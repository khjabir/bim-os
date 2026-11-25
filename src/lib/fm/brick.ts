// The facility as a Brick model (https://brickschema.org), in Turtle: site,
// building, floors, rooms, equipment with what feeds what, and live points
// with the equipment they belong to. Brick classes are chosen from each
// asset's kind and each point's kind; they are suggestions to check.

import { valueOf } from "./asset";
import { todayIso } from "./schedule";
import type { Asset, Facility, Point, PointKind, Space } from "./types";

const EQUIPMENT: Record<string, string> = {
  AHU: "Air_Handling_Unit",
  FCU: "Fan_Coil_Unit",
  IDU: "Fan_Coil_Unit",
  VAV: "Terminal_Unit",
  FAN: "Fan",
  PMP: "Pump",
  BPS: "Pump",
  SP: "Pump",
  FP: "Pump",
  CH: "Chiller",
  CT: "Cooling_Tower",
  BLR: "Boiler",
  HP: "Heat_Pump",
  HEX: "Heat_Exchanger",
  HUM: "Humidifier",
  DMP: "Damper",
  FD: "Damper",
  SMD: "Damper",
  VLV: "Valve",
  TMV: "Valve",
  BFP: "Valve",
  WH: "Water_Heater",
  TNK: "Water_Tank",
  TX: "Transformer",
  MCC: "Motor_Control_Center",
  VSD: "Variable_Frequency_Drive",
  EM: "Electrical_Meter",
  WM: "Water_Meter",
  LT: "Luminaire",
  EL: "Luminaire",
  EX: "Luminaire",
  LFT: "Elevator",
  ESC: "Escalator",
  CAM: "Camera",
};

const POINTS: Record<PointKind, string> = {
  temperature: "Temperature_Sensor",
  humidity: "Humidity_Sensor",
  pressure: "Pressure_Sensor",
  flow: "Flow_Sensor",
  power: "Power_Sensor",
  energy: "Energy_Sensor",
  current: "Current_Sensor",
  voltage: "Voltage_Sensor",
  co2: "CO2_Sensor",
  occupancy: "Occupancy_Sensor",
  status: "Status",
  alarm: "Alarm",
  setpoint: "Setpoint",
  speed: "Speed_Sensor",
  level: "Level_Sensor",
  other: "Point",
};

function equipmentClass(a: Asset): string {
  const mapped = EQUIPMENT[a.kindCode];
  if (mapped) return mapped;
  if (a.discipline === "Fire & life safety") return "Fire_Safety_Equipment";
  if (a.discipline === "Electrical") return "Electrical_Equipment";
  if (a.discipline === "HVAC") return "HVAC_Equipment";
  return "Equipment";
}

const slug = (text: string) => text.normalize("NFKD").replace(/[^\w-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "x";
const literal = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

export function brickTurtle(facility: Facility, assets: Asset[], spaces: Space[], points: Point[]): string {
  const ns = `urn:bim-os:${slug(facility.id)}#`;
  const lines: string[] = [
    "@prefix brick: <https://brickschema.org/schema/Brick#> .",
    "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
    `@prefix bldg: <${ns}> .`,
    "",
    `# ${facility.name}: written by bim-os on ${todayIso()}. Classes are suggested from asset and point kinds; check them before use.`,
    "",
  ];
  const site = `bldg:site_${slug(facility.siteCode || facility.site || "site")}`;
  const building = `bldg:building_${slug(facility.buildingCode || facility.name)}`;
  lines.push(`${site} a brick:Site ; rdfs:label ${literal(facility.site || facility.name)} ; brick:hasPart ${building} .`);
  const floors = [...new Set([...spaces.map((s) => s.floor), ...assets.map((a) => valueOf(a, "floor"))].filter(Boolean))];
  const floorId = (name: string) => `bldg:floor_${slug(name)}`;
  const roomId = (id: string) => `bldg:room_${slug(id)}`;
  lines.push(`${building} a brick:Building ; rdfs:label ${literal(facility.name)}${floors.length ? ` ;\n  brick:hasPart ${floors.map(floorId).join(", ")}` : ""} .`);
  for (const floor of floors) {
    const rooms = spaces.filter((s) => s.floor === floor);
    lines.push(`${floorId(floor)} a brick:Floor ; rdfs:label ${literal(floor)}${rooms.length ? ` ;\n  brick:hasPart ${rooms.map((r) => roomId(r.id)).join(", ")}` : ""} .`);
  }
  for (const s of spaces) lines.push(`${roomId(s.id)} a brick:Room ; rdfs:label ${literal([s.number, s.name].filter(Boolean).join(" "))} .`);
  lines.push("");
  const equipId = (a: Asset) => `bldg:equip_${slug(valueOf(a, "code") || a.id)}`;
  const byName = new Map(assets.map((a) => [a.name, a]));
  const pointsOf = new Map<string, Point[]>();
  for (const p of points) if (p.assetId) pointsOf.set(p.assetId, [...(pointsOf.get(p.assetId) ?? []), p]);
  const pointId = (p: Point) => `bldg:point_${slug(p.key)}`;
  for (const a of assets) {
    const props = [`a brick:${equipmentClass(a)}`, `rdfs:label ${literal(`${valueOf(a, "name")} (${valueOf(a, "code")})`)}`];
    const space = valueOf(a, "space");
    const floor = valueOf(a, "floor");
    if (space && spaces.some((s) => s.id === space)) props.push(`brick:hasLocation ${roomId(space)}`);
    else if (floor) props.push(`brick:hasLocation ${floorId(floor)}`);
    const feeds = a.serves.map((n) => byName.get(n)).filter((x): x is Asset => Boolean(x));
    if (feeds.length) props.push(`brick:feeds ${feeds.map(equipId).join(", ")}`);
    const parts = a.children.map((n) => byName.get(n)).filter((x): x is Asset => Boolean(x));
    if (parts.length) props.push(`brick:hasPart ${parts.map(equipId).join(", ")}`);
    const mine = pointsOf.get(a.id) ?? [];
    if (mine.length) props.push(`brick:hasPoint ${mine.map(pointId).join(", ")}`);
    lines.push(`${equipId(a)} ${props.join(" ;\n  ")} .`);
  }
  lines.push("");
  for (const p of points) {
    const props = [`a brick:${POINTS[p.kind] ?? "Point"}`, `rdfs:label ${literal(p.name || p.key)}`];
    if (!p.assetId && p.spaceId && spaces.some((s) => s.id === p.spaceId)) props.push(`brick:isPointOf ${roomId(p.spaceId)}`);
    lines.push(`${pointId(p)} ${props.join(" ;\n  ")} .`);
  }
  return `${lines.join("\n")}\n`;
}
