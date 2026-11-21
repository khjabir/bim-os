// Opening a whole folder of models.
//
//   1. find the model files, also inside archives          (files.ts)
//   2. group them into models and pick one copy of each     (plan.mjs)
//   3. look into every model, off the main thread           (scan.worker.ts)
//   4. leave out models that only repeat others             (plan.mjs)
//   5. show the result and let the user adjust it           (FolderDialog)
//   6. convert the chosen models one after another, the largest first, and
//      show each when that leaves room for the conversions still to come

import type { PreparedModel, ViewerEngine } from "@/lib/engine/engine";
import { prepareModel } from "@/lib/engine/open-files";
import { pushToast, removeTask, uid, upsertTask } from "@/lib/store";
import { formatBytes, formatDuration } from "@/lib/utils/format";
import { findModelFiles, modelBytes, modelContentKind, modelFileName, type FolderEntry, type ModelFile } from "./files";
import { findRepeats, planModels, type PlannedModel } from "./plan.mjs";
import type { ScanJob, ScanResponse } from "./protocol";
import { useFolderStore, type FolderPlan, type PlanRow } from "./store";

/** Everything about the folder being planned that does not belong in the store. */
interface Session {
  engine: ViewerEngine;
  files: Map<string, { use: ModelFile; source: ModelFile | null }>;
  guids: Map<string, string[] | null>;
  worker: Worker | null;
}

let session: Session | null = null;

/** The order the other formats of a model are named in. */
const COPY_ORDER = [".ifc", ".ifczip", ".frag"];

// --- How much is shown while conversions are still to come ------------------
//
// Converting an IFC takes many times the memory of the model it produces. On
// the test project (ten models, 99 to 328 MB of IFC each) a conversion took
// 7 to 15 GB per GB of IFC, and the model it produced about 2 GB per GB of
// IFC once shown. So a conversion on top of a full scene is what runs a tab
// out of memory, and the order and timing of showing models decides the peak.

/** Memory a shown model takes, as a share of what converting it took. */
const LOADED_SHARE = 1 / 6;
/** From this much IFC on, a conversion is large enough for a model to wait for it. */
const LARGE_CONVERSION = 64 * 1024 * 1024;
/** How far above the unavoidable peak a conversion next to the shown models may get. */
const HEADROOM = 1.1;

/**
 * The order a folder's models are opened in: what needs converting first,
 * largest first, so that the largest conversions run while little is shown;
 * then the .frag files, which only need loading.
 */
function openingOrder(rows: PlanRow[]): PlanRow[] {
  return [...rows].sort((a, b) => Number(a.convertBytes === 0) - Number(b.convertBytes === 0) || b.convertBytes - a.convertBytes || b.size - a.size);
}

/**
 * The memory the folder needs whatever the timing, in bytes of IFC to
 * convert: the largest conversion on its own, the second largest next to the
 * first model, or all models shown.
 */
function unavoidablePeak(queue: PlanRow[]): number {
  const first = queue[0]?.convertBytes ?? 0;
  const second = queue[1]?.convertBytes ?? 0;
  const all = queue.reduce((sum, row) => sum + row.convertBytes, 0);
  return Math.max(first, LOADED_SHARE * first + second, LOADED_SHARE * all);
}

function update(change: (plan: FolderPlan) => FolderPlan) {
  useFolderStore.setState((state) => (state.plan ? { plan: change(state.plan) } : state));
}

function patchRow(key: string, patch: Partial<PlanRow>) {
  update((plan) => ({ ...plan, rows: plan.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) }));
}

