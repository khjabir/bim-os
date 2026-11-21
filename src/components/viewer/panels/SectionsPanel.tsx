"use client";

import { Building, Eye, EyeOff, Layers2, LogOut, Scissors, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Callout, EmptyState, Kbd, SectionTitle, Spinner } from "@/components/ui/primitives";
import { useEngine } from "@/lib/engine/context";
import { useViewerStore } from "@/lib/store";

export function SectionsPanel() {
  const engine = useEngine();
  const hasModels = useViewerStore((state) => state.models.length > 0);
  const tool = useViewerStore((state) => state.tool);
  const planeCount = useViewerStore((state) => state.planeCount);
  const planesEnabled = useViewerStore((state) => state.planesEnabled);
  const plans = useViewerStore((state) => state.plans);
  const activePlan = useViewerStore((state) => state.activePlan);
  const [helpers, setHelpers] = useState(true);
  const [building, setBuilding] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  if (!engine || !hasModels) {
    return (
      <EmptyState icon={<Scissors size={26} strokeWidth={1.5} />} title="No model loaded">
        Open a model to cut it with section planes or to step through storey plans.
      </EmptyState>
    );
  }

  const generatePlans = async () => {
    setBuilding(true);
    setPlanError(null);
    try {
      const created = await engine.createPlans();
      if (created.length === 0) setPlanError("No IfcBuildingStorey was found in the loaded models.");
    } catch (reason) {
      setPlanError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="border-b border-line p-3">
        <SectionTitle aside={planeCount > 0 ? <span className="tabular text-[11.5px] text-fg-3">{planeCount} active</span> : null}>Section planes</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant={tool === "section" ? "primary" : "secondary"} icon={<Scissors size={12} />} onClick={() => engine.setTool(tool === "section" ? "select" : "section")}>
            {tool === "section" ? "Picking… (Esc to stop)" : "Pick on model"}
          </Button>
          <Button size="sm" onClick={() => engine.addAxisPlane("x")} title="Vertical cut across the X axis">
            Cut X
          </Button>
          <Button size="sm" onClick={() => engine.addAxisPlane("z")} title="Vertical cut across the Z axis">
            Cut Z
          </Button>
          <Button size="sm" onClick={() => engine.addAxisPlane("y")} title="Horizontal cut through the middle">
            Cut height
          </Button>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-fg-3">
          With <span className="font-medium text-fg-2">Pick on model</span> active, double-click any surface to cut there. Drag a plane to move it; press <Kbd>Del</Kbd> over a plane to remove it.
        </p>
        {planeCount > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" icon={planesEnabled ? <EyeOff size={12} /> : <Eye size={12} />} onClick={() => engine.setPlanesEnabled(!planesEnabled)}>
              {planesEnabled ? "Disable cuts" : "Enable cuts"}
            </Button>
            <Button
              size="sm"
              icon={<Layers2 size={12} />}
              onClick={() => {
                engine.setPlanesVisible(!helpers);
                setHelpers(!helpers);
              }}
            >
              {helpers ? "Hide handles" : "Show handles"}
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => engine.clearPlanes()}>
              Remove all
            </Button>
          </div>
        ) : null}
      </div>

      <div className="p-3">
        <SectionTitle>Storey plans</SectionTitle>
        {plans.length === 0 ? (
          <>
            <p className="mb-2 text-[11.5px] leading-relaxed text-fg-3">Creates a top-down, orthographic view cut 1.2 m above each storey.</p>
            <Button size="sm" variant="primary" icon={building ? <Spinner size={12} /> : <Building size={12} />} disabled={building} onClick={() => void generatePlans()}>
              {building ? "Creating plans…" : "Create plans"}
            </Button>
            {planError ? (
              <Callout tone="warn" className="mt-2">
                {planError}
              </Callout>
            ) : null}
          </>
        ) : (
          <>
            {activePlan ? (
              <Button size="sm" variant="primary" icon={<LogOut size={12} />} className="mb-2" onClick={() => engine.closePlan()}>
                Back to 3D
              </Button>
            ) : null}
            <ul className="overflow-hidden rounded-md border border-line">
              {plans.map((plan) => (
                <li key={plan.id} className="border-t border-line/70 first:border-t-0">
                  <button
                    type="button"
                    aria-pressed={activePlan === plan.id}
                    onClick={() => (activePlan === plan.id ? engine.closePlan() : void engine.openPlan(plan.id))}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] ${activePlan === plan.id ? "bg-accent-soft font-medium text-accent" : "text-fg hover:bg-surface-2"}`}
                  >
                    <Building size={13} className="shrink-0 text-fg-3" />
                    <span className="min-w-0 flex-1 truncate">{plan.name}</span>
                  </button>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => void generatePlans()}>
              Recreate plans
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
