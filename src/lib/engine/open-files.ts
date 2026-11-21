import { modelContentKind, modelFileName, type ModelFile } from "@/lib/collection/files";
import { JobCancelled } from "@/lib/ifc/client";
import { listArchiveModels, sniffModelFile, unpackModel, type ZipEntry } from "@/lib/ifc/ifczip";
import { pushToast, removeTask, uid, upsertTask } from "@/lib/store";
import { formatBytes } from "@/lib/utils/format";
import type { PreparedModel, ViewerEngine } from "./engine";

export const IFC_ACCEPT = ".ifc,.ifczip,.zip,.frag";

function extension(name: string) {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** What goes with a model when it is opened as part of a folder or archive. */
export interface OpenOptions {
  /** Name the model is listed under with the others it came with. */
  collection?: string;
  /** Position in the list among the models of the collection. */
  order?: number;
  folder?: string;
  description?: string;
  note?: string;
  /** The IFC a .frag was converted from, to keep IFC export available. */
  sourceFile?: Blob;
  /** Stops the model while it is being unpacked or converted. */
  signal?: AbortSignal;
}

/** Routes dropped or picked files to the right loader. Returns the ids of the models that loaded. */
export async function openModelFiles(engine: ViewerEngine, files: File[]): Promise<string[]> {
  const loaded: string[] = [];
  for (const file of files) {
    const kind = extension(file.name);
    if (kind === "ifc" || kind === "ifczip" || kind === "zip") {
      // The first bytes decide, not the extension: an archive named .ifc is
      // unpacked, and a plain IFC named .ifczip opens as the IFC it is.
      const format = await sniffModelFile(file);
      if (format === "zip" || (kind !== "ifc" && format !== "step")) {
        loaded.push(...(await openArchive(engine, file)));
      } else {
        const modelId = await engine.loadIfc(file, file.name);
        if (modelId) loaded.push(modelId);
      }
    } else if (kind === "frag") {
      const modelId = await engine.loadFragmentsFile(file, file.name);
      if (modelId) loaded.push(modelId);
    } else if (kind === "rvt" || kind === "rfa") pushToast("info", `${file.name}: open Revit files from the RVT viewer.`);
    else if (kind === "nwd" || kind === "nwc") pushToast("info", `${file.name}: open Navisworks files from the NWD viewer.`);
    else pushToast("error", `${file.name}: unsupported file type. Use .ifc, .ifczip or .frag.`);
  }
  return loaded;
}

/**
 * Opens one model: a file on its own, or one file inside an archive. Returns
 * the model's id, null when it could not be opened (the reason is shown as a
 * message), or "cancelled".
 */
export async function openModel(engine: ViewerEngine, model: ModelFile, options: OpenOptions = {}): Promise<string | "cancelled" | null> {
  const prepared = await prepareModel(engine, model, options);
  if (prepared === "cancelled" || !prepared) return prepared;
  return prepared.add();
}

/**
 * Does everything for a model short of showing it: unpacks it and converts
 * it. `add()` of the result puts it in the scene. Returns null when the model
 * could not be prepared (the reason is shown as a message), or "cancelled".
 */
export async function prepareModel(engine: ViewerEngine, model: ModelFile, options: OpenOptions = {}): Promise<PreparedModel | "cancelled" | null> {
  const { signal, sourceFile, ...details } = options;
  const name = modelFileName(model);
  let data: Blob = model.file;
  if (model.entry) {
    const unpacked = await unpack(engine, model.file, model.entry, name, signal);
    if (unpacked === "cancelled" || !unpacked) return unpacked;
    data = unpacked;
    details.note ??= `Unpacked from ${model.file.name} (${formatBytes(model.file.size)})`;
  } else if (model.kind === "ifczip") {
    // An archive that could not be looked into beforehand: opening it says what is wrong with it.
    const ids = await openArchive(engine, model.file, options);
    if (ids.length === 0) return signal?.aborted ? "cancelled" : null;
    return { add: async () => ids[0] };
  }
  // A .frag needs no preparing: loading it is showing it.
  if (modelContentKind(model) === "frag") return { add: () => engine.loadFragmentsFile(data, name, { ...details, sourceFile }) };
  const prepared = await engine.convertIfcModel(data, name, { ...details, signal });
  return prepared ?? (signal?.aborted ? "cancelled" : null);
}

/**
 * Opens an ifcZIP, or any ZIP archive that holds models: every .ifc and
 * .frag in it is opened like a file picked from disk, so it can be analysed
 * and exported in the same way. Models of one archive are listed together.
 */
async function openArchive(engine: ViewerEngine, archive: File, options: OpenOptions = {}): Promise<string[]> {
  const loaded: string[] = [];
  let entries: ZipEntry[];
  try {
    entries = await listArchiveModels(archive);
  } catch (error) {
    console.warn(`Failed to read ${archive.name}`, error);
    pushToast("error", `${archive.name}: ${messageOf(error)}`);
    return loaded;
  }
  const collection = options.collection ?? (entries.length > 1 ? archive.name : undefined);
  for (const entry of entries) {
    if (engine.isDisposed || options.signal?.aborted) break;
    const model: ModelFile = { path: `${archive.name}/${entry.name}`, kind: /\.frag$/i.test(entry.name) ? "frag" : "ifc", size: entry.size, lastModified: archive.lastModified, file: archive, entry };
    const modelId = await openModel(engine, model, { ...options, collection });
    if (modelId === "cancelled") break;
    if (modelId) loaded.push(modelId);
  }
  return loaded;
}

/** Unpacks one model with a cancellable entry in the task list. Reports failures itself. */
async function unpack(engine: ViewerEngine, archive: File, entry: ZipEntry, name: string, signal?: AbortSignal): Promise<Blob | "cancelled" | null> {
  const taskId = uid("task");
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal?.aborted) return "cancelled";
  signal?.addEventListener("abort", stop);
  const untrack = engine.trackTask(taskId, controller);
  const label = `Unpacking ${name}`;
  const phase = `From ${archive.name}`;
  const total = formatBytes(entry.size);
  upsertTask({ id: taskId, label, phase, progress: 0, cancellable: true });
  try {
    return await unpackModel(
      archive,
      entry,
      (bytes) => upsertTask({ id: taskId, label, phase, progress: bytes / entry.size, detail: `${formatBytes(bytes)} of ${total}`, cancellable: true }),
      controller.signal,
    );
  } catch (error) {
    if (error instanceof JobCancelled) {
      pushToast("info", `Cancelled ${name}.`);
      return "cancelled";
    }
    console.warn(`Failed to unpack ${archive.name}`, error);
    pushToast("error", `${archive.name}: ${messageOf(error)}`);
    return null;
  } finally {
    signal?.removeEventListener("abort", stop);
    untrack();
    removeTask(taskId);
  }
}
