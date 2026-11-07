// The WGSL every pass shares. One scene (the camera, the world: environment and lights, the scene's tables, the
// geometry, the texture store) in bind groups 0 and 1, and one way to shade a point: what a surface is there (surfaceAt:
// its material, its textures, its normal map, the film's surface code), the light falling on it (gather: every light,
// its shadows traced where asked; the environment), and what it sends toward the eye (shade: Blender's Principled BSDF
// as weights on that light). The camera's shader and every ray (reflections, GI, glass, shadows) call the same functions,
// so what a ray sees is what the camera would see there.
//
// World units are px: x right, y down, z toward the viewer. Light is linear (scene-referred) throughout: colours given
// as CSS are sRGB, made linear once, on the CPU.
import { SHEEN_LUT } from './sheen.js';
import { MATERIAL_WGSL } from './materials.js';
import { TEXTURES_WGSL } from './textures.js';

export const MAX_LIGHTS = 256;
export const MAX_GLOWS = 6;   // (a backdrop's soft glows)
// (the world uniform's floats: the environment, the backdrop and its glows, its light, the tables, tracing, the lights)
export const WORLD_FLOATS = 120 + MAX_LIGHTS * 16;
/** How the frame may be seen: its view transform's curves (viewCurve), by index. */
export const TRANSFORMS = ['neutral', 'agx', 'standard'];

export const FULLSCREEN_VS = /* wgsl */`
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO; o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(p.x, 1.0 - p.y); return o;
}`;

/** The camera and the world (group 0): every pass has them. */
export const COMMON = /* wgsl */`
const NEAR = 0.01;   // world px: the depth that maps to 1 (reversed depth: 1 near, 0 far)
const PI = 3.14159265;
const TAU = 6.2831853;
fn lin(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
fn srgb(c: vec3f) -> vec3f { let x = max(c, vec3f(0.0)); return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308)); }
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn hash3(p: vec3f) -> f32 { var q = fract(p * vec3f(0.1031, 0.1030, 0.0973)); q += dot(q, q.yxz + 33.33); return fract((q.x + q.y) * q.z); }
// the camera of this sub-frame: its eye and axes (it looks down -back), its lens (focal, px), where this sub-frame falls
// among the frame's (phase, 0–1) and its share of it (weight), a seed that differs per sub-frame, its offset (jitter,
// frame px), the frame's centre (px), the size drawn (px) and drawn px per frame px
struct Camera { eye: vec3f, focal: f32, right: vec3f, phase: f32, down: vec3f, weight: f32, back: vec3f, seed: f32,
  jitter: vec2f, center: vec2f, drawn: vec2f, scale: f32, _c: f32 };
// one of the scene's lights: a point (a bulb), a spot (a torch) or a sun (light from one way, as from far off). pos and
// radius (px: how large, so how soft its shadows and highlights); color (its colour × intensity, linear); kind (0 point, 1
// spot, 2 sun); dir (the way a spot or a sun shines); a spot's cone (the cosines of its edge and of where it is full);
// shadows (1: traced); reach (squared, px: past it, nothing); size (a sun's angular radius, radians)
struct Light { pos: vec3f, radius: f32, color: vec3f, kind: f32, dir: vec3f, cosOuter: f32, cosInner: f32, shadows: f32, reach2: f32, size: f32 };
// where each table starts in the scene's (scn, vec4s), and how many emitters; traced: whether anything is traced
struct Tables { tlas: i32, items: i32, materials: i32, shapes: i32, layers: i32, emitters: i32, emitterCount: i32, traced: i32 };
// what is traced and how: the shadow rays a frame where they are denoised (0: not), whether the opaque pass keeps what
// the denoiser reads, whether reflections are denoised, whether reflections are traced, global illumination, ambient
// occlusion
struct Tracing { shadowRays: f32, keep: f32, reuse: f32, reflect: f32, gi: f32, ao: f32, _a: f32, _b: f32 };
// the environment: its colour up (zenith), level with the eye (horizon) and down (nadir), × intensity; what the camera
// sees where nothing is (backdrop, as seen: sRGB, w 1; else the environment) and the soft glows on it (each its centre,
// frame px, and radius; its colour, as seen); how the frame is seen (view: its exposure, its curve: TRANSFORMS's
// index); the environment's light on a surface facing each way (irradiance / π as L2 spherical harmonics); the lights
struct World { zenith: vec3f, intensity: f32, horizon: vec3f, lightCount: f32, nadir: vec3f, glowCount: f32, backdrop: vec4f,
  view: vec4f, glows: array<vec4f, ${MAX_GLOWS * 2}>, sh: array<vec4f, 9>, tables: Tables, tracing: Tracing, lights: array<Light, ${MAX_LIGHTS}> };
@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var<uniform> world: World;
// a world point → clip space: x, y by the perspective (and the sub-frame's offset), depth reversed (NEAR / depth)
fn project(p: vec3f) -> vec4f {
  let d = p - cam.eye;
  let z = -dot(d, cam.back);
  return vec4f((dot(d, cam.right) * cam.focal + cam.jitter.x * z) / cam.center.x, -(dot(d, cam.down) * cam.focal + cam.jitter.y * z) / cam.center.y, NEAR, z);
}
fn viewZ(p: vec3f) -> f32 { return -dot(p - cam.eye, cam.back); }
fn lightCount() -> i32 { return i32(world.lightCount); }
// where a world point is on the frame (0–1)
fn toUV(p: vec3f) -> vec2f { let c = project(p); return vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5); }
// the camera's ray through frame px (unit)
fn viewDir(px: vec2f) -> vec3f { let q = px - cam.center - cam.jitter; return normalize(cam.right * q.x + cam.down * q.y - cam.back * cam.focal); }
// how many rays a sub-frame sends of n, sized for a frame of 8 sub-frames: fewer when the frame has more (depth of
// field's 32, a whip's blur), so it sends as many in all as 8 would (the sub-frames average them all the same)
fn budget(n: i32) -> i32 { return max(1, i32(round(f32(n) * min(1.0, 8.0 * cam.weight)))); }
// the environment seen along R (unit), sharp
fn skyAt(R: vec3f) -> vec3f {
  let e = -R.y;
  return select(mix(world.horizon, world.nadir, pow(clamp(-e, 0.0, 1.0), 0.6)), mix(world.horizon, world.zenith, pow(clamp(e, 0.0, 1.0), 0.6)), e > 0.0) * world.intensity;
}
// the environment's light falling on a surface facing N, as a matte white surface shows it (irradiance / π)
fn irradiance(N: vec3f) -> vec3f {
  let s = world.sh;
  return max(s[0].rgb + s[1].rgb * N.y + s[2].rgb * N.z + s[3].rgb * N.x + s[4].rgb * (N.x * N.y) + s[5].rgb * (N.y * N.z)
    + s[6].rgb * (3.0 * N.z * N.z - 1.0) + s[7].rgb * (N.x * N.z) + s[8].rgb * (N.x * N.x - N.y * N.y), vec3f(0.0));
}
// the environment seen along R in a surface whose roughness spreads it (spread, 0 sharp: about roughness × 0.7)
fn environment(R: vec3f, spread: f32) -> vec3f { return mix(skyAt(R), irradiance(R), clamp(spread * 1.5, 0.0, 1.0)); }
// What the camera sees along D where it meets nothing: the environment, or the backdrop. A backdrop is a colour as seen
// (a studio's black, a brand colour: picked as the display shows it), its glows each a bell round its centre on the
// frame, added as a page paints them (in sRGB); it is then the light that the frame's view shows as exactly that, so
// it comes out as picked whatever the view transform, and is light for what goes over it (glows, fog, glass).
fn backdrop(D: vec3f) -> vec3f {
  if (world.backdrop.w < 0.5) { return skyAt(D); }
  var c = world.backdrop.rgb;
  let px = cam.center + cam.jitter + vec2f(dot(D, cam.right), dot(D, cam.down)) * cam.focal / max(-dot(D, cam.back), 1e-4);
  for (var i = 0; i < i32(world.glowCount); i++) {
    let g = world.glows[i * 2];
    let d = length(px - g.xy) / max(g.z, 1.0);
    c += world.glows[i * 2 + 1].rgb * exp(-d * d * 2.2);
  }
  return viewInverse(lin(c), world.view.y) / world.view.x;
}
// The view transforms' tone curves (TRANSFORMS): light (at the frame's exposure) as the display shows it, 0–1, linear.
//   agx       Blender's AgX (Sobotka; the polynomial fit by Wrensch 2023; the default): light of every colour rolls off
//             toward white as film does, and more light never shows darker in any channel, so coloured lights mix as
//             they should (a shadow under a blue spot in warm light shows the warm light, darker than the lit floor)
//   neutral   Khronos PBR Neutral: base colours under white light come out as authored and only highlights compress;
//             but it takes from every channel what its dimmest one rises by, so adding light of one colour darkens the
//             others (warm light with a little blue added shows darker than warm alone): for product shots in white light
//   standard  none: light past 1 clips
fn viewNeutral(c: vec3f) -> vec3f {
  let x = min(c.r, min(c.g, c.b));
  let off = select(0.04, x - 6.25 * x * x, x < 0.08);
  var col = c - off;
  let peak = max(col.r, max(col.g, col.b));
  if (peak < 0.76) { return col; }
  let np = 1.0 - 0.0576 / (peak - 0.52);
  col *= np / peak;
  return mix(col, vec3f(np), 1.0 - 1.0 / (0.15 * (peak - np) + 1.0));
}
const AGX_IN = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336,
  0.0792237451477643, 0.0791661274605434, 0.879142973793104);
const AGX_OUT = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
  -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
const AGX_LO = -12.47393;
const AGX_HI = 4.026069;
fn agxSigmoid(x: vec3f) -> vec3f { let x2 = x * x; let x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
fn viewAgx(c: vec3f) -> vec3f {
  let x = (clamp(log2(max(AGX_IN * c, vec3f(1e-10))), vec3f(AGX_LO), vec3f(AGX_HI)) - AGX_LO) / (AGX_HI - AGX_LO);
  return pow(max(AGX_OUT * agxSigmoid(x), vec3f(0.0)), vec3f(2.2));
}
fn viewCurve(c: vec3f, transform: f32) -> vec3f {
  if (transform < 0.5) { return viewNeutral(c); }
  if (transform < 1.5) { return viewAgx(c); }
  return clamp(c, vec3f(0.0), vec3f(1.0));
}
// The light a curve shows as y (0–1, linear; the brightest are taken as 0.998, which neutral and agx reach only far up):
// each curve undone step by step, exactly (agx's polynomial by Newton's method, a channel at a time: it is monotonic)
fn viewInverse(y0: vec3f, transform: f32) -> vec3f {
  let y = clamp(y0, vec3f(0.0), vec3f(0.998));
  if (transform > 1.5) { return y; }
  if (transform > 0.5) {
    let s = clamp(AGX_IN * pow(y, vec3f(1.0 / 2.2)), vec3f(0.0), vec3f(1.0));   // (AGX_IN undoes AGX_OUT, and AGX_OUT AGX_IN)
    var x = vec3f(0.5);
    for (var i = 0; i < 12; i++) {
      let x2 = x * x; let x4 = x2 * x2;
      let d = 93.0 * x4 * x - 200.7 * x4 + 127.84 * x2 * x - 20.604 * x2 + 0.8596 * x + 0.1191;
      x = clamp(x - (agxSigmoid(x) - s) / max(d, vec3f(1e-4)), vec3f(0.0), vec3f(1.0));
    }
    return max(AGX_OUT * exp2(x * (AGX_HI - AGX_LO) + AGX_LO), vec3f(0.0));
  }
  // neutral: the highlights' compression (its peak np gives the peak before it, and how far it was greyed), then the offset
  var col = y;
  let np = max(y.r, max(y.g, y.b));
  if (np >= 0.76) {
    let peak = 0.0576 / (1.0 - np) + 0.52;
    let g = 1.0 - 1.0 / (0.15 * (peak - np) + 1.0);
    col = (y - vec3f(np * g)) / (1.0 - g) * peak / np;
  }
  let m = min(col.r, min(col.g, col.b));
  let x = select(m + 0.04, sqrt(max(m, 0.0) / 6.25), m < 0.04);
  return col + (x - m);
}`;

