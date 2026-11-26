//! Opt-in event trace for debugging show/hide and shortcut timing. Launch
//! with `LUMA_DEBUG_LOG=<file>` and the app appends one timestamped line per
//! event from the hook, the sample thread, window show/hide and the frontend.
//! With the variable unset every call returns after one atomic load.
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

fn path() -> Option<&'static PathBuf> {
    PATH.get_or_init(|| std::env::var_os("LUMA_DEBUG_LOG").map(PathBuf::from))
        .as_ref()
}

pub fn enabled() -> bool {
    path().is_some()
}

pub fn log(msg: impl AsRef<str>) {
    let Some(path) = path() else {
        return;
    };
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{ms} {}", msg.as_ref());
    }
}
