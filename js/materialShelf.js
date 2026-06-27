// materialShelf.js — cutout material cards: select, dbl-click play, drag to output
import { store } from './store.js?v=20260627-nativepreview3';
import { cardThumb, cloneCanvas } from './thumbnails.js?v=20260627-nativepreview3';
import { fmtDur } from './util.js?v=20260627-nativepreview3';

let shelfEl, countEl;
let onPlay = () => {};
const thumbs = new Map();   // materialId -> HTMLCanvasElement
const thumbSig = new Map(); // materialId -> mid-frame signature the thumb was made for
const thumbBusy = new Map();// materialId -> bool (generation in flight)

export function init(elements, { play } = {}) {
  shelfEl = elements.shelf;
  countEl = elements.count;
  if (play) onPlay = play;
  store.subscribe(render);
}

function selMatId() {
  const s = store.ui.selection;
  if (s.kind === 'material') return s.id;
  if (s.kind === 'output') return store.getOutput(s.id)?.materialId;
  return null;
}

function render() {
  const mats = store.get().materials;
  countEl.textContent = String(mats.length);

  if (!mats.length) {
    shelfEl.innerHTML = '<div class="placeholder">タイムラインでクリップを作成</div>';
    return;
  }
  const sel = selMatId();
  shelfEl.innerHTML = '';
  for (const m of mats) {
    shelfEl.appendChild(card(m, m.id === sel));
    ensureThumb(m);
  }
}

function midSig(src, m) { return Math.round((m.in + m.out) / 2 * (src.fps || 30)); }

// (re)generate a card thumbnail whenever the clip's midpoint frame changes,
// so trimming either edge updates the card immediately. Latest target wins.
async function ensureThumb(m) {
  const src = store.getSource(m.sourceId);
  if (!src) return;
  const sig = midSig(src, m);
  if (thumbSig.get(m.id) === sig) return;       // already up to date
  if (thumbBusy.get(m.id)) return;              // a later render will catch the newest sig
  thumbBusy.set(m.id, true);
  let ok = false;
  try {
    const canvas = await cardThumb(src, (m.in + m.out) / 2);
    if (canvas) {
      ok = true;
      thumbs.set(m.id, canvas);
      thumbSig.set(m.id, sig);
      const slot = shelfEl.querySelector(`.card[data-id="${m.id}"] .thumb`);
      if (slot) slot.replaceChildren(cloneCanvas(canvas));
    }
  } catch { /* media not linked / decode failed */ }
  finally {
    thumbBusy.set(m.id, false);
    // only chase a newer position if this render succeeded — otherwise retrying
    // an unlinked/failed source would loop forever.
    if (ok) {
      const cur = store.getMaterial(m.id);
      if (cur && midSig(src, cur) !== thumbSig.get(m.id)) ensureThumb(cur);
    }
  }
}

function card(m, selected) {
  const src = store.getSource(m.sourceId);
  const el = document.createElement('div');
  el.className = 'card' + (selected ? ' selected' : '');
  el.draggable = true;
  el.dataset.id = m.id;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (thumbs.has(m.id)) thumb.appendChild(cloneCanvas(thumbs.get(m.id)));

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span class="dur">${fmtDur(m.out - m.in)}</span><span class="src">${src ? src.fileName : '?'}</span>`;
  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '🗑'; del.title = '削除';
  del.onclick = (e) => { e.stopPropagation(); deleteMaterial(m.id); };
  meta.appendChild(del);

  el.appendChild(thumb); el.appendChild(meta);
  el.onclick = () => store.select('material', m.id);
  el.ondblclick = () => onPlay(m.in, m.out);
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-material', m.id);
    e.dataTransfer.effectAllowed = 'copy';
  });
  return el;
}

// Delete a material AND every output that depends on it (deleting the cutout
// source clip necessarily removes its instances in the sequence).
export function deleteMaterial(id) {
  store.update((p, ui) => {
    p.materials = p.materials.filter(m => m.id !== id);
    p.outputs = p.outputs.filter(o => o.materialId !== id); // drop dependent outputs
    if ((ui.selection.kind === 'material' && ui.selection.id === id))
      ui.selection = { kind: null, id: null };
  });
  thumbs.delete(id);
  thumbSig.delete(id);
  thumbBusy.delete(id);
}
