#!/usr/bin/env python3
"""
Luma Palette for Clip Studio Paint — Circular OKLCH Wheel

Usage:
  1. In CSP: Command Bar → "Connect to Smartphone" (QR code appears)
  2. Run: python luma_palette_csp.py
     → A tray icon appears and the screen is scanned for the QR code.
     → Once found, the palette connects automatically.
  3. Hold ALT + click canvas → reads CSP color, shows circular palette
  4. Click any color on the wheel → sets CSP foreground color (palette stays open)
  5. Click outside the palette → closes it
  6. Left-click the tray icon → exit the program

  (Legacy) You can still pass the QR URL as an argument:
     python luma_palette_csp.py "https://companion.clip-studio.com/rc/zh-tw?s=..."

Dependencies:
  pip install pynput Pillow pystray opencv-python-headless
"""

import socket, json, math, sys, platform, threading, queue, colorsys, time, os
import base64
from urllib.parse import urlparse, parse_qs
from tkinter import Tk, Canvas, Label, Frame, PhotoImage

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CONFIG
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHEEL_RADIUS  = 140       # px, radius of the color wheel
SLIDER_W      = 24        # px, width of the lightness slider
SLIDER_GAP    = 12        # px, gap between wheel and slider
CURSOR_OFFSET = (30, 30)
MAX_CHROMA    = 0.20      # OKLCH max chroma for the wheel edge

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CSP COMPANION CRYPTO (from chocolatkey/clipremote)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REMOTE_KEY = bytes([0x74, 0xB2, 0x92, 0x5B, 0x4A, 0x21, 0xDA])
AUTH_KEY   = bytes([0xB6, 0xD5, 0x92, 0xC4, 0xA7, 0x83, 0xE1])

def xor_cycle(data: bytes, key: bytes) -> bytes:
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))

def decode_qr_url(url: str):
    parsed = urlparse(url)
    s_hex = parse_qs(parsed.query)["s"][0]
    s_bytes = bytes.fromhex(s_hex)
    decrypted = xor_cycle(s_bytes, REMOTE_KEY).decode("utf-8")
    parts = decrypted.split("\t")
    return {"ips": parts[0].split(","), "port": int(parts[1]),
            "password": parts[2], "generation": parts[3]}

def obfuscate_auth(password: str) -> str:
    return xor_cycle(password.encode(), AUTH_KEY).hex()

def make_new_password() -> str:
    return base64.b64encode(os.urandom(6)).decode().rstrip("=")

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CSP PROTOCOL (unchanged from previous version)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TYPE_CLIENT = b'\x01'; TERM = b'\x00'; MAX_U32 = 4294967295

