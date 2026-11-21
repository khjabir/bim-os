"use client";

// The asset register: one search box with field filters (kind:pump
// floor:L03 status:incomplete), facets that write those filters, a fast list
// for tens of thousands of assets, selection for bulk changes, and the asset
// itself in a side panel (?asset=<GlobalId>).

import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { ArrowDown, ArrowUp, CheckCircle2, Download, FileSpreadsheet, Pencil, QrCode, Search, Wrench, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "@/components/ui/Menu";
import { Button } from "@/components/ui/primitives";
import { pushToast } from "@/lib/store";
import { downloadBlob, downloadCsv } from "@/lib/utils/download";
import { completeness, statusOf, valueOf } from "@/lib/fm/asset";
import { assetTable, assetWorkbook } from "@/lib/fm/export";
import { assetHay, filterText, matchesAsset, parseAssetQuery, FILTER_FIELDS } from "@/lib/fm/filter";
import { fileStem } from "@/lib/fm/package";
import { useFm } from "@/lib/fm/store";
import type { Asset } from "@/lib/fm/types";
import { WorkOrderDialog } from "../WorkOrderDialog";
import { AssetStatusBadge, compact, SidePanel, useParam, WorkspaceGate } from "../ui";
import { AssetDetail } from "./AssetDetail";
import { BulkEditDialog, VerifyDialog } from "./BulkDialogs";
import { setLabelQueue } from "../labels/queue";

export function AssetsPage() {
  return (
    <WorkspaceGate what="The asset register">
      <Register />
    </WorkspaceGate>
  );
}

type SortKey = "code" | "name" | "kind" | "floor" | "room" | "maker" | "model" | "serial" | "status";
const SORT_VALUE: Record<SortKey, (a: Asset) => string> = {
  code: (a) => valueOf(a, "code"),
  name: (a) => valueOf(a, "name"),
  kind: (a) => a.kind,
  floor: (a) => valueOf(a, "floor"),
  room: (a) => valueOf(a, "space"),
  maker: (a) => valueOf(a, "manufacturer"),
  model: (a) => valueOf(a, "model"),
  serial: (a) => valueOf(a, "serialNumber"),
  status: (a) => statusOf(a),
};
const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "code", label: "Code" },
  { key: "name", label: "Name" },
  { key: "kind", label: "Kind" },
  { key: "floor", label: "Floor" },
  { key: "room", label: "Room" },
  { key: "maker", label: "Manufacturer" },
  { key: "model", label: "Model" },
  { key: "serial", label: "Serial no." },
  { key: "status", label: "Status" },
];
const GRID = "32px minmax(130px,1fr) minmax(170px,1.6fr) minmax(120px,1fr) minmax(110px,0.9fr) minmax(90px,0.8fr) minmax(110px,1fr) minmax(100px,0.9fr) minmax(100px,0.9fr) 118px";

/** The query with one field's filter replaced (or removed). */
function withFilter(query: string, field: string, value: string | null): string {
  const re = new RegExp(`(^|\\s)${field}:("[^"]*"|\\S+)`, "gi");
  const rest = query.replace(re, " ").replace(/\s+/g, " ").trim();
  return value === null ? rest : `${rest} ${filterText(field, value)}`.trim();
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return narrow;
}

