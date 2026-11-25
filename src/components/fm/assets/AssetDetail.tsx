"use client";

// One asset: its information (edited per field, the model's value kept),
// the site check, maintenance and work orders, live readings, photos, how it
// connects to other assets, its label and its history.

import clsx from "clsx";
import { Activity, AlertTriangle, Camera, CheckCircle2, ChevronDown, ChevronRight, Network, Pause, Pencil, Play, Plus, Printer, RotateCcw, Trash2, Wrench } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { LineChart } from "@/components/charts/LineChart";
import { Button } from "@/components/ui/primitives";
import { pushToast } from "@/lib/store";
import { FIELD_BY_ID } from "@/lib/convert/assets/fields";
import { alarmText, numeric } from "@/lib/fm/alarms";
import { ALWAYS_SHOWN, FIELD_GROUPS, fieldLabel, isEdited, missingKeyFields, modelValue, statusOf, TOP_FIELDS, valueOf } from "@/lib/fm/asset";
import { filterText } from "@/lib/fm/filter";
import { labelPayload, qrSvg } from "@/lib/fm/qr";
import { dayOf, daysBetween, dueState, isOpen, todayIso } from "@/lib/fm/schedule";
import { addPhotos, createWorkOrders, deletePhoto, editAssets, photoBlob, revertEdit, savePlans, uid, updatePlan, useFm } from "@/lib/fm/store";
import { intervalText } from "@/lib/fm/tasks";
import type { Asset, Unit } from "@/lib/fm/types";
import { setLabelQueue } from "../labels/queue";
import { WorkOrderDialog } from "../WorkOrderDialog";
import { AssetStatusBadge, DueBadge, Empty, formatDate, formatDateTime, inputCls, plural, Tabs, useParam, WoStatusBadge } from "../ui";
import { dateInput, inputTypeOf, VerifyDialog } from "./BulkDialogs";

type Tab = "details" | "maintenance" | "live" | "photos" | "relations" | "label" | "history";

