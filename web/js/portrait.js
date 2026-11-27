// 歌曲肖像 Song portrait: the whole song as one circular object (time runs clockwise from 12 o'clock).
// Rings, inside → out: core (key · BPM) · tension halo · instrument streams (width = energy) ·
// harmonic-function ribbon with cadence ticks · section arcs.  Same grammar as the 声河 river.
import { h, cssVar, download, fmt } from './util.js';
import { sectionColor } from './ui.js';
import { RIVER_ORDER, STEM_CN, FUNC_CN, funcHex, tensionCss, stemHex, CAD } from './grammar.js';

const TAU = Math.PI * 2;
const ang = f => -Math.PI / 2 + f * TAU;

function smooth(arr, k = 2) {
  const n = arr.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0, w = 0;
    for (let j = -k; j <= k; j++) { const q = arr[(i + j + n) % n] ?? 0, ww = k + 1 - Math.abs(j); a += q * ww; w += ww; }
    out[i] = a / w;
  }
  return out;
}

/**
 * Draw a portrait.  P = insight.portrait (or meta.portrait).  (cx, cy) centre, R outer radius.
 * opts: { labels: bool, title, subtitle, dark: bool, bg: css colour | null, progress: 0..1 | null }
 */
export function drawPortrait(ctx, P, cx, cy, R, opts = {}) {
  if (!P || !P.n) return;
  const dark = opts.dark ?? document.documentElement.dataset.theme !== 'light';
  const ink = dark ? '#f3ead8' : '#151310', muted = dark ? 'rgba(243,234,216,0.45)' : 'rgba(20,18,16,0.45)';
  const n = P.n;
  ctx.save();
  if (opts.bg) { ctx.fillStyle = opts.bg; ctx.beginPath(); ctx.arc(cx, cy, R * 1.04, 0, TAU); ctx.fill(); }

  const r0 = R * 0.2, rT0 = R * 0.24, rT1 = R * 0.33, rS0 = R * 0.36, rS1 = R * 0.8, rF0 = R * 0.84, rF1 = R * 0.89, rX0 = R * 0.93, rX1 = R * 0.985;
  const seg = (a0, a1, ri, ro) => {
    ctx.beginPath(); ctx.arc(cx, cy, ro, a0, a1); ctx.arc(cx, cy, ri, a1, a0, true); ctx.closePath();
  };
  // tension halo
  const ten = P.tension || [];
  for (let i = 0; i < n; i++) {
    const t = ten[i] ?? 0;
    ctx.fillStyle = tensionCss(t, 0.25 + 0.75 * t);
    seg(ang(i / n) - 0.002, ang((i + 1) / n) + 0.002, rT0, rT0 + (rT1 - rT0) * (0.35 + 0.65 * t));
    ctx.fill();
  }
  // instrument streams (stacked radially)
  const names = RIVER_ORDER.filter(k => P.stems?.[k]).concat(Object.keys(P.stems || {}).filter(k => !RIVER_ORDER.includes(k)));
  const lv = names.map(k => smooth(P.stems[k].map(v => v ?? 0), 1));
  const tot = new Float32Array(n);
  for (const a of lv) for (let i = 0; i < n; i++) tot[i] += a[i];
  let mx = 0.001; for (const v of tot) mx = Math.max(mx, v);
  const k = (rS1 - rS0) / mx;
  const base = new Float32Array(n).fill(rS0);
  names.forEach((name, si) => {
    const a = lv[si];
    ctx.beginPath();
    for (let i = 0; i <= n; i++) { const j = i % n, r = base[j] + a[j] * k, th = ang(i / n); i ? ctx.lineTo(cx + Math.cos(th) * r, cy + Math.sin(th) * r) : ctx.moveTo(cx + Math.cos(th) * r, cy + Math.sin(th) * r); }
    for (let i = n; i >= 0; i--) { const j = i % n, r = base[j], th = ang(i / n); ctx.lineTo(cx + Math.cos(th) * r, cy + Math.sin(th) * r); }
    ctx.closePath();
    ctx.fillStyle = stemHex(name); ctx.globalAlpha = 0.88; ctx.fill(); ctx.globalAlpha = 1;
    for (let i = 0; i < n; i++) base[i] += a[i] * k;
  });
  // silhouette line
  ctx.beginPath();
  for (let i = 0; i <= n; i++) { const j = i % n, th = ang(i / n); const x = cx + Math.cos(th) * base[j], y = cy + Math.sin(th) * base[j]; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.strokeStyle = ink; ctx.globalAlpha = 0.35; ctx.lineWidth = Math.max(0.6, R / 260); ctx.stroke(); ctx.globalAlpha = 1;
  // function ribbon
  const fs = P.func || '';
  for (let i = 0; i < n; i++) {
    const f = fs[i] || 'N';
    if (f === 'N') continue;
    ctx.fillStyle = funcHex(f); seg(ang(i / n) - 0.002, ang((i + 1) / n) + 0.002, rF0, rF1); ctx.fill();
  }
  for (const [f, typ] of P.cadences || []) {
    const th = ang(f);
    ctx.strokeStyle = CAD[typ]?.hex || ink; ctx.lineWidth = Math.max(1, R / 140);
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(th) * (rF0 - R * 0.03), cy + Math.sin(th) * (rF0 - R * 0.03));
    ctx.lineTo(cx + Math.cos(th) * (rF1 + R * 0.01), cy + Math.sin(th) * (rF1 + R * 0.01)); ctx.stroke();
  }
  // sections
  const gap = Math.min(0.012, 0.6 / Math.max(1, (P.sections || []).length) * 0.05);
  for (const [a, b, lab] of P.sections || []) {
    ctx.fillStyle = sectionColor(lab); ctx.globalAlpha = 0.9;
    seg(ang(a) + gap, ang(b) - gap, rX0, rX1); ctx.fill(); ctx.globalAlpha = 1;
    if (opts.labels && (b - a) > 0.035) {
      const th = ang((a + b) / 2), rr = R * 1.06;
      ctx.fillStyle = ink; ctx.font = `600 ${Math.round(R * 0.055)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(lab, cx + Math.cos(th) * rr, cy + Math.sin(th) * rr);
    }
  }
  // progress hand
  if (opts.progress != null) {
    const th = ang(opts.progress);
    ctx.strokeStyle = cssVar('--playhead') || '#e5383b'; ctx.lineWidth = Math.max(1.5, R / 110);
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(th) * r0, cy + Math.sin(th) * r0); ctx.lineTo(cx + Math.cos(th) * R, cy + Math.sin(th) * R); ctx.stroke();
  }
  // core
  ctx.fillStyle = dark ? '#0d0a08' : '#ffffff';
  ctx.beginPath(); ctx.arc(cx, cy, r0, 0, TAU); ctx.fill();
  ctx.strokeStyle = muted; ctx.lineWidth = 1; ctx.stroke();
  if (R > 40) {
    ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const key = (P.key || '').replace(' major', '').replace(' minor', 'm');
    ctx.font = `600 ${Math.round(R * 0.085)}px system-ui`; ctx.fillText(key || '–', cx, cy - R * 0.035);
    ctx.fillStyle = muted; ctx.font = `${Math.round(R * 0.05)}px system-ui`;
    ctx.fillText(P.bpm ? `${Math.round(P.bpm)} BPM` : '', cx, cy + R * 0.06);
  }
  ctx.restore();
}

/** Poster-sized PNG (portrait + title + legend). */
export function posterCanvas(P, meta, { dark = true, size = 1600 } = {}) {
  const W = size, H = Math.round(size * 1.3);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const bg = dark ? '#0a0807' : '#f9f9f7', ink = dark ? '#f3ead8' : '#151310', muted = dark ? '#8b857b' : '#898781';
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  drawPortrait(g, P, W / 2, W * 0.56, W * 0.38, { labels: true, dark });
  g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.font = `600 ${Math.round(W * 0.045)}px "Songti SC", "Noto Serif SC", serif`;
  g.fillText(meta.title || '', W / 2, W * 0.1);
  g.fillStyle = muted; g.font = `${Math.round(W * 0.018)}px system-ui`;
  g.fillText([meta.artist, P.key, P.bpm && `${Math.round(P.bpm)} BPM`, P.lufs != null && `${fmt(P.lufs, 1)} LUFS`, mmss(P.duration)].filter(Boolean).join('  ·  '), W / 2, W * 0.135);
  // legend
  const items = [
    ...Object.keys(P.stems || {}).map(k => [stemHex(k), STEM_CN[k] || k]),
    ...['T', 'S', 'D', 'X'].map(f => [funcHex(f), FUNC_CN[f]]),
  ];
  g.font = `${Math.round(W * 0.016)}px system-ui`; g.textAlign = 'left';
  let x = W * 0.08, y = H - W * 0.12;
  for (const [col, lab] of items) {
    const w = g.measureText(lab).width + W * 0.045;
    if (x + w > W * 0.92) { x = W * 0.08; y += W * 0.035; }
    g.fillStyle = col; g.fillRect(x, y - W * 0.012, W * 0.016, W * 0.016);
    g.fillStyle = ink; g.fillText(lab, x + W * 0.024, y + W * 0.002);
    x += w;
  }
  g.fillStyle = muted; g.textAlign = 'center'; g.font = `${Math.round(W * 0.013)}px system-ui`;
  g.fillText('时间从 12 点方向顺时针走一圈 · 内圈光晕 = 张力 · 彩色河流 = 各乐器能量 · 外环 = 和声功能与段落    声镜 SonoLens', W / 2, H - W * 0.03);
  return c;
}
const mmss = t => t == null ? '' : `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

export function portraitThumb(P, size = 96) {
  const dpr = window.devicePixelRatio || 1;
  const c = h('canvas', { class: 'portrait-thumb', width: size * dpr, height: size * dpr, style: { width: size + 'px', height: size + 'px' } });
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  drawPortrait(g, P, size / 2, size / 2, size / 2 - 2, {});
  return c;
}

export function downloadPoster(P, meta, dark) {
  const c = posterCanvas(P, meta, { dark });
  download(c.toDataURL('image/png'), `${(meta.title || 'song').replace(/[\\/:*?"<>|\s]+/g, '_')}_声镜肖像.png`);
}
