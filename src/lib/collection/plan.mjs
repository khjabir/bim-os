// Works out what to open when a whole folder of models is handed over.
//
// Shared by the app and the command-line converter, so it is plain JavaScript
// without imports; the types live in plan.d.mts. Nothing here reads a file:
// the functions take file names, sizes and dates, and later the results of
// scanning the models, and answer with decisions.
//
// A project folder typically holds the same model several times (the IFC, a
// zipped copy, a converted .frag) and sometimes models that repeat what other
// models hold (a combined file next to the discipline files it was put
// together from). Opening all of it would draw things twice.

/** The kind of model file a name stands for, or null. A plain .zip only counts once it is known to hold IFC. */
export function modelKind(/** @type {string} */ path) {
  const name = path.toLowerCase();
  if (name.endsWith(".ifc")) return "ifc";
  if (name.endsWith(".ifczip")) return "ifczip";
  if (name.endsWith(".frag")) return "frag";
  return null;
}

/** Folders that are never part of a project's models. */
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", "__macosx", ".next", ".svn"]);

/** True for files inside tool folders and for Finder's hidden companion files. */
export function isClutterPath(/** @type {string} */ path) {
  const parts = path.split("/");
  const file = parts[parts.length - 1];
  if (file.startsWith("._") || file === ".DS_Store") return true;
  for (let i = 0; i < parts.length - 1; i++) if (SKIPPED_FOLDERS.has(parts[i].toLowerCase())) return true;
  return false;
}

/** File name without folders and without the model extension (and without the .ifc of "model.ifc.zip"). */
function stemOf(/** @type {string} */ path) {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.replace(/\.(ifczip|zip|frag)$/i, "").replace(/\.ifc$/i, "");
}

function folderOf(/** @type {string} */ path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * Groups the model files of a folder into models and picks the copy of each to open.
 *
 * @param {import("./plan.d.mts").PlanFile[]} files model files only (see `modelKind`); a .zip passed here is taken to hold IFC
 * @returns {import("./plan.d.mts").PlannedModel[]}
 */
export function planModels(files) {
  /** @type {Map<string, import("./plan.d.mts").PlannedModel>} */
  const groups = new Map();
  for (const file of files) {
    const stem = stemOf(file.path);
    const folder = folderOf(file.path);
    const key = `${folder}/${stem}`.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { key, stem, folder, copies: [], use: file, source: null, note: "" };
      groups.set(key, group);
    }
    group.copies.push(file);
  }

  // A .frag that sits in another folder than its IFC (a "frag" folder, say)
  // still belongs to it, as long as the name points at one model only.
  /** @type {Map<string, import("./plan.d.mts").PlannedModel[]>} */
  const byStem = new Map();
  for (const group of groups.values()) {
    const stem = group.stem.toLowerCase();
    byStem.set(stem, [...(byStem.get(stem) ?? []), group]);
  }
  for (const sameName of byStem.values()) {
    if (sameName.length < 2) continue;
    const withIfc = sameName.filter((group) => group.copies.some((copy) => copy.kind !== "frag"));
    const fragOnly = sameName.filter((group) => group.copies.every((copy) => copy.kind === "frag"));
    if (withIfc.length !== 1 || fragOnly.length === 0) continue;
    for (const group of fragOnly) {
      withIfc[0].copies.push(...group.copies);
      groups.delete(group.key);
    }
  }

  const models = [...groups.values()];
  for (const model of models) {
    const newest = (/** @type {string} */ kind) =>
      model.copies.filter((copy) => copy.kind === kind).sort((a, b) => b.lastModified - a.lastModified)[0] ?? null;
    const ifc = newest("ifc");
    const zipped = newest("ifczip");
    const frag = newest("frag");
    const original = ifc ?? zipped;
    if (frag && (!original || frag.lastModified >= original.lastModified - 2000)) {
      // A converted copy that is not older than the IFC opens in seconds and holds the same model.
      model.use = frag;
      model.source = ifc;
      model.note = original ? "Opens from the .frag saved for it, which is as new as the IFC." : "";
    } else if (original) {
      model.use = original;
      model.note = frag ? "The .frag saved for it is older than the IFC, so the IFC is converted again." : "";
    }
  }
  models.sort((a, b) => {
    const depth = a.folder.split("/").filter(Boolean).length - b.folder.split("/").filter(Boolean).length;
    return depth || collator.compare(a.folder, b.folder) || collator.compare(a.stem, b.stem);
  });
  return models;
}

