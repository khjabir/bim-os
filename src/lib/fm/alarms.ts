// Alarm rules on live points: above a high limit, below a low limit, a status
// value that means a fault, or no reading for too long. An alarm opens when
// its condition starts and closes when it ends; acknowledging is separate.

import type { Alarm, AlarmKind, Point } from "./types";

export interface AlarmChanges {
  opened: Alarm[];
  /** Ids of alarms that ended, with the time they ended. */
  closed: { id: string; end: number }[];
}

const none = (): AlarmChanges => ({ opened: [], closed: [] });

function open(point: Point, kind: AlarmKind, t: number, value?: number | string, limit?: number | string): Alarm {
  return { id: `${point.id}|${kind}|${t}`, pointId: point.id, assetId: point.assetId, kind, value, limit, start: t };
}

export function numeric(value: number | string | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** What a new reading changes: alarms that start, and alarms of this point that end (including "no data"). */
export function evaluateReading(point: Point, value: number | string, t: number, active: Alarm[]): AlarmChanges {
  const changes = none();
  const mine = active.filter((a) => a.pointId === point.id && a.end === undefined);
  const has = (kind: AlarmKind) => mine.find((a) => a.kind === kind);
  const end = (kind: AlarmKind) => {
    const a = has(kind);
    if (a) changes.closed.push({ id: a.id, end: t });
  };
  end("stale");
  const rule = point.rule;
  if (!rule) return changes;
  const n = numeric(value);
  if (rule.high !== undefined && n !== null) {
    if (n > rule.high) {
      if (!has("high")) changes.opened.push(open(point, "high", t, n, rule.high));
    } else end("high");
  }
  if (rule.low !== undefined && n !== null) {
    if (n < rule.low) {
      if (!has("low")) changes.opened.push(open(point, "low", t, n, rule.low));
    } else end("low");
  }
  if (rule.alarmValue !== undefined && rule.alarmValue !== "") {
    if (String(value).trim().toLowerCase() === rule.alarmValue.trim().toLowerCase()) {
      if (!has("state")) changes.opened.push(open(point, "state", t, value, rule.alarmValue));
    } else end("state");
  }
  return changes;
}

/** Points whose last reading is older than their rule allows get a "no data" alarm. */
export function evaluateStale(points: Point[], now: number, active: Alarm[]): AlarmChanges {
  const changes = none();
  const staleOpen = new Set(active.filter((a) => a.kind === "stale" && a.end === undefined).map((a) => a.pointId));
  for (const point of points) {
    const minutes = point.rule?.staleMinutes;
    if (!minutes || staleOpen.has(point.id)) continue;
    const last = point.lastAt ?? 0;
    if (last && now - last > minutes * 60000) changes.opened.push(open(point, "stale", now, undefined, `${minutes} min`));
  }
  return changes;
}

export function alarmText(alarm: Alarm, point?: Point): string {
  const unit = point?.unit ? ` ${point.unit}` : "";
  switch (alarm.kind) {
    case "high":
      return `High: ${alarm.value}${unit} (limit ${alarm.limit}${unit})`;
    case "low":
      return `Low: ${alarm.value}${unit} (limit ${alarm.limit}${unit})`;
    case "state":
      return `Status: ${alarm.value}`;
    case "stale":
      return `No data for ${alarm.limit}`;
  }
}
