// outputSequenceTimeline.js - edit timeline with playhead, wheel zoom/pan, and anchored captions
import { store, uid } from './store.js';
import { horizontalCardThumb, horizontalCropSignature, cloneCanvas } from './thumbnails.js';
import { escapeHtml, fmtDur } from './util.js';
import { MIN_CAPTION_MS, captionAbsolute, captionDensity, captionLines, densityClass } from './captions.js';

const MIN_SPAN_SEC = 1;
const MIN_CLIP_PX = 28;
const OUTSIDE_CAPTION_PAD_MS = 500;
const PREVIEW_INSET_MS = 120;
const DROP_EDGE_PAN_PX = 54;
const EDGE_THUMB_MIN_WIDTH = 180;

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
let lastEmptyCaptionPress = null;
let editingCaptionId = null;
let dropMarkerEl = null;

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
    if (!listEl.contains(e.relatedTarget)) {
      listEl.classList.remove('drop-active');
      hideDropMarker();
    }
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

  // Coalesce store-driven re-renders onto rAF: updateLive fires per
  // pointermove during drags and a full DOM rebuild per event is wasted work.
  // Direct render() calls (wheel/pan/resize) stay synchronous.
  store.subscribe(scheduleRender);
}

let renderRaf = 0;
function scheduleRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => { renderRaf = 0; render(); });
}

