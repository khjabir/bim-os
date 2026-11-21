// Value formatting for IFC STEP files (ISO 10303-21), and the IFC GlobalId
// encodings: compressed GUIDs, Revit's export GUIDs and stable hashed GUIDs.

/** A REAL: always has a decimal point ("3." not "3"), exponents as "1.5E-07". */
export function real(value: number): string {
  if (!Number.isFinite(value)) return "0.";
  if (Number.isInteger(value)) return `${value === 0 ? 0 : value}.`;
  const text = String(value);
  if (!text.includes("e")) return text;
  const [mantissa, exponent] = text.split("e");
  return `${mantissa.includes(".") ? mantissa : `${mantissa}.`}E${exponent}`;
}

/** A REAL rounded to `step` (0.1 mm for coordinates, 1e-9 for directions). */
export function realStep(value: number, decimals: number): string {
  const scale = 10 ** decimals;
  const rounded = Math.round(value * scale) / scale;
  return real(rounded === 0 ? 0 : rounded);
}

/** A STEP string: quotes doubled, backslashes doubled, anything outside printable ASCII as \X2\…\X0\. */
export function str(value: string | null | undefined): string {
  if (value === null || value === undefined) return "$";
  let out = "'";
  let wide = "";
  const flush = () => {
    if (wide) {
      out += `\\X2\\${wide}\\X0\\`;
      wide = "";
    }
  };
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      const ch = value[i];
      out += ch === "'" ? "''" : ch === "\\" ? "\\\\" : ch;
    } else if (code === 0x09 || code === 0x0a || code === 0x0d) {
      flush();
      out += " ";
    } else {
      wide += code.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  flush();
  return `${out}'`;
}

/** An optional label: "$" for empty values, trimmed to IFC's 255-character label limit. */
export function label(value: string | null | undefined, max = 255): string {
  if (value === null || value === undefined) return "$";
  const trimmed = value.trim();
  return trimmed ? str(trimmed.length > max ? trimmed.slice(0, max) : trimmed) : "$";
}

export function enumValue(value: string | null | undefined): string {
  return value ? `.${value}.` : "$";
}

export function bool(value: boolean | null | undefined): string {
  return value === null || value === undefined ? "$" : value ? ".T." : ".F.";
}

// ---------------------------------------------------------------------------
// GlobalIds

const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/** 16 bytes -> the 22-character IFC GlobalId (same encoding as IfcOpenShell's guid.compress). */
export function compressGuid(bytes: Uint8Array): string {
  const chars = (value: number, count: number) => {
    let text = "";
    for (let i = count - 1; i >= 0; i--) text += B64[Math.floor(value / 64 ** i) % 64];
    return text;
  };
  let out = chars(bytes[0], 2);
  for (let i = 1; i < 16; i += 3) out += chars((bytes[i] << 16) + (bytes[i + 1] << 8) + bytes[i + 2], 4);
  return out;
}

/** "0f8fad5b-d9cb-469f-a165-70867728950e" (or 32 hex digits) -> GlobalId; null when it is not a GUID. */
export function guidFromUuid(text: string | null | undefined): string | null {
  if (!text) return null;
  const hex = text.trim().replace(/^\{|\}$/g, "").replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return compressGuid(bytes);
}

/**
 * Revit UniqueId ("<episode GUID>-<8 hex element id>") -> the GlobalId Revit's
 * own IFC exporter gives the element (ExportUtils.GetExportId: the element id
 * is XOR-ed into the last 32 bits of the episode GUID).
 */
export function guidFromRevitUniqueId(uniqueId: string | null | undefined): string | null {
  if (!uniqueId) return null;
  const match = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-([0-9a-fA-F]{8})$/.exec(uniqueId.trim());
  if (!match) return null;
  const hex = match[1].replace(/-/g, "");
  const tail = (parseInt(hex.slice(24), 16) ^ parseInt(match[2], 16)) >>> 0;
  return guidFromUuid(hex.slice(0, 24) + tail.toString(16).padStart(8, "0"));
}

/** A stable 128-bit hash of `key` as a GlobalId (the same key always gives the same id). */
export function hashGuid(key: string): string {
  // cyrb128: four 32-bit lanes, good dispersion, no crypto needed for identifiers.
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < key.length; i++) {
    const k = key.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, h1 >>> 0);
  view.setUint32(4, h2 >>> 0);
  view.setUint32(8, h3 >>> 0);
  view.setUint32(12, h4 >>> 0);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // reads as a name-based (version 5 style) UUID
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return compressGuid(bytes);
}
