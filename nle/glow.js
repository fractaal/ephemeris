// Claude's light: a glow along the edge of something in the studio, drawn by a WebGPU shader on one canvas over each
// window (the studio's own GPU, as the films are): every glow in a window in one pass, a quad round each. `spin` while
// Claude works (its composer): two heads of violet-blue light running round the edge over a faint rim, until stopped;
// `flash` where Claude looked or changed something: one sweep round it, fading; `pulse` where it shows you something, in
// time with its finger's pokes: three beats, each flaring the edge and sending a ring of light out from it. No WebGPU (a
// browser without it), no glow; nothing draws while nothing glows.
//   const g = glow(() => el.getBoundingClientRect(), { mode: 'spin', radius: 4 }); … g.stop();

const CAP = 16;   // the most that glow at once (a new one past it takes the place of the oldest flash or pulse)
const SHADER = /* wgsl */ `
struct G { center: vec2f, half: vec2f, radius: f32, time: f32, fade: f32, mode: f32, seed: f32, margin: f32, pad: vec2f }
struct U { size: vec2f, scale: f32, pad: f32, g: array<G, ${CAP}> }
@group(0) @binding(0) var<uniform> u: U;
struct V { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) i: u32 }

// a quad round glow i: its box and the bloom's room round it
@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> V {
  var corner = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let g = u.g[i];
  let p = g.center + corner[v] * (g.half + g.margin);
  var o: V;
  o.pos = vec4f(p.x / u.size.x * 2.0 - 1.0, 1.0 - p.y / u.size.y * 2.0, 0.0, 1.0);
  o.i = i;
  return o;
}

// signed distance to the box (rounded by r): below 0 inside
fn box(q: vec2f, h: vec2f, r: f32) -> f32 {
  let d = abs(q) - h + r;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - r;
}
// where round the edge the nearest point of it is (0 to 1, clockwise from the top left), by length along it
fn along(q: vec2f, h: vec2f) -> f32 {
  let b = clamp(q, -h, h);
  var s = 0.0;
  if (h.y - abs(b.y) <= h.x - abs(b.x)) {
    if (b.y < 0.0) { s = b.x + h.x; } else { s = 2.0 * h.x + 2.0 * h.y + (h.x - b.x); }
  } else {
    if (b.x > 0.0) { s = 2.0 * h.x + (b.y + h.y); } else { s = 4.0 * h.x + 2.0 * h.y + (h.y - b.y); }
  }
  return s / (4.0 * (h.x + h.y));
}
// a head of light at t: a long tail behind it, a short fall in front
fn head(a: f32, t: f32, tail: f32) -> f32 {
  let behind = fract(t - a);
  let front = fract(a - t);
  return max(exp(-behind * tail), exp(-front * 60.0));
}

@fragment fn fs(in: V) -> @location(0) vec4f {
  let g = u.g[in.i];
  let q = in.pos.xy - g.center;
  let s = u.scale;
  let d = box(q, g.half, g.radius * s);
  let a = along(q, g.half);
  var level = 0.0;
  var ring = 0.0;
  if (g.mode > 1.5) {
    // pulse: a beat every 0.6 s, three times: the rim flares, and a ring of light goes out 26 px, fading as it goes
    level = 0.2;
    for (var k = 0; k < 3; k++) {
      let ph = (g.time - f32(k) * 0.6) / 0.6;
      if (ph < 0.0) { continue; }
      level += 1.25 * exp(-ph * 4.0);
      let x = (d - ph * 26.0 * s) / (3.0 * s);
      ring += select(0.0, exp(-x * x) * (1.0 - smoothstep(0.0, 1.3, ph)), d > -s);
    }
    level *= 1.0 - smoothstep(1.9, 2.6, g.time);
  } else if (g.mode < 0.5) {
    // spin: two heads half a turn apart, once round every 3 s, over a faint rim
    let t = fract(g.time / 3.0 + g.seed);
    level = 0.16 + 0.9 * (head(a, t, 5.0) + head(a, t + 0.5, 5.0));
  } else {
    // flash: one head once round (0.9 s), the rim lit behind it, fading with g.fade
    let t = clamp(g.time / 0.9, 0.0, 1.0);
    level = 0.25 * smoothstep(0.0, 0.3, t) + 1.1 * head(a, t + g.seed, 3.0) * (1.0 - smoothstep(0.85, 1.0, t));
  }
  // a thin bright rim, a soft bloom outside it, a little light inside
  let k = d / (1.1 * s);
  let rim = exp(-k * k);
  let out = select(0.0, exp(-d / (7.0 * s)), d > 0.0);
  let inn = select(0.0, exp(d / (4.0 * s)) * 0.35, d <= 0.0);
  let lit = level * (rim + 0.5 * out + inn) + 0.9 * ring;
  // violet to the studio's blue round the edge, drifting; white at the brightest
  let violet = vec3f(0.62, 0.47, 1.0);
  let blue = vec3f(0.38, 0.66, 1.0);
  var c = mix(violet, blue, 0.5 + 0.5 * sin(6.2832 * (a * 2.0 + g.time * 0.15)));
  c = mix(c, vec3f(1.0), clamp(level - 0.9, 0.0, 0.5));
  let alpha = clamp(lit * g.fade, 0.0, 1.0);
  return vec4f(c * alpha, alpha);
}`;

