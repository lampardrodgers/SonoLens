// Small shared helpers.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

let _css = null;
export function cssVar(name) {
  if (!_css) _css = getComputedStyle(document.documentElement);
  return _css.getPropertyValue(name).trim();
}
export function resetCss() { _css = null; }

export const SERIES = n => cssVar(`--s${((n % 8) + 8) % 8 + 1}`);
export const STEM_SLOT = { vocals: 0, drums: 1, bass: 2, guitar: 3, piano: 4, other: 5, mix: 6 };
export const stemColor = name => SERIES(STEM_SLOT[name] ?? 7);

export function fmtTime(t, dec = 1) {
  if (t == null || !isFinite(t)) return '–';
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(dec).padStart(dec ? 3 + dec : 2, '0')}`;
}
export const fmtHz = f => f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`;
export const fmt = (v, d = 1) => v == null || !isFinite(v) ? '–' : Number(v).toFixed(d);

export const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = m => `${NOTE[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

export function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag;
  const step = mag * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}

export function timeTicks(t0, t1, px) {
  const span = t1 - t0;
  const target = Math.max(2, Math.floor(px / 90));
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find(s => span / s <= target) || 600;
  const out = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(+t.toFixed(6));
  return { ticks: out, step };
}

// Series helpers: {t0, dt, v} uniform or {t, v} explicit
export function seriesAt(s, t) {
  if (!s) return null;
  if (s.t) {
    const i = bisect(s.t, t);
    const j = Math.max(0, Math.min(s.t.length - 1, i > 0 && Math.abs(s.t[i - 1] - t) < Math.abs((s.t[i] ?? Infinity) - t) ? i - 1 : i));
    return s.v[j];
  }
  const i = Math.round((t - s.t0) / s.dt);
  return i >= 0 && i < s.v.length ? s.v[i] : null;
}
export function bisect(arr, x) { // first index with arr[i] >= x
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function download(url, name) {
  const a = h('a', { href: url, download: name || '' });
  document.body.append(a); a.click(); a.remove();
}

export function hexToRgb(hex) {
  const m = hex.replace('#', '');
  const n = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };

// readable ink on a categorical fill: yellow-ish slots use dark ink
export function inkOn(hex) {
  const [r, g, b] = hexToRgb(hex);
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return L > 0.6 ? '#0b0b0b' : '#ffffff';
}
