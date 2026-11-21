// Clash detection between two sets of elements.
//
// Broad phase: sweep-and-prune over world-space bounding boxes.
// Narrow phase (optional): triangle tests with three-mesh-bvh on the real
// geometry, shrunk by the tolerance so elements that merely touch do not count.

import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { ModelIndex } from "@/lib/data/model-index";
import type { PlainIdMap } from "@/lib/store";

export type ClashMode = "hard" | "clearance";

export interface ClashOptions {
  mode: ClashMode;
  /** Hard clashes: minimum penetration in metres. Overlaps shallower than this are ignored. */
  tolerance: number;
  /** Clearance clashes: elements closer than this many metres are reported. */
  clearance: number;
  /** Confirm candidates against the triangle geometry (slower, far fewer false positives). */
  precise: boolean;
  /** Skip pairs where one element is hosted by the other (door in wall) or both share a parent. */
  ignoreRelated: boolean;
  maxResults: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number, stage: string) => void;
}

export interface ClashElement {
  modelId: string;
  localId: number;
}

export interface Clash {
  a: ClashElement;
  b: ClashElement;
  /** Centre of the overlap region, world space. */
  center: [number, number, number];
  /** Hard: smallest overlap extent in metres. Clearance: gap between the elements. */
  distance: number;
}

export interface ClashReport {
  clashes: Clash[];
  /** Pairs whose boxes overlapped before the triangle test. */
  candidates: number;
  truncated: boolean;
  elapsedMs: number;
}

interface Entry {
  modelId: string;
  localId: number;
  set: 0 | 1 | 2; // 0 = A, 1 = B, 2 = both
  box: THREE.Box3;
  parent: number;
}

class Cancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "Cancelled";
  }
}

export function isCancelled(error: unknown) {
  return error instanceof Cancelled;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function collectEntries(indexes: ModelIndex[], setA: PlainIdMap, setB: PlainIdMap, options: ClashOptions): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const index of indexes) {
    const a = new Set(setA[index.modelId] ?? []);
    const b = new Set(setB[index.modelId] ?? []);
    const ids = [...new Set([...a, ...b])].filter((id) => index.rowOf(id) >= 0);
    for (let start = 0; start < ids.length; start += 20_000) {
      if (options.signal?.aborted) throw new Cancelled();
      const batch = ids.slice(start, start + 20_000);
      // World-space boxes: the model transform is already applied by getBoxes.
      const boxes = await index.model.getBoxes(batch);
      for (let i = 0; i < batch.length; i++) {
        const box = boxes[i];
        if (!box || box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) continue;
        const id = batch[i];
        const inA = a.has(id);
        const inB = b.has(id);
        entries.push({
          modelId: index.modelId,
          localId: id,
          set: inA && inB ? 2 : inA ? 0 : 1,
          box,
          parent: index.parentOf[index.rowOf(id)],
        });
      }
    }
  }
  return entries;
}

/** Host relations: element -> the elements it is hosted by (door -> wall). */
async function hostPairs(indexes: ModelIndex[], entries: Entry[]): Promise<Set<string>> {
  const pairs = new Set<string>();
  for (const index of indexes) {
    const ids = entries.filter((entry) => entry.modelId === index.modelId).map((entry) => entry.localId);
    if (ids.length === 0) continue;
    const openingsOf = new Map<number, number[]>();
    const openingIds = new Set<number>();
    for (let start = 0; start < ids.length; start += 20_000) {
      const relations = await index.model.getRelations(ids.slice(start, start + 20_000));
      for (const [id, relation] of relations) {
        const openings = relation.data.FillsVoids;
        if (!openings || openings.length === 0) continue;
        openingsOf.set(id, openings);
        for (const opening of openings) openingIds.add(opening);
      }
    }
    if (openingIds.size === 0) continue;
    const hostOf = new Map<number, number[]>();
    const openingList = [...openingIds];
    for (let start = 0; start < openingList.length; start += 20_000) {
      const relations = await index.model.getRelations(openingList.slice(start, start + 20_000));
      for (const [opening, relation] of relations) hostOf.set(opening, relation.data.VoidsElements ?? []);
    }
    for (const [id, openings] of openingsOf) {
      for (const opening of openings) for (const host of hostOf.get(opening) ?? []) pairs.add(pairKey(index.modelId, id, index.modelId, host));
    }
  }
  return pairs;
}

