// Revit categories that are assets or rooms, shared by the Convert page and the register.

/** Categories that hold rooms and spaces. */
export const SPACE_CATEGORIES = new Set(["Rooms", "Spaces", "MEP Spaces", "Room", "Space"]);

/** Categories that are maintainable assets by default. */
export const DEFAULT_ASSET_CATEGORIES = [
  "Mechanical Equipment",
  "Plumbing Equipment",
  "Electrical Equipment",
  "Electrical Fixtures",
  "Lighting Fixtures",
  "Lighting Devices",
  "Fire Alarm Devices",
  "Fire Protection",
  "Sprinklers",
  "Communication Devices",
  "Data Devices",
  "Security Devices",
  "Nurse Call Devices",
  "Telephone Devices",
  "Audio Visual Devices",
  "Mechanical Control Devices",
  "Air Terminals",
  "Duct Accessories",
  "Pipe Accessories",
  "Plumbing Fixtures",
  "Specialty Equipment",
  "Medical Equipment",
  "Food Service Equipment",
  "Vertical Circulation",
  "Doors",
];

/** Fields shown first on the Convert page (the rest behind "all fields"). */
export const KEY_FIELDS = [
  "manufacturer",
  "model",
  "serialNumber",
  "tag",
  "barCode",
  "installationDate",
  "manufactureYear",
  "warrantyStartDate",
  "warrantyDurationParts",
  "warrantyEndDate",
  "expectedLife",
  "endOfLife",
  "replacementCost",
  "ppmTask",
  "ppmFrequency",
  "space",
  "systemName",
  "panel",
];

/** The asset code pattern used when none is set: building, floor, kind and a number ("EA-L03-AHU-001"). */
export const DEFAULT_CODE_PATTERN = "{building}-{floor}-{kind}-{seq}";

/** Pattern tokens, for the Convert page. */
export const CODE_TOKENS = ["{site}", "{building}", "{floor}", "{room}", "{kind}", "{discipline}", "{system}", "{tag}", "{type}", "{seq}", "{seq4}"];

/** Initials of a name, at most four letters ("Etihad Arena" -> "EA"); a single word gives its first three letters. */
export function initials(name: string): string {
  const words = (name ?? "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words
    .map((w) => (/^\d+$/.test(w) ? w : w[0]))
    .join("")
    .slice(0, 4)
    .toUpperCase();
}
