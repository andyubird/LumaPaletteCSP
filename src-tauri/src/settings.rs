use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    /// When true, ALT+click / tray click only activates while the CSP window is
    /// the foreground window.
    pub restrict_to_csp: bool,
    /// Always-on: QR scanner + auto-reconnect only run while CSP is detected.
    /// Kept in the struct for save-file compatibility but no longer toggleable.
    #[serde(default = "always_true")]
    pub require_csp_running: bool,
    /// Color wheel model: "oklch" | "hsv" | "hsl".
    pub wheel_type: String,
    /// Global hotkey accelerator string (e.g. "Alt+P", "F7", "Ctrl+Shift+P").
    /// Empty string disables the hotkey.
    #[serde(default = "default_hotkey")]
    pub global_hotkey: String,
    /// Where the palette appears relative to the summon point (cursor / hotkey
    /// invocation point). One of:
    /// "bottom-right" (default, right-handed),
    /// "bottom-left"  (left-handed mirror),
    /// "top-right",
    /// "top-left",
    /// "center"       (pin at cursor, palette centered on cursor).
    #[serde(default = "default_palette_offset")]
    pub palette_offset: String,
}

fn default_hotkey() -> String { "Alt+P".into() }
fn default_palette_offset() -> String { "bottom-right".into() }
fn always_true() -> bool { true }

impl Default for Settings {
    fn default() -> Self {
        Self {
            restrict_to_csp: false,
            require_csp_running: true,
            wheel_type: "oklch".into(),
            global_hotkey: default_hotkey(),
            palette_offset: default_palette_offset(),
        }
    }
}

fn settings_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("settings.json"))
}

pub fn load() -> Settings {
    let Some(path) = settings_path() else {
        return Settings::default();
    };
    let Ok(txt) = fs::read_to_string(&path) else {
        return Settings::default();
    };
    serde_json::from_str(&txt).unwrap_or_default()
}

pub fn save(s: &Settings) {
    let Some(path) = settings_path() else { return; };
    if let Ok(json) = serde_json::to_string_pretty(s) {
        let _ = fs::write(path, json);
    }
}

pub struct SettingsStore {
    inner: Mutex<Settings>,
}

impl SettingsStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(load()),
        }
    }
    pub fn get(&self) -> Settings {
        self.inner.lock().unwrap().clone()
    }
    pub fn update<F: FnOnce(&mut Settings)>(&self, f: F) {
        let mut s = self.inner.lock().unwrap();
        f(&mut s);
        save(&s);
    }
}

impl Default for SettingsStore {
    fn default() -> Self {
        Self::new()
    }
}
