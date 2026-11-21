// Mesh helpers for the IFC writer: welding duplicate vertices, telling open
// or inconsistently wound shells from closed ones, and formatting triangle
// meshes as IfcCartesianPointList3D / IfcTriangulatedFaceSet text.
//
// The viewer splits vertices wherever normals change; IFC face sets carry no
// normals, so vertices that print the same are merged (files get ~40%
// smaller). A shell that is open or wound inconsistently is written
// two-sided (a reversed copy on duplicated points): IFC viewers cull back
// faces, and a one-sided sheet seen from behind disappears.

import type { MeshText } from "./ifc/writer";
import { real } from "./ifc/step";

/** Open-addressing hash from integer triples to dense indices. */
class TripleIndex {
  private keys: Int32Array;
  private values: Int32Array;
  private mask: number;
  size = 0;

  constructor(expected: number) {
    let capacity = 16;
    while (capacity < expected * 2) capacity <<= 1;
    this.keys = new Int32Array(capacity * 3);
    this.values = new Int32Array(capacity).fill(-1);
    this.mask = capacity - 1;
  }

  id(x: number, y: number, z: number): number {
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & this.mask;
    for (;;) {
      const v = this.values[h];
      if (v < 0) {
        this.values[h] = this.size;
        this.keys[h * 3] = x;
        this.keys[h * 3 + 1] = y;
        this.keys[h * 3 + 2] = z;
        return this.size++;
      }
      if (this.keys[h * 3] === x && this.keys[h * 3 + 1] === y && this.keys[h * 3 + 2] === z) return v;
      h = (h + 1) & this.mask;
    }
  }
}

const INT_LIMIT = 2 ** 31 - 1;

/**
 * Whether a mesh is a closed, consistently wound shell. Vertices are welded
 * on a grid of `step` (exact for quantised positions).
 */
