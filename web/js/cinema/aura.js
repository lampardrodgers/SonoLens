// 流光 · 音乐心象 — the flagship real-time scene: one picture that is both a light show and a readable
// portrait of what the music is doing right now (raw WebGL2 feedback + bloom, no libraries).
//
// Visual grammar
//   atmosphere  → deep space behind everything: warped nebula, dust lanes and three layers of stars. Hue comes from
//                 mood (major/minor × energy), harmonic tension pulls it toward crimson, loudness sets how bright
//                 it burns, every beat sends a ripple through it.
//   harmony     → a star dial: 12 directions = the 12 pitch classes laid out on the circle of fifths, each with
//                 a fixed hue. Sounding pitch classes grow a petal of coloured smoke and throw a light shaft to the
//                 edge of the frame, so the lit half of the picture *is* the key and a modulation turns the light.
//                 Distance from the centre = pitch height. The polygon joins the tones of the current chord.
//   rhythm      → kick = shockwave + sparks from the core (and a shove to the whole flow), snare = crown flash and
//                 an anamorphic streak, hi-hat = glittering stars, the arcs around the core count the beats, the
//                 three lotus rings breathe with the low / mid / high bands.
//   progression → outer ring = the whole song (section arcs + playhead); every kind of section has its own flow
//                 form (drift / vortex / bloom / surge) and symmetry, so the picture changes when the song does;
//                 the chord strip shows what comes next.
//   instruments → great arcs orbiting outside the dial, one per stem, as long and bright as it is loud.
//   style       → a per-song "visual DNA" from tempo / pulse clarity / percussiveness: groove-driven music
//                 gets hard N-fold geometry and short trails, flowing music gets ink-like swirls and long ones.
//
// Everything luminous is drawn into a small 2D "ink" canvas, uploaded as a texture and fed into a feedback
// buffer that keeps streaming outward — so every note leaves a comet tail. Crisp labels are drawn on top in 2D.
import { PAL, F as FONT, STEM_CN, clamp, lerp, easeOut, text } from './fx.js';
import { sectionColor } from '../ui.js';
import { stemColor } from '../util.js';

const TAU = Math.PI * 2;
const NS = 86, MIDI0 = 24;                 // semitones shown: C1 … C#8
const R_IN = 0.20, R_OUT = 0.72;           // pitch range on the dial (fractions of Rm)
const R_POLY = 0.775, R_NAME = 0.838, R_SEC = 0.905, R_SONG = 0.955;
const INK_SCALE = 0.5;
const QI = { maj: [0, 4, 7], min: [0, 3, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], dim: [0, 3, 6],
  hdim7: [0, 3, 6, 10], aug: [0, 4, 8], sus4: [0, 5, 7], sus2: [0, 2, 7] };
const FUNC_CN = { T: '主', S: '下属', D: '属', X: '借用' };
const STEM_ORDER = ['vocals', 'guitar', 'piano', 'other', 'bass', 'drums'];

// how the light flows — one form per kind of section, so the picture changes with the song's structure
const FORMS = {
  drift:  { cn: '流动', zoom: 0.80, vort: 0.08, petal: 0.00, wave: 0.00, turb: 1.5 },
  vortex: { cn: '旋涡', zoom: 0.85, vort: 0.50, petal: 0.10, wave: 0.00, turb: 0.9 },
  bloom:  { cn: '绽放', zoom: 1.00, vort: 0.14, petal: 0.50, wave: 0.10, turb: 0.7 },
  surge:  { cn: '奔涌', zoom: 1.45, vort: 0.20, petal: 0.20, wave: 0.38, turb: 0.6 },
};

const fpos = pc => ((((pc % 12) + 12) % 12) * 7) % 12;          // position on the circle of fifths (C=0, G=1 …)
const pitchK = s => Math.pow(clamp((s - 4) / 66, 0, 1), 0.85);          // semitone index → 0..1 along the ray (E1 … C7)
const pcAngle = pc => -Math.PI / 2 + fpos(pc) * TAU / 12;

// ------------------------------------------------------------------------------------------ colour (OKLab)
function lab2rgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s]
    .map(v => { v = clamp(v, 0, 1); return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; });
}
const lch = (L, C, hDeg) => [L, C * Math.cos(hDeg * Math.PI / 180), C * Math.sin(hDeg * Math.PI / 180)];
const css = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
const mix3 = (p, q, k) => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
// one fixed hue per pitch class, a smooth wheel around the circle of fifths: sharp side warm → green, flat side blue → magenta
// neighbours on the wheel alternate light / deep so that two adjacent notes never look alike
const PC_RGB = Array.from({ length: 12 }, (_, pc) => { const f = fpos(pc); return lab2rgb(...lch(f % 2 ? 0.70 : 0.87, f % 2 ? 0.20 : 0.16, 25 + f * 30)); });
const WHITE = [1, 0.97, 0.92];
const PC_FIFTHS = new Float32Array(36);                    // the same colours ordered by position on the circle of fifths
for (let k = 0; k < 12; k++) PC_FIFTHS.set(PC_RGB[(k * 7) % 12], k * 3);
const MOOD = { calmDark: lch(0.30, 0.11, 265), hotDark: lch(0.34, 0.17, 318), calmBright: lch(0.34, 0.09, 200), hotBright: lch(0.42, 0.15, 62), tense: lch(0.36, 0.20, 22) };
/** valence (0 dark … 1 bright) × arousal × tension → two atmosphere colours */
function moodColors(val, aro, ten) {
  let m = mix3(mix3(MOOD.calmDark, MOOD.hotDark, aro), mix3(MOOD.calmBright, MOOD.hotBright, aro), val);
  m = mix3(m, MOOD.tense, 0.5 * ten * ten);
  const C = Math.max(0.085, Math.hypot(m[1], m[2])), h = Math.atan2(m[2], m[1]);
  return [lab2rgb(m[0], C * Math.cos(h), C * Math.sin(h)), lab2rgb(m[0] + 0.22, C * 1.2 * Math.cos(h + 0.5), C * 1.2 * Math.sin(h + 0.5))];
}
function moodWords(val, aro, ten) {
  const w = aro < 0.38 ? (val < 0.48 ? '沉静 · 忧郁' : '温柔 · 舒展') : aro < 0.68 ? (val < 0.48 ? '深沉 · 涌动' : '明朗 · 流动') : (val < 0.48 ? '激烈 · 紧绷' : '热烈 · 奔放');
  return ten > 0.68 ? `${w} · 高张力` : w;
}

function sprite(rgb, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), r = size / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
  gr.addColorStop(0, css(mix3(rgb, [1, 1, 1], 0.85), 1)); gr.addColorStop(0.1, css(mix3(rgb, [1, 1, 1], 0.45), 0.85));
  gr.addColorStop(0.3, css(rgb, 0.3)); gr.addColorStop(0.6, css(rgb, 0.07)); gr.addColorStop(1, css(rgb, 0));
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return c;
}
let SPR = null;
function point(rgb, size = 24) {                       // a small hard-cored disc for sparks
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), r = size / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
  gr.addColorStop(0, css(mix3(rgb, [1, 1, 1], 0.6), 1)); gr.addColorStop(0.45, css(mix3(rgb, [1, 1, 1], 0.3), 0.95)); gr.addColorStop(1, css(rgb, 0));
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return c;
}
const sprites = () => (SPR ||= { pc: PC_RGB.map(c => sprite(c)), white: sprite(WHITE), pp: PC_RGB.map(c => point(c)), pw: point(WHITE) });

// ------------------------------------------------------------------------------------------ per-song data
const upper = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; };

/** Visual DNA: how this song's style shapes the picture (all heuristics, derived from the analysis descriptors). */
function makeDna(A) {
  const d = Object.fromEntries((A.descriptors || []).map(x => [x.key, x.value]));
  const R = A.rhythm || {}, bpm = R.bpm || 110, bpb = R.beats_per_bar || 4;
  const pulse = R.pulse_clarity ?? 0.3, dance = d.danceability ?? 0.4, harm = d.harmonic ?? A.spectral?.hpss?.harmonic_share ?? 0.7;
  const k = clamp((0.45 * pulse + 0.55 * dance + 0.6 * (1 - harm) - 0.3) / 0.55, 0, 1);
  const geo = k * k * (3 - 2 * k);                       // 0 = flowing ink … 1 = hard geometry
  const tf = clamp(bpm / 120, 0.55, 1.7);
  const tags = [];
  tags.push(bpm < 72 ? '慢速' : bpm < 100 ? '中慢速' : bpm < 126 ? '中速' : bpm < 150 ? '快速' : '极快');
  tags.push(dance > 0.6 ? '强律动' : dance < 0.32 ? '松弛律动' : '稳定律动');
  if ((R.swing_ratio || 1) > 1.25) tags.push('摇摆');
  tags.push(harm > 0.8 ? '旋律和声主导' : harm < 0.6 ? '打击感强' : '律动与旋律并重');
  tags.push((d.brightness ?? 0.4) > 0.55 ? '音色明亮' : (d.brightness ?? 0.4) < 0.3 ? '音色暗柔' : '音色温润');
  if ((d.dynamics ?? 0.4) > 0.6) tags.push('大起大落'); else if ((d.dynamics ?? 0.4) < 0.2) tags.push('动态平稳');
  const top = (A.stems?.items || []).slice().sort((a, b) => (b.energy_share || 0) - (a.energy_share || 0))[0];
  if (top && top.energy_share > 45 && STEM_CN[top.name] && top.name !== 'other') tags.push(`${STEM_CN[top.name]}主奏`);
  return {
    geo, sym: { 2: 8, 3: 6, 4: 8, 5: 5, 6: 6, 7: 7 }[bpb] || 8, tf, bpb,
    tau: lerp(1.5, 0.6, geo) / Math.sqrt(tf),            // trail half-life (s)
    zoom: (0.32 + 0.28 * (d.energy ?? 0.5)) * tf,        // outward drift (1/s)
    turb: lerp(0.13, 0.03, geo) * (0.7 + 0.6 * (d.complexity ?? 0.5)),
    rot: lerp(0.16, 0.07, geo) * tf, grain: lerp(0.032, 0.02, geo),
    valence: d.valence ?? 0.5, tags, form: geo > 0.62 ? '几何' : geo > 0.3 ? '晶体流' : '流体',
  };
}

