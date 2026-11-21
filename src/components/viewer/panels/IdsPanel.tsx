"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { CheckCircle2, ChevronRight, CircleSlash, Download, FileCheck2, FileUp, RefreshCw, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IndexGate } from "@/components/ui/IndexGate";
import { Badge, Button, Callout, EmptyState, ProgressBar } from "@/components/ui/primitives";
import { describeFacet, evaluateIds, selectable, type IdsFailure, type IdsReport, type IdsSpecResult } from "@/lib/analysis/ids/evaluate";
import { parseIds } from "@/lib/analysis/ids/parse";
import type { IdsDocument } from "@/lib/analysis/ids/types";
import type { ModelIndex } from "@/lib/data/model-index";
import { useModelIndexes } from "@/lib/data/use-model-index";
import { useEngine } from "@/lib/engine/context";
import { useViewerStore } from "@/lib/store";
import { downloadCsv } from "@/lib/utils/download";
import { formatCount, prettyCategory } from "@/lib/utils/format";
import { ResultActions } from "../ResultActions";

export function IdsPanel() {
  const hasModels = useViewerStore((state) => state.models.length > 0);
  const state = useModelIndexes(hasModels);
  return (
    <IndexGate
      state={state}
      hasModels={hasModels}
      emptyTitle="No model loaded"
      emptyHint="Open a model, then load a buildingSMART IDS file to check the model against its information requirements."
    >
      <IdsBody indexes={state.indexes} />
    </IndexGate>
  );
}

