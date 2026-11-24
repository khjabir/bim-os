// AutoCAD DXF reader: ASCII and binary DXF of every release (R12 to 2018 and
// later), in the browser, without dependencies. It reads what a floor plan
// needs: the header units, layers, blocks and the model-space entities.
// Block references, dimensions and hatches are kept as they are; vector.ts
// explodes and flattens them.
//
// The file is read as a stream of (group code, value) pairs, gathered into
// records (everything between two code-0 pairs), so memory stays close to the
// size of the entities themselves even for large files.

export type V2 = [number, number];
export type V3 = [number, number, number];

export interface DxfLayer {
  name: string;
  /** AutoCAD colour index (1..255); 7 is black/white. */
  color: number;
  /** 0xRRGGBB when the layer has a true colour. */
  trueColor: number | null;
  off: boolean;
  frozen: boolean;
  linetype: string;
}

interface Common {
  layer: string;
  /** Colour index: 0 BYBLOCK, 256 BYLAYER (the default), 1..255. */
  color: number;
  trueColor: number | null;
  /** Normal of the entity's plane (OCS) when it is not +Z. */
  normal: V3 | null;
}

export interface DxfLine extends Common {
  type: "LINE";
  a: V3;
  b: V3;
}
export interface DxfPolyline extends Common {
  type: "POLYLINE";
  /** OCS points (x, y, elevation) unless `wcs`. */
  points: V3[];
  /** Bulge of the segment that starts at each point (tan of a quarter of the arc's angle). */
  bulges: number[];
  closed: boolean;
  /** Line width (0 for thin lines). */
  width: number;
  /** 3D polylines and MLINE elements hold WCS points. */
  wcs: boolean;
}
export interface DxfArc extends Common {
  type: "ARC";
  c: V3;
  r: number;
  /** Degrees, counter-clockwise in the OCS. */
  start: number;
  end: number;
}
export interface DxfCircle extends Common {
  type: "CIRCLE";
  c: V3;
  r: number;
}
export interface DxfEllipse extends Common {
  type: "ELLIPSE";
  /** WCS centre and end point of the major axis relative to it. */
  c: V3;
  major: V3;
  ratio: number;
  /** Parameters in radians. */
  start: number;
  end: number;
}
export interface DxfSpline extends Common {
  type: "SPLINE";
  degree: number;
  knots: number[];
  control: V3[];
  weights: number[];
  fit: V3[];
  closed: boolean;
}
export interface DxfText extends Common {
  type: "TEXT";
  /** Insertion point (OCS for TEXT / ATTRIB, WCS for MTEXT). */
  p: V3;
  /** Alignment point when the text is justified (TEXT / ATTRIB). */
  align: V3 | null;
  h: number;
  /** Degrees. */
  rotation: number;
  text: string;
  /** Horizontal justification 0 left, 1 centre, 2 right, 3 aligned, 4 middle, 5 fit; vertical 0 baseline, 1 bottom, 2 middle, 3 top. */
  hAlign: number;
  vAlign: number;
  widthFactor: number;
  /** MTEXT: attachment point 1..9 (top-left .. bottom-right), the text's x axis (WCS) and the frame width. */
  mtext: { attach: number; xDir: V3 | null; width: number } | null;
  /** ATTRIB: the attribute's tag. */
  tag?: string;
}
export interface DxfInsert extends Common {
  type: "INSERT";
  block: string;
  p: V3;
  scale: V3;
  /** Degrees. */
  rotation: number;
  cols: number;
  rows: number;
  colSpacing: number;
  rowSpacing: number;
  attribs: DxfText[];
}
export interface DxfDimension extends Common {
  type: "DIMENSION";
  /** Anonymous block holding the dimension's lines, arrows and text (WCS). */
  block: string;
  text: string;
  measurement: number | null;
}
export type HatchEdge =
  | { kind: "line"; a: V2; b: V2 }
  /** Angles in degrees, always counter-clockwise from start to end; `ccw` false means the boundary runs the other way. */
  | { kind: "arc"; c: V2; r: number; start: number; end: number; ccw: boolean }
  /** As arcs; the angles are true angles (not ellipse parameters). */
  | { kind: "ellipse"; c: V2; major: V2; ratio: number; start: number; end: number; ccw: boolean }
  | { kind: "spline"; degree: number; knots: number[]; control: V2[]; weights: number[]; fit: V2[] };
export interface DxfHatch extends Common {
  type: "HATCH";
  pattern: string;
  solid: boolean;
  /** OCS elevation of the hatch plane. */
  elevation: number;
  loops: HatchEdge[][];
}
export interface DxfSolid extends Common {
  type: "SOLID";
  /** Corner points in drawing order (3 or 4). SOLID / TRACE in OCS, 3DFACE in WCS. */
  points: V3[];
  wcs: boolean;
}

export type DxfEntity = DxfLine | DxfPolyline | DxfArc | DxfCircle | DxfEllipse | DxfSpline | DxfText | DxfInsert | DxfDimension | DxfHatch | DxfSolid;

export interface DxfBlock {
  name: string;
  base: V3;
  flags: number;
  /** External reference: its content is not in this file. */
  xref: boolean;
  entities: DxfEntity[];
}

