"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeftRight, Download, Play, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IndexGate } from "@/components/ui/IndexGate";
import { Button, Callout, FieldLabel, Input, ProgressBar, Segmented, Select } from "@/components/ui/primitives";
import { detectClashes, isCancelled, type Clash, type ClashMode, type ClashReport } from "@/lib/analysis/clash";
import type { ModelIndex } from "@/lib/data/model-index";
import { useModelIndexes } from "@/lib/data/use-model-index";
import { useEngine } from "@/lib/engine/context";
import type { PlainIdMap } from "@/lib/store";
import { useViewerStore } from "@/lib/store";
import { downloadCsv } from "@/lib/utils/download";
import { formatCount, formatDuration, prettyCategory } from "@/lib/utils/format";
import { MultiPick } from "./SearchPanel";

type SetSource = "classes" | "selection" | "all";

interface SetDraft {
  source: SetSource;
  classes: string[];
  /** Snapshot of the selection taken when "Use selection" was pressed. */
  selection: PlainIdMap;
}

const STRUCTURE = /^IFC(BEAM|COLUMN|FOOTING|PILE|SLAB|WALL|MEMBER|PLATE|REINFORCING|ROOF|STAIR|RAMP)/;
const SERVICES = /^IFC(FLOW|DUCT|PIPE|CABLE|AIRTERMINAL|SANITARYTERMINAL|LIGHTFIXTURE|ELECTRIC|ENERGYCONVERSION|DISTRIBUTION|VALVE|PUMP|FAN|BOILER|CHILLER|COIL|DAMPER|FIRESUPPRESSION|OUTLET|SWITCHINGDEVICE|JUNCTIONBOX|UNITARY|SPACEHEATER|TANK|WASTETERMINAL|STACKTERMINAL)/;

export function ClashPanel() {
  const hasModels = useViewerStore((state) => state.models.length > 0);
  const state = useModelIndexes(hasModels);
  return (
    <IndexGate state={state} hasModels={hasModels} emptyHint="Open one or more models to find elements that intersect or sit too close together, for example structure against services.">
      <ClashBody indexes={state.indexes} />
    </IndexGate>
  );
}

function resolveSet(draft: SetDraft, indexes: ModelIndex[]): PlainIdMap {
  if (draft.source === "selection") return draft.selection;
  const result: PlainIdMap = {};
  for (const index of indexes) {
    const ids: number[] = [];
    const wanted = draft.source === "all" ? null : new Set(draft.classes);
    for (let row = 0; row < index.count; row++) {
      const category = index.category(row);
      // Spaces and openings are volumes, not objects: they would clash with everything inside them.
      if (category === "IFCSPACE" || category === "IFCOPENINGELEMENT" || category === "IFCSITE") {
        if (!wanted?.has(category)) continue;
      }
      if (!wanted || wanted.has(category)) ids.push(index.ids[row]);
    }
    if (ids.length > 0) result[index.modelId] = ids;
  }
  return result;
}

function sizeOf(map: PlainIdMap) {
  let total = 0;
  for (const ids of Object.values(map)) total += ids.length;
  return total;
}

