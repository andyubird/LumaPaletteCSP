use tauri::{
    image::Image,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Listener, Manager,
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
        ("offset-bl", "Bottom-left of cursor (left-handed)", "bottom-left"),
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
    let offset_submenu =
        Submenu::with_items(app, "Palette offset", true, &offset_item_refs)?;
    let offset_handles: Vec<CheckMenuItem<tauri::Wry>> =
        offset_items.iter().cloned().collect();
    let offset_map: Vec<(String, String)> = offset_presets
        .iter()
        .map(|(id, _, val)| (id.to_string(), val.to_string()))
        .collect();

    // Hotkey submenu — a set of presets plus "Custom…".
    // Tauri's native tray menus can't take text input, so "Custom…" hands off
    // to the palette window which renders a capture overlay.
    let hotkey_presets: &[(&str, &str, &str)] = &[
        ("hotkey-none", "None", ""),
        ("hotkey-alt-p", "Alt+P", "Alt+P"),
        ("hotkey-f7", "F7", "F7"),
        ("hotkey-f8", "F8", "F8"),
        ("hotkey-f9", "F9", "F9"),
        ("hotkey-ctrl-shift-p", "Ctrl+Shift+P", "Ctrl+Shift+P"),
        ("hotkey-ctrl-alt-c", "Ctrl+Alt+C", "Ctrl+Alt+C"),
    ];
    // Show a check next to "Custom…" when the saved hotkey isn't a preset.
    let saved_matches_preset = hotkey_presets
        .iter()
        .any(|(_, _, accel)| *accel == settings.global_hotkey);
    let mut hotkey_items: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    for (id, label, accel) in hotkey_presets {
        hotkey_items.push(CheckMenuItem::with_id(
            app,
            *id,
            *label,
            true,
            settings.global_hotkey == *accel,
            None::<&str>,
        )?);
    }
    // Custom entry — label shows the current custom accel when active.
    let custom_label = if !saved_matches_preset && !settings.global_hotkey.is_empty() {
        format!("Custom… ({})", settings.global_hotkey)
    } else {
        "Custom…".into()
    };
    let hotkey_custom = CheckMenuItem::with_id(
        app,
        "hotkey-custom",
        &custom_label,
        true,
        !saved_matches_preset && !settings.global_hotkey.is_empty(),
        None::<&str>,
    )?;
    let hotkey_item_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = hotkey_items
        .iter()
        .map(|it| it as &dyn IsMenuItem<tauri::Wry>)
        .chain(std::iter::once(&hotkey_custom as &dyn IsMenuItem<tauri::Wry>))
        .collect();
    let parent_label = hotkey_submenu_label(&settings.global_hotkey);
    let hotkey_submenu = Submenu::with_items(app, &parent_label, true, &hotkey_item_refs)?;
    let hotkey_handles: Vec<CheckMenuItem<tauri::Wry>> =
        hotkey_items.iter().cloned().collect();
    let hotkey_custom_h = hotkey_custom.clone();
    let hotkey_map: Vec<(String, String)> = hotkey_presets
        .iter()
        .map(|(id, _, accel)| (id.to_string(), accel.to_string()))
        .collect();

    // Clone-for-sync before handles move into the menu closure below.
    let sync_handles = hotkey_handles.clone();
    let sync_custom = hotkey_custom.clone();
    let sync_submenu = hotkey_submenu.clone();
    let sync_map: Vec<(String, String)> = hotkey_map.clone();

    let rescan = MenuItem::with_id(app, "rescan-qr", "Re-scan QR code…", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &restrict_toggle,
            &sep,
            &wheel_submenu,
            &offset_submenu,
            &hotkey_submenu,
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
                "toggle-restrict" => {
                    let state: tauri::State<'_, AppState> = app.state();
                    let new_val = !state.settings.get().restrict_to_csp;
                    crate::commands::RESTRICT_TO_CSP
                        .store(new_val, std::sync::atomic::Ordering::Relaxed);
                    state.settings.update(|s| s.restrict_to_csp = new_val);
                    let _ = app.emit_to_all("restrict-to-csp-changed", new_val);
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
                    let Some((_, val)) = offset_map.iter().find(|(oid, _)| oid == other)
                    else { return; };
                    for (i, (oid, _)) in offset_map.iter().enumerate() {
                        let _ = offset_handles[i].set_checked(oid == other);
                    }
                    let state: tauri::State<'_, AppState> = app.state();
                    state.settings.update(|s| s.palette_offset = val.clone());
                    let _ = app.emit_to_all("palette-offset-changed", val.clone());
                }
                "rescan-qr" => {
                    let _ = app.emit_to_all("tray-rescan-qr", ());
                }
                "hotkey-custom" => {
                    // Show palette and ask the frontend to capture a combo.
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                    let _ = app.emit_to_all("request-custom-hotkey", ());
                }
                other if other.starts_with("hotkey-") => {
                    let Some((_, accel)) = hotkey_map.iter().find(|(hid, _)| hid == other)
                    else { return; };
                    // Radio UI: only this preset checked; custom unchecked.
                    for (i, (hid, _)) in hotkey_map.iter().enumerate() {
                        let _ = hotkey_handles[i].set_checked(hid == other);
                    }
                    let _ = hotkey_custom_h.set_checked(false);
                    let _ = hotkey_custom_h.set_text("Custom…");
                    let state: tauri::State<'_, AppState> = app.state();
                    let prev = state.settings.get().global_hotkey;
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    let gs = app.global_shortcut();
                    if !prev.is_empty() {
                        let _ = gs.unregister(prev.as_str());
                    }
                    if !accel.is_empty() {
                        if let Err(e) = gs.register(accel.as_str()) {
                            eprintln!("[HOTKEY] register '{accel}' failed: {e}");
                            for (i, (hid, a)) in hotkey_map.iter().enumerate() {
                                let _ = hotkey_handles[i]
                                    .set_checked(a == &prev && !prev.is_empty()
                                        || (prev.is_empty() && hid == "hotkey-none"));
                            }
                            return;
                        }
                    }
                    state.settings.update(|s| s.global_hotkey = accel.clone());
                    let _ = app.emit_to_all("global-hotkey-changed", accel.clone());
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, .. } = event {
                if matches!(button, MouseButton::Left) {
                    let app = tray.app_handle();
                    let _ = app.emit_to_all("tray-show-palette", ());
                }
            }
        })
        .build(app)?;

    app.listen("global-hotkey-changed", move |evt| {
        // Event payload is a JSON string (quoted). Strip quotes if present.
        let raw = evt.payload();
        let accel = raw.trim_matches('"').to_string();
        let mut matched_preset = false;
        for (i, (_, a)) in sync_map.iter().enumerate() {
            let is_match = a == &accel;
            if is_match { matched_preset = true; }
            let _ = sync_handles[i].set_checked(is_match);
        }
        if matched_preset || accel.is_empty() {
            let _ = sync_custom.set_checked(false);
            let _ = sync_custom.set_text("Custom…");
        } else {
            let _ = sync_custom.set_checked(true);
            let _ = sync_custom.set_text(format!("Custom… ({accel})"));
        }
        let _ = sync_submenu.set_text(hotkey_submenu_label(&accel));
    });

    Ok(())
}

/// Label for the tray's `Hotkey` submenu — embeds the active accelerator so
/// the current binding is visible without opening the submenu.
fn hotkey_submenu_label(accel: &str) -> String {
    if accel.is_empty() {
        "Hotkey: off".into()
    } else {
        format!("Hotkey: {accel}")
    }
}

fn select_wheel(app: &AppHandle, kind: &str) {
    let state: tauri::State<'_, AppState> = app.state();
    state.settings.update(|s| s.wheel_type = kind.into());
    let _ = app.emit_to_all("wheel-type-changed", kind.to_string());
}

trait EmitToAll {
    fn emit_to_all<S: serde::Serialize + Clone>(&self, event: &str, payload: S) -> tauri::Result<()>;
}
impl EmitToAll for AppHandle {
    fn emit_to_all<S: serde::Serialize + Clone>(&self, event: &str, payload: S) -> tauri::Result<()> {
        use tauri::Emitter;
        self.emit(event, payload)
    }
}
