// IFC Studio DWG add-on: converts one DWG drawing to DXF inside the browser
// with GNU LibreDWG, compiled to WebAssembly by the libredwg-web project.
//
// Copyright (C) 2026 The bim-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. This program is distributed in the hope that it will be
// useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General
// Public License for more details. You should have received a copy of the
// GNU General Public License along with this program (LICENSE, next to this
// file). If not, see <https://www.gnu.org/licenses/>.
//
// The app loads this file from /addons/dwg/ at run time and only exchanges
// messages with it: DWG bytes in, DXF bytes out. One worker converts one file
// and the app then terminates it, which gives the WebAssembly memory back.
//
// in : { type: "convert", file: Blob }
// out: { type: "progress", label }
//      { type: "done", dxf: ArrayBuffer, code, messages, stats: { loadMs, convertMs, dwgBytes, dxfBytes } }
//      { type: "error", message, code, outOfMemory, messages }
//
// `code` is LibreDWG's error bit set: 0 is a clean read, values below 128 are
// problems LibreDWG worked around, 128 and above mean it could not read the file.

import createModule from "./libredwg-web.js";

const CRITICAL = 128;
const OUT_OF_MEMORY = 8192;
const REASONS = [
  [8192, "it ran out of memory"],
  [4096, "it could not read or write a file"],
  [2048, "this is not a DWG file it can read"],
  [1024, "of an internal error"],
  [512, "a page of the file is missing"],
  [256, "a section of the file is missing"],
  [128, "the file's list of object classes is missing"],
];

function reason(code) {
  const found = REASONS.filter(([bit]) => (code & bit) !== 0).map(([, text]) => text);
  return found.length ? found.join(", and ") : `it reported error ${code}`;
}

self.onmessage = async (event) => {
  const request = event.data ?? {};
  if (request.type !== "convert") return;
  // LibreDWG's own messages (it prints few): kept to explain a failure.
  const messages = [];
  const log = (...parts) => {
    if (messages.length < 40) messages.push(parts.map(String).join(" ").slice(0, 300));
  };
  try {
    self.postMessage({ type: "progress", label: "Starting the DWG reader" });
    const started = performance.now();
    const lib = await createModule({ print: log, printErr: log });
    const loaded = performance.now();
    self.postMessage({ type: "progress", label: "Converting the drawing to DXF" });
    const dwg = new Uint8Array(await request.file.arrayBuffer());
    lib.FS.writeFile("/drawing.dwg", dwg);
    const code = lib.dwg_write_dxf("/drawing.dwg", "/drawing.dxf");
    let dxf = null;
    try {
      dxf = lib.FS.readFile("/drawing.dxf");
    } catch {
      // Not written: LibreDWG stopped before the DXF writer.
    }
    if (code >= CRITICAL || !dxf || dxf.length === 0) {
      self.postMessage({
        type: "error",
        message: `LibreDWG could not read this drawing because ${reason(code)}.`,
        code,
        outOfMemory: (code & OUT_OF_MEMORY) !== 0,
        messages,
      });
      return;
    }
    const buffer = dxf.byteOffset === 0 && dxf.byteLength === dxf.buffer.byteLength ? dxf.buffer : dxf.slice().buffer;
    const stats = { loadMs: Math.round(loaded - started), convertMs: Math.round(performance.now() - loaded), dwgBytes: dwg.length, dxfBytes: buffer.byteLength };
    self.postMessage({ type: "done", dxf: buffer, code, messages, stats }, [buffer]);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    self.postMessage({
      type: "error",
      message: `LibreDWG stopped while reading this drawing (${text}).`,
      code: null,
      outOfMemory: /out of memory|cannot enlarge memory|allocation failed/i.test(text),
      messages,
    });
  }
};
