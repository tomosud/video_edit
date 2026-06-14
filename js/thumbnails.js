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

// get-or-generate a single frame thumbnail URL
export function frameUrl(source, frame, fps) {
  return frameCache.once(source.id, frame, async () => {
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

// Render `count` thumbnails across [win.start, win.end] into `row`.
// token = { cancelled } lets callers abort a stale render.
export async function generateWindow(source, win, row, { fps, token } = {}) {
  fps = fps || source.fps || 30;
  const span = Math.max(0.001, win.end - win.start);
  const count = Math.max(6, Math.round((row.clientWidth || window.innerWidth) / TARGET_SPACING));

  // build skeleton immediately (so widths are stable while frames stream in)
  row.innerHTML = '';
  const cells = [];
  for (let i = 0; i < count; i++) { const c = cell(null); row.appendChild(c); cells.push(c.firstChild); }

  for (let i = 0; i < count; i++) {
    if (token?.cancelled) return;
    const t = win.start + (i + 0.5) / count * span;
    const frame = Math.round(t * fps);
    try {
      const url = await frameUrl(source, frame, fps);
      if (token?.cancelled) return;
      cells[i].src = url;
    } catch { /* skip */ }
  }
}

// single thumbnail for cards (data not cached URL — returns object URL via frameCache)
export async function cardThumb(source, t) {
  const fps = source.fps || 30;
  return frameUrl(source, Math.round(t * fps), fps);
}

export function spacing() { return TARGET_SPACING; }
