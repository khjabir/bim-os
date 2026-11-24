// A PDF page's line work as a vector drawing (vector.ts): the paths pdf.js
// reads from the page, in PDF points with y up (page view orientation, so
// rotated pages come out as they are seen). PDFs exported from CAD keep their
// layers as optional content groups; those become the drawing's layers.
// Without them, paths are grouped by pen (colour and line width, fills
// separately) so the layer roles can still be set. Arcs drawn as Bézier
// curves are recognised as arcs again (door swings, round columns).

import type { PDFPageProxy } from "pdfjs-dist";
import { DRAWING_SCALES } from "./recognize";
import { type Affine, DrawingBuilder, F_CURVE, IDENTITY, mul, normalizeArc, type Pt, type VectorDrawing } from "./vector";

type PdfJs = typeof import("pdfjs-dist");

const TAU = Math.PI * 2;

export interface PdfVector {
  drawing: VectorDrawing;
  /** Page size in points (view orientation). */
  width: number;
  height: number;
  /** Drawing scale printed on the sheet ("1:100", 1/4" = 1'-0"), when found. */
  scaleText: number | null;
  /** Painted path segments (0 for scanned pages). */
  segments: number;
  /** Share of the page covered by pictures (scanned plans are mostly picture). */
  imageShare: number;
  /** Layers came from the PDF's optional content (true) or from pens (false). */
  ocLayers: boolean;
}

/** "1:100", "M 1:50", "SCALE 1 : 200", 1/8" = 1'-0" ; the most frequent standard scale on the sheet. */
export function scaleFromTexts(texts: string[]): number | null {
  const votes = new Map<number, number>();
  const vote = (n: number) => {
    if (!DRAWING_SCALES.includes(n)) return;
    votes.set(n, (votes.get(n) ?? 0) + 1);
  };
  for (const raw of texts) {
    const t = raw.replace(/\s+/g, " ");
    for (const m of t.matchAll(/(?:^|[^\d.,])1 ?[:：] ?(\d{1,4})(?![\d.,])/g)) vote(parseInt(m[1], 10));
    for (const m of t.matchAll(/(\d+(?: \d+)?(?:\/\d+)?) ?(?:"|”|''|in\.?) ?= ?1 ?(?:'|’|ft\.?)(?: ?-? ?0 ?(?:"|”|''))?/gi)) {
      const parts = m[1].split(" ");
      let inches = 0;
      for (const p of parts) {
        if (p.includes("/")) {
          const [a, b] = p.split("/").map(Number);
          if (b) inches += a / b;
        } else inches += Number(p);
      }
      if (inches > 0) vote(Math.round(12 / inches));
    }
  }
  let best: number | null = null;
  let bestVotes = 0;
  for (const [n, v] of votes)
    if (v > bestVotes || (v === bestVotes && best !== null && n < best)) {
      best = n;
      bestVotes = v;
    }
  return best;
}

function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

function circleThrough(a: Pt, b: Pt, c: Pt): { c: Pt; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1],
    b2 = b[0] * b[0] + b[1] * b[1],
    c2 = c[0] * c[0] + c[1] * c[1];
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) };
}

