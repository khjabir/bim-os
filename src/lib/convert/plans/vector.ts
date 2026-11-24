// A floor plan as vector line work, whatever it came from (DXF, a PDF page's
// paths): flat lists of segments, true arcs, closed outlines, fills, texts and
// block references, all in drawing units with y up, each tagged with its
// layer. Recognition (recognize.ts) reads this; the editor draws it.
//
// fromDxf() explodes block references (nested, mirrored, arrays), applies the
// entity planes (OCS), resolves layer 0 and BYBLOCK inheritance, and flattens
// curves to segments while keeping arcs and circles as arcs too (door swings
// and round columns are recognised from them).

import { bulgeEdge, type DxfEntity, type DxfFile, type DxfText, type HatchEdge, type V2, type V3, unitsToMetres, UNIT_LABELS } from "./dxf";

export type Pt = [number, number];
/** 2D affine transform [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function mul(m: Affine, n: Affine): Affine {
  // m · n (n applied first)
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

export function apply(m: Affine, x: number, y: number): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const det = (m: Affine) => m[0] * m[3] - m[1] * m[2];

/** Segment flags. */
export const F_DIM = 1; // part of a dimension
export const F_WIDE = 2; // centre line of a wide polyline
export const F_CLOSED = 4; // edge of a closed outline
export const F_CURVE = 8; // part of a flattened arc or circle (kept as an arc too)

export interface VLayer {
  name: string;
  /** "#rrggbb" as the file defines it. */
  color: string;
  /** Off or frozen in the source drawing. */
  off: boolean;
}

export interface VArc {
  c: Pt;
  r: number;
  /** Radians, counter-clockwise from a0 to a1 (a1 > a0; a full circle is 0 .. 2π). */
  a0: number;
  a1: number;
  layer: number;
  symbol: number;
  flags: number;
}

export interface VPoly {
  points: Pt[];
  layer: number;
  symbol: number;
  flags: number;
}

export interface VFill {
  rings: Pt[][];
  layer: number;
  symbol: number;
  /** Solid fill (hatch pattern SOLID, SOLID / TRACE entities, filled PDF paths). */
  solid: boolean;
  flags: number;
}

export interface VStrip {
  points: Pt[];
  width: number;
  closed: boolean;
  layer: number;
  symbol: number;
}

export interface VText {
  /** Approximate centre of the text. */
  c: Pt;
  text: string;
  /** Height in drawing units. */
  h: number;
  /** Radians. */
  rotation: number;
  layer: number;
  symbol: number;
  flags: number;
}

export interface VSymbol {
  /** Block name (DXF), or a label for grouped PDF content. */
  name: string;
  layer: number;
  /** Enclosing symbol (nested block references), -1 at the top. */
  parent: number;
  m: Affine;
  bbox: [number, number, number, number] | null;
  attribs: Record<string, string>;
}

export interface VectorDrawing {
  source: "dxf" | "pdf";
  /** Metres per drawing unit when the file says; null when unitless. */
  unitScale: number | null;
  unitLabel: string;
  layers: VLayer[];
  /** x0, y0, x1, y1 per segment. */
  segs: Float64Array;
  segLayer: Int32Array;
  segSymbol: Int32Array;
  segFlags: Uint8Array;
  arcs: VArc[];
  polys: VPoly[];
  fills: VFill[];
  strips: VStrip[];
  texts: VText[];
  symbols: VSymbol[];
  bbox: [number, number, number, number];
  /** Notes for the report: entity types left out, block nesting cut short, … */
  notes: string[];
}

export const segCount = (d: VectorDrawing) => d.segLayer.length;

// ---------------------------------------------------------------------------
// Colours

/** AutoCAD colour index -> "#rrggbb". */
export function aciColor(aci: number): string {
  const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
  const base = ["#000000", "#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ffffff", "#808080", "#c0c0c0"];
  if (aci >= 0 && aci <= 9) return base[aci];
  if (aci >= 250 && aci <= 255) return ["#333333", "#505050", "#696969", "#828282", "#bebebe", "#ffffff"][aci - 250];
  if (aci < 10 || aci > 249) return "#ffffff";
  const k = aci - 10;
  const hue = Math.floor(k / 10) * 15;
  const shade = k % 10;
  const value = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3][shade];
  const sat = shade % 2 === 0 ? 1 : 0.5;
  // HSV -> RGB
  const c = value * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = value - c;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return hex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** A colour readable on white paper: light colours (white, yellow, cyan) darkened. */
