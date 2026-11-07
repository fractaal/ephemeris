// Layers as the camera sees them: every layer node's pixels (a captured picture, an effect) into its pixel's list of
// fragments, which the resolve sorts by depth and puts over what is opaque (passes/resolve.js). Nearly every layer is
// partly see-through (soft edges, CSS shadows, fades), so none is drawn into the frame directly: each pixel of it that
// shows becomes a fragment (order-independent transparency, as per-pixel linked lists), and layers that cross each
// other, or cross a mesh, meet exactly where they meet; layers that share a plane keep their scene order. What is opaque
// in front of a layer (a mesh: the depth so far) hides it there.
//
// A layer is one of two kinds, carried on its fragments:
//   authored  a captured layer as it was drawn (not lit, no brighter than authored: bright <= 1): graphics,
//             display-referred, premultiplied sRGB as browsers keep it; it comes out exactly as authored, blending as
//             browsers blend (bright below 1 dims it as authored)
//   light     a lit layer (lit: true: its picture a matte surface's colour, lit by the scene's lights, their shadows
//             traced, and the environment); a layer brighter than authored (bright > 1: its colour as light,
//             linear × bright^2.2); an effect (a procedural plane: its colour as light)
// Screen-space layers (screen: true: titles) are in front of everything. A layer in the world is also a plane in the
// scene's tables (scene.js), so rays see it and it casts shadows through them.
import { COMMON } from '../shaders.js';
import { basis, project } from '../../camera.js';
import { axes } from '../scene.js';
import { FRAGMENTS } from './resolve.js';

const FRAG_BYTES = 20;   // (a Frag: resolve.js)
const SLOT = 256;   // (bytes between layers' params: the alignment a dynamic offset takes)
const FLOATS = 40;

// A layer node as its shaders see it (q: one draw's): its plane (centre, half axes; on the screen, in frame px), opacity,
// blur (CSS blur()'s spread as a share of its width and of its height), its size in the world (an effect's), the film's
// moment, its scene order, whether it is on the screen, light (not authored), lit, how bright (authored: × its sRGB
// colour; light: × its light) and whether its lit light's shadows are traced; an effect's params. Its vertices: the plane,
// grown to hold its blur (3.5 spreads each side).
const LAYER = FRAGMENTS + /* wgsl */`
struct Layer { center: vec3f, opacity: f32, axU: vec3f, blurU: f32, axV: vec3f, blurV: f32, size: vec2f, t: f32, order: f32,
  screen: f32, light: f32, lit: f32, bright: f32, shadows: f32, p0: vec4f, p1: vec4f, p2: vec4f, p3: vec4f };
@group(2) @binding(0) var<uniform> q: Layer;
@group(2) @binding(1) var<storage, read_write> heads: array<atomic<u32>>;
@group(2) @binding(2) var<storage, read_write> frags: array<Frag>;
@group(2) @binding(3) var smp: sampler;
struct LO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) world: vec3f };
@vertex fn vs(@builtin(vertex_index) k: u32) -> LO {
  let e = 3.5 * vec2f(q.blurU, q.blurV);
  let c = vec2f(f32(k & 1u), f32(k >> 1u)) * (1.0 + 2.0 * e) - e;
  let p = q.center + q.axU * (c.x * 2.0 - 1.0) + q.axV * (c.y * 2.0 - 1.0);
  var o: LO;
  o.uv = c;
  o.world = p;
  // (on the screen: p is in frame px, offset as the sub-frame is; in front of everything)
  if (q.screen > 0.5) { o.pos = vec4f((p.x + cam.jitter.x - cam.center.x) / cam.center.x, (cam.center.y - p.y - cam.jitter.y) / cam.center.y, 1.0, 1.0); return o; }
  o.pos = project(p);
  return o;
}
// a pixel of the layer (premultiplied: light, or authored sRGB) into its pixel's list: its view depth (0 on the screen),
// its scene order and kind; the list's count is the heads' last entry
fn keep(col: vec4f, world: vec3f, pos: vec4f) {
  if (max(max(col.r, col.g), max(col.b, col.a)) < 1.0 / 4096.0) { return; }
  let i = atomicAdd(&heads[arrayLength(&heads) - 1u], 1u);
  if (i >= arrayLength(&frags)) { return; }
  let p = vec2u(pos.xy);
  let c = clamp(col, vec4f(0.0), vec4f(6e4));   // (as 16-bit floats hold it)
  let z = select(viewZ(world), 0.0, q.screen > 0.5);
  let order = u32(q.order) | select(AUTHORED, 0u, q.light > 0.5);
  frags[i] = Frag(pack2x16float(c.rg), pack2x16float(c.ba), z, order, atomicExchange(&heads[p.y * u32(cam.drawn.x) + p.x], i + 1u));
}`;

