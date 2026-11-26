// Tabs: harmony, structure, stems, melody/MIDI, stereo.
import { TimeChart, StaticChart } from './chart.js';
import { barChart, hbarChart, xyChart, squareImage } from './static.js';
import { card, tiles, legend, note, unavailable, sectionColor, funcColor, FUNC } from './ui.js';
import { h, SERIES, cssVar, fmt, fmtTime, stemColor, midiName, NOTE, clamp, download, rgba, inkOn } from './util.js';
import { heatmapCanvas, url } from './data.js';
import { TL } from './timeline.js';
import { Player } from './player.js';
import { sectionLayer, chordLayer, downbeatLayer } from './tabs_a.js';

const S = i => SERIES(i);
const KEYS_SHORT = [...NOTE, ...NOTE.map(n => n + 'm')];

// ================================================================== HARMONY
export function harmony(root, A) {
  const H = A.harmony;
  root.append(h('div', { class: 'tab-title' }, '调性与和声'), h('div', { class: 'tab-sub' }, '调性：Krumhansl-Kessler 调性轮廓；和弦：拍同步色度 + 模板匹配 + Viterbi 平滑（有分轨时去除人声和鼓，并用贝斯判断转位）。'));
  if (!H?.key) return unavailable(root, '和声分析');
  const k = H.key, cs = H.chord_stats || {};
  tiles(root, [
    { l: '主调', v: k.name_cn, s: k.name },
    { l: '置信度', v: fmt(k.confidence, 2), s: k.confidence < 0.1 ? '与关系调接近，需人工确认' : '' },
    { l: '关系调', v: k.relative_cn },
    { l: '可能转调', v: `${H.modulations}<small>次</small>` },
    { l: '和弦种类', v: `${cs.unique}` },
    { l: '平均和弦时值', v: `${fmt(cs.avg_chord_beats, 1)}<small>拍</small>` },
    { l: '功能占比 T/S/D', v: ['T', 'S', 'D'].map(f => Math.round(cs.function_share?.[f] || 0)).join(' / '), s: `调外 ${Math.round(cs.function_share?.X || 0)}%` },
  ]);

  // chord timeline
  const ct = card(root, '和弦进行时间线', '第一行：段落；第二行：和弦（颜色=和声功能）；第三行：级数（罗马数字，相对主调）；第四行：局部调性。下方为色度图（12 个音级的能量）。');
  legend(ct, Object.entries(FUNC).filter(([f]) => f !== 'N').map(([f, x]) => ({ label: x.label, color: funcColor(f) })));
  const keyItems = (H.key_segments || []).map((s, i) => ({ start: s.start, end: s.end, label: s.name_cn, color: S(i % 2 ? 6 : 0), alpha: 0.55 }));
  new TimeChart(ct, {
    height: 150, noGrid: true, m: { l: 62 }, lanes: [{ label: '段落' }, { label: '和弦' }, { label: '级数' }, { label: '调性' }],
    layers: [sectionLayer(A, [0, 0.25]), chordLayer(A, [0.25, 0.5]), chordLayer(A, [0.5, 0.75], true),
      { type: 'segments', rect: [0.75, 1], items: keyItems, name: '局部调性', font: 11 }],
  });
  new TimeChart(ct, { height: 170, yAxis: 'heatmap', layers: [{ type: 'heatmap', hm: H.chroma, name: '音级', fmtVal: v => v.toFixed(2) }, downbeatLayer(A, { alpha: 0.18 })] });

  // lead sheet
  const ls = card(root, '和弦谱 (Lead Sheet)', '按小节排列的和弦（每行 4 小节），下方为级数。左侧色条 = 新段落开始。点击小节跳转播放，播放时高亮当前小节。', { png: false });
  const romanOf = {};
  for (const c of H.chords) romanOf[c.label] ??= c.roman;
  const bars = A.rhythm?.bars || [];
  const sheet = h('div', { class: 'leadsheet' });
  const secStarts = new Map((A.structure?.segments || []).map(s => [s.start, s]));
  const cells = bars.map(([a, b], i) => {
    const chords = H.lead_sheet?.[i] || [];
    const sec = [...secStarts.entries()].find(([t]) => Math.abs(t - a) < 0.3);
    const el = h('div', { class: 'ls-bar', onclick: () => TL.seek(a), title: `第 ${i + 1} 小节 · ${fmtTime(a)}` },
      sec ? h('div', { class: 'sec', style: { background: sectionColor(sec[1].label) }, title: sec[1].label }) : null,
      h('div', { class: 'n' }, String(i + 1) + (sec ? ` · ${sec[1].label}` : '')),
      h('div', { class: 'c' }, chords.map(c => h('span', {}, c))),
      h('div', { class: 'r' }, chords.map(c => h('span', {}, romanOf[c] || ''))));
    sheet.append(el);
    return el;
  });
  ls.append(sheet);
  let curBar = -1;
  TL.onPlayhead(t => {
    const i = bars.findIndex(([a, b]) => t >= a && t < b);
    if (i !== curBar) { cells[curBar]?.classList.remove('cur'); cells[i]?.classList.add('cur'); curBar = i; }
  });

  const g = h('div', { class: 'grid g2' }); root.append(g);
  const ks = card(g, '24 调相关系数', '音级分布与每个大调/小调轮廓的相关度。最高者即推测调性；关系大小调往往分数接近。');
  barChart(ks, { labels: KEYS_SHORT, values: k.scores, colors: KEYS_SHORT.map((_, i) => i < 12 ? S(0) : S(1)), highlight: k.index, height: 230, labelW: 22, yMin: Math.min(0, ...k.scores),
    tip: i => `${k.labels[i]}: <b>${k.scores[i].toFixed(3)}</b>` });
  legend(ks, [{ label: '大调', color: S(0) }, { label: '小调', color: S(1) }]);
  const cf = card(g, '五度圈', '外圈大调、内圈小调。填充深浅 = 该根音的和弦在曲中出现的时长；粗框 = 推测主调。');
  cf.append(circleOfFifths(H));

  const g2 = h('div', { class: 'grid g2' }); root.append(g2);
  const pc = card(g2, '音级分布 vs 调性轮廓', '柱 = 全曲 12 个音级的加权能量；折线 = 推测调性的理论轮廓。');
  const prof = k.mode === 'minor' ? H.key_profile_minor : H.key_profile_major;
  barChart(pc, { labels: NOTE, values: H.pitch_class_profile, color: S(0), height: 230, yMin: 0, yMax: 1.05, lines: [{ values: prof, color: S(1) }],
    tip: i => `${NOTE[i]}: 能量 <b>${H.pitch_class_profile[i].toFixed(2)}</b> · 轮廓 ${prof[i].toFixed(2)}` });
  legend(pc, [{ label: '实际音级能量', color: S(0) }, { label: `${k.name} 轮廓`, color: S(1) }]);
  const cd = card(g2, '和弦使用时长 Top', '每个和弦在全曲中累计出现的秒数。');
  const byChord = cs.duration_by_chord || [];
  const fnOf = {}; for (const c of H.chords) fnOf[c.label] ??= c.function;
  hbarChart(cd, { items: byChord.slice(0, 12).map(([l, v]) => ({ label: l, value: v, color: funcColor(fnOf[l]), tip: `${l} (${romanOf[l]}): <b>${v.toFixed(1)} s</b>` })), fmt: v => v.toFixed(1) + 's', labelW: 70 });

  const g3 = h('div', { class: 'grid g2' }); root.append(g3);
  const pr = card(g3, '常见和弦进行', '在曲中重复出现的 3–4 和弦序列（和弦名 + 级数）。', { png: false });
  if (!cs.progressions?.length) pr.append(h('div', { class: 'muted' }, '未发现重复的进行。'));
  for (const p of cs.progressions || []) pr.append(h('div', {}, h('span', { class: 'chip' }, `×${p.count}`), ...p.chords.map(c => h('span', { class: 'chip' }, c))));
  if (cs.roman_progressions?.length) {
    pr.append(h('div', { class: 'note' }, '级数进行：'));
    for (const p of cs.roman_progressions) pr.append(h('div', {}, h('span', { class: 'chip' }, `×${p.count}`), ...p.chords.map(c => h('span', { class: 'chip' }, c))));
  }
  const tr = card(g3, '最常见的和弦转换', '和弦 A → 和弦 B 出现的次数。', { png: false });
  const tb = h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, '从'), h('th', {}, '到'), h('th', {}, '次数')));
  for (const [a, b, c] of cs.top_transitions || []) tb.append(h('tr', {}, h('td', {}, `${a}  (${romanOf[a] || ''})`), h('td', {}, `${b}  (${romanOf[b] || ''})`), h('td', {}, String(c))));
  tr.append(tb);
  const tn = card(root, '调性网络 (Tonnetz)', '把和声投影到五度圈、小三度圈、大三度圈三个平面 (6 维)。颜色变化反映和声色彩的移动。');
  new TimeChart(tn, { height: 170, yAxis: 'heatmap', m: { l: 70 }, layers: [{ type: 'heatmap', hm: H.tonnetz, name: '', fmtVal: v => v.toFixed(2) }] });
}

