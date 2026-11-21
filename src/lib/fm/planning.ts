// Planning maintenance for a register: which asset kinds the task library
// covers, and the plans to add for the kinds chosen.

import { plansForAssets } from "./schedule";
import type { Asset, Plan, TaskTemplate } from "./types";

/** Asset kinds of the register with how many assets and library tasks each has, most assets first. */
export function kindRows(assets: Asset[], tasks: TaskTemplate[]) {
  const kinds = new Map<string, { code: string; name: string; assets: number }>();
  for (const a of assets) {
    const k = kinds.get(a.kindCode);
    if (k) k.assets++;
    else kinds.set(a.kindCode, { code: a.kindCode, name: a.kind, assets: 1 });
  }
  return [...kinds.values()].map((k) => ({ ...k, tasks: tasks.filter((t) => t.kindCodes.includes(k.code)) })).sort((a, b) => b.assets - a.assets);
}

/** Plans for the kinds chosen, leaving plans that already exist (and their dates) alone. */
export function generatePlans(assets: Asset[], tasks: TaskTemplate[], existing: Plan[], options: { start: string; kinds: Set<string>; spread: boolean; fromModel: boolean }): Plan[] {
  const have = new Set(existing.map((p) => p.id));
  return plansForAssets(assets, tasks, options).filter((p) => !have.has(p.id));
}
