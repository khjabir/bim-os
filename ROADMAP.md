# bim-os roadmap

bim-os is heading towards one goal first: **getting a building onboarded for facility management quickly, and keeping it maintained and connected**, with the building's own models as the map. Alongside that it keeps growing the model tools most people working with BIM need.

This page lists what is planned, how the app is organised, and how search works. Ticked items are built (Phase 1 is described in [docs/facility.md](docs/facility.md)); everything else is open for discussion and contributions (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Principles

- **Start from what exists.** Onboarding begins with the files a project hands over (IFC, Revit, Navisworks, Autodesk Viewer links) and keeps what they contain instead of retyping it.
- **One place per asset.** Everything about an asset (data, location, maintenance, live readings, photos, label) is on one page, reachable by search or by scanning its label.
- **No server needed.** Facility data stays in the browser on each device and is shared as files. Nothing is uploaded unless you choose a cloud route.
- **Open standards.** IFC, COBie, BCF, IDS and Brick in and out, so data is never locked in.
- **Everything findable.** One search box for pages, actions and data, and the same navigation on every page.

## Who it is for

| Who | What they need from bim-os |
| --- | --- |
| FM onboarding teams and CAFM administrators | An asset register built from the handover models, gaps found and filled, and data ready for their CAFM system |
| Maintenance managers | Planned maintenance from the asset list, a calendar, work orders and each asset's history |
| Technicians on site | Scan a label, see the asset, confirm it, record readings and photos, also without signal |
| Building operators | Live readings from the building management system on the assets they belong to, and alarms |
| BIM and information managers | Model checks, IFC conversion and handover data that meets the requirements |
| Designers and contractors | Model viewing, coordination and the deliverables that go with handover |

## How the app is organised

The same sidebar is on every page (on phones a bottom bar), grouped by what people come to do:

| Group | Page | Path | What it is for |
| --- | --- | --- | --- |
| | Home | `/` | The facility at a glance: assets, data completeness, maintenance due, open work orders, alarms; quick actions |
| Facility | Assets | `/assets` | The asset register: search, filter, open an asset, edit and verify, export |
| | Maintenance | `/maintenance` | Due list, calendar, work orders and the maintenance plans behind them |
| | Live data | `/live` | Connected-building readings, points mapped to assets, alarms |
| | Labels | `/labels` | QR labels for assets, ready to print |
| | Field app | `/field` | The phone view for technicians: scan, check, record |
| Onboarding | Onboard a building | `/onboard` | Step by step from model files to a maintained asset register |
| Models | IFC viewer | `/ifc` | View and analyse IFC, ifcZIP and Fragments models |
| | Revit | `/rvt` | Open Revit files and export IFC |
| | Navisworks | `/nwd` | Open Navisworks files and export IFC |
| | Convert to IFC | `/convert` | Build IFC from Revit, Navisworks, viewer links and floor plans |
| | Settings | `/settings` | Facility details, the workspace file, label and maintenance settings |

## How search works

- One search box in the header, also opened with <kbd>Ctrl</kbd>+<kbd>K</kbd> (<kbd>⌘</kbd>+<kbd>K</kbd> on a Mac) or <kbd>/</kbd>.
- It finds pages and actions ("print labels", "new work order"), assets (by code, name, tag, kind, type, manufacturer, model, serial number, room, floor or system), rooms, systems, work orders and live points.
- Results are grouped by type, best matches first: an exact code or tag, then names that start with the words typed, then the rest. Everything works from the keyboard.
- A word with a colon narrows the search: `asset:`, `room:`, `system:`, `wo:`, `point:` or `page:` choose what to look for; on the Assets page `kind:`, `floor:`, `room:`, `system:`, `maker:` and `status:` filter the list (`kind:pump floor:L03`).
- The Assets, Maintenance and Live data pages each have their own search box and filters, and scanning an asset's QR label opens that asset.

## Phase 1: onboarding, maintenance and connected buildings

### Navigation and search

- [x] Grouped sidebar on every page, collapsible, with a bottom bar on phones
- [x] Global search across pages, actions, assets, rooms, systems, work orders and points
- [x] Home dashboard with the facility's key figures and quick actions

### Facility workspace

- [x] Facility data kept in the browser (IndexedDB) on each device
- [x] Export and import the whole workspace as one file, to back it up or move it to another device
- [x] A demo facility to try everything without a model

### Onboarding

- [x] A step-by-step wizard: facility details, model sources, review, filling gaps, maintenance setup
- [x] IFC files as a source for the asset register (alongside Revit, Navisworks, viewer links and extracts)
- [x] Gaps filled once per type (manufacturer, model, warranty, expected life) instead of asset by asset
- [x] COBie 2.4, asset register and single-line diagram downloads at the end

### Assets

- [x] A fast register for tens of thousands of assets, with search, `field:value` filters and facets
- [x] An asset page with its data, location, relationships, maintenance, live readings, photos and label
- [x] Edits and verification recorded per field, with who and when, and kept apart from the model's values
- [x] Excel and CSV export with the edits applied

### Maintenance

- [x] A starting library of maintenance tasks per asset kind, with typical intervals to review
- [x] Plans generated for the assets from the library and from maintenance data in the model
- [x] A due list and a month calendar, overdue items highlighted
- [x] Work orders (planned and reactive) with status, priority, assignee, notes and completion, and each asset's history
- [x] Excel export of work orders

### Labels and field app

- [x] Printable QR labels with the asset code, name and location; the QR opens the asset in the field app
- [x] A phone view: scan (where the browser supports it) or search, check the asset, edit, take photos, mark it verified
- [x] Works offline once opened
- [x] Field changes exported from the phone and merged on the desktop

### Live data

- [x] MQTT over WebSocket as a live source (BACnet, Modbus and other systems through a gateway that publishes to MQTT)
- [x] Readings imported from CSV, and a simulator for trying it out
- [x] Points mapped to assets, with suggestions from point names
- [x] Alarm rules (high, low, no data) and an alarm list with acknowledgement
- [x] Live readings on the asset page
- [x] Brick (RDF/Turtle) export of the building, its equipment, rooms and points

## Phase 2: next

### Drawings to BIM (in the browser, no AI service or key)

- [x] DXF (any release, ASCII or binary) and PDFs exported from CAD read line by line: walls (pairs, fills, MLINE, wide polylines, curved), doors and their swing, windows, plain openings, rooms named from their texts, columns and the slab
- [x] Layer roles from AIA, ISO 13567, Revit and plain-language layer names in several languages, or from the line work; PDFs without layers grouped by pen
- [x] Several plans in one drawing as storeys; units and scales from the file, the sheet or the door sizes
- [x] IfcDoor and IfcWindow in openings that void the walls, IfcSpace, IfcColumn; .frag downloads
- [x] Scans and photos read like drawings: the ink turned into line work (solid walls, pens, arcs, hatching), text read in the browser (room names and numbers, dimensions, written scales, areas), the scale from dimensions, the written scale with the picture's resolution, door sizes or room areas, photos of a sheet straightened, TIFF scans, click-to-outline rooms
- [ ] Scans and photos, harder cases: small models trained on openly licensed plans for faint or broken doors and rooms on noisy scans and photos, more languages for the text
- [x] Room types from room names in several languages, with suggested Uniclass SL codes; values read from the drawing's notes and title block (levels, heights, thicknesses, units, names)
- [x] An optional on-device assistant (open models in the browser with WebLLM, or Chrome's built-in model): room types for names in any language, the notes' free text, and changes asked for in plain words, each shown before it is applied
- [ ] The assistant, further: changes that move or add walls, doors and rooms; questions about the plan; checked against real drawings from practice
- [ ] DWG through an optional add-on (LibreDWG is GPL, so it stays separate from the MIT code)
- [ ] Mitred wall corners at any angle, stairs, curtain walls, grids


### Onboarding and data

- [ ] COBie workbook import (a COBie file as a source, and edits merged back)
- [ ] Export templates for CAFM systems (for example Maximo, Planon, Archibus, SAP PM, Dynamics 365), with saved field mappings
- [ ] Operation and maintenance documents (manuals, certificates, warranties) linked to assets, with completeness checks
- [ ] Handover checks against the client's requirements, written as IDS
- [ ] buildingSMART Data Dictionary (bSDD) lookups to classify assets and check property names

### Maintenance

- [ ] Checklists and readings per task, and spare parts per asset type
- [ ] Maintenance by usage (run hours and counts from live data) as well as by calendar
- [ ] Printable work orders and a calendar feed (iCal) for other tools
- [ ] Imports from licensed maintenance libraries such as SFG20, for users who hold a licence

### Models

- [ ] The facility's models kept with the workspace, so any asset opens in 3D from its page
- [ ] BCF issues linked to assets and work orders
- [ ] Floor plans with asset pins, rooms and labels

### Live data

- [ ] Haystack tags alongside Brick
- [ ] History charts and energy dashboards per meter, board and floor
- [ ] Work orders raised from alarms

## Phase 3: later

- [ ] Optional self-hosted sync for teams (logins, roles, one shared register), with the browser-only mode kept
- [ ] Space management: occupancy, departments, moves
- [ ] Lifecycle and capital planning from install dates and expected life, and condition surveys
- [ ] Emergency maps: shut-off valves, isolators, fire equipment and escape routes from the model
- [ ] Energy metering hierarchy from meters and boards

## For everyone working with BIM

These are useful well beyond facility management and are open for contributions at any time:

- **openBIM:** BCF issues with viewpoints, IDS authoring, IFC validation, IFC editing, IFC 4.3 alignments for roads and rail.
- **Formats:** DXF export of drawings, glTF, OBJ, STL, USDZ and 3D Tiles export, Rhino and STEP import, gbXML export.
- **Coordination:** model comparison between versions, clash management with a rules matrix and history, saved views and walkthroughs, georeferencing.
- **Drawings and schedules:** plans, sections and elevations with dimensions and tags, room data sheets, door and equipment schedules.
- **Time, cost and carbon:** 4D sequencing, 5D cost from quantities, embodied carbon from quantities and EPD factors.
- **Checks:** MEP system tracing, rule-based code checks, fire strategy checks.
- **Reality capture:** point clouds with the model overlaid, scan-versus-model deviation.
- **Platform:** a command line for checks in CI, plugins, a desktop build, more languages (including right-to-left), VR and AR.