class CSPConnection:
    def __init__(self, host, port, password, generation):
        self.host, self.port = host, port
        self.password, self.generation = password, generation
        self.sock = None; self.serial = 0
        self.lock = threading.Lock(); self.recv_buffer = b""
        self.connected = False

    def connect(self):
        print(f"[CSP] Connecting to {self.host}:{self.port}...")
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(5)
        self.sock.connect((self.host, self.port))
        self.connected = True; print("[CSP] Connected!")
        self._authenticate()

    def _authenticate(self):
        curr_token = obfuscate_auth(self.password)
        new_pass = make_new_password()
        new_token = obfuscate_auth(new_pass)
        detail = json.dumps([self.generation, curr_token, new_token], separators=(",",":"))
        resp = self._send_command("Authenticate", detail)
        if resp and resp.get("type") == "success":
            self.password = new_pass
            d = resp.get("detail", {})
            print(f"[CSP] Authenticated! Server: {d.get('RemoteCommandSpecVersionOfServer','?')}")
        else:
            print(f"[CSP] Auth FAILED: {resp}"); self.connected = False

    def _build_message(self, command, serial, detail=""):
        body = (f"$tcp_remote_command_protocol_version=1.0"
                f"\x1e$command={command}\x1e$serial={serial}"
                f"\x1e$detail={detail}\x1e")
        return TYPE_CLIENT + body.encode("utf-8") + TERM

    def _send_command(self, command, detail=""):
        with self.lock:
            if not self.connected and command != "Authenticate": return None
            s = self.serial; self.serial += 1
            msg = self._build_message(command, s, detail)
            try: self.sock.sendall(msg)
            except (OSError, ConnectionError) as e:
                print(f"[CSP] Send error: {e}"); self.connected = False; return None
            return self._read_response(s)

    def _read_response(self, expected, timeout=3):
        deadline = time.time() + timeout
        while time.time() < deadline:
            r = self._try_parse(expected)
            if r is not None: return r
            try:
                self.sock.settimeout(max(0.1, deadline - time.time()))
                chunk = self.sock.recv(8192)
                if not chunk: self.connected = False; return None
                self.recv_buffer += chunk
            except socket.timeout: continue
            except (OSError, ConnectionError): self.connected = False; return None
        return None

    def _try_parse(self, expected):
        while TERM in self.recv_buffer:
            idx = self.recv_buffer.index(TERM)
            start = 0
            for j in range(idx-1, -1, -1):
                if self.recv_buffer[j] in (0x01,0x06,0x15): start = j; break
            raw = self.recv_buffer[start:idx+1]
            self.recv_buffer = self.recv_buffer[idx+1:]
            p = self._parse(raw)
            if p and p.get("serial") == expected: return p
        return None

    def _parse(self, raw):
        if len(raw) < 10: return None
        ptype = raw[0]; body = raw[1:-1]
        parts = body.split(b'\x1e$')
        fields = {}
        for p in parts:
            t = p.decode("utf-8", errors="replace")
            if t.startswith("$"): t = t[1:]
            if "=" in t: k,_,v = t.partition("="); fields[k] = v
        result = {"type": {0x01:"command",0x06:"success",0x15:"error"}.get(ptype,"?"),
                  "command": fields.get("command",""),
                  "serial": int(fields.get("serial",-1))}
        ds = fields.get("detail","")
        if ds:
            try: result["detail"] = json.loads(ds.split("\x0b",1)[0])
            except: result["detail"] = {}
        else: result["detail"] = {}
        return result

    def get_color_rgb(self):
        resp = self._send_command("SyncColorCircleUIState")
        if not resp or resp.get("type") != "success": return None
        d = resp.get("detail",{})
        if "HSVColorMainH" not in d: return None
        h = (d["HSVColorMainH"]/MAX_U32)*360
        s = (d["HSVColorMainS"]/MAX_U32)*100
        v = (d["HSVColorMainV"]/MAX_U32)*100
        r,g,b = colorsys.hsv_to_rgb(h/360,s/100,v/100)
        return int(r*255),int(g*255),int(b*255)

    def set_color_hex(self, hx, idx=0):
        hx = hx.lstrip("#")
        r,g,b = int(hx[0:2],16),int(hx[2:4],16),int(hx[4:6],16)
        h,s,v = colorsys.rgb_to_hsv(r/255,g/255,b/255)
        detail = json.dumps({"ColorSpaceKind":"HSV","IsColorTransparent":False,
            "HSVColorH":int(h*MAX_U32),"HSVColorS":int(s*MAX_U32),
            "HSVColorV":int(v*MAX_U32),"ColorIndex":idx}, separators=(",",":"))
        return self._send_command("SetCurrentColor", detail)

    def heartbeat(self):
        if not self.connected: return
        try: self._send_command("TellHeartbeat")
        except: pass

    def disconnect(self):
        self.connected = False
        try: self.sock.close()
        except: pass

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# OKLCH COLOR MATH
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def oklch_to_oklab(L,C,h):
    r=math.radians(h); return L,C*math.cos(r),C*math.sin(r)
def oklab_to_linear(L,a,b):
    l_=L+.3963377774*a+.2158037573*b; m_=L-.1055613458*a-.0638541728*b; s_=L-.0894841775*a-1.291485548*b
    l=l_*l_*l_; m=m_*m_*m_; s=s_*s_*s_
    return 4.0767416621*l-3.3077115913*m+.2309699292*s, -1.2684380046*l+2.6097574011*m-.3413193965*s, -.0041960863*l-.7034186147*m+1.707614701*s
