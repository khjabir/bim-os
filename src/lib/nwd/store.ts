// State of the NWD page. The viewer session itself is held by the page
// component; this store carries what the panels display.

import { create } from "zustand";
import type { ApsStatus } from "@/lib/aps/client";
import type { ModelSummary, PickLevel } from "@/lib/lmv/session";

export interface RecentModel {
  name: string;
  urn: string;
  region: string | null;
  bytes: number;
  /** Upload time, ms since epoch. Cloud copies expire 24 hours after this. */
  at: number;
}

export type NwdPhase = "idle" | "uploading" | "translating" | "loading" | "ready" | "error";

interface NwdState {
  aps: ApsStatus | null;
  phase: NwdPhase;
  step: string | null;
  progress: number | undefined;
  error: string | null;
  modelName: string | null;
  /** URN of the open cloud model; null for the sample. */
  urn: string | null;
  summary: ModelSummary | null;
  /** Selected elements (not raw picks): what Export and the buttons act on. */
  selection: number[];
  pickLevel: PickLevel;
  hiddenObjects: boolean;
  materialProperties: boolean;
  recent: RecentModel[];
}

const RECENT_KEY = "ifc-studio-nwd-recent";
const DAY = 24 * 60 * 60 * 1000;

export function loadRecent(): RecentModel[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as RecentModel[];
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.urn === "string" && Date.now() - entry.at < DAY) : [];
  } catch {
    return [];
  }
}

function saveRecent(recent: RecentModel[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 12)));
  } catch {
    // Storage is a convenience only.
  }
}

export const useNwdStore = create<NwdState>(() => ({
  aps: null,
  phase: "idle",
  step: null,
  progress: undefined,
  error: null,
  modelName: null,
  urn: null,
  summary: null,
  selection: [],
  pickLevel: "object",
  hiddenObjects: false,
  materialProperties: true,
  recent: [],
}));

export function rememberModel(model: RecentModel) {
  useNwdStore.setState((state) => {
    const recent = [model, ...state.recent.filter((entry) => entry.urn !== model.urn)];
    saveRecent(recent);
    return { recent };
  });
}

export function forgetModel(urn: string) {
  useNwdStore.setState((state) => {
    const recent = state.recent.filter((entry) => entry.urn !== urn);
    saveRecent(recent);
    return { recent };
  });
}
