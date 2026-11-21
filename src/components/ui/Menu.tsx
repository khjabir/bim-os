"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  items: (MenuItem | "separator")[];
  align?: "start" | "end";
  side?: "top" | "bottom";
  width?: number;
}

/** Minimal dropdown menu: closes on outside click, Escape and selection. */
export function Menu({ trigger, items, align = "start", side = "bottom", width = 220 }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open ? (
        <div
          role="menu"
          style={{ width }}
          className={clsx(
            "absolute z-50 rounded-lg border border-line bg-surface p-1 shadow-pop",
            align === "end" ? "right-0" : "left-0",
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          {items.map((item, index) =>
            item === "separator" ? (
              <div key={`separator-${index}`} className="my-1 h-px bg-line" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.hint}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={clsx(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-45",
                  item.danger ? "text-bad hover:bg-bad-soft" : "text-fg hover:bg-surface-2",
                )}
              >
                {item.icon ? <span className="shrink-0 text-fg-3">{item.icon}</span> : null}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
