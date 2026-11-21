// Rule-based model health checks and a few inferred facts about the model.
//
// Every check answers one concrete question ("which elements have no
// material?") and returns the offending elements, so results can always be
// selected in 3D. Nothing here is a judgement about design quality: the checks
// look at how complete and consistent the model's data is.

import * as THREE from "three";
import { Kind, type ModelIndex } from "@/lib/data/model-index";
import { getModelUnits } from "@/lib/data/units";
import type { PlainIdMap } from "@/lib/store";
import { prettyCategory } from "@/lib/utils/format";
import { classMatches, escapeRegExp } from "./query";

export type Severity = "critical" | "serious" | "warning" | "info";

export interface CheckResult {
  id: string;
  title: string;
  /** One sentence on what was checked and why it matters. */
  description: string;
  severity: Severity;
  /** Number of elements the check applies to. */
  scope: number;
  failCount: number;
  failing: PlainIdMap;
  /** Optional extra line, e.g. the three most affected classes. */
  detail?: string;
  /** False when the check could not be evaluated for this model. */
  applicable: boolean;
}

export interface Insight {
  label: string;
  value: string;
  hint?: string;
}

export interface HealthReport {
  checks: CheckResult[];
  insights: Insight[];
  /** 0..100, weighted share of passing elements across the checks that count. */
  score: number;
  elementCount: number;
}

/** Classes that are not physical building elements and are exempt from most data checks. */
const NON_PHYSICAL = new Set([
  "IFCSPACE", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCPROJECT", "IFCANNOTATION", "IFCGRID", "IFCOPENINGELEMENT",
  "IFCOPENINGSTANDARDCASE", "IFCVIRTUALELEMENT", "IFCSPATIALZONE", "IFCELEMENTASSEMBLY", "IFCVOIDINGFEATURE", "IFCREFERENT",
  "IFCALIGNMENT", "IFCGEOGRAPHICELEMENT", "IFCDISTRIBUTIONPORT", "IFCEARTHWORKSCUT", "IFCEARTHWORKSFILL",
]);

const COMMON_PSET: Record<string, string> = {
  IFCWALL: "Pset_WallCommon",
  IFCSLAB: "Pset_SlabCommon",
  IFCBEAM: "Pset_BeamCommon",
  IFCCOLUMN: "Pset_ColumnCommon",
  IFCDOOR: "Pset_DoorCommon",
  IFCWINDOW: "Pset_WindowCommon",
  IFCROOF: "Pset_RoofCommon",
  IFCSTAIR: "Pset_StairCommon",
  IFCSTAIRFLIGHT: "Pset_StairFlightCommon",
  IFCRAMP: "Pset_RampCommon",
  IFCRAILING: "Pset_RailingCommon",
  IFCCOVERING: "Pset_CoveringCommon",
  IFCCURTAINWALL: "Pset_CurtainWallCommon",
  IFCMEMBER: "Pset_MemberCommon",
  IFCPLATE: "Pset_PlateCommon",
  IFCFOOTING: "Pset_FootingCommon",
  IFCPILE: "Pset_PileCommon",
  IFCSPACE: "Pset_SpaceCommon",
  IFCBUILDINGELEMENTPROXY: "Pset_BuildingElementProxyCommon",
};

function commonPsetFor(category: string): string | null {
  for (const [base, name] of Object.entries(COMMON_PSET)) if (classMatches(category, base)) return name;
  return null;
}

class Collector {
  readonly failing: PlainIdMap = {};
  count = 0;
  private readonly byClass = new Map<string, number>();

  add(index: ModelIndex, row: number) {
    (this.failing[index.modelId] ??= []).push(index.ids[row]);
    this.count += 1;
    const category = index.category(row);
    this.byClass.set(category, (this.byClass.get(category) ?? 0) + 1);
  }

