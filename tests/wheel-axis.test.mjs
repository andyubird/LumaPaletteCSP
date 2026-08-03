import test from "node:test";
import assert from "node:assert/strict";

import { createWheel } from "../src/wheel.js";
import { SliderRenderer } from "../src/slider.js";

function fakeContext() {
  return {
    arc() {},
    beginPath() {},
    createImageData(width, height) {
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
    fill() {},
    lineTo() {},
    moveTo() {},
    putImageData() {},
    stroke() {},
  };
}

function fakeCanvas() {
  const context = fakeContext();
  return {
    getContext: () => context,
    height: 0,
    width: 0,
  };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/;

for (const type of ["oklch", "hsv", "hsl", "lab"]) {
  test(`${type} axis edits preserve the selected point at both endpoints`, () => {
    const wheel = createWheel(fakeCanvas(), type);
    wheel.setCurrentColor("#c45a73");
    const sampledPoint = wheel.getSelectedPoint();

    const sampledLow = wheel.colorAtAxis(0);
    const sampledHigh = wheel.colorAtAxis(1);

    assert.match(sampledLow, HEX_COLOR);
    assert.match(sampledHigh, HEX_COLOR);
    assert.notEqual(sampledLow, "#c45a73");
    assert.notEqual(sampledHigh, "#c45a73");
    assert.notEqual(sampledLow, sampledHigh);
    assert.deepEqual(wheel.getSelectedPoint(), sampledPoint);

    assert.match(wheel.pickAt(185, 105), HEX_COLOR);
    const interactedPoint = wheel.getSelectedPoint();
    const interactedLow = wheel.colorAtAxis(0);
    const interactedHigh = wheel.colorAtAxis(1);

    assert.notEqual(interactedLow, interactedHigh);
    assert.deepEqual(wheel.getSelectedPoint(), interactedPoint);
  });
}

test("slider exposes the complete 0 to 100 percent range", () => {
  const slider = new SliderRenderer(fakeCanvas());

  assert.equal(slider.pickL(0), 1);
  assert.equal(slider.pickL(slider.canvas.height - 1), 0);
  assert.equal(slider.pickL(-100), 1);
  assert.equal(slider.pickL(slider.canvas.height + 100), 0);
});
