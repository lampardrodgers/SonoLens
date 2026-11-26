// TimeChart: canvas chart aligned to the global timeline, composed of layers.
// StaticChart: generic resizable canvas with draw() + hit() callbacks for non-time charts.
import { TL } from './timeline.js';
import { h, cssVar, fmtTime, niceTicks, timeTicks, bisect, rgba, inkOn, midiName, clamp } from './util.js';
import { heatmapCanvas, loadBin, heatmapValue } from './data.js';

const timeCharts = new Set();
const staticCharts = new Set();
const BLACK = new Set([1, 3, 6, 8, 10]);

export function showTip(html, x, y) {
  const tip = document.getElementById('tooltip');
  if (!html) { tip.hidden = true; return; }
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 64) top = y - r.height - 14;
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}
export const hideTip = () => { document.getElementById('tooltip').hidden = true; };

function setupCanvas(cv, w, hgt) {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(hgt * dpr));
  cv.style.width = w + 'px'; cv.style.height = hgt + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function roundRect(ctx, x, y, w, hh, r) {
  r = Math.max(0, Math.min(r, w / 2, hh / 2));
  ctx.beginPath();
  if (!(w > 0 && hh > 0)) return;
  if (ctx.roundRect) ctx.roundRect(x, y, w, hh, r); else ctx.rect(x, y, w, hh);
}

// --------------------------------------------------------------------------------------------
export class TimeChart {
  constructor(parent, opts) {
    const m = { l: 62, r: 10, t: 6, b: 20, ...(opts.m || {}) };
    this.o = { height: 160, layers: [], y: null, timeAxis: true, ...opts, m };
    if (!this.o.timeAxis) this.o.m.b = Math.min(this.o.m.b, 4);
    this.el = h('div', { class: 'tchart', style: { height: this.o.height + 'px' } });
    this.cv = h('canvas');
    this.ov = h('canvas', { class: 'over' });
    this.el.append(this.cv, this.ov);
    parent.append(this.el);
    this.hover = null;
    this.visible = false;
    this.dirty = true;
    this._raf = 0;
    this.ready = this.prepare();

    new ResizeObserver(() => this.resize()).observe(this.el);
    new IntersectionObserver(es => {
      this.visible = es[0].isIntersecting;
      if (this.visible && this.dirty) this.requestDraw();
    }, { rootMargin: '300px' }).observe(this.el);
    this.bind();
    timeCharts.add(this);
  }

  get layers() { return this.o.layers; }

  async prepare() {
    await Promise.all(this.o.layers.map(async L => {
      if (L.type === 'heatmap' && L.hm) {
        L.img = await heatmapCanvas(L.hm, L.cmap ? { cmap: L.cmap } : {});
        L.data = await loadBin(L.hm);
      }
      if (L.type === 'waveform' && L.wave) L.env = await loadBin(L.wave);
    }));
    this.requestDraw();
  }
  async refreshImages() {
    for (const L of this.o.layers) if (L.type === 'heatmap' && L.hm) L.img = await heatmapCanvas(L.hm, L.cmap ? { cmap: L.cmap } : {});
    this.requestDraw();
  }

  resize() {
    this.W = this.el.clientWidth; this.H = this.o.height;
    if (!this.W) return;
    this.ctx = setupCanvas(this.cv, this.W, this.H);
    this.octx = setupCanvas(this.ov, this.W, this.H);
    this.dirty = true;
    if (this.visible) this.draw();
  }
  requestDraw() {
    if (!this.visible) { this.dirty = true; return; }
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }
  get P() { const m = this.o.m; return { x: m.l, y: m.t, w: this.W - m.l - m.r, h: this.H - m.t - m.b }; }
  tx(t) { const P = this.P; return P.x + (t - TL.t0) / (TL.t1 - TL.t0) * P.w; }
  xt(x) { const P = this.P; return TL.t0 + (x - P.x) / P.w * (TL.t1 - TL.t0); }
  rectOf(L) {
    const P = this.P;
    const [a, b] = L.rect || [0, 1];
    return { x: P.x, y: P.y + a * P.h, w: P.w, h: (b - a) * P.h };
  }
  yScale(L) {
    const y = L.y || this.o.y || { min: 0, max: 1 };
    const R = this.rectOf(L);
    if (y.log) {
      const a = Math.log(y.min), b = Math.log(y.max);
      return v => R.y + R.h * (1 - (Math.log(Math.max(v, y.min)) - a) / (b - a));
    }
    return v => R.y + R.h * (1 - (v - y.min) / (y.max - y.min));
  }

