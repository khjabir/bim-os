"use client";

import clsx from "clsx";
import { ArrowDown, ArrowUp, Calculator, Download } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { RankedBars } from "@/components/charts/RankedBars";
import { IndexGate } from "@/components/ui/IndexGate";
import { Button, Callout, FieldLabel, ProgressBar, Segmented, Select } from "@/components/ui/primitives";
import { FACET_LABEL, type GroupFacet } from "@/lib/analysis/grouping";
import {
  computeMeshVolumes,
  getModelQuantities,
  MEASURE_LABEL,
  MEASURE_UNIT,
  quantityGroups,
  type Measure,
  type ModelQuantities,
  type QuantityGroup,
} from "@/lib/analysis/quantities";
import type { ModelIndex } from "@/lib/data/model-index";
import { useModelIndexes } from "@/lib/data/use-model-index";
import { useEngine } from "@/lib/engine/context";
import { useViewerStore } from "@/lib/store";
import { downloadCsv } from "@/lib/utils/download";
import { formatCount, formatNumber, prettyCategory } from "@/lib/utils/format";

const FACETS: GroupFacet[] = ["class", "storey", "type", "material", "model"];
const FACET_PHRASE: Record<GroupFacet, string> = {
  class: "IFC class",
  storey: "storey",
  type: "type",
  material: "material",
  classification: "classification",
  model: "model",
  property: "property value",
};
const MEASURES: Measure[] = ["count", "volume", "area", "length"];

export function QuantitiesPanel() {
  const hasModels = useViewerStore((state) => state.models.length > 0);
  const state = useModelIndexes(hasModels);
  return (
    <IndexGate state={state} hasModels={hasModels} emptyHint="Open a model to take off counts, volumes, areas and lengths by class, storey, type or material.">
      <QuantitiesBody indexes={state.indexes} />
    </IndexGate>
  );
}

function compact(value: number, measure: Measure) {
  if (measure === "count") return formatCount(value);
  return formatNumber(value, value >= 100 ? 0 : value >= 10 ? 1 : 2);
}

type SortKey = "label" | Measure | "meshVolume";

