// The facility workspace in memory, saved to IndexedDB as it changes.
// Components read it with `useFm`; changes go through the functions below so
// that every change is stored and stamped with who made it and when.

import { create } from "zustand";
import { pushToast } from "../store";
import { evaluateReading, evaluateStale, type AlarmChanges } from "./alarms";
import { modelValue } from "./asset";
import { deleteMany, getAll, getOne, putMany, replaceAll, type StoreName } from "./db";
import { completePlan, todayIso } from "./schedule";
import { DEFAULT_TASKS } from "./tasks";
import type { Alarm, Asset, Facility, LiveSource, Photo, Plan, Point, Series, Space, SystemInfo, TaskTemplate, Verification, WorkOrder, WorkspaceData } from "./types";

export type PhotoMeta = Omit<Photo, "blob">;

export interface FmState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  facility: Facility | null;
  assets: Asset[];
  spaces: Space[];
  systems: SystemInfo[];
  tasks: TaskTemplate[];
  plans: Plan[];
  workOrders: WorkOrder[];
  photos: PhotoMeta[];
  sources: LiveSource[];
  points: Point[];
  alarms: Alarm[];
  series: Record<string, Series>;
  /** Bumped on every change of facility data (search indexes rebuild on it). */
  rev: number;
  /** Bumped when readings arrive. */
  liveRev: number;
}

const EMPTY: Omit<FmState, "status" | "error"> = {
  facility: null,
  assets: [],
  spaces: [],
  systems: [],
  tasks: DEFAULT_TASKS,
  plans: [],
  workOrders: [],
  photos: [],
  sources: [],
  points: [],
  alarms: [],
  series: {},
  rev: 0,
  liveRev: 0,
};

export const useFm = create<FmState>(() => ({ status: "idle", error: null, ...EMPTY }));

/** Readings kept per point (in memory and on disk). */
export const SERIES_LIMIT = 2000;

const now = () => new Date().toISOString();

export function uid(prefix: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs storage writes one after another; a failure is reported, not thrown. */
function persist(write: () => Promise<unknown>) {
  queue = queue.then(write).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    useFm.setState({ error: message });
    pushToast("error", `The change could not be saved on this device: ${message}`);
  });
  return queue;
}

/** Waits for pending writes (tests and file exports). */
export function flushWrites(): Promise<unknown> {
  return queue;
}

const assetMaps = new WeakMap<Asset[], Map<string, Asset>>();

/** Assets by id, built once per version of the asset list. */
export function assetMap(assets: Asset[]): Map<string, Asset> {
  let map = assetMaps.get(assets);
  if (!map) assetMaps.set(assets, (map = new Map(assets.map((a) => [a.id, a]))));
  return map;
}

export function userName(): string {
  return useFm.getState().facility?.user || "Me";
}

// ---------------------------------------------------------------------------
// Loading and replacing

let loading: Promise<void> | null = null;

