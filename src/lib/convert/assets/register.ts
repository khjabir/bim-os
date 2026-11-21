// The asset register of a model: its maintainable equipment with type,
// manufacturer, identity, dates, warranty and service life; the floor and
// space each asset is in; the systems it belongs to; what serves it and what
// it serves; and the model's floors, spaces and zones. Feeds the COBie and
// asset register workbooks and the asset data written into the IFC files.
//
// Everything comes from the model, nothing is estimated. Where a value is
// worked out from others it is marked as derived: a warranty end from its
// start and duration, an end of life from the installation (or manufacturing)
// year and the expected life, a space from room geometry, a "served by" from
// system membership or an electrical board.

import type { ElementInfo, Props, SourceJob } from "../model";
import type { Affine } from "../math";
import { transformBox } from "../math";
import { classify } from "../classify";
import { hashGuid } from "../ifc/step";
import { ifcTypeClass, ifcClass } from "../ifc/schema";
import { levelIndex, storeyFor, type StoreyDef } from "../storeys";
import { cleanText, durationYears, FIELD_BY_ID, FIELDS, groupRank, nameUnit, normaliseName, parseDate, parseDuration, parseNumber, parseUnit, parseYear, unitWord, type DurationUnit, type FieldDef } from "./fields";
import { assetKind, familyUniclass, systemUniclass, type AssetKind, type Discipline, type Trait } from "./kinds";
import { parseDistributionSystem, parseElectricalData, parseQuantity } from "./quantities";
import { buildElectrical, type RegisterElectrical } from "./electrical";

import { DEFAULT_ASSET_CATEGORIES, DEFAULT_CODE_PATTERN, initials, SPACE_CATEGORIES } from "./categories";

export { DEFAULT_ASSET_CATEGORIES, DEFAULT_CODE_PATTERN, SPACE_CATEGORIES };

/** Categories whose members feed others in a system. */
const SOURCE_CATEGORIES = new Set(["Mechanical Equipment", "Plumbing Equipment", "Electrical Equipment"]);
/** Categories fed by a system's equipment (in-line parts such as valves and dampers only belong to it). */
const CONSUMER_CATEGORIES = new Set([
  "Air Terminals", "Plumbing Fixtures", "Sprinklers", "Lighting Fixtures", "Electrical Fixtures", "Lighting Devices", "Fire Alarm Devices",
  "Communication Devices", "Data Devices", "Security Devices", "Nurse Call Devices", "Telephone Devices", "Audio Visual Devices",
  "Mechanical Control Devices", "Specialty Equipment", "Medical Equipment", "Food Service Equipment", "Fire Protection",
]);
/** How far upstream equipment usually sits (lower feeds higher), by its family and type names. */
const UPSTREAM: RegExp[] = [
  /chiller|boiler|cooling tower|heat exchanger|generator|transformer|\bups\b|main switch|msb|\bhv\b|lv panel|switchboard/i,
  /\bahu\b|fahu|\bpau\b|doas|air handl|make-?up air|\bmau\b|rooftop|\brtu\b|crac|crah|\bmdb\b|\bsmdb\b/i,
  /pump|booster|calorifier|water heater|\bdb\b|distribution board|panel|water tank|storage tank/i,
  /fcu|fan coil|\bvav\b|vrf|vrv|cassette|split|indoor unit|blower coil|terminal unit|\bfan\b|heater/i,
];

function upstreamRank(a: { family: string; type: string; name: string }): number {
  const text = `${a.family} ${a.type} ${a.name}`;
  for (let i = 0; i < UPSTREAM.length; i++) if (UPSTREAM[i].test(text)) return i;
  return UPSTREAM.length;
}
const MOVEABLE_CATEGORIES = new Set(["Furniture", "Furniture Systems"]);
/** Type fields that should agree across a type's assets (a disagreement is reported). */
const IDENTITY_FIELDS = new Set(["manufacturer", "model", "modelReference", "classification", "warrantyGuarantorParts", "warrantyDurationParts", "expectedLife", "replacementCost", "ppmTask", "ppmFrequency", "url"]);

export interface AssetOptions {
  /** Revit categories whose elements are assets. */
  categories: string[];
  /** Field id -> property key ("Group/Name") to read it from, "" to leave it empty; absent: found automatically. */
  sources: Record<string, string>;
  /** Location and asset codes: site and building codes (blank: initials of their names) and the asset code pattern. */
  codes?: { site: string; building: string; pattern: string };
}


export interface RegisterInput {
  jobs: SourceJob[];
  /** Viewer coordinates -> metres in the model's own coordinates, per job. */
  toMetres: (job: SourceJob) => Affine;
  /** Whether an element goes into the conversion (part included, categories and pattern not left out). */
  include: (job: SourceJob, e: number, info: ElementInfo) => boolean;
  storeys: StoreyDef[];
  /** The element's IFC GlobalId (the same as in the IFC files). */
  guid: (job: SourceJob, e: number, props: Props) => string;
  /** Shared ids across files of one conversion. */
  projectKey: string;
  /** Site and building names (location paths, and default codes). */
  names?: { site: string; building: string };
}

export interface RegisterFloor {
  key: string;
  name: string;
  /** Metres, model height datum. */
  elevation: number;
  height: number | null;
  guid: string;
}

export interface RegisterSpace {
  key: string;
  /** COBie Space.Name: the room number when there is one, otherwise the room name. */
  name: string;
  number: string;
  roomName: string;
  floor: string;
  /** Storey key (as in the IFC files). */
  floorKey: string;
  category: string;
  department: string;
  occupant: string;
  /** Fire compartment or zone the room's own properties name. */
  fireZone: string;
  grossArea: number | null;
  netArea: number | null;
  height: number | null;
  /** element: a room or space of the model; reference: named by assets (rooms not in the model). */
  source: "element" | "reference";
  /** "job|dbId" of a room of the model, "" for rooms named by assets. */
  elementKey: string;
  guid: string;
  elementId: string;
  file: string;
  props: Props;
  /** Asset names in the space, and those serving it. */
  assets: string[];
  servedBy: string[];
  /** World box in metres (element spaces with geometry). */
  box: [number, number, number, number, number, number] | null;
}

export interface RegisterType {
  key: string;
  /** COBie Type.Name. */
  name: string;
  category: string;
  revitCategory: string;
  family: string;
  type: string;
  assetType: "Fixed" | "Moveable";
  ifcClass: string;
  ifcTypeClass: string;
  guid: string;
  /** Asset kind of the type's first asset, and the Uniclass product code suggested for it. */
  kind: string;
  uniclass: [string, string] | null;
  /** Type field values (shown as found). */
  values: Record<string, string>;
  /** Fields whose value differs between the type's assets (all values listed). */
  conflicts: Record<string, string[]>;
  /** Type-level properties ("Revit Type" tab) of the first asset. */
  props: Props;
  assets: string[];
}

export interface RegisterSystemRef {
  name: string;
  classification: string;
  type: string;
}

export interface RegisterAsset {
  key: string;
  /** COBie Component.Name (unique). */
  name: string;
  guid: string;
  elementId: string;
  category: string;
  family: string;
  type: string;
  typeKey: string;
  typeName: string;
  ifcClass: string;
  /** What the asset is (asset management): kind, short code, discipline, compliance regime and Uniclass suggestion. */
  kind: string;
  kindId: string;
  kindCode: string;
  discipline: Discipline;
  compliance: string;
  uniclass: [string, string] | null;
  traits: Trait[];
  /** Asset code from the code pattern, location code and path (site > building > floor > room). */
  code: string;
  locationCode: string;
  locationPath: string;
  /** The asset this one is part of, and its parts. */
  parent: string;
  children: string[];
  /** Where the "fed from" board came from: a property, or a note in the element's text ("FED FROM SMDB-02"). */
  panelSource: "" | "property" | "text";
  floor: string;
  floorKey: string;
  level: string;
  /** Space name ("" when not known) and how it was found. */
  space: string;
  spaceSource: "" | "property" | "room tab" | "geometry";
  systems: RegisterSystemRef[];
  servedBy: string[];
  serves: string[];
  servingSpaces: string[];
  /** Field values: the asset's own, then its type's. */
  values: Record<string, string>;
  /** Fields worked out from others (warranty end, end of life). */
  derived: string[];
  /** Box centre, metres, model coordinates. */
  position: [number, number, number] | null;
  file: string;
  job: string;
  e: number;
  props: Props;
  units: Record<string, string>;
}

export interface RegisterSystem {
  key: string;
  name: string;
  classification: string;
  type: string;
  members: string[];
  /** Members that feed the others (equipment). */
  sources: string[];
  ifcType: string;
  guid: string;
  /** Where the system comes from: the model's system names, a board's circuits, or a fire alarm panel's loops. */
  origin: "model" | "electrical" | "fire alarm";
  uniclass: [string, string] | null;
}

export interface RegisterZone {
  name: string;
  category: string;
  description: string;
  spaces: string[];
  guid: string;
}

export interface RegisterRelation {
  from: string;
  to: string;
  /** "System" (shared distribution system), "Electrical supply" (board), "Fire alarm" (panel and loop), "Signal" (low-voltage panel), "Stated" (a property says so). */
  kind: string;
  via: string;
}

export interface RegisterJob {
  name: string;
  typeName: string;
  description: string;
  frequency: number | null;
  frequencyUnit: string;
  duration: number | null;
  durationUnit: string;
  taskNumber: string;
}

export interface FieldSource {
  field: string;
  label: string;
  level: FieldDef["level"];
  /** Property keys read, best first. */
  keys: string[];
  auto: boolean;
  filled: number;
  /** Assets (or rooms) the field applies to. */
  total: number;
  /** How values were found besides the property (rooms by geometry, derived dates). */
  note?: string;
}

export interface RegisterIssue {
  kind: string;
  sheet: "Component" | "Type" | "Space" | "System";
  row: string;
  message: string;
}

export interface PropertyColumn {
  key: string;
  count: number;
}

