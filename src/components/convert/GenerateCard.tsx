"use client";

import { Box, Download, FileArchive, FolderDown, Play, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Callout, ProgressBar, Segmented } from "@/components/ui/primitives";
import { cancelGeneration, generate, handOffToViewer, passThroughFiles, resultFiles, saveAllToFolder, zipOutput, zipResults } from "@/lib/convert/actions";
import { disciplineLabel } from "@/lib/convert/disciplines";
import { updateSettings, useConvertStore } from "@/lib/convert/store";
import { pushToast } from "@/lib/store";
import { downloadBlob } from "@/lib/utils/download";
import { formatBytes, formatCount, formatDuration } from "@/lib/utils/format";
import { Card, Toggle } from "./parts";

export function GenerateCard() {
  const router = useRouter();
  const settings = useConvertStore((s) => s.settings);
  const generation = useConvertStore((s) => s.generation);
  const outputs = useConvertStore((s) => s.outputs);
  const report = useConvertStore((s) => s.report);
  const parts = useConvertStore((s) => s.parts);
  const partConfig = useConvertStore((s) => s.partConfig);
  const plans = useConvertStore((s) => s.plans);
  const sources = useConvertStore((s) => s.sources);
  const passThrough = sources.filter((s) => s.ifc?.include);
  const includedParts = parts.filter((p) => partConfig[p.id]?.include !== false);
  const readyPlans = plans.filter((p) => p.include && p.calibration && p.calibration.metresPerPixel > 0 && (p.walls.length || (p.withSlab && p.outline.length >= 3) || p.rooms.length || p.columns.length));
  const disciplines = new Set([...includedParts.map((p) => partConfig[p.id]?.discipline ?? p.suggestion.id), ...readyPlans.map((p) => p.discipline)]);
  const elements = includedParts.reduce((n, p) => n + p.elements, 0);
  const running = generation?.running ?? false;
  const canRun = !running && (includedParts.length > 0 || readyPlans.length > 0);
  const hasFederated = outputs.some((o) => o.discipline === null);
  const withTextures = outputs.some((o) => o.assets?.length);
  const [zipping, setZipping] = useState<string | null>(null);

  /** The IFC as That Open Fragments (.frag), converted in a worker. */
  const toFrag = async (name: string, blob: Blob) => {
    setZipping(`frag|${name}`);
    try {
      const { convertIfc } = await import("@/lib/ifc/client");
      const { bytes } = await convertIfc(blob);
      downloadBlob(new Blob([bytes as BlobPart], { type: "application/octet-stream" }), name.replace(/\.ifc$/i, "") + ".frag");
    } catch (error) {
      pushToast("error", `Could not convert ${name} to Fragments: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setZipping(null);
    }
  };

  const zip = async (key: string, make: () => Promise<Blob>, name: string) => {
    setZipping(key);
    try {
      downloadBlob(await make(), name);
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setZipping(null);
    }
  };

  const openInViewer = (which: "disciplines" | "federated" | string) => {
    const n = handOffToViewer(which);
    if (n === 0) return;
    router.push("/ifc");
  };

  const downloadAll = () => {
    // With textures the files only work together: one archive keeps the folder layout.
    if (withTextures) {
      void zip("*", zipResults, `${(settings.filePrefix || settings.projectName || "model").replace(/[\\/:*?"<>|]+/g, "-")}-ifc.zip`);
      return;
    }
    const files = resultFiles();
    files.forEach((f, i) => setTimeout(() => downloadBlob(f.blob, f.path), i * 400));
  };

  return (
    <Card step={4} title="Generate IFC" id="convert-generate">
      <div className="flex flex-col gap-2">
        <Toggle checked={settings.perDiscipline} onChange={(v) => updateSettings({ perDiscipline: v })} label="One IFC per discipline" hint="Architecture, structure, each MEP trade… as assigned above." />
        <Toggle
          checked={settings.federated}
          onChange={(v) => updateSettings({ federated: v })}
          label="A federated IFC with every discipline"
          hint="One file with everything, same element ids as the discipline files. Skipped when there is only one discipline."
        />
        <Toggle checked={settings.instancing} onChange={(v) => updateSettings({ instancing: v })} label="Share repeated shapes" hint="Seats, fittings, fixtures and panels are written once and placed many times: much smaller files." />
        <Toggle
          checked={settings.twoSidedOpen}
          onChange={(v) => updateSettings({ twoSidedOpen: v })}
          label="Write open surfaces two-sided"
          hint="For sheets that disappear when seen from behind (IFC viewers hide back faces). Makes files bigger; Revit and Navisworks shapes rarely need it."
        />
        <Toggle
          checked={settings.types}
          onChange={(v) => updateSettings({ types: v })}
          label="Type objects for family types"
          hint="Elements of one Revit family type share an IFC type (IfcWallType, IfcDoorType…), with the type's properties."
        />
        <Toggle
          checked={settings.assetsInIfc}
          onChange={(v) => updateSettings({ assetsInIfc: v })}
          label="Asset information"
          hint="The equipment of the asset register (below) gets its manufacturer, model, serial, warranty and service life, its room, systems and what serves it, as IFC property sets, systems and zones."
        />
        <Toggle
          checked={settings.lines}
          onChange={(v) => updateSettings({ lines: v })}
          label="Keep line work as annotations"
          hint="Elements made only of lines (model lines, separation lines) become IFC annotations, when their category is not left out above."
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5">
          <span className="text-[12px] text-fg">Texture pictures</span>
          <Segmented
            className="w-[264px]"
            value={settings.textures}
            onChange={(v) => updateSettings({ textures: v })}
            options={[
              { value: "files", label: "PNG files", title: "PNG files in a textures folder next to the IFC files (IfcImageTexture): the most widely read." },
              { value: "embed", label: "In the IFC", title: "The pictures are stored in the IFC file itself (IfcBlobTexture): one file, fewer readers." },
              { value: "none", label: "Leave out", title: "Colours only; textured surfaces get the picture's average colour." },
            ]}
          />
          <span className="basis-full text-[11px] leading-snug text-fg-3">
            Colours, shine, transparency and metal are always written. Textures need a viewer that reads them; others show each surface in its average colour.
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {running ? (
          <Button variant="danger" icon={<Square size={12} />} onClick={cancelGeneration}>
            Cancel
          </Button>
        ) : (
          <Button variant="primary" icon={<Play size={13} />} disabled={!canRun} onClick={() => void generate()} data-testid="convert-generate">
            Generate IFC
          </Button>
        )}
        <span className="text-[12px] text-fg-3">
          {includedParts.length || readyPlans.length
            ? `${formatCount(elements)} elements from ${includedParts.length} source file${includedParts.length === 1 ? "" : "s"}${readyPlans.length ? ` and ${readyPlans.length} plan${readyPlans.length === 1 ? "" : "s"}` : ""} · ${disciplines.size} discipline${disciplines.size === 1 ? "" : "s"}`
            : "Add a model or trace a plan first."}
        </span>
      </div>

      {generation && (running || generation.error) ? (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[11.5px] text-fg-2">
            <span>{generation.phase}</span>
            <span className="tabular">{generation.total ? `${formatCount(generation.done)} / ${formatCount(generation.total)}` : ""}</span>
          </div>
          {running ? <ProgressBar value={generation.total ? generation.done / generation.total : undefined} /> : null}
          {generation.error ? (
            <Callout tone="bad" className="mt-2">
              {generation.error}
            </Callout>
          ) : null}
        </div>
      ) : null}

      {outputs.length || passThrough.length ? (
        <div className="mt-4" data-testid="convert-results">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">Files</h3>
            {report ? (
              <span className="text-[11px] text-fg-3">
                {formatCount(report.elements)} elements in {formatDuration(report.seconds * 1000)}
                {report.skipped.excludedCategory + report.skipped.pattern ? ` · ${formatCount(report.skipped.excludedCategory + report.skipped.pattern)} left out by the filters` : ""}
              </span>
            ) : null}
          </div>
          <ul className="flex flex-col gap-1.5">
            {outputs.map((o) => (
              <li key={o.name} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2.5 py-2" data-testid="convert-output">
                <Box size={15} className="shrink-0 text-fg-3" />
                <div className="min-w-0 flex-1 basis-56">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-medium text-fg" title={o.name}>
                      {o.name}
                    </span>
                    {o.discipline === null ? <Badge tone="accent">Federated</Badge> : null}
                  </div>
                  <div className="truncate text-[11px] text-fg-3">
                    {o.label} · {formatCount(o.elements)} elements · {formatBytes(o.bytes)}
                    {o.textures ? ` · ${o.textures} texture${o.textures === 1 ? "" : "s"}` : ""} ·{" "}
                    {Object.entries(o.classes)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 3)
                      .map(([k, v]) => `${k.replace(/^Ifc/, "")} ${formatCount(v)}`)
                      .join(", ")}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => openInViewer(o.name)}>
                  View
                </Button>
                <Button size="sm" icon={<Download size={12} />} onClick={() => downloadBlob(o.blob, o.name)} title={o.assets?.length ? "The IFC file alone" : undefined}>
                  Download
                </Button>
                <Button size="sm" icon={<Download size={12} />} busy={zipping === `frag|${o.name}`} onClick={() => void toFrag(o.name, o.blob)} title="The same model as That Open Fragments (.frag): opens in seconds in Fragments viewers">
                  .frag
                </Button>
                {o.assets?.length ? (
                  <Button
                    size="sm"
                    icon={<FileArchive size={12} />}
                    busy={zipping === o.name}
                    onClick={() => void zip(o.name, () => zipOutput(o), `${o.name.replace(/\.ifc$/i, "")}.zip`)}
                    title="The IFC file with its textures folder, as one archive"
                  >
                    With textures
                  </Button>
                ) : null}
              </li>
            ))}
            {passThrough.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2.5 py-2">
                <Box size={15} className="shrink-0 text-fg-3" />
                <div className="min-w-0 flex-1 basis-56">
                  <div className="truncate text-[12.5px] font-medium text-fg">{s.ifc!.name}</div>
                  <div className="truncate text-[11px] text-fg-3">
                    {disciplineLabel(s.ifc!.discipline)} · {s.ifc!.note} · {formatBytes(s.ifc!.blob.size)}
                  </div>
                </div>
                <Button size="sm" icon={<Download size={12} />} onClick={() => downloadBlob(s.ifc!.blob, s.ifc!.name)}>
                  Download
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" icon={<Box size={13} />} onClick={() => openInViewer("disciplines")} data-testid="convert-open-viewer">
              Open in the model viewer
            </Button>
            {hasFederated ? (
              <Button onClick={() => openInViewer("federated")} title="The federated file alone">
                Open the federated file
              </Button>
            ) : null}
            <Button
              icon={<FolderDown size={13} />}
              onClick={() =>
                void saveAllToFolder().then((ok) => {
                  if (!ok) {
                    pushToast("info", "This browser cannot write to a folder; downloading the files instead.");
                    downloadAll();
                  }
                })
              }
            >
              Save all to a folder…
            </Button>
            {withTextures ? (
              <Button icon={<FileArchive size={13} />} busy={zipping === "*"} onClick={downloadAll} title="Every file with the textures folder, as one archive">
                Download all (.zip)
              </Button>
            ) : null}
          </div>
          {report ? (
            <p className="mt-2 text-[11px] leading-snug text-fg-3">
              Geometry: {formatCount(report.geometry.mapped)} placed copies of {formatCount(report.geometry.maps)} shared shapes, {formatCount(report.geometry.baked)} shapes written in place
              {report.geometry.twoSided ? `, ${formatCount(report.geometry.twoSided)} two-sided` : ""}. Site origin {report.frame.origin.map((v) => Math.round(v * 100) / 100).join(", ")} m
              {report.frame.rotationDeg ? `, rotated ${Math.round(report.frame.rotationDeg * 1000) / 1000}°` : ""}.
              {report.appearance ? (
                <>
                  {" "}
                  Appearance: {formatCount(report.appearance.styles)} surface styles
                  {report.appearance.textured ? `, ${formatCount(report.appearance.textured)} textured shapes using ${report.appearance.textures || "embedded"} picture${report.appearance.textures === 1 ? "" : "s"}` : ""}
                  {report.appearance.coloured ? `, ${formatCount(report.appearance.coloured)} shapes with face colours` : ""}
                  {report.appearance.materials ? `, ${formatCount(report.appearance.materials)} materials` : ""}
                  {report.appearance.types ? `, ${formatCount(report.appearance.types)} type objects` : ""}
                  {report.appearance.annotations ? `, ${formatCount(report.appearance.annotations)} line annotations` : ""}.
                </>
              ) : null}
              {report.appearance?.assets ? (
                <>
                  {" "}
                  Asset information on {formatCount(report.appearance.assets)} elements
                  {report.appearance.systems ? `, ${formatCount(report.appearance.systems)} system${report.appearance.systems === 1 ? "" : "s"}` : ""}
                  {report.appearance.zones ? `, ${formatCount(report.appearance.zones)} zone${report.appearance.zones === 1 ? "" : "s"}` : ""}.
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}
      {plans.some((p) => p.include) && !readyPlans.length ? (
        <p className="mt-2 text-[11px] text-fg-3">Plans are included once they have a scale and traced walls.</p>
      ) : null}
    </Card>
  );
}
