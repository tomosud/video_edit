// fileOpen.js - manage source media: pick files, runtime URL registry, re-link
import { store, uid } from './store.js?v=20260627-nativepreview3';
import * as db from './db.js?v=20260627-nativepreview3';
import * as projectStore from './projectStore.js?v=20260627-nativepreview3';
import { hashKey } from './util.js?v=20260627-nativepreview3';
import { readMediaInfo } from './mediaInfo.js?v=20260627-nativepreview3';

// runtime registry: sourceId -> { file, url, handle }
const media = new Map();
let addVideoInFlight = null;
const handleKeyOf = (sourceId) => projectStore.sourceHandleKey(sourceId);

export function urlFor(sourceId) { return media.get(sourceId)?.url || null; }
export function fileFor(sourceId) { return media.get(sourceId)?.file || null; }
export function isLinked(sourceId) { return media.has(sourceId); }

async function readPermission(handle) {
  if (!handle?.queryPermission) return 'prompt';
  try {
    return await handle.queryPermission({ mode: 'read' });
  } catch {
    return 'prompt';
  }
}

async function requestReadPermission(handle) {
  if (!handle?.requestPermission) return 'prompt';
  try {
    return await handle.requestPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

async function fileFromStoredHandle(source, { requestPermission = false } = {}) {
  const handle = await db.loadHandle(source.handleKey || source.access?.handleKey || handleKeyOf(source.id));
  if (!handle) return null;

  let permission = await readPermission(handle);
  if (permission !== 'granted' && requestPermission) {
    permission = await requestReadPermission(handle);
  }
  if (permission !== 'granted') return null;

  try {
    return { file: await handle.getFile(), handle };
  } catch {
    return null;
  }
}

// Get a FRESH File for reading (export). A File captured earlier can go stale
// ("File could not be read! Code=-1") once the OS/handle invalidates it, so
// re-acquire from the stored FileSystemFileHandle when possible (re-prompting
// for permission if needed) and refresh the cached object URL too.
export async function freshFileFor(sourceId) {
  const entry = media.get(sourceId);
  if (!entry) return null;
  const h = entry.handle;
  if (h && h.getFile) {
    try {
      if (h.queryPermission) {
        let perm = await h.queryPermission({ mode: 'read' });
        if (perm !== 'granted') perm = await h.requestPermission({ mode: 'read' });
        if (perm !== 'granted') return entry.file;
      }
      const file = await h.getFile();
      if (entry.url) URL.revokeObjectURL(entry.url);
      const url = URL.createObjectURL(file);
      media.set(sourceId, { ...entry, file, url });
      return file;
    } catch { /* fall back to cached file */ }
  }
  return entry.file;
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

// Measure the real frame rate by sampling consecutive presented frames via
// requestVideoFrameCallback (the only reliable in-browser source of true frame
// timing). Returns a sensible fps, snapped to common rates; falls back to 30.
async function probeFps(url) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return 30;
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'auto'; v.muted = true; v.playsInline = true;
    const times = [];
    let done = false;
    const finish = (fps) => { if (done) return; done = true; try { v.pause(); } catch {} resolve(fps); };
    const onFrame = (_now, meta) => {
      times.push(meta.mediaTime);
      if (times.length >= 10) return finish(estimate());
      v.requestVideoFrameCallback(onFrame);
    };
    const estimate = () => {
      const deltas = [];
      for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1];
        if (d > 1e-4) deltas.push(d);
      }
      if (!deltas.length) return 30;
      deltas.sort((a, b) => a - b);
      const med = deltas[Math.floor(deltas.length / 2)];
      const raw = 1 / med;
      // snap to the nearest common broadcast/web frame rate
      const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
      let best = common[0], bestErr = Infinity;
      for (const c of common) { const e = Math.abs(c - raw); if (e < bestErr) { bestErr = e; best = c; } }
      return (bestErr / best < 0.05) ? best : Math.round(raw);
    };
    v.onerror = () => finish(30);
    v.onloadeddata = () => { v.currentTime = 0; v.play().then(() => v.requestVideoFrameCallback(onFrame)).catch(() => finish(30)); };
    setTimeout(() => finish(times.length > 1 ? estimate() : 30), 3000); // safety timeout
    v.src = url;
  });
}

async function nativeMediaInfo(url) {
  const duration = await probeDuration(url);
  const fps = await probeFps(url);
  return { duration, fps, width: 0, height: 0, hasAudio: false, videoDecodable: false, audioDecodable: false };
}

function register(sourceId, file, handle = null) {
  const old = media.get(sourceId);
  if (old?.url) URL.revokeObjectURL(old.url);
  const url = URL.createObjectURL(file);
  media.set(sourceId, { file, url, handle });
  return url;
}

