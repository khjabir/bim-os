"use client";

import { ChevronDown, ChevronRight, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, IconButton, Input, Segmented, Select } from "@/components/ui/primitives";
import { refreshStoreys } from "@/lib/convert/actions";
import { convertWorker } from "@/lib/convert/client";
import { DISCIPLINES, disciplineLabel } from "@/lib/convert/disciplines";
import { updateSettings, useConvertStore } from "@/lib/convert/store";
import type { FrameConfig, PartSummary, StoreyDef } from "@/lib/convert/types";
import { formatCount, formatNumber } from "@/lib/utils/format";
import { Card, Field, NumberField } from "./parts";

export function AssembleCard() {
  const parts = useConvertStore((s) => s.parts);
  const plans = useConvertStore((s) => s.plans);
  const hasIfc = useConvertStore((s) => s.sources.some((x) => x.ifc));
  return (
    <Card step={3} title="Assemble" id="convert-assemble">
      {parts.length === 0 && plans.length === 0 && !hasIfc ? (
        <p className="text-[12px] leading-relaxed text-fg-3">Once a model or plan is in, its source files are listed here with a suggested discipline, the storeys found in it, and where the site sits.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <ProjectFields />
          {parts.length ? <PartsTable parts={parts} /> : null}
          <StoreysEditor />
          <FrameEditor />
          {parts.length ? <Filters parts={parts} /> : null}
        </div>
      )}
    </Card>
  );
}

function Heading({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{children}</h3>
      <div className="ml-auto flex items-center gap-1">{aside}</div>
    </div>
  );
}

