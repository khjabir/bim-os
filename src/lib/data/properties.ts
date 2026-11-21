// Full detail of a single element for the Properties panel: attributes,
// property and quantity sets (own and inherited from its type), materials,
// classification references and where it sits in the building.

import type * as FRAGS from "@thatopen/fragments";
import { categoryOfItem, idOf, parsePset, textOf, valueOf, type PsetContent } from "./model-index";

export interface AttributeRow {
  name: string;
  value: string | number | boolean | null;
  type?: string;
}

export interface MaterialRow {
  name: string;
  /** e.g. "Layer 2 of 3 · 115 mm" */
  detail?: string;
}

export interface ClassificationRow {
  system?: string;
  code?: string;
  name?: string;
  location?: string;
}

export interface LinkedItem {
  localId: number;
  category: string;
  name: string;
}

export interface ElementDetails {
  modelId: string;
  localId: number;
  category: string;
  guid: string | null;
  name: string;
  attributes: AttributeRow[];
  psets: PsetContent[];
  qsets: PsetContent[];
  type: (LinkedItem & { attributes: AttributeRow[]; psets: PsetContent[] }) | null;
  materials: MaterialRow[];
  classifications: ClassificationRow[];
  container: LinkedItem | null;
  parent: LinkedItem | null;
  parts: LinkedItem[];
  groups: LinkedItem[];
  /** Walls this door/window sits in, openings in this wall, and similar. */
  related: { label: string; items: LinkedItem[] }[];
}

const nested = { attributes: true, relations: true } as const;
const flat = { attributes: true, relations: false } as const;

const DETAIL_CONFIG: Partial<FRAGS.ItemsDataConfig> = {
  attributesDefault: true,
  relations: {
    IsDefinedBy: nested,
    IsTypedBy: nested,
    HasPropertySets: nested,
    HasProperties: flat,
    Quantities: flat,
    HasAssociations: nested,
    ForLayerSet: nested,
    MaterialLayers: nested,
    ForProfileSet: nested,
    MaterialProfiles: nested,
    MaterialConstituents: nested,
    Materials: nested,
    Material: flat,
    ReferencedSource: flat,
    ContainedInStructure: flat,
    Decomposes: flat,
    IsDecomposedBy: flat,
    Nests: flat,
    IsNestedBy: flat,
    HasAssignments: flat,
    FillsVoids: nested,
    VoidsElements: flat,
    HasOpenings: nested,
    HasFillings: flat,
  },
  relationsDefault: { attributes: false, relations: false },
};

const HIDDEN_ATTRIBUTES = new Set(["_category", "_localId", "_guid"]);

function attributesOf(item: FRAGS.ItemData): AttributeRow[] {
  const rows: AttributeRow[] = [];
  for (const [key, value] of Object.entries(item)) {
    if (HIDDEN_ATTRIBUTES.has(key) || Array.isArray(value)) continue;
    const parsed = valueOf(value);
    if (parsed === null || parsed === "") continue;
    rows.push({ name: key, value: parsed, type: (value as FRAGS.ItemAttribute).type });
  }
  return rows;
}

function children(item: FRAGS.ItemData, relation: string): FRAGS.ItemData[] {
  const value = item[relation];
  return Array.isArray(value) ? value : [];
}

function linked(item: FRAGS.ItemData): LinkedItem {
  return {
    localId: idOf(item) ?? -1,
    category: categoryOfItem(item),
    name: textOf(item.Name) ?? textOf(item.LongName) ?? "",
  };
}

function formatThickness(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  // IFC lengths arrive in model units; values under 5 are assumed to be metres.
  return value < 5 ? `${Math.round(value * 1000)} mm` : `${Math.round(value)} mm`;
}

/** Walks a material association (layer sets, constituent sets, profile sets, lists) down to its materials. */
function collectMaterials(item: FRAGS.ItemData, out: MaterialRow[], context = "", depth = 0) {
  if (depth > 6) return;
  const category = categoryOfItem(item);
  if (category === "IFCMATERIAL") {
    out.push({ name: textOf(item.Name) ?? "(unnamed material)", detail: context || undefined });
    return;
  }
  if (category === "IFCMATERIALLAYER") {
    const thickness = formatThickness(valueOf(item.LayerThickness));
    const label = [context, thickness].filter(Boolean).join(" · ");
    const materials = children(item, "Material");
    if (materials.length === 0) out.push({ name: textOf(item.Name) ?? "(layer without material)", detail: label || undefined });
    for (const material of materials) collectMaterials(material, out, label, depth + 1);
    return;
  }
  if (category === "IFCMATERIALCONSTITUENT" || category === "IFCMATERIALPROFILE") {
    const label = [context, textOf(item.Name)].filter(Boolean).join(" · ");
    for (const material of children(item, "Material")) collectMaterials(material, out, label, depth + 1);
    return;
  }
  const layers = children(item, "MaterialLayers");
  if (layers.length > 0) {
    layers.forEach((layer, index) => collectMaterials(layer, out, `Layer ${index + 1} of ${layers.length}`, depth + 1));
    return;
  }
  for (const relation of ["ForLayerSet", "ForProfileSet", "MaterialProfiles", "MaterialConstituents", "Materials", "Material"]) {
    for (const child of children(item, relation)) collectMaterials(child, out, context, depth + 1);
  }
}

