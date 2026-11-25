// Main-thread side of the vector plan worker.

import { readyGate, type ReadyGate } from "@/lib/utils/worker-ready";
import type { PictureOptions } from "./raster";
import type { LayerRole } from "./recognize";
import type { LayerPaths, PlanView, VectorDrawing, regionTexts } from "./vector";
import type { DrawingInfo, NoteTextPx, PictureInfo, PictureTexts, PxColumn, PxRecognized, PxRoom, PxWall, RecognizeSettings, VectorRequest, VectorResponse } from "./vectorTypes";

type Box = [number, number, number, number];

let worker: Worker | null = null;
let gate: ReadyGate | null = null;
let seq = 1;
const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): ReadyGate {
  if (worker && gate) return gate;
  worker = new Worker(new URL("./vector.worker.ts", import.meta.url), { type: "module" });
  const own = (gate = readyGate(worker, "vector"));
  worker.onmessage = (event: MessageEvent<VectorResponse>) => {
    if (own.handle(event.data)) return;
    const entry = pending.get(event.data.seq);
    if (!entry) return;
    pending.delete(event.data.seq);
    if (event.data.error !== undefined) entry.reject(new Error(event.data.error));
    else entry.resolve(event.data.result);
  };
  worker.onerror = (event) => {
    for (const entry of pending.values()) entry.reject(new Error(event.message || "The plan reader stopped (most likely out of memory)."));
    pending.clear();
    worker?.terminate();
    worker = null;
    gate = null;
  };
  return own;
}

function call<T>(req: VectorRequest, transfer: Transferable[] = []): Promise<T> {
  const id = seq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
    getWorker().post({ seq: id, req }, transfer);
  });
}

export const vectorPlans = {
  openDxf: (id: string, bytes: ArrayBuffer) => call<DrawingInfo>({ type: "open-dxf", id, bytes }, [bytes]),
  open: (id: string, drawing: VectorDrawing) => call<DrawingInfo>({ type: "open", id, drawing }),
  roles: (id: string, unitScale: number | null) => call<{ roles: LayerRole[] }>({ type: "roles", id, unitScale }),
  paths: (id: string, region: Box, view: PlanView) => call<{ paths: LayerPaths[]; texts: ReturnType<typeof regionTexts> }>({ type: "paths", id, region, view }),
  recognize: (id: string, region: Box, view: PlanView, roles: LayerRole[], unitScale: number, settings: RecognizeSettings) => call<PxRecognized>({ type: "recognize", id, region, view, roles, unitScale, settings }),
  rooms: (walls: PxWall[], columns: PxColumn[], unitScale: number, drawing?: { id: string; region: Box; view: PlanView; roles: LayerRole[] }) =>
    call<{ rooms: PxRoom[]; outline: [number, number][] }>({ type: "rooms", walls, columns, unitScale, drawing }),
  /** A picture read as line work (the grey values are copied, the plan keeps its own). */
  openPicture: (id: string, width: number, height: number, gray: Uint8Array, options: PictureOptions) => {
    const copy = gray.slice();
    return call<PictureInfo>({ type: "open-picture", id, width, height, gray: copy, options }, [copy.buffer]);
  },
  pictureTexts: (id: string, texts: { box: number; text: string }[], metresPerPixelAtFullSize: number | null, sizeLabel: string | null) =>
    call<PictureTexts>({ type: "picture-texts", id, texts, metresPerPixelAtFullSize, sizeLabel }),
  areaCheck: (id: string, rooms: [number, number][][], view: PlanView, unitScale: number) => call<{ factor: number; support: number } | null>({ type: "area-check", id, rooms, view, unitScale }),
  roomAt: (walls: PxWall[], columns: PxColumn[], unitScale: number, at: [number, number], drawing?: { id: string; region: Box; view: PlanView; roles: LayerRole[] }) =>
    call<PxRoom | null>({ type: "room-at", walls, columns, unitScale, at, drawing }),
  /** The drawing's texts outside the other plans' areas, in this plan's pixels (for its notes). */
  noteTexts: (id: string, view: PlanView, exclude: Box[]) => call<NoteTextPx[]>({ type: "note-texts", id, view, exclude }),
  release: (id: string) => call<null>({ type: "release", id }),
};
