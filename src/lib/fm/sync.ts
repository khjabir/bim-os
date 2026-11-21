// Moving work between devices without a server: sharing this device's
// changes as a file, and bringing in a workspace or change file.

import { changesFile, packageName, readPackage, type ReadPackage } from "./package";
import { addPhotoRecords, mergeAssetChanges, mergeWorkOrders, replaceWorkspace, useFm, userName, workspaceData } from "./store";
import { workspaceFile } from "./package";

/** Shares (on phones) or downloads this device's changes. Returns what went into the file. */
export async function shareChanges(): Promise<{ assets: number; workOrders: number; photos: number; shared: boolean } | null> {
  const data = await workspaceData();
  if (!data) return null;
  const by = userName();
  const result = await changesFile(data, by);
  const name = packageName(data.facility.name, `changes-${by.replace(/[^\w-]+/g, "") || "device"}`);
  const shared = await shareOrDownload(result.blob, name);
  return { assets: result.assets, workOrders: result.workOrders, photos: result.photos, shared };
}

/** The whole workspace as one file (a backup, or to set up another device). */
export async function exportWorkspace(): Promise<boolean> {
  const data = await workspaceData();
  if (!data) return false;
  const blob = await workspaceFile(data);
  await shareOrDownload(blob, packageName(data.facility.name));
  return true;
}

async function shareOrDownload(blob: Blob, name: string): Promise<boolean> {
  const file = new File([blob], name, { type: "application/zip" });
  const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
  // Phones: the share sheet (mail, messaging, files); elsewhere a download.
  if (/Android|iPhone|iPad/i.test(navigator.userAgent) && nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return false;
}

export type ImportResult = { kind: "workspace"; facility: string; assets: number; current: string | null; apply: () => Promise<void> } | { kind: "changes"; text: string };

/**
 * Reads a file and either merges its changes straight away (a change file), or returns what a
 * workspace file holds, to be applied once the person confirms replacing the current workspace.
 */
export async function importFile(file: Blob): Promise<ImportResult> {
  const pkg: ReadPackage = await readPackage(file);
  if (pkg.kind === "workspace") {
    const current = useFm.getState().facility?.name ?? null;
    return {
      kind: "workspace",
      facility: pkg.data.facility.name,
      assets: pkg.data.assets.length,
      current,
      apply: () => replaceWorkspace(pkg.data),
    };
  }
  const facility = useFm.getState().facility;
  if (!facility) throw new Error("Open the workspace these changes belong to first (a workspace file), then bring the changes in.");
  const changes = pkg.changes;
  const other = changes.facilityId !== facility.id;
  await addPhotoRecords(pkg.photos);
  const assets = mergeAssetChanges(changes.assets);
  const workOrders = mergeWorkOrders(changes.workOrders);
  const parts = [`${assets} asset${assets === 1 ? "" : "s"} updated`, `${workOrders} work order${workOrders === 1 ? "" : "s"} added or updated`];
  if (pkg.photos.length) parts.push(`${pkg.photos.length} photo${pkg.photos.length === 1 ? "" : "s"}`);
  return { kind: "changes", text: `Changes from ${changes.by} (${changes.exportedAt.slice(0, 10)}): ${parts.join(", ")}.${other ? ` They were made in "${changes.facilityName}"; only assets with the same ids were updated.` : ""}` };
}
