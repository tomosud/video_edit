// outputSequenceTimeline.js - edit timeline with playhead, wheel zoom/pan, and anchored captions
import { store, uid } from './store.js?v=20260707-horizontal-crop';
import { cardThumb, cloneCanvas } from './thumbnails.js?v=20260707-horizontal-crop';
import { fmtDur } from './util.js?v=20260707-horizontal-crop';
import { MIN_CAPTION_MS, captionAbsolute, captionDensity, densityClass } from './captions.js?v=20260711-source-anchor';

const MIN_SPAN_SEC = 1;
const MIN_CLIP_PX = 28;

let listEl, totalEl, captionEditorEl, video;
let onPlay = () => {};
let onSeek = () => {};
let viewStart = 0;
let viewEnd = 12;
let playheadDrag = false;
let gesture = null;
let playRaf = 0;
let draggingOutputId = null;
let lastCaptionPress = null;
let editingCaptionId = null;

const thumbs = new Map();
const thumbSig = new Map();
const thumbBusy = new Map();

export function init(elements, hooks = {}) {
  listEl = elements.list;
  totalEl = elements.total;
  captionEditorEl = elements.captionEditor;
  video = elements.video || null;
  onPlay = hooks.play || onPlay;
  onSeek = hooks.seek || onSeek;

  listEl.addEventListener('wheel', onWheel, { passive: false });
  listEl.addEventListener('pointerdown', onTimelinePointerDown);
  listEl.addEventListener('dblclick', onTimelineDblClick);
  listEl.addEventListener('contextmenu', (e) => e.preventDefault());
  listEl.addEventListener('dragover', onDragOver);
  listEl.addEventListener('dragleave', (e) => {
    if (e.target === listEl) listEl.classList.remove('drop-active');
  });
  listEl.addEventListener('drop', onDrop);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', render);

  if (video) {
    video.addEventListener('timeupdate', positionPlayhead);
    video.addEventListener('seeked', positionPlayhead);
    video.addEventListener('play', startPlayheadLoop);
    video.addEventListener('pause', stopPlayheadLoop);
    video.addEventListener('ended', stopPlayheadLoop);
  }

  store.subscribe(render);
}

function render() {
  const layout = sequenceLayout();
  totalEl.textContent = 'Total ' + fmtDur(layout.totalMs / 1000);
  normalizeView(layout.totalMs / 1000);
  const active = document.activeElement;
  if ((active?.classList?.contains('caption-edit-textarea') && listEl.contains(active)) || editingCaptionId) return;

  if (!layout.items.length) {
    listEl.innerHTML = '<div class="placeholder">Drag materials here to build the edit</div>';
    if (captionEditorEl) captionEditorEl.innerHTML = '';
    return;
  }

  listEl.innerHTML = '';
  const timeline = document.createElement('div');
  timeline.className = 'edit-timeline';
  timeline.style.width = Math.max(1, listEl.clientWidth - 24) + 'px';

  const cutTrack = document.createElement('div');
  cutTrack.className = 'edit-cut-track';
  const captionTrack = document.createElement('div');
  captionTrack.className = 'edit-caption-track';
  const seekLane = document.createElement('div');
  seekLane.className = 'edit-seek-lane';
  const playhead = document.createElement('div');
  playhead.className = 'edit-playhead';
  playhead.innerHTML = '<span></span>';
  timeline.append(cutTrack, seekLane, captionTrack, playhead);
  listEl.appendChild(timeline);

  for (const item of layout.items) {
    if (item.endMs >= viewStartMs() && item.startMs <= viewEndMs()) {
      cutTrack.appendChild(card(item));
      ensureThumb(item.output);
    }
  }
  for (const item of layout.items) {
    for (const caption of captionsOf(item.output)) {
      const bar = captionBar(item, caption, layout);
      if (bar) captionTrack.appendChild(bar);
    }
  }

  if (captionEditorEl) captionEditorEl.innerHTML = '';
  positionPlayhead();
}