function circleOfFifths(H) {
  const ns = 'http://www.w3.org/2000/svg';
  const order = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
  const flat = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F'];
  const minN = ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm'];
  const majUse = new Array(12).fill(0), minUse = new Array(12).fill(0);
  for (const c of H.chords) {
    if (c.root == null) continue;
    const d = c.end - c.start;
    if (['min', 'min7', 'dim', 'hdim7'].includes(c.quality)) minUse[c.root] += d; else majUse[c.root] += d;
  }
  const mx = Math.max(...majUse, ...minUse, 1e-9);
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '-170 -170 340 340'); svg.setAttribute('class', 'cof');
  svg.style.width = '100%'; svg.style.maxHeight = '300px';
  const col = cssVar('--s1');
  const arc = (r0, r1, a0, a1) => {
    const p = (r, a) => `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;
    return `M ${p(r1, a0)} A ${r1} ${r1} 0 0 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`;
  };
  const key = H.key;
  order.forEach((pcv, i) => {
    const a0 = (i - 0.5) * Math.PI / 6 + 0.01, a1 = (i + 0.5) * Math.PI / 6 - 0.01;
    for (const ring of [0, 1]) {
      const pcRoot = ring === 0 ? pcv : (pcv + 9) % 12;
      const use = ring === 0 ? majUse[pcRoot] : minUse[pcRoot];
      const isKey = ring === 0 ? (key.mode === 'major' && key.tonic === pcRoot) : (key.mode === 'minor' && key.tonic === pcRoot);
      const g = document.createElementNS(ns, 'g');
      if (isKey) g.setAttribute('class', 'key-on');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', ring === 0 ? arc(110, 162, a0, a1) : arc(62, 108, a0, a1));
      path.setAttribute('fill', use > 0 ? rgba(col, 0.12 + 0.88 * use / mx) : cssVar('--surface-2'));
      path.setAttribute('stroke', isKey ? cssVar('--ink') : cssVar('--surface'));
      path.setAttribute('stroke-width', isKey ? 3 : 1.5);
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${ring === 0 ? flat[i] : minN[i]}：和弦累计 ${use.toFixed(1)} 秒`;
      path.append(title);
      const t = document.createElementNS(ns, 'text');
      const am = (a0 + a1) / 2, r = ring === 0 ? 136 : 85;
      t.setAttribute('x', (r * Math.sin(am)).toFixed(1)); t.setAttribute('y', (-r * Math.cos(am)).toFixed(1));
      t.textContent = ring === 0 ? flat[i] : minN[i];
      if (use / mx > 0.55) t.style.fill = '#fff';
      g.append(path, t); svg.append(g);
    }
  });
  const c = document.createElementNS(ns, 'text');
  c.setAttribute('x', 0); c.setAttribute('y', 0); c.textContent = key.name_cn; c.style.fontWeight = 700; c.style.fill = cssVar('--ink');
  svg.append(c);
  return svg;
}

