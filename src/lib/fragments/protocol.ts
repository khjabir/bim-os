// Messages between the main thread and the Fragments packing worker.

import type { MergedSource } from "./merge-fragments.mjs";

/** Announce the size of all models, then add them one by one, then finish. */
export type PackRequest =
  | { type: "start"; totalBytes: number }
  | { type: "add"; name: string; buffer: ArrayBuffer }
  | { type: "finish"; name: string; id: string };

export type PackResponse =
  | { type: "added"; items: number; elements: number }
  | { type: "progress"; done: number; total: number }
  | { type: "combined"; blob: Blob; rawBytes: number; items: number; elements: number; models: MergedSource[] }
  | { type: "error"; message: string };
