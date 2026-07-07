// app.js - entry: wire modules, selection side-effects, ranged playback, temporary export
import { store } from './store.js?v=20260707-indexeddb-autosave';
import * as fileOpen from './fileOpen.js?v=20260707-indexeddb-autosave';
import * as db from './db.js?v=20260707-indexeddb-autosave';
import * as cropPreview from './cropPreview.js?v=20260707-indexeddb-autosave';
import * as srcTimeline from './sourceTimeline.js?v=20260707-indexeddb-autosave';
import * as frameStrip from './frameStrip.js?v=20260707-indexeddb-autosave';
import * as shelf from './materialShelf.js?v=20260707-indexeddb-autosave';
import * as outSeq from './outputSequence.js?v=20260707-indexeddb-autosave';
import { exportProject, downloadBlob } from './export.js?v=20260707-indexeddb-autosave';
import { fmtTime, frameFromTime, frameProbeTime, makeScrubber, seekVideoFrame } from './util.js?v=20260707-indexeddb-autosave';

const $ = (id) => document.getElementById(id);
const el = {};
['btnNewProject','btnAddVideo','sourceSelect','btnUndo','btnRedo',
 'btnExport','status','srcVideo','srcEmpty','origPane','origTime','btnPlay','btnLoop','vertPane','vertCanvas',
 'panX','panY','zoom','bgBlur','verticalCropReset',
 'sourcePanX','sourcePanY','sourceZoom','sourceCropReset',
 'overlay','overlayMsg','overlayProg',
 'confirm','confirmTitle','confirmMsg','confirmOk','confirmCancel',
 'srcPane','tlScroll','tlInner','thumbRow','clipBands','tlPlayhead','frameStrip','srcRange',
 'tlOverview','ovThumbRow','ovClips','ovWindow','ovPlayhead',
 'seekBar','seekMarks','seekRange','seekFill','seekHead','frameInfo',
 'workPane','shelf','shelfCount','outList','totalDur','btnPlayOut','btnStopOut'].forEach(id => el[id] = $(id));

let activeUrl = null;
let pendingSeek = null;
let lastSelKey = '';
let loopEnabled = true;
let sequence = null;
let transportRaf = 0;
let sequenceAdvancing = false;
let activeArea = 'timeline';

function init() {
  cropPreview.init(el.vertCanvas, el.srcVideo);
  srcTimeline.init({
    scroll: el.tlScroll, inner: el.tlInner, thumbRow: el.thumbRow,
    bands: el.clipBands, playhead: el.tlPlayhead, range: el.srcRange,
    overview: el.tlOverview, ovThumbRow: el.ovThumbRow, ovClips: el.ovClips, ovWindow: el.ovWindow, ovPlayhead: el.ovPlayhead,
  }, el.srcVideo);
  frameStrip.init(el.frameStrip, el.srcVideo);
  shelf.init({ shelf: el.shelf, count: el.shelfCount }, { play: playRange });
  outSeq.init({ list: el.outList, total: el.totalDur }, { play: playOutputFrom });
  srcTimeline.onPlayRange(playRange);

  wireMenu(); wireTransport(); wireCrop(); wireShortcuts(); wireSeek(); wireConfirm(); wireAreas(); wireWorkspaceSplitters(); wireVideoDrop();
  store.subscribe(onState);

  bootstrap();
}

async function bootstrap() {
  if (await store.restore()) {
    const restored = await fileOpen.restoreSavedMedia();
    refreshStateViews();
    setStatus(restored.length ? 'Restored edit' : 'Restored edit; video files are missing');
  } else {
    await resetTemporaryEdit('Temporary edit ready', { clearSaved: true });
  }
  updateChrome();
}

// ---------- menu ----------
function wireMenu() {
  el.btnNewProject.onclick = guard(async () => {
    if (hasWork()) {
      if (!await askConfirm('Start a new edit?\nCurrent work will be lost.', 'New', 'New Edit')) return;
      if (!await askConfirm('Confirm again.\nCurrent work will be lost.', 'New', 'New Edit')) return;
    }
    await resetTemporaryEdit('State cleared', { clearSaved: true });
  });
  el.btnAddVideo.onclick = guard(async () => {
    el.btnAddVideo.disabled = true;
    try {
      await fileOpen.addVideo();
    }
    finally { updateChrome(); }
  });
  el.btnUndo.onclick = () => store.undo();
  el.btnRedo.onclick = () => store.redo();
  el.btnExport.onclick = guard(doExport);
  el.sourceSelect.onchange = () => store.setUI({ activeSourceId: el.sourceSelect.value });
}

