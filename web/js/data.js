// Loading analysis JSON + binary blobs, and turning heatmaps into cached canvases.
import { getLut } from './colormap.js';

export const D = { id: null, A: null, base: '' };
export const settings = {
  cmap: localStorage.getItem('mv.cmap') || 'magma',
  floor: +(localStorage.getItem('mv.floor') ?? 10),
};

const binCache = new Map();
const imgCache = new Map();

export async function loadAnalysis(id) {
  const r = await fetch(`/results/${id}/analysis.json`);
  if (!r.ok) throw new Error(`无法加载分析结果 (${r.status})`);
  D.A = await r.json();
  D.id = id;
  D.base = `/results/${id}/`;
  binCache.clear();
  imgCache.clear();
  return D.A;
}

export function url(rel) { return D.base + rel; }

export async function loadBin(desc) {
  if (!desc) return null;
  if (binCache.has(desc.file)) return binCache.get(desc.file);
  const p = fetch(url(desc.file)).then(r => r.arrayBuffer()).then(buf => {
    const dt = desc.dtype || 'uint8';
    return dt === 'int8' ? new Int8Array(buf) : dt === 'float32' ? new Float32Array(buf) : new Uint8Array(buf);
  });
  binCache.set(desc.file, p);
  return p;
}

function cmapFor(hm) {
  if (hm.cmap === 'magma' || hm.cmap === undefined) return settings.cmap;
  return hm.cmap;
}

/** Returns a canvas (cols x rows, row 0 at bottom) for a heatmap descriptor; cached per colormap. */
export async function heatmapCanvas(hm, opts = {}) {
  const cm = opts.cmap || cmapFor(hm);
  const floor = hm.unit === 'dB' ? settings.floor : 0;
  const key = `${hm.file}|${cm}|${floor}|${document.documentElement.dataset.theme}`;
  if (imgCache.has(key)) return imgCache.get(key);
  const data = await loadBin(hm);
  const { rows, cols } = hm;
  const lut = getLut(cm);
  const cv = document.createElement('canvas');
  cv.width = cols; cv.height = rows;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  const px = img.data;
  const f0 = floor / 100 * 255;
  const sc = 255 / Math.max(1, 255 - f0);
  const map = new Uint8Array(256);
  for (let v = 0; v < 256; v++) map[v] = Math.max(0, Math.min(255, Math.round((v - f0) * sc)));
  for (let r = 0; r < rows; r++) {
    const y = rows - 1 - r;
    const src = r * cols;
    let o = y * cols * 4;
    for (let c = 0; c < cols; c++, o += 4) {
      const li = map[data[src + c]] * 3;
      px[o] = lut[li]; px[o + 1] = lut[li + 1]; px[o + 2] = lut[li + 2]; px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  imgCache.set(key, cv);
  return cv;
}

export function clearImages() { imgCache.clear(); }

/** Value lookup inside a heatmap at (t, rowFrac) for tooltips. */
export function heatmapValue(hm, data, t, row) {
  if (!data) return null;
  const c = Math.floor((t - hm.t0) / (hm.t1 - hm.t0) * hm.cols);
  const r = Math.round(row);
  if (c < 0 || c >= hm.cols || r < 0 || r >= hm.rows) return null;
  const u = data[r * hm.cols + c];
  return hm.lo + (u / 255) * (hm.hi - hm.lo);
}
