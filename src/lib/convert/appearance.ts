// What surfaces look like in the Autodesk viewer, and how that carries over to
// IFC and to the preview.
//
// The viewer shades with a Phong model (colours as "rrggbb"):
//   colour = texture × vertex colour × (emissive + diffuse × light) + specular highlights
// and, for metals, reflections tinted with the specular colour instead of a
// Fresnel term. IFC keeps the parts it has words for: diffuse and specular
// colours, the Phong exponent, transparency, the reflectance method and an
// image texture modulating the diffuse colour. Viewers that show only one
// colour per surface (most IFC viewers) read SurfaceColour, so that colour is
// what the viewer's rendering averages to: the texture's average colour, the
// vertex colours and, for metals, part of the reflection.

import type { MaterialRecord } from "./bundle";

export interface MaterialInfo {
  /** Diffuse colour. */
  color: string;
  opacity: number;
  name: string;
  transparent: boolean;
  specular: string | null;
  /** Phong exponent. */
  shininess: number | null;
  reflectivity: number | null;
  metal: boolean;
  emissive: string | null;
  /** Vertex colours multiply the diffuse colour. */
  vertexColors: boolean;
  /** Line material (drawn as lines). */
  lines: boolean;
  /** Autodesk physically based material type, and its roughness. */
  prism: string | null;
  roughness: number | null;
  /** Texture index, -1 for none. */
  texture: number;
  /** Texture coordinate transform (3x3, column major), null for identity. */
  texMatrix: Float64Array | null;
  repeatS: boolean;
  repeatT: boolean;
}

const HEX = /^[0-9a-f]{6}$/i;

function hexOr(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX.test(value) ? value.toLowerCase() : fallback;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function isIdentity(m: ArrayLike<number>) {
  const id = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < 9; i++) if (Math.abs(m[i] - id[i]) > 1e-9) return false;
  return true;
}

/** A material from the extractor's record (format 3) or the plain [colour, opacity, name] of older files. */
export function materialInfo(record: MaterialRecord | undefined, legacy: [string, number, string?] | undefined): MaterialInfo {
  const color = hexOr(record?.c ?? legacy?.[0], "8c8c8c");
  const opacityRaw = typeof record?.o === "number" ? record.o : typeof legacy?.[1] === "number" ? legacy[1] : 1;
  const info: MaterialInfo = {
    color,
    opacity: clamp01(Number.isFinite(opacityRaw) ? opacityRaw : 1),
    name: String(record?.n ?? legacy?.[2] ?? "").trim(),
    transparent: record?.t === 1,
    specular: record?.s ? hexOr(record.s, "000000") : null,
    shininess: typeof record?.sh === "number" && Number.isFinite(record.sh) ? record.sh : null,
    reflectivity: typeof record?.r === "number" && Number.isFinite(record.r) ? record.r : null,
    metal: record?.m === 1,
    emissive: record?.e ? hexOr(record.e, "000000") : null,
    vertexColors: record?.vc === 1,
    lines: record?.l === 1,
    prism: record?.p ?? null,
    roughness: typeof record?.ro === "number" && Number.isFinite(record.ro) ? record.ro : null,
    texture: typeof record?.tex === "number" && record.tex >= 0 ? record.tex : -1,
    texMatrix: null,
    repeatS: record?.ws !== 0,
    repeatT: record?.wt !== 0,
  };
  if (info.texture >= 0) {
    // The viewer's shaders map coordinates through the texture matrix; older three.js
    // materials use repeat and offset instead.
    const tm = record?.tm;
    if (tm && tm.length === 9 && tm.every((v) => Number.isFinite(v)) && !isIdentity(tm)) info.texMatrix = Float64Array.from(tm);
    else if (record?.rp || record?.of) {
      const [rx, ry] = record.rp ?? [1, 1];
      const [ox, oy] = record.of ?? [0, 0];
      const m = Float64Array.of(rx, 0, 0, 0, ry, 0, ox, oy, 1);
      if (!isIdentity(m)) info.texMatrix = m;
    }
  }
  return info;
}

export function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255];
}

export function toHex(c: [number, number, number]): string {
  return c.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0")).join("");
}