const M = 18, M_PULSE = 46;   // the bloom's room round the box (css px; a pulse's rings go further)
const MODE = { spin: 0, flash: 1, pulse: 2 };
const still = matchMedia('(prefers-reduced-motion: reduce)');
// the GPU, set up once for every glow: { device, pipeline, format }, or false (no WebGPU)
let gpu = null, ready = null;
function setup() {
  return (ready ??= (async () => {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return (gpu = false);
      const device = await adapter.requestDevice(), format = navigator.gpu.getPreferredCanvasFormat();
      const module = device.createShaderModule({ code: SHADER });
      const blend = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' };   // (premultiplied: where glows overlap, one over the other)
      const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format, blend: { color: blend, alpha: blend } }] }, primitive: { topology: 'triangle-list' } });
      device.lost.then(() => {
        gpu = null; ready = null;
        for (const g of live) g.remove();
        for (const o of overlays.values()) o.canvas.remove();
        overlays.clear();
      });
      return (gpu = { device, pipeline, format });
    } catch { return (gpu = false); }
  })());
}

// each window's canvas, by its document: { canvas, ctx, buf, bind }, made when something first glows there
const overlays = new Map();
function overlay(doc) {
  let o = overlays.get(doc);
  if (o) return o;
  const canvas = doc.createElement('canvas');
  canvas.className = 'claude-glow';
  doc.body.append(canvas);
  const ctx = canvas.getContext('webgpu');
  ctx.configure({ device: gpu.device, format: gpu.format, alphaMode: 'premultiplied' });
  const buf = gpu.device.createBuffer({ size: (4 + CAP * 12) * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bind = gpu.device.createBindGroup({ layout: gpu.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
  overlays.set(doc, (o = { canvas, ctx, buf, bind, data: new Float32Array(4 + CAP * 12) }));
  return o;
}
// draws `list` (each glow's numbers, as G in the shader) on doc's canvas, or hides it when nothing glows there
function paint(doc, o, list) {
  if (!list.length || !doc.defaultView) { o.canvas.hidden = true; if (!doc.defaultView) { o.buf.destroy(); overlays.delete(doc); } return; }
  const win = doc.defaultView, dpr = win.devicePixelRatio || 1, W = Math.round(win.innerWidth * dpr), H = Math.round(win.innerHeight * dpr);
  if (o.canvas.width !== W || o.canvas.height !== H) { o.canvas.width = W; o.canvas.height = H; }
  o.data.set([W, H, dpr, 0]);
  list.forEach((p, k) => o.data.set(p, 4 + k * 12));
  gpu.device.queue.writeBuffer(o.buf, 0, o.data, 0, 4 + list.length * 12);
  const enc = gpu.device.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: o.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
  pass.setPipeline(gpu.pipeline); pass.setBindGroup(0, o.bind); pass.draw(6, list.length); pass.end();
  gpu.device.queue.submit([enc.finish()]);
  o.canvas.hidden = false;
}

const live = new Set();
let loop = 0;
function frame(now) {
  loop = 0;
  // where each glow is, read for all of them before anything is drawn (nothing on the page changes in between)
  const by = new Map();
  for (const g of live) {
    let p = null;
    try { p = g.at(now); } catch { g.remove(); }   // (what it glowed round is gone)
    if (p) { if (!by.has(p.doc)) by.set(p.doc, []); by.get(p.doc).push(p.numbers); }
  }
  for (const doc of by.keys()) overlay(doc);
  for (const [doc, o] of overlays) paint(doc, o, by.get(doc) ?? []);
  if (live.size) loop = requestAnimationFrame(frame);
}

/**
 * A glow round what `rect()` says (a DOMRect in the window, or null while it is not on screen), until `stop()`
 * (spin), or for about two seconds (flash), or three beats (pulse). radius: its corners' (css px); strength: how bright (0 to 1); el: what it
 * glows round, if it may move to a window of its own (the glow goes with it; else it is this window's).
 */
export function glow(rect, { mode = 'spin', radius = 4, strength = 1, el = null } = {}) {
  const seed = Math.random(), t0 = performance.now(), fadeIn = mode === 'spin' ? 350 : 120, fadeOut = mode === 'spin' ? 700 : 1100;
  let stopAt = null, gone = false;
  const g = {
    mode,
    /** Where it is and how it looks at `now`: { doc, numbers } (G in the shader), or null while it is not on screen. */
    at(now) {
      const end = mode === 'flash' ? t0 + 900 : mode === 'pulse' ? t0 + 1900 : stopAt;
      if (end != null && now - end > fadeOut) { g.remove(); return null; }
      const r = rect();
      if (!r || !r.width || !r.height) return null;
      let fade = strength * Math.min(1, (now - t0) / fadeIn);
      if (end != null) fade *= Math.max(0, 1 - (now - end) / fadeOut);
      const doc = el?.ownerDocument ?? document, dpr = doc.defaultView?.devicePixelRatio || 1;
      const time = still.matches ? (mode === 'spin' ? 0.4 : 0.9) : (now - t0) / 1000;
      const m = (mode === 'pulse' ? M_PULSE : M) * dpr;
      return { doc, numbers: [(r.left + r.width / 2) * dpr, (r.top + r.height / 2) * dpr, (r.width / 2) * dpr, (r.height / 2) * dpr, radius, time, fade, MODE[mode], seed, m, 0, 0] };
    },
    remove() { gone = true; live.delete(g); },
    /** Fades it out (a spin; a flash ends by itself). */
    stop() { if (stopAt == null) stopAt = performance.now(); },
  };
  setup().then((ok) => {
    if (!ok || gone) return;
    if (live.size >= CAP) ([...live].find((x) => x.mode !== 'spin') ?? live.values().next().value).remove();
    live.add(g);
    if (!loop) loop = requestAnimationFrame(frame);
  });
  return g;
}
