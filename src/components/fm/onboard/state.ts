// The onboarding wizard's state and work: the models read (in a conversion
// worker of its own, so they never end up in the Convert page's IFC files),
// the building's details, the asset categories, the register as a
// workspace, gaps filled per type, and maintenance planned.

import { create } from "zustand";
import { DEFAULT_ASSET_CATEGORIES, DEFAULT_CODE_PATTERN, initials } from "@/lib/convert/assets/categories";
import type { AssetOptions, RegisterSummary } from "@/lib/convert/assets/register";
import { classifySourceName } from "@/lib/convert/bundle";
import { convertWorker, createConvertClient, type ConvertClient, type WorkspaceResult } from "@/lib/convert/client";
import type { IfcSourceInfo } from "@/lib/convert/ifc-source";
import { useConvertStore } from "@/lib/convert/store";
import { mergeStoreys } from "@/lib/convert/storeys";
import type { ConvertOptions, PartSummary, StoreyDef } from "@/lib/convert/types";
import { findModelFiles, modelBytes, modelFileName, type FolderEntry } from "@/lib/collection/files";
import { generatePlans } from "@/lib/fm/planning";
import { modelValue } from "@/lib/fm/asset";
import { replaceWorkspace, uid } from "@/lib/fm/store";
import { DEFAULT_TASKS } from "@/lib/fm/tasks";
import type { Asset, Facility, WorkspaceData } from "@/lib/fm/types";
import { todayIso } from "@/lib/fm/schedule";

export type Step = "models" | "building" | "assets" | "gaps" | "maintenance" | "done";
export const STEPS: { id: Step; label: string }[] = [
  { id: "models", label: "Models" },
  { id: "building", label: "Building" },
  { id: "assets", label: "Assets" },
  { id: "gaps", label: "Fill gaps by type" },
  { id: "maintenance", label: "Maintenance" },
  { id: "done", label: "Create" },
];

export interface ReadModel {
  id: string;
  name: string;
  size: number;
  kind: "ifc" | "extract";
  status: "reading" | "ready" | "failed";
  phase?: string;
  progress?: number;
  error?: string;
  jobs: string[];
  info?: IfcSourceInfo;
}

export interface FacilityDraft {
  name: string;
  site: string;
  address: string;
  siteCode: string;
  buildingCode: string;
  currency: string;
  pattern: string;
  user: string;
}

/** Type information worth filling once for all assets of a type. */
export const TYPE_GAP_FIELDS = ["manufacturer", "model", "expectedLife", "warrantyDurationParts"] as const;

export interface OnboardState {
  step: Step;
  /** files: models read here; convert: the models loaded on the Convert page. */
  mode: "files" | "convert";
  models: ReadModel[];
  parts: PartSummary[];
  storeys: StoreyDef[];
  facility: FacilityDraft;
  /** The details were typed by hand: models read later do not overwrite them. */
  edited: boolean;
  categories: string[];
  summary: RegisterSummary | null;
  summaryBusy: boolean;
  workspace: WorkspaceResult | null;
  /** Values typed per type: type name -> field -> value. */
  typeValues: Record<string, Record<string, string>>;
  plan: { skip: boolean; start: string; spread: boolean; fromModel: boolean; kinds: string[] | null };
  busy: string | null;
  error: string | null;
  created: boolean;
}

const initial = (): OnboardState => ({
  step: "models",
  mode: "files",
  models: [],
  parts: [],
  storeys: [],
  facility: { name: "", site: "", address: "", siteCode: "", buildingCode: "", currency: "", pattern: DEFAULT_CODE_PATTERN, user: "" },
  edited: false,
  categories: [...DEFAULT_ASSET_CATEGORIES],
  summary: null,
  summaryBusy: false,
  workspace: null,
  typeValues: {},
  plan: { skip: false, start: todayIso(), spread: true, fromModel: true, kinds: null },
  busy: null,
  error: null,
  created: false,
});

export const useOnboard = create<OnboardState>(initial);

let client: ConvertClient | null = null;
function worker(): ConvertClient {
  if (useOnboard.getState().mode === "convert") return convertWorker;
  if (!client) client = createConvertClient();
  return client;
}

