"use client";

import { Download, FileDown, Upload, X } from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, ProgressBar } from "@/components/ui/primitives";
import { Menu } from "@/components/ui/Menu";
import { useEngine } from "@/lib/engine/context";
import { useViewerStore } from "@/lib/store";
import { formatCount } from "@/lib/utils/format";

/** Progress cards for conversions, loads and exports. */
export function TaskOverlay() {
  const engine = useEngine();
  const tasks = useViewerStore((state) => state.tasks);
  if (tasks.length === 0) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-30 flex w-[min(92%,420px)] -translate-x-1/2 flex-col gap-2">
      {tasks.map((task) => (
        <div key={task.id} className="pointer-events-auto rounded-lg border border-line bg-surface px-3 py-2.5 shadow-pop" role="status">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">{task.label}</div>
            {typeof task.progress === "number" ? <div className="tabular text-[11.5px] text-fg-3">{Math.round(task.progress * 100)}%</div> : null}
            {task.cancellable && engine ? (
              <button type="button" aria-label="Cancel" title="Cancel" onClick={() => engine.cancelTask(task.id)} className="rounded p-0.5 text-fg-3 hover:bg-surface-2 hover:text-fg">
                <X size={13} />
              </button>
            ) : null}
          </div>
          <ProgressBar value={task.progress} className="mt-2" />
          <div className="mt-1.5 flex justify-between gap-3 text-[11.5px] text-fg-3">
            <span className="truncate">{task.phase ?? "Working"}</span>
            {task.detail ? <span className="truncate">{task.detail}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Appears while something is selected: count plus the export actions. */
export function SelectionBar() {
  const engine = useEngine();
  const count = useViewerStore((state) => state.selectionCount);
  const models = useViewerStore((state) => state.models);
  const selection = useViewerStore((state) => state.selection);
  if (!engine || count === 0) return null;
  const selectedModels = Object.keys(selection);
  const canExportIfc = selectedModels.some((id) => models.find((model) => model.id === id)?.hasSourceIfc);
  return (
    <div className="absolute left-3 top-3 z-20 flex items-center gap-1.5 rounded-lg border border-line bg-surface/95 py-1 pl-2.5 pr-1 shadow-pop backdrop-blur">
      <span className="tabular text-[12.5px] font-medium text-fg">
        {formatCount(count)} selected
      </span>
      <Menu
        trigger={({ toggle }) => (
          <Button size="sm" variant="primary" icon={<FileDown size={12} />} onClick={toggle}>
            Export
          </Button>
        )}
        width={250}
        items={[
          {
            label: "Selection as IFC (.ifc)",
            icon: <Download size={14} />,
            disabled: !canExportIfc,
            hint: canExportIfc ? "A valid IFC with the selected elements and what they depend on. Walls keep their openings, doors and windows; assemblies keep their parts." : "Needs the original IFC: not available for models opened from .frag",
            onSelect: () => void engine.exportIfcSubset(useViewerStore.getState().selection),
          },
          {
            label: "Selection as Fragments (.frag)",
            icon: <Download size={14} />,
            onSelect: () => void engine.exportFragmentsSubset(useViewerStore.getState().selection),
          },
        ]}
      />
      <button type="button" aria-label="Clear selection" title="Clear selection (Esc)" onClick={() => void engine.clearSelection()} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-surface-2 hover:text-fg">
        <X size={13} />
      </button>
    </div>
  );
}

/** Rubber-band rectangle for the box-select tool. */
export function BoxSelectLayer() {
  const engine = useEngine();
  const active = useViewerStore((state) => state.tool === "box");
  const start = useRef<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number; contained: boolean } | null>(null);
  if (!engine || !active) return null;

  const local = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  return (
    <div
      className="absolute inset-0 z-10 cursor-crosshair touch-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, y: event.clientY };
        const point = local(event);
        setRect({ left: point.x, top: point.y, width: 0, height: 0, contained: true });
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const x0 = start.current.x - bounds.left;
        const y0 = start.current.y - bounds.top;
        const point = local(event);
        setRect({
          left: Math.min(x0, point.x),
          top: Math.min(y0, point.y),
          width: Math.abs(point.x - x0),
          height: Math.abs(point.y - y0),
          // Dragging left-to-right selects only fully enclosed elements, like CAD tools.
          contained: point.x >= x0,
        });
      }}
      onPointerUp={(event) => {
        const origin = start.current;
        start.current = null;
        setRect(null);
        if (!origin) return;
        const left = Math.min(origin.x, event.clientX);
        const right = Math.max(origin.x, event.clientX);
        const top = Math.min(origin.y, event.clientY);
        const bottom = Math.max(origin.y, event.clientY);
        if (right - left < 4 || bottom - top < 4) return;
        void engine.boxSelect(left, top, right, bottom, { add: event.shiftKey, contained: event.clientX >= origin.x });
      }}
      onPointerCancel={() => {
        start.current = null;
        setRect(null);
      }}
    >
      {rect ? (
        <div
          className={rect.contained ? "absolute border border-accent bg-accent/10" : "absolute border border-dashed border-ok bg-ok/10"}
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      ) : null}
    </div>
  );
}

export function DropHint({ visible, label }: { visible: boolean; label: string }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-2 z-40 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-accent/10">
      <div className="flex items-center gap-2 rounded-lg bg-surface px-4 py-2.5 text-[13px] font-medium text-fg shadow-pop">
        <Upload size={16} className="text-accent" />
        {label}
      </div>
    </div>
  );
}
