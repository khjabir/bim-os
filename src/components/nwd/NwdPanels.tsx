"use client";

import clsx from "clsx";
import { ArrowUpRight, Download, Eye, EyeOff, FileOutput, Focus, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Section } from "@/components/ui/Section";
import { Button, Callout, Input, ProgressBar, Segmented, Select, Spinner } from "@/components/ui/primitives";
import { handOffFiles } from "@/lib/handoff";
import { ExportCancelled, type ExportResult, type LmvSession, type ObjectGroup, type PickLevel, type PropertyKey } from "@/lib/lmv/session";
import { useNwdStore } from "@/lib/nwd/store";
import { pushToast } from "@/lib/store";
import { downloadBlob } from "@/lib/utils/download";
import { baseName, formatBytes, formatCount, prettyCategory, sanitizeFileName } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// Selection

export function SelectionSection({ session }: { session: LmvSession }) {
  const selection = useNwdStore((state) => state.selection);
  const pickLevel = useNwdStore((state) => state.pickLevel);
  const count = selection.length;
  const sample = useMemo(() => selection.slice(0, 3).map((id) => session.name(id)), [selection, session]);

  return (
    <Section title="Selection" count={count > 0 ? formatCount(count) : undefined}>
      <div className="px-3">
        {count === 0 ? (
          <p className="text-[12px] leading-relaxed text-fg-3">Click objects in the 3D view (Ctrl or Cmd-click adds), or pick a group below. The viewer&apos;s own toolbar has a model browser for picking by tree.</p>
        ) : (
          <p className="break-words text-[12px] leading-relaxed text-fg-2">
            {sample.join(", ")}
            {count > sample.length ? ` and ${formatCount(count - sample.length)} more` : ""}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" icon={<Focus size={12} />} disabled={count === 0} onClick={() => session.fit(selection)}>
            Zoom
          </Button>
          <Button size="sm" icon={<Eye size={12} />} disabled={count === 0} onClick={() => session.isolate(selection)}>
            Isolate
          </Button>
          <Button size="sm" icon={<EyeOff size={12} />} disabled={count === 0} onClick={() => session.hide(selection)}>
            Hide
          </Button>
          <Button
            size="sm"
            onClick={() => {
              session.showAll();
              session.fit();
            }}
          >
            Show all
          </Button>
          <Button size="sm" variant="ghost" icon={<X size={12} />} disabled={count === 0} onClick={() => session.clearSelection()}>
            Clear
          </Button>
        </div>
        <div className="mt-2.5">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-fg-3">A click selects</div>
          <Segmented<PickLevel>
            className="w-full"
            value={pickLevel}
            onChange={(value) => {
              useNwdStore.setState({ pickLevel: value });
              session.setPickLevel(value);
            }}
            options={[
              { value: "part", label: "Part", title: "The smallest piece under the cursor" },
              { value: "object", label: "Object", title: "The object the piece belongs to" },
              { value: "top", label: "Assembly", title: "The top-level object it belongs to" },
            ]}
          />
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Groups

const TREE_LEVELS = [1, 2, 3, 4];
const MAX_GROUP_ROWS = 400;

export function GroupsSection({ session }: { session: LmvSession }) {
  const [facet, setFacet] = useState("tree:1");
  const [keys, setKeys] = useState<PropertyKey[] | null>(null);
  const [groups, setGroups] = useState<ObjectGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const selection = useNwdStore((state) => state.selection);
  const selected = useMemo(() => new Set(selection), [selection]);

  useEffect(() => {
    let cancelled = false;
    setKeys(null);
    void session.propertyKeys().then((found) => {
      if (!cancelled) setKeys(found);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setProgress(undefined);
    (async () => {
      const result = facet.startsWith("tree:") ? session.groupByTreeLevel(Number(facet.slice(5))) : await session.groupByProperty(facet.slice(5), (fraction) => !cancelled && setProgress(fraction));
      if (!cancelled) {
        setGroups(result);
        setBusy(false);
      }
    })().catch(() => {
      if (!cancelled) {
        setGroups([]);
        setBusy(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [facet, session]);

  const total = groups.reduce((sum, group) => sum + group.ids.length, 0);
  const largest = groups[0]?.ids.length ?? 1;
  const byCategory = useMemo(() => {
    const map = new Map<string, PropertyKey[]>();
    for (const key of keys ?? []) {
      const list = map.get(key.category) ?? [];
      if (!map.has(key.category)) map.set(key.category, list);
      list.push(key);
    }
    return [...map.entries()];
  }, [keys]);

  const runSearch = async () => {
    if (!query.trim() || searching) return;
    setSearching(true);
    const found = await session.search(query);
    setSearching(false);
    if (found.length === 0) pushToast("info", `Nothing matches “${query.trim()}”.`);
    else {
      session.select(found);
      session.fit(found);
    }
  };

  return (
    <Section title="Groups" count={groups.length > 0 && !busy ? formatCount(groups.length) : undefined}>
      <div className="px-3">
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find by name or property value" aria-label="Find objects" />
          <Button type="submit" icon={searching ? undefined : <Search size={13} />} busy={searching} disabled={!query.trim()}>
            Find
          </Button>
        </form>
        <label className="mb-1 mt-2.5 block text-[11px] font-medium uppercase tracking-wide text-fg-3" htmlFor="nwd-group-by">
          Group by
        </label>
        <Select id="nwd-group-by" value={facet} onChange={(event) => setFacet(event.target.value)}>
          <optgroup label="Model tree">
            {TREE_LEVELS.map((level) => (
              <option key={level} value={`tree:${level}`}>
                Tree level {level}
              </option>
            ))}
          </optgroup>
          {byCategory.map(([category, list]) => (
            <optgroup key={category} label={category || "Properties"}>
              {list.map((key) => (
                <option key={key.key} value={`prop:${key.key}`}>
                  {key.name}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        {keys === null ? <div className="mt-1 text-[11px] text-fg-3">Reading property names…</div> : null}
      </div>

      {busy ? (
        <div className="px-3 pt-2.5">
          <ProgressBar value={progress} />
          <div className="mt-1 text-[11.5px] text-fg-3">Grouping objects</div>
        </div>
      ) : (
        <ul className="mt-2 flex flex-col">
          {groups.slice(0, MAX_GROUP_ROWS).map((group) => {
            const active = group.ids.length > 0 && group.ids.every((id) => selected.has(id));
            return (
              <li key={group.label}>
                <button
                  type="button"
                  onClick={(event) => {
                    session.select(group.ids, event.ctrlKey || event.metaKey || event.shiftKey);
                    if (!(event.ctrlKey || event.metaKey || event.shiftKey)) session.fit(group.ids);
                  }}
                  title={`Select ${formatCount(group.ids.length)} object${group.ids.length === 1 ? "" : "s"} (Ctrl-click adds)`}
                  className={clsx("block w-full px-3 py-1 text-left transition-colors", active ? "bg-accent-soft" : "hover:bg-surface-2")}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-[12px] text-fg">{group.label}</span>
                    <span className="tabular shrink-0 text-[11.5px] text-fg-2">{formatCount(group.ids.length)}</span>
                  </span>
                  <span className="mt-1 block h-[3px] rounded-full bg-surface-3">
                    <span className="block h-full rounded-full bg-fg-3" style={{ width: `${Math.max(2, (group.ids.length / largest) * 100)}%` }} />
                  </span>
                </button>
              </li>
            );
          })}
          {groups.length > MAX_GROUP_ROWS ? <li className="px-3 py-1.5 text-[11.5px] text-fg-3">{formatCount(groups.length - MAX_GROUP_ROWS)} smaller groups not listed.</li> : null}
          {groups.length === 0 ? <li className="px-3 py-1.5 text-[12px] text-fg-3">No groups.</li> : null}
        </ul>
      )}
      {!busy && groups.length > 0 ? <div className="px-3 pt-1.5 text-[11px] text-fg-3">{formatCount(total)} objects in {formatCount(groups.length)} groups</div> : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Export

type Scope = "selection" | "visible" | "all";

interface Finished {
  result: ExportResult;
  fileName: string;
  elapsedMs: number;
}

export function ExportSection({ session }: { session: LmvSession }) {
  const router = useRouter();
  const selection = useNwdStore((state) => state.selection);
  const modelName = useNwdStore((state) => state.modelName);
  const summary = useNwdStore((state) => state.summary);
  const [scope, setScope] = useState<Scope>("selection");
  const [guessClasses, setGuessClasses] = useState(true);
  const [storeyProperty, setStoreyProperty] = useState("");
  const [levelKeys, setLevelKeys] = useState<PropertyKey[]>([]);
  const [running, setRunning] = useState<{ label: string; fraction: number; controller: AbortController } | null>(null);
  const [finished, setFinished] = useState<Finished | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the view's visibility may have changed, so the "visible" count is re-read.
  const [visibilityTick, setVisibilityTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void session.propertyKeys().then((keys) => {
      if (!cancelled) setLevelKeys(keys.filter((key) => /level|storey|story|floor/i.test(key.name)));
    });
    setFinished(null);
    setError(null);
    return () => {
      cancelled = true;
    };
  }, [session]);

  // With nothing selected, exporting the selection makes no sense: fall back to what is visible.
  const effectiveScope: Scope = scope === "selection" && selection.length === 0 ? "visible" : scope;
  const ids = useMemo(() => {
    void visibilityTick;
    return effectiveScope === "selection" ? selection : effectiveScope === "visible" ? session.visibleElements() : session.elements();
  }, [effectiveScope, selection, session, visibilityTick]);
  const triangles = useMemo(() => session.countTriangles(ids), [ids, session]);
  // Measured on exports: about 31 bytes per triangle after welding, plus the element and its properties.
  const estimate = triangles * 31 + ids.length * 1500;

  const run = async () => {
    if (running || ids.length === 0) return;
    const controller = new AbortController();
    const started = performance.now();
    const base = sanitizeFileName(baseName(modelName ?? "model"));
    const fileName = `${base}${effectiveScope === "all" ? "" : effectiveScope === "selection" ? "-selection" : "-visible"}.ifc`;
    setError(null);
    setFinished(null);
    setRunning({ label: "Reading geometry", fraction: 0, controller });
    try {
      const result = await session.exportIfc(
        ids,
        { fileName, projectName: base, guessClasses, storeyProperty: storeyProperty || null },
        (label, fraction) => setRunning({ label, fraction, controller }),
        controller.signal,
      );
      setFinished({ result, fileName, elapsedMs: performance.now() - started });
      downloadBlob(result.blob, fileName);
    } catch (reason) {
      if (!(reason instanceof ExportCancelled)) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(null);
    }
  };

  return (
    <Section title="Export IFC">
      <div className="px-3">
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="What to export" onPointerEnter={() => setVisibilityTick((value) => value + 1)}>
          <ScopeOption value="selection" current={effectiveScope} onChange={setScope} disabled={selection.length === 0} label="Selection" count={selection.length} />
          <ScopeOption value="visible" current={effectiveScope} onChange={setScope} label="Everything visible" count={effectiveScope === "visible" ? ids.length : undefined} />
          <ScopeOption value="all" current={effectiveScope} onChange={setScope} label="Whole model" count={summary?.elements} />
        </div>

        <label className="mt-2.5 flex cursor-pointer items-start gap-2">
          <input type="checkbox" checked={guessClasses} onChange={(event) => setGuessClasses(event.target.checked)} className="mt-[3px] size-3.5 shrink-0 accent-[var(--accent)]" />
          <span>
            <span className="block text-[12px] text-fg">Guess IFC classes from names</span>
            <span className="block text-[11px] leading-snug text-fg-3">Walls, doors, pipes and so on are recognised by category and object names. Everything else becomes a building element proxy.</span>
          </span>
        </label>

        {levelKeys.length > 0 ? (
          <div className="mt-2.5">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-fg-3" htmlFor="nwd-storey">
              Storeys from
            </label>
            <Select id="nwd-storey" value={storeyProperty} onChange={(event) => setStoreyProperty(event.target.value)}>
              <option value="">One storey for everything</option>
              {levelKeys.map((key) => (
                <option key={key.key} value={key.key}>
                  {key.category ? `${key.category} · ${key.name}` : key.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        <div className="mt-2.5 text-[11.5px] leading-snug text-fg-3">
          <span className="tabular">{formatCount(ids.length)}</span> object{ids.length === 1 ? "" : "s"} · <span className="tabular">{formatCount(triangles)}</span> triangles · about {formatBytes(estimate)}
        </div>
        {estimate > 400 * 1024 * 1024 ? (
          <Callout tone="warn" className="mt-2">
            This is a very large export. It can take several minutes and the browser may run out of memory; exporting a selection or one group at a time is safer.
          </Callout>
        ) : null}

        {running ? (
          <div className="mt-2.5">
            <div className="mb-1.5 flex justify-between text-[12px] text-fg-2">
              <span>{running.label}</span>
              <span className="tabular text-fg-3">{Math.round(running.fraction * 100)}%</span>
            </div>
            <ProgressBar value={running.fraction} />
            <Button size="sm" className="mt-2" onClick={() => running.controller.abort()}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="primary" className="mt-2.5 w-full" icon={<FileOutput size={14} />} disabled={ids.length === 0 || triangles === 0} onClick={() => void run()}>
            Export {effectiveScope === "selection" ? "selection" : effectiveScope === "visible" ? "visible objects" : "whole model"} as IFC
          </Button>
        )}
        {error ? <p className="mt-2 break-words text-[12px] text-bad">{error}</p> : null}

        {finished ? (
          <div className="mt-2.5 rounded-md border border-line bg-surface-2 p-2.5">
            <div className="break-words text-[12px] font-medium text-fg">{finished.fileName}</div>
            <div className="mt-0.5 text-[11.5px] leading-snug text-fg-2">
              <span className="tabular">{formatCount(finished.result.stats.elements)}</span> elements · <span className="tabular">{formatCount(finished.result.stats.triangles)}</span> triangles ·{" "}
              <span className="tabular">{formatCount(finished.result.stats.properties)}</span> properties · {formatBytes(finished.result.blob.size)}
            </div>
            <div className="mt-1 text-[11.5px] leading-snug text-fg-3">
              {Object.entries(finished.result.classes)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([ifcClass, count]) => `${prettyCategory(ifcClass)} ${formatCount(count)}`)
                .join(" · ")}
              {finished.result.skippedNoGeometry > 0 ? ` · ${formatCount(finished.result.skippedNoGeometry)} without surfaces left out` : ""}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" icon={<Download size={12} />} onClick={() => downloadBlob(finished.result.blob, finished.fileName)}>
                Download again
              </Button>
              <Button
                size="sm"
                icon={<ArrowUpRight size={12} />}
                onClick={() => {
                  handOffFiles([new File([finished.result.blob], finished.fileName, { type: "application/x-step" })]);
                  router.push("/ifc");
                }}
                title="Open the exported file in the IFC viewer to check and analyse it"
              >
                Open in IFC viewer
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function ScopeOption({ value, current, onChange, label, count, disabled }: { value: Scope; current: Scope; onChange: (value: Scope) => void; label: string; count?: number; disabled?: boolean }) {
  return (
    <label className={clsx("flex items-center gap-2", disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer")}>
      <input type="radio" name="nwd-export-scope" checked={current === value} disabled={disabled} onChange={() => onChange(value)} className="size-3.5 accent-[var(--accent)]" />
      <span className="text-[12px] text-fg">{label}</span>
      {count !== undefined ? <span className="tabular text-[11.5px] text-fg-3">{formatCount(count)}</span> : null}
    </label>
  );
}

/** Small status line used while the page uploads, translates or loads a model. */
export function BusyLine({ label, progress, onCancel }: { label: string; progress?: number; onCancel?: () => void }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px] text-fg-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Spinner size={13} />
          <span className="min-w-0 break-words">{label}</span>
        </span>
        {progress !== undefined ? <span className="tabular shrink-0 text-fg-3">{Math.round(progress * 100)}%</span> : null}
      </div>
      <ProgressBar value={progress} />
      {onCancel ? (
        <Button size="sm" className="mt-2" icon={<X size={12} />} onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}
