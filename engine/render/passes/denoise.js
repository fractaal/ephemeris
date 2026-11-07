// The denoiser: meshes' shadows from the scene's lights, and their rough reflections, each filtered as the paper it
// follows does it, every sub-frame (the frame's sub-frames then average what is left, where real-time renderers
// accumulate frames). It works on linear light, from what the opaque pass keeps for it (KEPT, the frame's 'kept'), and
// writes the pixels it changes back into the frame's 'color'. Denoised by default where the look is 'accurate' and the
// device has room for what is kept (scene.shadows = { rays: of each kind a frame, 8; denoise: false, 16 unfiltered };
// scene.reflections = true | { denoise: false }).
//
// Shadows (Heitz, Hill and McGuire 2018, "Combining Analytic Direct Illumination and Stochastic Shadows", I3D), of the
// lights' diffuse light (with sheen; a highlight keeps its pixel's own: see the opaque pass): the light is U, as if
// nothing were in the way (exact: the analytic sum), times the weighted shadow S/U, which alone the rays estimate (S_N,
// U_N: the same rays' light, through what is in the way and as if nothing were: see gather). The estimates are
// denoised apart and divided after: U × denoise[S_N] / denoise[U_N] (their Eq. 25), with W_N = S_N / U_N taken as 1
// where U_N is nothing (§4.2). The denoise is theirs (§4.1): a noise estimate E (the noise pass: the total variation of
// W_N's second derivative along four lines through the pixel, an asterisk with a random per-pixel offset: their Eq. 29),
// box-filtered 3 × 3, then a Gaussian joint-bilateral filter of S_N and U_N, horizontally then vertically, its standard
// deviation proportional to E (so it grows in noisy penumbrae and not where shadows are hard or absent), its bilateral
// weights from the difference in planes (position and normal) between the centre and each tap. The two constants the
// paper leaves to its supplemental code (not published with it) are Ephemeris's: LINE (each line's half length, px) and
// SIGMA (px of standard deviation per unit of E, up to SIGMA_MAX). gather() gives the opaque pass U, U_N and S_N, each
// the colour it makes as the surface shows it.
//
// Rough reflections (Stachowiak and Uludag 2015, "Stochastic Screen-Space Reflections", SIGGRAPH Advances; their
// screen-space trace replaced by the traced ray): each pixel sends one ray, importance-sampled from its GGX lobe's
// visible normals (Heitz 2018), and the resolve (the vertical pass) reuses its neighbours' rays as if sent from here:
// each weighted by this pixel's own BRDF toward the neighbour's hit point over the probability the neighbour had of
// sending it, the sum normalised by the sum of weights (their slides 46-55), the pre-integrated BRDF applied outside (the
// surface's weight for its reflection: the split sum's). BRDF × cosine without Fresnel is D(H) G2(V, L) / (4 N.V) (Heitz
// 2018, Eq. 15); a ray's probability, G1(V) D(H) / (4 N.V) (Eqs. 3, 17). Because every borrowed ray is judged by this
// pixel's lobe, a mirror keeps only its own and stays sharp, and a rough lobe's reflection keeps its shape (a streak
// where a low angle stretches it). The rays are borrowed from REUSE taps within REUSE_R px, turned each sub-frame; a
// neighbour off this pixel's surface (another plane) is not borrowed from (the paper assumes visibility the same; across
// an edge it is not).
import { COMMON, FULLSCREEN_VS } from '../shaders.js';

