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
import { pxToProject, type PlanCalibration } from "./plans/calibrate";
import { traceInWorker } from "./plans/client";
import { readSheets } from "./plans/ocr";
import { attachOpenings } from "./plans/part";
import { findSheet, straightenedSize, warpQuad } from "./plans/photo";
import { DEFAULT_RECOGNIZE, type LayerRole } from "./plans/recognize";
import { typeRoomsByName } from "./plans/roomTypes";
import { isPlanFile, loadPlanFile, type PlanRaster } from "./plans/source";
import { DEFAULT_TRACE } from "./plans/trace";
import { paperColor, planView, toPx, type LayerPaths } from "./plans/vector";
import { vectorPlans } from "./plans/vectorClient";
import { DEFAULT_SIZES, updateLink, updatePlan, updateSource, useConvertStore, type PlanItem, type PlanPicture, type PlanVector, type SourceItem, type SourceKind, type SourceMethod } from "./store";
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
  const drawings = new Set(
    useConvertStore
      .getState()
      .plans.filter((p) => p.sourceId === id && p.vector)
      .map((p) => p.vector!.drawingId),
  );
  for (const d of drawings) void vectorPlans.release(d).catch(() => undefined);
  useConvertStore.setState((s) => ({
    sources: s.sources.filter((x) => x.id !== id),
    plans: s.plans.filter((p) => {
      if (p.sourceId !== id) return true;
      if (p.imageUrl) URL.revokeObjectURL(p.imageUrl);
      const original = p.vector?.picture?.original?.imageUrl;
      if (original && original !== p.imageUrl) URL.revokeObjectURL(original);
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

type PlanBase = Pick<PlanItem, "sourceId" | "label" | "fileName" | "page" | "width" | "height" | "imageUrl" | "gray" | "lightPaper" | "metresPerPixelAtFullSize"> & Partial<PlanItem>;

function newPlan(base: PlanBase, index: number): PlanItem {
  return {
    id: uid("plan"),
    drawingScale: null,
    calibration: null,
    trace: { mode: "filled", darkWalls: base.lightPaper, threshold: null, minThickness: 0.08, maxThickness: 0.6, defaultThickness: 0.2, minLength: 0.5, doorGap: 1.2, orthogonal: true, region: null },
    walls: [],
    outline: [],
    traced: false,
    tracing: false,
    storey: { name: `Level ${index}`, elevation: Math.round(index * 3.5 * 100) / 100, height: 3 },
    slabThickness: 0.2,
    withSlab: true,
    include: true,
    discipline: "plans",
    openings: [],
    rooms: [],
    columns: [],
    sizes: { ...DEFAULT_SIZES },
    vector: null,
    ...base,
  };
}

const VECTOR_SETTINGS = {
  minThickness: DEFAULT_RECOGNIZE.minThickness,
  maxThickness: DEFAULT_RECOGNIZE.maxThickness,
  singleLines: DEFAULT_RECOGNIZE.singleLines,
  defaultThickness: DEFAULT_RECOGNIZE.defaultThickness,
  rooms: DEFAULT_RECOGNIZE.rooms,
};

export const DWG_MESSAGE = "DWG files can't be read in the browser yet. In AutoCAD (or any DWG viewer) use Save As → DXF, any version, or export a PDF, and add that instead.";

async function addPlanSource(sourceId: string, file: File) {
  if (/\.dwg$/i.test(file.name)) {
    updateSource(sourceId, { status: "failed", step: undefined, error: DWG_MESSAGE });
    return;
  }
  if (/\.dxf$/i.test(file.name)) return addDxfSource(sourceId, file);
  updateSource(sourceId, { status: "working", step: /\.pdf$/i.test(file.name) ? "Rendering the PDF" : "Reading the image" });
  try {
    const rasters = await loadPlanFile(file);
    const existing = useConvertStore.getState().plans;
    const plans: PlanItem[] = [];
    for (const [i, r] of rasters.entries()) {
      const plan = newPlan(
        {
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
        },
        existing.length + i,
      );
      if (r.vector) {
        // A PDF drawn as line work: read its paths.
        const pdf = r.vector.pdf;
        const drawingId = `${sourceId}#${r.page ?? 1}`;
        try {
          const info = await vectorPlans.open(drawingId, pdf.drawing);
          plan.vector = {
            drawingId,
            kind: "pdf",
            region: [0, 0, pdf.width, pdf.height],
            view: { x0: 0, y1: pdf.height, k: r.vector.pxPerPoint, width: r.width, height: r.height },
            scaleSource: r.vector.scaleSource,
            unitLabel: "PDF points",
            layers: info.layers.map((l, k) => ({ name: l.name, color: l.color, role: info.roles[k], auto: info.roles[k], count: l.count })),
            paths: null,
            texts: null,
            settings: { ...VECTOR_SETTINGS },
            recognizing: false,
            recognized: false,
            warnings: [],
            notes: pdf.ocLayers ? [] : ["This PDF has no layers: its lines are grouped by pen (colour and width)."],
            autoOrigin: true,
          };
          if (r.vector.scale && r.metresPerPixelAtFullSize) {
            plan.drawingScale = r.vector.scale;
            plan.calibration = { metresPerPixel: r.metresPerPixelAtFullSize * r.vector.scale, originPx: [0, r.height], origin: [0, 0], rotationDeg: 0 };
          }
        } catch {
          plan.vector = null;
        }
      }
      // A picture (an image, or a PDF page that is one): read as line work too; photos of a sheet are straightened first.
      if (!plan.vector) {
        plan.vector = pictureVector(plan, r);
        const corners = findSheet(r.gray, r.width, r.height);
        if (corners) await straightenRaster(plan, corners);
      }
      plans.push(plan);
    }
    useConvertStore.setState((s) => ({ plans: [...s.plans, ...plans] }));
    updateSource(sourceId, { status: "ready", step: undefined, progress: undefined });
    for (const plan of plans) {
      if (plan.vector?.kind === "picture") void readPicture(plan.id);
      else if (plan.vector && plan.calibration) void recognizePlan(plan.id);
    }
    if (plans.length === 1) useConvertStore.setState({ editingPlan: plans[0].id });
  } catch (error) {
    updateSource(sourceId, { status: "failed", step: undefined, error: error instanceof Error ? error.message : String(error) });
  }
}

/** A DXF file: each separate plan in its model space becomes a plan (a storey). */
async function addDxfSource(sourceId: string, file: File) {
  updateSource(sourceId, { status: "working", step: "Reading the drawing" });
  try {
    const info = await vectorPlans.openDxf(sourceId, await file.arrayBuffer());
    const unitScale = info.unitScale ?? info.unitGuess?.scale ?? null;
    const scaleSource: PlanVector["scaleSource"] = info.unitScale ? "file" : (info.unitGuess?.basis ?? null);
    const unitLabel = info.unitScale ? info.unitLabel : (info.unitGuess?.label ?? "unitless");
    const regions = info.regions.slice(0, 12);
    const existing = useConvertStore.getState().plans.length;
    const plans = regions.map((region, i) => {
      const view = planView(region, 4000);
      // Keep the drawing's own coordinates when it is a single plan drawn near its origin.
      const span = Math.max(region[2] - region[0], region[3] - region[1]);
      const nearOrigin = regions.length === 1 && 0 >= region[0] - span && 0 <= region[2] + span && 0 >= region[1] - span && 0 <= region[3] + span;
      const originPx = nearOrigin ? toPx(view, 0, 0) : toPx(view, region[0], region[1]);
      const calibration: PlanCalibration | null = unitScale ? { metresPerPixel: unitScale / view.k, originPx, origin: [0, 0], rotationDeg: 0 } : null;
      return newPlan(
        {
          sourceId,
          label: regions.length > 1 ? `${file.name} · plan ${i + 1}` : file.name,
          fileName: file.name,
          page: regions.length > 1 ? i + 1 : null,
          width: view.width,
          height: view.height,
          imageUrl: "",
          gray: new Uint8Array(0),
          lightPaper: true,
          metresPerPixelAtFullSize: null,
          calibration,
          discipline: "architecture",
          vector: {
            drawingId: sourceId,
            kind: "dxf",
            region,
            view,
            scaleSource,
            unitLabel,
            layers: info.layers.map((l, k) => ({ name: l.name, color: l.color, role: info.roles[k], auto: info.roles[k], count: l.count })),
            paths: null,
            texts: null,
            settings: { ...VECTOR_SETTINGS },
            recognizing: false,
            recognized: false,
            warnings: [],
            notes: info.notes,
            autoOrigin: !nearOrigin,
          },
        },
        existing + i,
      );
    });
    useConvertStore.setState((s) => ({ plans: [...s.plans, ...plans] }));
    const note = `DXF ${info.version}${info.binary ? " (binary)" : ""} · ${unitScale ? unitLabel : "units unknown"}${regions.length > 1 ? ` · ${regions.length} plans` : ""}`;
    updateSource(sourceId, { status: "ready", step: undefined, progress: undefined, note });
    if (!useConvertStore.getState().sources.some((x) => x.kind === "rvt" || x.kind === "nwd" || x.kind === "extract")) nameProjectFrom(file.name);
    for (const plan of plans) {
      void loadPlanPaths(plan.id);
      if (plan.calibration) void recognizePlan(plan.id);
    }
    if (plans.length === 1) useConvertStore.setState({ editingPlan: plans[0].id });
  } catch (error) {
    updateSource(sourceId, { status: "failed", step: undefined, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Line work of a DXF plan for the editor, and a small picture of it for the plans list. */
async function loadPlanPaths(id: string) {
  const plan = useConvertStore.getState().plans.find((p) => p.id === id);
  if (!plan?.vector || plan.vector.kind !== "dxf") return;
  const v = plan.vector;
  try {
    const { paths, texts } = await vectorPlans.paths(v.drawingId, v.region, v.view);
    const imageUrl = plan.imageUrl || thumbnail(paths, v, plan.width, plan.height);
    updatePlan(id, (p) => ({ imageUrl, vector: p.vector ? { ...p.vector, paths, texts } : p.vector }));
  } catch (error) {
    updatePlan(id, (p) => ({ vector: p.vector ? { ...p.vector, error: error instanceof Error ? error.message : String(error) } : p.vector }));
  }
}

function thumbnail(paths: LayerPaths[], v: PlanVector, width: number, height: number): string {
  const shown = new Set<LayerRole>(["wall", "door", "window", "column", "room", "other"]);
  const stroke = Math.max(width, height) / 400;
  const parts = paths
    .filter((p) => shown.has(v.layers[p.layer]?.role ?? "other"))
    .map((p) => {
      const color = paperColor(v.layers[p.layer]?.color ?? "#000000");
      return `${p.fill ? `<path d="${p.fill}" fill="${color}" fill-opacity="0.35"/>` : ""}${p.d ? `<path d="${p.d}" fill="none" stroke="${color}" stroke-width="${stroke}"/>` : ""}`;
    });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/>${parts.join("")}</svg>`;
  return URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
}

/** Reads walls, doors, windows, rooms and columns from a plan's line work (replaces them, edits included). */
export async function recognizePlan(id: string) {
  const plan = useConvertStore.getState().plans.find((p) => p.id === id);
  if (!plan?.vector) return;
  const cal = plan.calibration;
  if (!cal || !(cal.metresPerPixel > 0)) {
    updatePlan(id, (p) => ({ vector: p.vector ? { ...p.vector, error: "Set the scale first." } : p.vector }));
    return;
  }
  const v = plan.vector;
  updatePlan(id, (p) => ({ vector: p.vector ? { ...p.vector, recognizing: true, error: undefined } : p.vector }));
  try {
    const r = await vectorPlans.recognize(
      v.drawingId,
      v.region,
      v.view,
      v.layers.map((l) => l.role),
      cal.metresPerPixel * v.view.k,
      v.settings,
    );
    updatePlan(id, (p) => {
      const patch: Partial<PlanItem> = {
        walls: r.walls,
        outline: r.outline,
        openings: r.openings,
        rooms: typeRoomsByName(r.rooms),
        columns: r.columns,
        traced: true,
        vector: p.vector ? { ...p.vector, recognizing: false, recognized: true, warnings: r.warnings } : p.vector,
      };
      // Until the user picks an origin, it sits at the floor's lower-left corner (floors of one drawing then stack).
      if (p.vector?.autoOrigin && p.calibration && r.outline.length) {
        const xs = r.outline.map((q) => q[0]),
          ys = r.outline.map((q) => q[1]);
        patch.calibration = { ...p.calibration, originPx: [Math.min(...xs), Math.max(...ys)] };
      }
      return patch;
    });
  } catch (error) {
    updatePlan(id, (p) => ({ vector: p.vector ? { ...p.vector, recognizing: false, error: error instanceof Error ? error.message : String(error) } : p.vector }));
  }
}

/** Changes a layer's role on every plan from the same drawing, and reads them again. */
export function setLayerRole(id: string, layer: number, role: LayerRole) {
  const plan = useConvertStore.getState().plans.find((p) => p.id === id);
  if (!plan?.vector) return;
  const drawingId = plan.vector.drawingId;
  const affected = useConvertStore.getState().plans.filter((p) => p.vector?.drawingId === drawingId);
  for (const p of affected) updatePlan(p.id, (q) => ({ vector: q.vector ? { ...q.vector, layers: q.vector.layers.map((l, i) => (i === layer ? { ...l, role } : l)) } : q.vector }));
  for (const p of affected) void recognizePlan(p.id);
}

/** Rooms from the plan's current walls and columns (after editing them, or for a traced picture). */
export async function findPlanRooms(id: string) {
  const plan = useConvertStore.getState().plans.find((p) => p.id === id);
  const cal = plan?.calibration;
  if (!plan || !cal || !(cal.metresPerPixel > 0) || plan.walls.length === 0) return;
  updatePlan(id, { findingRooms: true });
  try {
    const v = plan.vector;
    const r = await vectorPlans.rooms(plan.walls, plan.columns, cal.metresPerPixel, v ? { id: v.drawingId, region: v.region, view: v.view, roles: v.layers.map((l) => l.role) } : undefined);
    updatePlan(id, (p) => ({ rooms: typeRoomsByName(r.rooms), outline: p.outline.length >= 3 ? p.outline : r.outline, findingRooms: false }));
    if (r.rooms.length === 0) pushToast("info", "No closed rooms found: check that the walls meet.");
  } catch (error) {
    updatePlan(id, { findingRooms: false });
    pushToast("error", error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Pictures of plans (scans, photos): read as line work, with their text

function pictureVector(plan: PlanItem, r: Pick<PlanRaster, "width" | "height" | "lightPaper" | "sizeLabel">): PlanVector {
  return {
    drawingId: `${plan.id}#picture`,
    kind: "picture",
    region: [0, 0, r.width, r.height],
    view: { x0: 0, y1: r.height, k: 1, width: r.width, height: r.height },
    scaleSource: null,
    unitLabel: "pixels",
    layers: [],
    paths: null,
    texts: null,
    settings: { ...VECTOR_SETTINGS },
    recognizing: false,
    recognized: false,
    warnings: [],
    notes: [],
    autoOrigin: true,
    picture: { threshold: null, solidWidth: null, darkInk: r.lightPaper, step: "Waiting", stats: null, textBoxes: 0, texts: 0, scaleDetail: null, sizeLabel: r.sizeLabel ?? null, corners: null, original: null },
  };
}

function setPicture(id: string, patch: Partial<PlanPicture>) {
  updatePlan(id, (p) => (p.vector?.picture ? { vector: { ...p.vector, picture: { ...p.vector.picture, ...patch } } } : {}));
}

/** An image's pixels (from its object URL). */
async function imagePixels(url: string): Promise<ImageData> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Straightens a plan's picture in place (corners in the original picture's pixels); the original is kept. */
async function straightenRaster(plan: PlanItem, corners: [number, number][]) {
  const original = plan.vector?.picture?.original ?? { imageUrl: plan.imageUrl, gray: plan.gray, width: plan.width, height: plan.height, lightPaper: plan.lightPaper, corners };
  const src = await imagePixels(original.imageUrl);
  const size = straightenedSize(corners, original.width, original.height);
  const rgba = warpQuad(src.data, src.width, src.height, corners, size.width, size.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext("2d")!.putImageData(new ImageData(rgba, size.width, size.height), 0, 0);
  const gray = new Uint8Array(size.width * size.height);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) {
    const v = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
    gray[i] = v;
    sum += v;
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  const imageUrl = blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/png");
  if (plan.imageUrl !== original.imageUrl && plan.imageUrl) URL.revokeObjectURL(plan.imageUrl);
  plan.width = size.width;
  plan.height = size.height;
  plan.gray = gray;
  plan.imageUrl = imageUrl;
  plan.lightPaper = sum / gray.length > 127;
  // The size on paper is no longer known.
  plan.metresPerPixelAtFullSize = null;
  plan.calibration = null;
  if (plan.vector) {
    plan.vector = {
      ...plan.vector,
      region: [0, 0, size.width, size.height],
      view: { x0: 0, y1: size.height, k: 1, width: size.width, height: size.height },
      scaleSource: null,
      picture: plan.vector.picture ? { ...plan.vector.picture, original: { ...original, corners }, corners: null, sizeLabel: null, scaleDetail: null } : plan.vector.picture,
    };
  }
}

/** Straighten a plan's photo with these corners (in the original picture), or go back to the original (null). */
export async function straightenPicture(id: string, corners: [number, number][] | null) {
  const plan = useConvertStore.getState().plans.find((p) => p.id === id);
  const pic = plan?.vector?.picture;
  if (!plan || !pic) return;
  const next: PlanItem = { ...plan, vector: plan.vector ? { ...plan.vector } : null };
  if (corners) await straightenRaster(next, corners);
  else if (pic.original) {
    if (plan.imageUrl && plan.imageUrl !== pic.original.imageUrl) URL.revokeObjectURL(plan.imageUrl);
    const o = pic.original;
    Object.assign(next, { width: o.width, height: o.height, gray: o.gray, imageUrl: o.imageUrl, lightPaper: o.lightPaper, calibration: null });
    next.vector = { ...next.vector!, region: [0, 0, o.width, o.height], view: { x0: 0, y1: o.height, k: 1, width: o.width, height: o.height }, scaleSource: null, picture: { ...pic, original: null, corners: o.corners, scaleDetail: null } };
  }
  updatePlan(id, { width: next.width, height: next.height, gray: next.gray, imageUrl: next.imageUrl, lightPaper: next.lightPaper, metresPerPixelAtFullSize: next.metresPerPixelAtFullSize, calibration: next.calibration, vector: next.vector, walls: [], openings: [], rooms: [], columns: [], outline: [], traced: false });
  await readPicture(id);
}

/** Reads a picture: its ink as line work, its text, the scale it gives, then walls, doors, windows, rooms and columns. */
export async function readPicture(id: string) {
  const plan = useConvertStore.getState().plans.find((p) => p.id === id);
  const v = plan?.vector;
  const pic = v?.picture;
  if (!plan || !v || !pic) return;
  setPicture(id, { step: "Reading the lines", error: undefined });
  try {
    const info = await vectorPlans.openPicture(v.drawingId, plan.width, plan.height, plan.gray, { darkInk: pic.darkInk, threshold: pic.threshold, solidWidth: pic.solidWidth, region: null });
    updatePlan(id, (p) =>
      p.vector?.picture
        ? {
            vector: {
              ...p.vector,
              layers: info.layers.map((l, k) => ({ name: l.name, color: l.color, role: info.roles[k], auto: info.roles[k], count: l.count })),
              picture: { ...p.vector.picture, stats: info.stats, textBoxes: info.boxes.length, step: info.boxes.length ? "Reading text" : "Reading the plan" },
            },
          }
        : {},
    );
    let texts: { box: number; text: string }[] = [];
    const warnings: string[] = [];
    if (info.boxes.length) {
      try {
        texts = (await readSheets(info.sheets, (step) => setPicture(id, { step }))).map((t) => ({ box: t.box, text: t.text }));
      } catch (error) {
        warnings.push(`The text could not be read (${error instanceof Error ? error.message : String(error)}): rooms are not named and the scale has to be set by hand.`);
      }
    }
    const now = useConvertStore.getState().plans.find((p) => p.id === id);
    const r = await vectorPlans.pictureTexts(v.drawingId, texts, now?.metresPerPixelAtFullSize ?? null, now?.vector?.picture?.sizeLabel ?? null);
    updatePlan(id, (p) => {
      if (!p.vector?.picture) return {};
      const patch: Partial<PlanItem> = {
        vector: {
          ...p.vector,
          layers: r.layers.map((l, k) => ({ name: l.name, color: l.color, role: r.roles[k], auto: r.roles[k], count: l.count })),
          warnings,
          picture: { ...p.vector.picture, texts: r.texts, step: null },
        },
      };
      // The scale the picture gives, unless it was set by hand.
      if (r.scale && !(p.calibration && p.vector.scaleSource === "set")) {
        patch.calibration = { metresPerPixel: r.scale.scale, originPx: p.calibration?.originPx ?? [0, p.height], origin: p.calibration?.origin ?? [0, 0], rotationDeg: p.calibration?.rotationDeg ?? 0 };
        patch.vector = { ...patch.vector!, scaleSource: r.scale.basis, picture: { ...patch.vector!.picture!, scaleDetail: r.scale.detail } };
      }
      return patch;
    });
    const ready = useConvertStore.getState().plans.find((p) => p.id === id);
    if (ready?.calibration && ready.calibration.metresPerPixel > 0) {
      await recognizePlan(id);
      await checkAreas(id);
    }
  } catch (error) {
    setPicture(id, { step: null, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Room areas written in the rooms against the rooms found: a scale from door sizes is corrected by them; any other scale is only checked. */
async function checkAreas(id: string) {
  const plan = useConvertStore.getState().plans.find((p) => p.id === id);
  const v = plan?.vector;
  const cal = plan?.calibration;
  if (!plan || !v || !cal || plan.rooms.length < 2) return;
  const check = await vectorPlans.areaCheck(v.drawingId, plan.rooms.map((r) => r.outline), v.view, cal.metresPerPixel * v.view.k).catch(() => null);
  if (!check) return;
  const off = Math.abs(check.factor - 1);
  if (v.scaleSource === "doors" && off > 0.02) {
    updatePlan(id, (p) => ({
      calibration: p.calibration ? { ...p.calibration, metresPerPixel: p.calibration.metresPerPixel * check.factor } : p.calibration,
      vector: p.vector ? { ...p.vector, scaleSource: "areas", picture: p.vector.picture ? { ...p.vector.picture, scaleDetail: `${check.support} room areas` } : p.vector.picture } : p.vector,
    }));
    await recognizePlan(id);
  } else if (off > 0.05) {
    updatePlan(id, (p) => ({ vector: p.vector ? { ...p.vector, warnings: [...p.vector.warnings, `The room areas written on the plan suggest a scale ${formatPercent(check.factor - 1)} different: check a known length.`] } : p.vector }));
  }
}

const formatPercent = (x: number) => `${x > 0 ? "+" : ""}${Math.round(x * 100)}%`;

/** New picture settings (ink threshold, solid ink, light lines on dark): read the picture again. */
export function setPictureSettings(id: string, patch: Partial<Pick<PlanPicture, "threshold" | "solidWidth" | "darkInk">>) {
  setPicture(id, patch);
  void readPicture(id);
}

/** The room around a point (click-to-outline), from the plan's walls; it replaces a room found there before. */
export async function outlineRoomAt(id: string, at: [number, number]) {
  const plan = useConvertStore.getState().plans.find((p) => p.id === id);
  const cal = plan?.calibration;
  if (!plan || !cal || !(cal.metresPerPixel > 0) || plan.walls.length === 0) return false;
  const v = plan.vector;
  const room = await vectorPlans.roomAt(plan.walls, plan.columns, cal.metresPerPixel, at, v ? { id: v.drawingId, region: v.region, view: v.view, roles: v.layers.map((l) => l.role) } : undefined).catch(() => null);
  if (!room) {
    pushToast("info", "No closed room there: the walls around it leave a gap wider than a door.");
    return false;
  }
  const inside = (ring: [number, number][]) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if (ring[i][1] > at[1] !== ring[j][1] > at[1] && at[0] < ((ring[j][0] - ring[i][0]) * (at[1] - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]) c = !c;
    return c;
  };
  updatePlan(id, (p) => ({ rooms: [...p.rooms.filter((r) => !inside(r.outline)), ...typeRoomsByName([room])] }));
  return true;
}

/** The older method for pictures: trace walls only (no doors, windows or text). */
export function traceInstead(id: string) {
  const plan = useConvertStore.getState().plans.find((p) => p.id === id);
  if (!plan?.vector || plan.vector.kind !== "picture") return;
  void vectorPlans.release(plan.vector.drawingId).catch(() => undefined);
  updatePlan(id, { vector: null, walls: [], openings: [], rooms: [], columns: [], outline: [], traced: false });
}

/** Back from tracing to reading the picture. */
export function readInstead(id: string) {
  const plan = useConvertStore.getState().plans.find((p) => p.id === id);
  if (!plan || plan.vector || !plan.gray.length) return;
  updatePlan(id, { vector: pictureVector(plan, plan), walls: [], openings: [], rooms: [], columns: [], outline: [], traced: false });
  void readPicture(id);
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
  const P = (p: [number, number]) => pxToProject(cal, p);
  const outline = plan.withSlab && plan.outline.length >= 3 ? plan.outline.map(P) : null;
  // Walls on the outline are external.
  const onOutline = (a: [number, number], b: [number, number], t: number) => {
    if (!outline) return false;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i],
        q = outline[(i + 1) % outline.length];
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const d = Math.abs((mid[0] - p[0]) * (q[1] - p[1]) - (mid[1] - p[1]) * (q[0] - p[0])) / L;
      const s = ((mid[0] - p[0]) * (q[0] - p[0]) + (mid[1] - p[1]) * (q[1] - p[1])) / (L * L);
      if (d < Math.max(1, t) && s > -0.05 && s < 1.05) return true;
    }
    return false;
  };
  const walls = plan.walls.map((w) => {
    const a = P(w.a);
    const b = P(w.b);
    const thickness = Math.round(w.thickness * m * 1000) / 1000;
    return { a, b, thickness, external: onOutline(a, b, thickness) };
  });
  // Door swing directions turn with the plan.
  const dirOf = (p: [number, number], d: [number, number]): [number, number] => {
    const a = P(p),
      b = P([p[0] + d[0] * 100, p[1] + d[1] * 100]);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  };
  const sz = plan.sizes ?? DEFAULT_SIZES;
  const openings = attachOpenings(
    walls,
    (plan.openings ?? []).map((o) => ({
      a: P(o.a),
      b: P(o.b),
      kind: o.kind,
      swing: o.swing ? dirOf(o.a, o.swing) : null,
      operation: o.operation,
      name: o.name,
      sill: o.kind === "window" ? sz.windowSill : 0,
      height: o.kind === "door" ? sz.doorHeight : o.kind === "window" ? sz.windowHeight : sz.openingHeight,
    })),
  );
  return {
    id: plan.id,
    name: plan.label,
    source: plan.label,
    discipline: plan.discipline,
    include: plan.include,
    storey: plan.storey,
    walls,
    slab: outline ? { outline, thickness: plan.slabThickness } : null,
    openings,
    rooms: (plan.rooms ?? []).map((r) => ({ outline: r.outline.map(P), name: r.name, number: r.number, type: r.type ?? null, typeSource: r.typeSource ?? null })),
    roomHeight: plan.roomHeight ?? null,
    columns: (plan.columns ?? []).map((c) => ({ outline: c.outline ? c.outline.map(P) : null, circle: c.circle ? { c: P(c.circle.c), r: Math.round(c.circle.r * m * 1000) / 1000 } : null })),
    basis: plan.vector ? "read" : "traced",
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
      .filter((p) => p.include && p.calibration && p.calibration.metresPerPixel > 0 && (p.walls.length > 0 || (p.withSlab && p.outline.length >= 3) || p.rooms.length > 0 || p.columns.length > 0))
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