/** The scene (group 1): its tables, every copy, the geometry, the films' surfaces' params, the texture store. */
export const SCENE = (surfaces) => /* wgsl */`
@group(1) @binding(0) var<storage, read> scn: array<vec4f>;
@group(1) @binding(1) var<storage, read> insts: array<vec4f>;
@group(1) @binding(2) var<storage, read> geo: array<vec4u>;
@group(1) @binding(3) var<storage, read> sp: array<vec4f>;
${TEXTURES_WGSL(1, 4)}
${MATERIAL_WGSL}
${surfaces}
// the copy a point is on: its model matrix columns (translation in w) and the rows of its inverse; its colour
var<private> I: array<vec4f, 6>;
fn useCopy(i: i32) { let b = i * 7; I = array<vec4f, 6>(insts[b], insts[b + 1], insts[b + 2], insts[b + 3], insts[b + 4], insts[b + 5]); }
fn tintOf(i: i32) -> vec3f { return insts[i * 7 + 6].rgb; }
fn objV(v: vec3f) -> vec3f { return vec3f(dot(I[3].xyz, v), dot(I[4].xyz, v), dot(I[5].xyz, v)); }
fn objP(p: vec3f) -> vec3f { return objV(p - vec3f(I[0].w, I[1].w, I[2].w)); }
fn worldP(p: vec3f) -> vec3f { return I[0].xyz * p.x + I[1].xyz * p.y + I[2].xyz * p.z + vec3f(I[0].w, I[1].w, I[2].w); }
fn worldV(v: vec3f) -> vec3f { return I[0].xyz * v.x + I[1].xyz * v.y + I[2].xyz * v.z; }
fn worldN(n: vec3f) -> vec3f { return normalize(I[3].xyz * n.x + I[4].xyz * n.y + I[5].xyz * n.z); }
// a mesh node's shape: its triangles (their hierarchy's root and their indices in geo, its vertices) or its solid form
// (a box with rounded edges, a sphere: half extents, edge radius), which rays meet exactly
struct Shape { solid: bool, root: i32, tris: i32, verts: i32, S: vec4f };
fn shapeOf(node: i32) -> Shape {
  let a = scn[world.tables.shapes + node * 2];
  return Shape(a.x > 0.5, i32(a.y), i32(a.z), i32(a.w), scn[world.tables.shapes + node * 2 + 1]);
}
fn geoAt(i: i32) -> vec4f { return bitcast<vec4f>(geo[i]); }
fn triVertex(tris: i32, k: i32) -> i32 { return i32(geo[(tris + k) / 4][(tris + k) % 4]); }`;

