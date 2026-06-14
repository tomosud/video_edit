// clipList.js — output clip cards: add, select, delete, drag-reorder
import { store, uid } from './store.js';
import { singleThumb } from './thumbnails.js';
import { fmtDur } from './util.js';

let listEl, totalEl;
const thumbCache = new Map(); // clipId -> dataURL

export function init(listElement, totalElement) {
  listEl = listElement;
  totalEl = totalElement;
  store.subscribe(render);
}

// Add a clip from the current trim draft of the active source
export function addClipFromTrim(trim) {
  const src = store.activeSource();
  if (!src) return;
  const id = uid('clip');
  store.update((p, ui) => {
    p.clips.push({
      id,
      sourceId: src.id,
      in: trim.in,
      out: trim.out,
      crop: { ...(ui.crop || { panX: 0.5, panY: 0.5, zoom: 1 }) },
      texts: [],
    });
    ui.selectedClipId = id;
  });
  makeThumb(id);
}

async function makeThumb(clipId) {
  const clip = store.getClip(clipId);
  if (!clip) return;
  const src = store.getSource(clip.sourceId);
  if (!src) return;
  try {
    const url = await singleThumb(src, (clip.in + clip.out) / 2);
    if (url) { thumbCache.set(clipId, url); render(); }
  } catch { /* ignore */ }
}

function render() {
  const p = store.get();
  if (!listEl) return;

  if (!p.clips.length) {
    listEl.innerHTML = '<div class="clip-empty">IN/OUT を決めて「クリップ追加」</div>';
    totalEl.textContent = '合計 0:00';
    return;
  }

  listEl.innerHTML = '';
  let total = 0;
  for (const clip of p.clips) {
    total += Math.max(0, clip.out - clip.in);
    listEl.appendChild(card(clip));
    if (!thumbCache.has(clip.id)) makeThumb(clip.id);
  }
  totalEl.textContent = '合計 ' + fmtDur(total);
}

function card(clip) {
  const src = store.getSource(clip.sourceId);
  const el = document.createElement('div');
  el.className = 'clip-card' + (store.ui.selectedClipId === clip.id ? ' selected' : '');
  el.draggable = true;
  el.dataset.id = clip.id;

  const img = document.createElement('img');
  img.className = 'clip-thumb';
  if (thumbCache.has(clip.id)) img.src = thumbCache.get(clip.id);

  const meta = document.createElement('div');
  meta.className = 'clip-meta';
  meta.innerHTML =
    `<span class="dur">${fmtDur(clip.out - clip.in)}</span>` +
    `<span class="src">${src ? src.fileName : '?'}</span>`;

  const del = document.createElement('button');
  del.className = 'clip-del';
  del.textContent = '🗑';
  del.title = '削除';
  del.onclick = (e) => { e.stopPropagation(); removeClip(clip.id); };
  meta.appendChild(del);

  el.appendChild(img);
  el.appendChild(meta);

  el.onclick = () => store.setUI({ selectedClipId: clip.id });
  wireDrag(el);
  return el;
}

function removeClip(id) {
  store.update((p, ui) => {
    p.clips = p.clips.filter(c => c.id !== id);
    if (ui.selectedClipId === id) ui.selectedClipId = null;
  });
  thumbCache.delete(id);
}

// ---- drag reorder ----
let dragId = null;
function wireDrag(el) {
  el.addEventListener('dragstart', () => { dragId = el.dataset.id; el.classList.add('dragging'); });
  el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragId || dragId === el.dataset.id) return;
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragId || dragId === el.dataset.id) return;
    reorder(dragId, el.dataset.id);
  });
}

function reorder(fromId, toId) {
  store.update((p) => {
    const clips = p.clips;
    const fromIdx = clips.findIndex(c => c.id === fromId);
    const toIdx = clips.findIndex(c => c.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = clips.splice(fromIdx, 1);
    clips.splice(toIdx, 0, moved);
  });
}
