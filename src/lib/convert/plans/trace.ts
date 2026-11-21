// Wall and slab tracing on a raster floor plan (an image, or a PDF page
// rendered to pixels). Runs in a worker; everything is in pixels here, the
// Convert page turns pixels into metres with the plan's calibration.
//
// Walls drawn three ways are handled:
//   filled  - walls are solid (poché) strokes: thick ink, thinner lines
//             (text, dimensions, hatching, furniture) are ignored;
//   double  - walls are two parallel lines: parallel line pairs at a
//             plausible wall thickness become one wall;
//   single  - every long line is a wall centre line (sketches, renders).
// Lines are found on the skeleton of the wall ink, simplified to straight
// segments, merged where collinear, optionally snapped to the plan's two
// main directions, and joined at corners. The slab outline is the outside
// boundary of the walls with door-sized gaps closed.

export type TraceMode = "filled" | "double" | "single";

export interface TraceInput {
  width: number;
  height: number;
  /** Luminance 0..255 per pixel. */
  gray: Uint8Array;
}

export interface TraceOptions {
  mode: TraceMode;
  /** Walls are darker than the paper (usual) or lighter (dark renders). */
  darkWalls: boolean;
  /** 0..255; null for automatic (Otsu). */
  threshold: number | null;
  /** Pixels. */
  minThickness: number;
  maxThickness: number;
  /** Thickness given to single-line walls, pixels. */
  defaultThickness: number;
  /** Shortest wall kept, pixels. */
  minLength: number;
  /** Door-sized gaps closed when finding the outline, pixels. */
  closeGap: number;
  /** Snap near-orthogonal walls to the plan's main directions. */
  orthogonal: boolean;
  /** Only look inside this rectangle [x0, y0, x1, y1] (pixels), e.g. to skip a title block. */
  region?: [number, number, number, number] | null;
}

export interface TracedWall {
  a: [number, number];
  b: [number, number];
  thickness: number;
}

export interface TraceResult {
  walls: TracedWall[];
  /** Outside boundary of the walls, pixels, counter-clockwise on screen. */
  outline: [number, number][];
  threshold: number;
  /** Main direction of the walls (radians, image axes). */
  direction: number;
  inkShare: number;
}

export const DEFAULT_TRACE: TraceOptions = {
  mode: "filled",
  darkWalls: true,
  threshold: null,
  minThickness: 4,
  maxThickness: 60,
  defaultThickness: 8,
  minLength: 20,
  closeGap: 25,
  orthogonal: true,
  region: null,
};

// ---------------------------------------------------------------------------
// Raster helpers

