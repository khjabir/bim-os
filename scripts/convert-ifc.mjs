#!/usr/bin/env node
// Converts IFC files to That Open Fragments (.frag) from the command line.
//
//   npm run convert -- model.ifc [output.frag]
//   npm run convert -- model.ifczip [output.frag]
//   npm run convert -- folder [--combined all.frag] [--all] [--force] [--dry-run]
//
// Use it for models too large to convert inside a browser tab. Node has no
// per-tab memory ceiling, and the file is read from disk in chunks, so the
// IFC itself is never loaded into memory as a whole. The result opens in the
// IFC viewer with "Open files" and is identical to what the browser produces.
//
// A model packed in an ifcZIP (.ifczip, or any .zip that holds .ifc files) is
// first unpacked to a temporary file. It needs as much free space as the
// unpacked IFC and is gone again when the script ends, however it ends; set
// TMPDIR (TEMP on Windows) to put it on another disk.
//
// Given a folder, every model in it is converted, with the choices the app
// makes for "Open folder": one copy per model, and no model that only repeats
// what other models hold (--all converts those too). Each .frag is written
// next to its IFC, where "Open folder" finds it and opens it in seconds
// instead of converting again. A .frag that is as new as its IFC is left
// alone (--force converts anyway). --combined also writes all of them as one
// Fragments model. --dry-run lists what would be done and writes nothing. Every model of a folder is converted in a process of its
// own: its memory is back before the next one starts, and a model that fails
// does not stop the others.

import * as FRAGS from "@thatopen/fragments";
import * as WEBIFC from "web-ifc";
import { closeSync, createReadStream, createWriteStream, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createInflateRaw } from "node:zlib";
import { createIfcScanner, ifcHeaderProblem } from "../src/lib/collection/ifc-scan.mjs";
import { findRepeats, isClutterPath, modelKind, planModels } from "../src/lib/collection/plan.mjs";
import { MergeError, summariseFragments } from "../src/lib/fragments/merge-fragments.mjs";
import {
  crc32,
  describeMissingModel,
  entryDataOffset,
  fileNameOf,
  METHOD_STORED,
  readZipEntries,
  selectIfcEntries,
  startsLikeStep,
  startsLikeZip,
  UNPACK_MISMATCH,
  unsupportedReason,
  ZipError,
} from "../src/lib/ifc/zip-archive.mjs";
import { combineFiles, readFragments } from "./combine-frags.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const extras = JSON.parse(readFileSync(join(here, "../src/lib/ifc/importer-extras.json"), "utf8"));

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(1)} s`;
const count = (value) => value.toLocaleString("en-US");

// Folder mode runs this script once per model and hands it the model's place in the queue ("[3/10] "),
// which goes in front of the first line it prints.
let placeInQueue = process.env.IFC_STUDIO_STEP ?? "";
function stepPrefix() {
  const prefix = placeInQueue;
  placeInQueue = "";
  return prefix;
}

// One status line that is rewritten in place while a step runs.
let lastLine = "";
function status(line) {
  if (line === lastLine) return;
  lastLine = line;
  if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(70)}`);
}
function endStatus() {
  if (lastLine && process.stdout.isTTY) process.stdout.write("\n");
  lastLine = "";
}

/** Reads from an open file the way the ZIP reader asks for it. */
const readerOf = (file) => (offset, length) => {
  const bytes = new Uint8Array(length);
  const got = readSync(file, bytes, 0, length, offset);
  return got === length ? bytes : bytes.subarray(0, got);
};

// ---------------------------------------------------------------------------
// One model
// ---------------------------------------------------------------------------

/**
 * Converts the IFC held by the open file `source.file` at bytes `start` to
 * `start + size`. A model stored without compression is read straight out of
 * its archive this way.
 */