async function resetTemporaryEdit(message, { clearSaved = false } = {}) {
  stopSequence();
  try { el.srcVideo.pause(); } catch { /* ignore */ }
  activeUrl = null;
  pendingSeek = null;
  lastSelKey = '';
  fileOpen.clear();
  if (clearSaved) {
    await Promise.all([
      db.clearAutosave(),
      db.clearHistory(),
      fileOpen.clearSavedMedia(),
    ]);
  }
  store.load({ name: 'temporary' });
  setStatus(message);
}

function hasWork() {
  const p = store.get();
  return !!(p.sources.length || p.materials.length || p.outputs.length);
}

function wireVideoDrop() {
  const takeFiles = guard(async (files) => {
    const videos = [...files].filter(f => f.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|m4v)$/i.test(f.name || ''));
    if (!videos.length) {
      setStatus('Drop video files on Add Video');
      return;
    }
    await fileOpen.addVideoFiles(videos);
    setStatus(videos.length === 1 ? 'Video added: ' + videos[0].name : 'Videos added: ' + videos.length);
    updateChrome();
  });

  el.btnAddVideo.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.btnAddVideo.classList.add('drop-active');
  });
  el.btnAddVideo.addEventListener('dragleave', () => el.btnAddVideo.classList.remove('drop-active'));
  el.btnAddVideo.addEventListener('drop', (e) => {
    e.preventDefault();
    el.btnAddVideo.classList.remove('drop-active');
    takeFiles(e.dataTransfer.files);
  });
}

// ---------- transport / ranged playback ----------
function wireTransport() {
  el.btnPlay.onclick = () => {
    stopSequence();
    if (el.srcVideo.paused) el.srcVideo.play();
    else el.srcVideo.pause();
  };
  el.btnLoop.onclick = () => { loopEnabled = !loopEnabled; el.btnLoop.style.color = loopEnabled ? 'var(--accent)' : ''; };
  el.srcVideo.addEventListener('play', () => el.btnPlay.textContent = 'Pause');
  el.srcVideo.addEventListener('pause', () => el.btnPlay.textContent = 'Play');
  el.srcVideo.addEventListener('play', startTransportMonitor);
  el.srcVideo.addEventListener('pause', stopTransportMonitor);
  el.srcVideo.addEventListener('ended', stopTransportMonitor);
  el.srcVideo.addEventListener('play', updateOutputTransport);
  el.srcVideo.addEventListener('pause', updateOutputTransport);
  el.srcVideo.addEventListener('timeupdate', () => {
    el.origTime.textContent = fmtTime(el.srcVideo.currentTime) + ' / ' + fmtTime(el.srcVideo.duration);
  });
  el.btnLoop.style.color = 'var(--accent)';

  el.btnPlayOut.onclick = playOutputs;
  el.btnStopOut.onclick = toggleOutputPause;
}

function playRange(a, b) {
  stopSequence();
  store.ui.playRange = { start: a, end: b };
  renderSeekDecor();
  seekTo(a, () => el.srcVideo.play());
}

function frameDur() {
  const fps = store.activeSource()?.fps || 30;
  return 1 / fps;
}

function frameDurFor(sourceId) {
  const fps = store.getSource(sourceId)?.fps || store.activeSource()?.fps || 30;
  return 1 / fps;
}

function activeFps() {
  return store.activeSource()?.fps || 30;
}

function activeDuration() {
  return store.activeSource()?.duration || el.srcVideo.duration || 0;
}

function frameOfTime(t, fps = activeFps(), duration = activeDuration()) {
  const total = duration ? Math.max(0, Math.round(duration * fps) - 1) : Number.MAX_SAFE_INTEGER;
  return frameFromTime(t, fps, total);
}

function probeTimeOf(t) {
  const fps = activeFps();
  const duration = activeDuration();
  return frameProbeTime(frameOfTime(t, fps, duration), fps, duration);
}

