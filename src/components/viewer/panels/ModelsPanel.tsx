"use client";

import clsx from "clsx";
import { ChevronRight, Combine, Download, Eye, EyeOff, FileBox, Files, Folder, FolderOpen, MoreHorizontal, Package, Scan, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Badge, Button, EmptyState, IconButton, SectionTitle } from "@/components/ui/primitives";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { entriesFromPicker } from "@/lib/collection/files";
import { planFolder } from "@/lib/collection/open";
import { useEngine } from "@/lib/engine/context";
import type { ViewerEngine } from "@/lib/engine/engine";
import { IFC_ACCEPT, openModelFiles } from "@/lib/engine/open-files";
import { useViewerStore, type ModelInfo } from "@/lib/store";
import { formatBytes, formatCount, formatDuration } from "@/lib/utils/format";

const SOURCE_LABEL: Record<ModelInfo["source"], string> = { ifc: "IFC", frag: "FRAG", rvt: "RVT" };

/** From this many models on, the list shows one line per model until a line is opened. */
const COMPACT_FROM = 4;

/** Menu entries for exporting a set of models: each as its own .frag, or all in one. */
function exportItems(engine: ViewerEngine, models: ModelInfo[], name: string, what: string): MenuItem[] {
  const ids = models.map((model) => model.id);
  return [
    {
      label: `${what} as .frag files (.zip)`,
      icon: <Package size={14} />,
      hint: "One .frag per model, packed in a .zip. Unpack it next to the IFC files and the folder opens in seconds next time; the .zip also opens here as it is.",
      onSelect: () => void engine.exportFragmentsArchive(ids, name),
    },
    {
      label: `${what} as one combined .frag`,
      icon: <Combine size={14} />,
      hint: "A single Fragments model that holds every element of these models, placed as shown here. It is put together in memory: for a very large set, npm run combine does the same outside the browser.",
      onSelect: () => void engine.exportCombinedFragments(ids, name),
    },
  ];
}

