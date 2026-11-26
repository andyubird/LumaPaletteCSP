import {
  gamutClamp,
  rgb2oklch,
  MAX_CHROMA,
  rgbToHex,
  hexToRgb,
} from "./oklch.js";
import { hsv2rgb, rgb2hsv, hsl2rgb, rgb2hsl } from "./color-models.js";
import { lab2rgb, rgb2lab } from "./lab.js";
import { createGlSurface } from "./wheel-gl.js";

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

// A surface owns the wheel image and hands the wheel a 2D context for its
// overlay. The real one lives in wheel-gl.js (fragment shaders at device
// resolution). This fallback exists for environments with no WebGL at all —
// headless unit tests, or a WebView2 with both GPU and software rendering
// disabled by policy — and draws only the background and overlay.
class OverlayOnlySurface {
  constructor(canvas) {
    const size = WHEEL_RADIUS * 2;
    canvas.width = size;
    canvas.height = size;
    if (canvas.style) {
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
    }
    this.ctx = canvas.getContext("2d");
    if (typeof document !== "undefined") {
      console.warn("[wheel] WebGL unavailable; the color wheel cannot be drawn.");
    }
  }
  renderImage() {}
  draw(paint) {
    const size = WHEEL_RADIUS * 2;
    this.ctx.fillStyle = `rgb(${BG[0]}, ${BG[1]}, ${BG[2]})`;
    this.ctx.fillRect(0, 0, size, size);
    paint(this.ctx);
  }
  clearImage() {}
}

// One surface per canvas element, reused across wheel-type swaps so shader
// programs compile once.
const surfaces = new WeakMap();
function surfaceFor(canvas) {
  let surface = surfaces.get(canvas);
  if (!surface) {
    surface = createGlSurface(canvas, WHEEL_RADIUS * 2) || new OverlayOnlySurface(canvas);
    surfaces.set(canvas, surface);
  }
  surface.clearImage();
  return surface;
}

// Compute (dx, dy, dist, angleDeg) for pixel (x,y) once.
function polar(x, y) {
  const dx = x - WHEEL_RADIUS;
  const dy = y - WHEEL_RADIUS;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
  return [dx, dy, dist, angle];
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

class OklchWheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.surface = surfaceFor(canvas);
    this.currentL = 0.65;
    this.gamutWarning = false;
    this.currentHex = "#808080";
    this.selectedPoint = this._pointForHex(this.currentHex);
  }
  render(L) {
    this.currentL = L;
    this.surface.renderImage("oklch", { L, gamutWarning: this.gamutWarning });
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
    this.surface.draw((ctx) => drawOverlay(ctx, this.currentHex, this.selectedPoint));
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

class HsvWheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.surface = surfaceFor(canvas);
    this.currentL = 1.0; // "L" = V for HSV
    this.currentHex = "#ffffff";
    this.selectedPoint = this._pointForHex(this.currentHex);
  }
  render(L) {
    this.currentL = L;
    this.surface.renderImage("hsv", { L });
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
    this.surface.draw((ctx) => drawOverlay(ctx, this.currentHex, this.selectedPoint));
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

class HslWheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.surface = surfaceFor(canvas);
    this.currentL = 0.5;
    this.currentHex = "#808080";
    this.selectedPoint = this._pointForHex(this.currentHex);
  }
  render(L) {
    this.currentL = L;
    this.surface.renderImage("hsl", { L });
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
    this.surface.draw((ctx) => drawOverlay(ctx, this.currentHex, this.selectedPoint));
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

class LabWheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.surface = surfaceFor(canvas);
    this.currentL = 0.5;
    this.gamutWarning = false;
    this.currentHex = "#808080";
    this.selectedPoint = this._pointForHex(this.currentHex);
  }
  render(L) {
    this.currentL = L;
    this.surface.renderImage("lab", { L, gamutWarning: this.gamutWarning });
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
    this.surface.draw((ctx) => drawOverlay(ctx, this.currentHex, this.selectedPoint));
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
