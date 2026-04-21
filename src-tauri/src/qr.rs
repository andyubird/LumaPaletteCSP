use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use image::{DynamicImage, ImageBuffer, Rgba};
use xcap::Monitor;

/// Capture a single monitor into a DynamicImage. Returns None if capture fails.
fn capture_monitor(monitor: &Monitor) -> Option<DynamicImage> {
    let img = monitor.capture_image().ok()?;
    let (w, h) = (img.width(), img.height());
    let buf: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(w, h, img.into_raw())?;
    Some(DynamicImage::ImageRgba8(buf))
}

/// Scan one image for a QR code whose decoded text starts with `needle`.
fn scan_image_for(img: &DynamicImage, needle: &str) -> Option<String> {
    let gray = img.to_luma8();
    let mut prepared = rqrr::PreparedImage::prepare(gray);
    for grid in prepared.detect_grids() {
        if let Ok((_meta, content)) = grid.decode() {
            if content.starts_with(needle) {
                return Some(content);
            }
        }
    }
    None
}

/// Scan every monitor once for a QR code matching `needle`. Returns the
/// first match's decoded URL.
pub fn scan_once(needle: &str) -> Option<String> {
    let monitors = Monitor::all().ok()?;
    for m in monitors {
        if let Some(img) = capture_monitor(&m) {
            if let Some(url) = scan_image_for(&img, needle) {
                return Some(url);
            }
        }
    }
    None
}

/// Handle to a running QR scan loop. Drop or call `.stop()` to halt it.
pub struct QrScanHandle {
    stop: Arc<AtomicBool>,
}

impl QrScanHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for QrScanHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Spawn a background thread that scans monitors every `interval_ms` for a QR
/// whose contents start with `needle`. When found, `on_found` fires once and
/// the loop exits. `needle` is typically `"https://companion.clip-studio.com/"`.
pub fn spawn_scan<F>(needle: String, interval_ms: u64, on_found: F) -> QrScanHandle
where
    F: FnOnce(String) + Send + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    thread::spawn(move || {
        let mut cb = Some(on_found);
        while !stop_thread.load(Ordering::Relaxed) {
            if let Some(url) = scan_once(&needle) {
                if let Some(f) = cb.take() {
                    f(url);
                }
                break;
            }
            thread::sleep(Duration::from_millis(interval_ms));
        }
    });
    QrScanHandle { stop }
}
