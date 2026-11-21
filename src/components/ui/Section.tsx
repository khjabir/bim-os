"use client";

import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

interface SectionProps {
  title: ReactNode;
  count?: ReactNode;
  defaultOpen?: boolean;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Collapsible block used throughout the side panels. */
export function Section({ title, count, defaultOpen = true, aside, children, className }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={clsx("border-b border-line", className)}>
      <div className="flex h-8 items-center gap-1 px-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left hover:bg-surface-2"
        >
          <ChevronRight size={13} className={clsx("shrink-0 text-fg-3 transition-transform", open && "rotate-90")} />
          <span className="truncate text-[12px] font-semibold text-fg">{title}</span>
          {count !== undefined ? <span className="tabular ml-1 shrink-0 text-[11px] text-fg-3">{count}</span> : null}
        </button>
        {aside}
      </div>
      {open ? <div className="pb-2">{children}</div> : null}
    </section>
  );
}