export interface AssetRegister {
  floors: RegisterFloor[];
  spaces: RegisterSpace[];
  types: RegisterType[];
  assets: RegisterAsset[];
  systems: RegisterSystem[];
  zones: RegisterZone[];
  relations: RegisterRelation[];
  jobs: RegisterJob[];
  sources: FieldSource[];
  /** Per field: properties whose names match it, with how many assets have a value. */
  candidates: Record<string, PropertyColumn[]>;
  /** Every property key found on assets, most filled first (for picking a field's source by hand). */
  properties: PropertyColumn[];
  /** Categories of the included elements, with counts (for picking asset categories). */
  categories: { name: string; count: number; asset: boolean }[];
  issues: RegisterIssue[];
  /** Boards, their tree and circuits (single-line diagram data). */
  electrical: RegisterElectrical;
  stats: {
    elements: number;
    assets: number;
    types: number;
    spaces: number;
    spacesFromModel: number;
    systems: number;
    relations: number;
    withSpace: number;
    spaceByGeometry: number;
    boards: number;
    circuits: number;
    fireDevices: number;
    withTechnical: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers

// Names compared without case, with runs of spaces as one and typographic dashes ("MDB−NED-02") as hyphens.
const upper = (s: string) => s.toUpperCase().replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\s+/g, " ").trim();

/** "GUARD MC.131" -> name GUARD, number MC.131; "101 Office" -> number 101; "Office" -> name only. */
export function splitRoom(text: string): { name: string; number: string } {
  const t = text.replace(/\s+/g, " ").trim();
  const parts = t.split(" ");
  const last = parts[parts.length - 1];
  const first = parts[0];
  if (parts.length >= 2 && /\d/.test(last)) return { name: parts.slice(0, -1).join(" "), number: last };
  if (parts.length >= 2 && /\d/.test(first) && !/\d/.test(last)) return { name: parts.slice(1).join(" "), number: first };
  if (parts.length === 1 && /\d/.test(t)) return { name: "", number: t };
  return { name: t, number: "" };
}

// Navisworks tabs and Revit groups that are not a room's (a tab named after a room carries its level).
const KNOWN_TABS = new Set(
  [
    "item", "element", "revit type", "element id", "identity data", "constraints", "dimensions", "phasing", "other", "mechanical", "mechanical - flow",
    "mechanical - loads", "electrical", "electrical - loads", "electrical - lighting", "electrical - circuiting", "plumbing", "text", "materials and finishes",
    "structural", "graphics", "data", "ifc parameters", "analytical properties", "hyperlinks", "element properties", "revit material", "material",
    "base constraint", "top constraint", "reference level", "schedule level", "base level", "top level", "level", "phase", "phase id", "design option",
    "workset", "host", "system type", "distribution system", "pipe segment", "pipesegment", "mepsystem", "walltype", "energy analysis",
    "green building properties", "construction", "fire protection", "general", "model properties", "timeliner", "geometry", "transform", "entity handle",
    "autocad", "attributes", "units", "document", "__category__", "__name__", "__parent__", "__child__", "__viewable_in__", "__externalid__",
  ].map((t) => t.toLowerCase()),
);

/** The unit a property's name gives in brackets ("Frequency of Maintenance (Months)"), or "". */
function unitInName(key: string): string {
  const slash = key.indexOf("/");
  return nameUnit(slash > 0 ? key.slice(slash + 1) : key)?.unit ?? "";
}

function roomTabs(props: Props): { tab: string; level: string; name: string; number: string }[] {
  const tabs = new Map<string, { level: string; workset: string; name: string; number: string }>();
  for (const key of Object.keys(props)) {
    const slash = key.indexOf("/");
    if (slash <= 0) continue;
    const tab = key.slice(0, slash);
    const lower = tab.toLowerCase();
    if (KNOWN_TABS.has(lower) || lower.startsWith("__") || lower.startsWith("material") || lower.startsWith("revit")) continue;
    const prop = key.slice(slash + 1).toLowerCase();
    let entry = tabs.get(tab);
    if (!entry) tabs.set(tab, (entry = { level: "", workset: "", name: "", number: "" }));
    const v = cleanText(props[key]);
    if (prop === "level") entry.level = v;
    else if (prop === "workset") entry.workset = v;
    else if (prop === "name") entry.name = v;
    else if (prop === "number") entry.number = v;
  }
  const out: { tab: string; level: string; name: string; number: string }[] = [];
  for (const [tab, e] of tabs) {
    // A room's tab: named with a room number, or living on a rooms workset, and carrying a level.
    if (!e.level && !e.number) continue;
    if (!(/\d/.test(tab) || /room|space/i.test(e.workset) || e.number)) continue;
    const split = splitRoom(tab);
    out.push({ tab, level: e.level, name: e.name || split.name, number: e.number || split.number });
  }
  return out;
}

function mode(values: string[]): { value: string; distinct: string[] } {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = "";
  let n = 0;
  for (const [v, c] of counts) if (c > n) {
    best = v;
    n = c;
  }
  return { value: best, distinct: [...counts.keys()] };
}

// Display units the viewer reports, as metres per unit.
const LENGTH_UNITS: [RegExp, number][] = [
  [/^(ft|feet|foot|decimal-ft|ft-and-.*|feet-and-.*)$/i, 0.3048],
  [/^(in|inch|inches|decimal-in|fractional-in)$/i, 0.0254],
  [/^(m|meter|meters|metre|metres|m-and-cm)$/i, 1],
  [/^(cm|centimeter|centimeters|centimetre|centimetres)$/i, 0.01],
  [/^(mm|millimeter|millimeters|millimetre|millimetres)$/i, 0.001],
];

function lengthScale(unit: string | undefined): number | null {
  if (!unit) return null;
  for (const [re, scale] of LENGTH_UNITS) if (re.test(unit.trim())) return scale;
  return null;
}

function areaScale(unit: string | undefined): number | null {
  if (!unit) return null;
  const u = unit.trim().toLowerCase().replace(/\s+/g, "");
  if (/^(ft\^?2|ft²|sqft|squarefeet|square-feet|sf)$/.test(u)) return 0.09290304;
  if (/^(m\^?2|m²|sqm|squaremeters|squaremetres|square-meters)$/.test(u)) return 1;
  if (/^(mm\^?2|mm²)$/.test(u)) return 1e-6;
  return null;
}

/** IFC distribution system type for a Revit system classification / type name. */
export function distributionSystemType(classification: string, type: string): string {
  const t = `${classification} ${type}`.toLowerCase();
  if (/fire|sprinkler|hydrant|wet|dry riser|pre-?action|deluge/.test(t)) return /alarm/.test(t) ? "SIGNAL" : "FIREPROTECTION";
  if (/exhaust|extract/.test(t)) return "EXHAUST";
  if (/fresh air|outside air|outdoor air|supply air|return air|ventilat|pressuri/.test(t)) return "VENTILATION";
  if (/chilled|chw/.test(t)) return "CHILLEDWATER";
  if (/condenser/.test(t)) return "CONDENSERWATER";
  if (/heating|hot water supply|hydronic|lthw|mthw/.test(t)) return /domestic/.test(t) ? "DOMESTICHOTWATER" : "HEATING";
  if (/domestic hot|dhw|hot water/.test(t)) return "DOMESTICHOTWATER";
  if (/domestic cold|dcw|cold water|potable|water supply/.test(t)) return "DOMESTICCOLDWATER";
  if (/sanitary|soil|sewage|foul/.test(t)) return "SEWAGE";
  if (/waste/.test(t)) return "WASTEWATER";
  if (/storm|rain/.test(t)) return "STORMWATER";
  if (/drain|condensate/.test(t)) return "DRAINAGE";
  if (/vent/.test(t)) return "VENT";
  if (/gas/.test(t)) return "GAS";
  if (/refrigerant|refrigeration/.test(t)) return "REFRIGERATION";
  if (/compressed air/.test(t)) return "COMPRESSEDAIR";
  if (/irrigation/.test(t)) return "WATERSUPPLY";
  if (/lighting/.test(t)) return "LIGHTING";
  if (/data/.test(t)) return "DATA";
  if (/telephone/.test(t)) return "TELEPHONE";
  if (/security|cctv|access/.test(t)) return "SECURITY";
  if (/communication|nurse call|av|audio/.test(t)) return "COMMUNICATION";
  if (/alarm/.test(t)) return "SIGNAL";
  if (/control/.test(t)) return "CONTROL";
  if (/power|electrical|lv|hv|switchboard|distribution/.test(t)) return "ELECTRICAL";
  if (/air/.test(t)) return "AIRCONDITIONING";
  return "NOTDEFINED";
}

/** A zone category from a system classification (COBie zone types). */
function zoneCategory(kind: string): string {
  const t = kind.toLowerCase();
  if (/fire|sprinkler/.test(t)) return "Fire Zone";
  if (/electrical supply|power|lighting/.test(t)) return "Electrical Zone";
  if (/signal|data|security|communication|telephone|nurse/.test(t)) return "Low Voltage Zone";
  if (/water|sanitary|plumbing|drain|waste/.test(t)) return "Plumbing Zone";
  return "HVAC Zone";
}

// ---------------------------------------------------------------------------
// Room geometry: which room solid a point is in (upward ray, odd crossings)

class RoomSolids {
  private readonly tris = new Map<RegisterSpace, Float64Array>();

  add(space: RegisterSpace, triangles: Float64Array) {
    this.tris.set(space, triangles);
  }

  get size() {
    return this.tris.size;
  }

  private inside(T: Float64Array, x: number, y: number, z: number): boolean {
    let crossings = 0;
    for (let i = 0; i < T.length; i += 9) {
      const ax = T[i],
        ay = T[i + 1],
        bx = T[i + 3],
        by = T[i + 4],
        cx = T[i + 6],
        cy = T[i + 7];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const hz = l1 * T[i + 2] + l2 * T[i + 5] + l3 * T[i + 8];
      if (hz > z) crossings++;
    }
    return crossings % 2 === 1;
  }