  /** "Wall 120, Door 42, Slab 8" */
  topClasses(limit = 3): string | undefined {
    if (this.byClass.size === 0) return undefined;
    const top = [...this.byClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const text = top.map(([category, count]) => `${prettyCategory(category)} ${count}`).join(", ");
    return this.byClass.size > limit ? `${text} and ${this.byClass.size - limit} more classes` : text;
  }
}

function result(
  id: string,
  title: string,
  description: string,
  severity: Severity,
  scope: number,
  collector: Collector,
  options: { detail?: string; applicable?: boolean } = {},
): CheckResult {
  return {
    id,
    title,
    description,
    severity,
    scope,
    failCount: collector.count,
    failing: collector.failing,
    detail: options.detail ?? collector.topClasses(),
    applicable: options.applicable ?? true,
  };
}

function isPhysical(index: ModelIndex, row: number) {
  return !NON_PHYSICAL.has(index.category(row));
}

export type CheckProgress = (fraction: number, stage: string) => void;

/** Runs every check over every loaded model. */
export async function runHealthChecks(indexes: ModelIndex[], onProgress?: CheckProgress): Promise<HealthReport> {
  const stages = 9;
  let stage = 0;
  const step = (label: string) => onProgress?.(stage++ / stages, label);

  let elementCount = 0;
  let physicalCount = 0;
  for (const index of indexes) {
    elementCount += index.count;
    for (let row = 0; row < index.count; row++) if (isPhysical(index, row)) physicalCount += 1;
  }

  const checks: CheckResult[] = [];

  // --- Spatial structure --------------------------------------------------
  step("Spatial structure");
  {
    const orphans = new Collector();
    const noStorey = new Collector();
    let scope = 0;
    for (const index of indexes) {
      for (let row = 0; row < index.count; row++) {
        const category = index.category(row);
        if (category === "IFCSITE" || category === "IFCBUILDING" || category === "IFCPROJECT" || category === "IFCGRID" || category === "IFCANNOTATION") continue;
        scope += 1;
        if (index.containerOf[row] < 0 && index.parentOf[row] < 0) orphans.add(index, row);
        else if (index.storeyOf[row] < 0 && index.storeys.length > 0) noStorey.add(index, row);
      }
    }
    checks.push(
      result("spatial-orphans", "Not placed in the spatial structure", "Elements that belong to no site, building, storey or space. They are skipped by storey filters, plans and many downstream tools.", "serious", scope, orphans),
      result("no-storey", "Not assigned to a storey", "Elements contained directly in the site or building although the model has storeys.", "info", scope, noStorey),
    );
  }

  // --- Type links, property sets, materials -------------------------------------
  step("Property sets and materials");
  {
    const noPsets = new Collector();
    const noMaterial = new Collector();
    const noType = new Collector();
    const noQuantities = new Collector();
    const noCommon = new Collector();
    let commonScope = 0;

    for (const index of indexes) {
      const links = await index.typeLinks();
      // Names of every property set are needed for the "common Pset" check.
      const setIds = new Set<number>();
      for (const id of index.psets.values) setIds.add(id);
      for (const sets of links.psets.values()) for (const id of sets) if (index.kindOf(id) === Kind.PropertySet) setIds.add(id);
      const names = await index.psetNames(setIds);

      for (let row = 0; row < index.count; row++) {
        if (!isPhysical(index, row)) {
          // Spaces still have a standard common property set.
          if (index.category(row) !== "IFCSPACE") continue;
        }
        const physical = isPhysical(index, row);
        const type = index.typeOf[row];
        const typeSets = type >= 0 ? (links.psets.get(type) ?? []) : [];
        const ownPsets = index.psets.get(row);
        let psetCount = ownPsets.length;
        let qsetCount = index.qsets.count(row);
        for (const id of typeSets) {
          if (index.kindOf(id) === Kind.QuantitySet) qsetCount += 1;
          else psetCount += 1;
        }
        if (physical) {
          if (psetCount === 0) noPsets.add(index, row);
          if (index.materialsOfRow(row, links).length === 0) noMaterial.add(index, row);
          if (type < 0) noType.add(index, row);
          if (qsetCount === 0) noQuantities.add(index, row);
        }
        const expected = commonPsetFor(index.category(row));
        if (expected) {
          commonScope += 1;
          let found = false;
          for (let i = 0; i < ownPsets.length && !found; i++) found = names.get(ownPsets[i]) === expected;
          for (let i = 0; i < typeSets.length && !found; i++) found = names.get(typeSets[i]) === expected;
          if (!found) noCommon.add(index, row);
        }
      }
    }
    checks.push(
      result("no-psets", "No property sets", "Physical elements that carry no property set at all, on the element or on its type.", "serious", physicalCount, noPsets),
      result("no-common-pset", "Standard common property set missing", "Elements whose class has a standard Pset_…Common (for example Pset_WallCommon) that is absent. Fire rating, load bearing and external flags normally live there.", "warning", commonScope, noCommon),
      result("no-material", "No material", "Physical elements with no material assigned on the element or its type. Quantities by material and many cost and carbon workflows depend on it.", "warning", physicalCount, noMaterial),
      result("no-type", "No type object", "Physical elements that are not linked to a type. Types carry shared properties and make schedules consistent.", "info", physicalCount, noType),
      result("no-quantities", "No base quantities", "Physical elements without an IfcElementQuantity set. Take-off then relies on measured properties or on volumes computed from geometry.", "info", physicalCount, noQuantities),
    );
  }

  // --- Names ----------------------------------------------------------------
  step("Names");
  {
    const unnamed = new Collector();
    let scope = 0;
    for (const index of indexes) {
      const categories = index.categories.map((category) => new RegExp(`^${escapeRegExp(category)}$`));
      const named = new Set(await index.model.getItemsByQuery({ categories, attributes: { queries: [{ name: /^Name$/, value: /\S/ }] } }));
      for (let row = 0; row < index.count; row++) {
        if (!isPhysical(index, row)) continue;
        scope += 1;
        if (!named.has(index.ids[row])) unnamed.add(index, row);
      }
    }
    checks.push(result("unnamed", "No name", "Physical elements with an empty Name. They are hard to find in schedules and issue reports.", "warning", scope, unnamed));
  }

  // --- GlobalIds ------------------------------------------------------------------
  step("GlobalIds");
  {
    const duplicates = new Collector();
    const missing = new Collector();
    let groups = 0;
    for (const index of indexes) {
      const ids = Array.from(index.ids);
      const seen = new Map<string, number[]>();
      for (let start = 0; start < ids.length; start += 50_000) {
        const batch = ids.slice(start, start + 50_000);
        const guids = await index.model.getGuidsByLocalIds(batch);
        for (let i = 0; i < batch.length; i++) {
          const guid = guids[i];
          const row = start + i;
          if (!guid) {
            missing.add(index, row);
            continue;
          }
          let rows = seen.get(guid);
          if (!rows) seen.set(guid, (rows = []));
          rows.push(row);
        }
      }
      for (const rows of seen.values()) {
        if (rows.length < 2) continue;
        groups += 1;
        for (const row of rows) duplicates.add(index, row);
      }
    }
    checks.push(
      result("duplicate-guid", "Duplicate GlobalIds", "Elements sharing a GlobalId inside one model. GlobalIds must be unique: issue tracking, model comparison and BCF all key on them.", "critical", elementCount, duplicates, {
        detail: groups > 0 ? `${groups} GlobalId${groups === 1 ? " is" : "s are"} used more than once` : undefined,
      }),
      result("missing-guid", "No GlobalId", "Elements without a GlobalId.", "critical", elementCount, missing),
    );
  }

  // --- Classification and proxies -----------------------------------------------
  step("Classification");
  {
    const unclassified = new Collector();
    const proxies = new Collector();
    let classified = 0;
    for (const index of indexes) {
      const links = await index.typeLinks();
      for (let row = 0; row < index.count; row++) {
        if (!isPhysical(index, row)) continue;
        if (classMatches(index.category(row), "IFCBUILDINGELEMENTPROXY")) proxies.add(index, row);
        if (index.classificationsOfRow(row, links).length > 0) classified += 1;
        else unclassified.add(index, row);
      }
    }
    checks.push(
      result(
        "unclassified",
        "No classification reference",
        classified > 0
          ? "Physical elements without a classification reference, in a model that classifies others (for example Uniclass, OmniClass or a national system)."
          : "No element carries a classification reference. This is only a finding if your project requires a classification system.",
        classified > 0 ? "warning" : "info",
        physicalCount,
        unclassified,
        { applicable: true },
      ),
      result("proxies", "Generic proxy elements", "Elements exported as IfcBuildingElementProxy, which means the authoring tool had no better class for them. Filters and rules by class will miss them.", "warning", physicalCount, proxies),
    );
  }

  // --- Hosted elements ---------------------------------------------------------------
  step("Doors and windows");
  {
    const unhosted = new Collector();
    let scope = 0;
    for (const index of indexes) {
      const rows: number[] = [];
      for (let row = 0; row < index.count; row++) {
        const category = index.category(row);
        if (classMatches(category, "IFCDOOR") || classMatches(category, "IFCWINDOW")) rows.push(row);
      }
      scope += rows.length;
      for (let start = 0; start < rows.length; start += 20_000) {
        const batch = rows.slice(start, start + 20_000);
        const relations = await index.model.getRelations(batch.map((row) => index.ids[row]));
        for (const row of batch) {
          const data = relations.get(index.ids[row])?.data;
          if (!data?.FillsVoids || data.FillsVoids.length === 0) unhosted.add(index, row);
        }
      }
    }
    checks.push(result("unhosted", "Doors and windows without a host opening", "Doors and windows that do not fill an opening in a wall or slab. They will not move with their host and are missed by host-based schedules.", "info", scope, unhosted, { applicable: scope > 0 }));
  }

  // --- Geometry ------------------------------------------------------------------------
  step("Geometry");
  const extents = new THREE.Box3();
  {
    const degenerate = new Collector();
    const outliers = new Collector();
    const duplicates = new Collector();
    let duplicateGroups = 0;
    for (const index of indexes) {
      const ids = Array.from(index.ids);
      const centers = new Float64Array(index.count * 3);
      const mins = new Float64Array(index.count * 3);
      const maxs = new Float64Array(index.count * 3);
      const valid = new Uint8Array(index.count);
      const seen = new Map<string, number[]>();
      for (let start = 0; start < ids.length; start += 20_000) {
        const batch = ids.slice(start, start + 20_000);
        // getBoxes already returns world-space boxes (the model transform is applied).
        const boxes = await index.model.getBoxes(batch);
        for (let i = 0; i < batch.length; i++) {
          const row = start + i;
          const box = boxes[i];
          if (!box) continue;
          if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) continue;
          const sx = box.max.x - box.min.x;
          const sy = box.max.y - box.min.y;
          const sz = box.max.z - box.min.z;
          valid[row] = 1;
          centers[row * 3] = (box.min.x + box.max.x) / 2;
          centers[row * 3 + 1] = (box.min.y + box.max.y) / 2;
          centers[row * 3 + 2] = (box.min.z + box.max.z) / 2;
          mins[row * 3] = box.min.x;
          mins[row * 3 + 1] = box.min.y;
          mins[row * 3 + 2] = box.min.z;
          maxs[row * 3] = box.max.x;
          maxs[row * 3 + 1] = box.max.y;
          maxs[row * 3 + 2] = box.max.z;
          if (!isPhysical(index, row)) continue;
          // Smaller than a millimetre in every direction: nothing to see or measure.
          if (Math.max(sx, sy, sz) < 0.001) degenerate.add(index, row);
          const round = (value: number) => Math.round(value * 1000);
          const key = `${index.categoryOf[row]}|${round(box.min.x)}|${round(box.min.y)}|${round(box.min.z)}|${round(box.max.x)}|${round(box.max.y)}|${round(box.max.z)}`;
          let rows = seen.get(key);
          if (!rows) seen.set(key, (rows = []));
          rows.push(row);
        }
      }
      for (const rows of seen.values()) {
        if (rows.length < 2) continue;
        duplicateGroups += 1;
        for (const row of rows) duplicates.add(index, row);
      }

      const corner = new THREE.Vector3();
      const grow = (row: number) => {
        // The site (terrain) is usually far larger than the building; leave it out of the extents.
        if (index.category(row) === "IFCSITE") return;
        extents.expandByPoint(corner.set(mins[row * 3], mins[row * 3 + 1], mins[row * 3 + 2]));
        extents.expandByPoint(corner.set(maxs[row * 3], maxs[row * 3 + 1], maxs[row * 3 + 2]));
      };

      // Outliers: far from where most of the model is. The yardstick is the
      // distance within which 95 % of elements sit from the median centre.
      const xs: number[] = [];
      const ys: number[] = [];
      const zs: number[] = [];
      for (let row = 0; row < index.count; row++) {
        if (!valid[row]) continue;
        xs.push(centers[row * 3]);
        ys.push(centers[row * 3 + 1]);
        zs.push(centers[row * 3 + 2]);
      }
      if (xs.length >= 20) {
        const median = (values: number[]) => {
          const sorted = [...values].sort((a, b) => a - b);
          return sorted[sorted.length >> 1];
        };
        const cx = median(xs);
        const cy = median(ys);
        const cz = median(zs);
        const distances: number[] = [];
        for (let i = 0; i < xs.length; i++) distances.push(Math.hypot(xs[i] - cx, ys[i] - cy, zs[i] - cz));
        const sorted = [...distances].sort((a, b) => a - b);
        const reach = sorted[Math.floor(sorted.length * 0.95)] || 1;
        const limit = Math.max(reach * 8, 250);
        for (let row = 0; row < index.count; row++) {
          if (!valid[row]) continue;
          const distance = Math.hypot(centers[row * 3] - cx, centers[row * 3 + 1] - cy, centers[row * 3 + 2] - cz);
          if (distance > limit) outliers.add(index, row);
          else grow(row);
        }
      } else {
        for (let row = 0; row < index.count; row++) if (valid[row]) grow(row);
      }
    }
    checks.push(
      result("duplicate-geometry", "Possible duplicates", "Elements of the same class whose bounding boxes coincide to the millimetre. These are usually accidental copies that double quantities.", "serious", physicalCount, duplicates, {
        detail: duplicateGroups > 0 ? `${duplicateGroups} coinciding group${duplicateGroups === 1 ? "" : "s"}${duplicates.topClasses() ? ` · ${duplicates.topClasses()}` : ""}` : undefined,
      }),
      result("outliers", "Far from the rest of the model", "Elements much further away than everything else. Stray geometry like this breaks zoom-to-fit and coordinates.", "warning", elementCount, outliers),
      result("degenerate", "No measurable size", "Elements whose geometry is smaller than a millimetre in every direction.", "info", physicalCount, degenerate),
    );
  }

