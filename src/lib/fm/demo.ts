// A made-up office building to try bim-os without a model: five floors with
// rooms, building services with realistic data gaps, maintenance plans, work
// orders and simulated live points. Every name, maker and number is invented.

import { ASSET_KINDS } from "../convert/assets/kinds";
import { addDays, plansForAssets, todayIso } from "./schedule";
import { DEFAULT_TASKS } from "./tasks";
import type { Asset, Facility, LiveSource, Plan, Point, PointKind, Space, SystemInfo, WorkOrder, WorkspaceData } from "./types";

const KINDS = new Map(ASSET_KINDS.map((k) => [k.code, k]));
const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/** A small deterministic random generator (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEMO_SOURCE_ID = "demo-simulator";

interface Floor {
  key: string;
  name: string;
  code: string;
  rooms: [string, string][];
}

const FLOORS: Floor[] = [
  { key: "B1", name: "Basement", code: "B1", rooms: [["B1.01", "Plant Room"], ["B1.02", "Main Electrical Room"], ["B1.03", "Generator Room"], ["B1.04", "Water Tank Room"], ["B1.05", "Car Park"]] },
  { key: "L00", name: "Ground Floor", code: "L00", rooms: [["G.01", "Reception"], ["G.02", "Cafe"], ["G.03", "Fire Control Room"], ["G.04", "Security Office"], ["G.05", "Washrooms"], ["G.06", "Riser"]] },
  { key: "L01", name: "Level 1", code: "L01", rooms: [["1.01", "Open Office North"], ["1.02", "Open Office South"], ["1.03", "Meeting Room A"], ["1.04", "Comms Room"], ["1.05", "Washrooms"], ["1.06", "Riser"]] },
  { key: "L02", name: "Level 2", code: "L02", rooms: [["2.01", "Open Office North"], ["2.02", "Open Office South"], ["2.03", "Boardroom"], ["2.04", "Comms Room"], ["2.05", "Washrooms"], ["2.06", "Riser"]] },
  { key: "RF", name: "Roof", code: "RF", rooms: [["R.01", "Roof Plant Area"]] },
];

export function demoWorkspace(): WorkspaceData {
  const rnd = random(20261121);
  const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)];
  const today = todayIso();
  const createdAt = new Date().toISOString();
  const facility: Facility = {
    id: "demo-harbour-view",
    name: "Harbour View Offices",
    site: "Harbour Quarter",
    siteCode: "HQ",
    buildingCode: "HVO",
    address: "1 Example Quay (demo data)",
    currency: "USD",
    source: "demo",
    labelBaseUrl: "",
    user: "Demo user",
    woCounter: 0,
    createdAt,
    updatedAt: createdAt,
  };

  const spaces: Space[] = FLOORS.flatMap((f) => f.rooms.map(([number, name]) => ({ id: number, number, name, floor: f.name, area: Math.round(20 + rnd() * 380), department: f.key === "B1" || f.key === "RF" ? "Building services" : "Tenant" })));
  const assets: Asset[] = [];
  const seq = new Map<string, number>();
  let guidCounter = 0;

  const add = (kindCode: string, floor: Floor, room: string, name: string, extra: { family?: string; type?: string; values?: Record<string, string>; systems?: string[]; fedFrom?: string; parent?: string } = {}) => {
    const kind = KINDS.get(kindCode) ?? KINDS.get("AST")!;
    const n = (seq.get(`${floor.code}|${kindCode}`) ?? 0) + 1;
    seq.set(`${floor.code}|${kindCode}`, n);
    let id = "";
    let h = 0x2545f491 + guidCounter++ * 7919;
    for (let i = 0; i < 22; i++) {
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
      id += B64[(h >>> 5) % 64];
    }
    const space = spaces.find((s) => s.id === room);
    const family = extra.family ?? kind.label;
    const type = extra.type ?? "Standard";
    const asset: Asset = {
      id,
      code: `HVO-${floor.code}-${kind.code}-${String(n).padStart(3, "0")}`,
      name,
      tag: name,
      kind: kind.label,
      kindCode: kind.code,
      discipline: kind.discipline,
      category: categoryOf(kind.discipline, kind.code),
      family,
      type,
      typeName: `${family}: ${type}`,
      floor: floor.name,
      space: room,
      roomName: space?.name ?? "",
      locationCode: `HQ-HVO-${floor.code}-${room}`,
      locationPath: ["Harbour Quarter", "Harbour View Offices", floor.name, `${room} ${space?.name ?? ""}`.trim()].join(" > "),
      systems: extra.systems ?? [],
      fedFrom: extra.fedFrom ?? "",
      servedBy: extra.fedFrom ? [extra.fedFrom] : [],
      serves: [],
      parent: extra.parent ?? "",
      children: [],
      compliance: kind.compliance,
      uniclass: kind.uniclass ? `${kind.uniclass[0]} ${kind.uniclass[1]}` : "",
      values: Object.fromEntries(Object.entries(extra.values ?? {}).filter(([, v]) => v)),
      file: "Harbour View demo",
      elementId: String(100000 + guidCounter),
    };
    assets.push(asset);
    return asset;
  };

  const year = new Date().getFullYear();
  const product = (maker: string, model: string, life: number, opts: { serial?: boolean; installed?: number } = {}) => {
    const installed = `${year - (opts.installed ?? 2)}-0${1 + Math.floor(rnd() * 8)}-1${Math.floor(rnd() * 9)}`;
    const values: Record<string, string> = { manufacturer: maker, model, expectedLife: `${life} Years`, installationDate: installed, supplier: "Demo Building Services Ltd" };
    if (opts.serial !== false && rnd() > 0.25) values.serialNumber = `SN-${Math.floor(100000 + rnd() * 899999)}`;
    if (rnd() > 0.3) values.warrantyEndDate = `${Number(installed.slice(0, 4)) + 2}${installed.slice(4)}`;
    return values;
  };

  const [b1, gf, l1, l2, rf] = FLOORS;

  // Electrical distribution
  const tx = add("TX", b1, "B1.02", "TX-01", { family: "Cast Resin Transformer", type: "1000 kVA", values: { ...product("Voltaris", "CRT-1000", 30), connectedLoad: "1000", voltage: "400" } });
  const msb = add("MSB", b1, "B1.02", "MSB-01", { family: "Main Switchboard", type: "Form 4 2500A", fedFrom: tx.name, values: { ...product("Voltaris", "MS-2500", 30), mainsRating: "2500", voltage: "400", phases: "3", distributionSystem: "400/230V 3P4W" } });
  add("GEN", b1, "B1.03", "GEN-01", { family: "Diesel Generator", type: "500 kVA", values: { ...product("PowerCore", "DG-500", 25), connectedLoad: "500" } });
  add("UPS", b1, "B1.02", "UPS-01", { family: "UPS", type: "60 kVA", fedFrom: msb.name, values: { ...product("Voltaris", "UPS-60", 12), connectedLoad: "60" } });
  const smdbs: Asset[] = [];
  for (const floor of [b1, gf, l1, l2, rf]) {
    const riser = floor.rooms.find(([, n]) => /riser|electrical|plant/i.test(n))?.[0] ?? floor.rooms[0][0];
    const smdb = add("SMDB", floor, riser, `SMDB-${floor.code}`, { family: "Sub-main Distribution Board", type: "400A", fedFrom: msb.name, values: { ...product("Voltaris", "SD-400", 25, { serial: false }), mainsRating: "400", voltage: "400", phases: "3" } });
    smdbs.push(smdb);
    for (const lp of ["L", "P"]) add("DB", floor, riser, `DB-${floor.code}-${lp}1`, { family: "Distribution Board", type: lp === "L" ? "Lighting 24 way" : "Power 36 way", fedFrom: smdb.name, values: { ...product("Voltaris", lp === "L" ? "DB-24" : "DB-36", 25, { serial: false }), ways: lp === "L" ? "24" : "36", voltage: "400" } });
  }
  add("CBS", b1, "B1.02", "CBS-01", { family: "Central Battery System", type: "3 hour", fedFrom: msb.name, values: product("Lumensafe", "CB-3H", 10) });

  // Heating, cooling and ventilation
  const ch = add("CH", rf, "R.01", "CH-01", { family: "Air Cooled Chiller", type: "450 kW", systems: ["CHW-01"], values: { ...product("Northwind Air", "ACX-450", 20), coolingCapacity: "450", refrigerant: "R-1234ze", refrigerantCharge: "86" } });
  add("CH", rf, "R.01", "CH-02", { family: "Air Cooled Chiller", type: "450 kW", systems: ["CHW-01"], values: { ...product("Northwind Air", "ACX-450", 20), coolingCapacity: "450", refrigerant: "R-1234ze" } });
  for (const i of [1, 2]) add("PMP", b1, "B1.01", `CHWP-0${i}`, { family: "End Suction Pump", type: "CHW 22 kW", systems: ["CHW-01"], values: { ...product("AquaFlow", "ES-80", 15), motorPower: "22", waterFlow: "18.5" } });
  add("BLR", b1, "B1.01", "BLR-01", { family: "Condensing Boiler", type: "300 kW", systems: ["LTHW-01"], values: { ...product("Calora", "CB-300", 20), heatingCapacity: "300" } });
  for (const i of [1, 2, 3]) {
    const ahu = add("AHU", rf, "R.01", `AHU-0${i}`, { family: "Air Handling Unit", type: "Double deck 6 m³/s", systems: [`SA-0${i}`, "CHW-01"], fedFrom: "SMDB-RF", values: { ...product("Northwind Air", "AH-6000", 20), airflow: "6000", coolingCapacity: "120", motorPower: "15", esp: "450", ppmTask: "Filter change and belt check", ppmFrequency: "Quarterly" } });
    if (i === 1) ch.serves.push(ahu.name);
  }
  for (const floor of [gf, l1, l2]) {
    floor.rooms.filter(([, n]) => /office|meeting|board|reception|cafe/i.test(n)).forEach(([room], i) => {
      for (const j of [1, 2]) add("FCU", floor, room, `FCU-${floor.code}-${String(i * 2 + j).padStart(2, "0")}`, { family: "Ceiling Fan Coil Unit", type: "4-pipe 2 kW", systems: ["CHW-01", `SA-0${1 + (i % 3)}`], fedFrom: `DB-${floor.code}-P1`, values: product("Northwind Air", "FC-200", 15, { serial: rnd() > 0.5 }) });
    });
  }
  add("FAN", rf, "R.01", "EF-01", { family: "Roof Extract Fan", type: "Toilet extract", fedFrom: "SMDB-RF", values: product("Northwind Air", "RX-30", 15) });
  add("FAN", b1, "B1.05", "CPV-01", { family: "Car Park Jet Fan", type: "Reversible", fedFrom: "SMDB-B1", values: product("Northwind Air", "JF-1", 15) });

  // Water
  add("TNK", b1, "B1.04", "CWST-01", { family: "Sectional Water Tank", type: "20 m³", values: { ...product("TankCraft", "GRP-20", 25, { serial: false }), tankVolume: "20000" } });
  add("BPS", b1, "B1.04", "BPS-01", { family: "Booster Pump Set", type: "Triple", fedFrom: "SMDB-B1", values: product("AquaFlow", "BP-3", 15) });
  add("WH", b1, "B1.01", "CAL-01", { family: "Water Heater", type: "500 L", values: product("Calora", "WH-500", 15) });
  for (const floor of [gf, l1, l2]) add("TMV", floor, floor.rooms.find(([, n]) => /washroom/i.test(n))![0], `TMV-${floor.code}-01`, { family: "Thermostatic Mixing Valve", type: "TMV3", values: product("AquaFlow", "TM-3", 10, { serial: false }) });
  add("BFP", b1, "B1.04", "BFP-01", { family: "Backflow Preventer", type: "RPZ 50", values: product("AquaFlow", "RPZ-50", 15, { serial: false }) });

  // Fire and life safety
  const facp = add("FACP", gf, "G.03", "FACP-01", { family: "Fire Alarm Control Panel", type: "4 loop", fedFrom: "SMDB-L00", values: { ...product("SafeGuard Fire", "FP-4L", 15), firePanel: "FACP-01" } });
  for (const floor of FLOORS) {
    floor.rooms.forEach(([room], i) => {
      add(i % 3 === 2 ? "HD" : "SD", floor, room, `${i % 3 === 2 ? "HD" : "SD"}-${floor.code}-${String(i + 1).padStart(2, "0")}`, { family: i % 3 === 2 ? "Heat Detector" : "Optical Smoke Detector", type: "Addressable", values: { manufacturer: "SafeGuard Fire", model: i % 3 === 2 ? "HD-1" : "OD-2", firePanel: facp.name, loop: `${1 + (FLOORS.indexOf(floor) % 4)}`, address: String(i + 1).padStart(3, "0"), installationDate: `${year - 2}-03-1${i % 9}` } });
    });
    add("MCP", floor, floor.rooms[0][0], `MCP-${floor.code}-01`, { family: "Manual Call Point", type: "Addressable", values: { manufacturer: "SafeGuard Fire", model: "CP-1", firePanel: facp.name } });
    add("SB", floor, floor.rooms[0][0], `SB-${floor.code}-01`, { family: "Sounder Beacon", type: "Wall", values: { manufacturer: "SafeGuard Fire", model: "SB-2", firePanel: facp.name } });
    add("FE", floor, floor.rooms[0][0], `FE-${floor.code}-01`, { family: "Fire Extinguisher", type: "CO2 5 kg", values: { manufacturer: "Extinct", model: "CO2-5", extinguisherType: "CO2" } });
    for (const j of [1, 2]) add("EL", floor, floor.rooms[j % floor.rooms.length][0], `EL-${floor.code}-0${j}`, { family: "Emergency Downlight", type: "3 h non-maintained", fedFrom: "CBS-01", values: { manufacturer: "Lumensafe", model: "ED-3", emergencyDuration: "3" } });
    add("EX", floor, floor.rooms[0][0], `EX-${floor.code}-01`, { family: "Exit Sign", type: "Maintained", fedFrom: "CBS-01", values: { manufacturer: "Lumensafe", model: "EX-1" } });
  }
  add("FP", b1, "B1.01", "FP-01", { family: "Fire Pump Set", type: "Electric duty", fedFrom: "SMDB-B1", values: product("AquaFlow", "FPS-75", 20) });
  add("AVS", b1, "B1.01", "AVS-01", { family: "Sprinkler Alarm Valve Set", type: "Wet 150", values: product("SafeGuard Fire", "AV-150", 30, { serial: false }) });
  for (const floor of [gf, l1, l2]) {
    add("FD", floor, floor.rooms.find(([, n]) => /riser/i.test(n))![0], `FD-${floor.code}-01`, { family: "Fire Damper", type: "Curtain 600x400", values: { manufacturer: "Northwind Air", model: "FD-120", fireRating: "120 min" } });
    add("FDR", floor, floor.rooms.find(([, n]) => /riser/i.test(n))![0], `FDR-${floor.code}-01`, { family: "Fire Door", type: "FD60S single", values: { manufacturer: "Doorworks", model: "FD60S", fireRating: "FD60S" } });
  }

  // Lifts, security and controls
  for (const i of [1, 2]) add("LFT", gf, "G.01", `LIFT-0${i}`, { family: "Passenger Lift", type: "13 person 1000 kg", fedFrom: "SMDB-RF", values: { ...product("Vertica", "PL-1000", 25), liftCapacity: "1000", liftSpeed: "1.6", liftPersons: "13" } });
  for (const floor of [b1, gf, l1, l2]) add("CAM", floor, floor.rooms[0][0], `CAM-${floor.code}-01`, { family: "Dome Camera", type: "IP 4MP", values: { manufacturer: "Watchpoint", model: "DC-4" } });
  add("ACR", gf, "G.01", "ACR-L00-01", { family: "Access Control Reader", type: "Card", values: { manufacturer: "Watchpoint", model: "AR-2" } });
  add("BMS", b1, "B1.01", "BMS-01", { family: "BMS Controller", type: "Plant controller", values: { manufacturer: "Ctrlogic", model: "PC-200" } });

  // What feeds what, from the board each asset names.
  const byName = new Map(assets.map((a) => [a.name, a]));
  for (const a of assets) if (a.fedFrom) byName.get(a.fedFrom)?.serves.push(a.name);

  // A few changes and verifications made "on site".
  const verifiedBy = "Demo technician";
  for (const a of assets.filter((x) => x.floor === "Basement").slice(0, 12)) a.verified = { at: new Date(Date.now() - 86400000 * (2 + Math.floor(rnd() * 20))).toISOString(), by: verifiedBy, condition: 3 + Math.floor(rnd() * 3) };
  const fcu = assets.find((a) => a.kindCode === "FCU" && !a.values.serialNumber);
  if (fcu) fcu.edits = { serialNumber: { value: "SN-448120", at: new Date(Date.now() - 86400000 * 3).toISOString(), by: verifiedBy } };

  const systems: SystemInfo[] = [];
  const members = new Map<string, number>();
  for (const a of assets) for (const s of a.systems) members.set(s, (members.get(s) ?? 0) + 1);
  for (const [name, count] of members) systems.push({ name, classification: name.startsWith("CHW") ? "Chilled water" : name.startsWith("LTHW") ? "Heating water" : "Supply air", type: "", members: count });

  // Maintenance: plans from the library, some done, some overdue, and work orders.
  const plans: Plan[] = plansForAssets(assets, DEFAULT_TASKS, { start: addDays(today, -20), spread: true, fromModel: true });
  const workOrders: WorkOrder[] = [];
  let counter = 0;
  const wo = (plan: Plan | null, title: string, status: WorkOrder["status"], due: string, assetIds: string[], kind: WorkOrder["kind"] = "planned", priority: WorkOrder["priority"] = "normal") => {
    counter++;
    const at = new Date(Date.now() - 86400000 * 5).toISOString();
    const order: WorkOrder = {
      id: `demo-wo-${counter}`,
      number: `WO-${String(counter).padStart(4, "0")}`,
      title,
      kind,
      status,
      priority,
      assetIds,
      planId: plan?.id,
      due,
      assignee: pick(["A. Rahman", "J. Silva", "M. Chen"]),
      description: kind === "reactive" ? "Reported by the tenant on level 2." : "",
      createdAt: at,
      createdBy: "Demo user",
      updatedAt: at,
      log: [{ at, by: "Demo user", text: plan ? "Raised from the maintenance plan" : "Created" }],
    };
    if (status === "done") {
      order.completedAt = new Date(Date.now() - 86400000 * 2).toISOString();
      order.completedBy = order.assignee;
      order.log.push({ at: order.completedAt, by: order.assignee, text: "Status: done" });
    }
    workOrders.push(order);
  };
  const overdue = plans.filter((p) => p.nextDue < today).slice(0, 6);
  overdue.forEach((p, i) => wo(p, p.title, i < 2 ? "in-progress" : "open", p.nextDue, [p.assetId], "planned", i === 0 ? "high" : "normal"));
  const l2fcu = assets.find((a) => a.kindCode === "FCU" && a.floor === "Level 2");
  if (l2fcu) wo(null, "Fan coil noisy in boardroom", "open", addDays(today, 2), [l2fcu.id], "reactive", "high");
  const ahu1 = assets.find((a) => a.name === "AHU-01")!;
  wo(null, "Replace AHU-01 supply fan belt", "done", addDays(today, -4), [ahu1.id], "reactive");

  // Live points, fed by the simulator.
  const source: LiveSource = { id: DEMO_SOURCE_ID, kind: "simulator", name: "Simulator (demo)", url: "", topics: [], valuePath: "value", timePath: "", enabled: true };
  const points: Point[] = [];
  const point = (assetName: string, key: string, name: string, kind: PointKind, unit: string, rule?: Point["rule"]) => {
    const a = byName.get(assetName);
    points.push({ id: `${DEMO_SOURCE_ID}|${key}`, sourceId: DEMO_SOURCE_ID, key, name, unit, kind, assetId: a?.id, spaceId: a?.space, rule });
  };
  for (const i of [1, 2, 3]) {
    point(`AHU-0${i}`, `hvo/ahu-0${i}/supply-temp`, `AHU-0${i} supply air temperature`, "temperature", "°C", { high: 18, low: 10, staleMinutes: 10 });
    point(`AHU-0${i}`, `hvo/ahu-0${i}/fan-status`, `AHU-0${i} supply fan status`, "status", "", { alarmValue: "fault" });
    point(`AHU-0${i}`, `hvo/ahu-0${i}/filter-dp`, `AHU-0${i} filter pressure drop`, "pressure", "Pa", { high: 250 });
  }
  point("CH-01", "hvo/ch-01/chw-supply", "CH-01 chilled water supply temperature", "temperature", "°C", { high: 9 });
  point("CH-01", "hvo/ch-01/power", "CH-01 power", "power", "kW");
  point("MSB-01", "hvo/msb-01/energy", "MSB-01 energy", "energy", "kWh");
  point("MSB-01", "hvo/msb-01/power", "MSB-01 power", "power", "kW", { high: 800 });
  point("CWST-01", "hvo/cwst-01/level", "CWST-01 water level", "level", "%", { low: 30 });
  point("GEN-01", "hvo/gen-01/status", "GEN-01 run status", "status", "", { alarmValue: "fault" });
  for (const room of ["1.01", "1.03", "2.01", "2.03"]) {
    const fcuIn = assets.find((a) => a.kindCode === "FCU" && a.space === room);
    if (fcuIn) point(fcuIn.name, `hvo/room-${room}/temp`, `Room ${room} temperature`, "temperature", "°C", { high: 26, low: 18 });
    if (fcuIn) point(fcuIn.name, `hvo/room-${room}/co2`, `Room ${room} CO₂`, "co2", "ppm", { high: 1000 });
  }

  return { facility: { ...facility, woCounter: counter }, assets, spaces, systems, tasks: DEFAULT_TASKS, plans, workOrders, sources: [source], points, alarms: [], photos: [] };
}

function categoryOf(discipline: string, code: string): string {
  if (/^(SD|HD|MCP|SB|FACP)$/.test(code)) return "Fire Alarm Devices";
  if (/^(EL|EX|LT)$/.test(code)) return "Lighting Fixtures";
  if (/^(FE|AVS|FP)$/.test(code)) return "Fire Protection";
  if (/^(FD)$/.test(code)) return "Duct Accessories";
  if (/^(FDR)$/.test(code)) return "Doors";
  if (/^(TMV|BFP)$/.test(code)) return "Pipe Accessories";
  if (/^(LFT)$/.test(code)) return "Vertical Circulation";
  if (/^(CAM|ACR)$/.test(code)) return "Security Devices";
  if (discipline === "Electrical") return "Electrical Equipment";
  return "Mechanical Equipment";
}

/** A believable reading for a demo point at time t (ms). Some points drift into alarm now and then. */
export function simulatedValue(point: Point, t: number, rnd: () => number): number | string {
  const minutes = t / 60000;
  const wave = (period: number, phase = 0) => Math.sin((minutes / period) * Math.PI * 2 + phase);
  const seed = point.key.length;
  switch (point.kind) {
    case "temperature":
      if (/supply/.test(point.key) && /chw/.test(point.key)) return round(6.5 + wave(47, seed) * 1.4 + (rnd() - 0.5) * 0.3 + (wave(180) > 0.93 ? 2.8 : 0));
      if (/supply/.test(point.key)) return round(14 + wave(37, seed) * 2.5 + (rnd() - 0.5) * 0.4 + (wave(240, seed) > 0.9 ? 5 : 0));
      return round(22.5 + wave(61, seed) * 2 + (rnd() - 0.5) * 0.4 + (wave(300, seed) > 0.85 ? 3.5 : 0));
    case "co2":
      return Math.round(620 + wave(53, seed) * 230 + rnd() * 40 + (wave(200, seed) > 0.9 ? 300 : 0));
    case "pressure":
      return Math.round(150 + wave(400, seed) * 70 + rnd() * 10);
    case "power":
      return round(/msb/.test(point.key) ? 420 + wave(90) * 180 + rnd() * 20 : 95 + wave(70, seed) * 35 + rnd() * 5);
    case "energy":
      return Math.round(1250000 + minutes * 7.5);
    case "level":
      return round(68 + wave(500, seed) * 30);
    case "status":
      return wave(310, seed) > 0.97 ? "fault" : wave(97, seed) > -0.6 ? "on" : "off";
    default:
      return round(50 + wave(60, seed) * 10);
  }
}

const round = (n: number) => Math.round(n * 10) / 10;
