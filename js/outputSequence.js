// outputSequence.js — output clips (editing place): drop, reorder, select, play
import { store, uid } from './store.js';
import { cardThumb, cloneCanvas } from './thumbnails.js';
import { fmtDur } from './util.js';

let listEl, totalEl;
let onPlay = () => {};
const thumbs = new Map();   // outputId -> HTMLCanvasElement
const thumbSig = new Map(); // outputId -> mid-frame signature
const thumbBusy = new Map();// outputId -> bool

export function init(elements, { play } = {}) {
  listEl = elements.list;
  totalEl = elements.total;
  if (play) onPlay = play;

  listEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('application/x-material') || dragId) {
      e.preventDefault();
      listEl.classList.add('drop-active');
    }
  });
  listEl.addEventListener('dragleave', (e) => {
    if (e.target === listEl) listEl.classList.remove('drop-active');
  });
  listEl.addEventListener('drop', onDrop);

  store.subscribe(render);
}

function render() {
  const outs = store.get().outputs;
  let total = 0;
  for (const o of outs) { const m = store.getMaterial(o.materialId); if (m) total += Math.max(0, m.out - m.in); }
  totalEl.textContent = '合計 ' + fmtDur(total);

  if (!outs.length) {
    listEl.innerHTML = '<div class="placeholder">素材をドロップして並べる</div>';
    return;
  }
  const sel = store.ui.selection;
  listEl.innerHTML = '';
  for (const o of outs) {
    listEl.appendChild(card(o, sel.kind === 'output' && sel.id === o.id));
    ensureThumb(o);
  }
}

function midSig(src, m) { return Math.round((m.in + m.out) / 2 * (src.fps || 30)); }

// keep the output thumbnail in sync with its material's current trim.
async function ensureThumb(o) {
  const m = store.getMaterial(o.materialId);
  const src = m && store.getSource(m.sourceId);
  if (!src) return;
  const sig = midSig(src, m);
  if (thumbSig.get(o.id) === sig) return;
  if (thumbBusy.get(o.id)) return;
  thumbBusy.set(o.id, true);
  let ok = false;
  try {
    const canvas = await cardThumb(src, (m.in + m.out) / 2);
    if (canvas) {
      ok = true;
      thumbs.set(o.id, canvas);
      thumbSig.set(o.id, sig);
      const slot = listEl.querySelector(`.card[data-id="${o.id}"] .thumb`);
      if (slot) slot.replaceChildren(cloneCanvas(canvas));
    }
  } catch { /* media not linked / decode failed */ }
  finally {
    thumbBusy.set(o.id, false);
    // only chase a newer position if this render succeeded — otherwise retrying
    // an unlinked/failed source would loop forever.
    if (ok) {
      const cm = store.getMaterial(o.materialId);
      if (cm && midSig(src, cm) !== thumbSig.get(o.id)) ensureThumb(o);
    }
  }
}

function card(o, selected) {
  const m = store.getMaterial(o.materialId);
  const src = m && store.getSource(m.sourceId);
  const el = document.createElement('div');
  el.className = 'card' + (selected ? ' selected' : '');
  el.draggable = true;
  el.dataset.id = o.id;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (thumbs.has(o.id)) thumb.appendChild(cloneCanvas(thumbs.get(o.id)));

  const meta = document.createElement('div');
  meta.className = 'meta';
  const dur = m ? (m.out - m.in) : 0;
  meta.innerHTML = `<span class="dur">${fmtDur(dur)}</span><span class="src">${src ? src.fileName : '?'}</span>`;
  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '🗑'; del.title = '削除';
  del.onclick = (e) => { e.stopPropagation(); deleteOutput(o.id); };
  meta.appendChild(del);

  el.appendChild(thumb); el.appendChild(meta);
  el.onclick = () => store.select('output', o.id);
  el.ondblclick = () => { if (m) onPlay(m.in, m.out); };
  wireDrag(el);
  return el;
}

// Delete just this output instance. The underlying cutout material is kept
// (it may still be used by other outputs or re-dropped later).
export function deleteOutput(id) {
  store.update((p, ui) => {
    p.outputs = p.outputs.filter(o => o.id !== id);
    if (ui.selection.kind === 'output' && ui.selection.id === id) ui.selection = { kind: null, id: null };
  });
  thumbs.delete(id);
  thumbSig.delete(id);
  thumbBusy.delete(id);
}

// ---- drop from shelf + reorder ----
let dragId = null;
function wireDrag(el) {
  el.addEventListener('dragstart', (e) => {
    dragId = el.dataset.id;
    e.dataTransfer.setData('application/x-output', el.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); listEl.classList.remove('drop-active'); });
}

function onDrop(e) {
  e.preventDefault();
  listEl.classList.remove('drop-active');
  const matId = e.dataTransfer.getData('application/x-material');
  const targetCard = e.target.closest('.card');
  const targetId = targetCard?.dataset.id;
  const dropIndex = () => {
    if (!targetId || !targetCard) return store.get().outputs.length;
    const idx = store.get().outputs.findIndex(o => o.id === targetId);
    if (idx < 0) return store.get().outputs.length;
    const rect = targetCard.getBoundingClientRect();
    return e.clientX > rect.left + rect.width / 2 ? idx + 1 : idx;
  };

  if (matId) {
    // create new output from material, inserted at drop position
    const id = uid('out');
    store.update((p, ui) => {
      const out = { id, materialId: matId, texts: [] };
      const idx = dropIndex();
      p.outputs.splice(Math.max(0, Math.min(idx, p.outputs.length)), 0, out);
      ui.selection = { kind: 'output', id };
    });
  } else if (dragId) {
    store.update((p) => {
      const from = p.outputs.findIndex(o => o.id === dragId);
      let to = dropIndex();
      if (from < 0) return;
      const [moved] = p.outputs.splice(from, 1);
      if (from < to) to--;
      p.outputs.splice(to, 0, moved);
    });
  }
}
