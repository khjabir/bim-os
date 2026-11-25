"use client";

// The plan editor's assistant section: room types, the drawing's notes, and
// changes asked for in plain words. Room types from names and notes read by
// the rules work without the assistant; the assistant adds what they miss and
// turns requests into changes. Nothing is applied before the user says so.

import clsx from "clsx";
import { Check, FileText, House, Sparkles, TriangleAlert, Undo2, Wand2 } from "lucide-react";
import { useState } from "react";
import { OnDeviceStatus, OnDeviceSwitch } from "@/components/ondevice/OnDeviceControls";
import { Button, Callout, Select, Spinner } from "@/components/ui/primitives";
import { useAssistant } from "@/lib/ondevice/engine";
import { applyEdits, applyFindings, findingEffect, previewEdits, readPlanNotes, roomsToType, setRoomType, suggestRoomTypes, undoAssistant } from "@/lib/convert/assistActions";
import type { EditStep, Selection } from "@/lib/convert/plans/planEdits";
import { findingText, NOTE_FIELDS, type NoteField } from "@/lib/convert/plans/planNotes";
import { ROOM_TYPES } from "@/lib/convert/plans/roomTypes";
import type { PlanItem } from "@/lib/convert/store";
import { pushToast } from "@/lib/store";

const SOURCE: Record<string, string> = { name: "from its name", assistant: "suggested by the assistant", user: "set by you" };

export function RoomTypeSelect({ plan, index, className }: { plan: PlanItem; index: number; className?: string }) {
  const r = plan.rooms[index];
  if (!r) return null;
  return (
    <Select aria-label={`Type of room ${[r.number, r.name].filter(Boolean).join(" ") || index + 1}`} value={r.type ?? ""} onChange={(e) => setRoomType(plan.id, index, e.target.value || null)} className={clsx("h-6 px-1 text-[11.5px]", className)}>
      <option value="">No type</option>
      {ROOM_TYPES.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label}
        </option>
      ))}
    </Select>
  );
}

export function AssistantSection({ plan, step, sel, onChanged }: { plan: PlanItem; step: number; sel: Selection; onChanged: () => void }) {
  const enabled = useAssistant((s) => s.enabled);
  const status = useAssistant((s) => s.status);
  const busy = status === "busy" || status === "loading";
  const scaled = Boolean(plan.calibration && plan.calibration.metresPerPixel > 0);
  return (
    <section className="flex flex-col gap-2.5" data-testid="plan-assistant">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{step} · Assistant</h3>
      <OnDeviceSwitch />
      <RoomTypes plan={plan} enabled={enabled} busy={busy} />
      {plan.vector ? <Notes plan={plan} enabled={enabled} busy={busy} onChanged={onChanged} /> : null}
      <Changes plan={plan} sel={sel} enabled={enabled} busy={busy} scaled={scaled} onChanged={onChanged} />
      {plan.undo ? (
        <Button
          size="sm"
          icon={<Undo2 size={12} />}
          onClick={() => {
            undoAssistant(plan.id);
            onChanged();
          }}
          className="self-start"
          data-testid="assistant-undo"
        >
          Undo {plan.undo.label}
        </Button>
      ) : null}
    </section>
  );
}