function endGuard() {
  return Math.min(0.03, frameDur() * 0.75);
}

function sequenceEndGuard(item) {
  return Math.min(0.08, frameDurFor(item?.sourceId) * 1.15);
}

function startTransportMonitor() {
  if (!transportRaf) transportLoop();
}

function stopTransportMonitor() {
  cancelAnimationFrame(transportRaf);
  transportRaf = 0;
}

function transportLoop() {
  transportRaf = requestAnimationFrame(transportLoop);
  if (!el.srcVideo || el.srcVideo.paused) return;

  // Sequential output playback takes priority over a source loop range.
  if (sequence) {
    const it = sequence.items[sequence.i];
    if (it && !sequenceAdvancing) {
      const fps = store.getSource(it.sourceId)?.fps || activeFps();
      const outFrame = Math.round(it.out * fps);
      if (el.srcVideo.currentTime >= outFrame / fps - sequenceEndGuard(it)) advanceSequence();
    }
    return;
  }

  const r = store.ui.playRange;
  if (!r) return;
  const fps = activeFps();
  const outFrame = Math.round(r.end * fps);
  if (el.srcVideo.currentTime < outFrame / fps - endGuard()) return;

  if (loopEnabled) {
    seekVideoFrame(el.srcVideo, Math.round(r.start * fps), fps, activeDuration());
  } else {
    el.srcVideo.pause();
    seekVideoFrame(el.srcVideo, Math.max(Math.round(r.start * fps), outFrame - 1), fps, activeDuration());
  }
}

// ---- sequential playback of the output sequence ----
function playOutputs() {
  playOutputsFromIndex(0);
}

function playOutputFrom(outputId) {
  const p = store.get();
  const index = p.outputs.findIndex(o => o.id === outputId);
  playOutputsFromIndex(Math.max(0, index));
}

function playOutputsFromIndex(startIndex) {
  const p = store.get();
  const items = p.outputs.map(o => {
    const m = store.getMaterial(o.materialId);
    return m ? {
      outputId: o.id,
      materialId: m.id,
      sourceId: m.sourceId,
      in: m.in,
      out: m.out,
    } : null;
  }).filter(Boolean);
  if (!items.length) return;
  store.ui.playRange = null;
  sequence = { items, i: Math.min(Math.max(0, startIndex || 0), items.length - 1), mode: 'native' };
  sequenceAdvancing = false;
  updateOutputTransport();
  playSequenceItem();
}

function playSequenceItem() {
  if (!sequence) return;
  const it = sequence.items[sequence.i];
  store.ui._fromSequence = true;
  store.select('output', it.outputId);
  ensureSource(it.sourceId, () => {
    seekTo(it.in, () => {
      sequenceAdvancing = false;
      el.srcVideo.play();
    });
  });
}

function advanceSequence() {
  if (!sequence) return;
  sequenceAdvancing = true;
  try { el.srcVideo.pause(); } catch { /* ignore */ }
  sequence.i++;
  if (sequence.i >= sequence.items.length) { stopSequence(); return; }
  playSequenceItem();
}

function toggleOutputPause() {
  if (!sequence) return;
  if (el.srcVideo.paused) el.srcVideo.play();
  else el.srcVideo.pause();
  updateOutputTransport();
}

function stopSequence() {
  const hadSequence = !!sequence;
  if (hadSequence) {
    try { el.srcVideo.pause(); } catch { /* ignore */ }
  }
  sequence = null;
  sequenceAdvancing = false;
  updateOutputTransport();
}

function updateOutputTransport() {
  el.btnStopOut.disabled = !sequence;
  el.btnStopOut.textContent = sequence && el.srcVideo.paused ? 'Resume' : 'Pause';
}

function ensureSource(sourceId, cb) {
  if (store.ui.activeSourceId === sourceId && el.srcVideo.readyState >= 1) { cb(); return; }
  if (store.ui.activeSourceId !== sourceId) store.setUI({ activeSourceId: sourceId });
  el.srcVideo.addEventListener('loadeddata', cb, { once: true });
}

