// A quick look inside an IFC file without converting it.
//
// Shared by the app (browser worker) and the command-line converter (Node),
// so it is plain JavaScript without imports; the types live in ifc-scan.d.mts.
//
// The scanner is fed the bytes of the file in pieces and walks them once,
// which takes a second or two per gigabyte. It reports the schema, the
// project's name and description, how many elements of which class the file
// holds, and the GlobalId of every element. Comparing those ids between files
// is how a folder of models is checked for copies and for models that are
// part of another one, before any of them is converted.

/**
 * Rooted entities that are not counted as elements: the project and its
 * spatial structure, property data, groups, grids, and openings (which cut
 * elements rather than being one).
 */
const NOT_ELEMENTS = new Set([
  "IFCPROJECT",
  "IFCPROJECTLIBRARY",
  "IFCSITE",
  "IFCBUILDING",
  "IFCBUILDINGSTOREY",
  "IFCSPACE",
  "IFCSPATIALZONE",
  "IFCFACILITY",
  "IFCFACILITYPART",
  "IFCBRIDGE",
  "IFCBRIDGEPART",
  "IFCROAD",
  "IFCROADPART",
  "IFCRAILWAY",
  "IFCRAILWAYPART",
  "IFCMARINEFACILITY",
  "IFCMARINEPART",
  "IFCPROPERTYSET",
  "IFCELEMENTQUANTITY",
  "IFCPROPERTYSETTEMPLATE",
  "IFCSIMPLEPROPERTYTEMPLATE",
  "IFCCOMPLEXPROPERTYTEMPLATE",
  "IFCGROUP",
  "IFCSYSTEM",
  "IFCZONE",
  "IFCBUILDINGSYSTEM",
  "IFCDISTRIBUTIONSYSTEM",
  "IFCDISTRIBUTIONCIRCUIT",
  "IFCSTRUCTURALANALYSISMODEL",
  "IFCASSET",
  "IFCINVENTORY",
  "IFCGRID",
  "IFCOPENINGELEMENT",
  "IFCOPENINGSTANDARDCASE",
  "IFCVOIDINGFEATURE",
  "IFCVIRTUALELEMENT",
  "IFCANNOTATION",
]);

/**
 * True for the classes that count as elements: products other than the
 * spatial structure and openings.
 * @param {string} type upper-case IFC class
 */
export function isElementClass(type) {
  if (NOT_ELEMENTS.has(type)) return false;
  if (type.startsWith("IFCREL") || type.startsWith("IFCPROPERTY") || type.startsWith("IFCQUANTITY") || type.startsWith("IFCMATERIAL")) return false;
  // Types (IfcWallType, IfcDoorStyle), profiles and property definitions are shared definitions, not elements.
  if (type.endsWith("TYPE") || type.endsWith("STYLE") || type.endsWith("PROPERTIES") || type.endsWith("PROFILEDEF")) return false;
  return true;
}

const QUOTE = 0x27;
const EQUALS = 0x3d;
const OPEN = 0x28;
const SEMICOLON = 0x3b;

const SEEK = 0;
const AFTER_EQUALS = 1;
const IN_TYPE = 2;
const AFTER_TYPE = 3;
const AFTER_OPEN = 4;
const IN_ID = 5;
const IN_OTHER_STRING = 6;
const IN_PROJECT = 7;

const isSpace = (/** @type {number} */ byte) => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
const isNameByte = (/** @type {number} */ byte) => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x5f;

/**
 * Why a file cannot be read as IFC, judged by its first bytes, or null when nothing speaks against it.
 * The IFC engine fails on such files with errors that say nothing ("Cannot read properties of undefined",
 * "memory access out of bounds"), so they are caught here first.
 * @param {Uint8Array} head the first bytes of the file (64 KB is plenty)
 * @param {boolean} [whole] true when `head` is the whole file
 * @returns {string | null}
 */
