// Evaluates IDS specifications against loaded models.
//
// The evaluator works on any item of a model by local id (elements, spatial
// items, types), not only on items with geometry, and fetches what each facet
// needs in batches: attributes, relations, property sets, materials and
// classification references. See README ("IDS validation") for the parts of
// IDS 1.0 this implementation does not cover.

import type * as FRAGS from "@thatopen/fragments";
import { categoryOfItem, idOf, Kind, textOf, type ModelIndex, type PsetContent } from "@/lib/data/model-index";
import { getModelUnits, type ModelUnits } from "@/lib/data/units";
import type { PlainIdMap } from "@/lib/store";
import type { EntityFacet, IdsCardinality, IdsDocument, IdsFacet, IdsSpecification, IdsValue, PartOfFacet } from "./types";

type Scalar = string | number | boolean | null;

/** match: the facet holds. mismatch: the thing exists but its value is wrong. absent: the thing does not exist. */
type State = "match" | "mismatch" | "absent";

interface Outcome {
  state: State;
  reason?: string;
  /** The attribute / set / association is there, even if empty or wrong. Drives "prohibited" without a value. */
  exists?: boolean;
}

export interface IdsFailure {
  modelId: string;
  localId: number;
  reasons: string[];
}

export interface IdsSpecResult {
  spec: IdsSpecification;
  status: "pass" | "fail" | "skipped";
  /** Explains a skipped or occurrence-level result. */
  message?: string;
  applicable: PlainIdMap;
  passed: PlainIdMap;
  failed: PlainIdMap;
  applicableCount: number;
  passCount: number;
  failCount: number;
  /** Reasons for the first failures (capped to keep memory bounded). */
  failures: IdsFailure[];
  /** How many applicable entities failed each requirement, in requirement order. */
  requirementFailures: number[];
}

export interface IdsReport {
  document: IdsDocument;
  results: IdsSpecResult[];
  passed: number;
  failed: number;
  skipped: number;
}

const EPSILON = 1e-6;
const FAILURE_REASON_LIMIT = 3000;

// ---------------------------------------------------------------------------
// Value matching
// ---------------------------------------------------------------------------

const NUMBER_FORMAT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function numbersEqual(actual: number, expected: number) {
  // IDS tolerance: |v| * 1e-6 + 1e-6 either side. The extra term absorbs the
  // binary rounding of the bounds themselves (0.999998 must equal 1.0).
  const slack = Math.abs(expected) * EPSILON + EPSILON;
  const rounding = 1e-9 * Math.max(1e-6, Math.abs(expected) * EPSILON + EPSILON);
  return actual >= expected - slack - rounding && actual <= expected + slack + rounding;
}

function matchesLiteral(literal: string, actual: Scalar): boolean {
  if (actual === null) return false;
  if (typeof actual === "number") {
    if (!NUMBER_FORMAT.test(literal.trim())) return false;
    return numbersEqual(actual, Number(literal));
  }
  if (typeof actual === "boolean") {
    // IDS spells booleans in lower case.
    return literal === (actual ? "true" : "false");
  }
  return literal === actual;
}

const patternCache = new Map<string, RegExp | null>();

function xsdPattern(pattern: string): RegExp | null {
  let compiled = patternCache.get(pattern);
  if (compiled === undefined) {
    try {
      // XSD patterns are implicitly anchored. \i and \c (XML name characters) are approximated.
      const source = pattern.replace(/\\i/g, "[A-Za-z_:]").replace(/\\c/g, "[-.0-9A-Za-z_:]");
      compiled = new RegExp(`^(?:${source})$`, "u");
    } catch {
      compiled = null;
    }
    patternCache.set(pattern, compiled);
  }
  return compiled;
}

/** Does `actual` satisfy the IDS value constraint? An absent constraint accepts any non-empty value. */
export function matchesValue(constraint: IdsValue | undefined, actual: Scalar): boolean {
  if (actual === null || actual === "") return false;
  if (!constraint) return true;
  if (constraint.kind === "simple") return matchesLiteral(constraint.value, actual);

  if (constraint.enumeration && !constraint.enumeration.some((literal) => matchesLiteral(literal, actual))) return false;
  if (constraint.pattern) {
    const text = typeof actual === "boolean" ? (actual ? "true" : "false") : String(actual);
    if (!constraint.pattern.some((pattern) => xsdPattern(pattern)?.test(text))) return false;
  }
  const bounded = constraint.minInclusive !== undefined || constraint.maxInclusive !== undefined || constraint.minExclusive !== undefined || constraint.maxExclusive !== undefined;
  if (bounded) {
    const number = typeof actual === "number" ? actual : typeof actual === "string" && NUMBER_FORMAT.test(actual.trim()) ? Number(actual) : NaN;
    if (!Number.isFinite(number)) return false;
    // Ranges are compared exactly; the equality tolerance does not apply to them.
    if (constraint.minInclusive !== undefined && !(number >= constraint.minInclusive)) return false;
    if (constraint.maxInclusive !== undefined && !(number <= constraint.maxInclusive)) return false;
    if (constraint.minExclusive !== undefined && !(number > constraint.minExclusive)) return false;
    if (constraint.maxExclusive !== undefined && !(number < constraint.maxExclusive)) return false;
  }
  const measured = constraint.length !== undefined || constraint.minLength !== undefined || constraint.maxLength !== undefined;
  if (measured) {
    const length = String(actual).length;
    if (constraint.length !== undefined && length !== constraint.length) return false;
    if (constraint.minLength !== undefined && length < constraint.minLength) return false;
    if (constraint.maxLength !== undefined && length > constraint.maxLength) return false;
  }
  return true;
}

