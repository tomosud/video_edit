// materialShelf.js - cutout material cards: select, double-click play, drag to output
import { store } from './store.js';
import { horizontalCardThumb, horizontalCropSignature, cloneCanvas } from './thumbnails.js';
import { escapeHtml, fmtDur } from './util.js';

let shelfEl, countEl;
let onPlay = () => {};
const thumbs = new Map();   // materialId -> HTMLCanvasElement
const thumbSig = new Map(); // materialId -> mid-frame signature the thumb was made for
const thumbBusy = new Map();// materialId -> bool (generation in flight)
const SHELF_MIN = 72;
const SHELF_MAX = 180;
const SHELF_STEP = 8;
let draggingMaterialId = null;
let draggingSection = null;

export function init(elements, { play } = {}) {
  shelfEl = elements.shelf;
  countEl = elements.count;
  if (play) onPlay = play;
  shelfEl.addEventListener('wheel', onShelfWheel, { passive: false });
  // Coalesced onto rAF: every updateLive during timeline drags would
  // otherwise rebuild all shelf cards per pointermove.
  store.subscribe(scheduleRender);
}

let renderRaf = 0;
function scheduleRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => { renderRaf = 0; render(); });
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
    shelfEl.innerHTML = '<div class="placeholder">Split cuts on the timeline</div>';
    return;
  }
  const sel = selMatId();
  const usedIds = new Set(store.get().outputs.map(o => o.materialId));
  const used = mats.filter(m => usedIds.has(m.id));
  const unused = mats.filter(m => !usedIds.has(m.id));
  shelfEl.innerHTML = '';
  appendSection('Used in edit', used, sel, 'used');
  appendSection('Unused', unused, sel, 'unused');
}

function appendSection(title, mats, sel, sectionKind) {
  const section = document.createElement('section');
  section.className = 'shelf-section';
  const head = document.createElement('div');
  head.className = 'shelf-section-head';
  head.innerHTML = `<span>${escapeHtml(title)}</span><span>${mats.length}</span>`;
  const grid = document.createElement('div');
  grid.className = 'shelf-grid';
  grid.dataset.section = sectionKind;
  grid.addEventListener('dragover', onGridDragOver);
  grid.addEventListener('dragleave', (e) => {
    if (!grid.contains(e.relatedTarget)) clearDropCues();
  });
  grid.addEventListener('drop', onGridDrop);
  if (!mats.length) {
    const empty = document.createElement('div');
    empty.className = 'shelf-empty';
    empty.textContent = 'No materials';
    grid.appendChild(empty);
  } else {
    for (const m of mats) {
      grid.appendChild(card(m, m.id === sel, sectionKind));
      ensureThumb(m);
    }
  }
  section.append(head, grid);
  shelfEl.appendChild(section);
}

function midSig(src, m) {
  return [
    Math.round((m.in + m.out) / 2 * (src.fps || 30)),
    horizontalCropSignature(m.horizontalCrop || {}),
  ].join(':');
}
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
    const canvas = await horizontalCardThumb(src, (m.in + m.out) / 2, m.horizontalCrop || {});
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

function card(m, selected, sectionKind) {
  const src = store.getSource(m.sourceId);
  const name = displayName(m, src);
  const el = document.createElement('div');
  el.className = 'card' + (selected ? ' selected' : '');
  el.draggable = true;
  el.dataset.id = m.id;
  el.dataset.section = sectionKind;
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
    if (e.target.closest('.meta')) return;
    onPlay(m.in, m.out, 'stock');
  };
  meta.onclick = (e) => {
    e.stopPropagation();
  };
  meta.ondblclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    beginTitleEdit(meta.querySelector('.material-title'), m.id);
  };
  el.addEventListener('dragstart', (e) => {
    if (e.target.closest('input, textarea, [contenteditable="true"]')) {
      e.preventDefault();
      return;
    }
    draggingMaterialId = m.id;
    draggingSection = sectionKind;
    e.dataTransfer.setData('application/x-material', m.id);
    e.dataTransfer.effectAllowed = 'copyMove';
    el.classList.add('dragging');
  });
  el.addEventListener('dragover', onCardDragOver);
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) clearDropCues(el);
  });
  el.addEventListener('drop', onCardDrop);
  el.addEventListener('dragend', () => {
    draggingMaterialId = null;
    draggingSection = null;
    clearDropCues();
    el.classList.remove('dragging');
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
  const src = store.getSource(m.sourceId);
  const cardEl = node.closest('.card');
  const original = (m.title || '').trim();
  const input = document.createElement('input');
  input.className = 'material-title-input';
  input.type = 'text';
  input.value = original;
  input.placeholder = src?.fileName || 'Label';
  input.spellcheck = false;
  if (cardEl) cardEl.draggable = false;
  node.replaceChildren(input);
  input.focus();
  input.select();
  let cancelled = false;

  const finish = (commit) => {
    const value = input.value || '';
    input.onblur = null;
    input.onkeydown = null;
    if (cardEl) cardEl.draggable = true;
    if (!commit || cancelled) { render(); return; }
    setMaterialTitle(id, value);
  };

  for (const eventName of ['pointerdown', 'click', 'dblclick']) {
    input.addEventListener(eventName, (e) => e.stopPropagation());
  }
  input.onblur = () => finish(true);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      cancelled = true;
      input.value = original;
      finish(false);
    }
  };
}

