// State of the Convert page. Kept outside the components so sources,
// traced plans and generated files survive a trip to the model viewer and
// back (client-side navigation keeps this module loaded).

import { create } from "zustand";
import type { ApsStatus } from "@/lib/aps/client";
import type { PlanCalibration } from "./plans/calibrate";
import type { PictureStats } from "./plans/raster";
import type { LayerRole } from "./plans/recognize";
import type { TracedWall, TraceMode } from "./plans/trace";
import type { NoteBlock, NoteFinding } from "./plans/planNotes";
import type { LayerPaths, PlanView, regionTexts } from "./plans/vector";
import type { RecognizeSettings } from "./plans/vectorTypes";
import type { ConvertReport, FrameConfig, JobSummary, OutputFile, PartSummary, StoreyDef } from "./types";
import { DEFAULT_CODE_PATTERN } from "./assets/categories";

export type SourceKind = "rvt" | "nwd" | "extract" | "ifc" | "plan";
/** How a Revit / Navisworks file becomes model data. */
export type SourceMethod = "aps-extract" | "aps-ifc" | "local" | "link" | "none";

export interface SourceItem {
  id: string;
  name: string;
  size: number;
  kind: SourceKind;
  file?: File;
  method: SourceMethod;
  status: "pending" | "working" | "ready" | "failed" | "cancelled";
  step?: string;
  progress?: number;
  error?: string;
  /** Extracted model jobs this source produced (names in the conversion worker). */
  jobs?: string[];
  /** IFC delivered as-is (Revit's own exporter, the in-browser reader, or an IFC file added directly). */
  ifc?: { blob: Blob; name: string; note: string; discipline: string; include: boolean };
  /** What was read (DXF release, units, plans found). */
  note?: string;
}

export interface PlanTraceSettings {
  mode: TraceMode;
  darkWalls: boolean;
  /** 0..255, null for automatic. */
  threshold: number | null;
  /** Metres. */
  minThickness: number;
  maxThickness: number;
  defaultThickness: number;
  minLength: number;
  doorGap: number;
  orthogonal: boolean;
  region: [number, number, number, number] | null;
}

/** A door, window or plain opening on a plan (image pixels). */
export interface PlanOpeningItem {
  a: [number, number];
  b: [number, number];
  kind: "door" | "window" | "opening";
  /** Unit vector the door opens towards (image axes), or null. */
  swing: [number, number] | null;
  operation: string | null;
  name: string | null;
}

export interface PlanRoomItem {
  outline: [number, number][];
  name: string | null;
  number: string | null;
  /** Room type id (roomTypes.ts), and where it came from: the room's name, the on-device assistant, or the user. */
  type?: string | null;
  typeSource?: "name" | "assistant" | "user" | null;
}

export interface PlanColumnItem {
  outline: [number, number][] | null;
  circle: { c: [number, number]; r: number } | null;
}

export interface PlanLayer {
  name: string;
  color: string;
  role: LayerRole;
  /** The role the reader suggested. */
  auto: LayerRole;
  count: number;
}

/** A picture of a plan (scan, photo, PDF page that is an image) read as line work. */
export interface PlanPicture {
  /** Ink settings: threshold 0..255 (null: automatic), solid ink from this stroke width in pixels (null: automatic, 0: none). */
  threshold: number | null;
  solidWidth: number | null;
  darkInk: boolean;
  /** What is being done ("Reading the lines", "Reading text"), or null. */
  step: string | null;
  stats: PictureStats | null;
  /** Lines of text found, and read. */
  textBoxes: number;
  texts: number;
  /** How the scale was found, in words ("7 dimensions in millimetres"). */
  scaleDetail: string | null;
  /** How the size on paper is known ("300 dpi", "the PDF page size"). */
  sizeLabel: string | null;
  /** Corners of the sheet (image pixels) when the picture looks like a photo of one. */
  corners: [number, number][] | null;
  /** The picture before it was straightened, with the corners used (to adjust them or go back). */
  original: { imageUrl: string; gray: Uint8Array; width: number; height: number; lightPaper: boolean; corners: [number, number][] } | null;
  error?: string;
}

