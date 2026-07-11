// cropPreview.js - 9:16 canvas preview of the active source with crop/pan/zoom
import { store } from './store.js?v=20260707-horizontal-crop';
import { activeCaptionText as captionTextForSequence, captionAbsolute, captionTextAt, drawCaption } from './captions.js?v=20260711-caption-input-preview-inset';

let canvas, ctx, video;
let raf = 0;

export function init(canvasEl, videoEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  video = videoEl;
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
  const r = store.resolve() || resolveSelectedCaption();
  return (r && r.crop) || store.ui.crop || { panX: 0.5, panY: 0.5, zoom: 1, bgBlur: 1 };
}

function draw() {
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!video || video.readyState < 2 || !video.videoWidth) return;

  drawCropped(ctx, video, W, H, currentCrop());
  drawActiveCaption(ctx, W, H);
}

export function drawFrame(sourceCanvas, crop = currentCrop()) {
  if (!ctx || !sourceCanvas) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  drawCropped(ctx, sourceCanvas, W, H, crop);
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
      const atMs = sequenceMs + localMs;
      return selectedCaptionTextAt(p, atMs) || captionTextForSequence(p, atMs);
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

function selectedCaptionTextAt(project, sequenceMs) {
  const id = store.ui.selectedCaptionId;
  if (!id) return '';
  let startMs = 0;
  for (const output of project.outputs) {
    const material = project.materials.find(m => m.id === output.materialId);
    if (!material) continue;
    const durationMs = Math.max(250, Math.round(Math.max(0, material.out - material.in) * 1000));
    const caption = (output.captions || []).find(c => c.id === id);
    if (caption) {
      const abs = captionAbsolute(caption, startMs, material);
      const primary = captionTextAt(abs, sequenceMs, 'text');
      const secondary = captionTextAt(abs, sequenceMs, 'secondaryText');
      return primary || secondary ? { primary, secondary } : '';
    }
    startMs += durationMs;
  }
  return '';
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
  const targetAspect = W / H;
  const sourceAspect = vw / vh;

  let baseW, baseH;
  if (sourceAspect > targetAspect) {
    baseH = vh;
    baseW = vh * targetAspect;
  } else {
    baseW = vw;
    baseH = vw / targetAspect;
  }
  const cropW = baseW / zoom;
  const cropH = baseH / zoom;
  const sx = (vw - cropW) * panX;
  const sy = (vh - cropH) * panY;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (sx < 0 || sy < 0 || sx + cropW > vw || sy + cropH > vh) {
    drawBlurBackground(ctx, source, W, H, Math.max(0, Math.min(1, bgBlur)));
  }

  const vx = Math.max(0, sx);
  const vy = Math.max(0, sy);
  const vx2 = Math.min(vw, sx + cropW);
  const vy2 = Math.min(vh, sy + cropH);
  const sw = vx2 - vx;
  const sh = vy2 - vy;
  if (sw <= 0 || sh <= 0) return;

  const dx = (vx - sx) / cropW * W;
  const dy = (vy - sy) / cropH * H;
  const dw = sw / cropW * W;
  const dh = sh / cropH * H;
  ctx.drawImage(source, vx, vy, sw, sh, dx, dy, dw, dh);
}

function loop() {
  draw();
  raf = requestAnimationFrame(loop);
}

function startLoop() { if (!raf) loop(); }
function stopLoop() { cancelAnimationFrame(raf); raf = 0; draw(); }

export function stop() { stopLoop(); }

