// One open model in the Autodesk viewer, with the pieces the NWD page needs
// on top of it: reading the object tree, grouping and searching objects,
// and exporting objects to IFC with their geometry, colours and properties.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { IfcWriter, type WriterElement, type WriterMesh, type WriterProperty, type WriterPropertySet, type WriterStats } from "@/lib/ifc-writer/writer";
import { guessIfcClass } from "./classify";
import { loadLmv, type LmvModel, type LmvNamespace, type LmvTree, type LmvViewer } from "./loader";

export type LmvSource =
  /** A model translated by Autodesk Platform Services, streamed with a viewer token. */
  | { kind: "aps"; urn: string; region: string | null }
  /** An extracted viewer bundle served from a plain URL (the built-in sample). */
  | { kind: "url"; url: string };

/** How a click resolves in the model tree: the smallest part, the object it belongs to, or its top-level ancestor. */
export type PickLevel = "part" | "object" | "top";

export interface ModelSummary {
  objects: number;
  elements: number;
  fragments: number;
  triangles: number;
  unit: string;
  /** Metres per model unit. */
  unitScale: number;
  upAxis: "Y" | "Z";
  isSvf2: boolean;
}

export interface PropertyKey {
  /** "category|name" */
  key: string;
  category: string;
  name: string;
}

export interface ObjectGroup {
  label: string;
  ids: number[];
}

export interface ExportOptions {
  fileName: string;
  projectName: string;
  /** Guess IFC classes from names; otherwise everything is an IfcBuildingElementProxy. */
  guessClasses: boolean;
  /** Property used to place elements on storeys, as a PropertyKey.key; null for a single storey. */
  storeyProperty: string | null;
}

export interface ExportResult {
  blob: Blob;
  stats: WriterStats;
  classes: Record<string, number>;
  skippedNoGeometry: number;
}

export class ExportCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "ExportCancelled";
  }
}

// Node kinds of the viewer's object tree.
const NODE_INSERT = 1;
const NODE_COMPOSITE = 4;
const NODE_GEOMETRY = 6;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function errorText(code: unknown, message: unknown): string {
  const text = typeof message === "string" && message ? message : "";
  const map: Record<number, string> = {
    1: "An unknown failure occurred.",
    2: "The model data is corrupt or has no 3D view.",
    3: "The network request failed.",
    4: "Access to the model was denied. The viewer token may have expired.",
    5: "The model was not found. Cloud copies are deleted after 24 hours.",
    6: "The Autodesk server had a problem.",
    7: "The model could not be loaded.",
    8: "WebGL is not available in this browser.",
    9: "The model has no viewable content.",
  };
  const known = typeof code === "number" ? map[code] : undefined;
  return known ? (text && !/^\s*$/.test(text) ? `${known} (${text})` : known) : text || "The model could not be loaded.";
}

export class LmvSession {
  readonly viewer: LmvViewer;
  readonly model: LmvModel;
  readonly tree: LmvTree | null;
  private readonly AV: LmvNamespace;
  private disposed = false;
  private elementCache: number[] | null = null;
  private selectionListeners = new Set<(ids: number[]) => void>();
  private readonly onSelection = () => {
    const ids = this.getSelection();
    for (const listener of this.selectionListeners) listener(ids);
  };

  private constructor(AV: LmvNamespace, viewer: LmvViewer, model: LmvModel, tree: LmvTree | null) {
    this.AV = AV;
    this.viewer = viewer;
    this.model = model;
    this.tree = tree;
    viewer.addEventListener(AV.SELECTION_CHANGED_EVENT, this.onSelection);
  }

