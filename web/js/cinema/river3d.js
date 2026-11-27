// 声河 · 一镜到底 — a WebGL2 flythrough of the whole song (raw WebGL2, no libraries).
// Same grammar as the 2D 声河: time = depth (the future comes toward you), the spectrum forms the two
// canyon walls (low frequencies next to the water, highs further out), the instruments are the river
// itself (stream width = energy), the vocal melody is a thread of light above the water, bar lines
// pulse on the beat, the fog and light warm up with harmonic/energetic tension, and section gates /
// cadence pillars mark the form. Rendered offscreen and composited into the 2D cinema canvas, so the
// recorder captures it like any other scene.
import { PAL, F as FONT, clamp, lerp, rgba, text, roundRect } from './fx.js';
import { stemLevels, sampleAt, tensionRGB, funcHex, FUNC_CN, CAD, tagHex, STEM_CN } from '../grammar.js';
import { sectionColor } from '../ui.js';
import { hexToRgb } from '../util.js';

const S = 6;             // world units per second
const RH = 6;            // river half width
const NB = 44;           // spectrum bins per bank
const BANK = 30;         // bank width
const HMAX = 9;          // canyon wall max height
const DT = 0.1;          // terrain row step (s)

// ---------------------------------------------------------------- tiny mat4 helpers (column-major)
function persp(fov, asp, n, f) {
  const t = 1 / Math.tan(fov / 2), m = new Float32Array(16);
  m[0] = t / asp; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = 2 * f * n / (n - f); return m;
}
function lookAt(e, c, up) {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2]; let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx; l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
  }
  return o;
}

const VS = `#version 300 es
in vec3 aPos; in vec4 aCol;
uniform mat4 uVP; uniform vec3 uCam; uniform float uNowZ;
out vec4 vCol; out float vDist; out float vDz;
void main() { gl_Position = uVP * vec4(aPos, 1.0); vCol = aCol; vDist = length(aPos - uCam); vDz = aPos.z - uNowZ; }`;
const FS = `#version 300 es
precision highp float;
in vec4 vCol; in float vDist; in float vDz;
uniform vec3 uFog; uniform vec2 uFogR; uniform float uAdd; uniform float uPulse; uniform float uNowGlow;
out vec4 o;
void main() {
  float f = clamp((vDist - uFogR.x) / (uFogR.y - uFogR.x), 0.0, 1.0);
  f = f * f * (3.0 - 2.0 * f);
  vec3 c = vCol.rgb;
  float near = exp(-abs(vDz) * 0.55);
  c *= 1.0 + uPulse * near * 0.9;
  c += vec3(1.0, 0.85, 0.55) * uNowGlow * exp(-abs(vDz) * 2.2) * 0.35;
  if (vDz > 0.0) c *= mix(1.0, 0.5, clamp(vDz / 10.0, 0.0, 1.0));   // already played → dimmer
  if (uAdd > 0.5) o = vec4(c * vCol.a * (1.0 - f), 0.0);
  else o = vec4(mix(c, uFog, f), 1.0);
}`;

function rgb01(css) {
  if (!css || css[0] !== '#') return [0.6, 0.6, 0.6];
  return hexToRgb(css).map(v => v / 255);
}
function ramp(v) { // spectrum intensity → colour (night slate → steel blue → gold → cream)
  const st = [[0, [0.035, 0.035, 0.05]], [0.35, [0.16, 0.2, 0.3]], [0.7, [0.78, 0.6, 0.3]], [1, [1, 0.93, 0.8]]];
  for (let i = 1; i < st.length; i++) if (v <= st[i][0]) {
    const [a, ca] = st[i - 1], [b, cb] = st[i], k = (v - a) / (b - a);
    return [0, 1, 2].map(j => ca[j] + (cb[j] - ca[j]) * k);
  }
  return st[st.length - 1][1];
}

// ================================================================== geometry builder
class Geo {
  constructor() { this.p = []; this.c = []; this.i = []; }
  v(x, y, z, r, g, b, a = 1) { this.p.push(x, y, z); this.c.push(r, g, b, a); return this.p.length / 3 - 1; }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
}