export function paperColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16),
    g = parseInt(hex.slice(3, 5), 16),
    b = parseInt(hex.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum < 0.62) return hex;
  const f = lum > 0.95 ? 0.2 : 0.55;
  return `#${[r, g, b].map((v) => Math.round(v * f).toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Builder

class Grow {
  data: Float64Array;
  length = 0;
  constructor(n = 4096) {
    this.data = new Float64Array(n);
  }
  push4(a: number, b: number, c: number, d: number) {
    if (this.length + 4 > this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
    this.data[this.length++] = d;
  }
}

class IntGrow {
  data: Int32Array;
  length = 0;
  constructor(n = 1024) {
    this.data = new Int32Array(n);
  }
  push(v: number) {
    if (this.length + 1 > this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
}

export class DrawingBuilder {
  readonly layers: VLayer[] = [];
  private readonly layerIndex = new Map<string, number>();
  private readonly segs = new Grow();
  private readonly segLayer = new IntGrow();
  private readonly segSymbol = new IntGrow();
  private readonly segFlags = new IntGrow();
  readonly arcs: VArc[] = [];
  readonly polys: VPoly[] = [];
  readonly fills: VFill[] = [];
  readonly strips: VStrip[] = [];
  readonly texts: VText[] = [];
  readonly symbols: VSymbol[] = [];
  readonly notes: string[] = [];
  /** Angular step limit for curves (radians) and the largest sagitta in drawing units (0: relative only). */
  maxStep = (8 * Math.PI) / 180;
  sagitta = 0;

  layer(name: string, color = "#ffffff", off = false): number {
    let i = this.layerIndex.get(name);
    if (i === undefined) {
      i = this.layers.length;
      this.layers.push({ name, color, off });
      this.layerIndex.set(name, i);
    }
    return i;
  }

  hasLayer(name: string) {
    return this.layerIndex.has(name);
  }

  seg(x0: number, y0: number, x1: number, y1: number, layer: number, symbol: number, flags: number) {
    if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1))) return;
    if (x0 === x1 && y0 === y1) return;
    this.segs.push4(x0, y0, x1, y1);
    this.segLayer.push(layer);
    this.segSymbol.push(symbol);
    this.segFlags.push(flags);
  }

  polyline(points: Pt[], closed: boolean, layer: number, symbol: number, flags: number) {
    for (let i = 0; i + 1 < points.length; i++) this.seg(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], layer, symbol, flags | (closed ? F_CLOSED : 0));
    if (closed && points.length > 2) {
      const a = points[points.length - 1],
        b = points[0];
      if (a[0] !== b[0] || a[1] !== b[1]) this.seg(a[0], a[1], b[0], b[1], layer, symbol, flags | F_CLOSED);
    }
  }

  /** Steps for an arc of radius r (drawing units) sweeping `sweep` radians. */
  steps(r: number, sweep: number): number {
    let step = this.maxStep;
    if (r > 0) {
      const rel = 2 * Math.acos(1 - 0.004);
      step = Math.min(step, rel);
      if (this.sagitta > 0 && this.sagitta < r) step = Math.min(step, 2 * Math.acos(1 - this.sagitta / r));
    }
    return Math.max(2, Math.min(720, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-3))));
  }

  build(source: "dxf" | "pdf", unitScale: number | null, unitLabel: string): VectorDrawing {
    const n = this.segLayer.length;
    const segs = this.segs.data.slice(0, n * 4);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = 0; i < n * 4; i += 2) {
      const x = segs[i],
        y = segs[i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    for (const t of this.texts) {
      x0 = Math.min(x0, t.c[0]);
      x1 = Math.max(x1, t.c[0]);
      y0 = Math.min(y0, t.c[1]);
      y1 = Math.max(y1, t.c[1]);
    }
    for (const f of this.fills)
      for (const ring of f.rings)
        for (const p of ring) {
          x0 = Math.min(x0, p[0]);
          x1 = Math.max(x1, p[0]);
          y0 = Math.min(y0, p[1]);
          y1 = Math.max(y1, p[1]);
        }
    if (!(x1 >= x0)) {
      x0 = y0 = 0;
      x1 = y1 = 1;
    }
    const drawing: VectorDrawing = {
      source,
      unitScale,
      unitLabel,
      layers: this.layers,
      segs,
      segLayer: this.segLayer.data.slice(0, n),
      segSymbol: this.segSymbol.data.slice(0, n),
      segFlags: Uint8Array.from(this.segFlags.data.subarray(0, n)),
      arcs: this.arcs,
      polys: this.polys,
      fills: this.fills,
      strips: this.strips,
      texts: this.texts,
      symbols: this.symbols,
      bbox: [x0, y0, x1, y1],
      notes: this.notes,
    };
    symbolBounds(drawing);
    return drawing;
  }
}

/** Bounding boxes of the symbols, from the primitives drawn inside them (and their nested symbols). */
function symbolBounds(d: VectorDrawing) {
  const boxes = d.symbols.map(() => [Infinity, Infinity, -Infinity, -Infinity]);
  const grow = (s: number, x: number, y: number) => {
    for (let k = s; k >= 0; k = d.symbols[k].parent) {
      const b = boxes[k];
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  };
  const n = d.segLayer.length;
  for (let i = 0; i < n; i++) {
    const s = d.segSymbol[i];
    if (s < 0) continue;
    grow(s, d.segs[i * 4], d.segs[i * 4 + 1]);
    grow(s, d.segs[i * 4 + 2], d.segs[i * 4 + 3]);
  }
  for (const f of d.fills) if (f.symbol >= 0) for (const ring of f.rings) for (const p of ring) grow(f.symbol, p[0], p[1]);
  d.symbols.forEach((sym, i) => {
    const b = boxes[i];
    sym.bbox = b[2] >= b[0] ? [b[0], b[1], b[2], b[3]] : null;
  });
}

// ---------------------------------------------------------------------------
// Curves

/** Points of a circular arc (radians, counter-clockwise from a0 to a1), in the arc's own plane. */
export function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, steps: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** Normalises an arc to a0 in [0, 2π) and a1 in (a0, a0 + 2π]. */
export function normalizeArc(a0: number, a1: number): [number, number] {
  const TAU = Math.PI * 2;
  let s = ((a0 % TAU) + TAU) % TAU;
  let e = ((a1 % TAU) + TAU) % TAU;
  if (e <= s + 1e-12) e += TAU;
  if (Math.abs(s) < 1e-12 && Math.abs(e - TAU) < 1e-12) {
    s = 0;
    e = TAU;
  }
  return [s, e];
}

/** Points of a (rational) B-spline, or of its fit points when it has no control points. */
export function splinePoints(degree: number, knots: number[], control: Pt[], weights: number[], fit: Pt[], samples: number): Pt[] {
  const n = control.length;
  if (n < 2) return fit.length >= 2 ? fit.slice() : control.slice();
  const p = Math.max(1, Math.min(degree, n - 1));
  let U = knots;
  if (U.length !== n + p + 1) {
    // Clamped uniform knots.
    U = [];
    for (let i = 0; i <= p; i++) U.push(0);
    for (let i = 1; i < n - p; i++) U.push(i / (n - p));
    for (let i = 0; i <= p; i++) U.push(1);
  }
  const w = weights.length === n ? weights : null;
  const lo = U[p],
    hi = U[n];
  const out: Pt[] = [];
  const total = Math.max(samples, n * 4);
  for (let s = 0; s <= total; s++) {
    let u = lo + ((hi - lo) * s) / total;
    if (u >= hi) u = hi - 1e-12 * Math.max(1, Math.abs(hi));
    // Knot span
    let k = p;
    while (k < n - 1 && U[k + 1] <= u) k++;
    // de Boor
    const d: [number, number, number][] = [];
    for (let j = 0; j <= p; j++) {
      const i = k - p + j;
      const wi = w ? w[i] : 1;
      d.push([control[i][0] * wi, control[i][1] * wi, wi]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = U[i + p - r + 1] - U[i];
        const a = den === 0 ? 0 : (u - U[i]) / den;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
    }
    const [x, y, wt] = d[p];
    out.push([x / (wt || 1), y / (wt || 1)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DXF

/** OCS -> WCS on the XY plane, as an affine (plus the elevation's offset). */
function ocsAffine(normal: V3 | null, elevation = 0): Affine {
  if (!normal) return [1, 0, 0, 1, 0, 0];
  const [nx, ny, nz] = normal;
  let ax: V3;
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) ax = [nz, 0, -nx]; // Wy × N
  else ax = [-ny, nx, 0]; // Wz × N
  let L = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  ax = [ax[0] / L, ax[1] / L, ax[2] / L];
  let ay: V3 = [ny * ax[2] - nz * ax[1], nz * ax[0] - nx * ax[2], nx * ax[1] - ny * ax[0]];
  L = Math.hypot(ay[0], ay[1], ay[2]) || 1;
  ay = [ay[0] / L, ay[1] / L, ay[2] / L];
  return [ax[0], ax[1], ay[0], ay[1], nx * elevation, ny * elevation];
}

interface Ctx {
  m: Affine;
  /** Layer for entities on layer "0" (the enclosing reference's), -1 at the top. */
  layer: number;
  symbol: number;
  flags: number;
  depth: number;
  stack: string[];
}

export function fromDxf(file: DxfFile): VectorDrawing {
  const b = new DrawingBuilder();
  for (const layer of file.layers.values()) b.layer(layer.name, layer.trueColor !== null ? `#${layer.trueColor.toString(16).padStart(6, "0")}` : aciColor(layer.color), layer.off || layer.frozen);
  const unitScale = unitsToMetres(file.insUnits);
  // Curves: sagitta at most 2 mm when the units are known.
  if (unitScale) b.sagitta = 0.002 / unitScale;
  let cut = 0;

  const layerOf = (name: string, ctx: Ctx) => {
    if ((name === "0" || name === "") && ctx.layer >= 0) return ctx.layer;
    return b.layer(name || "0", "#ffffff", false);
  };

  const transformPts = (m: Affine, pts: Pt[]): Pt[] => pts.map((p) => apply(m, p[0], p[1]));

  /** An arc in its OCS under `m`: kept as an arc when m is a similarity, always as segments. */
  const emitArc = (m: Affine, c: Pt, r: number, a0: number, a1: number, layer: number, ctx: Ctx) => {
    const [s, e] = normalizeArc(a0, a1);
    const steps = b.steps(r * Math.sqrt(Math.abs(det(m))), e - s);
    const sx = Math.hypot(m[0], m[1]),
      sy = Math.hypot(m[2], m[3]);
    const ortho = Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9 * sx * sy;
    const similar = Math.abs(sx - sy) <= 1e-6 * Math.max(sx, sy) && ortho;
    // Segments of arcs that stay arcs are marked, so straight-wall matching can leave them to the arc matching.
    b.polyline(transformPts(m, arcPoints(c[0], c[1], r, s, e, steps)), false, layer, ctx.symbol, ctx.flags | (similar ? F_CURVE : 0));
    if (similar) {
      const cc = apply(m, c[0], c[1]);
      const full = e - s >= Math.PI * 2 - 1e-9;
      if (full) b.arcs.push({ c: cc, r: r * sx, a0: 0, a1: Math.PI * 2, layer, symbol: ctx.symbol, flags: ctx.flags });
      else {
        const ps = apply(m, c[0] + r * Math.cos(s), c[1] + r * Math.sin(s));
        const pe = apply(m, c[0] + r * Math.cos(e), c[1] + r * Math.sin(e));
        let as = Math.atan2(ps[1] - cc[1], ps[0] - cc[0]);
        let ae = Math.atan2(pe[1] - cc[1], pe[0] - cc[0]);
        if (det(m) < 0) [as, ae] = [ae, as];
        const [ns, ne] = normalizeArc(as, ae);
        b.arcs.push({ c: cc, r: r * sx, a0: ns, a1: ne, layer, symbol: ctx.symbol, flags: ctx.flags });
      }
    }
  };

  const edgePoints = (edge: HatchEdge, scaleHint: number): Pt[] => {
    switch (edge.kind) {
      case "line":
        return [edge.a, edge.b];
      case "arc": {
        const [s, e] = normalizeArc((edge.start * Math.PI) / 180, (edge.end * Math.PI) / 180);
        const pts = arcPoints(edge.c[0], edge.c[1], edge.r, s, e, b.steps(edge.r * scaleHint, e - s));
        return edge.ccw ? pts : pts.reverse();
      }
      case "ellipse": {
        const ratio = edge.ratio || 1;
        const toParam = (deg: number) => {
          const a = (deg * Math.PI) / 180;
          return Math.atan2(Math.sin(a) / ratio, Math.cos(a));
        };
        const [s, e] = normalizeArc(toParam(edge.start), toParam(edge.end));
        const R = Math.hypot(edge.major[0], edge.major[1]);
        const ux = edge.major[0] / (R || 1),
          uy = edge.major[1] / (R || 1);
        const steps = b.steps(R * scaleHint, e - s);
        const pts: Pt[] = [];
        for (let i = 0; i <= steps; i++) {
          const t = s + ((e - s) * i) / steps;
          const x = R * Math.cos(t),
            y = R * ratio * Math.sin(t);
          pts.push([edge.c[0] + x * ux - y * uy, edge.c[1] + x * uy + y * ux]);
        }
        return edge.ccw ? pts : pts.reverse();
      }
      case "spline":
        return splinePoints(edge.degree, edge.knots, edge.control, edge.weights, edge.fit, 24);
    }
  };

  const textOf = (t: DxfText, m: Affine, layer: number, ctx: Ctx) => {
    if (!t.text.trim()) return;
    const mo = t.mtext ? m : mul(m, ocsAffine(t.normal));
    const rot = (t.rotation * Math.PI) / 180;
    const dir: Pt = [Math.cos(rot), Math.sin(rot)];
    const up: Pt = [-dir[1], dir[0]];
    const lines = t.text.split("\n");
    const longest = Math.max(...lines.map((l) => l.length));
    let cx: number, cy: number;
    if (t.mtext) {
      const w = t.mtext.width > 0 ? Math.min(t.mtext.width, longest * t.h * 0.65) : longest * t.h * 0.65;
      const hh = t.h * (1 + (lines.length - 1) * 1.67);
      const col = (t.mtext.attach - 1) % 3;
      const row = Math.floor((t.mtext.attach - 1) / 3);
      const ox = (w / 2) * (1 - col);
      const oy = (hh / 2) * (row - 1);
      cx = t.p[0] + dir[0] * ox + up[0] * oy;
      cy = t.p[1] + dir[1] * ox + up[1] * oy;
    } else {
      const w = longest * t.h * 0.6 * t.widthFactor;
      const anchor = t.align ?? t.p;
      let ox = 0;
      if (t.hAlign === 0) ox = w / 2;
      else if (t.hAlign === 2) ox = -w / 2;
      else if (t.hAlign === 3 || t.hAlign === 5) {
        // Aligned / fit: between the two points.
        const a = t.p,
          e = t.align ?? t.p;
        cx = (a[0] + e[0]) / 2 + up[0] * (t.h / 2);
        cy = (a[1] + e[1]) / 2 + up[1] * (t.h / 2);
        const c = apply(mo, cx, cy);
        pushText(c, t, mo, rot, layer, ctx);
        return;
      }
      const oy = t.hAlign === 4 || t.vAlign === 2 ? 0 : t.vAlign === 3 ? -t.h / 2 : t.h / 2;
      cx = anchor[0] + dir[0] * ox + up[0] * oy;
      cy = anchor[1] + dir[1] * ox + up[1] * oy;
    }
    pushText(apply(mo, cx, cy), t, mo, rot, layer, ctx);
  };

  const pushText = (c: Pt, t: DxfText, m: Affine, rot: number, layer: number, ctx: Ctx) => {
    const p0 = apply(m, 0, 0);
    const pu = apply(m, -Math.sin(rot) * t.h, Math.cos(rot) * t.h);
    const pd = apply(m, Math.cos(rot), Math.sin(rot));
    b.texts.push({ c, text: t.text, h: Math.hypot(pu[0] - p0[0], pu[1] - p0[1]), rotation: Math.atan2(pd[1] - p0[1], pd[0] - p0[0]), layer, symbol: ctx.symbol, flags: ctx.flags });
  };

  const explode = (entities: DxfEntity[], ctx: Ctx) => {
    for (const e of entities) {
      const layer = layerOf(e.layer, ctx);
      switch (e.type) {
        case "LINE": {
          const a = apply(ctx.m, e.a[0], e.a[1]);
          const c = apply(ctx.m, e.b[0], e.b[1]);
          b.seg(a[0], a[1], c[0], c[1], layer, ctx.symbol, ctx.flags);
          break;
        }
        case "POLYLINE": {
          const m = e.wcs ? ctx.m : mul(ctx.m, ocsAffine(e.normal, e.points[0]?.[2] ?? 0));
          // Path with bulges as arcs.
          const pts: Pt[] = [];
          const count = e.points.length;
          const segsN = e.closed ? count : count - 1;
          const scale = Math.sqrt(Math.abs(det(m)));
          for (let i = 0; i < segsN; i++) {
            const a: V2 = [e.points[i][0], e.points[i][1]];
            const c: V2 = [e.points[(i + 1) % count][0], e.points[(i + 1) % count][1]];
            const bulge = e.bulges[i] ?? 0;
            if (Math.abs(bulge) > 1e-9) {
              const edge = bulgeEdge(a, c, bulge);
              if (edge.kind === "arc") {
                emitArc(m, edge.c, edge.r, (edge.start * Math.PI) / 180, (edge.end * Math.PI) / 180, layer, { ...ctx, flags: ctx.flags | (e.closed ? F_CLOSED : 0) });
                const [s, en] = normalizeArc((edge.start * Math.PI) / 180, (edge.end * Math.PI) / 180);
                const arc = arcPoints(edge.c[0], edge.c[1], edge.r, s, en, b.steps(edge.r * scale, en - s));
                const ordered = edge.ccw ? arc : arc.reverse();
                if (pts.length === 0) pts.push(apply(m, ordered[0][0], ordered[0][1]));
                for (let k = 1; k < ordered.length; k++) pts.push(apply(m, ordered[k][0], ordered[k][1]));
                continue;
              }
            }
            if (pts.length === 0) pts.push(apply(m, a[0], a[1]));
            pts.push(apply(m, c[0], c[1]));
          }
          if (pts.length < 2) break;
          const closedPts = e.closed && pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts.slice(0, -1) : pts;
          const hasBulge = e.bulges.some((v) => Math.abs(v) > 1e-9);
          if (e.width > 0) {
            const w = e.width * scale;
            b.strips.push({ points: closedPts, width: w, closed: e.closed, layer, symbol: ctx.symbol });
            // The arc parts were already written as arcs; the straight ones go in as the strip's centre line.
            if (!hasBulge) b.polyline(closedPts, e.closed, layer, ctx.symbol, ctx.flags | F_WIDE);
            else for (let i = 0; i + 1 < pts.length; i++) b.seg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], layer, ctx.symbol, ctx.flags | F_WIDE);
          } else if (!hasBulge) b.polyline(closedPts, e.closed, layer, ctx.symbol, ctx.flags);
          else {
            // Straight parts only (arc parts were emitted by emitArc).
            let k = 0;
            for (let i = 0; i < segsN; i++) {
              const bulge = e.bulges[i] ?? 0;
              if (Math.abs(bulge) > 1e-9) {
                const a: V2 = [e.points[i][0], e.points[i][1]];
                const c: V2 = [e.points[(i + 1) % count][0], e.points[(i + 1) % count][1]];
                const edge = bulgeEdge(a, c, bulge);
                if (edge.kind === "arc") {
                  const [s, en] = normalizeArc((edge.start * Math.PI) / 180, (edge.end * Math.PI) / 180);
                  k += b.steps(edge.r * scale, en - s);
                  continue;
                }
              }
              b.seg(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], layer, ctx.symbol, ctx.flags | (e.closed ? F_CLOSED : 0));
              k++;
            }
          }
          if (e.closed && closedPts.length >= 3) b.polys.push({ points: closedPts, layer, symbol: ctx.symbol, flags: ctx.flags });
          break;
        }
        case "ARC": {
          const m = mul(ctx.m, ocsAffine(e.normal, e.c[2]));
          emitArc(m, [e.c[0], e.c[1]], e.r, (e.start * Math.PI) / 180, (e.end * Math.PI) / 180, layer, ctx);
          break;
        }
        case "CIRCLE": {
          const m = mul(ctx.m, ocsAffine(e.normal, e.c[2]));
          emitArc(m, [e.c[0], e.c[1]], e.r, 0, Math.PI * 2, layer, ctx);
          const steps = b.steps(e.r * Math.sqrt(Math.abs(det(m))), Math.PI * 2);
          const ring = transformPts(m, arcPoints(e.c[0], e.c[1], e.r, 0, Math.PI * 2, steps)).slice(0, -1);
          b.polys.push({ points: ring, layer, symbol: ctx.symbol, flags: ctx.flags });
          break;
        }
        case "ELLIPSE": {
          // WCS geometry.
          const R = Math.hypot(e.major[0], e.major[1]);
          const ux = e.major[0] / (R || 1),
            uy = e.major[1] / (R || 1);
          // An ellipse seen from below (normal -Z) runs clockwise on the XY plane.
          const flip = e.normal && e.normal[2] < 0 ? -1 : 1;
          const [s, en] = normalizeArc(e.start, e.end);
          const steps = b.steps(R * Math.sqrt(Math.abs(det(ctx.m))), en - s);
          const pts: Pt[] = [];
          for (let i = 0; i <= steps; i++) {
            const t = s + ((en - s) * i) / steps;
            const x = R * Math.cos(t),
              y = R * e.ratio * Math.sin(t) * flip;
            pts.push(apply(ctx.m, e.c[0] + x * ux - y * uy, e.c[1] + x * uy + y * ux));
          }
          const full = en - s >= Math.PI * 2 - 1e-9;
          b.polyline(full ? pts.slice(0, -1) : pts, full, layer, ctx.symbol, ctx.flags);
          if (full) b.polys.push({ points: pts.slice(0, -1), layer, symbol: ctx.symbol, flags: ctx.flags });
          break;
        }
        case "SPLINE": {
          const pts = splinePoints(
            e.degree,
            e.knots,
            e.control.map((p) => [p[0], p[1]] as Pt),
            e.weights,
            e.fit.map((p) => [p[0], p[1]] as Pt),
            32,
          ).map((p) => apply(ctx.m, p[0], p[1]));
          b.polyline(pts, false, layer, ctx.symbol, ctx.flags);
          break;
        }
        case "TEXT":
          textOf(e, ctx.m, layer, ctx);
          break;
        case "HATCH": {
          const m = mul(ctx.m, ocsAffine(e.normal, e.elevation));
          const scale = Math.sqrt(Math.abs(det(m)));
          const rings: Pt[][] = [];
          for (const loop of e.loops) {
            const ring: Pt[] = [];
            for (const edge of loop) {
              let pts = edgePoints(edge, scale);
              if (pts.length === 0) continue;
              // Keep the boundary continuous whatever direction an edge was stored in.
              if (ring.length) {
                const last = ring[ring.length - 1];
                const d0 = Math.hypot(pts[0][0] - last[0], pts[0][1] - last[1]);
                const d1 = Math.hypot(pts[pts.length - 1][0] - last[0], pts[pts.length - 1][1] - last[1]);
                if (d1 < d0) pts = pts.slice().reverse();
              }
              for (const p of ring.length ? pts.slice(1) : pts) ring.push(p);
            }
            if (ring.length >= 3) {
              const first = ring[0],
                last = ring[ring.length - 1];
              if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) ring.pop();
              rings.push(transformPts(m, ring));
            }
          }
          if (rings.length) b.fills.push({ rings, layer, symbol: ctx.symbol, solid: e.solid || /^solid$/i.test(e.pattern), flags: ctx.flags });
          break;
        }
        case "SOLID": {
          const m = e.wcs ? ctx.m : mul(ctx.m, ocsAffine(e.normal, e.points[0]?.[2] ?? 0));
          const ring = transformPts(
            m,
            e.points.map((p) => [p[0], p[1]] as Pt),
          );
          b.fills.push({ rings: [ring], layer, symbol: ctx.symbol, solid: true, flags: ctx.flags });
          break;
        }
        case "INSERT": {
          const block = file.blocks.get(e.block);
          if (!block || block.xref) break;
          if (ctx.depth >= 20 || ctx.stack.includes(block.name)) {
            cut++;
            break;
          }
          const r = (e.rotation * Math.PI) / 180;
          const cos = Math.cos(r),
            sin = Math.sin(r);
          const ocs = ocsAffine(e.normal, e.p[2]);
          for (let row = 0; row < e.rows; row++) {
            for (let col = 0; col < e.cols; col++) {
              const ox = col * e.colSpacing,
                oy = row * e.rowSpacing;
              const px = e.p[0] + ox * cos - oy * sin,
                py = e.p[1] + ox * sin + oy * cos;
              // OCS(normal) · T(p) · R(rot) · S(scale) · T(-base)
              const local: Affine = [cos * e.scale[0], sin * e.scale[0], -sin * e.scale[1], cos * e.scale[1], px, py];
              const toBase: Affine = [1, 0, 0, 1, -block.base[0], -block.base[1]];
              const m = mul(ctx.m, mul(ocs, mul(local, toBase)));
              const symbol = b.symbols.length;
              const attribs: Record<string, string> = {};
              for (const a of e.attribs) if (a.tag) attribs[a.tag] = a.text;
              b.symbols.push({ name: block.name, layer, parent: ctx.symbol, m, bbox: null, attribs });
              explode(block.entities, { m, layer, symbol, flags: ctx.flags, depth: ctx.depth + 1, stack: [...ctx.stack, block.name] });
              // Attributes are placed in the drawing's coordinates already.
              for (const a of e.attribs) textOf(a, ctx.m, layerOf(a.layer, ctx), { ...ctx, symbol });
            }
          }
          break;
        }
        case "DIMENSION": {
          const block = file.blocks.get(e.block);
          if (block && ctx.depth < 20) explode(block.entities, { ...ctx, layer, flags: ctx.flags | F_DIM, depth: ctx.depth + 1, stack: [...ctx.stack, block.name] });
          break;
        }
      }
    }
  };

  explode(file.entities, { m: IDENTITY, layer: -1, symbol: -1, flags: 0, depth: 0, stack: [] });
  if (cut) b.notes.push(`${cut} block reference${cut === 1 ? "" : "s"} nested too deep or in a loop left out`);
  const skipped = Object.entries(file.skipped);
  if (skipped.length) b.notes.push(`Not read: ${skipped.map(([t, n]) => `${n} ${t}`).join(", ")}`);
  const label = unitScale ? (UNIT_LABELS[file.insUnits] ?? `units ${file.insUnits}`) : "unitless";
  return b.build("dxf", unitScale, label);
}

