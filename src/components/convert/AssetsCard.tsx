"use client";

import { FileSpreadsheet, ListChecks, Network, RefreshCw } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Callout, Input, ProgressBar, Segmented, Select } from "@/components/ui/primitives";
import { assetOptions, buildOptions } from "@/lib/convert/actions";
import { CODE_TOKENS, DEFAULT_ASSET_CATEGORIES, DEFAULT_CODE_PATTERN, initials, KEY_FIELDS, SPACE_CATEGORIES } from "@/lib/convert/assets/categories";
import { FIELD_BY_ID, FIELD_GROUP_LABELS, FIELDS, type FieldGroup } from "@/lib/convert/assets/fields";
import type { RegisterSummary } from "@/lib/convert/assets/register";
import { convertWorker } from "@/lib/convert/client";
import { updateSettings, useConvertStore } from "@/lib/convert/store";
import { downloadBlob } from "@/lib/utils/download";
import { formatCount } from "@/lib/utils/format";
import { Card, Field, Stat } from "./parts";

const AUTO = "\u0000auto";
const NONE = "\u0000none";

type FieldView = "key" | "electrical" | "technical" | "fire" | "cafm" | "all";
const VIEW_GROUPS: Record<Exclude<FieldView, "key" | "all">, FieldGroup[]> = {
  electrical: ["electrical"],
  technical: ["technical"],
  fire: ["fire"],
  cafm: ["cafm", "identity", "location"],
};

function Heading({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{children}</h3>
      <div className="ml-auto flex items-center gap-1">{aside}</div>
    </div>
  );
}

/**
 * The asset register: equipment with its make, model, serial, dates, warranty,
 * service life and PPM, the room it is in and what it serves, read from the
 * extracted model and exported as COBie 2.4 and as a flat onboarding sheet.
 */
