// The Assets page's search box: free words plus field filters such as
// `kind:pump floor:L03 room:"EV.214" status:incomplete missing:serial`.
// A quoted value must match the whole field; an unquoted one may be part of it
// (except a status, which is always matched whole: "complete" is part of "incomplete").

import { fieldLabel, KEY_FIELDS, missingKeyFields, statusOf, valueOf } from "./asset";
import { norm } from "./search";
import type { Asset } from "./types";

export const FILTER_FIELDS: Record<string, { label: string; values: (a: Asset) => string[]; whole?: boolean }> = {
  kind: { label: "Kind", values: (a) => [a.kind, a.kindCode] },
  floor: { label: "Floor", values: (a) => [valueOf(a, "floor")] },
  room: { label: "Room", values: (a) => [valueOf(a, "space"), a.roomName] },
  system: { label: "System", values: (a) => a.systems },
  maker: { label: "Manufacturer", values: (a) => [valueOf(a, "manufacturer")] },
  model: { label: "Model", values: (a) => [valueOf(a, "model")] },
  type: { label: "Type", values: (a) => [a.typeName] },
  category: { label: "Category", values: (a) => [a.category] },
  discipline: { label: "Discipline", values: (a) => [a.discipline] },
  status: { label: "Status", values: (a) => [statusOf(a)], whole: true },
  missing: { label: "Missing", values: (a) => missingKeyFields(a).flatMap((f) => [f, fieldLabel(f)]) },
  fed: { label: "Fed from", values: (a) => [a.fedFrom] },
};

const ALIASES: Record<string, string> = { space: "room", manufacturer: "maker", make: "maker", level: "floor", storey: "floor", by: "fed", board: "fed" };

export interface AssetFilter {
  field: string;
  value: string;
  exact: boolean;
}

export interface AssetQuery {
  words: string[];
  filters: AssetFilter[];
}

export function parseAssetQuery(query: string): AssetQuery {
  const words: string[] = [];
  const filters: AssetFilter[] = [];
  const re = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    const field = (m[1] ?? m[3])?.toLowerCase();
    if (field) {
      const name = ALIASES[field] ?? field;
      if (FILTER_FIELDS[name]) {
        filters.push({ field: name, value: norm(m[2] ?? m[4] ?? ""), exact: m[2] !== undefined });
        continue;
      }
    }
    const word = norm(m[5] ?? m[6] ?? `${m[1] ?? m[3]}:${m[2] ?? m[4]}`);
    if (word) words.push(word);
  }
  return { words, filters };
}

/** The text an asset is found by in its words, normalised. */
export function assetHay(a: Asset): string {
  return norm(
    [valueOf(a, "code"), valueOf(a, "name"), valueOf(a, "tag"), a.kind, a.kindCode, a.typeName, a.category, a.discipline, valueOf(a, "manufacturer"), valueOf(a, "model"), valueOf(a, "serialNumber"), valueOf(a, "assetIdentifier"), valueOf(a, "barCode"), valueOf(a, "floor"), valueOf(a, "space"), a.roomName, a.systems.join(" "), a.locationCode, a.fedFrom].filter(Boolean).join(" "),
  );
}

/** A filter value for a missing field accepts its id or label ("missing:serial" finds serialNumber). */
function missingMatches(a: Asset, value: string): boolean {
  if (!value) return missingKeyFields(a).length > 0;
  return KEY_FIELDS.some((f) => !valueOf(a, f) && (norm(f).includes(value) || norm(fieldLabel(f)).includes(value)));
}

export function matchesAsset(a: Asset, query: AssetQuery, hay: string): boolean {
  for (const word of query.words) if (!hay.includes(word)) return false;
  for (const filter of query.filters) {
    if (filter.field === "missing") {
      if (!missingMatches(a, filter.value)) return false;
      continue;
    }
    const def = FILTER_FIELDS[filter.field];
    const values = def.values(a).filter(Boolean).map(norm);
    if (filter.exact || def.whole ? !values.includes(filter.value) : !values.some((v) => v.includes(filter.value))) return false;
  }
  return true;
}

/** A filter written back into the search box, quoted when it has spaces or must match exactly. */
export function filterText(field: string, value: string, exact = true): string {
  return exact || /\s/.test(value) ? `${field}:"${value}"` : `${field}:${value}`;
}
