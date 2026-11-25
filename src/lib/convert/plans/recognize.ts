// Building elements from vector line work (vector.ts): walls, doors, windows,
// columns, rooms and the floor outline, in drawing units.
//
// Walls are found the way a person reads a CAD plan: two parallel lines a
// wall's thickness apart, on wall layers, facing each other (each line pairs
// with its nearest partner, and the partner must pair back), confirmed by the
// wall fill when the drawing has one. Collinear pieces join into runs; a gap
// in a run becomes a door (a swing arc hinged at its jamb), a window (glazing
// lines across it) or a plain opening, and the run continues through it.
// Wall ends meet at corners and T-junctions. Rooms are the closed areas the
// walls leave (or the room outlines the drawing has), named by the texts in
// them.

import { simplifyRing } from "./trace";
import { F_CURVE, F_DIM, F_WIDE, type Pt, type VArc, type VectorDrawing } from "./vector";

export type LayerRole = "wall" | "door" | "window" | "room" | "column" | "text" | "other" | "ignore";

export const ROLE_LABELS: Record<LayerRole, string> = {
  wall: "Walls",
  door: "Doors",
  window: "Windows",
  room: "Rooms",
  column: "Columns",
  text: "Room names",
  other: "Shown only",
  ignore: "Hidden",
};

// ---------------------------------------------------------------------------
// Layer roles

const RULES: [LayerRole, RegExp][] = [
  ["ignore", /\b(dim|dims|dimension|dimensions|dimensioning|cota|cotas|cotation|cotations|bemassung|bemasung|bemass|quote|quota|maat|maten|wymiary|defpoints|vport|viewport|viewports)\b/],
  ["ignore", /\b(title|titleblock|tblk|border|frame|sheet|plankopf|rahmen|cartouche|cajetin|marco|legend|legende|keyplan|logo|xref)\b/],
  ["wall", /\b(wall|walls|wand|wande|waende|mur|murs|muro|muros|muri|pared|paredes|parede|parete|pareti|muur|muren|sciana|partition|partitions|cloison|cloisons|trennwand|tabique|tabiques)\b/],
  ["window", /\b(window|windows|wind|win|wndw|glaz|glazing|glass|fenster|fenetre|fenetres|ventana|ventanas|finestra|finestre|janela|janelas|raam|ramen|okno|okna|vitrage|vitrages)\b/],
  ["door", /\b(door|doors|dr|tur|turen|tuer|tueren|porte|portes|puerta|puertas|porta|portas|deur|deuren|drzwi)\b/],
  ["column", /\b(column|columns|col|cols|colm|colmn|stutze|stutzen|stuetze|stuetzen|poteau|poteaux|columna|columnas|pilar|pilares|pillar|pillars|pilier|piliers|kolom|kolommen|pilastro|pilastri)\b/],
  ["room", /\b(room|rooms|space|spaces|area|areas|zone|zones|raum|raume|raeume|piece|pieces|local|locaux|locales|habitacion|habitaciones|ambiente|ambientes|ruimte|ruimtes|vano|vani|iden)\b/],
  ["text", /\b(text|texts|txt|anno|annotation|annotations|note|notes|tag|tags|label|labels|beschriftung|texte|testo|tekst)\b/],
  ["ignore", /\b(furn|furniture|mobel|moebel|mobilier|mobiliario|arredo|arredi|meubel|meubilair|eqpm|equip|equipment|fixt|fixture|fixtures|casework|appl|appliance|appliances)\b/],
  ["ignore", /\b(hvac|duct|ducts|pipe|pipes|piping|plumb|plumbing|sanit|sanitary|elec|electrical|lite|light|lighting|power|sprink|sprinkler|sprinklers|mech|mechanical)\b/],
  ["other", /\b(stair|stairs|strs|treppe|treppen|escalier|escaliers|escalera|escaleras|scala|trap|ramp|ramps)\b/],
  ["other", /\b(patt|pattern|hatch|hatching|schraffur|hachure|hachures|flor|floor|clng|ceiling|decke|grid|grids|axis|axes|achse|achsen|eje|ejes|beam|beams)\b/],
];

/** A layer's role from its name (AIA / ISO 13567 / Revit export names and plain words in several languages); null when the name says nothing. */
export function roleFromName(name: string): LayerRole | null {
  const lower = name.toLowerCase();
  if (lower === "defpoints") return "ignore";
  // Discipline prefixes other than architecture and structure (AIA): MEP, civil, landscape, telecom, fire.
  if (/^(e|m|p|fp|c|l|t|q|g)[-_]/.test(lower)) return "ignore";
  const n = ` ${lower.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, " ")} `;
  for (const [role, re] of RULES) if (re.test(n)) return role;
  return null;
}

// ---------------------------------------------------------------------------
// Small geometry

const TAU = Math.PI * 2;

function pointInRing(x: number, y: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function ringArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i],
      q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function ringBox(ring: Pt[]): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of ring) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

function centroid(ring: Pt[]): Pt {
  let a = 0,
    cx = 0,
    cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i],
      q = ring[(i + 1) % ring.length];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f;
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const b = ringBox(ring);
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Infinite lines in normal form: direction angle th in [-0.5°, 179.5°), d = (cos, sin), n = (-sin, cos), offset o = n·p, extent s0..s1 along d. */
interface Line {
  th: number;
  dx: number;
  dy: number;
  o: number;
  s0: number;
  s1: number;
  /** From a fill's outline rather than a drawn line. */
  fill: boolean;
}

const TH_MIN = (-0.5 * Math.PI) / 180;

function lineOf(ax: number, ay: number, bx: number, by: number, fill = false): Line | null {
  const L = Math.hypot(bx - ax, by - ay);
  if (!(L > 0)) return null;
  let th = Math.atan2(by - ay, bx - ax);
  while (th < TH_MIN) th += Math.PI;
  while (th >= Math.PI + TH_MIN) th -= Math.PI;
  const dx = Math.cos(th),
    dy = Math.sin(th);
  const o = -dy * ax + dx * ay;
  const sa = dx * ax + dy * ay,
    sb = dx * bx + dy * by;
  return { th, dx, dy, o, s0: Math.min(sa, sb), s1: Math.max(sa, sb), fill };
}

/** A line's frame: direction and offset. */
interface Frame {
  dx: number;
  dy: number;
  o: number;
}

const at = (l: Frame, s: number, off = 0): Pt => [l.dx * s - l.dy * (l.o + off), l.dy * s + l.dx * (l.o + off)];

/** Merges collinear overlapping or touching lines. */
function mergeLines(lines: Line[], angTol: number, offTol: number, gapTol: number): Line[] {
  const sorted = lines.slice().sort((a, b) => a.th - b.th);
  const out: Line[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].th - sorted[j - 1].th <= angTol) j++;
    const group = sorted.slice(i, j);
    i = j;
    // Group frame: length-weighted mean angle.
    let sw = 0,
      st = 0;
    for (const l of group) {
      const w = l.s1 - l.s0;
      sw += w;
      st += l.th * w;
    }
    const th = sw > 0 ? st / sw : group[0].th;
    const dx = Math.cos(th),
      dy = Math.sin(th);
    const items = group.map((l) => {
      const a = at(l, l.s0),
        b = at(l, l.s1);
      const oa = -dy * a[0] + dx * a[1],
        ob = -dy * b[0] + dx * b[1];
      const sa = dx * a[0] + dy * a[1],
        sb = dx * b[0] + dy * b[1];
      return { o: (oa + ob) / 2, s0: Math.min(sa, sb), s1: Math.max(sa, sb), fill: l.fill };
    });
    items.sort((a, b) => a.o - b.o);
    let k = 0;
    while (k < items.length) {
      let m = k + 1;
      while (m < items.length && items[m].o - items[m - 1].o <= offTol) m++;
      const cluster = items.slice(k, m).sort((a, b) => a.s0 - b.s0);
      k = m;
      let o = 0,
        w = 0;
      for (const c of cluster) {
        const len = c.s1 - c.s0;
        o += c.o * len;
        w += len;
      }
      o = w > 0 ? o / w : cluster[0].o;
      let cur = { s0: cluster[0].s0, s1: cluster[0].s1, fill: cluster[0].fill };
      for (let q = 1; q < cluster.length; q++) {
        const c = cluster[q];
        if (c.s0 <= cur.s1 + gapTol) {
          cur.s1 = Math.max(cur.s1, c.s1);
          cur.fill = cur.fill && c.fill;
        } else {
          out.push({ th, dx, dy, o, s0: cur.s0, s1: cur.s1, fill: cur.fill });
          cur = { s0: c.s0, s1: c.s1, fill: c.fill };
        }
      }
      out.push({ th, dx, dy, o, s0: cur.s0, s1: cur.s1, fill: cur.fill });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spatial grid for fills (point-in-fill tests)

class RingIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly size: number;
  readonly rings: Pt[][];
  private readonly boxes: [number, number, number, number][];
  constructor(rings: Pt[][], size: number) {
    this.rings = rings;
    this.size = size;
    this.boxes = rings.map(ringBox);
    this.boxes.forEach((b, i) => {
      for (let gx = Math.floor(b[0] / size); gx <= Math.floor(b[2] / size); gx++)
        for (let gy = Math.floor(b[1] / size); gy <= Math.floor(b[3] / size); gy++) {
          const key = gx * 73856093 + gy * 19349663;
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(i);
        }
    });
  }
  /** Even-odd test over all rings (holes in hatches count as outside). */
  contains(x: number, y: number): boolean {
    const key = Math.floor(x / this.size) * 73856093 + Math.floor(y / this.size) * 19349663;
    const list = this.cells.get(key);
    if (!list) return false;
    let inside = false;
    for (const i of list) {
      const b = this.boxes[i];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pointInRing(x, y, this.rings[i])) inside = !inside;
    }
    return inside;
  }
}

// ---------------------------------------------------------------------------
// Output

export interface RecWall {
  a: Pt;
  b: Pt;
  /** Thickness in drawing units. */
  t: number;
  source: "lines" | "fill" | "wide" | "single" | "arc";
}

export type OpeningKind = "door" | "window" | "opening";