  /** The room containing the point; failing that, the room whose footprint holds it, nearest in height. */
  find(x: number, y: number, z: number): RegisterSpace | null {
    // A hair off grid lines, so the ray does not run along shared edges.
    const px = x + 1.37e-6,
      py = y + 2.11e-6;
    let footprint: RegisterSpace | null = null;
    let footprintGap = Infinity;
    for (const [space, T] of this.tris) {
      const b = space.box!;
      if (px < b[0] || px > b[3] || py < b[1] || py > b[4]) continue;
      if (z >= b[2] - 0.05 && z <= b[5] + 0.05 && this.inside(T, px, py, z)) return space;
      // Footprint: the same test at the room's mid-height.
      const gap = z < b[2] ? b[2] - z : z > b[5] ? z - b[5] : 0;
      if (gap < footprintGap && gap < 2.5 && this.inside(T, px, py, (b[2] + b[5]) / 2)) {
        footprint = space;
        footprintGap = gap;
      }
    }
    return footprint;
  }
}

// ---------------------------------------------------------------------------
// The register

interface Entry {
  job: SourceJob;
  e: number;
  k: number;
  info: ElementInfo;
  box: [number, number, number, number, number, number] | null;
}

/** Field values of an element: the first non-empty value among the field's source keys. */
function readField(props: Props, keys: string[]): string {
  for (const key of keys) {
    const v = cleanText(props[key]);
    if (v) return v;
  }
  return "";
}

/** Property keys whose names match a field, ranked: name order, then group, then how often they are filled. */
function matchKeys(field: FieldDef, counts: Map<string, number>): PropertyColumn[] {
  const wanted = field.names.map(normaliseName);
  const found: { key: string; count: number; rank: number; group: number; exact: number }[] = [];
  for (const [key, count] of counts) {
    const slash = key.indexOf("/");
    const group = slash > 0 ? key.slice(0, slash) : "";
    const name = slash > 0 ? key.slice(slash + 1) : key;
    let rank = wanted.indexOf(normaliseName(name));
    let exact = 1;
    // "Expected Lifetime (Years)", "Frequency of Maintenance (Months)": the name with its unit in brackets.
    const withUnit = rank < 0 ? nameUnit(name) : null;
    if (withUnit) {
      rank = wanted.indexOf(normaliseName(withUnit.base));
      exact = 0;
    }
    if (rank < 0) continue;
    const g = groupRank(group, field.level, field.id);
    if (!Number.isFinite(g)) continue;
    found.push({ key, count, rank, group: g, exact });
  }
  found.sort((a, b) => a.rank - b.rank || b.exact - a.exact || a.group - b.group || b.count - a.count);
  return found.map(({ key, count }) => ({ key, count }));
}

/** Whether a field limited to some kinds of asset applies to one. */
function appliesTo(f: FieldDef, kind: AssetKind, category: string): boolean {
  const a = f.applies;
  if (!a) return true;
  if (a.not?.some((t) => kind.traits.includes(t))) return false;
  if (a.traits?.some((t) => kind.traits.includes(t))) return true;
  if (a.disciplines?.includes(kind.discipline)) return true;
  return Boolean(a.categories?.includes(category));
}

// Tabs Navisworks adds for an element's related objects: they hold the level's, host's or system type's properties.
const RELATED_TAB = /^(base constraint|top constraint|base level|top level|reference level|schedule level|level|host|phase|phase created|phase demolished|phase id|design option|workset|system type|pipe segment|pipesegment|mepsystem|walltype|lcoa.*)$/i;
// Fields holding an identifier, which a yes / no flag is not.
const IDENTIFIER_FIELDS = new Set(["tag", "assetIdentifier", "serialNumber", "barCode", "panelName"]);

// A board named in an element's text ("2 Nos 16A TP isolator … FED FROM SMDB-AR-RT-LL-03 AT H/L").
const FED_FROM = /\b(?:fed|supplied|feed|fed off)\s+(?:from|by|off)\s*:?\s*([A-Z0-9][A-Z0-9\-_./]*[A-Z0-9])/i;
const TEXT_KEYS = /comment|remark|description|note|mark|name|feed|supply|source/i;

export function buildRegister(input: RegisterInput, options: AssetOptions, onProgress?: (phase: string, done: number, total: number) => void): AssetRegister {
  const assetCategories = new Set(options.categories);
  const storeys = input.storeys;
  const byLevel = levelIndex(storeys);
  const storeyName = new Map(storeys.map((s) => [s.key, s.name]));
  const box = new Float64Array(6);

  // 1. Elements of the conversion: assets, rooms, and everything else (for counts).
  const assets: Entry[] = [];
  const rooms: Entry[] = [];
  const categoryCounts = new Map<string, number>();
  let elements = 0;
  for (const job of input.jobs) {
    const toMetres = input.toMetres(job);
    for (let k = 0; k < job.elementCount; k++) {
      if (onProgress && k % 20000 === 0) onProgress(`Reading ${job.name}`, k, job.elementCount);
      const e = job.elementIds[k];
      const info = job.info(e);
      if (!input.include(job, e, info)) continue;
      elements++;
      const category = info.category || "(no category)";
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      const isRoom = SPACE_CATEGORIES.has(category);
      if (!isRoom && !assetCategories.has(category)) continue;
      let b: [number, number, number, number, number, number] | null = null;
      for (let j = job.elementStart[k]; j < job.elementStart[k + 1]; j++) {
        transformBox(toMetres, job.data.fbox, job.fragOrder[j] * 6, box);
        if (!b) b = [box[0], box[1], box[2], box[3], box[4], box[5]];
        else
          for (let i = 0; i < 3; i++) {
            b[i] = Math.min(b[i], box[i]);
            b[i + 3] = Math.max(b[i + 3], box[i + 3]);
          }
      }
      (isRoom ? rooms : assets).push({ job, e, k, info, box: b });
    }
  }

  // 2. Which properties feed which field. A room's tab on an asset (Navisworks' "convert room as attribute")
  // describes the room, so it feeds no asset field (its Comments, Volume and Area are the room's).
  const roomTabNames = new Set<string>();
  for (const a of assets) for (const t of roomTabs(a.info.props)) roomTabNames.add(t.tab);
  const groupOf = (key: string) => {
    const slash = key.indexOf("/");
    return slash > 0 ? key.slice(0, slash) : "";
  };
  // What is the asset's own: not a room's tab, nor a related object's (its level, host, phase, system type).
  const ownKey = (key: string) => {
    if (key.startsWith("__")) return false;
    const g = groupOf(key);
    return !roomTabNames.has(g) && !RELATED_TAB.test(g);
  };
  const ownProps = (p: Props): Props => {
    const out: Props = {};
    for (const key in p) if (ownKey(key)) out[key] = p[key];
    return out;
  };
  const assetKeyCounts = new Map<string, number>();
  for (const a of assets)
    for (const [key, value] of Object.entries(a.info.props)) {
      if (key.startsWith("__") || roomTabNames.has(groupOf(key))) continue;
      if (cleanText(value)) assetKeyCounts.set(key, (assetKeyCounts.get(key) ?? 0) + 1);
    }
  const roomKeyCounts = new Map<string, number>();
  for (const r of rooms)
    for (const [key, value] of Object.entries(r.info.props)) if (cleanText(value)) roomKeyCounts.set(key, (roomKeyCounts.get(key) ?? 0) + 1);

  const candidates: Record<string, PropertyColumn[]> = {};
  const keysOf: Record<string, string[]> = {};
  const auto: Record<string, boolean> = {};
  for (const field of FIELDS) {
    const counts = field.level === "space" ? roomKeyCounts : assetKeyCounts;
    const matched = matchKeys(field, counts);
    candidates[field.id] = matched;
    const chosen = options.sources[field.id];
    if (chosen !== undefined) {
      keysOf[field.id] = chosen ? [chosen] : [];
      auto[field.id] = false;
    } else {
      keysOf[field.id] = matched.map((m) => m.key);
      auto[field.id] = true;
    }
  }
  // "Mark" is the tag only when no stronger tag field exists; a type's "Description" is not the asset's comment.
  // A key feeds one field: the first that claims it in catalogue order (so "Cost" is not also "Replacement cost"
  // twice). Fields limited to some kinds of asset only compete with fields limited the same way ("Capacity" is a
  // chiller's cooling capacity and a lift's rated load); among them, one asset's key feeds one field (`exclusive`).
  const claimedAll = new Set<string>();
  const claimedBy = new Map<string, Set<string>>();
  for (const field of FIELDS) {
    if (!auto[field.id]) continue;
    const signature = field.applies ? JSON.stringify(field.applies) : "";
    keysOf[field.id] = keysOf[field.id].filter((key) => {
      const k = `${field.level}|${key}`;
      if (claimedAll.has(k)) return false;
      const by = claimedBy.get(k);
      return signature ? !by?.has(signature) : !by;
    });
    for (const key of keysOf[field.id]) {
      const k = `${field.level}|${key}`;
      if (!signature) claimedAll.add(k);
      else claimedBy.set(k, (claimedBy.get(k) ?? new Set()).add(signature));
    }
  }

  // 3. Spaces: rooms of the model, then rooms named by assets (tabs and properties).
  const spaces: RegisterSpace[] = [];
  const byKey = new Map<string, RegisterSpace>();
  const byNumber = new Map<string, RegisterSpace>();
  const byFull = new Map<string, RegisterSpace>();
  const byName = new Map<string, RegisterSpace[]>();
  const spaceGuid = (key: string) => hashGuid(`space|${input.projectKey}|${key}`);
  const addSpace = (space: RegisterSpace) => {
    spaces.push(space);
    byKey.set(space.key, space);
    if (space.number) byNumber.set(upper(space.number), space);
    byFull.set(upper(`${space.roomName} ${space.number}`), space);
    byFull.set(upper(`${space.number} ${space.roomName}`), space);
    byFull.set(upper(space.name), space);
    if (space.roomName) {
      const list = byName.get(upper(space.roomName)) ?? [];
      list.push(space);
      byName.set(upper(space.roomName), list);
    }
  };
  const resolveSpace = (text: string): RegisterSpace | null => {
    const t = upper(text);
    if (!t) return null;
    const direct = byFull.get(t) ?? byNumber.get(t);
    if (direct) return direct;
    const { name, number } = splitRoom(text);
    if (number) {
      const s = byNumber.get(upper(number));
      if (s) return s;
    }
    if (name) {
      const list = byName.get(upper(name));
      if (list && list.length === 1) return list[0];
    }
    return null;
  };
  const spaceNames = new Set<string>();
  const uniqueSpaceName = (base: string) => {
    let name = base || "Space";
    for (let n = 2; spaceNames.has(name); n++) name = `${base || "Space"} (${n})`;
    spaceNames.add(name);
    return name;
  };

  const solids = new RoomSolids();
  for (const r of rooms) {
    const p = r.info.props;
    const roomName = readField(p, keysOf.spaceName) || splitRoom(r.job.nodeName(r.e)).name || r.job.nodeName(r.e);
    const number = readField(p, keysOf.spaceNumber) || splitRoom(r.job.nodeName(r.e)).number;
    const key = upper(number || roomName || `${r.job.name}|${r.e}`);
    if (byKey.has(key)) continue;
    const units = unitsOf(r.job);
    const area = (fieldId: string) => {
      for (const k of keysOf[fieldId]) {
        const n = parseNumber(p[k]);
        if (n === null) continue;
        const scale = areaScale(units.get(k)) ?? (legacyOf(r.job) ? 0.09290304 : 1);
        return Math.round(n * scale * 100) / 100;
      }
      return null;
    };
    const height = (() => {
      for (const k of keysOf.usableHeight) {
        const n = parseNumber(p[k]);
        if (n === null) continue;
        const scale = lengthScale(units.get(k)) ?? (legacyOf(r.job) ? 0.3048 : 1);
        return Math.round(n * scale * 1000) / 1000;
      }
      return r.box ? Math.round((r.box[5] - r.box[2]) * 1000) / 1000 : null;
    })();
    const bottom = r.box ? r.box[2] : 0;
    const floorKey = storeyFor(storeys, byLevel, r.info.level, bottom);
    const space: RegisterSpace = {
      key,
      name: uniqueSpaceName(number || roomName),
      number,
      roomName,
      floor: storeyName.get(floorKey) ?? "",
      floorKey,
      category: readField(p, keysOf.spaceCategory),
      department: readField(p, keysOf.department),
      occupant: readField(p, keysOf.occupant),
      fireZone: readField(p, keysOf.spaceFireZone),
      grossArea: area("grossArea"),
      netArea: area("netArea"),
      height,
      source: "element",
      elementKey: `${r.job.name}|${r.e}`,
      guid: input.guid(r.job, r.e, p),
      elementId: r.job.elementId(r.e, p),
      file: r.info.file,
      props: p,
      assets: [],
      servedBy: [],
      box: r.box,
    };
    addSpace(space);
    // Room solids for the geometry test.
    const T = roomTriangles(r, input.toMetres(r.job));
    if (T && space.box) {
      solids.add(space, T);
      if (space.grossArea === null) space.grossArea = footprintArea(T);
    }
  }

  const referenced = (text: string, level: string, from: "property" | "room tab", nameHint = "", numberHint = ""): RegisterSpace | null => {
    const found = resolveSpace(text);
    if (found) return found;
    const split = splitRoom(text);
    const number = numberHint || split.number;
    const roomName = nameHint || split.name;
    const key = upper(number || roomName);
    if (!key) return null;
    const existing = byKey.get(key);
    if (existing) return existing;
    void from;
    const floorKey = level ? (byLevel.get(level) ?? "") : "";
    const space: RegisterSpace = {
      key,
      name: uniqueSpaceName(number || roomName),
      number,
      roomName,
      floor: storeyName.get(floorKey) ?? "",
      floorKey,
      category: "",
      department: "",
      occupant: "",
      fireZone: "",
      grossArea: null,
      netArea: null,
      height: null,
      source: "reference",
      elementKey: "",
      guid: spaceGuid(key),
      elementId: "",
      file: "",
      props: {},
      assets: [],
      servedBy: [],
      box: null,
    };
    addSpace(space);
    return space;
  };

  // 4. Assets
  const typeEntries = new Map<string, { entries: Entry[]; names: string[] }>();
  const registerAssets: RegisterAsset[] = [];
  const nameCount = new Map<string, number>();
  const labelCount = new Map<string, number>();
  const issues: RegisterIssue[] = [];
  const unresolvedSpaces = new Map<string, number>();
  let spaceByGeometry = 0;
  const typeFields = FIELDS.filter((f) => f.level === "type");
  const assetFields = FIELDS.filter((f) => f.level !== "space");
  const applicable = new Map<string, number>();

  assets.forEach((a, i) => {
    if (onProgress && i % 5000 === 0) onProgress("Reading assets", i, assets.length);
    const { job, e, info } = a;
    const p = info.props;
    const ku = unitsOf(job);
    const values: Record<string, string> = {};
    // Fields of every asset first, then what the asset is, then the fields of its kind.
    const taken = new Map<string, Set<string>>();
    const read = (f: FieldDef) => {
      const used = f.exclusive ? (taken.get(f.exclusive) ?? taken.set(f.exclusive, new Set()).get(f.exclusive)!) : null;
      for (const key of keysOf[f.id]) {
        if (used?.has(key)) continue;
        let v = "";
        if (f.kind === "quantity") {
          const q = parseQuantity(p[key], ku.get(key) || unitInName(key), f.unit ?? "");
          if (q !== null && q !== 0) v = String(q);
        } else if (f.kind === "date") v = parseDate(p[key]);
        else if (f.kind === "year") v = parseYear(p[key]);
        else if (f.kind === "duration") {
          // A frequency or life as a number of the unit the name gives ("Expected Lifetime (Years)": 15), and
          // only what reads as a duration ("60 Hz" in a type's "Frequency" is the supply's).
          v = cleanText(p[key]);
          const unit = unitInName(key);
          if (v && unit && /^\d+(?:[.,]\d+)?$/.test(v)) v = `${v} ${unit}`;
          if (v && !parseDuration(v)) v = "";
        } else v = cleanText(p[key]);
        if (v && IDENTIFIER_FIELDS.has(f.id) && /^(?:yes|no|true|false|y|n)$/i.test(v)) v = "";
        // A board is named, not measured: a number with a fraction under "DB" is a dimension.
        if (v && (f.id === "panel" || f.id === "firePanel") && (typeof p[key] === "number" || /^[-+]?\d*[.,]\d+$/.test(v))) v = "";
        if (!v) continue;
        used?.add(key);
        return v;
      }
      return "";
    };
    for (const f of assetFields) if (!f.applies) values[f.id] = read(f);
    const nodeName = job.nodeName(e);
    const kind = assetKind(info.category, info.family, info.type, nodeName, `${values.panelName} ${values.tag} ${values.typeMark}`);
    for (const f of assetFields) {
      if (!f.applies) continue;
      values[f.id] = "";
      if (!appliesTo(f, kind, info.category)) continue;
      applicable.set(f.id, (applicable.get(f.id) ?? 0) + 1);
      values[f.id] = read(f);
    }
    // Revit's one-line electrical data ("230 V/1-120 VA") and a board's distribution system ("400/230V 3P4W").
    if (values.electricalData && (!values.voltage || !values.phases || !values.connectedLoad)) {
      const d = parseElectricalData(values.electricalData);
      if (!values.voltage && d.voltage) values.voltage = String(d.voltage);
      if (!values.phases && d.phases) values.phases = String(d.phases);
      if (!values.connectedLoad && d.kva) values.connectedLoad = String(d.kva);
    }
    if (values.distributionSystem && (!values.voltage || !values.phases)) {
      const d = parseDistributionSystem(values.distributionSystem);
      if (!values.voltage && d.voltage) values.voltage = String(d.voltage);
      if (!values.phases && d.phases) values.phases = String(d.phases);
    }
    if (values.ipRating) {
      const m = /\bIP\s?-?([0-6X][0-9X])/i.exec(values.ipRating);
      if (m) values.ipRating = `IP${m[1].toUpperCase()}`;
    }
    // A fire alarm device's Panel and Circuit are its fire alarm panel and loop, not a power supply.
    if (kind.traits.includes("fireAlarm") && !kind.traits.includes("board")) {
      if (!values.firePanel) values.firePanel = values.panel;
      if (!values.loop) values.loop = values.circuit;
      values.panel = "";
      values.circuit = "";
    }
    // A family named after its Uniclass code (NBS object naming: "60_70_22_22_DistributionBoards_Generic").
    let classFromFamily = false;
    if (!values.classification) {
      const fu = familyUniclass(info.family);
      if (fu) {
        values.classification = fu[0];
        if (!values.classificationTitle) values.classificationTitle = fu[1];
        classFromFamily = true;
      }
    }
    // "FED FROM SMDB-02" in a description or note, when no property names the board.
    let panelSource: RegisterAsset["panelSource"] = values.panel ? "property" : "";
    if (!values.panel && (kind.traits.includes("power") || kind.traits.includes("board") || kind.traits.includes("lighting"))) {
      for (const [key, raw] of Object.entries(p)) {
        if (typeof raw !== "string" || raw.length < 10 || !TEXT_KEYS.test(key)) continue;
        const m = FED_FROM.exec(raw);
        if (m && /\d/.test(m[1])) {
          values.panel = m[1];
          panelSource = "text";
          break;
        }
      }
    }
    const elementId = job.elementId(e, p);
    const typeKey = `${info.category}|${info.family}|${info.type}`;
    let t = typeEntries.get(typeKey);
    if (!t) typeEntries.set(typeKey, (t = { entries: [], names: [] }));
    t.entries.push(a);

    // Name: an equipment code as it stands ("AHU-01"); a bare number with its type ("FCU-031-1213");
    // no tag: the Revit element id, or a running number within the type.
    // A board is known by its panel name (what the items it feeds refer to); a mark that is a note ("100A TP
    // isolator for CHWSP-ES-EL-05 fed from MCC-…") names nothing.
    const isCode = (t: string) => /[A-Za-z]/.test(t) && /\d/.test(t) && t.length <= 40;
    const mark = values.tag && values.tag.length <= 40 && (values.tag.match(/\s+/g)?.length ?? 0) < 3 ? values.tag : "";
    const tag = values.panelName && isCode(values.panelName) ? values.panelName : mark || values.panelName;
    const label = values.typeMark || info.type || info.family || info.category || "Asset";
    const sequence = (labelCount.get(label) ?? 0) + 1;
    labelCount.set(label, sequence);
    let base = tag && isCode(tag) ? tag : tag ? `${label}-${tag}` : `${label}-${elementId || String(sequence).padStart(3, "0")}`;
    base = base.slice(0, 120);
    let name = base;
    const seen = nameCount.get(name) ?? 0;
    if (seen) {
      name = `${base} (${elementId || seen + 1})`;
      for (let n = 2; nameCount.has(name); n++) name = `${base} (${elementId || seen + 1}-${n})`;
    }
    nameCount.set(base, seen + 1);
    nameCount.set(name, 1);

    // Space: a property naming the room, a room tab, or the room solid holding the asset.
    let space: RegisterSpace | null = null;
    let spaceSource: RegisterAsset["spaceSource"] = "";
    if (values.space) {
      space = referenced(values.space, info.level, "property");
      if (space) spaceSource = "property";
      else unresolvedSpaces.set(values.space, (unresolvedSpaces.get(values.space) ?? 0) + 1);
    }
    if (!space) {
      const tabs = roomTabs(p);
      if (tabs.length === 1) {
        const tab = tabs[0];
        space = referenced(tab.tab, tab.level, "room tab", tab.name, tab.number);
        if (space) {
          spaceSource = "room tab";
          if (!space.floorKey && tab.level) {
            space.floorKey = byLevel.get(tab.level) ?? "";
            space.floor = storeyName.get(space.floorKey) ?? "";
          }
        }
      }
    }
    const position: [number, number, number] | null = a.box ? [(a.box[0] + a.box[3]) / 2, (a.box[1] + a.box[4]) / 2, (a.box[2] + a.box[5]) / 2] : null;
    if (!space && position && solids.size) {
      space = solids.find(position[0], position[1], position[2]);
      if (space) {
        spaceSource = "geometry";
        spaceByGeometry++;
      }
    }

    // Systems: Revit lists several as "SA 1, CHW 2", and the classifications and types as lists of their own
    // that need not be in the same order (or as long); they are settled per system below, by vote.
    const names = values.systemName ? values.systemName.split(/\s*,\s*/).filter(Boolean) : [];
    const classes = values.systemClassification ? values.systemClassification.split(/\s*,\s*/).filter(Boolean) : [];
    const types = values.systemType ? values.systemType.split(/\s*,\s*/).filter(Boolean) : [];
    const paired = (list: string[], j: number) => (list.length === names.length ? list[j] : "");
    const systems = names.map((n, j) => ({ name: n, classification: paired(classes, j), type: paired(types, j) }));

    const bottom = a.box ? a.box[2] : 0;
    const floorKey = storeyFor(storeys, byLevel, info.level, bottom);
    const choice = classify(info.category, info.family, info.type, [nodeName]);
    const units: Record<string, string> = {};
    for (const key of Object.keys(p)) {
      const u = ku.get(key);
      if (u) units[key] = u;
    }
    registerAssets.push({
      key: `${job.name}|${e}`,
      name,
      guid: input.guid(job, e, p),
      elementId,
      category: info.category,
      family: info.family,
      type: info.type,
      typeKey,
      typeName: "",
      ifcClass: ifcClass(choice.cls)?.name ?? "IfcBuildingElementProxy",
      kind: kind.label,
      kindId: kind.id,
      kindCode: kind.code,
      discipline: kind.discipline,
      compliance: kind.compliance,
      uniclass: kind.uniclass,
      traits: kind.traits,
      code: "",
      locationCode: "",
      locationPath: "",
      parent: "",
      children: [],
      panelSource,
      floor: storeyName.get(floorKey) ?? "",
      floorKey,
      level: info.level,
      space: space?.name ?? "",
      spaceSource,
      systems,
      servedBy: [],
      serves: [],
      servingSpaces: [],
      values,
      derived: classFromFamily ? ["classification"] : [],
      position,
      file: info.file,
      job: job.name,
      e,
      props: ownProps(p),
      units,
    });
    t.names.push(name);
    if (space) space.assets.push(name);
  });
  for (const [text, n] of unresolvedSpaces) issues.push({ kind: "Unknown space", sheet: "Component", row: text, message: `${n} asset(s) name the space "${text}", which matches no room of the model.` });

  // Spaces named by assets but not by a level: the floor most of their assets are on.
  const assetFloor = new Map(registerAssets.map((a) => [a.name, a.floorKey]));
  for (const sp of spaces) {
    if (sp.floorKey || sp.assets.length === 0) continue;
    const m = mode(sp.assets.map((n) => assetFloor.get(n) ?? ""));
    sp.floorKey = m.value;
    sp.floor = storeyName.get(m.value) ?? "";
  }

  // 5. Types: one per family type; type values are the most common among its assets.
  const types: RegisterType[] = [];
  const typeByKey = new Map<string, RegisterType>();
  const typeNames = new Set<string>();
  const assetByKey = new Map(registerAssets.map((a) => [a.key, a]));
  for (const [key, t] of typeEntries) {
    const first = t.entries[0];
    const info = first.info;
    let name = info.family && info.type && info.family !== info.type ? `${info.family}: ${info.type}` : info.type || info.family || info.category;
    if (typeNames.has(name)) name = `${info.category}: ${name}`;
    for (let n = 2; typeNames.has(name); n++) name = `${name} (${n})`;
    typeNames.add(name);
    const members = t.entries.map((en) => assetByKey.get(`${en.job.name}|${en.e}`)!);
    const values: Record<string, string> = {};
    const conflicts: Record<string, string[]> = {};
    for (const f of typeFields) {
      const m = mode(members.map((a) => a.values[f.id]));
      values[f.id] = m.value;
      if (m.distinct.length > 1) conflicts[f.id] = m.distinct;
    }
    const choice = classify(info.category, info.family, info.type, [first.job.nodeName(first.e)]);
    const cls = ifcClass(choice.cls)?.name ?? "IfcBuildingElementProxy";
    const typeClass = ifcTypeClass(cls)?.name ?? "";
    const assetType = /^moveable|^movable/i.test(values.assetType) ? "Moveable" : /^fixed/i.test(values.assetType) ? "Fixed" : MOVEABLE_CATEGORIES.has(info.category) ? "Moveable" : "Fixed";
    // Type-level properties: Navisworks' "Revit Type" tab (Revit models put type parameters among the element's).
    const props: Props = {};
    for (const [k, v] of Object.entries(first.info.props)) if (/^(revit type|type)\//i.test(k)) props[k] = v;
    const type: RegisterType = {
      key,
      name,
      category: values.classification || info.category,
      revitCategory: info.category,
      family: info.family,
      type: info.type,
      assetType,
      ifcClass: cls,
      ifcTypeClass: typeClass,
      guid: typeClass ? hashGuid(`type|${input.projectKey}|${typeClass}|${info.category}|${info.family}|${info.type}`) : hashGuid(`type|${input.projectKey}|${key}`),
      kind: members[0]?.kind ?? "",
      uniclass: members[0]?.uniclass ?? null,
      values,
      conflicts,
      props,
      assets: t.names,
    };
    types.push(type);
    typeByKey.set(key, type);
    for (const [field, distinct] of Object.entries(conflicts)) {
      // Sizes and dimensions vary per instance by nature; identity, warranty and life should not.
      if (!IDENTITY_FIELDS.has(field) || distinct.length > 6) continue;
      issues.push({ kind: "Type values differ", sheet: "Type", row: name, message: `${FIELD_BY_ID.get(field)?.label ?? field}: ${distinct.slice(0, 4).join(" | ")} (the most common is used).` });
    }
  }
  for (const a of registerAssets) {
    const type = typeByKey.get(a.typeKey)!;
    a.typeName = type.name;
    // The asset's own value wins; type values fill the rest.
    for (const f of typeFields) if (!a.values[f.id]) a.values[f.id] = type.values[f.id];
  }

  // 6. Derived dates: warranty end from start + duration, end of life from install (or manufacture) year + expected life.
  for (const a of registerAssets) {
    const v = a.values;
    const installed = parseDate(v.installationDate);
    if (installed) v.installationDate = installed;
    const start = parseDate(v.warrantyStartDate);
    if (start) v.warrantyStartDate = start;
    const end = parseDate(v.warrantyEndDate);
    if (end) v.warrantyEndDate = end;
    const made = parseYear(v.manufactureYear);
    if (made) v.manufactureYear = made;
    if (!v.warrantyEndDate && start.length === 10) {
      const d = parseDuration(v.warrantyDurationParts, parseUnit(v.warrantyDurationUnit) || "year");
      const years = durationYears(d);
      if (years !== null && years > 0 && years < 100) {
        const date = new Date(`${start}T00:00:00Z`);
        date.setUTCMonth(date.getUTCMonth() + Math.round(years * 12));
        v.warrantyEndDate = date.toISOString().slice(0, 10);
        a.derived.push("warrantyEndDate");
      }
    }
    const eol = parseDate(v.endOfLife);
    if (eol) v.endOfLife = eol;
    else {
      const life = durationYears(parseDuration(v.expectedLife, parseUnit(v.durationUnit) || "year"));
      const fromYear = installed ? Number(installed.slice(0, 4)) : made ? Number(made) : null;
      if (life !== null && life > 0 && life < 200 && fromYear) {
        v.endOfLife = String(Math.round(fromYear + life));
        a.derived.push("endOfLife");
      }
    }
  }

  // 7. Systems. A system's classification and type: what its members in that system alone say, else
  // what members whose lists line up with their system names say (most common wins).
  const systemMap = new Map<string, RegisterSystem>();
  const votes = new Map<string, { classification: Map<string, number>; type: Map<string, number> }>();
  const vote = (m: Map<string, number>, value: string, weight: number) => {
    if (value) m.set(value, (m.get(value) ?? 0) + weight);
  };
  for (const a of registerAssets)
    for (const s of a.systems) {
      const key = upper(s.name);
      let sys = systemMap.get(key);
      if (!sys) {
        sys = { key, name: s.name, classification: "", type: "", members: [], sources: [], ifcType: "", guid: hashGuid(`system|${input.projectKey}|${key}`), origin: "model", uniclass: null };
        systemMap.set(key, sys);
        votes.set(key, { classification: new Map(), type: new Map() });
      }
      const v = votes.get(key)!;
      const weight = a.systems.length === 1 ? 10 : 1;
      vote(v.classification, s.classification, weight);
      vote(v.type, s.type, weight);
      sys.members.push(a.name);
      if (SOURCE_CATEGORIES.has(a.category)) sys.sources.push(a.name);
    }
  const top = (m: Map<string, number>) => [...m].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "";
  for (const sys of systemMap.values()) {
    const v = votes.get(sys.key)!;
    sys.classification = top(v.classification);
    sys.type = top(v.type);
    sys.ifcType = distributionSystemType(sys.classification, sys.type || sys.name);
    sys.uniclass = systemUniclass(sys.classification || sys.type, sys.name);
  }
  for (const a of registerAssets)
    for (const s of a.systems) {
      const sys = systemMap.get(upper(s.name))!;
      s.classification = sys.classification;
      s.type = sys.type;
    }
  const systems = [...systemMap.values()].sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));

