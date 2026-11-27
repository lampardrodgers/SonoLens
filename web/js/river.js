// 声河 Sound River — the whole song in one picture.
// One shared time axis, one visual grammar (grammar.js), semantic zoom (地图 → 编曲 → 音符),
// and a cross-section panel that explains "what is happening right here, and why".
import { TL } from './timeline.js';
import { Player } from './player.js';
import { h, cssVar, fmt, fmtTime, bisect, clamp, rgba, midiName, seriesAt, NOTE } from './util.js';
import { card, tiles, note, sectionColor } from './ui.js';
import { hideTip } from './chart.js';
import * as G from './grammar.js';
import { drawPortrait, downloadPoster } from './portrait.js';
import { D } from './data.js';

const LANES = [
  ['axis', 18], ['arcs', 34], ['sections', 22], ['key', 12], ['_', 6], ['river', 268], ['_', 4],
  ['beats', 14], ['phrases', 16], ['chords', 26], ['_', 6], ['tension', 74], ['_', 4], ['density', 26], ['_', 6],
];
const LANE_CN = { arcs: '重复', sections: '段落', key: '调性', river: '乐器河流', beats: '小节', phrases: '乐句',
  chords: '和声', tension: '张力', density: '编曲密度' };
const ML = 74, MR = 10;
const smooth01 = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ================================================================================== tab
export function river(root, A) {
  const I = A.insight;
  root.append(h('div', { class: 'tab-title' }, '声河 · 一张图读懂整首歌'),
    h('div', { class: 'tab-sub' }, '所有维度共用一条时间轴、一套视觉语法：河流宽度 = 乐器能量，旋律线浮在河面，底色越暖 = 和声越紧张。缩放会在“全曲地图 → 编曲 → 音符”之间切换细节层级；点任意位置看这一刻的完整横截面。'));
  if (!I) { note(root, '这首歌还没有“洞察层”数据。重启服务（会自动补算）或运行 <code>./run.sh enrich</code>。'); return; }

  // headline facts
  const H = A.harmony || {}, R = A.rhythm || {}, ms = I.melody_stats || {}, gr = I.groove || {};
  const secs = I.sections || [];
  const climax = secs.reduce((m, s) => (s.tension_peak ?? 0) > (m?.tension_peak ?? -1) ? s : m, null);
  tiles(root, [
    { l: '调性', v: H.key?.name_cn || '–', s: `${(H.key_segments || []).length > 1 ? `${H.key_segments.length - 1} 次离调/转调` : '全曲不转调'}` },
    { l: '速度 · 拍号', v: `${fmt(R.bpm, 0)} BPM`, s: `${R.time_signature || ''} · ${gr.feel_cn || ''}` },
    { l: '曲式', v: secs.map(s => s.prime).join(' ') || '–', s: `${(I.phrases || []).length} 个乐句` },
    { l: '终止式', v: String((I.cadences || []).length), s: summarizeCadences(I.cadences || []) },
    { l: '张力最高处', v: climax ? `${climax.prime} ${shortHint(climax.hint)}` : '–', s: climax ? `${fmtTime(climax.start, 0)} 起 · 峰值 ${fmt(climax.tension_peak * 100, 0)}` : '' },
    ms.n ? { l: '旋律与和弦', v: `${fmt(ms.chord_tone, 0)}% 和弦音`, s: `${fmt(ms.tension, 0)}% 张力音 · ${fmt(ms.non_chord, 0)}% 经过/邻音` } : null,
  ]);

  // toolbar
  const lvlBtns = [['map', '全曲地图'], ['arr', '编曲'], ['note', '音符']].map(([k, l]) =>
    h('button', { class: 'btn ghost sm', 'data-lvl': k, title: { map: '显示全曲：段落、重复、调性、张力全景', arr: '约 40 秒：和弦级数、乐句、终止式、旋律线', note: '约 8 秒：旋律音逐个标注（和弦音/张力音），贝斯音，拍点' }[k] }, l));
  const tenSel = h('select', {}, h('option', { value: 'total' }, '底色：总张力（和声+能量）'), h('option', { value: 'harmonic' }, '底色：仅和声张力'), h('option', { value: 'none' }, '底色：关'));
  const lvlLabel = h('span', { class: 'river-lvl' });
  const bar = h('div', { class: 'river-bar' }, h('div', { class: 'seg' }, ...lvlBtns), lvlLabel, h('div', { class: 'grow' }),
    h('label', { class: 'ctl sm' }, tenSel), h('span', { class: 'muted sm' }, '⌘/Ctrl+滚轮缩放 · 拖动平移 · 双击全曲'));
  root.append(bar);

  const wrap = h('div', { class: 'river-wrap' });
  const main = h('div', { class: 'river-main card' }), side = h('div', { class: 'river-x card' });
  wrap.append(main, side); root.append(wrap);
  root.append(legendRow(A));

  const view = new RiverView(main, A, side, lvlLabel);
  tenSel.onchange = () => { view.tenMode = tenSel.value; view.requestDraw(); };
  lvlBtns.forEach(b => b.onclick = () => view.gotoLevel(b.dataset.lvl));

  // ---------------------------------------------------------------- detail cards
  const grid = h('div', { class: 'river-cards' });
  root.append(grid);
  portraitCardEl(grid, A);
  sectionCard(grid, A);
  cadenceCard(grid, A);
  grooveCard(grid, A);
  productionCard(grid, A);
}

function shortHint(hn) { return (hn || '').split(' ')[0]; }
function summarizeCadences(cs) {
  const c = {};
  cs.forEach(x => { c[x.type] = (c[x.type] || 0) + 1; });
  return Object.entries(c).map(([k, v]) => `${G.CAD[k]?.cn || k} ${v}`).join(' · ') || '未检测到明显终止式';
}

function legendRow(A) {
  const el = h('div', { class: 'legend river-legend' });
  for (const s of G.stemLevels(A)) el.append(h('span', {}, h('i', { style: { background: s.color } }), G.STEM_CN[s.name] || s.name));
  el.append(h('span', { class: 'sep' }));
  for (const f of ['T', 'S', 'D', 'X']) el.append(h('span', {}, h('i', { style: { background: G.funcHex(f) } }), G.FUNC_CN[f]));
  el.append(h('span', { class: 'sep' }));
  for (const t of ['c', 't', 'n']) el.append(h('span', {}, h('i', { style: { background: G.tagHex(t, isDark()), borderRadius: '50%' } }), G.TAG[t].cn));
  el.append(h('span', { class: 'sep' }));
  el.append(h('span', {}, h('i', { style: { background: `linear-gradient(90deg, ${G.tensionCss(0, 0.6)}, ${G.tensionCss(0.5, 0.8)}, ${G.tensionCss(1, 1)})`, width: '40px' } }), '张力 低 → 高'));
  el.append(h('span', { class: 'muted' }, '· 所有理论标注均为算法估计'));
  return el;
}
const isDark = () => document.documentElement.dataset.theme !== 'light';

