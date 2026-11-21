// Finds the model files in what the user handed over: a picked folder, a
// dropped folder, or a handful of files. Archives are looked into, so a model
// packed in an .ifczip (or one of several in a .zip) is found as well.

import { entryDataOffset, fileNameOf, readZipEntries, selectIfcEntries, unsupportedReason, ZipError, METHOD_STORED, type ZipEntry } from "@/lib/ifc/zip-archive.mjs";
import { isClutterPath, modelKind, type ModelKind } from "./plan.mjs";

/** A file with its path inside the folder that was opened. */
export interface FolderEntry {
  file: File;
  path: string;
}

/** A model that can be opened: a file on its own, or one file inside an archive. */
export interface ModelFile {
  /** Path inside the opened folder; for a file inside an archive, the archive's path plus the file's. */
  path: string;
  kind: ModelKind;
  size: number;
  lastModified: number;
  file: File;
  /** Set when the model is a file inside the archive `file`. */
  entry?: ZipEntry;
}

export interface FolderContents {
  models: ModelFile[];
  /** Files of other BIM formats, which are opened from their own viewers. */
  revit: number;
  navisworks: number;
}

const read = (file: Blob) => async (offset: number, length: number) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());

/** Lists the models among `entries`. Never throws: an archive that cannot be read is listed and fails when it is opened. */
export async function findModelFiles(entries: FolderEntry[]): Promise<FolderContents> {
  const contents: FolderContents = { models: [], revit: 0, navisworks: 0 };
  for (const { file, path } of entries) {
    if (isClutterPath(path)) continue;
    const lower = path.toLowerCase();
    if (/\.(rvt|rfa|rte)$/.test(lower)) contents.revit++;
    else if (/\.(nwd|nwc)$/.test(lower)) contents.navisworks++;

    const kind = modelKind(path);
    if (kind === "ifc" || kind === "frag") {
      contents.models.push({ path, kind, size: file.size, lastModified: file.lastModified, file });
      continue;
    }
    const isArchive = kind === "ifczip" || lower.endsWith(".zip");
    if (!isArchive) continue;
    try {
      const selection = selectIfcEntries(await readZipEntries(read(file), file.size));
      const found = [...selection.models, ...selection.fragments];
      if (found.length === 1 && selection.models.length === 1) {
        // The usual ifcZIP: one IFC. It stands for the model under the archive's own name.
        contents.models.push({ path, kind: "ifczip", size: file.size, lastModified: file.lastModified, file, entry: found[0] });
      } else if (found.length > 0) {
        for (const entry of found) {
          contents.models.push({
            path: `${path}/${entry.name}`,
            kind: /\.frag$/i.test(entry.name) ? "frag" : "ifc",
            size: entry.size,
            lastModified: file.lastModified,
            file,
            entry,
          });
        }
      } else if (kind === "ifczip") {
        // An .ifczip without an IFC in it: listed, so that opening it says what is wrong.
        contents.models.push({ path, kind: "ifczip", size: file.size, lastModified: file.lastModified, file });
      }
    } catch (error) {
      if (!(error instanceof ZipError)) console.warn(`Could not look into ${path}`, error);
      if (kind === "ifczip") contents.models.push({ path, kind: "ifczip", size: file.size, lastModified: file.lastModified, file });
    }
  }
  return contents;
}

/** The name a model goes by: its own file name, also when it sits inside an archive. */
export function modelFileName(model: ModelFile): string {
  if (model.entry) return fileNameOf(model.entry.name);
  return model.path.slice(model.path.lastIndexOf("/") + 1);
}

/** What kind of data the model itself is, whatever it is packed in. */
export function modelContentKind(model: ModelFile): "ifc" | "frag" {
  if (model.entry) return /\.frag$/i.test(model.entry.name) ? "frag" : "ifc";
  return model.kind === "frag" ? "frag" : "ifc";
}

/**
 * The bytes of a model for a quick scan: the file, or the slice of its
 * archive, and whether that slice is Deflate-compressed. Null when the model
 * cannot be read without more work (an unsupported or unreadable archive).
 */
export async function modelBytes(model: ModelFile): Promise<{ data: Blob; deflated: boolean } | null> {
  if (!model.entry) return model.kind === "ifczip" ? null : { data: model.file, deflated: false };
  if (unsupportedReason(model.entry)) return null;
  try {
    const start = await entryDataOffset(read(model.file), model.entry, model.file.size);
    return { data: model.file.slice(start, start + model.entry.compressedSize), deflated: model.entry.method !== METHOD_STORED };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Folders from the picker and from drag and drop
// ---------------------------------------------------------------------------

/** Files of a folder picked with <input webkitdirectory>, and the folder's name. */
export function entriesFromPicker(list: FileList): { name: string; entries: FolderEntry[] } {
  const files = Array.from(list);
  const first = files[0]?.webkitRelativePath ?? "";
  const name = first.includes("/") ? first.slice(0, first.indexOf("/")) : "Folder";
  return {
    name,
    // The relative path starts with the folder's own name, which is dropped.
    entries: files.map((file) => ({ file, path: file.webkitRelativePath.includes("/") ? file.webkitRelativePath.slice(file.webkitRelativePath.indexOf("/") + 1) : file.name })),
  };
}

/** Folders whose contents are not worth walking through. */
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", ".next", "__MACOSX"]);

function readAll(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    // A directory reader hands out its entries in batches until one comes back empty.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

async function walk(entry: FileSystemEntry, prefix: string, out: FolderEntry[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, path: prefix + entry.name });
  } else if (entry.isDirectory && !SKIPPED_FOLDERS.has(entry.name)) {
    for (const child of await readAll(entry as FileSystemDirectoryEntry)) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

/**
 * What was dropped. When folders are among it, they are walked and the result
 * is returned as `folder`; plain files come back as `files`.
 */
export async function entriesFromDrop(transfer: DataTransfer): Promise<{ files: File[]; folder: { name: string; entries: FolderEntry[] } | null }> {
  // The entries must be taken out before the first await: the transfer is cleared afterwards.
  const items = Array.from(transfer.items ?? []).filter((item) => item.kind === "file");
  const roots = items.map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null));
  const files = Array.from(transfer.files ?? []);
  const directories = roots.filter((root): root is FileSystemEntry => Boolean(root?.isDirectory));
  if (directories.length === 0) return { files, folder: null };

  const entries: FolderEntry[] = [];
  const single = directories.length === 1 && roots.filter(Boolean).length === 1;
  for (const root of roots) {
    if (!root) continue;
    if (root.isDirectory && single) {
      // One folder: paths are given from inside it, as the picker does.
      for (const child of await readAll(root as FileSystemDirectoryEntry)) await walk(child, "", entries);
    } else await walk(root, "", entries);
  }
  return { files: [], folder: { name: single ? directories[0].name : `${roots.filter(Boolean).length} dropped items`, entries } };
}
