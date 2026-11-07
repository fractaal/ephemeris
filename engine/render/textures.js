// The texture store: every picture a shader reads by handle (a model's base colour and normal map, a surface's own
// pictures, the layers' pictures as rays see them), in one place, read the same way by the camera and by rays. WebGPU
// binds no unbounded set of textures, so pictures are kept in texture arrays, one per size class (1024 to 4096 px
// square, each with its mip levels): a picture takes a slice of the smallest class that holds it, resampled to fill it.
// A handle says which (class, slice) and whether its texels are colours (sRGB, read as linear light) or numbers (a
// normal map: read as stored); texRead(handle, uv, ddx, ddy) and texReadLevel(handle, uv, lod) read it.
import { drawLevels } from './levels.js';

const CLASSES = [1024, 2048, 4096];
const LEVELS = (size) => Math.log2(size) + 1;
// handle = class × 8192 + slice × 2 + (1: numbers, not colours)
const handleOf = (cls, slice, numbers) => cls * 8192 + slice * 2 + (numbers ? 1 : 0);

const FULLSCREEN = /* wgsl */`
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO; o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(p.x, 1.0 - p.y); return o;
}`;
// a picture into level 0 of its slice, resampled (premul: a layer's, premultiplied sRGB, to premultiplied light)
const FILL = (premul) => FULLSCREEN + /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
fn lin(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let c = textureSampleLevel(src, smp, v.uv, max(log2(max(size.x, size.y) / OUT), 0.0));
  ${premul ? 'if (c.a <= 0.0) { return vec4f(0.0); } return vec4f(lin(c.rgb / c.a) * c.a, c.a);' : 'return c;'}
}`;
export class TextureStore {
  constructor(dev) {
    this.dev = dev;
    this.classes = CLASSES.map((size) => ({ size, tex: null, slices: 0, used: 0, free: [] }));
    this.handles = new WeakMap();   // picture → { handle, version }
    this.gen = 0;   // (changes when an array is made again: what binds them is made again)
    // (how many pictures have been copied in, and whether one taken is kept whatever its version now: a frame's sub-frame
    // drawn with its pictures as its sub-frames before it took them, after the film's code ran for another moment: see
    // drawSub in runtime.js)
    this.fills = 0;
    this.hold = false;
    this.sampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 16, addressModeU: 'repeat', addressModeV: 'repeat' });
    this.clamp = dev.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.pipes = {};
    for (const c of this.classes) this.grow(c, 1);
    // (the fills every picture takes, made now away from the GPU process's main thread: Renderer.pipeline)
    this.ready = Promise.all(this.classes.flatMap((c) => [['rgba8unorm-srgb', false], ['rgba8unorm-srgb', true], ['rgba8unorm', false]].map(([fmt, layer]) => {
      const key = `fill:${fmt}:${layer}:${c.size}`;
      return dev.createRenderPipelineAsync(this.fillDesc(fmt, FILL(layer).replace('OUT', `${c.size}.0`))).then((p) => { this.pipes[key] ??= p; });
    })));
  }
  fillDesc(fmt, code) {
    const mod = this.dev.createShaderModule({ code });
    return { layout: 'auto', vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets: [{ format: fmt }] }, primitive: { topology: 'triangle-list' } };
  }
  /**
   * The handle of a picture: a mip chain of ImageBitmaps (or one), a GPU texture view ({ view, width, height,
   * version }: a layer's), copied in the first time and again when its version changes. numbers: its texels are
   * numbers (a normal map), not colours; layer: a layer's picture (premultiplied sRGB), kept at 1024 px at most.
   */
  handle(pic, { numbers = false, layer = false } = {}) {
    const version = pic.version ?? 0;
    let e = this.handles.get(pic);
    if (e && (e.version === version || this.hold) && e.gen === this.gen) return e.handle;
    const w = pic.width ?? (Array.isArray(pic) ? pic[0].width : 0), h = pic.height ?? (Array.isArray(pic) ? pic[0].height : 0);
    if (!e) {
      const need = Math.max(w, h), cap = layer ? 1024 : 4096;
      const ci = Math.max(0, CLASSES.findIndex((s) => s >= Math.min(need, cap)));
      const c = this.classes[ci === -1 ? CLASSES.length - 1 : ci];
      const slice = c.free.pop() ?? c.used++;
      if (slice >= c.slices) this.grow(c, Math.max(c.slices * 2, slice + 1));
      e = { cls: this.classes.indexOf(c), slice, handle: handleOf(this.classes.indexOf(c), slice, numbers) };
      this.handles.set(pic, e);
    }
    this.fill(this.classes[e.cls], e.slice, pic, numbers, layer);
    e.version = version; e.gen = this.gen; this.fills++;
    return e.handle;
  }
  // a class's array made larger (its slices copied over)
  grow(c, n) {
    const dev = this.dev, old = c.tex;
    c.tex = dev.createTexture({ size: [c.size, c.size, n], format: 'rgba8unorm', viewFormats: ['rgba8unorm-srgb'], mipLevelCount: LEVELS(c.size), label: `pictures ${c.size}`,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    if (old) {
      const enc = dev.createCommandEncoder();
      for (let l = 0; l < LEVELS(c.size); l++) { const s = c.size >> l; enc.copyTextureToTexture({ texture: old, mipLevel: l }, { texture: c.tex, mipLevel: l }, [s, s, c.slices]); }
      dev.queue.submit([enc.finish()]);
      old.destroy();
    }
    c.slices = n;
    c.views = { colour: c.tex.createView({ dimension: '2d-array', format: 'rgba8unorm-srgb' }), numbers: c.tex.createView({ dimension: '2d-array' }) };
    this.gen++;
  }
  // a picture resampled into its slice's level 0, then its mip levels
  fill(c, slice, pic, numbers, layer) {
    const dev = this.dev, enc = dev.createCommandEncoder();
    let src = pic.view, tmp = null;
    if (!src) {
      const levels = Array.isArray(pic) ? pic : [pic];
      tmp = dev.createTexture({ size: [levels[0].width, levels[0].height], mipLevelCount: levels.length, format: numbers ? 'rgba8unorm' : 'rgba8unorm-srgb',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      levels.forEach((img, i) => dev.queue.copyExternalImageToTexture({ source: img }, { texture: tmp, mipLevel: i }, [img.width, img.height]));
      src = tmp.createView();
    }
    const fmt = numbers ? 'rgba8unorm' : 'rgba8unorm-srgb', level = (l) => c.tex.createView({ dimension: '2d', format: fmt, baseArrayLayer: slice, arrayLayerCount: 1, baseMipLevel: l, mipLevelCount: 1 });
    const pipe = (key, code) => (this.pipes[key] ??= dev.createRenderPipeline(this.fillDesc(fmt, code)));   // (made ready in the constructor, unless asked for first)
    const fillPipe = pipe(`fill:${fmt}:${layer}:${c.size}`, FILL(layer).replace('OUT', `${c.size}.0`));
    const draw = (view, p, entries) => {
      const r = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      r.setPipeline(p); r.setBindGroup(0, dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries })); r.draw(3); r.end();
    };
    draw(level(0), fillPipe, [{ binding: 0, resource: src }, { binding: 1, resource: this.clamp }]);
    drawLevels(dev, enc, Array.from({ length: LEVELS(c.size) }, (_, l) => level(l)), fmt);
    dev.queue.submit([enc.finish()]);
    tmp?.destroy();
  }
  /** The bind group entries the shaders' TEXTURES_WGSL reads, from `binding` on. */
  entries(binding) {
    return [...this.classes.flatMap((c, i) => [{ binding: binding + i * 2, resource: c.views.colour }, { binding: binding + i * 2 + 1, resource: c.views.numbers }]),
      { binding: binding + CLASSES.length * 2, resource: this.sampler }];
  }
  /** Their layout entries. */
  static layout(binding, visibility) {
    return [...CLASSES.flatMap((_, i) => [0, 1].map((k) => ({ binding: binding + i * 2 + k, visibility, texture: { viewDimension: '2d-array' } }))),
      { binding: binding + CLASSES.length * 2, visibility, sampler: {} }];
  }
}

/** The WGSL that reads a handle's picture (bindings from `b` in group `g`): with gradients (the camera's), or a level. */
export const TEXTURES_WGSL = (g, b) => /* wgsl */`
${CLASSES.map((_, i) => `@group(${g}) @binding(${b + i * 2}) var texC${i}: texture_2d_array<f32>;\n@group(${g}) @binding(${b + i * 2 + 1}) var texN${i}: texture_2d_array<f32>;`).join('\n')}
@group(${g}) @binding(${b + CLASSES.length * 2}) var texSmp: sampler;
fn texRead(h: f32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  let k = i32(h); let s = (k % 8192) / 2; let n = (k & 1) == 1;
  switch k / 8192 {
${CLASSES.map((_, i) => `    case ${i}: { if (n) { return textureSampleGrad(texN${i}, texSmp, uv, s, dx, dy); } return textureSampleGrad(texC${i}, texSmp, uv, s, dx, dy); }`).join('\n')}
    default: { return vec4f(1.0); }
  }
}
fn texReadLevel(h: f32, uv: vec2f, lod: f32) -> vec4f {
  let k = i32(h); let s = (k % 8192) / 2; let n = (k & 1) == 1;
  switch k / 8192 {
${CLASSES.map((_, i) => `    case ${i}: { if (n) { return textureSampleLevel(texN${i}, texSmp, uv, s, lod); } return textureSampleLevel(texC${i}, texSmp, uv, s, lod); }`).join('\n')}
    default: { return vec4f(1.0); }
  }
}
// its size (px across)
fn texSize(h: f32) -> f32 { return f32(${CLASSES[0]} << u32(i32(h) / 8192)); }`;
