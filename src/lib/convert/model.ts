// Elements of an extracted model: fragments grouped into building elements,
// with their names, Revit identity and properties, read from the viewer's node
// tree and property database.
//
// Element rule (the same one the extractor uses to fetch properties): walking
// down from a file root, the element is the first node that is not a grouping
// level (assembly, layer, collection, model) and holds no grouping level
// itself. Navisworks files mark Revit elements as inserts or composites; some
// NWC exports make a category node a composite or nest linked Revit models,
// which the container test catches. Models with no such node types (Revit
// translated directly) fall back to the node that owns the geometry.

import { materialInfo, type MaterialInfo } from "./appearance";
import { GEOM_INDEX32, GEOM_LINES, GEOM_NON_INDEXED, GEOM_NONE, GEOM_QUANTIZED, type JobData, type PropsData, type RawSourceJob, type TextureMeta } from "./bundle";
import { guidFromRevitUniqueId, guidFromUuid } from "./ifc/step";
import { fromFragment, type Affine } from "./math";

/** Navisworks node types that are tree levels rather than elements: assembly, layer, collection, model. */
export const GROUPING_TYPES = new Set([0, 2, 3, 5]);
export const NODE_TYPE_MODEL = 5;

export const REVIT_CATEGORIES = new Set([
  "Walls", "Doors", "Windows", "Floors", "Ceilings", "Roofs", "Railings", "Handrails", "Top Rails", "Stairs", "Runs", "Landings", "Ramps",
  "Curtain Panels", "Curtain Wall Mullions", "Curtain Systems", "Structural Framing", "Structural Columns", "Structural Stiffeners",
  "Structural Connections", "Structural Foundations", "Structural Rebar", "Structural Trusses", "Structural Beam Systems", "Supports", "Columns",
  "Furniture", "Furniture Systems", "Casework", "Plumbing Fixtures", "Plumbing Equipment", "Specialty Equipment", "Generic Models", "Parking",
  "Planting", "Site", "Topography", "Toposolid", "Mass", "Entourage", "Mechanical Equipment", "Mechanical Control Devices", "Electrical Equipment",
  "Electrical Fixtures", "Lighting Fixtures", "Lighting Devices", "Fire Alarm Devices", "Communication Devices", "Data Devices", "Security Devices",
  "Telephone Devices", "Nurse Call Devices", "Sprinklers", "Fire Protection", "Pipes", "Flex Pipes", "Pipe Fittings", "Pipe Accessories",
  "Pipe Insulations", "Ducts", "Flex Ducts", "Duct Fittings", "Duct Accessories", "Duct Insulations", "Duct Linings", "Air Terminals",
  "MEP Fabrication Ductwork", "MEP Fabrication Pipework", "MEP Fabrication Hangers", "MEP Fabrication Containment", "MEP Ancillary Framing",
  "Cable Trays", "Cable Tray Fittings", "Cable Tray Runs", "Conduits", "Conduit Fittings", "Conduit Runs", "Wires", "Slab Edges", "Wall Sweeps",
  "Roof Soffits", "Fascias", "Gutters", "Rooms", "Spaces", "Areas", "Signage", "Medical Equipment", "Food Service Equipment",
  "Audio Visual Devices", "Vertical Circulation", "Temporary Structures", "Hardscape", "Parts", "Assemblies", "Detail Items", "Model Groups",
  "Shaft Openings", "Openings",
]);

// Format 1 property files store strings as indices into a table and numbers raw; these keys hold numbers.
const NUMERIC_KEYS = new Set([
  "Parameters/Size", "ParametersMap/Size", "Element/Length", "Element/Outside Diameter", "Element Properties/Diameter", "Element Properties/Height",
  "Element Properties/Width", "Element Properties/Length", "Revit Type/Diameter", "Revit Type/Height", "Revit Type/Length", "Revit Type/Width",
  "Revit Type/Outside Diameter", "WallType/Width", "Host/Width",
]);
const MIXED_KEYS = new Set(["Element/Diameter", "Element/Height", "Element/Width"]);

function keyKind(key: string): "n" | "s" | "m" {
  if (MIXED_KEYS.has(key)) return "m";
  if (key.endsWith("/Id") || key.endsWith("/Flow") || NUMERIC_KEYS.has(key)) return "n";
  return "s";
}

