// Floor plans from pictures (scans, photos, PDF pages that are images): the
// ink becomes vector line work so a picture is read by the same recognizer as
// a CAD drawing (recognize.ts).
//
//   - Uneven light is evened out, then the ink is separated from the paper.
//   - Solid ink (filled walls, columns) becomes fills, outlined along the
//     ink's edges; small isolated blocks go on a layer of their own.
//   - Strokes are thinned to their centre lines and split into straight
//     segments and arcs (door swings), grouped by pen weight; arcs and
//     circles go on their own layer.
//   - Characters are grouped into lines of text and laid out on a sheet for
//     OCR; the text read is added afterwards (addTexts).
//   - Lines are squared up to the plan's main directions and lines on one
//     line share one position, so walls pair as exactly as in a CAD file.
//
// Units are pixels with y up (y = height - row), so a plan view with
// x0 = 0, y1 = height and k = 1 maps the drawing back onto the picture.

import { distanceTo, thin, tracePaths } from "./trace";
import { DrawingBuilder, F_CURVE, type Pt, type VectorDrawing } from "./vector";

export interface PictureOptions {
  /** Ink darker than the paper (usual); false for light lines on a dark ground. */
  darkInk: boolean;
  /** 0..255; null for automatic. */
  threshold: number | null;
  /** Strokes at least this wide (pixels) are solid fills; null for automatic, 0 for none. */
  solidWidth: number | null;
  /** Only read inside [x0, y0, x1, y1] (pixels, rows down). */
  region: [number, number, number, number] | null;
}

export const DEFAULT_PICTURE: PictureOptions = { darkInk: true, threshold: null, solidWidth: null, region: null };

export interface TextBox {
  id: number;
  /** Pixels, rows down: [x0, y0, x1, y1]. */
  box: [number, number, number, number];
  vertical: boolean;
  /** Character height, pixels. */
  h: number;
}

export interface MosaicPlace {
  box: number;
  /** Which sheet, and where on it: [x, y, w, h]. */
  sheet: number;
  rect: [number, number, number, number];
  /** Rotation applied to the crop: 0, or ±90 for vertical text (degrees, clockwise). */
  rotation: 0 | 90 | -90;
}

export interface TextSheets {
  sheets: { width: number; height: number; data: Uint8Array }[];
  places: MosaicPlace[];
}

export interface PictureStats {
  threshold: number;
  flattened: boolean;
  solidWidth: number | null;
  pens: number[];
  segments: number;
  arcs: number;
  fills: number;
  blocks: number;
  textBoxes: number;
  direction: number;
  seconds: number;
}

export interface PictureDrawing {
  drawing: VectorDrawing;
  boxes: TextBox[];
  sheets: TextSheets;
  stats: PictureStats;
}

// ---------------------------------------------------------------------------
// Connected components (8-connected)

export interface Components {
  /** 0 outside, else 1..count. */
  labels: Int32Array;
  count: number;
  area: Int32Array;
  x0: Int32Array;
  y0: Int32Array;
  x1: Int32Array;
  y1: Int32Array;
}

export function components(mask: Uint8Array, w: number, h: number): Components {
  const labels = new Int32Array(w * h);
  let parent = new Int32Array(1024);
  let next = 1;
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    a = find(a);
    b = find(b);
    if (a === b) return a;
    if (a < b) {
      parent[b] = a;
      return a;
    }
    parent[a] = b;
    return b;
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!mask[i]) continue;
      let l = 0;
      const look = (j: number) => {
        const m = labels[j];
        if (!m) return;
        l = l ? union(l, m) : find(m);
      };
      if (x > 0) look(i - 1);
      if (y > 0) {
        if (x > 0) look(i - w - 1);
        look(i - w);
        if (x < w - 1) look(i - w + 1);
      }
      if (!l) {
        if (next >= parent.length) {
          const grown = new Int32Array(parent.length * 2);
          grown.set(parent);
          parent = grown;
        }
        parent[next] = next;
        l = next++;
      }
      labels[i] = l;
    }
  }
  // Compact the labels.
  const map = new Int32Array(next);
  let count = 0;
  for (let l = 1; l < next; l++) {
    const r = find(l);
    if (r === l) map[l] = ++count;
  }
  for (let l = 1; l < next; l++) map[l] = map[find(l)];
  const area = new Int32Array(count + 1);
  const x0 = new Int32Array(count + 1).fill(w);
  const y0 = new Int32Array(count + 1).fill(h);
  const x1 = new Int32Array(count + 1).fill(-1);
  const y1 = new Int32Array(count + 1).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!labels[i]) continue;
      const l = map[labels[i]];
      labels[i] = l;
      area[l]++;
      if (x < x0[l]) x0[l] = x;
      if (x > x1[l]) x1[l] = x;
      if (y < y0[l]) y0[l] = y;
      if (y > y1[l]) y1[l] = y;
    }
  }
  return { labels, count, area, x0, y0, x1, y1 };
}

// ---------------------------------------------------------------------------
// Paper and ink

/** Evens out uneven light (photos, scans with shadows): each pixel divided by the paper's local brightness. Null when the paper is even already. */
export function flattenBackground(gray: Uint8Array, w: number, h: number): Uint8Array | null {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / 512));
  const sw = Math.ceil(w / f),
    sh = Math.ceil(h / f);
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / f);
    for (let x = 0; x < w; x++) {
      const k = sy * sw + Math.floor(x / f);
      const v = gray[y * w + x];
      if (v > small[k]) small[k] = v;
    }
  }
  // Paper = local maximum (ink removed), then smoothed.
  const r = Math.max(2, Math.round(Math.min(sw, sh) / 60));
  const tmp = new Float32Array(sw * sh);
  const maxPass = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
    const n = horizontal ? sw : sh,
      lines = horizontal ? sh : sw;
    for (let l = 0; l < lines; l++) {
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) {
          const v = horizontal ? src[l * sw + k] : src[k * sw + l];
          if (v > m) m = v;
        }
        if (horizontal) dst[l * sw + i] = m;
        else dst[i * sw + l] = m;
      }
    }
  };
  const boxPass = (src: Float32Array, dst: Float32Array, horizontal: boolean, rr: number) => {
    const n = horizontal ? sw : sh,
      lines = horizontal ? sh : sw;
    for (let l = 0; l < lines; l++) {
      for (let i = 0; i < n; i++) {
        let s = 0,
          c = 0;
        for (let k = Math.max(0, i - rr); k <= Math.min(n - 1, i + rr); k++) {
          s += horizontal ? src[l * sw + k] : src[k * sw + l];
          c++;
        }
        if (horizontal) dst[l * sw + i] = s / c;
        else dst[i * sw + l] = s / c;
      }
    }
  };
  maxPass(small, tmp, true);
  maxPass(tmp, small, false);
  boxPass(small, tmp, true, r);
  boxPass(tmp, small, false, r);
  // Even already?
  const sorted = Float32Array.from(small).sort();
  const p5 = sorted[Math.floor(sorted.length * 0.05)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  if (p5 >= 232 || p95 - p5 < 12) return null;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const y0 = Math.floor(fy),
      y1 = Math.min(sh - 1, y0 + 1),
      ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5));
      const x0 = Math.floor(fx),
        x1 = Math.min(sw - 1, x0 + 1),
        tx = fx - x0;
      const bg = (small[y0 * sw + x0] * (1 - tx) + small[y0 * sw + x1] * tx) * (1 - ty) + (small[y1 * sw + x0] * (1 - tx) + small[y1 * sw + x1] * tx) * ty;
      const v = (gray[y * w + x] * 255) / Math.max(24, bg);
      out[y * w + x] = v >= 255 ? 255 : v;
    }
  }
  return out;
}

function otsuWindow(g: Uint8Array, w: number, h: number, region: [number, number, number, number] | null): number {
  const hist = new Float64Array(256);
  const [rx0, ry0, rx1, ry1] = region ?? [0, 0, w - 1, h - 1];
  let n = 0;
  for (let y = Math.max(0, ry0); y <= Math.min(h - 1, ry1); y++)
    for (let x = Math.max(0, rx0); x <= Math.min(w - 1, rx1); x++) {
      hist[g[y * w + x]]++;
      n++;
    }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0,
    wB = 0,
    best = -1,
    threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB,
      mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** Stroke widths at the ridges of the ink (pixels whose distance to the paper is a local maximum): width ≈ 2·distance − 1. */
function ridgeWidths(ink: Uint8Array, dist: Float32Array, w: number, h: number): Float64Array {
  const hist = new Float64Array(512); // 0.25 px bins up to 128 px
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!ink[i]) continue;
      const d = dist[i];
      if (d < dist[i - 1] || d < dist[i + 1] || d < dist[i - w] || d < dist[i + w] || d < dist[i - w - 1] || d < dist[i - w + 1] || d < dist[i + w - 1] || d < dist[i + w + 1]) continue;
      const width = 2 * d - 1;
      hist[Math.min(511, Math.round(width * 4))]++;
    }
  }
  return hist;
}

/** Width of the widest pen in common use (the 98th percentile of ridge widths up to `limit`). */
function pensTop(hist: Float64Array, limit: number): number {
  let total = 0;
  for (let k = 4; k < hist.length && k / 4 < limit; k++) total += hist[k];
  let acc = 0;
  for (let k = 4; k < hist.length && k / 4 < limit; k++) {
    acc += hist[k];
    if (acc >= 0.98 * total) return k / 4;
  }
  return 1;
}

