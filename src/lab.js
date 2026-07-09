const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function lin2s(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function s2lin(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labF(t) {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

function labFinv(t) {
  const t3 = t * t * t;
  return t3 > EPS ? t3 : (116 * t - 16) / KAPPA;
}

export function lab2rgbRaw(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;

  const X = XN * labFinv(fx);
  const Y = YN * labFinv(fy);
  const Z = ZN * labFinv(fz);

  const lr = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const lg = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  const lb = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;

  return [lin2s(lr), lin2s(lg), lin2s(lb)];
}

export function lab2rgb(L, a, b) {
  const [r, g, bl] = lab2rgbRaw(L, a, b);
  return [clamp01(r), clamp01(g), clamp01(bl)];
}

export function rgb2lab(r, g, b) {
  const lr = s2lin(r);
  const lg = s2lin(g);
  const lb = s2lin(b);

  const X = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
  const Y = 0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb;
  const Z = 0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb;

  const fx = labF(X / XN);
  const fy = labF(Y / YN);
  const fz = labF(Z / ZN);

  return [
    116 * fy - 16,
    500 * (fx - fy),
    200 * (fy - fz),
  ];
}