export function otsu(gray: Uint8Array, mask?: Uint8Array): number {
  const hist = new Float64Array(256);
  let n = 0;
  for (let i = 0; i < gray.length; i++) {
    if (mask && !mask[i]) continue;
    hist[gray[i]]++;
    n++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0,
    wB = 0,
    best = 0,
    threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** Squared-distance transform along one line (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Euclidean distance from every pixel to the nearest pixel where `feature` is set. */
export function distanceTo(feature: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e20;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = feature[y * w + x] ? 0 : INF;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const dist = distanceTo(mask, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = dist[i] <= r ? 1 : 0;
  return out;
}

function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
  const grown = dilate(inv, w, h, r);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = grown[i] ? 0 : 1;
  return out;
}

/** Zhang–Suen thinning, on a list of foreground pixels. Modifies `mask`. */
export function thin(mask: Uint8Array, w: number, h: number) {
  let list: number[] = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (mask[y * w + x]) list.push(y * w + x);
  for (let y = 0; y < h; y++) {
    mask[y * w] = 0;
    mask[y * w + w - 1] = 0;
  }
  for (let x = 0; x < w; x++) {
    mask[x] = 0;
    mask[(h - 1) * w + x] = 0;
  }
  const remove: number[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      remove.length = 0;
      for (const i of list) {
        if (!mask[i]) continue;
        const p2 = mask[i - w],
          p3 = mask[i - w + 1],
          p4 = mask[i + 1],
          p5 = mask[i + w + 1],
          p6 = mask[i + w],
          p7 = mask[i + w - 1],
          p8 = mask[i - 1],
          p9 = mask[i - w - 1];
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (b < 2 || b > 6) continue;
        const a = (!p2 && p3 ? 1 : 0) + (!p3 && p4 ? 1 : 0) + (!p4 && p5 ? 1 : 0) + (!p5 && p6 ? 1 : 0) + (!p6 && p7 ? 1 : 0) + (!p7 && p8 ? 1 : 0) + (!p8 && p9 ? 1 : 0) + (!p9 && p2 ? 1 : 0);
        if (a !== 1) continue;
        if (step === 0 ? p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0 : p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
        remove.push(i);
      }
      if (remove.length) {
        changed = true;
        for (const i of remove) mask[i] = 0;
      }
    }
    list = list.filter((i) => mask[i]);
  }
}

const N8 = (w: number) => [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];

/** Skeleton -> polylines (pixel indices), split at endpoints and junctions; loops included. */
export function tracePaths(skel: Uint8Array, w: number, h: number): number[][] {
  const nb = N8(w);
  const degree = new Uint8Array(w * h);
  const pixels: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!skel[i]) continue;
      let c = 0;
      for (const o of nb) if (skel[i + o]) c++;
      degree[i] = c;
      pixels.push(i);
    }
  }
  const isNode = (i: number) => degree[i] !== 2;
  const visited = new Uint8Array(w * h);
  const paths: number[][] = [];
  const walk = (start: number, next: number) => {
    const path = [start, next];
    let prev = start;
    let cur = next;
    while (!isNode(cur)) {
      visited[cur] = 1;
      let step = -1;
      for (const o of nb) {
        const j = cur + o;
        if (skel[j] && j !== prev && !(visited[j] && !isNode(j)) && j !== start) {
          step = j;
          break;
        }
      }
      if (step < 0) break;
      path.push(step);
      prev = cur;
      cur = step;
    }
    return path;
  };
  const usedEdge = new Set<number>();
  for (const i of pixels) {
    if (!isNode(i) || degree[i] === 0) continue;
    for (const o of nb) {
      const j = i + o;
      if (!skel[j]) continue;
      if (isNode(j)) {
        const key = Math.min(i, j) * 2 + (i < j ? 0 : 1);
        const key2 = Math.min(i, j) * w * h + Math.max(i, j);
        if (usedEdge.has(key2)) continue;
        usedEdge.add(key2);
        void key;
        paths.push([i, j]);
        continue;
      }
      if (visited[j]) continue;
      paths.push(walk(i, j));
    }
  }
  // Loops (every pixel of degree 2): rooms drawn as closed rings.
  for (const i of pixels) {
    if (visited[i] || isNode(i)) continue;
    visited[i] = 1;
    let next = -1;
    for (const o of nb) if (skel[i + o]) next = i + o;
    if (next < 0) continue;
    const path = walk(i, next);
    path.push(i);
    paths.push(path);
  }
  return paths;
}

/** Douglas–Peucker on points [x, y][]; returns the kept points. */
export function simplify(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax,
      dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1,
      at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Douglas–Peucker on a closed ring (no repeated end point). */
export function simplifyRing(ring: [number, number][], tolerance: number): [number, number][] {
  if (ring.length <= 3) return ring.slice();
  // Split at the point farthest from the first one, simplify both halves.
  let far = 0,
    farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const first = simplify(ring.slice(0, far + 1), tolerance);
  const second = simplify(ring.slice(far).concat([ring[0]]), tolerance);
  return first.concat(second.slice(1, -1));
}

// ---------------------------------------------------------------------------
// Segments

interface Seg {
  a: [number, number];
  b: [number, number];
  t: number;
}

const length = (s: Seg) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);