export interface RecOpening {
  kind: OpeningKind;
  /** Ends of the opening on its wall's centre line. */
  a: Pt;
  b: Pt;
  /** Index of the host wall in `walls`. */
  wall: number;
  /** Doors: which way the leaf opens, as a unit vector (null when unknown), and where it is hinged. */
  swing: Pt | null;
  hinge: "a" | "b" | "both" | null;
  /** IFC operation type (SINGLE_SWING_LEFT, DOUBLE_DOOR_SINGLE_SWING, …) when known. */
  operation: string | null;
  /** Block name, when it came from one. */
  name: string | null;
}

export interface RecColumn {
  ring: Pt[] | null;
  circle: { c: Pt; r: number } | null;
}

export interface RecRoom {
  ring: Pt[];
  name: string | null;
  number: string | null;
  /** Square metres. */
  area: number;
  source: "outline" | "walls";
}

export interface Recognized {
  walls: RecWall[];
  openings: RecOpening[];
  columns: RecColumn[];
  rooms: RecRoom[];
  /** Outer boundary of the floor (for the slab), drawing units. */
  outline: Pt[];
  warnings: string[];
  stats: { wallLines: number; pairedShare: number; fillChecked: boolean; singleLines: boolean; seconds: number };
}

export interface RecognizeOptions {
  /** Metres per drawing unit. */
  unitScale: number;
  roles: LayerRole[];
  region: [number, number, number, number] | null;
  /** Metres. */
  minThickness: number;
  maxThickness: number;
  /** Lines on wall layers without a partner become walls of `defaultThickness`: "auto" when most of them have none. */
  singleLines: "auto" | "on" | "off";
  defaultThickness: number;
  /** Find rooms from the walls when the drawing has no room outlines. */
  rooms: boolean;
}

export const DEFAULT_RECOGNIZE: Omit<RecognizeOptions, "unitScale" | "roles" | "region"> = {
  minThickness: 0.06,
  maxThickness: 0.6,
  singleLines: "auto",
  defaultThickness: 0.15,
  rooms: true,
};

// ---------------------------------------------------------------------------
// Units

const UNIT_CANDIDATES: [number, string][] = [
  [0.001, "millimetres"],
  [1, "metres"],
  [0.01, "centimetres"],
  [0.0254, "inches"],
  [0.3048, "feet"],
];

