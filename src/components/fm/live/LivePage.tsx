"use client";

// Live data: where readings come from (MQTT brokers over WebSocket, CSV
// files, the simulator), the points they feed and the assets those belong
// to, alarm limits, and the alarms. Readings are kept per point on this
// device; the building's model can be exported as Brick.

import clsx from "clsx";
import { AlertTriangle, BellOff, CheckCircle2, Download, FileUp, Link2, Pencil, Plus, Radio, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { LineChart, Sparkline } from "@/components/charts/LineChart";
import { Button, Callout } from "@/components/ui/primitives";
import { pushToast } from "@/lib/store";
import { downloadText } from "@/lib/utils/download";
import { valueOf } from "@/lib/fm/asset";
import { alarmText, numeric } from "@/lib/fm/alarms";
import { brickTurtle } from "@/lib/fm/brick";
import { parseReadingsCsv, useLive } from "@/lib/fm/live/runtime";
import { fileStem } from "@/lib/fm/package";
import { assetMatcher, guessKind, nameFromKey } from "@/lib/fm/pointmatch";
import { norm } from "@/lib/fm/search";
import { acknowledgeAlarms, assetMap, clearClosedAlarms, deletePoints, flushSeries, ingestReadings, saveSources, uid, upsertPoints, useFm } from "@/lib/fm/store";
import type { AlarmRule, LiveSource, Point, PointKind } from "@/lib/fm/types";
import { AssetPicker } from "../WorkOrderDialog";
import { ago, Empty, formatDateTime, FormRow, inputCls, Modal, Panel, plural, Tabs, textareaCls, useParam, WorkspaceGate } from "../ui";

type Tab = "points" | "alarms" | "sources";
const CSV_SOURCE = "csv";
const KINDS: PointKind[] = ["temperature", "humidity", "pressure", "flow", "power", "energy", "current", "voltage", "co2", "occupancy", "status", "alarm", "setpoint", "speed", "level", "other"];

export function LivePage() {
  return (
    <WorkspaceGate what="Live data">
      <Live />
    </WorkspaceGate>
  );
}

function Live() {
  const [tabParam, setTab] = useParam("tab");
  const points = useFm((s) => s.points);
  const alarms = useFm((s) => s.alarms);
  const sources = useFm((s) => s.sources);
  const active = alarms.filter((a) => a.end === undefined).length;
  const tab = (["points", "alarms", "sources"].includes(tabParam) ? tabParam : points.length || sources.length ? "points" : "sources") as Tab;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="border-b border-line bg-surface px-3 pt-3 sm:px-4">
        <div className="pb-2">
          <h1 className="text-[17px] font-semibold tracking-tight text-fg">Live data</h1>
          <p className="text-[12px] text-fg-2">
            {plural(points.length, "point")} from {plural(sources.length, "source")} · readings are kept on this device while the app is open
          </p>
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "points", label: "Points", count: points.length || undefined },
            { id: "alarms", label: "Alarms", count: active || undefined, tone: active ? "bad" : undefined },
            { id: "sources", label: "Sources", count: sources.length || undefined },
          ]}
        />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] p-3 sm:p-4">
          {tab === "points" ? <PointsTab /> : null}
          {tab === "alarms" ? <AlarmsTab /> : null}
          {tab === "sources" ? <SourcesTab /> : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Points

function ruleText(rule?: AlarmRule): string {
  if (!rule) return "";
  return [rule.high !== undefined ? `> ${rule.high}` : "", rule.low !== undefined ? `< ${rule.low}` : "", rule.alarmValue ? `= ${rule.alarmValue}` : "", rule.staleMinutes ? `quiet ${rule.staleMinutes} min` : ""].filter(Boolean).join(" · ");
}

function PointsTab() {
  const facility = useFm((s) => s.facility)!;
  const points = useFm((s) => s.points);
  const assets = useFm((s) => s.assets);
  const spaces = useFm((s) => s.spaces);
  const series = useFm((s) => s.series);
  const sources = useFm((s) => s.sources);
  useFm((s) => s.liveRev);
  const discovered = useLive((s) => s.discovered);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<Point | null>(null);
  const [pointParam, setPointParam] = useParam("point");
  const [exportParam, setExportParam] = useParam("export");
  const byId = assetMap(assets);
  const matcher = useMemo(() => assetMatcher(assets), [assets]);
  const sourceName = (id: string) => (id === CSV_SOURCE ? "CSV import" : (sources.find((s) => s.id === id)?.name ?? id));

  const exportBrick = () => {
    downloadText(brickTurtle(facility, assets, spaces, points), `${fileStem(facility.name, "brick")}.ttl`, "text/turtle");
  };
  useEffect(() => {
    if (exportParam === "brick") {
      setExportParam(null);
      exportBrick();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportParam]);

  const words = norm(text).split(" ").filter(Boolean);
  const shown = points.filter((p) => {
    if (!words.length) return true;
    const a = p.assetId ? byId.get(p.assetId) : undefined;
    const hay = norm(`${p.name} ${p.key} ${p.kind} ${a ? `${valueOf(a, "name")} ${valueOf(a, "code")}` : ""}`);
    return words.every((w) => hay.includes(w));
  });
  const fresh = Object.values(discovered).sort((a, b) => b.count - a.count);
  const focus = pointParam ? points.find((p) => p.id === pointParam) : undefined;

  const addDiscovered = (list: typeof fresh) => {
    const created: Point[] = list.map((d) => {
      const asset = matcher.match(d.key);
      const guess = guessKind(d.key);
      return { id: `${d.sourceId}|${d.key}`, sourceId: d.sourceId, key: d.key, name: nameFromKey(d.key, asset), unit: guess.unit, kind: guess.kind, assetId: asset?.id };
    });
    upsertPoints(created);
    // What each topic last sent goes to its new point, so it does not read "never" until the next message.
    ingestReadings(list.map((d) => ({ pointId: `${d.sourceId}|${d.key}`, t: d.lastAt, v: d.value })));
    useLive.setState((s) => {
      const next = { ...s.discovered };
      for (const d of list) delete next[`${d.sourceId}|${d.key}`];
      return { discovered: next };
    });
    const linked = created.filter((p) => p.assetId).length;
    pushToast("success", `${plural(created.length, "point")} added, ${linked} linked to assets from their names.`);
  };

  return (
    <div className="flex flex-col gap-4">
      {fresh.length ? (
        <Panel
          title={`New topics coming in (${fresh.length})`}
          aside={
            <Button size="sm" variant="primary" icon={<Plus size={12} />} onClick={() => addDiscovered(fresh)}>
              Add all as points
            </Button>
          }
          bodyClassName="p-0"
        >
          <ul className="scroll-thin max-h-64 divide-y divide-line overflow-y-auto">
            {fresh.slice(0, 200).map((d) => {
              const asset = matcher.match(d.key);
              return (
                <li key={`${d.sourceId}|${d.key}`} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[12.5px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={d.key}>
                    {d.key}
                  </span>
                  <span className="tabular text-fg-2">{String(d.value).slice(0, 24)}</span>
                  <span className="text-[11.5px] text-fg-3">{asset ? `→ ${valueOf(asset, "name")}` : "no asset found from the name"}</span>
                  <Button size="sm" onClick={() => addDiscovered([d])}>
                    Add
                  </Button>
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line-strong bg-surface px-2 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-fg-3" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search points, topics, assets…" className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none focus-ring-none placeholder:text-fg-3" aria-label="Search points" />
          {text ? (
            <button type="button" onClick={() => setText("")} aria-label="Clear" className="rounded p-0.5 text-fg-3 hover:text-fg">
              <X size={13} />
            </button>
          ) : null}
        </label>
        <Button icon={<Download size={13} />} onClick={exportBrick} title="The building, its floors, rooms, equipment and points as a Brick model (RDF / Turtle)">
          Brick (Turtle)
        </Button>
      </div>

      {points.length === 0 ? (
        <Empty action={<Link href="/live?tab=sources" className="text-accent hover:underline">Add a source</Link>}>
          No points yet. Connect a source; the topics it sends show up above to be added as points, linked to their assets by name.
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[960px] text-[12.5px]">
            <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-fg-3">
              <tr>
                <th className="px-3 py-1.5 font-semibold">Point</th>
                <th className="px-2 py-1.5 font-semibold">Asset</th>
                <th className="px-2 py-1.5 text-right font-semibold">Value</th>
                <th className="px-2 py-1.5 font-semibold">Last 2 h</th>
                <th className="px-2 py-1.5 font-semibold">Last reading</th>
                <th className="px-2 py-1.5 font-semibold">Alarm when</th>
                <th className="w-16 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.slice(0, 500).map((p) => {
                const a = p.assetId ? byId.get(p.assetId) : undefined;
                const list = series[p.id] ?? [];
                const cut = Date.now() - 2 * 3600000;
                const values = list.filter(([t]) => t >= cut).map(([, v]) => numeric(v)).filter((v): v is number => v !== null);
                const stale = p.lastAt && p.rule?.staleMinutes && Date.now() - p.lastAt > p.rule.staleMinutes * 60000;
                return (
                  <tr key={p.id} className={clsx("hover:bg-surface-2", p.id === pointParam && "bg-accent-soft")}>
                    <td className="max-w-[260px] px-3 py-1.5">
                      <button type="button" className="block max-w-full truncate text-left text-fg hover:underline" onClick={() => setPointParam(p.id)} title={p.name}>
                        {p.name || p.key}
                      </button>
                      <div className="truncate font-mono text-[11px] text-fg-3" title={`${sourceName(p.sourceId)}: ${p.key}`}>
                        {p.key}
                      </div>
                    </td>
                    <td className="max-w-[200px] truncate px-2 py-1.5">
                      {a ? (
                        <Link href={`/assets?asset=${encodeURIComponent(a.id)}&tab=live`} className="text-accent hover:underline">
                          {valueOf(a, "name")}
                        </Link>
                      ) : (
                        <button type="button" onClick={() => setEditing(p)} className="inline-flex items-center gap-1 text-fg-3 hover:text-accent">
                          <Link2 size={12} /> Link to an asset
                        </button>
                      )}
                    </td>
                    <td className="tabular whitespace-nowrap px-2 py-1.5 text-right font-medium text-fg">
                      {p.lastValue !== undefined ? String(p.lastValue) : "–"}
                      {p.unit && p.lastValue !== undefined ? <span className="ml-0.5 text-[11px] font-normal text-fg-3">{p.unit}</span> : null}
                    </td>
                    <td className="px-2 py-1.5">{values.length > 1 ? <Sparkline values={values.slice(-120)} label={`${p.name}: last 2 hours`} /> : <span className="text-[11px] text-fg-3">–</span>}</td>
                    <td className={clsx("whitespace-nowrap px-2 py-1.5 text-[12px]", stale ? "text-bad" : "text-fg-2")}>{ago(p.lastAt)}</td>
                    <td className="max-w-[180px] truncate px-2 py-1.5 text-[12px] text-fg-2">{ruleText(p.rule) || <span className="text-fg-3">–</span>}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex justify-end gap-0.5">
                        <button type="button" aria-label="Edit point" onClick={() => setEditing(p)} className="rounded p-1 text-fg-3 hover:bg-surface-3 hover:text-fg">
                          <Pencil size={13} />
                        </button>
                        <button type="button" aria-label="Delete point" onClick={() => deletePoints([p.id])} className="rounded p-1 text-fg-3 hover:bg-bad-soft hover:text-bad">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {focus ? <PointChart point={focus} onClose={() => setPointParam(null)} /> : null}
      {editing ? <PointDialog point={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function PointChart({ point, onClose }: { point: Point; onClose: () => void }) {
  const series = useFm((s) => s.series[point.id] ?? []);
  const data = series.map(([t, v]) => ({ t, v: numeric(v) })).filter((d): d is { t: number; v: number } => d.v !== null);
  const limits = [point.rule?.high !== undefined ? { label: "High limit", value: point.rule.high } : null, point.rule?.low !== undefined ? { label: "Low limit", value: point.rule.low } : null].filter((x): x is { label: string; value: number } => Boolean(x));
  const textValues = series.filter(([, v]) => numeric(v) === null).slice(-12).reverse();
  return (
    <Modal open onClose={onClose} title={point.name || point.key} width={760}>
      <div className="flex flex-col gap-2">
        <p className="text-[12px] text-fg-3">
          {point.key} · {plural(series.length, "reading")} kept · latest {point.lastValue ?? "–"} {point.unit}
        </p>
        {data.length > 1 ? <LineChart title={point.name || point.key} data={data} unit={point.unit} limits={limits} height={220} /> : null}
        {textValues.length ? (
          <ul className="text-[12px] text-fg-2">
            {textValues.map(([t, v]) => (
              <li key={t}>
                {formatDateTime(t)}: <b className="text-fg">{String(v)}</b>
              </li>
            ))}
          </ul>
        ) : null}
        {!data.length && !textValues.length ? <Empty>No readings yet.</Empty> : null}
      </div>
    </Modal>
  );
}

function PointDialog({ point, onClose }: { point: Point; onClose: () => void }) {
  const spaces = useFm((s) => s.spaces);
  const [name, setName] = useState(point.name);
  const [unit, setUnit] = useState(point.unit);
  const [kind, setKind] = useState<PointKind>(point.kind);
  const [assetIds, setAssetIds] = useState<string[]>(point.assetId ? [point.assetId] : []);
  const [spaceId, setSpaceId] = useState(point.spaceId ?? "");
  const [high, setHigh] = useState(point.rule?.high?.toString() ?? "");
  const [low, setLow] = useState(point.rule?.low?.toString() ?? "");
  const [alarmValue, setAlarmValue] = useState(point.rule?.alarmValue ?? "");
  const [stale, setStale] = useState(point.rule?.staleMinutes?.toString() ?? "");
  const save = () => {
    const num = (v: string) => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const rule: AlarmRule = { high: num(high), low: num(low), alarmValue: alarmValue.trim() || undefined, staleMinutes: num(stale) };
    const hasRule = Object.values(rule).some((v) => v !== undefined);
    upsertPoints([{ ...point, name: name.trim() || point.key, unit: unit.trim(), kind, assetId: assetIds[assetIds.length - 1], spaceId: spaceId || undefined, rule: hasRule ? rule : undefined }]);
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Point"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="font-mono text-[11.5px] text-fg-3">{point.key}</p>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="Name" className="col-span-2">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </FormRow>
          <FormRow label="Kind">
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as PointKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k === "co2" ? "CO₂" : k.charAt(0).toUpperCase() + k.slice(1)}
                </option>
              ))}
            </select>
          </FormRow>
          <FormRow label="Unit">
            <input className={inputCls} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="°C, %, kW…" />
          </FormRow>
        </div>
        <FormRow label="Asset" hint="Readings and alarms show on the asset's page." group>
          <AssetPicker value={assetIds} onChange={(ids) => setAssetIds(ids.slice(-1))} />
        </FormRow>
        {!assetIds.length ? (
          <FormRow label="Or a room" hint="For room sensors (temperature, CO₂, occupancy).">
            <select className={inputCls} value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
              <option value="">None</option>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {[s.number, s.name].filter(Boolean).join(" ")} {s.floor ? `(${s.floor})` : ""}
                </option>
              ))}
            </select>
          </FormRow>
        ) : null}
        <fieldset className="rounded-md border border-line p-2.5">
          <legend className="px-1 text-[11.5px] font-medium text-fg-2">Alarm when</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <FormRow label="Above">
              <input className={inputCls} inputMode="decimal" value={high} onChange={(e) => setHigh(e.target.value)} placeholder="–" />
            </FormRow>
            <FormRow label="Below">
              <input className={inputCls} inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} placeholder="–" />
            </FormRow>
            <FormRow label="Value is">
              <input className={inputCls} value={alarmValue} onChange={(e) => setAlarmValue(e.target.value)} placeholder="fault, 1…" />
            </FormRow>
            <FormRow label="Quiet for (min)">
              <input className={inputCls} inputMode="numeric" value={stale} onChange={(e) => setStale(e.target.value)} placeholder="–" />
            </FormRow>
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Alarms

function AlarmsTab() {
  const alarms = useFm((s) => s.alarms);
  const points = useFm((s) => s.points);
  const assets = useFm((s) => s.assets);
  const byId = assetMap(assets);
  const pointById = new Map(points.map((p) => [p.id, p]));
  const active = alarms.filter((a) => a.end === undefined).sort((a, b) => b.start - a.start);
  const ended = alarms.filter((a) => a.end !== undefined).sort((a, b) => (b.end ?? 0) - (a.end ?? 0));
  const unacked = active.filter((a) => !a.ackAt);

  const row = (al: (typeof alarms)[number]) => {
    const p = pointById.get(al.pointId);
    const a = al.assetId ? byId.get(al.assetId) : undefined;
    return (
      <li key={al.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
        {al.end === undefined ? <AlertTriangle size={15} className="shrink-0 text-bad" /> : <CheckCircle2 size={15} className="shrink-0 text-ok" />}
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] text-fg">
            <span className="font-medium">{p?.name ?? al.pointId}</span> · {alarmText(al, p)}
          </div>
          <div className="text-[11.5px] text-fg-3">
            {a ? (
              <Link href={`/assets?asset=${encodeURIComponent(a.id)}&tab=live`} className="text-accent hover:underline">
                {valueOf(a, "name")}
              </Link>
            ) : (
              "No asset"
            )}{" "}
            · from {formatDateTime(al.start)}
            {al.end !== undefined ? ` to ${formatDateTime(al.end)}` : ` (${ago(al.start)})`}
            {al.ackAt ? ` · acknowledged by ${al.ackBy}` : ""}
          </div>
        </div>
        {!al.ackAt ? (
          <Button size="sm" icon={<BellOff size={12} />} onClick={() => acknowledgeAlarms([al.id])}>
            Acknowledge
          </Button>
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={`Active (${active.length})`}
        aside={
          unacked.length > 1 ? (
            <Button size="sm" onClick={() => acknowledgeAlarms(unacked.map((a) => a.id))}>
              Acknowledge all {unacked.length}
            </Button>
          ) : null
        }
        bodyClassName="p-0"
      >
        {active.length ? (
          <ul className="divide-y divide-line">{active.map(row)}</ul>
        ) : (
          <p className="flex items-center justify-center gap-1.5 px-3 py-6 text-[12.5px] text-fg-3">
            <CheckCircle2 size={14} className="text-ok" /> No active alarms.
          </p>
        )}
      </Panel>
      <Panel
        title={`Ended (${ended.length})`}
        aside={
          ended.some((a) => a.ackAt) ? (
            <Button size="sm" variant="ghost" onClick={clearClosedAlarms}>
              Clear acknowledged
            </Button>
          ) : null
        }
        bodyClassName="p-0"
      >
        {ended.length ? <ul className="divide-y divide-line">{ended.slice(0, 200).map(row)}</ul> : <p className="px-3 py-6 text-center text-[12.5px] text-fg-3">None.</p>}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources

const STATUS_TEXT: Record<string, string> = { connecting: "Connecting", connected: "Connected", closed: "Disconnected", error: "Error", running: "Running", off: "Off" };

function SourcesTab() {
  const sources = useFm((s) => s.sources);
  const points = useFm((s) => s.points);
  const assets = useFm((s) => s.assets);
  const state = useLive((s) => s.sources);
  const [addParam, setAddParam] = useParam("add");
  const [editing, setEditing] = useState<LiveSource | null>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const matcher = useMemo(() => assetMatcher(assets), [assets]);

  const importCsv = async (file: File) => {
    const text = await file.text();
    const { readings, keys, skipped } = parseReadingsCsv(text, CSV_SOURCE);
    if (!readings.length) {
      pushToast("error", "No readings found. Each row needs a time, a point name and a value.");
      return;
    }
    const known = new Set(points.map((p) => p.id));
    const fresh: Point[] = keys
      .filter((k) => !known.has(`${CSV_SOURCE}|${k}`))
      .map((k) => {
        const asset = matcher.match(k);
        const guess = guessKind(k);
        return { id: `${CSV_SOURCE}|${k}`, sourceId: CSV_SOURCE, key: k, name: nameFromKey(k, asset), unit: guess.unit, kind: guess.kind, assetId: asset?.id };
      });
    upsertPoints(fresh);
    // Points have to exist before their readings are taken in.
    setTimeout(() => {
      ingestReadings(readings);
      flushSeries();
    }, 0);
    pushToast("success", `${plural(readings.length, "reading")} for ${plural(keys.length, "point")} imported${fresh.length ? ` (${fresh.length} new)` : ""}${skipped ? `; ${skipped} rows skipped` : ""}.`);
  };

  return (
    <div className="flex flex-col gap-4">
      <Callout tone="info">
        Building systems reach bim-os through an MQTT broker with a WebSocket listener (Mosquitto, EMQX, HiveMQ, a cloud IoT hub): BACnet, Modbus, KNX and others through a gateway that publishes their points to it. Readings come in while the app is open; set the broker to keep the last value of each topic (retained messages) so values show straight away.
      </Callout>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Radio size={14} />} onClick={() => setEditing({ id: uid("src"), kind: "mqtt", name: "BMS gateway", url: "wss://", topics: ["#"], valuePath: "value", timePath: "", enabled: true })}>
          Add an MQTT broker
        </Button>
        <Button icon={<FileUp size={14} />} onClick={() => csvInput.current?.click()}>
          Import readings (CSV)
        </Button>
        <input
          ref={csvInput}
          type="file"
          accept=".csv,text/csv,.txt"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importCsv(f);
          }}
        />
      </div>
      {sources.length === 0 ? (
        <Empty>No sources yet. A CSV file needs three columns per row: time (ISO date or epoch), point name, value.</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {sources.map((s) => {
            const st = state[s.id];
            const n = points.filter((p) => p.sourceId === s.id).length;
            const tone = st?.status === "connected" || st?.status === "running" ? "ok" : st?.status === "error" ? "bad" : "neutral";
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
                <span className={clsx("size-2.5 shrink-0 rounded-full", tone === "ok" ? "bg-ok" : tone === "bad" ? "bg-bad" : "bg-fg-3")} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-fg">
                    {s.name} <span className="text-[11.5px] font-normal text-fg-3">· {s.kind === "mqtt" ? "MQTT" : "Simulator"}</span>
                  </div>
                  <div className="truncate text-[11.5px] text-fg-3">
                    {STATUS_TEXT[st?.status ?? (s.enabled ? "off" : "off")] ?? st?.status}
                    {st?.detail ? `: ${st.detail}` : ""} · {plural(n, "point")} · {st?.messages ? `${st.messages.toLocaleString()} messages, last ${ago(st.lastAt)}` : "no messages yet"}
                    {s.kind === "mqtt" ? ` · ${s.url}` : ""}
                  </div>
                </div>
                <label className="flex items-center gap-1.5 text-[12px] text-fg-2">
                  <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={s.enabled} onChange={(e) => saveSources(sources.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x)))} />
                  On
                </label>
                {s.kind === "mqtt" ? (
                  <Button size="sm" icon={<Pencil size={12} />} onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                ) : null}
                <button type="button" aria-label="Remove source" onClick={() => saveSources(sources.filter((x) => x.id !== s.id))} className="rounded p-1 text-fg-3 hover:bg-bad-soft hover:text-bad">
                  <Trash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {editing || addParam === "mqtt" ? (
        <SourceDialog
          source={editing ?? { id: uid("src"), kind: "mqtt", name: "BMS gateway", url: "wss://", topics: ["#"], valuePath: "value", timePath: "", enabled: true }}
          onClose={() => {
            setEditing(null);
            if (addParam) setAddParam(null);
          }}
        />
      ) : null}
    </div>
  );
}

function SourceDialog({ source, onClose }: { source: LiveSource; onClose: () => void }) {
  const sources = useFm((s) => s.sources);
  const [s, setS] = useState(source);
  const [topics, setTopics] = useState(source.topics.join("\n"));
  const valid = /^wss?:\/\/.+/.test(s.url.trim());
  const insecure = s.url.trim().startsWith("ws://") && typeof window !== "undefined" && window.location.protocol === "https:";
  const save = () => {
    const next = { ...s, url: s.url.trim(), topics: topics.split(/\n+/).map((t) => t.trim()).filter(Boolean) };
    saveSources(sources.some((x) => x.id === next.id) ? sources.map((x) => (x.id === next.id ? next : x)) : [...sources, next]);
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="MQTT broker"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={save}>
            Save and connect
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormRow label="Name">
          <input className={inputCls} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
        </FormRow>
        <FormRow label="WebSocket address" hint="Such as wss://broker.example.com:8884/mqtt. The broker must allow this app's address (CORS is not involved; the WebSocket listener must be enabled).">
          <input className={inputCls} value={s.url} onChange={(e) => setS({ ...s, url: e.target.value })} spellCheck={false} />
        </FormRow>
        {insecure ? <Callout tone="warn">Browsers block unencrypted ws:// connections from an https:// page; use the broker&apos;s wss:// listener.</Callout> : null}
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="User name">
            <input className={inputCls} value={s.username ?? ""} onChange={(e) => setS({ ...s, username: e.target.value || undefined })} autoComplete="off" />
          </FormRow>
          <FormRow label="Password" hint="Kept on this device only; never written to workspace files.">
            <input className={inputCls} type="password" value={s.password ?? ""} onChange={(e) => setS({ ...s, password: e.target.value || undefined })} autoComplete="new-password" />
          </FormRow>
        </div>
        <FormRow label="Topics" hint="One per line; + matches one level, # everything below.">
          <textarea className={textareaCls} rows={3} value={topics} onChange={(e) => setTopics(e.target.value)} spellCheck={false} />
        </FormRow>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="Value in JSON messages" hint='Path such as "value" or "data.temp"; plain messages are read as they are.'>
            <input className={inputCls} value={s.valuePath} onChange={(e) => setS({ ...s, valuePath: e.target.value })} />
          </FormRow>
          <FormRow label="Time in JSON messages" hint="Empty: the time a message arrives.">
            <input className={inputCls} value={s.timePath} onChange={(e) => setS({ ...s, timePath: e.target.value })} placeholder="ts" />
          </FormRow>
        </div>
      </div>
    </Modal>
  );
}
