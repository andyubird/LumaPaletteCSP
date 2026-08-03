import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_PALETTE_H,
  MIN_PALETTE_W,
  measurePaletteLogicalSize,
} from "../src/palette-layout.js";

function element({ width, height }) {
  return {
    scrollWidth: width,
    scrollHeight: height,
    getBoundingClientRect: () => ({ height }),
  };
}

test("intrinsic palette size remains 340x310 in an oversized viewport", () => {
  const oversizedViewport = { scrollWidth: 380, scrollHeight: 360 };
  const topbar = element({ width: MIN_PALETTE_W, height: 26 });
  const container = element({ width: 316, height: 284 });

  const size = measurePaletteLogicalSize(topbar, container, oversizedViewport);

  assert.deepEqual(size, { width: 340, height: 310 });
});

test("intrinsic content can grow beyond the minimum palette size", () => {
  const topbar = element({ width: 365, height: 28 });
  const container = element({ width: 350, height: 300 });

  assert.deepEqual(measurePaletteLogicalSize(topbar, container), {
    width: 365,
    height: 328,
  });
});
