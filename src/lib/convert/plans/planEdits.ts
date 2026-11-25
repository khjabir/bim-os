// Changes to a plan asked for in plain words ("make the external walls
// 300 mm", "the door between the kitchen and the dining room slides"). The
// on-device assistant turns the request into changes from a fixed list; this
// module finds what each change applies to (the selection, the walls of a
// room, the doors between two rooms, external walls...), says in plain words
// what will change, and applies it. Nothing is applied before the user sees
// the list.

import type { JsonTask } from "@/lib/ondevice/types";
import type { PlanItem, PlanOpeningItem } from "../store";
import { normaliseName, ROOM_TYPES, roomType, roomTypeFromName } from "./roomTypes";

export const EDIT_ACTIONS = [
  "wall_thickness",
  "wall_height",
  "room_height",
  "floor_level",
  "storey_name",
  "slab_thickness",
  "door_height",
  "window_sill",
  "window_height",
  "rename",
  "renumber",
  "room_type",
  "door_type",
  "flip_doors",
  "make",
  "delete",
  "unsupported",
] as const;
export type EditAction = (typeof EDIT_ACTIONS)[number];

export const EDIT_KINDS = ["walls", "doors", "windows", "openings", "rooms", "columns", "slab", "plan"] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

export const EDIT_SCOPES = ["selected", "all", "external", "internal", "room", "between", "type"] as const;
export type EditScope = (typeof EDIT_SCOPES)[number];

export interface EditOp {
  action: EditAction;
  kind: EditKind;
  scope: EditScope;
  room: string | null;
  room2: string | null;
  number: number | null;
  unit: "mm" | "cm" | "m" | "none";
  text: string | null;
}

export type Selection = { kind: "wall" | "opening" | "room" | "column"; index: number } | null;

// ---------------------------------------------------------------------------
// The assistant's part

// Worked examples, given to the model as earlier turns of the conversation.
const EXAMPLE_ROOMS = "2.01 LOBBY; 2.02 MEETING; 2.03 OFFICE; 2.04 STORE; 2.05 WC; 2.06 CORRIDOR";
const EXAMPLES: [string, string, Partial<EditOp>[]][] = [
  ["Selected: the room 2.03 OFFICE.", "the internal walls are 120 thick", [{ action: "wall_thickness", kind: "walls", scope: "internal", number: 120, unit: "none" }]],
  ["Nothing is selected.", "make the external walls 300 mm and the floor to floor height 3.5 m", [{ action: "wall_thickness", kind: "walls", scope: "external", number: 300, unit: "mm" }, { action: "wall_height", kind: "plan", scope: "all", number: 3.5, unit: "m" }]],
  ["Selected: the room 2.03 OFFICE.", "walls around the meeting room should be 150", [{ action: "wall_thickness", kind: "walls", scope: "room", room: "meeting", number: 150, unit: "none" }]],
  ["Selected: a wall 100 mm thick.", "this wall is 20 cm", [{ action: "wall_thickness", kind: "walls", scope: "selected", number: 20, unit: "cm" }]],
  ["Selected: the room 2.03 OFFICE.", "make this a meeting room", [{ action: "room_type", kind: "rooms", scope: "selected", text: "meeting" }]],
  ["Nothing is selected.", "rename 2.04 to Archive", [{ action: "rename", kind: "rooms", scope: "room", room: "2.04", text: "Archive" }]],
  ["Nothing is selected.", "the door between the lobby and the office slides", [{ action: "door_type", kind: "doors", scope: "between", room: "lobby", room2: "office", text: "sliding" }]],
  ["Nothing is selected.", "all the WCs are accessible toilets", [{ action: "room_type", kind: "rooms", scope: "type", room: "toilet", text: "accessible_toilet" }]],
  ["Selected: a window 1200 mm wide.", "delete it", [{ action: "delete", kind: "windows", scope: "selected" }]],
  ["Selected: the room 2.03 OFFICE.", "delete room 2.05", [{ action: "delete", kind: "rooms", scope: "room", room: "2.05" }]],
  ["Nothing is selected.", "the doors of the lobby are double doors", [{ action: "door_type", kind: "doors", scope: "room", room: "lobby", text: "double" }]],
  ["Nothing is selected.", "sills at 850 and windows 1.4 m tall", [{ action: "window_sill", kind: "windows", scope: "all", number: 850, unit: "none" }, { action: "window_height", kind: "windows", scope: "all", number: 1.4, unit: "m" }]],
  ["Selected: the room 2.01 LOBBY.", "this floor is the ground floor, storey height 4 m", [{ action: "storey_name", kind: "plan", scope: "all", text: "Ground floor" }, { action: "wall_height", kind: "plan", scope: "all", number: 4, unit: "m" }]],
  ["Nothing is selected.", "ceiling height 2700, no slab", [{ action: "room_height", kind: "rooms", scope: "all", number: 2700, unit: "none" }, { action: "delete", kind: "slab", scope: "all" }]],
  ["Nothing is selected.", "turn the openings of the corridor into doors", [{ action: "make", kind: "openings", scope: "room", room: "corridor", text: "door" }]],
  ["Nothing is selected.", "add a lift next to the lobby", [{ action: "unsupported", kind: "plan", scope: "all", text: "adding a lift" }]],
  ["Selected: the room 2.05 WC.", "floor level +3.2", [{ action: "floor_level", kind: "plan", scope: "all", number: 3.2, unit: "m" }]],
  ["Selected: a door 900 mm wide.", "doors 2.4 m high", [{ action: "door_height", kind: "doors", scope: "all", number: 2.4, unit: "m" }]],
];