/** Component-wise product of two colours. */
export function multiplyHex(a: string, b: string): string {
  const x = rgb(a);
  const y = rgb(b);
  return toHex([x[0] * y[0], x[1] * y[1], x[2] * y[2]]);
}

/** Share of the viewer's environment a metal reflects, as seen on average. */
const METAL_REFLECTION = 0.5;

/**
 * The single colour a surface shows on average in the viewer: diffuse colour
 * times the texture's average colour and the vertex colour, plus reflections
 * for metals.
 */
export function surfaceColour(material: MaterialInfo, textureAverage: string | null, vertexColour: string | null): string {
  let [r, g, b] = rgb(material.color);
  if (material.texture >= 0 && textureAverage) {
    const t = rgb(textureAverage);
    r *= t[0];
    g *= t[1];
    b *= t[2];
  }
  if (vertexColour && material.vertexColors) {
    const v = rgb(vertexColour);
    r *= v[0];
    g *= v[1];
    b *= v[2];
  }
  if (material.metal && material.specular) {
    const s = rgb(material.specular);
    r += METAL_REFLECTION * s[0];
    g += METAL_REFLECTION * s[1];
    b += METAL_REFLECTION * s[2];
  }
  return toHex([r, g, b]);
}

/** IFC reflectance model closest to how the viewer shades the material. */
export function reflectanceMethod(material: MaterialInfo): "METAL" | "GLASS" | "PHONG" | "NOTDEFINED" {
  if (material.metal) return "METAL";
  if (material.opacity < 0.999) return "GLASS";
  if (material.specular || material.shininess !== null) return "PHONG";
  return "NOTDEFINED";
}

/** Texture coordinates after the material's texture matrix (what the viewer samples with). */
export function transformUvs(uv: Float32Array, matrix: Float64Array | null): Float32Array {
  if (!matrix) return uv;
  const out = new Float32Array(uv.length);
  const [m0, m1, , m3, m4, , m6, m7] = matrix;
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i];
    const v = uv[i + 1];
    out[i] = m0 * u + m3 * v + m6;
    out[i + 1] = m1 * u + m4 * v + m7;
  }
  return out;
}

/**
 * Colours of a shape's triangles from its vertex colours (IFC colours whole
 * faces): the uniform colour when every vertex has the same one, otherwise
 * per-triangle averages and their area-weighted mean.
 */
export function faceColours(positions: Float64Array, indices: Uint32Array, colours: Uint8Array): { uniform: string | null; mean: string; faces: Uint8Array | null } {
  const nv = colours.length / 3;
  let same = true;
  for (let i = 3; i < colours.length && same; i += 3) {
    if (colours[i] !== colours[0] || colours[i + 1] !== colours[1] || colours[i + 2] !== colours[2]) same = false;
  }
  if (nv === 0) return { uniform: null, mean: "ffffff", faces: null };
  const first = toHex([colours[0] / 255, colours[1] / 255, colours[2] / 255]);
  if (same) return { uniform: first, mean: first, faces: null };
  const nt = Math.floor(indices.length / 3);
  const faces = new Uint8Array(nt * 3);
  let wr = 0,
    wg = 0,
    wb = 0,
    total = 0;
  for (let t = 0; t < nt; t++) {
    const a = indices[t * 3],
      b = indices[t * 3 + 1],
      c = indices[t * 3 + 2];
    const r = (colours[a * 3] + colours[b * 3] + colours[c * 3]) / 3;
    const g = (colours[a * 3 + 1] + colours[b * 3 + 1] + colours[c * 3 + 1]) / 3;
    const bl = (colours[a * 3 + 2] + colours[b * 3 + 2] + colours[c * 3 + 2]) / 3;
    faces[t * 3] = Math.round(r);
    faces[t * 3 + 1] = Math.round(g);
    faces[t * 3 + 2] = Math.round(bl);
    const ux = positions[b * 3] - positions[a * 3],
      uy = positions[b * 3 + 1] - positions[a * 3 + 1],
      uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3],
      vy = positions[c * 3 + 1] - positions[a * 3 + 1],
      vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    wr += r * area;
    wg += g * area;
    wb += bl * area;
    total += area;
  }
  const mean = total > 0 ? toHex([wr / total / 255, wg / total / 255, wb / total / 255]) : first;
  return { uniform: null, mean, faces };
}
