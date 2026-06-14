// fileOpen.js — manage source media: pick files, runtime URL registry, re-link
import { store, uid } from './store.js';
import * as projectStore from './projectStore.js';
import * as db from './db.js';

// runtime registry: sourceId -> { file, url, handle }
const media = new Map();

export function urlFor(sourceId) { return media.get(sourceId)?.url || null; }
export function fileFor(sourceId) { return media.get(sourceId)?.file || null; }
export function isLinked(sourceId) { return media.has(sourceId); }

async function probeDuration(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve(v.duration || 0);
    v.onerror = () => resolve(0);
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
  const url = register(id, file, handle);
  const duration = await probeDuration(url);
  if (handle) db.saveHandle('media:' + id, handle).catch(() => {});

  store.update((p, ui) => {
    p.sources.push({
      id,
      fileName: file.name,
      relPath: 'media/' + file.name,
      size: file.size,
      lastModified: file.lastModified,
      duration,
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
