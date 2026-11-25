// DWG drawings, read through the optional DWG add-on.
//
// The add-on (addons/dwg, GPL-3.0-or-later) is not part of this app and is not
// bundled with it: `npm run addon:dwg` installs it into public/addons/dwg/,
// which git ignores. This file only checks whether it is there, and talks to
// its worker, loaded from that folder at run time, by messages: a DWG file
// goes in, DXF comes out, and the app reads the DXF with its own reader.

const BASE = "/addons/dwg/";
/** The message format this app speaks with the add-on's worker (addons/dwg/install.mjs writes it into addon.json). */
export const DWG_ADDON_PROTOCOL = 1;

export interface DwgAddon {
  /** What reads the files, e.g. "GNU LibreDWG (libredwg-web 0.9.3)". */
  reader: string;
  protocol: number;
}

let probe: Promise<DwgAddon | null> | null = null;

/** The installed add-on, or null. A miss is not remembered. */
export function dwgAddon(): Promise<DwgAddon | null> {
  // next.config.ts sets this when the add-on was installed as the app was built (or the development server
  // started). Without it there is nothing to ask for, and no failed request is left in the console.
  if (process.env.NEXT_PUBLIC_DWG_ADDON !== "1") return Promise.resolve(null);
  if (probe) return probe;
  const current = fetch(`${BASE}addon.json`, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return null;
      const manifest = (await response.json()) as { addon?: unknown; reader?: unknown; protocol?: unknown };
      if (manifest?.addon !== "dwg") return null;
      return { reader: typeof manifest.reader === "string" ? manifest.reader : "GNU LibreDWG", protocol: Number(manifest.protocol) || 0 };
    })
    .catch(() => null);
  probe = current;
  void current.then((found) => {
    if (!found && probe === current) probe = null;
  });
  return current;
}

export interface DwgRelease {
  /** The six-letter code at the start of the file, e.g. "AC1032". */
  code: string;
  /** The release whose format it is, e.g. "2018" (AutoCAD has saved in the 2018 format since 2018). */
  name: string;
}

const RELEASES: Record<string, string> = {
  "AC1.2": "R1.2",
  "AC1.3": "R1.3",
  "AC1.40": "R1.4",
  "AC1.50": "R2.0",
  "AC2.10": "R2.10",
  "AC2.21": "R2.21",
  "AC2.22": "R2.22",
  AC1001: "R2.4",
  AC1002: "R2.5",
  AC1003: "R2.6",
  AC1004: "R9",
  AC1005: "R9",
  AC1006: "R10",
  AC1007: "R11",
  AC1008: "R11",
  AC1009: "R11/R12",
  AC1010: "R13",
  AC1011: "R13",
  AC1012: "R13",
  AC1013: "R13",
  AC1014: "R14",
  AC1500: "2000",
  AC1015: "2000",
  AC1016: "2000i",
  AC1017: "2002",
  AC1018: "2004",
  AC1021: "2007",
  AC1024: "2010",
  AC1027: "2013",
  AC1032: "2018",
};

/** The DWG release from a file's first bytes, or null when it does not start like a DWG file. */
export function dwgRelease(head: Uint8Array): DwgRelease | null {
  let code = "";
  for (const byte of head.subarray(0, 6)) {
    if (byte === 0) break;
    code += String.fromCharCode(byte);
  }
  if (RELEASES[code]) return { code, name: RELEASES[code] };
  // A release missing from the list, which LibreDWG may still read.
  if (/^AC10\d\d$/.test(code)) return { code, name: code > "AC1032" ? "newer than 2018" : code };
  return null;
}

export type DwgFailure = "failed" | "timeout" | "cancelled" | "unavailable";

export class DwgReadError extends Error {
  constructor(
    message: string,
    readonly failure: DwgFailure,
    /** LibreDWG's error bits, when it reported them. */
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = "DwgReadError";
  }
}

export interface DwgConversion {
  /** The drawing as DXF, in the DWG's own release. */
  dxf: ArrayBuffer;
  /** LibreDWG's error bits: 0 for a clean conversion, below 128 for problems it worked around. */
  code: number;
  stats: { loadMs: number; convertMs: number; dwgBytes: number; dxfBytes: number };
}

type WorkerMessage =
  | { type: "progress"; label: string }
  | { type: "done"; dxf: ArrayBuffer; code: number; messages: string[]; stats: DwgConversion["stats"] }
  | { type: "error"; message: string; code: number | null; outOfMemory: boolean; messages: string[] };

/**
 * Converts a DWG file to DXF in the add-on's worker. One worker per file, terminated afterwards (the only way to
 * give the WebAssembly memory back); stopped if it runs for too long.
 */
export function convertDwg(file: Blob, onProgress?: (label: string) => void, signal?: AbortSignal): Promise<DwgConversion> {
  return new Promise<DwgConversion>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DwgReadError("Cancelled", "cancelled"));
      return;
    }
    const url = `${BASE}dwg.worker.js`;
    const worker = new Worker(url, { type: "module" });
    // Most drawings convert in well under a second; allow plenty for big ones.
    const limit = Math.min(600_000, 60_000 + (file.size / 1_000_000) * 20_000);
    const timer = setTimeout(() => finish(() => reject(new DwgReadError("Reading this DWG took too long, so it was stopped.", "timeout"))), limit);
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      settle();
    };
    const onAbort = () => finish(() => reject(new DwgReadError("Cancelled", "cancelled")));
    signal?.addEventListener("abort", onAbort);
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") onProgress?.(message.label);
      else if (message.type === "done") finish(() => resolve({ dxf: message.dxf, code: message.code, stats: message.stats }));
      else if (message.type === "error")
        finish(() => reject(new DwgReadError(message.outOfMemory ? "The DWG reader ran out of memory on this drawing." : message.message, "failed", message.code)));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() => reject(new DwgReadError(`The DWG add-on could not start${event.message ? ` (${event.message})` : ""}.`, "unavailable")));
    };
    worker.postMessage({ type: "convert", file });
  });
}
