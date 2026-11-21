"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { Box, Building, Building2, ChevronRight, Crosshair, EyeOff, Focus, Layers, MapPin, SquareStack } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IndexGate } from "@/components/ui/IndexGate";
import { Button } from "@/components/ui/primitives";
import type { ModelIndex, SpatialNode } from "@/lib/data/model-index";
import { useModelIndexes } from "@/lib/data/use-model-index";
import { useEngine } from "@/lib/engine/context";
import { useViewerStore } from "@/lib/store";
import { formatCount, prettyCategory } from "@/lib/utils/format";

interface Row {
  id: string;
  modelId: string;
  index: ModelIndex;
  /** null for the per-model root row. */
  node: SpatialNode | null;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

const ROW_HEIGHT = 26;
const AUTO_EXPAND = new Set(["IFCPROJECT", "IFCSITE", "IFCBUILDING", "MODEL"]);

function rowId(modelId: string, node: SpatialNode | null) {
  return node ? `${modelId}:${node.key}` : `${modelId}:root`;
}

function collectElementIds(index: ModelIndex, node: SpatialNode): number[] {
  const ids: number[] = [];
  const stack: SpatialNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as SpatialNode;
    if (current.kind === "item" && current.localId !== null && index.rowOf(current.localId) >= 0) ids.push(current.localId);
    for (const child of current.children) stack.push(child);
  }
  return ids;
}

function iconFor(node: SpatialNode | null) {
  if (!node) return <SquareStack size={13} />;
  if (node.kind === "group") return <Layers size={13} />;
  switch (node.category) {
    case "IFCPROJECT":
      return <SquareStack size={13} />;
    case "IFCSITE":
      return <MapPin size={13} />;
    case "IFCBUILDING":
      return <Building2 size={13} />;
    case "IFCBUILDINGSTOREY":
      return <Building size={13} />;
    default:
      return <Box size={13} />;
  }
}

export function TreePanel() {
  const engine = useEngine();
  const hasModels = useViewerStore((state) => state.models.length > 0);
  const state = useModelIndexes(hasModels);
  return (
    <IndexGate state={state} hasModels={hasModels} emptyHint="Open a model to browse its spatial structure: site, building, storeys and the elements inside them.">
      {engine ? <Tree indexes={state.indexes} /> : null}
    </IndexGate>
  );
}

