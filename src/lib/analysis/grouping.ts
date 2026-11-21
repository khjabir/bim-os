// Groups elements by a facet (class, storey, type, material, ...). Used by the
// Groups panel, quantity take-off and the assistant.

import type { ModelIndex } from "@/lib/data/model-index";
import type { PlainIdMap } from "@/lib/store";
import { prettyCategory } from "@/lib/utils/format";
import { lookupProperty } from "./query";

export type GroupFacet = "class" | "storey" | "type" | "material" | "classification" | "model" | "property";

export const FACET_LABEL: Record<GroupFacet, string> = {
  class: "IFC class",
  storey: "Storey",
  type: "Type",
  material: "Material",
  classification: "Classification",
  model: "Model",
  property: "Property value",
};

export interface ElementGroup {
  /** Stable key (the label, lower-cased); colours follow this, not the rank. */
  key: string;
  label: string;
  items: PlainIdMap;
  count: number;
}

export interface GroupOptions {
  /** For the "property" facet. */
  property?: { set?: string; name: string };
  /** Restricts grouping to these elements. */
  scope?: PlainIdMap;
  modelNames?: Record<string, string>;
}

const NONE: Record<GroupFacet, string> = {
  class: "Unknown class",
  storey: "No storey",
  type: "No type",
  material: "No material",
  classification: "Not classified",
  model: "Model",
  property: "(not set)",
};

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return NONE.property;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  return String(value);
}

/**
 * Returns, for every row of `index`, the labels it belongs to. Most facets give
 * exactly one label per element; materials can give several.
 */
export async function labelsForRows(index: ModelIndex, facet: GroupFacet, options: GroupOptions = {}): Promise<(row: number) => string[]> {
  switch (facet) {
    case "class":
      return (row) => [prettyCategory(index.category(row))];
    case "storey":
      return (row) => [index.storeyName(index.storeyOf[row])];
    case "model": {
      const name = options.modelNames?.[index.modelId] ?? index.modelId;
      return () => [name];
    }
    case "type": {
      const typeIds = new Set<number>();
      for (let row = 0; row < index.count; row++) if (index.typeOf[row] >= 0) typeIds.add(index.typeOf[row]);
      const names = await index.names(typeIds);
      return (row) => {
        const type = index.typeOf[row];
        return [type >= 0 ? names.get(type) || `Type #${type}` : NONE.type];
      };
    }
    case "material": {
      const [names, links] = await Promise.all([index.materialNames(), index.typeLinks()]);
      return (row) => {
        const associations = index.materialsOfRow(row, links);
        const labels = new Set<string>();
        for (let i = 0; i < associations.length; i++) for (const name of names.get(associations[i]) ?? []) labels.add(name);
        return labels.size > 0 ? [...labels] : [NONE.material];
      };
    }
    case "classification": {
      const [info, links] = await Promise.all([index.classificationInfo(), index.typeLinks()]);
      return (row) => {
        const references = index.classificationsOfRow(row, links);
        const labels: string[] = [];
        for (let i = 0; i < references.length; i++) {
          const entry = info.get(references[i]);
          if (entry) labels.push([entry.system, entry.code, entry.name].filter(Boolean).join(" · ") || "Classified");
        }
        return labels.length > 0 ? labels : [NONE.classification];
      };
    }
    case "property": {
      if (!options.property?.name) return () => [NONE.property];
      const hits = await lookupProperty(index, options.property);
      return (row) => [displayValue(hits.get(index.ids[row])?.value)];
    }
  }
}

/** Groups the elements of every model by a facet, largest group first. */
export async function groupElements(indexes: ModelIndex[], facet: GroupFacet, options: GroupOptions = {}): Promise<ElementGroup[]> {
  const groups = new Map<string, ElementGroup>();
  for (const index of indexes) {
    const labelsOf = await labelsForRows(index, facet, options);
    const scope = options.scope ? new Set(options.scope[index.modelId] ?? []) : null;
    if (options.scope && (!scope || scope.size === 0)) continue;
    for (let row = 0; row < index.count; row++) {
      const localId = index.ids[row];
      if (scope && !scope.has(localId)) continue;
      for (const label of labelsOf(row)) {
        const key = label.trim().toLowerCase();
        let group = groups.get(key);
        if (!group) groups.set(key, (group = { key, label, items: {}, count: 0 }));
        (group.items[index.modelId] ??= []).push(localId);
        group.count += 1;
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
