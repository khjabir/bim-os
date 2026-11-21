// Types of zip-archive.mjs, which is plain JavaScript so the command-line
// converter can import it without a build step.

/** A problem with the archive itself. The message is written for the user. */
export class ZipError extends Error {
  constructor(message: string);
}

/**
 * Returns `length` bytes of the archive starting at `offset`. Only called for
 * ranges inside the archive; may answer directly or with a promise.
 */
export type ZipRead = (offset: number, length: number) => Uint8Array | Promise<Uint8Array>;

export interface ZipEntry {
  /** Path inside the archive, with "/" between folders. Folders end with "/". */
  name: string;
  directory: boolean;
  /** ZIP compression method: 0 stored, 8 Deflate; see `unsupportedReason` for the rest. */
  method: number;
  encrypted: boolean;
  /** CRC-32 of the unpacked data. */
  crc32: number;
  compressedSize: number;
  /** Size of the unpacked data. */
  size: number;
  /** Position of the entry's header; use `entryDataOffset` to find its data. */
  localHeaderOffset: number;
}

export interface IfcSelection {
  /** IFC models in the STEP format (.ifc). */
  models: ZipEntry[];
  /** Fragments models (.frag), as this app exports them. */
  fragments: ZipEntry[];
  /** ifcXML models, which web-ifc cannot read. */
  ifcXml: ZipEntry[];
  /** Every other file. Finder and Explorer clutter is left out. */
  others: ZipEntry[];
}

export const METHOD_STORED: 0;
export const METHOD_DEFLATE: 8;

/** What to tell the user when the unpacked data does not match the archive's own size and checksum. */
export const UNPACK_MISMATCH: string;

export function methodName(method: number): string;

/**
 * CRC-32 of `bytes`. Pass the result of the previous call as `previous` to
 * checksum data that arrives in pieces.
 */
export function crc32(bytes: Uint8Array, previous?: number): number;

/** The file name of an entry without its folders. */
export function fileNameOf(path: string): string;

/** Lists every entry of the archive, in the order of its table of contents. Throws `ZipError`. */
export function readZipEntries(read: ZipRead, archiveSize: number): Promise<ZipEntry[]>;

/** Position of the (compressed) data of an entry inside the archive. Throws `ZipError`. */
export function entryDataOffset(read: ZipRead, entry: ZipEntry, archiveSize: number): Promise<number>;

/** Sorts the files of an archive into IFC models (.ifc), Fragments models (.frag), ifcXML models and the rest. */
export function selectIfcEntries(entries: ZipEntry[]): IfcSelection;

/** Explains why an archive without a model in it cannot be opened. */
export function describeMissingModel(selection: IfcSelection): string;

/** Why this entry cannot be unpacked, or null when it can. */
export function unsupportedReason(entry: ZipEntry): string | null;

/** True when a file begins like a ZIP archive ("PK\x03\x04"). */
export function startsLikeZip(head: Uint8Array): boolean;

/** True when a file begins like an IFC in the STEP format ("ISO-10303-21"). */
export function startsLikeStep(head: Uint8Array): boolean;
