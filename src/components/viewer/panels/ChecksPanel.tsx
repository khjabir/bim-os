"use client";

import clsx from "clsx";
import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronRight, CircleAlert, Download, Info, Play, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IndexGate } from "@/components/ui/IndexGate";
import { Button, ProgressBar } from "@/components/ui/primitives";
import { runHealthChecks, type CheckResult, type HealthReport, type Severity } from "@/lib/analysis/checks";
import type { ModelIndex } from "@/lib/data/model-index";
import { useModelIndexes } from "@/lib/data/use-model-index";
import { useViewerStore } from "@/lib/store";
import { downloadCsv } from "@/lib/utils/download";
import { formatCount, prettyCategory } from "@/lib/utils/format";
import { ElementList } from "../ElementList";
import { ResultActions } from "../ResultActions";

const SEVERITY: Record<Severity, { label: string; color: string; icon: ReactNode; rank: number }> = {
  critical: { label: "Critical", color: "var(--status-critical)", icon: <AlertOctagon size={14} />, rank: 0 },
  serious: { label: "Serious", color: "var(--status-serious)", icon: <CircleAlert size={14} />, rank: 1 },
  warning: { label: "Warning", color: "var(--status-warning)", icon: <AlertTriangle size={14} />, rank: 2 },
  info: { label: "Note", color: "var(--series-other)", icon: <Info size={14} />, rank: 3 },
};

export function ChecksPanel() {
  const hasModels = useViewerStore((state) => state.models.length > 0);
  const state = useModelIndexes(hasModels);
  return (
    <IndexGate state={state} hasModels={hasModels} emptyHint="Open a model to check how complete and consistent its data is: spatial structure, property sets, materials, GlobalIds, duplicates and more.">
      <ChecksBody indexes={state.indexes} />
    </IndexGate>
  );
}

