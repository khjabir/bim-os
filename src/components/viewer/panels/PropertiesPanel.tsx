"use client";

import { Check, Copy, Download, Focus, MousePointerClick, Scan } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Section } from "@/components/ui/Section";
import { Badge, Button, EmptyState, Input, Spinner } from "@/components/ui/primitives";
import type { PsetContent } from "@/lib/data/model-index";
import { detailsToRows, getElementDetails, type AttributeRow, type ElementDetails, type LinkedItem } from "@/lib/data/properties";
import { getModelUnits, SI_UNITS, unitForType, type ModelUnits } from "@/lib/data/units";
import { useEngine } from "@/lib/engine/context";
import { useViewerStore } from "@/lib/store";
import { downloadCsv } from "@/lib/utils/download";
import { formatCount, formatNumber, ifcClassName, prettyCategory, sanitizeFileName } from "@/lib/utils/format";

export function PropertiesPanel() {
  const selection = useViewerStore((state) => state.selection);
  const count = useViewerStore((state) => state.selectionCount);

  if (count === 0) {
    return (
      <EmptyState icon={<MousePointerClick size={26} strokeWidth={1.5} />} title="Nothing selected">
        Click an element in the 3D view or the tree to see its attributes, property sets, quantities and materials.
      </EmptyState>
    );
  }
  if (count === 1) {
    const [modelId, ids] = Object.entries(selection)[0];
    return <SingleElement key={`${modelId}:${ids[0]}`} modelId={modelId} localId={ids[0]} />;
  }
  return <MultiSelection />;
}

// ---------------------------------------------------------------------------

function displayValue(value: string | number | boolean | null, type: string | undefined, units: ModelUnits): string {
  if (value === null || value === "") return "–";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    const unit = unitForType(type, units);
    return unit ? `${formatNumber(value, 3)} ${unit}` : formatNumber(value, 4);
  }
  return value;
}

function matches(filter: string, ...parts: (string | number | boolean | null | undefined)[]) {
  if (!filter) return true;
  return parts.some((part) => part !== null && part !== undefined && String(part).toLowerCase().includes(filter));
}

