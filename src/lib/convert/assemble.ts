// The conversion itself: extracted models (and traced plans) in, IFC4 files
// out — one per discipline and, optionally, one federated file with all of
// them, all in the same site, building, storeys and coordinates.

import { faceColours, multiplyHex, reflectanceMethod, rgb, surfaceColour, transformUvs, type MaterialInfo } from "./appearance";
import type { RawSourceJob } from "./bundle";
import { classify } from "./classify";
import { disciplineCode, disciplineLabel, suggestDiscipline } from "./disciplines";
import { ifcClass, ifcTypeClass, type IfcClassInfo } from "./ifc/schema";
import { hashGuid, real } from "./ifc/step";
import { IfcFileWriter, type ElementDef, type ItemDef, type MeshText, type OpeningDef, type ProfileDef, type PropEntry, type PsetDef, type StyleDef, type TextureRef, type TypeDef, type Vec3 } from "./ifc/writer";
import { chain, determinant3, multiply, rotationZ, scaling, transformBox, translation, type Affine } from "./math";
import { meshText, polylines, shellTopology } from "./mesh";
import { SourceJob, type ElementInfo, type Props } from "./model";
import { buildPreview, type PreviewData, type PreviewItem } from "./preview";
import { buildRegister, type AssetOptions, type AssetRegister, type RegisterAsset, type RegisterSpace, type RegisterType } from "./assets/register";
import { columnLabel, cobieWorkbook, FIRE_COLUMNS, registerWorkbook, TECHNICAL_COLUMNS, typeDurations, type WorkbookSettings } from "./assets/workbook";
import { FIELD_BY_ID, isoDuration, parseDuration, parseNumber, parseUnit } from "./assets/fields";
import type { RegisterBoard } from "./assets/electrical";
import { sldHtml } from "./assets/sld";
import { detectStoreys, emptyLevelStats, levelIndex, mergeLevelStats, sampleLevel, storeyFor, type LevelStats, type StoreyDef } from "./storeys";
import { planHasContent, type BBox, type ConvertOptions, type ConvertReport, type JobSummary, type OutputFile, type PartSummary, type PlanOpening, type PlanPart, type ProgressFn } from "./types";

/**
 * Mirrored instances (a placement with a negative determinant) get their own
 * shared shape, mirrored in its local X with the winding reversed, placed by
 * a transform without the reflection. IFC viewers differ in how they treat a
 * mirroring IfcMappedItem (web-ifc and IfcOpenShell keep the triangle order,
 * so the shape shows its inside); with no reflection left in the placement,
 * every viewer draws it the same way.
 */

const KEY_FIELDS: [string, string[], "length" | null][] = [
  ["Workset", ["Element/Workset", "Identity Data/Workset", "Other/Workset"], null],
  ["SystemClassification", ["Element/System Classification", "Mechanical/System Classification", "Plumbing/System Classification"], null],
  ["SystemType", ["Element/System Type", "Mechanical/System Type", "Plumbing/System Type"], null],
  ["SystemName", ["Element/System Name", "Mechanical/System Name", "Plumbing/System Name"], null],
  ["Size", ["Element/Size", "Mechanical/Size", "Dimensions/Size"], null],
  ["OverallSize", ["Element/Overall Size", "Mechanical/Overall Size", "Dimensions/Overall Size"], null],
  ["Diameter", ["Element/Diameter", "Dimensions/Diameter"], "length"],
  ["OutsideDiameter", ["Element/Outside Diameter", "Dimensions/Outside Diameter"], "length"],
  ["Length", ["Element/Length", "Dimensions/Length"], "length"],
  ["Flow", ["Element/Flow", "Mechanical - Flow/Flow", "Mechanical/Flow"], null],
  ["FreeSize", ["Element/Free Size"], null],
  ["Mark", ["Element/Mark", "Identity Data/Mark"], null],
  ["Comments", ["Element/Comments", "Identity Data/Comments"], null],
  ["Room", ["Element/Room"], null],
  ["TypeMark", ["Revit Type/Type Mark", "Identity Data/Type Mark"], null],
  ["Manufacturer", ["Revit Type/Manufacturer", "Identity Data/Manufacturer"], null],
  ["Model", ["Revit Type/Model", "Identity Data/Model"], null],
  ["Description", ["Revit Type/Description", "Identity Data/Description"], null],
  ["SystemDescription", ["System Type/Description"], null],
];

// Display units the viewer reports, as metres per unit (lengths only; anything else stays a plain number).
const LENGTH_UNITS: [RegExp, number][] = [
  [/^(ft|feet|foot|decimal-ft|ft-and-.*|feet-and-.*)$/i, 0.3048],
  [/^(in|inch|inches|decimal-in|fractional-in)$/i, 0.0254],
  [/^(m|meter|meters|metre|metres|m-and-cm)$/i, 1],
  [/^(cm|centimeter|centimeters|centimetre|centimetres)$/i, 0.01],
  [/^(mm|millimeter|millimeters|millimetre|millimetres)$/i, 0.001],
];

function lengthUnit(unit: string | undefined): number | null {
  if (!unit) return null;
  for (const [re, scale] of LENGTH_UNITS) if (re.test(unit.trim())) return scale;
  return null;
}

const slug = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "model";

/** Strips characters file systems refuse, keeps the name readable. */
export function safeFileStem(text: string) {
  return (
    text
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "model"
  );
}

interface PartState {
  summary: PartSummary;
  levels: Map<string, LevelStats>;
  unassigned: number[];
}

/** Content hash of a picture (FNV-1a, two lanes), for file names and de-duplication. */
function hashBytes(bytes: Uint8Array): string {
  let a = 0x811c9dc5,
    b = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b ^ bytes[i], 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0").slice(0, 4);
}

const isWhite = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return r > 0.99 && g > 0.99 && b > 0.99;
};

/** Vertex colour analysis of one shape: uniform colour, area-weighted mean, per-face colours. */
type ColourInfo = ReturnType<typeof faceColours>;

/** viewer world -> metres in the model's own coordinates (global offset added back, Z up). */
function modelToMetres(job: SourceJob): Affine {
  const go = job.data.header.globalOffset ?? [0, 0, 0];
  const base = chain(scaling(job.unitScale), translation(go[0], go[1], go[2]));
  if (!job.yUp) return base;
  const yUpToZUp = Float64Array.of(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0);
  return multiply(yUpToZUp, base);
}

function unionBox(into: BBox | null, box: ArrayLike<number>): BBox {
  if (!into) return [box[0], box[1], box[2], box[3], box[4], box[5]];
  for (let i = 0; i < 3; i++) {
    if (box[i] < into[i]) into[i] = box[i];
    if (box[i + 3] > into[i + 3]) into[i + 3] = box[i + 3];
  }
  return into;
}

/** Adds a storey for every plan whose height no storey is within 0.3 m of. */
export function withPlanStoreys(storeys: StoreyDef[], plans: PlanPart[]): StoreyDef[] {
  const out = storeys.map((s) => ({ ...s }));
  for (const plan of plans) {
    if (out.some((s) => Math.abs(s.elevation - plan.storey.elevation) <= 0.3)) continue;
    let key = `p${out.length}`;
    while (out.some((s) => s.key === key)) key += "_";
    out.push({ key, name: plan.storey.name || `Level ${plan.storey.elevation.toFixed(2)}`, elevation: plan.storey.elevation, levels: [], count: 0 });
  }
  if (out.length === 0) out.push({ key: "s0", name: "Level 0", elevation: 0, levels: [], count: 0 });
  return out.sort((a, b) => a.elevation - b.elevation);
}

const ELECTRICAL_IFC = ["voltage", "phases", "distributionSystem", "mainsRating", "ways", "connectedLoad", "demandLoad", "faultLevel", "poles", "breakerRating", "cableSize", "loadName", "loadClassification", "ipRating"];
const TECHNICAL_IFC = TECHNICAL_COLUMNS.filter((id) => FIELD_BY_ID.get(id)?.group === "technical");

/** Field values as IFC properties: quantities as reals named with their unit ("Airflow (L/s)"), the rest as labels. */
function fieldProps(a: RegisterAsset, ids: string[]): PropEntry[] {
  return ids
    .filter((id) => a.values[id])
    .map((id) => {
      const f = FIELD_BY_ID.get(id)!;
      const n = Number(a.values[id]);
      return f.kind === "quantity" && Number.isFinite(n) ? { name: columnLabel(id), value: n, kind: "real" as const } : { name: f.label, value: a.values[id] };
    });
}

