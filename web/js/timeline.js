// Global time view shared by every time-aligned chart (zoom window + playhead).
import { clamp } from './util.js';

export const TL = {
  duration: 1, t0: 0, t1: 1, playhead: 0, follow: true,
  _view: new Set(), _ph: new Set(), seekHandler: null,

  reset(duration) {
    this.duration = duration;
    this.t0 = 0; this.t1 = duration; this.playhead = 0;
    this._emitView();
    this._emitPh();
  },
  setView(a, b) {
    const minSpan = Math.min(0.5, this.duration);
    let span = clamp(b - a, minSpan, this.duration);
    a = clamp(a, 0, this.duration - span);
    if (Math.abs(a - this.t0) < 1e-6 && Math.abs(a + span - this.t1) < 1e-6) return;
    this.t0 = a; this.t1 = a + span;
    this._emitView();
  },
  zoom(factor, center = (this.t0 + this.t1) / 2) {
    const a = center - (center - this.t0) * factor;
    const b = center + (this.t1 - center) * factor;
    this.setView(a, b);
  },
  pan(dt) { this.setView(this.t0 + dt, this.t1 + dt); },
  fit() { this.setView(0, this.duration); },
  seek(t) {
    t = clamp(t, 0, this.duration);
    if (this.seekHandler) this.seekHandler(t); else this.setPlayhead(t);
  },
  setPlayhead(t) {
    this.playhead = t;
    if (this.follow && (t > this.t1 || t < this.t0) && this.t1 - this.t0 < this.duration - 1e-6) {
      const span = this.t1 - this.t0;
      this.setView(t - span * 0.05, t + span * 0.95);
    }
    this._emitPh();
  },
  onView(fn) { this._view.add(fn); return () => this._view.delete(fn); },
  onPlayhead(fn) { this._ph.add(fn); return () => this._ph.delete(fn); },
  _emitView() { for (const f of this._view) f(this.t0, this.t1); },
  _emitPh() { for (const f of this._ph) f(this.playhead); },
};
