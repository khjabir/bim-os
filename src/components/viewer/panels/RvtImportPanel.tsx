"use client";

import clsx from "clsx";
import { AlertTriangle, Check, CircleAlert, Cloud, Cpu, Download, FolderOpen, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { RankedBars } from "@/components/charts/RankedBars";
import { Section } from "@/components/ui/Section";
import { Badge, Button, Callout, IconButton, Segmented, Select, Spinner } from "@/components/ui/primitives";
import { ApsSetupNote } from "@/components/ui/ApsSetupNote";
import { getApsStatus } from "@/lib/aps/client";
import { useEngine } from "@/lib/engine/context";
import type { ViewerEngine } from "@/lib/engine/engine";
import { convertAndLoad, openRvtFiles } from "@/lib/rvt/open";
import { IFC_EXPORT_SETUPS, removeConversion, useRvtStore, type RvtConversion, type RvtEngine } from "@/lib/rvt/store";
import { useViewerStore } from "@/lib/store";
import { formatBytes, formatCount, formatDuration, prettyCategory } from "@/lib/utils/format";

const CUSTOM = "__custom";

export function RvtImportPanel() {
  const engine = useEngine();
  const choice = useRvtStore((state) => state.engine);
  const largeModel = useRvtStore((state) => state.largeModel);
  const savedMeshes = useRvtStore((state) => state.savedMeshes);
  const exportSetup = useRvtStore((state) => state.exportSetup);
  const deleteCloudCopy = useRvtStore((state) => state.deleteCloudCopy);
  const aps = useRvtStore((state) => state.aps);
  const conversions = useRvtStore((state) => state.conversions);
  const input = useRef<HTMLInputElement>(null);
  const setupId = useId();
  const [customSetup, setCustomSetup] = useState(() => !(IFC_EXPORT_SETUPS as readonly string[]).includes(exportSetup));

  useEffect(() => {
    void getApsStatus().then((status) => useRvtStore.setState({ aps: status }));
  }, []);

  const cloudReady = aps?.configured === true;
  const canOpen = Boolean(engine) && (choice === "local" || cloudReady);

  return (
    <div className="flex h-full flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-line p-3">
          <Segmented<RvtEngine>
            className="w-full"
            value={choice}
            onChange={(value) => useRvtStore.setState({ engine: value })}
            options={[
              { value: "local", label: "In the browser", title: "Read the file here with the open-source rvt-rs reader" },
              { value: "cloud", label: "Autodesk cloud", title: "Export to IFC with Autodesk Platform Services" },
            ]}
          />

          {choice === "local" ? (
            <div className="mt-2.5">
              <p className="text-[12px] leading-relaxed text-fg-2">
                Reads the file on this computer with the open-source <strong className="font-medium text-fg">rvt-rs</strong> reader. Nothing is uploaded and no account is needed.
              </p>
              <Callout tone="warn" className="mt-2">
                Experimental. rvt-rs is an independent reader, not Autodesk software: it recovers part of a project, many shapes are simplified (some are only bounding boxes), and
                parameters are incomplete. Each file gets a report of what was recovered. Do not measure or coordinate from this view.
              </Callout>
              <div className="mt-2.5 flex flex-col gap-1.5">
                <Toggle checked={savedMeshes} onChange={(value) => useRvtStore.setState({ savedMeshes: value })} label="Use the meshes Revit saved" hint="Better doors, windows and families on Revit 2023 to 2027 files." />
                <Toggle checked={largeModel} onChange={(value) => useRvtStore.setState({ largeModel: value })} label="Large-model limits" hint="Lifts the reader's size limits for very big projects. Uses more memory." />
              </div>
            </div>
          ) : (
            <div className="mt-2.5">
              <p className="text-[12px] leading-relaxed text-fg-2">
                Uploads the file to your Autodesk Platform Services account, where Autodesk&apos;s own Revit engine exports it to IFC. The IFC is then downloaded and opened here.
              </p>
              {aps === null ? (
                <div className="mt-2 flex items-center gap-2 text-[12px] text-fg-3">
                  <Spinner size={13} /> Checking the Autodesk connection
                </div>
              ) : cloudReady ? (
                <div className="mt-2.5 flex flex-col gap-2">
                  <div>
                    <label htmlFor={setupId} className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-fg-3">
                      IFC export setup
                    </label>
                    <Select
                      id={setupId}
                      value={customSetup ? CUSTOM : exportSetup}
                      onChange={(event) => {
                        const value = event.target.value;
                        setCustomSetup(value === CUSTOM);
                        useRvtStore.setState({ exportSetup: value === CUSTOM ? "" : value });
                      }}
                    >
                      {IFC_EXPORT_SETUPS.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                      <option value={CUSTOM}>A setup saved in the project…</option>
                    </Select>
                    {customSetup ? (
                      <input
                        value={exportSetup}
                        onChange={(event) => useRvtStore.setState({ exportSetup: event.target.value })}
                        placeholder="Name of the IFC export setup"
                        aria-label="Name of the IFC export setup saved in the project"
                        className="mt-1.5 h-7 w-full rounded-md border border-line-strong bg-surface px-2 text-[12.5px] text-fg placeholder:text-fg-3"
                      />
                    ) : null}
                  </div>
                  <Toggle
                    checked={deleteCloudCopy}
                    onChange={(value) => useRvtStore.setState({ deleteCloudCopy: value })}
                    label="Delete the cloud copy afterwards"
                    hint="Removes the upload and its export from Autodesk once the IFC is here. Otherwise Autodesk deletes the upload after 24 hours."
                  />
                  <p className="text-[11px] leading-snug text-fg-3">Translations use your APS quota{aps?.region ? ` · region ${aps.region}` : ""}.</p>
                </div>
              ) : (
                <ApsSetupNote onRetry={() => void getApsStatus().then((status) => useRvtStore.setState({ aps: status }))} />
              )}
            </div>
          )}

          <input
            ref={input}
            type="file"
            accept=".rvt,.rfa,.rte"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (engine && files.length > 0) openRvtFiles(engine, files);
            }}
          />
          <Button variant="primary" className="mt-3 w-full" icon={<FolderOpen size={14} />} disabled={!canOpen} onClick={() => input.current?.click()}>
            Open Revit file
          </Button>
          <p className="mt-1.5 text-[11px] leading-snug text-fg-3">.rvt, .rfa, .rte · or drop files onto the 3D view. Once open, select elements or groups and export them as IFC from the selection bar.</p>
        </div>

        {conversions.length === 0 ? (
          <p className="p-3 text-[12px] leading-relaxed text-fg-3">Files you open are listed here with a report of what was read.</p>
        ) : (
          conversions.map((conversion) => <ConversionCard key={conversion.id} conversion={conversion} engine={engine} cloudReady={cloudReady} />)
        )}
      </div>
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-[3px] size-3.5 shrink-0 accent-[var(--accent)]" />
      <span className="min-w-0">
        <span className="block text-[12px] text-fg">{label}</span>
        {hint ? <span className="block text-[11px] leading-snug text-fg-3">{hint}</span> : null}
      </span>
    </label>
  );
}

