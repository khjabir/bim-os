// Readable names for IFC classes. Fragments stores classes in upper case
// (IFCWALLSTANDARDCASE); web-ifc ships the schema with its original casing,
// which is used here to recover "IfcWallStandardCase" and "Wall standard case".

import * as WEBIFC from "web-ifc";

let table: Map<string, string> | null = null;

function names(): Map<string, string> {
  if (table) return table;
  table = new Map();
  const schemas = WEBIFC as unknown as Record<string, Record<string, unknown> | undefined>;
  for (const schema of ["IFC4X3", "IFC4", "IFC2X3"]) {
    for (const name of Object.keys(schemas[schema] ?? {})) {
      const upper = name.toUpperCase();
      if (!table.has(upper)) table.set(upper, name);
    }
  }
  return table;
}

const LABEL_OVERRIDES: Record<string, string> = {
  IFCBUILDINGSTOREY: "Storey",
  IFCWALLSTANDARDCASE: "Wall (standard case)",
  IFCWALLELEMENTEDCASE: "Wall (elemented case)",
  IFCSLABSTANDARDCASE: "Slab (standard case)",
  IFCSLABELEMENTEDCASE: "Slab (elemented case)",
  IFCBEAMSTANDARDCASE: "Beam (standard case)",
  IFCCOLUMNSTANDARDCASE: "Column (standard case)",
  IFCDOORSTANDARDCASE: "Door (standard case)",
  IFCWINDOWSTANDARDCASE: "Window (standard case)",
  IFCMEMBERSTANDARDCASE: "Member (standard case)",
  IFCPLATESTANDARDCASE: "Plate (standard case)",
  IFCOPENINGELEMENT: "Opening",
  IFCELEMENTQUANTITY: "Quantity set",
};

/** "IFCWALLSTANDARDCASE" -> "IfcWallStandardCase". */
export function ifcClassName(category: string | null | undefined): string {
  if (!category) return "Unknown";
  const upper = category.toUpperCase();
  const known = names().get(upper);
  if (known) return known;
  if (!upper.startsWith("IFC")) return category;
  return "Ifc" + upper.charAt(3) + upper.slice(4).toLowerCase();
}

/** "IFCWALLSTANDARDCASE" -> "Wall (standard case)", "IFCFLOWSEGMENT" -> "Flow segment". */
export function prettyCategory(category: string | null | undefined): string {
  if (!category) return "Unknown";
  const upper = category.toUpperCase();
  const override = LABEL_OVERRIDES[upper];
  if (override) return override;
  const proper = ifcClassName(upper).replace(/^Ifc/, "");
  const words = proper.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ");
  return words.map((word, index) => (index === 0 ? word : word.toLowerCase())).join(" ");
}
