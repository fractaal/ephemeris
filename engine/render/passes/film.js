// A film's own passes (F.pass, see pass.js): full-screen shaders of the film's, run where their stage says, each on what
// the one before it made, in scene order.
//   scene     each sub-frame, on what is opaque (light), with where each pixel's surface is: fog, light in it, a
//             raymarched world (which may draw surfaces the rest of the frame meets: drawSurface)
//   light     once a frame, on the frame's light (what the sub-frames added up, before the view transform): halation,
//             glows, a grade in light
//   display   once a frame, on the frame as seen (after the view transform, the layers as authored over it): grain, a
//             print's look, a grade on the picture
// A pass sees the scene as every pass of the renderer does (shaders.js: the camera, the world, the scene's tables), so
// what it draws can be lit as meshes are, shadowed by the scene's surfaces and its own, and reflect the scene.
import { withRays } from '../rays.js';
import { used } from '../used.js';
import { W, H } from '../../camera.js';
import { instanceData, INSTANCE_FLOATS } from '../../mesh.js';
import { material } from '../../mesh.js';
import { paramData, Texture } from '../../pass.js';
import { MATERIAL, packMaterial, MATERIAL_VEC4S } from '../materials.js';
import { FULLSCREEN_VS } from '../shaders.js';
import { drawLevels } from '../levels.js';
import { cameraData, worldData, lightsOf } from '../scene.js';

const LEVELS = 8;   // (the picture so far's blurred levels)
const STAGE = { scene: 0, light: 1, display: 2 };

// a material's defaults (material() in mesh.js), as the Material struct holds them
const DEFAULT = (() => {
  const d = new Float32Array(MATERIAL_VEC4S * 4);
  packMaterial(material(), { baseTex: -1, normalTex: -1, surface: 0 }, d, 0);
  let at = 0;
  const parts = MATERIAL.map(([, type]) => {
    const n = type === 'vec3f' ? 3 : 1;
    if (n === 3 && at % 4 > 1) at = Math.ceil(at / 4) * 4;
    const v = Array.from(d.subarray(at, at + n), (x) => x.toFixed(6));
    at += n;
    return n === 3 ? `vec3f(${v.join(', ')})` : v[0];
  });
  return `Material(${parts.join(', ')})`;
})();