function seekTo(t, cb) {
  const fps = activeFps();
  const duration = activeDuration();
  const targetFrame = frameOfTime(t, fps, duration);
  const targetTime = frameProbeTime(targetFrame, fps, duration);
  if (el.srcVideo.readyState >= 1) {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.srcVideo.removeEventListener('seeked', finish);
      cb?.();
    };
    if (cb) {
      el.srcVideo.addEventListener('seeked', finish);
      requestAnimationFrame(() => {
        if (Math.abs(el.srcVideo.currentTime - targetTime) < 1e-4 && !el.srcVideo.seeking) finish();
      });
    }
    try { el.srcVideo.currentTime = targetTime; } catch { finish(); }
  } else {
    pendingSeek = t;
    if (cb) el.srcVideo.addEventListener('loadeddata', cb, { once: true });
  }
}

// ---------- preview seek bar + frame readout ----------
let seekScrub = null;
let seekRaf = 0;
function wireSeek() {
  seekScrub = makeScrubber(el.srcVideo);
  const bar = el.seekBar;
  let dragging = false;
  const tAt = (clientX) => {
    const r = bar.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1)));
    return f * (el.srcVideo.duration || 0);
  };
  bar.addEventListener('pointerdown', (e) => {
    if (!el.srcVideo.duration) return;
    dragging = true;
    try { bar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    stopSequence(); store.ui.playRange = null;
    seekScrub(probeTimeOf(tAt(e.clientX))); updateSeek();
  });
  bar.addEventListener('pointermove', (e) => { if (dragging) { seekScrub(probeTimeOf(tAt(e.clientX))); updateSeek(e.clientX); } });
  bar.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    try { bar.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    seekTo(tAt(e.clientX));
  });

  el.srcVideo.addEventListener('timeupdate', () => { updateSeek(); updateFrameInfo(); });
  el.srcVideo.addEventListener('seeked', () => { updateSeek(); updateFrameInfo(); });
  el.srcVideo.addEventListener('loadedmetadata', () => { renderSeekDecor(); updateSeek(); updateFrameInfo(); });
  el.srcVideo.addEventListener('play', startSeekLoop);
  el.srcVideo.addEventListener('pause', stopSeekLoop);
  el.srcVideo.addEventListener('ended', stopSeekLoop);
}

function startSeekLoop() { if (!seekRaf) seekLoop(); }
function stopSeekLoop() { cancelAnimationFrame(seekRaf); seekRaf = 0; updateSeek(); }
function seekLoop() { updateSeek(); seekRaf = requestAnimationFrame(seekLoop); }

function updateSeek(overrideX) {
  const d = el.srcVideo.duration || 0;
  let f = 0;
  if (overrideX != null) {
    const r = el.seekBar.getBoundingClientRect();
    f = Math.min(1, Math.max(0, (overrideX - r.left) / (r.width || 1))) * 100;
  } else {
    f = d ? (el.srcVideo.currentTime / d * 100) : 0;
  }
  el.seekFill.style.width = f + '%';
  el.seekHead.style.left = f + '%';
}

function updateFrameInfo() {
  const src = store.activeSource();
  const fps = (src && src.fps) || 0;
  if (!fps || !el.srcVideo.duration) { el.frameInfo.textContent = '-'; return; }
  const frameDur = 1 / fps;
  const totalFrames = Math.round((el.srcVideo.duration || 0) * fps);
  const frame = frameFromTime(el.srcVideo.currentTime, fps, Math.max(0, totalFrames - 1));
  el.frameInfo.textContent = fps + 'fps - 1 frame ' + frameDur.toFixed(3) + 's - #' + frame + '/' + totalFrames;
}

function renderSeekDecor() {
  const d = el.srcVideo.duration || store.activeSource()?.duration || 0;
  if (!d) { el.seekMarks.innerHTML = ''; el.seekRange.style.display = 'none'; return; }
  const sid = store.ui.activeSourceId;
  const mats = store.get().materials.filter(m => m.sourceId === sid);
  el.seekMarks.innerHTML = mats.map(m => {
    const l = m.in / d * 100, w = Math.max(0.3, (m.out - m.in) / d * 100);
    return '<span style="left:' + l + '%;width:' + w + '%"></span>';
  }).join('');
  const r = store.ui.playRange;
  if (r) {
    el.seekRange.style.display = 'block';
    el.seekRange.style.left = (r.start / d * 100) + '%';
    el.seekRange.style.width = Math.max(0.3, (r.end - r.start) / d * 100) + '%';
  } else {
    el.seekRange.style.display = 'none';
  }
}

