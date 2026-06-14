// thumbnails.js — source thumbnail strip via <video> seeking (+ IndexedDB cache)
import * as db from './db.js';
import { urlFor } from './fileOpen.js';

const THUMB_H = 120;            // base thumbnail height (px), scaled by DPR for crispness
const TARGET_SPACING = 96;      // approx px between thumbs at zoom=1

// seek a video to t and draw a thumbnail to an offscreen canvas -> blob
function seekDraw(video, t, w, h) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(video, 0, 0, w, h);
      resolve(c);
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = Math.min(t, Math.max(0, (video.duration || t) - 0.05));
  });
}

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'auto'; v.muted = true; v.crossOrigin = 'anonymous';
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error('thumbnail video load failed'));
    v.src = url;
  });
}

// Generate `count` thumbnails across the duration. Renders into `row` element.
// onProgress(0..1) optional.
export async function generateStrip(source, row, { count, onProgress } = {}) {
  row.innerHTML = '';
  const url = urlFor(source.id);
  if (!url) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const h = Math.round(THUMB_H * dpr);

  const video = await loadVideo(url);
  const aspect = (video.videoWidth || 16) / (video.videoHeight || 9);
  const w = Math.round(h * aspect);
  const n = count || Math.max(8, Math.round(window.innerWidth / TARGET_SPACING));

  const cacheKey = `${source.fileName}:${source.size}:${n}`;
  const cached = await db.get('thumbs', cacheKey);
  if (cached) {
    renderCached(row, cached);
    return;
  }

  const blobs = [];
  for (let i = 0; i < n; i++) {
    const t = (source.duration || video.duration) * (i + 0.5) / n;
    const c = await seekDraw(video, t, w, h);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.7));
    blobs.push(blob);
    appendThumb(row, c);
    onProgress?.((i + 1) / n);
  }
  db.set('thumbs', cacheKey, { blobs, w, h, dpr }).catch(() => {});
}

function cell(child) {
  const d = document.createElement('div');
  d.className = 'thumb-cell';
  d.appendChild(child);
  return d;
}

function appendThumb(row, canvas) {
  row.appendChild(cell(canvas));
}

function renderCached(row, { blobs }) {
  for (const blob of blobs) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    row.appendChild(cell(img));
  }
}

// Single thumbnail (for clip cards) -> dataURL
export async function singleThumb(source, t, h = 96) {
  const url = urlFor(source.id);
  if (!url) return null;
  const video = await loadVideo(url);
  const aspect = (video.videoWidth || 16) / (video.videoHeight || 9);
  const w = Math.round(h * aspect);
  const c = await seekDraw(video, t, w, h);
  return c.toDataURL('image/jpeg', 0.7);
}
