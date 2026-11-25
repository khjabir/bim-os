// Notes on a drawing: the general notes, title block and legends around a
// plan, read for what the model can use (storey height and level, room
// height, slab and wall thicknesses, door and window sizes, drawing units,
// project, building and storey names). Rules read the usual wordings; the
// on-device assistant reads free text. Every finding keeps the words it came
// from, and nothing is applied until the user says so.

import type { JsonTask } from "@/lib/ondevice/types";

export type NoteField =
  | "projectName"
  | "buildingName"
  | "storeyName"
  | "levelElevation"
  | "storeyHeight"
  | "ceilingHeight"
  | "slabThickness"
  | "doorHeight"
  | "windowSill"
  | "windowHead"
  | "windowHeight"
  | "externalWallThickness"
  | "internalWallThickness"
  | "units";

export type DrawingUnits = "mm" | "cm" | "m" | "in" | "ft";

export interface NoteFinding {
  field: NoteField;
  /** Metres for lengths, the units for "units", text for names. */
  value: number | string;
  /** The words on the drawing it was read from. */
  quote: string;
  source: "rules" | "assistant";
}

export interface FieldInfo {
  label: string;
  kind: "length" | "text" | "units";
  /** Metres, for lengths. */
  min?: number;
  max?: number;
  /** For the assistant. */
  meaning: string;
}

export const NOTE_FIELDS: Record<NoteField, FieldInfo> = {
  projectName: { label: "Project name", kind: "text", meaning: "the project's name or title" },
  buildingName: { label: "Building name", kind: "text", meaning: "the building's name" },
  storeyName: { label: "Storey", kind: "text", meaning: "which floor this plan shows, e.g. Ground floor, Level 2" },
  levelElevation: { label: "Floor level", kind: "length", min: -30, max: 500, meaning: "finished floor level (FFL) of this floor" },
  storeyHeight: { label: "Floor to floor height", kind: "length", min: 2, max: 12, meaning: "floor to floor (storey) height" },
  ceilingHeight: { label: "Room height (floor to ceiling)", kind: "length", min: 2, max: 10, meaning: "clear height from floor to ceiling" },
  slabThickness: { label: "Slab thickness", kind: "length", min: 0.05, max: 1, meaning: "floor slab thickness" },
  doorHeight: { label: "Door height", kind: "length", min: 1.8, max: 4, meaning: "height of the doors" },
  windowSill: { label: "Window sill height", kind: "length", min: 0, max: 2.2, meaning: "height of window sills above the floor" },
  windowHead: { label: "Window head height", kind: "length", min: 1.2, max: 5, meaning: "height of the top of the windows above the floor" },
  windowHeight: { label: "Window height", kind: "length", min: 0.3, max: 4, meaning: "height of the windows themselves" },
  externalWallThickness: { label: "External wall thickness", kind: "length", min: 0.08, max: 1, meaning: "thickness of the external walls" },
  internalWallThickness: { label: "Internal wall thickness", kind: "length", min: 0.04, max: 0.5, meaning: "thickness of the internal walls or partitions" },
  units: { label: "Drawing units", kind: "units", meaning: "the units the dimensions are given in" },
};

export const NOTE_FIELD_IDS = Object.keys(NOTE_FIELDS) as NoteField[];

// ---------------------------------------------------------------------------
// Finding the notes

export interface NoteText {
  text: string;
  /** Plan pixels. */
  x: number;
  y: number;
  h: number;
  /** Part of a dimension. */
  dim: boolean;
}

export interface NoteBlock {
  id: number;
  text: string;
  x: number;
  y: number;
}

const KEYWORDS = /\b(notes?|general|all|unless|otherwise|dimensions?|height|heights|level|levels|ffl|ssl|fcl|slab|walls?|partitions?|doors?|windows?|sills?|ceilings?|project|title|building|client|drawing|dwg|scale|floor|plan|storey|story|thk|thick|thickness|mm|millimet\w*)\b/gi;

