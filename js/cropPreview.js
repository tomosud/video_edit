// cropPreview.js — 9:16 canvas preview of the active source with crop/pan/zoom
import { store } from './store.js';

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

function resize() {
  // 9:16, sized to available height
  const wrap = canvas.parentElement;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const h = wrap.clientHeight;
  const w = h * 9 / 16;
  canvas.style.height = h + 'px';
  canvas.style.width = w + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

// crop config: selected output's crop if any, else the UI draft crop
function currentCrop() {
  const r = store.resolve();
  return (r && r.crop) || store.ui.crop || { panX: 0.5, panY: 0.5, zoom: 1 };
}

function draw() {
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!video || video.readyState < 2 || !video.videoWidth) return;

  const vw = video.videoWidth, vh = video.videoHeight;
  const { panX, panY, zoom } = currentCrop();

  // target aspect 9:16; choose source crop rect that fills the 9:16 frame
  const targetAspect = 9 / 16;
  // crop rect in source space, scaled by zoom (zoom>1 = tighter crop)
  let cropH = vh / zoom;
  let cropW = cropH * targetAspect;
  if (cropW > vw) { cropW = vw / zoom; cropH = cropW / targetAspect; }

  const maxX = vw - cropW;
  const maxY = vh - cropH;
  const sx = maxX * panX;
  const sy = maxY * panY;

  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, W, H);
}

function loop() {
  draw();
  raf = requestAnimationFrame(loop);
}

function startLoop() { if (!raf) loop(); }
function stopLoop() { cancelAnimationFrame(raf); raf = 0; draw(); }

export function stop() { stopLoop(); }