// ================================================================== STRUCTURE
export function structure(root, A) {
  const St = A.structure;
  root.append(h('div', { class: 'tab-title' }, '段落结构'), h('div', { class: 'tab-sub' }, '基于拍同步 CQT/MFCC 的递归矩阵 + 拉普拉斯谱聚类 (McFee & Ellis 2014)，边界对齐到小节线。段落名称为启发式推测。'));
  if (!St?.segments) return unavailable(root, '结构分析');
  const rb = card(root, '段落与新颖度曲线', '上：段落（相同字母 = 相似内容）；下：新颖度曲线（峰值 = 音乐发生明显变化的位置）。');
  new TimeChart(rb, {
    height: 210, y: { min: 0, max: 1.05 },
    layers: [sectionLayer(A, [0, 0.34], { hint: true, font: 12 }),
      { type: 'line', series: { t: St.novelty.t, v: St.novelty.v }, color: S(0), name: '新颖度', fill: 0, rect: [0.4, 1], y: { min: 0, max: 1.05 } },
      downbeatLayer(A, { alpha: 0.12 })],
  });
  const g = h('div', { class: 'grid g2' }); root.append(g);
  const sm = card(g, '自相似矩阵 (Self-Similarity Matrix)', '坐标 (x, y) 的亮度 = 时刻 x 与时刻 y 的相似度（和声+音色）。对角线方向的亮条纹 = 重复段落；亮方块 = 内部一致的段落。点击跳转到 x 时刻。');
  let img = null;
  heatmapCanvas(St.ssm).then(c => { img = c; chart.draw(); });
  const dur = A.meta.duration;
  const segs = St.segments;
  const chart = squareImage(sm, {
    img: () => img, smooth: false, ml: 14, mb: 14, maxH: 520,
    after(ctx, gg) {
      const { x0, y0, S: sz } = gg;
      for (const s of segs) {
        ctx.fillStyle = sectionColor(s.label);
        ctx.fillRect(x0 + s.start / dur * sz, y0 + sz + 3, (s.end - s.start) / dur * sz - 1, 7);
        ctx.fillRect(x0 - 10, y0 + s.start / dur * sz, 7, (s.end - s.start) / dur * sz - 1);
      }
      const p = TL.playhead / dur;
      ctx.strokeStyle = cssVar('--playhead'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0 + p * sz, y0); ctx.lineTo(x0 + p * sz, y0 + sz); ctx.moveTo(x0, y0 + p * sz); ctx.lineTo(x0 + sz, y0 + p * sz); ctx.stroke();
    },
    hit(x, y, gg) {
      if (!gg) return null;
      const a = (x - gg.x0) / gg.S, b = (y - gg.y0) / gg.S;
      if (a < 0 || a > 1 || b < 0 || b > 1) return null;
      return `x: <b>${fmtTime(a * dur)}</b> · y: <b>${fmtTime(b * dur)}</b>`;
    },
    click(x, y, gg) { const a = (x - gg.x0) / gg.S; if (a >= 0 && a <= 1) TL.seek(a * dur); },
    onPlayhead() { this.draw(); },
  });
  const tb = card(g, '段落列表', '点击行跳转；“循环”会把视图设为该段并开启循环播放。', { png: false });
  const table = h('table', { class: 'tbl' }, h('tr', {}, ...['段', '推测', '时间', '小节', '能量', '主要和弦', '活跃乐器', ''].map(x => h('th', {}, x))));
  const rows = segs.map(s => {
    const tr = h('tr', { class: 'click', onclick: () => TL.seek(s.start) },
      h('td', {}, h('span', { class: 'pill', style: { background: sectionColor(s.label), color: inkOn(sectionColor(s.label)) } }, s.label)),
      h('td', {}, s.hint || ''),
      h('td', {}, `${fmtTime(s.start, 0)}–${fmtTime(s.end, 0)}`),
      h('td', {}, String(s.n_bars ?? '')),
      h('td', {}, `${fmt(s.energy_db, 1)} dB`),
      h('td', {}, (s.top_chords || []).join(' ')),
      h('td', {}, (s.active_stems || []).map(n => h('span', { class: 'pill', title: n, style: { background: stemColor(n), color: inkOn(stemColor(n)) } }, n.slice(0, 3)))),
      h('td', {}, h('button', { class: 'btn ghost sm', onclick: e => { e.stopPropagation(); loopRange(s.start, s.end); } }, '循环')));
    table.append(tr);
    return [s, tr];
  });
  tb.append(table);
  TL.onPlayhead(t => rows.forEach(([s, tr]) => tr.classList.toggle('cur', t >= s.start && t < s.end)));
}

