"use client";

// QR labels for assets: chosen by the same search as the Assets page (or
// handed over from a selection), in a size that suits a label printer or a
// sheet of labels, printed from the browser.

import { Link2, Printer, Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Toggle } from "@/components/convert/parts";
import { Button, Callout } from "@/components/ui/primitives";
import { valueOf } from "@/lib/fm/asset";
import { assetHay, matchesAsset, parseAssetQuery } from "@/lib/fm/filter";
import { labelPayload, qrSvg } from "@/lib/fm/qr";
import { assetMap, updateFacility, useFm } from "@/lib/fm/store";
import type { Asset, Facility } from "@/lib/fm/types";
import { inputCls, Panel, plural, useParam, WorkspaceGate } from "../ui";
import { useLabelQueue } from "./queue";

interface Preset {
  id: string;
  label: string;
  /** Label size, millimetres. */
  w: number;
  h: number;
  /** Sheets: page size, margins and gaps (mm); rolls print one label per page. */
  sheet?: { page: "A4" | "letter"; cols: number; rows: number; top: number; left: number; gapX: number; gapY: number };
}

const PRESETS: Preset[] = [
  { id: "roll-50x25", label: "Label printer, 50 × 25 mm", w: 50, h: 25 },
  { id: "roll-62x29", label: "Label printer, 62 × 29 mm", w: 62, h: 29 },
  { id: "roll-100x50", label: "Label printer, 100 × 50 mm", w: 100, h: 50 },
  { id: "a4-3x8", label: "A4 sheet, 3 × 8 labels (70 × 37 mm)", w: 70, h: 37, sheet: { page: "A4", cols: 3, rows: 8, top: 0.5, left: 0, gapX: 0, gapY: 0 } },
  { id: "a4-2x7", label: "A4 sheet, 2 × 7 labels (99.1 × 38.1 mm)", w: 99.1, h: 38.1, sheet: { page: "A4", cols: 2, rows: 7, top: 15.15, left: 4.65, gapX: 2.5, gapY: 0 } },
  { id: "letter-3x10", label: "US Letter sheet, 3 × 10 labels (66.7 × 25.4 mm)", w: 66.7, h: 25.4, sheet: { page: "letter", cols: 3, rows: 10, top: 12.7, left: 4.8, gapX: 3.2, gapY: 0 } },
];

const PREFS_KEY = "bimos-label-prefs";
const LIMIT = 3000;

interface Content {
  name: boolean;
  location: boolean;
  kind: boolean;
  facility: boolean;
}

export function LabelsPage() {
  return (
    <WorkspaceGate what="Labels">
      <Labels />
    </WorkspaceGate>
  );
}