// What the opaque pass keeps at each mesh pixel, in this order, as half floats two to a channel in the frame's 'kept'
// (three rgba32uint layers: 24 halves in 48 bytes; render targets, not storage, so the depth test still spares the
// shader the meshes behind the nearest): the colour without the shadowed lights' diffuse light as the rays left it (raw); the
// reflection's lobe alpha (a; 0: no ray kept); the shadowed lights' diffuse light as if nothing were in the way (U); the
// kept ray's probability (pdf); that light as the rays found it, as if nothing were in the way (UN: U_N) and through
// what is (SN: S_N); where the ray went from the surface (hit); the reflection's weight in the colour (rw) and what its
// ray brought back (rl).
const FIELDS = [['raw', 3], ['a', 1], ['U', 3], ['pdf', 1], ['UN', 3], ['SN', 3], ['hit', 3], ['rw', 3], ['rl', 3]];
const halves = FIELDS.flatMap(([name, n]) => (n === 1 ? [`k.${name}`] : ['x', 'y', 'z'].slice(0, n).map((c) => `k.${name}.${c}`)));
while (halves.length < 24) halves.push('0.0');
const typeOf = (n) => (n === 1 ? 'f32' : `vec${n}f`);
const unpacked = (() => { let at = 0; return FIELDS.map(([, n]) => { const h = Array.from({ length: n }, () => { const i = at++; return `h[${i >> 1}].${i & 1 ? 'y' : 'x'}`; }); return n === 1 ? h[0] : `vec${n}f(${h.join(', ')})`; }); })();
/** The WGSL of what is kept: struct Kept, nothingKept(), packKept (the three texels) and unpackKept. */
export const KEPT = /* wgsl */`
struct Kept { ${FIELDS.map(([name, n]) => `${name}: ${typeOf(n)}`).join(', ')} };
fn nothingKept() -> Kept { return Kept(${FIELDS.map(([, n]) => (n === 1 ? '0.0' : `vec${n}f(0.0)`)).join(', ')}); }
fn packKept(k: Kept) -> array<vec4u, 3> {
  return array<vec4u, 3>(${[0, 1, 2].map((l) => `vec4u(${[0, 1, 2, 3].map((c) => `pack2x16float(vec2f(${halves[(l * 4 + c) * 2]}, ${halves[(l * 4 + c) * 2 + 1]}))`).join(', ')})`).join(',\n    ')});
}
fn unpackKept(a: vec4u, b: vec4u, c: vec4u) -> Kept {
  let h = array<vec2f, 12>(${['a', 'b', 'c'].flatMap((t) => ['x', 'y', 'z', 'w'].map((s) => `unpack2x16float(${t}.${s})`)).join(', ')});
  return Kept(${unpacked.join(', ')});
}`;

const HEAD = FULLSCREEN_VS + COMMON + KEPT + /* wgsl */`
fn pcg(v: u32) -> u32 { let s = v * 747796405u + 2891336453u; let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
const LINE = 4;
const SIGMA = 1.0;
const SIGMA_MAX = 12.0;
@group(1) @binding(0) var keptT: texture_2d_array<u32>;
@group(1) @binding(1) var posT: texture_2d<f32>;
fn unkeep(q: vec2i) -> Kept { return unpackKept(textureLoad(keptT, q, 0, 0), textureLoad(keptT, q, 1, 0), textureLoad(keptT, q, 2, 0)); }
fn shadowed(K: Kept) -> bool { return dot(K.U, vec3f(1.0)) > 0.0; }
fn edge() -> vec2i { return vec2i(cam.drawn) - vec2i(1); }
// the plane weight both filters use: a tap off the centre's plane (by a few pixels' width at its depth) or facing
// another way is not the same surface
fn sameSurface(P0: vec3f, N0: vec3f, Pq: vec3f, Nq: vec3f) -> f32 {
  let tol = 3.0 * max(dot(cam.eye - P0, cam.back), 1.0) / (cam.focal * cam.scale);
  let off = dot(N0, Pq - P0) / tol;
  return exp(-off * off) * pow(max(dot(N0, Nq), 0.0), 8.0);
}`;

// the noise estimate (Heitz et al. 2018, Eq. 29) of each mesh pixel the scene's lights' shadows fall on
const NOISE = HEAD + /* wgsl */`
fn shadowW(K: Kept) -> f32 { let u = luma(K.UN); if (u <= 1e-6) { return 1.0; } return clamp(luma(K.SN) / u, 0.0, 1.0); }
@fragment fn fs(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let px = vec2i(fp.xy);
  let K0 = unkeep(px);
  if (textureLoad(posT, px, 0).w < 0.5 || !shadowed(K0)) { return vec4f(0.0); }
  let w0 = shadowW(K0);
  let o = i32(pcg(u32(px.x) * 1973u + u32(px.y) * 9277u + u32(cam.seed * 1000.0) * 26699u) & 1u);
  let dirs = array<vec2i, 4>(vec2i(1, 0), vec2i(0, 1), vec2i(1, 1), vec2i(1, -1));
  var tv = 0.0;
  for (var l = 0; l < 4; l++) {
    // (W_N along the line; off the shadowed surface, this pixel's: a silhouette is not noise)
    var w = array<f32, 9>();
    for (var t = 0; t < 2 * LINE + 1; t++) {
      let q = clamp(px + dirs[l] * (t - LINE + o), vec2i(0), edge());
      let Kq = unkeep(q);
      w[t] = select(w0, shadowW(Kq), textureLoad(posT, q, 0).w > 0.5 && shadowed(Kq));
    }
    for (var t = 1; t < 2 * LINE; t++) { tv += abs(w[t - 1] - 2.0 * w[t] + w[t + 1]); }
  }
  return vec4f(tv / 4.0, 0.0, 0.0, 1.0);
}`;

