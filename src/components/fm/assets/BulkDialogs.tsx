"use client";

// Changes to many assets at once: one field set on all of them, or a site
// check recorded for all of them.

import { useMemo, useState } from "react";
import { pushToast } from "@/lib/store";
import { FIELD_BY_ID } from "@/lib/convert/assets/fields";
import { FIELD_GROUPS, fieldLabel, TOP_FIELDS, valueOf } from "@/lib/fm/asset";
import { assetMap, editAssets, useFm, verifyAssets } from "@/lib/fm/store";
import { Button } from "@/components/ui/primitives";
import { FormRow, inputCls, Modal, plural, textareaCls } from "../ui";

/** The input type that suits a field. */
export function inputTypeOf(field: string): "date" | "number" | "text" {
  const kind = FIELD_BY_ID.get(field)?.kind;
  if (kind === "date") return "date";
  if (kind === "year" || kind === "number" || kind === "money" || kind === "quantity") return "number";
  return "text";
}

/** A date as an <input type="date"> shows it ("2021-03-15"), or "" when it is not a full date. */
export const dateInput = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");

export function FieldSelect({ value, onChange }: { value: string; onChange: (field: string) => void }) {
  return (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Field">
      <optgroup label="Asset">
        {Object.entries(TOP_FIELDS).map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </optgroup>
      {FIELD_GROUPS.map((g) => (
        <optgroup key={g.group} label={g.label}>
          {g.fields
            .filter((f) => f !== "space" && f !== "tag")
            .map((f) => (
              <option key={f} value={f}>
                {fieldLabel(f)}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

export function BulkEditDialog({ ids, onClose, initialField = "manufacturer" }: { ids: string[]; onClose: () => void; initialField?: string }) {
  const assets = useFm((s) => s.assets);
  const [field, setField] = useState(initialField);
  const [value, setValue] = useState("");
  const byId = assetMap(assets);
  const chosen = ids.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const suggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of assets) {
      const v = valueOf(a, field);
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([v]) => v);
  }, [assets, field]);
  const current = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of chosen) counts.set(valueOf(a, field) || "(empty)", (counts.get(valueOf(a, field) || "(empty)") ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [chosen, field]);
  const type = inputTypeOf(field);

  const apply = () => {
    editAssets(ids, field, value);
    pushToast("success", `${fieldLabel(field)} ${value.trim() ? `set to "${value.trim()}"` : "cleared"} on ${plural(ids.length, "asset")}.`);
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${plural(ids.length, "asset")}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply}>
            Apply to {plural(ids.length, "asset")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormRow label="Field">
          <FieldSelect
            value={field}
            onChange={(f) => {
              setField(f);
              setValue("");
            }}
          />
        </FormRow>
        <FormRow label="New value" hint="Recorded as your change next to the model's value, which stays as it was. A value equal to the model's removes the change.">
          <input autoFocus className={inputCls} type={type} value={type === "date" ? dateInput(value) : value} onChange={(e) => setValue(e.target.value)} list="bulk-suggestions" onKeyDown={(e) => e.key === "Enter" && apply()} />
          <datalist id="bulk-suggestions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </FormRow>
        <div className="rounded-md bg-surface-2 px-2.5 py-2 text-[12px] text-fg-2">
          Now:{" "}
          {current.map(([v, n], i) => (
            <span key={v}>
              {i ? ", " : ""}
              <span className="font-medium text-fg">{v}</span> ({n})
            </span>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function VerifyDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [condition, setCondition] = useState("");
  const [notes, setNotes] = useState("");
  const apply = () => {
    verifyAssets(ids, { condition: condition ? Number(condition) : undefined, notes: notes.trim() || undefined });
    pushToast("success", `${plural(ids.length, "asset")} marked as checked on site.`);
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Checked on site: ${plural(ids.length, "asset")}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply}>
            Mark as checked
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] leading-relaxed text-fg-2">Records that the asset was seen on site and its information confirmed, with your name and today&apos;s date.</p>
        <ConditionField value={condition} onChange={setCondition} />
        <FormRow label="Notes">
          <textarea className={textareaCls} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </FormRow>
      </div>
    </Modal>
  );
}

export const CONDITIONS = [
  { value: "5", label: "5 · As new" },
  { value: "4", label: "4 · Good" },
  { value: "3", label: "3 · Fair" },
  { value: "2", label: "2 · Poor" },
  { value: "1", label: "1 · Very poor, replace" },
];

export function ConditionField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <FormRow label="Condition" group>
      <div className="grid grid-cols-5 gap-1">
        {CONDITIONS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => onChange(value === c.value ? "" : c.value)}
            className={`rounded-md border px-1 py-1.5 text-[11px] leading-tight ${value === c.value ? "border-accent bg-accent-soft text-accent" : "border-line-strong text-fg-2 hover:bg-surface-2"}`}
            aria-pressed={value === c.value}
          >
            {c.label}
          </button>
        ))}
      </div>
    </FormRow>
  );
}