/**
 * Share of solid ink that comes in parallel pairs across a narrow gap: heavy
 * outlines of walls drawn as two lines, not filled walls. Sampled at ridge
 * pixels; across each band (its shorter run, x or y) the next solid band
 * within `maxGap` of similar width counts as a partner.
 */
function pairedSolidShare(solid: Uint8Array, dist: Float32Array, w: number, h: number, band: number): number {
  const maxGap = Math.round(10 * band + 4);
  let samples = 0,
    paired = 0;
  const run = (x: number, y: number, dx: number, dy: number) => {
    let n = 0;
    while (x >= 0 && y >= 0 && x < w && y < h && solid[y * w + x]) {
      x += dx;
      y += dy;
      n++;
    }
    return n;
  };
  for (let y = 2; y < h - 2; y += 3) {
    for (let x = 2; x < w - 2; x += 3) {
      const i = y * w + x;
      if (!solid[i]) continue;
      const d = dist[i];
      if (d < dist[i - 1] || d < dist[i + 1] || d < dist[i - w] || d < dist[i + w]) continue;
      const rx = run(x, y, 1, 0) + run(x, y, -1, 0) - 1,
        ry = run(x, y, 0, 1) + run(x, y, 0, -1) - 1;
      if (Math.max(rx, ry) < 3 * Math.min(rx, ry)) continue; // not along a band
      const across = rx < ry ? ([1, 0] as const) : ([0, 1] as const);
      const width = Math.min(rx, ry);
      samples++;
      let found = false;
      for (const sgn of [1, -1]) {
        const dx = across[0] * sgn,
          dy = across[1] * sgn;
        // Out of this band, then across the gap.
        let px = x,
          py = y;
        while (px >= 0 && py >= 0 && px < w && py < h && solid[py * w + px]) {
          px += dx;
          py += dy;
        }
        let gap = 0;
        while (px >= 0 && py >= 0 && px < w && py < h && !solid[py * w + px] && gap <= maxGap) {
          px += dx;
          py += dy;
          gap++;
        }
        if (gap === 0 || gap > maxGap || px < 0 || py < 0 || px >= w || py >= h) continue;
        const other = run(px, py, dx, dy);
        if (other >= 0.5 * width && other <= 2 * width + 2) {
          found = true;
          break;
        }
      }
      if (found) paired++;
    }
  }
  return samples >= 30 ? paired / samples : 0;
}

/** The narrowest solid stroke: splits pen lines from solid ink when the picture has both (null: no solid ink). */
function solidThreshold(hist: Float64Array): number | null {
  // Otsu on log widths.
  const bins: { lw: number; n: number; width: number }[] = [];
  for (let k = 4; k < hist.length; k++) if (hist[k] > 0) bins.push({ lw: Math.log(k / 4), n: hist[k], width: k / 4 });
  if (bins.length < 2) return null;
  const total = bins.reduce((s, b) => s + b.n, 0);
  const sum = bins.reduce((s, b) => s + b.n * b.lw, 0);
  let wB = 0,
    sB = 0,
    best = -1,
    split = -1;
  for (let k = 0; k < bins.length - 1; k++) {
    wB += bins[k].n;
    sB += bins[k].n * bins[k].lw;
    const wF = total - wB;
    if (!wF) break;
    const mB = sB / wB,
      mF = (sum - sB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      split = k;
    }
  }
  if (split < 0) return null;
  let n0 = 0,
    s0 = 0,
    n1 = 0,
    s1 = 0;
  bins.forEach((b, k) => {
    if (k <= split) {
      n0 += b.n;
      s0 += b.n * b.width;
    } else {
      n1 += b.n;
      s1 += b.n * b.width;
    }
  });
  const m0 = s0 / Math.max(1, n0),
    m1 = s1 / Math.max(1, n1);
  if (m1 < 4.5 || m1 / Math.max(1, m0) < 2.4 || n1 < 40 || n1 < 0.01 * total) return null;
  // Halfway (geometrically) between the pens and the solid ink, never inside the pens' own spread.
  let pensTop = 0;
  bins.forEach((b, k) => {
    if (k <= split && b.n >= 0.02 * n0) pensTop = Math.max(pensTop, b.width);
  });
  return Math.max(pensTop + 1, Math.min(Math.sqrt(m0 * m1), bins[split + 1].width));
}

// ---------------------------------------------------------------------------
// Outlines of solid ink (marching squares on the component's pixels)

/** Closed boundaries of component `id` (outer and holes), points in pixel coordinates (rows down). */
function componentRings(labels: Int32Array, w: number, h: number, id: number, bx0: number, by0: number, bx1: number, by1: number): Pt[][] {
  const ox = bx0 - 1,
    oy = by0 - 1;
  const gw = bx1 - bx0 + 3,
    gh = by1 - by0 + 3;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === id ? 1 : 0);
  const stride = 2 * gw + 2;
  const key = (x2: number, y2: number) => (y2 - 2 * oy) * stride + (x2 - 2 * ox);
  // Segments between edge midpoints, doubled coordinates.
  const segA: number[] = [];
  const segB: number[] = [];
  const pts = new Map<number, [number, number]>();
  const adj = new Map<number, number[]>();
  const addSeg = (ax2: number, ay2: number, bx2: number, by2: number) => {
    const ka = key(ax2, ay2),
      kb = key(bx2, by2);
    pts.set(ka, [ax2 / 2, ay2 / 2]);
    pts.set(kb, [bx2 / 2, by2 / 2]);
    const s = segA.length;
    segA.push(ka);
    segB.push(kb);
    for (const k of [ka, kb]) {
      const list = adj.get(k);
      if (list) list.push(s);
      else adj.set(k, [s]);
    }
  };
  for (let y = oy; y < oy + gh - 1; y++) {
    for (let x = ox; x < ox + gw - 1; x++) {
      const a = at(x, y),
        b = at(x + 1, y),
        c = at(x + 1, y + 1),
        d = at(x, y + 1);
      const code = a * 8 + b * 4 + c * 2 + d;
      if (code === 0 || code === 15) continue;
      // Edge midpoints (doubled): T, R, B, L.
      const T: [number, number] = [2 * x + 1, 2 * y],
        R: [number, number] = [2 * x + 2, 2 * y + 1],
        B: [number, number] = [2 * x + 1, 2 * y + 2],
        L: [number, number] = [2 * x, 2 * y + 1];
      const link = (p: [number, number], q: [number, number]) => addSeg(p[0], p[1], q[0], q[1]);
      switch (code) {
        case 1:
        case 14:
          link(L, B);
          break;
        case 2:
        case 13:
          link(B, R);
          break;
        case 3:
        case 12:
          link(L, R);
          break;
        case 4:
        case 11:
          link(T, R);
          break;
        case 6:
        case 9:
          link(T, B);
          break;
        case 7:
        case 8:
          link(L, T);
          break;
        case 5:
          link(L, T);
          link(B, R);
          break;
        case 10:
          link(T, R);
          link(L, B);
          break;
      }
    }
  }
  const used = new Uint8Array(segA.length);
  const rings: Pt[][] = [];
  for (let s = 0; s < segA.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const ring: Pt[] = [pts.get(segA[s])!];
    let cur = segB[s];
    const start = segA[s];
    for (let guard = 0; guard < segA.length + 2 && cur !== start; guard++) {
      ring.push(pts.get(cur)!);
      const list = adj.get(cur) ?? [];
      let nextSeg = -1;
      for (const t of list)
        if (!used[t]) {
          nextSeg = t;
          break;
        }
      if (nextSeg < 0) break;
      used[nextSeg] = 1;
      cur = segA[nextSeg] === cur ? segB[nextSeg] : segA[nextSeg];
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

// ---------------------------------------------------------------------------
// Skeleton clean-up

/** Neighbourhoods (bits N, NE, E, SE, S, SW, W, NW) whose centre pixel can go without breaking the line: two or more neighbours, all one 8-connected group. */
const REDUNDANT = (() => {
  const table = new Uint8Array(256);
  // Ring positions as (dx, dy).
  const pos = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];
  for (let m = 0; m < 256; m++) {
    const on: number[] = [];
    for (let k = 0; k < 8; k++) if (m & (1 << k)) on.push(k);
    if (on.length < 2) continue;
    const parent = on.map((_, i) => i);
    const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
    for (let i = 0; i < on.length; i++)
      for (let j = i + 1; j < on.length; j++) {
        const [ax, ay] = pos[on[i]],
          [bx, by] = pos[on[j]];
        if (Math.max(Math.abs(ax - bx), Math.abs(ay - by)) === 1) parent[find(j)] = find(i);
      }
    const roots = new Set(on.map((_, i) => find(i)));
    if (roots.size === 1) table[m] = 1;
  }
  return table;
})();

/** Removes the extra pixels thinning leaves at stair steps, so every pixel of a line has two neighbours and only real junctions have more. */
export function pruneSkeleton(skel: Uint8Array, w: number, h: number) {
  for (let changed = true; changed; ) {
    changed = false;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!skel[i]) continue;
        const m = skel[i - w] | (skel[i - w + 1] << 1) | (skel[i + 1] << 2) | (skel[i + w + 1] << 3) | (skel[i + w] << 4) | (skel[i + w - 1] << 5) | (skel[i - 1] << 6) | (skel[i - w - 1] << 7);
        if (REDUNDANT[m]) {
          skel[i] = 0;
          changed = true;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Circles and arcs

interface Circle {
  c: Pt;
  r: number;
  rms: number;
  maxErr: number;
}

export function fitCircle(pts: Pt[]): Circle | null {
  const n = pts.length;
  if (n < 5) return null;
  // Algebraic fit (Kåsa) on centred points, then a few geometric (Gauss–Newton) steps.
  let mx = 0,
    my = 0;
  for (const p of pts) {
    mx += p[0];
    my += p[1];
  }
  mx /= n;
  my /= n;
  let suu = 0,
    svv = 0,
    suv = 0,
    suuu = 0,
    svvv = 0,
    suvv = 0,
    svuu = 0;
  for (const p of pts) {
    const u = p[0] - mx,
      v = p[1] - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const bu = 0.5 * (suuu + suvv),
    bv = 0.5 * (svvv + svuu);
  let cx = (bu * svv - bv * suv) / det + mx;
  let cy = (bv * suu - bu * suv) / det + my;
  let r = 0;
  for (const p of pts) r += Math.hypot(p[0] - cx, p[1] - cy);
  r /= n;
  for (let it = 0; it < 6; it++) {
    // Minimise Σ (|p − c| − r)²
    let j11 = 0,
      j12 = 0,
      j13 = 0,
      j22 = 0,
      j23 = 0,
      j33 = 0,
      g1 = 0,
      g2 = 0,
      g3 = 0;
    for (const p of pts) {
      const dx = cx - p[0],
        dy = cy - p[1];
      const d = Math.hypot(dx, dy) || 1e-9;
      const res = d - r;
      const a = dx / d,
        b = dy / d,
        c = -1;
      j11 += a * a;
      j12 += a * b;
      j13 += a * c;
      j22 += b * b;
      j23 += b * c;
      j33 += c * c;
      g1 += a * res;
      g2 += b * res;
      g3 += c * res;
    }
    // Solve the 3x3 normal equations.
    const m = [
      [j11, j12, j13, -g1],
      [j12, j22, j23, -g2],
      [j13, j23, j33, -g3],
    ];
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let row = col + 1; row < 3; row++) if (Math.abs(m[row][col]) > Math.abs(m[piv][col])) piv = row;
      if (Math.abs(m[piv][col]) < 1e-12) return null;
      [m[col], m[piv]] = [m[piv], m[col]];
      for (let row = 0; row < 3; row++) {
        if (row === col) continue;
        const f = m[row][col] / m[col][col];
        for (let k = col; k < 4; k++) m[row][k] -= f * m[col][k];
      }
    }
    const dx = m[0][3] / m[0][0],
      dy = m[1][3] / m[1][1],
      dr = m[2][3] / m[2][2];
    cx += dx;
    cy += dy;
    r += dr;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dr) < 1e-4) break;
  }
  if (!(r > 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  let ss = 0,
    maxErr = 0;
  for (const p of pts) {
    const e = Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - r);
    ss += e * e;
    if (e > maxErr) maxErr = e;
  }
  return { c: [cx, cy], r, rms: Math.sqrt(ss / n), maxErr };
}

/** Angles of `pts` around `c` (rows-down pixels, returned with y up), unwrapped along the path: [start, end] radians. */
function sweepOf(pts: Pt[], c: Pt): [number, number] {
  let prev = Math.atan2(-(pts[0][1] - c[1]), pts[0][0] - c[0]);
  const start = prev;
  let acc = start;
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2(-(pts[i][1] - c[1]), pts[i][0] - c[0]);
    let d = a - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    acc += d;
    prev = a;
  }
  return [start, acc];
}