  // Two assets trade names everywhere a name is held so far (spaces, types, systems).
  const swapNames = (a: RegisterAsset, b: RegisterAsset) => {
    const [x, y] = [a.name, b.name];
    const trade = (list: string[]) => {
      for (let i = 0; i < list.length; i++) list[i] = list[i] === x ? y : list[i] === y ? x : list[i];
    };
    for (const sp of spaces) trade(sp.assets);
    for (const t of types) trade(t.assets);
    for (const sys of systems) {
      trade(sys.members);
      trade(sys.sources);
    }
    a.name = y;
    b.name = x;
  };
  // Boards that share a panel name (copies of one board, or a board placed again for scheduling): what names
  // it goes to the copy with the most electrical data, the others are folded into it on the single-line diagram,
  // and the duplicate is reported.
  const electricalData = (a: RegisterAsset) => ["connectedLoad", "demandLoad", "mainsRating", "ways", "voltage", "phases", "distributionSystem", "panel", "faultLevel"].filter((f) => a.values[f]).length;
  const boardGroups = new Map<string, RegisterAsset[]>();
  for (const a of registerAssets)
    if (a.values.panelName && a.traits.includes("board") && !a.traits.includes("fireAlarm")) {
      const k = upper(a.values.panelName);
      boardGroups.set(k, [...(boardGroups.get(k) ?? []), a]);
    }
  const primaryBoard = new Map<string, RegisterAsset>();
  const copyOf = new Map<string, string>();
  for (const [k, list] of boardGroups) {
    if (list.length < 2) continue;
    const best = [...list].sort((a, b) => electricalData(b) - electricalData(a) || a.name.localeCompare(b.name))[0];
    // The board keeps the plain panel name: a copy that took it first trades names with it.
    const plain = list.find((a) => a !== best && upper(a.name) === k);
    if (plain && upper(best.name) !== k) swapNames(best, plain);
    primaryBoard.set(k, best);
    for (const a of list) if (a !== best) copyOf.set(a.name, best.name);
    // The board is fed as a copy says when it says nothing itself.
    const fed = best.values.panel ? null : list.find((a) => a.values.panel);
    if (fed) {
      best.values.panel = fed.values.panel;
      best.panelSource = fed.panelSource;
      best.derived.push("panel");
    }
    issues.push({ kind: "Duplicate board name", sheet: "Component", row: best.values.panelName, message: `${list.length} boards carry the panel name "${best.values.panelName}" (${list.map((b) => b.name).join(", ")}); what names it is put under ${best.name}, and the single-line diagram shows them as one board.` });
  }
  // 8. Serving: stated properties, electrical boards, then systems with one to three equipment items.
  const byAssetName = new Map(registerAssets.map((a) => [a.name, a]));
  const assetLookup = new Map<string, RegisterAsset[]>();
  const index = (text: string, a: RegisterAsset) => {
    const k = upper(text);
    if (!k) return;
    const list = assetLookup.get(k) ?? [];
    if (!list.includes(a)) list.push(a);
    assetLookup.set(k, list);
  };
  for (const a of registerAssets) {
    index(a.name, a);
    index(a.values.tag, a);
    index(a.values.panelName, a);
    index(a.values.assetIdentifier, a);
    if (a.category === "Electrical Equipment") index(a.type, a);
  }
  const findAsset = (text: string, preferCategory?: string): RegisterAsset | null => {
    const k = upper(text);
    const primary = primaryBoard.get(k);
    if (primary) return primary;
    const list = assetLookup.get(k);
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const preferred = list.filter((a) => a.category === preferCategory);
    return preferred.length === 1 ? preferred[0] : null;
  };
  const relations: RegisterRelation[] = [];
  const relationKeys = new Set<string>();
  const relate = (from: RegisterAsset, to: RegisterAsset, kind: string, via: string) => {
    if (from === to) return;
    const key = `${from.name}\u0000${to.name}`;
    if (relationKeys.has(key)) return;
    relationKeys.add(key);
    relations.push({ from: from.name, to: to.name, kind, via });
    from.serves.push(to.name);
    to.servedBy.push(from.name);
  };
  const unresolvedBoards = new Map<string, number>();
  const unresolvedFeeds = new Map<string, RegisterAsset[]>();
  const unresolvedFirePanels = new Map<string, number>();
  const powered = (a: RegisterAsset) => a.traits.includes("power") || a.traits.includes("board") || a.traits.includes("lighting");
  // Data cabinets, security and BMS panels: what names them as its panel is wired for signals, not fed power.
  const signalPanel = (a: RegisterAsset) => a.traits.includes("signal") && !a.traits.includes("board");
  for (const a of registerAssets) {
    for (const text of a.values.servedBy ? a.values.servedBy.split(/\s*[,;]\s*/) : []) {
      const src = findAsset(text);
      if (src) relate(src, a, "Stated", text);
    }
    for (const text of a.values.serves ? a.values.serves.split(/\s*[,;]\s*/) : []) {
      const dst = findAsset(text);
      if (dst) relate(a, dst, "Stated", text);
    }
    if (a.values.panel && !copyOf.has(a.name)) {
      // A power board feeds; a fire alarm panel watches its devices; other panels carry signals (data, security).
      const board = findAsset(a.values.panel, "Electrical Equipment");
      const via = a.values.panel + (a.values.circuit ? ` / circuit ${a.values.circuit}` : "");
      if (board) relate(board, a, board.traits.includes("fireAlarm") && !powered(a) ? "Fire alarm" : signalPanel(board) ? "Signal" : powered(board) || powered(a) ? "Electrical supply" : "Signal", via);
      else {
        unresolvedBoards.set(a.values.panel, (unresolvedBoards.get(a.values.panel) ?? 0) + 1);
        if (powered(a)) unresolvedFeeds.set(a.values.panel, [...(unresolvedFeeds.get(a.values.panel) ?? []), a]);
      }
    }
    if (a.values.firePanel) {
      const panel = findAsset(a.values.firePanel);
      if (panel) relate(panel, a, "Fire alarm", a.values.firePanel + (a.values.loop ? ` / loop ${a.values.loop}` : ""));
      else unresolvedFirePanels.set(a.values.firePanel, (unresolvedFirePanels.get(a.values.firePanel) ?? 0) + 1);
    }
  }
  for (const [text, n] of unresolvedBoards) issues.push({ kind: "Unknown board", sheet: "Component", row: text, message: `${n} asset(s) are fed from "${text}", which is not among the assets (not modelled, or its category is left out).` });
  for (const [text, n] of unresolvedFirePanels) issues.push({ kind: "Unknown fire alarm panel", sheet: "Component", row: text, message: `${n} fire alarm device(s) name the panel "${text}", which is not among the assets.` });
  for (const sys of systems) {
    // Who feeds whom in a system, without connectivity, by what the equipment is: in an air system
    // the AHU feeds the fan coils / VAV boxes and they the air terminals; in a chilled or hot water
    // system the chillers, boilers and pumps feed the AHUs, fan coils and terminals (there the AHUs
    // and fan coils are fed, not feeding); elsewhere the most upstream equipment feeds the rest.
    const equipment = [...new Set(sys.sources)].map((n) => byAssetName.get(n)!);
    if (equipment.length === 0) continue;
    const text = `${sys.classification} ${sys.type} ${sys.name}`;
    const medium = /air|exhaust|ventilat|pressuri|smoke|duct/i.test(text) ? "air" : /chilled|chw|hot water|\bhw\b|heating|hydronic|condenser|glycol|lthw|mthw/i.test(text) ? "hydronic" : "other";
    const allowed = medium === "air" ? [1, 3] : medium === "hydronic" ? [0, 2] : [0, 1, 2];
    let candidates = equipment.filter((a) => allowed.includes(upstreamRank(a)));
    // A lone piece of equipment of unknown kind feeds its air or other system's terminals.
    if (candidates.length === 0 && equipment.length === 1 && medium !== "hydronic" && upstreamRank(equipment[0]) === UPSTREAM.length) candidates = equipment;
    let sources: RegisterAsset[] = [];
    if (candidates.length) {
      const best = Math.min(...candidates.map(upstreamRank));
      sources = candidates.filter((a) => upstreamRank(a) === best);
      if (sources.length > 3) sources = [];
    }
    sys.sources = sources.map((a) => a.name);
    if (sources.length === 0) continue;
    const sourceRank = upstreamRank(sources[0]);
    for (const memberName of new Set(sys.members)) {
      const member = byAssetName.get(memberName)!;
      if (sources.includes(member)) continue;
      const rank = upstreamRank(member);
      const fedEquipment = SOURCE_CATEGORIES.has(member.category) && (medium === "hydronic" ? !allowed.includes(rank) || rank > sourceRank : rank > sourceRank && rank < UPSTREAM.length);
      if (!CONSUMER_CATEGORIES.has(member.category) && !fedEquipment) continue;
      for (const src of sources) relate(src, member, "System", sys.name);
    }
  }

