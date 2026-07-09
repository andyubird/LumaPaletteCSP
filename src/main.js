import { createWheel, WHEEL_RADIUS } from "./wheel.js";
import { SliderRenderer } from "./slider.js";
import { updateInfoBar } from "./ui.js";
import { hexToRgb, rgbToHex } from "./oklch.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow, LogicalSize, PhysicalPosition } = window.__TAURI__.window;
const { availableMonitors } = window.__TAURI__.window;

const wheelCanvas = document.getElementById("wheel");
let wheel = createWheel(wheelCanvas, "oklch");
const slider = new SliderRenderer(document.getElementById("slider"));
const info = document.getElementById("info");
const gamutBtn = document.getElementById("gamut-btn");

let currentHex = "#808080";
let currentL = 0.65;
let lastCspSend = 0;
let currentWheelType = "oklch";
let paletteOffset = "bottom-right";
let language = "en";
let currentSlot = 0; // 0 = main, 1 = sub
let infoMode = { kind: "status", key: "waitingCsp" };
let gamutWarning = false;

const MIN_PALETTE_W = 340;
const MIN_PALETTE_H = 310;
const EDGE_GAP = 30;

function setColor(hex, { sync = true, markerAt = null } = {}) {
  currentHex = hex;
  wheel.setCurrentColor(hex, markerAt);
  infoMode = { kind: "color" };
  updateInfoBar(info, hex, currentSlot, language);
  if (sync) {
    const [r, g, b] = hexToRgb(hex);
    currentL = wheel.rgbToAxis(r, g, b);
    slider.render(currentL);
  }
}

function setPaletteStatus(key) {
  infoMode = { kind: "status", key };
  info.textContent = paletteText(key);
}

function refreshPaletteInfo() {
  if (infoMode.kind === "color") {
    updateInfoBar(info, currentHex, currentSlot, language);
  } else {
    info.textContent = paletteText(infoMode.key);
  }
}

function wheelSupportsGamutWarning() {
  return currentWheelType === "oklch" || currentWheelType === "lab";
}

function updateGamutButton() {
  const supported = wheelSupportsGamutWarning();
  gamutBtn.disabled = !supported;
  gamutBtn.classList.toggle("active", supported && gamutWarning);
  gamutBtn.title = supported
    ? (language === "zh-TW" ? "切換色域警告" : "Toggle gamut warning")
    : (language === "zh-TW" ? "HSV / HSL 不需要色域警告" : "HSV / HSL stay inside sRGB");
}

function applyGamutWarningState() {
  updateGamutButton();
  const supported = wheelSupportsGamutWarning();
  wheel.setGamutWarning(supported && gamutWarning);
}

function renderWheel() {
  wheel.setGamutWarning(wheelSupportsGamutWarning() && gamutWarning, false);
  wheel.render(currentL);
  updateGamutButton();
}

function swapWheel(type) {
  currentWheelType = type || "oklch";
  wheel = createWheel(wheelCanvas, currentWheelType);
  const [r, g, b] = hexToRgb(currentHex);
  currentL = wheel.rgbToAxis(r, g, b);
  wheel.setCurrentColor(currentHex);
  renderWheel();
  slider.render(currentL);
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
  renderWheel();
  slider.render(L);
}

