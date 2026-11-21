"use client";

import { Plus, Search as SearchIcon, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IndexGate } from "@/components/ui/IndexGate";
import { Menu } from "@/components/ui/Menu";
import { Badge, Button, Input, Select, Spinner } from "@/components/ui/primitives";
import { OPERATOR_LABEL, runQuery, VALUELESS_OPERATORS, type Operator, type Rule } from "@/lib/analysis/query";
import type { ModelIndex } from "@/lib/data/model-index";
import { useModelIndexes } from "@/lib/data/use-model-index";
import type { PlainIdMap } from "@/lib/store";
import { useViewerStore } from "@/lib/store";
import { formatCount, prettyCategory } from "@/lib/utils/format";
import { ElementList } from "../ElementList";
import { ResultActions } from "../ResultActions";

type RuleDraft = Rule & { id: number };

const OPERATORS: Operator[] = ["exists", "missing", "equals", "not_equals", "contains", "matches", "gt", "gte", "lt", "lte", "true", "false"];

export function SearchPanel() {
  const hasModels = useViewerStore((state) => state.models.length > 0);
  const state = useModelIndexes(hasModels);
  return (
    <IndexGate state={state} hasModels={hasModels} emptyHint="Open a model to search its elements by name, class, storey, property, material or type.">
      <SearchBody indexes={state.indexes} />
    </IndexGate>
  );
}

function countOf(map: PlainIdMap) {
  let total = 0;
  for (const ids of Object.values(map)) total += ids.length;
  return total;
}

