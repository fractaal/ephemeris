// The frame's light into the frame as seen: the lens's glow (bloom), then the view transform (exposure, the vignette, a
// tone curve), the layers as authored over it, and the 8-bit frame with an invisible dither.
import { COMMON, FULLSCREEN_VS } from '../shaders.js';
import { viewIndex } from '../scene.js';

const LEVELS = 6;
// the frame's light at a pixel: what the sub-frames added up where no layer as authored covered it, over that share
const LIGHT_AT = /* wgsl */`
fn lightAt(t: texture_2d<f32>, px: vec2i) -> vec3f { let L = textureLoad(t, px, 0); return select(vec3f(0.0), L.rgb / L.w, L.w > 1e-5); }`;

/**
 * Bloom: the light the lens spreads around bright things, as much as they are bright (no threshold: the tone curve keeps
 * what is not bright from showing it). A chain of halvings (Jimenez 2014, "Next Generation Post Processing in Call of
 * Duty: Advanced Warfare": 13 taps down, the first weighted against fireflies by Karis's average; a 3 × 3 tent up, each
 * level added to the one below), mixed in by the view (post.bloom: how much, 0–1; a few hundredths is a lens's).
 */
export const bloom = {
  name: 'bloom', stage: 'frame', reads: ['light'], writes: ['glow'],
  setup(R) {
    const head = FULLSCREEN_VS + COMMON + LIGHT_AT + /* wgsl */`
@group(1) @binding(0) var src: texture_2d<f32>;
@group(1) @binding(1) var smp: sampler;`;
    const down = (first) => R.module(head + /* wgsl */`
fn at(uv: vec2f) -> vec3f { ${first ? 'return lightAt(src, vec2i(clamp(uv, vec2f(0.0), vec2f(0.9999)) * vec2f(textureDimensions(src))));' : 'return textureSampleLevel(src, smp, uv, 0.0).rgb;'} }
fn karis(c: vec3f) -> f32 { return ${first ? '1.0 / (1.0 + luma(c))' : '1.0'}; }
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  let A = at(v.uv + t * vec2f(-2.0, -2.0)); let B = at(v.uv + t * vec2f(0.0, -2.0)); let C = at(v.uv + t * vec2f(2.0, -2.0));
  let D = at(v.uv + t * vec2f(-1.0, -1.0)); let E = at(v.uv + t * vec2f(1.0, -1.0));
  let F = at(v.uv + t * vec2f(-2.0, 0.0)); let G = at(v.uv); let H = at(v.uv + t * vec2f(2.0, 0.0));
  let I = at(v.uv + t * vec2f(-1.0, 1.0)); let J = at(v.uv + t * vec2f(1.0, 1.0));
  let K = at(v.uv + t * vec2f(-2.0, 2.0)); let L = at(v.uv + t * vec2f(0.0, 2.0)); let M = at(v.uv + t * vec2f(2.0, 2.0));
  // five boxes, the middle one weighted most (0.5, and 0.125 each for the four corners'), each by Karis's weight
  let q0 = (D + E + I + J) * 0.25; let q1 = (A + B + F + G) * 0.25; let q2 = (B + C + G + H) * 0.25; let q3 = (F + G + K + L) * 0.25; let q4 = (G + H + L + M) * 0.25;
  let w0 = 0.5 * karis(q0); let w1 = 0.125 * karis(q1); let w2 = 0.125 * karis(q2); let w3 = 0.125 * karis(q3); let w4 = 0.125 * karis(q4);
  return vec4f((q0 * w0 + q1 * w1 + q2 * w2 + q3 * w3 + q4 * w4) / (w0 + w1 + w2 + w3 + w4), 1.0);
}`, 'bloom down');
    const up = R.module(head + /* wgsl */`
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var c = textureSampleLevel(src, smp, v.uv, 0.0).rgb * 4.0;
  c += (textureSampleLevel(src, smp, v.uv + vec2f(-t.x, 0.0), 0.0).rgb + textureSampleLevel(src, smp, v.uv + vec2f(t.x, 0.0), 0.0).rgb
      + textureSampleLevel(src, smp, v.uv + vec2f(0.0, -t.y), 0.0).rgb + textureSampleLevel(src, smp, v.uv + vec2f(0.0, t.y), 0.0).rgb) * 2.0;
  c += textureSampleLevel(src, smp, v.uv - t, 0.0).rgb + textureSampleLevel(src, smp, v.uv + t, 0.0).rgb
     + textureSampleLevel(src, smp, v.uv + vec2f(t.x, -t.y), 0.0).rgb + textureSampleLevel(src, smp, v.uv + vec2f(-t.x, t.y), 0.0).rgb;
  return vec4f(c / 16.0, 1.0);
}`, 'bloom up');
    this.layout = R.dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
    this.firstLayout = R.dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
    const pipe = (key, mod, layout, blend) => R.pipeline(key, () => ({ layout: R.pipelineLayout([R.layouts.frame, layout]), vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba16float', ...(blend && { blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }) }] },
      primitive: { topology: 'triangle-list' } }));
    this.pipes = Promise.all([pipe('bloom down 0', down(true), this.firstLayout), pipe('bloom down', down(false), this.layout), pipe('bloom up', up, this.layout, true), pipe('bloom last', up, this.layout, false)]);
  },
  async run(R, frame) {
    const k = frame.post.bloom ?? 0;
    if (!k) { R.enc.beginRenderPass({ colorAttachments: [R.clear('glow')] }).end(); return; }
    const [down0, down, up, last] = await this.pipes;
    if (this.gen !== R.tex.gen) {
      this.gen = R.tex.gen;
      this.chain?.destroy();
      this.chain = R.dev.createTexture({ size: [Math.max(1, R.pw >> 1), Math.max(1, R.ph >> 1)], format: 'rgba16float', mipLevelCount: LEVELS, label: 'bloom',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.levels = Array.from({ length: LEVELS }, (_, l) => this.chain.createView({ baseMipLevel: l, mipLevelCount: 1 }));
      const bg = (layout, view) => R.dev.createBindGroup({ layout, entries: [{ binding: 0, resource: view }, { binding: 1, resource: R.linear }] });
      this.bgs = { first: bg(this.firstLayout, R.view('light')), level: this.levels.map((v) => bg(this.layout, v)) };
    }
    const draw = (view, pipe, bg, load) => { const p = R.enc.beginRenderPass({ colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }); p.setPipeline(pipe); p.setBindGroup(0, R.frameBG); p.setBindGroup(1, bg); p.draw(3); p.end(); };
    draw(this.levels[0], down0, this.bgs.first);
    for (let l = 1; l < LEVELS; l++) draw(this.levels[l], down, this.bgs.level[l - 1]);
    for (let l = LEVELS - 2; l >= 0; l--) draw(this.levels[l], up, this.bgs.level[l + 1], true);
    draw(R.view('glow'), last, this.bgs.level[0]);
  },
};

/**
 * The view transform: the frame's light (with the lens's glow and vignette) at the exposure, through a tone curve
 * (viewCurve: TRANSFORMS in shaders.js), to the display (sRGB); then the layers as authored over it, as they were drawn
 * (scene.view: { transform, exposure }).
 */
export const view = {
  name: 'view', stage: 'frame', reads: ['light', 'glow', 'authored'], writes: ['display'],
  setup(R) {
    const mod = R.module(FULLSCREEN_VS + COMMON + LIGHT_AT + /* wgsl */`
@group(1) @binding(0) var lightT: texture_2d<f32>;
@group(1) @binding(1) var glowT: texture_2d<f32>;
@group(1) @binding(2) var authT: texture_2d<f32>;
struct View { exposure: f32, bloom: f32, vignette: f32, transform: f32 };
@group(1) @binding(3) var<uniform> o: View;
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let px = vec2i(v.pos.xy);
  let L = textureLoad(lightT, px, 0);
  var c = mix(lightAt(lightT, px), textureLoad(glowT, px, 0).rgb, o.bloom);
  let d = v.uv - vec2f(0.5);
  c *= mix(1.0, 1.0 - smoothstep(0.35, 0.95, length(d * vec2f(1.0, 0.9))), o.vignette) * o.exposure;
  let shown = viewCurve(c, o.transform);
  let A = textureLoad(authT, px, 0);
  return vec4f(A.rgb + srgb(shown) * clamp(L.w, 0.0, 1.0), 1.0);
}`, 'view');
    this.layout = R.dev.createBindGroupLayout({ entries: [0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }))
      .concat([{ binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: {} }]) });
    this.pipe = R.pipeline('view', () => ({ layout: R.pipelineLayout([R.layouts.frame, this.layout]), vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] }, primitive: { topology: 'triangle-list' } }));
    this.buf = R.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  },
  async run(R, frame) {
    const pipe = await this.pipe;
    if (this.gen !== R.tex.gen) {
      this.gen = R.tex.gen;
      this.bg = R.dev.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: R.view('light') }, { binding: 1, resource: R.view('glow') }, { binding: 2, resource: R.view('authored') }, { binding: 3, resource: { buffer: this.buf } }] });
    }
    const v = frame.view, t = viewIndex(v);
    R.dev.queue.writeBuffer(this.buf, 0, new Float32Array([v.exposure ?? 1, frame.post.bloom ?? 0, frame.post.vignette ?? 0, t]));
    const p = R.enc.beginRenderPass({ label: 'view', colorAttachments: [R.clear('display')] });
    p.setPipeline(pipe); p.setBindGroup(0, R.frameBG); p.setBindGroup(1, this.bg); p.draw(3); p.end();
  },
};

