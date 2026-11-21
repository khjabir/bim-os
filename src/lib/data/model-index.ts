// Per-model element index.
//
// Quantity take-off, health checks, IDS validation, grouping and the assistant
// all need the same facts about every element: its class, storey, type, and
// which property sets, quantity sets, materials and classifications it has.
// Fetching those per feature would repeat a lot of worker round trips, so they
// are gathered once per model into compact typed arrays and cached.
//
// Heavy text (names, property values) is NOT loaded up front. It is fetched in
// batches on demand and memoised (see names/psetNames/psetContents below).

import type * as FRAGS from "@thatopen/fragments";

export interface StoreyInfo {
  localId: number;
  name: string;
  elevation: number | null;
}

/** Compressed sparse rows: a list of ids per element row. */
export class Csr {
  constructor(
    readonly offsets: Uint32Array,
    readonly values: Uint32Array,
  ) {}

  get(row: number): Uint32Array {
    return this.values.subarray(this.offsets[row], this.offsets[row + 1]);
  }

  count(row: number): number {
    return this.offsets[row + 1] - this.offsets[row];
  }
}

class CsrBuilder {
  private offsets: Uint32Array;
  private values: Uint32Array;
  private length = 0;
  private row = 0;

  constructor(rows: number) {
    this.offsets = new Uint32Array(rows + 1);
    this.values = new Uint32Array(Math.max(16, rows * 2));
  }

  /** Rows must be appended in order. */
  append(values: number[]) {
    const needed = this.length + values.length;
    if (needed > this.values.length) {
      const grown = new Uint32Array(Math.max(needed, this.values.length * 2));
      grown.set(this.values.subarray(0, this.length));
      this.values = grown;
    }
    for (let i = 0; i < values.length; i++) this.values[this.length + i] = values[i];
    this.length = needed;
    this.row += 1;
    this.offsets[this.row] = this.length;
  }

  build(): Csr {
    return new Csr(this.offsets, this.values.slice(0, this.length));
  }
}

export const enum Kind {
  Unknown = 0,
  PropertySet = 1,
  QuantitySet = 2,
  Type = 3,
  Material = 4,
  Classification = 5,
  Group = 6,
}

export interface PsetContent {
  localId: number;
  name: string;
  /** "pset" for IfcPropertySet, "qset" for IfcElementQuantity. */
  kind: "pset" | "qset";
  props: PropertyEntry[];
}

export interface PropertyEntry {
  name: string;
  value: string | number | boolean | null;
  /** IFC value type, e.g. IFCLABEL or IFCAREAMEASURE. */
  type?: string;
  /** The IFC class of the property or quantity (e.g. IFCQUANTITYAREA). */
  category?: string;
}

export interface SpatialNode {
  /** Stable key within the model, used for expansion state. */
  key: number;
  /** "item" is a real IFC item; "group" bundles the items of one class under a parent. */
  kind: "item" | "group";
  /** Local id of the item; null for class groups. */
  localId: number | null;
  /** Upper-case IFC class. */
  category: string;
  children: SpatialNode[];
  /** Number of geometric elements at or below this node. */
  elementCount: number;
}

export class ModelIndex {
  readonly modelId: string;
  readonly model: FRAGS.FragmentsModel;
  /** Local ids of all items with geometry, ascending. */
  readonly ids: Uint32Array;
  readonly categories: string[];
  readonly categoryOf: Uint16Array;
  /** Storey local id per row, -1 when the element is not under a storey. */
  readonly storeyOf: Int32Array;
  /** Nearest spatial container per row (storey, space, building or site), -1 when none. */
  readonly containerOf: Int32Array;
  /** Aggregation parent per row (IfcRelAggregates), -1 when none. */
  readonly parentOf: Int32Array;
  readonly typeOf: Int32Array;
  readonly psets: Csr;
  readonly qsets: Csr;
  readonly materials: Csr;
  readonly classifications: Csr;
  readonly groups: Csr;
  readonly storeys: StoreyInfo[];
  readonly tree: SpatialNode | null;
  readonly maxLocalId: number;

