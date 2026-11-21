#!/usr/bin/env node
// Joins several Fragments files into one from the command line.
//
//   npm run combine -- a.frag b.frag c.frag [-o combined.frag]
//
// The result is a single Fragments model that holds every item of each
// input, placed where the viewer shows them when they are opened together.
// The first file sets the coordinate system. It is the same joining the app
// does for "combined .frag", without a browser tab's memory limits: memory
// holds the combined model plus one input at a time.

import { createWriteStream, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createDeflate, inflateSync } from "node:zlib";
import { createFragmentsMerger, MergeError } from "../src/lib/fragments/merge-fragments.mjs";

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The uncompressed data of a .frag file (which is zlib-compressed unless it was saved raw). */
export function readFragments(path) {
  const bytes = readFileSync(path);
  const zlib = bytes.length >= 2 && (bytes[0] & 15) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0;
  const raw = zlib ? inflateSync(bytes) : bytes;
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
}

/**
 * Joins the .frag files at `paths`, in that order, and writes the result to `outputPath`.
 * @returns what the merger reports, plus the size of the written file
 */
export async function combineFiles(paths, outputPath, log = console.log) {
  // The combined model is built in one block of memory that is sized up front, so the inputs are measured first.
  let totalBytes = 0;
  for (const path of paths) totalBytes += readFragments(path).length;
  const merger = createFragmentsMerger({ totalBytes });
  for (const path of paths) {
    const added = merger.add(readFragments(path), { name: basename(path) });
    log(`  + ${basename(path)}: ${added.elements.toLocaleString("en-US")} elements`);
  }
  const name = basename(outputPath).replace(/\.frag$/i, "");
  const result = merger.finish({ name, id: randomUUID() });

  // Compressed as a stream, so the output never sits in memory a second time.
  const SLICE = 4 * 1024 * 1024;
  function* slices() {
    for (let offset = 0; offset < result.bytes.length; offset += SLICE) yield result.bytes.subarray(offset, Math.min(offset + SLICE, result.bytes.length));
  }
  const output = createWriteStream(outputPath);
  await pipeline(Readable.from(slices(), { objectMode: false }), createDeflate(), output);
  return { ...result, fileBytes: output.bytesWritten, rawBytes: result.bytes.length };
}

// Run as a command (and not imported by the converter).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const inputs = [];
  let output = "combined.frag";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" || args[i] === "--output") output = args[++i] ?? output;
    else inputs.push(args[i]);
  }
  if (inputs.length < 2) {
    console.error("Usage: npm run combine -- <a.frag> <b.frag> [more.frag ...] [-o combined.frag]");
    process.exit(1);
  }
  const outputPath = resolve(output);
  const started = Date.now();
  try {
    console.log(`Combining ${inputs.length} models`);
    const result = await combineFiles(inputs.map((input) => resolve(input)), outputPath);
    console.log(
      `Wrote ${outputPath} (${megabytes(result.fileBytes)}): ${result.elements.toLocaleString("en-US")} elements from ${result.models.length} models in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  } catch (error) {
    if (error instanceof MergeError) {
      console.error(error.message);
      process.exit(1);
    }
    if (error?.code === "ENOENT") {
      console.error(`${error.path}: no such file.`);
      process.exit(1);
    }
    throw error;
  }
}
