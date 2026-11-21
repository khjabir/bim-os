// Reads the table of contents of a ZIP archive: what an ifcZIP file is.
//
// Shared by the app (browser) and the command-line converter (Node), so it
// is plain JavaScript without imports; the types live in zip-archive.d.mts.
//
// It only touches the small records at the end of the archive and the header
// in front of an entry, through a read(offset, length) callback, so an archive
// of any size is listed without loading it. Unpacking the entry data is left
// to the caller: DecompressionStream in the browser, zlib in Node.
//
// Covered: ZIP64 (archives and entries beyond 4 GB or 65,535 entries), data
// descriptors, archive comments, data in front of the archive, UTF-8 and
// legacy file names. Reported as unsupported: split archives, encryption and
// every compression method other than "stored" and Deflate.

/** A problem with the archive itself. The message is written for the user. */
export class ZipError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ZipError";
  }
}

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

const END_OF_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_DIRECTORY = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/** Longer directories (several hundred thousand entries) are refused rather than held in memory. */
const MAX_DIRECTORY_BYTES = 128 * 1024 * 1024;

const NOT_A_ZIP = "This is not a ZIP archive. If it should be one, the file is incomplete: download or copy it again.";
const DAMAGED = "The archive is damaged: its table of contents cannot be read.";
const SPLIT = "This is one part of a split (multi-volume) archive, which cannot be read. Unpack it and open the .ifc file.";

const METHOD_NAMES = {
  0: "no compression",
  8: "Deflate",
  9: "Deflate64",
  12: "bzip2",
  14: "LZMA",
  20: "Zstandard",
  93: "Zstandard",
  95: "XZ",
  96: "JPEG",
  97: "WavPack",
  98: "PPMd",
};

/** @param {number} method */
export function methodName(method) {
  return METHOD_NAMES[method] ?? `ZIP method ${method}`;
}

// ---------------------------------------------------------------------------
// CRC-32 (the checksum ZIP stores for every entry), eight bytes per step.
// ---------------------------------------------------------------------------

const CRC_TABLES = (() => {
  const tables = Array.from({ length: 8 }, () => new Int32Array(256));
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    tables[0][n] = value;
  }
  for (let n = 0; n < 256; n++) {
    let value = tables[0][n];
    for (let t = 1; t < 8; t++) {
      value = tables[0][value & 0xff] ^ (value >>> 8);
      tables[t][n] = value;
    }
  }
  return tables;
})();

/**
 * CRC-32 of `bytes`. Pass the result of the previous call as `previous` to
 * checksum data that arrives in pieces.
 * @param {Uint8Array} bytes
 * @param {number} [previous]
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(bytes, previous = 0) {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC_TABLES;
  const length = bytes.length;
  let crc = ~previous;
  let i = 0;
  for (const stop = length - 7; i < stop; i += 8) {
    crc ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    crc =
      t7[crc & 0xff] ^
      t6[(crc >>> 8) & 0xff] ^
      t5[(crc >>> 16) & 0xff] ^
      t4[crc >>> 24] ^
      t3[bytes[i + 4]] ^
      t2[bytes[i + 5]] ^
      t1[bytes[i + 6]] ^
      t0[bytes[i + 7]];
  }
  for (; i < length; i++) crc = t0[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

// Code page 437, upper half: the encoding ZIP prescribes for names that are not UTF-8.
const CP437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

/**
 * UTF-8 when the bytes are valid UTF-8, code page 437 otherwise. The header
 * flag that should tell the two apart is not consulted: several tools (the
 * macOS Finder among them) write UTF-8 names without setting it.
 * @param {Uint8Array} bytes
 */
function decodeName(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    let text = "";
    for (const byte of bytes) text += byte < 0x80 ? String.fromCharCode(byte) : CP437[byte - 0x80];
    return text;
  }
}

