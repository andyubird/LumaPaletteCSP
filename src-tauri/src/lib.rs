pub mod color;
pub mod commands;
pub mod csp;
pub mod csp_process;
pub mod input_hook;
pub mod qr;
pub mod settings;
pub mod state;
pub mod status;
pub mod tray;

use std::thread;
use std::time::Duration;

use tauri::{Emitter, Listener, Manager, WindowEvent};

use state::AppState;
use status::Phase;

fn cli_qr_url() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|a| a.starts_with("https://"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch: surface the running app instead of staying silent.
            commands::show_status_settings(app);
            let app = app.clone();
            thread::spawn(move || {
                let state: tauri::State<'_, AppState> = app.state();
                if !commands::try_reconnect_session(app.clone(), state) {
                    let state: tauri::State<'_, AppState> = app.state();
                    commands::start_qr_scan(app.clone(), state);
                }
            });
        }))
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .setup(|app| {
            // Apply persisted settings to in-memory flags.
            let startup_settings = {
                let state: tauri::State<'_, AppState> = app.state();
                let s = state.settings.get();
                commands::RESTRICT_TO_CSP
                    .store(s.restrict_to_csp, std::sync::atomic::Ordering::Relaxed);
                s
            };

            // System tray.
            if let Err(e) = tray::install(&app.handle()) {
                eprintln!("[TRAY] install failed: {e}");
            }
            status::set(&app.handle(), Phase::WaitingForCsp);

            // ALT+click hook — posts into main thread via an event.
            let hook_handle = app.handle().clone();
            input_hook::install_alt_click(move |x, y| {
                commands::sample_after_alt_pick(&hook_handle, x, y);
            });

            let shortcut_settings_handle = app.handle().clone();
            let shortcut_action_handle = app.handle().clone();
            input_hook::install_shortcut(
                move || {
                    let state: tauri::State<'_, AppState> = shortcut_settings_handle.state();
                    state.settings.get().global_hotkey
                },
                move || {
                    let (x, y) = get_cursor_pos();
                    commands::sample_and_show(&shortcut_action_handle, x, y);
                },
            );

            // Wire tray menu events to app-level actions.
            let toggle_handle = app.handle().clone();
            app.listen("tray-toggle-restrict", move |_| {
                let cur = commands::RESTRICT_TO_CSP.load(std::sync::atomic::Ordering::Relaxed);
                commands::RESTRICT_TO_CSP.store(!cur, std::sync::atomic::Ordering::Relaxed);
                let _ = toggle_handle.emit("restrict-to-csp-changed", !cur);
            });

            let show_handle = app.handle().clone();
            app.listen("tray-show-palette", move |_| {
                // Tray left-click → sample at last known cursor via OS.
                let (x, y) = get_cursor_pos();
                commands::sample_and_show(&show_handle, x, y);
            });

            let rescan_handle = app.handle().clone();
            app.listen("tray-rescan-qr", move |_| {
                let state: tauri::State<'_, AppState> = rescan_handle.state();
                commands::disconnect_and_scan_qr(rescan_handle.clone(), state);
            });

            // CSP process watcher — pauses/resumes QR scanning as the user
            // opens and closes Clip Studio Paint.
            let proc_handle = app.handle().clone();
            csp_process::spawn_watcher(move |running| {
                let _ = proc_handle.emit("csp-process-status", running);
                let state: tauri::State<'_, AppState> = proc_handle.state();
                if running {
                    let connected = state
                        .csp
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|c| c.connected)
                        .unwrap_or(false);
                    if !connected {
                        // CSP just appeared. Give it a few seconds to finish
                        // booting its Companion server, then try the saved
                        // session first (new generation, same IP) and only
                        // fall back to a full QR scan if that fails.
                        let app = proc_handle.clone();
                        thread::spawn(move || {
                            thread::sleep(Duration::from_secs(4));
                            let ok = {
                                let st: tauri::State<'_, AppState> = app.state();
                                commands::try_reconnect_session(app.clone(), st)
                            };
                            if !ok {
                                let app2 = app.clone();
                                let st: tauri::State<'_, AppState> = app.state();
                                commands::start_qr_scan(app2, st);
                            }
                        });
                    }
                } else {
                    if let Some(h) = state.qr_scan.lock().unwrap().take() {
                        h.stop();
                    }
                    let was_connected = {
                        let mut slot = state.csp.lock().unwrap();
                        let had = slot.is_some();
                        if let Some(mut c) = slot.take() {
                            c.disconnect();
                        }
                        had
                    };
                    let _ = proc_handle.emit(
                        "connection-status",
                        commands::ConnectionStatus {
                            status: "disconnected".into(),
                            message: Some("CSP not running".into()),
                        },
                    );
                    if was_connected {
                        status::set(&proc_handle, Phase::Disconnected("CSP closed".into()));
                    } else {
                        status::set(&proc_handle, Phase::WaitingForCsp);
                    }
                }
            });

            // Heartbeat thread — also watches for dropped connections and
            // auto-starts a QR re-scan when the socket dies (subject to CSP
            // process gating).
            let hb_handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(3));
                let state: tauri::State<'_, AppState> = hb_handle.state();
                let dropped = {
                    let mut slot = state.csp.lock().unwrap();
                    if let Some(conn) = slot.as_mut() {
                        conn.heartbeat();
                        if !conn.connected {
                            *slot = None;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                };
                if dropped {
                    let _ = hb_handle.emit(
                        "connection-status",
                        commands::ConnectionStatus {
                            status: "disconnected".into(),
                            message: Some("socket dropped".into()),
                        },
                    );
                    status::set(&hb_handle, Phase::Disconnected("socket dropped".into()));
                    let scan_state: tauri::State<'_, AppState> = hb_handle.state();
                    commands::start_qr_scan(hb_handle.clone(), scan_state);
                }
            });

            // CLI arg: a QR URL bypasses the scan entirely.
            if let Some(url) = cli_qr_url() {
                let url_handle = app.handle().clone();
                thread::spawn(move || {
                    let state: tauri::State<'_, AppState> = url_handle.state();
                    if let Err(e) = commands::connect_via_qr_url(url, url_handle.clone(), state) {
                        eprintln!("[CLI] connect_via_qr_url failed: {e}");
                    }
                });
            }

            // Hide the main window when it loses focus (click-outside-to-dismiss).
            if let Some(win) = app.get_webview_window("main") {
                let win_clone = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        let _ = win_clone.hide();
                    }
                });
            }

            // Settings window closes to tray; the palette window keeps its own
            // click-outside-to-hide behavior above.
            if let Some(win) = app.get_webview_window("settings") {
                let win_clone = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win_clone.hide();
                    }
                });
            }

            if !startup_settings.has_seen_welcome {
                commands::show_status_settings(&app.handle());
                let state: tauri::State<'_, AppState> = app.state();
                state.settings.update(|s| s.has_seen_welcome = true);
            } else if startup_settings.notify_on_startup {
                status::notify_startup(&app.handle(), &startup_settings.global_hotkey);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_snapshot,
            commands::open_status_settings,
            commands::close_status_settings,
            commands::mark_welcome_seen,
            commands::try_reconnect_session,
            commands::connect_via_qr_url,
            commands::get_csp_color,
            commands::set_csp_color,
            commands::connection_status,
            commands::disconnect_csp,
            commands::disconnect_and_scan_qr,
            commands::set_restrict_to_csp,
            commands::get_restrict_to_csp,
            commands::get_settings,
            commands::set_wheel_type,
            commands::set_palette_offset,
            commands::set_show_after_alt_pick,
            commands::set_global_hotkey,
            commands::show_palette_at_cursor,
            commands::start_qr_scan,
            commands::stop_qr_scan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(target_os = "windows")]
fn get_cursor_pos() -> (i32, i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        (pt.x, pt.y)
    }
}

#[cfg(not(target_os = "windows"))]
fn get_cursor_pos() -> (i32, i32) {
    (100, 100)
}
