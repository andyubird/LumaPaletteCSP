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
        // Prefer the currently-selected slot's HSV when both Main and Sub are
        // present. Fall back to the legacy HSVColorH/S/V for older payloads.
        let slot_prefix = if self.current_color_index == 1 { "Sub" } else { "Main" };
        let (hk, sk, vk) = (
            format!("HSVColor{slot_prefix}H"),
            format!("HSVColor{slot_prefix}S"),
            format!("HSVColor{slot_prefix}V"),
        );
        let (h, s, v) = if let (Some(h), Some(s), Some(v)) = (
            d.get(&hk).and_then(|x| x.as_u64()),
            d.get(&sk).and_then(|x| x.as_u64()),
            d.get(&vk).and_then(|x| x.as_u64()),
        ) {
            (h as f64, s as f64, v as f64)
        } else if let (Some(h), Some(s), Some(v)) = (
            d.get("HSVColorH").and_then(|x| x.as_u64()),
            d.get("HSVColorS").and_then(|x| x.as_u64()),
            d.get("HSVColorV").and_then(|x| x.as_u64()),
        ) {
            (h as f64, s as f64, v as f64)
        } else {
            return;
        };
        // u32 scale: H -> [0,1), S/V -> [0,1]
        let hn = h / MAX_U32;
        let sn = s / MAX_U32;
        let vn = v / MAX_U32;
        let (r, g, b) = hsv_to_rgb(hn, sn, vn);
        self.last_rgb = Some((
            (r * 255.0).round().clamp(0.0, 255.0) as u8,
            (g * 255.0).round().clamp(0.0, 255.0) as u8,
            (b * 255.0).round().clamp(0.0, 255.0) as u8,
        ));
    }

    pub fn get_color_rgb(&mut self) -> Option<(u8, u8, u8)> {
        // Stale-state trick from PROTOCOL.md so server returns full detail.
        let stale = r#"{"IsManipulating":false,"HSVColorMainH":0,"HSVColorMainS":0,"HSVColorMainV":0,"CurrentColorIndex":0,"ColorSelectionModel":"HSV"}"#;
        let _ = self.send_command("SyncColorCircleUIState", stale);
        self.last_rgb
    }

    pub fn set_color_hex(&mut self, hex: &str) -> Option<ParsedMessage> {
        let hx = hex.trim_start_matches('#');
        if hx.len() < 6 {
            return None;
        }
        let r = u8::from_str_radix(&hx[0..2], 16).ok()? as f64 / 255.0;
        let g = u8::from_str_radix(&hx[2..4], 16).ok()? as f64 / 255.0;
        let b = u8::from_str_radix(&hx[4..6], 16).ok()? as f64 / 255.0;
        self.last_rgb = Some((
            (r * 255.0) as u8,
            (g * 255.0) as u8,
            (b * 255.0) as u8,
        ));
        let (h, s, v) = rgb_to_hsv(r, g, b);
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
