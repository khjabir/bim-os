/// <reference lib="webworker" />
//
// Unpacks one entry of a ZIP archive (an ifcZIP) off the main thread.
//
// The compressed bytes are streamed from disk through the browser's own
// Deflate decoder, and the result is handed to the browser as Blob parts of
// 32 MB, so neither the archive nor the unpacked IFC ever has to fit into
// JavaScript memory: the browser keeps the parts, on disk once they add up
// (Chromium; a private window keeps them in memory and so holds far less).
// The size and CRC-32 recorded in the archive are checked on the way, so a
// damaged archive is reported instead of producing a broken model.
//
// Like the IFC worker, one instance serves one job and is then terminated.

import type { InflateRequest, InflateResponse } from "./protocol";
import { announceReady } from "@/lib/utils/worker-ready";
import { crc32, UNPACK_MISMATCH } from "./zip-archive.mjs";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const PART_BYTES = 32 * 1024 * 1024;
const PROGRESS_BYTES = 4 * 1024 * 1024;

function post(message: InflateResponse) {
  ctx.postMessage(message);
}

class UnpackError extends Error {}

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024).toLocaleString("en-US")} MB`;

/**
 * Creating a Blob never fails; one the browser has no room for only fails when
 * it is read. Reading a byte of every part as it is made reports that at once
 * instead of after the whole model has been unpacked.
 */
async function store(pieces: BlobPart[], size: number, type?: string): Promise<Blob> {
  const blob = new Blob(pieces, { type });
  try {
    await blob.slice(0, 1).arrayBuffer();
  } catch {
    throw new UnpackError(
      `The browser has no room to hold the unpacked model (${megabytes(size)}). Private windows hold far less than normal ones. ` +
        "If this is a normal window, convert the archive with `npm run convert -- <file.ifczip>` instead and open the resulting .frag.",
    );
  }
  return blob;
}

async function inflate({ data, size, crc32: expected }: InflateRequest) {
  if (typeof DecompressionStream === "undefined") {
    throw new UnpackError("This browser cannot unpack ZIP archives. Unpack the file and open the .ifc file.");
  }
  const reader = data.stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Blob[] = [];
  let pending: Uint8Array<ArrayBuffer>[] = [];
  let pendingBytes = 0;
  let bytes = 0;
  let reported = 0;
  let checksum = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      // A stream that grows past the size the archive records is damaged (or built to exhaust memory).
      if (bytes > size) throw new UnpackError(UNPACK_MISMATCH);
      checksum = crc32(value, checksum);
      pending.push(value);
      pendingBytes += value.byteLength;
      if (pendingBytes >= PART_BYTES) {
        parts.push(await store(pending, size));
        pending = [];
        pendingBytes = 0;
      }
      if (bytes - reported >= PROGRESS_BYTES) {
        reported = bytes;
        post({ type: "progress", bytes });
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof UnpackError) throw error;
    // The decoder rejects invalid or truncated Deflate data with a TypeError;
    // a file that can no longer be read from disk surfaces as a DOMException.
    if (error instanceof TypeError) throw new UnpackError("The archive is damaged: its compressed data cannot be read.");
    if (error instanceof DOMException) throw new UnpackError("The archive could not be read from disk. It may have been moved or changed since it was picked.");
    throw error;
  }
  if (pending.length > 0) parts.push(await store(pending, size));
  if (bytes !== size || checksum !== expected) throw new UnpackError(UNPACK_MISMATCH);
  post({ type: "inflated", blob: await store(parts, size, "application/x-step") });
}

ctx.onmessage = async (event: MessageEvent<InflateRequest>) => {
  try {
    await inflate(event.data);
  } catch (error) {
    post({
      type: "error",
      message:
        error instanceof UnpackError
          ? error.message
          : "The browser ran out of memory while unpacking this archive. Close other tabs and retry, or convert it with `npm run convert -- <file.ifczip>` and open the resulting .frag.",
    });
  }
};

announceReady("unzip");