/** Entity names are compared in upper case; everything else is case sensitive. */
function matchesName(constraint: IdsValue, actualUpper: string): boolean {
  return matchesValue(constraint, actualUpper);
}

export function describeValue(constraint: IdsValue | undefined): string {
  if (!constraint) return "any value";
  if (constraint.kind === "simple") return `"${constraint.value}"`;
  const parts: string[] = [];
  if (constraint.enumeration) parts.push(`one of ${constraint.enumeration.map((value) => `"${value}"`).join(", ")}`);
  if (constraint.pattern) parts.push(`matching ${constraint.pattern.join(" or ")}`);
  if (constraint.minInclusive !== undefined) parts.push(`≥ ${constraint.minInclusive}`);
  if (constraint.minExclusive !== undefined) parts.push(`> ${constraint.minExclusive}`);
  if (constraint.maxInclusive !== undefined) parts.push(`≤ ${constraint.maxInclusive}`);
  if (constraint.maxExclusive !== undefined) parts.push(`< ${constraint.maxExclusive}`);
  if (constraint.length !== undefined) parts.push(`${constraint.length} characters long`);
  if (constraint.minLength !== undefined) parts.push(`at least ${constraint.minLength} characters`);
  if (constraint.maxLength !== undefined) parts.push(`at most ${constraint.maxLength} characters`);
  return parts.join(" and ") || "any value";
}

export function describeFacet(facet: IdsFacet): string {
  switch (facet.type) {
    case "entity":
      return `Class is ${describeValue(facet.name)}${facet.predefinedType ? ` with predefined type ${describeValue(facet.predefinedType)}` : ""}`;
    case "attribute":
      return `Attribute ${describeValue(facet.name)}${facet.value ? ` is ${describeValue(facet.value)}` : " has a value"}`;
    case "property":
      return `Property ${describeValue(facet.propertySet)} . ${describeValue(facet.baseName)}${facet.value ? ` is ${describeValue(facet.value)}` : " has a value"}${facet.dataType ? ` (${facet.dataType})` : ""}`;
    case "classification":
      return `Classified${facet.system ? ` in ${describeValue(facet.system)}` : ""}${facet.value ? ` as ${describeValue(facet.value)}` : ""}`;
    case "material":
      return facet.value ? `Material is ${describeValue(facet.value)}` : "Has a material";
    case "partOf":
      return `Part of ${describeValue(facet.entity.name)}${facet.relation ? ` via ${facet.relation}` : ""}`;
  }
}

// ---------------------------------------------------------------------------
// Per-model context: batched, cached access to item data
// ---------------------------------------------------------------------------

interface ItemAttributes {
  category: string;
  guid: string | null;
  values: Map<string, { value: Scalar; type?: string }>;
}

interface IdsProperty {
  name: string;
  /** Every value the property carries (single, enumerated, list, table columns), with its IFC data type. */
  values: { value: Scalar; type?: string }[];
  /** True for IfcPropertyBoundedValue: the values are its lower bound, upper bound and set point. */
  bounded?: boolean;
}

interface IdsSet {
  name: string;
  props: IdsProperty[];
}

interface ClassificationRef {
  system: string;
  /** Identification of the reference and of its ancestors. */
  codes: string[];
}

const HELPER_CLASSES = /^IFC(PROPERTY|QUANTITY|ELEMENTQUANTITY|MATERIAL|SIUNIT|UNITASSIGNMENT|DERIVEDUNIT|MONETARYUNIT|CONVERSIONBASEDUNIT|CLASSIFICATION|COMPLEXPROPERTY|PHYSICALCOMPLEXQUANTITY)/;

const LENGTH_TYPES = /^IFC(POSITIVE|NONNEGATIVE)?LENGTHMEASURE$/;

class ModelContext {
  readonly model: FRAGS.FragmentsModel;
  private readonly attributes = new Map<number, ItemAttributes>();
  private readonly relations = new Map<number, Record<string, number[]>>();
  private readonly sets = new Map<number, IdsSet>();
  private readonly materialLabels = new Map<number, string[]>();
  private readonly classificationRefs = new Map<number, ClassificationRef>();
  private categories: string[] | null = null;

  constructor(
    readonly index: ModelIndex,
    readonly schema: string,
    readonly units: ModelUnits,
  ) {
    this.model = index.model;
  }

  async allCategories(): Promise<string[]> {
    if (!this.categories) this.categories = (await this.model.getCategories()).map((category) => category.toUpperCase());
    return this.categories;
  }

  /** Local ids of every item whose class is in `categories`. */
  async itemsOf(categories: string[]): Promise<number[]> {
    if (categories.length === 0) return [];
    const found = await this.model.getItemsOfCategories(categories.map((category) => new RegExp(`^${category}$`)));
    const ids: number[] = [];
    for (const list of Object.values(found)) for (const id of list) ids.push(id);
    return ids;
  }

