# DWG add-on (optional)

Lets IFC Studio read AutoCAD DWG floor plans. Each DWG is converted to DXF on
the user's own computer, inside the browser, by [GNU LibreDWG](https://www.gnu.org/software/libredwg/)
compiled to WebAssembly by the [libredwg-web](https://github.com/mlightcad/libredwg-web)
project. The app then reads the DXF exactly as it reads any other DXF. Nothing
is uploaded.

## Why it is separate

LibreDWG is licensed under the GNU General Public License, version 3 or later.
The rest of this project is MIT. To keep the MIT code free of GPL code, the
add-on:

- lives in this folder, under its own licence (GPL-3.0-or-later, see `LICENSE`);
- is not one of the app's dependencies: `npm install` does not fetch it, and
  the app's bundle does not contain it;
- runs in its own web worker, which the app loads from `/addons/dwg/` at run
  time. The app sends it a DWG file and gets DXF text back, and exchanges
  nothing else with it.

Without the add-on, the app explains how to install it, or to save the drawing
as DXF or PDF instead.

## Install

From the project root:

```sh
npm run addon:dwg
```

This installs the `@mlightcad/libredwg-web` version locked in this folder's
`package-lock.json` into `addons/dwg/node_modules` (not the app's own
`node_modules`), checks that it loads, and copies the files the browser needs
into `public/addons/dwg/`, which git ignores. Then restart `npm run dev`, or run
`npm run build` again before `npm start`: the app looks for the add-on only if it
was there when the app was built or the development server started.

To remove it: `npm run addon:dwg -- --remove`, then restart or rebuild.

| Installed in `public/addons/dwg/` | What it is |
| --- | --- |
| `libredwg-web.js`, `libredwg-web.wasm` | LibreDWG compiled to WebAssembly (libredwg-web 0.9.3, unchanged) |
| `dwg.worker.js` | This add-on's worker: DWG in, DXF out |
| `LICENSE` | The GNU GPL, version 3 |
| `SOURCE.md` | Where to get the source code of the files above |
| `addon.json` | Version, licence, source and checksums; the app reads it to find the add-on |

To move to a newer libredwg-web release, change the version in `package.json`,
run `npm install --package-lock-only` in this folder, test it, and add the
release and its commit to `TESTED` in `install.mjs`.

## If you host the app for other people

Serving these files to other people's browsers distributes GPL-licensed object
code, and the GPL then asks two things of you: keep the licence with it (the
installed `LICENSE`), and give the people who receive it access to the
corresponding source code. The installed `SOURCE.md` sits next to the files and
points to that source: the libredwg-web repository at the matching release tag,
which holds LibreDWG's source, the WebAssembly bindings and the build scripts.
If you rely on a server you do not run (here, GitHub) for the source, you stay
responsible for it being available, so consider keeping your own copy of that
release. The add-on's own files (`dwg.worker.js`, `install.mjs`) are their own
source. This is a plain-language summary, not legal advice.

## What to expect

LibreDWG reads the DWG formats AutoCAD has saved in since R13 (1994), up to the
2018 format that current releases still use. In tests on LibreDWG's own test
drawings, 42 of 43 drawings in the 2000 to 2018 formats read the same as a DXF of
the same drawing written by other software (layers, entities, block references,
texts and line work), and the 43rd differed in one entity's layer; R13 and R14
drawings can lose old-style hatching (anonymous blocks), and drawings older than
R13 read only in part. Objects LibreDWG cannot convert yet are left out. See
[Testing](../../docs/testing.md#dwg-drawings). LibreDWG is not Autodesk software
and is not affiliated with Autodesk. AutoCAD is a registered trademark of
Autodesk, Inc.
