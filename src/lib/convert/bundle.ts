// Readers for what the viewer extractor produces (public/convert/ifcstudio-extractor.js):
//
//   job file     "EANWD1" + pad + u32 header length + header JSON + 4-byte aligned sections
//                (little endian), optionally gzipped:
//                  ndb npar nname (u32) ntyp (u8)   node table: dbId, parent, name index, node type
//                  fdb fgeom fmat (u32)             fragment -> node, unique geometry, material
//                  fmtx (f32 x12) fbox (f32 x6)     world matrix (3x3 column-major + t) and box
//                  gmeta (u32 x5, x7 from format 3)  per geometry: nv, ni, flags, position / index offsets
//                                                    [, texture coordinate / vertex colour offsets]
//                  posQ (u16 x3) posF (f32 x3) i16 i32
//                  uv (f32 x2) col (u8 x3)           texture coordinates and vertex colours (format 3)
//   props file   JSON { job, strings, rows } (format 1: [dbId, {key: value}], format 2+: [dbId, k, v, k, v, …])
//   textures     <job>-tex<n>.png (format 3), the pictures the materials use
//   bundle       "EAPK1" + per file [u32 name length, f64 size, name, bytes] (one download for many files)
//
// Format 1 files are the ones written for the Etihad Arena model (ea-nwd-*.bin.gz); format 2 adds
// the unit scale, up axis and model / file names, and stores numbers unambiguously; format 3 adds
// full materials (specular, shininess, metal, textures and their placement), texture coordinates,
// vertex colours and line geometry.

export const GEOM_QUANTIZED = 1;
export const GEOM_INDEX32 = 2;
export const GEOM_NON_INDEXED = 4;
/** The shape is line segments (index pairs), not triangles. */
export const GEOM_LINES = 8;
/** gmeta entry for "no texture coordinates / vertex colours". */
export const GEOM_NONE = 0xffffffff;

/** A material as the extractor records it (format 3). Colours are hex "rrggbb". */
export interface MaterialRecord {
  /** Diffuse colour. */
  c: string;
  /** Opacity 0..1. */
  o: number;
  /** Name, when the viewer keeps one. */
  n?: string;
  /** Drawn as transparent. */
  t?: 1;
  /** Line material. */
  l?: 1;
  /** Specular colour, shininess (Phong exponent), reflectivity. */
  s?: string;
  sh?: number;
  r?: number;
  /** Metal: shaded with the specular colour. */
  m?: 1;
  /** Emissive colour. */
  e?: string;
  /** Multiplied by vertex colours. */
  vc?: 1;
  /** Autodesk physically based material type, and its roughness. */
  p?: string;
  ro?: number;
  /** Texture index (into the header's textures), its 3x3 coordinate matrix (column major), repeat and offset. */
  tex?: number;
  tm?: number[];
  rp?: [number, number];
  of?: [number, number];
  /** Texture repeats (1) or is clamped (0) along S and T. */
  ws?: 0 | 1;
  wt?: 0 | 1;
}

export interface TextureMeta {
  /** Original file name, when known. */
  name: string;
  w: number;
  h: number;
  /** Average colour "rrggbb" (for viewers that show no textures). */
  avg: string | null;
  /** False when the picture could not be read from the viewer. */
  ok: boolean;
}

export interface JobHeader {
  job: string;
  roots: number[];
  globalOffset: [number, number, number];
  strings: string[];
  /** [hex colour, opacity, name?] per material index. */
  materials: [string, number, string?][];
  sections: Record<string, [offset: number, count: number, type: string]>;
  format?: number;
  /** Metres per model unit (format 2). Format 1 files are in feet. */
  unitScale?: number;
  units?: string;
  /** The model's up direction (format 2); Z when absent. */
  up?: [number, number, number];
  /** Name of the model as the viewer shows it, and of the source file this job holds. */
  model?: string;
  file?: string;
  stats?: Record<string, number>;
  source?: string;
  extractedAt?: string;
  /** Entries per geometry in gmeta: 5 before format 3, 7 from it. */
  gmetaStride?: number;
  /** Full material records (format 3), parallel to `materials`. */
  materials3?: MaterialRecord[];
  textures?: TextureMeta[];
}

