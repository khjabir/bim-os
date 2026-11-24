// Conversion worker: holds the extracted models, analyses them and writes the
// IFC files, so the Convert page stays responsive on models with hundreds of
// thousands of elements.

import { Converter } from "./assemble";
import { inflateIfNeeded, parseJob, parseProps, readExtractorFiles, type RawSourceJob } from "./bundle";
import { previewTransfer, type PreviewData } from "./preview";
import { summarise, type AssetOptions } from "./assets/register";
import type { WorkbookSettings } from "./assets/workbook";
import { workspaceFromRegister } from "./assets/workspace";
import type { IfcSourceInfo } from "./ifc-source";
import type { ConvertOptions } from "./types";
import { announceReady } from "@/lib/utils/worker-ready";

export type WorkerRequest =
  | { id: number; type: "addFiles"; files: { name: string; blob: Blob }[] }
  | { id: number; type: "addJobs"; jobs: { name: string; bin: Blob; props: Blob | null; textures?: (Blob | null)[] }[] }
  /** IFC files read for their assets, rooms and systems (web-ifc in this worker). */
  | { id: number; type: "addIfc"; files: { name: string; blob: Blob }[]; wasmPath: string }
  | { id: number; type: "remove"; jobs: string[] }
  | { id: number; type: "clear" }
  | { id: number; type: "storeys"; partIds: string[] }
  | { id: number; type: "frame"; options: Pick<ConvertOptions, "frame">; partIds: string[] }
  | { id: number; type: "generate"; options: ConvertOptions }
  | { id: number; type: "preview"; options: ConvertOptions; budget: number }
  | { id: number; type: "assets"; options: ConvertOptions; assets: AssetOptions }
  | { id: number; type: "assetFiles"; options: ConvertOptions; assets: AssetOptions; contact: Pick<WorkbookSettings, "contactEmail" | "contactCompany" | "contactPhone" | "currency"> }
  /** The register as a facility workspace (assets, rooms, systems). */
  | { id: number; type: "workspace"; options: ConvertOptions; assets: AssetOptions }
  | { id: number; type: "cancel" };

const converter = new Converter();

function post(message: unknown, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(message, transfer);
}

function state() {
  return { parts: converter.summaries(), jobs: converter.jobSummaries() };
}

async function handle(request: WorkerRequest) {
  const progress = (phase: string, done: number, total: number) => post({ id: request.id, type: "progress", phase, done, total });
  switch (request.type) {
    case "addFiles": {
      const files = [];
      for (const f of request.files) files.push({ name: f.name, bytes: new Uint8Array(await f.blob.arrayBuffer()) });
      const { jobs, ignored } = await readExtractorFiles(files, (name) => progress(`Reading ${name}`, 0, 0));
      const added = converter.addJobs(jobs, progress);
      return { ...state(), added, ignored };
    }
    case "addJobs": {
      const raw: RawSourceJob[] = [];
      for (const job of request.jobs) {
        progress(`Reading ${job.name}`, 0, 0);
        const data = parseJob(await inflateIfNeeded(new Uint8Array(await job.bin.arrayBuffer())));
        const props = job.props ? parseProps(new TextDecoder().decode(await inflateIfNeeded(new Uint8Array(await job.props.arrayBuffer())))) : null;
        const textures: (Uint8Array | null)[] = [];
        for (const texture of job.textures ?? []) textures.push(texture ? new Uint8Array(await texture.arrayBuffer()) : null);
        raw.push({ name: job.name, data, props, textures });
      }
      const added = converter.addJobs(raw, progress);
      return { ...state(), added, ignored: [] };
    }
    case "addIfc": {
      // web-ifc is loaded only when an IFC file is read.
      const { readIfcFile } = await import("./ifc-source");
      const raw: RawSourceJob[] = [];
      const infos: IfcSourceInfo[] = [];
      for (const f of request.files) {
        let name = f.name.replace(/\.(ifc|ifczip)$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 60) || "ifc";
        for (let n = 2; converter.jobs.has(name) || raw.some((r) => r.name === name); n++) name = `${name.replace(/-\d+$/, "")}-${n}`;
        const { job, info } = await readIfcFile(f.blob, f.name, name, request.wasmPath, progress);
        raw.push(job);
        infos.push(info);
      }
      const added = converter.addJobs(raw, progress);
      added.forEach((name, i) => (infos[i].job = name));
      return { ...state(), added, ignored: [], ifc: infos };
    }
    case "remove":
      for (const name of request.jobs) converter.removeJob(name);
      return state();
    case "clear":
      converter.clear();
      return state();
    case "storeys":
      return { storeys: converter.detectStoreys(request.partIds) };
    case "frame":
      return converter.resolveFrame(request.options, request.partIds);
    case "generate": {
      const { files, report } = await converter.generate(request.options, progress);
      return { files, report };
    }
    case "preview":
      progress("Preparing the preview", 0, 0);
      return converter.preview(request.options, request.budget);
    case "assets":
      return summarise(converter.assetRegister(request.options, request.assets, progress));
    case "assetFiles": {
      const { register, cobie, workbook, sld } = await converter.assetWorkbooks(request.options, request.assets, request.contact, progress);
      return { summary: summarise(register), cobie, workbook, sld };
    }
    case "workspace": {
      const register = converter.assetRegister(request.options, request.assets, progress);
      progress("Preparing the workspace", 0, 0);
      return { summary: summarise(register), ...workspaceFromRegister(register) };
    }
    case "cancel":
      converter.cancelled = true;
      return { cancelled: true };
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  handle(request).then(
    (result) => post({ id: request.id, type: "result", result }, request.type === "preview" ? previewTransfer(result as PreviewData) : []),
    (error: unknown) => post({ id: request.id, type: "error", message: error instanceof Error ? error.message : String(error) }),
  );
});

announceReady("convert");