def lin2s(c): return 12.92*c if c<=.0031308 else 1.055*(c**(1/2.4))-.055
def s2lin(c): return c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4
def oklch2rgb(L,C,h):
    ol,oa,ob=oklch_to_oklab(L,C,h); lr,lg,lb=oklab_to_linear(ol,oa,ob)
    return lin2s(lr),lin2s(lg),lin2s(lb)
def rgb2oklch(r,g,b):
    lr,lg,lb=s2lin(r),s2lin(g),s2lin(b)
    l_=.4122214708*lr+.5363325363*lg+.0514459929*lb
    m_=.2119034982*lr+.6806995451*lg+.1073969566*lb
    s_=.0883024619*lr+.2220049481*lg+.689692687*lb
    l=math.copysign(abs(l_)**(1/3),l_); m=math.copysign(abs(m_)**(1/3),m_); s=math.copysign(abs(s_)**(1/3),s_)
    L=.2104542553*l+.793617785*m-.0040720468*s
    a=1.9779984951*l-2.428592205*m+.4505937099*s
    bv=.0259040371*l+.7827717662*m-.808675766*s
    return L,math.sqrt(a*a+bv*bv),math.degrees(math.atan2(bv,a))%360
def clamp01(v): return max(0.,min(1.,v))

def gamut_clamp(L,C,h):
    r,g,b=oklch2rgb(L,C,h)
    if -.002<=r<=1.002 and -.002<=g<=1.002 and -.002<=b<=1.002:
        return clamp01(r),clamp01(g),clamp01(b)
    lo,hi=0.,C
    for _ in range(20):
        mid=(lo+hi)/2; mr,mg,mb=oklch2rgb(L,mid,h)
        if -.002<=mr<=1.002 and -.002<=mg<=1.002 and -.002<=mb<=1.002: lo=mid
        else: hi=mid
    r,g,b=oklch2rgb(L,lo,h); return clamp01(r),clamp01(g),clamp01(b)

def rgb_hex(r,g,b): return f"#{round(r*255):02x}{round(g*255):02x}{round(b*255):02x}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CIRCULAR PALETTE RENDERER
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import numpy as np

def render_wheel_ppm(lightness, radius=WHEEL_RADIUS, max_c=MAX_CHROMA):
    """Render a circular OKLCH palette as PPM pixel data extremely fast using NumPy."""
    size = radius * 2
    dy, dx = np.ogrid[-radius:radius, -radius:radius]
    dist = np.sqrt(dx**2 + dy**2)
    mask = dist <= (radius - 1)
    
    pixels = np.full((size, size, 3), [30, 30, 32], dtype=np.uint8)
    if not mask.any(): 
        header = f"P6\n{size} {size}\n255\n".encode()
        return header + pixels.tobytes(), None
        
    dy_full = np.broadcast_to(dy, (size, size))
    dx_full = np.broadcast_to(dx, (size, size))
    dy_m = dy_full[mask]
    dx_m = dx_full[mask]
    dist_m = dist[mask]
    
    angle_deg = np.degrees(np.arctan2(-dy_m, dx_m))
    hue = (150 - angle_deg) % 360
    chroma = (dist_m / radius) * max_c
    L = np.full_like(hue, float(lightness))
    h_rad = np.radians(hue)
    
    def get_rgb(C_val):
        a_val = C_val * np.cos(h_rad)
        b_val = C_val * np.sin(h_rad)
        l_ = L + 0.3963377774 * a_val + 0.2158037573 * b_val
        m_ = L - 0.1055613458 * a_val - 0.0638541728 * b_val
        s_ = L - 0.0894841775 * a_val - 1.291485548 * b_val
        l_cb = l_**3; m_cb = m_**3; s_cb = s_**3
        r_lin = 4.0767416621 * l_cb - 3.3077115913 * m_cb + 0.2309699292 * s_cb
        g_lin = -1.2684380046 * l_cb + 2.6097574011 * m_cb - 0.3413193965 * s_cb
        b_lin = -0.0041960863 * l_cb - 0.7034186147 * m_cb + 1.707614701 * s_cb
        sg_r = np.where(r_lin <= 0.0031308, 12.92 * r_lin, 1.055 * (np.maximum(r_lin, 0) ** (1/2.4)) - 0.055)
        sg_g = np.where(g_lin <= 0.0031308, 12.92 * g_lin, 1.055 * (np.maximum(g_lin, 0) ** (1/2.4)) - 0.055)
        sg_b = np.where(b_lin <= 0.0031308, 12.92 * b_lin, 1.055 * (np.maximum(b_lin, 0) ** (1/2.4)) - 0.055)
        return sg_r, sg_g, sg_b

    lo = np.zeros_like(chroma)
    hi = chroma.copy()
    
    r, g, b = get_rgb(hi)
    in_gamut = (r >= -0.002) & (r <= 1.002) & (g >= -0.002) & (g <= 1.002) & (b >= -0.002) & (b <= 1.002)
    
    for _ in range(20):
        mid = (lo + hi) / 2
        mr, mg, mb = get_rgb(mid)
        mid_in_gamut = (mr >= -0.002) & (mr <= 1.002) & (mg >= -0.002) & (mg <= 1.002) & (mb >= -0.002) & (mb <= 1.002)
        lo = np.where(mid_in_gamut, mid, lo)
        hi = np.where(mid_in_gamut, hi, mid)
        
    final_C = np.where(in_gamut, chroma, lo)
    r, g, b = get_rgb(final_C)

    r8 = np.clip(np.round(r * 255), 0, 255).astype(np.uint8)
    g8 = np.clip(np.round(g * 255), 0, 255).astype(np.uint8)
    b8 = np.clip(np.round(b * 255), 0, 255).astype(np.uint8)
    
    pixels[mask, 0] = r8
    pixels[mask, 1] = g8
    pixels[mask, 2] = b8
    
    header = f"P6\n{size} {size}\n255\n".encode()
    return header + pixels.tobytes(), None