export function AssetsCard() {
  const parts = useConvertStore((s) => s.parts);
  const partConfig = useConvertStore((s) => s.partConfig);
  const settings = useConvertStore((s) => s.settings);
  const storeys = useConvertStore((s) => s.storeys);
  const [summary, setSummary] = useState<RegisterSummary | null>(null);
  const [summaryKey, setSummaryKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<FieldView>("key");
  const [allCategories, setAllCategories] = useState(false);
  // Which button started the current work: the busy spinner goes on that one.
  const [doing, setDoing] = useState<"read" | "cobie" | "workbook" | "sld" | null>(null);
  // The last files, reused while nothing they depend on has changed.
  const files = useRef<{ key: string; cobie: Blob; workbook: Blob; sld: Blob } | null>(null);

  const included = parts.filter((p) => partConfig[p.id]?.include !== false);
  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of included) for (const [k, v] of Object.entries(p.categories)) map.set(k, (map.get(k) ?? 0) + v);
    return [...map.entries()].filter(([c]) => !SPACE_CATEGORIES.has(c)).sort((a, b) => b[1] - a[1]);
  }, [included]);
  const rooms = useMemo(() => included.reduce((n, p) => n + Object.entries(p.categories).reduce((m, [c, v]) => m + (SPACE_CATEGORIES.has(c) ? v : 0), 0), 0), [included]);
  const selected = settings.assetCategories ?? DEFAULT_ASSET_CATEGORIES;
  const assetCount = categories.reduce((n, [c, v]) => n + (selected.includes(c) ? v : 0), 0);
  const shownCategories = allCategories ? categories : categories.filter(([c], i) => i < 24 || selected.includes(c));

  // The register depends on the parts, storeys, categories and field sources; the files also on the project and COBie author.
  const key = JSON.stringify([included.map((p) => p.id), selected, settings.assetSources, storeys.map((s) => [s.key, s.name, s.elevation]), settings.siteCode, settings.buildingCode, settings.assetCodePattern, settings.siteName, settings.buildingName]);
  const fileKey = JSON.stringify([key, settings.projectName, settings.filePrefix, settings.cobieEmail, settings.cobieCompany, settings.cobiePhone, settings.currency]);
  const stale = summary !== null && summaryKey !== key;

  const run = async () => {
    setBusy("Reading assets");
    setDoing("read");
    setError(null);
    setProgress(undefined);
    try {
      const requested = key;
      const result = await convertWorker.assets(buildOptions(), assetOptions(), (phase, done, total) => {
        setBusy(phase);
        setProgress(total ? done / total : undefined);
      });
      setSummary(result);
      setSummaryKey(requested);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setDoing(null);
    }
  };

  // Re-read when the categories or field sources change after a first read.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (!summary) return;
    const timer = setTimeout(() => void run(), 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(selected), JSON.stringify(settings.assetSources), settings.siteCode, settings.buildingCode, settings.assetCodePattern]);

  const prefix = (settings.filePrefix || settings.projectName || "model").replace(/[\\/:*?"<>|]+/g, "-");
  const download = async (which: "cobie" | "workbook" | "sld") => {
    setBusy(which === "cobie" ? "Writing the COBie workbook" : which === "sld" ? "Drawing the single-line diagrams" : "Writing the asset register");
    setDoing(which);
    setError(null);
    try {
      let current = files.current;
      if (!current || current.key !== fileKey) {
        const requested = key;
        const requestedFiles = fileKey;
        const result = await convertWorker.assetFiles(
          buildOptions(),
          assetOptions(),
          { contactEmail: settings.cobieEmail.trim(), contactCompany: settings.cobieCompany.trim(), contactPhone: settings.cobiePhone.trim(), currency: settings.currency.trim() },
          (phase, done, total) => {
            setBusy(phase);
            setProgress(total ? done / total : undefined);
          },
        );
        setSummary(result.summary);
        setSummaryKey(requested);
        current = { key: requestedFiles, cobie: result.cobie, workbook: result.workbook, sld: result.sld };
        files.current = current;
      }
      if (which === "cobie") downloadBlob(current.cobie, `${prefix}-COBie.xlsx`);
      else if (which === "sld") downloadBlob(current.sld, `${prefix}-single-line-diagrams.html`);
      else downloadBlob(current.workbook, `${prefix}-asset-register.xlsx`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setDoing(null);
    }
  };
  const toggleCategory = (category: string, on: boolean) => {
    const next = on ? [...new Set([...selected, category])] : selected.filter((c) => c !== category);
    updateSettings({ assetCategories: next });
  };
  const setSource = (field: string, value: string) => {
    const sources = { ...settings.assetSources };
    if (value === AUTO) delete sources[field];
    else sources[field] = value === NONE ? "" : value;
    updateSettings({ assetSources: sources });
  };

  const fieldIds = view === "key" ? KEY_FIELDS : view === "all" ? FIELDS.map((f) => f.id) : VIEW_GROUPS[view].flatMap((g) => FIELDS.filter((f) => f.group === g).map((f) => f.id));
  const groupStarts = new Set<string>();
  if (view === "all" || view === "cafm") {
    let last = "";
    for (const id of fieldIds) {
      const g = FIELD_BY_ID.get(id)?.group ?? "";
      if (g !== last) groupStarts.add(id);
      last = g;
    }
  }
  const sourceOf = (field: string) => summary?.sources.find((s) => s.field === field);

  return (
    <Card
      title="Asset register"
      id="convert-assets"
      aside={
        <>
          <Badge>COBie 2.4</Badge>
          <Badge>Excel</Badge>
        </>
      }
    >
      {included.length === 0 ? (
        <p className="text-[12px] text-fg-3">Add a model to list its equipment: make, model, serial numbers, dates, warranty, service life and PPM, the room each item is in and what it serves.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed text-fg-2">
            Equipment with its make, model, serial number, dates, warranty, service life and PPM, the room each item is in, its systems, and what serves it and what it serves; electrical boards
            and circuits as single-line diagrams, MEP technical data, fire and life safety data, asset codes and suggested classification; with the model&apos;s floors, rooms and zones. Exported as a COBie
            2.4 workbook and as a flat asset register for onboarding. Fields the model doesn&apos;t carry stay blank and show up in the coverage.
          </p>

          <div>
            <Heading aside={<button type="button" className="text-[11px] text-fg-3 underline" onClick={() => updateSettings({ assetCategories: null })}>Maintainable equipment</button>}>
              Asset categories
            </Heading>
            <div className="flex flex-wrap gap-1.5" data-testid="convert-asset-categories">
              {shownCategories.map(([category, count]) => {
                const on = selected.includes(category);
                return (
                  <label key={category} className={`flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-[11.5px] ${on ? "border-accent/60 bg-accent-soft text-fg" : "border-line text-fg-3"}`}>
                    <input type="checkbox" checked={on} onChange={(e) => toggleCategory(category, e.target.checked)} className="size-3 accent-[var(--accent)]" />
                    {category}
                    <span className="tabular text-fg-3">{formatCount(count)}</span>
                  </label>
                );
              })}
            </div>
            {categories.length > shownCategories.length || allCategories ? (
              <button type="button" className="mt-1 text-[11.5px] text-fg-3 underline" onClick={() => setAllCategories(!allCategories)}>
                {allCategories ? "Show fewer" : `Show all ${categories.length} categories`}
              </button>
            ) : null}
            <p className="mt-1 text-[11px] text-fg-3">
              {formatCount(assetCount)} assets in {selected.filter((c) => categories.some(([k]) => k === c)).length} categories{rooms ? ` · ${formatCount(rooms)} rooms in the model` : " · no rooms in the model: rooms named by the assets are listed instead"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant={summary && !stale ? "secondary" : "primary"} size="sm" icon={summary ? <RefreshCw size={12} /> : <ListChecks size={13} />} busy={doing === "read"} disabled={busy !== null || assetCount === 0} onClick={() => void run()} data-testid="convert-assets-read">
              {summary ? "Read again" : "Read assets"}
            </Button>
            {busy ? <span className="text-[11.5px] text-fg-3">{busy}…</span> : null}
          </div>
          {busy && progress !== undefined ? <ProgressBar value={progress} /> : null}

          {summary ? (
            <div data-testid="convert-assets-summary">
              <div className="mb-3 grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-6">
                <Stat label="Assets" value={formatCount(summary.stats.assets)} />
                <Stat label="Types" value={formatCount(summary.stats.types)} />
                <Stat label="Rooms" value={formatCount(summary.stats.spaces)} />
                <Stat label="In a room" value={`${summary.stats.assets ? Math.round((100 * summary.stats.withSpace) / summary.stats.assets) : 0}%`} />
                <Stat label="Systems" value={formatCount(summary.stats.systems)} />
                <Stat label="Serving links" value={formatCount(summary.stats.relations)} />
                <Stat label="Boards" value={formatCount(summary.stats.boards)} />
                <Stat label="Circuits" value={formatCount(summary.stats.circuits)} />
                <Stat label="Fire & life safety" value={formatCount(summary.stats.fireDevices)} />
                <Stat label="Technical data" value={formatCount(summary.stats.withTechnical)} />
              </div>
              {summary.trees.length ? (
                <p className="mb-3 text-[11.5px] leading-snug text-fg-3" data-testid="convert-assets-trees">
                  Electrical distribution:{" "}
                  {summary.trees.slice(0, 6).map((t, i) => (
                    <span key={t.name}>
                      {i ? ", " : ""}
                      <span className="text-fg-2">{t.name}</span> ({formatCount(t.boards)} board{t.boards === 1 ? "" : "s"}, {formatCount(t.items)} item{t.items === 1 ? "" : "s"})
                    </span>
                  ))}
                  {summary.trees.length > 6 ? ` and ${summary.trees.length - 6} more` : ""}.
                </p>
              ) : null}
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">Fields and where they are read from</h3>
                <Segmented
                  className="ml-auto"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "key", label: "Key", title: "The fields most platforms need" },
                    { value: "electrical", label: "Electrical", title: "Boards, ratings, loads and circuits" },
                    { value: "technical", label: "MEP", title: "Airflow, capacities, motors, pumps, refrigerant, lighting and lifts" },
                    { value: "fire", label: "Fire", title: "Fire alarm, sprinklers, dampers, fire ratings" },
                    { value: "cafm", label: "CAFM", title: "Parent asset, criticality, maintainer, statutory; identity and location" },
                    { value: "all", label: "All", title: `Every field (${FIELDS.length})` },
                  ]}
                />
              </div>
              {/* A grid rather than a table: on a phone each field takes two lines, the source picker under the name. */}
              <div role="table" aria-label="Asset fields" className="text-[11.5px]">
                <div role="row" className="hidden grid-cols-[minmax(0,1fr)_120px_minmax(0,300px)] gap-x-2 py-1 text-[10.5px] uppercase tracking-wide text-fg-3 sm:grid">
                  <span role="columnheader" className="font-medium">
                    Field
                  </span>
                  <span role="columnheader" className="font-medium">
                    Filled
                  </span>
                  <span role="columnheader" className="font-medium">
                    Read from
                  </span>
                </div>
                {fieldIds.map((id) => {
                  const def = FIELD_BY_ID.get(id)!;
                  const src = sourceOf(id);
                  const pct = src && src.total ? src.filled / src.total : 0;
                  const chosen = settings.assetSources[id];
                  const value = chosen === undefined ? AUTO : chosen === "" ? NONE : chosen;
                  const candidates = summary.candidates[id] ?? [];
                  const others = def.level === "space" ? [] : summary.properties.filter((p) => !candidates.some((c) => c.key === p.key));
                  return (
                    <Fragment key={id}>
                    {groupStarts.has(id) && def.group ? (
                      <div role="row" className="border-t border-line pb-0.5 pt-2.5">
                        <span role="cell" className="text-[10.5px] font-semibold uppercase tracking-wide text-fg-3">
                          {FIELD_GROUP_LABELS[def.group]}
                        </span>
                      </div>
                    ) : null}
                    <div
                      role="row"
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-t border-line py-1.5 sm:grid-cols-[minmax(0,1fr)_120px_minmax(0,300px)] sm:py-1"
                      data-testid="convert-asset-field"
                    >
                      <div role="cell" className="min-w-0 text-fg" title={def.hint}>
                        {def.label}
                        {def.unit ? <span className="ml-1 text-[10px] text-fg-3">{def.unit}</span> : null}
                        {def.level === "type" ? <span className="ml-1 text-[10px] text-fg-3">type</span> : def.level === "space" ? <span className="ml-1 text-[10px] text-fg-3">room</span> : null}
                      </div>
                      <div role="cell" className="flex items-center gap-1.5" title={src ? `${formatCount(src.filled)} of ${formatCount(src.total)} ${def.level === "space" ? "rooms" : "assets it applies to"}` : undefined}>
                        <div className="h-1.5 w-14 overflow-hidden rounded bg-surface-3">
                          <div className={`h-full ${pct > 0.8 ? "bg-ok" : pct > 0 ? "bg-accent" : ""}`} style={{ width: `${Math.round(pct * 100)}%` }} />
                        </div>
                        <span className="tabular w-9 text-right text-fg-2">{src ? `${Math.round(pct * 100)}%` : "–"}</span>
                      </div>
                      <div role="cell" className="col-span-2 min-w-0 sm:col-span-1">
                        <Select value={value} onChange={(e) => setSource(id, e.target.value)} aria-label={`Source of ${def.label}`} className="w-full">
                          <option value={AUTO}>
                            {src?.auto && src.keys.length ? `Automatic: ${src.keys[0]}${src.note ? `; ${src.note}` : ""}` : src?.note ? `Automatic: ${src.note}` : "Automatic (not in the model)"}
                          </option>
                          {candidates.length ? (
                            <optgroup label="Matching properties">
                              {candidates.map((c) => (
                                <option key={c.key} value={c.key}>
                                  {c.key} ({formatCount(c.count)})
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                          {others.length ? (
                            <optgroup label="Other properties">
                              {others.slice(0, 300).map((c) => (
                                <option key={c.key} value={c.key}>
                                  {c.key} ({formatCount(c.count)})
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                          <option value={NONE}>Leave empty</option>
                          {value !== AUTO && value !== NONE && !candidates.some((c) => c.key === value) && !others.some((c) => c.key === value) ? <option value={value}>{value}</option> : null}
                        </Select>
                      </div>
                    </div>
                    </Fragment>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-fg-3">
                Served-by links come from shared systems (equipment to the terminals and devices of its system), electrical boards (the board an item is fed from) and properties that name them.
                {summary.issueCount ? ` ${formatCount(summary.issueCount)} data issue${summary.issueCount === 1 ? "" : "s"} are listed in the workbooks.` : ""}
                {summary.jobs ? ` ${summary.jobs} PPM task${summary.jobs === 1 ? "" : "s"} found.` : " No PPM data in the model."}
              </p>
            </div>
          ) : null}

          <div>
            <Heading>Location and asset codes</Heading>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_120px_minmax(0,1fr)]">
              <Field label="Site code">
                <Input value={settings.siteCode} onChange={(e) => updateSettings({ siteCode: e.target.value.toUpperCase().replace(/\s+/g, "").slice(0, 12) })} placeholder={initials(settings.siteName) || "SITE"} aria-label="Site code" />
              </Field>
              <Field label="Building code">
                <Input value={settings.buildingCode} onChange={(e) => updateSettings({ buildingCode: e.target.value.toUpperCase().replace(/\s+/g, "").slice(0, 12) })} placeholder={initials(settings.buildingName) || "BLDG"} aria-label="Building code" />
              </Field>
              <Field label="Asset code pattern">
                <Input value={settings.assetCodePattern} onChange={(e) => updateSettings({ assetCodePattern: e.target.value })} placeholder={DEFAULT_CODE_PATTERN} aria-label="Asset code pattern" className="font-mono" />
              </Field>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-fg-3">
              Tokens: {CODE_TOKENS.join(" ")}. {"{seq}"} numbers the assets that share the rest of the code.
              {summary?.codes.length ? (
                <>
                  {" "}
                  First codes: <span className="font-mono text-fg-2" data-testid="convert-assets-codes">{summary.codes.slice(0, 3).join(", ")}</span>
                </>
              ) : null}
            </p>
          </div>

          <div>
            <Heading>COBie author</Heading>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Email (COBie CreatedBy)">
                <Input value={settings.cobieEmail} onChange={(e) => updateSettings({ cobieEmail: e.target.value })} placeholder="name@company.com" aria-label="COBie author email" type="email" />
              </Field>
              <Field label="Company">
                <Input value={settings.cobieCompany} onChange={(e) => updateSettings({ cobieCompany: e.target.value })} aria-label="COBie author company" />
              </Field>
              <Field label="Phone">
                <Input value={settings.cobiePhone} onChange={(e) => updateSettings({ cobiePhone: e.target.value })} aria-label="COBie author phone" />
              </Field>
              <Field label="Currency of costs">
                <Input value={settings.currency} onChange={(e) => updateSettings({ currency: e.target.value.toUpperCase().slice(0, 3) })} placeholder="AED" aria-label="Currency" />
              </Field>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<FileSpreadsheet size={13} />} disabled={busy !== null || assetCount === 0} busy={doing === "workbook"} onClick={() => void download("workbook")} data-testid="convert-assets-register">
              Asset register (.xlsx)
            </Button>
            <Button icon={<FileSpreadsheet size={13} />} disabled={busy !== null || assetCount === 0} busy={doing === "cobie"} onClick={() => void download("cobie")} data-testid="convert-assets-cobie">
              COBie (.xlsx)
            </Button>
            <Button icon={<Network size={13} />} disabled={busy !== null || assetCount === 0} busy={doing === "sld"} onClick={() => void download("sld")} data-testid="convert-assets-sld" title="The electrical distribution drawn as single-line diagrams, one page to open in a browser or print">
              Single-line diagrams (.html)
            </Button>
          </div>
          {error ? <Callout tone="bad">{error}</Callout> : null}
        </div>
      )}
    </Card>
  );
}
