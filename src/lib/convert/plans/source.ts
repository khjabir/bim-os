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
  /** Metres per pixel at 1:1 (multiply by the drawing scale, e.g. 100 for 1:100): PDF pages, and pictures that give their resolution. */
  metresPerPixelAtFullSize: number | null;
  /** How the size on paper is known: "300 dpi", "PDF page". */
  sizeLabel?: string | null;
  /** Taken with a camera (EXIF), or a picture of a sheet on a darker ground: may need straightening. */
  photo?: boolean;
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

/** Resolution and camera details in a PNG (pHYs), JPEG (JFIF, EXIF) or TIFF header. Screen defaults (72, 96 dpi) say nothing about paper. */
export function pictureInfo(bytes: Uint8Array): { dpi: number | null; camera: boolean } {
  const u16 = (o: number, le: boolean) => (le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
  const u32 = (o: number, le: boolean) => (le ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) + bytes[o + 3] * 2 ** 24 : bytes[o] * 2 ** 24 + ((bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]));
  const useful = (dpi: number) => (dpi > 96 && dpi <= 2400 ? Math.round(dpi) : null);
  // TIFF structure (TIFF files, EXIF in JPEG): resolution (282, 296) and camera make (271).
  const tiff = (base: number): { dpi: number | null; camera: boolean } => {
    const le = bytes[base] === 0x49;
    if (u16(base + 2, le) !== 42) return { dpi: null, camera: false };
    const ifd = base + u32(base + 4, le);
    const n = u16(ifd, le);
    let xres: number | null = null,
      unit = 2,
      camera = false;
    for (let k = 0; k < n && ifd + 2 + k * 12 + 12 <= bytes.length; k++) {
      const e = ifd + 2 + k * 12;
      const tag = u16(e, le);
      if (tag === 282) {
        const off = base + u32(e + 8, le);
        const den = u32(off + 4, le);
        if (den) xres = u32(off, le) / den;
      } else if (tag === 296) unit = u16(e + 8, le);
      else if (tag === 271 || tag === 272) camera = true;
    }
    return { dpi: xres ? useful(unit === 3 ? xres * 2.54 : xres) : null, camera };
  };
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    // PNG chunks.
    for (let o = 8; o + 12 <= bytes.length; ) {
      const len = u32(o, false);
      const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
      if (type === "pHYs" && bytes[o + 16] === 1) return { dpi: useful(u32(o + 8, false) * 0.0254), camera: false };
      if (type === "IDAT" || type === "IEND") break;
      o += 12 + len;
    }
    return { dpi: null, camera: false };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let dpi: number | null = null,
      camera = false;
    for (let o = 2; o + 4 < bytes.length && bytes[o] === 0xff; ) {
      const marker = bytes[o + 1];
      const len = u16(o + 2, false);
      if (marker === 0xe0 && String.fromCharCode(...bytes.subarray(o + 4, o + 8)) === "JFIF") {
        const units = bytes[o + 11];
        const x = u16(o + 12, false);
        if (units === 1) dpi = useful(x) ?? dpi;
        if (units === 2) dpi = useful(x * 2.54) ?? dpi;
      } else if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(o + 4, o + 8)) === "Exif") {
        const t = tiff(o + 10);
        dpi = t.dpi ?? dpi;
        camera = t.camera;
      } else if (marker === 0xda) break;
      o += 2 + len;
    }
    return { dpi, camera };
  }
  if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) return tiff(0);
  return { dpi: null, camera: false };
}

/** A TIFF page drawn on a canvas no larger than IMAGE_MAX; one-bit scans are shrunk straight from their bits (an A0 sheet at 400 dpi would not fit in memory as colour). */
async function tiffCanvas(bytes: ArrayBuffer): Promise<HTMLCanvasElement> {
  const UTIF = await import("utif2");
  const ifds = UTIF.decode(bytes);
  const page = ifds.find((i) => (i["t256"] as number[] | undefined)?.[0]) ?? ifds[0];
  if (!page) throw new Error("This TIFF file has no image.");
  UTIF.decodeImage(bytes, page);
  const w = page.width,
    h = page.height;
  const scale = Math.min(1, IMAGE_MAX / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)),
    ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const bps = (page["t258"] as number[] | undefined)?.[0] ?? 1;
  if (bps === 1 && scale < 1) {
    // Area average of the bits under each output pixel.
    const whiteIsZero = ((page["t262"] as number[] | undefined)?.[0] ?? 0) === 0;
    const bpl = Math.ceil(w / 8);
    const data = page.data;
    const sum = new Float32Array(cw * ch);
    const count = new Float32Array(cw * ch);
    for (let y = 0; y < h; y++) {
      const oy = Math.min(ch - 1, Math.floor(y * scale)) * cw;
      const row = y * bpl;
      for (let x = 0; x < w; x++) {
        const bit = (data[row + (x >> 3)] >> (7 - (x & 7))) & 1;
        const k = oy + Math.min(cw - 1, Math.floor(x * scale));
        sum[k] += whiteIsZero ? 1 - bit : bit;
        count[k]++;
      }
    }
    const img = ctx.createImageData(cw, ch);
    for (let i = 0; i < cw * ch; i++) {
      const v = count[i] ? (255 * sum[i]) / count[i] : 255;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }
  const rgba = UTIF.toRGBA8(page);
  const full = document.createElement("canvas");
  full.width = w;
  full.height = h;
  const pixels = new Uint8ClampedArray(w * h * 4);
  pixels.set(rgba.subarray(0, w * h * 4));
  full.getContext("2d")!.putImageData(new ImageData(pixels, w, h), 0, 0);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(full, 0, 0, cw, ch);
  return canvas;
}

async function loadImage(file: File): Promise<PlanRaster> {
  const bytes = await file.arrayBuffer();
  const meta = pictureInfo(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1 << 20)));
  let canvas: HTMLCanvasElement;
  let fullWidth: number;
  if (/\.tiff?$/i.test(file.name)) {
    const UTIF = await import("utif2");
    const page = UTIF.decode(bytes)[0];
    fullWidth = (page?.["t256"] as number[] | undefined)?.[0] ?? 0;
    canvas = await tiffCanvas(bytes);
    if (!fullWidth) fullWidth = canvas.width;
  } else {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: file.type || undefined }));
    fullWidth = bitmap.width;
    const scale = Math.min(1, IMAGE_MAX / Math.max(bitmap.width, bitmap.height));
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
  }
  const { gray, lightPaper } = rasterFromCanvas(canvas);
  // Size on paper: the resolution, corrected for any scaling down.
  const k = fullWidth ? canvas.width / fullWidth : 1;
  const metresPerPixelAtFullSize = meta.dpi ? 0.0254 / meta.dpi / k : null;
  return {
    label: file.name,
    fileName: file.name,
    page: null,
    width: canvas.width,
    height: canvas.height,
    imageUrl: await canvasToUrl(canvas),
    gray,
    lightPaper,
    metresPerPixelAtFullSize,
    sizeLabel: meta.dpi ? `${meta.dpi} dpi` : null,
    photo: meta.camera,
  };
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
        sizeLabel: "the PDF page size",
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