/** Greedy merge of collinear, overlapping or nearly touching segments. */
export function mergeCollinear(segs: Seg[], angleTol = 4, offsetTol = 3, gapTol = 6): Seg[] {
  const order = segs.map((_, i) => i).sort((i, j) => length(segs[j]) - length(segs[i]));
  const used = new Uint8Array(segs.length);
  const cosTol = 1 - Math.cos((angleTol * Math.PI) / 180);
  const out: Seg[] = [];
  for (const i of order) {
    if (used[i]) continue;
    used[i] = 1;
    const s = segs[i];
    const L = length(s) || 1;
    const d = [(s.b[0] - s.a[0]) / L, (s.b[1] - s.a[1]) / L];
    const n = [-d[1], d[0]];
    let lo = 0,
      hi = L;
    const offs = [0];
    const ts = [s.t];
    for (let changed = true; changed; ) {
      changed = false;
      for (const j of order) {
        if (used[j]) continue;
        const o = segs[j];
        const Lj = length(o) || 1;
        const dj = [(o.b[0] - o.a[0]) / Lj, (o.b[1] - o.a[1]) / Lj];
        if (Math.abs(Math.abs(d[0] * dj[0] + d[1] * dj[1]) - 1) > cosTol) continue;
        const tol = Math.max(offsetTol, Math.min(s.t, o.t) / 2);
        const oc = (o.a[0] - s.a[0]) * n[0] + (o.a[1] - s.a[1]) * n[1];
        const oe = (o.b[0] - s.a[0]) * n[0] + (o.b[1] - s.a[1]) * n[1];
        if (Math.abs(oc) > tol || Math.abs(oe) > tol) continue;
        let tc = (o.a[0] - s.a[0]) * d[0] + (o.a[1] - s.a[1]) * d[1];
        let te = (o.b[0] - s.a[0]) * d[0] + (o.b[1] - s.a[1]) * d[1];
        if (tc > te) [tc, te] = [te, tc];
        const gap = Math.max(gapTol, Math.max(s.t, o.t));
        if (tc > hi + gap || te < lo - gap) continue;
        lo = Math.min(lo, tc);
        hi = Math.max(hi, te);
        offs.push(oc, oe);
        ts.push(o.t);
        used[j] = 1;
        changed = true;
      }
    }
    const o = offs.reduce((a, b) => a + b, 0) / offs.length;
    const t = ts.sort((a, b) => a - b)[Math.floor(ts.length / 2)];
    out.push({ a: [s.a[0] + d[0] * lo + n[0] * o, s.a[1] + d[1] * lo + n[1] * o], b: [s.a[0] + d[0] * hi + n[0] * o, s.a[1] + d[1] * hi + n[1] * o], t });
  }
  return out;
}

/** The main wall direction (radians in [0, π/2)), from a length-weighted histogram of angles mod 90°, refined to the mean of the peak. */
export function mainDirection(segs: Seg[]): number {
  const quarter = Math.PI / 2;
  const angleOf = (seg: Seg) => {
    const a = Math.atan2(seg.b[1] - seg.a[1], seg.b[0] - seg.a[0]);
    return ((a % quarter) + quarter) % quarter;
  };
  const bins = new Float64Array(180);
  for (const seg of segs) bins[Math.min(179, Math.floor((angleOf(seg) / quarter) * 180))] += length(seg);
  let best = 0;
  let bestValue = -1;
  for (let i = 0; i < 180; i++) {
    const v = bins[(i + 179) % 180] * 0.5 + bins[i] + bins[(i + 1) % 180] * 0.5;
    if (v > bestValue) {
      bestValue = v;
      best = i;
    }
  }
  const peak = ((best + 0.5) / 180) * quarter;
  // Length-weighted mean of the angles near the peak (on the 90° circle).
  let sx = 0,
    sy = 0;
  for (const seg of segs) {
    let a = angleOf(seg);
    let diff = a - peak;
    if (diff > quarter / 2) diff -= quarter;
    if (diff < -quarter / 2) diff += quarter;
    if (Math.abs(diff) > (2 * Math.PI) / 180) continue;
    a = peak + diff;
    sx += Math.cos(a * 4) * length(seg);
    sy += Math.sin(a * 4) * length(seg);
  }
  if (sx === 0 && sy === 0) return peak;
  const mean = Math.atan2(sy, sx) / 4;
  return ((mean % quarter) + quarter) % quarter;
}