function Labels() {
  const facility = useFm((s) => s.facility)!;
  const assets = useFm((s) => s.assets);
  const queue = useLabelQueue((s) => s.ids);
  const [from] = useParam("from");
  const [useQueue, setUseQueue] = useState(Boolean(queue && from));
  const [text, setText] = useState("");
  const deferred = useDeferredValue(text);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [content, setContent] = useState<Content>({ name: true, location: true, kind: false, facility: false });
  const [base, setBase] = useState(facility.labelBaseUrl);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
      if (saved?.presetId) setPresetId(saved.presetId);
      if (saved?.content) setContent(saved.content);
    } catch {
      /* no saved preferences */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ presetId, content }));
    } catch {
      /* storage unavailable */
    }
  }, [presetId, content]);

  const chosen: Asset[] = useMemo(() => {
    if (useQueue && queue) {
      const byId = assetMap(assets);
      return queue.map((id) => byId.get(id)).filter((a): a is Asset => Boolean(a));
    }
    const query = parseAssetQuery(deferred);
    if (!query.words.length && !query.filters.length) return [];
    return assets.filter((a) => matchesAsset(a, query, assetHay(a)));
  }, [useQueue, queue, assets, deferred]);
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const printable = chosen.slice(0, LIMIT);

  const pageCss = preset.sheet
    ? `@page { size: ${preset.sheet.page === "A4" ? "210mm 297mm" : "215.9mm 279.4mm"}; margin: 0; }`
    : `@page { size: ${preset.w}mm ${preset.h}mm; margin: 0; }`;

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-bg">
      <style>{`@media print { ${pageCss} }`}</style>
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-3 sm:p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight text-fg">Labels</h1>
            <p className="mt-0.5 text-[12.5px] text-fg-2">QR labels with the asset code. Scanning one opens the asset in the field app.</p>
          </div>
          <Button variant="primary" icon={<Printer size={14} />} disabled={!printable.length} onClick={() => window.print()}>
            Print {printable.length ? plural(printable.length, "label") : "labels"}
          </Button>
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(300px,380px)_1fr]">
          <div className="flex flex-col gap-4">
            <Panel title="Which assets">
              {queue ? (
                <div className="mb-2 flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] text-fg">
                    <input type="radio" checked={useQueue} onChange={() => setUseQueue(true)} className="accent-[var(--accent)]" /> The {plural(queue.length, "asset")} chosen before
                  </label>
                  <label className="flex items-center gap-2 text-[12.5px] text-fg">
                    <input type="radio" checked={!useQueue} onChange={() => setUseQueue(false)} className="accent-[var(--accent)]" /> Assets found by a search
                  </label>
                </div>
              ) : null}
              {!useQueue || !queue ? (
                <>
                  <label className="flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent">
                    <Search size={14} className="shrink-0 text-fg-3" />
                    <input value={text} onChange={(e) => setText(e.target.value)} placeholder="floor:L03 kind:pump, or a room, a system…" className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none focus-ring-none placeholder:text-fg-3" aria-label="Assets to label" />
                    {text ? (
                      <button type="button" onClick={() => setText("")} aria-label="Clear" className="rounded p-0.5 text-fg-3 hover:text-fg">
                        <X size={13} />
                      </button>
                    ) : null}
                  </label>
                  <p className="mt-1.5 text-[11.5px] text-fg-3">The same search and filters as on the Assets page. A floor at a time works well.</p>
                </>
              ) : null}
              <p className="mt-2 text-[12.5px] text-fg">{chosen.length ? `${plural(chosen.length, "asset")} chosen` : "No assets chosen yet."}</p>
              {chosen.length > LIMIT ? <Callout tone="warn" className="mt-2">The first {LIMIT.toLocaleString()} are printed at a time; narrow the search for the rest.</Callout> : null}
            </Panel>
            <Panel title="Label">
              <div className="flex flex-col gap-3">
                <select className={inputCls} value={presetId} onChange={(e) => setPresetId(e.target.value)} aria-label="Label size">
                  {PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <Toggle checked={content.name} onChange={(v) => setContent({ ...content, name: v })} label="Name" />
                  <Toggle checked={content.location} onChange={(v) => setContent({ ...content, location: v })} label="Floor and room" />
                  <Toggle checked={content.kind} onChange={(v) => setContent({ ...content, kind: v })} label="Kind" />
                  <Toggle checked={content.facility} onChange={(v) => setContent({ ...content, facility: v })} label="Building name" />
                </div>
                <p className="text-[11.5px] leading-snug text-fg-3">In the print dialog choose the label size or paper above, scale 100% (no fitting) and no headers or footers.</p>
              </div>
            </Panel>
            <Panel title="What the QR code opens">
              <div className="flex flex-col gap-2">
                <p className="text-[12px] leading-relaxed text-fg-2">
                  With this app&apos;s web address, a phone&apos;s own camera opens the asset in the field app. Without one, the code holds just the asset code, which the field app&apos;s scanner (or typing) finds.
                </p>
                <input className={inputCls} value={base} onChange={(e) => setBase(e.target.value)} onBlur={() => base !== facility.labelBaseUrl && updateFacility({ labelBaseUrl: base.trim() })} placeholder="https://fm.example.com" aria-label="App address for labels" />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    icon={<Link2 size={12} />}
                    onClick={() => {
                      setBase(window.location.origin);
                      updateFacility({ labelBaseUrl: window.location.origin });
                    }}
                  >
                    Use this app&apos;s address
                  </Button>
                  {base ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setBase("");
                        updateFacility({ labelBaseUrl: "" });
                      }}
                    >
                      Codes only
                    </Button>
                  ) : null}
                </div>
                {base && /localhost|127\.0\.0\.1/.test(base) ? <Callout tone="warn">This address only works on this computer; phones need the address the app is served from on your network or the internet.</Callout> : null}
              </div>
            </Panel>
          </div>
          <Panel title="Preview" bodyClassName="bg-surface-2">
            {printable.length ? (
              <div className="flex flex-wrap gap-3">
                {printable.slice(0, 24).map((a) => (
                  <div key={a.id} className="rounded border border-line-strong bg-white shadow-sm">
                    <LabelFace asset={a} facility={facility} preset={preset} content={content} />
                  </div>
                ))}
                {printable.length > 24 ? <p className="w-full text-[12px] text-fg-3">and {(printable.length - 24).toLocaleString()} more.</p> : null}
              </div>
            ) : (
              <p className="py-8 text-center text-[12.5px] text-fg-3">Choose assets to see their labels.</p>
            )}
          </Panel>
        </div>
      </div>
      <PrintSheet assets={printable} facility={facility} preset={preset} content={content} />
    </div>
  );
}