def render_slider_ppm(width=SLIDER_W, height=WHEEL_RADIUS*2, current_L=0.65):
    """Render a vertical lightness slider as PPM."""
    L_array = 1.0 - (np.arange(height) / (height - 1))
    l_ = L_array; m_ = L_array; s_ = L_array
    r_lin = 4.0767416621 * l_**3 - 3.3077115913 * m_**3 + 0.2309699292 * s_**3
    sg_r = np.where(r_lin <= 0.0031308, 12.92 * r_lin, 1.055 * (np.maximum(r_lin, 0) ** (1/2.4)) - 0.055)
    val8 = np.clip(np.round(sg_r * 255), 0, 255).astype(np.uint8)
    
    pixels = np.zeros((height, width, 3), dtype=np.uint8)
    pixels[:, :, 0] = val8[:, None]
    pixels[:, :, 1] = val8[:, None]
    pixels[:, :, 2] = val8[:, None]
    
    header = f"P6\n{width} {height}\n255\n".encode()
    return header + pixels.tobytes()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PALETTE UI
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class LumaPaletteApp:
    def __init__(self, csp):
        self.csp = csp
        self.q = queue.Queue()
        self.cur_hex = "#808080"
        self.cur_L = 0.65
        self.palette_shown = False
        self.win_x = self.win_y = 0
        self.win_w = self.win_h = 0

        # Tkinter
        self.root = Tk(); self.root.withdraw()
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.configure(bg="#1e1e20")

        self._build_ui()
        self._no_activate()
        self._hotkeys()
        self.root.after(16, self._poll)
        self.root.after(3000, self._hb)

        print("=" * 48)
        print("  Luma Palette (Circular OKLCH) ready!")
        print("  ALT + click canvas -> sample & show palette")
        print("  Click/drag wheel   -> change CSP color")
        print("  Click/drag slider  -> change lightness")
        print("  Click outside      -> close palette")
        print("=" * 48)

    _wheel_gen = 0

    def _render_wheel_async(self, L):
        """Render wheel in a background thread; result delivered via queue."""
        self._wheel_gen += 1
        gen = self._wheel_gen
        def worker():
            ppm_data, color_map = render_wheel_ppm(L)
            self.q.put(("wheel_ready", ppm_data, color_map, gen))
        threading.Thread(target=worker, daemon=True).start()

    def _update_wheel_overlay(self):
        """Cheap: redraw canvas with cached image + marker (no pixel recalc)."""
        self.wheel_cv.delete("all")
        if self.wheel_img:
            self.wheel_cv.create_image(0, 0, anchor="nw", image=self.wheel_img)

        cx = cy = WHEEL_RADIUS
        # Center dot showing current sampled color
        self.wheel_cv.create_oval(cx-6, cy-6, cx+6, cy+6,
                                   fill=self.cur_hex, outline="#fff", width=1)
        # Marker ring at current color position
        _, cur_C, cur_h = rgb2oklch(*[int(self.cur_hex[i:i+2],16)/255 for i in (1,3,5)])
        marker_dist = min(cur_C / MAX_CHROMA, 1.0) * WHEEL_RADIUS
        screen_angle = math.radians(150 - cur_h)
        mx = cx + marker_dist * math.cos(screen_angle)
        my = cy - marker_dist * math.sin(screen_angle)
        self.wheel_cv.create_oval(mx-4, my-4, mx+4, my+4,
                                   fill="", outline="#fff", width=2)

    def _draw_wheel(self, L):
        """Non-blocking wheel draw via background thread."""
        self._render_wheel_async(L)

    def _build_ui(self):
        diam = WHEEL_RADIUS * 2
        total_w = diam + SLIDER_GAP + SLIDER_W + 8
        total_h = diam + 30  # room for info label

        font = "Consolas" if platform.system() == "Windows" else "Menlo"

        # Info label at top
        self.info = Label(self.root, text="", font=(font, 9),
                          fg="#bbb", bg="#1e1e20", anchor="w")
        self.info.pack(fill="x", padx=6, pady=(4, 2))

        # Container frame
        container = Frame(self.root, bg="#1e1e20")
        container.pack(padx=4, pady=(0, 4))

        # Wheel canvas
        self.wheel_cv = Canvas(container, width=diam, height=diam,
                               bg="#1e1e20", highlightthickness=0)
        self.wheel_cv.pack(side="left")
        self.wheel_cv.bind("<Button-1>", self._on_wheel_click)
        self.wheel_cv.bind("<B1-Motion>", self._on_wheel_drag)
        self.wheel_cv.bind("<ButtonRelease-1>", self._on_wheel_release)

        # Slider canvas
        self.slider_cv = Canvas(container, width=SLIDER_W, height=diam,
                                bg="#1e1e20", highlightthickness=0)
        self.slider_cv.pack(side="left", padx=(SLIDER_GAP, 0))
        self.slider_cv.bind("<Button-1>", self._on_slider_click)
        self.slider_cv.bind("<B1-Motion>", self._on_slider_drag)
        self.slider_cv.bind("<ButtonRelease-1>", self._on_slider_release)

        # PhotoImage holders
        self.wheel_img = None
        self.slider_img = None

        # Throttle state
        self._last_csp_send = 0.0
        self._last_wheel_render = 0.0



    def _draw_slider(self, L):
        """Render the lightness slider with position indicator."""
        ppm_data = render_slider_ppm()
        self.slider_img = PhotoImage(data=ppm_data)
        self.slider_cv.delete("all")
        self.slider_cv.create_image(0, 0, anchor="nw", image=self.slider_img)

        # Draw current L indicator
        h = WHEEL_RADIUS * 2
        y_pos = int((1.0 - L) * (h - 1))
        self.slider_cv.create_line(0, y_pos, SLIDER_W, y_pos,
                                    fill="#fff", width=2)
        self.slider_cv.create_rectangle(0, y_pos-1, SLIDER_W, y_pos+1,
                                         outline="#fff", width=1)

    def _update_slider_indicator(self, L):
        """Cheap: just move the slider indicator without re-rendering."""
        self.slider_cv.delete("indicator")
        h = WHEEL_RADIUS * 2
        y_pos = int((1.0 - L) * (h - 1))
        self.slider_cv.create_line(0, y_pos, SLIDER_W, y_pos,
                                    fill="#fff", width=2, tags="indicator")
        self.slider_cv.create_rectangle(0, y_pos-1, SLIDER_W, y_pos+1,
                                         outline="#fff", width=1, tags="indicator")

    def _update_info(self):
        r,g,b = [int(self.cur_hex[i:i+2],16) for i in (1,3,5)]
        L,C,h = rgb2oklch(r/255, g/255, b/255)
        self.info.configure(
            text=f" {self.cur_hex.upper()}  L={L:.0%}  C={C:.3f}  H={h:.0f}")

    # ── WHEEL INTERACTION ────────────────────────────────────────

    def _pick_wheel_color(self, event):
        """Pick color from wheel at cursor position instantaneously."""
        x, y = event.x, event.y
        cx = cy = WHEEL_RADIUS
        dx, dy = x - cx, y - cy
        dist = math.sqrt(dx*dx + dy*dy)
        if dist > WHEEL_RADIUS - 1:
            return False
            
        angle = math.degrees(math.atan2(-dy, dx))
        hue = (150 - angle) % 360
        chroma = (dist / WHEEL_RADIUS) * MAX_CHROMA
        
        r, g, b = gamut_clamp(self.cur_L, chroma, hue)
        self.cur_hex = rgb_hex(r, g, b)
        
        self._update_info()
        self._update_wheel_overlay()  # fast: just redraws markers
        return True

    def _send_color_to_csp(self):
        """Send current color to CSP in a background thread."""
        hx = self.cur_hex
        threading.Thread(target=self.csp.set_color_hex,
                         args=(hx,), daemon=True).start()

    def _throttled_csp_send(self):
        """Send color to CSP at most ~2x per second during drag."""
        now = time.time()
        if now - self._last_csp_send >= 0.5:
            self._last_csp_send = now
            self._send_color_to_csp()

    def _on_wheel_click(self, event):
        """Click on wheel -> pick color, send to CSP."""
        if self._pick_wheel_color(event):
            self._last_csp_send = time.time()
            self._send_color_to_csp()

    def _on_wheel_drag(self, event):
        """Drag on wheel -> pick color, throttle CSP sends."""
        if self._pick_wheel_color(event):
            self._throttled_csp_send()

    def _on_wheel_release(self, event):
        """Release on wheel -> final CSP send."""
        if self._pick_wheel_color(event):
            self._send_color_to_csp()

    # ── SLIDER INTERACTION ───────────────────────────────────────

    def _on_slider_click(self, event):
        self._set_lightness_from_y(event.y, is_final=True)

    def _on_slider_drag(self, event):
        self._set_lightness_from_y(event.y, is_final=False)

    def _on_slider_release(self, event):
        self._set_lightness_from_y(event.y, is_final=True)

    def _set_lightness_from_y(self, y, is_final=True):
        h = WHEEL_RADIUS * 2
        y = max(0, min(h - 1, y))
        L = 1.0 - (y / (h - 1))
        L = max(0.05, min(0.95, L))
        if abs(self.cur_L - L) < 0.001 and not is_final:
            return  # no meaningful change
        self.cur_L = L

        # 1. Update the currently selected color based on the new lightness
        r, g, b = [int(self.cur_hex[i:i+2], 16) / 255 for i in (1, 3, 5)]
        _, cur_C, cur_h = rgb2oklch(r, g, b)
        new_r, new_g, new_b = gamut_clamp(L, cur_C, cur_h)
        self.cur_hex = rgb_hex(new_r, new_g, new_b)

        # 2. Update UI instantly
        self._update_info()
        self._update_slider_indicator(L)
        self._update_wheel_overlay()  # moves marker dot if needed

        # 3. Request background wheel re-render (throttled)
        now = time.time()
        if is_final or now - self._last_wheel_render >= 0.15:
            self._last_wheel_render = now
            self._render_wheel_async(L)

        # 4. Send color to CSP
        if is_final:
            self._send_color_to_csp()
        else:
            self._throttled_csp_send()

    # ── SHOW / HIDE ──────────────────────────────────────────────

    def _show(self, x, y):
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self.root.update_idletasks()
        pw = self.root.winfo_reqwidth()
        ph = self.root.winfo_reqheight()
        wx, wy = x + CURSOR_OFFSET[0], y + CURSOR_OFFSET[1]
        if wx + pw > sw: wx = x - pw - CURSOR_OFFSET[0]
        if wy + ph > sh: wy = y - ph - CURSOR_OFFSET[1]
        wx, wy = max(0, wx), max(0, wy)
        self.win_x, self.win_y = wx, wy
        self.win_w, self.win_h = pw, ph
        self.root.geometry(f"+{wx}+{wy}")
        self.root.deiconify(); self.root.lift()
        self.palette_shown = True

    def _hide(self):
        self.root.withdraw()
        self.palette_shown = False

    def _is_inside(self, sx, sy):
        """Check if screen coords are inside our palette window."""
        return (self.win_x <= sx <= self.win_x + self.win_w and
                self.win_y <= sy <= self.win_y + self.win_h)

    # ── WINDOW MANAGEMENT ────────────────────────────────────────

    def _no_activate(self):
        self.root.update_idletasks()
        if platform.system() == "Windows":
            try:
                import ctypes
                hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id())
                if not hwnd: hwnd = self.root.winfo_id()
                s = ctypes.windll.user32.GetWindowLongW(hwnd, -20)
                ctypes.windll.user32.SetWindowLongW(hwnd, -20,
                    (s | 0x08000080) & ~0x00040000)
            except: pass

    # ── INPUT HANDLING ───────────────────────────────────────────

    def _hotkeys(self):
        from pynput import keyboard, mouse
        self.alt = False; self.armed = True

        def kp(k):
            if k == keyboard.Key.alt_l:
                self.alt = True; self.armed = True

        def kr(k):
            if k == keyboard.Key.alt_l:
                self.alt = False
                # Don't auto-hide on ALT release anymore

        def mc(x, y, btn, pressed):
            if not pressed or btn != mouse.Button.left:
                return
            if self.alt and self.armed:
                # ALT+click → sample color and show palette
                self.armed = False
                threading.Thread(target=self._sample,
                                 args=(x, y), daemon=True).start()
            elif self.palette_shown and not self._is_inside(x, y):
                # Click outside → close palette
                self.q.put(("hide",))

        kl = keyboard.Listener(on_press=kp, on_release=kr)
        kl.daemon = True; kl.start()
        ml = mouse.Listener(on_click=mc)
        ml.daemon = True; ml.start()

    def _sample(self, x, y):
        rgb = self.csp.get_color_rgb()
        if rgb:
            r, g, b = rgb
            self.cur_hex = f"#{r:02x}{g:02x}{b:02x}"
        else:
            try:
                from PIL import ImageGrab
                img = ImageGrab.grab(bbox=(x,y,x+1,y+1))
                r,g,b = img.getpixel((0,0))[:3]
                self.cur_hex = f"#{r:02x}{g:02x}{b:02x}"
            except: return
            r,g,b = int(self.cur_hex[1:3],16), int(self.cur_hex[3:5],16), int(self.cur_hex[5:7],16)
        L,_,_ = rgb2oklch(r/255, g/255, b/255)
        self.cur_L = L
        self.q.put(("show", x, y))

    # ── EVENT LOOP ───────────────────────────────────────────────

    def _poll(self):
        try:
            while True:
                m = self.q.get_nowait()
                if m[0] == "show":
                    self._draw_slider(self.cur_L)
                    self._update_info()
                    self._render_wheel_async(self.cur_L)
                    self._show(m[1], m[2])
                elif m[0] == "hide":
                    self._hide()
                elif m[0] == "wheel_ready":
                    _, ppm_data, _, gen = m
                    if gen >= self._wheel_gen:  # discard stale renders
                        self.wheel_img = PhotoImage(data=ppm_data)
                        self._update_wheel_overlay()
        except queue.Empty:
            pass
        self.root.after(16, self._poll)

    def _hb(self):
        if self.csp.connected:
            threading.Thread(target=self.csp.heartbeat, daemon=True).start()
        self.root.after(3000, self._hb)

    def run(self):
        try: self.root.mainloop()
        except KeyboardInterrupt: self.csp.disconnect()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TRAY ICON & QR AUTO-SCAN
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def create_tray_icon_image():
    """Create a small palette-style icon for the system tray."""
    from PIL import Image, ImageDraw
    sz = 64
    img = Image.new('RGBA', (sz, sz), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Outer ring
    draw.ellipse([2, 2, sz-2, sz-2], fill=(60, 90, 180), outline=(180, 200, 255), width=2)
    # Inner white circle
    draw.ellipse([20, 20, sz-20, sz-20], fill=(255, 255, 255))
    # Four color dots around the ring
    for angle, color in [(0, (255,80,80)), (90, (80,200,80)),
                          (180, (80,120,255)), (270, (255,200,50))]:
        rad = math.radians(angle)
        cx = sz // 2 + int(16 * math.cos(rad))
        cy = sz // 2 - int(16 * math.sin(rad))
        draw.ellipse([cx-5, cy-5, cx+5, cy+5], fill=color)
    return img


_scan_error_shown = False
_qr_detector = None

def scan_screen_for_qr():
    """Capture the screen and look for a CSP companion QR code URL.
    Uses OpenCV's built-in QRCodeDetector (no external DLLs needed)."""
    global _scan_error_shown, _qr_detector
    try:
        from PIL import ImageGrab
        import cv2
        import numpy as np
        if _qr_detector is None:
            _qr_detector = cv2.QRCodeDetector()
        screenshot = ImageGrab.grab()
        frame = np.array(screenshot)
        frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
        data, bbox, _ = _qr_detector.detectAndDecode(frame)
        if data and 'companion.clip-studio.com' in data:
            return data
    except Exception as e:
        if not _scan_error_shown:
            print(f"[QR] Scan error: {e}")
            _scan_error_shown = True
    return None


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if __name__ == "__main__":
    import pystray

    # ── Tray icon (persistent, runs in background thread) ────────
    def on_exit(icon, item):
        icon.stop()
        os._exit(0)

    icon_image = create_tray_icon_image()
    tray = pystray.Icon(
        "LumaPalette", icon_image, "Luma Palette - Waiting for QR",
        menu=pystray.Menu(
            pystray.MenuItem("Exit", on_exit),
        ),
    )

    def on_tray_setup(icon):
        icon.visible = True

    tray_thread = threading.Thread(
        target=lambda: tray.run(setup=on_tray_setup), daemon=True)
    tray_thread.start()
    time.sleep(0.5)  # let the icon register with the shell

    # ── Obtain the QR URL ────────────────────────────────────────
    if len(sys.argv) >= 2:
        url = sys.argv[1]
        print("[QR] Using URL from command line.")
    else:
        tray.notify("Waiting for QR - open the CSP companion\n"
                    "QR screen and it will be detected automatically.",
                    "Luma Palette")
        print("[QR] Scanning screen for CSP companion QR code...")
        url = None
        while True:
            url = scan_screen_for_qr()
            if url:
                break
            time.sleep(1.5)

        print(f"[QR] Found: {url[:80]}...")
        tray.notify("QR code found! Connecting...", "Luma Palette")

    # ── Decode & connect ─────────────────────────────────────────
    cfg = decode_qr_url(url)
    print(f"[QR] IP: {cfg['ips']}, Port: {cfg['port']}, Gen: {cfg['generation']}")

    csp = CSPConnection(cfg["ips"][0], cfg["port"],
                        cfg["password"], cfg["generation"])
    try:
        csp.connect()
    except Exception as e:
        print(f"[!] Connection failed: {e}")
        tray.notify(f"Connection failed: {e}", "Luma Palette")
        time.sleep(3)
        os._exit(1)

    tray.title = "Luma Palette - Connected"
    tray.notify("Connected to CSP!", "Luma Palette")
    print("[CSP] Connected!")

    rgb = csp.get_color_rgb()
    if rgb:
        r, g, b = rgb
        print(f"[CSP] Current color: #{r:02x}{g:02x}{b:02x}")

    app = LumaPaletteApp(csp)
    app.run()
