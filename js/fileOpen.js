// fileOpen.js — manage source media: pick files, runtime URL registry, re-link
import { store, uid } from './store.js';
import * as projectStore from './projectStore.js';
import * as db from './db.js';
import { hashKey } from './util.js';

// runtime registry: sourceId -> { file, url, handle }
const media = new Map();
let addVideoInFlight = null;

export function urlFor(sourceId) { return media.get(sourceId)?.url || null; }
export function fileFor(sourceId) { return media.get(sourceId)?.file || null; }
export function isLinked(sourceId) { return media.has(sourceId); }

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
  // stable cache identity from file name + size (survives re-imports / sessions)
  const mediaKey = await hashKey(`${file.name}:${file.size}`);
  const existing = store.get().sources.find(s =>
    s.mediaKey === mediaKey || (s.fileName === file.name && s.size === file.size));
  if (existing) {
    store.setUI({ activeSourceId: existing.id });
    return existing.id;
  }

  // copy into the project's gitignored media/ folder when a project is open,
  // then point the source at the on-disk copy.
  let relPath = 'media/' + file.name;
  if (projectStore.dirHandle()) {
    try {
      const copied = await projectStore.copyIntoMedia(file);
      if (copied) { relPath = copied.relPath; handle = copied.handle; file = copied.file; }
    } catch (err) {
      throw new Error('media フォルダへの動画コピーに失敗しました。コピー完了前に同じ動画を追加した場合は、少し待ってからもう一度試してください。\n' + (err?.message || err));
    }
  }

  const url = register(id, file, handle);
  const duration = await probeDuration(url);
  const fps = await probeFps(url);
  if (handle) db.saveHandle('media:' + id, handle).catch(() => {});

  store.update((p, ui) => {
    p.sources.push({
      id,
      fileName: file.name,
      relPath,
      mediaKey,
      size: file.size,
      lastModified: file.lastModified,
      duration,
      fps,
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

// After opening a project, try to re-link sources to media files
export async function relinkAll() {
  const missing = [];
  for (const s of store.get().sources) {
    if (media.has(s.id)) continue;
    // 1) try stored file handle
    let file = null;
    const handle = await db.loadHandle('media:' + s.id);
    if (handle) {
      try {
        const perm = await handle.queryPermission({ mode: 'read' });
        if (perm === 'granted' || (await handle.requestPermission({ mode: 'read' })) === 'granted') {
          file = await handle.getFile();
        }
      } catch { /* fall through */ }
    }
    // 2) try project media/ folder by name
    if (!file) file = await projectStore.findMedia(s.fileName);
    if (file) register(s.id, file, handle);
    else missing.push(s);
  }
  // backfill missing fps (older projects) now that media is linked
  for (const s of store.get().sources) {
    if (s.fps || !media.has(s.id)) continue;
    const fps = await probeFps(media.get(s.id).url);
    store.update((p) => { const t = p.sources.find(x => x.id === s.id); if (t) t.fps = fps; }, { commit: false });
  }
  return missing; // sources still needing manual re-link
}

// Manually re-link one source (user picks the file)
export async function relinkOne(sourceId) {
  const file = await ('showOpenFilePicker' in window
    ? window.showOpenFilePicker({ types: [{ description: 'Video', accept: { 'video/*': [] } }] }).then(([h]) => h.getFile())
    : pickWithInput());
  if (file) register(sourceId, file);
  return !!file;
}