const full = (p: Partial<EditOp>): EditOp => {
  const o: EditOp = { action: "unsupported", kind: "plan", scope: "all", room: null, room2: null, number: null, unit: "none", text: null, ...p };
  // The order the schema asks for them in.
  return { action: o.action, number: o.number, unit: o.unit, kind: o.kind, scope: o.scope, room: o.room, room2: o.room2, text: o.text };
};

export interface EditContext {
  selection: string;
  rooms: string[];
  values: string;
}

/** What the request is about, in words: the selection, the rooms (names and numbers) and the plan's current values. */
export function editContext(plan: PlanItem, sel: Selection, mpp: number): EditContext {
  const mm = (px: number) => Math.round(px * mpp * 1000);
  let selection = "Nothing is selected.";
  if (sel?.kind === "wall" && plan.walls[sel.index]) selection = `Selected: a wall ${mm(plan.walls[sel.index].thickness)} mm thick.`;
  else if (sel?.kind === "opening" && plan.openings[sel.index]) {
    const o = plan.openings[sel.index];
    selection = `Selected: a ${o.kind === "opening" ? "plain opening" : o.kind} ${mm(Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]))} mm wide.`;
  } else if (sel?.kind === "room" && plan.rooms[sel.index]) selection = `Selected: the room ${roomName(plan.rooms[sel.index], sel.index)}.`;
  else if (sel?.kind === "column") selection = "Selected: a column.";
  const rooms = plan.rooms.slice(0, 60).map((r, i) => roomName(r, i));
  const thick = plan.walls.map((w) => mm(w.thickness)).sort((a, b) => a - b);
  const values = [
    `walls ${thick.length ? `${thick[0]}–${thick[thick.length - 1]} mm thick` : "none"}`,
    `wall height ${plan.storey.height} m`,
    `floor level ${plan.storey.elevation} m`,
    `slab ${plan.withSlab ? `${plan.slabThickness} m` : "none"}`,
    `doors ${plan.sizes.doorHeight} m high`,
    `window sills ${plan.sizes.windowSill} m, windows ${plan.sizes.windowHeight} m high`,
  ].join("; ");
  return { selection, rooms, values };
}

const contextText = (selection: string, rooms: string, values: string | null, request: string) => [selection, `Rooms: ${rooms}.`, ...(values ? [`Now: ${values}.`] : []), `Request: ${request}`].join("\n");

export function editsTask(request: string, context: EditContext): JsonTask {
  const system = [
    "You turn a request to change a building floor plan into a list of changes, as JSON on one line. Each change has these fields.",
    "action: wall_thickness | wall_height (the walls' height: the storey height, floor to floor height) | room_height (ceiling height) | floor_level (the floor's elevation) | storey_name | slab_thickness | door_height | window_sill | window_height | rename (a room's name) | renumber (a room's number) | room_type | door_type (single, double, sliding, folding, revolving, double_swing, rolling) | flip_doors (open to the other side) | make (turn doors, windows or openings into a door, window or opening) | delete | unsupported (anything else; say what in text).",
    "kind: what the change applies to: walls | doors | windows | openings | rooms | columns | slab | plan.",
    "scope: which of them: selected (only when the user says this, it or selected) | all | external | internal | room (those of the room in room, or that room itself) | between (those between room and room2) | type (rooms whose type is room).",
    "number and unit: the value the user gives (unit none when the user gives no unit), else null and none. room, room2: a room's name or number as the user says it, else null. text: a new name or number, a room type id, a door type, else null.",
    "Only list the changes the request asks for.",
    `Room type ids: ${ROOM_TYPES.map((r) => r.id).join(", ")}.`,
  ].join("\n");
  const examples = EXAMPLES.map(([selection, q, ops]) => ({ user: contextText(selection, EXAMPLE_ROOMS, null, q), answer: JSON.stringify({ changes: ops.map(full) }) }));
  const user = contextText(context.selection, context.rooms.length ? context.rooms.join("; ") : "none", null, request.trim());
  return {
    label: "Working out the changes",
    system,
    examples,
    user,
    schema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: [...EDIT_ACTIONS] },
              number: { type: ["number", "null"] },
              unit: { type: "string", enum: ["mm", "cm", "m", "none"] },
              kind: { type: "string", enum: [...EDIT_KINDS] },
              scope: { type: "string", enum: [...EDIT_SCOPES] },
              room: { type: ["string", "null"] },
              room2: { type: ["string", "null"] },
              text: { type: ["string", "null"] },
            },
            required: ["action", "number", "unit", "kind", "scope", "room", "room2", "text"],
            additionalProperties: false,
          },
        },
      },
      required: ["changes"],
      additionalProperties: false,
    },
    maxTokens: 400,
  };
}