function IdsBody({ indexes }: { indexes: ModelIndex[] }) {
  const [document, setDocument] = useState<IdsDocument | null>(null);
  const [report, setReport] = useState<IdsReport | null>(null);
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const token = useRef(0);

  const run = useCallback(
    async (doc: IdsDocument) => {
      const current = ++token.current;
      setError(null);
      setProgress({ fraction: 0, label: "Starting" });
      try {
        const result = await evaluateIds(doc, indexes, (fraction, label) => {
          if (current === token.current) setProgress({ fraction, label });
        });
        if (current === token.current) setReport(result);
      } catch (reason) {
        if (current === token.current) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (current === token.current) setProgress(null);
      }
    },
    [indexes],
  );

  // Re-check when the set of models changes.
  useEffect(() => {
    if (document) void run(document);
  }, [document, run]);

  const load = async (text: string, fileName: string) => {
    setError(null);
    setReport(null);
    setOpen(null);
    try {
      setDocument(parseIds(text, fileName));
    } catch (reason) {
      setDocument(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const loadSample = async () => {
    try {
      const response = await fetch("/samples/basic-requirements.ids");
      if (!response.ok) throw new Error(`Could not load the sample (${response.status}).`);
      await load(await response.text(), "basic-requirements.ids");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const exportCsv = async () => {
    if (!report) return;
    const rows: (string | number)[][] = [];
    for (const result of report.results) {
      if (result.failCount === 0) {
        rows.push([result.spec.name, result.status, result.applicableCount, result.passCount, 0, "", "", "", "", result.message ?? ""]);
        continue;
      }
      const reasons = new Map(result.failures.map((failure) => [`${failure.modelId}:${failure.localId}`, failure.reasons.join(" | ")]));
      for (const [modelId, ids] of Object.entries(result.failed)) {
        const index = indexes.find((candidate) => candidate.modelId === modelId);
        if (!index) continue;
        const [names, guids] = await Promise.all([index.names(ids), index.model.getGuidsByLocalIds(ids)]);
        ids.forEach((id, position) => {
          const row = index.rowOf(id);
          rows.push([
            result.spec.name,
            result.status,
            result.applicableCount,
            result.passCount,
            result.failCount,
            modelId,
            guids[position] ?? "",
            row >= 0 ? prettyCategory(index.category(row)) : "",
            names.get(id) ?? "",
            reasons.get(`${modelId}:${id}`) ?? "",
          ]);
        });
      }
    }
    downloadCsv(["Specification", "Result", "Applicable", "Passed", "Failed", "Model", "GlobalId", "Class", "Name", "Reason"], rows, "ids-report.csv");
  };

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept=".ids,.xml"
      hidden
      onChange={async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) await load(await file.text(), file.name);
      }}
    />
  );

  if (!document) {
    return (
      <div className="p-3">
        {fileInput}
        <EmptyState
          icon={<FileCheck2 size={26} strokeWidth={1.5} />}
          title="Check against an IDS"
          action={
            <div className="flex flex-wrap justify-center gap-1.5">
              <Button variant="primary" icon={<FileUp size={13} />} onClick={() => inputRef.current?.click()}>
                Load .ids file
              </Button>
              <Button onClick={() => void loadSample()}>Try the sample</Button>
            </div>
          }
        >
          An IDS file lists what information the model must carry. Each specification is checked against the loaded models.
        </EmptyState>
        {error ? <Callout tone="bad">{error}</Callout> : null}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {fileInput}
      <div className="border-b border-line p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="break-words text-[13px] font-semibold text-fg">{document.title}</div>
            <div className="mt-0.5 truncate text-[11.5px] text-fg-3">
              {document.fileName}
              {document.version ? ` · v${document.version}` : ""}
              {document.author ? ` · ${document.author}` : ""}
            </div>
          </div>
          <button
            type="button"
            title="Remove this IDS"
            aria-label="Remove this IDS"
            onClick={() => {
              token.current += 1;
              setDocument(null);
              setReport(null);
              setProgress(null);
            }}
            className="grid size-6 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-surface-2 hover:text-fg"
          >
            <Trash2 size={13} />
          </button>
        </div>
        {document.description ? <p className="mt-1.5 text-[12px] leading-relaxed text-fg-2">{document.description}</p> : null}
        {report ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone="ok">{report.passed} passed</Badge>
            <Badge tone={report.failed > 0 ? "bad" : "neutral"}>{report.failed} failed</Badge>
            {report.skipped > 0 ? <Badge>{report.skipped} skipped</Badge> : null}
          </div>
        ) : null}
        {progress ? (
          <div className="mt-2">
            <ProgressBar value={progress.fraction} />
            <div className="mt-1 truncate text-[11.5px] text-fg-3">Checking: {progress.label}</div>
          </div>
        ) : null}
        {error ? (
          <Callout tone="bad" className="mt-2">
            {error}
          </Callout>
        ) : null}
        {document.warnings.length > 0 ? (
          <Callout tone="warn" className="mt-2">
            {document.warnings.slice(0, 3).map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
            {document.warnings.length > 3 ? <div>+ {document.warnings.length - 3} more</div> : null}
          </Callout>
        ) : null}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <ul>
          {(report?.results ?? []).map((result) => (
            <SpecRow key={result.spec.id} result={result} indexes={indexes} open={open === result.spec.id} onToggle={() => setOpen(open === result.spec.id ? null : result.spec.id)} />
          ))}
        </ul>
        {!report && !progress ? <p className="p-3 text-[12px] text-fg-3">No results yet.</p> : null}
      </div>

      <div className="flex flex-wrap gap-1.5 border-t border-line p-3">
        <Button size="sm" icon={<FileUp size={12} />} onClick={() => inputRef.current?.click()}>
          Load another
        </Button>
        <Button size="sm" icon={<RefreshCw size={12} />} disabled={Boolean(progress)} onClick={() => void run(document)}>
          Check again
        </Button>
        <Button size="sm" icon={<Download size={12} />} disabled={!report} onClick={() => void exportCsv()}>
          Report CSV
        </Button>
      </div>
    </div>
  );
}

function SpecRow({ result, indexes, open, onToggle }: { result: IdsSpecResult; indexes: ModelIndex[]; open: boolean; onToggle: () => void }) {
  const { spec } = result;
  const share = result.applicableCount > 0 ? result.passCount / result.applicableCount : 0;
  const failedVisible = useMemo(() => selectable(indexes, result.failed), [indexes, result.failed]);
  const passedVisible = useMemo(() => selectable(indexes, result.passed), [indexes, result.passed]);
  const visibleFailCount = Object.values(failedVisible).reduce((sum, ids) => sum + ids.length, 0);
  const hidden = result.failCount - visibleFailCount;

  return (
    <li className="border-b border-line/70">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-2">
        <span className="mt-px shrink-0" aria-hidden style={{ color: result.status === "pass" ? "var(--status-good)" : result.status === "fail" ? "var(--status-critical)" : "var(--series-other)" }}>
          {result.status === "pass" ? <CheckCircle2 size={14} /> : result.status === "fail" ? <XCircle size={14} /> : <CircleSlash size={14} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium text-fg">{spec.name}</span>
          <span className="tabular mt-0.5 block text-[11px] text-fg-3">
            {result.status === "pass" ? "Passed" : result.status === "fail" ? "Failed" : "Skipped"}
            {result.applicableCount > 0 ? ` · ${formatCount(result.passCount)} of ${formatCount(result.applicableCount)} comply` : " · nothing applicable"}
          </span>
          {result.applicableCount > 0 ? (
            // Meter: share of applicable items that comply.
            <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full" style={{ background: result.failCount > 0 ? "color-mix(in srgb, var(--status-critical) 22%, transparent)" : "var(--surface-3)" }} aria-hidden>
              <span className="block h-full rounded-full" style={{ width: `${share * 100}%`, background: "var(--status-good)" }} />
            </span>
          ) : null}
        </span>
        <ChevronRight size={13} className={clsx("mt-0.5 shrink-0 text-fg-3 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="bg-surface-2/60 px-3 pb-3 pt-1">
          {spec.description ? <p className="text-[12px] leading-relaxed text-fg-2">{spec.description}</p> : null}
          {spec.instructions ? <p className="mt-1 text-[12px] leading-relaxed text-fg-2">{spec.instructions}</p> : null}
          {result.message ? (
            <Callout tone={result.status === "fail" ? "bad" : "info"} className="mt-2">
              {result.message}
            </Callout>
          ) : null}
          <FacetList title={`Applies to${spec.occurrence === "required" ? " (at least one required)" : spec.occurrence === "prohibited" ? " (none allowed)" : ""}`} items={spec.applicability.map((facet) => ({ text: describeFacet(facet) }))} empty="Every item" />
          {spec.requirements.length > 0 ? (
            <FacetList
              title="Requirements"
              items={spec.requirements.map((facet, position) => ({
                text: `${facet.type !== "entity" && facet.cardinality !== "required" ? `${facet.cardinality === "optional" ? "Optional" : "Prohibited"}: ` : ""}${describeFacet(facet)}`,
                note: facet.instructions,
                failing: result.requirementFailures[position],
              }))}
            />
          ) : null}

          {result.failCount > 0 ? (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">Failing ({formatCount(result.failCount)})</span>
                <ResultActions items={failedVisible} disabled={visibleFailCount === 0} compact />
              </div>
              {hidden > 0 ? <p className="mt-1 text-[11.5px] text-fg-3">{formatCount(hidden)} failing item{hidden === 1 ? " has" : "s have"} no geometry and cannot be shown in 3D.</p> : null}
              <FailureList failures={result.failures} total={result.failCount} indexes={indexes} />
            </>
          ) : null}
          {result.passCount > 0 && result.failCount > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">Complying ({formatCount(result.passCount)})</span>
              <ResultActions items={passedVisible} compact />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function FacetList({ title, items, empty }: { title: string; items: { text: string; note?: string; failing?: number }[]; empty?: string }) {
  return (
    <div className="mt-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{title}</div>
      {items.length === 0 ? (
        <p className="mt-1 text-[12px] text-fg-2">{empty}</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {items.map((item, position) => (
            <li key={position} className="flex items-start gap-2 text-[12px] text-fg">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-fg-3" />
              <span className="min-w-0 flex-1">
                <span className="break-words">{item.text}</span>
                {item.note ? <span className="block text-[11.5px] text-fg-3">{item.note}</span> : null}
              </span>
              {item.failing ? <span className="tabular shrink-0 text-[11.5px] text-bad">{formatCount(item.failing)} fail</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FailureList({ failures, total, indexes }: { failures: IdsFailure[]; total: number; indexes: ModelIndex[] }) {
  const engine = useEngine();
  const scrollRef = useRef<HTMLDivElement>(null);
  const byModel = useMemo(() => new Map(indexes.map((index) => [index.modelId, index])), [indexes]);
  const names = useRef(new Map<string, string>());
  const pending = useRef(new Set<string>());
  const [, setVersion] = useState(0);
  const virtualizer = useVirtualizer({ count: failures.length, getScrollElement: () => scrollRef.current, estimateSize: () => 44, overscan: 6 });
  const rows = virtualizer.getVirtualItems();

  useEffect(() => {
    const wanted = new Map<ModelIndex, number[]>();
    for (const row of rows) {
      const failure = failures[row.index];
      if (!failure) continue;
      const key = `${failure.modelId}:${failure.localId}`;
      const index = byModel.get(failure.modelId);
      if (!index || names.current.has(key) || pending.current.has(key)) continue;
      pending.current.add(key);
      let list = wanted.get(index);
      if (!list) wanted.set(index, (list = []));
      list.push(failure.localId);
    }
    for (const [index, ids] of wanted) {
      void index.names(ids).then((result) => {
        for (const [id, name] of result) {
          names.current.set(`${index.modelId}:${id}`, name);
          pending.current.delete(`${index.modelId}:${id}`);
        }
        setVersion((value) => value + 1);
      });
    }
  });

  return (
    <>
      <div ref={scrollRef} className="scroll-thin mt-2 max-h-60 overflow-auto rounded-md border border-line bg-surface">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {rows.map((row) => {
            const failure = failures[row.index];
            const index = byModel.get(failure.modelId);
            const position = index?.rowOf(failure.localId) ?? -1;
            const name = names.current.get(`${failure.modelId}:${failure.localId}`);
            return (
              <button
                key={row.key}
                type="button"
                disabled={position < 0}
                onClick={() => void engine?.select({ [failure.modelId]: [failure.localId] }, { zoom: true })}
                className="absolute left-0 right-0 border-b border-line/70 px-2.5 text-left hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
                style={{ top: row.start, height: 44 }}
                title={failure.reasons.join("\n")}
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{name || (name === undefined ? "…" : "(unnamed)")}</span>
                  <span className="shrink-0 text-[11px] text-fg-3">{position >= 0 && index ? prettyCategory(index.category(position)) : `#${failure.localId}`}</span>
                </span>
                <span className="block truncate text-[11.5px] text-fg-2">{failure.reasons.join(" · ")}</span>
              </button>
            );
          })}
        </div>
      </div>
      {failures.length < total ? <p className="mt-1 text-[11.5px] text-fg-3">Reasons are listed for the first {formatCount(failures.length)}; the CSV report covers all {formatCount(total)}.</p> : null}
    </>
  );
}
