// Maintenance scheduling: plans from the task library and the model's own
// maintenance data, due dates, calendar occurrences and work orders to raise.
// Dates are local calendar dates written "YYYY-MM-DD".

import { parseDuration } from "../convert/assets/fields";
import { tasksForKind } from "./tasks";
import type { Asset, Plan, TaskTemplate, Unit, WorkOrder } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayIso(): string {
  return isoDate(new Date());
}

export function parseIso(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(date: string, days: number): string {
  const d = parseIso(date);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

/** The date `every` units after `date`; month steps keep the day of month where it exists (31 Jan + 1 month = 28/29 Feb). */
export function addInterval(date: string, every: number, unit: Unit): string {
  const d = parseIso(date);
  if (unit === "day") d.setDate(d.getDate() + every);
  else if (unit === "week") d.setDate(d.getDate() + every * 7);
  else {
    const months = unit === "year" ? every * 12 : every;
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  }
  return isoDate(d);
}

export function intervalDays(every: number, unit: Unit): number {
  return every * { day: 1, week: 7, month: 30.4375, year: 365.25 }[unit];
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / 86400000);
}

/** A stable number from text (FNV-1a), to spread first due dates. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A model's maintenance interval ("Quarterly", "6 Months", 12 with a unit) as a plan interval, or null. */
export function modelInterval(frequency: string, unit: string): { every: number; unit: Unit } | null {
  const d = parseDuration(unit && /^\d+(?:[.,]\d+)?$/.test(frequency.trim()) ? `${frequency} ${unit}` : frequency);
  if (!d || !(d.value > 0)) return null;
  switch (d.unit) {
    case "year":
      return Number.isInteger(d.value) ? { every: d.value, unit: "year" } : { every: Math.max(1, Math.round(d.value * 12)), unit: "month" };
    case "month":
      return { every: Math.max(1, Math.round(d.value)), unit: "month" };
    case "week":
      return { every: Math.max(1, Math.round(d.value)), unit: "week" };
    case "day":
      return { every: Math.max(1, Math.round(d.value)), unit: "day" };
    case "hour":
    case "minute":
      return { every: 1, unit: "day" };
    default:
      return null;
  }
}

export interface PlanOptions {
  /** First day plans can fall due. */
  start: string;
  /** Kind codes to plan for (all the library covers when absent). */
  kinds?: Set<string>;
  /** Spread first due dates over the first interval, so a thousand detectors are not all due on one day. */
  spread: boolean;
  /** Add plans for maintenance tasks and frequencies the model itself carries. */
  fromModel: boolean;
}

/** Maintenance plans for assets: one per asset and task. */
export function plansForAssets(assets: Asset[], tasks: TaskTemplate[], options: PlanOptions): Plan[] {
  const plans: Plan[] = [];
  const firstDue = (assetId: string, taskId: string, every: number, unit: Unit) => {
    if (!options.spread) return options.start;
    const window = Math.max(1, Math.min(365, Math.floor(intervalDays(every, unit))));
    return addDays(options.start, hash(`${assetId}|${taskId}`) % window);
  };
  for (const asset of assets) {
    if (options.kinds && !options.kinds.has(asset.kindCode)) continue;
    for (const task of tasksForKind(tasks, asset.kindCode)) {
      const nextDue = firstDue(asset.id, task.id, task.every, task.unit);
      plans.push({
        id: `${asset.id}|${task.id}`,
        assetId: asset.id,
        taskId: task.id,
        title: task.title,
        every: task.every,
        unit: task.unit,
        start: nextDue,
        nextDue,
        active: true,
        source: "library",
        statutory: task.statutory,
        minutes: task.minutes,
        trade: task.trade,
      });
    }
    if (options.fromModel) {
      const frequency = asset.edits?.ppmFrequency?.value ?? asset.values.ppmFrequency ?? "";
      const interval = frequency ? modelInterval(frequency, asset.edits?.ppmFrequencyUnit?.value ?? asset.values.ppmFrequencyUnit ?? "") : null;
      if (interval) {
        const title = asset.edits?.ppmTask?.value ?? asset.values.ppmTask ?? "";
        const nextDue = firstDue(asset.id, "model", interval.every, interval.unit);
        plans.push({
          id: `${asset.id}|model`,
          assetId: asset.id,
          taskId: "model",
          title: title || `Planned maintenance (${asset.kind.toLowerCase()})`,
          every: interval.every,
          unit: interval.unit,
          start: nextDue,
          nextDue,
          active: true,
          source: "model",
        });
      }
    }
  }
  return plans;
}

export type DueState = "overdue" | "due" | "scheduled" | "inactive";

/** Overdue before today; due within `soonDays`; otherwise scheduled. */
export function dueState(plan: Plan, today: string, soonDays = 14): DueState {
  if (!plan.active) return "inactive";
  const d = daysBetween(today, plan.nextDue);
  return d < 0 ? "overdue" : d <= soonDays ? "due" : "scheduled";
}

/** Due dates of a plan from `from` to `to` (inclusive): the next due date and those after it. An overdue date is kept on its own day. */
export function occurrences(plan: Plan, from: string, to: string, max = 400): string[] {
  if (!plan.active) return [];
  const out: string[] = [];
  let date = plan.nextDue;
  for (let i = 0; i < max && date <= to; i++) {
    if (date >= from) out.push(date);
    date = addInterval(date, plan.every, plan.unit);
  }
  return out;
}

/** The plan after its task was done on `date`: the next one falls an interval later. */
export function completePlan(plan: Plan, date: string): Plan {
  return { ...plan, lastDone: date, nextDue: addInterval(date, plan.every, plan.unit) };
}

const OPEN: WorkOrder["status"][] = ["open", "in-progress", "on-hold"];

export function isOpen(wo: WorkOrder): boolean {
  return OPEN.includes(wo.status);
}

/** Active plans due by `until` that have no open work order yet. */
export function plansToRaise(plans: Plan[], workOrders: WorkOrder[], until: string): Plan[] {
  const raised = new Set(workOrders.filter(isOpen).map((w) => w.planId).filter(Boolean));
  return plans.filter((p) => p.active && p.nextDue <= until && !raised.has(p.id)).sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.id.localeCompare(b.id));
}
