"use client";

import { Eye, Maximize2, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Button, Callout, IconButton, Segmented, Spinner } from "@/components/ui/primitives";
import { buildOptions } from "@/lib/convert/actions";
import { convertWorker } from "@/lib/convert/client";
import type { PreviewData } from "@/lib/convert/preview";
import type { PreviewPick, PreviewScene } from "@/lib/convert/previewScene";
import { useConvertStore } from "@/lib/convert/store";
import { formatCount } from "@/lib/utils/format";
import { Card } from "./parts";

/** Triangles drawn at most; larger models show their largest elements. */
const BUDGET = 6_000_000;

type Stats = PreviewData["stats"] & { materials: number; textures: number };

/**
 * A 3D preview of what will be converted, drawn from the extracted model with
 * its materials and textures (or in the single colours IFC viewers show).
 */
export function PreviewCard() {
  const parts = useConvertStore((s) => s.parts);
  const partConfig = useConvertStore((s) => s.partConfig);
  const settings = useConvertStore((s) => s.settings);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<PreviewScene | null>(null);
  const downAt = useRef<[number, number] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"textured" | "ifc">("textured");
  const [stats, setStats] = useState<Stats | null>(null);
  const [pick, setPick] = useState<PreviewPick | null>(null);
  const [shownKey, setShownKey] = useState("");
  const included = parts.filter((p) => partConfig[p.id]?.include !== false);

  // What the preview depends on: the parts and filters (not names or storeys).
  const key = useMemo(
    () =>
      JSON.stringify([
        parts.map((p) => [p.id, partConfig[p.id]?.include !== false]),
        settings.excludedCategories,
        settings.excludePattern,
        settings.textures === "none",
        settings.lines,
      ]),
    [parts, partConfig, settings.excludedCategories, settings.excludePattern, settings.textures, settings.lines],
  );
  const stale = state === "ready" && key !== shownKey;

  useEffect(() => {
    // Theme switches change the page colours behind the model.
    const observer = new MutationObserver(() => view.current?.applyBackground());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => {
      observer.disconnect();
      view.current?.dispose();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    view.current?.setMode(mode);
  }, [mode]);

  // Nothing left to show once every model is gone.
  useEffect(() => {
    if (parts.length === 0 && view.current) {
      view.current.dispose();
      view.current = null;
      setState("idle");
      setStats(null);
      setPick(null);
    }
  }, [parts.length]);

  const show = async () => {
    if (!host.current) return;
    setState("loading");
    setError(null);
    setPick(null);
    try {
      const requested = key;
      const data = await convertWorker.preview(buildOptions(), BUDGET);
      if (!view.current || view.current.disposed) {
        const { PreviewScene } = await import("@/lib/convert/previewScene");
        view.current = await PreviewScene.create(host.current);
      }
      await view.current.load(data, mode);
      setStats({ ...data.stats, materials: data.materials.length, textures: data.textures.length });
      setShownKey(requested);
      setState("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  };

  const onClick = (event: MouseEvent) => {
    if (state !== "ready" || !view.current) return;
    // A drag (orbit) is not a click.
    const down = downAt.current;
    if (down && Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return;
    setPick(view.current.pick(event.clientX, event.clientY));
  };

  return (
    <Card
      title="Preview"
      id="convert-preview"
      aside={
        state === "ready" ? (
          <>
            <Segmented
              className="w-[190px]"
              value={mode}
              onChange={setMode}
              options={[
                { value: "textured", label: "Materials", title: "Colours, shine, transparency and textures as the Autodesk viewer showed them" },
                { value: "ifc", label: "IFC colours", title: "The single colour per surface that IFC viewers without textures show" },
              ]}
            />
            <IconButton label="Fit the model in view" size="sm" onClick={() => view.current?.fit()}>
              <Maximize2 size={13} />
            </IconButton>
          </>
        ) : null
      }
    >
      {included.length === 0 ? (
        <p className="text-[12px] text-fg-3">Add a model (or include one above) to preview it with its materials and textures.</p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Button variant={state === "ready" && !stale ? "secondary" : "primary"} size="sm" icon={state === "ready" ? <RefreshCw size={12} /> : <Eye size={13} />} busy={state === "loading"} onClick={() => void show()} data-testid="convert-preview-show">
              {state === "ready" ? "Refresh" : "Show preview"}
            </Button>
            <span className="text-[11.5px] text-fg-3">
              {stale
                ? "The parts or filters changed: refresh to see what will be converted."
                : state === "ready" && stats
                  ? `${formatCount(stats.shown)} elements · ${formatCount(stats.triangles)} triangles · ${stats.materials} materials · ${stats.textures} texture${stats.textures === 1 ? "" : "s"}`
                  : "Draws the parts and categories that will be converted, with their materials and textures."}
            </span>
          </div>
          <div
            ref={host}
            className="relative h-[440px] overflow-hidden rounded-md border border-line bg-surface-2"
            onPointerDown={(e) => (downAt.current = [e.clientX, e.clientY])}
            onClick={onClick}
            data-testid="convert-preview"
          >
            {state === "idle" ? <div className="absolute inset-0 grid place-items-center text-[12px] text-fg-3">The preview appears here.</div> : null}
            {state === "loading" ? (
              <div className="absolute inset-0 z-10 grid place-items-center bg-surface-2/60">
                <span className="flex items-center gap-2 text-[12px] text-fg-2">
                  <Spinner /> Preparing the preview…
                </span>
              </div>
            ) : null}
            {pick ? (
              <div className="absolute left-2 top-2 z-10 max-w-[min(360px,80%)] rounded-md border border-line bg-surface/95 px-2.5 py-2 text-[11.5px] shadow-sm" data-testid="convert-preview-pick">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-fg" title={pick.element.name}>
                      {pick.element.name || "(unnamed)"}
                    </div>
                    <div className="truncate text-fg-3">{[pick.element.category, pick.element.level].filter(Boolean).join(" · ")}</div>
                  </div>
                  <button
                    type="button"
                    aria-label="Close"
                    className="text-fg-3 hover:text-fg"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPick(null);
                      view.current?.hideMarker();
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
                {pick.element.material ? <div className="mt-1 truncate text-fg-2">Material: {pick.element.material}</div> : null}
                {pick.element.texture ? <div className="truncate text-fg-2">Texture: {pick.element.texture}</div> : null}
                {pick.element.file ? <div className="truncate text-fg-3">{pick.element.file}</div> : null}
              </div>
            ) : null}
          </div>
          {stats?.capped ? (
            <p className="mt-1.5 text-[11px] text-fg-3">
              The model has {formatCount(stats.totalTriangles)} triangles; the preview shows {formatCount(stats.shown)} of its {formatCount(stats.elements)} elements, leaving out the most detailed small ones. The IFC files get all of them.
            </p>
          ) : null}
          {state === "ready" ? <p className="mt-1.5 text-[11px] text-fg-3">Drag to orbit, right-drag to pan, scroll to zoom; click a surface to see its element and material.</p> : null}
          {error ? (
            <Callout tone="bad" className="mt-2">
              {error}
            </Callout>
          ) : null}
        </>
      )}
    </Card>
  );
}
