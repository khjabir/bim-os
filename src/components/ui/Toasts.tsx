"use client";

import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import clsx from "clsx";
import { dismissToast, useViewerStore } from "@/lib/store";

export function Toasts() {
  const toasts = useViewerStore((state) => state.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none absolute bottom-16 left-1/2 z-40 flex w-[min(92%,460px)] -translate-x-1/2 flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={clsx(
            "pointer-events-auto flex items-start gap-2 rounded-lg border bg-surface px-3 py-2 text-[12.5px] shadow-pop",
            toast.kind === "error" ? "border-bad/40" : toast.kind === "success" ? "border-ok/40" : "border-line",
          )}
        >
          <span className="mt-px shrink-0">
            {toast.kind === "error" ? <AlertCircle size={15} className="text-bad" /> : toast.kind === "success" ? <CheckCircle2 size={15} className="text-ok" /> : <Info size={15} className="text-accent" />}
          </span>
          <span className="min-w-0 flex-1 break-words leading-relaxed text-fg">{toast.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(toast.id)} className="shrink-0 rounded p-0.5 text-fg-3 hover:bg-surface-2 hover:text-fg">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
