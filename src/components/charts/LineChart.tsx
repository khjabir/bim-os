"use client";

// Readings over time: one series, a 2px line with a light wash under it,
// hairline grid, the alarm limits as labelled reference lines, and a
// crosshair that snaps to the nearest reading with its value and time.
// Sparkline: the same in a row's corner, no axes.

import { useMemo, useRef, useState } from "react";

export interface LinePoint {
  t: number;
  v: number;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

const fmtValue = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 10 ? 2 : 1 }));

function fmtTime(t: number, span: number): string {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (span < 86400000 * 1.5) return hm;
  return `${d.getDate()}/${d.getMonth() + 1} ${hm}`;
}

export function LineChart({ title, data, unit = "", limits = [], height = 180 }: { title: string; data: LinePoint[]; unit?: string; limits?: { label: string; value: number }[]; height?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;
  const pad = { l: 44, r: 12, t: 10, b: 22 };
  const geom = useMemo(() => {
    if (data.length === 0) return null;
    const t0 = data[0].t;
    const t1 = data[data.length - 1].t;
    let lo = Math.min(...data.map((d) => d.v), ...limits.map((l) => l.value));
    let hi = Math.max(...data.map((d) => d.v), ...limits.map((l) => l.value));
    const margin = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
    lo -= margin;
    hi += margin;
    const ticks = niceTicks(lo, hi);
    if (ticks.length) {
      lo = Math.min(lo, ticks[0]);
      hi = Math.max(hi, ticks[ticks.length - 1]);
    }
    const x = (t: number) => pad.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (width - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (height - pad.t - pad.b);
    const path = data.map((d, i) => `${i ? "L" : "M"}${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join("");
    const area = `${path}L${x(t1).toFixed(1)},${height - pad.b}L${x(t0).toFixed(1)},${height - pad.b}Z`;
    const timeTicks = [0, 0.5, 1].map((f) => t0 + f * (t1 - t0));
    return { x, y, path, area, ticks, timeTicks, span: t1 - t0 };
  }, [data, limits, height, pad.b, pad.l, pad.r, pad.t]);

  if (!geom) return <p className="py-6 text-center text-[12px] text-fg-3">No readings yet.</p>;
  const h = hover !== null ? data[hover] : null;

  const onMove = (e: React.PointerEvent) => {
    const svg = ref.current;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    // Nearest reading by time.
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < data.length; i++) {
      const gap = Math.abs(geom.x(data[i].t) - px);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    setHover(best);
  };

  return (
    <figure className="relative">
      <figcaption className="sr-only">{title}</figcaption>
      <svg
        ref={ref}
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full touch-none select-none"
        role="img"
        aria-label={`${title}: ${data.length} readings, latest ${fmtValue(data[data.length - 1].v)}${unit ? ` ${unit}` : ""}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {geom.ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={width - pad.r} y1={geom.y(v)} y2={geom.y(v)} stroke="var(--chart-grid)" strokeWidth={1} />
            <text x={pad.l - 6} y={geom.y(v)} dy="0.32em" textAnchor="end" fontSize={10.5} fill="var(--fg-3)" className="tabular">
              {fmtValue(v)}
            </text>
          </g>
        ))}
        {geom.timeTicks.map((t, i) => (
          <text key={i} x={geom.x(t)} y={height - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fontSize={10.5} fill="var(--fg-3)">
            {fmtTime(t, geom.span)}
          </text>
        ))}
        {limits.map((l) => (
          <g key={l.label}>
            <line x1={pad.l} x2={width - pad.r} y1={geom.y(l.value)} y2={geom.y(l.value)} stroke="var(--status-critical)" strokeWidth={1} opacity={0.8} />
            <text x={width - pad.r} y={geom.y(l.value) - 4} textAnchor="end" fontSize={10.5} fill="var(--fg-2)">
              {l.label} {fmtValue(l.value)}
              {unit ? ` ${unit}` : ""}
            </text>
          </g>
        ))}
        <path d={geom.area} fill="var(--series-1)" opacity={0.1} />
        <path d={geom.path} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={geom.x(data[data.length - 1].t)} cy={geom.y(data[data.length - 1].v)} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
        {h ? (
          <g pointerEvents="none">
            <line x1={geom.x(h.t)} x2={geom.x(h.t)} y1={pad.t} y2={height - pad.b} stroke="var(--fg-3)" strokeWidth={1} />
            <circle cx={geom.x(h.t)} cy={geom.y(h.v)} r={4.5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        ) : null}
      </svg>
      {h ? (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-line bg-surface px-2 py-1 text-[11.5px] shadow-pop"
          style={{ left: `${Math.min(78, Math.max(2, (geom.x(h.t) / width) * 100 - 8))}%` }}
        >
          <div className="font-semibold text-fg">
            {fmtValue(h.v)}
            {unit ? ` ${unit}` : ""}
          </div>
          <div className="text-fg-3">{new Date(h.t).toLocaleString()}</div>
        </div>
      ) : null}
    </figure>
  );
}

/** A row-sized trend: de-emphasised line, the latest reading in the accent. */
export function Sparkline({ values, width = 88, height = 24, label }: { values: number[]; width?: number; height?: number; label?: string }) {
  if (values.length < 2) return <span className="inline-block text-[11px] text-fg-3" style={{ width }} />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = (i: number) => 3 + (i / (values.length - 1)) * (width - 6);
  const y = (v: number) => 3 + (1 - (v - lo) / (hi - lo || 1)) * (height - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = values[values.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? `Trend, latest ${fmtValue(last)}`} className="shrink-0">
      <title>{label ?? `Latest ${fmtValue(last)}, range ${fmtValue(lo)} to ${fmtValue(hi)}`}</title>
      <path d={d} fill="none" stroke="var(--series-other)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(last)} r={2.5} fill="var(--series-1)" />
    </svg>
  );
}