function quarterArcs(d: VectorDrawing, roles: LayerRole[] | null): VArc[] {
  return d.arcs.filter((a) => {
    if (a.flags & F_DIM) return false;
    const sweep = a.a1 - a.a0;
    if (sweep < (70 * Math.PI) / 180 || sweep > (110 * Math.PI) / 180) return false;
    if (roles) {
      const role = roles[a.layer];
      if (role === "ignore" || role === "wall" || role === "column" || role === "room") return false;
    }
    return true;
  });
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

/** Metres per unit for a unitless drawing: from door swings (≈ 0.9 m), else from the plan's size. */
export function guessUnitScale(d: VectorDrawing, roles: LayerRole[] | null = null): { scale: number; label: string; basis: "doors" | "size" } | null {
  const doors = quarterArcs(d, roles);
  const doorLayerArcs = roles ? doors.filter((a) => roles[a.layer] === "door") : [];
  const radii = (doorLayerArcs.length >= 2 ? doorLayerArcs : doors).map((a) => a.r);
  if (radii.length >= 2) {
    const r = median(radii);
    let best: [number, string] | null = null;
    let bestErr = Infinity;
    for (const c of UNIT_CANDIDATES) {
      const m = r * c[0];
      if (m < 0.5 || m > 1.4) continue;
      const err = Math.abs(Math.log(m / 0.85));
      if (err < bestErr) {
        bestErr = err;
        best = c;
      }
    }
    if (best) return { scale: best[0], label: best[1], basis: "doors" };
  }
  const [x0, y0, x1, y1] = d.bbox;
  const span = Math.max(x1 - x0, y1 - y0);
  for (const c of UNIT_CANDIDATES) {
    const m = span * c[0];
    if (m >= 4 && m <= 600) return { scale: c[0], label: c[1], basis: "size" };
  }
  return null;
}

/** Common drawing scales (1:N). */
export const DRAWING_SCALES = [10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 1000, 12, 16, 24, 32, 48, 64, 96, 128, 192];

/** Drawing scale of a PDF plan from its door swings: N with 1 PDF unit = 0.0254 / 72 · N metres (metric scales unless `imperial`). */
export function guessPdfScale(d: VectorDrawing, roles: LayerRole[] | null = null, imperial = false): number | null {
  const doors = quarterArcs(d, roles);
  if (doors.length < 2) return null;
  const r = median(doors.map((a) => a.r)) * (0.0254 / 72);
  const n = 0.9 / r;
  let best: number | null = null;
  let bestErr = Infinity;
  for (const s of imperial ? DRAWING_SCALES : DRAWING_SCALES.filter((x) => x % 12 !== 0 && x !== 16 && x !== 32 && x !== 64 && x !== 128)) {
    const err = Math.abs(Math.log(s / n));
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  return best !== null && bestErr < Math.log(1.45) ? best : null;
}

// ---------------------------------------------------------------------------
// Roles

/** Roles for every layer: from the names, then from the line work where names say nothing. */
export function suggestRoles(d: VectorDrawing, unitScale: number | null): LayerRole[] {
  const roles: (LayerRole | null)[] = d.layers.map((l) => (l.off ? "ignore" : roleFromName(l.name)));
  const scale = unitScale ?? guessUnitScale(d)?.scale ?? null;
  const n = d.segLayer.length;
  const L = d.layers.length;
  // Per-layer counts and lengths.
  const segs = new Array<number>(L).fill(0);
  const lengths = new Array<number>(L).fill(0);
  const texts = new Array<number>(L).fill(0);
  for (let i = 0; i < n; i++) {
    if (d.segFlags[i] & F_DIM) continue;
    const l = d.segLayer[i];
    segs[l]++;
    lengths[l] += Math.hypot(d.segs[i * 4 + 2] - d.segs[i * 4], d.segs[i * 4 + 3] - d.segs[i * 4 + 1]);
  }
  for (const f of d.fills) if (!(f.flags & F_DIM)) for (const ring of f.rings) segs[f.layer] += ring.length;
  for (const t of d.texts) if (!(t.flags & F_DIM)) texts[t.layer]++;
  if (!scale) return roles.map((r, l) => r ?? (texts[l] > 0 && texts[l] >= segs[l] ? "text" : "other"));
  const U = 1 / scale;

  if (!roles.includes("wall")) {
    // Layers whose lines (or fill outlines) mostly come in parallel pairs a wall's thickness apart.
    const paired = new Array<number>(L).fill(0);
    const share = new Array<number>(L).fill(0);
    for (let l = 0; l < L; l++) {
      if (roles[l] !== null || segs[l] < 8) continue;
      const lines: Line[] = [];
      for (let i = 0; i < n; i++) {
        if (d.segLayer[i] !== l || d.segFlags[i] & (F_DIM | F_CURVE)) continue;
        const line = lineOf(d.segs[i * 4], d.segs[i * 4 + 1], d.segs[i * 4 + 2], d.segs[i * 4 + 3]);
        if (line) lines.push(line);
      }
      for (const f of d.fills) {
        if (f.layer !== l || f.flags & F_DIM) continue;
        for (const ring of f.rings)
          for (let k = 0; k < ring.length; k++) {
            const a = ring[k],
              b = ring[(k + 1) % ring.length];
            const line = lineOf(a[0], a[1], b[0], b[1], true);
            if (line) lines.push(line);
          }
      }
      const merged = mergeLines(lines, 0.003, 0.002 * U, 0.002 * U);
      const total = merged.reduce((sum, x) => sum + x.s1 - x.s0, 0);
      const { pieces } = pairWalls(merged, 0.06 * U, 0.6 * U);
      paired[l] = pieces.reduce((sum, p) => sum + 2 * (p.s1 - p.s0), 0);
      share[l] = total > 0 ? paired[l] / total : 0;
    }
    const most = Math.max(0, ...paired);
    for (let l = 0; l < L; l++) if (roles[l] === null && paired[l] * scale > 4 && share[l] > 0.35 && paired[l] >= 0.25 * most) roles[l] = "wall";
  }
  if (!roles.includes("door")) {
    const arcs = quarterArcs(d, null);
    const byLayer = new Map<number, number>();
    for (const a of arcs) {
      const m = a.r * scale;
      if (m < 0.5 || m > 1.4) continue;
      byLayer.set(a.layer, (byLayer.get(a.layer) ?? 0) + 1);
    }
    for (const [l, count] of byLayer) if (roles[l] === null && count >= 2) roles[l] = "door";
  }
  if (!roles.includes("column")) {
    // Small closed shapes, round or squarish, that make up most of a layer.
    const shapes = new Array<number>(L).fill(0);
    const shapeSegs = new Array<number>(L).fill(0);
    for (const a of d.arcs) {
      if (roles[a.layer] !== null || a.flags & F_DIM || a.a1 - a.a0 < TAU - 1e-6) continue;
      const m = 2 * a.r * scale;
      if (m >= 0.15 && m <= 1.5) shapes[a.layer]++;
    }
    for (const p of d.polys) {
      if (roles[p.layer] !== null || p.flags & F_DIM) continue;
      const b = ringBox(p.points);
      const big = Math.max(b[2] - b[0], b[3] - b[1]) * scale,
        small = Math.min(b[2] - b[0], b[3] - b[1]) * scale;
      if (big >= 0.15 && big <= 1.5 && small >= 0.6 * big) {
        if (p.points.length <= 8) shapes[p.layer]++;
        shapeSegs[p.layer] += p.points.length;
      }
    }
    for (let l = 0; l < L; l++) if (roles[l] === null && shapes[l] >= 2 && shapeSegs[l] >= 0.7 * segs[l]) roles[l] = "column";
  }
  if (!roles.includes("window") && roles.includes("wall")) {
    // Lines that sit in the gaps of the walls, along them: glazing.
    const trial = recognize(d, { ...DEFAULT_RECOGNIZE, unitScale: scale, roles: roles.map((r) => (r === "wall" ? "wall" : r === "door" ? "door" : "other")), region: null, rooms: false });
    const gaps = trial.openings.filter((o) => o.kind === "opening" || o.kind === "window");
    if (gaps.length) {
      const inGaps = new Array<number>(L).fill(0);
      for (let i = 0; i < n; i++) {
        const l = d.segLayer[i];
        if (roles[l] !== null || d.segFlags[i] & F_DIM) continue;
        const ax = d.segs[i * 4],
          ay = d.segs[i * 4 + 1],
          bx = d.segs[i * 4 + 2],
          by = d.segs[i * 4 + 3];
        const mx = (ax + bx) / 2,
          my = (ay + by) / 2;
        for (const g of gaps) {
          const w = trial.walls[g.wall];
          const gl = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) || 1;
          const ux = (g.b[0] - g.a[0]) / gl,
            uy = (g.b[1] - g.a[1]) / gl;
          const s = (mx - g.a[0]) * ux + (my - g.a[1]) * uy;
          const off = Math.abs(-uy * (mx - g.a[0]) + ux * (my - g.a[1]));
          if (s < -0.02 * U || s > gl + 0.02 * U || off > w.t / 2 + 0.03 * U) continue;
          inGaps[l] += Math.hypot(bx - ax, by - ay);
          break;
        }
      }
      for (let l = 0; l < L; l++) if (roles[l] === null && inGaps[l] >= 0.5 * lengths[l] && inGaps[l] * scale >= 0.5) roles[l] = "window";
    }
  }
  return roles.map((r, l) => r ?? (texts[l] > 0 && texts[l] >= segs[l] ? "text" : "other"));
}

// ---------------------------------------------------------------------------
// Wall pairs

interface Piece {
  /** Centre line of a wall piece. */
  line: Line;
  s0: number;
  s1: number;
  t: number;
  fill: boolean;
}

/**
 * Each line takes its nearest parallel partner (either side) within the
 * thickness range, piece by piece along its length; pieces where the partner
 * takes the line back are walls.
 */
function pairWalls(lines: Line[], tmin: number, tmax: number): { pieces: Piece[]; used: Uint8Array } {
  const order = lines.map((_, i) => i).sort((a, b) => lines[a].th - lines[b].th);
  const groups: number[][] = [];
  for (let k = 0; k < order.length; ) {
    let m = k + 1;
    while (m < order.length && lines[order[m]].th - lines[order[m - 1]].th <= (0.5 * Math.PI) / 180) m++;
    groups.push(order.slice(k, m));
    k = m;
  }
  // claims[i]: intervals of line i (in its own s) and the partner that claims them.
  const claims = new Map<number, { j: number; u0: number; u1: number; delta: number }[]>();
  const angTol = (0.6 * Math.PI) / 180;
  for (const group of groups) {
    // Offsets in a shared frame for the candidate search.
    const th = lines[group[0]].th;
    const gdx = Math.cos(th),
      gdy = Math.sin(th);
    const offs = group.map((i) => {
      const l = lines[i];
      const c = at(l, (l.s0 + l.s1) / 2);
      return { i, o: -gdy * c[0] + gdx * c[1] };
    });
    offs.sort((a, b) => a.o - b.o);
    const os = offs.map((x) => x.o);
    const lower = (v: number) => {
      let lo = 0,
        hi = os.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (os[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    for (const { i, o } of offs) {
      const li = lines[i];
      const cands: { j: number; u0: number; u1: number; delta: number }[] = [];
      const slack = tmax * 0.05 + (li.s1 - li.s0) * 0.01;
      for (let k = lower(o - tmax - slack); k < os.length && os[k] <= o + tmax + slack; k++) {
        const j = offs[k].i;
        if (j === i) continue;
        const lj = lines[j];
        if (Math.abs(lj.th - li.th) > angTol) continue;
        const a = at(lj, lj.s0),
          b = at(lj, lj.s1);
        const da = -li.dy * a[0] + li.dx * a[1] - li.o,
          db = -li.dy * b[0] + li.dx * b[1] - li.o;
        const delta = (da + db) / 2;
        const ad = Math.abs(delta);
        if (ad < tmin || ad > tmax || Math.abs(da - db) > Math.max(tmin * 0.25, ad * 0.08)) continue;
        const sa = li.dx * a[0] + li.dy * a[1],
          sb = li.dx * b[0] + li.dy * b[1];
        const u0 = Math.max(li.s0, Math.min(sa, sb)),
          u1 = Math.min(li.s1, Math.max(sa, sb));
        if (u1 - u0 <= 0) continue;
        cands.push({ j, u0, u1, delta });
      }
      if (!cands.length) continue;
      cands.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
      // Coverage sweep: the nearest partner claims each part of the line.
      let free: [number, number][] = [[li.s0, li.s1]];
      const mine: { j: number; u0: number; u1: number; delta: number }[] = [];
      for (const c of cands) {
        const next: [number, number][] = [];
        for (const [f0, f1] of free) {
          const x0 = Math.max(f0, c.u0),
            x1 = Math.min(f1, c.u1);
          if (x1 > x0) {
            mine.push({ j: c.j, u0: x0, u1: x1, delta: c.delta });
            if (x0 > f0) next.push([f0, x0]);
            if (f1 > x1) next.push([x1, f1]);
          } else next.push([f0, f1]);
        }
        free = next;
        if (!free.length) break;
      }
      claims.set(i, mine);
    }
  }
  const pieces: Piece[] = [];
  const used = new Uint8Array(lines.length);
  for (const [i, mine] of claims) {
    const li = lines[i];
    for (const c of mine) {
      if (c.j < i) continue;
      const back = claims.get(c.j);
      if (!back) continue;
      const lj = lines[c.j];
      for (const r of back) {
        if (r.j !== i) continue;
        // j's interval in i's frame.
        const a = at(lj, r.u0),
          b = at(lj, r.u1);
        const sa = li.dx * a[0] + li.dy * a[1],
          sb = li.dx * b[0] + li.dy * b[1];
        const u0 = Math.max(c.u0, Math.min(sa, sb)),
          u1 = Math.min(c.u1, Math.max(sa, sb));
        if (u1 - u0 <= 0) continue;
        pieces.push({ line: { ...li, o: li.o + c.delta / 2 }, s0: u0, s1: u1, t: Math.abs(c.delta), fill: li.fill && lj.fill });
        used[i] = 1;
        used[c.j] = 1;
      }
    }
  }
  return { pieces, used };
}

interface Run {
  th: number;
  dx: number;
  dy: number;
  o: number;
  s0: number;
  s1: number;
  t: number;
  source: RecWall["source"];
  /** Removed (merged into another run). */
  dead?: boolean;
}

/** Joins wall pieces that continue each other (same line, same thickness, touching). */
function mergeRuns(pieces: Run[], tolOff: number, tolT: number, gap: number): Run[] {
  const sorted = pieces.slice().sort((a, b) => a.th - b.th || a.o - b.o || a.s0 - b.s0);
  const out: Run[] = [];
  const angTol = (0.5 * Math.PI) / 180;
  for (const p of sorted) {
    let merged = false;
    for (let k = out.length - 1; k >= 0 && k >= out.length - 400; k--) {
      const q = out[k];
      if (Math.abs(q.th - p.th) > angTol) continue;
      // Offset of p in q's frame.
      const c = at(p, (p.s0 + p.s1) / 2);
      const o = -q.dy * c[0] + q.dx * c[1];
      if (Math.abs(o - q.o) > Math.max(tolOff, 0.1 * Math.min(p.t, q.t))) continue;
      if (Math.abs(p.t - q.t) > Math.max(tolT, 0.08 * Math.max(p.t, q.t))) continue;
      const a = at(p, p.s0),
        b = at(p, p.s1);
      const sa = q.dx * a[0] + q.dy * a[1],
        sb = q.dx * b[0] + q.dy * b[1];
      const s0 = Math.min(sa, sb),
        s1 = Math.max(sa, sb);
      if (s0 > q.s1 + gap || s1 < q.s0 - gap) continue;
      const lq = q.s1 - q.s0,
        lp = s1 - s0;
      q.t = (q.t * lq + p.t * lp) / (lq + lp);
      q.s0 = Math.min(q.s0, s0);
      q.s1 = Math.max(q.s1, s1);
      merged = true;
      break;
    }
    if (!merged) out.push({ ...p });
  }
  return out;
}

/** Parallel runs whose faces touch (a cavity, a lining): one wall over both. */
function mergeLayered(runs: Run[], maxGap: number, tmax: number): Run[] {
  const angTol = (0.5 * Math.PI) / 180;
  const sorted = runs.slice().sort((a, b) => a.th - b.th || a.o - b.o);
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (p.dead) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const q = sorted[j];
      if (q.th - p.th > angTol) break;
      if (q.dead) continue;
      const c = at(q, (q.s0 + q.s1) / 2);
      const o = -p.dy * c[0] + p.dx * c[1];
      const gapBetween = Math.abs(o - p.o) - (p.t + q.t) / 2;
      if (gapBetween > maxGap || gapBetween < -Math.min(p.t, q.t) * 0.5) continue;
      const a = at(q, q.s0),
        b = at(q, q.s1);
      const sa = p.dx * a[0] + p.dy * a[1],
        sb = p.dx * b[0] + p.dy * b[1];
      const s0 = Math.min(sa, sb),
        s1 = Math.max(sa, sb);
      const overlap = Math.min(p.s1, s1) - Math.max(p.s0, s0);
      if (overlap < 0.8 * Math.min(p.s1 - p.s0, s1 - s0)) continue;
      const lo = Math.min(p.o - p.t / 2, o - q.t / 2),
        hi = Math.max(p.o + p.t / 2, o + q.t / 2);
      if (hi - lo > tmax) continue;
      p.o = (lo + hi) / 2;
      p.t = hi - lo;
      p.s0 = Math.min(p.s0, s0);
      p.s1 = Math.max(p.s1, s1);
      q.dead = true;
    }
  }
  return sorted.filter((r) => !r.dead);
}

// ---------------------------------------------------------------------------
// Openings

interface Span {
  run: number;
  s0: number;
  s1: number;
  kind: OpeningKind;
  swing: Pt | null;
  hinge: "a" | "b" | "both" | null;
  operation: string | null;
  name: string | null;
  arcs?: number;
}

/**
 * The run a point (and direction) sits on: parallel within `angTol`, the point
 * within the wall's half thickness (plus `slack`) of its centre line, and on
 * the run or in a gap of its line up to `reach` from it; the nearest along the
 * line wins.
 */
function hostRun(runs: Run[], p: Pt, dir: Pt | null, slack: number, reach: number, angTol = 0.17): { run: number; s: number; off: number } | null {
  let best: { run: number; s: number; off: number } | null = null;
  let bestScore = Infinity;
  runs.forEach((r, k) => {
    if (r.dead) return;
    if (dir && Math.abs(dir[0] * r.dx + dir[1] * r.dy) < Math.cos(angTol)) return;
    const off = -r.dy * p[0] + r.dx * p[1] - r.o;
    const d = Math.abs(off);
    if (d > r.t / 2 + slack) return;
    const s = r.dx * p[0] + r.dy * p[1];
    const along = s < r.s0 ? r.s0 - s : s > r.s1 ? s - r.s1 : 0;
    if (along > reach) return;
    const score = along + d;
    if (score < bestScore) {
      bestScore = score;
      best = { run: k, s, off };
    }
  });
  return best;
}

// ---------------------------------------------------------------------------
// Rooms

class Raster {
  readonly w: number;
  readonly h: number;
  readonly res: number;
  readonly x0: number;
  readonly y1: number;
  readonly data: Uint8Array;
  constructor(box: [number, number, number, number], res: number) {
    this.res = res;
    this.x0 = box[0];
    this.y1 = box[3];
    this.w = Math.max(1, Math.ceil((box[2] - box[0]) / res));
    this.h = Math.max(1, Math.ceil((box[3] - box[1]) / res));
    this.data = new Uint8Array(this.w * this.h);
  }
  px(p: Pt): Pt {
    return [(p[0] - this.x0) / this.res, (this.y1 - p[1]) / this.res];
  }
  unit(x: number, y: number): Pt {
    return [this.x0 + x * this.res, this.y1 - y * this.res];
  }
  /** Scanline fill of a polygon (drawing units). */
  fill(poly: Pt[], v = 1) {
    const pts = poly.map((p) => this.px(p));
    let ymin = Infinity,
      ymax = -Infinity;
    for (const p of pts) {
      ymin = Math.min(ymin, p[1]);
      ymax = Math.max(ymax, p[1]);
    }
    const y0 = Math.max(0, Math.floor(ymin)),
      y1 = Math.min(this.h - 1, Math.ceil(ymax));
    const xs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      xs.length = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i],
          b = pts[j];
        if (a[1] > cy !== b[1] > cy) xs.push(a[0] + ((cy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] - 0.5)),
          xb = Math.min(this.w - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = xa; x <= xb; x++) this.data[y * this.w + x] = v;
      }
    }
  }
  /** A line `width` pixels wide. */
  line(a: Pt, b: Pt, width = 1, v = 1) {
    const pa = this.px(a),
      pb = this.px(b);
    const n = Math.max(1, Math.ceil(Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) * 2));
    const r = Math.max(0, Math.floor((width - 1) / 2));
    for (let i = 0; i <= n; i++) {
      const x = Math.round(pa[0] + ((pb[0] - pa[0]) * i) / n - 0.5),
        y = Math.round(pa[1] + ((pb[1] - pa[1]) * i) / n - 0.5);
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const X = x + dx,
            Y = y + dy;
          if (X >= 0 && Y >= 0 && X < this.w && Y < this.h) this.data[Y * this.w + X] = v;
        }
    }
  }
}

