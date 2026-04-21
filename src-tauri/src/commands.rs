use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::csp::crypto::decode_qr_url;
use crate::csp::session::{clear_session, load_session};
use crate::csp::CSPConnection;
use crate::csp_process;
use crate::input_hook;
use crate::qr;
use crate::state::AppState;
use crate::status::{self, Phase};

const QR_PREFIX: &str = "https://companion.clip-studio.com/";

// Kept for backward-compatibility with the ALT+click hook path; mirrored from
// settings.restrict_to_csp on load.
pub static RESTRICT_TO_CSP: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
pub struct ConnectionStatus {
    pub status: String, // "disconnected" | "connected"
    pub message: Option<String>,
}

fn emit_status(app: &AppHandle, status: &str, message: Option<String>) {
    let _ = app.emit(
        "connection-status",
        ConnectionStatus {
            status: status.to_string(),
            message,
        },
    );
}

#[derive(Serialize, Clone)]
pub struct RgbTuple {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Serialize, Clone)]
pub struct ColorUpdate {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    /// 0 = main/foreground, 1 = sub/background — which slot CSP currently has
    /// selected. Frontend uses it for the status label.
    pub slot: u8,
}

fn emit_color(app: &AppHandle, rgb: (u8, u8, u8), slot: u8) {
    let _ = app.emit(
        "color-update",
        ColorUpdate { r: rgb.0, g: rgb.1, b: rgb.2, slot },
    );
}

#[tauri::command]
pub fn try_reconnect_session(app: AppHandle, state: State<'_, AppState>) -> bool {
    if !csp_process::is_running() {
        // Skip silently — the csp_process watcher will invoke us again once
        // CSP appears, and we don't want to ECONNREFUSED-log on every launch
        // while CSP is closed.
        return false;
    }
    let Some(sess) = load_session() else {
        return false;
    };
    println!(
        "[SESSION] Trying saved session {}:{}...",
        sess.host, sess.port
    );
    let mut conn = CSPConnection::new(
        sess.host,
        sess.port,
        sess.password,
        sess.generation,
        true,
    );
    status::set(&app, Phase::Reconnecting);
    match conn.connect() {
        Ok(()) if conn.connected => {
            let host = conn.host.clone();
            let mut slot = state.csp.lock().unwrap();
            *slot = Some(conn);
            emit_status(&app, "connected", Some("reconnected".into()));
            status::set(&app, Phase::Connected(host));
            println!("[SESSION] Reconnected without QR.");
            true
        }
        Ok(()) => {
            // Auth failure: session is genuinely bad, forget it.
            clear_session();
            false
        }
        Err(e) => {
            // Network-level failure (CSP not ready, port moved, router change).
            // Keep the session — the next attempt may succeed; the QR-scan
            // fallback will recover if it doesn't.
            println!("[SESSION] Saved session failed (keeping): {e}");
            false
        }
    }
}

#[tauri::command]
pub fn connect_via_qr_url(
    url: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cfg = decode_qr_url(&url)?;
    let host = cfg.ips.first().cloned().ok_or("no IP")?;
    println!(
        "[QR] IP: {:?}, Port: {}, Gen: {}",
        cfg.ips, cfg.port, cfg.generation
    );
    let mut conn = CSPConnection::new(
        host,
        cfg.port,
        cfg.password,
        cfg.generation,
        false,
    );
    conn.connect()?;
    if !conn.connected {
        return Err("connection lost after auth".into());
    }
    let host = conn.host.clone();
    let mut slot = state.csp.lock().unwrap();
    *slot = Some(conn);
    emit_status(&app, "connected", Some("qr".into()));
    status::set(&app, Phase::Connected(host));
    Ok(())
}

#[tauri::command]
pub fn get_csp_color(app: AppHandle, state: State<'_, AppState>) -> Option<RgbTuple> {
    let mut slot = state.csp.lock().unwrap();
    let conn = slot.as_mut()?;
    let rgb = conn.get_color_rgb()?;
    let idx = conn.color_index();
    emit_color(&app, rgb, idx);
    Some(RgbTuple { r: rgb.0, g: rgb.1, b: rgb.2 })
}

#[tauri::command]
pub fn set_csp_color(hex: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.csp.lock().unwrap();
    let conn = slot.as_mut().ok_or("not connected")?;
    conn.set_color_hex(&hex);
    Ok(())
}

#[tauri::command]
pub fn connection_status(state: State<'_, AppState>) -> &'static str {
    let slot = state.csp.lock().unwrap();
    match slot.as_ref() {
        Some(c) if c.connected => "connected",
        _ => "disconnected",
    }
}

#[tauri::command]
pub fn disconnect_csp(app: AppHandle, state: State<'_, AppState>) {
    let mut slot = state.csp.lock().unwrap();
    if let Some(c) = slot.as_mut() {
        c.disconnect();
    }
    *slot = None;
    status::set(&app, Phase::Disconnected("user".into()));
}

#[derive(Serialize, Clone)]
pub struct ShowPalettePayload {
    pub x: i32,
    pub y: i32,
    pub r: Option<u8>,
    pub g: Option<u8>,
    pub b: Option<u8>,
    pub slot: Option<u8>,
}

/// Sample current CSP color, then tell the frontend to show the palette at (x, y).
/// Called by the ALT+click hook and the tray left-click.
///
/// Sampling runs on a background thread with a short delay so CSP's built-in
/// ALT+click eyedropper has time to commit the new brush color before we read
/// it. We only emit `show-palette` after the sample lands — this way the
/// frontend positions the marker for the correct color *before* the window
/// appears, avoiding the visible "jump" of the marker circle.
pub fn sample_and_show(app: &AppHandle, x: i32, y: i32) {
    if RESTRICT_TO_CSP.load(Ordering::Relaxed) && !input_hook::is_csp_foreground() {
        return;
    }

    let app_bg = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(180));
        let state: State<'_, AppState> = app_bg.state();
        let (rgb, slot_idx) = {
            let mut slot = state.csp.lock().unwrap();
            match slot.as_mut() {
                Some(c) => (c.get_color_rgb(), Some(c.color_index())),
                None => (None, None),
            }
        };
        let _ = app_bg.emit(
            "show-palette",
            ShowPalettePayload {
                x,
                y,
                r: rgb.map(|c| c.0),
                g: rgb.map(|c| c.1),
                b: rgb.map(|c| c.2),
                slot: slot_idx,
            },
        );
    });
}

