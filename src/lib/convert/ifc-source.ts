// IFC models as a source of the asset register and the facility workspace.
//
// An IFC file is read with web-ifc into the same shape as a viewer extract
// (a job: node tree, fragments, property table), so the register, COBie and
// the workspace work on IFC models exactly as on Revit and Navisworks ones:
//
//   - Elements: every IfcElement except pipe, duct and cable runs and their
//     fittings (IfcFlowSegment, IfcFlowFitting), openings and other feature
//     elements, virtual elements and small components (fasteners, rebar,
//     hangers). Equipment, terminals, devices, doors, furniture, transport and
//     proxies carry all their properties and the box of their geometry; the
//     rest (walls, slabs…) only what identifies them, for the category counts.
//   - Rooms: IfcSpace, with its shape, so assets are placed in rooms by
//     geometry when the model does not say which room they are in.
//   - Properties: "<property set>/<name>" for the element's own sets and
//     quantities, "Type/<name>" for its type's; "Element/…" and "Item/…" keys
//     carry the category, family, type, level, room, systems and GlobalId the
//     register reads, unless the model's own properties already do (Revit's
//     property sets, or the IFC files bim-os writes itself).
//   - Positions in metres, Z up, in the file's own coordinates.

import * as WEBIFC from "web-ifc";
import { ifcHeaderProblem } from "@/lib/collection/ifc-scan.mjs";
import { prettyCategory } from "@/lib/utils/ifc-names";
import type { JobData, JobHeader, PropsData, RawSourceJob } from "./bundle";
import type { StoreyDef } from "./storeys";

type Api = WEBIFC.IfcAPI;
type ProgressFn = (phase: string, done: number, total: number) => void;
type Scalar = string | number;
/** A web-ifc line: attributes by name (typed values, references, lists). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Line = Record<string, any>;

export interface IfcSourceInfo {
  /** Job name in the conversion worker. */
  job: string;
  file: string;
  schema: string;
  /** Names the model gives the project, site and building, and the building's address. */
  project: string;
  site: string;
  building: string;
  address: string;
  /** Currency of the model's monetary unit ("AED", "GBP"…), when it has one. */
  currency: string;
  /** Storeys of the model, lowest first (elevations in metres). */
  storeys: StoreyDef[];
  counts: {
    /** Elements read (with full properties: equipment, devices, doors, furniture…). */
    elements: number;
    detailed: number;
    spaces: number;
    /** Pipe, duct and cable runs and fittings left out. */
    runs: number;
    /** Openings, virtual elements and small components left out. */
    other: number;
    systems: number;
  };
  seconds: number;
}

export interface IfcSource {
  job: RawSourceJob;
  info: IfcSourceInfo;
}

// ---------------------------------------------------------------------------
// IFC classes

const TYPE_CODES = WEBIFC as unknown as Record<string, number | undefined>;

/** Elements that carry all their properties (the ones that can be assets). */
const DETAILED_SUPERTYPES = ["IFCDISTRIBUTIONELEMENT", "IFCTRANSPORTELEMENT", "IFCFURNISHINGELEMENT", "IFCBUILDINGELEMENTPROXY", "IFCDOOR", "IFCELECTRICALELEMENT", "IFCEQUIPMENTELEMENT", "IFCELEMENTASSEMBLY"];
/** Runs and fittings: thousands of them, never assets. */
const RUN_SUPERTYPES = ["IFCFLOWSEGMENT", "IFCFLOWFITTING"];
/** Not building elements in their own right. */
const SKIPPED_SUPERTYPES = ["IFCFEATUREELEMENT", "IFCVIRTUALELEMENT", "IFCELEMENTCOMPONENT", "IFCBUILDINGELEMENTCOMPONENT", "IFCDISCRETEACCESSORY", "IFCFASTENER", "IFCMECHANICALFASTENER", "IFCREINFORCINGELEMENT", "IFCBUILDINGELEMENTPART"];
const SYSTEM_CLASSES = new Set(["IFCSYSTEM", "IFCDISTRIBUTIONSYSTEM", "IFCDISTRIBUTIONCIRCUIT", "IFCBUILDINGSYSTEM", "IFCBUILTSYSTEM", "IFCELECTRICALCIRCUIT"]);
/** Distribution system types in words. */
const SYSTEM_WORDS: Record<string, string> = {
  AIRCONDITIONING: "Air conditioning",
  AUDIOVISUAL: "Audio visual",
  CHILLEDWATER: "Chilled water",
  COMPRESSEDAIR: "Compressed air",
  CONDENSERWATER: "Condenser water",
  DOMESTICCOLDWATER: "Domestic cold water",
  DOMESTICHOTWATER: "Domestic hot water",
  EXHAUST: "Exhaust air",
  FIREPROTECTION: "Fire protection",
  LIGHTNINGPROTECTION: "Lightning protection",
  MUNICIPALSOLIDWASTE: "Municipal solid waste",
  POWERGENERATION: "Power generation",
  WASTEWATER: "Waste water",
  WATERSUPPLY: "Water supply",
  TV: "TV",
};
/** Generic occurrences (IFC2x3 style) whose type says what they are. */
const GENERIC = new Set([
  "IFCFLOWTERMINAL", "IFCFLOWCONTROLLER", "IFCFLOWMOVINGDEVICE", "IFCFLOWSTORAGEDEVICE", "IFCFLOWTREATMENTDEVICE", "IFCENERGYCONVERSIONDEVICE",
  "IFCDISTRIBUTIONCONTROLELEMENT", "IFCDISTRIBUTIONFLOWELEMENT", "IFCDISTRIBUTIONELEMENT", "IFCELECTRICALELEMENT", "IFCEQUIPMENTELEMENT", "IFCBUILDINGELEMENTPROXY",
]);

