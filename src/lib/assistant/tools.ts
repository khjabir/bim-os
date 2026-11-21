// Tools the assistant can call. They run in the browser against the loaded
// models, so the model data never leaves the page except as the compact JSON
// results returned here.

import { runHealthChecks } from "@/lib/analysis/checks";
import { groupElements, type GroupFacet } from "@/lib/analysis/grouping";
import { lookupProperty, runQuery, type Operator, type Rule } from "@/lib/analysis/query";
import { getModelQuantities, quantityGroups } from "@/lib/analysis/quantities";
import { getModelIndex, type ModelIndex } from "@/lib/data/model-index";
import { getElementDetails } from "@/lib/data/properties";
import { getModelUnits } from "@/lib/data/units";
import type { ViewerEngine } from "@/lib/engine/engine";
import { useViewerStore, type PlainIdMap } from "@/lib/store";
import { prettyCategory } from "@/lib/utils/format";
import { seriesColor } from "@/lib/utils/palette";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const OPERATORS: Operator[] = ["exists", "missing", "equals", "not_equals", "contains", "matches", "gt", "gte", "lt", "lte", "true", "false"];

const FILTERS_SCHEMA = {
  type: "object",
  description: "All given conditions must hold (AND). Omit the whole object to address every element.",
  properties: {
    classes: { type: "array", items: { type: "string" }, description: "IFC classes in upper case, e.g. [\"IFCWALL\", \"IFCDOOR\"]. IFCWALL also matches IFCWALLSTANDARDCASE." },
    storeys: { type: "array", items: { type: "string" }, description: "Storey names exactly as returned by get_model_overview. Use \"No storey\" for elements outside any storey." },
    text: { type: "string", description: "Free text matched against name, tag, object type, description, class name and type name." },
    material: { type: "string", description: "Material name contains this text." },
    type_name: { type: "string", description: "Type object name contains this text." },
    attribute: {
      type: "object",
      description: "Condition on a direct IFC attribute such as Name, Tag, ObjectType, PredefinedType, Description.",
      properties: { name: { type: "string" }, operator: { type: "string", enum: OPERATORS }, value: { type: "string" } },
      required: ["name", "operator"],
    },
    properties: {
      type: "array",
      description: "Conditions on properties or quantities, e.g. {set: \"Pset_WallCommon\", name: \"IsExternal\", operator: \"true\"}. Values from the type object count too.",
      items: {
        type: "object",
        properties: {
          set: { type: "string", description: "Property or quantity set name. Optional: omit to search every set." },
          name: { type: "string", description: "Property or quantity name, exact." },
          operator: { type: "string", enum: OPERATORS },
          value: { type: "string", description: "Comparison value as text; not needed for exists, missing, true, false." },
        },
        required: ["name", "operator"],
      },
    },
    result_id: { type: "string", description: "Restrict to the elements of an earlier result." },
  },
} as const;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_model_overview",
    description: "Summary of every loaded model: schema, authoring tool, units, element counts per IFC class, and the storeys with their elevations. Call this first when you do not yet know the model.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_elements",
    description: "Finds elements matching filters. Returns the count, a breakdown by class and storey, a few sample elements, and a result_id that other tools accept to act on exactly these elements.",
    input_schema: {
      type: "object",
      properties: { filters: FILTERS_SCHEMA, sample_size: { type: "integer", description: "How many sample elements to list (default 10, max 40)." } },
    },
  },
  {
    name: "get_element_details",
    description: "Everything known about one element: attributes, type, storey, materials, classification, property sets and quantity sets.",
    input_schema: {
      type: "object",
      properties: { element: { type: "string", description: "An element reference from find_elements (\"model#id\") or an IFC GlobalId." } },
      required: ["element"],
    },
  },
  {
    name: "get_property_values",
    description: "Distribution of one property or quantity across elements: how many elements have it, the distinct values with counts, and min / max / sum / mean when numeric.",
    input_schema: {
      type: "object",
      properties: {
        set: { type: "string", description: "Property or quantity set name (optional)." },
        name: { type: "string", description: "Property or quantity name, exact." },
        filters: FILTERS_SCHEMA,
      },
      required: ["name"],
    },
  },
  {
    name: "get_quantities",
    description: "Quantity take-off: element count and summed volume (m3), area (m2) and length (m) per group. Quantities come from the model's quantity sets and measured properties; coverage tells how many elements carried each one.",
    input_schema: {
      type: "object",
      properties: {
        group_by: { type: "string", enum: ["class", "storey", "type", "material", "model"], description: "Grouping facet." },
        filters: FILTERS_SCHEMA,
      },
      required: ["group_by"],
    },
  },
  {
    name: "group_elements",
    description: "Counts elements per group of a facet. For facet \"property\" give the property to group by. Each group gets a result_id.",
    input_schema: {
      type: "object",
      properties: {
        facet: { type: "string", enum: ["class", "storey", "type", "material", "classification", "model", "property"] },
        property: { type: "object", properties: { set: { type: "string" }, name: { type: "string" } }, required: ["name"] },
        filters: FILTERS_SCHEMA,
      },
      required: ["facet"],
    },
  },
  {
    name: "run_health_checks",
    description: "Runs the data-quality checks (missing property sets, materials, names, duplicate GlobalIds, duplicate geometry, unplaced elements and more) and returns each check with its failing count and a result_id for the failing elements, plus inferred facts about the model.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_selection",
    description: "What the user currently has selected in the 3D view, with a result_id for it.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "show_in_viewer",
    description: "Acts on the 3D view for the elements of a result: select them, isolate them (hide everything else), hide them, x-ray everything else, zoom to them, or colour them.",
    input_schema: {
      type: "object",
      properties: {
        result_id: { type: "string" },
        action: { type: "string", enum: ["select", "isolate", "hide", "xray", "zoom", "color"] },
        color: { type: "string", description: "For action \"color\": a hex colour such as #e34948. Omit to use the default highlight colour." },
      },
      required: ["result_id", "action"],
    },
  },
  {
    name: "reset_viewer",
    description: "Shows every element again, removes colours and x-ray, and clears the selection.",
    input_schema: { type: "object", properties: {} },
  },
];

