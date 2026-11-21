// A small MQTT 3.1.1 client over WebSocket, enough to subscribe to a building's
// live data from the browser: connect (with user name and password), subscribe
// with QoS 0, receive messages, keep the connection alive, disconnect.
// Building systems that speak BACnet, Modbus or others reach it through a
// gateway that publishes to an MQTT broker.

export type MqttStatus = "connecting" | "connected" | "closed" | "error";

export interface MqttOptions {
  /** ws:// or wss:// address of the broker's WebSocket listener, e.g. wss://broker.example.com:8884/mqtt */
  url: string;
  clientId?: string;
  username?: string;
  password?: string;
  /** Seconds between keep-alive pings. */
  keepalive?: number;
  topics: string[];
  onMessage: (topic: string, payload: Uint8Array) => void;
  onStatus: (status: MqttStatus, detail?: string) => void;
}

export interface MqttConnection {
  close: () => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function str(text: string): number[] {
  const bytes = encoder.encode(text);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

function remainingLength(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

function packet(type: number, body: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array([type, ...remainingLength(body.length), ...body]);
}

export function connectPacket(clientId: string, keepalive: number, username?: string, password?: string): Uint8Array<ArrayBuffer> {
  let flags = 0x02; // clean session
  if (username) flags |= 0x80;
  if (username && password) flags |= 0x40;
  const body = [...str("MQTT"), 4, flags, keepalive >> 8, keepalive & 0xff, ...str(clientId)];
  if (username) body.push(...str(username));
  if (username && password) body.push(...str(password));
  return packet(0x10, body);
}

export function subscribePacket(id: number, topics: string[]): Uint8Array<ArrayBuffer> {
  const body = [id >> 8, id & 0xff];
  for (const topic of topics) body.push(...str(topic), 0);
  return packet(0x82, body);
}

export interface ParsedPacket {
  type: number;
  flags: number;
  body: Uint8Array;
}

/** Takes complete packets off the front of a buffer; returns them and what is left. */
export function parsePackets(buffer: Uint8Array): { packets: ParsedPacket[]; rest: Uint8Array } {
  const packets: ParsedPacket[] = [];
  let at = 0;
  while (at + 2 <= buffer.length) {
    let length = 0;
    let multiplier = 1;
    let i = at + 1;
    let complete = false;
    for (let k = 0; k < 4 && i < buffer.length; k++, i++) {
      const byte = buffer[i];
      length += (byte & 0x7f) * multiplier;
      multiplier *= 128;
      if (!(byte & 0x80)) {
        complete = true;
        i++;
        break;
      }
    }
    if (!complete || i + length > buffer.length) break;
    packets.push({ type: buffer[at] >> 4, flags: buffer[at] & 0x0f, body: buffer.subarray(i, i + length) });
    at = i + length;
  }
  return { packets, rest: buffer.slice(at) };
}

export function readPublish(p: ParsedPacket): { topic: string; payload: Uint8Array; qos: number; id: number } {
  const topicLength = (p.body[0] << 8) | p.body[1];
  const topic = decoder.decode(p.body.subarray(2, 2 + topicLength));
  const qos = (p.flags >> 1) & 0x03;
  let at = 2 + topicLength;
  let id = 0;
  if (qos > 0) {
    id = (p.body[at] << 8) | p.body[at + 1];
    at += 2;
  }
  return { topic, payload: p.body.subarray(at), qos, id };
}

const CONNACK_ERRORS: Record<number, string> = {
  1: "the broker does not accept MQTT 3.1.1",
  2: "the client id was rejected",
  3: "the broker is unavailable",
  4: "wrong user name or password",
  5: "not authorised",
};

export function connectMqtt(options: MqttOptions): MqttConnection {
  const keepalive = options.keepalive ?? 45;
  const clientId = options.clientId || `bimos-${Math.random().toString(36).slice(2, 10)}`;
  let socket: WebSocket;
  try {
    socket = new WebSocket(options.url, ["mqtt"]);
  } catch (error) {
    options.onStatus("error", error instanceof Error ? error.message : String(error));
    return { close() {} };
  }
  socket.binaryType = "arraybuffer";
  let buffer: Uint8Array = new Uint8Array(0);
  let ping: ReturnType<typeof setInterval> | null = null;
  let closedByUs = false;
  options.onStatus("connecting");

  socket.onopen = () => socket.send(connectPacket(clientId, keepalive, options.username, options.password));
  socket.onmessage = (event) => {
    const chunk = new Uint8Array(event.data as ArrayBuffer);
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    const { packets, rest } = parsePackets(merged);
    buffer = rest;
    for (const p of packets) {
      if (p.type === 2) {
        const code = p.body[1];
        if (code !== 0) {
          options.onStatus("error", `The broker refused the connection: ${CONNACK_ERRORS[code] ?? `code ${code}`}.`);
          socket.close();
          return;
        }
        options.onStatus("connected");
        if (options.topics.length) socket.send(subscribePacket(1, options.topics));
        ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(new Uint8Array([0xc0, 0])), keepalive * 1000);
      } else if (p.type === 3) {
        const message = readPublish(p);
        if (message.qos === 1) socket.send(new Uint8Array([0x40, 2, message.id >> 8, message.id & 0xff]));
        else if (message.qos === 2) socket.send(new Uint8Array([0x50, 2, message.id >> 8, message.id & 0xff]));
        options.onMessage(message.topic, message.payload);
      } else if (p.type === 6) {
        // PUBREL for a QoS 2 message: complete it.
        socket.send(new Uint8Array([0x70, 2, p.body[0], p.body[1]]));
      } else if (p.type === 9) {
        if ([...p.body.subarray(2)].some((code) => code === 0x80)) options.onStatus("error", "The broker refused a subscription (check the topic filters and permissions).");
      }
    }
  };
  socket.onerror = () => options.onStatus("error", "The broker could not be reached (address, port, wss certificate, or the broker's WebSocket listener).");
  socket.onclose = () => {
    if (ping) clearInterval(ping);
    options.onStatus("closed", closedByUs ? undefined : "The connection closed.");
  };
  return {
    close() {
      closedByUs = true;
      if (ping) clearInterval(ping);
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(new Uint8Array([0xe0, 0]));
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** A reading from a message: JSON at a path ("value", "data.temp"), or the text itself. */
export function readPayload(payload: Uint8Array, valuePath: string, timePath: string, arrived: number): { value: number | string; t: number } | null {
  const text = decoder.decode(payload).trim();
  if (!text) return null;
  const asValue = (v: unknown): number | string | null => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") {
      const n = Number(v);
      return v.trim() !== "" && Number.isFinite(n) ? n : v.trim();
    }
    return null;
  };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { value: asValue(text) ?? text, t: arrived };
  }
  const at = (obj: unknown, path: string): unknown => {
    if (!path) return undefined;
    let cur: unknown = obj;
    for (const key of path.split(".")) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur;
  };
  const raw = typeof json === "object" && json !== null ? at(json, valuePath || "value") : json;
  const value = asValue(raw);
  if (value === null) return null;
  let t = arrived;
  const time = typeof json === "object" ? at(json, timePath) : undefined;
  if (typeof time === "number") t = time < 1e12 ? time * 1000 : time;
  else if (typeof time === "string" && !Number.isNaN(Date.parse(time))) t = Date.parse(time);
  return { value, t };
}
