use std::sync::Mutex;

use crate::csp::CSPConnection;
use crate::qr::QrScanHandle;
use crate::settings::SettingsStore;

pub struct AppState {
    pub csp: Mutex<Option<CSPConnection>>,
    pub qr_scan: Mutex<Option<QrScanHandle>>,
    pub settings: SettingsStore,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            csp: Mutex::new(None),
            qr_scan: Mutex::new(None),
            settings: SettingsStore::new(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
