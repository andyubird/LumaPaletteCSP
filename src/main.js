import { createWheel, WHEEL_RADIUS } from "./wheel.js";
import { SliderRenderer } from "./slider.js";
import { updateInfoBar } from "./ui.js";
import { hexToRgb, rgbToHex } from "./oklch.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow, PhysicalPosition } = window.__TAURI__.window;
const { availableMonitors, primaryMonitor } = window.__TAURI__.window;

const wheelCanvas = document.getElementById("wheel");
let wheel = createWheel(wheelCanvas, "oklch");
const slider = new SliderRenderer(document.getElementById("slider"));
const info = document.getElementById("info");
const gamutBtn = document.getElementById("gamut-btn");

let currentHex = "#808080";
let currentL = 0.65;
let lastCspSend = 0;
let paletteOffset = "bottom-right";
let currentSlot = 0; // 0 = main, 1 = sub

const hotkeyOverlay = document.getElementById("hotkey-overlay");
const hotkeyCapture = document.getElementById("hotkey-capture");

function setColor(hex, { sync = true, markerAt = null } = {}) {
  currentHex = hex;
  wheel.setCurrentColor(hex, markerAt);
  updateInfoBar(info, hex, currentSlot);
  if (sync) {
    const [r, g, b] = hexToRgb(hex);
    currentL = wheel.rgbToAxis(r, g, b);
    slider.render(currentL);
  }
}

function swapWheel(type) {
  wheel = createWheel(wheelCanvas, type);
  wheel.setCurrentColor(currentHex);
  wheel.render(currentL);
}

function sendColorNow(hex) {
  invoke("set_csp_color", { hex }).catch((e) => console.warn("set_csp_color:", e));
  lastCspSend = performance.now();
}

function sendColorThrottled(hex) {
  if (performance.now() - lastCspSend >= 500) sendColorNow(hex);
}

function setLightness(L) {
  currentL = L;
  wheel.render(L);
  slider.render(L);
}

async function showPaletteAt(x, y, r, g, b, slot) {
  if (slot != null) currentSlot = slot;
  if (r != null && g != null && b != null) {
    const hex = rgbToHex(r / 255, g / 255, b / 255);
    setColor(hex, { sync: true });
    wheel.render(currentL);
  }
  const win = getCurrentWindow();
  const innerSize = await win.innerSize();
  const pw = innerSize.width;
  const ph = innerSize.height;
  let monitor = null;
  try { monitor = await primaryMonitor(); } catch {}
  let sw = 1920, sh = 1080;
  if (monitor) { sw = monitor.size.width; sh = monitor.size.height; }

  const GAP = 30;
  let wx, wy;
  switch (paletteOffset) {
    case "bottom-left":
      wx = x - pw - GAP; wy = y + GAP; break;
    case "top-right":
      wx = x + GAP;      wy = y - ph - GAP; break;
    case "top-left":
      wx = x - pw - GAP; wy = y - ph - GAP; break;
    case "center":
      wx = x - Math.round(pw / 2); wy = y - Math.round(ph / 2); break;
    case "bottom-right":
    default:
      wx = x + GAP;      wy = y + GAP; break;
  }
  // Flip to the opposite side if we'd spill off the monitor.
  if (wx + pw > sw) wx = x - pw - GAP;
  if (wy + ph > sh) wy = y - ph - GAP;
  if (wx < 0) wx = 0;
  if (wy < 0) wy = 0;
  if (wx + pw > sw) wx = sw - pw;
  if (wy + ph > sh) wy = sh - ph;

  await win.setPosition(new PhysicalPosition(wx, wy));
  await win.show();
  await win.setFocus();
}

async function bootstrap() {
  wheel.render(currentL);
  slider.render(currentL);
  setColor(currentHex, { sync: false });
  info.textContent = " Waiting for CSP…";

  listen("connection-status", (evt) => {
    const { status } = evt.payload;
    if (status === "connected") {
      info.textContent = " Connected.";
      invoke("get_csp_color").catch(() => {});
    } else {
      info.textContent = " Disconnected.";
    }
  });

  listen("color-update", (evt) => {
    const { r, g, b, slot } = evt.payload;
    if (slot != null) currentSlot = slot;
    const hex = rgbToHex(r / 255, g / 255, b / 255);
    setColor(hex, { sync: true });
    wheel.render(currentL);
  });

  listen("show-palette", (evt) => {
    const { x, y, r, g, b, slot } = evt.payload;
    // Normal summon — make sure any stale capture overlay is cleared.
    closeHotkeyCapture();
    showPaletteAt(x, y, r, g, b, slot);
  });

  listen("request-custom-hotkey", () => {
    openHotkeyCapture();
  });

  // If the window loses focus (Tauri hides it on blur) tear down the capture
  // overlay too, otherwise it would still be up on the next summon.
  window.addEventListener("blur", closeHotkeyCapture);

  listen("qr-scan-status", (evt) => {
    const { scanning, message } = evt.payload;
    if (scanning) {
      info.textContent = " Scanning for CSP QR code…";
    } else if (message) {
      info.textContent = ` QR: ${message}`;
    }
  });

  listen("wheel-type-changed", (evt) => {
    swapWheel(evt.payload);
  });

  listen("csp-process-status", (evt) => {
    if (!evt.payload) info.textContent = " Waiting for CSP to launch…";
  });

  // Apply persisted settings from Rust side.
  try {
    const settings = await invoke("get_settings");
    if (settings) {
      if (settings.wheel_type && settings.wheel_type !== "oklch") {
        swapWheel(settings.wheel_type);
      }
      if (settings.palette_offset) {
        paletteOffset = settings.palette_offset;
      }
    }
  } catch (e) {
    console.warn("get_settings:", e);
  }

  listen("palette-offset-changed", (evt) => {
    paletteOffset = evt.payload;
  });

  try {
    const ok = await invoke("try_reconnect_session");
    if (!ok) {
      // If CSP isn't running yet, let the watcher drive the retry — don't
      // kick a scan (which would just log "skipped").
      info.textContent = " Waiting for CSP to launch…";
      invoke("start_qr_scan").catch((e) => console.warn("start_qr_scan:", e));
    }
  } catch (e) {
    console.warn("try_reconnect_session:", e);
  }
}

