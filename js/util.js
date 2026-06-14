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
