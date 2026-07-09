const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const statusLabel = document.getElementById("status-label");
const connectionPill = document.getElementById("connection-pill");
const portableWarning = document.getElementById("portable-warning");
const settingsPath = document.getElementById("settings-path");
const sessionPath = document.getElementById("session-path");
const scanBtn = document.getElementById("scan-btn");
const showPaletteBtn = document.getElementById("show-palette-btn");
const languageSelect = document.getElementById("language-select");
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
let language = "en";

const I18N = {
  en: {
    documentTitle: "Luma Palette Settings",
    starting: "Starting...",
    checking: "Checking",
    portableTitle: "Portable storage needs attention",
    portableBody: "Luma Palette saves settings.json and session.json beside the app. Move the app to a writable folder if settings or pairing do not persist.",
    setup: "Setup",
    language: "Language",
    step1: "Open Clip Studio Paint.",
    step2: "Choose File > Connect to Smartphone.",
    step3: "Keep the QR code visible while Luma Palette scans.",
    disconnectScan: "Disconnect and scan QR",
    forgetScan: "Forget session and scan QR",
    showPalette: "Show palette now",
    colorPicking: "Color picking",
    altPickTitle: "Show palette after ALT color pick",
    altPickHelp: "After CSP samples the canvas color, Luma Palette opens at the cursor.",
    paletteSettings: "Palette settings",
    restrictTitle: "Only respond when CSP is focused",
    restrictHelp: "Ignore palette shortcuts and ALT color pick while another app is active.",
    colorWheel: "Color wheel",
    palettePosition: "Palette position",
    keyboardShortcut: "Keyboard shortcut",
    shortcutTitle: "Enable keyboard shortcut",
    shortcutHelp: "Use one custom shortcut to show the palette at the cursor.",
    recordShortcut: "Record shortcut",
    clear: "Clear",
    pressKeys: "Press keys...",
    escCancels: "Esc cancels",
    storage: "Storage",
    settings: "Settings",
    pairing: "Pairing",
    close: "Close to tray",
    off: "Off",
    connected: "Connected",
    scanning: "Scanning",
    reconnecting: "Reconnecting",
    disconnected: "Disconnected",
    waiting: "Waiting",
    waitingCsp: "Waiting for Clip Studio Paint",
    tryingSession: "Trying saved Companion Mode session",
    connectedTo: "Connected to CSP at {detail}",
    disconnectedReason: "Disconnected: {detail}",
    clearingConnected: "Disconnecting and clearing saved pairing...",
    clearing: "Clearing saved pairing...",
    shortcutCanceled: "Shortcut recording canceled.",
    registering: "Registering shortcut...",
    shortcutSet: "Shortcut set to {shortcut}.",
    pressAnother: "Press another shortcut...",
    shortcutDisabled: "Keyboard shortcut disabled.",
    shortcutCleared: "Keyboard shortcut cleared.",
    unavailable: "Unavailable",
    wheelOklch: "OKLCH (perceptual)",
    wheelHsv: "HSV (CSP native)",
    wheelHsl: "HSL (classic)",
    wheelLab: "Photoshop Lab",
    posBr: "Bottom-right of cursor",
    posBl: "Bottom-left of cursor (left-handed)",
    posTr: "Top-right of cursor",
    posTl: "Top-left of cursor",
    posCenter: "Centered on cursor",
  },
  "zh-TW": {
    documentTitle: "Luma Palette 設定",
    starting: "啟動中...",
    checking: "檢查中",
    portableTitle: "可攜式儲存需要注意",
    portableBody: "Luma Palette 會把 settings.json 和 session.json 儲存在程式旁邊。如果設定或配對無法保存，請把程式移到可寫入的資料夾。",
    setup: "設定",
    language: "語言",
    step1: "開啟 Clip Studio Paint。",
    step2: "選擇「檔案 > 連接至智慧型手機」。",
    step3: "掃描時請讓 QR code 保持顯示。",
    disconnectScan: "中斷並掃描 QR",
    forgetScan: "清除配對並掃描 QR",
    showPalette: "立即顯示調色盤",
    colorPicking: "取色",
    altPickTitle: "ALT 取色後顯示調色盤",
    altPickHelp: "CSP 完成畫布取色後，Luma Palette 會在游標旁開啟。",
    paletteSettings: "調色盤設定",
    restrictTitle: "只在 CSP 作用中時回應",
    restrictHelp: "其他程式作用中時，忽略快捷鍵與 ALT 取色。",
    colorWheel: "色盤模式",
    palettePosition: "調色盤位置",
    keyboardShortcut: "鍵盤快捷鍵",
    shortcutTitle: "啟用鍵盤快捷鍵",
    shortcutHelp: "使用一組自訂快捷鍵在游標旁顯示調色盤。",
    recordShortcut: "錄製快捷鍵",
    clear: "清除",
    pressKeys: "請按下按鍵...",
    escCancels: "Esc 取消",
    storage: "儲存位置",
    settings: "設定",
    pairing: "配對",
    close: "關閉到系統匣",
    off: "關閉",
    connected: "已連線",
    scanning: "掃描中",
    reconnecting: "重新連線",
    disconnected: "已中斷",
    waiting: "等待中",
    waitingCsp: "等待 Clip Studio Paint",
    tryingSession: "嘗試使用已儲存的 Companion Mode 配對",
    connectedTo: "已連線到 CSP：{detail}",
    disconnectedReason: "已中斷：{detail}",
    clearingConnected: "正在中斷並清除已儲存配對...",
    clearing: "正在清除已儲存配對...",
    shortcutCanceled: "已取消錄製快捷鍵。",
    registering: "正在設定快捷鍵...",
    shortcutSet: "快捷鍵已設定為 {shortcut}。",
    pressAnother: "請按另一組快捷鍵...",
    shortcutDisabled: "鍵盤快捷鍵已停用。",
    shortcutCleared: "鍵盤快捷鍵已清除。",
    unavailable: "無法取得",
    wheelOklch: "OKLCH（感知均勻）",
    wheelHsv: "HSV（CSP 原生）",
    wheelHsl: "HSL（傳統）",
    wheelLab: "Photoshop Lab",
    posBr: "游標右下",
    posBl: "游標左下（左手模式）",
    posTr: "游標右上",
    posTl: "游標左上",
    posCenter: "以游標置中",
  },
};

