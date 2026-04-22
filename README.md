# Luma Palette for Clip Studio Paint

An OKLCH color picker popup that drives the Clip Studio Paint brush color over
CSP's Companion Mode protocol. Rewritten from the original Python version as a
Tauri 2 app — a single small binary, no Python runtime, native tray + hotkey.

The original Python single-file version is preserved in this repo
(`luma_palette_csp.py` + `run.bat`) alongside the Tauri source and its
[`PROTOCOL.md`](PROTOCOL.md) reference notes.

## Install

Grab the installer (`.msi` or `.exe`) from the
[latest release](https://github.com/andyubird/LumaPaletteCSP/releases/latest).
Requires Windows 10+ with the WebView2 runtime (ships with Windows 11).

## Features

- OKLCH / HSV / HSL color wheels, blue at the bottom (CSP style).
- ALT+click anywhere to summon the palette at the cursor with CSP's current
  brush color pre-filled.
- Configurable global hotkey (preset list + custom capture).
- Palette-offset modes (bottom-right / bottom-left for left-handers / top
  variants / centered).
- Tray menu: wheel type, hotkey, palette offset, re-scan, restrict-to-CSP.
- Reads and writes the currently selected slot (main / sub).
- Auto-reconnect via the saved Companion session; falls back to on-screen QR
  scan if the saved session is stale.

## Develop

```sh
npm install
npm run tauri dev
```

Requires Rust (stable), Node 18+, and — on Windows — the WebView2 runtime
(ships with Windows 11).

The app connects to CSP via the Companion Mode QR that CSP shows under
`File → Connect to Smartphone`. Once paired, the session persists in
`settings.json` / `session.json` beside the binary.

## Release build

```sh
npm run tauri build
```

Installer and portable exe land in
`src-tauri/target/release/bundle/` — on Windows, `msi/` and `nsis/` by default
(controlled by `bundle.targets` in `src-tauri/tauri.conf.json`).

## Credits

- Companion-mode impersonation trick: Tourbox.
- Reference protocol implementation: chocolatkey/clipremote.
- Protocol notes: [`PROTOCOL.md`](PROTOCOL.md).

MIT licensed.
