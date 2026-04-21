# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Tauri 2 rewrite of **Luma Palette for Clip Studio Paint** — an OKLCH/HSV/HSL color-picker popup that drives the CSP desktop brush color over CSP's Companion Mode TCP protocol. The Python version (single-file Tk app) lives in the parent `CSPTool/` directory; this is the single-binary successor with a native tray, global hotkey, and WebView2 UI.

## Commands

- Dev run (rebuilds on source change): `npm run tauri dev`
- Release build (Windows: MSI + NSIS in `src-tauri/target/release/bundle/`): `npm run tauri build`
- Rust-only check (skips bundling, faster than dev): `cargo check --manifest-path src-tauri/Cargo.toml`
- CLI bypass (skip QR scan, connect via URL): `luma-palette-csp.exe "https://companion.clip-studio.com/rc/..."`

No test suite yet; the only unit tests are in `src-tauri/src/csp/framing.rs` (`cargo test --manifest-path src-tauri/Cargo.toml`). CSP desktop must be running with "Connect to Smartphone" open to exercise the protocol end-to-end.

## Architecture

The split is deliberate: **Rust owns all CSP connection state; the JS frontend only knows the current color.** This keeps the wire protocol, threading, and OS integration out of WebView2 and makes the palette popup a stateless renderer.

### Rust backend (`src-tauri/src/`)

- `lib.rs` — Tauri bootstrap. Wires every long-running thread: tray, ALT+click hook, CSP process watcher, heartbeat. These threads communicate with Tauri commands via `AppState` (mutexes) and with the frontend via `app.emit(...)` events.
- `state.rs` — `AppState { csp: Mutex<Option<CSPConnection>>, qr_scan: Mutex<Option<QrScanHandle>>, settings: SettingsStore }`. All backend state lives here.
- `csp/` — Companion-mode protocol.
  - `crypto.rs` — `REMOTE_KEY`/`AUTH_KEY` XOR keys and the `RECONNECT_MARKER`. **Load-bearing: do not change without a reference implementation** (keys and the tab-separated QR payload format come from chocolatkey/clipremote).
  - `framing.rs` — Wire format. `TYPE_CLIENT=0x01`, `TERM=0x00`, `RS=0x1E`, `MAX_U32` for HSV scaling. `drain_messages` handles coalesced records per `PROTOCOL.md` in the Python repo.
  - `connection.rs` — `CSPConnection` owns the TCP socket, serial counter, and recv buffer. `absorb_color` tracks `CurrentColorIndex` (0=main, 1=sub) and prefers the selected slot's `HSVColor{Main,Sub}{H,S,V}` over the legacy `HSVColorH/S/V`. `set_color_hex` writes back with `ColorIndex: current_color_index` so edits land in the slot CSP has focused. `get_color_rgb` sends a "stale state" `SyncColorCircleUIState` to force CSP to echo its full current color — documented trick from `PROTOCOL.md`.
  - `session.rs` — `session.json` persistence (host/port/password/generation). Same JSON shape as the Python version so sessions are portable.
- `commands.rs` — `#[tauri::command]` entry points invoked from JS. `sample_and_show` is the single path the ALT+click hook, tray left-click, and global hotkey all funnel through. It **spawns a thread and sleeps 180ms before sampling** to let CSP's built-in ALT+click eyedropper commit the new brush color before we read it, then emits `show-palette` once with the color so the frontend can position the marker *before* the window is shown (fixes the visible marker jump).
- `input_hook.rs` — Platform low-level mouse hook (Windows `SetWindowsHookEx`). ALT+click calls `sample_and_show`. `is_csp_foreground()` gates the hook when the user toggled "only while CSP is focused" (`RESTRICT_TO_CSP` atomic mirrors `settings.restrict_to_csp`).
- `csp_process.rs` — Polls for `CLIPStudioPaint.exe` via `sysinfo`. Drives a running/not-running signal that pauses QR scans and disconnects the socket when CSP closes, and schedules a reconnect-then-scan 4s after CSP reappears.
- `qr.rs` — `xcap` screen capture + `rqrr` QR decode, scanning every 1500ms until a URL with `QR_PREFIX` is found. Runs on its own thread; `QrScanHandle::stop()` tells it to exit.
- `tray.rs` — Tray menu (restrict-to-CSP, wheel type, palette offset, hotkey presets + custom). Menu items are cloned into sync closures *before* being moved into the `TrayIconBuilder` (borrow-checker dance for `CheckMenuItem`/`Submenu` handles).
- `settings.rs` — `settings.json` next to the binary. Uses `#[serde(default)]` helpers (e.g. `always_true`, `default_hotkey`) so older save files keep working after field additions/removals.
- `status.rs` — Single `Phase` enum (`WaitingForCsp` / `Scanning` / `Reconnecting` / `Connected(host)` / `Disconnected(reason)`) that drives the tray tooltip text and frontend status bar.