/** Rotates segments within `tol` degrees of the main directions onto them (about their midpoints). */
export function snapOrthogonal(segs: Seg[], direction: number, tol = 6): Seg[] {
  return segs.map((s) => {
    const L = length(s);
    const angle = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]);
    let best = angle;
    let bestDiff = Infinity;
    for (let k = -4; k <= 4; k++) {
      const target = direction + (k * Math.PI) / 2;
      const diff = Math.abs(angle - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = target;
      }
    }
    if ((bestDiff * 180) / Math.PI > tol) return s;
    const mx = (s.a[0] + s.b[0]) / 2,
      my = (s.a[1] + s.b[1]) / 2;
    const dx = (Math.cos(best) * L) / 2,
      dy = (Math.sin(best) * L) / 2;
    return { a: [mx - dx, my - dy], b: [mx + dx, my + dy], t: s.t };
  });
}

function intersect(p: [number, number], d: [number, number], q: [number, number], e: [number, number]): number | null {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-9) return null;
  return ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
}

/**
 * Joins walls at corners and T-junctions: an end near another wall is moved
 * to where the two centre lines cross, then extended by half the other
 * wall's thickness so the corner is filled.
 */
export function joinWalls(segs: Seg[], reach = 1.5, extendFree = false): Seg[] {
  const out = segs.map((s) => ({ a: [...s.a] as [number, number], b: [...s.b] as [number, number], t: s.t }));
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    for (const end of ["a", "b"] as const) {
      const p = s[end];
      const other = end === "a" ? s.b : s.a;
      const L = Math.hypot(p[0] - other[0], p[1] - other[1]) || 1;
      const d: [number, number] = [(p[0] - other[0]) / L, (p[1] - other[1]) / L]; // pointing out of the wall
      let best: { t: number; extend: number } | null = null;
      for (let j = 0; j < out.length; j++) {
        if (j === i) continue;
        const o = out[j];
        const Lo = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) || 1;
        const e: [number, number] = [(o.b[0] - o.a[0]) / Lo, (o.b[1] - o.a[1]) / Lo];
        if (Math.abs(d[0] * e[0] + d[1] * e[1]) > 0.94) continue; // parallel
        const t = intersect(p, d, o.a, e);
        if (t === null) continue;
        const limit = Math.max(o.t, s.t) * reach + 2;
        if (Math.abs(t) > limit) continue;
        const x = p[0] + d[0] * t,
          y = p[1] + d[1] * t;
        const along = (x - o.a[0]) * e[0] + (y - o.a[1]) * e[1];
        if (along < -limit || along > Lo + limit) continue;
        if (!best || Math.abs(t) < Math.abs(best.t)) best = { t, extend: o.t / 2 };
      }
      if (best) {
        const t = best.t + best.extend;
        p[0] += d[0] * t;
        p[1] += d[1] * t;
      } else if (extendFree) {
        // A skeleton stops about half a stroke short of a free end (a door or window jamb).
        p[0] += (d[0] * s.t) / 2;
        p[1] += (d[1] * s.t) / 2;
      }
    }
  }
  return out;
}

/**
 * Outer boundary of the largest 4-connected blob in `mask`, as points on the
 * pixel-corner lattice (marching squares, inside kept on the right).
 */