export interface DxfFile {
  version: string;
  /** $INSUNITS (0 unitless, 1 inches, 4 millimetres, 6 metres, …). */
  insUnits: number;
  /** $MEASUREMENT: 0 imperial, 1 metric, null when absent. */
  measurement: number | null;
  layers: Map<string, DxfLayer>;
  blocks: Map<string, DxfBlock>;
  /** Model-space entities. */
  entities: DxfEntity[];
  binary: boolean;
  /** Entity types met and left out (with counts), for the report. */
  skipped: Record<string, number>;
  /** Paper-space entities left out. */
  paperSpace: number;
}

/** Metres per drawing unit for an $INSUNITS code; null when unitless or unknown. */
export function unitsToMetres(code: number): number | null {
  const table: Record<number, number> = {
    1: 0.0254,
    2: 0.3048,
    3: 1609.344,
    4: 0.001,
    5: 0.01,
    6: 1,
    7: 1000,
    8: 0.0254e-6,
    9: 0.0254e-3,
    10: 0.9144,
    11: 1e-10,
    12: 1e-9,
    13: 1e-6,
    14: 0.1,
    15: 10,
    16: 100,
    17: 1e9,
    21: 1200 / 3937,
    22: 1 / 39.37,
    23: 3600 / 3937,
    24: 6336000 / 3937,
  };
  return table[code] ?? null;
}

export const UNIT_LABELS: Record<number, string> = {
  0: "unitless",
  1: "inches",
  2: "feet",
  4: "millimetres",
  5: "centimetres",
  6: "metres",
  7: "kilometres",
  10: "yards",
  14: "decimetres",
  21: "US survey feet",
};

// ---------------------------------------------------------------------------
// Pair readers

type Value = string | number;

interface PairReader {
  code: number;
  value: Value;
  next(): boolean;
  /** Called once the header has told the release and code page (binary strings). */
  setEncoding?(label: string): void;
}

class AsciiReader implements PairReader {
  code = -1;
  value: Value = "";
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
    if (text.charCodeAt(0) === 0xfeff) this.pos = 1;
  }
  next(): boolean {
    const t = this.text;
    for (;;) {
      if (this.pos >= t.length) return false;
      let e = t.indexOf("\n", this.pos);
      if (e < 0) e = t.length;
      const code = parseInt(t.slice(this.pos, e), 10);
      let e2 = t.indexOf("\n", e + 1);
      if (e2 < 0) e2 = t.length;
      let value = t.slice(e + 1, e2);
      if (value.endsWith("\r")) value = value.slice(0, -1);
      this.pos = e2 + 1;
      if (Number.isNaN(code)) {
        // A blank line at the end, or a broken pair: skip it.
        if (this.pos >= t.length) return false;
        continue;
      }
      this.code = code;
      this.value = value;
      return true;
    }
  }
}

const BINARY_SENTINEL = "AutoCAD Binary DXF\r\n\x1a\x00";

function isBinaryDxf(bytes: Uint8Array) {
  if (bytes.length < 22) return false;
  for (let i = 0; i < 22; i++) if (bytes[i] !== BINARY_SENTINEL.charCodeAt(i)) return false;
  return true;
}

function binaryKind(code: number): "str" | "f64" | "i16" | "i32" | "i64" | "bool" | "bin" {
  if (code <= 9) return "str";
  if (code <= 59) return "f64";
  if (code <= 79) return "i16";
  if (code <= 99) return "i32";
  if (code === 100 || code === 102 || code === 105) return "str";
  if (code >= 110 && code <= 149) return "f64";
  if (code >= 160 && code <= 169) return "i64";
  if (code >= 170 && code <= 179) return "i16";
  if (code >= 210 && code <= 239) return "f64";
  if (code >= 270 && code <= 289) return "i16";
  if (code >= 290 && code <= 299) return "bool";
  if (code >= 300 && code <= 309) return "str";
  if (code >= 310 && code <= 319) return "bin";
  if (code >= 320 && code <= 369) return "str";
  if (code >= 370 && code <= 389) return "i16";
  if (code >= 390 && code <= 399) return "str";
  if (code >= 400 && code <= 409) return "i16";
  if (code >= 410 && code <= 419) return "str";
  if (code >= 420 && code <= 429) return "i32";
  if (code >= 430 && code <= 439) return "str";
  if (code >= 440 && code <= 459) return "i32";
  if (code >= 460 && code <= 469) return "f64";
  if (code >= 470 && code <= 481) return "str";
  if (code === 999) return "str";
  if (code === 1004) return "bin";
  if (code >= 1000 && code <= 1009) return "str";
  if (code >= 1010 && code <= 1059) return "f64";
  if (code >= 1060 && code <= 1070) return "i16";
  if (code === 1071) return "i32";
  return "str";
}

