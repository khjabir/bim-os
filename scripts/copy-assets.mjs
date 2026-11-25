// Copies the runtime assets the viewers load at run time from node_modules
// into /public, so they always match the installed package versions:
//   - web-ifc WebAssembly binaries      -> public/web-ifc/
//   - That Open Fragments worker script -> public/fragments/
//   - pdf.js worker (floor-plan PDFs)    -> public/pdfjs/
//   - Tesseract OCR worker, engine and English model (text on pictures of plans) -> public/ocr/
// Runs on postinstall, predev and prebuild. Safe to run repeatedly.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");

const jobs = [
  ["web-ifc/web-ifc.wasm", "public/web-ifc/web-ifc.wasm"],
  ["web-ifc/web-ifc-mt.wasm", "public/web-ifc/web-ifc-mt.wasm"],
  ["@thatopen/fragments/dist/Worker/worker.mjs", "public/fragments/worker.mjs"],
  ["pdfjs-dist/build/pdf.worker.min.mjs", "public/pdfjs/pdf.worker.min.mjs"],
  ["tesseract.js/dist/worker.min.js", "public/ocr/worker.min.js"],
  ["tesseract.js-core/tesseract-core-lstm.wasm.js", "public/ocr/core/tesseract-core-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "public/ocr/core/tesseract-core-simd-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js", "public/ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js"],
  ["@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "public/ocr/lang/eng.traineddata.gz"],
];

const digest = (file) => createHash("sha1").update(readFileSync(file)).digest("hex");

let copied = 0;
let missing = 0;
for (const [from, to] of jobs) {
  const src = join(nm, from);
  const dst = join(root, to);
  if (!existsSync(src)) {
    console.warn(`[assets] missing ${from} (run npm install first)`);
    missing++;
    continue;
  }
  mkdirSync(dirname(dst), { recursive: true });
  if (!existsSync(dst) || digest(dst) !== digest(src)) {
    copyFileSync(src, dst);
    copied++;
  }
}
console.log(`[assets] ${copied} copied, ${jobs.length - copied - missing} up to date`);
