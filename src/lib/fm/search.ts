// Search across the app: pages and actions, and the facility's assets, rooms,
// systems, work orders and live points. Every word typed must appear; exact
// codes and tags come first, then names that start with what was typed, then
// the rest. A word with a colon picks what to look for ("room: 214").

import { valueOf } from "./asset";
import type { Asset, Point, Space, SystemInfo, WorkOrder } from "./types";

export type SearchKind = "action" | "page" | "asset" | "room" | "system" | "workorder" | "point";

export const KIND_ORDER: SearchKind[] = ["action", "page", "asset", "room", "system", "workorder", "point"];

export const KIND_LABELS: Record<SearchKind, string> = {
  action: "Actions",
  page: "Pages",
  asset: "Assets",
  room: "Rooms",
  system: "Systems",
  workorder: "Work orders",
  point: "Live points",
};

/** Words that narrow a search to some kinds: "asset: ahu", "wo: 12". */
export const SCOPES: Record<string, SearchKind[]> = {
  asset: ["asset"],
  assets: ["asset"],
  room: ["room"],
  rooms: ["room"],
  space: ["room"],
  system: ["system"],
  systems: ["system"],
  wo: ["workorder"],
  workorder: ["workorder"],
  work: ["workorder"],
  point: ["point"],
  points: ["point"],
  live: ["point"],
  page: ["page", "action"],
  pages: ["page", "action"],
  go: ["page", "action"],
};

export interface SearchItem {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  /** Everything the item can be found by, normalised. */
  hay: string;
  /** Codes and tags that count as an exact hit, normalised. */
  keys: string[];
}

/** Lower case, typographic dashes as hyphens, runs of space as one. */
export function norm(text: string): string {
  return text.toLowerCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim();
}

const join = (...parts: (string | undefined)[]) => norm(parts.filter(Boolean).join(" "));

export function assetItems(assets: Asset[]): SearchItem[] {
  return assets.map((a) => {
    const name = valueOf(a, "name");
    const code = valueOf(a, "code");
    const tag = valueOf(a, "tag");
    const floor = valueOf(a, "floor");
    const space = valueOf(a, "space");
    const where = [floor, space].filter(Boolean).join(" · ");
    return {
      kind: "asset" as const,
      id: a.id,
      title: name,
      subtitle: [code !== name ? code : "", a.kind, where].filter(Boolean).join(" · "),
      href: `/assets?asset=${encodeURIComponent(a.id)}`,
      hay: join(code, name, tag, a.kind, a.kindCode, a.typeName, a.category, valueOf(a, "manufacturer"), valueOf(a, "model"), valueOf(a, "serialNumber"), valueOf(a, "assetIdentifier"), valueOf(a, "barCode"), floor, space, a.roomName, a.systems.join(" "), a.locationCode, a.discipline),
      keys: [code, tag, valueOf(a, "assetIdentifier"), valueOf(a, "barCode"), valueOf(a, "serialNumber")].filter(Boolean).map(norm),
    };
  });
}

export function roomItems(spaces: Space[]): SearchItem[] {
  return spaces.map((s) => ({
    kind: "room" as const,
    id: s.id,
    title: [s.number, s.name].filter((x, i, all) => x && all.indexOf(x) === i).join(" "),
    subtitle: [s.floor, s.department].filter(Boolean).join(" · "),
    href: `/assets?q=${encodeURIComponent(`room:"${s.id}"`)}`,
    hay: join(s.id, s.number, s.name, s.floor, s.department, s.category),
    keys: [s.id, s.number].filter(Boolean).map(norm),
  }));
}

