"use client";

import clsx from "clsx";
import { AppWindow, Crosshair, DoorOpen, Hand, House, Maximize, MousePointer2, PenLine, Ruler, ScanLine, Shapes, SquareDashed, Trash2, Wand2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Callout, IconButton, Input, Segmented, Select, Spinner } from "@/components/ui/primitives";
import { findPlanRooms, recognizePlan, tracePlan } from "@/lib/convert/actions";
import { DISCIPLINES } from "@/lib/convert/disciplines";
import { distancePx, rotationFromLine, type PlanCalibration } from "@/lib/convert/plans/calibrate";
import type { TracedWall, TraceMode } from "@/lib/convert/plans/trace";
import { fromPx, paperColor } from "@/lib/convert/plans/vector";
import { updatePlan, useConvertStore, type PlanItem, type PlanOpeningItem, type PlanTraceSettings } from "@/lib/convert/store";
import type { StoreyDef } from "@/lib/convert/types";
import { formatNumber } from "@/lib/utils/format";
import { Field, NumberField, Toggle } from "./parts";
import { countsText, LayersSection, RecognizeSection, SelectionEditor, setVector, SizesSection, type Selection } from "./PlanSections";

type Tool = "select" | "draw" | "door" | "window" | "outline" | "scale" | "origin" | "align" | "region" | "pan";
type Pt = [number, number];

const TOOLS: { id: Tool; label: string; icon: React.ReactNode; hint: string }[] = [
  { id: "select", label: "Select", icon: <MousePointer2 size={15} />, hint: "Click a wall, door, window, room or column to select it; drag a wall's ends to move them. Delete removes it. Drag the background to pan." },
  { id: "draw", label: "Draw walls", icon: <PenLine size={15} />, hint: "Click the start and end of each wall; it continues from the last point. Shift keeps it straight. Esc stops." },
  { id: "door", label: "Add a door", icon: <DoorOpen size={15} />, hint: "Click both sides of the door on its wall." },
  { id: "window", label: "Add a window", icon: <AppWindow size={15} />, hint: "Click both sides of the window on its wall." },
  { id: "outline", label: "Slab outline", icon: <Shapes size={15} />, hint: "Drag corners to move them, click an edge to add a corner, Alt-click a corner to remove it." },
  { id: "scale", label: "Measure scale", icon: <Ruler size={15} />, hint: "Click both ends of a dimension you know, then type its length." },
  { id: "origin", label: "Set origin", icon: <Crosshair size={15} />, hint: "Click the point that sits at the X / Y position given on the right (a grid intersection, a building corner)." },
  { id: "align", label: "Align X axis", icon: <ScanLine size={15} />, hint: "Click two points along a line that should run along the project's X axis." },
  { id: "region", label: "Limit to an area", icon: <SquareDashed size={15} />, hint: "Drag a rectangle around the plan to leave out title blocks, legends and details." },
  { id: "pan", label: "Pan", icon: <Hand size={15} />, hint: "Drag to move around; the wheel zooms." },
];

const UNITS: { value: number; label: string }[] = [
  { value: 0.001, label: "Millimetres" },
  { value: 0.01, label: "Centimetres" },
  { value: 1, label: "Metres" },
  { value: 0.0254, label: "Inches" },
  { value: 0.3048, label: "Feet" },
];

const OPENING_COLOUR: Record<PlanOpeningItem["kind"], string> = { door: "#ea580c", window: "#0891b2", opening: "#64748b" };

export function PlanEditor() {
  const id = useConvertStore((s) => s.editingPlan);
  const plan = useConvertStore((s) => s.plans.find((p) => p.id === id) ?? null);
  const storeys = useConvertStore((s) => s.storeys);
  if (!plan) return null;
  return <Editor key={plan.id} plan={plan} storeys={storeys} />;
}

const isScaled = (cal: PlanCalibration | null): cal is PlanCalibration => Boolean(cal && cal.metresPerPixel > 0);

