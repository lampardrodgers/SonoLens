// AI layer (front end): provider settings modal, narration generation (streamed), the "AI 解读" tab and Q&A chat.
// All model calls go through the local server (/api/llm/*), which holds the API keys.
import { $, h, fmtTime } from './util.js';
import { card } from './ui.js';
import { Player } from './player.js';

const STYLE_OPTS = [['pro', '专业乐评'], ['easy', '通俗讲解'], ['poetic', '诗意叙述']];

export const AI = {
  conf: null,
  nar: new Map(),          // rid -> narration (parsed, possibly partial while streaming)
  busy: new Map(),         // rid -> AbortController
  subs: new Set(),
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); },
  emit(rid) { for (const f of this.subs) f(rid); },

  async loadConf(force) {
    if (!this.conf || force) this.conf = await (await fetch('/api/llm/config')).json();
    return this.conf;
  },
  provider(id) { return this.conf?.providers.find(p => p.id === (id || this.conf.active)); },

  async narration(rid) {
    if (this.nar.has(rid)) return this.nar.get(rid);
    const r = await (await fetch(`/api/analysis/${rid}/narration`)).json();
    if (r) this.nar.set(rid, r);
    return r;
  },

  /** Stream a new narration; the partial result is published on every chunk (AI.emit). */
  async generate(rid, { provider, model, style = 'pro' } = {}) {
    if (this.busy.has(rid)) return;
    const ac = new AbortController(); this.busy.set(rid, ac);
    let raw = '';
    const part = { title: '', summary: '', chapters: {}, moments: [], streaming: true, style, provider, model };
    this.nar.set(rid, part); this.emit(rid);
    try {
      await sse(`/api/analysis/${rid}/narrate`, { provider, model, style }, ev => {
        if (ev.type === 'start') { part.provider = ev.provider; part.model = ev.model; part.provider_name = this.provider(ev.provider)?.name; }
        else if (ev.type === 'delta') { raw += ev.text; Object.assign(part, parseNarration(raw)); this.emit(rid); }
        else if (ev.type === 'done') { this.nar.set(rid, ev.narration); }
        else if (ev.type === 'error') throw new Error(ev.message);
      }, ac.signal);
    } catch (e) {
      if (e.name !== 'AbortError') { part.error = e.message; part.streaming = false; }
      else part.streaming = false;
    } finally {
      this.busy.delete(rid);
      const cur = this.nar.get(rid); if (cur) cur.streaming = false;
      this.emit(rid);
    }
  },
  stop(rid) { this.busy.get(rid)?.abort(); },
};

// ------------------------------------------------------------------------------------ SSE over fetch
export async function sse(url, body, onEvent, signal) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`);
  const rd = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split('\n').find(l => l.startsWith('data: '));
      if (line) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

// ------------------------------------------------------------------------------------ parsing / markdown
const TAG = /^@(TITLE|SUMMARY|CHAPTER|MOMENT|END)\b\s*(.*)$/;
export function parseNarration(text) {
  const out = { title: '', summary: '', chapters: {}, moments: [] };
  let cur = null, arg = '', buf = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (cur === 'TITLE') out.title = (body.split('\n')[0] || arg).replace(/^[#*\s]+|[*\s]+$/g, '');
    else if (cur === 'SUMMARY') out.summary = body;
    else if (cur === 'CHAPTER' && arg) out.chapters[arg.trim().replace(/[：:]$/, '')] = body;
    else if (cur === 'MOMENT') { const t = mmssToSec(arg); if (t != null && body) out.moments.push({ t, text: body.replace(/\n/g, ' ') }); }
  };
  for (const ln of text.split('\n')) {
    const m = ln.trim().match(TAG);
    if (m) { flush(); cur = m[1] === 'END' ? null : m[1]; arg = m[2]; buf = cur === 'TITLE' && arg ? [arg] : []; }
    else if (cur) buf.push(ln);
  }
  flush();
  out.moments.sort((a, b) => a.t - b.t);
  return out;
}
function mmssToSec(s) { const m = String(s).match(/(\d+):(\d{1,2})(?:\.(\d+))?/); return m ? +m[1] * 60 + +m[2] + (m[3] ? +('0.' + m[3]) : 0) : null; }

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** Tiny, safe markdown: headings, bold/italic, inline code, lists, paragraphs, m:ss timestamps → seek links. */
export function md(src) {
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(?<![\d:])(\d{1,2}:\d{2})(?![\d:])/g, '<a class="ts" data-t="$1">$1</a>');
  const out = []; let list = null, para = [];
  const endPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const endList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of src.split('\n')) {
    const ln = raw.trimEnd();
    let m;
    if (!ln.trim()) { endPara(); endList(); continue; }
    if ((m = ln.match(/^(#{1,4})\s+(.*)/))) { endPara(); endList(); const l = Math.min(4, m[1].length + 2); out.push(`<h${l}>${inline(m[2])}</h${l}>`); continue; }
    if ((m = ln.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)/))) {
      endPara(); const want = m[1] ? 'ol' : 'ul';
      if (list !== want) { endList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline(m[2])}</li>`); continue;
    }
    endList(); para.push(ln.trim());
  }
  endPara(); endList();
  return out.join('');
}
function bindSeek(el) {
  el.addEventListener('click', e => {
    const a = e.target.closest('[data-t]'); if (!a) return;
    const t = typeof a.dataset.t === 'string' && a.dataset.t.includes(':') ? mmssToSec(a.dataset.t) : +a.dataset.t;
    if (t != null) { Player.seek(t); if (!Player.playing) Player.play(); }
  });
}