export const SYSTEM_PROMPT = `You are the model analyst built into IFC Studio, a browser viewer for BIM models (IFC, and Revit files converted to IFC). The user is looking at one or more loaded models and asks questions about them or asks you to show things in the 3D view.

How to work:
- Every fact about the model must come from a tool result in this conversation. Never estimate counts, quantities or property values, and never invent element names.
- Start with get_model_overview when you do not yet know which classes, storeys and units the model has. Use the class and storey names exactly as it returns them.
- find_elements returns a result_id. Pass that id to show_in_viewer, get_quantities, get_property_values or group_elements to work on the same elements.
- When the user asks to see, show, highlight, isolate or find something in the model, call show_in_viewer so the 3D view changes, then say what you did in one sentence.
- IFC classes are upper case (IFCWALL, IFCDOOR, IFCSLAB, IFCBEAM, IFCCOLUMN, IFCWINDOW, IFCSPACE, IFCBUILDINGELEMENTPROXY ...). IFCWALL also covers IFCWALLSTANDARDCASE.
- Standard properties live in sets such as Pset_WallCommon (IsExternal, LoadBearing, FireRating), Pset_DoorCommon, Pset_SlabCommon, Pset_SpaceCommon. Models often lack them or use custom sets: if a lookup returns nothing, say so, and use get_element_details on a sample element to see which sets exist before trying another name.
- Quantities are in SI units (m, m2, m3). Report the coverage: if only part of the elements carried a quantity, the total is a lower bound and you must say that.
- A count of zero is an answer. Report it plainly instead of guessing at a different interpretation.

How to answer:
- Lead with the answer, then the few numbers that support it. Short paragraphs or a small table; no preamble and no summary of the tools you used.
- Round quantities sensibly (two or three significant digits) and always give the unit.
- If the question cannot be answered from the model data, say what is missing.`;

// ---------------------------------------------------------------------------

export interface AssistantRuntime {
  engine: ViewerEngine;
  results: Map<string, PlainIdMap>;
  counter: number;
}

export function createRuntime(engine: ViewerEngine): AssistantRuntime {
  return { engine, results: new Map(), counter: 0 };
}

export interface ToolOutcome {
  /** JSON-serialisable result returned to the model. */
  output: unknown;
  /** One short line shown to the user in the chat. */
  summary: string;
  isError?: boolean;
  /** Elements this call found, so the chat can offer to select them in 3D. */
  items?: PlainIdMap;
}