class BinaryReader implements PairReader {
  code = -1;
  value: Value = "";
  private pos = 22;
  private readonly view: DataView;
  private readonly wideCodes: boolean;
  private decoder = new TextDecoder("latin1");
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // R13+ writes 2-byte group codes; R12 one byte (255 escapes a 2-byte code).
    this.wideCodes = bytes[22] === 0 && bytes[23] === 0;
  }
  setEncoding(label: string) {
    try {
      this.decoder = new TextDecoder(label);
    } catch {
      /* keep latin1 */
    }
  }
  next(): boolean {
    const b = this.bytes;
    if (this.pos >= b.length) return false;
    let code: number;
    if (this.wideCodes) {
      if (this.pos + 2 > b.length) return false;
      code = this.view.getUint16(this.pos, true);
      this.pos += 2;
    } else {
      code = b[this.pos++];
      if (code === 255) {
        code = this.view.getUint16(this.pos, true);
        this.pos += 2;
      }
    }
    const kind = binaryKind(code);
    switch (kind) {
      case "str": {
        let end = this.pos;
        while (end < b.length && b[end] !== 0) end++;
        this.value = this.decoder.decode(b.subarray(this.pos, end));
        this.pos = end + 1;
        break;
      }
      case "f64":
        this.value = this.view.getFloat64(this.pos, true);
        this.pos += 8;
        break;
      case "i16":
        this.value = this.view.getInt16(this.pos, true);
        this.pos += 2;
        break;
      case "i32":
        this.value = this.view.getInt32(this.pos, true);
        this.pos += 4;
        break;
      case "i64":
        this.value = Number(this.view.getBigInt64(this.pos, true));
        this.pos += 8;
        break;
      case "bool":
        this.value = b[this.pos];
        this.pos += 1;
        break;
      case "bin": {
        const n = b[this.pos];
        this.value = "";
        this.pos += 1 + n;
        break;
      }
    }
    this.code = code;
    return this.pos <= b.length;
  }
}

// ---------------------------------------------------------------------------
// Records: a code-0 pair and everything up to the next one

interface Rec {
  type: string;
  codes: number[];
  values: Value[];
}

class Records {
  private pending: string | null = null;
  private started = false;
  private readonly reader: PairReader;
  constructor(reader: PairReader) {
    this.reader = reader;
  }
  next(): Rec | null {
    const r = this.reader;
    if (!this.started) {
      this.started = true;
      // Skip anything before the first code-0 pair (comments, junk).
      for (;;) {
        if (!r.next()) return null;
        if (r.code === 0) {
          this.pending = String(r.value).trim();
          break;
        }
      }
    }
    if (this.pending === null) return null;
    const type = this.pending;
    const codes: number[] = [];
    const values: Value[] = [];
    this.pending = null;
    while (r.next()) {
      if (r.code === 0) {
        this.pending = String(r.value).trim();
        break;
      }
      if (r.code === 999) continue;
      codes.push(r.code);
      values.push(r.value);
    }
    return { type, codes, values };
  }
}

const num = (v: Value | undefined, fallback = 0): number => {
  if (v === undefined) return fallback;
  if (typeof v === "number") return v;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};
const int = (v: Value | undefined, fallback = 0): number => {
  if (v === undefined) return fallback;
  if (typeof v === "number") return Math.trunc(v);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: Value | undefined, fallback = ""): string => (v === undefined ? fallback : String(v));

function first(rec: Rec, code: number): Value | undefined {
  const i = rec.codes.indexOf(code);
  return i >= 0 ? rec.values[i] : undefined;
}

function point(rec: Rec, xCode: number): V3 {
  return [num(first(rec, xCode)), num(first(rec, xCode + 10)), num(first(rec, xCode + 20))];
}

function normalOf(rec: Rec): V3 | null {
  const i = rec.codes.indexOf(210);
  if (i < 0) return null;
  const n: V3 = [num(rec.values[i]), num(first(rec, 220)), num(first(rec, 230), 1)];
  if (Math.abs(n[0]) < 1e-9 && Math.abs(n[1]) < 1e-9 && n[2] > 0) return null;
  const L = Math.hypot(n[0], n[1], n[2]);
  return L > 0 ? [n[0] / L, n[1] / L, n[2] / L] : null;
}

function common(rec: Rec): Common {
  const tc = first(rec, 420);
  return {
    layer: str(first(rec, 8), "0").trim() || "0",
    color: int(first(rec, 62), 256),
    trueColor: tc === undefined ? null : int(tc) & 0xffffff,
    normal: normalOf(rec),
  };
}

// ---------------------------------------------------------------------------
// Text clean-up

/** Plain text of an MTEXT string: formatting codes removed, paragraphs as "\n". */
export function mtextPlain(raw: string): string {
  let s = raw;
  s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\M\+\d[0-9A-Fa-f]{4}/g, "");
  // Stacked fractions: \S1/2; or \S1^2; or \S1#2;
  s = s.replace(/\\S([^;]*?)[\^/#]([^;]*?);/g, "$1/$2");
  // Codes with a ';'-terminated argument.
  s = s.replace(/\\[ACcFfHhQqTtWwp][^;\\]*;/g, "");
  s = s.replace(/\\P/g, "\n").replace(/\\X/g, "\n");
  s = s.replace(/\\~/g, " ");
  s = s.replace(/\\[LlOoKkNn]/g, "");
  s = s.replace(/\\\\/g, "\u0000").replace(/\\\{/g, "\u0001").replace(/\\\}/g, "\u0002");
  s = s.replace(/[{}]/g, "");
  s = s.replace(/\u0000/g, "\\").replace(/\u0001/g, "{").replace(/\u0002/g, "}");
  return s.replace(/[ \t]+\n/g, "\n").trim();
}

/** Plain text of a TEXT / ATTRIB string: %% codes and \U+ escapes resolved. */
export function textPlain(raw: string): string {
  return raw
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%[cC]/g, "Ø")
    .replace(/%%[dD]/g, "°")
    .replace(/%%[pP]/g, "±")
    .replace(/%%[uUoOkK]/g, "")
    .replace(/%%(\d{3})/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/%%%/g, "%")
    .trim();
}

