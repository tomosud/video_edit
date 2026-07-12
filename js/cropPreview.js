// cropPreview.js - 9:16 canvas preview of the active source with crop/pan/zoom
import { store } from './store.js';
import { previewCaptionText, captionOutputId, drawCaption } from './captions.js';
import { drawVerticalFrame } from './drawing.js';

let canvas, ctx, video;
let raf = 0;
let previewMode = () => 'source';

export function init(canvasEl, videoEl, hooks = {}) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  video = videoEl;
  previewMode = typeof hooks.previewMode === 'function' ? hooks.previewMode : () => 'source';
  resize();
  window.addEventListener('resize', () => { resize(); draw(); });

  // animate only while playing; otherwise redraw on-demand (keeps renderer idle)
  video.addEventListener('play', startLoop);
  video.addEventListener('pause', stopLoop);
  video.addEventListener('ended', stopLoop);
  video.addEventListener('seeked', draw);
  video.addEventListener('loadeddata', draw);
  store.subscribe(draw);   // crop/selection changes
  draw();
}

export function refresh() {
  resize();
  draw();
}

function resize() {
  // 9:16, fit to the preview box without leaving a wide unused column.
  const wrap = canvas.parentElement;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const maxH = Math.max(1, wrap.clientHeight);
  const maxW = Math.max(1, wrap.clientWidth);
  let h = maxH;
  let w = h * 9 / 16;
  if (w > maxW) {
    w = maxW;
    h = w * 16 / 9;
  }
  canvas.style.height = h + 'px';
  canvas.style.width = w + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

// crop config: selected output's crop if any, else the UI draft crop
function currentCrop() {
  if (previewMode() === 'source') return { panX: 0.5, panY: 0.5, zoom: 1, bgBlur: 1 };
  const r = store.resolve() || resolveSelectedCaption();
  return (r && r.crop) || store.ui.crop || { panX: 0.5, panY: 0.5, zoom: 1, bgBlur: 1 };
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

  drawVerticalFrame(ctx, video, W, H, currentCrop());
  const text = previewMode() === 'source' ? '' : previewCaptionText(store.get(), store.ui, video.currentTime);
  if (text) drawCaption(ctx, W, H, text);
}

function loop() {
  draw();
  raf = requestAnimationFrame(loop);
}

function startLoop() { if (!raf) loop(); }
function stopLoop() { cancelAnimationFrame(raf); raf = 0; draw(); }
