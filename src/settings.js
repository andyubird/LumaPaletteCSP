const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const statusLabel = document.getElementById("status-label");
const connectionPill = document.getElementById("connection-pill");
const portableWarning = document.getElementById("portable-warning");
const settingsPath = document.getElementById("settings-path");
const sessionPath = document.getElementById("session-path");
const scanBtn = document.getElementById("scan-btn");
const showPaletteBtn = document.getElementById("show-palette-btn");
const altPickToggle = document.getElementById("alt-pick-toggle");
const restrictToggle = document.getElementById("restrict-toggle");
const wheelType = document.getElementById("wheel-type");
const paletteOffset = document.getElementById("palette-offset");
const shortcutEnabled = document.getElementById("shortcut-enabled");
const shortcutValue = document.getElementById("shortcut-value");
const recordShortcutBtn = document.getElementById("record-shortcut-btn");
const clearShortcutBtn = document.getElementById("clear-shortcut-btn");
const captureBox = document.getElementById("capture-box");
const captureValue = document.getElementById("capture-value");
const shortcutMessage = document.getElementById("shortcut-message");
const closeBtn = document.getElementById("close-btn");

let currentShortcut = "";
let captureActive = false;
let connected = false;

function renderPhase(phase) {
  statusLabel.textContent = phase?.label || "Waiting for app status";
  const key = phase?.phase || "waiting_for_csp";
  connectionPill.className = key;
  connectionPill.textContent = pillText(key);
}

function pillText(key) {
  switch (key) {
    case "connected": return "Connected";
    case "scanning": return "Scanning";
    case "reconnecting": return "Reconnecting";
    case "disconnected": return "Disconnected";
    case "waiting_for_csp":
    default: return "Waiting";
  }
}

function renderSettings(settings) {
  currentShortcut = settings.global_hotkey || "";
  altPickToggle.checked = !!settings.show_after_alt_pick;
  restrictToggle.checked = !!settings.restrict_to_csp;
  wheelType.value = settings.wheel_type || "oklch";
  paletteOffset.value = settings.palette_offset || "bottom-right";
  shortcutEnabled.checked = currentShortcut.length > 0;
  shortcutValue.textContent = currentShortcut || "Off";
  clearShortcutBtn.disabled = !currentShortcut;
}

function renderPortable(portable) {
  portableWarning.hidden = !!portable.exe_dir_writable;
  settingsPath.textContent = portable.settings_path || "Unavailable";
  sessionPath.textContent = portable.session_path || "Unavailable";
}

function renderScanAction(isConnected) {
  connected = !!isConnected;
  scanBtn.textContent = connected ? "Disconnect and scan QR" : "Forget session and scan QR";
}

async function refresh() {
  const snapshot = await invoke("get_app_snapshot");
  renderPhase(snapshot.phase);
  renderSettings(snapshot.settings);
  renderPortable(snapshot.portable);
  renderScanAction(snapshot.connected);
}

function accelFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Super");

  let key = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  if (key === " ") key = "Space";
  else if (/^F\d+$/.test(key)) { /* keep F1..F24 */ }
  else if (key.length === 1) key = key.toUpperCase();
  else key = key.charAt(0).toUpperCase() + key.slice(1);

  parts.push(key);
  return parts.join("+");
}

function startCapture() {
  captureActive = true;
  captureValue.textContent = "Press keys...";
  captureBox.hidden = false;
  shortcutMessage.textContent = "";
  document.addEventListener("keydown", onCaptureKey, true);
}

function stopCapture() {
  captureActive = false;
  captureBox.hidden = true;
  document.removeEventListener("keydown", onCaptureKey, true);
}

async function onCaptureKey(e) {
  if (!captureActive) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === "Escape") {
    shortcutMessage.textContent = "Shortcut recording canceled.";
    stopCapture();
    return;
  }

  const accel = accelFromEvent(e);
  if (!accel) return;

  captureValue.textContent = accel;
  shortcutMessage.textContent = "Registering shortcut...";
  try {
    await invoke("set_global_hotkey", { hotkey: accel });
    shortcutMessage.textContent = `Shortcut set to ${accel}.`;
    stopCapture();
    await refresh();
  } catch (err) {
    shortcutMessage.textContent = String(err);
    captureValue.textContent = "Press another shortcut...";
  }
}

scanBtn.addEventListener("click", () => {
  scanBtn.disabled = true;
  statusLabel.textContent = connected ? "Disconnecting and clearing saved pairing..." : "Clearing saved pairing...";
  invoke("disconnect_and_scan_qr").then(refresh).catch((err) => {
    statusLabel.textContent = String(err);
  }).finally(() => {
    scanBtn.disabled = false;
  });
});

showPaletteBtn.addEventListener("click", () => {
  invoke("show_palette_at_cursor").catch((err) => {
    statusLabel.textContent = String(err);
  });
});

altPickToggle.addEventListener("change", async () => {
  await invoke("set_show_after_alt_pick", { enabled: altPickToggle.checked });
  await refresh();
});

restrictToggle.addEventListener("change", async () => {
  await invoke("set_restrict_to_csp", { enabled: restrictToggle.checked });
  await refresh();
});

wheelType.addEventListener("change", async () => {
  await invoke("set_wheel_type", { wheelType: wheelType.value });
  await refresh();
});

paletteOffset.addEventListener("change", async () => {
  await invoke("set_palette_offset", { offset: paletteOffset.value });
  await refresh();
});

shortcutEnabled.addEventListener("change", async () => {
  if (shortcutEnabled.checked) {
    if (!currentShortcut) startCapture();
    return;
  }
  await invoke("set_global_hotkey", { hotkey: "" });
  shortcutMessage.textContent = "Keyboard shortcut disabled.";
  await refresh();
});

recordShortcutBtn.addEventListener("click", startCapture);

clearShortcutBtn.addEventListener("click", async () => {
  await invoke("set_global_hotkey", { hotkey: "" });
  shortcutMessage.textContent = "Keyboard shortcut cleared.";
  await refresh();
});

closeBtn.addEventListener("click", () => {
  invoke("mark_welcome_seen").finally(() => invoke("close_status_settings"));
});

listen("phase-changed", (evt) => renderPhase(evt.payload));
listen("settings-changed", (evt) => renderSettings(evt.payload));
listen("global-hotkey-changed", (evt) => {
  currentShortcut = evt.payload || "";
  shortcutEnabled.checked = currentShortcut.length > 0;
  shortcutValue.textContent = currentShortcut || "Off";
  clearShortcutBtn.disabled = !currentShortcut;
});
listen("qr-scan-status", async (evt) => {
  try {
    const snapshot = await invoke("get_app_snapshot");
    renderPhase(snapshot.phase);
    renderScanAction(snapshot.connected);
    if (!evt.payload?.scanning && evt.payload?.message && !snapshot.connected) {
      statusLabel.textContent = evt.payload.message;
    }
  } catch (err) {
    statusLabel.textContent = String(err);
  }
});
listen("csp-process-status", () => {
  refresh().catch((err) => {
    statusLabel.textContent = String(err);
  });
});

invoke("mark_welcome_seen").catch(() => {});
refresh().catch((err) => {
  statusLabel.textContent = String(err);
});
