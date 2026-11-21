"use client";

import clsx from "clsx";
import { Folder, FolderOpen, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Badge, Button, ProgressBar, Spinner } from "@/components/ui/primitives";
import { closeFolderPlan, openFolderPlan, setAllSelected, setRowSelected } from "@/lib/collection/open";
import { useFolderStore, type PlanRow } from "@/lib/collection/store";
import { formatBytes, formatCount } from "@/lib/utils/format";

const KIND_LABEL: Record<PlanRow["kind"], string> = { ifc: "IFC", ifczip: "ifcZIP", frag: "FRAG" };

/** From this much IFC to convert, the dialog points to the command-line converter. */
const HEAVY_CONVERSION = 750 * 1024 * 1024;

/** Says why a model was left out, or what ticking it anyway leads to. */
function repeatText(row: PlanRow): string {
  const repeat = row.repeat;
  if (!repeat) return "";
  const all = repeat.shared >= repeat.total;
  const count = all ? `all ${formatCount(repeat.total)} elements` : `${formatCount(repeat.shared)} of its ${formatCount(repeat.total)} elements`;
  let found: string;
  if (repeat.kind === "combined") found = `${count} are also in ${repeat.of.length} other models here (${repeat.of.join(", ")}), which can be shown and hidden one by one`;
  else if (repeat.kind === "same") found = `it holds the same elements as ${repeat.of[0]}`;
  else found = `${count} are also in ${repeat.of[0]}`;
  return row.selected ? `Opening it draws things twice: ${found}.` : `Left out: ${found}.`;
}

