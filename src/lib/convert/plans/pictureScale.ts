// The scale of a picture of a plan (metres per pixel), from what is drawn on
// it: dimension strings measured against their dimension lines, the scale
// written on the sheet with the picture's resolution (or the PDF page size),
// door swings, and room areas written in the rooms.

import { DRAWING_SCALES } from "./recognize";
import { F_CURVE, F_DIM, type Pt, type VectorDrawing } from "./vector";

export type ScaleBasis = "dims" | "sheet" | "areas" | "doors";

export interface ScaleGuess {
  /** Metres per drawing unit (per pixel for pictures). */
  scale: number;
  basis: ScaleBasis;
  /** For the editor: "7 dimensions in millimetres", "1:100 at 300 dpi", … */
  detail: string;
  /** How many independent measurements agree. */
  support: number;
}

// ---------------------------------------------------------------------------
// Reading numbers

/** A dimension value in metres for each unit it could be in ("4615" → 4.615 m in mm, 46.15 in cm). */
export function dimensionValues(text: string): { unit: string; metres: number }[] {
  const t = text.trim().replace(/\s+/g, " ");
  // Feet and inches: 12'-6", 12' 6", 12'6", 12'
  const ft = /^(\d{1,3})\s*['’′]\s*-?\s*(\d{1,2}(?:\s*\d\/\d+)?)?\s*(?:["”″])?$/.exec(t);
  if (ft) {
    let inches = 0;
    if (ft[2]) {
      const [whole, frac] = ft[2].split(/\s+/);
      inches = Number(whole);
      if (frac) {
        const [a, b] = frac.split("/").map(Number);
        if (b) inches += a / b;
      }
    }
    return [{ unit: "ft-in", metres: Number(ft[1]) * 0.3048 + inches * 0.0254 }];
  }
  const inch = /^(\d{1,3}(?:\.\d+)?)\s*["”″]$/.exec(t);
  if (inch) return [{ unit: "in", metres: Number(inch[1]) * 0.0254 }];
  // Plain numbers, with an optional unit; thousands separators in long integers.
  const m = /^(\d{1,3}(?:[ ,.]\d{3})+|\d+(?:[.,]\d+)?)\s*(mm|cm|m)?$/i.exec(t);
  if (!m) return [];
  let raw = m[1];
  const unit = m[2]?.toLowerCase();
  const grouped = /^\d{1,3}([ ,.])\d{3}(\1\d{3})*$/.exec(raw);
  if (grouped && !unit) raw = raw.replace(/[ ,.]/g, "");
  else raw = raw.replace(",", ".");
  const v = Number(raw);
  if (!(v > 0)) return [];
  if (unit === "mm") return [{ unit: "mm", metres: v / 1000 }];
  if (unit === "cm") return [{ unit: "cm", metres: v / 100 }];
  if (unit === "m") return [{ unit: "m", metres: v }];
  if (raw.includes(".")) {
    // 3.60 (metres), or 360.5 (centimetres) now and then.
    return v < 100 ? [{ unit: "m", metres: v }] : [{ unit: "cm", metres: v / 100 }];
  }
  // Integers: millimetres or centimetres.
  return [
    { unit: "mm", metres: v / 1000 },
    { unit: "cm", metres: v / 100 },
  ].filter((c) => c.metres >= 0.05 && c.metres <= 300);
}

/** The drawing scale written on a sheet: "SCALE 1:100", "1 : 50", "1/8" = 1'-0"" → N (1:N). */
export function scaleNote(text: string): number | null {
  const t = text.toUpperCase();
  const ratio = /(?:^|[^\d])1\s*[:;]\s*(\d{1,4})(?!\d)/.exec(t);
  if (ratio) return Number(ratio[1]) || null;
  // OCR often loses the colon after "SCALE": "SCALE 1100" -> 1:100 when that is a common scale.
  const lost = /SCALE\s*[:.]?\s*1\s*[.,]?\s*(\d{2,4})\b/.exec(t);
  if (lost) {
    const n = Number(lost[1]);
    if (DRAWING_SCALES.includes(n)) return n;
  }
  const imp = /(\d+)\s*\/\s*(\d+)\s*["”″]?\s*=\s*1\s*['’′]\s*-?\s*0?\s*["”″]?/.exec(t);
  if (imp) {
    const inches = Number(imp[1]) / Number(imp[2]);
    if (inches > 0) return Math.round(12 / inches);
  }
  return null;
}

/** Area written in a room: "24.5 m²", "24,5m2", "263 SF" → square metres. */
export function areaValue(text: string): number | null {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /(\d+(?:[.,]\d+)?)\s*(m2|m²|m\^2|sqm|sq\.?\s?m|m)(?![a-z])/i.exec(t);
  if (m) {
    const v = Number(m[1].replace(",", "."));
    return v > 0.5 && v < 20000 ? v : null;
  }
  const f = /(\d+(?:[.,]\d+)?)\s*(sf|sq\.?\s?ft|ft2|ft²)(?![a-z])/i.exec(t);
  if (f) {
    const v = Number(f[1].replace(",", ".")) * 0.09290304;
    return v > 0.5 && v < 20000 ? v : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// From dimensions

/**
 * Each dimension text against the dimension line beside it: the nearest
 * parallel line within a few text heights whose extent covers the text, and
 * along it the nearest marks on either side of the text (extension lines,
 * ticks, arrow ends, the line's own ends). The units that make most of them
 * agree win.
 */
export function scaleFromDimensions(d: VectorDrawing, used?: { segs: Set<number>; texts: Set<number> }): ScaleGuess | null {
  const n = d.segLayer.length;
  const segs: { a: Pt; b: Pt; len: number; i: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (d.segFlags[i] & F_CURVE) continue;
    const a: Pt = [d.segs[i * 4], d.segs[i * 4 + 1]],
      b: Pt = [d.segs[i * 4 + 2], d.segs[i * 4 + 3]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > 0) segs.push({ a, b, len, i });
  }
  const samples: { values: { unit: string; metres: number }[]; px: number; text: number; segs: number[] }[] = [];
  let textIndex = -1;
  for (const t of d.texts) {
    textIndex++;
    if (t.flags & F_DIM) continue;
    const values = dimensionValues(t.text);
    if (!values.length) continue;
    const u: Pt = [Math.cos(t.rotation), Math.sin(t.rotation)];
    const nrm: Pt = [-u[1], u[0]];
    const tc = t.c;
    const ts = tc[0] * u[0] + tc[1] * u[1];
    // The dimension line.
    let line: { a: Pt; b: Pt; off: number; s0: number; s1: number } | null = null;
    for (const s of segs) {
      const dir: Pt = [(s.b[0] - s.a[0]) / s.len, (s.b[1] - s.a[1]) / s.len];
      if (Math.abs(dir[0] * u[0] + dir[1] * u[1]) < 0.996) continue;
      const off = (s.a[0] - tc[0]) * nrm[0] + (s.a[1] - tc[1]) * nrm[1];
      if (Math.abs(off) < 0.25 * t.h || Math.abs(off) > 2.6 * t.h) continue;
      const sa = s.a[0] * u[0] + s.a[1] * u[1],
        sb = s.b[0] * u[0] + s.b[1] * u[1];
      const s0 = Math.min(sa, sb),
        s1 = Math.max(sa, sb);
      if (ts < s0 - 0.5 * t.h || ts > s1 + 0.5 * t.h) continue;
      if (!line || Math.abs(off) < Math.abs(line.off)) line = { a: s.a, b: s.b, off, s0, s1 };
    }
    if (!line) continue;
    // Marks crossing (or touching) the dimension line; collinear pieces of the line extend it.
    const lineOff = tc[0] * nrm[0] + tc[1] * nrm[1] + line.off;
    const marks: number[] = [];
    const pieces: number[] = [];
    const ticks: number[] = [];
    let lo = line.s0,
      hi = line.s1;
    for (const s of segs) {
      const dir: Pt = [(s.b[0] - s.a[0]) / s.len, (s.b[1] - s.a[1]) / s.len];
      const oa = s.a[0] * nrm[0] + s.a[1] * nrm[1] - lineOff,
        ob = s.b[0] * nrm[0] + s.b[1] * nrm[1] - lineOff;
      const sa = s.a[0] * u[0] + s.a[1] * u[1],
        sb = s.b[0] * u[0] + s.b[1] * u[1];
      if (Math.abs(dir[0] * u[0] + dir[1] * u[1]) >= 0.996) {
        // Collinear piece of the same dimension line (broken at the marks): it only extends the line.
        if (Math.abs(oa) <= 1.5 && Math.abs(ob) <= 1.5) {
          lo = Math.min(lo, sa, sb);
          hi = Math.max(hi, sa, sb);
          pieces.push(s.i);
        }
        continue;
      }
      const tol = 1.5;
      if ((oa > tol && ob > tol) || (oa < -tol && ob < -tol)) continue;
      // Where it meets the line.
      const k = Math.abs(ob - oa) > 1e-9 ? -oa / (ob - oa) : 0;
      marks.push(sa + (sb - sa) * Math.max(0, Math.min(1, k)));
      if (s.len <= 2.5 * t.h) ticks.push(s.i);
    }
    // One mark per place: a tick, its extension line and the pieces they leave meet within a pixel or two.
    marks.sort((p, q) => p - q);
    const places: number[] = [];
    for (let i = 0; i < marks.length; ) {
      let j = i + 1;
      while (j < marks.length && marks[j] - marks[j - 1] <= Math.max(2.5, 0.25 * t.h)) j++;
      places.push(marks.slice(i, j).reduce((a, b) => a + b, 0) / (j - i));
      i = j;
    }
    let left = -Infinity,
      right = Infinity;
    for (const m of places) {
      if (m < ts - 0.3 * t.h && m > left) left = m;
      if (m > ts + 0.3 * t.h && m < right) right = m;
    }
    // No mark on a side: the end of the dimension line (arrowheads drawn solid).
    if (!Number.isFinite(left) && lo < ts - 0.3 * t.h) left = lo;
    if (!Number.isFinite(right) && hi > ts + 0.3 * t.h) right = hi;
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
    const px = right - left;
    // The text has to fit between its marks.
    if (px < 0.6 * t.h * Math.max(1, t.text.length * 0.55)) continue;
    // The dimension line where it runs between the text's marks (other dimension texts on it take the rest), and short ticks.
    const mine: number[] = [...ticks];
    for (const i of pieces) {
      const sa = d.segs[i * 4] * u[0] + d.segs[i * 4 + 1] * u[1],
        sb = d.segs[i * 4 + 2] * u[0] + d.segs[i * 4 + 3] * u[1];
      if (Math.max(sa, sb) >= left - 2 && Math.min(sa, sb) <= right + 2) mine.push(i);
    }
    samples.push({ values, px, text: textIndex, segs: mine });
  }
  if (samples.length < 2) return null;
  // Units: the one most measurements agree on (within 3%).
  const units = new Set<string>();
  for (const s of samples) for (const v of s.values) units.add(v.unit);
  let best: ScaleGuess | null = null;
  let bestMembers: typeof samples = [];
  for (const unit of units) {
    const rated = samples.map((s) => ({ s, r: (s.values.find((v) => v.unit === unit)?.metres ?? NaN) / s.px })).filter((x) => Number.isFinite(x.r));
    if (rated.length < 2) continue;
    // Largest group within 3% of each other.
    rated.sort((a, b) => a.r - b.r);
    let members: typeof rated = [];
    for (let i = 0; i < rated.length; i++) {
      const group = rated.filter((x) => Math.abs(x.r / rated[i].r - 1) <= 0.03);
      if (group.length > members.length) members = group;
    }
    const bestGroup = members.map((x) => x.r);
    if (bestGroup.length < 2) continue;
    const scale = bestGroup[Math.floor(bestGroup.length / 2)];
    const label = unit === "mm" ? "millimetres" : unit === "cm" ? "centimetres" : unit === "m" ? "metres" : unit === "ft-in" ? "feet and inches" : "inches";
    const guess: ScaleGuess = { scale, basis: "dims", detail: `${bestGroup.length} dimensions in ${label}`, support: bestGroup.length };
    // Ties: the plan that comes out a building's size.
    const [x0, y0, x1, y1] = d.bbox;
    const span = Math.max(x1 - x0, y1 - y0) * scale;
    const plausible = span >= 3 && span <= 800;
    if (!plausible) continue;
    if (!best || guess.support > best.support) {
      best = guess;
      bestMembers = members.map((x) => x.s);
    }
  }
  // Only the dimensions that agree are marked as such.
  if (used)
    for (const m of bestMembers) {
      used.texts.add(m.text);
      for (const i of m.segs) used.segs.add(i);
    }
  return best;
}

/** Dimension lines, their ticks and their texts (the ones the scale was read from) marked as dimensions: never walls, windows or room names. */
export function markDimensions(d: VectorDrawing): number {
  const used = { segs: new Set<number>(), texts: new Set<number>() };
  scaleFromDimensions(d, used);
  for (const i of used.segs) d.segFlags[i] |= F_DIM;
  for (const k of used.texts) d.texts[k].flags |= F_DIM;
  return used.segs.size;
}

// ---------------------------------------------------------------------------
// From the sheet, doors and rooms

/** "SCALE 1:100" on the sheet with the picture's size on paper (metres per pixel at 1:1). */
export function scaleFromSheet(d: VectorDrawing, metresPerPixelAtFullSize: number | null, dpiLabel: string | null): ScaleGuess | null {
  if (!metresPerPixelAtFullSize) return null;
  for (const t of d.texts) {
    const n = scaleNote(t.text);
    if (n && n >= 1 && n <= 5000) return { scale: metresPerPixelAtFullSize * n, basis: "sheet", detail: `1:${n}${dpiLabel ? ` at ${dpiLabel}` : ""}`, support: 1 };
  }
  return null;
}

/** Door swings: quarter arcs of about 0.85 m. */
export function scaleFromDoors(d: VectorDrawing, roles: string[] | null = null): ScaleGuess | null {
  const radii: number[] = [];
  for (const a of d.arcs) {
    if (a.flags & F_DIM) continue;
    const sweep = a.a1 - a.a0;
    if (sweep < (70 * Math.PI) / 180 || sweep > (110 * Math.PI) / 180) continue;
    if (roles && roles[a.layer] !== "door") continue;
    radii.push(a.r);
  }
  if (radii.length < 2) return null;
  radii.sort((p, q) => p - q);
  // The common door: the median of the larger half (double-leaf and narrow doors pull both ways).
  const r = radii[Math.floor(radii.length * 0.6)];
  return { scale: 0.85 / r, basis: "doors", detail: `${radii.length} door swings`, support: radii.length };
}

/** Room areas written in the rooms against the rooms' areas (drawing units²): the factor to apply to the current scale, when they agree. */
export function areaCheck(rooms: { ring: Pt[]; texts: string[] }[], scale: number): { factor: number; support: number } | null {
  const factors: number[] = [];
  for (const room of rooms) {
    let a = 0;
    for (let i = 0; i < room.ring.length; i++) {
      const p = room.ring[i],
        q = room.ring[(i + 1) % room.ring.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    const units2 = Math.abs(a) / 2;
    if (!(units2 > 0)) continue;
    for (const t of room.texts) {
      const v = areaValue(t);
      if (!v) continue;
      factors.push(Math.sqrt(v / (units2 * scale * scale)));
      break;
    }
  }
  if (factors.length < 2) return null;
  factors.sort((p, q) => p - q);
  let group: number[] = [];
  for (let i = 0; i < factors.length; i++) {
    const g = factors.filter((f) => Math.abs(f / factors[i] - 1) <= 0.04);
    if (g.length > group.length) group = g;
  }
  if (group.length < 2 || group.length < 0.5 * factors.length) return null;
  return { factor: group[Math.floor(group.length / 2)], support: group.length };
}
