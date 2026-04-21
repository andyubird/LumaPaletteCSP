import {
  oklch2rgb,
  gamutClamp,
  rgb2oklch,
  MAX_CHROMA,
  rgbToHex,
  hexToRgb,
} from "./oklch.js";
import { hsv2rgb, rgb2hsv, hsl2rgb, rgb2hsl } from "./color-models.js";

export const WHEEL_RADIUS = 140;

// -------- common helpers --------

const BG = [30, 30, 32];

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

// -------- OKLCH wheel --------

function renderOklchImage(L, gamutWarning) {
  const size = WHEEL_RADIUS * 2;
  const img = new ImageData(size, size);
  const d = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [, , dist, angle] = polar(x, y);
      if (dist > WHEEL_RADIUS - 1) {
        putBg(d, i);
        continue;
      }
      const hue = ((150 - angle) % 360 + 360) % 360;
      const chroma = (dist / WHEEL_RADIUS) * MAX_CHROMA;
      const [r0, g0, b0] = oklch2rgb(L, chroma, hue);
      const fits =
        r0 >= -0.002 && r0 <= 1.002 &&
        g0 >= -0.002 && g0 <= 1.002 &&
        b0 >= -0.002 && b0 <= 1.002;
      if (!fits && gamutWarning) {
        d[i] = 80; d[i + 1] = 80; d[i + 2] = 82; d[i + 3] = 255;
        continue;
      }
      let r, g, b;
      if (fits) { r = r0; g = g0; b = b0; }
      else [r, g, b] = gamutClamp(L, chroma, hue);
      putPx(d, i, r, g, b);
    }
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
    this.markerAt = null;
  }
  render(L) {
    this.currentL = L;
    this.cachedImage = renderOklchImage(L, this.gamutWarning);
    this._draw();
  }
  setGamutWarning(on) { this.gamutWarning = on; this.render(this.currentL); }
  setCurrentColor(hex, markerAt) {
    this.currentHex = hex;
    this.markerAt = markerAt || null;
    this._draw();
  }
  _draw() {
    if (this.cachedImage) this.ctx.putImageData(this.cachedImage, 0, 0);
    let marker;
    if (this.markerAt) {
      marker = { x: this.markerAt[0], y: this.markerAt[1] };
    } else {
      const [r, g, b] = hexToRgb(this.currentHex);
      const [, curC, curH] = rgb2oklch(r, g, b);
      const distPx = Math.min(curC / MAX_CHROMA, 1) * WHEEL_RADIUS;
      const screenAngleRad = ((150 - curH) * Math.PI) / 180;
      marker = { distPx, screenAngleRad };
    }
    drawOverlay(this.ctx, this.currentHex, marker);
  }
  pickAt(x, y) {
    const [, , dist, angle] = polar(x, y);
    if (dist > WHEEL_RADIUS - 1) return null;
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
    this.markerAt = null;
  }
  render(L) {
    this.currentL = L;
    this.cachedImage = renderHsvImage(L);
    this._draw();
  }
  setGamutWarning(_on) {}
  setCurrentColor(hex, markerAt) {
    this.currentHex = hex;
    this.markerAt = markerAt || null;
    this._draw();
  }
  _draw() {
    if (this.cachedImage) this.ctx.putImageData(this.cachedImage, 0, 0);
    let marker;
    if (this.markerAt) {
      marker = { x: this.markerAt[0], y: this.markerAt[1] };
    } else {
      const [r, g, b] = hexToRgb(this.currentHex);
      const [h, s] = rgb2hsv(r, g, b);
      marker = {
        distPx: Math.min(s, 1) * WHEEL_RADIUS,
        screenAngleRad: hue360ToScreenAngleRad(h * 360),
      };
    }
    drawOverlay(this.ctx, this.currentHex, marker);
  }
  pickAt(x, y) {
    const [, , dist, angle] = polar(x, y);
    if (dist > WHEEL_RADIUS - 1) return null;
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
    this.markerAt = null;
  }
  render(L) {
    this.currentL = L;
    this.cachedImage = renderHslImage(L);
    this._draw();
  }
  setGamutWarning(_on) {}
  setCurrentColor(hex, markerAt) {
    this.currentHex = hex;
    this.markerAt = markerAt || null;
    this._draw();
  }
  _draw() {
    if (this.cachedImage) this.ctx.putImageData(this.cachedImage, 0, 0);
    let marker;
    if (this.markerAt) {
      marker = { x: this.markerAt[0], y: this.markerAt[1] };
    } else {
      const [r, g, b] = hexToRgb(this.currentHex);
      const [h, s] = rgb2hsl(r, g, b);
      marker = {
        distPx: Math.min(s, 1) * WHEEL_RADIUS,
        screenAngleRad: hue360ToScreenAngleRad(h * 360),
      };
    }
    drawOverlay(this.ctx, this.currentHex, marker);
  }
  pickAt(x, y) {
    const [, , dist, angle] = polar(x, y);
    if (dist > WHEEL_RADIUS - 1) return null;
    const hue = screenAngleDegToHue360(angle) / 360;
    const sat = Math.min(1, dist / WHEEL_RADIUS);
    const [r, g, b] = hsl2rgb(hue, sat, this.currentL);
    return rgbToHex(r, g, b);
  }
  rgbToAxis(r, g, b) { return rgb2hsl(r, g, b)[2]; }
}

// -------- factory --------

export function createWheel(canvas, type) {
  switch (type) {
    case "hsv": return new HsvWheel(canvas);
    case "hsl": return new HslWheel(canvas);
    case "oklch":
    default: return new OklchWheel(canvas);
  }
}

// Keep the old export name for backward compatibility.
export const WheelRenderer = OklchWheel;