/** Reads a folder and shows what would be opened. A folder with a single model is opened straight away. */
export async function planFolder(engine: ViewerEngine, entries: FolderEntry[], name: string) {
  closeFolderPlan();
  // Archives are looked into here, which takes a moment in a folder with many of them.
  const readingId = uid("task");
  upsertTask({ id: readingId, label: `Reading ${name}`, phase: `${entries.length} file${entries.length === 1 ? "" : "s"}` });
  let contents;
  try {
    contents = await findModelFiles(entries);
  } finally {
    removeTask(readingId);
  }
  if (engine.isDisposed) return;
  if (contents.models.length === 0) {
    const others = [contents.revit ? `${contents.revit} Revit` : "", contents.navisworks ? `${contents.navisworks} Navisworks` : ""].filter(Boolean).join(" and ");
    pushToast("error", `${name} holds no .ifc, .ifczip or .frag files.${others ? ` Its ${others} files open from their own viewers.` : ""}`);
    return;
  }

  const planned: PlannedModel[] = planModels(contents.models.map((model, ref) => ({ path: model.path, kind: model.kind, size: model.size, lastModified: model.lastModified, ref })));
  const files: Session["files"] = new Map();
  const rows: PlanRow[] = planned.map((model) => {
    const use = contents.models[model.use.ref];
    files.set(model.key, { use, source: model.source ? contents.models[model.source.ref] : null });
    return {
      key: model.key,
      name: modelFileName(use),
      folder: model.folder,
      kind: model.use.kind,
      size: model.use.size,
      convertBytes: modelContentKind(use) === "frag" ? 0 : (use.entry?.size ?? use.size),
      otherCopies: [...new Set(model.copies.filter((copy) => copy !== model.use).map((copy) => `.${copy.kind}`))].sort((a, b) => COPY_ORDER.indexOf(a) - COPY_ORDER.indexOf(b)),
      note: model.note,
      selected: true,
      touched: false,
      scan: "waiting",
      schema: "",
      elements: null,
      description: "",
      repeat: null,
    };
  });
  session = { engine, files, guids: new Map(), worker: null };

  if (rows.length === 1) {
    useFolderStore.setState({ plan: { name, rows, analysing: false, scannedBytes: 0, totalBytes: 0, revit: contents.revit, navisworks: contents.navisworks } });
    await openFolderPlan();
    return;
  }
  const totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
  useFolderStore.setState({ plan: { name, rows, analysing: true, scannedBytes: 0, totalBytes, revit: contents.revit, navisworks: contents.navisworks } });
  await analyse(session, rows);
}

/** Looks into every model and marks the ones that only repeat others. */
async function analyse(current: Session, rows: PlanRow[]) {
  const jobs: ScanJob[] = [];
  for (const row of rows) {
    const model = current.files.get(row.key)?.use;
    const bytes = model ? await modelBytes(model) : null;
    if (session !== current) return;
    if (!model || !bytes) {
      current.guids.set(row.key, null);
      patchRow(row.key, { scan: "skipped" });
      continue;
    }
    jobs.push({ key: row.key, kind: modelContentKind(model), data: bytes.data, deflated: bytes.deflated });
  }
  if (jobs.length === 0) {
    update((plan) => ({ ...plan, analysing: false }));
    return;
  }

  const worker = new Worker(new URL("./scan.worker.ts", import.meta.url), { type: "module" });
  current.worker = worker;
  const sizes = new Map(rows.map((row) => [row.key, row.size]));
  let finished = 0;
  const finish = (key: string) => {
    finished += sizes.get(key) ?? 0;
    update((plan) => ({ ...plan, scannedBytes: finished }));
  };
  worker.onmessage = (event: MessageEvent<ScanResponse>) => {
    if (session !== current) return;
    const message = event.data;
    if (message.type === "progress") {
      update((plan) => ({ ...plan, scannedBytes: Math.min(plan.totalBytes, finished + message.bytes) }));
    } else if (message.type === "scanned") {
      current.guids.set(message.key, message.scan.guids);
      patchRow(message.key, { scan: "done", schema: message.scan.schema, elements: message.scan.elements, description: message.scan.description });
      finish(message.key);
    } else if (message.type === "failed") {
      current.guids.set(message.key, null);
      patchRow(message.key, { scan: "failed" });
      finish(message.key);
    } else {
      worker.terminate();
      current.worker = null;
      applyRepeats(current);
    }
  };
  worker.onerror = () => {
    if (session !== current) return;
    worker.terminate();
    current.worker = null;
    update((plan) => ({ ...plan, analysing: false }));
  };
  worker.postMessage(jobs);
}

function applyRepeats(current: Session) {
  update((plan) => {
    const repeats = findRepeats(plan.rows.map((row) => ({ key: row.key, guids: current.guids.get(row.key) ?? null })));
    // Two models of the same name are told apart by their folder.
    const shared = new Set(plan.rows.map((row) => row.name).filter((name, index, all) => all.indexOf(name) !== index));
    const names = new Map(plan.rows.map((row) => [row.key, shared.has(row.name) && row.folder ? `${row.folder}/${row.name}` : row.name]));
    return {
      ...plan,
      analysing: false,
      scannedBytes: plan.totalBytes,
      rows: plan.rows.map((row) => {
        const repeat = repeats.get(row.key);
        if (!repeat) return row;
        return {
          ...row,
          repeat: { kind: repeat.kind, of: repeat.of.map((key) => names.get(key) ?? key), shared: repeat.shared, total: repeat.total },
          selected: row.touched ? row.selected : false,
        };
      }),
    };
  });
}

export function setRowSelected(key: string, selected: boolean) {
  patchRow(key, { selected, touched: true });
}

