// fileOpen.js - browser source media registry with IndexedDB recovery.
import { store, uid } from './store.js?v=20260707-indexeddb-autosave';
import * as db from './db.js?v=20260707-indexeddb-autosave';
import { hashKey } from './util.js?v=20260707-indexeddb-autosave';
import { readMediaInfo } from './mediaInfo.js?v=20260707-indexeddb-autosave';

const media = new Map(); // sourceId -> { file, url, handle }
let addVideoInFlight = null;

export function urlFor(sourceId) { return media.get(sourceId)?.url || null; }
export function fileFor(sourceId) { return media.get(sourceId)?.file || null; }
export function isLinked(sourceId) { return media.has(sourceId); }

export function clear() {
  for (const entry of media.values()) {
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
  media.clear();
}

export async function clearSavedMedia() {
  await db.clearMedia();
}

function register(sourceId, file, handle = null) {
  const old = media.get(sourceId);
  if (old?.url) URL.revokeObjectURL(old.url);
  const url = URL.createObjectURL(file);
  media.set(sourceId, { file, url, handle });
  return url;
}

// Get a fresh File for export when the browser supplied a live file handle.
// Drag-and-dropped files do not have a handle, so the in-memory File is used.
export async function freshFileFor(sourceId) {
  const entry = media.get(sourceId);
  if (!entry) return null;
  const h = entry.handle;
  if (h?.getFile) {
    try {
      const file = await h.getFile();
      register(sourceId, file, h);
      return file;
    } catch {
      /* fall back to the File already selected for this temporary session */
    }
  }
  return entry.file;
}

export async function addVideo() {
  if (addVideoInFlight) return addVideoInFlight;
  addVideoInFlight = addVideoImpl().finally(() => { addVideoInFlight = null; });
  return addVideoInFlight;
}

async function addVideoImpl() {
  if ('showOpenFilePicker' in window) {
    const handles = await window.showOpenFilePicker({
      multiple: true,
      types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mov', '.mkv', '.webm', '.m4v'] } }],
    });
    const files = [];
    for (const handle of handles) files.push({ file: await handle.getFile(), handle });
    return addVideoEntries(files);
  }

  const files = await pickWithInput();
  return addVideoFiles(files);
}

export async function addVideoFiles(files) {
  const entries = [...files]
    .filter(file => file?.type?.startsWith('video/') || /\.(mp4|mov|mkv|webm|m4v)$/i.test(file?.name || ''))
    .map(file => ({ file, handle: null }));
  return addVideoEntries(entries);
}

async function addVideoEntries(entries) {
  const added = [];
  for (const entry of entries) {
    const id = await addOneVideo(entry.file, entry.handle);
    if (id) added.push(id);
  }
  return added;
}

async function addOneVideo(file, handle = null) {
  if (!file) return null;

  const mediaKey = await hashKey(`${file.name}:${file.size}:${file.lastModified || 0}`);
  const existing = store.get().sources.find(s =>
    s.mediaKey === mediaKey || (s.fileName === file.name && s.size === file.size));
  if (existing) {
    register(existing.id, file, handle);
    db.saveMedia(existing.id, file).catch((err) => console.warn('media save failed', err));
    store.setUI({ activeSourceId: existing.id });
    return existing.id;
  }

  const id = uid('src');
  const url = register(id, file, handle);
  let info;
  try {
    info = await readMediaInfo(file);
  } catch (err) {
    console.warn('Mediabunny metadata probe failed; falling back to native metadata.', err);
    info = await nativeMediaInfo(url);
  }

  store.update((p, ui) => {
    p.sources.push({
      id,
      fileName: file.name,
      mediaKey,
      size: file.size,
      lastModified: file.lastModified,
      duration: info.duration,
      fps: info.fps,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      videoDecodable: info.videoDecodable,
      audioDecodable: info.audioDecodable,
      subtitleFile: null,
    });
    ui.activeSourceId = id;
  });
  db.saveMedia(id, file).catch((err) => console.warn('media save failed', err));
  return id;
}

export async function restoreSavedMedia() {
  const restored = [];
  for (const source of store.get().sources) {
    if (media.has(source.id)) {
      restored.push(source.id);
      continue;
    }
    const file = await db.loadMedia(source.id).catch(() => null);
    if (!file) continue;
    register(source.id, file, null);
    restored.push(source.id);
  }
  return restored;
}

function pickWithInput() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'video/*';
    inp.multiple = true;
    inp.onchange = () => resolve(inp.files || []);
    inp.click();
  });
}

async function nativeMediaInfo(url) {
  const duration = await probeDuration(url);
  const fps = await probeFps(url);
  return { duration, fps, width: 0, height: 0, hasAudio: false, videoDecodable: false, audioDecodable: false };
}

async function probeDuration(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve(v.duration || 0);
    v.onerror = () => resolve(0);
    v.src = url;
  });
}

async function probeFps(url) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return 30;
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.muted = true;
    v.playsInline = true;
    const times = [];
    let done = false;
    const finish = (fps) => {
      if (done) return;
      done = true;
      try { v.pause(); } catch { /* ignore */ }
      resolve(fps);
    };
    const estimate = () => {
      const deltas = [];
      for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1];
        if (d > 1e-4) deltas.push(d);
      }
      if (!deltas.length) return 30;
      deltas.sort((a, b) => a - b);
      const raw = 1 / deltas[Math.floor(deltas.length / 2)];
      const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
      let best = common[0], bestErr = Infinity;
      for (const c of common) {
        const e = Math.abs(c - raw);
        if (e < bestErr) { bestErr = e; best = c; }
      }
      return (bestErr / best < 0.05) ? best : Math.round(raw);
    };
    const onFrame = (_now, meta) => {
      times.push(meta.mediaTime);
      if (times.length >= 10) return finish(estimate());
      v.requestVideoFrameCallback(onFrame);
    };
    v.onerror = () => finish(30);
    v.onloadeddata = () => {
      v.currentTime = 0;
      v.play().then(() => v.requestVideoFrameCallback(onFrame)).catch(() => finish(30));
    };
    setTimeout(() => finish(times.length > 1 ? estimate() : 30), 3000);
    v.src = url;
  });
}

export async function relinkAll() { return []; }
export async function relinkOne() { return false; }
