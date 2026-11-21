// A small IFC4 writer for tessellated models. The NWD viewer uses it to turn
// the meshes and properties it reads from the Autodesk viewer into an IFC
// file. It writes plain STEP text in chunks, so a large export never has to
// exist as one string.
//
// Geometry is written as IfcTriangulatedFaceSet in metres, Z up. Elements sit
// under Project > Site > Building > Storey; every element carries its
// property sets and a surface colour per mesh.

export interface WriterMesh {
  /** x, y, z triples in metres, Z up, relative to the model origin. */
  positions: Float64Array | Float32Array | number[];
  /** Zero-based vertex indices, three per triangle. */
  indices: Uint32Array | Uint16Array | number[];
  /** Linear RGB 0..1. */
  color?: [number, number, number];
  /** 1 = opaque. */
  opacity?: number;
}

export type PropertyValue = string | number | boolean;

export interface WriterProperty {
  name: string;
  value: PropertyValue;
  /** Forces the IFC value type; by default it follows the JavaScript type. */
  kind?: "text" | "label" | "identifier" | "real" | "integer" | "boolean";
}

export interface WriterPropertySet {
  name: string;
  properties: WriterProperty[];
}

export interface WriterElement {
  /** Upper-case IFC4 class, e.g. IFCWALL. Unknown classes are written as IFCBUILDINGELEMENTPROXY. */
  ifcClass: string;
  name: string;
  description?: string;
  objectType?: string;
  tag?: string;
  /** A stable identifier of the source object; the GlobalId is derived from it. */
  sourceId: string;
  /** Storey to place the element on; elements without one go to the default storey. */
  storey?: string;
  meshes: WriterMesh[];
  propertySets: WriterPropertySet[];
}

export interface WriterOptions {
  projectName: string;
  fileName: string;
  /** Written into the header as the originating system. */
  application?: string;
  description?: string;
  /** Where the model origin sits in the source file's coordinates (metres, Z up). */
  origin?: [number, number, number];
  defaultStorey?: string;
  /** Decimal places for coordinates in metres. 5 = 0.01 mm. */
  precision?: number;
  /** Salt for GlobalIds, so two different source models never share ids. */
  idNamespace?: string;
}

export interface WriterStats {
  elements: number;
  meshes: number;
  triangles: number;
  vertices: number;
  propertySets: number;
  properties: number;
  /** Elements that had no usable triangles and were written without a shape. */
  withoutGeometry: number;
  bytes: number;
}

/** Entity classes this writer emits, with the number of attributes after Tag. */
const CLASS_TAIL: Record<string, string[]> = {
  // (GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, Tag) + tail
  IFCBUILDINGELEMENTPROXY: ["$"],
  IFCWALL: ["$"],
  IFCSLAB: ["$"],
  IFCROOF: ["$"],
  IFCCOLUMN: ["$"],
  IFCBEAM: ["$"],
  IFCMEMBER: ["$"],
  IFCPLATE: ["$"],
  IFCFOOTING: ["$"],
  IFCPILE: ["$", "$"],
  IFCSTAIR: ["$"],
  IFCRAMP: ["$"],
  IFCRAILING: ["$"],
  IFCCOVERING: ["$"],
  IFCCURTAINWALL: ["$"],
  IFCDOOR: ["$", "$", "$", "$", "$"],
  IFCWINDOW: ["$", "$", "$", "$", "$"],
  IFCFURNITURE: ["$"],
  IFCPIPESEGMENT: ["$"],
  IFCPIPEFITTING: ["$"],
  IFCDUCTSEGMENT: ["$"],
  IFCDUCTFITTING: ["$"],
  IFCCABLECARRIERSEGMENT: ["$"],
  IFCCABLESEGMENT: ["$"],
  IFCAIRTERMINAL: ["$"],
  IFCSANITARYTERMINAL: ["$"],
  IFCLIGHTFIXTURE: ["$"],
  IFCFIRESUPPRESSIONTERMINAL: ["$"],
  IFCVALVE: ["$"],
  IFCPUMP: ["$"],
  IFCTANK: ["$"],
  IFCTRANSPORTELEMENT: ["$"],
};

export const WRITER_CLASSES = Object.keys(CLASS_TAIL);

// ---------------------------------------------------------------------------
// STEP encoding

