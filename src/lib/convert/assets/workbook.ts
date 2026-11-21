// The asset register as Excel workbooks:
//
// - COBie 2.4: the US NBIMS v3 spreadsheet (Contact, Facility, Floor, Space,
//   Zone, Type, Component, System, Assembly, Connection, Spare, Resource, Job,
//   Impact, Document, Attribute, Coordinate, Issue, PickLists), headers
//   coloured by COBie's convention, and COBie's placeholders where a required
//   value is not in the model ("n/a", and 1900-12-31T23:59:59 for dates), so
//   COBie importers accept it.
// - Asset register: one flat sheet with a row per asset and every field and
//   relationship as columns, for onboarding into an FM / CMMS platform, with
//   spaces, types, systems, relationships, PPM, coverage of every field,
//   data issues, and every property of every asset. Blank where the model has
//   nothing.

import { writeXlsx, type Cell, type HeaderStyle, type SheetDef } from "@/lib/utils/xlsx";
import { cleanText, durationYears, FIELD_BY_ID, FIELD_GROUP_LABELS, FIELDS, isoDuration, parseDuration, parseNumber, parseUnit, unitWord } from "./fields";
import type { AssetRegister, RegisterAsset } from "./register";

/** Normalised technical values of an asset, in the order the sheets list them. */
export const TECHNICAL_COLUMNS = [
  "airflow", "waterFlow", "coolingCapacity", "sensibleCapacity", "heatingCapacity", "motorPower", "esp", "pumpHead", "refrigerant", "refrigerantCharge", "efficiency",
  "voltage", "phases", "ratedCurrent", "connectedLoad", "ipRating", "weight", "tankVolume", "lampPower", "luminousFlux", "colourTemperature", "emergencyType",
  "emergencyDuration", "liftCapacity", "liftSpeed", "liftPersons", "floorsServed",
];
export const FIRE_COLUMNS = ["firePanel", "loop", "address", "fireZone", "fireRating", "activationTemperature", "kFactor", "sprinklerResponse", "coverageArea", "damperActuation", "extinguisherType", "emergencyType", "emergencyDuration"];

/** "Airflow (L/s)" */
export function columnLabel(id: string): string {
  const f = FIELD_BY_ID.get(id);
  if (!f) return id;
  return f.unit ? `${f.label} (${f.unit})` : f.label;
}

