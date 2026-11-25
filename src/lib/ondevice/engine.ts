// The on-device assistant, page side: whether it is on and which model it
// uses (remembered on this device), what the browser supports, loading the
// model (downloaded once, then from the browser's cache), and answering a
// task with JSON. Open models run in a worker (webllm.worker.ts); Chrome's
// built-in model runs through the browser's LanguageModel API. Answers are
// constrained to the task's JSON Schema, so they always parse.

import { create } from "zustand";
import { readyGate, type ReadyGate } from "@/lib/utils/worker-ready";
import { ASSISTANT_MODELS, assistantModel, DEFAULT_MODEL, type AssistantModel } from "./models";
import type { JsonTask } from "./types";
import type { JsonReply, WorkerReply, WorkerRequest } from "./workerTypes";

export type AssistantStatus = "off" | "idle" | "loading" | "ready" | "busy" | "error";

export type ChromeAvailability = "available" | "downloadable" | "downloading" | "unavailable";

export interface AssistantSupport {
  webgpu: boolean;
  /** 16-bit shader maths (smaller, faster model builds). */
  f16: boolean;
  /** Chrome's built-in model, or null when this browser has no such API. */
  chrome: ChromeAvailability | null;
  /** Why WebGPU is not there. */
  reason: string | null;
}

export interface AssistantState {
  enabled: boolean;
  modelId: string;
  status: AssistantStatus;
  /** 0..1 while loading. */
  progress: number | null;
  /** What is happening, in words. */
  detail: string | null;
  error: string | null;
  support: AssistantSupport | null;
  /** Our model ids whose files are in this browser. */
  downloaded: Record<string, boolean>;
  /** The model that is loaded (our id). */
  loaded: string | null;
  /** How long the last answer took (seconds). */
  lastSeconds: number | null;
}

const PREFS_KEY = "ifc-studio:ondevice-assistant";

function readPrefs(): { enabled: boolean; modelId: string } {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(PREFS_KEY) : null;
    const p = raw ? (JSON.parse(raw) as { enabled?: unknown; modelId?: unknown }) : {};
    const modelId = typeof p.modelId === "string" && ASSISTANT_MODELS.some((m) => m.id === p.modelId) ? p.modelId : DEFAULT_MODEL;
    return { enabled: p.enabled === true, modelId };
  } catch {
    return { enabled: false, modelId: DEFAULT_MODEL };
  }
}

function writePrefs(enabled: boolean, modelId: string) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ enabled, modelId }));
  } catch {
    // Private windows and blocked storage: the choice lasts until the page closes.
  }
}

// The page renders first with the defaults (as the server does), then takes the device's choice.
export const useAssistant = create<AssistantState>(() => ({
  enabled: false,
  modelId: DEFAULT_MODEL,
  status: "off",
  progress: null,
  detail: null,
  error: null,
  support: null,
  downloaded: {},
  loaded: null,
  lastSeconds: null,
}));

const set = (patch: Partial<AssistantState>) => useAssistant.setState(patch);
const get = () => useAssistant.getState();

let prefsLoaded = false;

/** Takes the choice remembered on this device (once, after the page has rendered). */
export function loadAssistantPrefs() {
  if (prefsLoaded) return;
  prefsLoaded = true;
  const prefs = readPrefs();
  set({ enabled: prefs.enabled, modelId: prefs.modelId, status: prefs.enabled ? (get().loaded ? "ready" : "idle") : "off" });
}

/** Turns the assistant on or off (off unloads the model; its files stay in the browser). */
export function setAssistantEnabled(enabled: boolean) {
  loadAssistantPrefs();
  writePrefs(enabled, get().modelId);
  if (!enabled) void unloadAssistant();
  set({ enabled, status: enabled ? (get().loaded ? "ready" : "idle") : "off", error: null, detail: null });
  if (enabled) {
    void checkSupport();
    if (assistantModel(get().modelId).engine === "webllm") void refreshDownloaded();
  }
}

export function setAssistantModel(modelId: string) {
  loadAssistantPrefs();
  if (modelId === get().modelId) return;
  writePrefs(get().enabled, modelId);
  void unloadAssistant();
  set({ modelId, status: get().enabled ? "idle" : "off", error: null, detail: null });
}

// ---------------------------------------------------------------------------
// What this browser can do

let supportCheck: Promise<AssistantSupport> | null = null;

type Gpu = { requestAdapter(): Promise<{ features: { has(f: string): boolean } } | null> };
type LanguageModelApi = {
  availability(options?: unknown): Promise<ChromeAvailability>;
  create(options?: unknown): Promise<{ prompt(input: string, options?: unknown): Promise<string>; destroy(): void }>;
};

const LANG = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };

