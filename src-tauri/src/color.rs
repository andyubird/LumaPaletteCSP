// HSV<->RGB conversion matching Python's colorsys.
// CSP wire protocol uses HSV scaled to u32. Frontend deals in sRGB hex.

pub fn hsv_to_rgb(h: f64, s: f64, v: f64) -> (f64, f64, f64) {
    // h in [0,1), s,v in [0,1]
    if s <= 0.0 {
        return (v, v, v);
    }
    let mut hh = h * 6.0;
    if hh >= 6.0 {
        hh = 0.0;
    }
    let i = hh.floor();
    let f = hh - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    match i as i32 {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    }
}

pub fn rgb_to_hsv(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let v = max;
    let d = max - min;
    let s = if max > 0.0 { d / max } else { 0.0 };
    if d == 0.0 {
        return (0.0, 0.0, v);
    }
    let h = if max == r {
        ((g - b) / d) % 6.0
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    let mut h = h / 6.0;
    if h < 0.0 {
        h += 1.0;
    }
    (h, s, v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn roundtrip_primary() {
        let (h, s, v) = rgb_to_hsv(1.0, 0.0, 0.0);
        let (r, g, b) = hsv_to_rgb(h, s, v);
        assert!(close(r, 1.0) && close(g, 0.0) && close(b, 0.0));
    }

    #[test]
    fn gray() {
        let (h, s, v) = rgb_to_hsv(0.5, 0.5, 0.5);
        assert_eq!(h, 0.0);
        assert_eq!(s, 0.0);
        assert!(close(v, 0.5));
    }
}
