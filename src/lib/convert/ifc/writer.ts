// Streaming IFC4 writer for converted models.
//
// One writer makes one file: project, site, building and storeys, then
// elements as they come. Element geometry arrives as text already (point
// lists and triangle indices are formatted once and can go to several files:
// a discipline file and the federated one). Shapes used by many elements are
// written once as an IfcRepresentationMap and placed by IfcMappedItem; plan
// walls and slabs are extrusions. Output is collected in chunks and returned
// as a Blob, so files of several hundred megabytes stay out of the JS heap.

import type { IfcClassInfo, IfcTypeClassInfo } from "./schema";
import { enumValue, hashGuid, label, real, str } from "./step";

export type Vec3 = [number, number, number];

export interface MeshText {
  /** "(x,y,z),(x,y,z),…" in millimetres. */
  points: string;
  /** "(a,b,c),(a,b,c),…" 1-based. */
  indices: string;
  closed: boolean;
  /** Texture coordinates "(u,v),…" and, per triangle, their indices "(a,b,c),…" (1-based). */
  texCoords?: string;
  texIndices?: string;
  /** Face colours "(r,g,b),…" (0..1) and one 1-based index per triangle "i,j,…". */
  colours?: string;
  colourIndex?: string;
}

/** A picture a style uses: written once per file, as a file next to the IFC or inside it. */
export interface TextureRef {
  /** Identity across the conversion (content hash). */
  id: string;
  /** Path of the picture relative to the IFC file, e.g. "textures/brick-1a2b3c4d.png". */
  path: string;
  bytes: Uint8Array;
  repeatS: boolean;
  repeatT: boolean;
}

export interface StyleDef {
  /** The colour simple viewers show (IfcSurfaceStyleShading.SurfaceColour), hex "rrggbb". */
  hex: string;
  opacity: number;
  /** Style name; "#rrggbb" when absent. */
  name?: string;
  /** Diffuse colour when it differs from the surface colour (textured, metal). */
  diffuse?: string | null;
  specular?: string | null;
  /** Phong exponent (IfcSpecularExponent) or roughness 0..1 (IfcSpecularRoughness). */
  shininess?: number | null;
  roughness?: number | null;
  method?: "METAL" | "GLASS" | "PHONG" | "NOTDEFINED";
  texture?: TextureRef | null;
}

/** Type object (IfcWallType, …) shared by elements of one Revit family type. */
export interface TypeDef {
  /** Identity across the conversion. */
  key: string;
  cls: IfcTypeClassInfo;
  name: string;
  description: string | null;
  elementType: string | null;
  predefined: string | null;
  psets?: PsetDef[];
}

export type ProfileDef =
  | { type: "rectangle"; x: number; y: number; xDim: number; yDim: number }
  | { type: "polygon"; points: [number, number][] }
  | { type: "circle"; x: number; y: number; r: number };

export type ItemDef =
  | { kind: "mesh"; mesh: MeshText; style: StyleDef }
  | {
      kind: "mapped";
      /** Identifies the shared shape; elements with the same key share one IfcRepresentationMap. */
      key: string;
      mesh: () => MeshText;
      style: StyleDef;
      axis1: Vec3;
      axis2: Vec3;
      axis3: Vec3;
      origin: Vec3;
      /** Per-axis scale, null for 1. */
      scale: Vec3 | null;
    }
  | { kind: "extrusion"; profile: ProfileDef; origin: Vec3; depth: number; style: StyleDef }
  | {
      kind: "curves";
      /** Point list "(x,y,z),…" (mm) and polylines as 1-based point indices. */
      points: string;
      runs: number[][];
      style: StyleDef;
    };

export type PropKind = "label" | "text" | "identifier" | "real" | "integer" | "boolean" | "length" | "area" | "volume" | "date" | "duration";

export interface PropEntry {
  name: string;
  value: string | number | boolean;
  kind?: PropKind;
}

export interface PsetDef {
  name: string;
  props: PropEntry[];
}

export interface QuantityDef {
  name: string;
  items: { kind: "length" | "area" | "volume"; name: string; value: number }[];
}

export interface ElementDef {
  guid: string;
  cls: IfcClassInfo;
  predefined: string | null;
  name: string | null;
  description: string | null;
  objectType: string | null;
  tag: string | null;
  /** Spaces: the room name (IfcSpace.LongName), with the number as the name. */
  longName?: string | null;
  storey: string;
  /** Element placement relative to its storey (mm); identity when absent. */
  placement?: { origin: Vec3; xDir?: Vec3 };
  /** Body representation type; "Curve3D" writes an 'Annotation' representation of the curves. */
  representation: "Tessellation" | "MappedRepresentation" | "SweptSolid" | "Curve3D";
  items: ItemDef[];
  /** 2D axis line in the element's placement (mm), written as an 'Axis' representation. */
  axis?: [[number, number], [number, number]];
  psets: PsetDef[];
  quantities?: QuantityDef;
  /** Identifies the element across the files of a conversion (systems, zones and spaces refer to it). */
  key?: string;
  /** Material names: one is an IfcMaterial, several an IfcMaterialConstituentSet. */
  materials?: string[] | null;
  /** How each material looks (IfcMaterialDefinitionRepresentation), by name. */
  materialStyles?: Record<string, StyleDef>;
  type?: TypeDef | null;
  /** STEP values for attributes after Representation the writer has no field for (OverallHeight, OperationType, …). */
  attributes?: Record<string, string>;
}

