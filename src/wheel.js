import {
  oklch2rgb,
  oklabToLinear,
  lin2s,
  gamutClamp,
  inGamut,
  rgb2oklch,
  MAX_CHROMA,
  rgbToHex,
  hexToRgb,
} from "./oklch.js";
import { hsv2rgb, rgb2hsv, hsl2rgb, rgb2hsl } from "./color-models.js";
import { lab2rgb, lab2rgbRaw, rgb2lab } from "./lab.js";

export const WHEEL_RADIUS = 140;

// -------- common helpers --------

const BG = [30, 30, 32];
const LAB_AB_RANGE = 256;
const LAB_AB_MIN = -128;
const LAB_AB_MAX = 128;

// Screen-angle → hue mapping. Chosen so that blue sits at the bottom of the
// wheel, matching the OKLCH formula (and loosely CSP's own color-circle
// orientation: yellow near the top, blue near the bottom).
const HUE_OFFSET_DEG = 150;

function screenAngleDegToHue360(angleDeg) {
  return (((HUE_OFFSET_DEG - angleDeg) % 360) + 360) % 360;
}
function hue360ToScreenAngleRad(h360) {
  return ((HUE_OFFSET_DEG - h360) * Math.PI) / 180;
}

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function pointFromMarker(marker) {
  if (Array.isArray(marker)) return { x: marker[0], y: marker[1] };
  return { x: marker.x, y: marker.y };
}

function pointForPolar(hue360, radius) {
  const angle = hue360ToScreenAngleRad(hue360);
  return {
    x: WHEEL_RADIUS + radius * Math.cos(angle),
    y: WHEEL_RADIUS - radius * Math.sin(angle),
  };
}

function selectedPointArray(point) {
  return [point.x, point.y];
}

function setupCanvas(canvas) {
  canvas.width = WHEEL_RADIUS * 2;
  canvas.height = WHEEL_RADIUS * 2;
}

// Compute (dx, dy, dist, angleDeg) for pixel (x,y) once.
function polar(x, y) {
  const dx = x - WHEEL_RADIUS;
  const dy = y - WHEEL_RADIUS;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
  return [dx, dy, dist, angle];
}