export function loopRange(a, b) {
  TL.setView(a, b);
  const lp = document.getElementById('loop');
  if (lp && !lp.checked) { lp.checked = true; lp.dispatchEvent(new Event('change')); }
  TL.seek(a);
  if (!Player.playing) Player.play();
}

// ================================================================== STEMS
export function stems(root, A) {
  const St = A.stems;
  root.append(h('div', { class: 'tab-title' }, '乐器分离 (分轨)'), h('div', { class: 'tab-sub' }, St ? `Demucs ${St.model}（Meta, Hybrid Transformer）分离结果。可以在下方混音台单独试听/静音/独奏每个分轨。` : ''));
  if (!St?.items) return unavailable(root, '分轨（分析时选择了不分离或分离失败）');
  const items = St.items;

  const mx = card(root, '分轨混音台', '点击“加载分轨”后，底部播放源切换为“分轨混音”，即可实时调节各轨音量 / M 静音 / S 独奏。', { png: false });
  const loadBtn = h('button', { class: 'btn primary' }, '加载分轨到播放器');
  const status = h('span', { class: 'muted', style: { marginLeft: '10px' } });
  mx.append(h('div', { style: { marginBottom: '10px' } }, loadBtn, status));
  const mixer = h('div', { class: 'mixer' });
  const meters = {};
  for (const s of items) {
    const st = () => Player.stemState[s.name] ??= { vol: 1, mute: false, solo: false };
    const mBtn = h('button', { class: 'ms m', title: '静音' }, 'M');
    const sBtn = h('button', { class: 'ms s', title: '独奏' }, 'S');
    mBtn.onclick = () => { st().mute = !st().mute; mBtn.classList.toggle('on', st().mute); Player.applyStemGains(); };
    sBtn.onclick = () => { st().solo = !st().solo; sBtn.classList.toggle('on', st().solo); Player.applyStemGains(); };
    const vol = h('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: 1 });
    vol.oninput = () => { st().vol = +vol.value; Player.applyStemGains(); };
    const meter = h('div', { class: 'meter' }, h('div'));
    meters[s.name] = meter.firstChild;
    mixer.append(h('div', { class: 'strip' },
      h('div', { class: 'nm' }, h('i', { style: { background: stemColor(s.name) } }), s.label),
      h('div', { class: 'muted sm' }, `占比 ${fmt(s.energy_share, 1)}% · 活跃 ${Math.round(s.active_ratio * 100)}%`),
      h('div', { class: 'row' }, mBtn, sBtn, vol), meter,
      h('div', { class: 'row' }, h('a', { class: 'dl', href: url(s.file), download: `${s.name}.flac` }, '下载 FLAC'))));
  }
  mx.append(mixer);
  loadBtn.onclick = async () => {
    loadBtn.disabled = true; status.textContent = '解码中…';
    await Player.loadStems(items, p => { status.textContent = `解码中 ${Math.round(p * 100)}%`; });
    status.textContent = '已加载，播放源已切到“分轨混音”';
    document.querySelector('#srcMode [data-mode=stems]').click();
  };
  const buf = new Uint8Array(1024);
  (function meterLoop() {
    if (!document.body.contains(mixer)) return;
    if (Player.playing && Player.mode === 'stems') {
      for (const [n, node] of Object.entries(Player.stemNodes)) {
        node.an.getByteTimeDomainData(buf);
        let pk = 0; for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i] - 128));
        if (meters[n]) meters[n].style.width = `${Math.min(100, pk / 128 * 140)}%`;
      }
    }
    requestAnimationFrame(meterLoop);
  })();

  const lanes = items.map(s => ({ label: s.label, color: stemColor(s.name) }));
  const wv = card(root, '分轨波形 / 频谱', '每一行是一个分轨。切换显示波形或梅尔频谱。');
  const seg = h('div', { class: 'seg' }, h('button', { class: 'on' }, '波形'), h('button', {}, '频谱'));
  wv.tools.prepend(seg);
  const wrapW = h('div'), wrapS = h('div', { style: { display: 'none' } });
  wv.append(wrapW, wrapS);
  new TimeChart(wrapW, {
    height: 62 * items.length + 24, m: { l: 130 }, lanes, noGrid: true,
    layers: [downbeatLayer(A, { alpha: 0.1 }), ...items.map((s, i) => ({ type: 'waveform', wave: s.waveform, mode: 'mono', color: stemColor(s.name), rect: [i / items.length, (i + 1) / items.length], gain: 1.4 }))],
  });
  new TimeChart(wrapS, {
    height: 80 * items.length + 24, m: { l: 130 }, lanes,
    layers: items.map((s, i) => ({ type: 'heatmap', hm: s.mel, name: s.label, rect: [i / items.length, (i + 1) / items.length] })),
  });
  seg.children[0].onclick = () => { seg.children[0].classList.add('on'); seg.children[1].classList.remove('on'); wrapW.style.display = ''; wrapS.style.display = 'none'; };
  seg.children[1].onclick = () => { seg.children[1].classList.add('on'); seg.children[0].classList.remove('on'); wrapS.style.display = ''; wrapW.style.display = 'none'; };

  const g = h('div', { class: 'grid g2' }); root.append(g);
  const es = card(g, '能量占比', '各分轨能量在总能量中的比例。');
  hbarChart(es, { items: items.map(s => ({ label: s.label.split(' ')[0], value: s.energy_share, color: stemColor(s.name), tip: `${s.label}: <b>${s.energy_share.toFixed(1)}%</b><br>RMS ${s.rms_dbfs} dBFS · 峰值 ${s.peak_dbfs} dBFS · 活跃 ${Math.round(s.active_ratio * 100)}%` })),
    fmt: v => v.toFixed(1) + '%', labelW: 80, rowH: 30 });
  const lt = card(g, '分轨频率分布', '各分轨的平均频谱：看出每件乐器占据的频段，以及哪里相互遮蔽 (masking)。');
  const ser = items.map(s => ({ x: St.ltas_freqs, y: s.ltas, color: stemColor(s.name), name: s.label.split(' ')[0], width: 1.8 }));
  let ch;
  legend(lt, ser.map(s => ({ label: s.name, color: s.color, ref: s })), it => { it.ref.hidden = it.off; ch.draw(); });
  ch = xyChart(lt, { series: ser, xLog: true, xMin: 20, xMax: 20000, height: 240, yFmtTip: v => `${v.toFixed(1)} dB` });

  const ec = card(root, '分轨能量随时间', '各分轨 RMS 电平 (dBFS)。点击图例开关曲线。');
  const layers = items.map(s => ({ type: 'line', series: s.energy, color: stemColor(s.name), width: 1.4, name: s.label.split(' ')[0], unit: 'dBFS', dec: 1 }));
  let tc;
  legend(ec, layers.map(l => ({ label: l.name, color: l.color, ref: l })), it => { it.ref.hidden = it.off; tc.requestDraw(); });
  tc = new TimeChart(ec, { height: 240, y: { min: -70, max: 0 }, yLabel: 'dBFS', layers: [sectionLayer(A, [0, 0.07]), ...layers] });

  const ar = card(root, '编曲密度图', '每格 = 一个小节；颜色越实 = 该乐器在这一小节越响。');
  new TimeChart(ar, {
    height: 34 * items.length + 26, m: { l: 130 }, lanes,
    layers: [{ type: 'bargrid', bars: A.rhythm.bars, lo: -50, hi: -8, rows: items.map(s => ({ values: s.bar_db, color: stemColor(s.name) })) }],
  });
}

