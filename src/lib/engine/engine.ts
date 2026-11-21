// The 3D engine behind the IFC and RVT workbenches.
//
// It wraps That Open Engine (components, components-front, fragments) behind a
// small imperative API and mirrors the UI-relevant state into the zustand
// store. React components never touch three.js or OBC objects directly.

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";
import { combineFragments } from "@/lib/fragments/pack";
import { convertIfc, extractIfc, JobCancelled, type JobProgress } from "@/lib/ifc/client";
import {
  pushToast,
  removeTask,
  resetViewerStore,
  uid,
  upsertTask,
  useViewerStore,
  type ModelInfo,
  type ModelSource,
  type NavMode,
  type PlainIdMap,
  type Projection,
  type RenderStyle,
  type ToolId,
} from "@/lib/store";
import { baseName, formatBytes, formatCount, formatDuration, sanitizeFileName } from "@/lib/utils/format";
import { downloadBlob } from "@/lib/utils/download";
import { ZipWriter } from "@/lib/utils/zip-writer";
import { disposeModelIndex } from "@/lib/data/model-index";

export type IdMap = OBC.ModelIdMap;

type World = OBC.SimpleWorld<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBF.PostproductionRenderer>;
type MeasureTool = "length" | "area" | "angle" | "volume";
export type ViewOrientation = "front" | "back" | "left" | "right" | "top" | "bottom";

const SELECT = "select";
const FRAGMENTS_WORKER_URL = "/fragments/worker.mjs";

const PHASE_LABEL: Record<JobProgress["phase"], string> = {
  reading: "Reading file",
  geometry: "Building geometry",
  properties: "Reading properties",
  relations: "Linking relations",
  packing: "Packing fragments",
  extract: "Writing IFC",
};

/** A model that is ready to be shown but is not in the scene yet. */
export interface PreparedModel {
  /** Puts the model in the scene. Gives its id, or null when that failed; the reason is then shown as a message. */
  add(): Promise<string | null>;
}

export interface AddModelOptions {
  name: string;
  source: ModelSource;
  /** Original IFC kept in memory to allow IFC subset export. */
  sourceFile?: Blob;
  sourceBytes?: number;
  convertMs?: number;
  leftOutGeometry?: number;
  note?: string;
  collection?: string;
  order?: number;
  folder?: string;
  description?: string;
}

export function toIdMap(map: PlainIdMap | IdMap): IdMap {
  const result: IdMap = {};
  for (const [modelId, ids] of Object.entries(map)) {
    if (!ids) continue;
    const set = ids instanceof Set ? ids : new Set(ids);
    if (set.size > 0) result[modelId] = set;
  }
  return result;
}

export function toPlainMap(map: IdMap | PlainIdMap): PlainIdMap {
  const result: PlainIdMap = {};
  for (const [modelId, ids] of Object.entries(map)) {
    if (!ids) continue;
    const list = ids instanceof Set ? [...ids] : ids;
    if (list.length > 0) result[modelId] = list;
  }
  return result;
}

export function countIds(map: IdMap | PlainIdMap): number {
  let total = 0;
  for (const ids of Object.values(map)) {
    if (!ids) continue;
    total += ids instanceof Set ? ids.size : ids.length;
  }
  return total;
}

export class ViewerEngine {
  readonly container: HTMLElement;
  readonly components: OBC.Components;
  readonly world: World;
  readonly fragments: OBC.FragmentsManager;
  readonly highlighter: OBF.Highlighter;
  readonly hoverer: OBF.Hoverer;
  readonly hider: OBC.Hider;
  readonly boxer: OBC.BoundingBoxer;
  readonly clipper: OBC.Clipper;
  readonly views: OBC.Views;
  readonly grid: OBC.SimpleGrid;
  readonly measurers: Record<MeasureTool, OBF.LengthMeasurement | OBF.AreaMeasurement | OBF.AngleMeasurement | OBF.VolumeMeasurement>;

  /** Original IFC per model id (enables "export selection as IFC"). */
  private readonly sources = new Map<string, Blob>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly cleanups: (() => void)[] = [];
  private selectionSyncQueued = false;
  private disposed = false;
  /** True while newly arriving models are framed together with the ones already shown. */
  private following = false;

  static async create(container: HTMLElement): Promise<ViewerEngine> {
    resetViewerStore();
    const engine = new ViewerEngine(container);
    await engine.world.camera.controls.setLookAt(24, 16, 24, 0, 2, 0, false);
    useViewerStore.setState({ ready: true });
    return engine;
  }