const PRELUDE = /* wgsl */`
// the moment (the sub-frame's in the scene stage), the frame's index, the film's fps, a seed that differs per sub-frame,
// the size of what it draws (px: the frame's, or its target's), the texels a px it is drawn at, its stage
struct Film { t: f32, frame: f32, fps: f32, seed: f32, size: vec2f, texel: f32, stage: f32 };
@group(2) @binding(0) var<uniform> film: Film;
@group(2) @binding(1) var<uniform> p: Params;
@group(2) @binding(2) var src: texture_2d<f32>;
@group(2) @binding(3) var smp: sampler;
@group(2) @binding(4) var posT: texture_2d<f32>;
@group(2) @binding(5) var nrmT: texture_2d<f32>;
@group(2) @binding(6) var<storage, read> data: array<vec4f>;
@group(2) @binding(7) var depthT: texture_depth_2d;
struct Obj { m: mat4x4f, inv: mat4x4f, bounds: vec4f };   // a placed pass's: its own space → the world, back, half extents
@group(2) @binding(8) var<uniform> obj: Obj;
var<private> FRAME: vec2f;   // (the frame's size, px: the film's, or a view's of its own shape)
var<private> PX: vec2f;   // (the pixel being drawn, frame px: what sampling seeds by)
fn pxOf(px: vec2f) -> vec2i { return vec2i(clamp(px * cam.scale, vec2f(0.0), cam.drawn - 1.0)); }
// the picture so far as this stage has it (the light stage's is kept as light × its share not under authored layers)
fn asStaged(c: vec4f) -> vec4f { if (film.stage == 1.0) { return vec4f(select(vec3f(0.0), c.rgb / c.w, c.w > 1e-5), 1.0); } return c; }
fn input(px: vec2f) -> vec4f { return asStaged(textureLoad(src, pxOf(px), 0)); }
fn inputAt(uv: vec2f, lod: f32) -> vec4f { return asStaged(textureSampleLevel(src, smp, uv, lod)); }
// a blurred level read through a cubic B-spline over its texels (four bilinear reads; Sigg and Hadwiger 2005): the level
// spread back over the frame as a smooth blur, where a plain read of a coarse one shows its texels' grid as blocks
fn inputLevel(uv: vec2f, level: i32) -> vec4f {
  let lv = clamp(level, 0, i32(textureNumLevels(src)) - 1);
  let size = vec2f(textureDimensions(src, lv));
  let q = uv * size - 0.5; let i = floor(q); let f = q - i;
  let f2 = f * f; let f3 = f2 * f;
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0; let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0; let w3 = f3 / 6.0;
  let g0 = w0 + w1; let g1 = w2 + w3;
  let t0 = (i - 0.5 + w1 / g0) / size; let t1 = (i + 1.5 + w3 / g1) / size; let L = f32(lv);
  return asStaged((textureSampleLevel(src, smp, t0, L) * g0.x + textureSampleLevel(src, smp, vec2f(t1.x, t0.y), L) * g1.x) * g0.y
       + (textureSampleLevel(src, smp, vec2f(t0.x, t1.y), L) * g0.x + textureSampleLevel(src, smp, t1, L) * g1.x) * g1.y);
}
fn inputSmooth(uv: vec2f, lod: f32) -> vec4f {
  let l = floor(lod);
  if (lod == l) { return inputLevel(uv, i32(l)); }
  return mix(inputLevel(uv, i32(l)), inputLevel(uv, i32(l) + 1), lod - l);
}
fn surface(px: vec2f) -> vec4f { return textureLoad(posT, pxOf(px), 0); }
fn surfaceNormal(px: vec2f) -> vec3f { let n = textureLoad(nrmT, pxOf(px), 0).xyz; return select(vec3f(0.0), normalize(n), dot(n, n) > 0.0); }
struct Ray { o: vec3f, d: vec3f };
fn viewRay(px: vec2f) -> Ray { return Ray(cam.eye, viewDir(px)); }
// a placed pass's own space (bounds: where it was placed, turned, scaled): points and ways into it and out of it; and
// where a ray is inside its bounds, [enter, leave] as distances along it (enter > leave: it misses)
fn toLocal(q: vec3f) -> vec3f { return (obj.inv * vec4f(q, 1.0)).xyz; }
fn toWorld(q: vec3f) -> vec3f { return (obj.m * vec4f(q, 1.0)).xyz; }
fn toLocalDir(d: vec3f) -> vec3f { return (obj.inv * vec4f(d, 0.0)).xyz; }
fn normalToWorld(n: vec3f) -> vec3f { return normalize((vec4f(n, 0.0) * obj.inv).xyz); }
fn boundsHit(r: Ray) -> vec2f {
  let o = toLocal(r.o); let d = toLocalDir(r.d); let h = obj.bounds.xyz;
  let inv = 1.0 / select(d, vec3f(1e-9), abs(d) < vec3f(1e-9));
  let t0 = (-h - o) * inv; let t1 = (h - o) * inv;
  let tn = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
  let tf = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
  return vec2f(max(tn, 0.0), tf);
}
// a mesh material's parts with its defaults (Blender's Principled BSDF: material() in mesh.js); set the rest on it
fn material(base: vec3f, rough: f32, metal: f32) -> Material { var m = ${DEFAULT}; m.base = base; m.rough = rough; m.metal = metal; return m; }
// A surface of the pass's own, lit as meshes are, by the same code: the environment around it (as open as ao says),
// what it reflects at its roughness and its coat's (refl, coatRefl: your own traced reflections — reflection() traces
// the scene — or the environment's), and every light; the lights with shadows: true are shadowed by the scene's surfaces
// (one traced ray each) and, where the pass defines fn sceneDistance, by its own (softShadow), each light that gives a
// fiftieth of this point's light or more. Its light (col) and how much of what lies behind it comes through (trans).
fn litMaterialReflecting(X: vec3f, N: vec3f, V: vec3f, m: Material, refl: vec3f, coatRefl: vec3f, ao: f32) -> Shown {
  let rough = clamp(m.rough, 0.02, 1.0); let coatRough = clamp(m.coatRough, 0.02, 1.0);
  var light = noTerms();
  var total = 0.0;
  for (var i = 0; i < lightCount(); i++) {
    let o = lightHere(i, X);
    if (max(o.c.r, max(o.c.g, o.c.b)) < 1e-5) { continue; }
    let t = termsOf(o.c, o.L, o.size, N, V, rough, coatRough, m.sheenRough);
    light = plus(light, t); total += luma(t.diff + t.spec);
  }
  for (var i = 0; i < lightCount() && total > 0.0; i++) {
    let o = lightHere(i, X);
    if (!o.shadowed || max(o.c.r, max(o.c.g, o.c.b)) < 1e-5) { continue; }
    let t = termsOf(o.c, o.L, o.size, N, V, rough, coatRough, m.sheenRough);
    if (luma(t.diff + t.spec) < 0.02 * total) { continue; }
    let k = lightRay(X, N, i, PX, 0.0) * shadowToward(X, N, o.L, o.dist - world.lights[i].radius, o.size);
    light = plus(light, scaled(t, k - 1.0));
  }
  let a = irradiance(N) * ao;
  return surfaceLight(Surf(m, m.base, N, false, vec3f(0.0)), V, light, Terms(a, refl, coatRefl, a * sheenAlbedo(clamp(dot(N, V), 1e-3, 1.0), m.sheenRough)), vec3f(0.0));
}
// its light reflecting the environment (an opaque material's whole light)
fn litMaterial(X: vec3f, N: vec3f, V: vec3f, m: Material) -> vec3f {
  let R = reflect(-V, N);
  return litMaterialReflecting(X, N, V, m, environment(R, clamp(m.rough, 0.02, 1.0) * 0.7), environment(R, clamp(m.coatRough, 0.02, 1.0) * 0.7), openAround(X, N)).col;
}
fn litAsMeshes(X: vec3f, N: vec3f, V: vec3f, base: vec3f, rough: f32, metal: f32) -> vec3f { return litMaterial(X, N, V, material(base, rough, metal)); }
// world point P on the frame: its px (x, y) and how far in front of the eye it is (z)
fn framePoint(P: vec3f) -> vec3f {
  let d = P - cam.eye; let z = -dot(d, cam.back);
  return vec3f(vec2f(dot(d, cam.right), dot(d, cam.down)) * cam.focal / max(z, 1e-3) + cam.center + cam.jitter, z);
}
// what lies behind a surface of the pass's own, along D (unit) from X (where the light leaves it): the first of the
// frame's opaque surfaces the ray goes behind (as the frame has them before this pass), or the backdrop, read from the
// picture so far, blurred as rough glass frosts it (rough). What the frame does not show (off it, or hidden) is not there
fn seenThrough(X: vec3f, D: vec3f, rough: f32) -> vec3f {
  var t = 0.0; var dt = 8.0; var at = framePoint(X); var hit = false;
  for (var i = 0; i < 40; i++) {
    let q = framePoint(X + D * (t + dt));
    if (q.z <= 1.0 || any(q.xy < vec2f(0.0)) || any(q.xy > FRAME)) { break; }
    t += dt; at = q;
    let s = surface(q.xy);
    if (s.w > 0.5 && q.z > framePoint(s.xyz).z + 1.0) { hit = true; break; }
    dt *= 1.3;
  }
  if (hit) {   // (back toward where the ray went behind it)
    var lo = t - dt / 1.3; var hi = t;
    for (var k = 0; k < 5; k++) {
      let mid = 0.5 * (lo + hi); let q = framePoint(X + D * mid); let s = surface(q.xy);
      if (s.w > 0.5 && q.z > framePoint(s.xyz).z + 1.0) { hi = mid; at = q; } else { lo = mid; }
    }
  }
  let spread = (rough * rough * 0.45 * t + rough * 10.0) * cam.focal / max(at.z, 1.0);
  return inputSmooth(at.xy / FRAME, log2(max(spread * cam.scale, 1.0))).rgb;
}
// the material lit, with, where it transmits, the frame behind it seen through it (bent once at its surface: a solid of
// your own is better marched through to where the light leaves it, and seenThrough read from there)
fn shownAsMeshes(X: vec3f, N: vec3f, V: vec3f, m: Material) -> vec3f {
  let R = reflect(-V, N);
  let lit = litMaterialReflecting(X, N, V, m, environment(R, clamp(m.rough, 0.02, 1.0) * 0.7), environment(R, clamp(m.coatRough, 0.02, 1.0) * 0.7), openAround(X, N));
  if (m.transmission <= 0.0) { return lit.col; }
  return lit.col + lit.trans * seenThrough(X, refract(-V, N, 1.0 / m.ior), m.rough);
}
fn filmGrain(px: vec2f) -> f32 { return hash3(vec3f(px, fract(film.frame * 0.618) * 937.0 + 17.0)); }
struct Surface { color: vec4f, world: vec4f, normal: vec3f };`;