export function setAllSelected(selected: boolean) {
  update((plan) => ({ ...plan, rows: plan.rows.map((row) => ({ ...row, selected, touched: true })) }));
}

/** Closes the dialog without opening anything. */
export function closeFolderPlan() {
  session?.worker?.terminate();
  session = null;
  useFolderStore.setState({ plan: null });
}

/**
 * Opens the ticked models and closes the dialog.
 *
 * Models are converted one after another and shown as they are ready, as
 * long as that leaves room for the conversions still to come. A model that
 * would crowd a large conversion waits instead, as a small .frag in storage,
 * and is shown once that conversion is done. For models of falling size
 * nothing waits; for many large models of similar size the later ones do,
 * which keeps the peak near what the finished scene needs instead of a
 * conversion on top of nearly all of it.
 */
export async function openFolderPlan() {
  const plan = useFolderStore.getState().plan;
  const current = session;
  if (!plan || !current) return;
  current.worker?.terminate();
  current.worker = null;
  session = null;
  useFolderStore.setState({ plan: null });

  const { engine } = current;
  // The list keeps the order of the dialog, whatever order the models arrive in.
  const position = new Map(plan.rows.map((row, index) => [row.key, index]));
  const chosen = openingOrder(plan.rows.filter((row) => row.selected));
  if (chosen.length === 0) return;
  const totalBytes = chosen.reduce((sum, row) => sum + row.size, 0);
  const taskId = uid("task");
  const controller = new AbortController();
  const untrack = engine.trackTask(taskId, controller);
  const label = `Opening ${plan.name}`;
  const several = chosen.length > 1;
  const started = performance.now();
  let doneBytes = 0;
  let opened = 0;
  // Sizes are bytes of IFC converted, which is what the memory of a model goes by.
  const limit = unavoidablePeak(chosen) * HEADROOM;
  let shownBytes = 0;
  const waiting: { prepared: PreparedModel; bytes: number }[] = [];
  /** Shows the models that are converted but not yet in the scene. */
  const showWaiting = async () => {
    const batch = waiting.splice(0);
    for (const [index, model] of batch.entries()) {
      if (engine.isDisposed) return;
      // Showing cannot be stopped half-way, and the name of the last conversion no longer applies.
      if (batch.length > 1) upsertTask({ id: taskId, label, phase: `Showing model ${index + 1} of ${batch.length}`, detail: undefined, progress: totalBytes > 0 ? doneBytes / totalBytes : undefined, cancellable: false });
      if (await model.prepared.add()) {
        opened++;
        shownBytes += model.bytes;
      }
    }
  };
  // The view follows the models as they arrive, until the user moves it.
  engine.followModels(several);
  try {
    for (let i = 0; i < chosen.length; i++) {
      if (controller.signal.aborted || engine.isDisposed) break;
      const row = chosen[i];
      const file = current.files.get(row.key);
      if (!file) continue;
      if (several) {
        const held = waiting.length > 0 ? ` · ${waiting.length} converted, shown when this one is done` : "";
        upsertTask({ id: taskId, label, phase: `Model ${i + 1} of ${chosen.length}${held}`, detail: row.name, progress: totalBytes > 0 ? doneBytes / totalBytes : undefined, cancellable: true });
      }
      const prepared = await prepareModel(engine, file.use, {
        collection: several ? plan.name : undefined,
        order: position.get(row.key),
        folder: row.folder,
        description: row.description || undefined,
        note: row.note || undefined,
        sourceFile: file.source?.file,
        signal: controller.signal,
      });
      doneBytes += row.size;
      if (prepared === "cancelled") break;
      if (!prepared) continue;
      waiting.push({ prepared, bytes: row.convertBytes });
      // With something on screen already, a model waits when showing it would crowd the next large conversion.
      const next = chosen[i + 1];
      if (opened > 0 && next && next.convertBytes >= LARGE_CONVERSION) {
        const converted = shownBytes + waiting.reduce((sum, model) => sum + model.bytes, 0);
        if (LOADED_SHARE * converted + next.convertBytes > limit) continue;
      }
      await showWaiting();
    }
    // Also after a stop: what is converted is shown.
    await showWaiting();
  } finally {
    engine.followModels(false);
    untrack();
    removeTask(taskId);
  }
  if (several && opened > 0) {
    const stopped = controller.signal.aborted ? " before it was stopped" : "";
    pushToast(opened === chosen.length ? "success" : "info", `${plan.name}: ${opened} of ${chosen.length} models opened in ${formatDuration(performance.now() - started)}${stopped} (${formatBytes(totalBytes)} of files).`, 9000);
  }
}
