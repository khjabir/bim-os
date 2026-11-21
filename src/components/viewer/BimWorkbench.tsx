"use client";

import {
  Bot,
  ClipboardCheck,
  FileCheck2,
  Files,
  FolderTree,
  Group,
  ListTree,
  Scissors,
  Search,
  ShieldAlert,
  Table2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Callout, Spinner } from "@/components/ui/primitives";
import { Toasts } from "@/components/ui/Toasts";
import { resetAssistant } from "@/lib/assistant/session";
import { entriesFromDrop } from "@/lib/collection/files";
import { closeFolderPlan, planFolder } from "@/lib/collection/open";
import { EngineContext } from "@/lib/engine/context";
import { ViewerEngine } from "@/lib/engine/engine";
import { IFC_ACCEPT, openModelFiles } from "@/lib/engine/open-files";
import { takeHandedOffFiles } from "@/lib/handoff";
import { useViewerStore } from "@/lib/store";
import { FolderDialog } from "./FolderDialog";
import { BoxSelectLayer, DropHint, SelectionBar, TaskOverlay } from "./Overlays";
import { Rail, ResizablePanel, type RailItem } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { AssistantPanel } from "./panels/AssistantPanel";
import { ChecksPanel } from "./panels/ChecksPanel";
import { ClashPanel } from "./panels/ClashPanel";
import { GroupsPanel } from "./panels/GroupsPanel";
import { IdsPanel } from "./panels/IdsPanel";
import { ModelsPanel } from "./panels/ModelsPanel";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { QuantitiesPanel } from "./panels/QuantitiesPanel";
import { SearchPanel } from "./panels/SearchPanel";
import { SectionsPanel } from "./panels/SectionsPanel";
import { TreePanel } from "./panels/TreePanel";

type LeftTab = "import" | "models" | "tree" | "search" | "groups" | "sections";
type RightTab = "properties" | "quantities" | "checks" | "clash" | "ids" | "assistant";

const LEFT_TITLES: Record<LeftTab, string> = {
  import: "Import",
  models: "Models",
  tree: "Spatial tree",
  search: "Search",
  groups: "Groups",
  sections: "Sections and plans",
};

const RIGHT_TITLES: Record<RightTab, string> = {
  properties: "Properties",
  quantities: "Quantities",
  checks: "Model health",
  clash: "Clash detection",
  ids: "IDS validation",
  assistant: "Assistant",
};

export interface WorkbenchProps {
  /** File extensions accepted by the open dialog and drop zone. */
  accept?: string;
  /** Custom file handler (the RVT viewer converts before loading). */
  onFiles?: (engine: ViewerEngine, files: File[]) => void;
  /** Extra first tab in the left rail (the RVT import panel). */
  importPanel?: ReactNode;
  dropLabel?: string;
  /** Shown in the middle of the empty viewport. */
  emptyState?: ReactNode;
}

