"use client";

// The global search: pages, actions and the facility's data in one box,
// opened from the header, with Ctrl/Cmd+K or "/". Everything works from the
// keyboard: arrows move, Enter opens, Escape closes.

import clsx from "clsx";
import { Activity, ArrowRight, Box, Clock, CornerDownLeft, DoorOpen, Network, Package, Search, Sparkles, Wrench, X, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { assetMap, useFm } from "@/lib/fm/store";
import { assetItems, KIND_LABELS, norm, parseQuery, pointItems, roomItems, searchItems, systemItems, workOrderItems, type SearchItem, type SearchKind } from "@/lib/fm/search";
import { NAV_ITEMS } from "./nav";
import { toggleTheme } from "./theme";

interface SearchUi {
  open: boolean;
  query: string;
}

export const useSearchUi = create<SearchUi>(() => ({ open: false, query: "" }));

export function openSearch(query = "") {
  useSearchUi.setState({ open: true, query });
}

export function closeSearch() {
  useSearchUi.setState({ open: false });
}

/** Things to do, found by what they do. `action:` links run here instead of opening a page. */
const ACTIONS: { id: string; title: string; subtitle: string; href: string; keywords: string; common?: boolean }[] = [
  { id: "onboard", title: "Onboard a building", subtitle: "From IFC, Revit or Navisworks models", href: "/onboard", keywords: "new facility import models wizard handover setup", common: true },
  { id: "demo", title: "Try the demo building", subtitle: "A made-up office building with assets, maintenance and live data", href: "/onboard?demo=1", keywords: "sample example test" },
  { id: "new-wo", title: "New work order", subtitle: "Report a fault or plan a job", href: "/maintenance?tab=orders&new=1", keywords: "create fault reactive job ticket repair request", common: true },
  { id: "due", title: "Maintenance due", subtitle: "Overdue and due soon, and raise work orders for them", href: "/maintenance?tab=due", keywords: "ppm overdue planned raise" },
  { id: "calendar", title: "Maintenance calendar", subtitle: "The month ahead", href: "/maintenance?tab=calendar", keywords: "schedule month plan" },
  { id: "tasks", title: "Maintenance task library", subtitle: "Tasks and intervals per asset kind", href: "/maintenance?tab=library", keywords: "intervals frequency sfg20 templates" },
  { id: "scan", title: "Scan an asset label", subtitle: "Open the field app's scanner", href: "/field?scan=1", keywords: "qr camera code find", common: true },
  { id: "labels", title: "Print asset labels", subtitle: "QR labels with code, name and location", href: "/labels", keywords: "qr print tags stickers", common: true },
  { id: "incomplete", title: "Assets missing key information", subtitle: "Manufacturer, model, serial number, dates, life or room", href: "/assets?q=status:incomplete", keywords: "gaps data quality completeness missing" },
  { id: "export-assets", title: "Export the asset register", subtitle: "Excel, with the team's edits", href: "/assets?export=xlsx", keywords: "download excel xlsx csv cafm" },
  { id: "alarms", title: "Active alarms", subtitle: "Live readings out of range or gone quiet", href: "/live?tab=alarms", keywords: "alerts bms faults" },
  { id: "add-source", title: "Connect a live data source", subtitle: "An MQTT broker over WebSocket, or the simulator", href: "/live?tab=sources&add=mqtt", keywords: "mqtt bms bacnet modbus iot gateway connect" },
  { id: "import-readings", title: "Import readings from a CSV file", subtitle: "Time, point and value per row", href: "/live?tab=sources", keywords: "csv meter readings history upload" },
  { id: "brick", title: "Export the building as Brick", subtitle: "RDF / Turtle with equipment, rooms and points", href: "/live?tab=points&export=brick", keywords: "rdf turtle ontology semantic" },
  { id: "backup", title: "Back up the workspace", subtitle: "One file with everything, to keep or move to another device", href: "/settings#workspace", keywords: "export save download backup move device" },
  { id: "import-ws", title: "Import a workspace or field changes file", subtitle: "Bring in a backup or a technician's changes", href: "/settings#workspace", keywords: "restore load merge changes sync" },
  { id: "share-changes", title: "Share field changes", subtitle: "Edits, checks and photos made on this device, as a file", href: "/field?tab=sync", keywords: "sync export phone merge" },
  { id: "open-ifc", title: "Open an IFC model", subtitle: "View and analyse IFC, ifcZIP and Fragments", href: "/ifc", keywords: "3d model viewer" },
  { id: "convert", title: "Convert Revit or Navisworks to IFC", subtitle: "And an asset register in COBie and Excel", href: "/convert", keywords: "rvt nwd export cobie" },
  { id: "theme", title: "Switch between light and dark", subtitle: "Theme of this browser", href: "action:theme", keywords: "dark mode light mode theme colours" },
];

const ICONS: Record<SearchKind, LucideIcon> = {
  action: Sparkles,
  page: ArrowRight,
  asset: Package,
  room: DoorOpen,
  system: Network,
  workorder: Wrench,
  point: Activity,
};

const SCOPE_HINTS = [
  { prefix: "asset:", label: "Assets" },
  { prefix: "room:", label: "Rooms" },
  { prefix: "system:", label: "Systems" },
  { prefix: "wo:", label: "Work orders" },
  { prefix: "point:", label: "Live points" },
  { prefix: "page:", label: "Pages" },
];

const RECENT_KEY = "bimos-search-recent";

function readRecent(): SearchItem[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function remember(item: SearchItem) {
  try {
    const list = readRecent().filter((r) => !(r.kind === item.kind && r.id === item.id));
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ ...item, hay: "", keys: [] }, ...list].slice(0, 8)));
  } catch {
    /* storage unavailable */
  }
}