// ================================================================================== view
class RiverView {
  constructor(parent, A, side, lvlLabel) {
    this.A = A; this.I = A.insight; this.side = side; this.lvlLabel = lvlLabel;
    this.tenMode = 'total';
    this.el = h('div', { class: 'river-canvas' });
    this.cv = h('canvas'); this.ov = h('canvas', { class: 'over' });
    this.el.append(this.cv, this.ov); parent.append(this.el);
    this.H = LANES.reduce((a, [, hh]) => a + hh, 0);
    this.lane = {};
    let y = 0;
    for (const [k, hh] of LANES) { if (k !== '_') this.lane[k] = { y, h: hh }; y += hh; }
    this.prep();
    this.hoverT = null; this.drag = null; this._raf = 0; this._xT = 0;
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.bind();
    this._offV = TL.onView(() => { if (!this.alive()) return; this.requestDraw(); });
    this._offP = TL.onPlayhead(() => { if (!this.alive()) return; this.onPlayhead(); });
    this._mo = new MutationObserver(() => { if (this.alive()) { this.requestDraw(); this.updateCross(true); } });
    this._mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.resize();
  }

  alive() {
    if (this.el.isConnected) return true;
    this._offV?.(); this._offP?.(); this._mo?.disconnect();
    return false;
  }

  prep() {
    const A = this.A, I = this.I;
    this.stems = G.stemLevels(A);
    this.chords = A.harmony?.chords || [];
    this.cStarts = this.chords.map(c => c.start);
    this.segs = A.structure?.segments || [];
    this.isecs = I.sections || [];
    this.bars = A.rhythm?.bars || [];
    this.barStarts = this.bars.map(b => b[0]);
    this.beats = A.rhythm?.beats || [];
    this.beatPos = A.rhythm?.beat_pos || [];
    this.keys = A.harmony?.key_segments || [];
    this.phr = I.phrases || [];
    this.cads = I.cadences || [];
    this.mnotes = I.melody_notes || [];
    this.mStarts = this.mnotes.map(n => n[0]);
    const mel = A.melody?.vocals;
    this.mel = mel && !mel.weak && mel.midi ? mel : null;
    if (this.mel) {
      this.melLo = (mel.low_midi ?? 48) - 3; this.melHi = (mel.high_midi ?? 76) + 3;
    }
    this.bassNotes = (A.transcription?.tracks?.bass || []).slice().sort((a, b) => a[0] - b[0]);
    this.bStarts = this.bassNotes.map(n => n[0]);
    if (this.bassNotes.length) {
      const ps = this.bassNotes.map(n => n[2]).sort((a, b) => a - b);
      this.bLo = ps[Math.floor(ps.length * 0.02)] - 2; this.bHi = ps[Math.floor(ps.length * 0.98)] + 2;
    }
    const T = I.tension || {};
    this.ten = { t0: T.t0 || 0, dt: T.dt || 0.1, total: Float32Array.from(T.total || []), harmonic: Float32Array.from(T.harmonic || []), energy: Float32Array.from(T.energy || []) };
    this.kicks = (A.drums?.hits || []).find(x => x.name === 'kick');
    this.snares = (A.drums?.hits || []).find(x => x.name === 'snare');
  }