function Register() {
  const router = useRouter();
  const facility = useFm((s) => s.facility);
  const assets = useFm((s) => s.assets);
  const [q, setQ] = useParam("q");
  const [assetId, setAssetId] = useParam("asset");
  const [exportParam, setExportParam] = useParam("export");
  const [text, setText] = useState(q);
  const deferred = useDeferredValue(text);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "code", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<"edit" | "verify" | "wo" | null>(null);
  const narrow = useNarrow();

  // The box follows the address (links from search and Home), and the address follows the box.
  const lastPushed = useRef(q);
  useEffect(() => {
    if (q !== lastPushed.current) {
      lastPushed.current = q;
      setText(q);
    }
  }, [q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== lastPushed.current) {
        lastPushed.current = text;
        setQ(text || null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [text, setQ]);

  const hays = useMemo(() => new Map(assets.map((a) => [a.id, assetHay(a)])), [assets]);
  const query = useMemo(() => parseAssetQuery(deferred), [deferred]);
  const filtered = useMemo(() => (query.words.length || query.filters.length ? assets.filter((a) => matchesAsset(a, query, hays.get(a.id) ?? "")) : assets), [assets, query, hays]);
  const sorted = useMemo(() => {
    if (sort.key === "code" && sort.dir === 1) return filtered;
    const get = SORT_VALUE[sort.key];
    return [...filtered].sort((a, b) => sort.dir * (get(a).localeCompare(get(b), undefined, { numeric: true }) || valueOf(a, "code").localeCompare(valueOf(b, "code"), undefined, { numeric: true })));
  }, [filtered, sort]);

  const facets = useMemo(() => {
    const count = (values: string[]) => {
      const m = new Map<string, number>();
      for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
      return [...m].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    };
    return {
      floor: count(assets.map((a) => valueOf(a, "floor"))),
      kind: count(assets.map((a) => a.kind)),
      discipline: count(assets.map((a) => a.discipline)),
    };
  }, [assets]);
  const active = useMemo(() => new Map(parseAssetQuery(text).filters.map((f) => [f.field, f.value])), [text]);

  // Export from a link (?export=xlsx), once.
  useEffect(() => {
    if (exportParam !== "xlsx") return;
    setExportParam(null);
    void exportXlsx(sorted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportParam]);

  async function exportXlsx(list: Asset[]) {
    pushToast("info", `Writing ${list.length.toLocaleString()} assets to Excel…`);
    const blob = await assetWorkbook(facility, list);
    downloadBlob(blob, `${fileStem(facility?.name ?? "facility", "assets")}.xlsx`);
  }
  const exportCsv = (list: Asset[]) => {
    const { header, rows } = assetTable(list);
    downloadCsv(header, rows, `${fileStem(facility?.name ?? "facility", "assets")}.csv`);
  };

  const ids = [...selected];
  const allSelected = sorted.length > 0 && sorted.every((a) => selected.has(a.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = narrow ? 64 : 36;
  const virtualizer = useVirtualizer({ count: sorted.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowHeight, overscan: 12 });
  useEffect(() => virtualizer.measure(), [rowHeight, virtualizer]);

  const pct = Math.round(completeness(filtered) * 100);
  const open = assetId ? assets.find((a) => a.id === assetId) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex flex-col gap-3 border-b border-line bg-surface px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight text-fg">Assets</h1>
            <p className="text-[12px] text-fg-2">
              {sorted.length === assets.length ? `${assets.length.toLocaleString()} assets` : `${sorted.length.toLocaleString()} of ${assets.length.toLocaleString()} assets`} · {pct}% of key information filled
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button icon={<QrCode size={14} />} onClick={() => {
              setLabelQueue(selected.size ? ids : sorted.map((a) => a.id));
              router.push("/labels?from=assets");
            }}>
              {selected.size ? `Labels for ${compact(selected.size)}` : "Print labels"}
            </Button>
            <Menu
              align="end"
              trigger={({ toggle: t }) => (
                <Button icon={<Download size={14} />} onClick={t}>
                  Export
                </Button>
              )}
              items={[
                { label: `Excel, ${selected.size ? `${selected.size} selected` : `${sorted.length.toLocaleString()} shown`}`, icon: <FileSpreadsheet size={14} />, onSelect: () => void exportXlsx(selected.size ? sorted.filter((a) => selected.has(a.id)) : sorted) },
                { label: "CSV, same assets", icon: <Download size={14} />, onSelect: () => exportCsv(selected.size ? sorted.filter((a) => selected.has(a.id)) : sorted) },
                "separator",
                { label: "Excel, all assets", icon: <FileSpreadsheet size={14} />, onSelect: () => void exportXlsx(assets) },
              ]}
            />
          </div>
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent">
            <Search size={14} className="shrink-0 text-fg-3" />
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search, or filter: kind:pump floor:L03 room:214 maker:daikin status:incomplete missing:serial"
              className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none focus-ring-none placeholder:text-fg-3"
              aria-label="Search and filter assets"
              spellCheck={false}
            />
            {text ? (
              <button type="button" onClick={() => setText("")} aria-label="Clear" className="rounded p-0.5 text-fg-3 hover:bg-surface-2 hover:text-fg">
                <X size={13} />
              </button>
            ) : null}
          </label>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Facet label="Floor" field="floor" options={facets.floor} value={active.get("floor")} onChange={(v) => setText(withFilter(text, "floor", v))} />
            <Facet label="Kind" field="kind" options={facets.kind} value={active.get("kind")} onChange={(v) => setText(withFilter(text, "kind", v))} />
            <Facet label="Discipline" field="discipline" options={facets.discipline} value={active.get("discipline")} onChange={(v) => setText(withFilter(text, "discipline", v))} />
            <Facet
              label="Status"
              field="status"
              options={[
                ["incomplete", 0],
                ["complete", 0],
                ["edited", 0],
                ["verified", 0],
              ]}
              labels={{ incomplete: "Missing data", complete: "From model, complete", edited: "Edited", verified: "Checked on site" }}
              value={active.get("status")}
              onChange={(v) => setText(withFilter(text, "status", v))}
            />
          </div>
        </div>
        {query.filters.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {query.filters.map((f) => (
              <span key={`${f.field}:${f.value}`} className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent-soft py-0.5 pl-2 pr-1 text-[11.5px] text-accent">
                {FILTER_FIELDS[f.field]?.label ?? f.field}: {f.value || "any"}
                <button type="button" aria-label="Remove filter" onClick={() => setText(withFilter(text, f.field, null))} className="rounded-full p-0.5 hover:bg-accent/15">
                  <X size={11} />
                </button>
              </span>
            ))}
            <button type="button" onClick={() => setText(query.words.join(" "))} className="text-[11.5px] text-fg-3 hover:text-fg">
              Clear filters
            </button>
          </div>
        ) : null}
      </div>

      {selected.size ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-3 py-1.5 sm:px-4">
          <span className="text-[12.5px] font-medium text-fg">{selected.size.toLocaleString()} selected</span>
          <Button size="sm" icon={<Pencil size={12} />} onClick={() => setDialog("edit")}>
            Edit a field
          </Button>
          <Button size="sm" icon={<CheckCircle2 size={12} />} onClick={() => setDialog("verify")}>
            Mark checked on site
          </Button>
          <Button size="sm" icon={<Wrench size={12} />} disabled={selected.size > 200} title={selected.size > 200 ? "Select up to 200 assets for one work order" : undefined} onClick={() => setDialog("wo")}>
            New work order
          </Button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-[12px] text-fg-2 hover:text-fg">
            Clear selection
          </button>
        </div>
      ) : null}

      <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <div className="px-4 py-12 text-center text-[12.5px] text-fg-3">
            No assets match <span className="font-medium text-fg-2">{deferred}</span>.{" "}
            <button type="button" className="text-accent hover:underline" onClick={() => setText("")}>
              Show all
            </button>
          </div>
        ) : narrow ? (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const a = sorted[v.index];
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAssetId(a.id)}
                  className="absolute inset-x-0 flex items-center gap-2 border-b border-line bg-surface px-3 text-left"
                  style={{ top: v.start, height: v.size }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-fg">{valueOf(a, "name")}</div>
                    <div className="truncate text-[11.5px] text-fg-3">{[valueOf(a, "code"), a.kind].join(" · ")}</div>
                    <div className="truncate text-[11.5px] text-fg-3">{[valueOf(a, "floor"), valueOf(a, "space")].filter(Boolean).join(" · ")}</div>
                  </div>
                  <AssetStatusBadge status={statusOf(a)} />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="min-w-[1180px]">
            <div className="sticky top-0 z-10 grid h-8 items-center border-b border-line bg-surface-2 text-[11px] font-semibold uppercase tracking-wide text-fg-3" style={{ gridTemplateColumns: GRID }}>
              <span className="grid place-items-center">
                <input
                  type="checkbox"
                  aria-label="Select all shown"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(sorted.map((a) => a.id)))}
                  className="size-3.5 accent-[var(--accent)]"
                />
              </span>
              {COLUMNS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}
                  className="flex items-center gap-1 truncate px-2 text-left hover:text-fg"
                  aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                >
                  {c.label}
                  {sort.key === c.key ? sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : null}
                </button>
              ))}
            </div>
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((v) => {
                const a = sorted[v.index];
                const isOpen = a.id === assetId;
                return (
                  <div
                    key={a.id}
                    className={clsx("absolute inset-x-0 grid cursor-pointer items-center border-b border-line text-[12.5px]", isOpen ? "bg-accent-soft" : selected.has(a.id) ? "bg-surface-2" : "bg-surface hover:bg-surface-2")}
                    style={{ top: v.start, height: v.size, gridTemplateColumns: GRID }}
                    onClick={() => setAssetId(a.id)}
                  >
                    <span className="grid place-items-center" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${valueOf(a, "name")}`} checked={selected.has(a.id)} onChange={() => toggle(a.id)} className="size-3.5 accent-[var(--accent)]" />
                    </span>
                    <Cell mono>{valueOf(a, "code")}</Cell>
                    <Cell strong>{valueOf(a, "name")}</Cell>
                    <Cell>{a.kind}</Cell>
                    <Cell>{valueOf(a, "floor")}</Cell>
                    <Cell>{valueOf(a, "space")}</Cell>
                    <Cell edited={Boolean(a.edits?.manufacturer)}>{valueOf(a, "manufacturer")}</Cell>
                    <Cell edited={Boolean(a.edits?.model)}>{valueOf(a, "model")}</Cell>
                    <Cell edited={Boolean(a.edits?.serialNumber)}>{valueOf(a, "serialNumber")}</Cell>
                    <span className="px-2">
                      <AssetStatusBadge status={statusOf(a)} />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <SidePanel open={Boolean(open)} onClose={() => setAssetId(null)} title={open ? valueOf(open, "name") : ""} subtitle={open ? [valueOf(open, "code"), open.kind].filter(Boolean).join(" · ") : ""} width={600}>
        {open ? <AssetDetail asset={open} /> : null}
      </SidePanel>
      {dialog === "edit" ? <BulkEditDialog ids={ids} onClose={() => setDialog(null)} /> : null}
      {dialog === "verify" ? <VerifyDialog ids={ids} onClose={() => setDialog(null)} /> : null}
      <WorkOrderDialog open={dialog === "wo"} onClose={() => setDialog(null)} assetIds={ids} />
    </div>
  );
}

function Cell({ children, mono, strong, edited }: { children: React.ReactNode; mono?: boolean; strong?: boolean; edited?: boolean }) {
  return (
    <span className={clsx("truncate px-2", mono && "tabular font-mono text-[11.5px] text-fg-2", strong ? "font-medium text-fg" : !mono && "text-fg-2", edited && "underline decoration-accent decoration-dotted underline-offset-2")} title={typeof children === "string" ? children : undefined}>
      {children || <span className="text-fg-3">–</span>}
    </span>
  );
}

function Facet({ label, field, options, value, onChange, labels }: { label: string; field: string; options: [string, number][]; value?: string; onChange: (value: string | null) => void; labels?: Record<string, string> }) {
  const current = value ? (options.find(([o]) => o.toLowerCase() === value)?.[0] ?? value) : "";
  return (
    <select
      aria-label={label}
      value={current}
      onChange={(e) => onChange(e.target.value || null)}
      className={clsx("h-8 min-w-0 rounded-md border bg-surface px-1.5 text-[12.5px] sm:w-[150px]", value ? "border-accent text-accent" : "border-line-strong text-fg-2")}
      data-field={field}
    >
      <option value="">{`${label}: all`}</option>
      {current && !options.some(([o]) => o === current) ? <option value={current}>{current}</option> : null}
      {options.map(([o, n]) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
          {n ? ` (${n.toLocaleString()})` : ""}
        </option>
      ))}
    </select>
  );
}