export function systemItems(systems: SystemInfo[]): SearchItem[] {
  return systems.map((s) => ({
    kind: "system" as const,
    id: s.name,
    title: s.name,
    subtitle: [s.classification, `${s.members} item${s.members === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
    href: `/assets?q=${encodeURIComponent(`system:"${s.name}"`)}`,
    hay: join(s.name, s.classification, s.type),
    keys: [norm(s.name)],
  }));
}

export function workOrderItems(workOrders: WorkOrder[], assetName: (id: string) => string): SearchItem[] {
  return workOrders.map((w) => ({
    kind: "workorder" as const,
    id: w.id,
    title: `${w.number} ${w.title}`,
    subtitle: [w.status.replace("-", " "), `due ${w.due}`, w.assetIds.slice(0, 2).map(assetName).join(", ")].filter(Boolean).join(" · "),
    href: `/maintenance?tab=orders&wo=${encodeURIComponent(w.id)}`,
    hay: join(w.number, w.title, w.status, w.kind, w.priority, w.assignee, w.description, w.assetIds.map(assetName).join(" ")),
    keys: [norm(w.number)],
  }));
}

export function pointItems(points: Point[], assetName: (id: string) => string): SearchItem[] {
  return points.map((p) => ({
    kind: "point" as const,
    id: p.id,
    title: p.name || p.key,
    subtitle: [p.lastValue !== undefined ? `${p.lastValue}${p.unit ? ` ${p.unit}` : ""}` : "", p.assetId ? assetName(p.assetId) : "not linked"].filter(Boolean).join(" · "),
    href: `/live?point=${encodeURIComponent(p.id)}`,
    hay: join(p.name, p.key, p.kind, p.unit, p.assetId ? assetName(p.assetId) : ""),
    keys: [norm(p.key)],
  }));
}

export interface ParsedQuery {
  kinds: SearchKind[] | null;
  tokens: string[];
}

/** Splits a query into words (quoted phrases stay together) and a scope ("room: 214"). */
export function parseQuery(query: string): ParsedQuery {
  let kinds: SearchKind[] | null = null;
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    let word = m[1] ?? m[2];
    if (m[2]) {
      const colon = word.indexOf(":");
      if (colon > 0) {
        const scope = SCOPES[word.slice(0, colon).toLowerCase()];
        if (scope) {
          kinds = scope;
          word = word.slice(colon + 1);
        }
      }
    }
    const t = norm(word.replace(/^"|"$/g, ""));
    if (t) tokens.push(t);
  }
  return { kinds, tokens };
}

const wordStart = (hay: string, token: string) => {
  let at = hay.indexOf(token);
  while (at >= 0) {
    if (at === 0 || /[\s\-_./:|·,(]/.test(hay[at - 1])) return true;
    at = hay.indexOf(token, at + 1);
  }
  return false;
};

/** 0 when a word is missing; higher is better. */
export function scoreItem(item: SearchItem, tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const title = norm(item.title);
  const phrase = tokens.join(" ");
  let score = 0;
  for (const token of tokens) {
    if (!item.hay.includes(token) && !title.includes(token)) return 0;
    if (item.keys.includes(token)) score += 100;
    else if (item.keys.some((k) => k.startsWith(token))) score += 40;
    if (title.startsWith(token)) score += 30;
    else if (wordStart(title, token)) score += 20;
    else if (title.includes(token)) score += 8;
    else if (wordStart(item.hay, token)) score += 6;
    else score += 2;
  }
  if (item.keys.includes(phrase)) score += 200;
  if (title === phrase) score += 150;
  return score;
}

export interface SearchGroup {
  kind: SearchKind;
  items: SearchItem[];
  total: number;
}

/** Best matches per kind, in a fixed kind order. */
export function searchItems(items: SearchItem[], query: string, perKind = 6): SearchGroup[] {
  const { kinds, tokens } = parseQuery(query);
  const scored = new Map<SearchKind, { item: SearchItem; score: number }[]>();
  for (const item of items) {
    if (kinds && !kinds.includes(item.kind)) continue;
    const score = scoreItem(item, tokens);
    if (score <= 0) continue;
    let list = scored.get(item.kind);
    if (!list) scored.set(item.kind, (list = []));
    list.push({ item, score });
  }
  const groups: SearchGroup[] = [];
  for (const kind of KIND_ORDER) {
    const list = scored.get(kind);
    if (!list?.length) continue;
    list.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, undefined, { numeric: true }));
    groups.push({ kind, items: list.slice(0, kinds ? perKind * 4 : perKind).map((s) => s.item), total: list.length });
  }
  return groups;
}
