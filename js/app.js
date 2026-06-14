// app.js — entry: wire modules, selection side-effects, ranged playback, persistence
import { store } from './store.js';
import * as projectStore from './projectStore.js';
import * as fileOpen from './fileOpen.js';
import * as cropPreview from './cropPreview.js';
import * as srcTimeline from './sourceTimeline.js';
import * as shelf from './materialShelf.js';
import * as outSeq from './outputSequence.js';
import { exportProject, downloadBlob } from './export.js';
import { fmtTime, makeScrubber } from './util.js';

const $ = (id) => document.getElementById(id);
const el = {};
['btnNewProject','btnOpenProject','btnAddVideo','sourceSelect','btnUndo','btnRedo',
 'btnExport','status','srcVideo','srcEmpty','origTime','btnPlay','btnLoop','vertCanvas',
 'panX','panY','zoom','overlay','overlayMsg','overlayProg',
 'confirm','confirmTitle','confirmMsg','confirmOk','confirmCancel',
 'tlScroll','tlInner','thumbRow','clipBands','tlPlayhead','srcRange',
 'tlOverview','ovClips','ovWindow','ovPlayhead',
 'seekBar','seekMarks','seekRange','seekFill','seekHead','frameInfo',
 'shelf','shelfCount','outList','totalDur','btnPlayOut','btnStopOut'].forEach(id => el[id] = $(id));

let projectOpen = false;
let activeUrl = null;
let pendingSeek = null;
let lastSelKey = '';
let loopEnabled = true;
let sequence = null;   // { items:[{sourceId,in,out}], i } during 連続再生
let transportRaf = 0;
let projectSaveTimer = 0;
let sequenceAdvancing = false;

function init() {
  cropPreview.init(el.vertCanvas, el.srcVideo);
  srcTimeline.init({
    scroll: el.tlScroll, inner: el.tlInner, thumbRow: el.thumbRow,
    bands: el.clipBands, playhead: el.tlPlayhead, range: el.srcRange,
    overview: el.tlOverview, ovClips: el.ovClips, ovWindow: el.ovWindow, ovPlayhead: el.ovPlayhead,
  }, el.srcVideo);
  shelf.init({ shelf: el.shelf, count: el.shelfCount }, { play: playRange });
  outSeq.init({ list: el.outList, total: el.totalDur }, { play: playRange });
  srcTimeline.onPlayRange(playRange);

  wireMenu(); wireTransport(); wireCrop(); wireShortcuts(); wireSeek(); wireConfirm();
  store.subscribe(onState);

  bootstrap();
}

async function bootstrap() {
  try {
    const re = await projectStore.reattach();
    if (re) {
      projectOpen = true;
      if (re.project) store.load(re.project);
      await fileOpen.relinkAll();
    }
  } catch { /* ignore */ }
  if (!projectOpen) await store.restore();
  updateChrome();
}

// ---------- menu ----------
function wireMenu() {
  el.btnNewProject.onclick = guard(async () => {
    const name = await projectStore.newProject();
    projectOpen = true; store.load({ name });
    setStatus('新規プロジェクト: ' + name);
  });
  el.btnOpenProject.onclick = guard(async () => {
    const { name, project } = await projectStore.openProject();
    projectOpen = true;
    if (project) {
      store.load(project);
      const missing = await fileOpen.relinkAll();
      setStatus(missing.length ? `${name}（未リンク ${missing.length}）` : '開いた: ' + name);
    } else { store.load({ name }); setStatus('空フォルダ→新規: ' + name); }
  });
  el.btnAddVideo.onclick = guard(async () => {
    el.btnAddVideo.disabled = true;
    try { await fileOpen.addVideo(); }
    finally { updateChrome(); }
  });
  el.btnUndo.onclick = () => store.undo();
  el.btnRedo.onclick = () => store.redo();
  el.btnExport.onclick = guard(doExport);
  el.sourceSelect.onchange = () => store.setUI({ activeSourceId: el.sourceSelect.value });
}

