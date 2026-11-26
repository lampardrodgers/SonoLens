// Tabs: overview, loudness, spectrum, rhythm, drums.
import { TimeChart, StaticChart, roundRect } from './chart.js';
import { barChart, xyChart, radarChart } from './static.js';
import { card, tiles, legend, kv, note, unavailable, sectionColor, funcColor, FUNC } from './ui.js';
import { h, SERIES, cssVar, fmt, fmtTime, stemColor, clamp, inkOn } from './util.js';
import { TL } from './timeline.js';

const S = i => SERIES(i);

export function sectionLayer(A, rect, opts = {}) {
  const segs = A.structure?.segments || [];
  return {
    type: 'segments', rect, name: '段落', font: opts.font || 11,
    items: segs.map(s => ({ start: s.start, end: s.end, label: s.label + (opts.hint && s.hint ? ' ' + s.hint.split(' ')[0] : ''),
      color: sectionColor(s.label), tip: `${s.label} · ${s.hint || ''} (${fmtTime(s.start, 0)}–${fmtTime(s.end, 0)})` })),
  };
}
export function chordLayer(A, rect, roman = false) {
  return {
    type: 'segments', rect, name: roman ? '级数' : '和弦', font: 11,
    items: (A.harmony?.chords || []).map(c => ({ start: c.start, end: c.end, label: roman ? c.roman : (c.label === 'N' ? '' : c.label),
      color: funcColor(c.function), tip: `${c.label} · ${c.roman} · ${FUNC[c.function]?.label || ''}` })),
  };
}
export function downbeatLayer(A, opts = {}) {
  const db = (A.rhythm?.bars || []).map(b => b[0]);
  return { type: 'markers', times: db, color: cssVar('--ink-2'), alpha: opts.alpha ?? 0.25, minPx: 6,
    labels: opts.labels ? (i => String(i + 1)) : null };
}

