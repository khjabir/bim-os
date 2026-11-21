// Main-thread side of the IFC worker. Every call spins up a fresh worker and
// terminates it when the job settles, so the WebAssembly heap used for a
// conversion is returned to the browser immediately.

import type { ConvertOptions, ConvertPhase, ConvertStats, IfcWorkerRequest, IfcWorkerResponse } from "./protocol";

export interface JobProgress {
  phase: ConvertPhase | "extract";
  /** 0..1 */
  progress: number;
  detail?: string;
}

export class JobCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "JobCancelled";
  }
}

function runJob<T extends IfcWorkerResponse["type"]>(
  request: IfcWorkerRequest,
  expected: T,
  onProgress?: (progress: JobProgress) => void,
  signal?: AbortSignal,
): Promise<Extract<IfcWorkerResponse, { type: T }>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new JobCancelled());
      return;
    }
    const worker = new Worker(new URL("./ifc.worker.ts", import.meta.url), { type: "module" });
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(new JobCancelled());
    };
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (event: MessageEvent<IfcWorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.({ phase: message.phase, progress: message.progress, detail: message.detail });
      } else if (message.type === "error") {
        finish();
        reject(new Error(message.message));
      } else if (message.type === expected) {
        finish();
        resolve(message as Extract<IfcWorkerResponse, { type: T }>);
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The IFC worker crashed (most likely out of memory)."));
    };
    worker.postMessage(request);
  });
}

export function wasmPath() {
  return new URL("/web-ifc/", window.location.origin).href;
}

/** Converts an IFC file to a Fragments binary without blocking the UI. */
export async function convertIfc(
  file: Blob,
  onProgress?: (progress: JobProgress) => void,
  signal?: AbortSignal,
  options: Partial<ConvertOptions> = {},
): Promise<{ bytes: Uint8Array; stats: ConvertStats }> {
  const result = await runJob(
    { type: "convert", file, options: { wasmPath: wasmPath(), ...options } },
    "converted",
    onProgress,
    signal,
  );
  return { bytes: result.bytes, stats: result.stats };
}

/**
 * Writes a new IFC holding only `elementIds` (IFC express ids) and everything
 * they depend on. `elementTypes` lists the IFC classes that count as elements.
 */
export async function extractIfc(
  file: Blob,
  elementIds: number[],
  elementTypes: string[],
  onProgress?: (progress: JobProgress) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; written: number; warnings: string[] }> {
  const result = await runJob({ type: "extract", file, elementIds, elementTypes }, "extracted", onProgress, signal);
  return { blob: result.blob, written: result.written, warnings: result.warnings };
}