  // ------------------------------------------------------------------ geometry
  resize() {
    const w = this.el.clientWidth;
    if (!w) return;
    this.W = w;
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.cv, this.ov]) {
      c.width = Math.round(w * dpr); c.height = Math.round(this.H * dpr);
      c.style.width = w + 'px'; c.style.height = this.H + 'px';
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.el.style.height = this.H + 'px';
    this.draw(); this.drawOverlay(); this.updateCross(true);
  }
  get pw() { return this.W - ML - MR; }
  tx(t) { return ML + (t - TL.t0) / (TL.t1 - TL.t0) * this.pw; }
  xt(x) { return TL.t0 + (x - ML) / this.pw * (TL.t1 - TL.t0); }
  requestDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); this.drawOverlay(); });
  }
  levels() {
    const span = TL.t1 - TL.t0;
    return { span, aArr: smooth01(110, 35, span), aNote: smooth01(20, 9, span) };
  }
  gotoLevel(k) {
    const c = clamp(Player.playing || TL.playhead > 0 ? TL.playhead : (TL.t0 + TL.t1) / 2, 0, TL.duration);
    if (k === 'map') return TL.fit();
    const span = Math.min(TL.duration, k === 'arr' ? 40 : 8);
    TL.setView(c - span * 0.3, c + span * 0.7);
  }

  // ------------------------------------------------------------------ draw
  draw() {
    if (!this.W || !this.el.offsetParent) return;
    const g = this.cv.getContext('2d'), W = this.W, H = this.H, L = this.lane;
    const dark = isDark(), ink = cssVar('--ink'), muted = cssVar('--muted'), axis = cssVar('--axis'), grid = cssVar('--grid');
    const { span, aArr, aNote } = this.levels();
    this.lvlLabel.textContent = aNote > 0.5 ? '细节层级：音符（旋律逐音标注 · 贝斯 · 拍点）' : aArr > 0.5 ? '细节层级：编曲（和声级数 · 乐句 · 终止式）' : '细节层级：全曲地图（段落 · 重复 · 调性 · 张力）';
    g.clearRect(0, 0, W, H);
    const x0 = ML, x1 = W - MR;
    g.save(); g.beginPath(); g.rect(x0, 0, x1 - x0, H); g.clip();

    // ---- tension wash behind river + tension lane
    if (this.tenMode !== 'none') {
      const arr = this.ten[this.tenMode === 'harmonic' ? 'harmonic' : 'total'];
      const step = 3, w = Math.max(span * 0.022, 0.2);
      for (let x = x0; x < x1; x += step) {
        const tc = this.xt(x + step / 2), v = this.tenMean(arr, tc - w, tc + w);
        g.fillStyle = G.tensionCss(v, (dark ? 0.03 : 0.025) + Math.pow(v, 2) * (dark ? 0.26 : 0.2));
        g.fillRect(x, L.river.y, step, L.river.h);
      }
    }
    // ---- axis
    g.font = '10px system-ui'; g.fillStyle = muted; g.textBaseline = 'middle';
    const tStep = [0.5, 1, 2, 5, 10, 15, 30, 60].find(s => span / s <= (x1 - x0) / 80) || 120;
    for (let t = Math.ceil(TL.t0 / tStep) * tStep; t <= TL.t1; t += tStep) {
      const x = this.tx(t); g.fillRect(x, L.axis.y + 12, 1, 5);
      g.fillText(fmtTime(t, tStep < 1 ? 1 : 0), x + 3, L.axis.y + 8);
    }
    // ---- sections & arcs
    const sl = L.sections;
    this.segs.forEach((s, i) => {
      const a = this.tx(s.start), b = this.tx(s.end), info = this.isecs[i];
      g.fillStyle = sectionColor(s.label); g.globalAlpha = 0.85;
      rr(g, a + 1, sl.y + 2, Math.max(1, b - a - 2), sl.h - 4, 4); g.fill(); g.globalAlpha = 1;
      if (b - a > 22) {
        g.fillStyle = '#fff'; g.font = '600 11px system-ui';
        g.fillText(fit(g, `${info?.prime || s.label}  ${shortHint(s.hint)}`, b - a - 10), Math.max(a, x0) + 6, sl.y + sl.h / 2);
      }
      // faint section boundaries through everything
      g.fillStyle = rgba(ink, 0.08); g.fillRect(a, L.key.y, 1, H - L.key.y);
    });
    const al = L.arcs;
    for (const s of this.isecs) {
      if (!s.diff) continue;
      const p = this.isecs[s.diff.vs];
      const a = this.tx((p.start + p.end) / 2), b = this.tx((s.start + s.end) / 2);
      if (b < x0 - 400 || a > x1 + 400) continue;
      const hgt = Math.min(al.h - 4, 8 + (b - a) * 0.12);
      g.strokeStyle = sectionColor(s.label); g.globalAlpha = 0.85; g.lineWidth = 1 + 2.5 * (s.diff.harmony_sim ?? 0.5);
      g.beginPath(); g.moveTo(a, al.y + al.h); g.bezierCurveTo(a, al.y + al.h - hgt * 1.3, b, al.y + al.h - hgt * 1.3, b, al.y + al.h); g.stroke(); g.globalAlpha = 1;
      if (b - a > 90) {
        g.fillStyle = muted; g.font = '10px system-ui'; g.textAlign = 'center';
        g.fillText(`${p.prime}→${s.prime}`, (a + b) / 2, al.y + al.h - hgt * 0.95 - 4); g.textAlign = 'left';
      }
    }
    // ---- key lane
    const kl = L.key;
    for (const k of this.keys) {
      const a = this.tx(k.start), b = this.tx(k.end);
      g.fillStyle = G.keyHsl(k.key, 0.9); g.fillRect(a, kl.y, Math.max(1, b - a - 1), kl.h);
      if (b - a > 54) { g.fillStyle = '#fff'; g.font = '9.5px system-ui'; g.fillText(fit(g, k.name_cn, b - a - 6), Math.max(a, x0) + 4, kl.y + kl.h / 2 + 0.5); }
    }
    // ---- river
    this.drawRiver(g, aNote);
    this.drawMelody(g, aArr, aNote, dark);
    // ---- beats / bars
    const bl = L.beats;
    const barPx = this.bars.length > 1 ? (this.bars[1][0] - this.bars[0][0]) / span * (x1 - x0) : 99;
    const beatPx = barPx / (this.A.rhythm?.beats_per_bar || 4);
    g.fillStyle = axis;
    if (beatPx > 5) {
      const i0 = Math.max(0, bisect(this.beats, TL.t0) - 1);
      for (let i = i0; i < this.beats.length && this.beats[i] <= TL.t1; i++) {
        const x = this.tx(this.beats[i]), down = this.beatPos[i] === 1;
        g.fillStyle = down ? ink : axis; g.globalAlpha = down ? 0.7 : 1;
        g.fillRect(x, bl.y + (down ? 1 : 6), down ? 1.5 : 1, down ? bl.h - 2 : bl.h - 7);
      }
      g.globalAlpha = 1;
    }
    const every = barPx > 28 ? 1 : barPx > 12 ? 4 : barPx > 4 ? 8 : 16;
    g.font = '9.5px system-ui'; g.fillStyle = muted;
    this.bars.forEach((b, i) => {
      if (b[1] < TL.t0 || b[0] > TL.t1) return;
      const x = this.tx(b[0]);
      if (beatPx <= 5) { g.fillStyle = axis; g.fillRect(x, bl.y + 4, 1, bl.h - 6); g.fillStyle = muted; }
      if (i % every === 0) g.fillText(String(i + 1), x + 2, bl.y + bl.h / 2);
    });
    // ---- phrases
    const pl = L.phrases;
    this.phr.forEach((p, i) => {
      const a = this.tx(p.start), b = this.tx(p.end);
      if (b < x0 || a > x1 || b - a < 3) return;
      g.strokeStyle = muted; g.lineWidth = 1; g.globalAlpha = 0.7;
      g.beginPath(); g.moveTo(a + 2, pl.y + 3); g.lineTo(a + 2, pl.y + 8); g.lineTo(b - 2, pl.y + 8); g.lineTo(b - 2, pl.y + 3); g.stroke(); g.globalAlpha = 1;
      if (p.cadence) {
        const c = G.CAD[p.cadence];
        g.fillStyle = c.hex; g.beginPath(); g.arc(b - 2, pl.y + 8, 3, 0, Math.PI * 2); g.fill();
      }
      if (aArr > 0.3 && b - a > 46) { g.fillStyle = muted; g.font = '9.5px system-ui'; g.globalAlpha = aArr; g.fillText(`乐句 ${i + 1} · ${p.n_bars} 小节`, a + 6, pl.y + 13); g.globalAlpha = 1; }
    });
    // ---- chords
    const cl = L.chords;
    const ci0 = Math.max(0, bisect(this.cStarts, TL.t0) - 1);
    for (let i = ci0; i < this.chords.length && this.chords[i].start <= TL.t1; i++) {
      const c = this.chords[i];
      if (c.label === 'N') continue;
      const a = this.tx(c.start), b = this.tx(c.end);
      g.fillStyle = G.funcHex(c.func_local || c.function); g.globalAlpha = 0.85;
      rr(g, a + 0.5, cl.y + 2, Math.max(1, b - a - 1), cl.h - 4, 3); g.fill(); g.globalAlpha = 1;
      const w = b - a - 6;
      if (w > 12) {
        const ro = c.roman_local || c.roman;
        const lab = aNote > 0.5 ? `${c.label}  ${ro}` : aArr > 0.4 ? ro : c.label;
        g.fillStyle = '#fff'; g.font = `${w > 40 ? 600 : 500} 10.5px system-ui`;
        g.fillText(fit(g, lab, w), a + 4, cl.y + cl.h / 2);
      }
    }
    // ---- tension lane
    const tl = L.tension, ty = v => tl.y + tl.h - 4 - v * (tl.h - 10);
    g.fillStyle = grid; g.fillRect(x0, tl.y + tl.h - 4, x1 - x0, 1);
    const pts = [];
    for (let x = x0; x <= x1; x += 2) pts.push([x, this.tenMean(this.ten.total, this.xt(x), this.xt(x + 2))]);
    for (let i = 1; i < pts.length; i++) {
      const [xa, va] = pts[i - 1], [xb, vb] = pts[i];
      g.fillStyle = G.tensionCss((va + vb) / 2, dark ? 0.55 : 0.45);
      g.beginPath(); g.moveTo(xa, ty(va)); g.lineTo(xb, ty(vb)); g.lineTo(xb, tl.y + tl.h - 4); g.lineTo(xa, tl.y + tl.h - 4); g.fill();
    }
    g.beginPath(); pts.forEach(([x, v], i) => i ? g.lineTo(x, ty(v)) : g.moveTo(x, ty(v)));
    g.strokeStyle = G.tensionCss(0.75, 1); g.lineWidth = 1.4; g.stroke();
    g.beginPath();
    for (let x = x0, i = 0; x <= x1; x += 2, i++) { const v = this.tenMean(this.ten.harmonic, this.xt(x), this.xt(x + 2)); i ? g.lineTo(x, ty(v)) : g.moveTo(x, ty(v)); }
    g.strokeStyle = rgba(ink, 0.55); g.lineWidth = 1; g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]);
    for (const c of this.cads) {
      if (c.t < TL.t0 - 2 || c.t > TL.t1 + 2) continue;
      const x = this.tx(c.t), cd = G.CAD[c.type];
      g.fillStyle = cd.hex;
      g.beginPath(); g.moveTo(x - 5, tl.y + 1); g.lineTo(x + 5, tl.y + 1); g.lineTo(x, tl.y + 9); g.fill();
      g.strokeStyle = rgba(cd.hex, 0.5); g.beginPath(); g.moveTo(x + 0.5, tl.y + 9); g.lineTo(x + 0.5, tl.y + tl.h - 4); g.stroke();
      if (aArr > 0.3 || span < 140) { g.fillStyle = cd.hex; g.font = '600 9.5px system-ui'; g.fillText(cd.short, x + 6, tl.y + 6); }
    }
    // ---- density
    const dl = L.density, ns = Math.max(1, this.stems.length);
    const act = this.I.bars?.active || [], dd = this.I.bars?.drum_density || [];
    const ddMax = Math.max(8, ...dd);
    this.bars.forEach((b, i) => {
      if (b[1] < TL.t0 || b[0] > TL.t1) return;
      const a = this.tx(b[0]), w = Math.max(1, this.tx(b[1]) - a - 1);
      const v = (act[i] || 0) / ns;
      g.fillStyle = rgba(ink, 0.22 + 0.4 * v); g.fillRect(a, dl.y + dl.h - v * (dl.h - 4), w, v * (dl.h - 4));
      if (dd[i]) { g.fillStyle = cssVar('--gold') || '#e8c06a'; g.fillRect(a, dl.y + dl.h - 2 - dd[i] / ddMax * (dl.h - 6), w, 2); }
    });
    g.restore();

    // ---- lane labels
    g.font = '11px system-ui'; g.fillStyle = muted; g.textBaseline = 'middle'; g.textAlign = 'right';
    for (const [k, l] of Object.entries(this.lane)) if (LANE_CN[k]) g.fillText(LANE_CN[k], ML - 8, l.y + Math.min(l.h / 2, 12));
    g.textAlign = 'left';
    g.fillStyle = muted; g.font = '9.5px system-ui'; g.textAlign = 'right';
    g.fillText('— 和声', ML - 8, this.lane.tension.y + 28); g.fillText('▬ 总', ML - 8, this.lane.tension.y + 42);
    if (this.mel) { g.fillText('旋律线', ML - 8, this.lane.river.y + 40); }
    g.textAlign = 'left';
  }

  tenMean(arr, a, b) {
    if (!arr.length) return 0;
    const dt = this.ten.dt, i0 = clamp(Math.floor((a - this.ten.t0) / dt), 0, arr.length - 1), i1 = clamp(Math.ceil((b - this.ten.t0) / dt), i0, arr.length - 1);
    let s = 0; for (let i = i0; i <= i1; i++) s += arr[i];
    return s / (i1 - i0 + 1);
  }

  drawRiver(g, aNote) {
    const rl = this.lane.river, x0 = ML, x1 = this.W - MR;
    if (!this.stems.length) return;
    const step = 2, xs = [];
    for (let x = x0; x <= x1 + step; x += step) xs.push(x);
    const n = xs.length, ns = this.stems.length;
    const lv = this.stems.map(s => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = G.meanOver(s, this.xt(xs[i] - step), this.xt(xs[i] + step));
      return a;
    });
    const tot = new Float32Array(n);
    for (const a of lv) for (let i = 0; i < n; i++) tot[i] += a[i];
    const maxT = rl.h - 16, unit = maxT / Math.max(2.4, ns * 0.55);
    const mid = rl.y + rl.h / 2;
    const top = new Float32Array(n);
    for (let i = 0; i < n; i++) { const sc = Math.min(1, maxT / Math.max(1e-6, tot[i] * unit)); top[i] = mid - tot[i] * unit * sc / 2; lv.forEach(a => { a[i] *= unit * sc; }); }
    const base = Float32Array.from(top);
    const alpha = 0.9 - 0.55 * aNote;
    this.stems.forEach((s, si) => {
      const a = lv[si];
      g.beginPath();
      for (let i = 0; i < n; i++) { const y = base[i]; i ? g.lineTo(xs[i], y) : g.moveTo(xs[i], y); }
      for (let i = n - 1; i >= 0; i--) g.lineTo(xs[i], base[i] + a[i]);
      g.closePath();
      g.fillStyle = s.color; g.globalAlpha = alpha; g.fill();
      g.globalAlpha = alpha * 0.6; g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 0.6;
      g.beginPath(); for (let i = 0; i < n; i++) { const y = base[i]; i ? g.lineTo(xs[i], y) : g.moveTo(xs[i], y); } g.stroke();
      g.globalAlpha = 1;
      for (let i = 0; i < n; i++) base[i] += a[i];
    });
    this._riverTop = top; this._riverXs = xs; this._riverLv = lv;
  }

  melY(m) { const rl = this.lane.river; return rl.y + 8 + (1 - (m - this.melLo) / (this.melHi - this.melLo)) * (rl.h * 0.6); }
  bassY(m) { const rl = this.lane.river; return rl.y + rl.h * 0.7 + (1 - (m - this.bLo) / Math.max(1, this.bHi - this.bLo)) * (rl.h * 0.27); }

  drawMelody(g, aArr, aNote, dark) {
    const x0 = ML, x1 = this.W - MR, rl = this.lane.river;
    // contour (fades out as notes fade in)
    if (this.mel && aNote < 0.98) {
      const m = this.mel, dt = m.dt, i0 = Math.max(0, Math.floor((TL.t0 - m.t0) / dt)), i1 = Math.min(m.midi.length - 1, Math.ceil((TL.t1 - m.t0) / dt));
      const stride = Math.max(1, Math.floor((i1 - i0) / ((x1 - x0) * 1.5)));
      g.save();
      g.globalAlpha = (0.8 + 0.2 * aArr) * (1 - aNote);
      g.strokeStyle = dark ? '#fff6e4' : '#1c1a17'; g.lineWidth = 1.2 + aArr * 1.1; g.lineJoin = 'round';
      if (dark) { g.shadowColor = 'rgba(255,230,180,0.7)'; g.shadowBlur = 6; }
      g.beginPath(); let pen = false, lastX = -9;
      for (let i = i0; i <= i1; i += stride) {
        const v = m.midi[i];
        if (v == null) { pen = false; continue; }
        const x = this.tx(m.t0 + i * dt), y = this.melY(v);
        if (!pen || x - lastX > 6) g.moveTo(x, y); else g.lineTo(x, y);
        pen = true; lastX = x;
      }
      g.stroke(); g.restore();
    }
    if (aNote <= 0.02) return;
    g.save(); g.globalAlpha = aNote;
    // pitch grid (C lines)
    if (this.mel) {
      g.font = '9px system-ui'; g.fillStyle = cssVar('--muted');
      for (let p = Math.ceil(this.melLo); p <= this.melHi; p++) {
        if (p % 12 !== 0) continue;
        const y = this.melY(p); g.fillStyle = rgba(cssVar('--ink'), 0.12); g.fillRect(x0, y, x1 - x0, 1);
        g.fillStyle = cssVar('--muted'); g.fillText(midiName(p), x0 + 2, y - 5);
      }
    }
    // bass notes
    if (this.bassNotes.length) {
      const i0 = Math.max(0, bisect(this.bStarts, TL.t0 - 4));
      g.fillStyle = G.stemHex('bass');
      for (let i = i0; i < this.bassNotes.length && this.bassNotes[i][0] <= TL.t1; i++) {
        const [s, e, p] = this.bassNotes[i]; if (e < TL.t0) continue;
        const a = this.tx(s), b = this.tx(e), y = this.bassY(p);
        rr(g, a, y - 3, Math.max(2, b - a - 1), 6, 2); g.fill();
        if (b - a > 22) { g.fillStyle = '#fff'; g.font = '9px system-ui'; g.fillText(NOTE[p % 12], a + 3, y + 0.5); g.fillStyle = G.stemHex('bass'); }
      }
    }
    // tagged melody notes
    if (this.mnotes.length) {
      const nh = clamp(rl.h * 0.6 / Math.max(6, this.melHi - this.melLo), 5, 14);
      const i0 = Math.max(0, bisect(this.mStarts, TL.t0 - 4));
      for (let i = i0; i < this.mnotes.length && this.mnotes[i][0] <= TL.t1; i++) {
        const [s, e, p, tag, rel, deg] = this.mnotes[i]; if (e < TL.t0) continue;
        const a = this.tx(s), b = this.tx(e), y = this.melY(p), col = G.tagHex(tag, dark);
        g.fillStyle = col; g.strokeStyle = dark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.8)'; g.lineWidth = 1;
        rr(g, a, y - nh / 2, Math.max(2, b - a - 1), nh, 3); g.fill(); g.stroke();
        if (b - a > 16) {
          g.fillStyle = col; g.font = '600 10px system-ui';
          g.fillText(rel === 'R' ? '根' : rel, a + 1, y - nh / 2 - 7);
        }
        if (b - a > 30) { g.fillStyle = tag === 'c' && dark ? '#14100d' : '#fff'; g.font = '9px system-ui'; g.fillText(NOTE[p % 12], a + 3, y + 0.5); }
      }
    }
    g.restore();
  }

  // ------------------------------------------------------------------ overlay + cross-section
  drawOverlay() {
    if (!this.W) return;
    const g = this.ov.getContext('2d');
    g.clearRect(0, 0, this.W, this.H);
    const ph = this.tx(TL.playhead);
    if (ph >= ML && ph <= this.W - MR) {
      g.fillStyle = cssVar('--playhead'); g.fillRect(ph - 0.75, this.lane.arcs.y, 1.5, this.H - this.lane.arcs.y);
    }
    if (this.hoverT != null) {
      const x = this.tx(this.hoverT);
      g.strokeStyle = cssVar('--ink'); g.globalAlpha = 0.55; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x + 0.5, this.lane.arcs.y); g.lineTo(x + 0.5, this.H); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      g.fillStyle = cssVar('--surface-3'); rr(g, x + 4, 1, 54, 15, 3); g.fill();
      g.fillStyle = cssVar('--ink'); g.font = '10px system-ui'; g.textBaseline = 'middle'; g.fillText(fmtTime(this.hoverT, 1), x + 8, 9);
    }
  }
  onPlayhead() {
    if (!this.el.offsetParent) return;
    this.drawOverlay();
    if (this.hoverT == null) this.updateCross();
  }
  updateCross(force = false) {
    const now = performance.now();
    if (!force && now - this._xT < 120) { clearTimeout(this._xTo); this._xTo = setTimeout(() => this.updateCross(true), 130); return; }
    this._xT = now;
    const t = this.hoverT ?? TL.playhead;
    this.side.replaceChildren(...crossSection(this.A, this, t, this.hoverT != null));
  }

  bind() {
    const ov = this.ov;
    ov.addEventListener('mousemove', e => {
      const r = ov.getBoundingClientRect(), x = e.clientX - r.left;
      if (this.drag) {
        const dx = x - this.drag.x;
        if (Math.abs(dx) > 3) this.drag.moved = true;
        if (this.drag.moved) { const dt = -dx / this.pw * (this.drag.t1 - this.drag.t0); TL.setView(this.drag.t0 + dt, this.drag.t1 + dt); }
        return;
      }
      this.hoverT = x >= ML && x <= this.W - MR ? this.xt(x) : null;
      this.drawOverlay(); this.updateCross();
    });
    ov.addEventListener('mouseleave', () => { this.hoverT = null; this.drawOverlay(); this.updateCross(true); });
    ov.addEventListener('mousedown', e => {
      const r = ov.getBoundingClientRect();
      this.drag = { x: e.clientX - r.left, t0: TL.t0, t1: TL.t1, moved: false };
      const up = ev => {
        window.removeEventListener('mouseup', up);
        const d = this.drag; this.drag = null;
        if (d && !d.moved) { const x = ev.clientX - r.left; if (x >= ML) TL.seek(this.xt(x)); }
      };
      window.addEventListener('mouseup', up);
    });
    ov.addEventListener('dblclick', () => TL.fit());
    ov.addEventListener('wheel', e => {
      const r = ov.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || e.altKey) { e.preventDefault(); TL.zoom(Math.exp(e.deltaY * 0.01), this.xt(e.clientX - r.left)); }
      else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) { e.preventDefault(); TL.pan((e.deltaX || e.deltaY) / this.pw * (TL.t1 - TL.t0)); }
    }, { passive: false });
    hideTip();
  }
}

