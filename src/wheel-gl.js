// GPU wheel surface: renders the wheel image with a fragment shader at device
// resolution. The color math mirrors oklch.js / color-models.js / lab.js; keep
// them in step. The marker and center dot are drawn by the wheel on a stacked
// transparent 2D canvas because a canvas can hold only one kind of context.
import { MAX_CHROMA } from "./oklch.js";

// Device pixels per CSS pixel, clamped so a misreported ratio can't allocate
// absurd backing stores. 1 outside a browser (unit tests).
export function backingScale() {
  if (typeof window === "undefined") return 1;
  return Math.max(1, Math.min(4, window.devicePixelRatio || 1));
}

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// Shared by every wheel shader. Coordinates are converted back to logical
// (CSS-pixel, y-down) space so the geometry matches pickAt()/colorAtAxis().
const PRELUDE = `
precision highp float;
uniform float uSize;
uniform float uDpr;
uniform float uL;
uniform float uGamutWarning;
uniform float uMaxChroma;
const float HUE_OFFSET = 150.0;
const vec3 BG = vec3(30.0, 30.0, 32.0) / 255.0;

vec2 logicalCoord() {
  return vec2(gl_FragCoord.x / uDpr, uSize - gl_FragCoord.y / uDpr);
}

float lin2s(float c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055;
}
vec3 lin2s3(vec3 c) { return vec3(lin2s(c.r), lin2s(c.g), lin2s(c.b)); }
bool inGamut(vec3 c) {
  return all(greaterThanEqual(c, vec3(-0.002))) && all(lessThanEqual(c, vec3(1.002)));
}

// Disc wheels: hue in degrees, radial position 0..1, and rim coverage that
// antialiases the disc edge against the background (the CPU path cuts off at
// radius - 1, so the soft edge is centered there).
struct Polar { float hue; float radial; float rim; };
Polar polarAt(vec2 p) {
  float R = uSize * 0.5;
  vec2 d = p - vec2(R);
  float dist = length(d);
  float angle = degrees(atan(-d.y, d.x));
  Polar pr;
  pr.hue = mod(HUE_OFFSET - angle, 360.0);
  pr.radial = min(dist / R, 1.0);
  pr.rim = 1.0 - smoothstep(R - 1.75, R - 0.25, dist);
  return pr;
}
`;

const FRAG = {
  oklch: `
vec3 oklabToLinear(float L, float a, float b) {
  float l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  float m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  float s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;
  return vec3(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 oklch2rgb(float L, float C, float hDeg) {
  float r = radians(hDeg);
  return lin2s3(oklabToLinear(L, C * cos(r), C * sin(r)));
}
void main() {
  Polar pr = polarAt(logicalCoord());
  float chroma = pr.radial * uMaxChroma;
  vec3 rgb = oklch2rgb(uL, chroma, pr.hue);
  vec3 color;
  if (inGamut(rgb)) {
    color = rgb;
  } else if (uGamutWarning > 0.5) {
    color = vec3(80.0, 80.0, 82.0) / 255.0;
  } else {
    // Same chroma binary search as gamutClamp() in oklch.js.
    float lo = 0.0;
    float hi = chroma;
    for (int i = 0; i < 20; i++) {
      float mid = 0.5 * (lo + hi);
      if (inGamut(oklch2rgb(uL, mid, pr.hue))) lo = mid; else hi = mid;
    }
    color = oklch2rgb(uL, lo, pr.hue);
  }
  gl_FragColor = vec4(mix(BG, clamp(color, 0.0, 1.0), pr.rim), 1.0);
}
`,
  hsv: `
vec3 hsv2rgb(float h, float s, float v) {
  vec3 p = abs(fract(vec3(h) + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return v * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), s);
}
void main() {
  Polar pr = polarAt(logicalCoord());
  vec3 color = hsv2rgb(pr.hue / 360.0, pr.radial, uL);
  gl_FragColor = vec4(mix(BG, color, pr.rim), 1.0);
}
`,
  hsl: `
float hslChannel(float n, float h, float s, float l) {
  float k = mod(n + h * 12.0, 12.0);
  float a = s * min(l, 1.0 - l);
  return l - a * max(-1.0, min(min(k - 3.0, 9.0 - k), 1.0));
}
vec3 hsl2rgb(float h, float s, float l) {
  return vec3(hslChannel(0.0, h, s, l), hslChannel(8.0, h, s, l), hslChannel(4.0, h, s, l));
}
void main() {
  Polar pr = polarAt(logicalCoord());
  vec3 color = hsl2rgb(pr.hue / 360.0, pr.radial, uL);
  gl_FragColor = vec4(mix(BG, color, pr.rim), 1.0);
}
`,
  lab: `
const float EPS = 216.0 / 24389.0;
const float KAPPA = 24389.0 / 27.0;
float labFinv(float t) {
  float t3 = t * t * t;
  return t3 > EPS ? t3 : (116.0 * t - 16.0) / KAPPA;
}
vec3 lab2rgbRaw(float L, float a, float b) {
  float fy = (L + 16.0) / 116.0;
  float fx = fy + a / 500.0;
  float fz = fy - b / 200.0;
  float X = 0.95047 * labFinv(fx);
  float Y = labFinv(fy);
  float Z = 1.08883 * labFinv(fz);
  return lin2s3(vec3(
     3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z,
     0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z));
}
void main() {
  vec2 p = logicalCoord();
  float a = (p.x / (uSize - 1.0)) * 256.0 - 128.0;
  float b = 128.0 - (p.y / (uSize - 1.0)) * 256.0;
  vec3 rgb = lab2rgbRaw(uL * 100.0, a, b);
  vec3 color = !inGamut(rgb) && uGamutWarning > 0.5
    ? vec3(78.0, 78.0, 82.0) / 255.0
    : clamp(rgb, 0.0, 1.0);
  gl_FragColor = vec4(color, 1.0);
}
`,
};