// ---------------------------------------------------------------------------
// Entities

function lwPolyline(rec: Rec): DxfPolyline {
  const points: V3[] = [];
  const bulges: number[] = [];
  const elevation = num(first(rec, 38));
  let width = num(first(rec, 43));
  let maxWidth = 0;
  for (let i = 0; i < rec.codes.length; i++) {
    const c = rec.codes[i];
    if (c === 10) {
      points.push([num(rec.values[i]), 0, elevation]);
      bulges.push(0);
    } else if (c === 20 && points.length) points[points.length - 1][1] = num(rec.values[i]);
    else if (c === 42 && points.length) bulges[bulges.length - 1] = num(rec.values[i]);
    else if ((c === 40 || c === 41) && points.length) maxWidth = Math.max(maxWidth, num(rec.values[i]));
  }
  if (!(width > 0)) width = maxWidth;
  return { type: "POLYLINE", ...common(rec), points, bulges, closed: (int(first(rec, 70)) & 1) === 1, width, wcs: false };
}

function arcEdgeAngles(start: number, end: number, ccw: boolean): { start: number; end: number } {
  // Clockwise edges are stored with complementary angles (360 - a); turn them
  // into the counter-clockwise arc they cover.
  return ccw ? { start, end } : { start: 360 - end, end: 360 - start };
}

function hatch(rec: Rec): DxfHatch {
  const { codes, values } = rec;
  let i = 0;
  const n = codes.length;
  const at = (code: number) => (i < n && codes[i] === code ? values[i++] : undefined);
  let pattern = "";
  let solid = false;
  let elevation = 0;
  const loops: HatchEdge[][] = [];
  // Header up to the loop count.
  for (; i < n; i++) {
    const c = codes[i];
    if (c === 30) elevation = num(values[i]);
    else if (c === 2) pattern = str(values[i]).trim();
    else if (c === 70) solid = int(values[i]) === 1;
    else if (c === 91) {
      i++;
      break;
    }
  }
  const loopCount = int(values[i - 1]);
  for (let l = 0; l < loopCount && i < n; l++) {
    // Seek the loop's type flags.
    while (i < n && codes[i] !== 92) i++;
    if (i >= n) break;
    const flags = int(values[i++]);
    const edges: HatchEdge[] = [];
    if (flags & 2) {
      // Polyline loop.
      let hasBulge = 0;
      let closed = 1;
      let count = 0;
      for (; i < n; i++) {
        if (codes[i] === 72) hasBulge = int(values[i]);
        else if (codes[i] === 73) closed = int(values[i]);
        else if (codes[i] === 93) {
          count = int(values[i]);
          i++;
          break;
        } else break;
      }
      const pts: V2[] = [];
      const bulges: number[] = [];
      while (pts.length < count && i < n) {
        if (codes[i] === 10) {
          const x = num(values[i++]);
          const y = num(at(20));
          pts.push([x, y]);
          bulges.push(0);
          if (hasBulge && i < n && codes[i] === 42) bulges[bulges.length - 1] = num(values[i++]);
        } else i++;
      }
      // The boundary is closed whatever the flag says.
      void closed;
      const m = pts.length;
      for (let k = 0; k < m; k++) {
        const a = pts[k];
        const b = pts[(k + 1) % m];
        if (k === m - 1 && (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12)) continue;
        const bulge = bulges[k];
        if (Math.abs(bulge) > 1e-9) edges.push(bulgeEdge(a, b, bulge));
        else edges.push({ kind: "line", a, b });
      }
    } else {
      // Edge loop.
      while (i < n && codes[i] !== 93) i++;
      const count = int(values[i++]);
      for (let e = 0; e < count && i < n; e++) {
        while (i < n && codes[i] !== 72) i++;
        if (i >= n) break;
        const type = int(values[i++]);
        if (type === 1) {
          const a: V2 = [num(at(10)), num(at(20))];
          const b: V2 = [num(at(11)), num(at(21))];
          edges.push({ kind: "line", a, b });
        } else if (type === 2) {
          const c: V2 = [num(at(10)), num(at(20))];
          const r = num(at(40));
          const s = num(at(50));
          const t = num(at(51));
          const ccw = int(at(73), 1) !== 0;
          edges.push({ kind: "arc", c, r, ...arcEdgeAngles(s, t, ccw), ccw });
        } else if (type === 3) {
          const c: V2 = [num(at(10)), num(at(20))];
          const major: V2 = [num(at(11)), num(at(21))];
          const ratio = num(at(40), 1);
          const s = num(at(50));
          const t = num(at(51));
          const ccw = int(at(73), 1) !== 0;
          edges.push({ kind: "ellipse", c, major, ratio, ...arcEdgeAngles(s, t, ccw), ccw });
        } else if (type === 4) {
          const degree = int(at(94), 3);
          let rational = 0;
          let knotCount = 0;
          let ctrlCount = 0;
          for (; i < n; i++) {
            const c = codes[i];
            if (c === 73) rational = int(values[i]);
            else if (c === 74) continue;
            else if (c === 95) knotCount = int(values[i]);
            else if (c === 96) {
              ctrlCount = int(values[i]);
              i++;
              break;
            } else break;
          }
          const knots: number[] = [];
          while (knots.length < knotCount && i < n && codes[i] === 40) knots.push(num(values[i++]));
          const control: V2[] = [];
          const weights: number[] = [];
          while (control.length < ctrlCount && i < n && codes[i] === 10) {
            const x = num(values[i++]);
            control.push([x, num(at(20))]);
            if (i < n && codes[i] === 42) weights.push(num(values[i++]));
            else if (rational) weights.push(1);
          }
          const fit: V2[] = [];
          if (i < n && codes[i] === 97) {
            const fitCount = int(values[i++]);
            while (fit.length < fitCount && i < n && codes[i] === 11) {
              const x = num(values[i++]);
              fit.push([x, num(at(21))]);
            }
            // Tangents.
            while (i < n && (codes[i] === 12 || codes[i] === 22 || codes[i] === 13 || codes[i] === 23)) i++;
          }
          edges.push({ kind: "spline", degree, knots, control, weights: weights.length === control.length ? weights : [], fit });
        }
      }
    }
    // Source boundary objects.
    if (i < n && codes[i] === 97) {
      const count = int(values[i++]);
      for (let k = 0; k < count && i < n && codes[i] === 330; k++) i++;
    }
    if (edges.length) loops.push(edges);
  }
  return { type: "HATCH", ...common(rec), pattern, solid, elevation, loops };
}

