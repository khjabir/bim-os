<div align="center">

# bim-os

**An open-source BIM and facility-management workbench that runs in your browser.**

Onboard a building from its models, keep its assets and maintenance in order, label and check them on site,<br>
connect live data from its systems, and view, analyse and convert IFC, Revit and Navisworks models.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 20.9](https://img.shields.io/badge/node-%3E%3D20.9-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Built on That Open Engine](https://img.shields.io/badge/built%20on-That%20Open%20Engine-6528D7)](https://github.com/ThatOpen)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Features](#features) · [Quick start](#quick-start) · [Configuration](#configuration) · [Documentation](#documentation) · [Roadmap](ROADMAP.md) · [Contributing](#contributing) · [License](#license)

</div>

---

bim-os is a local-first web app for running buildings with their models and for working with the models themselves. Models are opened, analysed and converted on your own machine, in WebAssembly and web workers, and a building's facility data stays in the browser; nothing is uploaded unless you choose one of the optional cloud routes (Autodesk Platform Services for Revit and Navisworks, or the AI assistant with your own API key).

> [!NOTE]
> bim-os was developed under the name *IFC Studio*. The app's header, the viewer extractor and the IFC property sets it writes (`IFCStudio_*`) still use that name; see [Development notes](docs/development.md#names-left-from-ifc-studio).

## Features

The same sidebar is on every page (a bottom bar on phones), grouped as Home, Facility, Onboarding and Models, and one search box in the header (<kbd>Ctrl</kbd>+<kbd>K</kbd> or <kbd>/</kbd>) finds pages, actions, assets, rooms, systems, work orders and live points.

### Facility management

- **Onboarding** (`/onboard`): a step-by-step wizard from the building's IFC files (any discipline, also .ifczip and folders), or Revit, Navisworks and viewer extracts read on the Convert page, to a facility workspace: building details prefilled from the models, floors from their storeys, the asset categories, the information the models carry, gaps filled once per type, maintenance planned, and COBie, the asset register and single-line diagrams to hand on. A 270 MB electrical IFC is read in the browser in about half a minute.
- **Assets** (`/assets`): a register that stays fast with tens of thousands of assets, one search box with filters (`kind:pump floor:L03 status:incomplete missing:serial`), facets, bulk edits; each asset's page with its information (changes kept next to the model's values, with who and when, and offered to the rest of its type), the site check, maintenance, live readings, photos, connections, label and history; Excel and CSV exports with the changes.
- **Maintenance** (`/maintenance`): a starting library of about 80 tasks per asset kind (to review), plans with first due dates spread out, the due list, a month calendar, and work orders (planned, reactive, inspection) with priorities, assignees, notes and completion that moves the plan on; Excel exports.
- **Labels and the field app** (`/labels`, `/field`): printable QR labels for label printers and sheets that open the asset on a phone; a phone view to scan or search, check, correct, photograph and report faults, working offline once opened, with changes shared as a file and merged on the desktop.
- **Live data** (`/live`): MQTT over WebSocket (BACnet, Modbus and other systems through a gateway), CSV readings and a simulator; points linked to assets from their names, alarm limits, an alarm list with acknowledgement, readings on the asset page, and a Brick (Turtle) export of the building.
- **Home** (`/`) shows the building at a glance; **Settings** (`/settings`) exports the whole workspace as one file to back it up or move it to another device. Everything is kept in the browser (IndexedDB); a demo building shows it all without a model.

### IFC viewer and model analysis (`/ifc`)

