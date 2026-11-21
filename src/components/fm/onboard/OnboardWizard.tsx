"use client";

// Onboarding, step by step: the building's models in, its details, which
// elements are assets, the gaps filled once per type, maintenance planned,
// and the workspace created (with COBie and the register to hand on).

import clsx from "clsx";
import { AlertTriangle, ArrowLeft, ArrowRight, Box, Building2, Check, CheckCircle2, Download, FileInput, FolderOpen, Loader2, Package, QrCode, Search, Sparkles, Trash2, Upload, Wrench } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Toggle } from "@/components/convert/parts";
import { Button, Callout, ProgressBar } from "@/components/ui/primitives";
import { DEFAULT_ASSET_CATEGORIES, initials, SPACE_CATEGORIES } from "@/lib/convert/assets/categories";
import { useConvertStore } from "@/lib/convert/store";
import { entriesFromDrop, entriesFromPicker } from "@/lib/collection/files";
import { downloadBlob } from "@/lib/utils/download";
import { formatBytes } from "@/lib/utils/format";
import { demoWorkspace } from "@/lib/fm/demo";
import { fileStem } from "@/lib/fm/package";
import { generatePlans, kindRows } from "@/lib/fm/planning";
import { replaceWorkspace, useFm } from "@/lib/fm/store";
import { DEFAULT_TASKS, intervalText, TASK_LIBRARY_NOTE } from "@/lib/fm/tasks";
import { compact, FormRow, inputCls, MeterList, Panel, plural, StatTile, useParam } from "../ui";
import { addModelFiles, buildWorkspace, createFromWizard, goTo, handoverFiles, refreshSummary, removeModel, resetOnboarding, STEPS, TYPE_GAP_FIELDS, typeRows, takeConvertPageModels, useOnboard, type Step } from "./state";
import { fieldLabel } from "@/lib/fm/asset";

export function OnboardWizard() {
  const [demo] = useParam("demo");
  if (demo) return <DemoCard />;
  return <Wizard />;
}

// ---------------------------------------------------------------------------
// Demo

