"use client";

import clsx from "clsx";
import { useEffect, useState, type ReactNode } from "react";

/** A titled block of the Convert page. */
export function Card({ step, title, aside, children, className, id }: { step?: number; title: string; aside?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={clsx("rounded-lg border border-line bg-surface", className)} aria-label={title}>
      <header className="flex min-h-10 items-center gap-2 border-b border-line px-3 py-2">
        {step ? <span className="tabular grid size-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">{step}</span> : null}
        <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
        <div className="ml-auto flex items-center gap-1.5">{aside}</div>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={clsx("flex items-start gap-2", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-[3px] size-3.5 shrink-0 accent-[var(--accent)]" />
      <span className="min-w-0">
        <span className="block text-[12px] text-fg">{label}</span>
        {hint ? <span className="block text-[11px] leading-snug text-fg-3">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * A number field that keeps what is typed until it parses (so "-", "0." and
 * empty are allowed while editing) and reports numbers only.
 */
export function NumberField({
  value,
  onChange,
  step = 0.01,
  min,
  max,
  suffix,
  className,
  label,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  className?: string;
  label?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <span className={clsx("flex h-7 min-w-0 items-center rounded-md border border-line-strong bg-surface focus-within:border-accent", disabled && "opacity-50", className)}>
      <input
        type="number"
        inputMode="decimal"
        aria-label={label}
        value={text}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          const n = Number(event.target.value);
          if (event.target.value.trim() !== "" && Number.isFinite(n)) onChange(min !== undefined ? Math.max(min, max !== undefined ? Math.min(max, n) : n) : n);
        }}
        className="tabular h-full w-full min-w-0 bg-transparent px-2 text-[12.5px] text-fg outline-none"
      />
      {suffix ? <span className="pr-2 text-[11px] text-fg-3">{suffix}</span> : null}
    </span>
  );
}

export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-[11px] font-medium text-fg-3">{label}</span>
      {children}
    </label>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] uppercase tracking-wide text-fg-3">{label}</div>
      <div className="tabular truncate text-[12.5px] font-medium text-fg">{value}</div>
    </div>
  );
}