// ================================================================== MELODY / MIDI
export function melody(root, A) {
  const M = A.melody || {}, T = A.transcription || {};
  root.append(h('div', { class: 'tab-title' }, '旋律与音符转录'), h('div', { class: 'tab-sub' }, `人声/贝斯音高：pYIN 跟踪；复音音符：${T.engine || 'basic-pitch'} 逐分轨转录，可导出 MIDI 到 DAW。`));
  const v = M.vocals;
  if (v) {
    tiles(root, [
      { l: '人声音域', v: v.low ? `${v.low} – ${v.high}` : '–', s: v.range_semitones != null ? `${v.range_semitones} 个半音 · 极值 ${v.abs_low}–${v.abs_high}` : '' },
      { l: '中位音高', v: v.median || '–' },
      { l: '有声比例', v: `${Math.round((v.voiced_ratio || 0) * 100)}<small>%</small>`, s: v.weak ? '<span class="warn">人声分轨很弱，疑似无人声</span>' : v.source },
      { l: '音准偏差', v: v.intonation ? `±${fmt(v.intonation.std_cents, 0)}<small>音分</small>` : '–', s: v.intonation ? `平均偏 ${fmt(v.intonation.mean_cents, 0)} 音分` : '' },
      { l: '颤音', v: v.vibrato ? `${fmt(v.vibrato.rate_hz, 1)}<small>Hz</small>` : '–', s: v.vibrato ? `深度 ≈ ${v.vibrato.depth_cents} 音分 · ${v.vibrato.phrases_with_vibrato} 个乐句` : '' },
      { l: '贝斯音域', v: M.bass?.low ? `${M.bass.low} – ${M.bass.high}` : '–' },
    ]);
  }
  const tracks = T.tracks || {};
  const names = Object.keys(tracks).filter(k => tracks[k]?.length);
  const allP = names.flatMap(k => tracks[k].map(n => n[2]));
  const vm = v ? v.midi.filter(x => x != null) : [];
  let lo = Math.min(...allP, ...(vm.length ? [Math.min(...vm)] : []), 48) - 2, hi = Math.max(...allP, ...(vm.length ? [Math.max(...vm)] : []), 72) + 2;
  lo = clamp(lo, 21, 100); hi = clamp(hi, lo + 12, 108);

  const pr = card(root, '钢琴卷帘 (Piano Roll)', '方块 = 转录出的音符（颜色 = 来源分轨），粗线 = pYIN 人声音高曲线（连续，可看到滑音和颤音）。点击图例显示/隐藏；⌘/Ctrl+滚轮放大可看清细节。');
  const layers = names.map(k => ({ type: 'notes', notes: tracks[k], color: stemColor(k), name: k, alpha: 0.8 }));
  if (v) layers.push({ type: 'line', series: { t0: v.t0, dt: v.dt, v: v.midi }, color: cssVar('--ink'), width: 2, name: '人声音高', fmt: x => `${midiName(x)} (${x.toFixed(2)})` });
  if (M.bass) layers.push({ type: 'line', series: { t0: M.bass.t0, dt: M.bass.dt, v: M.bass.midi }, color: stemColor('bass'), width: 1.5, dash: [4, 2], name: '贝斯音高', hidden: true, fmt: x => midiName(x) });
  let roll;
  legend(pr, layers.map(l => ({ label: l.name === '人声音高' ? '人声音高曲线' : l.name === '贝斯音高' ? '贝斯音高曲线' : `${l.name} (${tracks[l.name]?.length || 0} 音)`, color: l.color, ref: l })), it => { it.ref.hidden = it.off; roll.requestDraw(); });
  [...pr.querySelectorAll('.legend span')].forEach((sp, i) => sp.classList.toggle('off', !!layers[i].hidden));
  roll = new TimeChart(pr, {
    height: 460, yAxis: 'notes', y: { min: lo - 0.5, max: hi + 0.5 }, crossY: true, layers: [downbeatLayer(A, { alpha: 0.15 }), ...layers],
    tooltip(t, y) {
      const P = this.P, ys = this.o.y;
      const mm = ys.min + (1 - (y - P.y) / P.h) * (ys.max - ys.min);
      const parts = [`<b>${fmtTime(t, 2)}</b> · 光标音高 ${midiName(mm)}`];
      for (const L of layers) {
        if (L.hidden) continue;
        if (L.type === 'notes') { const n = L.notes.find(n => t >= n[0] && t <= n[1] && Math.abs(n[2] - mm) < 0.6); if (n) parts.push(`<span class="sw" style="background:${L.color}"></span>${L.name}: <b>${midiName(n[2])}</b> ${(n[1] - n[0]).toFixed(2)}s`); }
        else { const k = Math.round((t - L.series.t0) / L.series.dt); const x = L.series.v[k]; if (x != null) parts.push(`<span class="sw" style="background:${L.color}"></span>${L.name}: <b>${midiName(x)}</b> (${((x - Math.round(x)) * 100).toFixed(0)}¢)`); }
      }
      return parts.join('<br>');
    },
  });

  const dl = card(root, 'MIDI 导出', '多轨 MIDI 包含各分轨转录 + 鼓 (GM 通道 10)，速度与拍号已写入，可直接拖进 Logic / Ableton / FL Studio。', { png: false });
  if (T.midi) {
    dl.append(h('div', {}, h('a', { class: 'btn primary', href: url(T.midi), download: 'transcription.mid' }, '下载完整多轨 MIDI'),
      ...Object.entries(T.per_track || {}).map(([k, f]) => h('a', { class: 'btn', style: { marginLeft: '8px' }, href: url(f), download: `${k}.mid` }, `${k}.mid`))));
  } else dl.append(h('div', { class: 'muted' }, '未生成 MIDI（分析时关闭了音符转录）。'));

  if (v?.note_hist) {
    const g = h('div', { class: 'grid g3' }); root.append(g);
    const nh = card(g, '人声音高分布', '各音符出现的帧数，反映常用音区 (tessitura)。');
    barChart(nh, { labels: v.note_hist.names, values: v.note_hist.counts, color: stemColor('vocals'), height: 220, labelW: 30, rotate: v.note_hist.names.length > 18, mb: 40,
      tip: i => `${v.note_hist.names[i]}: <b>${v.note_hist.counts[i]}</b> 帧` });
    const pc = card(g, '人声音级分布', '12 个音级的使用频率（与调性对照可看旋律的调式色彩）。');
    barChart(pc, { labels: NOTE, values: v.pitch_class_hist, color: stemColor('vocals'), height: 220 });
    if (v.intonation) {
      const it = card(g, '音准分布', '稳定音高帧相对最近半音的偏差（音分）。越集中在 0 附近，音准越“正”。');
      barChart(it, { labels: v.intonation.hist.map((_, i) => (i % 5 === 0 ? String(-50 + i * 5) : '')), values: v.intonation.hist, color: S(0), height: 220, labelW: 4,
        tip: i => `${-50 + i * 5}~${-45 + i * 5} 音分: <b>${v.intonation.hist[i]}</b>` });
    }
  }
}