export function ModelsPanel({ accept = IFC_ACCEPT, onFiles }: { accept?: string; onFiles?: (files: File[]) => void }) {
  const engine = useEngine();
  const storeModels = useViewerStore((state) => state.models);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const handleFiles = (list: FileList | null) => {
    if (!list || !engine) return;
    const files = Array.from(list);
    if (onFiles) onFiles(files);
    else void openModelFiles(engine, files);
  };
  const handleFolder = (list: FileList | null) => {
    if (!list || list.length === 0 || !engine) return;
    const { name, entries } = entriesFromPicker(list);
    void planFolder(engine, entries, name);
  };

  // Models that were opened together are listed together. A folder's models keep the order its dialog
  // showed them in, whatever order they arrive in (large ones are converted first); others keep the order they arrived in.
  const groups: { collection: string | null; models: ModelInfo[] }[] = [];
  for (const model of storeModels) {
    const collection = model.collection ?? null;
    const group = collection ? groups.find((entry) => entry.collection === collection) : null;
    if (group) group.models.push(model);
    else groups.push({ collection, models: [model] });
  }
  for (const group of groups) group.models.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  // Everything below, exports included, goes by the order of the list.
  const models = groups.flatMap((group) => group.models);
  const compact = models.length >= COMPACT_FROM;
  const hidden = models.filter((model) => !model.visible);
  const visible = models.filter((model) => model.visible);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-3">
        <input
          ref={fileInput}
          type="file"
          accept={accept}
          multiple
          hidden
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <input
          ref={folderInput}
          type="file"
          multiple
          hidden
          data-testid="folder-input"
          // Not part of React's typings: lets the picker choose a folder and returns every file in it.
          {...{ webkitdirectory: "", directory: "" }}
          onChange={(event) => {
            handleFolder(event.target.files);
            event.target.value = "";
          }}
        />
        <div className="flex gap-2">
          <Button variant="primary" className="flex-1" icon={<Files size={14} />} disabled={!engine} onClick={() => fileInput.current?.click()}>
            Open files
          </Button>
          <Button className="flex-1" icon={<FolderOpen size={14} />} disabled={!engine} onClick={() => folderInput.current?.click()} title="Open every model in a folder. Copies and repeated models are sorted out first.">
            Open folder
          </Button>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-fg-3">
          {accept.split(",").join(", ")} · or drop files or a whole folder onto the 3D view. Several models can be open at once.
        </p>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
        <SectionTitle
          aside={
            models.length > 1 && engine ? (
              <div className="flex items-center gap-0.5">
                <span title={hidden.length > 0 ? `${visible.length} of ${models.length} models are shown` : `${models.length} models`}>
                  <Badge className="mr-1 whitespace-nowrap">{hidden.length > 0 ? `${visible.length} of ${models.length}` : models.length}</Badge>
                </span>
                <IconButton label="Show all models" size="sm" disabled={hidden.length === 0} onClick={() => void engine.setModelsVisible(hidden.map((model) => model.id), true)}>
                  <Eye size={14} />
                </IconButton>
                <IconButton label="Hide all models" size="sm" disabled={visible.length === 0} onClick={() => void engine.setModelsVisible(visible.map((model) => model.id), false)}>
                  <EyeOff size={14} />
                </IconButton>
                <Menu
                  align="end"
                  width={290}
                  trigger={({ toggle }) => (
                    <IconButton label="Export models" size="sm" onClick={toggle}>
                      <Download size={14} />
                    </IconButton>
                  )}
                  items={[
                    ...exportItems(engine, models, groups.length === 1 && groups[0].collection ? groups[0].collection : "models", `All ${models.length} models`),
                    ...(hidden.length > 0 && visible.length > 0 ? (["separator", ...exportItems(engine, visible, "visible-models", `The ${visible.length} shown`)] as (MenuItem | "separator")[]) : []),
                  ]}
                />
              </div>
            ) : models.length > 0 ? (
              <Badge>{models.length}</Badge>
            ) : null
          }
        >
          Loaded models
        </SectionTitle>
        {models.length === 0 ? (
          <EmptyState icon={<FileBox size={26} strokeWidth={1.5} />} title="No model yet">
            Open an IFC or ifcZIP to convert it to Fragments, open a .frag you exported earlier, or open a whole folder of models.
          </EmptyState>
        ) : (
          <div className="mt-1 flex flex-col gap-2">
            {groups.map((group, index) =>
              group.collection ? (
                <CollectionGroup key={`${group.collection}-${index}`} name={group.collection} models={group.models} compact={compact} />
              ) : (
                <ul key={`model-${group.models[0].id}`} className="flex flex-col gap-2">
                  <ModelCard model={group.models[0]} compact={compact} />
                </ul>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The models of one folder or archive, with a switch and exports for all of them. */
function CollectionGroup({ name, models, compact }: { name: string; models: ModelInfo[]; compact: boolean }) {
  const engine = useEngine();
  const [open, setOpen] = useState(true);
  if (!engine) return null;
  const ids = models.map((model) => model.id);
  const shown = models.filter((model) => model.visible).length;
  const elements = models.reduce((sum, model) => sum + model.elementCount, 0);
  return (
    <section className="rounded-lg border border-line bg-surface-2/50">
      <header className="flex items-center gap-1.5 py-1.5 pl-1.5 pr-2">
        <button type="button" aria-expanded={open} aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen((value) => !value)} className="grid size-5 shrink-0 place-items-center rounded text-fg-3 hover:bg-surface-2 hover:text-fg">
          <ChevronRight size={13} className={clsx("transition-transform", open && "rotate-90")} />
        </button>
        <Folder size={14} className="shrink-0 text-fg-3" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-fg" title={name}>
            {name}
          </div>
          <div className="tabular text-[11px] text-fg-3">
            {models.length} models · {formatCount(elements)} elements{shown < models.length ? ` · ${shown} shown` : ""}
          </div>
        </div>
        <IconButton label={shown === models.length ? `Hide all of ${name}` : `Show all of ${name}`} size="sm" onClick={() => void engine.setModelsVisible(ids, shown !== models.length)}>
          {shown === 0 ? <EyeOff size={14} /> : <Eye size={14} className={shown < models.length ? "opacity-55" : undefined} />}
        </IconButton>
        <Menu
          align="end"
          width={290}
          trigger={({ toggle }) => (
            <IconButton label={`Actions for ${name}`} size="sm" onClick={toggle}>
              <MoreHorizontal size={14} />
            </IconButton>
          )}
          items={[
            { label: "Zoom to these models", icon: <Scan size={14} />, onSelect: () => void engine.fitAll(true, ids) },
            { label: "Show only these models", icon: <Eye size={14} />, onSelect: () => void engine.showOnlyModels(ids) },
            "separator",
            ...exportItems(engine, models, name, `These ${models.length} models`),
            "separator",
            { label: "Remove all", icon: <Trash2 size={14} />, danger: true, onSelect: () => void engine.removeModels(ids) },
          ]}
        />
      </header>
      {open ? (
        <ul className="flex flex-col gap-1.5 px-1.5 pb-1.5">
          {models.map((model) => (
            <ModelCard key={model.id} model={model} compact={compact} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ModelCard({ model, compact }: { model: ModelInfo; compact: boolean }) {
  const engine = useEngine();
  const [expanded, setExpanded] = useState(false);
  if (!engine) return null;
  const open = !compact || expanded;
  return (
    <li className={clsx("rounded-lg border border-line bg-surface", compact ? "px-1.5 py-1.5" : "p-2.5", !model.visible && "opacity-70")}>
      <div className="flex items-start gap-1.5">
        {compact ? (
          <button type="button" aria-expanded={open} aria-label={open ? "Hide details" : "Show details"} onClick={() => setExpanded((value) => !value)} className="mt-0.5 grid size-5 shrink-0 place-items-center rounded text-fg-3 hover:bg-surface-2 hover:text-fg">
            <ChevronRight size={13} className={clsx("transition-transform", open && "rotate-90")} />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-fg" title={model.description ? `${model.name}\n${model.description}` : model.name}>
            {model.name}
          </div>
          {compact && !open ? (
            <div className="tabular truncate text-[11px] text-fg-3">
              {SOURCE_LABEL[model.source]} · {formatCount(model.elementCount)} elements{model.description ? ` · ${model.description}` : ""}
            </div>
          ) : (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <Badge tone="accent">{SOURCE_LABEL[model.source]}</Badge>
              {model.schema ? <Badge>{model.schema}</Badge> : null}
              <Badge>{formatCount(model.elementCount)} elements</Badge>
            </div>
          )}
        </div>
        <IconButton label={model.visible ? "Hide model" : "Show model"} size="sm" onClick={() => void engine.setModelVisible(model.id, !model.visible)}>
          {model.visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconButton>
        <Menu
          align="end"
          trigger={({ toggle }) => (
            <IconButton label="Model actions" size="sm" onClick={toggle}>
              <MoreHorizontal size={14} />
            </IconButton>
          )}
          items={[
            { label: "Zoom to model", icon: <Scan size={14} />, onSelect: () => void engine.fitAll(true, [model.id]) },
            { label: "Show only this model", icon: <Eye size={14} />, onSelect: () => void engine.showOnlyModels([model.id]) },
            "separator",
            { label: "Export .frag", icon: <Download size={14} />, onSelect: () => void engine.exportFragments(model.id) },
            {
              label: "Download IFC",
              icon: <Download size={14} />,
              disabled: !model.hasSourceIfc,
              hint: model.hasSourceIfc ? undefined : "Only available for models converted in this session",
              onSelect: () => engine.downloadSourceIfc(model.id),
            },
            "separator",
            { label: "Remove", icon: <Trash2 size={14} />, danger: true, onSelect: () => void engine.removeModel(model.id) },
          ]}
        />
      </div>
      {open ? (
        <div className={compact ? "pl-[26px] pr-1" : undefined}>
          {model.description ? <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-2">{model.description}</p> : null}
          <dl className="tabular mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11.5px] text-fg-3">
            {model.sourceBytes !== undefined ? (
              <>
                <dt>Source</dt>
                <dd className="text-right text-fg-2">{formatBytes(model.sourceBytes)}</dd>
              </>
            ) : null}
            <dt>Fragments</dt>
            <dd className="text-right text-fg-2">{formatBytes(model.fragmentBytes)}</dd>
            {model.convertMs !== undefined ? (
              <>
                <dt>Converted in</dt>
                <dd className="text-right text-fg-2">{formatDuration(model.convertMs)}</dd>
              </>
            ) : null}
            {model.leftOutGeometry ? (
              <>
                <dt title="Pieces of geometry the importer could not turn into surfaces. They are missing from the model.">Geometry left out</dt>
                <dd className="text-right text-warn">{formatCount(model.leftOutGeometry)} pieces</dd>
              </>
            ) : null}
            {model.folder ? (
              <>
                <dt>Folder</dt>
                <dd className="truncate text-right text-fg-2" title={model.folder}>
                  {model.folder}
                </dd>
              </>
            ) : null}
          </dl>
          {model.note ? <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-3">{model.note}</p> : null}
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" icon={<Download size={12} />} onClick={() => void engine.exportFragments(model.id)} title="Download this model as a Fragments (.frag) file">
              .frag
            </Button>
            {model.hasSourceIfc ? (
              <Button size="sm" icon={<Download size={12} />} onClick={() => engine.downloadSourceIfc(model.id)} title="Download the IFC this model was converted from">
                .ifc
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}
