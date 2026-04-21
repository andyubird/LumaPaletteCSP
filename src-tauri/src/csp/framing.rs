use serde_json::Value;

pub const TYPE_CLIENT: u8 = 0x01;
pub const TYPE_SUCCESS: u8 = 0x06;
pub const TYPE_ERROR: u8 = 0x15;
pub const TERM: u8 = 0x00;
pub const RS: u8 = 0x1E;

pub const MAX_U32: f64 = 4294967295.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MsgType {
    Command,
    Success,
    Error,
    Unknown,
}

impl From<u8> for MsgType {
    fn from(b: u8) -> Self {
        match b {
            TYPE_CLIENT => MsgType::Command,
            TYPE_SUCCESS => MsgType::Success,
            TYPE_ERROR => MsgType::Error,
            _ => MsgType::Unknown,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ParsedMessage {
    pub msg_type: MsgType,
    pub command: String,
    pub serial: i64,
    pub detail: Value,
}

pub fn build_message(command: &str, serial: u32, detail: &str) -> Vec<u8> {
    let body = format!(
        "$tcp_remote_command_protocol_version=1.0\x1e$command={command}\x1e$serial={serial}\x1e$detail={detail}\x1e"
    );
    let mut out = Vec::with_capacity(body.len() + 2);
    out.push(TYPE_CLIENT);
    out.extend_from_slice(body.as_bytes());
    out.push(TERM);
    out
}

/// Drain all complete messages from `buf`, leaving any partial trailing bytes behind.
/// Handles coalesced records per PROTOCOL.md.
pub fn drain_messages(buf: &mut Vec<u8>) -> Vec<ParsedMessage> {
    let mut out = Vec::new();
    loop {
        let Some(idx) = buf.iter().position(|&b| b == TERM) else {
            break;
        };
        // Scan backward from TERM for the nearest type byte as the record start.
        let mut start = 0usize;
        for j in (0..idx).rev() {
            let b = buf[j];
            if b == TYPE_CLIENT || b == TYPE_SUCCESS || b == TYPE_ERROR {
                start = j;
                break;
            }
        }
        let raw = buf[start..=idx].to_vec();
        // Drain up to and including the TERM we just consumed.
        buf.drain(..=idx);
        if let Some(msg) = parse_record(&raw) {
            out.push(msg);
        }
    }
    out
}

fn parse_record(raw: &[u8]) -> Option<ParsedMessage> {
    if raw.len() < 10 {
        return None;
    }
    let ptype = raw[0];
    // body excludes leading type and trailing TERM
    let body = &raw[1..raw.len() - 1];
    let parts: Vec<&[u8]> = body.split(|&b| b == RS).collect();

    let mut command = String::new();
    let mut serial: i64 = -1;
    let mut detail_str = String::new();

    for p in parts {
        let s = String::from_utf8_lossy(p);
        let s = s.trim_start_matches('$');
        if let Some((k, v)) = s.split_once('=') {
            match k {
                "command" => command = v.to_string(),
                "serial" => serial = v.parse().unwrap_or(-1),
                "detail" => detail_str = v.to_string(),
                _ => {}
            }
        }
    }

    // Gotcha from PROTOCOL.md: detail is followed by an RS byte before TERM.
    // After splitting on RS that's already handled, but guard anyway.
    let ds = detail_str.trim_end_matches('\x1e').trim_end_matches('\x00');
    let detail: Value = if ds.is_empty() {
        Value::Object(Default::default())
    } else {
        match serde_json::from_str::<Value>(ds) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[PARSE ERR] {e}: ds={ds:?}");
                Value::Object(Default::default())
            }
        }
    };

    Some(ParsedMessage {
        msg_type: MsgType::from(ptype),
        command,
        serial,
        detail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_roundtrip() {
        let msg = build_message("TellHeartbeat", 7, r#"{"IdleTimerResetRequested":true}"#);
        assert_eq!(msg[0], TYPE_CLIENT);
        assert_eq!(*msg.last().unwrap(), TERM);
        let body = &msg[1..msg.len() - 1];
        let text = String::from_utf8_lossy(body);
        assert!(text.contains("$command=TellHeartbeat"));
        assert!(text.contains("$serial=7"));
        assert!(text.contains(r#"$detail={"IdleTimerResetRequested":true}"#));
    }

    #[test]
    fn parse_success_with_detail() {
        // Build a success response the way the server does
        let body = format!(
            "$tcp_remote_command_protocol_version=1.0\x1e$command=SyncColorCircleUIState\x1e$serial=3\x1e$detail={{\"CurrentColorIndex\":0,\"HSVColorMainH\":100}}\x1e"
        );
        let mut raw = vec![TYPE_SUCCESS];
        raw.extend_from_slice(body.as_bytes());
        raw.push(TERM);
        let mut buf = raw.clone();
        let msgs = drain_messages(&mut buf);
        assert_eq!(msgs.len(), 1);
        let m = &msgs[0];
        assert_eq!(m.msg_type, MsgType::Success);
        assert_eq!(m.command, "SyncColorCircleUIState");
        assert_eq!(m.serial, 3);
        assert_eq!(m.detail["HSVColorMainH"], 100);
    }

    #[test]
    fn drain_coalesced() {
        let a = build_message("A", 1, "{}");
        let b = build_message("B", 2, "{}");
        let mut buf = Vec::new();
        buf.extend_from_slice(&a);
        buf.extend_from_slice(&b);
        let msgs = drain_messages(&mut buf);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].command, "A");
        assert_eq!(msgs[1].command, "B");
        assert!(buf.is_empty());
    }

    #[test]
    fn drain_leaves_partial() {
        let a = build_message("A", 1, "{}");
        let mut buf = Vec::new();
        buf.extend_from_slice(&a);
        // Add a partial record (no TERM yet)
        buf.push(TYPE_CLIENT);
        buf.extend_from_slice(b"$partial");
        let msgs = drain_messages(&mut buf);
        assert_eq!(msgs.len(), 1);
        assert!(!buf.is_empty());
        assert_eq!(buf[0], TYPE_CLIENT);
    }
}