/** Revit categories for IFC classes (the register's kinds, default asset categories and COBie read Revit categories). */
const CATEGORY_BY_CLASS: Record<string, string> = {
  IFCAIRTERMINAL: "Air Terminals",
  IFCAIRTERMINALBOX: "Mechanical Equipment",
  IFCAIRTOAIRHEATRECOVERY: "Mechanical Equipment",
  IFCBOILER: "Mechanical Equipment",
  IFCBURNER: "Mechanical Equipment",
  IFCCHILLER: "Mechanical Equipment",
  IFCCOIL: "Mechanical Equipment",
  IFCCOMPRESSOR: "Mechanical Equipment",
  IFCCONDENSER: "Mechanical Equipment",
  IFCCOOLEDBEAM: "Mechanical Equipment",
  IFCCOOLINGTOWER: "Mechanical Equipment",
  IFCENGINE: "Mechanical Equipment",
  IFCEVAPORATIVECOOLER: "Mechanical Equipment",
  IFCEVAPORATOR: "Mechanical Equipment",
  IFCFAN: "Mechanical Equipment",
  IFCHEATEXCHANGER: "Mechanical Equipment",
  IFCHUMIDIFIER: "Mechanical Equipment",
  IFCPUMP: "Mechanical Equipment",
  IFCSPACEHEATER: "Mechanical Equipment",
  IFCTANK: "Mechanical Equipment",
  IFCTUBEBUNDLE: "Mechanical Equipment",
  IFCUNITARYEQUIPMENT: "Mechanical Equipment",
  IFCVIBRATIONISOLATOR: "Mechanical Equipment",
  IFCDAMPER: "Duct Accessories",
  IFCDUCTSILENCER: "Duct Accessories",
  IFCFILTER: "Duct Accessories",
  IFCFLOWMETER: "Pipe Accessories",
  IFCVALVE: "Pipe Accessories",
  IFCFLOWINSTRUMENT: "Pipe Accessories",
  IFCSANITARYTERMINAL: "Plumbing Fixtures",
  IFCWASTETERMINAL: "Plumbing Fixtures",
  IFCSTACKTERMINAL: "Plumbing Fixtures",
  IFCINTERCEPTOR: "Plumbing Equipment",
  IFCDISTRIBUTIONCHAMBERELEMENT: "Plumbing Equipment",
  IFCFIRESUPPRESSIONTERMINAL: "Fire Protection",
  IFCMEDICALDEVICE: "Medical Equipment",
  IFCSOLARDEVICE: "Electrical Equipment",
  IFCACTUATOR: "Mechanical Control Devices",
  IFCCONTROLLER: "Mechanical Control Devices",
  IFCSENSOR: "Mechanical Control Devices",
  IFCUNITARYCONTROLELEMENT: "Mechanical Control Devices",
  IFCALARM: "Fire Alarm Devices",
  IFCPROTECTIVEDEVICETRIPPINGUNIT: "Electrical Equipment",
  IFCAUDIOVISUALAPPLIANCE: "Audio Visual Devices",
  IFCCOMMUNICATIONSAPPLIANCE: "Communication Devices",
  IFCELECTRICAPPLIANCE: "Electrical Fixtures",
  IFCELECTRICDISTRIBUTIONBOARD: "Electrical Equipment",
  IFCELECTRICDISTRIBUTIONPOINT: "Electrical Equipment",
  IFCELECTRICFLOWSTORAGEDEVICE: "Electrical Equipment",
  IFCELECTRICGENERATOR: "Electrical Equipment",
  IFCELECTRICMOTOR: "Electrical Equipment",
  IFCELECTRICTIMECONTROL: "Electrical Equipment",
  IFCMOTORCONNECTION: "Electrical Equipment",
  IFCPROTECTIVEDEVICE: "Electrical Equipment",
  IFCTRANSFORMER: "Electrical Equipment",
  IFCELECTRICALELEMENT: "Electrical Equipment",
  IFCLAMP: "Lighting Fixtures",
  IFCLIGHTFIXTURE: "Lighting Fixtures",
  IFCOUTLET: "Electrical Fixtures",
  IFCSWITCHINGDEVICE: "Lighting Devices",
  IFCTRANSPORTELEMENT: "Vertical Circulation",
  IFCEQUIPMENTELEMENT: "Specialty Equipment",
  IFCFLOWTERMINAL: "Mechanical Equipment",
  IFCFLOWCONTROLLER: "Pipe Accessories",
  IFCFLOWMOVINGDEVICE: "Mechanical Equipment",
  IFCFLOWSTORAGEDEVICE: "Mechanical Equipment",
  IFCFLOWTREATMENTDEVICE: "Mechanical Equipment",
  IFCENERGYCONVERSIONDEVICE: "Mechanical Equipment",
  IFCDISTRIBUTIONFLOWELEMENT: "Mechanical Equipment",
  IFCDISTRIBUTIONELEMENT: "Mechanical Equipment",
  IFCDISTRIBUTIONCONTROLELEMENT: "Mechanical Control Devices",
  IFCFURNITURE: "Furniture",
  IFCFURNISHINGELEMENT: "Furniture",
  IFCSYSTEMFURNITUREELEMENT: "Furniture Systems",
  IFCDOOR: "Doors",
  IFCDOORSTANDARDCASE: "Doors",
  IFCWINDOW: "Windows",
  IFCWINDOWSTANDARDCASE: "Windows",
  IFCWALL: "Walls",
  IFCWALLSTANDARDCASE: "Walls",
  IFCWALLELEMENTEDCASE: "Walls",
  IFCCURTAINWALL: "Walls",
  IFCSLAB: "Floors",
  IFCSLABSTANDARDCASE: "Floors",
  IFCSLABELEMENTEDCASE: "Floors",
  IFCROOF: "Roofs",
  IFCCOVERING: "Generic Models",
  IFCBEAM: "Structural Framing",
  IFCBEAMSTANDARDCASE: "Structural Framing",
  IFCCOLUMN: "Structural Columns",
  IFCCOLUMNSTANDARDCASE: "Structural Columns",
  IFCMEMBER: "Structural Framing",
  IFCMEMBERSTANDARDCASE: "Structural Framing",
  IFCPLATE: "Generic Models",
  IFCPLATESTANDARDCASE: "Generic Models",
  IFCRAILING: "Railings",
  IFCSTAIR: "Stairs",
  IFCSTAIRFLIGHT: "Stairs",
  IFCRAMP: "Ramps",
  IFCRAMPFLIGHT: "Ramps",
  IFCFOOTING: "Structural Foundations",
  IFCPILE: "Structural Foundations",
  IFCCHIMNEY: "Generic Models",
  IFCSHADINGDEVICE: "Generic Models",
  IFCBUILDINGELEMENTPROXY: "Generic Models",
  IFCGEOGRAPHICELEMENT: "Site",
  IFCCIVILELEMENT: "Site",
  IFCELEMENTASSEMBLY: "Assemblies",
};

/** The Revit category for an IFC class and predefined type. */
export function ifcCategory(cls: string, predefined: string): string {
  const c = cls.toUpperCase();
  const p = predefined.toUpperCase();
  switch (c) {
    case "IFCFIRESUPPRESSIONTERMINAL":
      return /SPRINKLER/.test(p) ? "Sprinklers" : "Fire Protection";
    case "IFCSENSOR":
      if (/SMOKE|HEAT|FIRE|FLAME/.test(p)) return "Fire Alarm Devices";
      if (/MOVEMENT|CONTACT|IDENTIFIER/.test(p)) return "Security Devices";
      return "Mechanical Control Devices";
    case "IFCUNITARYCONTROLELEMENT":
      return /ALARMPANEL|INDICATORPANEL|MIMICPANEL/.test(p) ? "Fire Alarm Devices" : "Mechanical Control Devices";
    case "IFCAUDIOVISUALAPPLIANCE":
      return p === "CAMERA" ? "Security Devices" : "Audio Visual Devices";
    case "IFCCOMMUNICATIONSAPPLIANCE":
      return /ANTENNA|FAX|TELEPHONE/.test(p) || !p ? "Communication Devices" : "Data Devices";
    case "IFCOUTLET":
      if (p === "DATAOUTLET") return "Data Devices";
      if (p === "TELEPHONEOUTLET") return "Telephone Devices";
      if (p === "AUDIOVISUALOUTLET") return "Audio Visual Devices";
      if (p === "COMMUNICATIONSOUTLET") return "Communication Devices";
      return "Electrical Fixtures";
    case "IFCSWITCHINGDEVICE":
      if (p === "KEYPAD") return "Security Devices";
      if (/CONTACTOR|STARTER|DISCONNECTOR|EMERGENCYSTOP|RELAY/.test(p)) return "Electrical Equipment";
      return "Lighting Devices";
    case "IFCFLOWMETER":
      return p === "ENERGYMETER" ? "Electrical Equipment" : "Pipe Accessories";
    case "IFCFILTER":
      return /WATER|OIL|STRAINER|COMPRESSED/.test(p) ? "Pipe Accessories" : "Duct Accessories";
    case "IFCSOLARDEVICE":
      return p === "SOLARCOLLECTOR" ? "Mechanical Equipment" : "Electrical Equipment";
    case "IFCSLAB":
    case "IFCSLABSTANDARDCASE":
    case "IFCSLABELEMENTEDCASE":
      return p === "ROOF" ? "Roofs" : "Floors";
    case "IFCCOVERING":
      if (p === "CEILING") return "Ceilings";
      if (p === "FLOORING") return "Floors";
      if (p === "ROOFING") return "Roofs";
      if (p === "CLADDING") return "Walls";
      return "Generic Models";
    case "IFCMEMBER":
    case "IFCMEMBERSTANDARDCASE":
      return p === "MULLION" ? "Curtain Wall Mullions" : "Structural Framing";
    case "IFCPLATE":
    case "IFCPLATESTANDARDCASE":
      return p === "CURTAIN_PANEL" ? "Curtain Panels" : "Generic Models";
    case "IFCTRANSPORTELEMENT":
      return /ELEVATOR|ESCALATOR|MOVINGWALKWAY|LIFT/.test(p) || !p ? "Vertical Circulation" : "Specialty Equipment";
  }
  return CATEGORY_BY_CLASS[c] ?? "Generic Models";
}

// Keys the register reads category, family, type and level from (model.ts), in its order.
const CATEGORY_KEYS = ["Element/Category", "Revit Type/Category", "__category__/Category", "Item/Category", "Identity Data/Category", "Other/Category"];
const FAMILY_KEYS = ["Element/Family", "Revit Type/Family Name", "Identity Data/Family Name", "Other/Family", "Identity Data/Family"];
const TYPE_KEYS = ["Element/Type", "Revit Type/Type Name", "Identity Data/Type Name", "Other/Type", "Identity Data/Type"];
const LEVEL_KEYS = ["Element/Level", "Constraints/Level", "Constraints/Base Constraint", "Constraints/Reference Level", "Constraints/Schedule Level", "Constraints/Base Level", "Element/Base Constraint"];
/** Written by bim-os into its own IFC files: the source model's category, family, type and level. */
const OWN_SOURCE = "IFCStudio_Source";
/**
 * What bim-os worked out and wrote into its own IFC files (codes, kinds, locations, relations, the
 * electrical tree): left out when such a file is read back, since the register works it out again and
 * would otherwise take its last answers for stated facts.
 */