/** The file name of an entry without its folders. @param {string} path */
export function fileNameOf(path) {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** @param {Uint8Array} bytes */
function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * @param {DataView} view
 * @param {number} offset
 */
function uint64(view, offset) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError(DAMAGED);
  return Number(value);
}

/**
 * @param {import("./zip-archive.d.mts").ZipRead} read
 * @param {number} offset
 * @param {number} length
 * @param {number} archiveSize
 * @param {string} [problem]
 */
async function readExact(read, offset, length, archiveSize, problem = DAMAGED) {
  if (offset < 0 || length < 0 || offset + length > archiveSize) throw new ZipError(problem);
  if (length === 0) return new Uint8Array(0);
  const bytes = await read(offset, length);
  if (bytes.length !== length) throw new ZipError(problem);
  return bytes;
}

/**
 * Lists every entry of the archive, in the order of its table of contents.
 * @param {import("./zip-archive.d.mts").ZipRead} read
 * @param {number} archiveSize
 * @returns {Promise<import("./zip-archive.d.mts").ZipEntry[]>}
 */
export async function readZipEntries(read, archiveSize) {
  if (!Number.isFinite(archiveSize) || archiveSize < 22) throw new ZipError(NOT_A_ZIP);

  // The end-of-directory record is the last thing in the file, followed only
  // by an optional comment of at most 65,535 bytes.
  const tailLength = Math.min(archiveSize, 22 + 0xffff);
  const tailOffset = archiveSize - tailLength;
  const tail = await readExact(read, tailOffset, tailLength, archiveSize, NOT_A_ZIP);
  const tailView = viewOf(tail);
  let end = -1;
  // First the strict reading (the comment runs exactly to the end of the file),
  // then a lenient one for archives with stray bytes behind them.
  for (const strict of [true, false]) {
    for (let i = tailLength - 22; i >= 0 && end < 0; i--) {
      if (tailView.getUint32(i, true) !== END_OF_DIRECTORY) continue;
      const commentEnd = i + 22 + tailView.getUint16(i + 20, true);
      if (strict ? commentEnd === tailLength : commentEnd <= tailLength) end = i;
    }
    if (end >= 0) break;
  }
  if (end < 0) throw new ZipError(NOT_A_ZIP);

  const endOffset = tailOffset + end;
  let disk = tailView.getUint16(end + 4, true);
  let directoryDisk = tailView.getUint16(end + 6, true);
  let count = tailView.getUint16(end + 10, true);
  let directorySize = tailView.getUint32(end + 12, true);
  let directoryOffset = tailView.getUint32(end + 16, true);
  /** Where the table of contents is expected to stop. */
  let directoryEnd = endOffset;

  // ZIP64: a locator right in front of the end record points at a larger
  // record that holds the same numbers in 64 bits.
  if (endOffset >= 20) {
    const locator = viewOf(await readExact(read, endOffset - 20, 20, archiveSize));
    if (locator.getUint32(0, true) === ZIP64_LOCATOR) {
      if (locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) > 1) throw new ZipError(SPLIT);
      let recordOffset = uint64(locator, 8);
      const signatureAt = async (/** @type {number} */ offset) =>
        offset >= 0 && offset + 56 <= archiveSize && viewOf(await readExact(read, offset, 4, archiveSize)).getUint32(0, true) === ZIP64_END_OF_DIRECTORY;
      // With data in front of the archive the stored position is off; the record then sits right before its locator.
      if (!(await signatureAt(recordOffset))) recordOffset = endOffset - 20 - 56;
      if (!(await signatureAt(recordOffset))) throw new ZipError(DAMAGED);
      const record = viewOf(await readExact(read, recordOffset, 56, archiveSize));
      disk = record.getUint32(16, true);
      directoryDisk = record.getUint32(20, true);
      count = uint64(record, 32);
      directorySize = uint64(record, 40);
      directoryOffset = uint64(record, 48);
      directoryEnd = recordOffset;
    }
  }
  if (disk !== 0 || directoryDisk !== 0) throw new ZipError(SPLIT);
  if (directorySize === 0) {
    if (count === 0) return [];
    throw new ZipError(DAMAGED);
  }
  if (directorySize > MAX_DIRECTORY_BYTES) throw new ZipError("The archive holds too many files to list. Unpack it and open the .ifc file.");

  // Self-extracting archives and files with a prefix store positions relative
  // to the start of the ZIP data rather than of the file: detect the shift.
  let shift = 0;
  const startsEntry = async (/** @type {number} */ offset) =>
    offset >= 0 && offset + 46 <= archiveSize && viewOf(await readExact(read, offset, 4, archiveSize)).getUint32(0, true) === DIRECTORY_ENTRY;
  if (!(await startsEntry(directoryOffset))) {
    shift = directoryEnd - directorySize - directoryOffset;
    if (shift === 0 || !(await startsEntry(directoryOffset + shift))) throw new ZipError(DAMAGED);
  }

  const directory = await readExact(read, directoryOffset + shift, directorySize, archiveSize);
  const view = viewOf(directory);
  /** @type {import("./zip-archive.d.mts").ZipEntry[]} */
  const entries = [];
  let position = 0;
  // The directory is walked to its end rather than for `count` entries: some
  // tools write more than 65,535 entries without ZIP64 and let the count wrap.
  while (position + 46 <= directory.length && view.getUint32(position, true) === DIRECTORY_ENTRY) {
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const checksum = view.getUint32(position + 16, true);
    let compressedSize = view.getUint32(position + 20, true);
    let size = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    let localHeaderOffset = view.getUint32(position + 42, true);
    const nameStart = position + 46;
    const extraStart = nameStart + nameLength;
    const extraEnd = extraStart + extraLength;
    const next = extraEnd + commentLength;
    if (next > directory.length) throw new ZipError(DAMAGED);

    const rawName = directory.subarray(nameStart, extraStart);
    let name = decodeName(rawName);
    for (let field = extraStart; field + 4 <= extraEnd; ) {
      const id = view.getUint16(field, true);
      const body = field + 4;
      const bodyEnd = body + view.getUint16(field + 2, true);
      if (bodyEnd > extraEnd) break;
      if (id === 0x0001) {
        // ZIP64 sizes: present, in this order, only for the values that overflowed above.
        let at = body;
        if (size === 0xffffffff && at + 8 <= bodyEnd) {
          size = uint64(view, at);
          at += 8;
        }
        if (compressedSize === 0xffffffff && at + 8 <= bodyEnd) {
          compressedSize = uint64(view, at);
          at += 8;
        }
        if (localHeaderOffset === 0xffffffff && at + 8 <= bodyEnd) localHeaderOffset = uint64(view, at);
      } else if (id === 0x7075 && bodyEnd - body > 5 && view.getUint8(body) === 1 && view.getUint32(body + 1, true) === crc32(rawName)) {
        // Info-ZIP Unicode path: the real name when the plain one is in a legacy code page.
        name = new TextDecoder().decode(directory.subarray(body + 5, bodyEnd));
      }
      field = bodyEnd;
    }
    name = name.replace(/\\/g, "/");

    entries.push({
      name,
      directory: name.endsWith("/"),
      method,
      encrypted: (flags & 0x2041) !== 0 || method === 99,
      crc32: checksum,
      compressedSize,
      size,
      localHeaderOffset: localHeaderOffset + shift,
    });
    position = next;
  }
  if (entries.length < count) throw new ZipError(DAMAGED);
  return entries;
}

