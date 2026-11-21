// What the Convert page does: takes in sources (Revit and Navisworks files,
// extracted viewer bundles, floor plans), turns Revit / Navisworks files into
// model data through Autodesk's cloud or the in-browser Revit reader,
// receives models from the viewer bookmarklet, and drives the conversion
// worker. Runs on the main thread; the heavy lifting is in the workers.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { ApsCancelled, deleteFromAps, downloadDerivative, getApsStatus, progressFraction, startTranslation, uploadToAps, waitForTranslation } from "@/lib/aps/client";
import { handOffFiles } from "@/lib/handoff";
import { LmvSession } from "@/lib/lmv/session";
import { convertRvtLocal, RvtCancelled } from "@/lib/rvt/local";
import { pushToast, uid } from "@/lib/store";
import { baseName, formatBytes } from "@/lib/utils/format";
import { DEFAULT_ASSET_CATEGORIES, DEFAULT_CODE_PATTERN } from "./assets/categories";
import type { AssetOptions } from "./assets/register";
import { classifySourceName } from "./bundle";
import { convertWorker, type WorkerState } from "./client";
import { pxToProject } from "./plans/calibrate";
import { traceInWorker } from "./plans/client";
import { isPlanFile, loadPlanFile } from "./plans/source";
import { DEFAULT_TRACE } from "./plans/trace";
import { updateLink, updatePlan, updateSource, useConvertStore, type PlanItem, type SourceItem, type SourceKind, type SourceMethod } from "./store";
import type { ConvertOptions, OutputFile, PlanPart } from "./types";

const controllers = new Map<string, AbortController>();
const lmvHosts = new Map<string, HTMLElement>();

export function registerLmvHost(sourceId: string, element: HTMLElement | null) {
  if (element) lmvHosts.set(sourceId, element);
  else lmvHosts.delete(sourceId);
}

export async function refreshApsStatus() {
  const aps = await getApsStatus();
  useConvertStore.setState({ aps });
  return aps;
}

function extension(name: string) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function kindOf(name: string): SourceKind | null {
  if (classifySourceName(name)) return "extract";
  const ext = extension(name);
  if (ext === "rvt" || ext === "rfa") return "rvt";
  if (ext === "nwd" || ext === "nwc") return "nwd";
  if (ext === "ifc" || ext === "ifczip") return "ifc";
  if (isPlanFile(name)) return "plan";
  return null;
}

function defaultMethod(kind: SourceKind): SourceMethod {
  const aps = useConvertStore.getState().aps;
  if (kind === "rvt") return aps?.configured ? "aps-extract" : "local";
  if (kind === "nwd") return aps?.configured ? "aps-extract" : "link";
  return "none";
}

/** Names the project after the first model when nothing is set yet. */
function nameProjectFrom(name: string) {
  const { settings } = useConvertStore.getState();
  if (settings.projectName) return;
  const stem = baseName(name)
    .replace(/[-_ ]?(ifcstudio|eapk)$/i, "")
    .replace(/^ifcstudio-/i, "")
    .trim();
  if (!stem) return;
  useConvertStore.setState((s) => ({ settings: { ...s.settings, projectName: stem, buildingName: s.settings.buildingName || stem, filePrefix: s.settings.filePrefix || stem.replace(/\s+/g, "-").slice(0, 40) } }));
}

// ---------------------------------------------------------------------------
// Worker state

function applyWorkerState(state: WorkerState) {
  useConvertStore.setState((s) => {
    const partConfig = { ...s.partConfig };
    for (const part of state.parts) {
      if (!partConfig[part.id]) partConfig[part.id] = { include: true, discipline: part.suggestion.id };
    }
    for (const id of Object.keys(partConfig)) if (!state.parts.some((p) => p.id === id)) delete partConfig[id];
    return { parts: state.parts, jobs: state.jobs, partConfig };
  });
  if (state.ignored?.length) pushToast("info", `Not model data, left out: ${state.ignored.slice(0, 4).join(", ")}${state.ignored.length > 4 ? "…" : ""}`);
  void refreshStoreys();
}