function segDistance(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function inRing(p: Pt, ring: Pt[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function centroid(ring: Pt[]): Pt {
  let a = 0,
    cx = 0,
    cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i],
      q = ring[(i + 1) % ring.length];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f;
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) return ring[0] ?? [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

function Editor({ plan, storeys }: { plan: PlanItem; storeys: StoreyDef[] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [tool, setTool] = useState<Tool>(isScaled(plan.calibration) ? "select" : "scale");
  const [pending, setPending] = useState<Pt[]>([]);
  const [hover, setHover] = useState<Pt | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const [measured, setMeasured] = useState<{ a: Pt; b: Pt } | null>(null);
  const [measuredLength, setMeasuredLength] = useState("");
  const [shift, setShift] = useState(false);
  const drag = useRef<
    | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number }
    | { kind: "end"; wall: number; end: "a" | "b" }
    | { kind: "vertex"; index: number }
    | { kind: "region"; start: Pt }
    | null
  >(null);
  const [draftWalls, setDraftWalls] = useState<TracedWall[] | null>(null);
  const [draftOutline, setDraftOutline] = useState<Pt[] | null>(null);
  const [draftRegion, setDraftRegion] = useState<[number, number, number, number] | null>(null);

  const walls = draftWalls ?? plan.walls;
  const outline = draftOutline ?? plan.outline;
  const cal = plan.calibration;
  const scaled = isScaled(cal);
  const mpp = scaled ? cal.metresPerPixel : 0;
  const vector = plan.vector;
  const selectedWall = sel?.kind === "wall" ? sel.index : null;

  const close = () => useConvertStore.setState({ editingPlan: null });

  const fit = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const z = Math.min(r.width / plan.width, r.height / plan.height) * 0.96;
    setView({ z, x: (r.width - plan.width * z) / 2, y: (r.height - plan.height * z) / 2 });
  }, [plan.width, plan.height]);
  useLayoutEffect(() => fit(), [fit]);

  // Wheel zoom around the cursor (non-passive, to keep the page from scrolling).
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = event.clientX - r.left,
        my = event.clientY - r.top;
      setView((v) => {
        const z = Math.max(0.02, Math.min(60, v.z * Math.exp(-event.deltaY * 0.0015)));
        return { z, x: mx - ((mx - v.x) / v.z) * z, y: my - ((my - v.y) / v.z) * z };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const setCalibration = useCallback(
    (patch: Partial<PlanCalibration>) => {
      const base: PlanCalibration = plan.calibration ?? { metresPerPixel: 0, originPx: [0, plan.height], origin: [0, 0], rotationDeg: 0 };
      updatePlan(plan.id, { calibration: { ...base, ...patch } });
    },
    [plan.calibration, plan.height, plan.id],
  );

  /** A new scale: plans read from line work are read again (their thresholds are in metres). */
  const rescale = (metresPerPixel: number, source: "set" | "sheet" = "set") => {
    setCalibration({ metresPerPixel });
    if (plan.vector) {
      setVector(plan, { scaleSource: source });
      setTimeout(() => void recognizePlan(plan.id), 0);
    }
  };

  const deleteSelected = useCallback(() => {
    if (!sel) return;
    const drop = <T,>(list: T[]) => list.filter((_, i) => i !== sel.index);
    if (sel.kind === "wall") updatePlan(plan.id, (p) => ({ walls: drop(p.walls) }));
    else if (sel.kind === "opening") updatePlan(plan.id, (p) => ({ openings: drop(p.openings) }));
    else if (sel.kind === "room") updatePlan(plan.id, (p) => ({ rooms: drop(p.rooms) }));
    else updatePlan(plan.id, (p) => ({ columns: drop(p.columns) }));
    setSel(null);
  }, [plan.id, sel]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      setShift(event.shiftKey);
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.type !== "keydown") return;
      if (event.key === "Escape") {
        if (pending.length) setPending([]);
        else if (sel) setSel(null);
        else close();
      } else if ((event.key === "Delete" || event.key === "Backspace") && sel) {
        event.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [pending.length, sel, deleteSelected]);

  const toImage = (clientX: number, clientY: number): Pt => {
    const r = viewport.current!.getBoundingClientRect();
    return [(clientX - r.left - view.x) / view.z, (clientY - r.top - view.y) / view.z];
  };

  const snapRadius = 10 / view.z;
  const snap = (p: Pt, from?: Pt | null, exclude?: number): Pt => {
    let q = p;
    if (from && shift) q = Math.abs(p[0] - from[0]) > Math.abs(p[1] - from[1]) ? [p[0], from[1]] : [from[0], p[1]];
    let best: Pt | null = null;
    let bestD = snapRadius;
    walls.forEach((w, i) => {
      if (i === exclude) return;
      for (const e of [w.a, w.b]) {
        const d = Math.hypot(e[0] - q[0], e[1] - q[1]);
        if (d < bestD) {
          bestD = d;
          best = [e[0], e[1]];
        }
      }
    });
    return best ?? q;
  };

  /** The wall under a point, and where along it (for adding doors and windows). */
  const wallAt = (p: Pt): { index: number; t: number } | null => {
    let best: { index: number; t: number } | null = null;
    let bestD = Infinity;
    walls.forEach((w, i) => {
      const d = segDistance(p, w.a, w.b);
      if (d < Math.max(w.thickness / 2 + 4 / view.z, 8 / view.z) && d < bestD) {
        const dx = w.b[0] - w.a[0],
          dy = w.b[1] - w.a[1];
        const t = ((p[0] - w.a[0]) * dx + (p[1] - w.a[1]) * dy) / (dx * dx + dy * dy || 1);
        bestD = d;
        best = { index: i, t: Math.max(0, Math.min(1, t)) };
      }
    });
    return best;
  };

  const defaultThicknessPx = useMemo(() => {
    if (walls.length) {
      const t = walls.map((w) => w.thickness).sort((a, b) => a - b);
      return t[Math.floor(t.length / 2)];
    }
    return scaled ? plan.trace.defaultThickness / mpp : 8;
  }, [walls, scaled, plan.trace.defaultThickness, mpp]);

  const hitTest = (p: Pt): Selection => {
    const tol = 6 / view.z;
    let best: Selection = null;
    let bestD = Infinity;
    plan.openings.forEach((o, i) => {
      const d = segDistance(p, o.a, o.b);
      if (d < tol * 1.5 && d < bestD) {
        bestD = d;
        best = { kind: "opening", index: i };
      }
    });
    if (best) return best;
    plan.columns.forEach((c, i) => {
      if (c.circle ? Math.hypot(p[0] - c.circle.c[0], p[1] - c.circle.c[1]) <= c.circle.r + tol : c.outline && inRing(p, c.outline)) best = { kind: "column", index: i };
    });
    if (best) return best;
    walls.forEach((w, i) => {
      const d = segDistance(p, w.a, w.b);
      if (d < Math.max(w.thickness / 2, 5 / view.z) && d < bestD) {
        bestD = d;
        best = { kind: "wall", index: i };
      }
    });
    if (best) return best;
    // The smallest room under the point.
    let area = Infinity;
    plan.rooms.forEach((r, i) => {
      if (!inRing(p, r.outline)) return;
      let a = 0;
      for (let k = 0; k < r.outline.length; k++) {
        const u = r.outline[k],
          v = r.outline[(k + 1) % r.outline.length];
        a += u[0] * v[1] - v[0] * u[1];
      }
      if (Math.abs(a) < area) {
        area = Math.abs(a);
        best = { kind: "room", index: i };
      }
    });
    return best;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const p = toImage(event.clientX, event.clientY);
    (event.target as Element).setPointerCapture?.(event.pointerId);
    const startPan = () => {
      drag.current = { kind: "pan", startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y };
    };
    if (event.button === 1 || event.button === 2 || tool === "pan") return startPan();
    if (tool === "scale" || tool === "align") {
      const next = [...pending, p];
      if (next.length < 2) return setPending(next);
      setPending([]);
      if (tool === "scale") {
        setMeasured({ a: next[0], b: next[1] });
        setMeasuredLength("");
      } else {
        setCalibration({ rotationDeg: rotationFromLine(next[0], next[1]) });
        setTool("select");
      }
      return;
    }
    if (tool === "origin") {
      setCalibration({ originPx: [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] });
      if (plan.vector) setVector(plan, { autoOrigin: false });
      setTool("select");
      return;
    }
    if (tool === "draw") {
      const from = pending[0] ?? null;
      const q = snap(p, from);
      if (!from) return setPending([q]);
      if (distancePx(from, q) > 2) {
        updatePlan(plan.id, (pl) => ({ walls: [...pl.walls, { a: from, b: q, thickness: defaultThicknessPx }] }));
      }
      setPending([q]);
      return;
    }
    if (tool === "door" || tool === "window") {
      const hit = wallAt(p);
      if (!hit) return startPan();
      const w = walls[hit.index];
      const at = (t: number): Pt => [w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t];
      const q = at(hit.t);
      if (!pending.length) return setPending([q]);
      const first = pending[0];
      setPending([]);
      if (distancePx(first, q) < 3) return;
      const hit0 = wallAt(first);
      if (!hit0 || hit0.index !== hit.index) return;
      const [t0, t1] = [hit0.t, hit.t].sort((x, y) => x - y);
      const a = at(t0),
        b = at(t1);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const opening: PlanOpeningItem = {
        a,
        b,
        kind: tool,
        swing: tool === "door" ? [(b[1] - a[1]) / L, -(b[0] - a[0]) / L] : null,
        operation: tool === "door" ? "SINGLE_SWING_LEFT" : null,
        name: null,
      };
      updatePlan(plan.id, (pl) => ({ openings: [...pl.openings, opening] }));
      setSel({ kind: "opening", index: plan.openings.length });
      return;
    }
    if (tool === "region") {
      drag.current = { kind: "region", start: p };
      setDraftRegion([p[0], p[1], p[0], p[1]]);
      return;
    }
    if (tool === "outline") {
      const hitR = 8 / view.z;
      const vi = outline.findIndex((v) => Math.hypot(v[0] - p[0], v[1] - p[1]) < hitR);
      if (vi >= 0) {
        if (event.altKey) {
          if (outline.length > 3) updatePlan(plan.id, { outline: outline.filter((_, i) => i !== vi) });
          return;
        }
        drag.current = { kind: "vertex", index: vi };
        setDraftOutline(outline.map((v) => [...v] as Pt));
        return;
      }
      for (let i = 0; i < outline.length; i++) {
        if (segDistance(p, outline[i], outline[(i + 1) % outline.length]) < 6 / view.z) {
          const next = [...outline.slice(0, i + 1), p, ...outline.slice(i + 1)] as Pt[];
          setDraftOutline(next);
          drag.current = { kind: "vertex", index: i + 1 };
          return;
        }
      }
      if (outline.length < 3) {
        // No outline yet: click corners; close by clicking the first one.
        const first = pending[0];
        if (first && pending.length >= 3 && Math.hypot(first[0] - p[0], first[1] - p[1]) < hitR) {
          updatePlan(plan.id, { outline: pending });
          setPending([]);
        } else setPending([...pending, p]);
        return;
      }
      return startPan();
    }
    // select
    if (selectedWall !== null && walls[selectedWall]) {
      const w = walls[selectedWall];
      for (const end of ["a", "b"] as const) {
        if (Math.hypot(w[end][0] - p[0], w[end][1] - p[1]) < 8 / view.z) {
          drag.current = { kind: "end", wall: selectedWall, end };
          setDraftWalls(walls.map((x) => ({ ...x, a: [...x.a] as Pt, b: [...x.b] as Pt })));
          return;
        }
      }
    }
    const hit = hitTest(p);
    if (hit && hit.kind !== "room") setSel(hit);
    else if (hit) {
      setSel(hit);
      startPan();
    } else {
      setSel(null);
      startPan();
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const p = toImage(event.clientX, event.clientY);
    setHover(p);
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") setView((v) => ({ ...v, x: d.viewX + event.clientX - d.startX, y: d.viewY + event.clientY - d.startY }));
    else if (d.kind === "end" && draftWalls) {
      const w = draftWalls[d.wall];
      const other = d.end === "a" ? w.b : w.a;
      const q = snap(p, other, d.wall);
      setDraftWalls(draftWalls.map((x, i) => (i === d.wall ? { ...x, [d.end]: q } : x)));
    } else if (d.kind === "vertex" && draftOutline) setDraftOutline(draftOutline.map((v, i) => (i === d.index ? p : v)));
    else if (d.kind === "region") setDraftRegion([Math.min(d.start[0], p[0]), Math.min(d.start[1], p[1]), Math.max(d.start[0], p[0]), Math.max(d.start[1], p[1])]);
  };

  const fullRegion = vector ? ([vector.view.x0, vector.view.y1 - vector.view.height / vector.view.k, vector.view.x0 + vector.view.width / vector.view.k, vector.view.y1] as [number, number, number, number]) : null;
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "end" && draftWalls) updatePlan(plan.id, { walls: draftWalls });
    if (d.kind === "vertex" && draftOutline) updatePlan(plan.id, { outline: draftOutline });
    if (d.kind === "region" && draftRegion) {
      const [x0, y0, x1, y1] = draftRegion;
      const region = x1 - x0 > 20 && y1 - y0 > 20 ? ([Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)] as [number, number, number, number]) : null;
      updatePlan(plan.id, (pl) => ({ trace: { ...pl.trace, region } }));
      if (vector && fullRegion) {
        // Line work: read only inside the area (drawing units).
        const a = fromPx(vector.view, x0, y1),
          b = fromPx(vector.view, x1, y0);
        setVector(plan, { region: region ? [a[0], a[1], b[0], b[1]] : fullRegion });
        setTimeout(() => void recognizePlan(plan.id), 0);
      }
      setTool("select");
    }
    setDraftWalls(null);
    setDraftOutline(null);
    setDraftRegion(null);
  };

  const applyMeasured = () => {
    const m = Number(measuredLength.replace(",", "."));
    if (!measured || !(m > 0)) return;
    const px = distancePx(measured.a, measured.b);
    if (px < 2) return;
    updatePlan(plan.id, { drawingScale: null });
    rescale(m / px);
    setMeasured(null);
    setTool("select");
  };

  const setTrace = (patch: Partial<PlanTraceSettings>) => updatePlan(plan.id, (p) => ({ trace: { ...p.trace, ...patch } }));
  const z = view.z;
  const totalLength = walls.reduce((n, w) => n + Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]), 0) * mpp;
  const outlineArea = (() => {
    let a = 0;
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i],
        q = outline[(i + 1) % outline.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return (Math.abs(a) / 2) * mpp * mpp;
  })();
  const region = draftRegion ?? plan.trace.region;
  const activeHint = TOOLS.find((t) => t.id === tool)?.hint;
  const originPx = cal?.originPx ?? [0, plan.height];
  const rot = ((cal?.rotationDeg ?? 0) * Math.PI) / 180;
  const axisLen = 60 / z;
  const hidden = new Set(vector ? vector.layers.map((l, i) => (l.role === "ignore" ? i : -1)).filter((i) => i >= 0) : []);
  // Steps of the side panel.
  let step = 0;
  const next = () => ++step;
  const unitScale = vector && scaled ? mpp * vector.view.k : null;
  const unitChoice = unitScale ? (UNITS.find((u) => Math.abs(u.value - unitScale) / u.value < 1e-6)?.value ?? "custom") : "";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg" role="dialog" aria-modal="true" aria-label={`Floor plan ${plan.label}`} data-testid="plan-editor">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <span className="truncate text-[13px] font-semibold text-fg">{plan.label}</span>
        <span className="truncate text-[12px] text-fg-3">
          {vector ? (vector.kind === "dxf" ? `Drawing · ${vector.unitLabel}` : "PDF line work") : `${plan.width} × ${plan.height} px`}
          {scaled ? ` · 1 px = ${formatNumber(mpp * 1000, 1)} mm` : " · no scale yet"}
        </span>
        {vector?.recognizing ? (
          <span className="flex items-center gap-1.5 text-[12px] text-fg-3">
            <Spinner size={12} /> Reading the plan…
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Fit to view" onClick={fit}>
            <Maximize size={15} />
          </IconButton>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-2" role="toolbar" aria-label="Plan tools">
          {TOOLS.map((t) => (
            <IconButton
              key={t.id}
              label={t.label}
              active={tool === t.id}
              disabled={!scaled && (t.id === "draw" || t.id === "outline" || t.id === "door" || t.id === "window")}
              onClick={() => {
                setTool(t.id);
                setPending([]);
              }}
            >
              {t.icon}
            </IconButton>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          <div
            ref={viewport}
            className={clsx("absolute inset-0 overflow-hidden bg-surface-3", tool === "pan" ? "cursor-grab" : "cursor-crosshair")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(null)}
            onContextMenu={(e) => e.preventDefault()}
            data-testid="plan-viewport"
          >
            <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${z})`, width: plan.width, height: plan.height }}>
              {vector?.kind === "dxf" ? (
                <svg className="pointer-events-none absolute left-0 top-0 block overflow-visible bg-white" width={plan.width} height={plan.height} viewBox={`0 0 ${plan.width} ${plan.height}`} data-testid="plan-linework">
                  {(vector.paths ?? []).map((p) =>
                    hidden.has(p.layer) ? null : (
                      <g key={p.layer}>
                        {p.fill ? <path d={p.fill} fill={paperColor(vector.layers[p.layer]?.color ?? "#000")} fillOpacity={0.3} stroke="none" /> : null}
                        {p.wide.map((w, i) => (
                          <path key={i} d={w.d} fill="none" stroke={paperColor(vector.layers[p.layer]?.color ?? "#000")} strokeOpacity={0.6} strokeWidth={Math.max(w.width, 1 / z)} />
                        ))}
                        {p.d ? <path d={p.d} fill="none" stroke={paperColor(vector.layers[p.layer]?.color ?? "#000")} strokeWidth={1 / z} /> : null}
                      </g>
                    ),
                  )}
                  {(vector.texts ?? []).map((t, i) =>
                    hidden.has(t.layer) || t.h * z < 3 ? null : (
                      <text key={i} x={t.x} y={t.y} fontSize={t.h} textAnchor="middle" dominantBaseline="middle" fill="#334155" transform={t.rotation ? `rotate(${t.rotation} ${t.x} ${t.y})` : undefined}>
                        {t.text.split("\n")[0]}
                      </text>
                    ),
                  )}
                </svg>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={plan.imageUrl} alt="" draggable={false} width={plan.width} height={plan.height} className="pointer-events-none block max-w-none select-none bg-white" />
              )}
              <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={plan.width} height={plan.height} viewBox={`0 0 ${plan.width} ${plan.height}`}>
                {plan.rooms.map((r, i) => (
                  <polygon
                    key={`r${i}`}
                    points={r.outline.map((p) => p.join(",")).join(" ")}
                    fill={sel?.kind === "room" && sel.index === i ? "rgba(22,163,74,0.22)" : "rgba(22,163,74,0.07)"}
                    stroke="#16a34a"
                    strokeOpacity={0.55}
                    strokeWidth={1 / z}
                    strokeDasharray={`${4 / z} ${3 / z}`}
                  />
                ))}
                {outline.length >= 3 ? (
                  <polygon points={outline.map((p) => p.join(",")).join(" ")} fill="rgba(234,88,12,0.06)" stroke="#ea580c" strokeWidth={1.5 / z} strokeDasharray={`${6 / z} ${4 / z}`} />
                ) : null}
                {walls.map((w, i) => (
                  <g key={i}>
                    <line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke={i === selectedWall ? "rgba(234,88,12,0.55)" : "rgba(37,99,235,0.38)"} strokeWidth={Math.max(w.thickness, 2 / z)} />
                    <line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke={i === selectedWall ? "#c2410c" : "#1d4ed8"} strokeWidth={1.4 / z} />
                  </g>
                ))}
                {plan.columns.map((c, i) => {
                  const active = sel?.kind === "column" && sel.index === i;
                  const fill = active ? "rgba(234,88,12,0.7)" : "rgba(124,58,237,0.55)";
                  return c.circle ? (
                    <circle key={`c${i}`} cx={c.circle.c[0]} cy={c.circle.c[1]} r={c.circle.r} fill={fill} stroke="#5b21b6" strokeWidth={1 / z} />
                  ) : c.outline ? (
                    <polygon key={`c${i}`} points={c.outline.map((p) => p.join(",")).join(" ")} fill={fill} stroke="#5b21b6" strokeWidth={1 / z} />
                  ) : null;
                })}
                {plan.openings.map((o, i) => {
                  const active = sel?.kind === "opening" && sel.index === i;
                  const colour = OPENING_COLOUR[o.kind];
                  const mid: Pt = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
                  const w = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]);
                  return (
                    <g key={`o${i}`}>
                      <line x1={o.a[0]} y1={o.a[1]} x2={o.b[0]} y2={o.b[1]} stroke={colour} strokeOpacity={active ? 1 : 0.85} strokeWidth={(active ? 7 : 5) / z} strokeLinecap="butt" />
                      {o.kind === "door" && o.swing ? <line x1={mid[0]} y1={mid[1]} x2={mid[0] + o.swing[0] * w * 0.4} y2={mid[1] + o.swing[1] * w * 0.4} stroke={colour} strokeWidth={1.5 / z} /> : null}
                    </g>
                  );
                })}
                {plan.rooms.map((r, i) => {
                  const text = [r.number, r.name].filter(Boolean).join(" · ") || "Room";
                  // Drawings show their own room texts in the middle: the label goes in the room's top-left corner.
                  const corner = Boolean(vector);
                  const c = corner ? ([Math.min(...r.outline.map((p) => p[0])) + 5 / z, Math.min(...r.outline.map((p) => p[1])) + 6 / z] as Pt) : centroid(r.outline);
                  return (
                    <text key={`rl${i}`} x={c[0]} y={c[1]} fontSize={10.5 / z} textAnchor={corner ? "start" : "middle"} dominantBaseline={corner ? "hanging" : "middle"} fill="#15803d" stroke="#fff" strokeWidth={3 / z} paintOrder="stroke" fontWeight={600}>
                      {text}
                    </text>
                  );
                })}
                {selectedWall !== null && walls[selectedWall]
                  ? (["a", "b"] as const).map((end) => <circle key={end} cx={walls[selectedWall][end][0]} cy={walls[selectedWall][end][1]} r={5 / z} fill="#fff" stroke="#c2410c" strokeWidth={1.5 / z} />)
                  : null}
                {tool === "outline" ? outline.map((v, i) => <rect key={i} x={v[0] - 4 / z} y={v[1] - 4 / z} width={8 / z} height={8 / z} fill="#fff" stroke="#ea580c" strokeWidth={1.5 / z} />) : null}
                {region ? <rect x={region[0]} y={region[1]} width={region[2] - region[0]} height={region[3] - region[1]} fill="none" stroke="#7c3aed" strokeWidth={1.5 / z} strokeDasharray={`${8 / z} ${5 / z}`} /> : null}
                {pending.map((p, i) => (
                  <circle key={i} cx={p[0]} cy={p[1]} r={4 / z} fill="#16a34a" />
                ))}
                {pending.length && hover ? (
                  <line x1={pending[pending.length - 1][0]} y1={pending[pending.length - 1][1]} x2={tool === "draw" ? snap(hover, pending[0])[0] : hover[0]} y2={tool === "draw" ? snap(hover, pending[0])[1] : hover[1]} stroke="#16a34a" strokeWidth={1.5 / z} strokeDasharray={`${5 / z} ${3 / z}`} />
                ) : null}
                {measured ? <line x1={measured.a[0]} y1={measured.a[1]} x2={measured.b[0]} y2={measured.b[1]} stroke="#16a34a" strokeWidth={2 / z} /> : null}
                {/* origin and axes */}
                <g>
                  <line x1={originPx[0]} y1={originPx[1]} x2={originPx[0] + Math.cos(-rot) * axisLen} y2={originPx[1] + Math.sin(-rot) * axisLen} stroke="#dc2626" strokeWidth={2 / z} />
                  <line x1={originPx[0]} y1={originPx[1]} x2={originPx[0] + Math.cos(-rot - Math.PI / 2) * axisLen} y2={originPx[1] + Math.sin(-rot - Math.PI / 2) * axisLen} stroke="#16a34a" strokeWidth={2 / z} />
                  <circle cx={originPx[0]} cy={originPx[1]} r={4 / z} fill="#111827" />
                </g>
              </svg>
            </div>
          </div>
          {activeHint ? <div className="pointer-events-none absolute bottom-2 left-2 right-2 rounded-md bg-surface/95 px-2.5 py-1.5 text-[11.5px] text-fg-2 shadow">{activeHint}</div> : null}
          {measured ? (
            <form
              className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-md border border-line bg-surface p-2 shadow"
              onSubmit={(e) => {
                e.preventDefault();
                applyMeasured();
              }}
            >
              <span className="text-[12px] text-fg-2">This line is</span>
              <Input autoFocus value={measuredLength} onChange={(e) => setMeasuredLength(e.target.value)} className="w-24" placeholder="metres" aria-label="Length of the measured line in metres" />
              <span className="text-[12px] text-fg-3">m</span>
              <Button type="submit" variant="primary" size="sm" disabled={!(Number(measuredLength.replace(",", ".")) > 0)}>
                Set scale
              </Button>
              <IconButton label="Cancel" size="sm" onClick={() => setMeasured(null)}>
                <X size={13} />
              </IconButton>
            </form>
          ) : null}
        </div>

        <aside className="scroll-thin flex w-[340px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-surface p-3">
          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{next()} · Scale</h3>
            {vector?.kind === "dxf" ? (
              <Field label="Drawing units">
                <Select
                  aria-label="Drawing units"
                  value={String(unitChoice)}
                  onChange={(e) => {
                    const u = Number(e.target.value);
                    if (u > 0) rescale(u / vector.view.k);
                  }}
                >
                  {!scaled ? <option value="">Choose the units…</option> : null}
                  {unitChoice === "custom" ? <option value="custom">Measured ({formatNumber(unitScale ?? 0, 4)} m per unit)</option> : null}
                  {UNITS.map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {vector?.kind === "dxf" && vector.scaleSource && vector.scaleSource !== "file" && vector.scaleSource !== "set" ? (
              <Callout tone="info">The file does not say its units; {vector.scaleSource === "doors" ? "the door sizes" : "the plan's size"} suggest {vector.unitLabel}. Check a known length.</Callout>
            ) : null}
            {plan.metresPerPixelAtFullSize ? (
              <Field label="Drawing scale (PDF)">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12.5px] text-fg-2">1 :</span>
                  <NumberField
                    value={plan.drawingScale ?? 100}
                    step={1}
                    min={1}
                    label="Drawing scale"
                    onChange={(n) => {
                      updatePlan(plan.id, { drawingScale: n });
                      rescale(plan.metresPerPixelAtFullSize! * n);
                    }}
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      const n = plan.drawingScale ?? 100;
                      updatePlan(plan.id, { drawingScale: n });
                      rescale(plan.metresPerPixelAtFullSize! * n);
                    }}
                  >
                    Use
                  </Button>
                </div>
              </Field>
            ) : null}
            {vector?.kind === "pdf" && (vector.scaleSource === "sheet" || vector.scaleSource === "doors") ? (
              <p className="text-[11px] leading-snug text-fg-3">{vector.scaleSource === "sheet" ? `1:${plan.drawingScale} is written on the sheet.` : `1:${plan.drawingScale} from the door sizes: check a known length.`}</p>
            ) : null}
            <Button size="sm" icon={<Ruler size={12} />} onClick={() => setTool("scale")}>
              Measure a known length
            </Button>
            {scaled ? (
              <p className="text-[11.5px] text-fg-3">
                1 pixel = {formatNumber(mpp * 1000, 2)} mm · {vector ? "plan" : "sheet"} {formatNumber(plan.width * mpp, 1)} × {formatNumber(plan.height * mpp, 1)} m
              </p>
            ) : (
              <Callout tone="warn">{vector ? "Set the scale first: reading the plan needs it." : "Set the scale first: tracing and drawing need it."}</Callout>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{next()} · Position</h3>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Origin X (m)">
                <NumberField value={cal?.origin[0] ?? 0} label="Origin X" onChange={(n) => setCalibration({ origin: [n, cal?.origin[1] ?? 0] })} />
              </Field>
              <Field label="Origin Y (m)">
                <NumberField value={cal?.origin[1] ?? 0} label="Origin Y" onChange={(n) => setCalibration({ origin: [cal?.origin[0] ?? 0, n] })} />
              </Field>
              <Field label="Rotation (°)">
                <NumberField value={cal?.rotationDeg ?? 0} step={0.1} label="Rotation" onChange={(n) => setCalibration({ rotationDeg: n })} />
              </Field>
            </div>
            <div className="flex gap-2">
              <Button size="sm" icon={<Crosshair size={12} />} onClick={() => setTool("origin")}>
                Pick origin
              </Button>
              <Button size="sm" icon={<ScanLine size={12} />} onClick={() => setTool("align")}>
                Align X axis
              </Button>
            </div>
            <p className="text-[11px] leading-snug text-fg-3">
              {vector?.autoOrigin
                ? "The origin sits at the floor's lower-left corner, so floors of one drawing stack. Pick a grid intersection instead for exact alignment."
                : "The picked point is placed at X / Y in the project (the same coordinates as the model's site). Leave 0 / 0 for plans on their own."}
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{next()} · Storey</h3>
            {storeys.length ? (
              <Select
                aria-label="Use a storey of the model"
                value=""
                onChange={(e) => {
                  const st = storeys.find((s) => s.key === e.target.value);
                  if (!st) return;
                  const i = storeys.indexOf(st);
                  const nextStorey = storeys[i + 1];
                  updatePlan(plan.id, { storey: { name: st.name, elevation: st.elevation, height: nextStorey ? Math.max(2.4, Math.round((nextStorey.elevation - st.elevation) * 100) / 100) : plan.storey.height } });
                }}
              >
                <option value="">Use a storey of the model…</option>
                {storeys.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name} · {formatNumber(s.elevation)} m
                  </option>
                ))}
              </Select>
            ) : null}
            <Field label="Name">
              <Input value={plan.storey.name} onChange={(e) => updatePlan(plan.id, { storey: { ...plan.storey, name: e.target.value } })} aria-label="Storey name" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Elevation (m)">
                <NumberField value={plan.storey.elevation} label="Storey elevation" onChange={(n) => updatePlan(plan.id, { storey: { ...plan.storey, elevation: n } })} />
              </Field>
              <Field label="Wall height (m)">
                <NumberField value={plan.storey.height} min={0.1} label="Wall height" onChange={(n) => updatePlan(plan.id, { storey: { ...plan.storey, height: n } })} />
              </Field>
            </div>
          </section>

          {vector ? (
            <>
              <LayersSection plan={plan} step={next()} />
              <RecognizeSection plan={plan} step={next()} scaled={scaled} />
            </>
          ) : (
            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{next()} · Trace walls</h3>
              <Segmented<TraceMode>
                value={plan.trace.mode}
                onChange={(mode) => setTrace({ mode })}
                options={[
                  { value: "filled", label: "Filled", title: "Walls drawn as solid (poché) strokes" },
                  { value: "double", label: "Two lines", title: "Walls drawn as pairs of parallel lines" },
                  { value: "single", label: "One line", title: "Each line is a wall centre line" },
                ]}
              />
              <Toggle checked={plan.trace.darkWalls} onChange={(v) => setTrace({ darkWalls: v })} label="Walls are darker than the paper" hint="Turn off for renders with light walls on a dark background." />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Thinnest wall (m)">
                  <NumberField value={plan.trace.minThickness} min={0.01} label="Thinnest wall" onChange={(n) => setTrace({ minThickness: n })} />
                </Field>
                <Field label="Thickest wall (m)">
                  <NumberField value={plan.trace.maxThickness} min={0.02} label="Thickest wall" onChange={(n) => setTrace({ maxThickness: n })} />
                </Field>
                <Field label="Shortest wall (m)">
                  <NumberField value={plan.trace.minLength} min={0.05} label="Shortest wall" onChange={(n) => setTrace({ minLength: n })} />
                </Field>
                <Field label="Door gaps up to (m)">
                  <NumberField value={plan.trace.doorGap} min={0.1} label="Door gap" onChange={(n) => setTrace({ doorGap: n })} />
                </Field>
                {plan.trace.mode === "single" ? (
                  <Field label="Wall thickness (m)">
                    <NumberField value={plan.trace.defaultThickness} min={0.02} label="Wall thickness" onChange={(n) => setTrace({ defaultThickness: n })} />
                  </Field>
                ) : null}
                <Field label={`Ink threshold${plan.trace.threshold === null ? " (auto)" : ""}`}>
                  <input
                    type="range"
                    min={0}
                    max={255}
                    value={plan.trace.threshold ?? 128}
                    onChange={(e) => setTrace({ threshold: Number(e.target.value) })}
                    onDoubleClick={() => setTrace({ threshold: null })}
                    aria-label="Ink threshold (double-click for automatic)"
                    className="h-7 accent-[var(--accent)]"
                  />
                </Field>
              </div>
              <Toggle checked={plan.trace.orthogonal} onChange={(v) => setTrace({ orthogonal: v })} label="Square walls to the plan's main directions" />
              {plan.trace.region ? (
                <div className="flex items-center justify-between text-[11.5px] text-fg-3">
                  Tracing inside the marked area.
                  <button type="button" className="underline" onClick={() => setTrace({ region: null })}>
                    Clear
                  </button>
                </div>
              ) : null}
              <Button variant="primary" icon={plan.tracing ? <Spinner size={13} className="text-accent-fg" /> : <Wand2 size={13} />} disabled={!scaled || plan.tracing} onClick={() => void tracePlan(plan.id)}>
                {plan.tracing ? "Tracing…" : plan.traced ? "Trace again" : "Trace walls"}
              </Button>
              {plan.traceError ? <Callout tone="warn">{plan.traceError}</Callout> : null}
              {plan.traced && walls.length ? <p className="text-[11px] text-fg-3">Tracing again replaces the walls and outline, including your edits.</p> : null}
            </section>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{next()} · Check</h3>
            <p className="text-[12px] text-fg-2" data-testid="plan-counts">
              {countsText(plan)}
              {scaled ? ` · ${formatNumber(totalLength, 1)} m of wall` : ""}
              {outline.length >= 3 && scaled ? ` · floor ${formatNumber(outlineArea, 0)} m²` : ""}
            </p>
            {selectedWall !== null && walls[selectedWall] ? (
              <div className="flex items-end gap-2">
                <Field label="Selected wall thickness (m)" className="flex-1">
                  <NumberField
                    value={Math.round(walls[selectedWall].thickness * mpp * 1000) / 1000}
                    min={0.01}
                    label="Selected wall thickness"
                    onChange={(n) => updatePlan(plan.id, (p) => ({ walls: p.walls.map((w, i) => (i === selectedWall ? { ...w, thickness: n / mpp } : w)) }))}
                  />
                </Field>
                <Button size="md" variant="danger" icon={<Trash2 size={13} />} onClick={deleteSelected}>
                  Delete
                </Button>
              </div>
            ) : sel ? (
              <SelectionEditor plan={plan} sel={sel} mpp={mpp} onDelete={deleteSelected} />
            ) : (
              <p className="text-[11px] text-fg-3">Select a wall, door, window, room or column to change or delete it; draw missing walls, doors and windows with the tools on the left.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={plan.findingRooms ? <Spinner size={12} /> : <House size={12} />} disabled={!scaled || !walls.length || plan.findingRooms} onClick={() => void findPlanRooms(plan.id)} title="Rooms from the walls as they are now">
                {plan.rooms.length ? "Find rooms again" : "Find rooms"}
              </Button>
              <Button size="sm" disabled={!walls.length} onClick={() => updatePlan(plan.id, { walls: [] })}>
                Clear walls
              </Button>
              <Button size="sm" disabled={!outline.length} onClick={() => updatePlan(plan.id, { outline: [] })}>
                Clear outline
              </Button>
            </div>
          </section>

          <SizesSection plan={plan} step={next()} />

          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">{next()} · Output</h3>
            <Toggle checked={plan.withSlab} onChange={(v) => updatePlan(plan.id, { withSlab: v })} label="Floor slab from the outline" />
            {plan.withSlab ? (
              <Field label="Slab thickness (m)">
                <NumberField value={plan.slabThickness} min={0.01} label="Slab thickness" onChange={(n) => updatePlan(plan.id, { slabThickness: n })} />
              </Field>
            ) : null}
            <Field label="Discipline">
              <Select value={plan.discipline} onChange={(e) => updatePlan(plan.id, { discipline: e.target.value })} aria-label="Discipline of the plan">
                {DISCIPLINES.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Toggle checked={plan.include} onChange={(v) => updatePlan(plan.id, { include: v })} label="Include in the IFC files" />
          </section>
        </aside>
      </div>
    </div>
  );
}
