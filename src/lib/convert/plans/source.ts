// Floor-plan sources: images and PDF pages, turned into a picture to show
// and a grayscale raster to trace. PDFs are rendered with pdf.js, at a
// resolution that keeps thin walls several pixels thick; pages drawn as line
// work (exported from CAD) also give their paths as a vector drawing, read
// exactly instead of traced. DXF files are read by the vector plan worker.

import type { PdfVector } from "./pdfvector";

export interface PlanRaster {
  /** "<file>" or "<file> · page 3" */
  label: string;
  fileName: string;
  page: number | null;
  width: number;
  height: number;
  /** PNG of the page for display. */
  imageUrl: string;
  /** Luminance, composited on white. */
  gray: Uint8Array;
  /** True when the paper is light (walls are probably darker than it). */
  lightPaper: boolean;
  /** PDF pages: metres per pixel at 1:1 (multiply by the drawing scale, e.g. 100 for 1:100). */
  metresPerPixelAtFullSize: number | null;
  /** PDF pages drawn as line work: the paths, and pixels per PDF point of the rendering. */
  vector?: { pdf: PdfVector; pxPerPoint: number; scale: number | null; scaleSource: "sheet" | "doors" | null } | null;
}

/** Longest side of a rendered PDF page, pixels. */
const PDF_TARGET = 3600;
/** Images larger than this are scaled down for tracing. */
const IMAGE_MAX = 5000;

export const PLAN_ACCEPT = ".dxf,.dwg,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff";

export function isPlanFile(name: string) {
  return /\.(dxf|dwg|pdf|png|jpe?g|webp|gif|bmp|tiff?)$/i.test(name);
}

/** A page is read as line work when it is mostly paths, not a scanned picture. */
export function isVectorPage(v: PdfVector) {
  return v.segments >= 150 && v.imageShare < 0.6;
}

function rasterFromCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): { gray: Uint8Array; lightPaper: boolean } {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const n = canvas.width * canvas.height;
  const gray = new Uint8Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    const v = Math.round(l * a + 255 * (1 - a));
    gray[i] = v;
    sum += v;
  }
  return { gray, lightPaper: sum / n > 127 };
}

async function canvasToUrl(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/png");
}

async function loadImage(file: File): Promise<PlanRaster> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const { gray, lightPaper } = rasterFromCanvas(canvas);
  return { label: file.name, fileName: file.name, page: null, width: canvas.width, height: canvas.height, imageUrl: await canvasToUrl(canvas), gray, lightPaper, metresPerPixelAtFullSize: null };
}

/** Number of pages of a PDF. */
export async function pdfPageCount(file: File): Promise<number> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    return (await task.promise).numPages;
  } finally {
    await task.destroy();
  }
}

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
      return pdfjs;
    });
    pdfjsPromise.catch(() => (pdfjsPromise = null));
  }
  return pdfjsPromise;
}

async function loadPdf(file: File, pages: number[]): Promise<PlanRaster[]> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const out: PlanRaster[] = [];
  const [{ pdfPageVector, pdfLayers }, { guessPdfScale }] = await Promise.all([import("./pdfvector"), import("./recognize")]);
  const layers = await pdfLayers(doc);
  try {
    for (const n of pages) {
      if (n < 1 || n > doc.numPages) continue;
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(6, PDF_TARGET / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport, background: "rgb(255,255,255)" }).promise;
      const { gray, lightPaper } = rasterFromCanvas(canvas);
      let vector: PlanRaster["vector"] = null;
      try {
        const pdf = await pdfPageVector(pdfjs, page, layers);
        if (isVectorPage(pdf)) {
          const doors = guessPdfScale(pdf.drawing);
          const scale = pdf.scaleText ?? doors;
          vector = { pdf, pxPerPoint: canvas.width / pdf.width, scale, scaleSource: pdf.scaleText ? "sheet" : doors ? "doors" : null };
        }
      } catch {
        vector = null;
      }
      out.push({
        label: doc.numPages > 1 ? `${file.name} · page ${n}` : file.name,
        fileName: file.name,
        page: n,
        width: canvas.width,
        height: canvas.height,
        imageUrl: await canvasToUrl(canvas),
        gray,
        lightPaper,
        // One PDF unit is 1/72 inch on paper.
        metresPerPixelAtFullSize: 0.0254 / 72 / scale,
        vector,
      });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return out;
}

/** Loads an image, or the given pages of a PDF (all pages when omitted, up to 20). */
export async function loadPlanFile(file: File, pages?: number[]): Promise<PlanRaster[]> {
  if (/\.pdf$/i.test(file.name)) {
    const list = pages ?? Array.from({ length: Math.min(20, await pdfPageCount(file)) }, (_, i) => i + 1);
    return loadPdf(file, list);
  }
  return [await loadImage(file)];
}