  private readonly kinds: Uint8Array;
  private readonly storeyNames = new Map<number, string>();
  private readonly nameCache = new Map<number, string>();
  private readonly attrCache = new Map<string, Map<number, string | number | boolean | null>>();
  private readonly psetNameCache = new Map<number, string>();
  private readonly psetContentCache = new Map<number, PsetContent>();
  private typeLinkCache: TypeLinks | null = null;
  private materialNameCache: Map<number, string[]> | null = null;
  private classificationCache: Map<number, ClassificationInfo> | null = null;

  constructor(init: {
    modelId: string;
    model: FRAGS.FragmentsModel;
    ids: Uint32Array;
    categories: string[];
    categoryOf: Uint16Array;
    storeyOf: Int32Array;
    containerOf: Int32Array;
    parentOf: Int32Array;
    typeOf: Int32Array;
    psets: Csr;
    qsets: Csr;
    materials: Csr;
    classifications: Csr;
    groups: Csr;
    storeys: StoreyInfo[];
    tree: SpatialNode | null;
    kinds: Uint8Array;
    maxLocalId: number;
  }) {
    this.modelId = init.modelId;
    this.model = init.model;
    this.ids = init.ids;
    this.categories = init.categories;
    this.categoryOf = init.categoryOf;
    this.storeyOf = init.storeyOf;
    this.containerOf = init.containerOf;
    this.parentOf = init.parentOf;
    this.typeOf = init.typeOf;
    this.psets = init.psets;
    this.qsets = init.qsets;
    this.materials = init.materials;
    this.classifications = init.classifications;
    this.groups = init.groups;
    this.storeys = init.storeys;
    this.tree = init.tree;
    this.kinds = init.kinds;
    this.maxLocalId = init.maxLocalId;
    for (const storey of init.storeys) this.storeyNames.set(storey.localId, storey.name);
  }

  get count() {
    return this.ids.length;
  }

