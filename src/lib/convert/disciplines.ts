// Discipline suggestions for source files: from the file name first (the
// discipline codes most naming standards put in it), then from what the
// file contains (which Revit categories dominate). Users can change any
// suggestion; files with the same discipline are written to the same IFC.

export interface Discipline {
  id: string;
  label: string;
  /** Short code used in output file names. */
  code: string;
}

export const DISCIPLINES: Discipline[] = [
  { id: "architecture", label: "Architecture", code: "AR" },
  { id: "structure", label: "Structure", code: "ST" },
  { id: "mechanical", label: "Mechanical (HVAC)", code: "ME" },
  { id: "plumbing", label: "Plumbing and drainage", code: "PL" },
  { id: "fire", label: "Fire protection", code: "FP" },
  { id: "electrical", label: "Electrical", code: "EL" },
  { id: "facade", label: "Façade", code: "FC" },
  { id: "interiors", label: "Interiors", code: "ID" },
  { id: "vertical", label: "Vertical transport", code: "VT" },
  { id: "signage", label: "Signage", code: "SG" },
  { id: "landscape", label: "Landscape", code: "LA" },
  { id: "civil", label: "Civil", code: "CV" },
  { id: "plans", label: "Architecture (from plans)", code: "PLN" },
  { id: "other", label: "Other", code: "XX" },
];

export function disciplineLabel(id: string): string {
  return DISCIPLINES.find((d) => d.id === id)?.label ?? id;
}

export function disciplineCode(id: string): string {
  const known = DISCIPLINES.find((d) => d.id === id);
  if (known) return known.code;
  const letters = id.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
  return letters.slice(0, 3) || "XX";
}

// File-name tokens, checked as whole tokens between separators ("-AR-", "_MEP_", " ST ").
const NAME_TOKENS: [RegExp, string][] = [
  [/^(fa[cç]ade|cw|curtainwall|cladding)$/, "facade"],
  [/^(ar|arc|arch|architecture|architectural|a)$/, "architecture"],
  [/^(st|str|stru|struct|structure|structural|s)$/, "structure"],
  [/^(hv|hvac|me|mec|mech|mechanical|ac|mv|m)$/, "mechanical"],
  [/^(pl|ph|plb|plumbing|pw|dr|drainage|ws|wa|ds|sanitary|p)$/, "plumbing"],
  [/^(fs|fp|ff|spr|sprinkler|sprinklers|fireprotection|fire|firefighting)$/, "fire"],
  [/^(el|elec|electrical|elv|ev|lv|lt|lighting|fa|firealarm|e)$/, "electrical"],
  [/^(id|int|interior|interiors|ffe|fitout)$/, "interiors"],
  [/^(vt|lift|lifts|elevator|elevators|escalator|escalators)$/, "vertical"],
  [/^(sg|sign|signage|wayfinding)$/, "signage"],
  [/^(la|ls|land|landscape|landscaping|hardscape|softscape)$/, "landscape"],
  [/^(cv|civ|civil|infra|infrastructure|roads)$/, "civil"],
];

// Category -> discipline weights for the content-based guess.
const CATEGORY_DISCIPLINE: [RegExp, string][] = [
  [/^(Curtain Panels|Curtain Wall Mullions|Curtain Systems)$/, "facade"],
  [/^Structural |^(Supports)$/, "structure"],
  [/^(Ducts|Flex Ducts|Duct Fittings|Duct Accessories|Duct Insulations|Duct Linings|Air Terminals|Mechanical Equipment|MEP Fabrication Ductwork|Mechanical Control Devices)$/, "mechanical"],
  [/^(Sprinklers|Fire Protection)$/, "fire"],
  [/^(Pipes|Flex Pipes|Pipe Fittings|Pipe Accessories|Pipe Insulations|Plumbing Fixtures|Plumbing Equipment|MEP Fabrication Pipework)$/, "plumbing"],
  [/^(Cable Trays|Cable Tray Fittings|Conduits|Conduit Fittings|Wires|Electrical Equipment|Electrical Fixtures|Lighting Fixtures|Lighting Devices|Fire Alarm Devices|Communication Devices|Data Devices|Security Devices|Telephone Devices|Nurse Call Devices|Audio Visual Devices|MEP Fabrication Containment)$/, "electrical"],
  [/^(Furniture|Furniture Systems|Casework|Specialty Equipment|Entourage)$/, "interiors"],
  [/^(Vertical Circulation)$/, "vertical"],
  [/^(Signage)$/, "signage"],
  [/^(Planting|Topography|Toposolid|Site|Hardscape|Parking)$/, "landscape"],
  [/^(Walls|Doors|Windows|Floors|Ceilings|Roofs|Railings|Handrails|Top Rails|Stairs|Runs|Landings|Ramps|Columns|Generic Models|Rooms)$/, "architecture"],
];

function tokens(name: string): string[] {
  const stem = name.replace(/\.(nwc|nwd|nwf|rvt|ifc|dwg|dgn|skp|fbx)$/i, "");
  return stem
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** Discipline from a file name alone, or null. */
export function disciplineFromName(name: string): string | null {
  const ts = tokens(name);
  // Prefer multi-letter codes over the one-letter ones ("A", "S", "M") that also appear in other positions.
  for (const pass of [false, true]) {
    for (const t of ts) {
      if (!pass && t.length < 2) continue;
      for (const [re, id] of NAME_TOKENS) if (re.test(t)) return id;
    }
  }
  // Joined words ("ArchitecturalModel", "MEPModel").
  const joined = ts.join("");
  if (/fa[cç]ade|curtainwall/.test(joined)) return "facade";
  if (/signage/.test(joined)) return "signage";
  if (/sprinkler|fireprot|firefight/.test(joined)) return "fire";
  if (/hvac|mechanical/.test(joined)) return "mechanical";
  if (/plumbing|drainage/.test(joined)) return "plumbing";
  if (/electrical|lighting/.test(joined)) return "electrical";
  if (/structur/.test(joined)) return "structure";
  if (/architect/.test(joined)) return "architecture";
  if (/landscap/.test(joined)) return "landscape";
  return null;
}

/** Discipline from a histogram of Revit categories (element counts). */
export function disciplineFromCategories(histogram: Record<string, number>): string | null {
  const score = new Map<string, number>();
  let total = 0;
  for (const [category, count] of Object.entries(histogram)) {
    total += count;
    for (const [re, id] of CATEGORY_DISCIPLINE) {
      if (re.test(category)) {
        score.set(id, (score.get(id) ?? 0) + count);
        break;
      }
    }
  }
  let best: string | null = null;
  let bestScore = 0;
  for (const [id, s] of score) {
    if (s > bestScore) {
      best = id;
      bestScore = s;
    }
  }
  // A file where the recognised categories are a small minority stays unguessed.
  return best && bestScore >= total * 0.2 ? best : null;
}

export function suggestDiscipline(fileName: string, histogram: Record<string, number>): { id: string; reason: string } {
  const byName = disciplineFromName(fileName);
  if (byName) return { id: byName, reason: "file name" };
  const byContent = disciplineFromCategories(histogram);
  if (byContent) return { id: byContent, reason: "content" };
  return { id: "other", reason: "no match" };
}