/** IFC property sets of an asset: manufacturer, occurrence, warranty, service life and the register's own. */
function assetPsets(a: RegisterAsset, space: RegisterSpace | null, board?: RegisterBoard): PsetDef[] {
  const v = a.values;
  const warranty = isoDuration(parseDuration(v.warrantyDurationParts, parseUnit(v.warrantyDurationUnit) || "year"));
  const life = isoDuration(parseDuration(v.expectedLife, parseUnit(v.durationUnit) || "year"));
  const full = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "");
  const cost = parseNumber(v.replacementCost);
  return [
    {
      name: "Pset_ManufacturerTypeInformation",
      props: [
        { name: "Manufacturer", value: v.manufacturer },
        { name: "ModelLabel", value: v.model },
        { name: "ModelReference", value: v.modelReference },
        { name: "ProductionYear", value: v.manufactureYear },
      ],
    },
    {
      name: "Pset_ManufacturerOccurrence",
      props: [
        { name: "SerialNumber", value: v.serialNumber, kind: "identifier" },
        { name: "BarCode", value: v.barCode, kind: "identifier" },
      ],
    },
    {
      name: "Pset_Warranty",
      props: [
        { name: "WarrantyStartDate", value: full(v.warrantyStartDate), kind: "date" },
        { name: "WarrantyEndDate", value: full(v.warrantyEndDate), kind: "date" },
        { name: "WarrantyPeriod", value: warranty, kind: "duration" },
        { name: "PointOfContact", value: v.warrantyGuarantorParts },
        { name: "WarrantyContent", value: v.warrantyDescription, kind: "text" },
      ],
    },
    { name: "Pset_ServiceLife", props: [{ name: "ServiceLifeDuration", value: life, kind: "duration" }] },
    {
      name: "IFCStudio_Asset",
      props: [
        { name: "AssetName", value: a.name },
        { name: "AssetCode", value: a.code, kind: "identifier" },
        { name: "AssetKind", value: a.kind },
        { name: "KindCode", value: a.kindCode, kind: "identifier" },
        { name: "Discipline", value: a.discipline },
        { name: "TagNumber", value: v.tag },
        { name: "AssetIdentifier", value: v.assetIdentifier, kind: "identifier" },
        { name: "InstallationDate", value: v.installationDate, kind: "date" },
        { name: "ManufacturingYear", value: v.manufactureYear },
        { name: "EndOfLife", value: v.endOfLife ? `${v.endOfLife}${a.derived.includes("endOfLife") ? " (installation year + expected life)" : ""}` : "" },
        { name: "Floor", value: a.floor },
        { name: "Space", value: a.space },
        { name: "SpaceName", value: space?.roomName ?? "" },
        { name: "LocationCode", value: a.locationCode, kind: "identifier" },
        { name: "LocationPath", value: a.locationPath },
        { name: "ParentAsset", value: a.parent },
        { name: "Parts", value: a.children.join(", ") },
        { name: "Systems", value: a.systems.map((x) => x.name).join(", ") },
        { name: "FedFrom", value: v.panel },
        { name: "Circuit", value: v.circuit },
        { name: "ServedBy", value: a.servedBy.join(", ") },
        { name: "Serves", value: a.serves.join(", ") },
        { name: "ServingSpaces", value: a.servingSpaces.join(", ") },
        { name: "Condition", value: v.condition },
        { name: "Status", value: v.status },
        { name: "Supplier", value: v.supplier },
        { name: "InstalledBy", value: v.installer },
        { name: "ReplacementCost", value: cost ?? "", kind: "real" },
        { name: "PPMTask", value: v.ppmTask },
        { name: "PPMFrequency", value: v.ppmFrequency + (v.ppmFrequencyUnit ? ` ${v.ppmFrequencyUnit}` : "") },
        { name: "Criticality", value: v.criticality },
        { name: "Maintainer", value: v.maintainer },
        { name: "Statutory", value: v.statutory },
        { name: "ComplianceGroupSuggested", value: a.compliance },
        { name: "UniclassPrSuggested", value: v.classification || !a.uniclass ? "" : `${a.uniclass[0]}: ${a.uniclass[1]}` },
      ],
    },
    {
      name: "IFCStudio_Electrical",
      props: [
        ...fieldProps(a, ELECTRICAL_IFC),
        ...(board
          ? [
              { name: "BoardLevel", value: board.level, kind: "integer" as const },
              { name: "FeedPath", value: board.path.join(" > ") },
              { name: "BoardsFed", value: board.boards.join(", ") },
              { name: "Circuits", value: board.circuits, kind: "integer" as const },
              { name: "ItemsDownstream", value: board.downstream, kind: "integer" as const },
              ...(board.connectedLoadSource === "sum of loads" && board.connectedLoad !== null ? [{ name: "Connected load, sum of fed items (kVA)", value: board.connectedLoad, kind: "real" as const }] : []),
            ]
          : []),
      ],
    },
    { name: "IFCStudio_Technical", props: fieldProps(a, TECHNICAL_IFC) },
    { name: "IFCStudio_FireSafety", props: fieldProps(a, FIRE_COLUMNS) },
    ...(a.ifcClass === "IfcDoor" && v.fireRating ? [{ name: "Pset_DoorCommon", props: [{ name: "FireRating", value: v.fireRating }] }] : []),
  ];
}

/** IFC property sets of a room: its number, areas, department and what serves it. */
function spacePsets(sp: RegisterSpace, source: string): PsetDef[] {
  return [
    {
      name: "Pset_SpaceCommon",
      props: [
        { name: "Reference", value: sp.number, kind: "identifier" },
        { name: "GrossPlannedArea", value: sp.grossArea ?? "", kind: "area" },
        { name: "NetPlannedArea", value: sp.netArea ?? "", kind: "area" },
      ],
    },
    {
      name: "IFCStudio_Space",
      props: [
        { name: "RoomName", value: sp.roomName },
        { name: "RoomNumber", value: sp.number },
        { name: "Floor", value: sp.floor },
        { name: "Category", value: sp.category },
        { name: "Department", value: sp.department },
        { name: "Occupant", value: sp.occupant },
        { name: "Source", value: source },
        { name: "Assets", value: String(sp.assets.length), kind: "integer" },
        { name: "ServedBy", value: [...new Set(sp.servedBy)].join(", ") },
      ],
    },
  ];
}

/** IFC property sets of an asset type (on the type object). */
function typeAssetPsets(t: RegisterType): PsetDef[] {
  const v = t.values;
  const { warranty, life } = typeDurations(v);
  return [
    {
      name: "Pset_ManufacturerTypeInformation",
      props: [
        { name: "Manufacturer", value: v.manufacturer },
        { name: "ModelLabel", value: v.model },
        { name: "ModelReference", value: v.modelReference },
      ],
    },
    {
      name: "Pset_Warranty",
      props: [
        { name: "WarrantyPeriod", value: warranty, kind: "duration" },
        { name: "PointOfContact", value: v.warrantyGuarantorParts },
        { name: "WarrantyContent", value: v.warrantyDescription, kind: "text" },
      ],
    },
    { name: "Pset_ServiceLife", props: [{ name: "ServiceLifeDuration", value: life, kind: "duration" }] },
  ];
}

export class Converter {
  readonly jobs = new Map<string, SourceJob>();
  private readonly parts = new Map<string, PartState>();
  private readonly topology = new Map<string, Int8Array>();
  private readonly orient = new Map<string, Int8Array>();
  private readonly colourCache = new Map<string, ColourInfo | null>();
  private readonly textureCache = new Map<string, TextureRef | null>();
  private readonly texturePaths = new Map<string, string>();
  /** GlobalIds of the last generation ("job|dbId" -> id), so the asset register matches the IFC files. */
  private lastGuids: { projectKey: string; ids: Map<string, string> } | null = null;
  /** The last asset register, reused while the settings it was built with stand. */
  private registerCache: { key: string; register: AssetRegister } | null = null;
  cancelled = false;

  // ---------------------------------------------------------------------------
  // Sources

  addJobs(raw: RawSourceJob[], onProgress?: ProgressFn): string[] {
    const added: string[] = [];
    for (const r of raw) {
      let name = r.name;
      for (let n = 2; this.jobs.has(name); n++) name = `${r.name}-${n}`;
      const job = new SourceJob({ ...r, name });
      this.jobs.set(name, job);
      this.analyzeJob(job, onProgress);
      added.push(name);
    }
    return added;
  }

  removeJob(name: string) {
    this.registerCache = null;
    this.jobs.delete(name);
    this.topology.delete(name);
    this.orient.delete(name);
    for (const id of [...this.parts.keys()]) if (id.startsWith(`${name}#`)) this.parts.delete(id);
    for (const cache of [this.colourCache, this.textureCache]) for (const key of [...cache.keys()]) if (key.startsWith(`${name}|`)) cache.delete(key);
  }

  clear() {
    this.registerCache = null;
    this.jobs.clear();
    this.parts.clear();
    this.topology.clear();
    this.orient.clear();
    this.colourCache.clear();
    this.textureCache.clear();
    this.texturePaths.clear();
  }

  partId(job: SourceJob, root: number) {
    return `${job.name}#${root}`;
  }

  private analyzeJob(job: SourceJob, onProgress?: ProgressFn) {
    const toMetres = modelToMetres(job);
    const box = new Float64Array(6);
    const fbox = job.data.fbox;
    const header = job.data.header;
    const propsMode = !job.propsData ? "none" : job.propsData.format >= 2 && (job.propsData as { mode?: string }).mode === "all" ? "all" : "key";
    const states = new Map<number, PartState>();
    const stateFor = (root: number): PartState => {
      let state = states.get(root);
      if (!state) {
        const name = root >= 0 ? job.nodeName(root) || header.file || job.name : header.file || header.model || job.name;
        state = {
          summary: {
            id: this.partId(job, root),
            job: job.name,
            root,
            name,
            model: header.model || (header.source ? header.source.replace(/\s+via\s+.*$/i, "").replace(/\.(nwd|nwc|rvt)$/i, "") : job.name),
            elements: 0,
            fragments: 0,
            triangles: 0,
            categories: {},
            levels: {},
            bbox: null,
            suggestion: { id: "other", reason: "" },
            format: header.format ?? 1,
            propsMode,
          },
          levels: new Map(),
          unassigned: [],
        };
        states.set(root, state);
      }
      return state;
    };
    const n = job.elementCount;
    for (let k = 0; k < n; k++) {
      if (onProgress && k % 5000 === 0) onProgress(`Reading ${job.name}`, k, n);
      const e = job.elementIds[k];
      const root = job.rootOf(e);
      const state = stateFor(root);
      const s = state.summary;
      const info = job.info(e);
      let ebox: BBox | null = null;
      for (let j = job.elementStart[k]; j < job.elementStart[k + 1]; j++) {
        const f = job.fragOrder[j];
        transformBox(toMetres, fbox, f * 6, box);
        ebox = unionBox(ebox, box);
        s.triangles += job.triangleCount(job.data.fgeom[f]);
        s.fragments++;
      }
      s.elements++;
      const category = info.category || "(no category)";
      s.categories[category] = (s.categories[category] ?? 0) + 1;
      if (ebox) {
        s.bbox = unionBox(s.bbox, ebox);
        if (info.level) {
          s.levels[info.level] = (s.levels[info.level] ?? 0) + 1;
          let stats = state.levels.get(info.level);
          if (!stats) state.levels.set(info.level, (stats = emptyLevelStats()));
          sampleLevel(stats, category, ebox[2], ebox[5]);
        } else if (state.unassigned.length < 20000) state.unassigned.push(ebox[2]);
      }
    }
    for (const state of states.values()) {
      state.summary.suggestion = suggestDiscipline(`${state.summary.name} ${state.summary.model}`, state.summary.categories);
      this.parts.set(state.summary.id, state);
    }
  }

