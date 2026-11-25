# Development notes

[README](../README.md) · [IFC viewer](ifc-viewer.md) · [Revit and Navisworks](revit-and-navisworks.md) · [Convert to IFC](convert.md) · [Asset register](asset-register.md) · [Facility management](facility.md) · [Development](development.md) · [Testing](testing.md)

## Project layout

```
src/app/                  Pages (/, /assets, /maintenance, /live, /labels, /field, /onboard, /settings, /ifc, /rvt, /nwd,
                          /convert) and API routes (/api/assistant, /api/aps/*)
src/components/shell/     The frame of every page: sidebar, phone bar, header search (the search palette), theme
src/components/fm/        Facility pages: Home, assets, maintenance, labels, field app, live data, onboarding, settings
src/components/viewer/    The IFC workbench: toolbar, overlays, side panels
src/components/nwd/       The Navisworks page
src/components/convert/   The Convert page: sources, viewer link, plan editor, assembly, generation
src/lib/engine/           ViewerEngine: That Open world, models, selection, tools, exports
src/lib/ifc/              The conversion worker (IFC to Fragments, IFC subset extraction) and ifcZIP unpacking
src/lib/collection/       Opening a folder: finding the models, choosing one copy of each, spotting repeated models
src/lib/fragments/        Joining several Fragments models into one file
src/lib/data/             Element index, properties and units shared by the analysis tools
src/lib/analysis/         Search, grouping, quantities, health checks, clash detection, IDS
src/lib/assistant/        The viewers' AI assistant (Claude, with your own key): tools and the agent loop
src/lib/ondevice/         The on-device assistant: open models with WebLLM in a worker, Chrome's built-in model, JSON tasks
src/lib/rvt/              Revit import (in-browser and cloud)
src/lib/aps/              Autodesk Platform Services: server calls and browser client
src/lib/lmv/              Autodesk viewer session, object grouping, IFC class guessing
src/lib/ifc-writer/       IFC4 writer for tessellated models
src/lib/convert/          Converter: extract reader, element model, materials, classes, disciplines, storeys, IFC4 writer, 3D preview
                          with instancing, conversion worker, plans (plans/: DXF reader, PDF line work, pictures read
                          as line work (raster.ts), their text (ocr.ts) and scale (pictureScale.ts), photos
                          straightened (photo.ts), recognition of walls, doors, windows, rooms and columns, the older
                          picture tracer, room types (roomTypes.ts), notes (planNotes.ts), changes in words
                          (planEdits.ts), DWG through the add-on (dwgAddon.ts)), asset register and COBie (assets/)
src/lib/fm/               The facility workspace: data model, IndexedDB storage and store, search and filters, task
                          library and scheduling, workspace and change files, QR codes, alarms, Brick, the demo,
                          live data (live/: MQTT over WebSocket, the simulator, CSV readings)
src/lib/convert/ifc-source.ts  IFC files (web-ifc) as a source of the asset register, like a viewer extract
src/lib/utils/xlsx.ts     A small Excel (.xlsx) writer for the asset workbooks
public/convert/           The viewer extractor (bookmarklet and in-app)
public/rvt/               rvt-rs WebAssembly build and its worker
public/addons/dwg/        The DWG add-on once installed (not in git)
public/sw.js              Service worker for offline use (production builds), with manifest.webmanifest and icons/
scripts/                  Asset copy, command-line converter and combiner, rvt-rs rebuild
addons/dwg/               The optional DWG add-on (GPL-3.0-or-later): its worker, install script and pinned package
```

