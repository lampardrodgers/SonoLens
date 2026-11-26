// Perceptual colormaps (polynomial fits of matplotlib's magma / inferno / viridis) + diverging.
import { cssVar, hexToRgb } from './util.js';

const POLY = {
  viridis: [[0.2777273272234177, 0.005407344544966578, 0.3340998053353061], [0.1050930431085774, 1.404613529898575, 1.384590162594685],
    [-0.3308618287255563, 0.214847559468213, 0.09509516302823659], [-4.634230498983486, -5.799100973351585, -19.33244095627987],
    [6.228269936347081, 14.17993336680509, 56.69055260068105], [4.776384997670288, -13.74514537774601, -65.35303263337234],
    [-5.435455855934631, 4.645852612178535, 26.3124352495832]],
  magma: [[-0.002136485053939582, -0.000749655052795221, -0.005386127855323933], [0.2516605407371642, 0.6775232436837668, 2.494026599312351],
    [8.353717279216625, -3.577719514958484, 0.3144679030132573], [-27.66873308576866, 14.26473078096533, -13.64921318813922],
    [52.17613981234068, -27.94360607168351, 12.94416944238394], [-50.76852536473588, 29.04658282127291, 4.23415299384598],
    [18.65570506591883, -11.48977351997711, -5.601961508734096]],
  inferno: [[0.0002189403691192265, 0.001651004631001012, -0.01948089843709184], [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
    [11.60249308247187, -3.972853965665698, -15.9423941062914], [-41.70399613139459, 17.43639888205313, 44.35414519872813],
    [77.162935699427, -33.40235894210092, -81.80730925738993], [-71.31942824499214, 32.62606426397723, 73.20951985803202],
    [25.13112622477341, -12.24266895238567, -23.07032500287172]],
};

function polyLut(c) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    for (let k = 0; k < 3; k++) {
      let v = c[6][k];
      for (let j = 5; j >= 0; j--) v = v * t + c[j][k];
      lut[i * 3 + k] = Math.round(Math.max(0, Math.min(1, v)) * 255);
    }
  }
  return lut;
}

function rampLut(stops) { // stops: [[pos, [r,g,b]], ...]
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = stops[0], b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) if (t >= stops[s][0] && t <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break; }
    const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = a[1][k] + (b[1][k] - a[1][k]) * f;
  }
  return lut;
}

const cache = {};
export function getLut(name) {
  const dark = document.documentElement.dataset.theme !== 'light';
  const key = name + (dark ? ':d' : ':l');
  if (cache[key]) return cache[key];
  let lut;
  if (POLY[name]) lut = polyLut(POLY[name]);
  else if (name === 'gray') lut = rampLut([[0, [0, 0, 0]], [1, [255, 255, 255]]]);
  else if (name === 'diverging') {
    lut = rampLut([[0, hexToRgb(cssVar('--s1'))], [0.5, hexToRgb(cssVar('--neutral-mid'))], [1, hexToRgb(cssVar('--s8'))]]);
  } else lut = polyLut(POLY.magma);
  cache[key] = lut;
  return lut;
}
export function clearLutCache() { for (const k in cache) delete cache[k]; }

export function lutCss(lut, v) { // v in 0..1
  const i = Math.max(0, Math.min(255, Math.round(v * 255))) * 3;
  return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
}
