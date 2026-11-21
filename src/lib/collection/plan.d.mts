// Types of plan.mjs, which is plain JavaScript so the command-line converter
// can import it without a build step.

export type ModelKind = "ifc" | "ifczip" | "frag";

/** One model file found in a folder. */
export interface PlanFile {
  /** Path inside the opened folder, with "/" between folders. A file inside an archive is "archive.zip/file.ifc". */
  path: string;
  kind: ModelKind;
  size: number;
  /** Milliseconds since 1970, as File.lastModified and fs.Stats.mtimeMs give it. */
  lastModified: number;
  /** Whatever the caller needs to find the file again; passed through untouched. */
  ref: number;
}

/** One model, with every copy of it that was found and the copy to open. */
export interface PlannedModel {
  /** Folder and name, lower-case: unique within a plan. */
  key: string;
  /** File name without folders and extension. */
  stem: string;
  /** Folder inside the opened folder; "" for its top level. */
  folder: string;
  copies: PlanFile[];
  /** The copy to open. */
  use: PlanFile;
  /** When a .frag is opened: the plain IFC of the same model, kept for IFC export. */
  source: PlanFile | null;
  /** Why this copy was picked, when that needs saying. */
  note: string;
}

/** The kind of model file a name stands for, or null. A plain .zip only counts once it is known to hold models. */
export function modelKind(path: string): ModelKind | null;

/** True for files inside tool folders (node_modules, .git) and for Finder's hidden companion files. */
export function isClutterPath(path: string): boolean;

/** Groups the model files of a folder into models and picks the copy of each to open. */
export function planModels(files: PlanFile[]): PlannedModel[];

export interface ScannedModel {
  key: string;
  /** GlobalIds of the model's elements; null when the model could not be scanned. */
  guids: string[] | null;
}

export interface Repeat {
  /**
   * "same": the same elements as another model. "part": all of it is in a
   * larger model. "combined": all of it is in several smaller models.
   */
  kind: "same" | "part" | "combined";
  /** Keys of the models that hold its elements. */
  of: string[];
  /** How many of its elements were found there. */
  shared: number;
  total: number;
}

/** Finds the models that only repeat what other models hold. Returns the ones to leave out, by key. */
export function findRepeats(models: ScannedModel[]): Map<string, Repeat>;