function QuantitiesBody({ indexes }: { indexes: ModelIndex[] }) {
  const engine = useEngine();
  const models = useViewerStore((state) => state.models);
  const selection = useViewerStore((state) => state.selection);
  const selectionCount = useViewerStore((state) => state.selectionCount);
  const [facet, setFacet] = useState<GroupFacet>("class");
  const [measure, setMeasure] = useState<Measure>("count");
  const [scope, setScope] = useState<"all" | "selection">("all");
  const [quantities, setQuantities] = useState<ModelQuantities[] | null>(null);
  const [groups, setGroups] = useState<QuantityGroup[] | null>(null);
  const [progress, setProgress] = useState<{ fraction: number; stage: string } | null>(null);
  const [meshProgress, setMeshProgress] = useState<number | null>(null);
  const [hasMesh, setHasMesh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "count", descending: true });
  const token = useRef(0);

  const modelNames = useMemo(() => Object.fromEntries(models.map((model) => [model.id, model.name])), [models]);
  const effectiveScope = scope === "selection" && selectionCount > 0 ? selection : undefined;

  // 1. Read quantities once per model.
  useEffect(() => {
    let cancelled = false;
    setQuantities(null);
    setError(null);
    (async () => {
      const result: ModelQuantities[] = [];
      for (let i = 0; i < indexes.length; i++) {
        result.push(
          await getModelQuantities(indexes[i], {
            includeProperties: true,
            onProgress: (fraction, stage) => {
              if (!cancelled) setProgress({ fraction: (i + fraction) / indexes.length, stage });
            },
          }),
        );
      }
      if (!cancelled) {
        setQuantities(result);
        setProgress(null);
      }
    })().catch((reason: unknown) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setProgress(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [indexes]);

  // 2. Group them.
  useEffect(() => {
    if (!quantities) return;
    const run = ++token.current;
    setHasMesh(false);
    quantityGroups(quantities, facet, { scope: effectiveScope, modelNames })
      .then((result) => {
        if (run === token.current) setGroups(result);
      })
      .catch((reason: unknown) => {
        if (run === token.current) setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [quantities, facet, effectiveScope, modelNames]);

  const sorted = useMemo(() => {
    const list = [...(groups ?? [])];
    const direction = sort.descending ? -1 : 1;
    list.sort((a, b) => {
      if (sort.key === "label") return direction * a.label.localeCompare(b.label);
      const av = sort.key === "meshVolume" ? (a.meshVolume ?? 0) : a[sort.key];
      const bv = sort.key === "meshVolume" ? (b.meshVolume ?? 0) : b[sort.key];
      return direction * (av - bv) || a.label.localeCompare(b.label);
    });
    return list;
  }, [groups, sort]);

  const totals = useMemo(() => {
    const total = { count: 0, volume: 0, area: 0, length: 0, meshVolume: 0 };
    // Sum over elements, not groups: with materials an element can sit in several groups.
    if (!quantities) return total;
    for (const model of quantities) {
      const scoped = effectiveScope ? new Set(effectiveScope[model.index.modelId] ?? []) : null;
      for (let row = 0; row < model.index.count; row++) {
        if (scoped && !scoped.has(model.index.ids[row])) continue;
        total.count += 1;
        if (Number.isFinite(model.volume[row])) total.volume += model.volume[row];
        if (Number.isFinite(model.area[row])) total.area += model.area[row];
        if (Number.isFinite(model.length[row])) total.length += model.length[row];
      }
    }
    for (const group of groups ?? []) total.meshVolume += group.meshVolume ?? 0;
    return total;
  }, [quantities, groups, effectiveScope]);

  const coverage = useMemo(() => {
    const sum = { fromQuantitySets: 0, fromProperties: 0, none: 0, total: 0 };
    for (const model of quantities ?? []) {
      sum.fromQuantitySets += model.coverage.fromQuantitySets;
      sum.fromProperties += model.coverage.fromProperties;
      sum.none += model.coverage.none;
      sum.total += model.index.count;
    }
    return sum;
  }, [quantities]);

  const runMeshVolumes = async () => {
    if (!groups) return;
    setMeshProgress(0);
    try {
      await computeMeshVolumes(groups, indexes, setMeshProgress);
      setGroups([...groups]);
      setHasMesh(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMeshProgress(null);
    }
  };

  const exportGroups = () => {
    const header = [FACET_LABEL[facet], "Count", "Volume (m3)", "Area (m2)", "Length (m)", ...(hasMesh ? ["Mesh volume (m3)"] : [])];
    const rows = sorted.map((group) => [group.label, group.count, round(group.volume), round(group.area), round(group.length), ...(hasMesh ? [round(group.meshVolume ?? 0)] : [])]);
    downloadCsv(header, rows, `quantities-by-${facet}.csv`);
  };

  const exportSchedule = async () => {
    if (!quantities) return;
    const rows: (string | number | null)[][] = [];
    for (const model of quantities) {
      const { index } = model;
      const scoped = effectiveScope ? new Set(effectiveScope[index.modelId] ?? []) : null;
      const ids = Array.from(index.ids).filter((id) => !scoped || scoped.has(id));
      const typeIds = new Set<number>();
      for (const id of ids) {
        const type = index.typeOf[index.rowOf(id)];
        if (type >= 0) typeIds.add(type);
      }
      const [names, typeNames, guids] = await Promise.all([index.names(ids), index.names(typeIds), index.model.getGuidsByLocalIds(ids)]);
      ids.forEach((id, position) => {
        const row = index.rowOf(id);
        const type = index.typeOf[row];
        rows.push([
          modelNames[index.modelId] ?? index.modelId,
          guids[position] ?? "",
          id,
          prettyCategory(index.category(row)),
          names.get(id) ?? "",
          index.storeyName(index.storeyOf[row]),
          type >= 0 ? (typeNames.get(type) ?? "") : "",
          value(model.volume[row]),
          value(model.area[row]),
          value(model.length[row]),
        ]);
      });
    }
    downloadCsv(["Model", "GlobalId", "ExpressId", "Class", "Name", "Storey", "Type", "Volume (m3)", "Area (m2)", "Length (m)"], rows, "element-schedule.csv");
  };

  if (error) return <div className="p-3 text-[12px] text-bad">{error}</div>;
  if (!quantities || !groups) {
    return (
      <div className="p-3">
        <div className="mb-1.5 flex justify-between text-[12px] text-fg-2">
          <span>Reading quantities</span>
          <span className="tabular text-fg-3">{Math.round((progress?.fraction ?? 0) * 100)}%</span>
        </div>
        <ProgressBar value={progress?.fraction} />
        <div className="mt-1.5 text-[11.5px] text-fg-3">{progress?.stage ?? "Preparing"}</div>
      </div>
    );
  }

  const covered = coverage.fromQuantitySets + coverage.fromProperties;
  const columns: { key: SortKey; label: string; unit?: string }[] = [
    { key: "count", label: "Count" },
    { key: "volume", label: "Volume", unit: "m³" },
    { key: "area", label: "Area", unit: "m²" },
    { key: "length", label: "Length", unit: "m" },
    ...(hasMesh ? [{ key: "meshVolume" as const, label: "Mesh vol.", unit: "m³" }] : []),
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <FieldLabel htmlFor="qto-facet">Group by</FieldLabel>
            <Select id="qto-facet" value={facet} onChange={(event) => setFacet(event.target.value as GroupFacet)}>
              {FACETS.map((entry) => (
                <option key={entry} value={entry}>
                  {FACET_LABEL[entry]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <FieldLabel>Scope</FieldLabel>
            <Segmented
              className="w-full"
              value={scope === "selection" && selectionCount > 0 ? "selection" : "all"}
              onChange={(next) => setScope(next)}
              options={[
                { value: "all", label: "All" },
                { value: "selection", label: `Selection${selectionCount > 0 ? ` (${formatCount(selectionCount)})` : ""}`, title: selectionCount === 0 ? "Select elements first" : undefined },
              ]}
            />
          </div>
        </div>
        <div className="mt-2">
          <FieldLabel>Chart</FieldLabel>
          <Segmented className="w-full" value={measure} onChange={setMeasure} options={MEASURES.map((entry) => ({ value: entry, label: MEASURE_LABEL[entry] }))} />
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <RankedBars
          title={`${MEASURE_LABEL[measure]} by ${FACET_PHRASE[facet]}`}
          unit={MEASURE_UNIT[measure] || "elements"}
          data={(groups ?? []).map((group) => ({ key: group.key, label: group.label, value: group[measure], note: measure === "count" ? undefined : `${formatCount(group.count)} elements` }))}
          format={(amount) => compact(amount, measure)}
          onPick={(datum) => {
            const group = groups.find((entry) => entry.key === datum.key);
            if (group) void engine?.select(group.items);
          }}
        />

        {covered < coverage.total ? (
          <div className="px-3 pb-2">
            <Callout tone={covered === 0 ? "warn" : "info"}>
              {covered === 0 ? "This model carries no quantities. " : `${formatCount(covered)} of ${formatCount(coverage.total)} elements carry quantities (${formatCount(coverage.fromQuantitySets)} from quantity sets, ${formatCount(coverage.fromProperties)} from measured properties). `}
              Volumes can also be computed from the geometry.
            </Callout>
          </div>
        ) : null}

        <div className="border-t border-line">
          <table className="w-full table-fixed border-collapse text-[12px]">
            <colgroup>
              <col />
              {columns.map((column) => (
                <col key={column.key} style={{ width: column.key === "count" ? 52 : 60 }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="border-b border-line text-fg-3">
                <SortHeader label={FACET_LABEL[facet]} sortKey="label" sort={sort} onSort={setSort} align="left" />
                {columns.map((column) => (
                  <SortHeader key={column.key} label={column.label} unit={column.unit} sortKey={column.key} sort={sort} onSort={setSort} align="right" />
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((group) => (
                <tr key={group.key} className="cursor-pointer border-b border-line/70 hover:bg-surface-2" onClick={() => void engine?.select(group.items)} title="Click to select these elements">
                  <td className="break-words py-1.5 pl-3 pr-2 text-fg">{group.label}</td>
                  <td className="tabular px-2 py-1.5 text-right text-fg">{formatCount(group.count)}</td>
                  <NumberCell amount={group.volume} covered={group.covered.volume} count={group.count} />
                  <NumberCell amount={group.area} covered={group.covered.area} count={group.count} />
                  <NumberCell amount={group.length} covered={group.covered.length} count={group.count} last={!hasMesh} />
                  {hasMesh ? <td className="tabular py-1.5 pl-2 pr-3 text-right text-fg">{compact(group.meshVolume ?? 0, "volume")}</td> : null}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold text-fg">
                <td className="py-1.5 pl-3 pr-2">Total</td>
                <td className="tabular px-2 py-1.5 text-right">{formatCount(totals.count)}</td>
                <td className="tabular px-2 py-1.5 text-right">{compact(totals.volume, "volume")}</td>
                <td className="tabular px-2 py-1.5 text-right">{compact(totals.area, "area")}</td>
                <td className={clsx("tabular py-1.5 pl-2 text-right", hasMesh ? "pr-2" : "pr-3")}>{compact(totals.length, "length")}</td>
                {hasMesh ? <td className="tabular py-1.5 pl-2 pr-3 text-right">{compact(totals.meshVolume, "volume")}</td> : null}
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="px-3 py-2 text-[11.5px] leading-relaxed text-fg-3">
          Values are in SI units. A lighter figure means only part of the group carries that quantity. With grouping by material an element counts once per material, so rows can add up to more than the total.
        </p>
      </div>

      <div className="border-t border-line p-3">
        {meshProgress !== null ? (
          <div className="mb-2">
            <div className="mb-1 flex justify-between text-[11.5px] text-fg-3">
              <span>Computing volumes from geometry</span>
              <span className="tabular">{Math.round(meshProgress * 100)}%</span>
            </div>
            <ProgressBar value={meshProgress} />
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" icon={<Calculator size={12} />} disabled={meshProgress !== null} onClick={() => void runMeshVolumes()} title="Computes each group's solid volume from the 3D geometry">
            Mesh volumes
          </Button>
          <Button size="sm" icon={<Download size={12} />} onClick={exportGroups}>
            Table CSV
          </Button>
          <Button size="sm" icon={<Download size={12} />} onClick={() => void exportSchedule()} title="One row per element with class, name, storey, type and quantities">
            Schedule CSV
          </Button>
        </div>
      </div>
    </div>
  );
}

function round(amount: number) {
  return Math.round(amount * 1000) / 1000;
}

function value(amount: number) {
  return Number.isFinite(amount) ? round(amount) : null;
}

function NumberCell({ amount, covered, count, last }: { amount: number; covered: number; count: number; last?: boolean }) {
  const partial = covered > 0 && covered < count;
  return (
    <td
      className={clsx("tabular py-1.5 pl-2 text-right", last ? "pr-3" : "pr-2", covered === 0 ? "text-fg-3" : partial ? "text-fg-2" : "text-fg")}
      title={covered === 0 ? "No element in this group carries this quantity" : partial ? `${formatCount(covered)} of ${formatCount(count)} elements carry this quantity` : undefined}
    >
      {covered === 0 ? "–" : formatNumber(amount, amount >= 100 ? 0 : amount >= 10 ? 1 : 2)}
    </td>
  );
}

function SortHeader({ label, unit, sortKey, sort, onSort, align }: { label: string; unit?: string; sortKey: SortKey; sort: { key: SortKey; descending: boolean }; onSort: (next: { key: SortKey; descending: boolean }) => void; align: "left" | "right" }) {
  const active = sort.key === sortKey;
  return (
    <th scope="col" aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"} className={clsx("py-1.5 text-[11px] font-medium", align === "left" ? "pl-3 pr-2 text-left" : "px-2 text-right last:pr-3")}>
      <button
        type="button"
        onClick={() => onSort({ key: sortKey, descending: active ? !sort.descending : sortKey !== "label" })}
        className={clsx("inline-flex items-center gap-0.5 hover:text-fg", active && "text-fg")}
      >
        {label}
        {unit ? <span className="font-normal text-fg-3">{unit}</span> : null}
        {active ? sort.descending ? <ArrowDown size={10} /> : <ArrowUp size={10} /> : null}
      </button>
    </th>
  );
}
