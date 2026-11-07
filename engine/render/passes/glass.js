// Glass, ray traced. The nearest glass surface at each pixel draws (glass's depth first), and the light's path is
// followed from there: into its solid (a box's or a sphere's exact form, in the copy's own space; glass that is neither
// is a pane its material's thickness), bending as it enters, bouncing inside where a face is too steep to leave by (total
// internal reflection: the thick, deep edges of a glass block), bending again as it leaves — then on through every other
// piece of glass it meets in the scene (traceScene: glass is a mesh whose material transmits), each bending it, tinting
// it by its colour and its path (longer paths, deeper colour) and frosting it, up to its bounces (pieces) — and finally to
// what it meets (or what it meets inside the solid first: a card passing through it). Glass behind glass is traced, not
// ordered, so it cannot flicker.
//
// What the light meets is found exactly, traced. A layer is a picture, the same from any side: where the camera sees that
// very spot of it (nothing solid between them; it is in the frame behind the glass there), it is read from that frame,
// as the camera sees it, every pixel of it. Where the camera cannot (off the screen, hidden behind something nearer, or
// in front of the glass there), it is traced through the scene instead, as engines trace what screen space cannot see.
// (The frame's depth alone finds a surface the light could reach, not the one it does: it went through nearer things,
// or stopped on things it passes beside, leaving holes.) A mesh is lit, and looks different from where the light leaving
// the glass meets it than from the camera (a glossy floor seen from above, not at the camera's glancing angle): it is
// always traced. Light that meets nothing reads the backdrop where the frame shows it.
//
// The frame behind the glass is what is opaque (meshes, the backdrop: light) with the layers behind the nearest glass
// resolved over it (passes/resolve.js's fragments), all as light: an authored layer seen through glass is its colour as
// light, as rays see it (scene.js's tables). Frost reads it through its blurred levels, so frost (roughness) melts things
// more the further back they are. Each colour leaves a little differently (dispersion). Its surface is the shared shading
// (surfaceAt, surfaceLight: the Principled BSDF with transmission): it reflects the scene by Fresnel (traced) and lets the
// rest through. It then is what is opaque there: its light in 'color', where it is in 'position' and 'depth'.
import { drawLevels } from '../levels.js';
import { COMMON, FULLSCREEN_VS } from '../shaders.js';
import { VERTEX } from './meshes.js';
import { SORTED } from './resolve.js';
import { aroundGI, giReadLayout, giReadEntries } from './gi.js';

const LEVELS = 8;   // (the frame behind glass's blurred levels)

