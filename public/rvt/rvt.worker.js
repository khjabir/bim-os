// Converts a Revit file to IFC4 inside the browser with rvt-rs (WebAssembly).
//
// This is a plain module worker served from /public so the bundler never
// touches the wasm-bindgen output next to it. One worker handles one file and
// is terminated afterwards, which is the only way to give the WebAssembly
// heap back to the browser.
//
// in : { type: "convert", file: Blob, name: string, options?: { largeModel?, savedMeshes?, phase? } }
// out: { type: "progress", label, fraction? }
//      { type: "metadata", metadata }
//      { type: "done", ifc: Blob, report, phases, stats }
//      { type: "error", message, outOfMemory }

import init, { fileMetadata, modelToIfcStep, openRvtBytesWithDiagnosticsModeAndOpenLimits } from "./rvt.js";

const STAGES = {
  "schema-parse": "Reading the file's schema",
  "candidate-scan": "Scanning for elements",
  "element-decode": "Decoding elements",
  "partition-scan": "Reading element records",
  "saved-graphics": "Reading saved graphics",
  "saved-meshes": "Reading saved meshes",
};

// rvt-rs reports a Rust panic on console.error before the wasm trap, and the
// trap itself only says "unreachable": keep the panic's own message.
let lastPanic = null;
const consoleError = console.error.bind(console);
console.error = (...args) => {
  const text = args.map(String).join(" ");
  if (text.includes("rvt-rs wasm panic")) lastPanic = text.replace(/^.*?rvt-rs wasm panic:\s*/, "");
  consoleError(...args);
};

/** serde-wasm-bindgen hands maps over as Map objects; flatten them so they post as JSON. */
function plain(value) {
  if (value instanceof Map) {
    const object = {};
    for (const [key, entry] of value) object[String(key)] = plain(entry);
    return object;
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = {};
    for (const [key, entry] of Object.entries(value)) object[key] = plain(entry);
    return object;
  }
  return value;
}

function outOfMemory(error, panic) {
  const text = `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)} ${panic ?? ""}`.toLowerCase();
  return /out of memory|memory allocation of|maximum memory size|memory\.grow|allocation failed|capacity overflow|array buffer allocation|invalid array length/.test(text);
}

function report(diagnostics) {
  const { input = {}, exported = {}, decoded = {}, confidence = {}, source_coverage: coverage } = diagnostics;
  return {
    release: input.revit_version ?? null,
    build: input.build ?? null,
    projectName: input.project_name ?? null,
    releaseSupport: input.release_support?.status ?? null,
    confidence: { level: confidence.level ?? null, hasGeometry: Boolean(confidence.has_geometry), hasTypedElements: Boolean(confidence.has_typed_elements) },
    elements: exported.building_elements ?? 0,
    withGeometry: exported.building_elements_with_geometry ?? 0,
    carriedByParts: exported.building_elements_carried_by_parts ?? 0,
    boundingBoxBodies: exported.bounding_box_bodies ?? 0,
    byIfcType: exported.by_ifc_type ?? {},
    bodySources: exported.body_sources ?? {},
    storeys: exported.storey_names ?? [],
    materials: exported.material_count ?? 0,
    decodedRecords: decoded.production_walker_elements ?? 0,
    skipped: (diagnostics.skipped ?? []).map((item) => ({ reason: item.reason, count: item.count, classes: item.classes ?? {}, samples: (item.sample_names ?? []).slice(0, 8), phase: item.phase ?? null })),
    unsupported: diagnostics.unsupported_features ?? [],
    warnings: diagnostics.warnings ?? [],
    coverage: coverage
      ? { status: coverage.status ?? null, exported: coverage.exported_element_fraction ?? null, geometry: coverage.geometry_element_fraction ?? null }
      : null,
  };
}

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || message.type !== "convert") return;
  const progress = (label, fraction) => self.postMessage({ type: "progress", label, fraction });
  let wasm = null;
  try {
    progress("Starting the Revit reader");
    const started = performance.now();
    wasm = await init();

    progress("Reading the file");
    const bytes = new Uint8Array(await message.file.arrayBuffer());

    // Identity is cheap and useful even when the full read fails.
    try {
      self.postMessage({ type: "metadata", metadata: plain(fileMetadata(bytes)) });
    } catch {
      lastPanic = null;
    }

    const options = message.options ?? {};
    const limits = {};
    if (options.largeModel) limits.largeModel = true;
    if (options.savedMeshes === false) limits.savedMeshes = false;
    if (options.phase !== undefined && options.phase !== null && options.phase !== "") limits.phase = options.phase;

    progress("Opening the Revit file");
    lastPanic = null;
    const openStarted = performance.now();
    const result = openRvtBytesWithDiagnosticsModeAndOpenLimits(bytes, "scaffold", Object.keys(limits).length > 0 ? limits : null, (stage, done, total) => {
      progress(STAGES[stage] ?? stage, typeof total === "number" && total > 0 ? Math.min(1, done / total) : undefined);
    });
    const openMs = performance.now() - openStarted;

    progress("Writing IFC");
    const stepStarted = performance.now();
    const step = modelToIfcStep(result.model);
    const ifc = new Blob([step], { type: "application/x-step" });

    self.postMessage({
      type: "done",
      ifc,
      report: report(plain(result.diagnostics)),
      phases: plain(result.phases ?? []),
      stats: {
        openMs,
        stepMs: performance.now() - stepStarted,
        totalMs: performance.now() - started,
        wasmMemoryBytes: wasm.memory.buffer.byteLength,
        ifcBytes: ifc.size,
      },
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    self.postMessage({ type: "error", message: lastPanic ?? text, outOfMemory: outOfMemory(error, lastPanic) });
  }
});
