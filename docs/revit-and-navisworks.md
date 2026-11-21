# Revit and Navisworks

[README](../README.md) · [IFC viewer](ifc-viewer.md) · [Revit and Navisworks](revit-and-navisworks.md) · [Convert to IFC](convert.md) · [Asset register](asset-register.md) · [Development](development.md) · [Testing](testing.md)

## Revit viewer (`/rvt`)

Revit's file format is proprietary, so there are two ways in, switchable in the *Import* panel. Both produce an IFC, which then opens in the [IFC viewer](ifc-viewer.md) with every tool there, including *Export > Selection as IFC*.

**In the browser** (default, no account). The file is read on your computer by [rvt-rs](https://github.com/DrunkOnJava/rvt-rs) 0.17.0, an open-source reader compiled to WebAssembly and included in `public/rvt/`. Nothing is uploaded. This is experimental: rvt-rs is an independent project, not Autodesk software. It recovers part of a project, many shapes are simplified (some elements are only bounding boxes), some elements are left out, and parameters are incomplete. Its own support matrix rates Revit 2023 to 2025 projects as partial and other releases as experimental. Each file gets a report built from rvt-rs's diagnostics: elements exported, how many have geometry, how many are boxes, what was left out and why. Do not measure or coordinate from this view. Tested here on three public projects (Revit 2023, 2024 and 2025); the 34 MB Revit 2024 one produced 970 elements in 32 s.

**Autodesk cloud** (exact). The file is uploaded to your Autodesk Platform Services account, Autodesk's own Revit engine exports it to IFC with the export setup you choose, and the IFC is downloaded and opened. By default the upload and its export are deleted from Autodesk's cloud as soon as the IFC has arrived.

## Navisworks viewer (`/nwd`)

Navisworks files can only be read by Autodesk software, so this viewer needs Autodesk Platform Services. The file is uploaded and translated, then shown in Autodesk's own viewer, which is loaded from Autodesk's servers when you open a model. Its toolbar gives you navigation, measuring, sectioning, a model browser and a property panel.

The side panel adds what the request asked for:

- **Selection** at three levels (part, object, assembly), with zoom, isolate and hide.
- **Groups** by level of the model tree or by any property, and a search by name or property value. Clicking a group selects it.
- **Export IFC** for the selection, for everything visible, or for the whole model.

The IFC is written by this app (`src/lib/ifc-writer`): IFC4 with tessellated geometry in metres, a colour per mesh, every property of each object as property sets, and the object's place in the Navisworks tree. Navisworks files carry no IFC classes, so classes are guessed from category and object names (walls, doors, pipes and so on); anything unrecognised becomes an IfcBuildingElementProxy, and the guessing can be switched off. Storeys can be taken from a level property when the file has one. Exports are meshes, not parametric solids, and large exports are large files: the panel shows the triangle count and an estimated size first. *Open in IFC viewer* loads the result into the IFC viewer for checking and analysis.

Uploads live in a bucket that Autodesk empties after 24 hours. Models still in the cloud are listed in the panel so they can be reopened without uploading again, or deleted at once.

*Open the built-in sample* loads a small mechanical model shipped with the app, so selection, grouping and IFC export can be tried without an Autodesk account. It is not a building model.
