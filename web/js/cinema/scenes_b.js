// Cinema scenes, part B — extra visuals beyond the reference film, plus title card & finale map.
import {
  PAL, F as FONT, STEM_COL, STEM_CN, TONE, NOTE, clamp, lerp, easeOut, mmss, midiName,
  rgba, mixHex, text, line, circle, glowDot, roundRect, heatCanvas, lut, wrap, drawMark, measure,
} from './fx.js';
import { noData } from './scenes_a.js';

const TAU = Math.PI * 2;
const BLACK = new Set([1, 3, 6, 8, 10]);

export const scenesB = {
  // ---------------------------------------------------------------------------------------------
  notefall: {
    title: '音符瀑布',
    desc: () => '自动扒谱得到的音符从上方落下，碰到琴键时发声；颜色代表分轨乐器',
    draw(g, S) {
      const { F, R, t, mem } = S;
      const notes = F.notes; if (!notes.length) return noData(g, R, '音符转录');
      const G = F.S.global || {};
      let lo = Math.max(21, (G.range_lo ?? 36) - 1), hi = Math.min(108, (G.range_hi ?? 84) + 1);
      if (!mem.rng) { // tighten to where notes actually are
        const ps = notes.map(n => n.p).sort((a, b) => a - b);
        mem.rng = [ps[Math.floor(ps.length * 0.01)] - 2, ps[Math.floor(ps.length * 0.995)] + 2];
      }
      lo = Math.max(lo, mem.rng[0]); hi = Math.min(hi, mem.rng[1]);
      while (BLACK.has(lo % 12)) lo--; while (BLACK.has(hi % 12)) hi++;
      const whites = []; for (let m = lo; m <= hi; m++) if (!BLACK.has(m % 12)) whites.push(m);
      const x0 = R.x, x1 = R.x + R.w, kbH = 74, kbY = R.y + R.h - kbH, top = R.y + 4, look = 3.2;
      const ww = (x1 - x0) / whites.length;
      const keyX = m => {
        if (!BLACK.has(m % 12)) return [x0 + whites.indexOf(m) * ww, ww];
        const wi = whites.indexOf(m - 1); return [x0 + (wi + 1) * ww - ww * 0.32, ww * 0.64];
      };
      // lanes
      for (let i = 0; i < whites.length; i++) if (whites[i] % 12 === 0) {
        line(g, x0 + i * ww, top, x0 + i * ww, kbY, 'rgba(232,192,106,0.07)', 1);
        text(g, midiName(whites[i]), x0 + i * ww + 4, top + 16, { size: 12, font: FONT.num, color: PAL.dim });
      }
      // notes in window
      const fallH = kbY - top, yOf = tt => kbY - (tt - t) / look * fallH;
      let i = 0, lo2 = 0, hi2 = notes.length;
      while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (notes[m].s < t - 10) lo2 = m + 1; else hi2 = m; }
      const active = new Map();
      g.save(); g.beginPath(); g.rect(x0, top, x1 - x0, fallH); g.clip();
      for (i = lo2; i < notes.length && notes[i].s < t + look; i++) {
        const n = notes[i]; if (n.e < t || n.p < lo || n.p > hi) continue;
        const [kx, kw] = keyX(n.p), col = STEM_COL[n.tr] || PAL.cream;
        const ya = yOf(n.e), yb = yOf(Math.max(n.s, t));
        const on = n.s <= t;
        if (on) active.set(n.p, n.tr);
        roundRect(g, kx + 1.5, ya, kw - 3, Math.max(3, yb - ya), 3);
        g.fillStyle = rgba(col, on ? 0.95 : 0.35 + 0.5 * n.v); g.fill();
        if (on) { g.save(); g.shadowColor = col; g.shadowBlur = 16; g.fill(); g.restore(); }
      }
      g.restore();
      // impact line
      const gl = g.createLinearGradient(0, kbY - 40, 0, kbY);
      gl.addColorStop(0, rgba(PAL.gold, 0)); gl.addColorStop(1, rgba(PAL.gold, 0.12));
      g.fillStyle = gl; g.fillRect(x0, kbY - 40, x1 - x0, 40);
      line(g, x0, kbY, x1, kbY, PAL.gold, 1.5);
      // keyboard
      for (const pass of [0, 1]) for (let m = lo; m <= hi; m++) {
        const blk = BLACK.has(m % 12); if ((pass === 1) !== blk) continue;
        const [kx, kw] = keyX(m), tr = active.get(m), col = tr ? (STEM_COL[tr] || PAL.cream) : null;
        g.fillStyle = col ? (blk ? mixHex('#1b1512', col, 0.85) : mixHex('#e9dfcc', col, 0.75)) : (blk ? '#16110e' : '#d8cfbf');
        g.fillRect(kx + 0.5, kbY + 2, kw - 1, blk ? kbH * 0.6 : kbH - 2);
        if (col) glowDot(g, kx + kw / 2, kbY, 4, col, 0.9);
      }
      // legend
      const trs = [...new Set(notes.map(n => n.tr))];
      trs.forEach((tr, k) => {
        const x = x1 - 110 * (trs.length - k);
        circle(g, x, top + 12, 6, STEM_COL[tr] || PAL.cream);
        text(g, STEM_CN[tr] || tr, x + 12, top + 18, { size: 16, font: FONT.cn, color: PAL.ink });
      });
    },
  },

  // ---------------------------------------------------------------------------------------------
  stemgalaxy: {
    title: '分轨星系',
    desc: () => 'AI 乐器分离后的每个分轨是一颗行星：越大越亮，说明它此刻越响',
    draw(g, S) {
      const { F, R, t, mem, dt } = S;
      const stems = F.stems; if (!stems.length) return noData(g, R, '分轨');
      const cx = R.x + R.w * 0.38, cy = R.y + R.h * 0.5;
      mem.parts ||= [];
      const lu = F.lufs(t), sun = clamp((lu + 40) / 32, 0, 1);
      // sun
      const sg = g.createRadialGradient(cx, cy, 0, cx, cy, 120 + sun * 60);
      sg.addColorStop(0, rgba(PAL.goldHi, 0.95)); sg.addColorStop(0.18, rgba(PAL.gold, 0.6)); sg.addColorStop(0.5, rgba(PAL.red, 0.12)); sg.addColorStop(1, rgba(PAL.red, 0));
      circle(g, cx, cy, 120 + sun * 60, sg);
      text(g, lu <= -69 ? '−∞' : lu.toFixed(1), cx, cy + 10, { align: 'center', size: 30, font: FONT.num, weight: 600, color: '#1a120a' });
      text(g, 'LUFS', cx, cy + 32, { align: 'center', size: 13, font: FONT.num, color: '#3a2a16' });
      stems.forEach((s, i) => {
        const orbit = 120 + i * 50, ph = (i * 1.7) + t * (0.32 - i * 0.035);
        circle(g, cx, cy, orbit, null, 'rgba(232,192,106,0.07)', 1);
        const v = F.stemLevel(s, t), col = STEM_COL[s.name] || PAL.cream;
        const x = cx + Math.cos(ph) * orbit, y = cy + Math.sin(ph) * orbit * 0.92;
        // trail
        g.save(); g.strokeStyle = rgba(col, 0.15 + 0.5 * v); g.lineWidth = 2 + v * 4; g.lineCap = 'round';
        g.beginPath(); g.arc(cx, cy, orbit, ph - 0.25 - v * 0.6, ph); g.stroke(); g.restore();
        glowDot(g, x, y, 5 + v * 18, col, 0.25 + 0.75 * v);
        text(g, STEM_CN[s.name] || s.name, x, y - 16 - v * 22, { align: 'center', size: 16, font: FONT.cn, color: rgba(PAL.cream, 0.4 + 0.6 * v) });
        // particles
        if (Math.random() < v * v * 0.9) mem.parts.push({ x, y, vx: (x - cx) / orbit * (40 + 80 * Math.random()), vy: (y - cy) / orbit * (40 + 80 * Math.random()), life: 1, col });
      });
      mem.parts = mem.parts.filter(p => (p.life -= dt * 0.9) > 0);
      if (mem.parts.length > 600) mem.parts.splice(0, mem.parts.length - 600);
      for (const p of mem.parts) { p.x += p.vx * dt; p.y += p.vy * dt; circle(g, p.x, p.y, 1.6, rgba(p.col, p.life * 0.7)); }
      // meters
      const mx = R.x + R.w * 0.74, my = R.y + 40, mh = (R.h - 80) / stems.length;
      stems.forEach((s, i) => {
        const v = F.stemLevel(s, t), col = STEM_COL[s.name] || PAL.cream, y = my + i * mh;
        text(g, STEM_CN[s.name] || s.name, mx, y + 22, { size: 20, font: FONT.cn, color: PAL.cream });
        text(g, `${(s.energy_share ?? 0).toFixed(0)}%`, mx + 300, y + 22, { align: 'right', size: 15, font: FONT.num, color: PAL.gray });
        roundRect(g, mx, y + 34, 300, 8, 4); g.fillStyle = 'rgba(255,255,255,0.05)'; g.fill();
        roundRect(g, mx, y + 34, 300 * v, 8, 4); g.fillStyle = col; g.fill();
      });
      text(g, '百分比 = 全曲能量占比', mx, R.y + R.h - 6, { size: 14, font: FONT.cn, color: PAL.dim });
    },
  },

  // ---------------------------------------------------------------------------------------------
  radial: {
    title: '环形声纹',
    desc: () => '整首歌绕成一圈：角度是时间，半径是频率，越亮越响',
    draw(g, S) {
      const { F, R, t } = S;
      if (!F.mel) return noData(g, R, '梅尔频谱');
      const D = 820, cx = R.x + R.w * 0.4, cy = R.y + R.h * 0.5, sc = Math.min(R.h, 660) / D;
      if (!F._radial) {
        const { hm, data } = F.mel, L = lut('ember');
        const cv = document.createElement('canvas'); cv.width = cv.height = D;
        const c2 = cv.getContext('2d'), img = c2.createImageData(D, D), px = img.data;
        const r0 = 110, r1 = 400;
        for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
          const dx = x - D / 2, dy = y - D / 2, r = Math.hypot(dx, dy);
          if (r < r0 || r > r1) continue;
          let a = Math.atan2(dx, -dy); if (a < 0) a += TAU;
          const col = Math.min(hm.cols - 1, Math.floor(a / TAU * hm.cols)), row = Math.min(hm.rows - 1, Math.floor((r - r0) / (r1 - r0) * hm.rows));
          let v = data[row * hm.cols + col] / 255; v = clamp((v - 0.25) / 0.75, 0, 1); v = Math.pow(v, 1.6);
          const li = Math.round(v * 255) * 3, o = (y * D + x) * 4;
          px[o] = L[li]; px[o + 1] = L[li + 1]; px[o + 2] = L[li + 2]; px[o + 3] = 255;
        }
        c2.putImageData(img, 0, 0); F._radial = cv;
      }
      const dur = F.dur, ang = t / dur * TAU;
      g.save(); g.translate(cx, cy); g.scale(sc, sc);
      g.globalAlpha = 0.22; g.drawImage(F._radial, -D / 2, -D / 2); g.globalAlpha = 1;
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, D / 2, -Math.PI / 2, -Math.PI / 2 + ang); g.closePath(); g.clip();
      g.drawImage(F._radial, -D / 2, -D / 2);
      g.restore();
      // chapter arcs
      const ro = 418 * sc;
      F.chapters.forEach((c, i) => {
        const a0 = -Math.PI / 2 + c.start / dur * TAU + 0.01, a1 = -Math.PI / 2 + c.end / dur * TAU - 0.01;
        const cur = t >= c.start && t < c.end;
        g.save(); g.strokeStyle = cur ? (TONE[c.tone] || PAL.gold) : rgba(PAL.gold, 0.3); g.lineWidth = cur ? 6 : 3;
        g.beginPath(); g.arc(cx, cy, ro, a0, a1); g.stroke(); g.restore();
        const am = (a0 + a1) / 2;
        text(g, c.roman, cx + Math.cos(am) * (ro + 26), cy + Math.sin(am) * (ro + 26) + 7, { align: 'center', size: 19, font: FONT.display, color: cur ? PAL.goldHi : PAL.gray });
      });
      const a = -Math.PI / 2 + ang;
      g.save(); g.shadowColor = PAL.gold; g.shadowBlur = 14;
      line(g, cx + Math.cos(a) * 100 * sc, cy + Math.sin(a) * 100 * sc, cx + Math.cos(a) * (ro + 8), cy + Math.sin(a) * (ro + 8), PAL.goldHi, 2);
      g.restore();
      text(g, mmss(t), cx, cy + 12, { align: 'center', size: 38, font: FONT.num, weight: 500, color: PAL.cream });
      text(g, `/ ${mmss(dur)}`, cx, cy + 40, { align: 'center', size: 16, font: FONT.num, color: PAL.gray });
      const lx = R.x + R.w * 0.8;
      text(g, '内圈 · 低频', lx, R.y + R.h * 0.4, { size: 18, font: FONT.cn, color: PAL.gray });
      text(g, '外圈 · 高频', lx, R.y + R.h * 0.4 + 32, { size: 18, font: FONT.cn, color: PAL.gray });
      text(g, '12 点钟方向 = 0:00', lx, R.y + R.h * 0.4 + 64, { size: 18, font: FONT.cn, color: PAL.gray });
    },
  },

  // ---------------------------------------------------------------------------------------------
  tonnetz: {
    title: '音网 Tonnetz',
    desc: () => '横向是纯五度，斜向是大三度；亮起的三角形就是正在响的三和弦',
    draw(g, S) {
      const { F, R, t, mem } = S;
      if (!F.chromaPS) return noData(g, R, '色度');
      const cx = R.x + R.w * 0.44, cy = R.y + R.h * 0.5, dx = 112, dy = dx * 0.866;
      const cur = F.chromaRange(t - 0.4, t + 0.05), m = Math.max(...cur, 1e-6);
      const P = (i, j) => [cx + i * dx + j * dx / 2, cy - j * dy];
      const pcOf = (i, j) => (((7 * i + 4 * j) % 12) + 12) % 12;
      mem.tri ||= new Map();
      const ci = F.chordIdx(t), c = ci >= 0 ? F.chords[ci] : null;
      const minor = c && c.quality && (c.quality.startsWith('min') || c.quality.startsWith('dim'));
      const key = c && c.root != null ? `${minor ? 'm' : 'M'}${c.root}` : null;
      for (const [k, v] of mem.tri) { const nv = v * Math.pow(0.25, S.dt); nv < 0.02 ? mem.tri.delete(k) : mem.tri.set(k, nv); }
      if (key) mem.tri.set(key, 1);
      const I = [-4, 4], J = [-2, 2];
      // triangles
      for (let j = J[0]; j < J[1]; j++) for (let i = I[0]; i < I[1]; i++) {
        const p = pcOf(i, j);
        // up triangle (p, p+7, p+4) = major on p
        const tris = [[[i, j], [i + 1, j], [i, j + 1], `M${p}`], [[i + 1, j], [i + 1, j + 1], [i, j + 1], `m${(p + 4) % 12}`]];
        for (const [a, b, cc, k] of tris) {
          const v = mem.tri.get(k) || 0;
          const A = P(...a), B = P(...b), C = P(...cc);
          if (Math.max(A[0], B[0], C[0]) > R.x + R.w * 0.86 || Math.min(A[0], B[0], C[0]) < R.x) continue;
          g.beginPath(); g.moveTo(...A); g.lineTo(...B); g.lineTo(...C); g.closePath();
          const col = k[0] === 'M' ? PAL.gold : PAL.red;
          g.fillStyle = v > 0 ? rgba(col, 0.08 + 0.55 * v) : 'rgba(255,255,255,0.012)'; g.fill();
          g.strokeStyle = 'rgba(232,192,106,0.1)'; g.lineWidth = 1; g.stroke();
          if (v > 0.6) { const mx = (A[0] + B[0] + C[0]) / 3, my = (A[1] + B[1] + C[1]) / 3; text(g, F.noteName(+k.slice(1)) + (k[0] === 'm' ? 'm' : ''), mx, my + 6, { align: 'center', size: 17, font: FONT.display, color: '#140e0a', weight: 600 }); }
        }
      }
      // nodes
      for (let j = J[0]; j <= J[1]; j++) for (let i = I[0]; i <= I[1]; i++) {
        const [x, y] = P(i, j); if (x > R.x + R.w * 0.86 || x < R.x) continue;
        const pc = pcOf(i, j), v = cur[pc] / m;
        circle(g, x, y, 18, v > 0.55 ? rgba(PAL.gold, 0.25 + 0.6 * (v - 0.55) / 0.45) : rgba(PAL.bg, 0.95), rgba(PAL.gold, 0.25 + 0.5 * v), 1.2);
        if (v > 0.85) glowDot(g, x, y, 6, PAL.goldHi, v);
        text(g, F.noteName(pc), x, y + 6, { align: 'center', size: 16, font: FONT.display, color: v > 0.55 ? '#140e0a' : PAL.ink, weight: 600 });
      }
      const lx = R.x + R.w * 0.88;
      text(g, c?.label || '–', lx, R.y + R.h * 0.42, { align: 'center', size: 54, font: FONT.display, color: PAL.goldHi, glow: rgba(PAL.gold, 0.4) });
      text(g, '当前和弦', lx, R.y + R.h * 0.42 + 34, { align: 'center', size: 16, font: FONT.cn, color: PAL.gray });
      text(g, '→ 纯五度', R.x + 6, R.y + R.h - 36, { size: 16, font: FONT.cn, color: PAL.gray });
      text(g, '↗ 大三度   ↘ 小三度', R.x + 6, R.y + R.h - 10, { size: 16, font: FONT.cn, color: PAL.gray });
    },
  },

  // ---------------------------------------------------------------------------------------------
  streamgraph: {
    title: '分轨能量河流',
    desc: () => '每条色带是一个分轨，宽度代表它的能量，全曲从左流向右',
    draw(g, S) {
      const { F, R, t, mem } = S;
      const stems = F.stems; if (!stems.length) return noData(g, R, '分轨');
      const x0 = R.x, x1 = R.x + R.w, cy = R.y + R.h * 0.46, amp = R.h * 0.36, N = 480;
      if (!mem.lay) {
        const lay = stems.map(s => { const a = new Float32Array(N); for (let i = 0; i < N; i++) { const tt = i / (N - 1) * F.dur; let v = 0; for (let k = -2; k <= 2; k++) v += Math.pow(F.stemLevel(s, tt + k * F.dur / N * 0.5), 2); a[i] = v / 5; } return a; });
        let mx = 1e-6; for (let i = 0; i < N; i++) { let s = 0; for (const l of lay) s += l[i]; mx = Math.max(mx, s); }
        mem.lay = lay.map(l => l.map(v => v / mx));
      }
      const xs = i => x0 + i / (N - 1) * (x1 - x0);
      const playX = x0 + t / F.dur * (x1 - x0);
      const tot = new Float32Array(N); for (const l of mem.lay) for (let i = 0; i < N; i++) tot[i] += l[i];
      let base = Array.from(tot, v => -v / 2);
      mem.lay.forEach((l, k) => {
        const col = STEM_COL[stems[k].name] || PAL.cream;
        const top = base.map((b, i) => b + l[i]);
        g.beginPath();
        for (let i = 0; i < N; i++) g.lineTo(xs(i), cy + base[i] * amp * 2);
        for (let i = N - 1; i >= 0; i--) g.lineTo(xs(i), cy + top[i] * amp * 2);
        g.closePath();
        g.save(); g.fillStyle = rgba(col, 0.16); g.fill();
        g.beginPath(); g.rect(x0, R.y, playX - x0, R.h); g.clip();
        g.beginPath();
        for (let i = 0; i < N; i++) g.lineTo(xs(i), cy + base[i] * amp * 2);
        for (let i = N - 1; i >= 0; i--) g.lineTo(xs(i), cy + top[i] * amp * 2);
        g.closePath(); g.fillStyle = rgba(col, 0.85); g.fill(); g.restore();
        // label at max thickness
        let bi = 0; for (let i = 0; i < N; i++) if (l[i] > l[bi]) bi = i;
        if (l[bi] > 0.06) text(g, STEM_CN[stems[k].name] || stems[k].name, xs(bi), cy + (base[bi] + l[bi] / 2) * amp * 2 + 6, { align: 'center', size: 17, font: FONT.cn, color: '#140e0a', weight: 600 });
        base = top;
      });
      line(g, playX, R.y + 10, playX, R.y + R.h - 60, PAL.red, 2);
      glowDot(g, playX, R.y + 10, 4, PAL.red);
      F.chapters.forEach(c => {
        const x = x0 + c.start / F.dur * (x1 - x0);
        line(g, x, R.y + R.h - 56, x, R.y + R.h - 40, PAL.gray, 1);
        text(g, c.roman, x + 6, R.y + R.h - 40, { size: 16, font: FONT.display, color: PAL.gray });
      });
      // legend
      stems.forEach((s, k) => {
        const x = x0 + k * 130;
        circle(g, x + 6, R.y + R.h - 10, 6, STEM_COL[s.name] || PAL.cream);
        text(g, STEM_CN[s.name] || s.name, x + 18, R.y + R.h - 4, { size: 16, font: FONT.cn, color: PAL.ink });
      });
    },
  },

  // ---------------------------------------------------------------------------------------------
  drumgrid: {
    title: '鼓组步进网格',
    desc: () => '每小节分成 16 步，亮格是鼓击；下方依次是之前的小节',
    draw(g, S) {
      const { F, R, t } = S;
      const dr = F.A.drums; if (!dr?.hits?.length || !F.bars.length) return noData(g, R, '鼓组');
      const steps = dr.steps_per_bar || 16, ins = dr.hits;
      if (!F._dgrid) {
        F._dgrid = F.bars.map(([a, b]) => ins.map(h => {
          const row = new Float32Array(steps);
          for (let k = 0; k < h.t.length; k++) {
            const x = h.t[k]; if (x < a - 0.03 || x >= b - 0.03) continue;
            const s = clamp(Math.round((x - a) / (b - a) * steps), 0, steps - 1);
            row[s] = Math.max(row[s], h.v ? h.v[k] : 1);
          }
          return row;
        }));
      }
      const bi = F.barAt(t), cur = bi.idx, step = Math.floor(bi.phase * steps);
      const gx0 = R.x + 150, gx1 = R.x + R.w * 0.72, cw = (gx1 - gx0) / steps;
      const ch = 46, gy0 = R.y + 40;
      const insCol = [PAL.red, PAL.gold, PAL.cream, PAL.blue, PAL.teal];
      // current bar
      ins.forEach((h, r) => {
        const y = gy0 + r * (ch + 8);
        text(g, h.label?.split(' ')[0] || h.name, gx0 - 20, y + ch * 0.66, { align: 'right', size: 20, font: FONT.cn, color: PAL.cream });
        for (let s = 0; s < steps; s++) {
          const x = gx0 + s * cw, v = F._dgrid[cur]?.[r]?.[s] || 0, past = s <= step;
          roundRect(g, x + 3, y, cw - 6, ch, 5);
          g.fillStyle = s % 4 === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)'; g.fill();
          if (v > 0) {
            const col = insCol[r % insCol.length];
            g.fillStyle = rgba(col, past ? 0.35 + 0.6 * v : 0.18); g.fill();
            if (s === step) { g.save(); g.shadowColor = col; g.shadowBlur = 24; g.fill(); g.restore(); }
          }
        }
      });
      const px = gx0 + (bi.phase * steps) * cw;
      line(g, px, gy0 - 14, px, gy0 + ins.length * (ch + 8), PAL.goldHi, 2);
      for (let s = 0; s < steps; s += 4) text(g, `${s / 4 + 1}`, gx0 + s * cw + cw / 2, gy0 - 14, { align: 'center', size: 15, font: FONT.num, color: PAL.gray });
      // history
      const hy0 = gy0 + ins.length * (ch + 8) + 40, hh = 9, rows = Math.min(10, Math.floor((R.y + R.h - hy0) / (ins.length * hh + 8)));
      for (let k = 1; k <= rows; k++) {
        const b = cur - k; if (b < 0) break;
        const y = hy0 + (k - 1) * (ins.length * hh + 8), al = 1 - k / (rows + 1);
        text(g, `${b + 1}`, gx0 - 20, y + ins.length * hh - 4, { align: 'right', size: 13, font: FONT.num, color: rgba(PAL.gray, al) });
        ins.forEach((h, r) => {
          for (let s = 0; s < steps; s++) {
            const v = F._dgrid[b]?.[r]?.[s] || 0;
            g.fillStyle = v > 0 ? rgba(insCol[r % insCol.length], al * (0.3 + 0.6 * v)) : rgba('#ffffff', 0.025 * al);
            g.fillRect(gx0 + s * cw + 3, y + r * hh, cw - 6, hh - 2);
          }
        });
      }
      // step probability
      const sx = R.x + R.w * 0.77, sw = R.w * 0.22;
      text(g, '全曲步位出现率', sx, gy0 - 8, { size: 18, font: FONT.cn, color: PAL.cream });
      ins.forEach((h, r) => {
        const pr = dr.step_prob?.[h.name] || [], y = gy0 + 20 + r * 92;
        text(g, h.label?.split(' ')[0] || h.name, sx, y + 14, { size: 15, font: FONT.cn, color: PAL.gray });
        const bw = sw / steps;
        pr.forEach((p, s) => { const hgt = p * 56; g.fillStyle = rgba(insCol[r % insCol.length], 0.3 + 0.6 * p); g.fillRect(sx + s * bw + 1, y + 80 - hgt, bw - 2, hgt); });
      });
      text(g, `第 ${cur + 1} 小节 · 密度 ${dr.density_per_bar?.[cur] ?? '–'} 击`, R.x + 6, R.y + R.h - 8, { size: 17, font: FONT.cn, color: PAL.gray });
    },
  },

  // ---------------------------------------------------------------------------------------------
  ssm: {
    title: '自相似矩阵',
    desc: () => '每个点比较两个时刻的听感：亮方块代表重复出现的段落',
    draw(g, S) {
      const { F, R, t } = S;
      if (!F.ssm) return noData(g, R, '自相似矩阵');
      const hm = F.ssm.hm;
      const img = F._ssmImg ||= heatCanvas(hm, F.ssm.data, 'ember', { gamma: 1.6, floor: 0.1 });
      const sz = Math.min(R.h - 20, 640), x0 = R.x + 40, y0 = R.y + 10;
      g.save(); g.imageSmoothingEnabled = false;
      g.translate(x0, y0 + sz); g.scale(1, -1); g.drawImage(img, 0, 0, sz, sz); g.restore();
      // beat_times → position
      const bt = hm.beat_times || [];
      const pos = tt => { if (!bt.length) return tt / F.dur; let i = 0; while (i < bt.length - 1 && bt[i + 1] <= tt) i++; return i / Math.max(1, bt.length - 1); };
      const p = pos(t) * sz;
      line(g, x0 + p, y0, x0 + p, y0 + sz, rgba(PAL.goldHi, 0.8), 1.5);
      line(g, x0, y0 + p, x0 + sz, y0 + p, rgba(PAL.goldHi, 0.8), 1.5);
      glowDot(g, x0 + p, y0 + p, 6, PAL.goldHi);
      F.chapters.forEach(c => {
        const a = pos(c.start) * sz;
        line(g, x0 + a, y0 + sz + 4, x0 + a, y0 + sz + 16, PAL.gray, 1);
        text(g, c.roman, x0 + a + 4, y0 + sz + 20, { size: 14, font: FONT.display, color: PAL.gray });
      });
      const tx = x0 + sz + 70;
      const lines = ['对角线是“自己和自己”，永远最亮。', '离开对角线的亮块，说明这一段', '和另一段听起来很像——', '这就是“重复”与“再现”。'];
      lines.forEach((s, i) => text(g, s, tx, R.y + 80 + i * 36, { size: 21, font: FONT.cn, color: i === 2 ? PAL.gold : PAL.ink }));
      const segs = F.A.structure?.segments || [];
      text(g, '段落标签', tx, R.y + 280, { size: 18, font: FONT.cn, color: PAL.gray });
      segs.slice(0, 12).forEach((s, i) => {
        const x = tx + (i % 6) * 70, y = R.y + 310 + Math.floor(i / 6) * 70;
        roundRect(g, x, y, 58, 52, 6); g.fillStyle = t >= s.start && t < s.end ? rgba(PAL.gold, 0.85) : rgba(PAL.gold, 0.15); g.fill();
        text(g, s.label, x + 29, y + 34, { align: 'center', size: 24, font: FONT.display, color: t >= s.start && t < s.end ? '#140e0a' : PAL.cream });
      });
    },
  },

  // ---------------------------------------------------------------------------------------------
  waterfall: {
    title: '瀑布频谱',
    desc: () => '时间自上而下流动的频谱图，红亮处是能量集中的频率',
    draw(g, S) {
      const { F, R, t } = S;
      if (!F.stft) return noData(g, R, '频谱');
      const hm = F.stft.hm, img = F._stftImg ||= heatCanvas(hm, F.stft.data, 'ember', { gamma: 1.7, floor: 0.3 });
      const hz = F.stftHz, ra = Math.max(0, hz.findIndex(f => f >= 30)), rb = hz.findIndex(f => f >= 16000) < 0 ? hz.length : hz.findIndex(f => f >= 16000);
      const x0 = R.x + 10, x1 = R.x + R.w - 10, y0 = R.y + 10, y1 = R.y + R.h - 46, span = 10;
      const cps = hm.cols / (hm.t1 - hm.t0);
      // time runs downward (now at the top), frequency left → right
      const ta = Math.max(hm.t0, t - span), tb = t;
      const sy = hm.rows - rb, sh = rb - ra, sw = (tb - ta) * cps, Wd = x1 - x0, Hd = y1 - y0;
      g.save(); g.beginPath(); g.rect(x0, y0, Wd, Hd); g.clip();
      if (sw > 0) {
        g.transform(0, -Hd / (span * cps), -Wd / sh, 0, x0 + Wd, y0 + (tb - ta) / span * Hd);
        g.drawImage(img, ta * cps, sy, sw, sh, 0, 0, sw, sh);
      }
      g.restore();
      line(g, x0, y0, x1, y0, PAL.goldHi, 2);
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const r = hz.findIndex(h => h >= f); if (r < ra || r >= rb) continue;
        const x = x0 + (r - ra) / (rb - ra) * (x1 - x0);
        text(g, f >= 1000 ? `${f / 1000}k` : `${f}`, x, y1 + 26, { align: 'center', size: 15, font: FONT.num, color: PAL.gray });
      }
      text(g, '↓ 过去 10 秒', x1 - 4, y1 - 8, { align: 'right', size: 15, font: FONT.cn, color: PAL.gray });
    },
  },
};