  async loadAttributes(ids: Iterable<number>) {
    const missing: number[] = [];
    for (const id of ids) if (!this.attributes.has(id)) missing.push(id);
    for (let start = 0; start < missing.length; start += 4000) {
      const batch = missing.slice(start, start + 4000);
      const data = await this.model.getItemsData(batch, { attributesDefault: true, relationsDefault: { attributes: false, relations: false } });
      for (let i = 0; i < batch.length; i++) {
        const item = data[i];
        const values = new Map<string, { value: Scalar; type?: string }>();
        if (item) {
          for (const [key, raw] of Object.entries(item)) {
            if (key.startsWith("_") || Array.isArray(raw)) continue;
            const attribute = raw as FRAGS.ItemAttribute;
            values.set(key, { value: normalise(attribute.value), type: attribute.type });
          }
        }
        const guid = item ? textOf(item._guid) : null;
        if (guid) values.set("GlobalId", { value: guid, type: "IFCGLOBALLYUNIQUEID" });
        this.attributes.set(idOf(item) ?? batch[i], { category: categoryOfItem(item).toUpperCase(), guid, values });
      }
    }
  }

  attributesOf(id: number): ItemAttributes | undefined {
    return this.attributes.get(id);
  }

  async loadRelations(ids: Iterable<number>) {
    const missing: number[] = [];
    for (const id of ids) if (!this.relations.has(id)) missing.push(id);
    for (let start = 0; start < missing.length; start += 20_000) {
      const batch = missing.slice(start, start + 20_000);
      const result = await this.model.getRelations(batch);
      for (const id of batch) this.relations.set(id, result.get(id)?.data ?? {});
    }
  }

  relationsOf(id: number): Record<string, number[]> {
    return this.relations.get(id) ?? {};
  }

  /** The type object of an item, or -1. Relations must be loaded. */
  typeOf(id: number): number {
    const data = this.relationsOf(id);
    for (const target of data.IsTypedBy ?? []) return target;
    for (const target of data.IsDefinedBy ?? []) if (this.index.kindOf(target) === Kind.Type) return target;
    return -1;
  }

  private setIdsOf(id: number): number[] {
    const data = this.relationsOf(id);
    const ids: number[] = [];
    for (const name of ["IsDefinedBy", "HasPropertySets"]) {
      for (const target of data[name] ?? []) {
        const kind = this.index.kindOf(target);
        if (kind === Kind.PropertySet || kind === Kind.QuantitySet) ids.push(target);
      }
    }
    return ids;
  }

  /** Loads the property and quantity sets of items and of their types. Relations must be loaded. */
  async loadSets(ids: Iterable<number>) {
    const wanted = new Set<number>();
    const types = new Set<number>();
    for (const id of ids) {
      for (const setId of this.setIdsOf(id)) wanted.add(setId);
      const type = this.typeOf(id);
      if (type >= 0) types.add(type);
    }
    await this.loadRelations(types);
    for (const type of types) for (const setId of this.setIdsOf(type)) wanted.add(setId);
    const missing = [...wanted].filter((id) => !this.sets.has(id));
    for (let start = 0; start < missing.length; start += 2500) {
      const batch = missing.slice(start, start + 2500);
      const data = await this.model.getItemsData(batch, {
        attributesDefault: true,
        relations: {
          HasProperties: { attributes: true, relations: true },
          Quantities: { attributes: true, relations: true },
          EnumerationReference: { attributes: true, relations: false },
        },
        relationsDefault: { attributes: false, relations: false },
      });
      for (let i = 0; i < batch.length; i++) this.sets.set(idOf(data[i]) ?? batch[i], this.readSet(data[i]));
    }
  }

  private readSet(item: FRAGS.ItemData | undefined): IdsSet {
    if (!item) return { name: "", props: [] };
    const props: IdsProperty[] = [];
    const collect = (children: FRAGS.ItemData[]) => {
      for (const child of children) {
        const nested = Array.isArray(child.HasProperties) ? (child.HasProperties as FRAGS.ItemData[]) : Array.isArray(child.HasQuantities) ? (child.HasQuantities as FRAGS.ItemData[]) : null;
        if (nested) {
          collect(nested); // complex properties expose their members
          continue;
        }
        props.push(this.readProperty(child));
      }
    };
    if (Array.isArray(item.HasProperties)) collect(item.HasProperties as FRAGS.ItemData[]);
    if (Array.isArray(item.Quantities)) collect(item.Quantities as FRAGS.ItemData[]);
    return { name: textOf(item.Name) ?? "", props };
  }

  private readProperty(item: FRAGS.ItemData): IdsProperty {
    const name = textOf(item.Name) ?? "";
    const values: IdsProperty["values"] = [];
    const category = categoryOfItem(item).toUpperCase();
    for (const [key, raw] of Object.entries(item)) {
      if (key.startsWith("_") || key === "Name" || key === "Description" || key === "Unit" || key === "Formula" || Array.isArray(raw)) continue;
      const attribute = raw as FRAGS.ItemAttribute;
      const type = attribute.type?.toUpperCase();
      const push = (value: unknown, valueType?: string) => {
        const scalar = normalise(value);
        if (scalar === null) return;
        const dataType = valueType ?? type;
        values.push({ value: typeof scalar === "number" ? this.toSI(scalar, dataType) : scalar, type: dataType });
      };
      if (Array.isArray(attribute.value)) {
        // List, enumerated and table values arrive as arrays.
        for (const entry of attribute.value as unknown[]) {
          if (entry && typeof entry === "object" && "value" in (entry as object)) push((entry as { value: unknown }).value, (entry as { type?: string }).type?.toUpperCase());
          else push(entry);
        }
      } else {
        push(attribute.value);
      }
    }
    return { name, values, bounded: category === "IFCPROPERTYBOUNDEDVALUE" };
  }