class Song {
  constructor(F) {
    const A = this.A = F.A, I = A.insight || {};
    this.F = F; this.dna = makeDna(A);
    const st = (A.loudness?.short_term?.v || []).filter(v => v != null && v > -69).sort((a, b) => a - b);
    this.luHi = st.length ? st[Math.floor(st.length * 0.98)] : -8;
    this.luLo = Math.min(this.luHi - 14, st.length ? st[Math.floor(st.length * 0.05)] - 3 : -40);
    this.drums = {};
    for (const hsrc of A.drums?.hits || []) {
      if (!hsrc.t?.length) continue;
      const vs = (hsrc.v || []).slice().sort((a, b) => a - b), ref = vs.length ? Math.max(0.05, vs[Math.floor(vs.length * 0.9)]) : 1;
      this.drums[hsrc.name] = { t: hsrc.t, v: hsrc.t.map((_, i) => clamp((hsrc.v?.[i] ?? ref) / ref, 0.25, 1.25)), i: 0 };
    }
    // kick / snare: prefer the loudness-true accent list (drums.accents); the pattern-grid `hits` are far too sensitive
    // (ghost notes, bleed) and their strength is not loudness, so without accents keep only the clear local maxima
    const acc = A.drums?.accents;
    for (const name of ['kick', 'snare']) {
      const a = acc?.find(x => x.name === name), d = this.drums[name];
      if (a) { if (a.t.length) this.drums[name] = { t: a.t, v: a.v.map(v => clamp(v, 0.3, 1.3)), i: 0 }; else delete this.drums[name]; }
      else if (d) {
        const t = [], v = [];
        for (let i = 0; i < d.t.length; i++) {
          if (d.v[i] < 0.6) continue;
          let top = true; for (let j = i - 1; j >= 0 && d.t[i] - d.t[j] < 0.12; j--) if (d.v[j] >= d.v[i]) top = false;
          for (let j = i + 1; j < d.t.length && d.t[j] - d.t[i] < 0.12; j++) if (d.v[j] > d.v[i]) top = false;
          if (top) { t.push(d.t[i]); v.push(d.v[i]); }
        }
        this.drums[name] = { t, v, i: 0 };
      }
    }
    this.hasDrums = !!(this.drums.kick || this.drums.snare);
    const secs = I.sections?.length ? I.sections : A.structure?.segments || [];
    this.secs = secs.map(s => ({ start: s.start, end: s.end, label: s.label, prime: s.prime || s.label, hint: (s.hint || '').split(' ')[0], occ: s.occurrence || 0 }));
    const starts = F.bars.map(b => b[0]);
    for (const s of this.secs) { s.bar0 = upper(starts, s.start - 0.05) ; s.nBars = Math.max(1, upper(starts, s.end - 0.05) - s.bar0); }
    // quietest kind of section drifts, the loudest surges, the ones in between alternate vortex / bloom
    const labels = [...new Set(this.secs.map(s => s.label))];
    const ranked = labels.map(l => {
      let sum = 0, n = 0;
      for (const s of this.secs) if (s.label === l) for (let x = s.start + 0.5; x < s.end; x += 1) { sum += this.energy(x); n++; }
      return [l, n ? sum / n : 0];
    }).sort((a, b) => a[1] - b[1]);
    const formOf = {}, SYMS = [this.dna.sym, 6, 12, 5, 8, 7];
    ranked.forEach(([l], i) => {
      const n = ranked.length;
      formOf[l] = n === 1 ? (this.dna.geo > 0.5 ? 'bloom' : 'vortex') : i === n - 1 ? 'surge' : i === 0 && n > 2 ? 'drift' : labels.indexOf(l) % 2 ? 'bloom' : 'vortex';
    });
    for (const s of this.secs) { const li = labels.indexOf(s.label); s.form = FORMS[formOf[s.label]]; s.dir = li % 2 ? -1 : 1; s.sym = SYMS[li % SYMS.length]; }
    const ok = m => m && !m.weak && m.midi?.length ? m : null;
    this.mel = ok(A.melody?.vocals); this.bassMel = ok(A.melody?.bass);
    this.ten = I.tension?.total?.length ? I.tension : null;
    this.onset = A.rhythm?.onset_env || null;
    this.stems = STEM_ORDER.map(n => F.stems.find(s => s.name === n)).filter(Boolean);
    this.bassStem = F.stems.find(s => s.name === 'bass') || null;
    this.cadences = I.cadences || [];
    this.seed = [...String(A.id || A.meta?.title || 'x')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7) / 97;
  }
  energy(t) { return clamp((this.F.mlufs(t) - this.luLo) / (this.luHi - this.luLo), 0, 1); }
  tension(t) {
    const T = this.ten; if (!T) return 0.25 + 0.4 * this.energy(t);
    return T.total[clamp(Math.round((t - T.t0) / T.dt), 0, T.total.length - 1)] ?? 0.3;
  }
  pitch(m, t) { if (!m) return null; const i = Math.round((t - m.t0) / m.dt); return i >= 0 && i < m.midi.length ? m.midi[i] : null; }
  secIdx(t) { for (let i = this.secs.length - 1; i >= 0; i--) if (t >= this.secs[i].start) return i; return this.secs.length ? 0 : -1; }
}