async function showPaletteAt(x, y, r, g, b, slot) {
  if (slot != null) currentSlot = slot;
  if (r != null && g != null && b != null) {
    const hex = rgbToHex(r / 255, g / 255, b / 255);
    setColor(hex, { sync: true });
    renderWheel();
  }
  const win = getCurrentWindow();
  const monitor = await monitorForPoint(x, y);
  const targetSize = await resizePaletteForMonitor(win, monitor);
  const pw = targetSize.width;
  const ph = targetSize.height;
  const bounds = monitorBounds(monitor);

  let wx, wy;
  switch (paletteOffset) {
    case "bottom-left":
      wx = x - pw - EDGE_GAP; wy = y + EDGE_GAP; break;
    case "top-right":
      wx = x + EDGE_GAP; wy = y - ph - EDGE_GAP; break;
    case "top-left":
      wx = x - pw - EDGE_GAP; wy = y - ph - EDGE_GAP; break;
    case "center":
      wx = x - Math.round(pw / 2); wy = y - Math.round(ph / 2); break;
    case "bottom-right":
    default:
      wx = x + EDGE_GAP; wy = y + EDGE_GAP; break;
  }

  // Flip to the opposite side if we'd spill off the monitor the cursor is on.
  if (wx + pw > bounds.right) wx = x - pw - EDGE_GAP;
  if (wx < bounds.left) wx = x + EDGE_GAP;
  if (wy + ph > bounds.bottom) wy = y - ph - EDGE_GAP;
  if (wy < bounds.top) wy = y + EDGE_GAP;

  wx = clampWindowAxis(wx, pw, bounds.left, bounds.right);
  wy = clampWindowAxis(wy, ph, bounds.top, bounds.bottom);

  await win.setPosition(new PhysicalPosition(wx, wy));
  await win.show();
  await win.setFocus();
}

async function resizePaletteForMonitor(win, monitor) {
  const logicalSize = measurePaletteLogicalSize();
  await win.setSize(new LogicalSize(logicalSize.width, logicalSize.height));
  await nextFrame();
  await win.setSize(new LogicalSize(logicalSize.width, logicalSize.height));

  const actual = await win.innerSize();
  const scaleFactor = monitor?.scaleFactor || window.devicePixelRatio || 1;
  return {
    width: Math.max(actual.width, Math.ceil(logicalSize.width * scaleFactor)),
    height: Math.max(actual.height, Math.ceil(logicalSize.height * scaleFactor)),
  };
}