// ---------- crop sliders ----------
function wireCrop() {
  const startVertical = () => { if (store.resolve()?.material) store.beginAction(); };
  const startSource = () => { if (store.resolve()?.material) store.beginAction(); };
  const applyVertical = () => {
    const crop = { panX: +el.panX.value, panY: +el.panY.value, zoom: +el.zoom.value, bgBlur: +el.bgBlur.value };
    const r = store.resolve();
    if (r?.material) {
      store.updateLive(() => { r.material.crop = crop; });
    } else {
      store.setUI({ crop });
    }
  };
  for (const s of [el.panX, el.panY, el.zoom, el.bgBlur]) {
    s.addEventListener('pointerdown', startVertical);
    s.addEventListener('input', applyVertical);
  }
  el.verticalCropReset.onclick = () => {
    const crop = { panX: .5, panY: .5, zoom: 1, bgBlur: 0 };
    const r = store.resolve();
    if (r?.material) store.update((p) => { r.material.crop = crop; });
    else store.setUI({ crop });
  };

  const applySource = () => {
    const sourceCrop = { panX: +el.sourcePanX.value, panY: +el.sourcePanY.value, zoom: +el.sourceZoom.value };
    const r = store.resolve();
    if (r?.material) {
      store.updateLive(() => { r.material.sourceCrop = sourceCrop; });
    } else {
      store.setUI({ sourceCrop });
    }
  };
  for (const s of [el.sourcePanX, el.sourcePanY, el.sourceZoom]) {
    s.addEventListener('pointerdown', startSource);
    s.addEventListener('input', applySource);
  }
  el.sourceCropReset.onclick = () => {
    const sourceCrop = { panX: .5, panY: .5, zoom: 1 };
    const r = store.resolve();
    if (r?.material) store.update((p) => { r.material.sourceCrop = sourceCrop; });
    else store.setUI({ sourceCrop });
  };

  el.vertPane.addEventListener('dblclick', (e) => {
    e.preventDefault();
    store.setUI({ cropEditActive: !store.ui.cropEditActive });
    requestAnimationFrame(() => cropPreview.refresh());
  });
  el.origPane.addEventListener('dblclick', (e) => {
    e.preventDefault();
    store.setUI({ sourceCropEditActive: !store.ui.sourceCropEditActive });
  });
}

// ---------- active editing areas ----------
function wireAreas() {
  const areas = [...document.querySelectorAll('[data-area]')];
  const setArea = (area) => {
    if (!area) return;
    activeArea = area;
    const patch = {};
    if (area !== 'source') {
      if (store.ui.cropEditActive) patch.cropEditActive = false;
      if (store.ui.sourceCropEditActive) patch.sourceCropEditActive = false;
    }
    if (area !== 'timeline' && (store.ui.editMaterialId || store.ui.editMaterialIds?.length)) {
      patch.editMaterialId = null;
      patch.editMaterialIds = [];
    }
    if (Object.keys(patch).length) store.setUI(patch);
    for (const node of areas) node.classList.toggle('area-active', node.dataset.area === area);
    document.body.dataset.activeArea = area;
  };
  for (const node of areas) {
    node.addEventListener('pointerdown', () => setArea(node.dataset.area), { capture: true });
  }
  setArea(activeArea);
}

// ---------- workspace splitters ----------
function wireWorkspaceSplitters() {
  const splitters = [...document.querySelectorAll('.pane-splitter')];
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  let drag = null;

  for (const splitter of splitters) {
    splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = el.workPane.getBoundingClientRect();
      drag = {
        el: splitter,
        kind: splitter.dataset.splitter,
        startX: e.clientX,
        workW: rect.width,
        materials: document.getElementById('shelfPane').getBoundingClientRect().width,
        vertical: el.vertPane.getBoundingClientRect().width,
      };
      splitter.classList.add('dragging');
      try { splitter.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
  }

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (drag.kind === 'materials') {
      const max = Math.max(160, drag.workW - drag.vertical - 340);
      el.workPane.style.setProperty('--materials-col', clamp(drag.materials + dx, 120, max) + 'px');
    } else if (drag.kind === 'vertical') {
      const max = Math.max(180, drag.workW - drag.materials - 340);
      el.workPane.style.setProperty('--vertical-col', clamp(drag.vertical - dx, 150, max) + 'px');
    }
    window.dispatchEvent(new Event('resize'));
  });

  window.addEventListener('pointerup', (e) => {
    if (!drag) return;
    try { drag.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    drag.el.classList.remove('dragging');
    drag = null;
  });
}

