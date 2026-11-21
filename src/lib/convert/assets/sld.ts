// Single-line diagrams of a model's electrical distribution, as one
// self-contained HTML page: a drawing per supply tree (transformer or main
// board down to the final distribution boards), each board with its kind,
// ratings and load, and how many circuits and items it feeds. Drawn left to
// right, so wide distributions stay readable on screen and on paper.

import type { RegisterBoard } from "./electrical";
import type { AssetRegister } from "./register";

const BOX_W = 204;
const BOX_H = 66;
const COL_W = 252;
const ROW_H = 82;
const PAD = 24;

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const fmt = (n: number | null, unit: string, digits = 1) => (n === null ? "" : `${Math.round(n * 10 ** digits) / 10 ** digits} ${unit}`);

function accent(b: RegisterBoard): string {
  if (!b.inModel) return "var(--muted)";
  switch (b.code) {
    case "TX":
    case "GEN":
    case "UPS":
    case "PV":
    case "MVS":
    case "CBS":
      return "var(--source)";
    case "MSB":
      return "var(--main)";
    case "SMDB":
    case "BB":
      return "var(--submain)";
    case "DB":
      return "var(--final)";
    default:
      return "var(--other)";
  }
}

interface Placed {
  board: RegisterBoard;
  x: number;
  y: number;
}