function classificationOf(item: FRAGS.ItemData): ClassificationRow {
  const source = children(item, "ReferencedSource")[0];
  const category = categoryOfItem(item);
  if (category === "IFCCLASSIFICATION") {
    return { system: textOf(item.Name) ?? undefined, name: textOf(item.Description) ?? undefined };
  }
  return {
    system: source ? (textOf(source.Name) ?? undefined) : undefined,
    code: textOf(item.Identification) ?? textOf(item.ItemReference) ?? undefined,
    name: textOf(item.Name) ?? undefined,
    location: textOf(item.Location) ?? undefined,
  };
}

function isType(category: string) {
  return /(TYPE|STYLE)$/.test(category);
}

export async function getElementDetails(model: FRAGS.FragmentsModel, localId: number): Promise<ElementDetails | null> {
  const [item] = await model.getItemsData([localId], DETAIL_CONFIG);
  if (!item) return null;

  const psets: PsetContent[] = [];
  const qsets: PsetContent[] = [];
  let type: ElementDetails["type"] = null;

  for (const definition of [...children(item, "IsDefinedBy"), ...children(item, "IsTypedBy")]) {
    const category = categoryOfItem(definition);
    if (category === "IFCPROPERTYSET" || category === "IFCELEMENTQUANTITY") {
      const content = parsePset(definition, idOf(definition) ?? -1);
      (content.kind === "qset" ? qsets : psets).push(content);
    } else if (isType(category)) {
      const typePsets: PsetContent[] = [];
      for (const set of children(definition, "HasPropertySets")) {
        const setCategory = categoryOfItem(set);
        if (setCategory === "IFCPROPERTYSET" || setCategory === "IFCELEMENTQUANTITY") typePsets.push(parsePset(set, idOf(set) ?? -1));
      }
      type = { ...linked(definition), attributes: attributesOf(definition), psets: typePsets };
    }
  }

  const materials: MaterialRow[] = [];
  const classifications: ClassificationRow[] = [];
  for (const association of children(item, "HasAssociations")) {
    const category = categoryOfItem(association);
    if (category.startsWith("IFCCLASSIFICATION")) classifications.push(classificationOf(association));
    else collectMaterials(association, materials);
  }
  // Materials assigned on the type apply to its occurrences when they have none of their own.
  if (materials.length === 0 && type) {
    const [typeItem] = await model.getItemsData([type.localId], DETAIL_CONFIG);
    if (typeItem) for (const association of children(typeItem, "HasAssociations")) {
      if (!categoryOfItem(association).startsWith("IFCCLASSIFICATION")) collectMaterials(association, materials, "from type");
    }
  }

  const related: ElementDetails["related"] = [];
  const hosts = children(item, "FillsVoids").flatMap((opening) => children(opening, "VoidsElements"));
  if (hosts.length > 0) related.push({ label: "Hosted in", items: hosts.map(linked) });
  const fillings = children(item, "HasOpenings").flatMap((opening) => children(opening, "HasFillings"));
  if (fillings.length > 0) related.push({ label: "Hosts", items: fillings.map(linked) });

  const container = children(item, "ContainedInStructure")[0];
  const parent = children(item, "Decomposes")[0] ?? children(item, "Nests")[0];

  psets.sort((a, b) => a.name.localeCompare(b.name));
  qsets.sort((a, b) => a.name.localeCompare(b.name));

  return {
    modelId: model.modelId,
    localId,
    category: categoryOfItem(item),
    guid: textOf(item._guid),
    name: textOf(item.Name) ?? "",
    attributes: attributesOf(item),
    psets,
    qsets,
    type,
    materials,
    classifications,
    container: container ? linked(container) : null,
    parent: parent ? linked(parent) : null,
    parts: [...children(item, "IsDecomposedBy"), ...children(item, "IsNestedBy")].map(linked),
    groups: children(item, "HasAssignments").map(linked),
    related,
  };
}

/** Flattens an element's details into rows for CSV export. */
export function detailsToRows(details: ElementDetails): (string | number | boolean | null)[][] {
  const rows: (string | number | boolean | null)[][] = [];
  for (const attribute of details.attributes) rows.push(["Attributes", attribute.name, attribute.value, attribute.type ?? ""]);
  for (const set of [...details.psets, ...details.qsets]) {
    for (const prop of set.props) rows.push([set.name, prop.name, prop.value, prop.type ?? ""]);
  }
  if (details.type) {
    rows.push(["Type", "Name", details.type.name, details.type.category]);
    for (const set of details.type.psets) for (const prop of set.props) rows.push([`Type · ${set.name}`, prop.name, prop.value, prop.type ?? ""]);
  }
  for (const material of details.materials) rows.push(["Materials", material.name, material.detail ?? "", ""]);
  for (const entry of details.classifications) rows.push(["Classification", entry.system ?? "", entry.code ?? "", entry.name ?? ""]);
  return rows;
}
