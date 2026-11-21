"use client";

import type { ReactNode } from "react";
import { Database } from "lucide-react";
import type { IndexState } from "@/lib/data/use-model-index";
import { EmptyState, ProgressBar } from "./primitives";

/** Shared loading / empty / error states for panels that need the model index. */
export function IndexGate({ state, hasModels, children, emptyTitle = "No model loaded", emptyHint }: { state: IndexState; hasModels: boolean; children: ReactNode; emptyTitle?: string; emptyHint?: ReactNode }) {
  if (!hasModels) {
    return (
      <EmptyState icon={<Database size={26} strokeWidth={1.5} />} title={emptyTitle}>
        {emptyHint ?? "Open a model to use this panel."}
      </EmptyState>
    );
  }
  if (state.error) return <div className="p-3 text-[12px] text-bad">Could not read the model data: {state.error}</div>;
  if (state.loading || state.indexes.length === 0) {
    return (
      <div className="p-3">
        <div className="mb-1.5 flex justify-between text-[12px] text-fg-2">
          <span>Indexing model data</span>
          <span className="tabular text-fg-3">{Math.round(state.progress * 100)}%</span>
        </div>
        <ProgressBar value={state.progress} />
        <div className="mt-1.5 text-[11.5px] text-fg-3">{state.stage || "Preparing"} · done once per model</div>
      </div>
    );
  }
  return <>{children}</>;
}