/** A field value as a cell: numbers for quantities. */
export function fieldCell(a: RegisterAsset, id: string): Cell {
  const v = a.values[id] ?? "";
  if (!v) return null;
  if (FIELD_BY_ID.get(id)?.kind === "quantity") {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

/** Whether an asset is part of fire and life safety (devices, fire doors and dampers, emergency lighting). */
export function lifeSafety(a: RegisterAsset): boolean {
  return a.discipline === "Fire & life safety" || a.compliance === "Fire safety" || a.compliance === "Emergency lighting";
}

/** "Airflow 3333.3 L/s; Cooling capacity 85 kW" for COBie Type.Features. */
function featureText(a: RegisterAsset | undefined): string {
  if (!a) return "";
  return TECHNICAL_COLUMNS.filter((id) => a.values[id])
    .map((id) => {
      const f = FIELD_BY_ID.get(id)!;
      return `${f.label} ${a.values[id]}${f.unit ? ` ${f.unit}` : ""}`;
    })
    .join("; ");
}

export interface WorkbookSettings {
  projectName: string;
  siteName: string;
  buildingName: string;
  /** COBie author (CreatedBy everywhere). */
  contactEmail: string;
  contactCompany: string;
  contactPhone: string;
  /** Currency of replacement costs (COBie Facility.CurrencyUnit), e.g. "AED". */
  currency: string;
  /** Source model names, for the About sheet. */
  sources: string[];
  /** Ids shared with the IFC files. */
  siteGuid: string;
  buildingGuid: string;
}

const NA = "n/a";
const NO_DATE = "1900-12-31T23:59:59";

const or = (v: string | null | undefined, fallback = NA) => (v && String(v).trim() ? String(v) : fallback);

/** COBie list cells hold at most this many characters; longer lists go on extra rows. */
const LIST_CHARS = 30_000;

function chunkList(names: string[]): string[] {
  const out: string[] = [];
  let current = "";
  for (const n of names) {
    if (current && current.length + n.length + 1 > LIST_CHARS) {
      out.push(current);
      current = "";
    }
    current = current ? `${current},${n}` : n;
  }
  if (current) out.push(current);
  return out.length ? out : [""];
}

function isoDate(date: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date}T00:00:00`;
  if (/^\d{4}-\d{2}$/.test(date)) return `${date}-01T00:00:00`;
  if (/^\d{4}$/.test(date)) return `${date}-01-01T00:00:00`;
  return NO_DATE;
}

const mm = (metres: number | null | undefined) => (metres === null || metres === undefined ? NA : Math.round(metres * 1000));

// Column marker per COBie (Annex A): R required, F reference (foreign key), E external, O optional.
type Marker = "R" | "F" | "E" | "O";
const STYLE: Record<Marker, HeaderStyle> = { R: "required", F: "reference", E: "external", O: "optional" };

function cobieSheet(name: string, spec: string, rows: Cell[][]): SheetDef {
  // spec: "Name:R CreatedBy:F …"
  const columns = spec
    .trim()
    .split(/\s+/)
    .map((token) => {
      const [header, marker] = token.split(":");
      return { header, style: STYLE[(marker as Marker) ?? "O"] };
    });
  return { name, columns, rows };
}

/** Length / width / height of a type in millimetres (from its numeric value and units), else n/a. */
function nominal(asset: RegisterAsset | undefined, field: string, keys: string[]): Cell {
  if (!asset) return NA;
  for (const key of keys) {
    const raw = asset.props[key];
    const n = parseNumber(raw);
    if (n === null) continue;
    const unit = asset.units[key];
    const scale = /^(ft|feet|foot|decimal-ft)/i.test(unit ?? "") ? 304.8 : /^(in|inch)/i.test(unit ?? "") ? 25.4 : /^m$|^meters?$|^metres?$/i.test(unit ?? "") ? 1000 : /^cm/i.test(unit ?? "") ? 10 : /^mm/i.test(unit ?? "") ? 1 : null;
    if (scale !== null) return Math.round(n * scale);
    // Without units: values from Navisworks' older extracts are feet.
    return typeof raw === "number" && field ? Math.round(n * 304.8) : NA;
  }
  return NA;
}

export async function cobieWorkbook(reg: AssetRegister, s: WorkbookSettings): Promise<Blob> {
  const by = s.contactEmail || "cobie@ifc-studio.invalid";
  const on = new Date().toISOString().slice(0, 19);
  const ext = "IFC Studio";
  const sheets: SheetDef[] = [];
  const firstAsset = new Map<string, RegisterAsset>();
  for (const a of reg.assets) if (!firstAsset.has(a.typeName)) firstAsset.set(a.typeName, a);
  const keysOf = (field: string) => reg.sources.find((f) => f.field === field)?.keys ?? [];

  sheets.push(
    cobieSheet(
      "Contact",
      "Email:R CreatedBy:F CreatedOn:R Category:F Company:R Phone:R ExternalSystem:E ExternalObject:E ExternalIdentifier:E Department:O OrganizationCode:O GivenName:O FamilyName:O Street:O PostalBox:O Town:O StateRegion:O PostalCode:O Country:O",
      [[by, by, on, "Information Manager", or(s.contactCompany), or(s.contactPhone), ext, NA, NA, NA, NA, NA, NA, NA, NA, NA, NA, NA, NA]],
    ),
  );
  sheets.push(
    cobieSheet(
      "Facility",
      "Name:R CreatedBy:F CreatedOn:R Category:F ProjectName:R SiteName:R LinearUnits:F AreaUnits:F VolumeUnits:F CurrencyUnit:F AreaMeasurement:R ExternalSystem:E ExternalProjectObject:E ExternalProjectIdentifier:E ExternalSiteObject:E ExternalSiteIdentifier:E ExternalFacilityObject:E ExternalFacilityIdentifier:E Description:O ProjectDescription:O SiteDescription:O Phase:O",
      [[or(s.buildingName), by, on, NA, or(s.projectName), or(s.siteName), "millimeters", "square meters", "cubic meters", or(s.currency), NA, ext, "IfcProject", NA, "IfcSite", s.siteGuid, "IfcBuilding", s.buildingGuid, `${reg.stats.assets} assets from ${s.sources.join(", ") || "the model"}`, NA, NA, NA]],
    ),
  );
  sheets.push(
    cobieSheet(
      "Floor",
      "Name:R CreatedBy:F CreatedOn:R Category:F ExternalSystem:E ExternalObject:E ExternalIdentifier:E Description:O Elevation:O Height:O",
      reg.floors.map((f) => [f.name, by, on, "Floor", ext, "IfcBuildingStorey", f.guid, f.name, mm(f.elevation), mm(f.height)]),
    ),
  );
  sheets.push(
    cobieSheet(
      "Space",
      "Name:R CreatedBy:F CreatedOn:R Category:F FloorName:F Description:R ExternalSystem:E ExternalObject:E ExternalIdentifier:E RoomTag:O UsableHeight:O GrossArea:O NetArea:O",
      reg.spaces.map((sp) => [sp.name, by, on, or(sp.category), or(sp.floor), or(sp.roomName || sp.name), ext, "IfcSpace", sp.guid, or(sp.number), mm(sp.height), sp.grossArea ?? NA, sp.netArea ?? NA]),
    ),
  );
  const zoneRows: Cell[][] = [];
  for (const z of reg.zones) for (const list of chunkList(z.spaces)) zoneRows.push([z.name, by, on, z.category, list, ext, "IfcZone", z.guid, or(z.description)]);
  sheets.push(cobieSheet("Zone", "Name:R CreatedBy:F CreatedOn:R Category:F SpaceNames:F ExternalSystem:E ExternalObject:E ExternalIdentifier:E Description:O", zoneRows));

  sheets.push(
    cobieSheet(
      "Type",
      "Name:R CreatedBy:F CreatedOn:R Category:F Description:R AssetType:F Manufacturer:F ModelNumber:R WarrantyGuarantorParts:F WarrantyDurationParts:R WarrantyGuarantorLabor:F WarrantyDurationLabor:R WarrantyDurationUnit:F ExternalSystem:E ExternalObject:E ExternalIdentifier:E ReplacementCost:O ExpectedLife:O DurationUnit:F WarrantyDescription:O NominalLength:R NominalWidth:R NominalHeight:R ModelReference:O Shape:O Size:O Color:O Finish:O Grade:O Material:O Constituents:O Features:O AccessibilityPerformance:O CodePerformance:O SustainabilityPerformance:O",
      reg.types.map((t) => {
        const v = t.values;
        const warranty = parseDuration(v.warrantyDurationParts, parseUnit(v.warrantyDurationUnit) || "year");
        const labour = parseDuration(v.warrantyDurationLabor, parseUnit(v.warrantyDurationUnit) || "year");
        const life = parseDuration(v.expectedLife, parseUnit(v.durationUnit) || "year");
        const cost = parseNumber(v.replacementCost);
        const a = firstAsset.get(t.name);
        return [
          t.name, by, on, or(v.classification ? (v.classificationTitle ? `${v.classification}: ${v.classificationTitle}` : v.classification) : t.uniclass ? `${t.uniclass[0]}: ${t.uniclass[1]}` : t.revitCategory),
          or(v.typeDescription || `${t.family} ${t.type}`.trim()), t.assetType, or(v.manufacturer), or(v.model),
          or(v.warrantyGuarantorParts), warranty ? warranty.value : NA, or(v.warrantyGuarantorLabor), labour ? labour.value : NA, warranty ? unitWord(warranty.unit || "year") : labour ? unitWord(labour.unit || "year") : NA,
          ext, t.ifcTypeClass || t.ifcClass, t.guid, cost ?? NA, life ? life.value : NA, life ? unitWord(life.unit || "year") : NA, or(v.warrantyDescription),
          nominal(a, "length", keysOf("nominalLength")), nominal(a, "width", keysOf("nominalWidth")), nominal(a, "height", keysOf("nominalHeight")),
          or(v.modelReference), or(v.shape), or(v.size), or(v.color), or(v.finish), or(v.grade), or(v.material), or(v.constituents), or(v.features || featureText(a)),
          or(v.accessibilityPerformance), or(v.codePerformance), or(v.sustainabilityPerformance),
        ];
      }),
    ),
  );
  sheets.push(
    cobieSheet(
      "Component",
      "Name:R CreatedBy:F CreatedOn:R TypeName:F Space:F Description:R ExternalSystem:E ExternalObject:E ExternalIdentifier:E SerialNumber:R InstallationDate:R WarrantyStartDate:R TagNumber:O BarCode:O AssetIdentifier:O",
      reg.assets.map((a) => {
        const v = a.values;
        return [
          a.name, by, on, a.typeName, or(a.space), or(v.comments || v.typeDescription || `${a.category}: ${a.family}`), ext, a.ifcClass, a.guid,
          or(v.serialNumber), v.installationDate ? isoDate(v.installationDate) : NO_DATE, v.warrantyStartDate ? isoDate(v.warrantyStartDate) : NO_DATE,
          or(v.tag), or(v.barCode), or(v.assetIdentifier || a.code),
        ];
      }),
    ),
  );
  const systemRows: Cell[][] = [];
  for (const sys of reg.systems)
    for (const list of chunkList([...new Set(sys.members)]))
      systemRows.push([sys.name, by, on, or(sys.uniclass ? `${sys.uniclass[0]}: ${sys.uniclass[1]}` : sys.classification || sys.type), list, ext, "IfcDistributionSystem", sys.guid, or([...new Set([sys.type, sys.classification].filter(Boolean))].join(" / "))]);
  sheets.push(cobieSheet("System", "Name:R CreatedBy:F CreatedOn:R Category:F ComponentNames:F ExternalSystem:E ExternalObject:E ExternalIdentifier:E Description:O", systemRows));
  const assemblies: Cell[][] = [];
  for (const a of reg.assets)
    if (a.children.length) for (const list of chunkList(a.children)) assemblies.push([`${a.name} parts`.slice(0, 255), by, on, "Component", a.name, list, "Fixed", ext, NA, NA, `Parts of ${a.name}`]);
  sheets.push(cobieSheet("Assembly", "Name:R CreatedBy:F CreatedOn:R SheetName:F ParentName:F ChildNames:F AssemblyType:F ExternalSystem:E ExternalObject:E ExternalIdentifier:E Description:O", assemblies));
  sheets.push(
    cobieSheet(
      "Connection",
      "Name:R CreatedBy:F CreatedOn:R ConnectionType:F SheetName:F RowName1:F RowName2:F RealizingElement:O PortName1:O PortName2:O ExternalSystem:E ExternalObject:E ExternalIdentifier:E Description:O",
      reg.relations.map((r) => [
        `${r.from} > ${r.to}`.slice(0, 255), by, on, r.kind === "Electrical supply" ? "Electrical Supply" : r.kind === "Fire alarm" ? "Fire Alarm Loop" : r.kind === "Signal" ? "Signal" : "Serves",
        "Component", r.from, r.to, or(r.via), NA, NA, ext, NA, NA, `${r.from} serves ${r.to} (${r.kind.toLowerCase()}${r.via ? `: ${r.via}` : ""})`,
      ]),
    ),
  );
  sheets.push(cobieSheet("Spare", "Name:R CreatedBy:F CreatedOn:R Category:F TypeName:F Suppliers:F ExternalSystem:E ExternalObject:E ExternalIdentifier:E Description:O SetNumber:O PartNumber:O", []));
  sheets.push(cobieSheet("Resource", "Name:R CreatedBy:F CreatedOn:R Category:F ExternalSystem:E ExternalObject:E ExternalIdentifier:E Description:O", []));
  sheets.push(
    cobieSheet(
      "Job",
      "Name:R CreatedBy:F CreatedOn:R Category:F Status:F TypeName:F Description:R Duration:R DurationUnit:F Start:R TaskStartUnit:F Frequency:R FrequencyUnit:F ExternalSystem:E ExternalObject:E ExternalIdentifier:E TaskNumber:O Priors:O ResourceNames:O",
      reg.jobs.map((j) => [j.name, by, on, "PM", "Not Yet Started", j.typeName, j.description, j.duration ?? NA, or(j.durationUnit), NA, NA, j.frequency ?? NA, or(j.frequencyUnit), ext, NA, NA, j.taskNumber, NA, NA]),
    ),
  );
  sheets.push(cobieSheet("Impact", "Name:R CreatedBy:F CreatedOn:R ImpactType:F ImpactStage:F SheetName:F RowName:F Value:R ImpactUnit:F LeadInTime:O Duration:O LeadOutTime:O ExternalSystem:E ExternalObject:E ExternalIdentifier:E Description:O", []));
  sheets.push(
    cobieSheet(
      "Document",
      "Name:R CreatedBy:F CreatedOn:R Category:F ApprovalBy:F Stage:F SheetName:F RowName:F Directory:R File:R ExternalSystem:E ExternalObject:E ExternalIdentifier:E Description:O Reference:O",
      reg.types.filter((t) => /^https?:\/\//i.test(t.values.url)).map((t) => [`${t.name} product information`.slice(0, 255), by, on, "Product Data", NA, "Submitted", "Type", t.name, t.values.url, NA, ext, NA, NA, "Manufacturer product information", t.values.url]),
    ),
  );

  // Attribute: every property of every component, type and model room, the register's own reading first (so
  // Excel's row limit, if reached, cuts raw properties rather than normalised values).
  const attributes: Cell[][] = [];
  const LIMIT = 1_000_000;
  let skipped = 0;
  // Not attributes: what the Component and Type rows already say (name, category, family, type, ids, level,
  // workset, phase) and the modelling internals of an element (its host, offset, volume, area, design option).
  const IDENTITY = /^(item\/.*|[^/]*\/(name|category|family|type|family name|type name|family and type|id|type id|element id|guid|ifcguid|workset|phase created|phase demolished|edited by|design option|host|host id|level|schedule level|reference level|base level|level \(shared\)|offset|elevation|elevation from level|volume|area|image|use annotation scale|moves with nearby elements))$/i;
  const pushProps = (sheet: string, row: string, guid: string, props: Record<string, unknown>, units: Record<string, string> = {}) => {
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith("__") || (sheet !== "Space" && IDENTITY.test(key))) continue;
      const v = cleanText(value);
      if (!v) continue;
      if (attributes.length >= LIMIT) {
        skipped++;
        continue;
      }
      const slash = key.indexOf("/");
      const group = slash > 0 ? key.slice(0, slash) : "";
      const name = slash > 0 ? key.slice(slash + 1) : key;
      attributes.push([name, by, on, "Submitted", sheet, row, v, units[key] || NA, ext, group || NA, guid, group || NA, NA]);
    }
  };
  for (const t of reg.types) pushProps("Type", t.name, t.guid, t.props);
  // The register's own reading of each asset: kind, codes, and electrical, technical and fire values in one unit each.
  const normalised = FIELDS.filter((f) => f.group === "electrical" || f.group === "technical" || f.group === "fire" || f.group === "cafm");
  for (const a of reg.assets) {
    const own: [string, Cell, string][] = [
      ["AssetKind", a.kind, NA],
      ["AssetCode", a.code, NA],
      ["LocationCode", a.locationCode, NA],
      ["Discipline", a.discipline, NA],
    ];
    if (a.uniclass) own.push(["UniclassPr", `${a.uniclass[0]}: ${a.uniclass[1]}`, NA]);
    if (a.compliance) own.push(["ComplianceGroup", a.compliance, NA]);
    for (const f of normalised) if (a.values[f.id]) own.push([f.label, fieldCell(a, f.id), f.unit || NA]);
    for (const [name, value, unit] of own) {
      if (value === null || value === "") continue;
      if (attributes.length >= LIMIT) {
        skipped++;
        continue;
      }
      attributes.push([name, by, on, "Submitted", "Component", a.name, value, unit, ext, "IFC Studio register", a.guid, "Read and normalised from the model by IFC Studio", NA]);
    }
  }
  for (const a of reg.assets) {
    const own: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a.props)) if (!/^(revit type|type)\//i.test(k)) own[k] = v;
    pushProps("Component", a.name, a.guid, own, a.units);
  }
  for (const sp of reg.spaces) if (sp.source === "element") pushProps("Space", sp.name, sp.guid, sp.props);
  sheets.push(cobieSheet("Attribute", "Name:R CreatedBy:F CreatedOn:R Category:F SheetName:F RowName:F Value:R Unit:F ExternalSystem:E ExternalObject:E ExternalIdentifier:E Description:O AllowedValues:O", attributes));
  sheets.push(
    cobieSheet(
      "Coordinate",
      "Name:R CreatedBy:F CreatedOn:R Category:F SheetName:F RowName:F CoordinateXAxis:R CoordinateYAxis:R CoordinateZAxis:R ExternalSystem:E ExternalObject:E ExternalIdentifier:E ClockwiseRotation:O ElevationalRotation:O YawRotation:O",
      reg.assets.filter((a) => a.position).map((a) => [a.name, by, on, "point", "Component", a.name, mm(a.position![0]), mm(a.position![1]), mm(a.position![2]), ext, NA, NA, NA, NA, NA]),
    ),
  );
  const issues = reg.issues.map((i) => [i.kind.slice(0, 255), by, on, "Other", "Low", "Moderate", "Low", i.sheet, or(i.row), NA, NA, i.message, by, "Review in the model and fill in", ext, NA, NA] as Cell[]);
  if (skipped) issues.push(["Attributes left out", by, on, "Other", "Low", "High", "Low", "Attribute", NA, NA, NA, `${skipped} property values did not fit Excel's row limit and are not in the Attribute sheet.`, by, "Use the asset register workbook's Asset Properties sheet", ext, NA, NA]);
  sheets.push(cobieSheet("Issue", "Name:R CreatedBy:F CreatedOn:R Type:F Risk:F Chance:F Impact:F SheetName1:F RowName1:F SheetName2:F RowName2:F Description:R Owner:F Mitigation:R ExternalSystem:E ExternalObject:E ExternalIdentifier:E", issues));
  sheets.push({
    name: "PickLists",
    columns: ["AssetType", "DurationUnit", "Category-Role", "ConnectionType", "JobType", "JobStatusType", "CoordinateType", "ZoneType", "FloorType"].map((h) => ({ header: h, style: "plain" as HeaderStyle })),
    rows: [
      ["Fixed", "Year", "Information Manager", "Serves", "PM", "Not Yet Started", "point", "Department", "Floor"],
      ["Moveable", "Month", "", "Electrical Supply", "", "", "", "HVAC Zone", ""],
      ["", "Week", "", "Fire Alarm Loop", "", "", "", "Electrical Zone", ""],
      ["", "Day", "", "Signal", "", "", "", "Plumbing Zone", ""],
      ["", "Hour", "", "", "", "", "", "Fire Zone", ""],
      ["", "Minute", "", "", "", "", "", "Low Voltage Zone", ""],
    ],
    filter: false,
  });
  return writeXlsx(sheets, { title: `${s.projectName || s.buildingName} COBie`, creator: by, company: s.contactCompany });
}

// ---------------------------------------------------------------------------
// The flat register

const plain = (header: string, width?: number) => ({ header, width, style: "plain" as HeaderStyle });

function listText(list: string[], max = 2000): string {
  const text = list.join(", ");
  return text.length > max ? `${text.slice(0, max)}… (${list.length} in all)` : text;
}

export async function registerWorkbook(reg: AssetRegister, s: WorkbookSettings): Promise<Blob> {
  const sheets: SheetDef[] = [];
  const fieldLabel = (id: string) => FIELD_BY_ID.get(id)?.label ?? id;
  const derived = (a: RegisterAsset, id: string) => (a.derived.includes(id) ? " (derived)" : "");
  const pct = (n: number, total: number) => (total ? Math.round((1000 * n) / total) / 10 : 0);

  sheets.push({
    name: "About",
    columns: [plain("Item", 28), plain("Value", 110)],
    filter: false,
    rows: [
      ["Project", s.projectName],
      ["Building", s.buildingName],
      ["Site", s.siteName],
      ["Source models", s.sources.join(", ")],
      ["Created", new Date().toISOString().slice(0, 16).replace("T", " ")],
      ["Assets", reg.stats.assets],
      ["Asset types", reg.stats.types],
      ["Spaces", `${reg.stats.spaces} (${reg.stats.spacesFromModel} rooms of the model, the rest named by assets)`],
      ["Assets placed in a space", `${reg.stats.withSpace} of ${reg.stats.assets}${reg.stats.spaceByGeometry ? ` (${reg.stats.spaceByGeometry} from room geometry)` : ""}`],
      ["Systems", reg.stats.systems],
      ["Serving relationships", reg.stats.relations],
      ["Electrical boards", `${reg.stats.boards} in the model, ${reg.electrical.boards.length - reg.stats.boards} more named by what they feed; ${reg.stats.circuits} circuits`],
      ["Fire and life safety assets", reg.stats.fireDevices],
      ["Assets with technical data", reg.stats.withTechnical],
      ["", ""],
      ["Sheets", ""],
      ["Assets", "One row per asset: asset code, kind, identity, type, manufacturer, model, serial, dates, warranty, life, PPM, location code and path, floor, space, systems, what serves it, what it serves, the spaces it serves, parent and parts, classification, and blank criticality, maintainer and statutory columns for the FM team. Asset ID is the IFC GlobalId used in the IFC files."],
      ["Technical Data", "MEP technical values of each asset that has any, each in one unit: airflow, water flow, capacities, motor power, pressures, refrigerant, electrical supply, lighting and lift data."],
      ["Electrical Boards", "Sources and boards as a tree (the single-line diagram as a table): level, what each is fed from, the path from the source, ratings, loads, the boards and items it feeds."],
      ["Circuits", "The circuits leaving each board for the items it feeds, with what they feed and their load."],
      ["Fire & Life Safety", "Fire alarm devices with panel, loop, address and zone; sprinklers, dampers, fire doors, extinguishers and emergency lighting with their ratings."],
      ["Spaces", "Rooms with floor, areas, the assets in them and the equipment serving them."],
      ["Types", "One row per family type with its type-level information."],
      ["Systems", "Distribution systems with their equipment and members."],
      ["Relationships", "Who serves whom: shared system (equipment to the terminals and devices of its system), electrical supply (board to fed items), or stated in a property."],
      ["PPM", "Planned maintenance found in the model (empty when the model has none)."],
      ["Coverage", "How many assets have each field, and where it was read from. Gaps are left blank, not estimated."],
      ["Coverage by category", "The same for the key fields, per category."],
      ["Data issues", "Values that differ within a type, unknown rooms or boards, duplicate tags."],
      ["Asset Properties", "Every property of every asset, one column per property."],
      ["", ""],
      ["Derived values", "Marked \"(derived)\": warranty end = warranty start + warranty duration; end of life = installation (or manufacturing) year + expected life. Spaces from room geometry are marked in Space Source. A board's connected load that the model does not give is the sum of what it feeds. A classification read from a family name that starts with a Uniclass code (\"60_70_22_22_DistributionBoards\") is marked too."],
      ["Units", "Airflow and water flow L/s, capacities and motor power kW, loads kVA, pressure Pa, pump head kPa, current A, fault level kA, voltage V, weight kg, volume L, speed m/s, temperature °C, durations h. Values in other units are converted."],
      ["Asset codes", "Made from the code pattern set on the Convert page ({building}-{floor}-{kind}-{seq} unless changed), numbered within each prefix by floor, room and tag. Location code: site-building-floor-room."],
      ["Suggested values", "Asset kind, compliance group and the Uniclass 2015 product code are suggestions from what each asset is (family, type and name), to be checked. Uniclass 2015 codes and titles: NBS, from its published tables (January 2022 edition); a classification in the model always comes first."],
    ],
  });

  const assetColumns = [
    "Asset ID (IFC GlobalId)", "Asset Code", "Asset Name", "Tag / Mark", "Asset Kind", "Kind Code", "Discipline", "Category", "Family", "Type", "Type Mark", "Type Name", "Description",
    "Manufacturer", "Model", "Model Reference", "Serial Number", "Bar Code", "Asset Identifier", "Manufacturing Year", "Installation Date", "Warranty Start", "Warranty (years)", "Warranty End",
    "Warranty Guarantor", "Expected Life (years)", "End of Life", "Replacement Cost", "Condition", "Status", "Supplier", "Installed By", "PPM Task", "PPM Frequency", "PPM Frequency Unit",
    "Location Code", "Location Path", "Floor", "Revit Level", "Space", "Room Name", "Space Source", "Systems", "System Classification", "Fed From (board)", "Circuit", "Served By",
    "Serves", "Serving Spaces", "Parent Asset", "Parts", "Classification", "Classification Title", "Uniclass Pr (suggested)", "Uniclass Title", "Compliance (suggested)",
    "Criticality", "Maintainer", "Statutory", "IFC Class", "Revit Element ID", "Source File", "X (m)", "Y (m)", "Z (m)", "Derived Fields",
  ];
  const spaceByName = new Map(reg.spaces.map((sp) => [sp.name, sp]));
  sheets.push({
    name: "Assets",
    tab: "2563EB",
    columns: assetColumns.map((h) => plain(h)),
    rows: reg.assets.map((a) => {
      const v = a.values;
      const freq = frequency(v.ppmFrequency, v.ppmFrequencyUnit);
      const round = (n: number) => Math.round(n * 1000) / 1000;
      const notes = [...a.derived.map(fieldLabel), ...(a.panelSource === "text" ? ["Fed from (read from the element's text)"] : [])];
      return [
        a.guid, a.code, a.name, v.tag, a.kind, a.kindCode, a.discipline, a.category, a.family, a.type, v.typeMark, a.typeName, v.comments || v.typeDescription,
        v.manufacturer, v.model, v.modelReference, v.serialNumber, v.barCode, v.assetIdentifier, v.manufactureYear, v.installationDate, v.warrantyStartDate,
        years(v.warrantyDurationParts, v.warrantyDurationUnit), v.warrantyEndDate + derived(a, "warrantyEndDate"), v.warrantyGuarantorParts, years(v.expectedLife, v.durationUnit),
        v.endOfLife + derived(a, "endOfLife"), parseNumber(v.replacementCost) ?? v.replacementCost, v.condition, v.status, v.supplier, v.installer, v.ppmTask, freq.value, freq.unit,
        a.locationCode, a.locationPath, a.floor, a.level, a.space, spaceByName.get(a.space)?.roomName ?? "", a.spaceSource,
        a.systems.map((x) => x.name).join(", "), [...new Set(a.systems.map((x) => x.classification).filter(Boolean))].join(", "), v.panel, v.circuit,
        listText(a.servedBy), listText(a.serves), listText(a.servingSpaces), a.parent, listText(a.children), v.classification, v.classificationTitle,
        v.classification ? "" : (a.uniclass?.[0] ?? ""), v.classification ? "" : (a.uniclass?.[1] ?? ""), a.compliance, v.criticality, v.maintainer, v.statutory,
        a.ifcClass, a.elementId, a.file, a.position ? round(a.position[0]) : null, a.position ? round(a.position[1]) : null, a.position ? round(a.position[2]) : null,
        notes.join(", "),
      ].map((x) => (typeof x === "string" ? x.trim() : x));
    }),
  });
  sheets.push({
    name: "Spaces",
    columns: ["Space", "Room Name", "Room Number", "Floor", "Category", "Department / Zone", "Occupant", "Gross Area (m²)", "Net Area (m²)", "Height (m)", "Source", "Assets in Space", "Assets", "Served By", "IFC GlobalId", "Revit Element ID", "Source File"].map((h) => plain(h)),
    rows: reg.spaces.map((sp) => [
      sp.name, sp.roomName, sp.number, sp.floor, sp.category, sp.department, sp.occupant, sp.grossArea, sp.netArea, sp.height,
      sp.source === "element" ? "Room in the model" : "Named by assets (no room in the model)", sp.assets.length, listText(sp.assets), listText([...new Set(sp.servedBy)]), sp.guid, sp.elementId, sp.file,
    ]),
  });
  sheets.push({
    name: "Types",
    columns: ["Type Name", "Category", "Family", "Type", "Type Mark", "Asset Kind", "Description", "Manufacturer", "Model", "Model Reference", "Asset Type", "Classification", "Uniclass Pr (suggested)", "Expected Life (years)", "Warranty (years)", "Warranty Guarantor", "Replacement Cost", "PPM Task", "PPM Frequency", "PPM Frequency Unit", "Product URL", "Assets", "IFC Type", "Values Differ For"].map((h) => plain(h)),
    rows: reg.types.map((t) => {
      const v = t.values;
      const freq = frequency(v.ppmFrequency, v.ppmFrequencyUnit);
      return [
        t.name, t.revitCategory, t.family, t.type, v.typeMark, t.kind, v.typeDescription, v.manufacturer, v.model, v.modelReference, t.assetType, v.classification,
        v.classification ? "" : t.uniclass ? `${t.uniclass[0]}: ${t.uniclass[1]}` : "", years(v.expectedLife, v.durationUnit),
        years(v.warrantyDurationParts, v.warrantyDurationUnit), v.warrantyGuarantorParts, parseNumber(v.replacementCost) ?? v.replacementCost, v.ppmTask, freq.value, freq.unit, v.url, t.assets.length, t.ifcTypeClass || t.ifcClass,
        Object.keys(t.conflicts).map(fieldLabel).join(", "),
      ];
    }),
  });
  sheets.push({
    name: "Systems",
    columns: ["System", "Classification", "System Type", "From", "IFC System Type", "Uniclass Ss (suggested)", "Feeding Equipment", "Members", "Member Assets"].map((h) => plain(h)),
    rows: reg.systems.map((sys) => [
      sys.name, sys.classification, sys.type, sys.origin === "model" ? "Model" : sys.origin === "electrical" ? "Board's circuits" : "Fire alarm panel", sys.ifcType,
      sys.uniclass ? `${sys.uniclass[0]}: ${sys.uniclass[1]}` : "", sys.sources.join(", "), new Set(sys.members).size, listText([...new Set(sys.members)]),
    ]),
  });
  const ident = (a: RegisterAsset) => [a.guid, a.code, a.name, a.kind, a.category, a.typeName];
  const identHeaders = ["Asset ID (IFC GlobalId)", "Asset Code", "Asset Name", "Asset Kind", "Category", "Type Name"];
  sheets.push({
    name: "Technical Data",
    tab: "0E9F6E",
    columns: [...identHeaders, ...TECHNICAL_COLUMNS.map(columnLabel), "Floor", "Space"].map((h) => plain(h)),
    rows: reg.assets.filter((a) => TECHNICAL_COLUMNS.some((id) => a.values[id])).map((a) => [...ident(a), ...TECHNICAL_COLUMNS.map((id) => fieldCell(a, id)), a.floor, a.space]),
  });
  sheets.push({
    name: "Electrical Boards",
    tab: "D97706",
    columns: [
      "Board", "Asset ID (IFC GlobalId)", "Kind", "Level", "Fed From", "Feed Path", "Voltage (V)", "Phases", "Distribution System", "Main Rating (A)", "Ways", "Connected Load (kVA)",
      "Connected Load From", "Demand Load (kVA)", "Fault Level (kA)", "IP Rating", "Boards Fed", "Circuits", "Items Fed", "Items Downstream", "Floor", "Space", "In the Model", "Copies (same panel name)",
    ].map((h) => plain(h)),
    rows: reg.electrical.boards.map((b) => [
      b.name, b.guid, b.kind, b.level, b.fedFrom, b.path.join(" > "), b.voltage, b.phases, b.distributionSystem, b.mainsRating, b.ways, b.connectedLoad,
      b.connectedLoadSource === "model" ? "Model" : b.connectedLoadSource === "sum of loads" ? "Sum of what it feeds" : "", b.demandLoad, b.faultLevel, b.ipRating,
      listText(b.boards), b.circuits, b.items.length, b.downstream, b.floor, b.space, b.inModel ? "Yes" : "No (named by what it feeds)", listText(b.copies),
    ]),
  });
  sheets.push({
    name: "Circuits",
    columns: ["Board", "Circuit", "Load Name", "Poles", "Breaker (A)", "Cable", "Voltage (V)", "Items", "Connected Load (kVA)", "Floors", "Spaces", "Item Names"].map((h) => plain(h)),
    rows: reg.electrical.circuits.map((c) => [c.board, c.circuit || "(no circuit number)", c.loadName, c.poles, c.breakerRating, c.cable, c.voltage, c.items.length, c.connectedLoad, c.floors.join(", "), listText(c.spaces), listText(c.items)]),
  });
  sheets.push({
    name: "Fire & Life Safety",
    tab: "DC2626",
    columns: [...identHeaders, ...FIRE_COLUMNS.map(columnLabel), "Systems", "Fed From (board)", "Floor", "Space", "Location Code", "Compliance (suggested)"].map((h) => plain(h)),
    rows: reg.assets.filter(lifeSafety).map((a) => [...ident(a), ...FIRE_COLUMNS.map((id) => fieldCell(a, id)), a.systems.map((x) => x.name).join(", "), a.values.panel, a.floor, a.space, a.locationCode, a.compliance]),
  });
  const assetByName = new Map(reg.assets.map((a) => [a.name, a]));
  sheets.push({
    name: "Relationships",
    columns: ["Serving Asset", "Serving Category", "Served Asset", "Served Category", "Served Space", "Relationship", "Via (system / board)"].map((h) => plain(h)),
    rows: reg.relations.map((r) => [r.from, assetByName.get(r.from)?.category, r.to, assetByName.get(r.to)?.category, assetByName.get(r.to)?.space, r.kind, r.via]),
  });
  sheets.push({
    name: "PPM",
    columns: ["Type Name", "Task", "Frequency", "Frequency Unit", "Duration", "Duration Unit", "Assets"].map((h) => plain(h)),
    rows: reg.jobs.length
      ? reg.jobs.map((j) => [j.typeName, j.name, j.frequency, j.frequencyUnit, j.duration, j.durationUnit, reg.types.find((t) => t.name === j.typeName)?.assets.length ?? 0])
      : [["No planned maintenance (PPM) data was found in the model's properties.", "", "", "", "", "", ""]],
  });
  sheets.push({
    name: "Coverage",
    columns: ["Field", "Group", "Level", "Filled", "Of", "Filled %", "Read From", "Read Automatically", "Also Found By"].map((h) => plain(h)),
    rows: reg.sources.map((f) => {
      const def = FIELD_BY_ID.get(f.field);
      return [f.label + (def?.unit ? ` (${def.unit})` : ""), def?.group ? FIELD_GROUP_LABELS[def.group] : "", f.level, f.filled, f.total, pct(f.filled, f.total), f.keys.slice(0, 6).join("; "), f.auto ? "Yes" : "No (chosen)", f.note ?? ""];
    }),
  });
  const KEY_FIELDS = ["manufacturer", "model", "serialNumber", "installationDate", "manufactureYear", "warrantyStartDate", "warrantyDurationParts", "expectedLife", "endOfLife", "ppmFrequency", "tag"];
  const byCategory = new Map<string, RegisterAsset[]>();
  for (const a of reg.assets) byCategory.set(a.category, [...(byCategory.get(a.category) ?? []), a]);
  sheets.push({
    name: "Coverage by category",
    columns: [plain("Category"), plain("Assets"), ...KEY_FIELDS.map((f) => plain(`${fieldLabel(f)} %`)), plain("Space %"), plain("System %"), plain("Served By %")],
    rows: [...byCategory]
      .sort((x, y) => y[1].length - x[1].length)
      .map(([cat, list]) => [
        cat, list.length, ...KEY_FIELDS.map((f) => pct(list.filter((a) => a.values[f]).length, list.length)), pct(list.filter((a) => a.space).length, list.length),
        pct(list.filter((a) => a.systems.length).length, list.length), pct(list.filter((a) => a.servedBy.length).length, list.length),
      ]),
  });
  sheets.push({
    name: "Data issues",
    columns: [plain("Issue"), plain("Sheet"), plain("Row"), plain("Details", 100)],
    rows: reg.issues.map((i) => [i.kind, i.sheet, i.row, i.message]),
  });

  // Every property, one column each (most filled first; Excel allows 16,384 columns).
  const keys = reg.properties.slice(0, 16_000).map((p) => p.key);
  const col = new Map(keys.map((k, i) => [k, i + 2]));
  sheets.push({
    name: "Asset Properties",
    columns: [plain("Asset ID (IFC GlobalId)"), plain("Asset Name"), ...keys.map((k) => plain(k.replace("/", ": ")))],
    // Sparse: a model read with every property has thousands of columns, few of them filled per asset.
    rows: reg.assets.map((a) => {
      const cells: [number, Cell][] = [
        [0, a.guid],
        [1, a.name],
      ];
      for (const [k, v] of Object.entries(a.props)) {
        const i = col.get(k);
        if (i === undefined) continue;
        const text = typeof v === "number" ? (v !== 0 ? v : "") : cleanText(v);
        if (text !== "") cells.push([i, text]);
      }
      return { sparse: cells.sort((x, y) => x[0] - y[0]) };
    }),
  });
  return writeXlsx(sheets, { title: `${s.projectName || s.buildingName} asset register`, creator: s.contactEmail || "IFC Studio", company: s.contactCompany });
}

/** A duration in years as a number (months become fractions), or the text as given when it cannot be read. */
function years(raw: string, unitRaw: string): Cell {
  const n = durationYears(parseDuration(raw, parseUnit(unitRaw) || "year"));
  return n === null ? raw : Math.round(n * 1000) / 1000;
}

/** A PPM frequency as a number and a COBie unit word ("Quarterly" is 3 Month), or the text as given. */
function frequency(raw: string, unitRaw: string): { value: Cell; unit: string } {
  const d = parseDuration(raw, parseUnit(unitRaw));
  return d ? { value: d.value, unit: unitWord(d.unit) } : { value: raw, unit: cleanText(unitRaw) };
}

/** IFC durations ("P15Y") of a type's warranty and service life, for the IFC writer. */
export function typeDurations(values: Record<string, string>): { warranty: string; life: string } {
  return {
    warranty: isoDuration(parseDuration(values.warrantyDurationParts, parseUnit(values.warrantyDurationUnit) || "year")),
    life: isoDuration(parseDuration(values.expectedLife, parseUnit(values.durationUnit) || "year")),
  };
}
