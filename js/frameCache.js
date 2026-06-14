// frameCache.js — two-layer frame thumbnail cache:
//   1) in-memory LRU (objectURLs) for the session
//   2) write-through to project folder: cache/frames/<sourceId>/<frameIndex>.jpg
// Falls back to memory-only when no project folder is open.
import * as projectStore from './projectStore.js';

const MEM_LIMIT = 1500;          // max cached frame URLs in memory
const mem = new Map();           // key -> { url, blob }  (Map keeps insertion order = LRU)
const dirCache = new Map();      // sourceId -> DirectoryHandle for cache/frames/<id>
const pending = new Map();       // key -> Promise (dedupe concurrent generation)

const keyOf = (sourceId, frame) => `${sourceId}/${frame}`;
const fileName = (frame) => `${frame}.jpg`;

function memGet(key) {
  const v = mem.get(key);
  if (v) { mem.delete(key); mem.set(key, v); } // bump LRU
  return v;
}
function memPut(key, blob) {
  const url = URL.createObjectURL(blob);
  mem.set(key, { url, blob });
  while (mem.size > MEM_LIMIT) {
    const [oldKey, old] = mem.entries().next().value;
    URL.revokeObjectURL(old.url);
    mem.delete(oldKey);
  }
  return url;
}

async function folderDir(sourceId, create) {
  if (dirCache.has(sourceId)) return dirCache.get(sourceId);
  const dir = await projectStore.getDir(`cache/frames/${sourceId}`, { create });
  if (dir) dirCache.set(sourceId, dir);
  return dir;
}

async function folderGet(sourceId, frame) {
  const dir = await folderDir(sourceId, false);
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(fileName(frame));
    return await fh.getFile();
  } catch { return null; }
}

async function folderPut(sourceId, frame, blob) {
  const dir = await folderDir(sourceId, true);
  if (!dir) return;
  try {
    const fh = await dir.getFileHandle(fileName(frame), { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  } catch { /* best-effort */ }
}

// Return an object URL for a cached frame, or null if not cached anywhere.
export async function get(sourceId, frame) {
  const key = keyOf(sourceId, frame);
  const m = memGet(key);
  if (m) return m.url;
  const file = await folderGet(sourceId, frame);
  if (file) return memPut(key, file);
  return null;
}

// Store a freshly generated frame (blob) -> returns object URL. Writes through to folder.
export function put(sourceId, frame, blob) {
  const key = keyOf(sourceId, frame);
  const url = memPut(key, blob);
  folderPut(sourceId, frame, blob); // fire-and-forget
  return url;
}

// Dedupe concurrent generation for the same frame.
export function once(sourceId, frame, gen) {
  const key = keyOf(sourceId, frame);
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    const existing = await get(sourceId, frame);
    if (existing) return existing;
    const blob = await gen();
    return put(sourceId, frame, blob);
  })().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

export function clearSource(sourceId) {
  for (const key of [...mem.keys()]) {
    if (key.startsWith(sourceId + '/')) { URL.revokeObjectURL(mem.get(key).url); mem.delete(key); }
  }
  dirCache.delete(sourceId);
}
