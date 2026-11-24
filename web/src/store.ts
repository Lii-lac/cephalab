// Saved data in IndexedDB ("seedtracker" / "kv"): one value per key, the same data v52 kept in localStorage
// (seedtracker.mybuilds.v2 = your builds, seedtracker.pathbuild = the build the Path screen shows).
// The UI reads synchronously: init() loads everything into memory once, set() writes through in the background.
// On first run anything under the old localStorage keys is copied in (left in place, so nothing is lost).

const DB = "seedtracker", OS = "kv", MIGRATED = "_migratedFromLocalStorage";
export const KEYS = { builds: "seedtracker.mybuilds.v2", pathBuild: "seedtracker.pathbuild" } as const;
const OLD_BUILDS_V1 = "seedtracker.builds.v1";

const cache = new Map<string, unknown>();
let db: IDBDatabase | null = null;
let writes: Promise<unknown> = Promise.resolve();

// a JSON round trip, as localStorage did (undefined fields drop out); everything saved is plain JSON
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

function open(): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(OS);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
function put(entries: [string, unknown][], clear = false): Promise<void> {
  const d = db;
  if (!d) return Promise.resolve();
  const p = new Promise<void>((ok, no) => {
    const tx = d.transaction(OS, "readwrite"), os = tx.objectStore(OS);
    if (clear) os.clear();
    for (const [k, v] of entries) v === undefined ? os.delete(k) : os.put(v, k);
    tx.oncomplete = () => ok();
    tx.onerror = tx.onabort = () => no(tx.error);
  });
  writes = writes.then(() => p, () => p);
  return p;
}

function fromLocalStorage(): [string, unknown][] {
  const out: [string, unknown][] = [];
  try {
    const parse = (k: string) => { const s = localStorage.getItem(k); if (s == null) return undefined; try { return JSON.parse(s); } catch { return undefined; } };
    let builds = parse(KEYS.builds);
    const v1 = parse(OLD_BUILDS_V1);                           // an older list in the same build shape, if any
    if (Array.isArray(v1)) {
      builds = Array.isArray(builds) ? builds : [];
      for (const b of v1) if (b && Array.isArray(b.set) && !builds.some((x: any) => x.id === b.id)) builds.push(b);
    }
    if (Array.isArray(builds)) out.push([KEYS.builds, builds]);
    const pb = localStorage.getItem(KEYS.pathBuild);
    if (pb != null) out.push([KEYS.pathBuild, pb]);
  } catch {}
  return out;
}

export const store = {
  /** Open the database, load it into memory, migrate localStorage on first run. Call once before the UI starts. */
  async init(): Promise<void> {
    try {
      db = await open();
      const tx = db.transaction(OS, "readonly").objectStore(OS);
      const [keys, vals] = await Promise.all([req(tx.getAllKeys()), req(tx.getAll())]);
      keys.forEach((k, i) => cache.set(String(k), vals[i]));
    } catch { db = null; }                                     // no IndexedDB (private mode etc.): memory only
    if (!cache.has(MIGRATED)) {
      const found = fromLocalStorage().filter(([k]) => !cache.has(k));
      for (const [k, v] of found) cache.set(k, v);
      cache.set(MIGRATED, Date.now());
      await put([...found, [MIGRATED, cache.get(MIGRATED)]]).catch(() => {});
    }
  },
  /** A copy of the value under key, or null (as localStorage.getItem). */
  get(key: string): any {
    return cache.has(key) ? clone(cache.get(key)) : null;
  },
  set(key: string, value: unknown): void {
    cache.set(key, clone(value));
    put([[key, cache.get(key)]]).catch(() => {});
  },
  /** Resolves once every write so far has reached IndexedDB. */
  flush(): Promise<unknown> { return writes.then(() => {}, () => {}); },
};

/** Forget everything saved (Settings > Reset everything), including the old localStorage copies so they are not migrated back. */
export async function resetAll(): Promise<void> {
  cache.clear();
  cache.set(MIGRATED, Date.now());
  try { for (const k of [KEYS.builds, KEYS.pathBuild, OLD_BUILDS_V1]) localStorage.removeItem(k); } catch {}
  await put([[MIGRATED, cache.get(MIGRATED)]], true).catch(() => {});
}

/** Everything saved, as one JSON file. */
export function exportJSON(): string {
  const data: Record<string, unknown> = {};
  for (const [k, v] of cache) if (k !== MIGRATED) data[k] = v;
  return JSON.stringify({ app: "cephalab", version: 1, at: new Date().toISOString(), data }, null, 2);
}

/** Replace everything saved with an exportJSON() file. Reload the page afterwards to redraw. */
export async function importJSON(text: string): Promise<void> {
  const f = JSON.parse(text);
  if (!f || (f.app !== "cephalab" && f.app !== "seedtracker") || typeof f.data !== "object") throw new Error("not a Cephalab export");
  const keep = cache.get(MIGRATED) ?? Date.now();
  cache.clear();
  for (const [k, v] of Object.entries(f.data)) cache.set(k, clone(v));
  cache.set(MIGRATED, keep);
  await put([...cache.entries()], true);
}
