// materialShelf.js — cutout material cards: select, dbl-click play, drag to output
import { store } from './store.js';
import { cardThumb } from './thumbnails.js';
import { fmtDur } from './util.js';

let shelfEl, countEl;
let onPlay = () => {};
const thumbs = new Map(); // materialId -> objectURL

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
    if (!thumbs.has(m.id)) makeThumb(m);
  }
}

async function makeThumb(m) {
  const src = store.getSource(m.sourceId);
  if (!src) return;
  try {
    const url = await cardThumb(src, (m.in + m.out) / 2);
    if (url) { thumbs.set(m.id, url); render(); }
  } catch { /* ignore */ }
}

function card(m, selected) {
  const src = store.getSource(m.sourceId);
  const el = document.createElement('div');
  el.className = 'card' + (selected ? ' selected' : '');
  el.draggable = true;
  el.dataset.id = m.id;

  const img = document.createElement('img');
  img.className = 'thumb';
  if (thumbs.has(m.id)) img.src = thumbs.get(m.id);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span class="dur">${fmtDur(m.out - m.in)}</span><span class="src">${src ? src.fileName : '?'}</span>`;
  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '🗑'; del.title = '削除';
  del.onclick = (e) => { e.stopPropagation(); removeMaterial(m.id); };
  meta.appendChild(del);

  el.appendChild(img); el.appendChild(meta);
  el.onclick = () => store.select('material', m.id);
  el.ondblclick = () => onPlay(m.in, m.out);
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-material', m.id);
    e.dataTransfer.effectAllowed = 'copy';
  });
  return el;
}

function removeMaterial(id) {
  store.update((p, ui) => {
    p.materials = p.materials.filter(m => m.id !== id);
    p.outputs = p.outputs.filter(o => o.materialId !== id); // drop dependent outputs
    if ((ui.selection.kind === 'material' && ui.selection.id === id))
      ui.selection = { kind: null, id: null };
  });
  thumbs.delete(id);
}
