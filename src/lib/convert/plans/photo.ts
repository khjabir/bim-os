// Photos of plans: finding the sheet in the picture and straightening it.
//
// The sheet is the largest bright area on a darker ground; its outline's
// convex hull gives four corners, each side then refitted to the outline.
// Straightening maps those corners to a rectangle. Its proportions come from
// the perspective of the corners (the whiteboard method of Zhang and He,
// assuming the camera's centre is the picture's centre), or from the lengths
// of the sides when the photo is taken square on.

type Pt = [number, number];

/** Corners (image pixels) of a sheet that does not fill the picture, in order top-left, top-right, bottom-right, bottom-left; null when there is none. */
export function findSheet(gray: Uint8Array, w: number, h: number): Pt[] | null {
  // Small copy (about 400 pixels across).
  const f = Math.max(1, Math.ceil(Math.max(w, h) / 400));
  const sw = Math.floor(w / f),
    sh = Math.floor(h / f);
  if (sw < 20 || sh < 20) return null;
  const small = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) s += gray[(y * f + yy) * w + x * f + xx];
      small[y * sw + x] = s / (f * f);
    }
  // Paper: brighter than the Otsu split.
  const hist = new Float64Array(256);
  for (const v of small) hist[v]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let wB = 0,
    sB = 0,
    best = -1,
    thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = small.length - wB;
    if (!wF) break;
    sB += t * hist[t];
    const between = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  // The largest bright region (4-connected); lines drawn on the paper are bridged by a small closing of the dark parts.
  const bright = new Uint8Array(sw * sh);
  for (let i = 0; i < bright.length; i++) bright[i] = small[i] > thr ? 1 : 0;
  const lab = new Int32Array(sw * sh).fill(-1);
  let bestId = -1,
    bestSize = 0,
    id = 0;
  const stack: number[] = [];
  for (let i = 0; i < bright.length; i++) {
    if (!bright[i] || lab[i] >= 0) continue;
    let size = 0;
    lab[i] = id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % sw;
      for (const k of [x > 0 ? j - 1 : -1, x < sw - 1 ? j + 1 : -1, j - sw, j + sw])
        if (k >= 0 && k < bright.length && bright[k] && lab[k] < 0) {
          lab[k] = id;
          stack.push(k);
        }
    }
    if (size > bestSize) {
      bestSize = size;
      bestId = id;
    }
    id++;
  }
  if (bestId < 0) return null;
  const share = bestSize / (sw * sh);
  if (share < 0.2 || share > 0.93) return null;
  // The ground around it is darker, and the sheet does not run along most of the border.
  let border = 0,
    onSheet = 0;
  for (let x = 0; x < sw; x++)
    for (const y of [0, sh - 1]) {
      border++;
      if (lab[y * sw + x] === bestId) onSheet++;
    }
  for (let y = 0; y < sh; y++)
    for (const x of [0, sw - 1]) {
      border++;
      if (lab[y * sw + x] === bestId) onSheet++;
    }
  if (onSheet > 0.5 * border) return null;
  // Its outline (pixels of the region with a neighbour outside it), then the convex hull.
  const edge: Pt[] = [];
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      if (lab[i] !== bestId) continue;
      if (x === 0 || y === 0 || x === sw - 1 || y === sh - 1 || lab[i - 1] !== bestId || lab[i + 1] !== bestId || lab[i - sw] !== bestId || lab[i + sw] !== bestId) edge.push([x + 0.5, y + 0.5]);
    }
  const hull = convexHull(edge);
  if (hull.length < 4) return null;
  // Four corners: extremes along the diagonals, then improved one at a time for the largest area.
  const pick = (score: (p: Pt) => number) => hull.reduce((a, b) => (score(b) > score(a) ? b : a));
  let quad: Pt[] = [pick((p) => -p[0] - p[1]), pick((p) => p[0] - p[1]), pick((p) => p[0] + p[1]), pick((p) => -p[0] + p[1])];
  for (let it = 0; it < 4; it++) {
    for (let c = 0; c < 4; c++) {
      let bestP = quad[c],
        bestA = polyArea(quad);
      for (const p of hull) {
        const q = quad.slice();
        q[c] = p;
        const a = polyArea(q);
        if (a > bestA) {
          bestA = a;
          bestP = p;
        }
      }
      quad[c] = bestP;
    }
  }
  if (polyArea(quad) < 0.85 * bestSize) return null;
  // Each side refitted to the outline points near it; corners where the sides meet.
  const sides = quad.map((a, k) => {
    const b = quad[(k + 1) % 4];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d: Pt = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const near = edge.filter((p) => {
      const t = (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1];
      const o = Math.abs(-(p[0] - a[0]) * d[1] + (p[1] - a[1]) * d[0]);
      return t > 0.1 * L && t < 0.9 * L && o < Math.max(2, 0.02 * L);
    });
    return near.length >= 5 ? fitLine(near) : { p: a, d };
  });
  quad = sides.map((s, k) => {
    const prev = sides[(k + 3) % 4];
    return intersect(prev, s) ?? quad[k];
  });
  return quad.map(([x, y]) => [x * f, y * f] as Pt);
}

