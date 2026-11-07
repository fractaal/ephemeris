// Meshes as the camera sees them: their depth first, with where each pixel's mesh is and which way it faces (prepass:
// what occlusion and GI start from), then each pixel shaded once, for the mesh that shows there (opaque), over the
// backdrop where none does. Glass is drawn by its own pass.
import { COMMON } from '../shaders.js';
import { KEPT } from './denoise.js';
import { aroundGI, giReadLayout, giReadEntries } from './gi.js';

// a mesh's vertex (position, u, normal, v) and its copy (model columns with translation in w, normal matrix columns,
// colour with its node in w); what it gives each fragment: where it is, its normal, uv, its copy's colour and node, where
// in the mesh's own space, and which copy it is (its index among every mesh's copies, for useCopy: in its data, n0.w,
// as the copies drawn are the cull pass's, put together, rather than every copy in order)
export const VERTEX = /* wgsl */`
struct VI { @location(0) pos: vec3f, @location(1) u: f32, @location(2) nrm: vec3f, @location(3) v: f32,
  @location(4) c0: vec4f, @location(5) c1: vec4f, @location(6) c2: vec4f, @location(7) n0: vec4f, @location(8) n1: vec4f, @location(9) n2: vec4f, @location(10) col: vec4f };
struct MO { @invariant @builtin(position) pos: vec4f, @location(0) world: vec3f, @location(1) nrm: vec3f, @location(2) uv: vec2f,
  @location(3) @interpolate(flat) tint: vec4f, @location(4) local: vec3f, @location(5) @interpolate(flat) copy: u32 };
@vertex fn vs(v: VI) -> MO {
  var o: MO;
  o.world = v.c0.xyz * v.pos.x + v.c1.xyz * v.pos.y + v.c2.xyz * v.pos.z + vec3f(v.c0.w, v.c1.w, v.c2.w);
  o.nrm = v.n0.xyz * v.nrm.x + v.n1.xyz * v.nrm.y + v.n2.xyz * v.nrm.z;
  o.uv = vec2f(v.u, v.v);
  o.tint = v.col;
  o.local = v.pos;
  o.copy = u32(v.n0.w + 0.5);
  o.pos = project(o.world);
  return o;
}`;