  summaries(): PartSummary[] {
    return [...this.parts.values()].map((p) => p.summary);
  }

  jobSummaries(): JobSummary[] {
    return [...this.jobs.values()].map((job) => ({
      name: job.name,
      model: job.data.header.model || (job.data.header.source ? job.data.header.source.replace(/\s+via\s+.*$/i, "").replace(/\.(nwd|nwc|rvt)$/i, "") : job.name),
      bytes: job.data.bytes,
      parts: this.summaries()
        .filter((p) => p.job === job.name)
        .map((p) => p.id),
      stats: (job.data.header.stats ?? {}) as Record<string, number>,
      unitScale: job.unitScale,
    }));
  }

  /** Storeys from the levels of the given parts (all parts when omitted). */
  detectStoreys(partIds?: string[]): StoreyDef[] {
    const levels = new Map<string, LevelStats>();
    const unassigned: number[] = [];
    for (const [id, state] of this.parts) {
      if (partIds && !partIds.includes(id)) continue;
      for (const [name, stats] of state.levels) {
        let into = levels.get(name);
        if (!into) levels.set(name, (into = emptyLevelStats()));
        mergeLevelStats(into, stats);
      }
      for (const z of state.unassigned) if (unassigned.length < 50000) unassigned.push(z);
    }
    return detectStoreys(levels, unassigned);
  }

  /** The model-coordinate box of the given parts, metres. */
  bounds(partIds?: string[]): BBox | null {
    let box: BBox | null = null;
    for (const [id, state] of this.parts) {
      if (partIds && !partIds.includes(id)) continue;
      if (state.summary.bbox) box = unionBox(box, state.summary.bbox);
    }
    return box;
  }

  /** Site origin and rotation for a frame setting. */
  resolveFrame(options: Pick<ConvertOptions, "frame">, partIds?: string[]): { origin: Vec3; rotation: number } {
    const f = options.frame;
    if (f.mode === "custom") return { origin: [f.origin[0] || 0, f.origin[1] || 0, f.origin[2] || 0], rotation: ((f.rotationDeg || 0) * Math.PI) / 180 };
    if (f.mode === "model") return { origin: [0, 0, 0], rotation: 0 };
    const box = this.bounds(partIds);
    if (!box) return { origin: [0, 0, 0], rotation: 0 };
    const cx = (box[0] + box[3]) / 2;
    const cy = (box[1] + box[4]) / 2;
    // Models near the origin keep their coordinates; far-away (survey) coordinates move into the site placement.
    if (Math.hypot(cx, cy) < 1000) return { origin: [0, 0, 0], rotation: 0 };
    return { origin: [Math.round(cx), Math.round(cy), 0], rotation: 0 };
  }

  // ---------------------------------------------------------------------------
  // Geometry checks

  /**
   * Which way a shape's triangles face: +1 outward, -1 inward, 0 unknown (open
   * patches). Signed volume about the box centre; trusted when it is a fair
   * share of the box. Navisworks stores the shapes of mirrored instances wound
   * the other way, so that the mirror turns them right again; shapes shared by
   * mirrored and plain instances need one of the two corrected.
   */
  private orientation(job: SourceJob, gi: number): number {
    let cache = this.orient.get(job.name);
    if (!cache) {
      cache = new Int8Array(job.geomCount).fill(2);
      this.orient.set(job.name, cache);
    }
    if (cache[gi] === 2) {
      const { positions: V, indices: F } = job.geometry(gi);
      let x0 = Infinity,
        y0 = Infinity,
        z0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity,
        z1 = -Infinity;
      for (let i = 0; i < V.length; i += 3) {
        x0 = Math.min(x0, V[i]);
        x1 = Math.max(x1, V[i]);
        y0 = Math.min(y0, V[i + 1]);
        y1 = Math.max(y1, V[i + 1]);
        z0 = Math.min(z0, V[i + 2]);
        z1 = Math.max(z1, V[i + 2]);
      }
      const cx = (x0 + x1) / 2,
        cy = (y0 + y1) / 2,
        cz = (z0 + z1) / 2;
      const box = (x1 - x0) * (y1 - y0) * (z1 - z0);
      let vol = 0;
      for (let t = 0; t + 2 < F.length; t += 3) {
        const a = F[t] * 3,
          b = F[t + 1] * 3,
          c = F[t + 2] * 3;
        const ax = V[a] - cx,
          ay = V[a + 1] - cy,
          az = V[a + 2] - cz;
        const bx = V[b] - cx,
          by = V[b + 1] - cy,
          bz = V[b + 2] - cz;
        const qx = V[c] - cx,
          qy = V[c + 1] - cy,
          qz = V[c + 2] - cz;
        vol += ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
      }
      vol /= 6;
      cache[gi] = box > 0 && Math.abs(vol) > 0.02 * box ? Math.sign(vol) : 0;
    }
    return cache[gi];
  }

  private isOpen(job: SourceJob, gi: number): boolean {
    let cache = this.topology.get(job.name);
    if (!cache) {
      cache = new Int8Array(job.geomCount).fill(-1);
      this.topology.set(job.name, cache);
    }
    if (cache[gi] < 0) {
      const { positions, indices } = job.geometry(gi);
      const quantized = (job.geomFlags(gi) & 1) === 1;
      const t = shellTopology(positions, indices, quantized ? 0.5 / 65535 : 1e-5);
      cache[gi] = t.open || t.misoriented ? 1 : 0;
    }
    return cache[gi] === 1;
  }

  // ---------------------------------------------------------------------------
  // Appearance

  /** Vertex colours of shape `gi`, analysed once (null when the shape has none). */
  private colourInfo(job: SourceJob, gi: number): ColourInfo | null {
    const key = `${job.name}|${gi}`;
    if (this.colourCache.has(key)) return this.colourCache.get(key)!;
    const colours = job.vertexColours(gi);
    let info: ColourInfo | null = null;
    if (colours && !job.isLines(gi)) {
      const { positions, indices } = job.geometry(gi);
      info = faceColours(positions, indices, colours);
    }
    if (this.colourCache.size > 200_000) this.colourCache.clear();
    this.colourCache.set(key, info);
    return info;
  }

