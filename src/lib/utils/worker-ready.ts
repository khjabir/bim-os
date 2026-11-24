// Workers say when they listen; clients hold their messages until then.
//
// In production builds a bundled worker's own module can run after the
// worker has started taking messages, and a message that arrives before the
// worker's handler is in place is dropped: the call then waits forever. Each
// worker announces itself once its handler is set; the client queues what it
// sends until that announcement arrives.

const READY = "__workerReady";

// Production builds start every bundled worker from one bootstrap script and
// tell it which code to load in the URL's fragment ("…worker.js#params=…").
// Browsers can hand a new worker the response of an earlier one when the URLs
// differ only after "#", and the new worker then runs the earlier worker's
// code. The bootstrap reads the same parameters from the query string, which
// keeps each worker's URL distinct; workers are created with that instead.
// (`typeof window` is compiled away in client bundles, workers included: test for a document instead.)
const host = globalThis as unknown as { document?: unknown; Worker?: typeof Worker & { __paramsInQuery?: boolean } };
if (host.document !== undefined && typeof host.Worker === "function" && !host.Worker.__paramsInQuery) {
  const Native = host.Worker;
  const toQuery = (url: string | URL): string | URL => {
    const text = String(url);
    const i = text.indexOf("#params=");
    if (i < 0) return url;
    const base = text.slice(0, i);
    return `${base}${base.includes("?") ? "&" : "?"}params=${text.slice(i + 8)}`;
  };
  class QueryParamsWorker extends Native {
    static __paramsInQuery = true;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(toQuery(url), options);
    }
  }
  host.Worker = QueryParamsWorker;
}

/** Worker side: call once the message handler is in place. */
export function announceReady(name: string) {
  (self as unknown as Worker).postMessage({ [READY]: name });
}

export interface ReadyGate {
  /** True when `data` was the ready announcement (the caller ignores it). */
  handle(data: unknown): boolean;
  post(message: unknown, transfer?: Transferable[]): void;
}

/** Client side: wraps a worker's postMessage until the worker named `name` announces itself. */
export function readyGate(worker: Worker, name: string): ReadyGate {
  let ready = false;
  const queue: [unknown, Transferable[]][] = [];
  return {
    handle(data) {
      if (!data || typeof data !== "object" || !(READY in data)) return false;
      const who = (data as Record<string, unknown>)[READY];
      if (who !== name) console.warn(`Worker "${name}" announced itself as "${String(who)}".`);
      ready = true;
      for (const [message, transfer] of queue.splice(0)) worker.postMessage(message, transfer);
      return true;
    },
    post(message, transfer = []) {
      if (ready) worker.postMessage(message, transfer);
      else queue.push([message, transfer]);
    },
  };
}