export async function refreshStoreys(force = false) {
  const s = useConvertStore.getState();
  if (s.storeysEdited && !force) return;
  const ids = s.parts.filter((p) => s.partConfig[p.id]?.include !== false).map((p) => p.id);
  if (ids.length === 0) {
    useConvertStore.setState({ storeys: [], storeysEdited: false });
    return;
  }
  const { storeys } = await convertWorker.storeys(ids);
  useConvertStore.setState({ storeys, storeysEdited: false });
}

async function addExtracted(files: File[], sourceId: string) {
  useConvertStore.setState({ busy: `Reading ${files.length === 1 ? files[0].name : `${files.length} files`}` });
  try {
    const state = await convertWorker.addFiles(files, (phase) => useConvertStore.setState({ busy: phase }));
    updateSource(sourceId, { status: "ready", jobs: state.added ?? [], step: undefined, progress: undefined });
    applyWorkerState(state);
    const first = state.parts.find((p) => state.added?.includes(p.job));
    if (first) nameProjectFrom(first.model);
  } catch (error) {
    updateSource(sourceId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  } finally {
    useConvertStore.setState({ busy: null });
  }
}

// ---------------------------------------------------------------------------
// Sources

export async function addSourceFiles(files: File[]) {
  const extracted: File[] = [];
  const others: { file: File; kind: SourceKind }[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const kind = kindOf(file.name);
    if (!kind) skipped.push(file.name);
    else if (kind === "extract") extracted.push(file);
    else others.push({ file, kind });
  }
  if (skipped.length) pushToast("info", `Not a model, bundle or plan: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}`);

  if (extracted.length) {
    const id = uid("src");
    const name = extracted.length === 1 ? extracted[0].name : `${extracted.length} extracted files`;
    useConvertStore.setState((s) => ({ sources: [...s.sources, { id, name, size: extracted.reduce((n, f) => n + f.size, 0), kind: "extract", method: "none", status: "working", step: "Reading" }] }));
    await addExtracted(extracted, id);
  }

  for (const { file, kind } of others) {
    const id = uid("src");
    const item: SourceItem = { id, name: file.name, size: file.size, kind, file, method: defaultMethod(kind), status: "pending" };
    if (kind === "ifc") {
      item.status = "ready";
      item.ifc = { blob: file, name: file.name, note: "Added as IFC", discipline: "other", include: true };
    }
    useConvertStore.setState((s) => ({ sources: [...s.sources, item] }));
    if (kind === "plan") {
      // Plans name the project only when no model does.
      if (!useConvertStore.getState().sources.some((x) => x.kind === "rvt" || x.kind === "nwd" || x.kind === "extract")) nameProjectFrom(file.name);
      void addPlanSource(id, file);
    } else if (kind !== "ifc") nameProjectFrom(file.name);
  }
}

export function setSourceMethod(id: string, method: SourceMethod) {
  updateSource(id, { method });
}

export function cancelSource(id: string) {
  controllers.get(id)?.abort();
}

export async function removeSource(id: string) {
  cancelSource(id);
  const source = useConvertStore.getState().sources.find((s) => s.id === id);
  if (!source) return;
  if (source.jobs?.length) applyWorkerState(await convertWorker.remove(source.jobs));
  useConvertStore.setState((s) => ({
    sources: s.sources.filter((x) => x.id !== id),
    plans: s.plans.filter((p) => {
      if (p.sourceId !== id) return true;
      URL.revokeObjectURL(p.imageUrl);
      return false;
    }),
  }));
}

/** Turns a Revit / Navisworks file into model data with the chosen method. */
export async function processSource(id: string) {
  const source = useConvertStore.getState().sources.find((s) => s.id === id);
  if (!source?.file || source.status === "working") return;
  const file = source.file;
  const controller = new AbortController();
  controllers.set(id, controller);
  const step = (text: string, progress?: number) => updateSource(id, { step: text, progress });
  updateSource(id, { status: "working", error: undefined, step: "Starting", progress: 0 });
  const settings = useConvertStore.getState().settings;
  try {
    if (source.method === "local") {
      const result = await convertRvtLocal(file, file.name, { largeModel: file.size > 200 * 1024 * 1024, savedMeshes: true, phase: null }, (text, progress) => step(text, progress), controller.signal);
      if (result.report.withGeometry === 0 && result.report.carriedByParts === 0) throw new Error("The in-browser reader recovered no geometry from this file. Try Autodesk's cloud instead.");
      const note = `Read in the browser with rvt-rs${result.report.release ? ` · Revit ${result.report.release}` : ""} · ${result.report.withGeometry} of ${result.report.elements} elements with geometry`;
      updateSource(id, { status: "ready", step: undefined, progress: undefined, ifc: { blob: result.ifc, name: `${baseName(file.name)}.ifc`, note, discipline: "architecture", include: true } });
      return;
    }
    if (source.method !== "aps-extract" && source.method !== "aps-ifc") throw new Error("Choose how to read this file first.");
    const aps = useConvertStore.getState().aps ?? (await refreshApsStatus());
    if (!aps.configured) throw new Error("Autodesk Platform Services is not set up on this server.");
    step("Uploading to Autodesk", 0);
    const urn = await uploadToAps(file, file.name, (fraction) => step(`Uploading to Autodesk · ${formatBytes(Math.round(fraction * file.size))} of ${formatBytes(file.size)}`, fraction * 0.3), controller.signal);
    try {
      if (source.method === "aps-ifc") {
        step("Starting Revit's IFC export", 0.3);
        await startTranslation(urn, { output: "ifc", exportSettingName: settings.exportSetup.trim() || undefined }, controller.signal);
        const status = await waitForTranslation(urn, "ifc", (current) => step(`Autodesk is exporting IFC · ${current.progress || current.status}`, 0.3 + 0.5 * (progressFraction(current.progress) ?? 0)), controller.signal);
        step("Downloading the IFC", 0.8);
        const blob = await downloadDerivative(urn, status.ifcDerivativeUrn ?? "", (loaded, total) => step(`Downloading the IFC · ${formatBytes(loaded)}`, total ? 0.8 + 0.2 * (loaded / total) : undefined), controller.signal);
        updateSource(id, { status: "ready", step: undefined, progress: undefined, ifc: { blob, name: `${baseName(file.name)}.ifc`, note: `Revit's IFC exporter on Autodesk's cloud · ${settings.exportSetup}`, discipline: "architecture", include: true } });
        return;
      }
      step("Autodesk is translating the model", 0.3);
      await startTranslation(urn, { output: "svf2", hiddenObjects: false, materialProperties: true }, controller.signal);
      await waitForTranslation(urn, "svf2", (current) => step(`Autodesk is translating the model · ${current.progress || current.status}`, 0.3 + 0.3 * (progressFraction(current.progress) ?? 0)), controller.signal);
      // The viewer needs a visible, sized element to start in; the source row provides one while working.
      let host = lmvHosts.get(id);
      for (let i = 0; !host && i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        host = lmvHosts.get(id);
      }
      if (!host) throw new Error("The viewer panel for this file is not on screen.");
      const session = await LmvSession.create(host, { kind: "aps", urn, region: aps.region }, (label, fraction) => step(label, 0.6 + 0.15 * (fraction ?? 0)));
      try {
        if (controller.signal.aborted) throw new ApsCancelled();
        const extractor = await loadExtractor();
        const jobs = await extractor.extract(session.viewer, {
          props: "all",
          onProgress: (p: { index: number; total: number; file: string; phase: string }) => step(`Reading ${p.file} (${p.phase})`, 0.75 + 0.2 * ((p.index + (p.phase === "properties" ? 0.5 : 0)) / p.total)),
        });
        step("Analysing the model", 0.95);
        const state = await convertWorker.addJobs(
          jobs.map((j: any) => ({ name: j.name, bin: j.bin, props: j.props, textures: j.textures ?? [] })),
          (phase) => step(phase, 0.97),
        );
        updateSource(id, { status: "ready", jobs: state.added ?? [], step: undefined, progress: undefined });
        applyWorkerState(state);
      } finally {
        session.dispose();
      }
    } finally {
      if (settings.deleteFromAps) void deleteFromAps(urn);
    }
  } catch (error) {
    if (error instanceof ApsCancelled || error instanceof RvtCancelled || controller.signal.aborted) updateSource(id, { status: "cancelled", step: undefined, progress: undefined });
    else {
      const message = error instanceof Error ? error.message : String(error);
      updateSource(id, { status: "failed", step: undefined, progress: undefined, error: message });
    }
  } finally {
    controllers.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Extractor (the same script runs in the app and as the bookmarklet)

let extractorSource: Promise<string> | null = null;

export function extractorScript(): Promise<string> {
  if (!extractorSource) {
    extractorSource = fetch("/convert/ifcstudio-extractor.js", { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error("The extractor script could not be loaded.");
      return r.text();
    });
    extractorSource.catch(() => (extractorSource = null));
  }
  return extractorSource;
}

async function loadExtractor(): Promise<any> {
  const w = window as any;
  if (w.IFCStudioExtractor?.extract) return w.IFCStudioExtractor;
  const source = await extractorScript();
  // Evaluated as a classic script, as on a viewer page.
  const script = document.createElement("script");
  script.textContent = source;
  document.head.appendChild(script);
  script.remove();
  if (!w.IFCStudioExtractor?.extract) throw new Error("The extractor script did not start.");
  return w.IFCStudioExtractor;
}

/** Light minification for the bookmarklet: drops comments and indentation (the source is written for it). */
function compact(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .join("\n");
}

export async function bookmarkletHref(appOrigin: string): Promise<string> {
  const body = `${compact(await extractorScript())}\nIFCStudioExtractor.open(${JSON.stringify(appOrigin)});`;
  return `javascript:${encodeURIComponent(`(function(){${body}})();`)}`;
}

export async function consoleSnippet(appOrigin: string): Promise<string> {
  return `${await extractorScript()}\nIFCStudioExtractor.open(${JSON.stringify(appOrigin)});\n`;
}

// ---------------------------------------------------------------------------
// Viewer link: open the page, wait for the bookmarklet to send the model.

let viewerWindow: Window | null = null;
let linkSession = "";
let linkSourceId = "";
let listening = false;

function onLinkMessage(event: MessageEvent) {
  if (!viewerWindow || event.source !== viewerWindow) return;
  const data = event.data as { source?: string; op?: string; session?: string; index?: number; total?: number; name?: string; file?: string; model?: string; bin?: Blob; props?: Blob | null; textures?: (Blob | null)[] };
  if (!data || data.source !== "ifcstudio-extractor") return;
  if (data.op === "hello") {
    linkSession = uid("link");
    updateLink({ status: "connected", origin: event.origin, message: data.model ? `Connected to ${data.model}` : undefined });
    viewerWindow.postMessage({ source: "ifcstudio", op: "welcome", session: linkSession }, event.origin);
    return;
  }
  if (data.session !== linkSession) return;
  if (data.op === "job" && data.bin instanceof Blob) {
    const origin = event.origin;
    const index = data.index ?? 0;
    const total = data.total ?? 1;
    updateLink({ status: "receiving", total, message: `Receiving ${data.file ?? data.name}` });
    if (!linkSourceId || !useConvertStore.getState().sources.some((s) => s.id === linkSourceId)) {
      linkSourceId = uid("src");
      const label = data.model ? `${data.model} (viewer link)` : "Model from the viewer link";
      useConvertStore.setState((s) => ({ sources: [...s.sources, { id: linkSourceId, name: label, size: 0, kind: "extract", method: "link", status: "working", step: "Receiving", jobs: [] }] }));
      if (data.model) nameProjectFrom(data.model);
    }
    const sourceId = linkSourceId;
    void (async () => {
      try {
        const textures = Array.isArray(data.textures) ? data.textures.map((t) => (t instanceof Blob ? t : null)) : [];
        const state = await convertWorker.addJobs([{ name: data.name ?? `job-${index}`, bin: data.bin!, props: data.props ?? null, textures }]);
        const src = useConvertStore.getState().sources.find((s) => s.id === sourceId);
        const size = data.bin!.size + (data.props?.size ?? 0) + textures.reduce((n, t) => n + (t?.size ?? 0), 0);
        updateSource(sourceId, { jobs: [...(src?.jobs ?? []), ...(state.added ?? [])], size: (src?.size ?? 0) + size, step: `Received ${index + 1} of ${total}` });
        applyWorkerState(state);
        updateLink({ received: useConvertStore.getState().link.received + 1 });
        viewerWindow?.postMessage({ source: "ifcstudio", op: "ack", index, total }, origin);
      } catch (error) {
        updateSource(sourceId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return;
  }
  if (data.op === "done") {
    updateLink({ status: "done", message: `Received ${data.total ?? 0} file${data.total === 1 ? "" : "s"} from the viewer` });
    const sourceId = linkSourceId;
    setTimeout(() => updateSource(sourceId, { status: "ready", step: undefined }), 300);
    linkSourceId = "";
  }
}

/** Opens a viewer link in a new window that can talk back to this page. Call from a click handler. */
export function openViewerLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    updateLink({ status: "error", message: "That is not a web address." });
    return false;
  }
  if (parsed.protocol !== "https:") {
    updateLink({ status: "error", message: "Use the https:// link of the shared model." });
    return false;
  }
  if (!listening) {
    window.addEventListener("message", onLinkMessage);
    listening = true;
  }
  // No "noopener": the bookmarklet sends the model back through window.opener.
  viewerWindow = window.open(parsed.href, "ifcstudio-viewer");
  if (!viewerWindow) {
    updateLink({ status: "error", message: "The browser blocked the new window. Allow pop-ups for this site and try again." });
    return false;
  }
  updateLink({ url: parsed.href, status: "opened", received: 0, total: 0, message: undefined, origin: undefined });
  return true;
}

// ---------------------------------------------------------------------------
// Plans

async function addPlanSource(sourceId: string, file: File) {
  updateSource(sourceId, { status: "working", step: /\.pdf$/i.test(file.name) ? "Rendering the PDF" : "Reading the image" });
  try {
    const rasters = await loadPlanFile(file);
    const existing = useConvertStore.getState().plans;
    const plans: PlanItem[] = rasters.map((r, i) => {
      const index = existing.length + i;
      return {
        id: uid("plan"),
        sourceId,
        label: r.label,
        fileName: r.fileName,
        page: r.page,
        width: r.width,
        height: r.height,
        imageUrl: r.imageUrl,
        gray: r.gray,
        lightPaper: r.lightPaper,
        metresPerPixelAtFullSize: r.metresPerPixelAtFullSize,
        drawingScale: null,
        calibration: null,
        trace: { mode: "filled", darkWalls: r.lightPaper, threshold: null, minThickness: 0.08, maxThickness: 0.6, defaultThickness: 0.2, minLength: 0.5, doorGap: 1.2, orthogonal: true, region: null },
        walls: [],
        outline: [],
        traced: false,
        tracing: false,
        storey: { name: `Level ${index}`, elevation: Math.round(index * 3.5 * 100) / 100, height: 3 },
        slabThickness: 0.2,
        withSlab: true,
        include: true,
        discipline: "plans",
      };
    });
    useConvertStore.setState((s) => ({ plans: [...s.plans, ...plans] }));
    updateSource(sourceId, { status: "ready", step: undefined, progress: undefined });
    if (plans.length === 1) useConvertStore.setState({ editingPlan: plans[0].id });
  } catch (error) {
    updateSource(sourceId, { status: "failed", step: undefined, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function tracePlan(id: string) {
  const plan = useConvertStore.getState().plans.find((p) => p.id === id);
  if (!plan?.calibration || !(plan.calibration.metresPerPixel > 0)) return;
  const m = plan.calibration.metresPerPixel;
  const t = plan.trace;
  updatePlan(id, { tracing: true, traceError: undefined });
  try {
    const result = await traceInWorker(plan.width, plan.height, plan.gray, {
      ...DEFAULT_TRACE,
      mode: t.mode,
      darkWalls: t.darkWalls,
      threshold: t.threshold,
      minThickness: Math.max(1.5, t.minThickness / m),
      maxThickness: Math.max(3, t.maxThickness / m),
      defaultThickness: Math.max(1, t.defaultThickness / m),
      minLength: Math.max(4, t.minLength / m),
      closeGap: Math.max(4, t.doorGap / m),
      orthogonal: t.orthogonal,
      region: t.region,
    });
    updatePlan(id, { walls: result.walls, outline: result.outline, traced: true, tracing: false, trace: { ...t, threshold: t.threshold } });
    if (result.walls.length === 0) updatePlan(id, { traceError: "No walls found. Check the scale, the wall style and the thickness range." });
  } catch (error) {
    updatePlan(id, { tracing: false, traceError: error instanceof Error ? error.message : String(error) });
  }
}

/** A plan in metres, for the conversion worker. */
export function planToPart(plan: PlanItem): PlanPart | null {
  const cal = plan.calibration;
  if (!cal || !(cal.metresPerPixel > 0)) return null;
  const m = cal.metresPerPixel;
  const outline = plan.withSlab && plan.outline.length >= 3 ? plan.outline.map((p) => pxToProject(cal, p)) : null;
  // Walls on the outline are external.
  const onOutline = (a: [number, number], b: [number, number]) => {
    if (!outline) return false;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i],
        q = outline[(i + 1) % outline.length];
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const d = Math.abs((mid[0] - p[0]) * (q[1] - p[1]) - (mid[1] - p[1]) * (q[0] - p[0])) / L;
      const t = ((mid[0] - p[0]) * (q[0] - p[0]) + (mid[1] - p[1]) * (q[1] - p[1])) / (L * L);
      if (d < 1 && t > -0.05 && t < 1.05) return true;
    }
    return false;
  };
  return {
    id: plan.id,
    name: plan.label,
    source: plan.label,
    discipline: plan.discipline,
    include: plan.include,
    storey: plan.storey,
    walls: plan.walls.map((w) => {
      const a = pxToProject(cal, w.a);
      const b = pxToProject(cal, w.b);
      return { a, b, thickness: Math.round(w.thickness * m * 1000) / 1000, external: onOutline(a, b) };
    }),
    slab: outline ? { outline, thickness: plan.slabThickness } : null,
  };
}

// ---------------------------------------------------------------------------
// Generation

export function buildOptions(): ConvertOptions {
  const s = useConvertStore.getState();
  const st = s.settings;
  const name = st.projectName.trim() || "Converted model";
  return {
    projectName: name,
    siteName: st.siteName.trim() || "Site",
    buildingName: st.buildingName.trim() || name,
    filePrefix: (st.filePrefix.trim() || name).replace(/[\\/:*?"<>|]+/g, "-"),
    author: st.author,
    organization: st.organization,
    frame: st.frame,
    storeys: s.storeys,
    parts: s.parts.map((p) => ({ id: p.id, include: s.partConfig[p.id]?.include ?? true, discipline: s.partConfig[p.id]?.discipline ?? p.suggestion.id })),
    plans: s.plans
      .filter((p) => p.include && p.calibration && p.calibration.metresPerPixel > 0 && (p.walls.length > 0 || (p.withSlab && p.outline.length >= 3)))
      .map(planToPart)
      .filter((p): p is PlanPart => p !== null),
    excludedCategories: st.excludedCategories,
    excludePattern: st.excludePattern,
    perDiscipline: st.perDiscipline,
    federated: st.federated,
    instancing: st.instancing,
    twoSidedOpen: st.twoSidedOpen,
    textures: st.textures,
    lines: st.lines,
    types: st.types,
    assets: st.assetsInIfc ? assetOptions() : null,
  };
}

/** Which categories are assets and where fields are read from, as set on the page. */
export function assetOptions(): AssetOptions {
  const st = useConvertStore.getState().settings;
  return {
    categories: st.assetCategories ?? DEFAULT_ASSET_CATEGORIES,
    sources: st.assetSources,
    codes: { site: st.siteCode.trim(), building: st.buildingCode.trim(), pattern: st.assetCodePattern.trim() || DEFAULT_CODE_PATTERN },
  };
}

export async function generate() {
  const options = buildOptions();
  if (!options.parts.some((p) => p.include) && options.plans.length === 0) {
    pushToast("info", "Nothing to convert yet: add a model or trace a plan.");
    return;
  }
  useConvertStore.setState({ generation: { running: true, phase: "Starting", done: 0, total: 0, startedAt: Date.now() }, outputs: [], report: null });
  try {
    const { files, report } = await convertWorker.generate(options, (phase, done, total) => useConvertStore.setState((s) => ({ generation: s.generation ? { ...s.generation, phase, done, total } : s.generation })));
    useConvertStore.setState((s) => ({ outputs: files, report, generation: s.generation ? { ...s.generation, running: false, phase: "Done" } : null }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useConvertStore.setState((s) => ({ generation: s.generation ? { ...s.generation, running: false, error: message === "Cancelled" ? undefined : message, phase: message === "Cancelled" ? "Cancelled" : "Failed" } : null }));
  }
}

export function cancelGeneration() {
  void convertWorker.cancel();
}

/** IFC files delivered as-is by Revit's exporter or the in-browser reader. */
export function passThroughFiles(): { name: string; blob: Blob; note: string; discipline: string }[] {
  return useConvertStore
    .getState()
    .sources.filter((s) => s.ifc?.include)
    .map((s) => ({ name: s.ifc!.name, blob: s.ifc!.blob, note: s.ifc!.note, discipline: s.ifc!.discipline }));
}

/** Hands the chosen files to the IFC viewer; the caller navigates to /ifc. */
export function handOffToViewer(which: "disciplines" | "federated" | string) {
  const s = useConvertStore.getState();
  let picked: OutputFile[];
  if (which === "disciplines") picked = s.outputs.filter((o) => o.discipline !== null);
  else if (which === "federated") picked = s.outputs.filter((o) => o.discipline === null);
  else picked = s.outputs.filter((o) => o.name === which);
  if (picked.length === 0 && which === "disciplines") picked = s.outputs;
  const files = picked.map((o) => new File([o.blob], o.name, { type: "application/x-step" }));
  if (which === "disciplines" || which === "federated") for (const p of passThroughFiles()) files.push(new File([p.blob], p.name, { type: "application/x-step" }));
  handOffFiles(files);
  return files.length;
}

/** Every file of the results with its path: IFC files, pass-through IFCs and their texture pictures (once). */
export function resultFiles(outputs: OutputFile[] = useConvertStore.getState().outputs): { path: string; blob: Blob }[] {
  const files = [...outputs.map((o) => ({ path: o.name, blob: o.blob })), ...passThroughFiles().map((p) => ({ path: p.name, blob: p.blob }))];
  const seen = new Set<string>();
  for (const o of outputs)
    for (const a of o.assets ?? []) {
      if (seen.has(a.path)) continue;
      seen.add(a.path);
      files.push(a);
    }
  return files;
}

/** Writes all outputs into a folder the user picks (Chromium browsers); false when unsupported. */
export async function saveAllToFolder(): Promise<boolean> {
  const picker = (window as any).showDirectoryPicker;
  if (typeof picker !== "function") return false;
  let dir: any;
  try {
    dir = await picker.call(window, { mode: "readwrite", id: "ifc-studio-convert" });
  } catch {
    return true; // dismissed
  }
  const files = resultFiles();
  for (const f of files) {
    // Textures go into their folder next to the IFC files, as the IFC files refer to them.
    const segments = f.path.split("/");
    let folder = dir;
    for (const segment of segments.slice(0, -1)) folder = await folder.getDirectoryHandle(segment, { create: true });
    const handle = await folder.getFileHandle(segments[segments.length - 1], { create: true });
    const writable = await handle.createWritable();
    await f.blob.stream().pipeTo(writable);
  }
  const ifcCount = files.filter((f) => !f.path.includes("/")).length;
  const textures = files.length - ifcCount;
  pushToast("success", `Saved ${ifcCount} file${ifcCount === 1 ? "" : "s"}${textures ? ` and ${textures} texture${textures === 1 ? "" : "s"}` : ""} to ${dir.name}.`);
  return true;
}

async function zipFiles(files: { path: string; blob: Blob }[]): Promise<Blob> {
  const { ZipWriter } = await import("@/lib/utils/zip-writer");
  const zip = new ZipWriter();
  // Pictures are compressed already.
  for (const f of files) await zip.addBlob(f.path, f.blob, !/\.(png|jpe?g)$/i.test(f.path));
  return zip.finish();
}

/** One output as a ZIP archive with its textures folder. */
export function zipOutput(output: OutputFile): Promise<Blob> {
  return zipFiles([{ path: output.name, blob: output.blob }, ...(output.assets ?? [])]);
}

/** All results in one ZIP archive. */
export function zipResults(): Promise<Blob> {
  return zipFiles(resultFiles());
}
