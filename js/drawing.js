// drawing.js - shared crop drawing for previews, thumbnails, and export.
// Preview and export must render identically; keep every crop model here
// instead of copying it per module.

export function sourceSize(source) {
  return {
    w: source?.videoWidth || source?.width || 0,
    h: source?.videoHeight || source?.height || 0,
  };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function drawBlurBackground(ctx, source, W, H, amount, blurPx = 24) {
  if (amount <= 0) return;
  const { w: vw, h: vh } = sourceSize(source);
  if (!vw || !vh) return;
  const scale = Math.max(W / vw, H / vh) * 1.08;
  const dw = vw * scale, dh = vh * scale;
  ctx.save();
  ctx.globalAlpha = clamp01(amount);
  ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}

// Vertical (9:16) crop model: aspect-fit base rect, zoom shrinks the sampled
// region, pan slides it; blur background appears only when the sample rect
// overflows the source.
export function drawVerticalFrame(ctx, source, W, H, crop) {
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
    drawBlurBackground(ctx, source, W, H, clamp01(bgBlur));
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

// Horizontal (16:9) crop model: height-fit placement at zoom 1 regardless of
// source aspect, blur background always allowed.
export function drawHorizontalFrame(ctx, source, W, H, crop, { blurPx = 24 } = {}) {
  const { w: vw, h: vh } = sourceSize(source);
  if (!vw || !vh) return;
  const { panX = 0.5, panY = 0.5, zoom = 1, bgBlur = 1 } = crop || {};

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  drawBlurBackground(ctx, source, W, H, clamp01(bgBlur), blurPx);

  const scale = (H / vh) * Math.max(0.001, zoom);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = dw <= W ? (W - dw) * panX : -(dw - W) * panX;
  const dy = dh <= H ? (H - dh) * panY : -(dh - H) * panY;
  ctx.drawImage(source, dx, dy, dw, dh);
}