// ================================================================== OVERVIEW
export function overview(root, A) {
  const m = A.meta, R = A.rhythm || {}, H = A.harmony || {}, L = A.loudness || {};
  root.append(h('div', { class: 'tab-title' }, m.title || m.file_name),
    h('div', { class: 'tab-sub' }, [m.artist, m.album, m.codec, m.sample_rate && `${m.sample_rate} Hz`, m.bit_rate && `${Math.round(m.bit_rate / 1000)} kbps`,
      m.orig_channels === 1 ? '单声道' : '立体声'].filter(Boolean).join(' · ')));
  const chs = A.story?.chapters || [];
  if (chs.length) {
    const bn = h('div', { class: 'cin-banner', title: '进入影院模式' },
      h('div', { class: 'play' }, '▶'),
      h('div', {},
        h('div', { class: 'tt' }, '影院模式 · 逐章讲述这首歌'),
        h('div', { class: 'ss' }, `${chs.length} 个章节 · 18 种动态可视化 · 自动解说 · 可一键录制为视频`),
        h('div', { class: 'chs' }, chs.map(c => h('span', {}, h('b', {}, c.roman), c.name)))));
    bn.onclick = () => { location.hash = `#/a/${A.id}/cinema`; };
    root.append(bn);
  }
  tiles(root, [
    { l: '速度 Tempo', v: `${fmt(R.bpm, 1)}<small>BPM</small>`, s: R.bpm_candidates?.slice(1, 3).map(c => `${c[0]}`).join(' / ') ? `候选 ${R.bpm_candidates.slice(1, 3).map(c => c[0]).join(' / ')}` : '' },
    { l: '调性 Key', v: H.key?.name_cn || '–', s: H.key ? `${H.key.name} · 置信度 ${fmt(H.key.confidence, 2)}` : '' },
    { l: '拍号 Meter', v: R.time_signature || '–', s: R.n_bars ? `${R.n_bars} 小节` : '' },
    { l: '时长', v: fmtTime(m.duration, 0), s: `${(R.beats || []).length} 拍` },
    { l: '综合响度', v: `${fmt(L.integrated_lufs, 1)}<small>LUFS</small>`, s: `LRA ${fmt(L.lra, 1)} LU` },
    { l: '真峰值', v: `${fmt(L.true_peak_dbtp, 1)}<small>dBTP</small>`, s: `PLR ${fmt(L.plr_db, 1)} dB` },
    { l: '和弦', v: `${H.chord_stats?.unique ?? '–'}<small>种</small>`, s: `${(H.chords || []).filter(c => c.label !== 'N').length} 次变化` },
    { l: '段落', v: `${A.structure?.segments?.length ?? '–'}<small>段</small>`, s: `${A.structure?.n_clusters ?? '–'} 类` },
  ]);

  const g0 = h('div', { class: 'grid g2' }); root.append(g0);
  const sum = card(g0, '自动分析摘要', '由各项分析结果自动生成的文字总结。', { png: false });
  sum.append(h('ul', { class: 'summary' }, (A.summary || []).map(s => h('li', {}, s))));
  const rd = card(g0, '音乐特征雷达', '0–100 的启发式指标（非机器学习模型），用于快速对比不同曲目。悬停查看计算依据。');
  if (A.descriptors) radarChart(rd, { axes: A.descriptors.map(d => ({ label: d.label.split(' ')[0], value: d.value, desc: d.desc })), height: 290 });

  const ov = card(root, '全曲概览', '上：段落（自动聚类，字母相同=相似段落）；中：波形；下：和弦（颜色=和声功能）。点击任意图表跳转播放，⌘/Ctrl+滚轮缩放，横向滚动/拖拽平移，双击复位。');
  legend(ov, Object.entries(FUNC).filter(([k]) => k !== 'N').map(([k, f]) => ({ label: f.label, color: funcColor(k) })));
  new TimeChart(ov, {
    height: 230, timeAxis: true, noGrid: true,
    layers: [
      sectionLayer(A, [0, 0.16], { hint: true }),
      { type: 'waveform', wave: L.waveform, mode: 'mono', color: S(0), rect: [0.18, 0.74], alpha: 0.85 },
      downbeatLayer(A, { alpha: 0.12 }),
      chordLayer(A, [0.76, 1]),
    ],
  });

  const g1 = h('div', { class: 'grid g2' }); root.append(g1);
  const mood = card(g1, '情绪象限 (Valence × Energy)', '横轴=情绪正向（大小调/速度/亮度），纵轴=能量。基于启发式指标，仅供参考。');
  const d = Object.fromEntries((A.descriptors || []).map(x => [x.key, x.value]));
  new StaticChart(mood, {
    height: 260,
    draw(ctx, W, Hh) {
      const s = Math.min(W - 40, Hh - 30), x0 = (W - s) / 2, y0 = 6;
      ctx.strokeStyle = cssVar('--axis'); ctx.strokeRect(x0 + 0.5, y0 + 0.5, s, s);
      ctx.strokeStyle = cssVar('--grid'); ctx.beginPath(); ctx.moveTo(x0 + s / 2, y0); ctx.lineTo(x0 + s / 2, y0 + s); ctx.moveTo(x0, y0 + s / 2); ctx.lineTo(x0 + s, y0 + s / 2); ctx.stroke();
      ctx.font = '12px system-ui'; ctx.fillStyle = cssVar('--muted'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('紧张 / 激烈', x0 + s / 4, y0 + 14); ctx.fillText('欢快 / 兴奋', x0 + 3 * s / 4, y0 + 14);
      ctx.fillText('悲伤 / 低沉', x0 + s / 4, y0 + s - 14); ctx.fillText('平静 / 温暖', x0 + 3 * s / 4, y0 + s - 14);
      ctx.fillText('情绪正向 →', x0 + s / 2, y0 + s + 14);
      const x = x0 + s * clamp(d.valence ?? 0.5, 0, 1), y = y0 + s * (1 - clamp(d.energy ?? 0.5, 0, 1));
      ctx.fillStyle = S(0); ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fill();
      ctx.strokeStyle = cssVar('--surface'); ctx.lineWidth = 2; ctx.stroke();
    },
  });
  const en = card(g1, '能量曲线', '短期响度 (Short-term LUFS, 3 秒窗)：反映全曲的起伏与高潮位置。');
  new TimeChart(en, {
    height: 230, y: { min: -40, max: 0 }, yLabel: 'LUFS',
    layers: [sectionLayer(A, [0, 0.08]), { type: 'line', series: L.short_term, color: S(0), fill: -40, name: '短期响度', unit: 'LUFS', dec: 1 }],
  });

  if (A.stems?.items) {
    const st = A.stems.items;
    const ar = card(root, '编曲密度图 (Arrangement Map)', '每一格 = 一个小节，颜色深浅 = 该乐器在这一小节的能量。可一眼看出乐器何时进入/退出、哪里是编曲最满的地方。');
    new TimeChart(ar, {
      height: 36 * st.length + 26, m: { l: 130 }, lanes: st.map(s => ({ label: s.label, color: stemColor(s.name) })),
      layers: [{ type: 'bargrid', bars: A.rhythm.bars, lo: -50, hi: -8, rows: st.map(s => ({ values: s.bar_db, color: stemColor(s.name) })) }],
      tooltip(t, y) {
        const i = (A.rhythm.bars || []).findIndex(b => t >= b[0] && t < b[1]);
        const P = this.P;
        const lane = Math.floor((y - P.y) / P.h * st.length);
        if (i < 0 || lane < 0 || lane >= st.length) return `<b>${fmtTime(t)}</b>`;
        return `<b>第 ${i + 1} 小节</b> · ${fmtTime(t)}<br><span class="sw" style="background:${stemColor(st[lane].name)}"></span>${st[lane].label}: <b>${fmt(st[lane].bar_db[i], 1)} dBFS</b>`;
      },
    });
  }
}

// ================================================================== LOUDNESS
export function loudness(root, A) {
  const L = A.loudness;
  root.append(h('div', { class: 'tab-title' }, '波形与响度'), h('div', { class: 'tab-sub' }, 'EBU R128 / ITU-R BS.1770 响度测量、峰值、动态范围。'));
  if (!L) return unavailable(root, '响度分析');
  tiles(root, [
    { l: '综合响度 Integrated', v: `${fmt(L.integrated_lufs, 1)}<small>LUFS</small>` },
    { l: '响度范围 LRA', v: `${fmt(L.lra, 1)}<small>LU</small>` },
    { l: '真峰值 True Peak', v: `${fmt(L.true_peak_dbtp, 2)}<small>dBTP</small>`, s: L.true_peak_dbtp > -1 ? '<span class="warn">⚠ 高于 -1 dBTP</span>' : '' },
    { l: '采样峰值', v: `${fmt(L.sample_peak_dbfs, 2)}<small>dBFS</small>` },
    { l: 'RMS', v: `${fmt(L.rms_dbfs, 1)}<small>dBFS</small>` },
    { l: '峰值因数 Crest', v: `${fmt(L.crest_db, 1)}<small>dB</small>` },
    { l: 'PLR', v: `${fmt(L.plr_db, 1)}<small>dB</small>`, title: '峰值-响度比' },
    { l: 'DR (近似)', v: fmt(L.dr, 1) },
    { l: '最大瞬时响度', v: `${fmt(L.max_momentary, 1)}<small>LUFS</small>` },
    { l: '削波采样', v: String(L.clipped_samples ?? '–'), s: L.clipped_samples > 10 ? '<span class="warn">⚠ 可能存在削波</span>' : '正常' },
  ]);
  const wv = card(root, '立体声波形', '上 = 左声道 (L)，下 = 右声道 (R)。');
  new TimeChart(wv, { height: 200, noGrid: true, layers: [{ type: 'waveform', wave: L.waveform, mode: 'stereo', color: S(0) }, downbeatLayer(A, { alpha: 0.12 })] });

  const lc = card(root, '响度随时间变化', '瞬时响度 (400ms) 与短期响度 (3s)。虚线：本曲综合响度与流媒体常用标准 -14 LUFS。');
  legend(lc, [{ label: '短期 Short-term', color: S(0) }, { label: '瞬时 Momentary', color: S(1) }]);
  new TimeChart(lc, {
    height: 240, y: { min: -45, max: 0 }, yLabel: 'LUFS',
    layers: [
      { type: 'line', series: L.momentary, color: S(1), width: 1, name: '瞬时', unit: 'LUFS', dec: 1 },
      { type: 'line', series: L.short_term, color: S(0), width: 2, name: '短期', unit: 'LUFS', dec: 1 },
      { type: 'hlines', values: [{ v: L.integrated_lufs, label: `综合 ${fmt(L.integrated_lufs, 1)} LUFS`, color: cssVar('--ink-2') }, { v: -14, label: '-14 LUFS', color: cssVar('--muted') }] },
    ],
  });
  const g = h('div', { class: 'grid g2' }); root.append(g);
  const pr = card(g, '峰值与 RMS 包络', '每 50ms 的峰值与 RMS 电平 (dBFS)。两者差距越小 = 压缩越重。');
  legend(pr, [{ label: '峰值 Peak', color: S(1) }, { label: 'RMS', color: S(0) }]);
  new TimeChart(pr, {
    height: 220, y: { min: -60, max: 0 }, yLabel: 'dBFS',
    layers: [{ type: 'line', series: L.peak, color: S(1), width: 1, name: '峰值', unit: 'dBFS', dec: 1 },
      { type: 'line', series: L.rms, color: S(0), width: 1.5, name: 'RMS', unit: 'dBFS', dec: 1 }],
  });
  const cf = card(g, '峰值因数 (Crest Factor)', '峰值 − RMS。数值越低，动态越被压缩（典型流行母带 6–10 dB）。');
  new TimeChart(cf, { height: 220 + 18, y: { min: 0, max: 30 }, yLabel: 'dB', layers: [{ type: 'line', series: L.crest, color: S(0), name: '峰值因数', unit: 'dB', dec: 1, fill: 0 }] });

  const g2 = h('div', { class: 'grid g2' }); root.append(g2);
  const hc = card(g2, '短期响度分布', '短期响度的直方图：分布越窄，响度越一致。');
  const ed = L.histogram.edges;
  barChart(hc, { labels: L.histogram.counts.map((_, i) => `${ed[i]}`), values: L.histogram.counts, color: S(0), height: 220, labelW: 40,
    tip: i => `${ed[i]} ~ ${ed[i + 1]} LUFS: <b>${L.histogram.counts[i]}</b> 个窗口` });
  const sn = card(g2, '流媒体响度归一化预估', '各平台会把歌曲调整到目标响度。正值 = 会被提升，负值 = 会被压低。', { png: false });
  const tb = h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, '平台'), h('th', {}, '目标'), h('th', {}, '增益变化')));
  const tgt = { Spotify: -14, 'Apple Music': -16, YouTube: -14, Tidal: -14, Amazon: -14, '网易云/QQ': -14 };
  for (const [k, v] of Object.entries(L.streaming_targets || {})) tb.append(h('tr', {}, h('td', {}, k), h('td', {}, `${tgt[k]} LUFS`), h('td', {}, `${v > 0 ? '+' : ''}${fmt(v, 1)} dB`)));
  sn.append(tb);
  note(sn, `DC 偏移：L ${fmt(L.dc_offset?.[0], 5)} / R ${fmt(L.dc_offset?.[1], 5)}`);
}

