"use client";

// Building blocks shared by the facility pages: the page frame, the gate shown
// before a building is onboarded, tabs kept in the address, stat tiles,
// meters, status badges and a side panel.

import clsx from "clsx";
import { AlertTriangle, Building2, CheckCircle2, CircleDot, Clock, FileUp, Loader2, Pencil, Sparkles, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { DueState } from "@/lib/fm/schedule";
import { useFm } from "@/lib/fm/store";
import type { Priority, WorkOrderStatus } from "@/lib/fm/types";
import { Button } from "@/components/ui/primitives";

// ---------------------------------------------------------------------------
// Formatting

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03-14" -> "14 Mar 2026". */
export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** A timestamp as date and time in the browser's zone. */
export function formatDateTime(at: string | number | undefined): string {
  if (at === undefined || at === "") return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "3 min ago", "2 h ago", "5 days ago". */
export function ago(ms: number | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** 1,284 / 12.9K / 1.2M. */
export function compact(n: number): string {
  if (Math.abs(n) < 10000) return n.toLocaleString();
  if (Math.abs(n) < 1e6) return `${(n / 1000).toFixed(n < 1e5 ? 1 : 0)}K`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Address state

/** A search parameter as page state: reading it, and replacing it without a new history entry. */
export function useParam(key: string): [string, (value: string | null) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = params.get(key) ?? "";
  const set = useCallback(
    (next: string | null) => {
      const p = new URLSearchParams(window.location.search);
      if (next === null || next === "") p.delete(key);
      else p.set(key, next);
      const q = p.toString();
      router.replace(`${pathname}${q ? `?${q}` : ""}${window.location.hash}`, { scroll: false });
    },
    [key, pathname, router],
  );
  return [value, set];
}

/** Changes several search parameters at once (null removes one). */
export function useSetParams(): (patch: Record<string, string | null>) => void {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(
    (patch) => {
      const p = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") p.delete(k);
        else p.set(k, v);
      }
      const q = p.toString();
      router.replace(`${pathname}${q ? `?${q}` : ""}`, { scroll: false });
    },
    [pathname, router],
  );
}

// ---------------------------------------------------------------------------
// Page frame

export function PageFrame({ title, subtitle, actions, children, wide, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean; className?: string }) {
  return (
    <div className="scroll-thin h-full min-h-0 overflow-y-auto bg-bg">
      <div className={clsx("mx-auto flex flex-col gap-4 p-3 sm:p-4", wide ? "max-w-[1680px]" : "max-w-[1400px]", className)}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[17px] font-semibold tracking-tight text-fg">{title}</h1>
            {subtitle ? <p className="mt-0.5 max-w-[100ch] text-[12.5px] leading-relaxed text-fg-2">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A titled block on a facility page. */
export function Panel({ title, aside, children, className, bodyClassName, id }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string }) {
  return (
    <section id={id} className={clsx("min-w-0 rounded-lg border border-line bg-surface", className)}>
      {title || aside ? (
        <header className="flex min-h-10 items-center gap-2 border-b border-line px-3 py-2">
          {title ? <h2 className="min-w-0 truncate text-[13px] font-semibold text-fg">{title}</h2> : null}
          <div className="ml-auto flex items-center gap-1.5">{aside}</div>
        </header>
      ) : null}
      <div className={clsx("p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * What a facility page shows before the workspace has loaded, when it could not load, or when no
 * building has been onboarded on this device yet.
 */
export function WorkspaceGate({ children, what = "this page" }: { children: ReactNode; what?: string }) {
  const status = useFm((s) => s.status);
  const error = useFm((s) => s.error);
  const facility = useFm((s) => s.facility);
  if (status === "idle" || status === "loading")
    return (
      <div className="grid h-full place-items-center bg-bg text-[12.5px] text-fg-3">
        <span className="flex items-center gap-2">
          <Loader2 size={15} className="animate-spin" /> Opening the facility workspace…
        </span>
      </div>
    );
  if (status === "error" && !facility)
    return (
      <div className="grid h-full place-items-center bg-bg p-4">
        <div className="max-w-md rounded-lg border border-bad/30 bg-surface p-4 text-[12.5px] leading-relaxed text-fg-2">
          <div className="mb-1 flex items-center gap-2 font-semibold text-fg">
            <AlertTriangle size={15} className="text-bad" /> The workspace could not be opened
          </div>
          This browser did not let bim-os use its storage ({error}). Private windows and some privacy settings block it; open the app in a normal window, or allow site data for it.
        </div>
      </div>
    );
  if (!facility) return <NoWorkspace what={what} />;
  return <>{children}</>;
}

export function NoWorkspace({ what }: { what: string }) {
  return (
    <div className="scroll-thin grid h-full place-items-center overflow-y-auto bg-bg p-4">
      <div className="w-full max-w-[720px]">
        <div className="mb-4 text-center">
          <div className="mx-auto mb-2 grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
            <Building2 size={20} />
          </div>
          <h1 className="text-[17px] font-semibold text-fg">No building on this device yet</h1>
          <p className="mx-auto mt-1 max-w-[60ch] text-[12.5px] leading-relaxed text-fg-2">
            {what === "this page" ? "This page" : what} works on a facility workspace: a building&apos;s assets, rooms, maintenance and live data, kept in this browser. Start one from the building&apos;s models, try the demo, or open a workspace file someone shared.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <StartCard href="/onboard" icon={Building2} title="Onboard a building" text="From IFC, Revit or Navisworks models, step by step." primary />
          <StartCard href="/onboard?demo=1" icon={Sparkles} title="Try the demo" text="A made-up office building with assets, maintenance and live readings." />
          <StartCard href="/settings#workspace" icon={FileUp} title="Open a workspace file" text="A backup, or a workspace a colleague exported." />
        </div>
      </div>
    </div>
  );
}

function StartCard({ href, icon: Icon, title, text, primary }: { href: string; icon: LucideIcon; title: string; text: string; primary?: boolean }) {
  return (
    <Link href={href} className={clsx("group flex flex-col gap-1.5 rounded-lg border bg-surface p-3 transition-colors hover:border-accent", primary ? "border-accent/50" : "border-line")}>
      <Icon size={17} className="text-accent" />
      <span className="text-[13px] font-semibold text-fg">{title}</span>
      <span className="text-[12px] leading-snug text-fg-3">{text}</span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Tabs

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; count?: number; tone?: "bad" | "warn" }[]; value: T; onChange: (id: T) => void; className?: string }) {
  return (
    <div role="tablist" className={clsx("scroll-thin flex gap-1 overflow-x-auto border-b border-line", className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
          className={clsx(
            "-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[12.5px] font-medium transition-colors",
            t.id === value ? "border-accent text-fg" : "border-transparent text-fg-3 hover:text-fg",
          )}
        >
          {t.label}
          {t.count !== undefined ? (
            <span className={clsx("tabular rounded-full px-1.5 text-[10.5px] leading-[17px]", t.tone === "bad" ? "bg-bad-soft text-bad" : t.tone === "warn" ? "bg-warn-soft text-warn" : "bg-surface-2 text-fg-3")}>{compact(t.count)}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Figures

/** A headline number: label, value, and a line of context. */
export function StatTile({ label, value, sub, href, icon: Icon, tone, children }: { label: string; value: ReactNode; sub?: ReactNode; href?: string; icon?: LucideIcon; tone?: "bad" | "warn" | "ok"; children?: ReactNode }) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
        {Icon ? <Icon size={13} className={clsx(tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-fg-3")} /> : null}
        {label}
      </div>
      <div className="mt-0.5 text-[22px] font-semibold leading-tight tracking-tight text-fg">{value}</div>
      {sub ? <div className="mt-0.5 text-[11.5px] leading-snug text-fg-3">{sub}</div> : null}
      {children}
    </>
  );
  const cls = "block min-w-0 rounded-lg border border-line bg-surface px-3 py-2.5";
  return href ? (
    <Link href={href} className={clsx(cls, "transition-colors hover:border-accent/60")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** A share against its whole: the fill in the accent, the track a lighter step of the same hue. */
export function Meter({ value, className, label }: { value: number; className?: string; label?: string }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label} className={clsx("h-2 w-full overflow-hidden rounded-full", className)} style={{ background: "var(--series-track)" }}>
      <div className="h-full rounded-full" style={{ width: `${v * 100}%`, background: "var(--series-1)" }} />
    </div>
  );
}

/** Rows of a name, a meter and a figure (data completeness, for instance). */
export function MeterList({ rows }: { rows: { key: string; label: string; value: number; total: number; href?: string; note?: string }[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => {
        const share = r.total ? r.value / r.total : 0;
        const content = (
          <>
            <span className="min-w-0 truncate text-[12px] text-fg-2">{r.label}</span>
            <Meter value={share} label={`${r.label}: ${Math.round(share * 100)}%`} className="col-span-2 sm:col-span-1" />
            <span className="tabular text-right text-[12px] text-fg">
              {Math.round(share * 100)}%<span className="ml-1 text-[11px] text-fg-3">{r.note ?? `${r.value.toLocaleString()} of ${r.total.toLocaleString()}`}</span>
            </span>
          </>
        );
        const cls = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(90px,160px)_minmax(0,1fr)_minmax(120px,auto)]";
        return (
          <li key={r.key}>
            {r.href ? (
              <Link href={r.href} className={clsx(cls, "rounded-md px-1 py-0.5 hover:bg-surface-2")} title={`Show the assets missing ${r.label.toLowerCase()}`}>
                {content}
              </Link>
            ) : (
              <div className={clsx(cls, "px-1 py-0.5")}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Status badges (colour always with an icon or a word)

const pill = "inline-flex h-[19px] shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-medium";

export function AssetStatusBadge({ status }: { status: "verified" | "edited" | "incomplete" | "complete" }) {
  const map = {
    verified: { cls: "bg-ok-soft text-ok", icon: CheckCircle2, text: "Verified" },
    edited: { cls: "bg-accent-soft text-accent", icon: Pencil, text: "Edited" },
    incomplete: { cls: "bg-warn-soft text-warn", icon: AlertTriangle, text: "Missing data" },
    complete: { cls: "bg-surface-2 text-fg-2", icon: CircleDot, text: "From model" },
  } as const;
  const m = map[status];
  const Icon = m.icon;
  return (
    <span className={clsx(pill, m.cls)}>
      <Icon size={11} /> {m.text}
    </span>
  );
}

export function DueBadge({ state, days }: { state: DueState; days?: number }) {
  if (state === "overdue")
    return (
      <span className={clsx(pill, "bg-bad-soft text-bad")}>
        <AlertTriangle size={11} /> {days !== undefined ? `${Math.abs(days)} d overdue` : "Overdue"}
      </span>
    );
  if (state === "due")
    return (
      <span className={clsx(pill, "bg-warn-soft text-warn")}>
        <Clock size={11} /> {days === 0 ? "Due today" : days !== undefined ? `Due in ${days} d` : "Due soon"}
      </span>
    );
  if (state === "inactive") return <span className={clsx(pill, "bg-surface-2 text-fg-3")}>Paused</span>;
  return <span className={clsx(pill, "bg-surface-2 text-fg-2")}>Scheduled</span>;
}

export const WO_STATUS_LABEL: Record<WorkOrderStatus, string> = { open: "Open", "in-progress": "In progress", "on-hold": "On hold", done: "Done", cancelled: "Cancelled" };

export function WoStatusBadge({ status }: { status: WorkOrderStatus }) {
  const cls = { open: "bg-accent-soft text-accent", "in-progress": "bg-warn-soft text-warn", "on-hold": "bg-surface-2 text-fg-2", done: "bg-ok-soft text-ok", cancelled: "bg-surface-2 text-fg-3 line-through" }[status];
  const Icon = status === "done" ? CheckCircle2 : status === "in-progress" ? Clock : CircleDot;
  return (
    <span className={clsx(pill, cls)}>
      <Icon size={11} /> {WO_STATUS_LABEL[status]}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  if (priority === "normal") return <span className="text-[11.5px] text-fg-3">Normal</span>;
  const cls = { urgent: "bg-bad-soft text-bad", high: "bg-warn-soft text-warn", low: "bg-surface-2 text-fg-3" }[priority];
  return <span className={clsx(pill, cls)}>{priority === "urgent" ? <AlertTriangle size={11} /> : null}{priority.charAt(0).toUpperCase() + priority.slice(1)}</span>;
}

// ---------------------------------------------------------------------------
// Side panel (full screen on phones)

export function SidePanel({ open, onClose, title, subtitle, actions, children, width = 520 }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement | null)?.closest?.("input,textarea,select")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div ref={ref} className="relative flex h-full w-full flex-col border-l border-line bg-surface shadow-pop" style={{ maxWidth: width }}>
        <header className="flex items-start gap-2 border-b border-line px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-fg">{title}</div>
            {subtitle ? <div className="mt-0.5 text-[12px] text-fg-3">{subtitle}</div> : null}
          </div>
          {actions}
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-7 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-surface-2">
            <X size={16} />
          </button>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/** A small "nothing here yet" line with an optional action. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-[12.5px] text-fg-3">
      <div className="max-w-[56ch] leading-relaxed">{children}</div>
      {action}
    </div>
  );
}

export { Button };

// ---------------------------------------------------------------------------
// Modal

export function Modal({ open, onClose, title, children, footer, width = 520 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[55] flex items-end justify-center bg-black/30 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} className="flex max-h-[92vh] w-full flex-col rounded-t-xl border border-line bg-surface shadow-pop sm:rounded-xl" style={{ maxWidth: width }}>
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-7 place-items-center rounded-md text-fg-2 hover:bg-surface-2">
            <X size={16} />
          </button>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** A labelled form control. */
export function FormRow({
  label,
  hint,
  children,
  className,
  group,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  /** The row holds several controls (choice buttons, removable chips). It is then a group, not a <label>: a click on a label's caption presses the first control inside it. */
  group?: boolean;
}) {
  const body = (
    <>
      <span className="text-[11.5px] font-medium text-fg-2">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-snug text-fg-3">{hint}</span> : null}
    </>
  );
  if (group)
    return (
      <div role="group" aria-label={typeof label === "string" ? label : undefined} className={clsx("flex min-w-0 flex-col gap-1", className)}>
        {body}
      </div>
    );
  return <label className={clsx("flex min-w-0 flex-col gap-1", className)}>{body}</label>;
}

export const inputCls = "h-8 w-full min-w-0 rounded-md border border-line-strong bg-surface px-2 text-[12.5px] text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none disabled:opacity-50";
export const textareaCls = "w-full min-w-0 rounded-md border border-line-strong bg-surface px-2 py-1.5 text-[12.5px] leading-relaxed text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none";
