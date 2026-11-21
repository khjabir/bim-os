/** Saves a Blob through a temporary object URL. */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a moment to start the download before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadText(text: string, fileName: string, mime = "text/plain") {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), fileName);
}

type Cell = string | number | boolean | null | undefined;

/** RFC 4180 CSV with a UTF-8 byte-order mark so Excel reads non-ASCII text. */
export function toCsv(header: string[], rows: Cell[][]): string {
  const escape = (cell: Cell) => {
    if (cell === null || cell === undefined) return "";
    const text = String(cell);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [header.map(escape).join(","), ...rows.map((row) => row.map(escape).join(","))];
  return "﻿" + lines.join("\r\n");
}

export function downloadCsv(header: string[], rows: Cell[][], fileName: string) {
  downloadText(toCsv(header, rows), fileName, "text/csv");
}
