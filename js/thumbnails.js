// thumbnails.js - Mediabunny CanvasSink thumbnails, memory-only
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from '../lib/mediabunny.min.js';
import { fileFor } from './fileOpen.js';

const THUMB_H = 132;
const TARGET_SPACING = 200;
const FRAME_CELL_MIN_PX = 22;
const MEM_LIMIT = 700;

const sessions = new Map(); // sourceId -> { file, input, sink, ready, chain, height }
const mem = new Map();      // key -> HTMLCanvasElement (Map order = LRU)
const pending = new Map();  // key -> Promise<HTMLCanvasElement>

const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
const sourceKeyOf = (source) => source.mediaKey || source.id;
const frameKey = (source, frame, height) => `${sourceKeyOf(source)}/f/${frame}/h/${height}`;
const cardKey = (source, frame, width, height) => `${sourceKeyOf(source)}/card/${frame}/${width}x${height}`;

export function cloneCanvas(source) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, source.width || 1);
  c.height = Math.max(1, source.height || 1);
  const ctx = c.getContext('2d');
  if (ctx && source.width && source.height) ctx.drawImage(source, 0, 0);
  return c;
}

function lruGet(key) {
  const v = mem.get(key);
  if (v) { mem.delete(key); mem.set(key, v); }
  return v || null;
}

function lruPut(key, canvas) {
  mem.set(key, canvas);
  while (mem.size > MEM_LIMIT) {
    const oldKey = mem.keys().next().value;
    mem.delete(oldKey);
  }
  return canvas;
}

function disposeSession(entry) {
  try { entry.input?.dispose(); } catch { /* ignore */ }
}

function sessionFor(source, height) {
  const file = fileFor(source.id);
  if (!file) throw new Error('source not linked');

  const existing = sessions.get(source.id);
  if (existing && existing.file === file && existing.height === height) return existing;
  if (existing) disposeSession(existing);

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const ready = (async () => {
    if (!(await input.canRead())) throw new Error('media cannot be read');
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('no video track');
    if (!(await videoTrack.canDecode().catch(() => false))) throw new Error('video track cannot decode');
    return new CanvasSink(videoTrack, { poolSize: 1, height, fit: 'cover' });
  })();
  const entry = { file, input, sink: null, ready, chain: Promise.resolve(), height };
  entry.ready = ready.then((sink) => { entry.sink = sink; return sink; });
  sessions.set(source.id, entry);
  return entry;
}

function queuedCanvas(source, time, height) {
  const entry = sessionFor(source, height);
  const job = entry.chain.catch(() => {}).then(async () => {
    const sink = await entry.ready;
    const duration = source.duration || time;
    const t = Math.max(0, Math.min(time, Math.max(0, duration - 0.001)));
    const wrapped = await sink.getCanvas(t);
    if (!wrapped?.canvas) throw new Error('thumbnail frame unavailable');
    return cloneCanvas(wrapped.canvas);
  });
  entry.chain = job.catch(() => {});
  return job;
}

function coverDraw(sourceCanvas, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx || !sourceCanvas.width || !sourceCanvas.height) return canvas;

  const scale = Math.max(canvas.width / sourceCanvas.width, canvas.height / sourceCanvas.height);
  const sw = canvas.width / scale;
  const sh = canvas.height / scale;
  const sx = Math.max(0, (sourceCanvas.width - sw) / 2);
  const sy = Math.max(0, (sourceCanvas.height - sh) / 2);
  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function once(key, gen) {
  const cached = lruGet(key);
  if (cached) return Promise.resolve(cached);
  if (pending.has(key)) return pending.get(key);
  const p = gen().then((canvas) => lruPut(key, canvas)).finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

export function frameCanvas(source, frame, fps) {
  const height = Math.round(THUMB_H * dpr());
  const key = frameKey(source, frame, height);
  return once(key, () => queuedCanvas(source, frame / fps, height));
}

function cell() {
  const d = document.createElement('div');
  d.className = 'thumb-cell';
  return d;
}

// Render thumbnails across [win.start, win.end] into `row`.
// token = { cancelled } lets callers abort a stale render.
export async function generateWindow(source, win, row, { fps, token } = {}) {
  fps = fps || source.fps || 30;
  const W = row.clientWidth || window.innerWidth;
  const span = Math.max(0.001, win.end - win.start);
  const xOf = (t) => (t - win.start) / span * W;
  const framePx = W / (span * fps);

  row.innerHTML = '';
  const cells = []; // { el, frame }

  if (framePx >= FRAME_CELL_MIN_PX) {
    row.style.display = 'block';
    const f0 = Math.floor(win.start * fps);
    const f1 = Math.ceil(win.end * fps);
    for (let f = f0; f < f1; f++) {
      const left = xOf(f / fps);
      const w = xOf((f + 1) / fps) - left;
      const c = cell();
      c.style.cssText = `position:absolute;left:${left}px;width:${Math.max(1, w)}px;top:0;bottom:0`;
      row.appendChild(c);
      cells.push({ el: c, frame: f });
    }
  } else {
    row.style.display = 'flex';
    const count = Math.max(6, Math.min(400, Math.round(W / TARGET_SPACING)));
    for (let i = 0; i < count; i++) {
      const c = cell();
      row.appendChild(c);
      const t = win.start + (i / count) * span;
      cells.push({ el: c, frame: Math.round(t * fps) });
    }
  }

  for (let i = 0; i < cells.length; i++) {
    if (token?.cancelled) return;
    try {
      const canvas = await frameCanvas(source, cells[i].frame, fps);
      if (token?.cancelled) return;
      cells[i].el.replaceChildren(cloneCanvas(canvas));
    } catch { /* skip */ }
  }
}

export async function cardThumb(source, t, width = 320, height = 180) {
  const fps = source.fps || 30;
  const frame = Math.round(t * fps);
  const key = cardKey(source, frame, width, height);
  return once(key, async () => coverDraw(await frameCanvas(source, frame, fps), width, height));
}

export function spacing() { return TARGET_SPACING; }