function rr(g, x, y, w, hh, r) {
  r = Math.max(0, Math.min(r, w / 2, hh / 2));
  g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, hh, r); else g.rect(x, y, w, hh);
}
function fit(g, s, w) {
  if (g.measureText(s).width <= w) return s;
  while (s.length > 1 && g.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s.length > 1 ? s + '…' : '';
}

// ================================================================================== cross-section
function crossSection(A, V, t, hovering) {
  const I = A.insight, out = [];
  const R = A.rhythm || {};
  const bi = bisect(V.barStarts, t + 1e-3) - 1;
  const beatI = bisect(V.beats, t + 1e-3) - 1;
  out.push(h('div', { class: 'x-head' }, h('b', {}, fmtTime(t, 1)),
    bi >= 0 ? ` · 第 ${bi + 1} 小节 第 ${R.beat_pos?.[beatI] ?? 1} 拍` : '',
    h('span', { class: 'muted' }, hovering ? '  （鼠标位置）' : '  （播放位置）')));

  // section + phrase
  const si = V.segs.findIndex(s => t >= s.start && t < s.end);
  const sec = I.sections?.[si];
  if (sec) {
    const ph = V.phr.findIndex(p => t >= p.start && t < p.end);
    const inSec = V.phr.filter(p => p.section === si);
    const p = V.phr[ph];
    const barIn = p && bi >= 0 ? bi - p.bars[0] + 1 : null;
    out.push(h('div', { class: 'x-sec' },
      h('span', { class: 'pill', style: { background: sectionColor(sec.label) } }, sec.prime),
      h('span', {}, ` ${sec.hint || '段落'}`, sec.occurrence > 1 ? h('span', { class: 'muted' }, ` · 第 ${sec.occurrence} 次出现`) : ''),
      p ? h('div', { class: 'muted sm' }, `乐句 ${inSec.indexOf(p) + 1}/${inSec.length} · 第 ${barIn}/${p.n_bars} 小节${p.cadence ? ` · 以${G.CAD[p.cadence].cn}收尾` : ''}`) : null));
    if (sec.diff && sec.text?.length) {
      out.push(h('div', { class: 'x-diff' }, h('div', { class: 'x-l' }, `相比 ${sec.diff.vs_prime}`),
        h('ul', {}, ...sec.text.map(x => h('li', {}, x)))));
    }
  }

  // harmony + tension
  const ci = bisect(V.cStarts, t + 1e-6) - 1;
  const c = V.chords[ci];
  const tv = V.tenMean(V.ten.total, t - 0.05, t + 0.05), hv = V.tenMean(V.ten.harmonic, t - 0.05, t + 0.05);
  if (c && c.label !== 'N' && t < c.end) {
    const f = c.func_local || c.function;
    const ks = V.keys.find(k => t >= k.start && t < k.end);
    out.push(row('和声', h('span', {}, h('b', { class: 'x-big' }, c.label), '  ',
      h('span', { class: 'chip', style: { background: G.funcHex(f) } }, c.roman_local || c.roman), ' ', G.FUNC_CN[f] || '',
      ks ? h('div', { class: 'muted sm' }, `所在调：${ks.name_cn}${c.bass ? ` · 转位（低音 ${c.bass}）` : ''} · 置信度 ${fmt((c.confidence ?? 0) * 100, 0)}%`) : null)));
  } else out.push(row('和声', h('span', { class: 'muted' }, '无和弦 / 静音')));
  out.push(row('张力', h('div', { class: 'x-meter' },
    meter(tv, G.tensionCss(tv, 1), '总'), meter(hv, G.tensionCss(hv, 0.8), '和声'),
    h('div', { class: 'muted sm' }, tensionWords(tv, hv)))));

  // cadence nearby
  const nc = V.cads.find(x => x.t >= t - 0.6 && x.t <= t + 6);
  if (nc) {
    const cd = G.CAD[nc.type];
    out.push(row('终止', h('span', {}, h('span', { class: 'chip', style: { background: cd.hex } }, cd.short), ' ',
      nc.t <= t ? '此刻：' : `${fmt(nc.t - t, 1)} 秒后：`, h('b', {}, cd.cn), ` ${nc.from ? nc.from + ' → ' : ''}${nc.to || ''}`,
      h('div', { class: 'muted sm' }, cadenceWords(nc.type)))));
  }

  // melody
  const mi = bisect(V.mStarts, t + 1e-6) - 1, mn = V.mnotes[mi];
  if (mn && t <= mn[1] + 0.05) {
    const [s, e, p, tag, rel, deg] = mn;
    out.push(row('旋律', h('span', {}, h('b', { class: 'x-big' }, midiName(p)), '  ',
      h('span', { class: 'chip', style: { background: G.tagHex(tag, isDark()), color: tag === 'c' && isDark() ? '#14100d' : '#fff' } }, G.TAG[tag].cn),
      h('div', { class: 'muted sm' }, `${rel ? `和弦的 ${G.relCn(rel)}` : ''}${deg ? ` · 调内第 ${deg} 级` : ''} · 时值 ${fmt(e - s, 2)} s`))));
  } else if (V.mel) {
    out.push(row('旋律', h('span', { class: 'muted' }, '人声休止')));
  }

  // stems
  if (V.stems.length) {
    const box = h('div', { class: 'x-stems' });
    for (const s of V.stems) {
      const v = G.sampleAt(s, t);
      const it = A.stems.items.find(x => x.name === s.name);
      const db = seriesAt(it.energy, t);
      box.append(h('div', { class: 'x-stem' + (v < 0.08 ? ' off' : '') },
        h('i', { style: { background: s.color } }), h('span', { class: 'n' }, G.STEM_CN[s.name] || s.name),
        h('span', { class: 'b' }, h('span', { style: { width: `${Math.round(v * 100)}%`, background: s.color } })),
        h('span', { class: 'v' }, db == null ? '' : `${fmt(db, 0)} dB`)));
    }
    out.push(row('乐器', box));
  }

  // loudness / arrangement / groove
  const lu = seriesAt(A.loudness?.short_term, t);
  const act = I.bars?.active?.[bi], dd = I.bars?.drum_density?.[bi];
  out.push(row('响度', h('span', {}, lu != null && lu > -70 ? `${fmt(lu, 1)} LUFS（短期）` : '–',
    sec?.lufs != null ? h('span', { class: 'muted' }, ` · 本段平均 ${fmt(sec.lufs, 1)}`) : '')));
  if (act != null) out.push(row('编曲', h('span', {}, `${act}/${V.stems.length} 轨在响`, dd ? ` · 鼓 ${dd} 击/小节` : '')));

  // production warnings on this bar
  const warn = (I.masking || []).filter(p => (p.per_bar?.[bi] ?? 0) > 0.45);
  for (const p of warn) out.push(h('div', { class: 'x-warn' }, `⚠ ${p.name}：本小节 ${p.band} 频段重叠 ${fmt(p.per_bar[bi] * 100, 0)}%，可能互相掩蔽`));

  // drill-down
  const id = D.id;
  out.push(h('div', { class: 'x-links' }, '下钻：', ...[['harmony', '和声'], ['stems', '乐器分离'], ['drums', '鼓组'], ['melody', '旋律'], ['structure', '曲式']]
    .map(([k, l]) => h('a', { href: `#/a/${id}/${k}` }, l))));
  return out;
}
function row(label, content) { return h('div', { class: 'x-row' }, h('div', { class: 'x-l' }, label), h('div', { class: 'x-c' }, content)); }
function meter(v, col, lab) {
  return h('div', { class: 'x-m' }, h('span', { class: 'ml' }, lab), h('span', { class: 'mb' }, h('span', { style: { width: `${Math.round(v * 100)}%`, background: col } })), h('span', { class: 'mv' }, fmt(v * 100, 0)));
}
function tensionWords(tv, hv) {
  if (tv > 0.72) return hv > 0.55 ? '高张力：和声不稳定 + 能量高，听感在“往前推”' : '高能量段落，但和声本身较稳定';
  if (tv > 0.5) return hv > 0.55 ? '中等张力，和声在制造期待' : '中等张力';
  return hv > 0.55 ? '能量低但和声悬着，安静中的不安' : '放松、稳定';
}
function cadenceWords(type) {
  return {
    PAC: '属 → 主，落在强拍且旋律回到主音：最“完结”的收束',
    IAC: '属 → 主，但不在强拍或旋律未落主音：收得较轻',
    plagal: 'IV → I，“阿们终止”，温和、圣咏感',
    deceptive: '期待回到主和弦，却走向了 vi：故意“骗耳朵”，延长乐句',
    half: '停在属和弦上：像一个问号，等着下一句回答',
  }[type] || '';
}

// ================================================================================== cards
function portraitCardEl(parent, A) {
  const P = A.insight?.portrait;
  if (!P) return;
  const body = card(parent, '歌曲肖像', '把整首歌画成一个可对比的形状：时间从 12 点方向顺时针走一圈，内圈光晕是张力，彩色河流是各乐器能量，外环是和声功能与段落，刻痕是终止式。资料库里每首歌都有自己的肖像。', { png: false, cls: 'portrait-card' });
  const size = 300;
  const dpr = window.devicePixelRatio || 1;
  const cv = h('canvas', { width: size * dpr, height: size * dpr, style: { width: size + 'px', height: size + 'px' } });
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const draw = () => { g.clearRect(0, 0, size, size); drawPortrait(g, P, size / 2, size / 2, size / 2 - 22, { labels: true, progress: TL.playhead / (P.duration || TL.duration) }); };
  draw();
  let last = 0;
  const off = TL.onPlayhead(() => {
    if (!cv.isConnected) return off();
    const n = performance.now(); if (n - last > 250 && cv.offsetParent) { last = n; draw(); }
  });
  cv.style.cursor = 'pointer';
  cv.addEventListener('click', e => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left - size / 2, y = e.clientY - r.top - size / 2;
    let a = Math.atan2(y, x) + Math.PI / 2; if (a < 0) a += Math.PI * 2;
    TL.seek(a / (Math.PI * 2) * (P.duration || TL.duration));
  });
  body.append(h('div', { class: 'portrait-wrap' }, cv));
  body.tools.append(h('button', { class: 'btn ghost sm', onclick: () => downloadPoster(P, A.meta, true) }, '导出海报（深色）'),
    h('button', { class: 'btn ghost sm', onclick: () => downloadPoster(P, A.meta, false) }, '导出海报（浅色）'));
}