/** An arc edge between two points from a polyline bulge. */
export function bulgeEdge(a: V2, b: V2, bulge: number): HatchEdge {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return { kind: "line", a, b };
  const theta = 4 * Math.atan(bulge); // signed included angle
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  // Centre: from the chord midpoint along the normal, on the side the arc bends away from.
  const mx = (a[0] + b[0]) / 2,
    my = (a[1] + b[1]) / 2;
  // Negative for arcs over 180°: the centre is then on the other side of the chord.
  const h = r * Math.cos(Math.abs(theta) / 2);
  const nx = -dy / chord,
    ny = dx / chord;
  const sign = bulge > 0 ? 1 : -1;
  const c: V2 = [mx + nx * h * sign, my + ny * h * sign];
  const angA = (Math.atan2(a[1] - c[1], a[0] - c[0]) * 180) / Math.PI;
  const angB = (Math.atan2(b[1] - c[1], b[0] - c[0]) * 180) / Math.PI;
  // Positive bulge: counter-clockwise from a to b.
  return bulge > 0 ? { kind: "arc", c, r, start: angA, end: angB, ccw: true } : { kind: "arc", c, r, start: angB, end: angA, ccw: false };
}

function text(rec: Rec, attrib: boolean): DxfText {
  const p = point(rec, 10);
  const hAlign = int(first(rec, 72));
  const vAlign = int(first(rec, attrib ? 74 : 73));
  const has11 = rec.codes.indexOf(11) >= 0;
  return {
    type: "TEXT",
    ...common(rec),
    p,
    align: (hAlign !== 0 || vAlign !== 0) && has11 ? point(rec, 11) : null,
    h: num(first(rec, 40), 1),
    rotation: num(first(rec, 50)),
    text: textPlain(str(first(rec, 1))),
    hAlign,
    vAlign,
    widthFactor: num(first(rec, 41), 1) || 1,
    mtext: null,
    tag: attrib ? str(first(rec, 2)) : undefined,
  };
}

function mtext(rec: Rec): DxfText {
  let raw = "";
  for (let i = 0; i < rec.codes.length; i++) if (rec.codes[i] === 3) raw += str(rec.values[i]);
  raw += str(first(rec, 1));
  const xi = rec.codes.indexOf(11);
  const xDir: V3 | null = xi >= 0 ? point(rec, 11) : null;
  // MTEXT stores its rotation in radians.
  const rot = num(first(rec, 50));
  return {
    type: "TEXT",
    ...common(rec),
    p: point(rec, 10),
    align: null,
    h: num(first(rec, 40), 1),
    rotation: xDir ? (Math.atan2(xDir[1], xDir[0]) * 180) / Math.PI : (rot * 180) / Math.PI,
    text: mtextPlain(raw),
    hAlign: 0,
    vAlign: 0,
    widthFactor: 1,
    mtext: { attach: int(first(rec, 71), 1), xDir, width: num(first(rec, 41)) },
  };
}

