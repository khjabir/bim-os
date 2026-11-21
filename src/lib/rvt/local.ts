// Main-thread side of the in-browser Revit reader (public/rvt/rvt.worker.js).

export interface RvtLocalOptions {
  /** Raise the reader's stream and memory limits for very large projects. */
  largeModel?: boolean;
  /** Draw doors, windows and boxed elements from the meshes Revit saved (default true). */
  savedMeshes?: boolean;
  /** Export this project phase (name or ElementId) instead of the last one. */
  phase?: string | number | null;
}

export interface RvtSkippedItem {
  reason: string;
  count: number;
  classes: Record<string, number>;
  samples: string[];
  phase: string | null;
}

/** What the reader recovered, as reported by rvt-rs itself. */
export interface RvtReport {
  release: number | null;
  build: string | null;
  projectName: string | null;
  /** rvt-rs's own rating for this Revit release: verified, partial, experimental or unsupported. */
  releaseSupport: string | null;
  confidence: { level: string | null; hasGeometry: boolean; hasTypedElements: boolean };
  elements: number;
  withGeometry: number;
  carriedByParts: number;
  /** Elements drawn only as their bounding box: placed and sized, but not their real shape. */
  boundingBoxBodies: number;
  byIfcType: Record<string, number>;
  bodySources: Record<string, number>;
  storeys: string[];
  materials: number;
  decodedRecords: number;
  skipped: RvtSkippedItem[];
  unsupported: string[];
  warnings: string[];
  coverage: { status: string | null; exported: number | null; geometry: number | null } | null;
}

export interface RvtPhase {
  id: number;
  name?: string | null;
}

export interface RvtMetadata {
  revit_version?: number | null;
  build?: string | null;
  title?: string | null;
  last_saved?: string | null;
  worksharing?: string | null;
  workshared?: boolean | null;
}

export interface RvtLocalResult {
  ifc: Blob;
  report: RvtReport;
  phases: RvtPhase[];
  metadata: RvtMetadata | null;
  stats: { openMs: number; stepMs: number; totalMs: number; wasmMemoryBytes: number; ifcBytes: number };
}

export class RvtCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "RvtCancelled";
  }
}

export class RvtReadError extends Error {
  constructor(
    message: string,
    readonly outOfMemory: boolean,
    readonly metadata: RvtMetadata | null,
  ) {
    super(message);
    this.name = "RvtReadError";
  }
}

type WorkerMessage =
  | { type: "progress"; label: string; fraction?: number }
  | { type: "metadata"; metadata: RvtMetadata }
  | { type: "done"; ifc: Blob; report: RvtReport; phases: RvtPhase[]; stats: RvtLocalResult["stats"] }
  | { type: "error"; message: string; outOfMemory: boolean };

/** Reads a Revit file with rvt-rs and returns it as an IFC4 file plus the reader's own report. */
export function convertRvtLocal(
  file: Blob,
  name: string,
  options: RvtLocalOptions,
  onProgress: (label: string, fraction?: number) => void,
  signal?: AbortSignal,
): Promise<RvtLocalResult> {
  return new Promise<RvtLocalResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RvtCancelled());
      return;
    }
    // A static module worker: see the note at the top of public/rvt/rvt.worker.js.
    const worker = new Worker("/rvt/rvt.worker.js", { type: "module" });
    let metadata: RvtMetadata | null = null;
    const finish = (settle: () => void) => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      settle();
    };
    const onAbort = () => finish(() => reject(new RvtCancelled()));
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "progress":
          onProgress(message.label, message.fraction);
          break;
        case "metadata":
          metadata = message.metadata;
          break;
        case "done":
          finish(() => resolve({ ifc: message.ifc, report: message.report, phases: message.phases, metadata, stats: message.stats }));
          break;
        case "error":
          finish(() => reject(new RvtReadError(message.message, message.outOfMemory, metadata)));
          break;
      }
    };
    worker.onerror = (event) => {
      finish(() => reject(new RvtReadError(event.message || "The Revit reader could not start. Check that public/rvt/ holds rvt.js and rvt_bg.wasm.", false, metadata)));
    };
    worker.postMessage({ type: "convert", file, name, options });
  });
}