const ACTIONS = new Set<string>(EDIT_ACTIONS);
const KINDS = new Set<string>(EDIT_KINDS);
const SCOPES = new Set<string>(EDIT_SCOPES);

/** The assistant's changes, with anything malformed left out. */
export function readEdits(answer: unknown): EditOp[] {
  const list = (answer as { changes?: unknown })?.changes;
  if (!Array.isArray(list)) return [];
  const out: EditOp[] = [];
  for (const c of list.slice(0, 12)) {
    const o = c as Record<string, unknown>;
    const action = String(o.action ?? "");
    if (!ACTIONS.has(action)) continue;
    const kind = KINDS.has(String(o.kind)) ? (String(o.kind) as EditKind) : "plan";
    const scope = SCOPES.has(String(o.scope)) ? (String(o.scope) as EditScope) : "all";
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);
    const n = typeof o.number === "number" && Number.isFinite(o.number) ? o.number : null;
    const unit = ["mm", "cm", "m"].includes(String(o.unit)) ? (String(o.unit) as EditOp["unit"]) : "none";
    const op: EditOp = { action: action as EditAction, kind, scope, room: str(o.room), room2: scope === "between" ? str(o.room2) : null, number: n, unit, text: str(o.text) };
    // The same change twice (small models repeat themselves) is one change.
    const key = (x: EditOp) => [x.action, x.kind, x.scope, x.room?.toLowerCase(), x.room2?.toLowerCase(), x.number, x.unit, x.text?.toLowerCase()].join("|");
    if (!out.some((x) => key(x) === key(op))) out.push(op);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What each change applies to

type Pt = [number, number];

export function roomName(r: PlanItem["rooms"][number], i: number): string {
  return [r.number, r.name].filter(Boolean).join(" ") || `room ${i + 1}`;
}

const STOP = new Set(["the", "a", "an", "room", "rooms", "space", "area", "of", "in", "no", "number", "nr", "this", "that", "le", "la", "der", "die", "das", "el"]);

const tokens = (s: string) =>
  normaliseName(s)
    .split(" ")
    .filter((w) => w && !STOP.has(w));

/** Rooms a name or number refers to: an exact number or name first, then names holding all its words, then rooms of the type the words name. */
export function findRooms(plan: PlanItem, ref: string | null): number[] {
  if (!ref) return [];
  const want = tokens(ref);
  if (!want.length) return [];
  const joined = want.join(" ");
  const score = plan.rooms.map((r) => {
    const num = r.number ? normaliseName(r.number) : "";
    const name = r.name ? normaliseName(r.name) : "";
    const words = new Set([...tokens(r.name ?? ""), ...tokens(r.number ?? "")]);
    if (num && (num === joined || num.replace(/ /g, "") === joined.replace(/ /g, ""))) return 4;
    if (name && name === joined) return 3;
    if (want.every((w) => words.has(w) || [...words].some((x) => x.startsWith(w) && w.length >= 3))) return 2;
    const t = roomTypeFromName(ref) ?? (roomType(joined.replace(/ /g, "_")) ? joined.replace(/ /g, "_") : null);
    if (t && (r.type === t || roomTypeFromName(r.name) === t)) return 1;
    return 0;
  });
  const best = Math.max(0, ...score);
  return best ? score.flatMap((s, i) => (s === best ? [i] : [])) : [];
}

function segDistance(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function ringDistance(p: Pt, ring: Pt[]) {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, segDistance(p, ring[i], ring[(i + 1) % ring.length]));
  return d;
}

/** How much of a wall (metres) runs along all the given outlines, within its half thickness. */
function alongLength(w: PlanItem["walls"][number], rings: Pt[][], mpp: number): number {
  const tol = Math.max(3, 0.08 / mpp);
  const N = 20;
  let near = 0;
  for (let k = 0; k <= N; k++) {
    const p: Pt = [w.a[0] + ((w.b[0] - w.a[0]) * k) / N, w.a[1] + ((w.b[1] - w.a[1]) * k) / N];
    if (rings.every((ring) => ringDistance(p, ring) <= w.thickness / 2 + tol)) near++;
  }
  return near >= 2 ? (near / (N + 1)) * Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) * mpp : 0;
}

