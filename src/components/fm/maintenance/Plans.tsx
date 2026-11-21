"use client";

// Maintenance plans (one per asset and task) and the task library they are
// made from. Plans are created for the asset kinds chosen, with first due
// dates spread over the first interval, plus the tasks the models carry.

import clsx from "clsx";
import { Download, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { Toggle } from "@/components/convert/parts";
import { Button, Callout } from "@/components/ui/primitives";
import { pushToast } from "@/lib/store";
import { downloadBlob } from "@/lib/utils/download";
import { valueOf } from "@/lib/fm/asset";
import { planWorkbook } from "@/lib/fm/export";
import { fileStem } from "@/lib/fm/package";
import { generatePlans, kindRows } from "@/lib/fm/planning";
import { daysBetween, dueState, todayIso } from "@/lib/fm/schedule";
import { norm } from "@/lib/fm/search";
import { assetMap, deletePlans, savePlans, saveTasks, uid, updatePlan, useFm } from "@/lib/fm/store";
import { DEFAULT_TASKS, intervalText, TASK_LIBRARY_NOTE } from "@/lib/fm/tasks";
import type { Plan, TaskTemplate, Unit } from "@/lib/fm/types";
import { DueBadge, Empty, formatDate, inputCls, Panel, plural } from "../ui";

export function PlanGenerator({ onDone }: { onDone?: () => void }) {
  const assets = useFm((s) => s.assets);
  const tasks = useFm((s) => s.tasks);
  const plans = useFm((s) => s.plans);
  const rows = useMemo(() => kindRows(assets, tasks), [assets, tasks]);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(rows.filter((r) => r.tasks.length).map((r) => r.code)));
  const [start, setStart] = useState(todayIso());
  const [spread, setSpread] = useState(true);
  const [fromModel, setFromModel] = useState(true);
  const covered = rows.filter((r) => r.tasks.length);
  const uncovered = rows.filter((r) => !r.tasks.length);
  const preview = useMemo(() => generatePlans(assets, tasks, plans, { start, kinds: chosen, spread, fromModel }).length, [assets, tasks, plans, start, chosen, spread, fromModel]);

  const create = () => {
    const fresh = generatePlans(assets, tasks, plans, { start, kinds: chosen, spread, fromModel });
    if (!fresh.length) return;
    savePlans(fresh);
    pushToast("success", `${plural(fresh.length, "maintenance task")} planned.`);
    onDone?.();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-fg-2">First day tasks can fall due</span>
          <input type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value || todayIso())} />
        </label>
        <Toggle checked={spread} onChange={setSpread} label="Spread the first due dates" hint="Over each task's first interval, so a thousand detectors are not all due on one day." />
        <Toggle checked={fromModel} onChange={setFromModel} label="Add the models' own maintenance tasks" hint="Where assets carry a PPM task and frequency." />
      </div>
      <div className="overflow-hidden rounded-md border border-line">
        <div className="flex items-center justify-between border-b border-line bg-surface-2 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-3">
          <span>
            Asset kinds with library tasks ({covered.length})
          </span>
          <span className="flex gap-2 normal-case">
            <button type="button" className="text-accent hover:underline" onClick={() => setChosen(new Set(covered.map((r) => r.code)))}>
              All
            </button>
            <button type="button" className="text-accent hover:underline" onClick={() => setChosen(new Set())}>
              None
            </button>
          </span>
        </div>
        <ul className="scroll-thin max-h-[300px] divide-y divide-line overflow-y-auto">
          {covered.map((r) => (
            <li key={r.code} className="flex items-start gap-2 px-2.5 py-1.5">
              <input
                type="checkbox"
                className="mt-[3px] size-3.5 accent-[var(--accent)]"
                checked={chosen.has(r.code)}
                onChange={() =>
                  setChosen((s) => {
                    const n = new Set(s);
                    if (n.has(r.code)) n.delete(r.code);
                    else n.add(r.code);
                    return n;
                  })
                }
                aria-label={r.name}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] text-fg">
                  {r.name} <span className="text-fg-3">· {plural(r.assets, "asset")}</span>
                </div>
                <div className="truncate text-[11.5px] text-fg-3">{r.tasks.map((t) => `${t.title} (${intervalText(t.every, t.unit).toLowerCase()})`).join("; ")}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {uncovered.length ? (
        <p className="text-[12px] leading-relaxed text-fg-3">
          No library tasks yet for {uncovered.slice(0, 8).map((r) => `${r.name.toLowerCase()} (${r.assets})`).join(", ")}
          {uncovered.length > 8 ? ` and ${uncovered.length - 8} more kinds` : ""}. Add them in the <Link href="/maintenance?tab=library" className="text-accent hover:underline">task library</Link>.
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!preview} onClick={create}>
          {preview ? `Plan ${plural(preview, "task")}` : "Nothing new to plan"}
        </Button>
        {plans.length ? <span className="text-[12px] text-fg-3">Tasks already planned keep their dates.</span> : null}
      </div>
    </div>
  );
}

export function PlansTab() {
  const facility = useFm((s) => s.facility);
  const plans = useFm((s) => s.plans);
  const assets = useFm((s) => s.assets);
  const [text, setText] = useState("");
  const [showGenerator, setShowGenerator] = useState(plans.length === 0);
  const [limit, setLimit] = useState(400);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const deferred = useDeferredValue(text);
  const byId = assetMap(assets);
  const today = todayIso();

  const list = useMemo(() => {
    const words = norm(deferred).split(" ").filter(Boolean);
    return plans
      .filter((p) => {
        if (!words.length) return true;
        const a = byId.get(p.assetId);
        const hay = norm(`${p.title} ${p.trade ?? ""} ${p.source} ${a ? `${valueOf(a, "name")} ${valueOf(a, "code")} ${a.kind} ${valueOf(a, "floor")} ${valueOf(a, "space")}` : ""}`);
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  }, [plans, deferred, byId]);

  const onAssets = new Set(plans.map((p) => p.assetId)).size;

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={plans.length ? "Plan more maintenance" : "Plan maintenance for the register"}
        aside={
          plans.length ? (
            <Button size="sm" onClick={() => setShowGenerator((v) => !v)}>
              {showGenerator ? "Hide" : "Show"}
            </Button>
          ) : null
        }
      >
        {showGenerator ? <PlanGenerator onDone={() => setShowGenerator(false)} /> : <p className="text-[12px] text-fg-3">Create tasks from the library for more asset kinds, or for assets added since.</p>}
      </Panel>

      {plans.length ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent">
              <Search size={14} className="shrink-0 text-fg-3" />
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search tasks, assets, kinds, floors…" className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none focus-ring-none placeholder:text-fg-3" aria-label="Search plans" />
              {text ? (
                <button type="button" onClick={() => setText("")} aria-label="Clear" className="rounded p-0.5 text-fg-3 hover:text-fg">
                  <X size={13} />
                </button>
              ) : null}
            </label>
            <span className="text-[12px] text-fg-3">
              {plural(list.length, "task")} on {plural(onAssets, "asset")}
            </span>
            {selected.size ? (
              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 size={12} />}
                onClick={() => {
                  deletePlans([...selected]);
                  pushToast("info", `${plural(selected.size, "task")} removed from the plan.`);
                  setSelected(new Set());
                }}
              >
                Remove {selected.size}
              </Button>
            ) : null}
            <Button size="sm" icon={<Download size={12} />} onClick={async () => downloadBlob(await planWorkbook(facility, list, byId), `${fileStem(facility?.name ?? "facility", "maintenance-plans")}.xlsx`)}>
              Excel
            </Button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[860px] text-[12.5px]">
              <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-fg-3">
                <tr>
                  <th className="w-8 px-2 py-1.5">
                    <input type="checkbox" aria-label="Select all shown" checked={list.length > 0 && list.slice(0, limit).every((p) => selected.has(p.id))} onChange={(e) => setSelected(e.target.checked ? new Set(list.slice(0, limit).map((p) => p.id)) : new Set())} className="size-3.5 accent-[var(--accent)]" />
                  </th>
                  <th className="px-2 py-1.5 font-semibold">Task</th>
                  <th className="px-2 py-1.5 font-semibold">Asset</th>
                  <th className="px-2 py-1.5 font-semibold">Every</th>
                  <th className="px-2 py-1.5 font-semibold">Next due</th>
                  <th className="px-2 py-1.5 font-semibold">Last done</th>
                  <th className="px-2 py-1.5 font-semibold">From</th>
                  <th className="px-2 py-1.5 font-semibold">Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.slice(0, limit).map((p) => {
                  const a = byId.get(p.assetId);
                  return (
                    <tr key={p.id} className="hover:bg-surface-2">
                      <td className="px-2 py-1.5">
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
                      </td>
                      <td className={clsx("max-w-[300px] truncate px-2 py-1.5", p.active ? "text-fg" : "text-fg-3 line-through")} title={p.title}>
                        {p.title}
                      </td>
                      <td className="max-w-[220px] truncate px-2 py-1.5">
                        {a ? (
                          <Link href={`/assets?asset=${encodeURIComponent(a.id)}&tab=maintenance`} className="text-accent hover:underline">
                            {valueOf(a, "name")}
                          </Link>
                        ) : (
                          p.assetId
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <IntervalEditor plan={p} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <input type="date" className="h-7 rounded border border-transparent bg-transparent px-1 text-[12px] text-fg-2 hover:border-line-strong" value={p.nextDue} onChange={(e) => e.target.value && updatePlan(p.id, { nextDue: e.target.value })} aria-label="Next due" />
                        <DueBadge state={dueState(p, today)} days={daysBetween(today, p.nextDue)} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-fg-2">{formatDate(p.lastDone) || "–"}</td>
                      <td className="px-2 py-1.5 text-[11.5px] capitalize text-fg-3">{p.source}</td>
                      <td className="px-2 py-1.5">
                        <input type="checkbox" checked={p.active} onChange={(e) => updatePlan(p.id, { active: e.target.checked })} aria-label="Active" className="size-3.5 accent-[var(--accent)]" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {list.length > limit ? (
              <div className="border-t border-line p-2 text-center">
                <Button size="sm" onClick={() => setLimit((l) => l + 1000)}>
                  Show more ({(list.length - limit).toLocaleString()} left)
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function IntervalEditor({ plan }: { plan: Plan }) {
  const [editing, setEditing] = useState(false);
  if (!editing)
    return (
      <button type="button" className="rounded px-1 text-fg-2 hover:bg-surface-3" onClick={() => setEditing(true)} title="Change the interval">
        {intervalText(plan.every, plan.unit)}
      </button>
    );
  return (
    <span className="inline-flex items-center gap-1">
      <input type="number" min={1} className="h-7 w-14 rounded border border-line-strong bg-surface px-1 text-[12px]" defaultValue={plan.every} onBlur={(e) => updatePlan(plan.id, { every: Math.max(1, Number(e.target.value) || plan.every) })} aria-label="Every" />
      <select className="h-7 rounded border border-line-strong bg-surface px-1 text-[12px]" defaultValue={plan.unit} onChange={(e) => updatePlan(plan.id, { unit: e.target.value as Unit })} aria-label="Unit">
        <option value="day">days</option>
        <option value="week">weeks</option>
        <option value="month">months</option>
        <option value="year">years</option>
      </select>
      <button type="button" className="text-[11.5px] text-accent" onClick={() => setEditing(false)}>
        Done
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Task library

export function LibraryTab() {
  const tasks = useFm((s) => s.tasks);
  const assets = useFm((s) => s.assets);
  const plans = useFm((s) => s.plans);
  const [text, setText] = useState("");
  const rows = useMemo(() => kindRows(assets, tasks), [assets, tasks]);
  const uncovered = rows.filter((r) => !r.tasks.length);
  const words = norm(text).split(" ").filter(Boolean);
  const shown = tasks.filter((t) => !words.length || words.every((w) => norm(`${t.title} ${t.kindCodes.join(" ")} ${t.trade ?? ""}`).includes(w)));
  const kindName = new Map(rows.map((r) => [r.code, r.name]));

  const change = (id: string, patch: Partial<TaskTemplate>) => saveTasks(tasks.map((t) => (t.id === id ? { ...t, ...patch, custom: true } : t)));
  const add = (kindCode = "") => saveTasks([{ id: uid("task"), kindCodes: kindCode ? [kindCode] : [], title: "New task", every: 12, unit: "month", custom: true }, ...tasks]);
  const applyToPlans = () => {
    const byTask = new Map(tasks.map((t) => [t.id, t]));
    const changed = plans.filter((p) => p.source === "library" && byTask.has(p.taskId)).map((p) => ({ p, t: byTask.get(p.taskId)! })).filter(({ p, t }) => p.title !== t.title || p.every !== t.every || p.unit !== t.unit || p.statutory !== t.statutory);
    if (!changed.length) {
      pushToast("info", "The plans already follow the library.");
      return;
    }
    savePlans(changed.map(({ p, t }) => ({ ...p, title: t.title, every: t.every, unit: t.unit, statutory: t.statutory, minutes: t.minutes, trade: t.trade })));
    pushToast("success", `${plural(changed.length, "planned task")} updated from the library (their next due dates kept).`);
  };

  return (
    <div className="flex flex-col gap-4">
      <Callout tone="warn">{TASK_LIBRARY_NOTE}</Callout>
      {uncovered.length ? (
        <Panel title={`Asset kinds without tasks (${uncovered.length})`}>
          <div className="flex flex-wrap gap-1.5">
            {uncovered.map((r) => (
              <button key={r.code} type="button" onClick={() => add(r.code)} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11.5px] text-fg-2 hover:border-accent hover:text-accent" title={`Add a task for ${r.name}`}>
                <Plus size={11} /> {r.name} <span className="text-fg-3">{r.code} · {r.assets}</span>
              </button>
            ))}
          </div>
        </Panel>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-fg-3" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search tasks or kind codes (AHU, PMP, FACP…)" className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none focus-ring-none placeholder:text-fg-3" aria-label="Search the task library" />
        </label>
        <Button icon={<Plus size={13} />} onClick={() => add()}>
          Add a task
        </Button>
        <Button onClick={applyToPlans} title="Copy task names and intervals to the plans made from them">
          Update plans from the library
        </Button>
        <Button
          variant="ghost"
          icon={<RotateCcw size={13} />}
          onClick={() => {
            saveTasks(DEFAULT_TASKS);
            pushToast("info", "Task library reset to the built-in tasks.");
          }}
        >
          Reset
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[900px] text-[12.5px]">
          <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-fg-3">
            <tr>
              <th className="px-2 py-1.5 font-semibold">Kinds</th>
              <th className="px-2 py-1.5 font-semibold">Task</th>
              <th className="px-2 py-1.5 font-semibold">Every</th>
              <th className="px-2 py-1.5 font-semibold">Minutes</th>
              <th className="px-2 py-1.5 font-semibold">Trade</th>
              <th className="px-2 py-1.5 font-semibold">Statutory</th>
              <th className="w-8 px-2 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((t) => (
              <tr key={t.id} className={t.custom ? "bg-accent-soft/40" : undefined}>
                <td className="px-2 py-1">
                  <input
                    className="h-7 w-[150px] rounded border border-transparent bg-transparent px-1 font-mono text-[11.5px] text-fg-2 hover:border-line-strong focus:border-accent"
                    defaultValue={t.kindCodes.join(", ")}
                    title={t.kindCodes.map((c) => kindName.get(c) ?? c).join(", ")}
                    onBlur={(e) => change(t.id, { kindCodes: e.target.value.split(/[,;\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean) })}
                    aria-label="Kind codes"
                  />
                </td>
                <td className="px-2 py-1">
                  <input className="h-7 w-full min-w-[280px] rounded border border-transparent bg-transparent px-1 text-fg hover:border-line-strong focus:border-accent" defaultValue={t.title} onBlur={(e) => e.target.value.trim() && e.target.value !== t.title && change(t.id, { title: e.target.value.trim() })} aria-label="Task" />
                  {t.notes ? <div className="px-1 text-[11px] text-fg-3">{t.notes}</div> : null}
                </td>
                <td className="whitespace-nowrap px-2 py-1">
                  <input type="number" min={1} className="h-7 w-14 rounded border border-line bg-surface px-1" defaultValue={t.every} onBlur={(e) => change(t.id, { every: Math.max(1, Number(e.target.value) || t.every) })} aria-label="Every" />
                  <select className="ml-1 h-7 rounded border border-line bg-surface px-1" defaultValue={t.unit} onChange={(e) => change(t.id, { unit: e.target.value as Unit })} aria-label="Unit">
                    <option value="day">days</option>
                    <option value="week">weeks</option>
                    <option value="month">months</option>
                    <option value="year">years</option>
                  </select>
                </td>
                <td className="px-2 py-1">
                  <input type="number" min={0} className="h-7 w-16 rounded border border-line bg-surface px-1" defaultValue={t.minutes ?? ""} onBlur={(e) => change(t.id, { minutes: e.target.value ? Number(e.target.value) : undefined })} aria-label="Minutes" />
                </td>
                <td className="px-2 py-1">
                  <input className="h-7 w-28 rounded border border-transparent bg-transparent px-1 text-fg-2 hover:border-line-strong focus:border-accent" defaultValue={t.trade ?? ""} onBlur={(e) => change(t.id, { trade: e.target.value.trim() || undefined })} aria-label="Trade" />
                </td>
                <td className="px-2 py-1">
                  <input type="checkbox" checked={Boolean(t.statutory)} onChange={(e) => change(t.id, { statutory: e.target.checked || undefined })} className="size-3.5 accent-[var(--accent)]" aria-label="Statutory" />
                </td>
                <td className="px-2 py-1">
                  <button type="button" aria-label="Delete task" onClick={() => saveTasks(tasks.filter((x) => x.id !== t.id))} className="rounded p-1 text-fg-3 hover:bg-bad-soft hover:text-bad">
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? <Empty>No tasks match.</Empty> : null}
      </div>
    </div>
  );
}