function sectionCard(parent, A) {
  const secs = A.insight?.sections || [];
  if (!secs.length) return;
  const body = card(parent, '段落对比 · 每次重复变了什么', '同一个字母代表相似的音乐材料，A′、A″ 表示第 2、3 次出现。右侧列出与上一次相比的变化（乐器进出、响度、鼓的密度、人声音区、调性、和声进行）。点击行跳转。', { png: false });
  const tb = h('div', { class: 'sec-rows' });
  for (const s of secs) {
    tb.append(h('div', { class: 'sec-row', onclick: () => TL.seek(s.start + 0.01) },
      h('span', { class: 'pill', style: { background: sectionColor(s.label) } }, s.prime),
      h('div', { class: 'sec-meta' }, h('b', {}, shortHint(s.hint) || '段落'), h('div', { class: 'muted sm' }, `${fmtTime(s.start, 0)} · ${s.n_bars} 小节 · ${s.lufs != null ? fmt(s.lufs, 1) + ' LUFS' : ''}`)),
      h('div', { class: 'sec-ten' }, h('span', { style: { width: `${Math.round((s.tension ?? 0) * 100)}%`, background: G.tensionCss(s.tension ?? 0, 1) } })),
      h('div', { class: 'sec-diff' }, s.diff ? s.text.map(x => h('span', { class: 'tag' }, x)) : h('span', { class: 'muted sm' }, '首次出现'))));
  }
  body.append(tb);
}

