// The electrical distribution of a model, as a single-line diagram reads it:
// sources and boards (transformers, generators, main switchboards, sub-main
// and final distribution boards) in a tree by what each is fed from, every
// board's ratings and loads, and the circuits that leave it for the items it
// feeds.
//
// The tree comes from the model's own data: each item's or board's "Panel" /
// "Supply From" (or a "fed from" note in its text). A board that items name
// but that is not modelled appears as a placeholder, so the tree still holds
// together. Loads a board does not carry are summed from what it feeds and
// marked as such.

import type { RegisterAsset, RegisterRelation } from "./register";

export interface RegisterBoard {
  /** The board's name: its asset name, or the name items give it when it is not in the model. */
  name: string;
  /** Asset name ("" for a board only named by what it feeds). */
  asset: string;
  guid: string;
  kind: string;
  code: string;
  /** 0 for the top of a tree (a source, or a board whose supply is not known). */
  level: number;
  fedFrom: string;
  /** Names from the top of the tree down to this board. */
  path: string[];
  voltage: number | null;
  phases: number | null;
  distributionSystem: string;
  mainsRating: number | null;
  ways: number | null;
  /** kVA: the model's value, else the sum of what the board feeds. */
  connectedLoad: number | null;
  connectedLoadSource: "model" | "sum of loads" | "";
  demandLoad: number | null;
  faultLevel: number | null;
  ipRating: string;
  /** Boards fed directly. */
  boards: string[];
  /** Circuits to items (not boards). */
  circuits: number;
  /** Items (not boards) fed directly. */
  items: string[];
  /** Items fed directly or through boards below. */
  downstream: number;
  /** Other boards with the same panel name, folded into this one. */
  copies: string[];
  floor: string;
  space: string;
  inModel: boolean;
}

export interface RegisterCircuit {
  board: string;
  circuit: string;
  loadName: string;
  poles: number | null;
  breakerRating: number | null;
  cable: string;
  voltage: number | null;
  items: string[];
  /** kVA, summed from the items. */
  connectedLoad: number | null;
  floors: string[];
  spaces: string[];
}

export interface RegisterElectrical {
  boards: RegisterBoard[];
  circuits: RegisterCircuit[];
  /** Tops of the trees, biggest first. */
  roots: string[];
}

interface Node {
  name: string;
  asset: RegisterAsset | null;
  up: string;
  boards: string[];
  items: RegisterAsset[];
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

function mode<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  for (const v of values) if (v !== null && v !== undefined && v !== ("" as unknown as T)) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [v, c] of counts)
    if (c > n) {
      best = v;
      n = c;
    }
  return best;
}

export const isBoard = (a: RegisterAsset) => a.traits.includes("board") && !a.traits.includes("fireAlarm");

/**
 * Boards, their tree and circuits. `relations` are the register's serving
 * links (only "Electrical supply" ones are used); `unresolved` maps a board
 * name nothing in the model answers to, to the assets it feeds; `copies` maps a board that shares its panel name
 * with another to the one it is folded into.
 */