/** Blender's Principled BSDF as weights on the light falling on a surface, and what a light gives each kind of response. */
export const BSDF = /* wgsl */`
// the light falling on a surface by how it responds: diffusely, as highlights at its roughness (spec) and its coat's, and
// as sheen
struct Terms { diff: vec3f, spec: vec3f, coat: vec3f, sheen: vec3f };
fn noTerms() -> Terms { return Terms(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0)); }
fn plus(a: Terms, b: Terms) -> Terms { return Terms(a.diff + b.diff, a.spec + b.spec, a.coat + b.coat, a.sheen + b.sheen); }
fn scaled(t: Terms, k: vec3f) -> Terms { return Terms(t.diff * k, t.spec * k, t.coat * k, t.sheen * k); }
// what is left of a once b has taken from it (never below none)
fn termsLeft(a: Terms, b: Terms) -> Terms { let z = vec3f(0.0); return Terms(max(a.diff - b.diff, z), max(a.spec - b.spec, z), max(a.coat - b.coat, z), max(a.sheen - b.sheen, z)); }
fn weigh(w: Terms, t: Terms) -> vec3f { return w.diff * t.diff + w.spec * t.spec + w.coat * t.coat + w.sheen * t.sheen; }
fn iorF0(ior: f32) -> f32 { let q = (ior - 1.0) / (ior + 1.0); return q * q; }
// a table of the scene's at at (scene.js): 32 rows by roughness and 32 columns by the cosine of the view angle, each 0 to 1,
// read bilinearly, with its ends at 0 and 1, as Cycles' lookup_table_read_2D reads its own
fn tableAt(at: u32, c: f32, r: f32) -> vec4f {
  let x = clamp(c, 0.0, 1.0) * 31.0;
  let y = clamp(r, 0.0, 1.0) * 31.0;
  let i = min(u32(x), 31u); let j = min(u32(y), 31u);
  let i1 = min(i + 1u, 31u); let j1 = min(j + 1u, 31u);
  let fx = x - f32(i); let fy = y - f32(j);
  return mix(mix(scn[at + j * 32u + i], scn[at + j * 32u + i1], fx), mix(scn[at + j1 * 32u + i], scn[at + j1 * 32u + i1], fx), fy);
}
// how much of the light around it a surface of roughness r reflects seen at this cosine, as F0 · x + F90 · y, over the
// hemisphere (z, E_avg), and a dielectric's y (w; its x is x + y - w): ggx.js
fn ggxAt(r: f32, NoV: f32) -> vec4f { return tableAt(${SHEEN_LUT.length / 4}u, NoV, r); }
// what light scattering more than once among a surface's microfacets adds to what it reflects (t: ggxAt; Fss: its Fresnel
// over the hemisphere), as a factor: Cycles' albedo scaling since Blender 4.0 (bsdf_microfacet.h, microfacet_ggx_preserve_energy:
// Fms from the appendix of Kulla and Conty 2017), so that a white metal in a white world shows white at any roughness
fn ggxE(r: f32, NoV: f32) -> f32 { let t = ggxAt(r, NoV); return max(t.x + t.y, 1e-3); }
fn scatteredMore(Fss: vec3f, t: vec4f) -> vec3f {
  let E = max(t.x + t.y, 1e-3);
  return 1.0 + Fss * t.z / (1.0 - Fss * (1.0 - t.z)) * (1.0 - E) / E;
}
// GGX (Heitz 2018, "Sampling the GGX Distribution of Visible Normals", Eqs. 1 and 2; a: alpha, the roughness squared):
// the distribution of normals, Smith's Lambda, and the height-correlated visibility G2 / (4 N.L N.V) (Heitz 2014, Eq. 99)
fn ggxD(NoH: f32, a: f32) -> f32 { let a2 = a * a; let d = (a2 - 1.0) * NoH * NoH + 1.0; return a2 / (PI * d * d); }
fn ggxLambda(NoX: f32, a: f32) -> f32 { let c2 = max(NoX * NoX, 1e-8); return 0.5 * (-1.0 + sqrt(1.0 + a * a * (1.0 - c2) / c2)); }
fn ggxVis(NoL: f32, NoV: f32, a: f32) -> f32 { return 1.0 / (4.0 * max(NoL * NoV, 1e-6) * (1.0 + ggxLambda(NoL, a) + ggxLambda(NoV, a))); }
// how likely GGX's visible normals (Heitz 2018, Eqs. 3 and 17) send a viewer at V's reflection along D: G1(V) D(H) / (4 N.V)
fn ggxPdf(N: vec3f, V: vec3f, D: vec3f, a: f32, NoV: f32) -> f32 { return ggxD(max(dot(N, normalize(V + D)), 0.0), a) / (4.0 * NoV * (1.0 + ggxLambda(NoV, a))); }
// and of a surface's two lobes, its own (alpha aS) and its coat's (aC), the coat's drawn a qc share of the time
fn lobePdf(N: vec3f, V: vec3f, D: vec3f, aS: f32, aC: f32, qc: f32, NoV: f32) -> f32 { return (1.0 - qc) * ggxPdf(N, V, D, aS, NoV) + qc * ggxPdf(N, V, D, aC, NoV); }
// GGX's distribution of normals (alpha a) as a light of angular radius moves the half vector over a disc of radius rho in
// slope space. GGX there is (1/π) a² / (a² + s²)², which is the form factor's kernel from a point to a plane a above it, so
// its average over a disc is that of a parallel disc (Howell's catalogue) over the disc's area: no widening of a (ours: a
// wider lobe puts too much in its long tails, rough 0.1 under a sun 6° across 11 times Cycles' away from the highlight
// and 0.6 in it). Without a light's size, rho 0, it is ggxD. The two forms keep it exact either side of the disc's edge.
fn ggxDisc(NoH: f32, a: f32, rho: f32) -> f32 {
  let c2 = max(NoH * NoH, 1e-6);
  let s2 = (1.0 - c2) / c2;
  let a2 = a * a; let p2 = rho * rho;
  let A = a2 + s2;
  let Q = sqrt(max((A + p2) * (A + p2) - 4.0 * s2 * p2, 1e-30));
  return select((Q - A + p2) / (2.0 * Q * p2), 2.0 * a2 / (Q * (Q + A - p2)), A >= p2) / (PI * c2 * c2);
}
// a light's GGX highlight on a surface of roughness r (light colour c, irradiance / π; size its angular radius, which moves
// the half vector half as far, and further across the plane of the light and the eye: their mean), as the split sum weighs
// it: with F = 1, over E, that surface's reflectance of the light around it (ggxE)
fn highlight(c: vec3f, N: vec3f, V: vec3f, L: vec3f, NoL: f32, NoV: f32, r: f32, size: f32, E: f32) -> vec3f {
  let a = max(r * r, 1e-3);
  let H = normalize(L + V);
  let rho = size * 0.5 / sqrt(max(dot(V, H), 1e-3));
  return c * PI * ggxDisc(max(dot(N, H), 0.0), a, rho) * ggxVis(NoL, NoV, a) * NoL / E;
}
// Sheen: the microfiber sheen of Zeltner, Burley and Chiang 2022 ("Practical Multiple-Scattering Sheen Using
// Linearly Transformed Cosines"), as Blender's Principled BSDF has it since 4.0 (Cycles' bsdf_sheen.h): a linearly
// transformed cosine whose coefficients (aInv, bInv) and directional albedo come from its table by the view's cosine and
// the sheen's roughness (sheen.js: the scene's tables start with it). sheenAt: (aInv, bInv, albedo), bilinearly with the
// table's ends at 0 and 1 as Cycles' lookup_table_read_2D reads it, roughness at least 0.001; none (0) where Cycles drops
// the sheen (aInv or albedo under 1e-5)
fn sheenAt(c: f32, r: f32) -> vec3f {
  let v = tableAt(0u, c, max(r, 1e-3)).xyz;
  return select(vec3f(0.0), v, abs(v.x) >= 1e-5 && v.z >= 1e-5);
}
// how much of the light around it a sheen of roughness r reflects, seen at cos c (its directional albedo)
fn sheenAlbedo(c: f32, r: f32) -> f32 { return sheenAt(c, r).z; }
// its lobe toward L, with its cosine (bsdf_sheen_eval: integrates to 1 over the hemisphere; the albedo scales it), in
// the frame whose x is the eye's way along the surface (head-on, bInv is 0 and any frame will do)
fn sheenLobe(sh: vec3f, N: vec3f, V: vec3f, L: vec3f) -> f32 {
  var X = V - N * dot(N, V);
  let l = dot(X, X);
  X = select(normalize(cross(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(N.y) > 0.9), N)), X * inverseSqrt(max(l, 1e-20)), l > 1e-12);
  let w = vec3f(dot(L, X), dot(L, cross(N, X)), dot(L, N));
  let o = vec3f(sh.x * w.x + sh.y * w.z, sh.x * w.y, w.z);
  let q = sh.x / dot(o, o);
  return max(w.z, 0.0) / PI * q * q;
}
// a light's share of a surface's light (colour c from L, irradiance / π, of angular radius size), by kind of response
fn termsOf(c: vec3f, L: vec3f, size: f32, N: vec3f, V: vec3f, rough: f32, coatRough: f32, sheenRough: f32) -> Terms {
  let NoV = clamp(dot(N, V), 1e-3, 1.0);
  return termsWith(c, L, size, N, V, rough, coatRough, sheenAt(NoV, sheenRough), vec2f(ggxE(rough, NoV), ggxE(coatRough, NoV)));
}
// the same, the tables' values found already: the sheen's (sheenAt; 0: no sheen there) and the surface's and its coat's
// reflectance (E: ggxE), which a point lit by many lights, or by many rays to one, finds once
fn termsWith(c: vec3f, L: vec3f, size: f32, N: vec3f, V: vec3f, rough: f32, coatRough: f32, sh: vec3f, E: vec2f) -> Terms {
  let NoL = dot(N, L);
  if (NoL <= 0.0) { return noTerms(); }
  let NoV = clamp(dot(N, V), 1e-3, 1.0);
  return Terms(c * NoL, highlight(c, N, V, L, NoL, NoV, rough, size, E.x), highlight(c, N, V, L, NoL, NoV, coatRough, size, E.y),
    c * PI * sh.z * select(0.0, sheenLobe(sh, N, V, L), sh.z > 0.0));
}
// thin-film interference (Belcour and Barla 2017, as glTF's iridescence evaluates it): what a film nm thick, of index
// eta, over a base of reflectance F0 reflects, seen at cos c; its colours from the eye's sensitivity in Fourier space
fn sensitivity(opd: f32, shift: vec3f) -> vec3f {
  let phase = TAU * opd * 1e-9;
  let vr = vec3f(4.3278e9, 9.3046e9, 6.6121e9);
  var xyz = vec3f(5.4856e-13, 4.4201e-13, 5.2481e-13) * sqrt(TAU * vr) * cos(vec3f(1.6810e6, 1.7953e6, 2.2084e6) * phase + shift) * exp(-phase * phase * vr);
  xyz.x += 9.7470e-14 * sqrt(TAU * 4.5282e9) * cos(2.2399e6 * phase + shift.x) * exp(-4.5282e9 * phase * phase);
  return mat3x3f(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252) * (xyz / 1.0685e-7);
}
fn thinFilm(c: f32, nm: f32, eta: f32, F0: vec3f) -> vec3f {
  let s2 = (1.0 - c * c) / (eta * eta);
  if (s2 >= 1.0) { return vec3f(1.0); }
  let c2 = sqrt(1.0 - s2);
  let R12 = iorF0(eta) + (1.0 - iorF0(eta)) * pow(1.0 - c, 5.0);
  let T121 = 1.0 - R12;
  let phi21 = PI - select(0.0, PI, eta < 1.0);
  let sF0 = sqrt(clamp(F0, vec3f(0.0), vec3f(0.9999)));
  let n3 = (1.0 + sF0) / (1.0 - sF0);
  let q = (n3 - eta) / (n3 + eta);
  let R23 = q * q + (1.0 - q * q) * pow(1.0 - c2, 5.0);
  let phi = phi21 + select(vec3f(0.0), vec3f(PI), n3 < vec3f(eta));
  let opd = 2.0 * eta * nm * c2;
  let R123 = clamp(R12 * R23, vec3f(1e-5), vec3f(0.9999));
  let Rs = T121 * T121 * R23 / (1.0 - R123);
  var I = R12 + Rs;
  var Cm = Rs - T121;
  for (var k = 1; k <= 2; k++) { Cm *= sqrt(R123); I += Cm * 2.0 * sensitivity(f32(k) * opd, f32(k) * phi); }
  return max(I, vec3f(0.0));
}
// a reflectance seen at cos c as the head-on one that gives it there (to weight the light around it, as F0 is)
fn asF0(F: vec3f, c: f32) -> vec3f { let x = pow(1.0 - c, 5.0); return clamp((F - x) / max(1.0 - x, 1e-3), vec3f(0.0), vec3f(1.0)); }
// How much of each kind of light falling on it a surface shows (w), how much of what is behind it comes through
// (trans: transmission's share) and what it shows of its own (glow: emission, its rim, iridescence's sheen). Blender's
// layering: a sheen over a coat over the base, which is a metal (its reflection coloured by it, its edges by the specular
// tint) or a dielectric (its reflection by its ior, specular level and tint, through a thin film if it has one; the rest
// diffuse, or through it as transmission, tinted by its colour). at: where on it this is, for iridescence's bands.
// Iridescence (Ephemeris's, stylized): a dichroic film whose colours slide with the angle and sweep across the faces in
// bands; its reflection takes them, and what comes through their complement.
struct Weights { w: Terms, trans: vec3f, glow: vec3f };
fn weightsOf(M: Material, base: vec3f, N: vec3f, V: vec3f, at: vec3f) -> Weights {
  let rough = clamp(M.rough, 0.02, 1.0);
  let coatRough = clamp(M.coatRough, 0.02, 1.0);
  let NoV = clamp(dot(N, V), 1e-3, 1.0);   // (past 1 by rounding, pow(1 - NoV, k) would be NaN, which bloom spreads into a block)
  let ab = ggxAt(rough, NoV);
  var F0d = min(vec3f(iorF0(M.ior) * 2.0 * M.specLevel), vec3f(1.0)) * M.specTint;
  var F0m = base;
  if (M.filmThickness > 0.0) {
    if (M.metal < 1.0) { F0d = asF0(thinFilm(NoV, M.filmThickness, M.filmIor, F0d), NoV); }
    if (M.metal > 0.0) { F0m = asF0(thinFilm(NoV, M.filmThickness, M.filmIor, F0m), NoV); }
  }
  // (what it reflects at grazing angles fades out below 2% head-on, none at none: as Unreal has Karis's fit, "anything
  // less than 2% is physically impossible and is instead considered to be shadowing"; specularIorLevel 0 reflects nothing)
  let F90d = clamp(50.0 * F0d, vec3f(0.0), vec3f(1.0));
  // (and what scatters more than once; Schlick's Fresnel over the hemisphere is F0 · 20/21 + F90 / 21)
  let Wd = (F0d * (ab.x + ab.y - ab.w) + ab.w * F90d) * scatteredMore((F0d * 20.0 + F90d) / 21.0, ab);
  let Wm = (F0m * ab.x + ab.y * M.specTint) * scatteredMore((F0m * 20.0 + M.specTint) / 21.0, ab);
  var film = vec3f(0.0);
  if (M.iridescence > 0.0) { film = 0.5 + 0.5 * cos(TAU * (vec3f(0.0, 0.33, 0.67) + (1.0 - NoV) * 1.6 + dot(N, vec3f(0.31, 0.17, 0.11)) + dot(at, vec3f(0.23, 0.31, 0.17)))); }
  let dichroic = M.iridescence * 0.32 * film;
  var w = Terms((1.0 - M.metal) * (1.0 - Wd) * (1.0 - M.transmission) * base,
    mix(vec3f(1.0), film * 1.6, M.iridescence) * mix(Wd, Wm, M.metal) + dichroic, vec3f(0.0), vec3f(0.0));
  var trans = (1.0 - M.metal) * M.transmission * (1.0 - Wd) * (1.0 - dichroic) * base;
  var glow = film * M.iridescence * 0.06 * pow(1.0 - NoV, 2.0);
  if (M.coat > 0.0) {
    let abc = ggxAt(coatRough, NoV);
    let Wc = M.coat * (iorF0(M.coatIor) * (abc.x + abc.y - abc.w) + abc.w);
    // what is below is seen through the coat, tinted the more the longer its path through it
    let cosT = sqrt(max(1.0 - (1.0 - NoV * NoV) / (M.coatIor * M.coatIor), 0.0));
    let below = (1.0 - Wc) * mix(vec3f(1.0), pow(M.coatTint, vec3f(1.0 / max(cosT, 0.05))), M.coat);
    w.diff *= below; w.spec *= below; glow *= below; trans *= below;
    w.coat = vec3f(Wc);
  }
  // the sheen, over everything (Cycles' closure.h, its first layer): what is below shows as much less as the sheen
  // reflects of the light around it, by its brightest colour (it does not tint what is below: closure_layering_weight)
  if (M.sheen > 0.0) {
    let E = min(M.sheen * max(M.sheenTint.r, max(M.sheenTint.g, M.sheenTint.b)) * sheenAlbedo(NoV, M.sheenRough), 1.0);
    w.diff *= 1.0 - E; w.spec *= 1.0 - E; w.coat *= 1.0 - E; glow *= 1.0 - E; trans *= 1.0 - E;
    w.sheen = M.sheen * M.sheenTint;
  }
  return Weights(w, trans, glow + M.emit + M.rim * pow(1.0 - NoV, M.rimPower));
}`;

