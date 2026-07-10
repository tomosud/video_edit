// outputSequence.js - output clips (editing area): timed layout, captions, drop/reorder
import { store, uid } from './store.js?v=20260707-horizontal-crop';
import { cardThumb, cloneCanvas } from './thumbnails.js?v=20260707-horizontal-crop';
import { fmtDur } from './util.js?v=20260707-horizontal-crop';
import { MIN_CAPTION_MS, captionDensity, defaultCaption, densityClass, normalizeCaption } from './captions.js?v=20260710-captions';

let listEl, totalEl, zoomEl, captionEditorEl;
let onPlay = () => {};
const thumbs = new Map();   // outputId -> HTMLCanvasElement
const thumbSig = new Map(); // outputId -> mid-frame signature
const thumbBusy = new Map();// outputId -> bool
const MIN_CLIP_WIDTH = 74;
let pxPerSec = 72;
let focusCaptionId = null;
let restoringEditorFocus = false;

export function init(elements, { play } = {}) {
  listEl = elements.list;
  totalEl = elements.total;
  zoomEl = elements.zoom;
  captionEditorEl = elements.captionEditor;
  if (play) onPlay = play;
  if (zoomEl) {
    pxPerSec = Number(zoomEl.value) || pxPerSec;
    zoomEl.addEventListener('input', () => {
      pxPerSec = Number(zoomEl.value) || pxPerSec;
      render();
    });
  }

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
  const layout = sequenceLayout();
  const outs = layout.items.map(it => it.output);
  totalEl.textContent = 'Total ' + fmtDur(layout.totalMs / 1000);

  if (!outs.length) {
    listEl.innerHTML = '<div class="placeholder">Drag materials here to build the edit</div>';
    if (captionEditorEl) captionEditorEl.innerHTML = '<div class="placeholder">Drop clips, then add captions here</div>';
    return;
  }
  const sel = store.ui.selection;
  const selectedId = sel.kind === 'output' ? sel.id : null;
  listEl.innerHTML = '';
  const timeline = document.createElement('div');
  timeline.className = 'edit-timeline';
  timeline.style.width = Math.max(listEl.clientWidth - 24, layout.totalWidth) + 'px';

  const cutTrack = document.createElement('div');
  cutTrack.className = 'edit-cut-track';
  const captionTrack = document.createElement('div');
  captionTrack.className = 'edit-caption-track';
  timeline.appendChild(cutTrack);
  timeline.appendChild(captionTrack);
  listEl.appendChild(timeline);

  for (const item of layout.items) {
    cutTrack.appendChild(card(item, selectedId === item.output.id));
    const bar = captionBar(item, layout, selectedId === item.output.id);
    if (bar) captionTrack.appendChild(bar);
    ensureThumb(item.output);
  }

  renderCaptionEditor(layout);
  if (focusCaptionId) {
    const id = focusCaptionId;
    focusCaptionId = null;
    requestAnimationFrame(() => captionEditorEl?.querySelector(`textarea[data-id="${id}"]`)?.focus());
  }
}

function midSig(src, m) { return Math.round((m.in + m.out) / 2 * (src.fps || 30)); }
function displayName(m, src) { return (m?.title || '').trim() || src?.fileName || 'Untitled material'; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
function infoTitle(m, src) {
  if (!m) return 'Missing material';
  return [
    displayName(m, src),
    'Duration: ' + fmtDur(Math.max(0, m.out - m.in)),
    'Source: ' + (src?.fileName || '?'),
  ].join('\n');
}

function sequenceLayout(project = store.get()) {
  const items = [];
  let startMs = 0;
  let totalWidth = 0;
  for (const output of project.outputs) {
    const material = project.materials.find(m => m.id === output.materialId);
    if (!material) continue;
    const source = project.sources.find(s => s.id === material.sourceId);
    const durationMs = Math.max(MIN_CAPTION_MS, Math.round(Math.max(0, material.out - material.in) * 1000));
    const endMs = startMs + durationMs;
    const width = Math.max(MIN_CLIP_WIDTH, durationMs / 1000 * pxPerSec);
    const x = totalWidth;
    items.push({ output, material, source, startMs, endMs, durationMs, x, width });
    startMs = endMs;
    totalWidth += width;
  }
  return { items, totalMs: startMs, totalWidth };
}

function captionFor(item) {
  return normalizeCaption(item.output.caption, item.startMs, item.endMs);
}

function ensureCaption(output, item) {
  if (output.caption) {
    output.caption = normalizeCaption(output.caption, item.startMs, item.endMs);
  } else {
    output.caption = defaultCaption(item.startMs, item.endMs);
  }
  return output.caption;
}

function timeToX(ms, layout) {
  if (!layout.items.length) return 0;
  const t = Math.max(0, Math.min(layout.totalMs, ms));
  for (const item of layout.items) {
    if (t <= item.endMs || item === layout.items[layout.items.length - 1]) {
      const local = Math.max(0, Math.min(1, (t - item.startMs) / item.durationMs));
      return item.x + local * item.width;
    }
  }
  return layout.totalWidth;
}

function xToTime(x, layout) {
  const px = Math.max(0, Math.min(layout.totalWidth, x));
  for (const item of layout.items) {
    if (px <= item.x + item.width || item === layout.items[layout.items.length - 1]) {
      const local = Math.max(0, Math.min(1, (px - item.x) / item.width));
      return Math.round(item.startMs + local * item.durationMs);
    }
  }
  return layout.totalMs;
}

// Keep the output thumbnail in sync with its material's current trim.
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
    // Only chase a newer position if this render succeeded. Otherwise an
    // unlinked or failed source could retry forever.
    if (ok) {
      const cm = store.getMaterial(o.materialId);
      if (cm && midSig(src, cm) !== thumbSig.get(o.id)) ensureThumb(o);
    }
  }
}