  /** Starts the viewer in `container` and loads a model. Rejects with a readable message. */
  static async create(container: HTMLElement, source: LmvSource, onProgress: (label: string, fraction?: number) => void): Promise<LmvSession> {
    onProgress("Loading the Autodesk viewer");
    const AV = await loadLmv();
    if (source.kind === "url") return LmvSession.open(AV, container, source, { env: "Local" }, onProgress);

    const getAccessToken = (callback: (token: string, expiresInSeconds: number) => void) => {
      fetch("/api/aps/token", { cache: "no-store" })
        .then((response) => response.json())
        .then((token: { access_token?: string; expires_in?: number }) => callback(token.access_token ?? "", token.expires_in ?? 0))
        .catch(() => callback("", 0));
    };
    const suffix = source.region === "EMEA" ? "_EU" : source.region === "AUS" ? "_AUS" : "";
    // The translation is made as SVF2, which the streaming endpoint serves. If that
    // endpoint refuses the model, the classic derivative endpoint is tried once.
    const attempts = [
      { env: "AutodeskProduction2", api: `streamingV2${suffix}`, getAccessToken },
      { env: "AutodeskProduction", api: `derivativeV2${suffix}`, getAccessToken },
    ];
    let firstError: unknown;
    for (const options of attempts) {
      try {
        return await LmvSession.open(AV, container, source, options, onProgress);
      } catch (error) {
        firstError ??= error;
      }
    }
    throw firstError;
  }

