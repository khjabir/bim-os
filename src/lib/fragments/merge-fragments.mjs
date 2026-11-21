// Joins several Fragments models into one.
//
// Shared by the app (browser worker) and the command-line tools (Node), so it
// is plain JavaScript; the types live in merge-fragments.d.mts. It works on
// the uncompressed FlatBuffers data of each model and needs nothing but the
// flatbuffers package: the layout of the tables it reads and writes is
// written out below and is that of @thatopen/fragments 3.6 (file version "0001"
// of the Model schema).
//
// What a merge does:
//  - every model keeps all of its items, geometry, properties and relations;
//  - local ids are made unique by adding an offset per model, and every
//    reference to them (relations, GlobalId table, spatial tree) follows;
//  - each model is moved into the coordinate system of the first one, the
//    same shift the viewer applies when it shows the models side by side;
//  - the spatial trees are hung next to each other under one root.
//
// Models are added one at a time and can be released by the caller as soon as
// add() returns, so memory holds the output plus one input, not all inputs.

import { Builder } from "flatbuffers";
import { isElementClass } from "../collection/ifc-scan.mjs";

/** One Fragments file cannot exceed this: FlatBuffers addresses its data with 32-bit signed offsets. */
export const MAX_FRAGMENTS_BYTES = 0x7fffffff;

/** Thrown when the models cannot be joined. The message is written for the user. */
export class MergeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "MergeError";
  }
}

// ---------------------------------------------------------------------------
// Schema: field numbers of the tables, sizes of the structs
// ---------------------------------------------------------------------------

const MODEL = { metadata: 0, guids: 1, guidsItems: 2, maxLocalId: 3, localIds: 4, categories: 5, meshes: 6, attributes: 7, relations: 8, relationsItems: 9, guid: 10, spatialStructure: 11, uniqueAttributes: 12, relationNames: 13, indexes: 14 };
const MESHES = { coordinates: 0, meshesItems: 1, samples: 2, representations: 3, materials: 4, circleExtrusions: 5, shells: 6, localTransforms: 7, globalTransforms: 8, materialIds: 9, representationIds: 10, sampleIds: 11, localTransformIds: 12, globalTransformIds: 13 };
const SHELL = { profiles: 0, holes: 1, points: 2, bigProfiles: 3, bigHoles: 4, type: 5, profilesFaceIds: 6 };
const AXIS = { wires: 0, order: 1, parts: 2, wireSets: 3, circleCurves: 4 };
const SPATIAL = { localId: 0, category: 1, children: 2 };

const SAMPLE_BYTES = 16; // item, material, representation, local transform: four uint32
const REPRESENTATION_BYTES = 32; // id uint32, bounding box 6 float32, class int8 + padding
const MATERIAL_BYTES = 6; // r, g, b, a, rendered faces, stroke
const TRANSFORM_BYTES = 48; // position 3 float64, x direction 3 float32, y direction 3 float32
const POINT_BYTES = 12; // 3 float32
const WIRE_BYTES = 24;
const CIRCLE_CURVE_BYTES = 44;

const REPRESENTATION_SHELL = 1;
const REPRESENTATION_CIRCLE_EXTRUSION = 2;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Minimal FlatBuffers reader over one model. */
class Reader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  root() {
    return this.view.getUint32(0, true);
  }

  /** Position of a field inside its table, or 0 when the table does not have it. */
  field(/** @type {number} */ table, /** @type {number} */ index) {
    const vtable = table - this.view.getInt32(table, true);
    const slot = 4 + 2 * index;
    const offset = slot < this.view.getUint16(vtable, true) ? this.view.getUint16(vtable + slot, true) : 0;
    return offset ? table + offset : 0;
  }

  /** Follows the offset stored at `position`. */
  follow(/** @type {number} */ position) {
    return position + this.view.getUint32(position, true);
  }

  /** The table a field points to, or 0. */
  table(/** @type {number} */ table, /** @type {number} */ index) {
    const at = this.field(table, index);
    return at ? this.follow(at) : 0;
  }

  /** Start and element count of a vector field, or null. */
  vector(/** @type {number} */ table, /** @type {number} */ index) {
    const at = this.field(table, index);
    if (!at) return null;
    const vector = this.follow(at);
    return { start: vector + 4, length: this.view.getUint32(vector, true) };
  }

  /** A copy of the bytes of a vector of scalars or structs (empty when the field is missing). */
  copy(/** @type {number} */ table, /** @type {number} */ index, /** @type {number} */ elementBytes) {
    const vector = this.vector(table, index);
    if (!vector) return { bytes: new Uint8Array(0), length: 0 };
    return { bytes: this.bytes.slice(vector.start, vector.start + vector.length * elementBytes), length: vector.length };
  }

  /** Text of a string field. */
  text(/** @type {number} */ table, /** @type {number} */ index) {
    const at = this.field(table, index);
    if (!at) return null;
    return this.textAt(this.follow(at));
  }

  textAt(/** @type {number} */ string) {
    const length = this.view.getUint32(string, true);
    return new TextDecoder().decode(this.bytes.subarray(string + 4, string + 4 + length));
  }
}

