"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelIndex } from "@/lib/data/model-index";
import { useEngine } from "@/lib/engine/context";
import type { PlainIdMap } from "@/lib/store";
import { prettyCategory } from "@/lib/utils/format";

interface ElementListProps {
  items: PlainIdMap;
  indexes: ModelIndex[];
  /** Optional extra text on the right of each row. */
  detail?: (modelId: string, localId: number) => string | undefined;
  className?: string;
}

const ROW_HEIGHT = 26;

/** Virtualised list of elements. Names are fetched for the rows on screen only. */
export function ElementList({ items, indexes, detail, className }: ElementListProps) {
  const engine = useEngine();
  const scrollRef = useRef<HTMLDivElement>(null);
  const names = useRef(new Map<string, string>());
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);
  const [, setVersion] = useState(0);

  // Row n belongs to the group whose [start, start + length) range contains n.
  const groups = useMemo(() => {
    const result: { modelId: string; ids: number[]; start: number; index?: ModelIndex }[] = [];
    let start = 0;
    for (const [modelId, ids] of Object.entries(items)) {
      if (ids.length === 0) continue;
      result.push({ modelId, ids, start, index: indexes.find((candidate) => candidate.modelId === modelId) });
      start += ids.length;
    }
    return { list: result, total: start };
  }, [items, indexes]);

  const locate = (position: number) => {
    for (const group of groups.list) {
      if (position < group.start + group.ids.length) return { group, localId: group.ids[position - group.start] };
    }
    return null;
  };

  const virtualizer = useVirtualizer({
    count: groups.total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const virtualRows = virtualizer.getVirtualItems();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const wanted = new Map<ModelIndex, number[]>();
    for (const virtualRow of virtualRows) {
      const located = locate(virtualRow.index);
      if (!located?.group.index) continue;
      const key = `${located.group.modelId}:${located.localId}`;
      if (names.current.has(key) || pending.current.has(key)) continue;
      pending.current.add(key);
      let list = wanted.get(located.group.index);
      if (!list) wanted.set(located.group.index, (list = []));
      list.push(located.localId);
    }
    for (const [index, ids] of wanted) {
      index
        .names(ids)
        .then((result) => {
          for (const [localId, name] of result) {
            const key = `${index.modelId}:${localId}`;
            names.current.set(key, name);
            pending.current.delete(key);
          }
          if (mounted.current) setVersion((value) => value + 1);
        })
        .catch(() => {
          for (const localId of ids) pending.current.delete(`${index.modelId}:${localId}`);
        });
    }
  });

  return (
    <div ref={scrollRef} className={`scroll-thin overflow-auto ${className ?? ""}`}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualRows.map((virtualRow) => {
          const located = locate(virtualRow.index);
          if (!located) return null;
          const { group, localId } = located;
          const row = group.index?.rowOf(localId) ?? -1;
          const category = row >= 0 && group.index ? group.index.category(row) : "";
          const name = names.current.get(`${group.modelId}:${localId}`);
          const extra = detail?.(group.modelId, localId);
          return (
            <button
              key={virtualRow.key}
              type="button"
              className="absolute left-0 right-0 flex items-center gap-2 px-3 text-left text-[12px] text-fg hover:bg-surface-2"
              style={{ top: virtualRow.start, height: ROW_HEIGHT }}
              title="Click to select · double-click to zoom"
              onClick={() => void engine?.select({ [group.modelId]: [localId] })}
              onDoubleClick={() => void engine?.fitTo({ [group.modelId]: [localId] })}
            >
              <span className="min-w-0 flex-1 truncate">{name || (name === undefined ? "…" : "(unnamed)")}</span>
              {extra ? <span className="tabular shrink-0 text-[11px] text-fg-2">{extra}</span> : null}
              <span className="shrink-0 text-[11px] text-fg-3">{prettyCategory(category)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