/** Lines of text that are labels of rooms, dimensions, tags (D01, W2) or grid bubbles are not notes. */
function noteLike(text: string): boolean {
  const t = text.trim();
  if (t.length < 4) return false;
  if (!/[A-Za-zÀ-ɏ؀-ۿ]{2}/.test(t)) return false;
  if (/^[A-Z]{1,3}[-.]?\d{1,4}[A-Z]?$/i.test(t)) return false;
  return true;
}

/**
 * Groups the texts that are not room labels or dimensions into blocks
 * (lines that sit one under the other), ranked by how much they look like
 * notes, up to `budget` characters.
 */
export function noteBlocks(texts: NoteText[], insideRoom: (x: number, y: number) => boolean, budget = 2400): NoteBlock[] {
  const lines = texts
    .filter((t) => !t.dim && noteLike(t.text))
    .filter((t) => {
      // A short text in a room is its label.
      const short = t.text.length < 32 && !/\n/.test(t.text);
      return !(short && insideRoom(t.x, t.y));
    })
    .map((t) => ({ ...t, text: t.text.replace(/[ \t]+/g, " ").trim() }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  // Lines under each other with about the same left edge and height form a block.
  const blocks: { items: typeof lines; x: number; y: number; h: number; bottom: number }[] = [];
  for (const line of lines) {
    // Positions are the texts' middles: the left edge from the length of the longest line (about half the height a character).
    const longest = Math.max(...line.text.split("\n").map((l) => l.length));
    const left = line.x - 0.28 * line.h * longest;
    const target = blocks.find((b) => Math.abs(b.h - line.h) <= 0.35 * Math.max(b.h, line.h) && line.y - b.bottom <= 2.2 * Math.max(b.h, line.h) && line.y >= b.bottom - 0.5 * b.h && Math.abs(b.x - left) <= 3 * Math.max(b.h, line.h));
    const rows = line.text.split("\n").length;
    if (target) {
      target.items.push(line);
      target.bottom = line.y + rows * line.h * 1.2;
    } else blocks.push({ items: [line], x: left, y: line.y, h: line.h, bottom: line.y + rows * line.h * 1.2 });
  }
  const scored = blocks.map((b, i) => {
    const text = b.items
      .sort((p, q) => p.y - q.y || p.x - q.x)
      .map((l) => l.text)
      .join("\n");
    const hits = text.match(KEYWORDS)?.length ?? 0;
    return { id: i + 1, text, x: b.x, y: b.y, score: hits * 3 + Math.min(text.length, 300) / 60 };
  });
  scored.sort((a, b) => b.score - a.score);
  const out: NoteBlock[] = [];
  let used = 0;
  for (const s of scored) {
    if (s.score < 1) break;
    const text = s.text.length > 900 ? `${s.text.slice(0, 900)}…` : s.text;
    if (used + text.length > budget) continue;
    used += text.length;
    out.push({ id: out.length + 1, text, x: s.x, y: s.y });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lengths

const UNIT_M: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 };

/** "2700", "2.7m", "+3.600", "300 MM", "9'-0\"": metres, guessing the unit from the number when none is written. */
export function parseLength(text: string, unitHint: DrawingUnits | null = null): number | null {
  const t = text.trim().toLowerCase().replace(/^±/, "+");
  const feet = /^([+-]?\d+)\s*['’]\s*-?\s*(\d+(?:\.\d+)?)?\s*(?:"|”|'')?$/.exec(t);
  if (feet) return (Number(feet[1]) * 12 + Number(feet[2] ?? 0)) * 0.0254;
  const m = /^([+-]?\s*\d+(?:[.,]\d+)?)\s*(mm|millimet(?:re|er)s?|cm|centimet(?:re|er)s?|m|met(?:re|er)s?|in|inch(?:es)?|ft|feet|foot)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1].replace(/\s+/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const unit = m[2] ? (m[2].startsWith("mm") || m[2].startsWith("milli") ? "mm" : m[2].startsWith("c") ? "cm" : m[2].startsWith("i") ? "in" : m[2].startsWith("f") ? "ft" : "m") : null;
  if (unit) return n * UNIT_M[unit];
  if (unitHint) return n * UNIT_M[unitHint];
  // No unit: whole numbers from 20 up are millimetres, numbers with decimals metres.
  if (/[.,]/.test(m[1]) && Math.abs(n) < 100) return n;
  if (Math.abs(n) >= 20) return n / 1000;
  return null;
}

const LEN = String.raw`(?<![A-Za-z0-9.])([+-]?[ \t]?\d+(?:[.,]\d+)?[ \t]*(?:mm|millimet(?:re|er)s?|cm|m(?![a-z])|met(?:re|er)s?)?|\d+[ \t]*['’][ \t]*-?[ \t]*\d*(?:\.\d+)?[ \t]*(?:"|”)?)`;
const LEVEL = String.raw`([+±-][ \t]?\d+(?:[.,]\d+)?[ \t]*(?:mm|m(?![a-z]))?|\d+[.,]\d+[ \t]*(?:mm|m(?![a-z]))?|\d+[ \t]*(?:mm|m(?![a-z])))`;
const S = "[ \\t]*";
const SEP = String.raw`${S}(?:is|of|at|to|=|:|@|-|–)?${S}`;
const UNIT_WORDS = String.raw`millim[eè]tres?|millimet(?:re|er)s?|mm|centim[eè]tres?|centimet(?:re|er)s?|cm|m[eè]tres?|met(?:re|er)s?|metros|m(?![a-z])|inches|feet`;
const OE = "(?:ö|oe|o)";
const AE = "(?:ä|ae|a)";

const ORDINALS = "basement|lower ground|upper ground|ground|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|mezzanine|podium|roof|typical|\\d+(?:st|nd|rd|th)";

interface Rule {
  field: NoteField;
  re: RegExp;
  /** Which group holds the value. */
  group: number;
}

const R = (field: NoteField, source: string, flags = "gi"): Rule => ({ field, re: new RegExp(source, flags), group: 1 });

const RULES: Rule[] = [
  R("storeyHeight", String.raw`\b(?:floor[ \t-]*to[ \t-]*floor(?:${S}(?:heights?|ht\.?))?|f\.?t\.?f\.?|(?:storey|story|floor)${S}(?:heights?|ht\.?))${SEP}${LEN}`),
  R("storeyHeight", String.raw`\b(?:geschossh${OE}he|hauteur${S}d['’]?${S}[ée]tage|altura${S}(?:de${S}planta|entre${S}plantas|de${S}piso))${SEP}${LEN}`),
  R("ceilingHeight", String.raw`\b(?:floor[ \t-]*to[ \t-]*ceiling(?:${S}(?:heights?|ht\.?))?|clear${S}(?:heights?|ht\.?)|(?:false|suspended)?${S}ceiling${S}(?:heights?|ht\.?|level)|room${S}(?:heights?|ht\.?)|f\.?c\.?l\.?|c\.?h\.?)(?:[^\d\n]{0,30}?)${SEP}${LEN}`),
  R("ceilingHeight", String.raw`\b(?:hauteur${S}sous${S}plafond|h\.?s\.?p\.?|lichte${S}raumh${OE}he|raumh${OE}he|lichte${S}h${OE}he|altura${S}libre|altura${S}de${S}techo|altezza${S}netta)${SEP}${LEN}`),
  R("levelElevation", String.raw`\b(?:f\.?f\.?l\.?|finished${S}floor${S}level|floor${S}level|o\.?k\.?f\.?f\.?|niveau${S}fini)${SEP}${LEVEL}`),
  R("levelElevation", String.raw`\b(?:s\.?s\.?l\.?|structural${S}slab${S}level|t\.?o\.?s\.?)${SEP}${LEVEL}`),
  R("levelElevation", String.raw`\blevel${S}(?:=|:|@)?${S}([+±-]${S}\d+[.,]\d+${S}(?:m(?![a-z]))?)`),
  R("slabThickness", String.raw`${LEN}${S}(?:thk\.?|thick(?:ness)?)?${S}(?:r\.?c\.?|concrete|reinforced${S}concrete|post[ \t-]*tensioned|p\.?t\.?|hollow[ \t-]*core|composite|flat)?${S}(?:floor${S}|ground${S}|roof${S}|suspended${S})?slabs?\b`),
  R("slabThickness", String.raw`\bslabs?${S}(?:thickness|thk\.?|thick|depth)?${SEP}${LEN}`),
  R("doorHeight", String.raw`\bdoors?${S}(?:heights?|ht\.?|head(?:${S}heights?)?|clear${S}heights?)${SEP}${LEN}`),
  R("doorHeight", String.raw`\b(?:all${S})?doors?${S}(?:are|to${S}be|shall${S}be)?${S}${LEN}${S}(?:high|h\b|height|tall)`),
  R("doorHeight", String.raw`\b(?:t(?:ü|ue|u)rh${OE}he|hauteur${S}des${S}portes|altura${S}de${S}(?:las${S})?puertas)${SEP}${LEN}`),
  R("windowSill", String.raw`\b(?:window${S})?(?:sill|cill)s?${S}(?:heights?|ht\.?|level)?${SEP}${LEN}`),
  R("windowSill", String.raw`\b(?:br(?:ü|ue|u)stungsh${OE}he|all[èe]ge|antepecho)${SEP}${LEN}`),
  R("windowHead", String.raw`\bwindows?${S}head${S}(?:heights?|ht\.?|level)?${SEP}${LEN}`),
  R("windowHead", String.raw`\bwindows?\b(?:[^.\n]|\.(?=\d)){0,40}?\bhead${S}(?:heights?|ht\.?|level)?${SEP}${LEN}`),
  R("windowHeight", String.raw`\bwindows?${S}(?:heights?|ht\.?)${SEP}${LEN}`),
  R("externalWallThickness", String.raw`\b(?:external|exterior|ext\.?|outer|outside|perimeter|facade|façade)${S}walls?\b[^.\n;]{0,40}?${LEN}`),
  R("externalWallThickness", String.raw`${LEN}${S}(?:thk\.?|thick)?${S}(?:[a-z]+[ \t]+){0,3}(?:external|exterior|outer|perimeter)${S}walls?\b`),
  R("externalWallThickness", String.raw`\b(?:au(?:ss|ß)enw${AE}nde?|murs?${S}ext[ée]rieurs?|muros?${S}exteriores|pareti${S}esterne)\b[^.\n;]{0,30}?${LEN}`),
  R("internalWallThickness", String.raw`\b(?:internal|interior|int\.?|inner|partition)${S}(?:walls?|partitions?)\b[^.\n;]{0,40}?${LEN}`),
  R("internalWallThickness", String.raw`\bpartitions?\b[^.\n;]{0,30}?${LEN}`),
  R("internalWallThickness", String.raw`${LEN}${S}(?:thk\.?|thick)?${S}(?:[a-z]+[ \t]+){0,3}(?:internal|interior|partition)${S}(?:walls?|partitions?)\b`),
  R("internalWallThickness", String.raw`\b(?:innenw${AE}nde?|trennw${AE}nde?|cloisons?|murs?${S}int[ée]rieurs?|tabiques?|muros?${S}interiores|tramezzi)\b[^.\n;]{0,30}?${LEN}`),
  R("units", String.raw`\b(?:all${S})?(?:dimensions|dims\.?)${S}(?:are${S})?(?:shown${S}|given${S}|stated${S})?in${S}(${UNIT_WORDS})`),
  R("units", String.raw`\bunits?${S}(?:=|:|-)${S}(${UNIT_WORDS})`),
  R("units", String.raw`\b(?:toutes${S}les${S})?(?:cotes?|dimensions)${S}(?:sont${S})?(?:exprim[ée]es${S}|donn[ée]es${S})?en${S}(${UNIT_WORDS})`),
  R("units", String.raw`\b(?:alle${S})?ma(?:ß|ss)e${S}(?:sind${S})?in${S}(${UNIT_WORDS})`),
  R("units", String.raw`\b(?:cotas|medidas)${S}(?:est[aá]n${S})?en${S}(${UNIT_WORDS})`),
  R("projectName", String.raw`\b(?:project|proj\.?)(?:${S}(?:name|title))?${S}(?::|-|–)${S}([^\n]{3,80})`),
  R("buildingName", String.raw`\b(?:building|bldg\.?)(?:${S}name)?${S}(?::|-|–)${S}([^\n]{2,60})`),
  R("storeyName", String.raw`\b((?:${ORDINALS})${S}(?:floor|level)|(?:level|floor)${S}-?${S}\d{1,3}|basement${S}\d?)${S}(?:general${S}arrangement${S}|layout${S}|floor${S})?plan\b`),
  R("storeyName", String.raw`^${S}((?:level|floor)${S}-?${S}\d{1,3})\b(?![.,]\d)`, "gim"),
];

const UNITS: [RegExp, DrawingUnits][] = [
  [/^(mm|millim)/i, "mm"],
  [/^(cm|centim)/i, "cm"],
  [/^(m|met|mèt)/i, "m"],
  [/^inch/i, "in"],
  [/^feet|^foot|^ft/i, "ft"],
];

function tidyName(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*(?:\bdrawing\b|\bdwg\b|\bscale\b|\bclient\b|\bdate\b|\brev(?:ision)?\b).*$/i, "")
    .replace(/^[\s:–-]+|[\s:–,.-]+$/g, "")
    .trim();
}

function storeyLabel(text: string): string {
  const t = text.replace(/\s+/g, " ").trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Checks a value against its field: lengths in range, names of a sensible length. */
export function validFinding(field: NoteField, value: number | string): boolean {
  const info = NOTE_FIELDS[field];
  if (info.kind === "length") return typeof value === "number" && Number.isFinite(value) && value >= (info.min ?? -Infinity) && value <= (info.max ?? Infinity);
  if (info.kind === "units") return typeof value === "string" && ["mm", "cm", "m", "in", "ft"].includes(value);
  return typeof value === "string" && value.trim().length >= 2 && value.trim().length <= 80;
}

/** The value a rule's match gives, in metres for lengths (levels are metres unless written in mm; other lengths without a unit are in the drawing's units). */
function ruleValue(field: NoteField, raw: string, units: DrawingUnits | null): number | string | null {
  const info = NOTE_FIELDS[field];
  if (info.kind === "units") return UNITS.find(([re]) => re.test(raw.trim()))?.[1] ?? null;
  if (info.kind === "text") return field === "storeyName" ? storeyLabel(raw) : tidyName(raw);
  const r = raw.replace(/\s+/g, " ");
  const whole = !/[.,]/.test(r);
  const big = Math.abs(Number(r.replace(/[^\d.,+-]/g, "").replace(",", "."))) >= 500;
  const hint: DrawingUnits | null = field === "levelElevation" ? (/mm/i.test(r) || (whole && big) ? "mm" : "m") : units === "m" && whole && big ? "mm" : units;
  return parseLength(r, /[a-z'"]/i.test(r) ? null : hint);
}

/** The first statement of a field in a text, by the rules: its value and words. */
function extract(field: NoteField, text: string, units: DrawingUnits | null): { value: number | string; quote: string } | null {
  for (const rule of RULES) {
    if (rule.field !== field) continue;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const value = ruleValue(field, m[rule.group], units);
      if (value !== null && validFinding(field, value)) return { value, quote: m[0].replace(/\s+/g, " ").trim() };
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  return null;
}

/** What the usual wordings of notes say; one finding per field (the first), with the drawing's units when a note gives them. */
export function notesByRules(blocks: NoteBlock[]): NoteFinding[] {
  const all = blocks.map((b) => b.text).join("\n");
  const found: NoteFinding[] = [];
  // Units first: lengths without a unit follow them.
  const u = extract("units", all, null);
  const units = (u?.value as DrawingUnits | undefined) ?? null;
  if (u) found.push({ field: "units", value: u.value, quote: u.quote, source: "rules" });
  for (const field of NOTE_FIELD_IDS) {
    if (field === "units") continue;
    const x = extract(field, all, units);
    if (x) found.push({ field, value: x.value, quote: x.quote, source: "rules" });
  }
  return derive(found);
}

/** A window height from the head and sill heights when the notes give those. */
function derive(findings: NoteFinding[]): NoteFinding[] {
  const get = (f: NoteField) => findings.find((x) => x.field === f);
  const head = get("windowHead"),
    sill = get("windowSill");
  if (head && !get("windowHeight") && typeof head.value === "number") {
    const s = typeof sill?.value === "number" ? sill.value : null;
    if (s !== null && head.value - s >= 0.3) findings.push({ field: "windowHeight", value: Math.round((head.value - s) * 1000) / 1000, quote: [sill!.quote, head.quote].join(" · "), source: head.source });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The assistant's part

export function notesTask(blocks: NoteBlock[]): JsonTask {
  const list = NOTE_FIELD_IDS.map((f) => `${f}: ${NOTE_FIELDS[f].meaning}`).join("\n");
  const text = blocks.map((b) => b.text).join("\n\n");
  return {
    label: "Reading the notes",
    system:
      "You read the notes, title block and legends of an architectural floor plan drawing, in any language. For each item asked for, copy from the text the exact words that state it, the value included (for example FLOOR TO FLOOR HEIGHT 3600), or null when the text does not state it. Never guess and never use typical values. Answer only with compact JSON on one line.",
    user: `Items (name: what it is):\n${list}\n\nText of the drawing:\n${text}`,
    schema: {
      type: "object",
      properties: Object.fromEntries(NOTE_FIELD_IDS.map((f) => [f, { type: ["string", "null"] }])),
      required: [...NOTE_FIELD_IDS],
      additionalProperties: false,
    },
    maxTokens: 700,
  };
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A length in words the assistant pointed at, when the rules do not read them: the one number there with a sensible size. */
function looseLength(field: NoteField, quote: string, units: DrawingUnits | null): number | null {
  const re = new RegExp(LEN, "gi");
  const values: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(quote))) {
    const v = ruleValue(field, m[1], units);
    if (typeof v === "number" && validFinding(field, v)) values.push(v);
  }
  return values.length === 1 ? values[0] : null;
}

/** Words a statement of each field has to contain (in the languages the rules know): the assistant's copied words are checked against them. */
const FIELD_WORDS: Record<NoteField, RegExp> = {
  projectName: /\b(project|proj|projet|projekt|proyecto|progetto|title|titre|titel)\b/i,
  buildingName: /\b(building|bldg|block|tower|wing|gebäude|gebaude|haus|bâtiment|batiment|edificio|bloque|torre)\b/i,
  storeyName: /\b(floor|level|storey|story|basement|mezzanine|podium|roof|etage|étage|geschoss|obergeschoss|erdgeschoss|planta|piano|niveau|plan)\b/i,
  levelElevation: /\b(f\.?f\.?l|s\.?s\.?l|level|niveau|okff|cota|nivel|quota|elevation)\b/i,
  storeyHeight: /\b(floor[ -]*to[ -]*floor|storey|story|f\.?t\.?f|geschoss|étage|etage|planta|piso)\b/i,
  ceilingHeight: /\b(ceiling|clear|soffit|plafond|raumh|lichte|techo|libre|netta|room height|h\.?s\.?p|f\.?c\.?l)/i,
  slabThickness: /\b(slab|decke|dalle|losa|forjado|soletta|solaio)/i,
  doorHeight: /\b(door|doors|tür|tur|porte|portes|puerta|puertas|porta)/i,
  windowSill: /\b(sill|cill|brüstung|brustung|allège|allege|antepecho|alféizar|alfeizar|davanzale)/i,
  windowHead: /\b(head|sturz|linteau|dintel)/i,
  windowHeight: /\b(window|windows|fenster|fenêtre|fenetre|ventana|finestra)/i,
  externalWallThickness: /\b(ext|external|exterior|outer|outside|perimeter|fa[cç]ade|au(ss|ß)en|extérieur|exterieur|exteriores?|esterne)/i,
  internalWallThickness: /\b(int|internal|interior|inner|partitions?|innen|trenn|cloisons?|intérieur|interieur|tabiques?|interiores?|tramezzi)/i,
  units: /\b(dimensions?|dims|units?|cotes|ma(ß|ss)e|medidas|cotas|misure)\b/i,
};

/** The facts in the words the assistant copied: only words that are on the drawing and say what the field is about, values read from them as the rules read them. */
export function readNotes(answer: unknown, blocks: NoteBlock[], units: DrawingUnits | null = null): NoteFinding[] {
  if (!answer || typeof answer !== "object") return [];
  const all = squash(blocks.map((b) => b.text).join("\n"));
  const lines = blocks.flatMap((b) => b.text.split("\n"));
  const out: NoteFinding[] = [];
  const quotes = answer as Record<string, unknown>;
  // The drawing's units first: lengths without a unit follow them.
  const order = ["units", ...NOTE_FIELD_IDS.filter((f) => f !== "units")] as NoteField[];
  let u = units;
  for (const field of order) {
    const raw = quotes[field];
    if (typeof raw !== "string") continue;
    const quote = raw.trim();
    const q = squash(quote);
    if (q.length < 2 || !all.includes(q)) continue;
    const info = NOTE_FIELDS[field];
    // Names are often written after a label ("PROJECT TITLE: SEA VIEW"): their line has to say what they are. Other values have to say it themselves.
    const line = info.kind === "text" ? (lines.find((l) => squash(l).includes(q)) ?? quote) : quote;
    if (!FIELD_WORDS[field].test(line)) continue;
    let value: number | string | null = extract(field, quote, u)?.value ?? null;
    if (value === null) {
      if (info.kind === "length") value = looseLength(field, quote, u);
      else if (info.kind === "units") value = UNITS.find(([re]) => re.test(quote.replace(/^.*\b(?=(?:millim|mm\b|centim|cm\b|m[eè]t|inch|feet))/i, "")))?.[1] ?? null;
      else value = field === "storeyName" ? storeyLabel(quote) : tidyName(quote.replace(/^[^:]{0,30}:\s*/, ""));
    }
    if (value === null || !validFinding(field, value)) continue;
    if (typeof value === "number") value = Math.round(value * 1000) / 1000;
    if (field === "units") u = value as DrawingUnits;
    out.push({ field, value, quote, source: "assistant" });
  }
  return derive(out);
}

/** Rules first; the assistant adds what they missed (and never replaces a rule's finding). */
export function mergeFindings(rules: NoteFinding[], assistant: NoteFinding[]): NoteFinding[] {
  const out = [...rules];
  for (const a of assistant) if (!out.some((r) => r.field === a.field)) out.push(a);
  return out;
}

export function findingText(f: NoteFinding): string {
  const info = NOTE_FIELDS[f.field];
  if (info.kind === "length" && typeof f.value === "number") return `${Math.abs(f.value) < 10 ? f.value.toFixed(f.value % 1 === 0 ? 1 : 3).replace(/0+$/, "").replace(/\.$/, ".0") : f.value} m`;
  if (info.kind === "units") return ({ mm: "millimetres", cm: "centimetres", m: "metres", in: "inches", ft: "feet" } as Record<string, string>)[String(f.value)] ?? String(f.value);
  return String(f.value);
}
