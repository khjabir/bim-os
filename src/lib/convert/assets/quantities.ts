// Physical quantities in a model's properties ("1500 m³/h", "45 kW", "400 V",
// "3 Phase", or a bare number with the unit the viewer reports for the
// property), converted to one unit per field so registers can be compared and
// imported: airflow in L/s, power in kW, pressure in Pa, and so on.
//
// The viewer reports units in three ways: written into the value ("1.9 L/s",
// Navisworks), as a short unit beside a number ("kW", "L/s"), or as an
// Autodesk unit id ("autodesk.unit.unit:litersPerSecond-1.0.1"). All three
// are read. A number without any unit is taken to be in the field's unit.

export type Dimension =
  | "flow"
  | "power"
  | "apparent"
  | "pressure"
  | "voltage"
  | "current"
  | "mass"
  | "volume"
  | "speed"
  | "temperature"
  | "flux"
  | "colourTemperature"
  | "time"
  | "area"
  | "count";

// Factor to the dimension's base unit (m³/s, W, VA, Pa, V, A, kg, m³, m/s, °C, lm, K, s, m², 1).
const UNITS: Record<Dimension, [RegExp, number][]> = {
  flow: [
    [/^(l\/s|lps|ls-?1|ltr\/s|litres?\/s(ec)?|liters?\/s(ec)?|literspersecond|litrespersecond)$/, 0.001],
    [/^(m3\/s|cms|cubicmeterspersecond|cubicmetrespersecond)$/, 1],
    [/^(m3\/h|m3\/hr|m3h|cmh|cubicmetersperhour|cubicmetresperhour)$/, 1 / 3600],
    [/^(m3\/min|cubicmetersperminute)$/, 1 / 60],
    [/^(l\/min|lpm|litersperminute|litresperminute)$/, 1 / 60000],
    [/^(l\/h|lph|litersperhour|litresperhour)$/, 1 / 3.6e6],
    [/^(cfm|ft3\/min|cubicfeetperminute)$/, 0.00047194745],
    [/^(cfs|ft3\/s|cubicfeetpersecond)$/, 0.028316847],
    [/^(gpm|usgpm|gal\/min|usgallonsperminute)$/, 6.3090196e-5],
    [/^(igpm|imperialgallonsperminute)$/, 7.5768166e-5],
  ],
  power: [
    [/^(w|watt|watts)$/, 1],
    [/^(kw|kilowatt|kilowatts)$/, 1000],
    [/^(mw|megawatt|megawatts)$/, 1e6],
    [/^(hp|bhp|horsepower)$/, 745.69987],
    [/^(btu\/h|btuh|btu\/hr|btu|britishthermalunitsperhour)$/, 0.29307107],
    [/^(mbh|kbtu\/h|kbtuh|mbtu\/h|thousandbritishthermalunitsperhour)$/, 293.07107],
    [/^(tr|ton|tons|rt|tonsofrefrigeration|tonofrefrigeration)$/, 3516.8528],
    [/^(kcal\/h|kilocaloriesperhour)$/, 1.163],
  ],
  apparent: [
    [/^(va|voltampere|voltamperes)$/, 1],
    [/^(kva|kilovoltampere|kilovoltamperes)$/, 1000],
    [/^(mva|megavoltampere|megavoltamperes)$/, 1e6],
    [/^(w|watt|watts)$/, 1],
    [/^(kw|kilowatt|kilowatts)$/, 1000],
  ],
  pressure: [
    [/^(pa|pascal|pascals)$/, 1],
    [/^(kpa|kilopascal|kilopascals)$/, 1000],
    [/^(mpa|megapascal|megapascals)$/, 1e6],
    [/^(bar|bars)$/, 1e5],
    [/^(mbar|millibar|millibars)$/, 100],
    [/^(psi|poundsforcepersquareinch|psig)$/, 6894.7573],
    [/^(inwg|inwc|inh2o|in\.?w\.?g\.?|in\.?w\.?c\.?|inchesofwater.*|inchofwater.*)$/, 249.08891],
    [/^(mmwg|mmwc|mmh2o|mm\.?w\.?g\.?|millimetersofwater.*|millimetresofwater.*|millimetersofwatercolumn)$/, 9.80665],
    [/^(mwg|mwc|mh2o|mhd|metersofwater.*|metresofwater.*|metersofwatercolumn|m)$/, 9806.65],
    [/^(ft|fth2o|ftwg|ftwc|feetofwater.*|feet)$/, 2989.0669],
  ],
  voltage: [
    [/^(v|volt|volts|vac|vdc|v~)$/, 1],
    [/^(kv|kilovolt|kilovolts)$/, 1000],
  ],
  current: [
    [/^(a|amp|amps|ampere|amperes)$/, 1],
    [/^(ka|kiloampere|kiloamperes)$/, 1000],
    [/^(ma|milliampere|milliamperes)$/, 0.001],
  ],
  mass: [
    [/^(kg|kgs|kilogram|kilograms)$/, 1],
    [/^(g|gram|grams)$/, 0.001],
    [/^(t|tonne|tonnes|metricton)$/, 1000],
    [/^(lb|lbs|pound|pounds|poundsmass)$/, 0.45359237],
  ],
  volume: [
    [/^(l|ltr|ltrs|litre|litres|liter|liters)$/, 0.001],
    [/^(m3|cubicmeter|cubicmeters|cubicmetre|cubicmetres)$/, 1],
    [/^(ml|milliliter|milliliters|millilitre|millilitres)$/, 1e-6],
    [/^(gal|usgal|gallon|gallons|usgallons)$/, 0.0037854118],
    [/^(ft3|cubicfeet|cubicfoot)$/, 0.028316847],
  ],
  speed: [
    [/^(m\/s|mps|meterspersecond|metrespersecond)$/, 1],
    [/^(m\/min|metersperminute|metresperminute)$/, 1 / 60],
    [/^(fpm|ft\/min|feetperminute)$/, 0.00508],
    [/^(fps|ft\/s|feetpersecond)$/, 0.3048],
    [/^(km\/h|kph|kilometersperhour|kilometresperhour)$/, 1 / 3.6],
  ],
  temperature: [
    [/^(c|°c|degc|degreesc|celsius|degreescelsius|deg\.?c)$/, 1],
    [/^(f|°f|degf|degreesf|fahrenheit|degreesfahrenheit)$/, 1],
    [/^(k|kelvin|kelvins)$/, 1],
  ],
  flux: [[/^(lm|lumen|lumens)$/, 1]],
  colourTemperature: [[/^(k|kelvin|kelvins)$/, 1]],
  time: [
    [/^(h|hr|hrs|hour|hours)$/, 3600],
    [/^(min|mins|minute|minutes)$/, 60],
    [/^(s|sec|secs|second|seconds)$/, 1],
  ],
  area: [
    [/^(m2|sqm|squaremeters|squaremetres|squaremeter|squaremetre)$/, 1],
    [/^(ft2|sqft|squarefeet|squarefoot|sf)$/, 0.09290304],
    [/^(mm2|squaremillimeters|squaremillimetres)$/, 1e-6],
  ],
  count: [],
};

