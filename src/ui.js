import { rgb2oklch, hexToRgb } from "./oklch.js";

export function updateInfoBar(infoEl, hex, slot) {
  const [r, g, b] = hexToRgb(hex);
  const [L, C, h] = rgb2oklch(r, g, b);
  const tag = slot === 1 ? "sub" : slot === 0 ? "main" : null;
  const prefix = tag ? `[${tag}] ` : " ";
  infoEl.textContent = `${prefix}${hex.toUpperCase()}  L=${Math.round(L * 100)}%  C=${C.toFixed(3)}  H=${Math.round(h)}`;
}
