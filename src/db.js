// Tiny IndexedDB wrapper: keeps opened models on the device so they show up
// in the library without re-picking them.
const DB = 'skpviewer';
const STORE = 'models';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const s = t.objectStore(STORE);
        const out = fn(s);
        t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const store = {
  async list() {
    const all = await tx('readonly', (s) => s.getAll());
    // Don't keep the file bytes around just to draw the library.
    return all
      .map(({ data, ...meta }) => meta)
      .sort((a, b) => (b.opened || 0) - (a.opened || 0));
  },
  get(id) { return tx('readonly', (s) => s.get(id)); },
  put(rec) { return tx('readwrite', (s) => s.put(rec)); },
  remove(id) { return tx('readwrite', (s) => s.delete(id)); },
  async touch(id) {
    const r = await this.get(id);
    if (r) { r.opened = Date.now(); await this.put(r); }
  },
};

export function idFor(name, size) {
  return `${name}::${size}`;
}