export function AssetDetail({ asset }: { asset: Asset }) {
  const [tabParam, setTab] = useParam("tab");
  const workOrders = useFm((s) => s.workOrders);
  const points = useFm((s) => s.points);
  const photos = useFm((s) => s.photos);
  const tab = (["details", "maintenance", "live", "photos", "relations", "label", "history"].includes(tabParam) ? tabParam : "details") as Tab;
  const myOrders = workOrders.filter((w) => w.assetIds.includes(asset.id));
  const myPoints = points.filter((p) => p.assetId === asset.id);
  const myPhotos = photos.filter((p) => p.assetId === asset.id);
  const openOrders = myOrders.filter(isOpen).length;

  return (
    <div className="flex flex-col">
      <Tabs
        className="sticky top-0 z-10 bg-surface px-2"
        value={tab}
        onChange={(t) => setTab(t === "details" ? null : t)}
        tabs={[
          { id: "details", label: "Details" },
          { id: "maintenance", label: "Maintenance", count: openOrders || undefined, tone: openOrders ? "warn" : undefined },
          ...(myPoints.length ? [{ id: "live" as const, label: "Live", count: myPoints.length }] : []),
          { id: "photos", label: "Photos", count: myPhotos.length || undefined },
          { id: "relations", label: "Connections" },
          { id: "label", label: "Label" },
          { id: "history", label: "History" },
        ]}
      />
      <div className="p-3">
        {tab === "details" ? <Details asset={asset} /> : null}
        {tab === "maintenance" ? <MaintenanceTab asset={asset} /> : null}
        {tab === "live" ? <LiveTab asset={asset} /> : null}
        {tab === "photos" ? <PhotosTab asset={asset} /> : null}
        {tab === "relations" ? <Relations asset={asset} /> : null}
        {tab === "label" ? <LabelTab asset={asset} /> : null}
        {tab === "history" ? <HistoryTab asset={asset} /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details

function Details({ asset }: { asset: Asset }) {
  const [showAll, setShowAll] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const missing = missingKeyFields(asset);
  const status = statusOf(asset);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <AssetStatusBadge status={status} />
        <span className="min-w-0 truncate text-[12px] text-fg-3">{asset.locationPath}</span>
      </div>

      {asset.verified ? (
        <div className="flex items-start gap-2 rounded-md border border-ok/30 bg-ok-soft px-2.5 py-2 text-[12px] text-fg">
          <CheckCircle2 size={15} className="mt-px shrink-0 text-ok" />
          <div className="min-w-0 flex-1">
            Checked on site by <b>{asset.verified.by}</b> on {formatDate(dayOf(asset.verified.at))}
            {asset.verified.condition ? ` · condition ${asset.verified.condition} of 5` : ""}
            {asset.verified.notes ? <div className="mt-0.5 text-fg-2">{asset.verified.notes}</div> : null}
          </div>
          <button type="button" className="shrink-0 text-[11.5px] text-fg-2 hover:text-fg" onClick={() => setVerifying(true)}>
            Check again
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" icon={<CheckCircle2 size={12} />} onClick={() => setVerifying(true)}>
            Mark checked on site
          </Button>
          {missing.length ? (
            <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-warn">
              <AlertTriangle size={12} className="shrink-0" />
              <span className="truncate">Missing {missing.map((f) => fieldLabel(f).toLowerCase()).join(", ")}</span>
            </span>
          ) : null}
        </div>
      )}

      <FieldGroup asset={asset} label="Asset" fields={Object.keys(TOP_FIELDS)} showAll />
      {FIELD_GROUPS.map((g) => (
        <FieldGroup key={g.group} asset={asset} label={g.label} fields={g.fields.filter((f) => f !== "space" && f !== "tag")} showAll={showAll} />
      ))}
      <button type="button" onClick={() => setShowAll((v) => !v)} className="self-start text-[12px] text-accent hover:underline">
        {showAll ? "Hide empty fields" : "Show all fields, to fill in"}
      </button>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-surface-2 px-2.5 py-2 text-[11.5px] text-fg-3">
        <span>Category</span>
        <span className="truncate text-fg-2">{asset.category}</span>
        <span>Type</span>
        <span className="truncate text-fg-2">{asset.typeName}</span>
        <span>Discipline</span>
        <span className="truncate text-fg-2">{asset.discipline}</span>
        {asset.compliance ? (
          <>
            <span>Compliance (suggested)</span>
            <span className="truncate text-fg-2">{asset.compliance}</span>
          </>
        ) : null}
        {asset.uniclass ? (
          <>
            <span>Uniclass (suggested)</span>
            <span className="truncate text-fg-2">{asset.uniclass}</span>
          </>
        ) : null}
        <span>Model file</span>
        <span className="truncate text-fg-2">{asset.file}</span>
        <span>GlobalId</span>
        <span className="truncate font-mono text-fg-2">{asset.id}</span>
      </div>
      {verifying ? <VerifyDialog ids={[asset.id]} onClose={() => setVerifying(false)} /> : null}
    </div>
  );
}

function FieldGroup({ asset, label, fields, showAll }: { asset: Asset; label: string; fields: string[]; showAll: boolean }) {
  const [open, setOpen] = useState(true);
  const shown = fields.filter((f) => showAll || ALWAYS_SHOWN.has(f) || valueOf(asset, f) || isEdited(asset, f));
  if (!shown.length) return null;
  return (
    <section className="rounded-md border border-line">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-3 hover:text-fg">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {label}
      </button>
      {open ? (
        <div className="divide-y divide-line border-t border-line">
          {shown.map((f) => (
            <FieldRow key={f} asset={asset} field={f} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** One field: the value in use, the model's value when it was changed, and an editor. */
export function FieldRow({ asset, field }: { asset: Asset; field: string }) {
  const assets = useFm((s) => s.assets);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [offer, setOffer] = useState<{ value: string; ids: string[] } | null>(null);
  const value = valueOf(asset, field);
  const edit = asset.edits?.[field];
  const def = FIELD_BY_ID.get(field);
  const type = inputTypeOf(field);

  const save = () => {
    setEditing(false);
    if (draft.trim() === value) return;
    editAssets([asset.id], field, draft);
    // A type's information (manufacturer, model, life…) is the same for every asset of the type: offer it to the others.
    if (def?.level === "type" && asset.typeName) {
      const others = assets.filter((a) => a.id !== asset.id && a.typeName === asset.typeName && valueOf(a, field) !== draft.trim()).map((a) => a.id);
      if (others.length) setOffer({ value: draft.trim(), ids: others });
    }
  };

  return (
    <div className="px-2.5 py-1.5">
      <div className="grid grid-cols-[minmax(110px,38%)_minmax(0,1fr)_auto] items-start gap-2">
        <span className="pt-0.5 text-[12px] text-fg-3">{fieldLabel(field)}</span>
        {editing ? (
          <input
            autoFocus
            className={clsx(inputCls, "h-7")}
            type={type}
            value={type === "date" ? dateInput(draft) : draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
            aria-label={fieldLabel(field)}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
            className={clsx("min-w-0 break-words rounded px-1 py-0.5 text-left text-[12.5px] hover:bg-surface-2", value ? "text-fg" : "text-fg-3")}
            title="Edit"
          >
            {value || "Add…"}
            {edit ? <Pencil size={11} className="ml-1 inline text-accent" aria-label="Changed" /> : null}
          </button>
        )}
        {edit && !editing ? (
          <button type="button" onClick={() => revertEdit(asset.id, field)} title={`Back to the model's value${modelValue(asset, field) ? ` (${modelValue(asset, field)})` : " (empty)"}`} className="rounded p-1 text-fg-3 hover:bg-surface-2 hover:text-fg">
            <RotateCcw size={12} />
          </button>
        ) : (
          <span className="w-6" />
        )}
      </div>
      {edit && !editing ? (
        <div className="mt-0.5 pl-[38%] text-[11px] text-fg-3">
          Model: {modelValue(asset, field) || "empty"} · changed by {edit.by}, {formatDate(dayOf(edit.at))}
        </div>
      ) : null}
      {offer ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md bg-accent-soft px-2 py-1.5 text-[12px] text-fg">
          <span className="min-w-0 flex-1">
            Use &quot;{offer.value}&quot; for the other {plural(offer.ids.length, "asset")} of type <b>{asset.typeName}</b> too?
          </span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              editAssets(offer.ids, field, offer.value);
              pushToast("success", `${fieldLabel(field)} set on ${plural(offer.ids.length + 1, "asset")} of ${asset.typeName}.`);
              setOffer(null);
            }}
          >
            Apply to all
          </Button>
          <Button size="sm" onClick={() => setOffer(null)}>
            Only this one
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Maintenance

function MaintenanceTab({ asset }: { asset: Asset }) {
  const plans = useFm((s) => s.plans);
  const workOrders = useFm((s) => s.workOrders);
  const [dialog, setDialog] = useState(false);
  const [adding, setAdding] = useState(false);
  const today = todayIso();
  const mine = plans.filter((p) => p.assetId === asset.id).sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const orders = workOrders.filter((w) => w.assetIds.includes(asset.id));
  const openFor = new Set(orders.filter(isOpen).map((w) => w.planId).filter(Boolean));

  return (
    <div className="flex flex-col gap-4">
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">Maintenance plan</h3>
          <Button size="sm" icon={<Plus size={12} />} onClick={() => setAdding((v) => !v)}>
            Add a task
          </Button>
        </div>
        {adding ? <AddTask asset={asset} onDone={() => setAdding(false)} /> : null}
        {mine.length === 0 ? (
          <Empty>No planned maintenance for this asset. Add a task, or plan the whole register from the task library on the Maintenance page.</Empty>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {mine.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 px-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <div className={clsx("text-[12.5px]", p.active ? "text-fg" : "text-fg-3 line-through")}>{p.title}</div>
                  <div className="text-[11.5px] text-fg-3">
                    {intervalText(p.every, p.unit)} · next {formatDate(p.nextDue)}
                    {p.lastDone ? ` · last done ${formatDate(p.lastDone)}` : ""}
                    {p.statutory ? " · statutory" : ""}
                  </div>
                </div>
                <DueBadge state={dueState(p, today)} days={daysBetween(today, p.nextDue)} />
                {p.active && !openFor.has(p.id) ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      const [wo] = createWorkOrders([{ title: p.title, kind: "planned", priority: p.statutory ? "high" : "normal", due: p.nextDue < today ? today : p.nextDue, assetIds: [asset.id], planId: p.id }]);
                      pushToast("success", `${wo.number} raised.`);
                    }}
                  >
                    Raise work order
                  </Button>
                ) : null}
                <button type="button" title={p.active ? "Pause this task" : "Resume this task"} onClick={() => updatePlan(p.id, { active: !p.active })} className="rounded p-1 text-fg-3 hover:bg-surface-2 hover:text-fg">
                  {p.active ? <Pause size={13} /> : <Play size={13} />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">Work orders</h3>
          <Button size="sm" variant="primary" icon={<Wrench size={12} />} onClick={() => setDialog(true)}>
            New work order
          </Button>
        </div>
        {orders.length === 0 ? (
          <Empty>No work orders for this asset yet.</Empty>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {orders.map((w) => (
              <li key={w.id}>
                <Link href={`/maintenance?tab=orders&wo=${encodeURIComponent(w.id)}`} className="flex items-center gap-2 px-2.5 py-2 hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] text-fg">
                      <span className="tabular mr-1.5 text-fg-3">{w.number}</span>
                      {w.title}
                    </div>
                    <div className="text-[11.5px] text-fg-3">
                      {w.status === "done" && w.completedAt ? `Done ${formatDate(w.completedAt.slice(0, 10))}${w.completedBy ? ` by ${w.completedBy}` : ""}` : `Due ${formatDate(w.due)}`}
                    </div>
                  </div>
                  <WoStatusBadge status={w.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <WorkOrderDialog open={dialog} onClose={() => setDialog(false)} assetIds={[asset.id]} />
    </div>
  );
}

function AddTask({ asset, onDone }: { asset: Asset; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [every, setEvery] = useState(12);
  const [unit, setUnit] = useState<Unit>("month");
  const [start, setStart] = useState(todayIso());
  const add = () => {
    if (!title.trim()) return;
    savePlans([{ id: `${asset.id}|${uid("task")}`, assetId: asset.id, taskId: "manual", title: title.trim(), every: Math.max(1, every), unit, start, nextDue: start, active: true, source: "manual" }]);
    onDone();
  };
  return (
    <div className="mb-2 grid grid-cols-2 gap-2 rounded-md border border-line bg-surface-2 p-2 sm:grid-cols-[1fr_70px_100px_130px_auto]">
      <input className={clsx(inputCls, "col-span-2 sm:col-span-1")} placeholder="Task, such as Replace filters" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <input className={inputCls} type="number" min={1} value={every} onChange={(e) => setEvery(Number(e.target.value) || 1)} aria-label="Every" />
      <select className={inputCls} value={unit} onChange={(e) => setUnit(e.target.value as Unit)} aria-label="Unit">
        <option value="day">days</option>
        <option value="week">weeks</option>
        <option value="month">months</option>
        <option value="year">years</option>
      </select>
      <input className={inputCls} type="date" value={start} onChange={(e) => setStart(e.target.value)} aria-label="First due" />
      <Button variant="primary" onClick={add} disabled={!title.trim()}>
        Add
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live

function LiveTab({ asset }: { asset: Asset }) {
  const points = useFm((s) => s.points).filter((p) => p.assetId === asset.id);
  const series = useFm((s) => s.series);
  const alarms = useFm((s) => s.alarms).filter((a) => a.assetId === asset.id && a.end === undefined);
  useFm((s) => s.liveRev);
  if (!points.length) return <Empty>No live points are linked to this asset. Link them on the Live data page.</Empty>;
  return (
    <div className="flex flex-col gap-4">
      {alarms.map((al) => (
        <div key={al.id} className="flex items-center gap-2 rounded-md border border-bad/30 bg-bad-soft px-2.5 py-2 text-[12px] text-fg">
          <AlertTriangle size={14} className="shrink-0 text-bad" />
          {alarmText(al, points.find((p) => p.id === al.pointId))}
        </div>
      ))}
      {points.map((p) => {
        const data = (series[p.id] ?? []).map(([t, v]) => ({ t, v: numeric(v) })).filter((d): d is { t: number; v: number } => d.v !== null);
        const limits = [p.rule?.high !== undefined ? { label: "High", value: p.rule.high } : null, p.rule?.low !== undefined ? { label: "Low", value: p.rule.low } : null].filter((x): x is { label: string; value: number } => Boolean(x));
        return (
          <section key={p.id} className="rounded-md border border-line p-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="min-w-0 truncate text-[12.5px] font-semibold text-fg">{p.name || p.key}</h3>
              <span className="text-[15px] font-semibold text-fg">
                {p.lastValue ?? "–"}
                {p.unit && p.lastValue !== undefined ? <span className="ml-0.5 text-[11.5px] font-normal text-fg-3">{p.unit}</span> : null}
              </span>
            </div>
            <div className="mb-1 text-[11px] text-fg-3">
              {p.key} · {p.lastAt ? `last reading ${formatDateTime(p.lastAt)}` : "no readings yet"}
            </div>
            {data.length > 1 ? <LineChart title={p.name || p.key} data={data} unit={p.unit} limits={limits} height={150} /> : null}
          </section>
        );
      })}
      <Link href="/live?tab=points" className="flex items-center gap-1 text-[12px] text-accent hover:underline">
        <Activity size={13} /> Manage points and alarm limits
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Photos

function PhotosTab({ asset }: { asset: Asset }) {
  const photos = useFm((s) => s.photos).filter((p) => p.assetId === asset.id);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const input = useRef<HTMLInputElement>(null);
  const ids = photos.map((p) => p.id).join(",");
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    void (async () => {
      const next: Record<string, string> = {};
      for (const p of photos) {
        const blob = await photoBlob(p.id);
        if (blob) {
          const url = URL.createObjectURL(blob);
          made.push(url);
          next[p.id] = url;
        }
      }
      if (alive) setUrls(next);
    })();
    return () => {
      alive = false;
      for (const u of made) URL.revokeObjectURL(u);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button icon={<Camera size={14} />} onClick={() => input.current?.click()}>
          Add photos
        </Button>
        <span className="text-[11.5px] text-fg-3">Kept on this device and in workspace and field change files.</span>
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) void addPhotos(asset.id, files).then(() => pushToast("success", `${plural(files.length, "photo")} added.`));
          }}
        />
      </div>
      {photos.length === 0 ? (
        <Empty>No photos yet: the nameplate, the asset in place, a fault.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {photos.map((p) => (
            <figure key={p.id} className="group relative overflow-hidden rounded-md border border-line bg-surface-2">
              {urls[p.id] ? (
                <a href={urls[p.id]} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={urls[p.id]} alt={p.name} className="aspect-square w-full object-cover" />
                </a>
              ) : (
                <div className="aspect-square" />
              )}
              <figcaption className="truncate px-1.5 py-1 text-[10.5px] text-fg-3">
                {formatDate(dayOf(p.at))} · {p.by}
              </figcaption>
              <button type="button" aria-label="Delete photo" onClick={() => deletePhoto(p.id)} className="absolute right-1 top-1 hidden rounded bg-surface/90 p-1 text-bad group-hover:block">
                <Trash2 size={12} />
              </button>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connections

function Relations({ asset }: { asset: Asset }) {
  const assets = useFm((s) => s.assets);
  const byName = useMemo(() => new Map(assets.map((a) => [a.name, a])), [assets]);
  const link = (name: string) => {
    const a = byName.get(name);
    return a ? (
      <Link key={name} href={`/assets?asset=${encodeURIComponent(a.id)}`} className="text-accent hover:underline">
        {name}
      </Link>
    ) : (
      <span key={name}>{name}</span>
    );
  };
  const list = (names: string[]) => (names.length ? names.slice(0, 60).map((n, i) => <span key={n}>{i ? ", " : ""}{link(n)}</span>) : <span className="text-fg-3">–</span>);
  const space = valueOf(asset, "space");
  return (
    <dl className="grid grid-cols-[minmax(110px,32%)_1fr] gap-x-3 gap-y-2 text-[12.5px]">
      <dt className="text-fg-3">Room</dt>
      <dd className="text-fg">{space ? <Link href={`/assets?q=${encodeURIComponent(filterText("room", space))}`} className="text-accent hover:underline">{[space, asset.roomName].filter(Boolean).join(" · ")}</Link> : "–"}</dd>
      <dt className="text-fg-3">Floor</dt>
      <dd className="text-fg">{valueOf(asset, "floor") || "–"}</dd>
      <dt className="text-fg-3">Fed from</dt>
      <dd className="text-fg">{asset.fedFrom ? link(asset.fedFrom) : "–"}</dd>
      <dt className="text-fg-3">Serves / feeds</dt>
      <dd className="text-fg">{list(asset.serves)}{asset.serves.length > 60 ? ` and ${asset.serves.length - 60} more` : ""}</dd>
      <dt className="text-fg-3">Served by</dt>
      <dd className="text-fg">{list(asset.servedBy)}</dd>
      <dt className="text-fg-3">Part of</dt>
      <dd className="text-fg">{asset.parent ? link(asset.parent) : "–"}</dd>
      <dt className="text-fg-3">Parts</dt>
      <dd className="text-fg">{list(asset.children)}</dd>
      <dt className="text-fg-3">Systems</dt>
      <dd className="flex flex-wrap gap-1">
        {asset.systems.length ? (
          asset.systems.map((s) => (
            <Link key={s} href={`/assets?q=${encodeURIComponent(filterText("system", s))}`} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11.5px] text-fg-2 hover:border-accent hover:text-accent">
              <Network size={11} /> {s}
            </Link>
          ))
        ) : (
          <span className="text-fg-3">–</span>
        )}
      </dd>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Label

function LabelTab({ asset }: { asset: Asset }) {
  const facility = useFm((s) => s.facility);
  const router = useRouter();
  const payload = labelPayload(asset, facility);
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex items-center gap-3 rounded-md border border-line bg-white p-3 text-black">
        <div className="size-28" dangerouslySetInnerHTML={{ __html: qrSvg(payload, { title: valueOf(asset, "code") }) }} />
        <div className="max-w-[220px]">
          <div className="font-mono text-[13px] font-bold">{valueOf(asset, "code")}</div>
          <div className="text-[12px] leading-tight">{valueOf(asset, "name")}</div>
          <div className="mt-1 text-[10.5px] leading-tight text-neutral-600">{[valueOf(asset, "floor"), valueOf(asset, "space")].filter(Boolean).join(" · ")}</div>
        </div>
      </div>
      <p className="max-w-[60ch] text-[12px] leading-relaxed text-fg-3">
        The code holds {facility?.labelBaseUrl ? <>a link to this asset in the field app ({payload})</> : <>the asset code; set the app&apos;s address in Settings to make it a link a phone camera opens</>}.
      </p>
      <Button
        icon={<Printer size={14} />}
        onClick={() => {
          setLabelQueue([asset.id]);
          router.push("/labels?from=asset");
        }}
      >
        Print this label
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History

function HistoryTab({ asset }: { asset: Asset }) {
  const workOrders = useFm((s) => s.workOrders);
  const events: { at: string; text: string; by: string }[] = [];
  for (const [field, e] of Object.entries(asset.edits ?? {})) events.push({ at: e.at, by: e.by, text: `${fieldLabel(field)} set to "${e.value}" (model: ${modelValue(asset, field) || "empty"})` });
  if (asset.verified) events.push({ at: asset.verified.at, by: asset.verified.by, text: `Checked on site${asset.verified.condition ? `, condition ${asset.verified.condition} of 5` : ""}${asset.verified.notes ? `: ${asset.verified.notes}` : ""}` });
  for (const w of workOrders) {
    if (!w.assetIds.includes(asset.id)) continue;
    events.push({ at: w.createdAt, by: w.createdBy, text: `${w.number} created: ${w.title}` });
    if (w.completedAt) events.push({ at: w.completedAt, by: w.completedBy ?? "", text: `${w.number} done: ${w.title}` });
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  if (!events.length) return <Empty>Nothing has changed since the asset came from the model.</Empty>;
  return (
    <ol className="flex flex-col gap-2">
      {events.map((e, i) => (
        <li key={i} className="border-l-2 border-line pl-2.5">
          <div className="text-[12.5px] text-fg">{e.text}</div>
          <div className="text-[11px] text-fg-3">
            {formatDateTime(e.at)}
            {e.by ? ` · ${e.by}` : ""}
          </div>
        </li>
      ))}
    </ol>
  );
}