/** A void cut in a host element (IfcOpeningElement), placed in the host's own coordinates, optionally filled by a door or window. */
export interface OpeningDef {
  guid: string;
  name: string;
  /** Origin and x direction in the host's placement (mm). */
  origin: Vec3;
  xDir?: Vec3;
  /** The void's body (extrusions in the opening's coordinates). */
  items: Extract<ItemDef, { kind: "extrusion" }>[];
}

export interface WriterSetup {
  fileName: string;
  /** Distinguishes relationship ids between files of one conversion. */
  fileKey: string;
  projectName: string;
  projectDescription?: string;
  siteName: string;
  buildingName: string;
  author?: string;
  organization?: string;
  /** Shared ids so per-discipline files federate onto the same site, building and storeys. */
  projectKey: string;
  /** Site origin in metres, in the source model's coordinates, and the rotation of the project X axis (radians). */
  siteOrigin: Vec3;
  rotation: number;
  storeys: { key: string; name: string; elevation: number }[];
  /** Texture pictures: files next to the IFC (IfcImageTexture), inside it (IfcBlobTexture), or left out. */
  textures?: "files" | "embed" | "none";
}

export interface WriterStats {
  elements: number;
  items: number;
  mapped: number;
  maps: number;
  bytes: number;
  styles: number;
  textured: number;
  coloured: number;
  types: number;
  materials: number;
  systems: number;
  zones: number;
}

const FLUSH_CHARS = 1 << 22; // ~4 MB of text per chunk
const BLOB_BYTES = 64 << 20; // move chunks into a Blob every 64 MB

const f1 = (v: number) => {
  // millimetres to 0.1 mm
  const r = Math.round(v * 10);
  return r % 10 === 0 ? `${r / 10}.` : `${r / 10}`;
};

const f9 = (v: number) => {
  const r = Math.round(v * 1e9) / 1e9;
  return real(r === 0 ? 0 : r);
};

function measure(kind: PropKind, value: string | number | boolean): string {
  switch (kind) {
    case "boolean":
      return `IFCBOOLEAN(${value ? ".T." : ".F."})`;
    case "integer":
      return `IFCINTEGER(${Math.round(Number(value))})`;
    case "real":
      return `IFCREAL(${real(Number(value))})`;
    case "length":
      return `IFCLENGTHMEASURE(${real(Math.round(Number(value) * 1e4) / 1e4)})`;
    case "area":
      return `IFCAREAMEASURE(${real(Math.round(Number(value) * 1e6) / 1e6)})`;
    case "volume":
      return `IFCVOLUMEMEASURE(${real(Math.round(Number(value) * 1e6) / 1e6)})`;
    case "identifier":
      return `IFCIDENTIFIER(${str(String(value).slice(0, 255))})`;
    case "date":
      // IfcDate is a full calendar date; a year or year-month stays a label.
      return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `IFCDATE(${str(String(value))})` : `IFCLABEL(${str(String(value))})`;
    case "duration":
      return `IFCDURATION(${str(String(value))})`;
    case "text":
      return `IFCTEXT(${str(String(value))})`;
    default: {
      const text = String(value);
      return text.length > 255 ? `IFCTEXT(${str(text)})` : `IFCLABEL(${str(text)})`;
    }
  }
}

function inferKind(value: string | number | boolean): PropKind {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "real";
  return "label";
}

const HEX_DIGITS = "0123456789ABCDEF";

/** IfcBinary: a quoted string of hex digits, led by the count of unused bits (0). */
function binary(bytes: Uint8Array): string {
  const out = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = HEX_DIGITS[bytes[i] >> 4] + HEX_DIGITS[bytes[i] & 15];
  return `"0${out.join("")}"`;
}

function styleKey(def: StyleDef): string {
  const opacity = Math.max(0, Math.min(1, def.opacity));
  return [
    def.hex,
    opacity.toFixed(2),
    def.name ?? "",
    def.diffuse ?? "",
    def.specular ?? "",
    def.shininess === null || def.shininess === undefined ? "" : def.shininess.toFixed(2),
    def.roughness === null || def.roughness === undefined ? "" : def.roughness.toFixed(3),
    def.method ?? "",
    def.texture ? `${def.texture.id}|${def.texture.repeatS ? 1 : 0}${def.texture.repeatT ? 1 : 0}` : "",
  ].join("|");
}

export class IfcFileWriter {
  readonly setup: WriterSetup;
  readonly stats: WriterStats = { elements: 0, items: 0, mapped: 0, maps: 0, bytes: 0, styles: 0, textured: 0, coloured: 0, types: 0, materials: 0, systems: 0, zones: 0 };
  /** Texture pictures the file refers to (files mode), by path. */
  readonly textureFiles = new Map<string, Uint8Array>();
  private nextId = 1;
  private buf = "";
  private parts: Uint8Array[] = [];
  private partBytes = 0;
  private blobs: Blob[] = [];
  private readonly encoder = new TextEncoder();

