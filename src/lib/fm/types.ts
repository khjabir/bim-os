// The facility workspace: one building's assets, rooms, systems, maintenance
// and live data, kept in the browser (IndexedDB) and shared as files.
//
// Values read from the models stay as they were read (`Asset.values`); what
// people change or confirm later is recorded next to them (`Asset.edits`,
// `Asset.verified`) with who and when, so the model's data and the team's
// corrections never get mixed up and either can be exported.

export interface Facility {
  id: string;
  /** The building or facility, as people call it. */
  name: string;
  site: string;
  siteCode: string;
  buildingCode: string;
  address: string;
  currency: string;
  /** Where the register came from: "demo", "model" (viewer extracts, Revit, Navisworks), "ifc" or "file". */
  source: string;
  /** Base of the links in QR labels (the address bim-os is served from); empty puts the bare asset code in the QR. */
  labelBaseUrl: string;
  /** Name recorded with edits, verifications and work orders made on this device. */
  user: string;
  /** Last work order number handed out. */
  woCounter: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssetEdit {
  value: string;
  at: string;
  by: string;
}

export interface Verification {
  at: string;
  by: string;
  /** 1 (very poor) to 5 (as new). */
  condition?: number;
  notes?: string;
}

export interface Asset {
  /** The IFC GlobalId, the same id the asset has in the IFC files and workbooks. */
  id: string;
  code: string;
  name: string;
  tag: string;
  kind: string;
  kindCode: string;
  discipline: string;
  category: string;
  family: string;
  type: string;
  /** The register's type name ("Family: Type"); assets of one type share type values. */
  typeName: string;
  floor: string;
  space: string;
  roomName: string;
  locationCode: string;
  locationPath: string;
  systems: string[];
  /** The board it is fed from. */
  fedFrom: string;
  servedBy: string[];
  serves: string[];
  parent: string;
  children: string[];
  /** Suggested compliance regime (fire safety, lifting equipment…). */
  compliance: string;
  /** Suggested Uniclass 2015 product code and title, "Pr_… Title". */
  uniclass: string;
  /** Field values as read from the model (field ids of the register, non-empty only). */
  values: Record<string, string>;
  /** Changes made in bim-os, by field id (register fields or name, tag, space, floor). */
  edits?: Record<string, AssetEdit>;
  verified?: Verification;
  /** Centre in metres, when the model gave a position. */
  position?: [number, number, number];
  file: string;
  elementId: string;
  photos?: string[];
}

export interface Space {
  /** The room's key as assets name it (its number, or its name). */
  id: string;
  number: string;
  name: string;
  floor: string;
  area?: number;
  department?: string;
  category?: string;
}

export interface SystemInfo {
  name: string;
  classification: string;
  type: string;
  members: number;
}

export type Unit = "day" | "week" | "month" | "year";

/** A maintenance task in the library, applied to assets of the listed kinds. */
export interface TaskTemplate {
  id: string;
  /** Asset kind codes it applies to (AHU, PMP, DB…). */
  kindCodes: string[];
  title: string;
  every: number;
  unit: Unit;
  /** Minutes on site, as a planning guide. */
  minutes?: number;
  /** A legal or insurance requirement in most places (check the local rules). */
  statutory?: boolean;
  trade?: string;
  notes?: string;
  /** Edited or added by the facility team (kept when the built-in library changes). */
  custom?: boolean;
}

export interface Plan {
  id: string;
  assetId: string;
  taskId: string;
  title: string;
  every: number;
  unit: Unit;
  /** First due date (ISO date). */
  start: string;
  lastDone?: string;
  /** ISO date. */
  nextDue: string;
  active: boolean;
  /** "library", "model" (maintenance data in the model) or "manual". */
  source: "library" | "model" | "manual";
  statutory?: boolean;
  minutes?: number;
  trade?: string;
}

export type WorkOrderStatus = "open" | "in-progress" | "on-hold" | "done" | "cancelled";
export type WorkOrderKind = "planned" | "reactive" | "inspection";
export type Priority = "low" | "normal" | "high" | "urgent";

export interface WorkOrderLog {
  at: string;
  by: string;
  text: string;
}

export interface WorkOrder {
  id: string;
  /** WO-0001. */
  number: string;
  title: string;
  kind: WorkOrderKind;
  status: WorkOrderStatus;
  priority: Priority;
  assetIds: string[];
  planId?: string;
  /** ISO date. */
  due: string;
  assignee: string;
  description: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  completedAt?: string;
  completedBy?: string;
  log: WorkOrderLog[];
}

export interface Photo {
  id: string;
  assetId: string;
  at: string;
  by: string;
  name: string;
  type: string;
  blob: Blob;
}

export type PointKind =
  | "temperature"
  | "humidity"
  | "pressure"
  | "flow"
  | "power"
  | "energy"
  | "current"
  | "voltage"
  | "co2"
  | "occupancy"
  | "status"
  | "alarm"
  | "setpoint"
  | "speed"
  | "level"
  | "other";

export interface AlarmRule {
  high?: number;
  low?: number;
  /** Raise an alarm when no reading arrived for this long. */
  staleMinutes?: number;
  /** For status points: the value that is an alarm ("1", "fault", "on"…). */
  alarmValue?: string;
}

export interface LiveSource {
  id: string;
  kind: "mqtt" | "simulator";
  name: string;
  /** ws:// or wss:// address of an MQTT broker's WebSocket listener. */
  url: string;
  username?: string;
  password?: string;
  /** Topic filters to subscribe to (MQTT wildcards + and # allowed). */
  topics: string[];
  /** Where the value is in a JSON payload ("value", "data.temp"); plain payloads are read as they are. */
  valuePath: string;
  /** Where a timestamp is in a JSON payload; empty uses the time of arrival. */
  timePath: string;
  enabled: boolean;
}

export interface Point {
  /** Source id and key: "src-1|plant/ahu-01/supply-temp". */
  id: string;
  sourceId: string;
  /** The MQTT topic (or the point's name in a CSV file). */
  key: string;
  name: string;
  unit: string;
  kind: PointKind;
  assetId?: string;
  spaceId?: string;
  rule?: AlarmRule;
  lastValue?: number | string;
  /** Epoch milliseconds of the last reading. */
  lastAt?: number;
}

export type AlarmKind = "high" | "low" | "stale" | "state";

export interface Alarm {
  id: string;
  pointId: string;
  assetId?: string;
  kind: AlarmKind;
  value?: number | string;
  limit?: number | string;
  /** Epoch milliseconds. */
  start: number;
  end?: number;
  ackAt?: number;
  ackBy?: string;
}

/** Readings of a point, oldest first: [epoch ms, value]. */
export type Series = [number, number | string][];

/** Everything in a workspace, as written to and read from a workspace file. */
export interface WorkspaceData {
  facility: Facility;
  assets: Asset[];
  spaces: Space[];
  systems: SystemInfo[];
  tasks: TaskTemplate[];
  plans: Plan[];
  workOrders: WorkOrder[];
  sources: LiveSource[];
  points: Point[];
  alarms: Alarm[];
  photos: Photo[];
}