  // Spaces served: where the assets an asset serves are.
  const spaceByName = new Map(spaces.map((s) => [s.name, s]));
  for (const a of registerAssets) {
    const served = new Set<string>();
    for (const n of a.serves) {
      const target = byAssetName.get(n);
      if (target?.space) served.add(target.space);
    }
    a.servingSpaces = [...served].sort();
    for (const s of a.servingSpaces) spaceByName.get(s)?.servedBy.push(a.name);
  }

  // Parts: an asset naming the one it is part of.
  const unresolvedParents = new Map<string, number>();
  for (const a of registerAssets) {
    if (!a.values.parentAsset) continue;
    const parent = findAsset(a.values.parentAsset);
    if (parent && parent !== a) {
      a.parent = parent.name;
      parent.children.push(a.name);
    } else unresolvedParents.set(a.values.parentAsset, (unresolvedParents.get(a.values.parentAsset) ?? 0) + 1);
  }
  for (const [text, n] of unresolvedParents) issues.push({ kind: "Unknown parent asset", sheet: "Component", row: text, message: `${n} asset(s) are part of "${text}", which is not among the assets.` });

  // Electrical distribution: boards in a tree, circuits; each board's distribution as a system.
  onProgress?.("Electrical distribution", 0, 0);
  const electrical = buildElectrical(registerAssets, relations, unresolvedFeeds, copyOf);
  const addSystem = (name: string, classification: string, type: string, origin: RegisterSystem["origin"], members: RegisterAsset[], sources: RegisterAsset[]) => {
    let display = name;
    for (let n = 2; systemMap.has(upper(display)); n++) display = `${name} (${n})`;
    const key = upper(display);
    const sys: RegisterSystem = {
      key,
      name: display,
      classification,
      type,
      members: members.map((m) => m.name),
      sources: sources.map((m) => m.name),
      ifcType: distributionSystemType(classification, type),
      guid: hashGuid(`system|${input.projectKey}|${key}`),
      origin,
      uniclass: systemUniclass(classification, name),
    };
    systemMap.set(key, sys);
    systems.push(sys);
    for (const m of members) m.systems.push({ name: sys.name, classification, type });
  };
  for (const b of electrical.boards) {
    const board = b.asset ? byAssetName.get(b.asset) : undefined;
    if (!board) continue;
    const fed = [...b.boards, ...b.items].map((n) => byAssetName.get(n)).filter((x): x is RegisterAsset => Boolean(x));
    if (fed.length === 0) continue;
    const lighting = fed.every((x) => x.traits.includes("lighting"));
    addSystem(`${board.name} distribution`, lighting ? "Lighting" : "Power", "Electrical distribution", "electrical", [board, ...fed], [board]);
  }
  // Fire alarm loops: a panel's devices by loop.
  const loops = new Map<string, RegisterAsset[]>();
  for (const a of registerAssets) {
    if (!a.values.firePanel) continue;
    const key = `${a.values.firePanel}\u0000${a.values.loop}`;
    loops.set(key, [...(loops.get(key) ?? []), a]);
  }
  for (const [key, devices] of [...loops].sort((x, y) => x[0].localeCompare(y[0], undefined, { numeric: true }))) {
    const [panelText, loop] = key.split("\u0000");
    const panel = findAsset(panelText);
    const label = panel?.name ?? panelText;
    addSystem(loop ? `${label} loop ${loop}` : `${label} fire alarm`, "Fire Alarm", "Fire alarm loop", "fire alarm", panel ? [panel, ...devices] : devices, panel ? [panel] : []);
  }
  systems.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));

  // 9. Zones: departments of rooms, and each equipment item's service area.
  const zones: RegisterZone[] = [];
  const departments = new Map<string, string[]>();
  for (const s of spaces) if (s.department) departments.set(s.department, [...(departments.get(s.department) ?? []), s.name]);
  for (const [name, list] of departments) zones.push({ name, category: "Department", description: `Rooms of ${name}`, spaces: list, guid: hashGuid(`zone|${input.projectKey}|department|${name}`) });
  // Fire zones: the rooms of the devices of a zone, and rooms that name their fire compartment.
  const fireZones = new Map<string, Set<string>>();
  const addFire = (zone: string, space: string) => fireZones.set(zone, (fireZones.get(zone) ?? new Set()).add(space));
  for (const a of registerAssets) if (a.values.fireZone && a.space) addFire(a.values.fireZone, a.space);
  for (const sp of spaces) if (sp.fireZone) addFire(sp.fireZone, sp.name);
  const zoneNames = new Set(zones.map((z) => z.name));
  for (const [zone, set] of fireZones) {
    let name = /zone|compartment|fz|fc/i.test(zone) ? zone : `Fire zone ${zone}`;
    if (zoneNames.has(name)) name = `${name} (fire)`;
    zoneNames.add(name);
    zones.push({ name, category: "Fire Zone", description: `Rooms of fire zone ${zone}`, spaces: [...set].sort(), guid: hashGuid(`zone|${input.projectKey}|fire|${zone}`) });
  }
  for (const a of registerAssets) {
    if (a.servingSpaces.length === 0 || a.serves.length === 0) continue;
    const kinds = relations.filter((r) => r.from === a.name).map((r) => (r.kind === "System" ? (systemMap.get(upper(r.via))?.classification ?? r.via) : r.kind));
    zones.push({ name: `${a.name} service area`, category: zoneCategory(kinds[0] ?? ""), description: `Spaces served by ${a.name}`, spaces: a.servingSpaces, guid: hashGuid(`zone|${input.projectKey}|served|${a.name}`) });
  }

  // 10. PPM jobs, where the model has them (per type).
  const jobs: RegisterJob[] = [];
  for (const t of types) {
    const v = t.values;
    if (!v.ppmTask && !v.ppmFrequency) continue;
    const freq = parseDuration(v.ppmFrequency, parseUnit(v.ppmFrequencyUnit));
    const dur = parseDuration(v.ppmDuration, "hour");
    jobs.push({
      name: v.ppmTask || `PPM ${t.name}`,
      typeName: t.name,
      description: v.ppmTask || `Planned maintenance of ${t.name}`,
      frequency: freq ? freq.value : null,
      frequencyUnit: freq ? unitWord(freq.unit) : "",
      duration: dur ? dur.value : null,
      durationUnit: dur ? unitWord(dur.unit) : "",
      taskNumber: "1",
    });
  }

  // 11. Floors
  const floors: RegisterFloor[] = storeys.map((s, i) => ({
    key: s.key,
    name: s.name,
    elevation: Math.round(s.elevation * 1000) / 1000,
    height: i + 1 < storeys.length ? Math.round((storeys[i + 1].elevation - s.elevation) * 1000) / 1000 : null,
    guid: hashGuid(`storey|${input.projectKey}|${s.key}|${s.name}`),
  }));

  // 11b. Location codes (site-building-floor-room), location paths and asset codes from the pattern.
  const codes = options.codes ?? { site: "", building: "", pattern: DEFAULT_CODE_PATTERN };
  const siteCode = codeToken(codes.site) || initials(input.names?.site ?? "");
  const buildingCode = codeToken(codes.building) || initials(input.names?.building ?? "");
  const floorCodes = floorCodesOf(storeys);
  const floorOrder = new Map(storeys.map((st, i) => [st.key, i]));
  const roomNames = new Map(spaces.map((sp) => [sp.name, sp.roomName]));
  for (const a of registerAssets) {
    const floor = floorCodes.get(a.floorKey) ?? "";
    a.locationCode = [siteCode, buildingCode, floor, codeToken(a.space)].filter(Boolean).join("-");
    const room = a.space ? `${a.space}${roomNames.get(a.space) && roomNames.get(a.space) !== a.space ? ` ${roomNames.get(a.space)}` : ""}` : "";
    a.locationPath = [input.names?.site ?? "", input.names?.building ?? "", a.floor, room].filter(Boolean).join(" > ");
  }
  const pattern = codes.pattern.trim() || DEFAULT_CODE_PATTERN;
  const render = (a: RegisterAsset, seq: string, seq4: string) =>
    tidyCode(
      pattern.replace(/\{(\w+)\}/g, (whole, token: string) => {
        switch (token.toLowerCase()) {
          case "site":
            return siteCode;
          case "building":
            return buildingCode;
          case "floor":
            return floorCodes.get(a.floorKey) ?? "";
          case "room":
          case "space":
            return codeToken(a.space);
          case "kind":
            return a.kindCode;
          case "discipline":
            return DISCIPLINE_CODES[a.discipline];
          case "system":
            return codeToken(a.systems[0]?.name ?? "");
          case "tag":
            return codeToken(a.values.tag);
          case "type":
            return codeToken(a.values.typeMark || a.type);
          case "category":
            return initials(a.category);
          case "seq":
            return seq;
          case "seq4":
            return seq4;
          default:
            return whole;
        }
      }),
    );
  const groups = new Map<string, RegisterAsset[]>();
  for (const a of registerAssets) {
    const prefix = render(a, "\u0001", "\u0001");
    groups.set(prefix, [...(groups.get(prefix) ?? []), a]);
  }
  const usedCodes = new Map<string, number>();
  let repeated = 0;
  for (const list of groups.values()) {
    list.sort((x, y) => (floorOrder.get(x.floorKey) ?? 999) - (floorOrder.get(y.floorKey) ?? 999) || x.space.localeCompare(y.space, undefined, { numeric: true }) || (x.values.tag || x.name).localeCompare(y.values.tag || y.name, undefined, { numeric: true }));
    list.forEach((a, n) => {
      let code = render(a, String(n + 1).padStart(3, "0"), String(n + 1).padStart(4, "0"));
      const seen = usedCodes.get(code) ?? 0;
      usedCodes.set(code, seen + 1);
      if (seen) {
        repeated++;
        code = `${code}-${seen + 1}`;
      }
      a.code = code;
    });
  }
  if (repeated) issues.push({ kind: "Asset codes repeated", sheet: "Component", row: pattern, message: `The asset code pattern gives ${repeated} code(s) more than once; they were numbered (-2, -3…). Add {seq} to the pattern for unique codes.` });

  // 12. Field sources and coverage; data issues.
  const sources: FieldSource[] = FIELDS.map((f) => {
    const total = f.level === "space" ? spaces.length : f.applies ? (applicable.get(f.id) ?? 0) : registerAssets.length;
    let filled = f.level === "space" ? countSpaceField(spaces, f.id) : registerAssets.filter((a) => a.values[f.id]).length;
    let note = "";
    if (f.id === "space") {
      // The room an asset is in, however it was found.
      filled = registerAssets.filter((a) => a.space).length;
      const by = (how: RegisterAsset["spaceSource"]) => registerAssets.filter((a) => a.spaceSource === how).length;
      note = [by("room tab") ? `room tabs for ${by("room tab")}` : "", by("geometry") ? `room geometry for ${by("geometry")}` : ""].filter(Boolean).join(", ");
    } else if (f.id === "classification") {
      const fromFamily = registerAssets.filter((a) => a.derived.includes("classification")).length;
      if (fromFamily) note = `family names for ${fromFamily}`;
    } else if (f.id === "warrantyEndDate" || f.id === "endOfLife") {
      const derived = registerAssets.filter((a) => a.derived.includes(f.id)).length;
      if (derived) note = `${f.id === "warrantyEndDate" ? "warranty start + duration" : "installation year + life"} for ${derived}`;
    }
    return { field: f.id, label: f.label, level: f.level, keys: keysOf[f.id], auto: auto[f.id], filled, total, ...(note ? { note } : {}) };
  });
  const tags = new Map<string, number>();
  for (const a of registerAssets) if (a.values.tag) tags.set(a.values.tag, (tags.get(a.values.tag) ?? 0) + 1);
  const duplicateTags = [...tags].filter(([, n]) => n > 1);
  if (duplicateTags.length) issues.push({ kind: "Duplicate tags", sheet: "Component", row: duplicateTags.slice(0, 5).map(([t]) => t).join(", "), message: `${duplicateTags.length} tag value(s) are used by more than one asset; names were made unique with the element id.` });
  const noSpace = registerAssets.filter((a) => !a.space).length;
  if (noSpace) issues.push({ kind: "Assets without a space", sheet: "Component", row: "", message: `${noSpace} of ${registerAssets.length} assets are in no known room (no room property, room tab or room geometry).` });

  const properties = [...assetKeyCounts].filter(([key]) => ownKey(key)).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
  const categories = [...categoryCounts].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count, asset: assetCategories.has(name) }));
  const technical = FIELDS.filter((f) => f.group === "technical" || (f.group === "electrical" && f.kind === "quantity")).map((f) => f.id);
  return {
    floors,
    spaces,
    types,
    assets: registerAssets,
    systems,
    zones,
    relations,
    jobs,
    sources,
    candidates,
    properties,
    categories,
    issues,
    electrical,
    stats: {
      elements,
      assets: registerAssets.length,
      types: types.length,
      spaces: spaces.length,
      spacesFromModel: spaces.filter((s) => s.source === "element").length,
      systems: systems.length,
      relations: relations.length,
      withSpace: registerAssets.length - noSpace,
      spaceByGeometry,
      boards: electrical.boards.filter((b) => b.inModel).length,
      circuits: electrical.circuits.length,
      fireDevices: registerAssets.filter((a) => a.discipline === "Fire & life safety" || a.compliance === "Fire safety" || a.compliance === "Emergency lighting").length,
      withTechnical: registerAssets.filter((a) => technical.some((id) => a.values[id])).length,
    },
  };
}