function cadenceCard(parent, A) {
  const I = A.insight, cs = I.cadences || [], ms = I.melody_stats || {};
  const body = card(parent, '终止式 · 乐句 · 旋律与和声', '终止式是乐句的“标点符号”。旋律音按它与当下和弦的关系分为和弦音（稳定）、张力音（9/11/13 音，色彩）和经过/邻音（装饰）。', { png: false });
  if (cs.length) {
    const list = h('div', { class: 'cad-list' });
    for (const c of cs) {
      const cd = G.CAD[c.type];
      list.append(h('div', { class: 'cad', onclick: () => TL.seek(Math.max(0, c.t - 3)) },
        h('span', { class: 'chip', style: { background: cd.hex } }, cd.short), h('b', {}, fmtTime(c.t, 1)),
        h('span', {}, ` ${cd.cn} `), h('span', { class: 'muted' }, `${c.from ? c.from + ' → ' : ''}${c.to || ''} · ${c.key || ''} · ${c.chords.join(' → ')}`)));
    }
    body.append(list);
  } else body.append(h('div', { class: 'muted' }, '没有检测到明确的终止式（流行/电子音乐里很常见：和声循环而不收束）。'));
  if (ms.n) {
    body.append(h('div', { class: 'stack-bar' },
      h('span', { style: { width: `${ms.chord_tone}%`, background: G.tagHex('c', isDark()) }, title: '和弦音' }),
      h('span', { style: { width: `${ms.tension}%`, background: G.tagHex('t', isDark()) }, title: '张力音' }),
      h('span', { style: { width: `${ms.non_chord}%`, background: G.tagHex('n', isDark()) }, title: '经过/邻音' })),
    h('div', { class: 'muted sm' }, `人声旋律 ${ms.n} 个音：和弦音 ${fmt(ms.chord_tone, 0)}% · 张力音 ${fmt(ms.tension, 0)}% · 经过/邻音 ${fmt(ms.non_chord, 0)}%。` +
      (ms.tension > 30 ? '张力音比例较高，旋律色彩丰富（爵士/R&B 倾向）。' : ms.chord_tone > 70 ? '旋律紧贴和弦，听感直接、好唱。' : '')));
  }
}