  /** The picture of texture `ti`, named after its source file and content. Null when it was not extracted. */
  textureRef(job: SourceJob, ti: number): TextureRef | null {
    const key = `${job.name}|${ti}`;
    if (this.textureCache.has(key)) return this.textureCache.get(key)!;
    const bytes = job.textureBytes(ti);
    let ref: TextureRef | null = null;
    if (bytes && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
      const id = hashBytes(bytes);
      let path = this.texturePaths.get(id);
      if (!path) {
        const meta = job.textureMeta(ti);
        const stem =
          (meta?.name ?? "")
            .replace(/\.[a-z0-9]+$/i, "")
            .normalize("NFKD")
            .replace(/[^A-Za-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "texture";
        path = `textures/${stem}-${id.slice(0, 8)}.png`;
        this.texturePaths.set(id, path);
      }
      ref = { id, path, bytes, repeatS: true, repeatT: true };
    }
    this.textureCache.set(key, ref);
    return ref;
  }

  /** The IFC style of material `mi`, for a shape whose vertex colours average to `vertexHex`. */
  private styleOf(job: SourceJob, material: MaterialInfo, vertexHex: string | null, textures: boolean): StyleDef {
    const texture = textures && material.texture >= 0 ? this.textureRef(job, material.texture) : null;
    const average = material.texture >= 0 ? (job.textureMeta(material.texture)?.avg ?? null) : null;
    const surface = surfaceColour(material, average, vertexHex);
    let diffuse: string | null = null;
    // A tinted picture: the tint is the diffuse colour the texture modulates.
    if (texture && !isWhite(material.color)) diffuse = vertexHex && material.vertexColors ? multiplyHex(material.color, vertexHex) : material.color;
    return {
      hex: surface,
      opacity: material.opacity,
      name: material.name || undefined,
      diffuse,
      specular: material.specular,
      shininess: material.shininess,
      roughness: material.roughness,
      method: reflectanceMethod(material),
      texture: texture ? { ...texture, repeatS: material.repeatS, repeatT: material.repeatT } : null,
    };
  }

  /** IFC type object for an element of a Revit family type. */
  private typeOf(cls: IfcClassInfo, predefined: string | null, info: ElementInfo, props: Props, assetType?: RegisterType): TypeDef | null {
    if (!info.family && !info.type) return null;
    // IFC4's own rule for IfcTransformer names its type misspelt ('IFCTRANFORMERTYPE'), so no type passes it.
    if (cls.name === "IfcTransformer") return null;
    const typeClass = ifcTypeClass(cls.name);
    if (!typeClass) return null;
    const name = info.family ? (!info.type || info.type === info.family ? info.family : `${info.family}:${info.type}`) : info.type;
    const typeProps: PropEntry[] = [];
    for (const [key, value] of Object.entries(props)) {
      if (!key.startsWith("Revit Type/") || value === "" || value === null || value === undefined) continue;
      typeProps.push({ name: key.slice("Revit Type/".length), value });
      if (typeProps.length >= 200) break;
    }
    const psets: PsetDef[] = typeProps.length ? [{ name: "Revit Type", props: typeProps }] : [];
    if (assetType) psets.push(...typeAssetPsets(assetType));
    return {
      key: `${typeClass.name}|${info.category}|${info.family}|${info.type}`,
      cls: typeClass,
      name,
      description: info.category || null,
      elementType: info.type || info.family || null,
      predefined,
      psets,
    };
  }

  // ---------------------------------------------------------------------------
  // Asset register

  /** The storeys a conversion with these options uses. */
  private storeysFor(options: ConvertOptions): StoreyDef[] {
    const partIds = options.parts.filter((p) => p.include).map((p) => p.id);
    return withPlanStoreys(options.storeys.length ? options.storeys : partIds.length ? this.detectStoreys(partIds) : [], options.plans.filter((p) => p.include && planHasContent(p)));
  }

  /** Assets, types, spaces, systems and serving relationships of the included parts. */
  assetRegister(options: ConvertOptions, assets: AssetOptions, onProgress?: ProgressFn): AssetRegister {
    const included = new Set(options.parts.filter((p) => p.include).map((p) => p.id));
    const projectKey = `${options.projectName}|${options.filePrefix}`;
    const cacheKey = JSON.stringify([
      projectKey,
      [...included].sort(),
      options.storeys.map((st) => [st.key, st.name, st.elevation, st.levels]),
      options.siteName,
      options.buildingName,
      assets,
      this.lastGuids?.projectKey === projectKey ? this.lastGuids.ids.size : 0,
      [...this.jobs.keys()],
    ]);
    if (this.registerCache?.key === cacheKey) return this.registerCache.register;
    const register = this.buildAssetRegister(options, assets, included, projectKey, onProgress);
    this.registerCache = { key: cacheKey, register };
    return register;
  }

  private buildAssetRegister(options: ConvertOptions, assets: AssetOptions, included: Set<string>, projectKey: string, onProgress?: ProgressFn): AssetRegister {
    const cached = this.lastGuids?.projectKey === projectKey ? this.lastGuids.ids : null;
    const used = new Set<string>();
    return buildRegister(
      {
        jobs: [...this.jobs.values()],
        toMetres: modelToMetres,
        include: (job, e) => included.has(this.partId(job, job.rootOf(e))),
        storeys: this.storeysFor(options),
        // The IFC files' GlobalId: the last generation's, else the same rule it applies.
        guid: (job, e, p) => {
          let g = cached?.get(`${job.name}|${e}`) ?? null;
          if (!g) {
            const preferred = job.sourceGuid(e, p);
            g = preferred && !used.has(preferred) ? preferred : hashGuid(`${projectKey}|${job.name}|${e}`);
          }
          used.add(g);
          return g;
        },
        projectKey,
        names: { site: options.siteName, building: options.buildingName },
      },
      assets,
      onProgress,
    );
  }

  /** The COBie and asset register workbooks. */
  async assetWorkbooks(options: ConvertOptions, assets: AssetOptions, contact: Pick<WorkbookSettings, "contactEmail" | "contactCompany" | "contactPhone" | "currency">, onProgress?: ProgressFn) {
    const register = this.assetRegister(options, assets, onProgress);
    const projectKey = `${options.projectName}|${options.filePrefix}`;
    const settings: WorkbookSettings = {
      projectName: options.projectName,
      siteName: options.siteName,
      buildingName: options.buildingName,
      ...contact,
      sources: [...new Set(this.summaries().filter((p) => options.parts.some((c) => c.id === p.id && c.include)).map((p) => p.name))],
      siteGuid: hashGuid(`site|${projectKey}`),
      buildingGuid: hashGuid(`building|${projectKey}`),
    };
    onProgress?.("Writing the COBie workbook", 0, 0);
    const cobie = await cobieWorkbook(register, settings);
    onProgress?.("Writing the asset register", 0, 0);
    const workbook = await registerWorkbook(register, settings);
    const sld = new Blob([sldHtml(register, settings)], { type: "text/html" });
    return { register, cobie, workbook, sld };
  }

  // ---------------------------------------------------------------------------
  // Preview

  /** Draw buffers of the elements the options would convert, at most `budget` triangles. */
  preview(options: ConvertOptions, budget: number): PreviewData {
    const included = new Set(options.parts.filter((p) => p.include).map((p) => p.id));
    const exclude = new Set(options.excludedCategories);
    let pattern: RegExp | null = null;
    try {
      pattern = options.excludePattern.trim() ? new RegExp(options.excludePattern.trim(), "i") : null;
    } catch {
      pattern = null;
    }
    const items: PreviewItem[] = [];
    for (const job of this.jobs.values()) {
      const toMetres = modelToMetres(job);
      for (let k = 0; k < job.elementCount; k++) {
        const e = job.elementIds[k];
        if (!included.has(this.partId(job, job.rootOf(e)))) continue;
        const info = job.info(e);
        if (exclude.has(info.category || "(no category)")) continue;
        if (pattern && (pattern.test(info.family) || pattern.test(info.type) || pattern.test(job.nodeName(e)))) continue;
        items.push({ job, k, toMetres });
      }
    }
    const box = this.bounds([...included]);
    const center: [number, number, number] = box ? [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, box[2]] : [0, 0, 0];
    return buildPreview(items, center, budget, { textures: options.textures !== "none", lines: options.lines !== false });
  }

  // ---------------------------------------------------------------------------
  // Generation

  async generate(options: ConvertOptions, onProgress: ProgressFn): Promise<{ files: OutputFile[]; report: ConvertReport }> {
    const started = Date.now();
    this.cancelled = false;
    const included = new Map(options.parts.filter((p) => p.include).map((p) => [p.id, p]));
    const plans = options.plans.filter((p) => p.include && planHasContent(p));
    const partIds = [...included.keys()];
    const { origin, rotation } = this.resolveFrame(options, partIds);
    // Storey elevations are model heights (metres); plans on a height no storey has add one.
    const storeys = withPlanStoreys(options.storeys.length ? options.storeys : partIds.length ? this.detectStoreys(partIds) : [], plans);
    const byLevel = levelIndex(storeys);
    const projectKey = `${options.projectName}|${options.filePrefix}`;
    const exclude = new Set(options.excludedCategories);
    let pattern: RegExp | null = null;
    try {
      pattern = options.excludePattern.trim() ? new RegExp(options.excludePattern.trim(), "i") : null;
    } catch {
      pattern = null;
    }

    // Writers: one per discipline, plus the federated file when there is more than one discipline.
    const disciplines = new Set<string>();
    for (const p of included.values()) disciplines.add(p.discipline || "other");
    for (const p of plans) disciplines.add(p.discipline || "plans");
    const prefix = safeFileStem(options.filePrefix || options.projectName || "model");
    const writers = new Map<string, { writer: IfcFileWriter; label: string; parts: Set<string>; classes: Record<string, number>; storeys: Record<string, number> }>();
    const makeWriter = (key: string, fileName: string, label: string) => {
      writers.set(key, {
        writer: new IfcFileWriter({
          fileName,
          fileKey: key,
          projectName: options.projectName || "Converted model",
          projectDescription: key === "*" ? "Federated model" : label,
          siteName: options.siteName || "Site",
          buildingName: options.buildingName || options.projectName || "Building",
          author: options.author,
          organization: options.organization,
          projectKey,
          siteOrigin: origin,
          rotation,
          storeys: storeys.map((st) => ({ key: st.key, name: st.name, elevation: st.elevation - origin[2] })),
          textures: options.textures ?? "files",
        }),
        label,
        parts: new Set(),
        classes: {},
        storeys: {},
      });
    };
    if (options.perDiscipline || disciplines.size === 1 || !options.federated) {
      for (const d of [...disciplines].sort()) makeWriter(d, `${prefix}-${disciplineCode(d)}-${slug(disciplineLabel(d))}.ifc`, disciplineLabel(d));
    }
    if (options.federated && disciplines.size > 1) makeWriter("*", `${prefix}-federated.ifc`, "Federated (all disciplines)");
    const federated = writers.get("*");

    const report: ConvertReport = {
      outputs: [],
      elements: 0,
      skipped: { excludedCategory: 0, pattern: 0, noGeometry: 0 },
      geometry: { baked: 0, mapped: 0, maps: 0, nonUniform: 0, sheared: 0, twoSided: 0, mirrored: 0, empty: 0 },
      appearance: { styles: 0, textured: 0, coloured: 0, textures: 0, types: 0, materials: 0, annotations: 0, systems: 0, zones: 0, assets: 0 },
      seconds: 0,
      frame: { origin, rotationDeg: (rotation * 180) / Math.PI },
    };
    const textureMode = options.textures ?? "files";
    const withTextures = textureMode !== "none";
    const guids = new Set<string>();
    const guidByElement = new Map<string, string>();
    this.lastGuids = { projectKey, ids: guidByElement };
    const uniqueGuid = (preferred: string | null, fallbackKey: string) => {
      let g = preferred && !guids.has(preferred) ? preferred : hashGuid(`${projectKey}|${fallbackKey}`);
      for (let n = 2; guids.has(g); n++) g = hashGuid(`${projectKey}|${fallbackKey}|${n}`);
      guids.add(g);
      return g;
    };
    const emit = (discipline: string, def: ElementDef, part: string, hosted: { opening: OpeningDef; filler: ElementDef | null }[] = []) => {
      const count = (target: { classes: Record<string, number>; storeys: Record<string, number> }, d: ElementDef) => {
        target.classes[d.cls.name] = (target.classes[d.cls.name] ?? 0) + 1;
        const storeyName = storeys.find((s) => s.key === d.storey)?.name ?? d.storey;
        target.storeys[storeyName] = (target.storeys[storeyName] ?? 0) + 1;
      };
      for (const target of [writers.get(discipline), federated]) {
        if (!target) continue;
        const host = target.writer.addElement(def);
        target.parts.add(part);
        count(target, def);
        if (host === null) continue;
        // Doors and windows first, then the openings they fill.
        for (const h of hosted) {
          const filler = h.filler ? target.writer.addElement(h.filler) : null;
          if (h.filler && filler !== null) count(target, h.filler);
          target.writer.addOpening(host, h.opening, filler);
        }
      }
      report.elements += 1 + hosted.filter((h) => h.filler).length;
    };

    const projectFromMetres = chain(rotationZ(-rotation), translation(-origin[0], -origin[1], -origin[2]));
    // metres (model) -> millimetres in a storey's frame (site rotation, storey height)
    const storeyFrames = new Map(storeys.map((s) => [s.key, chain(scaling(1000), translation(0, 0, -(s.elevation - origin[2])), projectFromMetres)]));

    // Total for progress
    let total = plans.reduce((n, p) => n + p.walls.length + (p.slab ? 1 : 0) + (p.openings?.length ?? 0) + (p.rooms?.length ?? 0) + (p.columns?.length ?? 0), 0);
    for (const id of included.keys()) total += this.parts.get(id)?.summary.elements ?? 0;
    let done = 0;
    const tick = async () => {
      done++;
      if (done % 500 === 0) {
        onProgress("Writing elements", done, total);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.cancelled) throw new Error("Cancelled");
      }
    };

    // Styles per job, material and vertex colour.
    const styleCache = new Map<string, StyleDef>();
    const styleFor = (job: SourceJob, mi: number, gi: number): { style: StyleDef; faces: Uint8Array | null; material: MaterialInfo } => {
      const material = job.materialInfo(mi);
      const colours = material.vertexColors ? this.colourInfo(job, gi) : null;
      const vertexHex = colours ? (colours.uniform ?? colours.mean) : null;
      const key = `${job.name}|${mi}|${vertexHex ?? ""}`;
      let style = styleCache.get(key);
      if (!style) {
        style = this.styleOf(job, material, vertexHex, withTextures);
        styleCache.set(key, style);
      }
      let faces: Uint8Array | null = null;
      if (colours?.faces) {
        faces = colours.faces;
        if (!isWhite(material.color)) {
          // The viewer multiplies vertex colours with the diffuse colour.
          const [r, g, b] = rgb(material.color);
          faces = faces.slice();
          for (let i = 0; i < faces.length; i += 3) {
            faces[i] = Math.round(faces[i] * r);
            faces[i + 1] = Math.round(faces[i + 1] * g);
            faces[i + 2] = Math.round(faces[i + 2] * b);
          }
        }
      }
      return { style, faces, material };
    };
    const uvsFor = (job: SourceJob, gi: number, style: StyleDef, material: MaterialInfo): Float32Array | null => {
      if (!style.texture) return null;
      const uv = job.uvs(gi);
      return uv ? transformUvs(uv, material.texMatrix) : null;
    };

    // Shared shapes: the scale a map was made at, and a small cache of formatted map meshes.
    const mapScale = new Map<string, Vec3>();
    const meshCache = new Map<string, MeshText | null>();
    const mapValid = new Map<string, boolean>();
    const cachedMesh = (key: string, make: () => MeshText | null) => {
      if (meshCache.has(key)) return meshCache.get(key)!;
      const m = make();
      if (meshCache.size > 512) meshCache.clear();
      meshCache.set(key, m);
      return m;
    };

    const sourceDate = new Date().toISOString().slice(0, 10);

    // Asset information: the register of the same parts, by element.
    let register: AssetRegister | null = null;
    if (options.assets && included.size) {
      onProgress("Reading assets", 0, 0);
      register = this.assetRegister(options, options.assets);
    }
    const assetByKey = new Map(register?.assets.map((a) => [`${a.job}|${a.e}`, a]) ?? []);
    const typeByKey = new Map(register?.types.map((t) => [t.key, t]) ?? []);
    const spaceByName = new Map(register?.spaces.map((sp) => [sp.name, sp]) ?? []);
    const spaceByElement = new Map(register?.spaces.filter((sp) => sp.elementKey).map((sp) => [sp.elementKey!, sp]) ?? []);
    const boardByAsset = new Map(register?.electrical.boards.filter((b) => b.asset).map((b) => [b.asset, b]) ?? []);
    // Assets and rooms keep the register's ids (the workbooks' Asset ID and ExtIdentifier) whatever the order.
    const reserved = new Map<string, string>();
    for (const a of register?.assets ?? []) reserved.set(`${a.job}|${a.e}`, a.guid);
    for (const sp of register?.spaces ?? []) {
      if (sp.elementKey) reserved.set(sp.elementKey, sp.guid);
      guids.add(sp.guid);
    }
    for (const g of reserved.values()) guids.add(g);
    const box = new Float64Array(6);

    for (const job of this.jobs.values()) {
      const toMetres = modelToMetres(job);
      const worldToStorey = new Map([...storeyFrames].map(([k, m]) => [k, multiply(m, toMetres)]));
      const header = job.data.header;
      const keyUnits = ((job.propsData as { units?: Record<string, string> } | null)?.units ?? {}) as Record<string, string>;
      const unitByKey = new Map<string, string>();
      if (job.propsData) for (const [k, u] of Object.entries(keyUnits)) unitByKey.set(job.propsData.strings[Number(k)], u);
      const legacy = (header.format ?? 1) < 2;
      const basis = header.source ? `${header.source}` : `Extracted model ${header.model ?? job.name}`;

      for (let k = 0; k < job.elementCount; k++) {
        const e = job.elementIds[k];
        const root = job.rootOf(e);
        const partId = this.partId(job, root);
        const part = included.get(partId);
        if (!part) continue;
        await tick();
        const info = job.info(e);
        if (exclude.has(info.category || "(no category)")) {
          report.skipped.excludedCategory++;
          continue;
        }
        const nodeName = job.nodeName(e);
        if (pattern && (pattern.test(info.family) || pattern.test(info.type) || pattern.test(nodeName))) {
          report.skipped.pattern++;
          continue;
        }

        const start = job.elementStart[k];
        const end = job.elementStart[k + 1];
        let bottom = Infinity;
        for (let j = start; j < end; j++) {
          transformBox(toMetres, job.data.fbox, job.fragOrder[j] * 6, box);
          if (box[2] < bottom) bottom = box[2];
        }
        const storeyKey = storeyFor(storeys, byLevel, info.level, Number.isFinite(bottom) ? bottom : 0);
        const toStorey = worldToStorey.get(storeyKey)!;
        const choice = classify(info.category, info.family, info.type, [nodeName]);
        let cls = ifcClass(choice.cls)!;

        let mapped = false;
        if (options.instancing) {
          for (let j = start; j < end; j++) {
            const gi = job.data.fgeom[job.fragOrder[j]];
            if (job.geomUses[gi] > 1 && !job.isLines(gi)) {
              mapped = true;
              break;
            }
          }
        }
        const items: ItemDef[] = [];
        const lineFragments: number[] = [];
        // Materials of the element, by name, with the style of their first shape.
        const materialNames: string[] = [];
        const materialStyles: Record<string, StyleDef> = {};
        for (let j = start; j < end; j++) {
          const f = job.fragOrder[j];
          const gi = job.data.fgeom[f];
          const mi = job.data.fmat[f];
          if (job.isLines(gi)) {
            lineFragments.push(f);
            continue;
          }
          const { style, faces, material } = styleFor(job, mi, gi);
          // Navisworks names geometry nodes after their material; otherwise the viewer's material name.
          const leaf = job.data.fdb[f];
          const materialName = ((leaf !== e && job.nodeType(leaf) === 6 ? job.nodeName(leaf) : "") || material.name).trim();
          if (materialName && !(materialName in materialStyles) && materialNames.length < 16) {
            materialNames.push(materialName);
            materialStyles[materialName] = style;
          }
          const G = multiply(toStorey, job.fragmentMatrix(f));
          const sc: Vec3 = [Math.hypot(G[0], G[4], G[8]), Math.hypot(G[1], G[5], G[9]), Math.hypot(G[2], G[6], G[10])];
          const twoSided = options.twoSidedOpen && this.isOpen(job, gi);
          if (mapped && Math.min(...sc) > 1e-9) {
            const U = [G[0] / sc[0], G[4] / sc[0], G[8] / sc[0], G[1] / sc[1], G[5] / sc[1], G[9] / sc[1], G[2] / sc[2], G[6] / sc[2], G[10] / sc[2]];
            const dot = (a: number, b: number) => U[a * 3] * U[b * 3] + U[a * 3 + 1] * U[b * 3 + 1] + U[a * 3 + 2] * U[b * 3 + 2];
            if (Math.abs(dot(0, 1)) < 1e-4 && Math.abs(dot(0, 2)) < 1e-4 && Math.abs(dot(1, 2)) < 1e-4) {
              const baseKey = `${job.name}|${gi}|${mi}`;
              let S0 = mapScale.get(baseKey);
              if (!S0) mapScale.set(baseKey, (S0 = sc));
              const ratio: Vec3 = [sc[0] / S0[0], sc[1] / S0[1], sc[2] / S0[2]];
              const uniform = Math.abs(ratio[0] - 1) < 1e-5 && Math.abs(ratio[1] - 1) < 1e-5 && Math.abs(ratio[2] - 1) < 1e-5;
              const mirrored = determinant3(G) < 0;
              const key = mirrored ? `${baseKey}|m` : baseKey;
              const s0 = S0;
              const mx = mirrored ? -1 : 1;
              // Turn closed shapes outward in the end result (see orientation()).
              // The mirrored shape is reflected in its own X, so its facing reverses with it.
              const facing = (mirrored ? -1 : 1) * this.orientation(job, gi);
              const flip = !twoSided && facing < 0;
              const make = () => {
                const { positions, indices } = job.geometry(gi);
                for (let i = 0; i < positions.length; i += 3) {
                  positions[i] *= s0[0] * mx;
                  positions[i + 1] *= s0[1];
                  positions[i + 2] *= s0[2];
                }
                return meshText(positions, indices, { twoSided, flip, uv: uvsFor(job, gi, style, material), faceColours: faces });
              };
              // Shapes that come out empty (slivers thinner than the 0.1 mm grid) are left out.
              let valid = mapValid.get(key);
              if (valid === undefined) {
                valid = cachedMesh(key, make) !== null;
                mapValid.set(key, valid);
              }
              if (!valid) {
                report.geometry.empty++;
                continue;
              }
              items.push({
                kind: "mapped",
                key,
                style,
                // The reflection lives in the shape; the placement keeps a right-handed frame.
                axis1: [U[0] * mx, U[1] * mx, U[2] * mx],
                axis2: [U[3], U[4], U[5]],
                axis3: [U[6], U[7], U[8]],
                origin: [G[3], G[7], G[11]],
                scale: uniform ? null : ratio,
                mesh: () => cachedMesh(key, make)!,
              });
              if (!uniform) report.geometry.nonUniform++;
              if (mirrored) report.geometry.mirrored++;
              if (twoSided) report.geometry.twoSided++;
              report.geometry.mapped++;
              continue;
            }
            report.geometry.sheared++;
          }
          // Baked: the shape in the storey frame.
          const { positions, indices } = job.geometry(gi);
          const out = new Float64Array(positions.length);
          for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i],
              y = positions[i + 1],
              z = positions[i + 2];
            out[i] = G[0] * x + G[1] * y + G[2] * z + G[3];
            out[i + 1] = G[4] * x + G[5] * y + G[6] * z + G[7];
            out[i + 2] = G[8] * x + G[9] * y + G[10] * z + G[11];
          }
          const orientation = this.orientation(job, gi);
          const mesh = meshText(out, indices, {
            flip: !twoSided && orientation !== 0 && Math.sign(determinant3(G)) * orientation < 0,
            twoSided,
            uv: uvsFor(job, gi, style, material),
            faceColours: faces,
          });
          if (!mesh) {
            report.geometry.empty++;
            continue;
          }
          if (twoSided) report.geometry.twoSided++;
          report.geometry.baked++;
          if (mapped) {
            // One representation type per element: a baked shape among mapped ones goes into a single-use map.
            items.push({ kind: "mapped", key: `bake|${job.name}|${f}`, style, axis1: [1, 0, 0], axis2: [0, 1, 0], axis3: [0, 0, 1], origin: [0, 0, 0], scale: null, mesh: () => mesh });
          } else items.push({ kind: "mesh", mesh, style });
        }
        // Line work alone (model lines, room separation lines): an annotation with its curves.
        let annotation = false;
        if (items.length === 0 && lineFragments.length && options.lines !== false) {
          for (const f of lineFragments) {
            const gi = job.data.fgeom[f];
            const G = multiply(toStorey, job.fragmentMatrix(f));
            const { positions, indices } = job.geometry(gi);
            const out = new Float64Array(positions.length);
            for (let i = 0; i < positions.length; i += 3) {
              const x = positions[i],
                y = positions[i + 1],
                z = positions[i + 2];
              out[i] = G[0] * x + G[1] * y + G[2] * z + G[3];
              out[i + 1] = G[4] * x + G[5] * y + G[6] * z + G[7];
              out[i + 2] = G[8] * x + G[9] * y + G[10] * z + G[11];
            }
            const lines = polylines(out, indices);
            if (!lines) continue;
            const material = job.materialInfo(job.data.fmat[f]);
            items.push({ kind: "curves", points: lines.points, runs: lines.runs, style: { hex: material.color, opacity: 1, name: material.name || undefined } });
          }
          if (items.length) {
            annotation = true;
            cls = ifcClass("IfcAnnotation")!;
            report.appearance.annotations++;
          }
        }
        if (items.length === 0) {
          report.skipped.noGeometry++;
          continue;
        }

        const p = info.props;
        const elementId = job.elementId(e, p);
        const guid = reserved.get(`${job.name}|${e}`) ?? uniqueGuid(job.sourceGuid(e, p), `${job.name}|${e}`);
        guidByElement.set(`${job.name}|${e}`, guid);
        const name = info.family ? (!info.type || info.type === info.family ? info.family : `${info.family}:${info.type}`) : nodeName || info.category;
        const psets = this.propertySets(job, e, info, p, elementId, unitByKey, legacy, basis, sourceDate);

        const def: ElementDef = {
          guid,
          cls,
          predefined: annotation ? null : choice.predefined,
          name: name || null,
          description: info.category || null,
          objectType: info.type || null,
          tag: elementId || null,
          storey: storeyKey,
          representation: annotation ? "Curve3D" : mapped ? "MappedRepresentation" : "Tessellation",
          items,
          psets,
          // IFC allows material associations on elements, not on spaces or annotations.
          materials: choice.spatial || annotation ? null : materialNames,
          materialStyles,
          type: annotation || options.types === false ? null : this.typeOf(cls, choice.predefined, info, p, assetByKey.has(`${job.name}|${e}`) ? typeByKey.get(`${info.category}|${info.family}|${info.type}`) : undefined),
          key: `${job.name}|${e}`,
        };
        const asset = assetByKey.get(`${job.name}|${e}`);
        if (asset) {
          def.psets.splice(1, 0, ...assetPsets(asset, spaceByName.get(asset.space) ?? null, boardByAsset.get(asset.name)));
          report.appearance.assets++;
        }
        const room = cls.name === "IfcSpace" ? spaceByElement.get(`${job.name}|${e}`) : undefined;
        if (room) {
          // As Revit's own IFC export does: the number is the name, the room name the long name.
          def.name = room.name;
          def.longName = room.roomName || null;
          def.psets.splice(1, 0, ...spacePsets(room, "Room in this model"));
        }
        emit(part.discipline || "other", def, part.id);
      }
    }

