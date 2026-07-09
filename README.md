# Luma Palette for Clip Studio Paint

[English](#english) | [繁體中文](#繁體中文)

---

<a name="english"></a>
## Luma Palette (English)

Luma Palette is a small Windows color-picker popup for Clip Studio Paint. It
lets you choose colors with OKLCH, HSV, or HSL wheels, then sends the selected
brush color directly to CSP through Companion Mode.

<p align="center">
  <img src="PaletteUI.png" width="300" alt="Luma Palette interface" />
</p>

### Install

1. Download the portable app (`.exe`) or installer (`.msi` / setup `.exe`) from the
   [latest release](https://github.com/andyubird/LumaPaletteCSP/releases/latest).
2. Launch Luma Palette.
3. Make sure Clip Studio Paint is running.

Requires Windows 10 or newer. Windows 11 normally includes the WebView2 runtime;
on Windows 10, install WebView2 if the app asks for it.

For portable use, keep the app in a writable folder. Luma Palette saves
`settings.json` and `session.json` beside the `.exe`.

### First-time pairing

1. In Clip Studio Paint, open `File > Connect to Smartphone`.
2. Keep the Companion Mode QR code visible on screen.
3. Launch Luma Palette. It will scan the screen, find the QR code, and connect.
4. After pairing once, Luma Palette will try to reconnect automatically next time.

<p align="center">
  <img src="ShowCompanionAppQRCode.png" width="300" alt="Show QR Code in CSP" />
</p>

### Usage

- Press `ALT + Left Click` on the canvas to sample the color under the cursor and
  show the palette there. This can be turned off in Status & Settings.
- Open Status & Settings from the tray to record one custom keyboard shortcut.
- Click or drag on the color wheel to change hue and chroma/saturation.
- Click or drag on the vertical slider to change lightness/value.
- Click outside the palette to close it.
- Luma Palette reads and writes the currently selected CSP color slot, so edits
  go to the active main or sub color.

### Tray menu

Click the tray icon to open Status & Settings. Right-click it for the quick menu:

- Status & Settings: connection status, setup help, portable storage, and shortcut settings.
- Wheel type: OKLCH, HSV, or HSL.
- Palette position: bottom-right, bottom-left, top variants, or centered.
- Restrict to CSP: only react while Clip Studio Paint is focused.
- Disconnect and scan QR: clear the saved pairing, disconnect, and scan a new
  Companion Mode QR code.
- Exit: fully quit the app.

### Troubleshooting

- If Luma Palette does not connect, open `File > Connect to Smartphone` in CSP
  again and choose Disconnect and scan QR from the tray menu or settings window.
- If `ALT + Left Click` does nothing, check the tray menu and make sure the app
  is still running. If "Restrict to CSP" is enabled, CSP must be the foreground
  app.
- If the palette shows but the color is stale, wait a moment and sample again;
  CSP sometimes needs a short beat to commit its own eyedropper color.

### Credits

- Companion-mode impersonation idea: Tourbox.
- Reference protocol implementation: chocolatkey/clipremote.
- Protocol notes: [`PROTOCOL.md`](PROTOCOL.md).

MIT licensed.

---

<a name="繁體中文"></a>
## Luma Palette (繁體中文)

Luma Palette 是一個給 Clip Studio Paint 使用的 Windows 調色盤彈出視窗。你可以用
OKLCH、HSV 或 HSL 色環選色，並透過 CSP 的 Companion Mode 直接把顏色同步到目前
的筆刷顏色。

<p align="center">
  <img src="PaletteUI.png" width="300" alt="Luma Palette 介面" />
</p>

### 安裝

1. 請從
   [最新版本](https://github.com/andyubird/LumaPaletteCSP/releases/latest)
   下載可攜版程式 (`.exe`) 或安裝檔 (`.msi` / setup `.exe`)。
2. 啟動 Luma Palette。
3. 確認 Clip Studio Paint 已開啟。

需要 Windows 10 以上。Windows 11 通常已內建 WebView2 runtime；如果 Windows 10
上啟動時提示需要 WebView2，請依照提示安裝。

若要當作可攜版使用，請把程式放在可寫入的資料夾。Luma Palette 會把
`settings.json` 與 `session.json` 存在 `.exe` 旁邊。

### 第一次配對

1. 在 Clip Studio Paint 中開啟 `File > Connect to Smartphone`
   （或「連接智慧型手機」）。
2. 保持 Companion Mode 的 QR Code 顯示在螢幕上。
3. 啟動 Luma Palette。它會自動掃描螢幕、找到 QR Code 並完成連線。
4. 完成一次配對後，Luma Palette 下次會嘗試自動重新連線。

<p align="center">
  <img src="ShowCompanionAppQRCode.png" width="300" alt="在 CSP 顯示 Companion Mode QR Code" />
</p>

### 使用方式

- 在畫布上按 `ALT + 左鍵`，即可吸取游標下方顏色並在游標位置顯示調色盤。這個行為可在
  Status & Settings 中關閉。
- 可從系統匣開啟 Status & Settings，錄製一組自訂鍵盤快捷鍵。
- 點擊或拖曳色環可調整色相與彩度。
- 點擊或拖曳垂直滑桿可調整明度。
- 點擊調色盤外側即可關閉。
- Luma Palette 會讀寫 CSP 目前選取的顏色槽，所以變更會套用到目前的主色或副色。

### 系統匣選單

點擊系統匣圖示會開啟 Status & Settings。按右鍵可使用快速選單：

- Status & Settings：連線狀態、設定說明、可攜版儲存位置與快捷鍵設定。
- 色環類型：OKLCH、HSV 或 HSL。
- 調色盤位置：右下、左下、上方變體或置中。
- 限定 CSP：只有 Clip Studio Paint 在前景時才反應。
- 重新掃描 QR Code：當已儲存的配對無法連線時重新配對。
- 結束：完全關閉程式。

### 疑難排解

- 如果無法連線，請在 CSP 再次開啟 `File > Connect to Smartphone`
  （或「連接智慧型手機」），再從系統匣選單選擇重新掃描。
- 如果 `ALT + 左鍵` 沒有反應，請確認系統匣中的 Luma Palette 仍在執行。如果啟用了
  「限定 CSP」，Clip Studio Paint 必須是目前前景視窗。
- 如果調色盤顯示的顏色不是剛吸到的顏色，請稍等一下再吸一次；CSP 有時需要短暫時間
  才會完成自己的吸色更新。

### 特別致謝

- 感謝 Tourbox 提供 Companion Mode 模擬手機端以取得 / 設定 CSP 畫筆顏色的靈感。
- 感謝 chocolatkey/clipremote 分享 CSP Companion Mode 的參考實作。
- 協定筆記請參考 [`PROTOCOL.md`](PROTOCOL.md)。

本專案採用 [MIT License](LICENSE) 授權。
