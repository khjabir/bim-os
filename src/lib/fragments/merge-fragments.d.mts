// Types of merge-fragments.mjs, which is plain JavaScript so the command-line
// tools can import it without a build step.

/** One Fragments file cannot exceed this many bytes of uncompressed data. */
export const MAX_FRAGMENTS_BYTES: number;

/** Thrown when the models cannot be joined. The message is written for the user. */
export class MergeError extends Error {
  constructor(message: string);
}

export interface MergeOptions {
  /** Size of all models together, uncompressed. The output buffer is sized from it. */
  totalBytes: number;
}

export interface MergedSource {
  name: string;
  schema: unknown;
  /** Items (IFC entities) the model contributed. */
  items: number;
  /** Items with geometry. */
  elements: number;
  /** What was added to the model's local ids. */
  localIdOffset: number;
  /** The model's highest local id in the combined file. */
  maxLocalId: number;
}

export interface MergeResult {
  /** The combined model: uncompressed FlatBuffers data, a view into the merger's buffer. */
  bytes: Uint8Array;
  models: MergedSource[];
  items: number;
  elements: number;
  samples: number;
}

export interface FragmentsMerger {
  /**
   * Adds one model. `bytes` is its uncompressed data; it is not kept, so the
   * caller may release it when this returns.
   */
  add(bytes: Uint8Array, info: { name: string }): { items: number; elements: number };
  /** Writes the tables that span all models and returns the combined model. */
  finish(details: { name: string; id: string }): MergeResult;
}

export interface FragmentsSummary {
  /** IFC schema the model was converted from; "" when not recorded. */
  schema: string;
  items: number;
  /** Elements, counted by class as the IFC scanner counts them. */
  elements: number;
  /** Items with geometry. */
  drawn: number;
  /** Description (or long name) of the model's IfcProject; "" when it has none. */
  description: string;
  /** GlobalId of every element. */
  guids: string[];
}

/** A quick look at one model, from its uncompressed data. Throws `MergeError` when the data is not a Fragments model. */
export function summariseFragments(bytes: Uint8Array): FragmentsSummary;

/** Throws `MergeError` when the models are too large for one file or memory runs out. */
export function createFragmentsMerger(options: MergeOptions): FragmentsMerger;