// ---------------------------------------------------------------------------
// Strokes -> segments and arcs

interface Stroke {
  a: Pt;
  b: Pt;
  /** Stroke width, pixels. */
  width: number;
  curve: boolean;
}

interface ArcStroke {
  c: Pt;
  r: number;
  /** y up, radians, a1 > a0. */
  a0: number;
  a1: number;
  width: number;
  points: Pt[];
}

const turn = (a: Pt, b: Pt, c: Pt) => {
  const u = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const v = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = v - u;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

function douglas(pts: Pt[], tol: number): number[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a],
      [bx, by] = pts[b];
    const dx = bx - ax,
      dy = by - ay;
    const len = Math.hypot(dx, dy);
    let worst = -1,
      at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = len > 1e-9 ? Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => k && out.push(i));
  return out;
}

/** The straight line through pts[i0..i1] (least squares), as the projections of its two end points. */
function fitSegment(pts: Pt[], i0: number, i1: number): [Pt, Pt] {
  const n = i1 - i0 + 1;
  if (n < 5) return [pts[i0], pts[i1]];
  let mx = 0,
    my = 0;
  for (let i = i0; i <= i1; i++) {
    mx += pts[i][0];
    my += pts[i][1];
  }
  mx /= n;
  my /= n;
  let sxx = 0,
    syy = 0,
    sxy = 0;
  for (let i = i0; i <= i1; i++) {
    const dx = pts[i][0] - mx,
      dy = pts[i][1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d: Pt = [Math.cos(angle), Math.sin(angle)];
  const proj = (p: Pt): Pt => {
    const t = (p[0] - mx) * d[0] + (p[1] - my) * d[1];
    return [mx + d[0] * t, my + d[1] * t];
  };
  return [proj(pts[i0]), proj(pts[i1])];
}

/** A closed outline simplified (Douglas–Peucker), each kept edge fitted to the outline's points along it, corners where fitted edges meet. */
function simplifyRingFit(ring: Pt[], tol: number): Pt[] {
  const n = ring.length;
  if (n <= 4) return ring.slice();
  // Split at the point farthest from the first one; simplify both halves on the doubled index range.
  let far = 0,
    farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const loop = ring.concat([ring[0]]);
  const first = douglas(loop.slice(0, far + 1), tol);
  const second = douglas(loop.slice(far), tol).map((i) => i + far);
  const keep = first.concat(second.slice(1, -1));
  if (keep.length < 3) return ring.slice();
  const m = keep.length;
  const edges: [Pt, Pt][] = keep.map((k, j) => {
    const k1 = j + 1 < m ? keep[j + 1] : n;
    return fitSegment(loop, k, k1);
  });
  const out: Pt[] = [];
  for (let j = 0; j < m; j++) {
    const [p0, p1] = edges[(j - 1 + m) % m];
    const [q0, q1] = edges[j];
    const v = ring[keep[j]];
    const d1: Pt = [p1[0] - p0[0], p1[1] - p0[1]],
      d2: Pt = [q1[0] - q0[0], q1[1] - q0[1]];
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) > 1e-6 * Math.hypot(...d1) * Math.hypot(...d2)) {
      const t = ((q0[0] - p0[0]) * d2[1] - (q0[1] - p0[1]) * d2[0]) / den;
      const x: Pt = [p0[0] + d1[0] * t, p0[1] + d1[1] * t];
      if (Math.hypot(x[0] - v[0], x[1] - v[1]) <= 2.5) {
        out.push(x);
        continue;
      }
    }
    out.push([v[0], v[1]]);
  }
  return out;
}

/** One skeleton path -> straight strokes and arcs. */
function splitPath(pts: Pt[], widthAt: (p: Pt) => number, strokes: Stroke[], arcs: ArcStroke[]) {
  if (pts.length < 2) return;
  const tryArc = (from: number, to: number): ArcStroke | null => {
    const part = pts.slice(from, to + 1);
    if (part.length < 8) return null;
    const chord = Math.hypot(part[part.length - 1][0] - part[0][0], part[part.length - 1][1] - part[0][1]);
    const fit = fitCircle(part);
    if (!fit || fit.r < 5 || fit.r > 4000) return null;
    if (fit.rms > Math.max(0.55, 0.012 * fit.r) || fit.maxErr > Math.max(1.6, 0.04 * fit.r)) return null;
    const [s, e] = sweepOf(part, fit.c);
    const sweep = Math.abs(e - s);
    if (sweep < (25 * Math.PI) / 180 || chord < 6) return null;
    let a0 = Math.min(s, e),
      a1 = Math.max(s, e);
    const k = Math.floor(a0 / (2 * Math.PI));
    a0 -= k * 2 * Math.PI;
    a1 -= k * 2 * Math.PI;
    const widths = part.map(widthAt).sort((p, q) => p - q);
    return { c: fit.c, r: fit.r, a0, a1, width: widths[Math.floor(widths.length / 2)], points: part };
  };
  const pushLine = (from: number, to: number) => {
    const [a, b] = fitSegment(pts, from, to);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1.5) return;
    const ws: number[] = [];
    for (let i = from; i <= to; i++) ws.push(widthAt(pts[i]));
    ws.sort((p, q) => p - q);
    strokes.push({ a, b, width: ws[Math.floor(ws.length / 2)], curve: false });
  };
  // A whole path that is one arc (door swings are usually a path of their own).
  const whole = douglas(pts, 1.0);
  if (whole.length > 3) {
    const arc = tryArc(0, pts.length - 1);
    if (arc) {
      arcs.push(arc);
      return;
    }
  }
  // Runs of short, consistently turning pieces are arcs; the rest are lines.
  const v = whole;
  let i = 0;
  while (i < v.length - 1) {
    let j = i + 1;
    if (j + 1 < v.length) {
      const sign = Math.sign(turn(pts[v[i]], pts[v[j]], pts[v[j + 1]]));
      let k = j;
      while (k + 1 < v.length) {
        const t = turn(pts[v[k - 1]], pts[v[k]], pts[v[k + 1]]);
        if (Math.sign(t) !== sign || Math.abs(t) > (40 * Math.PI) / 180 || Math.abs(t) < (2 * Math.PI) / 180) break;
        k++;
      }
      if (k - i >= 3) {
        const arc = tryArc(v[i], v[k]);
        if (arc) {
          arcs.push(arc);
          i = k;
          continue;
        }
      }
    }
    pushLine(v[i], v[j]);
    i = j;
  }
}