// ================================================================================================
/** Title card (full frame). k = 0..1 intro progress, now = stage clock. */
export function drawTitle(g, F, W, H, now, k = 1) {
  const A = F.A, G = F.S.global || {};
  const cx = W / 2, cy = H * 0.44;
  const a = easeOut(k);
  // sunburst
  g.save(); g.translate(cx, cy); g.rotate(now * 0.02);
  for (let i = 0; i < 96; i++) {
    const ang = i / 96 * TAU, len = 260 + (i % 3) * 90 + (i % 7) * 25;
    g.strokeStyle = rgba(PAL.gold, (i % 4 === 0 ? 0.22 : 0.08) * a); g.lineWidth = 1;
    g.beginPath(); g.moveTo(Math.cos(ang) * 200, Math.sin(ang) * 200); g.lineTo(Math.cos(ang) * (200 + len * a), Math.sin(ang) * (200 + len * a)); g.stroke();
  }
  g.restore();
  circle(g, cx, cy, 188 * (0.8 + 0.2 * a), null, rgba(PAL.gold, 0.55 * a), 1.2);
  circle(g, cx, cy, 196 * (0.8 + 0.2 * a), null, rgba(PAL.gold, 0.2 * a), 1);
  const title = A.meta.title || A.meta.file_name || 'Untitled';
  const size = title.length > 18 ? 74 : title.length > 10 ? 96 : 120;
  text(g, title, cx, cy + size * 0.33, { align: 'center', size, font: FONT.display, color: PAL.cream, alpha: a, glow: rgba(PAL.gold, 0.35), blur: 30 });
  text(g, 'A  VISUAL  ANALYSIS', cx, cy - 120, { align: 'center', size: 18, font: FONT.display, color: PAL.gold, alpha: a, ls: 8 });
  const info = [A.meta.artist && `作曲 / 演唱  ${A.meta.artist}`, `时长  ${mmss(F.dur)}`, `${G.n_chapters || F.chapters.length} 个段落`, G.key_cn, G.bpm && `${Math.round(G.bpm)} BPM`].filter(Boolean).join('   ·   ');
  text(g, info, cx, cy + 290, { align: 'center', size: 24, font: FONT.cn, color: PAL.ink, alpha: a });
  line(g, cx - 160 * a, cy + 330, cx + 160 * a, cy + 330, rgba(PAL.gold, 0.5), 1);
  text(g, '所有数据均由音频信号分析得出', cx, cy + 372, { align: 'center', size: 19, font: FONT.cn, color: PAL.gray, alpha: a, ls: 3 });
  // brand signature
  const bw = measure(g, '声镜', { size: 22, font: FONT.cn }) + 14 + measure(g, 'SONOLENS', { size: 15, font: FONT.display });
  const bx = cx - (bw + 40) / 2, by = H - 58;
  drawMark(g, bx + 14, by - 7, 30, PAL.gold, a * 0.9);
  text(g, '声镜', bx + 40, by, { size: 22, font: FONT.cn, color: PAL.cream, alpha: a * 0.85, ls: 4 });
  text(g, 'SONOLENS', bx + 40 + measure(g, '声镜', { size: 22, font: FONT.cn }) + 22, by - 1, { size: 15, font: FONT.display, color: PAL.gold, alpha: a * 0.85, ls: 3 });
}