function languageModel(): LanguageModelApi | null {
  const lm = (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel;
  return lm && typeof lm.availability === "function" ? lm : null;
}

export function checkSupport(): Promise<AssistantSupport> {
  if (!supportCheck) {
    supportCheck = (async () => {
      const stand = testEngine()?.support;
      if (stand) {
        set({ support: stand });
        return stand;
      }
      let webgpu = false;
      let f16 = false;
      let reason: string | null = null;
      const gpu = (globalThis.navigator as { gpu?: Gpu } | undefined)?.gpu;
      if (!gpu) reason = "This browser has no WebGPU (recent Chrome, Edge and Safari have it; Firefox only on some systems).";
      else {
        try {
          const adapter = await gpu.requestAdapter();
          if (adapter) {
            webgpu = true;
            f16 = adapter.features.has("shader-f16");
          } else reason = "WebGPU is there but found no graphics adapter to use.";
        } catch (error) {
          reason = `WebGPU could not start: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      let chrome: ChromeAvailability | null = null;
      const lm = languageModel();
      if (lm) chrome = await lm.availability(LANG).catch(() => "unavailable" as const);
      const support = { webgpu, f16, chrome, reason };
      set({ support });
      return support;
    })();
  }
  return supportCheck;
}

/** Whether the chosen model can run here. */
export function canRun(model: AssistantModel, support: AssistantSupport | null): boolean {
  if (!support) return false;
  return model.engine === "chrome" ? support.chrome !== null && support.chrome !== "unavailable" : support.webgpu;
}

// ---------------------------------------------------------------------------
// The worker (open models)

let worker: Worker | null = null;
let gate: ReadyGate | null = null;
let seq = 1;
const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; progress?: (p: { progress: number; text: string }) => void }>();

function getWorker(): ReadyGate {
  if (worker && gate) return gate;
  worker = new Worker(new URL("./webllm.worker.ts", import.meta.url), { type: "module" });
  const own = (gate = readyGate(worker, "assistant"));
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    if (own.handle(event.data)) return;
    const msg = event.data;
    const entry = pending.get(msg.id);
    if (!entry) return;
    if ("progress" in msg) return entry.progress?.(msg.progress);
    pending.delete(msg.id);
    if ("error" in msg) entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
  };
  worker.onerror = (event) => {
    for (const entry of pending.values()) entry.reject(new Error(event.message || "The assistant stopped (most likely out of memory)."));
    pending.clear();
    worker?.terminate();
    worker = null;
    gate = null;
    set({ loaded: null, status: get().enabled ? "error" : "off", error: event.message || "The assistant stopped (most likely out of memory)." });
  };
  return own;
}

type Body<T> = T extends unknown ? Omit<T, "id"> : never;

/**
 * Tests can stand in for the worker (a page script sets this before the app
 * loads): it then answers every request the worker would. Nothing sets it in
 * normal use.
 */
interface TestEngine {
  call(req: Body<WorkerRequest>, progress?: (p: { progress: number; text: string }) => void): Promise<unknown>;
  support?: AssistantSupport;
}
const testEngine = (): TestEngine | null => (globalThis as { __ondeviceTestEngine?: TestEngine }).__ondeviceTestEngine ?? null;

function call<T>(req: Body<WorkerRequest>, progress?: (p: { progress: number; text: string }) => void): Promise<T> {
  const stand = testEngine();
  if (stand) return stand.call(req, progress) as Promise<T>;
  const g = getWorker();
  const id = seq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject, progress });
    g.post({ ...req, id });
  });
}

/** The WebLLM build of a model for this GPU. */
function webllmId(model: AssistantModel, support: AssistantSupport): string {
  return support.f16 ? model.webllm!.f16 : model.webllm!.f32;
}

/** Which models' files are in this browser. */
export async function refreshDownloaded(): Promise<void> {
  const ids = ASSISTANT_MODELS.flatMap((m) => (m.webllm ? [m.webllm.f16, m.webllm.f32] : []));
  try {
    const found = await call<Record<string, boolean>>({ op: "has", modelIds: ids });
    const downloaded: Record<string, boolean> = {};
    for (const m of ASSISTANT_MODELS) if (m.webllm) downloaded[m.id] = Boolean(found[m.webllm.f16] || found[m.webllm.f32]);
    set({ downloaded });
  } catch {
    // No worker here (old browser): nothing is downloaded.
  }
}

/** Removes a model's files from this browser. */
export async function removeDownloaded(modelId: string): Promise<void> {
  const m = assistantModel(modelId);
  if (!m.webllm) return;
  if (get().loaded === modelId) await unloadAssistant();
  await call({ op: "delete", modelIds: [m.webllm.f16, m.webllm.f32] });
  await refreshDownloaded();
}

// ---------------------------------------------------------------------------
// Loading and answering

let loading: Promise<void> | null = null;

/** Readable progress from WebLLM's messages ("Fetching param cache[12/39]: 412MB fetched. 41% completed…"). */
function progressText(text: string, progress: number, model: AssistantModel): string {
  if (/fetching/i.test(text) && !/cache\[\d+\/\d+\]:\s*0MB/i.test(text)) {
    const mb = /(\d+)\s*MB fetched/i.exec(text)?.[1];
    return mb && model.sizeMB ? `Downloading the model: ${mb} of ${model.sizeMB} MB` : `Downloading the model: ${Math.round(progress * 100)}%`;
  }
  if (/loading model from cache|loading gpu shader|loading/i.test(text)) return `Loading the model: ${Math.round(progress * 100)}%`;
  return "Starting the model";
}

/** Loads the chosen model (downloading it the first time). Chrome's model may need a click to start its download. */
export function loadAssistant(): Promise<void> {
  const s = get();
  const model = assistantModel(s.modelId);
  if (s.loaded === model.id) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      set({ status: "loading", progress: 0, detail: "Starting the model", error: null });
      try {
        const support = await checkSupport();
        if (model.engine === "chrome") {
          const lm = languageModel();
          if (!lm || support.chrome === "unavailable" || support.chrome === null) throw new Error("This browser has no built-in model the assistant can use.");
          if (support.chrome !== "available") {
            // The first session starts Chrome's own download.
            const session = await lm.create({
              ...LANG,
              monitor(m: EventTarget) {
                m.addEventListener("downloadprogress", (e) => {
                  const loaded = (e as unknown as { loaded: number }).loaded;
                  set({ progress: loaded, detail: `Chrome is downloading its model: ${Math.round(loaded * 100)}%` });
                });
              },
            });
            session.destroy();
            set({ support: { ...support, chrome: "available" } });
          }
        } else {
          if (!support.webgpu) throw new Error(support.reason ?? "This browser has no WebGPU.");
          await call({ op: "load", modelId: webllmId(model, support) }, (p) => set({ progress: p.progress, detail: progressText(p.text, p.progress, model) }));
          set({ downloaded: { ...get().downloaded, [model.id]: true } });
        }
        set({ loaded: model.id, status: "ready", progress: null, detail: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ status: "error", progress: null, detail: null, error: friendly(message) });
        throw new Error(friendly(message));
      } finally {
        loading = null;
      }
    })();
  }
  return loading;
}

function friendly(message: string): string {
  if (/NotAllowedError|user activation|gesture/i.test(message)) return "Chrome needs a click to start downloading its model: press Turn on again.";
  if (/QuotaExceeded|quota/i.test(message)) return "There is not enough free storage in this browser for the model.";
  if (/device.*lost|GPUDevice|out of memory|OOM/i.test(message)) return "The graphics card ran out of memory: try the smaller model, or close other tabs.";
  if (/fetch|network|Failed to fetch/i.test(message)) return "The model could not be downloaded: check the connection (it comes from huggingface.co) and try again.";
  return message;
}

export async function unloadAssistant(): Promise<void> {
  if (worker || testEngine()) await call({ op: "unload" }).catch(() => undefined);
  if (get().loaded) set({ loaded: null, status: get().enabled ? "idle" : "off" });
}

let queue: Promise<unknown> = Promise.resolve();
let stopped = false;

/** Stops the answer being written (it is then thrown away). */
export function stopAnswer() {
  stopped = true;
  if (worker || testEngine()) void call({ op: "stop" }).catch(() => undefined);
}

/** JSON that may have been cut short by the length limit: closes it after the last complete item. */
export function parseAnswer(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    for (let end = text.lastIndexOf("}"); end > 0; end = text.lastIndexOf("}", end - 1)) {
      for (const tail of ["]}", "}", "]}}"]) {
        try {
          return JSON.parse(text.slice(0, end + 1) + tail);
        } catch {
          // keep trying shorter
        }
      }
    }
    throw new Error("The assistant's answer could not be read.");
  }
}

/** Asks the assistant (loading it when needed); one task at a time. */
export function askAssistant<T = unknown>(task: JsonTask): Promise<T> {
  const run = async (): Promise<T> => {
    const s = get();
    if (!s.enabled) throw new Error("The assistant is off: turn it on first.");
    await loadAssistant();
    const model = assistantModel(get().modelId);
    stopped = false;
    set({ status: "busy", detail: task.label, error: null });
    const started = performance.now();
    try {
      let text: string;
      if (model.engine === "chrome") {
        const lm = languageModel();
        if (!lm) throw new Error("This browser has no built-in model.");
        const session = await lm.create({
          ...LANG,
          initialPrompts: [{ role: "system", content: task.system }, ...(task.examples ?? []).flatMap((e) => [
            { role: "user", content: e.user },
            { role: "assistant", content: e.answer },
          ])],
        });
        try {
          text = await session.prompt(task.user, { responseConstraint: task.schema });
        } finally {
          session.destroy();
        }
      } else text = (await call<JsonReply>({ op: "json", system: task.system, examples: task.examples ?? [], user: task.user, schema: task.schema, maxTokens: task.maxTokens })).text;
      if (stopped) throw new Error("Stopped.");
      set({ status: "ready", detail: null, lastSeconds: (performance.now() - started) / 1000 });
      return parseAnswer(text) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ status: get().loaded ? "ready" : "error", detail: null, error: message === "Stopped." ? null : friendly(message) });
      throw error;
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

export function sizeText(mb: number | undefined): string {
  if (!mb) return "";
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}
