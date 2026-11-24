// Main-thread side of the Fragments packing worker: combining several loaded
// models into one .frag.

import { JobCancelled } from "@/lib/ifc/client";
import { readyGate } from "@/lib/utils/worker-ready";
import type { MergedSource } from "./merge-fragments.mjs";
import type { PackRequest, PackResponse } from "./protocol";

/** A loaded model as the packer needs it: a name, and a way to get its uncompressed data. */
export interface PackableModel {
  name: string;
  /** Returns a fresh copy of the model's uncompressed Fragments data. */
  raw(): Promise<ArrayBuffer>;
}

export interface PackProgress {
  phase: "measuring" | "merging" | "compressing";
  /** 0..1 over the whole job. */
  progress: number;
  detail?: string;
}

export interface CombinedFragments {
  blob: Blob;
  rawBytes: number;
  items: number;
  elements: number;
  models: MergedSource[];
}

/** Talks to one worker: every request gets exactly one final answer; progress messages come in between. */
class PackWorker {
  private readonly worker = new Worker(new URL("./pack.worker.ts", import.meta.url), { type: "module" });
  private readonly gate = readyGate(this.worker, "pack");
  private settle: { resolve: (message: PackResponse) => void; reject: (error: Error) => void } | null = null;
  onProgress: ((done: number, total: number) => void) | null = null;

  constructor(signal?: AbortSignal) {
    this.worker.onmessage = (event: MessageEvent<PackResponse>) => {
      if (this.gate.handle(event.data)) return;
      const message = event.data;
      if (message.type === "progress") {
        this.onProgress?.(message.done, message.total);
        return;
      }
      const pending = this.settle;
      this.settle = null;
      if (message.type === "error") pending?.reject(new Error(message.message));
      else pending?.resolve(message);
    };
    this.worker.onerror = (event) => {
      const pending = this.settle;
      this.settle = null;
      pending?.reject(new Error(event.message || "The packing worker stopped unexpectedly (most likely out of memory)."));
    };
    signal?.addEventListener("abort", () => {
      this.worker.terminate();
      const pending = this.settle;
      this.settle = null;
      pending?.reject(new JobCancelled());
    });
  }

  request(message: PackRequest, transfer: Transferable[] = []): Promise<PackResponse> {
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
      this.gate.post(message, transfer);
    });
  }

  close() {
    this.worker.terminate();
  }
}

/**
 * Joins the models into one Fragments model, in the order given, and
 * compresses it. The first model's coordinate system becomes that of the
 * result. Throws `JobCancelled` when `signal` aborts.
 */
export async function combineFragments(
  models: PackableModel[],
  name: string,
  onProgress: (progress: PackProgress) => void,
  signal?: AbortSignal,
): Promise<CombinedFragments> {
  if (signal?.aborted) throw new JobCancelled();
  const stopped = () => {
    if (signal?.aborted) throw new JobCancelled();
  };

  // The combined model is built in one block of memory that has to be sized
  // before anything is written, so the models are measured first.
  let totalBytes = 0;
  for (let i = 0; i < models.length; i++) {
    onProgress({ phase: "measuring", progress: (i / models.length) * 0.1, detail: models[i].name });
    totalBytes += (await models[i].raw()).byteLength;
    stopped();
  }

  const worker = new PackWorker(signal);
  try {
    await worker.request({ type: "start", totalBytes });
    let done = 0;
    for (const model of models) {
      onProgress({ phase: "merging", progress: 0.1 + (done / totalBytes) * 0.3, detail: model.name });
      const buffer = await model.raw();
      stopped();
      done += buffer.byteLength;
      await worker.request({ type: "add", name: model.name, buffer }, [buffer]);
    }
    worker.onProgress = (packed, total) => onProgress({ phase: "compressing", progress: 0.4 + (packed / total) * 0.6 });
    const result = await worker.request({ type: "finish", name, id: crypto.randomUUID() });
    if (result.type !== "combined") throw new Error("Unexpected answer from the packing worker.");
    return { blob: result.blob, rawBytes: result.rawBytes, items: result.items, elements: result.elements, models: result.models };
  } finally {
    worker.close();
  }
}