function pairKey(modelA: string, idA: number, modelB: string, idB: number) {
  const first = `${modelA}:${idA}`;
  const second = `${modelB}:${idB}`;
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

interface Candidate {
  a: number;
  b: number;
  center: [number, number, number];
  depth: number;
}

/** Sweep along X; a pair is a candidate when its boxes overlap (or come within `margin`) on all axes. */
function broadPhase(entries: Entry[], margin: number, minOverlap: number, limit: number): { candidates: Candidate[]; truncated: boolean } {
  const order = entries.map((_, index) => index).sort((p, q) => entries[p].box.min.x - entries[q].box.min.x);
  const candidates: Candidate[] = [];
  let active: number[] = [];
  let truncated = false;

  for (const current of order) {
    const box = entries[current].box;
    const set = entries[current].set;
    const next: number[] = [];
    for (const other of active) {
      const otherBox = entries[other].box;
      if (otherBox.max.x + margin < box.min.x) continue; // no longer overlapping on X
      next.push(other);
      const otherSet = entries[other].set;
      // One must come from A and the other from B (2 means the element is in both sets).
      const crossing = set === 2 || otherSet === 2 || set !== otherSet;
      if (!crossing) continue;
      const overlapX = Math.min(box.max.x, otherBox.max.x) - Math.max(box.min.x, otherBox.min.x);
      const overlapY = Math.min(box.max.y, otherBox.max.y) - Math.max(box.min.y, otherBox.min.y);
      const overlapZ = Math.min(box.max.z, otherBox.max.z) - Math.max(box.min.z, otherBox.min.z);
      const smallest = Math.min(overlapX, overlapY, overlapZ);
      if (smallest <= minOverlap - margin) continue;
      if (candidates.length >= limit) {
        truncated = true;
        continue;
      }
      candidates.push({
        a: set === 1 ? other : current,
        b: set === 1 ? current : other,
        center: [
          (Math.max(box.min.x, otherBox.min.x) + Math.min(box.max.x, otherBox.max.x)) / 2,
          (Math.max(box.min.y, otherBox.min.y) + Math.min(box.max.y, otherBox.max.y)) / 2,
          (Math.max(box.min.z, otherBox.min.z) + Math.min(box.max.z, otherBox.max.z)) / 2,
        ],
        depth: smallest,
      });
    }
    next.push(current);
    active = next;
  }
  return { candidates, truncated };
}

// ---------------------------------------------------------------------------
// Narrow phase
// ---------------------------------------------------------------------------

interface Solid {
  geometry: THREE.BufferGeometry;
  bvh: MeshBVH;
  /** A vertex of the mesh, used for the containment test. */
  probe: THREE.Vector3;
}

function toMatrix(value: unknown): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  const elements = (value as { elements?: ArrayLike<number> } | undefined)?.elements;
  if (elements && elements.length === 16) matrix.fromArray(Array.from(elements));
  return matrix;
}

class SolidCache {
  private readonly solids = new Map<string, Solid | null>();
  private readonly limit = 600;

  constructor(
    private readonly indexes: Map<string, ModelIndex>,
    private readonly shrink: number,
  ) {}

  /** Loads the geometry of many elements of one model in one worker call. */
  async preload(modelId: string, ids: number[]) {
    const index = this.indexes.get(modelId);
    if (!index) return;
    const missing = ids.filter((id) => !this.solids.has(`${modelId}:${id}`));
    if (missing.length === 0) return;
    const world = index.model.object.matrixWorld;
    const meshes = await index.model.getItemsGeometry(missing);
    for (let i = 0; i < missing.length; i++) {
      this.solids.set(`${modelId}:${missing[i]}`, this.build(meshes[i] ?? [], world));
    }
  }

  /** Keeps memory bounded on long runs: drops the oldest solids that the current chunk does not need. */
  trim(keep: Set<string>) {
    if (this.solids.size <= this.limit) return;
    for (const key of [...this.solids.keys()]) {
      if (this.solids.size <= this.limit) break;
      if (keep.has(key)) continue;
      this.solids.get(key)?.geometry.dispose();
      this.solids.delete(key);
    }
  }