class World {
  constructor(F) {
    this.F = F; this.A = F.A; this.I = F.A.insight || {};
    this.dur = F.dur;
    this.cv = document.createElement('canvas');
    const gl = this.gl = this.cv.getContext('webgl2', { antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
    if (!gl) { this.err = 'WebGL2 不可用'; return; }
    this.prog = this.program(VS, FS);
    this.loc = {};
    for (const u of ['uVP', 'uCam', 'uNowZ', 'uFog', 'uFogR', 'uAdd', 'uPulse', 'uNowGlow']) this.loc[u] = gl.getUniformLocation(this.prog, u);
    this.ten = this.I.tension || null;
    this.layers = [];
    try { this.build(); } catch (e) { console.error('river3d build', e); this.err = String(e); }
  }
  program(vs, fs) {
    const gl = this.gl, mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.bindAttribLocation(p, 1, 'aCol');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  upload(geo, opts) {
    const gl = this.gl, vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geo.p), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const cb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geo.c), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(geo.i), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.layers.push({ vao, n: geo.i.length, ...opts });
  }
  tensionAt(t, which = 'total') {
    const T = this.ten; if (!T?.[which]?.length) return 0.3;
    const i = clamp(Math.round((t - T.t0) / T.dt), 0, T[which].length - 1); return T[which][i] ?? 0.3;
  }

  build() {
    const F = this.F, A = this.A, dur = this.dur;
    const rows = Math.max(2, Math.ceil(dur / DT) + 1);
    this.rows = rows;
    // ---------------- canyon walls from the mel spectrogram
    const spec = F.mel || F.stft || F.cqt;
    const bankH = new Float32Array(rows * NB);
    if (spec) {
      const { hm, data } = spec, R = hm.rows, C = hm.cols;
      const r0 = Math.floor(R * 0.02), r1 = Math.floor(R * 0.94);
      for (let i = 0; i < rows; i++) {
        const t = i * DT;
        const ca = clamp(Math.floor((t - DT / 2 - hm.t0) / (hm.t1 - hm.t0) * C), 0, C - 1), cb = clamp(Math.ceil((t + DT / 2 - hm.t0) / (hm.t1 - hm.t0) * C), ca, C - 1);
        for (let b = 0; b < NB; b++) {
          const ra = r0 + Math.floor((r1 - r0) * b / NB), rb = Math.max(ra, r0 + Math.floor((r1 - r0) * (b + 1) / NB) - 1);
          let m = 0, n = 0;
          for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) { m += data[r * C + c]; n++; }
          bankH[i * NB + b] = clamp((m / Math.max(1, n) / 255 - 0.32) / 0.6, 0, 1);
        }
      }
      // light temporal smoothing so the walls read as landforms, not noise
      const tmp = Float32Array.from(bankH);
      for (let i = 1; i < rows - 1; i++) for (let b = 0; b < NB; b++) bankH[i * NB + b] = (tmp[(i - 1) * NB + b] + 2 * tmp[i * NB + b] + tmp[(i + 1) * NB + b]) / 4;
    }
    const bx = b => RH + 0.6 + Math.pow(b / (NB - 1), 1.25) * BANK;
    const by = (i, b) => 0.25 + (b / NB) * 1.6 + Math.pow(bankH[i * NB + b], 1.5) * HMAX * (1 - 0.35 * b / NB);
    this.bx = bx; this.by = by;
    const geo = new Geo();
    for (const side of [-1, 1]) {
      const base = geo.p.length / 3;
      for (let i = 0; i < rows; i++) {
        const t = i * DT, z = -t * S, tt = this.tensionAt(t), tc = tensionRGB(tt).map(v => v / 255);
        for (let b = 0; b < NB; b++) {
          const v = bankH[i * NB + b], y = by(i, b);
          const dx = (by(i, Math.min(NB - 1, b + 1)) - by(i, Math.max(0, b - 1))) * side;
          const dz = by(Math.min(rows - 1, i + 1), b) - by(Math.max(0, i - 1), b);
          const shade = clamp(0.78 - dx * 0.09 + dz * 0.06, 0.35, 1.25);
          const c = ramp(v);
          const k = 0.22 + 0.25 * v;
          geo.v(side * bx(b), y, z, (c[0] * (1 - k) + tc[0] * k * (0.4 + v)) * shade, (c[1] * (1 - k) + tc[1] * k * (0.4 + v)) * shade, (c[2] * (1 - k) + tc[2] * k * (0.4 + v)) * shade);
        }
      }
      // indices row by row so we can draw only the visible slice
      for (let i = 0; i < rows - 1; i++) for (let b = 0; b < NB - 1; b++) {
        const a = base + i * NB + b;
        geo.quad(a, a + 1, a + NB + 1, a + NB);
      }
    }
    // riverbed between the walls (dark, warmed slightly by tension)
    const fl = new Geo(); let pf = null;
    for (let i = 0; i < rows; i += 5) {
      const t = i * DT, z = -t * S, tc = tensionRGB(this.tensionAt(t)).map(v => v / 255 * 0.07);
      const l = fl.v(-RH - 0.8, -0.02, z, 0.03 + tc[0], 0.028 + tc[1], 0.03 + tc[2]), r = fl.v(RH + 0.8, -0.02, z, 0.03 + tc[0], 0.028 + tc[1], 0.03 + tc[2]);
      if (pf) fl.quad(pf[0], pf[1], r, l);
      pf = [l, r];
    }
    this.upload(fl, { mode: 'TRI', add: false });
    this.upload(geo, { mode: 'TRI', add: false, rowIdx: (NB - 1) * 6, rowsPerSide: rows - 1, sides: 2 });
    this.terrain = this.layers[this.layers.length - 1];

    // ---------------- bar lines draped over the walls (+ downbeat across the river)
    const bars = A.rhythm?.bars || [];
    const lg = new Geo();
    bars.forEach((bar, bi) => {
      const t = bar[0], i = clamp(Math.round(t / DT), 0, rows - 1), z = -t * S, strong = bi % 4 === 0;
      const a = strong ? 0.55 : 0.28;
      for (const side of [-1, 1]) {
        for (let b = 0; b < NB - 1; b++) {
          const w = 0.05;
          const p0 = lg.v(side * bx(b), by(i, b) + 0.06, z - w, 0.91, 0.75, 0.42, a), p1 = lg.v(side * bx(b + 1), by(i, b + 1) + 0.06, z - w, 0.91, 0.75, 0.42, a);
          const p2 = lg.v(side * bx(b + 1), by(i, b + 1) + 0.06, z + w, 0.91, 0.75, 0.42, a), p3 = lg.v(side * bx(b), by(i, b) + 0.06, z + w, 0.91, 0.75, 0.42, a);
          lg.quad(p0, p1, p2, p3);
        }
      }
    });
    this.upload(lg, { mode: 'TRI', add: true });

    // ---------------- the river: instrument streams side by side, width = energy
    const stems = stemLevels(A);
    this.stems = stems;
    if (stems.length) {
      const sg = new Geo(), step = 0.1, n = Math.ceil(dur / step) + 1;
      const lv = stems.map(s => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = sampleAt(s, i * step); return a; });
      let mx = 0.01; for (let i = 0; i < n; i++) { let s = 0; for (const a of lv) s += a[i]; mx = Math.max(mx, s); }
      const k = RH * 2 * 0.94 / mx;
      const cols = stems.map(s => rgb01(s.color));
      const prev = stems.map(() => null);
      for (let i = 0; i < n; i++) {
        let tot = 0; for (const a of lv) tot += a[i];
        let x = -tot * k / 2;
        const z = -i * step * S;
        stems.forEach((s, si) => {
          const w = lv[si][i] * k, y = 0.04 + si * 0.012, c = cols[si], br = 0.45 + 0.75 * lv[si][i];
          const a = sg.v(x, y, z, c[0] * br, c[1] * br, c[2] * br), b = sg.v(x + w, y, z, c[0] * br, c[1] * br, c[2] * br);
          if (prev[si]) sg.quad(prev[si][0], prev[si][1], b, a);
          prev[si] = [a, b];
          x += w;
        });
      }
      this.upload(sg, { mode: 'TRI', add: false });
      // a faint additive sheen on the water so it glows in the fog
      const gw = new Geo(); let pv = null;
      for (let i = 0; i < n; i++) {
        let tot = 0; for (const a of lv) tot += a[i];
        const hw = tot * k / 2, z = -i * step * S, a = 0.10 + 0.25 * tot / mx;
        const l = gw.v(-hw - 0.6, 0.1, z, 1, 0.9, 0.7, a * 0.4), c = gw.v(0, 0.1, z, 1, 0.9, 0.7, a), r = gw.v(hw + 0.6, 0.1, z, 1, 0.9, 0.7, a * 0.4);
        if (pv) { gw.quad(pv[0], pv[1], c, l); gw.quad(pv[1], pv[2], r, c); }
        pv = [l, c, r];
      }
      this.upload(gw, { mode: 'TRI', add: true });
    }

