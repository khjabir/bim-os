// Importer settings shared by the browser worker and the command-line converter
// (scripts/convert-ifc.mjs reads the same JSON), so both produce identical models.
//
// The default importer leaves out a few relations and classes the analysis
// tools rely on: classification references, groups / systems / zones, openings
// (void and fill coupling), imperial units and the IFC2x3 door / window
// "style" type objects.

import type * as FRAGS from "@thatopen/fragments";
import * as WEBIFC from "web-ifc";
import extras from "./importer-extras.json";

export function extendImporter(importer: FRAGS.IfcImporter) {
  const codes = WEBIFC as unknown as Record<string, number | undefined>;
  for (const [name, mapping] of Object.entries(extras.relations)) {
    const code = codes[name];
    if (typeof code === "number") importer.relations.set(code, mapping);
  }
  for (const name of extras.abstractClasses) {
    const code = codes[name];
    if (typeof code === "number") importer.classes.abstract.add(code);
  }
}