/**
 * A quick look at one model: schema, counts, what its IfcProject says about
 * it, and the GlobalIds of its elements. Elements are told by their class,
 * with the rule the IFC scanner uses, so a model gives the same ids whether
 * it is looked at as IFC or as Fragments.
 * @param {Uint8Array} bytes uncompressed Fragments data
 * @returns {import("./merge-fragments.d.mts").FragmentsSummary}
 */
export function summariseFragments(bytes) {
  const reader = new Reader(bytes);
  const model = reader.root();
  const meshes = reader.table(model, MODEL.meshes);
  if (!meshes) throw new MergeError("This is not a Fragments model.");
  let schema = "";
  try {
    const metadata = JSON.parse(reader.text(model, MODEL.metadata) ?? "{}");
    if (typeof metadata?.schema === "string") schema = metadata.schema;
  } catch {
    // Unreadable metadata: the schema stays unknown.
  }
  const localIds = reader.vector(model, MODEL.localIds);
  const meshesItems = reader.vector(meshes, MESHES.meshesItems);
  const guids = reader.vector(model, MODEL.guids);
  const guidsItems = reader.vector(model, MODEL.guidsItems);

  const categories = reader.vector(model, MODEL.categories);
  const attributes = reader.vector(model, MODEL.attributes);
  const ascii = new TextDecoder("latin1");
  const textOf = (/** @type {number} */ string) => ascii.decode(reader.bytes.subarray(string + 4, string + 4 + reader.view.getUint32(string, true)));

  // GlobalIds are stored next to the local id of their item; the class of an item is found by its position.
  const indexOf = new Map();
  for (let i = 0; localIds && i < localIds.length; i++) indexOf.set(reader.view.getUint32(localIds.start + i * 4, true), i);
  /** Whether a class counts as an element, by where its name sits in the file (names are shared between items). */
  const elementClass = new Map();
  const elementGuids = [];
  for (let i = 0; guids && guidsItems && categories && i < guidsItems.length; i++) {
    const index = indexOf.get(reader.view.getUint32(guidsItems.start + i * 4, true));
    if (index === undefined || index >= categories.length) continue;
    const category = reader.follow(categories.start + index * 4);
    let isElement = elementClass.get(category);
    if (isElement === undefined) {
      isElement = isElementClass(textOf(category).toUpperCase());
      elementClass.set(category, isElement);
    }
    if (isElement) elementGuids.push(textOf(reader.follow(guids.start + i * 4)));
  }

  // The project's own words: the attributes of the IFCPROJECT item.
  let description = "";
  for (let i = 0; categories && attributes && i < categories.length && i < attributes.length; i++) {
    const category = reader.follow(categories.start + i * 4);
    if (reader.view.getUint32(category, true) !== 10 || textOf(category) !== "IFCPROJECT") continue;
    const data = reader.vector(reader.follow(attributes.start + i * 4), 0);
    const found = /** @type {Record<string, string>} */ ({});
    for (let k = 0; data && k < data.length; k++) {
      try {
        const [name, value] = JSON.parse(reader.textAt(reader.follow(data.start + k * 4)));
        if (typeof name === "string" && typeof value === "string") found[name] = value.trim();
      } catch {
        // Not an attribute in the usual form.
      }
    }
    description = found.Description || found.LongName || "";
    break;
  }
  return { schema, items: localIds?.length ?? 0, elements: elementGuids.length, drawn: meshesItems?.length ?? 0, description, guids: elementGuids };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Writes `bytes` as a vector of `count` elements of `elementBytes` each. */
function writeVector(/** @type {Builder} */ builder, /** @type {Uint8Array} */ bytes, /** @type {number} */ elementBytes, /** @type {number} */ count, /** @type {number} */ alignment) {
  builder.startVector(elementBytes, count, alignment);
  const b = /** @type {any} */ (builder);
  b.bb.setPosition((b.space -= bytes.length));
  b.bb.bytes().set(bytes, b.space);
  return builder.endVector();
}

/** Writes several byte chunks as one vector. */
function writeChunks(/** @type {Builder} */ builder, /** @type {Uint8Array[]} */ chunks, /** @type {number} */ elementBytes, /** @type {number} */ alignment) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  builder.startVector(elementBytes, total / elementBytes, alignment);
  const b = /** @type {any} */ (builder);
  // The builder fills its buffer from the end, so the last chunk goes in first.
  for (let i = chunks.length - 1; i >= 0; i--) {
    b.bb.setPosition((b.space -= chunks[i].length));
    b.bb.bytes().set(chunks[i], b.space);
  }
  return builder.endVector();
}

