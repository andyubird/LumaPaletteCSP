use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
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

    fn key(&self) -> &'static str {
        match self {
            Phase::WaitingForCsp => "waiting_for_csp",
            Phase::Scanning => "scanning",
            Phase::Reconnecting => "reconnecting",
            Phase::Connected(_) => "connected",
            Phase::Disconnected(_) => "disconnected",
        }
    }

    fn detail(&self) -> Option<String> {
        match self {
            Phase::Connected(host) => Some(host.clone()),
            Phase::Disconnected(reason) => Some(reason.clone()),
            _ => None,
        }
    }

    fn label(&self) -> String {
        match self {
            Phase::WaitingForCsp => "Waiting for Clip Studio Paint".into(),
            Phase::Scanning => "Scanning for Companion Mode QR code".into(),
            Phase::Reconnecting => "Trying saved Companion Mode session".into(),
            Phase::Connected(host) => format!("Connected to CSP at {host}"),
            Phase::Disconnected(reason) => format!("Disconnected: {reason}"),
        }
    }
}

static LAST_PHASE: Mutex<Option<Phase>> = Mutex::new(None);

#[derive(Clone, Debug, Serialize)]
pub struct PhasePayload {
    pub phase: String,
    pub detail: Option<String>,
    pub label: String,
}

impl From<&Phase> for PhasePayload {
    fn from(phase: &Phase) -> Self {
        Self {
            phase: phase.key().into(),
            detail: phase.detail(),
            label: phase.label(),
        }
    }
}

pub fn current() -> PhasePayload {
    let phase = LAST_PHASE
        .lock()
        .unwrap()
        .clone()
        .unwrap_or(Phase::WaitingForCsp);
    PhasePayload::from(&phase)
}

/// Update tray tooltip and, if the phase materially changed, send an OS
/// notification. Suppresses duplicate transitions so we don't spam the user.
pub fn set(app: &AppHandle, phase: Phase) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(phase.tooltip()));
    }

    let payload = PhasePayload::from(&phase);
    let _ = app.emit("phase-changed", payload);

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

pub fn notify_startup(app: &AppHandle, hotkey: &str) {
    let shortcut = if hotkey.is_empty() {
        "No keyboard shortcut is set.".to_string()
    } else {
        format!("Shortcut: {hotkey}.")
    };
    let _ = app
        .notification()
        .builder()
        .title("Luma Palette is running")
        .body(format!(
            "Use the tray icon for Status & Settings. {shortcut}"
        ))
        .show();
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
