// Installs the optional DWG add-on into public/addons/dwg/, or removes it.
//
//   npm run addon:dwg               install it, or update it to the pinned version
//   npm run addon:dwg -- --remove   remove it
//
// It installs the libredwg-web version locked in addons/dwg/package-lock.json
// into addons/dwg/node_modules (not the app's own node_modules), checks that it
// loads, and copies what the browser needs into public/addons/dwg/, which git
// ignores. See addons/dwg/README.md.
//
// Copyright (C) 2026 The bim-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see LICENSE.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const target = join(root, "public", "addons", "dwg");
const pkgDir = join(here, "node_modules", "@mlightcad", "libredwg-web");
const PACKAGE = "@mlightcad/libredwg-web";
const REPO = "https://github.com/mlightcad/libredwg-web";
// libredwg-web releases this add-on was tested with, and the commit each release tag points to.
const TESTED = { "0.9.3": "c8d0bc8f4c0dfac6fcde9f8347867ed1c35ffad0" };
// The message format between the app and dwg.worker.js. The app checks it.
const PROTOCOL = 1;

const say = (text) => console.log(`[dwg add-on] ${text}`);
const fail = (text) => {
  console.error(`[dwg add-on] ${text}`);
  process.exit(1);
};

if (process.argv.includes("--remove")) {
  rmSync(target, { recursive: true, force: true });
  const addons = dirname(target);
  if (existsSync(addons) && readdirSync(addons).length === 0) rmSync(addons, { recursive: true, force: true });
  rmSync(join(here, "node_modules"), { recursive: true, force: true });
  say("Removed. Restart `npm run dev`, or run `npm run build` again, so the app stops offering it.");
  process.exit(0);
}

// 1. The pinned package, exactly as locked, with no install scripts.
const execPath = process.env.npm_execpath;
const viaNpm = execPath && /npm-cli\.[cm]?js$/.test(basename(execPath));
const args = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
say(`Installing ${PACKAGE} into addons/dwg/node_modules`);
const npm = viaNpm
  ? spawnSync(process.execPath, [execPath, ...args], { cwd: here, stdio: "inherit" })
  : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: here, stdio: "inherit", shell: process.platform === "win32" });
if (npm.status !== 0) fail("npm could not install the package (see above). Check your connection to the npm registry and try again.");

const { version, license: packageLicense } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const files = [
  [join(pkgDir, "wasm", "libredwg-web.js"), "libredwg-web.js"],
  [join(pkgDir, "wasm", "libredwg-web.wasm"), "libredwg-web.wasm"],
  [join(here, "dwg.worker.js"), "dwg.worker.js"],
  [join(here, "LICENSE"), "LICENSE"],
];
for (const [from] of files) if (!existsSync(from)) fail(`Missing ${from}. Run \`npm run addon:dwg\` again.`);

// 2. Check that LibreDWG loads here and has the converter the worker calls.
try {
  const { default: createModule } = await import(pathToFileURL(files[0][0]).href);
  const lib = await createModule({ print() {}, printErr() {} });
  if (typeof lib.dwg_write_dxf !== "function" || typeof lib.FS?.writeFile !== "function") throw new Error("dwg_write_dxf or FS is missing");
} catch (error) {
  fail(`${PACKAGE} ${version} did not load: ${error instanceof Error ? error.message : error}`);
}

// 3. Copy what the browser needs, with directions to the source code next to it.
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const checksums = {};
for (const [from, name] of files) {
  copyFileSync(from, join(target, name));
  checksums[name] = sha256(from);
}
const commit = TESTED[version] ?? null;
const source = `${REPO}/tree/v${version}`;
writeFileSync(
  join(target, "SOURCE.md"),
  `# Source code for the files in this folder

\`libredwg-web.js\` and \`libredwg-web.wasm\` are GNU LibreDWG compiled to
WebAssembly by the libredwg-web project: version ${version} of the npm package
\`${PACKAGE}\`, unchanged. They are free software under the GNU General Public
License, version 3 (\`LICENSE\` in this folder).

Their corresponding source code (LibreDWG's source, the WebAssembly bindings and
the build scripts) is the libredwg-web repository at release v${version}:

- ${source}${commit ? `\n- commit ${commit}` : ""}
- GNU LibreDWG: https://www.gnu.org/software/libredwg/

\`dwg.worker.js\` is the IFC Studio DWG add-on's worker, under GPL-3.0-or-later.
It is its own source code; it also lives in \`addons/dwg/\` in IFC Studio's
source, with the script that installed these files.
`,
);
checksums["SOURCE.md"] = sha256(join(target, "SOURCE.md"));
const manifest = {
  addon: "dwg",
  protocol: PROTOCOL,
  reader: `GNU LibreDWG (libredwg-web ${version})`,
  package: PACKAGE,
  version,
  license: "GPL-3.0-or-later",
  packageLicense: packageLicense ?? null,
  source,
  commit,
  installed: new Date().toISOString(),
  files: checksums,
};
writeFileSync(join(target, "addon.json"), `${JSON.stringify(manifest, null, 2)}\n`);

say(`Installed GNU LibreDWG (libredwg-web ${version}) in public/addons/dwg/ (GPL licensed, not tracked by git).`);
if (!commit) say(`Note: version ${version} has not been tested with this add-on (tested: ${Object.keys(TESTED).join(", ")}).`);
say("Restart `npm run dev`, or run `npm run build` again before `npm start`: the app looks for the add-on only if it was there when the app was built or the development server started.");
