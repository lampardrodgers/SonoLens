// Cinema mode stage: one 1920×1080 canvas, chapter header, narrative facts, global timeline,
// scene transitions, title card / finale map, scene picker and video recording.
import { W, H, PAL, F as FONT, TONE, Feed, text, line, circle, glowDot, roundRect, clamp, lerp, easeOut, mmss, rgba, wrap, measure } from './fx.js';
import { scenesA } from './scenes_a.js';
import { scenesB, drawTitle, drawFinale } from './scenes_b.js';
import { scenesC } from './scenes_c.js';
import { river3d } from './river3d.js';
import { Player } from '../player.js';
import { h } from '../util.js';
import { AI, openSettings } from '../ai.js';

export const SCENES = { ...scenesA, ...scenesB, ...scenesC, river3d };
export const SCENE_LIST = [
  ['pianoroll', '音高卷帘'], ['chromaclock', '音级时钟'], ['rhythmspiral', '节奏螺旋'], ['spectrumbars', '实时频谱'],
  ['chordorbit', '和弦轨道'], ['keytrail', '调性中心轨迹'], ['oscilloscope', '示波器'], ['ridgeline', '频谱山脊'],
  ['lissajous', '声像 · 李萨如'], ['chromaradar', '音高分布雷达'],
  ['notefall', '音符瀑布 ✦'], ['stemgalaxy', '分轨星系 ✦'], ['radial', '环形声纹 ✦'], ['tonnetz', '音网 Tonnetz ✦'],
  ['streamgraph', '分轨能量河流 ✦'], ['drumgrid', '鼓组步进网格 ✦'], ['ssm', '自相似矩阵 ✦'], ['waterfall', '瀑布频谱 ✦'],
  ['audioring', '声波光环 ★'], ['particles', '粒子风暴 ★'], ['mixer', '调音台 ★'], ['chordpiano', '和弦钢琴 ★'],
  ['melody', '旋律线 ★'], ['beatpulse', '节拍脉冲 ★'], ['stereofield', '声场频谱 ★'], ['loudmeter', '响度表 ★'],
  ['kaleido', '万花筒 ★'], ['tunnel', '声隧道 ★'], ['strings', '十二弦 ★'],
];

const MAIN = { x: 90, y: 250, w: 1200, h: 640 };
const WIDE = { x: 90, y: 250, w: 1740, h: 560 };
const FACTS = { x: 1370, y: 262, w: 460, h: 640 };
const TLY = 940, TLX0 = 90, TLX1 = W - 90;
const INTRO = 4.2, FADE = 0.9;