// User adds a new video to the project
export async function addVideo() {
  if (addVideoInFlight) return addVideoInFlight;
  addVideoInFlight = addVideoImpl().finally(() => { addVideoInFlight = null; });
  return addVideoInFlight;
}

async function addVideoImpl() {
  let file, handle = null;
  if ('showOpenFilePicker' in window) {
    const [fh] = await window.showOpenFilePicker({
      types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mov', '.mkv', '.webm', '.m4v'] } }],
    });
    handle = fh;
    file = await fh.getFile();
  } else {
    file = await pickWithInput();
    if (!file) return null;
  }

  const id = uid('src');
  // stable source identity from file attributes (survives re-imports / sessions)
  const mediaKey = await hashKey(`${file.name}:${file.size}:${file.lastModified || 0}`);
  const existing = store.get().sources.find(s =>
    s.mediaKey === mediaKey || (s.fileName === file.name && s.size === file.size));
  if (existing) {
    register(existing.id, file, handle);
    const handleKey = handleKeyOf(existing.id);
    if (handle) db.saveHandle(handleKey, handle).catch(() => {});
    store.update((p) => {
      const t = p.sources.find(s => s.id === existing.id);
      if (t) t.handleKey = handleKey;
    }, { commit: false });
    store.setUI({ activeSourceId: existing.id });
    return existing.id;
  }

  const url = register(id, file, handle);
  let info;
  try {
    info = await readMediaInfo(file);
  } catch (err) {
    console.warn('Mediabunny metadata probe failed; falling back to native metadata.', err);
    info = await nativeMediaInfo(url);
  }
  if (handle) db.saveHandle(handleKeyOf(id), handle).catch(() => {});

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
      handleKey: handleKeyOf(id),
      subtitleFile: null,
    });
    ui.activeSourceId = id;
  });
  return id;
}

function pickWithInput() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'video/*';
    inp.onchange = () => resolve(inp.files[0] || null);
    inp.click();
  });
}

// After opening a project, try to re-link sources from their original file handles.
export async function relinkAll({ requestPermission = false } = {}) {
  const missing = [];
  for (const s of store.get().sources) {
    if (media.has(s.id)) continue;
    const linked = await fileFromStoredHandle(s, { requestPermission });
    if (linked) register(s.id, linked.file, linked.handle);
    else missing.push(s);
  }
  // backfill missing metadata now that media is linked
  for (const s of store.get().sources) {
    if ((s.fps && s.duration && s.width != null && s.height != null && s.hasAudio != null) || !media.has(s.id)) continue;
    let info;
    try {
      info = await readMediaInfo(media.get(s.id).file);
    } catch {
      info = await nativeMediaInfo(media.get(s.id).url);
    }
    store.update((p) => {
      const t = p.sources.find(x => x.id === s.id);
      if (t) Object.assign(t, {
        duration: t.duration || info.duration,
        fps: t.fps || info.fps,
        width: t.width ?? info.width,
        height: t.height ?? info.height,
        hasAudio: t.hasAudio ?? info.hasAudio,
        videoDecodable: t.videoDecodable ?? info.videoDecodable,
        audioDecodable: t.audioDecodable ?? info.audioDecodable,
        handleKey: t.handleKey || handleKeyOf(s.id),
      });
    }, { commit: false });
  }
  return missing; // sources still needing manual re-link
}

// Manually re-link one source (user picks the file)
export async function relinkOne(sourceId) {
  let file, handle = null;
  if ('showOpenFilePicker' in window) {
    const [h] = await window.showOpenFilePicker({ types: [{ description: 'Video', accept: { 'video/*': [] } }] });
    handle = h;
    file = await h.getFile();
  } else {
    file = await pickWithInput();
  }
  if (file) {
    register(sourceId, file, handle);
    let info = null;
    try { info = await readMediaInfo(file); } catch { /* metadata stays as-is */ }
    if (handle) db.saveHandle(handleKeyOf(sourceId), handle).catch(() => {});
    store.update((p) => {
      const t = p.sources.find(x => x.id === sourceId);
      if (!t) return;
      Object.assign(t, {
        fileName: file.name,
        size: file.size,
        lastModified: file.lastModified,
        handleKey: handleKeyOf(sourceId),
      });
      if (info) Object.assign(t, {
        duration: info.duration,
        fps: info.fps,
        width: info.width,
        height: info.height,
        hasAudio: info.hasAudio,
        videoDecodable: info.videoDecodable,
        audioDecodable: info.audioDecodable,
      });
    }, { commit: false });
  }
  return !!file;
}
