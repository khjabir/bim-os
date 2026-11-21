// Quantity take-off.
//
// Quantities come from three places, in order of trust:
//   1. IfcElementQuantity sets (base quantities written by the authoring tool),
//      on the element or inherited from its type;
//   2. measured properties in ordinary property sets (values typed as
//      IfcVolumeMeasure / IfcAreaMeasure, which is how Revit exports its
//      "Dimensions" group);
//   3. volume computed from the tessellated geometry, on request.
// Everything is converted to SI (m, m², m³, kg) using the project units.

import { Kind, type ModelIndex, type PropertyEntry, type PsetContent } from "@/lib/data/model-index";
import { getModelUnits } from "@/lib/data/units";
import type { PlainIdMap } from "@/lib/store";
import { labelsForRows, type GroupFacet, type GroupOptions } from "./grouping";

export type Measure = "count" | "volume" | "area" | "length" | "weight";

export const MEASURE_LABEL: Record<Measure, string> = {
  count: "Count",
  volume: "Volume",
  area: "Area",
  length: "Length",
  weight: "Weight",
};

export const MEASURE_UNIT: Record<Measure, string> = {
  count: "",
  volume: "m³",
  area: "m²",
  length: "m",
  weight: "kg",
};

export interface ElementQuantity {
  volume: number;
  area: number;
  length: number;
  weight: number;
}

/** Per-model quantities, one slot per index row; NaN means "not available". */
export interface ModelQuantities {
  index: ModelIndex;
  volume: Float64Array;
  area: Float64Array;
  length: Float64Array;
  weight: Float64Array;
  /** How many elements got at least one quantity, and from where. */
  coverage: { fromQuantitySets: number; fromProperties: number; none: number };
}

export interface QuantityGroup {
  key: string;
  label: string;
  count: number;
  volume: number;
  area: number;
  length: number;
  weight: number;
  /** Elements of the group that contributed a value to each measure. */
  covered: Record<Exclude<Measure, "count">, number>;
  /** Volume computed from the mesh, when requested. */
  meshVolume?: number;
  items: PlainIdMap;
}

const VOLUME_PRIORITY = ["netvolume", "grossvolume", "volume"];
const AREA_PRIORITY: Record<string, string[]> = {
  wall: ["netsidearea", "grosssidearea"],
  curtainwall: ["netsidearea", "grosssidearea"],
  slab: ["netarea", "grossarea"],
  roof: ["netarea", "grossarea", "projectedarea"],
  covering: ["netarea", "grossarea"],
  space: ["netfloorarea", "grossfloorarea"],
  door: ["area"],
  window: ["area"],
  plate: ["netarea", "grossarea"],
};
const AREA_FALLBACK = ["netarea", "netsidearea", "netfloorarea", "area", "grossarea", "grosssidearea", "grossfloorarea", "netsurfacearea", "outersurfacearea", "totalsurfacearea"];
const LENGTH_NAMES = ["length", "netlength", "grosslength"];
const WEIGHT_PRIORITY = ["netweight", "grossweight", "weight"];

// Property names used by authoring tools for the same measures (several languages).
const PROPERTY_VOLUME = /^(net\s*)?(volume|volumen|volumetric|volym|tilavuus|objem)$/i;
const PROPERTY_AREA = /^(net\s*)?(area|área|fläche|flaeche|surface|superficie|oppervlakte|pinta-ala)$/i;
const PROPERTY_LENGTH = /^(length|longitud|länge|laenge|longueur|lunghezza|lengte|pituus|comprimento)$/i;