export function buildElectrical(assets: RegisterAsset[], relations: RegisterRelation[], unresolved: Map<string, RegisterAsset[]>, copies: Map<string, string> = new Map()): RegisterElectrical {
  const byName = new Map(assets.map((a) => [a.name, a]));
  const supply = relations.filter((r) => r.kind === "Electrical supply");
  // Nodes: boards, anything that feeds something, and boards only named by what they feed.
  const nodes = new Map<string, Node>();
  const node = (name: string, asset: RegisterAsset | null) => {
    let n = nodes.get(name);
    if (!n) nodes.set(name, (n = { name, asset, up: "", boards: [], items: [] }));
    return n;
  };
  for (const a of assets) if (isBoard(a) && !copies.has(a.name)) node(a.name, a);
  const copiesOf = new Map<string, string[]>();
  for (const [copy, primary] of copies) copiesOf.set(primary, [...(copiesOf.get(primary) ?? []), copy]);
  for (const r of supply) node(r.from, byName.get(r.from) ?? null);
  for (const [text] of unresolved) if (!nodes.has(text)) node(text, null);

  for (const r of supply) {
    const from = nodes.get(r.from)!;
    const to = byName.get(r.to);
    if (!to) continue;
    const child = nodes.get(to.name);
    if (child) {
      if (!child.up) {
        child.up = from.name;
        from.boards.push(child.name);
      }
    } else from.items.push(to);
  }
  for (const [text, fed] of unresolved) {
    const from = nodes.get(text)!;
    for (const a of fed) {
      const child = nodes.get(a.name);
      if (child) {
        if (!child.up) {
          child.up = text;
          from.boards.push(child.name);
        }
      } else if (!from.items.includes(a)) from.items.push(a);
    }
  }

  // Effective loads and downstream counts, children first; cycles are cut where met.
  const load = new Map<string, { value: number | null; source: RegisterBoard["connectedLoadSource"]; downstream: number }>();
  const visiting = new Set<string>();
  const measure = (name: string): { value: number | null; source: RegisterBoard["connectedLoadSource"]; downstream: number } => {
    const done = load.get(name);
    if (done) return done;
    if (visiting.has(name)) return { value: null, source: "", downstream: 0 };
    visiting.add(name);
    const n = nodes.get(name)!;
    let sum = 0;
    let any = false;
    let downstream = n.items.length;
    for (const b of n.boards) {
      const m = measure(b);
      downstream += m.downstream;
      if (m.value !== null) {
        sum += m.value;
        any = true;
      }
    }
    for (const a of n.items) {
      const v = num(a.values.connectedLoad);
      if (v !== null) {
        sum += v;
        any = true;
      }
    }
    const own = n.asset ? num(n.asset.values.connectedLoad) : null;
    const result = own !== null ? { value: own, source: "model" as const, downstream } : any ? { value: Math.round(sum * 1000) / 1000, source: "sum of loads" as const, downstream } : { value: null, source: "" as const, downstream };
    visiting.delete(name);
    load.set(name, result);
    return result;
  };

  // Tops: nodes without a known supply; a cycle with no top gets one where it is first met.
  const roots = [...nodes.values()].filter((n) => !n.up || !nodes.has(n.up)).map((n) => n.name);
  const seen = new Set<string>();
  const order: { name: string; level: number; path: string[] }[] = [];
  const walk = (name: string, level: number, path: string[]) => {
    if (seen.has(name)) return;
    seen.add(name);
    const p = [...path, name];
    order.push({ name, level, path: p });
    const n = nodes.get(name)!;
    for (const b of [...n.boards].sort(natural)) walk(b, level + 1, p);
  };
  for (const r of roots.sort((a, b) => measure(b).downstream - measure(a).downstream || natural(a, b))) walk(r, 0, []);
  for (const n of [...nodes.values()].sort((a, b) => natural(a.name, b.name)))
    if (!seen.has(n.name)) {
      roots.push(n.name);
      walk(n.name, 0, []);
    }

  const boards: RegisterBoard[] = [];
  const circuits: RegisterCircuit[] = [];
  for (const { name, level, path } of order) {
    const n = nodes.get(name)!;
    const a = n.asset;
    const v = a?.values ?? {};
    const m = measure(name);
    // Circuits: the items fed directly, by circuit number.
    const byCircuit = new Map<string, RegisterAsset[]>();
    for (const item of n.items) {
      const c = item.values.circuit || "";
      byCircuit.set(c, [...(byCircuit.get(c) ?? []), item]);
    }
    // Numbered circuits in order, items without a circuit number last.
    for (const [circuit, items] of [...byCircuit].sort((x, y) => (x[0] ? 0 : 1) - (y[0] ? 0 : 1) || natural(x[0], y[0]))) {
      let total = 0;
      let any = false;
      for (const item of items) {
        const x = num(item.values.connectedLoad);
        if (x !== null) {
          total += x;
          any = true;
        }
      }
      circuits.push({
        board: name,
        circuit,
        loadName: mode(items.map((i) => i.values.loadName)) ?? "",
        poles: mode(items.map((i) => num(i.values.poles))),
        breakerRating: mode(items.map((i) => num(i.values.breakerRating))),
        cable: mode(items.map((i) => i.values.cableSize)) ?? "",
        voltage: mode(items.map((i) => num(i.values.voltage))),
        items: items.map((i) => i.name).sort(natural),
        connectedLoad: any ? Math.round(total * 1000) / 1000 : null,
        floors: [...new Set(items.map((i) => i.floor).filter(Boolean))].sort(natural),
        spaces: [...new Set(items.map((i) => i.space).filter(Boolean))].sort(natural),
      });
    }
    boards.push({
      name,
      asset: a?.name ?? "",
      guid: a?.guid ?? "",
      kind: a?.kind ?? "Board (not in the model)",
      code: a?.kindCode ?? "",
      level,
      fedFrom: n.up && nodes.has(n.up) ? n.up : a?.values.panel ?? "",
      path,
      voltage: num(v.voltage),
      phases: num(v.phases),
      distributionSystem: v.distributionSystem ?? "",
      mainsRating: num(v.mainsRating),
      ways: num(v.ways),
      connectedLoad: m.value,
      connectedLoadSource: m.source,
      demandLoad: num(v.demandLoad),
      faultLevel: num(v.faultLevel),
      ipRating: v.ipRating ?? "",
      boards: [...n.boards].sort(natural),
      circuits: byCircuit.size,
      items: n.items.map((i) => i.name).sort(natural),
      downstream: m.downstream,
      copies: (copiesOf.get(name) ?? []).sort(natural),
      floor: a?.floor ?? "",
      space: a?.space ?? "",
      inModel: Boolean(a),
    });
  }
  // Boards with nothing below and nothing above them are not worth a tree of their own, but they stay listed.
  const tops = roots.filter((r) => {
    const n = nodes.get(r)!;
    return n.boards.length || n.items.length;
  });
  return { boards, circuits, roots: tops };
}
