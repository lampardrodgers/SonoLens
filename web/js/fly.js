// Full-width scene pages: one cinema scene rendered into a 1920×1080 canvas that follows the player and has
// its own transport bar + fullscreen (流光 and the 3D 声河 flythrough).
import { h, fmtTime } from './util.js';
import { Player } from './player.js';
import { TL } from './timeline.js';
import { Feed, PAL, F as FONT, text } from './cinema/fx.js';
import { river3d } from './cinema/river3d.js';
import { aura } from './cinema/aura.js';

const HAS_GL = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
const LW = 1920, LH = 1080, R = { x: 60, y: 40, w: LW - 120, h: LH - 70 };

const FLY = {
  scene: river3d, title: '3D 声河 · 一镜到底',
  sub: '整首歌变成一条峡谷里的河：时间是纵深（未来迎面而来），两岸山壁是频谱，河道是各乐器（宽度 = 能量），光线是人声旋律，雾色随张力变暖，拱门是段落，光柱是终止式。镜头按段落角色自动运镜。按空格播放，点击画面也可以播放/暂停。',
};
export const fly = (root, A, isActive) => scenePage(root, A, isActive, FLY);

/** A cinema scene as its own full-width page: 1920×1080 canvas, transport bar, fullscreen.
 *  opts: { scene, title, sub, hud (adds a 标注 on/off toggle, key H), legend: [[name, meaning], …] } */
export function scenePage(root, A, isActive, opts) {
  const scene = opts.scene;
  root.append(h('div', { class: 'tab-title' }, opts.title), h('div', { class: 'tab-sub' }, opts.sub));

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
  let hud = localStorage.getItem('mv.sceneHud') !== '0';
  const hudBtn = opts.hud ? h('button', { class: 'scene-fs-btn', title: '显示 / 隐藏文字标注（H）', onclick: () => toggleHud() }, '') : null;
  const toggleHud = () => { hud = !hud; localStorage.setItem('mv.sceneHud', hud ? '1' : '0'); syncHud(); };
  const syncHud = () => { if (hudBtn) hudBtn.textContent = hud ? '标注 · 开' : '标注 · 关'; };
  syncHud();
  const bar = h('div', { class: 'fly-bar' }, play, cur, track, dur, chap, hudBtn, fsBtn);
  const wrap = h('div', { class: 'fly-wrap' }, cv, bar);
  root.append(wrap);
  if (opts.legend) root.append(h('div', { class: 'fly-legend' }, ...opts.legend.map(([k, v]) => h('div', {}, h('b', {}, k), v))));
  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : wrap.requestFullscreen?.())?.catch?.(() => {});
  document.addEventListener('fullscreenchange', () => { fsBtn.textContent = document.fullscreenElement === wrap ? '✕ 退出全屏' : '⛶ 全屏'; });
  window.addEventListener('keydown', e => {
    if (!isActive() || e.target.closest?.('input,textarea,select')) return;
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFs(); }
    else if (opts.hud && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); toggleHud(); }
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
    // what you see should match what you hear: the audio clock runs ahead of the speakers by the output latency
    const lat = Player.playing ? Math.min(0.35, Player.ctx?.outputLatency || 0) : 0;
    const t = Player.time ? Math.max(0, Player.time() - lat) : TL.playhead, d = Player.duration?.() || A.meta.duration;
    fill.style.width = (d ? Math.min(100, t / d * 100) : 0) + '%';
    cur.textContent = fmtTime(t, 0);
    const pl = Player.playing ? '❚❚' : '▶'; if (play.textContent !== pl) play.textContent = pl;
    if (!isActive() || !visible || !F) return;
    const now = ts / 1000, dt = Math.min(0.1, Math.max(0, now - (lastNow || now))); lastNow = now;
    const ci = F.chapterIdx(t), ch = F.chapters[ci] || { start: 0, end: F.dur, role: 'build', name: '' };
    const lab = `${ch.roman || ''} ${ch.name || ''}`.trim(); if (chap.textContent !== lab) chap.textContent = lab;
    const g = fit();
    try { scene.draw(g, { t, F, R, ch, chIdx: ci, age: now, dt, now, mem, hud }); } catch (e) { console.warn('scene page', e); }
    if (HAS_GL && !Player.playing && t < 0.05) {
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, LW, LH);
      text(g, '▶  点击画面或按空格开始', LW / 2, LH / 2, { align: 'center', size: 40, font: FONT.cn, color: PAL.cream, glow: 'rgba(0,0,0,0.9)', blur: 12 });
    }
  }
  requestAnimationFrame(frame);
}

const AURA = {
  scene: aura, title: '流光 · 音乐心象', hud: true,
  sub: '把正在播放的音乐实时画成一幅流动的星云：颜色是氛围与和声，形状是和弦与节奏，流动的方式随段落和这首歌自己的风格而变。按空格播放，H 隐藏文字标注，F 全屏。',
  legend: [
    ['星云底色 · 氛围', '大调偏暖、小调偏冷，能量越高越亮，和声张力越大越偏向绯红；每一拍都有一圈涟漪从中心荡开。'],
    ['12 个方向 · 音级', '按五度圈排列，每个音一种固定颜色。正在响的音会长出花瓣、射出直达画面边缘的光柱——亮起的那半圈就是当前调性。'],
    ['离中心的距离 · 音高', '越靠外音越高。每个音都拖着彗尾并洒出火花；白色彗星是人声旋律，绕着核心的光团是贝斯。'],
    ['多边形 · 和弦', '把当前和弦的几个音连起来，白圈是根音。换和弦时有一圈根音颜色的光晕绽开；左下角是和弦名、级数和接下来的走向。'],
    ['星座 · 流星 · 金环', '正在响的几个最强音按音高连成星座；每句人声开口时有一颗流星划过外侧夜空；终止式出现时表盘边缘亮起一圈金色光环；绕着表盘跑的小彗星每小节正好一圈。'],
    ['冲击环 · 光冠 · 星点', '底鼓把整幅画向外推并放出冲击环和火花，军鼓让光冠和横向光芒闪一下，镲片让星野闪烁；核心外的弧段在数拍子。只有换段和每个乐句里最重的那一下，画面才会震一下并荡开一圈扭曲整幅画的大波纹；紧张或响亮的段落里，军鼓还会从核心向最响的音打出闪电。'],
    ['莲花纹 · 频段', '核心外三圈花瓣分别跟着低、中、高频呼吸，花瓣数随段落变化。'],
    ['流场 · 段落', '每类段落有自己的流动方式：安静处「流动」，过渡处「旋涡」或「绽放」，最响的段落「奔涌」；换段时有一次大的光波。'],
    ['外侧弧线 · 乐器', '表盘之外每件乐器一条轨道，演奏得越响，弧线越长越亮（颜色与右下角的分轨电平一致）。'],
    ['外环 · 全曲进度', '一圈就是整首歌，按段落分色，白点是现在，金色小刻度是终止式。'],
    ['色调 · 这首歌', '整体色调由音乐决定：调性的主音给星云染色，情绪明亮、音色偏暗的歌偏琥珀暖色，情绪低沉、音色明亮的歌偏冷蓝；越有能量和律动颜色越浓，越安静越淡雅。'],
    ['质感 · 风格', '律动清晰、打击感强的音乐呈现硬朗的几何和短拖尾；旋律和声主导的音乐像墨在水里慢慢散开。'],
  ],
};
export const auraPage = (root, A, isActive) => scenePage(root, A, isActive, AURA);