  /** Converts a measure from project units to the SI unit IDS expects. */
  toSI(value: number, dataType: string | undefined): number {
    if (!dataType) return value;
    if (LENGTH_TYPES.test(dataType)) return value * this.units.length.toSI;
    if (dataType === "IFCAREAMEASURE") return value * this.units.area.toSI;
    if (dataType === "IFCVOLUMEMEASURE") return value * this.units.volume.toSI;
    return value;
  }

  /** Sets of an item with the ones inherited from its type; own properties override inherited ones. */
  setsOf(id: number): IdsSet[] {
    const merged = new Map<string, Map<string, IdsProperty>>();
    const add = (setId: number) => {
      const set = this.sets.get(setId);
      if (!set) return;
      let props = merged.get(set.name);
      if (!props) merged.set(set.name, (props = new Map()));
      for (const prop of set.props) props.set(prop.name, prop);
    };
    const type = this.typeOf(id);
    if (type >= 0) for (const setId of this.setIdsOf(type)) add(setId);
    for (const setId of this.setIdsOf(id)) add(setId);
    return [...merged.entries()].map(([name, props]) => ({ name, props: [...props.values()] }));
  }

  private materialIdsOf(id: number): number[] {
    const own = (this.relationsOf(id).HasAssociations ?? []).filter((target) => this.index.kindOf(target) === Kind.Material);
    if (own.length > 0) return own;
    const type = this.typeOf(id);
    return type >= 0 ? (this.relationsOf(type).HasAssociations ?? []).filter((target) => this.index.kindOf(target) === Kind.Material) : [];
  }

  async loadMaterials(ids: Iterable<number>) {
    const types = new Set<number>();
    for (const id of ids) {
      const type = this.typeOf(id);
      if (type >= 0) types.add(type);
    }
    await this.loadRelations(types);
    const wanted = new Set<number>();
    for (const id of ids) for (const material of this.materialIdsOf(id)) wanted.add(material);
    const missing = [...wanted].filter((id) => !this.materialLabels.has(id));
    const nested = { attributes: true, relations: true } as const;
    for (let start = 0; start < missing.length; start += 1500) {
      const batch = missing.slice(start, start + 1500);
      const data = await this.model.getItemsData(batch, {
        attributesDefault: true,
        relations: { ForLayerSet: nested, MaterialLayers: nested, ForProfileSet: nested, MaterialProfiles: nested, MaterialConstituents: nested, Materials: nested, Material: nested },
        relationsDefault: { attributes: false, relations: false },
      });
      for (let i = 0; i < batch.length; i++) {
        const labels = new Set<string>();
        collectMaterialLabels(data[i], labels, 0);
        this.materialLabels.set(idOf(data[i]) ?? batch[i], [...labels]);
      }
    }
  }

  /** null when the item has no material at all; otherwise every name and category found. */
  materialsOf(id: number): string[] | null {
    const ids = this.materialIdsOf(id);
    if (ids.length === 0) return null;
    const labels: string[] = [];
    for (const material of ids) for (const label of this.materialLabels.get(material) ?? []) labels.push(label);
    return labels;
  }

  private classificationIdsOf(id: number): number[] {
    const pick = (item: number) => (this.relationsOf(item).HasAssociations ?? []).filter((target) => this.index.kindOf(target) === Kind.Classification);
    const type = this.typeOf(id);
    return [...pick(id), ...(type >= 0 ? pick(type) : [])];
  }

  async loadClassifications(ids: Iterable<number>) {
    const types = new Set<number>();
    for (const id of ids) {
      const type = this.typeOf(id);
      if (type >= 0) types.add(type);
    }
    await this.loadRelations(types);
    const wanted = new Set<number>();
    for (const id of ids) for (const reference of this.classificationIdsOf(id)) wanted.add(reference);
    const missing = [...wanted].filter((id) => !this.classificationRefs.has(id));
    for (let start = 0; start < missing.length; start += 2000) {
      const batch = missing.slice(start, start + 2000);
      const data = await this.model.getItemsData(batch, {
        attributesDefault: true,
        relations: { ReferencedSource: { attributes: true, relations: true } },
        relationsDefault: { attributes: false, relations: false },
      });
      for (let i = 0; i < batch.length; i++) {
        const codes: string[] = [];
        let system = "";
        let current: FRAGS.ItemData | undefined = data[i];
        let guard = 0;
        while (current && guard++ < 12) {
          if (categoryOfItem(current).toUpperCase() === "IFCCLASSIFICATION") {
            system = textOf(current.Name) ?? "";
            break;
          }
          const code = textOf(current.Identification) ?? textOf(current.ItemReference);
          if (code) codes.push(code);
          const parent: FRAGS.ItemData | undefined = Array.isArray(current.ReferencedSource) ? (current.ReferencedSource[0] as FRAGS.ItemData | undefined) : undefined;
          current = parent;
        }
        this.classificationRefs.set(idOf(data[i]) ?? batch[i], { system, codes });
      }
    }
  }

