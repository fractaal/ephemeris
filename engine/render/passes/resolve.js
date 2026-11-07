// The sub-frame into the frame: each pixel's layer fragments (passes/layers.js), sorted by depth, over what is opaque
// there ('color': meshes, the backdrop, glass, as light), added into the frame with the sub-frame's weight.
//
// A fragment is one of two kinds. Light (a lit layer, a layer brighter than authored, an effect) adds its light over the
// light behind it. Authored (a captured layer as it was drawn: graphics, display-referred) must come out exactly as
// authored over whatever is behind it, blending as browsers blend: in sRGB, premultiplied, over the frame as seen. So
// the frame keeps the two apart until the view transform (post.js): the light ('light': rgb the light × the share of it
// no authored layer covers, w that share) and the authored layers over it ('authored': premultiplied sRGB), which the
// view puts over the light once it is seen, A + srgb(curve(light)) × share — a browser's source-over of the authored
// stack onto the light as the display shows it.
//
// Walking a pixel's fragments far to near: authored fragments blend among themselves as browsers do (D = c + D (1 − a))
// and cover the light behind them by their alpha (T ×= 1 − a: the stack covers 1 − T of the pixel); light fragments add
// over the light behind them (H = c + H (1 − a)), which shows where the authored stack does not. A light fragment in
// front of an authored one lights the stack's part of the pixel too: there it is folded into the stack, blending as
// light blends — the stack made linear (display-linear: its sRGB undone) is covered by the fragment's alpha and the
// fragment's light added as the display shows it (through the frame's exposure and tone curve: what it shows over
// black), then made sRGB again, at the stack's coverage. So over a card a glow shows as light over the card (its faint
// tail stays faint: added in sRGB, as browsers add, it would be a bright smear, sRGB rising steeply from black), and where
// a card's coverage fades out (its CSS shadow's edge) the glow fades from the one to the other without a seam. What its
// share over the stack loses is the bloom and vignette the frame's light gets (they work on the light alone).
import { FULLSCREEN_VS, COMMON } from '../shaders.js';
import { viewIndex } from '../scene.js';

/**
 * Each pixel's fragments (WGSL; group 1, bindings 0 and 1, read): its list (heads: its newest fragment + 1, 0 for none)
 * and the fragments, which hold their premultiplied colour (as 16-bit floats: light, or authored sRGB), view depth (0 on
 * the screen: in front of everything), scene order (its top bit: authored) and the next of their pixel's list. sorted()
 * keeps a pixel's nearest MAXF between two depths, far to near, in fz, fo, fc.
 */
export const FRAGMENTS = /* wgsl */`
struct Frag { rg: u32, ba: u32, z: f32, order: u32, next: u32 };
const AUTHORED = 0x80000000u;`;
export const SORTED = FRAGMENTS + /* wgsl */`
@group(1) @binding(0) var<storage, read> heads: array<u32>;
@group(1) @binding(1) var<storage, read> frags: array<Frag>;
// (a sorting array is held for every pixel, so its size is what sorting costs; films reach 8 at most)
const MAXF = 16u;
var<private> fz: array<f32, MAXF>;
var<private> fo: array<u32, MAXF>;
var<private> fc: array<vec4f, MAXF>;
// whether fragment a is in front of fragment b: by depth; on a shared plane (within a hair's breadth), the later in the scene
fn before(za: f32, oa: u32, zb: f32, ob: u32) -> bool {
  if (abs(za - zb) > 0.01 + 1e-5 * max(za, zb)) { return za < zb; }
  return (oa & ~AUTHORED) > (ob & ~AUTHORED);
}
fn firstFrag(px: vec2i) -> u32 { return heads[u32(px.y) * u32(cam.drawn.x) + u32(px.x)]; }
// a pixel's fragments farther than near and nearer than far (view depth), its nearest MAXF kept, far to near; how many
fn sorted(px: vec2i, near: f32, far: f32) -> u32 {
  var i = firstFrag(px);
  var n = 0u;
  loop {
    if (i == 0u) { break; }
    let f = frags[i - 1u];
    i = f.next;
    if (f.z <= near + 0.01 || f.z > far + 0.01) { continue; }
    var k = n;
    if (n == MAXF) {
      // full: the farthest goes, if this one is nearer
      if (!before(f.z, f.order, fz[0], fo[0])) { continue; }
      for (var j = 0u; j + 1u < MAXF; j++) { fz[j] = fz[j + 1u]; fo[j] = fo[j + 1u]; fc[j] = fc[j + 1u]; }
      k = MAXF - 1u;
    } else { n++; }
    loop {
      if (k == 0u || !before(fz[k - 1u], fo[k - 1u], f.z, f.order)) { break; }
      fz[k] = fz[k - 1u]; fo[k] = fo[k - 1u]; fc[k] = fc[k - 1u];
      k--;
    }
    fz[k] = f.z; fo[k] = f.order; fc[k] = vec4f(unpack2x16float(f.rg), unpack2x16float(f.ba));
  }
  return n;
}
// how far what is opaque at a pixel is (view depth; past everything where nothing is)
fn opaqueZ(P: vec4f) -> f32 { return select(1e30, viewZ(P.xyz), P.w > 0.5); }`;

