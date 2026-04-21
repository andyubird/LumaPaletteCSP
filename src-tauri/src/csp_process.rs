use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use sysinfo::{ProcessesToUpdate, System};

static CSP_RUNNING: AtomicBool = AtomicBool::new(false);

// Executable basenames to match. Windows reports with extension; macOS doesn't.
const CSP_NAMES: &[&str] = &[
    "CLIPStudioPaint.exe",
    "CLIPStudioPaint",
    "CLIP STUDIO PAINT.exe",
    "CLIP STUDIO PAINT",
];

pub fn is_running() -> bool {
    CSP_RUNNING.load(Ordering::Relaxed)
}

fn refresh(sys: &mut System) -> bool {
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let running = sys.processes().values().any(|p| {
        let name = p.name().to_string_lossy();
        CSP_NAMES.iter().any(|n| name.eq_ignore_ascii_case(n))
    });
    CSP_RUNNING.store(running, Ordering::Relaxed);
    running
}

/// Spawn a background thread that updates CSP_RUNNING every 2 seconds. Fires
/// `on_change(running)` whenever the state transitions.
pub fn spawn_watcher<F>(mut on_change: F)
where
    F: FnMut(bool) + Send + 'static,
{
    thread::spawn(move || {
        let mut sys = System::new();
        let mut last = refresh(&mut sys);
        on_change(last);
        loop {
            thread::sleep(Duration::from_millis(2000));
            let now = refresh(&mut sys);
            if now != last {
                last = now;
                on_change(now);
            }
        }
    });
}