/** Arcs of one circle broken where other lines cross them (or touch them) become one arc again. */
function mergeArcs(arcs: ArcStroke[]) {
  const TAU = 2 * Math.PI;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < arcs.length && !changed; i++) {
      for (let j = i + 1; j < arcs.length; j++) {
        const p = arcs[i],
          q = arcs[j];
        const r = Math.max(p.r, q.r);
        if (Math.hypot(p.c[0] - q.c[0], p.c[1] - q.c[1]) > Math.max(2.5, 0.06 * r) || Math.abs(p.r - q.r) > Math.max(2, 0.06 * r)) continue;
        // Angle ranges touching (within a few pixels of arc length), either way round.
        const slack = Math.max(4 / r, (6 * Math.PI) / 180);
        let qa0 = q.a0,
          qa1 = q.a1;
        while (qa0 > p.a1 + slack) {
          qa0 -= TAU;
          qa1 -= TAU;
        }
        while (qa1 < p.a0 - slack) {
          qa0 += TAU;
          qa1 += TAU;
        }
        if (qa0 > p.a1 + slack || qa1 < p.a0 - slack) continue;
        const a0 = Math.min(p.a0, qa0),
          a1 = Math.max(p.a1, qa1);
        if (a1 - a0 > TAU) continue;
        const points = p.points.concat(q.points);
        const fit = fitCircle(points);
        const c = fit && fit.rms < Math.max(0.8, 0.015 * fit.r) ? fit.c : p.c;
        const rr = fit && fit.rms < Math.max(0.8, 0.015 * fit.r) ? fit.r : (p.r + q.r) / 2;
        arcs[i] = { c, r: rr, a0, a1, width: (p.width + q.width) / 2, points };
        arcs.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Squaring up: main directions, shared positions

interface Family {
  /** Direction angle, radians in [0, π). */
  angle: number;
  d: Pt;
  n: Pt;
}

/** Direction families: peaks of the length-weighted histogram of line angles (mod 180°); the strongest one also gives its perpendicular. */
function directionFamilies(items: { a: Pt; b: Pt }[]): Family[] {
  const bins = new Float64Array(360); // 0.5°
  // Length-weighted sum of each bin's angles, relative to the bin's start (radians).
  const sums = new Float64Array(360);
  let total = 0;
  for (const s of items) {
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    if (L < 8) continue;
    let a = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]);
    if (a < 0) a += Math.PI;
    if (a >= Math.PI) a -= Math.PI;
    const k = Math.min(359, Math.floor((a / Math.PI) * 360));
    bins[k] += L;
    sums[k] += (a - (k * Math.PI) / 360) * L;
    total += L;
  }
  if (!total) return [];
  const smooth = new Float64Array(360);
  for (let k = 0; k < 360; k++) for (let o = -2; o <= 2; o++) smooth[k] += bins[(k + o + 360) % 360] * (3 - Math.abs(o));
  const peaks: { k: number; v: number }[] = [];
  for (let k = 0; k < 360; k++) {
    const v = smooth[k];
    if (v <= 0) continue;
    let isPeak = true;
    for (let o = -6; o <= 6 && isPeak; o++) if (o && smooth[(k + o + 360) % 360] > v) isPeak = false;
    if (isPeak) peaks.push({ k, v });
  }
  peaks.sort((p, q) => q.v - p.v);
  const angles: number[] = [];
  const refine = (k: number) => {
    // Length-weighted mean of the actual angles near the peak (bins wrap around 180°).
    let s = 0,
      wsum = 0;
    for (let o = -4; o <= 4; o++) {
      const kk = (k + o + 360) % 360;
      if (!bins[kk]) continue;
      s += (((k + o) * Math.PI) / 360) * bins[kk] + sums[kk];
      wsum += bins[kk];
    }
    let a = wsum ? s / wsum : ((k + 0.5) * Math.PI) / 360;
    if (a < 0) a += Math.PI;
    if (a >= Math.PI) a -= Math.PI;
    return a;
  };
  const near = (a: number, b: number) => {
    let d = Math.abs(a - b) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return d < (4 * Math.PI) / 180;
  };
  const strongest = peaks[0]?.v ?? 0;
  for (const p of peaks) {
    if (p.v < 0.08 * strongest && angles.length) break;
    const a = refine(p.k);
    if (!angles.some((b) => near(a, b))) angles.push(a);
    if (angles.length === 1) {
      let perp = a + Math.PI / 2;
      if (perp >= Math.PI) perp -= Math.PI;
      if (!angles.some((b) => near(perp, b))) angles.push(perp);
    }
    if (angles.length >= 6) break;
  }
  return angles.map((angle) => ({ angle, d: [Math.cos(angle), Math.sin(angle)], n: [-Math.sin(angle), Math.cos(angle)] }));
}

/** A door swing's end angles (y up, a1 > a0) snapped to the plan's first two directions when that makes a quarter turn; null otherwise. */
function snapSwing(a0: number, a1: number, families: Family[]): [number, number] | null {
  const sweep = a1 - a0;
  if (sweep < (55 * Math.PI) / 180 || sweep > (125 * Math.PI) / 180 || !families.length) return null;
  const axes: number[] = [];
  // Angles y up: a family at angle φ (rows down) runs at −φ.
  for (const f of families.slice(0, 2)) for (let k = 0; k < 4; k++) axes.push(-f.angle + (k * Math.PI) / 2);
  const snap = (a: number) => {
    let best = a,
      bestD = (22 * Math.PI) / 180;
    for (const x of axes) {
      let d = a - x;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      if (Math.abs(d) < bestD) {
        bestD = Math.abs(d);
        best = a - d;
      }
    }
    return best;
  };
  const s0 = snap(a0),
    s1 = snap(a1);
  const turn = s1 - s0;
  return turn >= (80 * Math.PI) / 180 && turn <= (100 * Math.PI) / 180 ? [s0, s1] : null;
}

function familyOf(families: Family[], a: Pt, b: Pt, tolDeg: number): number {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 1e-9) return -1;
  let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  if (ang < 0) ang += Math.PI;
  if (ang >= Math.PI) ang -= Math.PI;
  // Short pieces may lean more (pixel steps).
  const tol = ((tolDeg + Math.min(6, 20 / L)) * Math.PI) / 180;
  let best = -1,
    bestD = tol;
  families.forEach((f, k) => {
    let d = Math.abs(ang - f.angle) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    if (d <= bestD) {
      bestD = d;
      best = k;
    }
  });
  return best;
}

interface Placed {
  fam: number;
  o: number;
  s0: number;
  s1: number;
  len: number;
}

/** Positions within `tol` (chained, at most `span` apart overall) become their length-weighted mean. */
function clusterOffsets(items: Placed[], tol: number, span: number) {
  const byFam = new Map<number, Placed[]>();
  for (const it of items) {
    const list = byFam.get(it.fam);
    if (list) list.push(it);
    else byFam.set(it.fam, [it]);
  }
  for (const list of byFam.values()) {
    list.sort((p, q) => p.o - q.o);
    let k = 0;
    while (k < list.length) {
      let m = k + 1;
      while (m < list.length && list[m].o - list[m - 1].o <= tol && list[m].o - list[k].o <= span) m++;
      let s = 0,
        wsum = 0;
      for (let j = k; j < m; j++) {
        s += list[j].o * list[j].len;
        wsum += list[j].len;
      }
      const o = wsum ? s / wsum : list[k].o;
      for (let j = k; j < m; j++) list[j].o = o;
      k = m;
    }
  }
}

// ---------------------------------------------------------------------------
// Text

interface CharCC {
  label: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
}

