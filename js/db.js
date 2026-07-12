// db.js - IndexedDB wrapper: session autosave, media files, history, model/thumb cache
const DB_NAME = 'viralcut';
const DB_VERSION = 3;
const STORES = ['autosave', 'handles', 'history', 'media', 'models', 'thumbs', 'sessions', 'sessionHistory', 'sessionMedia'];

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
    req.onsuccess = () => {
      const db = req.result;
      _db = db;
      db.onversionchange = () => {
        db.close();
        if (_db === db) _db = null;
      };
      resolve(db);
    };
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

export async function all(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

export async function keys(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
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

// --- session persistence ---
export const loadSession = (sessionId) => get('sessions', sessionId);
export const saveSession = (sessionId, state) => set('sessions', sessionId, { ...state, id: sessionId });
export const loadSessionHistory = (sessionId) => get('sessionHistory', sessionId);
export const saveSessionHistory = (sessionId, h) => set('sessionHistory', sessionId, h);
export const saveSessionMedia = (sessionId, sourceId, file) => set('sessionMedia', mediaKey(sessionId, sourceId), file);
export const loadSessionMedia = (sessionId, sourceId) => get('sessionMedia', mediaKey(sessionId, sourceId));

export async function listSessions() {
  const sessions = await all('sessions');
  return sessions
    .filter(s => s?.id)
    .sort((a, b) => (b.updatedAt || b.savedAt || 0) - (a.updatedAt || a.savedAt || 0));
}

export async function latestSession() {
  return (await listSessions())[0] || null;
}

export async function deleteSession(sessionId) {
  await Promise.all([
    del('sessions', sessionId),
    del('sessionHistory', sessionId),
    deleteSessionMedia(sessionId),
  ]);
  const remaining = await listSessions();
  if (!remaining.length) await deleteEntireDatabase();
  return remaining;
}

// Removing the database, rather than clearing only current stores, also
// removes data left by older app versions (autosave, handles, models, thumbs,
// legacy media/history, and any other stores in the same database).
export function deleteEntireDatabase() {
  if (_db) {
    _db.close();
    _db = null;
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error(`Could not delete IndexedDB database: ${DB_NAME}`));
    req.onblocked = () => reject(new Error('Could not delete browser data because ViralCut is open in another tab'));
  });
}

export async function clearSessionMedia(sessionId) {
  await deleteSessionMedia(sessionId);
}

export async function estimateSessionBytes(sessionId) {
  const [session, history, mediaKeys] = await Promise.all([
    loadSession(sessionId).catch(() => null),
    loadSessionHistory(sessionId).catch(() => null),
    keys('sessionMedia').catch(() => []),
  ]);
  let bytes = jsonBytes(session) + jsonBytes(history);
  const prefix = `${sessionId}:`;
  for (const key of mediaKeys) {
    if (!String(key).startsWith(prefix)) continue;
    const file = await get('sessionMedia', key).catch(() => null);
    bytes += Number(file?.size || 0);
  }
  return bytes;
}

export async function pruneSessions(max = 15) {
  const sessions = await listSessions();
  await Promise.all(sessions.slice(max).map(s => deleteSession(s.id)));
}

async function deleteSessionMedia(sessionId) {
  const prefix = `${sessionId}:`;
  const mediaKeys = await keys('sessionMedia');
  await Promise.all(mediaKeys.filter(k => String(k).startsWith(prefix)).map(k => del('sessionMedia', k)));
}

function mediaKey(sessionId, sourceId) {
  return `${sessionId}:${sourceId}`;
}

function jsonBytes(value) {
  if (!value) return 0;
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}
