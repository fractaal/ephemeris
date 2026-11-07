// Ambient occlusion: how open each mesh pixel is around it, from the surfaces the camera sees there (screen space):
// points in the hemisphere above it, a different set each sub-frame (the frame's sub-frames average them), tested
// against what is in front. It dims only the light around a surface (the environment's, or GI's), not the light of the
// scene's lights, which their shadows dim. On by default where there are meshes (scene.ao: { radius, strength }; false:
// off); with GI, off unless the scene asks (GI finds how open each point is itself).
import { COMMON, FULLSCREEN_VS } from '../shaders.js';

export const ao = {
  name: 'ao', stage: 'sub', reads: ['position', 'normal'], writes: ['ao'],
  setup(R) {
    const mod = R.module(FULLSCREEN_VS + COMMON + /* wgsl */`
@group(1) @binding(0) var posT: texture_2d<f32>;
@group(1) @binding(1) var nrmT: texture_2d<f32>;
@group(1) @binding(2) var<uniform> a: vec4f;   // radius (world px), strength
@fragment fn fs(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let px = vec2i(fp.xy);
  let P4 = textureLoad(posT, px, 0);
  if (P4.w < 0.5) { return vec4f(1.0); }
  let P = P4.xyz;
  let N = normalize(textureLoad(nrmT, px, 0).xyz);
  let T = normalize(select(cross(N, vec3f(0.0, 1.0, 0.0)), cross(N, vec3f(1.0, 0.0, 0.0)), abs(N.y) > 0.9));
  let B = cross(N, T);
  let ds0 = length(P - cam.eye);
  var occ = 0.0;
  for (var i = 0; i < 12; i++) {
    let r1 = hash3(vec3f(fp.xy, cam.seed * 13.0 + f32(i)));
    let r2 = hash3(vec3f(fp.yx + 7.0, cam.seed * 29.0 + f32(i) * 3.0));
    let r3 = hash3(vec3f(fp.xy + 19.0, cam.seed * 41.0 + f32(i) * 5.0));
    // a cosine-weighted direction, at a distance crowded toward the surface
    let ph = r1 * TAU;
    let dir = T * cos(ph) * sqrt(r2) + B * sin(ph) * sqrt(r2) + N * sqrt(1.0 - r2);
    let S = P + N * 0.5 + dir * a.x * mix(0.1, 1.0, r3 * r3);
    let c = project(S);
    if (c.w <= 0.0) { continue; }
    let uv = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5);
    if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { continue; }
    let Q4 = textureLoad(posT, vec2i(uv * cam.drawn), 0);
    if (Q4.w < 0.5) { continue; }
    let dq = length(Q4.xyz - cam.eye);
    // the visible surface there is in front of the sample point (and near enough to be what hides it)
    if (dq < length(S - cam.eye) - 1.0) { occ += smoothstep(0.0, 1.0, a.x / max(abs(ds0 - dq), 1e-3)); }
  }
  return vec4f(1.0 - a.y * occ / 12.0);
}`, 'ao');
    this.layout = R.dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} }, { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} }] });
    this.pipe = R.pipeline('ao', () => ({ layout: R.pipelineLayout([R.layouts.frame, this.layout]), vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'r16float' }] }, primitive: { topology: 'triangle-list' } }));
    this.buf = R.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  },
  async run(R, sub) {
    const o = sub.ao, pipe = o ? await this.pipe : null;
    const p = R.enc.beginRenderPass({ label: 'ao', colorAttachments: [{ view: R.view('ao'), loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] }] });
    if (o) {
      if (this.gen !== R.tex.gen) {
        this.gen = R.tex.gen;
        this.bg = R.dev.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: R.view('position') }, { binding: 1, resource: R.view('normal') }, { binding: 2, resource: { buffer: this.buf } }] });
      }
      R.dev.queue.writeBuffer(this.buf, 0, new Float32Array([o.radius ?? 40, o.strength ?? 0.75, 0, 0]));
      p.setPipeline(pipe); p.setBindGroup(0, R.frameBG); p.setBindGroup(1, this.bg); p.draw(3);
    }
    p.end();
  },
};
