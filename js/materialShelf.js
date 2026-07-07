// materialShelf.js - cutout material cards: select, double-click play, drag to output
import { store } from './store.js?v=20260707-horizontal-crop';
import { cardThumb, cloneCanvas } from './thumbnails.js?v=20260707-horizontal-crop';
import { fmtDur } from './util.js?v=20260707-horizontal-crop';

let shelfEl, countEl;
let onPlay = () => {};
const thumbs = new Map();   // materialId -> HTMLCanvasElement
const thumbSig = new Map(); // materialId -> mid-frame signature the thumb was made for
const thumbBusy = new Map();// materialId -> bool (generation in flight)
const SHELF_MIN = 72;
const SHELF_MAX = 180;
const SHELF_STEP = 8;

export function init(elements, { play } = {}) {
  shelfEl = elements.shelf;
  countEl = elements.count;
  if (play) onPlay = play;
  shelfEl.addEventListener('wheel', onShelfWheel, { passive: false });
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
    shelfEl.innerHTML = '<div class="placeholder">Create materials on the timeline</div>';
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
function displayName(m, src) { return (m.title || '').trim() || src?.fileName || 'Untitled material'; }
function infoTitle(m, src) {
  return [
    displayName(m, src),
    'Duration: ' + fmtDur(Math.max(0, m.out - m.in)),
    'Source: ' + (src?.fileName || '?'),
  ].join('\n');
}

// Regenerate a card thumbnail whenever the clip midpoint frame changes.
async function ensureThumb(m) {
  const src = store.getSource(m.sourceId);
  if (!src) return;
  const sig = midSig(src, m);
  if (thumbSig.get(m.id) === sig) return;
  if (thumbBusy.get(m.id)) return;
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
    // Only chase a newer position if this render succeeded.
    if (ok) {
      const cur = store.getMaterial(m.id);
      if (cur && midSig(src, cur) !== thumbSig.get(m.id)) ensureThumb(cur);
    }
  }
}

function card(m, selected) {
  const src = store.getSource(m.sourceId);
  const name = displayName(m, src);
  const el = document.createElement('div');
  el.className = 'card' + (selected ? ' selected' : '');
  el.draggable = true;
  el.dataset.id = m.id;
  el.title = infoTitle(m, src);

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (thumbs.has(m.id)) thumb.appendChild(cloneCanvas(thumbs.get(m.id)));

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span class="dur">${fmtDur(m.out - m.in)}</span><span class="src material-title">${escapeHtml(name)}</span>`;

  el.appendChild(thumb);
  el.appendChild(meta);
  el.onclick = () => store.select('material', m.id);
  el.ondblclick = (e) => {
    if (e.target.closest('.material-title')) return;
    onPlay(m.in, m.out);
  };
  meta.querySelector('.material-title').ondblclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    beginTitleEdit(e.currentTarget, m.id);
  };
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-material', m.id);
    e.dataTransfer.effectAllowed = 'copy';
  });
  return el;
}

function onShelfWheel(e) {
  e.preventDefault();
  const current = Number.parseInt(getComputedStyle(shelfEl).getPropertyValue('--shelf-card-min'), 10) || 96;
  const next = Math.max(SHELF_MIN, Math.min(SHELF_MAX, current + (e.deltaY < 0 ? SHELF_STEP : -SHELF_STEP)));
  shelfEl.style.setProperty('--shelf-card-min', next + 'px');
}

function beginTitleEdit(node, id) {
  const m = store.getMaterial(id);
  if (!m) return;
  node.contentEditable = 'true';
  node.spellcheck = false;
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (commit) => {
    const value = node.textContent || '';
    node.contentEditable = 'false';
    node.onblur = null;
    node.onkeydown = null;
    if (!commit) { render(); return; }
    setMaterialTitle(id, value);
  };

  node.onblur = () => finish(true);
  node.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
}

function setMaterialTitle(id, value) {
  store.update((p) => {
    const target = p.materials.find(x => x.id === id);
    if (!target) return;
    const trimmed = value.trim();
    if (trimmed) target.title = trimmed;
    else delete target.title;
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Delete a material and every output that depends on it.
export function deleteMaterial(id) {
  store.update((p, ui) => {
    p.materials = p.materials.filter(m => m.id !== id);
    p.outputs = p.outputs.filter(o => o.materialId !== id);
    if (ui.selection.kind === 'material' && ui.selection.id === id) ui.selection = { kind: null, id: null };
    if (ui.editMaterialId === id) ui.editMaterialId = null;
    if (Array.isArray(ui.editMaterialIds)) ui.editMaterialIds = ui.editMaterialIds.filter(x => x !== id);
  });
  thumbs.delete(id);
  thumbSig.delete(id);
  thumbBusy.delete(id);
}