const DISCIPLINE_CODES: Record<Discipline, string> = {
  HVAC: "HV",
  Electrical: "EL",
  "Fire & life safety": "FP",
  Plumbing: "PH",
  "Low voltage": "ELV",
  "Vertical transport": "VT",
  Architectural: "AR",
  Specialist: "SP",
};

/** Letters and digits only, for codes ("SA 1" -> "SA1", "EV.504" stays). */
function codeToken(text: string): string {
  return (text ?? "").replace(/\s+/g, "").replace(/[^A-Za-z0-9.\-_]/g, "");
}


/** A short floor code from a storey name: "L03 - VIP Level" -> L03, "Level 2" -> L02, "Ground Floor" -> GF, "Basement 1" -> B1. */
export function floorCode(name: string): string {
  const t = (name ?? "").trim();
  if (!t) return "";
  let m = /^(?:level|lvl|floor|flr|storey|story)\s*[-_ ]?\s*(-?\d{1,3})\b/i.exec(t);
  if (m) return `L${m[1].replace("-", "B").padStart(2, "0")}`;
  m = /^(basement|cellar)\s*[-_ ]?\s*(\d{1,2})?/i.exec(t);
  if (m) return `B${m[2] ?? "1"}`;
  if (/^(ground|gf\b|g\b)/i.test(t)) return "GF";
  if (/^lower ground/i.test(t)) return "LG";
  if (/^upper ground/i.test(t)) return "UG";
  if (/^mezz/i.test(t)) return "M";
  if (/^roof/i.test(t)) return "RF";
  m = /^([A-Z]{1,3})\s*[-_]?\s*(\d{1,3})\b/.exec(t);
  if (m) return `${m[1]}${m[2]}`;
  m = /^(-?\d{1,3})\b/.exec(t);
  if (m) return `L${m[1].replace("-", "B").padStart(2, "0")}`;
  return initials(t);
}

