// Cinema scenes, part A — every visual from the reference film.
// Each scene: { title, desc(S) → string, draw(g, S) }.
// S = { t, F (Feed), R {x,y,w,h}, ch (chapter), chIdx, age, mem, dt, now }
import {
  PAL, F as FONT, FIFTHS, NOTE, STEM_COL, clamp, lerp, easeOut, mmss, midiName, hz2midi,
  rgba, mixHex, text, line, circle, glowDot, roundRect, heatCanvas, lutColor,
} from './fx.js';

const TAU = Math.PI * 2;
const isMinorQ = q => !!q && (q.startsWith('min') || q === 'm' || q === 'm7' || q.startsWith('dim') || q.startsWith('hdim'));
const BLACK = new Set([1, 3, 6, 8, 10]);

export function noData(g, R, what) {
  text(g, `此段缺少 ${what} 数据`, R.x + R.w / 2, R.y + R.h / 2, { align: 'center', color: PAL.gray, size: 26, font: FONT.cn });
}
function triadOf(F) {
  const k = F.key, tonic = k.tonic ?? 0, minor = k.mode === 'minor';
  return new Set([tonic, (tonic + (minor ? 3 : 4)) % 12, (tonic + 7) % 12]);
}
function tonicLabel(F) { const k = F.key; return `${F.noteName(k.tonic ?? 0)}${k.mode === 'minor' ? 'm' : ''}`; }

