"use client";

// Maintenance: what is due (and raising work orders for it), the month
// ahead, the work orders themselves, the plans behind them and the task
// library they come from.

import clsx from "clsx";
import { ChevronLeft, ChevronRight, Download, Search, Wrench, X } from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { Button } from "@/components/ui/primitives";
import { pushToast } from "@/lib/store";
import { downloadBlob } from "@/lib/utils/download";
import { valueOf } from "@/lib/fm/asset";
import { planWorkbook } from "@/lib/fm/export";
import { fileStem } from "@/lib/fm/package";
import { addDays, daysBetween, dueState, isOpen, isoDate, occurrences, parseIso, plansToRaise, todayIso } from "@/lib/fm/schedule";
import { norm } from "@/lib/fm/search";
import { assetMap, createWorkOrders, useFm } from "@/lib/fm/store";
import { intervalText } from "@/lib/fm/tasks";
import type { Plan, WorkOrder } from "@/lib/fm/types";
import { compact, DueBadge, Empty, formatDate, plural, Tabs, useParam, WorkspaceGate, WoStatusBadge } from "../ui";
import { WorkOrderDialog } from "../WorkOrderDialog";
import { LibraryTab, PlansTab } from "./Plans";
import { WorkOrdersTab } from "./WorkOrders";

type Tab = "due" | "calendar" | "orders" | "plans" | "library";

export function MaintenancePage() {
  return (
    <WorkspaceGate what="Maintenance">
      <Maintenance />
    </WorkspaceGate>
  );
}