function convexHull(points: Pt[]): Pt[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function polyArea(q: Pt[]) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i],
      r = q[(i + 1) % q.length];
    a += p[0] * r[1] - r[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function fitLine(pts: Pt[]): { p: Pt; d: Pt } {
  let mx = 0,
    my = 0;
  for (const p of pts) {
    mx += p[0];
    my += p[1];
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0,
    syy = 0,
    sxy = 0;
  for (const p of pts) {
    sxx += (p[0] - mx) ** 2;
    syy += (p[1] - my) ** 2;
    sxy += (p[0] - mx) * (p[1] - my);
  }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(a), Math.sin(a)] };
}

function intersect(l1: { p: Pt; d: Pt }, l2: { p: Pt; d: Pt }): Pt | null {
  const den = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
  if (Math.abs(den) < 1e-6) return null;
  const t = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / den;
  return [l1.p[0] + l1.d[0] * t, l1.p[1] + l1.d[1] * t];
}

/** Width / height of the sheet seen with corners `q` (TL, TR, BR, BL) in a picture of size w × h. */
export function sheetAspect(q: Pt[], w: number, h: number): number {
  const sideW = (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1])) / 2;
  const sideH = (Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2;
  const plain = sideW / Math.max(1e-9, sideH);
  // Zhang & He: m1 TL, m2 TR, m3 BL, m4 BR, relative to the centre of the picture.
  const u0 = w / 2,
    v0 = h / 2;
  const m = (p: Pt) => [p[0], p[1], 1];
  const m1 = m(q[0]),
    m2 = m(q[1]),
    m3 = m(q[3]),
    m4 = m(q[2]);
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  if (Math.abs(n2[2]) < 1e-9 || Math.abs(n3[2]) < 1e-9) return plain;
  const f2 =
    -(1 / (n2[2] * n3[2])) *
    (n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0 + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0));
  if (!(f2 > 0) || !Number.isFinite(f2)) return plain;
  const f = Math.sqrt(f2);
  // nᵀ A⁻ᵀ A⁻¹ n with A = [[f,0,u0],[0,f,v0],[0,0,1]].
  const norm = (n: number[]) => {
    const x = (n[0] - u0 * n[2]) / f,
      y = (n[1] - v0 * n[2]) / f;
    return x * x + y * y + n[2] * n[2];
  };
  const aspect = Math.sqrt(norm(n2) / norm(n3));
  // Trust it when the camera's focal length is plausible for a phone (0.5 to 3 picture widths) and it stays near the plain ratio.
  if (!Number.isFinite(aspect) || f < 0.4 * Math.max(w, h) || f > 4 * Math.max(w, h) || Math.abs(Math.log(aspect / plain)) > 0.35) return plain;
  return aspect;
}

/** 3×3 matrix taking (u, v) in the unit square to the quad (TL, TR, BR, BL). */
function squareToQuad(q: Pt[]): number[] {
  const [x0, y0] = q[0],
    [x1, y1] = q[1],
    [x2, y2] = q[2],
    [x3, y3] = q[3];
  const dx1 = x1 - x2,
    dx2 = x3 - x2,
    sx = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2,
    dy2 = y3 - y2,
    sy = y0 - y1 + y2 - y3;
  let g = 0,
    hh = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh, 1];
}

/** The quad `corners` of an RGBA picture warped to a w × h rectangle (bilinear). */
export function warpQuad(src: Uint8ClampedArray, sw: number, sh: number, corners: Pt[], w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const M = squareToQuad(corners);
  const out = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const den = M[6] * u + M[7] * v + M[8];
      const fx = (M[0] * u + M[1] * v + M[2]) / den - 0.5,
        fy = (M[3] * u + M[4] * v + M[5]) / den - 0.5;
      const o = (y * w + x) * 4;
      if (fx < 0 || fy < 0 || fx > sw - 1 || fy > sh - 1) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255;
        continue;
      }
      const ix = Math.floor(fx),
        iy = Math.floor(fy);
      const jx = Math.min(sw - 1, ix + 1),
        jy = Math.min(sh - 1, iy + 1);
      const tx = fx - ix,
        ty = fy - iy;
      for (let c = 0; c < 4; c++) {
        const a = src[(iy * sw + ix) * 4 + c],
          b = src[(iy * sw + jx) * 4 + c],
          d = src[(jy * sw + ix) * 4 + c],
          e = src[(jy * sw + jx) * 4 + c];
        out[o + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
      }
    }
  }
  return out;
}

/** Size of the straightened picture: about as many pixels across the sheet as the photo has, in the sheet's proportions. */
export function straightenedSize(corners: Pt[], w: number, h: number, maxSide = 5000): { width: number; height: number } {
  const aspect = sheetAspect(corners, w, h);
  const across = Math.max(Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]), Math.hypot(corners[2][0] - corners[3][0], corners[2][1] - corners[3][1]));
  let width = across,
    height = across / aspect;
  const k = Math.min(1, maxSide / Math.max(width, height));
  width *= k;
  height *= k;
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}