function ProjectFields() {
  const s = useConvertStore((st) => st.settings);
  const [more, setMore] = useState(false);
  return (
    <div>
      <Heading>Project</Heading>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Project name">
          <Input value={s.projectName} onChange={(e) => updateSettings({ projectName: e.target.value })} placeholder="Converted model" aria-label="Project name" />
        </Field>
        <Field label="File name prefix">
          <Input value={s.filePrefix} onChange={(e) => updateSettings({ filePrefix: e.target.value })} placeholder="Same as the project" aria-label="File name prefix" />
        </Field>
        {more ? (
          <>
            <Field label="Building">
              <Input value={s.buildingName} onChange={(e) => updateSettings({ buildingName: e.target.value })} aria-label="Building name" />
            </Field>
            <Field label="Site">
              <Input value={s.siteName} onChange={(e) => updateSettings({ siteName: e.target.value })} aria-label="Site name" />
            </Field>
            <Field label="Author">
              <Input value={s.author} onChange={(e) => updateSettings({ author: e.target.value })} aria-label="Author" />
            </Field>
            <Field label="Organisation">
              <Input value={s.organization} onChange={(e) => updateSettings({ organization: e.target.value })} aria-label="Organisation" />
            </Field>
          </>
        ) : null}
      </div>
      <button type="button" className="mt-1.5 flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg" onClick={() => setMore(!more)}>
        {more ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Building, site, author
      </button>
    </div>
  );
}

function PartsTable({ parts }: { parts: PartSummary[] }) {
  const partConfig = useConvertStore((s) => s.partConfig);
  const byModel = useMemo(() => {
    const map = new Map<string, PartSummary[]>();
    for (const p of parts) {
      const key = `${p.model}`;
      const list = map.get(key) ?? [];
      list.push(p);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [parts]);
  const setPart = (id: string, patch: Partial<{ include: boolean; discipline: string }>) => {
    useConvertStore.setState((s) => ({ partConfig: { ...s.partConfig, [id]: { ...s.partConfig[id], ...patch } } }));
    if (patch.include !== undefined) void refreshStoreys();
  };
  const disciplines = new Map<string, number>();
  for (const p of parts) {
    const c = partConfig[p.id];
    if (c?.include) disciplines.set(c.discipline, (disciplines.get(c.discipline) ?? 0) + p.elements);
  }

  return (
    <div>
      <Heading aside={<span className="text-[11px] text-fg-3">{[...disciplines.keys()].map(disciplineLabel).join(" · ")}</span>}>Source files and disciplines</Heading>
      <div className="overflow-hidden rounded-md border border-line">
        {byModel.map(([model, list]) => (
          <div key={model} className="border-b border-line last:border-b-0">
            {byModel.length > 1 || list.length > 1 ? (
              <div className="flex items-center gap-2 bg-surface-2 px-2.5 py-1.5">
                <span className="truncate text-[11.5px] font-medium text-fg-2" title={model}>
                  {model}
                </span>
                <span className="ml-auto text-[11px] text-fg-3">{list.length} files</span>
                <button type="button" className="text-[11px] text-fg-3 underline" onClick={() => list.forEach((p) => setPart(p.id, { include: true }))}>
                  all
                </button>
                <button type="button" className="text-[11px] text-fg-3 underline" onClick={() => list.forEach((p) => setPart(p.id, { include: false }))}>
                  none
                </button>
              </div>
            ) : null}
            <ul>
              {list.map((p) => {
                const c = partConfig[p.id] ?? { include: true, discipline: p.suggestion.id };
                const top = Object.entries(p.categories)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([k, v]) => `${k} ${formatCount(v)}`)
                  .join(", ");
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-2.5 py-1.5 first:border-t-0" data-testid="convert-part">
                    <input type="checkbox" checked={c.include} onChange={(e) => setPart(p.id, { include: e.target.checked })} className="size-3.5 accent-[var(--accent)]" aria-label={`Include ${p.name}`} />
                    <div className="min-w-0 flex-1 basis-48">
                      <div className="truncate text-[12px] text-fg" title={p.name}>
                        {p.name}
                      </div>
                      <div className="truncate text-[11px] text-fg-3" title={top}>
                        {formatCount(p.elements)} elements · {top}
                      </div>
                    </div>
                    <div className="w-44 shrink-0">
                      <Select value={c.discipline} onChange={(e) => setPart(p.id, { discipline: e.target.value })} aria-label={`Discipline of ${p.name}`}>
                        {DISCIPLINES.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {p.suggestion.reason === "file name" ? null : <Badge tone="neutral" className="hidden sm:inline-flex">by content</Badge>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-fg-3">Files with the same discipline go into one IFC file. Untick files to leave them out.</p>
    </div>
  );
}

function StoreysEditor() {
  const storeys = useConvertStore((s) => s.storeys);
  const edited = useConvertStore((s) => s.storeysEdited);
  const set = (next: StoreyDef[]) => useConvertStore.setState({ storeys: next, storeysEdited: true });
  const [open, setOpen] = useState(false);
  const shown = open ? storeys : storeys.slice(0, 8);
  return (
    <div>
      <Heading
        aside={
          <>
            {edited ? (
              <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => void refreshStoreys(true)}>
                Detect again
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={12} />}
              onClick={() => {
                const top = storeys[storeys.length - 1];
                let key = `u${storeys.length}`;
                while (storeys.some((s) => s.key === key)) key += "_";
                set([...storeys, { key, name: `Level ${storeys.length}`, elevation: top ? Math.round((top.elevation + 3.5) * 100) / 100 : 0, levels: [], count: 0 }]);
              }}
            >
              Add
            </Button>
          </>
        }
      >
        Storeys
      </Heading>
      {storeys.length === 0 ? (
        <p className="text-[11.5px] text-fg-3">Found from the levels of the model; traced plans add their own.</p>
      ) : (
        <ul className="overflow-hidden rounded-md border border-line">
          {shown.map((st) => (
            <li key={st.key} className="flex items-center gap-2 border-t border-line px-2 py-1 first:border-t-0" title={st.levels.length ? `Levels: ${st.levels.join(", ")}` : undefined}>
              <Input
                value={st.name}
                onChange={(e) => set(storeys.map((x) => (x.key === st.key ? { ...x, name: e.target.value } : x)))}
                aria-label="Storey name"
                className="flex-1"
              />
              <NumberField
                value={st.elevation}
                label={`Elevation of ${st.name}`}
                suffix="m"
                className="w-28"
                onChange={(n) => set(storeys.map((x) => (x.key === st.key ? { ...x, elevation: n } : x)).sort((a, b) => a.elevation - b.elevation))}
              />
              <span className="tabular w-16 text-right text-[11px] text-fg-3">{st.count ? formatCount(st.count) : ""}</span>
              <IconButton label="Remove storey (its elements are placed by height)" size="sm" onClick={() => set(storeys.filter((x) => x.key !== st.key))}>
                <Trash2 size={12} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {storeys.length > 8 ? (
        <button type="button" className="mt-1 text-[11.5px] text-fg-3 underline" onClick={() => setOpen(!open)}>
          {open ? "Show fewer" : `Show all ${storeys.length}`}
        </button>
      ) : null}
      <p className="mt-1 text-[11px] text-fg-3">Elevations are estimated from where each level&apos;s elements sit. Elements go to the storey of their Revit level, or by height when it is not listed.</p>
    </div>
  );
}

function FrameEditor() {
  const frame = useConvertStore((s) => s.settings.frame);
  const parts = useConvertStore((s) => s.parts);
  const partConfig = useConvertStore((s) => s.partConfig);
  const [resolved, setResolved] = useState<{ origin: [number, number, number]; rotation: number } | null>(null);
  const ids = parts.filter((p) => partConfig[p.id]?.include !== false).map((p) => p.id);
  const key = ids.join("|");
  useEffect(() => {
    if (!ids.length) {
      setResolved(null);
      return;
    }
    let alive = true;
    void convertWorker.frame(frame, ids).then((r) => alive && setResolved(r));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, key]);
  const setFrame = (patch: Partial<FrameConfig>) => updateSettings({ frame: { ...frame, ...patch } });
  return (
    <div>
      <Heading>Site origin</Heading>
      <Segmented<FrameConfig["mode"]>
        value={frame.mode}
        onChange={(mode) => setFrame({ mode, origin: mode === "custom" && resolved ? resolved.origin : frame.origin })}
        options={[
          { value: "auto", label: "Automatic", title: "Keep the model's coordinates; models far from the origin get the site there" },
          { value: "model", label: "Model origin", title: "Site at the model's 0,0,0" },
          { value: "custom", label: "Custom", title: "Site at a point you give, with a rotation" },
        ]}
      />
      {frame.mode === "custom" ? (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Field label="X / Easting (m)">
            <NumberField value={frame.origin[0]} label="Site origin X" onChange={(n) => setFrame({ origin: [n, frame.origin[1], frame.origin[2]] })} />
          </Field>
          <Field label="Y / Northing (m)">
            <NumberField value={frame.origin[1]} label="Site origin Y" onChange={(n) => setFrame({ origin: [frame.origin[0], n, frame.origin[2]] })} />
          </Field>
          <Field label="Z (m)">
            <NumberField value={frame.origin[2]} label="Site origin Z" onChange={(n) => setFrame({ origin: [frame.origin[0], frame.origin[1], n] })} />
          </Field>
          <Field label="Rotation (°)">
            <NumberField value={frame.rotationDeg} step={0.01} label="Site rotation" onChange={(n) => setFrame({ rotationDeg: n })} />
          </Field>
        </div>
      ) : resolved ? (
        <p className="mt-1.5 text-[11.5px] text-fg-3">
          Site at {formatNumber(resolved.origin[0], 1)}, {formatNumber(resolved.origin[1], 1)}, {formatNumber(resolved.origin[2], 1)} m in the model&apos;s coordinates
          {resolved.origin[0] || resolved.origin[1] ? " (the model is far from its origin, so the site moves there and element coordinates stay small)" : ""}.
        </p>
      ) : null}
      <p className="mt-1 text-[11px] text-fg-3">Every output file uses the same site, so the discipline files line up when opened together.</p>
    </div>
  );
}

function Filters({ parts }: { parts: PartSummary[] }) {
  const partConfig = useConvertStore((s) => s.partConfig);
  const excluded = useConvertStore((s) => s.settings.excludedCategories);
  const pattern = useConvertStore((s) => s.settings.excludePattern);
  const [all, setAll] = useState(false);
  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of parts) {
      if (partConfig[p.id]?.include === false) continue;
      for (const [k, v] of Object.entries(p.categories)) map.set(k, (map.get(k) ?? 0) + v);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [parts, partConfig]);
  const shown = all ? categories : categories.slice(0, 18);
  let patternOk = true;
  try {
    if (pattern.trim()) new RegExp(pattern.trim(), "i");
  } catch {
    patternOk = false;
  }
  const toggle = (category: string, on: boolean) => updateSettings({ excludedCategories: on ? excluded.filter((c) => c !== category) : [...excluded, category] });
  return (
    <div>
      <Heading>Categories</Heading>
      <div className="flex flex-wrap gap-1.5">
        {shown.map(([category, count]) => {
          const on = !excluded.includes(category);
          return (
            <label key={category} className={`flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-[11.5px] ${on ? "border-line-strong text-fg" : "border-line text-fg-3 line-through"}`}>
              <input type="checkbox" checked={on} onChange={(e) => toggle(category, e.target.checked)} className="size-3 accent-[var(--accent)]" />
              {category}
              <span className="tabular text-fg-3">{formatCount(count)}</span>
            </label>
          );
        })}
      </div>
      {categories.length > 18 ? (
        <button type="button" className="mt-1 text-[11.5px] text-fg-3 underline" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${categories.length} categories`}
        </button>
      ) : null}
      <Field label="Leave out families or types matching" className="mt-2">
        <Input value={pattern} onChange={(e) => updateSettings({ excludePattern: e.target.value })} placeholder="e.g. logo|signage panel" aria-label="Leave out families or types matching" className={patternOk ? "" : "border-bad"} />
      </Field>
    </div>
  );
}
