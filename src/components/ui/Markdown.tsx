"use client";

// A small, safe Markdown renderer for assistant replies: paragraphs, headings,
// lists, tables, code and bold / italic / links. It builds React elements and
// never injects HTML. Underscores are left alone on purpose, because IFC names
// (Pset_WallCommon, Qto_SlabBaseQuantities) are full of them.

import clsx from "clsx";
import { Fragment, type ReactNode } from "react";

type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "rule" }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: { text: string; depth: number }[] }
  | { kind: "table"; header: string[]; align: ("left" | "right" | "center" | null)[]; rows: string[][] };

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = cells(line);
      const align = cells(lines[i + 1]).map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
      blocks.push({ kind: "table", header, align, rows });
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const first = LIST_ITEM.exec(line);
    if (first) {
      const ordered = first[3] !== undefined;
      const baseIndent = first[1].length;
      const items: { text: string; depth: number }[] = [];
      while (i < lines.length) {
        const match = LIST_ITEM.exec(lines[i]);
        if (match) {
          items.push({ text: match[4], depth: Math.min(3, Math.max(0, Math.round((match[1].length - baseIndent) / 2))) });
          i += 1;
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length > 0) {
          // Continuation line of the previous item.
          items[items.length - 1].text += ` ${lines[i].trim()}`;
          i += 1;
        } else break;
      }
      blocks.push({ kind: "list", ordered, start: ordered ? Number(first[3]) : 1, items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```+|~~~+)/.test(lines[i]) && !/^\s{0,3}#{1,6}\s/.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !/^\s{0,3}>/.test(lines[i])) {
      if (body.length > 0 && lines[i].includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) break;
      body.push(lines[i++].trim());
    }
    if (body.length === 0) body.push(lines[i++].trim());
    blocks.push({ kind: "paragraph", text: body.join("\n") });
  }
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^\n]+?\*\*)|(\*[^*\s](?:[^*\n]*?[^*\s])?\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

function inline(text: string, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (match[1]) {
      nodes.push(
        <code key={key} className="rounded bg-surface-2 px-1 py-px font-mono text-[0.92em] text-fg">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      nodes.push(
        <strong key={key} className="font-semibold text-fg">
          {inline(token.slice(2, -2), key)}
        </strong>,
      );
    } else if (match[3]) {
      nodes.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>);
    } else {
      const split = token.indexOf("](");
      nodes.push(
        <a key={key} href={token.slice(split + 2, -1)} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
          {token.slice(1, split)}
        </a>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function withBreaks(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split("\n");
  return parts.map((part, position) => (
    <Fragment key={`${keyPrefix}-${position}`}>
      {inline(part, `${keyPrefix}-${position}`)}
      {position < parts.length - 1 ? " " : null}
    </Fragment>
  ));
}

const NUMERIC = /^[-+−]?[\d\s.,'’]+(?:\s?(?:%|mm|cm|m|km|m2|m3|m²|m³|kg|t|kN|W\/m²K))?$/;

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parse(text);
  return (
    <div className={clsx("space-y-2 text-[12.5px] leading-relaxed text-fg", className)}>
      {blocks.map((block, position) => {
        const key = `b-${position}`;
        switch (block.kind) {
          case "heading":
            return (
              <div key={key} role="heading" aria-level={Math.min(6, block.level + 2)} className={clsx("pt-1 font-semibold text-fg", block.level <= 2 ? "text-[13.5px]" : "text-[12.5px]")}>
                {inline(block.text, key)}
              </div>
            );
          case "code":
            return (
              <pre key={key} className="scroll-thin overflow-x-auto rounded-md border border-line bg-surface-2 p-2 font-mono text-[11.5px] leading-snug text-fg">
                {block.text}
              </pre>
            );
          case "rule":
            return <hr key={key} className="border-line" />;
          case "quote":
            return (
              <blockquote key={key} className="border-l-2 border-line-strong pl-2.5 text-fg-2">
                {inline(block.text, key)}
              </blockquote>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={key} start={block.ordered ? block.start : undefined} className={clsx("space-y-1 pl-5", block.ordered ? "list-decimal" : "list-disc", "marker:text-fg-3")}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`} style={item.depth > 0 ? { marginLeft: item.depth * 14 } : undefined}>
                    {inline(item.text, `${key}-${itemIndex}`)}
                  </li>
                ))}
              </List>
            );
          }
          case "table": {
            const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length));
            const align = Array.from({ length: columns }, (_, column) => {
              if (block.align[column]) return block.align[column];
              const values = block.rows.map((row) => row[column] ?? "").filter(Boolean);
              return values.length > 0 && values.every((value) => NUMERIC.test(value.replace(/\*\*/g, ""))) ? "right" : "left";
            });
            return (
              <div key={key} className="scroll-thin overflow-x-auto rounded-md border border-line">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="bg-surface-2">
                      {Array.from({ length: columns }, (_, column) => (
                        <th key={column} scope="col" className={clsx("border-b border-line px-2 py-1 font-medium text-fg-2", align[column] === "right" ? "text-right" : align[column] === "center" ? "text-center" : "text-left")}>
                          {inline(block.header[column] ?? "", `${key}-h${column}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-line last:border-b-0">
                        {Array.from({ length: columns }, (_, column) => (
                          <td key={column} className={clsx("px-2 py-1 align-top", align[column] === "right" ? "tabular whitespace-nowrap text-right" : align[column] === "center" ? "text-center" : "text-left")}>
                            {inline(row[column] ?? "", `${key}-${rowIndex}-${column}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          default:
            return <p key={key}>{withBreaks(block.text, key)}</p>;
        }
      })}
    </div>
  );
}