/** A cubic that is a circular arc (as CAD exporters write arcs): centre, radius and its angles in drawing order. */
function cubicArc(p0: Pt, p1: Pt, p2: Pt, p3: Pt): { c: Pt; r: number; from: number; to: number } | null {
  const mid = bezier(p0, p1, p2, p3, 0.5);
  const circle = circleThrough(p0, mid, p3);
  if (!circle || circle.r <= 0) return null;
  for (const t of [0.25, 0.75]) {
    const q = bezier(p0, p1, p2, p3, t);
    if (Math.abs(Math.hypot(q[0] - circle.c[0], q[1] - circle.c[1]) - circle.r) > circle.r * 0.004) return null;
  }
  const ang = (p: Pt) => Math.atan2(p[1] - circle.c[1], p[0] - circle.c[0]);
  const a0 = ang(p0),
    am = ang(mid),
    a1 = ang(p3);
  // Direction: does the arc go counter-clockwise from p0 through mid to p3?
  const ccw = (x: number, y: number) => ((y - x) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const sweepCcw = ccw(a0, a1);
  const midCcw = ccw(a0, am);
  const to = midCcw <= sweepCcw ? a0 + sweepCcw : a0 - (Math.PI * 2 - sweepCcw);
  return { c: circle.c, r: circle.r, from: a0, to };
}

interface GState {
  ctm: Affine;
  lineWidth: number;
  stroke: string;
  fill: string;
}

export async function pdfPageVector(pdfjs: PdfJs, page: PDFPageProxy, ocNames: Map<string, string> | null): Promise<PdfVector> {
  const OPS = pdfjs.OPS;
  const viewport = page.getViewport({ scale: 1 });
  const W = viewport.width,
    H = viewport.height;
  // User space -> view (y down) -> drawing (y up).
  const vt = viewport.transform as number[];
  const toView: Affine = [vt[0], vt[1], vt[2], vt[3], vt[4], vt[5]];
  const flip: Affine = [1, 0, 0, -1, 0, H];
  const base = mul(flip, toView);
  const b = new DrawingBuilder();
  b.maxStep = (6 * Math.PI) / 180;
  const ocLayers = Boolean(ocNames && ocNames.size);
  const ocLayer = new Map<string, number>();
  if (ocNames) for (const [id, name] of ocNames) ocLayer.set(id, b.layer(name || id, "#1f2937", false));
  const unlayered = () => b.layer(ocLayers ? "(no layer)" : "Lines", "#1f2937");
  const penLayer = (kind: "stroke" | "fill", color: string, width: number) => {
    if (kind === "fill") return b.layer(`Fill ${color}`, color);
    const mm = Math.max(0.05, Math.round(width * (25.4 / 72) * 100) / 100);
    return b.layer(`Pen ${mm.toFixed(2)} mm ${color}`, color);
  };

  const ops = await page.getOperatorList();
  const stack: GState[] = [];
  let g: GState = { ctm: IDENTITY, lineWidth: 1, stroke: "#000000", fill: "#000000" };
  const ocStack: (number | null)[] = [];
  const currentOc = () => {
    for (let i = ocStack.length - 1; i >= 0; i--) if (ocStack[i] !== null) return ocStack[i];
    return null;
  };
  let imageArea = 0;
  let segments = 0;
  const { fnArray, argsArray } = ops;
  for (let k = 0; k < fnArray.length; k++) {
    const fn = fnArray[k];
    const args = argsArray[k] as unknown[];
    switch (fn) {
      case OPS.save:
        stack.push({ ...g });
        break;
      case OPS.restore:
        if (stack.length) g = stack.pop()!;
        break;
      case OPS.transform: {
        const [a, bb, c, d, e, f] = args as number[];
        g.ctm = mul(g.ctm, [a, bb, c, d, e, f]);
        break;
      }
      case OPS.paintFormXObjectBegin: {
        stack.push({ ...g });
        const m = args[0] as number[] | null;
        if (m && m.length === 6) g.ctm = mul(g.ctm, [m[0], m[1], m[2], m[3], m[4], m[5]]);
        break;
      }
      case OPS.paintFormXObjectEnd:
        if (stack.length) g = stack.pop()!;
        break;
      case OPS.setLineWidth:
        g.lineWidth = Number(args[0]) || 0;
        break;
      case OPS.setGState:
        for (const [key, value] of (args[0] as [string, unknown][]) ?? []) if (key === "LW") g.lineWidth = Number(value) || 0;
        break;
      case OPS.setStrokeRGBColor:
        g.stroke = String(args[0]);
        break;
      case OPS.setFillRGBColor:
        g.fill = String(args[0]);
        break;
      case OPS.beginMarkedContentProps: {
        const data = args[1] as { type?: string; id?: string; ids?: string[]; expression?: unknown } | null;
        let layer: number | null = null;
        if (args[0] === "OC" && data) {
          if (data.type === "OCG" && data.id) layer = ocLayer.get(data.id) ?? null;
          else if (data.ids?.length) layer = ocLayer.get(data.ids[0]) ?? null;
        }
        ocStack.push(layer);
        break;
      }
      case OPS.beginMarkedContent:
        ocStack.push(null);
        break;
      case OPS.endMarkedContent:
        ocStack.pop();
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject: {
        // The image fills the unit square of the current transform.
        const m = mul(base, g.ctm);
        imageArea += Math.abs(m[0] * m[3] - m[1] * m[2]);
        break;
      }
      case OPS.constructPath: {
        const paint = args[0] as number;
        const data = (args[1] as (Float32Array | null)[] | undefined)?.[0];
        if (!data || paint === OPS.endPath) break;
        const stroke = paint === OPS.stroke || paint === OPS.closeStroke || paint === OPS.fillStroke || paint === OPS.eoFillStroke || paint === OPS.closeFillStroke || paint === OPS.closeEOFillStroke;
        const fill = paint === OPS.fill || paint === OPS.eoFill || paint === OPS.fillStroke || paint === OPS.eoFillStroke || paint === OPS.closeFillStroke || paint === OPS.closeEOFillStroke;
        const m = mul(base, g.ctm);
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        const oc = currentOc();
        const strokeLayer = oc ?? (ocLayers ? unlayered() : penLayer("stroke", g.stroke, g.lineWidth * scale));
        const fillLayer = oc ?? (ocLayers ? unlayered() : penLayer("fill", g.fill, 0));
        // Subpaths: points, and per segment whether it belongs to a curve that is a circular arc.
        interface Sub {
          pts: Pt[];
          arcSeg: boolean[];
          closed: boolean;
          arcs: { c: Pt; r: number; from: number; to: number }[];
        }
        const subpaths: Sub[] = [];
        let cur: Sub | null = null;
        const P = (x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
        const start = (p: Pt) => {
          cur = { pts: [p], arcSeg: [], closed: false, arcs: [] };
          subpaths.push(cur);
          return cur;
        };
        for (let i = 0; i < data.length; ) {
          const op = data[i++];
          if (op === 0) {
            start(P(data[i], data[i + 1]));
            i += 2;
          } else if (op === 1) {
            const p = P(data[i], data[i + 1]);
            i += 2;
            const c = cur as Sub | null;
            if (!c) start(p);
            else {
              c.pts.push(p);
              c.arcSeg.push(false);
            }
          } else if (op === 2 || op === 3) {
            const n = op === 2 ? 6 : 4;
            const c = cur as Sub | null;
            if (!c) {
              i += n;
              continue;
            }
            const p0 = c.pts[c.pts.length - 1];
            let p1: Pt, p2: Pt, p3: Pt;
            if (op === 2) {
              p1 = P(data[i], data[i + 1]);
              p2 = P(data[i + 2], data[i + 3]);
              p3 = P(data[i + 4], data[i + 5]);
            } else {
              const q = P(data[i], data[i + 1]);
              p3 = P(data[i + 2], data[i + 3]);
              p1 = [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])];
              p2 = [p3[0] + (2 / 3) * (q[0] - p3[0]), p3[1] + (2 / 3) * (q[1] - p3[1])];
            }
            i += n;
            const arc = cubicArc(p0, p1, p2, p3);
            if (arc) {
              // Continue the previous arc piece when it is the same circle, turning the same way.
              const last = c.arcs[c.arcs.length - 1];
              const joined =
                last &&
                Math.hypot(last.c[0] - arc.c[0], last.c[1] - arc.c[1]) < arc.r * 0.01 &&
                Math.abs(last.r - arc.r) < arc.r * 0.01 &&
                Math.sign(last.to - last.from) === Math.sign(arc.to - arc.from) &&
                Math.abs((((last.to - arc.from) % TAU) + TAU + Math.PI) % TAU - Math.PI) < 0.02;
              if (joined) last.to += arc.to - arc.from;
              else c.arcs.push(arc);
            }
            const steps = Math.max(4, Math.min(24, Math.ceil(Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / 4)));
            for (let t = 1; t <= steps; t++) {
              c.pts.push(bezier(p0, p1, p2, p3, t / steps));
              c.arcSeg.push(Boolean(arc));
            }
          } else if (op === 4) {
            const c = cur as Sub | null;
            if (c) {
              c.closed = true;
              start(c.pts[0]);
            }
          } else break;
        }
        const rings: Pt[][] = [];
        for (const sp of subpaths) {
          if (sp.pts.length < 2) continue;
          if (stroke) {
            for (let q = 0; q + 1 < sp.pts.length; q++) {
              b.seg(sp.pts[q][0], sp.pts[q][1], sp.pts[q + 1][0], sp.pts[q + 1][1], strokeLayer, -1, sp.arcSeg[q] ? F_CURVE : 0);
              segments++;
            }
            if (sp.closed) {
              const a = sp.pts[sp.pts.length - 1],
                c = sp.pts[0];
              b.seg(a[0], a[1], c[0], c[1], strokeLayer, -1, 0);
            }
            for (const arc of sp.arcs) {
              const full = Math.abs(arc.to - arc.from) >= TAU - 0.02;
              const [a0, a1] = full ? [0, TAU] : arc.to >= arc.from ? normalizeArc(arc.from, arc.to) : normalizeArc(arc.to, arc.from);
              b.arcs.push({ c: arc.c, r: arc.r, a0, a1, layer: strokeLayer, symbol: -1, flags: 0 });
            }
          }
          const closedRing = sp.closed || (sp.pts.length > 3 && Math.hypot(sp.pts[0][0] - sp.pts[sp.pts.length - 1][0], sp.pts[0][1] - sp.pts[sp.pts.length - 1][1]) < 1e-6);
          if (closedRing && sp.pts.length >= 3) {
            const ring = sp.closed ? sp.pts : sp.pts.slice(0, -1);
            if (stroke) b.polys.push({ points: ring, layer: strokeLayer, symbol: -1, flags: 0 });
            rings.push(ring);
          }
        }
        // White fills mask things out (wipeouts); they are not walls or rooms.
        if (fill && rings.length && !/^#f[0-9a-f]f[0-9a-f]f[0-9a-f]$/i.test(g.fill)) b.fills.push({ rings, layer: fillLayer, symbol: -1, solid: true, flags: 0 });
        break;
      }
    }
  }

  // Texts.
  const content = await page.getTextContent();
  const textLayer = b.layer("Text", "#374151");
  const texts: string[] = [];
  for (const item of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
    if (!item.str || !item.transform) continue;
    const str = item.str.trim();
    if (!str) continue;
    texts.push(str);
    const [a, bb, c, d, e, f] = item.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, bb);
    const dir: Pt = [a / (Math.hypot(a, bb) || 1), bb / (Math.hypot(a, bb) || 1)];
    const up: Pt = [-dir[1], dir[0]];
    const w = item.width ?? str.length * size * 0.5;
    const cx = e + dir[0] * (w / 2) + up[0] * size * 0.35,
      cy = f + dir[1] * (w / 2) + up[1] * size * 0.35;
    const p = [base[0] * cx + base[2] * cy + base[4], base[1] * cx + base[3] * cy + base[5]] as Pt;
    const dv = [base[0] * dir[0] + base[2] * dir[1], base[1] * dir[0] + base[3] * dir[1]];
    b.texts.push({ c: p, text: str, h: size * Math.sqrt(Math.abs(base[0] * base[3] - base[1] * base[2])), rotation: Math.atan2(dv[1], dv[0]), layer: textLayer, symbol: -1, flags: 0 });
  }
  const drawing = b.build("pdf", null, "PDF points");
  // The page as the drawing's extent.
  drawing.bbox = [0, 0, W, H];
  return { drawing, width: W, height: H, scaleText: scaleFromTexts(texts), segments, imageShare: Math.min(1, imageArea / (W * H)), ocLayers };
}

/** Optional content groups of a PDF (id -> name), or null. */
export async function pdfLayers(doc: import("pdfjs-dist").PDFDocumentProxy): Promise<Map<string, string> | null> {
  try {
    const config = await doc.getOptionalContentConfig();
    const out = new Map<string, string>();
    for (const [id, group] of config as unknown as Iterable<[string, { name: string | null }]>) out.set(id, group?.name ?? id);
    return out.size ? out : null;
  } catch {
    return null;
  }
}