function Row({ row }: { row: PlanRow }) {
  const facts = [row.schema, row.elements !== null ? `${formatCount(row.elements)} elements` : "", row.description].filter(Boolean).join(" · ");
  return (
    <li className={clsx("rounded-md px-2 py-1.5", row.selected ? "" : "opacity-75")}>
      <label className="flex cursor-pointer items-start gap-2.5">
        <input type="checkbox" checked={row.selected} onChange={(event) => setRowSelected(row.key, event.target.checked)} className="mt-[3px] size-3.5 shrink-0 accent-[var(--accent)]" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate text-[12.5px] font-medium text-fg" title={row.name}>
              {row.name}
            </span>
            <Badge tone={row.kind === "frag" ? "ok" : "accent"}>{KIND_LABEL[row.kind]}</Badge>
            {row.otherCopies.length > 0 ? (
              <span className="shrink-0 text-[11px] text-fg-3" title="Other copies of the same model in this folder. They are not opened.">
                also as {row.otherCopies.join(", ")}
              </span>
            ) : null}
            <span className="tabular ml-auto shrink-0 text-[11.5px] text-fg-3">{formatBytes(row.size)}</span>
          </span>
          {row.scan === "waiting" ? (
            <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-3">
              <Spinner size={11} /> Looking into it…
            </span>
          ) : facts ? (
            <span className="mt-0.5 block truncate text-[11.5px] text-fg-3" title={facts}>
              {facts}
            </span>
          ) : null}
          {row.note ? <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-3">{row.note}</span> : null}
          {row.repeat ? <span className="mt-0.5 block text-[11.5px] leading-snug text-warn">{repeatText(row)}</span> : null}
        </span>
      </label>
    </li>
  );
}

/** Shows what an opened folder holds and lets the user choose what to load. */
export function FolderDialog() {
  const plan = useFolderStore((state) => state.plan);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const allRef = useRef<HTMLInputElement>(null);
  const visible = Boolean(plan && plan.rows.length > 1);
  const selectedCount = plan?.rows.filter((row) => row.selected).length ?? 0;
  const rowCount = plan?.rows.length ?? 0;

  // A checkbox that is neither ticked nor empty while only some models are chosen.
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = selectedCount > 0 && selectedCount < rowCount;
  }, [selectedCount, rowCount, visible]);

  useEffect(() => {
    if (!visible) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFolderPlan();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible]);

  if (!plan || !visible) return null;

  const chosen = plan.rows.filter((row) => row.selected);
  const chosenBytes = chosen.reduce((sum, row) => sum + row.size, 0);
  const convertBytes = chosen.reduce((sum, row) => sum + row.convertBytes, 0);
  const leftOut = plan.rows.filter((row) => row.repeat && !row.selected).length;
  const withCopies = plan.rows.filter((row) => row.otherCopies.length > 0).length;
  const allSelected = chosen.length === plan.rows.length;

  // Rows are listed folder by folder, in the order the plan gives them.
  const folders: { folder: string; rows: PlanRow[] }[] = [];
  for (const row of plan.rows) {
    const last = folders[folders.length - 1];
    if (last && last.folder === row.folder) last.rows.push(row);
    else folders.push({ folder: row.folder, rows: [row] });
  }
  const elsewhere = [plan.revit ? `${plan.revit} Revit file${plan.revit === 1 ? "" : "s"}` : "", plan.navisworks ? `${plan.navisworks} Navisworks file${plan.navisworks === 1 ? "" : "s"}` : ""].filter(Boolean);
  const oneElsewhere = plan.revit + plan.navisworks === 1;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/35 p-4" onPointerDown={(event) => event.target === event.currentTarget && closeFolderPlan()}>
      <div role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title" className="flex max-h-[min(86vh,760px)] w-[min(100%,640px)] flex-col rounded-xl border border-line bg-surface shadow-pop">
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
            <FolderOpen size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="folder-dialog-title" className="truncate text-[14px] font-semibold text-fg">
              Open {plan.name}
            </h2>
            <p className="mt-0.5 text-[12px] text-fg-3">
              {plan.rows.length} models found
              {withCopies > 0 ? `, ${withCopies === plan.rows.length ? "all" : withCopies} of them in more than one format: one copy of each is opened` : ""}.
            </p>
          </div>
          <button type="button" aria-label="Close" title="Close" onClick={closeFolderPlan} className="rounded p-1 text-fg-3 hover:bg-surface-2 hover:text-fg">
            <X size={15} />
          </button>
        </header>

        <div className="flex items-center gap-3 border-b border-line px-4 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-2">
            <input ref={allRef} type="checkbox" checked={allSelected} onChange={(event) => setAllSelected(event.target.checked)} className="size-3.5 accent-[var(--accent)]" />
            All models
          </label>
          <div className="ml-auto flex min-w-0 items-center gap-2 text-[11.5px] text-fg-3">
            {plan.analysing ? (
              <>
                <span className="truncate">Checking the models for repeated content</span>
                <ProgressBar value={plan.totalBytes > 0 ? plan.scannedBytes / plan.totalBytes : undefined} className="w-24 shrink-0" />
              </>
            ) : leftOut > 0 ? (
              <span className="truncate">
                {leftOut} model{leftOut === 1 ? " is" : "s are"} left out because {leftOut === 1 ? "it repeats" : "they repeat"} what others hold.
              </span>
            ) : (
              <span className="truncate">No model repeats another.</span>
            )}
          </div>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {folders.map((group, index) => (
            <section key={`${group.folder}-${index}`} className="mb-1.5">
              <h3 className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[11.5px] font-medium text-fg-3">
                <Folder size={12} className="shrink-0" />
                <span className="truncate">{group.folder || plan.name}</span>
              </h3>
              <ul>
                {group.rows.map((row) => (
                  <Row key={row.key} row={row} />
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="flex items-center gap-3 border-t border-line px-4 py-3">
          <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-fg-3">
            {elsewhere.length > 0 ? `${elsewhere.join(" and ")} in this folder ${oneElsewhere ? "opens from its own viewer" : "open from their own viewers"}. ` : ""}
            {chosen.length === 0 ? (
              "Tick the models to open."
            ) : convertBytes >= HEAVY_CONVERSION ? (
              <>
                {formatBytes(convertBytes)} of IFC to convert, which takes minutes and several GB of memory in a browser tab. <code className="rounded bg-surface-2 px-1 py-px text-[11px] text-fg-2">npm run convert -- &lt;folder&gt;</code> does it once, outside the
                browser: the folder then opens from the .frag files it writes.
              </>
            ) : convertBytes > 0 ? (
              "Models are converted one after another, the largest first; large ones take a while."
            ) : (
              "These models are .frag files already: nothing needs converting."
            )}
          </p>
          <Button onClick={closeFolderPlan}>Cancel</Button>
          <Button ref={confirmRef} variant="primary" disabled={chosen.length === 0} onClick={() => void openFolderPlan()}>
            Open {chosen.length} model{chosen.length === 1 ? "" : "s"}
            {chosen.length > 0 ? ` · ${formatBytes(chosenBytes)}` : ""}
          </Button>
        </footer>
      </div>
    </div>
  );
}