// Write an RGBA pixel into an ImageData.data array.
function putPx(d, i, r, g, b) {
  d[i] = Math.max(0, Math.min(255, Math.round(r * 255)));
  d[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
  d[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
  d[i + 3] = 255;
}

function putBg(d, i) {
  d[i] = BG[0];
  d[i + 1] = BG[1];
  d[i + 2] = BG[2];
  d[i + 3] = 255;
}

// Draw center dot + marker for a wheel. `marker` is either
// { distPx, screenAngleRad } (derived from the current color) or
// { x, y } (explicit pixel coords, used during drag so the marker tracks the
// cursor exactly — matters for OKLCH where gamut-clamp shrinks chroma and the
// derived position drifts inward from the rim).
function drawOverlay(ctx, currentHex, marker) {
  const cx = WHEEL_RADIUS;
  const cy = WHEEL_RADIUS;

  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fillStyle = currentHex;
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.stroke();

  if (!marker) return;
  let mx, my;
  if (marker.x != null) {
    mx = marker.x;
    my = marker.y;
  } else {
    mx = cx + marker.distPx * Math.cos(marker.screenAngleRad);
    my = cy - marker.distPx * Math.sin(marker.screenAngleRad);
  }
  ctx.beginPath();
  ctx.arc(mx, my, 4, 0, Math.PI * 2);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function labAtPoint(x, y) {
  const size = WHEEL_RADIUS * 2;
  const a = (x / (size - 1)) * LAB_AB_RANGE + LAB_AB_MIN;
  const b = LAB_AB_MAX - (y / (size - 1)) * LAB_AB_RANGE;
  return [a, b];
}

function pointForLab(a, b) {
  const size = WHEEL_RADIUS * 2;
  const clamp = (v) => Math.max(0, Math.min(size - 1, v));
  return {
    x: clamp(((a - LAB_AB_MIN) / LAB_AB_RANGE) * (size - 1)),
    y: clamp(((LAB_AB_MAX - b) / LAB_AB_RANGE) * (size - 1)),
  };
}

// -------- OKLCH wheel --------

// Pixel geometry (hue, chroma, inside-the-disc) never changes between renders;
// compute it once instead of a sqrt + atan2 per pixel per frame.
let oklchGeometry = null;
function getOklchGeometry() {
  if (oklchGeometry) return oklchGeometry;
  const size = WHEEL_RADIUS * 2;
  const count = size * size;
  const hue = new Float32Array(count);
  const chroma = new Float32Array(count);
  const cosH = new Float32Array(count);
  const sinH = new Float32Array(count);
  const inside = new Uint8Array(count);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      const [, , dist, angle] = polar(x, y);
      if (dist > WHEEL_RADIUS - 1) continue;
      inside[p] = 1;
      const h = ((150 - angle) % 360 + 360) % 360;
      hue[p] = h;
      chroma[p] = (dist / WHEEL_RADIUS) * MAX_CHROMA;
      const rad = (h * Math.PI) / 180;
      cosH[p] = Math.cos(rad);
      sinH[p] = Math.sin(rad);
    }
  }
  oklchGeometry = { size, hue, chroma, cosH, sinH, inside };
  return oklchGeometry;
}

// Linear→sRGB transfer through an interpolated lookup table. Math.pow per
// channel per pixel was most of what remained of the per-frame cost; 4096
// steps with linear interpolation stays well under one 8-bit level of error.
const LIN2S_STEPS = 4096;
const LIN2S_LUT = new Float32Array(LIN2S_STEPS + 2);
for (let i = 0; i < LIN2S_LUT.length; i++) {
  LIN2S_LUT[i] = lin2s(Math.min(i / LIN2S_STEPS, 1));
}
function lin2sFast(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  const t = c * LIN2S_STEPS;
  const i = t | 0;
  return LIN2S_LUT[i] + (LIN2S_LUT[i + 1] - LIN2S_LUT[i]) * (t - i);
}

// Along a fixed-hue ray at fixed L the in-gamut chromas form one interval
// [0, Cmax] — the same monotonicity gamutClamp's binary search relies on. So
// search once per hue bin instead of once per out-of-gamut pixel: 1441
// searches per frame rather than tens of thousands. 0.25° bins are finer than
// the ~0.4° a rim pixel subtends; values are interpolated between bins.
const OKLCH_HUE_BINS = 1440;
function maxChromaByHue(L) {
  const out = new Float32Array(OKLCH_HUE_BINS + 1);
  for (let i = 0; i <= OKLCH_HUE_BINS; i++) {
    const h = (i / OKLCH_HUE_BINS) * 360;
    let lo = 0;
    let hi = MAX_CHROMA;
    if (inGamut(...oklch2rgb(L, hi, h))) {
      out[i] = hi;
      continue;
    }
    for (let k = 0; k < 20; k++) {
      const mid = (lo + hi) / 2;
      if (inGamut(...oklch2rgb(L, mid, h))) lo = mid;
      else hi = mid;
    }
    out[i] = lo;
  }
  return out;
}

function renderOklchImage(L, gamutWarning) {
  const { size, hue, chroma, cosH, sinH, inside } = getOklchGeometry();
  const cmax = maxChromaByHue(L);
  const binScale = OKLCH_HUE_BINS / 360;
  const img = new ImageData(size, size);
  const d = img.data;

  for (let p = 0, i = 0; p < size * size; p++, i += 4) {
    if (!inside[p]) {
      putBg(d, i);
      continue;
    }
    const hb = hue[p] * binScale;
    const b0 = hb | 0;
    const limit = cmax[b0] + (cmax[b0 + 1] - cmax[b0]) * (hb - b0);
    let c = chroma[p];
    if (c > limit) {
      if (gamutWarning) {
        d[i] = 80; d[i + 1] = 80; d[i + 2] = 82; d[i + 3] = 255;
        continue;
      }
      c = limit;
    }
    const [lr, lg, lb] = oklabToLinear(L, c * cosH[p], c * sinH[p]);
    putPx(d, i, lin2sFast(lr), lin2sFast(lg), lin2sFast(lb));
  }
  return img;
}

class OklchWheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    setupCanvas(canvas);
    this.cachedImage = null;
    this.currentL = 0.65;
    this.gamutWarning = false;
    this.currentHex = "#808080";
    this.selectedPoint = this._pointForHex(this.currentHex);
  }
  render(L) {
    this.currentL = L;
    this.cachedImage = renderOklchImage(L, this.gamutWarning);
    this._draw();
  }
  setGamutWarning(on, rerender = true) {
    this.gamutWarning = on;
    if (rerender) this.render(this.currentL);
  }
  setCurrentColor(hex, markerAt) {
    this.currentHex = hex;
    this.selectedPoint = markerAt
      ? pointFromMarker(markerAt)
      : this._pointForHex(hex);
    this._draw();
  }
  _pointForHex(hex) {
    const [r, g, b] = hexToRgb(hex);
    const [, chroma, hue] = rgb2oklch(r, g, b);
    return pointForPolar(
      hue,
      Math.min(chroma / MAX_CHROMA, 1) * WHEEL_RADIUS,
    );
  }
  getSelectedPoint() { return selectedPointArray(this.selectedPoint); }
  colorAtAxis(L) {
    const [, , dist, angle] = polar(this.selectedPoint.x, this.selectedPoint.y);
    const hue = screenAngleDegToHue360(angle);
    const chroma = Math.min(dist / WHEEL_RADIUS, 1) * MAX_CHROMA;
    return rgbToHex(...gamutClamp(clamp01(L), chroma, hue));
  }
  _draw() {
    if (this.cachedImage) this.ctx.putImageData(this.cachedImage, 0, 0);
    drawOverlay(this.ctx, this.currentHex, this.selectedPoint);
  }
  pickAt(x, y) {
    const [, , dist, angle] = polar(x, y);
    if (dist > WHEEL_RADIUS - 1) return null;
    this.selectedPoint = { x, y };
    const hue = ((150 - angle) % 360 + 360) % 360;
    const chroma = (dist / WHEEL_RADIUS) * MAX_CHROMA;
    const [r, g, b] = gamutClamp(this.currentL, chroma, hue);
    return rgbToHex(r, g, b);
  }
  rgbToAxis(r, g, b) { return rgb2oklch(r, g, b)[0]; }
}