// ------------------------------------------------------------------------------------------ WebGL2 engine
const VS = `#version 300 es
out vec2 vUv;
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const NOISE = `
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
const mat2 M2 = mat2(1.6, -1.2, 1.2, 1.6);
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = M2 * p + vec2(17.1, 9.3); a *= 0.5; } return s; }
float fbm3(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = M2 * p + vec2(17.1, 9.3); a *= 0.5; } return s; }`;
const HEAD = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;`;
// feedback: yesterday's light drifts outward (zoom), turns (rot) and swirls (curl noise), fades, and takes today's ink
const FS_FEED = `${HEAD}
uniform sampler2D uPrev, uInk;
uniform vec2 uAsp, uC;
uniform float uTime, uDt, uZoom, uRot, uVort, uPetal, uWave, uTurb, uSym, uSpin, uGain, uFade, uRm;
uniform vec3 uTint;
${NOISE}
vec2 curl(vec2 p) { float e = 0.06;
  return vec2(fbm3(p + vec2(0, e)) - fbm3(p - vec2(0, e)), fbm3(p - vec2(e, 0)) - fbm3(p + vec2(e, 0))) / (2.0 * e); }
void main() {
  vec2 p = (vUv - uC) * uAsp * 2.0;
  float r = length(p), a = atan(p.y, p.x);
  float star = 1.0 + uPetal * cos(uSym * (a + uSpin));                   // petals: the flow is faster along N spokes
  float wave = 1.0 + uWave * sin(r * 9.0 - uTime * 2.2);                 // surge: the flow pulses in radial bands
  float z = uZoom * star * wave * (0.30 + 0.70 * r);
  vec2 q = p - p / max(r, 1e-3) * min(r, z * uDt);
  float an = (uRot * (1.2 - 0.5 * smoothstep(0.0, 1.2, r)) + uVort / (0.35 + r)) * uDt;   // vortex: the core turns faster → spiral arms
  float cs = cos(an), sn = sin(an);
  q = mat2(cs, -sn, sn, cs) * q;
  q -= curl(p * 1.4 + vec2(0.0, uTime * 0.07)) * uTurb * uDt;
  vec3 prev = texture(uPrev, q / (uAsp * 2.0) + uC).rgb;
  float lum = dot(prev, vec3(0.3, 0.55, 0.15));
  prev = mix(prev, lum * uTint * 1.8, clamp(0.10 * uDt, 0.0, 1.0));     // old light takes the colour of the air only very slowly, so a trail keeps its note's colour
  prev *= uFade;
  vec2 e = smoothstep(vec2(0.0), vec2(0.02), vUv) * smoothstep(vec2(0.0), vec2(0.02), 1.0 - vUv);
  prev *= e.x * e.y;
  vec3 ink = pow(texture(uInk, vUv).rgb, vec3(1.6)) * smoothstep(0.07, 0.24, r);    // the core itself stays out of the trails
  ink *= 1.0 - 0.8 * smoothstep(1.02, 1.07, r / uRm);                               // … and the instrument orbits only leave a faint wake
  o = vec4(min(prev + ink * uGain, vec3(4.0)), 1.0);
}`;
const FS_BLUR = `${HEAD}
uniform sampler2D uTex; uniform vec2 uDir;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.2270270270;
  c += (texture(uTex, vUv + uDir * 1.3846153846).rgb + texture(uTex, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
  c += (texture(uTex, vUv + uDir * 3.2307692308).rgb + texture(uTex, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
  o = vec4(c, 1.0);
}`;
const FS_COMP = `${HEAD}
uniform sampler2D uFb, uB1, uB2, uB3, uInk;
uniform vec2 uAsp, uC;
uniform vec3 uColA, uColB, uColC;
uniform vec3 uPc[12];
uniform float uChroma[12];
uniform vec3 uRp[3];                 // shock ripples: (radius, strength, -)
uniform float uTime, uNow, uEnergy, uTension, uBeat, uShock, uFlash, uGeo, uSym, uSpin, uGrain, uSeed, uKick, uSnare, uHat, uRipR, uRipA, uRm;
${NOISE}
float starLayer(vec2 q, float seed) {
  vec2 id = floor(q), f = fract(q) - 0.5;
  float h = hash(id + seed);
  vec2 off = (vec2(hash(id + seed + 7.13), hash(id + seed + 3.71)) - 0.5) * 0.7;
  float tw = 0.55 + 0.45 * sin(uNow * (1.5 + 5.0 * hash(id + 1.37)) + h * 40.0);
  return smoothstep(0.075, 0.0, length(f - off)) * tw * smoothstep(0.80, 1.0, h);
}
void main() {
  vec2 p = (vUv - uC) * uAsp * 2.0;
  // big drum hits send a ring through the whole picture that bends everything it passes (like a wave in water)
  float r0 = length(p), rim = 0.0; vec2 dn0 = p / max(r0, 1e-3), dp = vec2(0.0);
  for (int i = 0; i < 3; i++) { float dd = r0 - uRp[i].x, gw = exp(-dd * dd * 60.0) * uRp[i].y; dp -= dn0 * dd * gw * 0.9; rim += exp(-dd * dd * 450.0) * uRp[i].y; }
  p += dp; vec2 uvs = vUv + dp / (uAsp * 2.0);
  float r = length(p), a = atan(p.y, p.x);
  float seg = 6.2831853 / uSym, af = abs(mod(a + uSpin, seg) - seg * 0.5);
  vec2 bp = mix(p, r * vec2(cos(af), sin(af)) * 1.3, uGeo) + uSeed;         // geometric styles fold the air into N mirrors
  // ---- deep space: domain-warped clouds, bright filaments, dark dust lanes
  vec2 w = vec2(fbm(bp * 0.9 + vec2(uTime * 0.11, -uTime * 0.07)), fbm(bp * 0.9 + vec2(5.2 - uTime * 0.09, 1.3 + uTime * 0.05)));
  float n = fbm(bp * 1.1 + 2.2 * w);
  float n2 = fbm(bp * 2.3 - 1.7 * w + vec2(7.0, uTime * 0.13));
  float dust = fbm(bp * 1.6 + 2.6 * w.yx + vec2(11.0, 3.0));
  float halo = exp(-r * r * 1.4);
  float cloud = smoothstep(0.30, 0.72, n);
  vec3 bg = uColA * (0.06 + 1.5 * cloud * cloud);
  bg = mix(bg, uColB * 1.05, smoothstep(0.50, 0.80, n) * (0.3 + 0.55 * uEnergy));
  float fil = pow(1.0 - abs(2.0 * n2 - 1.0), 6.0);
  bg += mix(uColB, uColC, 0.45) * fil * (0.2 + cloud) * (0.10 + 0.55 * uEnergy);
  bg *= 1.0 - 0.82 * smoothstep(0.44, 0.68, dust);
  bg += uColC * pow(n2, 3.0) * (0.3 + 1.3 * uEnergy) * (0.25 + halo);
  float rp = r * cos(af);
  bg += uColB * smoothstep(0.93, 1.0, cos(rp * 20.0 - uTime * 1.6)) * uGeo * 0.22 * (0.3 + uEnergy) * exp(-r * 0.9);
  float rip = uRipA * exp(-pow((r - uRipR) * 4.0, 2.0));                    // every beat sends a ripple through the air
  bg *= (0.22 + 0.75 * uEnergy + 0.45 * halo * (0.6 + 0.5 * uBeat)) * (1.0 + 1.3 * rip);
  bg *= mix(1.0, 0.6, smoothstep(0.7, 1.9, r));
  // ---- light shafts: one per pitch class (circle of fifths), as bright as that note is sounding right now
  float fa = mod((1.5707963 - a) * 1.9098593, 12.0), fr = fract(fa);
  int i0 = int(fa) % 12, i1 = (i0 + 1) % 12;
  vec3 ray = uPc[i0] * uChroma[i0] * exp(-fr * fr * 9.0) + uPc[i1] * uChroma[i1] * exp(-(1.0 - fr) * (1.0 - fr) * 9.0);
  vec2 dn = p / max(r, 1e-3);
  float streak = 0.3 + 1.5 * fbm3(dn * 7.0 + vec2(uSeed, uTime * 0.22)) * fbm3(dn * 19.0 - vec2(uTime * 0.31, r * 0.6));
  bg += ray * streak * smoothstep(0.10, 0.55, r) / (1.0 + r * r * 0.45) * (0.35 + 1.1 * uEnergy) * (1.0 + 0.8 * rip);
  // ---- three layers of stars; the kick shoves the near ones, the hi-hat makes them glitter
  float cs1 = cos(uSpin * 0.6), sn1 = sin(uSpin * 0.6);
  vec2 sp = mat2(cs1, -sn1, sn1, cs1) * p;
  float sf = starLayer(sp * 11.0 * (1.0 - 0.06 * uKick), 1.0) + 0.6 * starLayer(sp * 21.0 * (1.0 - 0.03 * uKick) + 40.0, 2.0) + 0.35 * starLayer(p * 33.0 + 80.0, 3.0);
  bg += mix(vec3(1.0, 0.96, 0.9), uColB, 0.3) * sf * (0.3 + 0.5 * uEnergy + 1.4 * uHat);
  // ---- the light itself: feedback trails + bloom + today's ink
  vec2 d = uvs - uC;
  float ca = 0.0012 + 0.011 * uShock;
  vec3 fb = vec3(texture(uFb, uvs - d * ca).r, texture(uFb, uvs).g, texture(uFb, uvs + d * ca).b);
  vec3 bl = texture(uB1, uvs).rgb * 0.45 + texture(uB2, uvs).rgb * 0.45 + texture(uB3, uvs).rgb * 0.4;
  vec3 col = bg + fb * 0.85 + bl * (0.42 + 0.25 * uEnergy) + pow(texture(uInk, uvs).rgb, vec3(1.6)) * (0.3 + 0.8 * (1.0 - smoothstep(0.08, 0.26, r)) + 1.1 * smoothstep(1.02, 1.07, r / uRm));
  col += mix(uColC, vec3(1.0), 0.65) * (1.6 * exp(-r * r * 700.0) + 0.3 * exp(-r * r * 90.0)) * (0.55 + 0.5 * uEnergy + 0.6 * uKick);   // the core: a small sun
  col += uColC * uFlash * 0.3 * (0.35 + halo);
  float flare = exp(-abs(p.y) * 30.0) / (1.0 + p.x * p.x * 1.2);            // anamorphic streak on snare / section change
  col += mix(uColC, vec3(1.0), 0.35) * flare * (0.22 * uSnare + 0.7 * uFlash + 0.07 * uKick);
  col += mix(uColC, vec3(1.0), 0.5) * rim * 0.4;
  col = 1.0 - exp(-col * 1.2);
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.2 + 0.35 * uTension);
  col *= mix(1.0, 0.5, smoothstep(0.6, 1.9, length((vUv - 0.5) * vec2(1.15, 1.0) * 2.0)));
  col += (hash(gl_FragCoord.xy + fract(uNow) * 517.0) - 0.5) * uGrain;
  o = vec4(col, 1.0);
}`;

