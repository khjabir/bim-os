/// <reference lib="webworker" />
//
// Looks into the models of a folder before any of them is opened: schema,
// element count, what each model says it is, and the GlobalIds of its
// elements. The main thread compares those ids to find models that repeat
// each other (see plan.mjs).
//
// IFC files are walked once as a stream, about a second per 300 MB, without
// being parsed. A .frag is unpacked and its tables read directly. Nothing is
// converted here.

import { summariseFragments } from "@/lib/fragments/merge-fragments.mjs";
import { createIfcScanner } from "./ifc-scan.mjs";
import type { ModelScan, ScanJob, ScanResponse } from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: ScanResponse) => ctx.postMessage(message);

/** Names that export tools fill in when nobody typed a description. */
const PLACEHOLDERS = new Set(["project name", "project number", "project", "default project", "default", "undefined", "unnamed", "untitled", "ifc project"]);
const meaningful = (text: string) => (PLACEHOLDERS.has(text.trim().toLowerCase()) ? "" : text.trim());

function content(job: ScanJob): ReadableStream<Uint8Array<ArrayBuffer>> {
  return job.deflated ? job.data.stream().pipeThrough(new DecompressionStream("deflate-raw")) : job.data.stream();
}

async function scanIfc(job: ScanJob): Promise<ModelScan> {
  const scanner = createIfcScanner();
  const reader = content(job).getReader();
  let bytes = 0;
  let reported = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    scanner.push(value);
    bytes += value.byteLength;
    if (bytes - reported >= 16 * 1024 * 1024) {
      reported = bytes;
      post({ type: "progress", key: job.key, bytes });
    }
  }
  const result = scanner.finish();
  if (!result.isIfc) throw new Error("This does not look like an IFC file.");
  const description = meaningful(result.project?.description ?? "") || meaningful(result.project?.longName ?? "");
  return { schema: result.schema, elements: result.elements, description, guids: result.guids };
}

async function scanFragments(job: ScanJob): Promise<ModelScan> {
  let bytes = new Uint8Array(await new Response(content(job)).arrayBuffer());
  // A .frag is zlib-compressed unless it was saved raw: the first two bytes tell (as in the Fragments library).
  const zlib = bytes.length >= 2 && (bytes[0] & 15) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0;
  if (zlib) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  const summary = summariseFragments(bytes);
  return { schema: summary.schema.toUpperCase(), elements: summary.elements, description: meaningful(summary.description), guids: summary.guids };
}

ctx.onmessage = async (event: MessageEvent<ScanJob[]>) => {
  for (const job of event.data) {
    try {
      const scan = job.kind === "frag" ? await scanFragments(job) : await scanIfc(job);
      post({ type: "scanned", key: job.key, scan });
    } catch (error) {
      post({ type: "failed", key: job.key, message: error instanceof Error ? error.message : String(error) });
    }
  }
  post({ type: "done" });
};