async function preparePaletteWindow() {
  const win = getCurrentWindow();
  let monitor = null;
  try {
    monitor = (await availableMonitors())[0] || null;
  } catch (e) {
    console.warn("prepare availableMonitors:", e);
  }
  await resizePaletteForMonitor(win, monitor);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function measurePaletteLogicalSize() {
  const topbar = document.querySelector(".topbar");
  const container = document.querySelector(".container");
  const width = Math.max(
    MIN_PALETTE_W,
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
    Math.ceil(container?.scrollWidth || 0),
    Math.ceil(topbar?.scrollWidth || 0),
  );
  const height = Math.max(
    MIN_PALETTE_H,
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
    Math.ceil((topbar?.getBoundingClientRect().height || 0) + (container?.scrollHeight || 0)),
  );
  return { width, height };
}

async function monitorForPoint(x, y) {
  try {
    const monitors = await availableMonitors();
    const containing = monitors.find((monitor) => {
      const bounds = monitorBounds(monitor);
      return x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
    });
    if (containing) return containing;

    return monitors
      .map((monitor) => ({ monitor, distance: distanceToMonitor(monitor, x, y) }))
      .sort((a, b) => a.distance - b.distance)[0]?.monitor || null;
  } catch (e) {
    console.warn("availableMonitors:", e);
    return null;
  }
}

function monitorBounds(monitor) {
  const area = monitor?.workArea || monitor;
  const hasFlatRect =
    Number.isFinite(area?.x) &&
    Number.isFinite(area?.y) &&
    Number.isFinite(area?.width) &&
    Number.isFinite(area?.height);
  const position = hasFlatRect ? { x: area.x, y: area.y } : (area?.position || { x: 0, y: 0 });
  const size = hasFlatRect
    ? { width: area.width, height: area.height }
    : (area?.size || { width: 1920, height: 1080 });
  return {
    left: position.x,
    top: position.y,
    right: position.x + size.width,
    bottom: position.y + size.height,
  };
}

function distanceToMonitor(monitor, x, y) {
  const bounds = monitorBounds(monitor);
  const cx = Math.max(bounds.left, Math.min(x, bounds.right));
  const cy = Math.max(bounds.top, Math.min(y, bounds.bottom));
  return (x - cx) ** 2 + (y - cy) ** 2;
}

function clampWindowAxis(pos, size, min, max) {
  if (size >= max - min) return min;
  return Math.max(min, Math.min(pos, max - size));
}

async function bootstrap() {
  renderWheel();
  slider.render(currentL);
  setColor(currentHex, { sync: false });
  setPaletteStatus("waitingCsp");
  await preparePaletteWindow().catch((e) => console.warn("preparePaletteWindow:", e));

  listen("connection-status", (evt) => {
    const { status } = evt.payload;
    if (status === "connected") {
      setPaletteStatus("connected");
      invoke("get_csp_color").catch(() => {});
    } else {
      setPaletteStatus("disconnected");
    }
  });

  listen("color-update", (evt) => {
    const { r, g, b, slot } = evt.payload;
    if (slot != null) currentSlot = slot;
    const hex = rgbToHex(r / 255, g / 255, b / 255);
    setColor(hex, { sync: true });
    renderWheel();
  });

  listen("show-palette", (evt) => {
    const { x, y, r, g, b, slot } = evt.payload;
    showPaletteAt(x, y, r, g, b, slot);
  });

  listen("qr-scan-status", (evt) => {
    const { scanning, message } = evt.payload;
    if (scanning) {
      setPaletteStatus("scanning");
    } else if (message === "already connected") {
      setPaletteStatus("connected");
    } else if (message) {
      info.textContent = ` QR: ${message}`;
    }
  });

  listen("wheel-type-changed", (evt) => {
    swapWheel(evt.payload);
  });

  listen("csp-process-status", (evt) => {
    if (!evt.payload) setPaletteStatus("waitingLaunch");
  });

  // Apply persisted settings from Rust side.
  try {
    const settings = await invoke("get_settings");
    if (settings) {
      language = settings.language || "en";
      if (settings.wheel_type) swapWheel(settings.wheel_type);
      if (settings.palette_offset) {
        paletteOffset = settings.palette_offset;
      }
      setPaletteStatus("waitingCsp");
    }
  } catch (e) {
    console.warn("get_settings:", e);
  }

  listen("palette-offset-changed", (evt) => {
    paletteOffset = evt.payload;
  });

  listen("settings-changed", (evt) => {
    const settings = evt.payload || {};
    language = settings.language || language;
    if (settings.palette_offset) paletteOffset = settings.palette_offset;
    applyGamutWarningState();
    refreshPaletteInfo();
  });

  listen("language-changed", (evt) => {
    language = evt.payload || "en";
    applyGamutWarningState();
    refreshPaletteInfo();
  });

  try {
    const ok = await invoke("try_reconnect_session");
    if (!ok) {
      // If CSP isn't running yet, let the watcher drive the retry — don't
      // kick a scan (which would just log "skipped").
      setPaletteStatus("waitingLaunch");
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
  if (typeof wheel.clampPoint === "function") return wheel.clampPoint(x, y);
  const cx = WHEEL_RADIUS, cy = WHEEL_RADIUS;
  const dx = x - cx, dy = y - cy;
  const dist = Math.hypot(dx, dy);
  const maxR = WHEEL_RADIUS - 1.5;
  if (dist <= maxR) return [x, y];
  const k = maxR / dist;
  return [cx + dx * k, cy + dy * k];
}

function paletteText(key) {
  const zh = language === "zh-TW";
  const text = {
    waitingCsp: zh ? " 等待 CSP…" : " Waiting for CSP…",
    connected: zh ? " 已連線。" : " Connected.",
    disconnected: zh ? " 已中斷。" : " Disconnected.",
    scanning: zh ? " 正在掃描 CSP QR code…" : " Scanning for CSP QR code…",
    waitingLaunch: zh ? " 等待 Clip Studio Paint 啟動…" : " Waiting for CSP to launch…",
  };
  return text[key] || text.waitingCsp;
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
  if (!wheelSupportsGamutWarning()) return;
  gamutWarning = !gamutWarning;
  applyGamutWarningState();
});

bootstrap();
window.__luma = { wheel, slider, setColor, setLightness, invoke };
