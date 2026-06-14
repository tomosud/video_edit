// outputSequence.js — output clips (editing place): drop, reorder, select, play
import { store, uid } from './store.js';
import { cardThumb } from './thumbnails.js';
import { fmtDur } from './util.js';

let listEl, totalEl;
let onPlay = () => {};
const thumbs = new Map(); // outputId -> objectURL

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
    if (!thumbs.has(o.id)) makeThumb(o);
  }
}

async function makeThumb(o) {
  const m = store.getMaterial(o.materialId);
  const src = m && store.getSource(m.sourceId);
  if (!src) return;
  try {
    const url = await cardThumb(src, (m.in + m.out) / 2);
    if (url) { thumbs.set(o.id, url); render(); }
  } catch { /* ignore */ }
}

function card(o, selected) {
  const m = store.getMaterial(o.materialId);
  const src = m && store.getSource(m.sourceId);
  const el = document.createElement('div');
  el.className = 'card' + (selected ? ' selected' : '');
  el.draggable = true;
  el.dataset.id = o.id;

  const img = document.createElement('img');
  img.className = 'thumb';
  if (thumbs.has(o.id)) img.src = thumbs.get(o.id);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const dur = m ? (m.out - m.in) : 0;
  meta.innerHTML = `<span class="dur">${fmtDur(dur)}</span><span class="src">${src ? src.fileName : '?'}</span>`;
  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '🗑'; del.title = '削除';
  del.onclick = (e) => { e.stopPropagation(); removeOutput(o.id); };
  meta.appendChild(del);

  el.appendChild(img); el.appendChild(meta);
  el.onclick = () => store.select('output', o.id);
  el.ondblclick = () => { if (m) onPlay(m.in, m.out); };
  wireDrag(el);
  return el;
}

function removeOutput(id) {
  store.update((p, ui) => {
    p.outputs = p.outputs.filter(o => o.id !== id);
    if (ui.selection.kind === 'output' && ui.selection.id === id) ui.selection = { kind: null, id: null };
  });
  thumbs.delete(id);
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

  if (matId) {
    // create new output from material, inserted at drop position
    const id = uid('out');
    store.update((p, ui) => {
      const out = { id, materialId: matId, crop: { ...(ui.crop || { panX: .5, panY: .5, zoom: 1 }) }, texts: [] };
      const idx = targetId ? p.outputs.findIndex(o => o.id === targetId) : p.outputs.length;
      p.outputs.splice(idx < 0 ? p.outputs.length : idx, 0, out);
      ui.selection = { kind: 'output', id };
    });
  } else if (dragId && targetId && dragId !== targetId) {
    store.update((p) => {
      const from = p.outputs.findIndex(o => o.id === dragId);
      const to = p.outputs.findIndex(o => o.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = p.outputs.splice(from, 1);
      p.outputs.splice(to, 0, moved);
    });
  }
}
