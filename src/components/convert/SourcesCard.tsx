"use client";

import clsx from "clsx";
import { Box, Check, CloudUpload, FileArchive, FileImage, FileText, FolderOpen, Layers3, Play, RotateCcw, Trash2, X } from "lucide-react";
import { useRef } from "react";
import { ApsSetupNote } from "@/components/ui/ApsSetupNote";
import { Badge, Button, Callout, IconButton, ProgressBar, Select, Spinner } from "@/components/ui/primitives";
import { cancelSource, processSource, refreshApsStatus, registerLmvHost, removeSource, setSourceMethod } from "@/lib/convert/actions";
import { DISCIPLINES } from "@/lib/convert/disciplines";
import { PLAN_ACCEPT } from "@/lib/convert/plans/source";
import { updateSettings, updateSource, useConvertStore, type SourceItem, type SourceMethod } from "@/lib/convert/store";
import { IFC_EXPORT_SETUPS } from "@/lib/rvt/store";
import { downloadBlob } from "@/lib/utils/download";
import { formatBytes, formatCount } from "@/lib/utils/format";
import { Card, Toggle } from "./parts";

export const SOURCE_ACCEPT = `.rvt,.rfa,.nwd,.nwc,.eapk,.gz,.bin,.json,.ifc,.ifczip,${PLAN_ACCEPT}`;

const METHODS: Record<"rvt" | "nwd", { value: SourceMethod; label: string; needsAps: boolean; hint: string }[]> = {
  rvt: [
    { value: "aps-extract", label: "Autodesk cloud, then convert here", needsAps: true, hint: "Autodesk translates the model for its viewer; IFC Studio reads geometry and properties from it and writes the IFC with the other sources (disciplines, storeys, federated file)." },
    { value: "aps-ifc", label: "Revit's own IFC exporter (cloud)", needsAps: true, hint: "Autodesk runs Revit's IFC export. The IFC is kept as Revit writes it and listed next to the generated files; it is not merged into the federated file." },
    { value: "local", label: "In the browser (rvt-rs, partial)", needsAps: false, hint: "No upload. An independent reader recovers part of the project; many shapes are simplified. The IFC is kept as it comes out." },
  ],
  nwd: [
    { value: "aps-extract", label: "Autodesk cloud, then convert here", needsAps: true, hint: "Autodesk translates the Navisworks file for its viewer; IFC Studio reads every source file in it." },
    { value: "link", label: "From an Autodesk Viewer link instead", needsAps: false, hint: "Upload the file to viewer.autodesk.com (or open it in ACC), then use the viewer link below. Nothing is uploaded from here." },
  ],
};

function KindIcon({ kind }: { kind: SourceItem["kind"] }) {
  const cls = "shrink-0 text-fg-3";
  if (kind === "rvt") return <Box size={15} className={cls} />;
  if (kind === "nwd") return <Layers3 size={15} className={cls} />;
  if (kind === "extract") return <FileArchive size={15} className={cls} />;
  if (kind === "plan") return <FileImage size={15} className={cls} />;
  return <FileText size={15} className={cls} />;
}

const KIND_LABEL: Record<SourceItem["kind"], string> = { rvt: "Revit", nwd: "Navisworks", extract: "Viewer extract", ifc: "IFC", plan: "Floor plan" };