// A pass whose code defines fn sceneDistance(w: vec3f) -> f32 (how far world point w is from its surfaces, px) gets
// shadows and occlusion through them: softShadow (how much of the way toward a light, unit L, dist away, they leave
// open, soft by k: about the light's distance over its radius), occlusion (how open the surface is around X, over a reach
// of r px), and its lit materials shadowed and occluded by them
const SHADOWS = (P) => (/fn\s+sceneDistance\s*\(/.test(P.code) ? /* wgsl */`
const HAS_DISTANCE = true;
fn softShadow(X: vec3f, L: vec3f, dist: f32, k: f32) -> f32 {
  var res = 1.0; var t = 0.5; var ph = 1e10;
  for (var i = 0; i < 64; i++) {
    let h = sceneDistance(X + L * t);
    // (the penumbra from this step and the last, where the field is a true distance; Quilez's improved estimate)
    let y = select(0.0, h * h / (2.0 * ph), h < 2.0 * ph); let d = sqrt(max(h * h - y * y, 0.0));
    res = min(res, k * d / max(t - y, 1e-4)); ph = h;
    t += clamp(h, 0.3 + 0.002 * t, max(dist / 16.0, 40.0));
    if (res < 0.01 || t > dist) { break; }
  }
  return clamp(res, 0.0, 1.0);
}
fn occlusion(X: vec3f, N: vec3f, r: f32) -> f32 {
  var o = 0.0; var sc = 1.0;
  for (var i = 0; i < 5; i++) { let h = r * (0.1 + 0.22 * f32(i)); o += (h - sceneDistance(X + N * h)) * sc; sc *= 0.7; }
  return clamp(1.0 - 1.5 * o / r, 0.0, 1.0);
}
fn shadowToward(X: vec3f, N: vec3f, L: vec3f, dist: f32, size: f32) -> f32 { return softShadow(X + N * 0.5, L, dist, clamp(1.0 / max(size, 1e-3), 2.0, 64.0)); }
fn openAround(X: vec3f, N: vec3f) -> f32 { return occlusion(X, N, 16.0); }` : /* wgsl */`
const HAS_DISTANCE = false;
fn shadowToward(X: vec3f, N: vec3f, L: vec3f, dist: f32, size: f32) -> f32 { return 1.0; }
fn openAround(X: vec3f, N: vec3f) -> f32 { return 1.0; }`);
// the pictures a pass reads, by their names (group 3: a repeating sampler, then each texture or target)
const TEXTURES = (P) => {
  const names = Object.keys(P.textures ?? {});
  return names.length ? `\n@group(3) @binding(0) var smpWrap: sampler;\n${names.map((k, i) => `@group(3) @binding(${i + 1}) var ${k}: texture_2d<f32>;`).join('\n')}` : '';
};
// (what it writes kept finite: one infinite or NaN pixel spreads through every blur and level after it as a black block;
// the check is on the bits, since WGSL lets a compiler assume no float is ever either)
const FINITE = /* wgsl */`
fn keepFinite1(x: f32) -> f32 {
  let b = bitcast<u32>(x);
  if ((b & 0x7f800000u) != 0x7f800000u) { return clamp(x, -65000.0, 65000.0); }
  if ((b & 0x007fffffu) != 0u) { return 0.0; }
  return select(65000.0, -65000.0, (b & 0x80000000u) != 0u);
}
fn keepFinite(c: vec3f) -> vec3f { return vec3f(keepFinite1(c.x), keepFinite1(c.y), keepFinite1(c.z)); }`;
const head = (R, P) => FULLSCREEN_VS + R.prelude() + P.layout.struct + PRELUDE + SHADOWS(P) + TEXTURES(P);
// what a pass writes: a surface pass its colour and, where it drew a surface, its world point, normal and depth (so what
// comes after meets it); a light-stage pass its light, kept as the frame keeps it (× the share not under authored layers)
const TAIL = (P, stage) => FINITE + (P.surfaces ? /* wgsl */`
struct SO { @location(0) color: vec4f, @location(1) world: vec4f, @location(2) normal: vec4f, @builtin(frag_depth) depth: f32 };
@fragment fn fs(v: VO) -> SO {
  let px = v.pos.xy / cam.scale;
  PX = px; FRAME = 2.0 * cam.center;
  let s = drawSurface(px, px / FRAME);
  var o: SO;
  o.color = vec4f(keepFinite(s.color.rgb), 1.0);
  let vd = viewZ(s.world.xyz);
  if (s.world.w > 0.5 && vd > NEAR) {
    o.world = vec4f(s.world.xyz, 1.0); o.normal = vec4f(s.normal, 0.0); o.depth = NEAR / vd;
  } else {
    // (no surface drawn here: what was there stays, the colour changed over it)
    let ip = pxOf(px);
    o.world = textureLoad(posT, ip, 0); o.normal = textureLoad(nrmT, ip, 0); o.depth = textureLoad(depthT, ip, 0);
  }
  return o;
}` : /* wgsl */`
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let px = v.pos.xy / film.texel;
  PX = px; FRAME = 2.0 * cam.center;
  let c = keepFinite(draw(px, px / film.size).rgb);
  ${STAGE[stage] === 1 && !P.target ? 'let w = textureLoad(src, vec2i(v.pos.xy), 0).w; return vec4f(c * w, w);' : 'return vec4f(c, 1.0);'}
}`);
const PICK = /* wgsl */`
@fragment fn fs(v: VO) -> @location(0) vec4f { PX = v.pos.xy / cam.scale; FRAME = 2.0 * cam.center; let r = pick(PX); return vec4f(r.x, r.y, 0.0, 1.0); }`;

// a placed pass's own space as its uniform holds it: to the world and back (column-major 4x4s, turned and scaled as a
// mesh copy is), and its half extents; an unplaced pass's is the world's own
function objData(n) {
  const d = new Float32Array(36), f = new Float32Array(INSTANCE_FLOATS);
  instanceData([n.pass.bounds ? n : {}], f, 0);
  const M = [0, 1, 2].map((r) => [0, 1, 2].map((c) => f[c * 4 + r]));
  const T = [f[3], f[7], f[11]], Iv = [0, 1, 2].map((r) => [0, 1, 2].map((c) => f[12 + r * 4 + c]));
  const Ti = [0, 1, 2].map((r) => -(Iv[r][0] * T[0] + Iv[r][1] * T[1] + Iv[r][2] * T[2]));
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) { d[c * 4 + r] = M[r][c]; d[16 + c * 4 + r] = Iv[r][c]; }
  d.set([...T, 1], 12); d.set([...Ti, 1], 28);
  d.set([...(n.pass.bounds ?? [0, 0, 0]), n.pass.bounds ? 1 : 0], 32);
  return d;
}