  // --- Insights ----------------------------------------------------------------------------
  step("Summary");
  const insights = await buildInsights(indexes, extents);

  // --- Score -----------------------------------------------------------------------------------
  const weights: Record<Severity, number> = { critical: 4, serious: 3, warning: 2, info: 0 };
  let weightSum = 0;
  let penalty = 0;
  for (const check of checks) {
    const weight = weights[check.severity];
    if (!check.applicable || check.scope === 0 || weight === 0) continue;
    weightSum += weight;
    penalty += weight * Math.min(1, check.failCount / check.scope);
  }
  const score = weightSum > 0 ? Math.round(100 * (1 - penalty / weightSum)) : 100;

  onProgress?.(1, "Done");
  return { checks, insights, score, elementCount };
}

// ---------------------------------------------------------------------------
// Inferred facts
// ---------------------------------------------------------------------------

const DISCIPLINES: { name: string; classes: RegExp }[] = [
  // Members, plates and slabs appear in every discipline, so they are not counted.
  { name: "Structural", classes: /^IFC(BEAM|COLUMN|FOOTING|PILE|REINFORCING|TENDON|MECHANICALFASTENER|FASTENER)/ },
  { name: "MEP", classes: /^IFC(FLOW|DUCT|PIPE|CABLE|AIRTERMINAL|SANITARYTERMINAL|LIGHTFIXTURE|ELECTRIC|ENERGYCONVERSION|DISTRIBUTION|VALVE|PUMP|FAN|BOILER|CHILLER|COIL|DAMPER|FIRESUPPRESSION|OUTLET|SWITCHINGDEVICE|JUNCTIONBOX|UNITARY|SPACEHEATER|TANK|WASTETERMINAL|STACKTERMINAL|LAMP|SENSOR|ACTUATOR|CONTROLLER|ALARM|COMMUNICATIONSAPPLIANCE|AUDIOVISUAL|PROTECTIVEDEVICE|TRANSFORMER|MOTORCONNECTION)/ },
  { name: "Architectural", classes: /^IFC(WALL|DOOR|WINDOW|CURTAINWALL|COVERING|STAIR|RAMP|RAILING|ROOF|FURNI|SYSTEMFURNITURE|SPACE|SHADINGDEVICE|CHIMNEY)/ },
];