/** How much of a model must be found elsewhere for it to count as a repeat. A few stray elements do not change the verdict. */
const REPEAT_SHARE = 0.98;

/**
 * Finds the models that only repeat what other models hold, from the
 * GlobalIds of their elements.
 *
 *  - Two models with the same elements are the same model twice: the first stays.
 *  - A model whose elements are all found in smaller models is a combined copy
 *    of them. The parts are kept, because they can be shown and hidden one by one.
 *  - A model whose elements are all found in one larger model is part of that
 *    model and is left out.
 *
 * @param {import("./plan.d.mts").ScannedModel[]} models in the order they would be opened
 * @returns {Map<string, import("./plan.d.mts").Repeat>} the models to leave out, by key
 */
export function findRepeats(models) {
  const known = models.filter((model) => model.guids && model.guids.length > 0);
  const size = (/** @type {import("./plan.d.mts").ScannedModel} */ model) => /** @type {string[]} */ (model.guids).length;
  const sets = new Map(known.map((model) => [model.key, new Set(model.guids)]));
  const position = new Map(known.map((model, index) => [model.key, index]));
  const at = (/** @type {import("./plan.d.mts").ScannedModel} */ model) => /** @type {number} */ (position.get(model.key));
  const shares = (/** @type {import("./plan.d.mts").ScannedModel} */ model, /** @type {import("./plan.d.mts").ScannedModel} */ other) => {
    const set = /** @type {Set<string>} */ (sets.get(other.key));
    let shared = 0;
    for (const guid of /** @type {string[]} */ (model.guids)) if (set.has(guid)) shared++;
    return shared;
  };
  /** @type {Map<string, import("./plan.d.mts").Repeat>} */
  const repeats = new Map();
  // Largest first. Of two models of one size the later one is looked at first, so the earlier one stays.
  const largestFirst = [...known].sort((a, b) => size(b) - size(a) || at(b) - at(a));

  // Twins and combined copies.
  for (const model of largestFirst) {
    const needed = size(model) * REPEAT_SHARE;
    const others = known.filter((other) => other !== model && !repeats.has(other.key) && size(other) <= size(model));
    const twin = others.find((other) => size(other) === size(model) && shares(model, other) >= needed);
    if (twin) {
      repeats.set(model.key, { kind: "same", of: [twin.key], shared: shares(model, twin), total: size(model) });
      continue;
    }
    const smaller = others.filter((other) => size(other) < size(model));
    if (smaller.length < 2) continue;
    const parts = smaller.filter((other) => shares(model, other) > 0);
    let covered = 0;
    for (const guid of /** @type {string[]} */ (model.guids)) {
      if (parts.some((part) => /** @type {Set<string>} */ (sets.get(part.key)).has(guid))) covered++;
    }
    // One part alone that nearly fills it is not a combination: the larger model then simply holds a little more.
    if (covered >= needed && parts.length >= 2 && !parts.some((part) => shares(model, part) >= needed)) {
      repeats.set(model.key, { kind: "combined", of: parts.sort((a, b) => at(a) - at(b)).map((part) => part.key), shared: covered, total: size(model) });
    }
  }

  // Parts of a larger model. Again largest first, so that a part is reported against a model that stays.
  for (const model of largestFirst) {
    if (repeats.has(model.key)) continue;
    let best = null;
    let bestShared = 0;
    for (const other of known) {
      if (other === model || repeats.has(other.key) || size(other) <= size(model)) continue;
      const shared = shares(model, other);
      if (shared > bestShared) {
        best = other;
        bestShared = shared;
      }
    }
    if (best && bestShared >= size(model) * REPEAT_SHARE) repeats.set(model.key, { kind: "part", of: [best.key], shared: bestShared, total: size(model) });
  }
  return repeats;
}