// the horizontal pass of the shadows' joint-bilateral filter: S_N (rgb) and its standard deviation (w), U_N (w: this
// pixel is shadowed)
const ACROSS = HEAD + /* wgsl */`
@group(1) @binding(2) var nrmT: texture_2d<f32>;
@group(1) @binding(3) var noiseT: texture_2d<f32>;
struct HO { @location(0) s: vec4f, @location(1) u: vec4f };
@fragment fn fs(@builtin(position) fp: vec4f) -> HO {
  let px = vec2i(fp.xy);
  let K0 = unkeep(px);
  if (textureLoad(posT, px, 0).w < 0.5 || !shadowed(K0)) { return HO(vec4f(0.0), vec4f(0.0)); }
  var E = 0.0;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) { E += textureLoad(noiseT, clamp(px + vec2i(x, y), vec2i(0), edge()), 0).r; } }
  let sigma = min(SIGMA * E / 9.0, SIGMA_MAX);
  var fS = K0.SN;
  var fU = K0.UN;
  if (sigma >= 0.5) {
    let P0 = textureLoad(posT, px, 0).xyz;
    let N0 = normalize(textureLoad(nrmT, px, 0).xyz);
    let r = i32(ceil(2.0 * sigma));
    for (var t = -r; t <= r; t++) {
      if (t == 0) { continue; }
      let q = px + vec2i(t, 0);
      if (q.x < 0 || q.x > edge().x) { continue; }
      let Kq = unkeep(q);
      if (!shadowed(Kq)) { continue; }
      let w = exp(-f32(t * t) / (2.0 * sigma * sigma)) * sameSurface(P0, N0, textureLoad(posT, q, 0).xyz, textureLoad(nrmT, q, 0).xyz);
      fS += w * Kq.SN;
      fU += w * Kq.UN;
    }
  }
  return HO(vec4f(fS, sigma), vec4f(fU, 1.0));
}`;

// the vertical pass, the shadows' ratio, the reflections' resolve, and the pixel's light where they change it
const DOWN = HEAD + /* wgsl */`
@group(1) @binding(2) var nrmT: texture_2d<f32>;
@group(1) @binding(3) var hsT: texture_2d<f32>;
@group(1) @binding(4) var huT: texture_2d<f32>;
fn ggxD(NoH: f32, a: f32) -> f32 { let a2 = a * a; let d = (a2 - 1.0) * NoH * NoH + 1.0; return a2 / (PI * d * d); }
fn ggxLambda(NoX: f32, a: f32) -> f32 { let c2 = max(NoX * NoX, 1e-8); return 0.5 * (-1.0 + sqrt(1.0 + a * a * (1.0 - c2) / c2)); }
const REUSE = 16;
const REUSE_R = 8.0;
@fragment fn fs(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let px = vec2i(fp.xy);
  let P4 = textureLoad(posT, px, 0);
  let K0 = unkeep(px);
  let lit = shadowed(K0);
  if (P4.w < 0.5 || (!lit && K0.a <= 0.0)) { discard; }
  let P0 = P4.xyz;
  let N0 = normalize(textureLoad(nrmT, px, 0).xyz);
  var L = K0.raw;
  if (lit) {
    let c = textureLoad(hsT, px, 0);
    let sigma = c.w;
    var fS = c.rgb;
    var fU = textureLoad(huT, px, 0).rgb;
    if (sigma >= 0.5) {
      let r = i32(ceil(2.0 * sigma));
      for (var t = -r; t <= r; t++) {
        if (t == 0) { continue; }
        let q = px + vec2i(0, t);
        if (q.y < 0 || q.y > edge().y) { continue; }
        let hu = textureLoad(huT, q, 0);
        if (hu.w < 0.5) { continue; }
        let w = exp(-f32(t * t) / (2.0 * sigma * sigma)) * sameSurface(P0, N0, textureLoad(posT, q, 0).xyz, textureLoad(nrmT, q, 0).xyz);
        fS += w * textureLoad(hsT, q, 0).rgb;
        fU += w * hu.rgb;
      }
    }
    L += K0.U * select(clamp(fS / max(fU, vec3f(1e-6)), vec3f(0.0), vec3f(1.0)), vec3f(1.0), fU <= vec3f(1e-6));
  }
  if (K0.a > 0.0) {
    let a = K0.a;
    let V = normalize(cam.eye - P0);
    let NoV = max(dot(N0, V), 1e-4);
    let lamV = ggxLambda(NoV, a);
    let turn = f32(pcg(u32(px.x) * 7919u + u32(px.y) * 104729u + u32(cam.seed * 1000.0) * 15731u)) / 4294967296.0 * TAU;
    var sum = vec3f(0.0);
    var wsum = 0.0;
    for (var i = 0; i <= REUSE; i++) {
      // (this pixel's own ray, then REUSE of its neighbours', spread over a disc)
      var q = px;
      if (i > 0) { let r = REUSE_R * sqrt((f32(i) - 0.5) / f32(REUSE)); let ang = f32(i) * 2.39996323 + turn; q = px + vec2i(round(vec2f(cos(ang), sin(ang)) * r)); }
      if (any(q < vec2i(0)) || any(q > edge())) { continue; }
      let Kq = unkeep(q);
      if (Kq.pdf <= 0.0 || Kq.a <= 0.0) { continue; }
      let Pq = textureLoad(posT, q, 0).xyz;
      let Lq = normalize(Pq + Kq.hit - P0);
      let NoL = dot(N0, Lq);
      if (NoL <= 0.0) { continue; }
      let NoH = max(dot(N0, normalize(V + Lq)), 0.0);
      // (this pixel's BRDF × cosine toward that hit, without Fresnel, over the probability it was sent with)
      var w = ggxD(NoH, a) / (4.0 * NoV * (1.0 + lamV + ggxLambda(NoL, a))) / Kq.pdf;
      if (i > 0) { w *= sameSurface(P0, N0, Pq, textureLoad(nrmT, q, 0).xyz); }
      sum += w * Kq.rl;
      wsum += w;
    }
    if (wsum > 0.0) { L += K0.rw * (sum / wsum - K0.rl); }
  }
  return vec4f(max(L, vec3f(0.0)), 1.0);
}`;