/** Lights: each light where a point is, and their light on it, their shadows traced where asked. */
export const LIGHTING = /* wgsl */`
// light i at X: its colour there (a point or spot as bright as its colour 1000 px away, falling off with distance squared,
// no nearer than its radius, fading out at its reach; a spot's within its cone, softly at its edge; a sun's the same
// everywhere), the way to it, its angular radius from here, how far it is, and whether its shadows are traced
struct Here { c: vec3f, L: vec3f, size: f32, dist: f32, shadowed: bool };
fn lightHere(i: i32, X: vec3f) -> Here {
  let l = world.lights[i];
  if (l.kind > 1.5) { return Here(l.color, -l.dir, l.size, 1e6, l.shadows > 0.5); }
  let toL = l.pos - X;
  let r2 = dot(toL, toL);
  if (r2 >= l.reach2) { return Here(vec3f(0.0), vec3f(0.0, -1.0, 0.0), 0.0, 0.0, false); }
  let d2 = max(r2, l.radius * l.radius + 1.0);
  let L = toL * inverseSqrt(max(r2, 1e-6));
  let x = r2 / l.reach2;
  let fade = clamp(1.0 - x * x, 0.0, 1.0);
  var c = l.color * (1.0e6 / d2) * fade * fade;
  if (l.kind > 0.5) { c *= smoothstep(l.cosOuter, l.cosInner, dot(-L, l.dir)); }
  return Here(c, L, l.radius * inverseSqrt(d2), sqrt(r2), l.shadows > 0.5);
}
// a light's light (t) as a surface showing W of each kind of light shows it: its diffuse light and sheen, and its
// highlights and the coat's
fn diffuseShown(W: Terms, t: Terms) -> vec3f { return W.diff * t.diff + W.sheen * t.sheen; }
fn highlightShown(W: Terms, t: Terms) -> vec3f { return W.spec * t.spec + W.coat * t.coat; }
// how much of U the rays found S of, each colour (1 where there is none of it to scale: a light that lights a point sends
// its rays over the surface, inConeOver, so its rays find its light)
fn shareThrough(S: vec3f, U: vec3f) -> vec3f { return select(clamp(S / max(U, vec3f(1e-12)), vec3f(0.0), vec3f(1.0)), vec3f(1.0), U <= vec3f(1e-12)); }
// The scene's lights on a surface at X (normal N, seen from V, showing W of each kind of light falling on it): every light
// in reach as it lights it (exactly, and cheaply), and, for those whose shadows are traced (shadows), how much of each
// gets through what is in the way: of the light's rays, the share of what they bring that gets through, each colour
// (glass on the way tints it) — Heitz, Hill and McGuire 2018's illumination-weighted shadow (W, Eq. 14) for that light,
// so the light keeps its look and is hidden as the rays find it (their §3.4). Diffuse light (with sheen) and highlights
// (with the coat's) each take their own rays, shared among the shadowed lights by how much each gives this point of that
// kind of light as the surface shows it (stratified over their sum: a bright one gets most, and as many lights as a scene
// has cost the same rays as one; many-light renderers choose lights by their share of the light and keep diffuse light
// and highlights apart: Costa and Narkowicz 2025, MegaLights), so where one light's highlight is most of a glossy point's
// light, the rest of the lights' diffuse light still has rays of its own (where only one light here has shadows, what the
// shadows pass found for it serves both: Heitz, Hill and McGuire keep one W for a light's matte and glossy light together,
// their §6 leaving them apart to future work). Each kind's light is then U × S_N / U_N over
// the lights that took rays, each counted for its light over its share (their ratio estimator, Eq. 15): never more than
// the light there is, nothing where every ray is stopped, and exact, with no noise, where none is. rays: how many each
// kind takes a sub-frame (0: as the frame's budget says). pre: the diffuse light's rays' estimate, where the shadows pass
// found it for this point (diffuseThrough), else notFound() and its rays are taken here.
// lit: the light here, its shadows taken; for the denoiser, the shadowed lights' diffuse light as the surface shows it, as
// if nothing were in the way (U) and as the rays found it (U_N, and S_N through what is in the way), in the same units
struct Gathered { lit: Terms, U: vec3f, UN: vec3f, SN: vec3f };
fn gather(X: vec3f, N: vec3f, V: vec3f, rough: f32, coatRough: f32, sheenRough: f32, W: Terms, frag: vec2f, shadows: bool, rays: i32, pre: Through) -> Gathered {
  var T = noTerms();   // lights without traced shadows
  var S = noTerms();   // lights with them, unshadowed
  var Gd = 0.0;   // their diffuse light as the surface shows it (luminance), and their highlights
  var Gs = 0.0;
  var nS = 0;   // how many of them
  let n = i32(world.lightCount);
  // (its sheen's table values, once for all its lights' rays, where it has a sheen)
  var sh = vec3f(0.0);
  if (max(W.sheen.r, max(W.sheen.g, W.sheen.b)) > 0.0) { sh = sheenAt(clamp(dot(N, V), 1e-3, 1.0), sheenRough); }
  // (and its reflectance, and its coat's where it has one)
  var Es = vec2f(ggxE(rough, clamp(dot(N, V), 1e-3, 1.0)), 1.0);
  if (max(W.coat.r, max(W.coat.g, W.coat.b)) > 0.0) { Es.y = ggxE(coatRough, clamp(dot(N, V), 1e-3, 1.0)); }
  for (var i = 0; i < n; i++) {
    let o = lightHere(i, X);
    if (max(o.c.r, max(o.c.g, o.c.b)) < 1e-5) { continue; }
    let t = termsWith(o.c, o.L, o.size, N, V, rough, coatRough, sh, Es);
    if (shadows && o.shadowed && world.tables.traced > 0) { S = plus(S, t); Gd += luma(diffuseShown(W, t)); Gs += luma(highlightShown(W, t)); nS++; } else { T = plus(T, t); }
  }
  if (Gd + Gs <= 0.0) { return Gathered(plus(T, S), vec3f(0.0), vec3f(0.0), vec3f(0.0)); }
  let K = shadowRayCount(rays);
  let given = pre.found;
  // (what the shadows pass found: where only one light here has shadows, that light's, which its highlights' rays toward it share)
  let through = shareThrough(pre.S, pre.U);
  let oneLight = given && nS == 1;
  let Kd = select(0, K, Gd > 0.0 && !given);
  let Ks = select(0, K, Gs > 0.0);
  // (where each kind's points start, turned by the sub-frame's phase: a frame's points interleave, spread evenly over the sum)
  let xd = fract(hash3(vec3f(frag, 41.0)) + cam.phase);
  let xs = fract(hash3(vec3f(frag, 43.0)) + cam.phase);
  var Ud = vec3f(0.0); var Sd = vec3f(0.0);   // U_N and S_N of diffuse light (each light that took rays: its light over its share)
  var Us = vec3f(0.0); var Ss = vec3f(0.0);   // and highlights
  var Cd = 0.0; var Cs = 0.0;
  var kd = 0; var ks = 0;
  // (the highlights' lobes: their alphas, as termsOf's are for one way)
  let aS = max(rough * rough, 1e-3); let aC = max(coatRough * coatRough, 1e-3);
  let NoV = clamp(dot(N, V), 1e-3, 1.0);
  for (var i = 0; i < n && (kd < Kd || ks < Ks); i++) {
    let o = lightHere(i, X);
    if (!o.shadowed || max(o.c.r, max(o.c.g, o.c.b)) < 1e-5) { continue; }
    let t = termsWith(o.c, o.L, o.size, N, V, rough, coatRough, sh, Es);
    let gd = luma(diffuseShown(W, t));
    let gs = luma(highlightShown(W, t));
    Cd += gd; Cs += gs;
    // every one of each kind's points (spread evenly over its sum) that falls in this light's share: a ray to it
    var md = 0;
    loop { if (kd >= Kd || (f32(kd) + xd) / f32(Kd) * Gd >= Cd) { break; } kd++; md++; }
    var ms = 0;
    loop { if (ks >= Ks || (f32(ks) + xs) / f32(Ks) * Gs >= Cs) { break; } ks++; ms++; }
    if (md + ms == 0) { continue; }
    let C = lightCone(i, X);
    let qc = luma(W.coat * t.coat) / max(gs, 1e-20);
    var dw = vec3f(0.0); var dv = vec3f(0.0);   // the diffuse light's rays' weights, and their weights by what they found
    var sw = vec3f(0.0); var sv = vec3f(0.0);   // and the highlights'
    // (what the diffuse light's first ray found: the highlights' first ray toward the light shares it, see below; w 1
    // where it was traced)
    var seen = select(vec4f(0.0), vec4f(through, 1.0), oneLight);
    // (all its rays in one loop, the diffuse light's and then the highlights' pairs, for one call of shadowRay: see Lobe)
    for (var q = 0; q < md + 2 * ms; q++) {
      let diffuse = q < md;
      let r = select((q - md) / 2, q, diffuse);
      var D = vec3f(0.0);
      var w = vec3f(0.0);
      var reuse = false;
      if (diffuse) {
        // how much of this light gets through, weighed as the surface takes its light across the light (Heitz, Hill and
        // McGuire 2018's W, Eq. 14, for this light): diffuse light's rays toward the light, uniformly over the cone it
        // fills (any under the surface swapped: inConeOver), each weighed by what it brings (its light as if all of it came
        // that way: termsOf there)
        D = inConeOver(C, lightU(frag, i, f32(r), 17.0).xy, N);
        w = diffuseShown(W, termsWith(o.c, D, 0.0, N, V, rough, coatRough, sh, Es));
      } else {
        // highlights': each a pair, one toward the light so and one along the surface's own reflection (its lobe's visible
        // normals: the coat's or its own, by their shares of this light's highlight), counted where it meets the light, each
        // weighed by the balance heuristic over the two (Veach and Guibas 1995; as Heitz, Hill and McGuire's are, §4.3): on a
        // mirror the reflection's own ray finds what hides the light in it, where a ray to a point on the light would not.
        // The one toward the light is drawn as the diffuse light's are (uniformly over the cone it fills), so where this point
        // took diffuse rays too, the first pair's is the first diffuse ray, and shares what it found: each estimate is as
        // unbiased as with a ray of its own, one occluder hides both alike, and what a GI ray, a reflection or glass meets
        // (a ray of each kind) takes one shadow ray fewer toward a light both kinds of its light come from. The camera's own
        // points take their diffuse light's from the shadows pass, which keeps the share of its rays that got through, not
        // each ray's: where one light here has shadows, every ray toward it shares that (spring-brutalist's pool: these
        // rays were 167 of the opaque pass's 198 ms); where more do, it is theirs together, so they take their own.
        let u = lightU(frag, i, f32(r), 53.0);
        let k = (q - md) % 2;
        reuse = k == 0 && (oneLight || (r == 0 && md > 0));
        D = inConeOver(C, select(u.xy, lightU(frag, i, f32(r), 17.0).xy, reuse), N);
        if (k == 1) {
          D = reflect(-V, ggxVisible(V, N, select(aS, aC, u.z < qc), lightU(frag, i, f32(r), 71.0).xy));
          if (dot(D, C.w) < C.cosMax) { continue; }   // (past the light: none of its light that way)
        }
        if (dot(D, N) <= 0.0) { continue; }
        w = highlightShown(W, termsWith(o.c, D, 0.0, N, V, rough, coatRough, sh, Es)) / (1.0 + lobePdf(N, V, D, aS, aC, qc, NoV) * C.solid);
      }
      if (max(w.r, max(w.g, w.b)) <= 0.0) { continue; }
      var v = seen.xyz;
      if (!reuse || seen.w <= 0.5) { v = shadowRay(X, N, i, D); }
      if (diffuse) {
        if (r == 0) { seen = vec4f(v, 1.0); }
        dw += w; dv += w * v;
      } else {
        sw += w; sv += w * v;
      }
    }
    if (md > 0) { let a = diffuseShown(W, t) * (f32(md) / gd); Ud += a; Sd += a * shareThrough(dv, dw); }
    if (ms > 0) { let a = highlightShown(W, t) * (f32(ms) / gs); Us += a; Ss += a * shareThrough(sv, sw); }
  }
  let rd = select(shareThrough(Sd, Ud), through, given);
  let rs = shareThrough(Ss, Us);
  let lit = Terms(T.diff + S.diff * rd, T.spec + S.spec * rs, T.coat + S.coat * rs, T.sheen + S.sheen * rd);
  let U = diffuseShown(W, S);
  // (the pass's U_N and S_N are over the lights' light on a white matte surface: here, over U, as the surface shows it)
  if (given) { return Gathered(lit, U, U * pre.U, U * pre.S); }
  // (each diffuse ray stood for Gd / Kd of the light)
  let k = Gd / f32(max(Kd, 1));
  return Gathered(lit, U, Ud * k, Sd * k);
}
// how many rays each kind of light's shadows takes a sub-frame: rays (where the denoiser filters them: keptRays), else
// 16 a frame (a sub-frame's share, at least 4 in each of up to 4 sub-frames; depth of field's 32 send fewer each)
fn shadowRayCount(rays: i32) -> i32 { return select(min(16, max(budget(4), i32(ceil(16.0 * cam.weight)))), rays, rays > 0); }
// the camera's surfaces' rays where the denoiser filters their shadows (world.tracing.keep): the frame's shadow rays
// (scene.shadows.rays), a sub-frame's share, 1 to 4 of each kind; 0 where it does not
fn keptRays() -> i32 { return select(0, clamp(i32(round(world.tracing.shadowRays * cam.weight)), 1, 4), world.tracing.keep > 0.5 && world.tracing.shadowRays > 0.0); }
// The diffuse half of gather's shadows for a point the camera sees, taken apart from its shading (passes/shadows.js: a
// pass of their own, where a GPU walks rays several times faster than inside the surface's whole shader) and without
// its material, which that pass does not know: X, its normal N (facing the camera, unbent by normal maps), frag its
// pixel. The same rays as gather's (K a sub-frame, shared among the shadowed lights, stratified over their sum; each
// light's toward points spread uniformly over the cone it fills) and the same ratio estimator (Heitz, Hill and McGuire
// 2018, Eqs. 14–15), but each light shared and each ray weighed by its diffuse light on a white matte surface (c N·L)
// rather than as the surface shows it. A matte surface's colour is a factor of every term, in each colour, so the two
// agree where it is matte; a sheen's light changes across a light where c N·L does not. → U_N and S_N (gather's: each
// light that took rays counted for its light over its share, each colour, so that a frame's sum of them, the denoiser's,
// keeps each light's colour) over the lights' light on a white matte surface here (E, so about 1), packed in pairs of
// half floats (throughAt); where none of them lights its side (the light is behind it), none of it through.
struct Through { U: vec3f, S: vec3f, found: bool };
fn notFound() -> Through { return Through(vec3f(1.0), vec3f(1.0), false); }
fn throughAt(k: vec4u) -> Through { let a = unpack2x16float(k.x); let b = unpack2x16float(k.y); let c = unpack2x16float(k.z); return Through(vec3f(a, b.x), vec3f(b.y, c), true); }
fn packThrough(U: vec3f, S: vec3f) -> vec4u { return vec4u(pack2x16float(U.xy), pack2x16float(vec2f(U.z, S.x)), pack2x16float(S.yz), 0u); }
fn diffuseThrough(X: vec3f, N: vec3f, frag: vec2f) -> vec4u {
  let n = i32(world.lightCount);
  var G = 0.0;
  var E = vec3f(0.0);
  for (var i = 0; i < n; i++) {
    let o = lightHere(i, X);
    if (o.shadowed && max(o.c.r, max(o.c.g, o.c.b)) >= 1e-5) { let e = o.c * max(dot(N, o.L), 0.0); G += luma(e); E += e; }
  }
  if (G <= 0.0 || world.tables.traced == 0) { return packThrough(vec3f(1.0), vec3f(0.0)); }
  let K = shadowRayCount(keptRays());
  let x = fract(hash3(vec3f(frag, 41.0)) + cam.phase);
  var U = vec3f(0.0); var S = vec3f(0.0);
  var C = 0.0; var k = 0;
  for (var i = 0; i < n && k < K; i++) {
    let o = lightHere(i, X);
    if (!o.shadowed || max(o.c.r, max(o.c.g, o.c.b)) < 1e-5) { continue; }
    let e = o.c * max(dot(N, o.L), 0.0);
    let g = luma(e);
    if (g <= 0.0) { continue; }
    C += g;
    var m = 0;
    loop { if (k >= K || (f32(k) + x) / f32(K) * G >= C) { break; } k++; m++; }
    if (m == 0) { continue; }
    let cone = lightCone(i, X);
    var sw = vec3f(0.0); var sv = vec3f(0.0);
    for (var r = 0; r < m; r++) {
      let D = inConeOver(cone, lightU(frag, i, f32(r), 17.0).xy, N);
      let w = o.c * dot(N, D);
      if (dot(N, D) <= 0.0) { continue; }
      sw += w; sv += w * shadowRay(X, N, i, D);
    }
    let a = e * (f32(m) / g);
    U += a; S += a * shareThrough(sv, sw);
  }
  // (each ray stood for G / K of the light, as gather's)
  let each = G / f32(K);
  let none = E <= vec3f(1e-12);
  let Ek = max(E, vec3f(1e-12));
  return packThrough(select(U * each / Ek, vec3f(1.0), none), select(S * each / Ek, vec3f(1.0), none));
}`;