// ---------- shortcuts ----------
function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    // confirm dialog captures Enter/Escape while open
    if (!el.confirm.hidden) {
      if (e.key === 'Enter') { e.preventDefault(); closeConfirm(true); }
      else if (e.key === 'Escape') { e.preventDefault(); closeConfirm(false); }
      return;
    }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); setStatus('Autosave is active; use Export to write a video'); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.key === ' ') {
      e.preventDefault();
      if (activeArea === 'edit') {
        if (sequence) toggleOutputPause();
        else playOutputs();
      } else {
        el.btnPlay.click();
      }
    }
  });
}

// ---------- confirm dialog + selection delete ----------
let confirmResolve = null;
function wireConfirm() {
  el.confirmOk.onclick = () => closeConfirm(true);
  el.confirmCancel.onclick = () => closeConfirm(false);
  el.confirm.addEventListener('pointerdown', (e) => { if (e.target === el.confirm) closeConfirm(false); });
}
function askConfirm(message, okLabel = 'Delete', title = 'Confirm Delete') {
  el.confirmTitle.textContent = title;
  el.confirmMsg.textContent = message;
  el.confirmOk.textContent = okLabel;
  el.confirm.hidden = false;
  el.confirmOk.focus();
  return new Promise((res) => { confirmResolve = res; });
}
function closeConfirm(val) {
  if (el.confirm.hidden) return;
  el.confirm.hidden = true;
  const r = confirmResolve; confirmResolve = null;
  if (r) r(val);
}

async function deleteSelected() {
  const sel = store.ui.selection;
  if (!sel.kind) { setStatus('Nothing is selected for deletion'); return; }

  if (sel.kind === 'output') {
    if (await askConfirm('Delete this output clip?')) {
      outSeq.deleteOutput(sel.id);
      setStatus('Output clip deleted');
    }
  } else if (sel.kind === 'material') {
    const deps = store.get().outputs.filter(o => o.materialId === sel.id).length;
    const msg = deps
      ? 'Delete this material? ' + deps + ' output clip(s) using it will also be deleted.'
      : 'Delete this material?';
    if (await askConfirm(msg)) {
      shelf.deleteMaterial(sel.id);
      setStatus('Material deleted');
    }
  }
}

// ---------- export ----------
async function doExport() {
  const settings = prepareExportSettings();
  if (!settings) return;
  showOverlay('Preparing export...');
  try {
    const completed = [];
    for (let i = 0; i < settings.targets.length; i++) {
      const target = settings.targets[i];
      el.overlayMsg.textContent = `Preparing ${target.label} export...`;
      const blob = await exportProject({
        width: target.width,
        height: target.height,
        fps: settings.fps,
        cropMode: target.cropMode,
        onStatus: (m) => el.overlayMsg.textContent = settings.targets.length > 1 ? `${target.label}: ${m}` : m,
        onProgress: (p) => el.overlayProg.value = Math.round(((i + (p || 0)) / settings.targets.length) * 100),
      });
      downloadBlob(blob, target.fileName);
      completed.push(target.fileName);
    }
    setStatus('Export complete: ' + completed.join(', '));
  } finally { hideOverlay(); }
}