    // ---------------- melody: a thread of light (contour) + tagged note bars
    const mel = A.melody?.vocals;
    const mg = new Geo();
    if (mel && !mel.weak && mel.midi) {
      const lo = (mel.low_midi ?? 48) - 2, hi = (mel.high_midi ?? 76) + 2;
      this.melY = m => 1.6 + (m - lo) / Math.max(1, hi - lo) * 7;
      let prev = null, lastT = -9;
      const stride = Math.max(1, Math.round(0.03 / mel.dt));
      for (let i = 0; i < mel.midi.length; i += stride) {
        const m = mel.midi[i], t = mel.t0 + i * mel.dt;
        if (m == null) { prev = null; continue; }
        if (t - lastT > 0.2) prev = null;
        const y = this.melY(m), z = -t * S;
        // cross-shaped ribbon (vertical + horizontal) so the thread reads from behind and from above
        const core = [mg.v(0, y - 0.07, z, 1, 0.95, 0.85, 1), mg.v(0, y + 0.07, z, 1, 0.95, 0.85, 1),
          mg.v(-0.09, y, z, 1, 0.95, 0.85, 1), mg.v(0.09, y, z, 1, 0.95, 0.85, 1)];
        const halo = [mg.v(0, y - 0.5, z, 1, 0.8, 0.5, 0), mg.v(0, y, z, 1, 0.8, 0.5, 0.4), mg.v(0, y + 0.5, z, 1, 0.8, 0.5, 0),
          mg.v(-0.7, y, z, 1, 0.8, 0.5, 0), mg.v(0.7, y, z, 1, 0.8, 0.5, 0)];
        if (prev) {
          const P = prev;
          mg.quad(P.core[0], core[0], core[1], P.core[1]); mg.quad(P.core[2], core[2], core[3], P.core[3]);
          mg.quad(P.halo[0], halo[0], halo[1], P.halo[1]); mg.quad(P.halo[1], halo[1], halo[2], P.halo[2]);
          mg.quad(P.halo[3], halo[3], halo[1], P.halo[1]); mg.quad(P.halo[1], halo[1], halo[4], P.halo[4]);
        }
        prev = { core, halo }; lastT = t;
      }
      // note bars (flat, facing up) coloured by their relation to the chord
      for (const [s, e, p, tag] of this.I.melody_notes || []) {
        const c = rgb01(tagHex(tag, true)), y = this.melY(p) - 0.02, z0 = -s * S, z1 = -e * S, hw = tag === 'c' ? 0.35 : 0.55;
        const a = mg.v(-hw, y, z0, c[0], c[1], c[2], 0.8), b = mg.v(hw, y, z0, c[0], c[1], c[2], 0.8);
        const cc = mg.v(hw, y, z1, c[0], c[1], c[2], 0.8), d = mg.v(-hw, y, z1, c[0], c[1], c[2], 0.8);
        mg.quad(a, b, cc, d);
      }
    }
    // ---------------- section gates and cadence pillars
    this.gates = [];
    for (const s of this.I.sections || []) {
      const c = rgb01(sectionColor(s.label)), z = -s.start * S, X = RH + 1.2, Y = 13, w = 0.18;
      for (const sx of [-1, 1]) {
        const a = mg.v(sx * X - w, 0, z, c[0], c[1], c[2], 0.9), b = mg.v(sx * X + w, 0, z, c[0], c[1], c[2], 0.9);
        const cc = mg.v(sx * X + w, Y, z, c[0], c[1], c[2], 0.15), d = mg.v(sx * X - w, Y, z, c[0], c[1], c[2], 0.15);
        mg.quad(a, b, cc, d);
      }
      const a = mg.v(-X, Y - w, z, c[0], c[1], c[2], 0.25), b = mg.v(X, Y - w, z, c[0], c[1], c[2], 0.25);
      const cc = mg.v(X, Y + w, z, c[0], c[1], c[2], 0.25), d = mg.v(-X, Y + w, z, c[0], c[1], c[2], 0.25);
      mg.quad(a, b, cc, d);
      this.gates.push({ t: s.start, label: `${s.prime}  ${(s.hint || '').split(' ')[0]}`, color: sectionColor(s.label) });
    }
    for (const cd of this.I.cadences || []) {
      const c = rgb01(CAD[cd.type]?.hex || '#e8c06a'), z = -cd.t * S;
      for (const [x0, x1] of [[-0.25, 0.25]]) {
        const a = mg.v(x0, 0, z, c[0], c[1], c[2], 0.75), b = mg.v(x1, 0, z, c[0], c[1], c[2], 0.75);
        const cc = mg.v(x1, 11, z, c[0], c[1], c[2], 0), d = mg.v(x0, 11, z, c[0], c[1], c[2], 0);
        mg.quad(a, b, cc, d);
      }
    }
    if (mg.i.length) this.upload(mg, { mode: 'TRI', add: true });
  }

  render(w, h, cam, t, beat, tension) {
    const gl = this.gl;
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    const P = persp(cam.fov * Math.PI / 180, w / h, 0.5, 420);
    const V = lookAt(cam.eye, cam.at, [Math.sin(cam.roll), Math.cos(cam.roll), 0]);
    this.VP = mul(P, V);
    gl.uniformMatrix4fv(this.loc.uVP, false, this.VP);
    gl.uniform3fv(this.loc.uCam, cam.eye);
    gl.uniform1f(this.loc.uNowZ, -t * S);
    const fog = this.fogColor(tension);
    gl.uniform3fv(this.loc.uFog, fog);
    gl.uniform2f(this.loc.uFogR, 30, cam.far);
    gl.uniform1f(this.loc.uPulse, beat);
    gl.uniform1f(this.loc.uNowGlow, 1);
    gl.enable(gl.DEPTH_TEST);
    // visible slice of the terrain (rows from just behind the camera to the fog limit)
    const r0 = clamp(Math.floor((t - 6) / DT), 0, this.rows - 2), r1 = clamp(Math.ceil((t + (cam.far + 20) / S) / DT), r0 + 1, this.rows - 1);
    for (const L of this.layers) {
      gl.bindVertexArray(L.vao);
      if (L.add) { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE); gl.depthMask(false); gl.uniform1f(this.loc.uAdd, 1); }
      else { gl.disable(gl.BLEND); gl.depthMask(true); gl.uniform1f(this.loc.uAdd, 0); }
      if (L === this.terrain) {
        const per = L.rowIdx, cnt = (r1 - r0) * per;
        for (let s = 0; s < L.sides; s++) gl.drawElements(gl.TRIANGLES, cnt, gl.UNSIGNED_INT, (s * L.rowsPerSide * per + r0 * per) * 4);
      } else gl.drawElements(gl.TRIANGLES, L.n, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null); gl.depthMask(true); gl.disable(gl.BLEND);
  }
  fogColor(tt) {
    const cool = [0.05, 0.06, 0.09], warm = [0.2, 0.07, 0.05], gold = [0.16, 0.12, 0.07];
    const k = clamp(tt, 0, 1);
    return k < 0.5 ? cool.map((v, i) => lerp(v, gold[i], k / 0.5)) : gold.map((v, i) => lerp(v, warm[i], (k - 0.5) / 0.5));
  }
  project(x, y, z, R) {
    const m = this.VP; if (!m) return null;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0.1) return null;
    return { x: R.x + (cx / cw * 0.5 + 0.5) * R.w, y: R.y + (1 - (cy / cw * 0.5 + 0.5)) * R.h, w: cw };
  }
}