function findTextLines(cc: Components, w: number, h: number, exclude: Set<number>): { boxes: TextBox[]; textLabels: Set<number> } {
  const solidLabels = exclude;
  const maxChar = Math.max(12, Math.min(160, Math.round(0.06 * Math.min(w, h))));
  const minChar = 6;
  const chars: CharCC[] = [];
  for (let l = 1; l <= cc.count; l++) {
    if (solidLabels.has(l)) continue;
    const bw = cc.x1[l] - cc.x0[l] + 1,
      bh = cc.y1[l] - cc.y0[l] + 1;
    const big = Math.max(bw, bh),
      small = Math.min(bw, bh);
    if (big < minChar || big > maxChar || cc.area[l] < 6) continue;
    if (big / small > 12) continue;
    const density = cc.area[l] / (bw * bh);
    if (density < 0.06) continue;
    chars.push({ label: l, x0: cc.x0[l], y0: cc.y0[l], x1: cc.x1[l], y1: cc.y1[l], w: bw, h: bh });
  }
  // Spatial grid.
  const cell = maxChar * 2;
  const gw = Math.ceil(w / cell) + 1;
  const grid = new Map<number, number[]>();
  chars.forEach((c, i) => {
    const gx = Math.floor(c.x0 / cell),
      gy = Math.floor(c.y0 / cell);
    const k = gy * gw + gx;
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });
  const neighbours = (c: CharCC): number[] => {
    const out: number[] = [];
    const gx = Math.floor(c.x0 / cell),
      gy = Math.floor(c.y0 / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push(...(grid.get((gy + dy) * gw + gx + dx) ?? []));
    return out;
  };
  const group = (vertical: boolean) => {
    const parent = chars.map((_, i) => i);
    const find = (a: number): number => {
      while (parent[a] !== a) {
        parent[a] = parent[parent[a]];
        a = parent[a];
      }
      return a;
    };
    chars.forEach((c, i) => {
      for (const j of neighbours(c)) {
        if (j <= i) continue;
        const d = chars[j];
        // Along the line: x for horizontal text, y for vertical; across: the other.
        const [p0, p1, q0, q1] = vertical ? [c.y0, c.y1, d.y0, d.y1] : [c.x0, c.x1, d.x0, d.x1];
        const [u0, u1, v0, v1] = vertical ? [c.x0, c.x1, d.x0, d.x1] : [c.y0, c.y1, d.y0, d.y1];
        const hc = vertical ? c.w : c.h,
          hd = vertical ? d.w : d.h;
        const hm = Math.max(hc, hd);
        if (hm / Math.min(hc, hd) > 2.2) continue;
        const gap = Math.max(q0 - p1, p0 - q1);
        if (gap > 1.0 * hm || gap < -0.3 * hm) continue;
        const overlap = Math.min(u1, v1) - Math.max(u0, v0);
        if (overlap < 0.5 * Math.min(hc, hd)) continue;
        const a = find(i),
          b = find(j);
        if (a !== b) parent[b] = a;
      }
    });
    const groups = new Map<number, number[]>();
    chars.forEach((_, i) => {
      const r = find(i);
      const list = groups.get(r);
      if (list) list.push(i);
      else groups.set(r, [i]);
    });
    return [...groups.values()].filter((g) => g.length >= 2);
  };
  const hGroups = group(false);
  const vGroups = group(true);
  // Each character in one line: the line with more characters wins (horizontal on ties).
  const owner = new Int32Array(chars.length).fill(-1);
  const all = [...hGroups.map((g) => ({ g, vertical: false })), ...vGroups.map((g) => ({ g, vertical: true }))];
  all.sort((p, q) => q.g.length - p.g.length || (p.vertical ? 1 : 0) - (q.vertical ? 1 : 0));
  const lines: { g: number[]; vertical: boolean }[] = [];
  for (const entry of all) {
    const free = entry.g.filter((i) => owner[i] < 0);
    if (free.length < 2 || free.length < entry.g.length * 0.6) continue;
    for (const i of free) owner[i] = lines.length;
    lines.push({ g: free, vertical: entry.vertical });
  }
  const textLabels = new Set<number>();
  const boxes: TextBox[] = [];
  for (const line of lines) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    const heights: number[] = [];
    for (const i of line.g) {
      const c = chars[i];
      x0 = Math.min(x0, c.x0);
      y0 = Math.min(y0, c.y0);
      x1 = Math.max(x1, c.x1);
      y1 = Math.max(y1, c.y1);
      heights.push(line.vertical ? c.w : c.h);
      textLabels.add(c.label);
    }
    heights.sort((p, q) => p - q);
    const hh = heights[Math.floor(heights.length * 0.75)];
    // A line of text is longer than it is tall.
    const along = line.vertical ? y1 - y0 + 1 : x1 - x0 + 1;
    if (along < 1.2 * hh) continue;
    boxes.push({ id: boxes.length, box: [x0, y0, x1, y1], vertical: line.vertical, h: hh });
  }
  // Small marks beside a line (decimal points, superscripts such as ², commas, accents) belong to it.
  const markCell = 64;
  const marks = new Map<number, number[]>();
  for (let l = 1; l <= cc.count; l++) {
    if (textLabels.has(l) || solidLabels.has(l) || cc.area[l] < 2) continue;
    const bw = cc.x1[l] - cc.x0[l] + 1,
      bh = cc.y1[l] - cc.y0[l] + 1;
    if (Math.max(bw, bh) > maxChar * 0.6) continue;
    const k = Math.floor(cc.y0[l] / markCell) * 100000 + Math.floor(cc.x0[l] / markCell);
    const list = marks.get(k);
    if (list) list.push(l);
    else marks.set(k, [l]);
  }
  for (const box of boxes) {
    const hh = box.h;
    // Room above-right for superscripts, below for commas (rotated for vertical lines).
    const [x0, y0, x1, y1] = box.box;
    const ex = box.vertical ? [x0 - 0.6 * hh, y0 - 0.8 * hh, x1 + 0.3 * hh, y1 + 0.2 * hh] : [x0 - 0.2 * hh, y0 - 0.6 * hh, x1 + 0.8 * hh, y1 + 0.3 * hh];
    for (let gy = Math.floor(ex[1] / markCell) - 1; gy <= Math.floor(ex[3] / markCell); gy++)
      for (let gx = Math.floor(ex[0] / markCell) - 1; gx <= Math.floor(ex[2] / markCell); gx++)
        for (const l of marks.get(gy * 100000 + gx) ?? []) {
          const bw = cc.x1[l] - cc.x0[l] + 1,
            bh = cc.y1[l] - cc.y0[l] + 1;
          if (Math.max(bw, bh) > 0.8 * hh) continue;
          if (cc.x0[l] < ex[0] || cc.x1[l] > ex[2] || cc.y0[l] < ex[1] || cc.y1[l] > ex[3]) continue;
          textLabels.add(l);
          box.box = [Math.min(box.box[0], cc.x0[l]), Math.min(box.box[1], cc.y0[l]), Math.max(box.box[2], cc.x1[l]), Math.max(box.box[3], cc.y1[l])];
        }
  }
  return { boxes, textLabels };
}

/** Crops of the text lines (line work blanked, rotated level, scaled to ~32 px letters) packed on sheets for OCR. */
export function textSheets(norm: Uint8Array, w: number, h: number, cc: Components, textLabels: Set<number>, boxes: TextBox[], maxHeight = 6000): TextSheets {
  const sheets: TextSheets["sheets"] = [];
  const places: MosaicPlace[] = [];
  type Crop = { box: number; rotation: 0 | 90 | -90; cw: number; ch: number; data: Uint8Array };
  const crops: Crop[] = [];
  for (const b of boxes) {
    const m = Math.round(0.35 * b.h) + 2;
    const x0 = Math.max(0, b.box[0] - m),
      y0 = Math.max(0, b.box[1] - m),
      x1 = Math.min(w - 1, b.box[2] + m),
      y1 = Math.min(h - 1, b.box[3] + m);
    const sw = x1 - x0 + 1,
      sh = y1 - y0 + 1;
    const src = new Uint8Array(sw * sh);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        const l = cc.labels[i];
        // Other ink (lines through or beside the text) is blanked.
        src[(y - y0) * sw + (x - x0)] = l && !textLabels.has(l) && cc.area[l] > 12 ? 255 : norm[i];
      }
    const s = Math.max(0.5, Math.min(4, 32 / Math.max(4, b.h)));
    for (const rotation of b.vertical ? ([-90, 90] as const) : ([0] as const)) {
      // Rotated size.
      const rw = rotation === 0 ? sw : sh,
        rh = rotation === 0 ? sh : sw;
      const cw = Math.max(1, Math.round(rw * s)),
        ch = Math.max(1, Math.round(rh * s));
      const data = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++)
        for (let x = 0; x < cw; x++) {
          // Back to the rotated crop, then to the source crop (bilinear).
          const rx = (x + 0.5) / s - 0.5,
            ry = (y + 0.5) / s - 0.5;
          // rotation 90: clockwise (text reading downwards made level); -90: counter-clockwise (reading upwards).
          const [sx, sy] = rotation === 0 ? [rx, ry] : rotation === 90 ? [ry, sh - 1 - rx] : [sw - 1 - ry, rx];
          const fx = Math.max(0, Math.min(sw - 1, sx)),
            fy = Math.max(0, Math.min(sh - 1, sy));
          const ix = Math.floor(fx),
            iy = Math.floor(fy);
          const jx = Math.min(sw - 1, ix + 1),
            jy = Math.min(sh - 1, iy + 1);
          const tx = fx - ix,
            ty = fy - iy;
          const v = (src[iy * sw + ix] * (1 - tx) + src[iy * sw + jx] * tx) * (1 - ty) + (src[jy * sw + ix] * (1 - tx) + src[jy * sw + jx] * tx) * ty;
          data[y * cw + x] = v;
        }
      crops.push({ box: b.id, rotation, cw, ch, data });
    }
  }
  // One crop per row, with space between rows.
  const gap = 24,
    pad = 16;
  let start = 0;
  while (start < crops.length) {
    let height = pad,
      width = 0,
      end = start;
    while (end < crops.length && (end === start || height + crops[end].ch + gap <= maxHeight)) {
      height += crops[end].ch + gap;
      width = Math.max(width, crops[end].cw);
      end++;
    }
    width += 2 * pad;
    const data = new Uint8Array(width * height).fill(255);
    let y = pad;
    for (let k = start; k < end; k++) {
      const c = crops[k];
      for (let yy = 0; yy < c.ch; yy++) data.set(c.data.subarray(yy * c.cw, (yy + 1) * c.cw), (y + yy) * width + pad);
      places.push({ box: c.box, sheet: sheets.length, rect: [pad, y, c.cw, c.ch], rotation: c.rotation });
      y += c.ch + gap;
    }
    sheets.push({ width, height, data });
    start = end;
  }
  return { sheets, places };
}