function SearchBody({ indexes }: { indexes: ModelIndex[] }) {
  const [text, setText] = useState("");
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [result, setResult] = useState<PlainIdMap | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(1);
  const runToken = useRef(0);

  const classes = useMemo(() => [...new Set(indexes.flatMap((index) => index.categories))].sort(), [indexes]);
  const storeys = useMemo(() => [...new Set(indexes.flatMap((index) => index.storeys.map((storey) => storey.name)))], [indexes]);

  const activeRules = useMemo(() => {
    const list: Rule[] = [];
    if (text.trim()) list.push({ kind: "text", text: text.trim() });
    for (const rule of rules) {
      if (rule.kind === "class" && rule.classes.length === 0) continue;
      if (rule.kind === "storey" && rule.storeys.length === 0) continue;
      if ((rule.kind === "attribute" || rule.kind === "property") && !rule.name.trim()) continue;
      if ((rule.kind === "material" || rule.kind === "type") && !rule.text.trim()) continue;
      const { id: _id, ...clean } = rule;
      void _id;
      list.push(clean as Rule);
    }
    return list;
  }, [text, rules]);

  // Re-run shortly after the last edit; stale runs are ignored.
  useEffect(() => {
    if (activeRules.length === 0) {
      runToken.current += 1;
      setResult(null);
      setBusy(false);
      setError(null);
      return;
    }
    const token = ++runToken.current;
    const timer = setTimeout(() => {
      setBusy(true);
      setError(null);
      runQuery(indexes, activeRules)
        .then((matches) => {
          if (token === runToken.current) setResult(matches);
        })
        .catch((reason: unknown) => {
          if (token === runToken.current) setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (token === runToken.current) setBusy(false);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [activeRules, indexes]);

  const add = (rule: Rule) => setRules((previous) => [...previous, { ...rule, id: nextId.current++ } as RuleDraft]);
  const update = (id: number, patch: Partial<Rule>) => setRules((previous) => previous.map((rule) => (rule.id === id ? ({ ...rule, ...patch } as RuleDraft) : rule)));
  const remove = (id: number) => setRules((previous) => previous.filter((rule) => rule.id !== id));

  const total = result ? countOf(result) : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-3">
        <div className="relative">
          <SearchIcon size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-3" />
          <Input className="pl-7" placeholder="Name, tag, type, class or GlobalId" value={text} onChange={(event) => setText(event.target.value)} aria-label="Search text" />
        </div>

        {rules.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-2">
            {rules.map((rule) => (
              <li key={rule.id} className="rounded-md border border-line bg-surface-2 p-2">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{rule.kind}</span>
                  <button type="button" aria-label="Remove filter" onClick={() => remove(rule.id)} className="rounded p-0.5 text-fg-3 hover:bg-surface-3 hover:text-fg">
                    <X size={12} />
                  </button>
                </div>
                <RuleEditor rule={rule} classes={classes} storeys={storeys} onChange={(patch) => update(rule.id, patch)} />
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-2">
          <Menu
            width={200}
            trigger={({ toggle }) => (
              <Button size="sm" icon={<Plus size={12} />} onClick={toggle}>
                Add filter
              </Button>
            )}
            items={[
              { label: "Class", onSelect: () => add({ kind: "class", classes: [] }) },
              { label: "Storey", onSelect: () => add({ kind: "storey", storeys: [] }) },
              { label: "Property or quantity", onSelect: () => add({ kind: "property", set: "", name: "", op: "exists" }) },
              { label: "Attribute", onSelect: () => add({ kind: "attribute", name: "Name", op: "contains", value: "" }) },
              { label: "Material", onSelect: () => add({ kind: "material", text: "" }) },
              { label: "Type name", onSelect: () => add({ kind: "type", text: "" }) },
              { label: "Has classification", onSelect: () => add({ kind: "classification", text: "" }) },
            ]}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {error ? <div className="p-3 text-[12px] text-bad">{error}</div> : null}
        {activeRules.length === 0 ? (
          <p className="p-3 text-[12px] leading-relaxed text-fg-3">
            Type to search, or add filters. Filters combine with AND, for example Class is Wall and Pset_WallCommon.IsExternal is true.
          </p>
        ) : (
          <>
            <div className="border-b border-line p-3">
              <div className="mb-2 flex items-center gap-2 text-[12.5px] text-fg">
                {busy ? <Spinner /> : null}
                <span className="font-medium">{busy && !result ? "Searching…" : `${formatCount(total)} match${total === 1 ? "" : "es"}`}</span>
                {Object.keys(result ?? {}).length > 1 ? <Badge>{Object.keys(result ?? {}).length} models</Badge> : null}
              </div>
              <ResultActions items={result ?? {}} disabled={total === 0} />
            </div>
            {result && total > 0 ? <ElementList items={result} indexes={indexes} className="min-h-0 flex-1" /> : null}
          </>
        )}
      </div>
    </div>
  );
}

function RuleEditor({ rule, classes, storeys, onChange }: { rule: Rule; classes: string[]; storeys: string[]; onChange: (patch: Partial<Rule>) => void }) {
  if (rule.kind === "class") {
    return <MultiPick options={classes.map((value) => ({ value, label: prettyCategory(value) }))} values={rule.classes} onChange={(values) => onChange({ classes: values } as Partial<Rule>)} placeholder="Choose classes" />;
  }
  if (rule.kind === "storey") {
    return <MultiPick options={[...storeys, "No storey"].map((value) => ({ value, label: value }))} values={rule.storeys} onChange={(values) => onChange({ storeys: values } as Partial<Rule>)} placeholder="Choose storeys" />;
  }
  if (rule.kind === "attribute" || rule.kind === "property") {
    return (
      <div className="flex flex-col gap-1.5">
        {rule.kind === "property" ? (
          <Input placeholder="Set name (optional), e.g. Pset_WallCommon" value={rule.set ?? ""} onChange={(event) => onChange({ set: event.target.value } as Partial<Rule>)} aria-label="Property set name" />
        ) : null}
        <Input
          placeholder={rule.kind === "property" ? "Property name, e.g. IsExternal" : "Attribute, e.g. Name, Tag, ObjectType"}
          value={rule.name}
          onChange={(event) => onChange({ name: event.target.value } as Partial<Rule>)}
          aria-label={rule.kind === "property" ? "Property name" : "Attribute name"}
        />
        <div className="flex gap-1.5">
          <Select value={rule.op} onChange={(event) => onChange({ op: event.target.value as Operator } as Partial<Rule>)} aria-label="Operator" className="w-[46%]">
            {OPERATORS.map((op) => (
              <option key={op} value={op}>
                {OPERATOR_LABEL[op]}
              </option>
            ))}
          </Select>
          {VALUELESS_OPERATORS.has(rule.op) ? null : (
            <Input placeholder="Value" value={rule.value ?? ""} onChange={(event) => onChange({ value: event.target.value } as Partial<Rule>)} aria-label="Value" />
          )}
        </div>
      </div>
    );
  }
  if (rule.kind === "classification") {
    return <Input placeholder="System, code or name (empty = any)" value={rule.text} onChange={(event) => onChange({ text: event.target.value } as Partial<Rule>)} aria-label="Classification text" />;
  }
  if (rule.kind === "material" || rule.kind === "type") {
    return <Input placeholder={rule.kind === "material" ? "Material name contains…" : "Type name contains…"} value={rule.text} onChange={(event) => onChange({ text: event.target.value } as Partial<Rule>)} aria-label={`${rule.kind} text`} />;
  }
  return null;
}

/** Compact multi-select: chips for the chosen values plus a dropdown for the rest. */
export function MultiPick({ options, values, onChange, placeholder }: { options: { value: string; label: string }[]; values: string[]; onChange: (values: string[]) => void; placeholder: string }) {
  const remaining = options.filter((option) => !values.includes(option.value));
  return (
    <div className="flex flex-col gap-1.5">
      {values.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {values.map((value) => (
            <span key={value} className="inline-flex items-center gap-1 rounded bg-accent-soft py-0.5 pl-1.5 pr-0.5 text-[11.5px] font-medium text-accent">
              {options.find((option) => option.value === value)?.label ?? value}
              <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((entry) => entry !== value))} className="rounded p-0.5 hover:bg-accent/15">
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <Select
        value=""
        onChange={(event) => {
          if (event.target.value) onChange([...values, event.target.value]);
        }}
        aria-label={placeholder}
        disabled={remaining.length === 0}
      >
        <option value="">{remaining.length === 0 ? "All chosen" : placeholder}</option>
        {remaining.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
