// The one visual grammar every "whole-song" view shares (声河 river, poster, 3D flythrough):
//   time → x (or depth) · pitch → height · instrument → fixed colour, stream width = its energy
//   harmony → function colour (stable = cool, dominant = warm) · tension → warmth/brightness of the light
//   structure → section colour + repetition arcs · rhythm → ticks / pulses
import { stemColor, hexToRgb, seriesAt, clamp } from './util.js';

export const RIVER_ORDER = ['guitar', 'piano', 'other', 'vocals', 'bass', 'drums'];
export const STEM_CN = { vocals: '人声', drums: '鼓', bass: '贝斯', guitar: '吉他', piano: '钢琴/键盘', other: '其他' };
export const FUNC_CN = { T: '主功能 T', S: '下属功能 S', D: '属功能 D', X: '调外 / 借用', N: '无和弦' };
// fixed hues (theme independent, mid saturation so they read on dark and light pages)
export const FUNC_HEX = { T: '#3f9e9a', S: '#7d74d8', D: '#e07b39', X: '#d0507e', N: '#6b655d' };
export const funcHex = f => FUNC_HEX[f] || FUNC_HEX.N;
export const CAD = {
  PAC: { short: 'PAC', cn: '完全正格终止', hex: '#e8c06a' },
  IAC: { short: 'IAC', cn: '不完全正格终止', hex: '#d9a54a' },
  plagal: { short: 'IV→I', cn: '变格终止', hex: '#3f9e9a' },
  deceptive: { short: '阻碍', cn: '阻碍终止', hex: '#d0507e' },
  half: { short: '半', cn: '半终止', hex: '#7d74d8' },
};
export const TAG = {
  c: { cn: '和弦音', hex: '#f3ead8', light: '#2b2b2b' },
  t: { cn: '张力音', hex: '#e8c06a', light: '#c07a00' },
  n: { cn: '非和弦音', hex: '#8b857b', light: '#9a978f' },
};
export const tagHex = (tag, dark = true) => (TAG[tag] || TAG.n)[dark ? 'hex' : 'light'];
const REL_CN = { R: '根音', b9: '♭9 音', 9: '9 音', b3: '小三度', 3: '三度', 11: '11 音', '#11': '♯11 音', 5: '五度',
  b13: '♭13 音', 13: '13 音', b7: '小七度', 7: '大七度' };
export const relCn = r => REL_CN[r] || r || '';

/** tension 0..1 → [r,g,b]: cool slate → gold → crimson */
export function tensionRGB(t) {
  t = clamp(t, 0, 1);
  const A = [92, 116, 150], B = [232, 192, 106], C = [229, 56, 59];
  const [p, q, k] = t < 0.5 ? [A, B, t / 0.5] : [B, C, (t - 0.5) / 0.5];
  return [0, 1, 2].map(i => Math.round(p[i] + (q[i] - p[i]) * k));
}
export const tensionCss = (t, a = 1) => { const [r, g, b] = tensionRGB(t); return `rgba(${r},${g},${b},${a})`; };

/** key → hue on the circle of fifths (C = 0°, G = 30°, …), minor keys a little darker */
export function keyHsl(keyIdx, a = 1, light = 52) {
  const tonic = ((keyIdx % 12) + 12) % 12, minor = keyIdx >= 12;
  const pos = (tonic * 7) % 12;
  return `hsla(${pos * 30},${minor ? 38 : 52}%,${minor ? light - 12 : light}%,${a})`;
}

export const rgbOf = hex => hexToRgb(hex);
export const stemHex = name => stemColor(name);

/** Per-stem energy in 0..1 (shared normalisation so stream widths are comparable). */
export function stemLevels(A) {
  const items = (A.stems?.items || []).filter(s => s.energy?.v?.length);
  let mx = -80;
  for (const s of items) for (const v of s.energy.v) if (v != null && v > mx) mx = v;
  const lo = mx - 42;
  const out = [];
  for (const name of [...RIVER_ORDER, ...items.map(s => s.name).filter(n => !RIVER_ORDER.includes(n))]) {
    const s = items.find(x => x.name === name);
    if (!s) continue;
    const v = new Float32Array(s.energy.v.length);
    s.energy.v.forEach((x, i) => { v[i] = x == null ? 0 : Math.pow(clamp((x - lo) / 42, 0, 1), 1.25); });
    out.push({ name, label: s.label, t0: s.energy.t0, dt: s.energy.dt, v, color: stemColor(name) });
  }
  return out;
}
/** mean of a uniform Float32 series over [a, b] */
export function meanOver(s, a, b) {
  const i0 = Math.max(0, Math.floor((a - s.t0) / s.dt)), i1 = Math.min(s.v.length - 1, Math.ceil((b - s.t0) / s.dt));
  if (i1 < i0) return 0;
  let acc = 0;
  for (let i = i0; i <= i1; i++) acc += s.v[i];
  return acc / (i1 - i0 + 1);
}
export function sampleAt(s, t) {
  const x = (t - s.t0) / s.dt, i = Math.floor(x);
  if (i < 0) return s.v[0] ?? 0;
  if (i >= s.v.length - 1) return s.v[s.v.length - 1] ?? 0;
  const k = x - i;
  return s.v[i] * (1 - k) + s.v[i + 1] * k;
}
export const valAt = (s, t) => seriesAt(s, t);