export function shellTopology(positions: Float64Array, indices: Uint32Array, step: number): { open: boolean; misoriented: boolean } {
  const nv = positions.length / 3;
  const index = new TripleIndex(nv);
  const welded = new Int32Array(nv);
  for (let i = 0; i < nv; i++) {
    const x = Math.round(positions[i * 3] / step);
    const y = Math.round(positions[i * 3 + 1] / step);
    const z = Math.round(positions[i * 3 + 2] / step);
    if (Math.abs(x) > INT_LIMIT || Math.abs(y) > INT_LIMIT || Math.abs(z) > INT_LIMIT) return { open: true, misoriented: false };
    welded[i] = index.id(x, y, z);
  }
  const n = index.size;
  const edges = new Map<number, number>();
  let triangles = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = welded[indices[t]],
      b = welded[indices[t + 1]],
      c = welded[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    triangles++;
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = p * n + q;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  if (triangles === 0) return { open: true, misoriented: false };
  let open = false;
  let misoriented = false;
  for (const [key, count] of edges) {
    if (count > 1) misoriented = true;
    const p = Math.floor(key / n);
    const q = key - p * n;
    if (!edges.has(q * n + p)) open = true;
    if (open && misoriented) break;
  }
  return { open, misoriented };
}

const fmt = (tenths: number) => (tenths % 10 === 0 ? `${tenths / 10}.` : `${tenths / 10}`);

const uvText = (v: number) => {
  const r = Math.round(v * 1e5) / 1e5;
  return real(r === 0 ? 0 : r);
};

const colourText = (byte: number) => {
  const r = Math.round((byte / 255) * 1e4) / 1e4;
  return real(r);
};

export interface MeshOptions {
  /** Reverse the winding (mirrored placements, inward-facing shells). */
  flip?: boolean;
  /** Add a reversed copy of every triangle. */
  twoSided?: boolean;
  /** Texture coordinates per input vertex (u, v), already through the texture matrix. */
  uv?: Float32Array | null;
  /** Colour per input triangle (r, g, b bytes). */
  faceColours?: Uint8Array | null;
}

/**
 * Formats a mesh whose positions are in millimetres. Vertices are welded on
 * the 0.1 mm output grid, degenerate triangles dropped. `flip` reverses the
 * winding (for mirrored placements); `twoSided` adds a reversed copy. Texture
 * coordinates and face colours, when given, follow the triangles that are
 * kept (texture coordinates have their own index list, so welded vertices
 * keep their seams). Returns null when nothing is left.
 */
export function meshText(positions: Float64Array, indices: Uint32Array, options: MeshOptions): MeshText | null {
  const nv = positions.length / 3;
  const welded = new Int32Array(nv);
  const coords: number[] = [];
  let inRange = true;
  for (let i = 0; i < nv * 3; i++) {
    if (!(Math.abs(positions[i] * 10) < INT_LIMIT)) {
      inRange = false;
      break;
    }
  }
  if (inRange) {
    const index = new TripleIndex(nv);
    for (let i = 0; i < nv; i++) {
      const x = Math.round(positions[i * 3] * 10);
      const y = Math.round(positions[i * 3 + 1] * 10);
      const z = Math.round(positions[i * 3 + 2] * 10);
      const before = index.size;
      welded[i] = index.id(x, y, z);
      if (index.size > before) coords.push(x, y, z);
    }
  } else {
    // Hundreds of kilometres from the storey origin (a wrong frame): no welding, keep every vertex.
    for (let i = 0; i < nv; i++) {
      welded[i] = i;
      coords.push(Math.round(positions[i * 3] * 10), Math.round(positions[i * 3 + 1] * 10), Math.round(positions[i * 3 + 2] * 10));
    }
  }
  const tris: number[] = [];
  // Input corners of the kept triangles (for texture coordinates) and their input triangle.
  const corners: number[] | null = options.uv ? [] : null;
  const source: number[] | null = options.faceColours ? [] : null;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = welded[indices[t]],
      b = welded[indices[t + 1]],
      c = welded[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    // Zero-area triangles (collinear on the output grid) are dropped: IFC viewers discard them anyway,
    // and a shape made only of them would come out empty.
    const ux = coords[b * 3] - coords[a * 3],
      uy = coords[b * 3 + 1] - coords[a * 3 + 1],
      uz = coords[b * 3 + 2] - coords[a * 3 + 2];
    const vx = coords[c * 3] - coords[a * 3],
      vy = coords[c * 3 + 1] - coords[a * 3 + 1],
      vz = coords[c * 3 + 2] - coords[a * 3 + 2];
    if (uy * vz - uz * vy === 0 && uz * vx - ux * vz === 0 && ux * vy - uy * vx === 0) continue;
    if (options.flip) {
      tris.push(a, c, b);
      corners?.push(indices[t], indices[t + 2], indices[t + 1]);
    } else {
      tris.push(a, b, c);
      corners?.push(indices[t], indices[t + 1], indices[t + 2]);
    }
    source?.push(t / 3);
  }
  if (tris.length === 0) return null;
  // Drop points no triangle uses any more.
  const used = new Int32Array(coords.length / 3).fill(-1);
  let kept = 0;
  for (const v of tris) if (used[v] < 0) used[v] = kept++;
  if (kept < coords.length / 3) {
    const compact: number[] = new Array(kept * 3);
    for (let v = 0; v < used.length; v++) {
      const k = used[v];
      if (k < 0) continue;
      compact[k * 3] = coords[v * 3];
      compact[k * 3 + 1] = coords[v * 3 + 1];
      compact[k * 3 + 2] = coords[v * 3 + 2];
    }
    for (let t = 0; t < tris.length; t++) tris[t] = used[tris[t]];
    coords.length = 0;
    for (const x of compact) coords.push(x);
  }
  const n = coords.length / 3;
  const pointParts = new Array<string>(n);
  for (let i = 0; i < n; i++) pointParts[i] = `(${fmt(coords[i * 3])},${fmt(coords[i * 3 + 1])},${fmt(coords[i * 3 + 2])})`;
  let points = pointParts.join(",");
  const triParts = new Array<string>(tris.length / 3);
  for (let t = 0, k = 0; t < tris.length; t += 3, k++) triParts[k] = `(${tris[t] + 1},${tris[t + 1] + 1},${tris[t + 2] + 1})`;
  let faces = triParts.join(",");
  if (options.twoSided) {
    points = `${points},${points}`;
    const back = new Array<string>(tris.length / 3);
    for (let t = 0, k = 0; t < tris.length; t += 3, k++) back[k] = `(${tris[t] + 1 + n},${tris[t + 2] + 1 + n},${tris[t + 1] + 1 + n})`;
    faces = `${faces},${back.join(",")}`;
  }
  const out: MeshText = { points, indices: faces, closed: !options.twoSided };

  if (options.uv && corners) {
    const uv = options.uv;
    const lookup = new Map<string, number>();
    const list: string[] = [];
    const index = new Int32Array(corners.length);
    for (let k = 0; k < corners.length; k++) {
      const v = corners[k];
      const text = `(${uvText(uv[v * 2] ?? 0)},${uvText(uv[v * 2 + 1] ?? 0)})`;
      let id = lookup.get(text);
      if (id === undefined) {
        id = list.length;
        list.push(text);
        lookup.set(text, id);
      }
      index[k] = id + 1;
    }
    const front = new Array<string>(corners.length / 3);
    for (let k = 0, t = 0; k < corners.length; k += 3, t++) front[t] = `(${index[k]},${index[k + 1]},${index[k + 2]})`;
    let texIndices = front.join(",");
    if (options.twoSided) {
      const back = new Array<string>(corners.length / 3);
      for (let k = 0, t = 0; k < corners.length; k += 3, t++) back[t] = `(${index[k]},${index[k + 2]},${index[k + 1]})`;
      texIndices = `${texIndices},${back.join(",")}`;
    }
    out.texCoords = list.join(",");
    out.texIndices = texIndices;
  }

  if (options.faceColours && source) {
    const fc = options.faceColours;
    const lookup = new Map<number, number>();
    const list: string[] = [];
    const index = new Array<number>(source.length);
    for (let k = 0; k < source.length; k++) {
      const t = source[k];
      const key = (fc[t * 3] << 16) | (fc[t * 3 + 1] << 8) | fc[t * 3 + 2];
      let id = lookup.get(key);
      if (id === undefined) {
        id = list.length;
        list.push(`(${colourText(fc[t * 3])},${colourText(fc[t * 3 + 1])},${colourText(fc[t * 3 + 2])})`);
        lookup.set(key, id);
      }
      index[k] = id + 1;
    }
    const text = index.join(",");
    out.colours = list.join(",");
    out.colourIndex = options.twoSided ? `${text},${text}` : text;
  }
  return out;
}

/**
 * Chains line segments (index pairs) into polylines of millimetre points, for
 * IfcIndexedPolyCurve: each chain runs while consecutive segments share an end.
 */
export function polylines(positions: Float64Array, segments: Uint32Array): { points: string; runs: number[][] } | null {
  const nv = positions.length / 3;
  const welded = new Int32Array(nv);
  const coords: number[] = [];
  const index = new TripleIndex(nv);
  for (let i = 0; i < nv; i++) {
    const x = Math.round(positions[i * 3] * 10);
    const y = Math.round(positions[i * 3 + 1] * 10);
    const z = Math.round(positions[i * 3 + 2] * 10);
    if (!(Math.abs(x) < INT_LIMIT && Math.abs(y) < INT_LIMIT && Math.abs(z) < INT_LIMIT)) return null;
    const before = index.size;
    welded[i] = index.id(x, y, z);
    if (index.size > before) coords.push(x, y, z);
  }
  const runs: number[][] = [];
  let current: number[] | null = null;
  for (let s = 0; s + 1 < segments.length; s += 2) {
    const a = welded[segments[s]];
    const b = welded[segments[s + 1]];
    if (a === b) continue;
    if (current && current[current.length - 1] === a) current.push(b);
    else {
      current = [a, b];
      runs.push(current);
    }
  }
  if (runs.length === 0) return null;
  const n = coords.length / 3;
  const parts = new Array<string>(n);
  for (let i = 0; i < n; i++) parts[i] = `(${fmt(coords[i * 3])},${fmt(coords[i * 3 + 1])},${fmt(coords[i * 3 + 2])})`;
  return { points: parts.join(","), runs: runs.map((run) => run.map((v) => v + 1)) };
}
