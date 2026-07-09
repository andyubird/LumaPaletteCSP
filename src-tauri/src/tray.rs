use tauri::{
    image::Image,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use crate::state::AppState;

fn build_icon() -> Image<'static> {
    // 32x32 RGBA palette-dot.
    let size = 32usize;
    let mut pixels = vec![0u8; size * size * 4];
    let cx = size as f64 / 2.0;
    let cy = size as f64 / 2.0;
    let outer = size as f64 / 2.0 - 1.0;
    let inner = 5.0;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f64 + 0.5 - cx;
            let dy = y as f64 + 0.5 - cy;
            let d = (dx * dx + dy * dy).sqrt();
            let i = (y * size + x) * 4;
            if d > outer {
                pixels[i + 3] = 0;
                continue;
            }
            let (r, g, b) = if d < inner {
                (240u8, 240, 245)
            } else if dx.abs() >= dy.abs() && dx > 0.0 {
                (255, 80, 80)
            } else if dx.abs() >= dy.abs() {
                (80, 120, 255)
            } else if dy > 0.0 {
                (255, 200, 50)
            } else {
                (80, 200, 80)
            };
            pixels[i] = r;
            pixels[i + 1] = g;
            pixels[i + 2] = b;
            pixels[i + 3] = 255;
        }
    }
    Image::new_owned(pixels, size as u32, size as u32)
}

fn shutdown_and_exit(app: &AppHandle) {
    let state: tauri::State<'_, AppState> = app.state();
    if let Some(h) = state.qr_scan.lock().unwrap().take() {
        h.stop();
    }
    if let Some(mut conn) = state.csp.lock().unwrap().take() {
        conn.disconnect();
    }
    for (_, win) in app.webview_windows() {
        let _ = win.hide();
    }
    app.exit(0);
}

