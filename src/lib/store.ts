import { create } from "zustand";

/** Selection and item sets in a serialisable form: modelId -> local ids. */
export type PlainIdMap = Record<string, number[]>;

export type ToolId = "select" | "box" | "length" | "area" | "angle" | "volume" | "section";
export type NavMode = "Orbit" | "FirstPerson" | "Plan";
export type Projection = "Perspective" | "Orthographic";
export type RenderStyle = "basic" | "pen" | "shadows";
export type ModelSource = "ifc" | "frag" | "rvt";

export interface ModelInfo {
  id: string;
  name: string;
  source: ModelSource;
  /** Items that carry geometry. */
  elementCount: number;
  schema?: string;
  /** Size of the original file, when the model came from one. */
  sourceBytes?: number;
  fragmentBytes: number;
  convertMs?: number;
  /** Pieces of geometry the importer left out while converting, when there were any. */
  leftOutGeometry?: number;
  /** True when the original IFC is still held, which enables IFC subset export. */
  hasSourceIfc: boolean;
  visible: boolean;
  /** Free-form origin note, e.g. the RVT conversion engine. */
  note?: string;
  /** Name of the folder or archive the model was opened with; models of one collection are listed together. */
  collection?: string;
  /** Position among the models of its collection, when that differs from the order they were opened in. */
  order?: number;
  /** Where the model sat inside that folder, e.g. "out/bam". */
  folder?: string;
  /** What the model holds, in the words of its own IfcProject. */
  description?: string;
}

export interface Task {
  id: string;
  label: string;
  phase?: string;
  /** 0..1; undefined shows an indeterminate bar. */
  progress?: number;
  detail?: string;
  cancellable?: boolean;
}

export interface Toast {
  id: string;
  kind: "info" | "success" | "error";
  message: string;
}

export interface PlanInfo {
  id: string;
  name: string;
}

export interface ViewerState {
  ready: boolean;
  engineError: string | null;
  models: ModelInfo[];
  /** Bumps whenever the set of loaded models changes; data panels key off it. */
  modelsVersion: number;
  selection: PlainIdMap;
  selectionCount: number;
  tasks: Task[];
  toasts: Toast[];
  tool: ToolId;
  navMode: NavMode;
  projection: Projection;
  grid: boolean;
  renderStyle: RenderStyle;
  /** True after something was hidden, isolated or ghosted. */
  visibilityModified: boolean;
  ghosting: boolean;
  planeCount: number;
  planesEnabled: boolean;
  measurementCount: number;
  plans: PlanInfo[];
  activePlan: string | null;
}

export const initialViewerState: ViewerState = {
  ready: false,
  engineError: null,
  models: [],
  modelsVersion: 0,
  selection: {},
  selectionCount: 0,
  tasks: [],
  toasts: [],
  tool: "select",
  navMode: "Orbit",
  projection: "Perspective",
  grid: true,
  renderStyle: "basic",
  visibilityModified: false,
  ghosting: false,
  planeCount: 0,
  planesEnabled: true,
  measurementCount: 0,
  plans: [],
  activePlan: null,
};

export const useViewerStore = create<ViewerState>(() => ({ ...initialViewerState }));

export function resetViewerStore() {
  useViewerStore.setState({ ...initialViewerState }, true);
}

let counter = 0;
export function uid(prefix = "id") {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function pushToast(kind: Toast["kind"], message: string, ttl = kind === "error" ? 9000 : 4500) {
  const id = uid("toast");
  useViewerStore.setState((state) => ({ toasts: [...state.toasts, { id, kind, message }] }));
  setTimeout(() => dismissToast(id), ttl);
}

export function dismissToast(id: string) {
  useViewerStore.setState((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
}

export function upsertTask(task: Task) {
  useViewerStore.setState((state) => {
    const index = state.tasks.findIndex((entry) => entry.id === task.id);
    if (index === -1) return { tasks: [...state.tasks, task] };
    const tasks = state.tasks.slice();
    tasks[index] = { ...tasks[index], ...task };
    return { tasks };
  });
}

export function removeTask(id: string) {
  useViewerStore.setState((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }));
}