  private static async open(AV: LmvNamespace, container: HTMLElement, source: LmvSource, options: Record<string, unknown>, onProgress: (label: string, fraction?: number) => void): Promise<LmvSession> {
    // The endpoint settings are global, so start from a clean slate for every model.
    try {
      AV.shutdown();
    } catch {
      // Nothing was running.
    }
    await new Promise<void>((resolve) => AV.Initializer(options, () => resolve()));

    const viewer = new AV.GuiViewer3D(container, { disabledExtensions: { bimwalk: true, hyperlink: true } });
    const startCode = viewer.start();
    if (startCode > 0) {
      viewer.finish();
      throw new Error(errorText(startCode, "The viewer could not start. WebGL may be unavailable."));
    }

    onProgress("Opening the model");
    let model: LmvModel;
    try {
      if (source.kind === "aps") {
        const document = await new Promise<any>((resolve, reject) => AV.Document.load(`urn:${source.urn}`, resolve, (code: number, message: string) => reject(new Error(errorText(code, message)))));
        const viewable = document.getRoot().getDefaultGeometry();
        if (!viewable) throw new Error("The translated model has no 3D view.");
        model = await viewer.loadDocumentNode(document, viewable, { keepCurrentModels: false });
      } else {
        model = await new Promise<any>((resolve, reject) => viewer.loadModel(source.url, {}, resolve, (code: number, message: string) => reject(new Error(errorText(code, message)))));
      }

      // Geometry streams in after the model root; wait for all of it.
      if (!model.isLoadDone()) {
        await new Promise<void>((resolve) => {
          const onProgressEvent = (event: { percent?: number; state?: number }) => {
            if (typeof event.percent === "number") onProgress("Loading geometry", Math.min(1, event.percent / 100));
          };
          const done = () => {
            viewer.removeEventListener(AV.PROGRESS_UPDATE_EVENT, onProgressEvent);
            viewer.removeEventListener(AV.GEOMETRY_LOADED_EVENT, done);
            resolve();
          };
          viewer.addEventListener(AV.PROGRESS_UPDATE_EVENT, onProgressEvent);
          viewer.addEventListener(AV.GEOMETRY_LOADED_EVENT, done);
          if (model.isLoadDone()) done();
        });
      }

      onProgress("Reading the model tree");
      const tree = await new Promise<LmvTree | null>((resolve) => model.getObjectTree(resolve, () => resolve(null)));
      return new LmvSession(AV, viewer, model, tree);
    } catch (error) {
      try {
        viewer.finish();
      } catch {
        // Already torn down.
      }
      throw error;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.selectionListeners.clear();
    try {
      this.viewer.removeEventListener(this.AV.SELECTION_CHANGED_EVENT, this.onSelection);
      this.viewer.finish();
    } catch {
      // The viewer may already be gone.
    }
  }

  // -------------------------------------------------------------------------
  // Appearance

  setTheme(dark: boolean) {
    this.viewer.setTheme(dark ? "dark-theme" : "light-theme");
    // Match the app's viewport gradient.
    if (dark) this.viewer.setBackgroundColor(30, 35, 43, 17, 20, 25);
    else this.viewer.setBackgroundColor(246, 247, 249, 221, 225, 231);
  }

  resize() {
    this.viewer.resize();
  }

  // -------------------------------------------------------------------------
  // Tree

  private nodeType(id: number): number {
    return this.tree ? this.tree.getNodeType(id) : NODE_GEOMETRY;
  }

  private children(id: number): number[] {
    const result: number[] = [];
    // The viewer stops enumerating as soon as a callback returns something truthy, so return nothing.
    this.tree?.enumNodeChildren(
      id,
      (child: number) => {
        result.push(child);
      },
      false,
    );
    return result;
  }

  private hasFragments(id: number): boolean {
    let found = false;
    // Returning true stops at the first fragment, which is all that is asked here.
    this.tree?.enumNodeFragments(id, () => (found = true), true);
    return found;
  }

  /**
   * Splits the model into exportable elements. An element is a composite
   * object or an insert (a placed component) where the file has them, and
   * otherwise a single geometry node, so one building part is one element
   * rather than one element per surface.
   */
  elements(): number[] {
    if (this.elementCache) return this.elementCache;
    const result: number[] = [];
    if (!this.tree) {
      // No tree: every object that owns fragments is its own element.
      const seen = new Set<number>();
      const fragments = this.model.getFragmentList();
      for (let fragment = 0, count = fragments.getCount(); fragment < count; fragment++) {
        const id = fragments.getDbIds(fragment);
        if (typeof id === "number" && !seen.has(id)) {
          seen.add(id);
          result.push(id);
        }
      }
    } else {
      const visit = (id: number) => {
        const type = this.nodeType(id);
        const kids = this.children(id);
        if (kids.length === 0 || type === NODE_COMPOSITE || type === NODE_INSERT || type === NODE_GEOMETRY) {
          if (this.hasFragments(id)) result.push(id);
          return;
        }
        for (const child of kids) visit(child);
      };
      visit(this.tree.getRootId());
    }
    this.elementCache = result;
    return result;
  }

  /** The elements covered by a set of picked or grouped objects, without duplicates. */
  elementsOf(ids: number[]): number[] {
    if (!this.tree) return [...new Set(ids)];
    const all = new Set(this.elements());
    const result = new Set<number>();
    const down = (id: number) => {
      if (all.has(id)) {
        result.add(id);
        return;
      }
      for (const child of this.children(id)) down(child);
    };
    for (const id of ids) {
      // A picked part inside an element stands for that element.
      let owner: number | null = null;
      for (let current = id; typeof current === "number" && current > 0; current = this.tree.getNodeParentId(current)) {
        if (all.has(current)) {
          owner = current;
          break;
        }
        if (current === this.tree.getRootId()) break;
      }
      if (owner !== null) result.add(owner);
      else down(id);
    }
    return [...result];
  }

  /**
   * What a user's picks stand for when exporting. A pick at or below element
   * level is kept as picked, so a single part can be exported on its own; a
   * pick above it (a layer, a file) expands to the elements under it. When a
   * pick and one of its ancestors are both present, the ancestor wins.
   */
  unitsOf(ids: number[]): number[] {
    if (!this.tree) return [...new Set(ids)];
    const tree = this.tree;
    const root = tree.getRootId();
    const all = new Set(this.elements());
    const result = new Set<number>();
    const insideElement = (id: number) => {
      for (let current = id; typeof current === "number" && current > 0; current = tree.getNodeParentId(current)) {
        if (all.has(current)) return true;
        if (current === root) break;
      }
      return false;
    };
    const down = (id: number) => {
      if (all.has(id)) {
        result.add(id);
        return;
      }
      for (const child of this.children(id)) down(child);
    };
    for (const id of ids) {
      if (insideElement(id)) {
        if (this.hasFragments(id)) result.add(id);
      } else down(id);
    }
    return [...result].filter((id) => {
      for (let current = id === root ? 0 : tree.getNodeParentId(id); typeof current === "number" && current > 0; current = tree.getNodeParentId(current)) {
        if (result.has(current)) return false;
        if (current === root) break;
      }
      return true;
    });
  }

  name(id: number): string {
    return (this.tree?.getNodeName(id) as string | undefined) ?? `Object ${id}`;
  }

  /** Names from the root down to the object's parent. */
  path(id: number): string[] {
    if (!this.tree) return [];
    const names: string[] = [];
    const root = this.tree.getRootId();
    for (let current = this.tree.getNodeParentId(id); typeof current === "number" && current > 0; current = this.tree.getNodeParentId(current)) {
      const name = this.tree.getNodeName(current);
      if (name) names.unshift(name);
      if (current === root) break;
    }
    return names;
  }

  summary(): ModelSummary {
    const fragments = this.model.getFragmentList();
    let triangles = 0;
    const counted = new Set<number>();
    const fragmentCount: number = fragments.getCount();
    for (let fragment = 0; fragment < fragmentCount; fragment++) {
      const geometry = fragments.getGeometry(fragment);
      if (geometry && !geometry.isLines && !geometry.isPoints) triangles += geometry.polyCount ?? (geometry.ib ? geometry.ib.length / 3 : 0);
      counted.add(fragments.getDbIds(fragment));
    }
    const up = this.model.getUpVector?.() as number[] | undefined;
    return {
      objects: counted.size,
      elements: this.elements().length,
      fragments: fragmentCount,
      triangles: Math.round(triangles),
      unit: (this.model.getUnitString?.() as string | null) || "unitless",
      unitScale: Number(this.model.getUnitScale?.()) || 1,
      upAxis: up && Math.abs(up[1]) > Math.abs(up[2]) ? "Y" : "Z",
      isSvf2: Boolean(this.model.isSVF2?.() || this.model.isOTG?.()),
    };
  }

  // -------------------------------------------------------------------------
  // Selection and visibility

  getSelection(): number[] {
    return (this.viewer.getSelection() as number[]) ?? [];
  }

  onSelectionChanged(listener: (ids: number[]) => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  select(ids: number[], add = false) {
    this.viewer.select(add ? [...new Set([...this.getSelection(), ...ids])] : ids);
  }

  clearSelection() {
    this.viewer.clearSelection();
  }

  isolate(ids: number[]) {
    this.viewer.isolate(ids);
  }

  hide(ids: number[]) {
    this.viewer.hide(ids);
  }

  showAll() {
    this.viewer.showAll();
  }

  fit(ids?: number[]) {
    this.viewer.fitToView(ids && ids.length > 0 ? ids : undefined);
  }

  setPickLevel(level: PickLevel) {
    const modes = this.AV.SelectionMode;
    this.viewer.setSelectionMode(level === "part" ? modes.LEAF_OBJECT : level === "top" ? modes.FIRST_OBJECT : modes.LAST_OBJECT);
  }

  /** Elements that are currently shown (not hidden, not left out by an isolation). */
  visibleElements(): number[] {
    const isolated = new Set<number>((this.viewer.getIsolatedNodes?.() as number[] | undefined) ?? []);
    const hiddenNodes =
      (this.viewer.getHiddenNodes?.() as number[] | undefined) ??
      ((this.viewer.getAggregateHiddenNodes?.() as { model: unknown; ids: number[] }[] | undefined) ?? []).filter((entry) => entry.model === this.model).flatMap((entry) => entry.ids);
    const hidden = new Set<number>(hiddenNodes);
    if (isolated.size === 0 && hidden.size === 0) return this.elements();
    const within = (id: number, set: Set<number>) => {
      if (!this.tree) return set.has(id);
      const root = this.tree.getRootId();
      for (let current = id; typeof current === "number" && current > 0; current = this.tree.getNodeParentId(current)) {
        if (set.has(current)) return true;
        if (current === root) break;
      }
      return false;
    };
    const shown = isolated.size > 0 ? new Set(this.elementsOf([...isolated])) : null;
    return this.elements().filter((id) => (shown ? shown.has(id) : true) && !within(id, hidden));
  }

  // -------------------------------------------------------------------------
  // Properties, grouping, search

  private bulkProperties(ids: number[], propFilter?: string[]): Promise<any[]> {
    return new Promise((resolve) => {
      const options: Record<string, unknown> = { ignoreHidden: true, needsExternalId: true };
      if (propFilter) options.propFilter = propFilter;
      const fail = () => resolve([]);
      if (typeof this.model.getBulkProperties2 === "function") this.model.getBulkProperties2(ids, options, resolve, fail);
      else this.model.getBulkProperties(ids, options, resolve, fail);
    });
  }

  /** The property names found on a sample of elements, for the "group by" list. */
  async propertyKeys(sampleSize = 400): Promise<PropertyKey[]> {
    const elements = this.elements();
    const step = Math.max(1, Math.floor(elements.length / sampleSize));
    const sample: number[] = [];
    for (let i = 0; i < elements.length && sample.length < sampleSize; i += step) sample.push(elements[i]);
    const results = await this.bulkProperties(sample);
    const counts = new Map<string, { key: PropertyKey; count: number }>();
    for (const result of results) {
      for (const property of result.properties ?? []) {
        const category = String(property.displayCategory ?? "");
        const name = String(property.displayName ?? "");
        if (!name || category.startsWith("__") || property.hidden) continue;
        const key = `${category}|${name}`;
        const entry = counts.get(key);
        if (entry) entry.count += 1;
        else counts.set(key, { key: { key, category, name }, count: 1 });
      }
    }
    return [...counts.values()]
      .sort((a, b) => b.count - a.count || a.key.category.localeCompare(b.key.category) || a.key.name.localeCompare(b.key.name))
      .slice(0, 200)
      .map((entry) => entry.key);
  }

  /** Groups every element by its ancestor name at a tree depth (1 = directly under the root). */
  groupByTreeLevel(level: number): ObjectGroup[] {
    const groups = new Map<string, number[]>();
    for (const id of this.elements()) {
      const path = this.path(id);
      // path[0] is the root itself.
      const label = path[level] ?? (path.length <= level ? "(top level)" : "");
      const list = groups.get(label);
      if (list) list.push(id);
      else groups.set(label, [id]);
    }
    return sortGroups(groups);
  }

  /** Groups every element by the value of one property. */
  async groupByProperty(key: string, onProgress?: (fraction: number) => void): Promise<ObjectGroup[]> {
    const split = key.indexOf("|");
    const category = key.slice(0, split);
    const name = key.slice(split + 1);
    const elements = this.elements();
    const groups = new Map<string, number[]>();
    const assigned = new Set<number>();
    const BATCH = 2000;
    for (let start = 0; start < elements.length; start += BATCH) {
      const results = await this.bulkProperties(elements.slice(start, start + BATCH), [name]);
      for (const result of results) {
        const property = (result.properties ?? []).find((entry: any) => entry.displayName === name && String(entry.displayCategory ?? "") === category) ?? (result.properties ?? []).find((entry: any) => entry.displayName === name);
        if (!property) continue;
        const label = formatValue(property.displayValue, property.units);
        const list = groups.get(label);
        if (list) list.push(result.dbId);
        else groups.set(label, [result.dbId]);
        assigned.add(result.dbId);
      }
      onProgress?.(Math.min(1, (start + BATCH) / elements.length));
      await tick();
    }
    const missing = elements.filter((id) => !assigned.has(id));
    if (missing.length > 0) groups.set("(not set)", missing);
    return sortGroups(groups);
  }

  /** Objects whose properties contain the text, resolved to elements. */
  search(text: string): Promise<number[]> {
    return new Promise((resolve) => {
      if (!text.trim()) return resolve([]);
      this.viewer.search(
        text,
        (ids: number[]) => resolve(this.elementsOf(ids ?? [])),
        () => resolve([]),
      );
    });
  }

  // -------------------------------------------------------------------------
  // IFC export

  /** Triangles under the given elements, for a size estimate before exporting. */
  countTriangles(ids: number[]): number {
    const fragments = this.model.getFragmentList();
    let triangles = 0;
    for (const id of ids) {
      const visit = (fragment: number) => {
        const geometry = fragments.getGeometry(fragment);
        if (geometry && !geometry.isLines && !geometry.isPoints) triangles += geometry.polyCount ?? (geometry.ib ? geometry.ib.length / 3 : 0);
      };
      if (this.tree) this.tree.enumNodeFragments(id, visit, true);
      else {
        const own = this.model.getData()?.fragments?.dbId2fragId?.[id];
        for (const fragment of Array.isArray(own) ? own : typeof own === "number" ? [own] : []) visit(fragment);
      }
    }
    return Math.round(triangles);
  }

  private meshesOf(id: number, toMetres: number, yUp: boolean): WriterMesh[] {
    const enumerator = this.AV.Private.VertexEnumerator;
    const fragments = this.model.getFragmentList();
    const THREE = (window as any).THREE;
    const matrix = new THREE.Matrix4();
    const meshes: WriterMesh[] = [];

    const visit = (fragment: number) => {
      const geometry = fragments.getGeometry(fragment);
      if (!geometry || geometry.isLines || geometry.isPoints) return;
      fragments.getWorldMatrix(fragment, matrix);
      const vertexCount: number = enumerator.getVertexCount(geometry);
      if (!vertexCount) return;
      const positions = new Float64Array(vertexCount * 3);
      enumerator.enumMeshVertices(
        geometry,
        (position: { x: number; y: number; z: number }, _normal: unknown, _uv: unknown, index: number) => {
          const offset = index * 3;
          // To metres, and to Z up when the source is Y up.
          positions[offset] = position.x * toMetres;
          positions[offset + 1] = (yUp ? -position.z : position.y) * toMetres;
          positions[offset + 2] = (yUp ? position.y : position.z) * toMetres;
        },
        matrix,
      );
      const indices: number[] = [];
      enumerator.enumMeshIndices(geometry, (a: number, b: number, c: number) => {
        indices.push(a, b, c);
      });
      if (indices.length === 0) return;

      const material = fragments.getMaterial(fragment);
      const color = material?.color;
      meshes.push({
        positions,
        indices,
        color: color ? [color.r, color.g, color.b] : undefined,
        opacity: material && material.transparent && typeof material.opacity === "number" ? material.opacity : 1,
      });
    };

    if (this.tree) this.tree.enumNodeFragments(id, visit, true);
    else {
      const own = this.model.getData()?.fragments?.dbId2fragId?.[id];
      for (const fragment of Array.isArray(own) ? own : typeof own === "number" ? [own] : []) visit(fragment);
    }
    return meshes;
  }

  /** Writes the given elements to an IFC4 file. */
  async exportIfc(ids: number[], options: ExportOptions, onProgress: (label: string, fraction: number) => void, signal?: AbortSignal): Promise<ExportResult> {
    const elements = this.unitsOf(ids);
    if (elements.length === 0) throw new Error("There is nothing to export.");
    const summary = this.summary();
    const toMetres = summary.unitScale;
    const yUp = summary.upAxis === "Y";
    const offset = (this.model.getGlobalOffset?.() ?? this.model.getData()?.globalOffset ?? { x: 0, y: 0, z: 0 }) as { x: number; y: number; z: number };
    const origin: [number, number, number] = [offset.x * toMetres, (yUp ? -offset.z : offset.y) * toMetres, (yUp ? offset.y : offset.z) * toMetres];

    const writer = new IfcWriter({
      projectName: options.projectName,
      fileName: options.fileName,
      description: "Exported from a Navisworks model with IFC Studio",
      origin,
      idNamespace: options.projectName,
      defaultStorey: options.projectName,
    });
    const classes: Record<string, number> = {};
    let skippedNoGeometry = 0;
    const storeyKey = options.storeyProperty;
    const storeyName = storeyKey ? storeyKey.slice(storeyKey.indexOf("|") + 1) : null;
    const storeyCategory = storeyKey ? storeyKey.slice(0, storeyKey.indexOf("|")) : null;

    const BATCH = 200;
    for (let start = 0; start < elements.length; start += BATCH) {
      if (signal?.aborted) throw new ExportCancelled();
      const batch = elements.slice(start, start + BATCH);
      const properties = await this.bulkProperties(batch);
      const byId = new Map<number, any>();
      for (const result of properties) byId.set(result.dbId, result);

      for (const id of batch) {
        const meshes = this.meshesOf(id, toMetres, yUp);
        if (meshes.length === 0) {
          skippedNoGeometry += 1;
          continue;
        }
        const result = byId.get(id);
        const name = this.name(id);
        const path = this.path(id);
        const sets = new Map<string, WriterProperty[]>();
        let category: string | undefined;
        let storey: string | undefined;
        let typeName: string | undefined;
        for (const property of result?.properties ?? []) {
          const set = String(property.displayCategory ?? "") || "Properties";
          const propertyName = String(property.displayName ?? "");
          if (!propertyName || set.startsWith("__") || property.hidden) continue;
          const value = property.displayValue;
          if (value === null || value === undefined || value === "") continue;
          const lower = propertyName.toLowerCase();
          if (!category && (lower === "category" || lower === "element category") && typeof value === "string") category = value;
          if (!typeName && lower === "type" && typeof value === "string") typeName = value;
          if (storeyName && propertyName === storeyName && (!storeyCategory || set === storeyCategory || !storey)) storey = formatValue(value, null);
          const list = sets.get(set) ?? [];
          if (!sets.has(set)) sets.set(set, list);
          const units = typeof property.units === "string" && property.units ? property.units : null;
          list.push(
            typeof value === "number"
              ? { name: units ? `${propertyName} (${unitLabel(units)})` : propertyName, value, kind: Number.isInteger(value) && property.type !== 3 ? "integer" : "real" }
              : typeof value === "boolean"
                ? { name: propertyName, value }
                : { name: propertyName, value: String(value) },
          );
        }
        const propertySets: WriterPropertySet[] = [...sets.entries()].map(([setName, list]) => ({ name: setName, properties: list }));
        propertySets.push({
          name: "Navisworks",
          properties: [
            { name: "Path", value: [...path, name].join(" > ") },
            { name: "Object id", value: id, kind: "integer" },
            ...(result?.externalId ? [{ name: "External id", value: String(result.externalId) } satisfies WriterProperty] : []),
          ],
        });

        const ifcClass = options.guessClasses ? guessIfcClass([category, name, typeName, ...[...path].reverse()]) : "IFCBUILDINGELEMENTPROXY";
        classes[ifcClass] = (classes[ifcClass] ?? 0) + 1;
        const element: WriterElement = {
          ifcClass,
          name,
          objectType: typeName ?? category,
          tag: String(id),
          sourceId: result?.externalId ? String(result.externalId) : `dbid-${id}`,
          storey,
          meshes,
          propertySets,
        };
        writer.addElement(element);
      }
      onProgress("Writing elements", Math.min(1, (start + batch.length) / elements.length));
      await tick();
    }
    if (writer.stats.elements === 0) throw new Error("None of the selected objects has surface geometry to export.");
    return { blob: writer.finish(), stats: writer.stats, classes, skippedNoGeometry };
  }
}

function sortGroups(groups: Map<string, number[]>): ObjectGroup[] {
  return [...groups.entries()].map(([label, ids]) => ({ label: label || "(blank)", ids })).sort((a, b) => b.ids.length - a.ids.length || a.label.localeCompare(b.label));
}

function unitLabel(units: string): string {
  // Autodesk unit ids look like "autodesk.unit.unit:millimeters-1.0.1".
  const match = /unit:([A-Za-z]+)/.exec(units);
  return match ? match[1] : units;
}

function formatValue(value: unknown, units: unknown): string {
  if (typeof value === "number") {
    const rounded = Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(3);
    const text = String(Number(rounded));
    return typeof units === "string" && units ? `${text} ${unitLabel(units)}` : text;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value ?? "");
}