pub fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let settings = {
        let state: tauri::State<'_, AppState> = app.state();
        state.settings.get()
    };

    let restrict_toggle = CheckMenuItem::with_id(
        app,
        "toggle-restrict",
        "Only active when CSP is focused",
        true,
        settings.restrict_to_csp,
        None::<&str>,
    )?;

    let wheel_oklch = CheckMenuItem::with_id(
        app,
        "wheel-oklch",
        "OKLCH (perceptual)",
        true,
        settings.wheel_type == "oklch",
        None::<&str>,
    )?;
    let wheel_hsv = CheckMenuItem::with_id(
        app,
        "wheel-hsv",
        "HSV (CSP native)",
        true,
        settings.wheel_type == "hsv",
        None::<&str>,
    )?;
    let wheel_hsl = CheckMenuItem::with_id(
        app,
        "wheel-hsl",
        "HSL (classic)",
        true,
        settings.wheel_type == "hsl",
        None::<&str>,
    )?;
    let wheel_submenu = Submenu::with_items(
        app,
        "Color wheel",
        true,
        &[&wheel_oklch, &wheel_hsv, &wheel_hsl],
    )?;

    // Keep handles so we can enforce radio-button behavior inside the menu
    // event closure (Tauri v2 has no native radio-group menu item).
    let wheel_oklch_h = wheel_oklch.clone();
    let wheel_hsv_h = wheel_hsv.clone();
    let wheel_hsl_h = wheel_hsl.clone();

    // Palette offset submenu — where the popup sits relative to the cursor.
    let offset_presets: &[(&str, &str, &str)] = &[
        ("offset-br", "Bottom-right of cursor", "bottom-right"),
        (
            "offset-bl",
            "Bottom-left of cursor (left-handed)",
            "bottom-left",
        ),
        ("offset-tr", "Top-right of cursor", "top-right"),
        ("offset-tl", "Top-left of cursor", "top-left"),
        ("offset-center", "Centered on cursor", "center"),
    ];
    let mut offset_items: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    for (id, label, val) in offset_presets {
        offset_items.push(CheckMenuItem::with_id(
            app,
            *id,
            *label,
            true,
            settings.palette_offset == *val,
            None::<&str>,
        )?);
    }
    let offset_item_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = offset_items
        .iter()
        .map(|it| it as &dyn IsMenuItem<tauri::Wry>)
        .collect();
    let offset_submenu = Submenu::with_items(app, "Palette offset", true, &offset_item_refs)?;
    let offset_handles: Vec<CheckMenuItem<tauri::Wry>> = offset_items.iter().cloned().collect();
    let offset_map: Vec<(String, String)> = offset_presets
        .iter()
        .map(|(id, _, val)| (id.to_string(), val.to_string()))
        .collect();

    let status_settings = MenuItem::with_id(
        app,
        "status-settings",
        "Status && Settings...",
        true,
        None::<&str>,
    )?;
    let rescan = MenuItem::with_id(
        app,
        "rescan-qr",
        "Disconnect and scan QR...",
        true,
        None::<&str>,
    )?;
    let exit = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
    let sep0 = PredefinedMenuItem::separator(app)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &status_settings,
            &sep0,
            &restrict_toggle,
            &sep,
            &wheel_submenu,
            &offset_submenu,
            &rescan,
            &sep2,
            &exit,
        ],
    )?;

    let icon = build_icon();

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Luma Palette — Waiting for CSP")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let id = event.id.as_ref();
            match id {
                "exit" => shutdown_and_exit(app),
                "status-settings" => {
                    crate::commands::show_status_settings(app);
                }
                "toggle-restrict" => {
                    let state: tauri::State<'_, AppState> = app.state();
                    let new_val = !state.settings.get().restrict_to_csp;
                    crate::commands::RESTRICT_TO_CSP
                        .store(new_val, std::sync::atomic::Ordering::Relaxed);
                    state.settings.update(|s| s.restrict_to_csp = new_val);
                    let _ = app.emit_to_all("restrict-to-csp-changed", new_val);
                    let _ = app.emit_to_all("settings-changed", state.settings.get());
                }
                "wheel-oklch" => {
                    let _ = wheel_oklch_h.set_checked(true);
                    let _ = wheel_hsv_h.set_checked(false);
                    let _ = wheel_hsl_h.set_checked(false);
                    select_wheel(app, "oklch");
                }
                "wheel-hsv" => {
                    let _ = wheel_oklch_h.set_checked(false);
                    let _ = wheel_hsv_h.set_checked(true);
                    let _ = wheel_hsl_h.set_checked(false);
                    select_wheel(app, "hsv");
                }
                "wheel-hsl" => {
                    let _ = wheel_oklch_h.set_checked(false);
                    let _ = wheel_hsv_h.set_checked(false);
                    let _ = wheel_hsl_h.set_checked(true);
                    select_wheel(app, "hsl");
                }
                other if other.starts_with("offset-") => {
                    let Some((_, val)) = offset_map.iter().find(|(oid, _)| oid == other) else {
                        return;
                    };
                    for (i, (oid, _)) in offset_map.iter().enumerate() {
                        let _ = offset_handles[i].set_checked(oid == other);
                    }
                    let state: tauri::State<'_, AppState> = app.state();
                    state.settings.update(|s| s.palette_offset = val.clone());
                    let _ = app.emit_to_all("palette-offset-changed", val.clone());
                    let _ = app.emit_to_all("settings-changed", state.settings.get());
                }
                "rescan-qr" => {
                    let _ = app.emit_to_all("tray-rescan-qr", ());
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, .. } = event {
                if matches!(button, MouseButton::Left) {
                    let app = tray.app_handle();
                    crate::commands::show_status_settings(&app);
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn select_wheel(app: &AppHandle, kind: &str) {
    let state: tauri::State<'_, AppState> = app.state();
    state.settings.update(|s| s.wheel_type = kind.into());
    let _ = app.emit_to_all("wheel-type-changed", kind.to_string());
    let _ = app.emit_to_all("settings-changed", state.settings.get());
}

trait EmitToAll {
    fn emit_to_all<S: serde::Serialize + Clone>(
        &self,
        event: &str,
        payload: S,
    ) -> tauri::Result<()>;
}
impl EmitToAll for AppHandle {
    fn emit_to_all<S: serde::Serialize + Clone>(
        &self,
        event: &str,
        payload: S,
    ) -> tauri::Result<()> {
        use tauri::Emitter;
        self.emit(event, payload)
    }
}
