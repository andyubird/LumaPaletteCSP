use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::OpenOptions;
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
    /// UI language: "en" | "zh-TW".
    #[serde(default = "default_language")]
    pub language: String,
    /// Color wheel model: "oklch" | "hsv" | "hsl" | "lab".
    pub wheel_type: String,
    /// Custom global shortcut accelerator string. Empty string disables it.
    #[serde(default = "default_hotkey")]
    pub global_hotkey: String,
    /// Whether ALT+left-click should summon Luma after CSP's own eyedropper
    /// commits the sampled brush color.
    #[serde(default = "always_true")]
    pub show_after_alt_pick: bool,
    /// Whether the first-run Status & Settings guide has been shown.
    #[serde(default)]
    pub has_seen_welcome: bool,
    /// Whether to show a once-per-launch tray notification after the first run.
    #[serde(default = "always_true")]
    pub notify_on_startup: bool,
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

fn default_hotkey() -> String {
    String::new()
}
fn default_language() -> String {
    "en".into()
}
fn default_palette_offset() -> String {
    "bottom-right".into()
}
fn always_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            restrict_to_csp: false,
            require_csp_running: true,
            language: default_language(),
            wheel_type: "oklch".into(),
            global_hotkey: default_hotkey(),
            show_after_alt_pick: true,
            has_seen_welcome: false,
            notify_on_startup: true,
            palette_offset: default_palette_offset(),
        }
    }
}

pub fn exe_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.to_path_buf())
}

pub fn settings_path() -> Option<PathBuf> {
    Some(exe_dir()?.join("settings.json"))
}

pub fn exe_dir_is_writable() -> bool {
    let Some(dir) = exe_dir() else {
        return false;
    };
    let probe = dir.join(format!(".luma-write-test-{}", std::process::id()));
    match OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
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
    let Some(path) = settings_path() else {
        return;
    };
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
