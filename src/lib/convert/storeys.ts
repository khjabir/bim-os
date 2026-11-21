// Building storeys from the Revit levels elements are placed on.
//
// Navisworks and the viewer carry each element's level name but not the
// level's elevation, so the elevation is estimated from where the level's
// elements sit: the most common base height of elements that stand on their
// level (walls, columns, doors, furniture), else the most common top of its
// floors, else a low percentile of everything on it (MEP runs hang below
// the level above, so their median says little).
//
// Federated models name the same floor differently per discipline
// ("ARC - 01 - FFL - MEZZANINE LEVEL", "STR - 01 - TOS - MEZZANINE LEVEL",
// "L01 - Mezzanine Level"), so names are first grouped on their
// distinctive words, then levels within half a metre merge, and levels with
// very few elements are dropped (their elements are placed by height).

export interface StoreyDef {
  key: string;
  name: string;
  /** Metres, in the model's own height datum. */
  elevation: number;
  /** Level names (from all files) that map to this storey. */
  levels: string[];
  /** Elements estimated to be on it (for display). */
  count: number;
}

export interface LevelStats {
  hosted: number[];
  floorTops: number[];
  bottoms: number[];
  count: number;
}

/** Elements that stand on their level with no offset, typically. */
const HOSTED = /^(Walls|Columns|Structural Columns|Doors|Furniture|Furniture Systems|Casework|Railings|Stairs)$/;
const FLOORS = /^(Floors|Structural Foundations)$/;

export function emptyLevelStats(): LevelStats {
  return { hosted: [], floorTops: [], bottoms: [], count: 0 };
}

/** Adds one element to the per-level statistics (keeps at most ~4000 samples per list). */
export function sampleLevel(stats: LevelStats, category: string, bottom: number, top: number) {
  stats.count++;
  const keep = (list: number[], value: number) => {
    if (list.length < 4000) list.push(value);
    else {
      const k = Math.floor(Math.random() * stats.count);
      if (k < list.length) list[k] = value;
    }
  };
  if (HOSTED.test(category)) keep(stats.hosted, bottom);
  else if (FLOORS.test(category)) keep(stats.floorTops, top);
  keep(stats.bottoms, bottom);
}

export function mergeLevelStats(into: LevelStats, from: LevelStats) {
  into.count += from.count;
  for (const key of ["hosted", "floorTops", "bottoms"] as const) {
    for (const v of from[key]) if (into[key].length < 8000) into[key].push(v);
  }
}

function quantile(values: number[], q: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/**
 * The most common value on a 2 cm grid when it is common enough (elements
 * placed on a level mostly sit exactly on it), else the median.
 */
function typical(values: number[]): number {
  if (values.length === 0) return NaN;
  const bins = new Map<number, number>();
  for (const v of values) {
    const b = Math.round(v / 0.02);
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [b, c] of bins) {
    if (c > bestCount || (c === bestCount && b < best)) {
      best = b;
      bestCount = c;
    }
  }
  if (bestCount >= Math.max(2, values.length * 0.15)) return quantile(values.filter((v) => Math.round(v / 0.02) === best), 0.5);
  return quantile(values, 0.5);
}

export function levelElevation(stats: LevelStats): number {
  if (stats.hosted.length >= 3) return typical(stats.hosted);
  if (stats.floorTops.length >= 1) return typical(stats.floorTops);
  if (stats.hosted.length >= 1) return quantile(stats.hosted, 0.5);
  return quantile(stats.bottoms, 0.05);
}

/** Level names that are placeholders, not levels. */
const NOT_A_LEVEL = /^(<.*>|\(.*\)|none|null|-+|n\/a|unassigned|no level)$/i;

/** Structural / setting-out level names; an architectural name is preferred for a merged storey. */
const STRUCTURAL_NAME = /\b(STR|STRUCT|STRUCTURAL|TOS|SSL|T\.O\.S|TOC|SOFFIT|BOTTOM)\b|^S[-_ ]/i;

const STOP_WORDS = new Set(["ARC", "ARCH", "ARCHITECTURAL", "STR", "STRUCT", "STRUCTURAL", "TOS", "FFL", "SSL", "AFF", "SFL", "FL", "LEVEL", "LEVELS", "LVL", "LV", "THE", "OF", "F", "L", "S", "T", "O"]);

/** Distinctive words of a level name ("ARC - 01 - FFL - MEZZANINE LEVEL" -> "MEZZANINE"); "" when nothing is left. */
export function levelKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !STOP_WORDS.has(w) && !/^[LB]?\d+$/.test(w));
  const key = words.join("");
  return key.length >= 3 ? key : "";
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export interface DetectOptions {
  /** Levels closer than this (metres) become one storey. */
  tolerance?: number;
  /** Levels with fewer elements than this share of all elements are dropped (their elements go by height). */
  minShare?: number;
}

