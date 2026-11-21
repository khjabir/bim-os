"use client";

import { EyeOff, Focus, Ghost, MousePointer2, Scan } from "lucide-react";
import { Button } from "@/components/ui/primitives";
import { useEngine } from "@/lib/engine/context";
import type { PlainIdMap } from "@/lib/store";

/** The standard set of actions offered for any list of elements. */
export function ResultActions({ items, disabled, compact }: { items: PlainIdMap; disabled?: boolean; compact?: boolean }) {
  const engine = useEngine();
  const off = disabled || !engine;
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" variant="primary" icon={<MousePointer2 size={12} />} disabled={off} onClick={() => void engine?.select(items)}>
        Select
      </Button>
      <Button size="sm" icon={<Focus size={12} />} disabled={off} onClick={() => void engine?.isolate(items)}>
        Isolate
      </Button>
      <Button size="sm" icon={<EyeOff size={12} />} disabled={off} onClick={() => void engine?.hide(items)}>
        Hide
      </Button>
      {compact ? null : (
        <>
          <Button size="sm" icon={<Ghost size={12} />} disabled={off} onClick={() => void engine?.ghostExcept(items)} title="X-ray everything else">
            X-ray
          </Button>
          <Button size="sm" icon={<Scan size={12} />} disabled={off} onClick={() => void engine?.fitTo(items)}>
            Zoom
          </Button>
        </>
      )}
    </div>
  );
}