/** What a surface is at a point: the material, its textures and normal map, and the film's surface code on it. */
export const SURFACE = /* wgsl */`
// a point on a mesh as a shader meets it: where (P, and in its own space), its normal (interpolated, unit), where on its
// pictures (uv) and how fast that changes across what is being drawn (dx, dy: a pixel's, or a ray's footprint), which
// way its uv runs across it (Pu, Pv), its node and copy's colour, and where on it for iridescence's bands (at)
struct Point { P: vec3f, local: vec3f, N: vec3f, uv: vec2f, dx: vec2f, dy: vec2f, Pu: vec3f, Pv: vec3f, node: i32, tint: vec3f, at: vec3f };
// a surface there: its material with its textures and the film's surface applied, its normal (facing V), and, where the
// film's surface sheds its own light (fn shade), that light (own: true)
struct Surf { M: Material, base: vec3f, N: vec3f, own: bool, light: vec3f };
// a normal map's normal (t: its texel, as stored) on a surface of normal N (unit), where Pu and Pv are which way and how
// fast the surface moves as its u and v grow (its texture runs down the picture as v grows, and the map's green is up
// the picture: Blender's and glTF's), bent k of the way from N to it, as Blender's Normal Map node bends it
fn mappedNormal(N: vec3f, Pu: vec3f, Pv: vec3f, t: vec3f, k: f32) -> vec3f {
  let T = Pu - N * dot(N, Pu);
  let B = Pv - N * dot(N, Pv);
  if (dot(T, T) < 1e-20 || dot(B, B) < 1e-20) { return N; }
  let c = t * 2.0 - 1.0;
  let m = normalize(normalize(T) * c.x - normalize(B) * c.y + N * c.z);
  let n = normalize(N + (m - N) * k);
  return select(n, N, dot(n, N) <= 0.0);
}
// which way and how fast a surface moves as u and as v grow (Pu, Pv), from how it and its uv change across two steps
// (a triangle's edges, or a pixel's derivatives: dp1, dp2 and duv1, duv2)
fn uvFrame(dp1: vec3f, dp2: vec3f, duv1: vec2f, duv2: vec2f) -> array<vec3f, 2> {
  let det = duv1.x * duv2.y - duv1.y * duv2.x;
  if (abs(det) < 1e-20) { return array<vec3f, 2>(vec3f(0.0), vec3f(0.0)); }
  return array<vec3f, 2>((dp1 * duv2.y - dp2 * duv1.y) / det, (dp2 * duv1.x - dp1 * duv2.x) / det);
}
// N bent past the edge kept facing V
fn facing(N: vec3f, V: vec3f) -> vec3f { if (dot(N, V) < 0.0) { return normalize(N - V * dot(N, V) * 1.01); } return N; }
fn surfaceAt(p: Point, V: vec3f) -> Surf {
  var M = materialAt(p.node);
  var base = M.base * p.tint;
  if (M.baseTex >= 0.0) { base *= texRead(M.baseTex, p.uv, p.dx, p.dy).rgb; }
  var N = select(p.N, -p.N, dot(p.N, V) < 0.0);
  if (M.normalStrength > 0.0) { N = facing(mappedNormal(N, p.Pu, p.Pv, texRead(M.normalTex, p.uv, p.dx, p.dy).rgb, M.normalStrength), V); }
  if (M.surface > 0.5) {
    let sIn = SurfaceIn(p.P, p.local, N, V, p.uv, p.dx, p.dy, base, M.rough, M.metal, M.emit, sp[0].x);
    if (shadesItself(M.surface)) { return Surf(M, base, N, true, shadeOf(M.surface, sIn)); }
    let so = surfaceOf(M.surface, sIn);
    base = so.base; M.metal = so.metal; M.rough = so.rough; M.emit = so.emit;
    N = facing(normalize(so.normal), V);
  }
  return Surf(M, base, N, false, vec3f(0.0));
}
// what a surface sends toward the eye (V) from the light falling on it (light) and what it reflects (env: the light around
// it diffusely, its reflection at its roughness and its coat's, the light around it for sheen): linear light, and how
// much of what is behind it comes through (trans)
struct Shown { col: vec3f, trans: vec3f };
fn surfaceLight(s: Surf, V: vec3f, light: Terms, env: Terms, at: vec3f) -> Shown {
  if (s.own) { return Shown(s.light, vec3f(0.0)); }
  let W = weightsOf(s.M, s.base, s.N, V, at);
  return Shown(weigh(W.w, plus(light, env)) + W.glow, W.trans);
}
// the light around a surface from the environment alone (its reflections untraced): diffuse (open: how open it is
// around it, 0–1), its reflection at its roughness and its coat's, and for sheen
fn around(s: Surf, V: vec3f, open: f32, diffuse: vec3f) -> Terms {
  let R = reflect(-V, s.N);
  return Terms(diffuse * open, environment(R, clamp(s.M.rough, 0.02, 1.0) * 0.7), environment(R, clamp(s.M.coatRough, 0.02, 1.0) * 0.7),
    diffuse * open * sheenAlbedo(clamp(dot(s.N, V), 1e-3, 1.0), s.M.sheenRough));
}`;
