# IFC viewer

[README](../README.md) · [IFC viewer](ifc-viewer.md) · [Revit and Navisworks](revit-and-navisworks.md) · [Convert to IFC](convert.md) · [Asset register](asset-register.md) · [Facility management](facility.md) · [Development](development.md) · [Testing](testing.md)

The IFC viewer (`/ifc`) opens IFC, ifcZIP and Fragments files with [That Open Engine](https://github.com/ThatOpen), one at a time or a whole project folder at once, with analysis tools, and exports Fragments (`.frag`) and IFC.

## Opening files

Use *Open files* or *Open folder*, or drop files or a folder on the 3D view. IFC2x3, IFC4 and IFC4x3 files are converted to Fragments in a background worker, whether they come as `.ifc` or packed as ifcZIP (`.ifczip`); `.frag` files open directly. Several models can be open at once.

## Large files

The IFC is never read into memory as a whole. A worker hands the file to web-ifc in 64 MB pieces straight from disk, the result is a compact Fragments model, and the worker is discarded afterwards so its memory goes back to the browser. The Fragments engine then draws only what is in view. Measured in headless Chromium on two CPU cores with software rendering (a normal desktop is faster):

| File | Size | Elements | Time to open |
| --- | --- | --- | --- |
| FZK-Haus (IFC4) | 2.5 MB | 90 | 1.2 s |
| rac_basic_sample_project (IFC4) | 24 MB | 467 | 3.3 s |
| HITOS hospital (IFC2x3) | 61 MB | 2,318 | 8.5 s |
| Synthetic field of elements | 202 MB | 150,000 | 44 s |
| Synthetic field of elements | 612 MB | 450,000 | 2 min 43 s |

The two synthetic files are simple boxes with property sets: they show that entity count and file size are handled, not how long heavy solid geometry takes. The real limit is the memory a browser tab can give web-ifc (4 GB at most). For a file that will not convert in the browser, convert it once on the [command line](#command-line) and open the result:

```bash
npm run convert -- path/to/model.ifc          # writes path/to/model.frag
npm run convert -- path/to/model.ifczip       # the same, from an ifcZIP
npm run convert -- model.ifc out/model.frag
```

A `.frag` opens in seconds (the 150,000-element model above: 5.8 s), so exporting one is also the way to reopen a model quickly.

## ifcZIP

An `.ifczip` is a ZIP archive with an IFC inside. It opens like the IFC it holds: the model is unpacked in a worker and then converted to Fragments in the usual way, so every tool and panel works on it and it exports to `.frag` and to IFC like any other model. The `.ifc` button on its model card downloads the unpacked IFC. A plain `.zip` works too, and when an archive holds several `.ifc` files each one opens as its own model. The first bytes of a file decide how it is read, not its name, so an archive that was renamed to `.ifc` still opens.

The archive is not loaded into memory. Only its table of contents is read, the model is unpacked as a stream, and the browser stores the result (Chromium moves it to disk once it grows; a private window keeps it in memory, which held about 2 GB in testing). A model that was stored without compression is read in place, without copying. A compressed one is checked, as it is unpacked, against the size and CRC-32 recorded in the archive, so a damaged archive is reported instead of opening as a broken model. Unpacking is quick next to converting: the 612 MB model above unpacked from its 123 MB ifcZIP in about 5 s. Archives beyond 4 GB (ZIP64) are read: a 4.6 GB archive with a small model behind the 4 GB mark opened in under 5 s, because nothing but the table of contents and the model is read.

Not opened, each with a message that says why: password-protected archives, split (multi-volume) archives, compression other than Deflate (Deflate64, bzip2, LZMA and the like) and ifcXML models inside an archive. On the command line the model is unpacked to a temporary file first, which needs as much free disk space as the unpacked IFC; set `TMPDIR` (`TEMP` on Windows) to choose the disk. An archive with several models gives one `.frag` per model next to the archive.

## Folders of models

*Open folder*, or dropping a folder on the 3D view, opens a project that comes as many files: one model per discipline, perhaps a federated model of everything, each perhaps also as `.ifczip` or already converted to `.frag`. The folder is read with its subfolders and with the archives in it, and a dialog shows what was found and what will be opened:

- *One copy of each model.* Files of the same name in one folder (`model.ifc`, `model.ifczip`, `model.frag`) are one model in several formats. The `.frag` is opened when it is not older than the IFC, because it needs no converting; the IFC next to it still serves IFC export. Otherwise the `.ifc` is opened, and the `.ifczip` only when it is the only copy. A `.frag` in another subfolder is matched to the IFC of the same name, so converted files can live in a folder of their own.
- *Nothing drawn twice.* Each model is read through once for its schema, its description and the GlobalIds of its elements. A model is left out when at least 98 % of its elements are also in the other models: a second copy under another name, an extract of a larger model, or a federated model whose parts are in the folder too. In that last case the parts are the ones kept, because they can be shown and hidden one by one. The dialog names what was left out and why, and ticking a model opens it anyway.
- *Memory first.* Converting an IFC needs many times the memory of the model it produces, so a conversion on top of a full scene is what runs a tab out of memory. The models that need converting are therefore opened first, the largest first, while little else is shown; `.frag` files, which only need loading, follow. Each model is shown as soon as it is converted, unless that would crowd a large conversion still to come: then it waits, as a small `.frag` in the browser's storage, until that conversion is done. With models of falling size nothing waits; with many large models of similar size the later ones do, and arrive together at the end. The model list keeps the order of the dialog.

The models are placed by the coordinates in the files: the first one sets the origin of the scene and every further one is shifted onto it, so models that share a base point line up as they do in the authoring tool. (This is That Open's automatic coordination, and it applies to models opened one by one as well.) The camera frames the models as they arrive until you move it. Cancelling stops the folder and keeps the models that have arrived.

When a folder is picked, Chrome asks "Upload N files to this site?". That is the browser's wording for letting a page read a folder; nothing leaves the computer, as with single files. Dropping a folder asks nothing.

## Showing and hiding models

Every model in the *Models* panel has an eye switch. Models that were opened together, from one folder or one archive, form a group with a switch of its own, and the head of the list has *Show all* and *Hide all*. A model's menu adds *Show only this model* and *Zoom to model*; a group's menu has the same for the group. From four models on, each model takes one line and an arrow opens its details. A hidden model stays loaded: it comes back at once, and search and the analysis panels still cover it.

## Exporting

- *Whole model as Fragments*: the `.frag` button on the model card, or *Model actions > Export .frag*.
- *Every model as its own Fragments file*: *Export models* (the download button at the head of the model list) *> All N models as .frag files (.zip)*. One `.frag` per model in a single `.zip`, each the same file *Export .frag* gives. Unpacked into the project folder, they make the folder open without converting next time; the `.zip` also opens here as it is.
- *All models as one Fragments file*: *Export models > All N models as one combined .frag*. See below. Both exports are also offered for the models currently shown and, in a group's menu, for that group.
- *Selection as Fragments*: select elements, then *Export > Selection as Fragments* in the selection bar (one file per model).
- *Selection as IFC*: *Export > Selection as IFC*. The result is a valid IFC with the selected elements and what they depend on (geometry, materials, property sets, spatial structure). Walls keep their openings, doors and windows, a door or window brings the wall it sits in (and so that wall's other doors and windows), and assemblies keep their parts, so the file stays consistent. This needs the original IFC, so it is available for models converted in this session and for a `.frag` opened from a folder that also holds its IFC, not for a `.frag` opened on its own.
- *Whole model as IFC*: the `.ifc` button on the model card downloads the source IFC.

## The combined file

A combined `.frag` is a single Fragments model that holds every element of the models it was made from, with their attributes, property sets, relations and spatial structure, placed as the viewer shows them. It opens anywhere a `.frag` does, in one step. The models are joined, not reinterpreted: local ids are renumbered so that they do not collide, GlobalIds stay as they are, and the spatial structures stand side by side, one project branch per model in the *Tree* panel. Something that several models carry, such as the storeys every discipline file repeats, is therefore there once per model. The file's metadata lists the models it was made from.

Two limits. The uncompressed result must stay below 2 GB, which is what the Fragments format (FlatBuffers) can address; beyond that the export says so instead of writing a broken file. And it is put together in memory, which at its peak took about twice the uncompressed size of the result on top of the loaded models: 1.1 GB for five of the Etihad models (0.58 GB uncompressed, a 210 MB file, 1 min 28 s). Joining all ten (1.4 GB uncompressed) on top of the 3.4 GB they take when loaded was more than the 6 GB test machine had, and the tab ran out of memory; the export says how much it will need before it starts. The command line does the same joining without a browser tab's limits (next section): the ten took 57 s and 2.1 GB there, for a 483 MB file. A combined file is one model: its parts can no longer be switched on and off from the model list, and it unpacks all at once when it is opened. For working, the folder or the separate `.frag` files are the better set.

## Command line

The converter also takes a folder, and a second command joins `.frag` files:

```bash
npm run convert -- path/to/folder                        # a .frag next to every IFC in the folder
npm run convert -- path/to/folder --combined all.frag    # the same, plus one combined .frag
npm run combine -- a.frag b.frag c.frag -o all.frag      # joins .frag files that exist already
```

Folder mode makes the same choices as *Open folder* (one copy of each model, repeated models left out; `--all` converts those too) and skips models whose `.frag` is up to date (`--force` converts them again); `--dry-run` lists what it would do and writes nothing. Every model is converted in a process of its own, so its memory is back before the next one starts, and a model that fails is reported at the end without stopping the others. This is the way to prepare a large project: afterwards *Open folder* opens the `.frag` files without converting anything, and still exports IFC from the IFC files next to them.

## How much a folder can hold

Memory decides, and it goes by what is shown and from how close, not by file size alone. The test project was the Etihad Arena: ten discipline models of 99 to 328 MB of IFC each, 1.9 GB, 276,107 elements and 1.9 million items in all. It was opened in headless Chromium on two cores with software rendering and 6 GB of memory for the whole browser, which is far less than a desktop with a graphics card has:

| | Time | Memory of the tab |
| --- | --- | --- |
| Reading the folder and checking it for repeats | 16 s | |
| Converting and showing all ten in the browser | 23 to 28 min | 4.6 GB at the peak, 3.2 GB afterwards |
| The same folder prepared with `npm run convert -- <folder>` (18 min, 3.2 GB at the peak) and opened from its `.frag` files | 12 min | 3.5 GB at the peak, 3.4 GB afterwards |

On top of the tab's memory comes about 1 GB in the browser's graphics process. Converting is processor work and takes about as long on the command line. Opening the `.frag` files is slow here only because software rendering keeps both cores busy as soon as a large scene is on screen: the largest `.frag` of the project, 89 MB, opens in 17 s while nothing else is shown. Showing and hiding models, showing one alone, zooming to it and picking elements all worked with the ten models loaded.

The figures above are with the whole site in view. Going in close with all ten models shown makes the engine build the full geometry of everything nearby, and that was more than the 6 GB held: the tab ran out of memory. Geometry is only built for what is shown, so on a machine of that size, show only the models being worked on before zooming in. Opened in name order instead of largest first, the same folder ran out at the eighth model, which is why the order described above exists.

## Tools

Select (click, Ctrl-click, box), hide, isolate, X-ray, fit, standard views, perspective or orthographic camera, orbit / first-person / plan navigation, three render styles, length, area, angle and volume measurement, section planes, and storey plans.

| Key | Action |
| --- | --- |
| `Esc` | Leave the current tool, or clear the selection |
| `F` | Fit the selection (or the whole model) |
| `H` / `I` / `X` | Hide, isolate, X-ray the selection |
| `Shift+A` | Show everything |
| `Enter` | Finish an area or volume measurement |
| `Delete` | Remove the measurement or section plane under the cursor |

## Panels

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

## IDS coverage

The checker was run against buildingSMART's official IDS 1.0 test cases with this app's own importer settings: 290 of 307 pass. The 17 that do not all depend on data the Fragments importer does not keep: surface styles as entities (13 cases), IfcMaterialProperties (2), predefined property sets such as IfcDoorPanelProperties (1), and a classification attached to a material through an external reference (1).

## Assistant

The assistant runs Claude with a set of tools that execute in the browser against the loaded model (find elements, read properties, take off quantities, run the health checks, select or isolate in 3D), so every number in an answer comes from the model. Your question, and the results of the tools it calls (counts, names, property values), are sent to Anthropic through your own API key. Geometry and the file itself are not sent.