/** One tree as SVG: leaves take a row each, a board sits level with the middle of what it feeds. */
function treeSvg(root: string, byName: Map<string, RegisterBoard>): { svg: string; boards: number } {
  const placed = new Map<string, Placed>();
  let row = 0;
  let maxLevel = 0;
  const seen = new Set<string>();
  const place = (name: string, level: number): number => {
    const b = byName.get(name)!;
    seen.add(name);
    maxLevel = Math.max(maxLevel, level);
    const kids = b.boards.filter((k) => byName.has(k) && !seen.has(k));
    let y: number;
    if (kids.length === 0) {
      y = PAD + row * ROW_H;
      row++;
    } else {
      const ys = kids.map((k) => place(k, level + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    placed.set(name, { board: b, x: PAD + level * COL_W, y });
    return y;
  };
  place(root, 0);
  const width = PAD * 2 + maxLevel * COL_W + BOX_W;
  const height = PAD * 2 + Math.max(row, 1) * ROW_H - (ROW_H - BOX_H);
  const parts: string[] = [];
  // Feeders: parent -> bus -> child, with a breaker on each outgoing way.
  for (const p of placed.values()) {
    const kids = p.board.boards.map((k) => placed.get(k)).filter((k): k is Placed => Boolean(k));
    if (!kids.length) continue;
    const midY = p.y + BOX_H / 2;
    const busX = p.x + BOX_W + 26;
    const ys = kids.map((k) => k.y + BOX_H / 2);
    parts.push(`<path class="feeder" d="M${p.x + BOX_W} ${midY}H${busX}"/>`);
    parts.push(`<path class="bus" d="M${busX} ${Math.min(midY, ...ys)}V${Math.max(midY, ...ys)}"/>`);
    for (const k of kids) {
      const y = k.y + BOX_H / 2;
      parts.push(`<path class="feeder" d="M${busX} ${y}H${k.x}"/>`);
      parts.push(`<rect class="breaker" x="${k.x - 20}" y="${y - 5}" width="10" height="10"/>`);
    }
  }
  for (const { board: b, x, y } of placed.values()) {
    const ratings = [fmt(b.mainsRating, "A", 0), b.voltage ? `${b.voltage} V${b.phases ? ` ${b.phases}ph` : ""}` : "", fmt(b.faultLevel, "kA", 0)].filter(Boolean).join(" · ");
    const load = [b.connectedLoad !== null ? `${b.connectedLoadSource === "sum of loads" ? "Σ " : ""}${fmt(b.connectedLoad, "kVA", b.connectedLoad < 10 ? 2 : 1)}` : "", b.circuits ? `${b.circuits} circuit${b.circuits === 1 ? "" : "s"}` : "", b.downstream ? `${b.downstream} item${b.downstream === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    const kind = (b.inModel ? b.kind : "Not in the model") + (b.copies.length ? ` · ${b.copies.length + 1}× in the model` : "");
    const tip = [b.name, kind, ratings, load, b.fedFrom ? `Fed from ${b.fedFrom}` : "", b.floor ? `${b.floor}${b.space ? `, ${b.space}` : ""}` : ""].filter(Boolean).join("\n");
    parts.push(
      `<g class="board${b.inModel ? "" : " ghost"}"><title>${esc(tip)}</title>` +
        `<rect class="box" x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="5"/>` +
        `<rect x="${x}" y="${y}" width="5" height="${BOX_H}" rx="2" fill="${accent(b)}"/>` +
        `<text class="name" x="${x + 14}" y="${y + 17}">${esc(clip(b.name, 27))}</text>` +
        `<text class="kind" x="${x + 14}" y="${y + 32}">${esc(clip(kind, 32))}</text>` +
        [ratings, load]
          .filter(Boolean)
          .map((line, i) => `<text class="detail" x="${x + 14}" y="${y + 46 + i * 13}">${esc(clip(line, 34))}</text>`)
          .join("") +
        `</g>`,
    );
  }
  return { svg: `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(`Single-line diagram from ${root}`)}">${parts.join("")}</svg>`, boards: placed.size };
}

/** The diagrams page. */
export function sldHtml(reg: AssetRegister, s: { projectName: string; buildingName: string; sources: string[] }): string {
  const boards = reg.electrical.boards;
  const byName = new Map(boards.map((b) => [b.name, b]));
  const title = `${s.buildingName || s.projectName || "Model"} single-line diagrams`;
  const all = reg.electrical.roots.map((root, i) => ({ root, i, ...treeSvg(root, byName) }));
  // A board alone (with its circuits, no boards below) goes in a table, unless the model has little else.
  const trees = all.length <= 6 ? all : all.filter((t) => t.boards > 1);
  const single = all.length <= 6 ? [] : all.filter((t) => t.boards === 1).map((t) => byName.get(t.root)!);
  const inTrees = new Set(all.flatMap((t) => boards.filter((b) => b.path[0] === t.root).map((b) => b.name)));
  const loose = boards.filter((b) => !inTrees.has(b.name));
  const sourceText = s.sources.length > 3 ? `${s.sources.length} source files` : s.sources.join(", ") || "the model";
  const singleRows = single
    .map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.inModel ? b.kind : "Not in the model")}</td><td>${b.circuits}</td><td>${b.items.length}</td><td>${b.connectedLoad !== null ? esc(`${b.connectedLoadSource === "sum of loads" ? "Σ " : ""}${fmt(b.connectedLoad, "kVA")}`) : ""}</td><td>${esc(b.fedFrom)}</td></tr>`)
    .join("");
  const date = new Date().toISOString().slice(0, 10);
  const nav = trees.map((t) => `<li><a href="#tree-${t.i}">${esc(t.root)}</a> <span>${t.boards} board${t.boards === 1 ? "" : "s"}</span></li>`).join("");
  const sections = trees
    .map((t) => {
      const b = byName.get(t.root)!;
      return `<section id="tree-${t.i}"><h2>${esc(t.root)} <small>${esc(b.inModel ? b.kind : "not in the model")} · ${t.boards} board${t.boards === 1 ? "" : "s"} · ${b.downstream} item${b.downstream === 1 ? "" : "s"}</small></h2><div class="scroll">${t.svg}</div></section>`;
    })
    .join("");
  const looseRows = loose.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.kind)}</td><td>${esc(b.floor)}</td><td>${esc(b.space)}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --bg: #f7f7f5; --card: #ffffff; --fg: #1d1d1f; --fg2: #55575c; --line: #c9cbd0; --wire: #4b5563; --muted: #9ca3af; --source: #d97706; --main: #2563eb; --submain: #0d9488; --final: #16a34a; --other: #7c3aed; }
@media (prefers-color-scheme: dark) { :root { --bg: #111214; --card: #1b1c1f; --fg: #ececee; --fg2: #a3a6ad; --line: #3a3c42; --wire: #9aa0aa; --muted: #6b7280; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header, main, footer { max-width: 1400px; margin: 0 auto; padding: 0 16px; }
header { padding-top: 28px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 0 0 10px; }
h2 small { font-weight: 400; color: var(--fg2); font-size: 13px; }
p, li span, small { color: var(--fg2); }
nav ul { list-style: none; padding: 0; margin: 12px 0 20px; display: flex; flex-wrap: wrap; gap: 6px 14px; }
nav a { color: var(--main); text-decoration: none; font-weight: 600; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin: 0 0 18px; break-inside: avoid; }
.scroll { overflow: auto; }
svg { display: block; }
.box { fill: var(--card); stroke: var(--line); }
.ghost .box { stroke-dasharray: 4 3; }
.ghost text { fill: var(--muted); }
.name { font: 600 13px system-ui, sans-serif; fill: var(--fg); }
.kind { font: 11.5px system-ui, sans-serif; fill: var(--fg2); }
.detail { font: 11px system-ui, sans-serif; fill: var(--fg2); font-variant-numeric: tabular-nums; }
.feeder { stroke: var(--wire); stroke-width: 1.4; fill: none; }
.bus { stroke: var(--wire); stroke-width: 3; fill: none; }
.breaker { fill: var(--card); stroke: var(--wire); stroke-width: 1.4; }
table { border-collapse: collapse; width: 100%; }
td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); }
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin: 6px 0 0; color: var(--fg2); font-size: 12.5px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
footer { padding-bottom: 32px; font-size: 12.5px; color: var(--fg2); }
@media print { body { background: #fff; } section { border: 0; padding: 0; page-break-after: always; } .scroll { overflow: visible; } nav { display: none; } }
</style>
</head>
<body>
<header>
<h1>${esc(title)}</h1>
<p>${boards.filter((b) => b.inModel).length} boards in the model${boards.some((b) => !b.inModel) ? `, ${boards.filter((b) => !b.inModel).length} named by what they feed` : ""} · ${reg.electrical.circuits.length} circuits · ${esc(sourceText)} · ${date}</p>
<div class="legend"><span><i style="background:var(--source)"></i>Source</span><span><i style="background:var(--main)"></i>Main switchboard</span><span><i style="background:var(--submain)"></i>Sub-main board</span><span><i style="background:var(--final)"></i>Distribution board</span><span><i style="background:var(--other)"></i>Other</span><span><i style="background:var(--muted)"></i>Not in the model</span></div>
<nav><ul>${nav}</ul></nav>
</header>
<main>
${sections || (single.length ? "" : "<section><p>The model names no electrical boards and no fed-from relationships (Panel / Supply From), so there is no distribution to draw. Extract the model with all properties to read them.</p></section>")}
${single.length ? `<section><h2>Boards feeding items only <small>${single.length}</small></h2><p>Boards with circuits to items and no boards below them.</p><div class="scroll"><table><thead><tr><th>Board</th><th>Kind</th><th>Circuits</th><th>Items</th><th>Load</th><th>Fed from</th></tr></thead><tbody>${singleRows}</tbody></table></div></section>` : ""}
${loose.length ? `<section><h2>Boards outside the trees <small>${loose.length}</small></h2><p>Boards with no supply named and nothing fed from them.</p><div class="scroll"><table><thead><tr><th>Board</th><th>Kind</th><th>Floor</th><th>Space</th></tr></thead><tbody>${looseRows}</tbody></table></div></section>` : ""}
</main>
<footer>Drawn from the model's own data: each board's and item's Panel / Supply From (or a "fed from" note in its text). Loads marked Σ are the sum of what a board feeds, where the model gives none. Ratings and loads are as the model states them; check them against the design before use.</footer>
</body>
</html>`;
}