/**
 * Position of the (compressed) data of an entry inside the archive.
 * @param {import("./zip-archive.d.mts").ZipRead} read
 * @param {import("./zip-archive.d.mts").ZipEntry} entry
 * @param {number} archiveSize
 * @returns {Promise<number>}
 */
export async function entryDataOffset(read, entry, archiveSize) {
  const header = viewOf(await readExact(read, entry.localHeaderOffset, 30, archiveSize));
  if (header.getUint32(0, true) !== LOCAL_HEADER) throw new ZipError(DAMAGED);
  const start = entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  if (start + entry.compressedSize > archiveSize) {
    throw new ZipError(`The archive is incomplete: ${fileNameOf(entry.name)} is cut off. Download or copy the file again.`);
  }
  return start;
}

// ---------------------------------------------------------------------------
// Picking the models
// ---------------------------------------------------------------------------

/** Finder resource forks, thumbnails and the like. @param {string} path */
function isClutter(path) {
  if (path.startsWith("__MACOSX/") || path.includes("/__MACOSX/")) return true;
  const file = fileNameOf(path);
  return file.startsWith("._") || file === ".DS_Store" || file === "Thumbs.db" || file === "desktop.ini";
}

/**
 * Sorts the files of an archive into IFC models (.ifc), Fragments models
 * (.frag), ifcXML models and the rest.
 * @param {import("./zip-archive.d.mts").ZipEntry[]} entries
 * @returns {import("./zip-archive.d.mts").IfcSelection}
 */