function DemoCard() {
  const router = useRouter();
  const facility = useFm((s) => s.facility);
  const [busy, setBusy] = useState(false);
  return (
    <div className="scroll-thin grid h-full place-items-center overflow-y-auto bg-bg p-4">
      <div className="w-full max-w-[560px] rounded-xl border border-line bg-surface p-5">
        <div className="mb-2 grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
          <Sparkles size={20} />
        </div>
        <h1 className="text-[17px] font-semibold text-fg">Try the demo building</h1>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-2">
          Harbour View Offices is a made-up five-floor office building with about 180 assets (air handling, pumps, boards, lifts, fire alarm devices), rooms and systems, a maintenance plan with work orders, and simulated live readings with alarm limits. Everything works as it would with a real building.
        </p>
        {facility ? <Callout tone="warn" className="mt-3">It replaces {facility.name} on this device. Export that workspace first (Settings) if you want to keep it.</Callout> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              await replaceWorkspace(demoWorkspace());
              router.push("/");
            }}
          >
            {facility ? "Replace with the demo" : "Open the demo"}
          </Button>
          <Button onClick={() => router.push("/onboard")}>Onboard a real building instead</Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wizard frame

function Wizard() {
  const step = useOnboard((s) => s.step);
  const busy = useOnboard((s) => s.busy);
  const error = useOnboard((s) => s.error);
  const index = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="border-b border-line bg-surface px-3 py-3 sm:px-4">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h1 className="text-[17px] font-semibold tracking-tight text-fg">Onboard a building</h1>
              <p className="text-[12px] text-fg-2">From the building&apos;s models to a maintained asset register, kept on this device.</p>
            </div>
            <button type="button" onClick={resetOnboarding} className="text-[12px] text-fg-3 hover:text-fg">
              Start over
            </button>
          </div>
          <ol className="flex gap-1 overflow-x-auto" aria-label="Steps">
            {STEPS.map((s, i) => (
              <li key={s.id} className="min-w-0 flex-1">
                <div className={clsx("h-1 rounded-full", i <= index ? "bg-accent" : "bg-surface-3")} />
                <div className={clsx("mt-1 truncate text-[11px]", i === index ? "font-semibold text-fg" : i < index ? "text-fg-2" : "text-fg-3")}>
                  {i + 1}. {s.label}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-3 sm:p-4">
          {error ? (
            <Callout tone="bad">
              <span className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-bad" /> {error}
              </span>
            </Callout>
          ) : null}
          {step === "models" ? <ModelsStep /> : null}
          {step === "building" ? <BuildingStep /> : null}
          {step === "assets" ? <AssetsStep /> : null}
          {step === "gaps" ? <GapsStep /> : null}
          {step === "maintenance" ? <MaintenanceStep /> : null}
          {step === "done" ? <DoneStep /> : null}
        </div>
      </div>
      {busy ? (
        <div className="flex items-center gap-2 border-t border-line bg-surface px-4 py-2 text-[12px] text-fg-2">
          <Loader2 size={14} className="animate-spin text-accent" /> {busy}
        </div>
      ) : null}
    </div>
  );
}

function Nav({ back, next, nextLabel = "Continue", canNext = true, onNext }: { back?: Step; next?: Step; nextLabel?: string; canNext?: boolean; onNext?: () => Promise<boolean | void> | boolean | void }) {
  const busy = useOnboard((s) => s.busy);
  const [working, setWorking] = useState(false);
  return (
    <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
      {back ? (
        <Button icon={<ArrowLeft size={14} />} onClick={() => goTo(back)}>
          Back
        </Button>
      ) : (
        <span />
      )}
      {next || onNext ? (
        <Button
          variant="primary"
          disabled={!canNext || Boolean(busy)}
          busy={working}
          onClick={async () => {
            setWorking(true);
            try {
              const ok = onNext ? await onNext() : true;
              if (ok !== false && next) goTo(next);
            } finally {
              setWorking(false);
            }
          }}
        >
          {nextLabel} <ArrowRight size={14} />
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Models

function ModelsStep() {
  const models = useOnboard((s) => s.models);
  const mode = useOnboard((s) => s.mode);
  const parts = useOnboard((s) => s.parts);
  const convertParts = useConvertStore((s) => s.parts);
  const [dragging, setDragging] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const reading = models.some((m) => m.status === "reading");
  const ready = mode === "convert" ? parts.length > 0 : models.some((m) => m.status === "ready");

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const { files: dropped, folder: dir } = await entriesFromDrop(e.dataTransfer);
    if (dir) await addModelFiles([], dir.entries);
    else if (dropped.length) await addModelFiles(dropped);
  };

  return (
    <>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={clsx("flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-center", dragging ? "border-accent bg-accent-soft" : "border-line-strong bg-surface")}
      >
        <Upload size={26} className="text-accent" />
        <div>
          <div className="text-[14px] font-semibold text-fg">Drop the building&apos;s models here</div>
          <p className="mx-auto mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-fg-2">
            IFC files (also .ifczip and zipped folders), one per discipline or federated, and model extracts made on the Convert page. Architecture brings the rooms; mechanical, electrical, plumbing and fire bring the equipment. Files are read on this computer and never uploaded.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" icon={<FileInput size={14} />} onClick={() => files.current?.click()}>
            Choose files
          </Button>
          <Button icon={<FolderOpen size={14} />} onClick={() => folder.current?.click()}>
            Choose a folder
          </Button>
        </div>
        <input
          ref={files}
          type="file"
          multiple
          accept=".ifc,.ifczip,.zip,.eapk,.gz,.bin,.json"
          className="hidden"
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (list.length) void addModelFiles(list);
          }}
        />
        <input
          ref={folder}
          type="file"
          multiple
          className="hidden"
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            const list = e.target.files;
            if (list?.length) void addModelFiles([], entriesFromPicker(list).entries);
            e.target.value = "";
          }}
        />
      </div>

      {convertParts.length && mode !== "convert" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
          <Box size={16} className="text-accent" />
          <span className="min-w-0 flex-1 text-[12.5px] text-fg">
            The Convert page has {plural(convertParts.length, "model part")} loaded (Revit, Navisworks or viewer extracts).
          </span>
          <Button size="sm" onClick={takeConvertPageModels}>
            Use those instead
          </Button>
        </div>
      ) : null}
      <p className="text-[12px] leading-relaxed text-fg-3">
        Revit (.rvt) or Navisworks (.nwd) files? Read them on the <Link href="/convert" className="text-accent hover:underline">Convert page</Link> first (through Autodesk&apos;s cloud, the in-browser Revit reader or an Autodesk Viewer link), then come back and use them here.
      </p>

      {mode === "convert" ? (
        <Panel title="Models from the Convert page" aside={<Button size="sm" variant="ghost" onClick={() => useOnboard.setState({ mode: "files", parts: [], summary: null, workspace: null })}>Read files here instead</Button>}>
          <ul className="flex flex-col gap-1.5">
            {parts.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-[12.5px]">
                <CheckCircle2 size={14} className="text-ok" />
                <span className="min-w-0 flex-1 truncate text-fg">{p.name}</span>
                <span className="text-fg-3">{plural(p.elements, "element")}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : models.length ? (
        <Panel title="Models" bodyClassName="p-0">
          <ul className="divide-y divide-line">
            {models.map((m) => (
              <li key={m.id} className="flex flex-col gap-1.5 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  {m.status === "ready" ? <CheckCircle2 size={15} className="shrink-0 text-ok" /> : m.status === "failed" ? <AlertTriangle size={15} className="shrink-0 text-bad" /> : <Loader2 size={15} className="shrink-0 animate-spin text-accent" />}
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{m.name}</span>
                  <span className="text-[11.5px] text-fg-3">{formatBytes(m.size)}</span>
                  {m.status !== "reading" ? (
                    <button type="button" aria-label={`Remove ${m.name}`} onClick={() => void removeModel(m.id)} className="rounded p-1 text-fg-3 hover:bg-bad-soft hover:text-bad">
                      <Trash2 size={13} />
                    </button>
                  ) : null}
                </div>
                {m.status === "reading" ? (
                  <div className="flex flex-col gap-1 pl-6">
                    <span className="text-[11.5px] text-fg-3">{m.phase ?? "Reading"}</span>
                    <ProgressBar value={m.progress} />
                  </div>
                ) : null}
                {m.status === "failed" ? <p className="pl-6 text-[12px] text-bad">{m.error}</p> : null}
                {m.info ? (
                  <p className="pl-6 text-[12px] text-fg-2">
                    {m.info.schema} · {plural(m.info.counts.detailed, "equipment item")} and {compact(m.info.counts.elements - m.info.counts.detailed)} other elements · {plural(m.info.counts.spaces, "room")} · {plural(m.info.storeys.length, "storey")}
                    {m.info.counts.systems ? ` · ${plural(m.info.counts.systems, "system")}` : ""} · read in {m.info.seconds} s
                    {m.info.counts.runs ? <span className="text-fg-3"> · {compact(m.info.counts.runs)} pipe, duct and cable runs left out</span> : null}
                  </p>
                ) : m.status === "ready" ? (
                  <p className="pl-6 text-[12px] text-fg-2">Model extract read.</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <Nav next="building" canNext={ready && !reading} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 2. Building

function BuildingStep() {
  const f = useOnboard((s) => s.facility);
  const storeys = useOnboard((s) => s.storeys);
  const mode = useOnboard((s) => s.mode);
  const user = useFm((s) => s.facility?.user ?? "");
  const set = (patch: Partial<typeof f>) => useOnboard.setState((s) => ({ facility: { ...s.facility, ...patch }, edited: true, summary: null, workspace: null }));
  useEffect(() => {
    if (!f.user && user) useOnboard.setState((s) => ({ facility: { ...s.facility, user } }));
  }, [f.user, user]);

  return (
    <>
      <Panel title="The building">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormRow label="Building name" hint="As the people who run it call it.">
            <input className={inputCls} value={f.name} onChange={(e) => set({ name: e.target.value })} autoFocus />
          </FormRow>
          <FormRow label="Site or campus">
            <input className={inputCls} value={f.site} onChange={(e) => set({ site: e.target.value })} />
          </FormRow>
          <FormRow label="Address" className="sm:col-span-2">
            <input className={inputCls} value={f.address} onChange={(e) => set({ address: e.target.value })} />
          </FormRow>
          <FormRow label="Site code" hint={`Blank: ${initials(f.site) || "none"}`}>
            <input className={inputCls} value={f.siteCode} onChange={(e) => set({ siteCode: e.target.value.toUpperCase() })} placeholder={initials(f.site)} />
          </FormRow>
          <FormRow label="Building code" hint={`Blank: ${initials(f.name) || "none"}`}>
            <input className={inputCls} value={f.buildingCode} onChange={(e) => set({ buildingCode: e.target.value.toUpperCase() })} placeholder={initials(f.name)} />
          </FormRow>
          <FormRow label="Asset code pattern" hint="{site} {building} {floor} {room} {kind} {discipline} {system} {tag} {type} {seq} {seq4}" className="sm:col-span-2">
            <input className={clsx(inputCls, "font-mono")} value={f.pattern} onChange={(e) => set({ pattern: e.target.value })} />
          </FormRow>
          <FormRow label="Currency" hint="For replacement costs.">
            <input className={inputCls} value={f.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} placeholder="AED, GBP, EUR, USD…" />
          </FormRow>
          <FormRow label="Your name" hint="Recorded with the changes made on this device.">
            <input className={inputCls} value={f.user} onChange={(e) => set({ user: e.target.value })} />
          </FormRow>
        </div>
      </Panel>
      {mode === "files" && storeys.length ? (
        <Panel title={`Floors (${storeys.length})`}>
          <p className="mb-2 text-[12px] text-fg-3">From the models&apos; storeys; storeys of different models at the same height or with the same name are one floor.</p>
          <ul className="grid gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-2 lg:grid-cols-3">
            {[...storeys].reverse().map((s) => (
              <li key={s.key} className="flex items-baseline gap-2">
                <span className="tabular w-16 shrink-0 text-right text-fg-3">{s.elevation.toFixed(2)} m</span>
                <span className="min-w-0 truncate text-fg" title={s.levels.join(", ")}>
                  {s.name}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <Nav back="models" next="assets" canNext={Boolean(f.name.trim())} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 3. Assets

const KEY_COVERAGE = ["manufacturer", "model", "serialNumber", "installationDate", "warrantyDurationParts", "expectedLife", "space", "systemName"];

function AssetsStep() {
  const summary = useOnboard((s) => s.summary);
  const summaryBusy = useOnboard((s) => s.summaryBusy);
  const categories = useOnboard((s) => s.categories);
  const facility = useOnboard((s) => s.facility);
  const busy = useOnboard((s) => s.busy);
  const key = JSON.stringify([categories, facility.siteCode, facility.buildingCode, facility.pattern, facility.name, facility.site]);
  useEffect(() => {
    const t = setTimeout(() => void refreshSummary(), summary ? 400 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const chosen = new Set(categories);
  const setCategories = (list: string[]) => useOnboard.setState({ categories: list, workspace: null });
  // Rooms are rooms whatever is chosen; the list is of what can be an asset.
  const present = (summary?.categories ?? []).filter((c) => !SPACE_CATEGORIES.has(c.name));

  if (!summary)
    return (
      <div className="flex items-center gap-2 py-10 text-[12.5px] text-fg-3">
        <Loader2 size={15} className="animate-spin" /> {busy ?? "Building the asset register…"}
      </div>
    );
  const s = summary.stats;
  const coverage = KEY_COVERAGE.map((id) => summary.sources.find((x) => x.field === id)).filter((x): x is NonNullable<typeof x> => Boolean(x));

  return (
    <>
      <div className={clsx("grid grid-cols-2 gap-3 lg:grid-cols-4", summaryBusy && "opacity-60")}>
        <StatTile label="Assets" icon={Package} value={compact(s.assets)} sub={`of ${compact(s.elements)} elements read`} />
        <StatTile label="Types" value={compact(s.types)} sub="Same make and model" />
        <StatTile label="Rooms" value={compact(s.spaces)} sub={`${s.spacesFromModel} from the models`} />
        <StatTile label="In a known room" value={s.assets ? `${Math.round((s.withSpace / s.assets) * 100)}%` : "–"} sub={s.spaceByGeometry ? `${compact(s.spaceByGeometry)} placed by room shapes` : `${compact(s.withSpace)} assets`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(280px,1fr)_1.4fr]">
        <Panel
          title="Which elements are assets"
          aside={
            <span className="flex gap-2 text-[11.5px]">
              <button type="button" className="text-accent hover:underline" onClick={() => setCategories([...DEFAULT_ASSET_CATEGORIES])}>
                Defaults
              </button>
              <button type="button" className="text-accent hover:underline" onClick={() => setCategories(present.map((c) => c.name))}>
                All
              </button>
            </span>
          }
          bodyClassName="p-0"
        >
          <ul className="scroll-thin max-h-[420px] divide-y divide-line overflow-y-auto">
            {present.map((c) => (
              <li key={c.name}>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-[var(--accent)]"
                    checked={chosen.has(c.name)}
                    onChange={(e) => setCategories(e.target.checked ? [...categories, c.name] : categories.filter((x) => x !== c.name))}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{c.name}</span>
                  <span className="tabular text-[12px] text-fg-3">{c.count.toLocaleString()}</span>
                </label>
              </li>
            ))}
          </ul>
        </Panel>
        <div className="flex flex-col gap-4">
          <Panel title="What the models say about the assets">
            <MeterList rows={coverage.map((c) => ({ key: c.field, label: c.label, value: c.filled, total: c.total }))} />
            <p className="mt-3 text-[11.5px] text-fg-3">Gaps are filled per type in the next step, and later on the asset pages and in the field app.</p>
          </Panel>
          <Panel title="Asset codes">
            <div className="flex flex-wrap gap-1.5">
              {summary.codes.map((c) => (
                <span key={c} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-fg">
                  {c}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11.5px] text-fg-3">From the pattern on the Building step.</p>
          </Panel>
          {summary.issueCount ? (
            <Panel title={`Things to check (${summary.issueCount})`}>
              <ul className="flex flex-col gap-1 text-[12px] text-fg-2">
                {summary.issues.slice(0, 6).map((i, n) => (
                  <li key={n}>· {i.message}</li>
                ))}
              </ul>
              <p className="mt-2 text-[11.5px] text-fg-3">All of them are listed in the asset register workbook at the end.</p>
            </Panel>
          ) : null}
        </div>
      </div>
      <Nav back="building" next="gaps" canNext={s.assets > 0 && !summaryBusy} onNext={async () => Boolean(await buildWorkspace())} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 4. Gaps by type

function GapsStep() {
  const ws = useOnboard((s) => s.workspace);
  const typeValues = useOnboard((s) => s.typeValues);
  const [all, setAll] = useState(false);
  const [text, setText] = useState("");
  const rows = useMemo(() => (ws ? typeRows(ws.assets) : []), [ws]);
  if (!ws) return <Nav back="assets" />;
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter((r) => (all || r.gaps > 0) && words.every((w) => `${r.name} ${r.kind}`.toLowerCase().includes(w)));
  const withGaps = rows.filter((r) => r.gaps > 0).length;
  const typed = Object.values(typeValues).reduce((n, v) => n + Object.values(v).filter((x) => x.trim()).length, 0);
  const setValue = (type: string, field: string, value: string) => useOnboard.setState((s) => ({ typeValues: { ...s.typeValues, [type]: { ...s.typeValues[type], [field]: value } } }));

  return (
    <>
      <Callout>
        Assets of one type share their make, model, life and warranty, so these are filled once per type here: {plural(rows.length, "type")}, {withGaps} with something missing. What you type is recorded as the team&apos;s information next to the model&apos;s, which stays as it was. Leave anything you do not know; it can be filled later.
      </Callout>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-fg-3" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Find a type or kind" className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none focus-ring-none placeholder:text-fg-3" aria-label="Find a type" />
        </label>
        <Toggle checked={all} onChange={setAll} label="Show complete types too" />
        <span className="text-[12px] text-fg-3">{typed ? `${plural(typed, "value")} typed` : ""}</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[880px] text-[12.5px]">
          <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-fg-3">
            <tr>
              <th className="px-3 py-1.5 font-semibold">Type</th>
              <th className="px-2 py-1.5 text-right font-semibold">Assets</th>
              {TYPE_GAP_FIELDS.map((f) => (
                <th key={f} className="px-2 py-1.5 font-semibold">
                  {fieldLabel(f)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.slice(0, 300).map((r) => (
              <tr key={r.name}>
                <td className="max-w-[280px] px-3 py-1.5">
                  <div className="truncate text-fg" title={r.name}>
                    {r.name}
                  </div>
                  <div className="truncate text-[11px] text-fg-3">{r.kind}</div>
                </td>
                <td className="tabular px-2 py-1.5 text-right text-fg-2">{r.count.toLocaleString()}</td>
                {TYPE_GAP_FIELDS.map((f) => {
                  const model = r.values[f];
                  const full = r.complete[f];
                  return (
                    <td key={f} className="px-2 py-1">
                      {full ? (
                        <span className="flex items-center gap-1 text-fg-2" title="From the model">
                          <Check size={12} className="shrink-0 text-ok" />
                          <span className="truncate">{model}</span>
                        </span>
                      ) : (
                        <input
                          className="h-7 w-full min-w-[120px] rounded border border-line-strong bg-surface px-1.5 text-[12.5px] text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none"
                          value={typeValues[r.name]?.[f] ?? ""}
                          placeholder={model ? `Some: ${model}` : f === "expectedLife" || f === "warrantyDurationParts" ? "e.g. 15 years" : ""}
                          title={model ? `Some assets of this type have ${model}; what you type goes on the others` : undefined}
                          onChange={(e) => setValue(r.name, f, e.target.value)}
                          aria-label={`${fieldLabel(f)} of ${r.name}`}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? <p className="px-3 py-6 text-center text-[12.5px] text-fg-3">{withGaps ? "No type matches." : "Every type has its make, model, life and warranty from the models."}</p> : null}
        {shown.length > 300 ? <p className="border-t border-line px-3 py-2 text-[12px] text-fg-3">The 300 types with the most assets are shown; find others by name.</p> : null}
      </div>
      <Nav back="assets" next="maintenance" />
    </>
  );
}

// ---------------------------------------------------------------------------
// 5. Maintenance

function MaintenanceStep() {
  const ws = useOnboard((s) => s.workspace);
  const plan = useOnboard((s) => s.plan);
  const rows = useMemo(() => (ws ? kindRows(ws.assets, DEFAULT_TASKS) : []), [ws]);
  const covered = useMemo(() => rows.filter((r) => r.tasks.length), [rows]);
  const kinds = useMemo(() => new Set(plan.kinds ?? covered.map((r) => r.code)), [plan.kinds, covered]);
  const count = useMemo(() => (ws && !plan.skip ? generatePlans(ws.assets, DEFAULT_TASKS, [], { start: plan.start, kinds, spread: plan.spread, fromModel: plan.fromModel }).length : 0), [ws, plan.skip, plan.start, plan.spread, plan.fromModel, kinds]);
  const setPlan = (patch: Partial<typeof plan>) => useOnboard.setState((s) => ({ plan: { ...s.plan, ...patch } }));
  if (!ws) return <Nav back="gaps" />;
  return (
    <>
      <Callout tone="warn">{TASK_LIBRARY_NOTE}</Callout>
      <Toggle checked={plan.skip} onChange={(v) => setPlan({ skip: v })} label="Plan maintenance later" hint="The Maintenance page plans it from the task library at any time." />
      {!plan.skip ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormRow label="First day tasks can fall due">
              <input type="date" className={inputCls} value={plan.start} onChange={(e) => setPlan({ start: e.target.value || plan.start })} />
            </FormRow>
            <Toggle checked={plan.spread} onChange={(v) => setPlan({ spread: v })} label="Spread the first due dates" hint="Over each task's first interval, so work is even." />
            <Toggle checked={plan.fromModel} onChange={(v) => setPlan({ fromModel: v })} label="Add the models' own maintenance tasks" hint="Where assets carry a PPM task and frequency." />
          </div>
          <Panel title={`Asset kinds with tasks in the library (${covered.length} of ${rows.length})`} bodyClassName="p-0">
            <ul className="scroll-thin max-h-[380px] divide-y divide-line overflow-y-auto">
              {covered.map((r) => (
                <li key={r.code}>
                  <label className="flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-surface-2">
                    <input
                      type="checkbox"
                      className="mt-[3px] size-3.5 accent-[var(--accent)]"
                      checked={kinds.has(r.code)}
                      onChange={(e) => {
                        const next = new Set(kinds);
                        if (e.target.checked) next.add(r.code);
                        else next.delete(r.code);
                        setPlan({ kinds: [...next] });
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] text-fg">
                        {r.name} <span className="text-fg-3">· {plural(r.assets, "asset")}</span>
                      </span>
                      <span className="block truncate text-[11.5px] text-fg-3">{r.tasks.map((t) => `${t.title} (${intervalText(t.every, t.unit).toLowerCase()})`).join("; ")}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      ) : null}
      <Nav back="gaps" next="done" nextLabel={plan.skip ? "Continue" : `Plan ${plural(count, "task")}`} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 6. Create

function DoneStep() {
  const ws = useOnboard((s) => s.workspace);
  const created = useOnboard((s) => s.created);
  const facilityDraft = useOnboard((s) => s.facility);
  const plan = useOnboard((s) => s.plan);
  const typeValues = useOnboard((s) => s.typeValues);
  const current = useFm((s) => s.facility);
  const plans = useFm((s) => s.plans.length);
  const [downloading, setDownloading] = useState(false);
  const typed = Object.values(typeValues).reduce((n, v) => n + Object.values(v).filter((x) => x.trim()).length, 0);
  if (!ws) return <Nav back="maintenance" />;

  const downloads = async () => {
    setDownloading(true);
    try {
      const files = await handoverFiles();
      if (!files) return;
      const stem = fileStem(facilityDraft.name || "building");
      downloadBlob(files.cobie, `${stem}-COBie.xlsx`);
      downloadBlob(files.workbook, `${stem}-asset-register.xlsx`);
      downloadBlob(files.sld, `${stem}-single-line-diagrams.html`);
    } finally {
      setDownloading(false);
    }
  };

  if (created)
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-xl border border-ok/30 bg-ok-soft p-4">
          <CheckCircle2 size={22} className="mt-0.5 shrink-0 text-ok" />
          <div>
            <h2 className="text-[15px] font-semibold text-fg">{current?.name ?? facilityDraft.name} is ready</h2>
            <p className="mt-0.5 text-[12.5px] text-fg-2">
              {plural(ws.assets.length, "asset")}, {plural(ws.spaces.length, "room")} and {plural(ws.systems.length, "system")}
              {plans ? `, with ${plural(plans, "maintenance task")} planned` : ""}. It is kept in this browser; export it from Settings to back it up or share it.
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NextCard href="/" icon={Building2} title="Home" text="The building at a glance." />
          <NextCard href="/assets?q=status:incomplete" icon={Package} title="Assets missing information" text="Fill the gaps that are left." />
          <NextCard href="/labels" icon={QrCode} title="Print labels" text="QR labels to put on the equipment." />
          <NextCard href="/maintenance" icon={Wrench} title="Maintenance" text="What is due, and work orders." />
        </div>
        <Panel title="For the CAFM system and the handover file">
          <p className="mb-3 text-[12.5px] leading-relaxed text-fg-2">COBie 2.4, the asset register workbook (with rooms, systems, the electrical tree and the things to check) and the single-line diagrams, from the same register.</p>
          <Button icon={<Download size={14} />} busy={downloading} onClick={downloads}>
            Download COBie, register and diagrams
          </Button>
        </Panel>
        <button type="button" onClick={resetOnboarding} className="self-start text-[12px] text-fg-3 hover:text-fg">
          Onboard another building
        </button>
      </div>
    );

  const plannedCount = plan.skip ? 0 : null;
  return (
    <>
      <Panel title="Ready to create">
        <dl className="grid grid-cols-[minmax(140px,max-content)_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
          <dt className="text-fg-3">Building</dt>
          <dd className="text-fg">
            {facilityDraft.name}
            {facilityDraft.site ? ` · ${facilityDraft.site}` : ""}
          </dd>
          <dt className="text-fg-3">Assets</dt>
          <dd className="text-fg">{ws.assets.length.toLocaleString()}</dd>
          <dt className="text-fg-3">Rooms and floors</dt>
          <dd className="text-fg">
            {plural(ws.spaces.length, "room")} on {plural(ws.floors.length, "floor")}
          </dd>
          <dt className="text-fg-3">Systems</dt>
          <dd className="text-fg">{ws.systems.length.toLocaleString()}</dd>
          <dt className="text-fg-3">Filled per type</dt>
          <dd className="text-fg">{typed ? plural(typed, "value") : "Nothing"}</dd>
          <dt className="text-fg-3">Maintenance</dt>
          <dd className="text-fg">{plannedCount === 0 ? "Planned later" : "Planned from the task library"}</dd>
        </dl>
      </Panel>
      {current ? (
        <Callout tone="warn">
          This replaces <b>{current.name}</b> on this device, with everything done in it. <Link href="/settings#workspace" className="text-accent hover:underline">Export it first</Link> if you want to keep it.
        </Callout>
      ) : null}
      <Nav back="maintenance" nextLabel="Create the workspace" onNext={async () => void (await createFromWizard())} />
    </>
  );
}

function NextCard({ href, icon: Icon, title, text }: { href: string; icon: typeof Package; title: string; text: string }) {
  return (
    <Link href={href} className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3 transition-colors hover:border-accent">
      <Icon size={16} className="text-accent" />
      <span className="text-[13px] font-semibold text-fg">{title}</span>
      <span className="text-[12px] text-fg-3">{text}</span>
    </Link>
  );
}
