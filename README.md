# IFC Studio

A Next.js app with three BIM viewers and a converter:

- **IFC** (`/ifc`): opens IFC, ifcZIP and Fragments files with [That Open Engine](https://github.com/ThatOpen), one at a time or a whole project folder at once, with analysis tools, and exports Fragments (`.frag`) and IFC.
- **RVT** (`/rvt`): opens Revit files, either in the browser or through Autodesk's cloud, and exports selected elements as IFC.
- **NWD** (`/nwd`): opens Navisworks files through Autodesk's cloud and exports selected objects as IFC.
- **Convert** (`/convert`): builds IFC files from Revit and Navisworks models, Autodesk Viewer links and floor plans (PDF or images), one per discipline plus a federated one, and opens them in the IFC viewer.

## Quick start

Needs Node.js 20.9 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The IFC viewer and the in-browser Revit reader work straight away. The AI assistant, Revit cloud conversion and the Navisworks viewer need keys: copy `.env.example` to `.env.local`, fill it in and restart the server (see [Keys](#keys)).

For a production build: `npm run build`, then `npm start`.

## The IFC viewer

**Opening files.** Use *Open files* or *Open folder*, or drop files or a folder on the 3D view. IFC2x3, IFC4 and IFC4x3 files are converted to Fragments in a background worker, whether they come as `.ifc` or packed as ifcZIP (`.ifczip`); `.frag` files open directly. Several models can be open at once.

**Large files.** The IFC is never read into memory as a whole. A worker hands the file to web-ifc in 64 MB pieces straight from disk, the result is a compact Fragments model, and the worker is discarded afterwards so its memory goes back to the browser. The Fragments engine then draws only what is in view. Measured in headless Chromium on two CPU cores with software rendering (a normal desktop is faster):

| File | Size | Elements | Time to open |
| --- | --- | --- | --- |
| FZK-Haus (IFC4) | 2.5 MB | 90 | 1.2 s |
| rac_basic_sample_project (IFC4) | 24 MB | 467 | 3.3 s |
| HITOS hospital (IFC2x3) | 61 MB | 2,318 | 8.5 s |
| Synthetic field of elements | 202 MB | 150,000 | 44 s |
| Synthetic field of elements | 612 MB | 450,000 | 2 min 43 s |

The two synthetic files are simple boxes with property sets: they show that entity count and file size are handled, not how long heavy solid geometry takes. The real limit is the memory a browser tab can give web-ifc (4 GB at most). For a file that will not convert in the browser, convert it once on the command line and open the result:

```bash
npm run convert -- path/to/model.ifc          # writes path/to/model.frag
npm run convert -- path/to/model.ifczip       # the same, from an ifcZIP
npm run convert -- model.ifc out/model.frag
```

A `.frag` opens in seconds (the 150,000-element model above: 5.8 s), so exporting one is also the way to reopen a model quickly.

**ifcZIP.** An `.ifczip` is a ZIP archive with an IFC inside. It opens like the IFC it holds: the model is unpacked in a worker and then converted to Fragments in the usual way, so every tool and panel works on it and it exports to `.frag` and to IFC like any other model. The `.ifc` button on its model card downloads the unpacked IFC. A plain `.zip` works too, and when an archive holds several `.ifc` files each one opens as its own model. The first bytes of a file decide how it is read, not its name, so an archive that was renamed to `.ifc` still opens.

The archive is not loaded into memory. Only its table of contents is read, the model is unpacked as a stream, and the browser stores the result (Chromium moves it to disk once it grows; a private window keeps it in memory, which held about 2 GB in testing). A model that was stored without compression is read in place, without copying. A compressed one is checked, as it is unpacked, against the size and CRC-32 recorded in the archive, so a damaged archive is reported instead of opening as a broken model. Unpacking is quick next to converting: the 612 MB model above unpacked from its 123 MB ifcZIP in about 5 s. Archives beyond 4 GB (ZIP64) are read: a 4.6 GB archive with a small model behind the 4 GB mark opened in under 5 s, because nothing but the table of contents and the model is read.

Not opened, each with a message that says why: password-protected archives, split (multi-volume) archives, compression other than Deflate (Deflate64, bzip2, LZMA and the like) and ifcXML models inside an archive. On the command line the model is unpacked to a temporary file first, which needs as much free disk space as the unpacked IFC; set `TMPDIR` (`TEMP` on Windows) to choose the disk. An archive with several models gives one `.frag` per model next to the archive.

**Folders of models.** *Open folder*, or dropping a folder on the 3D view, opens a project that comes as many files: one model per discipline, perhaps a federated model of everything, each perhaps also as `.ifczip` or already converted to `.frag`. The folder is read with its subfolders and with the archives in it, and a dialog shows what was found and what will be opened:

- *One copy of each model.* Files of the same name in one folder (`model.ifc`, `model.ifczip`, `model.frag`) are one model in several formats. The `.frag` is opened when it is not older than the IFC, because it needs no converting; the IFC next to it still serves IFC export. Otherwise the `.ifc` is opened, and the `.ifczip` only when it is the only copy. A `.frag` in another subfolder is matched to the IFC of the same name, so converted files can live in a folder of their own.
- *Nothing drawn twice.* Each model is read through once for its schema, its description and the GlobalIds of its elements. A model is left out when at least 98 % of its elements are also in the other models: a second copy under another name, an extract of a larger model, or a federated model whose parts are in the folder too. In that last case the parts are the ones kept, because they can be shown and hidden one by one. The dialog names what was left out and why, and ticking a model opens it anyway.
- *Memory first.* Converting an IFC needs many times the memory of the model it produces, so a conversion on top of a full scene is what runs a tab out of memory. The models that need converting are therefore opened first, the largest first, while little else is shown; `.frag` files, which only need loading, follow. Each model is shown as soon as it is converted, unless that would crowd a large conversion still to come: then it waits, as a small `.frag` in the browser's storage, until that conversion is done. With models of falling size nothing waits; with many large models of similar size the later ones do, and arrive together at the end. The model list keeps the order of the dialog.

The models are placed by the coordinates in the files: the first one sets the origin of the scene and every further one is shifted onto it, so models that share a base point line up as they do in the authoring tool. (This is That Open's automatic coordination, and it applies to models opened one by one as well.) The camera frames the models as they arrive until you move it. Cancelling stops the folder and keeps the models that have arrived.

When a folder is picked, Chrome asks "Upload N files to this site?". That is the browser's wording for letting a page read a folder; nothing leaves the computer, as with single files. Dropping a folder asks nothing.

**Showing and hiding models.** Every model in the *Models* panel has an eye switch. Models that were opened together, from one folder or one archive, form a group with a switch of its own, and the head of the list has *Show all* and *Hide all*. A model's menu adds *Show only this model* and *Zoom to model*; a group's menu has the same for the group. From four models on, each model takes one line and an arrow opens its details. A hidden model stays loaded: it comes back at once, and search and the analysis panels still cover it.

**Exporting.**

- *Whole model as Fragments*: the `.frag` button on the model card, or *Model actions > Export .frag*.
- *Every model as its own Fragments file*: *Export models* (the download button at the head of the model list) *> All N models as .frag files (.zip)*. One `.frag` per model in a single `.zip`, each the same file *Export .frag* gives. Unpacked into the project folder, they make the folder open without converting next time; the `.zip` also opens here as it is.
- *All models as one Fragments file*: *Export models > All N models as one combined .frag*. See below. Both exports are also offered for the models currently shown and, in a group's menu, for that group.
- *Selection as Fragments*: select elements, then *Export > Selection as Fragments* in the selection bar (one file per model).
- *Selection as IFC*: *Export > Selection as IFC*. The result is a valid IFC with the selected elements and what they depend on (geometry, materials, property sets, spatial structure). Walls keep their openings, doors and windows, and assemblies keep their parts, so the file stays consistent. This needs the original IFC, so it is available for models converted in this session and for a `.frag` opened from a folder that also holds its IFC, not for a `.frag` opened on its own.
- *Whole model as IFC*: the `.ifc` button on the model card downloads the source IFC.

**The combined file.** A combined `.frag` is a single Fragments model that holds every element of the models it was made from, with their attributes, property sets, relations and spatial structure, placed as the viewer shows them. It opens anywhere a `.frag` does, in one step. The models are joined, not reinterpreted: local ids are renumbered so that they do not collide, GlobalIds stay as they are, and the spatial structures stand side by side, one project branch per model in the *Tree* panel. Something that several models carry, such as the storeys every discipline file repeats, is therefore there once per model. The file's metadata lists the models it was made from.

Two limits. The uncompressed result must stay below 2 GB, which is what the Fragments format (FlatBuffers) can address; beyond that the export says so instead of writing a broken file. And it is put together in memory, which at its peak took about twice the uncompressed size of the result on top of the loaded models: 1.1 GB for five of the Etihad models (0.58 GB uncompressed, a 210 MB file, 1 min 28 s). Joining all ten (1.4 GB uncompressed) on top of the 3.4 GB they take when loaded was more than the 6 GB test machine had, and the tab ran out of memory; the export says how much it will need before it starts. The command line does the same joining without a browser tab's limits (next section): the ten took 57 s and 2.1 GB there, for a 483 MB file. A combined file is one model: its parts can no longer be switched on and off from the model list, and it unpacks all at once when it is opened. For working, the folder or the separate `.frag` files are the better set.

**Command line.** The converter also takes a folder, and a second command joins `.frag` files:

```bash
npm run convert -- path/to/folder                        # a .frag next to every IFC in the folder
npm run convert -- path/to/folder --combined all.frag    # the same, plus one combined .frag
npm run combine -- a.frag b.frag c.frag -o all.frag      # joins .frag files that exist already
```

Folder mode makes the same choices as *Open folder* (one copy of each model, repeated models left out; `--all` converts those too) and skips models whose `.frag` is up to date (`--force` converts them again); `--dry-run` lists what it would do and writes nothing. Every model is converted in a process of its own, so its memory is back before the next one starts, and a model that fails is reported at the end without stopping the others. This is the way to prepare a large project: afterwards *Open folder* opens the `.frag` files without converting anything, and still exports IFC from the IFC files next to them.

**How much a folder can hold.** Memory decides, and it goes by what is shown and from how close, not by file size alone. The test project was the Etihad Arena: ten discipline models of 99 to 328 MB of IFC each, 1.9 GB, 276,107 elements and 1.9 million items in all. It was opened in headless Chromium on two cores with software rendering and 6 GB of memory for the whole browser, which is far less than a desktop with a graphics card has:

| | Time | Memory of the tab |
| --- | --- | --- |
| Reading the folder and checking it for repeats | 16 s | |
| Converting and showing all ten in the browser | 23 to 28 min | 4.6 GB at the peak, 3.2 GB afterwards |
| The same folder prepared with `npm run convert -- <folder>` (18 min, 3.2 GB at the peak) and opened from its `.frag` files | 12 min | 3.5 GB at the peak, 3.4 GB afterwards |

On top of the tab's memory comes about 1 GB in the browser's graphics process. Converting is processor work and takes about as long on the command line. Opening the `.frag` files is slow here only because software rendering keeps both cores busy as soon as a large scene is on screen: the largest `.frag` of the project, 89 MB, opens in 17 s while nothing else is shown. Showing and hiding models, showing one alone, zooming to it and picking elements all worked with the ten models loaded.

The figures above are with the whole site in view. Going in close with all ten models shown makes the engine build the full geometry of everything nearby, and that was more than the 6 GB held: the tab ran out of memory. Geometry is only built for what is shown, so on a machine of that size, show only the models being worked on before zooming in. Opened in name order instead of largest first, the same folder ran out at the eighth model, which is why the order described above exists.

**Tools.** Select (click, Ctrl-click, box), hide, isolate, X-ray, fit, standard views, perspective or orthographic camera, orbit / first-person / plan navigation, three render styles, length, area, angle and volume measurement, section planes, and storey plans.

| Key | Action |
| --- | --- |
| `Esc` | Leave the current tool, or clear the selection |
| `F` | Fit the selection (or the whole model) |
| `H` / `I` / `X` | Hide, isolate, X-ray the selection |
| `Shift+A` | Show everything |
| `Enter` | Finish an area or volume measurement |
| `Delete` | Remove the measurement or section plane under the cursor |

**Panels.**

| Panel | What it does |
| --- | --- |
| Models | Loaded models, grouped by the folder or archive they came from: sizes, show/hide, show only, zoom, export (one, all, combined), remove |
| Tree | Spatial structure (project, site, building, storey, space) with element counts |
| Search | Rule-based search by text, class, storey, attribute, property, material, type or classification |
| Groups | Groups elements by class, storey, type, material, classification, model or any property, and colours the 3D view by group |
| Sections | Section planes and storey plans |
| Props | Attributes, property sets, quantities, type, materials and layers, classification, containment, hosted elements |
| Quantities | Take-off of count, volume, area and length by any grouping, with a chart and CSV export. Uses the model's quantity sets and measured properties, converted to SI units, and says how many elements carried each quantity; volumes can also be computed from the meshes |
| Health | Sixteen data-quality checks (unplaced elements, missing property sets, materials, types or names, duplicate GlobalIds, duplicate geometry, proxies, outliers and more), a score, and inferred facts about the model. Every finding lists its elements; CSV export |
| Clashes | Hard and clearance clash detection between any two sets of elements, with exact mesh tests and options to ignore hosted and touching elements |
| IDS | Validates the models against a buildingSMART IDS file. A sample is in `public/samples/basic-requirements.ids` |
| Assistant | Questions in plain language, answered from the loaded model |

**IDS coverage.** The checker was run against buildingSMART's official IDS 1.0 test cases with this app's own importer settings: 290 of 307 pass. The 17 that do not all depend on data the Fragments importer does not keep: surface styles as entities (13 cases), IfcMaterialProperties (2), predefined property sets such as IfcDoorPanelProperties (1), and a classification attached to a material through an external reference (1).

**Assistant.** The assistant runs Claude with a set of tools that execute in the browser against the loaded model (find elements, read properties, take off quantities, run the health checks, select or isolate in 3D), so every number in an answer comes from the model. Your question, and the results of the tools it calls (counts, names, property values), are sent to Anthropic through your own API key. Geometry and the file itself are not sent.

## The RVT viewer

Revit's file format is proprietary, so there are two ways in, switchable in the *Import* panel. Both produce an IFC, which then opens in the same viewer with every tool above, including *Export > Selection as IFC*.

**In the browser** (default, no account). The file is read on your computer by [rvt-rs](https://github.com/DrunkOnJava/rvt-rs) 0.17.0, an open-source reader compiled to WebAssembly and included in `public/rvt/`. Nothing is uploaded. This is experimental: rvt-rs is an independent project, not Autodesk software. It recovers part of a project, many shapes are simplified (some elements are only bounding boxes), some elements are left out, and parameters are incomplete. Its own support matrix rates Revit 2023 to 2025 projects as partial and other releases as experimental. Each file gets a report built from rvt-rs's diagnostics: elements exported, how many have geometry, how many are boxes, what was left out and why. Do not measure or coordinate from this view. Tested here on three public projects (Revit 2023, 2024 and 2025); the 34 MB Revit 2024 one produced 970 elements in 32 s.

**Autodesk cloud** (exact). The file is uploaded to your Autodesk Platform Services account, Autodesk's own Revit engine exports it to IFC with the export setup you choose, and the IFC is downloaded and opened. By default the upload and its export are deleted from Autodesk's cloud as soon as the IFC has arrived.

## The NWD viewer

Navisworks files can only be read by Autodesk software, so this viewer needs Autodesk Platform Services. The file is uploaded and translated, then shown in Autodesk's own viewer, which is loaded from Autodesk's servers when you open a model. Its toolbar gives you navigation, measuring, sectioning, a model browser and a property panel.

The side panel adds what the request asked for:

- **Selection** at three levels (part, object, assembly), with zoom, isolate and hide.
- **Groups** by level of the model tree or by any property, and a search by name or property value. Clicking a group selects it.
- **Export IFC** for the selection, for everything visible, or for the whole model.

The IFC is written by this app (`src/lib/ifc-writer`): IFC4 with tessellated geometry in metres, a colour per mesh, every property of each object as property sets, and the object's place in the Navisworks tree. Navisworks files carry no IFC classes, so classes are guessed from category and object names (walls, doors, pipes and so on); anything unrecognised becomes an IfcBuildingElementProxy, and the guessing can be switched off. Storeys can be taken from a level property when the file has one. Exports are meshes, not parametric solids, and large exports are large files: the panel shows the triangle count and an estimated size first. *Open in IFC viewer* loads the result into the IFC viewer for checking and analysis.

Uploads live in a bucket that Autodesk empties after 24 hours. Models still in the cloud are listed in the panel so they can be reopened without uploading again, or deleted at once.

*Open the built-in sample* loads a small mechanical model shipped with the app, so selection, grouping and IFC export can be tried without an Autodesk account. It is not a building model.

## Convert to IFC

The Convert page assembles IFC4 files from whatever is at hand: a Revit model, a Navisworks model, a model someone shared in the Autodesk Viewer, floor plan drawings, or a mix. It works in four steps, top to bottom on the page.

**1. Sources.** Drop files on the page or use *Add files*:

| Source | How it is read |
| --- | --- |
| Revit `.rvt` | *Autodesk cloud, then convert here* (needs APS keys): Autodesk translates the model for its viewer, the app opens it in a hidden viewer panel and reads every element's geometry and key properties. *Revit's own IFC exporter*: Autodesk runs Revit's IFC export; the IFC is kept as delivered and listed next to the generated files. *In the browser*: the rvt-rs reader described above, no upload. |
| Navisworks `.nwd`, `.nwc` | *Autodesk cloud, then convert here* (needs APS keys), as for Revit; every source file inside a federated NWD becomes its own part. Without keys, use a viewer link instead. |
| Autodesk Viewer link | See below. Arrives as model data, like the cloud route. |
| Extracts `.eapk`, `ifcstudio-*.bin.gz`, `ifcstudio-*-tex*.png`, `ea-nwd-*.bin.gz` | Files saved by the bookmarklet (model data, properties and texture pictures), or by the earlier Etihad Arena extraction (older format, read as is). |
| Floor plans `.pdf`, `.png`, `.jpg` | Each page or image becomes a plan to trace (step 2). |
| IFC `.ifc`, `.ifczip` | Passed through to the viewer hand-off. |

**Autodesk Viewer links.** A model shared on viewer.autodesk.com (or open in Autodesk Construction Cloud, or any page running the Autodesk viewer) cannot be fetched or framed from another site, so a bookmarklet does the reading on the viewer page itself:

1. Drag *IFC Studio extractor* from the card to the bookmarks bar, once. (*Copy as console snippet* gives the same code for pasting into the developer console where bookmarklets are blocked.)
2. Paste the link and click *Open*. The viewer opens in a new tab that can talk back to this page.
3. When the model has loaded, click the bookmark. A small panel lists the source files in the model; pick them, choose all properties (the default) or key ones only, and click *Send to IFC Studio*. The model arrives under Sources, with its materials and texture pictures.

The bookmarklet carries the extractor itself, so after updating the app, drag it to the bookmarks bar again (the old one keeps working, without materials beyond colour and opacity).

If the viewer was opened some other way, the panel cannot reach the app and offers *Download .eapk* instead: one file with everything, to drop on the Convert page. The bookmarklet only reads what the viewer already shows and sends it nowhere but to the IFC Studio window or a local download; use it on models you are allowed to export. Pieces the viewer has not loaded (models too big for its memory budget) are counted in the panel.

**2. Floor plans.** *Edit* opens a plan in the editor:

- **Scale**: for a PDF, type the drawing scale (1 : 100); for any plan, *Measure a known length* (click both ends of a dimension, type its length).
- **Position**: pick the plan point that sits at a given X / Y (a grid intersection, a building corner) and align a line with the X axis, so the plan lines up with a model. Leave both at zero for plans on their own.
- **Storey**: name, elevation and wall height, or pick one of the model's storeys.
- **Trace walls**: walls drawn *Filled* (solid poché), as *Two lines*, or as *One line*; thickness range, shortest wall, door gap. Thin lines (text, dimensions, hatching, furniture) are ignored, walls are squared to the plan's main directions and joined at corners, and the floor slab outline is the outside of the walls with door and window gaps closed. *Limit tracing* leaves out title blocks and details.
- **Check**: select, move the ends of, or delete walls, draw missing ones, and drag the slab outline's corners.

Traced plans are written as IfcWall (extruded rectangle profiles with an axis line, Pset_WallCommon.IsExternal, Qto_WallBaseQuantities) and an IfcSlab (extruded outline, Qto_SlabBaseQuantities), in their own discipline or any other.

**3. Assemble.** Every source file is listed with its element count and main categories, and a discipline suggested from its name (AR, ST, HV, PW, FS, EL, ...) or, failing that, from what it contains. Files with the same discipline go into the same IFC. Below that:

- **Storeys**, found from the Revit levels elements are placed on. The viewer carries level names but not elevations, so each level's height is estimated from where its elements stand; levels at the same height in different files (an architectural *L01 - Mezzanine Level F.F.L.* and a structural *STR - 01 - TOS - MEZZANINE LEVEL*) become one storey, and levels with very few elements are dropped. Names and heights can be edited; elements of a level that is not listed go by height.
- **Site origin**: *Automatic* keeps the model's coordinates, moving the site placement to the model when it is far from the origin (survey coordinates), so element coordinates stay small. *Custom* takes an origin and a rotation. Every file uses the same site, building and storey ids, so the files line up and federate.
- **Categories** to leave out, and a pattern for families or types to leave out.

**4. Generate.** One IFC per discipline and, with more than one discipline, a federated IFC with everything (same GlobalIds as the discipline files). Elements are classified from their Revit category and family name into IFC4 classes and predefined types (pipes, fittings, valves by kind, dampers, sanitary terminals, sensors, alarms, lights, outlets, transport elements and so on; anything else is an IfcBuildingElementProxy). GlobalIds are the Revit ones: Navisworks' item GUID, or the GUID Revit's own exporter derives from an element's UniqueId; elements without one get a stable hashed id. Each element carries the property sets *IFCStudio_Source* (element id, source GUID, category, family, type, level, workset, system, size, mark, ...; lengths in millimetres) and *IFCStudio_Provenance*, plus every property group of the viewer when *All properties* was extracted. Geometry is the model's own tessellation in millimetres, with shapes used more than once written once and placed by IfcMappedItem (non-uniform scaling allowed); mirrored copies get their own mirrored shape, so no viewer has to deal with a reflecting placement. *Open in the model viewer* hands the discipline files to the IFC viewer; *Save all to a folder* writes them to disk (Chromium browsers) or downloads them.

**Materials and textures.** The extractor reads each material as the viewer shades it: diffuse colour, opacity, specular colour and shininess, metal, emissive colour, its name where the viewer keeps one, and the texture picture with the matrix that places it, together with each shape's texture coordinates and vertex colours, and line work. In the IFC:

- Every material becomes an IfcSurfaceStyle: IfcSurfaceStyleRendering with the surface colour, transparency, specular colour, IfcSpecularExponent and a reflectance method (PHONG, METAL, GLASS), plus IfcSurfaceStyleWithTextures when it has a picture. The surface colour is what the viewer's rendering averages to (the picture's average colour times the diffuse colour, metals lightened by their reflections), so viewers that show one colour per surface, the app's own model viewer among them, still show the right colours.
- Pictures are IfcImageTexture files in a `textures/` folder next to the IFC files (*PNG files*, the default), IfcBlobTexture inside the IFC (*In the IFC*), or left out. Each textured shape gets an IfcIndexedTriangleTextureMap whose coordinates already include the material's texture matrix, with its own index list so welded vertices keep their seams. *Save all to a folder* writes the `textures` folder too; *With textures* and *Download all (.zip)* give archives with the same layout.
- Vertex colours become IfcIndexedColourMap face colours (a single colour when a shape has only one).
- Material names (Navisworks geometry nodes, or the viewer's material) are IfcMaterial, or an IfcMaterialConstituentSet when an element has several, each with an IfcMaterialDefinitionRepresentation carrying its style.
- Elements of one Revit family type share a type object (IfcWallType, IfcPipeSegmentType, ...) named *Family:Type*, with the *Revit Type* properties.
- Elements made only of lines (model lines, separation lines, when their category is not left out) become IfcAnnotation with IfcIndexedPolyCurve curves.

Geometry stays the viewer's triangles: the viewer never receives Revit's parametric solids, so no tool working from it can recover them.

**Preview.** *Show preview* draws the parts and categories that will be converted, with their materials and textures, in a 3D view on the page (three.js; shapes used many times are drawn instanced). *IFC colours* shows the single colour per surface that viewers without textures show. Clicking a surface names its element, material and texture. Models over six million triangles leave out their most detailed small elements in the preview (not in the IFC).

**Asset register.** The *Asset register* card lists the model's equipment for facilities management (CAFM) and onboarding: make, model, serial number, bar code, tag, installation date, manufacturing year, warranty (start, duration, end, guarantor), expected life and end of life, replacement cost, PPM tasks and their frequency, the room each item is in, its systems, the board it is fed from, what serves it and what it serves, and the rooms it serves; the electrical distribution as single-line diagrams; MEP technical data; fire and life safety data; asset kinds, codes and suggested classification; with the model's floors, rooms and zones.

- **Which elements.** The maintainable categories by default (mechanical, plumbing and electrical equipment, light fixtures, devices, fire protection and sprinklers, air terminals, duct and pipe accessories, plumbing fixtures, specialty, medical and food-service equipment, lifts and escalators, doors); any category can be added or taken out.
- **Where values come from.** Each field is looked up by the names Revit, Navisworks and COBie use for it (*Manufacturer*, *Model*, *Serial Number*, *COBie.Component.InstallationDate*, *Warranty Duration Parts*, *Expected Life*, *Fed From*, ...) across the property groups, type values on the type and the rest per element. The card shows how many assets each field fills and which property it read; any field can be pointed at another property or left empty. Dates are read in ISO, day-first (15/03/2021), month-name and Excel-serial forms; *Quarterly*, *Every 6 months* and the like become a frequency and a unit.
- **Rooms.** Rooms and spaces of the model (with their number, name, department, areas and height) are matched by the room property an element carries, by Navisworks' room tabs, or else by geometry (the element's centre inside the room's solid). A model without rooms (most MEP models) gets the rooms its elements name.
- **Systems and serving.** Systems come from *System Name* (an element can be in several); a system's classification is settled by what its members say. Serving links come from shared systems (in an air system the air handler feeds the fan coils and boxes and they the terminals; in a water system the chillers, boilers and pumps feed what is on it), from electrical boards (the board in an item's *Panel* or *Supply From* property, found by panel name, mark or name) and from properties that name them (*Served By*, *Serves*). The rooms an item serves are the rooms of what it serves; each serving item also gets a service-area zone, and departments become zones.
- **What each asset is.** Every asset gets a kind from its category, family, type and name (about 140 kinds: air handling unit, fan coil, chiller, pump, distribution board, sub-main board, transformer, smoke detector, manual call point, sprinkler head, fire damper, fire door, emergency light, lift...), with a short code (AHU, DB, SD...), its discipline, the compliance regime it usually falls under (fire safety, emergency lighting, lifting equipment, pressure systems, water hygiene, refrigerant, electrical safety, gas safety) and a Uniclass 2015 product code. The compliance group and the Uniclass code are suggestions to check; a classification the model carries wins, including one at the start of a family name (NBS object naming: `60_70_22_22_DistributionBoards_Generic` is Pr_60_70_22_22).
- **Electrical distribution.** Boards (transformers, generators, UPS, main switchboards, sub-main and final distribution boards, MCCs) form a tree by what each is fed from: *Panel* / *Supply From*, or a "FED FROM SMDB-02" note in the element's text. Each board gets its level and feed path, voltage, phases, main rating, ways, connected and demand load, fault level and IP rating as the model states them (*Distribution System* and Revit's *Electrical Data* such as 230 V/1-36 VA are read too); a board without a connected load gets the sum of what it feeds, marked as such. Items fed from a board are grouped into circuits by circuit number, with poles, breaker, cable, voltage and load. A board items name but the model does not hold appears as a placeholder, so the tree still holds together. Fire alarm devices name their fire alarm panel in Revit's *Panel* and their loop in its circuit number; those become panel, loop and address, not a power supply.
- **MEP technical data.** Airflow, water flow, cooling, sensible and heating capacity, motor power, external static pressure, pump head, refrigerant and charge, efficiency, voltage, phases, rated current, load, IP rating, weight, volume, luminaire power, luminous flux, colour temperature, emergency type and duration, and a lift's rated load, speed, persons and floors. Each field is only read for the assets it applies to (airflow for air equipment, pump head for pumps), and values are converted to one unit per field from whatever the model uses (m³/h, CFM, TR, Btu/h, HP, inWG, m head, lb, °F, Autodesk unit ids).
- **Fire and life safety.** Fire alarm panel, loop, address and zone, fire rating, activation temperature, sprinkler K-factor, response and coverage, damper actuation and extinguisher type. A panel's loops become systems; fire zones and fire compartments become zones of the rooms concerned.
- **Asset management.** A location code (site-building-floor-room) and path for every asset, and an asset code from a pattern set on the card (`{building}-{floor}-{kind}-{seq}` by default, with `{site}`, `{room}`, `{discipline}`, `{system}`, `{tag}`, `{type}`, `{seq4}`); site and building codes default to the initials of their names. A parent asset named in a property (*Parent Asset*, *Part Of*) links parts to their asset. Criticality, maintainer and statutory requirement are read when the model has them and otherwise left as blank columns for the FM team.
- **Derived values.** Warranty end (start plus duration) and end of life (installation or manufacturing year plus expected life) are worked out when the model does not give them, and marked as derived.
- **Gaps.** A value the model does not carry is left blank in the asset register (COBie's own placeholders, `n/a` and `1900-12-31T23:59:59`, in the COBie workbook) and counted on the *Coverage* sheets; unknown boards and rooms, duplicate tags and values that differ within a type are listed under *Data issues*.

Three files come out:

- **COBie 2.4** (`*-COBie.xlsx`): Contact, Facility, Floor, Space, Zone, Type, Component, System, Assembly, Connection, Spare, Resource, Job, Impact, Document, Attribute, Coordinate, Issue and PickLists, with COBie's header colours. Type categories are the model's classification or the suggested Uniclass code, Type features summarise the technical data, Systems include each board's distribution and each fire alarm loop, Assemblies are parents and their parts, Connections the serving links (Electrical Supply, Fire Alarm Loop, Serves), Jobs the PPM tasks, Attributes every property of every asset plus the register's own normalised values with their units, Coordinates the asset positions. The author's email, company and phone and the currency are set on the card.
- **Asset register** (`*-asset-register.xlsx`): one row per asset with every field above in plain columns (asset code, kind, warranty and life in years, PPM frequency and unit, location code and path, parent and parts, suggested classification and compliance, blank criticality / maintainer / statutory, positions in metres), plus Technical Data, Electrical Boards (the single-line diagram as a table), Circuits, Fire & Life Safety, Spaces, Types, Systems, Relationships, PPM, Coverage, Coverage by category, Data issues and a wide sheet with every property of every asset.
- **Single-line diagrams** (`*-single-line-diagrams.html`): one page, drawn from the same data, with a diagram per supply tree (source on the left, boards to the right, each with its kind, ratings, load, circuits and items), to open in any browser or print.

In both workbooks, an asset's id is its IFC GlobalId, and with *Asset information* on (Generate step) the IFC files carry the same data: Pset_ManufacturerTypeInformation, Pset_ManufacturerOccurrence, Pset_Warranty (IfcDate, IfcDuration), Pset_ServiceLife, Pset_DoorCommon.FireRating, *IFCStudio_Asset* (name, code, kind, tag, dates, floor, room, location code, systems, fed from, served by, serves, serving rooms, parent, PPM, criticality, maintainer, statutory, suggested compliance and Uniclass code), *IFCStudio_Electrical* (ratings, loads, circuit, cable; a board's level, feed path and what it feeds), *IFCStudio_Technical* and *IFCStudio_FireSafety* (values named with their unit, "Airflow (L/s)") on the elements, the manufacturer, warranty and service life also on their types; IfcDistributionSystem for the systems, boards' distributions and fire alarm loops (with their members and the building they serve), IfcZone for the zones, and each asset referenced in its room (IfcRelReferencedInSpatialStructure). Transformers, generators, UPS units, batteries, busbars and energy meters are IfcTransformer, IfcElectricGenerator, IfcElectricFlowStorageDevice, IfcCableSegment and IfcFlowMeter (a transformer has no type object: IFC4's own rule for it misspells IfcTransformerType, so none passes). Rooms are IfcSpace named by number with the room name as long name, as Revit's own IFC export does; a file whose assets sit in rooms from another discipline's model, or in rooms only named by the assets, gets those rooms as spaces without geometry, with the same GlobalId. The richer the extract the more there is to find: extract with *All properties* (the default); an extract with key properties only has identity and system fields.

Everything heavy runs in workers: reading and analysing models, writing IFC, building the preview, tracing plans. Writing the 88,000-element fire-protection model of the Etihad Arena took 14 s and gave a 330 MB file (measured on the command line with the same code). Output files are kept as Blobs, so leaving the page for the viewer and coming back keeps them.

## Keys

All keys go in `.env.local` (copy `.env.example`). They are read by the server-side routes only and never reach the browser.

| Variable | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | The assistant. Optional `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) |
| `APS_CLIENT_ID`, `APS_CLIENT_SECRET` | Revit cloud conversion and the Navisworks viewer. Create an app at <https://aps.autodesk.com> with the Data Management and Model Derivative APIs. Optional `APS_REGION` (default `US`) and `APS_BUCKET` |

The API routes spend your API credit and cloud quota. They accept requests from this app's own pages only, which suits running it on your own machine. Put real authentication in front of them before hosting the app anywhere others can reach.

## What was and was not tested

Tested in a headless browser (Chromium) against the development and production builds: IFC conversion and display, Fragments export and re-opening, IFC export of selections, multi-model, box selection, measuring, sections, plans, render styles, both themes, every analysis panel, the in-browser Revit reader on three real projects, and the Navisworks page with the built-in sample (selection, groups, search, IFC export, hand-off to the IFC viewer).

ifcZIP was tested in the browser and on the command line with 39 test files made with Info-ZIP and Python: Deflate and stored models, ZIP64, data descriptors, archive comments, data in front of and behind the archive, Finder-style folders with resource forks, UTF-8 and legacy file names, wrong file extensions, several models in one archive, and archives that are encrypted, use other compression methods, hold only ifcXML, or were damaged on purpose in ten different ways. Two more exercise ZIP64 for real: a 4.6 GB archive with the model behind the 4 GB mark, which opens and converts, and an entry that unpacks to 4.5 GB, which was unpacked and checked against its checksum in the browser and on the command line (it is repeated filler rather than one real model, so it was not converted). The unpacked IFC was compared byte for byte with the original, and the Fragments output with that of the plain IFC (identical apart from the random model id every conversion gets). Archives written by Revit, Archicad or other BIM tools were not available to test; they are ordinary Deflate archives. Unpacking in the browser relies on `DecompressionStream`, which Chrome and Edge have had since version 103, Firefox since 113 and Safari since 16.4; only Chromium was tested.

Folders were tested in the browser and on the command line with two projects. One is made up for the purpose: models as `.ifc`, `.ifczip` and `.frag`, an extract of another model, a copy under another name, an archive with two models, a damaged archive, Finder leftovers, a `node_modules` folder and a Revit file. The other is real: the Etihad Arena models described under *How much a folder can hold*, eleven files of which one is an extract of another. Covered between them: what the dialog proposes, picking a folder and dropping one, the order of opening and of the list, models that wait for a large conversion (also tried with three 200 MB models of one size), showing and hiding, a `.frag` next to its IFC (it opens from the `.frag` and exports IFC from the IFC), both exports, and opening what they wrote. With the ten Etihad models loaded, the `.zip` of ten `.frag` files (449 MB) was written in the browser. With five of them loaded, both exports were written and checked: the `.zip` passes a CRC check and holds the very bytes the models were opened from, and the combined file (210 MB) opened again in a fresh tab in about two minutes, with its five project branches in the tree. Opening a combined file took about five times its uncompressed size at the peak (3.0 GB for that one), so the file of all ten, 1.4 GB uncompressed, was not opened in the 6 GB test browser.

A combined file was compared with the models it was made from, item by item, with the engine's own reader instead of the code that wrote it: for the ten Etihad models joined on the command line (1,904,316 items, 3,965,875 attributes, 2,042,785 relations, 1,472,530 geometry samples and 26.8 million points), for the five joined in the browser (736,924 items) and for the made-up project. Categories, GlobalIds, attributes, relations, geometry and placement came out the same as in the sources. Picking a folder relies on `webkitdirectory` and dropping one on `webkitGetAsEntry`, which Chrome, Edge, Firefox and Safari all have; only Chromium was tested.

Not tested against the real services, because no credentials were available while building:

- **Autodesk Platform Services.** The upload, translation, download and delete flows were run end to end against a local stand-in written from Autodesk's official Node SDK (same endpoints, payloads and headers), including a 34 MB multi-part upload verified byte for byte. The real service, and the Autodesk viewer streaming a real translated NWD, have not been exercised. Geometry extraction from the Autodesk viewer was tested with the built-in sample, which is in the older SVF format; translated Navisworks files arrive as SVF2.
- **The Claude API.** The assistant's tool loop, error handling and stop were tested with a scripted stand-in for the model. The server route was checked against the real API as far as authentication (a rejected key gives the expected message).

If something in those paths fails with real credentials, the error shown in the panel comes from the service itself and is the place to start.

The Convert page was tested as follows. The writer was run on the Etihad Arena extracts (twelve viewer extracts, 400,000 elements, 1.4 million fragments) and compared with the IFC files built from them earlier with IfcOpenShell: element counts per discipline, instanced and baked shapes and non-uniform placements match exactly; for 400 sampled elements of the HVAC model and 120 of the signage, matched by GlobalId, the class is the same and the bounding boxes agree to within a micrometre; mirrored and plain elements face outward as in the source. The output passes IfcOpenShell's schema validation and its EXPRESS rules, and web-ifc turns every shape into triangles. In the browser (Chromium, production build): bundle import, discipline suggestions, storeys, generation, and the hand-off to the IFC viewer with discipline files opening together and lining up; the PDF route (pdf.js) and an image route, including scale by drawing scale and by measuring, alignment, tracing, editing and the generated walls and slab; and the bookmarklet end to end on a page running the real Autodesk viewer (the built-in sample, served under viewer.autodesk.com in the test browser): panel, hand-shake, sending to the app, conversion, and the *.eapk* download when the viewer was not opened from the app. On the real viewer.autodesk.com share of the Etihad Arena model (Autodesk viewer 7.129), the extractor found the model's 84 source files, its real file name (the page stores it under a generated one), feet and Z up, and read one source file (853 parts, 700 elements with their properties and units) in under a second; all 735 geometry owners in it fall inside the elements the property reader lists, so geometry and properties line up. The cloud routes for Revit and Navisworks reuse the APS client above and share its untested status; a model translated by APS for this app was not run through the extractor.

Materials and textures were tested on the Autodesk viewer (7.129, the same library viewer.autodesk.com runs) with its built-in sample, with a test picture put on the body material together with a texture matrix (3× scale, 20° turn, offset): the viewer's rendering, the Convert page's preview and the IFC read back independently (texture coordinates, styles and placements parsed from the file with IfcOpenShell, drawn with three.js) show the same squares in the same places from the same camera. Embedded pictures come back byte for byte. Vertex colours (per face and uniform) and a line-only element were tested on synthetic data. The textured, coloured and annotated files pass IfcOpenShell's schema validation and EXPRESS rules, web-ifc turns every shape into triangles, and the app's model viewer opens them (in each surface's average colour). Re-run on eleven of the Etihad Arena extracts, the geometry report (shapes, placements, mirrored, non-uniform, left out) is identical to before; with type objects and material sets the water-services file validates clean. In the browser: preview, picking, *IFC colours*, generation, the ZIP downloads (checked with unzip), and textures arriving through both the viewer link and an *.eapk*. The new extractor was not run on a live viewer.autodesk.com share, so pictures from such a share (which the viewer may load differently) are untested.

The asset register was tested on two made-up models with known answers and on the Etihad Arena extracts. The made-up ones cover rooms with geometry (equipment placed in them by position), rooms named in Navisworks room tabs, an air handler with its diffusers, a chiller and pump on chilled-water systems with an air handler and a fan coil, a board feeding lights through *Panel* and *Circuit*, a stated *Served By*, COBie shared parameters, element lists of systems and classifications in different orders, duplicate tags, placeholders (`n/a`), and dates and durations written in a dozen ways (day-first, `15-Mar-21`, Excel serials, `P5Y`, *Quarterly*, *6-monthly*); every value, room, system, serving link, derived date, PPM job and data issue came out as expected, and the asset ids in both workbooks are the GlobalIds in the IFC. On three Etihad extracts (HVAC, electrical and architecture: 151,021 elements) the register took about 13 s on the command line: 38,345 assets of 1,915 types in 1,582 systems, 957 serving links, rooms only named by the assets (the models have no room geometry), giving a 22 MB COBie workbook and a 6.9 MB asset register. These extracts carry key properties only, so serial numbers, dates, warranty and PPM are empty there; the register reads them when an *All properties* extract has them, as the made-up models show. Both workbooks open in openpyxl and LibreOffice (a LibreOffice round trip keeps every sheet and value). IFC files with asset information pass IfcOpenShell's schema validation and EXPRESS rules (also the 440 MB federated Etihad file with 1,582 systems, 15 zones and 197 room spaces), web-ifc turns every shape into triangles, and IfcOpenShell reads the property sets, systems, zones and room references back. In the browser (Chromium, production build): the card, reading, changing a field's source, both downloads, generation with asset information and the phone layout. Not tested: importing the workbooks into a particular FM platform, and checking them with the COBie QC reporter.

The asset management additions (electrical distribution, technical and fire data, kinds, codes) were tested on a made-up plant with known answers: a transformer feeding a main switchboard, a sub-main board and a distribution board with lights, an emergency light, a socket and a fire alarm panel on it; an isolator fed through a "FED FROM" note; an air handler (airflow in m³/h), a pump (head in metres), a chiller (capacity in TR, refrigerant charge in lb), a fire alarm panel with detectors and a call point on two loops and two zones, a sprinkler, a fire damper, a fire door, a lift, a tank, an extinguisher and a fan that is part of the air handler. The tree, levels and paths, ratings (from "1600 A", "400/230V 3P4W", "50 kA", "IP 54 / IK10"), summed loads, circuits, fire loops and zones, converted values, kinds, codes, parent and parts, Uniclass suggestions and coverage all came out as expected, and the diagrams were checked on that plant and on a wider made-up distribution (2 transformers, 2 main switchboards, 6 sub-main and 24 distribution boards). Every Uniclass code and title in the kind table was checked against the published Pr and Ss tables. On four Etihad extracts (HVAC, electrical, architecture and fire protection: 238,781 elements, 48,145 assets) the register took about 7 s and the workbooks about 19 s on the command line; the kinds were checked against the families found there (which led to rules for CamelCase and Uniclass-coded family names, fused spurs named after what they feed, lift parts and washroom accessories). Those extracts hold key properties only, so ratings and panels are not in them; the distribution there comes from 17 "fed from" notes. The IFC files with the new property sets, systems and classes pass IfcOpenShell's schema validation and EXPRESS rules (the plant, and the 267 MB electrical and 254 MB fire protection files of the Etihad extracts), and web-ifc turns every shape into triangles. In the browser: the field views, codes, the three downloads and generation, in both themes and at phone width.

The register was then checked on the live Etihad Arena share (2026-11-20) with every property of the asset elements: ten of the model's files (HVAC, electrical, fire protection, drainage, water, vertical transport, signage and three architectural files; 343,477 elements) were read in the viewer in 21 s, all properties for the 119,134 elements in asset, room and generic-model categories or without a category, and key properties for the 224,343 pipes, ducts, walls and the like, and joined to the geometry read from the same share earlier. The register (54,681 assets, 2,495 types, 372 boards, 454 circuits, 14,122 fire and life safety items) took 14 s and the three outputs 27 s. That data led to these changes, each now covered by a made-up model with known answers: names with their unit in brackets ("Expected Lifetime (Years)", "Frequency of Maintanance (Months)", with the misspelling) and "Feeder Ref.", "Asset", "Supplied By" and "Installed By" (a new *Installed by* field) are read; zero values ("0.00" cost, "0 VA", "0 A") and COBie's placeholder dates (1900-12-31, and 1999-12-31) count as empty, as does "Please record on commissioning"; only durations count as PPM frequencies (a generator's "Frequency" of 60 Hz does not), only dates as dates and only names as boards (a "DB" of 0.35 does not); Navisworks room tabs are the room's, not the asset's (their Comments and Volume no longer fill asset fields, and they are left out of the asset's properties); a board is named by its panel name; a mark that is a note ("100A TP isolator for … fed from …") names nothing; boards that share a panel name (the model has one placed 18 times) are folded into the best documented one and reported; items wired to data cabinets and security panels are signal links, not part of the power diagram; typographic dashes in board names are read as hyphens; floors whose names read alike ("L03 - VIP Level" and "03 - Main Concourse") get codes of their own; the Asset Properties sheet is written sparsely (4,294 columns) and COBie's Attribute sheet leaves out what the Component and Type rows already say (768,721 rows, under Excel's limit). The workbooks open in openpyxl and LibreOffice.

Other limits worth knowing:

- The importer cannot turn every piece of geometry into a surface. It leaves out what it cannot (its own log calls these "problematic geometry"), and the app counts them instead of passing on a line for each: the conversion message and the model's details give the number, and so does the command line. In the Etihad project three of the ten models had some: 7,896 pieces in the fire-protection model, 191 in the electrical one and 85 in the interiors. Every element in those models still has geometry, so what is missing are parts of elements. A model opened from a `.frag` does not carry the count.
- While several large models load one after another, the browser console can show WebGL warnings ("no buffer is bound to enabled attribute") from the engine's level-of-detail meshes. They come with models that arrive in quick succession, also when several files are picked at once with *Open files*, and did not appear when the same models were opened one at a time with a pause in between. The finished picture was complete in every test.
- Analysis panels index a model the first time they are used. On very large models that takes a while (about a minute at 150,000 elements; quantity take-off, which reads every property set, took about four).
- Storey plans are clipped top-down views; cut faces are not hatched.
- The ground grid is drawn in the *Fast* render style only.
- The Navisworks viewer is set up for the US, EMEA and AUS regions.

## Versions

That Open Engine is at its latest release at the time of writing: `@thatopen/components` 3.6.0, `@thatopen/components-front` 3.6.1, `@thatopen/fragments` 3.6.1. Three other packages are pinned on purpose:

- **`web-ifc` 0.0.77**, not 0.0.78. The single-thread browser build of 0.0.78 does not match its own JavaScript API (`StreamMeshes called with 4 arguments, expected 3`), which breaks IFC conversion in the browser. 0.0.77 is the version That Open's packages are developed against.
- **`three` 0.184.0** (and `@types/three`). From 0.185, three's `TTFLoader` imports a library from a CDN URL, which Turbopack cannot bundle; 0.184 is also That Open 3.6's own development version.
- **`three-mesh-bvh` 0.9.9**, matching what That Open bundles.
- **`pdfjs-dist` 6.4.299** renders floor-plan PDFs on the Convert page. Its worker is copied to `public/pdfjs/` like the other runtime assets.

`src/lib/shims/three.js` re-exports three and adds a few WebGPU-only names as `undefined`. That Open probes for them, and Turbopack rejects a namespace member that does not exist.

`flatbuffers` 25.2.10 is a direct dependency: the combined export writes the Fragments file format itself. It is the version `@thatopen/fragments` 3.6.1 depends on, so the two share one copy.

`@thatopen/ui` is not used: the interface is plain React and Tailwind.

## Project layout

```
src/app/                  Pages (/ifc, /rvt, /nwd, /convert) and API routes (/api/assistant, /api/aps/*)
src/components/viewer/    The IFC workbench: toolbar, overlays, side panels
src/components/nwd/       The Navisworks page
src/components/convert/   The Convert page: sources, viewer link, plan editor, assembly, generation
src/lib/engine/           ViewerEngine: That Open world, models, selection, tools, exports
src/lib/ifc/              The conversion worker (IFC to Fragments, IFC subset extraction) and ifcZIP unpacking
src/lib/collection/       Opening a folder: finding the models, choosing one copy of each, spotting repeated models
src/lib/fragments/        Joining several Fragments models into one file
src/lib/data/             Element index, properties and units shared by the analysis tools
src/lib/analysis/         Search, grouping, quantities, health checks, clash detection, IDS
src/lib/assistant/        Assistant tools and the agent loop
src/lib/rvt/              Revit import (in-browser and cloud)
src/lib/aps/              Autodesk Platform Services: server calls and browser client
src/lib/lmv/              Autodesk viewer session, object grouping, IFC class guessing
src/lib/ifc-writer/       IFC4 writer for tessellated models
src/lib/convert/          Converter: extract reader, element model, materials, classes, disciplines, storeys, IFC4 writer, 3D preview
                          with instancing, conversion worker, plan tracing (plans/), asset register and COBie (assets/)
src/lib/utils/xlsx.ts     A small Excel (.xlsx) writer for the asset workbooks
public/convert/           The viewer extractor (bookmarklet and in-app)
public/rvt/               rvt-rs WebAssembly build and its worker
scripts/                  Asset copy, command-line converter and combiner, rvt-rs rebuild
```

`npm install` copies the web-ifc WebAssembly files, the Fragments worker and the pdf.js worker from `node_modules` into `public/` (`scripts/copy-assets.mjs`), so the app serves them itself instead of fetching them from a CDN.

## Credits and licences

- [That Open Engine](https://github.com/ThatOpen) (components, components-front, fragments): MIT. The engine's in-canvas logo is switched off; the credit is in the app header.
- [web-ifc](https://github.com/ThatOpen/engine_web-ifc): MPL-2.0. [three.js](https://threejs.org): MIT.
- [rvt-rs](https://github.com/DrunkOnJava/rvt-rs): Apache-2.0. Its licence, notice and the list of linked crates are in `public/rvt/`.
- The Autodesk viewer is Autodesk's proprietary software. It is not part of this repository: it is loaded from Autodesk's servers and its use, like the use of Autodesk Platform Services, is subject to Autodesk's terms.
- The built-in sample model in `public/samples/lmv-shaver/` comes from Autodesk's `viewer-javascript-offline.sample` repository (MIT, licence included).
- IDS is a buildingSMART standard.

Autodesk, Revit and Navisworks are registered trademarks of Autodesk, Inc. This project is not affiliated with Autodesk or with That Open Company.
