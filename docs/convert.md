# Convert to IFC

[README](../README.md) · [IFC viewer](ifc-viewer.md) · [Revit and Navisworks](revit-and-navisworks.md) · [Convert to IFC](convert.md) · [Asset register](asset-register.md) · [Facility management](facility.md) · [Development](development.md) · [Testing](testing.md)

The Convert page assembles IFC4 files from whatever is at hand: a Revit model, a Navisworks model, a model someone shared in the Autodesk Viewer, floor plan drawings, or a mix. It works in four steps, top to bottom on the page.

## 1. Sources

Drop files on the page or use *Add files*:

| Source | How it is read |
| --- | --- |
| Revit `.rvt` | *Autodesk cloud, then convert here* (needs APS keys): Autodesk translates the model for its viewer, the app opens it in a hidden viewer panel and reads every element's geometry and key properties. *Revit's own IFC exporter*: Autodesk runs Revit's IFC export; the IFC is kept as delivered and listed next to the generated files. *In the browser*: the rvt-rs reader described in [Revit and Navisworks](revit-and-navisworks.md), no upload. |
| Navisworks `.nwd`, `.nwc` | *Autodesk cloud, then convert here* (needs APS keys), as for Revit; every source file inside a federated NWD becomes its own part. Without keys, use a viewer link instead. |
| Autodesk Viewer link | See below. Arrives as model data, like the cloud route. |
| Extracts `.eapk`, `ifcstudio-*.bin.gz`, `ifcstudio-*-tex*.png`, `ea-nwd-*.bin.gz` | Files saved by the bookmarklet (model data, properties and texture pictures), or by the earlier Etihad Arena extraction (older format, read as is). |
| Floor plans `.pdf`, `.png`, `.jpg` | Each page or image becomes a plan to trace (step 2). |
| IFC `.ifc`, `.ifczip` | Passed through to the viewer hand-off. |

## Autodesk Viewer links

A model shared on viewer.autodesk.com (or open in Autodesk Construction Cloud, or any page running the Autodesk viewer) cannot be fetched or framed from another site, so a bookmarklet does the reading on the viewer page itself:

1. Drag *IFC Studio extractor* from the card to the bookmarks bar, once. (*Copy as console snippet* gives the same code for pasting into the developer console where bookmarklets are blocked.)
2. Paste the link and click *Open*. The viewer opens in a new tab that can talk back to this page.
3. When the model has loaded, click the bookmark. A small panel lists the source files in the model; pick them, choose all properties (the default) or key ones only, and click *Send to IFC Studio*. The model arrives under Sources, with its materials and texture pictures.

The bookmarklet carries the extractor itself, so after updating the app, drag it to the bookmarks bar again (the old one keeps working, without materials beyond colour and opacity).

If the viewer was opened some other way, the panel cannot reach the app and offers *Download .eapk* instead: one file with everything, to drop on the Convert page. The bookmarklet only reads what the viewer already shows and sends it nowhere but to the IFC Studio window or a local download; use it on models you are allowed to export. Pieces the viewer has not loaded (models too big for its memory budget) are counted in the panel.

## 2. Floor plans

*Edit* opens a plan in the editor:

- **Scale**: for a PDF, type the drawing scale (1 : 100); for any plan, *Measure a known length* (click both ends of a dimension, type its length).
- **Position**: pick the plan point that sits at a given X / Y (a grid intersection, a building corner) and align a line with the X axis, so the plan lines up with a model. Leave both at zero for plans on their own.
- **Storey**: name, elevation and wall height, or pick one of the model's storeys.
- **Trace walls**: walls drawn *Filled* (solid poché), as *Two lines*, or as *One line*; thickness range, shortest wall, door gap. Thin lines (text, dimensions, hatching, furniture) are ignored, walls are squared to the plan's main directions and joined at corners, and the floor slab outline is the outside of the walls with door and window gaps closed. *Limit tracing* leaves out title blocks and details.
- **Check**: select, move the ends of, or delete walls, draw missing ones, and drag the slab outline's corners.

Traced plans are written as IfcWall (extruded rectangle profiles with an axis line, Pset_WallCommon.IsExternal, Qto_WallBaseQuantities) and an IfcSlab (extruded outline, Qto_SlabBaseQuantities), in their own discipline or any other.

## 3. Assemble

Every source file is listed with its element count and main categories, and a discipline suggested from its name (AR, ST, HV, PW, FS, EL, ...) or, failing that, from what it contains. Files with the same discipline go into the same IFC. Below that:

