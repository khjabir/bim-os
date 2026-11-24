// Main-thread side of the plan tracing worker.

import { readyGate, type ReadyGate } from "@/lib/utils/worker-ready";
import type { TraceOptions, TraceResult } from "./trace";

let worker: Worker | null = null;
let gate: ReadyGate | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: TraceResult) => void; reject: (e: Error) => void }>();

function getWorker(): ReadyGate {
  if (worker && gate) return gate;
  worker = new Worker(new URL("./trace.worker.ts", import.meta.url), { type: "module" });
  const own = (gate = readyGate(worker, "trace"));
  worker.onmessage = (event: MessageEvent<{ id: number; result?: TraceResult; error?: string }>) => {
    if (own.handle(event.data)) return;
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.result) entry.resolve(event.data.result);
    else entry.reject(new Error(event.data.error ?? "Tracing failed."));
  };
  worker.onerror = (event) => {
    for (const entry of pending.values()) entry.reject(new Error(event.message || "The tracing worker stopped."));
    pending.clear();
    worker?.terminate();
    worker = null;
    gate = null;
  };
  return own;
}

/** Traces walls on a grayscale raster (the array is copied, the caller keeps its own). */
export function traceInWorker(width: number, height: number, gray: Uint8Array, options: TraceOptions): Promise<TraceResult> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().post({ id, width, height, gray: gray.slice(), options });
  });
}
