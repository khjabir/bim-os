"use client";

import clsx from "clsx";
import { EyeOff, Focus, Palette, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IndexGate } from "@/components/ui/IndexGate";
import { Button, FieldLabel, Input, Select, Spinner } from "@/components/ui/primitives";
import { FACET_LABEL, groupElements, type ElementGroup, type GroupFacet } from "@/lib/analysis/grouping";
import type { ModelIndex } from "@/lib/data/model-index";
import { useModelIndexes } from "@/lib/data/use-model-index";
import { useEngine } from "@/lib/engine/context";
import { useViewerStore } from "@/lib/store";
import { formatCount } from "@/lib/utils/format";
import { SERIES_SLOTS, seriesColor, seriesVar } from "@/lib/utils/palette";

const FACETS: GroupFacet[] = ["class", "storey", "type", "material", "classification", "model", "property"];

export function GroupsPanel() {
  const hasModels = useViewerStore((state) => state.models.length > 0);
  const state = useModelIndexes(hasModels);
  return (
    <IndexGate state={state} hasModels={hasModels} emptyHint="Open a model to group its elements by class, storey, type, material or any property, and colour the 3D view by group.">
      <GroupsBody indexes={state.indexes} />
    </IndexGate>
  );
}

function GroupsBody({ indexes }: { indexes: ModelIndex[] }) {
  const engine = useEngine();
  const models = useViewerStore((state) => state.models);
  const [facet, setFacet] = useState<GroupFacet>("class");
  const [setName, setSetName] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [groups, setGroups] = useState<ElementGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [colored, setColored] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const token = useRef(0);

  const modelNames = useMemo(() => Object.fromEntries(models.map((model) => [model.id, model.name])), [models]);

  useEffect(() => {
    if (facet === "property" && !propertyName.trim()) {
      setGroups(null);
      return;
    }
    const run = ++token.current;
    const timer = setTimeout(
      () => {
        setBusy(true);
        setError(null);
        groupElements(indexes, facet, { property: { set: setName.trim() || undefined, name: propertyName.trim() }, modelNames })
          .then((result) => {
            if (run === token.current) setGroups(result);
          })
          .catch((reason: unknown) => {
            if (run === token.current) setError(reason instanceof Error ? reason.message : String(reason));
          })
          .finally(() => {
            if (run === token.current) setBusy(false);
          });
      },
      facet === "property" ? 450 : 0,
    );
    return () => clearTimeout(timer);
  }, [indexes, facet, setName, propertyName, modelNames]);

  // The eight largest groups get the eight categorical colours; the rest share "Other".
  // Slots are tied to the group, so they stay put while the grouping is unchanged.
  const slots = useMemo(() => {
    const map = new Map<string, number>();
    (groups ?? []).forEach((group, index) => map.set(group.key, index < SERIES_SLOTS ? index : -1));
    return map;
  }, [groups]);

  // Leaving the panel or changing the grouping removes the colour overlay.
  useEffect(() => {
    setColored(false);
    setActive(null);
  }, [facet, setName, propertyName]);
  useEffect(() => {
    return () => {
      void engine?.resetColors();
    };
  }, [engine]);

  const applyColors = async () => {
    if (!engine || !groups) return;
    await engine.resetColors();
    // "Other" first so that multi-membership (materials) ends on a named colour.
    const ordered = [...groups].sort((a, b) => (slots.get(a.key) === -1 ? -1 : 0) - (slots.get(b.key) === -1 ? -1 : 0));
    for (const group of ordered) await engine.colorize(group.items, seriesColor(slots.get(group.key) ?? -1));
    setColored(true);
  };
  const clearColors = async () => {
    await engine?.resetColors();
    setColored(false);
  };

  const total = groups?.reduce((sum, group) => sum + group.count, 0) ?? 0;
  const max = groups?.[0]?.count ?? 1;
  const overflow = (groups?.length ?? 0) > SERIES_SLOTS;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-3">
        <FieldLabel htmlFor="group-facet">Group by</FieldLabel>
        <Select id="group-facet" value={facet} onChange={(event) => setFacet(event.target.value as GroupFacet)}>
          {FACETS.map((value) => (
            <option key={value} value={value}>
              {FACET_LABEL[value]}
            </option>
          ))}
        </Select>
        {facet === "property" ? (
          <div className="mt-2 flex flex-col gap-1.5">
            <Input placeholder="Set name (optional), e.g. Pset_WallCommon" value={setName} onChange={(event) => setSetName(event.target.value)} aria-label="Property set name" />
            <Input placeholder="Property name, e.g. FireRating" value={propertyName} onChange={(event) => setPropertyName(event.target.value)} aria-label="Property name" />
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {colored ? (
            <Button size="sm" icon={<RotateCcw size={12} />} onClick={() => void clearColors()}>
              Remove colours
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={<Palette size={12} />} disabled={!groups || groups.length === 0} onClick={() => void applyColors()}>
              Colour 3D view
            </Button>
          )}
        </div>
        {overflow ? (
          <p className="mt-2 text-[11.5px] leading-relaxed text-fg-3">
            The eight largest groups get their own colour; the other {formatCount((groups?.length ?? 0) - SERIES_SLOTS)} share grey so colours stay distinguishable.
          </p>
        ) : null}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {error ? <div className="p-3 text-[12px] text-bad">{error}</div> : null}
        {busy && !groups ? (
          <div className="flex items-center gap-2 p-3 text-[12px] text-fg-3">
            <Spinner /> Grouping…
          </div>
        ) : null}
        {facet === "property" && !propertyName.trim() ? <p className="p-3 text-[12px] text-fg-3">Enter a property name to group by its values.</p> : null}
        {groups && groups.length > 0 ? (
          <>
            <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[11.5px] text-fg-3">
              <span>
                {formatCount(groups.length)} group{groups.length === 1 ? "" : "s"}
              </span>
              <span className="tabular">{formatCount(total)} assignments</span>
            </div>
            <ul>
              {groups.map((group) => {
                const slot = slots.get(group.key) ?? -1;
                return (
                  <li key={group.key} className={clsx("group border-t border-line/70", active === group.key && "bg-accent-soft")}>
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: seriesVar(slot) }} />
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        title="Click to select this group"
                        onClick={() => {
                          setActive(group.key);
                          void engine?.select(group.items);
                        }}
                      >
                        <div className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{group.label}</span>
                          <span className="tabular shrink-0 text-[11.5px] text-fg-2">{formatCount(group.count)}</span>
                        </div>
                        <div className="mt-1 h-1 w-full rounded-full bg-surface-3">
                          <div className="h-full rounded-full bg-[var(--series-other)]" style={{ width: `${Math.max(2, (group.count / max) * 100)}%` }} />
                        </div>
                      </button>
                      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <button type="button" title="Isolate" aria-label={`Isolate ${group.label}`} className="grid size-5 place-items-center rounded text-fg-3 hover:bg-surface-3 hover:text-fg" onClick={() => void engine?.isolate(group.items)}>
                          <Focus size={12} />
                        </button>
                        <button type="button" title="Hide" aria-label={`Hide ${group.label}`} className="grid size-5 place-items-center rounded text-fg-3 hover:bg-surface-3 hover:text-fg" onClick={() => void engine?.hide(group.items)}>
                          <EyeOff size={12} />
                        </button>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
        {groups && groups.length === 0 ? <p className="p-3 text-[12px] text-fg-3">No groups found.</p> : null}
      </div>
    </div>
  );
}
