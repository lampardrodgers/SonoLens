// 3D 声河 tab: the WebGL2 flythrough as its own full-width page (not part of cinema mode).
// Renders the river3d scene into a 1920×1080 canvas, follows the player, has its own fullscreen bar.
import { h, fmtTime } from './util.js';
import { Player } from './player.js';
import { TL } from './timeline.js';
import { Feed, PAL, F as FONT, text } from './cinema/fx.js';
import { river3d } from './cinema/river3d.js';

const HAS_GL = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
const LW = 1920, LH = 1080, R = { x: 60, y: 40, w: LW - 120, h: LH - 70 };

export function fly(root, A, isActive) {
  root.append(
    h('div', { class: 'tab-title' }, '3D 声河 · 一镜到底'),
    h('div', { class: 'tab-sub' }, '整首歌变成一条峡谷里的河：时间是纵深（未来迎面而来），两岸山壁是频谱，河道是各乐器（宽度 = 能量），光线是人声旋律，雾色随张力变暖，拱门是段落，光柱是终止式。镜头按段落角色自动运镜。按空格播放，点击画面也可以播放/暂停。'));

  const cv = h('canvas', { class: 'fly-cv', title: '点击播放 / 暂停' });
  cv.onclick = () => Player.toggle();
  const play = h('button', { class: 'scene-fs-btn play', title: '播放/暂停（空格）', onclick: () => Player.toggle() }, '▶');
  const cur = h('span', { class: 'scene-fs-time' }, '0:00'), dur = h('span', { class: 'scene-fs-time' }, fmtTime(A.meta.duration, 0));
  const fill = h('div', { class: 'scene-fs-fill' }), ticks = h('div', { class: 'scene-fs-ticks' });
  const track = h('div', { class: 'scene-fs-track', title: '点击或拖动跳转' }, ticks, fill);
  const seekAt = e => { const r = track.getBoundingClientRect(), d = Player.duration() || A.meta.duration; if (d) Player.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d); };
  track.addEventListener('pointerdown', e => { track.setPointerCapture(e.pointerId); seekAt(e); track.onpointermove = seekAt; });
  track.addEventListener('pointerup', () => { track.onpointermove = null; });
  const chap = h('span', { class: 'fly-chap' }, '');
  const fsBtn = h('button', { class: 'scene-fs-btn', title: '全屏（F）', onclick: () => toggleFs() }, '⛶ 全屏');
  const bar = h('div', { class: 'fly-bar' }, play, cur, track, dur, chap, fsBtn);
  const wrap = h('div', { class: 'fly-wrap' }, cv, bar);
  root.append(wrap);
  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : wrap.requestFullscreen?.())?.catch?.(() => {});
  document.addEventListener('fullscreenchange', () => { fsBtn.textContent = document.fullscreenElement === wrap ? '✕ 退出全屏' : '⛶ 全屏'; });
  window.addEventListener('keydown', e => {
    if (!isActive() || e.target.closest?.('input,textarea,select')) return;
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFs(); }
  });

  let F = null, mem = {}, lastNow = 0, visible = true;
  new IntersectionObserver(es => { visible = es[0].isIntersecting; }).observe(wrap);
  new Feed(A).load().then(f => {
    F = f;
    ticks.replaceChildren(...(F.chapters || []).filter(c => c.start > 0.5)
      .map(c => h('i', { style: `left:${(c.start / F.dur) * 100}%`, title: `${c.roman || ''} ${c.name || ''}` })));
  });

  function fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const fs = document.fullscreenElement === wrap;
    let cw = wrap.clientWidth;
    cw = Math.min(cw, Math.max(420, (window.innerHeight - (fs ? bar.offsetHeight : 400)) * LW / LH));
    const ch = cw * LH / LW;
    if (cv.width !== Math.round(cw * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
    cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
    const g = cv.getContext('2d'), k = cv.width / LW;
    g.setTransform(k, 0, 0, k, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.fillStyle = PAL.bg; g.fillRect(0, 0, LW, LH);
    return g;
  }

  function frame(ts) {
    if (!document.body.contains(root)) return;
    requestAnimationFrame(frame);
    const t = Player.time ? Player.time() : TL.playhead, d = Player.duration?.() || A.meta.duration;
    fill.style.width = (d ? Math.min(100, t / d * 100) : 0) + '%';
    cur.textContent = fmtTime(t, 0);
    const pl = Player.playing ? '❚❚' : '▶'; if (play.textContent !== pl) play.textContent = pl;
    if (!isActive() || !visible || !F) return;
    const now = ts / 1000, dt = Math.min(0.1, Math.max(0, now - (lastNow || now))); lastNow = now;
    const ci = F.chapterIdx(t), ch = F.chapters[ci] || { start: 0, end: F.dur, role: 'build', name: '' };
    const lab = `${ch.roman || ''} ${ch.name || ''}`.trim(); if (chap.textContent !== lab) chap.textContent = lab;
    const g = fit();
    try { river3d.draw(g, { t, F, R, ch, chIdx: ci, age: now, dt, now, mem }); } catch (e) { console.warn('river3d', e); }
    if (HAS_GL && !Player.playing && t < 0.05) {
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, LW, LH);
      text(g, '▶  点击画面或按空格开始', LW / 2, LH / 2, { align: 'center', size: 40, font: FONT.cn, color: PAL.cream, glow: 'rgba(0,0,0,0.9)', blur: 12 });
    }
  }
  requestAnimationFrame(frame);
}
