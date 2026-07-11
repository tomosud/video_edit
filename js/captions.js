// captions.js - shared caption timing, density, and canvas drawing helpers

export const MIN_CAPTION_MS = 250;
const LINE_GAP_MS = 200;
const MIN_LINE_VISIBLE_MS = 400;
const EDGE_PAD_MS = 34;

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
    secondaryText: String(caption.secondaryText || ''),
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

export function captionTextAt(caption, sequenceMs, field = 'text') {
  const abs = captionAbsolute(caption, 0);
  const raw = String(abs?.[field] || '');
  if (!abs || !raw) return '';
  if (sequenceMs < abs.startMs || sequenceMs > abs.endMs + EDGE_PAD_MS) return '';
  const playMs = Math.max(abs.startMs, Math.min(sequenceMs, abs.endMs - 1));
  const lines = captionLines(raw);
  if (!lines.length) return '';
  if (lines.length === 1) return lines[0];
  const duration = Math.max(MIN_CAPTION_MS, abs.endMs - abs.startMs);
  const gapTotal = LINE_GAP_MS * (lines.length - 1);
  const canUseGaps = duration >= gapTotal + MIN_LINE_VISIBLE_MS * lines.length;
  if (canUseGaps) {
    const visibleMs = (duration - gapTotal) / lines.length;
    let elapsed = playMs - abs.startMs;
    for (let i = 0; i < lines.length; i++) {
      if (elapsed < visibleMs) return lines[i];
      elapsed -= visibleMs;
      if (i < lines.length - 1) {
        if (elapsed < LINE_GAP_MS) return '';
        elapsed -= LINE_GAP_MS;
      }
    }
    return lines[lines.length - 1];
  }
  const index = Math.min(lines.length - 1, Math.floor((playMs - abs.startMs) / duration * lines.length));
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
    if (sequenceMs < row.startMs || sequenceMs > row.endMs + EDGE_PAD_MS) continue;
    if (!captionLines(row.text).length && !captionLines(row.secondaryText).length) continue;
    const primary = captionTextAt(row, sequenceMs, 'text');
    const secondary = captionTextAt(row, sequenceMs, 'secondaryText');
    return primary || secondary ? { primary, secondary } : '';
  }
  return '';
}

export function captionDensity(caption) {
  if (!caption?.text && !caption?.secondaryText) return 0;
  const abs = captionAbsolute(caption, 0);
  const chars = (String(caption.text || '') + String(caption.secondaryText || '')).replace(/\s/g, '').length;
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
  const primaryText = typeof text === 'object' && text ? text.primary : text;
  const secondaryText = typeof text === 'object' && text ? text.secondary : '';
  const primaryRaw = captionLines(primaryText);
  const secondaryRaw = captionLines(secondaryText);
  if (!ctx || (!primaryRaw.length && !secondaryRaw.length) || !width || !height) return;

  const maxTextWidth = width * 0.84;
  let fontSize = Math.max(16, Math.round(height * 0.045));
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = captionFont(fontSize);

  let primaryLines = wrapCaptionLines(ctx, primaryRaw, maxTextWidth);
  let secondaryLines = wrapCaptionLines(ctx, secondaryRaw, maxTextWidth);
  while (fontSize > 14 && captionBlockTooLarge(ctx, primaryLines, secondaryLines, fontSize, width, height)) {
    fontSize -= 1;
    ctx.font = captionFont(fontSize);
    primaryLines = wrapCaptionLines(ctx, primaryRaw, maxTextWidth);
    secondaryLines = wrapCaptionLines(ctx, secondaryRaw, maxTextWidth);
  }

  const lineHeight = Math.round(fontSize * 1.28);
  const padX = Math.round(fontSize * 0.65);
  const padY = Math.round(fontSize * 0.42);
  const groupGap = primaryLines.length && secondaryLines.length ? Math.round(fontSize * 0.32) : 0;
  const allLines = [...primaryLines, ...secondaryLines];
  const blockH = allLines.length * lineHeight + groupGap + padY * 2;
  const blockW = Math.min(width * 0.9, Math.max(...allLines.map(line => ctx.measureText(line).width), 1) + padX * 2);
  const x = width / 2;
  const y = Math.min(height * 0.82, height - blockH / 2 - Math.max(10, height * 0.035));
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
  let cursorY = boxY + padY + lineHeight / 2;
  ctx.fillStyle = '#fff';
  for (const line of primaryLines) {
    ctx.fillText(line, x, cursorY);
    cursorY += lineHeight;
  }
  if (primaryLines.length && secondaryLines.length) cursorY += groupGap;
  ctx.fillStyle = '#ffd84d';
  for (const line of secondaryLines) {
    ctx.fillText(line, x, cursorY);
    cursorY += lineHeight;
  }
  ctx.restore();
}

function captionFont(size) {
  return `700 ${size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
}

function captionBlockTooLarge(ctx, primaryLines, secondaryLines, fontSize, width, height) {
  const maxTextWidth = width * 0.84;
  const lineHeight = Math.round(fontSize * 1.28);
  const groupGap = primaryLines.length && secondaryLines.length ? Math.round(fontSize * 0.32) : 0;
  const lineCount = primaryLines.length + secondaryLines.length;
  const blockH = lineCount * lineHeight + groupGap + Math.round(fontSize * 0.42) * 2;
  return blockH > height * 0.34 || [...primaryLines, ...secondaryLines].some(line => ctx.measureText(line).width > maxTextWidth);
}

function wrapCaptionLines(ctx, rawLines, maxWidth) {
  const wrapped = [];
  for (const line of rawLines) {
    wrapped.push(...wrapOneCaptionLine(ctx, line, maxWidth));
  }
  return wrapped;
}

function wrapOneCaptionLine(ctx, line, maxWidth) {
  if (!line || ctx.measureText(line).width <= maxWidth) return [line];
  const tokens = line.includes(' ') ? line.split(/(\s+)/).filter(Boolean) : [...line];
  const rows = [];
  let cur = '';
  for (const token of tokens) {
    const next = cur + token;
    if (cur && ctx.measureText(next).width > maxWidth) {
      rows.push(cur.trimEnd());
      cur = token.trimStart();
    } else {
      cur = next;
    }
  }
  if (cur.trim()) rows.push(cur.trim());
  return rows.length ? rows : [line];
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

