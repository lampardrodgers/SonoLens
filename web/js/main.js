// App entry: routing, upload/jobs, library, analysis view shell (navigator, tabs, player bar).
import { $, $$, h, cssVar, resetCss, fmtTime, fmt, bisect, clamp, rgba, SERIES } from './util.js';
import { D, settings, loadAnalysis, clearImages } from './data.js';
import { clearLutCache } from './colormap.js';
import { TL } from './timeline.js';
import { Player } from './player.js';
import { redrawAll, clearCharts, hideTip } from './chart.js';
import { sectionColor } from './ui.js';
import * as TA from './tabs_a.js';
import * as TB from './tabs_b.js';
import * as TC from './tabs_c.js';
import { Cinema } from './cinema/stage.js';

const TABS = [
  { id: 'overview', label: '总览', ico: '◎', fn: TA.overview },
  { id: 'loudness', label: '波形 / 响度', ico: '∿', fn: TA.loudness },
  { id: 'spectrum', label: '频谱', ico: '▦', fn: TA.spectrum },
  { id: 'rhythm', label: '节奏 / 速度', ico: '♩', fn: TA.rhythm },
  { id: 'drums', label: '鼓组', ico: '◉', fn: TA.drums, need: A => A.drums },
  { id: 'harmony', label: '调性 / 和弦', ico: '♯', fn: TB.harmony },
  { id: 'structure', label: '曲式结构', ico: '▤', fn: TB.structure },
  { id: 'stems', label: '乐器分离', ico: '≋', fn: TB.stems },
  { id: 'melody', label: '旋律 / MIDI', ico: '♪', fn: TB.melody },
  { id: 'stereo', label: '立体声', ico: '◐', fn: TB.stereo },
  { id: 'live', label: '实时可视化', ico: '✦', fn: (root, A) => TC.live(root, A, () => current === 'live' && !$('#view').hidden) },
  { id: 'export', label: '导出 / 诊断', ico: '⇩', fn: TC.exportTab },
];
let current = null;
const built = new Map();

// ------------------------------------------------------------------ theme & global settings
const theme = localStorage.getItem('mv.theme') || 'dark';
document.documentElement.dataset.theme = theme;
$('#cmapSel').value = settings.cmap;
$('#floorSel').value = settings.floor;
$('#themeBtn').onclick = () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  localStorage.setItem('mv.theme', t);
  resetCss(); clearLutCache(); clearImages();
  redrawAll(true); drawNav();
};
$('#cmapSel').onchange = e => { settings.cmap = e.target.value; localStorage.setItem('mv.cmap', settings.cmap); clearLutCache(); redrawAll(true); };
let floorT = 0;
$('#floorSel').oninput = e => {
  settings.floor = +e.target.value; localStorage.setItem('mv.floor', settings.floor);
  clearTimeout(floorT); floorT = setTimeout(() => redrawAll(true), 120);
};

