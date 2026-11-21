// What the "Open folder" dialog shows: the models found in a folder, which
// copy of each would be opened, and what a first look into them says.

import { create } from "zustand";
import type { ModelKind } from "./plan.mjs";

export interface PlanRow {
  key: string;
  /** File name of the copy that would be opened. */
  name: string;
  /** Folder inside the opened folder; "" for its top level. */
  folder: string;
  kind: ModelKind;
  size: number;
  /** Bytes of IFC that opening this model converts: its unpacked size, or 0 for a .frag. */
  convertBytes: number;
  /** Other copies of the same model that are left alone, e.g. [".ifczip"]. */
  otherCopies: string[];
  /** Why this copy was picked, when that needs saying. */
  note: string;
  selected: boolean;
  /** True once the user has ticked or unticked the row: later findings then leave the choice alone. */
  touched: boolean;
  scan: "waiting" | "done" | "failed" | "skipped";
  schema: string;
  elements: number | null;
  description: string;
  /** Set when the model only repeats what other models hold. */
  repeat: { kind: "same" | "part" | "combined"; of: string[]; shared: number; total: number } | null;
}

export interface FolderPlan {
  name: string;
  rows: PlanRow[];
  /** True while the models are still being looked into. */
  analysing: boolean;
  scannedBytes: number;
  totalBytes: number;
  revit: number;
  navisworks: number;
}

export const useFolderStore = create<{ plan: FolderPlan | null }>(() => ({ plan: null }));
