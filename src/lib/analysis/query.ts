// Element queries shared by the Search panel, grouping, IDS validation and the
// assistant. A query is a list of rules, all of which must hold.
//
// Wherever possible the heavy lifting happens inside the Fragments worker
// (attribute and relation queries return only ids); values cross the thread
// boundary only for the property/quantity sets that actually matter.

import type { ModelIndex, PropertyEntry } from "@/lib/data/model-index";
import { inBatches } from "@/lib/data/model-index";
import type { PlainIdMap } from "@/lib/store";

export type Operator =
  | "exists"
  | "missing"
  | "equals"
  | "not_equals"
  | "contains"
  | "matches"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "true"
  | "false";

export const OPERATOR_LABEL: Record<Operator, string> = {
  exists: "exists",
  missing: "is missing",
  equals: "=",
  not_equals: "≠",
  contains: "contains",
  matches: "matches regex",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  true: "is true",
  false: "is false",
};

export const VALUELESS_OPERATORS = new Set<Operator>(["exists", "missing", "true", "false"]);

export type Rule =
  | { kind: "text"; text: string }
  | { kind: "class"; classes: string[] }
  | { kind: "storey"; storeys: string[] }
  | { kind: "attribute"; name: string; op: Operator; value?: string }
  | { kind: "property"; set?: string; name: string; op: Operator; value?: string }
  | { kind: "material"; text: string }
  | { kind: "type"; text: string }
  | { kind: "classification"; text: string };

export interface PropertyHit {
  set: string;
  name: string;
  value: PropertyEntry["value"];
  type?: string;
  /** True when the value comes from the element's type object. */
  fromType: boolean;
}

export function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exact(text: string) {
  return new RegExp(`^${escapeRegExp(text.trim())}$`, "i");
}

function containing(text: string) {
  return new RegExp(escapeRegExp(text.trim()), "i");
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return containing(pattern);
  }
}

/** Does `actual` satisfy `op value`? Numbers compare numerically, everything else as text. */
export function testValue(actual: PropertyEntry["value"] | undefined, op: Operator, expected?: string): boolean {
  const present = actual !== null && actual !== undefined && actual !== "";
  switch (op) {
    case "exists":
      return present;
    case "missing":
      return !present;
    case "true":
      return actual === true || (typeof actual === "string" && /^(true|yes|\.t\.)$/i.test(actual));
    case "false":
      return actual === false || (typeof actual === "string" && /^(false|no|\.f\.)$/i.test(actual));
    default:
      break;
  }
  if (!present) return op === "not_equals";
  const want = (expected ?? "").trim();
  if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
    const a = typeof actual === "number" ? actual : Number(actual);
    const b = Number(want);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
  }
  if (op === "equals" || op === "not_equals") {
    let same: boolean;
    if (typeof actual === "number") {
      const b = Number(want);
      same = Number.isFinite(b) && Math.abs(actual - b) <= 1e-9 * Math.max(1, Math.abs(actual), Math.abs(b));
    } else if (typeof actual === "boolean") {
      same = /^(true|yes|1)$/i.test(want) === actual && /^(true|yes|1|false|no|0)$/i.test(want);
    } else {
      same = String(actual).trim().toLowerCase() === want.toLowerCase();
    }
    return op === "equals" ? same : !same;
  }
  if (op === "contains") return String(actual).toLowerCase().includes(want.toLowerCase());
  if (op === "matches") return safeRegex(want).test(String(actual));
  return false;
}

/** Class match that also accepts the *StandardCase / *ElementedCase subtypes of a class. */
export function classMatches(category: string, wanted: string): boolean {
  const target = wanted.toUpperCase();
  if (category === target) return true;
  return category === `${target}STANDARDCASE` || category === `${target}ELEMENTEDCASE`;
}

function elementCategories(index: ModelIndex): RegExp[] {
  return index.categories.map((category) => new RegExp(`^${escapeRegExp(category)}$`));
}

function maskFromIds(index: ModelIndex, ids: Iterable<number>): Uint8Array {
  const mask = new Uint8Array(index.count);
  for (const id of ids) {
    const row = index.rowOf(id);
    if (row >= 0) mask[row] = 1;
  }
  return mask;
}

function invert(mask: Uint8Array): Uint8Array {
  const result = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) result[i] = mask[i] ? 0 : 1;
  return result;
}

