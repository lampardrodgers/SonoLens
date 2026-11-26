// UI building blocks shared by the tab modules.
import { h, SERIES, cssVar, download } from './util.js';

export function card(parent, title, desc, opts = {}) {
  const tools = h('div', { class: 'card-tools' });
  const body = h('div', { class: 'card-b' });
  const el = h('div', { class: 'card' + (opts.cls ? ' ' + opts.cls : '') },
    h('div', { class: 'card-h' }, h('div', { class: 'card-t' }, title), tools),
    desc ? h('div', { class: 'card-d', html: desc }) : null,
    body);
  parent.append(el);
  if (opts.png !== false) {
    tools.append(h('button', {
      class: 'btn ghost sm', title: '导出为 PNG', onclick: () => exportPng(el, title),
    }, 'PNG'));
  }
  body.tools = tools;
  return body;
}

function exportPng(cardEl, title) {
  const canvases = [...cardEl.querySelectorAll('canvas')];
  if (!canvases.length) return;
  const rect = cardEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const out = document.createElement('canvas');
  out.width = rect.width * dpr; out.height = rect.height * dpr;
  const ctx = out.getContext('2d');
  ctx.fillStyle = cssVar('--surface'); ctx.fillRect(0, 0, out.width, out.height);
  ctx.scale(dpr, dpr);
  ctx.fillStyle = cssVar('--ink'); ctx.font = '600 14px system-ui'; ctx.fillText(title, 16, 24);
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    if (!r.width) continue;
    ctx.drawImage(c, r.left - rect.left, r.top - rect.top, r.width, r.height);
  }
  download(out.toDataURL('image/png'), `${title.replace(/[\\/:*?"<>|\s]+/g, '_')}.png`);
}

export function tiles(parent, items) {
  const el = h('div', { class: 'tiles' });
  for (const it of items) {
    if (!it) continue;
    el.append(h('div', { class: 'tile', title: it.title || '' },
      h('div', { class: 'l' }, it.l),
      h('div', { class: 'v', html: it.v }),
      it.s ? h('div', { class: 's', html: it.s }) : null));
  }
  parent.append(el);
  return el;
}

export function legend(parent, items, onToggle) {
  const el = h('div', { class: 'legend' });
  for (const it of items) {
    const sp = h('span', { class: onToggle ? 'tog' : '' }, h('i', { style: { background: it.color } }), it.label);
    if (onToggle) sp.addEventListener('click', () => { it.off = !it.off; sp.classList.toggle('off', it.off); onToggle(it); });
    el.append(sp);
  }
  parent.append(el);
  return el;
}

export function kv(parent, rows) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of rows) if (v != null) dl.append(h('dt', {}, k), h('dd', { html: String(v) }));
  parent.append(dl);
  return dl;
}

export function note(parent, html) { parent.append(h('div', { class: 'note', html })); }

export function unavailable(parent, what) {
  parent.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, `${what}不可用（该步骤未运行或失败，见“导出/诊断”）。`)));
}

// colour helpers for categorical entities
export const sectionColor = letter => SERIES(Math.max(0, 'ABCDEFGH'.indexOf(letter)) % 8);
export const FUNC = {
  T: { label: '主功能 T', slot: 0 }, S: { label: '下属 S', slot: 1 }, D: { label: '属功能 D', slot: 2 },
  X: { label: '调外/借用', slot: 3 }, N: { label: '无和弦', slot: -1 },
};
export const funcColor = f => (FUNC[f]?.slot ?? -1) < 0 ? cssVar('--surface-3') : SERIES(FUNC[f].slot);
