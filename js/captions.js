// captions.js - shared caption timing, density, and canvas drawing helpers

export const MIN_CAPTION_MS = 250;

export function defaultCaption(startMs = 0, endMs = startMs + 1000) {
  return {
    text: '',
    startMs: Math.max(0, Math.round(startMs || 0)),
    endMs: Math.max(Math.round(startMs || 0) + MIN_CAPTION_MS, Math.round(endMs || 0)),
  };
}

export function captionAbsolute(caption, clipStartMs = 0, material = null) {
  if (!caption) return null;
  if (Number.isFinite(+caption.startMs) && Number.isFinite(+caption.endMs)) {
    return normalizeCaption(caption, caption.startMs, caption.endMs);
  }
  const materialInMs = Math.round(Math.max(0, +(material?.in || 0)) * 1000);
  const materialOutMs = Number.isFinite(+material?.out)
    ? Math.round(Math.max(0, +material.out) * 1000)
    : null;
  if (Number.isFinite(+caption.sourceAnchorMs) || Number.isFinite(+caption.anchorOffsetMs)) {
    let localAnchorMs = Number.isFinite(+caption.sourceAnchorMs)
      ? Math.round(+caption.sourceAnchorMs - materialInMs)
      : Math.round(+caption.anchorOffsetMs || 0);
    if (materialOutMs != null) localAnchorMs = Math.max(0, Math.min(Math.max(0, materialOutMs - materialInMs), localAnchorMs));
    const anchorMs = Math.round(clipStartMs + localAnchorMs);
    const startOffsetMs = Number.isFinite(+caption.startOffsetMs) ? Math.round(+caption.startOffsetMs) : -500;
    const endOffsetMs = Number.isFinite(+caption.endOffsetMs) ? Math.round(+caption.endOffsetMs) : 1500;
    return {
      ...caption,
      anchorMs,
      startMs: anchorMs + startOffsetMs,
      endMs: Math.max(anchorMs + startOffsetMs + MIN_CAPTION_MS, anchorMs + endOffsetMs),
    };
  }
  return normalizeCaption(caption, caption.startMs, caption.endMs);
}

export function normalizeCaption(caption, startMs = 0, endMs = startMs + 1000) {
  if (!caption) return null;
  const fallback = defaultCaption(startMs, endMs);
  const a = Number.isFinite(+caption.startMs) ? Math.round(+caption.startMs) : fallback.startMs;
  const b = Number.isFinite(+caption.endMs) ? Math.round(+caption.endMs) : fallback.endMs;
  return {
    text: String(caption.text || ''),
    startMs: Math.max(0, a),
    endMs: Math.max(Math.max(0, a) + MIN_CAPTION_MS, b),
  };
}

export function captionLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function captionTextAt(caption, sequenceMs) {
  const abs = captionAbsolute(caption, 0);
  if (!abs || !abs.text) return '';
  if (sequenceMs < abs.startMs || sequenceMs >= abs.endMs) return '';
  const lines = captionLines(caption.text);
  if (!lines.length) return '';
  if (lines.length === 1) return lines[0];
  const duration = Math.max(MIN_CAPTION_MS, abs.endMs - abs.startMs);
  const index = Math.min(lines.length - 1, Math.floor((sequenceMs - abs.startMs) / duration * lines.length));
  return lines[index];
}

export function activeCaptionText(project, sequenceMs) {
  const rows = [];
  let startMs = 0;
  for (const output of (project?.outputs || [])) {
    const material = (project.materials || []).find(m => m.id === output.materialId);
    if (!material) continue;
    const durationMs = Math.max(MIN_CAPTION_MS, Math.round(Math.max(0, material.out - material.in) * 1000));
    for (const caption of (Array.isArray(output.captions) ? output.captions : [])) {
      rows.push(captionAbsolute(caption, startMs, material));
    }
    startMs += durationMs;
  }
  rows.sort((a, b) => a.startMs - b.startMs);
  for (const row of rows) {
    if (sequenceMs < row.startMs || sequenceMs >= row.endMs) continue;
    const text = captionTextAt(row, sequenceMs);
    if (text) return text;
  }
  return '';
}

export function captionDensity(caption) {
  if (!caption?.text) return 0;
  const abs = captionAbsolute(caption, 0);
  const chars = String(caption.text).replace(/\s/g, '').length;
  const seconds = Math.max(0.001, ((abs?.endMs || 0) - (abs?.startMs || 0)) / 1000);
  return chars / seconds;
}

export function densityClass(caption) {
  const d = captionDensity(caption);
  if (d >= 12) return 'danger';
  if (d >= 8) return 'warn';
  return 'ok';
}

export function drawCaption(ctx, width, height, text) {
  const lines = captionLines(text);
  if (!ctx || !lines.length || !width || !height) return;

  const maxTextWidth = width * 0.84;
  let fontSize = Math.max(16, Math.round(height * 0.045));
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = captionFont(fontSize);

  while (fontSize > 14 && lines.some(line => ctx.measureText(line).width > maxTextWidth)) {
    fontSize -= 1;
    ctx.font = captionFont(fontSize);
  }

  const lineHeight = Math.round(fontSize * 1.28);
  const padX = Math.round(fontSize * 0.65);
  const padY = Math.round(fontSize * 0.42);
  const blockH = lines.length * lineHeight + padY * 2;
  const blockW = Math.min(width * 0.9, Math.max(...lines.map(line => ctx.measureText(line).width)) + padX * 2);
  const x = width / 2;
  const y = height * 0.79;
  const boxX = x - blockW / 2;
  const boxY = y - blockH / 2;
  const radius = Math.max(6, Math.round(fontSize * 0.28));

  ctx.fillStyle = 'rgba(0,0,0,.62)';
  roundRect(ctx, boxX, boxY, blockW, blockH, radius);
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,.95)';
  ctx.shadowBlur = Math.max(2, Math.round(fontSize * 0.12));
  ctx.shadowOffsetY = 1;
  const firstY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, x, firstY + i * lineHeight));
  ctx.restore();
}

function captionFont(size) {
  return `700 ${size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
