"use client";

import { useEffect, useState } from "react";
import { useEngine } from "@/lib/engine/context";
import { useViewerStore } from "@/lib/store";
import { getModelIndex, type ModelIndex } from "./model-index";

export interface IndexState {
  /** One index per loaded model, in load order. Empty until ready. */
  indexes: ModelIndex[];
  loading: boolean;
  /** 0..1 across all models being indexed. */
  progress: number;
  stage: string;
  error: string | null;
}

/**
 * Builds (or reuses) the element index of every loaded model. Panels that
 * analyse whole models call this; the index itself is cached per model, so
 * several panels share one build.
 */
export function useModelIndexes(enabled = true): IndexState {
  const engine = useEngine();
  const version = useViewerStore((state) => state.modelsVersion);
  const [state, setState] = useState<IndexState>({ indexes: [], loading: false, progress: 0, stage: "", error: null });

  useEffect(() => {
    if (!engine || !enabled) return;
    const models = engine.models;
    if (models.length === 0) {
      setState({ indexes: [], loading: false, progress: 0, stage: "", error: null });
      return;
    }
    let cancelled = false;
    setState((previous) => ({ ...previous, loading: true, progress: 0, stage: "Indexing", error: null }));
    (async () => {
      const indexes: ModelIndex[] = [];
      for (let i = 0; i < models.length; i++) {
        const index = await getModelIndex(models[i], (fraction, stage) => {
          if (!cancelled) setState((previous) => ({ ...previous, loading: true, progress: (i + fraction) / models.length, stage }));
        });
        indexes.push(index);
      }
      if (!cancelled) setState({ indexes, loading: false, progress: 1, stage: "", error: null });
    })().catch((reason: unknown) => {
      if (!cancelled) setState({ indexes: [], loading: false, progress: 0, stage: "", error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => {
      cancelled = true;
    };
  }, [engine, version, enabled]);

  return state;
}