export const denoise = {
  name: 'denoise', stage: 'sub', reads: ['position', 'normal', 'kept'], writes: ['color'],
  setup(R) {
    const dev = R.dev, F = GPUShaderStage.FRAGMENT;
    // a pass of the denoiser's: what it reads (the frame's textures by name, and its own), what it draws into
    const pass = (code, label, textures, targets) => {
      const layout = dev.createBindGroupLayout({ entries: textures.map((n, binding) => ({ binding, visibility: F,
        texture: n === 'kept' ? { sampleType: 'uint', viewDimension: '2d-array' } : { sampleType: 'unfilterable-float' } })) });
      const mod = R.module(code, label);
      return { label, layout, textures, targets, pipe: R.pipeline(label, () => ({ layout: R.pipelineLayout([R.layouts.frame, layout]), vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: targets.map((t) => ({ format: t === 'noise' ? 'r16float' : 'rgba16float' })) }, primitive: { topology: 'triangle-list' } })) };
    };
    this.passes = [pass(NOISE, 'denoise: noise', ['kept', 'position'], ['noise']), pass(ACROSS, 'denoise: across', ['kept', 'position', 'normal', 'noise'], ['hS', 'hU']),
      pass(DOWN, 'denoise: down', ['kept', 'position', 'normal', 'hS', 'hU'], ['color'])];
  },
  async run(R, sub) {
    if (!sub.keep) return;
    const dev = R.dev, pipes = await Promise.all(this.passes.map((p) => p.pipe));
    // (its own textures, the size drawn: the noise estimate, and the horizontal pass's S_N and U_N)
    if (this.gen !== R.tex.gen) {
      this.gen = R.tex.gen;
      for (const t of Object.values(this.own ?? {})) t.destroy();
      const T = (format, label) => dev.createTexture({ size: [R.pw, R.ph], format, label, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.own = { noise: T('r16float', 'denoise: noise'), hS: T('rgba16float', 'denoise: S'), hU: T('rgba16float', 'denoise: U') };
      const view = (n) => (this.own[n] ?? R.tex[n]).createView();
      for (const p of this.passes) p.bg = dev.createBindGroup({ layout: p.layout, entries: p.textures.map((n, binding) => ({ binding, resource: view(n) })) });
    }
    for (const [i, p] of this.passes.entries()) {
      // (the last draws into the frame's colour where it changes it)
      const d = R.enc.beginRenderPass({ label: p.label, colorAttachments: p.targets.map((t) => (t === 'color' ? R.load('color') : { view: this.own[t].createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] })) });
      d.setPipeline(pipes[i]); d.setBindGroup(0, R.frameBG); d.setBindGroup(1, p.bg); d.draw(3); d.end();
    }
  },
};
