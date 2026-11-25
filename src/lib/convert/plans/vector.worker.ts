/// <reference lib="webworker" />
// Vector plans off the main thread: reading DXF files, layer roles, plan
// regions, recognition of walls / openings / rooms / columns, and the line
// work to draw. Drawings stay here between requests (by id); results go back
// in plan pixels.

import { announceReady } from "@/lib/utils/worker-ready";
import { parseDxf, releaseName } from "./dxf";
import { areaCheck, markDimensions, scaleFromDimensions, scaleFromDoors, scaleFromSheet, type ScaleGuess } from "./pictureScale";
import { addTexts, vectorizePicture, type TextBox } from "./raster";
import { DEFAULT_RECOGNIZE, findRooms, guessUnitScale, recognize, roomAt, suggestRoles, type LayerRole, type RecognizeOptions } from "./recognize";
import { F_DIM, findPlanRegions, fromDxf, fromPx, layerPaths, orderRegions, regionTexts, toPx, type PlanView, type Pt, type VectorDrawing } from "./vector";
import type { DrawingInfo, PictureInfo, PictureTexts, PxColumn, PxOpening, PxRecognized, PxRoom, PxWall, VectorRequest, VectorResponse } from "./vectorTypes";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const drawings = new Map<string, VectorDrawing>();
/** Pictures: the lines of text found, and the picture's height (pixels), for the text read later. */
const pictures = new Map<string, { boxes: TextBox[]; height: number }>();

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

/** A picture's pen layers hold every kind of line: never all windows (glazing is still read from lines across wall gaps). */
function pictureRoles(d: VectorDrawing, roles: LayerRole[]): LayerRole[] {
  return roles.map((r, i) => (r === "window" && /lines$/i.test(d.layers[i]?.name ?? "") ? "other" : r));
}

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
    case "open-picture": {
      const pic = vectorizePicture(req.width, req.height, req.gray, req.options);
      drawings.set(req.id, pic.drawing);
      pictures.set(req.id, { boxes: pic.boxes, height: req.height });
      const base = info(pic.drawing);
      const result: PictureInfo = { ...base, roles: pictureRoles(pic.drawing, base.roles), regions: [[0, 0, req.width, req.height]], unitGuess: null, sheets: pic.sheets, boxes: pic.boxes, stats: pic.stats, doors: scaleFromDoors(pic.drawing) };
      return result;
    }
    case "picture-texts": {
      const d = drawings.get(req.id);
      const pic = pictures.get(req.id);
      if (!d || !pic) throw new Error("The picture is no longer loaded.");
      addTexts(d, pic.height, pic.boxes, req.texts);
      const dims = scaleFromDimensions(d);
      markDimensions(d);
      const sheet = scaleFromSheet(d, req.metresPerPixelAtFullSize, req.sizeLabel);
      const roles0 = suggestRoles(d, dims?.scale ?? sheet?.scale ?? null);
      const doors = scaleFromDoors(d, roles0);
      // Written scale and dimensions agreeing: the written one (exact); disagreeing: the dimensions (the resolution may be wrong).
      let scale: ScaleGuess | null = null;
      if (dims && sheet) scale = Math.abs(dims.scale / sheet.scale - 1) <= 0.03 ? { ...sheet, detail: `${sheet.detail}, checked against ${dims.detail}`, support: sheet.support + dims.support } : dims;
      else scale = dims ?? sheet ?? doors;
      const roles = pictureRoles(d, suggestRoles(d, scale?.scale ?? null));
      const counted = info(d);
      const result: PictureTexts = { layers: counted.layers, roles, scale, candidates: [dims, sheet, doors].filter((g): g is ScaleGuess => Boolean(g)), texts: req.texts.length };
      return result;
    }
    case "area-check": {
      const d = drawings.get(req.id);
      if (!d) throw new Error("The drawing is no longer loaded.");
      const rooms = req.rooms.map((ring) => {
        const r = ring.map((p) => fromPx(req.view, p[0], p[1]));
        const xs = r.map((p) => p[0]),
          ys = r.map((p) => p[1]);
        const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        const inRing = (x: number, y: number) => {
          let inside = false;
          for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
          return inside;
        };
        return { ring: r, texts: d.texts.filter((t) => t.c[0] >= box[0] && t.c[0] <= box[2] && t.c[1] >= box[1] && t.c[1] <= box[3] && inRing(t.c[0], t.c[1])).map((t) => t.text) };
      });
      return areaCheck(rooms, req.unitScale);
    }
    case "room-at": {
      const texts = (() => {
        const d = req.drawing ? drawings.get(req.drawing.id) : undefined;
        if (!d || !req.drawing) return [];
        return labelTexts(d, req.drawing.roles, req.drawing.region).map((t) => ({ c: px(req.drawing!.view, t.c), text: t.text, h: t.h * req.drawing!.view.k }));
      })();
      const room = roomAt(
        req.walls.map((w) => ({ a: w.a, b: w.b, t: w.thickness, source: "lines" as const })),
        req.columns.map((c) => ({ ring: c.outline, circle: c.circle })),
        texts,
        req.unitScale,
        req.at,
      );
      return room ? ({ outline: room.ring, name: room.name, number: room.number } satisfies PxRoom) : null;
    }
    case "release":
      drawings.delete(req.id);
      pictures.delete(req.id);
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