// ---------------------------------------------------------------------------
// Main

export function vectorizePicture(width: number, height: number, gray: Uint8Array, options: PictureOptions = DEFAULT_PICTURE): PictureDrawing {
  const started = Date.now();
  const w = width,
    h = height;
  const region = options.region;
  // 1. Paper and ink.
  let g = gray;
  if (!options.darkInk) {
    g = new Uint8Array(gray.length);
    for (let i = 0; i < g.length; i++) g[i] = 255 - gray[i];
  }
  const flat = flattenBackground(g, w, h);
  const norm = flat ?? g;
  const threshold = options.threshold ?? otsuWindow(norm, w, h, region);
  const ink = new Uint8Array(w * h);
  const inRegion = (x: number, y: number) => !region || (x >= region[0] && x <= region[2] && y >= region[1] && y <= region[3]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (norm[y * w + x] <= threshold && inRegion(x, y)) ink[y * w + x] = 1;
  const cc = components(ink, w, h);

  // 2. Text lines first: bold lettering is text, not solid ink.
  const { boxes, textLabels } = findTextLines(cc, w, h, new Set<number>());

  // 3. Stroke widths, solid ink (text left out).
  const paper = new Uint8Array(w * h);
  for (let i = 0; i < paper.length; i++) paper[i] = ink[i] && !textLabels.has(cc.labels[i]) ? 0 : 1;
  const dist = distanceTo(paper, w, h);
  const ridges = ridgeWidths(ink, dist, w, h);
  let solidWidth = options.solidWidth === 0 ? null : (options.solidWidth ?? solidThreshold(ridges));
  const penTop = solidWidth ? pensTop(ridges, solidWidth) : pensTop(ridges, 1e9);
  let solid = new Uint8Array(w * h);
  const solidMask = (sw: number) => {
    const out = new Uint8Array(w * h);
    const r = (sw + 1) / 2;
    const core = new Uint8Array(w * h);
    let any = false;
    for (let i = 0; i < core.length; i++)
      if (!paper[i] && dist[i] >= r) {
        core[i] = 1;
        any = true;
      }
    if (!any) return out;
    const toCore = distanceTo(core, w, h);
    for (let i = 0; i < out.length; i++) out[i] = !paper[i] && toCore[i] <= r - 0.5 ? 1 : 0;
    return out;
  };
  if (solidWidth) {
    solid = solidMask(solidWidth);
    // Heavy outlines in parallel pairs are lines (walls drawn as two lines), unless the width was set by hand.
    if (options.solidWidth === null) {
      let sum = 0,
        n = 0;
      for (let k = Math.ceil(solidWidth * 4); k < ridges.length; k++) {
        sum += (k / 4) * ridges[k];
        n += ridges[k];
      }
      const band = n ? sum / n : solidWidth;
      if (pairedSolidShare(solid, dist, w, h, band) >= 0.5) {
        solidWidth = null;
        solid = new Uint8Array(w * h);
      }
    }
  }

  const b = new DrawingBuilder();
  const Y = (y: number) => h - y;
  const solidLayer = b.layer("Solid ink", "#202020");
  const blockLayer = b.layer("Small solid blocks", "#505050");
  const curveLayer = b.layer("Arcs and circles", "#1f6feb");
  const textLayer = b.layer("Text", "#8250df");

  // 4. Specks of solid ink (arrowheads, ticks, dots) stay line work.
  const minBlock = Math.max(2.5 * penTop, (solidWidth ?? 0) * 1.6);
  {
    const sc0 = components(solid, w, h);
    for (let l = 1; l <= sc0.count; l++) {
      const bw = sc0.x1[l] - sc0.x0[l] + 1,
        bh = sc0.y1[l] - sc0.y0[l] + 1;
      if (sc0.area[l] >= 6 && Math.max(bw, bh) >= minBlock) continue;
      for (let y = sc0.y0[l]; y <= sc0.y1[l]; y++) for (let x = sc0.x0[l]; x <= sc0.x1[l]; x++) if (sc0.labels[y * w + x] === l) solid[y * w + x] = 0;
    }
  }

  // 5. Strokes: everything else, thinned to centre lines.
  const lines = new Uint8Array(w * h);
  for (let i = 0; i < lines.length; i++) {
    if (!ink[i] || solid[i]) continue;
    const l = cc.labels[i];
    if (textLabels.has(l) || cc.area[l] < 4) continue;
    lines[i] = 1;
  }
  thin(lines, w, h);
  pruneSkeleton(lines, w, h);
  const paths = tracePaths(lines, w, h);
  const strokes: Stroke[] = [];
  const arcs: ArcStroke[] = [];
  const widthAt = (p: Pt) => {
    const x = Math.round(p[0]),
      y = Math.round(p[1]);
    return x >= 0 && y >= 0 && x < w && y < h ? Math.max(1, 2 * dist[y * w + x] - 1) : 1;
  };
  for (const path of paths) {
    if (path.length < 3) continue;
    const pts = path.map((i) => [i % w, Math.floor(i / w)] as Pt);
    splitPath(pts, widthAt, strokes, arcs);
  }
  mergeArcs(arcs);

  // Door swings are quarter turns between the plan's directions: ends cut short where the arc meets a wall or its leaf are put back.
  {
    const prelim = directionFamilies(strokes);
    for (const arc of arcs) {
      const snapped = snapSwing(arc.a0, arc.a1, prelim);
      if (snapped) [arc.a0, arc.a1] = snapped;
    }
  }

  // Door leaves drawn heavy enough to pass for solid ink: a solid band along the radius of a door swing is the leaf, a line.
  if (solidWidth) {
    for (const arc of arcs) {
      const sweep = arc.a1 - arc.a0;
      if (sweep < (55 * Math.PI) / 180 || sweep > (125 * Math.PI) / 180) continue;
      for (const a of [arc.a0, arc.a1]) {
        const u: Pt = [Math.cos(a), -Math.sin(a)];
        let inside = 0,
          count = 0;
        for (let f = 0.15; f <= 0.9; f += 0.05) {
          const x = Math.round(arc.c[0] + u[0] * arc.r * f),
            y = Math.round(arc.c[1] + u[1] * arc.r * f);
          count++;
          if (x >= 0 && y >= 0 && x < w && y < h && solid[y * w + x]) inside++;
        }
        if (inside < 0.6 * count) continue;
        const mid = [Math.round(arc.c[0] + u[0] * arc.r * 0.5), Math.round(arc.c[1] + u[1] * arc.r * 0.5)];
        const width = Math.max(1, 2 * dist[mid[1] * w + mid[0]] - 1);
        const half = width / 2 + 1.5;
        const x0 = Math.max(0, Math.floor(Math.min(arc.c[0], arc.c[0] + u[0] * arc.r) - half)),
          x1 = Math.min(w - 1, Math.ceil(Math.max(arc.c[0], arc.c[0] + u[0] * arc.r) + half));
        const y0 = Math.max(0, Math.floor(Math.min(arc.c[1], arc.c[1] + u[1] * arc.r) - half)),
          y1 = Math.min(h - 1, Math.ceil(Math.max(arc.c[1], arc.c[1] + u[1] * arc.r) + half));
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const rx = x - arc.c[0],
              ry = y - arc.c[1];
            const along = rx * u[0] + ry * u[1],
              across = Math.abs(-rx * u[1] + ry * u[0]);
            if (along >= 0.12 * arc.r && along <= arc.r + half && across <= half) solid[y * w + x] = 0;
          }
        strokes.push({ a: [arc.c[0], arc.c[1]], b: [arc.c[0] + u[0] * arc.r, arc.c[1] + u[1] * arc.r], width, curve: false });
      }
    }
  }

  // 6. Solid ink -> fills (outlined), small isolated blocks apart.
  const sc = components(solid, w, h);
  const fillRings: { rings: Pt[][]; block: boolean; round: Circle | null }[] = [];
  for (let l = 1; l <= sc.count; l++) {
    const bw = sc.x1[l] - sc.x0[l] + 1,
      bh = sc.y1[l] - sc.y0[l] + 1;
    if (sc.area[l] < 6 || Math.max(bw, bh) < minBlock) continue;
    const rings = componentRings(sc.labels, w, h, l, sc.x0[l], sc.y0[l], sc.x1[l], sc.y1[l]).map((r) => simplifyRingFit(r, 0.85));
    const fillShare = sc.area[l] / (bw * bh);
    const block = Math.min(bw, bh) >= 0.6 * Math.max(bw, bh) && fillShare >= 0.62 && Math.max(bw, bh) <= Math.max(16, 0.06 * Math.max(w, h)) && rings.length === 1;
    let round: Circle | null = null;
    if (block && fillShare < 0.86) {
      const pts = componentRings(sc.labels, w, h, l, sc.x0[l], sc.y0[l], sc.x1[l], sc.y1[l])[0];
      const fit = pts ? fitCircle(pts) : null;
      if (fit && fit.rms < Math.max(0.6, 0.05 * fit.r)) round = fit;
    }
    fillRings.push({ rings, block, round });
  }
  solid = new Uint8Array(0);

  // 7. Square up: directions from long strokes and fill edges; shared positions.
  const edges: { a: Pt; b: Pt }[] = [];
  for (const f of fillRings) for (const ring of f.rings) for (let k = 0; k < ring.length; k++) edges.push({ a: ring[k], b: ring[(k + 1) % ring.length] });
  const families = directionFamilies([...strokes, ...edges]);
  const placed: (Placed | null)[] = strokes.map((s) => {
    const fam = familyOf(families, s.a, s.b, 2.5);
    if (fam < 0) return null;
    const f = families[fam];
    const o = (f.n[0] * (s.a[0] + s.b[0])) / 2 + (f.n[1] * (s.a[1] + s.b[1])) / 2;
    const sa = f.d[0] * s.a[0] + f.d[1] * s.a[1],
      sb = f.d[0] * s.b[0] + f.d[1] * s.b[1];
    return { fam, o, s0: Math.min(sa, sb), s1: Math.max(sa, sb), len: Math.abs(sb - sa) };
  });
  // Fill rings: each edge placed too; vertices rebuilt afterwards.
  const ringPlaced: (Placed | null)[][][] = fillRings.map((f) =>
    f.rings.map((ring) =>
      ring.map((p, k) => {
        const q = ring[(k + 1) % ring.length];
        const fam = familyOf(families, p, q, 2.5);
        if (fam < 0) return null;
        const fm = families[fam];
        const o = (fm.n[0] * (p[0] + q[0])) / 2 + (fm.n[1] * (p[1] + q[1])) / 2;
        const sa = fm.d[0] * p[0] + fm.d[1] * p[1],
          sb = fm.d[0] * q[0] + fm.d[1] * q[1];
        return { fam, o, s0: sa, s1: sb, len: Math.abs(sb - sa) };
      }),
    ),
  );
  const allPlaced: Placed[] = [];
  for (const p of placed) if (p) allPlaced.push(p);
  for (const f of ringPlaced) for (const r of f) for (const e of r) if (e) allPlaced.push(e);
  clusterOffsets(allPlaced, 0.9, 1.8);

  // Strokes back from their placement, merged along shared lines.
  type Line = { fam: number; o: number; s0: number; s1: number; width: number };
  const straight: Line[] = [];
  const loose: Stroke[] = [];
  strokes.forEach((s, i) => {
    const p = placed[i];
    if (p) straight.push({ fam: p.fam, o: p.o, s0: p.s0, s1: p.s1, width: s.width });
    else loose.push(s);
  });
  straight.sort((p, q) => p.fam - q.fam || p.o - q.o || p.s0 - q.s0);
  const merged: Line[] = [];
  for (const s of straight) {
    const last = merged[merged.length - 1];
    if (last && last.fam === s.fam && Math.abs(last.o - s.o) < 1e-6 && s.s0 <= last.s1 + 1.6 && Math.max(last.width, s.width) / Math.min(last.width, s.width) <= 1.8) {
      const L0 = last.s1 - last.s0,
        L1 = s.s1 - s.s0;
      last.width = (last.width * L0 + s.width * L1) / Math.max(1e-9, L0 + L1);
      last.s1 = Math.max(last.s1, s.s1);
      continue;
    }
    merged.push({ ...s });
  }

  // Hatching: short parallel strokes at a regular spacing (wall patterns) are kept apart from the line work.
  const hatch = findHatching(merged);
  // Thinning bends lines where they meet: line ends are carried on to the line they were heading for.
  extendToMeet(merged, families, hatch);

  // 8. Pens: stroke widths in up to three classes.
  const pens = penClasses(merged.map((m) => ({ width: m.width, len: m.s1 - m.s0 })).concat(loose.map((s) => ({ width: s.width, len: Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) }))));
  const penNames = pens.length === 1 ? ["Lines"] : pens.length === 2 ? ["Thin lines", "Heavy lines"] : ["Thin lines", "Medium lines", "Heavy lines"];
  const penLayers = penNames.map((name) => b.layer(name, name === "Heavy lines" ? "#000000" : name === "Medium lines" ? "#404040" : "#707070"));
  const penOf = (width: number) => {
    let k = 0;
    for (let i = 1; i < pens.length; i++) if (width >= (pens[i - 1] + pens[i]) / 2) k = i;
    return penLayers[k];
  };

  // 9. The drawing (y up).
  const P = (x: number, y: number): Pt => [x, Y(y)];
  const hatchLayer = hatch.size ? b.layer("Hatching", "#9a9a9a") : -1;
  merged.forEach((m, k) => {
    if (m.s1 - m.s0 < 1.5) return;
    const f = families[m.fam];
    const a = P(f.d[0] * m.s0 + f.n[0] * m.o, f.d[1] * m.s0 + f.n[1] * m.o);
    const c = P(f.d[0] * m.s1 + f.n[0] * m.o, f.d[1] * m.s1 + f.n[1] * m.o);
    b.seg(a[0], a[1], c[0], c[1], hatch.has(k) ? hatchLayer : penOf(m.width), -1, 0);
  });
  for (const s of loose) {
    const a = P(s.a[0], s.a[1]),
      c = P(s.b[0], s.b[1]);
    b.seg(a[0], a[1], c[0], c[1], penOf(s.width), -1, 0);
  }
  for (const arc of arcs) {
    const c = P(arc.c[0], arc.c[1]);
    const [a0, a1] = snapSwing(arc.a0, arc.a1, families) ?? [arc.a0, arc.a1];
    b.arcs.push({ c, r: arc.r, a0, a1, layer: curveLayer, symbol: -1, flags: 0 });
    for (let k = 0; k + 1 < arc.points.length; k += Math.max(1, Math.floor(arc.points.length / 24))) {
      const p = arc.points[k],
        q = arc.points[Math.min(arc.points.length - 1, k + Math.max(1, Math.floor(arc.points.length / 24)))];
      b.seg(p[0], Y(p[1]), q[0], Y(q[1]), curveLayer, -1, F_CURVE);
    }
  }
  let fillCount = 0,
    blockCount = 0;
  fillRings.forEach((f, fi) => {
    const rings = f.rings
      .map((ring, ri) => rebuildRing(ring, ringPlaced[fi][ri], families))
      .filter((r) => r.length >= 3)
      .map((r) => r.map(([x, y]) => P(x, y)));
    if (!rings.length) return;
    if (f.block) {
      blockCount++;
      b.fills.push({ rings, layer: blockLayer, symbol: -1, solid: true, flags: 0 });
      b.polys.push({ points: rings[0], layer: blockLayer, symbol: -1, flags: 0 });
      if (f.round) b.arcs.push({ c: P(f.round.c[0], f.round.c[1]), r: f.round.r, a0: 0, a1: 2 * Math.PI, layer: blockLayer, symbol: -1, flags: 0 });
    } else {
      fillCount++;
      b.fills.push({ rings, layer: solidLayer, symbol: -1, solid: true, flags: 0 });
    }
  });
  const drawing = b.build("picture", null, "pixels");
  drawing.bbox = [0, 0, w, h];
  void textLayer;
  return {
    drawing,
    boxes,
    sheets: textSheets(norm, w, h, cc, textLabels, boxes),
    stats: {
      threshold,
      flattened: !!flat,
      solidWidth: solidWidth ?? null,
      pens,
      segments: drawing.segLayer.length,
      arcs: arcs.length,
      fills: fillCount,
      blocks: blockCount,
      textBoxes: boxes.length,
      direction: families[0]?.angle ?? 0,
      seconds: (Date.now() - started) / 1000,
    },
  };
}