  draw() {
    if (!this.ctx || !this.W) return;
    this.dirty = false;
    const ctx = this.ctx, P = this.P;
    ctx.clearRect(0, 0, this.W, this.H);
    this.drawGrid(ctx, P);
    ctx.save();
    ctx.beginPath(); ctx.rect(P.x, P.y, P.w, P.h); ctx.clip();
    for (const L of this.o.layers) {
      if (L.hidden) continue;
      const fn = DRAW[L.type];
      if (fn) { ctx.save(); try { fn.call(this, ctx, L); } catch (e) { console.error('layer', L.type, e); } ctx.restore(); }
    }
    ctx.restore();
    this.drawAxes(ctx, P);
    this.drawOverlay();
  }

  drawGrid(ctx, P) {
    const y = this.o.y;
    ctx.fillStyle = cssVar('--surface');
    ctx.fillRect(P.x, P.y, P.w, P.h);
    if (this.o.yAxis === 'notes' && y) {
      const ys = this.yScale({});
      for (let m = Math.ceil(y.min); m <= y.max; m++) {
        if (BLACK.has(((m % 12) + 12) % 12)) {
          ctx.fillStyle = cssVar('--surface-2');
          ctx.fillRect(P.x, ys(m + 0.5), P.w, ys(m - 0.5) - ys(m + 0.5));
        }
        if (m % 12 === 0) { ctx.fillStyle = cssVar('--grid'); ctx.fillRect(P.x, Math.round(ys(m - 0.5)), P.w, 1); }
      }
    } else if (y && !this.o.yAxis && !this.o.noGrid) {
      ctx.strokeStyle = cssVar('--grid'); ctx.lineWidth = 1;
      const ys = this.yScale({});
      for (const v of (y.ticks || niceTicks(y.min, y.max, Math.max(2, Math.floor(P.h / 34))))) {
        const yy = Math.round(ys(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(P.x, yy); ctx.lineTo(P.x + P.w, yy); ctx.stroke();
      }
    }
    if (this.o.timeAxis !== false && !this.o.noVGrid) {
      ctx.strokeStyle = cssVar('--grid'); ctx.lineWidth = 1;
      const { ticks } = timeTicks(TL.t0, TL.t1, P.w);
      if (!this.o.layers.some(l => l.type === 'heatmap' && !l.rect)) {
        for (const t of ticks) { const x = Math.round(this.tx(t)) + 0.5; ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke(); }
      }
    }
  }

  drawAxes(ctx, P) {
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const y = this.o.y;
    if (this.o.lanes) {
      const n = this.o.lanes.length;
      this.o.lanes.forEach((ln, i) => {
        const cy = P.y + P.h * (i + 0.5) / n;
        if (ln.color) { ctx.fillStyle = ln.color; roundRect(ctx, 6, cy - 4, 8, 8, 2); ctx.fill(); }
        ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'left';
        ctx.fillText(fitText(ctx, ln.label, P.x - 22), 18, cy);
        if (i > 0) { ctx.fillStyle = cssVar('--grid'); ctx.fillRect(P.x, Math.round(P.y + P.h * i / n), P.w, 1); }
      });
    } else if (this.o.yAxis === 'heatmap') {
      const L = this.o.layers.find(l => l.type === 'heatmap');
      if (L) {
        const R = this.rectOf(L);
        for (const [row, lab] of (L.hm.axis.ticks || [])) {
          const yy = R.y + R.h * (1 - (row + 0.5) / L.hm.rows);
          ctx.fillText(lab, P.x - 6, yy);
          ctx.fillStyle = cssVar('--axis'); ctx.fillRect(P.x - 4, Math.round(yy), 4, 1); ctx.fillStyle = cssVar('--muted');
        }
      }
    } else if (this.o.yAxis === 'notes' && y) {
      const ys = this.yScale({});
      for (let m = Math.ceil(y.min); m <= y.max; m++) if (m % 12 === 0) ctx.fillText(midiName(m), P.x - 6, ys(m));
    } else if (y) {
      const ys = this.yScale({});
      const f = y.fmt || (v => +v.toFixed(2));
      for (const v of (y.ticks || niceTicks(y.min, y.max, Math.max(2, Math.floor(P.h / 34))))) ctx.fillText(f(v), P.x - 6, ys(v));
    }
    if (this.o.yLabel) {
      ctx.save(); ctx.translate(11, P.y + P.h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
      ctx.fillStyle = cssVar('--muted'); ctx.fillText(this.o.yLabel, 0, 0); ctx.restore();
    }
    if (this.o.timeAxis !== false) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = cssVar('--muted');
      const { ticks, step } = timeTicks(TL.t0, TL.t1, P.w);
      for (const t of ticks) ctx.fillText(fmtTime(t, step < 1 ? 2 : 0), this.tx(t), P.y + P.h + 5);
      ctx.fillStyle = cssVar('--axis'); ctx.fillRect(P.x, P.y + P.h, P.w, 1);
    }
  }

  drawOverlay() {
    const ctx = this.octx; if (!ctx) return;
    const P = this.P;
    ctx.clearRect(0, 0, this.W, this.H);
    if (this.o.overlay) this.o.overlay.call(this, ctx, P);
    const ph = TL.playhead;
    if (ph >= TL.t0 && ph <= TL.t1) {
      const x = Math.round(this.tx(ph)) + 0.5;
      ctx.strokeStyle = cssVar('--playhead'); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
    }
    if (this.hover) {
      const x = Math.round(this.hover.x) + 0.5;
      ctx.strokeStyle = rgba(cssVar('--ink').startsWith('#') ? cssVar('--ink') : '#ffffff', 0.35);
      ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
      if (this.o.crossY) { ctx.beginPath(); ctx.moveTo(P.x, this.hover.y + 0.5); ctx.lineTo(P.x + P.w, this.hover.y + 0.5); ctx.stroke(); }
      ctx.setLineDash([]);
    }
  }

  tooltipHtml(t, y) {
    if (this.o.tooltip) return this.o.tooltip.call(this, t, y);
    const parts = [`<b>${fmtTime(t, 2)}</b>`];
    for (const L of this.o.layers) {
      if (L.hidden || !L.name && L.type !== 'heatmap' && L.type !== 'segments') continue;
      const fn = VALUE[L.type];
      const v = fn ? fn.call(this, L, t, y) : null;
      if (v != null) parts.push(v);
    }
    return parts.join('<br>');
  }

  bind() {
    const ov = this.ov;
    let drag = null;
    ov.addEventListener('mousemove', e => {
      const r = ov.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (drag) {
        const dx = x - drag.x;
        if (Math.abs(dx) > 3) drag.moved = true;
        if (drag.moved) {
          const span = drag.t1 - drag.t0;
          const dt = -dx / this.P.w * span;
          TL.setView(drag.t0 + dt, drag.t1 + dt);
        }
      }
      const P = this.P;
      if (x < P.x || x > P.x + P.w || y < P.y || y > P.y + P.h) { this.hover = null; hideTip(); this.drawOverlay(); return; }
      this.hover = { x, y };
      this.drawOverlay();
      showTip(this.tooltipHtml(this.xt(x), y), e.clientX, e.clientY);
    });
    ov.addEventListener('mouseleave', () => { this.hover = null; hideTip(); this.drawOverlay(); });
    ov.addEventListener('mousedown', e => {
      const r = ov.getBoundingClientRect();
      drag = { x: e.clientX - r.left, t0: TL.t0, t1: TL.t1, moved: false };
      const up = ev => {
        window.removeEventListener('mouseup', up);
        if (drag && !drag.moved) {
          const x = ev.clientX - r.left, y = ev.clientY - r.top;
          if (x >= this.P.x) {
            const t = this.xt(x);
            if (this.o.onClick) this.o.onClick.call(this, t, y); else TL.seek(t);
          }
        }
        drag = null;
      };
      window.addEventListener('mouseup', up);
    });
    ov.addEventListener('dblclick', () => TL.fit());
    ov.addEventListener('wheel', e => {
      const r = ov.getBoundingClientRect();
      const span = TL.t1 - TL.t0;
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        TL.zoom(Math.exp(e.deltaY * 0.01), this.xt(e.clientX - r.left));
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        e.preventDefault();
        TL.pan((e.deltaX || e.deltaY) / this.P.w * span);
      }
    }, { passive: false });
  }
}

function fitText(ctx, s, w) {
  if (ctx.measureText(s).width <= w) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s + '…';
}

// visible index range for a series
function range(s, t0, t1) {
  if (s.t) return [Math.max(0, bisect(s.t, t0) - 1), Math.min(s.t.length, bisect(s.t, t1) + 1)];
  return [Math.max(0, Math.floor((t0 - s.t0) / s.dt) - 1), Math.min(s.v.length, Math.ceil((t1 - s.t0) / s.dt) + 2)];
}
const tAt = (s, i) => s.t ? s.t[i] : s.t0 + i * s.dt;

// ---------------- layer renderers -----------------------------------------------------------
const DRAW = {
  heatmap(ctx, L) {
    if (!L.img) return;
    const hm = L.hm, R = this.rectOf(L);
    const a = Math.max(TL.t0, hm.t0), b = Math.min(TL.t1, hm.t1);
    if (b <= a) return;
    const sx = (a - hm.t0) / (hm.t1 - hm.t0) * hm.cols;
    const sw = Math.max(0.5, (b - a) / (hm.t1 - hm.t0) * hm.cols);
    const dx = this.tx(a), dw = this.tx(b) - dx;
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = L.alpha ?? 1;
    ctx.drawImage(L.img, sx, 0, sw, hm.rows, dx, R.y, dw, R.h);
  },

  line(ctx, L) {
    const s = L.series; if (!s || !s.v) return;
    const ys = this.yScale(L), R = this.rectOf(L);
    const [i0, i1] = range(s, TL.t0, TL.t1);
    ctx.strokeStyle = L.color; ctx.lineWidth = L.width || 1.5; ctx.lineJoin = 'round';
    if (L.dash) ctx.setLineDash(L.dash);
    const pts = [];
    const perPx = (i1 - i0) / this.P.w;
    if (perPx > 3) { // min/max decimation per pixel column
      let col = null, mn = 0, mx = 0, first = 0, last = 0;
      const flush = () => { if (col != null) { pts.push([col, first], [col, mn], [col, mx], [col, last]); } };
      for (let i = i0; i < i1; i++) {
        const v = s.v[i];
        if (v == null) { flush(); col = null; pts.push(null); continue; }
        const x = Math.round(this.tx(tAt(s, i))), y = ys(v);
        if (x !== col) { flush(); col = x; mn = mx = first = last = y; }
        else { mn = Math.min(mn, y); mx = Math.max(mx, y); last = y; }
      }
      flush();
    } else {
      for (let i = i0; i < i1; i++) { const v = s.v[i]; pts.push(v == null ? null : [this.tx(tAt(s, i)), ys(v)]); }
    }
    if (L.fill != null) {
      const yb = ys(L.fill);
      ctx.fillStyle = rgba(L.color, L.fillAlpha ?? 0.16);
      let open = false, startX = 0, lastX = 0;
      ctx.beginPath();
      for (const p of pts) {
        if (!p) { if (open) { ctx.lineTo(lastX, yb); ctx.lineTo(startX, yb); ctx.closePath(); open = false; } continue; }
        if (!open) { ctx.moveTo(p[0], yb); ctx.lineTo(p[0], p[1]); startX = p[0]; open = true; } else ctx.lineTo(p[0], p[1]);
        lastX = p[0];
      }
      if (open) { ctx.lineTo(lastX, yb); ctx.lineTo(startX, yb); ctx.closePath(); }
      ctx.fill();
    }
    ctx.beginPath();
    let pen = false;
    for (const p of pts) {
      if (!p) { pen = false; continue; }
      if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; } else ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
    void R;
  },

  hlines(ctx, L) {
    const ys = this.yScale(L), P = this.P;
    ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'right';
    for (const ln of L.values) {
      const y = Math.round(ys(ln.v)) + 0.5;
      ctx.strokeStyle = ln.color || cssVar('--axis'); ctx.lineWidth = 1; ctx.setLineDash(ln.dash || [4, 4]);
      ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke();
      if (ln.label) { ctx.fillStyle = cssVar('--ink-2'); ctx.fillText(ln.label, P.x + P.w - 4, y - 2); }
    }
    ctx.setLineDash([]);
  },

  markers(ctx, L) {
    const R = this.rectOf(L);
    const times = L.times || [];
    const [i0, i1] = [Math.max(0, bisect(times, TL.t0) - 1), Math.min(times.length, bisect(times, TL.t1) + 1)];
    const spacing = this.P.w / Math.max(1, (i1 - i0));
    if (L.minPx && spacing < L.minPx) return;
    ctx.strokeStyle = L.color; ctx.globalAlpha = L.alpha ?? 0.6; ctx.lineWidth = L.width || 1;
    ctx.beginPath();
    for (let i = i0; i < i1; i++) { const x = Math.round(this.tx(times[i])) + 0.5; ctx.moveTo(x, R.y); ctx.lineTo(x, R.y + R.h); }
    ctx.stroke();
    if (L.labels && spacing > 18) {
      ctx.globalAlpha = 1; ctx.fillStyle = cssVar('--ink-2'); ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      for (let i = i0; i < i1; i++) ctx.fillText(L.labels(i), this.tx(times[i]) + 3, R.y + 2);
    }
  },

  segments(ctx, L) {
    const R = this.rectOf(L);
    ctx.font = `${L.font || 12}px system-ui, sans-serif`; ctx.textBaseline = 'middle';
    for (const s of L.items) {
      if (s.end < TL.t0 || s.start > TL.t1) continue;
      const x0 = this.tx(s.start) + 1, x1 = this.tx(s.end) - 1;
      const w = x1 - x0; if (w <= 0) continue;
      ctx.fillStyle = s.color; ctx.globalAlpha = s.alpha ?? 1;
      roundRect(ctx, x0, R.y + 1, w, R.h - 2, 4); ctx.fill();
      ctx.globalAlpha = 1;
      if (w > 14 && s.label) {
        ctx.fillStyle = s.ink || inkOn(s.color);
        const cx0 = Math.max(x0, this.P.x) + 5;
        const txt = fitText(ctx, s.label + (s.sub && w > 90 ? `  ${s.sub}` : ''), Math.min(x1, this.P.x + this.P.w) - cx0 - 3);
        if (txt.length > 1 || w > 24) { ctx.textAlign = 'left'; ctx.fillText(txt, cx0, R.y + R.h / 2); }
      }
    }
  },

  notes(ctx, L) {
    const ys = this.yScale(L);
    const notes = L.notes || [];
    ctx.fillStyle = L.color;
    for (const n of notes) {
      const [s, e, p, a] = n;
      if (e < TL.t0 || s > TL.t1) continue;
      const x0 = this.tx(s), x1 = Math.max(x0 + 1.5, this.tx(e));
      const y0 = ys(p + 0.5), y1 = ys(p - 0.5);
      ctx.globalAlpha = L.alpha ?? (0.45 + 0.55 * Math.min(1, a ?? 0.7));
      roundRect(ctx, x0, y0 + 0.5, x1 - x0, Math.max(1.5, y1 - y0 - 1), 2); ctx.fill();
    }
  },

  waveform(ctx, L) {
    const env = L.env; if (!env) return;
    const R = this.rectOf(L);
    const ch = L.wave.channels || 2;
    const n = env.length / (ch * 2);
    const ps = L.wave.per_sec;
    const lanes = L.mode === 'stereo' ? ch : 1;
    ctx.fillStyle = L.color;
    ctx.globalAlpha = L.alpha ?? 0.9;
    const x0 = Math.max(this.P.x, this.tx(0)), x1 = Math.min(this.P.x + this.P.w, this.tx(n / ps));
    const gain = L.gain || 1;
    for (let lane = 0; lane < lanes; lane++) {
      const top = R.y + R.h * lane / lanes, hh = R.h / lanes, mid = top + hh / 2;
      for (let x = Math.floor(x0); x < x1; x++) {
        const ta = this.xt(x), tb = this.xt(x + 1);
        let a = Math.floor(ta * ps), b = Math.max(a + 1, Math.floor(tb * ps));
        a = clamp(a, 0, n - 1); b = clamp(b, 1, n);
        let mn = 127, mx = -127;
        const chans = L.mode === 'stereo' ? [lane] : [...Array(ch).keys()];
        for (const c of chans) {
          const base = c * 2 * n;
          for (let i = a; i < b; i++) { const lo = env[base + i], hi = env[base + n + i]; if (lo < mn) mn = lo; if (hi > mx) mx = hi; }
        }
        if (mx < mn) continue;
        const y1 = mid - clamp(mx / 127 * gain, -1, 1) * hh / 2, y2 = mid - clamp(mn / 127 * gain, -1, 1) * hh / 2;
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
      if (L.mode === 'stereo') {
        ctx.globalAlpha = 1; ctx.fillStyle = cssVar('--muted'); ctx.font = '10px system-ui'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
        ctx.fillText(lane === 0 ? 'L' : 'R', this.P.x + 4, top + 2);
        ctx.fillStyle = L.color; ctx.globalAlpha = L.alpha ?? 0.9;
      }
    }
  },

  dots(ctx, L) {
    const R = this.rectOf(L);
    const t = L.t || [], v = L.v || [];
    ctx.fillStyle = L.color;
    const [i0, i1] = [Math.max(0, bisect(t, TL.t0) - 1), Math.min(t.length, bisect(t, TL.t1) + 1)];
    const zoomScale = clamp(40 / (TL.t1 - TL.t0), 0.6, 2.2);
    for (let i = i0; i < i1; i++) {
      const r = (2 + 3 * (v[i] ?? 0.5)) * zoomScale;
      ctx.globalAlpha = 0.45 + 0.55 * (v[i] ?? 0.5);
      ctx.beginPath(); ctx.arc(this.tx(t[i]), R.y + R.h / 2, r, 0, Math.PI * 2); ctx.fill();
    }
  },

  bargrid(ctx, L) {
    const P = this.P;
    const n = L.rows.length;
    L.rows.forEach((row, ri) => {
      const top = P.y + P.h * ri / n + 1, hh = P.h / n - 2;
      ctx.fillStyle = row.color;
      L.bars.forEach(([a, b], i) => {
        if (b < TL.t0 || a > TL.t1) return;
        const v = row.values[i];
        if (v == null) return;
        const f = clamp((v - L.lo) / (L.hi - L.lo), 0, 1);
        if (f <= 0.02) return;
        ctx.globalAlpha = 0.12 + 0.88 * f;
        const x0 = this.tx(a) + 1, x1 = this.tx(b) - 1;
        roundRect(ctx, x0, top, Math.max(1, x1 - x0), hh, 3); ctx.fill();
      });
    });
  },

  stack(ctx, L) {
    const ys = this.yScale(L);
    const ser = L.series; // [{series, color}]
    const s0 = ser[0].series;
    const [i0, i1] = range(s0, TL.t0, TL.t1);
    const step = Math.max(1, Math.floor((i1 - i0) / this.P.w));
    const acc = new Float32Array(i1 - i0);
    for (const { series: s, color } of ser) {
      ctx.fillStyle = color; ctx.globalAlpha = 0.9;
      ctx.beginPath();
      const top = [];
      for (let i = i0; i < i1; i += step) {
        const k = i - i0;
        const b = acc[k];
        acc[k] = b + (s.v[i] || 0);
        for (let j = 1; j < step && i + j < i1; j++) acc[k + j] = acc[k];
        top.push([this.tx(tAt(s, i)), ys(acc[k]), ys(b)]);
      }
      if (!top.length) continue;
      ctx.moveTo(top[0][0], top[0][1]);
      for (const p of top) ctx.lineTo(p[0], p[1]);
      for (let j = top.length - 1; j >= 0; j--) ctx.lineTo(top[j][0], top[j][2]);
      ctx.closePath(); ctx.fill();
    }
  },
};

const VALUE = {
  line(L, t) {
    const s = L.series; if (!s) return null;
    let i;
    if (s.t) { i = bisect(s.t, t); if (i > 0 && (i >= s.t.length || Math.abs(s.t[i - 1] - t) < Math.abs(s.t[i] - t))) i--; }
    else i = Math.round((t - s.t0) / s.dt);
    const v = s.v[i];
    if (v == null) return null;
    const txt = L.fmt ? L.fmt(v) : (+v).toFixed(L.dec ?? 2) + (L.unit ? ' ' + L.unit : '');
    return `<span class="sw" style="background:${L.color}"></span>${L.name}: <b>${txt}</b>`;
  },
  heatmap(L, t, y) {
    if (!L.data) return null;
    const R = this.rectOf(L);
    if (y < R.y || y > R.y + R.h) return null;
    const row = (1 - (y - R.y) / R.h) * L.hm.rows - 0.5;
    const v = heatmapValue(L.hm, L.data, t, row);
    if (v == null) return null;
    const lab = L.hm.axis.values ? L.hm.axis.values[clamp(Math.round(row), 0, L.hm.rows - 1)] : '';
    const val = L.fmtVal ? L.fmtVal(v) : `${v.toFixed(1)}${L.hm.unit ? ' ' + L.hm.unit : ''}`;
    return `${L.name || ''} ${lab}${lab && L.hm.axis.unit ? ' ' + L.hm.axis.unit : ''}: <b>${val}</b>`;
  },
  segments(L, t) {
    const s = L.items.find(s => t >= s.start && t < s.end);
    if (!s) return null;
    return `<span class="sw" style="background:${s.color}"></span>${L.name ? L.name + ': ' : ''}<b>${s.tip || s.label}</b>`;
  },
  notes(L, t, y) {
    const ys = this.yScale(L);
    const hit = (L.notes || []).find(n => t >= n[0] && t <= n[1] && Math.abs(ys(n[2]) - y) < 6);
    if (!hit) return null;
    return `<span class="sw" style="background:${L.color}"></span>${L.name}: <b>${midiName(hit[2])}</b> (${(hit[1] - hit[0]).toFixed(2)}s)`;
  },
};

// --------------------------------------------------------------------------------------------
export class StaticChart {
  constructor(parent, opts) {
    this.o = { height: 220, ...opts };
    this.el = h('div', { class: 'schart' });
    this.cv = h('canvas');
    this.el.append(this.cv);
    parent.append(this.el);
    this.hoverPt = null;
    new ResizeObserver(() => this.resize()).observe(this.el);
    if (this.o.hit) {
      this.cv.addEventListener('mousemove', e => {
        const r = this.cv.getBoundingClientRect();
        this.hoverPt = { x: e.clientX - r.left, y: e.clientY - r.top };
        const html = this.o.hit.call(this, this.hoverPt.x, this.hoverPt.y);
        if (this.o.hoverRedraw) this.draw();
        showTip(html, e.clientX, e.clientY);
      });
      this.cv.addEventListener('mouseleave', () => { this.hoverPt = null; hideTip(); if (this.o.hoverRedraw) this.draw(); });
    }
    if (this.o.click) this.cv.addEventListener('click', e => {
      const r = this.cv.getBoundingClientRect();
      this.o.click.call(this, e.clientX - r.left, e.clientY - r.top);
    });
    staticCharts.add(this);
  }
  resize() {
    this.W = this.el.clientWidth;
    this.H = typeof this.o.height === 'function' ? this.o.height(this.W) : this.o.height;
    if (!this.W) return;
    this.ctx = setupCanvas(this.cv, this.W, this.H);
    this.draw();
  }
  draw() { if (this.ctx) { this.ctx.clearRect(0, 0, this.W, this.H); this.o.draw.call(this, this.ctx, this.W, this.H); } }
}

// global hooks
TL.onView(() => { for (const c of timeCharts) c.requestDraw(); });
TL.onPlayhead(() => { for (const c of timeCharts) if (c.visible) c.drawOverlay(); for (const c of staticCharts) if (c.o.onPlayhead) c.o.onPlayhead.call(c); });
export function redrawAll(images = false) {
  for (const c of timeCharts) { if (images) c.refreshImages(); else c.requestDraw(); }
  for (const c of staticCharts) c.draw();
}
export function clearCharts() { timeCharts.clear(); staticCharts.clear(); }
export { roundRect, fitText };