/** Walls along a room's outline (at least 0.4 m of them; long walls shared by several rooms count for each). */
function wallsOf(plan: PlanItem, room: number, mpp: number): number[] {
  const ring = plan.rooms[room]?.outline;
  if (!ring) return [];
  return plan.walls.flatMap((w, i) => (alongLength(w, [ring], mpp) >= 0.4 ? [i] : []));
}

/** Walls between two rooms: along both outlines at once. */
function wallsBetween(plan: PlanItem, a: number, b: number, mpp: number): number[] {
  const ra = plan.rooms[a]?.outline,
    rb = plan.rooms[b]?.outline;
  if (!ra || !rb) return [];
  return plan.walls.flatMap((w, i) => (alongLength(w, [ra, rb], mpp) >= 0.3 ? [i] : []));
}

const mid = (o: { a: Pt; b: Pt }): Pt => [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];

function openingNear(plan: PlanItem, o: PlanOpeningItem, ring: Pt[], mpp: number) {
  const t = Math.max(...plan.walls.map((w) => w.thickness), 0.3 / mpp);
  return ringDistance(mid(o), ring) <= Math.min(t, 0.6 / mpp) / 2 + Math.max(3, 0.12 / mpp);
}

function onOutline(plan: PlanItem, a: Pt, b: Pt, t: number) {
  const ring = plan.outline;
  if (ring.length < 3) return false;
  return ringDistance(mid({ a, b }), ring) < Math.max(2, t);
}

/** Doors and windows of a room (in the walls along its outline). */
export function openingsOfRoom(plan: PlanItem, room: number, mpp: number): { doors: number; windows: number } {
  const ring = plan.rooms[room]?.outline;
  let doors = 0,
    windows = 0;
  if (!ring) return { doors, windows };
  for (const o of plan.openings) {
    if (!openingNear(plan, o, ring, mpp)) continue;
    if (o.kind === "door") doors++;
    else if (o.kind === "window") windows++;
  }
  return { doors, windows };
}

const KIND_OF: Partial<Record<EditKind, PlanOpeningItem["kind"]>> = { doors: "door", windows: "window", openings: "opening" };

interface Targets {
  indices: number[];
  /** How they were found, in words ("the walls of CORRIDOR"). */
  what: string;
  problem?: string;
}