const pageItems: SearchItem[] = NAV_ITEMS.map((n) => ({
  kind: "page",
  id: n.href,
  title: n.label,
  subtitle: n.hint,
  href: n.href,
  hay: norm(`${n.label} ${n.hint} ${n.keywords ?? ""}`),
  keys: [norm(n.label)],
}));

const actionItems: SearchItem[] = ACTIONS.map((a) => ({
  kind: "action",
  id: a.id,
  title: a.title,
  subtitle: a.subtitle,
  href: a.href,
  hay: norm(`${a.title} ${a.subtitle} ${a.keywords}`),
  keys: [],
}));

/** Search items of the facility's data, rebuilt when the data changes (while the palette is open). */
function useDataItems(active: boolean): SearchItem[] {
  const rev = useFm((s) => s.rev);
  const [items, setItems] = useState<{ rev: number; items: SearchItem[] } | null>(null);
  useEffect(() => {
    if (!active || items?.rev === rev) return;
    const s = useFm.getState();
    const map = assetMap(s.assets);
    const name = (id: string) => map.get(id)?.name ?? id;
    setItems({ rev, items: [...assetItems(s.assets), ...roomItems(s.spaces), ...systemItems(s.systems), ...workOrderItems(s.workOrders, name), ...pointItems(s.points, name)] });
  }, [active, rev, items?.rev]);
  return items?.items ?? [];
}

interface Row {
  key: string;
  item: SearchItem;
  /** "See all" rows open a page with the query instead of one item. */
  more?: boolean;
}