const OWN_DERIVED: Record<string, Set<string> | "all"> = {
  IFCStudio_Asset: new Set(["AssetName", "AssetCode", "AssetKind", "KindCode", "Discipline", "Floor", "SpaceName", "LocationCode", "LocationPath", "Parts", "Systems", "ServedBy", "Serves", "ServingSpaces", "EndOfLife", "ComplianceGroupSuggested", "UniclassPrSuggested"]),
  IFCStudio_Electrical: new Set(["BoardLevel", "FeedPath", "BoardsFed", "Circuits", "ItemsDownstream", "Connected load, sum of fed items (kVA)"]),
  IFCStudio_Space: new Set(["Assets", "ServedBy", "Source"]),
  IFCStudio_Provenance: "all",
};
/** Systems bim-os derives (a board's circuits, a fire alarm panel's loops), as its IFC files describe them. */
const OWN_DERIVED_SYSTEM = /(^|\/\s*)(Electrical distribution|Fire alarm loop)$/;

// ---------------------------------------------------------------------------
// Units

const PREFIX: Record<string, [number, string]> = {
  EXA: [1e18, "E"],
  PETA: [1e15, "P"],
  TERA: [1e12, "T"],
  GIGA: [1e9, "G"],
  MEGA: [1e6, "M"],
  KILO: [1e3, "k"],
  HECTO: [1e2, "h"],
  DECA: [1e1, "da"],
  DECI: [1e-1, "d"],
  CENTI: [1e-2, "c"],
  MILLI: [1e-3, "m"],
  MICRO: [1e-6, "µ"],
  NANO: [1e-9, "n"],
  PICO: [1e-12, "p"],
  FEMTO: [1e-15, "f"],
  ATTO: [1e-18, "a"],
};

const SI_SYMBOL: Record<string, string> = {
  METRE: "m",
  SQUARE_METRE: "m2",
  CUBIC_METRE: "m3",
  GRAM: "g",
  SECOND: "s",
  WATT: "W",
  PASCAL: "Pa",
  VOLT: "V",
  AMPERE: "A",
  KELVIN: "K",
  DEGREE_CELSIUS: "°C",
  LUMEN: "lm",
  LUX: "lx",
  HERTZ: "Hz",
  JOULE: "J",
  NEWTON: "N",
  OHM: "Ω",
  RADIAN: "rad",
  STERADIAN: "sr",
  COULOMB: "C",
  FARAD: "F",
  HENRY: "H",
  SIEMENS: "S",
  TESLA: "T",
  WEBER: "Wb",
  CANDELA: "cd",
  MOLE: "mol",
  BECQUEREL: "Bq",
  GRAY: "Gy",
  SIEVERT: "Sv",
};

/** Measure types and the project unit they are given in. */
const MEASURE_UNIT: Record<string, string> = {
  IFCLENGTHMEASURE: "LENGTHUNIT",
  IFCPOSITIVELENGTHMEASURE: "LENGTHUNIT",
  IFCNONNEGATIVELENGTHMEASURE: "LENGTHUNIT",
  IFCAREAMEASURE: "AREAUNIT",
  IFCVOLUMEMEASURE: "VOLUMEUNIT",
  IFCMASSMEASURE: "MASSUNIT",
  IFCPLANEANGLEMEASURE: "PLANEANGLEUNIT",
  IFCPOSITIVEPLANEANGLEMEASURE: "PLANEANGLEUNIT",
  IFCTIMEMEASURE: "TIMEUNIT",
  IFCPOWERMEASURE: "POWERUNIT",
  IFCPRESSUREMEASURE: "PRESSUREUNIT",
  IFCELECTRICVOLTAGEMEASURE: "ELECTRICVOLTAGEUNIT",
  IFCELECTRICCURRENTMEASURE: "ELECTRICCURRENTUNIT",
  IFCTHERMODYNAMICTEMPERATUREMEASURE: "THERMODYNAMICTEMPERATUREUNIT",
  IFCLUMINOUSFLUXMEASURE: "LUMINOUSFLUXUNIT",
  IFCILLUMINANCEMEASURE: "ILLUMINANCEUNIT",
  IFCLUMINOUSINTENSITYMEASURE: "LUMINOUSINTENSITYUNIT",
  IFCFREQUENCYMEASURE: "FREQUENCYUNIT",
  IFCENERGYMEASURE: "ENERGYUNIT",
  IFCFORCEMEASURE: "FORCEUNIT",
  IFCELECTRICRESISTANCEMEASURE: "ELECTRICRESISTANCEUNIT",
  IFCVOLUMETRICFLOWRATEMEASURE: "VOLUMETRICFLOWRATEUNIT",
  IFCMASSFLOWRATEMEASURE: "MASSFLOWRATEUNIT",
  IFCLINEARVELOCITYMEASURE: "LINEARVELOCITYUNIT",
};

/** SI units of the measures, when the project assigns none. */
const DEFAULT_SYMBOL: Record<string, string> = {
  LENGTHUNIT: "m",
  AREAUNIT: "m2",
  VOLUMEUNIT: "m3",
  MASSUNIT: "kg",
  PLANEANGLEUNIT: "rad",
  TIMEUNIT: "s",
  POWERUNIT: "W",
  PRESSUREUNIT: "Pa",
  ELECTRICVOLTAGEUNIT: "V",
  ELECTRICCURRENTUNIT: "A",
  THERMODYNAMICTEMPERATUREUNIT: "K",
  LUMINOUSFLUXUNIT: "lm",
  ILLUMINANCEUNIT: "lx",
  LUMINOUSINTENSITYUNIT: "cd",
  FREQUENCYUNIT: "Hz",
  ENERGYUNIT: "J",
  FORCEUNIT: "N",
  ELECTRICRESISTANCEUNIT: "Ω",
  VOLUMETRICFLOWRATEUNIT: "m3/s",
  MASSFLOWRATEUNIT: "kg/s",
  LINEARVELOCITYUNIT: "m/s",
};

/** The short symbol of a conversion-based unit ("FOOT" -> "ft"). */
function conversionSymbol(name: string, unitType: string): string {
  const n = name.toLowerCase();
  switch (unitType) {
    case "LENGTHUNIT":
      return /foot|feet/.test(n) ? "ft" : /inch/.test(n) ? "in" : /yard/.test(n) ? "yd" : /mile/.test(n) ? "mi" : name;
    case "AREAUNIT":
      return /foot|feet/.test(n) ? "ft2" : /inch/.test(n) ? "in2" : /acre/.test(n) ? "acre" : name;
    case "VOLUMEUNIT":
      return /foot|feet/.test(n) ? "ft3" : /gallon/.test(n) ? "gal" : /litre|liter/.test(n) ? "L" : name;
    case "MASSUNIT":
      return /pound/.test(n) ? "lb" : /tonne|ton/.test(n) ? "t" : name;
    case "PLANEANGLEUNIT":
      return /degree/.test(n) ? "°" : name;
    case "THERMODYNAMICTEMPERATUREUNIT":
      return /fahrenheit/.test(n) ? "°F" : /celsius/.test(n) ? "°C" : name;
    case "POWERUNIT":
      return /btu/.test(n) ? "btu/h" : /horse/.test(n) ? "hp" : /ton/.test(n) ? "tr" : name;
    case "PRESSUREUNIT":
      return /psi|pound/.test(n) ? "psi" : /water/.test(n) ? "inwg" : /bar/.test(n) ? "bar" : name;
    case "TIMEUNIT":
      return /hour/.test(n) ? "h" : /minute/.test(n) ? "min" : /day/.test(n) ? "d" : name;
  }
  return name;
}

interface UnitInfo {
  unitType: string;
  symbol: string;
  /** Factor to the SI base unit, when known (metres for lengths). */
  scale: number | null;
  currency?: string;
}

// ---------------------------------------------------------------------------
// Values

// web-ifc references are {type: 5, value: id}; typed values {type, value, name}.
const REF = 5;
const ENUM = 3;

function ref(x: unknown): number {
  const o = x as { type?: number; value?: unknown } | null;
  return o && typeof o === "object" && o.type === REF && typeof o.value === "number" ? o.value : 0;
}

function refs(x: unknown): number[] {
  if (Array.isArray(x)) {
    const out: number[] = [];
    for (const item of x) {
      const id = ref(item);
      if (id) out.push(id);
    }
    return out;
  }
  const id = ref(x);
  return id ? [id] : [];
}

function text(x: unknown): string {
  if (x === null || x === undefined) return "";
  if (typeof x === "string") return x.trim();
  if (typeof x === "object") {
    const v = (x as { value?: unknown }).value;
    return v === null || v === undefined ? "" : String(v).trim();
  }
  return String(x).trim();
}

function num(x: unknown): number | null {
  const v = x !== null && typeof x === "object" ? (x as { value?: unknown }).value : x;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function enumText(x: unknown): string {
  const o = x as { type?: number; value?: unknown } | null;
  if (o && typeof o === "object" && o.type === ENUM) return String(o.value ?? "").replace(/^\.|\.$/g, "");
  return text(x);
}

/** A property value: text, a number, or "Yes" / "No"; null when empty or unknown. */
function scalar(x: unknown): Scalar | null {
  if (x === null || x === undefined) return null;
  const o = typeof x === "object" ? (x as { value?: unknown; name?: unknown }) : null;
  const name = o && typeof o.name === "string" ? o.name : "";
  const raw = o ? o.value : x;
  if (name === "IFCBOOLEAN" || name === "IFCLOGICAL" || typeof raw === "boolean") {
    if (raw === true || raw === "T" || raw === ".T.") return "Yes";
    if (raw === false || raw === "F" || raw === ".F.") return "No";
    return null;
  }
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t ? t : null;
  }
  return null;
}