/** Outer boundary of the 4-connected region `id` of `label` starting at its first pixel (marching squares, pixel corners). */
function traceRegion(label: Int32Array, w: number, h: number, id: number, start: number): Pt[] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && label[y * w + x] === id;
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
  const sx = start % w,
    sy = Math.floor(start / w);
  const out: Pt[] = [[sx, sy]];
  let x = sx,
    y = sy,
    dir = 0;
  for (let guard = 0; guard < 4 * (w + 1) * (h + 1); guard++) {
    x += DX[dir];
    y += DY[dir];
    if (x === sx && y === sy) break;
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

const AREA_RE = /^(a\s*=\s*)?\d+([.,]\d+)?\s*(m²|m2|sq\.?\s?m|sqm|sf|sq\.?\s?ft|ft²|ft2|qm)$/i;
const LEVEL_RE = /^(ffl|sfl|ssl|fl|ok|uk|\+|-|±)\s*[\d.,]+/i;
const NUMBER_RE = /^[A-Z]{0,3}[-.\s]?\d{1,4}[A-Z]?([.-]\d{1,3}[A-Z]?)?$/i;

/** Room name and number from the texts inside a room (largest first). */
export function roomLabel(texts: { text: string; h: number }[]): { name: string | null; number: string | null } {
  const lines = texts
    .slice()
    .sort((a, b) => b.h - a.h)
    .flatMap((t) => t.text.split("\n").map((s) => s.trim()))
    .filter(Boolean);
  let name: string | null = null;
  let number: string | null = null;
  for (const line of lines) {
    if (AREA_RE.test(line) || LEVEL_RE.test(line) || /^[\d.,\s×x*/-]+$/.test(line) && !NUMBER_RE.test(line)) continue;
    if (!number && NUMBER_RE.test(line) && /\d/.test(line) && line.length <= 10) number = line;
    else if (!name && /[\p{L}]{2,}/u.test(line)) name = line;
    if (name && number) break;
  }
  return { name, number };
}

export interface RoomText {
  c: Pt;
  text: string;
  h: number;
}

/**
 * Rooms and the floor outline from walls (any units; `unitScale` is metres per
 * unit): the closed areas the walls, columns and `closers` (glazing lines)
 * leave, unless `rooms` already holds room outlines; each named by the texts
 * inside it.
 */
export function findRooms(walls: RecWall[], columns: RecColumn[], closers: [Pt, Pt][], texts: RoomText[], unitScale: number, options: { fromWalls: boolean; rooms?: RecRoom[] }): { rooms: RecRoom[]; outline: Pt[] } {
  const scale = unitScale;
  const U = 1 / scale;
  const rooms: RecRoom[] = options.rooms ? options.rooms.slice() : [];
  let outline: Pt[] = [];
  const geomBox = (() => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const w of walls)
      for (const p of [w.a, w.b]) {
        x0 = Math.min(x0, p[0] - w.t);
        y0 = Math.min(y0, p[1] - w.t);
        x1 = Math.max(x1, p[0] + w.t);
        y1 = Math.max(y1, p[1] + w.t);
      }
    return x1 > x0 ? ([x0, y0, x1, y1] as [number, number, number, number]) : null;
  })();
  if (geomBox) {
    const margin = 0.5 * U;
    const box: [number, number, number, number] = [geomBox[0] - margin, geomBox[1] - margin, geomBox[2] + margin, geomBox[3] + margin];
    const span = Math.max(box[2] - box[0], box[3] - box[1]);
    const res = Math.max(0.02 * U, span / 3000);
    const ras = new Raster(box, res);
    for (const w of walls) {
      const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
      const nx = (-(w.b[1] - w.a[1]) / L) * (w.t / 2),
        ny = ((w.b[0] - w.a[0]) / L) * (w.t / 2);
      ras.fill([
        [w.a[0] + nx, w.a[1] + ny],
        [w.b[0] + nx, w.b[1] + ny],
        [w.b[0] - nx, w.b[1] - ny],
        [w.a[0] - nx, w.a[1] - ny],
      ]);
      // Thin walls still close their rooms.
      ras.line(w.a, w.b, 2);
    }
    for (const c of columns) {
      if (c.ring) ras.fill(c.ring);
      else if (c.circle) {
        const k = 24;
        ras.fill(Array.from({ length: k }, (_, i) => [c.circle!.c[0] + c.circle!.r * Math.cos((i / k) * TAU), c.circle!.c[1] + c.circle!.r * Math.sin((i / k) * TAU)] as Pt));
      }
    }
    // Glazing lines and unpaired wall lines close rooms too (curtain walls, partitions drawn as one line).
    for (const [a, b] of closers) ras.line(a, b, 2);
    // Wall ends that miss each other by a little (up to about a quarter metre, far less than a door) still close rooms.
    {
      const close = Math.round((0.12 * U) / res);
      if (close >= 1) ras.data.set(closeGrid(ras.data, ras.w, ras.h, close));
    }
    const { w, h, data } = ras;
    // Outside: flood from the border.
    const OUT = 2;
    const stack: number[] = [];
    const push = (i: number) => {
      if (data[i] === 0) {
        data[i] = OUT;
        stack.push(i);
      }
    };
    for (let x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      push(y * w);
      push(y * w + w - 1);
    }
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < (h - 1) * w) push(i + w);
    }
    // The floor: everything not outside.
    const floor = new Int32Array(w * h).fill(-1);
    let firstFloor = -1;
    for (let i = 0; i < w * h; i++)
      if (data[i] !== OUT) {
        floor[i] = 0;
        if (firstFloor < 0) firstFloor = i;
      }
    if (firstFloor >= 0) {
      // Largest connected part of the floor.
      const lab = new Int32Array(w * h).fill(-1);
      let best = -1,
        bestSize = 0,
        bestStart = -1,
        id = 0;
      for (let i = 0; i < w * h; i++) {
        if (floor[i] !== 0 || lab[i] >= 0) continue;
        let size = 0;
        lab[i] = id;
        stack.push(i);
        while (stack.length) {
          const j = stack.pop()!;
          size++;
          const x = j % w;
          for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) if (k >= 0 && k < w * h && floor[k] === 0 && lab[k] < 0) {
            lab[k] = id;
            stack.push(k);
          }
        }
        if (size > bestSize) {
          bestSize = size;
          best = id;
          bestStart = i;
        }
        id++;
      }
      if (bestStart >= 0) outline = simplifyRing(traceRegion(lab, w, h, best, bestStart), 1.0).map(([x, y]) => ras.unit(x, y));
    }
    if (options.fromWalls && rooms.length === 0) {
      // Rooms: free areas inside, wide enough to stand in.
      const dist = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) dist[i] = data[i] === 0 ? 1e9 : 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!dist[i]) continue;
          if (x > 0) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
          if (y > 0) dist[i] = Math.min(dist[i], dist[i - w] + 1);
        }
      for (let y = h - 1; y >= 0; y--)
        for (let x = w - 1; x >= 0; x--) {
          const i = y * w + x;
          if (!dist[i]) continue;
          if (x < w - 1) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
          if (y < h - 1) dist[i] = Math.min(dist[i], dist[i + w] + 1);
        }
      const lab = new Int32Array(w * h).fill(-1);
      let id = 0;
      for (let i = 0; i < w * h; i++) {
        if (data[i] !== 0 || lab[i] >= 0) continue;
        let size = 0,
          maxD = 0;
        lab[i] = id;
        stack.push(i);
        while (stack.length) {
          const j = stack.pop()!;
          size++;
          if (dist[j] > maxD) maxD = dist[j];
          const x = j % w;
          for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) if (k >= 0 && k < w * h && data[k] === 0 && lab[k] < 0) {
            lab[k] = id;
            stack.push(k);
          }
        }
        const areaM = size * res * res * scale * scale;
        if (areaM >= 0.8 && maxD * res * scale >= 0.25) {
          const ring = simplifyRing(traceRegion(lab, w, h, id, i), 0.9).map(([x, y]) => ras.unit(x, y));
          if (ring.length >= 3) rooms.push({ ring, name: null, number: null, area: Math.abs(ringArea(ring)) * scale * scale, source: "walls" });
        }
        id++;
      }
    }
  }
  // Names: texts inside each room (smallest room first, so nested outlines get their own).
  const claimed = new Set<number>();
  rooms.sort((a, b) => a.area - b.area);
  for (const room of rooms) {
    const box = ringBox(room.ring);
    const inside: { text: string; h: number }[] = [];
    texts.forEach((t, k) => {
      if (claimed.has(k) || t.c[0] < box[0] || t.c[0] > box[2] || t.c[1] < box[1] || t.c[1] > box[3]) return;
      if (!pointInRing(t.c[0], t.c[1], room.ring)) return;
      inside.push({ text: t.text, h: t.h });
      claimed.add(k);
    });
    const { name, number } = roomLabel(inside);
    room.name = name;
    room.number = number;
  }

  return { rooms, outline };
}