function card(item, selected) {
  const o = item.output;
  const m = item.material;
  const src = item.source;
  const el = document.createElement('div');
  el.className = 'card out-card' + (selected ? ' selected' : '');
  el.draggable = true;
  el.dataset.id = o.id;
  el.style.left = item.x + 'px';
  el.style.width = item.width + 'px';
  el.title = infoTitle(m, src);

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (thumbs.has(o.id)) thumb.appendChild(cloneCanvas(thumbs.get(o.id)));

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span class="dur">${fmtDur(item.durationMs / 1000)}</span><span class="src">${escapeHtml(displayName(m, src))}</span>`;

  el.appendChild(thumb);
  el.appendChild(meta);
  el.onclick = () => store.select('output', o.id);
  el.ondblclick = () => { if (m) onPlay(o.id); };
  wireDrag(el);
  return el;
}

function captionBar(item, layout, selected) {
  const caption = captionFor(item);
  if (!caption?.text) return null;
  const left = timeToX(caption.startMs, layout);
  const right = timeToX(caption.endMs, layout);
  const bar = document.createElement('div');
  bar.className = `caption-bar ${densityClass(caption)}${selected ? ' selected' : ''}`;
  bar.dataset.id = item.output.id;
  bar.style.left = left + 'px';
  bar.style.width = Math.max(8, right - left) + 'px';
  bar.title = `${captionDensity(caption).toFixed(1)} chars/sec`;
  bar.innerHTML =
    '<span class="caption-handle caption-handle-l" data-edge="start"></span>' +
    `<span class="caption-label">${escapeHtml(caption.text.replace(/\s+/g, ' ').trim())}</span>` +
    '<span class="caption-handle caption-handle-r" data-edge="end"></span>';
  bar.addEventListener('click', (e) => {
    e.stopPropagation();
    focusCaptionId = item.output.id;
    store.select('output', item.output.id);
  });
  wireCaptionResize(bar, item.output.id, layout);
  return bar;
}

function wireCaptionResize(bar, outputId, layout) {
  for (const handle of bar.querySelectorAll('.caption-handle')) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      store.beginAction();
      const edge = handle.dataset.edge;
      const rect = bar.parentElement.getBoundingClientRect();
      const move = (ev) => {
        const ms = xToTime(ev.clientX - rect.left, layout);
        store.updateLive((p) => resizeCaption(p, outputId, edge, ms));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
  }
}

function resizeCaption(project, outputId, edge, ms) {
  const layout = sequenceLayout(project);
  const idx = layout.items.findIndex(it => it.output.id === outputId);
  if (idx < 0) return;
  const item = layout.items[idx];
  const caption = ensureCaption(item.output, item);
  const next = layout.items[idx + 1]?.output.caption || null;
  const prev = layout.items[idx - 1]?.output.caption || null;
  const bounded = Math.max(0, Math.min(layout.totalMs, Math.round(ms)));

  if (edge === 'start') {
    caption.startMs = Math.min(caption.endMs - MIN_CAPTION_MS, bounded);
    if (prev && prev.endMs > caption.startMs) {
      prev.endMs = Math.max(prev.startMs + MIN_CAPTION_MS, caption.startMs);
      if (prev.endMs > caption.startMs) caption.startMs = prev.endMs;
    }
  } else {
    caption.endMs = Math.max(caption.startMs + MIN_CAPTION_MS, bounded);
    if (next && next.startMs < caption.endMs) {
      next.startMs = Math.min(next.endMs - MIN_CAPTION_MS, caption.endMs);
      if (next.startMs < caption.endMs) caption.endMs = next.startMs;
    }
  }
}

function captionAnchors(project) {
  const anchors = new Map();
  for (const item of sequenceLayout(project).items) {
    const caption = normalizeCaption(item.output.caption, item.startMs, item.endMs);
    if (!caption) continue;
    anchors.set(item.output.id, {
      startOffset: caption.startMs - item.startMs,
      endOffset: caption.endMs - item.startMs,
    });
  }
  return anchors;
}

function restoreCaptionAnchors(project, anchors) {
  const layout = sequenceLayout(project);
  for (const item of layout.items) {
    const anchor = anchors.get(item.output.id);
    if (!anchor || !item.output.caption) continue;
    item.output.caption.startMs = Math.max(0, Math.round(item.startMs + anchor.startOffset));
    item.output.caption.endMs = Math.max(item.output.caption.startMs + MIN_CAPTION_MS, Math.round(item.startMs + anchor.endOffset));
    item.output.caption.endMs = Math.min(layout.totalMs, item.output.caption.endMs);
    if (item.output.caption.endMs - item.output.caption.startMs < MIN_CAPTION_MS) {
      item.output.caption.startMs = Math.max(0, item.output.caption.endMs - MIN_CAPTION_MS);
    }
  }
}

function renderCaptionEditor(layout) {
  if (!captionEditorEl) return;
  const active = document.activeElement;
  const activeId = active?.tagName === 'TEXTAREA' && active.closest('.caption-editor') ? active.dataset.id : null;
  if (activeId && !focusCaptionId) {
    updateCaptionEditorSelection();
    return;
  }
  const activeStart = activeId ? active.selectionStart : null;
  const activeEnd = activeId ? active.selectionEnd : null;
  captionEditorEl.innerHTML = '';
  const selectedId = store.ui.selection.kind === 'output' ? store.ui.selection.id : null;
  for (let i = 0; i < layout.items.length; i++) {
    const item = layout.items[i];
    const caption = captionFor(item);
    const row = document.createElement('div');
    row.className = 'caption-row' + (selectedId === item.output.id ? ' selected' : '');
    row.dataset.id = item.output.id;
    const density = caption ? captionDensity(caption) : 0;
    row.innerHTML =
      `<div class="caption-row-meta"><span>${i + 1}</span><span>${fmtDur(item.durationMs / 1000)}</span><span class="density ${caption ? densityClass(caption) : 'ok'}">${density.toFixed(1)}/s</span></div>` +
      `<textarea data-id="${item.output.id}" rows="2" placeholder="Caption for this cut">${escapeHtml(caption?.text || '')}</textarea>`;
    const textarea = row.querySelector('textarea');
    textarea.addEventListener('focus', () => {
      if (restoringEditorFocus) return;
      row.classList.add('selected');
      store.beginAction();
      store.select('output', item.output.id);
    });
    textarea.addEventListener('input', () => {
      store.updateLive((p) => {
        const layoutNow = sequenceLayout(p);
        const cur = layoutNow.items.find(it => it.output.id === item.output.id);
        if (!cur) return;
        const cap = ensureCaption(cur.output, cur);
        cap.text = textarea.value;
      });
    });
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        textarea.blur();
      }
    });
    row.addEventListener('click', (e) => {
      if (e.target === textarea) return;
      textarea.focus();
      store.select('output', item.output.id);
    });
    captionEditorEl.appendChild(row);
  }
  if (activeId) {
    requestAnimationFrame(() => {
      const node = captionEditorEl.querySelector(`textarea[data-id="${activeId}"]`);
      if (!node) return;
      restoringEditorFocus = true;
      node.focus();
      try { node.setSelectionRange(activeStart, activeEnd); } catch { /* ignore */ }
      restoringEditorFocus = false;
    });
  }
}

function updateCaptionEditorSelection() {
  if (!captionEditorEl) return;
  const selectedId = store.ui.selection.kind === 'output' ? store.ui.selection.id : null;
  for (const row of captionEditorEl.querySelectorAll('.caption-row')) {
    row.classList.toggle('selected', row.dataset.id === selectedId);
  }
}

// Delete just this output instance. The underlying cutout material is kept
// because it may still be used by other outputs or re-dropped later.
export function deleteOutput(id) {
  store.update((p, ui) => {
    p.outputs = p.outputs.filter(o => o.id !== id);
    if (ui.selection.kind === 'output' && ui.selection.id === id) ui.selection = { kind: null, id: null };
  });
  thumbs.delete(id);
  thumbSig.delete(id);
  thumbBusy.delete(id);
}

export function sequenceStartForOutput(id) {
  const item = sequenceLayout().items.find(it => it.output.id === id);
  return item ? item.startMs / 1000 : 0;
}

export function sequenceItems() {
  return sequenceLayout().items;
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
  el.addEventListener('dragend', () => {
    dragId = null;
    el.classList.remove('dragging');
    listEl.classList.remove('drop-active');
  });
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
    const id = uid('out');
    store.update((p, ui) => {
      const anchors = captionAnchors(p);
      const out = { id, materialId: matId };
      const idx = dropIndex();
      p.outputs.splice(Math.max(0, Math.min(idx, p.outputs.length)), 0, out);
      restoreCaptionAnchors(p, anchors);
      ui.selection = { kind: 'output', id };
    });
  } else if (dragId) {
    store.update((p) => {
      const anchors = captionAnchors(p);
      const from = p.outputs.findIndex(o => o.id === dragId);
      let to = dropIndex();
      if (from < 0) return;
      const [moved] = p.outputs.splice(from, 1);
      if (from < to) to--;
      p.outputs.splice(to, 0, moved);
      restoreCaptionAnchors(p, anchors);
    });
  }
}
