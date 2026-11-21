// The facility workspace's storage: one IndexedDB database in this browser
// profile. Nothing here leaves the device; sharing goes through workspace and
// change files (package.ts).

export const STORES = {
  meta: "key",
  assets: "id",
  spaces: "id",
  systems: "name",
  tasks: "id",
  plans: "id",
  workOrders: "id",
  photos: "id",
  sources: "id",
  points: "id",
  alarms: "id",
  series: "pointId",
} as const;

export type StoreName = keyof typeof STORES;

const DB_NAME = "bim-os";
const DB_VERSION = 1;

let opening: Promise<IDBDatabase> | null = null;

export function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Storage request failed."));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Storage transaction was aborted (is the disk full?)."));
    tx.onerror = () => reject(tx.error ?? new Error("Storage transaction failed."));
  });
}

export function openDb(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) return Promise.reject(new Error("This browser keeps no local storage for the workspace (private window?)."));
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(STORES)) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the database: let it, and reopen next time.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      opening = null;
      reject(req.error ?? new Error("The workspace storage could not be opened."));
    };
    req.onblocked = () => reject(new Error("The workspace storage is held by another tab of bim-os; close it and try again."));
  });
  return opening;
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return request(db.transaction(store, "readonly").objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function getOne<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return request(db.transaction(store, "readonly").objectStore(store).get(key) as IDBRequest<T | undefined>);
}

/** Writes records (one transaction per call). */
export async function putMany(store: StoreName, values: unknown[]): Promise<void> {
  if (values.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  for (const value of values) os.put(value);
  return done(tx);
}

export async function deleteMany(store: StoreName, keys: IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  for (const key of keys) os.delete(key);
  return done(tx);
}

/** Replaces the whole content of several stores in one transaction. */
export async function replaceAll(content: Partial<Record<StoreName, unknown[]>>): Promise<void> {
  const db = await openDb();
  const names = Object.keys(STORES) as StoreName[];
  const tx = db.transaction(names, "readwrite");
  for (const name of names) {
    const os = tx.objectStore(name);
    os.clear();
    for (const value of content[name] ?? []) os.put(value);
  }
  return done(tx);
}

/** How much this site stores on the device, when the browser says. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return estimate ? { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

/** Asks the browser to keep the workspace when it is short of space (it may say no). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
