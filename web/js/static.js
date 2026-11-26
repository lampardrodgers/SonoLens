// Non-time charts built on StaticChart: bars, XY lines (lin/log), radar, square images.
import { StaticChart, roundRect } from './chart.js';
import { cssVar, niceTicks, fmtHz, rgba, clamp } from './util.js';

const font = (s = 11) => `${s}px system-ui, -apple-system, sans-serif`;

/** Vertical bar chart. opts: labels, values, color | colors[], fmt, height, highlight, yMin, yMax, refs:[{v,label}], tip(i) */
export function barChart(parent, o) {
  const m = { l: o.ml ?? 44, r: 8, t: 10, b: o.mb ?? 34 };
  let hoverI = -1;
  return new StaticChart(parent, {
    height: o.height || 200, hoverRedraw: true,
    draw(ctx, W, H) {
      const n = o.values.length;
      const vals = o.values.map(v => v ?? 0);
      const yMin = o.yMin ?? Math.min(0, ...vals), yMax = o.yMax ?? Math.max(...vals, 1e-9) * 1.08;
      const P = { x: m.l, y: m.t, w: W - m.l - m.r, h: H - m.t - m.b };
      const ys = v => P.y + P.h * (1 - (v - yMin) / (yMax - yMin));
      ctx.font = font(); ctx.fillStyle = cssVar('--muted'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (const t of niceTicks(yMin, yMax, 4)) {
        ctx.fillStyle = cssVar('--grid'); ctx.fillRect(P.x, Math.round(ys(t)), P.w, 1);
        ctx.fillStyle = cssVar('--muted'); ctx.fillText((o.yFmt || (v => +v.toFixed(2)))(t), P.x - 6, ys(t));
      }
      const bw = P.w / n;
      const gap = Math.max(2, Math.min(bw * 0.25, 10));
      this._geo = { P, bw };
      for (let i = 0; i < n; i++) {
        const v = vals[i];
        const x = P.x + i * bw + gap / 2, w = bw - gap;
        const y0 = ys(Math.max(0, yMin)), y1 = ys(v);
        const col = o.colors ? o.colors[i] : o.color || cssVar('--s1');
        ctx.fillStyle = col;
        ctx.globalAlpha = o.highlight != null && o.highlight !== i ? 0.45 : 1;
        if (hoverI === i) ctx.globalAlpha = 1;
        roundRect(ctx, x, Math.min(y0, y1), w, Math.max(1, Math.abs(y0 - y1)), Math.min(4, w / 2)); ctx.fill();
        ctx.globalAlpha = 1;
      }
      // labels
      ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const every = Math.ceil(n / Math.max(1, P.w / (o.labelW || 34)));
      for (let i = 0; i < n; i += every) {
        const lab = o.labels[i];
        if (o.rotate) {
          ctx.save(); ctx.translate(P.x + (i + 0.5) * bw, P.y + P.h + 4); ctx.rotate(-Math.PI / 4); ctx.textAlign = 'right';
          ctx.fillText(lab, 0, 0); ctx.restore();
        } else ctx.fillText(lab, P.x + (i + 0.5) * bw, P.y + P.h + 5);
      }
      if (o.refs) for (const r of o.refs) {
        const y = Math.round(ys(r.v)) + 0.5;
        ctx.strokeStyle = r.color || cssVar('--ink-2'); ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke(); ctx.setLineDash([]);
        if (r.label) { ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(r.label, P.x + P.w, y - 2); }
      }
      if (o.lines) for (const L of o.lines) {   // overlay polyline across bar centres (same scale)
        ctx.strokeStyle = L.color; ctx.lineWidth = 2; ctx.beginPath();
        L.values.forEach((v, i) => { const x = P.x + (i + 0.5) * bw; i ? ctx.lineTo(x, ys(v)) : ctx.moveTo(x, ys(v)); }); ctx.stroke();
        ctx.fillStyle = L.color;
        L.values.forEach((v, i) => { ctx.beginPath(); ctx.arc(P.x + (i + 0.5) * bw, ys(v), 3, 0, 7); ctx.fill(); });
      }
    },
    hit(x) {
      if (!this._geo) return null;
      const { P, bw } = this._geo;
      const i = Math.floor((x - P.x) / bw);
      const prev = hoverI;
      hoverI = i >= 0 && i < o.values.length ? i : -1;
      if (prev !== hoverI) this.draw();
      if (hoverI < 0) return null;
      return o.tip ? o.tip(hoverI) : `${o.labels[hoverI]}: <b>${(o.fmt || (v => (+v).toFixed(2)))(o.values[hoverI])}</b>`;
    },
  });
}

/** Horizontal bar list (sorted ranking). opts: items [{label, value, color, sub}] */
export function hbarChart(parent, o) {
  const rowH = o.rowH || 22;
  let hoverI = -1;
  return new StaticChart(parent, {
    height: Math.max(40, o.items.length * rowH + 8), hoverRedraw: true,
    draw(ctx, W) {
      const lw = o.labelW || 90;
      const max = o.max ?? Math.max(...o.items.map(i => i.value), 1e-9);
      ctx.font = font(12); ctx.textBaseline = 'middle';
      o.items.forEach((it, i) => {
        const y = 4 + i * rowH;
        ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'right';
        ctx.fillText(it.label, lw - 8, y + rowH / 2);
        const w = Math.max(2, (W - lw - 60) * it.value / max);
        ctx.fillStyle = it.color || cssVar('--s1'); ctx.globalAlpha = hoverI === i || hoverI < 0 ? 1 : 0.6;
        roundRect(ctx, lw, y + 4, w, rowH - 8, 4); ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillStyle = cssVar('--ink'); ctx.textAlign = 'left';
        ctx.fillText((o.fmt || (v => v.toFixed(1)))(it.value), lw + w + 6, y + rowH / 2);
      });
    },
    hit(x, y) {
      const i = Math.floor((y - 4) / rowH);
      const prev = hoverI; hoverI = i >= 0 && i < o.items.length ? i : -1;
      if (prev !== hoverI) this.draw();
      if (hoverI < 0) return null;
      const it = o.items[hoverI];
      return it.tip || `${it.label}: <b>${(o.fmt || (v => v.toFixed(1)))(it.value)}</b>`;
    },
  });
}

/** XY line chart. opts: series [{x[], y[], color, name, dash, width, fill}], xLog, xMin, xMax, yMin, yMax, xFmt, yFmt, vlines */
export function xyChart(parent, o) {
  const m = { l: o.ml ?? 48, r: 12, t: 10, b: 24 };
  let hx = null;
  return new StaticChart(parent, {
    height: o.height || 220,
    draw(ctx, W, H) {
      const P = { x: m.l, y: m.t, w: W - m.l - m.r, h: H - m.t - m.b };
      const all = o.series.filter(s => !s.hidden);
      const ysAll = all.flatMap(s => s.y.filter(v => v != null && isFinite(v)));
      const yMin = o.yMin ?? Math.min(...ysAll), yMax = o.yMax ?? Math.max(...ysAll);
      const xMin = o.xMin ?? Math.min(...all.map(s => s.x[0])), xMax = o.xMax ?? Math.max(...all.map(s => s.x[s.x.length - 1]));
      const xs = o.xLog ? (v => P.x + P.w * (Math.log(v / xMin) / Math.log(xMax / xMin))) : (v => P.x + P.w * (v - xMin) / (xMax - xMin));
      const ys = v => P.y + P.h * (1 - (v - yMin) / (yMax - yMin));
      this._g = { P, xs, ys, xMin, xMax, yMin, yMax };
      ctx.font = font(); ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
      for (const t of (o.yTicks || niceTicks(yMin, yMax, 5))) {
        ctx.fillStyle = cssVar('--grid'); ctx.fillRect(P.x, Math.round(ys(t)), P.w, 1);
        ctx.fillStyle = cssVar('--muted'); ctx.fillText((o.yFmt || (v => +v.toFixed(2)))(t), P.x - 6, ys(t));
      }
      const xt = o.xTicks || (o.xLog ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter(v => v >= xMin && v <= xMax) : niceTicks(xMin, xMax, 8));
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (const t of xt) {
        ctx.fillStyle = cssVar('--grid'); ctx.fillRect(Math.round(xs(t)), P.y, 1, P.h);
        ctx.fillStyle = cssVar('--muted'); ctx.fillText((o.xFmt || (o.xLog ? fmtHz : (v => +v.toFixed(2))))(t), xs(t), P.y + P.h + 5);
      }
      ctx.save(); ctx.beginPath(); ctx.rect(P.x, P.y, P.w, P.h); ctx.clip();
      if (o.bands) for (const b of o.bands) { ctx.fillStyle = b.color; ctx.globalAlpha = b.alpha ?? 0.1; ctx.fillRect(xs(b.x0), P.y, xs(b.x1) - xs(b.x0), P.h); ctx.globalAlpha = 1; }
      for (const s of all) {
        ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.setLineDash(s.dash || []);
        ctx.beginPath(); let pen = false;
        s.x.forEach((x, i) => {
          const v = s.y[i];
          if (v == null || !isFinite(v)) { pen = false; return; }
          const X = xs(x), Y = ys(clamp(v, yMin - (yMax - yMin), yMax + (yMax - yMin)));
          if (!pen) { ctx.moveTo(X, Y); pen = true; } else ctx.lineTo(X, Y);
        });
        ctx.stroke();
        if (s.fill) {
          ctx.lineTo(xs(s.x[s.x.length - 1]), ys(yMin)); ctx.lineTo(xs(s.x[0]), ys(yMin)); ctx.closePath();
          ctx.fillStyle = rgba(s.color, 0.12); ctx.fill();
        }
        if (s.points) { ctx.fillStyle = s.color; s.x.forEach((x, i) => { if (s.y[i] != null) { ctx.beginPath(); ctx.arc(xs(x), ys(s.y[i]), 3, 0, 7); ctx.fill(); } }); }
      }
      ctx.setLineDash([]);
      if (o.vlines) for (const v of o.vlines) {
        const X = Math.round(xs(v.x)) + 0.5;
        ctx.strokeStyle = v.color || cssVar('--ink-2'); ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X, P.y); ctx.lineTo(X, P.y + P.h); ctx.stroke(); ctx.setLineDash([]);
        if (v.label) { ctx.fillStyle = cssVar('--ink-2'); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(v.label, X + 4, P.y + 2); }
      }
      if (hx != null) {
        ctx.strokeStyle = cssVar('--muted'); ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(hx + 0.5, P.y); ctx.lineTo(hx + 0.5, P.y + P.h); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.restore();
    },
    hoverRedraw: true,
    hit(x) {
      const g = this._g; if (!g || x < g.P.x || x > g.P.x + g.P.w) { hx = null; return null; }
      hx = x;
      const xv = o.xLog ? g.xMin * Math.pow(g.xMax / g.xMin, (x - g.P.x) / g.P.w) : g.xMin + (x - g.P.x) / g.P.w * (g.xMax - g.xMin);
      const rows = [`<b>${(o.xFmtTip || o.xFmt || (o.xLog ? (v => fmtHz(v) + ' Hz') : (v => v.toFixed(2))))(xv)}</b>`];
      for (const s of o.series) {
        if (s.hidden) continue;
        let best = 0, bd = Infinity;
        s.x.forEach((xx, i) => { const d = Math.abs(xx - xv); if (d < bd) { bd = d; best = i; } });
        const v = s.y[best];
        if (v != null) rows.push(`<span class="sw" style="background:${s.color}"></span>${s.name || ''}: <b>${(o.yFmtTip || o.yFmt || (v => v.toFixed(1)))(v)}</b>`);
      }
      return rows.join('<br>');
    },
  });
}

/** Radar chart. axes: [{label, value 0..1, desc}] */
export function radarChart(parent, o) {
  return new StaticChart(parent, {
    height: o.height || 300,
    draw(ctx, W, H) {
      const n = o.axes.length;
      const cx = W / 2, cy = H / 2 + 4, R = Math.min(W / 2 - 70, H / 2 - 26);
      const ang = i => -Math.PI / 2 + i * 2 * Math.PI / n;
      this._g = { cx, cy, R, ang, n };
      ctx.strokeStyle = cssVar('--grid'); ctx.lineWidth = 1;
      for (const r of [0.25, 0.5, 0.75, 1]) {
        ctx.beginPath();
        for (let i = 0; i <= n; i++) { const a = ang(i % n); const x = cx + Math.cos(a) * R * r, y = cy + Math.sin(a) * R * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.stroke();
      }
      for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(ang(i)) * R, cy + Math.sin(ang(i)) * R); ctx.stroke(); }
      const col = o.color || cssVar('--s1');
      ctx.beginPath();
      o.axes.forEach((a, i) => { const v = clamp(a.value ?? 0, 0, 1); const x = cx + Math.cos(ang(i)) * R * v, y = cy + Math.sin(ang(i)) * R * v; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath(); ctx.fillStyle = rgba(col, 0.22); ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = col;
      o.axes.forEach((a, i) => { const v = clamp(a.value ?? 0, 0, 1); ctx.beginPath(); ctx.arc(cx + Math.cos(ang(i)) * R * v, cy + Math.sin(ang(i)) * R * v, 4, 0, 7); ctx.fill(); });
      ctx.font = font(12); ctx.fillStyle = cssVar('--ink-2'); ctx.textBaseline = 'middle';
      o.axes.forEach((a, i) => {
        const x = cx + Math.cos(ang(i)) * (R + 12), y = cy + Math.sin(ang(i)) * (R + 12);
        ctx.textAlign = Math.abs(Math.cos(ang(i))) < 0.2 ? 'center' : Math.cos(ang(i)) > 0 ? 'left' : 'right';
        ctx.fillText(`${a.label} ${Math.round((a.value ?? 0) * 100)}`, x, y);
      });
    },
    hit(x, y) {
      const g = this._g; if (!g) return null;
      let a = Math.atan2(y - g.cy, x - g.cx) + Math.PI / 2; if (a < 0) a += 2 * Math.PI;
      const i = Math.round(a / (2 * Math.PI / g.n)) % g.n;
      const ax = o.axes[i];
      return `<b>${ax.label}</b>: ${Math.round(ax.value * 100)} / 100<br><span class="muted">${ax.desc || ''}</span>`;
    },
  });
}

/** Square image (e.g. self-similarity matrix). img: canvas; extra draw via o.after(ctx, geo) */
export function squareImage(parent, o) {
  return new StaticChart(parent, {
    height: w => Math.min(o.maxH || 560, w) ,
    draw(ctx, W, H) {
      const S = Math.min(W - (o.ml || 50), H - (o.mb || 26));
      const x0 = (o.ml || 50) + (W - (o.ml || 50) - S) / 2, y0 = 4;
      this._g = { x0, y0, S };
      if (o.img()) {
        ctx.imageSmoothingEnabled = o.smooth ?? false;
        ctx.drawImage(o.img(), x0, y0, S, S);
      }
      if (o.after) o.after.call(this, ctx, this._g);
    },
    hit(x, y) { return o.hit ? o.hit.call(this, x, y, this._g) : null; },
    click(x, y) { if (o.click) o.click.call(this, x, y, this._g); },
    onPlayhead: o.onPlayhead,
  });
}