/** Line ends stopped short of a crossing line (within a few pen widths) are extended to it. */
function extendToMeet(lines: { fam: number; o: number; s0: number; s1: number; width: number }[], families: Family[], skip: Set<number>) {
  const n = lines.length;
  const ext0 = new Float64Array(n).fill(NaN),
    ext1 = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (skip.has(i)) continue;
    const A = lines[i];
    const fa = families[A.fam];
    if (A.s1 - A.s0 < 4) continue;
    let best0 = Infinity,
      best1 = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i || skip.has(j)) continue;
      const B = lines[j];
      if (B.fam === A.fam) continue;
      const fb = families[B.fam];
      // Intersection of the two lines: p = dA·t + nA·oA = dB·u + nB·oB.
      const den = fa.d[0] * fb.d[1] - fa.d[1] * fb.d[0];
      if (Math.abs(den) < 0.2) continue;
      const pa: Pt = [fa.n[0] * A.o, fa.n[1] * A.o],
        pb: Pt = [fb.n[0] * B.o, fb.n[1] * B.o];
      const t = ((pb[0] - pa[0]) * fb.d[1] - (pb[1] - pa[1]) * fb.d[0]) / den;
      const x: Pt = [pa[0] + fa.d[0] * t, pa[1] + fa.d[1] * t];
      const sA = fa.d[0] * x[0] + fa.d[1] * x[1];
      const sB = fb.d[0] * x[0] + fb.d[1] * x[1];
      const reach = 3 * Math.max(A.width, B.width) + 4;
      // The line met is often broken exactly there (at the junction itself): a pen width of slack.
      const tolB = B.width / 2 + A.width + 3;
      if (sB < B.s0 - tolB || sB > B.s1 + tolB) continue;
      if (sA > A.s1 && sA - A.s1 <= reach && sA - A.s1 < best1) best1 = sA - A.s1;
      if (sA < A.s0 && A.s0 - sA <= reach && A.s0 - sA < best0) best0 = A.s0 - sA;
    }
    if (best1 < Infinity) ext1[i] = A.s1 + best1;
    if (best0 < Infinity) ext0[i] = A.s0 - best0;
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(ext0[i])) lines[i].s0 = ext0[i];
    if (!Number.isNaN(ext1[i])) lines[i].s1 = ext1[i];
  }
}