function sequenceLayout(project = store.get()) {
  const items = [];
  let startMs = 0;
  for (let index = 0; index < project.outputs.length; index++) {
    const output = project.outputs[index];
    const material = project.materials.find(m => m.id === output.materialId);
    if (!material) continue;
    const source = project.sources.find(s => s.id === material.sourceId);
    const durationMs = Math.max(MIN_CAPTION_MS, Math.round(Math.max(0, material.out - material.in) * 1000));
    const item = { output, material, source, index, startMs, endMs: startMs + durationMs, durationMs };
    clampCaptionAnchors(item);
    items.push(item);
    startMs += durationMs;
  }
  return { items, totalMs: startMs };
}

function captionsOf(output) {
  if (!Array.isArray(output.captions)) output.captions = [];
  return output.captions;
}

function clampCaptionAnchors(item) {
  for (const caption of captionsOf(item.output)) {
    const materialInMs = sourceMs(item.material.in);
    const materialOutMs = sourceMs(item.material.out);
    if (!Number.isFinite(+caption.sourceAnchorMs)) {
      const legacyOffset = Math.max(0, Math.min(item.durationMs, Math.round(+caption.anchorOffsetMs || 0)));
      caption.sourceAnchorMs = materialInMs + legacyOffset;
    }
    caption.sourceAnchorMs = Math.max(materialInMs, Math.min(materialOutMs, Math.round(+caption.sourceAnchorMs || materialInMs)));
    delete caption.anchorOffsetMs;
    caption.startOffsetMs = Math.min(-1, Math.round(+caption.startOffsetMs || -500));
    caption.endOffsetMs = Math.max(MIN_CAPTION_MS, Math.round(+caption.endOffsetMs || 1500));
    if (caption.endOffsetMs - caption.startOffsetMs < MIN_CAPTION_MS) caption.endOffsetMs = caption.startOffsetMs + MIN_CAPTION_MS;
    if (!caption.id) caption.id = uid('cap');
    if (caption.text == null) caption.text = '';
  }
}

function viewStartMs() { return Math.round(viewStart * 1000); }
function viewEndMs() { return Math.round(viewEnd * 1000); }
function spanSec() { return Math.max(0.001, viewEnd - viewStart); }
function innerW() { return listEl.querySelector('.edit-timeline')?.clientWidth || Math.max(1, listEl.clientWidth - 24); }
function timeToX(ms) { return ((ms / 1000 - viewStart) / spanSec()) * innerW(); }
function xToMs(clientX) {
  const timeline = listEl.querySelector('.edit-timeline') || listEl;
  const rect = timeline.getBoundingClientRect();
  return Math.round((viewStart + ((clientX - rect.left) / (rect.width || 1)) * spanSec()) * 1000);
}
function clampMs(ms, layout = sequenceLayout()) { return Math.max(0, Math.min(layout.totalMs, Math.round(ms))); }
function sourceMs(sec) { return Math.round(Math.max(0, +(sec || 0)) * 1000); }
function sourceAnchorFromSequenceMs(item, sequenceMs) {
  const localMs = Math.max(0, Math.min(item.durationMs, Math.round(sequenceMs - item.startMs)));
  return Math.max(sourceMs(item.material.in), Math.min(sourceMs(item.material.out), sourceMs(item.material.in) + localMs));
}

function normalizeView(totalSec) {
  const total = Math.max(0, totalSec || 0);
  if (!total) { viewStart = 0; viewEnd = 1; return; }
  if (viewEnd <= viewStart || viewStart < 0 || viewEnd > total + 0.001) {
    viewStart = 0;
    viewEnd = Math.min(total, Math.max(MIN_SPAN_SEC, Math.min(12, total)));
  }
  const span = Math.min(total, Math.max(MIN_SPAN_SEC, spanSec()));
  viewStart = Math.max(0, Math.min(viewStart, total - span));
  viewEnd = Math.min(total, viewStart + span);
}

