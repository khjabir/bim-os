// Reading an asset's values: what the team changed wins over what the model
// said, and both stay visible.

import { FIELD_BY_ID, FIELD_GROUP_LABELS, FIELDS, type FieldDef, type FieldGroup } from "../convert/assets/fields";
import type { Asset } from "./types";

/** Asset attributes that are not register fields but can be edited like them. */
export const TOP_FIELDS: Record<string, string> = {
  name: "Name",
  code: "Asset code",
  tag: "Tag / mark",
  floor: "Floor",
  space: "Room",
};

/** The fields a maintainable asset should have before handover; completeness is measured on these. */
export const KEY_FIELDS = ["manufacturer", "model", "serialNumber", "installationDate", "warrantyEndDate", "expectedLife", "space"] as const;

export function fieldLabel(field: string): string {
  return TOP_FIELDS[field] ?? FIELD_BY_ID.get(field)?.label ?? field;
}

export function fieldDef(field: string): FieldDef | undefined {
  return FIELD_BY_ID.get(field);
}

/** The value the model gave. */
export function modelValue(a: Asset, field: string): string {
  switch (field) {
    case "name":
      return a.name;
    case "code":
      return a.code;
    case "tag":
      return a.tag;
    case "floor":
      return a.floor;
    case "space":
      return a.space;
    default:
      return a.values[field] ?? "";
  }
}

/** The value in use: the team's edit when there is one, else the model's. */
export function valueOf(a: Asset, field: string): string {
  const edit = a.edits?.[field];
  return edit ? edit.value : modelValue(a, field);
}

export function isEdited(a: Asset, field: string): boolean {
  return Boolean(a.edits?.[field]);
}

/** Key fields without a value. */
export function missingKeyFields(a: Asset): string[] {
  return KEY_FIELDS.filter((f) => !valueOf(a, f));
}

/** Share of key fields filled over a set of assets, 0..1. */
export function completeness(assets: Asset[]): number {
  if (assets.length === 0) return 0;
  let filled = 0;
  for (const a of assets) for (const f of KEY_FIELDS) if (valueOf(a, f)) filled++;
  return filled / (assets.length * KEY_FIELDS.length);
}

/** Field ids in display order, grouped as the register groups them. */
export const FIELD_GROUPS: { group: FieldGroup; label: string; fields: string[] }[] = (() => {
  const order: FieldGroup[] = ["identity", "product", "lifecycle", "maintenance", "location", "cafm", "electrical", "technical", "fire"];
  return order.map((group) => ({
    group,
    label: FIELD_GROUP_LABELS[group],
    fields: FIELDS.filter((f) => f.level !== "space" && f.group === group).map((f) => f.id),
  }));
})();

/** Fields shown on an asset page even when empty, so they can be filled in. */
export const ALWAYS_SHOWN = new Set<string>(["manufacturer", "model", "serialNumber", "barCode", "assetIdentifier", "installationDate", "warrantyEndDate", "expectedLife", "ppmTask", "ppmFrequency", "criticality", "maintainer", "condition", "status"]);

/** A short line under an asset's name: kind and where it is. */
export function assetSubtitle(a: Asset): string {
  const where = [valueOf(a, "floor"), valueOf(a, "space")].filter(Boolean).join(" · ");
  return [a.kind, where].filter(Boolean).join(" · ");
}

/** Status words used on lists and in search ("verified", "edited", "missing data"). */
export function statusOf(a: Asset): "verified" | "edited" | "incomplete" | "complete" {
  if (a.verified) return "verified";
  if (a.edits && Object.keys(a.edits).length) return "edited";
  return missingKeyFields(a).length ? "incomplete" : "complete";
}