function PropertyRows({ rows, units, filter }: { rows: AttributeRow[]; units: ModelUnits; filter: string }) {
  const visible = rows.filter((row) => matches(filter, row.name, row.value));
  if (visible.length === 0) return null;
  return (
    <dl className="px-3">
      {visible.map((row, index) => (
        <div key={`${row.name}-${index}`} className="grid grid-cols-[minmax(0,42%)_minmax(0,1fr)] gap-2 border-t border-line/70 py-1 first:border-t-0">
          <dt className="truncate text-[12px] text-fg-3" title={row.name}>
            {row.name}
          </dt>
          <dd className="tabular break-words text-[12px] text-fg" title={row.type ? ifcClassName(row.type) : undefined}>
            {displayValue(row.value, row.type, units)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SetSection({ set, units, filter, prefix }: { set: PsetContent; units: ModelUnits; filter: string; prefix?: string }) {
  const rows = set.props.map((prop) => ({ name: prop.name, value: prop.value, type: prop.type }));
  const setMatches = matches(filter, set.name);
  const visible = setMatches ? rows : rows.filter((row) => matches(filter, row.name, row.value));
  if (visible.length === 0 && filter) return null;
  return (
    <Section title={prefix ? `${prefix} · ${set.name}` : set.name} count={visible.length} defaultOpen>
      {visible.length === 0 ? <p className="px-3 text-[12px] text-fg-3">Empty set.</p> : <PropertyRows rows={visible} units={units} filter="" />}
    </Section>
  );
}

function LinkedList({ items, modelId }: { items: LinkedItem[]; modelId: string }) {
  const engine = useEngine();
  return (
    <ul className="px-3">
      {items.map((item) => (
        <li key={item.localId} className="flex items-center gap-2 border-t border-line/70 py-1 first:border-t-0">
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg" title={item.name}>
            {item.name || `#${item.localId}`}
          </span>
          <span className="shrink-0 text-[11px] text-fg-3">{prettyCategory(item.category)}</span>
          <button
            type="button"
            className="shrink-0 rounded px-1 text-[11px] font-medium text-accent hover:bg-accent-soft"
            onClick={() => void engine?.select({ [modelId]: [item.localId] }, { zoom: false })}
          >
            Select
          </button>
        </li>
      ))}
    </ul>
  );
}

function SingleElement({ modelId, localId }: { modelId: string; localId: number }) {
  const engine = useEngine();
  const [details, setDetails] = useState<ElementDetails | null>(null);
  const [units, setUnits] = useState<ModelUnits>(SI_UNITS);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const model = engine?.getModel(modelId);
    if (!model) return;
    let cancelled = false;
    setDetails(null);
    setError(null);
    Promise.all([getElementDetails(model, localId), getModelUnits(model)])
      .then(([result, modelUnits]) => {
        if (cancelled) return;
        setUnits(modelUnits);
        if (result) setDetails(result);
        else setError("This item has no readable data.");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [engine, modelId, localId]);

  const needle = filter.trim().toLowerCase();
  const modelName = useViewerStore((state) => state.models.find((model) => model.id === modelId)?.name ?? modelId);

  if (error) return <div className="p-3 text-[12px] text-bad">{error}</div>;
  if (!details) {
    return (
      <div className="flex items-center gap-2 p-3 text-[12px] text-fg-3">
        <Spinner /> Reading properties…
      </div>
    );
  }

  const map = { [modelId]: [localId] };
  const copyGuid = async () => {
    if (!details.guid) return;
    try {
      await navigator.clipboard.writeText(details.guid);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };
  const exportCsv = () =>
    downloadCsv(["Group", "Name", "Value", "Type"], detailsToRows(details), `${sanitizeFileName(details.name || `element-${localId}`)}-properties.csv`);

  const location: AttributeRow[] = [];
  if (details.container) location.push({ name: prettyCategory(details.container.category), value: details.container.name || `#${details.container.localId}` });
  if (details.parent) location.push({ name: `Part of (${prettyCategory(details.parent.category)})`, value: details.parent.name || `#${details.parent.localId}` });
  location.push({ name: "Model", value: modelName });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="break-words text-[13px] font-semibold leading-snug text-fg">{details.name || "(unnamed element)"}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <Badge tone="accent">{ifcClassName(details.category)}</Badge>
              <Badge>#{details.localId}</Badge>
            </div>
          </div>
        </div>
        {details.guid ? (
          <button type="button" onClick={copyGuid} title="Copy GlobalId" className="mt-2 flex w-full items-center gap-1.5 rounded border border-line bg-surface-2 px-2 py-1 text-left font-mono text-[11px] text-fg-2 hover:border-line-strong">
            <span className="min-w-0 flex-1 truncate">{details.guid}</span>
            {copied ? <Check size={12} className="shrink-0 text-ok" /> : <Copy size={12} className="shrink-0 text-fg-3" />}
          </button>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" icon={<Scan size={12} />} onClick={() => void engine?.fitTo(map)}>
            Zoom
          </Button>
          <Button size="sm" icon={<Focus size={12} />} onClick={() => void engine?.isolate(map)}>
            Isolate
          </Button>
          <Button size="sm" icon={<Download size={12} />} onClick={exportCsv}>
            CSV
          </Button>
        </div>
        <Input className="mt-2" placeholder="Filter properties…" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter properties" />
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <Section title="Attributes" count={details.attributes.length}>
          <PropertyRows rows={details.attributes} units={units} filter={needle} />
        </Section>
        <Section title="Location">
          <PropertyRows rows={location} units={units} filter={needle} />
        </Section>
        {details.type ? (
          <Section title="Type" count={ifcClassName(details.type.category)}>
            <PropertyRows rows={details.type.attributes} units={units} filter={needle} />
          </Section>
        ) : null}
        {details.materials.length > 0 ? (
          <Section title="Materials" count={details.materials.length}>
            <PropertyRows rows={details.materials.map((material) => ({ name: material.detail ?? "Material", value: material.name }))} units={units} filter={needle} />
          </Section>
        ) : null}
        {details.classifications.length > 0 ? (
          <Section title="Classification" count={details.classifications.length}>
            <PropertyRows
              rows={details.classifications.map((entry) => ({ name: entry.system ?? "Reference", value: [entry.code, entry.name].filter(Boolean).join(" · ") || entry.location || "–" }))}
              units={units}
              filter={needle}
            />
          </Section>
        ) : null}
        {details.qsets.map((set) => (
          <SetSection key={set.localId} set={set} units={units} filter={needle} />
        ))}
        {details.psets.map((set) => (
          <SetSection key={set.localId} set={set} units={units} filter={needle} />
        ))}
        {details.type?.psets.map((set) => <SetSection key={`type-${set.localId}`} set={set} units={units} filter={needle} prefix="Type" />)}
        {details.related.map((group) => (
          <Section key={group.label} title={group.label} count={group.items.length}>
            <LinkedList items={group.items} modelId={modelId} />
          </Section>
        ))}
        {details.parts.length > 0 ? (
          <Section title="Parts" count={details.parts.length} defaultOpen={false}>
            <LinkedList items={details.parts} modelId={modelId} />
          </Section>
        ) : null}
        {details.groups.length > 0 ? (
          <Section title="Groups and systems" count={details.groups.length}>
            <PropertyRows rows={details.groups.map((group) => ({ name: prettyCategory(group.category), value: group.name || `#${group.localId}` }))} units={units} filter={needle} />
          </Section>
        ) : null}
        {details.psets.length === 0 && details.qsets.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-fg-3">This element has no property or quantity sets.</p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const LIST_LIMIT = 3000;

interface ListedItem {
  modelId: string;
  localId: number;
  category: string;
  name: string;
}

function MultiSelection() {
  const engine = useEngine();
  const selection = useViewerStore((state) => state.selection);
  const count = useViewerStore((state) => state.selectionCount);
  const [items, setItems] = useState<ListedItem[] | null>(null);

  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    setItems(null);
    (async () => {
      const listed: ListedItem[] = [];
      for (const [modelId, ids] of Object.entries(selection)) {
        const model = engine.getModel(modelId);
        if (!model) continue;
        const slice = ids.slice(0, Math.max(0, LIST_LIMIT - listed.length));
        if (slice.length === 0) break;
        const data = await model.getItemsData(slice, {
          attributesDefault: false,
          attributes: ["Name"],
          relationsDefault: { attributes: false, relations: false },
        });
        for (let i = 0; i < slice.length; i++) {
          const item = data[i];
          listed.push({
            modelId,
            localId: slice[i],
            category: String((item?._category as { value?: unknown } | undefined)?.value ?? ""),
            name: String((item?.Name as { value?: unknown } | undefined)?.value ?? ""),
          });
        }
      }
      if (!cancelled) setItems(listed);
    })().catch(() => {
      if (!cancelled) setItems([]);
    });
    return () => {
      cancelled = true;
    };
  }, [engine, selection]);

  const byClass = useMemo(() => {
    const groups = new Map<string, ListedItem[]>();
    for (const item of items ?? []) {
      let list = groups.get(item.category);
      if (!list) groups.set(item.category, (list = []));
      list.push(item);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [items]);

  const truncated = count > LIST_LIMIT;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-3">
        <div className="text-[13px] font-semibold text-fg">{formatCount(count)} elements selected</div>
        <p className="mt-1 text-[12px] leading-relaxed text-fg-3">
          Use Export in the 3D view to write the selection as IFC or Fragments. Pick a single element to see its properties.
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" icon={<Scan size={12} />} onClick={() => void engine?.fitTo(selection)}>
            Zoom
          </Button>
          <Button size="sm" icon={<Focus size={12} />} onClick={() => void engine?.isolate(selection)}>
            Isolate
          </Button>
        </div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {!items ? (
          <div className="flex items-center gap-2 p-3 text-[12px] text-fg-3">
            <Spinner /> Listing selection…
          </div>
        ) : (
          <>
            {truncated ? <p className="px-3 pt-2 text-[11.5px] text-fg-3">Showing the first {formatCount(LIST_LIMIT)} of {formatCount(count)}.</p> : null}
            {byClass.map(([category, list]) => (
              <Section key={category} title={prettyCategory(category)} count={list.length} defaultOpen={byClass.length <= 3}>
                <div className="px-3 pb-1">
                  <Button size="sm" onClick={() => void engine?.select(groupToMap(list))}>
                    Select only these
                  </Button>
                </div>
                <ul className="px-3">
                  {list.slice(0, 200).map((item) => (
                    <li key={`${item.modelId}:${item.localId}`} className="border-t border-line/70 first:border-t-0">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 py-1 text-left hover:text-accent"
                        onClick={() => void engine?.select({ [item.modelId]: [item.localId] })}
                      >
                        <span className="min-w-0 flex-1 truncate text-[12px]">{item.name || "(unnamed)"}</span>
                        <span className="tabular shrink-0 text-[11px] text-fg-3">#{item.localId}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {list.length > 200 ? <p className="px-3 pt-1 text-[11.5px] text-fg-3">+ {formatCount(list.length - 200)} more</p> : null}
              </Section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function groupToMap(items: ListedItem[]) {
  const map: Record<string, number[]> = {};
  for (const item of items) (map[item.modelId] ??= []).push(item.localId);
  return map;
}
