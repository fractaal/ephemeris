// The timeline's lanes, drawn by the GPU (WebGL2) each time they change or move: boxes (the lanes, the grid, the clips
// and their outlines, notes, a song's beats, the objects' bars, striped where code places them), each sound's waveform with
// its fades, from its peaks (audio.js), and pictures along their clips. No picture of them is kept: a scroll, a pan, a zoom
// draws them again from these, onto a canvas the size of what shows. (A 2D canvas could not draw them all each frame, 15 ms
// on spring-brutalist's, so it kept them drawn as a picture twice the view's width and as tall as every lane, and the
// canvases over it as tall: about 150 MB of canvases there, with its 106 objects' rows in a window 3428 px wide, against
// 24 MB now and this canvas; and the picture drawn again whenever a scroll left it, 20 to 30 ms, which stalled for 0.3 to
// 2 s with the GPU near full.) Their text and the motion lanes' curves are the timeline's 2D canvas over this one.
//
// WebGL2, not WebGPU: the editor's window shows a WebGPU canvas at about 2.7 ms of the GPU process's main thread each frame
// it changes, however small (the thread its compositing and every canvas's drawing share), a WebGL2 or 2D canvas at under
// 1 ms (measured on Linux, a 3413 × 643 canvas cleared each frame: 3.9, 0.7 and 0.85 ms).
//
// What is drawn is recorded (record) as a 2D canvas would draw it, for a stretch of the timeline round the view: its
// fillRect, strokeRect, a rectangle's clip, globalAlpha, and in place of what the 2D canvas drew column by column or
// picture by picture, wave() and picture(); x in px from where the stretch starts (at the zoom recorded), y down the
// lanes. commit() hands it to the GPU, and draw() draws it where the view is now, in px from where the stretch starts.

