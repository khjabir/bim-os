// Text on pictures of plans, read in the browser with Tesseract (tesseract.js)
// from this app's own copy of the engine and the English model (public/ocr,
// copied from node_modules by scripts/copy-assets.mjs): no service, no key.
// The language model is kept in the browser after the first use.
//
// The vector worker lays the lines of text out on sheets (one per row,
// level, letters about 32 px high); each sheet is read once and the words
// are put back to their lines by position.

import type { TextSheets } from "./raster";

type Worker = import("tesseract.js").Worker;

let ocr: Promise<Worker> | null = null;

function getOcr(onStatus?: (status: string) => void): Promise<Worker> {
  if (!ocr) {
    ocr = (async () => {
      onStatus?.("Loading the text reader");
      const { createWorker, PSM } = await import("tesseract.js");
      const worker = await createWorker("eng", 1, {
        workerPath: "/ocr/worker.min.js",
        corePath: "/ocr/core",
        langPath: "/ocr/lang",
        workerBlobURL: false,
        gzip: true,
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: "1", user_defined_dpi: "300" });
      return worker;
    })();
    ocr.catch(() => (ocr = null));
  }
  return ocr;
}

/** Frees the text reader (it is started again when needed). */
export async function closeOcr() {
  const current = ocr;
  ocr = null;
  if (current) await (await current).terminate().catch(() => undefined);
}

/** OCR fixes common on plans: "m?" for "m²", stray marks. */
export function cleanText(text: string): string {
  let t = text.replace(/[|_~]+/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/(\d)\s*m\s*[?°'"*^2²]$/i, "$1 m²").replace(/(\d)\s*(sq\.?\s?m|sqm)$/i, "$1 m²");
  t = t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9²)"'′″]+$/g, "");
  return t;
}

export interface ReadText {
  box: number;
  text: string;
  /** 0..100 */
  confidence: number;
}

/** Reads the sheets; one text per line box (the better of the two readings of vertical lines). */
export async function readSheets(sheets: TextSheets, onStatus?: (status: string) => void): Promise<ReadText[]> {
  if (!sheets.places.length) return [];
  const worker = await getOcr(onStatus);
  const found = new Map<string, { text: string; conf: number }>();
  for (let k = 0; k < sheets.sheets.length; k++) {
    onStatus?.(sheets.sheets.length > 1 ? `Reading text (${k + 1} of ${sheets.sheets.length})` : "Reading text");
    const sheet = sheets.sheets[k];
    const canvas = document.createElement("canvas");
    canvas.width = sheet.width;
    canvas.height = sheet.height;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(sheet.width, sheet.height);
    for (let i = 0; i < sheet.data.length; i++) {
      const v = sheet.data[i];
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
    const words: { text: string; conf: number; x: number; y: number }[] = [];
    for (const block of data.blocks ?? []) for (const par of block.paragraphs) for (const line of par.lines) for (const w of line.words) words.push({ text: w.text, conf: w.confidence, x: (w.bbox.x0 + w.bbox.x1) / 2, y: (w.bbox.y0 + w.bbox.y1) / 2 });
    for (const place of sheets.places) {
      if (place.sheet !== k) continue;
      const [x, y, w, h] = place.rect;
      const mine = words.filter((m) => m.x >= x - 4 && m.x <= x + w + 4 && m.y >= y - 4 && m.y <= y + h + 4).sort((p, q) => p.x - q.x);
      if (!mine.length) continue;
      found.set(`${place.box}:${place.rotation}`, { text: mine.map((m) => m.text).join(" "), conf: mine.reduce((s, m) => s + m.conf, 0) / mine.length });
    }
  }
  const out: ReadText[] = [];
  const boxes = new Set(sheets.places.map((p) => p.box));
  const score = (c: { text: string; conf: number }) => c.conf * Math.min(1, c.text.replace(/[^A-Za-z0-9]/g, "").length / 2);
  for (const box of boxes) {
    const cands = [0, 90, -90].map((r) => found.get(`${box}:${r}`)).filter((c): c is { text: string; conf: number } => Boolean(c));
    if (!cands.length) continue;
    cands.sort((p, q) => score(q) - score(p));
    const best = cands[0];
    const text = cleanText(best.text);
    if (best.conf < 40 || !/[A-Za-z0-9]/.test(text)) continue;
    out.push({ box, text, confidence: Math.round(best.conf) });
  }
  return out;
}