function grooveCard(parent, A) {
  const gr = A.insight?.groove;
  if (!gr || !gr.per_instrument) return;
  const body = card(parent, '律动 · 微观时值', `相对 16 分音符网格（每格 ${fmt(gr.step_ms, 0)} ms）的平均偏移。正值 = 靠后（laid-back），负值 = 抢拍（pushed）。所有乐器同向偏移时多半是检测延迟，看它们之间的<b>相对</b>差异更有意义。`, { png: false });
  const rows = h('div', { class: 'groove' });
  const span = Math.max(20, ...Object.values(gr.per_instrument).map(v => Math.abs(v.offset_ms) + v.std_ms));
  for (const [k, v] of Object.entries(gr.per_instrument)) {
    const c = 50 + v.offset_ms / span * 50, w = v.std_ms / span * 50;
    rows.append(h('div', { class: 'g-row' }, h('span', { class: 'n' }, v.label || k),
      h('span', { class: 'g-axis' }, h('span', { class: 'g-std', style: { left: `${c - w}%`, width: `${2 * w}%` } }), h('span', { class: 'g-dot', style: { left: `${c}%` } }), h('span', { class: 'g-zero' })),
      h('span', { class: 'v' }, `${v.offset_ms > 0 ? '+' : ''}${fmt(v.offset_ms, 1)} ms ±${fmt(v.std_ms, 0)}`)));
  }
  body.append(rows, h('div', { class: 'muted sm' }, [gr.feel_cn, gr.hihat_swing ? `镲片摇摆比 ${fmt(gr.hihat_swing, 2)}（1.0 = 平直，1.5–2 = 三连音摇摆）` : null, gr.tightness_ms ? `整体离散 ±${fmt(gr.tightness_ms, 0)} ms` : null].filter(Boolean).join(' · ')));
}

