// db.js — promise-based IndexedDB wrapper (db "clf", version 1) with an in-memory fallback.
// Stores (PLAN §5.1):
//   vocab    key s        { s, t?, p?, d?, addedAt, source: "import"|"hsk", listName? }
//   cards    key cardId   { cardId, kind, ref, state, suspended?, introducedAt?, createdAt }
//   reviews  key id (auto){ id, cardId, ts, grade, elapsedMs }   — append-only log
//   settings key key      { key, value }
//   meta     key key      { key, value }   e.g. dataBuiltAt, lastOpen, suspendedClips
// Every call is wrapped so a failing IndexedDB never crashes the app: openDB() falls back to
// MemoryDB (db.mode === 'memory') and the UI shows a warning banner.

export const DB_NAME = 'clf';
export const DB_VERSION = 1;
export const STORES = {
  vocab: { keyPath: 's' },
  cards: { keyPath: 'cardId' },
  reviews: { keyPath: 'id', autoIncrement: true },
  settings: { keyPath: 'key' },
  meta: { keyPath: 'key' },
};

export const DEFAULT_SETTINGS = {
  autoplay: true,
  rate: 1.0,
  toneColors: true,
  showTraditional: false,
  showDefinition: true,
  threshold: 0,
  newWords: 15,
  newSentences: 10,
  sessionSize: 20,
  dayStart: 4,
  mirrorHcDeletions: false,
};

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** IndexedDB-backed store. */
class IDB {
  constructor(idb) { this.idb = idb; this.mode = 'idb'; }

  _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.idb.transaction(store, mode);
      let result;
      Promise.resolve(fn(tx.objectStore(store), tx)).then((r) => { result = r; }, reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  }

  get(store, key) { return this._tx(store, 'readonly', (s) => req2p(s.get(key))); }
  getAll(store) { return this._tx(store, 'readonly', (s) => req2p(s.getAll())); }
  count(store) { return this._tx(store, 'readonly', (s) => req2p(s.count())); }
  put(store, value) { return this._tx(store, 'readwrite', (s) => req2p(s.put(value))); }
  add(store, value) { return this._tx(store, 'readwrite', (s) => req2p(s.add(value))); }
  delete(store, key) { return this._tx(store, 'readwrite', (s) => req2p(s.delete(key))); }
  clear(store) { return this._tx(store, 'readwrite', (s) => req2p(s.clear())); }
  putMany(store, values) {
    return this._tx(store, 'readwrite', (s) => { for (const v of values) s.put(v); return values.length; });
  }
  deleteMany(store, keys) {
    return this._tx(store, 'readwrite', (s) => { for (const k of keys) s.delete(k); return keys.length; });
  }

  /** Replace the content of several stores atomically (backup restore). */
  replaceAll(dump) {
    const names = Object.keys(STORES).filter((n) => Array.isArray(dump[n]));
    return new Promise((resolve, reject) => {
      const tx = this.idb.transaction(names, 'readwrite');
      for (const n of names) {
        const s = tx.objectStore(n);
        s.clear();
        for (const row of dump[n]) s.put(row);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('restore aborted'));
    });
  }
}

/** In-memory fallback with the same API (data is lost on reload). */
export class MemoryDB {
  constructor() {
    this.mode = 'memory';
    this.stores = Object.fromEntries(Object.keys(STORES).map((n) => [n, new Map()]));
    this.seq = 0;
  }
  _key(store, value) {
    const { keyPath, autoIncrement } = STORES[store];
    if (value[keyPath] === undefined && autoIncrement) value[keyPath] = ++this.seq;
    return value[keyPath];
  }
  async get(store, key) { return structuredClone(this.stores[store].get(key)); }
  async getAll(store) { return [...this.stores[store].values()].map((v) => structuredClone(v)); }
  async count(store) { return this.stores[store].size; }
  async put(store, value) { const v = structuredClone(value); const k = this._key(store, v); this.stores[store].set(k, v); return k; }
  async add(store, value) {
    const v = structuredClone(value); const k = this._key(store, v);
    if (this.stores[store].has(k)) throw new Error('ConstraintError');
    this.stores[store].set(k, v); return k;
  }
  async delete(store, key) { this.stores[store].delete(key); }
  async clear(store) { this.stores[store].clear(); }
  async putMany(store, values) { for (const v of values) await this.put(store, v); return values.length; }
  async deleteMany(store, keys) { for (const k of keys) this.stores[store].delete(k); return keys.length; }
  async replaceAll(dump) {
    for (const n of Object.keys(STORES)) {
      if (!Array.isArray(dump[n])) continue;
      this.stores[n].clear();
      for (const row of dump[n]) await this.put(n, row);
    }
  }
}

/**
 * Open the database. Resolves to an IDB wrapper, or a MemoryDB if IndexedDB is missing,
 * blocked, errors, or hangs for > 4 s (seen on some old iOS private-mode builds).
 */
export async function openDB({ name = DB_NAME, memory = false } = {}) {
  if (memory || typeof indexedDB === 'undefined') return new MemoryDB();
  try {
    const idb = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IndexedDB open timed out')), 4000);
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const [store, opts] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, opts);
        }
      };
      req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
      req.onerror = () => { clearTimeout(timer); reject(req.error); };
      req.onblocked = () => { clearTimeout(timer); reject(new Error('IndexedDB blocked')); };
    });
    const db = new IDB(idb);
    await db.count('meta'); // smoke test: some browsers open but fail on first transaction
    return db;
  } catch (err) {
    console.warn('IndexedDB unavailable, using memory store:', err);
    return new MemoryDB();
  }
}

/** Settings merged over defaults. */
export async function loadSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  try {
    for (const row of await db.getAll('settings')) if (row && row.key in DEFAULT_SETTINGS) out[row.key] = row.value;
  } catch (err) { console.warn('settings load failed', err); }
  return out;
}

/** Read a meta value (undefined if absent or on error). */
export async function getMeta(db, key) {
  try { return (await db.get('meta', key))?.value; } catch { return undefined; }
}

/** Write a meta value (errors are logged, not thrown). */
export async function setMeta(db, key, value) {
  try { await db.put('meta', { key, value }); } catch (err) { console.warn('meta write failed', err); }
}
