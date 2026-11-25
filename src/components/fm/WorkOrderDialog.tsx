"use client";

// Creating a work order: what is wrong or what to do, how urgent, when, who,
// and the assets it is for (picked by search).

import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { pushToast } from "@/lib/store";
import { valueOf } from "@/lib/fm/asset";
import { addDays, todayIso } from "@/lib/fm/schedule";
import { assetItems, parseQuery, scoreItem } from "@/lib/fm/search";
import { assetMap, createWorkOrders, useFm } from "@/lib/fm/store";
import type { Priority, WorkOrder, WorkOrderKind } from "@/lib/fm/types";
import { Button } from "@/components/ui/primitives";
import { FormRow, inputCls, Modal, textareaCls } from "./ui";

const DUE_DAYS: Record<Priority, number> = { urgent: 0, high: 2, normal: 7, low: 28 };

export function WorkOrderDialog({
  open,
  onClose,
  assetIds = [],
  defaults,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  assetIds?: string[];
  defaults?: Partial<Pick<WorkOrder, "title" | "kind" | "priority" | "description" | "planId" | "due">>;
  onCreated?: (wo: WorkOrder) => void;
}) {
  if (!open) return null;
  return <Form onClose={onClose} assetIds={assetIds} defaults={defaults} onCreated={onCreated} />;
}

function Form({ onClose, assetIds, defaults, onCreated }: { onClose: () => void; assetIds: string[]; defaults?: Partial<Pick<WorkOrder, "title" | "kind" | "priority" | "description" | "planId" | "due">>; onCreated?: (wo: WorkOrder) => void }) {
  const workOrders = useFm((s) => s.workOrders);
  const [title, setTitle] = useState(defaults?.title ?? "");
  const [kind, setKind] = useState<WorkOrderKind>(defaults?.kind ?? "reactive");
  const [priority, setPriority] = useState<Priority>(defaults?.priority ?? "normal");
  const [due, setDue] = useState(defaults?.due ?? addDays(todayIso(), DUE_DAYS[defaults?.priority ?? "normal"]));
  const [dueTouched, setDueTouched] = useState(Boolean(defaults?.due));
  const [assignee, setAssignee] = useState("");
  const [description, setDescription] = useState(defaults?.description ?? "");
  const [ids, setIds] = useState<string[]>(assetIds);
  const assignees = useMemo(() => [...new Set(workOrders.map((w) => w.assignee).filter(Boolean))].slice(0, 30), [workOrders]);

  const submit = () => {
    if (!title.trim()) return;
    const [wo] = createWorkOrders([{ title: title.trim(), kind, priority, due, assignee: assignee.trim(), description: description.trim(), assetIds: ids, planId: defaults?.planId }]);
    pushToast("success", `${wo.number} created.`);
    onCreated?.(wo);
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New work order"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!title.trim()} onClick={submit}>
            Create work order
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <FormRow label="What needs doing">
          <input autoFocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fan noisy, water leak under the unit, replace filter…" />
        </FormRow>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <FormRow label="Kind">
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as WorkOrderKind)}>
              <option value="reactive">Reactive (a fault)</option>
              <option value="planned">Planned</option>
              <option value="inspection">Inspection</option>
            </select>
          </FormRow>
          <FormRow label="Priority">
            <select
              className={inputCls}
              value={priority}
              onChange={(e) => {
                const p = e.target.value as Priority;
                setPriority(p);
                if (!dueTouched) setDue(addDays(todayIso(), DUE_DAYS[p]));
              }}
            >
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </FormRow>
          <FormRow label="Due" className="col-span-2 sm:col-span-1">
            <input
              type="date"
              className={inputCls}
              value={due}
              onChange={(e) => {
                setDue(e.target.value);
                setDueTouched(true);
              }}
            />
          </FormRow>
        </div>
        <FormRow label="Assigned to" hint="A person, a team or a contractor.">
          <input className={inputCls} value={assignee} onChange={(e) => setAssignee(e.target.value)} list="wo-assignees" placeholder="Optional" />
          <datalist id="wo-assignees">
            {assignees.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </FormRow>
        <FormRow label="Assets" group>
          <AssetPicker value={ids} onChange={setIds} />
        </FormRow>
        <FormRow label="Details">
          <textarea className={textareaCls} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was seen, where exactly, access, safety…" />
        </FormRow>
      </form>
    </Modal>
  );
}

/** Assets chosen by searching for them; each shows as a removable chip. */
export function AssetPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const assets = useFm((s) => s.assets);
  const rev = useFm((s) => s.rev);
  const [query, setQuery] = useState("");
  const byId = assetMap(assets);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => assetItems(assets), [rev]);
  const matches = useMemo(() => {
    const { tokens } = parseQuery(query);
    if (!tokens.length) return [];
    const scored: { id: string; title: string; subtitle: string; score: number }[] = [];
    for (const item of items) {
      if (value.includes(item.id)) continue;
      const score = scoreItem(item, tokens);
      if (score > 0) scored.push({ id: item.id, title: item.title, subtitle: item.subtitle, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 8);
  }, [items, query, value]);

  return (
    <div className="flex flex-col gap-1.5">
      {value.length ? (
        <div className="flex flex-wrap gap-1">
          {value.map((id) => {
            const a = byId.get(id);
            return (
              <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface-2 py-0.5 pl-2 pr-1 text-[12px] text-fg">
                <span className="truncate">{a ? `${valueOf(a, "name")}` : id}</span>
                <button type="button" aria-label="Remove" onClick={() => onChange(value.filter((x) => x !== id))} className="rounded p-0.5 text-fg-3 hover:bg-surface-3 hover:text-fg">
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="relative">
        <input className={inputCls} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search assets by code, name, room…" aria-label="Add an asset" />
        {matches.length ? (
          <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-md border border-line bg-surface p-1 shadow-pop">
            {matches.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange([...value, m.id]);
                    setQuery("");
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2"
                >
                  <Plus size={13} className="shrink-0 text-fg-3" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-fg">{m.title}</span>
                    <span className="block truncate text-[11px] text-fg-3">{m.subtitle}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