const set = (patch: Partial<OnboardState>) => useOnboard.setState(patch);
const updateModel = (id: string, patch: Partial<ReadModel>) => useOnboard.setState((s) => ({ models: s.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));

/** Starts over: the models read are dropped (and the worker's memory freed). */
export function resetOnboarding() {
  client?.terminate();
  client = null;
  useOnboard.setState(initial());
}

export function goTo(step: Step) {
  set({ step, error: null });
}

// ---------------------------------------------------------------------------
// Models

async function inflate(data: Blob): Promise<Blob> {
  return new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
}

/** Reads dropped or picked files: IFC (also inside .ifczip / .zip) and viewer extracts (.eapk and job files). */
export async function addModelFiles(files: File[], folder?: FolderEntry[]) {
  if (useOnboard.getState().mode === "convert") set({ mode: "files", parts: [], models: [], summary: null, workspace: null });
  const entries: FolderEntry[] = folder ?? files.map((f) => ({ file: f, path: f.name }));
  const extracts = entries.filter((e) => classifySourceName(e.path.split("/").pop() ?? e.path)).map((e) => e.file);
  const found = await findModelFiles(entries.filter((e) => !classifySourceName(e.path.split("/").pop() ?? e.path)));
  const ifcModels = found.models.filter((m) => !/\.frag$/i.test(m.entry?.name ?? m.path));
  const skipped = entries.length - extracts.length - ifcModels.length;
  if (found.revit || found.navisworks)
    set({ error: `${found.revit + found.navisworks} Revit or Navisworks file(s): read them on the Convert page first (through Autodesk's cloud, the in-browser reader or a viewer link), then use "Models on the Convert page" here.` });
  else if (skipped > 0 && !extracts.length && !ifcModels.length) set({ error: "None of these files is an IFC model or a model extract." });

  for (const m of ifcModels) {
    const id = uid("model");
    const name = modelFileName(m);
    useOnboard.setState((s) => ({ models: [...s.models, { id, name, size: m.size, kind: "ifc", status: "reading", jobs: [], phase: "Waiting" }] }));
    try {
      const bytes = await modelBytes(m);
      if (!bytes) throw new Error("The IFC inside this archive cannot be read (unsupported compression or encryption).");
      const blob = bytes.deflated ? await inflate(bytes.data) : bytes.data;
      const state = await worker().addIfc([{ name, blob }], (phase, done, total) => updateModel(id, { phase, progress: total ? done / total : undefined }));
      const info = state.ifc[0];
      updateModel(id, { status: "ready", jobs: state.added ?? [], info, phase: undefined, progress: undefined });
      afterRead(state.parts);
      prefill(info);
    } catch (error) {
      updateModel(id, { status: "failed", error: error instanceof Error ? error.message : String(error), phase: undefined });
    }
  }
  if (extracts.length) {
    const id = uid("model");
    const name = extracts.length === 1 ? extracts[0].name : `${extracts.length} extract files`;
    useOnboard.setState((s) => ({ models: [...s.models, { id, name, size: extracts.reduce((n, f) => n + f.size, 0), kind: "extract", status: "reading", jobs: [], phase: "Reading" }] }));
    try {
      const state = await worker().addFiles(extracts, (phase) => updateModel(id, { phase }));
      if (!state.added?.length) throw new Error("No model data in these files.");
      updateModel(id, { status: "ready", jobs: state.added, phase: undefined });
      afterRead(state.parts);
      const part = state.parts.find((p) => state.added?.includes(p.job));
      if (part) prefill(null, part.model);
    } catch (error) {
      updateModel(id, { status: "failed", error: error instanceof Error ? error.message : String(error), phase: undefined });
    }
  }
  await refreshStoreys();
}

function afterRead(parts: PartSummary[]) {
  set({ parts, summary: null, workspace: null });
}

/** The building's details from what a model says, unless they were typed already. */
function prefill(info: IfcSourceInfo | null, modelName?: string) {
  const s = useOnboard.getState();
  if (s.edited) return;
  const f = { ...s.facility };
  const name = info?.building && !/^(default|building|unnamed)$/i.test(info.building) ? info.building : info?.project || modelName || "";
  if (!f.name && name) f.name = name;
  if (!f.site && info?.site && !/^(default|site|unnamed)$/i.test(info.site)) f.site = info.site;
  if (!f.address && info?.address) f.address = info.address;
  if (!f.currency && info?.currency) f.currency = info.currency;
  if (!f.buildingCode && f.name) f.buildingCode = initials(f.name);
  if (!f.siteCode && f.site) f.siteCode = initials(f.site);
  set({ facility: f });
}

export async function removeModel(id: string) {
  const m = useOnboard.getState().models.find((x) => x.id === id);
  if (!m) return;
  useOnboard.setState((s) => ({ models: s.models.filter((x) => x.id !== id), summary: null, workspace: null }));
  if (m.jobs.length) {
    const state = await worker().remove(m.jobs);
    set({ parts: state.parts });
  }
  await refreshStoreys();
}

/** Uses what the Convert page has loaded (Revit and Navisworks through Autodesk's cloud, viewer links, extracts). */
export function takeConvertPageModels() {
  client?.terminate();
  client = null;
  const cs = useConvertStore.getState();
  const st = cs.settings;
  const s = useOnboard.getState();
  set({
    mode: "convert",
    models: [],
    parts: cs.parts.filter((p) => cs.partConfig[p.id]?.include !== false),
    storeys: cs.storeys,
    summary: null,
    workspace: null,
    categories: st.assetCategories ?? [...DEFAULT_ASSET_CATEGORIES],
    facility: s.edited
      ? s.facility
      : {
          ...s.facility,
          name: st.buildingName || st.projectName || s.facility.name,
          site: st.siteName && st.siteName !== "Site" ? st.siteName : s.facility.site,
          siteCode: st.siteCode || initials(st.siteName && st.siteName !== "Site" ? st.siteName : ""),
          buildingCode: st.buildingCode || initials(st.buildingName || st.projectName),
          currency: st.currency || s.facility.currency,
          pattern: st.assetCodePattern || DEFAULT_CODE_PATTERN,
        },
  });
}

/** Storeys: those the IFC files define, with storeys found from the levels of other models. */
async function refreshStoreys() {
  const s = useOnboard.getState();
  if (s.mode === "convert") return;
  const ifcLists = s.models.filter((m) => m.status === "ready" && m.info).map((m) => m.info!.storeys);
  const ifcJobs = new Set(s.models.filter((m) => m.kind === "ifc").flatMap((m) => m.jobs));
  const otherParts = s.parts.filter((p) => !ifcJobs.has(p.job)).map((p) => p.id);
  const detected = otherParts.length ? (await worker().storeys(otherParts)).storeys : [];
  set({ storeys: mergeStoreys([...ifcLists, ...(detected.length ? [detected] : [])]) });
}

// ---------------------------------------------------------------------------
// Register

// The Convert page's own option builders are loaded only when its models are used.
async function convertOptions(): Promise<ConvertOptions> {
  const s = useOnboard.getState();
  if (s.mode === "convert") return (await import("@/lib/convert/actions")).buildOptions();
  const name = s.facility.name.trim() || "Building";
  return {
    projectName: name,
    siteName: s.facility.site.trim() || "Site",
    buildingName: name,
    filePrefix: "bimos",
    author: s.facility.user,
    organization: "",
    frame: { mode: "model", origin: [0, 0, 0], rotationDeg: 0 },
    storeys: s.storeys,
    parts: s.parts.map((p) => ({ id: p.id, include: true, discipline: p.suggestion.id })),
    plans: [],
    excludedCategories: [],
    excludePattern: "",
    perDiscipline: false,
    federated: false,
    instancing: true,
    twoSidedOpen: false,
    textures: "none",
    lines: false,
    types: false,
    assets: null,
  };
}

async function registerOptions(): Promise<AssetOptions> {
  const s = useOnboard.getState();
  const base = s.mode === "convert" ? (await import("@/lib/convert/actions")).assetOptions() : { categories: [], sources: {} };
  return {
    ...base,
    categories: s.categories,
    codes: { site: s.facility.siteCode.trim(), building: s.facility.buildingCode.trim(), pattern: s.facility.pattern.trim() || DEFAULT_CODE_PATTERN },
  };
}

let summaryRun = 0;
export async function refreshSummary() {
  const s = useOnboard.getState();
  if (!s.parts.length) return;
  const run = ++summaryRun;
  set({ summaryBusy: true, error: null });
  try {
    const summary = await worker().assets(await convertOptions(), await registerOptions(), (phase) => run === summaryRun && set({ busy: phase }));
    if (run === summaryRun) set({ summary, workspace: null });
  } catch (error) {
    if (run === summaryRun) set({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (run === summaryRun) set({ summaryBusy: false, busy: null });
  }
}

/** The register as workspace data (kept until the categories or codes change). */
export async function buildWorkspace(): Promise<WorkspaceResult | null> {
  const s = useOnboard.getState();
  if (s.workspace) return s.workspace;
  set({ busy: "Building the asset register", error: null });
  try {
    const ws = await worker().workspace(await convertOptions(), await registerOptions(), (phase) => set({ busy: phase }));
    set({ workspace: ws, summary: ws.summary });
    return ws;
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    set({ busy: null });
  }
}

/** COBie, the asset register workbook and the single-line diagrams of what was read. */
export async function handoverFiles(): Promise<{ cobie: Blob; workbook: Blob; sld: Blob } | null> {
  const s = useOnboard.getState();
  set({ busy: "Writing COBie and the asset register", error: null });
  try {
    const r = await worker().assetFiles(await convertOptions(), await registerOptions(), { contactEmail: "", contactCompany: "", contactPhone: "", currency: s.facility.currency }, (phase) => set({ busy: phase }));
    return { cobie: r.cobie, workbook: r.workbook, sld: r.sld };
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    set({ busy: null });
  }
}

// ---------------------------------------------------------------------------
// Types with gaps

export interface TypeRow {
  name: string;
  kind: string;
  count: number;
  /** Most common value per field among the type's assets ("" when none has one). */
  values: Record<string, string>;
  /** Fields every asset of the type has. */
  complete: Record<string, boolean>;
  /** Fields some asset of the type lacks. */
  gaps: number;
}

export function typeRows(assets: Asset[]): TypeRow[] {
  const groups = new Map<string, Asset[]>();
  for (const a of assets) {
    const key = a.typeName || `${a.category}: ${a.family}`;
    const list = groups.get(key);
    if (list) list.push(a);
    else groups.set(key, [a]);
  }
  const rows: TypeRow[] = [];
  for (const [name, list] of groups) {
    const values: Record<string, string> = {};
    const complete: Record<string, boolean> = {};
    let gaps = 0;
    for (const f of TYPE_GAP_FIELDS) {
      const counts = new Map<string, number>();
      for (const a of list) {
        const v = modelValue(a, f);
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const best = [...counts].sort((x, y) => y[1] - x[1])[0];
      values[f] = best?.[0] ?? "";
      const filled = [...counts.values()].reduce((n, c) => n + c, 0);
      complete[f] = filled === list.length;
      if (!complete[f]) gaps++;
    }
    rows.push({ name, kind: list[0].kind, count: list.length, values, complete, gaps });
  }
  return rows.sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Create

/** The workspace the wizard has put together. */
export function workspaceDataFrom(ws: WorkspaceResult): WorkspaceData {
  const s = useOnboard.getState();
  const at = new Date().toISOString();
  const by = s.facility.user.trim() || "Onboarding";
  // Values filled per type become the team's edits on assets that lack them.
  const assets = ws.assets.map((a) => {
    const typed = s.typeValues[a.typeName || `${a.category}: ${a.family}`];
    if (!typed) return a;
    const edits = { ...(a.edits ?? {}) };
    let touched = false;
    for (const [field, value] of Object.entries(typed)) {
      const v = value.trim();
      if (!v || modelValue(a, field)) continue;
      edits[field] = { value: v, at, by };
      touched = true;
    }
    return touched ? { ...a, edits } : a;
  });
  const f = s.facility;
  const facility: Facility = {
    id: uid("facility"),
    name: f.name.trim() || "Building",
    site: f.site.trim(),
    siteCode: f.siteCode.trim(),
    buildingCode: f.buildingCode.trim(),
    address: f.address.trim(),
    currency: f.currency.trim(),
    source: s.mode === "files" && s.models.every((m) => m.kind === "ifc") ? "ifc" : "model",
    labelBaseUrl: "",
    user: f.user.trim(),
    woCounter: 0,
    createdAt: at,
    updatedAt: at,
  };
  const kinds = new Set(s.plan.kinds ?? DEFAULT_TASKS.flatMap((t) => t.kindCodes));
  const plans = s.plan.skip ? [] : generatePlans(assets, DEFAULT_TASKS, [], { start: s.plan.start, kinds, spread: s.plan.spread, fromModel: s.plan.fromModel });
  return { facility, assets, spaces: ws.spaces, systems: ws.systems, tasks: DEFAULT_TASKS, plans, workOrders: [], sources: [], points: [], alarms: [], photos: [] };
}

export async function createFromWizard(): Promise<boolean> {
  const ws = await buildWorkspace();
  if (!ws) return false;
  set({ busy: "Saving the workspace on this device" });
  try {
    await replaceWorkspace(workspaceDataFrom(ws));
    set({ created: true, step: "done" });
    return true;
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    set({ busy: null });
  }
}