  classificationsOf(id: number): ClassificationRef[] {
    const result: ClassificationRef[] = [];
    for (const reference of this.classificationIdsOf(id)) {
      const entry = this.classificationRefs.get(reference);
      if (entry) result.push(entry);
    }
    return result;
  }
}

function normalise(value: unknown): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "object" && "value" in (value as object)) return normalise((value as { value: unknown }).value);
  return null;
}

function collectMaterialLabels(item: FRAGS.ItemData | undefined, out: Set<string>, depth: number) {
  if (!item || depth > 6) return;
  for (const key of ["Name", "Category", "LayerSetName"]) {
    const label = textOf(item[key]);
    if (label) out.add(label);
  }
  for (const relation of ["ForLayerSet", "MaterialLayers", "ForProfileSet", "MaterialProfiles", "MaterialConstituents", "Materials", "Material"]) {
    const value = item[relation];
    if (Array.isArray(value)) for (const child of value) collectMaterialLabels(child, out, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Facet evaluation
// ---------------------------------------------------------------------------

/** A logical UNKNOWN, an empty string and null all count as "no value". */
function hasValue(value: Scalar): boolean {
  if (value === null || value === "") return false;
  if (typeof value === "string" && value.toUpperCase() === "UNKNOWN") return false;
  return true;
}

/**
 * Predefined types an item answers to. A USERDEFINED item answers both to its
 * custom type (ObjectType / ElementType) and to the literal "USERDEFINED".
 * The occurrence wins; an unset or NOTDEFINED occurrence inherits from its type.
 */
function effectivePredefinedTypes(context: ModelContext, id: number): string[] {
  const read = (item: number, userDefinedKeys: string[]): string[] | null => {
    const values = context.attributesOf(item)?.values;
    if (!values) return null;
    const predefined = values.get("PredefinedType")?.value;
    if (typeof predefined !== "string" || predefined === "" || predefined === "NOTDEFINED") return null;
    if (predefined !== "USERDEFINED") return [predefined];
    for (const key of userDefinedKeys) {
      const custom = values.get(key)?.value;
      if (typeof custom === "string" && custom !== "") return [custom, "USERDEFINED"];
    }
    return ["USERDEFINED"];
  };
  const own = read(id, ["ObjectType", "ElementType", "ProcessType", "ResourceType"]);
  if (own) return own;
  const type = context.typeOf(id);
  if (type >= 0) {
    const inherited = read(type, ["ElementType", "ProcessType", "ResourceType", "ObjectType"]);
    if (inherited) return inherited;
  }
  const raw = context.attributesOf(id)?.values.get("PredefinedType")?.value;
  return typeof raw === "string" && raw !== "" ? [raw] : [];
}

/** Class names an item answers to: its own class and, in IFC2X3, the occurrence class implied by its type. */
function entityNames(context: ModelContext, id: number): string[] {
  const category = context.attributesOf(id)?.category ?? "";
  const names = [category];
  if (context.schema.startsWith("IFC2X3")) {
    const type = context.typeOf(id);
    const typeCategory = type >= 0 ? context.attributesOf(type)?.category : undefined;
    if (typeCategory?.endsWith("TYPE")) names.push(typeCategory.slice(0, -4));
  }
  return names;
}

function entityMatches(context: ModelContext, id: number, facet: Pick<EntityFacet, "name" | "predefinedType">): Outcome {
  const names = entityNames(context, id);
  if (!names.some((name) => matchesName(facet.name, name))) return { state: "absent", reason: `class is ${names[0] || "unknown"}` };
  if (facet.predefinedType) {
    const predefined = effectivePredefinedTypes(context, id);
    if (predefined.length === 0) return { state: "mismatch", reason: "no predefined type" };
    if (!predefined.some((value) => matchesValue(facet.predefinedType, value))) return { state: "mismatch", reason: `predefined type is ${predefined[0]}` };
  }
  return { state: "match" };
}

async function evaluateFacet(context: ModelContext, facet: IdsFacet, ids: number[]): Promise<Map<number, Outcome>> {
  const result = new Map<number, Outcome>();
  switch (facet.type) {
    case "entity": {
      await context.loadAttributes(ids);
      if (facet.predefinedType || context.schema.startsWith("IFC2X3")) {
        await context.loadRelations(ids);
        const types = ids.map((id) => context.typeOf(id)).filter((type) => type >= 0);
        await context.loadAttributes(types);
      }
      for (const id of ids) result.set(id, entityMatches(context, id, facet));
      return result;
    }
    case "attribute": {
      await context.loadAttributes(ids);
      const unresolved: number[] = [];
      for (const id of ids) {
        const values = context.attributesOf(id)?.values;
        let exists = false;
        let found = false;
        let matched = false;
        let last: Scalar = null;
        if (values) {
          for (const [name, entry] of values) {
            if (!matchesValue(facet.name, name)) continue;
            // An empty string is there (so it is not "null") but carries no value.
            if (entry.value !== null) exists = true;
            if (!hasValue(entry.value)) continue;
            found = true;
            last = entry.value;
            if (matchesValue(facet.value, entry.value)) {
              matched = true;
              break;
            }
          }
        }
        if (matched) result.set(id, { state: "match", exists: true });
        else if (found) result.set(id, { state: "mismatch", reason: `attribute value is ${JSON.stringify(last)}`, exists: true });
        else if (exists) result.set(id, { state: "mismatch", reason: "attribute is empty", exists: true });
        else unresolved.push(id);
      }
      // Attributes that reference another entity are stored as relations. They
      // count as "has a value", but a value check against an object always fails.
      if (unresolved.length > 0) {
        await context.loadRelations(unresolved);
        for (const id of unresolved) {
          const references = Object.entries(context.relationsOf(id)).some(([name, targets]) => targets.length > 0 && matchesValue(facet.name, name));
          if (!references) result.set(id, { state: "absent", reason: "attribute has no value" });
          else if (facet.value) result.set(id, { state: "mismatch", reason: "attribute references an object", exists: true });
          else result.set(id, { state: "match", exists: true });
        }
      }
      return result;
    }
    case "property": {
      await context.loadRelations(ids);
      await context.loadSets(ids);
      for (const id of ids) {
        const sets = context.setsOf(id).filter((set) => matchesValue(facet.propertySet, set.name));
        if (sets.length === 0) {
          result.set(id, { state: "absent", reason: "property set not found" });
          continue;
        }
        let outcome: Outcome = { state: "match", exists: true };
        // Every matching set must hold a matching property, and every matching property must comply.
        for (const set of sets) {
          const props = set.props.filter((prop) => matchesValue(facet.baseName, prop.name) && prop.values.some((entry) => hasValue(entry.value)));
          if (props.length === 0) {
            outcome = { state: "absent", reason: `no value in ${set.name}`, exists: true };
            break;
          }
          for (const prop of props) {
            // With a data type, only the values of that type are compared (a table has two).
            const typed = facet.dataType ? prop.values.filter((entry) => entry.type === facet.dataType) : prop.values;
            if (facet.dataType && typed.length === 0) {
              outcome = { state: "mismatch", reason: `${set.name}.${prop.name} is ${prop.values[0]?.type ?? "untyped"}, not ${facet.dataType}`, exists: true };
              break;
            }
            if (facet.value && !propertyComplies(typed.map((entry) => entry.value), Boolean(prop.bounded), facet.value)) {
              outcome = { state: "mismatch", reason: `${set.name}.${prop.name} is ${typed.map((entry) => JSON.stringify(entry.value)).join(", ")}`, exists: true };
              break;
            }
          }
          if (outcome.state !== "match") break;
        }
        result.set(id, outcome);
      }
      return result;
    }
    case "material": {
      await context.loadRelations(ids);
      await context.loadMaterials(ids);
      for (const id of ids) {
        const labels = context.materialsOf(id);
        if (labels === null) result.set(id, { state: "absent", reason: "no material" });
        else if (!facet.value || labels.some((label) => matchesValue(facet.value, label))) result.set(id, { state: "match", exists: true });
        else result.set(id, { state: "mismatch", reason: `materials are ${labels.join(", ") || "unnamed"}`, exists: true });
      }
      return result;
    }
    case "classification": {
      await context.loadRelations(ids);
      await context.loadClassifications(ids);
      for (const id of ids) {
        const all = context.classificationsOf(id);
        const references = all.filter((reference) => !facet.system || matchesValue(facet.system, reference.system));
        if (all.length === 0) result.set(id, { state: "absent", reason: "not classified" });
        else if (references.length === 0) result.set(id, { state: "mismatch", reason: `classified in ${all.map((reference) => reference.system || "(unnamed system)").join(", ")}` });
        else if (!facet.value || references.some((reference) => reference.codes.some((code) => matchesValue(facet.value, code)))) result.set(id, { state: "match", exists: true });
        else result.set(id, { state: "mismatch", reason: `classified as ${references.flatMap((reference) => reference.codes).join(", ") || "(no code)"}`, exists: true });
      }
      return result;
    }
    case "partOf": {
      const outcomes = await evaluatePartOf(context, facet, ids);
      for (const id of ids) result.set(id, outcomes.get(id) ?? { state: "absent", reason: "not part of anything" });
      return result;
    }
  }
}

function propertyComplies(values: Scalar[], bounded: boolean, constraint: IdsValue): boolean {
  const present = values.filter(hasValue);
  if (present.length === 0) return false;
  const ranged = constraint.kind === "restriction" && (constraint.minInclusive !== undefined || constraint.maxInclusive !== undefined || constraint.minExclusive !== undefined || constraint.maxExclusive !== undefined);
  // A range must hold for every value (for a bounded property: for both of its ends).
  // Anything else is satisfied by any one value: a list entry, an enumeration
  // member, or the lower bound, upper bound or set point of a bounded value.
  if (ranged) return (!bounded || present.length >= 2) && present.every((value) => matchesValue(constraint, value));
  return present.some((value) => matchesValue(constraint, value));
}

const PART_OF_RELATIONS: Record<string, string[]> = {
  IFCRELAGGREGATES: ["Decomposes"],
  IFCRELNESTS: ["Nests"],
  IFCRELCONTAINEDINSPATIALSTRUCTURE: ["ContainedInStructure"],
  IFCRELASSIGNSTOGROUP: ["HasAssignments"],
  "IFCRELVOIDSELEMENT IFCRELFILLSELEMENT": ["FillsVoids", "VoidsElements"],
};

async function evaluatePartOf(context: ModelContext, facet: PartOfFacet, ids: number[]): Promise<Map<number, Outcome>> {
  const relationNames = facet.relation ? (PART_OF_RELATIONS[facet.relation] ?? []) : [...new Set(Object.values(PART_OF_RELATIONS).flat())];
  const result = new Map<number, Outcome>();
  // Walk upwards level by level; each element keeps the frontier of wholes it reaches.
  const frontier = new Map<number, Set<number>>();
  for (const id of ids) frontier.set(id, new Set([id]));
  const reached = new Map<number, Set<number>>();
  for (const id of ids) reached.set(id, new Set());

  for (let depth = 0; depth < 12; depth++) {
    const pending = new Set<number>();
    for (const [id, nodes] of frontier) if (!result.has(id)) for (const node of nodes) pending.add(node);
    if (pending.size === 0) break;
    await context.loadRelations(pending);
    const parents = new Set<number>();
    const next = new Map<number, Set<number>>();
    for (const [id, nodes] of frontier) {
      if (result.has(id)) continue;
      const up = new Set<number>();
      for (const node of nodes) {
        const data = context.relationsOf(node);
        for (const name of relationNames) {
          for (const target of data[name] ?? []) {
            if (!reached.get(id)?.has(target)) {
              up.add(target);
              parents.add(target);
            }
          }
        }
      }
      if (up.size > 0) next.set(id, up);
    }
    if (parents.size === 0) break;
    await context.loadAttributes(parents);
    if (facet.entity.predefinedType) {
      await context.loadRelations(parents);
      await context.loadAttributes([...parents].map((parent) => context.typeOf(parent)).filter((type) => type >= 0));
    }
    for (const [id, up] of next) {
      for (const parent of up) {
        reached.get(id)?.add(parent);
        if (entityMatches(context, parent, facet.entity).state === "match") {
          result.set(id, { state: "match" });
          break;
        }
      }
    }
    frontier.clear();
    for (const [id, up] of next) if (!result.has(id)) frontier.set(id, up);
    // An explicit relation is still followed transitively (a part of a part of a wall).
  }
  for (const id of ids) {
    if (result.has(id)) continue;
    const any = (reached.get(id)?.size ?? 0) > 0;
    result.set(id, { state: any ? "mismatch" : "absent", reason: any ? "part of something else" : "not part of anything" });
  }
  return result;
}

function passes(cardinality: IdsCardinality, outcome: Outcome, hasValueConstraint: boolean): boolean {
  if (cardinality === "required") return outcome.state === "match";
  if (cardinality === "prohibited") {
    // Without a value the thing must not exist at all, even empty; with one, only that value is banned.
    return hasValueConstraint ? outcome.state !== "match" : outcome.state !== "match" && !outcome.exists;
  }
  return outcome.state !== "mismatch"; // optional: absent is fine, a wrong value is not
}

function hasValueConstraint(facet: IdsFacet): boolean {
  return (facet.type === "attribute" || facet.type === "property" || facet.type === "material" || facet.type === "classification") && facet.value !== undefined;
}

// ---------------------------------------------------------------------------
// Specification evaluation
// ---------------------------------------------------------------------------

async function applicableItems(context: ModelContext, spec: IdsSpecification): Promise<number[]> {
  const entity = spec.applicability.find((facet): facet is EntityFacet => facet.type === "entity");
  const categories = await context.allCategories();
  let candidates: number[];
  if (entity) {
    const wanted = categories.filter((category) => matchesName(entity.name, category));
    // IFC2X3 occurrences may answer to a class implied by their type (IfcFlowTerminal + IfcAirTerminalType).
    if (context.schema.startsWith("IFC2X3")) {
      for (const category of categories) {
        if (!category.endsWith("TYPE") && !wanted.includes(category) && /^IFC(FLOW|ENERGYCONVERSION|DISTRIBUTION|BUILDINGELEMENTPROXY|FURNISHINGELEMENT|ELEMENT)/.test(category)) wanted.push(category);
      }
    }
    candidates = await context.itemsOf(wanted);
  } else {
    candidates = await context.itemsOf(categories.filter((category) => !HELPER_CLASSES.test(category)));
  }
  let current = candidates;
  for (const facet of spec.applicability) {
    if (current.length === 0) break;
    const outcomes = await evaluateFacet(context, facet, current);
    current = current.filter((id) => outcomes.get(id)?.state === "match");
  }
  return current;
}

export type IdsProgress = (fraction: number, label: string) => void;

function schemaFamily(schema: string) {
  const upper = schema.toUpperCase();
  if (upper.startsWith("IFC2X3")) return "IFC2X3";
  if (upper.startsWith("IFC4X3")) return "IFC4X3";
  if (upper.startsWith("IFC4")) return "IFC4";
  return upper;
}

/** Runs every specification of an IDS document against every model. */
export async function evaluateIds(document: IdsDocument, indexes: ModelIndex[], onProgress?: IdsProgress): Promise<IdsReport> {
  const contexts: ModelContext[] = [];
  for (const index of indexes) {
    const [metadata, units] = await Promise.all([index.model.getMetadata<{ schema?: string }>().catch(() => ({ schema: undefined })), getModelUnits(index.model)]);
    contexts.push(new ModelContext(index, schemaFamily(metadata?.schema ?? ""), units));
  }

  const results: IdsSpecResult[] = [];
  for (let s = 0; s < document.specifications.length; s++) {
    const spec = document.specifications[s];
    onProgress?.(s / document.specifications.length, spec.name);
    const outcome: IdsSpecResult = {
      spec,
      status: "pass",
      applicable: {},
      passed: {},
      failed: {},
      applicableCount: 0,
      passCount: 0,
      failCount: 0,
      failures: [],
      requirementFailures: spec.requirements.map(() => 0),
    };

    // The specification is evaluated whatever schema it names (the official
    // test cases require it); a mismatch is reported as a note.
    const otherSchemas = new Set<string>();
    for (const context of contexts) {
      if (spec.ifcVersions.length > 0 && context.schema && !spec.ifcVersions.map(schemaFamily).includes(context.schema)) otherSchemas.add(context.schema);
      const ids = await applicableItems(context, spec);
      if (ids.length === 0) continue;
      const modelId = context.index.modelId;
      outcome.applicable[modelId] = ids;
      outcome.applicableCount += ids.length;

      const reasons = new Map<number, string[]>();
      for (let r = 0; r < spec.requirements.length; r++) {
        const facet = spec.requirements[r];
        const outcomes = await evaluateFacet(context, facet, ids);
        // An entity requirement has no cardinality: the item simply has to be of that class.
        const cardinality: IdsCardinality = facet.type === "entity" ? "required" : facet.cardinality;
        for (const id of ids) {
          const result = outcomes.get(id) ?? { state: "absent" as const };
          if (passes(cardinality, result, hasValueConstraint(facet))) continue;
          outcome.requirementFailures[r] += 1;
          let list = reasons.get(id);
          if (!list) reasons.set(id, (list = []));
          if (list.length < 4) {
            const lead = cardinality === "prohibited" ? "Prohibited: " : "";
            list.push(`${lead}${describeFacet(facet)}${result.reason && cardinality !== "prohibited" ? ` (${result.reason})` : ""}`);
          }
        }
      }
      const passed: number[] = [];
      const failed: number[] = [];
      for (const id of ids) {
        const list = reasons.get(id);
        if (list) {
          failed.push(id);
          if (outcome.failures.length < FAILURE_REASON_LIMIT) outcome.failures.push({ modelId, localId: id, reasons: list });
        } else passed.push(id);
      }
      if (passed.length > 0) outcome.passed[modelId] = passed;
      if (failed.length > 0) outcome.failed[modelId] = failed;
      outcome.passCount += passed.length;
      outcome.failCount += failed.length;
    }

    if (contexts.length === 0) {
      outcome.status = "skipped";
      outcome.message = "No model is loaded.";
    } else if (spec.occurrence === "prohibited") {
      // Prohibited specification: nothing may match the applicability (or, with requirements, the whole pattern).
      const offending = spec.requirements.length > 0 ? outcome.passCount : outcome.applicableCount;
      outcome.status = offending > 0 ? "fail" : "pass";
      if (offending > 0) {
        outcome.message = `${offending} item${offending === 1 ? "" : "s"} match a specification that prohibits them.`;
        if (spec.requirements.length > 0) {
          // The items that satisfy the requirements are the offenders here.
          const swap = outcome.failed;
          outcome.failed = outcome.passed;
          outcome.passed = swap;
          const count = outcome.failCount;
          outcome.failCount = outcome.passCount;
          outcome.passCount = count;
          outcome.failures = [];
        } else {
          outcome.failed = outcome.applicable;
          outcome.failCount = outcome.applicableCount;
          outcome.passed = {};
          outcome.passCount = 0;
        }
      } else if (spec.requirements.length > 0) {
        outcome.failed = {};
        outcome.failCount = 0;
        outcome.failures = [];
      }
    } else if (outcome.applicableCount === 0) {
      if (spec.occurrence === "required") {
        outcome.status = "fail";
        outcome.message = "Required, but no item in the model matches the applicability.";
      } else {
        outcome.message = "No item in the model matches the applicability.";
      }
    } else {
      outcome.status = outcome.failCount > 0 ? "fail" : "pass";
    }
    if (otherSchemas.size > 0) {
      const note = `Written for ${spec.ifcVersions.join(", ")}; checked against ${[...otherSchemas].join(", ")} anyway.`;
      outcome.message = outcome.message ? `${outcome.message} ${note}` : note;
    }
    results.push(outcome);
  }

  onProgress?.(1, "Done");
  return {
    document,
    results,
    passed: results.filter((result) => result.status === "pass").length,
    failed: results.filter((result) => result.status === "fail").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  };
}

/** Local ids that can be shown in 3D (items with geometry). */
export function selectable(indexes: ModelIndex[], items: PlainIdMap): PlainIdMap {
  const result: PlainIdMap = {};
  for (const [modelId, ids] of Object.entries(items)) {
    const index = indexes.find((candidate) => candidate.modelId === modelId);
    if (!index) continue;
    const visible = ids.filter((id) => index.rowOf(id) >= 0);
    if (visible.length > 0) result[modelId] = visible;
  }
  return result;
}

export type { PsetContent };