function card(item) {
  const selectedCaption = store.ui.selectedCaptionId ? findCaption(store.get(), store.ui.selectedCaptionId) : null;
  const selected = !store.ui.selectedCaptionId && store.ui.selection.kind === 'output' && store.ui.selection.id === item.output.id;
  const captionRelated = selectedCaption?.output.id === item.output.id;
  const el = document.createElement('div');
  el.className = 'card out-card' + (selected ? ' selected cut-selected' : '') + (captionRelated ? ' caption-related' : '');
  el.draggable = true;
  el.dataset.id = item.output.id;
  el.style.left = timeToX(item.startMs) + 'px';
  el.style.width = Math.max(MIN_CLIP_PX, timeToX(item.endMs) - timeToX(item.startMs)) + 'px';
  el.title = displayName(item.material, item.source);

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (thumbs.has(item.output.id)) thumb.appendChild(cloneCanvas(thumbs.get(item.output.id)));
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span class="dur">${fmtDur(item.durationMs / 1000)}</span><span class="src">${escapeHtml(displayName(item.material, item.source))}</span>`;
  el.append(thumb, meta);
  el.onclick = () => selectOutput(item.output.id);
  el.ondblclick = () => onPlay(item.output.id);
  wireOutputDrag(el);
  return el;
}

function captionBar(item, caption, layout) {
  const abs = captionAbsolute(caption, item.startMs, item.material);
  if (!abs || abs.endMs < viewStartMs() || abs.startMs > viewEndMs()) return null;

  const selected = store.ui.selectedCaptionId === caption.id;
  const cutRelated = !store.ui.selectedCaptionId && store.ui.selection.kind === 'output' && store.ui.selection.id === item.output.id;
  const left = timeToX(abs.startMs);
  const right = timeToX(abs.endMs);
  const anchorX = timeToX(abs.anchorMs);
  const width = Math.max(10, right - left);
  const bar = document.createElement('div');
  bar.className = `caption-bar ${densityClass(abs)}${selected ? ' selected caption-selected' : ''}${cutRelated ? ' cut-related' : ''}`;
  bar.dataset.id = caption.id;
  bar.dataset.outputId = item.output.id;
  bar.style.left = left + 'px';
  bar.style.width = width + 'px';
  const label = (caption.text || '').trim() || '(caption)';
  const lines = Math.max(1, label.split(/\r?\n/).length);
  const barHeight = Math.min(88, Math.max(42, 28 + lines * 17));
  bar.style.height = barHeight + 'px';
  bar.title = `Cut ${item.index + 1} anchor ${fmtDur((caption.sourceAnchorMs || sourceMs(item.material.in)) / 1000)} / ${captionDensity(abs).toFixed(1)} chars/sec`;
  const anchorLocal = Math.max(0, Math.min(width, anchorX - left));
  bar.style.setProperty('--anchor-x', anchorLocal + 'px');
  bar.innerHTML =
    '<span class="caption-handle caption-handle-l" data-edge="start"></span>' +
    `<span class="caption-label">${escapeHtml(label)}</span>` +
    '<span class="caption-anchor-stem"></span><span class="caption-anchor-dot"></span>' +
    '<span class="caption-handle caption-handle-r" data-edge="end"></span>';
  wireCaptionPointer(bar, caption.id);
  return bar;
}

function onWheel(e) {
  const layout = sequenceLayout();
  if (!layout.totalMs) return;
  e.preventDefault();
  const total = layout.totalMs / 1000;
  const center = Math.max(0, Math.min(total, xToMs(e.clientX) / 1000));
  const oldSpan = spanSec();
  const factor = Math.exp(e.deltaY * 0.0015);
  const newSpan = Math.min(total, Math.max(MIN_SPAN_SEC, oldSpan * factor));
  let start = center - (center - viewStart) * (newSpan / oldSpan);
  let end = start + newSpan;
  if (start < 0) { start = 0; end = newSpan; }
  if (end > total) { end = total; start = end - newSpan; }
  viewStart = Math.max(0, start);
  viewEnd = Math.min(total, end);
  render();
}

function onTimelinePointerDown(e) {
  const layout = sequenceLayout();
  if (!layout.totalMs) return;
  if (e.button === 2) {
    e.preventDefault();
    listEl.classList.add('panning');
    gesture = { type: 'pan', startX: e.clientX, startViewStart: viewStart, startViewEnd: viewEnd };
    return;
  }
  if (e.button !== 0) return;
  const playhead = e.target.closest('.edit-playhead');
  const seekLane = e.target.closest('.edit-seek-lane');
  const captionTrack = e.target.closest('.edit-caption-track');
  if (captionTrack && !e.target.closest('.caption-bar')) return;
  if (playhead || seekLane) {
    e.preventDefault();
    playheadDrag = true;
    listEl.classList.add('seeking');
    seekFromClientX(e.clientX, true);
  }
}

function onTimelineDblClick(e) {
  const bar = e.target.closest('.caption-bar');
  if (bar) beginCaptionTextEdit(bar.dataset.id);
  else if (e.target.closest('.edit-caption-track')) createCaptionAt(e.clientX);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function createCaptionAt(clientX) {
  const layout = sequenceLayout();
  const anchorMs = clampMs(xToMs(clientX), layout);
  const item = itemAtMs(layout, anchorMs);
  if (!item) return;
  const halfMs = 650;
  const id = uid('cap');
  const caption = {
    id,
    text: '',
    sourceAnchorMs: sourceAnchorFromSequenceMs(item, anchorMs),
    startOffsetMs: -halfMs,
    endOffsetMs: halfMs,
  };
  store.update((p, ui) => {
    const out = p.outputs.find(o => o.id === item.output.id);
    if (!out) return;
    captionsOf(out).push(caption);
    ui.selectedCaptionId = id;
    ui.selection = { kind: null, id: null };
  });
  requestAnimationFrame(() => beginCaptionTextEdit(id));
}

function beginCaptionTextEdit(captionId) {
  if (store.ui.selectedCaptionId !== captionId || store.ui.selection.kind) {
    selectCaption(captionId);
    requestAnimationFrame(() => mountCaptionTextEdit(captionId));
    return;
  }
  mountCaptionTextEdit(captionId);
}

function mountCaptionTextEdit(captionId) {
  const found = findCaption(store.get(), captionId);
  if (!found) return;
  const bar = listEl.querySelector(`.caption-bar[data-id="${captionId}"]`);
  if (!bar) return;
  const existing = bar.querySelector('.caption-edit-textarea');
  if (existing) {
    existing.focus();
    existing.select();
    return;
  }
  editingCaptionId = captionId;
  const textarea = document.createElement('textarea');
  textarea.className = 'caption-edit-textarea';
  textarea.value = found.caption.text || '';
  textarea.rows = 2;
  textarea.addEventListener('pointerdown', (e) => e.stopPropagation());
  textarea.addEventListener('click', (e) => e.stopPropagation());
  textarea.addEventListener('dblclick', (e) => e.stopPropagation());
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') textarea.blur();
    if (e.key === 'Escape') {
      textarea.value = found.caption.text || '';
      textarea.blur();
    }
  });
  textarea.addEventListener('input', () => {
    store.updateLive((p, ui) => {
      const cur = findCaption(p, captionId);
      if (!cur) return;
      cur.caption.text = textarea.value;
      ui.selectedCaptionId = captionId;
    });
  });
  textarea.addEventListener('blur', () => {
    editingCaptionId = null;
    render();
  });
  bar.replaceChildren(textarea);
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.select();
  });
}

function wireCaptionPointer(bar, captionId) {
  bar.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    beginCaptionTextEdit(captionId);
  });
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const doublePress = isCaptionDoublePress(captionId, e);
    e.preventDefault();
    e.stopPropagation();
    if (doublePress || e.detail >= 2) {
      gesture = null;
      beginCaptionTextEdit(captionId);
      return;
    }
    const edge = e.target.dataset.edge;
    const layout = sequenceLayout();
    const found = findCaption(store.get(), captionId);
    if (!found) return;
    const item = layout.items.find(it => it.output.id === found.output.id);
    const abs = captionAbsolute(found.caption, item?.startMs || 0, item?.material);
    selectCaption(captionId);
    store.beginAction();
    gesture = {
      type: edge ? 'caption-resize' : 'caption-move',
      captionId,
      edge,
      startClientX: e.clientX,
      startAnchorMs: abs.anchorMs,
      startStartMs: abs.startMs,
      startEndMs: abs.endMs,
      startOffsetMs: found.caption.startOffsetMs,
      endOffsetMs: found.caption.endOffsetMs,
    };
  });
  bar.addEventListener('click', (e) => {
    e.stopPropagation();
    selectCaption(captionId);
  });
}

function isCaptionDoublePress(captionId, e) {
  const now = performance.now();
  const prev = lastCaptionPress;
  lastCaptionPress = { id: captionId, t: now, x: e.clientX, y: e.clientY };
  if (!prev || prev.id !== captionId || now - prev.t > 450) return false;
  return Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 10;
}

function onPointerMove(e) {
  const layout = sequenceLayout();
  if (playheadDrag) { seekFromClientX(e.clientX, true); return; }
  if (!gesture) return;
  if (gesture.type === 'pan') {
    const dx = e.clientX - gesture.startX;
    const dt = dx / innerW() * (gesture.startViewEnd - gesture.startViewStart);
    const total = layout.totalMs / 1000;
    const span = gesture.startViewEnd - gesture.startViewStart;
    viewStart = Math.max(0, Math.min(total - span, gesture.startViewStart - dt));
    viewEnd = viewStart + span;
    render();
    return;
  }
  if (gesture.type === 'caption-move') {
    const deltaMs = xToMs(e.clientX) - xToMs(gesture.startClientX);
    store.updateLive((p, ui) => moveCaptionAbsolute(p, ui, gesture.captionId, gesture.startAnchorMs + deltaMs, gesture.startOffsetMs, gesture.endOffsetMs));
  } else if (gesture.type === 'caption-resize') {
    const targetMs = clampMs(xToMs(e.clientX), layout);
    store.updateLive((p) => resizeCaptionAbsolute(p, gesture.captionId, gesture.edge, targetMs));
  }
}

function onPointerUp(e) {
  if (playheadDrag) {
    playheadDrag = false;
    listEl.classList.remove('seeking');
    seekFromClientX(e.clientX, false);
  }
  listEl?.classList?.remove('panning');
  gesture = null;
}

function seekFromClientX(clientX, previewOnly) {
  const layout = sequenceLayout();
  const ms = clampMs(xToMs(clientX), layout);
  onSeek(ms / 1000, { previewOnly });
  positionPlayhead(ms);
}

function positionPlayhead(forcedMs = null) {
  const ms = forcedMs ?? currentSequenceMs();
  const head = listEl?.querySelector('.edit-playhead');
  if (!head) return;
  const x = timeToX(ms);
  head.style.left = x + 'px';
  head.style.display = (x < 0 || x > innerW()) ? 'none' : 'block';
}

function currentSequenceMs() {
  const sel = store.ui.selection;
  if (sel.kind !== 'output') return 0;
  const layout = sequenceLayout();
  const item = layout.items.find(it => it.output.id === sel.id);
  if (!item || !video) return item?.startMs || 0;
  const localMs = Math.max(0, Math.round(((video.currentTime || item.material.in) - item.material.in) * 1000));
  return Math.max(0, Math.min(layout.totalMs, item.startMs + localMs));
}

function startPlayheadLoop() { if (!playRaf) playheadLoop(); }
function stopPlayheadLoop() { cancelAnimationFrame(playRaf); playRaf = 0; positionPlayhead(); }
function playheadLoop() { positionPlayhead(); playRaf = requestAnimationFrame(playheadLoop); }

function moveCaptionAbsolute(project, ui, captionId, anchorMs, startOffsetMs, endOffsetMs) {
  const layout = sequenceLayout(project);
  const old = findCaption(project, captionId);
  if (!old) return;
  const clampedAnchor = clampMs(anchorMs, layout);
  const item = itemAtMs(layout, clampedAnchor) || layout.items[layout.items.length - 1];
  if (!item) return;
  if (old.output.id !== item.output.id) {
    old.output.captions = captionsOf(old.output).filter(c => c.id !== captionId);
    captionsOf(item.output).push(old.caption);
  }
  old.caption.sourceAnchorMs = sourceAnchorFromSequenceMs(item, clampedAnchor);
  delete old.caption.anchorOffsetMs;
  old.caption.startOffsetMs = Math.round(startOffsetMs);
  old.caption.endOffsetMs = Math.round(endOffsetMs);
  ui.selectedCaptionId = captionId;
  ui.selection = { kind: null, id: null };
}

function selectOutput(outputId) {
  store.setUI({ selectedCaptionId: null, selection: { kind: 'output', id: outputId } });
}

function selectCaption(captionId) {
  store.setUI({ selectedCaptionId: captionId, selection: { kind: null, id: null } });
}

function resizeCaptionAbsolute(project, captionId, edge, targetMs) {
  const found = findCaption(project, captionId);
  if (!found) return;
  const layout = sequenceLayout(project);
  const item = layout.items.find(it => it.output.id === found.output.id);
  if (!item) return;
  const abs = captionAbsolute(found.caption, item.startMs, item.material);
  if (edge === 'start') {
    const nextStart = Math.min(targetMs, abs.anchorMs - 1);
    found.caption.startOffsetMs = Math.min(-1, nextStart - abs.anchorMs);
  } else {
    const nextEnd = Math.max(targetMs, abs.anchorMs + MIN_CAPTION_MS);
    found.caption.endOffsetMs = Math.max(MIN_CAPTION_MS, nextEnd - abs.anchorMs);
  }
}

function itemAtMs(layout, ms) {
  return layout.items.find(it => ms >= it.startMs && ms < it.endMs) || (ms === layout.totalMs ? layout.items[layout.items.length - 1] : null);
}

function findCaption(project, captionId) {
  for (const output of project.outputs) {
    const caption = captionsOf(output).find(c => c.id === captionId);
    if (caption) return { output, caption };
  }
  return null;
}

function captionOffsets(project) {
  const layout = sequenceLayout(project);
  const offsets = new Map();
  for (const item of layout.items) {
    for (const caption of captionsOf(item.output)) {
      offsets.set(caption.id, { ...caption });
    }
  }
  return offsets;
}

function restoreCaptionOffsets(project, offsets) {
  const layout = sequenceLayout(project);
  for (const item of layout.items) {
    for (const caption of captionsOf(item.output)) {
      const old = offsets.get(caption.id);
      if (!old) continue;
      Object.assign(caption, old);
      caption.sourceAnchorMs = Math.max(sourceMs(item.material.in), Math.min(sourceMs(item.material.out), Math.round(+caption.sourceAnchorMs || sourceMs(item.material.in))));
      delete caption.anchorOffsetMs;
    }
  }
}

function defaultCaptionForMaterial(material) {
  const durationMs = Math.max(MIN_CAPTION_MS, Math.round(Math.max(0, (material?.out || 0) - (material?.in || 0)) * 1000));
  const duration = Math.max(MIN_CAPTION_MS, Math.round(durationMs || MIN_CAPTION_MS));
  const inset = duration > 900 ? Math.min(260, Math.round(duration * 0.1)) : 0;
  const anchorOffsetMs = Math.round(duration / 2);
  return {
    id: uid('cap'),
    text: '',
    sourceAnchorMs: sourceMs(material?.in || 0) + anchorOffsetMs,
    startOffsetMs: Math.min(-1, inset - anchorOffsetMs),
    endOffsetMs: Math.max(MIN_CAPTION_MS, duration - inset - anchorOffsetMs),
  };
}

function onDragOver(e) {
  if (e.dataTransfer.types.includes('application/x-material') || draggingOutputId) {
    e.preventDefault();
    listEl.classList.add('drop-active');
  }
}

function wireOutputDrag(el) {
  el.addEventListener('dragstart', (e) => {
    draggingOutputId = el.dataset.id;
    e.dataTransfer.setData('application/x-output', draggingOutputId);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    draggingOutputId = null;
    el.classList.remove('dragging');
    listEl.classList.remove('drop-active');
  });
}

function onDrop(e) {
  e.preventDefault();
  listEl.classList.remove('drop-active');
  const matId = e.dataTransfer.getData('application/x-material');
  const targetId = e.target.closest('.out-card')?.dataset.id;
  const dropIndex = () => {
    if (!targetId) return store.get().outputs.length;
    const idx = store.get().outputs.findIndex(o => o.id === targetId);
    if (idx < 0) return store.get().outputs.length;
    const rect = e.target.closest('.out-card').getBoundingClientRect();
    return e.clientX > rect.left + rect.width / 2 ? idx + 1 : idx;
  };

  if (matId) {
    const id = uid('out');
    store.update((p, ui) => {
      const offsets = captionOffsets(p);
      const material = p.materials.find(m => m.id === matId);
      p.outputs.splice(Math.max(0, Math.min(dropIndex(), p.outputs.length)), 0, {
        id,
        materialId: matId,
        captions: [defaultCaptionForMaterial(material)],
      });
      restoreCaptionOffsets(p, offsets);
      ui.selection = { kind: 'output', id };
      ui.selectedCaptionId = null;
    });
  } else if (draggingOutputId) {
    store.update((p) => {
      const offsets = captionOffsets(p);
      const from = p.outputs.findIndex(o => o.id === draggingOutputId);
      let to = dropIndex();
      if (from < 0) return;
      const [moved] = p.outputs.splice(from, 1);
      if (from < to) to--;
      p.outputs.splice(Math.max(0, Math.min(to, p.outputs.length)), 0, moved);
      restoreCaptionOffsets(p, offsets);
    });
  }
}

async function ensureThumb(o) {
  const m = store.getMaterial(o.materialId);
  const src = m && store.getSource(m.sourceId);
  if (!src) return;
  const sig = Math.round((m.in + m.out) / 2 * (src.fps || 30));
  if (thumbSig.get(o.id) === sig || thumbBusy.get(o.id)) return;
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
  } catch { /* media can be unlinked */ }
  finally {
    thumbBusy.set(o.id, false);
    if (ok) {
      const cm = store.getMaterial(o.materialId);
      if (cm && Math.round((cm.in + cm.out) / 2 * (src.fps || 30)) !== thumbSig.get(o.id)) ensureThumb(o);
    }
  }
}

export function deleteOutput(id) {
  store.update((p, ui) => {
    const removed = p.outputs.find(o => o.id === id);
    p.outputs = p.outputs.filter(o => o.id !== id);
    if (ui.selection.kind === 'output' && ui.selection.id === id) ui.selection = { kind: null, id: null };
    if (removed && captionsOf(removed).some(c => c.id === ui.selectedCaptionId)) ui.selectedCaptionId = null;
  });
  thumbs.delete(id);
  thumbSig.delete(id);
  thumbBusy.delete(id);
}

export function deleteCaption(id) {
  if (!id || !findCaption(store.get(), id)) return false;
  store.update((p, ui) => {
    for (const output of p.outputs) {
      output.captions = captionsOf(output).filter(c => c.id !== id);
    }
    if (ui.selectedCaptionId === id) ui.selectedCaptionId = null;
  });
  return true;
}

export function sequenceStartForOutput(id) {
  const item = sequenceLayout().items.find(it => it.output.id === id);
  return item ? item.startMs / 1000 : 0;
}

export function activeCaptionTextAt(project, sequenceMs) {
  const layout = sequenceLayout(project);
  const rows = [];
  for (const item of layout.items) {
    for (const caption of captionsOf(item.output)) rows.push(captionAbsolute(caption, item.startMs, item.material));
  }
  rows.sort((a, b) => a.startMs - b.startMs);
  const active = rows.find(c => sequenceMs >= c.startMs && sequenceMs < c.endMs && (c.text || '').trim());
  return active ? active.text || '' : '';
}

function displayName(m, src) { return (m?.title || '').trim() || src?.fileName || 'Untitled material'; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
