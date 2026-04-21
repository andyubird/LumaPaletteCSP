use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionData {
    pub host: String,
    pub port: u16,
    pub password: String,
    pub generation: String,
}

fn session_path() -> PathBuf {
    // Next to the executable, matching the Python behavior.
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("session.json")
}

pub fn save_session(data: &SessionData) {
    let path = session_path();
    if let Ok(s) = serde_json::to_string(data) {
        if let Err(e) = std::fs::write(&path, s) {
            eprintln!("[SESSION] save failed: {e}");
        }
    }
}

pub fn load_session() -> Option<SessionData> {
    let path = session_path();
    let s = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&s).ok()
}

pub fn clear_session() {
    let _ = std::fs::remove_file(session_path());
}