export type PropValue = string | number | boolean;
export type Props = Record<string, PropValue>;

export interface ElementInfo {
  category: string;
  family: string;
  type: string;
  level: string;
  /** Name of the file root the element sits under. */
  file: string;
  props: Props;
}

/** Keys that name the same thing in Navisworks (Element / Revit Type tabs) and in Revit translations. */
const CATEGORY_KEYS = ["Element/Category", "Revit Type/Category", "__category__/Category", "Item/Category", "Identity Data/Category", "Other/Category"];
const FAMILY_KEYS = ["Element/Family", "Revit Type/Family Name", "Identity Data/Family Name", "Other/Family", "Identity Data/Family"];
const TYPE_KEYS = ["Element/Type", "Revit Type/Type Name", "Identity Data/Type Name", "Other/Type", "Identity Data/Type"];
export const LEVEL_KEYS = ["Element/Level", "Constraints/Level", "Constraints/Base Constraint", "Constraints/Reference Level", "Constraints/Schedule Level", "Constraints/Base Level", "Element/Base Constraint"];

function firstString(props: Props, keys: string[]): string {
  for (const key of keys) {
    const value = props[key];
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return "";
}

export class SourceJob {
  readonly name: string;
  readonly data: JobData;
  readonly propsData: PropsData | null;
  /** Metres per model unit. */
  readonly unitScale: number;
  readonly yUp: boolean;
  readonly roots: number[];
  private readonly rootSet: Set<number>;
  private readonly parent: Int32Array;
  private readonly type: Uint8Array;
  private readonly nameIndex: Int32Array;
  private readonly container: Uint8Array;
  private readonly memo: Int32Array;
  private readonly propRow = new Map<number, number>();
  private readonly propCache = new Map<number, Props>();
  /** Fragment indices grouped per element (CSR): fragments of element k are fragOrder[elementStart[k] .. elementStart[k+1]). */
  readonly elementIds: Int32Array;
  readonly elementStart: Int32Array;
  readonly fragOrder: Int32Array;
  /** How many fragments use each unique geometry (instancing decisions). */
  readonly geomUses: Uint32Array;
  /** Entries per geometry in the shape table (5 before format 3, 7 from it). */
  readonly gstride: number;
  readonly geomCount: number;
  /** Texture pictures (PNG) by texture index. */
  readonly textures: (Uint8Array | null)[];
  private readonly materialCache = new Map<number, MaterialInfo>();
  private elementIndexCache: Map<number, number> | null = null;

  constructor(raw: RawSourceJob) {
    const { data } = raw;
    this.name = raw.name;
    this.data = data;
    this.propsData = raw.props;
    const header = data.header;
    this.unitScale = header.unitScale && header.unitScale > 0 ? header.unitScale : 0.3048;
    const up = header.up;
    this.yUp = Boolean(up && Math.abs(up[1]) > 0.9 && Math.abs(up[2]) < 0.1);
    this.roots = header.roots.slice();
    this.rootSet = new Set(header.roots);
    this.gstride = header.gmetaStride ?? 5;
    this.geomCount = Math.floor(data.gmeta.length / this.gstride);
    this.textures = raw.textures ?? [];

    let maxDb = 0;
    for (let i = 0; i < data.ndb.length; i++) if (data.ndb[i] > maxDb) maxDb = data.ndb[i];
    for (let i = 0; i < data.fdb.length; i++) if (data.fdb[i] > maxDb) maxDb = data.fdb[i];
    const size = maxDb + 1;
    this.parent = new Int32Array(size).fill(-1);
    this.type = new Uint8Array(size).fill(255);
    this.nameIndex = new Int32Array(size).fill(-1);
    this.container = new Uint8Array(size);
    this.memo = new Int32Array(size).fill(-1);
    for (let i = 0; i < data.ndb.length; i++) {
      const db = data.ndb[i];
      this.parent[db] = data.npar[i];
      this.type[db] = data.ntyp[i];
      this.nameIndex[db] = data.nname[i];
    }
    // A node that holds grouping nodes is a container, not an element.
    for (let i = 0; i < data.ndb.length; i++) {
      if (GROUPING_TYPES.has(data.ntyp[i])) {
        const p = data.npar[i];
        if (p < size && this.type[p] !== 255) this.container[p] = 1;
      }
    }

    // Element of every fragment, then fragments grouped by element.
    const nf = data.fdb.length;
    const fragElement = new Int32Array(nf);
    for (let f = 0; f < nf; f++) fragElement[f] = this.elementOf(data.fdb[f]);
    const order = Array.from({ length: nf }, (_, i) => i);
    order.sort((a, b) => fragElement[a] - fragElement[b] || a - b);
    this.fragOrder = Int32Array.from(order);
    const ids: number[] = [];
    const starts: number[] = [];
    for (let k = 0; k < nf; k++) {
      const e = fragElement[order[k]];
      if (k === 0 || e !== fragElement[order[k - 1]]) {
        ids.push(e);
        starts.push(k);
      }
    }
    starts.push(nf);
    this.elementIds = Int32Array.from(ids);
    this.elementStart = Int32Array.from(starts);

    const ng = this.geomCount;
    this.geomUses = new Uint32Array(ng);
    for (let f = 0; f < nf; f++) this.geomUses[data.fgeom[f]]++;

    if (raw.props) {
      const rows = raw.props.rows;
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r] as unknown[];
        this.propRow.set(Number(row[0]), r);
      }
    }
  }

  get elementCount() {
    return this.elementIds.length;
  }

  // ---------------------------------------------------------------------------
  // Tree

  private isGrouping(db: number) {
    const t = this.type[db];
    return (t !== 255 && GROUPING_TYPES.has(t)) || this.container[db] === 1;
  }

  hasNode(db: number) {
    return db >= 0 && db < this.type.length && this.type[db] !== 255;
  }

  parentOf(db: number): number {
    return db >= 0 && db < this.parent.length ? this.parent[db] : -1;
  }

  nodeName(db: number): string {
    const index = db >= 0 && db < this.nameIndex.length ? this.nameIndex[db] : -1;
    return index >= 0 ? (this.data.header.strings[index] ?? "") : "";
  }

  nodeType(db: number): number {
    return this.hasNode(db) ? this.type[db] : 6;
  }

  /** The element a node belongs to (see the rule at the top of this file). */
  elementOf(db: number): number {
    if (this.memo[db] >= 0) return this.memo[db];
    const chain: number[] = [];
    let d = db;
    let found = -1;
    while (this.hasNode(d) && !this.rootSet.has(d)) {
      if (this.memo[d] >= 0 && !this.isGrouping(d)) {
        found = this.memo[d];
        break;
      }
      chain.push(d);
      d = this.parent[d];
    }
    if (found < 0) {
      // chain runs leaf -> top; the element is the top-most non-grouping node.
      found = db;
      for (let k = chain.length - 1; k >= 0; k--) {
        if (!this.isGrouping(chain[k])) {
          found = chain[k];
          break;
        }
      }
    }
    for (const node of chain) if (!this.isGrouping(node)) this.memo[node] = found;
    this.memo[db] = found;
    return found;
  }

  /** The file root an element sits under (-1 when outside every root). */
  rootOf(db: number): number {
    let d = db;
    for (let guard = 0; guard < 4096 && d >= 0; guard++) {
      if (this.rootSet.has(d)) return d;
      if (!this.hasNode(d)) return -1;
      d = this.parent[d];
    }
    return -1;
  }

  /** Node names from the file root (inclusive) down to `db`. */
  pathNames(db: number): string[] {
    const out: string[] = [];
    let d = db;
    while (this.hasNode(d) && !this.rootSet.has(d)) {
      out.push(this.nodeName(d));
      d = this.parent[d];
    }
    if (this.rootSet.has(d)) out.push(this.nodeName(d));
    return out.reverse();
  }

  indexOfElement(e: number): number {
    if (!this.elementIndexCache) {
      this.elementIndexCache = new Map();
      for (let k = 0; k < this.elementIds.length; k++) this.elementIndexCache.set(this.elementIds[k], k);
    }
    return this.elementIndexCache.get(e) ?? -1;
  }

  // ---------------------------------------------------------------------------
  // Properties

  props(db: number): Props {
    const cached = this.propCache.get(db);
    if (cached) return cached;
    const out: Props = {};
    const row = this.propRow.get(db);
    const P = this.propsData;
    if (P && row !== undefined) {
      const S = P.strings;
      const raw = P.rows[row] as unknown[];
      if (P.format >= 2) {
        const N = P.numbers ?? [];
        for (let i = 1; i + 1 < raw.length; i += 2) {
          const key = S[raw[i] as number];
          const v = raw[i + 1] as number;
          out[key] = v >= 0 ? S[v] : N[-v - 1];
        }
      } else {
        const kv = raw[1] as Record<string, unknown>;
        const NS = S.length;
        for (const k in kv) {
          const key = S[Number(k)];
          const v = kv[k];
          if (typeof v !== "number") {
            out[key] = v as PropValue;
            continue;
          }
          const kind = keyKind(key);
          if (kind === "n") out[key] = v;
          else if (kind === "s") out[key] = Number.isInteger(v) && v >= 0 && v < NS ? S[v] : v;
          else out[key] = !Number.isInteger(v) ? v : v >= 0 && v < NS ? S[v] : v; // mixed: a fraction is a number
        }
      }
    }
    if (this.propCache.size > 20000) this.propCache.clear();
    this.propCache.set(db, out);
    return out;
  }

  /** Category, family, type, level and file of an element: properties first, the model tree as fallback. */
  info(e: number): ElementInfo {
    const p = this.props(e);
    const names = this.pathNames(e);
    let cat = firstString(p, CATEGORY_KEYS).replace(/^Revit\s+/, "");
    let fam = firstString(p, FAMILY_KEYS);
    let typ = firstString(p, TYPE_KEYS);
    let lvl = firstString(p, LEVEL_KEYS);
    // Tree: file > [linked model] > [level] > category > family > type > element [> part]. Some NWC files
    // carry only the Revit Type tab, and parts of stairs and stacked walls carry no properties at all,
    // so each missing name is read off the tree, anchored on the category.
    const body = names.slice(1);
    let ci = -1;
    for (let k = 0; k < body.length - 1; k++) {
      if (body[k] === cat || (!cat && REVIT_CATEGORIES.has(body[k]))) {
        ci = k;
        break;
      }
    }
    if (ci < 0 && body.length >= 4) ci = Math.max(body.length - 4, 0);
    if (ci >= 0) {
      cat = cat || body[ci];
      fam = fam || (ci + 1 < body.length - 1 ? body[ci + 1] : "");
      typ = typ || (ci + 2 < body.length - 1 ? body[ci + 2] : "");
      if (!lvl && ci >= 1 && !/\.(rvt|nwc|nwd|dwg|ifc)\b/i.test(body[ci - 1])) lvl = body[ci - 1];
    } else {
      cat = cat || body[0] || "";
    }
    return { category: cat, family: fam, type: typ, level: lvl, file: names[0] ?? "", props: p };
  }

  /** GlobalId the source model gives this element: Navisworks' item GUID, or Revit's export GUID from the UniqueId. */
  sourceGuid(e: number, p: Props = this.props(e)): string | null {
    const item = p["Item/GUID"] ?? p["Element/GUID"] ?? p["Identity Data/IfcGUID"] ?? p["IFC Parameters/IfcGUID"];
    if (typeof item === "string") {
      const g = guidFromUuid(item);
      if (g) return g;
      if (/^[0-9A-Za-z_$]{22}$/.test(item.trim())) return item.trim();
    }
    const ext = p["__externalId__"];
    if (typeof ext === "string") return guidFromRevitUniqueId(ext);
    return null;
  }

  /** Revit element id: the Element tab's Id, or the "[123456]" suffix Revit puts on node names. */
  elementId(e: number, p: Props = this.props(e)): string {
    const id = p["Element/Id"] ?? p["Identity Data/Element ID"] ?? p["Other/ElementId"];
    if (id !== undefined && id !== "") return String(typeof id === "number" ? Math.round(id) : id);
    const match = /\[(\d+)\]\s*$/.exec(this.nodeName(e));
    return match ? match[1] : "";
  }

  // ---------------------------------------------------------------------------
  // Geometry

  fragmentMatrix(fi: number): Affine {
    return fromFragment(this.data.fmtx, fi * 12);
  }

  geomFlags(gi: number): number {
    return this.data.gmeta[gi * this.gstride + 2];
  }

  /** Whether shape `gi` is line segments rather than triangles. */
  isLines(gi: number): boolean {
    return (this.geomFlags(gi) & GEOM_LINES) !== 0;
  }

  vertexCount(gi: number): number {
    return this.data.gmeta[gi * this.gstride];
  }

  /**
   * Unique geometry `gi`: positions in the viewer's geometry space (quantised
   * positions decode as u/65535 - 0.5, before the fragment matrix) and its
   * index list: triangles, or segments (pairs) for line shapes.
   */
  geometry(gi: number): { positions: Float64Array; indices: Uint32Array } {
    const g = this.data.gmeta;
    const k = gi * this.gstride;
    const nv = g[k],
      ni = g[k + 1],
      flags = g[k + 2],
      po = g[k + 3],
      io = g[k + 4];
    const positions = new Float64Array(nv * 3);
    if (flags & GEOM_QUANTIZED) {
      const q = this.data.posQ;
      for (let i = 0; i < nv * 3; i++) positions[i] = q[po * 3 + i] / 65535 - 0.5;
    } else {
      const f = this.data.posF;
      for (let i = 0; i < nv * 3; i++) positions[i] = f[po * 3 + i];
    }
    const per = flags & GEOM_LINES ? 2 : 3;
    let indices: Uint32Array;
    if (flags & GEOM_NON_INDEXED) {
      const n = nv - (nv % per);
      indices = new Uint32Array(n);
      for (let i = 0; i < n; i++) indices[i] = i;
    } else {
      const n = ni - (ni % per);
      const source = flags & GEOM_INDEX32 ? this.data.i32 : this.data.i16;
      indices = new Uint32Array(n);
      for (let i = 0; i < n; i++) indices[i] = source[io + i];
    }
    return { positions, indices };
  }

  /** Texture coordinates (u, v per vertex) of shape `gi`, as stored (before the material's texture matrix). */
  uvs(gi: number): Float32Array | null {
    if (this.gstride < 7) return null;
    const k = gi * this.gstride;
    const offset = this.data.gmeta[k + 5];
    if (offset === GEOM_NONE) return null;
    const nv = this.data.gmeta[k];
    if ((offset + nv) * 2 > this.data.uv.length) return null;
    return this.data.uv.subarray(offset * 2, (offset + nv) * 2);
  }

  /** Vertex colours (r, g, b bytes per vertex) of shape `gi`. */
  vertexColours(gi: number): Uint8Array | null {
    if (this.gstride < 7) return null;
    const k = gi * this.gstride;
    const offset = this.data.gmeta[k + 6];
    if (offset === GEOM_NONE) return null;
    const nv = this.data.gmeta[k];
    if ((offset + nv) * 3 > this.data.col.length) return null;
    return this.data.col.subarray(offset * 3, (offset + nv) * 3);
  }

  triangleCount(gi: number): number {
    const g = this.data.gmeta;
    const k = gi * this.gstride;
    const flags = g[k + 2];
    if (flags & GEOM_LINES) return 0;
    return Math.floor((flags & GEOM_NON_INDEXED ? g[k] : g[k + 1]) / 3);
  }

  /** The material as the viewer shades it. */
  materialInfo(mi: number): MaterialInfo {
    let info = this.materialCache.get(mi);
    if (!info) {
      const header = this.data.header;
      info = materialInfo(header.materials3?.[mi], header.materials[mi]);
      this.materialCache.set(mi, info);
    }
    return info;
  }

  material(mi: number): { hex: string; opacity: number; name: string } {
    const info = this.materialInfo(mi);
    return { hex: info.color, opacity: info.opacity, name: info.name };
  }

  textureMeta(ti: number): TextureMeta | null {
    return this.data.header.textures?.[ti] ?? null;
  }

  textureBytes(ti: number): Uint8Array | null {
    return this.textures[ti] ?? null;
  }
}