/** One label at its real size. */
function LabelFace({ asset, facility, preset, content }: { asset: Asset; facility: Facility; preset: Preset; content: Content }) {
  const qr = useMemo(() => qrSvg(labelPayload(asset, facility), { margin: 1 }), [asset, facility]);
  const pad = Math.min(2.5, preset.h * 0.08);
  const qrSize = preset.h - pad * 2;
  const code = valueOf(asset, "code");
  const lines = [content.name ? valueOf(asset, "name") : "", content.kind ? asset.kind : "", content.location ? [valueOf(asset, "floor"), valueOf(asset, "space")].filter(Boolean).join(" · ") : "", content.facility ? facility.name : ""].filter(Boolean);
  const textMm = Math.max(1.8, Math.min(3.2, preset.h / 9));
  return (
    <div className="flex items-center overflow-hidden text-black" style={{ width: `${preset.w}mm`, height: `${preset.h}mm`, padding: `${pad}mm`, gap: `${pad}mm`, fontFamily: "Arial, Helvetica, sans-serif" }}>
      <div style={{ width: `${qrSize}mm`, height: `${qrSize}mm`, flex: "none" }} dangerouslySetInnerHTML={{ __html: qr }} />
      <div className="min-w-0 flex-1 overflow-hidden" style={{ lineHeight: 1.15 }}>
        <div style={{ fontSize: `${textMm * 1.25}mm`, fontWeight: 700, overflowWrap: "anywhere" }}>{code}</div>
        {lines.map((l, i) => (
          <div key={i} style={{ fontSize: `${textMm}mm`, marginTop: "0.6mm", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: i === 0 && content.name ? 2 : 1, WebkitBoxOrient: "vertical" }}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The labels laid out for printing: outside the app's frame, shown only by the print stylesheet. */
function PrintSheet({ assets, facility, preset, content }: { assets: Asset[]; facility: Facility; preset: Preset; content: Content }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  if (!assets.length || !host) return null;
  const s = preset.sheet;
  let body: React.ReactNode;
  if (!s)
    body = assets.map((a) => (
      <div key={a.id} style={{ breakAfter: "page", pageBreakAfter: "always" }}>
        <LabelFace asset={a} facility={facility} preset={preset} content={content} />
      </div>
    ));
  else {
    const perPage = s.cols * s.rows;
    const pages: Asset[][] = [];
    for (let i = 0; i < assets.length; i += perPage) pages.push(assets.slice(i, i + perPage));
    body = pages.map((page, i) => (
      <div
        key={i}
        style={{
          breakAfter: "page",
          pageBreakAfter: "always",
          paddingTop: `${s.top}mm`,
          paddingLeft: `${s.left}mm`,
          display: "grid",
          gridTemplateColumns: `repeat(${s.cols}, ${preset.w}mm)`,
          gridAutoRows: `${preset.h}mm`,
          columnGap: `${s.gapX}mm`,
          rowGap: `${s.gapY}mm`,
        }}
      >
        {page.map((a) => (
          <LabelFace key={a.id} asset={a} facility={facility} preset={preset} content={content} />
        ))}
      </div>
    ));
  }
  return createPortal(<div className="print-portal">{body}</div>, host);
}
