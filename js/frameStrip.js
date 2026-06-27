// frameStrip.js - fixed per-frame strip around the current preview frame
import { store } from './store.js?v=20260627-nativepreview3';
import { frameCanvas } from './thumbnails.js?v=20260627-nativepreview3';
import { frameFromTime, frameStartTime, seekVideoFrame } from './util.js?v=20260627-nativepreview3';

const RADIUS = 10;
const SLOT_COUNT = RADIUS * 2 + 1;
const CACHE_LIMIT = 180;

let canvas, ctx, video;
let raf = 0;
let generation = 0;
let lastSignature = '';
let gesture = null;
const cache = new Map(); // key -> HTMLCanvasElement

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function init(canvasEl, videoEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  video = videoEl;

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', scheduleRender);

  for (const ev of ['loadedmetadata', 'timeupdate', 'seeked', 'pause', 'play']) {
    video.addEventListener(ev, scheduleRender);
  }
  store.subscribe(scheduleRender);
  scheduleRender();
}

function activeState() {
  const source = store.activeSource();
  if (!source || !source.duration) return null;
  const fps = source.fps || 30;
  const duration = source.duration || video.duration || 0;
  if (!fps || !duration) return null;
  const totalFrames = Math.max(0, Math.round(duration * fps));
  const currentFrame = frameFromTime(video.currentTime || 0, fps, Math.max(0, totalFrames - 1));
  return { source, fps, duration, totalFrames, currentFrame };
}

function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    render();
  });
}

function ensureSize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round((canvas.clientWidth || 1) * dpr));
  const h = Math.max(1, Math.round((canvas.clientHeight || 1) * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: canvas.clientWidth || 1, h: canvas.clientHeight || 1, dpr };
}

function cacheKey(source, frame) {
  return `${source.mediaKey || source.id}/${frame}`;
}

function cacheGet(key) {
  const v = cache.get(key);
  if (v) { cache.delete(key); cache.set(key, v); }
  return v || null;
}

function cachePut(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function visibleFrames(state) {
  const frames = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    frames.push(state.currentFrame + i - RADIUS);
  }
  return frames;
}

function frameToTime(frame, state) {
  return frameStartTime(clamp(frame, 0, state.totalFrames), state.fps);
}

function materialFrames(m, state) {
  const inFrame = clamp(Math.round(m.in * state.fps), 0, Math.max(0, state.totalFrames - 1));
  const outFrame = clamp(Math.round(m.out * state.fps), inFrame + 1, state.totalFrames);
  return { inFrame, outFrame };
}

function selectedMaterialId() {
  const sel = store.ui.selection;
  if (!sel.kind) return null;
  if (sel.kind === 'material') return sel.id;
  const o = store.getOutput(sel.id);
  return o ? o.materialId : null;
}

function frameAtClientX(clientX, state) {
  const rect = canvas.getBoundingClientRect();
  const slot = clamp(Math.floor((clientX - rect.left) / Math.max(1, rect.width) * SLOT_COUNT), 0, SLOT_COUNT - 1);
  return state.currentFrame + slot - RADIUS;
}

function drawEmpty(w, h, text = 'No linked source') {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0f1116';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#626b78';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
}

