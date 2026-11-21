"use client";

import clsx from "clsx";
import { useCallback, useRef, type ReactNode } from "react";

export interface RailItem<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
  badge?: ReactNode;
}

interface RailProps<T extends string> {
  items: RailItem<T>[];
  active: T | null;
  onChange: (id: T | null) => void;
  side: "left" | "right";
}

/** Vertical strip of labelled icons. Clicking the active item collapses its panel. */
export function Rail<T extends string>({ items, active, onChange, side }: RailProps<T>) {
  return (
    <nav
      className={clsx("flex w-[58px] shrink-0 flex-col items-center gap-0.5 bg-surface py-2", side === "left" ? "border-r border-line" : "border-l border-line")}
      aria-label={side === "left" ? "Model tools" : "Analysis tools"}
    >
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(selected ? null : item.id)}
            className={clsx(
              "relative flex w-[50px] flex-col items-center gap-0.5 rounded-md py-1.5 text-[10px] font-medium leading-none transition-colors",
              selected ? "bg-accent-soft text-accent" : "text-fg-3 hover:bg-surface-2 hover:text-fg",
            )}
          >
            {item.icon}
            <span className="mt-0.5">{item.label}</span>
            {item.badge ? <span className="absolute right-1 top-0.5">{item.badge}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}

interface ResizablePanelProps {
  side: "left" | "right";
  width: number;
  onWidth: (width: number) => void;
  min?: number;
  max?: number;
  title: string;
  children: ReactNode;
}

/** Side panel with a drag handle on its inner edge. */
export function ResizablePanel({ side, width, onWidth, min = 260, max = 640, title, children }: ResizablePanelProps) {
  const drag = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, width };
    },
    [width],
  );
  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      const delta = event.clientX - drag.current.x;
      const next = side === "left" ? drag.current.width + delta : drag.current.width - delta;
      onWidth(Math.max(min, Math.min(max, next)));
    },
    [side, min, max, onWidth],
  );
  const stop = useCallback(() => {
    drag.current = null;
  }, []);

  return (
    <aside
      style={{ width }}
      aria-label={title}
      className={clsx("relative flex shrink-0 flex-col bg-surface", side === "left" ? "border-r border-line" : "border-l border-line")}
    >
      <header className="flex h-9 shrink-0 items-center border-b border-line px-3">
        <h2 className="text-[12.5px] font-semibold text-fg">{title}</h2>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${title} panel`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stop}
        onPointerCancel={stop}
        className={clsx("absolute inset-y-0 z-20 w-1.5 cursor-col-resize touch-none hover:bg-accent/40", side === "left" ? "-right-[3px]" : "-left-[3px]")}
      />
    </aside>
  );
}
