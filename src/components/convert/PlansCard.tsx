"use client";

import { FileImage, PencilRuler } from "lucide-react";
import { Badge, Button } from "@/components/ui/primitives";
import { updatePlan, useConvertStore } from "@/lib/convert/store";
import { formatNumber } from "@/lib/utils/format";
import { Card } from "./parts";

export function PlansCard() {
  const plans = useConvertStore((s) => s.plans);
  return (
    <Card step={2} title="Floor plans" aside={<FileImage size={14} className="text-fg-3" />}>
      {plans.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-fg-3">
          Add plan drawings (PDF pages or images) under Sources. Each page becomes a storey: set its scale, trace the walls, check them, and they are written as walls and a floor slab, on their own or
          together with a model.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="convert-plans">
          {plans.map((plan) => {
            const lengthM = plan.calibration && plan.calibration.metresPerPixel > 0 ? plan.walls.reduce((n, w) => n + Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]), 0) * plan.calibration.metresPerPixel : 0;
            return (
              <li key={plan.id} className="flex items-center gap-2.5 rounded-md border border-line p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={plan.imageUrl} alt="" className="size-14 shrink-0 rounded border border-line bg-white object-contain" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-fg" title={plan.label}>
                    {plan.label}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-fg-3">
                    <span>
                      {plan.storey.name} · {formatNumber(plan.storey.elevation)} m
                    </span>
                    {!plan.calibration || !(plan.calibration.metresPerPixel > 0) ? <Badge tone="warn">Needs a scale</Badge> : plan.walls.length ? <Badge tone="ok">{plan.walls.length} walls · {formatNumber(lengthM, 0)} m</Badge> : <Badge>Not traced</Badge>}
                  </div>
                </div>
                <label className="flex items-center gap-1 text-[11.5px] text-fg-2" title="Include in the IFC">
                  <input type="checkbox" checked={plan.include} onChange={(e) => updatePlan(plan.id, { include: e.target.checked })} className="size-3.5 accent-[var(--accent)]" />
                  Use
                </label>
                <Button size="sm" icon={<PencilRuler size={12} />} onClick={() => useConvertStore.setState({ editingPlan: plan.id })}>
                  Edit
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