  private readonly styles = new Map<string, { id: number; texture: number | null }>();
  private readonly textureIds = new Map<string, number>();
  private readonly dirs = new Map<string, number>();
  private readonly maps = new Map<string, number>();
  private readonly values = new Map<string, number>();
  private readonly materials = new Map<string, { id: number; style: StyleDef | null }>();
  /** Material associations: an IfcMaterial or IfcMaterialConstituentSet and the products that use it. */
  private readonly associations = new Map<string, { id: number; members: number[] }>();
  private readonly types = new Map<string, { id: number; members: number[] }>();
  /** Products by element key (for systems, zones and space references). */
  private readonly products = new Map<string, number>();
  private readonly contained = new Map<string, number[]>();
  private readonly spaces = new Map<string, number[]>();
  /** Local placement of each product (openings are placed relative to their host). */
  private readonly placements = new Map<number, number>();
  /** The file has openings voiding elements: a design transfer file rather than a reference one. */
  private voids = false;
  private annotationContext = 0;
  private modelContext = 0;

  private origin3 = 0;
  private origin2 = 0;
  private identityAxis = 0;
  private dirZ = 0;
  private body = 0;
  private axisContext = 0;
  private storeyIds = new Map<string, { id: number; placement: number }>();
  private building = 0;

  constructor(setup: WriterSetup) {
    this.setup = setup;
    this.writeSkeleton();
  }

  private add(body: string): number {
    const id = this.nextId++;
    this.buf += `#${id}=${body};\n`;
    if (this.buf.length > FLUSH_CHARS) this.flush();
    return id;
  }

  private flush() {
    if (!this.buf) return;
    const bytes = this.encoder.encode(this.buf);
    this.buf = "";
    this.parts.push(bytes);
    this.partBytes += bytes.byteLength;
    this.stats.bytes += bytes.byteLength;
    if (this.partBytes > BLOB_BYTES) {
      this.blobs.push(new Blob(this.parts as BlobPart[]));
      this.parts = [];
      this.partBytes = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Shared entities

  private dir(v: Vec3): number {
    const text = `(${f9(v[0])},${f9(v[1])},${f9(v[2])})`;
    let id = this.dirs.get(text);
    if (id === undefined) {
      id = this.add(`IFCDIRECTION(${text})`);
      this.dirs.set(text, id);
    }
    return id;
  }

  private dir2(x: number, y: number): number {
    const text = `(${f9(x)},${f9(y)})`;
    let id = this.dirs.get(text);
    if (id === undefined) {
      id = this.add(`IFCDIRECTION(${text})`);
      this.dirs.set(text, id);
    }
    return id;
  }

  private colour(hex: string): number {
    const [r, g, b] = [0, 2, 4].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1e4) / 1e4);
    return this.add(`IFCCOLOURRGB($,${f9(r)},${f9(g)},${f9(b)})`);
  }

  /** The texture entity for a picture (once per file); null when textures are left out. */
  private texture(ref: TextureRef): number | null {
    const mode = this.setup.textures ?? "files";
    if (mode === "none") return null;
    const key = `${ref.id}|${ref.repeatS ? 1 : 0}${ref.repeatT ? 1 : 0}`;
    let id = this.textureIds.get(key);
    if (id === undefined) {
      const repeat = `${ref.repeatS ? ".T." : ".F."},${ref.repeatT ? ".T." : ".F."}`;
      if (mode === "embed") id = this.add(`IFCBLOBTEXTURE(${repeat},'MODULATE',$,$,'PNG',${binary(ref.bytes)})`);
      else {
        id = this.add(`IFCIMAGETEXTURE(${repeat},'MODULATE',$,$,${str(ref.path)})`);
        this.textureFiles.set(ref.path, ref.bytes);
      }
      this.textureIds.set(key, id);
    }
    return id;
  }

