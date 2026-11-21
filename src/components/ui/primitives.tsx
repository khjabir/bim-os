"use client";

import clsx from "clsx";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: ReactNode;
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover border-transparent",
  secondary: "bg-surface text-fg border-line-strong hover:bg-surface-2",
  ghost: "bg-transparent text-fg-2 border-transparent hover:bg-surface-2 hover:text-fg",
  danger: "bg-surface text-bad border-line-strong hover:bg-bad-soft",
};

export function Button({ variant = "secondary", size = "md", icon, busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-6 px-2 text-[11.5px]" : "h-7 px-2.5 text-[12.5px]",
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: "sm" | "md";
}

export function IconButton({ label, active, size = "md", className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      {...rest}
      className={clsx(
        "grid shrink-0 place-items-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "size-6" : "size-7",
        active ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "accent" | "ok" | "warn" | "bad"; children: ReactNode; className?: string }) {
  const tones = {
    neutral: "bg-surface-2 text-fg-2",
    accent: "bg-accent-soft text-accent",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad",
  } as const;
  return (
    <span className={clsx("tabular inline-flex h-[18px] items-center rounded px-1.5 text-[11px] font-medium", tones[tone], className)}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, className }: { value?: number; className?: string }) {
  const determinate = typeof value === "number" && Number.isFinite(value);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(value * 100) : undefined}
      className={clsx("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)}
    >
      {determinate ? (
        <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      ) : (
        <div className="h-full w-2/5 rounded-full bg-accent" style={{ animation: "indeterminate 1.2s ease-in-out infinite" }} />
      )}
    </div>
  );
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={clsx("animate-spin text-fg-3", className)} />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      {icon ? <div className="text-fg-3">{icon}</div> : null}
      <div className="text-[13px] font-medium text-fg">{title}</div>
      {children ? <div className="max-w-[30ch] text-[12px] leading-relaxed text-fg-3">{children}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={clsx(
        "h-7 w-full min-w-0 rounded-md border border-line-strong bg-surface px-2 text-[12.5px] text-fg placeholder:text-fg-3",
        "disabled:opacity-50",
        className,
      )}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={clsx(
        "h-7 w-full min-w-0 rounded-md border border-line-strong bg-surface px-1.5 text-[12.5px] text-fg disabled:opacity-50",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-fg-3">
      {children}
    </label>
  );
}

/** Small uppercase heading that separates groups inside a panel. */
export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between gap-2">
      <h3 className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-wide text-fg-3">{children}</h3>
      {aside}
    </div>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  className?: string;
}

export function Segmented<T extends string>({ value, onChange, options, className }: SegmentedProps<T>) {
  return (
    <div className={clsx("inline-flex rounded-md border border-line-strong bg-surface-2 p-0.5", className)} role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={clsx(
            "h-6 flex-1 rounded px-2 text-[11.5px] font-medium transition-colors",
            value === option.value ? "bg-surface text-fg shadow-sm" : "text-fg-3 hover:text-fg",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-surface-2 px-1 font-mono text-[10.5px] text-fg-2">{children}</kbd>
  );
}

/** Note box for inline guidance, warnings and errors. */
export function Callout({ tone = "info", children, className }: { tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode; className?: string }) {
  const tones = {
    info: "border-line bg-surface-2 text-fg-2",
    warn: "border-warn/30 bg-warn-soft text-fg",
    bad: "border-bad/30 bg-bad-soft text-fg",
    ok: "border-ok/30 bg-ok-soft text-fg",
  } as const;
  return <div className={clsx("rounded-md border px-2.5 py-2 text-[12px] leading-relaxed", tones[tone], className)}>{children}</div>;
}