// A layer's picture at uv, blurred as CSS blur() blurs it (a bell whose spread is q.blurU of its width; 0: sharp, read
// trilinearly with anisotropy). Blurred, it is read from the mip level whose texels match the blur through a cubic
// B-spline over them (Sigg and Hadwiger 2005): a box-filtered pyramid read so spreads as a bell does, its variance at level
// L (5·4^L − 1) / 12 texels², smooth at any blur, where a plain read of a coarse level shows its texels as blocks. Between
// two levels, each is weighed so the variance is the blur's. A level's texel covers 2^L of level 0's exactly (the
// picture's levels: index.js buildMips), so it is read where it covers, not stretched over the layer. A blur wider than
// the top level holds (the chain stops a few texels across) is a bell over all of its texels instead. Past the layer's
// edges it is clear, so a blur spreads beyond them (the plane grows).
const PICTURE = /* wgsl */`
@group(3) @binding(0) var tex: texture_2d<f32>;
fn layerTexel(p: vec2i, size: vec2i, L: i32) -> vec4f {
  if (any(p < vec2i(0)) || any(p >= size)) { return vec4f(0.0); }
  return textureLoad(tex, p, L);
}
fn layerSpline(uv: vec2f, L: i32) -> vec4f {
  let size = vec2i(textureDimensions(tex, L));
  let x = uv * vec2f(textureDimensions(tex)) / exp2(f32(L)) - 0.5;
  let i = vec2i(floor(x));
  let f = x - floor(x);
  let g = 1.0 - f;
  let w0 = g * g * g / 6.0;
  let w1 = (3.0 * f * f * f - 6.0 * f * f + 4.0) / 6.0;
  let w2 = (-3.0 * f * f * f + 3.0 * f * f + 3.0 * f + 1.0) / 6.0;
  let w3 = f * f * f / 6.0;
  let wx = array<f32, 4>(w0.x, w1.x, w2.x, w3.x);
  let wy = array<f32, 4>(w0.y, w1.y, w2.y, w3.y);
  var c = vec4f(0.0);
  for (var b = 0; b < 4; b++) {
    var row = vec4f(0.0);
    for (var a = 0; a < 4; a++) { row += layerTexel(i + vec2i(a - 1, b - 1), size, L) * wx[a]; }
    c += row * wy[b];
  }
  return c;
}
// a bell of sd (level 0's texels) over every texel of level L, each a box of 2^L × 2^L of level 0's (its own spread
// counted in)
fn layerWide(uv: vec2f, sd: f32, L: i32) -> vec4f {
  let size = vec2i(textureDimensions(tex, L));
  let s = exp2(f32(L));
  let at = uv * vec2f(textureDimensions(tex));
  let v = max(sd * sd - (s * s - 1.0) / 12.0, 1e-4);
  var c = vec4f(0.0);
  for (var y = 0; y < size.y; y++) {
    let dy = (f32(y) + 0.5) * s - at.y;
    var row = vec4f(0.0);
    for (var x = 0; x < size.x; x++) {
      let dx = (f32(x) + 0.5) * s - at.x;
      row += textureLoad(tex, vec2i(x, y), L) * exp(-dx * dx / (2.0 * v));
    }
    c += row * exp(-dy * dy / (2.0 * v));
  }
  return c * s * s / (TAU * v);
}
fn layerColor(uv: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(tex));
  let fp = uv * size;
  // (the level the screen asks for, as a trilinear read takes it: a blurred layer far away is no sharper than a sharp one)
  let screen = log2(max(max(length(dpdx(fp)), length(dpdy(fp))), 1e-6));
  if (q.blurU <= 0.0) { return textureSample(tex, smp, uv); }
  let sd = q.blurU * size.x;   // (in texels of level 0)
  let top = f32(textureNumLevels(tex)) - 1.0;
  let want = max(0.5 * log2((12.0 * sd * sd + 1.0) / 5.0), screen);
  if (want > top) { return layerWide(uv, max(sd, sqrt((5.0 * exp2(2.0 * want) - 1.0) / 12.0)), i32(top)); }
  let lod = max(want, 0.0);
  let l = floor(lod);
  var c = layerSpline(uv, i32(l));
  if (lod > l) {
    let v0 = (5.0 * exp2(2.0 * l) - 1.0) / 12.0;
    let v1 = (5.0 * exp2(2.0 * l + 2.0) - 1.0) / 12.0;
    let v = (5.0 * exp2(2.0 * lod) - 1.0) / 12.0;
    c = mix(c, layerSpline(uv, i32(l) + 1), clamp((v - v0) / (v1 - v0), 0.0, 1.0));
  }
  // (less than level 0's own spread, √(1/3): towards the picture as it is)
  let least = 0.57735;
  if (sd < least && screen < 0.0) { c = mix(textureSampleLevel(tex, smp, uv, 0.0), c, sd / least); }
  return c;
}`;

