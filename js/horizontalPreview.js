// horizontalPreview.js - 16:9 canvas preview with crop/pan/zoom/blur.
import { store } from './store.js?v=20260707-horizontal-crop';
import { activeCaptionText as captionTextForSequence, drawCaption } from './captions.js?v=20260711-caption-edit-preview';

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

function sourceSize(source) {
  return {
    w: source?.videoWidth || source?.width || 0,
    h: source?.videoHeight || source?.height || 0,
  };
}

function drawBlurBackground(ctx, source, W, H, amount) {
  if (amount <= 0) return;
  const { w: vw, h: vh } = sourceSize(source);
  if (!vw || !vh) return;
  const scale = Math.max(W / vw, H / vh) * 1.08;
  const dw = vw * scale, dh = vh * scale;
  ctx.save();
  ctx.globalAlpha = amount;
  ctx.filter = 'blur(24px)';
  ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

function drawCropped(ctx, source, W, H, crop) {
  const { w: vw, h: vh } = sourceSize(source);
  if (!vw || !vh) return;
  const { panX = 0.5, panY = 0.5, zoom = 1, bgBlur = 1 } = crop || {};

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  drawBlurBackground(ctx, source, W, H, Math.max(0, Math.min(1, bgBlur)));

  const scale = (H / vh) * Math.max(0.001, zoom);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = dw <= W ? (W - dw) * panX : -(dw - W) * panX;
  const dy = dh <= H ? (H - dh) * panY : -(dh - H) * panY;
  ctx.drawImage(source, dx, dy, dw, dh);
}

function draw() {
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!video || video.readyState < 2 || !video.videoWidth) return;
  drawCropped(ctx, video, W, H, currentCrop());
  drawActiveCaption(ctx, W, H);
}

function drawActiveCaption(ctx, W, H) {
  const text = currentCaptionText();
  if (text) drawCaption(ctx, W, H, text);
}

function currentCaptionText() {
  const selected = selectedOutputForCaption() || store.ui.selection.id;
  if (!selected) return '';
  const p = store.get();
  let sequenceMs = 0;
  for (const output of p.outputs) {
    const material = p.materials.find(m => m.id === output.materialId);
    if (!material) continue;
    const durationMs = Math.max(250, Math.round(Math.max(0, material.out - material.in) * 1000));
    if (output.id === selected) {
      const localMs = Math.round(Math.max(0, ((video?.currentTime || material.in) - material.in) * 1000));
      return captionTextForSequence(p, sequenceMs + localMs);
    }
    sequenceMs += durationMs;
  }
  return '';
}

function selectedOutputForCaption() {
  const id = store.ui.selectedCaptionId;
  if (!id) return null;
  return store.get().outputs.find(output => (output.captions || []).some(c => c.id === id))?.id || null;
}

function resolveSelectedCaption() {
  const outputId = selectedOutputForCaption();
  return outputId ? store.resolve({ kind: 'output', id: outputId }) : null;
}

function loop() {
  draw();
  raf = requestAnimationFrame(loop);
}

function startLoop() { if (!raf) loop(); }
function stopLoop() { cancelAnimationFrame(raf); raf = 0; draw(); }
