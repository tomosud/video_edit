// horizontalPreview.js - 16:9 canvas preview with crop/pan/zoom/blur.
import { store } from './store.js';
import { previewCaptionText, captionOutputId, drawCaption } from './captions.js';
import { drawHorizontalFrame } from './drawing.js';

let canvas, ctx, video;
let raf = 0;

export function init(canvasEl, videoEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  video = videoEl;
  resize();
  window.addEventListener('resize', () => { resize(); draw(); });
  video.addEventListener('play', startLoop);
  video.addEventListener('pause', stopLoop);
  video.addEventListener('ended', stopLoop);
  video.addEventListener('seeked', draw);
  video.addEventListener('loadeddata', draw);
  store.subscribe(draw);
  draw();
}

export function refresh() {
  resize();
  draw();
}

function resize() {
  const wrap = canvas.parentElement;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const maxH = Math.max(1, wrap.clientHeight);
  const maxW = Math.max(1, wrap.clientWidth);
  let w = maxW;
  let h = w * 9 / 16;
  if (h > maxH) {
    h = maxH;
    w = h * 16 / 9;
  }
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

function currentCrop() {
  const r = store.resolve() || resolveSelectedCaption();
  return r?.material?.horizontalCrop || store.ui.horizontalCrop || { panX: 0.5, panY: 0.5, zoom: 1, bgBlur: 1 };
}

function resolveSelectedCaption() {
  const outputId = captionOutputId(store.get(), store.ui.selectedCaptionId);
  return outputId ? store.resolve({ kind: 'output', id: outputId }) : null;
}

function draw() {
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!video || video.readyState < 2 || !video.videoWidth) return;
  drawHorizontalFrame(ctx, video, W, H, currentCrop());
  const text = previewCaptionText(store.get(), store.ui, video.currentTime);
  if (text) drawCaption(ctx, W, H, text);
}

function loop() {
  draw();
  raf = requestAnimationFrame(loop);
}

function startLoop() { if (!raf) loop(); }
function stopLoop() { cancelAnimationFrame(raf); raf = 0; draw(); }
