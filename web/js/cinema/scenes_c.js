// Cinema scenes, part C — live, audio-reactive visuals (FFT of the decoded mix + analysis data).
// Same contract as scenes_a/b: key → { title, desc(S), draw(g, S) }. Everything is derived from t,
// so scenes behave while paused or scrubbing; `mem` only smooths numbers.
import {
  PAL, F as FONT, NOTE, STEM_COL, STEM_CN, clamp, lerp, easeOut, mmss, midiName,
  rgba, mixHex, text, line, circle, glowDot, roundRect,
} from './fx.js';
import { noData } from './scenes_a.js';
import { Player } from '../player.js';

const TAU = Math.PI * 2;
const BLACK = new Set([1, 3, 6, 8, 10]);
const CHORD_IV = {
  maj: [0, 4, 7], min: [0, 3, 7], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], '7': [0, 4, 7, 10],
  sus2: [0, 2, 7], sus4: [0, 5, 7], dim: [0, 3, 6], aug: [0, 4, 8], m: [0, 3, 7], m7: [0, 3, 7, 10],
};
const PC_COL = ['#E8C06A', '#F0A55A', '#E5383B', '#E8879A', '#C77FB8', '#A38BD8', '#7A9CC6', '#5F9FD0', '#5FB4A6', '#7FBF7A', '#BFD36A', '#F3EAD8'];
const noteIdx = s => { if (!s) return -1; let i = NOTE.indexOf(s); if (i < 0) i = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'].indexOf(s); return i; };

// ------------------------------------------------------------------------------------------------
// Live FFT of the mix (radix-2, Hann window), cached per (t, n) so cross-fading scenes share work.
const fftTabs = {};
function fftTables(n) {
  if (fftTabs[n]) return fftTabs[n];
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(TAU * i / n); sin[i] = -Math.sin(TAU * i / n); }
  const win = new Float32Array(n); for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(TAU * i / (n - 1));
  return (fftTabs[n] = { rev, cos, sin, win });
}
function fftMag(x, n) {
  const { rev, cos, sin, win } = fftTables(n);
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[rev[i]] = (x[i] || 0) * win[i];
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) for (let k = 0; k < half; k++) {
      const c = cos[k * step], sn = sin[k * step], a = s + k, b = a + half;
      const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]) / (n / 4);
  return out;
}
/** {L, R, M} magnitude spectra (linear) at time t, plus sample rate. null when audio isn't decoded. */
function liveSpec(F, t, n = 2048) {
  const key = `${t.toFixed(4)}|${n}`;
  F._specCache ||= new Map();
  if (F._specCache.has(key)) return F._specCache.get(key);
  const sm = F.samples(t, n); let out = null;
  if (sm && sm[0].length === n) {
    const [L, R] = sm, M = new Float32Array(n);
    for (let i = 0; i < n; i++) M[i] = (L[i] + R[i]) * 0.5;
    out = { L: fftMag(L, n), R: fftMag(R, n), M: fftMag(M, n), sr: Player.mixBuf?.sampleRate || 44100, n, raw: sm };
  }
  if (F._specCache.size > 24) F._specCache.delete(F._specCache.keys().next().value);
  F._specCache.set(key, out);
  return out;
}
const db01 = (m, floor = -78) => clamp((20 * Math.log10(m + 1e-9) - floor) / -floor, 0, 1);
/** Collapse a linear spectrum into nb log-spaced bands between f0..f1 (max magnitude per band). */
function logBands(mag, sr, n, nb, f0 = 40, f1 = 14000, out) {
  out = out && out.length === nb ? out : new Float32Array(nb);
  const hzPer = sr / n;
  for (let b = 0; b < nb; b++) {
    const fa = f0 * Math.pow(f1 / f0, b / nb), fb = f0 * Math.pow(f1 / f0, (b + 1) / nb);
    const ia = Math.max(1, Math.floor(fa / hzPer)), ib = Math.max(ia, Math.ceil(fb / hzPer));
    let m = 0; for (let i = ia; i <= ib && i < mag.length; i++) m = Math.max(m, mag[i]);
    out[b] = m;
  }
  return out;
}
// deterministic hash → [0,1)
const rnd = (a, b = 0) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const bsearch = (arr, t) => { let lo = 0, hi = arr.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
function chordPcs(c) {
  if (!c || c.label === 'N' || c.root == null) return null;
  const iv = CHORD_IV[c.quality] || CHORD_IV.maj;
  const bass = noteIdx(c.bass);
  return { tones: iv.map(i => (c.root + i) % 12), root: c.root, bass: bass >= 0 ? bass : c.root };
}
function chip(g, x, y, s, o = {}) {
  const w = text(g, s, -9999, -9999, { size: o.size || 15, font: o.font || FONT.cn }) + 22;
  roundRect(g, x, y, w, (o.size || 15) + 14, 5);
  g.fillStyle = o.bg || 'rgba(232,192,106,0.08)'; g.fill();
  g.strokeStyle = o.border || 'rgba(232,192,106,0.28)'; g.lineWidth = 1; g.stroke();
  text(g, s, x + 11, y + (o.size || 15) + 4, { size: o.size || 15, font: o.font || FONT.cn, color: o.color || PAL.ink });
  return w;
}

// ================================================================================================
export const scenesC = {
  // ---------------------------------------------------------------------------------------------
  audioring: {
    title: '声波光环',
    desc: () => '实时频谱绕成一圈：低音在顶端，越往下频率越高；中心随低频鼓点脉动',
    draw(g, S) {
      const { F, R, t, mem } = S;
      const cx = R.x + R.w / 2, cy = R.y + R.h / 2 + 6, base = Math.min(R.w, R.h) * 0.24;
      const NB = 96;
      const frame = tt => { const sp = liveSpec(F, tt); return sp ? logBands(sp.M, sp.sr, sp.n, NB, 35, 15000) : null; };
      const cur = frame(t);
      if (!cur) return noData(g, R, '音频');
      // bass energy → pulse
      let bass = 0; for (let b = 0; b < 12; b++) bass = Math.max(bass, db01(cur[b]));
      mem.bass = mem.bass == null ? bass : Math.max(bass, lerp(mem.bass, bass, 0.18));
      const pulse = Math.pow(clamp((mem.bass - 0.45) / 0.5, 0, 1), 1.6);
      const r0 = base * (1 + pulse * 0.12);
      // background halo
      const hg = g.createRadialGradient(cx, cy, r0 * 0.2, cx, cy, r0 * 2.6);
      hg.addColorStop(0, rgba(PAL.red, 0.10 + pulse * 0.22)); hg.addColorStop(0.45, rgba(PAL.gold, 0.05 + pulse * 0.06)); hg.addColorStop(1, rgba(PAL.gold, 0));
      g.fillStyle = hg; g.fillRect(R.x - 40, R.y - 30, R.w + 80, R.h + 60);
      // echoes (earlier frames, fainter and smaller)
      const ring = (bands, rr, alpha, lw, col) => {
        g.beginPath();
        for (let k = 0; k <= NB * 2; k++) {
          const i = k <= NB ? k : NB * 2 - k, v = db01(bands[Math.min(NB - 1, i)]);
          const a = -Math.PI / 2 + k / (NB * 2) * TAU, r = rr + v * v * base * 0.95;
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          k ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.closePath(); g.strokeStyle = rgba(col, alpha); g.lineWidth = lw; g.stroke();
      };
      for (let e = 4; e >= 1; e--) { const b = frame(t - e * 0.07); if (b) ring(b, r0 * (1 - e * 0.035), 0.09 * (5 - e) / 4, 1.2, e > 2 ? PAL.blue : PAL.gold); }
      // bars
      g.save(); g.lineCap = 'round';
      for (let k = 0; k < NB * 2; k++) {
        const i = k < NB ? k : NB * 2 - 1 - k, v = db01(cur[i]);
        const a = -Math.PI / 2 + (k + 0.5) / (NB * 2) * TAU;
        const len = 6 + Math.pow(v, 1.7) * base * 1.15;
        const c = Math.cos(a), s = Math.sin(a);
        const col = mixHex(PAL.gold, PAL.red, clamp(v * 1.3 - 0.35, 0, 1));
        g.strokeStyle = rgba(col, 0.35 + 0.65 * v); g.lineWidth = 4.2;
        if (v > 0.7) { g.shadowColor = col; g.shadowBlur = 14; } else g.shadowBlur = 0;
        g.beginPath(); g.moveTo(cx + c * (r0 + 6), cy + s * (r0 + 6)); g.lineTo(cx + c * (r0 + 6 + len), cy + s * (r0 + 6 + len)); g.stroke();
        // inner reflection
        g.shadowBlur = 0; g.strokeStyle = rgba(PAL.gold, 0.08 + 0.18 * v); g.lineWidth = 2;
        g.beginPath(); g.moveTo(cx + c * (r0 - 6), cy + s * (r0 - 6)); g.lineTo(cx + c * (r0 - 6 - len * 0.22), cy + s * (r0 - 6 - len * 0.22)); g.stroke();
      }
      g.restore();
      circle(g, cx, cy, r0, null, rgba(PAL.goldHi, 0.55 + pulse * 0.4), 1.5);
      // centre disc
      const cg = g.createRadialGradient(cx, cy, 0, cx, cy, r0 * 0.78);
      cg.addColorStop(0, rgba(PAL.red, 0.25 + pulse * 0.45)); cg.addColorStop(1, rgba('#0a0807', 0.0));
      circle(g, cx, cy, r0 * 0.78, cg);
      // beat ticks orbit
      const bt = F.beatAt(t), bar = F.barAt(t);
      for (let i = 0; i < 4; i++) {
        const a = -Math.PI / 2 + i / 4 * TAU, on = bt.pos === i + 1, k = on ? clamp(1 - bt.since / 0.45, 0, 1) : 0;
        glowDot(g, cx + Math.cos(a) * (r0 * 0.62), cy + Math.sin(a) * (r0 * 0.62), 4 + k * 5, i === 0 ? PAL.red : PAL.gold, 0.35 + 0.65 * k);
      }
      const ci = F.chordIdx(t), cd = ci >= 0 ? F.chords[ci] : null;
      text(g, cd && cd.label !== 'N' ? cd.label : '—', cx, cy + 16, { align: 'center', size: 50, font: FONT.display, color: PAL.cream, glow: rgba(PAL.gold, 0.4), blur: 22 });
      text(g, bar.idx >= 0 ? `第 ${bar.idx + 1} 小节` : mmss(t), cx, cy + 50, { align: 'center', size: 16, font: FONT.cn, color: PAL.gray, ls: 2 });
      // frequency labels
      const lab = (f, s) => { const b = Math.log(f / 35) / Math.log(15000 / 35), a = -Math.PI / 2 + b * Math.PI, rr = base * 2.25; text(g, s, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, { align: 'center', size: 13, font: FONT.num, color: PAL.dim }); };
      lab(60, '60 Hz'); lab(250, '250'); lab(1000, '1k'); lab(4000, '4k'); lab(12000, '12k');
    },
  },

  // ---------------------------------------------------------------------------------------------
  particles: {
    title: '粒子风暴',
    desc: () => '每一次起音（新音符或鼓点）都会炸开一团粒子，颜色是当时最响的乐器',
    draw(g, S) {
      const { F, R, t, mem } = S;
      const on = F.onsets; if (!on.length) return noData(g, R, '起音');
      const stems = F.stems;
      const env = F.A.rhythm?.onset_env;
      const life = 2.6, i1 = bsearch(on, t);
      const cx = R.x + R.w / 2, cy = R.y + R.h / 2;
      if (!mem.envMax && env?.v) { let m = 0; for (const v of env.v) if (v > m) m = v; mem.envMax = m || 1; }
      const domCol = tt => {
        let best = null, bv = -1;
        for (const s of stems) { const v = F.stemLevel(s, tt); if (v > bv) { bv = v; best = s; } }
        return best ? (STEM_COL[best.name] || PAL.cream) : PAL.gold;
      };
      // soft vignette field
      const lu = clamp((F.lufs(t) + 40) / 32, 0, 1);
      const bg = g.createRadialGradient(cx, cy, 0, cx, cy, R.h * 0.62);
      bg.addColorStop(0, rgba(PAL.gold, 0.05 + 0.07 * lu)); bg.addColorStop(1, rgba(PAL.gold, 0));
      circle(g, cx, cy, R.h * 0.62, bg);
      g.save(); g.beginPath(); g.rect(R.x - 40, R.y - 20, R.w + 80, R.h + 40); g.clip();
      g.globalCompositeOperation = 'lighter';
      const counts = {};
      for (let i = i1; i >= 0 && t - on[i] < life; i--) {
        const age = t - on[i], k = age / life;
        const str = env?.v ? clamp((F.series(env, on[i]) || 0) / mem.envMax * 1.6, 0.25, 1) : 0.6;
        const col = domCol(on[i] + 0.05);
        counts[col] = (counts[col] || 0) + 1;
        // origin spread across the stage, seeded by onset index
        const ox = R.x + R.w * (0.18 + 0.64 * rnd(i, 1)), oy = R.y + R.h * (0.25 + 0.5 * rnd(i, 2));
        // shockwave
        if (age < 0.9) {
          circle(g, ox, oy, 12 + easeOut(age / 0.9) * 230 * (0.5 + str), null, rgba(col, (1 - age / 0.9) * 0.5 * str), 2);
          circle(g, ox, oy, 6 + easeOut(age / 0.9) * 130 * (0.5 + str), null, rgba(col, (1 - age / 0.9) * 0.25 * str), 1);
        }
        const n = Math.round(36 + 70 * str);
        for (let p = 0; p < n; p++) {
          const a = rnd(i, p * 3 + 7) * TAU, sp = (90 + 420 * Math.pow(rnd(i, p * 3 + 8), 0.7)) * (0.55 + str);
          const D = 1.8, drag = (1 - Math.exp(-age * D)) / D, ev = Math.exp(-age * D);
          const x = ox + Math.cos(a) * sp * drag, y = oy + Math.sin(a) * sp * drag + 30 * age * age;
          const vx = Math.cos(a) * sp * ev, vy = Math.sin(a) * sp * ev + 60 * age;
          const al = Math.pow(1 - k, 1.3) * (0.45 + 0.55 * str);
          const pc = rnd(i, p) < 0.25 ? mixHex(col, '#ffffff', 0.55) : col;
          g.strokeStyle = rgba(pc, al * 0.85); g.lineWidth = 2.2;
          g.beginPath(); g.moveTo(x, y); g.lineTo(x - vx * 0.08, y - vy * 0.08); g.stroke();
          circle(g, x, y, 1.6 + 2.6 * (1 - k) * rnd(i, p * 5 + 1), rgba(pc, al));
        }
        if (age < 0.2) glowDot(g, ox, oy, 10 + 18 * str, col, 1 - age / 0.2);
      }
      g.restore();
      // legend + density
      const dens = F.series(F.A.rhythm?.onset_density, t) || 0;
      text(g, `${dens.toFixed(1)}`, R.x + 4, R.y + R.h - 14, { size: 54, font: FONT.display, color: PAL.goldHi });
      text(g, '次起音 / 秒', R.x + 4 + measureW(g, dens.toFixed(1), 54) + 12, R.y + R.h - 18, { size: 18, font: FONT.cn, color: PAL.gray });
      let lx = R.x + R.w;
      for (const s of [...stems].reverse()) {
        const w = text(g, STEM_CN[s.name] || s.name, -9999, 0, { size: 15, font: FONT.cn });
        lx -= w + 34;
        circle(g, lx, R.y + R.h - 22, 6, STEM_COL[s.name] || PAL.cream);
        text(g, STEM_CN[s.name] || s.name, lx + 12, R.y + R.h - 16, { size: 15, font: FONT.cn, color: PAL.ink });
      }
    },
  },

  // ---------------------------------------------------------------------------------------------
  mixer: {
    title: '调音台',
    desc: () => 'AI 分离出的 6 个分轨各占一条推子：灯柱是此刻电平，顶端小横线是最近 1.5 秒的峰值',
    draw(g, S) {
      const { F, R, t, ch } = S;
      const stems = F.stems; if (!stems.length) return noData(g, R, '分轨');
      const N = stems.length + 1, gap = 18, sw = (R.w - 60 - gap * (N - 1)) / N;
      const x0 = R.x + 60, top = R.y + 70, bot = R.y + R.h - 90, segs = 32, segH = (bot - top) / segs;
      const DBMIN = -48, dbOf = v => DBMIN + v * (0 - DBMIN);
      // dB scale
      for (const d of [0, -6, -12, -18, -24, -36, -48]) {
        const y = bot - (d - DBMIN) / -DBMIN * (bot - top);
        text(g, `${d}`, R.x + 44, y + 5, { align: 'right', size: 13, font: FONT.num, color: PAL.dim });
        line(g, R.x + 50, y, R.x + R.w, y, 'rgba(232,192,106,0.05)', 1);
      }
      const strip = (i, name, label, col, lvl, peak, share, isMaster) => {
        const x = x0 + i * (sw + gap);
        roundRect(g, x, R.y + 4, sw, R.h - 8, 10);
        g.fillStyle = isMaster ? 'rgba(229,56,59,0.05)' : 'rgba(232,192,106,0.035)'; g.fill();
        g.strokeStyle = isMaster ? 'rgba(229,56,59,0.3)' : 'rgba(232,192,106,0.14)'; g.lineWidth = 1; g.stroke();
        circle(g, x + 18, R.y + 30, 6, col);
        text(g, name, x + 32, R.y + 36, { size: 20, font: FONT.cn, color: PAL.cream, weight: 500 });
        text(g, label, x + sw - 12, R.y + 35, { align: 'right', size: 11, font: FONT.num, color: PAL.gray, ls: 1 });
        // LED column
        const mw = sw * 0.32, mx = x + 16;
        const lit = Math.round(lvl * segs);
        for (let s = 0; s < segs; s++) {
          const y = bot - (s + 1) * segH + 1.5, frac = s / segs;
          const c = frac > 0.875 ? PAL.red : frac > 0.72 ? PAL.goldHi : col;
          const on = s < lit;
          g.fillStyle = on ? c : rgba(c, 0.07);
          if (on && s === lit - 1) { g.save(); g.shadowColor = c; g.shadowBlur = 12; g.fillRect(mx, y, mw, segH - 3); g.restore(); }
          else g.fillRect(mx, y, mw, segH - 3);
        }
        // peak hold
        const py = bot - peak * (bot - top);
        line(g, mx - 3, py, mx + mw + 3, py, PAL.cream, 2);
        // fader track + knob (position = this chapter's average level)
        const fx = x + sw * 0.72;
        line(g, fx, top, fx, bot, 'rgba(232,192,106,0.25)', 3);
        const ky = bot - share * (bot - top);
        roundRect(g, fx - 16, ky - 9, 32, 18, 3);
        const kg = g.createLinearGradient(0, ky - 9, 0, ky + 9);
        kg.addColorStop(0, '#d9cfbd'); kg.addColorStop(0.5, '#8b857b'); kg.addColorStop(1, '#3a3129');
        g.fillStyle = kg; g.fill();
        line(g, fx - 12, ky, fx + 12, ky, '#140e0a', 1.5);
        // readout
        const dB = dbOf(lvl);
        text(g, lvl <= 0.001 ? '−∞' : dB.toFixed(1), x + sw / 2, bot + 42, { align: 'center', size: 26, font: FONT.num, color: lvl > 0.875 ? PAL.redHi : PAL.cream, weight: 500 });
        text(g, 'dB', x + sw / 2, bot + 62, { align: 'center', size: 12, font: FONT.num, color: PAL.gray });
      };
      stems.forEach((s, i) => {
        const lvl = F.stemLevel(s, t);
        let peak = lvl; for (let k = 1; k <= 15; k++) peak = Math.max(peak, F.stemLevel(s, t - k * 0.1));
        let avg = 0, n = 0; for (let tt = ch.start; tt < ch.end; tt += 0.5) { avg += F.stemLevel(s, tt); n++; }
        strip(i, STEM_CN[s.name] || s.name, s.name.toUpperCase(), STEM_COL[s.name] || PAL.cream, lvl, peak, n ? avg / n : 0, false);
      });
      // master = momentary loudness
      const mv = lu => clamp((lu + 48) / 48, 0, 1);
      let mp = mv(F.mlufs(t)); for (let k = 1; k <= 15; k++) mp = Math.max(mp, mv(F.mlufs(t - k * 0.1)));
      strip(stems.length, '总线', 'MASTER', PAL.red, mv(F.mlufs(t)), mp, mv(ch.m?.lufs ?? F.S.global?.lufs ?? -14), true);
    },
  },

  // ---------------------------------------------------------------------------------------------
  chordpiano: {
    title: '和弦钢琴',
    desc: () => '当前和弦落在琴键上：金色是和弦音，红色是低音；上方柱子是 12 个音的实时能量',
    draw(g, S) {
      const { F, R, t, mem } = S;
      const chords = F.chords; if (!chords.length) return noData(g, R, '和弦');
      const ci = F.chordIdx(t), cd = ci >= 0 ? chords[ci] : null, pcs = chordPcs(cd);
      // header: big chord + roman + function
      const fnName = { T: '主功能', D: '属功能', S: '下属功能', X: '借用和弦' };
      const lab = cd && cd.label !== 'N' ? cd.label : '—';
      const lw = text(g, lab, R.x, R.y + 74, { size: 86, font: FONT.display, color: PAL.cream, glow: rgba(PAL.gold, 0.3), blur: 26 });
      if (cd?.roman) text(g, cd.roman, R.x + lw + 24, R.y + 46, { size: 34, font: FONT.display, color: cd.function === 'X' ? PAL.red : PAL.gold, italic: true });
      if (cd?.function) text(g, fnName[cd.function] || '', R.x + lw + 24, R.y + 76, { size: 18, font: FONT.cn, color: PAL.gray, ls: 2 });
      // upcoming chords
      let nx = R.x + R.w, shown = 0;
      const ups = []; for (let j = ci + 1; j < chords.length && ups.length < 4; j++) if (chords[j].label !== 'N') ups.push(chords[j]);
      text(g, '接下来', R.x + R.w, R.y + 16, { align: 'right', size: 14, font: FONT.cn, color: PAL.gray, ls: 2 });
      for (let j = ups.length - 1; j >= 0; j--) {
        const c = ups[j], dtc = c.start - t;
        const w = Math.max(92, text(g, c.label, -9999, 0, { size: 30, font: FONT.display }) + 30);
        nx -= w + 10;
        const a = 1 - j * 0.18;
        roundRect(g, nx, R.y + 28, w, 62, 8); g.fillStyle = rgba(c.function === 'X' ? PAL.red : PAL.gold, 0.07 * a); g.fill();
        g.strokeStyle = rgba(c.function === 'X' ? PAL.red : PAL.gold, 0.35 * a); g.lineWidth = 1; g.stroke();
        text(g, c.label, nx + w / 2, R.y + 62, { align: 'center', size: 30, font: FONT.display, color: rgba(PAL.cream, a) });
        text(g, `+${dtc.toFixed(1)}s`, nx + w / 2, R.y + 82, { align: 'center', size: 12, font: FONT.num, color: PAL.gray });
        shown++;
      }
      // chroma bars
      const chroma = F.column('chroma', t, mem.cb); mem.cb = chroma;
      const kbY = R.y + R.h - 230, barTop = R.y + 140, barBot = kbY - 46;
      const kx0 = R.x + 20, kx1 = R.x + R.w - 20;
      // keyboard: two octaves C3..B4
      const lo = 48, whites = []; for (let m = lo; m < lo + 24; m++) if (!BLACK.has(m % 12)) whites.push(m);
      const ww = (kx1 - kx0) / whites.length, kbH = 220;
      const keyX = m => BLACK.has(m % 12) ? [kx0 + (whites.indexOf(m - 1) + 1) * ww - ww * 0.3, ww * 0.6] : [kx0 + whites.indexOf(m) * ww, ww];
      if (chroma) {
        const bw = (kx1 - kx0) / 12;
        for (let pc = 0; pc < 12; pc++) {
          const v = chroma[pc], x = kx0 + pc * bw + 10, h = Math.pow(v, 1.3) * (barBot - barTop);
          const inC = pcs?.tones.includes(pc), col = pc === pcs?.bass ? PAL.red : inC ? PAL.gold : PAL.blueDim;
          const gr = g.createLinearGradient(0, barBot - h, 0, barBot);
          gr.addColorStop(0, rgba(mixHex(col, '#ffffff', inC ? 0.25 : 0), 0.95)); gr.addColorStop(1, rgba(col, 0.15));
          roundRect(g, x, barBot - h, bw - 20, Math.max(2, h), 4); g.fillStyle = gr; g.fill();
          text(g, F.noteName(pc), x + (bw - 20) / 2, barBot + 26, { align: 'center', size: 17, font: FONT.num, color: inC ? PAL.goldHi : PAL.gray, weight: inC ? 600 : 400 });
        }
      }
      // keys
      const lit = new Map();
      if (pcs) {
        lit.set(lo + pcs.bass, 'bass');
        for (const p of pcs.tones) lit.set(lo + 12 + p, lit.get(lo + 12 + p) || 'tone');
      }
      const ka = clamp((t - (cd?.start ?? t)) / 0.25, 0, 1);
      for (const pass of [0, 1]) for (let m = lo; m < lo + 24; m++) {
        const blk = BLACK.has(m % 12); if ((pass === 1) !== blk) continue;
        const [x, w] = keyX(m), kind = lit.get(m), col = kind === 'bass' ? PAL.red : kind ? PAL.gold : null;
        const h = blk ? kbH * 0.62 : kbH;
        roundRect(g, x + 1.5, kbY, w - 3, h, 5);
        g.fillStyle = col ? (blk ? mixHex('#1b1512', col, ka) : mixHex('#d8cfbf', kind === 'bass' ? '#E5383B' : '#D9A441', ka)) : (blk ? '#15100d' : '#d8cfbf');
        g.fill();
        if (col) { g.save(); g.shadowColor = col; g.shadowBlur = 24 * ka; g.fill(); g.restore(); glowDot(g, x + w / 2, kbY - 10, 5, col, ka); }
        if (!blk && m % 12 === 0) text(g, midiName(m), x + w / 2, kbY + kbH - 14, { align: 'center', size: 14, font: FONT.num, color: '#7a7064' });
      }
      if (pcs) {
        const names = pcs.tones.map(p => F.noteName(p)).join(' · ');
        text(g, `和弦音 ${names}   低音 ${F.noteName(pcs.bass)}`, R.x + 4, R.y + 112, { size: 17, font: FONT.cn, color: PAL.ink, ls: 1 });
      }
    },
  },

  // ---------------------------------------------------------------------------------------------
  melody: {
    title: '旋律线',
    desc: () => '人声分轨提取的主旋律音高随时间滚动；横线是调内音，右侧大字是此刻唱到的音',
    draw(g, S) {
      const { F, R, t, mem } = S;
      const mel = F.A.melody?.vocals;
      let get, lo, hi, src = '人声分轨';
      if (mel?.midi?.length && (mel.voiced_ratio ?? 1) > 0.03) {
        get = tt => { const i = Math.round((tt - mel.t0) / mel.dt); return i >= 0 && i < mel.midi.length ? mel.midi[i] : null; };
        lo = Math.floor((mel.low_midi ?? 55) - 3); hi = Math.ceil((mel.high_midi ?? 79) + 3);
      } else {
        const notes = F.notes; if (!notes.length) return noData(g, R, '旋律');
        src = '转录最高声部';
        get = tt => { let best = null; const i = bsearch(notes.map ? (mem.ns ||= notes.map(n => n.s)) : [], tt); for (let j = i; j >= 0 && j > i - 60; j--) { const n = notes[j]; if (n.e > tt && (best == null || n.p > best)) best = n.p; } return best; };
        const ps = notes.map(n => n.p).sort((a, b) => a - b); lo = ps[Math.floor(ps.length * 0.05)] - 2; hi = ps[Math.floor(ps.length * 0.99)] + 2;
      }
      if (hi - lo < 18) { const c = (hi + lo) / 2; lo = Math.floor(c - 9); hi = Math.ceil(c + 9); }
      const x0 = R.x + 64, x1 = R.x + R.w - 250, y0 = R.y + 20, y1 = R.y + R.h - 30;
      const past = 8, fut = 2.5, nowX = x0 + (x1 - x0) * past / (past + fut);
      const xOf = tt => nowX + (tt - t) / (past + fut) * (x1 - x0), yOf = m => y1 - (m - lo) / (hi - lo) * (y1 - y0);
      const ki = F.keyAt(t) ?? F.key.index ?? 0, tonic = ki % 12, scale = (ki >= 12 ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map(i => (tonic + i) % 12);
      for (let m = Math.ceil(lo); m <= hi; m++) {
        const pc = m % 12, inK = scale.includes(pc), y = yOf(m);
        if (!inK) continue;
        line(g, x0, y, x1, y, pc === tonic ? 'rgba(229,56,59,0.22)' : 'rgba(232,192,106,0.07)', pc === tonic ? 1.4 : 1);
        text(g, midiName(m), x0 - 10, y + 5, { align: 'right', size: 13, font: FONT.num, color: pc === tonic ? PAL.red : PAL.dim });
      }
      // AI transcription notes as faint context bars (the f0 trace is sparse in instrumental passages)
      const notes = F.notes;
      if (notes.length) {
        const ns = mem.ns ||= notes.map(n => n.s), bh = Math.max(3, (y1 - y0) / (hi - lo) * 0.62);
        for (let j = Math.max(0, bsearch(ns, t - past - 6)); j < notes.length && notes[j].s < t + fut; j++) {
          const n = notes[j]; if (n.e < t - past || n.p < lo || n.p > hi || n.tr === 'drums') continue;
          const xa = Math.max(x0, xOf(n.s)), xb = Math.min(x1, xOf(n.e)); if (xb - xa < 1) continue;
          const voc = n.tr === 'vocals', on = n.s <= t && n.e >= t;
          roundRect(g, xa, yOf(n.p) - bh / 2, xb - xa, bh, Math.min(3, bh / 2));
          g.fillStyle = rgba(STEM_COL[n.tr] || PAL.gray, (voc ? 0.32 : 0.16) + (on ? 0.25 : 0)); g.fill();
        }
      }
      // future veil
      const vg = g.createLinearGradient(nowX, 0, x1, 0); vg.addColorStop(0, 'rgba(10,8,7,0)'); vg.addColorStop(1, 'rgba(10,8,7,0.6)');
      // trace
      const step = 0.025;
      g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
      for (const pass of [0, 1]) {
        g.beginPath(); let pen = false, prev = null;
        for (let tt = t - past; tt <= t + fut; tt += step) {
          const m = get(tt);
          if (m == null || m < lo - 1 || m > hi + 1 || (prev != null && Math.abs(m - prev) > 4)) { pen = false; prev = m; continue; }
          const x = xOf(tt), y = yOf(m); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; prev = m;
        }
        if (pass === 0) { g.strokeStyle = rgba(PAL.gold, 0.25); g.lineWidth = 10; g.shadowColor = PAL.gold; g.shadowBlur = 24; }
        else { g.strokeStyle = PAL.goldHi; g.lineWidth = 3; g.shadowBlur = 0; }
        g.stroke();
      }
      g.restore();
      g.fillStyle = vg; g.fillRect(nowX, y0, x1 - nowX, y1 - y0);
      line(g, nowX, y0, nowX, y1, PAL.red, 1.5);
      text(g, '现在', nowX, y0 - 4, { align: 'center', size: 14, font: FONT.cn, color: PAL.red });
      // current note
      const cur = get(t);
      mem.last = cur != null ? cur : mem.last;
      const px = R.x + R.w - 120, py = R.y + R.h * 0.42;
      if (cur != null && cur >= lo - 1 && cur <= hi + 1) {
        glowDot(g, nowX, yOf(cur), 7, PAL.red, 1);
        const near = Math.round(cur), cents = Math.round((cur - near) * 100);
        text(g, midiName(near), px, py, { align: 'center', size: 96, font: FONT.display, color: PAL.cream, glow: rgba(PAL.gold, 0.35), blur: 30 });
        text(g, `${cents >= 0 ? '+' : ''}${cents} 音分`, px, py + 40, { align: 'center', size: 18, font: FONT.cn, color: Math.abs(cents) > 25 ? PAL.redHi : PAL.gray });
        // cents meter
        line(g, px - 80, py + 64, px + 80, py + 64, 'rgba(232,192,106,0.25)', 2);
        line(g, px, py + 56, px, py + 72, PAL.gold, 1.5);
        circle(g, px + clamp(cents, -50, 50) / 50 * 80, py + 64, 6, Math.abs(cents) > 25 ? PAL.red : PAL.goldHi);
      } else {
        text(g, mem.last != null ? midiName(Math.round(mem.last)) : '—', px, py, { align: 'center', size: 96, font: FONT.display, color: PAL.dim });
        let nx = null; for (let tt = t + 0.1; tt < t + 40 && tt < F.dur; tt += 0.1) if (get(tt) != null && get(tt + 0.1) != null) { nx = tt; break; }
        text(g, nx != null && nx - t > 3 ? `间奏中 · ${(nx - t).toFixed(0)} 秒后再唱` : '换气', px, py + 40, { align: 'center', size: 18, font: FONT.cn, color: PAL.gray });
      }
      if (mel) {
        text(g, `音域 ${mel.low}–${mel.high}`, px, py + 120, { align: 'center', size: 17, font: FONT.cn, color: PAL.ink });
        if (mel.vibrato?.rate_hz) text(g, `颤音 ${mel.vibrato.rate_hz} Hz · ±${Math.round(mel.vibrato.depth_cents)} 音分`, px, py + 146, { align: 'center', size: 15, font: FONT.cn, color: PAL.gray });
      }
      text(g, `亮线：${src}音高 · 淡色条：AI 扒谱音符`, px, R.y + R.h - 10, { align: 'center', size: 13, font: FONT.cn, color: PAL.dim });
    },
  },

  // ---------------------------------------------------------------------------------------------
  beatpulse: {
    title: '节拍脉冲',
    desc: () => '每个拍子荡开一圈涟漪，红色是每小节的第一拍；下方是整首歌的速度曲线',
    draw(g, S) {
      const { F, R, t, mem } = S;
      const beats = F.beats; if (!beats.length) return noData(g, R, '节拍');
      const pos = F.A.rhythm?.beat_pos || [];
      const cx = R.x + R.w * 0.34, cy = R.y + R.h * 0.38, maxR = R.h * 0.36;
      const bi = bsearch(beats, t);
      // ripples
      for (let i = bi; i >= 0 && t - beats[i] < 2.4; i--) {
        const age = t - beats[i], down = (pos[i] ?? 1) === 1, k = age / 2.4;
        const r = 30 + easeOut(k) * maxR * (down ? 1.05 : 0.8);
        const col = down ? PAL.red : PAL.gold;
        circle(g, cx, cy, r, null, rgba(col, (1 - k) * (down ? 0.85 : 0.55)), down ? 3 : 1.6);
        if (age < 0.25) circle(g, cx, cy, r * 0.96, null, rgba(mixHex(col, '#ffffff', 0.5), (1 - age / 0.25) * 0.5), 6);
      }
      const b = F.beatAt(t), bar = F.barAt(t), hit = clamp(1 - b.since / 0.35, 0, 1), down = b.pos === 1;
      const cg = g.createRadialGradient(cx, cy, 0, cx, cy, 90 + hit * 30);
      cg.addColorStop(0, rgba(down ? PAL.red : PAL.gold, 0.35 + 0.5 * hit)); cg.addColorStop(1, rgba(PAL.gold, 0));
      circle(g, cx, cy, 90 + hit * 30, cg);
      text(g, b.idx >= 0 ? `${b.pos}` : '·', cx, cy + 34, { align: 'center', size: 104, font: FONT.display, color: down ? PAL.redHi : PAL.cream, glow: rgba(down ? PAL.red : PAL.gold, 0.5), blur: 30 * hit + 8 });
      // beat dots of bar
      const bpb = F.A.rhythm?.beats_per_bar || 4;
      for (let i = 0; i < bpb; i++) {
        const x = cx + (i - (bpb - 1) / 2) * 34, on = i + 1 === b.pos;
        circle(g, x, cy + maxR + 18, on ? 8 : 5, on ? (i === 0 ? PAL.red : PAL.goldHi) : rgba(PAL.gold, 0.25));
      }
      // right panel: counters
      const px = R.x + R.w * 0.74;
      const bpm = F.bpmAt(t) || F.A.rhythm?.bpm || 0;
      text(g, `${Math.round(bpm)}`, px, R.y + 110, { align: 'center', size: 110, font: FONT.display, color: PAL.goldHi });
      text(g, 'BPM', px, R.y + 144, { align: 'center', size: 18, font: FONT.num, color: PAL.gray, ls: 4 });
      text(g, bar.idx >= 0 ? `第 ${bar.idx + 1} 小节` : '前奏', px, R.y + 204, { align: 'center', size: 30, font: FONT.cn, color: PAL.cream });
      text(g, `${F.A.rhythm?.time_signature || '4/4'} 拍 · 第 ${Math.max(0, b.idx + 1)} 拍 / 共 ${beats.length}`, px, R.y + 238, { align: 'center', size: 16, font: FONT.cn, color: PAL.gray });
      // bar phase ring
      const pr = 54, pcy = R.y + 320;
      circle(g, px, pcy, pr, null, 'rgba(232,192,106,0.15)', 6);
      g.save(); g.strokeStyle = PAL.gold; g.lineWidth = 6; g.lineCap = 'round';
      g.beginPath(); g.arc(px, pcy, pr, -Math.PI / 2, -Math.PI / 2 + bar.phase * TAU); g.stroke(); g.restore();
      text(g, '小节进度', px, pcy + 6, { align: 'center', size: 14, font: FONT.cn, color: PAL.gray });
      // tempo curve strip
      if (!mem.tempo) {
        const lb = F.A.rhythm?.local_bpm, gb = F.A.rhythm?.bpm || 120, pts = [];
        if (lb?.t?.length) for (let i = 0; i < lb.t.length; i++) {
          let v = lb.v[i]; if (!v) continue;
          while (v < gb * 0.72) v *= 2; while (v > gb * 1.45) v /= 2;
          pts.push([lb.t[i], v]);
        }
        // smooth
        const sm = pts.map((p, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - 3); j <= Math.min(pts.length - 1, i + 3); j++) { s += pts[j][1]; n++; } return [p[0], s / n]; });
        mem.tempo = sm;
      }
      const sx0 = R.x + 20, sx1 = R.x + R.w - 20, sy0 = R.y + R.h - 92, sy1 = R.y + R.h - 14;
      roundRect(g, sx0, sy0 - 6, sx1 - sx0, sy1 - sy0 + 12, 6); g.fillStyle = 'rgba(232,192,106,0.03)'; g.fill();
      const tp = mem.tempo;
      if (tp.length > 2) {
        let mn = Infinity, mx = -Infinity; for (const [, v] of tp) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
        if (mx - mn < 6) { const c = (mx + mn) / 2; mn = c - 3; mx = c + 3; }
        const X = tt => sx0 + tt / F.dur * (sx1 - sx0), Y = v => sy1 - (v - mn) / (mx - mn) * (sy1 - sy0);
        g.save(); g.beginPath(); tp.forEach(([tt, v], i) => i ? g.lineTo(X(tt), Y(v)) : g.moveTo(X(tt), Y(v)));
        g.strokeStyle = rgba(PAL.gold, 0.35); g.lineWidth = 1.5; g.stroke();
        g.beginPath(); let first = true; for (const [tt, v] of tp) { if (tt > t) break; first ? g.moveTo(X(tt), Y(v)) : g.lineTo(X(tt), Y(v)); first = false; }
        g.strokeStyle = PAL.goldHi; g.lineWidth = 2.5; g.stroke(); g.restore();
        line(g, X(t), sy0 - 6, X(t), sy1 + 6, PAL.red, 1.5);
        text(g, `${Math.round(mx)}`, sx0 + 6, sy0 + 10, { size: 12, font: FONT.num, color: PAL.dim });
        text(g, `${Math.round(mn)}`, sx0 + 6, sy1, { size: 12, font: FONT.num, color: PAL.dim });
        text(g, '速度曲线 BPM', sx1 - 6, sy0 + 10, { align: 'right', size: 13, font: FONT.cn, color: PAL.gray });
      }
    },
  },

  // ---------------------------------------------------------------------------------------------
  stereofield: {
    title: '声场频谱',
    desc: () => '每个点是一个频段：左右位置是它在立体声里的方位，高低是频率，大小是响度',
    draw(g, S) {
      const { F, R, t, mem } = S;
      const sp = liveSpec(F, t, 4096); if (!sp) return noData(g, R, '音频');
      const NB = 150, f0 = 40, f1 = 15000;
      const x0 = R.x + 80, x1 = R.x + R.w - 300, cxm = (x0 + x1) / 2, y0 = R.y + 20, y1 = R.y + R.h - 40, hw = (x1 - x0) / 2;
      const yOf = b => y1 - b / NB * (y1 - y0);
      // grid
      for (const p of [-1, -0.5, 0, 0.5, 1]) line(g, cxm + p * hw, y0, cxm + p * hw, y1, p === 0 ? 'rgba(232,192,106,0.22)' : 'rgba(232,192,106,0.07)', 1, p === 0 ? null : [3, 6]);
      text(g, 'L', x0, y1 + 30, { align: 'center', size: 22, font: FONT.display, color: PAL.blue });
      text(g, 'C', cxm, y1 + 30, { align: 'center', size: 22, font: FONT.display, color: PAL.gold });
      text(g, 'R', x1, y1 + 30, { align: 'center', size: 22, font: FONT.display, color: PAL.pink });
      for (const [f, s] of [[60, '60'], [200, '200'], [1000, '1k'], [4000, '4k'], [12000, '12k']]) {
        const y = yOf(Math.log(f / f0) / Math.log(f1 / f0) * NB);
        line(g, x0 - 8, y, x1, y, 'rgba(232,192,106,0.05)', 1);
        text(g, s, x0 - 14, y + 5, { align: 'right', size: 13, font: FONT.num, color: PAL.dim });
      }
      const frame = (s, alpha, big) => {
        const L = logBands(s.L, s.sr, s.n, NB, f0, f1), Rr = logBands(s.R, s.sr, s.n, NB, f0, f1);
        let wsum = 0, wpan = 0;
        for (let b = 0; b < NB; b++) {
          const l = L[b], r = Rr[b], m = Math.max(l, r), v = db01(m, -72);
          if (v < 0.12) continue;
          const pan = (r - l) / (r + l + 1e-9);
          wsum += v; wpan += Math.abs(pan) * v;
          const x = cxm + clamp(pan * 1.6, -1, 1) * hw, y = yOf(b + 0.5);
          const col = b / NB < 0.33 ? mixHex(PAL.red, PAL.gold, b / NB * 3) : mixHex(PAL.gold, PAL.blue, (b / NB - 0.33) * 1.5);
          if (big) glowDot(g, x, y, 1.5 + v * v * 7, col, alpha * (0.3 + 0.7 * v));
          else circle(g, x, y, 1 + v * 3, rgba(col, alpha * v));
        }
        return wsum ? wpan / wsum : 0;
      };
      for (let e = 5; e >= 1; e--) { const s = liveSpec(F, t - e * 0.06, 4096); if (s) frame(s, 0.25 * (6 - e) / 5, false); }
      const width = frame(sp, 1, true);
      // correlation from samples
      const [L, Rr] = sp.raw; let lr = 0, ll = 0, rr = 0;
      for (let i = 0; i < L.length; i += 2) { lr += L[i] * Rr[i]; ll += L[i] * L[i]; rr += Rr[i] * Rr[i]; }
      const corr = ll * rr > 1e-12 ? lr / Math.sqrt(ll * rr) : 1;
      mem.w = mem.w == null ? width : lerp(mem.w, width, 0.12);
      mem.c = mem.c == null ? corr : lerp(mem.c, corr, 0.12);
      const px = R.x + R.w - 130;
      text(g, `${Math.round(mem.w * 100)}%`, px, R.y + 120, { align: 'center', size: 76, font: FONT.display, color: PAL.goldHi });
      text(g, '频段平均偏离中心', px, R.y + 152, { align: 'center', size: 17, font: FONT.cn, color: PAL.gray, ls: 2 });
      text(g, mem.c.toFixed(2), px, R.y + 280, { align: 'center', size: 64, font: FONT.display, color: mem.c < 0.3 ? PAL.redHi : PAL.cream });
      text(g, '左右相关度', px, R.y + 310, { align: 'center', size: 17, font: FONT.cn, color: PAL.gray, ls: 2 });
      text(g, mem.c > 0.9 ? '接近单声道' : mem.c > 0.5 ? '自然立体声' : mem.c > 0.1 ? '很宽的声场' : '相位风险', px, R.y + 340, { align: 'center', size: 15, font: FONT.cn, color: PAL.ink });
      // correlation bar
      const bx0 = px - 90, bx1 = px + 90, by = R.y + 380;
      line(g, bx0, by, bx1, by, 'rgba(232,192,106,0.2)', 4);
      circle(g, lerp(bx0, bx1, (mem.c + 1) / 2), by, 7, mem.c < 0.3 ? PAL.red : PAL.goldHi);
      text(g, '−1', bx0, by + 24, { align: 'center', size: 12, font: FONT.num, color: PAL.dim });
      text(g, '+1', bx1, by + 24, { align: 'center', size: 12, font: FONT.num, color: PAL.dim });
    },
  },

  // ---------------------------------------------------------------------------------------------
  loudmeter: {
    title: '响度表',
    desc: () => '广播级 EBU R128 响度表：瞬时 / 短期响度指针、到此刻为止的综合响度，以及响度分布',
    draw(g, S) {
      const { F, R, t, mem } = S;
      const Lz = F.A.loudness; if (!Lz?.momentary) return noData(g, R, '响度');
      const gauge = (cx, cy, r, v, label, sub) => {
        const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2, map = x => a0 + clamp((x + 40) / 40, 0, 1) * (a1 - a0);
        // zones
        const zone = (from, to, col) => { g.beginPath(); g.arc(cx, cy, r, map(from), map(to)); g.strokeStyle = col; g.lineWidth = 14; g.stroke(); };
        zone(-40, -23, 'rgba(122,156,198,0.35)'); zone(-23, -14, 'rgba(232,192,106,0.45)'); zone(-14, -9, 'rgba(255,227,163,0.6)'); zone(-9, 0, 'rgba(229,56,59,0.6)');
        for (let d = -40; d <= 0; d += 5) {
          const a = map(d), c = Math.cos(a), s = Math.sin(a);
          line(g, cx + c * (r - 22), cy + s * (r - 22), cx + c * (r - 12), cy + s * (r - 12), PAL.gray, d % 10 ? 1 : 2);
          if (d % 10 === 0) text(g, `${d}`, cx + c * (r - 40), cy + s * (r - 40) + 5, { align: 'center', size: 14, font: FONT.num, color: PAL.gray });
        }
        // -14 target
        const at = map(-14); line(g, cx + Math.cos(at) * (r + 10), cy + Math.sin(at) * (r + 10), cx + Math.cos(at) * (r - 10), cy + Math.sin(at) * (r - 10), PAL.cream, 2);
        const a = map(v), col = v > -9 ? PAL.red : PAL.goldHi;
        g.save(); g.shadowColor = col; g.shadowBlur = 16;
        line(g, cx, cy, cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6), col, 4);
        g.restore();
        circle(g, cx, cy, 12, '#1c1712', col, 2);
        text(g, v <= -69 ? '−∞' : v.toFixed(1), cx, cy + r * 0.55, { align: 'center', size: 54, font: FONT.display, color: PAL.cream });
        text(g, label, cx, cy + r * 0.55 + 30, { align: 'center', size: 18, font: FONT.cn, color: PAL.ink, ls: 2 });
        text(g, sub, cx, cy + r * 0.55 + 52, { align: 'center', size: 12, font: FONT.num, color: PAL.gray, ls: 2 });
      };
      mem.m = mem.m == null ? F.mlufs(t) : lerp(mem.m, F.mlufs(t), 0.35);
      mem.s = mem.s == null ? F.lufs(t) : lerp(mem.s, F.lufs(t), 0.2);
      const r = Math.min(R.h * 0.3, 170);
      gauge(R.x + r + 30, R.y + r + 40, r, mem.m, '瞬时响度', 'MOMENTARY · 400ms');
      gauge(R.x + r * 3 + 90, R.y + r + 40, r, mem.s, '短期响度', 'SHORT-TERM · 3s');
      // running integrated (gated, BS.1770)
      const st = Lz.momentary, n = clamp(Math.floor((t - st.t0) / st.dt), 0, st.v.length);
      let e = 0, c = 0; for (let i = 0; i < n; i++) { const v = st.v[i]; if (v > -70) { e += Math.pow(10, v / 10); c++; } }
      let integ = -70;
      if (c) { const g1 = 10 * Math.log10(e / c) - 10; e = 0; c = 0; for (let i = 0; i < n; i++) { const v = st.v[i]; if (v > g1 && v > -70) { e += Math.pow(10, v / 10); c++; } } if (c) integ = 10 * Math.log10(e / c); }
      const px = R.x + R.w - 170;
      text(g, integ <= -69 ? '−∞' : integ.toFixed(1), px, R.y + 92, { align: 'center', size: 72, font: FONT.display, color: PAL.goldHi });
      text(g, '综合响度 LUFS · 截至此刻', px, R.y + 124, { align: 'center', size: 15, font: FONT.cn, color: PAL.gray });
      const stats = [['全曲综合', `${Lz.integrated_lufs?.toFixed(1)} LUFS`], ['响度范围 LRA', `${Lz.lra?.toFixed(1)} LU`], ['真峰值', `${Lz.true_peak_dbtp?.toFixed(1)} dBTP`], ['最大瞬时', `${Lz.max_momentary?.toFixed(1)} LUFS`]];
      stats.forEach(([k, v], i) => {
        const y = R.y + 172 + i * 40;
        text(g, k, px - 120, y, { size: 16, font: FONT.cn, color: PAL.gray });
        text(g, v, px + 120, y, { align: 'right', size: 18, font: FONT.num, color: PAL.cream });
        line(g, px - 120, y + 12, px + 120, y + 12, 'rgba(232,192,106,0.08)', 1);
      });
      // histogram of short-term so far
      const ss = Lz.short_term, ns = clamp(Math.floor((t - ss.t0) / ss.dt), 0, ss.v.length);
      const bins = new Float32Array(40); let mx = 1;
      for (let i = 0; i < ns; i++) { const v = ss.v[i]; if (v == null || v < -40) continue; const b = clamp(Math.floor(v + 40), 0, 39); bins[b]++; }
      for (const v of bins) mx = Math.max(mx, v);
      const hx0 = R.x + 30, hx1 = R.x + R.w - 30, hy1 = R.y + R.h - 26, hh = 120, bw = (hx1 - hx0) / 40;
      const curB = clamp(Math.floor(mem.s + 40), 0, 39);
      for (let b = 0; b < 40; b++) {
        const h = bins[b] / mx * hh, col = b === curB ? PAL.red : b >= 31 ? mixHex(PAL.gold, PAL.red, 0.5) : PAL.gold;
        roundRect(g, hx0 + b * bw + 2, hy1 - h, bw - 4, Math.max(1, h), 3); g.fillStyle = rgba(col, b === curB ? 1 : 0.55); g.fill();
        if (b % 5 === 0) text(g, `${b - 40}`, hx0 + b * bw, hy1 + 18, { align: 'center', size: 12, font: FONT.num, color: PAL.dim });
      }
      text(g, '短期响度分布（到此刻为止）', hx0, hy1 - hh - 10, { size: 15, font: FONT.cn, color: PAL.gray });
    },
  },

  // ---------------------------------------------------------------------------------------------
  kaleido: {
    title: '万花筒',
    desc: () => '12 个音级化作花瓣对称展开：花瓣越长那个音越响，每一拍转动一格',
    draw(g, S) {
      const { F, R, t, mem } = S;
      const cx = R.x + R.w / 2, cy = R.y + R.h / 2, Rm = Math.min(R.w, R.h) * 0.49;
      const chroma = F.column('chroma', t, mem.c0); mem.c0 = chroma;
      if (!chroma) return noData(g, R, '色度');
      const ch2 = F.column('chroma', t - 0.6, mem.c1); mem.c1 = ch2;
      const ch3 = F.column('chroma', t - 1.4, mem.c2); mem.c2 = ch3;
      const lu = clamp((F.lufs(t) + 36) / 28, 0, 1);
      const b = F.beatAt(t), hit = clamp(1 - b.since / 0.4, 0, 1);
      const rot = (Math.max(0, b.idx) + easeOut(clamp(b.since / 0.3, 0, 1))) * (TAU / 24) + t * 0.03;
      const NSEG = 12;
      g.save(); g.translate(cx, cy);
      const bg = g.createRadialGradient(0, 0, 0, 0, 0, Rm * 1.1);
      bg.addColorStop(0, rgba(PAL.red, 0.12 + 0.2 * hit * lu)); bg.addColorStop(0.6, rgba(PAL.gold, 0.04)); bg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = bg; g.beginPath(); g.arc(0, 0, Rm * 1.1, 0, TAU); g.fill();
      g.globalCompositeOperation = 'lighter';
      const motif = (cv, scale, alpha, wob) => {
        // one wedge: 12 petals across the half-wedge, mirrored by the caller
        for (let pc = 0; pc < 12; pc++) {
          const v = Math.pow(cv[pc], 1.4); if (v < 0.04) continue;
          const a = (pc / 12) * (Math.PI / NSEG), len = Rm * scale * (0.25 + 0.75 * v) * (0.85 + 0.15 * lu);
          const w = 0.06 + 0.1 * v, col = PC_COL[pc];
          g.beginPath(); g.moveTo(0, 0);
          g.quadraticCurveTo(Math.cos(a - w) * len * 0.55, Math.sin(a - w) * len * 0.55, Math.cos(a + wob) * len, Math.sin(a + wob) * len);
          g.quadraticCurveTo(Math.cos(a + w) * len * 0.55, Math.sin(a + w) * len * 0.55, 0, 0);
          g.fillStyle = rgba(col, alpha * (0.08 + 0.22 * v)); g.fill();
          g.strokeStyle = rgba(col, alpha * (0.25 + 0.6 * v)); g.lineWidth = 1; g.stroke();
          circle(g, Math.cos(a + wob) * len, Math.sin(a + wob) * len, 1.5 + 3.5 * v, rgba(mixHex(col, '#ffffff', 0.4), alpha * v));
        }
      };
      for (let s = 0; s < NSEG; s++) {
        for (const flip of [1, -1]) {
          g.save(); g.rotate(rot + s * TAU / NSEG); g.scale(1, flip);
          motif(ch3, 0.55, 0.5, 0.0);
          motif(ch2, 0.8, 0.7, 0.04 * Math.sin(t * 1.3));
          motif(chroma, 1.0, 1.0, 0.06 * Math.sin(t * 0.7 + 1));
          g.restore();
        }
      }
      g.globalCompositeOperation = 'source-over';
      // rings
      circle(g, 0, 0, Rm * (0.98 + 0.02 * hit), null, rgba(PAL.gold, 0.25), 1);
      circle(g, 0, 0, Rm * 0.2 * (1 + hit * 0.2), rgba('#0a0807', 0.75), rgba(PAL.goldHi, 0.6), 1.5);
      // dominant pitch class in the centre
      let best = 0; for (let i = 1; i < 12; i++) if (chroma[i] > chroma[best]) best = i;
      text(g, F.noteName(best), 0, 18, { align: 'center', size: 52, font: FONT.display, color: PC_COL[best], glow: rgba(PC_COL[best], 0.6), blur: 24 });
      g.restore();
      // legend of pitch-class colours
      const lx = R.x + R.w - 8;
      for (let pc = 0; pc < 12; pc++) {
        const y = R.y + 30 + pc * 26;
        circle(g, lx - 50, y - 5, 6, rgba(PC_COL[pc], 0.35 + 0.65 * chroma[pc]));
        text(g, F.noteName(pc), lx - 36, y, { size: 15, font: FONT.num, color: chroma[pc] > 0.5 ? PAL.cream : PAL.gray });
      }
    },
  },

  // ---------------------------------------------------------------------------------------------
  tunnel: {
    title: '声隧道',
    desc: () => '每一拍是一道光环迎面飞来，环的形状就是那一拍的频谱；红环是小节的第一拍',
    draw(g, S) {
      const { F, R, t, mem } = S;
      const beats = F.beats; if (!beats.length || !F.mel) return noData(g, R, '节拍/梅尔频谱');
      const pos = F.A.rhythm?.beat_pos || [];
      const bi = bsearch(beats, t);
      const prevB = bi >= 0 ? beats[bi] : 0, nextB = beats[bi + 1] ?? prevB + 0.5;
      const ph = bi >= 0 ? clamp((t - prevB) / Math.max(0.05, nextB - prevB), 0, 1) : t / 0.5 % 1;
      const vx = R.x + R.w / 2 + Math.sin(t * 0.35) * R.w * 0.05, vy = R.y + R.h / 2 + Math.cos(t * 0.27) * R.h * 0.05;
      const ccx = R.x + R.w / 2, ccy = R.y + R.h / 2;
      const lu = clamp((F.lufs(t) + 36) / 28, 0, 1);
      const FOC = 1.0, RAD = Math.min(R.w, R.h) * 0.55;
      g.save(); g.beginPath(); g.rect(R.x - 40, R.y - 20, R.w + 80, R.h + 40); g.clip();
      // depth fog
      const fg = g.createRadialGradient(vx, vy, 0, vx, vy, R.w * 0.6);
      fg.addColorStop(0, rgba(PAL.gold, 0.12 + 0.12 * lu)); fg.addColorStop(0.3, rgba(PAL.red, 0.05)); fg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = fg; g.fillRect(R.x - 40, R.y - 20, R.w + 80, R.h + 40);
      // streak stars (deterministic, cycle with beat phase)
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 140; i++) {
        const a = rnd(i, 11) * TAU, z0 = rnd(i, 12), z = ((z0 - (Math.max(0, bi) + ph) * 0.18) % 1 + 1) % 1 * 8 + 0.25;
        const rr = (0.4 + rnd(i, 13)) * RAD * 1.6, x = vx + Math.cos(a) * rr * FOC / z, y = vy + Math.sin(a) * rr * FOC / z;
        const x2 = vx + Math.cos(a) * rr * FOC / (z + 0.35), y2 = vy + Math.sin(a) * rr * FOC / (z + 0.35);
        const al = clamp(1 - z / 8, 0, 1) * 0.6;
        line(g, x, y, x2, y2, rgba(i % 5 ? PAL.gold : PAL.blue, al), 1.2);
      }
      // rings: beat k at depth z = (k - bi - ph) + 0.35
      const mel = F.mel.hm, NP = 128;
      const colBuf = mem.cb ||= new Float32Array(mel.rows);
      for (let k = bi + 10; k >= Math.max(0, bi - 1); k--) {
        if (k >= beats.length) continue;
        const z = (k - bi - ph) + 0.45; if (z <= 0.08) continue;
        const sc = FOC / z, alpha = clamp(1.4 - z / 7, 0, 1) * clamp((z - 0.12) / 0.55, 0, 1);
        const c = F.column('mel', beats[k] + 0.04, colBuf);
        const down = (pos[k] ?? 1) === 1, col = down ? PAL.red : (k % 2 ? PAL.gold : PAL.goldHi);
        g.beginPath();
        for (let p = 0; p <= NP; p++) {
          const a = -Math.PI / 2 + p / NP * TAU, q = p <= NP / 2 ? p / (NP / 2) : (NP - p) / (NP / 2);
          let v = 0; if (c) { const ci = q * (mel.rows - 1); for (let d = -3; d <= 3; d++) v += c[clamp(Math.round(ci) + d, 0, mel.rows - 1)]; v /= 7; }
          const r = RAD * 0.42 * (1 + Math.pow(v, 1.5) * 0.45) * sc;
          const x = vx + (ccx - vx) * Math.min(1, 1 / z) + Math.cos(a) * r, y = vy + (ccy - vy) * Math.min(1, 1 / z) + Math.sin(a) * r;
          p ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.closePath();
        g.strokeStyle = rgba(col, alpha * (down ? 0.95 : 0.7)); g.lineWidth = Math.max(1, (down ? 4 : 2.2) * Math.min(2.5, sc));
        g.shadowColor = col; g.shadowBlur = z < 1.5 ? 20 : 0;
        g.stroke(); g.shadowBlur = 0;
      }
      g.restore();
      const b = F.beatAt(t), bar = F.barAt(t);
      text(g, bar.idx >= 0 ? `${bar.idx + 1}` : '—', R.x + 10, R.y + R.h - 20, { size: 60, font: FONT.display, color: PAL.goldHi });
      text(g, `小节 · 第 ${Math.max(1, b.pos)} 拍 · ${Math.round(F.bpmAt(t) || 0)} BPM`, R.x + 12 + measureW(g, bar.idx >= 0 ? `${bar.idx + 1}` : '—', 60, FONT.display) + 10, R.y + R.h - 26, { size: 18, font: FONT.cn, color: PAL.gray });
    },
  },

  // ---------------------------------------------------------------------------------------------
  strings: {
    title: '十二弦',
    desc: () => '12 根弦对应 12 个音：哪个音此刻越响，那根弦振得越猛；红弦是主音，金弦是主和弦音',
    draw(g, S) {
      const { F, R, t, mem, ch } = S;
      const chroma = F.column('chroma', t, mem.cb); mem.cb = chroma;
      if (!chroma) return noData(g, R, '色度');
      const ki = F.keyAt(t) ?? F.key.index ?? 0, tonic = ki % 12, minor = ki >= 12;
      const triad = [tonic, (tonic + (minor ? 3 : 4)) % 12, (tonic + 7) % 12];
      const cum = F.chromaRange(ch.start, Math.max(ch.start + 0.5, t));
      let cmx = 1e-6; for (const v of cum) cmx = Math.max(cmx, v);
      const x0 = R.x + 90, x1 = R.x + R.w - 120, y0 = R.y + 22, y1 = R.y + R.h - 22, sp = (y1 - y0) / 11;
      const amp = sp * 0.95;
      // bridges
      for (const x of [x0, x1]) { roundRect(g, x - 5, y0 - 16, 10, y1 - y0 + 32, 4); g.fillStyle = 'rgba(232,192,106,0.25)'; g.fill(); }
      g.save(); g.lineCap = 'round';
      for (let i = 0; i < 12; i++) {
        const pc = 11 - i, y = y0 + i * sp, v = Math.pow(chroma[pc], 1.2);
        mem.v ||= new Float32Array(12);
        mem.v[pc] = Math.max(v, lerp(mem.v[pc], v, 0.12));
        const A = mem.v[pc] * amp, isT = pc === tonic, isTri = triad.includes(pc);
        const col = isT ? PAL.red : isTri ? PAL.gold : PAL.cream;
        const harm = 1 + (pc % 3), fr = 3.2 + pc * 0.45;
        const draw = (lw, alpha, blur) => {
          g.beginPath();
          for (let s = 0; s <= 120; s++) {
            const u = s / 120, x = lerp(x0, x1, u);
            const w = Math.sin(Math.PI * u) * Math.sin(TAU * fr * t) + 0.35 * Math.sin(Math.PI * u * (harm + 1)) * Math.sin(TAU * fr * (harm + 1) * 0.5 * t + pc);
            const yy = y + A * w;
            s ? g.lineTo(x, yy) : g.moveTo(x, yy);
          }
          g.strokeStyle = rgba(col, alpha); g.lineWidth = lw; g.shadowColor = col; g.shadowBlur = blur; g.stroke();
        };
        if (A > 2) draw(6, 0.12 + 0.25 * mem.v[pc], 22 * mem.v[pc]);
        draw(isT || isTri ? 2.2 : 1.6, 0.3 + 0.7 * mem.v[pc], 0);
        g.shadowBlur = 0;
        // ghost envelope
        if (A > 3) { g.setLineDash([2, 6]); line(g, x0, y - A * 1.2, x1, y - A * 1.2, rgba(col, 0.08), 1); g.setLineDash([]); }
        text(g, F.noteName(pc), x0 - 22, y + 7, { align: 'right', size: 22, font: FONT.display, color: v > 0.4 ? col : rgba(col, 0.55) });
        // chapter cumulative bar
        const bw = (cum[pc] / cmx) * 80;
        roundRect(g, x1 + 20, y - 5, bw, 10, 3); g.fillStyle = rgba(col, 0.5); g.fill();
      }
      g.restore();
      text(g, '本段累计', x1 + 20, y0 - 20, { size: 13, font: FONT.cn, color: PAL.gray });
    },
  },
};

function measureW(g, s, size, font = FONT.display) {
  g.save(); g.font = `400 ${size}px ${font}`; const w = g.measureText(s).width; g.restore(); return w;
}
