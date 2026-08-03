export const MIN_PALETTE_W = 340;
export const MIN_PALETTE_H = 310;

export function measurePaletteLogicalSize(topbar, container) {
  const width = Math.max(
    MIN_PALETTE_W,
    Math.ceil(topbar?.scrollWidth || 0),
    Math.ceil(container?.scrollWidth || 0),
  );
  const height = Math.max(
    MIN_PALETTE_H,
    Math.ceil(
      (topbar?.getBoundingClientRect().height || 0) +
      (container?.scrollHeight || 0),
    ),
  );
  return { width, height };
}
