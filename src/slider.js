import { WHEEL_RADIUS } from "./wheel.js";
import { lin2s } from "./oklch.js";
import { backingScale } from "./wheel-gl.js";

export const SLIDER_W = 24;
const SLIDER_H = WHEEL_RADIUS * 2;

export class SliderRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.currentL = 0.65;
    this._bg = null;
    if (canvas.style) {
      canvas.style.width = `${SLIDER_W}px`;
      canvas.style.height = `${SLIDER_H}px`;
    }
    this._fit();
  }

  // Keep the backing store at device resolution so the gradient and marker
  // line stay crisp on scaled displays. Drawing stays in logical pixels.
  _fit() {
    const scale = backingScale();
    const w = Math.round(SLIDER_W * scale);
    const h = Math.round(SLIDER_H * scale);
    if (this._bg && this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this._renderBackground(w, h);
  }

  _renderBackground(w, h) {
    // Achromatic (C=0) gradient from L=1.0 (top) to L=0.0 (bottom).
    // With C=0 the OKLab a/b vanish, so linear_rgb = L^3 and sRGB = lin2s(L^3).
    const img = this.ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      const L = 1 - y / (h - 1);
      const lin = L * L * L;
      const v = Math.max(0, Math.min(255, Math.round(lin2s(lin) * 255)));
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
      }
    }
    this._bg = img;
  }

  render(L) {
    this.currentL = L;
    this._fit();
    const ctx = this.ctx;
    const scale = this.canvas.width / SLIDER_W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(this._bg, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const y = Math.round((1 - L) * (SLIDER_H - 1));
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(SLIDER_W, y);
    ctx.stroke();
  }

  pickL(y) {
    const clampedY = Math.max(0, Math.min(SLIDER_H - 1, y));
    return 1 - clampedY / (SLIDER_H - 1);
  }
}
