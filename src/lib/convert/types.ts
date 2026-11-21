// Types shared by the conversion worker and the Convert page.

import type { StoreyDef } from "./storeys";

export type { StoreyDef };

export type BBox = [number, number, number, number, number, number];

/** One source file inside an extracted model (a file root of a federated NWD, or a whole RVT). */
export interface PartSummary {
  /** "<job>#<root dbId>" */
  id: string;
  job: string;
  root: number;
  /** File name as the model tree shows it. */
  name: string;
  /** Name of the model it came from (the NWD / RVT the viewer opened). */
  model: string;
  elements: number;
  fragments: number;
  triangles: number;
  categories: Record<string, number>;
  levels: Record<string, number>;
  /** Metres, in the model's own coordinates. */
  bbox: BBox | null;
  suggestion: { id: string; reason: string };
  /** Format of the extraction (1 = legacy files, 2 = current extractor). */
  format: number;
  propsMode: "key" | "all" | "none";
}

export interface JobSummary {
  name: string;
  model: string;
  bytes: number;
  parts: string[];
  stats: Record<string, number>;
  unitScale: number;
}

export interface PartConfig {
  id: string;
  include: boolean;
  discipline: string;
}

export interface FrameConfig {
  /** auto: keep model coordinates unless they are far from the origin, then centre the site there. */
  mode: "auto" | "model" | "custom";
  /** Site origin in metres (model coordinates) and rotation of the project X axis, for "custom". */
  origin: [number, number, number];
  rotationDeg: number;
}

export interface PlanWall {
  a: [number, number];
  b: [number, number];
  /** Metres. */
  thickness: number;
  external?: boolean;
}

/** A traced floor plan, in metres in the project frame (relative to the site origin). */
export interface PlanPart {
  id: string;
  name: string;
  source: string;
  discipline: string;
  include: boolean;
  storey: { name: string; elevation: number; height: number };
  walls: PlanWall[];
  slab: { outline: [number, number][]; thickness: number } | null;
}

export interface ConvertOptions {
  projectName: string;
  siteName: string;
  buildingName: string;
  /** Prefix of the output file names. */
  filePrefix: string;
  author: string;
  organization: string;
  frame: FrameConfig;
  storeys: StoreyDef[];
  parts: PartConfig[];
  plans: PlanPart[];
  excludedCategories: string[];
  /** Case-insensitive pattern; elements whose family, type or name match are left out. */
  excludePattern: string;
  perDiscipline: boolean;
  federated: boolean;
  instancing: boolean;
  twoSidedOpen: boolean;
  /** Texture pictures: PNG files in a textures folder next to the IFC, inside the IFC, or left out. */
  textures?: "files" | "embed" | "none";
  /** Elements made only of lines become IfcAnnotation curves (otherwise they are left out). */
  lines?: boolean;
  /** Type objects (IfcWallType, …) for Revit family types. */
  types?: boolean;
  /** Asset information written into the IFC files (null or absent: none). */
  assets?: { categories: string[]; sources: Record<string, string> } | null;
}

export interface OutputSummary {
  name: string;
  /** Discipline id, or null for the federated file. */
  discipline: string | null;
  label: string;
  elements: number;
  bytes: number;
  classes: Record<string, number>;
  storeys: Record<string, number>;
  parts: string[];
  /** Texture pictures the file refers to (kept next to it, in "textures/"). */
  textures: number;
}

export interface OutputFile extends OutputSummary {
  blob: Blob;
  /** Files that go next to the IFC, by relative path ("textures/x.png"). */
  assets: { path: string; blob: Blob }[];
}

export interface ConvertReport {
  outputs: OutputSummary[];
  elements: number;
  skipped: { excludedCategory: number; pattern: number; noGeometry: number };
  geometry: { baked: number; mapped: number; maps: number; nonUniform: number; sheared: number; twoSided: number; mirrored: number; empty: number };
  /** Surface styles, textured and vertex-coloured shapes, texture pictures, type objects, materials and line-only annotations written. */
  appearance: { styles: number; textured: number; coloured: number; textures: number; types: number; materials: number; annotations: number; systems: number; zones: number; assets: number };
  seconds: number;
  frame: { origin: [number, number, number]; rotationDeg: number };
}

export type ProgressFn = (phase: string, done: number, total: number) => void;
