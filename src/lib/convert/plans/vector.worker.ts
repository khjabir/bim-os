/// <reference lib="webworker" />
// Vector plans off the main thread: reading DXF files, layer roles, plan
// regions, recognition of walls / openings / rooms / columns, and the line
// work to draw. Drawings stay here between requests (by id); results go back
// in plan pixels.

import { announceReady } from "@/lib/utils/worker-ready";
import { parseDxf, releaseName } from "./dxf";
import { DEFAULT_RECOGNIZE, findRooms, guessUnitScale, recognize, suggestRoles, type LayerRole, type RecognizeOptions } from "./recognize";
import { F_DIM, findPlanRegions, fromDxf, layerPaths, orderRegions, regionTexts, toPx, type PlanView, type Pt, type VectorDrawing } from "./vector";
import type { DrawingInfo, PxColumn, PxOpening, PxRecognized, PxRoom, PxWall, VectorRequest, VectorResponse } from "./vectorTypes";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const drawings = new Map<string, VectorDrawing>();

function info(d: VectorDrawing, extra: Partial<DrawingInfo> = {}): DrawingInfo {
  const counts = new Array<number>(d.layers.length).fill(0);
  for (let i = 0; i < d.segLayer.length; i++) if (!(d.segFlags[i] & F_DIM)) counts[d.segLayer[i]]++;
  for (const f of d.fills) counts[f.layer] += 1;
  for (const t of d.texts) counts[t.layer] += 1;
  const guess = d.unitScale ? null : guessUnitScale(d);
  const scale = d.unitScale ?? guess?.scale ?? null;
  const roles = suggestRoles(d, scale);
  const building = (l: number) => roles[l] === "wall" || roles[l] === "door" || roles[l] === "window" || roles[l] === "column";
  let regions = orderRegions(findPlanRegions(d, building));
  if (!regions.length) regions = [d.bbox];
  return {
    layers: d.layers.map((l, i) => ({ name: l.name, color: l.color, off: l.off, count: counts[i] })),
    unitScale: d.unitScale,
    unitLabel: d.unitLabel,
    unitGuess: guess,
    roles,
    regions,
    bbox: d.bbox,
    notes: d.notes,
    version: "",
    binary: false,
    ...extra,
  };
}

const px = (view: PlanView, p: Pt): [number, number] => toPx(view, p[0], p[1]);

function toPxResult(view: PlanView, r: ReturnType<typeof recognize>): PxRecognized {
  const k = view.k;
  const walls: PxWall[] = r.walls.map((w) => ({ a: px(view, w.a), b: px(view, w.b), thickness: w.t * k }));
  const openings: PxOpening[] = r.openings.map((o) => ({
    a: px(view, o.a),
    b: px(view, o.b),
    kind: o.kind,
    // Image y runs down.
    swing: o.swing ? [o.swing[0], -o.swing[1]] : null,
    operation: o.operation,
    name: o.name,
  }));
  const rooms: PxRoom[] = r.rooms.map((room) => ({ outline: room.ring.map((p) => px(view, p)), name: room.name, number: room.number }));
  const columns: PxColumn[] = r.columns.map((c) => ({ outline: c.ring ? c.ring.map((p) => px(view, p)) : null, circle: c.circle ? { c: px(view, c.circle.c), r: c.circle.r * k } : null }));
  return { walls, openings, rooms, columns, outline: r.outline.map((p) => px(view, p)), warnings: r.warnings, stats: r.stats };
}

function labelTexts(d: VectorDrawing, roles: LayerRole[], region: [number, number, number, number]) {
  const inRegion = (p: Pt) => p[0] >= region[0] && p[0] <= region[2] && p[1] >= region[1] && p[1] <= region[3];
  const named = d.texts.filter((t) => !(t.flags & F_DIM) && inRegion(t.c) && (roles[t.layer] === "room" || roles[t.layer] === "text"));
  return named.length ? named : d.texts.filter((t) => !(t.flags & F_DIM) && inRegion(t.c) && roles[t.layer] !== "ignore");
}

function handle(req: VectorRequest): VectorResponse["result"] {
  switch (req.type) {
    case "open-dxf": {
      const file = parseDxf(new Uint8Array(req.bytes));
      const d = fromDxf(file);
      drawings.set(req.id, d);
      return info(d, { version: releaseName(file.version), binary: file.binary, paperSpace: file.paperSpace, entities: file.entities.length });
    }
    case "open": {
      drawings.set(req.id, req.drawing);
      return info(req.drawing);
    }
    case "roles": {
      const d = drawings.get(req.id);
      if (!d) throw new Error("The drawing is no longer loaded.");
      return { roles: suggestRoles(d, req.unitScale) };
    }
    case "paths": {
      const d = drawings.get(req.id);
      if (!d) throw new Error("The drawing is no longer loaded.");
      return { paths: layerPaths(d, req.region, req.view), texts: regionTexts(d, req.region, req.view) };
    }
    case "recognize": {
      const d = drawings.get(req.id);
      if (!d) throw new Error("The drawing is no longer loaded.");
      const options: RecognizeOptions = { ...DEFAULT_RECOGNIZE, ...req.settings, unitScale: req.unitScale, roles: req.roles, region: req.region };
      return toPxResult(req.view, recognize(d, options));
    }
    case "rooms": {
      // Plan pixels throughout; unitScale is metres per pixel.
      const texts = (() => {
        const d = req.drawing ? drawings.get(req.drawing.id) : undefined;
        if (!d || !req.drawing) return [];
        return labelTexts(d, req.drawing.roles, req.drawing.region).map((t) => ({ c: px(req.drawing!.view, t.c), text: t.text, h: t.h * req.drawing!.view.k }));
      })();
      const found = findRooms(
        req.walls.map((w) => ({ a: w.a, b: w.b, t: w.thickness, source: "lines" as const })),
        req.columns.map((c) => ({ ring: c.outline, circle: c.circle })),
        [],
        texts,
        req.unitScale,
        { fromWalls: true },
      );
      return { rooms: found.rooms.map((r) => ({ outline: r.ring, name: r.name, number: r.number })), outline: found.outline };
    }
    case "release":
      drawings.delete(req.id);
      return null;
  }
}

ctx.onmessage = (event: MessageEvent<{ seq: number; req: VectorRequest }>) => {
  const { seq, req } = event.data;
  try {
    const result = handle(req);
    ctx.postMessage({ seq, result } satisfies VectorResponse);
  } catch (error) {
    ctx.postMessage({ seq, error: error instanceof Error ? error.message : String(error) } satisfies VectorResponse);
  }
};

announceReady("vector");