// ================================================================== camera choreography
const SHOTS = {
  prologue: { h: 15, back: 30, ahead: 46, lookY: 1, fov: 48, sway: 6 },
  build: { h: 8, back: 19, ahead: 36, lookY: 2, fov: 55, sway: 3 },
  burst: { h: 5.5, back: 13, ahead: 30, lookY: 2.5, fov: 62, sway: 2 },
  bright: { h: 7, back: 16, ahead: 34, lookY: 2.5, fov: 58, sway: 4 },
  climax: { h: 3.4, back: 9, ahead: 26, lookY: 3, fov: 70, sway: 1.5, shake: 1 },
  break: { h: 26, back: 6, ahead: 20, lookY: 0, fov: 50, sway: 0 },
  dark: { h: 10, back: 22, ahead: 36, lookY: 1, fov: 50, sway: 2 },
  fall: { h: 11, back: 22, ahead: 40, lookY: 1, fov: 52, sway: 4 },
  end: { h: 14, back: 26, ahead: 46, lookY: 1, fov: 50, sway: 3, pull: 1 },
  coda: { h: 12, back: 24, ahead: 42, lookY: 1, fov: 52, sway: 3, pull: 1 },
};
const DEF = SHOTS.build;

let world = null;

export const river3d = {
  title: '声河 · 一镜到底',
  desc: () => '时间是纵深；两岸是频谱，河道是各乐器，光线是旋律，雾色随张力变暖，拱门是段落，光柱是终止式',
  draw(g, Sx) {
    const { F, R, t, ch, mem, dt } = Sx;
    if (!world || world.F !== F) world = new World(F);
    if (world.err) {
      text(g, '这个浏览器没有开启 WebGL2，无法显示 3D 声河', R.x + R.w / 2, R.y + R.h / 2 - 10, { align: 'center', color: PAL.gray, size: 26, font: FONT.cn });
      text(g, '请用最新版 Chrome / Edge / Safari 打开，或在浏览器设置里启用硬件加速', R.x + R.w / 2, R.y + R.h / 2 + 30, { align: 'center', color: PAL.gray, size: 18, font: FONT.cn, alpha: 0.7 });
      return;
    }
    const I = world.I;
    // ---- camera target from the chapter's dramatic role, with a pull-back through the final chapter
    const sh = SHOTS[ch.role] || DEF;
    const prog = clamp((t - ch.start) / Math.max(1, ch.end - ch.start), 0, 1);
    const pull = sh.pull ? Math.pow(prog, 1.6) : 0;
    const tgt = {
      h: lerp(sh.h, 70, pull), back: lerp(sh.back, 90, pull), ahead: lerp(sh.ahead, 120, pull),
      lookY: sh.lookY, fov: lerp(sh.fov, 55, pull), sway: sh.sway, shake: sh.shake || 0,
    };
    const c = mem.cam ||= { ...tgt };
    const k = 1 - Math.exp(-(dt || 0.016) * 0.9);
    for (const key of Object.keys(tgt)) c[key] = lerp(c[key], tgt[key], k);
    // ---- beat pulse + tension
    const bt = F.beatAt(t), down = bt.pos === 1;
    const beat = bt.idx >= 0 ? Math.exp(-bt.since * 7) * (down ? 1 : 0.5) : 0;
    const ten = world.tensionAt(t);
    mem.ten = mem.ten == null ? ten : lerp(mem.ten, ten, 0.05);
    const zNow = -t * S;
    const sway = Math.sin(t * 0.11) * c.sway + Math.sin(t * 0.037) * c.sway * 0.5;
    const shake = c.shake * beat * 0.12;
    const cam = {
      eye: [sway + Math.sin(t * 37) * shake, c.h + Math.cos(t * 41) * shake, zNow + c.back],
      at: [sway * 0.3, c.lookY, zNow - c.ahead],
      fov: c.fov + beat * c.shake * 1.5, roll: Math.sin(t * 0.07) * 0.03 * c.sway / 4, far: 60 + c.ahead * 1.6 + c.h,
    };
    // ---- sky (matches the fog at the horizon)
    const fog = world.fogColor(mem.ten).map(v => Math.round(v * 255));
    const sky = g.createLinearGradient(0, R.y - 40, 0, R.y + R.h + 30);
    sky.addColorStop(0, '#07060a'); sky.addColorStop(0.55, `rgb(${fog})`); sky.addColorStop(1, '#050404');
    g.fillStyle = sky; g.fillRect(R.x - 60, R.y - 40, R.w + 120, R.h + 70);
    // ---- 3D
    const W3 = Math.round(R.w + 120), H3 = Math.round(R.h + 70);
    const RR = { x: R.x - 60, y: R.y - 40, w: W3, h: H3 };
    world.render(W3, H3, cam, t, beat, mem.ten);
    g.drawImage(world.cv, RR.x, RR.y, RR.w, RR.h);
    // vignette
    const vg = g.createRadialGradient(R.x + R.w / 2, R.y + R.h / 2, R.h * 0.35, R.x + R.w / 2, R.y + R.h / 2, R.w * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vg; g.fillRect(RR.x, RR.y, RR.w, RR.h);

    // ---- labels projected from 3D: section gates and cadences ahead
    for (const gt of world.gates) {
      if (gt.t < t - 1 || gt.t > t + 40) continue;
      const p = world.project(0, 13.8, -gt.t * S, RR); if (!p) continue;
      const a = clamp(1 - (gt.t - t) / 40, 0, 1) * clamp((gt.t - t + 1) / 1, 0, 1);
      const sz = clamp(900 / p.w, 14, 40);
      text(g, gt.label, p.x, p.y, { align: 'center', size: sz, font: FONT.cn, color: gt.color, alpha: a, glow: 'rgba(0,0,0,0.9)', blur: 10, weight: 600 });
    }
    for (const cd of I.cadences || []) {
      if (cd.t < t - 0.5 || cd.t > t + 25) continue;
      const p = world.project(0, 11.4, -cd.t * S, RR); if (!p) continue;
      const a = clamp(1 - (cd.t - t) / 25, 0, 1);
      const info = CAD[cd.type];
      text(g, `${info.cn}  ${cd.from ? cd.from + '→' : ''}${cd.to || ''}`, p.x, p.y, { align: 'center', size: clamp(600 / p.w, 12, 26), font: FONT.cn, color: info.hex, alpha: a * 0.95, glow: 'rgba(0,0,0,0.9)', blur: 8 });
    }

    // ---- HUD: chord (function colour) · tension · stems legend
    const ci = F.chordIdx(t), cc = ci >= 0 ? F.chords[ci] : null;
    const hx = R.x + 6, hy = R.y + R.h - 58;
    if (cc && cc.label !== 'N') {
      const fn = cc.func_local || cc.function, col = funcHex(fn);
      roundRect(g, hx, hy, 300, 56, 10); g.fillStyle = 'rgba(10,8,7,0.62)'; g.fill();
      g.fillStyle = col; g.fillRect(hx, hy + 8, 4, 40);
      const w1 = text(g, cc.label, hx + 18, hy + 38, { size: 30, font: FONT.num, color: PAL.cream, weight: 500 });
      text(g, cc.roman_local || cc.roman || '', hx + 30 + w1, hy + 37, { size: 22, font: FONT.num, color: col, weight: 600 });
      text(g, FUNC_CN[fn] || '', hx + 30 + w1, hy + 52, { size: 12, font: FONT.cn, color: PAL.gray });
    }
    const tx = R.x + R.w - 236, ty = R.y + R.h - 58;
    roundRect(g, tx, ty, 230, 56, 10); g.fillStyle = 'rgba(10,8,7,0.62)'; g.fill();
    text(g, '张力', tx + 14, ty + 24, { size: 14, font: FONT.cn, color: PAL.gray });
    text(g, String(Math.round(mem.ten * 100)), tx + 216, ty + 26, { align: 'right', size: 22, font: FONT.num, color: rgba(PAL.cream, 1) });
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(tx + 14, ty + 36, 202, 6);
    const [r1, g1, b1] = tensionRGB(mem.ten);
    g.fillStyle = `rgb(${r1},${g1},${b1})`; g.fillRect(tx + 14, ty + 36, 202 * clamp(mem.ten, 0, 1), 6);
    // stems legend (tiny) top-left inside the frame
    let lx = R.x + 6;
    for (const s of world.stems || []) {
      g.fillStyle = s.color; g.fillRect(lx, R.y - 22, 10, 10);
      lx += 16 + text(g, STEM_CN[s.name] || s.name, lx + 15, R.y - 13, { size: 13, font: FONT.cn, color: PAL.gray }) + 14;
    }
  },
};
