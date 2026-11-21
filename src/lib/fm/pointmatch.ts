// Linking live points to assets: a point named "plant/AHU-01/supply-temp"
// belongs to the asset tagged AHU-01. Names are compared without case or
// separators, and with leading zeros dropped (AHU-1 is AHU-01).

import { valueOf } from "./asset";
import type { Asset, PointKind } from "./types";

/** Names without case, separators or leading zeros: "AHU-01" -> "ahu1", "FCU_L01_03" -> "fcul13". */
export function compact(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((piece) => piece.replace(/\d+/g, (digits) => String(Number(digits))))
    .join("");
}

export interface AssetMatcher {
  match: (key: string) => Asset | null;
}

/** Builds a matcher over the assets' names, tags and codes (only names at least 3 characters long count). */
export function assetMatcher(assets: Asset[]): AssetMatcher {
  const index = new Map<string, Asset | null>();
  const add = (text: string, a: Asset) => {
    const k = compact(text);
    if (k.length < 3 || !/\d/.test(k)) return;
    const known = index.get(k);
    index.set(k, known === undefined || known === a ? a : null); // ambiguous names match nothing
  };
  for (const a of assets) {
    add(valueOf(a, "name"), a);
    add(valueOf(a, "tag"), a);
    add(valueOf(a, "code"), a);
  }
  return {
    match(key: string) {
      const segments = key.split(/[\/.:|\s]+/).filter(Boolean);
      let best: { asset: Asset; length: number } | null = null;
      // Single segments and runs of up to three (plant/ahu/01).
      for (let i = 0; i < segments.length; i++) {
        let joined = "";
        for (let j = i; j < Math.min(segments.length, i + 3); j++) {
          joined += segments[j];
          const k = compact(joined);
          const hit = index.get(k);
          if (hit && (!best || k.length > best.length)) best = { asset: hit, length: k.length };
          // A segment may carry more than the name: "ahu-01-supply-temp".
          const parts = segments[j].split(/[-_]+/);
          for (let a = 0; a < parts.length; a++)
            for (let b = a + 1; b <= Math.min(parts.length, a + 4); b++) {
              const kk = compact(parts.slice(a, b).join(""));
              const h = index.get(kk);
              if (h && (!best || kk.length > best.length)) best = { asset: h, length: kk.length };
            }
        }
      }
      return best?.asset ?? null;
    },
  };
}

const KIND_WORDS: [RegExp, PointKind, string][] = [
  [/co2|carbon.?dioxide/i, "co2", "ppm"],
  [/humid|rh\b/i, "humidity", "%"],
  [/temp|\btmp\b|°c|degc/i, "temperature", "°C"],
  [/setpoint|\bsp\b|set.?point/i, "setpoint", ""],
  [/occup|presence|motion/i, "occupancy", ""],
  [/energy|kwh/i, "energy", "kWh"],
  [/power|\bkw\b/i, "power", "kW"],
  [/current|amps?\b/i, "current", "A"],
  [/volt/i, "voltage", "V"],
  [/flow/i, "flow", "L/s"],
  [/press|\bdp\b|\bpa\b/i, "pressure", "Pa"],
  [/level|tank/i, "level", "%"],
  [/speed|freq|rpm/i, "speed", ""],
  [/alarm|fault|trip/i, "alarm", ""],
  [/status|state|run|on.?off|cmd|command/i, "status", ""],
];

/** A point's kind and unit guessed from its name. */
export function guessKind(key: string): { kind: PointKind; unit: string } {
  for (const [re, kind, unit] of KIND_WORDS) if (re.test(key)) return { kind, unit };
  return { kind: "other", unit: "" };
}

/** A readable name from a topic: "plant/ahu-01/supply-temp" -> "AHU-01 supply temp". */
export function nameFromKey(key: string, asset: Asset | null): string {
  const segments = key.split(/[\/.:|]+/).filter(Boolean);
  const tail = segments.slice(-1)[0]?.replace(/[-_]+/g, " ") ?? key;
  return asset ? `${valueOf(asset, "name")} ${tail}` : segments.slice(-2).join(" ").replace(/[-_]+/g, " ");
}
