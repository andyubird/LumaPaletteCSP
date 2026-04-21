use std::sync::Mutex;

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// High-level app state used for tooltips + notifications.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    WaitingForCsp,
    Scanning,
    Reconnecting,
    Connected(String),
    Disconnected(String),
}

impl Phase {
    fn tooltip(&self) -> String {
        match self {
            Phase::WaitingForCsp => "Luma Palette — Waiting for CSP".into(),
            Phase::Scanning => "Luma Palette — Scanning for QR…".into(),
            Phase::Reconnecting => "Luma Palette — Reconnecting…".into(),
            Phase::Connected(host) => format!("Luma Palette — Connected to {host}"),
            Phase::Disconnected(reason) => format!("Luma Palette — Disconnected ({reason})"),
        }
    }
}

static LAST_PHASE: Mutex<Option<Phase>> = Mutex::new(None);

/// Update tray tooltip and, if the phase materially changed, send an OS
/// notification. Suppresses duplicate transitions so we don't spam the user.
pub fn set(app: &AppHandle, phase: Phase) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(phase.tooltip()));
    }

    let mut last = LAST_PHASE.lock().unwrap();
    let should_notify = match (&phase, last.as_ref()) {
        // Same variant as before: no new toast.
        (a, Some(b)) if variant_eq(a, b) => false,
        // Transient states don't warrant a toast on their own.
        (Phase::WaitingForCsp, _) | (Phase::Scanning, _) | (Phase::Reconnecting, _) => false,
        _ => true,
    };
    *last = Some(phase.clone());
    drop(last);

    if should_notify {
        let (title, body) = match &phase {
            Phase::Connected(host) => ("Luma Palette", format!("Connected to CSP at {host}")),
            Phase::Disconnected(reason) => ("Luma Palette", format!("Disconnected — {reason}")),
            _ => return,
        };
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

fn variant_eq(a: &Phase, b: &Phase) -> bool {
    use Phase::*;
    matches!(
        (a, b),
        (WaitingForCsp, WaitingForCsp)
            | (Scanning, Scanning)
            | (Reconnecting, Reconnecting)
            | (Connected(_), Connected(_))
            | (Disconnected(_), Disconnected(_))
    )
}
