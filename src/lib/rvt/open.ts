// Opens Revit files in the RVT viewer: converts them to IFC (in the browser
// with rvt-rs, or through Autodesk's cloud) and loads the result into the
// same engine the IFC viewer uses.

import { ApsCancelled, deleteFromAps, downloadDerivative, progressFraction, startTranslation, uploadToAps, waitForTranslation } from "@/lib/aps/client";
import type { ViewerEngine } from "@/lib/engine/engine";
import { openModelFiles } from "@/lib/engine/open-files";
import { pushToast, removeTask, uid, upsertTask } from "@/lib/store";
import { baseName, formatBytes } from "@/lib/utils/format";
import { convertRvtLocal, RvtCancelled, RvtReadError } from "./local";
import { addConversion, updateConversion, useRvtStore, type RvtEngine } from "./store";

export const RVT_ACCEPT = ".rvt,.rfa,.rte,.ifc,.ifczip,.zip,.frag";

const REVIT_EXTENSIONS = new Set(["rvt", "rfa", "rte", "rft"]);

function extension(name: string) {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

/** File handler of the RVT viewer: Revit files are converted, IFC, ifcZIP and .frag files open directly. */
export function openRvtFiles(engine: ViewerEngine, files: File[]) {
  void (async () => {
    for (const file of files) {
      const kind = extension(file.name);
      if (REVIT_EXTENSIONS.has(kind)) await convertAndLoad(engine, file);
      else if (kind === "nwd" || kind === "nwc") pushToast("info", `${file.name}: open Navisworks files from the NWD viewer.`);
      else await openModelFiles(engine, [file]);
    }
  })();
}

export interface ConvertOverrides {
  engine?: RvtEngine;
  phase?: string | number | null;
  /** A model to close once the new conversion has loaded (re-reading the same file). */
  replaceModelId?: string | null;
}

/** Converts one Revit file with the engine chosen in the import panel and loads the result. */
export async function convertAndLoad(viewer: ViewerEngine, file: File, overrides: ConvertOverrides = {}): Promise<string | null> {
  const settings = useRvtStore.getState();
  const engine = overrides.engine ?? settings.engine;
  const id = uid("rvt");
  const taskId = uid("task");
  const controller = new AbortController();
  const untrack = viewer.trackTask(taskId, controller);
  const started = performance.now();
  const label = engine === "local" ? `Reading ${file.name}` : `Converting ${file.name} with Autodesk`;
  const step = (text: string, progress?: number) => {
    upsertTask({ id: taskId, label, phase: text, progress, cancellable: true });
    updateConversion(id, { step: text });
  };

  addConversion({ id, fileName: file.name, fileBytes: file.size, engine, status: "running", modelId: null, file, phase: overrides.phase ?? null, exportSetup: engine === "cloud" ? settings.exportSetup : undefined });
  upsertTask({ id: taskId, label, phase: "Starting", progress: undefined, cancellable: true });

  let ifc: Blob;
  let note: string;
  try {
    if (engine === "local") {
      const result = await convertRvtLocal(file, file.name, { largeModel: settings.largeModel, savedMeshes: settings.savedMeshes, phase: overrides.phase ?? null }, step, controller.signal);
      updateConversion(id, { report: result.report, phases: result.phases, metadata: result.metadata, ifcBytes: result.stats.ifcBytes });
      if (result.report.withGeometry === 0 && result.report.carriedByParts === 0) {
        updateConversion(id, {
          status: "failed",
          elapsedMs: performance.now() - started,
          error:
            result.report.elements === 0
              ? "The in-browser reader opened the file but could not recover any building elements from it."
              : "The in-browser reader recovered elements but no geometry for them, so there is nothing to show in 3D.",
        });
        pushToast("error", `${file.name}: no geometry could be recovered in the browser. Try the Autodesk cloud engine.`);
        return null;
      }
      ifc = result.ifc;
      note = `Read in the browser with rvt-rs${result.report.release ? ` · Revit ${result.report.release}` : ""}`;
    } else {
      step("Uploading to Autodesk", 0);
      const urn = await uploadToAps(file, file.name, (fraction) => step(`Uploading to Autodesk · ${formatBytes(Math.round(fraction * file.size))} of ${formatBytes(file.size)}`, fraction * 0.35), controller.signal);
      try {
        step("Starting the IFC export", 0.35);
        await startTranslation(urn, { output: "ifc", exportSettingName: settings.exportSetup.trim() || undefined }, controller.signal);
        const status = await waitForTranslation(
          urn,
          "ifc",
          (current) => step(`Autodesk is exporting IFC · ${current.progress || current.status}`, 0.35 + 0.5 * (progressFraction(current.progress) ?? 0)),
          controller.signal,
        );
        updateConversion(id, { cloudMessages: status.messages });
        step("Downloading the IFC", 0.85);
        ifc = await downloadDerivative(
          urn,
          status.ifcDerivativeUrn ?? "",
          (loaded, total) => step(`Downloading the IFC · ${formatBytes(loaded)}`, total ? 0.85 + 0.15 * (loaded / total) : undefined),
          controller.signal,
        );
        updateConversion(id, { ifcBytes: ifc.size });
      } finally {
        // Also on failure or cancel: do not leave the upload behind unless asked to.
        if (settings.deleteCloudCopy) void deleteFromAps(urn);
      }
      note = `Converted by Autodesk${settings.exportSetup.trim() ? ` · ${settings.exportSetup.trim()}` : ""}`;
    }
  } catch (error) {
    const elapsedMs = performance.now() - started;
    if (error instanceof RvtCancelled || error instanceof ApsCancelled) {
      updateConversion(id, { status: "cancelled", elapsedMs, step: undefined });
      pushToast("info", `Cancelled ${file.name}.`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to convert ${file.name}`, error);
      updateConversion(id, {
        status: "failed",
        elapsedMs,
        step: undefined,
        error: message,
        outOfMemory: error instanceof RvtReadError ? error.outOfMemory : false,
        metadata: error instanceof RvtReadError ? error.metadata : undefined,
      });
      pushToast("error", `${file.name}: ${message}`);
    }
    return null;
  } finally {
    untrack();
    removeTask(taskId);
  }

  if (viewer.isDisposed) return null;
  const ifcFile = new File([ifc], `${baseName(file.name)}.ifc`, { type: "application/x-step" });
  const modelId = await viewer.loadIfc(ifcFile, file.name, { source: "rvt", note });
  updateConversion(id, { status: modelId ? "done" : "failed", modelId, elapsedMs: performance.now() - started, step: undefined, error: modelId ? undefined : "The converted IFC could not be loaded into the viewer." });
  if (modelId && overrides.replaceModelId && overrides.replaceModelId !== modelId) await viewer.removeModel(overrides.replaceModelId);
  return modelId;
}
