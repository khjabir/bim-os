// Types of ifc-scan.mjs, which is plain JavaScript so the command-line
// converter can import it without a build step.

export interface IfcScanResult {
  /** False when the data does not start like an IFC in the STEP format. */
  isIfc: boolean;
  /** Schema named in the header, upper-case ("IFC4", "IFC2X3"); "" when missing. */
  schema: string;
  /** Name, description and long name of the IfcProject, when the file has one. */
  project: { name: string; description: string; longName: string } | null;
  /** Entities with a GlobalId. */
  entities: number;
  /** Elements: products other than the spatial structure and openings. */
  elements: number;
  /** Element classes (upper-case) with their counts, most frequent first. */
  classes: [string, number][];
  /** GlobalId of every element. */
  guids: string[];
}

export interface IfcScanner {
  /** Feeds the next piece of the file. Pieces may be cut anywhere. */
  push(chunk: Uint8Array): void;
  finish(): IfcScanResult;
}

/** True for the classes (upper-case) that count as elements: products other than the spatial structure and openings. */
export function isElementClass(type: string): boolean;

/** Creates a scanner for one file. */
export function createIfcScanner(): IfcScanner;

/** Decodes the body of a STEP string: doubled quotes and the \X2\, \X4\, \X\ and \S\ escapes. */
export function decodeStepText(text: string): string;

/** How many of `part` are in `whole`. */
export function countShared(whole: Set<string>, part: string[]): number;
