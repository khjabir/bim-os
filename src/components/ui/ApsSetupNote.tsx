"use client";

import { RotateCcw } from "lucide-react";
import { Button, Callout } from "./primitives";

/** Shown where a feature needs Autodesk Platform Services and no credentials are configured. */
export function ApsSetupNote({ onRetry }: { onRetry: () => void }) {
  return (
    <Callout className="mt-2.5">
      <div className="font-medium text-fg">Autodesk Platform Services is not set up</div>
      <ol className="mt-1.5 list-decimal space-y-1 pl-4 marker:text-fg-3">
        <li>
          Create an app at <span className="font-mono text-[11.5px] text-fg">aps.autodesk.com</span> with the Data Management and Model Derivative APIs.
        </li>
        <li>
          Put its credentials in <span className="font-mono text-[11.5px] text-fg">.env.local</span>:
          <pre className="scroll-thin mt-1 overflow-x-auto rounded border border-line bg-surface p-1.5 font-mono text-[11px] text-fg">{"APS_CLIENT_ID=...\nAPS_CLIENT_SECRET=..."}</pre>
        </li>
        <li>
          Restart <span className="font-mono text-[11.5px] text-fg">npm run dev</span>.
        </li>
      </ol>
      <Button size="sm" className="mt-2" icon={<RotateCcw size={12} />} onClick={onRetry}>
        Check again
      </Button>
    </Callout>
  );
}