function normalise(name: string) {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

function numeric(value: PropertyEntry["value"]): number {
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

function areaFamily(category: string): string | null {
  const body = category.replace(/^IFC/, "").toLowerCase();
  for (const family of Object.keys(AREA_PRIORITY)) if (body.startsWith(family)) return family;
  return null;
}

function pick(candidates: Map<string, number>, priority: string[]): number {
  for (const name of priority) {
    const value = candidates.get(name);
    if (value !== undefined && Number.isFinite(value)) return value;
  }
  return NaN;
}

function first(candidates: Map<string, number>): number {
  for (const value of candidates.values()) if (Number.isFinite(value)) return value;
  return NaN;
}

interface Extracted {
  volume: number;
  area: number;
  length: number;
  weight: number;
}

function fromQuantitySets(sets: PsetContent[], category: string): Extracted {
  const volumes = new Map<string, number>();
  const areas = new Map<string, number>();
  const lengths = new Map<string, number>();
  const weights = new Map<string, number>();
  for (const set of sets) {
    if (set.kind !== "qset") continue;
    for (const prop of set.props) {
      const value = numeric(prop.value);
      if (!Number.isFinite(value)) continue;
      const name = normalise(prop.name);
      const kind = prop.category ?? "";
      const target = kind === "IFCQUANTITYVOLUME" ? volumes : kind === "IFCQUANTITYAREA" ? areas : kind === "IFCQUANTITYLENGTH" ? lengths : kind === "IFCQUANTITYWEIGHT" ? weights : null;
      if (target && !target.has(name)) target.set(name, value);
    }
  }
  const family = areaFamily(category);
  let area = family ? pick(areas, AREA_PRIORITY[family]) : NaN;
  if (!Number.isFinite(area)) area = pick(areas, AREA_FALLBACK);
  let volume = pick(volumes, VOLUME_PRIORITY);
  if (!Number.isFinite(volume)) volume = first(volumes);
  let weight = pick(weights, WEIGHT_PRIORITY);
  if (!Number.isFinite(weight)) weight = first(weights);
  return { volume, area, length: pick(lengths, LENGTH_NAMES), weight };
}

function fromPropertySets(sets: PsetContent[]): Extracted {
  let volume = NaN;
  let area = NaN;
  let length = NaN;
  let weakVolume = NaN;
  let weakArea = NaN;
  for (const set of sets) {
    if (set.kind !== "pset") continue;
    for (const prop of set.props) {
      const value = numeric(prop.value);
      if (!Number.isFinite(value)) continue;
      const type = (prop.type ?? "").toUpperCase();
      if (type === "IFCVOLUMEMEASURE") {
        if (PROPERTY_VOLUME.test(prop.name) && !Number.isFinite(volume)) volume = value;
        else if (!Number.isFinite(weakVolume)) weakVolume = value;
      } else if (type === "IFCAREAMEASURE") {
        if (PROPERTY_AREA.test(prop.name) && !Number.isFinite(area)) area = value;
        else if (!Number.isFinite(weakArea)) weakArea = value;
      } else if (type.includes("LENGTHMEASURE") && PROPERTY_LENGTH.test(prop.name) && !Number.isFinite(length)) {
        length = value;
      }
    }
  }
  return {
    volume: Number.isFinite(volume) ? volume : weakVolume,
    area: Number.isFinite(area) ? area : weakArea,
    length,
    weight: NaN,
  };
}

export interface QuantityOptions {
  /** Also read measured values from ordinary property sets (slower on big models). */
  includeProperties: boolean;
  onProgress?: (fraction: number, stage: string) => void;
}

const quantityCache = new WeakMap<ModelIndex, Map<boolean, Promise<ModelQuantities>>>();

/** Reads the quantities of every element of a model. Memoised per model and option. */
export function getModelQuantities(index: ModelIndex, options: QuantityOptions): Promise<ModelQuantities> {
  let perIndex = quantityCache.get(index);
  if (!perIndex) quantityCache.set(index, (perIndex = new Map()));
  const cached = perIndex.get(options.includeProperties);
  if (cached) return cached;
  const promise = readQuantities(index, options).catch((error) => {
    perIndex?.delete(options.includeProperties);
    throw error;
  });
  perIndex.set(options.includeProperties, promise);
  return promise;
}

async function readQuantities(index: ModelIndex, options: QuantityOptions): Promise<ModelQuantities> {
  const count = index.count;
  const volume = new Float64Array(count).fill(NaN);
  const area = new Float64Array(count).fill(NaN);
  const length = new Float64Array(count).fill(NaN);
  const weight = new Float64Array(count).fill(NaN);
  const coverage = { fromQuantitySets: 0, fromProperties: 0, none: 0 };

  const [units, links] = await Promise.all([getModelUnits(index.model), index.typeLinks()]);

  // 1. Quantity sets, own and inherited.
  options.onProgress?.(0, "Reading quantity sets");
  const qsetIds = new Set<number>();
  for (const id of index.qsets.values) qsetIds.add(id);
  for (const sets of links.psets.values()) for (const id of sets) if (index.kindOf(id) === Kind.QuantitySet) qsetIds.add(id);
  const qsets = await index.psetContents(qsetIds);

  const needsProperties: number[] = [];
  for (let row = 0; row < count; row++) {
    const sets: PsetContent[] = [];
    for (const id of index.qsets.get(row)) {
      const set = qsets.get(id);
      if (set) sets.push(set);
    }
    const type = index.typeOf[row];
    if (type >= 0) for (const id of links.psets.get(type) ?? []) {
      const set = qsets.get(id);
      if (set) sets.push(set);
    }
    const found = sets.length > 0 ? fromQuantitySets(sets, index.category(row)) : null;
    if (found) {
      volume[row] = found.volume * units.volume.toSI;
      area[row] = found.area * units.area.toSI;
      length[row] = found.length * units.length.toSI;
      weight[row] = found.weight;
    }
    const hasAny = found && (Number.isFinite(found.volume) || Number.isFinite(found.area) || Number.isFinite(found.length));
    if (hasAny) coverage.fromQuantitySets += 1;
    if (!found || !Number.isFinite(found.volume) || !Number.isFinite(found.area)) needsProperties.push(row);
  }

  // 2. Measured properties for the elements still missing a volume or an area.
  if (options.includeProperties && needsProperties.length > 0) {
    const psetIds = new Set<number>();
    for (const row of needsProperties) {
      for (const id of index.psets.get(row)) psetIds.add(id);
      const type = index.typeOf[row];
      if (type >= 0) for (const id of links.psets.get(type) ?? []) if (index.kindOf(id) === Kind.PropertySet) psetIds.add(id);
    }
    const idList = [...psetIds];
    const psets = new Map<number, PsetContent>();
    const chunk = 10_000;
    for (let start = 0; start < idList.length; start += chunk) {
      options.onProgress?.(start / Math.max(1, idList.length), "Reading measured properties");
      const part = await index.psetContents(idList.slice(start, start + chunk));
      for (const [id, content] of part) psets.set(id, content);
    }
    for (const row of needsProperties) {
      const sets: PsetContent[] = [];
      for (const id of index.psets.get(row)) {
        const set = psets.get(id);
        if (set) sets.push(set);
      }
      const type = index.typeOf[row];
      if (type >= 0) for (const id of links.psets.get(type) ?? []) {
        const set = psets.get(id);
        if (set) sets.push(set);
      }
      if (sets.length === 0) continue;
      const found = fromPropertySets(sets);
      const before = Number.isFinite(volume[row]) || Number.isFinite(area[row]) || Number.isFinite(length[row]);
      if (!Number.isFinite(volume[row]) && Number.isFinite(found.volume)) volume[row] = found.volume * units.volume.toSI;
      if (!Number.isFinite(area[row]) && Number.isFinite(found.area)) area[row] = found.area * units.area.toSI;
      if (!Number.isFinite(length[row]) && Number.isFinite(found.length)) length[row] = found.length * units.length.toSI;
      const after = Number.isFinite(volume[row]) || Number.isFinite(area[row]) || Number.isFinite(length[row]);
      if (!before && after) coverage.fromProperties += 1;
    }
  }

  coverage.none = count - coverage.fromQuantitySets - coverage.fromProperties;
  options.onProgress?.(1, "Done");
  return { index, volume, area, length, weight, coverage };
}

/** Sums quantities per group of a facet across all models. */
export async function quantityGroups(
  quantities: ModelQuantities[],
  facet: GroupFacet,
  options: GroupOptions = {},
): Promise<QuantityGroup[]> {
  const groups = new Map<string, QuantityGroup>();
  for (const model of quantities) {
    const { index } = model;
    const labelsOf = await labelsForRows(index, facet, options);
    const scope = options.scope ? new Set(options.scope[index.modelId] ?? []) : null;
    if (options.scope && (!scope || scope.size === 0)) continue;
    for (let row = 0; row < index.count; row++) {
      const localId = index.ids[row];
      if (scope && !scope.has(localId)) continue;
      for (const label of labelsOf(row)) {
        const key = label.trim().toLowerCase();
        let group = groups.get(key);
        if (!group) {
          group = { key, label, count: 0, volume: 0, area: 0, length: 0, weight: 0, covered: { volume: 0, area: 0, length: 0, weight: 0 }, items: {} };
          groups.set(key, group);
        }
        group.count += 1;
        (group.items[index.modelId] ??= []).push(localId);
        for (const measure of ["volume", "area", "length", "weight"] as const) {
          const value = model[measure][row];
          if (Number.isFinite(value)) {
            group[measure] += value;
            group.covered[measure] += 1;
          }
        }
      }
    }
  }
  return [...groups.values()];
}

/** Volume of each group computed from the mesh, in m³ (Fragments geometry is in metres). */
export async function computeMeshVolumes(
  groups: QuantityGroup[],
  indexes: ModelIndex[],
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const byModel = new Map(indexes.map((index) => [index.modelId, index]));
  let done = 0;
  for (const group of groups) {
    let total = 0;
    for (const [modelId, ids] of Object.entries(group.items)) {
      const index = byModel.get(modelId);
      if (!index) continue;
      // Batches keep each worker call short and the UI responsive.
      for (let start = 0; start < ids.length; start += 4000) {
        total += await index.model.getItemsVolume(ids.slice(start, start + 4000));
      }
    }
    group.meshVolume = total;
    done += 1;
    onProgress?.(done / groups.length);
  }
}
