// Messages between the main thread and the model scanning worker.

/** One model to look into. */
export interface ScanJob {
  key: string;
  kind: "ifc" | "frag";
  /** The file, or the slice of an archive that holds it. */
  data: Blob;
  /** True when `data` is Deflate-compressed (a file packed inside a ZIP archive). */
  deflated: boolean;
}

/** What a scan found. */
export interface ModelScan {
  /** IFC schema, upper-case; "" when unknown. */
  schema: string;
  elements: number;
  /** What the model says it is: the description or long name of its IfcProject. */
  description: string;
  /** GlobalId of every element. */
  guids: string[];
}

export type ScanResponse =
  | { type: "progress"; key: string; bytes: number }
  | { type: "scanned"; key: string; scan: ModelScan }
  | { type: "failed"; key: string; message: string }
  | { type: "done" };