// ---------- transport / ranged playback ----------
function wireTransport() {
  el.btnPlay.onclick = () => { if (el.srcVideo.paused) el.srcVideo.play(); else el.srcVideo.pause(); };
  el.btnLoop.onclick = () => { loopEnabled = !loopEnabled; el.btnLoop.style.color = loopEnabled ? 'var(--accent)' : ''; };
  el.srcVideo.addEventListener('play', () => el.btnPlay.textContent = '⏸');
  el.srcVideo.addEventListener('pause', () => el.btnPlay.textContent = '▶');
  el.srcVideo.addEventListener('play', startTransportMonitor);
  el.srcVideo.addEventListener('pause', stopTransportMonitor);
  el.srcVideo.addEventListener('ended', stopTransportMonitor);
  el.srcVideo.addEventListener('timeupdate', () => {
    el.origTime.textContent = `${fmtTime(el.srcVideo.currentTime)} / ${fmtTime(el.srcVideo.duration)}`;
  });
  el.btnLoop.style.color = 'var(--accent)';

  el.btnPlayOut.onclick = playOutputs;
  el.btnStopOut.onclick = stopSequence;
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

function endGuard() {
  return Math.min(0.03, frameDur() * 0.75);
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
    if (it && !sequenceAdvancing && el.srcVideo.currentTime >= it.out - endGuard()) advanceSequence();
    return;
  }

  const r = store.ui.playRange;
  if (!r) return;
  if (el.srcVideo.currentTime < r.end - endGuard()) return;

  if (loopEnabled) {
    el.srcVideo.currentTime = r.start;
  } else {
    el.srcVideo.pause();
    try { el.srcVideo.currentTime = Math.max(r.start, r.end - frameDur()); } catch { /* ignore */ }
  }
}

// ---- sequential playback of the output sequence ----
function playOutputs() {
  const p = store.get();
  const items = p.outputs.map(o => {
    const m = store.getMaterial(o.materialId);
    return m ? { outputId: o.id, materialId: m.id, sourceId: m.sourceId, in: m.in, out: m.out } : null;
  }).filter(Boolean);
  if (!items.length) return;
  store.ui.playRange = null;
  sequence = { items, i: 0 };
  sequenceAdvancing = false;
  el.btnStopOut.disabled = false;
  playSequenceItem();
}

function playSequenceItem() {
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
  if (sequence.i >= sequence.items.length) { stopSequence(); el.srcVideo.pause(); return; }
  playSequenceItem();
}

function stopSequence() {
  sequence = null;
  sequenceAdvancing = false;
  el.btnStopOut.disabled = true;
}

function ensureSource(sourceId, cb) {
  if (store.ui.activeSourceId === sourceId && el.srcVideo.readyState >= 1) { cb(); return; }
  if (store.ui.activeSourceId !== sourceId) store.setUI({ activeSourceId: sourceId });
  el.srcVideo.addEventListener('loadeddata', cb, { once: true });
}

function seekTo(t, cb) {
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
        if (Math.abs(el.srcVideo.currentTime - t) < 1e-4 && !el.srcVideo.seeking) finish();
      });
    }
    try { el.srcVideo.currentTime = t; } catch { finish(); }
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
    seekScrub(tAt(e.clientX)); updateSeek();
  });
  bar.addEventListener('pointermove', (e) => { if (dragging) { seekScrub(tAt(e.clientX)); updateSeek(e.clientX); } });
  bar.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    try { bar.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    try { el.srcVideo.currentTime = tAt(e.clientX); } catch { /* ignore */ }
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
  if (!fps || !el.srcVideo.duration) { el.frameInfo.textContent = '—'; return; }
  const frameDur = 1 / fps;
  const frame = Math.round(el.srcVideo.currentTime * fps);
  const totalFrames = Math.round((el.srcVideo.duration || 0) * fps);
  el.frameInfo.textContent = `${fps}fps · 1コマ ${frameDur.toFixed(3)}s · #${frame}/${totalFrames}`;
}

function renderSeekDecor() {
  const d = el.srcVideo.duration || store.activeSource()?.duration || 0;
  if (!d) { el.seekMarks.innerHTML = ''; el.seekRange.style.display = 'none'; return; }
  const sid = store.ui.activeSourceId;
  const mats = store.get().materials.filter(m => m.sourceId === sid);
  el.seekMarks.innerHTML = mats.map(m => {
    const l = m.in / d * 100, w = Math.max(0.3, (m.out - m.in) / d * 100);
    return `<span style="left:${l}%;width:${w}%"></span>`;
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
  const start = () => { if (store.resolve()?.material) store.beginAction(); };
  const apply = () => {
    const crop = { panX: +el.panX.value, panY: +el.panY.value, zoom: +el.zoom.value };
    const r = store.resolve();
    if (r?.material) {
      store.updateLive(() => { r.material.crop = crop; });
    } else {
      store.setUI({ crop });
    }
  };
  for (const s of [el.panX, el.panY, el.zoom]) {
    s.addEventListener('pointerdown', start);
    s.addEventListener('input', apply);
  }
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
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProjectNow(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.key === ' ') { e.preventDefault(); el.btnPlay.click(); }
  });
}