const ZEBRA = 10;   // (how often the stripes repeat, px: objects.js)
const PEAKS_W = 4096;   // (the peaks texture's width, in bins)
const COMMON = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform vec2 u_off, u_size; uniform float u_dpr, u_pps, u_zx, u_hpx;
// where a pixel's middle is: px from the stretch's start, down the lanes
vec2 at(vec2 p) { return (p + 0.5) / u_dpr + u_off; }
// how much of device pixel p r covers (px from the stretch's start; down the lanes), as a 2D canvas antialiases a
// rectangle's edges
float cover(vec2 p, vec4 r) {
  vec2 lo = (r.xy - u_off) * u_dpr, hi = (r.zw - u_off) * u_dpr;
  vec2 c = clamp(min(p + 1.0, hi) - max(p, lo), vec2(0.0), vec2(1.0));
  return c.x * c.y;
}
vec4 rgba(uint c) { return vec4(float(c & 255u), float((c >> 8) & 255u), float((c >> 16) & 255u), float(c >> 24)) / 255.0; }
vec4 pm(vec4 c, float k) { return vec4(c.rgb * c.a * k, c.a * k); }   // (premultiplied, k of it)
vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }
`;
// (a fragment shader's: the device pixel this is, its top left, from the canvas's top left)
const PIX = `
vec2 pix() { return vec2(floor(gl_FragCoord.x), u_hpx - 1.0 - floor(gl_FragCoord.y)); }
`;
// a quad over r, a device pixel larger each side for its edges' coverage; z: its clip's depth (1: not a clip's; a later
// clip nearer), so that a clip covers those before it whatever is drawn first
const QUAD = `
const vec2 Q[6] = vec2[6](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(0, 1), vec2(1, 0), vec2(1, 1));
vec4 quad(vec4 r, float z) {
  vec2 lo = r.xy - u_off - vec2(1.0 / u_dpr), hi = r.zw - u_off + vec2(1.0 / u_dpr);
  vec2 css = mix(lo, hi, Q[gl_VertexID]);
  return vec4(css / u_size * vec2(2.0, -2.0) + vec2(-1.0, 1.0), z * 2.0 - 1.0, 1.0);
}
`;
const BOX_VS = `${COMMON}${QUAD}
in vec4 a_r; in uvec2 a_c; in vec2 a_kz;
flat out vec4 v_r; flat out uvec2 v_c; flat out float v_k;
void main() { gl_Position = quad(a_r, a_kz.y); v_r = a_r; v_c = a_c; v_k = a_kz.x; }`;
const BOX_FS = `${COMMON}${PIX}
flat in vec4 v_r; flat in uvec2 v_c; flat in float v_k;
out vec4 o;
void main() {
  vec2 p = pix();
  float k = cover(p, v_r);
  if (k <= 0.0) discard;
  vec4 c = rgba(v_c.x);
  if (v_k > 0.5) {
    // stripes: lines rising to the right every ${ZEBRA} px, held to the timeline's time (u_zx: the stretch's start from
    // time 0, px) and to the lanes' top
    vec2 g = at(p) + vec2(u_zx, 0.0);
    float s = mod(g.x + g.y, ${ZEBRA}.0), d = min(s, ${ZEBRA}.0 - s) * 0.70710678 * u_dpr, hw = ${ZEBRA}.0 / 2.0 * 0.70710678 * 1.4 / 2.0 * u_dpr;
    c = mix(c, rgba(v_c.y), clamp(hw - d + 0.5, 0.0, 1.0));
  }
  o = pm(c, k);
}`;
// a sound's waveform and its fades: each a row of the waves texture (13 texels: the clip's rectangle; mid, half, gain,
// depth; at, from, speed, sample rate; fade in a, b, fade out a, b (px); four ramps (t0, t1, curve, out); where its
// levels start in the peaks (bins); how many bins each has; its colour, its fades' colours)
const WAVE_VS = `${COMMON}${QUAD}
uniform sampler2D u_w;
flat out int v_i;
void main() { gl_Position = quad(texelFetch(u_w, ivec2(0, gl_InstanceID), 0), texelFetch(u_w, ivec2(1, gl_InstanceID), 0).w); v_i = gl_InstanceID; }`;
const WAVE_FS = `${COMMON}${PIX}
uniform sampler2D u_w, u_p;
flat in int v_i;
out vec4 o;
vec4 W(int k) { return texelFetch(u_w, ivec2(k, v_i), 0); }
vec2 peak(int i) { return texelFetch(u_p, ivec2(i % ${PEAKS_W}, i / ${PEAKS_W}), 0).rg; }
float rampAt(vec4 r, float t) {
  if (r.z < 0.0) return 1.0;
  bool out_ = r.w > 0.5;
  if (t <= r.x) return out_ ? 1.0 : 0.0;
  if (t >= r.y) return out_ ? 0.0 : 1.0;
  float x = (t - r.x) / (r.y - r.x);
  if (out_) x = 1.0 - x;
  if (r.z < 0.5) return sin(x * 1.5707963);   // (power)
  if (r.z < 1.5) return x;                      // (linear)
  return (1.0 - cos(x * 3.14159265)) / 2.0;     // (smooth)
}
void main() {
  vec4 r = W(0), m = W(1), s = W(2), f = W(3), lv = W(8), n = W(9);
  vec2 p = pix();
  float k = cover(p, r);
  if (k <= 0.0) discard;
  vec2 q = at(p);
  vec4 c = vec4(0.0);
  // its waveform: the column this pixel is in, the mid channel's lowest and highest there (the level of peaks with no more
  // than about 32 bins to a column), by the clip's gain and ramps, as timeline.js drew a column of it
  float col = floor(q.x);
  if (lv.w > 0.5 && col >= floor(r.x) && col < r.z) {
    float t = col / u_pps, sr = s.w, spp = sr / u_pps;
    float s0 = (s.y + (t - s.x) * s.z) * sr, s1 = s0 + spp * s.z;
    int l = spp >= 4096.0 ? 2 : spp >= 128.0 ? 1 : 0;
    float bin = l == 2 ? 4096.0 : l == 1 ? 128.0 : 16.0, base = l == 2 ? lv.z : l == 1 ? lv.y : lv.x, len = l == 2 ? n.z : l == 1 ? n.y : n.x;
    float k0 = max(floor(s0 / bin), 0.0), e = min(max(floor(s0 / bin) + 1.0, ceil(s1 / bin)), len);
    float lo = 0.0, hi = 0.0;
    for (float j = k0; j < e && j < k0 + 256.0; j += 1.0) { vec2 v = peak(int(base + j)); lo = min(lo, v.x); hi = max(hi, v.y); }
    float env = m.z;
    for (int i = 0; i < 4; i++) env *= rampAt(W(4 + i), t + 0.5 / u_pps);
    float yt = m.x - min(1.05, hi * env) * m.y, yb = m.x - max(-1.05, lo * env) * m.y;
    c = pm(W(10), cover(p, vec4(col, yt, col + 1.0, yt + max(1.0, yb - yt))));
  }
  // its fades: shaded above their curve (raised cosine), and the curve drawn
  float top = r.y, h = r.w - r.y;
  for (int i = 0; i < 2; i++) {
    float a = i == 1 ? f.z : f.x, b = i == 1 ? f.w : f.y;
    if (!(b > a) || q.x < a || q.x > b) continue;
    float u = (q.x - a) / (b - a), sgn = i == 1 ? -1.0 : 1.0;
    float v = (1.0 - sgn * cos(u * 3.14159265)) / 2.0, dv = sgn * 1.5707963 * sin(u * 3.14159265) / (b - a);
    float yc = top + h - v * (h - 1.0);
    c = over(vec4(0.0, 0.0, 0.0, 0.4 * clamp((yc - u_off.y) * u_dpr - p.y, 0.0, 1.0)), c);
    float d = abs(q.y - yc) / sqrt(1.0 + dv * dv * (h - 1.0) * (h - 1.0)) * u_dpr;
    c = over(pm(W(11 + i), clamp(u_dpr * 0.5 + 0.5 - d, 0.0, 1.0)), c);
  }
  o = c * k;
}`;
// a picture again and again along its clip from its start, a gap of 2 px between (u_tile: start, width, step, height)
const PIC_VS = `${COMMON}${QUAD}
uniform vec4 u_r; uniform float u_z;
void main() { gl_Position = quad(u_r, u_z); }`;
const PIC_FS = `${COMMON}${PIX}
uniform vec4 u_r, u_tile; uniform sampler2D u_t;
out vec4 o;
void main() {
  vec2 p = pix(), q = at(p);
  float k = cover(p, u_r), m = mod(q.x - u_tile.x, u_tile.z);
  if (k <= 0.0 || m > u_tile.y) discard;
  o = texture(u_t, vec2(m / u_tile.y, (q.y - u_r.y) / u_tile.w)) * k;
}`;

// colours as a 2D canvas takes them ('#rgb', '#rrggbb', '#rrggbbaa', 'rgb()', 'rgba()'), as [r, g, b, a] 0–1
const colours = new Map();
function colour(s) {
  let c = colours.get(s);
  if (c) return c;
  if (s[0] === '#') {
    const h = s.length <= 5 ? [...s.slice(1)].map((x) => x + x).join('') : s.slice(1);
    c = [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) / 255 : 1));
  } else {
    const n = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')).split(/[\s,/]+/).filter(Boolean).map(Number);
    c = [n[0] / 255, n[1] / 255, n[2] / 255, n[3] ?? 1];
  }
  colours.set(s, c);
  return c;
}
const pack = (s, alpha = 1) => {
  const [r, g, b, a] = colour(s), q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return (q(r) | (q(g) << 8) | (q(b) << 16) | (q(a * alpha) << 24)) >>> 0;
};
const CURVE = { power: 0, linear: 1, smooth: 2 };

/**
 * A recorder of the lanes, as a 2D canvas draws them (see above); its records go to the GPU at commit. layer: 'under' (the
 * default) or 'over': the boxes over the waveforms and pictures (the clips' outlines, a song's beats).
 */
function recorder() {
  const R = { under: [], over: [], waves: [], pics: [] };
  let st = { fill: '#000', stroke: '#000', lw: 1, alpha: 1, clip: null }, path = null;
  const stack = [];
  const box = (x0, y0, x1, y1, style, kind = 0) => {
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    const k = st.clip;
    if (k) { x0 = Math.max(x0, k[0]); y0 = Math.max(y0, k[1]); x1 = Math.min(x1, k[2]); y1 = Math.min(y1, k[3]); }
    if (!(x1 > x0 && y1 > y0)) return;
    const z = typeof style === 'object' && style?.zebra;
    R[g.layer].push(x0, y0, x1, y1, pack(z ? z[0] : style, st.alpha), z ? pack(z[1], st.alpha) : 0, z ? 1 : kind, g.z);
  };
  let clips = 0;
  const g = {
    layer: 'under', z: 1,
    /** What is recorded from now on is a clip's, over those before it (until g.z = 1 again). */
    clip0() { g.z = 1 - ++clips * 1e-5; },
    get fillStyle() { return st.fill; }, set fillStyle(v) { st.fill = v; },
    get strokeStyle() { return st.stroke; }, set strokeStyle(v) { st.stroke = v; },
    get lineWidth() { return st.lw; }, set lineWidth(v) { st.lw = v; },
    get globalAlpha() { return st.alpha; }, set globalAlpha(v) { st.alpha = v; },
    setTransform() {},
    save() { stack.push({ ...st }); },
    restore() { if (stack.length) st = stack.pop(); },
    beginPath() { path = null; },
    rect(x, y, w, h) { path = [Math.min(x, x + w), Math.min(y, y + h), Math.max(x, x + w), Math.max(y, y + h)]; },
    clip() { if (path) st.clip = st.clip ? [Math.max(st.clip[0], path[0]), Math.max(st.clip[1], path[1]), Math.min(st.clip[2], path[2]), Math.min(st.clip[3], path[3])] : path; },
    fillRect(x, y, w, h) { box(x, y, x + w, y + h, st.fill); },
    strokeRect(x, y, w, h) {
      const d = st.lw / 2, x1 = x + w, y1 = y + h;
      box(x - d, y - d, x1 + d, y + d, st.stroke); box(x - d, y1 - d, x1 + d, y1 + d, st.stroke);
      box(x - d, y + d, x + d, y1 - d, st.stroke); box(x1 - d, y + d, x1 + d, y1 - d, st.stroke);
    },
    /** Stripes, as a fill (objects.js): a with lines of b, held to the timeline's time. */
    zebra: (a, b) => ({ zebra: [a, b] }),
    /**
     * A sound's waveform over its clip (the rectangle clipped to now): peaks (audio.js; null: none yet, its fades alone),
     * mid and half (its middle and how far a full-scale peak reaches, px), at (where it starts, s, from the stretch's),
     * from (where in the sound, s), speed, sr, gain and ramps (model.js regions, their times from the stretch's start), its
     * colour; fades: [[a, b, colour], [a, b, colour]] (in, out: px; b <= a: none).
     */
    wave(w) {
      const k = st.clip;
      if (!k || !(k[2] > k[0] && k[3] > k[1])) return;
      R.waves.push({ ...w, r: k, alpha: st.alpha, z: g.z });
    },
    /** A picture along its clip (the rectangle clipped to now), from x every step px, w × h px from y. */
    picture(p) {
      const k = st.clip, r = [Math.max(k[0], p.x), Math.max(k[1], p.y), k[2], Math.min(k[3], p.y + p.h)];
      if (r[2] > r[0] && r[3] > r[1] && p.img?.complete && p.img.naturalWidth) R.pics.push({ ...p, r, z: g.z });
    },
  };
  g.records = R;
  return g;
}

/** The lanes' GPU drawing, on canvas (sized by its owner). onReady: called once it can draw (again, after the GPU lost it). */
export function createLanesGPU(canvas, onReady) {
  let G = null;   // { gl, box, wave, pic (programs: { p, u: uniforms }), vaos, bufs, textures } while it has a context
  const thumbs = new WeakMap();   // a picture's image → its texture (a small copy, as tall as it shows)
  let peaksOf = new Map(), peaksRows = 0;   // each sound's peaks → its first bin in the peaks texture (a row's start); rows used
  let rec = { under: 0, over: 0, waves: 0, pics: [] };

  function program(vs, fs) {
    const { gl } = G, p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`timeline lanes shader: ${gl.getShaderInfoLog(sh)}`);
      gl.attachShader(p, sh);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`timeline lanes program: ${gl.getProgramInfoLog(p)}`);
    const u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }
  // the boxes' instances: a buffer and how it reads (x0, y0, x1, y1; two colours; kind, depth: 32 bytes a box)
  function boxes() {
    const { gl } = G, vao = gl.createVertexArray(), buf = gl.createBuffer(), at = (n) => gl.getAttribLocation(G.box.p, n);
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(at('a_r')); gl.vertexAttribPointer(at('a_r'), 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(at('a_r'), 1);
    gl.enableVertexAttribArray(at('a_c')); gl.vertexAttribIPointer(at('a_c'), 2, gl.UNSIGNED_INT, 32, 16); gl.vertexAttribDivisor(at('a_c'), 1);
    gl.enableVertexAttribArray(at('a_kz')); gl.vertexAttribPointer(at('a_kz'), 2, gl.FLOAT, false, 32, 24); gl.vertexAttribDivisor(at('a_kz'), 1);
    gl.bindVertexArray(null);
    return { vao, buf };
  }
  const texture = (internal, format, type) => {
    const { gl } = G, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return { t, internal, format, type, w: 0, h: 0 };
  };
  function start() {
    const gl = canvas.getContext('webgl2', { alpha: false, depth: true, stencil: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl || gl.isContextLost()) return;
    G = { gl };
    try { Object.assign(G, { box: program(BOX_VS, BOX_FS), wave: program(WAVE_VS, WAVE_FS), pic: program(PIC_VS, PIC_FS) }); }
    catch (e) { console.warn(e.message); G = null; return; }
    G.under = boxes(); G.over = boxes();
    G.waves = texture(gl.RGBA32F, gl.RGBA, gl.FLOAT); G.peaks = texture(gl.RG16F, gl.RG, gl.HALF_FLOAT);
    // (each with room from the start: a texture with none is not drawn from)
    for (const [T, w, h] of [[G.waves, 13, 16], [G.peaks, PEAKS_W, 1]]) { gl.bindTexture(gl.TEXTURE_2D, T.t); T.w = w; T.h = h; gl.texImage2D(gl.TEXTURE_2D, 0, T.internal, w, h, 0, T.format, T.type, null); }
    G.empty = gl.createVertexArray();
    peaksOf = new Map(); peaksRows = 0;
    onReady?.();
  }
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); G = null; });
  canvas.addEventListener('webglcontextrestored', start);
  start();

  // each sound's peaks, in the peaks texture, each from a row's start: those of the sounds drawn now, the texture made again
  // (them alone) when one more does not fit
  function peaksFor(list) {
    const { gl } = G, rows = (p) => Math.ceil(p.data.length / 2 / PEAKS_W), fresh = [...new Set(list)].filter((p) => !peaksOf.has(p));
    if (!fresh.length) return;
    const T = G.peaks;
    gl.bindTexture(gl.TEXTURE_2D, T.t);
    let need = peaksRows + fresh.reduce((n, p) => n + rows(p), 0);
    if (need > T.h) {
      const all = [...new Set(list)];
      peaksOf = new Map(); peaksRows = 0; need = all.reduce((n, p) => n + rows(p), 0);
      T.w = PEAKS_W; T.h = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), Math.ceil(need * 1.5) + 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, T.internal, T.w, T.h, 0, T.format, T.type, null);
    }
    for (const p of new Set(list)) {
      if (peaksOf.has(p)) continue;
      const n = rows(p);
      if (peaksRows + n > T.h) break;   // (more sound than a texture holds: the rest without waveforms)
      const data = new Uint16Array(n * PEAKS_W * 2);   // (a Float16Array's bits, padded to whole rows)
      data.set(new Uint16Array(p.data.buffer, p.data.byteOffset, p.data.length));
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, peaksRows, PEAKS_W, n, T.format, T.type, data);
      peaksOf.set(p, peaksRows * PEAKS_W); peaksRows += n;
    }
  }
  function thumbOf(img, h) {
    let t = thumbs.get(img);
    const th = Math.max(1, Math.ceil(h)), tw = Math.max(1, Math.round((th * img.naturalWidth) / img.naturalHeight));
    if (t && t.h === th && t.G === G) return t.t;
    // (drawn small once, as it shows: the GPU samples it without the shimmer of a large picture shrunk)
    const c = new OffscreenCanvas(tw, th), x = c.getContext('2d'), { gl } = G;
    x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, tw, th);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    if (t?.G === G) gl.deleteTexture(t.t);
    thumbs.set(img, { t: tex, h: th, G });
    return tex;
  }

  return {
    record: recorder,
    /** What r recorded, drawn from now on (dpr: the canvas's pixels to a px, for the pictures' copies). */
    commit(r, dpr) {
      if (!G) return;
      const { gl } = G, R = r.records;
      for (const [name, list] of [['under', R.under], ['over', R.over]]) {
        const B = new ArrayBuffer(list.length * 4), f = new Float32Array(B), u = new Uint32Array(B);
        list.forEach((v, i) => { const j = i % 8; if (j === 4 || j === 5) u[i] = v; else f[i] = v; });
        gl.bindBuffer(gl.ARRAY_BUFFER, G[name].buf); gl.bufferData(gl.ARRAY_BUFFER, B, gl.DYNAMIC_DRAW);
      }
      peaksFor(R.waves.filter((w) => w.peaks).map((w) => w.peaks));
      const n = R.waves.length, W = new Float32Array(Math.max(1, n) * 13 * 4);
      R.waves.forEach((w, i) => {
        const o = i * 52, p = w.peaks, base = p ? peaksOf.get(p) : undefined, rgba = (s, a = 1) => { const c = colour(s); return [c[0], c[1], c[2], c[3] * a]; };
        W.set(w.r, o); W.set([w.mid, w.half, w.gain, w.z], o + 4); W.set([w.at, w.from, w.speed, w.sr], o + 8);
        W.set([w.fades[0][0], w.fades[0][1], w.fades[1][0], w.fades[1][1]], o + 12);
        for (let k = 0; k < 4; k++) { const q = w.ramps[k]; W.set(q ? [q.t0, q.t1, CURVE[q.curve], q.out ? 1 : 0] : [0, 0, -1, 0], o + 16 + k * 4); }
        W.set(base != null ? [base + p.at[0], base + p.at[1], base + p.at[2], 1] : [0, 0, 0, 0], o + 32);
        W.set(base != null ? [p.n[0], p.n[1], p.n[2], 0] : [0, 0, 0, 0], o + 36);
        W.set(rgba(w.colour, w.alpha), o + 40); W.set(rgba(w.fades[0][2]), o + 44); W.set(rgba(w.fades[1][2]), o + 48);
      });
      const T = G.waves;
      gl.bindTexture(gl.TEXTURE_2D, T.t);
      if (T.h < Math.max(1, n)) { T.w = 13; T.h = Math.max(16, Math.ceil(n * 1.5)); gl.texImage2D(gl.TEXTURE_2D, 0, T.internal, T.w, T.h, 0, T.format, T.type, null); }
      if (n) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 13, n, T.format, T.type, W);
      rec = { under: R.under.length / 8, over: R.over.length / 8, waves: n, pics: R.pics.map((p) => ({ ...p, t: thumbOf(p.img, p.h * dpr) })) };
    },
    /** The lanes drawn as the view is now: x, its start in px from the stretch's; y, how far down the lanes it is; w, h:
     *  its size (px); dpr: the canvas's pixels to a px; pps: the zoom; zx: the stretch's start in px from time 0. */
    draw({ x, y, w, h, dpr, pps, zx }) {
      if (!G || !canvas.width || !canvas.height) return;
      const { gl } = G, uni = (P) => {
        gl.useProgram(P.p);
        gl.uniform2f(P.u.u_off, x, y); gl.uniform2f(P.u.u_size, w, h); gl.uniform1f(P.u.u_dpr, dpr); gl.uniform1f(P.u.u_hpx, canvas.height);
        if (P.u.u_pps) gl.uniform1f(P.u.u_pps, pps);
        if (P.u.u_zx) gl.uniform1f(P.u.u_zx, ((zx % ZEBRA) + ZEBRA) % ZEBRA);
      };
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(15 / 255, 15 / 255, 15 / 255, 1); gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      if (rec.under) { uni(G.box); gl.bindVertexArray(G.under.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, rec.under); }
      gl.bindVertexArray(G.empty);
      if (rec.pics.length) {
        uni(G.pic); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(G.pic.u.u_t, 0);
        for (const p of rec.pics) { gl.bindTexture(gl.TEXTURE_2D, p.t); gl.uniform4f(G.pic.u.u_r, ...p.r); gl.uniform4f(G.pic.u.u_tile, p.x, p.w, p.step, p.h); gl.uniform1f(G.pic.u.u_z, p.z); gl.drawArrays(gl.TRIANGLES, 0, 6); }
      }
      if (rec.waves) {
        uni(G.wave);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, G.waves.t); gl.uniform1i(G.wave.u.u_w, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, G.peaks.t); gl.uniform1i(G.wave.u.u_p, 1);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, rec.waves);
        gl.activeTexture(gl.TEXTURE0);
      }
      if (rec.over) { uni(G.box); gl.bindVertexArray(G.over.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, rec.over); }
      gl.bindVertexArray(null);
    },
  };
}
