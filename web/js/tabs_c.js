// Tabs: live visualisers (Web Audio) and export / diagnostics.
import { card, tiles, note } from './ui.js';
import { h, cssVar, SERIES, fmt, fmtTime, bisect, rgba, download, stemColor } from './util.js';
import { getLut } from './colormap.js';
import { Player } from './player.js';
import { TL } from './timeline.js';
import { url, settings } from './data.js';
import { SCENES, SCENE_LIST } from './cinema/stage.js';
import { Feed, PAL, F as FONT, text, line, rgba as rgbaC } from './cinema/fx.js';

// ------------------------------------------------------------------ immersive scene stage (cinema scenes, live)
const NEW_SCENES = ['audioring', 'particles', 'mixer', 'chordpiano', 'melody', 'beatpulse', 'stereofield', 'loudmeter', 'kaleido', 'tunnel', 'strings'];
function sceneStage(root, A, isActive) {
  const LW = 1340, LH = 790, R = { x: 70, y: 110, w: 1200, h: 640 };
  const body = card(root, '沉浸场景 · 29 种', '影院模式的全部动态场景都可以在这里单独实时播放。<b>★ 为新增场景</b>。「跟随章节」按自动编排切换，「轮播」每 12 秒换一个。', { cls: 'scene-card' });
  const bar = h('div', { class: 'scene-bar' });
  const cv = h('canvas', { class: 'scene-cv' });
  body.append(bar, cv);
  const names = Object.fromEntries(SCENE_LIST);
  const order = [...NEW_SCENES, ...SCENE_LIST.map(x => x[0]).filter(k => !NEW_SCENES.includes(k))].filter(k => SCENES[k]);
  let sel = 'audioring', cycle = false, selAt = 0, F = null, lastNow = 0;
  const mems = new Map(), mem = k => (mems.has(k) || mems.set(k, {}), mems.get(k));
  const btns = new Map();
  const mkBtn = (k, label, cls = '') => { const b = h('button', { class: 'scene-chip ' + cls, onclick: () => pick(k) }, label); btns.set(k, b); return b; };
  bar.append(mkBtn('@auto', '跟随章节', 'mode'), mkBtn('@cycle', '轮播', 'mode'), h('span', { class: 'scene-sep' }));
  for (const k of order) bar.append(mkBtn(k, (NEW_SCENES.includes(k) ? '★ ' : '') + (names[k] || SCENES[k].title).replace(/\s*[✦★]$/, ''), NEW_SCENES.includes(k) ? 'new' : ''));
  function pick(k) {
    cycle = k === '@cycle';
    sel = cycle ? (order.includes(sel) ? sel : order[0]) : k;
    selAt = performance.now() / 1000;
    for (const [kk, b] of btns) b.classList.toggle('on', kk === (cycle ? '@cycle' : sel));
  }
  pick(sel);
  new Feed(A).load().then(f => { F = f; });
  let visible = true;
  new IntersectionObserver(es => { visible = es[0].isIntersecting; }).observe(cv);

  function frame(ts) {
    if (!document.body.contains(root)) return;
    requestAnimationFrame(frame);
    if (!isActive() || !visible || !F) return;
    const now = ts / 1000, dt = Math.min(0.1, Math.max(0, now - (lastNow || now))); lastNow = now;
    const dpr = window.devicePixelRatio || 1, cw = cv.clientWidth, chh = cw * LH / LW;
    if (cv.width !== Math.round(cw * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(chh * dpr); cv.style.height = chh + 'px'; }
    const g = cv.getContext('2d'), k = cv.width / LW;
    g.setTransform(k, 0, 0, k, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    const bgG = g.createRadialGradient(LW / 2, LH * 0.45, 40, LW / 2, LH * 0.45, LW * 0.75);
    bgG.addColorStop(0, PAL.bg2); bgG.addColorStop(1, PAL.bg);
    g.fillStyle = bgG; g.fillRect(0, 0, LW, LH);
    const t = Player.time(), chs = F.chapters;
    const ci = F.chapterIdx(t), ch = chs[ci] || { start: 0, end: F.dur, roman: 'I', name: '', subtitle: '', facts: [], m: {}, scenes: [] };
    if (cycle && now - selAt > 12) { const i = order.indexOf(sel); sel = order[(i + 1) % order.length]; selAt = now; }
    let type = sel;
    if (sel === '@auto') { const s = (ch.scenes || []).find(s => t >= s.start && t < s.end) || ch.scenes?.[0]; type = s?.type || 'spectrumbars'; }
    const sc = SCENES[type];
    if (!sc) return;
    if (type !== frame.type) { frame.type = type; frame.start = now; }
    // caption
    line(g, 70, 52, 104, 52, PAL.gold, 1.5);
    const tw = text(g, sc.title, 116, 60, { size: 24, font: FONT.cn, color: PAL.goldHi, weight: 500 });
    let d = ''; try { d = sc.desc ? sc.desc({ F, ch }) : ''; } catch { }
    text(g, d ? ` · ${d}` : '', 116 + tw, 60, { size: 18, font: FONT.cn, color: PAL.gold, alpha: 0.75, maxW: LW - 330 - tw });
    text(g, `${ch.roman || ''} ${ch.name || ''}`.trim(), LW - 70, 60, { align: 'right', size: 20, font: FONT.cn, color: PAL.ink });
    g.save(); g.beginPath(); g.rect(R.x - 60, R.y - 40, R.w + 120, R.h + 70); g.clip();
    try { sc.draw(g, { t, F, R, ch, chIdx: ci, age: now - (frame.start || now), mem: mem(type), dt, now }); } catch (e) { console.warn('scene', type, e); }
    g.restore();
    // progress
    const p = F.dur ? t / F.dur : 0;
    g.fillStyle = rgbaC(PAL.gold, 0.15); g.fillRect(70, LH - 14, LW - 140, 2);
    g.fillStyle = PAL.gold; g.fillRect(70, LH - 14, (LW - 140) * p, 2);
  }
  requestAnimationFrame(frame);
}

function fitCanvas(cv, hgt) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); cv.style.height = hgt + 'px';
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, hgt];
}

