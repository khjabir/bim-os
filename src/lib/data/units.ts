// Project units, read from the IfcUnitAssignment stored with the model, so
// that quantities can be labelled and converted to SI.

import type * as FRAGS from "@thatopen/fragments";
import { textOf } from "./model-index";

export interface UnitInfo {
  /** Symbol shown next to values, e.g. "mm". */
  symbol: string;
  /** Multiply a value in this unit by `toSI` to get metres / m² / m³. */
  toSI: number;
}

export interface ModelUnits {
  length: UnitInfo;
  area: UnitInfo;
  volume: UnitInfo;
  /** True when the model declared its units; false means SI was assumed. */
  declared: boolean;
}

const PREFIX: Record<string, { symbol: string; factor: number }> = {
  EXA: { symbol: "E", factor: 1e18 },
  PETA: { symbol: "P", factor: 1e15 },
  TERA: { symbol: "T", factor: 1e12 },
  GIGA: { symbol: "G", factor: 1e9 },
  MEGA: { symbol: "M", factor: 1e6 },
  KILO: { symbol: "k", factor: 1e3 },
  HECTO: { symbol: "h", factor: 1e2 },
  DECA: { symbol: "da", factor: 10 },
  DECI: { symbol: "d", factor: 0.1 },
  CENTI: { symbol: "c", factor: 0.01 },
  MILLI: { symbol: "m", factor: 0.001 },
  MICRO: { symbol: "µ", factor: 1e-6 },
  NANO: { symbol: "n", factor: 1e-9 },
};

const IMPERIAL: Record<string, { length?: UnitInfo; area?: UnitInfo; volume?: UnitInfo }> = {
  FOOT: { length: { symbol: "ft", toSI: 0.3048 } },
  INCH: { length: { symbol: "in", toSI: 0.0254 } },
  YARD: { length: { symbol: "yd", toSI: 0.9144 } },
  MILE: { length: { symbol: "mi", toSI: 1609.344 } },
  "SQUARE FOOT": { area: { symbol: "ft²", toSI: 0.09290304 } },
  "SQUARE INCH": { area: { symbol: "in²", toSI: 0.00064516 } },
  "SQUARE YARD": { area: { symbol: "yd²", toSI: 0.83612736 } },
  "CUBIC FOOT": { volume: { symbol: "ft³", toSI: 0.028316846592 } },
  "CUBIC INCH": { volume: { symbol: "in³", toSI: 0.000016387064 } },
  "CUBIC YARD": { volume: { symbol: "yd³", toSI: 0.764554857984 } },
};

export const SI_UNITS: ModelUnits = {
  length: { symbol: "m", toSI: 1 },
  area: { symbol: "m²", toSI: 1 },
  volume: { symbol: "m³", toSI: 1 },
  declared: false,
};

const cache = new Map<string, Promise<ModelUnits>>();

export function disposeModelUnits(modelId: string) {
  cache.delete(modelId);
}

export function getModelUnits(model: FRAGS.FragmentsModel): Promise<ModelUnits> {
  let promise = cache.get(model.modelId);
  if (!promise) {
    promise = readUnits(model).catch(() => ({ ...SI_UNITS }));
    cache.set(model.modelId, promise);
  }
  return promise;
}

async function readUnits(model: FRAGS.FragmentsModel): Promise<ModelUnits> {
  const found = await model.getItemsOfCategories([/^IFCSIUNIT$/, /^IFCCONVERSIONBASEDUNIT/]);
  const ids = Object.values(found).flat();
  const units: ModelUnits = { ...SI_UNITS, length: { ...SI_UNITS.length }, area: { ...SI_UNITS.area }, volume: { ...SI_UNITS.volume } };
  if (ids.length === 0) return units;
  const items = await model.getItemsData(ids, {
    attributesDefault: true,
    relationsDefault: { attributes: false, relations: false },
  });
  // Conversion-based (imperial) units are applied last so they win over SI defaults.
  const ordered = [...items].sort((a, b) => Number(textOf(a._category)?.includes("CONVERSION")) - Number(textOf(b._category)?.includes("CONVERSION")));
  for (const item of ordered) {
    const unitType = textOf(item.UnitType);
    const name = (textOf(item.Name) ?? "").toUpperCase().replace(/[_']/g, " ").trim();
    const category = textOf(item._category) ?? "";
    const kind = unitType === "LENGTHUNIT" ? "length" : unitType === "AREAUNIT" ? "area" : unitType === "VOLUMEUNIT" ? "volume" : null;
    if (!kind) continue;
    if (category.includes("CONVERSION")) {
      const imperial = IMPERIAL[name]?.[kind];
      if (imperial) {
        units[kind] = imperial;
        units.declared = true;
      }
      continue;
    }
    const prefix = PREFIX[textOf(item.Prefix) ?? ""];
    const power = kind === "length" ? 1 : kind === "area" ? 2 : 3;
    const exponent = power === 1 ? "" : power === 2 ? "²" : "³";
    units[kind] = {
      symbol: `${prefix?.symbol ?? ""}m${exponent}`,
      toSI: Math.pow(prefix?.factor ?? 1, power),
    };
    units.declared = true;
  }
  return units;
}

/** Unit symbol for an IFC measure type, or "" when it carries no unit we label. */
export function unitForType(type: string | undefined, units: ModelUnits): string {
  if (!type) return "";
  const upper = type.toUpperCase();
  if (upper.includes("LENGTHMEASURE")) return units.length.symbol;
  if (upper === "IFCAREAMEASURE") return units.area.symbol;
  if (upper === "IFCVOLUMEMEASURE") return units.volume.symbol;
  if (upper === "IFCTHERMALTRANSMITTANCEMEASURE") return "W/m²K";
  if (upper === "IFCMASSMEASURE") return "kg";
  if (upper === "IFCPOWERMEASURE") return "W";
  return "";
}
