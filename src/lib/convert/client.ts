// Main-thread side of the conversion worker: one worker for the page,
// promise-based calls with progress callbacks.

import type { WorkerRequest } from "./convert.worker";
import type { PreviewData } from "./preview";
import type { AssetOptions, RegisterSummary } from "./assets/register";
import type { WorkbookSettings } from "./assets/workbook";
import type { ConvertOptions, ConvertReport, FrameConfig, JobSummary, OutputFile, PartSummary, StoreyDef } from "./types";

type Progress = (phase: string, done: number, total: number) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: Progress;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./convert.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent) => {
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
  };
  return worker;
}

type Request = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

function call<T>(request: Request, onProgress?: Progress): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
    getWorker().postMessage({ ...request, id });
  });
}

export interface WorkerState {
  parts: PartSummary[];
  jobs: JobSummary[];
  added?: string[];
  ignored?: string[];
}

export const convertWorker = {
  addFiles: (files: File[], onProgress?: Progress) => call<WorkerState>({ type: "addFiles", files: files.map((f) => ({ name: f.name, blob: f })) }, onProgress),
  addJobs: (jobs: { name: string; bin: Blob; props: Blob | null; textures?: (Blob | null)[] }[], onProgress?: Progress) => call<WorkerState>({ type: "addJobs", jobs }, onProgress),
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
};
