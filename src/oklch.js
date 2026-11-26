// OKLCH <-> sRGB math, ported from luma_palette_csp.py.
// All inputs/outputs in [0,1] for RGB, H in degrees.

export const MAX_CHROMA = 0.20;

export function oklchToOklab(L, C, h) {
  const r = (h * Math.PI) / 180;
  return [L, C * Math.cos(r), C * Math.sin(r)];
}

export function oklabToLinear(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function lin2s(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
}
export function s2lin(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function oklch2rgb(L, C, h) {
  const [ol, oa, ob] = oklchToOklab(L, C, h);
  const [lr, lg, lb] = oklabToLinear(ol, oa, ob);
  return [lin2s(lr), lin2s(lg), lin2s(lb)];
}

export function rgb2oklch(r, g, b) {
  const lr = s2lin(r), lg = s2lin(g), lb = s2lin(b);
  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2220049481 * lg + 0.689692687 * lb;
  const l = Math.sign(l_) * Math.pow(Math.abs(l_), 1 / 3);
  const m = Math.sign(m_) * Math.pow(Math.abs(m_), 1 / 3);
  const s = Math.sign(s_) * Math.pow(Math.abs(s_), 1 / 3);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bv = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  let h = (Math.atan2(bv, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, Math.sqrt(a * a + bv * bv), h];
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function inGamut(r, g, b) {
  return r >= -0.002 && r <= 1.002 && g >= -0.002 && g <= 1.002 && b >= -0.002 && b <= 1.002;
}

// Binary-search chroma down until the (L, C, h) fits in sRGB.
export function gamutClamp(L, C, h) {
  let [r, g, b] = oklch2rgb(L, C, h);
  if (inGamut(r, g, b)) return [clamp01(r), clamp01(g), clamp01(b)];
  let lo = 0, hi = C;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const [mr, mg, mb] = oklch2rgb(L, mid, h);
    if (inGamut(mr, mg, mb)) lo = mid;
    else hi = mid;
  }
  [r, g, b] = oklch2rgb(L, lo, h);
  return [clamp01(r), clamp01(g), clamp01(b)];
}

export function rgbToHex(r, g, b) {
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}