function t(key, vars = {}) {
  const dict = I18N[language] || I18N.en;
  let value = dict[key] || I18N.en[key] || key;
  for (const [name, replacement] of Object.entries(vars)) {
    value = value.replace(`{${name}}`, replacement);
  }
  return value;
}

function setText(selector, key) {
  const el = document.querySelector(selector);
  if (el) el.textContent = t(key);
}

function setOptionText(selector, key) {
  const option = document.querySelector(selector);
  if (option) option.textContent = t(key);
}

function applyLanguage() {
  document.documentElement.lang = language === "zh-TW" ? "zh-Hant" : "en";
  document.title = t("documentTitle");
  setText("#portable-warning h2", "portableTitle");
  setText("#portable-warning p", "portableBody");
  setText("main section:nth-of-type(2) h2", "setup");
  setText("label[for='language-select']", "language");
  setText("ol li:nth-child(1)", "step1");
  setText("ol li:nth-child(2)", "step2");
  setText("ol li:nth-child(3)", "step3");
  showPaletteBtn.textContent = t("showPalette");
  setText("main section:nth-of-type(3) h2", "colorPicking");
  setText("#alt-pick-toggle + span strong", "altPickTitle");
  setText("#alt-pick-toggle + span small", "altPickHelp");
  setText("main section:nth-of-type(4) h2", "paletteSettings");
  setText("#restrict-toggle + span strong", "restrictTitle");
  setText("#restrict-toggle + span small", "restrictHelp");
  setText("label[for='wheel-type']", "colorWheel");
  setText("label[for='palette-offset']", "palettePosition");
  setText("main section:nth-of-type(5) h2", "keyboardShortcut");
  setText("#shortcut-enabled + span strong", "shortcutTitle");
  setText("#shortcut-enabled + span small", "shortcutHelp");
  recordShortcutBtn.textContent = t("recordShortcut");
  clearShortcutBtn.textContent = t("clear");
  document.querySelector("#capture-box span").textContent = t("escCancels");
  setText("main section:nth-of-type(6) h2", "storage");
  setText("dt:nth-of-type(1)", "settings");
  setText("dt:nth-of-type(2)", "pairing");
  closeBtn.textContent = t("close");

  setOptionText("#wheel-type option[value='oklch']", "wheelOklch");
  setOptionText("#wheel-type option[value='hsv']", "wheelHsv");
  setOptionText("#wheel-type option[value='hsl']", "wheelHsl");
  setOptionText("#wheel-type option[value='lab']", "wheelLab");
  setOptionText("#palette-offset option[value='bottom-right']", "posBr");
  setOptionText("#palette-offset option[value='bottom-left']", "posBl");
  setOptionText("#palette-offset option[value='top-right']", "posTr");
  setOptionText("#palette-offset option[value='top-left']", "posTl");
  setOptionText("#palette-offset option[value='center']", "posCenter");
}