interface Filters {
  classes?: string[];
  storeys?: string[];
  text?: string;
  material?: string;
  type_name?: string;
  attribute?: { name: string; operator: Operator; value?: string };
  properties?: { set?: string; name: string; operator: Operator; value?: string }[];
  result_id?: string;
}

function countOf(map: PlainIdMap) {
  let total = 0;
  for (const ids of Object.values(map)) total += ids.length;
  return total;
}

function intersect(a: PlainIdMap, b: PlainIdMap): PlainIdMap {
  const result: PlainIdMap = {};
  for (const [modelId, ids] of Object.entries(a)) {
    const other = b[modelId];
    if (!other) continue;
    const allowed = new Set(other);
    const kept = ids.filter((id) => allowed.has(id));
    if (kept.length > 0) result[modelId] = kept;
  }
  return result;
}

async function indexesOf(runtime: AssistantRuntime): Promise<ModelIndex[]> {
  const indexes: ModelIndex[] = [];
  for (const model of runtime.engine.models) indexes.push(await getModelIndex(model));
  return indexes;
}

function remember(runtime: AssistantRuntime, items: PlainIdMap, id?: string): string {
  const key = id ?? `r${++runtime.counter}`;
  runtime.results.set(key, items);
  return key;
}

function toRules(filters: Filters | undefined): Rule[] {
  const rules: Rule[] = [];
  if (!filters) return rules;
  if (filters.classes?.length) rules.push({ kind: "class", classes: filters.classes.map((name) => name.toUpperCase().replace(/\s+/g, "")) });
  if (filters.storeys?.length) rules.push({ kind: "storey", storeys: filters.storeys });
  if (filters.text?.trim()) rules.push({ kind: "text", text: filters.text });
  if (filters.material?.trim()) rules.push({ kind: "material", text: filters.material });
  if (filters.type_name?.trim()) rules.push({ kind: "type", text: filters.type_name });
  if (filters.attribute?.name) rules.push({ kind: "attribute", name: filters.attribute.name, op: filters.attribute.operator, value: filters.attribute.value });
  for (const property of filters.properties ?? []) {
    if (property?.name) rules.push({ kind: "property", set: property.set || undefined, name: property.name, op: property.operator, value: property.value });
  }
  return rules;
}

async function resolve(runtime: AssistantRuntime, indexes: ModelIndex[], filters: Filters | undefined): Promise<PlainIdMap> {
  const rules = toRules(filters);
  let items: PlainIdMap;
  if (rules.length === 0) {
    items = {};
    for (const index of indexes) items[index.modelId] = Array.from(index.ids);
  } else {
    items = await runQuery(indexes, rules);
  }
  if (filters?.result_id) {
    const previous = runtime.results.get(filters.result_id);
    if (!previous) throw new Error(`Unknown result_id "${filters.result_id}".`);
    items = intersect(items, previous);
  }
  return items;
}

