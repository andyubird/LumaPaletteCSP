// Windows-only low-level hooks for ALT+click and the user shortcut. Hooks pass
// events through to Windows; they never consume typing in other apps. The one
// exception is Escape while the palette is open, which dismisses it.

use std::sync::atomic::{AtomicBool, Ordering};

/// Whether the palette is currently shown. The palette window is non-activating
/// (keyboard focus stays with CSP), so Escape-to-dismiss has to be handled here
/// in the hook rather than in the palette's own JS.
static PALETTE_VISIBLE: AtomicBool = AtomicBool::new(false);

/// Shortcut auto-repeat latch: drops on keydown, returns on keyup.
static ARMED: AtomicBool = AtomicBool::new(true);

pub fn set_palette_visible(visible: bool) {
    PALETTE_VISIBLE.store(visible, Ordering::Relaxed);
}

/// Called whenever the palette hides. A hide is proof the user isn't holding
/// the shortcut, so this bounds the damage if the hook ever misses a keyup
/// (measured: activating the palette with SetForegroundWindow while the key
/// was held made Windows skip our hook for that key's release).
pub fn rearm_shortcut() {
    ARMED.store(true, Ordering::Relaxed);
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ShortcutSpec {
    ctrl: bool,
    shift: bool,
    alt: bool,
    super_key: bool,
    vk_code: u16,
}

fn parse_shortcut(accel: &str) -> Result<Option<ShortcutSpec>, String> {
    let accel = accel.trim();
    if accel.is_empty() {
        return Ok(None);
    }

    let mut spec = ShortcutSpec {
        ctrl: false,
        shift: false,
        alt: false,
        super_key: false,
        vk_code: 0,
    };
    let mut key_seen = false;

    for raw in accel.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        match raw.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => spec.ctrl = true,
            "shift" => spec.shift = true,
            "alt" | "option" => spec.alt = true,
            "super" | "meta" | "win" | "windows" => spec.super_key = true,
            _ => {
                if key_seen {
                    return Err("Use one non-modifier key in the shortcut.".into());
                }
                spec.vk_code = vk_code_for_key(raw)?;
                key_seen = true;
            }
        }
    }

    if !key_seen {
        return Err("Pick a non-modifier key, such as P or 1.".into());
    }

    Ok(Some(spec))
}

pub fn validate_shortcut(accel: &str) -> Result<(), String> {
    parse_shortcut(accel).map(|_| ())
}

fn vk_code_for_key(raw: &str) -> Result<u16, String> {
    let key = raw.trim();
    if key.chars().count() == 1 {
        let ch = key.chars().next().unwrap();
        let upper = ch.to_ascii_uppercase();
        if upper.is_ascii_alphabetic() || upper.is_ascii_digit() {
            return Ok(upper as u16);
        }
        if let Some(vk) = oem_vk_for_char(ch) {
            return Ok(vk);
        }
    }

    let upper = key.to_ascii_uppercase();
    if let Some(num) = upper.strip_prefix('F').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=24).contains(&num) {
            return Ok(0x70 + num - 1);
        }
    }

    match upper.as_str() {
        "BACKSPACE" => Ok(0x08),
        "TAB" => Ok(0x09),
        "ENTER" | "RETURN" => Ok(0x0D),
        "PAUSE" => Ok(0x13),
        "CAPSLOCK" => Ok(0x14),
        "ESCAPE" | "ESC" => Ok(0x1B),
        "SPACE" => Ok(0x20),
        "PAGEUP" => Ok(0x21),
        "PAGEDOWN" => Ok(0x22),
        "END" => Ok(0x23),
        "HOME" => Ok(0x24),
        "ARROWLEFT" | "LEFT" => Ok(0x25),
        "ARROWUP" | "UP" => Ok(0x26),
        "ARROWRIGHT" | "RIGHT" => Ok(0x27),
        "ARROWDOWN" | "DOWN" => Ok(0x28),
        "INSERT" => Ok(0x2D),
        "DELETE" => Ok(0x2E),
        _ => Err("Use a letter, number, symbol, function key, arrow key, or navigation key.".into()),
    }
}

/// Virtual-key code for a punctuation character such as '`' or '-'. On Windows
/// this asks the active keyboard layout, so the physical key matches what the
/// user actually pressed; the table below is the US-layout fallback.
fn oem_vk_for_char(ch: char) -> Option<u16> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::VkKeyScanW;
        let mut buf = [0u16; 2];
        if let [unit] = ch.encode_utf16(&mut buf) {
            let scan = unsafe { VkKeyScanW(*unit) };
            if scan != -1 {
                return Some((scan as u16) & 0xFF);
            }
        }
    }
    Some(match ch {
        '`' | '~' => 0xC0,
        '-' | '_' => 0xBD,
        '=' | '+' => 0xBB,
        '[' | '{' => 0xDB,
        ']' | '}' => 0xDD,
        '\\' | '|' => 0xDC,
        ';' | ':' => 0xBA,
        '\'' | '"' => 0xDE,
        ',' | '<' => 0xBC,
        '.' | '>' => 0xBE,
        '/' | '?' => 0xBF,
        _ => return None,
    })
}