/** The film's passes of a stage, as a pass of the frame's. */
export function filmPasses(stage) {
  const sub = stage === 'scene', target = { scene: 'color', light: 'light', display: 'display' }[stage];
  return {
    name: `film ${stage} passes`, stage: sub ? 'sub' : 'frame',
    reads: sub ? ['color', 'position', 'normal', 'depth'] : [target], writes: sub ? ['color', 'position', 'normal', 'depth'] : [target],
    setup(R) { shared(R); },
    want(R, s) { for (const n of s.scene.nodes) if (n?.pass?.stage === stage) pipe(R, n.pass, stage); },
    async run(R, x) {
      const list = (sub ? x.scene.nodes : x.passes).filter((n) => n?.pass?.stage === stage);
      if (list.length) await runPasses(R, stage, list, R.tex[target], sub ? { t: x.scene.t ?? 0, first: x.first } : { t: x.t, first: true });
    },
  };
}

// what every film pass binds: its group 2's layout, and its slots
function shared(R) {
  if (R.film) return;
  const FS = GPUShaderStage.FRAGMENT, dev = R.dev;
  R.film = {
    layout: dev.createBindGroupLayout({ entries: [
      { binding: 0, visibility: FS, buffer: {} }, { binding: 1, visibility: FS, buffer: {} },
      { binding: 2, visibility: FS, texture: {} }, { binding: 3, visibility: FS, sampler: {} },
      { binding: 4, visibility: FS, texture: { sampleType: 'unfilterable-float' } }, { binding: 5, visibility: FS, texture: { sampleType: 'unfilterable-float' } },
      { binding: 6, visibility: FS, buffer: { type: 'read-only-storage' } }, { binding: 7, visibility: FS, texture: { sampleType: 'depth' } }, { binding: 8, visibility: FS, buffer: {} }] }),
    slots: { scene: [], light: [], display: [], pick: [] }, onces: {}, gen: -1,
  };
}
// the textures a pass reads from (made again at a new size): the picture so far with its levels, the surfaces so far
function inputs(R) {
  const F = R.film, dev = R.dev, U = GPUTextureUsage;
  if (F.gen === R.tex.gen) return F;
  F.gen = R.tex.gen;
  for (const t of [F.input, F.pos, F.nrm, F.depth, ...Object.values(F.onces)]) t?.destroy();
  F.onces = {};
  F.input = dev.createTexture({ size: [R.pw, R.ph], format: 'rgba16float', mipLevelCount: LEVELS, label: 'pass input', usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_DST });
  F.levels = Array.from({ length: LEVELS }, (_, i) => F.input.createView({ baseMipLevel: i, mipLevelCount: 1 }));
  F.pos = dev.createTexture({ size: [R.pw, R.ph], format: 'rgba32float', label: 'pass surfaces', usage: U.TEXTURE_BINDING | U.COPY_DST });
  F.nrm = dev.createTexture({ size: [R.pw, R.ph], format: 'rgba16float', label: 'pass normals', usage: U.TEXTURE_BINDING | U.COPY_DST });
  F.depth = dev.createTexture({ size: [R.pw, R.ph], format: 'depth32float', label: 'pass depth', usage: U.TEXTURE_BINDING | U.COPY_DST });
  for (const st of Object.values(F.slots)) for (const s of st) if (s) s.bg = {};
  return F;
}
// a pass's slot in its stage (the i-th pass there): its moment, params, data and bind groups
function slot(R, stage, i, P, data, surf) {
  const F = R.film, dev = R.dev, B = GPUBufferUsage;
  const s = (F.slots[stage][i] ??= { film: dev.createBuffer({ size: 32, usage: B.UNIFORM | B.COPY_DST }), obj: dev.createBuffer({ size: 144, usage: B.UNIFORM | B.COPY_DST }), params: null, data: null, bg: {} });
  if (!s.params || s.params.size < P.layout.bytes) { s.params?.destroy(); s.params = dev.createBuffer({ size: P.layout.bytes, usage: B.UNIFORM | B.COPY_DST }); s.bg = {}; }
  const d = data ? Float32Array.from(data) : null, bytes = Math.max(16, Math.ceil((d?.length ?? 0) / 4) * 16);
  if (!s.data || s.data.size < bytes) { s.data?.destroy(); s.data = dev.createBuffer({ size: bytes, usage: B.STORAGE | B.COPY_DST }); s.bg = {}; }
  if (d?.length) { const pad = new Float32Array(bytes / 4); pad.set(d); dev.queue.writeBuffer(s.data, 0, pad); }
  const key = surf ? 'surface' : 'plain';
  s.bg[key] ??= dev.createBindGroup({ layout: F.layout, entries: [
    { binding: 0, resource: { buffer: s.film } }, { binding: 1, resource: { buffer: s.params } },
    { binding: 2, resource: F.input.createView() }, { binding: 3, resource: R.linear },
    { binding: 4, resource: (surf ? F.pos : R.tex.position).createView() }, { binding: 5, resource: (surf ? F.nrm : R.tex.normal).createView() },
    { binding: 6, resource: { buffer: s.data } }, { binding: 7, resource: (surf ? F.depth : R.tex.depth).createView() }, { binding: 8, resource: { buffer: s.obj } }] });
  return s;
}
// a pass's group layouts: the frame's, the scene's, its own, and its pictures' where it reads any
function groups(R, P) {
  const n = Object.keys(P.textures ?? {}).length, base = [R.layouts.frame, R.layouts.scene, R.film.layout];
  if (!n) return base;
  P.texLayout ??= R.dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ...Object.values(P.textures).map((t, i) => ({ binding: i + 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: t.format === 'rgba32float' ? 'unfilterable-float' : 'float' } }))] });
  return [...base, P.texLayout];
}
// its pipeline, made once per pass, stage and set of the scene's surfaces; an error in its WGSL is said at the line of
// the film's code
function pipe(R, P, stage) {
  const key = `${stage}:${R.surfaceKey}`, pipes = (P.renderPipes ??= {});
  if (pipes[key]) return pipes[key];
  // (made away from the GPU process's main thread, as R.pipeline makes the studio's: a promise of it)
  const h = head(R, P), offset = h.split('\n').length;
  const mod = R.dev.createShaderModule({ code: withRays(used(h + '\n' + P.code + '\n' + TAIL(P, stage))), label: `pass ${P.label}` });
  mod.getCompilationInfo().then((info) => {
    for (const m of info.messages) if (m.type === 'error') console.error(`[pass "${P.label}"] ${m.message} ${m.lineNum > offset ? `(its code, line ${m.lineNum - offset})` : `(line ${m.lineNum} of what Ephemeris puts before it: does the code name something it gives? see engine/render/passes/film.js)`}`);
  });
  const targets = P.surfaces ? [{ format: 'rgba16float' }, { format: 'rgba32float' }, { format: 'rgba16float' }] : [{ format: P.target?.format ?? 'rgba16float' }];
  R.asked++;
  const p = (pipes[key] = R.dev.createRenderPipelineAsync({ layout: R.pipelineLayout(groups(R, P)), vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets },
    primitive: { topology: 'triangle-list' },
    // (a surface pass draws where nothing opaque is nearer, and is then what is opaque there)
    ...(P.surfaces && { depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' } }) }));
  p.catch(() => { if (pipes[key] === p) delete pipes[key]; });
  return p;
}
// its pictures' bind group (null: it reads none), made again when one of them is
function pictures(R, P) {
  const ts = Object.values(P.textures ?? {});
  if (!ts.length) return null;
  const views = ts.map((t) => (t instanceof Texture ? texGPU(R, t) : targetGPU(R, t)));
  const key = views.map((v) => v.gen).join(',');
  if (P.texBGKey !== key || !P.texBG) {
    R.wrap ??= R.dev.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
    groups(R, P);
    P.texBG = R.dev.createBindGroup({ layout: P.texLayout, entries: [{ binding: 0, resource: R.wrap }, ...views.map((v, i) => ({ binding: i + 1, resource: v.view }))] });
    P.texBGKey = key;
  }
  return P.texBG;
}
// a picture a film made (F.texture: an image with its mip levels, or its own numbers), on the GPU once
function texGPU(R, T) {
  R.texs ??= new Map();
  let g = R.texs.get(T);
  if (g) return g;
  const dev = R.dev, U = GPUTextureUsage;
  if (T.url && !T.image) throw new Error(`texture "${T.label}" is not loaded (made with F.texture, it loads before ready())`);
  const levels = T.image ? Math.max(1, Math.floor(Math.log2(Math.max(T.width, T.height))) + 1) : 1;
  const tex = dev.createTexture({ size: [T.width, T.height], format: T.format, mipLevelCount: levels, label: T.label, usage: U.TEXTURE_BINDING | U.COPY_DST | U.RENDER_ATTACHMENT });
  if (T.image) {
    dev.queue.copyExternalImageToTexture({ source: T.image }, { texture: tex }, [T.width, T.height]);
    const enc = dev.createCommandEncoder();
    drawLevels(dev, enc, Array.from({ length: levels }, (_, l) => tex.createView({ baseMipLevel: l, mipLevelCount: 1 })), T.format);
    dev.queue.submit([enc.finish()]);
  } else {
    const per = T.format === 'rgba32float' ? 16 : 4, data = T.format === 'rgba32float' ? Float32Array.from(T.data) : Uint8Array.from(T.data);
    dev.queue.writeTexture({ texture: tex }, data, { bytesPerRow: T.width * per }, [T.width, T.height]);
  }
  g = { tex, view: tex.createView(), gen: (R.texGen = (R.texGen ?? 0) + 1) };
  R.texs.set(T, g);
  return g;
}
// a picture a film's passes draw into (F.target), at its size: the frame's (as drawn) × its scale, or its own
function targetGPU(R, T) {
  R.tgts ??= new Map();
  const lw = Math.max(1, Math.round(T.size?.[0] ?? R.fw * T.scale)), lh = Math.max(1, Math.round(T.size?.[1] ?? R.fh * T.scale));
  const w = T.size ? lw : Math.max(1, Math.round(R.pw * T.scale)), h = T.size ? lh : Math.max(1, Math.round(R.ph * T.scale));
  let g = R.tgts.get(T);
  if (!g || g.w !== w || g.h !== h) {
    g?.tex.destroy();
    const tex = R.dev.createTexture({ size: [w, h], format: T.format, label: T.label, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
    g = { tex, view: tex.createView(), w, h, gen: (R.texGen = (R.texGen ?? 0) + 1) };
    R.tgts.set(T, g);
  }
  Object.assign(g, { lw, lh, texel: w / lw });   // (the frame's px it spans: another frame's shape, the same texels)
  return g;
}

/**
 * The film's passes of one stage over `target`, in order. A pass with a target of its own draws into that instead; one
 * drawn once (once: true) draws on the frame's first sub-frame, and on the frame's others what it drew is given again.
 */
async function runPasses(R, stage, list, target, info) {
  // (what each draws with, made before anything is recorded: those given again on a frame's later sub-frames draw nothing)
  const pipes = await Promise.all(list.map((n) => (n.pass.once && !info.first ? null : pipe(R, n.pass, stage))));
  const F = inputs(R), dev = R.dev, enc = R.enc;
  const load = (t) => ({ view: t.createView(), loadOp: 'load', storeOp: 'store' });
  list.forEach((n, i) => {
    const P = n.pass, surf = P.surfaces && stage === 'scene';
    if (P.once && !info.first) { if (!P.target) enc.copyTextureToTexture({ texture: once(R, stage, i) }, { texture: target }, [R.pw, R.ph]); return; }
    const s = slot(R, stage, i, P, n.data, surf), out = P.target ? targetGPU(R, P.target) : null;
    dev.queue.writeBuffer(s.film, 0, new Float32Array([info.t, R.frameInfo.frame, R.frameInfo.fps, stage === 'scene' ? R.sub.seed : R.frameInfo.frame, out ? out.lw : R.fw, out ? out.lh : R.fh, out ? out.texel : R.rs, STAGE[stage]]));
    dev.queue.writeBuffer(s.params, 0, paramData(P, n.params));
    dev.queue.writeBuffer(s.obj, 0, objData(n));
    // what it reads: the picture so far and its blurred levels; a surface pass, the surfaces so far too
    enc.copyTextureToTexture({ texture: target }, { texture: F.input }, [R.pw, R.ph]);
    drawLevels(dev, enc, F.levels, 'rgba16float', true);
    if (surf) for (const [a, b] of [[R.tex.position, F.pos], [R.tex.normal, F.nrm], [R.tex.depth, F.depth]]) enc.copyTextureToTexture({ texture: a }, { texture: b }, [R.pw, R.ph]);
    const texBG = pictures(R, P);
    const r = enc.beginRenderPass(surf
      ? { label: P.label, colorAttachments: [load(target), load(R.tex.position), load(R.tex.normal)], depthStencilAttachment: { view: R.tex.depth.createView(), depthLoadOp: 'load', depthStoreOp: 'store' } }
      : { label: P.label, colorAttachments: [load(out ? out.tex : target)] });
    r.setPipeline(pipes[i]); r.setBindGroup(0, R.frameBG); r.setBindGroup(1, R.sceneBG); r.setBindGroup(2, s.bg[surf ? 'surface' : 'plain']); if (texBG) r.setBindGroup(3, texBG); r.draw(3); r.end();
    if (P.once && !P.target) enc.copyTextureToTexture({ texture: target }, { texture: once(R, stage, i) }, [R.pw, R.ph]);
  });
}
// what a pass drawn once a frame made on the frame's first sub-frame (the i-th of its stage), kept for the rest
function once(R, stage, i) {
  return (R.film.onces[`${stage}:${i}`] ??= R.dev.createTexture({ size: [R.pw, R.ph], format: 'rgba16float', label: 'a pass drawn once a frame', usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST }));
}

/**
 * What a pass that picks (fn pick) has at frame point (x, y) in `scene` (its camera, unjittered; its lights): { t: how
 * far along the camera's ray, id }, or null where nothing of it is there.
 */
export async function pickPass(R, n, scene, x, y) {
  shared(R);
  const F = inputs(R), dev = R.dev, P = n.pass;
  P.pickPipes ??= {};
  const key = R.surfaceKey;
  if (!P.pickPipes[key]) {
    const mod = R.module(head(R, P) + '\n' + P.code + PICK, `pick ${P.label}`);
    P.pickPipes[key] = dev.createRenderPipelineAsync({ layout: R.pipelineLayout(groups(R, P)), vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] }, primitive: { topology: 'triangle-list' } });
  }
  const pickPipe = await P.pickPipes[key].catch((e) => { delete P.pickPipes[key]; throw e; });
  F.pick ??= dev.createTexture({ size: [R.pw, R.ph], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  F.pickBuf ??= dev.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  dev.queue.writeBuffer(R.camBuf, 0, cameraData(R, scene.camera, [0, 0], [0, 0], 0.5, 1, 0).data);
  dev.queue.writeBuffer(R.worldBuf, 0, worldData(scene, lightsOf(scene, R.shadowsAll), R.tables ?? { tlas: 0, items: 0, materials: 0, shapes: 0, layers: 0, emitters: 0, emitterCount: 0, traced: 0 }, { shadowRays: 0, keep: 0, reuse: 0, reflect: 0, gi: 0, ao: 0 }));
  const s = slot(R, 'pick', 0, P, n.data, false);
  dev.queue.writeBuffer(s.film, 0, new Float32Array([scene.t ?? 0, R.frameInfo.frame, R.frameInfo.fps, 0, R.fw, R.fh, R.rs, 0]));
  dev.queue.writeBuffer(s.params, 0, paramData(P, n.params));
  dev.queue.writeBuffer(s.obj, 0, objData(n));
  // (x, y: px of the film's frame, about whose centre the frame drawn now is)
  const px = [Math.max(0, Math.min(R.pw - 1, Math.floor((x + (R.fw - W) / 2) * R.rs))), Math.max(0, Math.min(R.ph - 1, Math.floor((y + (R.fh - H) / 2) * R.rs)))];
  const texBG = pictures(R, P), enc = dev.createCommandEncoder();
  const r = enc.beginRenderPass({ colorAttachments: [{ view: F.pick.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [-1, -1, 0, 0] }] });
  r.setScissorRect(px[0], px[1], 1, 1);
  r.setPipeline(pickPipe); r.setBindGroup(0, R.frameBG); r.setBindGroup(1, R.sceneBG); r.setBindGroup(2, s.bg.plain); if (texBG) r.setBindGroup(3, texBG); r.draw(3); r.end();
  enc.copyTextureToBuffer({ texture: F.pick, origin: [px[0], px[1]] }, { buffer: F.pickBuf, bytesPerRow: 256 }, [1, 1]);
  dev.queue.submit([enc.finish()]);
  await F.pickBuf.mapAsync(GPUMapMode.READ);
  const [t, id] = new Float32Array(F.pickBuf.getMappedRange().slice(0, 8));
  F.pickBuf.unmap();
  return t >= 0 ? { t, id: Math.round(id) } : null;
}