### Frontend (`src/`)

- `main.js` — Tauri IPC glue. Listens for `connection-status`, `color-update`, `show-palette`, `qr-scan-status`, `wheel-type-changed`, `palette-offset-changed`, `csp-process-status`, `request-custom-hotkey`. Owns `currentSlot`, `paletteOffset`, and the hotkey-capture overlay.
- `wheel.js` — `createWheel(canvas, type)` returns a renderer for `"oklch" | "hsv" | "hsl"`. All wheels share the same `HUE_OFFSET_DEG = 150` convention so **blue sits at the bottom**, matching CSP's own color circle. Swapping types rebuilds the ImageData cache; the marker position is computed from the current color via `hue360ToScreenAngleRad` so it stays correct across swaps.
- `oklch.js` — OKLCH↔sRGB math and `gamutClamp` (20-iter chroma binary search, single chokepoint for out-of-gamut handling). `MAX_CHROMA = 0.20` is tuned to match `WHEEL_RADIUS`; don't change one without the other.
- `color-models.js` — HSV/HSL helpers for the non-OKLCH wheels.
- `slider.js` — Vertical lightness slider; drives `wheel.render(L)`.

### Threading model

Main (Tauri event loop) never blocks on I/O. Work that can block or that runs periodically lives on dedicated threads:

- **CSP socket I/O** — all goes through `CSPConnection` behind `AppState.csp: Mutex<_>`. Commands and heartbeat both acquire the lock.
- **Heartbeat** — 3s loop; also detects dropped sockets and triggers `start_qr_scan`.
- **CSP process watcher** — polls `sysinfo` and posts a single bool via callback; drives connect/disconnect transitions.
- **QR scan** — one thread per active scan; owned by `AppState.qr_scan` so a new scan replaces the old one.
- **ALT+click hook** — Windows low-level hook thread; forwards `(x, y)` into `sample_and_show` which itself spawns a short-lived thread for the 180ms sample delay.
- **Frontend** — strictly a renderer. Canvas pointer events drive `set_csp_color`; a 500ms throttle (`sendColorThrottled` in `main.js`) keeps drag updates from flooding CSP.

### Things that are easy to break

- **XOR keys, framing bytes (`TYPE_CLIENT=0x01`, `TERM=0x00`, `RS=0x1E`), and the tab-separated QR payload** are load-bearing for CSP compatibility — reference the Python repo's `PROTOCOL.md` before touching.
- **`MAX_CHROMA` vs `WHEEL_RADIUS`** are tuned together (see `oklch.js` / `wheel.js`).
- The **180ms delay in `sample_and_show`** is not a hack — removing it resurrects the "picked the pre-eyedropper color" race with CSP's own ALT+click.
- The **single-phase sample-then-show** ordering in `sample_and_show` is load-bearing for the marker-no-jump behavior. Splitting it into "show window, then sample, then correct marker" visibly twitches the UI.
- Tray `CheckMenuItem`/`Submenu` handles must be `clone()`d **before** being moved into the `TrayIconBuilder` closure, otherwise the sync-radio-state listeners don't compile (borrow-after-move).
- Hidden overlay CSS: `#hotkey-overlay` uses `display: flex`, so `[hidden]` needs an explicit `display: none` rule to actually hide — otherwise the HTML `hidden` attribute is silently overridden.