// ================================================================== SPECTRUM
export function spectrum(root, A) {
  const Sp = A.spectral;
  root.append(h('div', { class: 'tab-title' }, '频谱分析'), h('div', { class: 'tab-sub' }, '时频图、平均频谱、频段能量与音色特征。顶部可切换色图/对比度。'));
  if (!Sp?.stft) return unavailable(root, '频谱分析');
  tiles(root, [
    { l: '频谱倾斜', v: `${fmt(Sp.tilt_db_per_oct, 2)}<small>dB/oct</small>`, s: '100Hz–10kHz（粉噪 ≈ -3）' },
    { l: '频谱质心 (中位)', v: `${fmt(Sp.features?.centroid?.stats?.median, 0)}<small>Hz</small>`, s: '越高越明亮' },
    { l: '能量峰值频率', v: `${fmt(Sp.peak_freq_hz, 0)}<small>Hz</small>` },
    { l: '高频截止', v: Sp.cutoff_hz ? `${fmt(Sp.cutoff_hz / 1000, 1)}<small>kHz</small>` : '无', s: Sp.cutoff_hz ? '<span class="warn">疑似有损压缩</span>' : '全频带' },
    { l: '谐波能量占比', v: `${fmt((Sp.hpss?.harmonic_share ?? 0) * 100, 0)}<small>%</small>`, s: 'HPSS 分离' },
  ]);
  const sc = card(root, '语谱图 (STFT, 对数频率 20Hz–20kHz)', '横轴时间、纵轴频率、颜色为能量 (dB)。可看出每个时刻有哪些频率在发声，以及高频是否被截断。');
  new TimeChart(sc, { height: 340, yAxis: 'heatmap', crossY: true, layers: [{ type: 'heatmap', hm: Sp.stft, name: '' }, downbeatLayer(A, { alpha: 0.08 })] });
  const g = h('div', { class: 'grid g2' }); root.append(g);
  const mc = card(g, '梅尔频谱 (Mel Spectrogram)', '按人耳感知压缩的频率轴（128 个梅尔带）。');
  new TimeChart(mc, { height: 260, yAxis: 'heatmap', crossY: true, layers: [{ type: 'heatmap', hm: Sp.mel }] });
  const cq = card(g, '常数 Q 变换 (CQT · 音高频谱)', '频率轴按音高（每半音 3 格）排列，水平线即持续的音符。');
  new TimeChart(cq, { height: 260, yAxis: 'heatmap', crossY: true, layers: [{ type: 'heatmap', hm: Sp.cqt }] });

  // LTAS
  const lt = card(root, '长期平均频谱 (LTAS)', '全曲平均频谱，1/12 倍频程平滑。Mid = 中置（L+R），Side = 两侧（L−R）。虚线为 −4.5 dB/oct 的“平衡混音”参考斜率。');
  const f = Sp.ltas.freqs;
  const i1k = f.findIndex(x => x >= 1000);
  const refY = f.map(x => Sp.ltas.mid[i1k] - 4.5 * Math.log2(x / 1000));
  const series = [
    { x: f, y: Sp.ltas.mid, color: S(0), name: 'Mid', fill: true },
    { x: f, y: Sp.ltas.side, color: S(1), name: 'Side' },
    { x: f, y: Sp.ltas.left, color: S(2), name: 'Left', hidden: true, width: 1.5 },
    { x: f, y: Sp.ltas.right, color: S(3), name: 'Right', hidden: true, width: 1.5 },
    { x: f, y: refY, color: cssVar('--muted'), name: '参考 −4.5dB/oct', dash: [5, 4], width: 1 },
  ];
  let ltChart;
  legend(lt, series.map(s => ({ label: s.name, color: s.color, off: s.hidden, ref: s })), it => { it.ref.hidden = it.off; ltChart.draw(); });
  [...lt.querySelectorAll('.legend span')].forEach((sp, i) => sp.classList.toggle('off', !!series[i].hidden));
  ltChart = xyChart(lt, { series, xLog: true, xMin: 20, xMax: 20000, yMin: -80, yMax: 5, height: 280, yFmt: v => `${v}`, yFmtTip: v => `${v.toFixed(1)} dB`,
    vlines: Sp.cutoff_hz ? [{ x: Sp.cutoff_hz, label: `截止 ${fmt(Sp.cutoff_hz / 1000, 1)}k` }] : [],
    bands: [{ x0: 20, x1: 60, color: S(0), alpha: 0.05 }, { x0: 6000, x1: 20000, color: S(0), alpha: 0.05 }] });

  // bands
  const bandColors = Sp.bands.map((_, i) => S(i));
  const g2 = h('div', { class: 'grid g2' }); root.append(g2);
  const bs = card(g2, '频段能量占比', '全曲各频段在总能量中的比例（低频通常占比最高）。');
  barChart(bs, { labels: Sp.bands.map(b => b.name.split(' ')[0]), values: Sp.bands.map(b => b.share), colors: bandColors, height: 240, fmt: v => v.toFixed(1) + '%', yFmt: v => v + '%',
    tip: i => `${Sp.bands[i].name} (${Sp.bands[i].lo}–${Sp.bands[i].hi} Hz): <b>${Sp.bands[i].share.toFixed(1)}%</b>` });
  const bt = card(g2, '频段能量随时间 (堆叠百分比)', '每个时刻各频段的能量占比，可看出低频/高频在不同段落的变化。');
  legend(bt, Sp.bands.map((b, i) => ({ label: b.name.split(' ')[0], color: bandColors[i] })));
  new TimeChart(bt, { height: 214, y: { min: 0, max: 100 }, yLabel: '%', layers: [{ type: 'stack', series: Sp.bands.map((b, i) => ({ series: b.pct, color: bandColors[i] })) }],
    tooltip(t) { return `<b>${fmtTime(t, 2)}</b><br>` + Sp.bands.map((b, i) => { const s = b.pct; const k = Math.round((t - s.t0) / s.dt); return `<span class="sw" style="background:${bandColors[i]}"></span>${b.name}: <b>${fmt(s.v[k], 1)}%</b>`; }).join('<br>'); } });

  // features
  const F = Sp.features;
  const fc = card(root, '频谱质心 / 滚降 / 带宽', '质心 = 频谱“重心”（明亮度）；滚降 = 85% 能量以下的频率；带宽 = 频谱展开程度。');
  legend(fc, [{ label: '质心 Centroid', color: S(0) }, { label: '滚降 Rolloff', color: S(1) }, { label: '带宽 Bandwidth', color: S(2) }]);
  new TimeChart(fc, {
    height: 220, y: { min: 100, max: 11025, log: true, ticks: [100, 200, 500, 1000, 2000, 5000, 10000], fmt: v => v >= 1000 ? v / 1000 + 'k' : v }, yLabel: 'Hz',
    layers: [{ type: 'line', series: F.rolloff, color: S(1), width: 1, name: '滚降', unit: 'Hz', dec: 0 },
      { type: 'line', series: F.bandwidth, color: S(2), width: 1, name: '带宽', unit: 'Hz', dec: 0 },
      { type: 'line', series: F.centroid, color: S(0), width: 1.5, name: '质心', unit: 'Hz', dec: 0 }],
  });
  const g3 = h('div', { class: 'grid g3' }); root.append(g3);
  const ff = card(g3, '频谱平坦度', '接近 1 = 噪声化（镲片、失真），接近 0 = 音调性强。');
  new TimeChart(ff, { height: 170, y: { min: 0, max: Math.max(0.05, F.flatness.stats.p90 * 2) }, layers: [{ type: 'line', series: F.flatness, color: S(0), width: 1, name: '平坦度', dec: 4 }] });
  const zc = card(g3, '过零率 (ZCR)', '高 = 高频/噪声成分多（齿音、镲片）。');
  new TimeChart(zc, { height: 170, y: { min: 0, max: Math.max(0.05, F.zcr.stats.p90 * 1.6) }, layers: [{ type: 'line', series: F.zcr, color: S(0), width: 1, name: 'ZCR', dec: 4 }] });
  const fx = card(g3, '频谱通量 (Spectral Flux)', '频谱变化的剧烈程度，峰值通常对应音符起始/鼓点。');
  new TimeChart(fx, { height: 170, y: { min: 0, max: 1 }, layers: [{ type: 'line', series: F.flux, color: S(0), width: 1, name: '通量', dec: 3 }] });

  const g4 = h('div', { class: 'grid g2' }); root.append(g4);
  const ct = card(g4, '频谱对比度 (Spectral Contrast)', '每个频段中峰与谷的差 (dB)。高对比 = 清晰的音调成分；低 = 噪声化。');
  new TimeChart(ct, { height: 200, yAxis: 'heatmap', m: { l: 74 }, layers: [{ type: 'heatmap', hm: Sp.contrast, name: '' }] });
  const mf = card(g4, 'MFCC 音色特征', '20 维梅尔倒谱系数（逐维标准化）。描述音色包络，常用于音色识别/相似度。');
  new TimeChart(mf, { height: 200, yAxis: 'heatmap', layers: [{ type: 'heatmap', hm: Sp.mfcc, name: '', fmtVal: v => v.toFixed(2) + ' σ' }] });
  const hp = card(root, '谐波 / 打击乐能量比 (HPSS)', '1 = 全是持续音（和声乐器、人声），0 = 全是打击乐瞬态。');
  new TimeChart(hp, { height: 170, y: { min: 0, max: 1 }, layers: [sectionLayer(A, [0, 0.1]), { type: 'line', series: Sp.hpss.harmonic_ratio, color: S(0), name: '谐波占比', dec: 2, fill: 0 }] });
}

