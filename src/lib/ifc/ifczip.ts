// ifcZIP support: an .ifczip is a ZIP archive that holds an IFC model. A plain
// .zip may hold several, and .frag files as well (this app's own export).
//
// The table of contents is read here with a few small reads; the model itself
// is unpacked in a worker into a Blob the browser stores, which then goes
// through the same pipeline as a file picked from disk. A model that was
// stored without compression is not copied at all: it is a slice of the archive.

import { JobCancelled } from "./client";
import type { InflateRequest, InflateResponse } from "./protocol";
import {
  describeMissingModel,
  entryDataOffset,
  fileNameOf,
  METHOD_STORED,
  readZipEntries,
  selectIfcEntries,
  startsLikeStep,
  startsLikeZip,
  unsupportedReason,
  ZipError,
  type ZipEntry,
  type ZipRead,
} from "./zip-archive.mjs";

export { ZipError, fileNameOf };
export type { ZipEntry };

function reader(file: Blob): ZipRead {
  return async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
}

/** What a file really is, judged by its first bytes rather than its extension. */
export async function sniffModelFile(file: Blob): Promise<"zip" | "step" | "unknown"> {
  try {
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    if (startsLikeZip(head)) return "zip";
    if (startsLikeStep(head)) return "step";
  } catch {
    // Unreadable: the loader that gets the file reports it.
  }
  return "unknown";
}

/**
 * Lists the models of an archive: its .ifc files and its .frag files. Throws
 * `ZipError` when the file is not a readable ZIP archive or holds neither.
 */
export async function listArchiveModels(archive: Blob): Promise<ZipEntry[]> {
  const selection = selectIfcEntries(await readZipEntries(reader(archive), archive.size));
  const models = [...selection.models, ...selection.fragments];
  if (models.length === 0) throw new ZipError(describeMissingModel(selection));
  return models;
}

/**
 * Unpacks one model of an archive into a Blob. `onProgress` receives the
 * unpacked byte count. Throws `ZipError` for archives that cannot be unpacked
 * and `JobCancelled` when `signal` aborts.
 */
export async function unpackModel(
  archive: Blob,
  entry: ZipEntry,
  onProgress?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const reason = unsupportedReason(entry);
  if (reason) throw new ZipError(reason);
  const start = await entryDataOffset(reader(archive), entry, archive.size);
  const data = archive.slice(start, start + entry.compressedSize);
  if (entry.method === METHOD_STORED) return data;
  return inflate({ data, size: entry.size, crc32: entry.crc32 }, onProgress, signal);
}

function inflate(request: InflateRequest, onProgress?: (bytes: number) => void, signal?: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new JobCancelled());
      return;
    }
    const worker = new Worker(new URL("./unzip.worker.ts", import.meta.url), { type: "module" });
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(new JobCancelled());
    };
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (event: MessageEvent<InflateResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.(message.bytes);
      } else if (message.type === "error") {
        finish();
        reject(new ZipError(message.message));
      } else {
        finish();
        resolve(message.blob);
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "Unpacking stopped unexpectedly (most likely out of memory)."));
    };
    worker.postMessage(request);
  });
}