  /** Row of an element local id, or -1 (binary search over the sorted ids). */
  rowOf(localId: number): number {
    const ids = this.ids;
    let low = 0;
    let high = ids.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const value = ids[mid];
      if (value === localId) return mid;
      if (value < localId) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  category(row: number): string {
    return this.categories[this.categoryOf[row]];
  }

  kindOf(localId: number): Kind {
    return localId <= this.maxLocalId ? (this.kinds[localId] as Kind) : Kind.Unknown;
  }

  storeyName(storeyId: number): string {
    return storeyId < 0 ? "No storey" : (this.storeyNames.get(storeyId) ?? `Storey #${storeyId}`);
  }

  /** Rows grouped by upper-case IFC class. */
  rowsByCategory(): Map<string, number[]> {
    const groups = new Map<string, number[]>();
    for (let row = 0; row < this.ids.length; row++) {
      const category = this.categories[this.categoryOf[row]];
      let list = groups.get(category);
      if (!list) groups.set(category, (list = []));
      list.push(row);
    }
    return groups;
  }

  // -------------------------------------------------------------------
  // Lazy, memoised text lookups
  // -------------------------------------------------------------------

  /** Name attribute for arbitrary items (elements, types, materials, storeys...). */
  async names(localIds: Iterable<number>): Promise<Map<number, string>> {
    const missing: number[] = [];
    for (const id of localIds) if (!this.nameCache.has(id)) missing.push(id);
    await inBatches(missing, 4000, async (batch) => {
      const data = await this.model.getItemsData(batch, {
        attributesDefault: false,
        attributes: ["Name", "LongName", "LayerSetName"],
        relationsDefault: { attributes: false, relations: false },
      });
      for (let i = 0; i < batch.length; i++) {
        const item = data[i];
        const id = idOf(item) ?? batch[i];
        const name = textOf(item?.Name) ?? textOf(item?.LongName) ?? textOf(item?.LayerSetName) ?? "";
        this.nameCache.set(id, name);
      }
      for (const id of batch) if (!this.nameCache.has(id)) this.nameCache.set(id, "");
    });
    const result = new Map<number, string>();
    for (const id of localIds) result.set(id, this.nameCache.get(id) ?? "");
    return result;
  }

  /** One attribute (e.g. ObjectType, PredefinedType, Tag, Description) for many items. */
  async attribute(localIds: Iterable<number>, attribute: string): Promise<Map<number, string | number | boolean | null>> {
    let cache = this.attrCache.get(attribute);
    if (!cache) this.attrCache.set(attribute, (cache = new Map()));
    const missing: number[] = [];
    for (const id of localIds) if (!cache.has(id)) missing.push(id);
    const store = cache;
    await inBatches(missing, 4000, async (batch) => {
      const data = await this.model.getItemsData(batch, {
        attributesDefault: false,
        attributes: [attribute],
        relationsDefault: { attributes: false, relations: false },
      });
      for (let i = 0; i < batch.length; i++) {
        const item = data[i];
        const id = idOf(item) ?? batch[i];
        store.set(id, valueOf(item?.[attribute]));
      }
      for (const id of batch) if (!store.has(id)) store.set(id, null);
    });
    const result = new Map<number, string | number | boolean | null>();
    for (const id of localIds) result.set(id, store.get(id) ?? null);
    return result;
  }

  /** Names of property/quantity sets. */
  async psetNames(psetIds: Iterable<number>): Promise<Map<number, string>> {
    const missing: number[] = [];
    for (const id of psetIds) if (!this.psetNameCache.has(id)) missing.push(id);
    await inBatches(missing, 5000, async (batch) => {
      const data = await this.model.getItemsData(batch, {
        attributesDefault: false,
        attributes: ["Name"],
        relationsDefault: { attributes: false, relations: false },
      });
      for (let i = 0; i < batch.length; i++) {
        const item = data[i];
        this.psetNameCache.set(idOf(item) ?? batch[i], textOf(item?.Name) ?? "");
      }
      for (const id of batch) if (!this.psetNameCache.has(id)) this.psetNameCache.set(id, "");
    });
    const result = new Map<number, string>();
    for (const id of psetIds) result.set(id, this.psetNameCache.get(id) ?? "");
    return result;
  }

  /** Full contents (properties or quantities) of property/quantity sets. */
  async psetContents(psetIds: Iterable<number>): Promise<Map<number, PsetContent>> {
    const missing: number[] = [];
    for (const id of psetIds) if (!this.psetContentCache.has(id)) missing.push(id);
    await inBatches(missing, 2500, async (batch) => {
      const data = await this.model.getItemsData(batch, {
        attributesDefault: true,
        relations: {
          HasProperties: { attributes: true, relations: false },
          Quantities: { attributes: true, relations: false },
        },
        relationsDefault: { attributes: false, relations: false },
      });
      for (let i = 0; i < batch.length; i++) {
        const item = data[i];
        const id = idOf(item) ?? batch[i];
        const content = parsePset(item, id);
        this.psetContentCache.set(id, content);
        this.psetNameCache.set(id, content.name);
      }
    });
    const result = new Map<number, PsetContent>();
    for (const id of psetIds) {
      const content = this.psetContentCache.get(id);
      if (content) result.set(id, content);
    }
    return result;
  }

  /** Property sets, materials and classifications attached to type objects. */
  async typeLinks(): Promise<TypeLinks> {
    if (this.typeLinkCache) return this.typeLinkCache;
    const typeIds = new Set<number>();
    for (let row = 0; row < this.typeOf.length; row++) if (this.typeOf[row] >= 0) typeIds.add(this.typeOf[row]);
    const links: TypeLinks = { psets: new Map(), materials: new Map(), classifications: new Map() };
    await inBatches([...typeIds], 5000, async (batch) => {
      const relations = await this.model.getRelations(batch);
      for (const [typeId, relation] of relations) {
        const psets: number[] = [];
        const materials: number[] = [];
        const classifications: number[] = [];
        for (const [name, targets] of Object.entries(relation.data)) {
          if (name === "ObjectTypeOf" || name === "RepresentationMaps") continue;
          for (const target of targets) {
            const kind = this.kindOf(target);
            if (kind === Kind.PropertySet || kind === Kind.QuantitySet) psets.push(target);
            else if (kind === Kind.Material) materials.push(target);
            else if (kind === Kind.Classification) classifications.push(target);
          }
        }
        if (psets.length > 0) links.psets.set(typeId, psets);
        if (materials.length > 0) links.materials.set(typeId, materials);
        if (classifications.length > 0) links.classifications.set(typeId, classifications);
      }
    });
    this.typeLinkCache = links;
    return links;
  }

  /** Backwards-compatible accessor for the type property sets only. */
  async typePsets(): Promise<Map<number, number[]>> {
    return (await this.typeLinks()).psets;
  }

  /**
   * Material names behind every material association in the model (layer set
   * usages, constituent sets, profile sets and lists resolve to their leaf
   * IfcMaterial names).
   */
  async materialNames(): Promise<Map<number, string[]>> {
    if (this.materialNameCache) return this.materialNameCache;
    const associations = new Set<number>();
    for (const id of this.materials.values) associations.add(id);
    const links = await this.typeLinks();
    for (const list of links.materials.values()) for (const id of list) associations.add(id);
    const result = new Map<number, string[]>();
    const config = { attributes: true, relations: true } as const;
    await inBatches([...associations], 1500, async (batch) => {
      const data = await this.model.getItemsData(batch, {
        attributesDefault: false,
        attributes: ["Name", "LayerSetName"],
        relations: {
          ForLayerSet: config,
          MaterialLayers: config,
          ForProfileSet: config,
          MaterialProfiles: config,
          MaterialConstituents: config,
          Materials: config,
          Material: { attributes: true, relations: false },
        },
        relationsDefault: { attributes: false, relations: false },
      });
      for (let i = 0; i < batch.length; i++) {
        const names = new Set<string>();
        collectMaterialNames(data[i], names, 0);
        result.set(idOf(data[i]) ?? batch[i], [...names]);
      }
    });
    this.materialNameCache = result;
    return result;
  }

  /** Material association ids of a row, falling back to its type's materials. */
  materialsOfRow(row: number, links: TypeLinks): ArrayLike<number> {
    const own = this.materials.get(row);
    if (own.length > 0) return own;
    const type = this.typeOf[row];
    return type >= 0 ? (links.materials.get(type) ?? EMPTY) : EMPTY;
  }

  /** Property and quantity set ids of a row, including the ones inherited from its type. */
  setsOfRow(row: number, links: TypeLinks): number[] {
    const sets: number[] = [];
    for (const id of this.psets.get(row)) sets.push(id);
    for (const id of this.qsets.get(row)) sets.push(id);
    const type = this.typeOf[row];
    if (type >= 0) for (const id of links.psets.get(type) ?? EMPTY) sets.push(id);
    return sets;
  }

  /** Classification reference ids of a row, falling back to its type's. */
  classificationsOfRow(row: number, links: TypeLinks): ArrayLike<number> {
    const own = this.classifications.get(row);
    if (own.length > 0) return own;
    const type = this.typeOf[row];
    return type >= 0 ? (links.classifications.get(type) ?? EMPTY) : EMPTY;
  }

  /** System, code and name of every classification reference used in the model. */
  async classificationInfo(): Promise<Map<number, ClassificationInfo>> {
    if (this.classificationCache) return this.classificationCache;
    const ids = new Set<number>();
    for (const id of this.classifications.values) ids.add(id);
    const links = await this.typeLinks();
    for (const list of links.classifications.values()) for (const id of list) ids.add(id);
    const result = new Map<number, ClassificationInfo>();
    await inBatches([...ids], 2000, async (batch) => {
      const data = await this.model.getItemsData(batch, {
        attributesDefault: true,
        relations: { ReferencedSource: { attributes: true, relations: false } },
        relationsDefault: { attributes: false, relations: false },
      });
      for (let i = 0; i < batch.length; i++) {
        const item = data[i];
        if (!item) continue;
        const source = Array.isArray(item.ReferencedSource) ? (item.ReferencedSource[0] as FRAGS.ItemData | undefined) : undefined;
        const isSystem = categoryOfItem(item) === "IFCCLASSIFICATION";
        result.set(idOf(item) ?? batch[i], {
          system: isSystem ? (textOf(item.Name) ?? "") : ((source && textOf(source.Name)) ?? ""),
          code: textOf(item.Identification) ?? textOf(item.ItemReference) ?? "",
          name: isSystem ? "" : (textOf(item.Name) ?? ""),
          uri: textOf(item.Location) ?? "",
        });
      }
    });
    this.classificationCache = result;
    return result;
  }
}

export interface TypeLinks {
  psets: Map<number, number[]>;
  materials: Map<number, number[]>;
  classifications: Map<number, number[]>;
}

export interface ClassificationInfo {
  system: string;
  code: string;
  name: string;
  uri: string;
}

const EMPTY: number[] = [];

function collectMaterialNames(item: FRAGS.ItemData | undefined, out: Set<string>, depth: number) {
  if (!item || depth > 6) return;
  const category = categoryOfItem(item);
  if (category === "IFCMATERIAL") {
    const name = textOf(item.Name);
    if (name) out.add(name);
    return;
  }
  for (const relation of ["ForLayerSet", "MaterialLayers", "ForProfileSet", "MaterialProfiles", "MaterialConstituents", "Materials", "Material"]) {
    const value = item[relation];
    if (Array.isArray(value)) for (const child of value) collectMaterialNames(child, out, depth + 1);
  }
}

// ---------------------------------------------------------------------
// Item data helpers
// ---------------------------------------------------------------------

type ItemValue = FRAGS.ItemAttribute | FRAGS.ItemData[] | undefined;

function isAttribute(value: ItemValue): value is FRAGS.ItemAttribute {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object" && "value" in (value as object);
}

export function valueOf(value: ItemValue): string | number | boolean | null {
  if (!isAttribute(value)) return null;
  const raw = value.value;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  return String(raw);
}

export function textOf(value: ItemValue): string | null {
  const raw = valueOf(value);
  if (raw === null) return null;
  const text = String(raw).trim();
  return text.length > 0 ? text : null;
}

export function idOf(item: FRAGS.ItemData | undefined): number | null {
  if (!item) return null;
  const raw = valueOf(item._localId);
  return typeof raw === "number" ? raw : null;
}

export function categoryOfItem(item: FRAGS.ItemData | undefined): string {
  return (item && textOf(item._category)) || "";
}

const VALUE_KEYS = [
  "NominalValue",
  "LengthValue",
  "AreaValue",
  "VolumeValue",
  "CountValue",
  "WeightValue",
  "TimeValue",
  "NumberValue",
  "UpperBoundValue",
  "LowerBoundValue",
  "SetPointValue",
];

/** Reads the value of an IfcProperty or IfcPhysicalQuantity item. */
export function parseProperty(item: FRAGS.ItemData): PropertyEntry {
  const name = textOf(item.Name) ?? "(unnamed)";
  const category = categoryOfItem(item);
  for (const key of VALUE_KEYS) {
    const attribute = item[key];
    if (isAttribute(attribute) && attribute.value !== null && attribute.value !== undefined) {
      return { name, value: valueOf(attribute), type: attribute.type, category };
    }
  }
  // Enumerated / list values arrive as arrays or plain attributes with other names.
  for (const [key, attribute] of Object.entries(item)) {
    if (key.startsWith("_") || key === "Name" || key === "Description" || key === "Unit") continue;
    if (isAttribute(attribute) && attribute.value !== null && attribute.value !== undefined) {
      const raw = attribute.value;
      const value = Array.isArray(raw) ? raw.map((entry) => (entry && typeof entry === "object" && "value" in entry ? entry.value : entry)).join(", ") : valueOf(attribute);
      return { name, value, type: attribute.type, category };
    }
  }
  return { name, value: null, category };
}

export function parsePset(item: FRAGS.ItemData | undefined, fallbackId: number): PsetContent {
  if (!item) return { localId: fallbackId, name: "", kind: "pset", props: [] };
  const category = categoryOfItem(item);
  const kind = category.includes("QUANTITY") ? "qset" : "pset";
  const children = (Array.isArray(item.HasProperties) ? item.HasProperties : Array.isArray(item.Quantities) ? item.Quantities : []) as FRAGS.ItemData[];
  return {
    localId: idOf(item) ?? fallbackId,
    name: textOf(item.Name) ?? "(unnamed set)",
    kind,
    props: children.map(parseProperty),
  };
}

export async function inBatches<T>(items: T[], size: number, run: (batch: T[], done: number) => Promise<void>) {
  for (let start = 0; start < items.length; start += size) {
    await run(items.slice(start, start + size), start);
  }
}

// ---------------------------------------------------------------------
// Building and caching
// ---------------------------------------------------------------------

const SPATIAL = new Set(["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSPACE", "IFCFACILITY", "IFCFACILITYPART", "IFCBRIDGE", "IFCBRIDGEPART", "IFCROAD", "IFCROADPART", "IFCRAILWAY", "IFCRAILWAYPART", "IFCSPATIALZONE"]);

export function isSpatialCategory(category: string) {
  return SPATIAL.has(category);
}

const cache = new Map<string, Promise<ModelIndex>>();

export function disposeModelIndex(modelId: string) {
  cache.delete(modelId);
}

export type IndexProgress = (fraction: number, stage: string) => void;

/** Returns the (cached) index of a model, building it on first use. */
export function getModelIndex(model: FRAGS.FragmentsModel, onProgress?: IndexProgress): Promise<ModelIndex> {
  const existing = cache.get(model.modelId);
  if (existing) return existing;
  const promise = buildIndex(model, onProgress).catch((error) => {
    cache.delete(model.modelId);
    throw error;
  });
  cache.set(model.modelId, promise);
  return promise;
}

async function buildIndex(model: FRAGS.FragmentsModel, onProgress?: IndexProgress): Promise<ModelIndex> {
  onProgress?.(0, "Listing elements");
  const [rawIds, rawCategories, maxLocalId] = await Promise.all([
    model.getItemsIdsWithGeometry(),
    model.getItemsWithGeometryCategories(),
    model.getMaxLocalId(),
  ]);

  // Sort rows by local id so rows can be found by binary search.
  const order = rawIds.map((_, index) => index).sort((a, b) => rawIds[a] - rawIds[b]);
  const count = order.length;
  const ids = new Uint32Array(count);
  const categoryOf = new Uint16Array(count);
  const categories: string[] = [];
  const categoryIndex = new Map<string, number>();
  for (let row = 0; row < count; row++) {
    const source = order[row];
    ids[row] = rawIds[source];
    const category = (rawCategories[source] ?? "UNKNOWN").toUpperCase();
    let index = categoryIndex.get(category);
    if (index === undefined) {
      index = categories.length;
      categories.push(category);
      categoryIndex.set(category, index);
    }
    categoryOf[row] = index;
  }

  onProgress?.(0.1, "Classifying related items");
  const kinds = new Uint8Array(maxLocalId + 1);
  const related = await model.getItemsOfCategories([
    /^IFCPROPERTYSET$/,
    /^IFCELEMENTQUANTITY$/,
    /TYPE$/,
    /STYLE$/,
    /^IFCMATERIAL/,
    /^IFCCLASSIFICATION/,
    /^IFC(GROUP|SYSTEM|ZONE|BUILDINGSYSTEM|DISTRIBUTIONSYSTEM|DISTRIBUTIONCIRCUIT|INVENTORY|ASSET)$/,
  ]);
  for (const [category, list] of Object.entries(related)) {
    let kind = Kind.Unknown;
    if (category === "IFCPROPERTYSET") kind = Kind.PropertySet;
    else if (category === "IFCELEMENTQUANTITY") kind = Kind.QuantitySet;
    else if (category.startsWith("IFCMATERIAL")) kind = Kind.Material;
    else if (category.startsWith("IFCCLASSIFICATION")) kind = Kind.Classification;
    else if (/^IFC(GROUP|SYSTEM|ZONE|BUILDINGSYSTEM|DISTRIBUTIONSYSTEM|DISTRIBUTIONCIRCUIT|INVENTORY|ASSET)$/.test(category)) kind = Kind.Group;
    else if (/(TYPE|STYLE)$/.test(category)) kind = Kind.Type;
    if (kind === Kind.Unknown) continue;
    for (const id of list) if (id <= maxLocalId) kinds[id] = kind;
  }

  // --- Spatial structure ------------------------------------------------
  onProgress?.(0.2, "Reading spatial structure");
  const storeyOf = new Int32Array(count).fill(-1);
  const containerOf = new Int32Array(count).fill(-1);
  const parentOf = new Int32Array(count).fill(-1);
  const storeyIds: number[] = [];

  const rowOf = (localId: number) => {
    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (ids[mid] === localId) return mid;
      if (ids[mid] < localId) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  };

  let tree: SpatialNode | null = null;
  try {
    const raw = await model.getSpatialStructure();
    tree = convertTree(raw, (localId, category, storey, container) => {
      if (category === "IFCBUILDINGSTOREY") storeyIds.push(localId);
      const row = rowOf(localId);
      if (row >= 0) {
        storeyOf[row] = storey;
        containerOf[row] = container;
      }
      return row >= 0;
    });
  } catch (error) {
    console.warn("Spatial structure unavailable", error);
  }

  // --- Relations ----------------------------------------------------------
  const typeOf = new Int32Array(count).fill(-1);
  const psets = new CsrBuilder(count);
  const qsets = new CsrBuilder(count);
  const materials = new CsrBuilder(count);
  const classifications = new CsrBuilder(count);
  const groups = new CsrBuilder(count);
  const batchSize = 20_000;
  const idList = Array.from(ids);
  for (let start = 0; start < count; start += batchSize) {
    onProgress?.(0.25 + 0.7 * (start / Math.max(1, count)), "Reading relations");
    const batch = idList.slice(start, start + batchSize);
    const relations = await model.getRelations(batch);
    for (let i = 0; i < batch.length; i++) {
      const row = start + i;
      const data = relations.get(batch[i])?.data;
      const rowPsets: number[] = [];
      const rowQsets: number[] = [];
      const rowMaterials: number[] = [];
      const rowClassifications: number[] = [];
      const rowGroups: number[] = [];
      if (data) {
        for (const target of data.IsDefinedBy ?? []) {
          const kind = target <= maxLocalId ? kinds[target] : Kind.Unknown;
          if (kind === Kind.PropertySet) rowPsets.push(target);
          else if (kind === Kind.QuantitySet) rowQsets.push(target);
          else if (kind === Kind.Type) typeOf[row] = target;
        }
        for (const target of data.IsTypedBy ?? []) typeOf[row] = target;
        for (const target of data.HasAssociations ?? []) {
          const kind = target <= maxLocalId ? kinds[target] : Kind.Unknown;
          if (kind === Kind.Classification) rowClassifications.push(target);
          else if (kind === Kind.Material) rowMaterials.push(target);
        }
        for (const target of data.HasAssignments ?? []) {
          if (target <= maxLocalId && kinds[target] === Kind.Group) rowGroups.push(target);
        }
        const parent = data.Decomposes?.[0] ?? data.Nests?.[0];
        if (parent !== undefined) parentOf[row] = parent;
        if (containerOf[row] < 0) {
          const container = data.ContainedInStructure?.[0];
          if (container !== undefined) containerOf[row] = container;
        }
      }
      psets.append(rowPsets);
      qsets.append(rowQsets);
      materials.append(rowMaterials);
      classifications.append(rowClassifications);
      groups.append(rowGroups);
    }
  }

  // --- Storeys --------------------------------------------------------------
  onProgress?.(0.97, "Reading storeys");
  const storeys: StoreyInfo[] = [];
  if (storeyIds.length > 0) {
    const data = await model.getItemsData(storeyIds, {
      attributesDefault: false,
      attributes: ["Name", "LongName", "Elevation"],
      relationsDefault: { attributes: false, relations: false },
    });
    for (let i = 0; i < storeyIds.length; i++) {
      const item = data[i];
      const elevation = valueOf(item?.Elevation);
      storeys.push({
        localId: idOf(item) ?? storeyIds[i],
        name: textOf(item?.Name) ?? textOf(item?.LongName) ?? `Storey ${i + 1}`,
        elevation: typeof elevation === "number" ? elevation : null,
      });
    }
    storeys.sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
  }

  onProgress?.(1, "Done");
  return new ModelIndex({
    modelId: model.modelId,
    model,
    ids,
    categories,
    categoryOf,
    storeyOf,
    containerOf,
    parentOf,
    typeOf,
    psets: psets.build(),
    qsets: qsets.build(),
    materials: materials.build(),
    classifications: classifications.build(),
    groups: groups.build(),
    storeys,
    tree,
    kinds,
    maxLocalId,
  });
}

/** Classes whose items are listed directly under their parent instead of inside a class group. */
const INLINE_CLASSES = new Set(["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCFACILITY", "IFCFACILITYPART", "IFCBRIDGE", "IFCROAD", "IFCRAILWAY"]);

/**
 * The raw spatial tree alternates "class" nodes ({ category, localId: null })
 * and "item" nodes ({ category: null, localId }). This turns it into item
 * nodes that carry their class, keeps a class group for element classes
 * (so a storey shows "Wall (120)" rather than 120 loose rows), and reports
 * every item to `visit` with the storey and nearest spatial container above it.
 */
function convertTree(
  raw: FRAGS.SpatialTreeItem,
  visit: (localId: number, category: string, storey: number, container: number) => boolean,
): SpatialNode | null {
  let nextKey = 1;

  const buildItem = (node: FRAGS.SpatialTreeItem, category: string, storey: number, container: number): SpatialNode | null => {
    if (node.localId === null || node.localId === undefined) return null;
    const localId = node.localId;
    const key = nextKey++;
    const isElement = visit(localId, category, storey, container);
    const nextStorey = category === "IFCBUILDINGSTOREY" ? localId : storey;
    const nextContainer = isSpatialCategory(category) ? localId : container;
    const children: SpatialNode[] = [];
    for (const child of node.children ?? []) children.push(...buildClass(child, nextStorey, nextContainer));
    let elementCount = isElement ? 1 : 0;
    for (const child of children) elementCount += child.elementCount;
    return { key, kind: "item", localId, category, children, elementCount };
  };

  const buildClass = (node: FRAGS.SpatialTreeItem, storey: number, container: number): SpatialNode[] => {
    if (node.localId !== null && node.localId !== undefined) {
      // An item without a class node above it (not expected, but harmless).
      const item = buildItem(node, (node.category ?? "").toUpperCase(), storey, container);
      return item ? [item] : [];
    }
    const category = (node.category ?? "").toUpperCase();
    const key = nextKey++;
    const items: SpatialNode[] = [];
    for (const child of node.children ?? []) {
      const item = buildItem(child, category, storey, container);
      if (item) items.push(item);
    }
    if (items.length === 0) return [];
    if (INLINE_CLASSES.has(category)) return items;
    let elementCount = 0;
    for (const item of items) elementCount += item.elementCount;
    return [{ key, kind: "group", localId: null, category, children: items, elementCount }];
  };

  const roots = buildClass(raw, -1, -1);
  if (roots.length === 0) return null;
  if (roots.length === 1) return roots[0];
  let elementCount = 0;
  for (const root of roots) elementCount += root.elementCount;
  return { key: 0, kind: "group", localId: null, category: "MODEL", children: roots, elementCount };
}