function ClashBody({ indexes }: { indexes: ModelIndex[] }) {
  const engine = useEngine();
  const selection = useViewerStore((state) => state.selection);
  const selectionCount = useViewerStore((state) => state.selectionCount);
  const classes = useMemo(() => [...new Set(indexes.flatMap((index) => index.categories))].sort(), [indexes]);
  const classOptions = useMemo(() => classes.map((value) => ({ value, label: prettyCategory(value) })), [classes]);

  const [setA, setSetA] = useState<SetDraft>({ source: "classes", classes: [], selection: {} });
  const [setB, setSetB] = useState<SetDraft>({ source: "classes", classes: [], selection: {} });
  const [mode, setMode] = useState<ClashMode>("hard");
  const [toleranceMm, setToleranceMm] = useState("10");
  const [clearanceMm, setClearanceMm] = useState("50");
  const [precise, setPrecise] = useState(true);
  const [ignoreRelated, setIgnoreRelated] = useState(true);
  const [report, setReport] = useState<ClashReport | null>(null);
  const [progress, setProgress] = useState<{ fraction: number; stage: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  // Offer a sensible starting point: structure against services when both exist.
  useEffect(() => {
    const structure = classes.filter((category) => STRUCTURE.test(category));
    const services = classes.filter((category) => SERVICES.test(category));
    setSetA({ source: "classes", classes: services.length > 0 ? structure : [], selection: {} });
    setSetB({ source: "classes", classes: services, selection: {} });
    setReport(null);
    setActive(null);
  }, [classes]);

  useEffect(() => () => abort.current?.abort(), []);

  const idsA = useMemo(() => resolveSet(setA, indexes), [setA, indexes]);
  const idsB = useMemo(() => resolveSet(setB, indexes), [setB, indexes]);
  const countA = sizeOf(idsA);
  const countB = sizeOf(idsB);

  const run = async () => {
    setError(null);
    setReport(null);
    setActive(null);
    const controller = new AbortController();
    abort.current = controller;
    setProgress({ fraction: 0, stage: "Starting" });
    try {
      const result = await detectClashes(indexes, idsA, idsB, {
        mode,
        tolerance: Math.max(0, Number(toleranceMm) || 0) / 1000,
        clearance: Math.max(0, Number(clearanceMm) || 0) / 1000,
        precise,
        ignoreRelated,
        maxResults: 5000,
        signal: controller.signal,
        onProgress: (fraction, stage) => setProgress({ fraction, stage }),
      });
      setReport(result);
    } catch (reason) {
      if (!isCancelled(reason)) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };

  const focus = async (clash: Clash, position: number) => {
    if (!engine) return;
    setActive(position);
    const items: PlainIdMap = {};
    (items[clash.a.modelId] ??= []).push(clash.a.localId);
    (items[clash.b.modelId] ??= []).push(clash.b.localId);
    await engine.select(items);
    await engine.ghostExcept(items);
    await engine.fitTo(items);
  };

  const exportCsv = async () => {
    if (!report) return;
    const byModel = new Map(indexes.map((index) => [index.modelId, index]));
    const wanted = new Map<string, Set<number>>();
    for (const clash of report.clashes) {
      for (const element of [clash.a, clash.b]) {
        let ids = wanted.get(element.modelId);
        if (!ids) wanted.set(element.modelId, (ids = new Set()));
        ids.add(element.localId);
      }
    }
    const names = new Map<string, string>();
    const guids = new Map<string, string>();
    for (const [modelId, ids] of wanted) {
      const index = byModel.get(modelId);
      if (!index) continue;
      const list = [...ids];
      const [nameMap, guidList] = await Promise.all([index.names(list), index.model.getGuidsByLocalIds(list)]);
      list.forEach((id, i) => {
        names.set(`${modelId}:${id}`, nameMap.get(id) ?? "");
        guids.set(`${modelId}:${id}`, guidList[i] ?? "");
      });
    }
    const describe = (element: Clash["a"]) => {
      const index = byModel.get(element.modelId);
      const row = index?.rowOf(element.localId) ?? -1;
      const key = `${element.modelId}:${element.localId}`;
      return [element.modelId, guids.get(key) ?? "", index && row >= 0 ? prettyCategory(index.category(row)) : "", names.get(key) ?? "", index && row >= 0 ? index.storeyName(index.storeyOf[row]) : ""];
    };
    const rows = report.clashes.map((clash, i) => [i + 1, ...describe(clash.a), ...describe(clash.b), Math.round(clash.distance * 1000), ...clash.center.map((value) => Math.round(value * 1000) / 1000)]);
    downloadCsv(
      ["#", "A model", "A GlobalId", "A class", "A name", "A storey", "B model", "B GlobalId", "B class", "B name", "B storey", mode === "hard" ? "Overlap (mm)" : "Gap (mm)", "X", "Y", "Z"],
      rows,
      "clashes.csv",
    );
  };

  const swap = () => {
    setSetA(setB);
    setSetB(setA);
  };

  const pairs = countA * countB;
  const disabled = countA === 0 || countB === 0 || progress !== null;

  return (
    <div className="flex h-full flex-col">
      <div className="scroll-thin max-h-[58%] shrink-0 overflow-y-auto border-b border-line p-3">
        <SetEditor label="Set A" draft={setA} onChange={setSetA} classOptions={classOptions} count={countA} selection={selection} selectionCount={selectionCount} />
        <div className="my-2 flex justify-center">
          <button type="button" onClick={swap} title="Swap sets" aria-label="Swap sets" className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-surface-2 hover:text-fg">
            <ArrowLeftRight size={13} className="rotate-90" />
          </button>
        </div>
        <SetEditor label="Set B" draft={setB} onChange={setSetB} classOptions={classOptions} count={countB} selection={selection} selectionCount={selectionCount} />

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <FieldLabel>Type</FieldLabel>
            <Segmented
              className="w-full"
              value={mode}
              onChange={setMode}
              options={[
                { value: "hard", label: "Hard", title: "Elements whose geometry intersects" },
                { value: "clearance", label: "Clearance", title: "Elements closer than a minimum distance" },
              ]}
            />
          </div>
          <div>
            <FieldLabel htmlFor="clash-distance">{mode === "hard" ? "Ignore below (mm)" : "Minimum gap (mm)"}</FieldLabel>
            {mode === "hard" ? (
              <Input id="clash-distance" inputMode="decimal" value={toleranceMm} onChange={(event) => setToleranceMm(event.target.value)} />
            ) : (
              <Input id="clash-distance" inputMode="decimal" value={clearanceMm} onChange={(event) => setClearanceMm(event.target.value)} />
            )}
          </div>
        </div>
        <label className="mt-2 flex items-start gap-2 text-[12px] text-fg-2">
          <input type="checkbox" className="mt-0.5" checked={precise} onChange={(event) => setPrecise(event.target.checked)} />
          <span>
            Check real geometry <span className="text-fg-3">(slower; without it, overlapping bounding boxes count as clashes)</span>
          </span>
        </label>
        <label className="mt-1.5 flex items-start gap-2 text-[12px] text-fg-2">
          <input type="checkbox" className="mt-0.5" checked={ignoreRelated} onChange={(event) => setIgnoreRelated(event.target.checked)} />
          <span>
            Ignore hosted and sibling elements <span className="text-fg-3">(a door in its wall, parts of one stair)</span>
          </span>
        </label>

        <div className="mt-3 flex items-center gap-2">
          {progress ? (
            <Button variant="danger" icon={<Square size={12} />} onClick={() => abort.current?.abort()}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" icon={<Play size={13} />} disabled={disabled} onClick={() => void run()}>
              Find clashes
            </Button>
          )}
          <span className="tabular text-[11.5px] text-fg-3">
            {formatCount(countA)} × {formatCount(countB)} elements
          </span>
        </div>
        {pairs > 4e9 ? <Callout tone="warn" className="mt-2">These sets are very large. Narrow them by class or storey for a faster, more useful result.</Callout> : null}
        {progress ? (
          <div className="mt-2">
            <ProgressBar value={progress.fraction} />
            <div className="mt-1 text-[11.5px] text-fg-3">{progress.stage}</div>
          </div>
        ) : null}
        {error ? <p className="mt-2 text-[12px] text-bad">{error}</p> : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {report ? (
          <>
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium text-fg">
                  {formatCount(report.clashes.length)} clash{report.clashes.length === 1 ? "" : "es"}
                  {report.truncated ? " (limit reached)" : ""}
                </div>
                <div className="text-[11.5px] text-fg-3">
                  {formatCount(report.candidates)} box overlaps checked in {formatDuration(report.elapsedMs)}
                </div>
              </div>
              <Button size="sm" icon={<Download size={12} />} disabled={report.clashes.length === 0} onClick={() => void exportCsv()}>
                CSV
              </Button>
            </div>
            {report.clashes.length > 0 ? (
              <ClashList clashes={report.clashes} indexes={indexes} mode={mode} active={active} onPick={(clash, position) => void focus(clash, position)} />
            ) : (
              <p className="p-3 text-[12px] text-fg-3">No clashes between these sets with the current settings.</p>
            )}
          </>
        ) : !progress ? (
          <p className="p-3 text-[12px] leading-relaxed text-fg-3">
            Choose two sets and press Find clashes. Click a result to isolate the pair in 3D; use Show everything in the toolbar to return to the full model.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SetEditor({
  label,
  draft,
  onChange,
  classOptions,
  count,
  selection,
  selectionCount,
}: {
  label: string;
  draft: SetDraft;
  onChange: (draft: SetDraft) => void;
  classOptions: { value: string; label: string }[];
  count: number;
  selection: PlainIdMap;
  selectionCount: number;
}) {
  return (
    <div className="rounded-md border border-line bg-surface-2 p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{label}</span>
        <span className="tabular text-[11.5px] text-fg-2">{formatCount(count)} elements</span>
      </div>
      <Select value={draft.source} onChange={(event) => onChange({ ...draft, source: event.target.value as SetSource, selection: event.target.value === "selection" ? selection : draft.selection })} aria-label={`${label} source`}>
        <option value="classes">By class</option>
        <option value="selection">Current selection{selectionCount > 0 ? ` (${formatCount(selectionCount)})` : ""}</option>
        <option value="all">Everything</option>
      </Select>
      {draft.source === "classes" ? (
        <div className="mt-1.5">
          <MultiPick options={classOptions} values={draft.classes} onChange={(values) => onChange({ ...draft, classes: values })} placeholder="Add a class" />
        </div>
      ) : null}
      {draft.source === "selection" ? (
        <div className="mt-1.5 flex items-center gap-2">
          <Button size="sm" disabled={selectionCount === 0} onClick={() => onChange({ ...draft, selection })}>
            Use current selection
          </Button>
          {count === 0 ? <span className="text-[11.5px] text-fg-3">Select elements in 3D first</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function ClashList({ clashes, indexes, mode, active, onPick }: { clashes: Clash[]; indexes: ModelIndex[]; mode: ClashMode; active: number | null; onPick: (clash: Clash, position: number) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const byModel = useMemo(() => new Map(indexes.map((index) => [index.modelId, index])), [indexes]);
  const names = useRef(new Map<string, string>());
  const pending = useRef(new Set<string>());
  const [, setVersion] = useState(0);
  const virtualizer = useVirtualizer({ count: clashes.length, getScrollElement: () => scrollRef.current, estimateSize: () => 44, overscan: 8 });
  const rows = virtualizer.getVirtualItems();

  useEffect(() => {
    const wanted = new Map<ModelIndex, number[]>();
    for (const row of rows) {
      const clash = clashes[row.index];
      if (!clash) continue;
      for (const element of [clash.a, clash.b]) {
        const key = `${element.modelId}:${element.localId}`;
        const index = byModel.get(element.modelId);
        if (!index || names.current.has(key) || pending.current.has(key)) continue;
        pending.current.add(key);
        let list = wanted.get(index);
        if (!list) wanted.set(index, (list = []));
        list.push(element.localId);
      }
    }
    for (const [index, ids] of wanted) {
      void index.names(ids).then((result) => {
        for (const [id, name] of result) {
          names.current.set(`${index.modelId}:${id}`, name);
          pending.current.delete(`${index.modelId}:${id}`);
        }
        setVersion((value) => value + 1);
      });
    }
  });

  const describe = (element: Clash["a"]) => {
    const index = byModel.get(element.modelId);
    const row = index?.rowOf(element.localId) ?? -1;
    const category = index && row >= 0 ? prettyCategory(index.category(row)) : "Element";
    const name = names.current.get(`${element.modelId}:${element.localId}`);
    return name ? `${category} · ${name}` : category;
  };

  return (
    <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {rows.map((row) => {
          const clash = clashes[row.index];
          return (
            <button
              key={row.key}
              type="button"
              onClick={() => onPick(clash, row.index)}
              className={`absolute left-0 right-0 flex items-center gap-2 border-b border-line/70 px-3 text-left ${active === row.index ? "bg-accent-soft" : "hover:bg-surface-2"}`}
              style={{ top: row.start, height: 44 }}
            >
              <span className="tabular w-8 shrink-0 text-[11px] text-fg-3">{row.index + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-fg">{describe(clash.a)}</span>
                <span className="block truncate text-[12px] text-fg-2">{describe(clash.b)}</span>
              </span>
              <span className="tabular shrink-0 text-right text-[11.5px] text-fg-2" title={mode === "hard" ? "Depth of the overlap between the bounding boxes" : "Distance between the two elements"}>
                {Math.round(clash.distance * 1000)} mm
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
