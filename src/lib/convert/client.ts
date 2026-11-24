// Main-thread side of the conversion worker: promise-based calls with
// progress callbacks, one worker per client.

import type { WorkerRequest } from "./convert.worker";
import type { PreviewData } from "./preview";
import type { AssetOptions, RegisterSummary } from "./assets/register";
import type { WorkbookSettings } from "./assets/workbook";
import type { RegisterWorkspace } from "./assets/workspace";
import type { IfcSourceInfo } from "./ifc-source";
import type { ConvertOptions, ConvertReport, FrameConfig, JobSummary, OutputFile, PartSummary, StoreyDef } from "./types";
import { readyGate, type ReadyGate } from "@/lib/utils/worker-ready";

type Progress = (phase: string, done: number, total: number) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: Progress;
}

type Request = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

export interface WorkerState {
  parts: PartSummary[];
  jobs: JobSummary[];
  added?: string[];
  ignored?: string[];
}

/** The register as a facility workspace, with its summary. */
export interface WorkspaceResult extends RegisterWorkspace {
  summary: RegisterSummary;
}

/** Folder that serves the web-ifc .wasm files. */
function ifcWasmPath() {
  return new URL("/web-ifc/", window.location.origin).href;
}

/**
 * A conversion worker with promise-based calls. The Convert page shares one (`convertWorker`); the
 * onboarding wizard has its own, so the models it reads never end up in a conversion.
 */
export function createConvertClient() {
  let worker: Worker | null = null;
  let gate: ReadyGate | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  function getWorker(): ReadyGate {
    if (worker && gate) return gate;
    worker = new Worker(new URL("./convert.worker.ts", import.meta.url), { type: "module" });
    const own = (gate = readyGate(worker, "convert"));
    worker.onmessage = (event: MessageEvent) => {
      if (own.handle(event.data)) return;
      const message = event.data as { id: number; type: string; result?: unknown; message?: string; phase?: string; done?: number; total?: number };
      const entry = pending.get(message.id);
      if (!entry) return;
      if (message.type === "progress") entry.onProgress?.(message.phase ?? "", message.done ?? 0, message.total ?? 0);
      else {
        pending.delete(message.id);
        if (message.type === "result") entry.resolve(message.result);
        else entry.reject(new Error(message.message ?? "The conversion worker failed."));
      }
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || "The conversion worker stopped (out of memory?).");
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      worker?.terminate();
      worker = null;
      gate = null;
    };
    return own;
  }

  function call<T>(request: Request, onProgress?: Progress): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
      getWorker().post({ ...request, id });
    });
  }

  return {
    addFiles: (files: File[], onProgress?: Progress) => call<WorkerState>({ type: "addFiles", files: files.map((f) => ({ name: f.name, blob: f })) }, onProgress),
    addJobs: (jobs: { name: string; bin: Blob; props: Blob | null; textures?: (Blob | null)[] }[], onProgress?: Progress) => call<WorkerState>({ type: "addJobs", jobs }, onProgress),
    /** IFC files (as files or the IFC inside an archive), read for their assets, rooms and systems. */
    addIfc: (files: { name: string; blob: Blob }[], onProgress?: Progress) => call<WorkerState & { ifc: IfcSourceInfo[] }>({ type: "addIfc", files, wasmPath: ifcWasmPath() }, onProgress),
    remove: (jobs: string[]) => call<WorkerState>({ type: "remove", jobs }),
    clear: () => call<WorkerState>({ type: "clear" }),
    storeys: (partIds: string[]) => call<{ storeys: StoreyDef[] }>({ type: "storeys", partIds }),
    frame: (frame: FrameConfig, partIds: string[]) => call<{ origin: [number, number, number]; rotation: number }>({ type: "frame", options: { frame }, partIds }),
    generate: (options: ConvertOptions, onProgress?: Progress) => call<{ files: OutputFile[]; report: ConvertReport }>({ type: "generate", options }, onProgress),
    cancel: () => call<{ cancelled: boolean }>({ type: "cancel" }),
    preview: (options: ConvertOptions, budget: number, onProgress?: Progress) => call<PreviewData>({ type: "preview", options, budget }, onProgress),
    assets: (options: ConvertOptions, assets: AssetOptions, onProgress?: Progress) => call<RegisterSummary>({ type: "assets", options, assets }, onProgress),
    assetFiles: (options: ConvertOptions, assets: AssetOptions, contact: Pick<WorkbookSettings, "contactEmail" | "contactCompany" | "contactPhone" | "currency">, onProgress?: Progress) =>
      call<{ summary: RegisterSummary; cobie: Blob; workbook: Blob; sld: Blob }>({ type: "assetFiles", options, assets, contact }, onProgress),
    workspace: (options: ConvertOptions, assets: AssetOptions, onProgress?: Progress) => call<WorkspaceResult>({ type: "workspace", options, assets }, onProgress),
    /** Stops the worker and frees what it holds (the next call starts a new one). */
    terminate: () => {
      worker?.terminate();
      worker = null;
      gate = null;
      for (const entry of pending.values()) entry.reject(new Error("Stopped."));
      pending.clear();
    },
  };
}

export type ConvertClient = ReturnType<typeof createConvertClient>;

export const convertWorker = createConvertClient();