/**
 * Hatching: within a direction, runs of four or more short strokes, side by
 * side at an even spacing (within 20%), each no longer than eight spacings.
 * Returns the indices of the hatch strokes.
 */
function findHatching(lines: { fam: number; o: number; s0: number; s1: number }[]): Set<number> {
  const out = new Set<number>();
  const byFam = new Map<number, number[]>();
  lines.forEach((l, i) => {
    const list = byFam.get(l.fam);
    if (list) list.push(i);
    else byFam.set(l.fam, [i]);
  });
  for (const idx of byFam.values()) {
    if (idx.length < 8) continue;
    idx.sort((p, q) => lines[p].o - lines[q].o);
    // Nearest neighbour across (overlapping along the line) for each stroke.
    const next = new Int32Array(idx.length).fill(-1);
    for (let a = 0; a < idx.length; a++) {
      const p = lines[idx[a]];
      for (let c = a + 1; c < idx.length && c < a + 40; c++) {
        const q = lines[idx[c]];
        if (q.o - p.o < 1.5) continue;
        if (Math.min(p.s1, q.s1) - Math.max(p.s0, q.s0) > 0.3 * Math.min(p.s1 - p.s0, q.s1 - q.s0)) {
          next[a] = c;
          break;
        }
      }
    }
    // Chains of strokes linked to their neighbour at a steady spacing.
    const seen = new Uint8Array(idx.length);
    for (let a = 0; a < idx.length; a++) {
      if (seen[a]) continue;
      const chain = [a];
      let cur = a;
      while (next[cur] >= 0 && !seen[next[cur]]) {
        const nx = next[cur];
        const gap = lines[idx[nx]].o - lines[idx[cur]].o;
        if (chain.length >= 2) {
          const prevGap = lines[idx[cur]].o - lines[idx[chain[chain.length - 2]]].o;
          if (Math.abs(gap - prevGap) > 0.2 * prevGap + 1) break;
        }
        chain.push(nx);
        cur = nx;
      }
      if (chain.length < 4) continue;
      const spacing = (lines[idx[chain[chain.length - 1]]].o - lines[idx[chain[0]]].o) / (chain.length - 1);
      const short = chain.filter((c) => lines[idx[c]].s1 - lines[idx[c]].s0 <= 8 * spacing);
      if (short.length < 0.8 * chain.length || spacing > 60) continue;
      for (const c of chain) {
        seen[c] = 1;
        if (lines[idx[c]].s1 - lines[idx[c]].s0 <= 8 * spacing) out.add(idx[c]);
      }
    }
  }
  return out;
}

/** Typical stroke widths (1 to 3 pens) from length-weighted widths. */
function penClasses(items: { width: number; len: number }[]): number[] {
  const list = items.filter((i) => i.len >= 6 && i.width > 0).sort((p, q) => p.width - q.width);
  if (!list.length) return [1];
  const mean = (xs: typeof list) => {
    let s = 0,
      wsum = 0;
    for (const x of xs) {
      s += Math.log(x.width) * x.len;
      wsum += x.len;
    }
    return { m: Math.exp(s / Math.max(1e-9, wsum)), w: wsum };
  };
  const split = (xs: typeof list): [typeof list, typeof list] | null => {
    if (xs.length < 4) return null;
    const total = mean(xs).w;
    let best = -1,
      at = -1;
    for (let k = 1; k < xs.length; k++) {
      if (xs[k].width === xs[k - 1].width) continue;
      const a = mean(xs.slice(0, k)),
        c = mean(xs.slice(k));
      if (a.w < 0.06 * total || c.w < 0.06 * total) continue;
      const between = a.w * c.w * Math.pow(Math.log(c.m / a.m), 2);
      if (between > best) {
        best = between;
        at = k;
      }
    }
    if (at < 0) return null;
    const lo = xs.slice(0, at),
      hi = xs.slice(at);
    const ml = mean(lo).m,
      mh = mean(hi).m;
    if (mh / ml < 1.45 || mh - ml < 0.9) return null;
    return [lo, hi];
  };
  const two = split(list);
  if (!two) return [mean(list).m];
  const [lo, hi] = two;
  const third = split(hi) ?? null;
  const thirdLo = third ? null : split(lo);
  if (third) return [mean(lo).m, mean(third[0]).m, mean(third[1]).m];
  if (thirdLo) return [mean(thirdLo[0]).m, mean(thirdLo[1]).m, mean(hi).m];
  return [mean(lo).m, mean(hi).m];
}

/** A fill outline after its edges were squared up: corners where neighbouring edges meet, steps kept, slivers dropped. */
function rebuildRing(ring: Pt[], placed: (Placed | null)[], families: Family[]): Pt[] {
  const n = ring.length;
  if (n < 3) return ring;
  // Each edge as a line (point + direction).
  const linesOf = ring.map((p, k) => {
    const q = ring[(k + 1) % n];
    const pl = placed[k];
    if (pl) {
      const f = families[pl.fam];
      return { p: [f.d[0] * pl.s0 + f.n[0] * pl.o, f.d[1] * pl.s0 + f.n[1] * pl.o] as Pt, d: f.d, fam: pl.fam, o: pl.o, len: pl.len };
    }
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return { p, d: [(q[0] - p[0]) / L, (q[1] - p[1]) / L] as Pt, fam: -1, o: 0, len: L };
  });
  // Short unsquared edges between squared edges of two directions are rounded corners: dropped, the neighbours meet.
  const bevel = linesOf.map((e, k) => e.fam < 0 && e.len < 6 && linesOf[(k - 1 + n) % n].fam >= 0 && linesOf[(k + 1) % n].fam >= 0 && linesOf[(k - 1 + n) % n].fam !== linesOf[(k + 1) % n].fam);
  const keepIdx: number[] = [];
  for (let k = 0; k < n; k++) if (!bevel[k]) keepIdx.push(k);
  if (keepIdx.length < 3) return ring;
  const out: Pt[] = [];
  for (let m = 0; m < keepIdx.length; m++) {
    const k = keepIdx[m];
    const prev = linesOf[keepIdx[(m - 1 + keepIdx.length) % keepIdx.length]],
      cur = linesOf[k];
    const afterBevel = bevel[(k - 1 + n) % n];
    const v = ring[k];
    if (prev.fam >= 0 && prev.fam === cur.fam) {
      if (Math.abs(prev.o - cur.o) < 1e-6) continue; // the same line: no corner
      // A step between two parallel lines: both feet of the original corner.
      const f = families[cur.fam];
      const s = f.d[0] * v[0] + f.d[1] * v[1];
      out.push([f.d[0] * s + f.n[0] * prev.o, f.d[1] * s + f.n[1] * prev.o], [f.d[0] * s + f.n[0] * cur.o, f.d[1] * s + f.n[1] * cur.o]);
      continue;
    }
    const den = prev.d[0] * cur.d[1] - prev.d[1] * cur.d[0];
    if (Math.abs(den) > 1e-6) {
      const t = ((cur.p[0] - prev.p[0]) * cur.d[1] - (cur.p[1] - prev.p[1]) * cur.d[0]) / den;
      const x: Pt = [prev.p[0] + prev.d[0] * t, prev.p[1] + prev.d[1] * t];
      if (Math.hypot(x[0] - v[0], x[1] - v[1]) <= (afterBevel ? 8 : 3)) {
        out.push(x);
        continue;
      }
    }
    out.push([v[0], v[1]]);
  }
  // Drop slivers and repeated points.
  const clean: Pt[] = [];
  for (const p of out) {
    const last = clean[clean.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.3) continue;
    clean.push(p);
  }
  if (clean.length > 2 && Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) < 0.3) clean.pop();
  return clean;
}

/** OCR results back into the drawing: one text per box (rows-down pixels -> y up). */
export function addTexts(d: VectorDrawing, height: number, boxes: TextBox[], texts: { box: number; text: string }[]) {
  let layer = d.layers.findIndex((l) => l.name === "Text");
  if (layer < 0) {
    layer = d.layers.length;
    d.layers.push({ name: "Text", color: "#8250df", off: false });
  }
  d.texts = d.texts.filter((t) => t.layer !== layer);
  for (const t of texts) {
    const box = boxes[t.box];
    if (!box || !t.text.trim()) continue;
    const [x0, y0, x1, y1] = box.box;
    d.texts.push({ c: [(x0 + x1) / 2, height - (y0 + y1) / 2], text: t.text.trim(), h: box.h, rotation: box.vertical ? Math.PI / 2 : 0, layer, symbol: -1, flags: 0 });
  }
}
