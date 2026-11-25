# Facility management

[README](../README.md) · [IFC viewer](ifc-viewer.md) · [Revit and Navisworks](revit-and-navisworks.md) · [Convert to IFC](convert.md) · [Asset register](asset-register.md) · [Facility management](facility.md) · [Development](development.md) · [Testing](testing.md)

bim-os turns a building's models into a facility workspace: its assets, rooms and systems, a maintenance plan with work orders, QR labels, a phone view for technicians, and live readings from the building's systems. The workspace is kept in the browser of each device (IndexedDB); nothing goes to a server. It moves between devices as files.

- [Getting around](#getting-around): the sidebar, search, and Home
- [Onboarding a building](#onboarding-a-building) from IFC, Revit, Navisworks or viewer extracts
- [Assets](#assets): the register, filters, the asset page, edits and checks, exports
- [Maintenance](#maintenance): the task library, plans, the due list, the calendar, work orders
- [Labels and the field app](#labels-and-the-field-app): QR labels, scanning, offline use, sharing changes
- [Live data](#live-data): MQTT, CSV readings, points on assets, alarms, Brick
- [The workspace](#the-workspace): files, devices, storage and limits

## Getting around

Every page has the same sidebar, grouped by what people come to do: **Home**; **Facility** (Assets, Maintenance, Live data, Labels, Field app); **Onboarding**; **Models** (IFC viewer, Revit, Navisworks, Convert to IFC); and **Settings**. It collapses to icons (the button at its foot, remembered per browser), and on phones it becomes a bar at the bottom with Home, Assets, Maintenance, Field and More. Overdue maintenance and active alarms show as counts next to their pages.

**Search** is in the header, and opens anywhere with <kbd>Ctrl</kbd>+<kbd>K</kbd> (<kbd>⌘</kbd>+<kbd>K</kbd> on a Mac) or <kbd>/</kbd>. One box finds:

- pages and actions ("new work order", "print labels", "back up the workspace", "connect a live data source", "switch theme");
- assets by code, name, tag, kind, type, manufacturer, model, serial number, bar code, room, floor or system;
- rooms, systems, work orders (by number, title, assignee, asset) and live points.

Every word typed must appear. An exact code or tag comes first, then names that start with the words typed, then the rest, grouped by type. A word with a colon picks what to look in: `asset:`, `room:`, `system:`, `wo:`, `point:`, `page:` (the chips under the box add them). Arrows move, <kbd>Enter</kbd> opens, <kbd>Esc</kbd> closes; with nothing typed it shows recent results, common actions and the pages. "See all … assets" opens the Assets page with the same words.

**Home** shows the building at a glance: assets and how much of their key information is filled, how many were checked on site, maintenance overdue and due in the next 14 days, open work orders, active alarms, the next maintenance due, the open work orders, the alarms, key information filled per field (each row opens the assets missing it) and assets by kind. Before a building is onboarded it shows the ways to start.

## Onboarding a building

*Onboarding* (`/onboard`) goes from model files to a workspace in six steps.

1. **Models.** Drop the IFC files (IFC2x3, IFC4, IFC4x3; `.ifc`, `.ifczip`, a zip or a folder holding them) or model extracts from the Convert page (`.eapk`, job files). Use all the disciplines together: architecture brings the rooms, mechanical, electrical, plumbing and fire bring the equipment, and assets are placed in the rooms of another model by their position. Revit and Navisworks files are read on the [Convert page](convert.md) first (Autodesk's cloud, the in-browser Revit reader or an Autodesk Viewer link); then *Use those instead* takes what that page has loaded. Files are read on this computer by web-ifc in a background worker; a 270 MB electrical model takes about half a minute.
2. **Building.** Name, site, address, site and building codes and the asset code pattern, prefilled from what the models say (IfcBuilding, IfcSite, the postal address, the currency). The floors are the models' storeys; storeys of different models at the same height, or with the same name or the same distinctive words ("L04 - Upper Concourse Level", "04-Upper Concourse Level"), are one floor.
3. **Assets.** Which categories are assets (the maintainable ones by default, with counts for everything read), how many assets, types, rooms and systems there are, how much of the key information the models carry (manufacturer, model, serial number, installation date, warranty, expected life, room, system), example asset codes, and the things to check.
4. **Fill gaps by type.** Assets of one type share make, model, expected life and warranty, so these are filled once per type for every type that lacks them. What is typed here is recorded as the team's information next to the model's.
5. **Maintenance.** Plans from the task library for the asset kinds chosen, from a start date, with first due dates spread over each task's first interval (so a thousand smoke detectors are not all due on one day), plus the maintenance tasks and frequencies the models carry. This can also be done later on the Maintenance page.
6. **Create.** The workspace is saved on this device (replacing the one there, after a warning). COBie 2.4, the asset register workbook and the single-line diagrams of the same register can be downloaded for the CAFM system and the handover file.

**What is read from an IFC file.** Every IfcElement except pipe, duct and cable runs and their fittings (IfcFlowSegment, IfcFlowFitting), openings and other feature elements, virtual elements and small components (fasteners, rebar, hangers). Equipment, terminals, devices, doors, furniture, transport elements, assemblies and proxies carry all their property sets and quantities, their type's property sets, classification references, the systems and zones they are grouped in, the storey and the room they are contained in or referenced by, the assembly they are part of, and the box of their geometry; other elements only what identifies them. IfcSpace brings rooms with their shapes (so equipment is placed in rooms by position when the model does not say which room it is in), number, name, areas and zones. IFC classes become the Revit categories the register works with (IfcAirTerminal is Air Terminals, IfcFireSuppressionTerminal of type SPRINKLER is Sprinklers, IfcOutlet of type DATAOUTLET is Data Devices…), unless the model's own properties name a category. Property names are matched as on the Convert page, with IFC's own names added (Pset_ManufacturerTypeInformation.ModelLabel, Pset_ServiceLife.ServiceLifeDuration, Qto_SpaceBaseQuantities.NetFloorArea…). IFC files written by bim-os itself are read back to the same register: what bim-os worked out (codes, kinds, relations, its systems) is left out and worked out again.

## Assets

The **Assets** page (`/assets`) is the register: a fast list of every asset (tens of thousands scroll smoothly) with code, name, kind, floor, room, manufacturer, model, serial number and status, sortable by any column.

**Searching and filtering.** The search box takes words and filters, which can be mixed: `kind:pump floor:L03`, `room:"EV.214"`, `system:"SA 1"`, `maker:daikin`, `model:`, `type:`, `category:`, `discipline:`, `fed:DB-01` (fed from a board), `status:incomplete` (also `complete`, `edited`, `verified`) and `missing:serial` (assets without a key field; `missing:` alone finds any gap). A quoted value must match the whole field; an unquoted one may be part of it (a status is always matched whole). The Floor, Kind, Discipline and Status menus write the same filters, and each active filter shows as a chip that removes it. The address keeps the search (`/assets?q=…`), so a filtered list can be bookmarked or sent.

**Selection.** Tick assets (or all shown) to edit one field on all of them, mark them checked on site, raise one work order for them, or print their labels.

**The asset page** opens beside the list (`/assets?asset=<GlobalId>`, full screen on phones):

- **Details**: every field the asset has, grouped (identity, product, dates and warranty, maintenance, location and systems, asset management, electrical, MEP data, fire safety); *Show all fields* lists the empty ones to fill in. Click a value to change it. A changed value shows the model's next to it, who changed it and when, and a button to go back to the model's. Changing a type's information (manufacturer, model, life, warranty…) offers to set it on the other assets of the type. *Mark checked on site* records that the asset was seen and its information confirmed, with a condition from 1 to 5 and notes.
- **Maintenance**: its planned tasks (pause, resume, raise a work order, add a task) and its work orders.
- **Live**: its points with a chart of recent readings, the alarm limits and active alarms.
- **Photos**: taken or added from files, kept with the workspace.
- **Connections**: room, floor, the board it is fed from, what it serves and what serves it, the asset it is part of and its parts, its systems.
- **Label**: its QR label, to print alone.
- **History**: every change, check and work order, newest first.

**Exports.** *Export* writes the assets shown (or selected, or all) to Excel or CSV with the edits applied: the register's columns plus status, the site check and the fields that were changed; the Excel file has a *Changes* sheet with every change next to the model's value, who made it and when.

## Maintenance

The **Maintenance** page (`/maintenance`) has five tabs.

- **Task library**: tasks per asset kind (by kind code: AHU, PMP, DB, SD, FD…), each with an interval, minutes on site, trade and whether it is statutory. The built-in library has about 80 typical tasks written for bim-os as a starting point: review them against the manufacturers' instructions, local regulations and any licensed schedule (such as SFG20) before relying on them. Tasks can be changed, added (kinds of the register without tasks are listed, one click adds a task for them) and deleted; *Update plans from the library* copies names and intervals to the plans made from them, keeping their due dates; *Reset* goes back to the built-in library.
- **Plans**: one per asset and task. *Plan more maintenance* creates plans for the kinds chosen (tasks already planned keep their dates). Every plan can be paused, given another interval or next due date, or removed; Excel export.
- **Due**: overdue tasks and those due in the next 14 or 30 days, 3 or 12 months, with search and floor and trade filters. Work orders are raised for the tasks ticked, or for every task shown without an open one, one per task; statutory tasks get high priority. Excel export.
- **Calendar**: a month at a time, with the tasks and open work orders due each day; a day opens its list.
- **Work orders**: open or closed, with search and priority and assignee filters, and Excel export (with the log on a second sheet). A work order opens beside the list: start, put on hold, complete (with the date and what was done), cancel or reopen; change its title, due date, priority, assignee, details and assets; add notes to its log. Completing a work order raised from a plan moves the plan on: the next due date is one interval after the date the work was done.

Work orders are numbered WO-0001, WO-0002… per workspace. *New work order* (also in the header search, on Home, on an asset and in the field app) records a fault or a job: what, kind (reactive, planned, inspection), priority (the due date follows it), assignee, details and assets.

## Labels and the field app

**Labels** (`/labels`) prints QR labels: the assets of a search (the Assets page's filters; a floor at a time works well) or those chosen on the Assets page or an asset's page. Sizes for label printers (50 × 25, 62 × 29, 100 × 50 mm, one label per page) and sheets (A4 3 × 8 and 2 × 7, US Letter 3 × 10). Each label has the QR code, the asset code and, as chosen, the name, floor and room, kind and building name. In the print dialog choose the paper or label size, scale 100% and no headers or footers.

The QR code holds a link to the asset in the field app when the app's address is set (*Use this app's address*, or Settings), so a phone's own camera opens the asset. Without one it holds just the asset code, which the field app's scanner reads. The address must be one phones can reach (not `localhost`).

The **field app** (`/field`) is the phone view for technicians:

- **Scan a label** with the camera (in browsers that read codes themselves: Chrome on Android, Edge; elsewhere the phone's camera app opens labels that carry a link), or type the code, or search. An asset is found by its code, GlobalId, tag, asset identifier, bar code or serial number.
- An asset shows what it is and where, its open work, and its key information to fill in or correct; **Check** records it as checked on site with a condition and notes; **Photo** takes a photo; **Fault** reports one as a work order.
- Home lists open work, recently opened assets and what was done on the phone.
- **Offline.** In production builds the app keeps its code and the pages visited, so once opened it works without signal; the workspace is in the phone's storage either way. Add it to the home screen for a full-screen app.
- **Share changes** sends what was done on the phone (changed and checked assets, their photos, work orders) as a change file through the phone's share sheet (mail, messaging, a shared drive) or as a download. It is brought into the main workspace under Settings (or on the phone's *Share changes* page): per field the later change wins, checks and photos are added, and work orders are merged; a new work order whose number is already taken gets the next free one.

To set a phone up, export the workspace on the computer (Settings), get the file onto the phone and open it under Settings or the field app's *Share changes*.

## Live data

**Live data** (`/live`) connects the building's systems while the app is open.

- **Sources.** An MQTT broker reached over WebSocket (`wss://`): Mosquitto, EMQX, HiveMQ or a cloud IoT hub. BACnet, Modbus, KNX and other systems reach it through a gateway that publishes their points; with retained messages the last value of every topic shows straight away. Set the topics to subscribe to (`+` and `#` wildcards), and where the value (and, optionally, the time) is in JSON messages (`value`, `data.temp`); plain messages are read as they are. The broker's password stays on the device and is never written to workspace files. Readings can also be imported from a CSV file (time, point, value per row; ISO dates or epoch seconds or milliseconds). The demo building has a simulator.
- **Points.** Topics that arrive become *new topics*, added one by one or all at once; each is linked to the asset its name contains (plant/AHU-01/supply-temp goes to AHU-01; names are compared without case, separators or leading zeros) and given a kind and unit from its name. A point can be renamed, linked to another asset or to a room, and given alarm limits: above, below, a value that means a fault, or quiet for so many minutes. The list shows each point's latest value, a two-hour trend and when it last reported; a point opens a chart with its limits.
- **Alarms** open when a reading crosses a limit, shows the fault value or stops coming, and end when the condition ends. Active alarms show in the header, on Home, on the asset and here, until acknowledged.
- **Brick.** *Brick (Turtle)* exports the building as a [Brick](https://brickschema.org) model: site, building, floors, rooms, equipment (with what feeds what and what it is part of) and points with the equipment or room they belong to. Classes are chosen from the asset and point kinds; check them before use.

The last 2,000 readings of each point are kept on the device.

## The workspace

**Settings** (`/settings`) has the facility's details, the name recorded with changes made on this device, the address used in labels, and the workspace file:

- *Export the workspace* writes everything (assets with their edits and checks, rooms, systems, the task library, plans, work orders, sources without passwords, points, alarms and photos) to one `.bimos` file, a ZIP archive with `bimos.json` and the photos. Keep it as a backup, open it on another device, or hand it on.
- *Open a workspace or change file* opens a workspace file (replacing the one on the device, after a warning) or merges a change file from the field app.
- *Remove from this device* deletes the workspace (typing the building's name confirms it).
- Storage: how much the app uses, and asking the browser to keep the data when space runs low.

One workspace is kept per browser. Private windows and some privacy settings do not allow the storage it needs.

**What to know.**

- Each device has its own copy of the workspace; files are how they meet. There is no live sync between devices yet (a self-hosted option is on the [roadmap](../ROADMAP.md)).
- The asset ids are the elements' IFC GlobalIds, the same as in the IFC files, COBie and the register workbook.
- The maintenance library, compliance groups, Uniclass codes and Brick classes are suggestions to review.
- Very large registers (40,000+ assets) work, but the workspace file and the first load grow with them; onboarding the equipment categories you maintain keeps things lean.
