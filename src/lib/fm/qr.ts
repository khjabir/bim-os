// QR codes for asset labels. A label's code is a link to the asset in the
// field app when the facility has a link address set (so a phone's camera app
// opens it directly), or the bare asset code otherwise (read by the field
// app's own scanner, or typed in).

import qrcode from "qrcode-generator";
import { valueOf } from "./asset";
import type { Asset, Facility } from "./types";

/** The text a label's QR code carries. */
export function labelPayload(asset: Asset, facility: Facility | null): string {
  const code = valueOf(asset, "code") || asset.id;
  const base = facility?.labelBaseUrl?.trim().replace(/\/+$/, "");
  return base ? `${base}/field?asset=${encodeURIComponent(code)}` : code;
}

/** An asset code from what a scanner read: a field-app link or the code itself. */
export function codeFromScan(text: string): string {
  const trimmed = text.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("asset");
    if (code) return code;
  } catch {
    /* not a link */
  }
  return trimmed;
}

/** A QR code as an SVG drawing (one path of dark modules), scaled to fit its box. */
export function qrSvg(text: string, options: { margin?: number; level?: "L" | "M" | "Q" | "H"; title?: string } = {}): string {
  const qr = qrcode(0, options.level ?? "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const m = options.margin ?? 2;
  let d = "";
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++;
        continue;
      }
      let run = 1;
      while (c + run < n && qr.isDark(r, c + run)) run++;
      d += `M${c + m} ${r + m}h${run}v1h-${run}z`;
      c += run;
    }
  }
  const size = n + m * 2;
  const title = options.title ? `<title>${options.title.replace(/[<&>]/g, "")}</title>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img">${title}<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
