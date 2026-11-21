// State of the RVT import panel. Kept outside the component so a conversion
// in flight, and the reports of finished ones, survive switching tabs.

import { create } from "zustand";
import type { ApsStatus } from "@/lib/aps/client";
import type { RvtMetadata, RvtPhase, RvtReport } from "./local";

export type RvtEngine = "local" | "cloud";

/** Revit's built-in IFC export setups. A setup saved inside the project can be typed in instead. */
export const IFC_EXPORT_SETUPS = [
  "IFC2x3 Coordination View 2.0",
  "IFC4 Reference View",
  "IFC4 Design Transfer View",
  "IFC2x3 Coordination View",
  "IFC2x3 Basic FM Handover View",
  "IFC2x3 COBie 2.4 Design Deliverable View",
  "IFC2x3 GSA Concept Design BIM 2010",
  "IFC2x2 Coordination View",
] as const;

export interface RvtConversion {
  id: string;
  fileName: string;
  fileBytes: number;
  engine: RvtEngine;
  status: "running" | "done" | "failed" | "cancelled";
  /** Short line about the step in progress. */
  step?: string;
  /** The model this conversion produced, while it is still loaded. */
  modelId: string | null;
  error?: string;
  /** The in-browser reader ran out of memory. */
  outOfMemory?: boolean;
  /** In-browser reader only. */
  report?: RvtReport;
  phases?: RvtPhase[];
  phase?: string | number | null;
  metadata?: RvtMetadata | null;
  /** Cloud conversion only. */
  exportSetup?: string;
  cloudMessages?: string[];
  ifcBytes?: number;
  elapsedMs?: number;
  /** Kept so the file can be read again with another phase or engine without re-picking it. */
  file: File;
}

interface RvtState {
  engine: RvtEngine;
  largeModel: boolean;
  savedMeshes: boolean;
  exportSetup: string;
  deleteCloudCopy: boolean;
  aps: ApsStatus | null;
  conversions: RvtConversion[];
}

export const useRvtStore = create<RvtState>(() => ({
  engine: "local",
  largeModel: false,
  savedMeshes: true,
  exportSetup: IFC_EXPORT_SETUPS[0],
  deleteCloudCopy: true,
  aps: null,
  conversions: [],
}));

export function addConversion(conversion: RvtConversion) {
  useRvtStore.setState((state) => ({ conversions: [conversion, ...state.conversions] }));
}

export function updateConversion(id: string, patch: Partial<RvtConversion>) {
  useRvtStore.setState((state) => ({ conversions: state.conversions.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) }));
}

export function removeConversion(id: string) {
  useRvtStore.setState((state) => ({ conversions: state.conversions.filter((entry) => entry.id !== id) }));
}

export function resetRvtStore() {
  useRvtStore.setState({ conversions: [] });
}
