// Preview data: the extracted model as ready-to-draw buffers with its
// materials, texture coordinates, vertex colours and texture pictures, for
// the 3D preview on the Convert page (three.js, main thread).
//
// Shapes used more than once are drawn instanced (one buffer, a matrix per
// use); the rest are merged per material in model coordinates (metres, Z up)
// around the preview centre. Large models are capped at a triangle budget,
// keeping the elements that show the most surface for their triangles (on
// the Etihad Arena facade: 87% of the surface with a sixth of the triangles).

import { surfaceColour, transformUvs, type MaterialInfo } from "./appearance";
import { chain, multiply, transformBox, translation, type Affine } from "./math";
import type { SourceJob } from "./model";
import type { BBox } from "./types";

export interface PreviewMaterial {
  name: string;
  color: string;
  opacity: number;
  specular: string | null;
  shininess: number | null;
  roughness: number | null;
  metal: boolean;
  emissive: string | null;
  vertexColors: boolean;
  /** Index into PreviewData.textures, -1 for none. */
  texture: number;
  repeatS: boolean;
  repeatT: boolean;
  /** The single colour IFC viewers without textures show. */
  surface: string;
}

export interface PreviewBatch {
  material: number;
  lines: boolean;
  /** Metres around the preview centre (merged), or shape space (instanced). */
  positions: Float32Array;
  indices: Uint32Array;
  /** Texture coordinates after the material's texture matrix. */
  uvs: Float32Array | null;
  colors: Uint8Array | null;
  /** Instance matrices, 16 per instance (column major); null for merged batches. */
  matrices: Float32Array | null;
  /** Instanced: element per instance. Merged: pairs [first triangle (or segment), element]. */
  picks: Int32Array;
}

export interface PreviewElement {
  name: string;
  category: string;
  level: string;
  file: string;
  material: string;
  texture: string;
}

export interface PreviewData {
  batches: PreviewBatch[];
  materials: PreviewMaterial[];
  textures: { name: string; bytes: Uint8Array }[];
  elements: PreviewElement[];
  /** Model coordinates (metres) of the preview origin. */
  center: [number, number, number];
  /** Preview coordinates. */
  bbox: BBox | null;
  stats: { elements: number; shown: number; triangles: number; totalTriangles: number; capped: boolean; instances: number; batches: number };
}

/** One element to draw: its job, element index and fragments. */
export interface PreviewItem {
  job: SourceJob;
  k: number;
  toMetres: Affine;
}

const MERGE_VERTICES = 1_500_000;

function toColumnMajor(m: Affine, out: Float32Array, offset: number) {
  out[offset] = m[0];
  out[offset + 1] = m[4];
  out[offset + 2] = m[8];
  out[offset + 3] = 0;
  out[offset + 4] = m[1];
  out[offset + 5] = m[5];
  out[offset + 6] = m[9];
  out[offset + 7] = 0;
  out[offset + 8] = m[2];
  out[offset + 9] = m[6];
  out[offset + 10] = m[10];
  out[offset + 11] = 0;
  out[offset + 12] = m[3];
  out[offset + 13] = m[7];
  out[offset + 14] = m[11];
  out[offset + 15] = 1;
}

type Typed = Float32Array | Uint32Array | Uint8Array | Int32Array;