export interface JobData {
  header: JobHeader;
  ndb: Uint32Array;
  npar: Uint32Array;
  nname: Uint32Array;
  ntyp: Uint8Array;
  fdb: Uint32Array;
  fgeom: Uint32Array;
  fmat: Uint32Array;
  fmtx: Float32Array;
  fbox: Float32Array;
  gmeta: Uint32Array;
  posQ: Uint16Array;
  posF: Float32Array;
  i16: Uint16Array;
  i32: Uint32Array;
  uv: Float32Array;
  col: Uint8Array;
  /** Size of the decoded file, for reporting. */
  bytes: number;
}

export interface PropsData {
  job: string;
  format: number;
  /** "key": the identity and system fields only; "all": every property the viewer shows. */
  mode?: "key" | "all";
  strings: string[];
  numbers?: number[];
  /** Display units per key index (format 2), e.g. {"12": "ft"}. */
  units?: Record<string, string>;
  /** Format 1: [dbId, {keyIndex: value}]; format 2: [dbId, keyIndex, value, keyIndex, value, …]. */
  rows: unknown[];
}

export interface RawSourceJob {
  name: string;
  data: JobData;
  props: PropsData | null;
  /** Texture pictures (PNG) by texture index; missing ones are null. */
  textures?: (Uint8Array | null)[];
}

const SECTION_TYPES = {
  Uint32Array,
  Uint16Array,
  Uint8Array,
  Float32Array,
} as const;

const SECTION_KEYS = ["ndb", "npar", "nname", "ntyp", "fdb", "fgeom", "fmat", "fmtx", "fbox", "gmeta", "posQ", "posF", "i16", "i32", "uv", "col"] as const;
const EMPTY_TYPE: Record<string, typeof Uint8Array | typeof Uint16Array | typeof Uint32Array | typeof Float32Array> = {
  ntyp: Uint8Array,
  col: Uint8Array,
  posQ: Uint16Array,
  i16: Uint16Array,
  fmtx: Float32Array,
  fbox: Float32Array,
  posF: Float32Array,
  uv: Float32Array,
};

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

function isGzip(bytes: Uint8Array) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decompresses gzip data; returns other data unchanged (as a fresh, aligned copy). */
export async function inflateIfNeeded(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (isGzip(bytes)) return gunzip(bytes);
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

/** Parses a (decompressed) job file. */
export function parseJob(bytes: Uint8Array<ArrayBuffer>): JobData {
  const magic = new TextDecoder().decode(bytes.subarray(0, 6));
  if (magic !== "EANWD1") throw new BundleError("Not an extracted model file (missing EANWD1 header).");
  if (bytes.byteOffset % 4 !== 0) bytes = bytes.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength))) as JobHeader;
  let base = 12 + headerLength;
  base += (4 - (base % 4)) % 4;
  const out: Partial<JobData> = { header, bytes: bytes.byteLength };
  for (const key of SECTION_KEYS) {
    const section = header.sections?.[key];
    const Type = section ? SECTION_TYPES[section[2] as keyof typeof SECTION_TYPES] : undefined;
    if (!section || !Type) {
      (out as Record<string, unknown>)[key] = new (EMPTY_TYPE[key] ?? Uint32Array)(0);
      continue;
    }
    const [offset, count] = section;
    const start = bytes.byteOffset + base + offset;
    if (start + count * Type.BYTES_PER_ELEMENT > bytes.byteOffset + bytes.byteLength) throw new BundleError(`The model file is truncated (section ${key}).`);
    (out as Record<string, unknown>)[key] = new Type(bytes.buffer, start, count);
  }
  header.format ??= 1;
  header.roots ??= [];
  header.globalOffset ??= [0, 0, 0];
  header.materials ??= [];
  header.gmetaStride ??= 5;
  if (header.gmetaStride < 5) throw new BundleError("The model file has an unknown shape table.");
  return out as JobData;
}