/**
 * A code per floor, each its own: floors whose names read alike ("L03 - VIP Level" and "03 - Main Concourse",
 * from models that number their levels differently) add the initials of the rest of their name, or a letter.
 */
export function floorCodesOf(storeys: { key: string; name: string; elevation: number }[]): Map<string, string> {
  const codes = new Map(storeys.map((st) => [st.key, floorCode(st.name)]));
  const groups = new Map<string, typeof storeys>();
  for (const st of storeys) {
    const c = codes.get(st.key)!;
    if (c) groups.set(c, [...(groups.get(c) ?? []), st]);
  }
  const taken = new Set(codes.values());
  for (const [code, list] of groups) {
    if (list.length < 2) continue;
    const used = new Set<string>();
    [...list].sort((a, b) => a.elevation - b.elevation).forEach((st, i) => {
      const rest = st.name.replace(/^\s*(?:(?:level|lvl|floor|flr|storey|story)\s*[-_ ]?\s*|[A-Z]{1,3}\s*[-_]?\s*)?-?\d{1,3}\b/i, "").replace(/\b(?:level|floor|storey|story|lvl|flr)\b/gi, " ");
      let next = `${code}${initials(rest)}`;
      if (next === code || used.has(next) || taken.has(next)) next = `${code}${String.fromCharCode(65 + i)}`;
      used.add(next);
      codes.set(st.key, next);
    });
  }
  return codes;
}