function Tree({ indexes }: { indexes: ModelIndex[] }) {
  const engine = useEngine();
  const modelNames = useViewerStore((state) => state.models);
  const selection = useViewerStore((state) => state.selection);
  const selectionCount = useViewerStore((state) => state.selectionCount);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [, setNameVersion] = useState(0);
  const names = useRef(new Map<string, string>());
  const pending = useRef(new Set<string>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeRow, setActiveRow] = useState<string | null>(null);

  // Open the project / site / building levels of every model by default.
  useEffect(() => {
    setExpanded((previous) => {
      const next = new Set(previous);
      for (const index of indexes) {
        const root = rowId(index.modelId, null);
        if (next.has(root)) continue;
        next.add(root);
        const stack = index.tree ? [index.tree] : [];
        while (stack.length > 0) {
          const node = stack.pop() as SpatialNode;
          if (!AUTO_EXPAND.has(node.category)) continue;
          next.add(rowId(index.modelId, node));
          for (const child of node.children) stack.push(child);
        }
      }
      return next;
    });
  }, [indexes]);

  const rows = useMemo(() => {
    const result: Row[] = [];
    for (const index of indexes) {
      const rootId = rowId(index.modelId, null);
      const rootOpen = expanded.has(rootId);
      result.push({ id: rootId, modelId: index.modelId, index, node: null, depth: 0, hasChildren: Boolean(index.tree), expanded: rootOpen });
      if (!rootOpen || !index.tree) continue;
      const stack: { node: SpatialNode; depth: number }[] = [{ node: index.tree, depth: 1 }];
      while (stack.length > 0) {
        const { node, depth } = stack.pop() as { node: SpatialNode; depth: number };
        const id = rowId(index.modelId, node);
        const open = expanded.has(id);
        result.push({ id, modelId: index.modelId, index, node, depth, hasChildren: node.children.length > 0, expanded: open });
        if (open) for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1 });
      }
    }
    return result;
  }, [indexes, expanded]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const virtualRows = virtualizer.getVirtualItems();

  // Fetch the names of the rows on screen, one batch per model. Runs after
  // every render; rows that are already named or requested are skipped.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const wanted = new Map<ModelIndex, number[]>();
    for (const virtualRow of virtualRows) {
      const row = rows[virtualRow.index];
      const localId = row?.node?.kind === "item" ? row.node.localId : null;
      if (!row || localId === null || localId === undefined) continue;
      const key = `${row.modelId}:${localId}`;
      if (names.current.has(key) || pending.current.has(key)) continue;
      pending.current.add(key);
      let list = wanted.get(row.index);
      if (!list) wanted.set(row.index, (list = []));
      list.push(localId);
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
          if (mounted.current) setNameVersion((value) => value + 1);
        })
        .catch(() => {
          for (const localId of ids) pending.current.delete(`${index.modelId}:${localId}`);
        });
    }
  });

  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const idsOf = useCallback((row: Row) => {
    if (!row.node) return Array.from(row.index.ids);
    return collectElementIds(row.index, row.node);
  }, []);

  const labelOf = (row: Row) => {
    if (!row.node) return modelNames.find((model) => model.id === row.modelId)?.name ?? row.modelId;
    if (row.node.kind === "group") return prettyCategory(row.node.category);
    const name = names.current.get(`${row.modelId}:${row.node.localId}`);
    return name ? name : prettyCategory(row.node.category);
  };

  // Reveal the single selected element: open its ancestors and scroll to it.
  const reveal = useCallback(() => {
    const entry = Object.entries(selection)[0];
    if (!entry) return;
    const [modelId, ids] = entry;
    const index = indexes.find((candidate) => candidate.modelId === modelId);
    if (!index?.tree) return;
    const target = ids[0];
    const path: SpatialNode[] = [];
    const search = (node: SpatialNode): boolean => {
      path.push(node);
      if (node.kind === "item" && node.localId === target) return true;
      for (const child of node.children) if (search(child)) return true;
      path.pop();
      return false;
    };
    if (!search(index.tree)) return;
    const targetId = rowId(modelId, path[path.length - 1]);
    setExpanded((previous) => {
      const next = new Set(previous);
      next.add(rowId(modelId, null));
      for (const node of path.slice(0, -1)) next.add(rowId(modelId, node));
      return next;
    });
    setActiveRow(targetId);
    // Wait for the rows to be rebuilt before scrolling to the target.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const position = rowsRef.current.findIndex((row) => row.id === targetId);
        if (position >= 0) virtualizer.scrollToIndex(position, { align: "center" });
      }),
    );
  }, [selection, indexes, virtualizer]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  if (!engine) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <Button size="sm" icon={<Crosshair size={12} />} disabled={selectionCount !== 1} onClick={reveal} title="Find the selected element in the tree">
          Reveal selection
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setExpanded(new Set(indexes.map((index) => rowId(index.modelId, null))))}
          title="Collapse every level"
        >
          Collapse
        </Button>
      </div>
      <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-auto" role="tree" aria-label="Spatial structure">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            const count = row.node ? row.node.elementCount : row.index.count;
            const isLeaf = row.node?.kind === "item" && !row.hasChildren;
            return (
              <div
                key={row.id}
                role="treeitem"
                aria-expanded={row.hasChildren ? row.expanded : undefined}
                aria-selected={activeRow === row.id}
                className={clsx(
                  "group absolute left-0 right-0 flex items-center gap-1 pr-1 text-[12px]",
                  activeRow === row.id ? "bg-accent-soft text-accent" : "text-fg hover:bg-surface-2",
                )}
                style={{ top: virtualRow.start, height: ROW_HEIGHT, paddingLeft: 6 + row.depth * 12 }}
              >
                <button
                  type="button"
                  aria-label={row.expanded ? "Collapse" : "Expand"}
                  tabIndex={row.hasChildren ? 0 : -1}
                  onClick={() => row.hasChildren && toggle(row.id)}
                  className={clsx("grid size-4 shrink-0 place-items-center rounded text-fg-3 hover:bg-surface-3", !row.hasChildren && "invisible")}
                >
                  <ChevronRight size={12} className={clsx("transition-transform", row.expanded && "rotate-90")} />
                </button>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
                  title="Click to select · double-click to zoom"
                  onClick={() => {
                    setActiveRow(row.id);
                    const ids = idsOf(row);
                    if (ids.length > 0) void engine.select({ [row.modelId]: ids });
                  }}
                  onDoubleClick={() => {
                    const ids = idsOf(row);
                    if (ids.length > 0) void engine.fitTo({ [row.modelId]: ids });
                  }}
                >
                  <span className={clsx("shrink-0", activeRow === row.id ? "text-accent" : "text-fg-3")}>{iconFor(row.node)}</span>
                  <span className={clsx("min-w-0 truncate", row.node?.kind === "group" && "text-fg-2", !row.node && "font-semibold")}>{labelOf(row)}</span>
                  {!isLeaf && count > 0 ? <span className="tabular shrink-0 text-[11px] text-fg-3">{formatCount(count)}</span> : null}
                </button>
                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <button
                    type="button"
                    title="Isolate"
                    aria-label="Isolate"
                    className="grid size-5 place-items-center rounded text-fg-3 hover:bg-surface-3 hover:text-fg"
                    onClick={() => {
                      const ids = idsOf(row);
                      if (ids.length > 0) void engine.isolate({ [row.modelId]: ids });
                    }}
                  >
                    <Focus size={12} />
                  </button>
                  <button
                    type="button"
                    title="Hide"
                    aria-label="Hide"
                    className="grid size-5 place-items-center rounded text-fg-3 hover:bg-surface-3 hover:text-fg"
                    onClick={() => {
                      const ids = idsOf(row);
                      if (ids.length > 0) void engine.hide({ [row.modelId]: ids });
                    }}
                  >
                    <EyeOff size={12} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