/** Canonical unit of a field, as a factor of the dimension's base unit. */
const OUTPUT_UNITS: Record<string, [Dimension, number]> = {
  "L/s": ["flow", 0.001],
  kW: ["power", 1000],
  W: ["power", 1],
  kVA: ["apparent", 1000],
  Pa: ["pressure", 1],
  kPa: ["pressure", 1000],
  V: ["voltage", 1],
  A: ["current", 1],
  kA: ["current", 1000],
  kg: ["mass", 1],
  L: ["volume", 0.001],
  "m/s": ["speed", 1],
  "°C": ["temperature", 1],
  lm: ["flux", 1],
  K: ["colourTemperature", 1],
  h: ["time", 3600],
  "m²": ["area", 1],
  "": ["count", 1],
};

/** "autodesk.unit.unit:litersPerSecond-1.0.1" -> "literspersecond"; "m³/h" -> "m3/h". */
export function normaliseUnit(unit: string): string {
  let u = unit.trim();
  const forge = /^autodesk\.unit\.unit:([A-Za-z0-9]+)(?:-[\d.]+)?$/.exec(u);
  if (forge) u = forge[1];
  return u
    .toLowerCase()
    .replace(/³/g, "3")
    .replace(/²/g, "2")
    .replace(/[·\s]/g, "")
    .replace(/\^/g, "")
    .replace(/^per/, "");
}

function factor(dim: Dimension, unit: string): number | null {
  const u = normaliseUnit(unit);
  if (!u) return null;
  for (const [re, f] of UNITS[dim]) if (re.test(u)) return f;
  return null;
}