function ChecksBody({ indexes }: { indexes: ModelIndex[] }) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [progress, setProgress] = useState<{ fraction: number; stage: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  // A new set of models invalidates the previous report.
  useEffect(() => {
    setReport(null);
    setOpen(null);
    setError(null);
  }, [indexes]);

  const run = async () => {
    setError(null);
    setProgress({ fraction: 0, stage: "Starting" });
    try {
      setReport(await runHealthChecks(indexes, (fraction, stage) => setProgress({ fraction, stage })));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProgress(null);
    }
  };

  const ordered = useMemo(() => {
    if (!report) return [];
    return [...report.checks].sort((a, b) => {
      const aFail = a.failCount > 0 ? 0 : 1;
      const bFail = b.failCount > 0 ? 0 : 1;
      return aFail - bFail || SEVERITY[a.severity].rank - SEVERITY[b.severity].rank || b.failCount - a.failCount;
    });
  }, [report]);

  const exportReport = async () => {
    if (!report) return;
    const rows: (string | number)[][] = [];
    for (const check of report.checks) {
      if (check.failCount === 0) {
        rows.push([check.title, SEVERITY[check.severity].label, 0, check.scope, "", "", "", ""]);
        continue;
      }
      for (const [modelId, ids] of Object.entries(check.failing)) {
        const index = indexes.find((candidate) => candidate.modelId === modelId);
        if (!index) continue;
        const [names, guids] = await Promise.all([index.names(ids), index.model.getGuidsByLocalIds(ids)]);
        ids.forEach((id, position) => {
          rows.push([check.title, SEVERITY[check.severity].label, check.failCount, check.scope, modelId, guids[position] ?? "", prettyCategory(index.category(index.rowOf(id))), names.get(id) ?? ""]);
        });
      }
    }
    downloadCsv(["Check", "Severity", "Failing", "Checked", "Model", "GlobalId", "Class", "Name"], rows, "model-health-report.csv");
  };

  if (progress) {
    return (
      <div className="p-3">
        <div className="mb-1.5 flex justify-between text-[12px] text-fg-2">
          <span>Checking the model</span>
          <span className="tabular text-fg-3">{Math.round(progress.fraction * 100)}%</span>
        </div>
        <ProgressBar value={progress.fraction} />
        <div className="mt-1.5 text-[11.5px] text-fg-3">{progress.stage}</div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="p-3">
        <p className="text-[12px] leading-relaxed text-fg-2">
          Runs a set of data-quality rules over every loaded model and infers a few facts about it (discipline, authoring tool, extents). Each finding lists the affected elements so you can select them in 3D.
        </p>
        <Button variant="primary" className="mt-3" icon={<Play size={13} />} onClick={() => void run()}>
          Run checks
        </Button>
        {error ? <p className="mt-2 text-[12px] text-bad">{error}</p> : null}
      </div>
    );
  }

  const findings = report.checks.filter((check) => check.failCount > 0 && check.severity !== "info").length;
  const scoreTone = report.score >= 85 ? "var(--status-good)" : report.score >= 60 ? "var(--status-warning)" : "var(--status-critical)";
  const scoreWord = report.score >= 85 ? "Good" : report.score >= 60 ? "Needs attention" : "Poor";

  return (
    <div className="flex h-full flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-line p-3">
          <div className="flex items-end gap-3">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-fg-3">Data health</div>
              <div className="flex items-baseline gap-1">
                <span className="text-[40px] font-semibold leading-none text-fg">{report.score}</span>
                <span className="text-[13px] text-fg-3">/ 100</span>
              </div>
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-fg">
                <span aria-hidden className="size-2 rounded-full" style={{ background: scoreTone }} />
                {scoreWord}
              </div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-fg-3">
                {findings === 0 ? "No findings" : `${findings} finding${findings === 1 ? "" : "s"}`} across {formatCount(report.elementCount)} elements. Notes do not affect the score.
              </div>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            {report.insights.map((insight) => (
              <div key={insight.label} className="contents">
                <dt className="text-[11.5px] text-fg-3">{insight.label}</dt>
                <dd className="min-w-0 text-[12px] text-fg">
                  <div className="break-words">{insight.value}</div>
                  {insight.hint ? <div className="text-[11px] leading-snug text-fg-3">{insight.hint}</div> : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <ul>
          {ordered.map((check) => (
            <CheckRow key={check.id} check={check} open={open === check.id} onToggle={() => setOpen(open === check.id ? null : check.id)} indexes={indexes} />
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-line p-3">
        <Button size="sm" icon={<RefreshCw size={12} />} onClick={() => void run()}>
          Run again
        </Button>
        <Button size="sm" icon={<Download size={12} />} onClick={() => void exportReport()}>
          Report CSV
        </Button>
      </div>
    </div>
  );
}

function CheckRow({ check, open, onToggle, indexes }: { check: CheckResult; open: boolean; onToggle: () => void; indexes: ModelIndex[] }) {
  const passed = check.failCount === 0;
  const severity = SEVERITY[check.severity];
  const share = check.scope > 0 ? check.failCount / check.scope : 0;
  return (
    <li className="border-b border-line/70">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-2">
        <span className="mt-px shrink-0" style={{ color: passed ? "var(--status-good)" : severity.color }} aria-hidden>
          {passed ? <CheckCircle2 size={14} /> : severity.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 text-[12.5px] font-medium text-fg">{check.title}</span>
            <span className="tabular shrink-0 text-[11.5px] text-fg-2">
              {passed ? "0" : formatCount(check.failCount)}
              <span className="text-fg-3"> / {formatCount(check.scope)}</span>
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-3">
            <span>{passed ? "Passed" : severity.label}</span>
            {!passed && share > 0 ? <span className="tabular">· {share < 0.001 ? "<0.1" : (share * 100).toFixed(share < 0.1 ? 1 : 0)}% of checked elements</span> : null}
          </span>
          {/* Meter: share of checked elements that fail. The track is a quiet step of the surface. */}
          <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
            {!passed ? <span className="block h-full rounded-full" style={{ width: `${Math.max(1.5, share * 100)}%`, background: severity.color }} /> : null}
          </span>
        </span>
        <ChevronRight size={13} className={clsx("mt-0.5 shrink-0 text-fg-3 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="bg-surface-2/60 pb-2">
          <p className="px-3 pt-1 text-[12px] leading-relaxed text-fg-2">{check.description}</p>
          {check.detail && !passed ? <p className="px-3 pt-1 text-[11.5px] text-fg-3">{check.detail}</p> : null}
          {!passed ? (
            <>
              <div className="px-3 py-2">
                <ResultActions items={check.failing} />
              </div>
              <ElementList items={check.failing} indexes={indexes} className="mx-3 max-h-56 rounded-md border border-line bg-surface" />
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