/** Finale: whole-song map with loudness, SSM and stat cards. */
export function drawFinale(g, F, W, H, now, k = 1) {
  const A = F.A, G = F.S.global || {}, a = easeOut(k);
  g.save(); g.globalAlpha = a;
  text(g, '全曲地图', 90, 132, { size: 64, font: FONT.cn, color: PAL.cream });
  text(g, 'THE  WHOLE  MAP', 92, 172, { size: 18, font: FONT.display, color: PAL.gold, ls: 6 });
  // loudness curve with chapter averages
  const x0 = 90, x1 = W - 90, y0 = 230, y1 = 520;
  const st = A.loudness?.short_term; const lo = -40, hi = -4;
  const yL = v => y1 - clamp((v - lo) / (hi - lo), 0, 1) * (y1 - y0);
  const xT = tt => x0 + tt / F.dur * (x1 - x0);
  for (const v of [-36, -30, -24, -18, -12, -6]) { line(g, x0, yL(v), x1, yL(v), 'rgba(232,192,106,0.06)', 1); text(g, `${v}`, x0 - 12, yL(v) + 5, { align: 'right', size: 13, font: FONT.num, color: PAL.dim }); }
  if (st?.v) {
    g.beginPath(); g.moveTo(xT(st.t0), y1);
    st.v.forEach((v, i) => g.lineTo(xT(st.t0 + i * st.dt), yL(v ?? -70)));
    g.lineTo(xT(st.t0 + st.v.length * st.dt), y1); g.closePath();
    const gr = g.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, rgba(PAL.gold, 0.35)); gr.addColorStop(1, rgba(PAL.gold, 0.02));
    g.fillStyle = gr; g.fill();
    g.beginPath(); st.v.forEach((v, i) => { const x = xT(st.t0 + i * st.dt), y = yL(v ?? -70); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.strokeStyle = PAL.gold; g.lineWidth = 1.6; g.stroke();
  }
  F.chapters.forEach(c => {
    const xa = xT(c.start), xb = xT(c.end), y = yL(c.m?.lufs ?? -30);
    line(g, xa + 3, y, xb - 3, y, PAL.cream, 2.5);
    line(g, xa, y0 - 10, xa, y1, 'rgba(232,192,106,0.12)', 1, [3, 4]);
    text(g, c.roman, (xa + xb) / 2, y0 - 16, { align: 'center', size: 22, font: FONT.display, color: TONE[c.tone] || PAL.gold });
    if (xb - xa > 90) text(g, c.name, (xa + xb) / 2, y1 + 26, { align: 'center', size: 17, font: FONT.cn, color: PAL.gray });
  });
  text(g, '白线 = 各章节平均响度 (LUFS)', x1, y1 + 56, { align: 'right', size: 15, font: FONT.cn, color: PAL.dim });
  // SSM
  if (F.ssm) {
    const img = F._ssmImg ||= heatCanvas(F.ssm.hm, F.ssm.data, 'ember', { gamma: 1.6, floor: 0.1 });
    const sz = 360, sx = 90, sy = 600;
    g.save(); g.imageSmoothingEnabled = false; g.translate(sx, sy + sz); g.scale(1, -1); g.drawImage(img, 0, 0, sz, sz); g.restore();
    g.strokeStyle = 'rgba(232,192,106,0.3)'; g.strokeRect(sx, sy, sz, sz);
    const tx = sx + sz + 36;
    text(g, '自相似矩阵', tx, sy + 30, { size: 26, font: FONT.cn, color: PAL.cream });
    ['横纵轴都是时间。', '亮块 = 两个时刻听起来相似。', '对角线外的亮块就是“重复”。', G.first_last_sim != null ? `首尾音高分布相似度 ${G.first_last_sim}` : ''].forEach((s, i) => s && text(g, s, tx, sy + 76 + i * 34, { size: 19, font: FONT.cn, color: i === 3 ? PAL.gold : PAL.ink }));
  }
  // stat cards
  const cards = [['时长', mmss(F.dur), ''], ['速度', G.bpm ? Math.round(G.bpm) : '–', 'BPM'], ['调性', G.key_cn || '–', ''], ['综合响度', G.lufs ?? '–', 'LUFS'], ['响度范围', G.lra ?? '–', 'LU'], ['音域', G.range || '–', '']];
  const cx0 = 990, cy0 = 600, cw = 270, chh = 160;
  cards.forEach(([lab, v, u], i) => {
    const x = cx0 + (i % 3) * (cw + 20), y = cy0 + Math.floor(i / 3) * (chh + 20);
    roundRect(g, x, y, cw, chh, 10); g.fillStyle = 'rgba(232,192,106,0.05)'; g.fill(); g.strokeStyle = 'rgba(232,192,106,0.2)'; g.stroke();
    text(g, lab, x + 22, y + 38, { size: 18, font: FONT.cn, color: PAL.gray });
    const vs = String(v);
    text(g, vs, x + 22, y + 108, { size: vs.length > 7 ? 34 : 50, font: /[一-龥]/.test(vs) ? FONT.cn : FONT.num, weight: 500, color: PAL.goldHi, maxW: cw - 44 });
    if (u) text(g, u, x + 22, y + 140, { size: 15, font: FONT.num, color: PAL.gray, ls: 2 });
  });
  g.restore();
}