function render() {
  const layout = sequenceLayout();
  totalEl.textContent = 'Total ' + fmtDur(layout.totalMs / 1000);
  normalizeView(layout);
  const active = document.activeElement;
  if ((active?.classList?.contains('caption-edit-textarea') && listEl.contains(active)) || editingCaptionId) return;

  if (!layout.items.length) {
    listEl.innerHTML = '<div class="placeholder">Drag cut stock here to build the edit</div>';
    if (captionEditorEl) captionEditorEl.innerHTML = '';
    return;
  }

  listEl.classList.toggle('caption-focused', !!store.ui.selectedCaptionId);
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
      ensureThumb(item.output, 'mid');
      if (showEdgeThumbs(item)) {
        ensureThumb(item.output, 'start');
        ensureThumb(item.output, 'end');
      }
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
  let minMs = 0;
  let maxMs = 0;
  for (let index = 0; index < project.outputs.length; index++) {
    const output = project.outputs[index];
    const material = project.materials.find(m => m.id === output.materialId);
    if (!material) continue;
    const source = project.sources.find(s => s.id === material.sourceId);
    const durationMs = Math.max(MIN_CAPTION_MS, Math.round(Math.max(0, material.out - material.in) * 1000));
    const item = { output, material, source, index, startMs, endMs: startMs + durationMs, durationMs };
    clampCaptionAnchors(item);
    items.push(item);
    minMs = Math.min(minMs, item.startMs);
    maxMs = Math.max(maxMs, item.endMs);
    for (const caption of captionsOf(output)) {
      const abs = captionAbsolute(caption, item.startMs, material);
      if (!abs) continue;
      minMs = Math.min(minMs, abs.startMs);
      maxMs = Math.max(maxMs, abs.endMs);
    }
    startMs += durationMs;
  }
  const hasOutsideCaption = minMs < 0 || maxMs > startMs;
  return {
    items,
    totalMs: startMs,
    minMs: hasOutsideCaption ? minMs - OUTSIDE_CAPTION_PAD_MS : 0,
    maxMs: hasOutsideCaption ? maxMs + OUTSIDE_CAPTION_PAD_MS : startMs,
  };
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
    if (caption.secondaryText == null) caption.secondaryText = '';
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
function clampViewMs(ms, layout = sequenceLayout()) {
  return Math.max(layout.minMs, Math.min(layout.maxMs, Math.round(ms)));
}
function sourceMs(sec) { return Math.round(Math.max(0, +(sec || 0)) * 1000); }
function sourceAnchorFromSequenceMs(item, sequenceMs) {
  const localMs = Math.max(0, Math.min(item.durationMs, Math.round(sequenceMs - item.startMs)));
  return Math.max(sourceMs(item.material.in), Math.min(sourceMs(item.material.out), sourceMs(item.material.in) + localMs));
}

function normalizeView(layout) {
  const total = Math.max(0, layout.totalMs / 1000 || 0);
  if (!total) { viewStart = 0; viewEnd = 1; return; }
  const min = layout.minMs / 1000;
  const max = Math.max(min + MIN_SPAN_SEC, layout.maxMs / 1000);
  const boundsSpan = Math.max(MIN_SPAN_SEC, max - min);
  if (viewEnd <= viewStart || viewStart < min - 0.001 || viewEnd > max + 0.001) {
    viewStart = min;
    viewEnd = Math.min(max, viewStart + Math.max(MIN_SPAN_SEC, Math.min(12, boundsSpan)));
  }
  const span = Math.min(boundsSpan, Math.max(MIN_SPAN_SEC, spanSec()));
  viewStart = Math.max(min, Math.min(viewStart, max - span));
  viewEnd = Math.min(max, viewStart + span);
}

function card(item) {
  const selectedCaption = store.ui.selectedCaptionId ? findCaption(store.get(), store.ui.selectedCaptionId) : null;
  const selected = !store.ui.selectedCaptionId && store.ui.selection.kind === 'output' && store.ui.selection.id === item.output.id;
  const materialRelated = !store.ui.selectedCaptionId && store.ui.selection.kind === 'material' && store.ui.selection.id === item.material.id;
  const captionRelated = selectedCaption?.output.id === item.output.id;
  const el = document.createElement('div');
  el.className = 'card out-card' + (selected ? ' selected cut-selected' : '') + (captionRelated ? ' caption-related' : '') + (materialRelated ? ' material-related' : '') + (showEdgeThumbs(item) ? ' zoom-thumbs' : '');
  el.draggable = true;
  el.dataset.id = item.output.id;
  el.style.left = timeToX(item.startMs) + 'px';
  el.style.width = Math.max(MIN_CLIP_PX, timeToX(item.endMs) - timeToX(item.startMs)) + 'px';
  el.title = displayName(item.material, item.source);

  const thumb = document.createElement('div');
  thumb.className = 'thumb' + (showEdgeThumbs(item) ? ' thumb-multi' : '');
  if (showEdgeThumbs(item)) {
    for (const kind of ['start', 'mid', 'end']) {
      const part = document.createElement('div');
      part.className = `thumb-part thumb-${kind}`;
      part.dataset.thumbKind = kind;
      const canvas = thumbs.get(thumbKey(item.output.id, kind));
      if (canvas) part.appendChild(cloneCanvas(canvas));
      thumb.appendChild(part);
    }
  } else {
    thumb.dataset.thumbKind = 'mid';
    const canvas = thumbs.get(thumbKey(item.output.id, 'mid'));
    if (canvas) thumb.appendChild(cloneCanvas(canvas));
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span class="dur">${fmtDur(item.durationMs / 1000)}</span><span class="src">${escapeHtml(displayName(item.material, item.source))}</span>`;
  el.append(thumb, meta);
  el.onclick = () => selectOutput(item.output.id);
  el.ondblclick = () => onPlay(item.output.id);
  wireOutputDrag(el);
  return el;
}

function showEdgeThumbs(item) {
  return timeToX(item.endMs) - timeToX(item.startMs) >= EDGE_THUMB_MIN_WIDTH;
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
  const primaryLabel = (caption.text || '').trim() || '(caption)';
  const secondaryLabel = (caption.secondaryText || '').trim() || '...';
  const lines = Math.max(
    1,
    primaryLabel.split(/\r?\n/).length,
    (caption.secondaryText || '').trim() ? secondaryLabel.split(/\r?\n/).length : 1,
  );
  const barHeight = Math.min(88, Math.max(42, 28 + lines * 17));
  bar.style.height = barHeight + 'px';
  bar.title = `Cut ${item.index + 1} anchor ${fmtDur((caption.sourceAnchorMs || sourceMs(item.material.in)) / 1000)} / ${captionDensity(abs).toFixed(1)} chars/sec`;
  const anchorLocal = Math.max(0, Math.min(width, anchorX - left));
  bar.style.setProperty('--anchor-x', anchorLocal + 'px');
  bar.innerHTML =
    '<span class="caption-handle caption-handle-l" data-edge="start"></span>' +
    '<span class="caption-label">' +
    `<span class="caption-label-primary">${escapeHtml(primaryLabel)}</span>` +
    `<span class="caption-label-secondary">${escapeHtml(secondaryLabel)}</span>` +
    '</span>' +
    '<span class="caption-anchor-stem"></span><span class="caption-anchor-dot"></span>' +
    '<span class="caption-handle caption-handle-r" data-edge="end"></span>';
  wireCaptionPointer(bar, caption.id);
  return bar;
}

function onWheel(e) {
  const layout = sequenceLayout();
  if (!layout.totalMs) return;
  e.preventDefault();
  const min = layout.minMs / 1000;
  const max = Math.max(min + MIN_SPAN_SEC, layout.maxMs / 1000);
  const boundsSpan = Math.max(MIN_SPAN_SEC, max - min);
  const center = Math.max(min, Math.min(max, xToMs(e.clientX) / 1000));
  const oldSpan = spanSec();
  const factor = Math.exp(e.deltaY * 0.0015);
  const newSpan = Math.min(boundsSpan, Math.max(MIN_SPAN_SEC, oldSpan * factor));
  let start = center - (center - viewStart) * (newSpan / oldSpan);
  let end = start + newSpan;
  if (start < min) { start = min; end = start + newSpan; }
  if (end > max) { end = max; start = end - newSpan; }
  viewStart = Math.max(min, start);
  viewEnd = Math.min(max, end);
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
  if (captionTrack && !e.target.closest('.caption-bar')) {
    e.preventDefault();
    if (isEmptyCaptionDoublePress(e)) createCaptionAt(e.clientX);
    else clearCaptionSelection();
    return;
  }
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
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function createCaptionAt(clientX) {
  const layout = sequenceLayout();
  const anchorMs = clampMs(xToMs(clientX), layout);
  const item = itemAtMs(layout, anchorMs);
  if (!item) return;
  const gap = captionGapAt(layout, anchorMs);
  if (!gap || gap.endMs - gap.startMs < MIN_CAPTION_MS) return;
  const defaultStart = anchorMs - 650;
  const defaultEnd = anchorMs + 650;
  const startMs = Math.max(gap.startMs, defaultStart);
  const endMs = Math.min(gap.endMs, defaultEnd);
  if (endMs - startMs < MIN_CAPTION_MS) return;
  const id = uid('cap');
  const caption = {
    id,
    text: '',
    secondaryText: '',
    sourceAnchorMs: sourceAnchorFromSequenceMs(item, anchorMs),
    startOffsetMs: startMs - anchorMs,
    endOffsetMs: endMs - anchorMs,
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
  const existing = bar.querySelector('.caption-edit-panel textarea');
  if (existing) {
    existing.focus();
    existing.select();
    return;
  }
  editingCaptionId = captionId;
  const panel = document.createElement('div');
  panel.className = 'caption-edit-panel';
  const primary = captionEditTextarea(found.caption.text || '', 'Primary');
  const secondary = captionEditTextarea(found.caption.secondaryText || '', 'Second');
  primary.dataset.captionField = 'text';
  secondary.dataset.captionField = 'secondaryText';
  // One undo snapshot per text-edit session, pushed before the first change,
  // so Ctrl+Z after typing restores the pre-edit text instead of silently
  // dropping everything typed since the previous commit.
  let undoPushed = false;
  const sync = () => {
    if (!undoPushed) { undoPushed = true; store.beginAction(); }
    store.updateLive((p, ui) => {
      const cur = findCaption(p, captionId);
      if (!cur) return;
      cur.caption.text = primary.value;
      cur.caption.secondaryText = secondary.value;
      ui.selectedCaptionId = captionId;
    });
  };
  for (const textarea of [primary, secondary]) {
    textarea.addEventListener('pointerdown', (e) => e.stopPropagation());
    textarea.addEventListener('click', (e) => {
      e.stopPropagation();
      seekTextEditLine(captionId, textarea);
    });
    textarea.addEventListener('dblclick', (e) => e.stopPropagation());
    textarea.addEventListener('focus', () => seekTextEditLine(captionId, textarea));
    textarea.addEventListener('input', () => {
      sync();
      seekTextEditLine(captionId, textarea);
    });
    textarea.addEventListener('keyup', () => seekTextEditLine(captionId, textarea));
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') textarea.blur();
      if (e.key === 'Escape') {
        primary.value = found.caption.text || '';
        secondary.value = found.caption.secondaryText || '';
        textarea.blur();
      }
    });
    textarea.addEventListener('blur', () => {
      requestAnimationFrame(() => {
        if (panel.contains(document.activeElement)) return;
        editingCaptionId = null;
        render();
      });
    });
  }
  panel.append(primary, secondary);
  bar.replaceChildren(panel);
  requestAnimationFrame(() => {
    primary.focus();
    primary.select();
  });
}

function captionEditTextarea(value, label) {
  const textarea = document.createElement('textarea');
  textarea.className = 'caption-edit-textarea';
  textarea.value = value;
  textarea.placeholder = label;
  textarea.rows = 2;
  return textarea;
}

function seekTextEditLine(captionId, textarea) {
  const found = findCaption(store.get(), captionId);
  if (!found) return;
  const layout = sequenceLayout();
  const item = layout.items.find(it => it.output.id === found.output.id);
  if (!item) return;
  const lineIndex = Math.max(0, textarea.value.slice(0, textarea.selectionStart || 0).split(/\r?\n/).length - 1);
  const ms = captionLineStartMs(found.caption, textarea.dataset.captionField || 'text', lineIndex, item);
  seekTimelineMs(ms, true);
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
    if (edge) seekTimelineMs(edge === 'start' ? previewInsideMs(abs.startMs, abs, 'start') : previewInsideMs(abs.endMs, abs, 'end'), true);
    else seekTimelineMs(previewInsideMs(abs.startMs, abs, 'start'), true);
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

function isEmptyCaptionDoublePress(e) {
  const now = performance.now();
  const prev = lastEmptyCaptionPress;
  lastEmptyCaptionPress = { t: now, x: e.clientX, y: e.clientY };
  if (!prev || now - prev.t > 450) return false;
  return Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 10;
}

function onPointerMove(e) {
  const layout = sequenceLayout();
  if (playheadDrag) { seekFromClientX(e.clientX, true); return; }
  if (!gesture) return;
  if (gesture.type === 'pan') {
    const dx = e.clientX - gesture.startX;
    const dt = dx / innerW() * (gesture.startViewEnd - gesture.startViewStart);
    const min = layout.minMs / 1000;
    const max = Math.max(min + MIN_SPAN_SEC, layout.maxMs / 1000);
    const span = gesture.startViewEnd - gesture.startViewStart;
    viewStart = Math.max(min, Math.min(max - span, gesture.startViewStart - dt));
    viewEnd = viewStart + span;
    render();
    return;
  }
  if (gesture.type === 'caption-move') {
    const deltaMs = xToMs(e.clientX) - xToMs(gesture.startClientX);
    const targetAnchorMs = clampMs(gesture.startAnchorMs + deltaMs, layout);
    store.updateLive((p, ui) => moveCaptionAbsolute(p, ui, gesture.captionId, targetAnchorMs, gesture.startOffsetMs, gesture.endOffsetMs));
    seekTimelineMs(previewInsideMs(targetAnchorMs + gesture.startOffsetMs, {
      startMs: targetAnchorMs + gesture.startOffsetMs,
      endMs: targetAnchorMs + gesture.endOffsetMs,
    }, 'start'), true);
  } else if (gesture.type === 'caption-resize') {
    const targetMs = clampViewMs(xToMs(e.clientX), layout);
    store.updateLive((p) => resizeCaptionAbsolute(p, gesture.captionId, gesture.edge, targetMs));
    const edgeMs = gesture.edge === 'start' ? Math.min(targetMs, gesture.startAnchorMs - 1) : Math.max(targetMs, gesture.startAnchorMs + MIN_CAPTION_MS);
    seekTimelineMs(previewInsideMs(edgeMs, {
      startMs: gesture.edge === 'start' ? edgeMs : gesture.startAnchorMs + gesture.startOffsetMs,
      endMs: gesture.edge === 'end' ? edgeMs : gesture.startAnchorMs + gesture.endOffsetMs,
    }, gesture.edge), true);
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
  seekTimelineMs(ms, previewOnly);
}

function seekTimelineMs(ms, previewOnly = true) {
  const layout = sequenceLayout();
  const timelineMs = clampViewMs(ms, layout);
  const playbackMs = clampMs(ms, layout);
  onSeek(playbackMs / 1000, { previewOnly });
  positionPlayhead(timelineMs);
}

// Last position a gesture forced the playhead to. Caption drags re-render the
// timeline on rAF and the video fires async 'seeked' events; both call
// positionPlayhead() with no argument, which must not undo the gesture's
// placement while the drag is still active.
let lastForcedPlayheadMs = null;

function gestureDragActive() {
  return playheadDrag || gesture?.type === 'caption-move' || gesture?.type === 'caption-resize';
}

function positionPlayhead(forcedMs = null) {
  if (forcedMs != null) lastForcedPlayheadMs = forcedMs;
  const ms = forcedMs
    ?? (gestureDragActive() && lastForcedPlayheadMs != null ? lastForcedPlayheadMs : currentSequenceMs());
  const head = listEl?.querySelector('.edit-playhead');
  if (!head) return;
  const x = timeToX(ms);
  head.style.left = x + 'px';
  head.style.display = (x < 0 || x > innerW()) ? 'none' : 'block';
}

function currentSequenceMs() {
  // A selected caption also anchors the playhead to its cut: selecting a
  // caption clears ui.selection, so resolve the owning output explicitly.
  const sel = store.ui.selection;
  let outputId = sel.kind === 'output' ? sel.id : null;
  if (!outputId && store.ui.selectedCaptionId) {
    outputId = findCaption(store.get(), store.ui.selectedCaptionId)?.output.id || null;
  }
  if (!outputId) return 0;
  const layout = sequenceLayout();
  const item = layout.items.find(it => it.output.id === outputId);
  if (!item || !video) return item?.startMs || 0;
  const localMs = Math.max(0, Math.round(((video.currentTime || item.material.in) - item.material.in) * 1000));
  return Math.max(0, Math.min(layout.totalMs, item.startMs + localMs));
}

function captionLineStartMs(caption, field, lineIndex, item) {
  const abs = captionAbsolute(caption, item.startMs, item.material);
  if (!abs) return item.startMs;
  const lines = captionLines(caption[field] || '');
  if (lines.length <= 1) return previewInsideMs(abs.startMs, abs, 'start');
  const index = Math.max(0, Math.min(lines.length - 1, lineIndex));
  const duration = Math.max(MIN_CAPTION_MS, abs.endMs - abs.startMs);
  const gapTotal = 200 * (lines.length - 1);
  if (duration >= gapTotal + 400 * lines.length) {
    const visibleMs = (duration - gapTotal) / lines.length;
    const lineStart = Math.round(abs.startMs + index * (visibleMs + 200));
    return previewInsideMs(lineStart, { startMs: lineStart, endMs: lineStart + visibleMs }, 'start');
  }
  const segment = duration / lines.length;
  const lineStart = Math.round(abs.startMs + index * segment);
  return previewInsideMs(lineStart, { startMs: lineStart, endMs: lineStart + segment }, 'start');
}

function previewInsideMs(ms, abs, edge = 'start') {
  const start = Math.round(abs.startMs);
  const end = Math.round(abs.endMs);
  if (end - start <= PREVIEW_INSET_MS * 2) return Math.round((start + end) / 2);
  if (edge === 'end') return Math.max(start + 1, end - PREVIEW_INSET_MS);
  return Math.min(end - 1, Math.max(start, Math.round(ms)) + PREVIEW_INSET_MS);
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

function clearCaptionSelection() {
  editingCaptionId = null;
  const active = document.activeElement;
  if (active?.classList?.contains('caption-edit-textarea')) active.blur();
  store.setUI({ selectedCaptionId: null, selection: { kind: null, id: null } });
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

function captionGapAt(layout, anchorMs) {
  const ranges = [];
  for (const item of layout.items) {
    for (const caption of captionsOf(item.output)) {
      const abs = captionAbsolute(caption, item.startMs, item.material);
      if (abs) ranges.push({ startMs: abs.startMs, endMs: abs.endMs });
    }
  }
  ranges.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let gapStart = 0;
  for (const range of ranges) {
    if (anchorMs >= range.startMs && anchorMs < range.endMs) return null;
    if (anchorMs < range.startMs) return { startMs: gapStart, endMs: range.startMs };
    gapStart = Math.max(gapStart, range.endMs);
  }
  return { startMs: gapStart, endMs: layout.maxMs };
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
    const layout = sequenceLayout();
    if (autoPanForDrop(e.clientX, layout)) return;
    showDropMarker(dropIndexAt(e.clientX, layout), layout);
  }
}

function dropIndexAt(clientX, layout = sequenceLayout()) {
  const targetMs = xToMs(clientX);
  for (const item of layout.items) {
    const midMs = (item.startMs + item.endMs) / 2;
    if (targetMs < midMs) return item.index;
  }
  const last = layout.items[layout.items.length - 1];
  return last ? last.index + 1 : 0;
}

function markerXForDropIndex(index, layout = sequenceLayout()) {
  const next = layout.items.find(item => item.index >= index);
  if (next) return timeToX(next.startMs);
  const prev = [...layout.items].reverse().find(item => item.index < index);
  return timeToX(prev ? prev.endMs : 0);
}

function showDropMarker(index, layout = sequenceLayout()) {
  const timeline = listEl.querySelector('.edit-timeline');
  if (!timeline || !layout.items.length) return;
  if (!dropMarkerEl) {
    dropMarkerEl = document.createElement('div');
    dropMarkerEl.className = 'edit-insert-marker';
  }
  dropMarkerEl.style.left = `${markerXForDropIndex(index, layout)}px`;
  if (!dropMarkerEl.parentNode) timeline.appendChild(dropMarkerEl);
}

function hideDropMarker() {
  dropMarkerEl?.remove();
  dropMarkerEl = null;
}

function autoPanForDrop(clientX, layout = sequenceLayout()) {
  const timeline = listEl.querySelector('.edit-timeline');
  if (!timeline || !layout.items.length) return false;
  const rect = timeline.getBoundingClientRect();
  const dir = clientX < rect.left + DROP_EDGE_PAN_PX ? -1 : (clientX > rect.right - DROP_EDGE_PAN_PX ? 1 : 0);
  if (!dir) return false;
  const min = layout.minMs / 1000;
  const max = Math.max(min + MIN_SPAN_SEC, layout.maxMs / 1000);
  const span = spanSec();
  const shift = Math.max(0.08, span * 0.08) * dir;
  const nextStart = Math.max(min, Math.min(max - span, viewStart + shift));
  if (Math.abs(nextStart - viewStart) < 0.001) return false;
  viewStart = nextStart;
  viewEnd = viewStart + span;
  render();
  return true;
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
    hideDropMarker();
  });
}

function onDrop(e) {
  e.preventDefault();
  listEl.classList.remove('drop-active');
  hideDropMarker();
  const matId = e.dataTransfer.getData('application/x-material');
  const dropIndex = () => Math.max(0, Math.min(dropIndexAt(e.clientX), store.get().outputs.length));

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
    requestAnimationFrame(() => includeOutputInView(id));
  } else if (draggingOutputId) {
    const movedId = draggingOutputId;
    store.update((p) => {
      const offsets = captionOffsets(p);
      const from = p.outputs.findIndex(o => o.id === movedId);
      let to = dropIndex();
      if (from < 0) return;
      const [moved] = p.outputs.splice(from, 1);
      if (from < to) to--;
      p.outputs.splice(Math.max(0, Math.min(to, p.outputs.length)), 0, moved);
      restoreCaptionOffsets(p, offsets);
    });
    requestAnimationFrame(() => includeOutputInView(movedId));
  }
}

function includeOutputInView(outputId) {
  const layout = sequenceLayout();
  normalizeView(layout);
  const item = layout.items.find(it => it.output.id === outputId);
  if (!item) return;
  const padSec = 0.25;
  const min = layout.minMs / 1000;
  const max = Math.max(min + MIN_SPAN_SEC, layout.maxMs / 1000);
  const boundsSpan = Math.max(MIN_SPAN_SEC, max - min);
  const span = Math.min(boundsSpan, Math.max(MIN_SPAN_SEC, spanSec()));
  let nextStart = viewStart;
  const itemStart = item.startMs / 1000;
  const itemEnd = item.endMs / 1000;
  if (itemStart < viewStart + padSec) nextStart = itemStart - padSec;
  if (itemEnd > viewEnd - padSec) nextStart = itemEnd - span + padSec;
  nextStart = Math.max(min, Math.min(max - span, nextStart));
  if (Math.abs(nextStart - viewStart) > 0.001) {
    viewStart = nextStart;
    viewEnd = viewStart + span;
    render();
  }
}

function thumbKey(outputId, kind) {
  return `${outputId}:${kind || 'mid'}`;
}

function thumbTimeFor(material, source, kind) {
  const fps = source?.fps || 30;
  const frame = 1 / fps;
  if (kind === 'start') return material.in;
  if (kind === 'end') return Math.max(material.in, material.out - frame);
  return (material.in + material.out) / 2;
}

async function ensureThumb(o, kind = 'mid') {
  const m = store.getMaterial(o.materialId);
  const src = m && store.getSource(m.sourceId);
  if (!src) return;
  const key = thumbKey(o.id, kind);
  const time = thumbTimeFor(m, src, kind);
  const sig = `${Math.round(time * (src.fps || 30))}:${horizontalCropSignature(m.horizontalCrop || {})}`;
  if (thumbSig.get(key) === sig || thumbBusy.get(key)) return;
  thumbBusy.set(key, true);
  let ok = false;
  try {
    const canvas = await horizontalCardThumb(src, time, m.horizontalCrop || {});
    if (canvas) {
      ok = true;
      thumbs.set(key, canvas);
      thumbSig.set(key, sig);
      const slot = listEl.querySelector(`.card[data-id="${o.id}"] [data-thumb-kind="${kind}"]`);
      if (slot) slot.replaceChildren(cloneCanvas(canvas));
    }
  } catch { /* media can be unlinked */ }
  finally {
    thumbBusy.set(key, false);
    if (ok) {
      const cm = store.getMaterial(o.materialId);
      if (cm) {
        const nextSig = `${Math.round(thumbTimeFor(cm, src, kind) * (src.fps || 30))}:${horizontalCropSignature(cm.horizontalCrop || {})}`;
        if (nextSig !== thumbSig.get(key)) ensureThumb(o, kind);
      }
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
  for (const kind of ['start', 'mid', 'end']) {
    const key = thumbKey(id, kind);
    thumbs.delete(key);
    thumbSig.delete(key);
    thumbBusy.delete(key);
  }
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