    // Plans: walls with their openings, doors and windows, rooms, columns and slabs, as extrusions.
    for (const plan of plans) {
      const storey = storeys.reduce((a, b) => (Math.abs(b.elevation - plan.storey.elevation) < Math.abs(a.elevation - plan.storey.elevation) ? b : a));
      const baseZ = (plan.storey.elevation - storey.elevation) * 1000;
      const height = Math.max(0.1, plan.storey.height) * 1000;
      const wallStyle: StyleDef = { hex: "d9d6cf", opacity: 1 };
      const slabStyle: StyleDef = { hex: "b8b8b4", opacity: 1 };
      const doorStyle: StyleDef = { hex: "a9825a", opacity: 1, name: "Door" };
      const frameStyle: StyleDef = { hex: "8d949b", opacity: 1, name: "Frame" };
      const glassStyle: StyleDef = { hex: "a8c8e8", opacity: 0.35, name: "Glass", method: "GLASS" };
      const spaceStyle: StyleDef = { hex: "8ec5ff", opacity: 0.25, name: "Space" };
      const columnStyle: StyleDef = { hex: "c8c4bc", opacity: 1, name: "Column" };
      const read = plan.basis === "read";
      const basis = `${read ? "Read" : "Traced"} from ${plan.source}`;
      const provenance = { name: "IFCStudio_Provenance", props: [{ name: "Basis", value: basis }, { name: "Converted", value: sourceDate }] };
      const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, style: StyleDef): Extract<ItemDef, { kind: "extrusion" }> => ({
        kind: "extrusion",
        profile: { type: "rectangle", x: (x0 + x1) / 2, y: (y0 + y1) / 2, xDim: Math.max(1, x1 - x0), yDim: Math.max(1, y1 - y0) },
        origin: [0, 0, z0],
        depth: Math.max(1, z1 - z0),
        style,
      });
      const openingsByWall = new Map<number, PlanOpening[]>();
      for (const o of plan.openings ?? []) {
        let list = openingsByWall.get(o.wall);
        if (!list) openingsByWall.set(o.wall, (list = []));
        list.push(o);
      }
      plan.walls.forEach((wall, i) => {
        const ax = wall.a[0] * 1000,
          ay = wall.a[1] * 1000,
          bx = wall.b[0] * 1000,
          by = wall.b[1] * 1000;
        const length = Math.hypot(bx - ax, by - ay);
        const t = wall.thickness * 1000;
        if (length < 10 || t <= 0) return;
        const ux = (bx - ax) / length,
          uy = (by - ay) / length;
        const guid = uniqueGuid(null, `plan|${plan.id}|wall|${i}|${ax.toFixed(0)},${ay.toFixed(0)},${bx.toFixed(0)},${by.toFixed(0)}`);
        const hosted: { opening: OpeningDef; filler: ElementDef | null }[] = [];
        (openingsByWall.get(i) ?? []).forEach((o, k) => {
          const w = o.width * 1000;
          const s0 = Math.max(0, Math.min(length - 1, o.offset * 1000));
          const width = Math.min(w, length - s0);
          if (width < 50) return;
          const sill = Math.max(0, o.sill * 1000);
          const h = Math.max(100, Math.min(o.height * 1000, height - sill));
          const key = `plan|${plan.id}|wall|${i}|opening|${k}|${s0.toFixed(0)}`;
          const opening: OpeningDef = {
            guid: uniqueGuid(null, key),
            name: o.kind === "door" ? "Door opening" : o.kind === "window" ? "Window opening" : "Opening",
            origin: [s0, 0, sill],
            items: [box(0, width, -t / 2 - 20, t / 2 + 20, 0, h, wallStyle)],
          };
          let filler: ElementDef | null = null;
          if (o.kind === "door" || o.kind === "window") {
            // The leaf opens to +y of the door's placement (IFC); its x then runs along or against the wall.
            const sideX = o.kind === "door" && o.swingSide !== 0 ? o.swingSide : 1;
            const dir: Vec3 = [ux * sideX, uy * sideX, 0];
            const startS = sideX > 0 ? s0 : s0 + width;
            const origin: Vec3 = [ax + ux * startS, ay + uy * startS, baseZ + sill];
            const f = 50;
            const depth = Math.min(t, o.kind === "door" ? 120 : 100);
            const items: ItemDef[] =
              o.kind === "door"
                ? [
                    box(0, f, -depth / 2, depth / 2, 0, h, frameStyle),
                    box(width - f, width, -depth / 2, depth / 2, 0, h, frameStyle),
                    box(0, width, -depth / 2, depth / 2, h - f, h, frameStyle),
                    ...(o.operation?.startsWith("DOUBLE")
                      ? [box(f, width / 2 - 3, -20, 20, 0, h - f, doorStyle), box(width / 2 + 3, width - f, -20, 20, 0, h - f, doorStyle)]
                      : [box(f, width - f, -20, 20, 0, h - f, doorStyle)]),
                  ]
                : [
                    box(0, f, -depth / 2, depth / 2, 0, h, frameStyle),
                    box(width - f, width, -depth / 2, depth / 2, 0, h, frameStyle),
                    box(f, width - f, -depth / 2, depth / 2, 0, f, frameStyle),
                    box(f, width - f, -depth / 2, depth / 2, h - f, h, frameStyle),
                    box(f, width - f, -6, 6, f, h - f, glassStyle),
                  ];
            const isDoor = o.kind === "door";
            filler = {
              guid: uniqueGuid(null, `${key}|${o.kind}`),
              cls: ifcClass(isDoor ? "IfcDoor" : "IfcWindow")!,
              predefined: isDoor ? "DOOR" : "WINDOW",
              name: o.name || `${isDoor ? "Door" : "Window"} ${Math.round(width)} × ${Math.round(h)} mm`,
              description: `${isDoor ? "Door" : "Window"} ${read ? "read" : "traced"} from a floor plan`,
              objectType: o.name,
              tag: null,
              storey: storey.key,
              placement: { origin, xDir: dir },
              representation: "SweptSolid",
              items,
              attributes: {
                OverallHeight: real(Math.round(h * 10) / 10),
                OverallWidth: real(Math.round(width * 10) / 10),
                ...(isDoor ? { OperationType: `.${o.operation && /^[A-Z_]+$/.test(o.operation) ? o.operation : "NOTDEFINED"}.` } : { PartitioningType: ".SINGLE_PANEL." }),
              },
              psets: [{ name: isDoor ? "Pset_DoorCommon" : "Pset_WindowCommon", props: [{ name: "IsExternal", value: Boolean(wall.external), kind: "boolean" }] }, provenance],
              quantities: {
                name: isDoor ? "Qto_DoorBaseQuantities" : "Qto_WindowBaseQuantities",
                items: [
                  { kind: "length", name: "Height", value: h },
                  { kind: "length", name: "Width", value: width },
                  { kind: "area", name: "Area", value: (h * width) / 1e6 },
                ],
              },
              materials: null,
            };
          }
          hosted.push({ opening, filler });
        });
        emit(
          plan.discipline || "plans",
          {
            guid,
            cls: ifcClass("IfcWall")!,
            predefined: wall.external ? "STANDARD" : "PARTITIONING",
            name: `Wall ${Math.round(t)} mm`,
            description: `Wall ${read ? "read" : "traced"} from a floor plan`,
            objectType: null,
            tag: null,
            storey: storey.key,
            placement: { origin: [ax, ay, baseZ], xDir: [ux, uy, 0] },
            representation: "SweptSolid",
            items: [{ kind: "extrusion", profile: { type: "rectangle", x: length / 2, y: 0, xDim: length, yDim: t }, origin: [0, 0, 0], depth: height, style: wallStyle }],
            axis: [
              [0, 0],
              [length, 0],
            ],
            psets: [{ name: "Pset_WallCommon", props: [{ name: "IsExternal", value: Boolean(wall.external), kind: "boolean" }] }, provenance],
            quantities: {
              name: "Qto_WallBaseQuantities",
              items: [
                { kind: "length", name: "Length", value: length },
                { kind: "length", name: "Width", value: t },
                { kind: "length", name: "Height", value: height },
                { kind: "area", name: "GrossFootprintArea", value: (length * t) / 1e6 },
                { kind: "area", name: "GrossSideArea", value: (length * height) / 1e6 },
                { kind: "volume", name: "GrossVolume", value: (length * t * height) / 1e9 },
              ],
            },
            materials: null,
          },
          plan.id,
          hosted,
        );
      });
      done += plan.walls.length + (plan.openings?.length ?? 0);
      // Rooms.
      (plan.rooms ?? []).forEach((room, i) => {
        const pts = room.outline.map(([x, y]) => [x * 1000, y * 1000] as [number, number]);
        if (pts.length < 3) return;
        let area = 0;
        let perimeter = 0;
        for (let k = 0; k < pts.length; k++) {
          const [x0, y0] = pts[k];
          const [x1, y1] = pts[(k + 1) % pts.length];
          area += x0 * y1 - x1 * y0;
          perimeter += Math.hypot(x1 - x0, y1 - y0);
        }
        if (area < 0) pts.reverse();
        area = Math.abs(area) / 2;
        if (area < 1e5) return; // under 0.1 m²
        const name = room.number || room.name || `Room ${i + 1}`;
        emit(
          plan.discipline || "plans",
          {
            guid: uniqueGuid(null, `plan|${plan.id}|room|${i}|${pts[0][0].toFixed(0)},${pts[0][1].toFixed(0)}`),
            cls: ifcClass("IfcSpace")!,
            predefined: "INTERNAL",
            name,
            longName: room.name && room.number ? room.name : null,
            description: `Room ${read ? "read" : "traced"} from a floor plan`,
            objectType: null,
            tag: null,
            storey: storey.key,
            representation: "SweptSolid",
            items: [{ kind: "extrusion", profile: { type: "polygon", points: pts }, origin: [0, 0, baseZ], depth: height, style: spaceStyle }],
            psets: [{ name: "Pset_SpaceCommon", props: [{ name: "Reference", value: room.number ?? "", kind: "identifier" }, { name: "IsExternal", value: false, kind: "boolean" }] }, provenance],
            quantities: {
              name: "Qto_SpaceBaseQuantities",
              items: [
                { kind: "length", name: "Height", value: height },
                { kind: "length", name: "NetPerimeter", value: perimeter },
                { kind: "area", name: "NetFloorArea", value: area / 1e6 },
                { kind: "area", name: "GrossFloorArea", value: area / 1e6 },
                { kind: "volume", name: "NetVolume", value: (area * height) / 1e9 },
              ],
            },
            materials: null,
          },
          plan.id,
        );
      });
      // Columns.
      (plan.columns ?? []).forEach((col, i) => {
        let profile: ProfileDef | null = null;
        let section = 0;
        if (col.circle) {
          profile = { type: "circle", x: col.circle.c[0] * 1000, y: col.circle.c[1] * 1000, r: col.circle.r * 1000 };
          section = Math.PI * (col.circle.r * 1000) ** 2;
        } else if (col.outline && col.outline.length >= 3) {
          const pts = col.outline.map(([x, y]) => [x * 1000, y * 1000] as [number, number]);
          let a = 0;
          for (let k = 0; k < pts.length; k++) a += pts[k][0] * pts[(k + 1) % pts.length][1] - pts[(k + 1) % pts.length][0] * pts[k][1];
          if (a < 0) pts.reverse();
          section = Math.abs(a) / 2;
          profile = { type: "polygon", points: pts };
        }
        if (!profile || section < 100) return;
        emit(
          plan.discipline || "plans",
          {
            guid: uniqueGuid(null, `plan|${plan.id}|column|${i}`),
            cls: ifcClass("IfcColumn")!,
            predefined: "COLUMN",
            name: col.circle ? `Column Ø${Math.round(col.circle.r * 2000)} mm` : `Column ${Math.round(Math.sqrt(section))} mm`,
            description: `Column ${read ? "read" : "traced"} from a floor plan`,
            objectType: null,
            tag: null,
            storey: storey.key,
            representation: "SweptSolid",
            items: [{ kind: "extrusion", profile, origin: [0, 0, baseZ], depth: height, style: columnStyle }],
            psets: [{ name: "Pset_ColumnCommon", props: [{ name: "IsExternal", value: false, kind: "boolean" }, { name: "LoadBearing", value: true, kind: "boolean" }] }, provenance],
            quantities: {
              name: "Qto_ColumnBaseQuantities",
              items: [
                { kind: "length", name: "Length", value: height },
                { kind: "area", name: "CrossSectionArea", value: section / 1e6 },
                { kind: "volume", name: "GrossVolume", value: (section * height) / 1e9 },
              ],
            },
            materials: null,
          },
          plan.id,
        );
      });
      done += (plan.rooms?.length ?? 0) + (plan.columns?.length ?? 0);
      if (plan.slab && plan.slab.outline.length >= 3) {
        const pts = plan.slab.outline.map(([x, y]) => [x * 1000, y * 1000] as [number, number]);
        let area = 0;
        let perimeter = 0;
        for (let i = 0; i < pts.length; i++) {
          const [x0, y0] = pts[i];
          const [x1, y1] = pts[(i + 1) % pts.length];
          area += x0 * y1 - x1 * y0;
          perimeter += Math.hypot(x1 - x0, y1 - y0);
        }
        if (area < 0) pts.reverse();
        area = Math.abs(area) / 2;
        const t = plan.slab.thickness * 1000;
        emit(
          plan.discipline || "plans",
          {
            guid: uniqueGuid(null, `plan|${plan.id}|slab`),
            cls: ifcClass("IfcSlab")!,
            predefined: "FLOOR",
            name: `Floor slab ${Math.round(t)} mm`,
            description: `Slab outline ${read ? "read" : "traced"} from a floor plan`,
            objectType: null,
            tag: null,
            storey: storey.key,
            representation: "SweptSolid",
            items: [{ kind: "extrusion", profile: { type: "polygon", points: pts }, origin: [0, 0, baseZ - t], depth: t, style: slabStyle }],
            psets: [{ name: "Pset_SlabCommon", props: [{ name: "IsExternal", value: false, kind: "boolean" }] }, provenance],
            quantities: {
              name: "Qto_SlabBaseQuantities",
              items: [
                { kind: "length", name: "Depth", value: t },
                { kind: "length", name: "Perimeter", value: perimeter },
                { kind: "area", name: "GrossArea", value: area / 1e6 },
                { kind: "volume", name: "GrossVolume", value: (area * t) / 1e9 },
              ],
            },
            materials: null,
          },
          plan.id,
        );
        done++;
      }
    }

    // Rooms named by assets, systems, service zones, and assets referenced in their rooms.
    if (register) {
      const keyOfAsset = new Map(register.assets.map((a) => [a.name, `${a.job}|${a.e}`]));
      const spaceKey = (sp: RegisterSpace) => sp.elementKey || `space|${sp.key}`;
      const spaceRefs = register.spaces.map((sp) => ({ space: spaceKey(sp), elements: sp.assets.map((n) => keyOfAsset.get(n)!).filter(Boolean) }));
      const systems = register.systems.map((sys) => ({
        guid: sys.guid,
        name: sys.name,
        description: [...new Set([sys.classification, sys.type].filter(Boolean))].join(" / ") || null,
        objectType: sys.classification || null,
        predefined: sys.ifcType,
        members: [...new Set(sys.members)].map((n) => keyOfAsset.get(n)!).filter(Boolean),
      }));
      const zoneSpaces = new Map(register.spaces.map((sp) => [sp.name, spaceKey(sp)]));
      const zones = register.zones.map((z) => ({ guid: z.guid, name: z.name, description: z.description || null, objectType: z.category, spaces: z.spaces.map((n) => zoneSpaces.get(n)!).filter(Boolean) }));
      for (const target of writers.values()) {
        const writer = target.writer;
        // A room goes into every file that holds an asset in it or one serving it: as itself where its
        // discipline is, otherwise (and for rooms only named by assets) as a room without geometry, same id.
        for (const sp of register.spaces) {
          if (writer.has(spaceKey(sp))) continue;
          const users = [...sp.assets, ...sp.servedBy].map((n) => keyOfAsset.get(n)).filter((k): k is string => Boolean(k));
          if (!users.some((k) => writer.has(k))) continue;
          writer.addSpaceStub({
            key: spaceKey(sp),
            guid: sp.guid,
            name: sp.name,
            longName: sp.roomName || null,
            storey: sp.floorKey || storeys[0]?.key || "",
            psets: spacePsets(sp, sp.elementKey ? "Room of another discipline's model (geometry there)" : "Named by the assets in it (the model has no room geometry)"),
          });
        }
        writer.addGroups({ systems, zones, spaceRefs });
      }
    }

    onProgress("Finishing files", total, total);
    const files: OutputFile[] = [];
    const textureFiles = new Set<string>();
    for (const [key, target] of writers) {
      if (target.writer.stats.elements === 0) continue;
      const blob = target.writer.finish();
      const stats = target.writer.stats;
      report.geometry.maps += stats.maps;
      if (key !== "*" || writers.size === 1) {
        report.appearance.systems += stats.systems;
        report.appearance.zones += stats.zones;
        report.appearance.styles += stats.styles;
        report.appearance.textured += stats.textured;
        report.appearance.coloured += stats.coloured;
        report.appearance.types += stats.types;
        report.appearance.materials += stats.materials;
      }
      const assets = [...target.writer.textureFiles].map(([path, bytes]) => {
        textureFiles.add(path);
        return { path, blob: new Blob([bytes as BlobPart], { type: "image/png" }) };
      });
      files.push({
        name: target.writer.setup.fileName,
        discipline: key === "*" ? null : key,
        label: target.label,
        elements: stats.elements,
        bytes: blob.size,
        classes: target.classes,
        storeys: target.storeys,
        parts: [...target.parts],
        textures: assets.length,
        blob,
        assets,
      });
    }
    report.appearance.textures = textureFiles.size;
    report.outputs = files.map(({ blob: _blob, assets: _assets, ...summary }) => summary);
    report.seconds = (Date.now() - started) / 1000;
    return { files, report };
  }

  private propertySets(job: SourceJob, e: number, info: ReturnType<SourceJob["info"]>, p: Props, elementId: string, unitByKey: Map<string, string>, legacy: boolean, basis: string, date: string): PsetDef[] {
    const props: PropEntry[] = [];
    const push = (name: string, value: unknown, kind?: PropEntry["kind"]) => {
      if (value === undefined || value === null || value === "") return;
      if (typeof value === "number" && !Number.isFinite(value)) return;
      props.push({ name, value: value as string | number | boolean, kind });
    };
    push("ElementId", elementId, "identifier");
    const rawGuid = p["Item/GUID"] ?? p["__externalId__"];
    push("SourceGUID", rawGuid, "identifier");
    push("Category", info.category);
    push("Family", info.family);
    push("Type", info.type);
    push("Level", info.level);
    for (const [name, keys, kind] of KEY_FIELDS) {
      for (const key of keys) {
        const v = p[key];
        if (v === undefined || v === "") continue;
        if (kind === "length" && typeof v === "number") {
          const scale = lengthUnit(unitByKey.get(key)) ?? (legacy ? 0.3048 : null);
          if (scale !== null) push(name, v * scale * 1000, "length");
          else push(name, v, "real");
        } else push(name, v);
        break;
      }
    }
    push("SourceFile", info.file);
    const psets: PsetDef[] = [{ name: "IFCStudio_Source", props }];

    // Everything else the extractor brought, grouped as the viewer groups it.
    if (job.propsData && (job.propsData as { mode?: string }).mode === "all") {
      const groups = new Map<string, PropEntry[]>();
      for (const [key, value] of Object.entries(p)) {
        const slash = key.indexOf("/");
        if (slash <= 0 || key.startsWith("__")) continue;
        const group = key.slice(0, slash);
        const name = key.slice(slash + 1);
        if (!name || value === "" || value === null || value === undefined) continue;
        let list = groups.get(group);
        if (!list) groups.set(group, (list = []));
        if (typeof value === "number") {
          const scale = lengthUnit(unitByKey.get(key));
          list.push(scale !== null ? { name, value: value * scale * 1000, kind: "length" } : { name, value, kind: "real" });
        } else list.push({ name, value });
      }
      for (const [group, list] of groups) psets.push({ name: group.replace(/^Pset_|^Qto_/i, "Src_$&"), props: list.slice(0, 400) });
    }

    psets.push({
      name: "IFCStudio_Provenance",
      props: [
        { name: "Basis", value: basis },
        { name: "SourceModel", value: job.data.header.model || job.name },
        { name: "SourceNode", value: e, kind: "integer" },
        { name: "Extracted", value: job.data.header.extractedAt || "" },
        { name: "Converted", value: date },
      ].filter((x) => x.value !== "") as PropEntry[],
    });
    return psets;
  }
}