- **Storeys**, found from the Revit levels elements are placed on. The viewer carries level names but not elevations, so each level's height is estimated from where its elements stand; levels at the same height in different files (an architectural *L01 - Mezzanine Level F.F.L.* and a structural *STR - 01 - TOS - MEZZANINE LEVEL*) become one storey, and levels with very few elements are dropped. Names and heights can be edited; elements of a level that is not listed go by height.
- **Site origin**: *Automatic* keeps the model's coordinates, moving the site placement to the model when it is far from the origin (survey coordinates), so element coordinates stay small. *Custom* takes an origin and a rotation. Every file uses the same site, building and storey ids, so the files line up and federate.
- **Categories** to leave out, and a pattern for families or types to leave out.

## 4. Generate

One IFC per discipline and, with more than one discipline, a federated IFC with everything (same GlobalIds as the discipline files). Elements are classified from their Revit category and family name into IFC4 classes and predefined types (pipes, fittings, valves by kind, dampers, sanitary terminals, sensors, alarms, lights, outlets, transport elements and so on; anything else is an IfcBuildingElementProxy). GlobalIds are the Revit ones: Navisworks' item GUID, or the GUID Revit's own exporter derives from an element's UniqueId; elements without one get a stable hashed id. Each element carries the property sets *IFCStudio_Source* (element id, source GUID, category, family, type, level, workset, system, size, mark, ...; lengths in millimetres) and *IFCStudio_Provenance*, plus every property group of the viewer when *All properties* was extracted. Geometry is the model's own tessellation in millimetres, with shapes used more than once written once and placed by IfcMappedItem (non-uniform scaling allowed); mirrored copies get their own mirrored shape, so no viewer has to deal with a reflecting placement. *Open in the model viewer* hands the discipline files to the IFC viewer; *Save all to a folder* writes them to disk (Chromium browsers) or downloads them.

## Materials and textures

The extractor reads each material as the viewer shades it: diffuse colour, opacity, specular colour and shininess, metal, emissive colour, its name where the viewer keeps one, and the texture picture with the matrix that places it, together with each shape's texture coordinates and vertex colours, and line work. In the IFC:

- Every material becomes an IfcSurfaceStyle: IfcSurfaceStyleRendering with the surface colour, transparency, specular colour, IfcSpecularExponent and a reflectance method (PHONG, METAL, GLASS), plus IfcSurfaceStyleWithTextures when it has a picture. The surface colour is what the viewer's rendering averages to (the picture's average colour times the diffuse colour, metals lightened by their reflections), so viewers that show one colour per surface, the app's own model viewer among them, still show the right colours.
- Pictures are IfcImageTexture files in a `textures/` folder next to the IFC files (*PNG files*, the default), IfcBlobTexture inside the IFC (*In the IFC*), or left out. Each textured shape gets an IfcIndexedTriangleTextureMap whose coordinates already include the material's texture matrix, with its own index list so welded vertices keep their seams. *Save all to a folder* writes the `textures` folder too; *With textures* and *Download all (.zip)* give archives with the same layout.
- Vertex colours become IfcIndexedColourMap face colours (a single colour when a shape has only one).
- Material names (Navisworks geometry nodes, or the viewer's material) are IfcMaterial, or an IfcMaterialConstituentSet when an element has several, each with an IfcMaterialDefinitionRepresentation carrying its style.
- Elements of one Revit family type share a type object (IfcWallType, IfcPipeSegmentType, ...) named *Family:Type*, with the *Revit Type* properties.
- Elements made only of lines (model lines, separation lines, when their category is not left out) become IfcAnnotation with IfcIndexedPolyCurve curves.

Geometry stays the viewer's triangles: the viewer never receives Revit's parametric solids, so no tool working from it can recover them.

## Preview

*Show preview* draws the parts and categories that will be converted, with their materials and textures, in a 3D view on the page (three.js; shapes used many times are drawn instanced). *IFC colours* shows the single colour per surface that viewers without textures show. Clicking a surface names its element, material and texture. Models over six million triangles leave out their most detailed small elements in the preview (not in the IFC).

## Asset register

The *Asset register* card on the same page turns the model into asset data for facilities management: an asset register, a COBie 2.4 workbook and single-line diagrams, and the same information in the IFC files. See [Asset register](asset-register.md).

## Performance

Everything heavy runs in workers: reading and analysing models, writing IFC, building the preview, tracing plans. Writing the 88,000-element fire-protection model of the Etihad Arena took 14 s and gave a 330 MB file (measured on the command line with the same code). Output files are kept as Blobs, so leaving the page for the viewer and coming back keeps them.