// ---------------------------------------------------------------------------
// Main

/** Chessboard distance (cells) from every cell to the nearest cell equal to `value`. */
function chessDistance(src: Uint8Array, w: number, h: number, value: number): Int32Array {
  const d = new Int32Array(w * h).fill(1 << 29);
  for (let i = 0; i < w * h; i++) if (src[i] === value) d[i] = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
      if (y > 0) d[i] = Math.min(d[i], d[i - w] + 1);
      if (x > 0 && y > 0) d[i] = Math.min(d[i], d[i - w - 1] + 1);
      if (x < w - 1 && y > 0) d[i] = Math.min(d[i], d[i - w + 1] + 1);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
      if (y < h - 1) d[i] = Math.min(d[i], d[i + w] + 1);
      if (x < w - 1 && y < h - 1) d[i] = Math.min(d[i], d[i + w + 1] + 1);
      if (x > 0 && y < h - 1) d[i] = Math.min(d[i], d[i + w - 1] + 1);
    }
  return d;
}

/** Walls (cells ≠ 0) closed by `r` cells: gaps up to 2r wide filled, everything else as it was. */
function closeGrid(data: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const toWall = chessDistance(data, w, h, 1);
  const grown = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) grown[i] = data[i] || toWall[i] <= r ? 1 : 0;
  const toFree = chessDistance(grown, w, h, 0);
  const closed = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) closed[i] = data[i] || toFree[i] > r ? 1 : 0;
  return closed;
}

/**
 * The room around a point (click-to-outline): the walls and columns drawn on a
 * grid, gaps up to a door's width bridged, then the free area reached from
 * the point. Null when the area is open to the outside.
 */
export function roomAt(walls: RecWall[], columns: RecColumn[], texts: RoomText[], unitScale: number, at: Pt): RecRoom | null {
  const scale = unitScale;
  const U = 1 / scale;
  if (!walls.length) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const w of walls)
    for (const p of [w.a, w.b]) {
      x0 = Math.min(x0, p[0] - w.t);
      y0 = Math.min(y0, p[1] - w.t);
      x1 = Math.max(x1, p[0] + w.t);
      y1 = Math.max(y1, p[1] + w.t);
    }
  const margin = 1.5 * U;
  const box: [number, number, number, number] = [Math.min(x0, at[0]) - margin, Math.min(y0, at[1]) - margin, Math.max(x1, at[0]) + margin, Math.max(y1, at[1]) + margin];
  const span = Math.max(box[2] - box[0], box[3] - box[1]);
  const res = Math.max(0.03 * U, span / 1500);
  const ras = new Raster(box, res);
  for (const w of walls) {
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
    const nx = (-(w.b[1] - w.a[1]) / L) * (w.t / 2),
      ny = ((w.b[0] - w.a[0]) / L) * (w.t / 2);
    ras.fill([
      [w.a[0] + nx, w.a[1] + ny],
      [w.b[0] + nx, w.b[1] + ny],
      [w.b[0] - nx, w.b[1] - ny],
      [w.a[0] - nx, w.a[1] - ny],
    ]);
    ras.line(w.a, w.b, 2);
  }
  for (const c of columns) {
    if (c.ring) ras.fill(c.ring);
    else if (c.circle) ras.fill(Array.from({ length: 24 }, (_, i) => [c.circle!.c[0] + c.circle!.r * Math.cos((i / 24) * TAU), c.circle!.c[1] + c.circle!.r * Math.sin((i / 24) * TAU)] as Pt));
  }
  const { w, h, data } = ras;
  // Bridge door-sized gaps: close the walls by 0.6 m.
  const r = Math.max(1, Math.round((0.6 * U) / res));
  const closed = closeGrid(data, w, h, r);
  const [px, py] = ras.px(at);
  const sx = Math.floor(px),
    sy = Math.floor(py);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const start = sy * w + sx;
  if (closed[start]) return null;
  const lab = new Int32Array(w * h).fill(-1);
  const stack = [start];
  lab[start] = 0;
  let size = 0;
  while (stack.length) {
    const j = stack.pop()!;
    size++;
    const x = j % w,
      y = Math.floor(j / w);
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) return null; // open to the outside
    for (const k of [j - 1, j + 1, j - w, j + w])
      if (!closed[k] && lab[k] < 0) {
        lab[k] = 0;
        stack.push(k);
      }
  }
  // Give back what the closing took from the room's own edges: grow the region into cells that are free in the walls themselves.
  for (let pass = 0; pass < r; pass++) {
    const add: number[] = [];
    for (let i = 0; i < w * h; i++) {
      if (lab[i] === 0 || data[i]) continue;
      const x = i % w;
      if ((x > 0 && lab[i - 1] === 0) || (x < w - 1 && lab[i + 1] === 0) || (i >= w && lab[i - w] === 0) || (i < w * (h - 1) && lab[i + w] === 0)) add.push(i);
    }
    if (!add.length) break;
    for (const i of add) lab[i] = 0;
  }
  if (size * res * res * scale * scale < 0.3) return null;
  // The boundary trace starts at the region's first cell in raster order.
  const first = lab.indexOf(0);
  const ring = simplifyRing(traceRegion(lab, w, h, 0, first), 0.9).map(([x, y]) => ras.unit(x, y));
  if (ring.length < 3) return null;
  const inside = texts.filter((t) => pointInRing(t.c[0], t.c[1], ring)).map((t) => ({ text: t.text, h: t.h }));
  const { name, number } = roomLabel(inside);
  return { ring, name, number, area: Math.abs(ringArea(ring)) * scale * scale, source: "walls" };
}

