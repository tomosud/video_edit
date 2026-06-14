// thumbnails.js — frame-indexed thumbnails via pooled <video> seeking + frameCache
import * as frameCache from './frameCache.js';
import { urlFor } from './fileOpen.js';

const THUMB_H = 132;             // fixed thumbnail pixel height (cache key is frame index only)
const TARGET_SPACING = 200;      // approx px per thumb — wider (landscape) cells

const pool = new Map();          // sourceId -> { video, ready }

function pooledVideo(source) {
  if (pool.has(source.id)) return pool.get(source.id).ready;
  const url = urlFor(source.id);
  if (!url) return Promise.reject(new Error('source not linked'));
  const video = document.createElement('video');
  video.preload = 'auto'; video.muted = true;
  const ready = new Promise((resolve, reject) => {
    video.onloadeddata = () => resolve(video);
    video.onerror = () => reject(new Error('thumb video load failed'));
    video.src = url;
  });
  pool.set(source.id, { video, ready });
  return ready;
}

function seekDraw(video, t, h) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      const aspect = (video.videoWidth || 16) / (video.videoHeight || 9);
      const w = Math.round(h * aspect);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(video, 0, 0, w, h);
      resolve(c);
    };
    video.addEventListener('seeked', onSeeked);
    const dur = video.duration || t;
    video.currentTime = Math.max(0, Math.min(t, dur - 0.03));
  });
}

const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

// On-disk frame cache is keyed by the media hash (mediaKey) so it persists and
// matches across sessions/re-imports of the same file; falls back to the random
// session id for legacy sources without a mediaKey.
const cacheKeyOf = (source) => source.mediaKey || source.id;

// get-or-generate a single frame thumbnail URL
export function frameUrl(source, frame, fps) {
  return frameCache.once(cacheKeyOf(source), frame, async () => {
    const v = await pooledVideo(source);
    const c = await seekDraw(v, frame / fps, Math.round(THUMB_H * dpr()));
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.72));
  });
}

function cell(url) {
  const d = document.createElement('div');
  d.className = 'thumb-cell';
  const img = document.createElement('img');
  if (url) img.src = url;
  d.appendChild(img);
  return d;
}

// When a single frame is at least this many pixels wide, switch to a
// frame-aligned filmstrip (exactly one cell per frame, cell edges on frame
// boundaries) so clip-band edges line up perfectly with the frames they cut.
const FRAME_CELL_MIN_PX = 22;

// Render thumbnails across [win.start, win.end] into `row`.
// token = { cancelled } lets callers abort a stale render.
export async function generateWindow(source, win, row, { fps, token } = {}) {
  fps = fps || source.fps || 30;
  const W = row.clientWidth || window.innerWidth;
  const span = Math.max(0.001, win.end - win.start);
  const xOf = (t) => (t - win.start) / span * W;     // same mapping as the timeline's timeToX
  const framePx = W / (span * fps);                  // on-screen width of one frame

  row.innerHTML = '';
  const cells = [];   // { img, frame }

  if (framePx >= FRAME_CELL_MIN_PX) {
    // ---- frame-aligned mode (zoomed in) ----
    // one absolutely-positioned cell per frame; left/width derived from the exact
    // frame-boundary times, so band edges (snapped to k/fps) sit on cell borders.
    row.style.display = 'block';
    const f0 = Math.floor(win.start * fps);
    const f1 = Math.ceil(win.end * fps);
    for (let f = f0; f < f1; f++) {
      const left = xOf(f / fps);
      const w = xOf((f + 1) / fps) - left;
      const c = document.createElement('div');
      c.className = 'thumb-cell';
      c.style.cssText = `position:absolute;left:${left}px;width:${Math.max(1, w)}px;top:0;bottom:0`;
      const img = document.createElement('img');
      c.appendChild(img);
      row.appendChild(c);
      cells.push({ img, frame: f });
    }
  } else {
    // ---- sampled mode (zoomed out) ----
    // evenly spaced cells; exact frame alignment isn't perceptible at this zoom.
    row.style.display = 'flex';
    const count = Math.max(6, Math.min(400, Math.round(W / TARGET_SPACING)));
    for (let i = 0; i < count; i++) {
      const c = cell(null);
      row.appendChild(c);
      const t = win.start + (i / count) * span;
      cells.push({ img: c.firstChild, frame: Math.round(t * fps) });
    }
  }

  for (let i = 0; i < cells.length; i++) {
    if (token?.cancelled) return;
    try {
      const url = await frameUrl(source, cells[i].frame, fps);
      if (token?.cancelled) return;
      cells[i].img.src = url;
    } catch { /* skip */ }
  }
}

// single thumbnail for cards (data not cached URL — returns object URL via frameCache)
export async function cardThumb(source, t) {
  const fps = source.fps || 30;
  return frameUrl(source, Math.round(t * fps), fps);
}

export function spacing() { return TARGET_SPACING; }
