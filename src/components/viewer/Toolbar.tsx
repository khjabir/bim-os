"use client";

import {
  Axis3d,
  Box,
  BoxSelect,
  Diameter,
  Eye,
  EyeOff,
  Focus,
  Footprints,
  Ghost,
  Grid3x3,
  Layers,
  Maximize,
  MousePointer2,
  Move3d,
  Orbit,
  PencilRuler,
  Ruler,
  Scissors,
  Sparkles,
  Square,
  Triangle,
} from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/primitives";
import { Menu } from "@/components/ui/Menu";
import { useEngine } from "@/lib/engine/context";
import type { ViewOrientation } from "@/lib/engine/engine";
import { useViewerStore, type ToolId } from "@/lib/store";

const TOOLS: { id: ToolId; label: string; icon: ReactNode }[] = [
  { id: "select", label: "Select (click, Ctrl+click to add)", icon: <MousePointer2 size={16} /> },
  { id: "box", label: "Box select (drag a rectangle)", icon: <BoxSelect size={16} /> },
  { id: "length", label: "Measure length", icon: <Ruler size={16} /> },
  { id: "area", label: "Measure area", icon: <Square size={16} /> },
  { id: "angle", label: "Measure angle", icon: <Triangle size={16} /> },
  { id: "volume", label: "Measure volume", icon: <Box size={16} /> },
  { id: "section", label: "Section plane", icon: <Scissors size={16} /> },
];

const HINTS: Partial<Record<ToolId, string>> = {
  box: "Drag to select what the rectangle touches · left-to-right selects only fully enclosed elements · Shift adds",
  length: "Double-click two points · Delete removes the hovered measurement · Esc exits",
  area: "Double-click each corner · Enter closes the area · Esc exits",
  angle: "Double-click three points · Delete removes the hovered measurement · Esc exits",
  volume: "Double-click elements to add them · Enter finishes · Esc exits",
  section: "Double-click a surface to cut there · drag the plane to move it · Delete removes the hovered plane",
};

const VIEWS: { id: ViewOrientation; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "bottom", label: "Bottom" },
  { id: "front", label: "Front" },
  { id: "back", label: "Back" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
];

function Divider() {
  return <div className="mx-1 h-5 w-px bg-line" />;
}