export function recognize(d: VectorDrawing, options: RecognizeOptions): Recognized {
  const started = Date.now();
  const scale = options.unitScale;
  const U = 1 / scale; // units per metre
  const roles = options.roles;
  const region = options.region;
  const warnings: string[] = [];
  const inRegion = (x: number, y: number) => !region || (x >= region[0] && x <= region[2] && y >= region[1] && y <= region[3]);
  const symbolRole = (s: number): LayerRole | null => {
    for (let k = s; k >= 0; k = d.symbols[k].parent) {
      const r = roles[d.symbols[k].layer];
      if (r === "door" || r === "window") return r;
    }
    return null;
  };
  const tmin = options.minThickness * U,
    tmax = options.maxThickness * U;

  // --- Wall lines
  const wallLines: Line[] = [];
  const n = d.segLayer.length;
  let wallSegCount = 0;
  for (let i = 0; i < n; i++) {
    if (roles[d.segLayer[i]] !== "wall" || d.segFlags[i] & (F_DIM | F_CURVE | F_WIDE)) continue;
    const ax = d.segs[i * 4],
      ay = d.segs[i * 4 + 1],
      bx = d.segs[i * 4 + 2],
      by = d.segs[i * 4 + 3];
    if (!inRegion(ax, ay) && !inRegion(bx, by)) continue;
    const s = d.segSymbol[i];
    if (s >= 0 && symbolRole(s)) continue;
    const line = lineOf(ax, ay, bx, by);
    if (line && line.s1 - line.s0 >= 0.005 * U) {
      wallLines.push(line);
      wallSegCount++;
    }
  }
  // Wall fills: outlines take part in the pairing, areas confirm pairs.
  const wallFillRings: Pt[][] = [];
  for (const f of d.fills) {
    if (roles[f.layer] !== "wall" || f.flags & F_DIM) continue;
    if (!f.rings.some((r) => r.some((p) => inRegion(p[0], p[1])))) continue;
    for (const ring of f.rings) {
      wallFillRings.push(ring);
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k],
          b = ring[(k + 1) % ring.length];
        const line = lineOf(a[0], a[1], b[0], b[1], true);
        if (line && line.s1 - line.s0 >= 0.005 * U) wallLines.push(line);
      }
    }
  }
  const merged = mergeLines(wallLines, (0.25 * Math.PI) / 180, 0.002 * U, 0.003 * U);
  const { pieces, used } = pairWalls(merged, tmin, tmax);
  const totalLen = merged.reduce((s, l) => s + l.s1 - l.s0, 0);
  const pairedLen = pieces.reduce((s, p) => s + 2 * (p.s1 - p.s0), 0);
  const pairedShare = totalLen > 0 ? Math.min(1, pairedLen / totalLen) : 0;

  // Fill evidence: when most pairs lie in the wall fill, pairs outside it are not walls (corridors, shafts).
  let fillChecked = false;
  // Pictures: a piece much shorter than its thickness is no wall (slivers where lines meet at a hinge or a corner).
  const sliver = d.source === "picture" ? 0.25 : 0;
  let accepted = pieces.filter((p) => p.s1 - p.s0 >= Math.max(0.02 * U, sliver * p.t));
  if (wallFillRings.length) {
    const index = new RingIndex(wallFillRings, 2 * U);
    const inFill = (p: Piece) => {
      let k = 0;
      for (const f of [0.2, 0.5, 0.8]) {
        const c = at(p.line, p.s0 + (p.s1 - p.s0) * f);
        if (index.contains(c[0], c[1])) k++;
      }
      return k >= 2;
    };
    const flags = accepted.map(inFill);
    const confirmed = accepted.reduce((s, p, i) => s + (flags[i] ? p.s1 - p.s0 : 0), 0);
    const all = accepted.reduce((s, p) => s + p.s1 - p.s0, 0);
    if (all > 0 && confirmed / all > 0.6) {
      fillChecked = true;
      accepted = accepted.filter((_, i) => flags[i]);
    }
  }

  let runs: Run[] = accepted.map((p) => ({ th: p.line.th, dx: p.line.dx, dy: p.line.dy, o: p.line.o, s0: p.s0, s1: p.s1, t: p.t, source: p.fill ? "fill" : "lines" }));

  // Wide polylines on wall layers: each straight part is a wall of the line's width.
  for (const s of d.strips) {
    if (roles[s.layer] !== "wall" || s.width < tmin || s.width > tmax) continue;
    const pts = s.points;
    const count = s.closed ? pts.length : pts.length - 1;
    for (let k = 0; k < count; k++) {
      const a = pts[k],
        b = pts[(k + 1) % pts.length];
      if (!inRegion(a[0], a[1]) && !inRegion(b[0], b[1])) continue;
      const line = lineOf(a[0], a[1], b[0], b[1]);
      if (line) runs.push({ th: line.th, dx: line.dx, dy: line.dy, o: line.o, s0: line.s0, s1: line.s1, t: s.width, source: "wide" });
    }
  }

  // Single lines: lines with no partner as wall centre lines.
  const unpaired = merged.filter((l, i) => !used[i] && !l.fill && l.s1 - l.s0 >= 0.3 * U);
  const singleOn = options.singleLines === "on" || (options.singleLines === "auto" && wallSegCount >= 4 && pairedShare < 0.2);
  if (singleOn) for (const l of unpaired) runs.push({ th: l.th, dx: l.dx, dy: l.dy, o: l.o, s0: l.s0, s1: l.s1, t: options.defaultThickness * U, source: "single" });

  runs = mergeRuns(runs, 0.004 * U, 0.006 * U, 0.01 * U);
  runs = mergeLayered(runs, 0.06 * U, tmax);
  runs = mergeRuns(runs, 0.004 * U, 0.006 * U, 0.01 * U);

  // Curved walls: concentric arcs on wall layers.
  const curved: RecWall[] = [];
  const wallArcs = d.arcs.filter((a) => {
    if (roles[a.layer] !== "wall" || a.flags & F_DIM) return false;
    const mid = (a.a0 + a.a1) / 2;
    return inRegion(a.c[0] + a.r * Math.cos(mid), a.c[1] + a.r * Math.sin(mid));
  });
  const arcUsed = new Uint8Array(wallArcs.length);
  for (let i = 0; i < wallArcs.length; i++) {
    const p = wallArcs[i];
    let best = -1,
      bestDr = Infinity;
    for (let j = 0; j < wallArcs.length; j++) {
      if (j === i) continue;
      const q = wallArcs[j];
      if (Math.hypot(p.c[0] - q.c[0], p.c[1] - q.c[1]) > 0.01 * U) continue;
      const dr = Math.abs(p.r - q.r);
      if (dr < tmin || dr > tmax || dr >= bestDr) continue;
      // Angular overlap.
      if (Math.min(p.a1, q.a1) - Math.max(p.a0, q.a0) <= 0.01) continue;
      best = j;
      bestDr = dr;
    }
    if (best < 0 || best < i) continue;
    const q = wallArcs[best];
    arcUsed[i] = arcUsed[best] = 1;
    const a0 = Math.max(p.a0, q.a0),
      a1 = Math.min(p.a1, q.a1);
    const r = (p.r + q.r) / 2;
    const sag = 0.01 * U;
    const step = Math.min((10 * Math.PI) / 180, 2 * Math.acos(Math.max(-1, 1 - sag / r)));
    const k = Math.max(1, Math.ceil((a1 - a0) / step));
    for (let s = 0; s < k; s++) {
      const t0 = a0 + ((a1 - a0) * s) / k,
        t1 = a0 + ((a1 - a0) * (s + 1)) / k;
      curved.push({ a: [p.c[0] + r * Math.cos(t0), p.c[1] + r * Math.sin(t0)], b: [p.c[0] + r * Math.cos(t1), p.c[1] + r * Math.sin(t1)], t: bestDr, source: "arc" });
    }
  }

  // --- Openings
  const openLayers = (role: LayerRole) => roles.some((r) => r === role);
  const hasDoorLayer = openLayers("door");
  const hasWindowLayer = openLayers("window");
  const spans: Span[] = [];
  // Door swings.
  const swings = d.arcs
    .map((a, idx) => ({ a, idx }))
    .filter(({ a }) => {
      if (a.flags & F_DIM || !inRegion(a.c[0], a.c[1])) return false;
      const role = roles[a.layer];
      const symRole = a.symbol >= 0 ? symbolRole(a.symbol) : null;
      if (!(role === "door" || symRole === "door" || (!hasDoorLayer && role !== "ignore" && role !== "wall" && role !== "column" && role !== "room" && role !== "window"))) return false;
      const sweep = a.a1 - a.a0;
      const rm = a.r * scale;
      return sweep >= (55 * Math.PI) / 180 && sweep <= (125 * Math.PI) / 180 && rm >= 0.3 && rm <= 1.6;
    });
  // How much of [s0, s1] on a run's line no collinear run covers (a door's span should be the gap at its hinge).
  const freeShare = (k: number, s0: number, s1: number) => {
    const r = runs[k];
    const cover: [number, number][] = [];
    runs.forEach((q, j) => {
      if (Math.abs(q.dx * r.dx + q.dy * r.dy) < Math.cos((0.5 * Math.PI) / 180)) return;
      const c = at(q, (q.s0 + q.s1) / 2);
      if (j !== k && Math.abs(-r.dy * c[0] + r.dx * c[1] - r.o) > Math.max(0.01 * U, 0.15 * Math.min(q.t, r.t))) return;
      const a = at(q, q.s0),
        b = at(q, q.s1);
      const qa = r.dx * a[0] + r.dy * a[1],
        qb = r.dx * b[0] + r.dy * b[1];
      const lo = Math.max(s0, Math.min(qa, qb)),
        hi = Math.min(s1, Math.max(qa, qb));
      if (hi > lo) cover.push([lo, hi]);
    });
    cover.sort((x, y) => x[0] - y[0]);
    let covered = 0,
      end = s0;
    for (const [lo, hi] of cover) {
      if (hi <= end) continue;
      covered += hi - Math.max(lo, end);
      end = hi;
    }
    return s1 > s0 ? 1 - covered / (s1 - s0) : 0;
  };
  for (const { a } of swings) {
    const ends: Pt[] = [
      [Math.cos(a.a0), Math.sin(a.a0)],
      [Math.cos(a.a1), Math.sin(a.a1)],
    ];
    // Either end of the swing may be the closed leaf along the wall: take the one whose span is the gap.
    let found: Span | null = null;
    let foundFree = -1;
    for (let e = 0; e < 2; e++) {
      const closed = ends[e],
        open = ends[1 - e];
      const host = hostRun(runs, a.c, closed, 0.08 * U + a.r * 0.05, a.r * 0.5);
      if (!host) continue;
      const r = runs[host.run];
      const dirS = closed[0] * r.dx + closed[1] * r.dy; // ±1
      const s0 = Math.min(host.s, host.s + dirS * a.r),
        s1 = Math.max(host.s, host.s + dirS * a.r);
      const free = freeShare(host.run, s0, s1);
      if (free <= foundFree) continue;
      const normal: Pt = [-r.dy, r.dx];
      const side = open[0] * normal[0] + open[1] * normal[1];
      foundFree = free;
      found = {
        run: host.run,
        s0,
        s1,
        kind: "door",
        swing: side >= 0 ? normal : [-normal[0], -normal[1]],
        hinge: dirS > 0 ? "a" : "b",
        operation: null,
        name: a.symbol >= 0 ? d.symbols[a.symbol].name : null,
        arcs: 1,
      };
    }
    if (found) spans.push(found);
  }
  // Two leaves meeting in the middle: one double door.
  spans.sort((p, q) => p.run - q.run || p.s0 - q.s0);
  for (let i = 0; i + 1 < spans.length; i++) {
    const p = spans[i],
      q = spans[i + 1];
    if (p.kind !== "door" || q.kind !== "door" || p.run !== q.run) continue;
    const L = Math.max(p.s1 - p.s0, q.s1 - q.s0);
    if (Math.abs(q.s0 - p.s1) <= 0.12 * L && p.hinge === "a" && q.hinge === "b") {
      p.s1 = q.s1;
      p.hinge = "both";
      p.arcs = 2;
      p.operation = p.swing && q.swing && p.swing[0] * q.swing[0] + p.swing[1] * q.swing[1] > 0 ? "DOUBLE_DOOR_SINGLE_SWING" : "DOUBLE_DOOR_DOUBLE_SWING";
      spans.splice(i + 1, 1);
    }
  }
  for (const s of spans) {
    if (s.kind === "door" && !s.operation) {
      // IFC: viewed along the swing direction (+y of the door), hinges on the left or the right.
      const r = runs[s.run];
      const x: Pt = s.swing ? [s.swing[1], -s.swing[0]] : [r.dx, r.dy];
      const along = x[0] * r.dx + x[1] * r.dy; // +1: the door's x runs with the wall's s
      const hingeAtMin = s.hinge === "a";
      const left = along > 0 ? hingeAtMin : !hingeAtMin;
      s.operation = left ? "SINGLE_SWING_LEFT" : "SINGLE_SWING_RIGHT";
    }
  }
  // Door blocks without a swing (sliding, folding): the block's extent on its wall.
  const coveredBy = (run: number, s0: number, s1: number) => spans.some((x) => x.run === run && Math.min(x.s1, s1) - Math.max(x.s0, s0) > 0.3 * (s1 - s0));
  d.symbols.forEach((sym, k) => {
    if (!sym.bbox || roles[sym.layer] !== "door" || (sym.parent >= 0 && symbolRole(sym.parent) === "door")) return;
    const c: Pt = [(sym.bbox[0] + sym.bbox[2]) / 2, (sym.bbox[1] + sym.bbox[3]) / 2];
    if (!inRegion(c[0], c[1])) return;
    if (swings.some(({ a }) => a.symbol === k)) return;
    const xDir: Pt = [sym.m[0], sym.m[1]];
    const L = Math.hypot(xDir[0], xDir[1]) || 1;
    const host = hostRun(runs, c, [xDir[0] / L, xDir[1] / L], 0.6 * U, 2.5 * U);
    if (!host) return;
    const r = runs[host.run];
    const xs = [sym.bbox[0], sym.bbox[2]],
      ys = [sym.bbox[1], sym.bbox[3]];
    let s0 = Infinity,
      s1 = -Infinity;
    for (const x of xs)
      for (const y of ys) {
        const s = r.dx * x + r.dy * y;
        s0 = Math.min(s0, s);
        s1 = Math.max(s1, s);
      }
    if ((s1 - s0) * scale < 0.4 || (s1 - s0) * scale > 4 || coveredBy(host.run, s0, s1)) return;
    spans.push({ run: host.run, s0, s1, kind: "door", swing: null, hinge: null, operation: "NOTDEFINED", name: sym.name });
  });
  // Windows: lines on window layers (or in window blocks) along a wall, inside its thickness.
  const winSegs: Pt[][] = [];
  for (let i = 0; i < n; i++) {
    if (d.segFlags[i] & F_DIM) continue;
    const layerRole = roles[d.segLayer[i]];
    const s = d.segSymbol[i];
    const isWin = layerRole === "window" || (s >= 0 && symbolRole(s) === "window");
    if (!isWin) continue;
    const a: Pt = [d.segs[i * 4], d.segs[i * 4 + 1]],
      b: Pt = [d.segs[i * 4 + 2], d.segs[i * 4 + 3]];
    if (!inRegion(a[0], a[1]) && !inRegion(b[0], b[1])) continue;
    winSegs.push([a, b]);
  }
  const winByRun = new Map<number, [number, number][]>();
  for (const [a, b] of winSegs) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.1 * U) continue;
    const dir: Pt = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const host = hostRun(runs, mid, dir, 0.05 * U, 3 * U, 0.09);
    if (!host) continue;
    const r = runs[host.run];
    const sa = r.dx * a[0] + r.dy * a[1],
      sb = r.dx * b[0] + r.dy * b[1];
    let list = winByRun.get(host.run);
    if (!list) winByRun.set(host.run, (list = []));
    list.push([Math.min(sa, sb), Math.max(sa, sb)]);
  }
  for (const [run, list] of winByRun) {
    list.sort((p, q) => p[0] - q[0]);
    let cur: [number, number] | null = null;
    const flush = () => {
      if (cur && (cur[1] - cur[0]) * scale >= 0.25 && !coveredBy(run, cur[0], cur[1])) spans.push({ run, s0: cur[0], s1: cur[1], kind: "window", swing: null, hinge: null, operation: null, name: null });
    };
    for (const iv of list) {
      if (cur && iv[0] <= cur[1] + 0.05 * U) cur[1] = Math.max(cur[1], iv[1]);
      else {
        flush();
        cur = [iv[0], iv[1]];
      }
    }
    flush();
  }

  // --- Gaps: runs on one line with a gap between them join through it; an opening in the gap fits it exactly.
  const order = runs.map((_, i) => i).sort((a, b) => runs[a].th - runs[b].th || runs[a].o - runs[b].o || runs[a].s0 - runs[b].s0);
  const angTol = (0.5 * Math.PI) / 180;
  const pointInWall = (p: Pt, except: number) =>
    runs.some((r, k) => {
      if (k === except || r.dead) return false;
      const off = Math.abs(-r.dy * p[0] + r.dx * p[1] - r.o);
      const s = r.dx * p[0] + r.dy * p[1];
      return off <= r.t / 2 + 0.01 * U && s >= r.s0 - 0.01 * U && s <= r.s1 + 0.01 * U;
    });
  // Window lines across a gap when the drawing has no window layers (on a wall layer: lines along the wall only, e.g. pictures read with one pen).
  const gapHasLines = (run: Run, s0: number, s1: number) => {
    if (hasWindowLayer) return false;
    let covered = 0;
    for (let i = 0; i < n; i++) {
      const role = roles[d.segLayer[i]];
      if (role === "ignore" || role === "door" || d.segFlags[i] & F_DIM) continue;
      const a: Pt = [d.segs[i * 4], d.segs[i * 4 + 1]],
        b: Pt = [d.segs[i * 4 + 2], d.segs[i * 4 + 3]];
      if (role === "wall") {
        if (d.segFlags[i] & F_CURVE) continue;
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 1e-9 || Math.abs((b[0] - a[0]) * run.dx + (b[1] - a[1]) * run.dy) / L < Math.cos((3 * Math.PI) / 180)) continue;
      }
      const offA = -run.dy * a[0] + run.dx * a[1] - run.o,
        offB = -run.dy * b[0] + run.dx * b[1] - run.o;
      if (Math.abs(offA) > run.t / 2 + 0.02 * U || Math.abs(offB) > run.t / 2 + 0.02 * U) continue;
      const sa = run.dx * a[0] + run.dy * a[1],
        sb = run.dx * b[0] + run.dy * b[1];
      const lo = Math.max(s0, Math.min(sa, sb)),
        hi = Math.min(s1, Math.max(sa, sb));
      if (hi > lo) covered = Math.max(covered, hi - lo);
    }
    return covered >= 0.8 * (s1 - s0);
  };
  // A wall running into the gap from the side, its centre line ending there (a T-junction a little wider than the wall that meets it).
  const junctionInGap = (p: Run, g0: number, g1: number) =>
    runs.some((r) => {
      if (r.dead || Math.abs(r.dx * p.dx + r.dy * p.dy) > 0.5) return false;
      if (r.t < 0.45 * (g1 - g0)) return false;
      // Where r's centre line crosses p's.
      const den = r.dx * p.dy - r.dy * p.dx;
      if (Math.abs(den) < 1e-9) return false;
      const ra = at(r, 0),
        pa = at(p, 0);
      const k = ((pa[0] - ra[0]) * p.dy - (pa[1] - ra[1]) * p.dx) / den;
      const x: Pt = [ra[0] + r.dx * k, ra[1] + r.dy * k];
      const sp = p.dx * x[0] + p.dy * x[1];
      if (sp < g0 - 0.02 * U || sp > g1 + 0.02 * U) return false;
      const sr = r.dx * x[0] + r.dy * x[1];
      const reach = p.t / 2 + 0.06 * U;
      return Math.min(Math.abs(sr - r.s0), Math.abs(sr - r.s1)) <= reach || (sr >= r.s0 && sr <= r.s1);
    });
  // Another run on the same line inside the gap: the two runs are not neighbours (yet).
  const runInGap = (p: Run, pi: number, qi: number, g0: number, g1: number) =>
    runs.some((r, k) => {
      if (k === pi || k === qi || r.dead || Math.abs(r.dx * p.dx + r.dy * p.dy) < Math.cos(angTol)) return false;
      const c = at(r, (r.s0 + r.s1) / 2);
      if (Math.abs(-p.dy * c[0] + p.dx * c[1] - p.o) > Math.max(0.01 * U, 0.15 * Math.min(p.t, r.t))) return false;
      const a = at(r, r.s0),
        b = at(r, r.s1);
      const rs0 = Math.min(p.dx * a[0] + p.dy * a[1], p.dx * b[0] + p.dy * b[1]),
        rs1 = Math.max(p.dx * a[0] + p.dy * a[1], p.dx * b[0] + p.dy * b[1]);
      return rs0 < g1 - 1e-6 * U && rs1 > g0 + 1e-6 * U;
    });
  for (let pass = 0, changed = true; changed && pass < 6; pass++) {
    changed = false;
    for (let x = 0; x < order.length; x++) {
      const p = runs[order[x]];
      if (p.dead) continue;
      for (let y = x + 1; y < order.length; y++) {
        const q = runs[order[y]];
        if (q.th - p.th > angTol) break;
        if (q.dead) continue;
        const c = at(q, (q.s0 + q.s1) / 2);
        const o = -p.dy * c[0] + p.dx * c[1];
        if (Math.abs(o - p.o) > Math.max(0.01 * U, 0.15 * Math.min(p.t, q.t))) continue;
        if (Math.abs(p.t - q.t) > Math.max(0.02 * U, 0.15 * Math.max(p.t, q.t))) continue;
        const a = at(q, q.s0),
          b = at(q, q.s1);
        const qs0 = Math.min(p.dx * a[0] + p.dy * a[1], p.dx * b[0] + p.dy * b[1]),
          qs1 = Math.max(p.dx * a[0] + p.dy * a[1], p.dx * b[0] + p.dy * b[1]);
        // The space between the two runs, whichever comes first along the line.
        const g0 = qs0 >= p.s1 ? p.s1 : qs1 <= p.s0 ? qs1 : 0,
          g1 = qs0 >= p.s1 ? qs0 : qs1 <= p.s0 ? p.s0 : 0;
        const gap = g1 - g0;
        if (gap > 4.5 * U) continue;
        const pi = order[x],
          qi = order[y];
        if (gap > 0 && runInGap(p, pi, qi, g0, g1)) continue;
        if (gap > 0) {
          const inGap = spans.filter((s) => (s.run === pi || s.run === qi) && Math.min(s.s1, g1) - Math.max(s.s0, g0) > 0.4 * gap);
          let take = false;
          if (inGap.length) {
            // The opening fits the gap: jamb to jamb.
            inGap.sort((s, t) => (t.kind === "door" ? 1 : 0) - (s.kind === "door" ? 1 : 0));
            const best = inGap[0];
            const leaves = inGap.filter((s) => s.kind === "door" && s.arcs);
            if (leaves.length >= 2) {
              // Two leaves hinged at the two jambs: a double door.
              const same = leaves[0].swing && leaves[1].swing && leaves[0].swing[0] * leaves[1].swing[0] + leaves[0].swing[1] * leaves[1].swing[1] > 0;
              best.hinge = "both";
              best.operation = same ? "DOUBLE_DOOR_SINGLE_SWING" : "DOUBLE_DOOR_DOUBLE_SWING";
              best.arcs = 2;
            }
            best.run = pi;
            best.s0 = g0;
            best.s1 = g1;
            for (const other of inGap) {
              if (other !== best) other.run = -1;
            }
            take = true;
          } else if (gap * scale < 0.25 || pointInWall(at(p, (g0 + g1) / 2), -1) || junctionInGap(p, g0, g1)) take = true;
          else if (gapHasLines(p, g0, g1)) {
            spans.push({ run: pi, s0: g0, s1: g1, kind: "window", swing: null, hinge: null, operation: null, name: null });
            take = true;
          } else if (gap * scale <= 2.0) {
            spans.push({ run: pi, s0: g0, s1: g1, kind: "opening", swing: null, hinge: null, operation: null, name: null });
            take = true;
          }
          if (!take) continue;
        }
        // Join q into p.
        for (const s of spans) if (s.run === qi) s.run = pi;
        p.s0 = Math.min(p.s0, qs0);
        p.s1 = Math.max(p.s1, qs1);
        p.t = Math.max(p.t, q.t);
        q.dead = true;
        changed = true;
      }
    }
  }
  const live = runs.map((r, i) => (r.dead ? -1 : i));
  const index = new Map<number, number>();
  const finalRuns: Run[] = [];
  live.forEach((i) => {
    if (i < 0) return;
    index.set(i, finalRuns.length);
    finalRuns.push(runs[i]);
  });

  // --- Joins at corners and T-junctions
  const walls: RecWall[] = finalRuns.map((r) => ({ a: at(r, r.s0), b: at(r, r.s1), t: r.t, source: r.source }));
  const minLen = 0.05 * U;
  {
    const ends: { w: number; end: "a" | "b" }[] = [];
    walls.forEach((_, i) => ends.push({ w: i, end: "a" }, { w: i, end: "b" }));
    const moves: { w: number; end: "a" | "b"; p: Pt }[] = [];
    for (const { w, end } of ends) {
      const s = walls[w];
      const p = s[end],
        other = end === "a" ? s.b : s.a;
      const L = Math.hypot(p[0] - other[0], p[1] - other[1]) || 1;
      const u: Pt = [(p[0] - other[0]) / L, (p[1] - other[1]) / L];
      let best: { t: number; ext: number } | null = null;
      for (let j = 0; j < walls.length; j++) {
        if (j === w) continue;
        const o = walls[j];
        const Lo = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) || 1;
        const e: Pt = [(o.b[0] - o.a[0]) / Lo, (o.b[1] - o.a[1]) / Lo];
        if (Math.abs(u[0] * e[0] + u[1] * e[1]) > 0.94) continue;
        const den = u[0] * e[1] - u[1] * e[0];
        if (Math.abs(den) < 1e-9) continue;
        const t = ((o.a[0] - p[0]) * e[1] - (o.a[1] - p[1]) * e[0]) / den;
        const limit = o.t / 2 + s.t / 2 + 0.06 * U;
        if (t < -limit - s.t || t > limit) continue;
        const x = p[0] + u[0] * t,
          y = p[1] + u[1] * t;
        const along = (x - o.a[0]) * e[0] + (y - o.a[1]) * e[1];
        if (along < -limit || along > Lo + limit) continue;
        // At another wall's end: a corner, filled to the outer face. Along it: a T, up to its centre line.
        const nearEnd = along < s.t / 2 + 0.06 * U || along > Lo - s.t / 2 - 0.06 * U;
        if (!best || Math.abs(t) < Math.abs(best.t)) best = { t, ext: nearEnd ? o.t / 2 : 0 };
      }
      if (best) moves.push({ w, end, p: [p[0] + u[0] * (best.t + best.ext), p[1] + u[1] * (best.t + best.ext)] });
    }
    for (const m of moves) walls[m.w][m.end] = m.p;
  }

  // Openings onto the final walls.
  const openings: RecOpening[] = [];
  for (const s of spans) {
    if (s.run < 0) continue;
    const w = index.get(s.run);
    if (w === undefined) continue;
    const r = finalRuns[w];
    if ((s.s1 - s.s0) * scale < 0.2) continue;
    const a = at(r, s.s0),
      b = at(r, s.s1);
    // Hinge relative to the final wall direction (a -> b follows s).
    openings.push({ kind: s.kind, a, b, wall: w, swing: s.swing, hinge: s.hinge, operation: s.operation, name: s.name });
  }
  const wallsAll = walls.filter((w) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) >= minLen);
  // Re-index openings after dropping very short walls.
  const keep = walls.map((w) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) >= minLen);
  const remap: number[] = [];
  let next = 0;
  keep.forEach((k, i) => (remap[i] = k ? next++ : -1));
  const openingsAll = openings.filter((o) => remap[o.wall] >= 0).map((o) => ({ ...o, wall: remap[o.wall] }));
  wallsAll.push(...curved);

  // --- Columns
  const columns: RecColumn[] = [];
  const colOk = (size: number) => size * scale >= 0.1 && size * scale <= 2.5;
  for (const a of d.arcs) {
    if (roles[a.layer] !== "column" || a.flags & F_DIM || a.a1 - a.a0 < TAU - 1e-6 || !inRegion(a.c[0], a.c[1])) continue;
    if (colOk(2 * a.r)) columns.push({ ring: null, circle: { c: a.c, r: a.r } });
  }
  const colRings: Pt[][] = [];
  for (const p of d.polys) if (roles[p.layer] === "column" && !(p.flags & F_DIM)) colRings.push(p.points);
  for (const f of d.fills) if (roles[f.layer] === "column" && !(f.flags & F_DIM)) colRings.push(f.rings[0]);
  for (const ring of colRings) {
    const b = ringBox(ring);
    if (!inRegion((b[0] + b[2]) / 2, (b[1] + b[3]) / 2) || !colOk(Math.max(b[2] - b[0], b[3] - b[1])) || (Math.min(b[2] - b[0], b[3] - b[1]) * scale) < 0.08) continue;
    columns.push({ ring, circle: null });
  }
  // One column per position: circles first, then the larger outline.
  const colCentre = (c: RecColumn): Pt => (c.circle ? c.circle.c : centroid(c.ring!));
  const colSize = (c: RecColumn) => (c.circle ? Math.PI * c.circle.r * c.circle.r : Math.abs(ringArea(c.ring!)));
  columns.sort((a, b) => (a.circle ? 0 : 1) - (b.circle ? 0 : 1) || colSize(b) - colSize(a));
  const colsUnique: RecColumn[] = [];
  for (const c of columns) {
    const p = colCentre(c);
    if (colsUnique.some((q) => Math.hypot(colCentre(q)[0] - p[0], colCentre(q)[1] - p[1]) < 0.1 * U)) continue;
    colsUnique.push(c);
  }
  // Column blocks with no outline of their own.
  d.symbols.forEach((sym) => {
    if (!sym.bbox || roles[sym.layer] !== "column") return;
    const c: Pt = [(sym.bbox[0] + sym.bbox[2]) / 2, (sym.bbox[1] + sym.bbox[3]) / 2];
    if (!inRegion(c[0], c[1]) || colsUnique.some((q) => Math.hypot(colCentre(q)[0] - c[0], colCentre(q)[1] - c[1]) < 0.1 * U)) return;
    const [x0, y0, x1, y1] = sym.bbox;
    if (!colOk(Math.max(x1 - x0, y1 - y0))) return;
    colsUnique.push({ ring: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], circle: null });
  });

  // --- Rooms and the outline
  const roomTexts = d.texts.filter((t) => {
    if (t.flags & F_DIM || !inRegion(t.c[0], t.c[1])) return false;
    const role = roles[t.layer];
    return role === "room" || role === "text";
  });
  const labelTexts = roomTexts.length ? roomTexts : d.texts.filter((t) => !(t.flags & F_DIM) && roles[t.layer] !== "ignore" && inRegion(t.c[0], t.c[1]));
  const rooms: RecRoom[] = [];
  const boundaryRings: Pt[][] = [];
  for (const p of d.polys) if (roles[p.layer] === "room" && !(p.flags & F_DIM)) boundaryRings.push(p.points);
  for (const f of d.fills) if (roles[f.layer] === "room" && !(f.flags & F_DIM)) boundaryRings.push(f.rings[0]);
  for (const ring of boundaryRings) {
    const area = Math.abs(ringArea(ring)) * scale * scale;
    const c = centroid(ring);
    if (area < 1 || area > 20000 || !inRegion(c[0], c[1])) continue;
    if (rooms.some((r) => Math.abs(r.area - area) < 0.01 * area && Math.hypot(centroid(r.ring)[0] - c[0], centroid(r.ring)[1] - c[1]) < 0.05 * U)) continue;
    rooms.push({ ring, name: null, number: null, area, source: "outline" });
  }

  const closers: [Pt, Pt][] = [...winSegs.map((sg) => [sg[0], sg[1]] as [Pt, Pt]), ...unpaired.map((l) => [at(l, l.s0), at(l, l.s1)] as [Pt, Pt])];
  const found = findRooms(wallsAll, colsUnique, closers, labelTexts.map((t) => ({ c: t.c, text: t.text, h: t.h })), scale, { fromWalls: options.rooms, rooms });
  rooms.length = 0;
  rooms.push(...found.rooms);
  const outline = found.outline;

  if (wallSegCount === 0 && wallFillRings.length === 0 && !d.strips.some((s) => roles[s.layer] === "wall")) warnings.push("No lines on wall layers: choose which layers hold the walls.");
  else if (!wallsAll.length) warnings.push("No walls found on the wall layers: check the units and the thickness range.");
  if (singleOn && options.singleLines === "auto") warnings.push("Walls are drawn as single lines: each line became a wall of the default thickness.");
  return {
    walls: wallsAll,
    openings: openingsAll,
    columns: colsUnique,
    rooms,
    outline,
    warnings,
    stats: { wallLines: wallSegCount, pairedShare, fillChecked, singleLines: singleOn, seconds: (Date.now() - started) / 1000 },
  };
}