`npm install` copies the web-ifc WebAssembly files, the Fragments worker, the pdf.js worker and the Tesseract OCR worker, engine and English model (`public/ocr/`, about 15 MB, of which a browser loads about 7 MB the first time it reads a picture's text) from `node_modules` into `public/` (`scripts/copy-assets.mjs`), so the app serves them itself instead of fetching them from a CDN.

## Pinned versions

That Open Engine is at its latest release at the time of writing: `@thatopen/components` 3.6.0, `@thatopen/components-front` 3.6.1, `@thatopen/fragments` 3.6.1. Three other packages are pinned on purpose:

- **`web-ifc` 0.0.77**, not 0.0.78. The single-thread browser build of 0.0.78 does not match its own JavaScript API (`StreamMeshes called with 4 arguments, expected 3`), which breaks IFC conversion in the browser. 0.0.77 is the version That Open's packages are developed against.
- **`three` 0.184.0** (and `@types/three`). From 0.185, three's `TTFLoader` imports a library from a CDN URL, which Turbopack cannot bundle; 0.184 is also That Open 3.6's own development version.
- **`three-mesh-bvh` 0.9.9**, matching what That Open bundles.
- **`pdfjs-dist` 6.4.299** renders floor-plan PDFs on the Convert page. Its worker is copied to `public/pdfjs/` like the other runtime assets.
- **`@mlc-ai/web-llm` 0.2.89** runs the on-device assistant's open models (Apache-2.0). It is only loaded in its own worker (`src/lib/ondevice/webllm.worker.ts`), so pages that do not use the assistant never load it. The model ids, their WebGPU libraries (`raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs`, `v0_2_87/base`) and their weights (`huggingface.co/mlc-ai`) come from its built-in model list, so an upgrade can change which builds are fetched: check `prebuiltAppConfig` when updating. Each model has a 16-bit build (`q4f16_1`) for GPUs with `shader-f16` and a 32-bit one (`q4f32_1`) for the others; both download the same weights.

`src/lib/shims/three.js` re-exports three and adds a few WebGPU-only names as `undefined`. That Open probes for them, and Turbopack rejects a namespace member that does not exist.

`flatbuffers` 25.2.10 is a direct dependency: the combined export writes the Fragments file format itself. It is the version `@thatopen/fragments` 3.6.1 depends on, so the two share one copy.

`@thatopen/ui` is not used: the interface is plain React and Tailwind.

## Rebuilding the Revit reader

The in-browser Revit reader in `public/rvt/` is [rvt-rs](https://github.com/DrunkOnJava/rvt-rs) 0.17.0 compiled to WebAssembly, and it is committed already built. Rebuild it only to move to a newer rvt-rs release. It needs git, Rust (rustup and cargo) and curl:

```bash
npm run build:rvt-wasm                       # the pinned release
RVT_RS_TAG=v0.18.0 npm run build:rvt-wasm    # another release
```

Keep `public/rvt/LICENSE`, `NOTICE` and `THIRD-PARTY-CRATES.txt` up to date with the release you build.

## The DWG add-on

DWG floor plans are read by [GNU LibreDWG](https://www.gnu.org/software/libredwg/), compiled to WebAssembly by [libredwg-web](https://github.com/mlightcad/libredwg-web) (`@mlightcad/libredwg-web` 0.9.3). LibreDWG is GPL-3.0-or-later, so it is kept out of the MIT app as an optional add-on in `addons/dwg/`, with its own licence:

```bash
npm run addon:dwg              # install it into public/addons/dwg/ (or update it to the pinned version)
npm run addon:dwg -- --remove  # remove it
```

`addons/dwg/install.mjs` runs `npm ci` in `addons/dwg/` (its own `package-lock.json`, no install scripts), so the package never enters the app's `node_modules` or bundle. It checks that the module loads, then copies `libredwg-web.js` and `.wasm`, the add-on's worker (`dwg.worker.js`), the GPL text and a `SOURCE.md` pointing to the corresponding source into `public/addons/dwg/`, with an `addon.json` the app looks for. `public/addons/` is git-ignored.

The app's side is `src/lib/convert/plans/dwgAddon.ts`. `next.config.ts` sets `NEXT_PUBLIC_DWG_ADDON` when the add-on is installed as the app is built (or the development server starts). When a DWG is added, the app reads the release from the file's first bytes and, if that flag is set, fetches `/addons/dwg/addon.json`; if the add-on is there and speaks the same message format (`protocol`), it starts `/addons/dwg/dwg.worker.js` as a module worker from that URL (a plain URL, so the bundler leaves it alone), sends it the file and gets DXF bytes back. The DXF goes through the same reader as any DXF. One worker converts one file and is terminated afterwards, which frees its WebAssembly memory; it is stopped after a time limit that grows with the file's size.

Restart `npm run dev` after installing or removing it, and install it before `npm run build`: the flag is fixed when the app is built or the development server starts.

To move to a newer libredwg-web release, change its version in `addons/dwg/package.json`, run `npm install --package-lock-only` there, test it (see [Testing](testing.md#dwg-drawings)) and add the release's tag commit to `TESTED` in `install.mjs`. Avoid 0.8.7 to 0.8.9: their DWG-to-DXF conversion crashes.

## Names left from IFC Studio

bim-os was developed as *IFC Studio*, and the name is still used where changing it would break files or habits:

- the page titles and header of the app;
- the viewer extractor: the *IFC Studio extractor* bookmarklet, its *Send to IFC Studio* button, `public/convert/ifcstudio-extractor.js` and extract files named `ifcstudio-*`;
- the property sets written into IFC files: `IFCStudio_Source`, `IFCStudio_Provenance`, `IFCStudio_Asset`, `IFCStudio_Electrical`, `IFCStudio_Technical` and `IFCStudio_FireSafety`;
- the browser storage key for the colour theme (`ifc-studio-theme`).

Renaming the property sets or the extract files would make IFC files and extracts made so far look different from new ones, so it should be done deliberately, with a note in the release.