export function ifcHeaderProblem(head, whole = false) {
  if (head.length === 0) return "The file is empty.";
  let text = "";
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
  // A UTF-8 byte order mark, blank lines and comments may come first.
  const start = text.replace(/^\xEF\xBB\xBF/, "").replace(/^(\s|\/\*[\s\S]*?\*\/)+/, "");
  if (/^<(\?xml|ifcXML|[a-z]+:ifcXML)/i.test(start)) return "This is an XML file. ifcXML is not read: save the model as .ifc (IFC in the STEP format).";
  if (!/^ISO-10303-21\s*;/i.test(start)) return "This is not an IFC file: it does not begin with ISO-10303-21, as IFC files do.";
  // Only judged when the whole header is in view.
  const end = start.search(/ENDSEC\s*;/i);
  if ((end >= 0 || whole) && !/FILE_SCHEMA\s*\(/i.test(end >= 0 ? start.slice(0, end) : start)) {
    return "This IFC file does not say which IFC version it is (its header has no FILE_SCHEMA), so it cannot be read. It may be cut off or damaged.";
  }
  return null;
}

/**
 * Decodes a STEP string body: doubled quotes and the \X2\, \X4\, \X\ and \S\ escapes.
 * @param {string} text
 */
export function decodeStepText(text) {
  return text
    .replace(/''/g, "'")
    .replace(/\\X2\\([0-9A-Fa-f]*)\\X0\\/g, (_, hex) => (hex.match(/.{4}/g) ?? []).map((/** @type {string} */ code) => String.fromCharCode(parseInt(code, 16))).join(""))
    .replace(/\\X4\\([0-9A-Fa-f]*)\\X0\\/g, (_, hex) => (hex.match(/.{8}/g) ?? []).map((/** @type {string} */ code) => String.fromCodePoint(parseInt(code, 16))).join(""))
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\S\\(.)/g, (_, char) => String.fromCharCode(char.charCodeAt(0) + 128))
    .replace(/\\\\/g, "\\");
}

/**
 * Splits the argument list of one STEP entity into its top-level arguments.
 * @param {string} body text between the outer parentheses
 * @returns {string[]}
 */
