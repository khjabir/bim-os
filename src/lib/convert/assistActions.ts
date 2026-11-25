// The on-device assistant's work on floor plans: room types (from the room
// names, then the assistant for names the rules do not know), the drawing's
// notes (rules, then the assistant for free text), and changes asked for in
// plain words. Everything the assistant suggests is shown first and applied
// only when the user says so; the last applied change can be undone.

import { askAssistant, useAssistant } from "@/lib/ondevice/engine";
import { pushToast } from "@/lib/store";
import { applySteps, editContext, editsTask, openingsOfRoom, planSteps, readEdits, snapshot, type EditStep, type Selection } from "./plans/planEdits";
import { mergeFindings, noteBlocks, notesByRules, notesTask, readNotes, type DrawingUnits, type NoteField, type NoteFinding } from "./plans/planNotes";
import { readRoomTypes, roomTypesTask, type RoomForTyping } from "./plans/roomTypes";
import { vectorPlans } from "./plans/vectorClient";
import { updatePlan, updateSettings, useConvertStore, type PlanItem } from "./store";

const planOf = (id: string) => useConvertStore.getState().plans.find((p) => p.id === id) ?? null;

// ---------------------------------------------------------------------------
// Room types

export function setRoomType(id: string, index: number, type: string | null) {
  updatePlan(id, (p) => ({ rooms: p.rooms.map((r, i) => (i === index ? { ...r, type, typeSource: type ? "user" : null } : r)) }));
}

function ringArea(ring: [number, number][]) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i],
      q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Named rooms the rules could not type. */
export function roomsToType(plan: PlanItem): number[] {
  return plan.rooms.flatMap((r, i) => (r.name && /\p{L}{2}/u.test(r.name) && !r.type ? [i] : []));
}

/** The assistant's types for the named rooms the rules could not type; returns how many it typed. */
export async function suggestRoomTypes(id: string): Promise<number> {
  const plan = planOf(id);
  if (!plan) return 0;
  const mpp = plan.calibration?.metresPerPixel ?? 0;
  const todo = roomsToType(plan);
  if (!todo.length) return 0;
  let typed = 0;
  // A few rooms at a time keeps each answer short.
  for (let k = 0; k < todo.length; k += 15) {
    const chunk = todo.slice(k, k + 15);
    const now = planOf(id);
    if (!now) return typed;
    const rooms: RoomForTyping[] = chunk.map((i, j) => {
      const r = now.rooms[i];
      const o = mpp > 0 ? openingsOfRoom(now, i, mpp) : { doors: 0, windows: 0 };
      return { n: j + 1, name: r.name ?? "", number: r.number, area: mpp > 0 ? Math.round(ringArea(r.outline) * mpp * mpp * 10) / 10 : null, doors: o.doors, windows: o.windows };
    });
    const answer = await askAssistant(roomTypesTask(rooms));
    const types = readRoomTypes(answer, rooms.length);
    if (!types.size) continue;
    updatePlan(id, (p) => ({
      rooms: p.rooms.map((r, i) => {
        const j = chunk.indexOf(i);
        const t = j >= 0 ? types.get(j + 1) : undefined;
        if (!t || r.type) return r;
        typed++;
        return { ...r, type: t, typeSource: "assistant" as const };
      }),
    }));
  }
  return typed;
}

// ---------------------------------------------------------------------------
// Notes

type Box = [number, number, number, number];

