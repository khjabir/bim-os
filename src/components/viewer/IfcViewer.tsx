"use client";

import dynamic from "next/dynamic";
import { Box } from "lucide-react";
import { Spinner } from "@/components/ui/primitives";

// The engine touches WebGL, workers and the DOM, so it is client-only.
const BimWorkbench = dynamic(() => import("./BimWorkbench"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-[12.5px] text-fg-3">
      <span className="flex items-center gap-2">
        <Spinner /> Loading viewer…
      </span>
    </div>
  ),
});

export function IfcViewer() {
  return (
    <BimWorkbench
      emptyState={
        <div className="max-w-sm text-center">
          <div className="mx-auto grid size-12 place-items-center rounded-xl border border-line bg-surface text-fg-3">
            <Box size={22} strokeWidth={1.5} />
          </div>
          <h1 className="mt-3 text-[15px] font-semibold text-fg">Open an IFC model</h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-2">
            Drop an .ifc, .ifczip or .frag file here, or use Open files. IFC is converted to Fragments in a background worker,
            read from disk in chunks, so large models stay responsive while they load.
          </p>
        </div>
      }
    />
  );
}
