// Plan tracing worker: wall and outline tracing off the main thread.

import { announceReady } from "@/lib/utils/worker-ready";
import { trace, type TraceOptions } from "./trace";

interface Request {
  id: number;
  width: number;
  height: number;
  gray: Uint8Array;
  options: TraceOptions;
}

self.addEventListener("message", (event: MessageEvent<Request>) => {
  const { id, width, height, gray, options } = event.data;
  try {
    const result = trace({ width, height, gray }, options);
    (self as unknown as Worker).postMessage({ id, result });
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});

announceReady("trace");