  /** Surface style: colour, transparency, specular part, reflectance model and texture. */
  private style(def: StyleDef): { id: number; texture: number | null } {
    const opacity = Math.max(0, Math.min(1, def.opacity));
    const key = styleKey(def);
    let entry = this.styles.get(key);
    if (entry === undefined) {
      const surface = this.colour(def.hex);
      const diffuse = def.diffuse && def.diffuse !== def.hex ? `#${this.colour(def.diffuse)}` : "$";
      const specular = def.specular ? `#${this.colour(def.specular)}` : "$";
      const highlight =
        def.shininess !== null && def.shininess !== undefined && def.shininess > 0
          ? `IFCSPECULAREXPONENT(${real(Math.round(def.shininess * 100) / 100)})`
          : def.roughness !== null && def.roughness !== undefined
            ? `IFCSPECULARROUGHNESS(${real(Math.round(Math.max(0, Math.min(1, def.roughness)) * 1000) / 1000)})`
            : "$";
      const rendering = this.add(`IFCSURFACESTYLERENDERING(#${surface},${real(Math.round((1 - opacity) * 100) / 100)},${diffuse},$,$,$,${specular},${highlight},.${def.method ?? "NOTDEFINED"}.)`);
      const parts = [`#${rendering}`];
      const texture = def.texture ? this.texture(def.texture) : null;
      if (texture !== null) parts.push(`#${this.add(`IFCSURFACESTYLEWITHTEXTURES((#${texture}))`)}`);
      const name = def.name || `#${def.hex}${opacity < 0.999 ? ` a${opacity.toFixed(2)}` : ""}`;
      entry = { id: this.add(`IFCSURFACESTYLE(${label(name)},.BOTH.,(${parts.join(",")}))`), texture };
      this.styles.set(key, entry);
      this.stats.styles++;
    }
    return entry;
  }

  private faceSet(mesh: MeshText, style: StyleDef): number {
    const points = this.add(`IFCCARTESIANPOINTLIST3D((${mesh.points}))`);
    const set = this.add(`IFCTRIANGULATEDFACESET(#${points},$,${mesh.closed ? ".T." : ".F."},(${mesh.indices}),$)`);
    const styled = this.style(style);
    this.add(`IFCSTYLEDITEM(#${set},(#${styled.id}),$)`);
    if (styled.texture !== null && mesh.texCoords && mesh.texIndices) {
      const coords = this.add(`IFCTEXTUREVERTEXLIST((${mesh.texCoords}))`);
      this.add(`IFCINDEXEDTRIANGLETEXTUREMAP((#${styled.texture}),#${set},#${coords},(${mesh.texIndices}))`);
      this.stats.textured++;
    }
    if (mesh.colours && mesh.colourIndex) {
      const list = this.add(`IFCCOLOURRGBLIST((${mesh.colours}))`);
      const opacity = Math.max(0, Math.min(1, style.opacity));
      this.add(`IFCINDEXEDCOLOURMAP(#${set},${opacity < 0.999 ? real(Math.round(opacity * 100) / 100) : "$"},#${list},(${mesh.colourIndex}))`);
      this.stats.coloured++;
    }
    return set;
  }

  /** Line work as indexed polycurves sharing one point list, styled as curves. */
  private curves(def: Extract<ItemDef, { kind: "curves" }>): number[] {
    const points = this.add(`IFCCARTESIANPOINTLIST3D((${def.points}))`);
    const key = `curve|${def.style.hex}|${def.style.name ?? ""}`;
    let style = this.styles.get(key);
    if (!style) {
      const colour = this.colour(def.style.hex);
      style = { id: this.add(`IFCCURVESTYLE(${label(def.style.name || `#${def.style.hex}`)},$,$,#${colour},.T.)`), texture: null };
      this.styles.set(key, style);
    }
    return def.runs.map((run) => {
      const curve = this.add(`IFCINDEXEDPOLYCURVE(#${points},(IFCLINEINDEX((${run.join(",")}))),.F.)`);
      this.add(`IFCSTYLEDITEM(#${curve},(#${style.id}),$)`);
      return curve;
    });
  }

  private valueId(entry: PropEntry): number {
    const kind = entry.kind ?? inferKind(entry.value);
    const value = measure(kind, entry.value);
    const key = `${entry.name}\u0000${value}`;
    let id = this.values.get(key);
    if (id === undefined) {
      id = this.add(`IFCPROPERTYSINGLEVALUE(${str(entry.name)},$,${value},$)`);
      if (this.values.size > 400_000) this.values.clear();
      this.values.set(key, id);
    }
    return id;
  }

  // ---------------------------------------------------------------------------
  // Skeleton: units, contexts, project, site, building, storeys

  private writeSkeleton() {
    const s = this.setup;
    this.origin3 = this.add("IFCCARTESIANPOINT((0.,0.,0.))");
    this.origin2 = this.add("IFCCARTESIANPOINT((0.,0.))");
    this.dirZ = this.dir([0, 0, 1]);
    this.identityAxis = this.add(`IFCAXIS2PLACEMENT3D(#${this.origin3},$,$)`);
    const north = this.dir2(0, 1);
    const context = this.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${this.identityAxis},#${north})`);
    this.modelContext = context;
    this.body = this.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${context},$,.MODEL_VIEW.,$)`);
    this.axisContext = this.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,#${context},$,.GRAPH_VIEW.,$)`);
    const units = [
      this.add("IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)"),
      this.add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)"),
      this.add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)"),
      this.add("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)"),
    ];
    const unitAssignment = this.add(`IFCUNITASSIGNMENT((${units.map((u) => `#${u}`).join(",")}))`);
    const project = this.add(
      `IFCPROJECT(${str(hashGuid(`project|${s.projectKey}|${s.fileKey}`))},$,${label(s.projectName)},${label(s.projectDescription)},$,$,$,(#${context}),#${unitAssignment})`,
    );

    const [ox, oy, oz] = s.siteOrigin;
    const sitePoint = this.add(`IFCCARTESIANPOINT((${f1(ox * 1000)},${f1(oy * 1000)},${f1(oz * 1000)}))`);
    const siteAxis = this.add(`IFCAXIS2PLACEMENT3D(#${sitePoint},#${this.dirZ},#${this.dir([Math.cos(s.rotation), Math.sin(s.rotation), 0])})`);
    const sitePlacement = this.add(`IFCLOCALPLACEMENT($,#${siteAxis})`);
    const site = this.add(`IFCSITE(${str(hashGuid(`site|${s.projectKey}`))},$,${label(s.siteName)},$,$,#${sitePlacement},$,$,.ELEMENT.,$,$,${real(Math.round(oz * 1000 * 10) / 10)},$,$)`);
    const buildingPlacement = this.add(`IFCLOCALPLACEMENT(#${sitePlacement},#${this.identityAxis})`);
    this.building = this.add(`IFCBUILDING(${str(hashGuid(`building|${s.projectKey}`))},$,${label(s.buildingName)},$,$,#${buildingPlacement},$,$,.ELEMENT.,$,$,$)`);
    this.add(`IFCRELAGGREGATES(${str(hashGuid(`agg-project|${s.projectKey}|${s.fileKey}`))},$,$,$,#${project},(#${site}))`);
    this.add(`IFCRELAGGREGATES(${str(hashGuid(`agg-site|${s.projectKey}|${s.fileKey}`))},$,$,$,#${site},(#${this.building}))`);
    const storeyRefs: number[] = [];
    for (const storey of s.storeys) {
      const z = storey.elevation * 1000;
      const point = this.add(`IFCCARTESIANPOINT((0.,0.,${f1(z)}))`);
      const axis = this.add(`IFCAXIS2PLACEMENT3D(#${point},$,$)`);
      const placement = this.add(`IFCLOCALPLACEMENT(#${buildingPlacement},#${axis})`);
      const id = this.add(`IFCBUILDINGSTOREY(${str(hashGuid(`storey|${s.projectKey}|${storey.key}|${storey.name}`))},$,${label(storey.name)},$,$,#${placement},$,$,.ELEMENT.,${f1(z)})`);
      this.storeyIds.set(storey.key, { id, placement });
      storeyRefs.push(id);
    }
    if (storeyRefs.length) this.add(`IFCRELAGGREGATES(${str(hashGuid(`agg-building|${s.projectKey}|${s.fileKey}`))},$,$,$,#${this.building},(${storeyRefs.map((r) => `#${r}`).join(",")}))`);
  }

  // ---------------------------------------------------------------------------
  // Elements

  private item(def: Exclude<ItemDef, { kind: "curves" }>): number {
    this.stats.items++;
    if (def.kind === "mesh") return this.faceSet(def.mesh, def.style);
    if (def.kind === "mapped") {
      let map = this.maps.get(def.key);
      if (map === undefined) {
        const set = this.faceSet(def.mesh(), def.style);
        const rep = this.add(`IFCSHAPEREPRESENTATION(#${this.body},'Body','Tessellation',(#${set}))`);
        map = this.add(`IFCREPRESENTATIONMAP(#${this.identityAxis},#${rep})`);
        this.maps.set(def.key, map);
        this.stats.maps++;
      }
      const origin = this.add(`IFCCARTESIANPOINT((${f1(def.origin[0])},${f1(def.origin[1])},${f1(def.origin[2])}))`);
      const a1 = this.dir(def.axis1);
      const a2 = this.dir(def.axis2);
      const a3 = this.dir(def.axis3);
      const operator = def.scale
        ? this.add(`IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM(#${a1},#${a2},#${origin},${f9(def.scale[0])},#${a3},${f9(def.scale[1])},${f9(def.scale[2])})`)
        : this.add(`IFCCARTESIANTRANSFORMATIONOPERATOR3D(#${a1},#${a2},#${origin},1.,#${a3})`);
      this.stats.mapped++;
      return this.add(`IFCMAPPEDITEM(#${map},#${operator})`);
    }
    // extrusion
    let profile: number;
    if (def.profile.type === "rectangle") {
      const p = this.add(`IFCCARTESIANPOINT((${f1(def.profile.x)},${f1(def.profile.y)}))`);
      const position = this.add(`IFCAXIS2PLACEMENT2D(#${p},$)`);
      profile = this.add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${position},${f1(def.profile.xDim)},${f1(def.profile.yDim)})`);
    } else if (def.profile.type === "circle") {
      const p = this.add(`IFCCARTESIANPOINT((${f1(def.profile.x)},${f1(def.profile.y)}))`);
      const position = this.add(`IFCAXIS2PLACEMENT2D(#${p},$)`);
      profile = this.add(`IFCCIRCLEPROFILEDEF(.AREA.,$,#${position},${f1(def.profile.r)})`);
    } else {
      const ids = def.profile.points.map(([x, y]) => this.add(`IFCCARTESIANPOINT((${f1(x)},${f1(y)}))`));
      ids.push(ids[0]);
      const polyline = this.add(`IFCPOLYLINE((${ids.map((i) => `#${i}`).join(",")}))`);
      profile = this.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#${polyline})`);
    }
    const o = def.origin;
    const position = o[0] === 0 && o[1] === 0 && o[2] === 0 ? this.identityAxis : this.add(`IFCAXIS2PLACEMENT3D(#${this.add(`IFCCARTESIANPOINT((${f1(o[0])},${f1(o[1])},${f1(o[2])}))`)},$,$)`);
    const solid = this.add(`IFCEXTRUDEDAREASOLID(#${profile},#${position},#${this.dirZ},${f1(def.depth)})`);
    this.add(`IFCSTYLEDITEM(#${solid},(#${this.style(def.style).id}),$)`);
    return solid;
  }

  addElement(def: ElementDef): number | null {
    const storey = this.storeyIds.get(def.storey) ?? this.storeyIds.values().next().value;
    if (!storey) throw new Error("The file has no storeys.");
    const items: number[] = [];
    for (const item of def.items) {
      if (item.kind === "curves") {
        this.stats.items++;
        items.push(...this.curves(item));
      } else items.push(this.item(item));
    }
    if (items.length === 0) return null;
    const reps: number[] = [];
    if (def.axis) {
      const [[x0, y0], [x1, y1]] = def.axis;
      const p0 = this.add(`IFCCARTESIANPOINT((${f1(x0)},${f1(y0)}))`);
      const p1 = this.add(`IFCCARTESIANPOINT((${f1(x1)},${f1(y1)}))`);
      const line = this.add(`IFCPOLYLINE((#${p0},#${p1}))`);
      reps.push(this.add(`IFCSHAPEREPRESENTATION(#${this.axisContext},'Axis','Curve2D',(#${line}))`));
    }
    if (def.representation === "Curve3D") {
      if (!this.annotationContext) this.annotationContext = this.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Annotation','Model',*,*,*,*,#${this.modelContext},$,.MODEL_VIEW.,$)`);
      reps.push(this.add(`IFCSHAPEREPRESENTATION(#${this.annotationContext},'Annotation','Curve3D',(${items.map((i) => `#${i}`).join(",")}))`));
    } else reps.push(this.add(`IFCSHAPEREPRESENTATION(#${this.body},'Body',${str(def.representation)},(${items.map((i) => `#${i}`).join(",")}))`));
    const shape = this.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${reps.map((r) => `#${r}`).join(",")}))`);

    let axis = this.identityAxis;
    if (def.placement) {
      const [x, y, z] = def.placement.origin;
      const point = this.add(`IFCCARTESIANPOINT((${f1(x)},${f1(y)},${f1(z)}))`);
      axis = this.add(`IFCAXIS2PLACEMENT3D(#${point},${def.placement.xDir ? `#${this.dirZ},#${this.dir(def.placement.xDir)}` : "$,$"})`);
    }
    const placement = this.add(`IFCLOCALPLACEMENT(#${storey.placement},#${axis})`);

    let objectType = def.objectType;
    let predefined = def.predefined;
    if (predefined === "USERDEFINED" && !objectType) objectType = def.name ?? def.description ?? "Userdefined";
    if (predefined && !def.cls.predefined.has(predefined)) predefined = null;
    const tail = def.cls.tail.map((attribute) => {
      switch (attribute) {
        case "Tag":
          return label(def.tag);
        case "LongName":
          return label(def.longName ?? null);
        case "PredefinedType":
          return enumValue(predefined);
        case "CompositionType":
          return ".ELEMENT.";
        default:
          return def.attributes?.[attribute] ?? "$";
      }
    });
    const product = this.add(
      `${def.cls.name.toUpperCase()}(${str(def.guid)},$,${label(def.name)},${label(def.description)},${label(objectType)},#${placement},#${shape}${tail.length ? `,${tail.join(",")}` : ""})`,
    );

    for (const pset of def.psets) {
      const props = pset.props.filter((p) => p.value !== "" && p.value !== null && p.value !== undefined && !(typeof p.value === "number" && !Number.isFinite(p.value)));
      if (props.length === 0) continue;
      const ids = props.map((p) => this.valueId(p));
      const set = this.add(`IFCPROPERTYSET(${str(hashGuid(`pset|${def.guid}|${pset.name}`))},$,${label(pset.name)},$,(${ids.map((i) => `#${i}`).join(",")}))`);
      this.add(`IFCRELDEFINESBYPROPERTIES(${str(hashGuid(`rdp|${def.guid}|${pset.name}`))},$,$,$,(#${product}),#${set})`);
    }
    if (def.quantities && def.quantities.items.length) {
      const ids = def.quantities.items.map((q) => {
        const value = q.kind === "length" ? Math.round(q.value * 10) / 10 : Math.round(q.value * 1e6) / 1e6;
        const type = q.kind === "length" ? "IFCQUANTITYLENGTH" : q.kind === "area" ? "IFCQUANTITYAREA" : "IFCQUANTITYVOLUME";
        return this.add(`${type}(${str(q.name)},$,$,${real(value)},$)`);
      });
      const set = this.add(`IFCELEMENTQUANTITY(${str(hashGuid(`qto|${def.guid}`))},$,${label(def.quantities.name)},$,$,(${ids.map((i) => `#${i}`).join(",")}))`);
      this.add(`IFCRELDEFINESBYPROPERTIES(${str(hashGuid(`rdq|${def.guid}`))},$,$,$,(#${product}),#${set})`);
    }

    if (def.key) this.products.set(def.key, product);
    this.placements.set(product, placement);
    const bucket = def.cls.name === "IfcSpace" ? this.spaces : this.contained;
    const key = this.storeyIds.has(def.storey) ? def.storey : [...this.storeyIds.keys()][0];
    let list = bucket.get(key);
    if (!list) bucket.set(key, (list = []));
    list.push(product);

    const names = (def.materials ?? []).map((m) => m.trim().slice(0, 255)).filter(Boolean);
    if (names.length) {
      const key = names.join("\u0000");
      let association = this.associations.get(key);
      if (!association) {
        const ids = names.map((name) => this.material(name, def.materialStyles?.[name] ?? null));
        if (ids.length === 1) association = { id: ids[0], members: [] };
        else {
          const constituents = names.map((name, i) => this.add(`IFCMATERIALCONSTITUENT(${label(name)},$,#${ids[i]},$,$)`));
          const setName = def.type?.name ?? def.name ?? names.join(", ");
          association = { id: this.add(`IFCMATERIALCONSTITUENTSET(${label(setName)},$,(${constituents.map((c) => `#${c}`).join(",")}))`), members: [] };
        }
        this.associations.set(key, association);
      }
      association.members.push(product);
    }

    if (def.type) {
      let type = this.types.get(def.type.key);
      if (!type) {
        type = { id: this.typeObject(def.type), members: [] };
        this.types.set(def.type.key, type);
        this.stats.types++;
      }
      type.members.push(product);
    }
    this.stats.elements++;
    return product;
  }

  private material(name: string, style: StyleDef | null): number {
    let material = this.materials.get(name);
    if (!material) {
      material = { id: this.add(`IFCMATERIAL(${str(name)},$,$)`), style };
      this.materials.set(name, material);
      this.stats.materials++;
    } else if (!material.style && style) material.style = style;
    return material.id;
  }

  private typeObject(def: TypeDef): number {
    let predefined = def.predefined;
    const tail = def.cls.tail.map((attribute) => {
      if (attribute.name === "PredefinedType") {
        if (!predefined || !attribute.items.includes(predefined)) predefined = attribute.items.includes("NOTDEFINED") ? "NOTDEFINED" : null;
        if (predefined === "USERDEFINED" && !def.elementType) predefined = "NOTDEFINED";
        return predefined ? `.${predefined}.` : attribute.optional ? "$" : `.${attribute.items[attribute.items.length - 1]}.`;
      }
      if (attribute.items.length) return attribute.optional ? "$" : `.${attribute.items.includes("NOTDEFINED") ? "NOTDEFINED" : attribute.items[attribute.items.length - 1]}.`;
      return "$";
    });
    const guid = hashGuid(`type|${this.setup.projectKey}|${def.key}`);
    let psets = "$";
    const sets: number[] = [];
    for (const pset of def.psets ?? []) {
      const props = pset.props.filter((p) => p.value !== "" && p.value !== null && p.value !== undefined && !(typeof p.value === "number" && !Number.isFinite(p.value)));
      if (props.length === 0) continue;
      const ids = props.map((p) => this.valueId(p));
      sets.push(this.add(`IFCPROPERTYSET(${str(hashGuid(`tpset|${guid}|${pset.name}`))},$,${label(pset.name)},$,(${ids.map((i) => `#${i}`).join(",")}))`));
    }
    if (sets.length) psets = `(${sets.map((i) => `#${i}`).join(",")})`;
    return this.add(`${def.cls.name.toUpperCase()}(${str(guid)},$,${label(def.name)},${label(def.description)},$,${psets},$,$,${label(def.elementType)}${tail.length ? `,${tail.join(",")}` : ""})`);
  }

  /**
   * Cuts an opening into `host` (a product this file wrote): IfcOpeningElement
   * placed in the host's coordinates, IfcRelVoidsElement, and IfcRelFillsElement
   * when a door or window (`filler`, written before) fills it.
   */
  addOpening(host: number, def: OpeningDef, filler: number | null): number | null {
    const hostPlacement = this.placements.get(host);
    if (hostPlacement === undefined || def.items.length === 0) return null;
    const items = def.items.map((item) => this.item(item));
    const rep = this.add(`IFCSHAPEREPRESENTATION(#${this.body},'Body','SweptSolid',(${items.map((i) => `#${i}`).join(",")}))`);
    const shape = this.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
    const [x, y, z] = def.origin;
    const point = this.add(`IFCCARTESIANPOINT((${f1(x)},${f1(y)},${f1(z)}))`);
    const axis = this.add(`IFCAXIS2PLACEMENT3D(#${point},${def.xDir ? `#${this.dirZ},#${this.dir(def.xDir)}` : "$,$"})`);
    const placement = this.add(`IFCLOCALPLACEMENT(#${hostPlacement},#${axis})`);
    const opening = this.add(`IFCOPENINGELEMENT(${str(def.guid)},$,${label(def.name)},$,$,#${placement},#${shape},$,.OPENING.)`);
    this.add(`IFCRELVOIDSELEMENT(${str(hashGuid(`voids|${this.setup.fileKey}|${def.guid}`))},$,$,$,#${host},#${opening})`);
    if (filler !== null) this.add(`IFCRELFILLSELEMENT(${str(hashGuid(`fills|${this.setup.fileKey}|${def.guid}`))},$,$,$,#${opening},#${filler})`);
    this.voids = true;
    return opening;
  }

  /** Whether an element with this key is in the file. */
  has(key: string): boolean {
    return this.products.has(key);
  }

  /** A room without geometry (named by the assets in it), aggregated under its storey. */
  addSpaceStub(def: { key: string; guid: string; name: string; longName: string | null; storey: string; psets: PsetDef[] }): number | null {
    if (this.products.has(def.key)) return this.products.get(def.key)!;
    const storey = this.storeyIds.get(def.storey) ?? this.storeyIds.values().next().value;
    if (!storey) return null;
    const placement = this.add(`IFCLOCALPLACEMENT(#${storey.placement},#${this.identityAxis})`);
    const space = this.add(`IFCSPACE(${str(def.guid)},$,${label(def.name)},$,$,#${placement},$,${label(def.longName)},.ELEMENT.,.INTERNAL.,$)`);
    this.writePsets(space, def.guid, def.psets);
    const key = this.storeyIds.has(def.storey) ? def.storey : [...this.storeyIds.keys()][0];
    let list = this.spaces.get(key);
    if (!list) this.spaces.set(key, (list = []));
    list.push(space);
    this.products.set(def.key, space);
    return space;
  }

  private writePsets(product: number, guid: string, psets: PsetDef[]) {
    for (const pset of psets) {
      const props = pset.props.filter((p) => p.value !== "" && p.value !== null && p.value !== undefined && !(typeof p.value === "number" && !Number.isFinite(p.value)));
      if (props.length === 0) continue;
      const ids = props.map((p) => this.valueId(p));
      const set = this.add(`IFCPROPERTYSET(${str(hashGuid(`pset|${guid}|${pset.name}`))},$,${label(pset.name)},$,(${ids.map((i) => `#${i}`).join(",")}))`);
      this.add(`IFCRELDEFINESBYPROPERTIES(${str(hashGuid(`rdp|${guid}|${pset.name}`))},$,$,$,(#${product}),#${set})`);
    }
  }

  /**
   * Distribution systems and their members, zones of spaces, and elements referenced in the spaces
   * they stand in; only what this file holds. Call before finish().
   */
  addGroups(groups: {
    systems: { guid: string; name: string; description: string | null; objectType: string | null; predefined: string; members: string[] }[];
    zones: { guid: string; name: string; description: string | null; objectType: string | null; spaces: string[] }[];
    spaceRefs: { space: string; elements: string[] }[];
  }) {
    const s = this.setup;
    const refs = (ids: number[]) => ids.map((i) => `#${i}`).join(",");
    const present = (keys: string[]) => [...new Set(keys.map((k) => this.products.get(k)).filter((id): id is number => id !== undefined))];
    for (const sys of groups.systems) {
      const members = present(sys.members);
      if (members.length === 0) continue;
      const id = this.add(`IFCDISTRIBUTIONSYSTEM(${str(sys.guid)},$,${label(sys.name)},${label(sys.description)},${label(sys.objectType)},$,.${sys.predefined}.)`);
      this.add(`IFCRELASSIGNSTOGROUP(${str(hashGuid(`sysgroup|${s.fileKey}|${sys.guid}`))},$,$,$,(${refs(members)}),$,#${id})`);
      this.add(`IFCRELSERVICESBUILDINGS(${str(hashGuid(`sysbuilding|${s.fileKey}|${sys.guid}`))},$,$,$,#${id},(#${this.building}))`);
      this.stats.systems++;
    }
    for (const zone of groups.zones) {
      const spaces = present(zone.spaces);
      if (spaces.length === 0) continue;
      const id = this.add(`IFCZONE(${str(zone.guid)},$,${label(zone.name)},${label(zone.description)},${label(zone.objectType)},$)`);
      this.add(`IFCRELASSIGNSTOGROUP(${str(hashGuid(`zonegroup|${s.fileKey}|${zone.guid}`))},$,$,$,(${refs(spaces)}),$,#${id})`);
      this.stats.zones++;
    }
    for (const ref of groups.spaceRefs) {
      const space = this.products.get(ref.space);
      if (space === undefined) continue;
      const elements = present(ref.elements).filter((e) => e !== space);
      if (elements.length === 0) continue;
      this.add(`IFCRELREFERENCEDINSPATIALSTRUCTURE(${str(hashGuid(`spaceref|${s.fileKey}|${ref.space}`))},$,$,$,(${refs(elements)}),#${space})`);
    }
  }

  /** Writes the relationships and returns the finished file. */
  finish(): Blob {
    const s = this.setup;
    const refs = (ids: number[]) => ids.map((i) => `#${i}`).join(",");
    for (const [key, products] of this.contained) {
      const storey = this.storeyIds.get(key)!;
      for (let i = 0; i < products.length; i += 10000) {
        this.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${str(hashGuid(`contain|${s.projectKey}|${s.fileKey}|${key}|${i}`))},$,$,$,(${refs(products.slice(i, i + 10000))}),#${storey.id})`);
      }
    }
    for (const [key, spaces] of this.spaces) {
      const storey = this.storeyIds.get(key)!;
      for (let i = 0; i < spaces.length; i += 10000) {
        this.add(`IFCRELAGGREGATES(${str(hashGuid(`spaces|${s.projectKey}|${s.fileKey}|${key}|${i}`))},$,$,$,#${storey.id},(${refs(spaces.slice(i, i + 10000))}))`);
      }
    }
    for (const [key, association] of this.associations) {
      for (let i = 0; i < association.members.length; i += 5000) {
        this.add(`IFCRELASSOCIATESMATERIAL(${str(hashGuid(`material|${s.projectKey}|${s.fileKey}|${key}|${i}`))},$,$,$,(${refs(association.members.slice(i, i + 5000))}),#${association.id})`);
      }
    }
    // How each material looks, for viewers that colour by material.
    for (const material of this.materials.values()) {
      if (!material.style) continue;
      const styled = this.add(`IFCSTYLEDITEM($,(#${this.style(material.style).id}),$)`);
      const representation = this.add(`IFCSTYLEDREPRESENTATION(#${this.body},'Style','Material',(#${styled}))`);
      this.add(`IFCMATERIALDEFINITIONREPRESENTATION($,$,(#${representation}),#${material.id})`);
    }
    // One relationship per type (IFC allows a type object a single IfcRelDefinesByType).
    for (const [key, type] of this.types) {
      this.add(`IFCRELDEFINESBYTYPE(${str(hashGuid(`type-rel|${s.projectKey}|${s.fileKey}|${key}`))},$,$,$,(${refs(type.members)}),#${type.id})`);
    }
    this.flush();
    const stamp = new Date().toISOString().slice(0, 19);
    const header =
      "ISO-10303-21;\nHEADER;\n" +
      `FILE_DESCRIPTION(('ViewDefinition [${this.voids ? "DesignTransferView_V1.0" : "ReferenceView_V1.2"}]'),'2;1');\n` +
      `FILE_NAME(${str(s.fileName)},${str(stamp)},(${str(s.author ?? "")}),(${str(s.organization ?? "")}),'IFC Studio Convert','IFC Studio','');\n` +
      "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";
    const footer = "ENDSEC;\nEND-ISO-10303-21;\n";
    const blob = new Blob([header, ...this.blobs, ...(this.parts as BlobPart[]), footer], { type: "application/x-step" });
    this.parts = [];
    this.blobs = [];
    this.stats.bytes = blob.size;
    return blob;
  }
}