function targets(plan: PlanItem, op: EditOp, sel: Selection, mpp: number): Targets {
  const kind = op.kind;
  const roomsFor = (ref: string | null) => findRooms(plan, ref);
  const ofType = (ref: string | null): number[] | null => {
    const t = toTypeId(ref);
    return t ? plan.rooms.flatMap((r, i) => ((r.type ?? roomTypeFromName(r.name)) === t ? [i] : [])) : null;
  };
  const names = (ids: number[]) => ids.map((i) => roomName(plan.rooms[i], i)).join(", ");
  const label = kind === "openings" ? "openings" : kind;
  if (kind === "walls") {
    const all = plan.walls.map((_, i) => i);
    switch (op.scope) {
      case "selected":
        return sel?.kind === "wall" ? { indices: [sel.index], what: "the selected wall" } : { indices: [], what: "", problem: "No wall is selected." };
      case "external":
      case "internal": {
        const ext = all.filter((i) => onOutline(plan, plan.walls[i].a, plan.walls[i].b, plan.walls[i].thickness));
        if (!plan.outline.length) return { indices: [], what: "", problem: "The plan has no outline yet, so external walls are not known." };
        return op.scope === "external" ? { indices: ext, what: "external walls" } : { indices: all.filter((i) => !ext.includes(i)), what: "internal walls" };
      }
      case "room": {
        const rooms = roomsFor(op.room);
        if (!rooms.length) return { indices: [], what: "", problem: `No room called “${op.room ?? ""}”.` };
        return { indices: [...new Set(rooms.flatMap((r) => wallsOf(plan, r, mpp)))], what: `walls of ${names(rooms)}` };
      }
      case "between": {
        const a = roomsFor(op.room),
          b = roomsFor(op.room2);
        if (!a.length || !b.length) return { indices: [], what: "", problem: `No room called “${!a.length ? op.room : op.room2}”.` };
        return { indices: [...new Set(a.flatMap((ra) => b.flatMap((rb) => (ra === rb ? [] : wallsBetween(plan, ra, rb, mpp)))))], what: `walls between ${names(a)} and ${names(b)}` };
      }
      case "type": {
        const rooms = ofType(op.room);
        if (!rooms) return { indices: [], what: "", problem: `“${op.room ?? ""}” is not a room type.` };
        return { indices: [...new Set(rooms.flatMap((r) => wallsOf(plan, r, mpp)))], what: `walls of the ${roomType(toTypeId(op.room))!.label.toLowerCase()} rooms` };
      }
      default:
        return { indices: all, what: "all walls" };
    }
  }
  if (kind === "doors" || kind === "windows" || kind === "openings") {
    const want = KIND_OF[kind]!;
    const all = plan.openings.flatMap((o, i) => (o.kind === want ? [i] : []));
    switch (op.scope) {
      case "selected":
        return sel?.kind === "opening" && plan.openings[sel.index] ? { indices: [sel.index], what: `the selected ${plan.openings[sel.index].kind}` } : { indices: [], what: "", problem: `No ${want} is selected.` };
      case "external":
      case "internal": {
        const t = plan.walls.length ? Math.max(...plan.walls.map((w) => w.thickness)) : 4;
        const ext = all.filter((i) => onOutline(plan, plan.openings[i].a, plan.openings[i].b, t));
        return op.scope === "external" ? { indices: ext, what: `${label} in external walls` } : { indices: all.filter((i) => !ext.includes(i)), what: `${label} in internal walls` };
      }
      case "room": {
        const rooms = roomsFor(op.room);
        if (!rooms.length) return { indices: [], what: "", problem: `No room called “${op.room ?? ""}”.` };
        return { indices: all.filter((i) => rooms.some((r) => openingNear(plan, plan.openings[i], plan.rooms[r].outline, mpp))), what: `${label} of ${names(rooms)}` };
      }
      case "between": {
        const a = roomsFor(op.room),
          b = roomsFor(op.room2);
        if (!a.length || !b.length) return { indices: [], what: "", problem: `No room called “${!a.length ? op.room : op.room2}”.` };
        return {
          indices: all.filter((i) => a.some((r) => openingNear(plan, plan.openings[i], plan.rooms[r].outline, mpp)) && b.some((r) => openingNear(plan, plan.openings[i], plan.rooms[r].outline, mpp))),
          what: `${label} between ${names(a)} and ${names(b)}`,
        };
      }
      case "type": {
        const rooms = ofType(op.room);
        if (!rooms) return { indices: [], what: "", problem: `“${op.room ?? ""}” is not a room type.` };
        return { indices: all.filter((i) => rooms.some((r) => openingNear(plan, plan.openings[i], plan.rooms[r].outline, mpp))), what: `${label} of the ${roomType(toTypeId(op.room))!.label.toLowerCase()} rooms` };
      }
      default:
        return { indices: all, what: `all ${label}` };
    }
  }
  if (kind === "rooms") {
    const all = plan.rooms.map((_, i) => i);
    switch (op.scope) {
      case "selected":
        return sel?.kind === "room" && plan.rooms[sel.index] ? { indices: [sel.index], what: roomName(plan.rooms[sel.index], sel.index) } : { indices: [], what: "", problem: "No room is selected." };
      case "type": {
        const t = toTypeId(op.room);
        if (!t) return { indices: [], what: "", problem: `“${op.room ?? ""}” is not a room type.` };
        const ids = all.filter((i) => (plan.rooms[i].type ?? roomTypeFromName(plan.rooms[i].name)) === t);
        return { indices: ids, what: `${roomType(t)!.label.toLowerCase()} rooms` };
      }
      case "room":
      case "between": {
        const rooms = roomsFor(op.room);
        if (!rooms.length) return { indices: [], what: "", problem: `No room called “${op.room ?? ""}”.` };
        return { indices: rooms, what: names(rooms) };
      }
      default:
        return { indices: all, what: "all rooms" };
    }
  }
  if (kind === "columns") {
    if (op.scope === "selected") return sel?.kind === "column" ? { indices: [sel.index], what: "the selected column" } : { indices: [], what: "", problem: "No column is selected." };
    return { indices: plan.columns.map((_, i) => i), what: "all columns" };
  }
  return { indices: [], what: "the plan" };
}

