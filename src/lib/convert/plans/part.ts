// Plans in metres for the IFC writer: doors and windows hosted by the walls
// they sit in, found by position so they survive edits to the walls.

import type { PlanOpening, PlanWall } from "../types";

type Pt = [number, number];

export interface OpeningIn {
  a: Pt;
  b: Pt;
  kind: PlanOpening["kind"];
  /** Unit vector the door leaf opens towards (metres frame), or null. */
  swing: Pt | null;
  operation: string | null;
  name: string | null;
  sill: number;
  height: number;
}

/** Hosts each opening in the wall it lies along (nearest centre line within its half thickness); openings with no wall are left out. */
export function attachOpenings(walls: PlanWall[], openings: OpeningIn[]): PlanOpening[] {
  const out: PlanOpening[] = [];
  for (const o of openings) {
    const width = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]);
    if (!(width > 0.05)) continue;
    const dir: Pt = [(o.b[0] - o.a[0]) / width, (o.b[1] - o.a[1]) / width];
    const mid: Pt = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
    let best = -1;
    let bestD = Infinity;
    walls.forEach((w, i) => {
      const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      if (L < width * 0.5) return;
      const u: Pt = [(w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L];
      if (Math.abs(u[0] * dir[0] + u[1] * dir[1]) < Math.cos((10 * Math.PI) / 180)) return;
      const rel: Pt = [mid[0] - w.a[0], mid[1] - w.a[1]];
      const s = rel[0] * u[0] + rel[1] * u[1];
      const d = Math.abs(-u[1] * rel[0] + u[0] * rel[1]);
      if (d > w.thickness / 2 + 0.1 || s < -0.05 || s > L + 0.05) return;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0) continue;
    const w = walls[best];
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const u: Pt = [(w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L];
    const sa = (o.a[0] - w.a[0]) * u[0] + (o.a[1] - w.a[1]) * u[1];
    const sb = (o.b[0] - w.a[0]) * u[0] + (o.b[1] - w.a[1]) * u[1];
    const width2 = Math.min(Math.abs(sb - sa), L);
    const offset = Math.max(0, Math.min(L - width2, Math.min(sa, sb)));
    const left: Pt = [-u[1], u[0]];
    const side = o.swing ? o.swing[0] * left[0] + o.swing[1] * left[1] : 0;
    out.push({
      wall: best,
      kind: o.kind,
      offset,
      width: width2,
      sill: o.sill,
      height: o.height,
      operation: o.kind === "door" ? o.operation : null,
      swingSide: side > 0.1 ? 1 : side < -0.1 ? -1 : 0,
      name: o.name,
    });
  }
  return out;
}
