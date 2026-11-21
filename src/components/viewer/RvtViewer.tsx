"use client";

import dynamic from "next/dynamic";
import { Building2 } from "lucide-react";
import { useEffect } from "react";
import { Spinner } from "@/components/ui/primitives";
import { openRvtFiles, RVT_ACCEPT } from "@/lib/rvt/open";
import { resetRvtStore } from "@/lib/rvt/store";
import { RvtImportPanel } from "./panels/RvtImportPanel";

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

/** The Revit viewer: the IFC workbench with an import step that turns .rvt into IFC first. */
export function RvtViewer() {
  // Reports refer to models of this viewer instance; drop them when it goes away.
  useEffect(() => resetRvtStore, []);
  return (
    <BimWorkbench
      accept={RVT_ACCEPT}
      onFiles={openRvtFiles}
      importPanel={<RvtImportPanel />}
      dropLabel="Drop Revit files to open them"
      emptyState={
        <div className="max-w-sm text-center">
          <div className="mx-auto grid size-12 place-items-center rounded-xl border border-line bg-surface text-fg-3">
            <Building2 size={22} strokeWidth={1.5} />
          </div>
          <h1 className="mt-3 text-[15px] font-semibold text-fg">Open a Revit model</h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-2">
            Drop an .rvt file here, or use the Import panel. The file is converted to IFC first, in the browser or through Autodesk&apos;s cloud, then opens in the same viewer
            and tools as an IFC model. Select elements or groups and export them as IFC.
          </p>
        </div>
      }
    />
  );
}