// a captured layer: authored as it is (dimmed by bright), or its colour as light, lit as a matte surface where it is lit
const CAPTURED = /* wgsl */`
@fragment fn fs(v: LO) {
  let c = layerColor(v.uv) * q.opacity;
  if (q.light < 0.5) { keep(vec4f(c.rgb * q.bright, c.a), v.world, v.pos); return; }
  var L = select(vec3f(0.0), lin(c.rgb / c.a) * c.a, c.a > 0.0) * q.bright;
  if (q.lit > 0.5 && c.a > 1e-4) { L *= matteLight(v.world, normalize(cross(q.axU, q.axV)), normalize(cam.eye - v.world), v.pos.xy, q.shadows > 0.5, 0, vec4f(0.0)); }
  keep(vec4f(L, c.a), v.world, v.pos);
}`;
// an effect: the film's WGSL fn effect(uv: vec2f, size: vec2f, t: f32) -> vec4f (premultiplied sRGB; uv spans the
// plane, size is its world size, t the film's moment, q.p0..q.p3 its params), each screen pixel: sharp at any zoom; its
// colour as light
const EFFECT = /* wgsl */`
@fragment fn fs(v: LO) {
  let c = effect(v.uv, q.size, q.t);
  keep(vec4f(select(c.rgb, lin(c.rgb / c.a) * c.a, c.a > 0.0), c.a) * q.opacity, v.world, v.pos);
}`;