/** A typed array that grows as values are appended. */
class Grow<T extends Typed> {
  data: T;
  length = 0;
  private readonly make: (n: number) => T;
  constructor(make: (n: number) => T) {
    this.make = make;
    this.data = make(1024);
  }
  reserve(extra: number) {
    if (this.length + extra <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = this.make(size);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  push(value: number) {
    this.reserve(1);
    this.data[this.length++] = value;
  }
  fill(value: number, count: number) {
    this.reserve(count);
    this.data.fill(value, this.length, this.length + count);
    this.length += count;
  }
  done(): T {
    return this.data.slice(0, this.length) as T;
  }
}

class Merger {
  positions = new Grow((n) => new Float32Array(n));
  indices = new Grow((n) => new Uint32Array(n));
  uvs = new Grow((n) => new Float32Array(n));
  colors = new Grow((n) => new Uint8Array(n));
  picks = new Grow((n) => new Int32Array(n));
  hasUv = false;
  hasColor = false;
  vertices = 0;
  primitives = 0;
  lastElement = -1;
  readonly material: number;
  readonly lines: boolean;
  constructor(material: number, lines: boolean) {
    this.material = material;
    this.lines = lines;
  }
}

export function buildPreview(items: PreviewItem[], center: [number, number, number], budget: number, options: { textures: boolean; lines: boolean }): PreviewData {
  const textures = options.textures;
  const toCenter = translation(-center[0], -center[1], -center[2]);
  const box = new Float64Array(6);

  // Elements, their triangle counts and sizes (for the budget).
  interface Candidate {
    item: PreviewItem;
    triangles: number;
    /** Half the surface of the element's box (m²), a stand-in for how much of the view it fills. */
    area: number;
    lineOnly: boolean;
  }
  const candidates: Candidate[] = [];
  let totalTriangles = 0;
  for (const item of items) {
    const { job, k } = item;
    let triangles = 0;
    let lineOnly = true;
    let x0 = Infinity,
      y0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      z1 = -Infinity;
    for (let j = job.elementStart[k]; j < job.elementStart[k + 1]; j++) {
      const f = job.fragOrder[j];
      const gi = job.data.fgeom[f];
      triangles += job.triangleCount(gi);
      if (!job.isLines(gi)) lineOnly = false;
      transformBox(item.toMetres, job.data.fbox, f * 6, box);
      x0 = Math.min(x0, box[0]);
      y0 = Math.min(y0, box[1]);
      z0 = Math.min(z0, box[2]);
      x1 = Math.max(x1, box[3]);
      y1 = Math.max(y1, box[4]);
      z1 = Math.max(z1, box[5]);
    }
    if (lineOnly && !options.lines) continue;
    totalTriangles += triangles;
    const [a, b, c] = Number.isFinite(x0) ? [x1 - x0, y1 - y0, z1 - z0] : [0, 0, 0];
    candidates.push({ item, triangles, area: a * b + b * c + a * c, lineOnly });
  }
  let chosen = candidates;
  let capped = false;
  if (totalTriangles > budget) {
    capped = true;
    const value = (c: Candidate) => c.area / Math.max(1, c.triangles);
    const sorted = [...candidates].sort((a, b) => value(b) - value(a));
    chosen = [];
    let used = 0;
    for (const c of sorted) {
      if (used + c.triangles > budget) continue;
      used += c.triangles;
      chosen.push(c);
    }
  }

  // Materials and textures, shared across jobs.
  const materials: PreviewMaterial[] = [];
  const materialIndex = new Map<string, number>();
  const textureList: { name: string; bytes: Uint8Array }[] = [];
  const textureIndex = new Map<string, number>();
  const materialOf = (job: SourceJob, mi: number): { index: number; info: MaterialInfo } => {
    const info = job.materialInfo(mi);
    const key = `${job.name}|${mi}`;
    let index = materialIndex.get(key);
    if (index === undefined) {
      let texture = -1;
      if (textures && info.texture >= 0) {
        const bytes = job.textureBytes(info.texture);
        if (bytes) {
          const tkey = `${job.name}|${info.texture}`;
          let t = textureIndex.get(tkey);
          if (t === undefined) {
            t = textureList.length;
            textureList.push({ name: job.textureMeta(info.texture)?.name || `texture ${t + 1}`, bytes });
            textureIndex.set(tkey, t);
          }
          texture = t;
        }
      }
      const average = info.texture >= 0 ? (job.textureMeta(info.texture)?.avg ?? null) : null;
      index = materials.length;
      materials.push({
        name: info.name,
        color: info.color,
        opacity: info.opacity,
        specular: info.specular,
        shininess: info.shininess,
        roughness: info.roughness,
        metal: info.metal,
        emissive: info.emissive,
        vertexColors: info.vertexColors,
        texture,
        repeatS: info.repeatS,
        repeatT: info.repeatT,
        surface: surfaceColour(info, average, null),
      });
      materialIndex.set(key, index);
    }
    return { index, info };
  };

  // Shapes used more than once among the chosen elements are instanced.
  const uses = new Map<string, number>();
  for (const c of chosen) {
    const { job, k } = c.item;
    for (let j = job.elementStart[k]; j < job.elementStart[k + 1]; j++) {
      const f = job.fragOrder[j];
      const gi = job.data.fgeom[f];
      if (job.isLines(gi)) continue;
      const key = `${job.name}|${gi}|${job.data.fmat[f]}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }

  const elements: PreviewElement[] = [];
  const instanced = new Map<string, { job: SourceJob; gi: number; mi: number; matrices: number[]; picks: number[] }>();
  const mergers = new Map<string, Merger[]>();
  const batches: PreviewBatch[] = [];
  let bbox: BBox | null = null;
  let drawn = 0;
  let instances = 0;

  const merger = (material: number, lines: boolean, vertices: number): Merger => {
    const key = `${material}|${lines ? 1 : 0}`;
    let list = mergers.get(key);
    if (!list) mergers.set(key, (list = []));
    let m = list[list.length - 1];
    if (!m || m.vertices + vertices > MERGE_VERTICES) {
      m = new Merger(material, lines);
      list.push(m);
    }
    return m;
  };

  const matrix = new Float32Array(16);
  for (const c of chosen) {
    const { job, k, toMetres } = c.item;
    const e = job.elementIds[k];
    const info = job.info(e);
    const elementIndex = elements.length;
    let materialName = "";
    let textureName = "";
    const base = multiply(toCenter, toMetres);
    for (let j = job.elementStart[k]; j < job.elementStart[k + 1]; j++) {
      const f = job.fragOrder[j];
      const gi = job.data.fgeom[f];
      const mi = job.data.fmat[f];
      const lines = job.isLines(gi);
      // Lines inside solid elements (centre lines, edges) stay out, as in the IFC.
      if (lines && !c.lineOnly) continue;
      const { index: material, info: mat } = materialOf(job, mi);
      if (!materialName) {
        const leaf = job.data.fdb[f];
        materialName = ((leaf !== e && job.nodeType(leaf) === 6 ? job.nodeName(leaf) : "") || mat.name).trim();
      }
      if (!textureName && mat.texture >= 0) textureName = job.textureMeta(mat.texture)?.name || "texture";
      const M = chain(base, job.fragmentMatrix(f));
      transformBox(base, job.data.fbox, f * 6, box);
      if (!bbox) bbox = [box[0], box[1], box[2], box[3], box[4], box[5]];
      else
        for (let i = 0; i < 3; i++) {
          if (box[i] < bbox[i]) bbox[i] = box[i];
          if (box[i + 3] > bbox[i + 3]) bbox[i + 3] = box[i + 3];
        }
      const key = `${job.name}|${gi}|${mi}`;
      if (!lines && (uses.get(key) ?? 0) > 1) {
        let entry = instanced.get(key);
        if (!entry) instanced.set(key, (entry = { job, gi, mi, matrices: [], picks: [] }));
        toColumnMajor(M, matrix, 0);
        for (let i = 0; i < 16; i++) entry.matrices.push(matrix[i]);
        entry.picks.push(elementIndex);
        drawn += job.triangleCount(gi);
        instances++;
        continue;
      }
      // Merged: the shape in preview coordinates.
      const { positions, indices } = job.geometry(gi);
      const nv = positions.length / 3;
      const m = merger(material, lines, nv);
      const first = m.vertices;
      m.positions.reserve(nv * 3);
      const P = m.positions.data;
      let w = m.positions.length;
      for (let i = 0; i < nv; i++) {
        const x = positions[i * 3],
          y = positions[i * 3 + 1],
          z = positions[i * 3 + 2];
        P[w++] = M[0] * x + M[1] * y + M[2] * z + M[3];
        P[w++] = M[4] * x + M[5] * y + M[6] * z + M[7];
        P[w++] = M[8] * x + M[9] * y + M[10] * z + M[11];
      }
      m.positions.length = w;
      if (m.lastElement !== elementIndex) {
        m.picks.push(m.primitives);
        m.picks.push(elementIndex);
        m.lastElement = elementIndex;
      }
      m.indices.reserve(indices.length);
      for (let i = 0; i < indices.length; i++) m.indices.data[m.indices.length++] = indices[i] + first;
      m.primitives += indices.length / (lines ? 2 : 3);
      if (!lines) drawn += indices.length / 3;
      // Texture coordinates and vertex colours; zeros / white where a shape has none.
      const uv = !lines && mat.texture >= 0 ? job.uvs(gi) : null;
      if (uv && !m.hasUv) {
        m.hasUv = true;
        m.uvs.fill(0, first * 2);
      }
      if (m.hasUv) {
        if (uv) {
          const t = transformUvs(uv, mat.texMatrix);
          m.uvs.reserve(nv * 2);
          m.uvs.data.set(t.subarray(0, nv * 2), m.uvs.length);
          m.uvs.length += nv * 2;
        } else m.uvs.fill(0, nv * 2);
      }
      const col = mat.vertexColors ? job.vertexColours(gi) : null;
      if (col && !m.hasColor) {
        m.hasColor = true;
        m.colors.fill(255, first * 3);
      }
      if (m.hasColor) {
        if (col) {
          m.colors.reserve(nv * 3);
          m.colors.data.set(col.subarray(0, nv * 3), m.colors.length);
          m.colors.length += nv * 3;
        } else m.colors.fill(255, nv * 3);
      }
      m.vertices += nv;
    }
    elements.push({ name: job.nodeName(e) || info.family || info.category, category: info.category, level: info.level, file: info.file, material: materialName, texture: textureName });
  }

  for (const entry of instanced.values()) {
    const { job, gi, mi } = entry;
    const { index: material, info: mat } = materialOf(job, mi);
    const { positions, indices } = job.geometry(gi);
    const uv = mat.texture >= 0 ? job.uvs(gi) : null;
    const col = mat.vertexColors ? job.vertexColours(gi) : null;
    batches.push({
      material,
      lines: false,
      positions: Float32Array.from(positions),
      indices,
      uvs: uv ? Float32Array.from(transformUvs(uv, mat.texMatrix)) : null,
      colors: col ? col.slice() : null,
      matrices: Float32Array.from(entry.matrices),
      picks: Int32Array.from(entry.picks),
    });
  }
  for (const list of mergers.values()) {
    for (const m of list) {
      if (m.vertices === 0) continue;
      batches.push({
        material: m.material,
        lines: m.lines,
        positions: m.positions.done(),
        indices: m.indices.done(),
        uvs: m.hasUv ? m.uvs.done() : null,
        colors: m.hasColor ? m.colors.done() : null,
        matrices: null,
        picks: m.picks.done(),
      });
    }
  }

  return {
    batches,
    materials,
    textures: textureList,
    elements,
    center,
    bbox,
    stats: { elements: candidates.length, shown: chosen.length, triangles: drawn, totalTriangles, capped, instances, batches: batches.length },
  };
}

/** Typed arrays of the preview, for postMessage transfer lists. */
export function previewTransfer(data: PreviewData): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const b of data.batches) {
    for (const a of [b.positions, b.indices, b.uvs, b.colors, b.matrices, b.picks]) if (a && a.buffer instanceof ArrayBuffer) out.add(a.buffer);
  }
  return [...out];
}