export function parseProps(text: string): PropsData {
  const raw = JSON.parse(text) as Partial<PropsData> & { rows?: unknown[] };
  if (!raw || !Array.isArray(raw.rows) || !Array.isArray(raw.strings)) throw new BundleError("Not a properties file.");
  return { job: String(raw.job ?? ""), format: Number(raw.format ?? 1), mode: raw.mode === "all" ? "all" : "key", strings: raw.strings, numbers: raw.numbers, units: raw.units, rows: raw.rows };
}

/** Splits an .eapk bundle into its files. */
export function unpackBundle(bytes: Uint8Array<ArrayBuffer>): { name: string; bytes: Uint8Array<ArrayBuffer> }[] {
  const magic = new TextDecoder().decode(bytes.subarray(0, 5));
  if (magic !== "EAPK1") throw new BundleError("Not an extractor bundle (missing EAPK1 header).");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files: { name: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
  let at = 5;
  while (at + 12 <= bytes.byteLength) {
    const nameLength = view.getUint32(at, true);
    const size = view.getFloat64(at + 4, true);
    at += 12;
    if (at + nameLength + size > bytes.byteLength) throw new BundleError("The bundle is truncated; download it again.");
    const name = new TextDecoder().decode(bytes.subarray(at, at + nameLength));
    at += nameLength;
    files.push({ name, bytes: bytes.subarray(at, at + size) });
    at += size;
  }
  return files;
}

const NAME_RE = /^(?:ea-nwd-|ifcstudio-)(.+?)(-props\.json|\.bin)(?:\.gz)?$/i;
const TEXTURE_RE = /^(?:ea-nwd-|ifcstudio-)(.+?)-tex(\d+)\.png$/i;

/** What a loose file is, by its name: a job file, a props file, a texture, a bundle, or something else. */
export function classifySourceName(name: string): { kind: "job" | "props"; job: string } | { kind: "texture"; job: string; index: number } | { kind: "bundle" } | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  if (/\.eapk$/i.test(base)) return { kind: "bundle" };
  const texture = TEXTURE_RE.exec(base);
  if (texture) return { kind: "texture", job: texture[1], index: Number(texture[2]) };
  const match = NAME_RE.exec(base);
  if (!match) return null;
  return { kind: match[2].toLowerCase() === ".bin" ? "job" : "props", job: match[1] };
}

/**
 * Reads extractor output — bundles and/or loose job and props files — into
 * jobs. Props files are matched to their job by name.
 */
export async function readExtractorFiles(files: { name: string; bytes: Uint8Array<ArrayBuffer> }[], onFile?: (name: string) => void): Promise<{ jobs: RawSourceJob[]; ignored: string[] }> {
  const loose: { name: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
  const ignored: string[] = [];
  for (const file of files) {
    const kind = classifySourceName(file.name);
    if (kind?.kind === "bundle") loose.push(...unpackBundle(file.bytes));
    else if (kind) loose.push(file);
    else ignored.push(file.name);
  }
  const jobs = new Map<string, { data?: JobData; props?: PropsData; textures: (Uint8Array | null)[] }>();
  for (const file of loose) {
    const kind = classifySourceName(file.name);
    if (!kind || kind.kind === "bundle") {
      ignored.push(file.name);
      continue;
    }
    const entry = jobs.get(kind.job) ?? { textures: [] };
    jobs.set(kind.job, entry);
    if (kind.kind === "texture") {
      entry.textures[kind.index] = file.bytes.slice();
      continue;
    }
    onFile?.(file.name);
    const bytes = await inflateIfNeeded(file.bytes);
    if (kind.kind === "job") entry.data = parseJob(bytes);
    else entry.props = parseProps(new TextDecoder().decode(bytes));
  }
  const out: RawSourceJob[] = [];
  for (const [name, entry] of jobs) {
    if (!entry.data) {
      if (entry.props) ignored.push(`${name} (properties without geometry)`);
      else if (entry.textures.length) ignored.push(`${name} (textures without geometry)`);
      continue;
    }
    out.push({ name, data: entry.data, props: entry.props ?? null, textures: Array.from({ length: entry.textures.length }, (_, i) => entry.textures[i] ?? null) });
  }
  return { jobs: out, ignored };
}