function setMaterialTitle(id, value) {
  const current = store.getMaterial(id);
  const trimmed = value.trim();
  if (!current || ((current.title || '') === trimmed) || (!current.title && !trimmed)) return;
  store.update((p) => {
    const target = p.materials.find(x => x.id === id);
    if (!target) return;
    if (trimmed) target.title = trimmed;
    else delete target.title;
  });
}

function onCardDragOver(e) {
  if (!canShelfReorder(e.currentTarget)) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  setDropCue(e.currentTarget, e);
}

function onCardDrop(e) {
  if (!canShelfReorder(e.currentTarget)) return;
  e.preventDefault();
  e.stopPropagation();
  const targetId = e.currentTarget.dataset.id;
  const position = e.currentTarget.dataset.dropPosition || 'before';
  clearDropCues();
  moveMaterialInSection(draggingMaterialId, draggingSection, targetId, position);
}

function onGridDragOver(e) {
  const grid = e.currentTarget;
  if (!draggingMaterialId || grid.dataset.section !== draggingSection) return;
  if (e.target.closest('.card')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropCues();
  grid.classList.add('drop-end');
}

function onGridDrop(e) {
  const grid = e.currentTarget;
  if (!draggingMaterialId || grid.dataset.section !== draggingSection) return;
  if (e.target.closest('.card')) return;
  e.preventDefault();
  clearDropCues();
  moveMaterialInSection(draggingMaterialId, draggingSection, null, 'after');
}

function canShelfReorder(target) {
  return !!(
    draggingMaterialId &&
    target?.dataset?.id &&
    target.dataset.id !== draggingMaterialId &&
    target.dataset.section === draggingSection
  );
}

function setDropCue(target, e) {
  const rect = target.getBoundingClientRect();
  const after = e.clientX > rect.left + rect.width / 2;
  clearDropCues(target);
  target.dataset.dropPosition = after ? 'after' : 'before';
  target.classList.toggle('drop-before', !after);
  target.classList.toggle('drop-after', after);
}

function clearDropCues(keep = null) {
  shelfEl?.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
    if (el === keep) return;
    el.classList.remove('drop-before', 'drop-after');
    delete el.dataset.dropPosition;
  });
  shelfEl?.querySelectorAll('.shelf-grid.drop-end').forEach((el) => el.classList.remove('drop-end'));
}

function moveMaterialInSection(sourceId, sectionKind, targetId, position) {
  const project = store.get();
  const usedIds = new Set(project.outputs.map(o => o.materialId));
  const belongs = (m) => sectionKind === 'used' ? usedIds.has(m.id) : !usedIds.has(m.id);
  const sectionIds = project.materials.filter(belongs).map(m => m.id);
  if (!sectionIds.includes(sourceId)) return;
  if (targetId && !sectionIds.includes(targetId)) return;

  const reordered = sectionIds.filter(id => id !== sourceId);
  const targetIndex = targetId ? reordered.indexOf(targetId) : reordered.length - 1;
  const insertAt = targetId
    ? Math.max(0, Math.min(reordered.length, targetIndex + (position === 'after' ? 1 : 0)))
    : reordered.length;
  reordered.splice(insertAt, 0, sourceId);
  if (reordered.join('\n') === sectionIds.join('\n')) return;

  store.update((p, ui) => {
    const currentUsedIds = new Set(p.outputs.map(o => o.materialId));
    const currentBelongs = (m) => sectionKind === 'used' ? currentUsedIds.has(m.id) : !currentUsedIds.has(m.id);
    const byId = new Map(p.materials.map(m => [m.id, m]));
    let cursor = 0;
    p.materials = p.materials.map((m) => currentBelongs(m) ? byId.get(reordered[cursor++]) : m);
    ui.selection = { kind: 'material', id: sourceId };
  });
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