// ================================================================== RHYTHM
export function rhythm(root, A) {
  const R = A.rhythm;
  root.append(h('div', { class: 'tab-title' }, '节奏与速度'), h('div', { class: 'tab-sub' }, `节拍检测：${R?.method === 'beat_this' ? 'Beat This! (CPJKU 2024, Transformer)' : 'librosa 动态规划'}。开启底部“节拍器”可以边听边验证节拍。`));
  if (!R) return unavailable(root, '节奏分析');
  tiles(root, [
    { l: 'BPM', v: fmt(R.bpm, 1), s: `稳定度 ±${fmt(R.tempo_stability_bpm_std, 1)}` },
    { l: '速度候选', v: (R.bpm_candidates || []).slice(0, 3).map(c => Math.round(c[0])).join(' · ') || '–', s: '来自速度图' },
    { l: '拍号', v: R.time_signature, s: `置信度 ${fmt(R.meter_confidence, 2)}` },
    { l: '拍 / 小节', v: `${(R.beats || []).length} / ${R.n_bars}` },
    { l: '摇摆比 Swing', v: R.swing_ratio ? fmt(R.swing_ratio, 2) : '–', s: R.swing_ratio ? (R.swing_ratio > 1.35 ? '有明显 swing' : '基本直拍') : '' },
    { l: '律动偏差', v: R.timing_dev_ms?.std != null ? `±${fmt(R.timing_dev_ms.std, 0)}<small>ms</small>` : '–', s: R.timing_dev_ms?.mean != null ? `平均 ${fmt(R.timing_dev_ms.mean, 0)} ms（负=抢拍）` : '' },
    { l: '节拍清晰度', v: fmt(R.pulse_clarity, 2), s: '拍点 / 平均起音强度' },
  ]);
  const bc = card(root, '节拍网格', '灰色曲线：起音强度；彩色曲线：神经网络的拍点 / 强拍激活值；竖线：检测到的拍 (细) 与小节线 (粗, 带小节号)。');
  legend(bc, [{ label: '起音强度', color: cssVar('--muted') }, { label: '拍激活', color: S(0) }, { label: '强拍激活', color: S(1) }]);
  new TimeChart(bc, {
    height: 220, y: { min: 0, max: 1.05 },
    layers: [
      { type: 'line', series: R.onset_env, color: cssVar('--muted'), width: 1, name: '起音', fill: 0, fillAlpha: 0.12 },
      ...(R.activation ? [{ type: 'line', series: R.activation.beat, color: S(0), width: 1.2, name: '拍激活' }, { type: 'line', series: R.activation.downbeat, color: S(1), width: 1.2, name: '强拍激活' }] : []),
      { type: 'markers', times: R.beats, color: cssVar('--ink-2'), alpha: 0.3, minPx: 4 },
      { type: 'markers', times: (R.bars || []).map(b => b[0]), color: S(1), alpha: 0.9, width: 1.5, labels: i => String(i + 1), minPx: 3 },
    ],
  });
  const tc = card(root, '速度曲线 (逐拍 BPM)', '相邻两拍间隔换算的 BPM（中值平滑）。可检查人演奏的速度漂移或渐快渐慢。');
  const lb = R.local_bpm.v.filter(v => v != null);
  const mn = Math.min(...lb), mx = Math.max(...lb);
  new TimeChart(tc, { height: 190, y: { min: Math.floor(Math.min(mn, R.bpm - 5)), max: Math.ceil(Math.max(mx, R.bpm + 5)) }, yLabel: 'BPM',
    layers: [{ type: 'hlines', values: [{ v: R.bpm, label: `${fmt(R.bpm, 1)} BPM` }] }, { type: 'line', series: { t: R.local_bpm.t, v: R.local_bpm.v }, color: S(0), name: 'BPM', dec: 1 }] });
  const g = h('div', { class: 'grid g2' }); root.append(g);
  const tg = card(g, '速度图 (Tempogram)', '每个时刻的周期性强度在各 BPM 上的分布，亮线就是主导速度（常伴随倍速/半速谐波）。');
  new TimeChart(tg, { height: 260, yAxis: 'heatmap', crossY: true, layers: [{ type: 'heatmap', hm: R.tempogram, fmtVal: v => v.toFixed(2) }] });
  const tp = card(g, '速度候选分布', '速度图的时间平均，峰值即候选 BPM。');
  xyChart(tp, { series: [{ x: R.tempo_profile.bpm, y: R.tempo_profile.v, color: S(0), name: '强度', fill: true }], xMin: 30, xMax: 300, yMin: 0, height: 260,
    xFmt: v => v, xFmtTip: v => `${v.toFixed(0)} BPM`, vlines: (R.bpm_candidates || []).slice(0, 3).map(c => ({ x: c[0], label: `${c[0]}` })) });
  const g2 = h('div', { class: 'grid g2' }); root.append(g2);
  const mt = card(g2, '微观律动：起音在拍内的位置', '每个起音落在一拍中的相对位置 (0~1)。直拍集中在 0 / ½ / ¼ / ¾；摇摆乐的反拍会后移到 ≈ ⅔。');
  const labs = R.microtiming_hist.map((_, i) => { const p = i / 48; return [0, 12, 24, 36].includes(i) ? ['0', '¼', '½', '¾'][i / 12] : (i === 32 ? '⅔' : ''); });
  barChart(mt, { labels: labs, values: R.microtiming_hist, color: S(0), height: 220, labelW: 6,
    tip: i => `拍内位置 ${(i / 48).toFixed(2)}–${((i + 1) / 48).toFixed(2)}: <b>${R.microtiming_hist[i]}</b> 个起音` });
  const od = card(g2, '起音密度', '每秒检测到的音符/鼓点起始数（2 秒窗）。');
  new TimeChart(od, { height: 220, y: { min: 0, max: Math.max(4, ...R.onset_density.v.filter(v => v != null)) }, yLabel: '次/秒',
    layers: [sectionLayer(A, [0, 0.08]), { type: 'line', series: R.onset_density, color: S(0), name: '密度', unit: '次/秒', dec: 1, fill: 0 }] });
}

