// Message protocol shared by the IFC worker and its main-thread client.

export interface ConvertOptions {
  /** Absolute URL of the folder that serves the web-ifc .wasm files. */
  wasmPath: string;
  /** Skip items further than this from the origin (metres). null keeps everything. */
  distanceThreshold?: number | null;
}

export type IfcWorkerRequest =
  | { type: "convert"; file: Blob; options: ConvertOptions }
  | {
      type: "extract";
      file: Blob;
      elementIds: number[];
      /** Upper-case IFC classes accepted as extractable elements. */
      elementTypes: string[];
    };

export type ConvertPhase = "reading" | "geometry" | "properties" | "relations" | "packing";

export interface ConvertStats {
  /** Size of the source IFC in bytes. */
  sourceBytes: number;
  /** Size of the produced Fragments binary in bytes. */
  fragmentBytes: number;
  /** Wall-clock conversion time in milliseconds. */
  elapsedMs: number;
  /** Pieces of geometry the importer could not turn into surfaces and left out. */
  leftOutGeometry: number;
}

export type IfcWorkerResponse =
  | { type: "progress"; phase: ConvertPhase | "extract"; progress: number; detail?: string }
  | { type: "converted"; bytes: Uint8Array; stats: ConvertStats }
  | { type: "extracted"; blob: Blob; written: number; warnings: string[] }
  | { type: "error"; message: string };

// --- ifcZIP ------------------------------------------------------------------

/** Request to the unzip worker: unpack one Deflate-compressed entry of an archive. */
export interface InflateRequest {
  /** The compressed bytes of the entry: a slice of the archive, so nothing is copied to get here. */
  data: Blob;
  /** Size the archive records for the unpacked data. */
  size: number;
  /** CRC-32 the archive records for the unpacked data. */
  crc32: number;
}

export type InflateResponse =
  | { type: "progress"; /** Unpacked bytes so far. */ bytes: number }
  | { type: "inflated"; blob: Blob }
  | { type: "error"; message: string };