/** A room type id from words ("WCs", "meeting room", "accessible_toilet"). */
export function toTypeId(text: string | null): string | null {
  if (!text) return null;
  const id = normaliseName(text).replace(/ /g, "_");
  if (roomType(id)) return id;
  const byLabel = ROOM_TYPES.find((r) => normaliseName(r.label) === normaliseName(text) || normaliseName(r.label).split(" ").includes(normaliseName(text)));
  if (byLabel) return byLabel.id;
  // Plurals ("WCs", "offices").
  return roomTypeFromName(text) ?? roomTypeFromName(text.replace(/s\b/gi, ""));
}

/** Door operation (IfcDoorTypeOperationEnum) for words; the hand of single doors is kept. */
export function doorOperation(text: string | null, current: string | null, widthM: number): string | null {
  const t = normaliseName(text ?? "");
  const hand = /RIGHT/.test(current ?? "") ? "RIGHT" : "LEFT";
  if (/revolv/.test(t)) return "REVOLVING";
  if (/roll|shutter|roller/.test(t)) return "ROLLINGUP";
  if (/fold|bi ?fold/.test(t)) return widthM > 1.6 ? "DOUBLE_DOOR_FOLDING" : `FOLDING_TO_${hand}`;
  if (/slid|pocket/.test(t)) return /double|two|pair/.test(t) || widthM > 1.5 ? "DOUBLE_DOOR_SLIDING" : `SLIDING_TO_${hand}`;
  if (/double.?swing|both ways|swing both|saloon/.test(t)) return /double door|pair|two/.test(t) ? "DOUBLE_DOOR_DOUBLE_SWING" : `DOUBLE_SWING_${hand}`;
  if (/double|pair|two leaf|2 leaf|leaf and a half/.test(t)) return "DOUBLE_DOOR_SINGLE_SWING";
  if (/single|one leaf|normal|hinged|swing/.test(t)) return `SINGLE_SWING_${hand}`;
  return null;
}

const DOOR_WORDS: Record<string, string> = {
  REVOLVING: "revolving",
  ROLLINGUP: "rolling shutter",
  DOUBLE_DOOR_FOLDING: "double folding",
  FOLDING_TO_LEFT: "folding",
  FOLDING_TO_RIGHT: "folding",
  DOUBLE_DOOR_SLIDING: "double sliding",
  SLIDING_TO_LEFT: "sliding",
  SLIDING_TO_RIGHT: "sliding",
  DOUBLE_DOOR_DOUBLE_SWING: "double, swinging both ways",
  DOUBLE_SWING_LEFT: "swinging both ways",
  DOUBLE_SWING_RIGHT: "swinging both ways",
  DOUBLE_DOOR_SINGLE_SWING: "double",
  SINGLE_SWING_LEFT: "single",
  SINGLE_SWING_RIGHT: "single",
};

// ---------------------------------------------------------------------------
// Steps: what will change, and the change itself

export interface EditStep {
  op: EditOp;
  /** In plain words; null when nothing can be done (see problem). */
  summary: string | null;
  problem: string | null;
  count: number;
  apply: ((plan: PlanItem) => Partial<PlanItem>) | null;
}

const LIMITS: Partial<Record<EditAction, [number, number]>> = {
  wall_thickness: [0.03, 1.5],
  wall_height: [1, 20],
  room_height: [1.5, 15],
  floor_level: [-50, 500],
  slab_thickness: [0.05, 1.5],
  door_height: [1.5, 5],
  window_sill: [0, 3],
  window_height: [0.2, 5],
};

/** The value in metres; without a unit, numbers from 20 up are millimetres. */
function metres(op: EditOp): number | null {
  if (op.number === null) return null;
  if (op.unit === "mm") return op.number / 1000;
  if (op.unit === "cm") return op.number / 100;
  if (op.unit === "m") return op.number;
  if (op.action === "floor_level") return Math.abs(op.number) >= 500 && Number.isInteger(op.number) ? op.number / 1000 : op.number;
  return Math.abs(op.number) >= 20 ? op.number / 1000 : op.number;
}