// ---------- confirm dialog + selection delete ----------
let confirmResolve = null;
function wireConfirm() {
  el.confirmOk.onclick = () => closeConfirm(true);
  el.confirmCancel.onclick = () => closeConfirm(false);
  el.confirm.addEventListener('pointerdown', (e) => { if (e.target === el.confirm) closeConfirm(false); });
}
function askConfirm(message, okLabel = '削除') {
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
  if (!sel.kind) { setStatus('削除対象が選択されていません'); return; }

  if (sel.kind === 'output') {
    // deleting an output removes only this instance; the cutout material stays
    if (await askConfirm('この出力クリップを削除しますか？\n（元の切り出し素材はそのまま残ります）')) {
      outSeq.deleteOutput(sel.id);
      setStatus('出力クリップを削除しました');
    }
  } else if (sel.kind === 'material') {
    // deleting a material also removes every output built from it
    const deps = store.get().outputs.filter(o => o.materialId === sel.id).length;
    const msg = deps
      ? `この切り出し素材を削除しますか？\nこの素材を使う出力クリップ ${deps} 個も一緒に削除されます。`
      : 'この切り出し素材を削除しますか？';
    if (await askConfirm(msg)) {
      shelf.deleteMaterial(sel.id);
      setStatus('切り出し素材を削除しました');
    }
  }
}

// ---------- export ----------
async function doExport() {
  showOverlay('書き出し準備中…');
  try {
    const blob = await exportProject({
      onStatus: (m) => el.overlayMsg.textContent = m,
      onProgress: (p) => el.overlayProg.value = Math.round((p || 0) * 100),
      onLog: (m) => console.debug('[ffmpeg]', m),
    });
    downloadBlob(blob, (store.get().name || 'viralcut') + '.mp4');
    setStatus('書き出し完了');
  } finally { hideOverlay(); }
}

// ---------- state -> UI ----------
function onState(project, ui) {
  // source dropdown
  const opts = project.sources.map(s =>
    `<option value="${s.id}"${s.id === ui.activeSourceId ? ' selected' : ''}>${s.fileName}</option>`).join('');
  if (el.sourceSelect.innerHTML !== opts) el.sourceSelect.innerHTML = opts;

  // selection side-effects (run once per selection change)
  const sel = ui.selection;
  const key = sel.kind + ':' + sel.id;
  if (key !== lastSelKey) { lastSelKey = key; applySelection(); }

  bindVideo(ui);

  // reflect crop in sliders (output's crop if selected, else draft)
  const r = store.resolve();
  const crop = (r && r.crop) || ui.crop;
  if (crop) {
    if (document.activeElement !== el.panX) el.panX.value = crop.panX;
    if (document.activeElement !== el.panY) el.panY.value = crop.panY;
    if (document.activeElement !== el.zoom) el.zoom.value = crop.zoom;
  }

  renderSeekDecor();
  scheduleProjectSave();
  updateChrome();
}

function scheduleProjectSave() {
  if (!projectOpen || !projectStore.dirHandle()) return;
  clearTimeout(projectSaveTimer);
  projectSaveTimer = setTimeout(saveProjectNow, 700);
}

async function saveProjectNow() {
  if (!projectOpen || !projectStore.dirHandle()) return;
  clearTimeout(projectSaveTimer);
  projectSaveTimer = 0;
  try {
    const ts = await projectStore.save(store.get());
    setStatus('自動保存 ' + new Date(ts).toLocaleTimeString());
  } catch (err) {
    console.warn('auto save failed', err);
    setStatus('自動保存エラー: ' + (err?.message || err));
  }
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

function bindVideo(ui) {
  const url = fileOpen.urlFor(ui.activeSourceId);
  if (url && url !== activeUrl) {
    activeUrl = url;
    el.srcVideo.src = url;
    el.srcEmpty.hidden = true;
    el.srcVideo.onloadedmetadata = () => {
      if (pendingSeek != null) { el.srcVideo.currentTime = pendingSeek; pendingSeek = null; }
    };
  } else if (url && pendingSeek != null && el.srcVideo.readyState >= 1) {
    el.srcVideo.currentTime = pendingSeek; pendingSeek = null;
  } else if (!url) {
    el.srcEmpty.hidden = ui.activeSourceId != null;
  }
}

function updateChrome() {
  const p = store.get();
  el.btnAddVideo.disabled = !projectOpen;
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
      console.error(err); setStatus('エラー: ' + (err?.message || err)); alert(err?.message || err);
    }
  };
}

init();