/** A plan read from CAD line work (DXF, or a PDF exported from CAD), or from a picture. */
export interface PlanVector {
  /** The drawing in the vector worker. */
  drawingId: string;
  kind: "dxf" | "pdf" | "picture";
  /** The part of the drawing this plan covers, and drawing units -> plan pixels. */
  region: [number, number, number, number];
  view: PlanView;
  /** Where the scale came from: the file's units, a guess from door sizes or the plan's size, the sheet's scale note, dimensions or room areas written on it, or set by hand. */
  scaleSource: "file" | "doors" | "size" | "sheet" | "dims" | "areas" | "set" | null;
  unitLabel: string;
  layers: PlanLayer[];
  /** Line work to draw (DXF; PDFs show the rendered page). */
  paths: LayerPaths[] | null;
  texts: ReturnType<typeof regionTexts> | null;
  settings: RecognizeSettings;
  recognizing: boolean;
  recognized: boolean;
  warnings: string[];
  error?: string;
  notes: string[];
  /** The origin follows the floor's corner until the user picks one. */
  autoOrigin: boolean;
  /** Pictures only. */
  picture?: PlanPicture;
}

export interface PlanSizes {
  /** Metres. */
  doorHeight: number;
  windowSill: number;
  windowHeight: number;
  openingHeight: number;
}

export const DEFAULT_SIZES: PlanSizes = { doorHeight: 2.1, windowSill: 0.9, windowHeight: 1.2, openingHeight: 2.1 };

export interface PlanItem {
  id: string;
  sourceId: string;
  label: string;
  fileName: string;
  page: number | null;
  width: number;
  height: number;
  imageUrl: string;
  gray: Uint8Array;
  lightPaper: boolean;
  /** PDF pages: metres per pixel at 1:1. */
  metresPerPixelAtFullSize: number | null;
  /** PDF pages: drawing scale (100 for 1:100) when the scale comes from it. */
  drawingScale: number | null;
  calibration: PlanCalibration | null;
  trace: PlanTraceSettings;
  /** Image pixels. */
  walls: TracedWall[];
  outline: [number, number][];
  traced: boolean;
  tracing: boolean;
  traceError?: string;
  storey: { name: string; elevation: number; height: number };
  slabThickness: number;
  withSlab: boolean;
  include: boolean;
  discipline: string;
  /** Doors, windows, rooms and columns (image pixels). */
  openings: PlanOpeningItem[];
  rooms: PlanRoomItem[];
  columns: PlanColumnItem[];
  sizes: PlanSizes;
  findingRooms?: boolean;
  /** Read from line work rather than traced from the picture. */
  vector: PlanVector | null;
  /** Height of the rooms (floor to ceiling, metres) when it differs from the walls'. */
  roomHeight?: number | null;
  /** The drawing's notes and what they say. */
  notes?: PlanNotes | null;
  /** The plan (and the project's names) before the assistant's last changes, to undo them. */
  undo?: { label: string; before: Partial<PlanItem>; settings?: Partial<ConvertSettings> } | null;
}

/** Notes on a plan's drawing (general notes, title block, legends) and the facts read from them. */
export interface PlanNotes {
  blocks: NoteBlock[];
  findings: NoteFinding[];
  /** Read by the assistant too. */
  assistant: boolean;
  /** Facts the user applied (field names). */
  applied: string[];
  reading?: boolean;
  error?: string;
}

export interface LinkState {
  url: string;
  status: "idle" | "opened" | "connected" | "receiving" | "done" | "error";
  origin?: string;
  received: number;
  total: number;
  message?: string;
}