export function SearchPalette() {
  const open = useSearchUi((s) => s.open);
  const initial = useSearchUi((s) => s.query);
  const router = useRouter();

  // Shortcuts: Ctrl/Cmd+K anywhere, "/" when not typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        if (useSearchUi.getState().open) closeSearch();
        else openSearch();
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const t = event.target as HTMLElement | null;
        const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
        if (!typing && !useSearchUi.getState().open) {
          event.preventDefault();
          openSearch();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;
  return <Palette key={initial} initial={initial} onClose={closeSearch} onGo={(href) => router.push(href)} />;
}

function Palette({ initial, onClose, onGo }: { initial: string; onClose: () => void; onGo: (href: string) => void }) {
  const [query, setQuery] = useState(initial);
  const deferred = useDeferredValue(query);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hasData = useFm((s) => s.assets.length > 0 || s.workOrders.length > 0);
  const data = useDataItems(true);
  const [recent] = useState(readRecent);

  useEffect(() => {
    inputRef.current?.focus();
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  const rows: { label: string; rows: Row[] }[] = useMemo(() => {
    const q = deferred.trim();
    if (!q) {
      const groups: { label: string; rows: Row[] }[] = [];
      if (recent.length) groups.push({ label: "Recent", rows: recent.map((item) => ({ key: `r:${item.kind}:${item.id}`, item })) });
      const common = actionItems.filter((a) => ACTIONS.find((x) => x.id === a.id)?.common);
      groups.push({ label: "Actions", rows: (hasData ? common : actionItems.slice(0, 2).concat(common.slice(1))).map((item) => ({ key: `a:${item.id}`, item })) });
      groups.push({ label: "Pages", rows: pageItems.map((item) => ({ key: `p:${item.id}`, item })) });
      return groups;
    }
    const found = searchItems([...actionItems, ...pageItems, ...data], q, 6);
    const { tokens } = parseQuery(q);
    return found.map((g) => {
      const list: Row[] = g.items.map((item) => ({ key: `${g.kind}:${item.id}`, item }));
      if (g.kind === "asset" && g.total > g.items.length) {
        const text = tokens.join(" ");
        list.push({
          key: "more:asset",
          more: true,
          item: { kind: "asset", id: "more", title: `See all ${g.total.toLocaleString()} assets`, subtitle: `On the Assets page, filtered by "${text}"`, href: `/assets?q=${encodeURIComponent(text)}`, hay: "", keys: [] },
        });
      }
      return { label: KIND_LABELS[g.kind], rows: list };
    });
  }, [deferred, data, hasData, recent]);

  const flat = useMemo(() => rows.flatMap((g) => g.rows), [rows]);
  useEffect(() => setSelected(0), [deferred]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const go = (row: Row | undefined) => {
    if (!row) return;
    onClose();
    if (row.item.href.startsWith("action:")) {
      if (row.item.href === "action:theme") toggleTheme();
      return;
    }
    if (!row.more) remember(row.item);
    onGo(row.item.href);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((i) => Math.min(flat.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(flat[selected]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "PageDown") {
      event.preventDefault();
      setSelected((i) => Math.min(flat.length - 1, i + 8));
    } else if (event.key === "PageUp") {
      event.preventDefault();
      setSelected((i) => Math.max(0, i - 8));
    }
  };

  let index = -1;
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 px-3 pt-[8vh] backdrop-blur-[1px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Search" className="flex max-h-[80vh] w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={16} className="shrink-0 text-fg-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={hasData ? "Search assets, rooms, systems, work orders, points, pages…" : "Search pages and actions…"}
            aria-label="Search"
            aria-controls="search-results"
            aria-activedescendant={flat[selected] ? `search-row-${selected}` : undefined}
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none focus-ring-none placeholder:text-fg-3"
            spellCheck={false}
            autoComplete="off"
          />
          {query ? (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear" className="rounded p-1 text-fg-3 hover:bg-surface-2 hover:text-fg">
              <X size={14} />
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-1.5">
          <span className="mr-1 text-[11px] text-fg-3">Look in</span>
          {SCOPE_HINTS.map((s) => (
            <button
              key={s.prefix}
              type="button"
              onClick={() => {
                const rest = query.replace(/^\s*\w+:\s*/, "");
                setQuery(`${s.prefix}${rest}`);
                inputRef.current?.focus();
              }}
              className={clsx("rounded-full border px-2 py-0.5 text-[11px]", query.trimStart().toLowerCase().startsWith(s.prefix) ? "border-accent bg-accent-soft text-accent" : "border-line text-fg-2 hover:bg-surface-2")}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div ref={listRef} id="search-results" role="listbox" className="scroll-thin min-h-0 flex-1 overflow-y-auto py-1">
          {flat.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12.5px] text-fg-3">
              Nothing matches <span className="font-medium text-fg-2">{deferred}</span>.{hasData ? " Try fewer words, a code or a tag." : " Onboard a building or try the demo to search assets and work orders."}
            </div>
          ) : (
            rows.map((group) => (
              <div key={group.label} className="pb-1">
                <div className="px-3 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-fg-3">{group.label}</div>
                {group.rows.map((row) => {
                  index++;
                  const i = index;
                  const Icon = group.label === "Recent" ? Clock : row.more ? ArrowRight : (ICONS[row.item.kind] ?? Box);
                  return (
                    <div
                      key={row.key}
                      id={`search-row-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={i === selected}
                      onMouseMove={() => i !== selected && setSelected(i)}
                      onClick={() => go(row)}
                      className={clsx("mx-1 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5", i === selected ? "bg-accent-soft" : "")}
                    >
                      <Icon size={15} className={clsx("shrink-0", i === selected ? "text-accent" : "text-fg-3")} />
                      <div className="min-w-0 flex-1">
                        <div className={clsx("truncate text-[13px]", row.more ? "text-accent" : "text-fg")}>{row.item.title}</div>
                        {row.item.subtitle ? <div className="truncate text-[11.5px] text-fg-3">{row.item.subtitle}</div> : null}
                      </div>
                      {i === selected ? <CornerDownLeft size={13} className="shrink-0 text-fg-3" /> : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11px] text-fg-3">
          <span>
            <Key>↑</Key> <Key>↓</Key> move
          </span>
          <span>
            <Key>Enter</Key> open
          </span>
          <span>
            <Key>Esc</Key> close
          </span>
          <span className="ml-auto hidden sm:inline">
            On the Assets page: <span className="font-mono">kind:pump floor:L03</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-surface-2 px-1 font-mono text-[10px] text-fg-2">{children}</kbd>;
}