// ---------------------------------------------------------------------------
// Several plans in one drawing

/**
 * Groups the drawing into separate plans (a ground floor and a first floor
 * drawn side by side): occupied cells of a coarse grid, joined when they
 * touch. `use(layer)` says which layers count (building layers, not title
 * blocks); returns bounding boxes, largest first.
 */
export function findPlanRegions(d: VectorDrawing, use: (layer: number) => boolean, minShare = 0.08): [number, number, number, number][] {
  const n = d.segLayer.length;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  let used = 0;
  for (let i = 0; i < n; i++) {
    if (!use(d.segLayer[i]) || d.segFlags[i] & F_DIM) continue;
    used++;
    for (const k of [0, 2]) {
      const x = d.segs[i * 4 + k],
        y = d.segs[i * 4 + k + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!used) return [];
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const cell = span / 160;
  const gw = Math.ceil((x1 - x0) / cell) + 3,
    gh = Math.ceil((y1 - y0) / cell) + 3;
  const grid = new Uint8Array(gw * gh);
  const mark = (x: number, y: number) => {
    const gx = Math.floor((x - x0) / cell) + 1,
      gy = Math.floor((y - y0) / cell) + 1;
    grid[gy * gw + gx] = 1;
  };
  for (let i = 0; i < n; i++) {
    if (!use(d.segLayer[i]) || d.segFlags[i] & F_DIM) continue;
    const ax = d.segs[i * 4],
      ay = d.segs[i * 4 + 1],
      bx = d.segs[i * 4 + 2],
      by = d.segs[i * 4 + 3];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / cell));
    for (let s = 0; s <= steps; s++) mark(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
  }
  // Close small gaps between parts of one plan: dilate twice.
  let cur = grid;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(gw * gh);
    for (let y = 1; y < gh - 1; y++)
      for (let x = 1; x < gw - 1; x++) {
        const i = y * gw + x;
        if (cur[i] || cur[i - 1] || cur[i + 1] || cur[i - gw] || cur[i + gw] || cur[i - gw - 1] || cur[i - gw + 1] || cur[i + gw - 1] || cur[i + gw + 1]) next[i] = 1;
      }
    cur = next;
  }
  const label = new Int32Array(gw * gh).fill(-1);
  const boxes: { box: [number, number, number, number]; cells: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < gw * gh; i++) {
    if (!cur[i] || label[i] >= 0) continue;
    const id = boxes.length;
    let bx0 = Infinity,
      by0 = Infinity,
      bx1 = -Infinity,
      by1 = -Infinity,
      cells = 0;
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % gw,
        y = Math.floor(j / gw);
      cells++;
      if (grid[j]) {
        bx0 = Math.min(bx0, x);
        by0 = Math.min(by0, y);
        bx1 = Math.max(bx1, x);
        by1 = Math.max(by1, y);
      }
      for (const k of [j - 1, j + 1, j - gw, j + gw]) if (k >= 0 && k < gw * gh && cur[k] && label[k] < 0) {
        label[k] = id;
        stack.push(k);
      }
    }
    if (bx1 >= bx0) boxes.push({ box: [x0 + (bx0 - 1) * cell, y0 + (by0 - 1) * cell, x0 + bx1 * cell, y0 + by1 * cell], cells });
  }
  if (!boxes.length) return [];
  const area = (b: [number, number, number, number]) => (b[2] - b[0]) * (b[3] - b[1]);
  boxes.sort((a, b) => area(b.box) - area(a.box));
  const biggest = area(boxes[0].box);
  // Keep regions of a useful size, padded a little.
  const pad = cell * 2;
  return boxes.filter((b) => area(b.box) >= biggest * minShare).map((b) => [b.box[0] - pad, b.box[1] - pad, b.box[2] + pad, b.box[3] + pad] as [number, number, number, number]);
}