// ------------------------------------------------------------------ routing
async function route() {
  const m = location.hash.match(/^#\/a\/([0-9a-f]{12})(?:\/(\w+))?/);
  $('#cinemaBtn').hidden = !m;
  if (m) {
    $('#home').hidden = true; $('#view').hidden = false;
    if (D.id !== m[1]) await openAnalysis(m[1]);
    showTab(m[2] && TABS.some(t => t.id === m[2]) ? m[2] : current || 'overview', false);
    if (m[2] === 'cinema') openCinema(); else closeCinema();
  } else {
    closeCinema();
    Player.pause();
    $('#view').hidden = true; $('#home').hidden = false;
    $('#trackTitle').textContent = '';
    refreshLibrary();
  }
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ cinema mode
let cinema = null, playerReady = Promise.resolve();
async function openCinema() {
  if (cinema) return;
  const id = D.id;
  cinema = new Cinema(D.A, { onExit: () => { cinema = null; location.hash = `#/a/${id}/${current || 'overview'}`; } });
  const c = cinema;
  await playerReady.catch(() => {});
  if (cinema !== c) return;
  await c.open(document.body);
}
function closeCinema() { if (cinema) { const c = cinema; cinema = null; c.close(); } }
$('#cinemaBtn').onclick = () => { if (D.id) location.hash = `#/a/${D.id}/cinema`; };

// ------------------------------------------------------------------ home: upload + library
const fileIn = $('#fileIn'), drop = $('#drop');
$('#pickBtn').onclick = e => { e.preventDefault(); fileIn.click(); };
fileIn.onchange = () => { if (fileIn.files[0]) upload(fileIn.files[0]); fileIn.value = ''; };
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => {
  e.preventDefault(); drop.classList.remove('over');
  const f = e.dataTransfer.files[0]; if (f) upload(f);
});

let busy = false;
async function upload(file) {
  if (busy) return;
  busy = true;
  const job = $('#job'); job.hidden = false;
  const setJ = (msg, p) => { $('#jobMsg').textContent = msg; $('#jobPct').textContent = p == null ? '' : `${Math.round(p * 100)}%`; $('#jobBar').style.width = `${(p || 0) * 100}%`; };
  setJ(`上传 ${file.name} …`, 0);
  const fd = new FormData();
  fd.append('file', file);
  fd.append('stems_model', $('#optStems').value);
  fd.append('transcribe', $('#optMidi').checked);
  fd.append('melody', $('#optMelody').checked);
  try {
    const r = await fetch('/api/analyze', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || r.status);
    const t0 = Date.now();
    for (;;) {
      await new Promise(res => setTimeout(res, 700));
      const s = await fetch(`/api/jobs/${j.job_id}`).then(x => x.json());
      const el = Math.round((Date.now() - t0) / 1000);
      setJ(`${s.message || s.status} · ${el}s`, s.progress);
      if (s.status === 'done') { setJ('完成 ✓', 1); location.hash = `#/a/${s.result_id}`; break; }
      if (s.status === 'error') throw new Error(s.message);
    }
  } catch (e) {
    setJ(`失败：${e.message}`, null);
    $('#jobBar').style.background = cssVar('--critical');
  } finally { busy = false; }
}

async function refreshLibrary() {
  const lib = $('#library'); lib.replaceChildren();
  let items = [];
  try { items = await fetch('/api/library').then(r => r.json()); } catch (e) { /* offline */ }
  if (!items.length) { lib.append(h('div', { class: 'empty' }, '还没有分析过的曲目。拖入一个音频文件开始。')); return; }
  for (const it of items) {
    const del = h('button', { class: 'btn ghost sm danger del', title: '删除分析结果' }, '✕');
    del.onclick = async e => {
      e.stopPropagation();
      if (!confirm(`删除“${it.title}”的分析结果？（不会删除原始音频文件）`)) return;
      await fetch(`/api/library/${it.id}`, { method: 'DELETE' });
      if (D.id === it.id) D.id = null;
      refreshLibrary();
    };
    const card = h('div', { class: 'lib-card' },
      h('div', { class: 't', title: it.file_name }, it.title || it.file_name), del,
      h('div', { class: 'm' }, [it.artist, it.file_name, it.created].filter(Boolean).join(' · ')),
      h('div', { class: 'k' },
        h('span', {}, fmtTime(it.duration, 0)), h('span', {}, `${fmt(it.bpm, 1)} BPM`),
        h('span', {}, it.key || '–'), h('span', {}, `${fmt(it.lufs, 1)} LUFS`),
        it.options?.stems_model && it.options.stems_model !== 'none' ? h('span', { class: 'muted' }, it.options.stems_model) : null,
        it.errors?.length ? h('span', { style: { color: cssVar('--warning') }, title: it.errors.join(', ') }, `⚠ ${it.errors.length}`) : null));
    card.onclick = () => { location.hash = `#/a/${it.id}`; };
    lib.append(card);
  }
}

// ------------------------------------------------------------------ analysis view
async function openAnalysis(id) {
  const content = $('#content');
  content.replaceChildren(h('div', { class: 'muted', style: { padding: '40px' } }, '加载分析结果…'));
  Player.pause();
  clearCharts(); built.clear(); current = null; hideTip();
  const A = await loadAnalysis(id);
  document.title = `${A.meta.title || A.meta.file_name} · 声镜 SonoLens`;
  $('#trackTitle').textContent = [A.meta.artist, A.meta.title || A.meta.file_name].filter(Boolean).join(' – ');
  TL.reset(A.meta.duration);
  content.replaceChildren();
  // side nav
  const side = $('#side'); side.replaceChildren();
  const cb = h('button', { class: 'side-cinema' }, h('span', { class: 'ico' }, '▶'), '影院模式');
  cb.onclick = () => { location.hash = `#/a/${id}/cinema`; };
  side.append(cb);
  for (const t of TABS) {
    const b = h('button', { 'data-tab': t.id }, h('span', { class: 'ico' }, t.ico), t.label);
    b.onclick = () => { location.hash = `#/a/${id}/${t.id}`; };
    side.append(b);
  }
  // player
  $('#tDur').textContent = fmtTime(A.meta.duration, 0);
  const hasStems = (A.stems?.items || []).length > 0;
  $('#stemsModeBtn').disabled = !hasStems;
  $('#stemsModeBtn').title = hasStems ? '用分轨混音播放（可在“乐器分离”页静音/独奏）' : '没有分轨';
  $$('#srcMode button').forEach(b => b.classList.toggle('on', b.dataset.mode === 'mix'));
  $('#playBtn').disabled = true;
  await initNav(A);
  playerReady = Player.init(A);
  playerReady.then(() => { $('#playBtn').disabled = false; updatePlayerUi(); })
    .catch(e => { $('#playBtn').title = `音频加载失败: ${e.message}`; });
}

function showTab(id, push = true) {
  if (push) { location.hash = `#/a/${D.id}/${id}`; return; }
  if (current !== id) window.scrollTo(0, 0);
  current = id;
  $$('#side button').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
  for (const [k, el] of built) el.classList.toggle('on', k === id);
  if (!built.has(id)) {
    const t = TABS.find(x => x.id === id);
    const el = h('div', { class: 'tab on', 'data-tab': id });
    $('#content').append(el);
    built.set(id, el);
    try { t.fn(el, D.A); } catch (e) {
      console.error(e);
      el.append(h('div', { class: 'errbox' }, h('b', {}, '该页面渲染出错'), h('pre', {}, String(e.stack || e))));
    }
  }
  hideTip();
}

// ------------------------------------------------------------------ navigator (overview strip)
const nav = { cv: null, ov: null, env: null, A: null, drag: null, W: 0, H: 64 };
async function initNav(A) {
  nav.A = A;
  const host = $('#navCanvas');
  if (!nav.cv) {
    nav.cv = h('canvas'); nav.ov = h('canvas', { style: { position: 'absolute', left: 0, top: 0, cursor: 'pointer' } });
    host.append(nav.cv, nav.ov);
    new ResizeObserver(() => { sizeNav(); drawNav(); }).observe(host);
    bindNav();
  }
  nav.env = null;
  const wf = A.loudness?.waveform;
  if (wf) {
    const buf = await fetch(`/results/${A.id || D.id}/${wf.file}`).then(r => r.arrayBuffer());
    nav.env = new Int8Array(buf); nav.wf = wf;
  }
  sizeNav(); drawNav();
}
function sizeNav() {
  const host = $('#navCanvas');
  const dpr = window.devicePixelRatio || 1;
  nav.W = host.clientWidth;
  for (const c of [nav.cv, nav.ov]) {
    c.width = Math.max(1, nav.W * dpr); c.height = nav.H * dpr;
    c.style.width = nav.W + 'px'; c.style.height = nav.H + 'px';
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
const nx = t => t / TL.duration * nav.W;
const nt = x => clamp(x / nav.W * TL.duration, 0, TL.duration);
function drawNav() {
  if (!nav.cv || !nav.A) return;
  const ctx = nav.cv.getContext('2d'), W = nav.W, H = nav.H, A = nav.A;
  ctx.clearRect(0, 0, W, H);
  // section ribbon (top 12px)
  for (const s of A.structure?.segments || []) {
    ctx.fillStyle = sectionColor(s.label); ctx.globalAlpha = 0.85;
    const x0 = nx(s.start), x1 = nx(s.end);
    ctx.fillRect(x0 + 1, 0, Math.max(1, x1 - x0 - 2), 12);
    ctx.globalAlpha = 1;
    if (x1 - x0 > 26) {
      ctx.fillStyle = '#fff'; ctx.font = '600 9.5px system-ui'; ctx.textBaseline = 'middle';
      ctx.fillText(s.hint ? `${s.label} ${s.hint}` : s.label, x0 + 5, 6.5, x1 - x0 - 8);
    }
  }
  // waveform
  const top = 15, hh = H - top - 2, mid = top + hh / 2;
  if (nav.env) {
    const env = nav.env, ch = nav.wf.channels || 2, n = env.length / (ch * 2), ps = nav.wf.per_sec;
    ctx.fillStyle = SERIES(0); ctx.globalAlpha = 0.75;
    for (let x = 0; x < W; x++) {
      const a = clamp(Math.floor(nt(x) * ps), 0, n - 1), b = clamp(Math.max(a + 1, Math.floor(nt(x + 1) * ps)), 1, n);
      let mn = 127, mx = -127;
      for (let c = 0; c < ch; c++) { const base = c * 2 * n; for (let i = a; i < b; i++) { if (env[base + i] < mn) mn = env[base + i]; if (env[base + n + i] > mx) mx = env[base + n + i]; } }
      if (mx < mn) continue;
      ctx.fillRect(x, mid - mx / 127 * hh / 2, 1, Math.max(1, (mx - mn) / 127 * hh / 2));
    }
    ctx.globalAlpha = 1;
  }
  // bar ticks
  ctx.fillStyle = cssVar('--axis');
  const bars = A.rhythm?.bars || [];
  const step = Math.max(1, Math.ceil(bars.length / (W / 40)));
  ctx.font = '9px system-ui'; ctx.textBaseline = 'bottom';
  bars.forEach((b, i) => {
    if (i % step) return;
    const x = nx(b[0]); ctx.fillRect(x, H - 4, 1, 4);
    if (i % (step * 4) === 0) { ctx.fillStyle = cssVar('--muted'); ctx.fillText(String(i + 1), x + 2, H); ctx.fillStyle = cssVar('--axis'); }
  });
  drawNavOverlay();
}
function drawNavOverlay() {
  if (!nav.ov) return;
  const ctx = nav.ov.getContext('2d'), W = nav.W, H = nav.H;
  ctx.clearRect(0, 0, W, H);
  const a = nx(TL.t0), b = nx(TL.t1);
  if (b - a < W - 1) {
    ctx.fillStyle = rgba(cssVar('--surface'), 0.6);
    ctx.fillRect(0, 0, a, H); ctx.fillRect(b, 0, W - b, H);
    ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 1.5;
    ctx.strokeRect(a + 0.75, 0.75, b - a - 1.5, H - 1.5);
  }
  const x = nx(TL.playhead);
  ctx.fillStyle = cssVar('--ink'); ctx.fillRect(x - 0.5, 0, 1.5, H);
  $('#navInfo').textContent = `视图 ${fmtTime(TL.t0, 1)} – ${fmtTime(TL.t1, 1)}（${fmt(TL.t1 - TL.t0, 1)} s）· Ctrl/⌘+滚轮缩放，横向滚动/拖动平移，单击定位，双击全曲`;
}
function bindNav() {
  const ov = nav.ov;
  ov.addEventListener('mousedown', e => {
    const x = e.offsetX, a = nx(TL.t0), b = nx(TL.t1);
    const zoomed = b - a < nav.W - 1;
    if (zoomed && Math.abs(x - a) < 6) nav.drag = { kind: 'l' };
    else if (zoomed && Math.abs(x - b) < 6) nav.drag = { kind: 'r' };
    else if (zoomed && x > a && x < b) nav.drag = { kind: 'move', x0: x, t0: TL.t0, t1: TL.t1, moved: false };
    else if (e.shiftKey) nav.drag = { kind: 'new', x0: x };
    else { TL.seek(nt(x)); nav.drag = { kind: 'scrub' }; }
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!nav.drag) {
      if (e.target === ov) {
        const x = e.offsetX, a = nx(TL.t0), b = nx(TL.t1), zoomed = b - a < nav.W - 1;
        ov.style.cursor = zoomed && (Math.abs(x - a) < 6 || Math.abs(x - b) < 6) ? 'ew-resize' : zoomed && x > a && x < b ? 'grab' : 'pointer';
      }
      return;
    }
    const r = ov.getBoundingClientRect(), x = clamp(e.clientX - r.left, 0, nav.W), d = nav.drag;
    if (d.kind === 'l') TL.setView(Math.min(nt(x), TL.t1 - 0.5), TL.t1);
    else if (d.kind === 'r') TL.setView(TL.t0, Math.max(nt(x), TL.t0 + 0.5));
    else if (d.kind === 'move') { d.moved = true; const dt = nt(x) - nt(d.x0); TL.setView(d.t0 + dt, d.t1 + dt); }
    else if (d.kind === 'new') { const a = Math.min(nt(d.x0), nt(x)), b = Math.max(nt(d.x0), nt(x)); if (b - a > 0.3) TL.setView(a, b); }
    else if (d.kind === 'scrub') TL.seek(nt(x));
  });
  window.addEventListener('mouseup', e => {
    const d = nav.drag; nav.drag = null;
    if (d?.kind === 'move' && !d.moved) { const r = ov.getBoundingClientRect(); TL.seek(nt(e.clientX - r.left)); }
  });
  ov.addEventListener('dblclick', () => TL.fit());
  ov.addEventListener('wheel', e => {
    const r = ov.getBoundingClientRect(), t = nt(e.clientX - r.left);
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) TL.pan(e.deltaX / nav.W * TL.duration);
    else TL.zoom(Math.exp(e.deltaY * 0.002), t);
  }, { passive: false });
}
TL.onView(drawNavOverlay);
TL.onPlayhead(drawNavOverlay);

// ------------------------------------------------------------------ player bar
const playBtn = $('#playBtn');
playBtn.onclick = () => Player.toggle();
$('#stopBtn').onclick = () => { Player.stop(); };
$('#metro').onchange = e => { Player.metro = e.target.checked; };
$('#loop').onchange = e => { Player.loop = e.target.checked; };
$('#rate').onchange = e => Player.setRate(+e.target.value);
$('#vol').oninput = e => Player.setVolume(+e.target.value);
$('#follow').onchange = e => { TL.follow = e.target.checked; };
$('#zoomIn').onclick = () => TL.zoom(0.5, Player.playing ? TL.playhead : undefined);
$('#zoomOut').onclick = () => TL.zoom(2);
$('#zoomFit').onclick = () => TL.fit();
$$('#srcMode button').forEach(b => b.onclick = async () => {
  if (b.disabled) return;
  const mode = b.dataset.mode;
  if (mode === 'stems') {
    const items = D.A.stems?.items || [];
    if (!items.every(s => Player.stemBufs[s.name])) {
      b.textContent = '加载分轨 0%';
      await Player.loadStems(items, p => { b.textContent = `加载分轨 ${Math.round(p * 100)}%`; });
      b.textContent = '分轨混音';
    }
  }
  Player.setMode(mode);
  $$('#srcMode button').forEach(x => x.classList.toggle('on', x.dataset.mode === mode));
});
Player.onState(updatePlayerUi);
function updatePlayerUi() {
  playBtn.textContent = Player.playing ? '❚❚' : '▶';
  playBtn.classList.toggle('on', Player.playing);
  if (Player.mode) $$('#srcMode button').forEach(x => x.classList.toggle('on', x.dataset.mode === Player.mode));
}

let lastBeat = -1;
TL.onPlayhead(t => {
  const A = D.A; if (!A || $('#view').hidden) return;
  $('#tCur').textContent = fmtTime(t, 1);
  const R = A.rhythm || {};
  const bi = bisect(R.beats || [], t + 1e-3) - 1;
  const bars = R.bars || [];
  let bari = bisect(bars.map(b => b[0]), t + 1e-3) - 1;
  $('#barBeat').textContent = bari >= 0 && bi >= 0 ? `${bari + 1}.${R.beat_pos?.[bi] ?? 1}` : '–';
  const ch = (A.harmony?.chords || []).find(c => t >= c.start && t < c.end);
  $('#curChord').textContent = ch ? (ch.label === 'N' ? 'N.C.' : `${ch.label}  ${ch.roman || ''}`) : '–';
  const sg = (A.structure?.segments || []).find(s => t >= s.start && t < s.end);
  const cs = $('#curSection');
  cs.textContent = sg ? `${sg.label}${sg.hint ? ' · ' + sg.hint : ''}` : '–';
  cs.style.color = sg ? sectionColor(sg.label) : '';
  if (bi !== lastBeat) {
    lastBeat = bi;
    if (Player.playing && bi >= 0) {
      const led = $('#beatLed');
      led.classList.remove('flash', 'down'); void led.offsetWidth;
      led.classList.add('flash'); if (R.beat_pos?.[bi] === 1) led.classList.add('down');
    }
  }
});

// ------------------------------------------------------------------ keyboard
window.addEventListener('keydown', e => {
  if ($('#view').hidden) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) && e.key !== ' ') return;
  if (document.activeElement?.tagName === 'INPUT' && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'range') return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); document.activeElement?.blur?.(); Player.toggle(); }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault();
    const R = D.A?.rhythm;
    if (e.shiftKey && R?.bars?.length) { // jump by bar
      const starts = R.bars.map(b => b[0]);
      const i = bisect(starts, TL.playhead + (k === 'ArrowRight' ? 0.05 : -0.05));
      TL.seek(k === 'ArrowRight' ? (starts[i] ?? TL.duration) : (starts[Math.max(0, i - 1)] ?? 0));
    } else TL.seek(TL.playhead + (k === 'ArrowRight' ? 5 : -5));
  }
  else if (k === '+' || k === '=') TL.zoom(0.5, TL.playhead >= TL.t0 && TL.playhead <= TL.t1 ? TL.playhead : undefined);
  else if (k === '-' || k === '_') TL.zoom(2);
  else if (k === '0') TL.fit();
  else if (k === 'Home') TL.seek(0);
  else if (/^[1-9]$/.test(k) && e.altKey) { const t = TABS[+k - 1]; if (t) showTab(t.id); }
});

route();