export function live(root, A, isActive) {
  root.append(h('div', { class: 'tab-title' }, '实时可视化'), h('div', { class: 'tab-sub' }, '播放时实时显示 29 种沉浸场景、频谱、瀑布图、矢量示波器和电平表，并同步显示当前段落 / 和弦 / 小节。按空格播放。'));
  const now = h('div', { class: 'live-now' });
  const mk = l => { const v = h('div', { class: 'v' }, '–'), s = h('div', { class: 's' }, ''); now.append(h('div', { class: 'tile' }, h('div', { class: 'l' }, l), v, s)); return [v, s]; };
  const [secV, secS] = mk('段落'), [chV, chS] = mk('和弦'), [keyV] = mk('调性'), [barV, barS] = mk('小节 . 拍'), [bpmV] = mk('局部 BPM');
  root.append(now);
  sceneStage(root, A, isActive);

  const gridEl = h('div', { class: 'live-grid' }); root.append(gridEl);
  const c1 = card(gridEl, '频谱分析仪', '对数频率，带峰值保持。');
  const spec = h('canvas', { class: 'live' }); c1.append(spec);
  const c2 = card(gridEl, '电平表 / 相关度', 'Peak + RMS (dBFS)，下方为相位相关度。');
  const meters = h('div', { class: 'meters' });
  const mkM = lab => { const rms = h('div', { class: 'rms' }), pk = h('div', { class: 'pk' }); meters.append(h('div', { class: 'm' }, h('div', { class: 'track' }, rms, pk), h('div', { class: 'lab' }, lab))); return [rms, pk]; };
  const [lr, lp] = mkM('L'), [rr, rp] = mkM('R');
  c2.append(meters);
  const corrBar = h('canvas', { class: 'live' }); c2.append(corrBar);
  const valTxt = h('div', { class: 'note' }); c2.append(valTxt);

  const grid2 = h('div', { class: 'live-grid' }); root.append(grid2);
  const c3 = card(grid2, '瀑布频谱图', '最近约 8 秒的滚动语谱图。');
  const fall = h('canvas', { class: 'live' }); c3.append(fall);
  const c4 = card(grid2, '矢量示波器 (Goniometer)', '竖线 = 单声道；向左/右倾斜 = 偏左/偏右；水平展开 = 宽/反相。');
  const gon = h('canvas', { class: 'live' }); c4.append(gon);
  const c5 = card(root, '环形可视化', '外环 = 频谱；中心随节拍脉动（使用分析得到的拍点，强拍更大）。');
  const ring = h('canvas', { class: 'live' }); c5.append(ring);

  const fbin = new Float32Array(4096);
  const tdL = new Float32Array(2048), tdR = new Float32Array(2048);
  const peaks = new Float32Array(128);
  const NB = 96;
  const edges = Array.from({ length: NB + 1 }, (_, i) => 20 * Math.pow(1000, i / NB));
  let fallCv = null;
  const H = A.harmony || {}, R = A.rhythm || {}, segs = A.structure?.segments || [];
  const chords = H.chords || [];
  const ks = H.key_segments || [];
  let lastBeatIdx = -1, pulse = 0, pulseDown = false;
  let pkL = 0, pkR = 0;

  function bandVals() {
    const an = Player.analyser; if (!an) return null;
    an.getFloatFrequencyData(fbin);
    const sr = Player.ctx.sampleRate, n = an.frequencyBinCount;
    const out = new Float32Array(NB);
    for (let b = 0; b < NB; b++) {
      const i0 = Math.floor(edges[b] / (sr / 2) * n), i1 = Math.max(i0 + 1, Math.ceil(edges[b + 1] / (sr / 2) * n));
      let m = -140; for (let i = i0; i < i1 && i < n; i++) m = Math.max(m, fbin[i]);
      out[b] = m;
    }
    return out;
  }

  function frame() {
    if (!document.body.contains(root)) return;
    requestAnimationFrame(frame);
    if (!isActive()) return;
    const t = TL.playhead;
    // ---- now playing
    const sg = segs.find(s => t >= s.start && t < s.end);
    secV.textContent = sg ? sg.label : '–'; secS.textContent = sg?.hint || '';
    const ci = chords.findIndex(c => t >= c.start && t < c.end);
    chV.textContent = ci >= 0 ? (chords[ci].label === 'N' ? 'N.C.' : chords[ci].label) : '–';
    chS.textContent = ci >= 0 ? `${chords[ci].roman}  → 下一个 ${chords[ci + 1]?.label ?? ''}` : '';
    const kk = ks.find(k => t >= k.start && t < k.end); keyV.textContent = kk ? kk.name_cn : (H.key?.name_cn || '–');
    const bi = bisect(R.beats || [], t + 1e-3) - 1;
    const bars = R.bars || [];
    const bari = bars.findIndex(b => t >= b[0] && t < b[1]);
    barV.textContent = bari >= 0 && bi >= 0 ? `${bari + 1} . ${R.beat_pos[bi] || 1}` : '–';
    barS.textContent = fmtTime(t, 1);
    const lbIdx = bisect(R.local_bpm?.t || [], t);
    bpmV.textContent = R.local_bpm?.v?.[Math.min(lbIdx, (R.local_bpm.v.length || 1) - 1)] != null ? fmt(R.local_bpm.v[Math.min(lbIdx, R.local_bpm.v.length - 1)], 1) : fmt(R.bpm, 1);
    if (bi !== lastBeatIdx && bi >= 0) { if (Player.playing) { pulse = 1; pulseDown = R.beat_pos[bi] === 1; } lastBeatIdx = bi; }
    pulse *= 0.9;

    const bands = bandVals();
    // ---- spectrum bars
    {
      const [ctx, W, Hh] = fitCanvas(spec, 230);
      ctx.clearRect(0, 0, W, Hh);
      const bw = W / NB;
      const col = cssVar('--s1');
      ctx.fillStyle = cssVar('--grid');
      for (const db of [-20, -40, -60, -80]) { const y = Hh * (-db - 10) / 90; ctx.fillRect(0, y, W, 1); }
      ctx.fillStyle = cssVar('--muted'); ctx.font = '10px system-ui';
      for (const f of [50, 100, 500, 1000, 5000, 10000]) { const x = W * Math.log(f / 20) / Math.log(1000); ctx.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 2, Hh - 3); }
      if (bands) for (let b = 0; b < NB; b++) {
        const v = Math.max(0, Math.min(1, (bands[b] + 100) / 90));
        peaks[b] = Math.max(v, peaks[b] - 0.008);
        ctx.fillStyle = col; ctx.globalAlpha = 0.85;
        ctx.fillRect(b * bw + 1, Hh * (1 - v), bw - 2, Hh * v);
        ctx.globalAlpha = 1; ctx.fillStyle = cssVar('--ink');
        ctx.fillRect(b * bw + 1, Hh * (1 - peaks[b]), bw - 2, 2);
      }
    }
    // ---- waterfall
    if (bands) {
      const [ctx, W, Hh] = fitCanvas(fall, 230);
      if (!fallCv || fallCv.width !== Math.round(W)) { fallCv = document.createElement('canvas'); fallCv.width = Math.round(W); fallCv.height = NB; }
      const fc = fallCv.getContext('2d');
      if (Player.playing) {
        fc.drawImage(fallCv, -2, 0);
        const lut = getLut(settings.cmap);
        for (let b = 0; b < NB; b++) {
          const v = Math.max(0, Math.min(255, Math.round((bands[b] + 100) / 90 * 255)));
          fc.fillStyle = `rgb(${lut[v * 3]},${lut[v * 3 + 1]},${lut[v * 3 + 2]})`;
          fc.fillRect(fallCv.width - 2, NB - 1 - b, 2, 1);
        }
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(fallCv, 0, 0, W, Hh);
    }
    // ---- goniometer + meters
    if (Player.anL) {
      Player.anL.getFloatTimeDomainData(tdL); Player.anR.getFloatTimeDomainData(tdR);
      let sl = 0, sr = 0, slr = 0, pl = 0, pr = 0;
      for (let i = 0; i < tdL.length; i++) { const l = tdL[i], r = tdR[i]; sl += l * l; sr += r * r; slr += l * r; pl = Math.max(pl, Math.abs(l)); pr = Math.max(pr, Math.abs(r)); }
      const rmsL = Math.sqrt(sl / tdL.length), rmsR = Math.sqrt(sr / tdR.length);
      const corr = sl > 1e-9 && sr > 1e-9 ? slr / Math.sqrt(sl * sr) : 0;
      pkL = Math.max(pl, pkL * 0.97); pkR = Math.max(pr, pkR * 0.97);
      const toPct = x => Math.max(0, Math.min(100, (20 * Math.log10(Math.max(x, 1e-6)) + 60) / 60 * 100));
      lr.style.height = toPct(rmsL) + '%'; rr.style.height = toPct(rmsR) + '%';
      lp.style.bottom = toPct(pkL) + '%'; rp.style.bottom = toPct(pkR) + '%';
      valTxt.textContent = `L ${fmt(20 * Math.log10(pkL + 1e-9), 1)} / R ${fmt(20 * Math.log10(pkR + 1e-9), 1)} dBFS · 相关度 ${fmt(corr, 2)}`;
      {
        const [ctx, W, Hh] = fitCanvas(corrBar, 26);
        ctx.clearRect(0, 0, W, Hh);
        ctx.fillStyle = cssVar('--surface-3'); ctx.fillRect(0, 8, W, 10);
        ctx.fillStyle = corr < 0 ? cssVar('--critical') : cssVar('--good');
        const x = W / 2 + corr * W / 2; ctx.fillRect(Math.min(W / 2, x), 8, Math.abs(x - W / 2), 10);
        ctx.fillStyle = cssVar('--muted'); ctx.font = '10px system-ui'; ctx.fillText('−1', 2, 6); ctx.fillText('+1', W - 14, 6);
      }
      const [ctx, W, Hh] = fitCanvas(gon, 230);
      ctx.fillStyle = rgba(cssVar('--surface-2'), 0.35); ctx.fillRect(0, 0, W, Hh);
      const cx = W / 2, cy = Hh / 2, sc = Math.min(W, Hh) * 0.45;
      ctx.strokeStyle = cssVar('--grid'); ctx.beginPath();
      ctx.moveTo(cx, cy - sc); ctx.lineTo(cx, cy + sc); ctx.moveTo(cx - sc, cy); ctx.lineTo(cx + sc, cy);
      ctx.moveTo(cx - sc * 0.7, cy - sc * 0.7); ctx.lineTo(cx + sc * 0.7, cy + sc * 0.7); ctx.moveTo(cx + sc * 0.7, cy - sc * 0.7); ctx.lineTo(cx - sc * 0.7, cy + sc * 0.7); ctx.stroke();
      ctx.fillStyle = SERIES(2);
      const g = 1 / Math.max(0.05, Math.max(pkL, pkR));
      for (let i = 0; i < tdL.length; i += 2) {
        const l = tdL[i] * g, r = tdR[i] * g;
        const x = (r - l) * 0.7071, y = (l + r) * 0.7071; // rotate 45°: L upper-left, R upper-right
        ctx.fillRect(cx + x * sc, cy - y * sc, 1.5, 1.5);
      }
      ctx.fillStyle = cssVar('--muted'); ctx.font = '11px system-ui'; ctx.fillText('L', cx - sc * 0.72 - 10, cy - sc * 0.72); ctx.fillText('R', cx + sc * 0.72 + 4, cy - sc * 0.72); ctx.fillText('M', cx + 4, cy - sc + 10);
    }
    // ---- ring
    if (bands) {
      const [ctx, W, Hh] = fitCanvas(ring, 360);
      ctx.clearRect(0, 0, W, Hh);
      const cx = W / 2, cy = Hh / 2, r0 = 70 + pulse * (pulseDown ? 22 : 10);
      const n = NB;
      for (let k = 0; k < n * 2; k++) {
        const b = k < n ? k : 2 * n - 1 - k;
        const v = Math.max(0, Math.min(1, (bands[b] + 100) / 90));
        const a = -Math.PI / 2 + k / (n * 2) * Math.PI * 2;
        const len = 8 + v * 100;
        ctx.strokeStyle = SERIES(b < n / 3 ? 0 : b < 2 * n / 3 ? 6 : 4); ctx.globalAlpha = 0.35 + 0.65 * v; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = pulseDown ? SERIES(1) : SERIES(0); ctx.globalAlpha = 0.25 + 0.6 * pulse;
      ctx.beginPath(); ctx.arc(cx, cy, r0 - 8, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = cssVar('--ink'); ctx.font = '600 20px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(chV.textContent, cx, cy - 8);
      ctx.font = '12px system-ui'; ctx.fillStyle = cssVar('--ink-2'); ctx.fillText(barV.textContent, cx, cy + 14);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
  }
  requestAnimationFrame(frame);
}

export function exportTab(root, A) {
  root.append(h('div', { class: 'tab-title' }, '导出与诊断'), h('div', { class: 'tab-sub' }, '下载分析数据、音频和 MIDI；查看各步骤耗时与错误信息、算法说明。'));
  const dl = card(root, '下载', '', { png: false });
  const btn = (label, href, name, cls = 'btn') => h('a', { class: cls, href, download: name, style: { marginRight: '8px', display: 'inline-block', marginBottom: '6px' } }, label);
  dl.append(h('div', {},
    btn('analysis.json（全部分析数据）', url('analysis.json'), `${A.meta.title || 'analysis'}.json`, 'btn primary'),
    btn('原曲 FLAC', url(A.audio.mix), 'mix.flac'),
    A.transcription?.midi ? btn('多轨 MIDI', url(A.transcription.midi), 'transcription.mid') : null,
    ...(A.stems?.items || []).map(s => btn(`${s.label.split(' ')[0]} FLAC`, url(s.file), `${s.name}.flac`))));
  const txt = [
    `# ${A.meta.title}`, '', ...(A.summary || []).map(s => `- ${s}`), '',
    '## 和弦谱', ...(A.harmony?.lead_sheet || []).reduce((rows, bar, i) => { if (i % 4 === 0) rows.push([]); rows[rows.length - 1].push(bar.join(' ')); return rows; }, []).map(r => '| ' + r.join(' | ') + ' |'),
    '', '## 段落', ...(A.structure?.segments || []).map(s => `- ${s.label} ${s.hint || ''} ${fmtTime(s.start, 0)}–${fmtTime(s.end, 0)} 和弦: ${(s.top_chords || []).join(' ')}`),
  ].join('\n');
  dl.append(h('div', { style: { marginTop: '10px' } },
    h('button', { class: 'btn', onclick: e => { navigator.clipboard.writeText(txt); e.target.textContent = '已复制 ✓'; } }, '复制文字报告 (Markdown)'),
    h('button', { class: 'btn', style: { marginLeft: '8px' }, onclick: () => download(URL.createObjectURL(new Blob([txt], { type: 'text/markdown' })), `${A.meta.title || 'report'}.md`) }, '下载报告 .md')));

  const g = h('div', { class: 'grid g2' }); root.append(g);
  const tm = card(g, '处理耗时', `设备：${A.device} · 创建于 ${A.created}`, { png: false });
  const tb = h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, '步骤'), h('th', {}, '秒')));
  for (const [k, v] of Object.entries(A.timings || {})) tb.append(h('tr', {}, h('td', {}, k), h('td', {}, String(v))));
  tm.append(tb);
  const er = card(g, '错误 / 警告', '', { png: false });
  const errs = Object.entries(A.errors || {});
  if (!errs.length) er.append(h('div', { class: 'muted' }, '所有步骤均成功完成 ✓'));
  for (const [k, v] of errs) er.append(h('div', { class: 'errbox' }, h('b', {}, k), h('pre', {}, v)));

  const md = card(root, '算法说明', '', { png: false });
  md.append(h('ul', { class: 'summary' }, [
    '响度：ITU-R BS.1770-4 K 加权，门限积分响度 / LRA (EBU Tech 3342)，真峰值 4× 过采样。',
    '频谱：44.1 kHz STFT (4096 点) 映射到 480 个对数频带；梅尔频谱 128 带；CQT 每八度 36 格 (C1–C8)。',
    '节拍：Beat This! (Foscarin et al., ISMIR 2024) Transformer 模型输出拍点与强拍；拍号由每小节拍数众数确定。',
    '乐器分离：Demucs v4 Hybrid Transformer (Rouard et al., 2023)，htdemucs_6s 输出 6 轨。',
    '调性：Krumhansl-Kessler 调性轮廓相关；局部调性为 8 小节滑窗。',
    '和弦：去人声/鼓后的 CQT 色度，拍同步，10 种和弦类型 × 12 根音模板匹配，贝斯分轨辅助根音/转位判断，Viterbi 平滑。',
    '结构：拍同步 CQT 递归矩阵 + MFCC 路径相似度的拉普拉斯谱聚类 (McFee & Ellis, ISMIR 2014)，Foote 棋盘核新颖度。',
    '旋律：pYIN 概率 YIN 基频估计；复音转录：Spotify basic-pitch (Bittner et al., ICASSP 2022)。',
    '鼓组：鼓分轨的分频段频谱通量起音检测（底鼓 30–130 Hz、军鼓 160–2500 Hz + 噪声、镲片 6–11 kHz），量化到 16 分网格。',
    '特征雷达 / 情绪象限：基于上述测量的启发式组合，不是训练好的情绪模型。',
  ].map(s => h('li', {}, s))));
}