// -------- HSV wheel (angle=hue, radial=saturation, L=value) --------

function renderHsvImage(V) {
  const size = WHEEL_RADIUS * 2;
  const img = new ImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [, , dist, angle] = polar(x, y);
      if (dist > WHEEL_RADIUS - 1) { putBg(d, i); continue; }
      const hue = screenAngleDegToHue360(angle) / 360;
      const sat = dist / WHEEL_RADIUS;
      const [r, g, b] = hsv2rgb(hue, sat, V);
      putPx(d, i, r, g, b);
    }
  }
  return img;
}

class HsvWheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    setupCanvas(canvas);
    this.cachedImage = null;
    this.currentL = 1.0; // "L" = V for HSV
    this.currentHex = "#ffffff";
    this.selectedPoint = this._pointForHex(this.currentHex);
  }
  render(L) {
    this.currentL = L;
    this.cachedImage = renderHsvImage(L);
    this._draw();
  }
  setGamutWarning(_on) {}
  setCurrentColor(hex, markerAt) {
    this.currentHex = hex;
    this.selectedPoint = markerAt
      ? pointFromMarker(markerAt)
      : this._pointForHex(hex);
    this._draw();
  }
  _pointForHex(hex) {
    const [r, g, b] = hexToRgb(hex);
    const [hue, saturation] = rgb2hsv(r, g, b);
    return pointForPolar(hue * 360, Math.min(saturation, 1) * WHEEL_RADIUS);
  }
  getSelectedPoint() { return selectedPointArray(this.selectedPoint); }
  colorAtAxis(V) {
    const [, , dist, angle] = polar(this.selectedPoint.x, this.selectedPoint.y);
    const hue = screenAngleDegToHue360(angle) / 360;
    const saturation = Math.min(dist / WHEEL_RADIUS, 1);
    return rgbToHex(...hsv2rgb(hue, saturation, clamp01(V)));
  }
  _draw() {
    if (this.cachedImage) this.ctx.putImageData(this.cachedImage, 0, 0);
    drawOverlay(this.ctx, this.currentHex, this.selectedPoint);
  }
  pickAt(x, y) {
    const [, , dist, angle] = polar(x, y);
    if (dist > WHEEL_RADIUS - 1) return null;
    this.selectedPoint = { x, y };
    const hue = screenAngleDegToHue360(angle) / 360;
    const sat = Math.min(1, dist / WHEEL_RADIUS);
    const [r, g, b] = hsv2rgb(hue, sat, this.currentL);
    return rgbToHex(r, g, b);
  }
  rgbToAxis(r, g, b) { return rgb2hsv(r, g, b)[2]; }
}

// -------- HSL wheel (angle=hue, radial=saturation, L=lightness) --------

function renderHslImage(L) {
  const size = WHEEL_RADIUS * 2;
  const img = new ImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [, , dist, angle] = polar(x, y);
      if (dist > WHEEL_RADIUS - 1) { putBg(d, i); continue; }
      const hue = screenAngleDegToHue360(angle) / 360;
      const sat = dist / WHEEL_RADIUS;
      const [r, g, b] = hsl2rgb(hue, sat, L);
      putPx(d, i, r, g, b);
    }
  }
  return img;
}

class HslWheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    setupCanvas(canvas);
    this.cachedImage = null;
    this.currentL = 0.5;
    this.currentHex = "#808080";
    this.selectedPoint = this._pointForHex(this.currentHex);
  }
  render(L) {
    this.currentL = L;
    this.cachedImage = renderHslImage(L);
    this._draw();
  }
  setGamutWarning(_on) {}
  setCurrentColor(hex, markerAt) {
    this.currentHex = hex;
    this.selectedPoint = markerAt
      ? pointFromMarker(markerAt)
      : this._pointForHex(hex);
    this._draw();
  }
  _pointForHex(hex) {
    const [r, g, b] = hexToRgb(hex);
    const [hue, saturation] = rgb2hsl(r, g, b);
    return pointForPolar(hue * 360, Math.min(saturation, 1) * WHEEL_RADIUS);
  }
  getSelectedPoint() { return selectedPointArray(this.selectedPoint); }
  colorAtAxis(L) {
    const [, , dist, angle] = polar(this.selectedPoint.x, this.selectedPoint.y);
    const hue = screenAngleDegToHue360(angle) / 360;
    const saturation = Math.min(dist / WHEEL_RADIUS, 1);
    return rgbToHex(...hsl2rgb(hue, saturation, clamp01(L)));
  }
  _draw() {
    if (this.cachedImage) this.ctx.putImageData(this.cachedImage, 0, 0);
    drawOverlay(this.ctx, this.currentHex, this.selectedPoint);
  }
  pickAt(x, y) {
    const [, , dist, angle] = polar(x, y);
    if (dist > WHEEL_RADIUS - 1) return null;
    this.selectedPoint = { x, y };
    const hue = screenAngleDegToHue360(angle) / 360;
    const sat = Math.min(1, dist / WHEEL_RADIUS);
    const [r, g, b] = hsl2rgb(hue, sat, this.currentL);
    return rgbToHex(r, g, b);
  }
  rgbToAxis(r, g, b) { return rgb2hsl(r, g, b)[2]; }
}

// -------- Photoshop-style Lab wheel (x=a, y=b, slider/current color=L) --------

function renderLabImage(L, gamutWarning) {
  const size = WHEEL_RADIUS * 2;
  const img = new ImageData(size, size);
  const d = img.data;
  const labL = L * 100;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [a, b] = labAtPoint(x, y);
      const raw = lab2rgbRaw(labL, a, b);
      const fits = raw.every((v) => v >= -0.002 && v <= 1.002);
      if (!fits && gamutWarning) {
        d[i] = 78; d[i + 1] = 78; d[i + 2] = 82; d[i + 3] = 255;
        continue;
      }
      const [r, g, bl] = fits ? raw : lab2rgb(labL, a, b);
      putPx(d, i, r, g, bl);
    }
  }
  return img;
}

class LabWheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    setupCanvas(canvas);
    this.cachedImage = null;
    this.currentL = 0.5;
    this.gamutWarning = false;
    this.currentHex = "#808080";
    this.selectedPoint = this._pointForHex(this.currentHex);
  }
  render(L) {
    this.currentL = L;
    this.cachedImage = renderLabImage(L, this.gamutWarning);
    this._draw();
  }
  setGamutWarning(on, rerender = true) {
    this.gamutWarning = on;
    if (rerender) this.render(this.currentL);
  }
  setCurrentColor(hex, markerAt) {
    this.currentHex = hex;
    this.selectedPoint = markerAt
      ? pointFromMarker(markerAt)
      : this._pointForHex(hex);
    this._draw();
  }
  _pointForHex(hex) {
    const [r, g, b] = hexToRgb(hex);
    const [, a, labB] = rgb2lab(r, g, b);
    return pointForLab(a, labB);
  }
  getSelectedPoint() { return selectedPointArray(this.selectedPoint); }
  colorAtAxis(L) {
    const [a, b] = labAtPoint(this.selectedPoint.x, this.selectedPoint.y);
    return rgbToHex(...lab2rgb(clamp01(L) * 100, a, b));
  }
  _draw() {
    if (this.cachedImage) this.ctx.putImageData(this.cachedImage, 0, 0);
    drawOverlay(this.ctx, this.currentHex, this.selectedPoint);
  }
  pickAt(x, y) {
    const size = WHEEL_RADIUS * 2;
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    this.selectedPoint = { x, y };
    const [a, b] = labAtPoint(x, y);
    const [r, g, bl] = lab2rgb(this.currentL * 100, a, b);
    return rgbToHex(r, g, bl);
  }
  clampPoint(x, y) {
    const max = WHEEL_RADIUS * 2 - 1;
    return [
      Math.max(0, Math.min(max, x)),
      Math.max(0, Math.min(max, y)),
    ];
  }
  rgbToAxis(r, g, b) { return Math.max(0, Math.min(1, rgb2lab(r, g, b)[0] / 100)); }
}

// -------- factory --------

export function createWheel(canvas, type) {
  switch (type) {
    case "hsv": return new HsvWheel(canvas);
    case "hsl": return new HslWheel(canvas);
    case "lab": return new LabWheel(canvas);
    case "oklch":
    default: return new OklchWheel(canvas);
  }
}

// Keep the old export name for backward compatibility.
export const WheelRenderer = OklchWheel;