/** Reads the workspace from this browser's storage, once. */
export function loadWorkspace(): Promise<void> {
  if (loading) return loading;
  useFm.setState({ status: "loading" });
  loading = (async () => {
    try {
      const meta = await getOne<{ key: string; facility: Facility }>("meta", "facility");
      const [assets, spaces, systems, tasks, plans, workOrders, photos, sources, points, alarms, series] = await Promise.all([
        getAll<Asset>("assets"),
        getAll<Space>("spaces"),
        getAll<SystemInfo>("systems"),
        getAll<TaskTemplate>("tasks"),
        getAll<Plan>("plans"),
        getAll<WorkOrder>("workOrders"),
        getAll<Photo>("photos"),
        getAll<LiveSource>("sources"),
        getAll<Point>("points"),
        getAll<Alarm>("alarms"),
        getAll<{ pointId: string; values: Series }>("series"),
      ]);
      useFm.setState({
        status: "ready",
        facility: meta?.facility ?? null,
        assets: sortAssets(assets),
        spaces,
        systems,
        tasks: tasks.length ? tasks : DEFAULT_TASKS,
        plans,
        workOrders: workOrders.sort((a, b) => b.number.localeCompare(a.number, undefined, { numeric: true })),
        photos: photos.map(({ blob: _blob, ...meta }) => meta),
        sources,
        points,
        alarms,
        series: Object.fromEntries(series.map((s) => [s.pointId, s.values])),
        rev: useFm.getState().rev + 1,
      });
    } catch (error) {
      useFm.setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return loading;
}

function sortAssets(assets: Asset[]): Asset[] {
  return assets.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Replaces everything in the workspace (onboarding, the demo, importing a workspace file). */
export async function replaceWorkspace(data: WorkspaceData): Promise<void> {
  const assets = sortAssets([...data.assets]);
  await persist(() =>
    replaceAll({
      meta: [{ key: "facility", facility: data.facility }],
      assets,
      spaces: data.spaces,
      systems: data.systems,
      tasks: data.tasks,
      plans: data.plans,
      workOrders: data.workOrders,
      photos: data.photos,
      sources: data.sources,
      points: data.points,
      alarms: data.alarms,
      series: [],
    }),
  );
  useFm.setState((s) => ({
    status: "ready",
    error: null,
    facility: data.facility,
    assets,
    spaces: data.spaces,
    systems: data.systems,
    tasks: data.tasks.length ? data.tasks : DEFAULT_TASKS,
    plans: data.plans,
    workOrders: [...data.workOrders].sort((a, b) => b.number.localeCompare(a.number, undefined, { numeric: true })),
    photos: data.photos.map(({ blob: _blob, ...meta }) => meta),
    sources: data.sources,
    points: data.points,
    alarms: data.alarms,
    series: {},
    rev: s.rev + 1,
    liveRev: s.liveRev + 1,
  }));
}

export async function clearWorkspace(): Promise<void> {
  await persist(() => replaceAll({}));
  useFm.setState((s) => ({ ...EMPTY, status: "ready", error: null, rev: s.rev + 1, liveRev: s.liveRev + 1 }));
}

/** Everything in the workspace, with photo files, for a workspace file. */
export async function workspaceData(): Promise<WorkspaceData | null> {
  await flushWrites();
  const s = useFm.getState();
  if (!s.facility) return null;
  const photos = await getAll<Photo>("photos");
  return {
    facility: s.facility,
    assets: s.assets,
    spaces: s.spaces,
    systems: s.systems,
    tasks: s.tasks,
    plans: s.plans,
    workOrders: s.workOrders,
    sources: s.sources.map(({ password: _password, ...rest }) => rest),
    points: s.points,
    alarms: s.alarms,
    photos,
  };
}

// ---------------------------------------------------------------------------
// Facility

export function updateFacility(patch: Partial<Facility>) {
  const facility = useFm.getState().facility;
  if (!facility) return;
  const next = { ...facility, ...patch, updatedAt: now() };
  useFm.setState((s) => ({ facility: next, rev: s.rev + 1 }));
  void persist(() => putMany("meta", [{ key: "facility", facility: next }]));
}

// ---------------------------------------------------------------------------
// Assets

function replaceAssets(changed: Asset[]) {
  if (changed.length === 0) return;
  const byId = new Map(changed.map((a) => [a.id, a]));
  useFm.setState((s) => ({ assets: s.assets.map((a) => byId.get(a.id) ?? a), rev: s.rev + 1 }));
  void persist(() => putMany("assets", changed));
}

/**
 * Sets a field on assets. A value equal to the model's removes the edit, so
 * typing the model's value back undoes a change.
 */
export function editAssets(ids: string[], field: string, value: string) {
  const map = assetMap(useFm.getState().assets);
  const by = userName();
  const at = now();
  const changed: Asset[] = [];
  const text = value.trim();
  for (const id of ids) {
    const a = map.get(id);
    if (!a) continue;
    const edits = { ...(a.edits ?? {}) };
    if (text === modelValue(a, field)) {
      if (!edits[field]) continue;
      delete edits[field];
    } else edits[field] = { value: text, at, by };
    changed.push({ ...a, edits });
  }
  replaceAssets(changed);
}

/** Puts a field back to the model's value. */
export function revertEdit(id: string, field: string) {
  const a = assetMap(useFm.getState().assets).get(id);
  if (!a?.edits?.[field]) return;
  const edits = { ...a.edits };
  delete edits[field];
  replaceAssets([{ ...a, edits }]);
}

export function verifyAssets(ids: string[], verification: Omit<Verification, "at" | "by"> | null) {
  const map = assetMap(useFm.getState().assets);
  const stamp = { at: now(), by: userName() };
  replaceAssets(ids.map((id) => map.get(id)).filter((a): a is Asset => Boolean(a)).map((a) => (verification ? { ...a, verified: { ...verification, ...stamp } } : { ...a, verified: undefined })));
}

export async function addPhotos(assetId: string, files: File[]) {
  const a = assetMap(useFm.getState().assets).get(assetId);
  if (!a || files.length === 0) return;
  const by = userName();
  const photos: Photo[] = files.map((file) => ({ id: uid("photo"), assetId, at: now(), by, name: file.name || "photo.jpg", type: file.type || "image/jpeg", blob: file }));
  await persist(() => putMany("photos", photos));
  useFm.setState((s) => ({ photos: [...s.photos, ...photos.map(({ blob: _blob, ...meta }) => meta)] }));
  replaceAssets([{ ...a, photos: [...(a.photos ?? []), ...photos.map((p) => p.id)] }]);
}

export async function photoBlob(id: string): Promise<Blob | null> {
  return (await getOne<Photo>("photos", id))?.blob ?? null;
}

export function deletePhoto(id: string) {
  const s = useFm.getState();
  const meta = s.photos.find((p) => p.id === id);
  if (!meta) return;
  useFm.setState((st) => ({ photos: st.photos.filter((p) => p.id !== id) }));
  void persist(() => deleteMany("photos", [id]));
  const a = assetMap(s.assets).get(meta.assetId);
  if (a) replaceAssets([{ ...a, photos: (a.photos ?? []).filter((p) => p !== id) }]);
}

/** Merges assets changed elsewhere (field change files): per field, the later change wins. */
export function mergeAssetChanges(incoming: Pick<Asset, "id" | "edits" | "verified" | "photos">[]): number {
  const map = assetMap(useFm.getState().assets);
  const changed: Asset[] = [];
  for (const inc of incoming) {
    const a = map.get(inc.id);
    if (!a) continue;
    const edits = { ...(a.edits ?? {}) };
    let touched = false;
    for (const [field, edit] of Object.entries(inc.edits ?? {})) {
      if (!edits[field] || edits[field].at < edit.at) {
        edits[field] = edit;
        touched = true;
      }
    }
    let verified = a.verified;
    if (inc.verified && (!verified || verified.at < inc.verified.at)) {
      verified = inc.verified;
      touched = true;
    }
    const photos = [...new Set([...(a.photos ?? []), ...(inc.photos ?? [])])];
    if (photos.length !== (a.photos ?? []).length) touched = true;
    if (touched) changed.push({ ...a, edits, verified, photos });
  }
  replaceAssets(changed);
  return changed.length;
}

export async function addPhotoRecords(photos: Photo[]) {
  const known = new Set(useFm.getState().photos.map((p) => p.id));
  const fresh = photos.filter((p) => !known.has(p.id));
  if (!fresh.length) return;
  await persist(() => putMany("photos", fresh));
  useFm.setState((s) => ({ photos: [...s.photos, ...fresh.map(({ blob: _blob, ...meta }) => meta)] }));
}

// ---------------------------------------------------------------------------
// Maintenance

export function saveTasks(tasks: TaskTemplate[]) {
  useFm.setState((s) => ({ tasks, rev: s.rev + 1 }));
  void persist(async () => {
    const old = await getAll<TaskTemplate>("tasks");
    await deleteMany("tasks", old.map((t) => t.id));
    await putMany("tasks", tasks);
  });
}

/** Adds plans, replacing plans with the same id. */
export function savePlans(plans: Plan[]) {
  const byId = new Map(plans.map((p) => [p.id, p]));
  useFm.setState((s) => {
    const kept = s.plans.filter((p) => !byId.has(p.id));
    return { plans: [...kept, ...plans], rev: s.rev + 1 };
  });
  void persist(() => putMany("plans", plans));
}

export function deletePlans(ids: string[]) {
  const set = new Set(ids);
  useFm.setState((s) => ({ plans: s.plans.filter((p) => !set.has(p.id)), rev: s.rev + 1 }));
  void persist(() => deleteMany("plans", ids));
}

export function updatePlan(id: string, patch: Partial<Plan>) {
  const plan = useFm.getState().plans.find((p) => p.id === id);
  if (plan) savePlans([{ ...plan, ...patch }]);
}

/** The next `count` work order numbers (WO-0001…), counted per facility. */
function nextNumbers(count: number): string[] {
  const facility = useFm.getState().facility;
  const first = (facility?.woCounter ?? 0) + 1;
  if (facility) updateFacility({ woCounter: first + count - 1 });
  return Array.from({ length: count }, (_, i) => `WO-${String(first + i).padStart(4, "0")}`);
}

export type NewWorkOrder = Pick<WorkOrder, "title" | "kind" | "priority" | "assetIds" | "due"> & Partial<Pick<WorkOrder, "planId" | "assignee" | "description">>;

export function createWorkOrders(items: NewWorkOrder[]): WorkOrder[] {
  const by = userName();
  const at = now();
  const numbers = nextNumbers(items.length);
  const created: WorkOrder[] = items.map((item, i) => ({
    id: uid("wo"),
    number: numbers[i],
    status: "open",
    assignee: "",
    description: "",
    ...item,
    createdAt: at,
    createdBy: by,
    updatedAt: at,
    log: [{ at, by, text: item.planId ? "Raised from the maintenance plan" : "Created" }],
  }));
  useFm.setState((s) => ({ workOrders: [...created.slice().reverse(), ...s.workOrders], rev: s.rev + 1 }));
  void persist(() => putMany("workOrders", created));
  return created;
}

/** Changes a work order; `note` goes into its log. Completing a planned one moves its plan on. */
export function updateWorkOrder(id: string, patch: Partial<WorkOrder>, note?: string) {
  const s = useFm.getState();
  const wo = s.workOrders.find((w) => w.id === id);
  if (!wo) return;
  const at = now();
  const by = userName();
  const log = [...wo.log];
  if (patch.status && patch.status !== wo.status) log.push({ at, by, text: `Status: ${patch.status.replace("-", " ")}` });
  if (note?.trim()) log.push({ at, by, text: note.trim() });
  const next: WorkOrder = { ...wo, ...patch, log, updatedAt: at };
  if (patch.status === "done" && wo.status !== "done") {
    next.completedAt = patch.completedAt ?? at;
    next.completedBy = by;
    const plan = wo.planId ? s.plans.find((p) => p.id === wo.planId) : undefined;
    if (plan) savePlans([completePlan(plan, (next.completedAt ?? at).slice(0, 10) || todayIso())]);
  }
  useFm.setState((st) => ({ workOrders: st.workOrders.map((w) => (w.id === id ? next : w)), rev: st.rev + 1 }));
  void persist(() => putMany("workOrders", [next]));
}

/**
 * Merges work orders changed elsewhere: the later update wins. A new work order whose number is
 * already taken here (both devices handed out the next number) gets the next free one.
 */
export function mergeWorkOrders(incoming: WorkOrder[]): number {
  const s = useFm.getState();
  const byId = new Map(s.workOrders.map((w) => [w.id, w]));
  const numbers = new Set(s.workOrders.map((w) => w.number));
  // A work order known here keeps the number it has here.
  let changed = incoming.filter((w) => !byId.has(w.id) || byId.get(w.id)!.updatedAt < w.updatedAt).map((w) => (byId.has(w.id) ? { ...w, number: byId.get(w.id)!.number } : w));
  if (!changed.length) return 0;
  const clashes = changed.filter((w) => !byId.has(w.id) && numbers.has(w.number));
  if (clashes.length) {
    const fresh = nextNumbers(clashes.length);
    const renamed = new Map(clashes.map((w, i) => [w.id, fresh[i]]));
    const at = now();
    changed = changed.map((w) => {
      const number = renamed.get(w.id);
      return number ? { ...w, number, log: [...w.log, { at, by: userName(), text: `Numbered ${number} here (it was ${w.number} on the device it came from)` }] } : w;
    });
  }
  // Numbers handed out elsewhere are not handed out again here.
  const highest = Math.max(0, ...changed.map((w) => Number(/^WO-(\d+)$/.exec(w.number)?.[1] ?? 0)));
  const facility = useFm.getState().facility;
  if (facility && highest > facility.woCounter) updateFacility({ woCounter: highest });
  const map = new Map(changed.map((w) => [w.id, w]));
  const merged = [...s.workOrders.filter((w) => !map.has(w.id)), ...changed].sort((a, b) => b.number.localeCompare(a.number, undefined, { numeric: true }));
  useFm.setState((st) => ({ workOrders: merged, rev: st.rev + 1 }));
  void persist(() => putMany("workOrders", changed));
  return changed.length;
}

// ---------------------------------------------------------------------------
// Live data

export function saveSources(sources: LiveSource[]) {
  useFm.setState({ sources });
  void persist(async () => {
    const old = await getAll<LiveSource>("sources");
    await deleteMany("sources", old.filter((o) => !sources.some((s) => s.id === o.id)).map((o) => o.id));
    await putMany("sources", sources);
  });
}

export function upsertPoints(points: Point[]) {
  if (!points.length) return;
  const byId = new Map(points.map((p) => [p.id, p]));
  useFm.setState((s) => ({ points: [...s.points.filter((p) => !byId.has(p.id)), ...points].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), rev: s.rev + 1 }));
  void persist(() => putMany("points", points));
}

export function deletePoints(ids: string[]) {
  const set = new Set(ids);
  useFm.setState((s) => {
    const series = { ...s.series };
    for (const id of ids) delete series[id];
    return { points: s.points.filter((p) => !set.has(p.id)), alarms: s.alarms.filter((a) => !set.has(a.pointId)), series, rev: s.rev + 1 };
  });
  void persist(async () => {
    await deleteMany("points", ids);
    await deleteMany("series", ids);
    const alarms = await getAll<Alarm>("alarms");
    await deleteMany("alarms", alarms.filter((a) => set.has(a.pointId)).map((a) => a.id));
  });
}

function applyAlarmChanges(alarms: Alarm[], changes: AlarmChanges): { alarms: Alarm[]; changed: Alarm[] } {
  if (!changes.opened.length && !changes.closed.length) return { alarms, changed: [] };
  const ends = new Map(changes.closed.map((c) => [c.id, c.end]));
  const changed: Alarm[] = [...changes.opened];
  const next = alarms.map((a) => {
    const end = ends.get(a.id);
    if (end === undefined) return a;
    const closed = { ...a, end };
    changed.push(closed);
    return closed;
  });
  return { alarms: [...changes.opened, ...next], changed };
}

let seriesDirty = new Set<string>();
let seriesTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSeriesWrite() {
  if (seriesTimer) return;
  seriesTimer = setTimeout(() => {
    seriesTimer = null;
    const ids = [...seriesDirty];
    seriesDirty = new Set();
    const s = useFm.getState();
    const known = new Set(s.points.map((p) => p.id));
    const rows = ids.filter((id) => known.has(id)).map((pointId) => ({ pointId, values: s.series[pointId] ?? [] }));
    const points = s.points.filter((p) => ids.includes(p.id));
    void persist(async () => {
      await putMany("series", rows);
      await putMany("points", points);
    });
  }, 2000);
}

export interface Reading {
  pointId: string;
  t: number;
  v: number | string;
}

/** Takes in readings: latest values, history, and the alarms they start or end. */
export function ingestReadings(readings: Reading[]) {
  if (!readings.length) return;
  const s = useFm.getState();
  const byId = new Map(s.points.map((p) => [p.id, p]));
  const series = { ...s.series };
  let alarms = s.alarms;
  const changedAlarms: Alarm[] = [];
  const updated = new Map<string, Point>();
  for (const r of [...readings].sort((a, b) => a.t - b.t)) {
    const point = updated.get(r.pointId) ?? byId.get(r.pointId);
    if (!point) continue;
    const list = (series[r.pointId] = [...(series[r.pointId] ?? [])]);
    list.push([r.t, r.v]);
    if (list.length > SERIES_LIMIT) list.splice(0, list.length - SERIES_LIMIT);
    const result = applyAlarmChanges(alarms, evaluateReading(point, r.v, r.t, alarms));
    alarms = result.alarms;
    changedAlarms.push(...result.changed);
    if (!point.lastAt || r.t >= point.lastAt) updated.set(point.id, { ...point, lastValue: r.v, lastAt: r.t });
    seriesDirty.add(r.pointId);
  }
  useFm.setState((st) => ({
    series,
    alarms,
    points: updated.size ? st.points.map((p) => updated.get(p.id) ?? p) : st.points,
    liveRev: st.liveRev + 1,
  }));
  if (changedAlarms.length) void persist(() => putMany("alarms", changedAlarms));
  scheduleSeriesWrite();
}

/** Opens "no data" alarms for points that have gone quiet. */
export function checkStale(nowMs = Date.now()) {
  const s = useFm.getState();
  const result = applyAlarmChanges(s.alarms, evaluateStale(s.points, nowMs, s.alarms));
  if (!result.changed.length) return;
  useFm.setState((st) => ({ alarms: result.alarms, liveRev: st.liveRev + 1 }));
  void persist(() => putMany("alarms", result.changed));
}

export function acknowledgeAlarms(ids: string[]) {
  const set = new Set(ids);
  const by = userName();
  const at = Date.now();
  const changed: Alarm[] = [];
  useFm.setState((s) => ({
    alarms: s.alarms.map((a) => {
      if (!set.has(a.id) || a.ackAt) return a;
      const next = { ...a, ackAt: at, ackBy: by };
      changed.push(next);
      return next;
    }),
    liveRev: s.liveRev + 1,
  }));
  void persist(() => putMany("alarms", changed));
}

/** Removes ended and acknowledged alarms from the list. */
export function clearClosedAlarms() {
  const s = useFm.getState();
  const gone = s.alarms.filter((a) => a.end !== undefined && a.ackAt !== undefined).map((a) => a.id);
  if (!gone.length) return;
  const set = new Set(gone);
  useFm.setState((st) => ({ alarms: st.alarms.filter((a) => !set.has(a.id)), liveRev: st.liveRev + 1 }));
  void persist(() => deleteMany("alarms", gone));
}

export type { StoreName };