export function selectIfcEntries(entries) {
  const files = entries.filter((entry) => !entry.directory && !isClutter(entry.name));
  const models = files.filter((entry) => /\.ifc$/i.test(entry.name));
  const fragments = files.filter((entry) => /\.frag$/i.test(entry.name));
  const ifcXml = files.filter((entry) => /\.ifcxml$/i.test(entry.name));
  const others = files.filter((entry) => !/\.(ifc|frag|ifcxml)$/i.test(entry.name));
  return { models, fragments, ifcXml, others };
}

/**
 * Explains why an archive without a model in it cannot be opened.
 * @param {import("./zip-archive.d.mts").IfcSelection} selection
 */
export function describeMissingModel({ ifcXml, others }) {
  if (ifcXml.length > 0) {
    return `The archive holds an ifcXML model (${fileNameOf(ifcXml[0].name)}), which cannot be read. Export the model as IFC in the STEP format (.ifc) instead.`;
  }
  if (others.length === 0) return "The archive is empty.";
  const names = others.slice(0, 3).map((entry) => fileNameOf(entry.name));
  const more = others.length > names.length ? ` and ${others.length - names.length} more` : "";
  return `The archive holds no .ifc or .frag file (it contains ${names.join(", ")}${more}).`;
}

/**
 * Why this entry cannot be unpacked, or null when it can.
 * @param {import("./zip-archive.d.mts").ZipEntry} entry
 * @returns {string | null}
 */
export function unsupportedReason(entry) {
  const file = fileNameOf(entry.name);
  if (entry.encrypted) return `${file} is password-protected. Unpack the archive and open the .ifc file.`;
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
    return `${file} is compressed with ${methodName(entry.method)}, which cannot be unpacked here. Unpack the archive and open the .ifc file, or create the archive again with the standard Deflate compression.`;
  }
  if (entry.size === 0) return `${file} is empty.`;
  if (entry.compressedSize === 0 || (entry.method === METHOD_STORED && entry.compressedSize !== entry.size)) return DAMAGED;
  return null;
}

/** What to tell the user when the unpacked data does not match the archive's own size and checksum. */
export const UNPACK_MISMATCH = "The archive is damaged: the model did not unpack to the size and checksum the archive records.";

/**
 * True when a file begins like a ZIP archive ("PK\x03\x04").
 * @param {Uint8Array} head the first bytes of the file
 */
export function startsLikeZip(head) {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/**
 * True when a file begins like an IFC in the STEP format ("ISO-10303-21").
 * @param {Uint8Array} head the first bytes of the file
 */
export function startsLikeStep(head) {
  const text = new TextDecoder().decode(head).replace(/^﻿/, "").trimStart();
  return text.startsWith("ISO-10303-21");
}
