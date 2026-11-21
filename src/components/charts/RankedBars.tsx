"use client";

import clsx from "clsx";
import { useState } from "react";

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  /** Optional second line in the tooltip, e.g. "128 elements". */
  note?: string;
  /** Rendered in the neutral "Other" colour (the folded tail). */
  muted?: boolean;
}

interface RankedBarsProps {
  title: string;
  unit?: string;
  data: BarDatum[];
  format: (value: number) => string;
  /** Rows beyond this many are folded into a single "Other" bar. */
  maxRows?: number;
  onPick?: (datum: BarDatum) => void;
}

const VALUE_COLUMN = 68;

/**
 * Ranked horizontal bars: one hue, largest first, value at the bar tip.
 * Used where the job is comparing a magnitude across named groups. The table
 * under the chart is its table view, so the tooltip never gates a value.
 */
export function RankedBars({ title, unit, data, format, maxRows = 10, onPick }: RankedBarsProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const sorted = [...data].filter((datum) => Number.isFinite(datum.value) && datum.value > 0).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, datum) => sum + datum.value, 0);
  let rows = sorted;
  if (sorted.length > maxRows) {
    const head = sorted.slice(0, maxRows - 1);
    const tail = sorted.slice(maxRows - 1);
    rows = [
      ...head,
      { key: "__other", label: `Other (${tail.length} groups)`, value: tail.reduce((sum, datum) => sum + datum.value, 0), muted: true },
    ];
  }
  const max = rows.reduce((value, datum) => Math.max(value, datum.value), 0) || 1;

  if (rows.length === 0) {
    return (
      <figure className="px-3 py-3">
        <figcaption className="text-[12px] font-semibold text-fg">{title}</figcaption>
        <p className="mt-2 text-[12px] text-fg-3">No values to chart for this measure.</p>
      </figure>
    );
  }

  return (
    <figure className="px-3 py-3">
      <figcaption className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-fg">{title}</span>
        {unit ? <span className="text-[11px] text-fg-3">{unit}</span> : null}
      </figcaption>
      <ol className="flex flex-col gap-[3px]">
        {rows.map((datum) => {
          const share = total > 0 ? datum.value / total : 0;
          const interactive = Boolean(onPick) && datum.key !== "__other";
          const active = hovered === datum.key;
          return (
            <li key={datum.key} className="relative">
              <button
                type="button"
                disabled={!interactive}
                onClick={() => interactive && onPick?.(datum)}
                onPointerEnter={() => setHovered(datum.key)}
                onPointerLeave={() => setHovered((current) => (current === datum.key ? null : current))}
                onFocus={() => setHovered(datum.key)}
                onBlur={() => setHovered((current) => (current === datum.key ? null : current))}
                aria-label={`${datum.label}: ${format(datum.value)}${unit ? ` ${unit}` : ""}, ${(share * 100).toFixed(1)} percent of the total`}
                className={clsx(
                  "grid w-full grid-cols-[minmax(0,36%)_minmax(0,1fr)] items-center gap-2 rounded py-[3px] text-left",
                  interactive ? "cursor-pointer" : "cursor-default",
                  active && "bg-surface-2",
                )}
              >
                <span className="truncate pl-1 text-[11.5px] text-fg-2">{datum.label}</span>
                <span className="flex min-w-0 items-center">
                  <span
                    aria-hidden
                    className="h-[10px] shrink-0 rounded-r-[4px]"
                    style={{
                      // The value label needs room past the longest bar.
                      width: `max(2px, calc((100% - ${VALUE_COLUMN}px) * ${datum.value / max}))`,
                      background: datum.muted ? "var(--series-other)" : "var(--series-1)",
                      filter: active ? "brightness(1.12)" : undefined,
                    }}
                  />
                  <span className="tabular ml-1.5 whitespace-nowrap text-[11.5px] font-medium text-fg">{format(datum.value)}</span>
                </span>
              </button>
              {active ? (
                <div role="tooltip" className="pointer-events-none absolute right-1 top-full z-20 mt-0.5 min-w-[150px] rounded-md border border-line bg-surface px-2.5 py-1.5 shadow-pop">
                  <div className="tabular text-[13px] font-semibold text-fg">
                    {format(datum.value)}
                    {unit ? <span className="ml-1 text-[11px] font-normal text-fg-3">{unit}</span> : null}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-2">
                    <span aria-hidden className="h-[3px] w-3 rounded-full" style={{ background: datum.muted ? "var(--series-other)" : "var(--series-1)" }} />
                    <span className="min-w-0 truncate">{datum.label}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-fg-3">
                    {(share * 100).toFixed(1)}% of total{datum.note ? ` · ${datum.note}` : ""}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
