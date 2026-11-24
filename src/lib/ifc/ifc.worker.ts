/// <reference lib="webworker" />
//
// Heavy IFC work, kept off the main thread:
//   - "convert": IFC -> That Open Fragments with FRAGS.IfcImporter. The file is
//     never loaded into JS memory as a whole: web-ifc pulls it through a
//     synchronous read callback backed by FileReaderSync, 64 MB at a time.
//   - "extract": write a new, valid IFC containing only the requested
//     elements (plus everything they depend on) with FRAGS.IfcSplitter.
//
// One worker instance serves exactly one job and is then terminated by the
// client, which is what gives the WebAssembly heap back to the browser.

import * as FRAGS from "@thatopen/fragments";
import { announceReady } from "@/lib/utils/worker-ready";
import { extendImporter } from "./importer-config";
import type { ConvertOptions, ConvertPhase, IfcWorkerRequest, IfcWorkerResponse } from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: IfcWorkerResponse, transfer: Transferable[] = []) {
  ctx.postMessage(message, transfer);
}

async function convert(file: Blob, options: ConvertOptions) {
  const started = performance.now();
  const importer = new FRAGS.IfcImporter();
  importer.wasm = { path: options.wasmPath, absolute: true };
  // One parse for geometry and properties: half the read passes and no second
  // parsed copy of the file in memory.
  importer.parseOnce = true;
  if (options.distanceThreshold !== undefined) importer.distanceThreshold = options.distanceThreshold;
  extendImporter(importer);

  const size = file.size;
  const reader = new FileReaderSync();
  let furthest = 0;
  let lastReported = -1;
  let phase: ConvertPhase = "reading";

  const readCallback = (offset: number, length: number): Uint8Array => {
    const end = Math.min(offset + length, size);
    if (offset >= end) return new Uint8Array(0);
    const chunk = new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, end)));
    // web-ifc may re-read earlier parts of very large files once its in-memory
    // tape is full, so only forward progress is reported.
    if (phase === "reading" && end > furthest) {
      furthest = end;
      const progress = size > 0 ? furthest / size : 1;
      const percent = Math.floor(progress * 100);
      if (percent !== lastReported) {
        lastReported = percent;
        post({ type: "progress", phase: "reading", progress });
      }
    }
    return chunk;
  };

  post({ type: "progress", phase: "reading", progress: 0 });

  const phaseOf: Record<FRAGS.ProgressData["process"], ConvertPhase> = {
    geometries: "geometry",
    attributes: "properties",
    relations: "relations",
    conversion: "packing",
  };
  let lastPercent = -1;
  let lastPhase: ConvertPhase | null = null;

  // The importer logs a line for every piece of geometry it cannot turn into a surface
  // ("Fragments: Problematic geometry: <id>") and leaves that piece out. Thousands of such lines
  // help nobody: they are counted, and the count goes with the model.
  const log = console.log;
  let leftOutGeometry = 0;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("Fragments: Problematic geometry")) leftOutGeometry++;
    else log(...args);
  };

  const bytes = await importer.process({
    readFromCallback: true,
    readCallback,
    raw: false,
    progressCallback: (progress, data) => {
      // The importer reports one global 0..1 value; the first event after the
      // file has been tokenised marks the end of the reading phase.
      if (data.process === "conversion" && data.state === "start") return;
      phase = phaseOf[data.process];
      const percent = Math.floor(progress * 100);
      if (percent === lastPercent && phase === lastPhase) return;
      lastPercent = percent;
      lastPhase = phase;
      post({
        type: "progress",
        phase,
        progress,
        detail: data.class ? prettyClass(data.class) : undefined,
      });
    },
  });

  post(
    {
      type: "converted",
      bytes,
      stats: { sourceBytes: size, fragmentBytes: bytes.byteLength, elapsedMs: performance.now() - started, leftOutGeometry },
    },
    [bytes.buffer as ArrayBuffer],
  );
}

function prettyClass(name: string) {
  return name.startsWith("IFC") ? `Ifc${name.slice(3).toLowerCase()}` : name;
}

async function extract(file: Blob, elementIds: number[], elementTypes: string[]) {
  const parts: string[] = [];
  let pending = "";
  const io: FRAGS.IfcSplitterIO = {
    readableStream: async () =>
      (file.stream() as ReadableStream<Uint8Array>).pipeThrough(
        new FRAGS.IfcDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>,
      ),
    writableStream: async () =>
      new WritableStream<string>({
        write(chunk) {
          // Batch the thousands of small line writes into ~1 MB string parts.
          pending += chunk;
          if (pending.length > 1 << 20) {
            parts.push(pending);
            pending = "";
          }
        },
        close() {
          if (pending) parts.push(pending);
          pending = "";
        },
      }),
  };

  const types = new Set<string>([...FRAGS.ELEMENT_TYPES, ...elementTypes.map((t) => t.toUpperCase())]);
  for (const spatial of FRAGS.SPATIAL_TYPES) types.delete(spatial);
  const splitter = new FRAGS.IfcSplitter(io, { elementTypes: [...types] });

  const stages: FRAGS.IfcSplitterStage[] = [
    "parse", "spatial", "void-fill", "style-maps", "classify", "aggregate", "cluster", "relations", "resolve", "write",
  ];
  post({ type: "progress", phase: "extract", progress: 0, detail: "parse" });
  splitter.onProgress.add((event) => {
    const index = stages.indexOf(event.stage);
    const next = stages[index + 1];
    post({ type: "progress", phase: "extract", progress: (index + 1) / stages.length, detail: next ?? event.stage });
  });
  const warnings: string[] = [];
  splitter.onExtractWarning.add((event) => {
    if (warnings.length < 50) warnings.push(event.message);
  });

  const written = await splitter.extract("input.ifc", elementIds, "output.ifc");
  if (pending) parts.push(pending);
  const blob = new Blob(parts, { type: "application/x-step" });
  post({ type: "extracted", blob, written: written.size, warnings });
}

ctx.onmessage = async (event: MessageEvent<IfcWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "convert") await convert(request.file, request.options);
    else if (request.type === "extract") await extract(request.file, request.elementIds, request.elementTypes);
  } catch (error) {
    post({ type: "error", message: describeError(error) });
  }
};

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/out of memory|Cannot enlarge memory|memory access out of bounds|Array buffer allocation failed/i.test(text)) {
    return (
      "The browser ran out of WebAssembly memory while converting this model. " +
      "Close other tabs and retry, or convert it once with `npm run convert -- <file.ifc>` and open the resulting .frag."
    );
  }
  return text || "Unknown error";
}

announceReady("ifc");