function breakdown(indexes: ModelIndex[], items: PlainIdMap, by: "class" | "storey", limit = 12) {
  const counts = new Map<string, number>();
  for (const index of indexes) {
    for (const id of items[index.modelId] ?? []) {
      const row = index.rowOf(id);
      if (row < 0) continue;
      const label = by === "class" ? index.category(row) : index.storeyName(index.storeyOf[row]);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const result: Record<string, number> = {};
  for (const [label, count] of sorted.slice(0, limit)) result[label] = count;
  if (sorted.length > limit) result[`(${sorted.length - limit} more)`] = sorted.slice(limit).reduce((sum, [, count]) => sum + count, 0);
  return result;
}

async function sample(indexes: ModelIndex[], items: PlainIdMap, size: number) {
  const rows: { element: string; class: string; name: string; storey: string }[] = [];
  for (const index of indexes) {
    const ids = (items[index.modelId] ?? []).slice(0, Math.max(0, size - rows.length));
    if (ids.length === 0) continue;
    const names = await index.names(ids);
    for (const id of ids) {
      const row = index.rowOf(id);
      rows.push({
        element: `${index.modelId}#${id}`,
        class: row >= 0 ? index.category(row) : "",
        name: names.get(id) ?? "",
        storey: row >= 0 ? index.storeyName(index.storeyOf[row]) : "",
      });
    }
    if (rows.length >= size) break;
  }
  return rows;
}

const round = (value: number, digits = 3) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function plural(count: number, noun: string) {
  return `${new Intl.NumberFormat("en-US").format(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** Runs one tool call. Errors are returned to the model so it can correct itself. */
export async function executeTool(runtime: AssistantRuntime, name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    return await run(runtime, name, input ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: { error: message }, summary: `${name} failed: ${message}`, isError: true };
  }
}

async function run(runtime: AssistantRuntime, name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  const { engine } = runtime;
  if (engine.models.length === 0 && name !== "reset_viewer") {
    return { output: { error: "No model is loaded. Ask the user to open a model first." }, summary: "No model loaded", isError: true };
  }
  const indexes = await indexesOf(runtime);
  const modelNames = Object.fromEntries(useViewerStore.getState().models.map((model) => [model.id, model.name]));

  switch (name) {
    case "get_model_overview": {
      const models = [];
      for (const index of indexes) {
        const [metadata, units] = await Promise.all([index.model.getMetadata<{ schema?: string; names?: string[] }>().catch(() => ({}) as { schema?: string; names?: string[] }), getModelUnits(index.model)]);
        const classes: Record<string, number> = {};
        for (const [category, rows] of [...index.rowsByCategory().entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 60)) classes[category] = rows.length;
        const perStorey = new Map<number, number>();
        for (let row = 0; row < index.count; row++) perStorey.set(index.storeyOf[row], (perStorey.get(index.storeyOf[row]) ?? 0) + 1);
        models.push({
          model: index.modelId,
          file: modelNames[index.modelId] ?? index.modelId,
          schema: metadata.schema ?? "unknown",
          authored_with: metadata.names?.[5] ?? "unknown",
          length_unit: units.declared ? units.length.symbol : "not declared",
          elements: index.count,
          classes,
          storeys: [
            ...index.storeys.map((storey) => ({ name: storey.name, elevation_m: storey.elevation === null ? null : round(storey.elevation, 2), elements: perStorey.get(storey.localId) ?? 0 })),
            ...(perStorey.get(-1) ? [{ name: "No storey", elevation_m: null, elements: perStorey.get(-1) ?? 0 }] : []),
          ],
        });
      }
      return { output: { models }, summary: `Read the overview of ${plural(models.length, "model")}` };
    }

    case "find_elements": {
      const filters = input.filters as Filters | undefined;
      const items = await resolve(runtime, indexes, filters);
      const count = countOf(items);
      const size = Math.min(40, Math.max(0, Number(input.sample_size ?? 10) || 10));
      const resultId = remember(runtime, items);
      return {
        output: { result_id: resultId, count, by_class: breakdown(indexes, items, "class"), by_storey: breakdown(indexes, items, "storey"), sample: await sample(indexes, items, size) },
        summary: `Found ${plural(count, "element")}`,
        items: count > 0 ? items : undefined,
      };
    }

    case "get_element_details": {
      const reference = String(input.element ?? "").trim();
      let modelId = "";
      let localId = NaN;
      const hash = reference.lastIndexOf("#");
      if (hash > 0) {
        modelId = reference.slice(0, hash);
        localId = Number(reference.slice(hash + 1));
      }
      if (!engine.getModel(modelId) || !Number.isFinite(localId)) {
        // Maybe a GlobalId.
        for (const index of indexes) {
          const [found] = await index.model.getLocalIdsByGuids([reference]);
          if (typeof found === "number") {
            modelId = index.modelId;
            localId = found;
            break;
          }
        }
      }
      const model = engine.getModel(modelId);
      if (!model || !Number.isFinite(localId)) throw new Error(`No element matches "${reference}". Use an element reference from find_elements or a GlobalId.`);
      const details = await getElementDetails(model, localId);
      if (!details) throw new Error("That element has no readable data.");
      const sets: Record<string, Record<string, unknown>> = {};
      for (const set of [...details.psets, ...details.qsets, ...(details.type?.psets ?? [])].slice(0, 30)) {
        const props: Record<string, unknown> = {};
        for (const prop of set.props.slice(0, 40)) {
          props[prop.name] = typeof prop.value === "number" ? round(prop.value, 4) : typeof prop.value === "string" && prop.value.length > 160 ? `${prop.value.slice(0, 160)}…` : prop.value;
        }
        sets[set.name] = props;
      }
      return {
        output: {
          element: `${modelId}#${localId}`,
          class: details.category,
          global_id: details.guid,
          attributes: Object.fromEntries(details.attributes.map((attribute) => [attribute.name, attribute.value])),
          storey_or_container: details.container ? { class: details.container.category, name: details.container.name } : null,
          type: details.type ? { class: details.type.category, name: details.type.name } : null,
          materials: details.materials.map((material) => (material.detail ? `${material.name} (${material.detail})` : material.name)),
          classification: details.classifications,
          sets,
        },
        summary: `Read ${prettyCategory(details.category)} "${details.name || localId}"`,
      };
    }

    case "get_property_values": {
      const propertyName = String(input.name ?? "").trim();
      if (!propertyName) throw new Error("name is required.");
      const scope = await resolve(runtime, indexes, input.filters as Filters | undefined);
      const counts = new Map<string, number>();
      const numbers: number[] = [];
      const setsSeen = new Set<string>();
      let found = 0;
      let missing = 0;
      for (const index of indexes) {
        const ids = scope[index.modelId] ?? [];
        if (ids.length === 0) continue;
        const hits = await lookupProperty(index, { set: (input.set as string | undefined) || undefined, name: propertyName });
        for (const id of ids) {
          const hit = hits.get(id);
          if (!hit || hit.value === null || hit.value === "") {
            missing += 1;
            continue;
          }
          found += 1;
          setsSeen.add(hit.set);
          if (typeof hit.value === "number") numbers.push(hit.value);
          const key = typeof hit.value === "number" ? String(round(hit.value, 4)) : String(hit.value);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      const values = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const numeric =
        numbers.length > 0 && numbers.length === found
          ? { min: round(Math.min(...numbers)), max: round(Math.max(...numbers)), sum: round(numbers.reduce((sum, value) => sum + value, 0)), mean: round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length) }
          : undefined;
      return {
        output: {
          property: propertyName,
          found_in_sets: [...setsSeen].slice(0, 12),
          elements_with_value: found,
          elements_without_value: missing,
          distinct_values: values.length,
          values: values.slice(0, 40).map(([value, count]) => ({ value, count })),
          numeric,
          note: numeric ? "Numeric values are in the model's own units (see length_unit in the overview)." : undefined,
        },
        summary: `Read ${propertyName} on ${plural(found, "element")}`,
      };
    }

    case "get_quantities": {
      const facet = String(input.group_by ?? "class") as GroupFacet;
      const scope = await resolve(runtime, indexes, input.filters as Filters | undefined);
      const quantities = [];
      for (const index of indexes) quantities.push(await getModelQuantities(index, { includeProperties: true }));
      const groups = await quantityGroups(quantities, facet, { scope, modelNames });
      groups.sort((a, b) => b.count - a.count);
      const totals = { count: 0, volume_m3: 0, area_m2: 0, length_m: 0 };
      const coverage = { volume: 0, area: 0, length: 0 };
      for (const model of quantities) {
        const allowed = new Set(scope[model.index.modelId] ?? []);
        for (let row = 0; row < model.index.count; row++) {
          if (!allowed.has(model.index.ids[row])) continue;
          totals.count += 1;
          if (Number.isFinite(model.volume[row])) {
            totals.volume_m3 += model.volume[row];
            coverage.volume += 1;
          }
          if (Number.isFinite(model.area[row])) {
            totals.area_m2 += model.area[row];
            coverage.area += 1;
          }
          if (Number.isFinite(model.length[row])) {
            totals.length_m += model.length[row];
            coverage.length += 1;
          }
        }
      }
      return {
        output: {
          group_by: facet,
          groups: groups.slice(0, 40).map((group) => ({
            group: group.label,
            count: group.count,
            volume_m3: group.covered.volume > 0 ? round(group.volume, 2) : null,
            area_m2: group.covered.area > 0 ? round(group.area, 2) : null,
            length_m: group.covered.length > 0 ? round(group.length, 2) : null,
            elements_with_volume: group.covered.volume,
            elements_with_area: group.covered.area,
          })),
          groups_omitted: Math.max(0, groups.length - 40),
          totals: { count: totals.count, volume_m3: round(totals.volume_m3, 2), area_m2: round(totals.area_m2, 2), length_m: round(totals.length_m, 2) },
          coverage: { elements: totals.count, with_volume: coverage.volume, with_area: coverage.area, with_length: coverage.length },
          note: "null means no element of the group carries that quantity. Totals only include elements that carry the quantity.",
        },
        summary: `Took off quantities for ${plural(totals.count, "element")} by ${facet}`,
      };
    }

    case "group_elements": {
      const facet = String(input.facet ?? "class") as GroupFacet;
      const property = input.property as { set?: string; name: string } | undefined;
      if (facet === "property" && !property?.name) throw new Error("property.name is required for facet \"property\".");
      const scope = await resolve(runtime, indexes, input.filters as Filters | undefined);
      const groups = await groupElements(indexes, facet, { property, scope, modelNames });
      return {
        output: {
          facet,
          group_count: groups.length,
          groups: groups.slice(0, 40).map((group) => ({ group: group.label, count: group.count, result_id: remember(runtime, group.items) })),
          groups_omitted: Math.max(0, groups.length - 40),
        },
        summary: `Grouped by ${facet}: ${plural(groups.length, "group")}`,
      };
    }

    case "run_health_checks": {
      const report = await runHealthChecks(indexes);
      return {
        output: {
          score_out_of_100: report.score,
          elements: report.elementCount,
          inferred: Object.fromEntries(report.insights.map((insight) => [insight.label, insight.hint ? `${insight.value} (${insight.hint})` : insight.value])),
          checks: report.checks.map((check) => ({
            check: check.title,
            severity: check.severity,
            failing: check.failCount,
            checked: check.scope,
            most_affected: check.failCount > 0 ? check.detail : undefined,
            result_id: check.failCount > 0 ? remember(runtime, check.failing, `check-${check.id}`) : undefined,
          })),
        },
        summary: `Ran ${report.checks.length} health checks (score ${report.score})`,
      };
    }

    case "get_selection": {
      const selection = useViewerStore.getState().selection;
      const count = countOf(selection);
      if (count === 0) return { output: { count: 0, note: "Nothing is selected." }, summary: "Nothing selected" };
      const resultId = remember(runtime, selection, "selection");
      return {
        output: { result_id: resultId, count, by_class: breakdown(indexes, selection, "class"), by_storey: breakdown(indexes, selection, "storey"), sample: await sample(indexes, selection, 10) },
        summary: `Read the selection (${plural(count, "element")})`,
        items: selection,
      };
    }

    case "show_in_viewer": {
      const resultId = String(input.result_id ?? "");
      const stored = runtime.results.get(resultId);
      if (!stored) throw new Error(`Unknown result_id "${resultId}". Call find_elements first.`);
      // Results can outlive a model the user has since closed.
      const items: PlainIdMap = {};
      for (const [modelId, ids] of Object.entries(stored)) if (engine.getModel(modelId) && ids.length > 0) items[modelId] = ids;
      const count = countOf(items);
      if (count === 0) return { output: { done: false, note: "That result is empty; nothing to show." }, summary: "Nothing to show" };
      const action = String(input.action ?? "select");
      switch (action) {
        case "select":
          await engine.select(items, { zoom: true });
          break;
        case "isolate":
          await engine.isolate(items);
          break;
        case "hide":
          await engine.hide(items);
          break;
        case "xray":
          await engine.ghostExcept(items);
          break;
        case "zoom":
          await engine.fitTo(items);
          break;
        case "color": {
          const color = typeof input.color === "string" && /^#[0-9a-fA-F]{6}$/.test(input.color) ? input.color : seriesColor(1);
          await engine.colorize(items, color);
          break;
        }
        default:
          throw new Error(`Unknown action "${action}".`);
      }
      const verbs: Record<string, string> = { select: "Selected", isolate: "Isolated", hide: "Hid", xray: "X-rayed everything except", zoom: "Zoomed to", color: "Coloured" };
      return { output: { done: true, action, elements: count }, summary: `${verbs[action]} ${plural(count, "element")} in 3D`, items };
    }

    case "reset_viewer": {
      await engine.showAll();
      await engine.resetColors();
      await engine.clearSelection();
      return { output: { done: true }, summary: "Reset the 3D view" };
    }

    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}