function inRing(p: [number, number], ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Reads the drawing's notes with the rules, and with the assistant too when asked. */
export async function readPlanNotes(id: string, withAssistant: boolean): Promise<void> {
  const plan = planOf(id);
  const v = plan?.vector;
  if (!plan || !v) return;
  updatePlan(id, (p) => ({ notes: { blocks: p.notes?.blocks ?? [], findings: p.notes?.findings ?? [], assistant: p.notes?.assistant ?? false, applied: p.notes?.applied ?? [], reading: true, error: undefined } }));
  try {
    const others = useConvertStore
      .getState()
      .plans.filter((p) => p.id !== id && p.vector?.drawingId === v.drawingId)
      .map((p) => p.vector!.region as Box);
    const texts = await vectorPlans.noteTexts(v.drawingId, v.view, others);
    const blocks = noteBlocks(texts, (x, y) => plan.rooms.some((r) => inRing([x, y], r.outline)));
    let findings: NoteFinding[] = notesByRules(blocks);
    let assistant = false;
    if (withAssistant && blocks.length) {
      const units = (findings.find((f) => f.field === "units")?.value as DrawingUnits | undefined) ?? unitsOf(plan);
      const answer = await askAssistant(notesTask(blocks));
      findings = mergeFindings(findings, readNotes(answer, blocks, units));
      assistant = true;
    }
    updatePlan(id, (p) => ({ notes: { blocks, findings, assistant, applied: p.notes?.applied ?? [], reading: false } }));
  } catch (error) {
    updatePlan(id, (p) => ({ notes: { blocks: p.notes?.blocks ?? [], findings: p.notes?.findings ?? [], assistant: p.notes?.assistant ?? false, applied: p.notes?.applied ?? [], reading: false, error: error instanceof Error ? error.message : String(error) } }));
  }
}

/** The drawing's units when its file says (DXF), for lengths in notes written without a unit. */
function unitsOf(plan: PlanItem): DrawingUnits | null {
  const v = plan.vector;
  if (!v || v.kind !== "dxf" || !plan.calibration) return null;
  const perUnit = plan.calibration.metresPerPixel * v.view.k;
  const known: [number, DrawingUnits][] = [
    [0.001, "mm"],
    [0.01, "cm"],
    [1, "m"],
    [0.0254, "in"],
    [0.3048, "ft"],
  ];
  return known.find(([m]) => Math.abs(perUnit - m) / m < 1e-6)?.[1] ?? null;
}

/** What applying a finding changes, in words, and whether it can be applied to this plan. */
export function findingEffect(plan: PlanItem, f: NoteFinding): { now: string; ok: boolean; note?: string } {
  const mpp = plan.calibration?.metresPerPixel ?? 0;
  const st = useConvertStore.getState().settings;
  const m = (x: number) => `${Math.round(x * 1000) / 1000} m`;
  const thick = (external: boolean) => {
    const list = wallsBySide(plan, external).map((i) => Math.round(plan.walls[i].thickness * mpp * 1000));
    if (!list.length) return null;
    list.sort((a, b) => a - b);
    return list[0] === list[list.length - 1] ? `${list[0]} mm` : `${list[0]}–${list[list.length - 1]} mm`;
  };
  switch (f.field) {
    case "projectName":
      return { now: st.projectName || "not set", ok: true };
    case "buildingName":
      return { now: st.buildingName || "not set", ok: true };
    case "storeyName":
      return { now: plan.storey.name, ok: true };
    case "levelElevation":
      return { now: m(plan.storey.elevation), ok: true };
    case "storeyHeight":
      return { now: `walls ${m(plan.storey.height)}`, ok: true };
    case "ceilingHeight":
      return { now: plan.roomHeight ? m(plan.roomHeight) : `as the walls (${m(plan.storey.height)})`, ok: true };
    case "slabThickness":
      return { now: m(plan.slabThickness), ok: true };
    case "doorHeight":
      return { now: m(plan.sizes.doorHeight), ok: true };
    case "windowSill":
      return { now: m(plan.sizes.windowSill), ok: true };
    case "windowHead":
      return { now: `${m(plan.sizes.windowSill + plan.sizes.windowHeight)} (sill + window)`, ok: true, note: "Sets the window height from the sill" };
    case "windowHeight":
      return { now: m(plan.sizes.windowHeight), ok: true };
    case "externalWallThickness":
    case "internalWallThickness": {
      const t = thick(f.field === "externalWallThickness");
      if (!mpp) return { now: "no scale", ok: false };
      if (!plan.outline.length) return { now: "no outline", ok: false, note: "External walls are known from the plan's outline" };
      return t ? { now: t, ok: true } : { now: "no walls", ok: false };
    }
    case "units": {
      const v = plan.vector;
      if (v?.kind !== "dxf") return { now: "", ok: false, note: "Only drawings (DXF) take their units from notes" };
      const cur = unitsOf(plan);
      return { now: cur ?? (v.scaleSource === "file" ? "from the file" : "guessed"), ok: v.scaleSource !== "file" && cur !== f.value, note: v.scaleSource === "file" ? "The file gives its units" : "Reads the plan again" };
    }
  }
}

function onOutline(plan: PlanItem, i: number) {
  const w = plan.walls[i];
  const ring = plan.outline;
  if (ring.length < 3) return false;
  const mid: [number, number] = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k],
      q = ring[(k + 1) % ring.length];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const d = Math.abs((mid[0] - p[0]) * (q[1] - p[1]) - (mid[1] - p[1]) * (q[0] - p[0])) / L;
    const s = ((mid[0] - p[0]) * (q[0] - p[0]) + (mid[1] - p[1]) * (q[1] - p[1])) / (L * L);
    if (d < Math.max(1, w.thickness) && s > -0.05 && s < 1.05) return true;
  }
  return false;
}

function wallsBySide(plan: PlanItem, external: boolean): number[] {
  return plan.walls.flatMap((_, i) => (onOutline(plan, i) === external ? [i] : []));
}

