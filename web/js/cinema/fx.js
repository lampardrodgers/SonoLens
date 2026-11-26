// Cinema mode: palette, typography, drawing helpers and a time-indexed data feed.
import { loadBin } from '../data.js';
import { Player } from '../player.js';

export const W = 1920, H = 1080;

export const PAL = {
  bg: '#0a0807', bg2: '#14100d',
  gold: '#E8C06A', goldHi: '#FFE3A3', goldDim: '#7d6538',
  red: '#E5383B', redHi: '#FF6B5E', redDim: '#6e1c1d',
  cream: '#F3EAD8', ink: '#d9cfbd', gray: '#8b857b', dim: '#4a443d', faint: '#2a2521',
  blue: '#7A9CC6', blueDim: '#34465e', pink: '#E8879A', teal: '#5FB4A6', violet: '#A38BD8',
};
export const STEM_COL = { vocals: PAL.red, drums: PAL.gold, bass: PAL.blue, guitar: PAL.pink, piano: PAL.cream, other: PAL.teal };
export const STEM_CN = { vocals: '人声', drums: '鼓组', bass: '贝斯', guitar: '吉他', piano: '钢琴', other: '其他' };
export const TONE = { red: PAL.red, blue: PAL.blue, gold: PAL.gold };

const SERIF_CN = '"Songti SC","STSong","Noto Serif SC","Source Han Serif SC",serif';
export const F = {
  display: `"Didot","Bodoni 72","Playfair Display","Bodoni MT",${SERIF_CN}`,
  serif: `"Baskerville","Times New Roman",${SERIF_CN}`,
  cn: SERIF_CN,
  num: '"Avenir Next","Helvetica Neue","PingFang SC",sans-serif',
  sans: '"PingFang SC","Avenir Next","Helvetica Neue",sans-serif',
};