/** Codes without doubled or trailing separators ("EA--AHU-001-" -> "EA-AHU-001"). */
function tidyCode(code: string): string {
  return code.replace(/([-_.\/ ])[-_.\/ ]+/g, "$1").replace(/^[-_.\/ ]+|[-_.\/ ]+$/g, "");
}

function countSpaceField(spaces: RegisterSpace[], field: string): number {
  return spaces.filter((s) => {
    switch (field) {
      case "spaceName":
        return Boolean(s.roomName);
      case "spaceNumber":
        return Boolean(s.number);
      case "spaceCategory":
        return Boolean(s.category);
      case "department":
        return Boolean(s.department);
      case "grossArea":
        return s.grossArea !== null;
      case "netArea":
        return s.netArea !== null;
      case "usableHeight":
        return s.height !== null;
      case "occupant":
        return Boolean(s.occupant);
      default:
        return false;
    }
  }).length;
}

// Units of a job's properties (format 2+), by key.
const unitCache = new WeakMap<SourceJob, Map<string, string>>();
function unitsOf(job: SourceJob): Map<string, string> {
  let map = unitCache.get(job);
  if (!map) {
    map = new Map();
    const p = job.propsData as { units?: Record<string, string>; strings: string[] } | null;
    if (p?.units) for (const [k, u] of Object.entries(p.units)) map.set(p.strings[Number(k)], u);
    unitCache.set(job, map);
  }
  return map;
}

function legacyOf(job: SourceJob): boolean {
  return (job.data.header.format ?? 1) < 2;
}

/** A room's triangles in metres (x, y, z per corner), or null without geometry. */
function roomTriangles(r: Entry, toMetres: Affine): Float64Array | null {
  const { job, k } = r;
  const parts: number[] = [];
  for (let j = job.elementStart[k]; j < job.elementStart[k + 1]; j++) {
    const f = job.fragOrder[j];
    const gi = job.data.fgeom[f];
    if (job.isLines(gi)) continue;
    const M = mul(toMetres, job.fragmentMatrix(f));
    const { positions, indices } = job.geometry(gi);
    for (let t = 0; t + 2 < indices.length; t += 3)
      for (let c = 0; c < 3; c++) {
        const v = indices[t + c] * 3;
        const x = positions[v],
          y = positions[v + 1],
          z = positions[v + 2];
        parts.push(M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7], M[8] * x + M[9] * y + M[10] * z + M[11]);
      }
    if (parts.length > 3_000_000) break;
  }
  return parts.length ? Float64Array.from(parts) : null;
}

function mul(a: Affine, b: Affine): Affine {
  const out = new Float64Array(12);
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 4],
      a1 = a[r * 4 + 1],
      a2 = a[r * 4 + 2],
      a3 = a[r * 4 + 3];
    out[r * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
    out[r * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
    out[r * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
    out[r * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3;
  }
  return out;
}

/** Floor area of a room solid: its downward-facing triangles, projected (m²). */
function footprintArea(T: Float64Array): number | null {
  let area = 0;
  for (let i = 0; i < T.length; i += 9) {
    const ux = T[i + 3] - T[i],
      uy = T[i + 4] - T[i + 1],
      vx = T[i + 6] - T[i],
      vy = T[i + 7] - T[i + 1];
    const z = ux * vy - uy * vx; // twice the signed projected area (z of the normal)
    const uz = T[i + 5] - T[i + 2],
      vz = T[i + 8] - T[i + 2];
    const len = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, z);
    if (len > 0 && z / len < -0.9) area += -z / 2;
  }
  return area > 0 ? Math.round(area * 100) / 100 : null;
}

export type { DurationUnit };

/** What the Convert page shows of a register: counts, field sources and coverage, categories, issues. */
export interface RegisterSummary {
  stats: AssetRegister["stats"];
  /** The first asset codes, to show what the pattern gives. */
  codes: string[];
  /** Tops of the electrical trees with their board counts. */
  trees: { name: string; boards: number; items: number }[];
  sources: FieldSource[];
  candidates: Record<string, PropertyColumn[]>;
  properties: PropertyColumn[];
  categories: AssetRegister["categories"];
  issues: RegisterIssue[];
  issueCount: number;
  jobs: number;
  zones: number;
  derived: number;
}

export function summarise(register: AssetRegister): RegisterSummary {
  const candidates: Record<string, PropertyColumn[]> = {};
  for (const [field, list] of Object.entries(register.candidates)) candidates[field] = list.slice(0, 12);
  const treeBoards = (root: string) => register.electrical.boards.filter((b) => b.path[0] === root);
  return {
    stats: register.stats,
    codes: register.assets.slice(0, 4).map((a) => a.code),
    trees: register.electrical.roots.slice(0, 12).map((name) => ({ name, boards: treeBoards(name).length, items: register.electrical.boards.find((b) => b.name === name)?.downstream ?? 0 })),
    sources: register.sources,
    candidates,
    properties: register.properties.slice(0, 400),
    categories: register.categories,
    issues: register.issues.slice(0, 60),
    issueCount: register.issues.length,
    jobs: register.jobs.length,
    zones: register.zones.length,
    derived: register.assets.filter((a) => a.derived.length).length,
  };
}
