// util.js — small shared helpers
export function fmtTime(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function fmtDur(sec) {
  sec = Math.max(0, sec || 0);
  return sec.toFixed(1) + 's';
}

// Stable short hash (16 hex chars) used to key media-derived caches by file
// identity (name+size) so thumbnails persist & match across sessions/re-imports.
export async function hashKey(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return 'h' + (h >>> 0).toString(16).padStart(8, '0');
  }
}

// High-responsiveness scrubber: coalesces rapid seek requests onto rAF and
// always jumps to the latest target, waiting for any in-flight seek to finish
// so the <video> never queues a backlog. Returns a function scrub(t).
export function makeScrubber(video) {
  let target = null, raf = 0;
  const tick = () => {
    raf = 0;
    if (target == null || !video || video.readyState < 1) return;
    if (video.seeking) { raf = requestAnimationFrame(tick); return; } // let current seek settle
    const t = Math.max(0, target); target = null;
    try { video.currentTime = t; } catch { /* ignore */ }
  };
  return (t) => { target = t; if (!raf) raf = requestAnimationFrame(tick); };
}