async function convert(source, outputPath) {
  const importer = new FRAGS.IfcImporter();
  importer.wasm = { path: dirname(require.resolve("web-ifc")) + "/", absolute: true };
  importer.parseOnce = true;
  for (const [name, mapping] of Object.entries(extras.relations)) {
    if (typeof WEBIFC[name] === "number") importer.relations.set(WEBIFC[name], mapping);
  }
  for (const name of extras.abstractClasses) {
    if (typeof WEBIFC[name] === "number") importer.classes.abstract.add(WEBIFC[name]);
  }

  const readCallback = (offset, length) => {
    const wanted = Math.max(0, Math.min(length, source.size - offset));
    const chunk = new Uint8Array(wanted);
    if (wanted > 0) readSync(source.file, chunk, 0, wanted, source.start + offset);
    return chunk;
  };

  console.log(`${stepPrefix()}Converting ${source.label} (${megabytes(source.size)})`);
  const started = Date.now();
  // The importer prints a line for every piece of geometry it cannot turn into a surface
  // ("Fragments: Problematic geometry: <id>"), thousands of them for some models. They are counted instead.
  const log = console.log;
  let leftOut = 0;
  console.log = (...args) => {
    if (typeof args[0] === "string" && args[0].startsWith("Fragments: Problematic geometry")) leftOut++;
    else log(...args);
  };
  try {
    const bytes = await importer.process({
      readFromCallback: true,
      readCallback,
      raw: false,
      progressCallback: (progress, data) => {
        status(`${String(Math.round(progress * 100)).padStart(3)}%  ${data.process}${data.class ? `  ${data.class}` : ""}`);
      },
    });
    endStatus();
    writeFileSync(outputPath, bytes);
    log(`Wrote ${outputPath} (${megabytes(bytes.byteLength)}) in ${seconds(started)}`);
    if (leftOut > 0) log(`  ${count(leftOut)} piece${leftOut === 1 ? "" : "s"} of geometry left out: the importer could not turn ${leftOut === 1 ? "it" : "them"} into surfaces`);
  } finally {
    console.log = log;
    endStatus();
  }
}

/**
 * Opens an empty temporary file for an unpacked model and removes its name at
 * once. The data stays readable through the open file, and the system frees
 * the space when this process ends: also when it is stopped with Ctrl+C in the
 * middle of a conversion, where no clean-up code gets to run.
 */