export const resolve = {
  name: 'resolve', stage: 'sub', reads: ['color', 'position', 'fragments'], writes: ['light', 'authored'],
  setup(R) {
    const mod = R.module(FULLSCREEN_VS + COMMON + SORTED + /* wgsl */`
@group(1) @binding(2) var colorT: texture_2d<f32>;
@group(1) @binding(3) var posT: texture_2d<f32>;
// the sub-frame's weight; the frame's view transform (its exposure and curve), for light over authored layers
struct Resolve { weight: f32, exposure: f32, transform: f32, _r: f32 };
@group(1) @binding(4) var<uniform> r: Resolve;
// light fragment c (premultiplied, alpha a) over the authored stack D (premultiplied sRGB, covering A > 0), as light blends
fn fold(c: vec3f, a: f32, D: vec3f, A: f32) -> vec3f {
  return srgb(viewCurve(max(c, vec3f(0.0)) * r.exposure, r.transform) + lin(D / A) * (1.0 - a)) * A;
}
struct Out { @location(0) light: vec4f, @location(1) authored: vec4f };
@fragment fn fs(v: VO) -> Out {
  let px = vec2i(v.pos.xy);
  let w = r.weight;
  var H = textureLoad(colorT, px, 0).rgb;
  // (most pixels hold no layer at all)
  if (firstFrag(px) == 0u) { return Out(vec4f(H * w, w), vec4f(0.0)); }
  let n = sorted(px, -1.0, opaqueZ(textureLoad(posT, px, 0)));
  var D = vec3f(0.0);
  var T = 1.0;
  for (var j = 0u; j < n; j++) {
    let c = fc[j];
    if ((fo[j] & AUTHORED) != 0u) { D = c.rgb + D * (1.0 - c.a); T *= 1.0 - c.a; continue; }
    if (T < 1.0) { D = fold(c.rgb, c.a, D, 1.0 - T); }
    H = c.rgb + H * (1.0 - c.a);
  }
  return Out(vec4f(H * T * w, T * w), vec4f(D * w, (1.0 - T) * w));
}`, 'resolve');
    const add = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
    const T = (sampleType) => ({ visibility: GPUShaderStage.FRAGMENT, texture: { sampleType } }), S = { visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } };
    this.layout = R.dev.createBindGroupLayout({ entries: [S, S, T('unfilterable-float'), T('unfilterable-float'), { visibility: GPUShaderStage.FRAGMENT, buffer: {} }].map((e, binding) => ({ binding, ...e })) });
    this.pipe = R.pipeline('resolve', () => ({ layout: R.pipelineLayout([R.layouts.frame, this.layout]), vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: add }, { format: 'rgba16float', blend: add }] }, primitive: { topology: 'triangle-list' } }));
    this.buf = R.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  },
  async run(R, sub) {
    const F = R.fragments, key = `${R.tex.gen}:${F.gen}`, pipe = await this.pipe;
    if (this.key !== key) {
      this.key = key;
      this.bg = R.dev.createBindGroup({ layout: this.layout, entries: [{ resource: { buffer: F.heads } }, { resource: { buffer: F.list } }, { resource: R.view('color') }, { resource: R.view('position') },
        { resource: { buffer: this.buf } }].map((e, binding) => ({ binding, ...e })) });
    }
    // (the view transform the frame will have: the scene's, as the frame's view pass reads it; none in the quick looks)
    const v = sub.look === 'solid' || sub.look === 'wire' ? {} : sub.scene.view ?? {};
    R.dev.queue.writeBuffer(this.buf, 0, new Float32Array([sub.weight, v.exposure ?? 1, viewIndex(v), 0]));
    const at = (name) => (sub.first ? R.clear(name) : R.load(name));
    const p = R.enc.beginRenderPass({ label: 'resolve', colorAttachments: [at('light'), at('authored')] });
    p.setPipeline(pipe); p.setBindGroup(0, R.frameBG); p.setBindGroup(1, this.bg); p.draw(3); p.end();
  },
};
