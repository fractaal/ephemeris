// A picture's mip levels, drawn on the GPU, each from the one before: as a 2 × 2 box (a picture's own levels, exact
// halvings: layers', the texture store's, a film's textures') or soft (a 4 × 4 bell from four bilinear reads: the
// blurred levels frost and films' passes read, smooth where a box's would show its texels).
const SHADERS = {
  box: /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let m = vec2i(textureDimensions(src)) - 1; let b = vec2i(p.xy) * 2;
  return 0.25 * (textureLoad(src, min(b, m), 0) + textureLoad(src, min(b + vec2i(1, 0), m), 0) + textureLoad(src, min(b + vec2i(0, 1), m), 0) + textureLoad(src, min(b + vec2i(1, 1), m), 0));
}`,
  soft: /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src)); let uv = p.xy / max(floor(vec2f(textureDimensions(src)) * 0.5), vec2f(1.0));   // (a level is the one before's size halved, rounded down)
  return 0.25 * (textureSampleLevel(src, s, uv + vec2f(-t.x, -t.y), 0.0) + textureSampleLevel(src, s, uv + vec2f(t.x, -t.y), 0.0)
               + textureSampleLevel(src, s, uv + vec2f(-t.x, t.y), 0.0) + textureSampleLevel(src, s, uv + vec2f(t.x, t.y), 0.0));
}`,
};
const VS = /* wgsl */`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); return vec4f(p * 2.0 - 1.0, 0.0, 1.0); }`;
const made = new WeakMap();   // device → its pipelines (by kind and format), sampler, and bind groups (by source view)
const cache = (dev) => { let m = made.get(dev); if (!m) made.set(dev, (m = { pipes: {}, bgs: new WeakMap(), linear: dev.createSampler({ magFilter: 'linear', minFilter: 'linear' }) })); return m; };
const desc = (dev, kind, format) => {
  const mod = dev.createShaderModule({ code: VS + SHADERS[kind], label: `${kind} levels` });
  return { layout: 'auto', vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } };
};
/** The levels' pipelines of these [kind, format] pairs made, away from the GPU process's main thread (Renderer.pipeline):
 *  drawLevels then has them. */
export function levelsReady(dev, pairs) {
  const m = cache(dev);
  return Promise.all(pairs.map(([kind, format]) => m.pipes[`${kind}:${format}`] ?? dev.createRenderPipelineAsync(desc(dev, kind, format)).then((p) => { m.pipes[`${kind}:${format}`] ??= p; })));
}

/**
 * Draws levels 1… of a picture into enc, each from the one before. views: its levels, one view each (level 0 drawn
 * already); format: theirs; soft: the bell, not the box.
 */
export function drawLevels(dev, enc, views, format, soft = false) {
  const m = cache(dev), kind = soft ? 'soft' : 'box';
  // (made now only for a kind and format levelsReady did not make ready: a film's picture of its own format)
  const pipe = (m.pipes[`${kind}:${format}`] ??= dev.createRenderPipeline(desc(dev, kind, format)));
  for (let l = 1; l < views.length; l++) {
    let bg = m.bgs.get(views[l - 1])?.[kind];
    if (!bg) {
      bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: views[l - 1] }, ...(soft ? [{ binding: 1, resource: m.linear }] : [])] });
      m.bgs.set(views[l - 1], { ...m.bgs.get(views[l - 1]), [kind]: bg });
    }
    const r = enc.beginRenderPass({ colorAttachments: [{ view: views[l], loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    r.setPipeline(pipe); r.setBindGroup(0, bg); r.draw(3); r.end();
  }
}