export function outerBoundary(mask: Uint8Array, w: number, h: number): [number, number][] {
  const label = new Int32Array(w * h).fill(-1);
  let bestLabel = -1,
    bestSize = 0,
    bestStart = -1;
  const stack: number[] = [];
  let next = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    let size = 0;
    label[i] = next;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % w;
      for (const k of [j - w, j + w, x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1]) {
        if (k >= 0 && k < w * h && mask[k] && label[k] < 0) {
          label[k] = next;
          stack.push(k);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = next;
      bestStart = i;
    }
    next++;
  }
  if (bestStart < 0) return [];
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && label[y * w + x] === bestLabel;
  // Directions: 0 east, 1 south, 2 west, 3 north (screen coordinates, y down).
  const DX = [1, 0, -1, 0],
    DY = [0, 1, 0, -1];
  const canExit = (x: number, y: number, dir: number) => {
    const a = inside(x - 1, y - 1),
      b = inside(x, y - 1),
      c = inside(x - 1, y),
      d = inside(x, y);
    if (dir === 0) return !b && d;
    if (dir === 1) return c && !d;
    if (dir === 2) return a && !c;
    return b && !a;
  };
  const sx = bestStart % w,
    sy = Math.floor(bestStart / w);
  const out: [number, number][] = [[sx, sy]];
  let x = sx,
    y = sy,
    dir = 0;
  for (let guard = 0; guard < 4 * (w + 1) * (h + 1); guard++) {
    x += DX[dir];
    y += DY[dir];
    if (x === sx && y === sy) break;
    // Prefer turning right (hugs the inside), then straight, then left.
    let moved = false;
    for (const turn of [1, 0, 3]) {
      const nd = (dir + turn) % 4;
      if (canExit(x, y, nd)) {
        if (nd !== dir) out.push([x, y]);
        dir = nd;
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main

export function trace(input: TraceInput, options: TraceOptions): TraceResult {
  const { width: w, height: h, gray } = input;
  const region = options.region;
  const inRegion = (x: number, y: number) => !region || (x >= region[0] && x <= region[2] && y >= region[1] && y <= region[3]);
  const threshold = options.threshold ?? otsu(gray);
  const ink = new Uint8Array(w * h);
  let inkCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const g = gray[i];
      if (inRegion(x, y) && (options.darkWalls ? g <= threshold : g > threshold)) {
        ink[i] = 1;
        inkCount++;
      }
    }
  }

  // Distance from every ink pixel to the paper: half the local stroke width.
  const paper = new Uint8Array(w * h);
  for (let i = 0; i < paper.length; i++) paper[i] = ink[i] ? 0 : 1;
  const half = distanceTo(paper, w, h);

  let wallMask: Uint8Array;
  if (options.mode === "filled") {
    // Opening with a disc of the minimum wall thickness: thin strokes vanish, walls stay.
    const core = new Uint8Array(w * h);
    const r = options.minThickness / 2;
    for (let i = 0; i < core.length; i++) core[i] = ink[i] && half[i] >= r ? 1 : 0;
    const grown = dilate(core, w, h, r + 0.5);
    wallMask = new Uint8Array(w * h);
    for (let i = 0; i < wallMask.length; i++) wallMask[i] = grown[i] && ink[i] ? 1 : 0;
  } else wallMask = ink.slice();

  // Skeleton -> straight runs.
  const skel = wallMask.slice();
  thin(skel, w, h);
  const paths = tracePaths(skel, w, h);
  let segs: Seg[] = [];
  const minLen = options.mode === "double" ? options.minLength / 2 : options.minLength;
  for (const path of paths) {
    const pts = path.map((i) => [i % w, Math.floor(i / w)] as [number, number]);
    const simplified = simplify(pts, Math.max(1.5, options.minThickness / 3));
    for (let k = 0; k + 1 < simplified.length; k++) {
      const a = simplified[k],
        b = simplified[k + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < minLen) continue;
      // Stroke width along the run (median of the distance map on the skeleton).
      const samples: number[] = [];
      const n = Math.max(2, Math.floor(L / 2));
      for (let s = 1; s < n; s++) {
        const x = Math.round(a[0] + ((b[0] - a[0]) * s) / n),
          y = Math.round(a[1] + ((b[1] - a[1]) * s) / n);
        samples.push(half[y * w + x] * 2);
      }
      samples.sort((p, q) => p - q);
      const t = samples.length ? samples[Math.floor(samples.length / 2)] : options.minThickness;
      segs.push({ a, b, t: Math.max(1, t) });
    }
  }

  if (options.mode === "filled") segs = segs.filter((s) => s.t >= options.minThickness * 0.8 && s.t <= options.maxThickness);
  if (options.mode === "single") segs = segs.map((s) => ({ ...s, t: options.defaultThickness }));
  // Drawn lines break where other lines join them; bridge breaks up to a wall's thickness (not door gaps).
  segs = mergeCollinear(segs, 4, 2, options.mode === "filled" ? 4 : Math.max(4, options.maxThickness));

  if (options.mode === "double") {
    // Pair parallel lines a wall's thickness apart.
    const order = segs.map((_, i) => i).sort((i, j) => length(segs[j]) - length(segs[i]));
    const used = new Uint8Array(segs.length);
    const walls: Seg[] = [];
    for (const i of order) {
      if (used[i]) continue;
      const s = segs[i];
      const L = length(s) || 1;
      const d = [(s.b[0] - s.a[0]) / L, (s.b[1] - s.a[1]) / L];
      const n = [-d[1], d[0]];
      let best = -1,
        bestScore = 0,
        bestOffset = 0,
        bestRange: [number, number] = [0, 0];
      for (const j of order) {
        if (j === i || used[j]) continue;
        const o = segs[j];
        const Lj = length(o) || 1;
        const dj = [(o.b[0] - o.a[0]) / Lj, (o.b[1] - o.a[1]) / Lj];
        if (Math.abs(d[0] * dj[0] + d[1] * dj[1]) < Math.cos((3 * Math.PI) / 180)) continue;
        const oa = (o.a[0] - s.a[0]) * n[0] + (o.a[1] - s.a[1]) * n[1];
        const ob = (o.b[0] - s.a[0]) * n[0] + (o.b[1] - s.a[1]) * n[1];
        const offset = (oa + ob) / 2;
        if (Math.abs(offset) < options.minThickness || Math.abs(offset) > options.maxThickness || Math.abs(oa - ob) > 2) continue;
        let ta = (o.a[0] - s.a[0]) * d[0] + (o.a[1] - s.a[1]) * d[1];
        let tb = (o.b[0] - s.a[0]) * d[0] + (o.b[1] - s.a[1]) * d[1];
        if (ta > tb) [ta, tb] = [tb, ta];
        const lo = Math.max(0, ta),
          hi = Math.min(L, tb);
        const overlap = hi - lo;
        if (overlap < Math.min(L, Lj) * 0.5) continue;
        const score = overlap / (1 + Math.abs(offset));
        if (score > bestScore) {
          bestScore = score;
          best = j;
          bestOffset = offset;
          bestRange = [lo, hi];
        }
      }
      if (best < 0) continue;
      used[i] = used[best] = 1;
      const [lo, hi] = bestRange;
      const m = bestOffset / 2;
      walls.push({ a: [s.a[0] + d[0] * lo + n[0] * m, s.a[1] + d[1] * lo + n[1] * m], b: [s.a[0] + d[0] * hi + n[0] * m, s.a[1] + d[1] * hi + n[1] * m], t: Math.abs(bestOffset) });
    }
    segs = mergeCollinear(walls, 4, 2, 4);
  }

  segs = segs.filter((s) => length(s) >= options.minLength);
  const direction = mainDirection(segs);
  if (options.orthogonal) segs = mergeCollinear(snapOrthogonal(segs, direction), 2, 2, 4);
  segs = joinWalls(segs, 1.5, options.mode === "filled");

  // Slab outline: walls (as drawn), door gaps closed, holes filled, outside boundary.
  const solid = new Uint8Array(w * h);
  for (const s of segs) {
    // The wall's footprint: a rectangle along the segment (square ends, so corners stay square).
    const L = length(s) || 1;
    const d = [(s.b[0] - s.a[0]) / L, (s.b[1] - s.a[1]) / L];
    const half = Math.max(0.5, s.t / 2);
    const xs = [s.a[0], s.b[0]].flatMap((x) => [x - half, x + half]);
    const ys = [s.a[1], s.b[1]].flatMap((y) => [y - half, y + half]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))),
      x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))),
      y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const rx = px + 0.5 - s.a[0],
          ry = py + 0.5 - s.a[1];
        const along = rx * d[0] + ry * d[1];
        const across = -rx * d[1] + ry * d[0];
        if (along >= 0 && along <= L && Math.abs(across) <= half) solid[py * w + px] = 1;
      }
    }
  }
  let outline: [number, number][] = [];
  if (segs.length >= 3) {
    // Window symbols are thin, often faint lines that carry a wall's line across an opening: ink in
    // the strip that continues each wall past its ends counts as solid, so the outside is not let in
    // through a window. Dimensions, text and furniture beside the walls are left alone.
    const faint = options.darkWalls ? Math.max(threshold, 235) : Math.min(threshold, 20);
    const isInk = (i: number) => (options.darkWalls ? gray[i] < faint : gray[i] > faint);
    const reach = Math.max(options.closeGap * 3, options.maxThickness * 4);
    // Only from free ends: an end that meets another wall continues nowhere.
    const meetsWall = (p: [number, number], self: Seg) =>
      segs.some((o) => {
        if (o === self) return false;
        const L = length(o) || 1;
        const t = ((p[0] - o.a[0]) * (o.b[0] - o.a[0]) + (p[1] - o.a[1]) * (o.b[1] - o.a[1])) / (L * L);
        if (t < -0.02 || t > 1.02) return false;
        const dist = Math.abs((p[0] - o.a[0]) * (o.b[1] - o.a[1]) - (p[1] - o.a[1]) * (o.b[0] - o.a[0])) / L;
        return dist <= o.t / 2 + 3;
      });
    for (const seg of segs) {
      const L = length(seg) || 1;
      const d = [(seg.b[0] - seg.a[0]) / L, (seg.b[1] - seg.a[1]) / L];
      const half = seg.t / 2 + 1.5;
      for (const [p, sign] of [
        [seg.b, 1],
        [seg.a, -1],
      ] as const) {
        if (meetsWall(p, seg)) continue;
        for (let along = 0; along <= reach; along += 0.7) {
          const cx = p[0] + d[0] * along * sign,
            cy = p[1] + d[1] * along * sign;
          for (let across = -half; across <= half; across += 0.7) {
            const x = Math.round(cx - d[1] * across),
              y = Math.round(cy + d[0] * across);
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const i = y * w + x;
            if (!solid[i] && isInk(i)) solid[i] = 1;
          }
        }
      }
    }
    let solidCount = 0;
    for (let i = 0; i < solid.length; i++) solidCount += solid[i];
    // The convex hull of the walls: an enclosed footprint fills a good part of it.
    const hullArea = (() => {
      const pts: [number, number][] = [];
      for (let y = 0; y < h; y++) {
        let x0 = -1,
          x1 = -1;
        for (let x = 0; x < w; x++) {
          if (solid[y * w + x]) {
            if (x0 < 0) x0 = x;
            x1 = x;
          }
        }
        if (x0 >= 0) pts.push([x0, y], [x1, y]);
      }
      pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lower: [number, number][] = [];
      for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
      }
      const upper: [number, number][] = [];
      for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
      }
      const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
      let a = 0;
      for (let i = 0; i < hull.length; i++) {
        const p = hull[i],
          q = hull[(i + 1) % hull.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return Math.abs(a) / 2;
    })();
    // Close door-sized gaps, then fill everything the outside cannot reach. If the outside still
    // leaks in (wide openings drawn without a line), close wider gaps and try again.
    let filled: Uint8Array | null = null;
    for (const factor of [1, 2, 3, 5]) {
      const gap = Math.max(2, (options.closeGap * factor) / 2);
      const closed = erode(dilate(solid, w, h, gap), w, h, gap);
      const outside = new Uint8Array(w * h);
      const stack: number[] = [];
      for (let x = 0; x < w; x++) for (const y of [0, h - 1]) if (!closed[y * w + x]) stack.push(y * w + x);
      for (let y = 0; y < h; y++) for (const x of [0, w - 1]) if (!closed[y * w + x]) stack.push(y * w + x);
      for (const i of stack) outside[i] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % w;
        for (const k of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
          if (k >= 0 && k < w * h && !outside[k] && !closed[k]) {
            outside[k] = 1;
            stack.push(k);
          }
        }
      }
      const candidate = new Uint8Array(w * h);
      let inside = 0;
      for (let i = 0; i < candidate.length; i++) {
        candidate[i] = outside[i] ? 0 : 1;
        inside += candidate[i];
      }
      filled = candidate;
      // Rooms enclosed: the filled area covers most of the walls' hull.
      if (inside >= hullArea * 0.5 && inside > solidCount * 1.5) break;
    }
    const boundary = outerBoundary(filled!, w, h);
    outline = simplifyRing(boundary, Math.max(2, options.minThickness / 2));
    if (options.orthogonal && outline.length >= 4) {
      // Square up the outline's edges to the main directions too.
      const snapped = snapOrthogonal(
        outline.map((p, i) => ({ a: p, b: outline[(i + 1) % outline.length], t: 0 })),
        direction,
        6,
      );
      const pts: [number, number][] = [];
      for (let i = 0; i < snapped.length; i++) {
        const prev = snapped[(i - 1 + snapped.length) % snapped.length];
        const cur = snapped[i];
        const d1: [number, number] = [prev.b[0] - prev.a[0], prev.b[1] - prev.a[1]];
        const d2: [number, number] = [cur.b[0] - cur.a[0], cur.b[1] - cur.a[1]];
        const t = intersect(prev.a, d1, cur.a, d2);
        pts.push(t === null || Math.abs(t) > 4 ? [...cur.a] : [prev.a[0] + d1[0] * t, prev.a[1] + d1[1] * t]);
      }
      outline = pts;
    }
  }

  // Drop corners that are no corners (collinear or doubled points).
  for (let changed = true; changed && outline.length > 3; ) {
    changed = false;
    for (let i = 0; i < outline.length && outline.length > 3; i++) {
      const p = outline[(i - 1 + outline.length) % outline.length],
        q = outline[i],
        r = outline[(i + 1) % outline.length];
      const ux = q[0] - p[0],
        uy = q[1] - p[1],
        vx = r[0] - q[0],
        vy = r[1] - q[1];
      const lu = Math.hypot(ux, uy),
        lv = Math.hypot(vx, vy);
      if (lu < 1 || lv < 1 || Math.abs(ux * vy - uy * vx) / (lu * lv) < 0.02) {
        outline.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }

  return {
    walls: segs.map((s) => ({ a: [round1(s.a[0]), round1(s.a[1])], b: [round1(s.b[0]), round1(s.b[1])], thickness: round1(s.t) })),
    outline: outline.map(([x, y]) => [round1(x), round1(y)]),
    threshold,
    direction,
    inkShare: inkCount / (w * h),
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