#[tauri::command]
pub fn set_restrict_to_csp(state: State<'_, AppState>, enabled: bool) {
    RESTRICT_TO_CSP.store(enabled, Ordering::Relaxed);
    state.settings.update(|s| s.restrict_to_csp = enabled);
}

#[tauri::command]
pub fn get_restrict_to_csp() -> bool {
    RESTRICT_TO_CSP.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> crate::settings::Settings {
    state.settings.get()
}

#[tauri::command]
pub fn set_wheel_type(app: AppHandle, state: State<'_, AppState>, wheel_type: String) {
    state.settings.update(|s| s.wheel_type = wheel_type.clone());
    let _ = app.emit("wheel-type-changed", wheel_type);
}

#[tauri::command]
pub fn set_palette_offset(
    app: AppHandle,
    state: State<'_, AppState>,
    offset: String,
) {
    state.settings.update(|s| s.palette_offset = offset.clone());
    let _ = app.emit("palette-offset-changed", offset);
}

#[tauri::command]
pub fn set_global_hotkey(
    app: AppHandle,
    state: State<'_, AppState>,
    hotkey: String,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let gs = app.global_shortcut();

    // Unregister the previous binding, if any.
    let prev = state.settings.get().global_hotkey;
    if !prev.is_empty() {
        let _ = gs.unregister(prev.as_str());
    }

    if !hotkey.is_empty() {
        gs.register(hotkey.as_str())
            .map_err(|e| format!("register '{hotkey}' failed: {e}"))?;
    }

    state.settings.update(|s| s.global_hotkey = hotkey.clone());
    let _ = app.emit("global-hotkey-changed", hotkey);
    Ok(())
}

fn emit_scan_status(app: &AppHandle, scanning: bool, message: Option<&str>) {
    #[derive(Serialize, Clone)]
    struct ScanStatus<'a> {
        scanning: bool,
        message: Option<&'a str>,
    }
    let _ = app.emit("qr-scan-status", ScanStatus { scanning, message });
}

/// Connect using a freshly decoded QR URL. Runs on the caller's thread (blocking
/// is fine — scan thread already spawned us a separate context).
fn connect_with_url(app: &AppHandle, url: &str) {
    let state: State<'_, AppState> = app.state();
    match decode_qr_url(url) {
        Ok(cfg) => {
            let Some(host) = cfg.ips.first().cloned() else {
                emit_scan_status(app, false, Some("QR had no IPs"));
                return;
            };
            println!(
                "[QR] scanned — IP: {:?}, Port: {}, Gen: {}",
                cfg.ips, cfg.port, cfg.generation
            );
            let mut conn = CSPConnection::new(
                host,
                cfg.port,
                cfg.password,
                cfg.generation,
                false,
            );
            match conn.connect() {
                Ok(()) if conn.connected => {
                    let host = conn.host.clone();
                    let mut slot = state.csp.lock().unwrap();
                    *slot = Some(conn);
                    emit_status(app, "connected", Some("qr-scan".into()));
                    emit_scan_status(app, false, Some("connected"));
                    status::set(app, Phase::Connected(host));
                }
                Ok(()) => emit_scan_status(app, false, Some("auth failed")),
                Err(e) => {
                    println!("[QR] connect failed: {e}");
                    emit_scan_status(app, false, Some("connect failed"));
                }
            }
        }
        Err(e) => {
            println!("[QR] decode failed: {e}");
            emit_scan_status(app, false, Some("decode failed"));
        }
    }
}

/// Start a background monitor scan for the CSP companion QR. Idempotent — if a
/// scan is already running, replaces it. Skipped when CSP isn't detected; the
/// csp_process watcher will call us again once CSP appears.
#[tauri::command]
pub fn start_qr_scan(app: AppHandle, state: State<'_, AppState>) {
    if !csp_process::is_running() {
        emit_scan_status(&app, false, Some("waiting for CSP process"));
        println!("[QR] skipped — CSP not running");
        return;
    }
    {
        let mut slot = state.qr_scan.lock().unwrap();
        if let Some(existing) = slot.take() {
            existing.stop();
        }
    }
    let app_cb = app.clone();
    let handle = qr::spawn_scan(QR_PREFIX.to_string(), 1500, move |url| {
        println!("[QR] found URL on screen");
        connect_with_url(&app_cb, &url);
    });
    *state.qr_scan.lock().unwrap() = Some(handle);
    emit_scan_status(&app, true, Some("scanning"));
    status::set(&app, Phase::Scanning);
    println!("[QR] scan started");
}

#[tauri::command]
pub fn stop_qr_scan(state: State<'_, AppState>) {
    if let Some(h) = state.qr_scan.lock().unwrap().take() {
        h.stop();
    }
}
