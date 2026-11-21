// Runs the facility's live sources while bim-os is open: MQTT connections and
// the demo simulator. Readings are batched and handed to the workspace once a
// second; topics nobody has mapped yet are kept as "discovered" so they can be
// added as points; quiet points are checked for "no data" alarms.

import { create } from "zustand";
import { simulatedValue } from "../demo";
import { checkStale, ingestReadings, useFm, type Reading } from "../store";
import type { LiveSource } from "../types";
import { connectMqtt, readPayload, type MqttConnection, type MqttStatus } from "./mqtt";

export interface SourceState {
  status: MqttStatus | "running" | "off";
  detail?: string;
  messages: number;
  lastAt?: number;
}

export interface Discovered {
  sourceId: string;
  key: string;
  value: number | string;
  count: number;
  lastAt: number;
}

interface LiveState {
  sources: Record<string, SourceState>;
  discovered: Record<string, Discovered>;
}

export const useLive = create<LiveState>(() => ({ sources: {}, discovered: {} }));

const running = new Map<string, { stop: () => void; signature: string }>();
let buffer: Reading[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let staleTimer: ReturnType<typeof setInterval> | null = null;
const DISCOVERED_LIMIT = 500;

function setSource(id: string, patch: Partial<SourceState>) {
  useLive.setState((s) => ({ sources: { ...s.sources, [id]: { ...{ status: "off" as const, messages: 0 }, ...s.sources[id], ...patch } } }));
}

function ensureTimers() {
  if (!flushTimer)
    flushTimer = setInterval(() => {
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      ingestReadings(batch);
    }, 1000);
  if (!staleTimer) staleTimer = setInterval(() => checkStale(), 30000);
}

function receive(source: LiveSource, key: string, value: number | string, t: number) {
  const id = `${source.id}|${key}`;
  const known = useFm.getState().points.some((p) => p.id === id);
  if (known) buffer.push({ pointId: id, t, v: value });
  else
    useLive.setState((s) => {
      const prev = s.discovered[id];
      const discovered = { ...s.discovered, [id]: { sourceId: source.id, key, value, count: (prev?.count ?? 0) + 1, lastAt: t } };
      const ids = Object.keys(discovered);
      if (ids.length > DISCOVERED_LIMIT) delete discovered[ids[0]];
      return { discovered };
    });
  const st = useLive.getState().sources[source.id];
  setSource(source.id, { messages: (st?.messages ?? 0) + 1, lastAt: Date.now() });
}

function startMqtt(source: LiveSource): () => void {
  let connection: MqttConnection | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let delay = 2000;
  const open = () => {
    connection = connectMqtt({
      url: source.url,
      username: source.username,
      password: source.password,
      topics: source.topics.length ? source.topics : ["#"],
      onStatus: (status, detail) => {
        if (status === "connected") delay = 2000;
        const prev = useLive.getState().sources[source.id];
        // Keep the reason of an error when the socket closes right after it.
        setSource(source.id, { status: status === "closed" && prev?.status === "error" ? "error" : status, detail: detail ?? (status === "closed" ? prev?.detail : undefined) });
        if (status === "closed" && !stopped) {
          retry = setTimeout(open, delay);
          delay = Math.min(delay * 2, 60000);
        }
      },
      onMessage: (topic, payload) => {
        const reading = readPayload(payload, source.valuePath, source.timePath, Date.now());
        if (reading) receive(source, topic, reading.value, reading.t);
      },
    });
  };
  open();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    connection?.close();
    setSource(source.id, { status: "off", detail: undefined });
  };
}

function startSimulator(source: LiveSource): () => void {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const tick = () => {
    const t = Date.now();
    for (const p of useFm.getState().points) if (p.sourceId === source.id) receive(source, p.key, simulatedValue(p, t, rnd), t);
  };
  // Some history straight away, so charts are not empty.
  const now = Date.now();
  const points = useFm.getState().points.filter((p) => p.sourceId === source.id);
  if (points.length && points.every((p) => !useFm.getState().series[p.id]?.length)) {
    for (let k = 120; k > 0; k--) {
      const t = now - k * 60000;
      for (const p of points) buffer.push({ pointId: p.id, t, v: simulatedValue(p, t, rnd) });
    }
  }
  tick();
  const timer = setInterval(tick, 5000);
  setSource(source.id, { status: "running", detail: undefined });
  return () => {
    clearInterval(timer);
    setSource(source.id, { status: "off" });
  };
}

const signatureOf = (s: LiveSource) => JSON.stringify([s.kind, s.url, s.username, s.password, s.topics, s.valuePath, s.timePath, s.enabled]);

/** Starts, restarts and stops sources to match the workspace's list. */
export function syncLiveSources() {
  const sources = useFm.getState().sources;
  const wanted = new Map(sources.filter((s) => s.enabled && (s.kind === "simulator" || s.url)).map((s) => [s.id, s]));
  for (const [id, run] of running) {
    const s = wanted.get(id);
    if (!s || signatureOf(s) !== run.signature) {
      run.stop();
      running.delete(id);
    }
  }
  for (const [id, s] of wanted) {
    if (running.has(id)) continue;
    ensureTimers();
    running.set(id, { stop: s.kind === "mqtt" ? startMqtt(s) : startSimulator(s), signature: signatureOf(s) });
  }
  for (const s of sources) if (!wanted.has(s.id)) setSource(s.id, { status: "off" });
}

export function stopLive() {
  for (const run of running.values()) run.stop();
  running.clear();
}

/** Readings from a CSV file: time, point, value (a header row is skipped). Returns readings and the points named. */
export function parseReadingsCsv(text: string, sourceId: string): { readings: Reading[]; keys: string[]; skipped: number } {
  const readings: Reading[] = [];
  const keys = new Set<string>();
  let skipped = 0;
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (const [i, line] of lines.entries()) {
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cells.length < 3) {
      skipped++;
      continue;
    }
    const [time, key, raw] = cells;
    const t = /^\d+(\.\d+)?$/.test(time) ? (Number(time) < 1e12 ? Number(time) * 1000 : Number(time)) : Date.parse(time);
    if (!Number.isFinite(t) || !key) {
      if (i > 0) skipped++;
      continue;
    }
    const n = Number(raw);
    readings.push({ pointId: `${sourceId}|${key}`, t, v: raw !== "" && Number.isFinite(n) ? n : raw });
    keys.add(key);
  }
  return { readings, keys: [...keys], skipped };
}
