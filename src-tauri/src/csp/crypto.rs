use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use rand::RngCore;
use url::Url;

pub const REMOTE_KEY: [u8; 7] = [0x74, 0xB2, 0x92, 0x5B, 0x4A, 0x21, 0xDA];
pub const AUTH_KEY: [u8; 7] = [0xB6, 0xD5, 0x92, 0xC4, 0xA7, 0x83, 0xE1];

pub const RECONNECT_MARKER: &str = "{{(([[reconnection request marker]]))}}\r\n";

pub fn xor_cycle(data: &[u8], key: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ key[i % key.len()])
        .collect()
}

#[derive(Debug, Clone)]
pub struct QrPayload {
    pub ips: Vec<String>,
    pub port: u16,
    pub password: String,
    pub generation: String,
}

pub fn decode_qr_url(url: &str) -> Result<QrPayload, String> {
    let parsed = Url::parse(url).map_err(|e| format!("bad url: {e}"))?;
    let s_hex = parsed
        .query_pairs()
        .find(|(k, _)| k == "s")
        .map(|(_, v)| v.into_owned())
        .ok_or_else(|| "missing 's' query param".to_string())?;
    let s_bytes = hex::decode(&s_hex).map_err(|e| format!("hex decode: {e}"))?;
    let decrypted = xor_cycle(&s_bytes, &REMOTE_KEY);
    let text = String::from_utf8(decrypted).map_err(|e| format!("utf8: {e}"))?;
    let parts: Vec<&str> = text.split('\t').collect();
    if parts.len() < 4 {
        return Err(format!("expected 4 tab-separated fields, got {}", parts.len()));
    }
    let ips: Vec<String> = parts[0].split(',').map(String::from).collect();
    let port: u16 = parts[1].parse().map_err(|e| format!("port: {e}"))?;
    Ok(QrPayload {
        ips,
        port,
        password: parts[2].to_string(),
        generation: parts[3].to_string(),
    })
}

pub fn obfuscate_auth(password: &str) -> String {
    hex::encode(xor_cycle(password.as_bytes(), &AUTH_KEY))
}

pub fn make_new_password() -> String {
    let mut bytes = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut bytes);
    STANDARD_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xor_roundtrip() {
        let plain = b"hello";
        let key = &[1u8, 2, 3];
        let enc = xor_cycle(plain, key);
        let dec = xor_cycle(&enc, key);
        assert_eq!(dec, plain);
    }

    #[test]
    fn obfuscate_reversible() {
        let pw = "test123";
        let enc_hex = obfuscate_auth(pw);
        let bytes = hex::decode(&enc_hex).unwrap();
        let back = xor_cycle(&bytes, &AUTH_KEY);
        assert_eq!(back, pw.as_bytes());
    }

    #[test]
    fn make_new_password_is_unique() {
        let a = make_new_password();
        let b = make_new_password();
        assert_ne!(a, b);
        assert!(!a.contains('='));
    }

    #[test]
    fn decode_qr_roundtrip() {
        // Build a synthetic payload the way CSP desktop would:
        //   plaintext = "192.168.1.10,10.0.0.5\t5678\tp4ssw0rd\tG#1:2022.12"
        //   ciphertext = XOR with REMOTE_KEY, then hex-encode, embed in ?s=
        let plain = "192.168.1.10,10.0.0.5\t5678\tp4ssw0rd\tG#1:2022.12";
        let enc = xor_cycle(plain.as_bytes(), &REMOTE_KEY);
        let s_hex = hex::encode(&enc);
        let url = format!("https://companion.clip-studio.com/rc/zh-tw?s={s_hex}");
        let p = decode_qr_url(&url).unwrap();
        assert_eq!(p.ips, vec!["192.168.1.10", "10.0.0.5"]);
        assert_eq!(p.port, 5678);
        assert_eq!(p.password, "p4ssw0rd");
        assert_eq!(p.generation, "G#1:2022.12");
    }
}