/** Orders plan regions as they are laid out on the sheet: rows from the top, left to right. */
export function orderRegions(regions: [number, number, number, number][]): [number, number, number, number][] {
  if (regions.length <= 1) return regions;
  const h = Math.max(...regions.map((r) => r[3] - r[1]));
  return regions.slice().sort((a, b) => {
    const rowA = Math.round(-(a[1] + a[3]) / 2 / h),
      rowB = Math.round(-(b[1] + b[3]) / 2 / h);
    return rowA - rowB || a[0] - b[0];
  });
}

// ---------------------------------------------------------------------------
// Drawing for the editor

export interface PlanView {
  /** Drawing units -> plan pixels: px = (x - x0)·k, py = (y1 - y)·k. */
  x0: number;
  y1: number;
  k: number;
  width: number;
  height: number;
}

export function planView(region: [number, number, number, number], longSide = 4000): PlanView {
  const w = region[2] - region[0],
    h = region[3] - region[1];
  const k = longSide / Math.max(w, h, 1e-9);
  return { x0: region[0], y1: region[3], k, width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

export const toPx = (v: PlanView, x: number, y: number): Pt => [(x - v.x0) * v.k, (v.y1 - y) * v.k];
export const fromPx = (v: PlanView, px: number, py: number): Pt => [px / v.k + v.x0, v.y1 - py / v.k];

export interface LayerPaths {
  layer: number;
  /** SVG path data for the layer's lines, in plan pixels. */
  d: string;
  /** SVG path data for its filled areas. */
  fill: string;
  /** Wide polylines: path data and stroke width (px). */
  wide: { d: string; width: number }[];
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

/** SVG paths per layer for the part of the drawing inside `region`. */
export function layerPaths(d: VectorDrawing, region: [number, number, number, number], view: PlanView): LayerPaths[] {
  const [rx0, ry0, rx1, ry1] = region;
  const inside = (x0: number, y0: number, x1: number, y1: number) => !(Math.max(x0, x1) < rx0 || Math.min(x0, x1) > rx1 || Math.max(y0, y1) < ry0 || Math.min(y0, y1) > ry1);
  const byLayer = new Map<number, { d: string[]; fill: string[]; wide: { d: string; width: number }[]; last: Pt | null }>();
  const entry = (l: number) => {
    let e = byLayer.get(l);
    if (!e) byLayer.set(l, (e = { d: [], fill: [], wide: [], last: null }));
    return e;
  };
  const n = d.segLayer.length;
  for (let i = 0; i < n; i++) {
    const ax = d.segs[i * 4],
      ay = d.segs[i * 4 + 1],
      bx = d.segs[i * 4 + 2],
      by = d.segs[i * 4 + 3];
    if (!inside(ax, ay, bx, by)) continue;
    if (d.segFlags[i] & F_WIDE) continue;
    const e = entry(d.segLayer[i]);
    const a = toPx(view, ax, ay),
      b = toPx(view, bx, by);
    // Continue the current subpath when segments chain.
    if (e.last && Math.abs(e.last[0] - a[0]) < 0.05 && Math.abs(e.last[1] - a[1]) < 0.05) e.d.push(`L${fmt(b[0])} ${fmt(b[1])}`);
    else e.d.push(`M${fmt(a[0])} ${fmt(a[1])}L${fmt(b[0])} ${fmt(b[1])}`);
    e.last = b;
  }
  for (const f of d.fills) {
    const ring0 = f.rings[0];
    if (!ring0?.length) continue;
    let bx0 = Infinity,
      by0 = Infinity,
      bx1 = -Infinity,
      by1 = -Infinity;
    for (const p of ring0) {
      bx0 = Math.min(bx0, p[0]);
      by0 = Math.min(by0, p[1]);
      bx1 = Math.max(bx1, p[0]);
      by1 = Math.max(by1, p[1]);
    }
    if (!inside(bx0, by0, bx1, by1)) continue;
    const e = entry(f.layer);
    for (const ring of f.rings) e.fill.push(`M${ring.map((p) => toPx(view, p[0], p[1]).map(fmt).join(" ")).join("L")}Z`);
  }
  for (const s of d.strips) {
    if (!s.points.some((p) => inside(p[0], p[1], p[0], p[1]))) continue;
    const e = entry(s.layer);
    e.wide.push({ d: `M${s.points.map((p) => toPx(view, p[0], p[1]).map(fmt).join(" ")).join("L")}${s.closed ? "Z" : ""}`, width: s.width * view.k });
  }
  return [...byLayer.entries()].map(([layer, e]) => ({ layer, d: e.d.join(""), fill: e.fill.join(""), wide: e.wide }));
}

/** Texts inside `region`, in plan pixels (for the editor). */
export function regionTexts(d: VectorDrawing, region: [number, number, number, number], view: PlanView, limit = 4000) {
  const out: { x: number; y: number; h: number; rotation: number; text: string; layer: number }[] = [];
  for (const t of d.texts) {
    if (t.c[0] < region[0] || t.c[0] > region[2] || t.c[1] < region[1] || t.c[1] > region[3]) continue;
    const [x, y] = toPx(view, t.c[0], t.c[1]);
    out.push({ x, y, h: t.h * view.k, rotation: (-t.rotation * 180) / Math.PI, text: t.text, layer: t.layer });
    if (out.length >= limit) break;
  }
  return out;
}