function spline(rec: Rec): DxfSpline {
  const knots: number[] = [];
  const control: V3[] = [];
  const weights: number[] = [];
  const fit: V3[] = [];
  for (let i = 0; i < rec.codes.length; i++) {
    const c = rec.codes[i];
    const v = rec.values[i];
    if (c === 40) knots.push(num(v));
    else if (c === 41) weights.push(num(v));
    else if (c === 10) control.push([num(v), 0, 0]);
    else if (c === 20 && control.length) control[control.length - 1][1] = num(v);
    else if (c === 30 && control.length) control[control.length - 1][2] = num(v);
    else if (c === 11) fit.push([num(v), 0, 0]);
    else if (c === 21 && fit.length) fit[fit.length - 1][1] = num(v);
    else if (c === 31 && fit.length) fit[fit.length - 1][2] = num(v);
  }
  const flags = int(first(rec, 70));
  return { type: "SPLINE", ...common(rec), degree: int(first(rec, 71), 3), knots, control, weights: weights.length === control.length ? weights : [], fit, closed: (flags & 1) === 1 };
}

/** MLINE: one polyline per element of its style, from the vertices, miters and element offsets. */
function mline(rec: Rec): DxfPolyline[] {
  const { codes, values } = rec;
  const flags = int(first(rec, 71));
  const elementCount = int(first(rec, 73));
  const verts: { p: V3; dir: V3; miter: V3; offsets: number[] }[] = [];
  let i = 0;
  const n = codes.length;
  for (; i < n; i++) {
    if (codes[i] !== 11) continue;
    const p: V3 = [num(values[i]), num(values[i + 1]), num(values[i + 2])];
    i += 3;
    const dir: V3 = [0, 0, 0];
    const miter: V3 = [0, 0, 0];
    if (codes[i] === 12) {
      dir[0] = num(values[i]);
      dir[1] = num(values[i + 1]);
      dir[2] = num(values[i + 2]);
      i += 3;
    }
    if (codes[i] === 13) {
      miter[0] = num(values[i]);
      miter[1] = num(values[i + 1]);
      miter[2] = num(values[i + 2]);
      i += 3;
    }
    const offsets: number[] = [];
    for (let e = 0; e < elementCount && i < n; e++) {
      while (i < n && codes[i] !== 74 && codes[i] !== 11) i++;
      if (i >= n || codes[i] !== 74) break;
      const paramCount = int(values[i++]);
      const params: number[] = [];
      for (let k = 0; k < paramCount && i < n && codes[i] === 41; k++) params.push(num(values[i++]));
      // The first parameter: distance from the vertex along the miter to the element's line.
      offsets.push(params[0] ?? 0);
      // Area fill parameters.
      if (i < n && codes[i] === 75) {
        const fills = int(values[i++]);
        for (let k = 0; k < fills && i < n && codes[i] === 42; k++) i++;
      }
    }
    verts.push({ p, dir, miter, offsets });
    i--;
  }
  const base = common(rec);
  const closed = (flags & 2) === 2;
  const out: DxfPolyline[] = [];
  for (let e = 0; e < elementCount; e++) {
    const points: V3[] = [];
    for (const v of verts) {
      const o = v.offsets[e] ?? 0;
      points.push([v.p[0] + v.miter[0] * o, v.p[1] + v.miter[1] * o, v.p[2] + v.miter[2] * o]);
    }
    if (points.length >= 2) out.push({ type: "POLYLINE", ...base, points, bulges: points.map(() => 0), closed, width: 0, wcs: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main

const CODE_PAGES: Record<string, string> = {
  ANSI_874: "windows-874",
  ANSI_932: "shift_jis",
  ANSI_936: "gbk",
  ANSI_949: "euc-kr",
  ANSI_950: "big5",
  ANSI_1250: "windows-1250",
  ANSI_1251: "windows-1251",
  ANSI_1252: "windows-1252",
  ANSI_1253: "windows-1253",
  ANSI_1254: "windows-1254",
  ANSI_1255: "windows-1255",
  ANSI_1256: "windows-1256",
  ANSI_1257: "windows-1257",
  ANSI_1258: "windows-1258",
};

/** Release and code page from the start of an ASCII file (read as Latin-1). */
function sniffHeader(latin: string): { version: string; codePage: string } {
  const head = latin.slice(0, 200000);
  const v = /\$ACADVER\s*\r?\n\s*1\s*\r?\n([^\r\n]*)/.exec(head);
  const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n([^\r\n]*)/.exec(head);
  return { version: v?.[1]?.trim() ?? "", codePage: cp?.[1]?.trim().toUpperCase() ?? "" };
}

/** R2007 (AC1021) and later files are UTF-8. */
const isUtf8Release = (version: string) => /^AC(\d{4})$/.test(version) && parseInt(version.slice(2), 10) >= 1021;

function decodeAscii(bytes: Uint8Array): { text: string; version: string } {
  const latin = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 200000)));
  const { version, codePage } = sniffHeader(latin);
  if (isUtf8Release(version)) return { text: new TextDecoder("utf-8").decode(bytes), version };
  // Older releases: the code page, unless the file is valid UTF-8 anyway (some exporters write UTF-8 regardless).
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), version };
  } catch {
    const label = CODE_PAGES[codePage] ?? "windows-1252";
    try {
      return { text: new TextDecoder(label).decode(bytes), version };
    } catch {
      return { text: new TextDecoder("windows-1252").decode(bytes), version };
    }
  }
}