export const prepass = {
  name: 'prepass', stage: 'sub', reads: [], writes: ['depth', 'position', 'normal'],
  setup(R) {
    const mod = R.module(COMMON + VERTEX + /* wgsl */`
struct GB { @location(0) pos: vec4f, @location(1) nrm: vec4f };
@fragment fn fs(v: MO) -> GB {
  let n = normalize(v.nrm);
  return GB(vec4f(v.world, 1.0), vec4f(select(n, -n, dot(n, cam.eye - v.world) < 0.0), 0.0));
}`, 'prepass');
    this.pipe = R.pipeline('prepass', () => ({ layout: R.pipelineLayout([R.layouts.frame]),
      vertex: { module: mod, entryPoint: 'vs', buffers: R.vertexLayout }, fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba32float' }, { format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } }));
  },
  async run(R, sub) {
    const pipe = await this.pipe;
    const p = R.enc.beginRenderPass({ label: 'prepass', colorAttachments: [R.clear('position'), R.clear('normal')],
      depthStencilAttachment: { view: R.view('depth'), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    if (sub.solids.length) { p.setPipeline(pipe); p.setBindGroup(0, R.frameBG); R.drawMeshes(p, sub.solids); }
    p.end();
  },
};

/**
 * Each pixel's mesh shaded (the scene's lights, its reflection traced, the light around it), over the backdrop; and,
 * where the denoiser filters its shadows or reflections (sub.keep), what it reads (the frame's 'kept': see denoise.js).
 * The lights' diffuse light's shadows come from the shadows pass where it found them this sub-frame ('shadow',
 * sub.shadowsFound: see shadows.js); without it (a film's render.passes leaving it out) this pass takes their rays itself.
 */
export const opaque = {
  name: 'opaque', stage: 'sub', reads: ['depth', 'ao', 'gi'], writes: ['color', 'position', 'normal', 'kept'],
  setup(R) {
    const bd = R.module(COMMON + /* wgsl */`
struct VO { @builtin(position) pos: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO { let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); return VO(vec4f(p * 2.0 - 1.0, 0.0, 1.0)); }
@fragment fn fs(v: VO) -> @location(0) vec4f { return vec4f(backdrop(viewDir(v.pos.xy / cam.scale)), 1.0); }`, 'backdrop');
    // (the backdrop where no mesh is: there the depth is still the cleared far plane; with what is kept, or without)
    const backdrop = (keep) => R.pipeline(`backdrop|${keep}`, () => ({ layout: R.pipelineLayout([R.layouts.frame]), vertex: { module: bd, entryPoint: 'vs' },
      fragment: { module: bd, entryPoint: 'fs', targets: [{ format: 'rgba16float' }, ...this.targets(keep).slice(1).map((t) => ({ ...t, writeMask: 0 }))] },
      primitive: { topology: 'triangle-list' }, depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' } }));
    this.backdrop = { false: backdrop(false), true: backdrop(true) };
    // (with GI, what it found where the reflections' rays meet something: its probes, bindings 3–5)
    const own = [0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: binding === 2 ? 'uint' : 'unfilterable-float' } }));
    this.layouts = { false: R.dev.createBindGroupLayout({ entries: own }), true: R.dev.createBindGroupLayout({ entries: [...own, ...giReadLayout(3, GPUShaderStage.FRAGMENT)] }) };
  },
  // what it draws into: colour, position, normal, and what it keeps for the denoiser (three layers of 'kept')
  targets(keep) { return [{ format: 'rgba16float' }, { format: 'rgba32float' }, { format: 'rgba16float' }, ...(keep ? [0, 1, 2].map(() => ({ format: 'rgba32uint' })) : [])]; },
  // (found: the shadows pass found the diffuse light's shadows this sub-frame, in 'shadow'; giOn: GI found its probes
  // this sub-frame, sub.giProbes, which light what its reflections meet)
  pipe(R, keep, found, giOn) { return R.pipeline(`opaque|${R.surfaceKey}|${keep}|${found}|${giOn}`, () => this.desc(R, keep, found, giOn)); },
  desc(R, keep, found, giOn) {
    const mod = R.module(R.prelude(giOn ? aroundGI(2, 3) : undefined) + VERTEX + (keep ? KEPT : '') + /* wgsl */`
@group(2) @binding(0) var aoT: texture_2d<f32>;
@group(2) @binding(1) var giT: texture_2d<f32>;
@group(2) @binding(2) var shadowT: texture_2d<u32>;
struct FO { @location(0) color: vec4f, @location(1) pos: vec4f, @location(2) nrm: vec4f${keep ? ', @location(3) k0: vec4u, @location(4) k1: vec4u, @location(5) k2: vec4u' : ''} };
fn opaqueOut(col: vec3f, P: vec3f, N: vec3f${keep ? ', K: Kept' : ''}) -> FO {
  ${keep ? 'let k = packKept(K); return FO(vec4f(col, 1.0), vec4f(P, 1.0), vec4f(N, 0.0), k[0], k[1], k[2]);' : 'return FO(vec4f(col, 1.0), vec4f(P, 1.0), vec4f(N, 0.0));'}
}
@fragment fn fs(v: MO) -> FO {
  let V = normalize(cam.eye - v.world);
  let n = normalize(v.nrm);
  // (how much the mirror direction turns across the pixel: its curvature; which way its uv runs across the surface,
  // found from how the surface and its uv change across the pixel: no tangents needed)
  let foot = length(fwidth(reflect(-V, select(n, -n, dot(n, V) < 0.0))));
  let uvf = uvFrame(dpdx(v.world), dpdy(v.world), dpdx(v.uv), dpdy(v.uv));
  let px = vec2i(v.pos.xy);
  let p = Point(v.world, v.local, n, v.uv, dpdx(v.uv), dpdy(v.uv), uvf[0], uvf[1], i32(v.tint.w + 0.5), v.tint.rgb, v.world / 300.0);
  let s = surfaceAt(p, V);
  if (s.own) { return opaqueOut(s.light, v.world, s.N${keep ? ', nothingKept()' : ''}); }
  let M = s.M;
  let rough = clamp(M.rough, 0.02, 1.0);
  let f0 = mix(iorF0(M.ior) * 2.0 * M.specLevel * dot(M.specTint, vec3f(0.333)), luma(s.base), M.metal);
  // (where the denoiser resolves reflections, one ray of a rough lobe, which its neighbours reuse)
  let reuse = ${keep} && world.tracing.reuse > 0.5;
  var lobes = array<Lobe, 2>(lobeOf(v.world, s.N, V, M.rough, f0, foot, v.pos.xy, reuse), noLobe());
  if (M.coat > 0.0) { lobes[1] = lobeOf(v.world, s.N, V, M.coatRough, iorF0(M.coatIor) * M.coat, foot, v.pos.xy, reuse); }
  // (their rays in one loop: see Lobe)
  for (var i = 0; i < 2; i++) {
    for (var k = 0; k < lobes[i].n; k++) {
      let R = lobeRay(lobes[i], k);
      lobes[i] = lobeGot(lobes[i], R, traceLight(lobes[i].X + lobes[i].N * 0.5, R, lobes[i].cone, lobes[i].w0, v.pos.xy, false));
    }
  }
  let refl = lobeDone(lobes[0]);
  let coat = lobeDone(lobes[1]);
  // the light around it: the environment's (or, with GI, what GI found), as open as occlusion says; and with GI, what
  // glows brighter than EMIT_BRIGHT, sampled from here (GI's rays leave it out), which occlusion does not dim: its rays
  // find what is in its way
  let g = textureLoad(giT, px, 0);
  let giOn = world.tracing.gi > 0.5;
  var ambient = select(irradiance(s.N), g.rgb, giOn && g.w > 0.5) * textureLoad(aoT, px, 0).r;
  if (giOn) { ambient += emitLight(v.world, s.N, v.pos.xy); }
  // (where the denoiser filters the lights' shadows, fewer rays: the frame's, a sub-frame's share, 1 to 4 of each kind;
  // the diffuse light's shadows, where the shadows pass found them, from there)
  let rays = keptRays();
  let W = weightsOf(M, s.base, s.N, V, p.at).w;
  let lit = gather(v.world, s.N, V, rough, clamp(M.coatRough, 0.02, 1.0), M.sheenRough, W, v.pos.xy, true, rays, ${found ? 'throughAt(textureLoad(shadowT, px, 0))' : 'notFound()'});
  let env = Terms(ambient, refl.light, coat.light, ambient * sheenAlbedo(clamp(dot(s.N, V), 1e-3, 1.0), M.sheenRough));
  let col = surfaceLight(s, V, lit.lit, env, p.at).col;
  ${keep ? `// what the denoiser reads: the shadowed lights' diffuse light (with sheen) as the surface shows it, as if nothing
  // were in the way (U) and as the rays found it (U_N, S_N), and the colour without it; the reflection's kept ray (the
  // coat's where it kept one, else the surface's own) and its weight in the colour. Only diffuse light's shadows are
  // filtered: their share through changes smoothly across a surface, as the filter assumes. A highlight's does not — on
  // a glossy floor each pixel's comes from a light of its own, hidden or not — so highlights keep this pixel's own ratio
  // (the frame's sub-frames average it)
  var K = nothingKept();
  K.raw = col;
  if (rays > 0) { K.raw = col - lit.U * shareThrough(lit.SN, lit.UN); K.U = lit.U; K.UN = lit.UN; K.SN = lit.SN; }
  var lobe = refl;
  var lw = W.spec;
  if (M.coat > 0.0 && coat.traced > 0.0) { lobe = coat; lw = W.coat; }
  let rw = lobe.traced * lw;
  if (dot(rw, vec3f(1.0)) > 0.0 && lobe.pdf > 0.0) { K.a = lobe.a; K.pdf = lobe.pdf; K.hit = lobe.hit; K.rw = rw; K.rl = lobe.L; }` : ''}
  return opaqueOut(col, v.world, s.N${keep ? ', K' : ''});
}`, keep ? 'opaque (kept)' : 'opaque');
    return { layout: R.pipelineLayout([R.layouts.frame, R.layouts.scene, this.layouts[giOn]]),
      vertex: { module: mod, entryPoint: 'vs', buffers: R.vertexLayout },
      fragment: { module: mod, entryPoint: 'fs', targets: this.targets(keep) },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' } };
  },
  // (what it will draw with: its variant as the shadows pass and GI, before it in the frame's passes, will leave it)
  want(R, sub) { if (sub.solids.length) this.pipe(R, !!sub.keep, !!(sub.shadowed && R.passes.some((p) => p.name === 'shadows')), !!(sub.gi && R.passes.some((p) => p.name === 'gi'))); },
  async run(R, sub) {
    const probes = sub.giProbes, giOn = !!probes;
    if (this.gen !== R.tex.gen || this.giIdx !== probes?.idx) {
      this.gen = R.tex.gen; this.giIdx = probes?.idx;
      this.bg = R.dev.createBindGroup({ layout: this.layouts[giOn], entries: [{ binding: 0, resource: R.view('ao') }, { binding: 1, resource: R.view('gi') }, { binding: 2, resource: R.view('shadow') },
        ...(giOn ? giReadEntries(probes, 3) : [])] });
    }
    const keep = !!sub.keep, [backdrop, pipe] = await Promise.all([this.backdrop[keep], sub.solids.length ? this.pipe(R, keep, !!sub.shadowsFound, giOn) : null]);
    const kept = keep ? [0, 1, 2].map((i) => R.tex.kept.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 })) : [];
    for (let b = 0; b < R.bands; b++) {
      const more = kept.map((view) => ({ view, loadOp: b ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }));
      const p = R.enc.beginRenderPass({ label: 'opaque', colorAttachments: [...(b ? [R.load('color'), R.load('position'), R.load('normal')] : [R.clear('color'), R.load('position'), R.load('normal')]), ...more],
        depthStencilAttachment: { view: R.view('depth'), depthReadOnly: true } });
      R.band(p, b);
      p.setPipeline(backdrop); p.setBindGroup(0, R.frameBG); p.draw(3);
      if (pipe) { p.setPipeline(pipe); p.setBindGroup(0, R.frameBG); p.setBindGroup(1, R.sceneBG); p.setBindGroup(2, this.bg); R.drawMeshes(p, sub.solids, b); }
      p.end();
      if (R.bands > 1) R.cut();
    }
  },
};