// ---------------------------------------------------------------------------
// Property lookup
// ---------------------------------------------------------------------------

/**
 * Finds a property or quantity by name (optionally within a named set) and
 * returns its value for every element that has it, either directly or through
 * its type object. Own values win over inherited ones.
 */
export async function lookupProperty(
  index: ModelIndex,
  spec: { set?: string | RegExp; name: string | RegExp },
): Promise<Map<number, PropertyHit>> {
  const model = index.model;
  const nameRe = typeof spec.name === "string" ? exact(spec.name) : spec.name;
  const setRe = spec.set === undefined || spec.set === "" ? null : typeof spec.set === "string" ? exact(spec.set) : spec.set;
  const propertyQuery = { attributes: { queries: [{ name: /^Name$/, value: nameRe }] } };

  // 1. Sets that contain a matching property (resolved inside the worker).
  const [psetIds, qsetIds] = await Promise.all([
    model.getItemsByQuery({ categories: [/^IFCPROPERTYSET$/], relation: { name: "HasProperties", query: propertyQuery } }),
    model.getItemsByQuery({ categories: [/^IFCELEMENTQUANTITY$/], relation: { name: "Quantities", query: propertyQuery } }),
  ]);
  let setIds = [...psetIds, ...qsetIds];
  if (setIds.length === 0) return new Map();
  if (setRe) {
    const names = await index.psetNames(setIds);
    setIds = setIds.filter((id) => setRe.test(names.get(id) ?? ""));
    if (setIds.length === 0) return new Map();
  }

  // 2. The matching value inside each of those sets.
  const contents = await index.psetContents(setIds);
  const hitBySet = new Map<number, PropertyHit>();
  for (const id of setIds) {
    const content = contents.get(id);
    const prop = content?.props.find((entry) => nameRe.test(entry.name));
    if (content && prop) hitBySet.set(id, { set: content.name, name: prop.name, value: prop.value, type: prop.type, fromType: false });
  }

  // 3. Elements defined by those sets.
  const result = new Map<number, PropertyHit>();
  const matchingSets = [...hitBySet.keys()];
  await inBatches(matchingSets, 20_000, async (batch) => {
    const relations = await model.getRelations(batch);
    for (const [setId, relation] of relations) {
      const hit = hitBySet.get(setId);
      if (!hit) continue;
      for (const elementId of relation.data.DefinesOccurrence ?? []) {
        if (index.rowOf(elementId) >= 0 && !result.has(elementId)) result.set(elementId, hit);
      }
    }
  });

  // 4. Values inherited from the type object.
  const links = await index.typeLinks();
  const typeHits = new Map<number, PropertyHit>();
  for (const [typeId, sets] of links.psets) {
    for (const setId of sets) {
      const hit = hitBySet.get(setId);
      if (hit) {
        typeHits.set(typeId, { ...hit, fromType: true });
        break;
      }
    }
  }
  if (typeHits.size > 0) {
    for (let row = 0; row < index.count; row++) {
      const type = index.typeOf[row];
      if (type < 0) continue;
      const hit = typeHits.get(type);
      if (hit && !result.has(index.ids[row])) result.set(index.ids[row], hit);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

async function attributeMask(index: ModelIndex, name: string, op: Operator, value: string | undefined, candidates: Uint8Array): Promise<Uint8Array> {
  const model = index.model;
  const categories = elementCategories(index);
  const attribute = new RegExp(`^${escapeRegExp(name.trim())}$`, "i");
  const run = async (query: { name: RegExp; value?: RegExp | number | boolean }) =>
    maskFromIds(index, await model.getItemsByQuery({ categories, attributes: { queries: [query] } }));

  switch (op) {
    case "exists":
      return run({ name: attribute });
    case "missing":
      return invert(await run({ name: attribute }));
    case "true":
      return run({ name: attribute, value: true });
    case "false":
      return run({ name: attribute, value: false });
    case "contains":
      return run({ name: attribute, value: containing(value ?? "") });
    case "matches":
      return run({ name: attribute, value: safeRegex(value ?? "") });
    case "equals":
    case "not_equals": {
      const text = await run({ name: attribute, value: exact(value ?? "") });
      const number = Number(value);
      if (value !== undefined && value.trim() !== "" && Number.isFinite(number)) {
        const numeric = await run({ name: attribute, value: number });
        for (let i = 0; i < text.length; i++) text[i] |= numeric[i];
      }
      return op === "equals" ? text : invert(text);
    }
    default: {
      // Numeric comparison: the values have to be read.
      const ids: number[] = [];
      for (let row = 0; row < index.count; row++) if (candidates[row]) ids.push(index.ids[row]);
      const values = await index.attribute(ids, canonicalAttribute(name));
      const mask = new Uint8Array(index.count);
      for (const [id, actual] of values) if (testValue(actual, op, value)) mask[index.rowOf(id)] = 1;
      return mask;
    }
  }
}

const KNOWN_ATTRIBUTES = ["Name", "Description", "ObjectType", "Tag", "PredefinedType", "LongName", "OverallHeight", "OverallWidth", "Elevation"];

function canonicalAttribute(name: string) {
  const lower = name.trim().toLowerCase();
  return KNOWN_ATTRIBUTES.find((known) => known.toLowerCase() === lower) ?? name.trim();
}

async function textMask(index: ModelIndex, text: string): Promise<Uint8Array> {
  const model = index.model;
  const needle = text.trim();
  const mask = new Uint8Array(index.count);
  if (!needle) return mask.fill(1);
  const pattern = containing(needle);

  const ids = await model.getItemsByQuery({
    categories: elementCategories(index),
    attributes: { queries: [{ name: /^(Name|Tag|ObjectType|LongName|Description|PredefinedType)$/, value: pattern }] },
  });
  for (const id of ids) {
    const row = index.rowOf(id);
    if (row >= 0) mask[row] = 1;
  }

  // Class names ("wall", "IfcDoor").
  const classNeedle = needle.toUpperCase().replace(/\s+/g, "");
  index.categories.forEach((category, categoryIndex) => {
    if (!category.includes(classNeedle) && !category.replace(/^IFC/, "").includes(classNeedle)) return;
    for (let row = 0; row < index.count; row++) if (index.categoryOf[row] === categoryIndex) mask[row] = 1;
  });

  // Type names.
  const typeIds = await model.getItemsByQuery({
    categories: [/(TYPE|STYLE)$/],
    attributes: { queries: [{ name: /^Name$/, value: pattern }] },
  });
  if (typeIds.length > 0) {
    const types = new Set(typeIds);
    for (let row = 0; row < index.count; row++) if (types.has(index.typeOf[row])) mask[row] = 1;
  }

  // GlobalId (22 characters) and "#123" / "123" express ids.
  if (/^[0-9A-Za-z_$]{22}$/.test(needle)) {
    const [localId] = await model.getLocalIdsByGuids([needle]);
    if (typeof localId === "number") {
      const row = index.rowOf(localId);
      if (row >= 0) mask[row] = 1;
    }
  }
  const idMatch = /^#?(\d+)$/.exec(needle);
  if (idMatch) {
    const row = index.rowOf(Number(idMatch[1]));
    if (row >= 0) mask[row] = 1;
  }
  return mask;
}

async function ruleMask(index: ModelIndex, rule: Rule, candidates: Uint8Array): Promise<Uint8Array> {
  const count = index.count;
  switch (rule.kind) {
    case "text":
      return textMask(index, rule.text);
    case "class": {
      const mask = new Uint8Array(count);
      const wanted = rule.classes.map((name) => name.toUpperCase());
      const allowed = index.categories.map((category) => wanted.some((name) => classMatches(category, name)));
      for (let row = 0; row < count; row++) if (allowed[index.categoryOf[row]]) mask[row] = 1;
      return mask;
    }
    case "storey": {
      const mask = new Uint8Array(count);
      const wanted = new Set(rule.storeys.map((name) => name.trim().toLowerCase()));
      const ids = new Set(index.storeys.filter((storey) => wanted.has(storey.name.trim().toLowerCase())).map((storey) => storey.localId));
      const includeNone = wanted.has("no storey");
      for (let row = 0; row < count; row++) {
        const storey = index.storeyOf[row];
        if (storey < 0 ? includeNone : ids.has(storey)) mask[row] = 1;
      }
      return mask;
    }
    case "attribute":
      return attributeMask(index, rule.name, rule.op, rule.value, candidates);
    case "property": {
      const hits = await lookupProperty(index, { set: rule.set, name: rule.name });
      const mask = new Uint8Array(count);
      for (let row = 0; row < count; row++) {
        const hit = hits.get(index.ids[row]);
        if (testValue(hit?.value, rule.op, rule.value)) mask[row] = 1;
      }
      return mask;
    }
    case "material": {
      const mask = new Uint8Array(count);
      const needle = rule.text.trim().toLowerCase();
      const [names, links] = await Promise.all([index.materialNames(), index.typeLinks()]);
      const matches = new Map<number, boolean>();
      for (const [association, list] of names) matches.set(association, list.some((name) => name.toLowerCase().includes(needle)));
      for (let row = 0; row < count; row++) {
        const associations = index.materialsOfRow(row, links);
        for (let i = 0; i < associations.length; i++) {
          if (matches.get(associations[i])) {
            mask[row] = 1;
            break;
          }
        }
      }
      return mask;
    }
    case "type": {
      const mask = new Uint8Array(count);
      const typeIds = new Set<number>();
      for (let row = 0; row < count; row++) if (index.typeOf[row] >= 0) typeIds.add(index.typeOf[row]);
      const names = await index.names(typeIds);
      const needle = rule.text.trim().toLowerCase();
      for (let row = 0; row < count; row++) {
        const type = index.typeOf[row];
        if (type >= 0 && (names.get(type) ?? "").toLowerCase().includes(needle)) mask[row] = 1;
      }
      return mask;
    }
    case "classification": {
      const mask = new Uint8Array(count);
      const needle = rule.text.trim().toLowerCase();
      const [info, links] = await Promise.all([index.classificationInfo(), index.typeLinks()]);
      for (let row = 0; row < count; row++) {
        const references = index.classificationsOfRow(row, links);
        for (let i = 0; i < references.length; i++) {
          const entry = info.get(references[i]);
          if (!entry) continue;
          if (!needle || `${entry.system} ${entry.code} ${entry.name}`.toLowerCase().includes(needle)) {
            mask[row] = 1;
            break;
          }
        }
      }
      return mask;
    }
  }
}

/** Runs a rule list against one model and returns the matching element local ids. */
export async function queryIndex(index: ModelIndex, rules: Rule[]): Promise<number[]> {
  const mask = new Uint8Array(index.count).fill(1);
  // Cheap, index-only rules first so later rules see fewer candidates.
  const order: Rule["kind"][] = ["class", "storey", "text", "attribute", "type", "material", "classification", "property"];
  const sorted = [...rules].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const rule of sorted) {
    const next = await ruleMask(index, rule, mask);
    let any = false;
    for (let row = 0; row < mask.length; row++) {
      mask[row] &= next[row];
      any ||= mask[row] === 1;
    }
    if (!any) return [];
  }
  const ids: number[] = [];
  for (let row = 0; row < mask.length; row++) if (mask[row]) ids.push(index.ids[row]);
  return ids;
}

/** Runs a rule list against every model. */
export async function runQuery(indexes: ModelIndex[], rules: Rule[]): Promise<PlainIdMap> {
  const result: PlainIdMap = {};
  for (const index of indexes) {
    const ids = await queryIndex(index, rules);
    if (ids.length > 0) result[index.modelId] = ids;
  }
  return result;
}

export function describeRule(rule: Rule): string {
  switch (rule.kind) {
    case "text":
      return `Text "${rule.text}"`;
    case "class":
      return `Class is ${rule.classes.join(" or ")}`;
    case "storey":
      return `Storey is ${rule.storeys.join(" or ")}`;
    case "attribute":
      return `${rule.name} ${OPERATOR_LABEL[rule.op]}${VALUELESS_OPERATORS.has(rule.op) ? "" : ` ${rule.value ?? ""}`}`;
    case "property":
      return `${rule.set ? `${rule.set}.` : ""}${rule.name} ${OPERATOR_LABEL[rule.op]}${VALUELESS_OPERATORS.has(rule.op) ? "" : ` ${rule.value ?? ""}`}`;
    case "material":
      return `Material contains "${rule.text}"`;
    case "type":
      return `Type contains "${rule.text}"`;
    case "classification":
      return rule.text ? `Classification contains "${rule.text}"` : "Has a classification";
  }
}
