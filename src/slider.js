import { WHEEL_RADIUS } from "./wheel.js";
import { lin2s } from "./oklch.js";

export const SLIDER_W = 24;

export class SliderRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    canvas.width = SLIDER_W;
    canvas.height = WHEEL_RADIUS * 2;
    this.currentL = 0.65;
    this._renderBackground();
  }

  _renderBackground() {
    // Achromatic (C=0) gradient from L=1.0 (top) to L=0.0 (bottom).
    // With C=0 the OKLab a/b vanish, so linear_rgb = L^3 and sRGB = lin2s(L^3).
    const h = this.canvas.height;
    const img = this.ctx.createImageData(SLIDER_W, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      const L = 1 - y / (h - 1);
      const lin = L * L * L;
      const v = Math.max(0, Math.min(255, Math.round(lin2s(lin) * 255)));
      for (let x = 0; x < SLIDER_W; x++) {
        const i = (y * SLIDER_W + x) * 4;
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
      }
    }
    this._bg = img;
  }

  render(L) {
    this.currentL = L;
    const h = this.canvas.height;
    this.ctx.putImageData(this._bg, 0, 0);
    const y = Math.round((1 - L) * (h - 1));
    this.ctx.strokeStyle = "#fff";
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(0, y);
    this.ctx.lineTo(SLIDER_W, y);
    this.ctx.stroke();
  }

  pickL(y) {
    const h = this.canvas.height;
    const clampedY = Math.max(0, Math.min(h - 1, y));
    const L = 1 - clampedY / (h - 1);
    return Math.max(0.05, Math.min(0.95, L));
  }
}