/** Storeys from per-level statistics. */
export function detectStoreys(levels: Map<string, LevelStats>, unassignedBottoms: number[], options: DetectOptions = {}): StoreyDef[] {
  const tolerance = options.tolerance ?? 0.5;
  const minShare = options.minShare ?? 0.003;

  // 1. Group names on their distinctive words.
  const groups = new Map<string, { names: { name: string; count: number }[]; stats: LevelStats }>();
  let total = 0;
  for (const [name, stats] of levels) {
    if (!name || stats.count === 0 || NOT_A_LEVEL.test(name.trim())) continue;
    total += stats.count;
    const key = levelKey(name) || `=${name}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { names: [], stats: emptyLevelStats() }));
    group.names.push({ name, count: stats.count });
    mergeLevelStats(group.stats, stats);
  }

  // 2. Estimate each group's height; drop the tiny ones.
  const minCount = Math.max(10, total * minShare);
  const estimated = [...groups.values()]
    .filter((g) => g.stats.count >= minCount)
    .map((g) => ({ names: g.names, count: g.stats.count, elevation: levelElevation(g.stats) }))
    .filter((g) => Number.isFinite(g.elevation))
    .sort((a, b) => a.elevation - b.elevation);

  // 3. Merge groups at (nearly) the same height.
  const merged: { names: { name: string; count: number }[]; members: { elevation: number; count: number }[] }[] = [];
  for (const g of estimated) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(g.elevation - last.members[0].elevation) <= tolerance) {
      last.names.push(...g.names);
      last.members.push({ elevation: g.elevation, count: g.count });
    } else merged.push({ names: [...g.names], members: [{ elevation: g.elevation, count: g.count }] });
  }

  const used = new Set<string>();
  const storeys: StoreyDef[] = merged.map((group, index) => {
    const biggest = group.names.reduce((a, b) => (b.count > a.count ? b : a));
    // Name: the biggest level, unless it is a structural setting-out level and an
    // architectural one of reasonable size sits at the same height.
    const architectural = group.names.filter((l) => !STRUCTURAL_NAME.test(l.name)).reduce<typeof biggest | null>((a, b) => (!a || b.count > a.count ? b : a), null);
    const main = STRUCTURAL_NAME.test(biggest.name) && architectural && architectural.count >= biggest.count * 0.1 ? architectural : biggest;
    let name = main.name.trim();
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${main.name.trim()} (${n})`;
    used.add(name.toLowerCase());
    // The biggest member's height (the others are usually the same floor's structural or MEP levels).
    const top = group.members.reduce((a, b) => (b.count > a.count ? b : a));
    const count = group.members.reduce((s, m) => s + m.count, 0);
    return { key: `s${index}`, name, elevation: round3(top.elevation), levels: group.names.map((l) => l.name), count };
  });

  if (storeys.length === 0) {
    const base = unassignedBottoms.length ? quantile(unassignedBottoms, 0.02) : 0;
    storeys.push({ key: "s0", name: "Level 0", elevation: round3(Number.isFinite(base) ? base : 0), levels: [], count: unassignedBottoms.length });
  }
  return storeys;
}

/** The storey an element belongs to: by its level name when known, else by the height of its base. */
export function storeyFor(storeys: StoreyDef[], byLevel: Map<string, string>, level: string, bottom: number, tolerance = 0.3): string {
  if (level) {
    const key = byLevel.get(level);
    if (key) return key;
  }
  let best = storeys[0]?.key ?? "s0";
  for (const storey of storeys) if (bottom >= storey.elevation - tolerance) best = storey.key;
  return best;
}

export function levelIndex(storeys: StoreyDef[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const storey of storeys) for (const level of storey.levels) if (!map.has(level)) map.set(level, storey.key);
  return map;
}

/**
 * Storeys of several models (the storeys each IFC file defines) as one list. Storeys of different models
 * become one when they are at the same height (within `tolerance` metres), or go by the same name or the
 * same distinctive words ("L04 - Upper Concourse Level", "04-Upper Concourse Level") within `nameReach`
 * metres of each other; every name they go by becomes one of its levels.
 */
export function mergeStoreys(lists: StoreyDef[][], tolerance = 0.3, nameReach = 3): StoreyDef[] {
  const all = lists.flatMap((list, source) => list.map((storey) => ({ storey, source, key: levelKey(storey.name), name: storey.name.trim().toLowerCase() })));
  const parent = all.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i],
        b = all[j];
      if (a.source === b.source) continue;
      const gap = Math.abs(a.storey.elevation - b.storey.elevation);
      const sameName = a.name === b.name || (a.key !== "" && a.key === b.key);
      if (gap <= tolerance || (sameName && gap <= nameReach)) parent[find(i)] = find(j);
    }
  const groups = new Map<number, typeof all>();
  for (let i = 0; i < all.length; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(all[i]);
    else groups.set(root, [all[i]]);
  }
  const merged = [...groups.values()].map((members) => {
    // Named and placed after the storey with the most elements, an architectural name before a structural one.
    const ranked = [...members].sort((a, b) => Number(STRUCTURAL_NAME.test(a.storey.name)) - Number(STRUCTURAL_NAME.test(b.storey.name)) || b.storey.count - a.storey.count);
    return { main: ranked[0].storey, members };
  });
  merged.sort((a, b) => a.main.elevation - b.main.elevation);
  const used = new Set<string>();
  return merged.map(({ main, members }, index) => {
    const base = main.name.trim() || `Level ${index}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    const levels = [...new Set(members.flatMap((m) => [m.storey.name, ...m.storey.levels]))];
    return { key: `s${index}`, name, elevation: round3(main.elevation), levels, count: members.reduce((n, m) => n + m.storey.count, 0) };
  });
}