export interface ConvertSettings {
  projectName: string;
  siteName: string;
  buildingName: string;
  filePrefix: string;
  author: string;
  organization: string;
  frame: FrameConfig;
  excludedCategories: string[];
  excludePattern: string;
  perDiscipline: boolean;
  federated: boolean;
  instancing: boolean;
  twoSidedOpen: boolean;
  /** Texture pictures: files in a textures folder next to the IFC, inside the IFC, or left out. */
  textures: "files" | "embed" | "none";
  /** Line-only elements as IFC annotations. */
  lines: boolean;
  /** Type objects for Revit family types. */
  types: boolean;
  /** Asset register: categories that are assets (null: the defaults), field sources chosen by hand, COBie author, currency. */
  assetCategories: string[] | null;
  assetSources: Record<string, string>;
  cobieEmail: string;
  cobieCompany: string;
  cobiePhone: string;
  currency: string;
  /** Location and asset codes: site and building codes (blank: initials of their names) and the asset code pattern. */
  siteCode: string;
  buildingCode: string;
  assetCodePattern: string;
  /** Write asset information (manufacturer, warranty, life, systems, spaces) into the IFC files. */
  assetsInIfc: boolean;
  /** Delete files from Autodesk's cloud once they have been read. */
  deleteFromAps: boolean;
  /** Revit IFC export setup for the "Autodesk IFC exporter" method. */
  exportSetup: string;
}

export interface GenerationState {
  running: boolean;
  phase: string;
  done: number;
  total: number;
  error?: string;
  startedAt: number;
}

export interface ConvertState {
  aps: ApsStatus | null;
  sources: SourceItem[];
  parts: PartSummary[];
  jobs: JobSummary[];
  partConfig: Record<string, { include: boolean; discipline: string }>;
  storeys: StoreyDef[];
  /** The user edited the storeys; stop replacing them with detected ones. */
  storeysEdited: boolean;
  plans: PlanItem[];
  settings: ConvertSettings;
  generation: GenerationState | null;
  outputs: OutputFile[];
  report: ConvertReport | null;
  link: LinkState;
  /** Worker activity outside generation (reading files). */
  busy: string | null;
  /** The plan open in the editor. */
  editingPlan: string | null;
}

export const DEFAULT_SETTINGS: ConvertSettings = {
  projectName: "",
  siteName: "Site",
  buildingName: "",
  filePrefix: "",
  author: "",
  organization: "",
  frame: { mode: "auto", origin: [0, 0, 0], rotationDeg: 0 },
  excludedCategories: ["Areas", "Lines", "Model Lines", "Detail Lines", "<Room Separation>", "<Space Separation>", "<Area Boundary>", "Mass", "Detail Items"],
  excludePattern: "",
  perDiscipline: true,
  federated: true,
  instancing: true,
  twoSidedOpen: false,
  textures: "files",
  lines: true,
  types: true,
  assetCategories: null,
  assetSources: {},
  cobieEmail: "",
  cobieCompany: "",
  cobiePhone: "",
  currency: "",
  siteCode: "",
  buildingCode: "",
  assetCodePattern: DEFAULT_CODE_PATTERN,
  assetsInIfc: true,
  deleteFromAps: true,
  exportSetup: "IFC4 Reference View",
};

export const useConvertStore = create<ConvertState>(() => ({
  aps: null,
  sources: [],
  parts: [],
  jobs: [],
  partConfig: {},
  storeys: [],
  storeysEdited: false,
  plans: [],
  settings: { ...DEFAULT_SETTINGS },
  generation: null,
  outputs: [],
  report: null,
  link: { url: "", status: "idle", received: 0, total: 0 },
  busy: null,
  editingPlan: null,
}));

export function updateSource(id: string, patch: Partial<SourceItem>) {
  useConvertStore.setState((s) => ({ sources: s.sources.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
}

export function updatePlan(id: string, patch: Partial<PlanItem> | ((plan: PlanItem) => Partial<PlanItem>)) {
  useConvertStore.setState((s) => ({ plans: s.plans.map((p) => (p.id === id ? { ...p, ...(typeof patch === "function" ? patch(p) : patch) } : p)) }));
}

export function updateSettings(patch: Partial<ConvertSettings>) {
  useConvertStore.setState((s) => ({ settings: { ...s.settings, ...patch } }));
}

export function updateLink(patch: Partial<LinkState>) {
  useConvertStore.setState((s) => ({ link: { ...s.link, ...patch } }));
}