export default function BimWorkbench({ accept = IFC_ACCEPT, onFiles, importPanel, dropLabel = "Drop IFC, ifcZIP or .frag files, or a folder of them", emptyState }: WorkbenchProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<ViewerEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab | null>(importPanel ? "import" : "models");
  const [rightTab, setRightTab] = useState<RightTab | null>("properties");
  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(360);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const hasModels = useViewerStore((state) => state.models.length > 0);
  const selectionCount = useViewerStore((state) => state.selectionCount);

  // --- Engine lifecycle ---------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let instance: ViewerEngine | null = null;
    ViewerEngine.create(container)
      .then((created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        instance = created;
        setEngine(created);
      })
      .catch((reason: unknown) => {
        console.error(reason);
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      setEngine(null);
      resetAssistant(null);
      closeFolderPlan();
      instance?.dispose();
    };
  }, []);

  const handleFiles = useCallback(
    (files: File[]) => {
      if (!engine || files.length === 0) return;
      if (onFiles) onFiles(engine, files);
      else void openModelFiles(engine, files);
    },
    [engine, onFiles],
  );

  // Files another page left for this viewer (an IFC exported from the NWD page).
  useEffect(() => {
    if (!engine) return;
    const files = takeHandedOffFiles();
    if (files.length > 0) handleFiles(files);
  }, [engine, handleFiles]);

  // --- Keyboard shortcuts ---------------------------------------------------
  useEffect(() => {
    if (!engine) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const state = useViewerStore.getState();
      switch (event.key) {
        case "Escape":
          if (state.tool !== "select") {
            engine.cancelMeasurement();
            engine.setTool("select");
          } else if (state.selectionCount > 0) void engine.clearSelection();
          break;
        case "Enter":
          engine.finishMeasurement();
          break;
        case "Delete":
        case "Backspace":
          engine.deleteUnderCursor();
          break;
        case "f":
        case "F":
          void (state.selectionCount > 0 ? engine.fitTo(state.selection) : engine.fitAll());
          break;
        case "h":
        case "H":
          if (state.selectionCount > 0) void engine.hide(state.selection).then(() => engine.clearSelection());
          break;
        case "i":
        case "I":
          if (state.selectionCount > 0) void engine.isolate(state.selection);
          break;
        case "x":
        case "X":
          void engine.ghostExcept(state.ghosting ? {} : state.selection);
          break;
        case "A":
          if (event.shiftKey) void engine.showAll();
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [engine]);

  // --- Drag and drop -------------------------------------------------------------
  const onDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!engine || !event.dataTransfer) return;
    // A dropped folder is planned as a whole; plain files open as before.
    void entriesFromDrop(event.dataTransfer).then(({ files, folder }) => {
      if (folder) void planFolder(engine, folder.entries, folder.name);
      else handleFiles(files);
    });
  };

  const leftItems: RailItem<LeftTab>[] = [
    ...(importPanel ? [{ id: "import" as const, label: "Import", icon: <Zap size={17} /> }] : []),
    { id: "models", label: "Models", icon: <Files size={17} /> },
    { id: "tree", label: "Tree", icon: <ListTree size={17} /> },
    { id: "search", label: "Search", icon: <Search size={17} /> },
    { id: "groups", label: "Groups", icon: <Group size={17} /> },
    { id: "sections", label: "Sections", icon: <Scissors size={17} /> },
  ];
  const rightItems: RailItem<RightTab>[] = [
    { id: "properties", label: "Props", icon: <FolderTree size={17} />, badge: selectionCount > 0 ? <span className="block size-1.5 rounded-full bg-accent" /> : undefined },
    { id: "quantities", label: "Quantities", icon: <Table2 size={17} /> },
    { id: "checks", label: "Health", icon: <ShieldAlert size={17} /> },
    { id: "clash", label: "Clashes", icon: <ClipboardCheck size={17} /> },
    { id: "ids", label: "IDS", icon: <FileCheck2 size={17} /> },
    { id: "assistant", label: "Assistant", icon: <Bot size={17} /> },
  ];

  return (
    <EngineContext.Provider value={engine}>
      <div className="flex h-full min-h-0">
        <Rail items={leftItems} active={leftTab} onChange={setLeftTab} side="left" />
        {leftTab ? (
          <ResizablePanel side="left" width={leftWidth} onWidth={setLeftWidth} title={LEFT_TITLES[leftTab]}>
            {leftTab === "import" ? importPanel : null}
            {leftTab === "models" ? <ModelsPanel accept={accept} onFiles={handleFiles} /> : null}
            {leftTab === "tree" ? <TreePanel /> : null}
            {leftTab === "search" ? <SearchPanel /> : null}
            {leftTab === "groups" ? <GroupsPanel /> : null}
            {leftTab === "sections" ? <SectionsPanel /> : null}
          </ResizablePanel>
        ) : null}

        <section
          className="viewport-bg relative min-w-0 flex-1 overflow-hidden"
          aria-label="3D view"
          onDragEnter={onDragEnter}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <div ref={containerRef} className="absolute inset-0" data-testid="viewport" />
          <BoxSelectLayer />
          {!engine && !error ? (
            <div className="absolute inset-0 grid place-items-center">
              <div className="flex items-center gap-2 text-[12.5px] text-fg-3">
                <Spinner /> Starting the 3D engine…
              </div>
            </div>
          ) : null}
          {error ? (
            <div className="absolute inset-0 grid place-items-center p-6">
              <Callout tone="bad" className="max-w-md">
                <div className="font-medium">The 3D engine could not start</div>
                <div className="mt-1 break-words">{error}</div>
                <div className="mt-1 text-fg-2">WebGL 2 is required. Check that hardware acceleration is enabled in your browser.</div>
              </Callout>
            </div>
          ) : null}
          {engine && !hasModels && !dragging ? <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">{emptyState}</div> : null}
          <SelectionBar />
          <TaskOverlay />
          <Toolbar />
          <Toasts />
          <DropHint visible={dragging} label={dropLabel} />
          <FolderDialog />
        </section>

        {rightTab ? (
          <ResizablePanel side="right" width={rightWidth} onWidth={setRightWidth} title={RIGHT_TITLES[rightTab]} min={300} max={760}>
            {rightTab === "properties" ? <PropertiesPanel /> : null}
            {rightTab === "quantities" ? <QuantitiesPanel /> : null}
            {rightTab === "checks" ? <ChecksPanel /> : null}
            {rightTab === "clash" ? <ClashPanel /> : null}
            {rightTab === "ids" ? <IdsPanel /> : null}
            {rightTab === "assistant" ? <AssistantPanel /> : null}
          </ResizablePanel>
        ) : null}
        <Rail items={rightItems} active={rightTab} onChange={setRightTab} side="right" />
      </div>
    </EngineContext.Provider>
  );
}