/** Writes a vector of offsets to objects written earlier. */
function writeOffsets(/** @type {Builder} */ builder, /** @type {ArrayLike<number>[]} */ lists) {
  let total = 0;
  for (const list of lists) total += list.length;
  builder.startVector(4, total, 4);
  for (let l = lists.length - 1; l >= 0; l--) {
    const list = lists[l];
    for (let i = list.length - 1; i >= 0; i--) builder.addOffset(list[i]);
  }
  return builder.endVector();
}

function writeString(/** @type {Builder} */ builder, /** @type {Uint8Array} */ utf8) {
  builder.addInt8(0);
  return writeVector(builder, utf8, 1, utf8.length, 1);
}

// ---------------------------------------------------------------------------
// The merger
// ---------------------------------------------------------------------------

/**
 * @param {import("./merge-fragments.d.mts").MergeOptions} options
 * @returns {import("./merge-fragments.d.mts").FragmentsMerger}
 */
export function createFragmentsMerger(options) {
  // The output is about as large as the inputs together. The buffer is sized
  // once, up front: the builder can only double it, and not past 1 GB.
  const capacity = Math.ceil(options.totalBytes * 1.04) + (16 << 20);
  if (capacity > MAX_FRAGMENTS_BYTES) {
    throw new MergeError(
      `These models hold ${(options.totalBytes / 1024 ** 3).toFixed(1)} GB of Fragments data together, and one Fragments file can hold 2 GB at most. Combine fewer models at a time.`,
    );
  }
  /** @type {Builder} */
  let builder;
  try {
    builder = new Builder(capacity);
  } catch {
    throw new MergeError(`Not enough memory to combine these models (${(capacity / 1024 ** 3).toFixed(1)} GB needed in one piece).`);
  }

  const encoder = new TextEncoder();
  /** Offsets of the tables and strings written so far, one list per model. */
  const shells = [];
  const circleExtrusions = [];
  const attributes = [];
  const categories = [];
  const guids = [];
  const relations = [];
  /** Chunks of the vectors that are written at the end, one chunk per model. */
  const chunks = {
    localIds: [], guidsItems: [], relationsItems: [], meshesItems: [], samples: [], representations: [], materials: [],
    localTransforms: [], globalTransforms: [], materialIds: [], representationIds: [], sampleIds: [], localTransformIds: [], globalTransformIds: [],
  };
  /** Children of the merged spatial root: offsets of nodes already written. */
  const roots = [];
  let rootCategory = "";
  /** @type {Uint8Array | null} */
  let coordinates = null;
  let basePosition = [0, 0, 0];
  let firstMetadata = /** @type {Record<string, unknown>} */ ({});
  const sources = [];
  const schemas = new Set();

  // Running totals: how far ids and indices of the next model are shifted.
  let idOffset = 0;
  let itemCount = 0;
  let meshCount = 0;
  let sampleCount = 0;
  let materialCount = 0;
  let representationCount = 0;
  let localTransformCount = 0;
  let shellCount = 0;
  let circleExtrusionCount = 0;

  const u32 = (/** @type {Uint8Array} */ bytes) => new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);

  /** Copies a vector of scalars or structs of a table, when it has one. */
  const copyVectorField = (/** @type {Reader} */ reader, /** @type {number} */ table, /** @type {number} */ index, /** @type {number} */ elementBytes, /** @type {number} */ alignment) => {
    const vector = reader.vector(table, index);
    if (!vector) return 0;
    return writeVector(builder, reader.bytes.subarray(vector.start, vector.start + vector.length * elementBytes), elementBytes, vector.length, alignment);
  };

  /** Tables whose only content is a vector of indices and, for holes, the profile they cut. */
  const copyIndexTables = (/** @type {Reader} */ reader, /** @type {number} */ shell, /** @type {number} */ index, /** @type {number} */ indexBytes, /** @type {boolean} */ withProfileId) => {
    const vector = reader.vector(shell, index);
    if (!vector) return 0;
    const offsets = new Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
      const table = reader.follow(vector.start + i * 4);
      const indices = copyVectorField(reader, table, 0, indexBytes, indexBytes);
      const profileAt = withProfileId ? reader.field(table, 1) : 0;
      builder.startObject(withProfileId ? 2 : 1);
      if (indices) builder.addFieldOffset(0, indices, 0);
      if (profileAt) {
        builder.addInt16(reader.view.getUint16(profileAt, true));
        builder.slot(1);
      }
      offsets[i] = builder.endObject();
    }
    return writeOffsets(builder, [offsets]);
  };

  const copyShell = (/** @type {Reader} */ reader, /** @type {number} */ shell) => {
    const points = copyVectorField(reader, shell, SHELL.points, POINT_BYTES, 4);
    const profiles = copyIndexTables(reader, shell, SHELL.profiles, 2, false);
    const holes = copyIndexTables(reader, shell, SHELL.holes, 2, true);
    const bigProfiles = copyIndexTables(reader, shell, SHELL.bigProfiles, 4, false);
    const bigHoles = copyIndexTables(reader, shell, SHELL.bigHoles, 4, true);
    const faceIds = copyVectorField(reader, shell, SHELL.profilesFaceIds, 2, 2);
    const typeAt = reader.field(shell, SHELL.type);
    builder.startObject(7);
    if (profiles) builder.addFieldOffset(SHELL.profiles, profiles, 0);
    if (holes) builder.addFieldOffset(SHELL.holes, holes, 0);
    if (points) builder.addFieldOffset(SHELL.points, points, 0);
    if (bigProfiles) builder.addFieldOffset(SHELL.bigProfiles, bigProfiles, 0);
    if (bigHoles) builder.addFieldOffset(SHELL.bigHoles, bigHoles, 0);
    if (typeAt) {
      builder.addInt8(reader.view.getInt8(typeAt));
      builder.slot(SHELL.type);
    }
    if (faceIds) builder.addFieldOffset(SHELL.profilesFaceIds, faceIds, 0);
    return builder.endObject();
  };

  const copyCircleExtrusion = (/** @type {Reader} */ reader, /** @type {number} */ extrusion) => {
    const radius = copyVectorField(reader, extrusion, 0, 8, 8);
    let axes = 0;
    const axesVector = reader.vector(extrusion, 1);
    if (axesVector) {
      const offsets = new Array(axesVector.length);
      for (let i = 0; i < axesVector.length; i++) {
        const axis = reader.follow(axesVector.start + i * 4);
        const wires = copyVectorField(reader, axis, AXIS.wires, WIRE_BYTES, 4);
        const order = copyVectorField(reader, axis, AXIS.order, 4, 4);
        const parts = copyVectorField(reader, axis, AXIS.parts, 1, 1);
        const circleCurves = copyVectorField(reader, axis, AXIS.circleCurves, CIRCLE_CURVE_BYTES, 4);
        let wireSets = 0;
        const setsVector = reader.vector(axis, AXIS.wireSets);
        if (setsVector) {
          const sets = new Array(setsVector.length);
          for (let s = 0; s < setsVector.length; s++) {
            const set = reader.follow(setsVector.start + s * 4);
            const points = copyVectorField(reader, set, 0, POINT_BYTES, 4);
            builder.startObject(1);
            if (points) builder.addFieldOffset(0, points, 0);
            sets[s] = builder.endObject();
          }
          wireSets = writeOffsets(builder, [sets]);
        }
        builder.startObject(5);
        if (wires) builder.addFieldOffset(AXIS.wires, wires, 0);
        if (order) builder.addFieldOffset(AXIS.order, order, 0);
        if (parts) builder.addFieldOffset(AXIS.parts, parts, 0);
        if (wireSets) builder.addFieldOffset(AXIS.wireSets, wireSets, 0);
        if (circleCurves) builder.addFieldOffset(AXIS.circleCurves, circleCurves, 0);
        offsets[i] = builder.endObject();
      }
      axes = writeOffsets(builder, [offsets]);
    }
    builder.startObject(2);
    if (radius) builder.addFieldOffset(0, radius, 0);
    if (axes) builder.addFieldOffset(1, axes, 0);
    return builder.endObject();
  };

  return {
    add(bytes, info) {
      const reader = new Reader(bytes);
      const model = reader.root();
      const meshes = reader.table(model, MODEL.meshes);
      if (!meshes) throw new MergeError(`${info.name} is not a Fragments model.`);
      const maxAt = reader.field(model, MODEL.maxLocalId);
      const maxLocalId = maxAt ? reader.view.getUint32(maxAt, true) : 0;
      if (idOffset + maxLocalId + 1 > 0xffffffff) throw new MergeError("These models hold more items together than one Fragments file can number.");

      /** Strings of this model that were written already, by where they sit in the input. */
      const written = new Map();
      const copyString = (/** @type {number} */ string) => {
        let offset = written.get(string);
        if (offset === undefined) {
          const length = reader.view.getUint32(string, true);
          offset = writeString(builder, reader.bytes.subarray(string + 4, string + 4 + length));
          written.set(string, offset);
        }
        return offset;
      };
      /** Copies a vector of strings; returns the offsets, not a vector. */
      const copyStrings = (/** @type {number} */ table, /** @type {number} */ index) => {
        const vector = reader.vector(table, index);
        if (!vector) return new Uint32Array(0);
        const offsets = new Uint32Array(vector.length);
        for (let i = 0; i < vector.length; i++) offsets[i] = copyString(reader.follow(vector.start + i * 4));
        return offsets;
      };
      /** Tables that hold nothing but a vector of strings (attributes, relations). */
      const copyStringTables = (/** @type {number} */ table, /** @type {number} */ index, /** @type {(string: number) => number} */ copyOne) => {
        const vector = reader.vector(table, index);
        if (!vector) return new Uint32Array(0);
        const offsets = new Uint32Array(vector.length);
        for (let i = 0; i < vector.length; i++) {
          const entry = reader.follow(vector.start + i * 4);
          const data = reader.vector(entry, 0);
          let dataOffset = 0;
          if (data) {
            const strings = new Array(data.length);
            for (let s = 0; s < data.length; s++) strings[s] = copyOne(reader.follow(data.start + s * 4));
            dataOffset = writeOffsets(builder, [strings]);
          }
          builder.startObject(1);
          if (dataOffset) builder.addFieldOffset(0, dataOffset, 0);
          offsets[i] = builder.endObject();
        }
        return offsets;
      };

      // --- geometry ------------------------------------------------------
      const shellVector = reader.vector(meshes, MESHES.shells);
      const shellOffsets = new Uint32Array(shellVector?.length ?? 0);
      for (let i = 0; i < shellOffsets.length; i++) shellOffsets[i] = copyShell(reader, reader.follow(/** @type {any} */ (shellVector).start + i * 4));
      shells.push(shellOffsets);

      const extrusionVector = reader.vector(meshes, MESHES.circleExtrusions);
      const extrusionOffsets = new Uint32Array(extrusionVector?.length ?? 0);
      for (let i = 0; i < extrusionOffsets.length; i++) extrusionOffsets[i] = copyCircleExtrusion(reader, reader.follow(/** @type {any} */ (extrusionVector).start + i * 4));
      circleExtrusions.push(extrusionOffsets);

      // --- placement -----------------------------------------------------
      // The model's own origin, in the coordinates all models of a project share.
      const coordinatesAt = reader.field(meshes, MESHES.coordinates);
      const own = coordinatesAt ? reader.bytes.slice(coordinatesAt, coordinatesAt + TRANSFORM_BYTES) : new Uint8Array(TRANSFORM_BYTES);
      const ownPosition = Array.from(new Float64Array(own.buffer, 0, 3));
      if (!coordinates) {
        coordinates = own;
        basePosition = ownPosition;
      }
      const shift = [basePosition[0] - ownPosition[0], basePosition[1] - ownPosition[1], basePosition[2] - ownPosition[2]];

      const globalTransforms = reader.copy(meshes, MESHES.globalTransforms, TRANSFORM_BYTES);
      if (shift[0] !== 0 || shift[1] !== 0 || shift[2] !== 0) {
        const doubles = new Float64Array(globalTransforms.bytes.buffer, 0, globalTransforms.length * 6);
        for (let i = 0; i < globalTransforms.length; i++) {
          doubles[i * 6] += shift[0];
          doubles[i * 6 + 1] += shift[1];
          doubles[i * 6 + 2] += shift[2];
        }
      }
      chunks.globalTransforms.push(globalTransforms.bytes);
      chunks.localTransforms.push(reader.copy(meshes, MESHES.localTransforms, TRANSFORM_BYTES).bytes);
      chunks.materials.push(reader.copy(meshes, MESHES.materials, MATERIAL_BYTES).bytes);

      // --- instances: every index moves by what the earlier models hold ----
      const samples = reader.copy(meshes, MESHES.samples, SAMPLE_BYTES);
      const sampleFields = u32(samples.bytes);
      for (let i = 0; i < samples.length; i++) {
        sampleFields[i * 4] += meshCount;
        sampleFields[i * 4 + 1] += materialCount;
        sampleFields[i * 4 + 2] += representationCount;
        sampleFields[i * 4 + 3] += localTransformCount;
      }
      chunks.samples.push(samples.bytes);

      const representations = reader.copy(meshes, MESHES.representations, REPRESENTATION_BYTES);
      const representationFields = u32(representations.bytes);
      for (let i = 0; i < representations.length; i++) {
        const kind = representations.bytes[i * REPRESENTATION_BYTES + 28];
        if (kind === REPRESENTATION_SHELL) representationFields[i * 8] += shellCount;
        else if (kind === REPRESENTATION_CIRCLE_EXTRUSION) representationFields[i * 8] += circleExtrusionCount;
      }
      chunks.representations.push(representations.bytes);

      const meshesItems = reader.copy(meshes, MESHES.meshesItems, 4);
      const meshItemIndices = u32(meshesItems.bytes);
      for (let i = 0; i < meshItemIndices.length; i++) meshItemIndices[i] += itemCount;
      chunks.meshesItems.push(meshesItems.bytes);

      // --- ids -------------------------------------------------------------
      const shifted = (/** @type {number} */ table, /** @type {number} */ index) => {
        const copy = reader.copy(table, index, 4);
        if (idOffset !== 0) {
          const ids = u32(copy.bytes);
          for (let i = 0; i < ids.length; i++) ids[i] += idOffset;
        }
        return copy;
      };
      const localIds = shifted(model, MODEL.localIds);
      chunks.localIds.push(localIds.bytes);
      chunks.guidsItems.push(shifted(model, MODEL.guidsItems).bytes);
      chunks.relationsItems.push(shifted(model, MODEL.relationsItems).bytes);
      chunks.materialIds.push(shifted(meshes, MESHES.materialIds).bytes);
      chunks.representationIds.push(shifted(meshes, MESHES.representationIds).bytes);
      chunks.sampleIds.push(shifted(meshes, MESHES.sampleIds).bytes);
      chunks.localTransformIds.push(shifted(meshes, MESHES.localTransformIds).bytes);
      chunks.globalTransformIds.push(shifted(meshes, MESHES.globalTransformIds).bytes);

      // --- data ------------------------------------------------------------
      attributes.push(copyStringTables(model, MODEL.attributes, copyString));
      categories.push(copyStrings(model, MODEL.categories));
      guids.push(copyStrings(model, MODEL.guids));

      // A relation is written as ["Name", id, id, ...]: the ids are local ids and move with the model.
      // (0 stands for "no item" and stays 0.)
      const offset = idOffset;
      const rewritten = new Map();
      const copyRelation =
        offset === 0
          ? copyString
          : (/** @type {number} */ string) => {
              let out = rewritten.get(string);
              if (out === undefined) {
                const relation = JSON.parse(reader.textAt(string));
                for (let i = 1; i < relation.length; i++) if (typeof relation[i] === "number" && relation[i] !== 0) relation[i] += offset;
                out = writeString(builder, encoder.encode(JSON.stringify(relation)));
                rewritten.set(string, out);
              }
              return out;
            };
      relations.push(copyStringTables(model, MODEL.relations, copyRelation));

      // --- spatial tree ----------------------------------------------------
      const copyNode = (/** @type {number} */ node) => {
        const children = reader.vector(node, SPATIAL.children);
        let childrenOffset = 0;
        if (children) {
          const offsets = new Array(children.length);
          for (let i = 0; i < children.length; i++) offsets[i] = copyNode(reader.follow(children.start + i * 4));
          childrenOffset = writeOffsets(builder, [offsets]);
        }
        const categoryAt = reader.field(node, SPATIAL.category);
        const category = categoryAt ? copyString(reader.follow(categoryAt)) : 0;
        const idAt = reader.field(node, SPATIAL.localId);
        builder.startObject(3);
        if (idAt) {
          builder.addInt32(reader.view.getUint32(idAt, true) + offset);
          builder.slot(SPATIAL.localId);
        }
        if (category) builder.addFieldOffset(SPATIAL.category, category, 0);
        if (childrenOffset) builder.addFieldOffset(SPATIAL.children, childrenOffset, 0);
        return builder.endObject();
      };
      const tree = reader.table(model, MODEL.spatialStructure);
      if (tree) {
        // A root that only names a class ("IFCPROJECT") is merged with the roots of the other models.
        const isClassNode = !reader.field(tree, SPATIAL.localId) && reader.field(tree, SPATIAL.category);
        if (isClassNode) {
          rootCategory ||= reader.text(tree, SPATIAL.category) ?? "";
          const children = reader.vector(tree, SPATIAL.children);
          for (let i = 0; children && i < children.length; i++) roots.push(copyNode(reader.follow(children.start + i * 4)));
        } else roots.push(copyNode(tree));
      }

      // --- bookkeeping -------------------------------------------------------
      let metadata = /** @type {Record<string, unknown>} */ ({});
      try {
        metadata = JSON.parse(reader.text(model, MODEL.metadata) ?? "{}") ?? {};
      } catch {
        // Unreadable metadata is left out.
      }
      if (sources.length === 0) firstMetadata = metadata;
      if (typeof metadata.schema === "string") schemas.add(metadata.schema);
      sources.push({ name: info.name, schema: metadata.schema ?? null, items: localIds.length, elements: meshesItems.length, localIdOffset: idOffset, maxLocalId: idOffset + maxLocalId });

      idOffset += maxLocalId + 1;
      itemCount += localIds.length;
      meshCount += meshesItems.length;
      sampleCount += samples.length;
      materialCount += chunks.materials[chunks.materials.length - 1].length / MATERIAL_BYTES;
      representationCount += representations.length;
      localTransformCount += chunks.localTransforms[chunks.localTransforms.length - 1].length / TRANSFORM_BYTES;
      shellCount += shellOffsets.length;
      circleExtrusionCount += extrusionOffsets.length;
      return { items: localIds.length, elements: meshesItems.length };
    },

    finish(details) {
      if (sources.length === 0 || !coordinates) throw new MergeError("There is no model to combine.");

      // Geometry tables and the vectors that describe where and how they are drawn.
      const shellsOffset = writeOffsets(builder, shells);
      const circleExtrusionsOffset = writeOffsets(builder, circleExtrusions);
      const globalTransforms = writeChunks(builder, chunks.globalTransforms, TRANSFORM_BYTES, 8);
      const localTransforms = writeChunks(builder, chunks.localTransforms, TRANSFORM_BYTES, 8);
      const representations = writeChunks(builder, chunks.representations, REPRESENTATION_BYTES, 4);
      const samples = writeChunks(builder, chunks.samples, SAMPLE_BYTES, 4);
      const materials = writeChunks(builder, chunks.materials, MATERIAL_BYTES, 1);
      const meshesItems = writeChunks(builder, chunks.meshesItems, 4, 4);
      const materialIds = writeChunks(builder, chunks.materialIds, 4, 4);
      const representationIds = writeChunks(builder, chunks.representationIds, 4, 4);
      const sampleIds = writeChunks(builder, chunks.sampleIds, 4, 4);
      const localTransformIds = writeChunks(builder, chunks.localTransformIds, 4, 4);
      const globalTransformIds = writeChunks(builder, chunks.globalTransformIds, 4, 4);

      builder.startObject(14);
      // The coordinates are a struct: stored inside the table, written right before its slot is set.
      builder.prep(8, TRANSFORM_BYTES);
      const b = /** @type {any} */ (builder);
      b.bb.setPosition((b.space -= TRANSFORM_BYTES));
      b.bb.bytes().set(coordinates, b.space);
      builder.addFieldStruct(MESHES.coordinates, builder.offset(), 0);
      builder.addFieldOffset(MESHES.meshesItems, meshesItems, 0);
      builder.addFieldOffset(MESHES.samples, samples, 0);
      builder.addFieldOffset(MESHES.representations, representations, 0);
      builder.addFieldOffset(MESHES.materials, materials, 0);
      builder.addFieldOffset(MESHES.circleExtrusions, circleExtrusionsOffset, 0);
      builder.addFieldOffset(MESHES.shells, shellsOffset, 0);
      builder.addFieldOffset(MESHES.localTransforms, localTransforms, 0);
      builder.addFieldOffset(MESHES.globalTransforms, globalTransforms, 0);
      builder.addFieldOffset(MESHES.materialIds, materialIds, 0);
      builder.addFieldOffset(MESHES.representationIds, representationIds, 0);
      builder.addFieldOffset(MESHES.sampleIds, sampleIds, 0);
      builder.addFieldOffset(MESHES.localTransformIds, localTransformIds, 0);
      builder.addFieldOffset(MESHES.globalTransformIds, globalTransformIds, 0);
      const meshes = builder.endObject();

      // The description keeps what the first model says and adds where everything came from.
      const metadata = {
        ...firstMetadata,
        schema: schemas.size === 1 ? [...schemas][0] : (firstMetadata.schema ?? null),
        combined: { name: details.name, models: sources },
      };
      const metadataOffset = builder.createString(JSON.stringify(metadata));
      const attributesOffset = writeOffsets(builder, attributes);
      const categoriesOffset = writeOffsets(builder, categories);
      const guidsOffset = writeOffsets(builder, guids);
      const relationsOffset = writeOffsets(builder, relations);
      const localIds = writeChunks(builder, chunks.localIds, 4, 4);
      const guidsItems = writeChunks(builder, chunks.guidsItems, 4, 4);
      const relationsItems = writeChunks(builder, chunks.relationsItems, 4, 4);
      const uniqueAttributes = writeOffsets(builder, []);
      const relationNames = writeOffsets(builder, []);
      const guid = builder.createString(details.id);

      const rootChildren = writeOffsets(builder, [roots]);
      const rootCategoryOffset = builder.createString(rootCategory || "IFCPROJECT");
      builder.startObject(3);
      builder.addFieldOffset(SPATIAL.category, rootCategoryOffset, 0);
      builder.addFieldOffset(SPATIAL.children, rootChildren, 0);
      const spatialStructure = builder.endObject();

      builder.startObject(15);
      builder.addFieldOffset(MODEL.meshes, meshes, 0);
      builder.addFieldOffset(MODEL.metadata, metadataOffset, 0);
      builder.addFieldOffset(MODEL.attributes, attributesOffset, 0);
      builder.addFieldOffset(MODEL.uniqueAttributes, uniqueAttributes, 0);
      builder.addFieldOffset(MODEL.relationNames, relationNames, 0);
      builder.addFieldOffset(MODEL.localIds, localIds, 0);
      builder.addFieldOffset(MODEL.categories, categoriesOffset, 0);
      builder.addFieldOffset(MODEL.relationsItems, relationsItems, 0);
      builder.addFieldOffset(MODEL.relations, relationsOffset, 0);
      builder.addFieldOffset(MODEL.guidsItems, guidsItems, 0);
      builder.addFieldOffset(MODEL.guids, guidsOffset, 0);
      builder.addFieldOffset(MODEL.spatialStructure, spatialStructure, 0);
      builder.addFieldOffset(MODEL.guid, guid, 0);
      builder.addInt32(idOffset);
      builder.slot(MODEL.maxLocalId);
      const root = builder.endObject();
      builder.finish(root);

      return {
        bytes: builder.asUint8Array(),
        models: sources,
        items: itemCount,
        elements: meshCount,
        samples: sampleCount,
      };
    },
  };
}