// ================================================================== STEREO
export function stereo(root, A) {
  const St = A.stereo;
  root.append(h('div', { class: 'tab-title' }, '立体声像'), h('div', { class: 'tab-sub' }, '相关度、宽度、平衡、分频段声像、单声道兼容性。实时示波器见“实时可视化”。'));
  if (!St?.bands) return unavailable(root, '立体声分析');
  tiles(root, [
    { l: '相关度', v: fmt(St.correlation, 2), s: St.correlation < 0 ? '<span class="warn">⚠ 反相风险</span>' : St.correlation > 0.95 ? '接近单声道' : '+1 单声道 / 0 很宽 / −1 反相' },
    { l: '宽度 S/M', v: `${fmt(St.side_to_mid_db, 1)}<small>dB</small>`, s: `比值 ${fmt(St.width, 2)}` },
    { l: '左右平衡', v: `${fmt(St.balance_db, 2)}<small>dB</small>`, s: Math.abs(St.balance_db) > 1 ? (St.balance_db > 0 ? '偏左' : '偏右') : '居中' },
    { l: '单声道折叠', v: `${fmt(St.mono_loss_db, 1)}<small>dB</small>`, s: St.mono_loss_db < -3 ? '<span class="warn">合成单声道损失较大</span>' : '兼容性良好' },
    { l: '负相关时长', v: `${fmt((St.negative_corr_ratio || 0) * 100, 1)}<small>%</small>` },
  ]);
  const cc = card(root, '相关度随时间', '每 100ms 的左右声道相关系数。持续低于 0 的区域在单声道播放时会被削弱。');
  new TimeChart(cc, { height: 190, y: { min: -1, max: 1 }, layers: [{ type: 'hlines', values: [{ v: 0, label: '0' }] }, sectionLayer(A, [0, 0.07]), { type: 'line', series: St.corr_series, color: S(0), width: 1.2, name: '相关度', dec: 2 }] });
  const g = h('div', { class: 'grid g2' }); root.append(g);
  const wc = card(g, '立体声宽度', 'Side / Mid 幅度比。0 = 单声道，越大越宽。');
  new TimeChart(wc, { height: 190, y: { min: 0, max: Math.max(1, ...St.width_series.v.filter(x => x != null).slice(0, 5000)) }, layers: [{ type: 'line', series: St.width_series, color: S(0), width: 1.2, name: '宽度', dec: 2, fill: 0 }] });
  const bc = card(g, '左右平衡', 'L − R 电平差 (dB)。正值偏左，负值偏右。');
  new TimeChart(bc, { height: 190, y: { min: -6, max: 6 }, yLabel: 'dB', layers: [{ type: 'hlines', values: [{ v: 0 }] }, { type: 'line', series: St.balance_series, color: S(0), width: 1.2, name: '平衡', unit: 'dB', dec: 2 }] });
  const g2 = h('div', { class: 'grid g2' }); root.append(g2);
  const bw = card(g2, '分频段声像宽度', '各频段 Side 相对 Mid 的能量 (dB)。通常低频应较窄（单声道），高频更宽。');
  barChart(bw, { labels: St.bands.map(b => `${b.lo >= 1000 ? b.lo / 1000 + 'k' : b.lo}`), values: St.bands.map(b => b.side_to_mid_db), color: S(0), height: 240, yMin: Math.min(-40, ...St.bands.map(b => b.side_to_mid_db)), yMax: Math.max(0, ...St.bands.map(b => b.side_to_mid_db)) + 2,
    tip: i => { const b = St.bands[i]; return `${b.lo}–${b.hi} Hz<br>S/M: <b>${b.side_to_mid_db} dB</b><br>相关度 ${b.corr}`; } });
  const vs = card(g2, '矢量示波器 (密度图)', '全曲采样点在 Mid/Side 平面上的分布：竖直细线 = 单声道，越宽越扩散，水平方向 = 反相。');
  let img = null;
  heatmapCanvas(St.vectorscope, { cmap: 'magma' }).then(c => { img = c; vchart.draw(); });
  const vchart = squareImage(vs, {
    img: () => img, smooth: true, ml: 10, mb: 10, maxH: 300,
    after(ctx, gg) {
      const { x0, y0, S: s } = gg;
      ctx.strokeStyle = rgba('#ffffff', 0.25); ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x0 + s / 2, y0); ctx.lineTo(x0 + s / 2, y0 + s); ctx.moveTo(x0, y0 + s / 2); ctx.lineTo(x0 + s, y0 + s / 2);
      ctx.moveTo(x0, y0); ctx.lineTo(x0 + s, y0 + s); ctx.moveTo(x0 + s, y0); ctx.lineTo(x0, y0 + s); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('M', x0 + s / 2, y0 + 10); ctx.fillText('L', x0 + 10, y0 + 12); ctx.fillText('R', x0 + s - 10, y0 + 12);
    },
  });
}