const fmt = (m: number) => (Math.abs(m) < 1 ? `${Math.round(m * 1000)} mm` : `${Math.round(m * 1000) / 1000} m`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function planSteps(plan: PlanItem, ops: EditOp[], sel: Selection, mpp: number): EditStep[] {
  return ops.map((op) => step(plan, op, sel, mpp));
}

function step(plan: PlanItem, given: EditOp, sel: Selection, mpp: number): EditStep {
  // "Selected" with another room named: the user named it, so it is that room.
  let op = given;
  if (op.scope === "selected" && op.room) {
    const named = findRooms(plan, op.room);
    if (named.length && !(sel?.kind === "room" && named.includes(sel.index))) op = { ...op, scope: "room" };
  }
  const none = (problem: string): EditStep => ({ op, summary: null, problem, count: 0, apply: null });
  if (op.action === "unsupported") return none(`Not something the assistant can change${op.text ? `: ${op.text}` : ""}.`);
  const range = LIMITS[op.action];
  const value = range ? metres(op) : null;
  if (range && (value === null || value < range[0] || value > range[1])) return none(value === null ? "No value was given." : `${fmt(value)} is outside what a ${op.action.replace(/_/g, " ")} can be.`);
  const v = value as number;
  switch (op.action) {
    case "wall_height":
      return { op, summary: `Walls ${fmt(v)} high (now ${fmt(plan.storey.height)})`, problem: null, count: 1, apply: (p) => ({ storey: { ...p.storey, height: v } }) };
    case "room_height":
      return { op, summary: `Rooms ${fmt(v)} high to the ceiling`, problem: null, count: 1, apply: () => ({ roomHeight: v }) };
    case "floor_level":
      return { op, summary: `Floor level ${v >= 0 ? "+" : ""}${Math.round(v * 1000) / 1000} m (now ${plan.storey.elevation} m)`, problem: null, count: 1, apply: (p) => ({ storey: { ...p.storey, elevation: v } }) };
    case "storey_name":
      return op.text ? { op, summary: `Storey named “${op.text}”`, problem: null, count: 1, apply: (p) => ({ storey: { ...p.storey, name: op.text! } }) } : none("No name was given.");
    case "slab_thickness":
      return { op, summary: `Slab ${fmt(v)} thick${plan.withSlab ? "" : " (and the slab turned on)"}`, problem: null, count: 1, apply: () => ({ slabThickness: v, withSlab: true }) };
    case "door_height":
      return { op, summary: `Doors ${fmt(v)} high (now ${fmt(plan.sizes.doorHeight)})`, problem: null, count: 1, apply: (p) => ({ sizes: { ...p.sizes, doorHeight: v } }) };
    case "window_sill":
      return { op, summary: `Window sills at ${fmt(v)} (now ${fmt(plan.sizes.windowSill)})`, problem: null, count: 1, apply: (p) => ({ sizes: { ...p.sizes, windowSill: v } }) };
    case "window_height":
      return { op, summary: `Windows ${fmt(v)} high (now ${fmt(plan.sizes.windowHeight)})`, problem: null, count: 1, apply: (p) => ({ sizes: { ...p.sizes, windowHeight: v } }) };
    default:
      break;
  }
  if (op.action === "delete" && op.kind === "slab") return plan.withSlab ? { op, summary: "No floor slab", problem: null, count: 1, apply: () => ({ withSlab: false }) } : none("The plan has no slab.");
  if (op.kind === "plan" || op.kind === "slab") return none("That change needs walls, doors, windows, rooms or columns to apply to.");
  const found = targets(plan, op, sel, mpp);
  if (found.problem) return none(found.problem);
  const ids = new Set(found.indices);
  if (!ids.size) return none(`Nothing found: ${found.what || op.kind}.`);
  const n = ids.size;
  switch (op.action) {
    case "wall_thickness": {
      if (op.kind !== "walls") return none("Only walls have a thickness.");
      const now = [...ids].map((i) => Math.round(plan.walls[i].thickness * mpp * 1000)).sort((a, b) => a - b);
      const was = now[0] === now[now.length - 1] ? `${now[0]} mm` : `${now[0]}–${now[now.length - 1]} mm`;
      return { op, summary: `${capital(found.what)}: ${plural(n, "wall")} ${fmt(v)} thick (now ${was})`, problem: null, count: n, apply: (p) => ({ walls: p.walls.map((w, i) => (ids.has(i) ? { ...w, thickness: v / mpp } : w)) }) };
    }
    case "delete": {
      const what = op.kind === "walls" ? plural(n, "wall") : op.kind === "rooms" ? plural(n, "room") : op.kind === "columns" ? plural(n, "column") : plural(n, KIND_OF[op.kind]!);
      const drop = <T,>(list: T[]) => list.filter((_, i) => !ids.has(i));
      return {
        op,
        summary: `Delete ${what} (${found.what})`,
        problem: null,
        count: n,
        apply: (p) => (op.kind === "walls" ? { walls: drop(p.walls) } : op.kind === "rooms" ? { rooms: drop(p.rooms) } : op.kind === "columns" ? { columns: drop(p.columns) } : { openings: drop(p.openings) }),
      };
    }
    case "rename":
    case "renumber": {
      if (op.kind !== "rooms") return none("Only rooms have names and numbers here.");
      if (!op.text) return none("No new name was given.");
      if (n > 1 && op.action === "renumber") return none(`${n} rooms match; select the one to renumber.`);
      const field = op.action === "rename" ? "name" : "number";
      return {
        op,
        summary: `${capital(found.what)} ${op.action === "rename" ? "named" : "numbered"} “${op.text}”`,
        problem: null,
        count: n,
        apply: (p) => ({ rooms: p.rooms.map((r, i) => (ids.has(i) ? { ...r, [field]: op.text, ...(field === "name" ? { type: roomTypeFromName(op.text) ?? r.type ?? null, typeSource: roomTypeFromName(op.text) ? "name" : (r.typeSource ?? null) } : {}) } : r)) }),
      };
    }
    case "room_type": {
      if (op.kind !== "rooms") return none("Only rooms have a type.");
      const t = toTypeId(op.text);
      if (!t) return none(`“${op.text ?? ""}” is not a room type.`);
      return { op, summary: `${capital(found.what)}: ${plural(n, "room")} typed ${roomType(t)!.label}`, problem: null, count: n, apply: (p) => ({ rooms: p.rooms.map((r, i) => (ids.has(i) ? { ...r, type: t, typeSource: "user" as const } : r)) }) };
    }
    case "door_type": {
      if (op.kind !== "doors") return none("Only doors have a type.");
      const ops = [...ids].map((i) => doorOperation(op.text, plan.openings[i].operation, Math.hypot(plan.openings[i].b[0] - plan.openings[i].a[0], plan.openings[i].b[1] - plan.openings[i].a[1]) * mpp));
      if (ops.some((o) => !o)) return none(`“${op.text ?? ""}” is not a door type the model knows (single, double, sliding, folding, revolving, rolling).`);
      const byIndex = new Map([...ids].map((i, k) => [i, ops[k]!]));
      return { op, summary: `${capital(found.what)}: ${plural(n, "door")} ${DOOR_WORDS[ops[0]!] ?? ops[0]!.toLowerCase()}`, problem: null, count: n, apply: (p) => ({ openings: p.openings.map((o, i) => (byIndex.has(i) ? { ...o, operation: byIndex.get(i)! } : o)) }) };
    }
    case "flip_doors":
      if (op.kind !== "doors") return none("Only doors open to a side.");
      return {
        op,
        summary: `${capital(found.what)}: ${plural(n, "door")} opening to the other side`,
        problem: null,
        count: n,
        apply: (p) => ({ openings: p.openings.map((o, i) => (ids.has(i) && o.swing ? { ...o, swing: [-o.swing[0], -o.swing[1]] as Pt, operation: o.operation?.replace(/LEFT|RIGHT/, (m) => (m === "LEFT" ? "RIGHT" : "LEFT")) ?? o.operation } : o)) }),
      };
    case "make": {
      if (!KIND_OF[op.kind]) return none("Only doors, windows and openings can be turned into each other.");
      const to = /window/i.test(op.text ?? "") ? "window" : /door/i.test(op.text ?? "") ? "door" : /open|gap|nothing/i.test(op.text ?? "") ? "opening" : null;
      if (!to) return none(`“${op.text ?? ""}”: say door, window or opening.`);
      return {
        op,
        summary: `${capital(found.what)}: ${plural(n, KIND_OF[op.kind]!)} made ${to === "opening" ? "plain openings" : `${to}s`}`,
        problem: null,
        count: n,
        apply: (p) => ({
          openings: p.openings.map((o, i) => {
            if (!ids.has(i)) return o;
            const L = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) || 1;
            return { ...o, kind: to, operation: to === "door" ? (o.operation ?? "SINGLE_SWING_LEFT") : null, swing: to === "door" ? (o.swing ?? ([(o.b[1] - o.a[1]) / L, -(o.b[0] - o.a[0]) / L] as Pt)) : o.swing };
          }),
        }),
      };
    }
    default:
      return none("That change is not known.");
  }
}

const capital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The parts of a plan the changes touch, to undo them. */
export function snapshot(plan: PlanItem): Partial<PlanItem> {
  return { walls: plan.walls, openings: plan.openings, rooms: plan.rooms, columns: plan.columns, storey: plan.storey, slabThickness: plan.slabThickness, withSlab: plan.withSlab, sizes: plan.sizes, roomHeight: plan.roomHeight ?? null };
}

/** Applies the steps that can be applied, one after the other. */
export function applySteps(plan: PlanItem, steps: EditStep[]): Partial<PlanItem> {
  let next = plan;
  const patch: Partial<PlanItem> = {};
  for (const s of steps) {
    if (!s.apply) continue;
    const p = s.apply(next);
    Object.assign(patch, p);
    next = { ...next, ...p };
  }
  return patch;
}
