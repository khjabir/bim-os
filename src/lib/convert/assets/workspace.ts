// The asset register as a facility workspace: the assets, rooms and systems
// bim-os keeps in the browser for maintenance, labels and live data.
// Runs in the conversion worker; the result is plain data for the page.

import type { Asset, Space, SystemInfo } from "@/lib/fm/types";
import type { AssetRegister } from "./register";

export interface RegisterWorkspace {
  assets: Asset[];
  spaces: Space[];
  systems: SystemInfo[];
  /** Floors, lowest first. */
  floors: string[];
  /** Model files the assets came from. */
  files: string[];
}

const round = (v: number, digits = 3) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export function workspaceFromRegister(register: AssetRegister): RegisterWorkspace {
  const spaceByName = new Map(register.spaces.map((s) => [s.name, s]));
  // The board an asset is fed from, as the register resolved it (its name in the register).
  const fedFrom = new Map<string, string>();
  for (const r of register.relations) if (r.kind === "Electrical supply" && !fedFrom.has(r.to)) fedFrom.set(r.to, r.from);

  const assets: Asset[] = register.assets.map((a) => {
    const values: Record<string, string> = {};
    for (const [field, value] of Object.entries(a.values)) if (value) values[field] = value;
    const space = spaceByName.get(a.space);
    const asset: Asset = {
      id: a.guid,
      code: a.code,
      name: a.name,
      tag: a.values.tag ?? "",
      kind: a.kind,
      kindCode: a.kindCode,
      discipline: a.discipline,
      category: a.category,
      family: a.family,
      type: a.type,
      typeName: a.typeName,
      floor: a.floor,
      space: a.space,
      roomName: space?.roomName ?? "",
      locationCode: a.locationCode,
      locationPath: a.locationPath,
      systems: a.systems.map((s) => s.name),
      fedFrom: fedFrom.get(a.name) ?? a.values.panel ?? "",
      servedBy: [...a.servedBy],
      serves: [...a.serves],
      parent: a.parent,
      children: [...a.children],
      compliance: a.compliance,
      uniclass: a.uniclass ? `${a.uniclass[0]} ${a.uniclass[1]}` : "",
      values,
      file: a.file,
      elementId: a.elementId,
    };
    if (a.position) asset.position = [round(a.position[0]), round(a.position[1]), round(a.position[2])];
    return asset;
  });

  const spaces: Space[] = register.spaces.map((s) => {
    const space: Space = { id: s.name, number: s.number, name: s.roomName, floor: s.floor };
    const area = s.netArea ?? s.grossArea;
    if (area !== null && area !== undefined) space.area = round(area, 2);
    if (s.department) space.department = s.department;
    if (s.category) space.category = s.category;
    return space;
  });

  const systems: SystemInfo[] = register.systems.map((s) => ({ name: s.name, classification: s.classification, type: s.type, members: s.members.length }));
  const floors = [...register.floors].sort((a, b) => a.elevation - b.elevation).map((f) => f.name);
  const files = [...new Set(register.assets.map((a) => a.file).filter(Boolean))];
  return { assets, spaces, systems, floors, files };
}
