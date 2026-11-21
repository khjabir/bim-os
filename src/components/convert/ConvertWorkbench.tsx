"use client";

import { FileInput } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Toasts } from "@/components/ui/Toasts";
import { addSourceFiles, refreshApsStatus } from "@/lib/convert/actions";
import { useConvertStore } from "@/lib/convert/store";
import { AssembleCard } from "./AssembleCard";
import { AssetsCard } from "./AssetsCard";
import { GenerateCard } from "./GenerateCard";
import { LinkCard } from "./LinkCard";
import { PlanEditor } from "./PlanEditor";
import { PlansCard } from "./PlansCard";
import { PreviewCard } from "./PreviewCard";
import { SourcesCard } from "./SourcesCard";

/**
 * The Convert page: Revit / Navisworks models (directly, through Autodesk's
 * cloud, or from an Autodesk Viewer link) and floor plans in, IFC files out,
 * one per discipline plus a federated one, ready to open in the IFC viewer.
 */
export function ConvertWorkbench() {
  const aps = useConvertStore((s) => s.aps);
  const editing = useConvertStore((s) => s.editingPlan);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    if (!aps) void refreshApsStatus();
  }, [aps]);

  const onDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) void addSourceFiles(files);
  };

  return (
    <div className="relative h-full min-h-0 overflow-y-auto bg-bg" onDragEnter={onDragEnter} onDragOver={(e) => e.preventDefault()} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight text-fg">Convert to IFC</h1>
          <p className="mt-0.5 max-w-[95ch] text-[12.5px] leading-relaxed text-fg-2">
            Bring in Revit or Navisworks models, an Autodesk Viewer link, and floor plans; assign disciplines and storeys; and generate IFC4 files, one per discipline and a federated one, that open
            together in the model viewer, and an asset register (COBie and Excel) of the equipment.
          </p>
        </div>
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(340px,5fr)_7fr]">
          <div className="flex min-w-0 flex-col gap-4">
            <SourcesCard onAdd={(files) => void addSourceFiles(files)} />
            <LinkCard />
            <PlansCard />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <AssembleCard />
            <PreviewCard />
            <GenerateCard />
            <AssetsCard />
          </div>
        </div>
      </div>
      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-accent/10">
          <div className="flex items-center gap-2 rounded-lg border border-accent bg-surface px-4 py-3 text-[13px] font-medium text-fg shadow">
            <FileInput size={16} className="text-accent" /> Drop models, extracts or plans
          </div>
        </div>
      ) : null}
      {editing ? <PlanEditor /> : null}
      <Toasts />
    </div>
  );
}
