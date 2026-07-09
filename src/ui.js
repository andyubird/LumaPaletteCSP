import { rgb2oklch, hexToRgb } from "./oklch.js";

export function updateInfoBar(infoEl, hex, slot, language = "en") {
  const [r, g, b] = hexToRgb(hex);
  const [L, C, h] = rgb2oklch(r, g, b);
  const zh = language === "zh-TW";
  const tag = slot === 1 ? (zh ? "副色" : "sub") : slot === 0 ? (zh ? "主色" : "main") : null;
  const prefix = tag ? `[${tag}] ` : " ";
  infoEl.textContent = `${prefix}${hex.toUpperCase()}  L=${Math.round(L * 100)}%  C=${C.toFixed(3)}  H=${Math.round(h)}`;
}