  get(modelId: string, localId: number): Solid | null {
    return this.solids.get(`${modelId}:${localId}`) ?? null;
  }

  has(modelId: string, localId: number) {
    return this.solids.has(`${modelId}:${localId}`);
  }

  dispose() {
    for (const solid of this.solids.values()) solid?.geometry.dispose();
    this.solids.clear();
  }

  private build(parts: { transform?: unknown; positions?: ArrayLike<number>; indices?: ArrayLike<number> }[], world: THREE.Matrix4): Solid | null {
    let vertexCount = 0;
    let indexCount = 0;
    for (const part of parts) {
      if (!part.positions || !part.indices) continue;
      vertexCount += part.positions.length / 3;
      indexCount += part.indices.length;
    }
    if (vertexCount === 0 || indexCount < 3) return null;

    const positions = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(indexCount);
    const point = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    let vertexOffset = 0;
    let indexOffset = 0;
    for (const part of parts) {
      if (!part.positions || !part.indices) continue;
      matrix.multiplyMatrices(world, toMatrix(part.transform));
      const count = part.positions.length / 3;
      for (let i = 0; i < count; i++) {
        point.set(part.positions[i * 3], part.positions[i * 3 + 1], part.positions[i * 3 + 2]).applyMatrix4(matrix);
        positions[(vertexOffset + i) * 3] = point.x;
        positions[(vertexOffset + i) * 3 + 1] = point.y;
        positions[(vertexOffset + i) * 3 + 2] = point.z;
      }
      for (let i = 0; i < part.indices.length; i++) indices[indexOffset + i] = part.indices[i] + vertexOffset;
      vertexOffset += count;
      indexOffset += part.indices.length;
    }

    // Shrink towards the centre by half the tolerance per side, so that
    // surfaces in mere contact (a slab resting on a wall) do not intersect.
    if (this.shrink > 0) {
      const box = new THREE.Box3().setFromArray(positions);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const scale = new THREE.Vector3(
        size.x > 0 ? Math.max(0.5, (size.x - this.shrink) / size.x) : 1,
        size.y > 0 ? Math.max(0.5, (size.y - this.shrink) / size.y) : 1,
        size.z > 0 ? Math.max(0.5, (size.z - this.shrink) / size.z) : 1,
      );
      for (let i = 0; i < positions.length; i += 3) {
        positions[i] = center.x + (positions[i] - center.x) * scale.x;
        positions[i + 1] = center.y + (positions[i + 1] - center.y) * scale.y;
        positions[i + 2] = center.z + (positions[i + 2] - center.z) * scale.z;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    const bvh = new MeshBVH(geometry, { maxLeafSize: 8 });
    return { geometry, bvh, probe: new THREE.Vector3(positions[0], positions[1], positions[2]) };
  }
}

const IDENTITY = new THREE.Matrix4();
const RAY = new THREE.Ray();
const DIRECTION = new THREE.Vector3(0.577, 0.577, 0.577).normalize();

/** True when `point` lies inside the closed surface of `solid` (odd number of ray crossings). */
function contains(solid: Solid, point: THREE.Vector3): boolean {
  RAY.origin.copy(point);
  RAY.direction.copy(DIRECTION);
  return solid.bvh.raycast(RAY, THREE.DoubleSide).length % 2 === 1;
}

function solidsIntersect(a: Solid, b: Solid): boolean {
  if (a.bvh.intersectsGeometry(b.geometry, IDENTITY)) return true;
  // No surface crossing: one may still sit entirely inside the other.
  return contains(a, b.probe) || contains(b, a.probe);
}

function solidsDistance(a: Solid, b: Solid, max: number): number {
  if (solidsIntersect(a, b)) return 0;
  const hit = a.bvh.closestPointToGeometry(b.geometry, IDENTITY, undefined, undefined, 0, max);
  return hit ? hit.distance : Infinity;
}

// ---------------------------------------------------------------------------

export async function detectClashes(indexes: ModelIndex[], setA: PlainIdMap, setB: PlainIdMap, options: ClashOptions): Promise<ClashReport> {
  const started = performance.now();
  const progress = options.onProgress ?? (() => undefined);

  progress(0, "Reading bounding boxes");
  const entries = await collectEntries(indexes, setA, setB, options);
  if (options.signal?.aborted) throw new Cancelled();

  progress(0.1, "Finding overlapping boxes");
  const margin = options.mode === "clearance" ? Math.max(0, options.clearance) : 0;
  const minOverlap = options.mode === "hard" ? Math.max(0, options.tolerance) : 0;
  // The triangle test discards many candidates, so let more through when it runs.
  const candidateLimit = options.precise ? options.maxResults * 20 : options.maxResults;
  const { candidates, truncated: broadTruncated } = broadPhase(entries, margin, minOverlap, candidateLimit);
  await tick();

  let pairs = candidates;
  if (options.ignoreRelated && pairs.length > 0) {
    progress(0.15, "Reading host relations");
    const hosts = await hostPairs(indexes, entries);
    pairs = pairs.filter((pair) => {
      const a = entries[pair.a];
      const b = entries[pair.b];
      if (a.modelId === b.modelId) {
        if (a.parent >= 0 && a.parent === b.parent) return false; // parts of one assembly
        if (a.parent === b.localId || b.parent === a.localId) return false; // part and its parent
      }
      return !hosts.has(pairKey(a.modelId, a.localId, b.modelId, b.localId));
    });
  }

  const clashes: Clash[] = [];
  let truncated = broadTruncated;

  if (!options.precise) {
    for (const pair of pairs) {
      if (clashes.length >= options.maxResults) {
        truncated = true;
        break;
      }
      const a = entries[pair.a];
      const b = entries[pair.b];
      clashes.push({
        a: { modelId: a.modelId, localId: a.localId },
        b: { modelId: b.modelId, localId: b.localId },
        center: pair.center,
        distance: options.mode === "hard" ? pair.depth : Math.max(0, -pair.depth),
      });
    }
  } else {
    const byModel = new Map(indexes.map((index) => [index.modelId, index]));
    const cache = new SolidCache(byModel, options.mode === "hard" ? options.tolerance : 0);
    try {
      const chunk = 60;
      for (let start = 0; start < pairs.length; start += chunk) {
        if (options.signal?.aborted) throw new Cancelled();
        if (clashes.length >= options.maxResults) {
          truncated = true;
          break;
        }
        progress(0.2 + 0.8 * (start / pairs.length), `Checking geometry (${start} of ${pairs.length})`);
        const slice = pairs.slice(start, start + chunk);
        // One geometry request per model for the elements of this chunk.
        const needed = new Map<string, Set<number>>();
        const keep = new Set<string>();
        for (const pair of slice) {
          for (const entry of [entries[pair.a], entries[pair.b]]) {
            keep.add(`${entry.modelId}:${entry.localId}`);
            if (cache.has(entry.modelId, entry.localId)) continue;
            let ids = needed.get(entry.modelId);
            if (!ids) needed.set(entry.modelId, (ids = new Set()));
            ids.add(entry.localId);
          }
        }
        for (const [modelId, ids] of needed) await cache.preload(modelId, [...ids]);
        cache.trim(keep);

        for (const pair of slice) {
          const a = entries[pair.a];
          const b = entries[pair.b];
          const solidA = cache.get(a.modelId, a.localId);
          const solidB = cache.get(b.modelId, b.localId);
          if (!solidA || !solidB) continue;
          let distance: number;
          if (options.mode === "hard") {
            if (!solidsIntersect(solidA, solidB)) continue;
            distance = pair.depth;
          } else {
            distance = solidsDistance(solidA, solidB, options.clearance);
            if (distance > options.clearance) continue;
          }
          clashes.push({ a: { modelId: a.modelId, localId: a.localId }, b: { modelId: b.modelId, localId: b.localId }, center: pair.center, distance });
          if (clashes.length >= options.maxResults) break;
        }
        await tick();
      }
    } finally {
      cache.dispose();
    }
  }

  clashes.sort((p, q) => (options.mode === "hard" ? q.distance - p.distance : p.distance - q.distance));
  progress(1, "Done");
  return { clashes, candidates: candidates.length, truncated, elapsedMs: performance.now() - started };
}