function openScratchFile() {
  const folder = mkdtempSync(join(tmpdir(), "ifc-studio-"));
  const path = join(folder, "model.ifc");
  const file = openSync(path, "w+");
  try {
    unlinkSync(path);
    rmdirSync(folder);
  } catch {
    // Windows can keep the entry until the file is closed; close() removes it then.
  }
  return {
    file,
    folder,
    close() {
      closeSync(file);
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

/** Unpacks one Deflate-compressed archive entry into the scratch file, checking its size and CRC-32. */
async function unpack(archivePath, start, entry, scratch) {
  let checksum = 0;
  let unpacked = 0;
  const name = fileNameOf(entry.name);
  const check = new Transform({
    transform(chunk, _encoding, done) {
      unpacked += chunk.length;
      if (unpacked > entry.size) {
        done(new ZipError(UNPACK_MISMATCH));
        return;
      }
      checksum = crc32(chunk, checksum);
      status(`${String(Math.floor((unpacked / entry.size) * 100)).padStart(3)}%  unpacking ${name}`);
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(archivePath, { start, end: start + entry.compressedSize - 1 }),
      createInflateRaw(),
      check,
      createWriteStream("", { fd: scratch.file, autoClose: false, start: 0 }),
    );
  } catch (error) {
    // zlib reports invalid or truncated data with a Z_* code.
    if (typeof error?.code === "string" && error.code.startsWith("Z_")) {
      throw new ZipError("The archive is damaged: its compressed data cannot be read.");
    }
    if (error?.code === "ENOSPC") {
      throw new ZipError(
        `Not enough free space in ${dirname(scratch.folder)} to unpack ${name} (${megabytes(entry.size)}). ` +
          "Set TMPDIR (TEMP on Windows) to a folder on a larger disk and run the command again.",
      );
    }
    throw error;
  } finally {
    endStatus();
  }
  if (unpacked !== entry.size || checksum !== entry.crc32) throw new ZipError(UNPACK_MISMATCH);
}

/** Converts one .ifc of the archive open as `archive`. */
async function convertEntry(archive, archivePath, archiveSize, entry, outputPath) {
  const reason = unsupportedReason(entry);
  if (reason) throw new ZipError(reason);
  const name = fileNameOf(entry.name);
  const start = await entryDataOffset(readerOf(archive), entry, archiveSize);
  if (entry.method === METHOD_STORED) {
    await convert({ file: archive, start, size: entry.size, label: `${name} from ${archivePath}` }, outputPath);
    return;
  }
  const scratch = openScratchFile();
  try {
    const started = Date.now();
    console.log(`${stepPrefix()}Unpacking ${name} from ${archivePath} (${megabytes(entry.compressedSize)} to ${megabytes(entry.size)})`);
    await unpack(archivePath, start, entry, scratch);
    console.log(`Unpacked in ${seconds(started)}`);
    await convert({ file: scratch.file, start: 0, size: entry.size, label: name }, outputPath);
  } finally {
    scratch.close();
  }
}

/**
 * Converts every .ifc of the archive open as `archive`. A single model goes to
 * `outputArgument`, or next to the archive under the archive's name; several
 * models go next to the archive under their own names.
 */
async function convertArchive(archive, archivePath, archiveSize, outputArgument, onlyEntry) {
  const selection = selectIfcEntries(await readZipEntries(readerOf(archive), archiveSize));
  // Folder mode names the one model of an archive it wants.
  const models = onlyEntry ? selection.models.filter((entry) => entry.name === onlyEntry) : selection.models;
  if (onlyEntry && models.length === 0) throw new ZipError(`The archive holds no model named ${onlyEntry}.`);
  if (models.length === 0) {
    throw new ZipError(selection.fragments.length > 0 ? "The archive holds .frag files only: there is nothing to convert." : describeMissingModel(selection));
  }
  if (models.length > 1 && outputArgument) {
    throw new ZipError(
      `The archive holds ${models.length} IFC models (${models.map((entry) => fileNameOf(entry.name)).join(", ")}). ` +
        "Leave out the output name: each model is then written next to the archive as <model>.frag.",
    );
  }
  const used = new Set();
  for (const entry of models) {
    let outputPath;
    if (models.length === 1) outputPath = resolve(outputArgument ?? defaultOutput(archivePath));
    else {
      // Models of the same name in different folders must not overwrite each other.
      const base = fileNameOf(entry.name).replace(/\.ifc$/i, "");
      let candidate = base;
      for (let index = 2; used.has(candidate.toLowerCase()); index++) candidate = `${base} (${index})`;
      used.add(candidate.toLowerCase());
      outputPath = join(dirname(archivePath), `${candidate}.frag`);
    }
    await convertEntry(archive, archivePath, archiveSize, entry, outputPath);
  }
}

function defaultOutput(inputPath) {
  return inputPath.replace(/\.(ifczip|zip)$/i, "").replace(/\.ifc$/i, "") + ".frag";
}

/** Converts one file: an IFC, or an archive that holds IFC. */
async function convertFile(inputPath, outputArgument, onlyEntry) {
  const size = statSync(inputPath).size;
  const input = openSync(inputPath, "r");
  try {
    // The first bytes decide, not the extension: an archive named .ifc is unpacked too.
    const head = new Uint8Array(64);
    const start = head.subarray(0, readSync(input, head, 0, head.length, 0));
    const zipped = startsLikeZip(start) || (/\.(ifczip|zip)$/i.test(inputPath) && !startsLikeStep(start));
    if (zipped) await convertArchive(input, inputPath, size, outputArgument, onlyEntry);
    else {
      // Files that are not IFC make the engine crash with errors that say nothing; say what is wrong instead.
      const top = new Uint8Array(65536);
      const problem = ifcHeaderProblem(top.subarray(0, readSync(input, top, 0, top.length, 0)), size <= top.length);
      if (problem) throw new ZipError(problem);
      await convert({ file: input, start: 0, size, label: inputPath }, resolve(outputArgument ?? defaultOutput(inputPath)));
    }
  } finally {
    closeSync(input);
  }
}

// ---------------------------------------------------------------------------
// A folder of models
// ---------------------------------------------------------------------------

/** Every file below `folder`, as paths relative to it with "/" between the parts. */
function listFiles(folder, prefix = "", out = []) {
  for (const entry of readdirSync(join(folder, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isClutterPath(entry.isDirectory() ? `${path}/x` : path)) continue;
    if (entry.isDirectory()) listFiles(folder, path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** The model files of a folder: IFC and .frag files, and the IFC files inside archives. */
async function findModels(folder) {
  const models = [];
  for (const path of listFiles(folder)) {
    const absolute = join(folder, path);
    const stats = statSync(absolute);
    const kind = modelKind(path);
    if (kind === "ifc" || kind === "frag") {
      models.push({ path, absolute, kind, size: stats.size, lastModified: stats.mtimeMs });
      continue;
    }
    if (kind !== "ifczip" && !/\.zip$/i.test(path)) continue;
    const archive = openSync(absolute, "r");
    try {
      const entries = selectIfcEntries(await readZipEntries(readerOf(archive), stats.size)).models;
      // The usual ifcZIP, one IFC, stands for the model under the archive's own name.
      if (entries.length === 1) models.push({ path, absolute, kind: "ifczip", size: stats.size, lastModified: stats.mtimeMs, entry: entries[0] });
      else for (const entry of entries) models.push({ path: `${path}/${entry.name}`, absolute, kind: "ifc", size: entry.size, lastModified: stats.mtimeMs, entry });
    } catch (error) {
      if (!(error instanceof ZipError)) throw error;
      if (kind === "ifczip") console.log(`  ${path}: ${error.message}`);
    } finally {
      closeSync(archive);
    }
  }
  return models;
}

/** GlobalIds, schema and element count of one model, without converting it. Null when it cannot be read. */
async function scanModel(model) {
  try {
    if (model.kind === "frag") {
      const summary = summariseFragments(readFragments(model.absolute));
      return { schema: summary.schema, elements: summary.elements, guids: summary.guids };
    }
    const scanner = createIfcScanner();
    if (!model.entry) {
      const file = openSync(model.absolute, "r");
      try {
        const buffer = new Uint8Array(8 << 20);
        for (let offset = 0; offset < model.size; ) {
          const got = readSync(file, buffer, 0, buffer.length, offset);
          if (got <= 0) break;
          scanner.push(buffer.subarray(0, got));
          offset += got;
        }
      } finally {
        closeSync(file);
      }
    } else {
      if (unsupportedReason(model.entry)) return null;
      const size = statSync(model.absolute).size;
      const archive = openSync(model.absolute, "r");
      let start;
      try {
        start = await entryDataOffset(readerOf(archive), model.entry, size);
      } finally {
        closeSync(archive);
      }
      const data = createReadStream(model.absolute, { start, end: start + model.entry.compressedSize - 1 });
      const feed = new Writable({
        write(chunk, _encoding, done) {
          scanner.push(chunk);
          done();
        },
      });
      if (model.entry.method === METHOD_STORED) await pipeline(data, feed);
      else await pipeline(data, createInflateRaw(), feed);
    }
    const result = scanner.finish();
    return result.isIfc ? { schema: result.schema, elements: result.elements, guids: result.guids } : null;
  } catch {
    return null;
  }
}

function describeRepeat(repeat, labels) {
  const where = repeat.of.map((key) => labels.get(key) ?? key);
  const share = repeat.shared >= repeat.total ? `all ${count(repeat.total)} elements` : `${count(repeat.shared)} of its ${count(repeat.total)} elements`;
  if (repeat.kind === "same") return `the same elements as ${where[0]}`;
  if (repeat.kind === "combined") return `${share} are also in ${where.join(", ")}`;
  return `${share} are also in ${where[0]}`;
}

async function convertFolder(folder, options) {
  const found = await findModels(folder);
  if (found.length === 0) throw new ZipError("The folder holds no .ifc, .ifczip or .frag files.");
  const plan = planModels(found.map((model, ref) => ({ path: model.path, kind: model.kind, size: model.size, lastModified: model.lastModified, ref })));
  const copies = found.length - plan.length;
  console.log(`${plan.length} model${plan.length === 1 ? "" : "s"} in ${folder}${copies > 0 ? ` (${found.length} files: one copy of each model is used)` : ""}`);

  // A look into every model, to leave out the ones that only repeat others.
  const labels = new Map(plan.map((model) => [model.key, found[model.use.ref].path]));
  const scans = new Map();
  for (const model of plan) {
    status(`  looking into ${labels.get(model.key)}`);
    scans.set(model.key, await scanModel(found[model.use.ref]));
  }
  endStatus();
  const repeats = options.all ? new Map() : findRepeats(plan.map((model) => ({ key: model.key, guids: scans.get(model.key)?.guids ?? null })));
  const width = Math.max(...[...labels.values()].map((label) => label.length));
  for (const model of plan) {
    const scan = scans.get(model.key);
    const repeat = repeats.get(model.key);
    const facts = scan ? `${scan.schema.padEnd(7)} ${count(scan.elements).padStart(8)} elements` : "(not read)".padEnd(25);
    console.log(`  ${labels.get(model.key).padEnd(width)}  ${facts}${repeat ? `  left out: ${describeRepeat(repeat, labels)}` : ""}`);
  }

  // Convert what has no up-to-date .frag yet. Each .frag goes next to its IFC.
  const chosen = plan.filter((model) => !repeats.has(model.key));
  const started = Date.now();
  const outputs = [];
  const failed = [];
  let converted = 0;
  let pending = 0;
  for (const [index, model] of chosen.entries()) {
    const use = found[model.use.ref];
    const original = model.copies.map((copy) => found[copy.ref]).filter((copy) => copy.kind !== "frag").sort((a, b) => (a.kind === "ifc" ? -1 : 1) - (b.kind === "ifc" ? -1 : 1))[0];
    const step = `[${index + 1}/${chosen.length}]`;
    if (use.kind === "frag" && !(options.force && original)) {
      console.log(`${step} ${use.path} is up to date`);
      outputs.push(use.absolute);
      continue;
    }
    const outputPath = join(dirname(original.absolute), `${model.stem}.frag`);
    if (options.dryRun) {
      console.log(`${step} ${original.path} (${megabytes(original.entry?.size ?? original.size)}) would be converted to ${outputPath}`);
      pending++;
      continue;
    }
    // A process of its own for every model: converting a large IFC takes several GB, and this way all of it
    // is back before the next model starts. It is this script again, given the one file.
    const args = [fileURLToPath(import.meta.url), original.absolute, outputPath];
    if (original.entry && original.kind !== "ifczip") args.push("--entry", original.entry.name);
    const result = spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, IFC_STUDIO_STEP: `${step} ` } });
    if (result.status === 0) {
      outputs.push(outputPath);
      converted++;
    } else {
      // Stopped by hand (Ctrl+C reaches both processes; a signal sent to the model's process alone ends the run as well).
      if (result.signal === "SIGINT" || result.signal === "SIGTERM") process.exit(1);
      // The model's own message is on the screen already.
      const how = result.signal ? `was stopped by the system (${result.signal}), most likely for lack of memory` : "could not be converted";
      console.log(`${step} ${original.path} ${how}`);
      failed.push(original.path);
    }
  }
  if (options.dryRun) {
    console.log(`Nothing was written: ${pending} model${pending === 1 ? "" : "s"} to convert, ${chosen.length - pending} up to date${options.combined ? `; ${resolve(options.combined)} would hold all ${chosen.length}` : ""}`);
    return;
  }
  const upToDate = chosen.length - converted - failed.length;
  if (converted > 0 || failed.length > 0) console.log(`${converted} model${converted === 1 ? "" : "s"} converted in ${seconds(started)}; ${upToDate} already up to date`);
  else console.log("Every model has an up-to-date .frag already");
  if (failed.length > 0) {
    // What worked stays, so running the command again only tries these.
    process.exitCode = 1;
    console.error(`Not converted: ${failed.join(", ")}`);
    if (options.combined) console.error("The combined file was not written, because it would lack these models.");
    return;
  }

  if (options.combined) {
    const combinedPath = resolve(options.combined);
    const combineStarted = Date.now();
    console.log(`Combining ${outputs.length} models into ${combinedPath}`);
    const result = await combineFiles(outputs, combinedPath, () => {});
    console.log(`Wrote ${combinedPath} (${megabytes(result.fileBytes)}): ${count(result.elements)} elements from ${result.models.length} models in ${seconds(combineStarted)}`);
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const positional = [];
const options = { combined: null, all: false, force: false, dryRun: false, entry: null };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--combined") options.combined = args[++i] ?? null;
  else if (args[i] === "--all") options.all = true;
  else if (args[i] === "--force") options.force = true;
  else if (args[i] === "--dry-run") options.dryRun = true;
  // Used by folder mode on itself: the one model of an archive to convert.
  else if (args[i] === "--entry") options.entry = args[++i] ?? null;
  else positional.push(args[i]);
}
const [inputArgument, outputArgument] = positional;
if (!inputArgument) {
  console.error("Usage: npm run convert -- <model.ifc | model.ifczip> [output.frag]\n       npm run convert -- <folder> [--combined all.frag] [--all] [--force] [--dry-run]");
  process.exit(1);
}
const inputPath = resolve(inputArgument);

try {
  if (statSync(inputPath).isDirectory()) await convertFolder(inputPath, options);
  else {
    if (options.combined) throw new ZipError("--combined joins the models of a folder: give a folder, or use `npm run combine -- a.frag b.frag -o all.frag` for single files.");
    await convertFile(inputPath, outputArgument, options.entry);
  }
} catch (error) {
  endStatus();
  if (error instanceof ZipError || error instanceof MergeError) {
    console.error(`${inputPath}: ${error.message}`);
    process.exit(1);
  }
  if (error?.code === "ENOENT" || error?.code === "EACCES") {
    console.error(`${error.path ?? inputPath}: ${error.code === "ENOENT" ? "no such file" : "permission denied"}.`);
    process.exit(1);
  }
  throw error;
}
