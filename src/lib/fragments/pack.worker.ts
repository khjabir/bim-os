/// <reference lib="webworker" />
//
// Joins several Fragments models into one, off the main thread (the joining
// itself is in merge-fragments.mjs), and compresses the result.
//
// Models arrive uncompressed, one at a time, and are let go as soon as they
// are merged, so the worker holds the combined model plus one input. The
// result is compressed as a stream into Blob parts, never as one more block
// of memory the size of the model.

import { createFragmentsMerger, MergeError, type FragmentsMerger } from "./merge-fragments.mjs";
import { announceReady } from "@/lib/utils/worker-ready";
import type { PackRequest, PackResponse } from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: PackResponse) => ctx.postMessage(message);

const SLICE_BYTES = 4 * 1024 * 1024;
const PART_BYTES = 32 * 1024 * 1024;

/** zlib-compresses `bytes` (the format of a .frag file) into Blob parts. */
async function compress(bytes: Uint8Array, onProgress?: (done: number) => void): Promise<Blob[]> {
  let offset = 0;
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + SLICE_BYTES, bytes.length);
      controller.enqueue(bytes.subarray(offset, end) as Uint8Array<ArrayBuffer>);
      offset = end;
      onProgress?.(offset);
    },
  });
  const reader = source.pipeThrough(new CompressionStream("deflate")).getReader();
  const parts: Blob[] = [];
  let pending: Uint8Array<ArrayBuffer>[] = [];
  let pendingBytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending.push(value);
    pendingBytes += value.byteLength;
    if (pendingBytes >= PART_BYTES) {
      parts.push(new Blob(pending));
      pending = [];
      pendingBytes = 0;
    }
  }
  if (pending.length > 0) parts.push(new Blob(pending));
  return parts;
}

let merger: FragmentsMerger | null = null;

async function handle(request: PackRequest) {
  switch (request.type) {
    case "start":
      merger = createFragmentsMerger({ totalBytes: request.totalBytes });
      post({ type: "added", items: 0, elements: 0 });
      break;
    case "add": {
      if (!merger) throw new Error("Nothing was started.");
      const added = merger.add(new Uint8Array(request.buffer), { name: request.name });
      post({ type: "added", ...added });
      break;
    }
    case "finish": {
      if (!merger) throw new Error("Nothing was started.");
      const result = merger.finish({ name: request.name, id: request.id });
      merger = null;
      const total = result.bytes.length;
      const parts = await compress(result.bytes, (done) => post({ type: "progress", done, total }));
      post({ type: "combined", blob: new Blob(parts, { type: "application/octet-stream" }), rawBytes: total, items: result.items, elements: result.elements, models: result.models });
      break;
    }
  }
}

// Requests are handled strictly one after another, in the order they arrive.
let queue = Promise.resolve();
ctx.onmessage = (event: MessageEvent<PackRequest>) => {
  queue = queue.then(async () => {
    try {
      await handle(event.data);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const outOfMemory = error instanceof RangeError || /allocation|memory/i.test(text);
      post({
        type: "error",
        message:
          error instanceof MergeError
            ? text
            : outOfMemory
              ? "The browser ran out of memory while packing these models. Combine fewer models at a time, or use `npm run convert -- <folder> --combined <file.frag>` on the command line."
              : text || "Packing failed.",
      });
    }
  });
};

announceReady("pack");