export const layers = {
  name: 'layers', stage: 'sub', reads: ['depth'], writes: ['fragments'],
  setup(R) {
    const dev = R.dev, F = GPUShaderStage.FRAGMENT, VF = GPUShaderStage.VERTEX | F;
    this.keepLayout = dev.createBindGroupLayout({ entries: [{ visibility: VF, buffer: { type: 'uniform', hasDynamicOffset: true } }, { visibility: F, buffer: { type: 'storage' } },
      { visibility: F, buffer: { type: 'storage' } }, { visibility: F, sampler: {} }].map((e, binding) => ({ binding, ...e })) });
    this.pictureLayout = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, texture: {} }] });
    this.sampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 16, addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.pictures = new WeakMap();   // a layer's picture → its bind group
    this.effects = new Map();   // an effect → its pipeline
    this.params = null;
    // each pixel's list (made at the frame's size) and the fragments (grown to what a sub-frame's layers can leave)
    R.fragments = { heads: null, list: dev.createBuffer({ size: 1024 * FRAG_BYTES, label: 'fragments', usage: GPUBufferUsage.STORAGE }), cap: 1024, gen: 0 };
  },
  pipeline(R, mod, groups) {
    return { layout: R.pipelineLayout(groups), vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets: [] },
      primitive: { topology: 'triangle-strip' }, depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' } };
  },
  capturedPipe(R) { return R.pipeline(`layers|${R.surfaceKey}`, () => this.pipeline(R, R.module(R.prelude() + LAYER + PICTURE + CAPTURED, 'layers'), [R.layouts.frame, R.layouts.scene, this.keepLayout, this.pictureLayout])); },
  // (an effect's, by the effect: made once, away from the GPU process's main thread as R.pipeline is)
  effectPipe(R, fx) {
    let p = this.effects.get(fx);
    if (!p) {
      R.asked++;
      this.effects.set(fx, (p = R.dev.createRenderPipelineAsync(this.pipeline(R, R.module(COMMON + LAYER + fx.code + EFFECT, `effect ${fx.label ?? ''}`), [R.layouts.frame, R.layouts.scene, this.keepLayout]))));
      p.catch(() => { if (this.effects.get(fx) === p) this.effects.delete(fx); });
    }
    return p;
  },
  want(R, sub) { if (sub.layers.some((n) => !n.fx)) this.capturedPipe(R); for (const n of sub.layers) if (n.fx) this.effectPipe(R, n.fx); },
  async run(R, sub) {
    const dev = R.dev, Fr = R.fragments, list = sub.layers;
    if (this.texGen !== R.tex.gen) {
      this.texGen = R.tex.gen;
      Fr.heads?.destroy();
      Fr.heads = dev.createBuffer({ size: (R.pw * R.ph + 1) * 4, label: 'fragment lists', usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      Fr.gen++;
    }
    R.enc.clearBuffer(Fr.heads);
    if (!list.length) return;
    // (what it draws with, made before anything of it is recorded)
    const fxs = [...new Set(list.filter((n) => n.fx).map((n) => n.fx))];
    const [captured, ...made] = await Promise.all([list.some((n) => !n.fx) ? this.capturedPipe(R) : null, ...fxs.map((fx) => this.effectPipe(R, fx))]);
    const fxPipe = new Map(fxs.map((fx, i) => [fx, made[i]]));
    this.grow(R, list, sub.scene.camera);
    // each layer's params, a slot apart
    const n = list.length, data = new Float32Array((n * SLOT) / 4);
    list.forEach((node, i) => data.set(paramsOf(node, i, sub.scene.t ?? 0), (i * SLOT) / 4));
    if (!this.params || this.params.size < data.byteLength) {
      this.params?.destroy();
      this.params = dev.createBuffer({ size: Math.max(16, n * 2) * SLOT, label: 'layers', usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    dev.queue.writeBuffer(this.params, 0, data);
    const key = `${Fr.gen}:${this.params.size}`;
    if (this.keepKey !== key) {
      this.keepKey = key;
      this.keepBG = dev.createBindGroup({ layout: this.keepLayout, entries: [{ resource: { buffer: this.params, size: FLOATS * 4 } }, { resource: { buffer: Fr.heads } },
        { resource: { buffer: Fr.list } }, { resource: this.sampler }].map((e, binding) => ({ binding, ...e })) });
    }
    const p = R.enc.beginRenderPass({ label: 'layers', colorAttachments: [], depthStencilAttachment: { view: R.view('depth'), depthReadOnly: true } });
    p.setBindGroup(0, R.frameBG); p.setBindGroup(1, R.sceneBG);
    list.forEach((node, i) => {
      if (node.fx) p.setPipeline(fxPipe.get(node.fx));
      else { p.setPipeline(captured); p.setBindGroup(3, this.picture(R, node.tex)); }
      p.setBindGroup(2, this.keepBG, [i * SLOT]);
      p.draw(4);
    });
    p.end();
  },
  picture(R, pic) {
    let bg = this.pictures.get(pic);
    if (!bg) this.pictures.set(pic, (bg = R.dev.createBindGroup({ layout: this.pictureLayout, entries: [{ binding: 0, resource: pic.view }] })));
    return bg;
  },
  // Room for every fragment a sub-frame's layers can leave: each node's box on the screen (the whole frame where it
  // reaches behind the eye), with a margin for the lens and the sub-frame's offset. The fragments grow (never shrink);
  // past the device's largest buffer, the farthest fragments of the fullest pixels are lost.
  grow(R, list, camera) {
    const B = basis(camera), Fr = R.fragments, W = R.fw, H = R.fh;
    let need = 1024;
    for (const n of list) {
      if (n.screen) { need += Math.min(W * H, (n.w + 16) * (n.h + 16)); continue; }
      const [U, V] = axes(n);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, whole = false;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = project([n.x + U[0] * a + V[0] * b, n.y + U[1] * a + V[1] * b, (n.z ?? 0) + U[2] * a + V[2] * b], B, [W / 2, H / 2]);
        if (p.depth < 1) { whole = true; break; }
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      need += whole ? W * H : Math.max(0, Math.min(x1 + 16, W) - Math.max(x0 - 16, 0)) * Math.max(0, Math.min(y1 + 16, H) - Math.max(y0 - 16, 0));
    }
    need = Math.ceil(need * R.rs * R.rs);   // (counted in frame px; the frame as drawn has rs² as many)
    if (need <= Fr.cap) return;
    const dev = R.dev, most = Math.floor(Math.min(dev.limits.maxStorageBufferBindingSize, dev.limits.maxBufferSize) / FRAG_BYTES);
    if (need > most && !this.warned) { this.warned = true; console.warn(`[render] a sub-frame's layers need ${need} fragments; the device holds ${most}`); }
    const cap = Math.min(most, Math.ceil(Math.max(need * 1.25, Fr.cap * 1.5, R.pw * R.ph * 2)));
    if (cap <= Fr.cap) return;
    Fr.list.destroy();
    Fr.list = dev.createBuffer({ size: cap * FRAG_BYTES, label: 'fragments', usage: GPUBufferUsage.STORAGE });
    Fr.cap = cap; Fr.gen++;
  },
};

// a layer node's params (Layer, above): i its scene order
function paramsOf(n, i, t) {
  const [U, V] = axes(n), d = new Float32Array(FLOATS), p = n.params ?? [];
  // blur: px of the layer as authored, as CSS blur() takes them (a bell's spread), as a share of its size
  const blur = n.tex ? Math.max(0, n.blur ?? 0) : 0, bw = n.layer?.worldW ?? n.w, bh = n.layer?.worldH ?? n.h;
  const lit = !!(n.tex && n.lit && !n.screen), bright = n.bright ?? 1, light = !!n.fx || lit || bright > 1;
  d.set([n.x, n.y, n.z ?? 0, n.opacity ?? 1, ...U, blur / bw, ...V, blur / bh, n.w, n.h, t, i,
    n.screen ? 1 : 0, light ? 1 : 0, lit ? 1 : 0, light ? bright ** 2.2 : bright, n.receive === false ? 0 : 1]);
  for (let k = 0; k < 16; k++) d[24 + k] = p[k] ?? 0;
  return d;
}