const measureName = (x: unknown): string => (x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string" ? (x as { name: string }).name : "");

// ---------------------------------------------------------------------------
// Placements (3x4 row-major affine, model length units)

type M34 = Float64Array;
const IDENTITY: M34 = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);

function mul(a: M34, b: M34): M34 {
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

function normalise(v: number[]): number[] | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

// ---------------------------------------------------------------------------
// Reading

/**
 * Reads an open web-ifc model into a job for the conversion worker. `jobName` names the job (and its
 * elements' keys), `fileName` the file as people know it.
 */
export function readIfcModel(api: Api, modelID: number, jobName: string, fileName: string, onProgress?: ProgressFn): IfcSource {
  const started = Date.now();
  const progress: ProgressFn = onProgress ?? (() => undefined);
  const line = (id: number): Line => api.GetLine(modelID, id, false) as Line;
  const classOf = (id: number): string => {
    try {
      return String(api.GetNameFromTypeCode(api.GetLineType(modelID, id)) ?? "").toUpperCase();
    } catch {
      return "";
    }
  };
  const ids = (name: string): number[] => {
    const code = TYPE_CODES[name];
    if (typeof code !== "number") return [];
    try {
      const v = api.GetLineIDsWithType(modelID, code, true);
      const out = new Array<number>(v.size());
      for (let i = 0; i < out.length; i++) out[i] = v.get(i);
      return out;
    } catch {
      return [];
    }
  };
  const idSet = (names: string[]) => {
    const set = new Set<number>();
    for (const name of names) for (const id of ids(name)) set.add(id);
    return set;
  };
  const schema = (() => {
    try {
      return api.GetModelSchema(modelID) ?? "";
    } catch {
      return "";
    }
  })();

  // -------------------------------------------------------------------------
  // Units

  const unitCache = new Map<number, UnitInfo>();
  const describeUnit = (id: number, depth = 0): UnitInfo => {
    const cached = unitCache.get(id);
    if (cached) return cached;
    let info: UnitInfo = { unitType: "", symbol: "", scale: null };
    if (id && depth < 6) {
      const l = line(id);
      const cls = classOf(id);
      if (cls === "IFCSIUNIT") {
        const name = enumText(l.Name);
        const unitType = enumText(l.UnitType);
        const [factor, p] = PREFIX[enumText(l.Prefix)] ?? [1, ""];
        let symbol = `${p}${SI_SYMBOL[name] ?? name.toLowerCase()}`;
        let scale = factor;
        if (name === "SQUARE_METRE") {
          symbol = `${p}m2`;
          scale = factor * factor;
        } else if (name === "CUBIC_METRE") {
          symbol = p === "d" ? "L" : `${p}m3`;
          scale = factor ** 3;
        } else if (name === "GRAM") scale = factor / 1000;
        info = { unitType, symbol, scale };
      } else if (cls === "IFCCONVERSIONBASEDUNIT" || cls === "IFCCONVERSIONBASEDUNITWITHOFFSET") {
        const unitType = enumText(l.UnitType);
        const symbol = conversionSymbol(text(l.Name), unitType);
        let scale: number | null = null;
        const factorId = ref(l.ConversionFactor);
        if (factorId) {
          const mw = line(factorId);
          const v = num(mw.ValueComponent);
          const base = ref(mw.UnitComponent) ? describeUnit(ref(mw.UnitComponent), depth + 1) : null;
          if (v !== null && base?.scale) scale = v * base.scale;
        }
        if (scale === null && unitType === "LENGTHUNIT") scale = symbol === "ft" ? 0.3048 : symbol === "in" ? 0.0254 : null;
        info = { unitType, symbol, scale };
      } else if (cls === "IFCDERIVEDUNIT") {
        const top: string[] = [];
        const bottom: string[] = [];
        for (const e of refs(l.Elements)) {
          const el = line(e);
          const exp = num(el.Exponent) ?? 1;
          const u = describeUnit(ref(el.Unit), depth + 1);
          if (!u.symbol || exp === 0) continue;
          const s = Math.abs(exp) > 1 ? `${u.symbol}${Math.abs(exp)}` : u.symbol;
          (exp > 0 ? top : bottom).push(s);
        }
        const symbol = top.length ? `${top.join("·")}${bottom.length ? `/${bottom.join("/")}` : ""}` : "";
        info = { unitType: enumText(l.UnitType), symbol: symbol.replace(/^dm3(?=\/|$)/, "L"), scale: null };
      } else if (cls === "IFCMONETARYUNIT") {
        info = { unitType: "MONETARYUNIT", symbol: "", scale: null, currency: enumText(l.Currency) };
      }
    }
    unitCache.set(id, info);
    return info;
  };

  const projectId = ids("IFCPROJECT")[0] ?? 0;
  const project = projectId ? line(projectId) : null;
  const projectSymbols = new Map<string, string>();
  let lengthScale = 1;
  let currency = "";
  const assignment = project ? ref(project.UnitsInContext) : 0;
  for (const id of assignment ? refs(line(assignment).Units) : []) {
    const u = describeUnit(id);
    if (u.unitType === "LENGTHUNIT" && u.scale) lengthScale = u.scale;
    if (u.unitType && u.symbol) projectSymbols.set(u.unitType, u.symbol);
    if (u.currency) currency = u.currency;
  }
  const symbolFor = (measure: string, unitRef: number): string => {
    if (unitRef) return describeUnit(unitRef).symbol;
    const unitType = MEASURE_UNIT[measure];
    return unitType ? (projectSymbols.get(unitType) ?? DEFAULT_SYMBOL[unitType] ?? "") : "";
  };

  // -------------------------------------------------------------------------
  // Strings and numbers of the property table

  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const sidx = (s: string): number => {
    let i = stringIndex.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      stringIndex.set(s, i);
    }
    return i;
  };
  const numbers: number[] = [];
  const numberIndex = new Map<number, number>();
  const nidx = (n: number): number => {
    let i = numberIndex.get(n);
    if (i === undefined) {
      numbers.push(n);
      i = numbers.length;
      numberIndex.set(n, i);
    }
    return -i;
  };
  const vidx = (v: Scalar): number => (typeof v === "number" ? nidx(v) : sidx(v));
  const valueOfIndex = (v: number): Scalar => (v >= 0 ? strings[v] : numbers[-v - 1]);
  const units: Record<string, string> = {};
  const keyUnit = (k: number, unit: string) => {
    if (unit && units[k] === undefined) units[k] = unit;
  };

  /** A value with its unit, temperatures in °C. */
  const measured = (value: Scalar, measure: string, unitRef: number): [Scalar, string] => {
    if (typeof value !== "number") return [value, ""];
    const unit = symbolFor(measure, unitRef);
    if (measure === "IFCTHERMODYNAMICTEMPERATUREMEASURE" || unit === "K" || unit === "°F") {
      // Absolute temperatures in kelvin or Fahrenheit, as °C (a small kelvin value is a difference).
      if (unit === "K" && value > 150) return [Math.round((value - 273.15) * 1000) / 1000, "°C"];
      if (unit === "°F") return [Math.round((((value - 32) * 5) / 9) * 1000) / 1000, "°C"];
    }
    return [value, unit];
  };

  // -------------------------------------------------------------------------
  // Property sets: flat [key, value, key, value…] lists, read once per set

  const psetCache = new Map<number, number[]>();
  const typeSetCache = new Map<number, number[]>();
  const groupName = (name: string) => (name || "Properties").replace(/\//g, "-").slice(0, 120);

  const readProperty = (id: number, group: string, prefix: string, out: number[], depth: number) => {
    const p = line(id);
    const cls = classOf(id);
    const name = text(p.Name);
    if (!name) return;
    const key = `${group}/${prefix}${name}`;
    let value: Scalar | null = null;
    let unit = "";
    switch (cls) {
      case "IFCPROPERTYSINGLEVALUE": {
        const v = scalar(p.NominalValue);
        if (v === null) return;
        [value, unit] = measured(v, measureName(p.NominalValue), ref(p.Unit));
        break;
      }
      case "IFCPROPERTYENUMERATEDVALUE": {
        const list = (Array.isArray(p.EnumerationValues) ? p.EnumerationValues : [p.EnumerationValues]).map(scalar).filter((v: Scalar | null) => v !== null);
        if (!list.length) return;
        value = list.join(", ");
        break;
      }
      case "IFCPROPERTYBOUNDEDVALUE": {
        const set = scalar(p.SetPointValue);
        const lo = scalar(p.LowerBoundValue);
        const hi = scalar(p.UpperBoundValue);
        const m = measureName(p.SetPointValue) || measureName(p.LowerBoundValue) || measureName(p.UpperBoundValue);
        if (set !== null) [value, unit] = measured(set, m, ref(p.Unit));
        else if (lo !== null && hi !== null) {
          unit = symbolFor(m, ref(p.Unit));
          value = `${lo}–${hi}${unit ? ` ${unit}` : ""}`;
          unit = "";
        } else if (lo !== null || hi !== null) [value, unit] = measured((lo ?? hi) as Scalar, m, ref(p.Unit));
        else return;
        break;
      }
      case "IFCPROPERTYLISTVALUE": {
        const list = (Array.isArray(p.ListValues) ? p.ListValues : []).map(scalar).filter((v: Scalar | null) => v !== null);
        if (!list.length) return;
        value = list.length === 1 ? (list[0] as Scalar) : list.join(", ");
        break;
      }
      case "IFCCOMPLEXPROPERTY": {
        if (depth < 3) for (const sub of refs(p.HasProperties)) readProperty(sub, group, `${prefix}${name}.`, out, depth + 1);
        return;
      }
      case "IFCPROPERTYREFERENCEVALUE": {
        const target = ref(p.PropertyReference);
        if (!target) return;
        const t = line(target);
        const v = text(t.Name) || text(t.Identification) || text(t.Location);
        if (!v) return;
        value = v;
        break;
      }
      default:
        return;
    }
    const k = sidx(key);
    out.push(k, vidx(value));
    keyUnit(k, unit);
  };

  const QUANTITY_VALUE: Record<string, [string, string]> = {
    IFCQUANTITYLENGTH: ["LengthValue", "LENGTHUNIT"],
    IFCQUANTITYAREA: ["AreaValue", "AREAUNIT"],
    IFCQUANTITYVOLUME: ["VolumeValue", "VOLUMEUNIT"],
    IFCQUANTITYWEIGHT: ["WeightValue", "MASSUNIT"],
    IFCQUANTITYTIME: ["TimeValue", "TIMEUNIT"],
    IFCQUANTITYCOUNT: ["CountValue", ""],
  };

  const readQuantity = (id: number, group: string, out: number[], depth: number) => {
    const q = line(id);
    const cls = classOf(id);
    const name = text(q.Name);
    if (!name) return;
    if (cls === "IFCPHYSICALCOMPLEXQUANTITY") {
      if (depth < 3) for (const sub of refs(q.HasQuantities)) readQuantity(sub, group, out, depth + 1);
      return;
    }
    const spec = QUANTITY_VALUE[cls];
    if (!spec) return;
    const v = num(q[spec[0]]);
    if (v === null) return;
    const unitRef = ref(q.Unit);
    const unit = unitRef ? describeUnit(unitRef).symbol : spec[1] ? (projectSymbols.get(spec[1]) ?? DEFAULT_SYMBOL[spec[1]] ?? "") : "";
    const k = sidx(`${group}/${name}`);
    out.push(k, vidx(Math.round(v * 1e6) / 1e6));
    keyUnit(k, unit);
  };

  /** Entries of a property set or quantity set; `asType` keys them "Type/<name>". */
  const setEntries = (id: number, asType: boolean): number[] => {
    const cache = asType ? typeSetCache : psetCache;
    const cached = cache.get(id);
    if (cached) return cached;
    const out: number[] = [];
    const cls = classOf(id);
    const set = line(id);
    const setName = text(set.Name);
    const group = asType ? "Type" : groupName(setName);
    const derived = OWN_DERIVED[setName];
    if (derived === "all") {
      cache.set(id, out);
      return out;
    }
    if (cls === "IFCPROPERTYSET") {
      const props = refs(set.HasProperties);
      for (let i = 0; i < props.length && i < 400; i++) {
        if (derived && derived.has(text(line(props[i]).Name))) continue;
        readProperty(props[i], group, "", out, 0);
      }
    } else if (cls === "IFCELEMENTQUANTITY") {
      const qs = refs(set.Quantities);
      for (let i = 0; i < qs.length && i < 400; i++) readQuantity(qs[i], group, out, 0);
    }
    cache.set(id, out);
    return out;
  };

  // -------------------------------------------------------------------------
  // Elements and rooms

  progress(`Reading ${fileName}: elements`, 0, 0);
  const runs = idSet(RUN_SUPERTYPES);
  const skipped = idSet(SKIPPED_SUPERTYPES);
  const detailedSet = idSet(DETAILED_SUPERTYPES);
  const spaceIds = ids("IFCSPACE");
  const elementIds: number[] = [];
  let runCount = 0;
  let otherCount = 0;
  for (const id of ids("IFCELEMENT")) {
    if (runs.has(id)) runCount++;
    else if (skipped.has(id)) otherCount++;
    else elementIds.push(id);
  }
  const spaceSet = new Set(spaceIds);
  const kept = new Set<number>([...spaceIds, ...elementIds]);
  // Compact node ids: 1 is the file, then rooms, then elements.
  const dbOf = new Map<number, number>();
  const order = [...spaceIds, ...elementIds];
  order.forEach((id, i) => dbOf.set(id, i + 2));
  const detailed = (id: number) => spaceSet.has(id) || (detailedSet.has(id) && !runs.has(id));

  // -------------------------------------------------------------------------
  // Relationships

  const typeOf = new Map<number, number>();
  const psetsOf = new Map<number, number[]>();
  const containerOf = new Map<number, number>();
  const referencedSpace = new Map<number, number>();
  const parentOf = new Map<number, number>();
  const partOf = new Map<number, number>();
  const groupsOf = new Map<number, number[]>();
  const classificationsOf = new Map<number, number[]>();
  const push = (map: Map<number, number[]>, key: number, value: number) => {
    const list = map.get(key);
    if (list) {
      if (!list.includes(value)) list.push(value);
    } else map.set(key, [value]);
  };

  const relTypes = ids("IFCRELDEFINESBYTYPE");
  for (const id of relTypes) {
    const r = line(id);
    const type = ref(r.RelatingType);
    if (!type) continue;
    for (const o of refs(r.RelatedObjects)) if (kept.has(o)) typeOf.set(o, type);
  }

  const relProps = ids("IFCRELDEFINESBYPROPERTIES");
  for (let i = 0; i < relProps.length; i++) {
    if (i % 20000 === 0) progress(`Reading ${fileName}: properties`, i, relProps.length);
    const r = line(relProps[i]);
    const related = refs(r.RelatedObjects).filter((o) => kept.has(o) && detailed(o));
    if (!related.length) continue;
    for (const set of refs(r.RelatingPropertyDefinition)) for (const o of related) push(psetsOf, o, set);
  }

  for (const id of ids("IFCRELCONTAINEDINSPATIALSTRUCTURE")) {
    const r = line(id);
    const structure = ref(r.RelatingStructure);
    if (!structure) continue;
    for (const o of refs(r.RelatedElements)) if (!containerOf.has(o)) containerOf.set(o, structure);
  }
  for (const id of ids("IFCRELREFERENCEDINSPATIALSTRUCTURE")) {
    const r = line(id);
    const structure = ref(r.RelatingStructure);
    if (!structure || !spaceSet.has(structure)) continue;
    for (const o of refs(r.RelatedElements)) if (!referencedSpace.has(o)) referencedSpace.set(o, structure);
  }
  for (const id of ids("IFCRELAGGREGATES")) {
    const r = line(id);
    const parent = ref(r.RelatingObject);
    if (!parent) continue;
    for (const o of refs(r.RelatedObjects)) {
      parentOf.set(o, parent);
      if (kept.has(o) && kept.has(parent) && !spaceSet.has(o)) partOf.set(o, parent);
    }
  }
  for (const id of ids("IFCRELNESTS")) {
    const r = line(id);
    const parent = ref(r.RelatingObject);
    if (!parent || !kept.has(parent)) continue;
    for (const o of refs(r.RelatedObjects)) if (kept.has(o) && !partOf.has(o)) partOf.set(o, parent);
  }

  const systems = new Map<number, { name: string; classification: string; type: string }>();
  const zones = new Map<number, string>();
  for (const id of ids("IFCRELASSIGNSTOGROUP")) {
    const r = line(id);
    const group = ref(r.RelatingGroup);
    if (!group) continue;
    const cls = classOf(group);
    const isSystem = SYSTEM_CLASSES.has(cls);
    const isZone = cls === "IFCZONE" || cls === "IFCSPATIALZONE";
    if (!isSystem && !isZone) continue;
    if (isSystem && !systems.has(group)) {
      const g = line(group);
      if (OWN_DERIVED_SYSTEM.test(text(g.Description))) continue;
      const predefined = enumText(g.PredefinedType);
      const words = /^(NOTDEFINED|USERDEFINED)?$/.test(predefined) ? "" : (SYSTEM_WORDS[predefined] ?? predefined.charAt(0) + predefined.slice(1).toLowerCase().replace(/_/g, " "));
      systems.set(group, { name: (text(g.Name) || text(g.LongName) || `System ${systems.size + 1}`).replace(/,/g, " "), classification: text(g.ObjectType) || words || text(g.Description), type: text(g.ObjectType) });
    }
    if (isZone && !zones.has(group)) {
      const g = line(group);
      zones.set(group, (text(g.LongName) || text(g.Name)).replace(/,/g, " "));
    }
    for (const o of refs(r.RelatedObjects)) if (kept.has(o)) push(groupsOf, o, group);
  }

  for (const id of ids("IFCRELASSOCIATESCLASSIFICATION")) {
    const r = line(id);
    const c = ref(r.RelatingClassification);
    if (!c) continue;
    for (const o of refs(r.RelatedObjects)) push(classificationsOf, o, c);
  }
  const classificationCache = new Map<number, { code: string; title: string; system: string }>();
  const classification = (id: number) => {
    let c = classificationCache.get(id);
    if (!c) {
      const l = line(id);
      const source = ref(l.ReferencedSource);
      let system = "";
      if (source) {
        const s = line(source);
        system = text(s.Name) || text(s.Source);
      }
      c = { code: text(l.Identification) || text(l.ItemReference) || text(l.Edition) || "", title: text(l.Name), system };
      classificationCache.set(id, c);
    }
    return c;
  };

  // -------------------------------------------------------------------------
  // Placements and spatial structure

  const placementCache = new Map<number, M34>();
  const vector = (id: number, key: "Coordinates" | "DirectionRatios"): number[] => {
    const list = line(id)[key];
    const out = [0, 0, 0];
    if (Array.isArray(list)) for (let i = 0; i < 3 && i < list.length; i++) out[i] = num(list[i]) ?? 0;
    return out;
  };
  const axisPlacement = (id: number): M34 => {
    const a = line(id);
    const loc = ref(a.Location) ? vector(ref(a.Location), "Coordinates") : [0, 0, 0];
    const z = (ref(a.Axis) && normalise(vector(ref(a.Axis), "DirectionRatios"))) || [0, 0, 1];
    let x = (ref(a.RefDirection) && normalise(vector(ref(a.RefDirection), "DirectionRatios"))) || [1, 0, 0];
    const d = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
    x = normalise([x[0] - d * z[0], x[1] - d * z[1], x[2] - d * z[2]]) ?? (Math.abs(z[0]) < 0.9 ? normalise([1 - z[0] * z[0], -z[0] * z[1], -z[0] * z[2]])! : [0, 1, 0]);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return Float64Array.of(x[0], y[0], z[0], loc[0], x[1], y[1], z[1], loc[1], x[2], y[2], z[2], loc[2]);
  };
  const placement = (id: number, depth = 0): M34 => {
    if (!id) return IDENTITY;
    const cached = placementCache.get(id);
    if (cached) return cached;
    let m = IDENTITY;
    if (depth < 64 && classOf(id) === "IFCLOCALPLACEMENT") {
      const p = line(id);
      const rel = ref(p.RelativePlacement) ? axisPlacement(ref(p.RelativePlacement)) : IDENTITY;
      m = mul(placement(ref(p.PlacementRelTo), depth + 1), rel);
    }
    placementCache.set(id, m);
    return m;
  };
  /** Where an object's placement puts its origin: metres, Z up. */
  const originOf = (l: Line): [number, number, number] | null => {
    const id = ref(l.ObjectPlacement);
    if (!id) return null;
    const m = placement(id);
    return [m[3] * lengthScale, m[7] * lengthScale, m[11] * lengthScale];
  };

  const spaceLabelCount = new Map<string, number>();
  for (const id of spaceIds) {
    const s = line(id);
    const label = text(s.Name) || text(s.LongName);
    if (label) spaceLabelCount.set(label, (spaceLabelCount.get(label) ?? 0) + 1);
  }

  const storeyIds = new Set(ids("IFCBUILDINGSTOREY"));
  const storeyMemo = new Map<number, number>();
  const storeyOf = (id: number): number => {
    const seen: number[] = [];
    let at = id;
    let found = 0;
    for (let guard = 0; guard < 32 && at; guard++) {
      const memo = storeyMemo.get(at);
      if (memo !== undefined) {
        found = memo;
        break;
      }
      seen.push(at);
      if (storeyIds.has(at)) {
        found = at;
        break;
      }
      at = containerOf.get(at) ?? parentOf.get(at) ?? 0;
    }
    for (const s of seen) storeyMemo.set(s, found);
    return found;
  };
  const spaceOf = (id: number): number => {
    let at = id;
    for (let guard = 0; guard < 16 && at; guard++) {
      const c = containerOf.get(at);
      if (c && spaceSet.has(c)) return c;
      const r = referencedSpace.get(at);
      if (r) return r;
      if (c) return 0;
      at = partOf.get(at) ?? 0;
    }
    return 0;
  };

  // -------------------------------------------------------------------------
  // Geometry: boxes of detailed elements, shapes of rooms

  const boxes = new Map<number, Float64Array>();
  const roomShapes = new Map<number, Float64Array>();
  const meshIds = order.filter((id) => detailed(id));
  const CHUNK = 2000;
  for (let start = 0; start < meshIds.length; start += CHUNK) {
    progress(`Reading ${fileName}: shapes`, start, meshIds.length);
    const chunk = meshIds.slice(start, start + CHUNK);
    try {
      api.StreamMeshes(modelID, chunk, (mesh) => {
        const id = mesh.expressID;
        const isSpace = spaceSet.has(id);
        const box = Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
        const tris: number[] = [];
        const geometries = mesh.geometries;
        for (let g = 0; g < geometries.size(); g++) {
          const placed = geometries.get(g);
          const T = placed.flatTransformation;
          const geometry = api.GetGeometry(modelID, placed.geometryExpressID);
          try {
            const v = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
            // web-ifc gives metres with Y up: (x, y, z) here is (x, -z, y) in the model.
            const world = new Float64Array((v.length / 6) * 3);
            for (let i = 0, j = 0; i < v.length; i += 6, j += 3) {
              const x = v[i],
                y = v[i + 1],
                z = v[i + 2];
              const X = T[0] * x + T[4] * y + T[8] * z + T[12];
              const Y = T[1] * x + T[5] * y + T[9] * z + T[13];
              const Z = T[2] * x + T[6] * y + T[10] * z + T[14];
              world[j] = X;
              world[j + 1] = -Z;
              world[j + 2] = Y;
              if (X < box[0]) box[0] = X;
              if (-Z < box[1]) box[1] = -Z;
              if (Y < box[2]) box[2] = Y;
              if (X > box[3]) box[3] = X;
              if (-Z > box[4]) box[4] = -Z;
              if (Y > box[5]) box[5] = Y;
            }
            if (isSpace && tris.length < 180000) {
              const ix = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
              for (let t = 0; t + 2 < ix.length; t += 3)
                for (let c = 0; c < 3; c++) {
                  const k = ix[t + c] * 3;
                  tris.push(world[k], world[k + 1], world[k + 2]);
                }
            }
          } finally {
            geometry.delete();
          }
        }
        if (box[0] <= box[3]) boxes.set(id, box);
        if (isSpace && tris.length >= 9) roomShapes.set(id, Float64Array.from(tris));
      });
    } catch {
      // A shape web-ifc cannot build: those elements are placed by their origin.
    }
  }

  // -------------------------------------------------------------------------
  // Storeys

  const storeyList = [...storeyIds].map((id) => {
    const l = line(id);
    const origin = originOf(l);
    const elevation = origin ? origin[2] : (num(l.Elevation) ?? 0) * lengthScale;
    return { id, name: text(l.Name) || text(l.LongName) || "Level", elevation: Math.round(elevation * 1000) / 1000 };
  });
  storeyList.sort((a, b) => a.elevation - b.elevation);
  const storeyName = new Map<number, string>();
  const usedNames = new Set<string>();
  for (const s of storeyList) {
    let name = s.name;
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${s.name} (${n})`;
    usedNames.add(name.toLowerCase());
    storeyName.set(s.id, name);
  }
  const storeyLevels = new Map<number, Set<string>>(storeyList.map((s) => [s.id, new Set([storeyName.get(s.id)!])]));
  const storeyCount = new Map<number, number>();

  // -------------------------------------------------------------------------
  // Facility: project, site, building and address

  const named = (id: number | undefined) => {
    if (!id) return "";
    const l = line(id);
    return text(l.LongName) || text(l.Name);
  };
  const siteId = ids("IFCSITE")[0];
  const buildingId = ids("IFCBUILDING")[0];
  const addressOf = (id: number | undefined, attribute: string): string => {
    if (!id) return "";
    const a = ref(line(id)[attribute]);
    if (!a) return "";
    const l = line(a);
    const lines = Array.isArray(l.AddressLines) ? l.AddressLines.map(text).filter(Boolean) : [];
    return [...lines, text(l.Town), text(l.Region), text(l.PostalCode), text(l.Country)].filter(Boolean).join(", ");
  };
  const address = addressOf(buildingId, "BuildingAddress") || addressOf(siteId, "SiteAddress");

  // -------------------------------------------------------------------------
  // Rows

  progress(`Reading ${fileName}: building the register input`, 0, 0);
  const nodeNames: string[] = [fileName];
  const rows: number[][] = [];
  const typeInfo = new Map<number, { cls: string; name: string; predefined: string; entries: number[] }>();
  const typeOfId = (id: number) => {
    let t = typeInfo.get(id);
    if (!t) {
      const l = line(id);
      const entries: number[] = [];
      const attr = (name: string, value: string) => {
        if (value) entries.push(sidx(`Type/${name}`), sidx(value));
      };
      attr("Name", text(l.Name));
      attr("Description", text(l.Description));
      attr("Tag", text(l.Tag));
      attr("Element Type", text(l.ElementType));
      const predefined = enumText(l.PredefinedType);
      if (!/^(NOTDEFINED|USERDEFINED)?$/.test(predefined)) attr("Predefined Type", predefined);
      for (const set of refs(l.HasPropertySets)) entries.push(...setEntries(set, true));
      t = { cls: classOf(id), name: text(l.Name), predefined: /^(NOTDEFINED|USERDEFINED)?$/.test(predefined) ? "" : predefined, entries };
      typeInfo.set(id, t);
    }
    return t;
  };

  const keyIdx = (keys: string[]) => keys.map(sidx);
  const CATEGORY = keyIdx(CATEGORY_KEYS);
  const FAMILY = keyIdx(FAMILY_KEYS);
  const TYPE = keyIdx(TYPE_KEYS);
  const LEVEL = keyIdx(LEVEL_KEYS);
  const OWN = { category: sidx(`${OWN_SOURCE}/Category`), family: sidx(`${OWN_SOURCE}/Family`), type: sidx(`${OWN_SOURCE}/Type`), level: sidx(`${OWN_SOURCE}/Level`) };
  const K = (name: string) => sidx(name);

  const row = new Map<number, number>();
  const put = (k: number, v: number) => {
    if (!row.has(k)) row.set(k, v);
  };
  const putText = (key: string, value: string) => {
    if (value) put(K(key), sidx(value));
  };
  const firstOf = (keys: number[]) => {
    for (const k of keys) {
      const v = row.get(k);
      if (v !== undefined && valueOfIndex(v) !== "") return v;
    }
    return undefined;
  };

  let detailedCount = 0;
  const fragmentBoxes: Float64Array[] = [];
  for (let i = 0; i < order.length; i++) {
    if (i % 20000 === 0) progress(`Reading ${fileName}: elements`, i, order.length);
    const id = order[i];
    const l = line(id);
    const isSpace = spaceSet.has(id);
    const full = detailed(id);
    if (full && !isSpace) detailedCount++;
    row.clear();

    // The element's own property sets, then its type's.
    if (full) for (const set of psetsOf.get(id) ?? []) {
      const entries = setEntries(set, false);
      for (let j = 0; j + 1 < entries.length; j += 2) put(entries[j], entries[j + 1]);
    }
    const typeId = typeOf.get(id);
    const type = typeId ? typeOfId(typeId) : null;
    if (type && full) for (let j = 0; j + 1 < type.entries.length; j += 2) put(type.entries[j], type.entries[j + 1]);

    // What the element is.
    let cls = classOf(id);
    if (type && GENERIC.has(cls)) {
      const fromType = type.cls.replace(/(TYPE|STYLE)$/, "");
      if (CATEGORY_BY_CLASS[fromType] && fromType !== cls) cls = fromType;
    }
    const ownPredefined = enumText(l.PredefinedType);
    const predefined = !/^(NOTDEFINED|USERDEFINED)?$/.test(ownPredefined) ? ownPredefined : (type?.predefined ?? "");
    const name = text(l.Name);
    const objectType = text(l.ObjectType);
    const typeName = type?.name || objectType;
    let family = "";
    let typeLabel = "";
    const revitName = /^(.+?):(.+?):(\d+)$/.exec(name);
    if (typeName.includes(":")) {
      const at = typeName.indexOf(":");
      family = typeName.slice(0, at).trim();
      typeLabel = typeName.slice(at + 1).trim();
    } else if (!typeName && revitName) {
      family = revitName[1].trim();
      typeLabel = revitName[2].trim();
    } else if (typeName) family = typeLabel = typeName;
    else family = isSpace ? "Space" : prettyCategory(cls);

    const gid = text(l.GlobalId);
    if (gid) put(K("Item/GUID"), sidx(gid));
    put(K("Item/IFC Class"), sidx(className(cls)));
    if (predefined) put(K("Item/Predefined Type"), sidx(predefined));

    if (firstOf(CATEGORY) === undefined) {
      const own = row.get(OWN.category);
      put(CATEGORY[0], own !== undefined && valueOfIndex(own) !== "" ? own : sidx(isSpace ? "Spaces" : ifcCategory(cls, predefined)));
    }
    if (firstOf(FAMILY) === undefined) {
      const own = row.get(OWN.family);
      if (own !== undefined) put(FAMILY[0], own);
      else if (family) put(FAMILY[0], sidx(family));
    }
    if (firstOf(TYPE) === undefined) {
      const own = row.get(OWN.type);
      if (own !== undefined) put(TYPE[0], own);
      else if (typeLabel) put(TYPE[0], sidx(typeLabel));
    }
    const storey = storeyOf(id);
    if (storey) {
      storeyCount.set(storey, (storeyCount.get(storey) ?? 0) + 1);
      const levelValue = firstOf(LEVEL);
      if (levelValue === undefined) put(LEVEL[0], sidx(storeyName.get(storey)!));
      else storeyLevels.get(storey)?.add(String(valueOfIndex(levelValue)));
      const own = row.get(OWN.level);
      if (own !== undefined) storeyLevels.get(storey)?.add(String(valueOfIndex(own)));
    } else if (firstOf(LEVEL) === undefined && row.get(OWN.level) !== undefined) put(LEVEL[0], row.get(OWN.level)!);

    if (isSpace) {
      // IfcSpace: Name is the room number, LongName the room's name (a Name with no digit and no
      // LongName is the name).
      const roomName = text(l.LongName);
      const numbered = Boolean(roomName) || /\d/.test(name);
      putText("Element/Name", roomName || (numbered ? "" : name));
      putText("Element/Number", numbered ? name : "");
      const zoneNames = (groupsOf.get(id) ?? []).map((g) => zones.get(g)).filter(Boolean);
      if (zoneNames.length) putText("Element/Zone", zoneNames.join(", "));
    } else {
      putText("Element/Name", name);
      if (full) {
        putText("Element/Description", text(l.Description));
        putText("Element/Object Type", objectType);
      }
    }
    const tag = text(l.Tag);
    if (tag) {
      if (/^\d+$/.test(tag)) put(K("Element/Id"), nidx(Number(tag)));
      else putText("Element/Tag", tag);
    }

    if (full && !isSpace) {
      // The room the model puts it in, by the room's number (when no other room has the same one).
      const space = spaceOf(id);
      if (space) {
        const s = line(space);
        const label = text(s.Name) || text(s.LongName);
        if (label && (spaceLabelCount.get(label) ?? 0) === 1) putText("Element/Room", label);
      }
      const own = (groupsOf.get(id) ?? []).map((g) => systems.get(g)).filter((s): s is NonNullable<typeof s> => Boolean(s));
      if (own.length) {
        putText("Element/System Name", own.map((s) => s.name).join(", "));
        if (own.every((s) => s.classification)) putText("Element/System Classification", own.map((s) => s.classification).join(", "));
        if (own.every((s) => s.type)) putText("Element/System Type", own.map((s) => s.type).join(", "));
      }
      const parent = partOf.get(id);
      if (parent && detailed(parent) && !spaceSet.has(parent)) putText("Element/Part Of", text(line(parent).GlobalId));
      const refsOf = [...(classificationsOf.get(id) ?? []), ...(typeId ? (classificationsOf.get(typeId) ?? []) : [])].map(classification).filter((c) => c.code || c.title);
      if (refsOf.length) {
        const best = refsOf.find((c) => /^pr[_ ]/i.test(c.code)) ?? refsOf.find((c) => /uniclass/i.test(c.system)) ?? refsOf[0];
        putText("Element/Classification", best.code);
        putText("Element/Classification Title", best.title);
        if (best.system) putText("Element/Classification System", best.system);
      }
    }

    const out: number[] = [dbOf.get(id)!];
    for (const [k, v] of row) out.push(k, v);
    rows.push(out);
    nodeNames.push(name || (isSpace ? text(l.LongName) : "") || prettyCategory(cls));

    let box = boxes.get(id) ?? null;
    if (!box) {
      const o = originOf(l);
      box = o ? Float64Array.of(o[0], o[1], o[2], o[0], o[1], o[2]) : Float64Array.of(0, 0, 0, 0, 0, 0);
    }
    fragmentBoxes.push(box);
  }

  // -------------------------------------------------------------------------
  // Job

  // Coordinates far from the origin (site coordinates) keep their precision as an offset.
  let minX = Infinity;
  let minY = Infinity;
  for (const b of fragmentBoxes) {
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
  }
  const offset: [number, number, number] = [Number.isFinite(minX) ? Math.floor(minX) : 0, Number.isFinite(minY) ? Math.floor(minY) : 0, 0];

  const n = order.length;
  const cube = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const cubeTris = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  let vertexCount = cube.length / 3;
  let indexCount = cubeTris.length;
  for (const id of order) {
    const shape = roomShapes.get(id);
    if (shape) {
      vertexCount += shape.length / 3;
      indexCount += shape.length / 3;
    }
  }
  const posF = new Float32Array(vertexCount * 3);
  const i32 = new Uint32Array(indexCount);
  posF.set(cube);
  i32.set(cubeTris);
  const gmeta: number[] = [8, cubeTris.length, 2, 0, 0, 0xffffffff, 0xffffffff];
  let vAt = cube.length / 3;
  let iAt = cubeTris.length;
  const fgeom = new Uint32Array(n);
  const fmtx = new Float32Array(n * 12);
  const fbox = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const id = order[i];
    const b = fragmentBoxes[i];
    const x0 = b[0] - offset[0],
      y0 = b[1] - offset[1],
      z0 = b[2] - offset[2];
    const x1 = b[3] - offset[0],
      y1 = b[4] - offset[1],
      z1 = b[5] - offset[2];
    fbox.set([x0, y0, z0, x1, y1, z1], i * 6);
    const shape = roomShapes.get(id);
    if (shape) {
      const nv = shape.length / 3;
      for (let k = 0; k < nv; k++) {
        posF[(vAt + k) * 3] = shape[k * 3] - offset[0];
        posF[(vAt + k) * 3 + 1] = shape[k * 3 + 1] - offset[1];
        posF[(vAt + k) * 3 + 2] = shape[k * 3 + 2] - offset[2];
        i32[iAt + k] = k;
      }
      fgeom[i] = gmeta.length / 7;
      gmeta.push(nv, nv, 2, vAt, iAt, 0xffffffff, 0xffffffff);
      vAt += nv;
      iAt += nv;
      fmtx.set([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], i * 12);
    } else {
      fgeom[i] = 0;
      fmtx.set([x1 - x0, 0, 0, 0, y1 - y0, 0, 0, 0, z1 - z0, x0, y0, z0], i * 12);
    }
  }

  const stem = fileName.replace(/\.(ifc|ifczip|ifcxml)$/i, "");
  const header: JobHeader = {
    format: 3,
    job: jobName,
    roots: [1],
    file: fileName,
    model: stem,
    source: `IFC (${schema || "IFC"})`,
    extractedAt: new Date().toISOString(),
    globalOffset: offset,
    unitScale: 1,
    units: "m",
    up: [0, 0, 1],
    strings: nodeNames,
    materials: [["8c8c8c", 1]],
    materials3: [{ c: "8c8c8c", o: 1 }],
    textures: [],
    sections: {},
    gmetaStride: 7,
    stats: { elements: elementIds.length, spaces: spaceIds.length, runs: runCount, other: otherCount },
  };
  const ndb = new Uint32Array(n + 1);
  const npar = new Uint32Array(n + 1);
  const nname = new Uint32Array(n + 1);
  const ntyp = new Uint8Array(n + 1);
  ndb[0] = 1;
  ntyp[0] = 5;
  for (let i = 0; i < n; i++) {
    ndb[i + 1] = i + 2;
    npar[i + 1] = 1;
    nname[i + 1] = i + 1;
    ntyp[i + 1] = 1;
  }
  const fdb = Uint32Array.from({ length: n }, (_, i) => i + 2);
  const data: JobData = {
    header,
    ndb,
    npar,
    nname,
    ntyp,
    fdb,
    fgeom,
    fmat: new Uint32Array(n),
    fmtx,
    fbox,
    gmeta: Uint32Array.from(gmeta),
    posQ: new Uint16Array(0),
    posF,
    i16: new Uint16Array(0),
    i32,
    uv: new Float32Array(0),
    col: new Uint8Array(0),
    bytes: posF.byteLength + i32.byteLength + fmtx.byteLength + fbox.byteLength,
  };
  const props: PropsData = { job: jobName, format: 3, mode: "all", strings, numbers, units, rows };

  const storeys: StoreyDef[] = storeyList.map((s, i) => ({
    key: `s${i}`,
    name: storeyName.get(s.id)!,
    elevation: s.elevation,
    levels: [...(storeyLevels.get(s.id) ?? [])],
    count: storeyCount.get(s.id) ?? 0,
  }));

  return {
    job: { name: jobName, data, props, textures: [] },
    info: {
      job: jobName,
      file: fileName,
      schema,
      project: project ? text(project.LongName) || text(project.Name) : "",
      site: named(siteId),
      building: named(buildingId),
      address,
      currency,
      storeys,
      counts: { elements: elementIds.length, detailed: detailedCount, spaces: spaceIds.length, runs: runCount, other: otherCount, systems: systems.size },
      seconds: Math.round((Date.now() - started) / 100) / 10,
    },
  };
}

/** "IFCAIRTERMINAL" -> "IfcAirTerminal" (web-ifc's own spelling when it knows the class). */
function className(upper: string): string {
  return prettyClassNames().get(upper) ?? (upper.startsWith("IFC") ? `Ifc${upper.charAt(3)}${upper.slice(4).toLowerCase()}` : upper);
}

let classNames: Map<string, string> | null = null;
function prettyClassNames(): Map<string, string> {
  if (classNames) return classNames;
  classNames = new Map();
  const schemas = WEBIFC as unknown as Record<string, Record<string, unknown> | undefined>;
  for (const schema of ["IFC4X3", "IFC4", "IFC2X3"]) for (const name of Object.keys(schemas[schema] ?? {})) if (!classNames.has(name.toUpperCase())) classNames.set(name.toUpperCase(), name);
  return classNames;
}

// ---------------------------------------------------------------------------
// In the worker: read a dropped file

let apiReady: Promise<Api> | null = null;

function ifcApi(wasmPath: string): Promise<Api> {
  if (!apiReady)
    apiReady = (async () => {
      const api = new WEBIFC.IfcAPI();
      api.SetWasmPath(wasmPath, true);
      await api.Init(undefined, true);
      return api;
    })().catch((error) => {
      apiReady = null;
      throw error;
    });
  return apiReady;
}

/** Reads an IFC file (in a worker: the file is pulled in through FileReaderSync, never whole in JS memory). */
export async function readIfcFile(blob: Blob, fileName: string, jobName: string, wasmPath: string, onProgress?: ProgressFn): Promise<IfcSource> {
  const reader = new FileReaderSync();
  const size = blob.size;
  // Files that are not IFC make the engine fail with errors that say nothing; say what is wrong instead.
  const problem = ifcHeaderProblem(new Uint8Array(reader.readAsArrayBuffer(blob.slice(0, 65536))), size <= 65536);
  if (problem) throw new Error(problem);
  const api = await ifcApi(wasmPath);
  let furthest = 0;
  let reported = -1;
  const modelID = api.OpenModelFromCallback(
    (offset: number, length: number) => {
      const end = Math.min(offset + length, size);
      if (offset >= end) return new Uint8Array(0);
      if (end > furthest) {
        furthest = end;
        const percent = Math.floor((furthest / size) * 100);
        if (percent !== reported) {
          reported = percent;
          onProgress?.(`Reading ${fileName}`, furthest, size);
        }
      }
      return new Uint8Array(reader.readAsArrayBuffer(blob.slice(offset, end)));
    },
    { COORDINATE_TO_ORIGIN: false },
  );
  if (modelID < 0) throw new Error(`${fileName} could not be read as IFC.`);
  try {
    return readIfcModel(api, modelID, jobName, fileName, onProgress);
  } finally {
    api.CloseModel(modelID);
  }
}