#[cfg(target_os = "windows")]
pub fn install_alt_click<F>(on_alt_click: F)
where
    F: Fn(i32, i32) + Send + Sync + 'static,
{
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL,
        WM_LBUTTONDOWN,
    };

    static CALLBACK: OnceLock<Box<dyn Fn(i32, i32) + Send + Sync>> = OnceLock::new();
    let _ = CALLBACK.set(Box::new(on_alt_click));

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && wparam.0 as u32 == WM_LBUTTONDOWN {
            if key_down(VK_MENU.0 as i32)
                && !key_down(VK_CONTROL.0 as i32)
                && !key_down(VK_SHIFT.0 as i32)
                && !key_down(VK_LWIN.0 as i32)
                && !key_down(VK_RWIN.0 as i32)
            {
                let info = unsafe { *(lparam.0 as *const MSLLHOOKSTRUCT) };
                if let Some(cb) = CALLBACK.get() {
                    cb(info.pt.x, info.pt.y);
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    // Hooks must run on a thread with a message loop.
    std::thread::spawn(move || unsafe {
        let h = SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0);
        if h.is_err() {
            eprintln!("[HOOK] SetWindowsHookExW failed");
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            // Pump messages; the hook fires via the OS.
        }
    });
}

#[cfg(target_os = "windows")]
pub fn install_shortcut<G, F, E>(get_shortcut: G, on_shortcut: F, on_escape: E)
where
    G: Fn() -> String + Send + Sync + 'static,
    F: Fn() + Send + Sync + 'static,
    E: Fn() + Send + Sync + 'static,
{
    use std::sync::atomic::AtomicU64;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_CONTROL, VK_ESCAPE, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
        WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    static GET_SHORTCUT: OnceLock<Box<dyn Fn() -> String + Send + Sync>> = OnceLock::new();
    static CALLBACK: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
    static ON_ESCAPE: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
    // ARMED drops on keydown and returns on keyup so auto-repeat fires once.
    // If the keyup never reaches us, a keydown later than Windows' slowest
    // repeat delay counts as a new press instead of leaving the shortcut jammed.
    static LAST_DOWN_MS: AtomicU64 = AtomicU64::new(0);
    const REPEAT_WINDOW_MS: u64 = 1100;

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    let _ = GET_SHORTCUT.set(Box::new(get_shortcut));
    let _ = CALLBACK.set(Box::new(on_shortcut));
    let _ = ON_ESCAPE.set(Box::new(on_escape));

    fn current_spec() -> Option<ShortcutSpec> {
        let accel = GET_SHORTCUT.get()?();
        parse_shortcut(&accel).ok().flatten()
    }

    fn modifiers_match(spec: &ShortcutSpec) -> bool {
        let ctrl = key_down(VK_CONTROL.0 as i32);
        let shift = key_down(VK_SHIFT.0 as i32);
        let alt = key_down(VK_MENU.0 as i32);
        let super_key = key_down(VK_LWIN.0 as i32) || key_down(VK_RWIN.0 as i32);
        ctrl == spec.ctrl && shift == spec.shift && alt == spec.alt && super_key == spec.super_key
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let msg = wparam.0 as u32;
            let info = unsafe { *(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let vk = info.vkCode as u16;
            let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if crate::diag::enabled() {
                crate::diag::log(format!("hook raw msg={msg:#x} vk={vk:#x} flags={:#x}", info.flags.0));
            }

            // Escape closes the open palette and is swallowed so the app under
            // it doesn't act on it too.
            if vk == VK_ESCAPE.0 && PALETTE_VISIBLE.load(Ordering::Relaxed) {
                if is_down {
                    crate::diag::log("hook escape -> dismiss");
                    if let Some(cb) = ON_ESCAPE.get() {
                        cb();
                    }
                }
                if is_down || is_up {
                    return LRESULT(1);
                }
            }

            if let Some(spec) = current_spec() {
                if is_down && vk == spec.vk_code && modifiers_match(&spec) {
                    let now = now_ms();
                    let prev = LAST_DOWN_MS.swap(now, Ordering::Relaxed);
                    let was_armed = ARMED.swap(false, Ordering::Relaxed);
                    let is_repeat = !was_armed && now.saturating_sub(prev) < REPEAT_WINDOW_MS;
                    crate::diag::log(format!(
                        "hook keydown vk={vk:#x} armed={was_armed} since_prev={}ms repeat={is_repeat}",
                        now.saturating_sub(prev)
                    ));
                    if !is_repeat {
                        if let Some(cb) = CALLBACK.get() {
                            cb();
                        }
                    }
                } else if is_up && vk == spec.vk_code {
                    crate::diag::log(format!("hook keyup vk={vk:#x} -> armed"));
                    ARMED.store(true, Ordering::Relaxed);
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    std::thread::spawn(move || unsafe {
        let h = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0);
        if h.is_err() {
            eprintln!("[HOOK] SetWindowsHookExW for shortcut failed");
            return;
        }
        crate::diag::log("keyboard hook installed");
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            // Pump messages; the hook fires via the OS.
        }
    });
}

#[cfg(target_os = "windows")]
fn key_down(vk: i32) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    // High bit of GetAsyncKeyState = currently held.
    (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
}

#[cfg(not(target_os = "windows"))]
pub fn install_alt_click<F>(_on_alt_click: F)
where
    F: Fn(i32, i32) + Send + Sync + 'static,
{
    // TODO: macOS CGEventTap equivalent for Phase 6.
    eprintln!("[HOOK] ALT+click hook not implemented on this platform yet.");
}

#[cfg(not(target_os = "windows"))]
pub fn install_shortcut<G, F, E>(_get_shortcut: G, _on_shortcut: F, _on_escape: E)
where
    G: Fn() -> String + Send + Sync + 'static,
    F: Fn() + Send + Sync + 'static,
    E: Fn() + Send + Sync + 'static,
{
    eprintln!("[HOOK] shortcut hook not implemented on this platform yet.");
}

#[cfg(target_os = "windows")]
pub fn is_csp_foreground() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return false;
        }
        let mut buf = [0u16; 256];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len == 0 {
            return false;
        }
        let title = String::from_utf16_lossy(&buf[..len as usize]);
        title.to_uppercase().contains("CLIP STUDIO PAINT")
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_csp_foreground() -> bool {
    true
}