/** Number and the unit written after it: "1,500 m³/h" -> [1500, "m³/h"]; "IP54" -> null. */
function splitValue(text: string): { n: number; unit: string } | null {
  const m = /^\s*([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:[.,]\d+)?)\s*(.*)$/.exec(text);
  if (!m) return null;
  let digits = m[1];
  // "1,500" (thousands) vs "1,5" (decimal comma)
  digits = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(digits) ? digits.replace(/,/g, "") : digits.replace(",", ".");
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  // The unit is the first word-ish run: "45 kW (cooling)" -> "kW"; "3 Phase" -> "Phase"; "400V/3ph/50Hz" -> "V".
  const unit = /^([A-Za-z°µ³²\/.\-0-9]*?)(?=$|[\s,;()]|\/\d|\/[A-Za-z]+\/)/.exec(m[2])?.[1] ?? "";
  return { n, unit };
}

/**
 * A property value as a number in the field's unit (`unit`, one of the
 * OUTPUT_UNITS keys), or null when it holds no number or a unit of another
 * kind. `viewerUnit` is the unit the viewer reports for the property.
 */
export function parseQuantity(value: unknown, viewerUnit: string | undefined, unit: string): number | null {
  const out = OUTPUT_UNITS[unit];
  if (!out) return null;
  const [dim, outFactor] = out;
  let n: number;
  let written = "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    n = value;
  } else if (typeof value === "string") {
    const split = splitValue(value);
    if (!split) return null;
    n = split.n;
    written = split.unit;
  } else return null;

  if (dim === "count") return Number.isFinite(n) ? n : null;
  if (dim === "temperature") {
    const u = normaliseUnit(written || viewerUnit || "");
    if (/^(f|°f|degf|degreesf|fahrenheit|degreesfahrenheit)$/.test(u)) return round((n - 32) * (5 / 9));
    if (/^(k|kelvin|kelvins)$/.test(u)) return round(n - 273.15);
    return round(n);
  }
  const f = written ? factor(dim, written) : null;
  if (f !== null) return round((n * f) / outFactor);
  if (written && !/^(phase|ph|ways?|poles?|p|x|nos?|no\.?)$/i.test(written)) {
    // A unit of another kind ("45 kW" read as a flow): only a viewer unit can rescue it.
    if (viewerUnit) {
      const g = factor(dim, viewerUnit);
      if (g !== null) return round((n * g) / outFactor);
    }
    return null;
  }
  if (viewerUnit) {
    const g = factor(dim, viewerUnit);
    if (g !== null) return round((n * g) / outFactor);
  }
  return round(n);
}

function round(n: number): number {
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 1 : abs >= 10 ? 2 : abs >= 1 ? 3 : 4;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/** Revit's "Electrical Data" text ("230 V/1-120 VA", "400 V/3-15 kVA"): voltage, phases and load. */
export function parseElectricalData(text: string): { voltage: number | null; phases: number | null; kva: number | null } {
  const m = /([\d.,]+)\s*V\s*\/\s*(\d)\s*-\s*([\d.,]+)\s*(k?VA|k?W)/i.exec(text);
  if (!m) return { voltage: null, phases: null, kva: null };
  const voltage = Number(m[1].replace(",", "."));
  const phases = Number(m[2]);
  const load = Number(m[3].replace(",", "."));
  const kva = /^k/i.test(m[4]) ? load : load / 1000;
  return { voltage: Number.isFinite(voltage) ? voltage : null, phases: Number.isFinite(phases) ? phases : null, kva: Number.isFinite(kva) ? round(kva) : null };
}

/** Voltage and phases from a distribution system name ("400/230V 3P4W", "230V 1-phase", "415V TPN"). */
export function parseDistributionSystem(text: string): { voltage: number | null; phases: number | null } {
  const v = /(\d{2,5})(?:\s*\/\s*\d{2,5})?\s*V\b/i.exec(text);
  const p = /\b([13])\s*-?\s*(?:phase|ph|p)(?![a-z])|\b(tpn|tp&n|three[- ]phase)\b|\b(spn|sp&n|single[- ]phase)\b/i.exec(text);
  const phases = p ? (p[1] ? Number(p[1]) : p[2] ? 3 : p[3] ? 1 : null) : null;
  return { voltage: v ? Number(v[1]) : null, phases };
}