  private constructor(container: HTMLElement) {
    this.container = container;
    const components = new OBC.Components();
    this.components = components;

    const world = components.get(OBC.Worlds).create<
      OBC.SimpleScene,
      OBC.OrthoPerspectiveCamera,
      OBF.PostproductionRenderer
    >();
    world.scene = new OBC.SimpleScene(components);
    world.scene.setup();
    world.scene.three.background = null;
    world.renderer = new OBF.PostproductionRenderer(components, container);
    // The header credits That Open Engine; the in-canvas mark would sit under the toolbar.
    world.renderer.showLogo = false;
    world.camera = new OBC.OrthoPerspectiveCamera(components);
    world.camera.controls.dollyToCursor = true;
    world.camera.controls.restThreshold = 0.05;
    components.init();
    this.world = world;

    this.grid = components.get(OBC.Grids).create(world);
    this.grid.config.color.set(0x8a93a3);

    // --- Fragments -----------------------------------------------------
    const fragments = components.get(OBC.FragmentsManager);
    fragments.init(FRAGMENTS_WORKER_URL);
    this.fragments = fragments;

    const controls = world.camera.controls;
    const onCameraUpdate = () => void fragments.core.update();
    const onCameraRest = () => void fragments.core.update(true);
    // "controlstart" fires for the user's own orbiting, panning and zooming, not for views set in code.
    const onUserMove = () => {
      this.following = false;
    };
    controls.addEventListener("update", onCameraUpdate);
    controls.addEventListener("rest", onCameraRest);
    controls.addEventListener("controlstart", onUserMove);
    this.cleanups.push(() => {
      controls.removeEventListener("update", onCameraUpdate);
      controls.removeEventListener("rest", onCameraRest);
      controls.removeEventListener("controlstart", onUserMove);
    });

    // Plan views swap the world camera; every model must cull against it.
    world.onCameraChanged.add((camera) => {
      for (const [, model] of fragments.list) model.useCamera(camera.three);
      void fragments.core.update(true);
    });

    fragments.list.onItemSet.add(({ value: model }) => {
      model.useCamera(world.camera.three);
      world.scene.three.add(model.object);
      model.getClippingPlanesEvent = () => Array.from(world.renderer?.three.clippingPlanes ?? []);
      void fragments.core.update(true);
    });

    // Avoid z-fighting between coplanar faces of different materials.
    fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
      if (!("isLodMaterial" in material && material.isLodMaterial)) {
        material.polygonOffset = true;
        material.polygonOffsetUnits = 1;
        material.polygonOffsetFactor = Math.random();
      }
    });

    // --- Selection -----------------------------------------------------
    components.get(OBC.Raycasters).get(world);
    const highlighter = components.get(OBF.Highlighter);
    highlighter.setup({
      world,
      selectMaterialDefinition: {
        color: new THREE.Color("#2f7df6"),
        opacity: 1,
        transparent: false,
        renderedFaces: FRAGS.RenderedFaces.ONE,
      },
    });
    highlighter.multiple = "ctrlKey";
    highlighter.zoomToSelection = false;
    highlighter.events[SELECT].onHighlight.add(() => this.queueSelectionSync());
    highlighter.events[SELECT].onClear.add(() => this.queueSelectionSync());
    this.highlighter = highlighter;

    const hoverer = components.get(OBF.Hoverer);
    hoverer.world = world;
    hoverer.material = new THREE.MeshBasicMaterial({
      color: 0x2f7df6,
      transparent: true,
      opacity: 0.35,
      depthTest: false,
    });
    hoverer.enabled = true;
    this.hoverer = hoverer;

    this.hider = components.get(OBC.Hider);
    this.boxer = components.get(OBC.BoundingBoxer);

    // --- Section planes ------------------------------------------------
    const clipper = components.get(OBC.Clipper);
    clipper.enabled = false;
    clipper.onAfterCreate.add(() => this.syncPlanes());
    clipper.onAfterDelete.add(() => this.syncPlanes());
    this.clipper = clipper;

    this.views = components.get(OBC.Views);
    this.views.world = world;

    // --- Measurements --------------------------------------------------
    const color = new THREE.Color("#e8590c");
    const length = components.get(OBF.LengthMeasurement);
    const area = components.get(OBF.AreaMeasurement);
    const angle = components.get(OBF.AngleMeasurement);
    const volume = components.get(OBF.VolumeMeasurement);
    length.snappings = [FRAGS.SnappingClass.POINT, FRAGS.SnappingClass.LINE];
    area.snappings = [FRAGS.SnappingClass.POINT];
    angle.snappings = [FRAGS.SnappingClass.POINT];
    this.measurers = { length, area, angle, volume };
    for (const measurer of Object.values(this.measurers)) {
      measurer.world = world;
      measurer.color = color;
      measurer.enabled = false;
      measurer.list.onItemAdded.add(() => this.syncMeasurements());
      measurer.list.onItemDeleted.add(() => this.syncMeasurements());
      measurer.list.onCleared.add(() => this.syncMeasurements());
    }

    // --- DOM events ----------------------------------------------------
    const onDoubleClick = () => {
      const tool = useViewerStore.getState().tool;
      if (tool === "section") void this.clipper.create(this.world);
      else if (tool in this.measurers) this.measurers[tool as MeasureTool].create();
    };
    container.addEventListener("dblclick", onDoubleClick);
    this.cleanups.push(() => container.removeEventListener("dblclick", onDoubleClick));

    const resizeObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      world.renderer?.resize();
      world.camera.updateAspect();
    });
    resizeObserver.observe(container);
    this.cleanups.push(() => resizeObserver.disconnect());

    world.camera.projection.onChanged.add(() => {
      const projection = world.camera.projection.current as Projection;
      this.grid.fade = projection === "Perspective";
      useViewerStore.setState({ projection });
    });
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.aborts.values()) controller.abort();
    this.aborts.clear();
    for (const cleanup of this.cleanups) {
      try {
        cleanup();
      } catch {
        /* best effort */
      }
    }
    for (const modelId of this.fragments.list.keys()) disposeModelIndex(modelId);
    this.sources.clear();
    try {
      this.components.dispose();
    } catch (error) {
      console.warn("Engine disposal reported an error", error);
    }
    resetViewerStore();
  }

  get isDisposed() {
    return this.disposed;
  }

  // ---------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------

  getModel(modelId: string): FRAGS.FragmentsModel | undefined {
    return this.fragments.list.get(modelId);
  }

  get models(): FRAGS.FragmentsModel[] {
    return [...this.fragments.list.values()];
  }

  getSourceIfc(modelId: string): Blob | undefined {
    return this.sources.get(modelId);
  }

  private uniqueModelId(name: string): string {
    const base = sanitizeFileName(baseName(name)) || "model";
    let candidate = base;
    let index = 2;
    while (this.fragments.list.has(candidate)) candidate = `${base} (${index++})`;
    return candidate;
  }

  /** Converts an IFC in a worker and adds the result to the scene. */
  async loadIfc(file: Blob, name: string, options: Partial<AddModelOptions> & { signal?: AbortSignal } = {}): Promise<string | null> {
    const prepared = await this.convertIfcModel(file, name, options);
    return prepared ? prepared.add() : null;
  }

  /**
   * Converts an IFC in a worker without showing it: `add()` of the result
   * puts it in the scene, at once or later. Opening a folder uses this to get
   * its large conversions done before the scene fills up, because a conversion
   * needs far more memory than the model it produces.
   */
  async convertIfcModel(file: Blob, name: string, options: Partial<AddModelOptions> & { signal?: AbortSignal } = {}): Promise<PreparedModel | null> {
    const taskId = uid("task");
    const controller = new AbortController();
    // A caller that opens several models can stop this one along with the rest.
    const stop = () => controller.abort();
    if (options.signal?.aborted) return null;
    options.signal?.addEventListener("abort", stop);
    this.aborts.set(taskId, controller);
    const label = `Converting ${name}`;
    upsertTask({ id: taskId, label, phase: PHASE_LABEL.reading, progress: 0, cancellable: true });
    try {
      const { bytes, stats } = await convertIfc(
        file,
        (progress) => {
          // Reading is the first ~30 % of the job; the importer's own 0..1 covers the rest.
          const overall = progress.phase === "reading" ? progress.progress * 0.3 : 0.3 + progress.progress * 0.7;
          upsertTask({
            id: taskId,
            label,
            phase: PHASE_LABEL[progress.phase],
            progress: overall,
            detail: progress.detail,
            cancellable: true,
          });
        },
        controller.signal,
      );
      if (this.disposed) return null;
      const leftOut =
        stats.leftOutGeometry > 0
          ? ` ${formatCount(stats.leftOutGeometry)} piece${stats.leftOutGeometry === 1 ? "" : "s"} of geometry could not be turned into surfaces and ${stats.leftOutGeometry === 1 ? "is" : "are"} left out.`
          : "";
      pushToast(
        stats.leftOutGeometry > 0 ? "info" : "success",
        `${name}: ${formatBytes(stats.sourceBytes)} converted to ${formatBytes(stats.fragmentBytes)} of Fragments in ${formatDuration(stats.elapsedMs)}.${leftOut}`,
        stats.leftOutGeometry > 0 ? 12000 : undefined,
      );
      // Kept as a Blob, the converted model is out of the page's own memory while it waits.
      const converted = new Blob([bytes as Uint8Array<ArrayBuffer>]);
      return {
        add: async () => {
          const addId = uid("task");
          upsertTask({ id: addId, label: `Loading ${name}`, phase: "Building scene" });
          try {
            const data = new Uint8Array(await converted.arrayBuffer());
            if (this.disposed) return null;
            return await this.addFragments(data, {
              name,
              source: options.source ?? "ifc",
              sourceFile: file,
              sourceBytes: file.size,
              convertMs: stats.elapsedMs,
              leftOutGeometry: stats.leftOutGeometry || undefined,
              note: options.note,
              collection: options.collection,
              order: options.order,
              folder: options.folder,
              description: options.description,
            });
          } catch (error) {
            console.warn(`Failed to load ${name}`, error);
            pushToast("error", `${name}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          } finally {
            removeTask(addId);
          }
        },
      };
    } catch (error) {
      if (error instanceof JobCancelled) pushToast("info", `Cancelled ${name}.`);
      else {
        console.warn(`Failed to load ${name}`, error);
        pushToast("error", `${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    } finally {
      options.signal?.removeEventListener("abort", stop);
      this.aborts.delete(taskId);
      removeTask(taskId);
    }
  }

  /**
   * Opens a .frag file. `options.sourceFile` can name the IFC the file was
   * converted from, which makes IFC export available for it as well.
   */
  async loadFragmentsFile(file: Blob, name: string, options: Partial<AddModelOptions> = {}): Promise<string | null> {
    const taskId = uid("task");
    upsertTask({ id: taskId, label: `Loading ${name}`, phase: "Reading file" });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (this.disposed) return null;
      return await this.addFragments(bytes, { ...options, name, source: "frag", sourceBytes: file.size }, taskId);
    } catch (error) {
      console.warn(`Failed to load ${name}`, error);
      pushToast("error", `${name}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      removeTask(taskId);
    }
  }

  /** Adds a Fragments binary to the scene and registers it in the store. */
  async addFragments(bytes: Uint8Array, options: AddModelOptions, taskId?: string): Promise<string> {
    const modelId = this.uniqueModelId(options.name);
    const isFirst = this.fragments.list.size === 0;
    const fragmentBytes = bytes.byteLength;
    const stageLabel: Record<FRAGS.LoadProgressEvent["stage"], string> = {
      decompressing: "Decompressing",
      parsing: "Parsing",
      generating: "Generating geometry",
      done: "Done",
    };
    const model = await this.fragments.core.load(bytes, {
      modelId,
      camera: this.world.camera.three,
      onProgress: taskId
        ? (event) => upsertTask({ id: taskId, label: `Loading ${options.name}`, phase: stageLabel[event.stage], progress: event.progress })
        : undefined,
    });
    if (this.disposed) return modelId;

    await this.fragments.core.update(true);
    const [withGeometry, metadata] = await Promise.all([
      model.getItemsIdsWithGeometry(),
      model.getMetadata<{ schema?: string }>().catch(() => ({}) as { schema?: string }),
    ]);
    if (options.sourceFile) this.sources.set(modelId, options.sourceFile);

    const info: ModelInfo = {
      id: modelId,
      name: options.name,
      source: options.source,
      elementCount: withGeometry.length,
      schema: metadata?.schema,
      sourceBytes: options.sourceBytes,
      fragmentBytes,
      convertMs: options.convertMs,
      leftOutGeometry: options.leftOutGeometry,
      hasSourceIfc: Boolean(options.sourceFile),
      visible: true,
      note: options.note,
      collection: options.collection,
      order: options.order,
      folder: options.folder,
      description: options.description,
    };
    useViewerStore.setState((state) => ({
      models: [...state.models, info],
      modelsVersion: state.modelsVersion + 1,
    }));
    this.updateCameraRange();
    if (isFirst || this.following) await this.fitAll(false);
    return modelId;
  }

  /**
   * While on, every model that arrives is framed together with the ones
   * already there. It switches itself off as soon as the user moves the view.
   */
  followModels(on: boolean) {
    this.following = on;
  }

  /**
   * The engine's camera stops at 300 m from its target and clips at 1 km,
   * which is too tight for campuses and infrastructure. Widen both to suit
   * what is loaded.
   */
  private updateCameraRange() {
    const box = this.modelsBox();
    if (box.isEmpty()) return;
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    if (!Number.isFinite(radius) || radius <= 0) return;
    const camera = this.world.camera;
    camera.controls.maxDistance = Math.max(300, radius * 10);
    const far = Math.max(1000, radius * 25);
    for (const three of [camera.threePersp, camera.threeOrtho]) {
      if (three.far < far) {
        three.far = far;
        three.updateProjectionMatrix();
      }
    }
  }

  async removeModel(modelId: string) {
    if (!this.fragments.list.has(modelId)) return;
    const selection = toIdMap(useViewerStore.getState().selection);
    if (selection[modelId]) {
      delete selection[modelId];
      await this.select(selection);
    }
    disposeModelIndex(modelId);
    this.sources.delete(modelId);
    await this.fragments.core.disposeModel(modelId);
    useViewerStore.setState((state) => ({
      models: state.models.filter((model) => model.id !== modelId),
      modelsVersion: state.modelsVersion + 1,
      plans: [],
      activePlan: null,
    }));
    await this.fragments.core.update(true);
  }

  async setModelVisible(modelId: string, visible: boolean) {
    const model = this.getModel(modelId);
    if (!model) return;
    await model.setVisible(undefined, visible);
    await this.fragments.core.update(true);
    useViewerStore.setState((state) => ({
      models: state.models.map((entry) => (entry.id === modelId ? { ...entry, visible } : entry)),
    }));
  }

  /** Shows or hides several models in one go. */
  async setModelsVisible(modelIds: string[], visible: boolean) {
    const changed = new Set<string>();
    for (const modelId of modelIds) {
      const model = this.getModel(modelId);
      if (!model) continue;
      await model.setVisible(undefined, visible);
      changed.add(modelId);
    }
    if (changed.size === 0) return;
    await this.fragments.core.update(true);
    useViewerStore.setState((state) => ({
      models: state.models.map((entry) => (changed.has(entry.id) ? { ...entry, visible } : entry)),
    }));
  }

  /** Shows the given models and hides every other one. */
  async showOnlyModels(modelIds: string[]) {
    const keep = new Set(modelIds);
    const all = [...this.fragments.list.keys()];
    await this.setModelsVisible(all.filter((modelId) => !keep.has(modelId)), false);
    await this.setModelsVisible(all.filter((modelId) => keep.has(modelId)), true);
  }

  async removeModels(modelIds: string[]) {
    for (const modelId of modelIds) await this.removeModel(modelId);
  }

  cancelTask(taskId: string) {
    this.aborts.get(taskId)?.abort();
  }

  /**
   * Registers work that runs outside the engine (a Revit conversion, a cloud
   * upload) so the task list's cancel button and dispose() can stop it.
   * Returns a function that unregisters it.
   */
  trackTask(taskId: string, controller: AbortController): () => void {
    this.aborts.set(taskId, controller);
    return () => {
      this.aborts.delete(taskId);
    };
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------

  private modelName(modelId: string) {
    const info = useViewerStore.getState().models.find((model) => model.id === modelId);
    return sanitizeFileName(baseName(info?.name ?? modelId));
  }

  /** Downloads the whole model as a compressed .frag file. */
  async exportFragments(modelId: string) {
    const model = this.getModel(modelId);
    if (!model) return;
    const buffer = await model.getBuffer(false);
    downloadBlob(new Blob([buffer], { type: "application/octet-stream" }), `${this.modelName(modelId)}.frag`);
  }

  /**
   * Downloads several models as separate .frag files inside one .zip. The
   * archive can be unpacked next to the IFC files, or opened here as it is.
   */
  async exportFragmentsArchive(modelIds: string[], archiveName: string) {
    const ids = modelIds.filter((modelId) => this.fragments.list.has(modelId));
    if (ids.length === 0) return;
    const taskId = uid("task");
    const controller = new AbortController();
    this.aborts.set(taskId, controller);
    const label = `Packing ${ids.length} .frag file${ids.length === 1 ? "" : "s"}`;
    upsertTask({ id: taskId, label, phase: "Starting", progress: 0, cancellable: true });
    try {
      const writer = new ZipWriter();
      for (let i = 0; i < ids.length; i++) {
        const model = this.fragments.list.get(ids[i]);
        if (!model) continue;
        const fileName = `${this.modelName(ids[i])}.frag`;
        upsertTask({ id: taskId, label, phase: fileName, progress: i / ids.length, detail: `${i + 1} of ${ids.length}`, cancellable: true });
        // Each file is what "Export .frag" gives for that model.
        const bytes = new Uint8Array((await model.getBuffer(false)) as ArrayBuffer);
        if (controller.signal.aborted) throw new JobCancelled();
        writer.add(fileName, bytes);
      }
      const blob = writer.finish();
      downloadBlob(blob, `${sanitizeFileName(archiveName)}-frag.zip`);
      pushToast("success", `${ids.length} .frag file${ids.length === 1 ? "" : "s"} packed: ${formatBytes(blob.size)}.`);
    } catch (error) {
      if (error instanceof JobCancelled) pushToast("info", "Export cancelled.");
      else pushToast("error", `Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.aborts.delete(taskId);
      removeTask(taskId);
    }
  }

  /**
   * Downloads several models as one .frag: a single Fragments model that
   * holds every item of each, placed where the viewer shows them. The models
   * are joined in the order given, and the first one sets the coordinate system.
   */
  async exportCombinedFragments(modelIds: string[], name: string) {
    const ids = modelIds.filter((modelId) => this.fragments.list.has(modelId));
    if (ids.length === 0) return;
    const taskId = uid("task");
    const controller = new AbortController();
    this.aborts.set(taskId, controller);
    const label = `Combining ${ids.length} model${ids.length === 1 ? "" : "s"} into one .frag`;
    const phases = { measuring: "Measuring", merging: "Joining", compressing: "Compressing" } as const;
    upsertTask({ id: taskId, label, phase: phases.measuring, progress: 0, cancellable: true });
    // The models are joined uncompressed, in memory. For a large set that is worth saying before it starts,
    // because a tab that runs out of memory closes without a message. A .frag unpacks to about three times
    // its size, and joining took about twice the unpacked size at its peak (measured: 1.1 GB for a 0.58 GB result).
    const packed = useViewerStore.getState().models.filter((model) => ids.includes(model.id)).reduce((sum, model) => sum + model.fragmentBytes, 0);
    const needed = packed * 6;
    if (needed >= 1024 * 1024 * 1024) {
      pushToast("info", `Joining these models takes about ${formatBytes(needed)} of memory on top of what is loaded. If the tab runs short of it, join the .frag files outside the browser with npm run combine.`, 15000);
    }
    const started = performance.now();
    try {
      const models = ids.map((modelId) => ({
        name: this.modelName(modelId),
        raw: async () => (await (this.fragments.list.get(modelId) as FRAGS.FragmentsModel).getBuffer(true)) as ArrayBuffer,
      }));
      const result = await combineFragments(
        models,
        name,
        (progress) => upsertTask({ id: taskId, label, phase: phases[progress.phase], progress: progress.progress, detail: progress.detail, cancellable: true }),
        controller.signal,
      );
      downloadBlob(result.blob, `${sanitizeFileName(name)}.frag`);
      pushToast(
        "success",
        `Combined .frag written: ${formatCount(result.elements)} elements from ${ids.length} model${ids.length === 1 ? "" : "s"}, ${formatBytes(result.blob.size)}, in ${formatDuration(performance.now() - started)}.`,
      );
    } catch (error) {
      if (error instanceof JobCancelled) pushToast("info", "Export cancelled.");
      else pushToast("error", `Combined export failed: ${error instanceof Error ? error.message : String(error)}`, 15000);
    } finally {
      this.aborts.delete(taskId);
      removeTask(taskId);
    }
  }

  /** Downloads only the given items of each model as .frag files. */
  async exportFragmentsSubset(items: PlainIdMap) {
    for (const [modelId, ids] of Object.entries(items)) {
      const model = this.getModel(modelId);
      if (!model || ids.length === 0) continue;
      const buffer = (await model.getSubsetBuffer(ids, false)) as ArrayBuffer | Uint8Array;
      downloadBlob(
        new Blob([buffer as BlobPart], { type: "application/octet-stream" }),
        `${this.modelName(modelId)}-selection.frag`,
      );
    }
  }

  /**
   * Writes the given items of each model to a new IFC file. Needs the original
   * IFC, so it works for models converted in this session (IFC or RVT), not
   * for models opened from a .frag.
   */
  async exportIfcSubset(items: PlainIdMap): Promise<number> {
    let exported = 0;
    for (const [modelId, ids] of Object.entries(items)) {
      const model = this.getModel(modelId);
      const source = this.sources.get(modelId);
      if (!model || ids.length === 0) continue;
      if (!source) {
        pushToast("error", `${modelId} was opened from a .frag file, so its original IFC is not available for IFC export.`);
        continue;
      }
      const taskId = uid("task");
      const controller = new AbortController();
      this.aborts.set(taskId, controller);
      const label = `Exporting ${ids.length} element${ids.length === 1 ? "" : "s"} as IFC`;
      upsertTask({ id: taskId, label, phase: PHASE_LABEL.extract, progress: 0, cancellable: true });
      try {
        const categories = await model.getItemsWithGeometryCategories();
        const elementTypes = [...new Set(categories.filter((category): category is string => Boolean(category)))];
        const { blob, warnings } = await extractIfc(
          source,
          ids,
          elementTypes,
          (progress) => upsertTask({ id: taskId, label, phase: PHASE_LABEL.extract, progress: progress.progress, detail: progress.detail, cancellable: true }),
          controller.signal,
        );
        downloadBlob(blob, `${this.modelName(modelId)}-selection.ifc`);
        exported += 1;
        const skipped = warnings.length ? ` ${warnings.length} item${warnings.length === 1 ? " was" : "s were"} skipped (not building elements).` : "";
        pushToast("success", `IFC written: ${formatBytes(blob.size)}.${skipped}`);
      } catch (error) {
        if (error instanceof JobCancelled) pushToast("info", "IFC export cancelled.");
        else pushToast("error", `IFC export failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.aborts.delete(taskId);
        removeTask(taskId);
      }
    }
    return exported;
  }

  /** Downloads the IFC a model was converted from (useful for RVT -> IFC). */
  downloadSourceIfc(modelId: string) {
    const source = this.sources.get(modelId);
    if (!source) return;
    downloadBlob(source, `${this.modelName(modelId)}.ifc`);
  }

  // ---------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------

  getSelection(): IdMap {
    return this.highlighter.selection[SELECT] ?? {};
  }

  private queueSelectionSync() {
    if (this.selectionSyncQueued) return;
    this.selectionSyncQueued = true;
    queueMicrotask(() => {
      this.selectionSyncQueued = false;
      if (this.disposed) return;
      const selection = toPlainMap(this.getSelection());
      useViewerStore.setState({ selection, selectionCount: countIds(selection) });
    });
  }

  async select(items: PlainIdMap | IdMap, options: { zoom?: boolean; add?: boolean } = {}) {
    const map = toIdMap(items);
    if (OBC.ModelIdMapUtils.isEmpty(map)) {
      if (!options.add) await this.highlighter.clear(SELECT);
    } else {
      // The highlighter ignores calls while it is switched off, which it is whenever a
      // tool other than Select is active. Selecting from a panel or a box must still work.
      const enabled = this.highlighter.enabled;
      this.highlighter.enabled = true;
      try {
        await this.highlighter.highlightByID(SELECT, map, !options.add, false);
      } finally {
        this.highlighter.enabled = enabled;
      }
      if (options.zoom) await this.fitTo(map);
    }
    this.queueSelectionSync();
  }

  async clearSelection() {
    await this.highlighter.clear(SELECT);
    this.queueSelectionSync();
  }

  /** Selects everything whose screen projection falls inside a client-space rectangle. */
  async boxSelect(left: number, top: number, right: number, bottom: number, options: { add?: boolean; contained?: boolean } = {}) {
    const dom = this.world.renderer?.three.domElement;
    if (!dom) return;
    const result: IdMap = {};
    await Promise.all(
      this.models.map(async (model) => {
        const hit = await model.rectangleRaycast({
          camera: this.world.camera.three,
          dom,
          topLeft: new THREE.Vector2(left, top),
          bottomRight: new THREE.Vector2(right, bottom),
          fullyIncluded: options.contained ?? false,
        });
        if (hit && hit.localIds.length > 0) result[model.modelId] = new Set(hit.localIds);
      }),
    );
    await this.select(result, { add: options.add });
  }

  // ---------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------

  async hide(items: PlainIdMap | IdMap) {
    const map = toIdMap(items);
    if (OBC.ModelIdMapUtils.isEmpty(map)) return;
    await this.hider.set(false, map);
    await this.fragments.core.update(true);
    useViewerStore.setState({ visibilityModified: true });
  }

  async isolate(items: PlainIdMap | IdMap) {
    const map = toIdMap(items);
    if (OBC.ModelIdMapUtils.isEmpty(map)) return;
    await this.hider.isolate(map);
    await this.fragments.core.update(true);
    useViewerStore.setState({ visibilityModified: true });
  }

  async show(items: PlainIdMap | IdMap) {
    const map = toIdMap(items);
    if (OBC.ModelIdMapUtils.isEmpty(map)) return;
    await this.hider.set(true, map);
    await this.fragments.core.update(true);
  }

  /** X-rays everything except the given items. Pass an empty map to clear. */
  async ghostExcept(items: PlainIdMap | IdMap) {
    const map = toIdMap(items);
    const active = !OBC.ModelIdMapUtils.isEmpty(map);
    for (const model of this.models) {
      if (!active) {
        model.clearGhost();
        continue;
      }
      await model.setGhostItems([...(map[model.modelId] ?? [])], true);
    }
    await this.fragments.core.update(true);
    useViewerStore.setState({ ghosting: active });
  }

  async showAll() {
    await this.hider.set(true);
    for (const model of this.models) model.clearGhost();
    await this.fragments.core.update(true);
    useViewerStore.setState((state) => ({
      visibilityModified: false,
      ghosting: false,
      models: state.models.map((model) => ({ ...model, visible: true })),
    }));
  }

  /** Paints items with a flat colour (used by grouping and analysis overlays). */
  async colorize(items: PlainIdMap | IdMap, color: THREE.ColorRepresentation) {
    const threeColor = new THREE.Color(color);
    for (const [modelId, ids] of Object.entries(toIdMap(items))) {
      const model = this.getModel(modelId);
      if (model && ids.size > 0) await model.setColor([...ids], threeColor);
    }
    await this.fragments.core.update(true);
  }

  async resetColors() {
    for (const model of this.models) await model.resetColor(undefined);
    await this.fragments.core.update(true);
  }

  // ---------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------

  /** Bounding box of all models, or of the given ones. */
  private modelsBox(modelIds?: string[]): THREE.Box3 {
    this.boxer.list.clear();
    this.boxer.addFromModels(modelIds?.map((modelId) => new RegExp(`^${modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)));
    const box = this.boxer.get();
    this.boxer.list.clear();
    return box;
  }

  /** Frames all models, or only the given ones. */
  async fitAll(animate = true, modelIds?: string[]) {
    if (this.fragments.list.size === 0) return;
    const box = this.modelsBox(modelIds);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return;
    await this.world.camera.controls.fitToSphere(sphere, animate);
    await this.fragments.core.update(true);
  }

  async fitTo(items: PlainIdMap | IdMap) {
    const map = toIdMap(items);
    if (OBC.ModelIdMapUtils.isEmpty(map)) return;
    await this.world.camera.fitToItems(map);
    await this.fragments.core.update(true);
  }

  async setView(orientation: ViewOrientation) {
    if (this.fragments.list.size === 0) return;
    this.boxer.list.clear();
    this.boxer.addFromModels();
    const { position, target } = await this.boxer.getCameraOrientation(orientation);
    this.boxer.list.clear();
    await this.world.camera.controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, true);
  }

  async setProjection(projection: Projection) {
    if (projection === "Orthographic" && useViewerStore.getState().navMode === "FirstPerson") this.setNavMode("Orbit");
    await this.world.camera.projection.set(projection);
    useViewerStore.setState({ projection });
    await this.fragments.core.update(true);
  }

  setNavMode(mode: NavMode) {
    try {
      if (mode === "FirstPerson" && this.world.camera.projection.current !== "Perspective") {
        void this.world.camera.projection.set("Perspective");
      }
      this.world.camera.set(mode);
      useViewerStore.setState({ navMode: mode });
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : String(error));
    }
  }

  setGridVisible(visible: boolean) {
    this.grid.visible = visible && useViewerStore.getState().renderStyle === "basic";
    useViewerStore.setState({ grid: visible });
  }

  setRenderStyle(style: RenderStyle) {
    const renderer = this.world.renderer;
    if (!renderer) return;
    const post = renderer.postproduction;
    if (style === "basic") {
      post.enabled = false;
    } else {
      post.enabled = true;
      post.style = style === "pen" ? OBF.PostproductionAspect.COLOR_PEN : OBF.PostproductionAspect.COLOR_PEN_SHADOWS;
    }
    // The outline and shadow passes turn the ground grid into thick bands, so it
    // is only drawn in the plain style. The grid toggle keeps the user's choice.
    this.grid.visible = useViewerStore.getState().grid && style === "basic";
    useViewerStore.setState({ renderStyle: style });
  }

  // ---------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------

  setTool(tool: ToolId) {
    for (const measurer of Object.values(this.measurers)) {
      if (measurer.enabled) measurer.cancelCreation();
      measurer.enabled = false;
    }
    this.clipper.enabled = tool === "section";
    this.highlighter.enabled = tool === "select";
    this.hoverer.enabled = tool === "select";
    if (tool in this.measurers) this.measurers[tool as MeasureTool].enabled = true;
    // Box selection draws its own rectangle; the camera must not orbit meanwhile.
    this.world.camera.setUserInput(tool !== "box");
    useViewerStore.setState({ tool });
  }

  /** Finishes a multi-point measurement (area, volume). */
  finishMeasurement() {
    const tool = useViewerStore.getState().tool;
    if (tool in this.measurers) this.measurers[tool as MeasureTool].endCreation();
  }

  cancelMeasurement() {
    const tool = useViewerStore.getState().tool;
    if (tool in this.measurers) this.measurers[tool as MeasureTool].cancelCreation();
  }

  /** Deletes the measurement or section plane under the cursor. */
  deleteUnderCursor() {
    const tool = useViewerStore.getState().tool;
    if (tool === "section") void this.clipper.delete(this.world);
    else if (tool in this.measurers) this.measurers[tool as MeasureTool].delete();
  }

  clearMeasurements() {
    for (const measurer of Object.values(this.measurers)) measurer.list.clear();
    this.syncMeasurements();
  }

  private syncMeasurements() {
    if (this.disposed) return;
    let count = 0;
    for (const measurer of Object.values(this.measurers)) count += measurer.list.size;
    useViewerStore.setState({ measurementCount: count });
  }

  /** Current measurement values, for the measure panel and CSV export. */
  getMeasurements(): { kind: MeasureTool; value: number; unit: string }[] {
    const result: { kind: MeasureTool; value: number; unit: string }[] = [];
    const units: Record<MeasureTool, string> = { length: "m", area: "m²", angle: "°", volume: "m³" };
    for (const [kind, measurer] of Object.entries(this.measurers) as [MeasureTool, (typeof this.measurers)[MeasureTool]][]) {
      for (const item of measurer.list) {
        const value = (item as { value?: number }).value;
        if (typeof value === "number") result.push({ kind, value, unit: units[kind] });
      }
    }
    return result;
  }

  // --- Section planes ---------------------------------------------------

  private syncPlanes() {
    if (this.disposed) return;
    const planes = [...this.clipper.list.values()];
    useViewerStore.setState({
      planeCount: planes.length,
      planesEnabled: planes.length === 0 ? true : planes.some((plane) => plane.enabled),
    });
    void this.fragments.core.update(true);
  }

  /** Adds an axis-aligned section plane through the middle of the loaded models. */
  addAxisPlane(axis: "x" | "y" | "z") {
    if (this.fragments.list.size === 0) return;
    const box = this.modelsBox();
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const normal = new THREE.Vector3(axis === "x" ? -1 : 0, axis === "y" ? -1 : 0, axis === "z" ? -1 : 0);
    this.clipper.createFromNormalAndCoplanarPoint(this.world, normal, center);
    this.syncPlanes();
  }

  setPlanesEnabled(enabled: boolean) {
    for (const [, plane] of this.clipper.list) plane.enabled = enabled;
    this.syncPlanes();
  }

  setPlanesVisible(visible: boolean) {
    this.clipper.visible = visible;
  }

  clearPlanes() {
    this.clipper.deleteAll();
    this.syncPlanes();
  }

  // --- Storey plans -----------------------------------------------------

  /** Creates one plan view per IfcBuildingStorey of every loaded model. */
  async createPlans() {
    this.closePlan();
    this.views.list.clear();
    await this.views.createFromIfcStoreys({ offset: 1.2 });
    const plans = [...this.views.list.keys()].map((id) => ({ id, name: id }));
    useViewerStore.setState({ plans, activePlan: null });
    return plans;
  }

  async openPlan(id: string) {
    const view = this.views.list.get(id);
    if (!view) return;
    this.views.open(id);
    useViewerStore.setState({ activePlan: id });
    // Frame the whole model in the plan; the view's own camera starts wherever it was created.
    try {
      const box = this.modelsBox();
      if (!box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3());
        const padding = Math.max(size.x, size.z) * 0.04;
        await view.camera.controls.fitToBox(box, false, { paddingTop: padding, paddingBottom: padding, paddingLeft: padding, paddingRight: padding });
      }
    } catch (error) {
      console.warn("Could not frame the plan view", error);
    }
    await this.fragments.core.update(true);
  }

  closePlan() {
    if (this.views.hasOpenViews) this.views.close();
    useViewerStore.setState({ activePlan: null });
    void this.fragments.core.update(true);
  }
}
