// db.js - IndexedDB wrapper: autosave, media files, history, model/thumb cache
const DB_NAME = 'viralcut';
const DB_VERSION = 2;
const STORES = ['autosave', 'handles', 'history', 'media', 'models', 'thumbs'];

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    const r = fn(os);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function get(store, key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function set(store, key, value) {
  return tx(store, 'readwrite', (os) => os.put(value, key));
}

export function del(store, key) {
  return tx(store, 'readwrite', (os) => os.delete(key));
}

export function clear(store) {
  return tx(store, 'readwrite', (os) => os.clear());
}

// --- convenience ---
export const loadAutosave   = () => get('autosave', 'current');
export const saveAutosave   = (state) => set('autosave', 'current', state);
export const clearAutosave  = () => del('autosave', 'current');
export const loadHistory    = () => get('history', 'current');
export const saveHistory    = (h) => set('history', 'current', h);
export const clearHistory   = () => del('history', 'current');
export const saveMedia      = (sourceId, file) => set('media', sourceId, file);
export const loadMedia      = (sourceId) => get('media', sourceId);
export const deleteMedia    = (sourceId) => del('media', sourceId);
export const clearMedia     = () => clear('media');
export const saveHandle     = (key, handle) => set('handles', key, handle);
export const loadHandle      = (key) => get('handles', key);