- Opens IFC2x3, IFC4 and IFC4x3 as `.ifc`, ifcZIP (`.ifczip`, including ZIP64) and Fragments (`.frag`): single files, several at once, or a whole project folder, with duplicate copies and extracts spotted and left out.
- Large models are streamed through [web-ifc](https://github.com/ThatOpen/engine_web-ifc) in a worker and drawn with That Open's Fragments engine (tested up to a 612 MB, 450,000-element file).
- Select, hide, isolate and X-ray; measure length, area, angle and volume; section planes and storey plans; orbit, first-person and plan navigation; three render styles.
- Analysis panels: spatial tree, rule-based search, grouping and colouring, quantity take-off with CSV export, sixteen data-quality checks, clash detection, [buildingSMART IDS](https://www.buildingsmart.org/standards/bsi-standards/information-delivery-specification-ids/) validation (290 of the 307 official test cases pass), and an optional AI assistant whose answers come from the loaded model.
- Exports whole models or selections as Fragments, selections as valid IFC subsets, and several models as one combined `.frag` or a `.zip` of `.frag` files.

### Revit and Navisworks (`/rvt`, `/nwd`)

- Revit files are read in the browser by the open-source [rvt-rs](https://github.com/DrunkOnJava/rvt-rs) reader (experimental, nothing uploaded), or exactly through Autodesk Platform Services and Revit's own IFC exporter.
- Navisworks models are shown in Autodesk's viewer through Autodesk Platform Services, with selection at three levels, grouping, search, and IFC export of the selection, the visible objects or the whole model.

### Convert to IFC (`/convert`)

- Builds IFC4 files from Revit and Navisworks models, models shared in the Autodesk Viewer (read on the viewer page by a bookmarklet), floor plans (DXF, DWG with an optional add-on, PDF, scans, photos), or a mix of them.
- One IFC per discipline plus a federated model, sharing GlobalIds, site and storeys, so the files line up.
- IFC classes and predefined types from Revit categories and family names, Revit GUIDs kept as GlobalIds, type objects, materials, surface styles, textures and vertex colours, and shared shapes written once.
- Floor plans to BIM, in the browser with no AI service or key: DXF drawings (any release, ASCII or binary), DWG drawings (with the optional DWG add-on, which converts them to DXF in the browser) and PDFs exported from CAD are read line by line into walls, doors, windows, rooms with their names and numbers, columns and the slab, by layer (roles guessed from AIA, ISO 13567 and Revit layer names, or from the lines); scans, photos and images are read the same way after their ink is turned into line work, with their text read by OCR (room names, dimensions and the scale; photos of a sheet are straightened first). Several plans in one drawing become storeys. Doors and windows are written in openings that void the walls, rooms as IfcSpace, after a check in the plan editor.
- Room types from room names (with suggested Uniclass 2015 SL codes) and values read from the drawing's notes (levels, heights, thicknesses, units, names). An optional on-device assistant runs a free, openly licensed model in the browser (Qwen3.5 with WebLLM, or Chrome's built-in model): it types rooms whose names the rules do not know, in any language, reads the notes' free text, and turns changes asked for in plain words into edits of the plan, each shown before it is applied. Nothing is sent anywhere.
- Each IFC can also be downloaded as That Open Fragments (.frag).
- A 3D preview with materials and textures before anything is generated.

### Asset information for facilities management

- An asset register of the model's maintainable equipment: make, model, serial number, tag, installation date, warranty, expected life, PPM, room, systems, and what serves what.
- Electrical distribution as a board hierarchy with circuits and loads, drawn as single-line diagrams.
- MEP technical data converted to one unit per field, and fire and life-safety data (panels, loops, zones, ratings).
- About 140 asset kinds with short codes, suggested Uniclass 2015 classes and compliance groups, plus location and asset codes from a pattern you set.
- Three outputs: a COBie 2.4 workbook, an asset-register workbook and single-line diagrams (HTML). The same data can also be written into the IFC files (Pset_ManufacturerTypeInformation, Pset_Warranty, Pset_ServiceLife, systems and zones).

### Command line

- `npm run convert` turns IFC files, ifcZIP archives or whole folders into Fragments outside the browser.
- `npm run combine` joins `.frag` files into one.

## How it works

bim-os is a [Next.js](https://nextjs.org) 16 app (React 19, TypeScript, Tailwind CSS). Viewing is done by [That Open Engine](https://github.com/ThatOpen) on [three.js](https://threejs.org); IFC parsing is done by web-ifc. Heavy work (converting, writing IFC, reading plans and pictures, building the asset register) runs in web workers; text on pictures is read with [tesseract.js](https://github.com/naptha/tesseract.js) from the app's own copy of the engine, the optional on-device assistant runs its model with [WebLLM](https://github.com/mlc-ai/web-llm) on WebGPU in a worker, and the optional DWG add-on runs [GNU LibreDWG](https://www.gnu.org/software/libredwg/) (WebAssembly) in a worker of its own. The only server code is a small set of API routes that call Autodesk Platform Services and the Anthropic API with keys kept on the server.

```mermaid
flowchart LR
  subgraph browser["Your browser"]
    pages["Pages<br/>/ · /assets · /maintenance · /live · /labels · /field · /onboard<br/>/ifc · /rvt · /nwd · /convert"]
    workers["Web workers<br/>web-ifc · rvt-rs · IFC writer<br/>plan tracing · asset register"]
    engine["That Open Engine<br/>three.js · Fragments"]
    store[("IndexedDB<br/>facility workspace")]
  end
  subgraph server["Next.js API routes (optional)"]
    assistant["/api/assistant"]
    aps["/api/aps/*"]
  end
  pages <--> workers
  pages <--> engine
  pages <--> store
  pages -- "MQTT over WebSocket" --> broker["Your MQTT broker (optional)"]
  pages -- "questions" --> assistant
  assistant --> anthropic["Anthropic API"]
  pages -- "RVT / NWD files" --> aps
  aps --> autodesk["Autodesk Platform Services"]
```

## Quick start

You need [Node.js](https://nodejs.org) 20.9 or newer and npm. bim-os has been tested in Chromium-based browsers (Chrome, Edge).

```bash
git clone https://github.com/khjabir/bim-os.git
cd bim-os
npm install
npm run dev
```

Open <http://localhost:3000>. The IFC viewer, the analysis tools, the in-browser Revit reader, floor-plan conversion and the Autodesk Viewer extractor work without any keys.

For a production build:

```bash
npm run build
npm start
```

## Configuration

Everything is optional. Copy `.env.example` to `.env.local`, fill in what you need and restart the server. The values are read only by the server-side API routes and never reach the browser.

| Variable | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | The AI assistant in the IFC and RVT viewers. `ANTHROPIC_MODEL` picks the model (default `claude-sonnet-5-5`). |
| `APS_CLIENT_ID`, `APS_CLIENT_SECRET` | Revit cloud conversion, the Navisworks viewer and the cloud routes of the Convert page. Create an app at <https://aps.autodesk.com> with the Data Management and Model Derivative APIs. |
| `APS_REGION` | Where uploads are stored: `US` (default), `EMEA`, `AUS`, `CAN`, `DEU`, `IND`, `JPN` or `GBR`. The Navisworks viewer is set up for `US`, `EMEA` and `AUS`. |
| `APS_BUCKET` | A bucket name of your own. By default one is derived from the client id; uploads are kept for 24 hours. |

> [!WARNING]
> The API routes spend your API credit and cloud quota. They accept requests from the app's own pages only, which suits running bim-os on your own machine. Put real authentication in front of them before hosting it anywhere others can reach.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on port 3000 |
| `npm run build`, `npm start` | Production build and server |
| `npm run typecheck` | TypeScript check |
| `npm run convert -- <file or folder>` | Converts IFC and ifcZIP files to Fragments on the command line (`--combined all.frag` also joins a folder's models into one file) |
| `npm run combine -- a.frag b.frag -o all.frag` | Joins Fragments files into one |
| `npm run assets` | Copies the web-ifc, Fragments and pdf.js workers into `public/` (also runs on install, dev and build) |
| `npm run build:rvt-wasm` | Rebuilds the in-browser Revit reader from rvt-rs (needs Rust) |
| `npm run addon:dwg` | Installs the optional DWG add-on (GPL-3.0-or-later) into `public/addons/dwg/`; `-- --remove` removes it. See [addons/dwg](addons/dwg/README.md) |

## Documentation

| Page | Contents |
| --- | --- |
| [IFC viewer](docs/ifc-viewer.md) | Opening files, large models, ifcZIP, project folders, exports, the combined file, the command line, tools and panels |
| [Revit and Navisworks](docs/revit-and-navisworks.md) | The in-browser Revit reader, the Autodesk cloud route and the Navisworks viewer |
| [Convert to IFC](docs/convert.md) | Sources, Autodesk Viewer links, floor plans, assembling, generating, materials and textures |
| [Asset register](docs/asset-register.md) | What is read for each asset, electrical distribution, technical and fire data, codes, and the COBie, register and diagram outputs |
| [Facility management](docs/facility.md) | Navigation and search, onboarding, assets, maintenance, labels and the field app, live data, the workspace file |
| [Development notes](docs/development.md) | Project layout, pinned dependency versions, rebuilding the Revit reader, names left from IFC Studio |
| [Testing and known limits](docs/testing.md) | What has been tested, with which models, and what has not |

## Project layout

```
src/app/          Pages (facility pages, /ifc, /rvt, /nwd, /convert) and API routes (/api/assistant, /api/aps/*)
src/components/   The interface: app shell and search, facility pages (fm/), viewer, Navisworks page, Convert page,
                  charts, shared UI
src/lib/          Facility workspace (fm/), engine, IFC worker, analysis, assistant, Revit and Autodesk clients,
                  IFC writers, converter (with the asset register in convert/assets/) and utilities
public/           The viewer extractor, the rvt-rs WebAssembly reader and sample files
scripts/          Asset copy, command-line converter and combiner, rvt-rs rebuild
addons/dwg/       The optional DWG add-on (GPL-3.0-or-later, installed on request)
docs/             Documentation
```

A fuller map is in [Development notes](docs/development.md#project-layout).

## Status

bim-os is at version 0.1 and changes quickly. Things to know before relying on it:

- Reading Revit files in the browser is experimental: rvt-rs recovers part of a project, with simplified shapes and incomplete parameters. Do not measure or coordinate from that view.
- The Autodesk Platform Services routes and the AI assistant were tested against stand-ins, not the live services.
- Models converted from Autodesk viewer data keep the viewer's triangles; parametric solids cannot be recovered from it.
- Very large federated projects are limited by the memory a browser tab can use; the [IFC viewer docs](docs/ifc-viewer.md#how-much-a-folder-can-hold) give measured figures.
- Facility data is kept per browser and moves between devices as files; there is no live sync between devices yet. Live data arrives only while the app is open.
- Scanning labels inside the field app needs a browser that reads codes itself (Chrome on Android, Edge); elsewhere the phone's camera app opens labels that carry the app's address.
- Only Chromium-based browsers have been tested.

[Testing and known limits](docs/testing.md) has the details.

## Contributing

Bug reports, sample files that break something (if you may share them), fixes, features and documentation are all welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started, and follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, see [SECURITY.md](SECURITY.md) instead of opening an issue.

## Acknowledgements

bim-os stands on these projects:

| Project | Used for | Licence |
| --- | --- | --- |
| [That Open Engine](https://github.com/ThatOpen) (components, components-front, fragments) | Viewer engine and the Fragments format | MIT |
| [web-ifc](https://github.com/ThatOpen/engine_web-ifc) | Reading IFC (WebAssembly) | MPL-2.0 |
| [three.js](https://threejs.org), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh), [camera-controls](https://github.com/yomotsu/camera-controls) | 3D rendering, picking and navigation | MIT |
| [rvt-rs](https://github.com/DrunkOnJava/rvt-rs) 0.17.0 | In-browser Revit reader, vendored in `public/rvt/` with its licence, notice and crate list | Apache-2.0 |
| [pdf.js](https://github.com/mozilla/pdf.js) | Floor-plan PDFs | Apache-2.0 |
| [tesseract.js](https://github.com/naptha/tesseract.js) (with tesseract.js-core and its English model) | Text on pictures of plans | Apache-2.0 |
| [UTIF.js](https://github.com/photopea/UTIF.js) (utif2) | TIFF scans | MIT |
| [WebLLM](https://github.com/mlc-ai/web-llm) (with Apache TVM's web runtime, XGrammar and tokenizers-cpp) | The on-device assistant | Apache-2.0 |
| [GNU LibreDWG](https://www.gnu.org/software/libredwg/), built for the browser by [libredwg-web](https://github.com/mlightcad/libredwg-web) 0.9.3 | DWG drawings, only in the optional DWG add-on (`addons/dwg/`), which is installed separately and is not part of the MIT code | GPL-3.0-or-later |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | QR codes on asset labels | MIT |
| [FlatBuffers](https://github.com/google/flatbuffers) | Writing combined Fragments files | Apache-2.0 |
| [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) | The AI assistant | Apache-2.0 |
| [Next.js](https://nextjs.org), [React](https://react.dev), [Tailwind CSS](https://tailwindcss.com), [Zustand](https://github.com/pmndrs/zustand), [TanStack Virtual](https://tanstack.com/virtual), [Lucide](https://lucide.dev) | App framework and interface | MIT (Lucide: ISC) |

- The Autodesk viewer and Autodesk Platform Services are Autodesk's proprietary software and services. They are not part of this repository: the viewer is loaded from Autodesk's servers, and using either is subject to Autodesk's terms.
- The sample model in `public/samples/lmv-shaver/` comes from Autodesk's `viewer-javascript-offline.sample` repository (MIT, licence included).
- The on-device assistant's models are not part of this repository: they are downloaded by the browser when the assistant is first used, from Hugging Face ([Qwen3.5](https://huggingface.co/Qwen/Qwen3.5-2B), Apache-2.0, in MLC's WebGPU builds), or are Chrome's built-in model, which Chrome provides under Google's terms.
- IFC and IDS are open standards of [buildingSMART International](https://www.buildingsmart.org). Uniclass 2015 codes and titles are © [NBS](https://uniclass.thenbs.com).

Autodesk, Revit and Navisworks are registered trademarks of Autodesk, Inc. bim-os is not affiliated with or endorsed by Autodesk, buildingSMART, That Open Company or NBS.

## License

bim-os is released under the [MIT License](LICENSE). Third-party components keep their own licences, listed above. The optional DWG add-on in `addons/dwg/` is the exception: it is licensed under the GNU GPL, version 3 or later, because it runs GNU LibreDWG. It is installed only on request and stays out of the app's dependencies and bundle (see [addons/dwg](addons/dwg/README.md)).
