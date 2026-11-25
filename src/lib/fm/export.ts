// Spreadsheets of the workspace: the asset register with the team's edits
// applied (and a sheet of what was changed, by whom and when), work orders,
// and maintenance plans. Plain columns, ready for a CAFM import.

import { FIELDS } from "../convert/assets/fields";
import { writeXlsx, type Cell, type SheetDef } from "../utils/xlsx";
import { fieldLabel, modelValue, statusOf, valueOf } from "./asset";
import { dayOf, localStamp } from "./schedule";
import { intervalText } from "./tasks";
import type { Asset, Facility, Plan, WorkOrder } from "./types";

const STATUS_WORDS = { verified: "Verified", edited: "Edited", incomplete: "Missing data", complete: "From model" } as const;

/** Register fields that have a value on at least one of the assets, in the register's order. */
function usedFields(assets: Asset[]): string[] {
  const used = new Set<string>();
  for (const a of assets) {
    for (const [k, v] of Object.entries(a.values)) if (v) used.add(k);
    for (const k of Object.keys(a.edits ?? {})) used.add(k);
  }
  return FIELDS.filter((f) => f.level !== "space" && used.has(f.id) && f.id !== "space" && f.id !== "tag").map((f) => f.id);
}

export function assetTable(assets: Asset[]): { header: string[]; rows: Cell[][] } {
  const fields = usedFields(assets);
  const header = [
    "Asset code",
    "Name",
    "Tag",
    "Kind",
    "Kind code",
    "Discipline",
    "Category",
    "Type",
    "Floor",
    "Room",
    "Room name",
    "Location",
    "Systems",
    "Fed from",
    "Parent",
    "Compliance (suggested)",
    "Uniclass (suggested)",
    ...fields.map((f) => fieldLabel(f)),
    "Status",
    "Checked on site",
    "Checked by",
    "Condition (1-5)",
    "Check notes",
    "Changed fields",
    "GlobalId",
    "Model file",
    "Element id",
  ];
  const rows = assets.map((a) => [
    valueOf(a, "code"),
    valueOf(a, "name"),
    valueOf(a, "tag"),
    a.kind,
    a.kindCode,
    a.discipline,
    a.category,
    a.typeName,
    valueOf(a, "floor"),
    valueOf(a, "space"),
    a.roomName,
    a.locationPath,
    a.systems.join(", "),
    a.fedFrom,
    a.parent,
    a.compliance,
    a.uniclass,
    ...fields.map((f) => valueOf(a, f)),
    STATUS_WORDS[statusOf(a)],
    dayOf(a.verified?.at),
    a.verified?.by ?? "",
    a.verified?.condition ?? "",
    a.verified?.notes ?? "",
    Object.keys(a.edits ?? {})
      .map((f) => fieldLabel(f))
      .join(", "),
    a.id,
    a.file,
    a.elementId,
  ]);
  return { header, rows };
}

/** The asset register as Excel: assets (edits applied), and every change next to the model's value. */
export async function assetWorkbook(facility: Facility | null, assets: Asset[]): Promise<Blob> {
  const { header, rows } = assetTable(assets);
  const changes: Cell[][] = [];
  for (const a of assets)
    for (const [field, edit] of Object.entries(a.edits ?? {})) changes.push([valueOf(a, "code"), valueOf(a, "name"), fieldLabel(field), modelValue(a, field), edit.value, edit.by, localStamp(edit.at), a.id]);
  const sheets: SheetDef[] = [
    { name: "Assets", columns: header.map((h) => ({ header: h })), rows, tab: "2563EB" },
    { name: "Changes", columns: ["Asset code", "Name", "Field", "Model value", "New value", "Changed by", "Changed at", "GlobalId"].map((h) => ({ header: h })), rows: changes, tab: "B45309" },
  ];
  return writeXlsx(sheets, { title: `${facility?.name ?? "Facility"} asset register`, creator: "IFC Studio" });
}

export function workOrderTable(workOrders: WorkOrder[], assetById: Map<string, Asset>): { header: string[]; rows: Cell[][] } {
  const header = ["Number", "Title", "Kind", "Status", "Priority", "Due", "Assignee", "Assets", "Asset codes", "Rooms", "Description", "Created", "Created by", "Completed", "Completed by", "Last note", "Plan"];
  const rows = workOrders.map((w) => {
    const assets = w.assetIds.map((id) => assetById.get(id)).filter((a): a is Asset => Boolean(a));
    const notes = w.log.filter((l) => !/^Status:|^Created$|^Raised from/.test(l.text));
    return [
      w.number,
      w.title,
      w.kind,
      w.status,
      w.priority,
      w.due,
      w.assignee,
      assets.map((a) => valueOf(a, "name")).join(", "),
      assets.map((a) => valueOf(a, "code")).join(", "),
      [...new Set(assets.map((a) => valueOf(a, "space")).filter(Boolean))].join(", "),
      w.description,
      dayOf(w.createdAt),
      w.createdBy,
      w.completedAt?.slice(0, 10) ?? "",
      w.completedBy ?? "",
      notes.length ? notes[notes.length - 1].text : "",
      w.planId ?? "",
    ];
  });
  return { header, rows };
}

export async function workOrderWorkbook(facility: Facility | null, workOrders: WorkOrder[], assetById: Map<string, Asset>): Promise<Blob> {
  const { header, rows } = workOrderTable(workOrders, assetById);
  const log: Cell[][] = [];
  for (const w of workOrders) for (const l of w.log) log.push([w.number, localStamp(l.at), l.by, l.text]);
  return writeXlsx(
    [
      { name: "Work orders", columns: header.map((h) => ({ header: h })), rows, tab: "2563EB" },
      { name: "Log", columns: ["Number", "At", "By", "Entry"].map((h) => ({ header: h })), rows: log },
    ],
    { title: `${facility?.name ?? "Facility"} work orders`, creator: "IFC Studio" },
  );
}

export async function planWorkbook(facility: Facility | null, plans: Plan[], assetById: Map<string, Asset>): Promise<Blob> {
  const rows = plans.map((p) => {
    const a = assetById.get(p.assetId);
    return [a ? valueOf(a, "code") : "", a ? valueOf(a, "name") : p.assetId, a?.kind ?? "", a ? valueOf(a, "floor") : "", a ? valueOf(a, "space") : "", p.title, intervalText(p.every, p.unit), p.nextDue, p.lastDone ?? "", p.active ? "Yes" : "No", p.statutory ? "Yes" : "", p.trade ?? "", p.minutes ?? "", p.source];
  });
  return writeXlsx(
    [{ name: "Maintenance plans", columns: ["Asset code", "Asset", "Kind", "Floor", "Room", "Task", "Every", "Next due", "Last done", "Active", "Statutory", "Trade", "Minutes", "Source"].map((h) => ({ header: h })), rows, tab: "15803D" }],
    { title: `${facility?.name ?? "Facility"} maintenance plans`, creator: "IFC Studio" },
  );
}