function drawCover(src, x, y, w, h) {
  if (!src?.width || !src?.height) return;
  const scale = Math.max(w / src.width, h / src.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = Math.max(0, (src.width - sw) / 2);
  const sy = Math.max(0, (src.height - sh) / 2);
  ctx.drawImage(src, sx, sy, sw, sh, x, y, w, h);
}

function drawSlotBase(frame, state, slot, slotW, h, hasFrame) {
  const x = slot * slotW;
  const inRange = frame >= 0 && frame < state.totalFrames;

  ctx.fillStyle = inRange ? '#07080b' : '#11141a';
  ctx.fillRect(x, 0, slotW, h);

  if (!hasFrame && inRange) {
    ctx.fillStyle = '#151923';
    ctx.fillRect(x + 1, 1, Math.max(1, slotW - 2), h - 2);
  }
  if (!inRange) {
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(x, 0, slotW, h);
  }
}

function drawSlotOverlay(frame, state, slot, slotW, h) {
  const x = slot * slotW;
  const current = slot === RADIUS;
  const inRange = frame >= 0 && frame < state.totalFrames;

  ctx.strokeStyle = current ? '#ffb648' : '#333a46';
  ctx.lineWidth = current ? 2 : 1;
  ctx.strokeRect(x + 0.5, 0.5, Math.max(1, slotW - 1), h - 1);

  ctx.fillStyle = current ? '#ffdf9a' : '#9aa3b2';
  ctx.font = current ? 'bold 11px system-ui, sans-serif' : '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(inRange ? String(frame) : '', x + slotW / 2, h - 4);
}

function drawMaterialBands(state, slotW, h) {
  const firstFrame = state.currentFrame - RADIUS;
  const lastFrame = state.currentFrame + RADIUS;
  const mats = store.get().materials.filter(m => m.sourceId === state.source.id);
  const selectedId = selectedMaterialId();

  for (const m of mats) {
    const { inFrame, outFrame } = materialFrames(m, state);
    if (outFrame <= firstFrame || inFrame > lastFrame) continue;

    const leftFrame = Math.max(inFrame, firstFrame);
    const rightFrame = Math.min(outFrame, lastFrame + 1);
    const x = (leftFrame - firstFrame) * slotW;
    const w = Math.max(2, (rightFrame - leftFrame) * slotW);
    const selected = m.id === selectedId;

    ctx.save();
    ctx.fillStyle = selected ? 'rgba(255, 182, 72, 0.14)' : 'rgba(76, 139, 245, 0.12)';
    ctx.strokeStyle = selected ? '#ffb648' : '#4c8bf5';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.fillRect(x + 1, 2, Math.max(1, w - 2), h - 4);
    ctx.strokeRect(x + 0.5, 1.5, Math.max(1, w - 1), h - 3);

    const handleW = Math.min(7, Math.max(3, slotW * 0.18));
    if (inFrame >= firstFrame && inFrame <= lastFrame) {
      const hx = (inFrame - firstFrame) * slotW;
      ctx.fillStyle = selected ? '#ffb648' : '#4c8bf5';
      ctx.fillRect(hx, 2, handleW, h - 4);
    }
    if (outFrame - 1 >= firstFrame && outFrame - 1 <= lastFrame) {
      const hx = (outFrame - firstFrame) * slotW - handleW;
      ctx.fillStyle = selected ? '#ffb648' : '#4c8bf5';
      ctx.fillRect(hx, 2, handleW, h - 4);
    }
    ctx.restore();
  }
}

function draw(state) {
  const { w, h } = ensureSize();
  if (!state) {
    drawEmpty(w, h);
    return;
  }

  const frames = visibleFrames(state);
  const slotW = w / SLOT_COUNT;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0f1116';
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const key = cacheKey(state.source, frame);
    const cached = cacheGet(key);
    const x = i * slotW;
    drawSlotBase(frame, state, i, slotW, h, !!cached);
    if (cached) {
      drawCover(cached, x + 1, 1, Math.max(1, slotW - 2), h - 2);
    }
  }
  drawMaterialBands(state, slotW, h);
  for (let i = 0; i < frames.length; i++) {
    drawSlotOverlay(frames[i], state, i, slotW, h);
  }
}

function render() {
  const state = activeState();
  draw(state);
  if (!state) return;

  const signature = `${state.source.id}:${state.currentFrame}:${canvas.clientWidth}:${canvas.clientHeight}`;
  if (signature === lastSignature) return;
  lastSignature = signature;
  ensureFrames(state, ++generation);
}