// Clamp a (possibly outside-the-canvas) point to the wheel's rim so drags off
// the edge keep picking max-chroma colors at the pointed angle instead of
// freezing at the last on-canvas position.
function clampToWheel(x, y) {
  const cx = WHEEL_RADIUS, cy = WHEEL_RADIUS;
  const dx = x - cx, dy = y - cy;
  const dist = Math.hypot(dx, dy);
  const maxR = WHEEL_RADIUS - 1.5;
  if (dist <= maxR) return [x, y];
  const k = maxR / dist;
  return [cx + dx * k, cy + dy * k];
}

// Wheel interaction (pointer capture keeps mousemove flowing when dragging
// outside the canvas, which fixes the color/cursor desync). Handlers bind to
// the canvas element (stable) but always go through the live `wheel` ref so
// they keep working after a wheel-type swap.
let wheelPtrId = null;
wheelCanvas.addEventListener("pointerdown", (e) => {
  wheelCanvas.setPointerCapture(e.pointerId);
  wheelPtrId = e.pointerId;
  const [px, py] = clampToWheel(e.offsetX, e.offsetY);
  const hex = wheel.pickAt(px, py);
  if (hex) { setColor(hex, { sync: false, markerAt: [px, py] }); sendColorNow(hex); }
});
wheelCanvas.addEventListener("pointermove", (e) => {
  if (wheelPtrId !== e.pointerId) return;
  const [px, py] = clampToWheel(e.offsetX, e.offsetY);
  const hex = wheel.pickAt(px, py);
  if (hex) { setColor(hex, { sync: false, markerAt: [px, py] }); sendColorThrottled(hex); }
});
function endWheelDrag() {
  if (wheelPtrId === null) return;
  try { wheelCanvas.releasePointerCapture(wheelPtrId); } catch {}
  wheelPtrId = null;
  sendColorNow(currentHex);
}
wheelCanvas.addEventListener("pointerup", endWheelDrag);
wheelCanvas.addEventListener("pointercancel", endWheelDrag);

// Slider interaction (pointer capture too).
let sliderPtrId = null;
slider.canvas.addEventListener("pointerdown", (e) => {
  slider.canvas.setPointerCapture(e.pointerId);
  sliderPtrId = e.pointerId;
  setLightness(slider.pickL(e.offsetY));
});
slider.canvas.addEventListener("pointermove", (e) => {
  if (sliderPtrId !== e.pointerId) return;
  setLightness(slider.pickL(e.offsetY));
});
function endSliderDrag() {
  if (sliderPtrId === null) return;
  try { slider.canvas.releasePointerCapture(sliderPtrId); } catch {}
  sliderPtrId = null;
}
slider.canvas.addEventListener("pointerup", endSliderDrag);
slider.canvas.addEventListener("pointercancel", endSliderDrag);

// Gamut toggle
gamutBtn.addEventListener("click", () => {
  const on = !gamutBtn.classList.contains("active");
  gamutBtn.classList.toggle("active", on);
  wheel.setGamutWarning(on);
});

// Custom hotkey capture overlay. Triggered by the tray's "Custom…" item.
function accelFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Super");
  let key = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  if (key === " ") key = "Space";
  else if (/^F\d+$/.test(key)) { /* F1..F24 */ }
  else if (key.length === 1) key = key.toUpperCase();
  else key = key.charAt(0).toUpperCase() + key.slice(1);
  parts.push(key);
  return parts.join("+");
}

function closeHotkeyCapture() {
  hotkeyOverlay.hidden = true;
  hotkeyCapture.textContent = "…";
  document.removeEventListener("keydown", onHotkeyCaptureKey, true);
}

function onHotkeyCaptureKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") { closeHotkeyCapture(); return; }
  const accel = accelFromEvent(e);
  if (!accel) return;
  hotkeyCapture.textContent = accel;
  invoke("set_global_hotkey", { hotkey: accel })
    .then(() => { setTimeout(closeHotkeyCapture, 350); })
    .catch((err) => {
      hotkeyCapture.textContent = `Rejected: ${err}`;
      setTimeout(closeHotkeyCapture, 1200);
    });
}

function openHotkeyCapture() {
  hotkeyOverlay.hidden = false;
  hotkeyCapture.focus();
  document.addEventListener("keydown", onHotkeyCaptureKey, true);
}

hotkeyOverlay.addEventListener("mousedown", (e) => {
  if (e.target === hotkeyOverlay) closeHotkeyCapture();
});

// Always-on ESC escape hatch — works even if the capture listener never got
// wired up (e.g. overlay was stuck visible from a CSS/attribute mismatch).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !hotkeyOverlay.hidden) {
    e.preventDefault();
    closeHotkeyCapture();
  }
}, true);

bootstrap();
window.__luma = { wheel, slider, setColor, setLightness, invoke };
