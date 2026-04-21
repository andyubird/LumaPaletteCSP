// Windows-only low-level mouse hook that detects ALT+left-click anywhere on screen.
// Replaces pynput's global mouse/keyboard listeners from the Python version.

#[cfg(target_os = "windows")]
pub fn install_alt_click<F>(on_alt_click: F)
where
    F: Fn(i32, i32) + Send + Sync + 'static,
{
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_MENU};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL,
        WM_LBUTTONDOWN,
    };

    static CALLBACK: OnceLock<Box<dyn Fn(i32, i32) + Send + Sync>> = OnceLock::new();
    let _ = CALLBACK.set(Box::new(on_alt_click));

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && wparam.0 as u32 == WM_LBUTTONDOWN {
            // High bit of GetAsyncKeyState = currently held.
            let alt_down = (unsafe { GetAsyncKeyState(VK_MENU.0 as i32) } as u16 & 0x8000) != 0;
            if alt_down {
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

#[cfg(not(target_os = "windows"))]
pub fn install_alt_click<F>(_on_alt_click: F)
where
    F: Fn(i32, i32) + Send + Sync + 'static,
{
    // TODO: macOS CGEventTap equivalent for Phase 6.
    eprintln!("[HOOK] ALT+click hook not implemented on this platform yet.");
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
