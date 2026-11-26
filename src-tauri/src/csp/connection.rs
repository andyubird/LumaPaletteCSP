use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde_json::json;

use super::crypto::{make_new_password, obfuscate_auth, RECONNECT_MARKER};
use super::framing::{build_message, drain_messages, MsgType, ParsedMessage, MAX_U32};
use super::session::{save_session, SessionData};
use crate::color::{hsv_to_rgb, rgb_to_hsv};

pub struct CSPConnection {
    pub host: String,
    pub port: u16,
    pub password: String,
    pub generation: String,
    pub reconnect_mode: bool,

    sock: Option<TcpStream>,
    serial: u32,
    recv_buffer: Vec<u8>,
    pub connected: bool,
    last_rgb: Option<(u8, u8, u8)>,
    /// 0 = main (foreground), 1 = sub (background). Tracks which slot CSP
    /// currently has selected so writes target the right one.
    current_color_index: u8,
    /// Raw u32-scaled H/S/V per slot (0 = main, 1 = sub) as last reported or
    /// declared. CSP's Sync replies are diffs: a field it omits is unchanged
    /// from what it believes this client already knows, so replies are merged
    /// into this instead of being discarded when a field is missing.
    known_hsv: [[u64; 3]; 2],
    known_valid: [bool; 2],
    /// Last color handed to the frontend, so pollers only emit real changes.
    last_emitted_rgb: Option<(u8, u8, u8)>,
    /// When we last wrote a color to CSP; pollers back off briefly after a
    /// write so a read-back can't fight an in-progress drag.
    last_set_at: Option<Instant>,
}

impl CSPConnection {
    pub fn new(host: String, port: u16, password: String, generation: String, reconnect: bool) -> Self {
        Self {
            host,
            port,
            password,
            generation,
            reconnect_mode: reconnect,
            sock: None,
            serial: 0,
            recv_buffer: Vec::new(),
            connected: false,
            last_rgb: None,
            current_color_index: 0,
            known_hsv: [[0; 3]; 2],
            known_valid: [false; 2],
            last_emitted_rgb: None,
            last_set_at: None,
        }
    }

    pub fn color_index(&self) -> u8 { self.current_color_index }