function renderPhase(phase) {
  statusLabel.textContent = phaseText(phase);
  const key = phase?.phase || "waiting_for_csp";
  connectionPill.className = key;
  connectionPill.textContent = pillText(key);
}

function phaseText(phase) {
  const key = phase?.phase || "waiting_for_csp";
  const detail = phase?.detail || "";
  switch (key) {
    case "connected": return t("connectedTo", { detail });
    case "scanning": return t("scanning");
    case "reconnecting": return t("tryingSession");
    case "disconnected": return t("disconnectedReason", { detail });
    case "waiting_for_csp":
    default: return t("waitingCsp");
  }
}

function pillText(key) {
  switch (key) {
    case "connected": return t("connected");
    case "scanning": return t("scanning");
    case "reconnecting": return t("reconnecting");
    case "disconnected": return t("disconnected");
    case "waiting_for_csp":
    default: return t("waiting");
  }
}

function renderSettings(settings) {
  language = settings.language || "en";
  languageSelect.value = language;
  currentShortcut = settings.global_hotkey || "";
  altPickToggle.checked = !!settings.show_after_alt_pick;
  restrictToggle.checked = !!settings.restrict_to_csp;
  wheelType.value = settings.wheel_type || "oklch";
  paletteOffset.value = settings.palette_offset || "bottom-right";
  shortcutEnabled.checked = currentShortcut.length > 0;
  shortcutValue.textContent = currentShortcut || t("off");
  clearShortcutBtn.disabled = !currentShortcut;
  applyLanguage();
  renderScanAction(connected);
}

function renderPortable(portable) {
  portableWarning.hidden = !!portable.exe_dir_writable;
  settingsPath.textContent = portable.settings_path || t("unavailable");
  sessionPath.textContent = portable.session_path || t("unavailable");
}

function renderScanAction(isConnected) {
  connected = !!isConnected;
  scanBtn.textContent = connected ? t("disconnectScan") : t("forgetScan");
}

async function refresh() {
  const snapshot = await invoke("get_app_snapshot");
  renderSettings(snapshot.settings);
  renderPhase(snapshot.phase);
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
  captureValue.textContent = t("pressKeys");
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
    shortcutMessage.textContent = t("shortcutCanceled");
    stopCapture();
    return;
  }

  const accel = accelFromEvent(e);
  if (!accel) return;

  captureValue.textContent = accel;
  shortcutMessage.textContent = t("registering");
  try {
    await invoke("set_global_hotkey", { hotkey: accel });
    shortcutMessage.textContent = t("shortcutSet", { shortcut: accel });
    stopCapture();
    await refresh();
  } catch (err) {
    shortcutMessage.textContent = String(err);
    captureValue.textContent = t("pressAnother");
  }
}

scanBtn.addEventListener("click", () => {
  scanBtn.disabled = true;
  statusLabel.textContent = connected ? t("clearingConnected") : t("clearing");
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

languageSelect.addEventListener("change", async () => {
  language = languageSelect.value;
  applyLanguage();
  renderScanAction(connected);
  await invoke("set_language", { language });
  await refresh();
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
  shortcutMessage.textContent = t("shortcutDisabled");
  await refresh();
});

recordShortcutBtn.addEventListener("click", startCapture);

clearShortcutBtn.addEventListener("click", async () => {
  await invoke("set_global_hotkey", { hotkey: "" });
  shortcutMessage.textContent = t("shortcutCleared");
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
  shortcutValue.textContent = currentShortcut || t("off");
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