/** The 8-bit frame: a static triangular dither of about one step, which removes banding in dark gradients unseen. */
export const output = {
  name: 'output', stage: 'frame', reads: ['display'], writes: [],
  setup(R) {
    const mod = R.module(FULLSCREEN_VS + /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> frame: vec4f;   // (the frame's size, px)
fn h(p: vec2f) -> f32 { var q = fract(p * vec2f(0.1031, 0.1030)); q += dot(q, q.yx + 33.33); return fract((q.x + q.y) * q.x); }
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let c = textureLoad(src, vec2i(v.pos.xy), 0).rgb;
  // (seeded by the pixel's place in the frame, so a frame drawn smaller has the same dither, scaled)
  let px = floor(v.uv * frame.xy);
  return vec4f(clamp(c + (h(px) + h(px + vec2f(17.0, 59.0)) - 1.0) / 255.0, vec3f(0.0), vec3f(1.0)), 1.0);
}`, 'output');
    this.pipe = R.pipeline('output', () => ({ layout: 'auto', vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } }));
  },
  async run(R) {
    const pipe = await this.pipe;
    this.frame ??= R.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'the frame' });
    R.dev.queue.writeBuffer(this.frame, 0, new Float32Array([R.fw, R.fh, 0, 0]));
    if (this.gen !== R.tex.gen) { this.gen = R.tex.gen; this.bg = R.dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: R.view('display') }, { binding: 1, resource: { buffer: this.frame } }] }); }
    const p = R.enc.beginRenderPass({ label: 'output', colorAttachments: [{ view: R.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    p.setPipeline(pipe); p.setBindGroup(0, this.bg); p.draw(3); p.end();
  },
};