export const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, k) => a + (b - a) * k;
export const smooth = k => k * k * (3 - 2 * k);
export const easeOut = k => 1 - Math.pow(1 - clamp(k, 0, 1), 3);
export const easeInOut = k => (k = clamp(k, 0, 1), k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
export const mmss = t => { t = Math.max(0, t); const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };
export const midiName = m => `${NOTE[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;
export const hz2midi = f => 69 + 12 * Math.log2(f / 440);
export const midi2hz = m => 440 * Math.pow(2, (m - 69) / 12);

export function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export const rgba = (h, a) => { const [r, g, b] = hex(h); return `rgba(${r},${g},${b},${a})`; };
export function mix(h1, h2, k) {
  const a = hex(h1), b = hex(h2);
  return `rgb(${Math.round(lerp(a[0], b[0], k))},${Math.round(lerp(a[1], b[1], k))},${Math.round(lerp(a[2], b[2], k))})`;
}

/** Text with optional letter spacing / alpha / shadow. */
export function text(g, s, x, y, o = {}) {
  g.save();
  g.font = `${o.italic ? 'italic ' : ''}${o.weight || 400} ${o.size || 20}px ${o.font || F.sans}`;
  g.fillStyle = o.color || PAL.cream;
  g.textAlign = o.align || 'left';
  g.textBaseline = o.base || 'alphabetic';
  if (o.alpha != null) g.globalAlpha *= o.alpha;
  if ('letterSpacing' in g) g.letterSpacing = `${o.ls || 0}px`;
  if (o.glow) { g.shadowColor = o.glow; g.shadowBlur = o.blur || 18; }
  if (o.maxW) g.fillText(s, x, y, o.maxW); else g.fillText(s, x, y);
  const w = g.measureText(s).width;
  g.restore();
  return w;
}
export function measure(g, s, o = {}) {
  g.save();
  g.font = `${o.weight || 400} ${o.size || 20}px ${o.font || F.sans}`;
  if ('letterSpacing' in g) g.letterSpacing = `${o.ls || 0}px`;
  const w = g.measureText(s).width;
  g.restore();
  return w;
}
/** Wrap text into lines that fit maxW (CJK aware: breaks anywhere). */
export function wrap(g, s, maxW, o = {}) {
  g.save();
  g.font = `${o.weight || 400} ${o.size || 20}px ${o.font || F.sans}`;
  const out = [];
  let line = '';
  for (const ch of s) {
    const tryL = line + ch;
    if (g.measureText(tryL).width > maxW && line) {
      // avoid starting a line with punctuation
      if ('，。、：；！？）》”'.includes(ch)) { out.push(tryL); line = ''; continue; }
      out.push(line); line = ch;
    } else line = tryL;
  }
  if (line) out.push(line);
  g.restore();
  return out;
}

export function line(g, x1, y1, x2, y2, color, w = 1, dash) {
  g.save(); g.strokeStyle = color; g.lineWidth = w; if (dash) g.setLineDash(dash);
  g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.restore();
}
export function circle(g, x, y, r, fill, stroke, lw = 1) {
  g.beginPath(); g.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
}
export function glowDot(g, x, y, r, color, a = 1) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r * 4);
  gr.addColorStop(0, rgba(color, 0.9 * a)); gr.addColorStop(0.25, rgba(color, 0.35 * a)); gr.addColorStop(1, rgba(color, 0));
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r * 4, 0, Math.PI * 2); g.fill();
  circle(g, x, y, r, rgba(mixHex(color, '#ffffff', 0.35), a));
}
export function mixHex(h1, h2, k) {
  const a = hex(h1), b = hex(h2);
  const c = a.map((v, i) => Math.round(lerp(v, b[i], k)));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}
export function roundRect(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  if (w <= 0 || h <= 0) return;
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/** 256-entry RGB lookup for the cinema colour ramps. */
const ramps = {
  ember: [[0, '#0a0807'], [0.25, '#3a0d0f'], [0.5, '#9c1f22'], [0.72, '#E5383B'], [0.88, '#F0A55A'], [1, '#FFF1CF']],
  gold: [[0, '#0a0807'], [0.35, '#3d2c12'], [0.65, '#a7802f'], [0.85, '#E8C06A'], [1, '#FFF6DC']],
  ice: [[0, '#0a0807'], [0.4, '#1d2a3e'], [0.7, '#5f86b8'], [1, '#EAF2FF']],
};
const lutCache = {};
export function lut(name) {
  if (lutCache[name]) return lutCache[name];
  const stops = ramps[name];
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let j = 0; while (j < stops.length - 2 && v > stops[j + 1][0]) j++;
    const [a, ca] = stops[j], [b, cb] = stops[j + 1];
    const k = clamp((v - a) / (b - a), 0, 1);
    const x = hex(ca), y = hex(cb);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = lerp(x[c], y[c], k);
  }
  return (lutCache[name] = out);
}
export function lutColor(name, v) {
  const L = lut(name), i = clamp(Math.round(v * 255), 0, 255) * 3;
  return `rgb(${L[i]},${L[i + 1]},${L[i + 2]})`;
}

/** Colour a u8 heatmap into a canvas (row 0 at the bottom) with a cinema ramp + gamma. */
export function heatCanvas(hm, data, rampName, { gamma = 1.0, floor = 0, alpha = false } = {}) {
  const { rows, cols } = hm;
  const cv = document.createElement('canvas'); cv.width = cols; cv.height = rows;
  const g = cv.getContext('2d');
  const img = g.createImageData(cols, rows), px = img.data;
  const L = lut(rampName);
  const map = new Uint8Array(256);
  for (let v = 0; v < 256; v++) map[v] = clamp(Math.round(Math.pow(clamp((v / 255 - floor) / (1 - floor), 0, 1), gamma) * 255), 0, 255);
  for (let r = 0; r < rows; r++) {
    const y = rows - 1 - r; let o = y * cols * 4; const src = r * cols;
    for (let c = 0; c < cols; c++, o += 4) {
      const m = map[data[src + c]], li = m * 3;
      px[o] = L[li]; px[o + 1] = L[li + 1]; px[o + 2] = L[li + 2]; px[o + 3] = alpha ? m : 255;
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}

// ------------------------------------------------------------------------------------------------
/** Everything a scene needs, indexed by time. Built once per analysis. */
export class Feed {
  constructor(A) { this.A = A; this.S = A.story || {}; this.dur = A.meta.duration; }

  async load() {
    const A = this.A, sp = A.spectral || {}, h = A.harmony || {};
    const want = { cqt: sp.cqt, stft: sp.stft, chroma: h.chroma, ssm: A.structure?.ssm, mel: sp.mel };
    await Promise.all(Object.entries(want).map(async ([k, hm]) => {
      if (!hm) return;
      try { this[k] = { hm, data: await loadBin(hm) }; } catch (e) { console.warn('cinema bin', k, e); }
    }));
    // chroma prefix sums (12 × cols) for "cumulative since 0:00"
    if (this.chroma) {
      const { hm, data } = this.chroma, n = hm.cols;
      const P = new Float32Array(12 * (n + 1));
      for (let r = 0; r < 12; r++) {
        let acc = 0; const base = r * (n + 1);
        for (let c = 0; c < n; c++) { acc += data[r * n + c] / 255; P[base + c + 1] = acc; }
      }
      this.chromaPS = P;
    }
    // stft frequency per row
    this.stftHz = sp.stft?.axis?.values || null;
    // stem energy (linear 0..1 normalised over all stems)
    this.stems = (A.stems?.items || []).filter(s => s.energy?.v?.length);
    let mx = -80;
    for (const s of this.stems) for (const v of s.energy.v) if (v != null) mx = Math.max(mx, v);
    this.stemMax = mx; // dB
    // transcription notes per track, sorted by onset
    this.notes = [];
    for (const [tr, arr] of Object.entries(A.transcription?.tracks || {})) for (const n of arr) this.notes.push({ s: n[0], e: n[1], p: n[2], v: n[3], tr });
    this.notes.sort((a, b) => a.s - b.s);
    this.bars = A.rhythm?.bars || [];
    this.beats = A.rhythm?.beats || [];
    this.onsets = A.rhythm?.onsets || [];
    this.chords = A.harmony?.chords || [];
    this.key = A.harmony?.key || {};
    this.flats = !!this.key.use_flats;
    this.chapters = this.S.chapters || [];
    return this;
  }

  /** Name on the circle of fifths: flats on the flat side, sharps on the sharp side. */
  fifthName(pc, minor = false) {
    pc = ((pc % 12) + 12) % 12;
    const i = FIFTHS.indexOf(minor ? (pc + 3) % 12 : pc);
    return (i >= 7 ? NOTE_FLAT : NOTE)[pc];
  }
  noteName(pc) { return (this.flats ? NOTE_FLAT : NOTE)[((pc % 12) + 12) % 12]; }

  col(hm, t) { return clamp(Math.floor((t - hm.t0) / (hm.t1 - hm.t0) * hm.cols), 0, hm.cols - 1); }
  /** Column of a heatmap at time t as Float32 0..1, linearly interpolated between frames. */
  column(name, t, out) {
    const H = this[name]; if (!H) return null;
    const { hm, data } = H, rows = hm.rows, cols = hm.cols;
    const x = (t - hm.t0) / (hm.t1 - hm.t0) * cols - 0.5;
    const c0 = clamp(Math.floor(x), 0, cols - 1), c1 = clamp(c0 + 1, 0, cols - 1), k = clamp(x - c0, 0, 1);
    out = out && out.length === rows ? out : new Float32Array(rows);
    for (let r = 0; r < rows; r++) out[r] = (data[r * cols + c0] * (1 - k) + data[r * cols + c1] * k) / 255;
    return out;
  }
  /** Mean chroma (12) over [a,b]. */
  chromaRange(a, b) {
    const out = new Float32Array(12);
    if (!this.chromaPS) return out;
    const { hm } = this.chroma, n = hm.cols;
    const ca = this.col(hm, a), cb = Math.max(ca + 1, this.col(hm, b));
    for (let r = 0; r < 12; r++) out[r] = (this.chromaPS[r * (n + 1) + cb] - this.chromaPS[r * (n + 1) + ca]) / (cb - ca);
    return out;
  }
  series(s, t) {
    if (!s || !s.v?.length) return null;
    const x = (t - s.t0) / s.dt; const i = clamp(Math.floor(x), 0, s.v.length - 1), j = clamp(i + 1, 0, s.v.length - 1);
    const a = s.v[i], b = s.v[j];
    if (a == null) return b; if (b == null) return a;
    return lerp(a, b, clamp(x - i, 0, 1));
  }
  lufs(t) { const v = this.series(this.A.loudness?.short_term, t); return v == null || v < -70 ? -70 : v; }
  mlufs(t) { const v = this.series(this.A.loudness?.momentary, t); return v == null || v < -70 ? -70 : v; }
  layers(t) { const L = this.S.layers; return L ? { harm: this.series({ t0: L.t0, dt: L.dt, v: L.harm }, t) || 0, perc: this.series({ t0: L.t0, dt: L.dt, v: L.perc }, t) || 0 } : { harm: 0, perc: 0 }; }
  stemLevel(s, t) { const v = this.series(s.energy, t); return v == null ? 0 : clamp((v + 48) / (this.stemMax + 48), 0, 1); }

  find(arr, t) { // last item with start <= t (arr sorted by .start)
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].start <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  chordIdx(t) { const i = this.find(this.chords, t); return i >= 0 && t < this.chords[i].end + 0.05 ? i : -1; }
  chapterIdx(t) { const i = this.find(this.chapters, t); return Math.max(0, i); }
  barAt(t) {
    const b = this.bars; if (!b.length) return { idx: -1, phase: 0 };
    let lo = 0, hi = b.length - 1, ans = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m][0] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    const [a, e] = b[ans];
    return { idx: ans, start: a, end: e, phase: clamp((t - a) / Math.max(1e-3, e - a), 0, 1) };
  }
  beatAt(t) {
    const b = this.beats; let lo = 0, hi = b.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return { idx: ans, pos: ans >= 0 ? (this.A.rhythm.beat_pos?.[ans] ?? 1) : 0, since: ans >= 0 ? t - b[ans] : 9 };
  }
  bpmAt(t) {
    const g = this.A.rhythm?.bpm, lb = this.A.rhythm?.local_bpm; if (!lb?.t?.length || !g) return g;
    let i = 0; while (i < lb.t.length - 1 && lb.t[i + 1] <= t) i++;
    const v = lb.v[i]; return v && Math.abs(v - g) / g < 0.12 ? v : g; // local tempo only when it is plausible
  }
  keyAt(t) {
    const kt = this.S.key_trail; if (!kt?.t?.length) return this.key.index;
    let i = 0; while (i < kt.t.length - 1 && kt.t[i + 1] <= t) i++; return kt.key[i];
  }
  keyName(k) {
    if (k == null) return '–';
    const pc = k % 12, minor = k >= 12;
    const fl = minor ? [5, 10, 3, 8, 0, 7, 2].includes(pc) : [5, 10, 3, 8, 1, 6].includes(pc);
    return `${(fl ? NOTE_FLAT : NOTE)[pc]} ${minor ? '小调' : '大调'}`;
  }

  /** Audio samples around t from the decoded mix: returns [L, R] Float32Array views (copied). */
  samples(t, n) {
    const buf = Player.mixBuf; if (!buf) return null;
    const sr = buf.sampleRate, i0 = clamp(Math.floor(t * sr) - n, 0, Math.max(0, buf.length - n));
    const L = buf.getChannelData(0).subarray(i0, i0 + n);
    const R = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).subarray(i0, i0 + n);
    return [L, R];
  }
}

/** SonoLens brand mark (lens ring + spectrum bars, crimson "now" bar). (x,y) = centre, s = size in px. */
const MARK = [
  ['M19 9.48A26 26 0 1 1 7.57 23.11', 3.6, 1], ['M13.87 23.55A20 20 0 0 1 20.53 15.62', 2.2, 0.55],
  ['M20 26v12M26 21v22M38 22v20M44 27v10', 3.8, 1],
].map(([d, w, a]) => [new Path2D(d), w, a]);
const MARK_NOW = new Path2D('M32 16v32');
export function drawMark(g, x, y, s, color = '#E8C06A', alpha = 1) {
  g.save(); g.translate(x - s / 2, y - s / 2); g.scale(s / 64, s / 64);
  g.lineCap = 'round'; g.globalAlpha = alpha;
  for (const [p, w, a] of MARK) { g.strokeStyle = color; g.lineWidth = w; g.globalAlpha = alpha * a; g.stroke(p); }
  g.strokeStyle = '#E5383B'; g.lineWidth = 3.8; g.globalAlpha = alpha; g.stroke(MARK_NOW);
  g.restore();
}