// The frame behind the nearest glass: each pixel's layers behind its glass's surface (everywhere else, all of them) over
// what is opaque, as light; and that frame's view depth (× coverage, coverage: where a layer is more see-through than not,
// what is behind it shows through it)
const BEHIND = FULLSCREEN_VS + COMMON + SORTED + /* wgsl */`
@group(1) @binding(2) var colorT: texture_2d<f32>;
@group(1) @binding(3) var posT: texture_2d<f32>;
@group(1) @binding(4) var cutT: texture_depth_2d;   // the nearest glass's surface (reversed depth; 0 where there is none)
struct BO { @location(0) color: vec4f, @location(1) z: vec4f };
@fragment fn fs(v: VO) -> BO {
  let px = vec2i(v.pos.xy);
  let P = textureLoad(posT, px, 0);
  var z = select(vec2f(0.0), vec2f(viewZ(P.xyz), 1.0), P.w > 0.5);
  var H = textureLoad(colorT, px, 0).rgb;
  if (firstFrag(px) != 0u) {
    let c = textureLoad(cutT, px, 0);
    let n = sorted(px, select(-1.0, NEAR / c, c > 0.0), opaqueZ(P));
    for (var j = 0u; j < n; j++) {
      let f = fc[j];
      let L = select(f.rgb, select(vec3f(0.0), lin(f.rgb / f.a) * f.a, f.a > 0.0), (fo[j] & AUTHORED) != 0u);
      H = L + H * (1.0 - f.a);
      z = vec2f(fz[j], 1.0) * f.a + z * (1.0 - f.a);
    }
  }
  return BO(vec4f(H, 1.0), vec4f(z, 0.0, z.y));
}`;
const GLASS = /* wgsl */`
@group(2) @binding(0) var behindT: texture_2d<f32>;
@group(2) @binding(1) var behindS: sampler;
@group(2) @binding(2) var behindZ: texture_2d<f32>;
// the view depth of what is behind at uv (far where nothing is: the backdrop)
fn behindAt(uv: vec2f) -> f32 {
  let z = textureLoad(behindZ, vec2i(clamp(uv, vec2f(0.0), vec2f(0.9999)) * cam.drawn), 0);
  return select(1e5, z.r / max(z.g, 1e-4), z.g > 0.02);
}
// where a ray from P going D meets what is behind the glass, refined against the depth there a few times (from s0, a
// guess at how far): where on the frame (xy), and how far along the ray what is there is (z), read again where it ends.
// A ray that passes a nearer thing's edge flips between it and what is beyond; an odd number of steps ends it beside the
// edge, on what is beyond (as near as the frame shows it), at that one's distance, not the edge's
fn behindHit(P: vec3f, D: vec3f, s0: f32, steps: i32) -> vec3f {
  let z0 = viewZ(P);
  let dz = -dot(D, cam.back);
  var uv = toUV(P + D * s0);
  if (dz <= 0.02) { return vec3f(uv, s0); }
  for (var i = 0; i < steps; i++) { uv = toUV(P + D * clamp((behindAt(uv) - z0) / dz, 0.0, 4000.0)); }
  return vec3f(uv, clamp((behindAt(uv) - z0) / dz, 0.0, 4000.0));
}
// light from P going D (unit) inside the copy in use (I), whose solid is S: through it, bouncing inside where it cannot
// leave, and out: where it leaves, which way, and its path inside (still inside after every bounce: it leaves the way it
// was going, darkened as if it had gone on)
struct Crossed { P: vec3f, D: vec3f, path: f32 };
fn crossSolid(P0: vec3f, D0: vec3f, S: vec4f, ior: f32) -> Crossed {
  var P = P0;
  var D = D0;
  var path = 0.0;
  var left = false;
  var p = objP(P);
  for (var b = 0; b < 5; b++) {
    let d = normalize(objV(D));
    let e = p + d * exitSolid(p, d, S);
    let Q = worldP(e);
    path += length(Q - P);
    let No = worldN(nSolid(e, S));
    let o = refract(D, -No, ior);
    P = Q;
    if (dot(o, o) > 1e-6) { D = o; left = true; break; }
    D = reflect(D, -No);
    p = e + normalize(objV(D)) * 0.02;
  }
  return Crossed(P, D, select(path * 1.5, path, left));
}
// Light leaving glass at P going D: on through every other piece of glass it meets before what stops it (up to hops
// pieces), each bending it, taking its tint along the path (tau: optical depth so far) and its frost (cone); where it
// finally leaves glass and which way, and what it then meets (hit: how far, and whether a layer, as opaqueHit says).
// Along the way it passes what it sees through: a layer more clear than not, a pane (glass without a solid form, which
// only the camera's nearest refracts), and a piece past the last it may pass.
struct Ray { P: vec3f, D: vec3f, tau: vec3f, cone: f32, hit: vec2f };
fn onward(r0: Ray, hops: i32) -> Ray {
  var r = r0;
  for (var h = 0; h <= hops; h++) {
    var gone = 0.0;
    var into = -1;   // (the scene's entry for the glass it enters)
    r.hit = vec2f(1e6, 0.0);
    for (var k = 0; k < 8; k++) {
      let x = traceScene(r.P + r.D * gone, r.D, 0.2, 1e6);
      if (x.item < 0) { break; }
      gone += x.t;
      let it = itemAt(x.item);
      if (it.copy < 0) {
        if (planeColor(planeOf(-it.copy - 1), x.b, 0.0).a > 0.5) { r.hit = vec2f(gone, 1.0); break; }
        continue;
      }
      if (materialAt(it.node).transmission <= 0.0) { r.hit = vec2f(gone, 0.0); break; }
      if (h < hops && shapeOf(it.node).solid) { into = x.item; break; }
    }
    if (into < 0) { break; }
    let it = itemAt(into);
    useCopy(it.copy);
    let M = materialAt(it.node);
    let S = shapeOf(it.node).S;
    let P = r.P + r.D * gone;
    let N = worldN(nSolid(objP(P), S));
    let D = refract(r.D, N, 1.0 / M.ior);
    if (dot(D, D) < 1e-6) { r.P = P; r.D = reflect(r.D, N); continue; }   // (glancing off it)
    let out = crossSolid(P, D, S, M.ior);
    r.P = out.P; r.D = out.D;
    r.tau += M.absorb * out.path - log(max(M.base * tintOf(it.copy), vec3f(1e-3)));
    r.cone += M.rough * M.rough * 0.45;
  }
  return r;
}
// frost's spread on the frame as drawn (px) for light that leaves the glass at view depth z0 and meets something s further along
fn frostPx(cone: f32, rough: f32, z0: f32, dz: f32, s: f32) -> f32 { return max(cone * s, rough * 10.0) * cam.focal * cam.scale / max(z0 + dz * s, 1.0); }
struct GL { @location(0) color: vec4f, @location(1) pos: vec4f };
@fragment fn fs(v: MO) -> GL {
  let V = normalize(cam.eye - v.world);
  let n = normalize(v.nrm);
  let foot = length(fwidth(reflect(-V, select(n, -n, dot(n, V) < 0.0))));   // (how much the mirror direction turns across the pixel)
  let frag = v.pos.xy;
  let node = i32(v.tint.w + 0.5);
  let s = surfaceAt(Point(v.world, v.local, n, v.uv, dpdx(v.uv), dpdy(v.uv), vec3f(0.0), vec3f(0.0), node, v.tint.rgb, v.world / 300.0), V);
  let M = s.M;
  let N = s.N;
  let rough = clamp(M.rough, 0.0, 1.0);
  let shape = shapeOf(node);
  useCopy(i32(v.copy));
  // where on the solid this is (in its own space, about -1 to 1), for iridescence's bands
  let at = select(v.world / 300.0, objP(v.world) / max(shape.S.xyz, vec3f(1.0)), shape.solid);
  // in, through, out
  var D = refract(-V, N, 1.0 / M.ior);
  var P = v.world;
  var path = 0.0;
  var inside = vec2f(1e6, 0.0);   // (what the light meets inside the solid before it first leaves: a card through it)
  let Din = D;
  if (shape.solid) {
    let p = objP(P);
    let d = normalize(objV(D));
    let leaves = length(worldP(p + d * exitSolid(p, d, shape.S)) - P);
    let out = crossSolid(P, D, shape.S, M.ior);
    P = out.P; D = out.D; path = out.path;
    inside = opaqueHit(v.world, Din, leaves);
  } else {
    let t = M.thickness / max(dot(D, -N), 0.2);
    P += D * t;
    path = t;
    D = refract(D, N, M.ior);
  }
  // on through any other glass the light meets (its own frost and every piece's it passes, as a cone at the end)
  var ray = Ray(v.world, Din, vec3f(0.0), 0.0, inside);
  if (inside.x < 1e6) { path = inside.x; }
  else { ray = onward(Ray(P, D, vec3f(0.0), 0.0, vec2f(0.0)), i32(M.bounces)); }
  // Frost: rough glass scatters the light leaving it into a cone that widens with roughness (and a little even right at
  // its surface). Read from the frame, each sub-frame sends eight rays within the cone from where the light last leaves
  // glass, each to what it meets behind (a ray that clears a nearer thing's edge sees what is beyond it), and reads that
  // from a blurred level only as wide as the ray's share of the cone there. The sub-frames' rays interleave (each turns
  // and widens the spiral by its phase, over a turn and a ring per pixel), so a frame's rays cover the cone evenly: rough
  // refraction as stochastic screen-space reflections do rough reflection, the sub-frames standing in for their temporal
  // filter. Traced, each sub-frame sends up to four rays drawn from the cone the same way (more as it widens, within the
  // frame's budget), and the sub-frames average them, as rough reflections are.
  let cone = rough * rough * 0.45 + ray.cone;
  let skin = rough * 10.0;
  let T1 = normalize(cross(ray.D, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(ray.D.y) > 0.9)));
  let T2 = cross(ray.D, T1);
  let turn = hash3(vec3f(frag, 7.0)) + cam.phase;
  let ring = fract(hash3(vec3f(frag.yx + 17.0, 3.0)) + cam.phase);
  var sAt = ray.hit.x;   // (how far the middle ray goes: where each ray starts looking)
  var framed = ray.hit.x >= 1e6;
  if (framed) { sAt = behindHit(ray.P, ray.D, 0.0, 3).z; }
  else if (ray.hit.y > 0.5) {
    let X = ray.P + ray.D * ray.hit.x;
    let uvX = toUV(X);
    let zX = viewZ(X);
    let E = X - cam.eye;
    let e = length(E);
    framed = zX > 0.0 && all(uvX >= vec2f(0.0)) && all(uvX <= vec2f(1.0)) && behindAt(uvX) <= zX + 2.0 + 0.03 * zX
      && opaqueHit(cam.eye, E / e, e + 1.0).x >= e - 1.0 - 0.002 * e;
  }
  var through = vec3f(0.0);
  // (the rays traced: those through it, here, and those of its surface's reflections, in one loop: see Lobe)
  var traced = 0;
  let h = vec2f(hash3(vec3f(frag, 13.0)), hash3(vec3f(frag.yx, 29.0)));
  if (!framed) {
    traced = budget(1 + i32(round(3.0 * smoothstep(0.002, 0.05, cone))));
  } else {
    let uv0 = v.pos.xy / cam.drawn;
    let px = cam.drawn / cam.scale;   // (the frame's px: the fringe is as wide at any size drawn)
    for (var k = 0; k < 8; k++) {
      let a = (turn + f32(k) * 0.381966) * TAU;   // (the golden angle)
      // most of the light leaves near the middle of the cone, thinning out to its edge (a bell, not a disc: a disc's
      // hard rim doubles thin strokes, as a lens's bokeh does)
      let d = (T1 * cos(a) + T2 * sin(a)) * 0.55 * sqrt(-2.0 * log(1.0 - 0.9 * (f32(k) + ring) / 8.0));
      let Pk = ray.P + d * skin;
      let Dk = normalize(ray.D + d * cone);
      let hk = behindHit(Pk, Dk, sAt, 3);
      // each colour bends by a slightly different amount: the rainbow at the edges (by the bend, up to a few px: rays
      // bounced far inside would otherwise split into speckle)
      let bend = (hk.xy - uv0) * px * 0.12 * M.dispersion;
      let fringe = bend * min(1.0, 14.0 * M.dispersion / max(length(bend), 1e-3)) / px;
      let lk = log2(max(frostPx(cone, rough, viewZ(Pk), -dot(Dk, cam.back), hk.z) * 0.4, 1.0));
      through += vec3f(textureSampleLevel(behindT, behindS, hk.xy - fringe, lk).r, textureSampleLevel(behindT, behindS, hk.xy, lk).g,
        textureSampleLevel(behindT, behindS, hk.xy + fringe, lk).b);
    }
    through /= 8.0;
  }
  // its surface: what it reflects (traced), its lights' highlights, and what comes through it
  var lobes = array<Lobe, 2>(lobeOf(v.world, N, V, M.rough, iorF0(M.ior), foot, frag, false), noLobe());
  if (M.coat > 0.0) { lobes[1] = lobeOf(v.world, N, V, M.coatRough, iorF0(M.coatIor) * M.coat, foot, frag, false); }
  for (var i = -1; i < 2; i++) {
    let n = select(lobes[max(i, 0)].n, traced, i < 0);
    for (var k = 0; k < n; k++) {
      var O = vec3f(0.0); var R = vec3f(0.0); var spread = cone; var w0 = viewZ(ray.P) / cam.focal;
      if (i < 0) {
        let u = fract(h + (floor(cam.phase * 64.0) * 4.0 + f32(k)) * vec2f(0.7548777, 0.5698403));
        let a = u.y * TAU;
        let d = (T1 * cos(a) + T2 * sin(a)) * 0.55 * sqrt(-2.0 * log(1.0 - 0.9 * u.x));
        O = ray.P + d * skin; R = normalize(ray.D + d * cone);
      } else {
        O = lobes[i].X + lobes[i].N * 0.5; R = lobeRay(lobes[i], k); spread = lobes[i].cone; w0 = lobes[i].w0;
      }
      let got = traceLight(O, R, spread, w0, frag, false);
      if (i < 0) { through += got.light; } else { lobes[i] = lobeGot(lobes[i], R, got); }
    }
  }
  if (traced > 0) { through /= f32(traced); }
  through *= exp(-M.absorb * path - ray.tau);
  // frosted glass is milky: its rough surface scatters some of the light around it toward the eye
  through = mix(through, irradiance(N), rough * 0.3);
  let refl = lobeDone(lobes[0]).light;
  let coatRefl = lobeDone(lobes[1]).light;
  let lit = gather(v.world, N, V, clamp(M.rough, 0.02, 1.0), clamp(M.coatRough, 0.02, 1.0), M.sheenRough, weightsOf(M, s.base, N, V, at).w, frag, true, 0, notFound()).lit;
  let amb = irradiance(N);
  let shown = surfaceLight(s, V, lit, Terms(amb, refl, coatRefl, amb * sheenAlbedo(clamp(dot(N, V), 1e-3, 1.0), M.sheenRough)), at);
  return GL(vec4f(shown.col + shown.trans * through, 1.0), vec4f(v.world, 1.0));
}`;