class Engine {
  constructor() {
    this.cv = document.createElement('canvas');
    this.ink = document.createElement('canvas');
    const gl = this.gl = this.cv.getContext('webgl2', { antialias: false, alpha: false, depth: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) { this.err = 'WebGL2 不可用'; return; }
    try {
      this.hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
      this.pFeed = this.program(FS_FEED); this.pBlur = this.program(FS_BLUR); this.pComp = this.program(FS_COMP);
      this.vao = gl.createVertexArray();
      this.inkTex = this.texture(gl.LINEAR);
      this.w = this.h = 0; this.cur = 0;
    } catch (e) { console.error('aura gl', e); this.err = String(e.message || e); }
  }
  program(fs) {
    const gl = this.gl, mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return { p, loc: new Map() };
  }
  texture(filter) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  target(w, h) {
    const gl = this.gl, tex = this.texture(gl.LINEAR);
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (this.hdr && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.hdr = false; gl.deleteFramebuffer(fb); gl.deleteTexture(tex); return this.target(w, h);
    }
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb, w, h };
  }
  resize(w, h) {
    if (w === this.w && h === this.h) return;
    const gl = this.gl;
    for (const t of [...(this.fbs || []), ...(this.blurs || [])]) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
    this.w = w; this.h = h; this.cv.width = w; this.cv.height = h;
    this.ink.width = Math.ceil(w * INK_SCALE); this.ink.height = Math.ceil(h * INK_SCALE);
    this.fbs = [this.target(w, h), this.target(w, h)];
    this.blurs = [2, 4, 8, 16, 32].flatMap(k => [this.target(w / k, h / k), this.target(w / k, h / k)]);
  }
  clear() {
    const gl = this.gl;
    for (const t of this.fbs || []) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
  }
  pass(P, dst, texs, uni) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.viewport(0, 0, dst ? dst.w : this.w, dst ? dst.h : this.h);
    gl.useProgram(P.p);
    const L = n => { if (!P.loc.has(n)) P.loc.set(n, gl.getUniformLocation(P.p, n)); return P.loc.get(n); };
    let unit = 0;
    for (const [n, t] of Object.entries(texs)) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(L(n), unit++); }
    for (const [n, v] of Object.entries(uni)) {
      if (typeof v === 'number') gl.uniform1f(L(n), v);
      else if (v.length === 2) gl.uniform2f(L(n), v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(L(n), v[0], v[1], v[2]);
      else if (v.length === 12) gl.uniform1fv(L(n), v);
      else gl.uniform3fv(L(n), v);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  render(U) {
    const gl = this.gl;
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    gl.bindTexture(gl.TEXTURE_2D, this.inkTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.ink);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const src = this.fbs[this.cur], dst = this.fbs[1 - this.cur];
    const geom = { uAsp: [this.w / this.h, 1], uC: U.c, uRm: U.rm };
    this.pass(this.pFeed, dst, { uPrev: src.tex, uInk: this.inkTex }, { ...geom, uTime: U.time, uDt: U.dt, uZoom: U.zoom, uRot: U.rot, uVort: U.vort, uPetal: U.petal, uWave: U.wave, uTurb: U.turb,
      uSym: U.sym, uSpin: U.spin, uGain: U.gain, uFade: U.fade, uTint: U.colB });
    this.cur = 1 - this.cur;
    let from = dst;
    for (let i = 0; i < 5; i++) {
      const a = this.blurs[i * 2], b = this.blurs[i * 2 + 1];
      this.pass(this.pBlur, a, { uTex: from.tex }, { uDir: [1 / a.w, 0] });
      this.pass(this.pBlur, b, { uTex: a.tex }, { uDir: [0, 1 / a.h] });
      from = b;
    }
    this.pass(this.pComp, null, { uFb: dst.tex, uB1: this.blurs[1].tex, uB2: this.blurs[5].tex, uB3: this.blurs[9].tex, uInk: this.inkTex },
      { ...geom, uColA: U.colA, uColB: U.colB, uColC: U.colC, uTime: U.time, uNow: U.now, uEnergy: U.energy, uTension: U.tension, uBeat: U.beat,
        uShock: U.shock, uFlash: U.flash, uGeo: U.geo, uSym: U.sym, uSpin: U.spin, uGrain: U.grain, uSeed: U.seed,
        uKick: U.kick, uSnare: U.snare, uHat: U.hat, uRipR: U.ripR, uRipA: U.ripA, uPc: PC_FIFTHS, uChroma: U.chroma, uRp: U.rp });
  }
}

// ------------------------------------------------------------------------------------------ the scene
let eng = null, song = null, st = null;
const newState = () => ({
  lastT: -9, E: 0, Es: 0.3, T: 0.3, kick: 0, snare: 0, hat: 0, shock: 0, flash: 0, beat: 0, beatIdx: -2, si: -1, flow: 0, spin: 0,
  amp: new Float32Array(NS), raw: new Float32Array(NS), rings: [], sparks: [], lastRing: 0,
  colA: [0.05, 0.05, 0.1], colB: [0.2, 0.2, 0.35], colC: [0.8, 0.7, 0.5], poly: null, polyA: 0, root: null, val: 0.5,
  fm: { ...FORMS.vortex }, sym: 8, parts: [], band: [0, 0, 0], chrF: new Float32Array(12), stemLv: new Float32Array(8), ripR: 0, ripA: 0, shake: 0, lastShock: -9, lastHit: -9, shocks: [], rp: new Float32Array(9),
});
const turn = d => { d = (d + Math.PI) % TAU; if (d < 0) d += TAU; return d - Math.PI; };       // shortest signed arc

function advance(F, t, now, dt) {
  const S = song, D = S.dna, dtm = t - st.lastT, seek = !(dtm >= 0 && dtm < 0.5);
  st.playing = dtm > 1e-4; st.lastT = t;
  const k = r => 1 - Math.exp(-dt * r);
  st.E = lerp(st.E, S.energy(t), seek ? 1 : k(7)); st.Es = lerp(st.Es, st.E, seek ? 1 : k(0.7));
  st.T = lerp(st.T, S.tension(t), seek ? 1 : k(2.5));
  for (const [n, r] of [['kick', 9], ['snare', 11], ['hat', 16], ['shock', 7], ['flash', 2.6], ['beat', 6]]) st[n] *= Math.exp(-dt * r);
  // a particle: position / velocity in dial radii, pc = pitch class (-1 = white)
  const emit = (x, y, pc, speed, s, life, spread = 0.9) => {
    if (st.parts.length >= 1200) return;
    const r = Math.hypot(x, y) || 1e-3, j = (Math.random() - 0.5) * spread, c = Math.cos(j), sn = Math.sin(j), ux = x / r, uy = y / r;
    st.parts.push({ x, y, vx: (ux * c - uy * sn) * speed, vy: (ux * sn + uy * c) * speed, pc, s, t0: now, life });
  };
  // The big effect — frame shake + a ripple that bends the whole picture — is kept rare so it stays an event: section
  // changes, and the hardest hits of the song when they land on a downbeat or break a silence. At least a bar apart.
  const bt = F.beatAt(t), bd = 60 / (F.bpmAt(t) || 120);
  const shock = (amp, life) => { st.lastShock = now; st.shocks.push({ t0: now, life, a: amp }); if (st.shocks.length > 3) st.shocks.shift(); st.shake = Math.max(st.shake, Math.min(1, amp)); };
  const impact = (v, life) => {
    const gap = now - st.lastHit, since = now - st.lastShock; st.lastHit = now;
    if (v < 0.95 || st.E < 0.3 || since < bd * 4) return;
    const down = bt.pos === 1 && bt.since < 0.1, breakIn = gap > bd * 1.5;
    if (down || breakIn || (v >= 1.2 && since > bd * 8)) shock(clamp(0.55 + 0.4 * v, 0.6, 1.1) * (breakIn ? 1.15 : 1), life);
  };
  const fire = (name, v) => {
    if (name === 'kick' && S.hasDrums) impact(v, 0.95); else if (name === 'snare') impact(v, 0.75);
    const w = name === 'hihat' ? v : Math.min(1.15, Math.pow(v, 1.6));      // quiet hits stay quiet: only real hits read as hits
    if (name === 'kick') {
      st.kick = Math.max(st.kick, w);
      if (v > 0.7 && now - st.lastRing > 0.12) {
        st.lastRing = now; st.rings.push({ t0: now, life: 0.8, a: 0.42 * w, w: 1 });
        for (let i = 0, n = Math.round(8 + 26 * w); i < n; i++) { const a = Math.random() * TAU; emit(Math.cos(a) * 0.1, Math.sin(a) * 0.1, -1, 0.45 + 0.75 * Math.random(), 0.7 + 0.8 * Math.random(), 0.7 + 0.9 * Math.random(), 0.25); }
      }
    } else if (name === 'snare') { st.snare = Math.max(st.snare, w); st.shock = Math.max(st.shock, 0.75 * w); }
    else if (name === 'hihat') {
      st.hat = Math.max(st.hat, v);
      for (let i = 0, n = 2 + Math.round(v * 3); i < n && st.sparks.length < 90; i++) st.sparks.push({ a: Math.random() * TAU, r: 0.26 + Math.random() * 0.68, t0: now, life: 0.18 + Math.random() * 0.2, s: 0.5 + Math.random() * v });
    }
  };
  for (const name of ['kick', 'snare', 'hihat']) {
    const d = S.drums[name]; if (!d) continue;
    if (seek) d.i = upper(d.t, t);
    else while (d.i < d.t.length && d.t[d.i] <= t + 0.02) fire(name, d.v[d.i++]);      // 20 ms early ≈ the frame it lands on
  }
  if (bt.idx !== st.beatIdx) {
    if (!seek && bt.idx >= 0) { st.beat = bt.pos === 1 ? 1 : 0.55; if (!S.hasDrums) fire('kick', bt.pos === 1 ? 1 : 0.6); }
    st.beatIdx = bt.idx;
  }
  const si = S.secIdx(t);
  if (si !== st.si) {
    if (!seek && st.si >= 0) { shock(1.4, 1.7); st.flash = 1; st.shock = Math.max(st.shock, 0.8); st.rings.push({ t0: now, life: 1.5, a: 0.8, w: 2.4 }); }
    st.si = si;
  }
  const sec = S.secs[si], fmT = sec?.form || FORMS.vortex, kf = seek ? 1 : k(0.9);
  for (const n of ['zoom', 'vort', 'petal', 'wave', 'turb']) st.fm[n] = lerp(st.fm[n], n === 'vort' ? fmT.vort * (sec?.dir || 1) : fmT[n], kf);
  st.sym = sec?.sym || D.sym; st.form = fmT;
  const bph = bt.idx >= 0 ? clamp(bt.since / bd, 0, 1.2) : 1.2;
  st.ripR = bph * 1.9; st.ripA = st.playing ? Math.pow(Math.max(0, 1 - bph), 1.5) * (bt.pos === 1 ? 1 : 0.5) : 0;
  // atmosphere: mode of the local key + the song's own valence → warm/cool; energy and tension do the rest
  const key = F.keyAt(t), minor = key != null && key >= 12;
  st.val = lerp(st.val, clamp(0.55 * (minor ? 0.26 : 0.74) + 0.45 * D.valence, 0, 1), seek ? 1 : k(1.2));
  const [cA, cB] = moodColors(st.val, clamp(st.Es * 0.7 + st.E * 0.3, 0, 1), st.T);
  const ci = F.chordIdx(t), chord = ci >= 0 && F.chords[ci].label !== 'N' && QI[F.chords[ci].quality] ? F.chords[ci] : null;
  st.chord = chord; st.ci = ci;
  const kc = seek ? 1 : k(1.6), ka = seek ? 1 : k(5);
  st.colA = mix3(st.colA, cA, kc); st.colB = mix3(st.colB, cB, kc);
  st.colC = mix3(st.colC, chord ? PC_RGB[chord.root] : mix3(cB, WHITE, 0.3), ka);
  // chord polygon morph
  if (chord) {
    const tg = QI[chord.quality].map(iv => pcAngle(chord.root + iv)).sort((a, b) => a - b);
    while (tg.length < 4) tg.push(tg[tg.length - 1]);
    if (!st.poly || seek) st.poly = tg.slice();
    else for (let i = 0; i < 4; i++) st.poly[i] += turn(tg[i] - st.poly[i]) * k(11);
    st.root = st.root == null || seek ? pcAngle(chord.root) : st.root + turn(pcAngle(chord.root) - st.root) * k(11);
  }
  st.polyA = lerp(st.polyA, chord ? 1 : 0, seek ? 1 : k(6));
  // pitch dial: one amplitude per semitone from the constant-Q spectrum (peaks only, so harmonics do not smear)
  const col = st.col = F.column('cqt', t, st.col), raw = st.raw;
  if (col) {
    let mx = 0;
    for (let s = 0; s < NS; s++) { const i = s * 3; raw[s] = Math.max(col[Math.max(0, i - 1)] || 0, col[i] || 0, col[i + 1] || 0) + 0.0032 * (s - 24); if (raw[s] > mx) mx = raw[s]; }
    const thr = Math.max(0.42, mx - 0.34), gate = clamp((mx - 0.36) / 0.4, 0, 1);
    for (let s = 0; s < NS; s++) {
      const v = raw[s], peak = v >= (raw[s - 1] ?? 0) && v >= (raw[s + 1] ?? 0);
      const a = peak ? Math.pow(clamp((v - thr) / (mx - thr + 1e-3), 0, 1), 1.5) * gate : 0;
      st.amp[s] = lerp(st.amp[s], a, seek ? 1 : a > st.amp[s] ? k(45) : k(6));
    }
  } else st.amp.fill(0);
  st.chr = F.column('chroma', t, st.chr);
  for (let b = 0; b < 3; b++) {                       // low / mid / high energy → the three rings of the lotus
    let mx = 0; for (let s2 = [0, 28, 56][b], e = [28, 56, NS][b]; s2 < e; s2++) if (raw[s2] > mx) mx = raw[s2];
    const v = col ? clamp((mx - 0.34) / 0.45, 0, 1) : 0;
    st.band[b] = lerp(st.band[b], v, seek ? 1 : v > st.band[b] ? k(30) : k(5));
  }
  for (let f = 0; f < 12; f++) { const v = st.chr ? Math.pow(st.chr[(f * 7) % 12], 2) : 0; st.chrF[f] = lerp(st.chrF[f], v, seek ? 1 : k(7)); }
  S.stems.forEach((sm, i) => { st.stemLv[i] = lerp(st.stemLv[i], F.stemLevel(sm, t), seek ? 1 : k(9)); });
  // particles: every sounding note sheds sparks that ride the flow outward
  if (seek) st.parts.length = 0;
  if (st.playing) {
    for (let s2 = 0; s2 < NS; s2++) {
      const a = st.amp[s2]; if (a < 0.12 || Math.random() > a * dt * 30) continue;
      const pc = (MIDI0 + s2) % 12, ang = pcAngle(pc), rr = lerp(R_IN, R_OUT, pitchK(s2));
      emit(Math.cos(ang) * rr, Math.sin(ang) * rr, pc, 0.08 + 0.22 * Math.random() + 0.2 * st.E, 0.6 + a, 1.6 + 2.2 * Math.random());
    }
    const vm = S.pitch(S.mel, t);
    if (vm != null && Math.random() < dt * 45) {
      const ang = pcAngle(Math.round(vm)), rr = lerp(R_IN, R_OUT, pitchK(vm - MIDI0));
      emit(Math.cos(ang) * rr, Math.sin(ang) * rr, -1, 0.1 + 0.3 * Math.random(), 0.8 + 0.6 * Math.random(), 1.2 + 1.6 * Math.random(), 1.6);
    }
  }
  const pl = st.playing ? 1 : 0.3, rotB = D.rot * (0.45 + 0.9 * st.E), vort = st.fm.vort * (0.5 + 0.8 * st.E);
  for (const p of st.parts) {
    const r = Math.hypot(p.x, p.y), an = (rotB + vort / (0.35 + r)) * dt * pl, c = Math.cos(an), sn = Math.sin(an);
    let x = p.x * c + p.y * sn, y = -p.x * sn + p.y * c; const vx = p.vx * c + p.vy * sn, vy = -p.vx * sn + p.vy * c;
    const acc = 1 + 0.45 * dt * pl; p.vx = vx * acc; p.vy = vy * acc;
    p.x = x + p.vx * dt * pl; p.y = y + p.vy * dt * pl;
  }
  st.parts = st.parts.filter(p => now - p.t0 < p.life && Math.abs(p.x) < 2.1 && Math.abs(p.y) < 1.3);
  st.on = S.onset ? clamp((F.series(S.onset, t) || 0) * 1.6, 0, 1) : st.kick;
  const speed = st.playing ? 1 : 0.35;
  st.flow += dt * D.tf * (0.35 + 1.3 * st.E) * speed;
  st.spin += dt * D.rot * 0.35 * speed;
  st.shake *= Math.exp(-dt * 8);
  st.shocks = st.shocks.filter(r => now - r.t0 < r.life && now >= r.t0);
  st.rp.fill(0);
  st.shocks.forEach((r, i) => { const k = (now - r.t0) / r.life; st.rp[i * 3] = lerp(0.06, 2.4, easeOut(k)); st.rp[i * 3 + 1] = r.a * Math.pow(1 - k, 1.4); });
  if (seek) { st.shocks.length = 0; st.rp.fill(0); st.shake = 0; }
  st.rings = st.rings.filter(r => now - r.t0 < r.life);
  st.sparks = st.sparks.filter(p => now - p.t0 < p.life);
  st.seek = seek;
}

/** everything that glows: drawn additively into the small ink canvas (origin = dial centre, units = scene px) */
function drawInk(F, t, now, Rm, ox, oy) {
  const g = eng.ink.getContext('2d'), S = song, D = S.dna, sp = sprites();
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  g.fillStyle = '#000'; g.fillRect(0, 0, eng.ink.width, eng.ink.height);
  g.setTransform(INK_SCALE, 0, 0, INK_SCALE, ox * INK_SCALE, oy * INK_SCALE);
  g.globalCompositeOperation = 'lighter';
  const dot = (img, x, y, r, a) => { if (a <= 0.01 || r <= 0.3) return; g.globalAlpha = Math.min(1, a); g.drawImage(img, x - r, y - r, r * 2, r * 2); };
  const breathe = 0.965 + 0.05 * st.E + 0.03 * st.kick;
  const acc = css(mix3(st.colC, WHITE, 0.35));
  // core + live waveform ring
  dot(sp.pc[st.chord ? st.chord.root : 0], 0, 0, Rm * (0.2 + 0.12 * st.E + 0.1 * st.kick), st.chord ? 0.18 + 0.22 * st.E : 0);
  dot(sp.white, 0, 0, Rm * (0.05 + 0.03 * st.E + 0.05 * st.kick), 0.25 + 0.2 * st.E + 0.25 * st.kick);
  const smp = F.samples(t, 1024);
  if (smp) {
    const [L, Rc] = smp, n = 200, r0 = Rm * 0.088 * (1 + 0.3 * st.kick);
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const j = Math.floor((i % n) / n * 1000), v = clamp((L[j] + Rc[j]) * 0.5, -1, 1), a = i / n * TAU - Math.PI / 2, rr = r0 + v * Rm * 0.05;
      i ? g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.globalAlpha = 0.55 + 0.4 * st.E; g.strokeStyle = acc; g.lineWidth = Math.max(1.4, Rm * 0.005); g.stroke();
  }
  // harmony flower: one petal of coloured smoke per pitch class, as long as that note is strong (the shape IS the chord)
  for (let f = 0; f < 12; f++) {
    const v = st.chrF[f]; if (v < 0.04) continue;
    const pc = (f * 7) % 12, a = pcAngle(pc), r0 = Rm * 0.15, r1 = Rm * (0.3 + 0.5 * Math.sqrt(v)) * breathe, da = 0.2, c = PC_RGB[pc];
    const gr = g.createLinearGradient(Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * r1, Math.sin(a) * r1);
    gr.addColorStop(0, css(c, 0)); gr.addColorStop(0.3, css(c, 0.13 * v)); gr.addColorStop(1, css(c, 0));
    g.globalAlpha = 1; g.fillStyle = gr; g.beginPath();
    g.moveTo(Math.cos(a - da) * r0, Math.sin(a - da) * r0);
    g.quadraticCurveTo(Math.cos(a - da * 1.3) * r1 * 0.62, Math.sin(a - da * 1.3) * r1 * 0.62, Math.cos(a) * r1, Math.sin(a) * r1);
    g.quadraticCurveTo(Math.cos(a + da * 1.3) * r1 * 0.62, Math.sin(a + da * 1.3) * r1 * 0.62, Math.cos(a + da) * r0, Math.sin(a + da) * r0);
    g.closePath(); g.fill();
  }
  // lotus: three petal rings breathing with the low / mid / high bands (the petal count follows the section's symmetry)
  const lotus = (r0, depth, nPet, rot, col, alpha) => {
    if (alpha < 0.02) return;
    const N = nPet * 20; g.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = i / N * TAU, rr = Rm * r0 * breathe * (1 + depth * Math.pow(Math.abs(Math.sin(nPet * 0.5 * (a - rot))), 0.65));
      i ? g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.globalAlpha = Math.min(1, alpha); g.strokeStyle = col; g.lineWidth = Math.max(2.4, Rm * 0.005); g.stroke();
  };
  const ns = st.sym, bnd = st.band, pulse = 0.5 + 0.5 * st.beat;
  lotus(0.215, 0.10 + 0.55 * bnd[0] + 0.25 * st.kick, ns, st.spin * 2.2, css(st.colC), (0.10 + 0.55 * bnd[0]) * pulse);
  lotus(0.36, 0.06 + 0.34 * bnd[1], ns, -st.spin * 1.5 + Math.PI / ns, css(mix3(st.colB, WHITE, 0.25)), (0.06 + 0.45 * bnd[1]) * pulse);
  lotus(0.545, 0.04 + 0.2 * bnd[2] + 0.06 * st.hat, ns * 2, st.spin, css(st.colB), (0.04 + 0.4 * bnd[2]) * pulse);
  // instrument orbits: far outside the dial, three sweeping arcs per stem — longer, thicker and brighter the louder it plays
  g.lineCap = 'round';
  S.stems.forEach((sm, i) => {
    const lv = st.stemLv[i]; if (lv < 0.05) return;
    const rr = Rm * (1.085 + i * 0.082), len = (0.10 + 0.55 * lv) * TAU / 3, a0 = (i % 2 ? 1 : -1) * st.flow * (0.22 + 0.05 * i) + i * 0.9;
    g.globalAlpha = Math.min(1, 1.05 * Math.pow(lv, 1.25)); g.strokeStyle = stemColor(sm.name); g.lineWidth = Math.max(2.4, Rm * (0.005 + 0.016 * lv));
    for (let j = 0; j < 3; j++) { g.beginPath(); g.arc(0, 0, rr, a0 + j * TAU / 3, a0 + j * TAU / 3 + len); g.stroke(); }
  });
  g.lineCap = 'butt';
  // sparks shed by the notes
  for (const p of st.parts) {
    const k = (now - p.t0) / p.life;
    const pr = Math.max(3, Rm * 0.009 * p.s * (1 - 0.4 * k));
    g.globalAlpha = Math.pow(1 - k, 1.2); g.drawImage(p.pc < 0 ? sp.pw : sp.pp[p.pc], p.x * Rm - pr, p.y * Rm - pr, pr * 2, pr * 2);
  }
  // bass: a heavy glow circling the core
  const bm = S.pitch(S.bassMel, t), bl = S.bassStem ? F.stemLevel(S.bassStem, t) : 0;
  if (bm != null && bl > 0.15) { const a = pcAngle(Math.round(bm)); dot(sp.pc[((Math.round(bm) % 12) + 12) % 12], Math.cos(a) * Rm * 0.128, Math.sin(a) * Rm * 0.128, Rm * (0.05 + 0.09 * bl), 0.25 + 0.6 * bl); }
  // the dial: every sounding pitch is a star on its pitch-class ray
  const shimmer = 0.8 + 0.45 * st.on;
  for (let s = 0; s < NS; s++) {
    const a = st.amp[s]; if (a < 0.03) continue;
    const pc = (MIDI0 + s) % 12, ang = pcAngle(pc), k = pitchK(s), rr = Rm * lerp(R_IN, R_OUT, k) * breathe;
    dot(sp.pc[pc], Math.cos(ang) * rr, Math.sin(ang) * rr, Rm * (0.022 + 0.085 * a) * lerp(1.4, 0.75, k), (0.12 + 1.1 * a) * shimmer);
  }
  // vocal melody: a white comet (octave → radius, so slides and vibrato move along the ray)
  const vm = S.pitch(S.mel, t);
  if (vm != null) {
    const ang = pcAngle(Math.round(vm)), rr = Rm * lerp(R_IN, R_OUT, pitchK(vm - MIDI0)) * breathe, x = Math.cos(ang) * rr, y = Math.sin(ang) * rr;
    dot(sp.pc[((Math.round(vm) % 12) + 12) % 12], x, y, Rm * 0.11, 0.7); dot(sp.white, x, y, Rm * 0.06, 0.95);
  }
  // chord polygon (faint, so its echo drifts outward)
  if (st.poly && st.polyA > 0.02) {
    g.beginPath(); st.poly.forEach((a, i) => { const x = Math.cos(a) * Rm * R_POLY, y = Math.sin(a) * Rm * R_POLY; i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath();
    g.globalAlpha = 0.16 * st.polyA; g.strokeStyle = css(st.colC); g.lineWidth = Math.max(1.5, Rm * 0.004); g.stroke();
  }
  // kick shockwaves (polygons when the style is geometric) and section-change waves
  for (const r of st.rings) {
    const k = (now - r.t0) / r.life, rad = Rm * lerp(0.1, 1.5, easeOut(k));
    g.beginPath();
    if (D.geo > 0.5) for (let i = 0; i <= st.sym; i++) { const a = st.spin + i / st.sym * TAU; i ? g.lineTo(Math.cos(a) * rad, Math.sin(a) * rad) : g.moveTo(Math.cos(a) * rad, Math.sin(a) * rad); }
    else g.arc(0, 0, rad, 0, TAU);
    g.globalAlpha = Math.min(1, r.a * Math.pow(1 - k, 1.6)); g.strokeStyle = acc; g.lineWidth = Math.max(1.5, Rm * 0.009 * r.w * (1 - k * 0.6)); g.stroke();
  }
  // snare: a crown of rays flashing at the rim of the dial
  if (st.snare > 0.03) {
    const n = st.sym * 6; g.beginPath();
    for (let i = 0; i < n; i++) { const a = st.spin + i / n * TAU, r0 = Rm * 0.795, r1 = Rm * (0.805 + 0.06 * st.snare); g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); }
    g.globalAlpha = Math.min(1, st.snare * 0.75); g.strokeStyle = css(WHITE); g.lineWidth = Math.max(1.4, Rm * 0.004); g.stroke();
  }
  // hi-hat sparks
  for (const p of st.sparks) { const k = (now - p.t0) / p.life; dot(sp.white, Math.cos(p.a) * Rm * p.r, Math.sin(p.a) * Rm * p.r, Rm * 0.016 * p.s, (1 - k) * 0.9); }
}

/** crisp instruments on top of the light: beat clock, chord polygon, pitch-class dial, song ring */
function drawDial(g, F, t, cx, cy, Rm, labels) {
  const S = song, D = S.dna, A0 = g.globalAlpha, u = Rm / 490;
  const arc = (r, a0, a1, col, lw, alpha) => { g.globalAlpha = A0 * alpha; g.beginPath(); g.arc(cx, cy, r, a0, a1); g.strokeStyle = col; g.lineWidth = lw; g.stroke(); };
  g.save(); g.lineCap = 'round';
  // beat clock: one arc per beat of the bar
  const bt = F.beatAt(t), n = D.bpb, gap = 0.1;
  if (bt.idx >= 0) for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + i / n * TAU + gap, a1 = -Math.PI / 2 + (i + 1) / n * TAU - gap, cur = i === bt.pos - 1;
    const lit = cur ? 0.35 + 0.65 * Math.exp(-bt.since * 5) : i < bt.pos - 1 ? 0.3 : 0.1;
    arc(Rm * 0.168, a0, a1, i === 0 ? css(mix3(st.colC, WHITE, 0.3)) : PAL.cream, Math.max(1.5, 2.6 * u) * (cur ? 1.5 : 1), lit);
  }
  // chord polygon
  if (st.poly && st.polyA > 0.02) {
    const pts = st.poly.map(a => [cx + Math.cos(a) * Rm * R_POLY, cy + Math.sin(a) * Rm * R_POLY]);
    g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath();
    g.globalAlpha = A0 * st.polyA; g.fillStyle = css(st.colC, 0.05); g.fill();
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(3,4,9,0.5)'; g.lineWidth = Math.max(4, 6.5 * u); g.stroke();              // dark casing: stays readable over bright light, invisible on dark
    g.shadowColor = css(st.colC, 0.9); g.shadowBlur = 10 * u; g.strokeStyle = css(mix3(st.colC, WHITE, 0.55), 0.95); g.lineWidth = Math.max(1.5, 2.2 * u); g.stroke();
    g.shadowBlur = 0;
    for (const [x, y] of pts) {
      g.beginPath(); g.arc(x, y, 5.5 * u + 1.5, 0, TAU); g.fillStyle = 'rgba(3,4,9,0.6)'; g.fill();
      g.beginPath(); g.arc(x, y, 3.6 * u + 1, 0, TAU); g.fillStyle = css(mix3(st.colC, WHITE, 0.65)); g.fill();
    }
    if (st.root != null) { g.beginPath(); g.arc(cx + Math.cos(st.root) * Rm * R_POLY, cy + Math.sin(st.root) * Rm * R_POLY, 6.5 * u + 1.5, 0, TAU); g.strokeStyle = css(WHITE, 0.9); g.lineWidth = Math.max(1, 1.5 * u); g.stroke(); }
  }
  if (labels) { g.globalAlpha = A0 * 0.22; g.beginPath(); g.arc(cx, cy, Rm * R_NAME, 0, TAU); g.strokeStyle = '#04050a'; g.lineWidth = Rm * 0.085; g.stroke(); }
  // pitch-class dial: names lit by the live chroma, a dot under every scale tone, a ring on the tonic
  const key = F.keyAt(t), tonic = key == null ? null : key % 12, scale = key == null ? [] : (key >= 12 ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map(i => (tonic + i) % 12);
  for (let pc = 0; pc < 12; pc++) {
    const a = pcAngle(pc), v = st.chr ? Math.pow(st.chr[pc], 1.5) : 0, inKey = scale.includes(pc), c = PC_RGB[pc];
    const x = cx + Math.cos(a) * Rm * R_NAME, y = cy + Math.sin(a) * Rm * R_NAME;
    g.globalAlpha = A0 * (inKey ? 0.55 : 0.2); g.beginPath(); g.arc(cx + Math.cos(a) * Rm * (R_POLY + 0.022), cy + Math.sin(a) * Rm * (R_POLY + 0.022), (inKey ? 1.8 : 1.2) * u + 0.6, 0, TAU); g.fillStyle = css(c); g.fill();
    if (!labels) continue;
    g.globalAlpha = A0 * (0.6 + 0.4 * v); g.beginPath(); g.arc(cx, cy, Rm * (R_NAME + 0.046), a - 0.215, a + 0.215); g.strokeStyle = css(c); g.lineWidth = Math.max(2, (3 + 3 * v) * u); g.stroke();   // colour key: this arc IS the note's colour
    g.globalAlpha = A0;
    text(g, F.fifthName(pc), x, y + 6 * u, { align: 'center', size: Math.max(12, (17 + 8 * v) * u), font: FONT.num, weight: pc === tonic ? 700 : 600, color: css(mix3(c, WHITE, 0.25 * v)), alpha: (inKey ? 0.78 : 0.45) + 0.22 * v, glow: css(c, 0.8 * v), blur: 12 * u });
    if (pc === tonic) { g.globalAlpha = A0 * 0.7; g.beginPath(); g.arc(x, y, 17 * u + 3, 0, TAU); g.strokeStyle = css(c); g.lineWidth = 1; g.stroke(); }
  }
  // song ring: sections as arcs, played part bright; cadences as ticks; playhead
  const dur = F.dur || 1, at = x => -Math.PI / 2 + clamp(x / dur, 0, 1) * TAU, rs = Rm * R_SONG;
  const secs = S.secs.length ? S.secs : [{ start: 0, end: dur, label: 'A', prime: '', hint: '' }];
  secs.forEach((s, i) => {
    const a0 = at(s.start) + 0.012, a1 = Math.max(a0 + 0.004, at(s.end) - 0.012), col = sectionColor(s.label);
    arc(rs, a0, a1, col, Math.max(1.5, 2.2 * u), 0.26);
    if (t > s.start) arc(rs, a0, Math.min(a1, Math.max(a0 + 0.002, at(t))), col, Math.max(2, 3.6 * u), 0.95);
    if (labels && a1 - a0 > 0.16) { const am = (a0 + a1) / 2; g.globalAlpha = A0; text(g, s.prime, cx + Math.cos(am) * Rm * R_SEC, cy + Math.sin(am) * Rm * R_SEC + 5 * u, { align: 'center', size: Math.max(10, 14 * u), font: FONT.display, color: col, alpha: i === st.si ? 1 : 0.5 }); }
  });
  for (const cd of S.cadences) { const a = at(cd.t); g.globalAlpha = A0 * (cd.t <= t ? 0.9 : 0.35); g.beginPath(); g.moveTo(cx + Math.cos(a) * (rs + 5 * u), cy + Math.sin(a) * (rs + 5 * u)); g.lineTo(cx + Math.cos(a) * (rs + 11 * u), cy + Math.sin(a) * (rs + 11 * u)); g.strokeStyle = PAL.gold; g.lineWidth = Math.max(1, 1.4 * u); g.stroke(); }
  const ap = at(t), px = cx + Math.cos(ap) * rs, py = cy + Math.sin(ap) * rs;
  g.globalAlpha = A0; g.shadowColor = '#fff'; g.shadowBlur = 16 * u; g.beginPath(); g.arc(px, py, 4.5 * u + 1.5, 0, TAU); g.fillStyle = '#fff'; g.fill();
  g.restore(); g.globalAlpha = A0;
}

/** four quiet corners of text: section · key & mood · harmony · style & instruments */
function drawHud(g, F, t, R, Rm) {
  const S = song, D = S.dna, u = Rm / 490, fs = px => Math.max(11, Math.round(px * u)), A0 = g.globalAlpha;
  const x0 = R.x, x1 = R.x + R.w, y0 = R.y, y1 = R.y + R.h, compact = Rm < 400;
  const cap = (s, x, y, align = 'left') => text(g, s, x, y, { align, size: fs(13), font: FONT.cn, color: PAL.gray, ls: 3 });
  const shadow = { glow: 'rgba(0,0,0,0.85)', blur: 10 };
  for (const [px, py, pr] of [[x0, y0, 380], [x1, y0, 340], [x0, y1, 380], [x1, y1, compact ? 0 : 400]]) {
    if (!pr) continue;
    const gr = g.createRadialGradient(px, py, 0, px, py, pr * u);
    gr.addColorStop(0, 'rgba(3,4,9,0.62)'); gr.addColorStop(0.55, 'rgba(3,4,9,0.3)'); gr.addColorStop(1, 'rgba(3,4,9,0)');
    g.fillStyle = gr; g.fillRect(px - pr * u, py - pr * u, pr * u * 2, pr * u * 2);
  }
  // ---- top-left: where we are in the form
  const sec = S.secs[st.si];
  cap('段落 · 行进', x0, y0 + fs(14));
  if (sec) {
    const col = sectionColor(sec.label);
    const w = text(g, sec.prime, x0, y0 + fs(62), { size: fs(46), font: FONT.display, color: col, ...shadow });
    text(g, sec.hint || '', x0 + w + fs(14), y0 + fs(60), { size: fs(30), font: FONT.cn, color: PAL.cream, ...shadow });
    const bar = F.barAt(t), bi = bar.idx - sec.bar0;
    const p = clamp((t - sec.start) / Math.max(0.1, sec.end - sec.start), 0, 1), bw = fs(230);
    g.globalAlpha = A0 * 0.22; g.fillStyle = col; g.fillRect(x0, y0 + fs(78), bw, Math.max(2, 3 * u));
    g.globalAlpha = A0; g.fillRect(x0, y0 + fs(78), bw * p, Math.max(2, 3 * u));
    const occ = (sec.occ > 1 ? ` · 第 ${sec.occ} 次出现` : '') + (sec.form ? ` · 流场「${sec.form.cn}」` : '');
    text(g, bi >= 0 && bi < sec.nBars ? `第 ${bi + 1} / ${sec.nBars} 小节${occ}` : `全曲 ${Math.round(t / (F.dur || 1) * 100)}%${occ}`, x0, y0 + fs(104), { size: fs(15), font: FONT.cn, color: PAL.ink, alpha: 0.85 });
  }
  // ---- top-right: key, tempo and the mood the colours are painting
  cap('调性 · 氛围', x1, y0 + fs(14), 'right');
  text(g, F.keyName(F.keyAt(t)), x1, y0 + fs(56), { align: 'right', size: fs(38), font: FONT.cn, color: PAL.cream, ...shadow });
  const bpm = F.bpmAt(t);
  text(g, `${bpm ? Math.round(bpm) : '–'} BPM · ${F.A.rhythm?.time_signature || '4/4'}`, x1, y0 + fs(84), { align: 'right', size: fs(16), font: FONT.num, color: PAL.ink, alpha: 0.85, ls: 1 });
  const sw = fs(150), sy = y0 + fs(98), gr = g.createLinearGradient(x1 - sw, 0, x1, 0);
  gr.addColorStop(0, css(mix3(st.colA, [1, 1, 1], 0.12))); gr.addColorStop(0.55, css(mix3(st.colB, [1, 1, 1], 0.15))); gr.addColorStop(1, css(st.colC));
  g.fillStyle = gr; g.fillRect(x1 - sw, sy, sw, Math.max(3, 5 * u));
  text(g, moodWords(st.val, st.Es, st.T), x1, sy + fs(28), { align: 'right', size: fs(17), font: FONT.cn, color: css(mix3(st.colB, [1, 1, 1], 0.55)), ...shadow });
  // ---- bottom-left: the chord now, and where the harmony goes next
  const ch = st.chord, cy0 = y1 - fs(44);
  cap('和声 · 下一步', x0, cy0 - fs(62));
  if (ch) {
    const col = css(mix3(PC_RGB[ch.root], [1, 1, 1], 0.2)), fn = ch.func_local || ch.function;
    const w = text(g, ch.label, x0, cy0, { size: fs(54), font: FONT.num, weight: 500, color: col, glow: css(PC_RGB[ch.root], 0.5), blur: 18 * u });
    text(g, ch.roman_local || ch.roman || '', x0 + w + fs(14), cy0 - fs(22), { size: fs(22), font: FONT.num, weight: 600, color: PAL.cream, alpha: 0.9 });
    text(g, FUNC_CN[fn] ? `${FUNC_CN[fn]}功能` : '', x0 + w + fs(14), cy0, { size: fs(14), font: FONT.cn, color: PAL.gray });
    let tx = x0 + w + fs(92);                                   // the chord's notes, each in its dial colour
    for (const iv of QI[ch.quality]) { const pc = (ch.root + iv) % 12; tx += text(g, F.fifthName(pc), tx, cy0 - fs(8), { size: fs(22), font: FONT.num, weight: 600, color: css(PC_RGB[pc]), ...shadow }) + fs(12); }
    const p = clamp((t - ch.start) / Math.max(0.1, ch.end - ch.start), 0, 1);
    g.globalAlpha = A0 * 0.9; g.fillStyle = col; g.fillRect(x0, cy0 + fs(10), Math.max(fs(60), w) * p, Math.max(2, 2.5 * u)); g.globalAlpha = A0;
  } else text(g, '—', x0, cy0, { size: fs(54), font: FONT.num, color: PAL.dim });
  let nx = x0; const ny = y1 - fs(4);
  for (let i = st.ci + 1, n = 0; i < F.chords.length && n < 4; i++) {
    const c = F.chords[i]; if (c.label === 'N' || c.label === F.chords[i - 1]?.label) continue;
    nx += text(g, '→ ', nx, ny, { size: fs(17), font: FONT.num, color: PAL.gray, alpha: 0.7 });
    nx += text(g, c.label, nx, ny, { size: fs(19), font: FONT.num, weight: 500, color: css(PC_RGB[c.root] || WHITE), alpha: 0.95 - n * 0.2 }) + fs(10);
    n++;
  }
  if (compact) return;
  // ---- bottom-right: who is playing, and the style this picture was grown from
  const bw = fs(120), rowH = fs(21);
  S.stems.forEach((s, i) => {
    const y = y1 - (S.stems.length - 1 - i) * rowH - fs(6), lv = F.stemLevel(s, t), col = stemColor(s.name);
    text(g, STEM_CN[s.name] || s.name, x1 - bw - fs(10), y, { align: 'right', size: fs(14), font: FONT.cn, color: PAL.ink, alpha: 0.35 + 0.65 * lv });
    g.globalAlpha = A0 * 0.14; g.fillStyle = col; g.fillRect(x1 - bw, y - fs(9), bw, fs(8));
    g.globalAlpha = A0 * (0.4 + 0.6 * lv); g.fillRect(x1 - bw, y - fs(9), bw * lv, fs(8)); g.globalAlpha = A0;
  });
  const ty = y1 - S.stems.length * rowH - fs(22);
  const half = Math.ceil(D.tags.length / 2), lines = [D.tags.slice(0, half).join(' · '), D.tags.slice(half).join(' · ')].filter(Boolean);
  lines.forEach((s, i) => text(g, s, x1, ty - (lines.length - 1 - i) * fs(24), { align: 'right', size: fs(16), font: FONT.cn, color: PAL.cream, alpha: 0.9, ...shadow }));
  cap(`风格气质 · ${D.form}质感`, x1, ty - lines.length * fs(24) - fs(4), 'right');
}

export const aura = {
  title: '流光 · 音乐心象',
  desc: () => '星云底色是氛围；12 个方向是五度圈上的音级，离中心越远音越高；多边形是和弦，冲击环是鼓点，流场随段落变化，外侧弧线是各件乐器，外环是全曲进度',
  /** debug / tuning hook: the live engine, song model and state */
  get debug() { return { eng, song, st }; },
  draw(g, Sx) {
    const { F, R, t, now } = Sx, dt = clamp(Sx.dt ?? 0.016, 0.001, 0.1);
    const cxm = R.x + R.w / 2, cym = R.y + R.h / 2;
    eng ||= new Engine();
    if (eng.err) {
      text(g, '这个浏览器没有开启 WebGL2，无法显示「流光」', cxm, cym - 10, { align: 'center', color: PAL.gray, size: 26, font: FONT.cn });
      text(g, '请用最新版 Chrome / Edge / Safari 打开，或在浏览器设置里启用硬件加速', cxm, cym + 30, { align: 'center', color: PAL.gray, size: 18, font: FONT.cn, alpha: 0.7 });
      return;
    }
    if (!song || song.A !== F.A) { song = new Song(F); st = newState(); eng.clear(); }
    song.F = F;
    const RR = { x: R.x - 60, y: R.y - 40, w: Math.round(R.w + 120), h: Math.round(R.h + 70) };
    const Rm = Math.min(R.w, R.h) / 2 * 0.97, D = song.dna;
    eng.resize(RR.w, RR.h);
    advance(F, t, now, dt);
    if (st.seek) eng.clear();
    drawInk(F, t, now, Rm, cxm - RR.x, cym - RR.y);
    const pl = st.playing ? 1 : 0.4;
    eng.render({
      c: [(cxm - RR.x) / RR.w, 1 - (cym - RR.y) / RR.h], rm: Rm / (RR.h / 2), dt, now: now % 1000, time: st.flow, seed: song.seed,
      zoom: (D.zoom * st.fm.zoom * (0.35 + 0.95 * st.E) + 1.25 * st.kick * (0.45 + 0.55 * D.geo)) * pl,
      rot: D.rot * (0.45 + 0.9 * st.E) * pl, vort: st.fm.vort * (0.5 + 0.8 * st.E) * pl,
      petal: Math.max(st.fm.petal, 0.45 * D.geo), wave: st.fm.wave, turb: D.turb * st.fm.turb * (0.5 + 1.3 * st.T),
      fade: Math.exp(-dt * Math.LN2 / (D.tau * (0.75 + 0.5 * (1 - st.E)))), gain: 18 * dt,
      geo: D.geo, sym: st.sym, spin: st.spin, grain: D.grain,
      kick: Math.min(1, st.kick), snare: Math.min(1, st.snare), hat: Math.min(1, st.hat), ripR: st.ripR, ripA: st.ripA, chroma: st.chrF, rp: st.rp,
      colA: st.colA, colB: st.colB, colC: st.colC, energy: st.E, tension: st.T, beat: st.beat, shock: st.shock, flash: st.flash,
    });
    const sh = st.playing ? st.shake : 0, sc = 1 + 0.022 * sh + 0.006 * Math.min(1, st.kick);      // shake + a small zoom punch
    const sx = (Math.random() - 0.5) * 2 * sh * Rm * 0.02, sy = (Math.random() - 0.5) * 2 * sh * Rm * 0.02;
    g.drawImage(eng.cv, RR.x - RR.w * (sc - 1) / 2 + sx, RR.y - RR.h * (sc - 1) / 2 + sy, RR.w * sc, RR.h * sc);
    const labels = Sx.hud !== false;
    drawDial(g, F, t, cxm, cym, Rm, labels);
    if (labels) drawHud(g, F, t, R, Rm);
  },
};