function RoomTypes({ plan, enabled, busy }: { plan: PlanItem; enabled: boolean; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  if (!plan.rooms.length) return null;
  const counts = { name: 0, assistant: 0, user: 0 };
  for (const r of plan.rooms) if (r.type && r.typeSource) counts[r.typeSource]++;
  const typed = plan.rooms.filter((r) => r.type).length;
  const todo = roomsToType(plan).length;
  const parts = [counts.name ? `${counts.name} from their names` : "", counts.assistant ? `${counts.assistant} by the assistant` : "", counts.user ? `${counts.user} by you` : ""].filter(Boolean);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 text-[12px] text-fg-2" data-testid="room-types-count">
        <House size={12} className="shrink-0 text-fg-3" aria-hidden />
        Room types: {typed} of {plan.rooms.length} rooms{parts.length ? ` (${parts.join(", ")})` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {todo && enabled ? (
          <Button
            size="sm"
            icon={working ? <Spinner size={12} /> : <Sparkles size={12} />}
            disabled={busy || working}
            onClick={async () => {
              setWorking(true);
              try {
                const n = await suggestRoomTypes(plan.id);
                pushToast("info", n ? `Typed ${n} room${n === 1 ? "" : "s"}: check them in the list.` : "The assistant could not type these rooms from their names.");
              } catch (error) {
                if (!(error instanceof Error && error.message === "Stopped.")) pushToast("error", error instanceof Error ? error.message : String(error));
              } finally {
                setWorking(false);
              }
            }}
            data-testid="suggest-room-types"
          >
            Suggest types for {todo} room{todo === 1 ? "" : "s"}
          </Button>
        ) : null}
        <button type="button" className="text-[11.5px] text-fg-3 underline" onClick={() => setOpen(!open)}>
          {open ? "Hide the rooms" : "Show the rooms"}
        </button>
      </div>
      {todo && !enabled ? <p className="text-[11px] leading-snug text-fg-3">{todo} named room{todo === 1 ? "" : "s"} could not be typed from the name: turn on the assistant to suggest types, or set them below.</p> : null}
      {open ? (
        <ul className="scroll-thin flex max-h-[240px] flex-col overflow-y-auto rounded-md border border-line" data-testid="room-types">
          {plan.rooms.map((r, i) => (
            <li key={i} className="flex items-center gap-2 border-b border-line px-2 py-1 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg" title={r.typeSource ? `Type ${SOURCE[r.typeSource]}` : undefined}>
                {[r.number, r.name].filter(Boolean).join(" · ") || `Room ${i + 1}`}
                {r.typeSource === "assistant" ? <Sparkles size={10} className="ml-1 inline text-accent" aria-label="suggested by the assistant" /> : null}
              </span>
              <div className="w-[150px] shrink-0">
                <RoomTypeSelect plan={plan} index={i} />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Notes({ plan, enabled, busy, onChanged }: { plan: PlanItem; enabled: boolean; busy: boolean; onChanged: () => void }) {
  const notes = plan.notes ?? null;
  const [picked, setPicked] = useState<Set<NoteField> | null>(null);
  const reading = Boolean(notes?.reading);
  const findings = notes?.findings ?? [];
  const effects = findings.map((f) => ({ f, e: findingEffect(plan, f) }));
  const chosen = picked ?? new Set(effects.filter(({ f, e }) => e.ok && !notes?.applied.includes(f.field)).map(({ f }) => f.field));
  const read = (withAssistant: boolean) => {
    setPicked(null);
    void readPlanNotes(plan.id, withAssistant);
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="plan-notes">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[12px] text-fg-2">
          <FileText size={12} className="shrink-0 text-fg-3" aria-hidden />
          Notes on the drawing
        </span>
        <Button size="sm" className="ml-auto" icon={reading ? <Spinner size={12} /> : undefined} disabled={reading || busy} onClick={() => read(enabled)} data-testid="read-notes">
          {notes ? "Read again" : "Read the notes"}
        </Button>
      </div>
      {notes?.error ? <Callout tone="warn">{notes.error}</Callout> : null}
      {notes && !reading ? (
        <p className="text-[11px] leading-snug text-fg-3" data-testid="notes-summary">
          {notes.blocks.length
            ? `${notes.blocks.length} block${notes.blocks.length === 1 ? "" : "s"} of notes · ${findings.length ? `${findings.length} value${findings.length === 1 ? "" : "s"} found` : "nothing the model can use"}${notes.assistant ? " (read by the rules and the assistant)" : enabled ? "" : " (read by the rules; the assistant reads free text too)"}.`
            : "No notes found on this drawing."}
        </p>
      ) : null}
      {effects.length ? (
        <ul className="flex flex-col rounded-md border border-line" data-testid="note-findings">
          {effects.map(({ f, e }) => {
            const applied = notes?.applied.includes(f.field);
            return (
              <li key={f.field} className="flex items-start gap-2 border-b border-line px-2 py-1.5 last:border-b-0">
                <input
                  type="checkbox"
                  className="mt-[3px] size-3.5 shrink-0 accent-[var(--accent)]"
                  checked={chosen.has(f.field)}
                  disabled={!e.ok}
                  aria-label={`Apply ${NOTE_FIELDS[f.field].label}`}
                  onChange={(ev) => {
                    const next = new Set(chosen);
                    if (ev.target.checked) next.add(f.field);
                    else next.delete(f.field);
                    setPicked(next);
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] text-fg">
                    {NOTE_FIELDS[f.field].label}: <strong className="font-semibold">{findingText(f)}</strong>
                    {applied ? <Check size={11} className="ml-1 inline text-ok" aria-label="applied" /> : null}
                    {f.source === "assistant" ? <Sparkles size={10} className="ml-1 inline text-accent" aria-label="found by the assistant" /> : null}
                  </span>
                  <span className="block truncate text-[10.5px] text-fg-3" title={f.quote}>
                    “{f.quote}” · now {e.now}
                    {e.note ? ` · ${e.note}` : ""}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {effects.length ? (
        <Button
          size="sm"
          variant="primary"
          className="self-start"
          disabled={!chosen.size}
          onClick={() => {
            const done = applyFindings(plan.id, [...chosen]);
            setPicked(new Set());
            if (done.length) onChanged();
            pushToast("info", done.length ? `Applied ${done.length} value${done.length === 1 ? "" : "s"} from the notes.` : "Nothing to apply.");
          }}
          data-testid="apply-notes"
        >
          Apply {chosen.size || ""} selected
        </Button>
      ) : null}
    </div>
  );
}

const EXAMPLE = "e.g. make the external walls 300 mm; the door between the kitchen and the dining room is sliding; rename room 104 to Server room";

function Changes({ plan, sel, enabled, busy, scaled, onChanged }: { plan: PlanItem; sel: Selection; enabled: boolean; busy: boolean; scaled: boolean; onChanged: () => void }) {
  const [request, setRequest] = useState("");
  const [steps, setSteps] = useState<EditStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  /** Changes the user unticked. */
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const chosen = steps?.filter((s, i) => s.apply && !skip.has(i)) ?? [];
  const preview = async () => {
    if (!request.trim()) return;
    setWorking(true);
    setError(null);
    setSteps(null);
    setSkip(new Set());
    try {
      setSteps(await previewEdits(plan.id, request, sel));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== "Stopped.") setError(message);
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="plan-changes">
      <span className="flex items-center gap-1.5 text-[12px] text-fg-2">
        <Wand2 size={12} className="shrink-0 text-fg-3" aria-hidden />
        Ask for a change
      </span>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void preview();
        }}
      >
        <textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void preview();
            }
          }}
          rows={2}
          placeholder={EXAMPLE}
          disabled={!enabled || !scaled}
          className="w-full min-w-0 resize-y rounded-md border border-line-strong bg-surface px-2 py-1.5 text-[12px] leading-snug text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none disabled:opacity-60"
          aria-label="Change to make, in your own words"
          data-testid="change-request"
        />
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" icon={working ? <Spinner size={12} /> : <Sparkles size={12} />} disabled={!enabled || !scaled || !request.trim() || busy || working} data-testid="preview-changes">
            Show the changes
          </Button>
          {!enabled ? <span className="text-[11px] text-fg-3">Needs the assistant.</span> : !scaled ? <span className="text-[11px] text-fg-3">Set the scale first.</span> : sel ? <span className="truncate text-[11px] text-fg-3">“This” means the selected {sel.kind === "opening" ? (plan.openings[sel.index]?.kind ?? "opening") : sel.kind}.</span> : null}
        </div>
      </form>
      {working ? <OnDeviceStatus /> : null}
      {error ? <Callout tone="warn">{error}</Callout> : null}
      {steps ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-line p-2" data-testid="change-steps">
          <ul className="flex flex-col gap-1">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11.5px] leading-snug">
                {s.apply ? (
                  <input
                    type="checkbox"
                    className="mt-[2px] size-3.5 shrink-0 accent-[var(--accent)]"
                    checked={!skip.has(i)}
                    aria-label={`Apply: ${s.summary ?? ""}`}
                    onChange={(e) => {
                      const next = new Set(skip);
                      if (e.target.checked) next.delete(i);
                      else next.add(i);
                      setSkip(next);
                    }}
                  />
                ) : (
                  <TriangleAlert size={12} className="mt-[2px] shrink-0 text-warn" aria-hidden />
                )}
                <span className={s.apply ? "text-fg" : "text-fg-3"}>{s.summary ?? s.problem}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!chosen.length}
              onClick={() => {
                const r = applyEdits(plan.id, chosen, `“${request.trim().slice(0, 40)}${request.trim().length > 40 ? "…" : ""}”`, sel);
                if (r.changed) {
                  setSteps(r.changed);
                  setSkip(new Set());
                  setError("The plan changed since: check the changes again.");
                  return;
                }
                setSteps(null);
                setError(null);
                if (r.applied) {
                  setRequest("");
                  onChanged();
                }
              }}
              data-testid="apply-changes"
            >
              Apply {chosen.length} change{chosen.length === 1 ? "" : "s"}
            </Button>
            <Button size="sm" onClick={() => setSteps(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