    pub fn connect(&mut self) -> Result<(), String> {
        let addr = format!("{}:{}", self.host, self.port);
        println!("[CSP] Connecting to {addr}...");
        let sock = TcpStream::connect_timeout(
            &addr.parse().map_err(|e| format!("bad addr: {e}"))?,
            Duration::from_secs(5),
        )
        .map_err(|e| format!("connect: {e}"))?;
        sock.set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| format!("set_read_timeout: {e}"))?;
        self.sock = Some(sock);
        self.connected = true;
        println!("[CSP] Connected!");
        self.authenticate()
    }

    fn authenticate(&mut self) -> Result<(), String> {
        // Reconnect: curr = obfuscated marker, new = same password we sent last time.
        // Fresh:     curr = obfuscated QR password, new = fresh random.
        let (curr_token, new_pass) = if self.reconnect_mode {
            (obfuscate_auth(RECONNECT_MARKER), self.password.clone())
        } else {
            (obfuscate_auth(&self.password), make_new_password())
        };
        let new_token = obfuscate_auth(&new_pass);
        let detail =
            serde_json::to_string(&[&self.generation, &curr_token, &new_token]).unwrap();

        let resp = self.send_command("Authenticate", &detail);
        match resp {
            Some(ref m) if m.msg_type == MsgType::Success => {
                self.password = new_pass;
                let server = m
                    .detail
                    .get("RemoteCommandSpecVersionOfServer")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                println!("[CSP] Authenticated! Server: {server}");
                save_session(&SessionData {
                    host: self.host.clone(),
                    port: self.port,
                    password: self.password.clone(),
                    generation: self.generation.clone(),
                });
                self.activate();
                Ok(())
            }
            _ => {
                self.connected = false;
                Err(format!("auth failed: {resp:?}"))
            }
        }
    }

    fn activate(&mut self) {
        // Mirror the Python activation ritual.
        let _ = self.send_command("TellHeartbeat", r#"{"IdleTimerResetRequested":true}"#);
        let _ = self.send_command(
            "GetModifyKeyString",
            r#"{"CtrlPushed":false,"AltPushed":false,"ShiftPushed":false}"#,
        );
        let _ = self.send_command("GetServerSelectedTabKind", "");
        let _ = self.send_command("SetServerSelectedTabKind", "");
        let _ = self.send_command("TellHeartbeat", r#"{"IdleTimerResetRequested":true}"#);
    }

    pub fn send_command(&mut self, command: &str, detail: &str) -> Option<ParsedMessage> {
        if !self.connected && command != "Authenticate" {
            return None;
        }
        let s = self.serial;
        self.serial += 1;
        let msg = build_message(command, s, detail);
        if let Some(sock) = self.sock.as_mut() {
            if let Err(e) = sock.write_all(&msg) {
                eprintln!("[CSP] Send error: {e}");
                self.connected = false;
                return None;
            }
        } else {
            return None;
        }
        self.read_response(s, Duration::from_secs(3))
    }

    fn read_response(&mut self, expected: u32, timeout: Duration) -> Option<ParsedMessage> {
        let deadline = Instant::now() + timeout;
        loop {
            // Check already-buffered messages first.
            let msgs = drain_messages(&mut self.recv_buffer);
            for m in msgs {
                self.absorb_color(&m);
                if m.serial as u32 == expected {
                    return Some(m);
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let sock = self.sock.as_mut()?;
            sock.set_read_timeout(Some(remaining.max(Duration::from_millis(50)))).ok();
            let mut buf = [0u8; 8192];
            match sock.read(&mut buf) {
                Ok(0) => {
                    self.connected = false;
                    return None;
                }
                Ok(n) => {
                    self.recv_buffer.extend_from_slice(&buf[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    continue;
                }
                Err(_) => {
                    self.connected = false;
                    return None;
                }
            }
        }
    }

    fn absorb_color(&mut self, m: &ParsedMessage) {
        let d = &m.detail;
        if !d.is_object() {
            return;
        }
        // Track which slot CSP currently has selected so writes target it.
        if let Some(idx) = d.get("CurrentColorIndex").and_then(|x| x.as_u64()) {
            self.current_color_index = idx.min(1) as u8;
        }

        // Merge whatever fields this message carries. The legacy
        // HSVColorH/S/V names (no Main/Sub) refer to the selected slot.
        let mut any = false;
        for (slot, prefix) in [(0usize, "Main"), (1usize, "Sub")] {
            let mut present = [false; 3];
            for (i, axis) in ["H", "S", "V"].iter().enumerate() {
                if let Some(v) = d.get(format!("HSVColor{prefix}{axis}")).and_then(|x| x.as_u64()) {
                    self.known_hsv[slot][i] = v;
                    present[i] = true;
                    any = true;
                }
            }
            if present.iter().all(|p| *p) {
                self.known_valid[slot] = true;
            }
        }
        if !any {
            let slot = self.current_color_index as usize;
            let mut present = [false; 3];
            for (i, axis) in ["H", "S", "V"].iter().enumerate() {
                if let Some(v) = d.get(format!("HSVColor{axis}")).and_then(|x| x.as_u64()) {
                    self.known_hsv[slot][i] = v;
                    present[i] = true;
                    any = true;
                }
            }
            if present.iter().all(|p| *p) {
                self.known_valid[slot] = true;
            }
        }
        if any {
            self.refresh_last_rgb();
        }
    }

    /// Recompute `last_rgb` from the selected slot's known H/S/V.
    fn refresh_last_rgb(&mut self) {
        let slot = self.current_color_index as usize;
        if !self.known_valid[slot] {
            return;
        }
        let [h, s, v] = self.known_hsv[slot];
        // u32 scale: H -> [0,1), S/V -> [0,1]
        let (r, g, b) = hsv_to_rgb(h as f64 / MAX_U32, s as f64 / MAX_U32, v as f64 / MAX_U32);
        self.last_rgb = Some((
            (r * 255.0).round().clamp(0.0, 255.0) as u8,
            (g * 255.0).round().clamp(0.0, 255.0) as u8,
            (b * 255.0).round().clamp(0.0, 255.0) as u8,
        ));
    }

    fn trace_sync(&self, what: &str, resp: &Option<ParsedMessage>) {
        if !crate::diag::enabled() {
            return;
        }
        let detail = resp
            .as_ref()
            .map(|m| m.detail.to_string())
            .unwrap_or_else(|| "<no response>".into());
        let detail: String = detail.chars().take(400).collect();
        crate::diag::log(format!(
            "csp {what}: slot={} rgb={:?} known={:?} detail={detail}",
            self.current_color_index, self.last_rgb, self.known_hsv
        ));
    }

    /// Full read of CSP's current color, used when the palette opens.
    ///
    /// Stale-state trick from PROTOCOL.md: declaring main = (0,0,0) makes CSP
    /// reply with every main field that differs from that, i.e. a full payload
    /// unless a component really is 0 — in which case the declared 0 is right,
    /// so the declaration is written into `known_hsv` before the reply merges.
    pub fn get_color_rgb(&mut self) -> Option<(u8, u8, u8)> {
        let stale = r#"{"IsManipulating":false,"HSVColorMainH":0,"HSVColorMainS":0,"HSVColorMainV":0,"CurrentColorIndex":0,"ColorSelectionModel":"HSV"}"#;
        self.known_hsv[0] = [0; 3];
        self.known_valid[0] = true;
        let resp = self.send_command("SyncColorCircleUIState", stale);
        self.refresh_last_rgb();
        self.trace_sync("sync(full)", &resp);
        self.last_rgb
    }

    /// Cheap incremental read for polling while the palette is open: an empty
    /// declaration makes CSP reply with only what changed since the last sync.
    pub fn poll_color(&mut self) {
        let before = self.last_rgb;
        let resp = self.send_command("SyncColorCircleUIState", "{}");
        if self.last_rgb != before {
            self.trace_sync("sync(poll) changed", &resp);
        }
    }

    /// The color to hand to the frontend if it differs from what it last got.
    /// Ignores ±2 per channel so CSP's HSV round-trip of our own writes
    /// doesn't nudge the marker.
    pub fn take_color_change(&mut self) -> Option<((u8, u8, u8), u8)> {
        let rgb = self.last_rgb?;
        let differs = match self.last_emitted_rgb {
            None => true,
            Some(prev) => {
                (rgb.0 as i16 - prev.0 as i16).abs() > 2
                    || (rgb.1 as i16 - prev.1 as i16).abs() > 2
                    || (rgb.2 as i16 - prev.2 as i16).abs() > 2
            }
        };
        if !differs {
            return None;
        }
        self.last_emitted_rgb = Some(rgb);
        Some((rgb, self.current_color_index))
    }

    pub fn recently_set(&self, within: Duration) -> bool {
        self.last_set_at.map(|t| t.elapsed() < within).unwrap_or(false)
    }

    pub fn set_color_hex(&mut self, hex: &str) -> Option<ParsedMessage> {
        let hx = hex.trim_start_matches('#');
        if hx.len() < 6 {
            return None;
        }
        let r = u8::from_str_radix(&hx[0..2], 16).ok()? as f64 / 255.0;
        let g = u8::from_str_radix(&hx[2..4], 16).ok()? as f64 / 255.0;
        let b = u8::from_str_radix(&hx[4..6], 16).ok()? as f64 / 255.0;
        let rgb8 = ((r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8);
        self.last_rgb = Some(rgb8);
        // The frontend already shows what it just sent.
        self.last_emitted_rgb = Some(rgb8);
        self.last_set_at = Some(Instant::now());
        let (h, s, v) = rgb_to_hsv(r, g, b);
        let slot = self.current_color_index as usize;
        self.known_hsv[slot] = [(h * MAX_U32) as u64, (s * MAX_U32) as u64, (v * MAX_U32) as u64];
        self.known_valid[slot] = true;
        let detail = json!({
            "ColorSpaceKind": "HSV",
            "IsColorTransparent": false,
            "HSVColorH": (h * MAX_U32) as u64,
            "HSVColorS": (s * MAX_U32) as u64,
            "HSVColorV": (v * MAX_U32) as u64,
            "ColorIndex": self.current_color_index,
        });
        self.send_command("SetCurrentColor", &detail.to_string())
    }

    pub fn heartbeat(&mut self) {
        if !self.connected {
            return;
        }
        let _ = self.send_command("TellHeartbeat", r#"{"IdleTimerResetRequested":true}"#);
    }

    pub fn disconnect(&mut self) {
        self.connected = false;
        if let Some(sock) = self.sock.take() {
            let _ = sock.shutdown(std::net::Shutdown::Both);
        }
    }
}