export class DxfError extends Error {}

export function parseDxf(bytes: Uint8Array): DxfFile {
  const binary = isBinaryDxf(bytes);
  let reader: PairReader;
  let version = "";
  if (binary) reader = new BinaryReader(bytes);
  else {
    const decoded = decodeAscii(bytes);
    version = decoded.version;
    reader = new AsciiReader(decoded.text);
  }
  const records = new Records(reader);
  const file: DxfFile = { version, insUnits: 0, measurement: null, layers: new Map(), blocks: new Map(), entities: [], binary, skipped: {}, paperSpace: 0 };
  let sawSection = false;

  // Entity reading shared by BLOCKS and ENTITIES. `rec` is the record after
  // the last one consumed; returns the first record it did not consume.
  const readEntities = (start: Rec | null, sink: DxfEntity[], stopAt: Set<string>, modelSpaceOnly: boolean): Rec | null => {
    let rec = start;
    while (rec && !stopAt.has(rec.type)) {
      const type = rec.type;
      if (type === "POLYLINE") {
        const head = rec;
        const flags = int(first(head, 70));
        const points: V3[] = [];
        const bulges: number[] = [];
        let width = Math.max(num(first(head, 40)), num(first(head, 41)));
        let next = records.next();
        while (next && next.type === "VERTEX") {
          const vf = int(first(next, 70));
          // Spline frame control points (16) and polyface/mesh faces are not path points.
          if (!(vf & 16) && !(vf & 128 && !(vf & 64))) {
            points.push(point(next, 10));
            bulges.push(num(first(next, 42)));
            width = Math.max(width, num(first(next, 40)), num(first(next, 41)));
          }
          next = records.next();
        }
        if (next && next.type === "SEQEND") next = records.next();
        const paper = int(first(head, 67)) === 1;
        if (paper && modelSpaceOnly) file.paperSpace++;
        else if (flags & (16 | 64)) file.skipped["POLYLINE (mesh)"] = (file.skipped["POLYLINE (mesh)"] ?? 0) + 1;
        else if (points.length >= 2) {
          const is3d = (flags & 8) === 8;
          const elevation = num(first(head, 30));
          sink.push({
            type: "POLYLINE",
            ...common(head),
            points: is3d ? points : points.map((p) => [p[0], p[1], elevation] as V3),
            bulges,
            closed: (flags & 1) === 1,
            width,
            wcs: is3d,
          });
        }
        rec = next;
        continue;
      }
      if (type === "INSERT") {
        const head = rec;
        const attribs: DxfText[] = [];
        let next = records.next();
        if (int(first(head, 66)) === 1) {
          while (next && next.type === "ATTRIB") {
            if (!(int(first(next, 70)) & 1)) attribs.push(text(next, true));
            next = records.next();
          }
          if (next && next.type === "SEQEND") next = records.next();
        }
        const paper = int(first(head, 67)) === 1;
        if (paper && modelSpaceOnly) file.paperSpace++;
        else
          sink.push({
            type: "INSERT",
            ...common(head),
            block: str(first(head, 2)).trim(),
            p: point(head, 10),
            scale: [num(first(head, 41), 1), num(first(head, 42), 1), num(first(head, 43), 1)],
            rotation: num(first(head, 50)),
            cols: Math.max(1, int(first(head, 70), 1)),
            rows: Math.max(1, int(first(head, 71), 1)),
            colSpacing: num(first(head, 44)),
            rowSpacing: num(first(head, 45)),
            attribs,
          });
        rec = next;
        continue;
      }
      const paper = int(first(rec, 67)) === 1;
      const invisible = int(first(rec, 60)) === 1;
      if (paper && modelSpaceOnly) file.paperSpace++;
      else if (!invisible) {
        switch (type) {
          case "LINE":
            sink.push({ type: "LINE", ...common(rec), a: point(rec, 10), b: point(rec, 11) });
            break;
          case "LWPOLYLINE": {
            const pl = lwPolyline(rec);
            if (pl.points.length >= 2) sink.push(pl);
            break;
          }
          case "ARC":
            sink.push({ type: "ARC", ...common(rec), c: point(rec, 10), r: num(first(rec, 40)), start: num(first(rec, 50)), end: num(first(rec, 51)) });
            break;
          case "CIRCLE":
            sink.push({ type: "CIRCLE", ...common(rec), c: point(rec, 10), r: num(first(rec, 40)) });
            break;
          case "ELLIPSE":
            sink.push({ type: "ELLIPSE", ...common(rec), c: point(rec, 10), major: point(rec, 11), ratio: num(first(rec, 40), 1), start: num(first(rec, 41)), end: num(first(rec, 42), Math.PI * 2) });
            break;
          case "SPLINE":
            sink.push(spline(rec));
            break;
          case "TEXT":
            sink.push(text(rec, false));
            break;
          case "ATTDEF":
            // Attribute definitions show their tag in the block editor only.
            break;
          case "MTEXT":
            sink.push(mtext(rec));
            break;
          case "DIMENSION":
            sink.push({ type: "DIMENSION", ...common(rec), block: str(first(rec, 2)).trim(), text: textPlain(str(first(rec, 1))), measurement: rec.codes.includes(42) ? num(first(rec, 42)) : null });
            break;
          case "HATCH":
            sink.push(hatch(rec));
            break;
          case "SOLID":
          case "TRACE": {
            // Corners 1, 2, 4, 3 in drawing order.
            const p1 = point(rec, 10),
              p2 = point(rec, 11),
              p3 = point(rec, 12),
              p4 = rec.codes.includes(13) ? point(rec, 13) : p3;
            const pts = [p1, p2, p4, p3];
            const same = (a: V3, b: V3) => Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12;
            sink.push({ type: "SOLID", ...common(rec), points: same(p3, p4) ? [p1, p2, p3] : pts, wcs: false });
            break;
          }
          case "3DFACE": {
            const p1 = point(rec, 10),
              p2 = point(rec, 11),
              p3 = point(rec, 12),
              p4 = rec.codes.includes(13) ? point(rec, 13) : p3;
            const same = (a: V3, b: V3) => Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12;
            sink.push({ type: "SOLID", ...common(rec), points: same(p3, p4) ? [p1, p2, p3] : [p1, p2, p3, p4], wcs: true });
            break;
          }
          case "MLINE":
            sink.push(...mline(rec));
            break;
          case "POINT":
          case "VIEWPORT":
          case "SEQEND":
          case "VERTEX":
          case "ATTRIB":
            break;
          default:
            file.skipped[type] = (file.skipped[type] ?? 0) + 1;
        }
      }
      rec = records.next();
    }
    return rec;
  };

  let rec = records.next();
  while (rec) {
    if (rec.type === "EOF") break;
    if (rec.type !== "SECTION") {
      rec = records.next();
      continue;
    }
    sawSection = true;
    const name = str(first(rec, 2)).trim().toUpperCase();
    if (name === "HEADER") {
      // Variables: (9, $NAME) followed by their values, all within this record.
      const { codes, values } = rec;
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] !== 9) continue;
        const variable = str(values[i]).trim();
        const value = values[i + 1];
        if (variable === "$ACADVER") {
          version = str(value).trim();
          file.version = version;
        } else if (variable === "$DWGCODEPAGE" && binary) {
          if (isUtf8Release(version)) reader.setEncoding?.("utf-8");
          else reader.setEncoding?.(CODE_PAGES[str(value).trim().toUpperCase()] ?? "windows-1252");
        } else if (variable === "$INSUNITS") file.insUnits = int(value);
        else if (variable === "$MEASUREMENT") file.measurement = int(value);
      }
      if (binary && isUtf8Release(version)) reader.setEncoding?.("utf-8");
      rec = records.next();
      continue;
    }
    if (name === "TABLES") {
      rec = records.next();
      while (rec && rec.type !== "ENDSEC") {
        if (rec.type === "LAYER") {
          const layerName = str(first(rec, 2)).trim();
          const color = int(first(rec, 62), 7);
          const flags = int(first(rec, 70));
          const tc = first(rec, 420);
          if (layerName)
            file.layers.set(layerName, {
              name: layerName,
              color: Math.abs(color) || 7,
              trueColor: tc === undefined ? null : int(tc) & 0xffffff,
              off: color < 0,
              frozen: (flags & 1) === 1,
              linetype: str(first(rec, 6)),
            });
        }
        rec = records.next();
      }
      rec = records.next();
      continue;
    }
    if (name === "BLOCKS") {
      rec = records.next();
      while (rec && rec.type !== "ENDSEC") {
        if (rec.type === "BLOCK") {
          const head = rec;
          const flags = int(first(head, 70));
          const block: DxfBlock = { name: str(first(head, 2)).trim() || str(first(head, 3)).trim(), base: point(head, 10), flags, xref: (flags & 4) === 4, entities: [] };
          rec = readEntities(records.next(), block.entities, new Set(["ENDBLK", "ENDSEC", "BLOCK"]), false);
          if (rec && rec.type === "ENDBLK") rec = records.next();
          if (block.name) file.blocks.set(block.name, block);
          continue;
        }
        rec = records.next();
      }
      rec = records.next();
      continue;
    }
    if (name === "ENTITIES") {
      rec = readEntities(records.next(), file.entities, new Set(["ENDSEC"]), true);
      if (rec && rec.type === "ENDSEC") rec = records.next();
      continue;
    }
    // CLASSES, OBJECTS, THUMBNAILIMAGE, ACDSDATA: skip to the end of the section.
    rec = records.next();
    while (rec && rec.type !== "ENDSEC") rec = records.next();
    rec = records.next();
  }
  if (!sawSection) throw new DxfError("This is not a DXF file (no sections found).");
  return file;
}

/** The DXF release name for an $ACADVER code ("AC1015" -> "2000"). */
export function releaseName(version: string): string {
  const names: Record<string, string> = {
    AC1009: "R12",
    AC1012: "R13",
    AC1014: "R14",
    AC1015: "2000",
    AC1018: "2004",
    AC1021: "2007",
    AC1024: "2010",
    AC1027: "2013",
    AC1032: "2018",
  };
  return names[version] ?? (version || "unknown");
}