/** Applies findings to the plan (and the project's names); returns what was applied. */
export function applyFindings(id: string, fields: NoteField[]): string[] {
  const plan = planOf(id);
  if (!plan?.notes) return [];
  const mpp = plan.calibration?.metresPerPixel ?? 0;
  const done: string[] = [];
  let reread = false;
  const patch: Partial<PlanItem> = {};
  let storey = { ...plan.storey };
  let sizes = { ...plan.sizes };
  let walls = plan.walls;
  const find = (f: NoteField) => plan.notes!.findings.find((x) => x.field === f);
  const st = useConvertStore.getState().settings;
  const settingsBefore = { projectName: st.projectName, buildingName: st.buildingName };
  for (const field of fields) {
    const f = find(field);
    if (!f || !findingEffect(plan, f).ok) continue;
    const v = f.value;
    switch (field) {
      case "projectName":
        updateSettings({ projectName: String(v) });
        break;
      case "buildingName":
        updateSettings({ buildingName: String(v) });
        break;
      case "storeyName":
        storey = { ...storey, name: String(v) };
        break;
      case "levelElevation":
        storey = { ...storey, elevation: v as number };
        break;
      case "storeyHeight":
        storey = { ...storey, height: v as number };
        break;
      case "ceilingHeight":
        patch.roomHeight = v as number;
        break;
      case "slabThickness":
        patch.slabThickness = v as number;
        break;
      case "doorHeight":
        sizes = { ...sizes, doorHeight: v as number };
        break;
      case "windowSill":
        sizes = { ...sizes, windowSill: v as number };
        break;
      case "windowHeight":
        sizes = { ...sizes, windowHeight: v as number };
        break;
      case "windowHead":
        if (!fields.includes("windowHeight") && (v as number) - sizes.windowSill >= 0.3) sizes = { ...sizes, windowHeight: Math.round(((v as number) - sizes.windowSill) * 1000) / 1000 };
        break;
      case "externalWallThickness":
      case "internalWallThickness": {
        const ids = new Set(wallsBySide(plan, field === "externalWallThickness"));
        if (mpp > 0) walls = walls.map((w, i) => (ids.has(i) ? { ...w, thickness: (v as number) / mpp } : w));
        break;
      }
      case "units": {
        const unit = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 }[String(v)];
        if (unit && plan.vector && plan.calibration) {
          patch.calibration = { ...plan.calibration, metresPerPixel: unit / plan.vector.view.k };
          patch.vector = { ...plan.vector, scaleSource: "set" };
          reread = true;
        }
        break;
      }
    }
    done.push(field);
  }
  if (!done.length) return done;
  updatePlan(id, (p) => ({ ...patch, storey, sizes, walls, notes: p.notes ? { ...p.notes, applied: [...new Set([...p.notes.applied, ...done])] } : p.notes, undo: { label: "the notes' values", before: { ...snapshot(p), calibration: p.calibration, vector: p.vector }, settings: settingsBefore } }));
  if (reread) void import("./actions").then((a) => a.recognizePlan(id));
  return done;
}

// ---------------------------------------------------------------------------
// Changes asked for in words

/** The changes a request asks for, found on the plan (nothing is changed yet). */
export async function previewEdits(id: string, request: string, sel: Selection): Promise<EditStep[]> {
  const plan = planOf(id);
  if (!plan) return [];
  const mpp = plan.calibration?.metresPerPixel ?? 0;
  if (!(mpp > 0)) throw new Error("Set the plan's scale first.");
  const answer = await askAssistant(editsTask(request, editContext(plan, sel, mpp)));
  const ops = readEdits(answer);
  if (!ops.length) throw new Error("The assistant found no change in that request: try saying what to change and where.");
  return planSteps(plan, ops, sel, mpp);
}

/**
 * Applies the changes that can be applied (the plan as it was is kept for
 * Undo). They are worked out again on the plan as it is now: when that gives
 * a different list (the plan was edited since), nothing is applied and the
 * new list is returned to be checked again.
 */
export function applyEdits(id: string, steps: EditStep[], label: string, sel: Selection): { applied: number; changed: EditStep[] | null } {
  const plan = planOf(id);
  const mpp = plan?.calibration?.metresPerPixel ?? 0;
  if (!plan || !(mpp > 0)) return { applied: 0, changed: null };
  const fresh = planSteps(plan, steps.map((s) => s.op), sel, mpp);
  const words = (list: EditStep[]) => JSON.stringify(list.map((s) => s.summary ?? s.problem));
  if (words(fresh) !== words(steps)) return { applied: 0, changed: fresh };
  const usable = fresh.filter((s) => s.apply);
  if (!usable.length) return { applied: 0, changed: null };
  updatePlan(id, (p) => ({ ...applySteps(p, usable), undo: { label, before: snapshot(p) } }));
  return { applied: usable.length, changed: null };
}

export function undoAssistant(id: string) {
  const plan = planOf(id);
  if (!plan?.undo) return;
  const { label, settings } = plan.undo;
  updatePlan(id, (p) => ({ ...p.undo!.before, undo: null, notes: p.notes ? { ...p.notes, applied: label === "the notes' values" ? [] : p.notes.applied } : p.notes }));
  if (settings) updateSettings(settings);
  pushToast("info", `Undone: ${label}.`);
}

/** The assistant is on and usable. */
export function assistantReady(): boolean {
  const s = useAssistant.getState();
  return s.enabled && s.status !== "error";
}
