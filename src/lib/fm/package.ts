// Workspace and change files: how a facility workspace moves between devices
// without a server. A workspace file holds everything (to back up, or to set
// up a phone for the field); a change file holds what was edited, verified,
// photographed or done on one device, to merge into the main workspace.
// Both are ZIP archives: bimos.json plus the photos.

import { entryDataOffset, readZipEntries, type ZipEntry } from "../ifc/zip-archive.mjs";
import { ZipWriter } from "../utils/zip-writer";
import type { Asset, Photo, WorkOrder, WorkspaceData } from "./types";

const MANIFEST = "bimos.json";
export const WORKSPACE_FORMAT = "bim-os-workspace";
export const CHANGES_FORMAT = "bim-os-changes";

type PhotoMeta = Omit<Photo, "blob">;

interface WorkspaceManifest {
  format: typeof WORKSPACE_FORMAT;
  version: 1;
  exportedAt: string;
  data: Omit<WorkspaceData, "photos"> & { photos: PhotoMeta[] };
}

export interface ChangesManifest {
  format: typeof CHANGES_FORMAT;
  version: 1;
  facilityId: string;
  facilityName: string;
  exportedAt: string;
  by: string;
  assets: Pick<Asset, "id" | "edits" | "verified" | "photos">[];
  workOrders: WorkOrder[];
  photos: PhotoMeta[];
}

const photoPath = (p: PhotoMeta) => `photos/${p.id}.${(p.type.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "")}`;

async function writeArchive(manifest: object, photos: Photo[]): Promise<Blob> {
  const zip = new ZipWriter();
  await zip.addBlob(MANIFEST, new Blob([JSON.stringify(manifest)], { type: "application/json" }));
  // Pictures are compressed already.
  for (const photo of photos) await zip.addBlob(photoPath(photo), photo.blob, false);
  return zip.finish();
}

export async function workspaceFile(data: WorkspaceData): Promise<Blob> {
  const manifest: WorkspaceManifest = {
    format: WORKSPACE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    data: { ...data, photos: data.photos.map(({ blob: _blob, ...meta }) => meta) },
  };
  return writeArchive(manifest, data.photos);
}

/** What changed on this device: assets edited, verified or photographed, and the work orders. */
export async function changesFile(data: WorkspaceData, by: string): Promise<{ blob: Blob; assets: number; workOrders: number; photos: number }> {
  const assets = data.assets.filter((a) => (a.edits && Object.keys(a.edits).length) || a.verified || a.photos?.length).map((a) => ({ id: a.id, edits: a.edits, verified: a.verified, photos: a.photos }));
  const photos = data.photos.filter((p) => assets.some((a) => a.photos?.includes(p.id)));
  const manifest: ChangesManifest = {
    format: CHANGES_FORMAT,
    version: 1,
    facilityId: data.facility.id,
    facilityName: data.facility.name,
    exportedAt: new Date().toISOString(),
    by,
    assets,
    workOrders: data.workOrders,
    photos: photos.map(({ blob: _blob, ...meta }) => meta),
  };
  return { blob: await writeArchive(manifest, photos), assets: assets.length, workOrders: data.workOrders.length, photos: photos.length };
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(file: Blob, entry: ZipEntry): Promise<Uint8Array> {
  const read = async (offset: number, length: number) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  const start = await entryDataOffset(read, entry, file.size);
  const raw = new Uint8Array(await file.slice(start, start + entry.compressedSize).arrayBuffer());
  return entry.method === 8 ? inflate(raw) : raw;
}

export type ReadPackage = { kind: "workspace"; data: WorkspaceData } | { kind: "changes"; changes: ChangesManifest; photos: Photo[] };

/** Reads a workspace or change file. */
export async function readPackage(file: Blob): Promise<ReadPackage> {
  const read = async (offset: number, length: number) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  let entries: ZipEntry[];
  try {
    entries = await readZipEntries(read, file.size);
  } catch {
    throw new Error("This is not a bim-os workspace or change file.");
  }
  const manifestEntry = entries.find((e) => e.name === MANIFEST);
  if (!manifestEntry) throw new Error("This archive has no bim-os data in it.");
  const manifest = JSON.parse(new TextDecoder().decode(await readEntry(file, manifestEntry))) as WorkspaceManifest | ChangesManifest;
  const byName = new Map(entries.map((e) => [e.name, e]));
  const photos = async (metas: PhotoMeta[]): Promise<Photo[]> => {
    const out: Photo[] = [];
    for (const meta of metas) {
      const entry = byName.get(photoPath(meta));
      if (!entry) continue;
      const bytes = await readEntry(file, entry);
      out.push({ ...meta, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: meta.type }) });
    }
    return out;
  };
  if (manifest.format === WORKSPACE_FORMAT) {
    const data = manifest.data;
    return { kind: "workspace", data: { ...data, photos: await photos(data.photos) } };
  }
  if (manifest.format === CHANGES_FORMAT) return { kind: "changes", changes: manifest, photos: await photos(manifest.photos) };
  throw new Error("This file was written by a newer or different program.");
}

/** "Harbour View Offices-assets-2026-03-14": a file name for an export, without its extension. */
export function fileStem(facilityName: string, suffix = ""): string {
  const base = (facilityName || "facility").replace(/[\\/:*?"<>|]+/g, "-").trim();
  const date = new Date().toISOString().slice(0, 10);
  return `${base}${suffix ? `-${suffix}` : ""}-${date}`;
}

/** File name of a workspace or change file. */
export function packageName(facilityName: string, suffix = ""): string {
  return `${fileStem(facilityName, suffix)}.bimos`;
}