export const glass = {
  name: 'glass', stage: 'sub', reads: ['color', 'position', 'depth', 'fragments'], writes: ['color', 'position', 'depth'],
  setup(R) {
    const dev = R.dev, F = GPUShaderStage.FRAGMENT;
    const depth = R.module(COMMON + VERTEX, 'glass depth');
    // glass's depth, nearest wins: into its own (where the nearest glass is: what is behind it), and into the frame's
    this.depthPipe = R.pipeline('glass depth', () => ({ layout: R.pipelineLayout([R.layouts.frame]), vertex: { module: depth, entryPoint: 'vs', buffers: R.vertexLayout },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } }));
    const T = (sampleType) => ({ visibility: F, texture: { sampleType } }), S = { visibility: F, buffer: { type: 'read-only-storage' } };
    this.behindLayout = dev.createBindGroupLayout({ entries: [S, S, T('unfilterable-float'), T('unfilterable-float'), T('depth')].map((e, binding) => ({ binding, ...e })) });
    const behind = R.module(BEHIND, 'behind glass');
    this.behindPipe = R.pipeline('behind glass', () => ({ layout: R.pipelineLayout([R.layouts.frame, this.behindLayout]), vertex: { module: behind, entryPoint: 'vs' },
      fragment: { module: behind, entryPoint: 'fs', targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }] }, primitive: { topology: 'triangle-list' } }));
    // (with GI, what it found where the rays through it and its reflections meet something: its probes, bindings 3–5)
    const own = [T('float'), { visibility: F, sampler: {} }, T('unfilterable-float')].map((e, binding) => ({ binding, ...e }));
    this.layouts = { false: dev.createBindGroupLayout({ entries: own }), true: dev.createBindGroupLayout({ entries: [...own, ...giReadLayout(3, F)] }) };
    this.sampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  },
  // the glass's shading (it reads the scene's shaders, with the film's surfaces compiled in: what it shows through is lit
  // as the camera would see it; giOn: GI found its probes this sub-frame, sub.giProbes, which light what its rays meet)
  pipe(R, giOn) {
    return R.pipeline(`glass|${R.surfaceKey}|${giOn}`, () => {
      const mod = R.module(R.prelude(giOn ? aroundGI(2, 3) : undefined) + VERTEX + GLASS, 'glass');
      return { layout: R.pipelineLayout([R.layouts.frame, R.layouts.scene, this.layouts[giOn]]), vertex: { module: mod, entryPoint: 'vs', buffers: R.vertexLayout },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba16float' }, { format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' } };
    });
  },
  // its own textures, the frame's size: the nearest glass's depth, the frame behind it (with its blurred levels) and its depth
  sized(R) {
    const dev = R.dev, U = GPUTextureUsage;
    for (const t of [this.cut, this.behind, this.behindZ]) t?.destroy();
    this.cut = dev.createTexture({ size: [R.pw, R.ph], format: 'depth32float', label: 'nearest glass', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
    this.behind = dev.createTexture({ size: [R.pw, R.ph], format: 'rgba16float', mipLevelCount: LEVELS, label: 'behind glass', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
    this.behindZ = dev.createTexture({ size: [R.pw, R.ph], format: 'rgba16float', label: 'behind glass, depth', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING });
    this.levels = Array.from({ length: LEVELS }, (_, i) => this.behind.createView({ baseMipLevel: i, mipLevelCount: 1 }));
  },
  want(R, sub) { if (sub.glass.length) this.pipe(R, !!(sub.gi && R.passes.some((p) => p.name === 'gi'))); },
  async run(R, sub) {
    if (!sub.glass.length) return;
    const dev = R.dev, Fr = R.fragments, probes = sub.giProbes, giOn = !!probes;
    const [depthPipe, behindPipe, pipe] = await Promise.all([this.depthPipe, this.behindPipe, this.pipe(R, giOn)]);
    if (this.gen !== R.tex.gen) { this.gen = R.tex.gen; this.sized(R); this.behindKey = null; this.bgKey = null; }
    if (this.bgKey !== probes?.idx) {
      this.bgKey = probes?.idx;
      this.bg = dev.createBindGroup({ layout: this.layouts[giOn], entries: [...[this.behind.createView(), this.sampler, this.behindZ.createView()].map((resource, binding) => ({ binding, resource })),
        ...(giOn ? giReadEntries(probes, 3) : [])] });
    }
    const key = `${R.tex.gen}:${Fr.gen}`;
    if (this.behindKey !== key) {
      this.behindKey = key;
      this.behindBG = dev.createBindGroup({ layout: this.behindLayout, entries: [{ buffer: Fr.heads }, { buffer: Fr.list }, R.view('color'), R.view('position'), this.cut.createView()]
        .map((resource, binding) => ({ binding, resource })) });
    }
    const clear = (view) => ({ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] });
    const depthOf = (view, loadOp) => {
      const p = R.enc.beginRenderPass({ label: 'glass depth', colorAttachments: [], depthStencilAttachment: { view, depthClearValue: 0, depthLoadOp: loadOp, depthStoreOp: 'store' } });
      p.setPipeline(depthPipe); p.setBindGroup(0, R.frameBG); R.drawMeshes(p, sub.glass); p.end();
    };
    depthOf(this.cut.createView(), 'clear');
    depthOf(R.view('depth'), 'load');
    const b = R.enc.beginRenderPass({ label: 'behind glass', colorAttachments: [clear(this.levels[0]), clear(this.behindZ.createView())] });
    b.setPipeline(behindPipe); b.setBindGroup(0, R.frameBG); b.setBindGroup(1, this.behindBG); b.draw(3); b.end();
    drawLevels(R.dev, R.enc, this.levels, 'rgba16float', true);
    for (let k = 0; k < R.bands; k++) {
      const g = R.enc.beginRenderPass({ label: 'glass', colorAttachments: [R.load('color'), R.load('position')], depthStencilAttachment: { view: R.view('depth'), depthReadOnly: true } });
      R.band(g, k);
      g.setPipeline(pipe); g.setBindGroup(0, R.frameBG); g.setBindGroup(1, R.sceneBG); g.setBindGroup(2, this.bg);
      R.drawMeshes(g, sub.glass, k);
      g.end();
      if (R.bands > 1) R.cut();
    }
  },
};
