"use client";

// Work orders: the list with its filters, and one work order in a side panel
// where it is started, put on hold, completed (with notes) or cancelled.

import clsx from "clsx";
import { CheckCircle2, Download, Pause, Play, RotateCcw, Search, X, XCircle } from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { Button, Segmented } from "@/components/ui/primitives";
import { pushToast } from "@/lib/store";
import { downloadBlob } from "@/lib/utils/download";
import { valueOf } from "@/lib/fm/asset";
import { workOrderWorkbook } from "@/lib/fm/export";
import { fileStem } from "@/lib/fm/package";
import { isOpen, todayIso } from "@/lib/fm/schedule";
import { norm } from "@/lib/fm/search";
import { assetMap, updateWorkOrder, useFm } from "@/lib/fm/store";
import type { Priority, WorkOrder, WorkOrderStatus } from "@/lib/fm/types";
import { Empty, formatDate, formatDateTime, FormRow, inputCls, Modal, plural, PriorityBadge, SidePanel, textareaCls, useParam, WO_STATUS_LABEL, WoStatusBadge } from "../ui";
import { AssetPicker } from "../WorkOrderDialog";

type View = "open" | "done" | "all";

export function WorkOrdersTab() {
  const facility = useFm((s) => s.facility);
  const workOrders = useFm((s) => s.workOrders);
  const assets = useFm((s) => s.assets);
  const [woId, setWoId] = useParam("wo");
  const [view, setView] = useState<View>("open");
  const [text, setText] = useState("");
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("");
  const deferred = useDeferredValue(text);
  const byId = assetMap(assets);
  const today = todayIso();

  const list = useMemo(() => {
    const words = norm(deferred).split(" ").filter(Boolean);
    return workOrders
      .filter((w) => (view === "open" ? isOpen(w) : view === "done" ? !isOpen(w) : true))
      .filter((w) => !priority || w.priority === priority)
      .filter((w) => !assignee || w.assignee === assignee)
      .filter((w) => {
        if (!words.length) return true;
        const hay = norm(`${w.number} ${w.title} ${w.description} ${w.assignee} ${w.kind} ${w.assetIds.map((id) => { const a = byId.get(id); return a ? `${valueOf(a, "name")} ${valueOf(a, "code")} ${valueOf(a, "space")}` : ""; }).join(" ")}`);
        return words.every((x) => hay.includes(x));
      })
      .sort((a, b) => (view === "open" ? a.due.localeCompare(b.due) : b.number.localeCompare(a.number, undefined, { numeric: true })));
  }, [workOrders, view, priority, assignee, deferred, byId]);

  const assignees = useMemo(() => [...new Set(workOrders.map((w) => w.assignee).filter(Boolean))].sort(), [workOrders]);
  const open = woId ? workOrders.find((w) => w.id === woId) : undefined;
  const counts = { open: workOrders.filter(isOpen).length, done: workOrders.filter((w) => !isOpen(w)).length };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "open", label: `Open (${counts.open})` },
            { value: "done", label: `Closed (${counts.done})` },
            { value: "all", label: "All" },
          ]}
        />
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-fg-3" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search number, title, asset, room, person…" className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none focus-ring-none placeholder:text-fg-3" aria-label="Search work orders" />
          {text ? (
            <button type="button" onClick={() => setText("")} aria-label="Clear" className="rounded p-0.5 text-fg-3 hover:text-fg">
              <X size={13} />
            </button>
          ) : null}
        </label>
        <div className="grid grid-cols-3 gap-2 sm:flex">
          <select className="h-8 rounded-md border border-line-strong bg-surface px-1.5 text-[12.5px] text-fg-2" value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
            <option value="">Priority: all</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
          <select className="h-8 rounded-md border border-line-strong bg-surface px-1.5 text-[12.5px] text-fg-2" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assigned to">
            <option value="">Assigned: anyone</option>
            {assignees.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <Button icon={<Download size={13} />} onClick={async () => downloadBlob(await workOrderWorkbook(facility, list, byId), `${fileStem(facility?.name ?? "facility", "work-orders")}.xlsx`)}>
            Excel
          </Button>
        </div>
      </div>

      {list.length === 0 ? (
        <Empty>{workOrders.length ? "No work orders match." : "No work orders yet. Raise them from the Due tab, or create one for a fault."}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[860px] text-[12.5px]">
            <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-fg-3">
              <tr>
                <th className="px-3 py-1.5 font-semibold">Number</th>
                <th className="px-2 py-1.5 font-semibold">Title</th>
                <th className="px-2 py-1.5 font-semibold">Assets</th>
                <th className="px-2 py-1.5 font-semibold">Due</th>
                <th className="px-2 py-1.5 font-semibold">Priority</th>
                <th className="px-2 py-1.5 font-semibold">Status</th>
                <th className="px-2 py-1.5 font-semibold">Assigned</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.slice(0, 1000).map((w) => {
                const first = w.assetIds[0] ? byId.get(w.assetIds[0]) : undefined;
                const late = isOpen(w) && w.due < today;
                return (
                  <tr key={w.id} onClick={() => setWoId(w.id)} className={clsx("cursor-pointer", w.id === woId ? "bg-accent-soft" : "hover:bg-surface-2")}>
                    <td className="tabular whitespace-nowrap px-3 py-1.5 text-fg-2">{w.number}</td>
                    <td className="max-w-[320px] px-2 py-1.5">
                      <div className="truncate text-fg" title={w.title}>
                        {w.title}
                      </div>
                      <div className="text-[11px] capitalize text-fg-3">{w.kind}</div>
                    </td>
                    <td className="max-w-[220px] truncate px-2 py-1.5 text-fg-2">{first ? `${valueOf(first, "name")}${w.assetIds.length > 1 ? ` +${w.assetIds.length - 1}` : ""}` : "–"}</td>
                    <td className={clsx("whitespace-nowrap px-2 py-1.5", late ? "font-medium text-bad" : "text-fg-2")}>{formatDate(w.due)}</td>
                    <td className="px-2 py-1.5">
                      <PriorityBadge priority={w.priority} />
                    </td>
                    <td className="px-2 py-1.5">
                      <WoStatusBadge status={w.status} />
                    </td>
                    <td className="max-w-[140px] truncate px-2 py-1.5 text-fg-2">{w.assignee || "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.length > 1000 ? <div className="border-t border-line p-2 text-center text-[12px] text-fg-3">The first 1,000 of {list.length.toLocaleString()} are shown; search or filter to find the others.</div> : null}
        </div>
      )}
      <SidePanel open={Boolean(open)} onClose={() => setWoId(null)} title={open ? `${open.number} · ${open.title}` : ""} subtitle={open ? `${open.kind.charAt(0).toUpperCase()}${open.kind.slice(1)} · created ${formatDate(open.createdAt.slice(0, 10))} by ${open.createdBy}` : ""} width={560}>
        {open ? <WorkOrderDetail wo={open} /> : null}
      </SidePanel>
    </div>
  );
}

export function WorkOrderDetail({ wo, compactView }: { wo: WorkOrder; compactView?: boolean }) {
  const assets = useFm((s) => s.assets);
  const byId = assetMap(assets);
  const [note, setNote] = useState("");
  const [completing, setCompleting] = useState(false);
  const status = (s: WorkOrderStatus, text?: string) => {
    updateWorkOrder(wo.id, { status: s }, text);
    pushToast("success", `${wo.number}: ${WO_STATUS_LABEL[s].toLowerCase()}.`);
  };
  const open = isOpen(wo);

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <WoStatusBadge status={wo.status} />
        <PriorityBadge priority={wo.priority} />
        <div className="ml-auto flex flex-wrap gap-1.5">
          {wo.status === "open" || wo.status === "on-hold" ? (
            <Button size="sm" icon={<Play size={12} />} onClick={() => status("in-progress")}>
              Start
            </Button>
          ) : null}
          {wo.status === "in-progress" ? (
            <Button size="sm" icon={<Pause size={12} />} onClick={() => status("on-hold")}>
              On hold
            </Button>
          ) : null}
          {open ? (
            <Button size="sm" variant="primary" icon={<CheckCircle2 size={12} />} onClick={() => setCompleting(true)}>
              Complete
            </Button>
          ) : (
            <Button size="sm" icon={<RotateCcw size={12} />} onClick={() => status("open", "Reopened")}>
              Reopen
            </Button>
          )}
          {open ? (
            <Button size="sm" variant="ghost" icon={<XCircle size={12} />} onClick={() => status("cancelled")}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {!compactView ? (
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="Title" className="col-span-2">
            <input className={inputCls} defaultValue={wo.title} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== wo.title && updateWorkOrder(wo.id, { title: e.target.value.trim() })} />
          </FormRow>
          <FormRow label="Due">
            <input type="date" className={inputCls} value={wo.due} onChange={(e) => e.target.value && updateWorkOrder(wo.id, { due: e.target.value }, `Due date: ${e.target.value}`)} />
          </FormRow>
          <FormRow label="Priority">
            <select className={inputCls} value={wo.priority} onChange={(e) => updateWorkOrder(wo.id, { priority: e.target.value as Priority }, `Priority: ${e.target.value}`)}>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </FormRow>
          <FormRow label="Assigned to" className="col-span-2">
            <input className={inputCls} defaultValue={wo.assignee} onBlur={(e) => e.target.value.trim() !== wo.assignee && updateWorkOrder(wo.id, { assignee: e.target.value.trim() }, e.target.value.trim() ? `Assigned to ${e.target.value.trim()}` : "Unassigned")} placeholder="A person, team or contractor" />
          </FormRow>
          <FormRow label="Details" className="col-span-2">
            <textarea className={textareaCls} rows={3} defaultValue={wo.description} onBlur={(e) => e.target.value.trim() !== wo.description && updateWorkOrder(wo.id, { description: e.target.value.trim() })} />
          </FormRow>
          <FormRow label="Assets" className="col-span-2">
            <AssetPicker value={wo.assetIds} onChange={(ids) => updateWorkOrder(wo.id, { assetIds: ids })} />
          </FormRow>
        </div>
      ) : (
        <div className="flex flex-col gap-1 text-[12.5px]">
          <div className="text-fg-2">Due {formatDate(wo.due)}{wo.assignee ? ` · ${wo.assignee}` : ""}</div>
          {wo.description ? <div className="whitespace-pre-wrap text-fg">{wo.description}</div> : null}
        </div>
      )}

      {wo.assetIds.length ? (
        <ul className="flex flex-col gap-1">
          {wo.assetIds.slice(0, 30).map((id) => {
            const a = byId.get(id);
            return (
              <li key={id} className="text-[12px]">
                <Link href={`/assets?asset=${encodeURIComponent(id)}&tab=maintenance`} className="text-accent hover:underline">
                  {a ? valueOf(a, "name") : id}
                </Link>
                {a ? <span className="text-fg-3"> · {[valueOf(a, "floor"), valueOf(a, "space")].filter(Boolean).join(" · ")}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-3">Log</h3>
        <ol className="flex flex-col gap-2">
          {[...wo.log].reverse().map((l, i) => (
            <li key={i} className="border-l-2 border-line pl-2.5">
              <div className="whitespace-pre-wrap text-[12.5px] text-fg">{l.text}</div>
              <div className="text-[11px] text-fg-3">
                {formatDateTime(l.at)} · {l.by}
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-2 flex gap-2">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" onKeyDown={(e) => e.key === "Enter" && note.trim() && (updateWorkOrder(wo.id, {}, note), setNote(""))} />
          <Button
            disabled={!note.trim()}
            onClick={() => {
              updateWorkOrder(wo.id, {}, note);
              setNote("");
            }}
          >
            Add
          </Button>
        </div>
      </section>
      {completing ? <CompleteDialog wo={wo} onClose={() => setCompleting(false)} /> : null}
    </div>
  );
}

function CompleteDialog({ wo, onClose }: { wo: WorkOrder; onClose: () => void }) {
  const plans = useFm((s) => s.plans);
  const [date, setDate] = useState(todayIso());
  const [notes, setNotes] = useState("");
  const plan = wo.planId ? plans.find((p) => p.id === wo.planId) : undefined;
  const done = () => {
    updateWorkOrder(wo.id, { status: "done", completedAt: `${date}T${new Date().toISOString().slice(11)}` }, notes || undefined);
    pushToast("success", `${wo.number} completed.${plan ? " The task's next due date has moved on." : ""}`);
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Complete ${wo.number}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={done}>
            Complete
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormRow label="Done on">
          <input type="date" className={inputCls} value={date} max={todayIso()} onChange={(e) => setDate(e.target.value || todayIso())} />
        </FormRow>
        <FormRow label="What was done" hint="Findings, parts used, readings, follow-up needed.">
          <textarea className={textareaCls} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} autoFocus />
        </FormRow>
        {plan ? <p className="text-[12px] text-fg-3">This work order comes from the plan &quot;{plan.title}&quot;; its next due date will be one interval after the date it was done.</p> : null}
        <p className="text-[12px] text-fg-3">{plural(wo.assetIds.length, "asset")} on this work order.</p>
      </div>
    </Modal>
  );
}