function Maintenance() {
  const [tabParam, setTab] = useParam("tab");
  const [newParam, setNew] = useParam("new");
  const plans = useFm((s) => s.plans);
  const workOrders = useFm((s) => s.workOrders);
  const tab = (["due", "calendar", "orders", "plans", "library"].includes(tabParam) ? tabParam : plans.length ? "due" : "plans") as Tab;
  const today = todayIso();
  const overdue = useMemo(() => plans.reduce((n, p) => n + (dueState(p, today) === "overdue" ? 1 : 0), 0), [plans, today]);
  const open = workOrders.filter(isOpen).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="border-b border-line bg-surface px-3 pt-3 sm:px-4">
        <div className="flex flex-wrap items-end justify-between gap-2 pb-2">
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight text-fg">Maintenance</h1>
            <p className="text-[12px] text-fg-2">
              {plural(plans.length, "planned task")} · {plural(open, "open work order")}
            </p>
          </div>
          <Button variant="primary" icon={<Wrench size={14} />} onClick={() => setNew("1")}>
            New work order
          </Button>
        </div>
        <Tabs
          value={tab}
          onChange={(t) => setTab(t)}
          tabs={[
            { id: "due", label: "Due", count: overdue || undefined, tone: overdue ? "bad" : undefined },
            { id: "calendar", label: "Calendar" },
            { id: "orders", label: "Work orders", count: open || undefined },
            { id: "plans", label: "Plans", count: plans.length || undefined },
            { id: "library", label: "Task library" },
          ]}
        />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] p-3 sm:p-4">
          {tab === "due" ? <DueTab /> : null}
          {tab === "calendar" ? <CalendarTab /> : null}
          {tab === "orders" ? <WorkOrdersTab /> : null}
          {tab === "plans" ? <PlansTab /> : null}
          {tab === "library" ? <LibraryTab /> : null}
        </div>
      </div>
      <WorkOrderDialog open={newParam === "1"} onClose={() => setNew(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Due

const WINDOWS = [
  { days: 14, label: "Next 14 days" },
  { days: 30, label: "Next 30 days" },
  { days: 90, label: "Next 90 days" },
  { days: 365, label: "Next 12 months" },
];

function DueTab() {
  const facility = useFm((s) => s.facility);
  const plans = useFm((s) => s.plans);
  const assets = useFm((s) => s.assets);
  const workOrders = useFm((s) => s.workOrders);
  const [windowDays, setWindowDays] = useState(14);
  const [text, setText] = useState("");
  const [floor, setFloor] = useState("");
  const [trade, setTrade] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(300);
  const deferred = useDeferredValue(text);
  const today = todayIso();
  const until = addDays(today, windowDays);
  const byId = assetMap(assets);

  const openByPlan = useMemo(() => {
    const m = new Map<string, WorkOrder>();
    for (const w of workOrders) if (isOpen(w) && w.planId) m.set(w.planId, w);
    return m;
  }, [workOrders]);

  const due = useMemo(() => {
    const words = norm(deferred).split(" ").filter(Boolean);
    return plans
      .filter((p) => p.active && p.nextDue <= until)
      .filter((p) => {
        const a = byId.get(p.assetId);
        if (floor && (!a || valueOf(a, "floor") !== floor)) return false;
        if (trade && p.trade !== trade) return false;
        if (!words.length) return true;
        const hay = norm(`${p.title} ${a ? `${valueOf(a, "name")} ${valueOf(a, "code")} ${a.kind} ${valueOf(a, "space")} ${valueOf(a, "floor")}` : ""}`);
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.title.localeCompare(b.title));
  }, [plans, until, byId, floor, trade, deferred]);

  const floors = useMemo(() => [...new Set(plans.map((p) => byId.get(p.assetId)).filter(Boolean).map((a) => valueOf(a!, "floor")).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [plans, byId]);
  const trades = useMemo(() => [...new Set(plans.map((p) => p.trade).filter((t): t is string => Boolean(t)))].sort(), [plans]);
  const withoutOrder = due.filter((p) => !openByPlan.has(p.id));
  const overdue = due.filter((p) => p.nextDue < today).length;

  const raise = (list: Plan[]) => {
    const items = plansToRaise(list, workOrders, until).map((p) => ({ title: p.title, kind: "planned" as const, priority: p.statutory ? ("high" as const) : ("normal" as const), due: p.nextDue < today ? today : p.nextDue, assetIds: [p.assetId], planId: p.id }));
    if (!items.length) return;
    const created = createWorkOrders(items);
    setSelected(new Set());
    pushToast("success", `${plural(created.length, "work order")} raised (${created[0].number}${created.length > 1 ? ` to ${created[created.length - 1].number}` : ""}).`);
  };

  if (!plans.length)
    return (
      <Empty action={<Link href="/maintenance?tab=plans" className="text-accent hover:underline">Set up maintenance plans</Link>}>
        No maintenance is planned yet. Plans come from the task library (typical tasks per asset kind) and from maintenance data in the models.
      </Empty>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-fg-3" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search tasks, assets, rooms…" className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none focus-ring-none placeholder:text-fg-3" aria-label="Search due maintenance" />
          {text ? (
            <button type="button" onClick={() => setText("")} aria-label="Clear" className="rounded p-0.5 text-fg-3 hover:text-fg">
              <X size={13} />
            </button>
          ) : null}
        </label>
        <div className="grid grid-cols-3 gap-2 sm:flex">
          <select className="h-8 rounded-md border border-line-strong bg-surface px-1.5 text-[12.5px] text-fg-2" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} aria-label="Period">
            {WINDOWS.map((w) => (
              <option key={w.days} value={w.days}>
                Overdue and {w.label.toLowerCase()}
              </option>
            ))}
          </select>
          <select className="h-8 rounded-md border border-line-strong bg-surface px-1.5 text-[12.5px] text-fg-2" value={floor} onChange={(e) => setFloor(e.target.value)} aria-label="Floor">
            <option value="">Floor: all</option>
            {floors.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <select className="h-8 rounded-md border border-line-strong bg-surface px-1.5 text-[12.5px] text-fg-2" value={trade} onChange={(e) => setTrade(e.target.value)} aria-label="Trade">
            <option value="">Trade: all</option>
            {trades.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
        <span className="text-[12.5px] text-fg">
          <b>{due.length.toLocaleString()}</b> due{overdue ? <>, <span className="font-semibold text-bad">{overdue.toLocaleString()} overdue</span></> : null} · {withoutOrder.length.toLocaleString()} without a work order
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {selected.size ? (
            <Button size="sm" variant="primary" onClick={() => raise(due.filter((p) => selected.has(p.id)))}>
              Raise {plural(selected.size, "work order")}
            </Button>
          ) : null}
          <Button size="sm" disabled={!withoutOrder.length} onClick={() => raise(withoutOrder)} title="One work order per task, for every task shown that has none open">
            Raise work orders for all {compact(withoutOrder.length)}
          </Button>
          <Button size="sm" icon={<Download size={12} />} onClick={async () => downloadBlob(await planWorkbook(facility, due, byId), `${fileStem(facility?.name ?? "facility", "maintenance-due")}.xlsx`)}>
            Excel
          </Button>
        </div>
      </div>

      {due.length === 0 ? (
        <Empty>Nothing due in this period{text || floor || trade ? " that matches" : ""}.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[820px] text-[12.5px]">
            <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-fg-3">
              <tr>
                <th className="w-8 px-2 py-1.5">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={withoutOrder.length > 0 && withoutOrder.every((p) => selected.has(p.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(withoutOrder.map((p) => p.id)) : new Set())}
                    className="size-3.5 accent-[var(--accent)]"
                  />
                </th>
                <th className="px-2 py-1.5 font-semibold">Task</th>
                <th className="px-2 py-1.5 font-semibold">Asset</th>
                <th className="px-2 py-1.5 font-semibold">Where</th>
                <th className="px-2 py-1.5 font-semibold">Every</th>
                <th className="px-2 py-1.5 font-semibold">Due</th>
                <th className="px-2 py-1.5 font-semibold">Work order</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {due.slice(0, limit).map((p) => {
                const a = byId.get(p.assetId);
                const wo = openByPlan.get(p.id);
                return (
                  <tr key={p.id} className="hover:bg-surface-2">
                    <td className="px-2 py-1.5">
                      {wo ? null : (
                        <input
                          type="checkbox"
                          aria-label={`Select ${p.title}`}
                          checked={selected.has(p.id)}
                          onChange={() =>
                            setSelected((s) => {
                              const n = new Set(s);
                              if (n.has(p.id)) n.delete(p.id);
                              else n.add(p.id);
                              return n;
                            })
                          }
                          className="size-3.5 accent-[var(--accent)]"
                        />
                      )}
                    </td>
                    <td className="max-w-[320px] px-2 py-1.5 text-fg">
                      <div className="truncate" title={p.title}>
                        {p.title}
                      </div>
                      {p.statutory ? <div className="text-[11px] text-warn">Statutory</div> : null}
                    </td>
                    <td className="max-w-[220px] px-2 py-1.5">
                      {a ? (
                        <Link href={`/assets?asset=${encodeURIComponent(a.id)}&tab=maintenance`} className="block truncate text-accent hover:underline" title={valueOf(a, "name")}>
                          {valueOf(a, "name")}
                        </Link>
                      ) : (
                        <span className="text-fg-3">{p.assetId}</span>
                      )}
                      <div className="truncate text-[11px] text-fg-3">{a?.kind}</div>
                    </td>
                    <td className="max-w-[200px] truncate px-2 py-1.5 text-fg-2">{a ? [valueOf(a, "floor"), valueOf(a, "space")].filter(Boolean).join(" · ") : ""}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-fg-2">{intervalText(p.every, p.unit)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <div className="text-fg-2">{formatDate(p.nextDue)}</div>
                      <DueBadge state={dueState(p, today)} days={daysBetween(today, p.nextDue)} />
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {wo ? (
                        <Link href={`/maintenance?tab=orders&wo=${encodeURIComponent(wo.id)}`} className="inline-flex items-center gap-1.5 hover:underline">
                          <span className="tabular text-fg-2">{wo.number}</span>
                          <WoStatusBadge status={wo.status} />
                        </Link>
                      ) : (
                        <span className="text-fg-3">–</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {due.length > limit ? (
            <div className="border-t border-line p-2 text-center">
              <Button size="sm" onClick={() => setLimit((l) => l + 500)}>
                Show more ({(due.length - limit).toLocaleString()} left)
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function CalendarTab() {
  const plans = useFm((s) => s.plans);
  const workOrders = useFm((s) => s.workOrders);
  const assets = useFm((s) => s.assets);
  const today = todayIso();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [day, setDay] = useState<string | null>(null);
  const byId = assetMap(assets);

  const first = parseIso(`${month}-01`);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return isoDate(d);
  });
  const from = days[0];
  const to = days[days.length - 1];

  const byDay = useMemo(() => {
    const tasks = new Map<string, Plan[]>();
    for (const p of plans) {
      // Overdue tasks stay on their due day; the next ones follow from it.
      for (const d of occurrences(p, from, to, 120)) {
        const list = tasks.get(d);
        if (list) list.push(p);
        else tasks.set(d, [p]);
      }
    }
    const orders = new Map<string, WorkOrder[]>();
    for (const w of workOrders) {
      if (!isOpen(w) || w.due < from || w.due > to) continue;
      const list = orders.get(w.due);
      if (list) list.push(w);
      else orders.set(w.due, [w]);
    }
    return { tasks, orders };
  }, [plans, workOrders, from, to]);

  const shift = (n: number) => {
    const d = parseIso(`${month}-01`);
    d.setMonth(d.getMonth() + n);
    setMonth(isoDate(d).slice(0, 7));
    setDay(null);
  };
  const selectedTasks = day ? (byDay.tasks.get(day) ?? []) : [];
  const selectedOrders = day ? (byDay.orders.get(day) ?? []) : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button size="sm" icon={<ChevronLeft size={13} />} onClick={() => shift(-1)} aria-label="Previous month" />
        <Button size="sm" icon={<ChevronRight size={13} />} onClick={() => shift(1)} aria-label="Next month" />
        <h2 className="text-[14px] font-semibold text-fg">
          {MONTH_NAMES[first.getMonth()]} {first.getFullYear()}
        </h2>
        <Button size="sm" className="ml-auto" onClick={() => setMonth(today.slice(0, 7))}>
          Today
        </Button>
      </div>
      <div className="grid grid-cols-7 overflow-hidden rounded-lg border border-line bg-line" style={{ gap: 1 }}>
        {WEEKDAYS.map((w) => (
          <div key={w} className="bg-surface-2 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-3">
            {w}
          </div>
        ))}
        {days.map((d) => {
          const tasks = byDay.tasks.get(d)?.length ?? 0;
          const orders = byDay.orders.get(d)?.length ?? 0;
          const inMonth = d.startsWith(month);
          const past = d < today && (tasks > 0 || orders > 0);
          return (
            <button
              key={d}
              type="button"
              onClick={() => setDay(d === day ? null : d)}
              className={clsx("flex min-h-[64px] flex-col items-start gap-1 p-1.5 text-left sm:min-h-[84px]", d === day ? "bg-accent-soft" : "bg-surface hover:bg-surface-2", !inMonth && "opacity-50")}
              aria-label={`${formatDate(d)}: ${tasks} tasks, ${orders} work orders`}
            >
              <span className={clsx("tabular text-[11.5px]", d === today ? "grid size-5 place-items-center rounded-full bg-accent font-semibold text-accent-fg" : "text-fg-2")}>{Number(d.slice(8))}</span>
              {tasks ? <span className={clsx("tabular rounded px-1 text-[10.5px] font-medium", past ? "bg-bad-soft text-bad" : "bg-surface-2 text-fg-2")}>{compact(tasks)} task{tasks === 1 ? "" : "s"}</span> : null}
              {orders ? <span className="tabular rounded bg-accent-soft px-1 text-[10.5px] font-medium text-accent">{orders} WO</span> : null}
            </button>
          );
        })}
      </div>
      {day ? (
        <div className="rounded-lg border border-line bg-surface">
          <div className="border-b border-line px-3 py-2 text-[13px] font-semibold text-fg">{formatDate(day)}</div>
          {selectedOrders.length === 0 && selectedTasks.length === 0 ? <Empty>Nothing due on this day.</Empty> : null}
          <ul className="divide-y divide-line">
            {selectedOrders.map((w) => (
              <li key={w.id}>
                <Link href={`/maintenance?tab=orders&wo=${encodeURIComponent(w.id)}`} className="flex items-center gap-2 px-3 py-2 hover:bg-surface-2">
                  <span className="tabular text-[12px] text-fg-3">{w.number}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{w.title}</span>
                  <WoStatusBadge status={w.status} />
                </Link>
              </li>
            ))}
            {selectedTasks.slice(0, 200).map((p) => {
              const a = byId.get(p.assetId);
              return (
                <li key={p.id}>
                  <Link href={`/assets?asset=${encodeURIComponent(p.assetId)}&tab=maintenance`} className="flex items-center gap-2 px-3 py-2 hover:bg-surface-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-fg">{p.title}</span>
                      <span className="block truncate text-[11.5px] text-fg-3">{a ? `${valueOf(a, "name")} · ${[valueOf(a, "floor"), valueOf(a, "space")].filter(Boolean).join(" · ")}` : p.assetId}</span>
                    </span>
                    <span className="text-[11.5px] text-fg-3">{intervalText(p.every, p.unit)}</span>
                  </Link>
                </li>
              );
            })}
            {selectedTasks.length > 200 ? <li className="px-3 py-2 text-[12px] text-fg-3">and {(selectedTasks.length - 200).toLocaleString()} more; the Due tab lists them all.</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