/** Encodes a string for a STEP file: quotes doubled, non-ASCII as \\X2\\ (BMP) or \\X4\\ (beyond) escapes. */
export function stepString(value: string): string {
  let out = "'";
  let mode: "" | "X2" | "X4" = "";
  const close = () => {
    if (mode) out += "\\X0\\";
    mode = "";
  };
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 32 && code <= 126) {
      close();
      if (code === 39) out += "''";
      else if (code === 92) out += "\\\\";
      else out += character;
    } else if (code === 9 || code === 10 || code === 13) {
      close();
      out += " ";
    } else if (code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff)) {
      // Control characters and lone surrogates have no place in a name or value.
    } else if (code <= 0xffff) {
      if (mode !== "X2") {
        close();
        out += "\\X2\\";
        mode = "X2";
      }
      out += code.toString(16).toUpperCase().padStart(4, "0");
    } else {
      if (mode !== "X4") {
        close();
        out += "\\X4\\";
        mode = "X4";
      }
      out += code.toString(16).toUpperCase().padStart(8, "0");
    }
  }
  close();
  return `${out}'`;
}

function optionalString(value: string | undefined | null): string {
  const trimmed = value?.trim();
  return trimmed ? stepString(trimmed.length > 255 ? trimmed.slice(0, 255) : trimmed) : "$";
}

/** A STEP real: always with a decimal point, never NaN or an exponent without a mantissa point. */
export function stepReal(value: number, decimals = 6): string {
  if (!Number.isFinite(value)) return "0.";
  if (Math.abs(value) >= 1e15) {
    // toFixed switches to exponent notation up here; write a STEP exponent instead.
    const [mantissa, exponent] = value.toExponential(6).split("e");
    return `${mantissa.replace(/0+$/, "")}E${exponent.replace("+", "")}`;
  }
  let text = value.toFixed(decimals);
  if (text.includes(".")) text = text.replace(/0+$/, "");
  if (text === "-0.") return "0.";
  return text.includes(".") ? text : `${text}.`;
}

const GUID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // A final avalanche so short inputs still spread over all bits.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** A 22-character IFC GlobalId derived deterministically from a text key. */
export function ifcGuid(key: string): string {
  const words = [fnv1a(key, 0x811c9dc5), fnv1a(key, 0x9747b28c), fnv1a(key, 0x1b873593), fnv1a(key, 0xcc9e2d51)];
  // 128 bits: the first character carries 2 bits, the other 21 carry 6 each.
  const bits: number[] = [];
  for (const word of words) for (let bit = 31; bit >= 0; bit--) bits.push((word >>> bit) & 1);
  let guid = GUID_CHARS[(bits[0] << 1) | bits[1]];
  for (let i = 2; i < 128; i += 6) {
    let value = 0;
    for (let bit = 0; bit < 6; bit++) value = (value << 1) | bits[i + bit];
    guid += GUID_CHARS[value];
  }
  return guid;
}

// ---------------------------------------------------------------------------
// Vertex welding

/**
 * Merges vertices that land on the same rounded coordinate and drops
 * degenerate triangles. Viewer meshes duplicate every vertex per normal, so
 * this roughly halves the size of the written geometry.
 */
function weld(mesh: WriterMesh, decimals: number): { coords: number[]; triangles: number[] } {
  const { positions, indices } = mesh;
  const vertexCount = Math.floor(positions.length / 3);
  const scale = 10 ** decimals;
  const remap = new Int32Array(vertexCount).fill(-1);
  const coords: number[] = [];

  // Open addressing over the quantised coordinates.
  let capacity = 16;
  while (capacity < vertexCount * 2) capacity *= 2;
  const table = new Int32Array(capacity).fill(-1);
  const quantised = new Float64Array(vertexCount * 3);
  let unique = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const x = Math.round(positions[vertex * 3] * scale);
    const y = Math.round(positions[vertex * 3 + 1] * scale);
    const z = Math.round(positions[vertex * 3 + 2] * scale);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    let slot = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) & (capacity - 1);
    for (;;) {
      const existing = table[slot];
      if (existing === -1) {
        table[slot] = unique;
        quantised[unique * 3] = x;
        quantised[unique * 3 + 1] = y;
        quantised[unique * 3 + 2] = z;
        coords.push(x / scale, y / scale, z / scale);
        remap[vertex] = unique++;
        break;
      }
      if (quantised[existing * 3] === x && quantised[existing * 3 + 1] === y && quantised[existing * 3 + 2] === z) {
        remap[vertex] = existing;
        break;
      }
      slot = (slot + 1) & (capacity - 1);
    }
  }

  const triangles: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] < vertexCount ? remap[indices[i]] : -1;
    const b = indices[i + 1] < vertexCount ? remap[indices[i + 1]] : -1;
    const c = indices[i + 2] < vertexCount ? remap[indices[i + 2]] : -1;
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
    triangles.push(a, b, c);
  }
  return { coords, triangles };
}