function productionCard(parent, A) {
  const I = A.insight, mk = I.masking || [], sc = I.sidechain || {};
  if (!mk.length && !sc.curve) return;
  const body = card(parent, '制作 · 频率掩蔽与 Sidechain', '掩蔽 = 两个声部在同一频段同时出现的程度（基于分轨梅尔谱估计），越高越容易互相“糊”在一起。Sidechain = 底鼓之后其它乐器音量是否被压低（“抽吸感”）。', { png: false });
  for (const p of mk) {
    const lvl = p.mean > 0.45 ? 'critical' : p.mean > 0.28 ? 'warning' : 'good';
    const strip = h('canvas', { class: 'mask-strip', width: 600, height: 18 });
    const g = strip.getContext('2d');
    p.per_bar.forEach((v, i) => { g.fillStyle = G.tensionCss(clamp(v / 0.7, 0, 1), 0.25 + 0.75 * clamp(v / 0.7, 0, 1)); g.fillRect(i / p.per_bar.length * 600, 0, 600 / p.per_bar.length + 0.5, 18); });
    strip.onclick = e => { const r = strip.getBoundingClientRect(); const i = Math.floor((e.clientX - r.left) / r.width * p.per_bar.length); const b = A.rhythm?.bars?.[i]; if (b) TL.seek(b[0]); };
    body.append(h('div', { class: 'mask-row' },
      h('div', {}, h('b', {}, p.name), h('span', { class: 'muted' }, ` ${p.band} · 平均重叠 ${fmt(p.mean * 100, 0)}% · `), h('span', { style: { color: cssVar(`--${lvl}`) } }, p.level),
        p.worst_bars?.length ? h('span', { class: 'muted' }, ` · 最严重：第 ${p.worst_bars.map(i => i + 1).join('、')} 小节`) : ''),
      strip));
  }
  if (sc.curve) {
    const cv = h('canvas', { width: 240, height: 70, class: 'sc-curve' });
    const g = cv.getContext('2d'), c = sc.curve, mn = Math.min(-3, ...c), mx = Math.max(1, ...c);
    g.strokeStyle = cssVar('--axis'); g.beginPath(); g.moveTo(0, 70 * (mx / (mx - mn))); g.lineTo(240, 70 * (mx / (mx - mn))); g.stroke();
    g.fillStyle = cssVar('--playhead'); const kx = sc.pre / (c.length - 1) * 240; g.fillRect(kx, 0, 1.5, 70);
    g.strokeStyle = cssVar('--gold') || '#e8c06a'; g.lineWidth = 2; g.beginPath();
    c.forEach((v, i) => { const x = i / (c.length - 1) * 240, y = (mx - v) / (mx - mn) * 66 + 2; i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    body.append(h('div', { class: 'sc-row' }, cv, h('div', {},
      h('b', {}, sc.detected ? `检测到 sidechain 抽吸：约 ${fmt(sc.depth_db, 1)} dB` : `未见明显 sidechain（压低 ${fmt(sc.depth_db, 1)} dB）`),
      h('div', { class: 'muted sm' }, `曲线 = 底鼓（红线）前后，${(sc.sources || []).map(x => G.STEM_CN[x] || x).join('+')} 的平均电平变化，基于 ${sc.n} 次底鼓。`))));
  }
}