// ------------------------------------------------------------------------------------ settings modal
export async function openSettings(onSaved) {
  const conf = await AI.loadConf(true);
  let sel = conf.active;
  const ov = h('div', { class: 'ai-modal-ov' });
  const box = h('div', { class: 'ai-modal', role: 'dialog', 'aria-label': 'AI 设置' });
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  ov.onclick = e => { if (e.target === ov) close(); };

  const list = h('div', { class: 'ai-plist' });
  const pane = h('div', { class: 'ai-pane' });
  const render = () => {
    list.replaceChildren(...conf.providers.map(p => {
      const b = h('button', { class: 'ai-p' + (p.id === sel ? ' on' : '') },
        h('span', { class: 'ai-pn' }, p.name), h('span', { class: 'ai-pv' }, p.vendor),
        h('span', { class: 'ai-dot' + (p.has_key ? ' ok' : '') }, p.has_key ? '已配置' : '未配置'),
        conf.active === p.id ? h('span', { class: 'ai-act' }, '默认') : null);
      b.onclick = () => { sel = p.id; render(); };
      return b;
    }));
    const p = conf.providers.find(x => x.id === sel);
    const key = h('input', { type: 'password', placeholder: p.has_key ? `已保存 ${p.key_hint}${p.key_source === 'env' ? '（来自环境变量）' : ''}，留空则不修改` : `粘贴 ${p.name} API Key`, autocomplete: 'off', spellcheck: 'false' });
    const dl = h('datalist', { id: `dl-${p.id}` }, ...p.suggest.map(s => h('option', { value: s })));
    const model = h('input', { value: p.model, list: `dl-${p.id}`, spellcheck: 'false' });
    const base = h('input', { value: p.base_url, placeholder: '默认', spellcheck: 'false' });
    const msg = h('div', { class: 'ai-msg' });
    const fetchBtn = h('button', { class: 'btn sm' }, '获取模型列表');
    fetchBtn.onclick = async () => {
      await save(false); msg.textContent = '获取中…'; msg.className = 'ai-msg';
      const r = await fetch(`/api/llm/models/${p.id}`); const j = await r.json();
      if (!r.ok) { msg.textContent = j.detail; msg.className = 'ai-msg err'; return; }
      dl.replaceChildren(...j.models.map(s => h('option', { value: s })));
      msg.textContent = `共 ${j.models.length} 个模型，点模型输入框即可选择`; msg.className = 'ai-msg ok';
    };
    const testBtn = h('button', { class: 'btn sm' }, '测试连接');
    testBtn.onclick = async () => {
      await save(false); msg.textContent = '测试中…'; msg.className = 'ai-msg';
      const j = await (await fetch('/api/llm/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: p.id }) })).json();
      msg.textContent = j.ok ? `连接成功 · ${j.ms} ms · 回复 “${j.reply}”` : j.error; msg.className = 'ai-msg ' + (j.ok ? 'ok' : 'err');
    };
    const clearBtn = p.key_source === 'saved' ? h('button', { class: 'btn ghost sm' }, '删除已保存的 Key') : null;
    if (clearBtn) clearBtn.onclick = async () => { await post({ providers: { [p.id]: { clear_key: true } } }); render(); };
    const defBtn = h('button', { class: 'btn sm' + (conf.active === p.id ? ' primary' : '') }, conf.active === p.id ? '✓ 当前默认' : '设为默认');
    defBtn.onclick = async () => { await save(false, true); render(); };
    async function save(closeAfter, makeDefault) {
      const body = { providers: { [p.id]: { model: model.value, base_url: base.value } } };
      if (key.value.trim()) body.providers[p.id].api_key = key.value.trim();
      if (makeDefault) body.active = p.id;
      await post(body); key.value = '';
      if (closeAfter) { close(); onSaved?.(); }
    }
    async function post(body) {
      const j = await (await fetch('/api/llm/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
      Object.assign(conf, j); AI.conf = j;
    }
    const saveBtn = h('button', { class: 'btn primary' }, '保存');
    saveBtn.onclick = () => save(true, !conf.providers.some(x => x.has_key && x.id === conf.active));
    pane.replaceChildren(
      h('div', { class: 'ai-ph' }, h('b', {}, p.name), h('span', {}, p.vendor),
        h('a', { href: p.console, target: '_blank', rel: 'noopener' }, '获取 API Key ↗')),
      h('label', { class: 'ai-f' }, h('span', {}, 'API Key'), key),
      h('label', { class: 'ai-f' }, h('span', {}, '模型'), model, dl),
      h('label', { class: 'ai-f' }, h('span', {}, 'Base URL'), base),
      h('div', { class: 'ai-hint' }, `也可以用环境变量 ${p.env}。Key 只保存在本机 ${conf.path}，不会发给浏览器。`),
      h('div', { class: 'ai-row' }, fetchBtn, testBtn, defBtn, clearBtn), msg,
      h('div', { class: 'ai-foot' }, h('button', { class: 'btn ghost', onclick: close }, '关闭'), saveBtn));
  };
  box.append(h('div', { class: 'ai-mh' }, h('span', { class: 'ai-spark' }, '✦'), 'AI 设置',
    h('small', {}, '选择用于音乐解析与实时解说的大模型')), h('div', { class: 'ai-mb' }, list, pane));
  ov.append(box); document.body.append(ov);
  render();
}

// ------------------------------------------------------------------------------------ generate bar (shared)
export function genBar(rid, { compact = false } = {}) {
  const wrap = h('div', { class: 'ai-gen' + (compact ? ' compact' : '') });
  const prov = h('select', { class: 'ai-sel', title: '模型服务' });
  const style = h('select', { class: 'ai-sel', title: '解说风格' }, ...STYLE_OPTS.map(([v, l]) => h('option', { value: v }, l)));
  const go = h('button', { class: 'btn primary ai-go' }, '✦ 生成 AI 解析');
  const set = h('button', { class: 'btn ghost sm', title: 'AI 设置' }, '⚙');
  set.onclick = () => openSettings(fill);
  async function fill() {
    const c = await AI.loadConf(true);
    prov.replaceChildren(...c.providers.map(p => h('option', { value: p.id, selected: p.id === c.active || null },
      `${p.name} · ${p.model}${p.has_key ? '' : '（未配置）'}`)));
  }
  go.onclick = async () => {
    if (AI.busy.has(rid)) { AI.stop(rid); return; }
    const c = await AI.loadConf();
    const p = c.providers.find(x => x.id === prov.value);
    if (!p.has_key && p.id !== 'claude') { openSettings(fill); return; }
    AI.generate(rid, { provider: prov.value, style: style.value });
  };
  const upd = () => { go.textContent = AI.busy.has(rid) ? '■ 停止生成' : (AI.nar.get(rid)?.summary ? '↻ 重新生成' : '✦ 生成 AI 解析'); };
  const off = AI.on(r => { if (r === rid) upd(); });
  wrap._off = off;
  fill().then(upd);
  wrap.append(prov, style, go, set);
  return wrap;
}

// ------------------------------------------------------------------------------------ the tab
export function aiTab(root, A) {
  const rid = A.id;
  root.append(h('div', { class: 'tab-title' }, 'AI 解读'),
    h('div', { class: 'muted' }, '把全部分析数据交给大模型，生成全曲解析、章节解说和可在影院模式中实时播放的解说字幕；也可以就这首歌提问。支持 Claude / OpenAI / Gemini / DeepSeek / Kimi / Grok。'));
  const hero = h('div', { class: 'ai-hero' });
  root.append(hero);
  const head = h('div', { class: 'ai-hhead' });
  hero.append(head, genBar(rid));
  const status = h('div', { class: 'ai-status' });
  hero.append(status);

  const grid = h('div', { class: 'grid ai-grid' }); root.append(grid);
  const sumC = card(grid, '全曲解析', '由大模型基于分析数据撰写，时间点可点击跳转播放。', { png: false, cls: 'ai-sum' });
  const sideCol = h('div', { class: 'ai-side' }); grid.append(sideCol);
  const momC = card(sideCol, '实时解说字幕', '影院模式播放到对应时间会逐字打出这些字幕。点击跳转。', { png: false });
  const chC = card(root, '章节解说', '', { png: false });
  const chatC = card(root, '问问 AI', '就这首歌提问，例如“副歌在哪里？”“为什么 2:34 会突然安静？”“鼓的律动有什么特点？”', { png: false });
  bindSeek(sumC); bindSeek(momC); bindSeek(chC);

  const chs = A.story?.chapters || [];
  function draw() {
    const n = AI.nar.get(rid);
    head.replaceChildren(
      h('div', { class: 'ai-eyebrow' }, n?.provider_name || n?.provider ? `✦ ${n.provider_name || n.provider} · ${n.model || ''}` : '✦ AI MUSIC NARRATIVE'),
      h('div', { class: 'ai-title' }, n?.title || (n?.streaming ? '正在聆听数据…' : '还没有生成 AI 解析')));
    status.replaceChildren();
    if (n?.streaming) status.append(h('span', { class: 'ai-pulse' }), `生成中 · 已写 ${n.moments.length} 条字幕 · ${Object.keys(n.chapters).length}/${chs.length} 个章节`);
    else if (n?.error) status.append(h('span', { class: 'ai-err' }, n.error));
    else if (n?.created) status.append(`生成于 ${n.created} · 风格：${(STYLE_OPTS.find(s => s[0] === n.style) || [, ''])[1]}`);
    sumC.replaceChildren(n?.summary ? h('div', { class: 'ai-md', html: md(n.summary) + (n.streaming ? '<span class="ai-caret"></span>' : '') })
      : h('div', { class: 'ai-empty' }, n?.streaming ? '…' : '选择模型后点击「生成 AI 解析」。第一次使用请先点 ⚙ 填写 API Key。'));
    momC.replaceChildren(n?.moments?.length ? h('div', { class: 'ai-moms' }, ...n.moments.map(m =>
      h('div', { class: 'ai-mom', 'data-t': m.t }, h('span', { class: 'ai-mt' }, fmtTime(m.t, 0)), h('span', {}, m.text))))
      : h('div', { class: 'ai-empty' }, '—'));
    chC.replaceChildren(h('div', { class: 'ai-chs' }, ...chs.map(c => h('div', { class: 'ai-ch', 'data-t': c.start },
      h('div', { class: 'ai-chh' }, h('b', {}, c.roman), h('span', {}, c.name), h('small', {}, `${fmtTime(c.start, 0)} – ${fmtTime(c.end, 0)}`)),
      h('div', { class: 'ai-chs-sub' }, c.subtitle || ''),
      h('div', { class: 'ai-cht' }, n?.chapters?.[c.roman] || (n?.streaming ? '…' : '—'))))));
  }
  AI.on(r => { if (r === rid) draw(); });
  draw();
  AI.narration(rid).then(draw);
  buildChat(chatC, rid);
}

function buildChat(body, rid) {
  const log = h('div', { class: 'ai-chat' });
  const ta = h('textarea', { rows: 2, placeholder: '输入问题，Enter 发送，Shift+Enter 换行' });
  const send = h('button', { class: 'btn primary' }, '发送');
  const msgs = [];
  const sugg = h('div', { class: 'ai-sugg' }, ...['这首歌的情绪是怎么发展的？', '最精彩的 30 秒在哪里？', '和声上有什么特别之处？', '混音和响度处理得怎么样？']
    .map(q => h('button', { class: 'btn ghost sm', onclick: () => { ta.value = q; ask(); } }, q)));
  body.append(log, sugg, h('div', { class: 'ai-ask' }, ta, send));
  bindSeek(log);
  let ac = null;
  async function ask() {
    const q = ta.value.trim();
    if (ac) { ac.abort(); return; }
    if (!q) return;
    ta.value = '';
    msgs.push({ role: 'user', content: q });
    log.append(h('div', { class: 'ai-q' }, q));
    const a = h('div', { class: 'ai-a ai-md' }, h('span', { class: 'ai-caret' }));
    log.append(a); log.scrollTop = log.scrollHeight;
    let txt = ''; ac = new AbortController(); send.textContent = '停止';
    try {
      const c = await AI.loadConf();
      await sse(`/api/analysis/${rid}/chat`, { messages: msgs, provider: c.active }, ev => {
        if (ev.type === 'delta') { txt += ev.text; a.innerHTML = md(txt) + '<span class="ai-caret"></span>'; log.scrollTop = log.scrollHeight; }
        else if (ev.type === 'error') throw new Error(ev.message);
      }, ac.signal);
      a.innerHTML = md(txt); msgs.push({ role: 'assistant', content: txt });
    } catch (e) {
      if (e.name === 'AbortError') { a.innerHTML = md(txt || '（已停止）'); if (txt) msgs.push({ role: 'assistant', content: txt }); }
      else { a.innerHTML = ''; a.append(h('span', { class: 'ai-err' }, e.message)); msgs.pop(); }
    } finally { ac = null; send.textContent = '发送'; }
  }
  send.onclick = ask;
  ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } };
}