const SUPPORT_TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = { verified: "ok", partial: "warn", experimental: "warn", unsupported: "bad" };

function humanise(reason: string) {
  const text = reason.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ConversionCard({ conversion, engine, cloudReady }: { conversion: RvtConversion; engine: ViewerEngine | null; cloudReady: boolean }) {
  const loaded = useViewerStore((state) => (conversion.modelId ? state.models.some((model) => model.id === conversion.modelId) : false));
  const busy = useRvtStore((state) => state.conversions.some((entry) => entry.status === "running"));
  const { report } = conversion;
  const phases = conversion.phases ?? [];
  const defaultPhase = phases.length > 0 ? phases[phases.length - 1].id : null;
  const currentPhase = conversion.phase ?? defaultPhase;

  const reread = (overrides: { engine?: RvtEngine; phase?: string | number | null }) => {
    if (!engine || busy) return;
    void convertAndLoad(engine, conversion.file, { ...overrides, replaceModelId: conversion.modelId });
  };

  const selectClass = async (category: string) => {
    const model = engine && conversion.modelId ? engine.getModel(conversion.modelId) : undefined;
    if (!engine || !model) return;
    const found = await model.getItemsOfCategories([new RegExp(`^${category}(STANDARDCASE|ELEMENTEDCASE)?$`)]);
    const ids = Object.values(found).flat();
    if (ids.length > 0) await engine.select({ [model.modelId]: ids }, { zoom: true });
  };

  return (
    <article className="border-b border-line">
      <header className="flex items-start gap-2 px-3 pt-2.5">
        <div className="mt-0.5 shrink-0">
          {conversion.status === "running" ? (
            <Spinner size={14} />
          ) : conversion.status === "done" ? (
            <Check size={14} className="text-ok" />
          ) : conversion.status === "cancelled" ? (
            <X size={14} className="text-fg-3" />
          ) : (
            <CircleAlert size={14} className="text-bad" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="break-words text-[12.5px] font-medium text-fg">{conversion.fileName}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-fg-3">
            <span className="inline-flex items-center gap-1">
              {conversion.engine === "local" ? <Cpu size={11} /> : <Cloud size={11} />}
              {conversion.engine === "local" ? "In the browser" : "Autodesk cloud"}
            </span>
            <span>{formatBytes(conversion.fileBytes)}</span>
            {conversion.elapsedMs !== undefined && conversion.status !== "running" ? <span>{formatDuration(conversion.elapsedMs)}</span> : null}
          </div>
        </div>
        {conversion.status !== "running" ? (
          <IconButton label="Remove from this list" size="sm" onClick={() => removeConversion(conversion.id)}>
            <X size={13} />
          </IconButton>
        ) : null}
      </header>

      <div className="px-3 pb-2.5 pt-1.5">
        {conversion.status === "running" ? <p className="text-[12px] text-fg-2">{conversion.step ?? "Working"}</p> : null}
        {conversion.status === "cancelled" ? <p className="text-[12px] text-fg-3">Cancelled.</p> : null}
        {conversion.status === "failed" ? (
          <Callout tone="bad">
            <div className="break-words">{conversion.error}</div>
            {conversion.outOfMemory ? <div className="mt-1 text-fg-2">The file needs more memory than a browser tab can give the reader.</div> : null}
            {conversion.engine === "local" ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {cloudReady ? (
                  <Button size="sm" icon={<Cloud size={12} />} disabled={busy} onClick={() => reread({ engine: "cloud" })}>
                    Try Autodesk cloud
                  </Button>
                ) : (
                  <span className="text-fg-2">The Autodesk cloud engine reads every Revit file; it needs APS credentials.</span>
                )}
              </div>
            ) : null}
          </Callout>
        ) : null}

        {conversion.status === "done" && conversion.engine === "cloud" ? (
          <div className="text-[12px] leading-relaxed text-fg-2">
            Exported by Autodesk{conversion.exportSetup ? ` with “${conversion.exportSetup}”` : ""}
            {conversion.ifcBytes ? ` · ${formatBytes(conversion.ifcBytes)} of IFC` : ""}.
            {conversion.cloudMessages && conversion.cloudMessages.length > 0 ? (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11.5px] text-fg-3">
                {conversion.cloudMessages.map((message, index) => (
                  <li key={index} className="break-words">
                    {message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {report ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-fg-3">Revit release</dt>
            <dd className="flex flex-wrap items-center gap-1.5 text-fg">
              {report.release ?? "Unknown"}
              {report.releaseSupport ? (
                <Badge tone={SUPPORT_TONE[report.releaseSupport] ?? "neutral"}>
                  {report.releaseSupport === "verified" ? "Verified" : report.releaseSupport === "partial" ? "Partial support" : report.releaseSupport === "experimental" ? "Experimental" : "Unsupported"}
                </Badge>
              ) : null}
            </dd>
            <dt className="text-fg-3">Elements</dt>
            <dd className="tabular text-fg">
              {formatCount(report.elements)} exported
              <span className="text-fg-3"> · {formatCount(report.withGeometry)} with geometry</span>
            </dd>
            {report.boundingBoxBodies > 0 ? (
              <>
                <dt className="text-fg-3">Simplified</dt>
                <dd className="flex items-start gap-1.5 text-fg">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" />
                  <span>
                    <span className="tabular">{formatCount(report.boundingBoxBodies)}</span> drawn as bounding boxes only
                  </span>
                </dd>
              </>
            ) : null}
            <dt className="text-fg-3">Storeys</dt>
            <dd className="tabular text-fg">{report.storeys.length}</dd>
            {report.coverage?.exported !== null && report.coverage?.exported !== undefined ? (
              <>
                <dt className="text-fg-3">Coverage</dt>
                <dd className="text-fg">
                  <span className="tabular">{Math.round(report.coverage.exported * 100)}%</span>
                  <span className="text-fg-3"> of the file&apos;s element records exported</span>
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {conversion.status === "done" && phases.length > 1 && conversion.engine === "local" ? (
          <div className="mt-2 flex items-center gap-2">
            <span className="shrink-0 text-[11.5px] text-fg-3">Phase</span>
            <Select
              aria-label="Project phase to read"
              value={String(currentPhase ?? "")}
              disabled={busy}
              onChange={(event) => reread({ phase: Number(event.target.value) })}
              className="h-6 text-[12px]"
            >
              {phases.map((phase) => (
                <option key={phase.id} value={phase.id}>
                  {phase.name || `Phase ${phase.id}`}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        {conversion.status === "done" ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" icon={<Download size={12} />} disabled={!loaded || !engine} onClick={() => conversion.modelId && engine?.downloadSourceIfc(conversion.modelId)} title="Download the whole converted model as IFC">
              Full IFC
            </Button>
            {conversion.engine === "local" && cloudReady ? (
              <Button size="sm" icon={<Cloud size={12} />} disabled={busy} onClick={() => reread({ engine: "cloud" })} title="Convert the same file with Autodesk for exact geometry">
                Autodesk cloud
              </Button>
            ) : null}
            {!loaded ? <span className="self-center text-[11.5px] text-fg-3">Model closed</span> : null}
          </div>
        ) : null}
      </div>

      {report && Object.keys(report.byIfcType).length > 0 ? (
        <div className="border-t border-line">
          <RankedBars
            title="Exported elements by class"
            unit="elements"
            data={Object.entries(report.byIfcType).map(([category, count]) => ({ key: category, label: prettyCategory(category), value: count }))}
            format={formatCount}
            maxRows={8}
            onPick={loaded ? (datum) => void selectClass(datum.key) : undefined}
          />
        </div>
      ) : null}

      {report && report.skipped.length > 0 ? (
        <Section title="Left out" count={formatCount(report.skipped.reduce((sum, item) => sum + item.count, 0))} defaultOpen={false} className="border-b-0 border-t">
          <ul className="flex flex-col gap-1.5 px-3">
            {report.skipped.map((item) => (
              <li key={`${item.reason}-${item.phase ?? ""}`} className="text-[12px]">
                <div className="flex justify-between gap-2 text-fg">
                  <span className="min-w-0 break-words">{humanise(item.reason)}</span>
                  <span className="tabular shrink-0 text-fg-2">{formatCount(item.count)}</span>
                </div>
                {item.samples.length > 0 ? <div className="mt-0.5 break-words text-[11px] leading-snug text-fg-3">{item.samples.slice(0, 4).join(" · ")}</div> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {report && report.warnings.length > 0 ? (
        <Section title="Reader notes" count={report.warnings.length} defaultOpen={false} className={clsx("border-b-0 border-t")}>
          <ul className="flex list-disc flex-col gap-1 pl-7 pr-3 text-[11.5px] leading-snug text-fg-2 marker:text-fg-3">
            {report.warnings.map((warning, index) => (
              <li key={index} className="break-words">
                {warning}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </article>
  );
}