async function buildInsights(indexes: ModelIndex[], extents: THREE.Box3): Promise<Insight[]> {
  const insights: Insight[] = [];
  const classCounts = new Map<string, number>();
  let total = 0;
  for (const index of indexes) {
    for (let row = 0; row < index.count; row++) {
      const category = index.category(row);
      classCounts.set(category, (classCounts.get(category) ?? 0) + 1);
      total += 1;
    }
  }

  // Discipline, inferred from which classes dominate.
  const disciplineCounts = DISCIPLINES.map((discipline) => {
    let count = 0;
    for (const [category, amount] of classCounts) if (discipline.classes.test(category)) count += amount;
    return { name: discipline.name, count };
  }).sort((a, b) => b.count - a.count);
  const assigned = disciplineCounts.reduce((sum, entry) => sum + entry.count, 0);
  if (assigned > 0) {
    const [first, second] = disciplineCounts;
    const share = first.count / assigned;
    const label = share >= 0.7 ? first.name : second && second.count / assigned >= 0.25 ? `${first.name} + ${second.name}` : `Mostly ${first.name.toLowerCase()}`;
    insights.push({
      label: "Discipline (inferred)",
      value: label,
      hint: disciplineCounts.filter((entry) => entry.count > 0).map((entry) => `${entry.name} ${Math.round((entry.count / assigned) * 100)}%`).join(" · "),
    });
  }

  // Authoring tool and schema, from the IFC header kept in the model metadata.
  const applications = new Set<string>();
  const schemas = new Set<string>();
  for (const index of indexes) {
    try {
      const metadata = await index.model.getMetadata<{ schema?: string; names?: string[] }>();
      if (metadata.schema) schemas.add(metadata.schema);
      const application = metadata.names?.[5];
      if (application) applications.add(application.replace(/\s+/g, " ").replace(/^IFC file generated by /i, "").replace(/\.$/, "").trim());
    } catch {
      /* metadata is optional */
    }
  }
  if (applications.size > 0) insights.push({ label: "Authored with", value: [...applications].join(" · ") });
  if (schemas.size > 0) insights.push({ label: "Schema", value: [...schemas].join(", ") });

  // Units.
  const units = new Set<string>();
  for (const index of indexes) {
    const modelUnits = await getModelUnits(index.model);
    units.add(modelUnits.declared ? modelUnits.length.symbol : "not declared");
  }
  insights.push({ label: "Length unit", value: [...units].join(", ") });

  // Storeys.
  const storeyCount = indexes.reduce((sum, index) => sum + index.storeys.length, 0);
  if (storeyCount > 0) {
    const elevations = indexes.flatMap((index) => index.storeys.map((storey) => storey.elevation)).filter((value): value is number => typeof value === "number");
    const emptyStoreys: string[] = [];
    for (const index of indexes) {
      const used = new Set<number>();
      for (let row = 0; row < index.count; row++) if (index.storeyOf[row] >= 0) used.add(index.storeyOf[row]);
      for (const storey of index.storeys) if (!used.has(storey.localId)) emptyStoreys.push(storey.name);
    }
    insights.push({
      label: "Storeys",
      value: `${storeyCount}`,
      hint: [
        elevations.length > 1 ? `elevations ${Math.min(...elevations).toFixed(2)} to ${Math.max(...elevations).toFixed(2)} m` : null,
        emptyStoreys.length > 0 ? `${emptyStoreys.length} without elements (${emptyStoreys.slice(0, 3).join(", ")}${emptyStoreys.length > 3 ? "…" : ""})` : null,
      ].filter(Boolean).join(" · ") || undefined,
    });
  }

  // Overall size.
  if (!extents.isEmpty()) {
    const size = extents.getSize(new THREE.Vector3());
    const footprint = [size.x, size.z].sort((a, b) => b - a);
    insights.push({ label: "Extents", value: `${footprint[0].toFixed(1)} × ${footprint[1].toFixed(1)} m, ${size.y.toFixed(1)} m high`, hint: "Building elements only, without the site and far-away strays" });
  }

  // Largest classes.
  const top = [...classCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (top.length > 0) {
    insights.push({
      label: "Most common",
      value: top.map(([category, count]) => `${prettyCategory(category)} ${Math.round((count / total) * 100)}%`).join(" · "),
    });
  }
  return insights;
}