export function Toolbar() {
  const engine = useEngine();
  const tool = useViewerStore((state) => state.tool);
  const selectionCount = useViewerStore((state) => state.selectionCount);
  const projection = useViewerStore((state) => state.projection);
  const navMode = useViewerStore((state) => state.navMode);
  const grid = useViewerStore((state) => state.grid);
  const renderStyle = useViewerStore((state) => state.renderStyle);
  const ghosting = useViewerStore((state) => state.ghosting);
  const visibilityModified = useViewerStore((state) => state.visibilityModified);
  const hasModels = useViewerStore((state) => state.models.length > 0);
  const measurementCount = useViewerStore((state) => state.measurementCount);
  const planeCount = useViewerStore((state) => state.planeCount);

  if (!engine) return null;
  const selection = () => useViewerStore.getState().selection;
  const hint = HINTS[tool];

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex flex-col items-center gap-2 px-3">
      {hint ? (
        <div className="pointer-events-auto max-w-full rounded-md border border-line bg-surface/95 px-2.5 py-1 text-center text-[11.5px] text-fg-2 shadow-pop backdrop-blur">
          {hint}
        </div>
      ) : null}
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-0.5 rounded-xl border border-line bg-surface/95 p-1 shadow-pop backdrop-blur" role="toolbar" aria-label="Viewer tools">
        {TOOLS.map((entry) => (
          <IconButton key={entry.id} label={entry.label} active={tool === entry.id} disabled={!hasModels && entry.id !== "select"} onClick={() => engine.setTool(tool === entry.id ? "select" : entry.id)}>
            {entry.icon}
          </IconButton>
        ))}
        {measurementCount > 0 || planeCount > 0 ? (
          <Menu
            side="top"
            trigger={({ toggle }) => (
              <IconButton label="Measurements and section planes" onClick={toggle}>
                <PencilRuler size={16} />
              </IconButton>
            )}
            items={[
              { label: `Clear measurements (${measurementCount})`, disabled: measurementCount === 0, onSelect: () => engine.clearMeasurements() },
              { label: `Remove section planes (${planeCount})`, disabled: planeCount === 0, onSelect: () => engine.clearPlanes() },
            ]}
          />
        ) : null}
        <Divider />
        <IconButton label="Hide selection (H)" disabled={selectionCount === 0} onClick={() => void engine.hide(selection()).then(() => engine.clearSelection())}>
          <EyeOff size={16} />
        </IconButton>
        <IconButton label="Isolate selection (I)" disabled={selectionCount === 0} onClick={() => void engine.isolate(selection())}>
          <Focus size={16} />
        </IconButton>
        <IconButton label={ghosting ? "Turn X-ray off" : "X-ray everything except the selection (X)"} active={ghosting} disabled={!ghosting && selectionCount === 0} onClick={() => void engine.ghostExcept(ghosting ? {} : selection())}>
          <Ghost size={16} />
        </IconButton>
        <IconButton label="Show everything (Shift+A)" disabled={!visibilityModified && !ghosting} onClick={() => void engine.showAll()}>
          <Eye size={16} />
        </IconButton>
        <Divider />
        <IconButton label="Fit model (F)" disabled={!hasModels} onClick={() => void (selectionCount > 0 ? engine.fitTo(selection()) : engine.fitAll())}>
          <Maximize size={16} />
        </IconButton>
        <Menu
          side="top"
          width={150}
          trigger={({ toggle }) => (
            <IconButton label="Standard views" disabled={!hasModels} onClick={toggle}>
              <Axis3d size={16} />
            </IconButton>
          )}
          items={VIEWS.map((view) => ({ label: view.label, onSelect: () => void engine.setView(view.id) }))}
        />
        <IconButton
          label={projection === "Perspective" ? "Perspective camera (click for orthographic)" : "Orthographic camera (click for perspective)"}
          active={projection === "Orthographic"}
          onClick={() => void engine.setProjection(projection === "Perspective" ? "Orthographic" : "Perspective")}
        >
          <Diameter size={16} />
        </IconButton>
        <Menu
          side="top"
          width={190}
          trigger={({ toggle }) => (
            <IconButton label={`Navigation: ${navMode}`} onClick={toggle}>
              {navMode === "Orbit" ? <Orbit size={16} /> : navMode === "FirstPerson" ? <Footprints size={16} /> : <Move3d size={16} />}
            </IconButton>
          )}
          items={[
            { label: "Orbit", icon: <Orbit size={14} />, onSelect: () => engine.setNavMode("Orbit") },
            { label: "First person (WASD)", icon: <Footprints size={14} />, onSelect: () => engine.setNavMode("FirstPerson") },
            { label: "Plan (pan and zoom)", icon: <Move3d size={14} />, onSelect: () => engine.setNavMode("Plan") },
          ]}
        />
        <Divider />
        <IconButton
          label={renderStyle !== "basic" ? "Grid (shown in the Fast render style only)" : grid ? "Hide grid" : "Show grid"}
          active={grid && renderStyle === "basic"}
          disabled={renderStyle !== "basic"}
          onClick={() => engine.setGridVisible(!grid)}
        >
          <Grid3x3 size={16} />
        </IconButton>
        <Menu
          side="top"
          align="end"
          width={210}
          trigger={({ toggle }) => (
            <IconButton label="Render style" active={renderStyle !== "basic"} onClick={toggle}>
              {renderStyle === "basic" ? <Layers size={16} /> : <Sparkles size={16} />}
            </IconButton>
          )}
          items={[
            { label: `${renderStyle === "basic" ? "● " : ""}Fast (no effects)`, onSelect: () => engine.setRenderStyle("basic") },
            { label: `${renderStyle === "pen" ? "● " : ""}Outlined edges`, onSelect: () => engine.setRenderStyle("pen") },
            { label: `${renderStyle === "shadows" ? "● " : ""}Outlines and soft shadows`, onSelect: () => engine.setRenderStyle("shadows") },
          ]}
        />
      </div>
    </div>
  );
}