async function ensureFrames(state, gen) {
  const frames = visibleFrames(state);
  const order = [state.currentFrame];
  for (let d = 1; d <= RADIUS; d++) {
    order.push(state.currentFrame + d, state.currentFrame - d);
  }

  for (const frame of order) {
    if (gen !== generation) return;
    if (frame < 0 || frame >= state.totalFrames) continue;
    const key = cacheKey(state.source, frame);
    if (cacheGet(key)) continue;
    try {
      const c = await frameCanvas(state.source, frame, state.fps);
      if (gen !== generation) return;
      cachePut(key, c);
      draw(activeState());
    } catch {
      if (gen !== generation) return;
    }
  }
}

function seekFrame(frame) {
  const state = activeState();
  if (!state) return;
  const f = clamp(frame, 0, Math.max(0, state.totalFrames - 1));
  seekVideoFrame(video, f, state.fps, state.duration);
  scheduleRender();
}

function hitMaterial(frame, state) {
  const mats = store.get().materials.filter(m => m.sourceId === state.source.id);
  const selectedId = selectedMaterialId();
  const ordered = [...mats].sort((a, b) => (a.id === selectedId ? 1 : 0) - (b.id === selectedId ? 1 : 0));
  for (let i = ordered.length - 1; i >= 0; i--) {
    const m = ordered[i];
    const { inFrame, outFrame } = materialFrames(m, state);
    if (frame < inFrame || frame >= outFrame) continue;
    const edge = frame === inFrame ? 'in' : (frame === outFrame - 1 ? 'out' : null);
    return { material: m, inFrame, outFrame, edge };
  }
  return null;
}

function onPointerDown(e) {
  const state = activeState();
  if (!state || e.button !== 0) return;
  const frame = frameAtClientX(e.clientX, state);
  const hit = hitMaterial(frame, state);
  if (hit) {
    e.preventDefault();
    store.ui._fromTimeline = true;
    store.select('material', hit.material.id);
    const length = hit.outFrame - hit.inFrame;
    const edge = hit.edge;
    gesture = {
      type: edge ? 'resize' : 'move',
      id: hit.material.id,
      edge,
      started: false,
      grabFrame: frame - hit.inFrame,
      length,
    };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    seekFrame(edge === 'out' ? hit.outFrame - 1 : frame);
    return;
  }
  gesture = { type: 'seek' };
  seekFrame(frame);
}

function onPointerMove(e) {
  if (!gesture || gesture.type === 'seek') return;
  const state = activeState();
  if (!state) return;
  const m = store.getMaterial(gesture.id);
  if (!m) { gesture = null; return; }
  if (!gesture.started) {
    store.beginAction();
    gesture.started = true;
  }

  const frame = clamp(frameAtClientX(e.clientX, state), 0, Math.max(0, state.totalFrames - 1));
  if (gesture.type === 'move') {
    let inFrame = frame - gesture.grabFrame;
    let outFrame = inFrame + gesture.length;
    if (inFrame < 0) { inFrame = 0; outFrame = gesture.length; }
    if (outFrame > state.totalFrames) {
      outFrame = state.totalFrames;
      inFrame = Math.max(0, outFrame - gesture.length);
    }
    store.updateLive(() => {
      m.in = frameToTime(inFrame, state);
      m.out = frameToTime(outFrame, state);
    });
    seekFrame(inFrame);
  } else if (gesture.type === 'resize') {
    const cur = materialFrames(m, state);
    if (gesture.edge === 'in') {
      const inFrame = clamp(frame, 0, cur.outFrame - 1);
      store.updateLive(() => { m.in = frameToTime(inFrame, state); });
      seekFrame(inFrame);
    } else {
      const outFrame = clamp(frame + 1, cur.inFrame + 1, state.totalFrames);
      store.updateLive(() => { m.out = frameToTime(outFrame, state); });
      seekFrame(outFrame - 1);
    }
  }
  scheduleRender();
}

function onPointerUp(e) {
  if (!gesture) return;
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  gesture = null;
}

function onWheel(e) {
  const state = activeState();
  if (!state) return;
  e.preventDefault();
  seekFrame(state.currentFrame + (e.deltaY > 0 ? 1 : -1));
}