function prepareExportSettings() {
  const p = store.get();
  const items = p.outputs.map(o => {
    const m = p.materials.find(x => x.id === o.materialId);
    return m ? { output: o, material: m, source: p.sources.find(s => s.id === m.sourceId) } : null;
  }).filter(it => it?.source);
  if (!items.length) return null;

  const mode = selectExportMode();
  if (!mode) return null;

  const currentName = p.exportName || p.name || 'viralcut';
  const requested = prompt('Export file name', stripMp4(currentName));
  if (requested == null) return null;
  const baseName = sanitizeFileName(stripMp4(requested)) || 'viralcut';
  const sources = [...new Map(items.map(it => [it.source.id, it.source])).values()];
  const fps = resolveExportFps(sources, p.output.fps || 30);
  if (!fps) return null;
  const targets = exportTargets(mode, baseName, sources);

  store.update((project) => {
    project.exportName = baseName;
    project.output = { ...project.output, fps };
  }, { commit: false });

  return { fps, targets };
}

function selectExportMode() {
  const picked = prompt('Export ratio\nType: vertical, horizontal, or both', 'vertical');
  if (picked == null) return null;
  const value = picked.trim().toLowerCase();
  if (['vertical', 'v', '9:16', '916'].includes(value)) return 'vertical';
  if (['horizontal', 'h', '16:9', '169'].includes(value)) return 'horizontal';
  if (['both', 'all'].includes(value)) return 'both';
  alert('Type vertical, horizontal, or both');
  return null;
}

function resolveExportFps(sources, fallback) {
  const values = sources.map(s => Number(s.fps || 0)).filter(v => Number.isFinite(v) && v > 0);
  if (!values.length) return fallback || 30;
  const unique = [];
  for (const fps of values) {
    if (!unique.some(v => Math.abs(v - fps) < 0.01)) unique.push(fps);
  }
  if (unique.length === 1) return unique[0];

  const picked = prompt(
    ['Source frame rates do not match.', 'Enter the FPS to use.', 'Candidates: ' + unique.map(v => Number(v.toFixed(3))).join(', ')].join('\n'),
    String(fallback || unique[0]),
  );
  if (picked == null) return null;
  const fps = Number(picked);
  if (!Number.isFinite(fps) || fps <= 0) {
    alert('FPS must be a positive number');
    return null;
  }
  return fps;
}

function exportTargets(mode, baseName, sources) {
  const vertical = {
    label: 'Vertical 9:16',
    cropMode: 'vertical',
    fileName: (mode === 'both' ? `${baseName}-vertical` : baseName) + '.mp4',
    ...resolveExportSize(sources, 9 / 16),
  };
  const horizontal = {
    label: 'Horizontal 16:9',
    cropMode: 'horizontal',
    fileName: (mode === 'both' ? `${baseName}-horizontal` : baseName) + '.mp4',
    ...resolveExportSize(sources, 16 / 9),
  };
  if (mode === 'horizontal') return [horizontal];
  if (mode === 'both') return [vertical, horizontal];
  return [vertical];
}

function resolveExportSize(sources, aspect) {
  const maxSourceLong = Math.max(0, ...sources.map(s => Math.max(Number(s.width) || 0, Number(s.height) || 0)));
  const longEdge = Math.min(1080, maxSourceLong || 1080);
  if (aspect >= 1) return { width: even(longEdge), height: even(longEdge / aspect) };
  return { width: even(longEdge * aspect), height: even(longEdge) };
}

function stripMp4(name) {
  return String(name || '').replace(/\.mp4$/i, '');
}