export class Cinema {
  constructor(A, { onExit } = {}) {
    this.A = A; this.onExit = onExit;
    this.mode = 'auto'; this.phase = 'title'; this.phaseStart = 0; this.autoIntro = false;
    this.mems = new Map(); this.cur = null; this.prev = null; this.chIdx = -1; this.chChange = 0;
    this.dust = Array.from({ length: 70 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.6 + 0.3, v: Math.random() * 8 + 3, a: Math.random() * 0.25 + 0.05 }));
    this.last = 0; this.raf = 0; this.idleT = 0;
  }

  async open(root = document.body) {
    this.el = h('div', { class: 'cin' });
    this.cv = h('canvas', { class: 'cin-cv', width: W, height: H });
    this.g = this.cv.getContext('2d');
    const sceneSel = h('select', { class: 'cin-sel', title: '场景' },
      h('option', { value: 'auto' }, '场景：自动（按章节编排）'),
      ...SCENE_LIST.map(([k, n]) => h('option', { value: k }, n)),
      h('option', { value: '@title' }, '片头'), h('option', { value: '@finale' }, '全曲地图'));
    const chSel = h('select', { class: 'cin-sel', title: '跳到章节' }, h('option', { value: '' }, '跳到章节…'));
    this.ui = h('div', { class: 'cin-ui' },
      h('button', { class: 'cin-btn', 'data-a': 'exit', title: '返回仪表盘 (Esc)' }, '✕'),
      h('button', { class: 'cin-btn big', 'data-a': 'play', title: '播放/暂停 (空格)' }, '▶'),
      h('button', { class: 'cin-btn', 'data-a': 'restart', title: '从片头开始' }, '⟲'),
      sceneSel, chSel,
      h('button', { class: 'cin-btn ai', 'data-a': 'ai', title: 'AI 实时解说：开/关；还没有解说时会用默认模型现场生成 (A)' }, '✦ AI 解说'),
      h('button', { class: 'cin-btn rec', 'data-a': 'rec', title: '把整部影片录制为视频文件（含音频）' }, '● 录制视频'),
      h('button', { class: 'cin-btn', 'data-a': 'full', title: '全屏 (F)' }, '⛶'));
    this.recEl = h('div', { class: 'cin-rec', hidden: true });
    this.loading = h('div', { class: 'cin-loading' }, '正在准备影院模式…');
    this.el.append(this.cv, this.ui, this.recEl, this.loading);
    root.append(this.el);
    this.sceneSel = sceneSel; this.chSel = chSel; this.playBtn = this.ui.querySelector('[data-a=play]');
    this.aiBtn = this.ui.querySelector('[data-a=ai]'); this.aiOn = true;
    AI.narration(this.A.id).catch(() => {});

    this._fit = () => {
      const s = Math.min(innerWidth / W, innerHeight / H);
      this.cv.style.width = `${W * s}px`; this.cv.style.height = `${H * s}px`;
    };
    addEventListener('resize', this._fit); this._fit();
    this._key = e => this.onKey(e);
    addEventListener('keydown', this._key, true);
    this._move = () => { this.el.classList.remove('idle'); clearTimeout(this.idleT); this.idleT = setTimeout(() => this.el.classList.add('idle'), 2600); };
    this.el.addEventListener('mousemove', this._move); this._move();
    this.ui.addEventListener('click', e => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) this.action(a); });
    sceneSel.addEventListener('change', () => { this.setMode(sceneSel.value); sceneSel.blur(); });
    chSel.addEventListener('change', () => { const c = this.F.chapters[+chSel.value]; if (c) this.seek(c.start + 0.01); chSel.value = ''; chSel.blur(); });
    this.cv.addEventListener('click', e => this.onClick(e));
    this.cv.addEventListener('dblclick', () => this.action('full'));
    this._state = () => { this.playBtn.textContent = Player.playing || this.autoIntro ? '❚❚' : '▶'; };
    Player.onState(this._state);

    this.F = await new Feed(this.A).load();
    this.F.chapters.forEach((c, i) => chSel.append(h('option', { value: i }, `${c.roman} · ${c.name}  ${mmss(c.start)}`)));
    this.bg = this.makeBg();
    this.tlImgs = this.makeTimeline();
    this.loading.remove();
    window.__cinema = this;
    this.phase = Player.time() < 0.3 ? 'title' : 'play';
    this.phaseStart = performance.now() / 1000 - (this.phase === 'title' ? INTRO : 0);
    this.raf = requestAnimationFrame(ts => this.frame(ts));
    this._state();
  }

  close() {
    cancelAnimationFrame(this.raf);
    if (this.recording) this.stopRecording(true);
    removeEventListener('resize', this._fit);
    removeEventListener('keydown', this._key, true);
    Player._stateFns.delete(this._state);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.el.remove();
  }

  // ---------------------------------------------------------------------------------------------
  action(a) {
    const now = performance.now() / 1000;
    if (a === 'exit') { this.close(); this.onExit?.(); }
    else if (a === 'play') this.togglePlay();
    else if (a === 'restart') { Player.pause(); Player.seek(0); this.phase = 'title'; this.phaseStart = now; this.autoIntro = true; this._state(); }
    else if (a === 'full') { document.fullscreenElement ? document.exitFullscreen() : this.el.requestFullscreen?.(); }
    else if (a === 'rec') this.recording ? this.stopRecording(false) : this.startRecording();
    else if (a === 'ai') this.toggleAI();
  }
  get nar() { return AI.nar.get(this.A.id); }
  async toggleAI() {
    const n = this.nar, rid = this.A.id;
    if (AI.busy.has(rid)) { this.aiOn = !this.aiOn; return; }
    if (n && (n.moments?.length || n.summary) && !n.error) { this.aiOn = !this.aiOn; return; }
    const c = await AI.loadConf(true);
    const p = c.providers.find(x => x.id === c.active);
    if (!p?.has_key) { if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); openSettings(); return; }
    this.aiOn = true;
    AI.generate(rid, { provider: c.active, style: 'pro' });
  }
  aiLabel() {
    const n = this.nar, busy = AI.busy.has(this.A.id);
    const s = busy ? `✦ AI 撰写中 ${n?.moments?.length || 0}` : !n || n.error ? '✦ AI 解说' : this.aiOn ? '✦ AI 解说 · 开' : '✦ AI 解说 · 关';
    if (this.aiBtn.textContent !== s) { this.aiBtn.textContent = s; this.aiBtn.classList.toggle('on', !!(n && !n.error && this.aiOn)); }
  }
  togglePlay() {
    const now = performance.now() / 1000;
    if (this.autoIntro) { this.autoIntro = false; this.phase = 'play'; this.phaseStart = now; Player.play(); }
    else if (this.phase === 'title' && !Player.playing) { this.phaseStart = now; this.autoIntro = true; }
    else if (this.phase === 'finale') { Player.seek(0); this.phase = 'title'; this.phaseStart = now; this.autoIntro = true; }
    else Player.toggle();
    this._state();
  }
  seek(t) {
    Player.seek(clamp(t, 0, Player.duration()));
    if (this.phase !== 'play') { this.phase = 'play'; this.phaseStart = performance.now() / 1000 - FADE; this.autoIntro = false; }
  }
  setMode(m) { this.mode = m; this.sceneSel.value = m; }
  onKey(e) {
    if (e.target.tagName === 'SELECT' && !['Escape', ' '].includes(e.key)) return;
    const k = e.key; let used = true;
    if (k === ' ') this.togglePlay();
    else if (k === 'Escape') { if (this.recording) this.stopRecording(true); else if (!document.fullscreenElement) this.action('exit'); else used = false; }
    else if (k === 'ArrowRight') this.seek(Player.time() + (e.shiftKey ? 15 : 5));
    else if (k === 'ArrowLeft') this.seek(Player.time() - (e.shiftKey ? 15 : 5));
    else if (k === 'f' || k === 'F') this.action('full');
    else if (k === 'a' || k === 'A') this.action('ai');
    else if (k === 's' || k === 'S') {
      const keys = ['auto', ...SCENE_LIST.map(s => s[0])];
      this.setMode(keys[(keys.indexOf(this.mode) + (e.shiftKey ? keys.length - 1 : 1)) % keys.length]);
    } else if (/^[1-9]$/.test(k)) { const c = this.F.chapters[+k - 1]; if (c) this.seek(c.start + 0.01); }
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); }
  }
  onClick(e) {
    const r = this.cv.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * W, y = (e.clientY - r.top) / r.height * H;
    if (y > TLY - 20 && x >= TLX0 - 10 && x <= TLX1 + 10) this.seek(clamp((x - TLX0) / (TLX1 - TLX0), 0, 1) * this.F.dur);
    else this.togglePlay();
  }

  // ---------------------------------------------------------------------------------------------
  makeBg() {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = PAL.bg; g.fillRect(0, 0, W, H);
    const r = g.createRadialGradient(W * 0.45, H * 0.45, 80, W * 0.5, H * 0.5, W * 0.75);
    r.addColorStop(0, 'rgba(46,34,24,0.55)'); r.addColorStop(0.5, 'rgba(20,15,11,0.3)'); r.addColorStop(1, 'rgba(0,0,0,0.85)');
    g.fillStyle = r; g.fillRect(0, 0, W, H);
    const img = g.getImageData(0, 0, W, H), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 9; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(img, 0, 0);
    return c;
  }
  makeTimeline() {
    const st = this.A.loudness?.short_term, F = this.F;
    const mk = (stroke, fill) => {
      const c = document.createElement('canvas'); c.width = W; c.height = 90;
      const g = c.getContext('2d');
      if (!st?.v) return c;
      const vs = st.v.filter(v => v != null && v > -70).sort((a, b) => a - b);
      const hi = (vs[vs.length - 1] ?? -6) + 1.5, lo = Math.max(-60, Math.min(hi - 18, (vs[Math.floor(vs.length * 0.04)] ?? -40) - 4)), y0 = 6, y1 = 70;
      const pts = [];
      for (let x = TLX0; x <= TLX1; x += 2) {
        const tt = (x - TLX0) / (TLX1 - TLX0) * F.dur;
        let v = -70, n = 0; // max over the pixel span for a crisp silhouette
        const i0 = Math.floor((tt - st.t0) / st.dt), i1 = Math.floor((tt + F.dur / (TLX1 - TLX0) * 2 - st.t0) / st.dt);
        for (let i = Math.max(0, i0); i <= Math.min(st.v.length - 1, i1); i++) if (st.v[i] != null) { v = Math.max(v, st.v[i]); n++; }
        pts.push([x, y1 - clamp((v - lo) / (hi - lo), 0, 1) * (y1 - y0)]);
      }
      g.beginPath(); g.moveTo(TLX0, y1); for (const [x, y] of pts) g.lineTo(x, y); g.lineTo(TLX1, y1); g.closePath();
      if (fill) { const gr = g.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, fill); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fill(); }
      g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
      g.strokeStyle = stroke; g.lineWidth = 1.6; g.stroke();
      c.pts = pts;
      return c;
    };
    return { past: mk(PAL.gold, rgba(PAL.gold, 0.32)), fut: mk('rgba(139,133,123,0.45)', 'rgba(139,133,123,0.06)') };
  }

  // ---------------------------------------------------------------------------------------------
  memFor(key) { if (!this.mems.has(key)) this.mems.set(key, {}); return this.mems.get(key); }

  frame(ts) {
    this.raf = requestAnimationFrame(ts2 => this.frame(ts2));
    const now = ts / 1000, dt = clamp(now - (this.last || now), 0, 0.1); this.last = now;
    const g = this.g, F = this.F, dur = F.dur;
    let t = Player.time();

    // phase logic
    if (this.mode === '@title') { this.phase = 'title'; }
    else if (this.mode === '@finale') { this.phase = 'finale'; }
    else {
      if (this.phase === 'title' && this.autoIntro && now - this.phaseStart > INTRO) {
        this.autoIntro = false; this.phase = 'play'; this.phaseStart = now; Player.seek(0); Player.play(); this._state();
      }
      if (this.phase === 'play' && !Player.playing && t >= dur - 0.15) { this.phase = 'finale'; this.phaseStart = now; }
      if (this.phase === 'finale' && t < dur - 0.15) { this.phase = 'play'; this.phaseStart = now; }
      if (this.phase === 'title' && !this.autoIntro && (Player.playing || t > 0.3)) { this.phase = 'play'; this.phaseStart = now; }
    }
    if (this.recording && this.phase === 'finale' && now - this.phaseStart > 9) this.stopRecording(false);
    if (this.recording) this.recEl.textContent = `● REC  ${mmss(now - this.recording.t0)}`;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.drawImage(this.bg, 0, 0);
    for (const p of this.dust) { p.y -= p.v * dt; if (p.y < -5) { p.y = H + 5; p.x = Math.random() * W; } circle(g, p.x, p.y, p.r, rgba(PAL.gold, p.a)); }

    const pk = now - this.phaseStart;
    try {
      if (this.phase === 'title') {
        const tk = this.autoIntro ? clamp(pk / 1.6, 0, 1) * (pk > INTRO - 0.8 ? clamp((INTRO - pk) / 0.8, 0, 1) : 1) : 1;
        drawTitle(g, F, W, H, now, tk);
        const n = this.nar;
        if (this.aiOn && n?.title) text(g, `✦ AI 解读 ·「${n.title}」`, W / 2, 912, { align: 'center', size: 26, font: FONT.cn, color: PAL.goldHi, alpha: easeOut(tk) * 0.9, ls: 2 });
      } else if (this.phase === 'finale') {
        drawFinale(g, F, W, H, now, clamp(pk / 1.4, 0, 1));
      } else {
        g.save(); g.globalAlpha = clamp(pk / FADE, 0, 1);
        this.drawPlay(g, t, now, dt);
        g.restore();
      }
    } catch (e) { console.error('cinema frame', e); }
    this.drawCorner(g, t);
    this.aiLabel();
  }

  pickScene(ch, t) {
    if (this.mode !== 'auto' && SCENES[this.mode]) return this.mode;
    const sc = ch.scenes || [];
    const s = sc.find(s => t >= s.start && t < s.end) || sc[sc.length - 1];
    return s && SCENES[s.type] ? s.type : 'spectrumbars';
  }

  drawPlay(g, t, now, dt) {
    const F = this.F, chs = F.chapters;
    const chIdx = F.chapterIdx(t), ch = chs[chIdx] || { start: 0, end: F.dur, roman: 'I', name: '', subtitle: '', facts: [], m: {}, scenes: [] };
    if (chIdx !== this.chIdx) { this.chIdx = chIdx; this.chChange = now; }
    const type = this.pickScene(ch, t);
    const key = `${chIdx}|${type}`;
    if (!this.cur || this.cur.key !== key) {
      if (this.cur) this.prev = { ...this.cur, end: now };
      this.cur = { key, type, chIdx, start: now };
    }
    const wide = !!ch.break && this.mode === 'auto';
    const R = wide ? WIDE : MAIN;
    // scenes (with crossfade)
    const drawScene = (s, alpha) => {
      const sc = SCENES[s.type]; if (!sc || alpha <= 0.01) return;
      const c = chs[s.chIdx] || ch;
      g.save(); g.globalAlpha *= alpha;
      g.beginPath(); g.rect(R.x - 60, R.y - 40, R.w + 120, R.h + 70); g.clip();
      sc.draw(g, { t, F, R, ch: c, chIdx: s.chIdx, age: now - s.start, mem: this.memFor(s.type), dt, now });
      g.restore();
    };
    const k = clamp((now - this.cur.start) / FADE, 0, 1);
    if (this.prev && k < 1) drawScene(this.prev, 1 - easeOut(k));
    drawScene(this.cur, easeOut(k));

    this.drawHeader(g, ch, chIdx, SCENES[type], now, t);
    const sub = this.aiOn ? this.drawNarration(g, t, R, wide) : false;
    if (wide) { if (!sub) this.drawCenterFacts(g, ch, t); } else this.drawFacts(g, ch, t);
    this.drawTimeline(g, t, chIdx);
  }

  /** Live AI subtitle: the latest moment ≤ t, typed out at a fixed rate (deterministic in t, so it records too). */
  drawNarration(g, t, R, wide) {
    const n = this.nar;
    if (!n || n.error) return false;
    const ms = n.moments || [];
    let i = -1;
    for (let k = 0; k < ms.length && ms[k].t <= t + 0.05; k++) i = k;
    const busy = AI.busy.has(this.A.id);
    const yb = wide ? 812 : 800;
    let m = i >= 0 ? ms[i] : null, age = m ? t - m.t : 0;
    if (m) {
      const nxt = ms[i + 1];
      const life = Math.min(Math.max(5.5, m.text.length * 0.3 + 2.5), nxt ? nxt.t - m.t : 1e9);
      if (age > life + 0.6) m = null;
    }
    if (!m) {
      if (busy) text(g, `✦ AI 正在聆听数据并撰写解说…  已完成 ${ms.length} 条`, R.x + R.w / 2, yb + 74, { align: 'center', size: 20, font: FONT.cn, color: PAL.gold, alpha: 0.55 + 0.25 * Math.sin(performance.now() / 300) });
      return false;
    }
    const nxt = ms[i + 1];
    const life = Math.min(Math.max(5.5, m.text.length * 0.3 + 2.5), nxt ? nxt.t - m.t : 1e9);
    const a = clamp(age / 0.35, 0, 1) * clamp((life + 0.6 - age) / 0.6, 0, 1);
    const shown = Math.min(m.text.length, Math.floor(age * 15) + 1);
    const typing = shown < m.text.length;
    const lines = wrap(g, m.text.slice(0, shown), R.w - 160, { size: 31, font: FONT.cn }).slice(0, 3);
    g.save(); g.globalAlpha *= a;
    const gr = g.createLinearGradient(0, yb - 24, 0, yb + 118);
    gr.addColorStop(0, 'rgba(10,8,7,0)'); gr.addColorStop(0.3, 'rgba(10,8,7,0.9)'); gr.addColorStop(1, 'rgba(10,8,7,0.95)');
    g.fillStyle = gr; g.fillRect(R.x - 40, yb - 24, R.w + 80, 142);
    const cy = yb + 70 - (lines.length - 1) * 21;
    const tag = `✦ ${mmss(m.t)}`;
    text(g, tag, R.x + 10, cy - 34 - (lines.length > 1 ? 0 : 0), { size: 15, font: FONT.num, color: PAL.gold, alpha: 0.85, ls: 2 });
    lines.forEach((s, k) => {
      const w = text(g, s, R.x + R.w / 2, cy + k * 42, { align: 'center', size: 31, font: FONT.cn, color: PAL.cream, glow: 'rgba(0,0,0,0.9)', blur: 12 });
      if (typing && k === lines.length - 1 && Math.floor(performance.now() / 400) % 2) {
        const tw = measure(g, s, { size: 31, font: FONT.cn });
        g.fillStyle = PAL.gold; g.fillRect(R.x + R.w / 2 + tw / 2 + 4, cy + k * 42 - 26, 3, 30);
      }
    });
    g.restore();
    return true;
  }

  drawHeader(g, ch, chIdx, sc, now, t) {
    const a = easeOut((now - this.chChange) / 1.0), dx = (1 - a) * -30;
    g.save(); g.globalAlpha *= a;
    const tone = TONE[ch.tone] || PAL.gold;
    const rw = text(g, ch.roman, 90 + dx, 152, { size: 104, font: FONT.display, color: PAL.gold, glow: rgba(PAL.gold, 0.25), blur: 24 });
    const nx = 90 + rw + 34 + dx;
    text(g, ch.name || '', nx, 112, { size: 52, font: FONT.cn, color: PAL.cream, weight: 500 });
    const sw = text(g, ch.subtitle || '', nx, 152, { size: 23, font: FONT.cn, color: PAL.ink });
    text(g, `${mmss(ch.start)} – ${mmss(ch.end)}`, nx + sw + (sw ? 22 : 0), 152, { size: 19, font: FONT.num, color: PAL.gray, ls: 1 });
    line(g, nx, 128, nx + 46, 128, rgba(tone, 0.9), 2);
    g.restore();
    // caption
    if (sc) {
      const d = sc.desc ? sc.desc({ F: this.F, ch }) : '';
      line(g, 90, 206, 128, 206, PAL.gold, 1.5);
      const tw = text(g, sc.title, 142, 213, { size: 23, font: FONT.cn, color: PAL.goldHi, weight: 500 });
      text(g, ` · ${d}`, 142 + tw, 213, { size: 20, font: FONT.cn, color: PAL.gold, alpha: 0.75 });
    }
  }

  drawCorner(g, t) {
    const F = this.F, A = this.A;
    const title = (A.meta.title || A.meta.file_name || '').toUpperCase();
    text(g, title, W - 90, 82, { align: 'right', size: 21, font: FONT.display, color: PAL.gold, ls: 9, maxW: 760 });
    if (this.phase !== 'play') return;
    const lu = F.lufs(t), bpm = F.bpmAt(t), key = F.keyName(F.keyAt(t));
    this.luS = this.luS == null ? lu : lerp(this.luS, lu, 0.08);
    const parts = [
      [this.luS <= -69 ? '−∞' : this.luS.toFixed(1), PAL.cream, FONT.num, 30, 500], [' LUFS', PAL.gray, FONT.num, 16, 400], ['   ·   ', PAL.dim, FONT.num, 18, 400],
      [bpm ? `${Math.round(bpm)}` : '–', PAL.cream, FONT.num, 30, 500], [' BPM', PAL.gray, FONT.num, 16, 400], ['   ·   ', PAL.dim, FONT.num, 18, 400],
      [key, PAL.cream, FONT.cn, 26, 500],
    ];
    const ws = parts.map(([s, , f, sz, w]) => measure(g, s, { size: sz, font: f, weight: w }));
    let x = W - 90 - ws.reduce((a, b) => a + b, 0);
    parts.forEach(([s, c, f, sz, w], i) => { text(g, s, x, 130, { size: sz, font: f, color: c, weight: w }); x += ws[i]; });
    text(g, '短时响度', W - 90 - ws.reduce((a, b) => a + b, 0), 156, { size: 14, font: FONT.cn, color: PAL.dim });
  }

  layoutFacts(g, facts) {
    const out = [];
    for (const f of facts) {
      let hgt = 0, lines = null, sub = null;
      if (f.kind === 'chords') { hgt = 92; }
      else if (f.big) { sub = f.sub ? wrap(g, f.sub, FACTS.w - 24, { size: 19, font: FONT.cn }) : []; hgt = 70 + sub.length * 28; if (f.text) { lines = wrap(g, f.text, FACTS.w - 24, { size: 22, font: FONT.cn }); hgt += lines.length * 34; } }
      else { lines = wrap(g, f.text || '', FACTS.w - 24, { size: 23, font: FONT.cn }); hgt = lines.length * 36; }
      out.push({ f, hgt: hgt + 30, lines, sub });
    }
    return out;
  }
  drawFacts(g, ch, t) {
    const facts = (ch.facts || []).filter(f => f.t <= t + 0.02 && f.kind !== 'center');
    let L = this.layoutFacts(g, facts);
    let tot = L.reduce((a, b) => a + b.hgt, 0);
    let y = FACTS.y, hAvail = FACTS.h;
    const ct = this.aiOn && this.nar && !this.nar.error ? this.nar.chapters?.[ch.roman] : '';
    if (ct) {
      const age = t - ch.start, shown = Math.min(ct.length, Math.floor(age * 22) + 1);
      const ls = wrap(g, ct, FACTS.w - 30, { size: 20, font: FONT.cn }).slice(0, 6);
      const full = ls.join(''); let left = shown;
      const bh = 44 + ls.length * 31;
      g.save(); g.globalAlpha *= easeOut(age / 0.8);
      roundRect(g, FACTS.x - 6, y - 8, FACTS.w + 6, bh, 10); g.fillStyle = 'rgba(232,192,106,0.06)'; g.fill(); g.strokeStyle = 'rgba(232,192,106,0.22)'; g.lineWidth = 1; g.stroke();
      text(g, '✦ AI 章节解说', FACTS.x + 12, y + 18, { size: 15, font: FONT.cn, color: PAL.gold, ls: 2 });
      ls.forEach((s, k) => { const part = s.slice(0, Math.max(0, left)); left -= s.length; if (part) text(g, part, FACTS.x + 12, y + 50 + k * 31, { size: 20, font: FONT.cn, color: '#e9dcc2' }); });
      g.restore();
      void full;
      y += bh + 18; hAvail -= bh + 18;
    }
    while (L.length > 1 && tot > hAvail) { tot -= L[0].hgt; L = L.slice(1); }
    if (ct && tot > hAvail) L = [];
    line(g, FACTS.x - 30, FACTS.y - 12, FACTS.x - 30, FACTS.y + FACTS.h - 20, 'rgba(232,192,106,0.08)', 1);
    for (const it of L) {
      const f = it.f, a = easeOut((t - f.t) / 0.8), oy = (1 - a) * 26;
      const acc = f.accent === 'red' ? PAL.red : f.accent === 'white' ? PAL.cream : PAL.gold;
      g.save(); g.globalAlpha *= a;
      g.fillStyle = acc; g.fillRect(FACTS.x, y + oy + 4, 3, 24);
      const x = FACTS.x + 20;
      let yy = y + oy;
      if (f.kind === 'chords') {
        const chips = (f.text || '').replace(' …', '').split(' - ').slice(0, 8);
        let cx = x, cy = yy;
        for (const c of chips) {
          const w = measure(g, c, { size: 17, font: FONT.num, weight: 600 }) + 22;
          if (cx + w > FACTS.x + FACTS.w) { cx = x; cy += 42; }
          roundRect(g, cx, cy, w, 32, 6); g.fillStyle = rgba(PAL.gold, 0.14); g.fill(); g.strokeStyle = rgba(PAL.gold, 0.4); g.stroke();
          text(g, c, cx + w / 2, cy + 22, { align: 'center', size: 17, font: FONT.num, weight: 600, color: PAL.goldHi });
          cx += w + 8;
        }
      } else if (f.big) {
        if (it.lines) { it.lines.forEach((s, i) => text(g, s, x, yy + 24 + i * 34, { size: 22, font: FONT.cn, color: PAL.ink })); yy += it.lines.length * 34; }
        const col = f.accent === 'red' ? PAL.redHi : PAL.goldHi;
        text(g, f.big, x, yy + 56, { size: 54, font: /[一-龥]/.test(f.big) ? FONT.cn : FONT.num, weight: 500, color: col, glow: rgba(col, 0.3), maxW: FACTS.w - 24 });
        it.sub.forEach((s, i) => text(g, s, x, yy + 90 + i * 28, { size: 19, font: FONT.cn, color: PAL.gray }));
      } else {
        it.lines.forEach((s, i) => text(g, s, x, yy + 24 + i * 36, { size: 23, font: FONT.cn, color: f.accent === 'red' ? '#f2c9c4' : PAL.cream }));
      }
      g.restore();
      y += it.hgt;
    }
  }
  drawCenterFacts(g, ch, t) {
    const facts = (ch.facts || []).filter(f => f.t <= t + 0.02);
    facts.slice(-2).forEach((f, i, arr) => {
      const a = easeOut((t - f.t) / 1.0);
      const s = f.text || [f.big, f.sub].filter(Boolean).join('  ');
      text(g, s, W / 2, 846 + (i - arr.length + 1) * 44 + (1 - a) * 16, { align: 'center', size: i === arr.length - 1 ? 32 : 24, font: FONT.cn, color: i === arr.length - 1 ? PAL.cream : PAL.gray, alpha: a });
    });
  }

  drawTimeline(g, t, chIdx) {
    const F = this.F, dur = F.dur, px = TLX0 + clamp(t / dur, 0, 1) * (TLX1 - TLX0), y0 = TLY + 6;
    text(g, mmss(t), TLX0, TLY - 6, { size: 19, font: FONT.num, color: PAL.cream, weight: 500 });
    text(g, mmss(dur), TLX1, TLY - 6, { align: 'right', size: 19, font: FONT.num, color: PAL.gray });
    g.save(); g.beginPath(); g.rect(px, y0, W, 90); g.clip(); g.drawImage(this.tlImgs.fut, 0, y0); g.restore();
    g.save(); g.beginPath(); g.rect(0, y0, px, 90); g.clip(); g.drawImage(this.tlImgs.past, 0, y0); g.restore();
    // playhead
    const pts = this.tlImgs.past.pts || [];
    const pi = clamp(Math.round((px - TLX0) / 2), 0, Math.max(0, pts.length - 1));
    line(g, px, y0 - 6, px, y0 + 92, PAL.red, 2);
    if (pts.length) glowDot(g, px, y0 + pts[pi][1], 5, PAL.red);
    // chapter strip
    const sy = y0 + 80;
    F.chapters.forEach((c, i) => {
      const xa = TLX0 + c.start / dur * (TLX1 - TLX0) + 2, xb = TLX0 + c.end / dur * (TLX1 - TLX0) - 2;
      const cur = i === chIdx, col = TONE[c.tone] || PAL.gold;
      g.fillStyle = cur ? col : i < chIdx ? rgba(PAL.gold, 0.45) : 'rgba(139,133,123,0.25)';
      g.fillRect(xa, sy, Math.max(1, xb - xa), cur ? 6 : 4);
      const lab = xb - xa > 110 ? `${c.roman}  ${c.name}` : c.roman;
      if (xb - xa > 22) text(g, lab, xa, sy + 32, { size: 16, font: xb - xa > 110 ? FONT.cn : FONT.display, color: cur ? PAL.cream : PAL.gray, maxW: xb - xa - 4 });
    });
  }

  // ---------------------------------------------------------------------------------------------
  async startRecording() {
    if (!Player.ctx || !window.MediaRecorder) { alert('当前浏览器不支持录制'); return; }
    if (!this.dest) { this.dest = Player.ctx.createMediaStreamDestination(); Player.master.connect(this.dest); }
    const tracks = [...this.cv.captureStream(60).getVideoTracks(), ...this.dest.stream.getAudioTracks()];
    const stream = new MediaStream(tracks);
    const mime = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 14e6, audioBitsPerSecond: 256e3 });
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      if (this.recording?.discard) { this.recording = null; return; }
      const blob = new Blob(chunks, { type: mime || 'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(this.A.meta.title || 'music').replace(/[\\/:*?"<>|]/g, '_')}-可视化分析.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      this.recording = null;
    };
    this.setMode('auto');
    Player.pause(); Player.seek(0);
    this.phase = 'title'; this.phaseStart = performance.now() / 1000; this.autoIntro = true;
    this.recording = { rec, t0: performance.now() / 1000, discard: false };
    rec.start(1000);
    this.recEl.hidden = false; this.el.classList.add('recording');
    this.ui.querySelector('[data-a=rec]').textContent = '■ 停止录制';
    this._state();
  }
  stopRecording(discard) {
    if (!this.recording) return;
    this.recording.discard = discard;
    try { this.recording.rec.stop(); } catch (e) { /* */ }
    if (discard) Player.pause();
    this.recEl.hidden = true; this.el.classList.remove('recording');
    this.ui.querySelector('[data-a=rec]').textContent = '● 录制视频';
  }
}