export function SourcesCard({ onAdd }: { onAdd: (files: File[]) => void }) {
  const sources = useConvertStore((s) => s.sources);
  const aps = useConvertStore((s) => s.aps);
  const busy = useConvertStore((s) => s.busy);
  const deleteFromAps = useConvertStore((s) => s.settings.deleteFromAps);
  const input = useRef<HTMLInputElement>(null);
  const needsAps = sources.some((s) => (s.kind === "rvt" || s.kind === "nwd") && (s.method === "aps-extract" || s.method === "aps-ifc"));

  return (
    <Card
      step={1}
      title="Sources"
      aside={
        <Button size="sm" variant="primary" icon={<FolderOpen size={13} />} onClick={() => input.current?.click()}>
          Add files
        </Button>
      }
    >
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={SOURCE_ACCEPT}
        data-testid="convert-file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) onAdd(files);
        }}
      />
      {sources.length === 0 ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="flex w-full flex-col items-center gap-1.5 rounded-md border border-dashed border-line-strong px-4 py-6 text-center hover:bg-surface-2"
        >
          <CloudUpload size={22} className="text-fg-3" />
          <span className="text-[12.5px] font-medium text-fg">Drop files here, or click to choose</span>
          <span className="max-w-[46ch] text-[11.5px] leading-relaxed text-fg-3">
            Revit (.rvt) and Navisworks (.nwd, .nwc) models, extracts from an Autodesk Viewer link (.eapk), and floor plans as PDF or images (.png, .jpg). Use whatever you have; a model, plans, or both.
          </span>
        </button>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="convert-sources">
          {sources.map((source) => (
            <SourceRow key={source.id} source={source} apsReady={Boolean(aps?.configured)} />
          ))}
        </ul>
      )}
      {busy ? (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-fg-3">
          <Spinner size={13} /> {busy}
        </div>
      ) : null}
      {needsAps && aps && !aps.configured ? (
        <div className="mt-2">
          <ApsSetupNote onRetry={() => void refreshApsStatus()} />
        </div>
      ) : null}
      {needsAps && aps?.configured ? (
        <div className="mt-2.5">
          <Toggle
            checked={deleteFromAps}
            onChange={(value) => updateSettings({ deleteFromAps: value })}
            label="Delete the uploads from Autodesk afterwards"
            hint={`Removes each upload and its translation once it has been read. Otherwise Autodesk deletes uploads after 24 hours. Translations use your APS quota${aps.region ? ` · region ${aps.region}` : ""}.`}
          />
        </div>
      ) : null}
    </Card>
  );
}