const CONTEXT_OPTS = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
};

function getGl(canvas) {
  try {
    return canvas.getContext("webgl2", CONTEXT_OPTS) || canvas.getContext("webgl", CONTEXT_OPTS);
  } catch {
    return null;
  }
}

function compile(gl, kind, source) {
  const shader = gl.createShader(kind);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function buildPrograms(gl) {
  const vert = compile(gl, gl.VERTEX_SHADER, VERT);
  const programs = {};
  for (const [type, body] of Object.entries(FRAG)) {
    const frag = compile(gl, gl.FRAGMENT_SHADER, PRELUDE + body);
    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed (${type}): ${gl.getProgramInfoLog(program)}`);
    }
    programs[type] = {
      program,
      aPos: gl.getAttribLocation(program, "aPos"),
      uSize: gl.getUniformLocation(program, "uSize"),
      uDpr: gl.getUniformLocation(program, "uDpr"),
      uL: gl.getUniformLocation(program, "uL"),
      uGamutWarning: gl.getUniformLocation(program, "uGamutWarning"),
      uMaxChroma: gl.getUniformLocation(program, "uMaxChroma"),
    };
  }
  return programs;
}

function buildQuad(gl) {
  // One triangle that covers clip space; cheaper than a two-triangle quad.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  return buffer;
}

function setLogicalSize(canvas, size) {
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
}

function findOrCreateOverlay(canvas) {
  const parent = canvas.parentElement;
  let overlay = parent ? parent.querySelector("canvas[data-wheel-overlay]") : null;
  if (!overlay) {
    overlay = document.createElement("canvas");
    overlay.dataset.wheelOverlay = "";
    overlay.style.position = "absolute";
    overlay.style.left = "0";
    overlay.style.top = "0";
    overlay.style.pointerEvents = "none";
    if (parent && getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    canvas.insertAdjacentElement("afterend", overlay);
  }
  return overlay;
}

class GlSurface {
  constructor(canvas, gl, size) {
    this.canvas = canvas;
    this.gl = gl;
    this.size = size;
    this.programs = buildPrograms(gl);
    this.quad = buildQuad(gl);
    this.last = null;

    this.overlay = findOrCreateOverlay(canvas);
    this.overlayCtx = this.overlay.getContext("2d");
    setLogicalSize(canvas, size);
    setLogicalSize(this.overlay, size);
    this._fit(canvas);
    this._fit(this.overlay);

    canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
    canvas.addEventListener("webglcontextrestored", () => {
      this.programs = buildPrograms(gl);
      this.quad = buildQuad(gl);
      if (this.last) this.renderImage(this.last.type, this.last);
    });
  }

  // Keep the backing store at device resolution; returns true when it changed.
  _fit(canvas) {
    const px = Math.round(this.size * backingScale());
    if (canvas.width === px && canvas.height === px) return false;
    canvas.width = px;
    canvas.height = px;
    return true;
  }

  renderImage(type, { L, gamutWarning = false }) {
    const gl = this.gl;
    this.last = { type, L, gamutWarning };
    this._fit(this.canvas);
    const prog = this.programs[type] || this.programs.oklch;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(prog.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(prog.aPos);
    gl.vertexAttribPointer(prog.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(prog.uSize, this.size);
    gl.uniform1f(prog.uDpr, this.canvas.width / this.size);
    gl.uniform1f(prog.uL, L);
    gl.uniform1f(prog.uGamutWarning, gamutWarning ? 1 : 0);
    gl.uniform1f(prog.uMaxChroma, MAX_CHROMA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // `paint(ctx)` draws the overlay in logical coordinates.
  draw(paint) {
    const resized = this._fit(this.overlay);
    if (resized && this.last) this.renderImage(this.last.type, this.last);
    const ctx = this.overlayCtx;
    const scale = this.overlay.width / this.size;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);
    paint(ctx);
  }

  clearImage() {
    const gl = this.gl;
    gl.clearColor(30 / 255, 30 / 255, 32 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.last = null;
  }
}

// Returns a GPU surface for `canvas`, or null when WebGL is unavailable so the
// caller can use the CPU path. Shaders are proven on a throwaway canvas first:
// asking a canvas for a WebGL context is irreversible, so a compile failure
// must not leave the real canvas unable to hand out a 2D context.
export function createGlSurface(canvas, size) {
  if (typeof document === "undefined" || !canvas || typeof canvas.getContext !== "function") {
    return null;
  }
  const probe = document.createElement("canvas");
  const probeGl = getGl(probe);
  if (!probeGl) return null;
  try {
    buildPrograms(probeGl);
  } catch (err) {
    console.warn("[wheel] WebGL shaders unavailable, using CPU renderer:", err);
    return null;
  } finally {
    probeGl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  const gl = getGl(canvas);
  if (!gl) return null;
  try {
    return new GlSurface(canvas, gl, size);
  } catch (err) {
    console.warn("[wheel] WebGL surface failed, using CPU renderer:", err);
    return null;
  }
}