function splitArguments(body) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "'") quoted = !quoted;
    else if (!quoted) {
      if (char === "(") depth++;
      else if (char === ")") depth--;
      else if (char === "," && depth === 0) {
        parts.push(body.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  parts.push(body.slice(start).trim());
  return parts;
}

/** @param {string | undefined} argument a STEP argument; returns its text when it is a string */
function stringArgument(argument) {
  if (!argument || argument[0] !== "'" || argument.length < 2) return "";
  return decodeStepText(argument.slice(1, -1)).trim();
}

/**
 * Creates a scanner. Call `push` with consecutive pieces of the file, then `finish`.
 * @returns {import("./ifc-scan.d.mts").IfcScanner}
 */
export function createIfcScanner() {
  let state = SEEK;
  /** The entity name being read, as char codes. */
  const type = new Uint8Array(64);
  let typeLength = 0;
  const id = new Uint8Array(22);
  let idLength = 0;
  /** Bytes of the IfcProject entity, from its opening parenthesis. */
  const projectBytes = new Uint8Array(4096);
  let projectLength = 0;
  let projectQuoted = false;
  let projectText = "";
  /** The start of the file, for the header. */
  const head = new Uint8Array(8192);
  let headLength = 0;

  let entities = 0;
  let elements = 0;
  /** @type {Map<string, number>} */
  const classes = new Map();
  /** @type {string[]} */
  const guids = [];
  let currentType = "";
  let currentIsElement = false;

  const decoder = new TextDecoder("latin1");

  // A GlobalId is 22 characters of a base-64 alphabet and, holding 128 bits, starts with 0 to 3.
  // The test keeps out entities whose first argument merely is a 22-character name.
  const isGlobalId = () => {
    if (id[0] < 0x30 || id[0] > 0x33) return false;
    for (let k = 1; k < 22; k++) {
      const byte = id[k];
      if (!((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f || byte === 0x24)) return false;
    }
    return true;
  };

  const record = () => {
    if (!isGlobalId()) return;
    entities++;
    if (!currentIsElement) return;
    elements++;
    classes.set(currentType, (classes.get(currentType) ?? 0) + 1);
    guids.push(String.fromCharCode.apply(null, /** @type {any} */ (id)));
  };

  return {
    push(chunk) {
      if (headLength < head.length) {
        const take = Math.min(head.length - headLength, chunk.length);
        head.set(chunk.subarray(0, take), headLength);
        headLength += take;
      }
      const length = chunk.length;
      let i = 0;
      while (i < length) {
        if (state === SEEK) {
          // The hot loop: nearly every byte of a file is passed over here.
          let byte = 0;
          while (i < length) {
            byte = chunk[i++];
            if (byte === QUOTE || byte === EQUALS) break;
            byte = 0;
          }
          if (byte === QUOTE) state = IN_OTHER_STRING;
          else if (byte === EQUALS) {
            state = AFTER_EQUALS;
            typeLength = 0;
          }
          continue;
        }
        const byte = chunk[i];
        switch (state) {
          case IN_OTHER_STRING:
            // A doubled quote ends and reopens the string, which comes to the same thing.
            if (byte === QUOTE) state = SEEK;
            i++;
            break;
          case AFTER_EQUALS:
            if (isSpace(byte)) i++;
            else if (isNameByte(byte)) state = IN_TYPE;
            else state = SEEK;
            break;
          case IN_TYPE:
            if (isNameByte(byte)) {
              if (typeLength < type.length) type[typeLength++] = byte >= 0x61 ? byte - 32 : byte;
              i++;
            } else state = AFTER_TYPE;
            break;
          case AFTER_TYPE:
            if (isSpace(byte)) i++;
            else if (byte === OPEN) {
              state = AFTER_OPEN;
              i++;
            } else state = SEEK;
            break;
          case AFTER_OPEN:
            if (isSpace(byte)) i++;
            else if (byte === QUOTE) {
              currentType = decoder.decode(type.subarray(0, typeLength));
              currentIsElement = isElementClass(currentType);
              state = IN_ID;
              idLength = 0;
              i++;
              if (currentType === "IFCPROJECT" && !projectText) {
                projectLength = 0;
                projectBytes[projectLength++] = QUOTE;
                projectQuoted = true;
              }
            } else state = SEEK;
            break;
          case IN_ID:
            if (byte === QUOTE) {
              if (idLength === 22) record();
              if (currentType === "IFCPROJECT" && !projectText && projectLength > 0) {
                projectBytes[projectLength++] = QUOTE;
                projectQuoted = false;
                state = IN_PROJECT;
              } else state = SEEK;
            } else {
              if (idLength < 22) id[idLength] = byte;
              idLength++;
              if (projectLength > 0 && projectLength < projectBytes.length && currentType === "IFCPROJECT" && !projectText) projectBytes[projectLength++] = byte;
            }
            i++;
            break;
          case IN_PROJECT:
            // Keep the rest of the IfcProject entity to read its name and description.
            if (byte === QUOTE) projectQuoted = !projectQuoted;
            if ((byte === SEMICOLON && !projectQuoted) || projectLength >= projectBytes.length) {
              projectText = new TextDecoder().decode(projectBytes.subarray(0, projectLength));
              state = SEEK;
            } else projectBytes[projectLength++] = byte;
            i++;
            break;
          default:
            state = SEEK;
        }
      }
    },

    finish() {
      const header = new TextDecoder().decode(head.subarray(0, headLength));
      const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(header)?.[1]?.toUpperCase() ?? "";
      let project = null;
      if (projectText) {
        // GlobalId, OwnerHistory, Name, Description, ObjectType, LongName, Phase, ...
        const body = projectText.endsWith(")") ? projectText.slice(0, -1) : projectText;
        const args = splitArguments(body);
        project = { name: stringArgument(args[2]), description: stringArgument(args[3]), longName: stringArgument(args[5]) };
      }
      return {
        isIfc: /^﻿?\s*ISO-10303-21/.test(header),
        schema,
        project,
        entities,
        elements,
        classes: [...classes.entries()].sort((a, b) => b[1] - a[1]),
        guids,
      };
    },
  };
}

/**
 * How much of `part` is also in `whole`: the number of shared ids.
 * @param {Set<string>} whole
 * @param {string[]} part
 */
export function countShared(whole, part) {
  let shared = 0;
  for (const guid of part) if (whole.has(guid)) shared++;
  return shared;
}