function sanitizeFileName(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

function even(v) {
  return Math.max(2, Math.round(v / 2) * 2);
}

// ---------- state -> UI ----------
function onState(project, ui) {
  // source dropdown
  const opts = project.sources.map(s =>
    '<option value="' + s.id + '"' + (s.id === ui.activeSourceId ? ' selected' : '') + '>' + s.fileName + '</option>').join('');
  if (el.sourceSelect.innerHTML !== opts) el.sourceSelect.innerHTML = opts;

  // selection side-effects (run once per selection change)
  const sel = ui.selection;
  const key = sel.kind + ':' + sel.id;
  if (key !== lastSelKey) { lastSelKey = key; applySelection(); }

  bindVideo(ui);

  // reflect crop in sliders (output's crop if selected, else draft)
  const r = store.resolve();
  const crop = (r && r.crop) || ui.crop;
  const sourceCrop = (r && r.material?.sourceCrop) || ui.sourceCrop || { panX: .5, panY: .5, zoom: 1 };
  if (crop) {
    if (document.activeElement !== el.panX) el.panX.value = crop.panX;
    if (document.activeElement !== el.panY) el.panY.value = crop.panY;
    if (document.activeElement !== el.zoom) el.zoom.value = crop.zoom;
    if (document.activeElement !== el.bgBlur) el.bgBlur.value = crop.bgBlur ?? 0;
  }
  if (sourceCrop) {
    if (document.activeElement !== el.sourcePanX) el.sourcePanX.value = sourceCrop.panX;
    if (document.activeElement !== el.sourcePanY) el.sourcePanY.value = sourceCrop.panY;
    if (document.activeElement !== el.sourceZoom) el.sourceZoom.value = sourceCrop.zoom;
    el.srcVideo.style.setProperty('--source-pan-x', sourceCrop.panX);
    el.srcVideo.style.setProperty('--source-pan-y', sourceCrop.panY);
    el.srcVideo.style.setProperty('--source-zoom', sourceCrop.zoom);
  }
  el.vertPane.classList.toggle('crop-editing', !!ui.cropEditActive);
  el.origPane.classList.toggle('crop-editing', !!ui.sourceCropEditActive);
  requestAnimationFrame(() => cropPreview.refresh());

  renderSeekDecor();
  updateChrome();
}

function applySelection() {
  if (store.ui._fromSequence) {
    store.ui._fromSequence = false;
    return;
  }
  const fromTL = store.ui._fromTimeline;
  store.ui._fromTimeline = false;
  const r = store.resolve();
  if (!r || !r.source) return;
  if (r.source.id !== store.ui.activeSourceId) {
    pendingSeek = r.in;
    queueMicrotask(() => store.setUI({ activeSourceId: r.source.id }));
  } else {
    seekTo(r.in);
  }
  // focus the view to the clip only for shelf/output navigation, not timeline clicks
  // (timeline view should change via wheel/right-drag only)
  if (!fromTL && r.material) queueMicrotask(() => srcTimeline.focusMaterial(r.material));
}

function refreshStateViews() {
  store.setUI({ activeSourceId: store.ui.activeSourceId });
}

function bindVideo(ui) {
  const url = fileOpen.urlFor(ui.activeSourceId);
  if (url && url !== activeUrl) {
    activeUrl = url;
    el.srcVideo.src = url;
    el.srcEmpty.hidden = true;
    el.srcVideo.onloadedmetadata = () => {
      if (pendingSeek != null) { seekTo(pendingSeek); pendingSeek = null; }
    };
  } else if (url && pendingSeek != null && el.srcVideo.readyState >= 1) {
    seekTo(pendingSeek); pendingSeek = null;
  } else if (!url) {
    if (activeUrl || el.srcVideo.getAttribute('src')) {
      activeUrl = null;
      el.srcVideo.removeAttribute('src');
      try { el.srcVideo.load(); } catch { /* ignore */ }
    }
    el.srcEmpty.textContent = ui.activeSourceId ? 'Video is no longer available' : 'Add a video to begin';
    el.srcEmpty.hidden = false;
  }
}

function updateChrome() {
  const p = store.get();
  const activeHasCuts = p.materials.some(m => m.sourceId === store.ui.activeSourceId);
  el.btnAddVideo.disabled = false;
  el.btnAddVideo.classList.toggle('need-video', !p.sources.length);
  el.srcPane.classList.toggle('no-cuts', !!p.sources.length && !activeHasCuts);
  el.sourceSelect.disabled = !p.sources.length;
  el.btnExport.disabled = !p.outputs.length;
  el.btnPlayOut.disabled = !p.outputs.length;
  el.btnUndo.disabled = !store.canUndo();
  el.btnRedo.disabled = !store.canRedo();
}

// ---------- helpers ----------
function setStatus(m) { el.status.textContent = m; }
function showOverlay(m) { el.overlayMsg.textContent = m; el.overlayProg.value = 0; el.overlay.hidden = false; }
function hideOverlay() { el.overlay.hidden = true; }
function guard(fn) {
  return async (...a) => {
    try { await fn(...a); }
    catch (err) {
      if (err?.name === 'AbortError') return;
      console.error(err); setStatus('Error: ' + (err?.message || err)); alert(err?.message || err);
    }
  };
}

init();