// ---------------------------------------------------------------------------
// Writer

const FLUSH_CHARS = 2 * 1024 * 1024;

export class IfcWriter {
  private parts: BlobPart[] = [];
  private buffer: string[] = [];
  private buffered = 0;
  private bytes = 0;
  private nextId = 1;
  private readonly precision: number;
  private readonly namespace: string;
  private readonly usedGuids = new Set<string>();
  private readonly styles = new Map<string, number>();
  private readonly storeys = new Map<string, { id: number; placement: number; elements: number[] }>();
  private readonly ownerHistory: number;
  private readonly bodyContext: number;
  private readonly building: number;
  private readonly buildingPlacement: number;
  private readonly identityAxis: number;
  private readonly defaultStorey: string;
  private finished = false;
  readonly stats: WriterStats = { elements: 0, meshes: 0, triangles: 0, vertices: 0, propertySets: 0, properties: 0, withoutGeometry: 0, bytes: 0 };

  constructor(options: WriterOptions) {
    this.precision = Math.max(2, Math.min(8, options.precision ?? 5));
    this.namespace = options.idNamespace ?? options.projectName;
    this.defaultStorey = options.defaultStorey?.trim() || "Model";
    const stamp = new Date();
    const iso = stamp.toISOString().slice(0, 19);
    const application = options.application ?? "IFC Studio";

    this.raw("ISO-10303-21;\nHEADER;\n");
    this.raw(`FILE_DESCRIPTION((${stepString("ViewDefinition [ReferenceView_V1.2]")}${options.description ? `,${stepString(options.description)}` : ""}),'2;1');\n`);
    this.raw(`FILE_NAME(${stepString(options.fileName)},'${iso}',(''),(''),${stepString(application)},${stepString(application)},'');\n`);
    this.raw("FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n");

    const person = this.add("IFCPERSON($,$,'',$,$,$,$,$)");
    const organisation = this.add(`IFCORGANIZATION($,${stepString(application)},$,$,$)`);
    const personAndOrganisation = this.add(`IFCPERSONANDORGANIZATION(#${person},#${organisation},$)`);
    const app = this.add(`IFCAPPLICATION(#${organisation},'1.0',${stepString(application)},'IFCStudio')`);
    this.ownerHistory = this.add(`IFCOWNERHISTORY(#${personAndOrganisation},#${app},$,.NOCHANGE.,$,$,$,${Math.floor(stamp.getTime() / 1000)})`);

    const length = this.add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)");
    const area = this.add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)");
    const volume = this.add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)");
    const angle = this.add("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)");
    const units = this.add(`IFCUNITASSIGNMENT((#${length},#${area},#${volume},#${angle}))`);

    const zero = this.add("IFCCARTESIANPOINT((0.,0.,0.))");
    const up = this.add("IFCDIRECTION((0.,0.,1.))");
    const along = this.add("IFCDIRECTION((1.,0.,0.))");
    this.identityAxis = this.add(`IFCAXIS2PLACEMENT3D(#${zero},#${up},#${along})`);
    const context = this.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#${this.identityAxis},$)`);
    this.bodyContext = this.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${context},$,.MODEL_VIEW.,$)`);

    const project = this.add(`IFCPROJECT('${this.guid("project")}',#${this.ownerHistory},${optionalString(options.projectName)},${optionalString(options.description)},$,$,$,(#${context}),#${units})`);

    // The site carries the source file's origin, so geometry can stay close to zero.
    const origin = options.origin ?? [0, 0, 0];
    const far = origin.some((value) => Math.abs(value) > 1e-9);
    const siteAxis = far ? this.add(`IFCAXIS2PLACEMENT3D(#${this.add(`IFCCARTESIANPOINT((${origin.map((value) => stepReal(value, 4)).join(",")}))`)},#${up},#${along})`) : this.identityAxis;
    const sitePlacement = this.add(`IFCLOCALPLACEMENT($,#${siteAxis})`);
    const site = this.add(`IFCSITE('${this.guid("site")}',#${this.ownerHistory},'Site',$,$,#${sitePlacement},$,$,.ELEMENT.,$,$,$,$,$)`);
    this.buildingPlacement = this.add(`IFCLOCALPLACEMENT(#${sitePlacement},#${this.identityAxis})`);
    this.building = this.add(`IFCBUILDING('${this.guid("building")}',#${this.ownerHistory},${optionalString(options.projectName)},$,$,#${this.buildingPlacement},$,$,.ELEMENT.,$,$,$)`);
    this.add(`IFCRELAGGREGATES('${this.guid("rel-project-site")}',#${this.ownerHistory},$,$,#${project},(#${site}))`);
    this.add(`IFCRELAGGREGATES('${this.guid("rel-site-building")}',#${this.ownerHistory},$,$,#${site},(#${this.building}))`);
  }

  private raw(text: string) {
    this.buffer.push(text);
    this.buffered += text.length;
    if (this.buffered >= FLUSH_CHARS) this.flush();
  }

  private flush() {
    if (this.buffer.length === 0) return;
    const blob = new Blob(this.buffer, { type: "application/x-step" });
    this.parts.push(blob);
    this.bytes += blob.size;
    this.buffer = [];
    this.buffered = 0;
  }

  private add(entity: string): number {
    const id = this.nextId++;
    this.raw(`#${id}=${entity};\n`);
    return id;
  }

  private guid(key: string): string {
    let guid = ifcGuid(`${this.namespace}|${key}`);
    for (let attempt = 1; this.usedGuids.has(guid); attempt++) guid = ifcGuid(`${this.namespace}|${key}|${attempt}`);
    this.usedGuids.add(guid);
    return guid;
  }

  private storey(name: string | undefined) {
    const key = name?.trim() || this.defaultStorey;
    let entry = this.storeys.get(key);
    if (!entry) {
      const placement = this.add(`IFCLOCALPLACEMENT(#${this.buildingPlacement},#${this.identityAxis})`);
      const id = this.add(`IFCBUILDINGSTOREY('${this.guid(`storey|${key}`)}',#${this.ownerHistory},${optionalString(key)},$,$,#${placement},$,$,.ELEMENT.,$)`);
      entry = { id, placement, elements: [] };
      this.storeys.set(key, entry);
    }
    return entry;
  }

  private style(color: [number, number, number], opacity: number): number {
    const rgb = color.map((channel) => Math.max(0, Math.min(1, Number.isFinite(channel) ? channel : 0.8)));
    const transparency = Math.max(0, Math.min(1, 1 - (Number.isFinite(opacity) ? opacity : 1)));
    const key = `${rgb.map((channel) => channel.toFixed(3)).join(",")}|${transparency.toFixed(2)}`;
    let id = this.styles.get(key);
    if (id === undefined) {
      const colour = this.add(`IFCCOLOURRGB($,${rgb.map((channel) => stepReal(channel, 3)).join(",")})`);
      const rendering = this.add(`IFCSURFACESTYLERENDERING(#${colour},${stepReal(transparency, 2)},$,$,$,$,$,$,.NOTDEFINED.)`);
      id = this.add(`IFCSURFACESTYLE($,.BOTH.,(#${rendering}))`);
      this.styles.set(key, id);
    }
    return id;
  }

  private propertyValue(property: WriterProperty): string | null {
    const { value } = property;
    const kind = property.kind ?? (typeof value === "boolean" ? "boolean" : typeof value === "number" ? (Number.isInteger(value) && Math.abs(value) < 2 ** 31 ? "integer" : "real") : "text");
    switch (kind) {
      case "boolean":
        return `IFCBOOLEAN(${value === true || value === "true" || value === 1 ? ".T." : ".F."})`;
      case "integer": {
        const number = Number(value);
        return Number.isFinite(number) ? `IFCINTEGER(${Math.trunc(number)})` : null;
      }
      case "real": {
        const number = Number(value);
        return Number.isFinite(number) ? `IFCREAL(${stepReal(number, 6)})` : null;
      }
      case "label":
        return `IFCLABEL(${stepString(String(value).slice(0, 255))})`;
      case "identifier":
        return `IFCIDENTIFIER(${stepString(String(value).slice(0, 255))})`;
      default: {
        const text = String(value);
        return text.length === 0 ? null : `IFCTEXT(${stepString(text.length > 4000 ? `${text.slice(0, 4000)}…` : text)})`;
      }
    }
  }

  /** Writes one element with its geometry, colours and property sets. */
  addElement(element: WriterElement): void {
    if (this.finished) throw new Error("The IFC file is already finished.");
    const storey = this.storey(element.storey);
    const ifcClass = CLASS_TAIL[element.ifcClass] ? element.ifcClass : "IFCBUILDINGELEMENTPROXY";

    const items: number[] = [];
    for (const mesh of element.meshes) {
      const { coords, triangles } = weld(mesh, this.precision);
      if (triangles.length === 0) continue;
      const points: string[] = new Array(coords.length / 3);
      for (let i = 0, p = 0; i < coords.length; i += 3, p++) points[p] = `(${stepReal(coords[i], this.precision)},${stepReal(coords[i + 1], this.precision)},${stepReal(coords[i + 2], this.precision)})`;
      const list = this.add(`IFCCARTESIANPOINTLIST3D((${points.join(",")}))`);
      const faces: string[] = new Array(triangles.length / 3);
      for (let i = 0, f = 0; i < triangles.length; i += 3, f++) faces[f] = `(${triangles[i] + 1},${triangles[i + 1] + 1},${triangles[i + 2] + 1})`;
      const faceSet = this.add(`IFCTRIANGULATEDFACESET(#${list},$,$,(${faces.join(",")}),$)`);
      if (mesh.color) this.add(`IFCSTYLEDITEM(#${faceSet},(#${this.style(mesh.color, mesh.opacity ?? 1)}),$)`);
      items.push(faceSet);
      this.stats.meshes += 1;
      this.stats.triangles += triangles.length / 3;
      this.stats.vertices += coords.length / 3;
    }

    let representation = "$";
    if (items.length > 0) {
      const shape = this.add(`IFCSHAPEREPRESENTATION(#${this.bodyContext},'Body','Tessellation',(${items.map((id) => `#${id}`).join(",")}))`);
      representation = `#${this.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${shape}))`)}`;
    } else this.stats.withoutGeometry += 1;

    const placement = this.add(`IFCLOCALPLACEMENT(#${storey.placement},#${this.identityAxis})`);
    const id = this.add(
      `${ifcClass}('${this.guid(`element|${element.sourceId}`)}',#${this.ownerHistory},${optionalString(element.name)},${optionalString(element.description)},${optionalString(element.objectType)},#${placement},${representation},${optionalString(element.tag)},${CLASS_TAIL[ifcClass].join(",")})`,
    );
    storey.elements.push(id);
    this.stats.elements += 1;

    const usedSetNames = new Set<string>();
    for (const set of element.propertySets) {
      const properties: number[] = [];
      const usedNames = new Set<string>();
      for (const property of set.properties) {
        const value = this.propertyValue(property);
        let name = property.name.trim().slice(0, 255);
        if (!value || !name) continue;
        // Property names must be unique inside a set.
        for (let attempt = 2; usedNames.has(name); attempt++) name = `${property.name.trim().slice(0, 250)} (${attempt})`;
        usedNames.add(name);
        properties.push(this.add(`IFCPROPERTYSINGLEVALUE(${stepString(name)},$,${value},$)`));
      }
      if (properties.length === 0) continue;
      let setName = set.name.trim().slice(0, 255) || "Properties";
      for (let attempt = 2; usedSetNames.has(setName); attempt++) setName = `${set.name.trim().slice(0, 250)} (${attempt})`;
      usedSetNames.add(setName);
      const pset = this.add(`IFCPROPERTYSET('${this.guid(`pset|${element.sourceId}|${setName}`)}',#${this.ownerHistory},${stepString(setName)},$,(${properties.map((entry) => `#${entry}`).join(",")}))`);
      this.add(`IFCRELDEFINESBYPROPERTIES('${this.guid(`rel-pset|${element.sourceId}|${setName}`)}',#${this.ownerHistory},$,$,(#${id}),#${pset})`);
      this.stats.propertySets += 1;
      this.stats.properties += properties.length;
    }
  }

  /** Closes the file and returns it. */
  finish(): Blob {
    if (!this.finished) {
      this.finished = true;
      if (this.storeys.size === 0) this.storey(undefined);
      const storeyIds: number[] = [];
      for (const [name, storey] of this.storeys) {
        storeyIds.push(storey.id);
        if (storey.elements.length > 0) {
          this.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${this.guid(`rel-contained|${name}`)}',#${this.ownerHistory},$,$,(${storey.elements.map((id) => `#${id}`).join(",")}),#${storey.id})`);
        }
      }
      this.add(`IFCRELAGGREGATES('${this.guid("rel-building-storeys")}',#${this.ownerHistory},$,$,#${this.building},(${storeyIds.map((id) => `#${id}`).join(",")}))`);
      this.raw("ENDSEC;\nEND-ISO-10303-21;\n");
      this.flush();
      this.stats.bytes = this.bytes;
    }
    return new Blob(this.parts, { type: "application/x-step" });
  }
}
