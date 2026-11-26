// Web Audio playback: original mix or stem mixer, metronome, loop, analysers for live views.
import { TL } from './timeline.js';
import { url } from './data.js';
import { bisect } from './util.js';

export const Player = {
  ctx: null, master: null, bus: null, mixGain: null, stemBus: null,
  analyser: null, anL: null, anR: null,
  mixBuf: null, stemBufs: {}, stemNodes: {}, stemState: {},
  mode: 'mix', playing: false, offset: 0, startedAt: 0, rate: 1, sources: [],
  metro: false, loop: false, beats: [], beatPos: [], _metroNext: 0, _metroTimer: 0,
  listeners: new Set(),

  async init(A) {
    this.stop(true);
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const c = this.ctx;
      this.master = c.createGain(); this.master.gain.value = 0.9;
      this.mixGain = c.createGain();
      this.stemBus = c.createGain();
      this.mixGain.connect(this.master); this.stemBus.connect(this.master);
      this.analyser = c.createAnalyser(); this.analyser.fftSize = 8192; this.analyser.smoothingTimeConstant = 0.6;
      const sp = c.createChannelSplitter(2);
      this.anL = c.createAnalyser(); this.anR = c.createAnalyser();
      this.anL.fftSize = this.anR.fftSize = 2048;
      this.master.connect(this.analyser); this.master.connect(sp);
      sp.connect(this.anL, 0); sp.connect(this.anR, 1);
      this.master.connect(c.destination);
      this.click = c.createGain(); this.click.gain.value = 0.6; this.click.connect(c.destination);
    }
    this.mixBuf = null; this.stemBufs = {}; this.stemState = {}; this.mode = 'mix'; this.offset = 0;
    for (const n of Object.values(this.stemNodes)) { try { n.gain.disconnect(); } catch (e) { /* */ } }
    this.stemNodes = {};
    this.beats = A.rhythm?.beats || [];
    this.beatPos = A.rhythm?.beat_pos || [];
    const buf = await fetch(url(A.audio.mix)).then(r => r.arrayBuffer());
    this.mixBuf = await this.ctx.decodeAudioData(buf);
    TL.seekHandler = t => this.seek(t);
    this.emit();
  },

  async loadStems(stems, onProgress) {
    let done = 0;
    await Promise.all(stems.map(async s => {
      if (this.stemBufs[s.name]) return;
      const buf = await fetch(url(s.file)).then(r => r.arrayBuffer());
      this.stemBufs[s.name] = await this.ctx.decodeAudioData(buf);
      const g = this.ctx.createGain();
      const an = this.ctx.createAnalyser(); an.fftSize = 1024;
      g.connect(an); g.connect(this.stemBus);
      this.stemNodes[s.name] = { gain: g, an };
      this.stemState[s.name] ??= { vol: 1, mute: false, solo: false };
      onProgress?.(++done / stems.length);
    }));
    this.applyStemGains();
  },

  applyStemGains() {
    const anySolo = Object.values(this.stemState).some(s => s.solo);
    for (const [name, n] of Object.entries(this.stemNodes)) {
      const s = this.stemState[name];
      const on = anySolo ? s.solo : !s.mute;
      n.gain.gain.setTargetAtTime(on ? s.vol : 0, this.ctx.currentTime, 0.015);
    }
  },

  setMode(mode) {
    const t = this.time();
    const was = this.playing;
    this.stop(true);
    this.mode = mode;
    this.offset = t;
    if (was) this.play();
    this.emit();
  },

  time() {
    if (!this.playing) return this.offset;
    return this.offset + (this.ctx.currentTime - this.startedAt) * this.rate;
  },
  duration() { return this.mixBuf ? this.mixBuf.duration : 0; },

  play() {
    if (!this.mixBuf || this.playing) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const dur = this.duration();
    if (this.offset >= dur - 0.05) this.offset = 0;
    const when = this.ctx.currentTime + 0.03;
    const mk = (buf, dest) => {
      const s = this.ctx.createBufferSource();
      s.buffer = buf; s.playbackRate.value = this.rate; s.connect(dest);
      s.start(when, Math.min(this.offset, buf.duration - 0.001));
      this.sources.push(s);
      return s;
    };
    if (this.mode === 'stems' && Object.keys(this.stemBufs).length) {
      for (const [name, buf] of Object.entries(this.stemBufs)) mk(buf, this.stemNodes[name].gain);
    } else mk(this.mixBuf, this.mixGain);
    this.sources[0].onended = () => { if (this.playing && this.time() >= dur - 0.1) { this.stop(true); this.offset = dur; this.emit(); } };
    this.startedAt = when;
    this.playing = true;
    this._metroNext = bisect(this.beats, this.offset);
    this._tick();
    this._metroTimer = setInterval(() => this._scheduleMetro(), 25);
    this.emit();
  },

  pause() { if (!this.playing) return; this.offset = this.time(); this.stop(true); this.emit(); },
  toggle() { this.playing ? this.pause() : this.play(); },

  stop(keepOffset = false) {
    for (const s of this.sources) { try { s.onended = null; s.stop(); } catch (e) { /* */ } }
    this.sources = [];
    this.playing = false;
    clearInterval(this._metroTimer);
    if (!keepOffset) { this.offset = 0; TL.setPlayhead(0); }
    this.emit();
  },

  seek(t) {
    const was = this.playing;
    this.stop(true);
    this.offset = Math.max(0, Math.min(t, this.duration()));
    TL.setPlayhead(this.offset);
    if (was) this.play();
  },

  setRate(r) { const t = this.time(); const was = this.playing; this.stop(true); this.rate = r; this.offset = t; if (was) this.play(); },
  setVolume(v) { if (this.master) this.master.gain.value = v; },

  _scheduleMetro() {
    if (!this.metro || !this.playing) return;
    const now = this.ctx.currentTime;
    const horizon = now + 0.12;
    while (this._metroNext < this.beats.length) {
      const bt = this.beats[this._metroNext];
      const when = this.startedAt + (bt - this.offset) / this.rate;
      if (when > horizon) break;
      if (when >= now - 0.01) {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        const down = this.beatPos[this._metroNext] === 1;
        o.frequency.value = down ? 1760 : 1100;
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(down ? 0.9 : 0.5, when + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
        o.connect(g); g.connect(this.click); o.start(when); o.stop(when + 0.08);
      }
      this._metroNext++;
    }
  },

  _tick() {
    if (!this.playing) return;
    const t = this.time();
    if (this.loop && TL.t1 - TL.t0 < this.duration() - 0.01 && t >= TL.t1) { this.seek(TL.t0); return; }
    TL.setPlayhead(t);
    for (const f of this.listeners) f(t);
    requestAnimationFrame(() => this._tick());
  },

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  _stateFns: new Set(),
  onState(fn) { this._stateFns.add(fn); },
  emit() { for (const f of this._stateFns) f(this); },
};