// ================================================================== DRUMS
export function drums(root, A) {
  const Dr = A.drums;
  root.append(h('div', { class: 'tab-title' }, '鼓组与节奏型'), h('div', { class: 'tab-sub' }, `从${Dr?.source === 'drums stem' ? '分离出的鼓分轨' : 'HPSS 打击乐成分'}中检测底鼓/军鼓/镲片并量化到 16 分音符网格。频段法估计，复杂鼓组可能有误差。`));
  if (!Dr?.hits) return unavailable(root, '鼓组分析');
  const colors = Dr.instruments.map((_, i) => S(i));
  const pc = card(root, '最常见的鼓型 (Step Sequencer)', '按小节统计出现次数最多的节奏型，像鼓机一样显示。每一列 = 一个 16 分音符，粗框 = 每拍第一个 16 分。');
  if (!Dr.patterns?.length) pc.append(h('div', { class: 'muted' }, '未检测到稳定的鼓型。'));
  const n = Dr.steps_per_bar;
  const g = h('div', { class: 'grid g2' }); pc.append(g);
  for (const p of Dr.patterns) {
    const box = h('div', { class: 'pattern-box' }, h('div', { class: 'ph' }, `出现 ${p.count} 个小节`));
    const grid = h('div', { class: 'drumgrid', style: { gridTemplateColumns: `90px repeat(${n}, 1fr)` } });
    grid.append(h('div'));
    for (let s = 0; s < n; s++) grid.append(h('div', { class: 'hdr' }, s % 4 === 0 ? String(s / 4 + 1) : '·'));
    Dr.instruments.forEach((ins, k) => {
      grid.append(h('div', { class: 'lab' }, ins.label));
      const row = p.rows[ins.name];
      for (let s = 0; s < n; s++) grid.append(h('div', { class: 'cell' + (s % 4 === 0 ? ' beat' : ''), style: row[s] === 'x' ? { background: colors[k] } : {} }));
    });
    box.append(grid); g.append(box);
  }
  const sp = card(root, '各步击打概率', '所有小节中，每个 16 分位置被击打的比例（颜色越深越常出现）。');
  const grid = h('div', { class: 'drumgrid', style: { gridTemplateColumns: `90px repeat(${n}, 1fr)` } });
  grid.append(h('div'));
  for (let s = 0; s < n; s++) grid.append(h('div', { class: 'hdr' }, s % 4 === 0 ? String(s / 4 + 1) : '·'));
  Dr.instruments.forEach((ins, k) => {
    grid.append(h('div', { class: 'lab' }, ins.label));
    (Dr.step_prob[ins.name] || []).forEach((v, s) => grid.append(h('div', {
      class: 'cell' + (s % 4 === 0 ? ' beat' : ''), title: `${(v * 100).toFixed(0)}%`,
      style: { background: colors[k], opacity: String(0.08 + 0.92 * v) },
    })));
  });
  sp.append(grid);
  const hc = card(root, '鼓击时间线', '每个点 = 一次检测到的击打，大小/透明度 = 力度。');
  new TimeChart(hc, {
    height: 160, m: { l: 110 }, lanes: Dr.instruments.map((ins, i) => ({ label: ins.label, color: colors[i] })),
    layers: [downbeatLayer(A, { alpha: 0.3 }), { type: 'markers', times: A.rhythm?.beats || [], color: cssVar('--grid'), alpha: 0.8, minPx: 5 },
      ...Dr.hits.map((ht, i) => ({ type: 'dots', t: ht.t, v: ht.v, color: colors[i], rect: [i / 3, (i + 1) / 3] }))],
  });
  const bars = A.rhythm?.bars || [];
  if (bars.length && Dr.bar_pattern_ids) {
    const pp = card(root, '每小节使用的鼓型', '颜色相同 = 同一种节奏型；可发现加花 (fill)、段落变化。数字为该小节的击打数。');
    const items = bars.slice(0, Dr.bar_pattern_ids.length).map(([a, b], i) => {
      const id = Dr.bar_pattern_ids[i];
      return { start: a, end: b, label: id < 0 ? '' : `#${id + 1}`, color: id < 0 ? cssVar('--surface-3') : id < 7 ? S(id) : cssVar('--muted'),
        tip: id < 0 ? `第 ${i + 1} 小节：无鼓` : `第 ${i + 1} 小节：鼓型 #${id + 1}，${Dr.density_per_bar[i]} 次击打` };
    });
    new TimeChart(pp, { height: 74, noGrid: true, layers: [sectionLayer(A, [0, 0.4]), { type: 'segments', rect: [0.45, 1], items, name: '鼓型', font: 10 }] });
  }
}
