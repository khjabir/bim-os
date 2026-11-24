"use client";

// Side-panel sections of the plan editor for plans read from CAD line work
// (layers and their roles, recognition settings), and for what the editor
// selects: walls, doors and windows, rooms and columns.

import { ArrowLeftRight, RefreshCw, Trash2 } from "lucide-react";
import { Button, Callout, Input, Segmented, Select, Spinner } from "@/components/ui/primitives";
import { recognizePlan, setLayerRole } from "@/lib/convert/actions";
import { ROLE_LABELS, type LayerRole } from "@/lib/convert/plans/recognize";
import { paperColor } from "@/lib/convert/plans/vector";
import { updatePlan, type PlanItem, type PlanVector } from "@/lib/convert/store";
import { formatNumber } from "@/lib/utils/format";
import { Field, NumberField, Toggle } from "./parts";

export type Selection = { kind: "wall" | "opening" | "room" | "column"; index: number } | null;

const ROLE_ORDER: LayerRole[] = ["wall", "door", "window", "column", "room", "text", "other", "ignore"];

export function setVector(plan: PlanItem, patch: Partial<PlanVector>) {
  updatePlan(plan.id, (p) => ({ vector: p.vector ? { ...p.vector, ...patch } : p.vector }));
}

export function LayersSection({ plan, step }: { plan: PlanItem; step: number }) {
  const v = plan.vector!;
  const used = v.layers.map((l, i) => ({ ...l, i })).filter((l) => l.count > 0);
  used.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || b.count - a.count);
  return (
    <section className="flex flex-col gap-2" data-testid="plan-layers">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{step} · Layers</h3>
      <p className="text-[11px] leading-snug text-fg-3">
        {v.kind === "pdf" && v.layers.some((l) => l.name.startsWith("Pen "))
          ? "This PDF has no layers, so its lines are grouped by pen. Say which pens draw what."
          : "What each layer draws. The reader guessed from the names and the lines; change any it got wrong."}
      </p>
      <ul className="scroll-thin flex max-h-[260px] flex-col overflow-y-auto rounded-md border border-line">
        {used.map((l) => (
          <li key={l.i} className="flex items-center gap-2 border-b border-line px-2 py-1 last:border-b-0">
            <span className="size-2.5 shrink-0 rounded-sm border border-line-strong" style={{ background: paperColor(l.color) }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[12px] text-fg" title={`${l.name} · ${l.count} items`}>
              {l.name}
            </span>
            <span className="shrink-0 text-[10.5px] tabular-nums text-fg-3">{l.count}</span>
            <div className="w-[112px] shrink-0">
              <Select aria-label={`What layer ${l.name} draws`} value={l.role} onChange={(e) => setLayerRole(plan.id, l.i, e.target.value as LayerRole)} className="h-6 px-1 text-[11.5px]" disabled={v.recognizing}>
                {ROLE_ORDER.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                    {r === l.auto && l.role !== l.auto ? " (guess)" : ""}
                  </option>
                ))}
              </Select>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RecognizeSection({ plan, step, scaled }: { plan: PlanItem; step: number; scaled: boolean }) {
  const v = plan.vector!;
  const set = (patch: Partial<PlanVector["settings"]>) => setVector(plan, { settings: { ...v.settings, ...patch } });
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{step} · Read the plan</h3>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Thinnest wall (m)">
          <NumberField value={v.settings.minThickness} min={0.01} label="Thinnest wall" onChange={(n) => set({ minThickness: n })} />
        </Field>
        <Field label="Thickest wall (m)">
          <NumberField value={v.settings.maxThickness} min={0.02} label="Thickest wall" onChange={(n) => set({ maxThickness: n })} />
        </Field>
      </div>
      <Field label="Walls drawn as one line">
        <Segmented<"auto" | "on" | "off">
          value={v.settings.singleLines}
          onChange={(singleLines) => set({ singleLines })}
          options={[
            { value: "auto", label: "Auto", title: "Single lines become walls when the wall layers have almost no pairs" },
            { value: "on", label: "Yes", title: "Every unpaired line on a wall layer is a wall centre line" },
            { value: "off", label: "No", title: "Only pairs of lines are walls" },
          ]}
        />
      </Field>
      {v.settings.singleLines !== "off" ? (
        <Field label="Their thickness (m)">
          <NumberField value={v.settings.defaultThickness} min={0.02} label="Thickness of single-line walls" onChange={(n) => set({ defaultThickness: n })} />
        </Field>
      ) : null}
      <Toggle checked={v.settings.rooms} onChange={(rooms) => set({ rooms })} label="Find rooms between the walls" hint="When the drawing has no room outlines of its own." />
      <Button variant="primary" icon={v.recognizing ? <Spinner size={13} className="text-accent-fg" /> : <RefreshCw size={13} />} disabled={!scaled || v.recognizing} onClick={() => void recognizePlan(plan.id)} data-testid="plan-recognize">
        {v.recognizing ? "Reading…" : v.recognized ? "Read again" : "Read the plan"}
      </Button>
      {v.recognized && (plan.walls.length || plan.openings.length) ? <p className="text-[11px] text-fg-3">Reading again replaces the walls, openings, rooms and columns, including your edits.</p> : null}
      {v.error ? <Callout tone="warn">{v.error}</Callout> : null}
      {v.warnings.map((w) => (
        <Callout key={w} tone="info">
          {w}
        </Callout>
      ))}
      {v.notes.map((n) => (
        <p key={n} className="text-[11px] leading-snug text-fg-3">
          {n}
        </p>
      ))}
    </section>
  );
}

export function SizesSection({ plan, step }: { plan: PlanItem; step: number }) {
  const sz = plan.sizes;
  const set = (patch: Partial<PlanItem["sizes"]>) => updatePlan(plan.id, (p) => ({ sizes: { ...p.sizes, ...patch } }));
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{step} · Door and window heights</h3>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Door height (m)">
          <NumberField value={sz.doorHeight} min={0.5} label="Door height" onChange={(n) => set({ doorHeight: n })} />
        </Field>
        <Field label="Plain openings (m)">
          <NumberField value={sz.openingHeight} min={0.5} label="Height of openings without a door" onChange={(n) => set({ openingHeight: n })} />
        </Field>
        <Field label="Window sill (m)">
          <NumberField value={sz.windowSill} min={0} label="Window sill height" onChange={(n) => set({ windowSill: n })} />
        </Field>
        <Field label="Window height (m)">
          <NumberField value={sz.windowHeight} min={0.1} label="Window height" onChange={(n) => set({ windowHeight: n })} />
        </Field>
      </div>
    </section>
  );
}

export function countsText(plan: PlanItem): string {
  const doors = plan.openings.filter((o) => o.kind === "door").length;
  const windows = plan.openings.filter((o) => o.kind === "window").length;
  const plain = plan.openings.filter((o) => o.kind === "opening").length;
  const parts = [`${plan.walls.length} walls`];
  if (doors) parts.push(`${doors} door${doors === 1 ? "" : "s"}`);
  if (windows) parts.push(`${windows} window${windows === 1 ? "" : "s"}`);
  if (plain) parts.push(`${plain} opening${plain === 1 ? "" : "s"}`);
  if (plan.rooms.length) parts.push(`${plan.rooms.length} room${plan.rooms.length === 1 ? "" : "s"}`);
  if (plan.columns.length) parts.push(`${plan.columns.length} column${plan.columns.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function ringArea(ring: [number, number][]) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i],
      q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Fields for the selected door, window, room or column. */
export function SelectionEditor({ plan, sel, mpp, onDelete }: { plan: PlanItem; sel: Selection; mpp: number; onDelete: () => void }) {
  if (!sel) return null;
  if (sel.kind === "opening") {
    const o = plan.openings[sel.index];
    if (!o) return null;
    const width = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) * mpp;
    const setKind = (kind: typeof o.kind) =>
      updatePlan(plan.id, (p) => ({
        openings: p.openings.map((x, i) => (i === sel.index ? { ...x, kind, operation: kind === "door" ? (x.operation ?? "SINGLE_SWING_LEFT") : null, swing: kind === "door" ? (x.swing ?? perpendicular(x)) : x.swing } : x)),
      }));
    const flip = () =>
      updatePlan(plan.id, (p) => ({
        openings: p.openings.map((x, i) => {
          if (i !== sel.index) return x;
          const swing = x.swing ? ([-x.swing[0], -x.swing[1]] as [number, number]) : perpendicular(x);
          const operation = x.operation?.replace(/LEFT|RIGHT/, (m) => (m === "LEFT" ? "RIGHT" : "LEFT")) ?? x.operation;
          return { ...x, swing, operation };
        }),
      }));
    return (
      <div className="flex flex-col gap-2 rounded-md border border-line p-2" data-testid="plan-selection">
        <div className="flex items-center gap-2">
          <Segmented<typeof o.kind>
            value={o.kind}
            onChange={setKind}
            options={[
              { value: "door", label: "Door" },
              { value: "window", label: "Window" },
              { value: "opening", label: "Opening", title: "A gap without a door or window" },
            ]}
          />
          <span className="ml-auto text-[11.5px] tabular-nums text-fg-3">{formatNumber(width, 2)} m wide</span>
        </div>
        {o.name ? <p className="truncate text-[11px] text-fg-3">From block {o.name}</p> : null}
        <div className="flex gap-2">
          {o.kind === "door" ? (
            <Button size="sm" icon={<ArrowLeftRight size={12} />} onClick={flip} title="Open to the other side of the wall">
              Flip swing
            </Button>
          ) : null}
          <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={onDelete} className="ml-auto">
            Delete
          </Button>
        </div>
      </div>
    );
  }
  if (sel.kind === "room") {
    const r = plan.rooms[sel.index];
    if (!r) return null;
    const set = (patch: Partial<typeof r>) => updatePlan(plan.id, (p) => ({ rooms: p.rooms.map((x, i) => (i === sel.index ? { ...x, ...patch } : x)) }));
    return (
      <div className="flex flex-col gap-2 rounded-md border border-line p-2" data-testid="plan-selection">
        <div className="grid grid-cols-[1fr_88px] gap-2">
          <Field label="Room name">
            <Input value={r.name ?? ""} onChange={(e) => set({ name: e.target.value || null })} aria-label="Room name" />
          </Field>
          <Field label="Number">
            <Input value={r.number ?? ""} onChange={(e) => set({ number: e.target.value || null })} aria-label="Room number" />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] tabular-nums text-fg-3">{formatNumber(ringArea(r.outline) * mpp * mpp, 1)} m²</span>
          <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={onDelete} className="ml-auto">
            Delete
          </Button>
        </div>
      </div>
    );
  }
  if (sel.kind === "column") {
    const c = plan.columns[sel.index];
    if (!c) return null;
    return (
      <div className="flex items-center gap-2 rounded-md border border-line p-2" data-testid="plan-selection">
        <span className="text-[12px] text-fg-2">{c.circle ? `Round column Ø${formatNumber(c.circle.r * 2 * mpp, 2)} m` : "Column"}</span>
        <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={onDelete} className="ml-auto">
          Delete
        </Button>
      </div>
    );
  }
  return null;
}

/** The left normal of an opening (image axes): a default swing. */
function perpendicular(o: { a: [number, number]; b: [number, number] }): [number, number] {
  const L = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) || 1;
  return [(o.b[1] - o.a[1]) / L, -(o.b[0] - o.a[0]) / L];
}

export function BusyNote({ busy, text }: { busy: boolean; text: string }) {
  if (!busy) return null;
  return (
    <div className="flex items-center gap-2 text-[11.5px] text-fg-3">
      <Spinner size={12} />
      {text}
    </div>
  );
}