// ================================================================================================
export const scenesA = {
  // ---------------------------------------------------------------------------------------------
  pianoroll: {
    title: '音高卷帘',
    desc: () => '横轴是时间，纵轴是音高；越亮的地方，那个音越响',
    draw(g, S) {
      const { F, R, t, ch, mem } = S;
      if (!F.cqt) return noData(g, R, 'CQT');
      const hm = F.cqt.hm;
      const img = F._cqtImg ||= heatCanvas(hm, F.cqt.data, 'ember', { gamma: 1.45, floor: 0.2 });
      const G = F.S.global || {};
      let lo = (G.range_lo ?? 36) - 3, hi = (G.range_hi ?? 84) + 2;
      if (hi - lo < 40) { const c = (hi + lo) / 2; lo = c - 20; hi = c + 20; }
      lo = Math.max(24, Math.floor(lo)); hi = Math.min(24 + Math.floor(hm.rows / 3) - 1, Math.ceil(hi));
      const kbW = 84, x0 = R.x + kbW + 10, x1 = R.x + R.w, y0 = R.y + 34, y1 = R.y + R.h - 6;
      const past = 8, fut = 4, span = past + fut;
      const nowX = x0 + (x1 - x0) * past / span;
      const n = hi - lo + 1, semH = (y1 - y0) / n;
      const yOf = m => y1 - (m - lo + 0.5) * semH;

      // spectrogram strip
      const cps = hm.cols / (hm.t1 - hm.t0);
      let ta = t - past, tb = t + fut, dxa = x0, dxb = x1;
      if (ta < hm.t0) { dxa = x0 + (hm.t0 - ta) / span * (x1 - x0); ta = hm.t0; }
      if (tb > hm.t1) { dxb = x1 - (tb - hm.t1) / span * (x1 - x0); tb = hm.t1; }
      const rowTop = (hi - 24) * 3 + 1.5, rowBot = (lo - 24) * 3 - 1.5;
      g.save();
      g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.clip();
      for (let m = lo; m <= hi; m++) if (BLACK.has(m % 12)) { g.fillStyle = 'rgba(255,255,255,0.018)'; g.fillRect(x0, yOf(m) - semH / 2, x1 - x0, semH); }
      if (tb > ta) {
        g.imageSmoothingEnabled = true;
        g.drawImage(img, (ta - hm.t0) * cps, hm.rows - rowTop, (tb - ta) * cps, rowTop - rowBot, dxa, y0, dxb - dxa, y1 - y0);
      }
      // future is veiled, edges fade
      g.fillStyle = rgba(PAL.bg, 0.62); g.fillRect(nowX, y0, x1 - nowX, y1 - y0);
      const fl = g.createLinearGradient(x0, 0, x0 + 120, 0);
      fl.addColorStop(0, rgba(PAL.bg, 1)); fl.addColorStop(1, rgba(PAL.bg, 0));
      g.fillStyle = fl; g.fillRect(x0, y0, 120, y1 - y0);
      const fr = g.createLinearGradient(x1 - 90, 0, x1, 0);
      fr.addColorStop(0, rgba(PAL.bg, 0)); fr.addColorStop(1, rgba(PAL.bg, 1));
      g.fillStyle = fr; g.fillRect(x1 - 90, y0, 90, y1 - y0);
      // octave lines
      for (let m = lo; m <= hi; m++) if (m % 12 === 0) line(g, x0, yOf(m) + semH / 2, x1, yOf(m) + semH / 2, 'rgba(232,192,106,0.08)', 1);
      g.restore();

      // reference lines
      const mHi = ch?.m?.range_hi;
      if (mHi && mHi >= lo && mHi <= hi) {
        const y = yOf(mHi) - semH / 2;
        line(g, x0, y, x1, y, rgba(PAL.red, 0.85), 1.5, [8, 6]);
        text(g, `${midiName(mHi)} · 本段音域上限`, x1 - 8, y - 10, { align: 'right', color: PAL.red, size: 20, font: FONT.cn });
      }
      const m150 = hz2midi(150);
      if (m150 > lo && m150 < hi) {
        const y = yOf(m150);
        line(g, x0, y, x1, y, rgba(PAL.gold, 0.45), 1, [3, 6]);
        text(g, '≈150 Hz', x0 + 130, y - 8, { color: PAL.goldDim, size: 18, font: FONT.num });
      }

      // now line
      const gl = g.createLinearGradient(nowX - 30, 0, nowX + 2, 0);
      gl.addColorStop(0, rgba(PAL.gold, 0)); gl.addColorStop(1, rgba(PAL.gold, 0.16));
      g.fillStyle = gl; g.fillRect(nowX - 30, y0, 32, y1 - y0);
      line(g, nowX, y0 - 8, nowX, y1, PAL.gold, 2);
      text(g, '现在', nowX, y0 - 14, { align: 'center', color: PAL.gold, size: 18, font: FONT.cn });
      text(g, '← 已播放', x0 + 130, y0 - 14, { color: PAL.gray, size: 17, font: FONT.cn });
      text(g, '即将到来 →', x1 - 10, y0 - 14, { align: 'right', color: PAL.gray, size: 17, font: FONT.cn });

      // keyboard with active keys
      const col = mem.col = F.column('cqt', t, mem.col);
      mem.lvl ||= new Float32Array(128);
      for (let m = lo; m <= hi; m++) {
        const r = (m - 24) * 3;
        let v = 0; for (let k = -1; k <= 1; k++) if (r + k >= 0 && r + k < col.length) v = Math.max(v, col[r + k]);
        const target = clamp((v - 0.66) / 0.28, 0, 1);
        mem.lvl[m] = Math.max(target, mem.lvl[m] * 0.86);
      }
      for (let pass = 0; pass < 2; pass++) {
        for (let m = lo; m <= hi; m++) {
          const blk = BLACK.has(m % 12);
          if ((pass === 0) === blk) continue;
          const y = yOf(m) - semH / 2, k = mem.lvl[m];
          const w = blk ? kbW * 0.6 : kbW;
          g.fillStyle = blk ? mixHex('#1b1512', PAL.red, k) : mixHex('#d8cfbf', PAL.red, k);
          g.fillRect(R.x, y + 0.5, w, Math.max(1, semH - 1));
          if (k > 0.05) {
            const gx = g.createLinearGradient(x0, 0, nowX, 0);
            gx.addColorStop(0, rgba(PAL.red, 0)); gx.addColorStop(1, rgba(PAL.redHi, 0.5 * k));
            g.fillStyle = gx; g.fillRect(nowX - 140, y + 1, 140, Math.max(1, semH - 2));
            glowDot(g, nowX, y + semH / 2, 2.5 + 2 * k, PAL.redHi, k);
          }
          if (m % 12 === 0) text(g, midiName(m), R.x + kbW - 6, y + semH / 2 + 5, { align: 'right', color: '#5a5048', size: 13, font: FONT.num });
        }
      }
    },
  },

  // ---------------------------------------------------------------------------------------------
  chromaclock: {
    title: '音级时钟',
    desc: S => `12 个音级按五度圈排列 · 内圈是此刻，外环是从 0:00 起的累计`,
    draw(g, S) {
      const { F, R, t, mem } = S;
      if (!F.chromaPS) return noData(g, R, '色度');
      const cx = R.x + R.w * 0.4, cy = R.y + R.h * 0.5, rr = Math.min(R.h * 0.44, 290);
      const cur = F.chromaRange(t - 0.5, t + 0.05), acc = F.chromaRange(0, Math.max(0.2, t));
      const cm = Math.max(...cur, 1e-6), am = Math.max(...acc, 1e-6);
      mem.cur ||= new Float32Array(12);
      for (let i = 0; i < 12; i++) mem.cur[i] = lerp(mem.cur[i], cur[i] / cm, 0.25);
      const tri = triadOf(F);
      const dom = acc.indexOf(Math.max(...acc));
      const step = TAU / 12;
      // rings
      for (const r of [rr * 0.2, rr * 0.62, rr * 0.7, rr * 0.98]) circle(g, cx, cy, r, null, 'rgba(232,192,106,0.12)', 1);
      for (let i = 0; i < 12; i++) {
        const a = -Math.PI / 2 + i * step;
        line(g, cx + Math.cos(a) * rr * 0.2, cy + Math.sin(a) * rr * 0.2, cx + Math.cos(a) * rr * 0.98, cy + Math.sin(a) * rr * 0.98, 'rgba(232,192,106,0.06)', 1);
      }
      for (let i = 0; i < 12; i++) {
        const pc = FIFTHS[i], a = -Math.PI / 2 + i * step;
        const isT = tri.has(pc), col = isT ? PAL.red : PAL.gold;
        // inner wedge: now
        const v = mem.cur[pc], r0 = rr * 0.2, r1 = r0 + v * (rr * 0.6 - r0);
        const gr = g.createRadialGradient(cx, cy, r0, cx, cy, Math.max(r0 + 1, r1));
        gr.addColorStop(0, rgba(col, 0.15)); gr.addColorStop(1, rgba(col, 0.25 + 0.65 * v));
        g.fillStyle = gr;
        g.beginPath(); g.arc(cx, cy, r1, a - step * 0.4, a + step * 0.4); g.arc(cx, cy, r0, a + step * 0.4, a - step * 0.4, true); g.closePath(); g.fill();
        if (v > 0.8) { g.save(); g.shadowColor = col; g.shadowBlur = 24; g.strokeStyle = rgba(col, 0.9); g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, r1, a - step * 0.4, a + step * 0.4); g.stroke(); g.restore(); }
        // outer ring: cumulative
        const u = acc[pc] / am, q0 = rr * 0.7, q1 = q0 + u * rr * 0.27;
        g.fillStyle = rgba(col, 0.18 + 0.5 * u);
        g.beginPath(); g.arc(cx, cy, q1, a - step * 0.44, a + step * 0.44); g.arc(cx, cy, q0, a + step * 0.44, a - step * 0.44, true); g.closePath(); g.fill();
        // labels
        const lr = rr + 36;
        text(g, F.fifthName(pc), cx + Math.cos(a) * lr, cy + Math.sin(a) * lr + 9, {
          align: 'center', size: isT ? 30 : 26, font: FONT.display, color: isT ? PAL.red : (v > 0.7 ? PAL.cream : PAL.gray), weight: isT ? 600 : 400,
        });
      }
      // centre: dominant
      circle(g, cx, cy, rr * 0.19, rgba(PAL.bg, 0.9), rgba(PAL.gold, 0.3), 1);
      text(g, F.noteName(dom), cx, cy + 14, { align: 'center', size: 58, font: FONT.display, color: tri.has(dom) ? PAL.red : PAL.gold, glow: rgba(PAL.gold, 0.4) });
      text(g, '主导音', cx, cy + 44, { align: 'center', size: 16, font: FONT.cn, color: PAL.gray });
      // legend
      const lx = R.x + R.w * 0.8, ly = R.y + R.h * 0.3;
      const leg = [[PAL.gold, '内圈', '此刻 0.5 秒内的音级能量'], [rgba(PAL.gold, 0.5), '外环', '从 0:00 开始累计'], [PAL.red, '红色', `主三和弦 ${tonicLabel(F)}`]];
      leg.forEach(([c, a, b], i) => {
        g.fillStyle = c; g.fillRect(lx, ly + i * 74, 14, 14);
        text(g, a, lx + 26, ly + i * 74 + 14, { size: 22, font: FONT.cn, color: PAL.cream });
        text(g, b, lx + 26, ly + i * 74 + 42, { size: 17, font: FONT.cn, color: PAL.gray });
      });
    },
  },

  // ---------------------------------------------------------------------------------------------
  rhythmspiral: {
    title: '节奏螺旋',
    desc: () => '每转一圈是一小节，点是起音，落在哪个角度就是这一拍的哪个位置',
    draw(g, S) {
      const { F, R, t, ch } = S;
      const bars = F.bars;
      if (!bars.length) return noData(g, R, '节拍');
      const cx = R.x + R.w * 0.37, cy = R.y + R.h * 0.5, rmax = Math.min(R.h * 0.45, 300), r0 = 26;
      const i0 = Math.max(0, bars.findIndex(b => b[1] > ch.start)), i1 = Math.max(i0 + 1, bars.findIndex(b => b[0] >= ch.end) < 0 ? bars.length : bars.findIndex(b => b[0] >= ch.end));
      const N = Math.max(1, i1 - i0);
      let rad = () => r0;
      const pos = tt => { // continuous bar position relative to chapter
        let lo = i0, hi = i1 - 1, k = i0;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m][0] <= tt) { k = m; lo = m + 1; } else hi = m - 1; }
        const [a, b] = bars[k]; return (k - i0) + clamp((tt - a) / Math.max(1e-3, b - a), 0, 0.9999);
      };
      const pNow = pos(t);
      const denom = Math.max(6, pNow + 1);
      rad = p => r0 + clamp(p / denom, 0, 1) * (rmax - r0);
      // spokes
      for (let s = 0; s < 8; s++) {
        const a = -Math.PI / 2 + s / 8 * TAU, main = s % 2 === 0;
        line(g, cx, cy, cx + Math.cos(a) * (rmax + 18), cy + Math.sin(a) * (rmax + 18), main ? 'rgba(232,192,106,0.22)' : 'rgba(232,192,106,0.08)', 1, main ? null : [3, 5]);
        if (main) text(g, `第${s / 2 + 1}拍`, cx + Math.cos(a) * (rmax + 46), cy + Math.sin(a) * (rmax + 46) + 7, { align: 'center', size: 19, font: FONT.cn, color: PAL.goldDim });
      }
      // spiral guide
      g.beginPath();
      for (let p = 0; p <= Math.min(N, denom); p += 1 / 64) { const a = -Math.PI / 2 + (p % 1) * TAU, r = rad(p); p === 0 ? g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r) : g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
      g.strokeStyle = 'rgba(232,192,106,0.07)'; g.lineWidth = 1; g.stroke();
      // onsets
      const oe = F.A.rhythm.onset_env;
      const on = F.onsets;
      let mx = 1e-6; if (oe?.v) for (const v of oe.v) mx = Math.max(mx, v);
      for (let i = 0; i < on.length; i++) {
        const o = on[i]; if (o < (bars[i0]?.[0] ?? ch.start) || o > t || o >= ch.end) continue;
        const p = pos(o), ph = p % 1, a = -Math.PI / 2 + ph * TAU, r = rad(p);
        const strength = oe ? clamp(F.series(oe, o) / mx, 0, 1) : 0.5;
        const grid = Math.abs(ph * 8 - Math.round(ph * 8)) < 0.14;
        const age = t - o;
        const col = grid ? PAL.gold : PAL.red;
        const sz = 2.5 + strength * 6;
        if (age < 0.4) glowDot(g, cx + Math.cos(a) * r, cy + Math.sin(a) * r, sz * (1.6 - age), col, 1 - age);
        else circle(g, cx + Math.cos(a) * r, cy + Math.sin(a) * r, sz, rgba(col, 0.55 + 0.35 * strength));
      }
      // hand
      const p = pos(t), a = -Math.PI / 2 + (p % 1) * TAU, r = rad(p);
      g.save(); g.shadowColor = PAL.gold; g.shadowBlur = 16;
      line(g, cx, cy, cx + Math.cos(a) * (r + 14), cy + Math.sin(a) * (r + 14), rgba(PAL.goldHi, 0.85), 2);
      g.restore();
      glowDot(g, cx + Math.cos(a) * r, cy + Math.sin(a) * r, 5, PAL.goldHi);
      // centre
      const b = F.barAt(t);
      circle(g, cx, cy, 22, rgba(PAL.bg, 0.95), rgba(PAL.gold, 0.4));
      text(g, `${b.idx + 1}`, cx, cy + 9, { align: 'center', size: 26, font: FONT.num, weight: 600, color: PAL.goldHi });
      text(g, '小节', cx, cy + 40, { align: 'center', size: 14, font: FONT.cn, color: PAL.gray });
      // legend
      text(g, '● 金色：落在八分音符网格上', R.x + 8, R.y + R.h - 34, { size: 17, font: FONT.cn, color: PAL.gold });
      text(g, '● 红色：网格之外的切分/装饰', R.x + 8, R.y + R.h - 8, { size: 17, font: FONT.cn, color: PAL.red });

      // harmonic vs percussive layers
      const L = F.layers(t);
      const bx = R.x + R.w * 0.76, bw = 64, by0 = R.y + 70, by1 = R.y + R.h - 70;
      [['和声层', L.harm, PAL.gold], ['打击层', L.perc, PAL.red]].forEach(([nm, v, c], i) => {
        const x = bx + i * (bw + 56);
        roundRect(g, x, by0, bw, by1 - by0, 6); g.fillStyle = 'rgba(255,255,255,0.03)'; g.fill();
        g.strokeStyle = 'rgba(232,192,106,0.15)'; g.stroke();
        const hh = (by1 - by0) * clamp(v, 0, 1);
        const gr = g.createLinearGradient(0, by1, 0, by0); gr.addColorStop(0, rgba(c, 0.25)); gr.addColorStop(1, c);
        roundRect(g, x + 4, by1 - hh, bw - 8, Math.max(0, hh - 4), 4); g.fillStyle = gr; g.fill();
        text(g, `${Math.round(v * 100)}`, x + bw / 2, by0 - 14, { align: 'center', size: 30, font: FONT.num, weight: 600, color: c });
        text(g, nm, x + bw / 2, by1 + 34, { align: 'center', size: 20, font: FONT.cn, color: PAL.cream });
      });
      if (ch?.m?.grid != null) text(g, `本段起音的 ${Math.round(ch.m.grid * 100)}% 落在八分网格上`, bx - 10, by1 + 72, { size: 17, font: FONT.cn, color: PAL.gray });
    },
  },

  // ---------------------------------------------------------------------------------------------
  spectrumbars: {
    title: '实时频谱',
    desc: () => '从左到右由低到高，柱子越高该频段越响 · 下方为各章节的频段占比',
    draw(g, S) {
      const { F, R, t, mem, chIdx } = S;
      if (!F.stft) return noData(g, R, '频谱');
      const hz = F.stftHz, N = 84, fmin = 30, fmax = Math.min(16000, hz[hz.length - 1] * 0.97);
      const x0 = R.x + 10, x1 = R.x + R.w - 10, base = R.y + R.h * 0.58, top = R.y + 30;
      const col = mem.col = F.column('stft', t, mem.col);
      mem.v ||= new Float32Array(N); mem.pk ||= new Float32Array(N); mem.pt ||= new Float32Array(N);
      if (!mem.map) {
        mem.map = [];
        for (let i = 0; i < N; i++) {
          const fa = fmin * Math.pow(fmax / fmin, i / N), fb = fmin * Math.pow(fmax / fmin, (i + 1) / N);
          let ra = hz.findIndex(f => f >= fa), rb = hz.findIndex(f => f >= fb);
          if (ra < 0) ra = hz.length - 1; if (rb < 0) rb = hz.length; rb = Math.max(ra + 1, rb);
          mem.map.push([ra, rb]);
        }
      }
      const bw = (x1 - x0) / N;
      const grad = g.createLinearGradient(0, base, 0, top);
      grad.addColorStop(0, PAL.redDim); grad.addColorStop(0.35, PAL.red); grad.addColorStop(0.75, '#F08A4B'); grad.addColorStop(1, PAL.goldHi);
      for (let i = 0; i < N; i++) {
        const [ra, rb] = mem.map[i];
        let v = 0; for (let r = ra; r < rb; r++) v = Math.max(v, col[r]);
        v = clamp((v - 0.3) / 0.62, 0, 1); v = Math.pow(v, 1.35);
        mem.v[i] = v > mem.v[i] ? lerp(mem.v[i], v, 0.6) : mem.v[i] * 0.9 + v * 0.1;
        if (mem.v[i] >= mem.pk[i]) { mem.pk[i] = mem.v[i]; mem.pt[i] = S.now; } else if (S.now - mem.pt[i] > 0.45) mem.pk[i] = Math.max(mem.v[i], mem.pk[i] - 0.012);
        const hgt = mem.v[i] * (base - top), x = x0 + i * bw + 1.5, w = bw - 3;
        g.fillStyle = grad; g.fillRect(x, base - hgt, w, hgt);
        // reflection
        g.fillStyle = rgba(PAL.red, 0.12 * mem.v[i] + 0.02); g.fillRect(x, base + 3, w, hgt * 0.28);
        // peak hold
        const py = base - mem.pk[i] * (base - top);
        g.fillStyle = mem.pk[i] > 0.8 ? PAL.goldHi : rgba(PAL.gold, 0.8); g.fillRect(x, py - 3, w, 2);
      }
      const fade = g.createLinearGradient(0, base, 0, base + (base - top) * 0.3);
      fade.addColorStop(0, rgba(PAL.bg, 0)); fade.addColorStop(1, rgba(PAL.bg, 1));
      g.fillStyle = fade; g.fillRect(x0, base + 2, x1 - x0, (base - top) * 0.3);
      line(g, x0, base + 1, x1, base + 1, rgba(PAL.gold, 0.35), 1);
      // bands
      const xf = f => x0 + Math.log(f / fmin) / Math.log(fmax / fmin) * (x1 - x0);
      const edges = F.S.bands5_edges || [[20, 150], [150, 500], [500, 2000], [2000, 6000], [6000, 20000]];
      const names = F.S.bands5 || ['低频', '中低', '中频', '中高', '高频'];
      edges.forEach(([a, b], i) => {
        if (i) line(g, xf(a), top - 10, xf(a), base + 40, 'rgba(232,192,106,0.12)', 1, [2, 5]);
        const xm = (xf(Math.max(a, fmin)) + xf(Math.min(b, fmax))) / 2;
        text(g, names[i], xm, base + 36, { align: 'center', size: 20, font: FONT.cn, color: PAL.cream });
        text(g, `${a >= 1000 ? a / 1000 + 'k' : a}–${b >= 1000 ? b / 1000 + 'k' : b} Hz`, xm, base + 58, { align: 'center', size: 13, font: FONT.num, color: PAL.gray });
      });
      // band share per chapter
      const chs = F.chapters, cols = [PAL.blue, PAL.teal, PAL.gold, '#F08A4B', PAL.red];
      const sy0 = base + 84, rowH = Math.min(26, (R.y + R.h - sy0) / Math.max(1, chs.length) - 6), lx = x0 + 56;
      chs.forEach((c, i) => {
        if (i > chIdx || !c.m?.bands) return;
        const y = sy0 + i * (rowH + 6), cur = i === chIdx;
        text(g, c.roman, x0 + 40, y + rowH - 6, { align: 'right', size: 18, font: FONT.display, color: cur ? PAL.goldHi : PAL.gray });
        let x = lx; const tot = c.m.bands.reduce((a, b) => a + b, 0) || 1, W2 = x1 - lx - 140;
        c.m.bands.forEach((v, k) => {
          const w = v / tot * W2;
          g.fillStyle = rgba(cols[k], cur ? 0.95 : 0.45); g.fillRect(x, y, Math.max(0, w - 2), rowH);
          if (cur && w > 46) text(g, `${Math.round(v)}%`, x + w / 2, y + rowH - 7, { align: 'center', size: 14, font: FONT.num, color: '#120d0a', weight: 600 });
          x += w;
        });
        text(g, `${c.name}`, x1 - 130, y + rowH - 6, { size: 16, font: FONT.cn, color: cur ? PAL.cream : PAL.dim });
      });
    },
  },

  // ---------------------------------------------------------------------------------------------
  chordorbit: {
    title: '和弦轨道',
    desc: () => '外圈是大三和弦、内圈是小三和弦，按五度圈排列；连线是最近的和弦走向',
    draw(g, S) {
      const { F, R, t, mem, ch } = S;
      const chords = F.chords; if (!chords.length) return noData(g, R, '和弦');
      const cx = R.x + R.w * 0.38, cy = R.y + R.h * 0.42, ro = Math.min(R.h * 0.36, 230), ri = ro * 0.64;
      const nodePos = c => {
        if (c.root == null) return null;
        const minor = isMinorQ(c.quality);
        const i = FIFTHS.indexOf(minor ? (c.root + 3) % 12 : c.root);
        const a = -Math.PI / 2 + i / 12 * TAU, r = minor ? ri : ro;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, minor];
      };
      circle(g, cx, cy, ro, null, 'rgba(232,192,106,0.14)', 1);
      circle(g, cx, cy, ri, null, 'rgba(232,192,106,0.10)', 1);
      // visit heat within the chapter
      const heat = mem.heat = new Map();
      const ci = F.chordIdx(t);
      for (let i = 0; i <= Math.max(ci, -1) && i < chords.length; i++) {
        const c = chords[i]; if (c.end < ch.start || c.root == null) continue;
        const k = `${isMinorQ(c.quality) ? 'm' : 'M'}${c.root}`;
        heat.set(k, (heat.get(k) || 0) + Math.min(t, c.end) - Math.max(ch.start, c.start));
      }
      const hmax = Math.max(1, ...heat.values());
      // all 24 nodes
      for (let i = 0; i < 12; i++) {
        const a = -Math.PI / 2 + i / 12 * TAU;
        for (const minor of [false, true]) {
          const root = minor ? (FIFTHS[i] + 9) % 12 : FIFTHS[i];
          const r = minor ? ri : ro, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          const h = (heat.get(`${minor ? 'm' : 'M'}${root}`) || 0) / hmax;
          circle(g, x, y, 5 + h * 9, rgba(PAL.gold, 0.08 + h * 0.4), rgba(PAL.gold, 0.25 + h * 0.4), 1);
          const lr = minor ? r - 30 : r + 34;
          text(g, F.fifthName(root, minor) + (minor ? 'm' : ''), cx + Math.cos(a) * lr, cy + Math.sin(a) * lr + 7, {
            align: 'center', size: minor ? 16 : 20, font: FONT.display, color: h > 0.05 ? PAL.cream : PAL.dim,
          });
        }
      }
      // links of recent chords
      const recent = [];
      for (let i = ci; i >= 0 && recent.length < 10; i--) if (chords[i].root != null) recent.unshift(i);
      for (let k = 1; k < recent.length; k++) {
        const A = nodePos(chords[recent[k - 1]]), B = nodePos(chords[recent[k]]);
        if (!A || !B) continue;
        const al = (k / recent.length) ** 1.5;
        const col = chords[recent[k]].function === 'X' ? PAL.red : PAL.gold;
        g.save(); g.shadowColor = col; g.shadowBlur = 10 * al;
        g.strokeStyle = rgba(col, 0.15 + 0.75 * al); g.lineWidth = 1 + 2.5 * al;
        g.beginPath(); g.moveTo(A[0], A[1]);
        g.quadraticCurveTo(lerp(A[0], B[0], 0.5) * 0.8 + cx * 0.2, lerp(A[1], B[1], 0.5) * 0.8 + cy * 0.2, B[0], B[1]); g.stroke();
        g.restore();
      }
      // current
      if (ci >= 0 && chords[ci].root != null) {
        const c = chords[ci], P = nodePos(c), col = c.function === 'X' ? PAL.red : PAL.gold;
        const pulse = 1 + 0.25 * Math.exp(-(t - c.start) * 5);
        glowDot(g, P[0], P[1], 11 * pulse, col);
        text(g, c.label, cx, cy + 16, { align: 'center', size: 56, font: FONT.display, color: col === PAL.red ? PAL.redHi : PAL.goldHi, glow: rgba(col, 0.5) });
        text(g, c.roman || '', cx, cy + 50, { align: 'center', size: 20, font: FONT.serif, italic: true, color: PAL.gray });
      }
      // strip
      const sx0 = R.x, sx1 = R.x + R.w, sy = R.y + R.h - 78, sh = 44, wa = t - 14, wb = t + 6;
      const xs = tt => sx0 + (tt - wa) / (wb - wa) * (sx1 - sx0);
      g.save(); g.beginPath(); g.rect(sx0, sy - 30, sx1 - sx0, sh + 60); g.clip();
      for (let i = Math.max(0, F.find(chords, wa)); i < chords.length && chords[i].start < wb; i++) {
        const c = chords[i]; if (c.label === 'N') continue;
        const xa = xs(c.start), xb = xs(c.end), col = c.function === 'X' ? PAL.red : PAL.gold, fut = c.start > t;
        roundRect(g, xa + 1, sy, Math.max(1, xb - xa - 2), sh, 4);
        g.fillStyle = rgba(col, fut ? 0.12 : i === ci ? 0.85 : 0.35); g.fill();
        if (xb - xa > 34) text(g, c.label, (xa + xb) / 2, sy + 29, { align: 'center', size: 17, font: FONT.num, weight: 600, color: i === ci ? '#120d0a' : fut ? PAL.dim : PAL.cream, maxW: xb - xa - 6 });
      }
      g.restore();
      line(g, xs(t), sy - 10, xs(t), sy + sh + 10, PAL.red, 2);
      text(g, '■ 调内和弦', sx0, sy + sh + 34, { size: 16, font: FONT.cn, color: PAL.gold });
      text(g, '■ 调外 / 借用和弦', sx0 + 120, sy + sh + 34, { size: 16, font: FONT.cn, color: PAL.red });
    },
  },

  // ---------------------------------------------------------------------------------------------
  keytrail: {
    title: '调性中心轨迹',
    desc: () => '每个点是前后 8 秒的调性重心，在五度圈上移动',
    draw(g, S) {
      const { F, R, t, ch } = S;
      const kt = F.S.key_trail; if (!kt?.t?.length) return noData(g, R, '调性轨迹');
      const cx = R.x + R.w * 0.42, cy = R.y + R.h * 0.48, rr = Math.min(R.h * 0.42, 270);
      // background halves: flat side dark, sharp side bright
      const bg = g.createLinearGradient(cx - rr, 0, cx + rr, 0);
      bg.addColorStop(0, rgba(PAL.blue, 0.07)); bg.addColorStop(0.5, rgba(PAL.gold, 0.0)); bg.addColorStop(1, rgba(PAL.gold, 0.07));
      circle(g, cx, cy, rr * 1.12, bg);
      circle(g, cx, cy, rr, null, 'rgba(232,192,106,0.2)', 1);
      circle(g, cx, cy, rr * 0.64, null, 'rgba(232,192,106,0.12)', 1);
      for (let i = 0; i < 12; i++) {
        const a = -Math.PI / 2 + i / 12 * TAU, pc = FIFTHS[i];
        line(g, cx + Math.cos(a) * rr * 0.95, cy + Math.sin(a) * rr * 0.95, cx + Math.cos(a) * rr * 1.05, cy + Math.sin(a) * rr * 1.05, 'rgba(232,192,106,0.4)', 1);
        text(g, F.fifthName(pc), cx + Math.cos(a) * (rr + 34), cy + Math.sin(a) * (rr + 34) + 8, { align: 'center', size: 24, font: FONT.display, color: PAL.ink });
        text(g, F.fifthName((pc + 9) % 12, true) + 'm', cx + Math.cos(a) * (rr * 0.64 - 26), cy + Math.sin(a) * (rr * 0.64 - 26) + 6, { align: 'center', size: 15, font: FONT.display, color: PAL.gray });
      }
      const P = i => [cx + kt.x[i] * rr, cy + kt.y[i] * rr];
      let last = -1;
      for (let i = 1; i < kt.t.length && kt.t[i] <= t; i++) {
        const [x0, y0] = P(i - 1), [x1, y1] = P(i);
        const after = kt.t[i] >= ch.start, age = t - kt.t[i];
        const al = after ? 0.9 : clamp(0.55 - age / 240, 0.12, 0.55);
        line(g, x0, y0, x1, y1, rgba(after ? PAL.red : PAL.gold, al), after ? 2.2 : 1.4);
        last = i;
      }
      if (last >= 0) {
        // interpolate current point
        const j = Math.min(last + 1, kt.t.length - 1), k = clamp((t - kt.t[last]) / Math.max(0.01, kt.t[j] - kt.t[last]), 0, 1);
        const [ax, ay] = P(last), [bx, by] = P(j);
        glowDot(g, lerp(ax, bx, k), lerp(ay, by, k), 8, PAL.redHi);
      }
      text(g, F.keyName(F.keyAt(t)), cx, cy + 14, { align: 'center', size: 40, font: FONT.cn, color: PAL.goldHi, glow: rgba(PAL.gold, 0.35) });
      text(g, '当前调性', cx, cy + 46, { align: 'center', size: 16, font: FONT.cn, color: PAL.gray });
      // hints
      const hy = R.y + R.h - 14;
      text(g, '↺ 逆时针：降号增多（更暗）', R.x + 6, hy, { size: 19, font: FONT.cn, color: PAL.blue });
      text(g, '顺时针：升号增多（更亮）↻', R.x + R.w * 0.84, hy, { align: 'right', size: 19, font: FONT.cn, color: PAL.gold });
      const lx = R.x + R.w * 0.8;
      text(g, '— 本章之前', lx, R.y + 80, { size: 18, font: FONT.cn, color: PAL.gold });
      text(g, '— 本章', lx, R.y + 112, { size: 18, font: FONT.cn, color: PAL.red });
    },
  },

  // ---------------------------------------------------------------------------------------------
  oscilloscope: {
    title: '示波器',
    desc: () => '声音的原始波形 · 数字是瞬时响度',
    draw(g, S) {
      const { F, R, t, mem, ch, chIdx } = S;
      const sm = F.samples(t, 4096);
      const cy = R.y + R.h * 0.62, x0 = R.x, x1 = R.x + R.w;
      const lu = F.mlufs(t);
      const prev = F.chapters[chIdx - 1]?.m?.lufs ?? F.S.global?.lufs ?? -14;
      const drop = clamp((prev - lu) / 18, 0, 1);
      if (sm) {
        const [L, Rr] = sm, n = L.length, step = 2;
        g.save(); g.shadowColor = mixHex(PAL.gold, PAL.red, drop); g.shadowBlur = 18;
        g.strokeStyle = rgba(mixHex(PAL.goldHi, PAL.red, drop), 0.9); g.lineWidth = 2;
        g.beginPath();
        for (let i = 0; i < n; i += step) {
          const v = (L[i] + Rr[i]) * 0.5, x = x0 + i / n * (x1 - x0), y = cy - clamp(v * 520, -R.h * 0.3, R.h * 0.3);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke(); g.restore();
      }
      line(g, x0, cy, x1, cy, 'rgba(232,192,106,0.12)', 1);
      mem.lu = mem.lu == null ? lu : lerp(mem.lu, lu, 0.15);
      const col = mixHex(PAL.goldHi, PAL.red, drop);
      text(g, mem.lu <= -69 ? '−∞' : mem.lu.toFixed(1), R.x + R.w / 2, R.y + R.h * 0.3, { align: 'center', size: 150, font: FONT.display, color: col, glow: rgba(col, 0.35), blur: 40 });
      text(g, 'LUFS · 瞬时响度', R.x + R.w / 2, R.y + R.h * 0.3 + 46, { align: 'center', size: 20, font: FONT.cn, color: PAL.gray, ls: 2 });
    },
  },

  // ---------------------------------------------------------------------------------------------
  ridgeline: {
    title: '频谱山脊',
    desc: () => '每条线是一个时刻的频谱，最前面是现在，越往后越早',
    draw(g, S) {
      const { F, R, t, mem } = S;
      if (!F.stft) return noData(g, R, '频谱');
      const hz = F.stftHz, N = 34, dtl = 0.16;
      const fmin = 35, fmax = Math.min(14000, hz[hz.length - 1] * 0.97);
      const ra = Math.max(0, hz.findIndex(f => f >= fmin)), rb = hz.findIndex(f => f >= fmax) < 0 ? hz.length : hz.findIndex(f => f >= fmax);
      const x0 = R.x + 30, x1 = R.x + R.w - 30, baseY = R.y + R.h - 60, depth = R.h * 0.6, amp = R.h * 0.24;
      for (let i = N - 1; i >= 0; i--) {
        const tt = t - i * dtl; if (tt < 0) continue;
        const col = mem['c' + (i % 4)] = F.column('stft', tt, mem['c' + (i % 4)]);
        const k = i / (N - 1), shrink = 1 - k * 0.22, cxm = (x0 + x1) / 2;
        const xa = cxm - (cxm - x0) * shrink, xb = cxm + (x1 - cxm) * shrink, by = baseY - k * depth;
        const a = amp * (1 - k * 0.45);
        g.beginPath(); g.moveTo(xa, by);
        const pts = [];
        for (let r = ra; r < rb; r += 2) {
          let v = clamp((col[r] - 0.38) / 0.55, 0, 1); v = v * v;
          const x = xa + (r - ra) / (rb - ra) * (xb - xa), y = by - v * a;
          pts.push(x, y); g.lineTo(x, y);
        }
        g.lineTo(xb, by); g.closePath();
        g.fillStyle = PAL.bg; g.fill();
        const c = i === 0 ? PAL.cream : k < 0.4 ? mixHex(PAL.cream, PAL.pink, k / 0.4) : mixHex(PAL.pink, PAL.gold, (k - 0.4) / 0.6);
        g.strokeStyle = rgba(c, i === 0 ? 1 : 0.85 - k * 0.65); g.lineWidth = i === 0 ? 2.2 : 1.2;
        if (i === 0) { g.save(); g.shadowColor = PAL.cream; g.shadowBlur = 12; }
        g.beginPath(); for (let p = 0; p < pts.length; p += 2) p ? g.lineTo(pts[p], pts[p + 1]) : g.moveTo(pts[p], pts[p + 1]); g.stroke();
        if (i === 0) g.restore();
      }
      // Hz axis
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const r = hz.findIndex(h => h >= f); if (r < ra || r >= rb) continue;
        const x = x0 + (r - ra) / (rb - ra) * (x1 - x0);
        line(g, x, baseY + 6, x, baseY + 14, PAL.gray, 1);
        text(g, f >= 1000 ? `${f / 1000}k` : `${f}`, x, baseY + 36, { align: 'center', size: 16, font: FONT.num, color: PAL.gray });
      }
      text(g, 'Hz', x1, baseY + 36, { align: 'right', size: 16, font: FONT.num, color: PAL.dim });
      text(g, `← ${(N * dtl).toFixed(0)} 秒前`, x0 + (x1 - x0) * 0.11, baseY - depth - 12, { size: 16, font: FONT.cn, color: PAL.goldDim });
    },
  },

  // ---------------------------------------------------------------------------------------------
  lissajous: {
    title: '声像 · 李萨如',
    desc: () => '左右声道画成点云：越竖越集中在中间，越横越宽',
    draw(g, S) {
      const { F, R, t, mem, chIdx } = S;
      const size = Math.min(R.h - 40, 560), cx = R.x + size / 2 + 20, cy = R.y + R.h / 2;
      if (!mem.cv) { mem.cv = document.createElement('canvas'); mem.cv.width = mem.cv.height = 600; mem.cx = mem.cv.getContext('2d'); }
      const c2 = mem.cx;
      c2.globalCompositeOperation = 'destination-out';
      c2.fillStyle = 'rgba(0,0,0,0.24)'; c2.fillRect(0, 0, 600, 600);
      const sm = F.samples(t, 2048);
      let sS = 0, sM = 0;
      if (sm) {
        const [L, Rr] = sm;
        c2.globalCompositeOperation = 'lighter';
        for (let i = 0; i < L.length; i++) {
          const m = (L[i] + Rr[i]) * 0.7071, s = (L[i] - Rr[i]) * 0.7071;
          sS += s * s; sM += m * m;
          if (i % 2) continue;
          const x = 300 + s * 330, y = 300 - m * 330;
          const hot = Math.min(1, Math.hypot(s, m) * 3);
          c2.fillStyle = hot > 0.6 ? 'rgba(255,214,150,0.35)' : 'rgba(229,120,70,0.28)';
          c2.fillRect(x, y, 1.6, 1.6);
        }
      }
      // guides
      const r = size / 2;
      circle(g, cx, cy, r, null, 'rgba(232,192,106,0.1)', 1);
      line(g, cx, cy - r, cx, cy + r, 'rgba(232,192,106,0.18)', 1, [4, 6]);
      line(g, cx - r, cy, cx + r, cy, 'rgba(232,192,106,0.1)', 1, [4, 6]);
      line(g, cx - r * 0.7, cy - r * 0.7, cx + r * 0.7, cy + r * 0.7, 'rgba(232,192,106,0.1)', 1);
      line(g, cx + r * 0.7, cy - r * 0.7, cx - r * 0.7, cy + r * 0.7, 'rgba(232,192,106,0.1)', 1);
      g.save(); g.globalCompositeOperation = 'lighter'; g.shadowColor = PAL.red; g.shadowBlur = 10; g.drawImage(mem.cv, cx - r, cy - r, size, size); g.restore();
      text(g, '中 (M)', cx, cy - r - 12, { align: 'center', size: 19, font: FONT.cn, color: PAL.gold });
      text(g, 'L', cx - r * 0.74, cy - r * 0.74, { align: 'center', size: 22, font: FONT.display, color: PAL.gold });
      text(g, 'R', cx + r * 0.74, cy - r * 0.74, { align: 'center', size: 22, font: FONT.display, color: PAL.gold });
      text(g, '侧 (S)', cx + r - 4, cy - 10, { align: 'right', size: 16, font: FONT.cn, color: PAL.gray });
      const ratio = Math.sqrt(sS / Math.max(1e-9, sM));
      mem.ratio = mem.ratio == null ? ratio : lerp(mem.ratio, ratio, 0.08);
      text(g, mem.ratio.toFixed(2), cx - r, cy + r + 4, { size: 40, font: FONT.num, weight: 600, color: PAL.goldHi });
      text(g, '侧/中 能量比', cx - r + 96, cy + r - 6, { size: 16, font: FONT.cn, color: PAL.gray });

      // pitch range per chapter
      const px0 = cx + r + 110, px1 = R.x + R.w - 10, lo = 24, hi = 96;
      const xm = m => px0 + 40 + (m - lo) / (hi - lo) * (px1 - px0 - 40);
      text(g, '各章节音域', px0, R.y + 34, { size: 22, font: FONT.cn, color: PAL.cream });
      for (let o = 1; o <= 7; o++) {
        const x = xm(12 + o * 12);
        line(g, x, R.y + 56, x, R.y + R.h - 30, 'rgba(232,192,106,0.07)', 1);
        text(g, `C${o}`, x, R.y + R.h - 8, { align: 'center', size: 14, font: FONT.num, color: PAL.gray });
      }
      const chs = F.chapters, rowH = Math.min(36, (R.h - 110) / Math.max(1, chs.length));
      chs.forEach((c, i) => {
        if (c.m?.range_lo == null) return;
        const y = R.y + 70 + i * rowH, cur = i === chIdx;
        text(g, c.roman, px0 + 28, y + rowH * 0.5 + 6, { align: 'right', size: 17, font: FONT.display, color: cur ? PAL.goldHi : PAL.gray });
        const a = xm(c.m.range_lo), b = xm(c.m.range_hi);
        roundRect(g, a, y + rowH * 0.25, Math.max(4, b - a), rowH * 0.5, rowH * 0.25);
        g.fillStyle = cur ? PAL.red : rgba(PAL.gold, i < chIdx ? 0.55 : 0.15); g.fill();
        if (cur) text(g, `${midiName(c.m.range_lo)}–${midiName(c.m.range_hi)}`, b + 10, y + rowH * 0.5 + 6, { size: 15, font: FONT.num, color: PAL.cream });
      });
    },
  },

  // ---------------------------------------------------------------------------------------------
  chromaradar: {
    title: '音高分布雷达',
    desc: () => '12 个音级的分布形状：金色是序章，蓝色是中段，红色是此刻所在的章节',
    draw(g, S) {
      const { F, R, t, ch, chIdx, mem } = S;
      const chs = F.chapters; if (!chs.length) return noData(g, R, '章节');
      const cx = R.x + R.w * 0.36, cy = R.y + R.h * 0.5, rr = Math.min(R.h * 0.42, 270);
      const norm = v => { const m = Math.max(...v, 1e-9); return Array.from(v, x => x / m); };
      const first = norm(chs[0].m?.chroma || new Array(12).fill(0));
      const midI = Math.floor((chs.length - 1) / 2), mid = norm(chs[midI].m?.chroma || new Array(12).fill(0));
      const curRaw = norm(F.chromaRange(ch.start, Math.max(ch.start + 0.5, t)));
      mem.cur ||= curRaw.slice();
      for (let i = 0; i < 12; i++) mem.cur[i] = lerp(mem.cur[i], curRaw[i], 0.1);
      for (const k of [0.25, 0.5, 0.75, 1]) {
        g.beginPath();
        for (let i = 0; i <= 12; i++) { const a = -Math.PI / 2 + i / 12 * TAU; const x = cx + Math.cos(a) * rr * k, y = cy + Math.sin(a) * rr * k; i ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.strokeStyle = 'rgba(232,192,106,0.1)'; g.stroke();
      }
      for (let i = 0; i < 12; i++) {
        const a = -Math.PI / 2 + i / 12 * TAU;
        line(g, cx, cy, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 'rgba(232,192,106,0.08)', 1);
        text(g, F.noteName(i), cx + Math.cos(a) * (rr + 30), cy + Math.sin(a) * (rr + 30) + 8, { align: 'center', size: 22, font: FONT.display, color: PAL.ink });
      }
      const poly = (v, stroke, fill, w = 2, dash) => {
        g.beginPath();
        for (let i = 0; i <= 12; i++) { const a = -Math.PI / 2 + (i % 12) / 12 * TAU; const r = rr * (0.08 + 0.92 * v[i % 12]); const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; i ? g.lineTo(x, y) : g.moveTo(x, y); }
        if (fill) { g.fillStyle = fill; g.fill(); }
        g.save(); g.strokeStyle = stroke; g.lineWidth = w; if (dash) g.setLineDash(dash); g.stroke(); g.restore();
      };
      poly(first, PAL.gold, rgba(PAL.gold, 0.12), 2);
      if (midI !== 0 && midI !== chIdx) poly(mid, rgba(PAL.blue, 0.8), null, 1.5, [6, 5]);
      g.save(); g.shadowColor = PAL.red; g.shadowBlur = 18; poly(mem.cur, PAL.red, rgba(PAL.red, 0.1), 2.6); g.restore();
      const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < 12; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y + 1e-12); };
      const sim = cos(mem.cur, first);
      const rx = R.x + R.w * 0.74;
      text(g, sim.toFixed(2), rx, R.y + R.h * 0.34, { size: 96, font: FONT.display, color: PAL.goldHi, glow: rgba(PAL.gold, 0.3) });
      text(g, '与序章的相似度', rx, R.y + R.h * 0.34 + 36, { size: 19, font: FONT.cn, color: PAL.gray });
      // centroid
      const col = mem.col = F.column('stft', t, mem.col), hz = F.stftHz;
      let num = 0, den = 0; for (let r = 0; r < col.length; r++) { const p = Math.pow(10, (col[r] * 90 - 90) / 10); num += p * hz[r]; den += p; }
      const cen = den ? num / den : 0;
      mem.cen = mem.cen == null ? cen : lerp(mem.cen, cen, 0.08);
      text(g, `${Math.round(mem.cen).toLocaleString()} Hz`, rx, R.y + R.h * 0.62, { size: 44, font: FONT.num, weight: 600, color: PAL.cream });
      text(g, '频谱重心（越高越明亮）', rx, R.y + R.h * 0.62 + 32, { size: 18, font: FONT.cn, color: PAL.gray });
      const ly = R.y + R.h * 0.8;
      [[PAL.gold, `${chs[0].roman} ${chs[0].name}`], [PAL.blue, `${chs[midI].roman} ${chs[midI].name}`], [PAL.red, `${ch.roman} ${ch.name}（此刻）`]].forEach(([c, s], i) => {
        line(g, rx, ly + i * 30 - 6, rx + 26, ly + i * 30 - 6, c, 3);
        text(g, s, rx + 38, ly + i * 30, { size: 17, font: FONT.cn, color: PAL.ink });
      });
    },
  },
};