function SourceRow({ source, apsReady }: { source: SourceItem; apsReady: boolean }) {
  const parts = useConvertStore((s) => s.parts);
  const methods = source.kind === "rvt" || source.kind === "nwd" ? METHODS[source.kind] : null;
  const method = methods?.find((m) => m.value === source.method);
  const myParts = parts.filter((p) => source.jobs?.includes(p.job));
  const elements = myParts.reduce((n, p) => n + p.elements, 0);
  const working = source.status === "working";
  const canStart = methods && source.status !== "working" && source.status !== "ready" && method && (!method.needsAps || apsReady) && source.method !== "link";

  return (
    <li className="rounded-md border border-line bg-surface" data-testid="convert-source">
      <div className="flex items-start gap-2 px-2.5 py-2">
        <div className="mt-0.5">{working ? <Spinner size={15} /> : source.status === "ready" ? <Check size={15} className="text-ok" /> : source.status === "failed" ? <X size={15} className="text-bad" /> : <KindIcon kind={source.kind} />}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium text-fg" title={source.name}>
              {source.name}
            </span>
            <Badge className="shrink-0">{KIND_LABEL[source.kind]}</Badge>
          </div>
          <div className="mt-0.5 text-[11.5px] text-fg-3">
            {source.size ? formatBytes(source.size) : null}
            {source.status === "ready" && myParts.length ? ` · ${myParts.length} source file${myParts.length === 1 ? "" : "s"} · ${formatCount(elements)} elements` : null}
            {source.status === "ready" && source.ifc ? ` · ${source.ifc.note}` : null}
            {source.status === "cancelled" ? " · cancelled" : null}
          </div>
        </div>
        {working ? (
          <IconButton label="Cancel" size="sm" onClick={() => cancelSource(source.id)}>
            <X size={14} />
          </IconButton>
        ) : (
          <IconButton label="Remove" size="sm" onClick={() => void removeSource(source.id)}>
            <Trash2 size={13} />
          </IconButton>
        )}
      </div>

      {methods && source.status !== "ready" ? (
        <div className="border-t border-line px-2.5 py-2">
          <div className="flex items-center gap-2">
            <Select aria-label="How to read this file" value={source.method} disabled={working} onChange={(event) => setSourceMethod(source.id, event.target.value as SourceMethod)} className="flex-1">
              {methods.map((m) => (
                <option key={m.value} value={m.value} disabled={m.needsAps && !apsReady}>
                  {m.label}
                  {m.needsAps && !apsReady ? " (needs Autodesk setup)" : ""}
                </option>
              ))}
            </Select>
            {source.status === "failed" || source.status === "cancelled" ? (
              <Button size="md" icon={<RotateCcw size={13} />} disabled={!canStart} onClick={() => void processSource(source.id)}>
                Retry
              </Button>
            ) : (
              <Button size="md" variant="primary" icon={<Play size={13} />} disabled={!canStart} onClick={() => void processSource(source.id)}>
                Start
              </Button>
            )}
          </div>
          {method ? <p className="mt-1.5 text-[11px] leading-snug text-fg-3">{method.hint}</p> : null}
          {source.method === "aps-ifc" ? <ExportSetup disabled={working} /> : null}
        </div>
      ) : null}

      {working ? (
        <div className="border-t border-line px-2.5 py-2">
          <div className="mb-1.5 truncate text-[11.5px] text-fg-2">{source.step ?? "Working"}</div>
          <ProgressBar value={source.progress} />
          {source.method === "aps-extract" ? (
            <div
              ref={(el) => registerLmvHost(source.id, el)}
              className="relative mt-2 h-[240px] overflow-hidden rounded-md border border-line bg-surface-2"
              aria-label="Autodesk viewer reading the model"
            />
          ) : null}
        </div>
      ) : null}

      {source.status === "failed" && source.error ? (
        <div className="border-t border-line px-2.5 py-2">
          <Callout tone="bad">{source.error}</Callout>
        </div>
      ) : null}

      {source.status === "ready" && source.ifc ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-2.5 py-2">
          <label className="flex items-center gap-1.5 text-[12px] text-fg">
            <input type="checkbox" checked={source.ifc.include} onChange={(e) => updateSource(source.id, { ifc: { ...source.ifc!, include: e.target.checked } })} className="size-3.5 accent-[var(--accent)]" />
            Include
          </label>
          <Select aria-label="Discipline" value={source.ifc.discipline} onChange={(e) => updateSource(source.id, { ifc: { ...source.ifc!, discipline: e.target.value } })} className={clsx("w-auto flex-1")}>
            {DISCIPLINES.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </Select>
          <Button size="sm" onClick={() => downloadBlob(source.ifc!.blob, source.ifc!.name)}>
            Download
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function ExportSetup({ disabled }: { disabled: boolean }) {
  const setup = useConvertStore((s) => s.settings.exportSetup);
  const known = (IFC_EXPORT_SETUPS as readonly string[]).includes(setup);
  return (
    <div className="mt-2 flex flex-col gap-1">
      <span className="text-[11px] font-medium text-fg-3">IFC export setup</span>
      <Select aria-label="IFC export setup" value={known ? setup : "custom"} disabled={disabled} onChange={(e) => updateSettings({ exportSetup: e.target.value === "custom" ? "" : e.target.value })}>
        {IFC_EXPORT_SETUPS.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        <option value="custom">A setup saved in the project…</option>
      </Select>
      {!known ? (
        <input
          value={setup}
          disabled={disabled}
          onChange={(e) => updateSettings({ exportSetup: e.target.value })}
          placeholder="Name of the IFC export setup"
          aria-label="Name of the IFC export setup saved in the project"
          className="h-7 w-full rounded-md border border-line-strong bg-surface px-2 text-[12.5px] text-fg placeholder:text-fg-3"
        />
      ) : null}
    </div>
  );
}
