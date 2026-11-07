// Global illumination (scene.gi: true, or { probe, rays, once }; off by default; the timeline's gi for every scene or
// none): the light around each mesh pixel the camera sees, found again for every sub-frame from nothing kept between
// frames, as Split Radiance Cascades does it (Freeman, Sannikov and Pitt-Francis 2026, "Split Radiance Cascades:
// Real-Time Global Illumination via Sparse Radiance Probes", arXiv 2607.20384): what reaches a surface from every way,
// the environment where nothing is in the way, and where something is, the light it sends back (lit by the scene's
// lights, their shadows traced; glowing; a layer's picture). One bounce, diffuse: what a GI ray meets is lit by the
// lights, not by the environment's diffuse light (traceLight's gi), so the light that bounces is what the lights put
// there. The opaque pass takes it (the frame's 'gi', w 1 where found) in place of the environment's diffuse light, and
// lights what its reflections meet with it, read from the probes where they are (sub.giProbes: giReader, aroundGI);
// where the scene's reflections are traced, probes are made where they land too, out of the camera's sight (giReach).
//
// More bounces (bounces: n): each ray's light again, where it met a surface, with that surface lit too by the light
// around it as the bounce before found it (giAgain). The rays are not traced again: where each landed, which way the
// surface there faces and how much of the light around it comes back along the ray are kept as it is traced (giRec),
// and each bounce reads the probes there and adds to the deposits what that brings back beyond what the bounce before
// did; the cascades are merged again. So a sub-frame alone has every bounce, the same at any number of sub-frames, and
// nothing is kept between frames. Where light bounces more than once, probes are made where GI's rays land too, out of
// the camera's sight (giReach), as they are where its reflections do. What a ray meets where no probe is near takes no
// more than the lights put there; nor does glass or a layer it passes, or a surface's highlight. The sky's light
// reaches what a ray meets one bounce later than the lights' does (it comes in GI's rays, not with the lights), so
// bounces: n has the lights' light bounced n times and the sky's n - 1 times.
//
// Radiance probes hold the light arriving at a point from each of a set of directions. Radiance Cascades (Sannikov
// 2023) keeps several sets (cascades) of probes in the same space: cascade n's are 2^n times as far apart, see 4^n times
// as many directions (32 · 4^n, an equal-area grid over the sphere: its Algorithm 2), and each holds only what lies
// between t(n-1) and t(n) = t0 · 4^n from it (t0 = 1.6 times cascade 0's spacing: its section 7). Near things are seen
// finely in space and coarsely in direction, far ones the other way round, so a penumbra is as sharp as the probes that
// see it can make it at any distance. A cascade's light in a direction is what it found in its interval (J), and beyond
// it, as much as its interval was clear (β), the cascade above's (Eq. 6, 7): merged from the top cascade down, cascade 0
// holds all the light arriving from every way.
//
// The probes are sparse (its section 4): only the cells that a visible surface passes through have them, in a hash
// table per cascade; and the cells' size grows with distance from the eye (levels of detail: its section 4.1, by the
// Chebyshev distance, each level twice as far, its cells twice as large), so a probe is about as large on screen
// wherever it is (probe: its size at the near edge of its level, in drawn px; half that at the far edge: a preview drawn
// smaller has larger probes, each with as many rays as a render's — coarser light, not grainier). Rays are split, not
// traced per cascade (its section 5): each pixel's mesh sends one ray in a direction of its own, and how far it got
// before what stopped it says which cascade's interval held it — the ones below saw the way clear, that one saw what it
// met, the ones above none of it — so one ray serves every cascade, from where the surface is rather than where the
// probe's centre is (which may be inside it). The pixels' directions are spread so that each probe's are: a 64 × 64 tile
// of pixels in Morton order takes the R2 sequence's points in turn (Roberts 2018), so every aligned square of 4^k pixels
// (a probe's share of the screen at one cascade or another) holds a run of them, which covers the sphere evenly (its
// Algorithm 3 gives each probe a run directly; this does it by the probes' size on screen, with nothing to count or
// sort). Each sub-frame takes another stretch of the sequence; the frame's sub-frames average them.
//
// What each ray deposits is summed in integers (fixed point: 1/4096 of a unit of light), the same whatever order the
// rays arrive in, so a frame is the same on any worker; the hash tables' slots differ with the order things are
// inserted, but every lookup is by a probe's own key. The light around a pixel is then read from the 27 cascade-0 probes
// around it that exist, each from its 6 × 6 octahedral map of the light falling on a surface facing each way (its
// section 6), weighed by a quadratic B-spline.
//
// What glows brighter than EMIT_BRIGHT is not found by GI's rays (they see it dark): its light is sampled from each
// pixel instead (emitters.js), which a small bright emitter needs — found by GI's rays it bubbles.
//
// Each level overlaps the one below it, and the light around a pixel is blended across the overlap (its section 4.1:
// giUp), so a level's edge does not show as a step in a wall's light.
//
// Not done here: the screen-space cascade below cascade 0 (its C(-1)), its second cache for more bounces (fed by the
// previous frame's, which a frame here does not have: giAgain instead), glass and layers taking it (meshes alone do;
// glass and layers send light into it).
//
// scene.gi = { probe: a probe's size on screen (drawn px, 16): how fine the light is, and what it costs, as many rays
// reaching each probe whatever its size (32: one pixel in four sends them, 64: one in sixteen, which ones turning each
// sub-frame; 8: each pixel four), rays: how many a pixel sends in a frame at that size (4; at least one a sub-frame;
// below 1, a quarter of that): how grainy it is, bounces: how many times light bounces (1), once: the probes made and
// traced on the frame's first sub-frame alone, the others reading them (where they have moved since, from the probes
// they are near; its rays are worth raising: on spring-brutalist at probe 16 and 4 bounces, 4 leaves shaded floors pebbly and
// 16 is as clean as 32, at 35% and 50% of GI every sub-frame's GPU time and a browser's 2.1 GB against 32's 2.65; one such
// sub-frame is cleaner than as many rays over as many sub-frames), reach: how far cascade 0 sees, in its probes' spacing,
// the cascades above four times further each (its t0: 1.6, its section 7), hit: one pixel in each hit × hit drawn makes probes
// where it reflects or its first ray lands, out of the camera's sight (px; 4 at probe 16, in step with the probe: hitOf;
// wider saves little and loses bounces: gi-test at 2 bounces, 16 against 4, about 20% of GI's time and 4 levels darker) }.
import { W, H } from '../../camera.js';
import { COMMON } from '../shaders.js';

const GI_PROBE = 16;
const GI_REACH = 1.6;   // t0 over cascade 0's spacing (its section 7)
// one pixel in each GI_HIT × GI_HIT follows its reflection to where GI's light is wanted (giReach): on gi-test's floor
// 4 corrects as much of what its reflections show as 2 did, within 0.001, at about half the cost. A larger probe takes
// them from further apart, in step with it (hitOf): probes four times as wide cover a surface with a sixteenth as many
const GI_HIT = 4;
const hitOf = (P) => Math.max(GI_HIT, Math.round((GI_HIT * P) / GI_PROBE));

// spacing: cascade 0's at level 0 (world px); reach: t0 over that spacing; stride: which pixels send rays (1 every one, 2
// one in four); rays: how many each sends this sub-frame; cap: how many probes each cascade has room for; mask: its
// table's slots - 1; where in giIdx each cascade's table, its probes' keys and their links to the cascade above start
// (u32s); where in giDep its deposits start (u32s); where in giVal its merged light starts (vec4s: cascade 0's I, the
// others' A); maps: where cascade 0's probes' maps of the light falling on them start in giVal; hits: where the points
// the pixels' mirror reflections meet start in giVal (two vec4s each: the point, w 1 where it needs probes; which way it
// faces); bounces: how many; recW: how many pixels across send rays (giRec's rows), recHits: where in giRec the
// hits' rays start; lands: where probes are made out of the camera's sight (1: where its mirror reflections land, 2:
// where GI's rays do; giReach); hit: one pixel in each hit × hit follows them there (hitOf)
const GI_U = /* wgsl */`
struct GIU { spacing: f32, reach: f32, stride: u32, rays: u32, cap: vec4u, mask: vec4u, tab: vec4u, key: vec4u, link: vec4u, dep: vec4u, val: vec4u, maps: u32, hits: u32, bounces: u32, recW: u32, recHits: u32, lands: u32, hit: u32 };
`;

// Finding the light around a point in the probes (giAt, giNear): in GI's own passes (atomic: giIdx as they write it)
// and in the passes after it, which read what it found (giReader)
const GI_LOOK = (atomic) => {
  const ld = (e) => (atomic ? `atomicLoad(&${e})` : e);
  return /* wgsl */`
const GI_N = 4u;
const GI_NONE = 0xffffffffu;
// level 0 reaches a quarter of the focal length from the eye (px): a probe s px across seen from that far is s · 4 px
// on the frame
fn giD0() -> f32 { return cam.focal * 0.25; }
// the level of detail of what is seen from d away: how many times giD0 doubles to d; a point's (giLod), by its
// Chebyshev distance from the eye
fn giLodAt(d: f32) -> u32 { return u32(clamp(floor(log2(max(d, giD0()) / giD0())), 0.0, 15.0)); }
fn giDist(X: vec3f) -> f32 { let a = abs(X - cam.eye); return max(a.x, max(a.y, a.z)); }
fn giLod(X: vec3f) -> u32 { return giLodAt(giDist(X)); }
// how far into the level above its own a point seen from d away is: each level starts at 0.9 of its distance (GI_OVERLAP),
// overlapping the one below, and the two are blended linearly across the overlap, so that where a surface passes from
// one to the next its light does not step (its section 4.1): 0 below the overlap, rising to 1 where the level below ends
// (a point in the overlap has probes of both levels, and its rays go to both)
const GI_OVERLAP = 0.9;
fn giUp(d: f32) -> f32 {
  let l = giLodAt(d);
  if (l >= 15u) { return 0.0; }
  let D = giD0() * exp2(f32(l + 1u));
  return clamp((d - GI_OVERLAP * D) / ((1.0 - GI_OVERLAP) * D), 0.0, 1.0);
}
fn giSpacing(n: u32, lod: u32) -> f32 { return giU.spacing * f32(1u << (n + lod)); }
// a probe's key: its cell (20 bits each way) and level of detail (4 bits), its centre (cell + 0.5) × its spacing
struct GIKey { lo: u32, hi: u32 };
fn giKey(c: vec3i, lod: u32) -> GIKey {
  let o = vec3u(clamp(c + vec3i(524288), vec3i(0), vec3i(1048575)));
  return GIKey(o.x | ((o.y & 0xfffu) << 20u), (o.y >> 12u) | (o.z << 8u) | (lod << 28u));
}
fn giPcg(v: u32) -> u32 { let s = v * 747796405u + 2891336453u; let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
fn giFinger(k: GIKey) -> u32 { return giPcg(k.lo ^ giPcg(k.hi)) | 1u; }
// the probe with key k in cascade n (GI_NONE: there is none)
fn giFind(n: u32, k: GIKey) -> u32 {
  let h = giFinger(k);
  var s = h & giU.mask[n];
  for (var i = 0; i < 64; i++) {
    let b = giU.tab[n] + s * 4u;
    let st = ${ld('giIdx[b]')};
    if (st == 0u) { return GI_NONE; }
    if (st == h && ${ld('giIdx[b + 1u]')} == k.lo && ${ld('giIdx[b + 2u]')} == k.hi) { return ${ld('giIdx[b + 3u]')}; }
    s = (s + 1u) & giU.mask[n];
  }
  return GI_NONE;
}
// The probes made where reflections land are all made after those where the camera sees a surface (giAddHits runs
// after giAdd and giFix), so after the counts giReach keeps (giIdx[5 + n]; 0: none were made that way). Whether they
// all fit is the same however their threads ran (how many cells they need is), but which of them would get the room
// left is not: in a cascade where they do not all fit (giIdx[9], a bit each: giArgsFill), none is used, and the frame
// is the same on any worker, the cascades below it keeping theirs and the light they reach by themselves. (All of them
// going for one cascade's few too many, gi-test's room jumped by 9% as the count crossed its room, its reflections
// taking the open sky.)
fn giMade(n: u32) -> u32 { return ${ld('giIdx[5u + n]')}; }
fn giHitsOut(n: u32) -> bool { return ((${ld('giIdx[9]')} >> n) & 1u) != 0u; }
// whether probe p of cascade n (as giFind found it) may be used: there, and made where the camera sees a surface or
// where a reflection lands while those fit
fn giUsable(n: u32, p: u32) -> bool { let m = giMade(n); return p != GI_NONE && (m == 0u || p < m || !giHitsOut(n)); }
// whether cascade-0 probe p is one made where the camera sees a surface, not only where a reflection lands
fn giSeen(p: u32) -> bool { let m = giMade(0u); return m == 0u || p < m; }
// a direction ↔ its place on a probe's 6 × 6 octahedral map (the poles along y)
fn giOct(n: vec3f) -> vec2f {
  let a = n / (abs(n.x) + abs(n.y) + abs(n.z));
  var e = a.xz;
  if (a.y < 0.0) { e = (1.0 - abs(e.yx)) * select(vec2f(-1.0), vec2f(1.0), e >= vec2f(0.0)); }
  return e * 0.5 + 0.5;
}
// a texel just past the map's edge is the one mirrored across that edge's middle (the folded half meets itself there:
// the paper copies a border of them round each map)
fn giWrap(c: vec2i) -> vec2u {
  var x = c.x; var y = c.y;
  if (x < 0) { x = 0; y = 5 - y; } else if (x > 5) { x = 5; y = 5 - y; }
  if (y < 0) { y = 0; x = 5 - x; } else if (y > 5) { y = 5; x = 5 - x; }
  return vec2u(clamp(vec2i(x, y), vec2i(0), vec2i(5)));
}
// probe p's map toward N, bilinearly (each texel as much as its directions had rays)
fn giMapAt(p: u32, N: vec3f) -> vec4f {
  let uv = giOct(N) * 6.0 - 0.5;
  let i = vec2i(floor(uv)); let f = uv - floor(uv);
  let b = giU.maps + p * 36u;
  var acc = vec4f(0.0);
  for (var k = 0u; k < 4u; k++) {
    let c = giWrap(i + vec2i(i32(k & 1u), i32(k >> 1u)));
    let t = giVal[b + c.y * 6u + c.x];
    let wt = select(1.0 - f.x, f.x, (k & 1u) == 1u) * select(1.0 - f.y, f.y, k >= 2u) * t.w;
    acc += vec4f(t.rgb * wt, wt);
  }
  return select(vec4f(0.0), vec4f(acc.rgb / acc.w, acc.w), acc.w > 0.0);
}
// the light around a surface at X facing N: the 27 cascade-0 probes around it that exist, weighed by a quadratic
// B-spline (each way, ½ (½ - t)², ¾ - t², ½ (½ + t)² for the probe below, nearest and above, t from the nearest: at a
// probe's centre it takes ¾ of that probe each way rather than all of it, as trilinear weights would, so one probe's
// noise does not show at its centre, in a lattice that boils as the camera moves; half way between two, the same as
// trilinear) (w 1: some did; 0: none, as where no surface the camera sees is near X). Of those, only the ones made
// where the camera sees a surface (giSeen): those made where a reflection lands have fewer rays (one pixel in hit²
// sends them), and with them the frame converges to the same light (gi-test, 32 sub-frames: the same to 4 places in
// each region measured) but one sub-frame's walls beside them are twice as grainy.
fn giAt(X: vec3f, N: vec3f, lod: u32) -> vec4f {
  let u = X / giSpacing(0u, lod) - 0.5;
  let c = vec3i(round(u));
  let t = u - vec3f(c);
  let w0 = 0.5 * (0.5 - t) * (0.5 - t);
  let w1 = 0.75 - t * t;
  let w2 = 0.5 * (0.5 + t) * (0.5 + t);
  var acc = vec3f(0.0); var ws = 0.0;
  for (var j = 0; j < 27; j++) {
    let o = vec3i(j % 3, (j / 3) % 3, j / 9);
    let p = giFind(0u, giKey(c + o - 1, lod));
    if (p == GI_NONE || !giSeen(p)) { continue; }
    let e = giMapAt(p, N);
    let wx = select(select(w2.x, w1.x, o.x == 1), w0.x, o.x == 0);
    let wy = select(select(w2.y, w1.y, o.y == 1), w0.y, o.y == 0);
    let wz = select(select(w2.z, w1.z, o.z == 1), w0.z, o.z == 0);
    acc += e.rgb * wx * wy * wz * e.w; ws += wx * wy * wz * e.w;
  }
  return select(vec4f(0.0), vec4f(acc / ws, 1.0), ws > 1e-4);
}
// the light around X as giAt finds it, from the 8 probes of level lod around it, trilinearly: cheaper, for what a ray
// meets; toward N (diff) and, where both is set, toward R (refl) from the same probes (w 1: some had it)
struct GINear { diff: vec4f, refl: vec4f };
fn giNear(X: vec3f, N: vec3f, R: vec3f, both: bool, lod: u32) -> GINear {
  let u = X / giSpacing(0u, lod) - 0.5;
  let c = vec3i(floor(u));
  let f = u - vec3f(c);
  var a = vec3f(0.0); var wa = 0.0; var b = vec3f(0.0); var wb = 0.0;
  for (var j = 0u; j < 8u; j++) {
    let o = vec3u(j & 1u, (j >> 1u) & 1u, j >> 2u);
    let p = giFind(0u, giKey(c + vec3i(o), lod));
    if (!giUsable(0u, p)) { continue; }
    let t = mix(1.0 - f, f, vec3f(o));
    let e = giMapAt(p, N);
    a += e.rgb * t.x * t.y * t.z * e.w; wa += t.x * t.y * t.z * e.w;
    if (both) { let g = giMapAt(p, R); b += g.rgb * t.x * t.y * t.z * g.w; wb += t.x * t.y * t.z * g.w; }
  }
  return GINear(select(vec4f(0.0), vec4f(a / wa, 1.0), wa > 1e-4), select(vec4f(0.0), vec4f(b / wb, 1.0), wb > 1e-4));
}
// the light around what a ray meets at X (path: from the eye to there, along the ray): the camera's probes first, at
// X's own level, then where it found none, those made where reflections land, at the level the ray sees it at (where
// that is another: sized by how far along the path they are seen), and those where GI's rays land, a level coarser
fn giAround(X: vec3f, N: vec3f, R: vec3f, both: bool, path: f32) -> GINear {
  let l0 = giLod(X); let l1 = giLodAt(path);
  var a = giNear(X, N, R, both, l0);
  for (var l = max(l0 + 1u, l1); l <= min(l1 + 1u, 15u); l++) {
    if (a.diff.w >= 0.5 && (!both || a.refl.w >= 0.5)) { break; }
    let b = giNear(X, N, R, both, l);
    if (a.diff.w < 0.5) { a.diff = b.diff; }
    if (a.refl.w < 0.5) { a.refl = b.refl; }
  }
  return a;
}
`;
};

/**
 * WGSL for a pass after GI's that reads the light it found at any point (giAt(X, N, lod), giNear: w 1 where it found some), its
 * buffers in bind group g at bindings b, b + 1, b + 2 (giReadLayout, giReadEntries).
 */
export const giReader = (g, b) => GI_U + /* wgsl */`
@group(${g}) @binding(${b}) var<uniform> giU: GIU;
@group(${g}) @binding(${b + 1}) var<storage, read> giIdx: array<u32>;
@group(${g}) @binding(${b + 2}) var<storage, read> giVal: array<vec4f>;
` + GI_LOOK(false);

/**
 * The light around what a pass's rays meet (R.prelude's around: see AROUND_ENV in trace.js), from what GI found there;
 * the environment's where it found none (neither a surface the camera sees nor a mirror reflection's landing is near:
 * a rough reflection's ray spread far from it). The camera's probes first, then those made where reflections land, which
 * are sized by how far along the path (path: from the eye to where the ray met it) they are seen (giAround). From the 8
 * probes around it (giNear): what a ray meets is blurred by its own spread and the sub-frames'
 * average, and the 27 of giAt cost the opaque pass about three times as much. Its buffers in bind group g at bindings
 * b, b + 1, b + 2 (giReadLayout, giReadEntries).
 */
export const aroundGI = (g, b) => giReader(g, b) + /* wgsl */`
fn aroundHit(X: vec3f, N: vec3f, R: vec3f, both: bool, path: f32) -> Around {
  let a = giAround(X, N, R, both, path);
  return Around(select(vec4f(irradiance(N), 0.0), a.diff, a.diff.w > 0.5), a.refl);
}
`;

/** The bind group layout entries for GI's probes, read (giReader) at bindings b … b + 2 by the shader stages vis. */
export const giReadLayout = (b, visibility) => [{ binding: b, visibility, buffer: {} },
  { binding: b + 1, visibility, buffer: { type: 'read-only-storage' } }, { binding: b + 2, visibility, buffer: { type: 'read-only-storage' } }];
/** Their entries, for the probes GI found this sub-frame (sub.giProbes). */
export const giReadEntries = (probes, b) => [{ binding: b, resource: { buffer: probes.u } },
  { binding: b + 1, resource: { buffer: probes.idx } }, { binding: b + 2, resource: { buffer: probes.val } }];

const GI_CORE = GI_U + /* wgsl */`
@group(2) @binding(0) var<uniform> giU: GIU;
// counts (0–3: each cascade's probes; 4: probes without room; 5–8: each cascade's made where the camera sees a surface,
// when reflections' hits made more after them; 9: a bit for each cascade where those did not all fit: giMade, giHitsOut), tables (4 u32 a slot: its key's fingerprint, the key,
// the probe), probes' keys (2 each), links (8 each)
@group(2) @binding(1) var<storage, read_write> giIdx: array<atomic<u32>>;
// each probe's buckets, one per direction: how many rays (low 16 bits) and how many of them found its interval clear
// (high 16), and the light of those that met something in it (r, g, b in fixed point)
@group(2) @binding(2) var<storage, read_write> giDep: array<atomic<u32>>;
@group(2) @binding(3) var<storage, read_write> giVal: array<vec4f>;
// where each pixel's mesh is and which way it faces (the prepass's)
@group(2) @binding(4) var giPos: texture_2d<f32>;
@group(2) @binding(5) var giNrm: texture_2d<f32>;
// where each ray landed, where light bounces more than once (giU.bounces): how far along it (x: f32 bits; GI_NONE: on
// nothing that bounces it), which way what it met faces (y: giOct, 16 bits each way), how much of the light around it
// comes back along the ray (z: 9 bits each, 0–1) and the cascade it was deposited in at its level and, where it is in
// their overlap, the level above (z: bits 27–28, 29–30), and what the bounce before brought back (w: giPackL). A pixel's
// rays first (k of the point at c: (c.y · recW + c.x) · rays + k), then the reflections' hits' (from recHits)
@group(2) @binding(8) var<storage, read_write> giRec: array<vec4u>;
` + GI_LOOK(true) + /* wgsl */`
const GI_SCALE = 4096.0;
const GI_MAX = 64.0;   // (a ray's light, at most: a deposit's sum stays inside 32 bits)
// light as one u32 (a shared exponent, 9 bits each: E5B9G9R9, as GPUs keep it)
fn giPackL(v: vec3f) -> u32 {
  let m = max(v.r, max(v.g, v.b));
  if (!(m > 1e-6)) { return 0u; }
  let e = clamp(i32(floor(log2(m))) + 1, -15, 16);
  let q = min(vec3u(round(v / exp2(f32(e - 9)))), vec3u(511u));
  return q.r | (q.g << 9u) | (q.b << 18u) | (u32(e + 15) << 27u);
}
fn giUnpackL(u: u32) -> vec3f { return vec3f(f32(u & 511u), f32((u >> 9u) & 511u), f32((u >> 18u) & 511u)) * exp2(f32(i32(u >> 27u) - 24)); }
// the pixel that sends rays at c on their grid: one in each stride × stride, which one turning each sub-frame (spread by
// the R2 sequence), so that thin things have their turn
fn giShift() -> vec2u { let i = f32(u32(cam.phase / cam.weight)); return min(vec2u(fract(i * vec2f(0.7548777, 0.5698403)) * f32(giU.stride)), vec2u(giU.stride - 1u)); }
fn giSender(c: vec2u) -> vec2u { return c * giU.stride + giShift(); }
// the first of point c's rays in giRec (a pixel's that sends them, or, hits, a hit's)
fn giSlot(c: vec2u, hits: bool) -> u32 { return select(0u, giU.recHits, hits) + (c.y * select(giU.recW, giHitsSize().x, hits) + c.x) * giU.rays; }
fn giDirs(n: u32) -> u32 { return 32u << (2u * n); }
// the hits: one for each hit × hit of the frame's pixels and each of the ways probes are made out of sight
// (giReach: their rows one after the other, reflections' first), the hits grid's size, hit c's point (w 1: it needs
// probes) and which way it faces, and its block of pixels
fn giBlocks() -> vec2u { return (vec2u(cam.drawn) + giU.hit - 1u) / giU.hit; }
fn giHitsSize() -> vec2u { return giBlocks() * vec2u(1u, countOneBits(giU.lands)); }
fn giHit(c: vec2u) -> u32 { return giU.hits + (c.y * giHitsSize().x + c.x) * 2u; }
fn giHitBlock(c: vec2u) -> vec2u { return vec2u(c.x, c.y % giBlocks().y); }
fn giCellOf(k: GIKey) -> vec3i { return vec3i(i32(k.lo & 0xfffffu), i32((k.lo >> 20u) | ((k.hi & 0xffu) << 12u)), i32((k.hi >> 8u) & 0xfffffu)) - vec3i(524288); }
fn giLodOf(k: GIKey) -> u32 { return k.hi >> 28u; }
fn giProbeKey(n: u32, p: u32) -> GIKey { return GIKey(atomicLoad(&giIdx[giU.key[n] + p * 2u]), atomicLoad(&giIdx[giU.key[n] + p * 2u + 1u])); }
// a direction's bucket in cascade n: its cell (u, v) on the 2Θ × Θ equal-area grid (Θ = 4 · 2^n; the poles along y),
// numbered so that its four in cascade n + 1 are 4i … 4i + 3 (as the paper keeps them, in Morton order)
fn giDir(a: f32, b: f32) -> vec3f { let z = 2.0 * b - 1.0; let r = sqrt(max(1.0 - z * z, 0.0)); let ph = a * TAU; return vec3f(r * cos(ph), z, r * sin(ph)); }
fn giBucket(w: vec3f, n: u32) -> u32 {
  let t = 4u << n;
  let u = min(u32(fract(atan2(w.z, w.x) / TAU) * f32(2u * t)), 2u * t - 1u);
  let v = min(u32(clamp(w.y * 0.5 + 0.5, 0.0, 1.0) * f32(t)), t - 1u);
  var i = (v >> n) * 8u + (u >> n);
  for (var k = n; k > 0u; k--) { i = i * 4u + ((u >> (k - 1u)) & 1u) + 2u * ((v >> (k - 1u)) & 1u); }
  return i;
}
fn giBucketDir(i: u32, n: u32) -> vec3f {
  var u = 0u; var v = 0u; var j = i;
  for (var k = 0u; k < n; k++) { u |= (j & 1u) << k; v |= ((j >> 1u) & 1u) << k; j >>= 2u; }
  u |= (j % 8u) << n; v |= (j / 8u) << n;
  let t = 4u << n;
  return giDir((f32(u) + 0.5) / f32(2u * t), (f32(v) + 0.5) / f32(t));
}
// ray k of the point at c on a grid of them (the pixels that send rays, the reflections' hits): its place in its 64 × 64
// tile in Morton order (its rays in turn there), this sub-frame's stretch of the R2 sequence (in fixed point: Roberts'
// constants × 2^32), mapped to the sphere by area, turned into the surface's side
fn giMorton(v: u32) -> u32 { var x = v & 63u; x = (x | (x << 4u)) & 0x0f0fu; x = (x | (x << 2u)) & 0x3333u; x = (x | (x << 1u)) & 0x5555u; return x; }
fn giRay(c: vec2u, N: vec3f, k: u32) -> vec3f {
  let K = giU.rays;
  let i = (giMorton(c.x) | (giMorton(c.y) << 1u)) * K + k + u32(floor(cam.phase * 64.0)) * 4096u * K;
  let w = giDir(f32(i * 3242174889u + 2147483648u) / 4294967296.0, f32(i * 2447445414u + 2147483648u) / 4294967296.0);
  return select(w, -w, dot(w, N) < 0.0);
}
// a ray from X going w that brought back L, stopped at tEnd (1e6: it met nothing): the cascades whose intervals it
// passed saw the way clear, the one where it stopped saw L (the top one, what lies beyond everything: the environment),
// each in its own probe at X (the cell X is in) and bucket; which cascade that was
fn giDeposit(X: vec3f, lod: u32, w: vec3f, L: vec3f, tEnd: f32) -> u32 {
  var tn = giU.reach * giSpacing(0u, lod);
  let q = vec3u(round(L * GI_SCALE));
  for (var n = 0u; n < GI_N; n++) {
    let met = n == GI_N - 1u || tEnd <= tn;
    let p = giFind(n, giKey(vec3i(floor(X / giSpacing(n, lod))), lod));
    if (p != GI_NONE) {
      let b = giU.dep[n] + (p * giDirs(n) + giBucket(w, n)) * 4u;
      if (met) { atomicAdd(&giDep[b], 1u); atomicAdd(&giDep[b + 1u], q.x); atomicAdd(&giDep[b + 2u], q.y); atomicAdd(&giDep[b + 3u], q.z); }
      else { atomicAdd(&giDep[b], 0x10001u); }
    }
    if (met) { return n; }
    tn *= 4.0;
  }
  return GI_N - 1u;
}`;

// GI's passes, in the order they run: probes made where the pixels' meshes are (giAdd, then giFix for any a race left
// out), dispatches sized to them (giArgsFill), their buckets emptied (giZero), each linked to the eight above it
// (giLink); then, after the rays (giTrace), the cascades merged from the top down (giMerge, giMerge0), cascade 0's light
// falling on each probe's surroundings (giIrr), and each pixel's (giShade)
const GI_PASSES = /* wgsl */`
override GN: u32 = 0u;   // (the cascade a pipeline works on)
@group(2) @binding(7) var giOut: texture_storage_2d<rgba16float, write>;
@group(3) @binding(0) var<storage, read_write> giArgs: array<u32>;
// the probe with key k in cascade n, made if there is none. A slot is taken by its key's fingerprint, then given the
// key: a slot with the same fingerprint whose key is not written yet is taken as this one's, which giFix makes sure of
// (it can be another key's, rarely: the same 32-bit fingerprint)
fn giInsert(n: u32, k: GIKey) {
  let h = giFinger(k);
  var s = h & giU.mask[n];
  for (var i = 0; i < 64; i++) {
    let b = giU.tab[n] + s * 4u;
    var st = atomicLoad(&giIdx[b]);
    if (st == 0u) {
      let r = atomicCompareExchangeWeak(&giIdx[b], 0u, h);
      if (r.exchanged) {
        atomicStore(&giIdx[b + 1u], k.lo); atomicStore(&giIdx[b + 2u], k.hi);
        let p = atomicAdd(&giIdx[n], 1u);
        if (p < giU.cap[n]) { atomicStore(&giIdx[b + 3u], p); atomicStore(&giIdx[giU.key[n] + p * 2u], k.lo); atomicStore(&giIdx[giU.key[n] + p * 2u + 1u], k.hi); }
        else { atomicStore(&giIdx[b + 3u], GI_NONE); atomicAdd(&giIdx[4], 1u); }
        return;
      }
      st = r.old_value;
      if (st == 0u) { continue; }   // (it failed spuriously: the same slot again)
    }
    if (st == h) {
      let lo = atomicLoad(&giIdx[b + 1u]); let hi = atomicLoad(&giIdx[b + 2u]);
      if ((lo == k.lo && hi == k.hi) || (lo == 0u && hi == 0u)) { return; }
    }
    s = (s + 1u) & giU.mask[n];
  }
}
fn giPixel(id: vec3u) -> vec4f {
  if (id.x >= u32(cam.drawn.x) || id.y >= u32(cam.drawn.y)) { return vec4f(0.0); }
  return textureLoad(giPos, vec2i(id.xy), 0);
}
// the probes of every cascade at X (giMake); then again for any a race left out (giMend)
fn giMake(X: vec3f, lod: u32) { for (var n = 0u; n < GI_N; n++) { giInsert(n, giKey(vec3i(floor(X / giSpacing(n, lod))), lod)); } }
fn giMend(X: vec3f, lod: u32) {
  for (var n = 0u; n < GI_N; n++) { let k = giKey(vec3i(floor(X / giSpacing(n, lod))), lod); if (giFind(n, k) == GI_NONE) { giInsert(n, k); } }
}
// (a pixel's: of its level, and of the one above where it is in their overlap, giUp)
@compute @workgroup_size(8, 8) fn giAdd(@builtin(global_invocation_id) id: vec3u) {
  let P = giPixel(id);
  if (P.w < 0.5) { return; }
  let d = giDist(P.xyz);
  giMake(P.xyz, giLodAt(d));
  if (giUp(d) > 0.0) { giMake(P.xyz, giLodAt(d) + 1u); }
}
@compute @workgroup_size(8, 8) fn giFix(@builtin(global_invocation_id) id: vec3u) {
  let P = giPixel(id);
  if (P.w < 0.5) { return; }
  let d = giDist(P.xyz);
  giMend(P.xyz, giLodAt(d));
  if (giUp(d) > 0.0) { giMend(P.xyz, giLodAt(d) + 1u); }
}
// the same where the reflections' hits need them (giReach)
fn giHitPoint(id: vec3u) -> vec4f { if (any(id.xy >= giHitsSize())) { return vec4f(0.0); } return giVal[giHit(id.xy)]; }
fn giHitLod(id: vec3u) -> u32 { return u32(giVal[giHit(id.xy) + 1u].w); }
@compute @workgroup_size(8, 8) fn giAddHits(@builtin(global_invocation_id) id: vec3u) { let H = giHitPoint(id); if (H.w > 0.5) { giMake(H.xyz, giHitLod(id)); } }
@compute @workgroup_size(8, 8) fn giFixHits(@builtin(global_invocation_id) id: vec3u) { let H = giHitPoint(id); if (H.w > 0.5) { giMend(H.xyz, giHitLod(id)); } }
fn giCount(n: u32) -> u32 { return min(atomicLoad(&giIdx[n]), giU.cap[n]); }
// (the indirect passes: 64 threads a workgroup, up to 32768 workgroups across, rows of them down)
fn giJob(j: u32, threads: u32) { let g = (threads + 63u) / 64u; giArgs[j * 3u] = min(g, 32768u); giArgs[j * 3u + 1u] = (g + 32767u) / 32768u; giArgs[j * 3u + 2u] = 1u; }
fn giFlat(w: vec3u, l: u32) -> u32 { return (w.y * 32768u + w.x) * 64u + l; }
@compute @workgroup_size(1) fn giArgsFill() {
  // (the probes made where reflections land, in a cascade where they did not all fit: none of them is used, giUsable)
  for (var n = 0u; n < GI_N; n++) { if (giMade(n) > 0u && atomicLoad(&giIdx[n]) > giU.cap[n]) { atomicOr(&giIdx[9], 1u << n); } }
  for (var n = 0u; n < GI_N; n++) {
    let c = giCount(n);
    giJob(n, c * giDirs(n) * 4u);                                       // 0–3: emptying
    giJob(4u + n, c);                                                   // 4–7: links
    giJob(8u + n, c * select(32u, giDirs(max(n, 1u) - 1u), n > 0u));    // 8–11: merging
  }
  giJob(12u, giCount(0u) * 36u);                                        // 12: the maps
}
@compute @workgroup_size(64) fn giZero(@builtin(workgroup_id) w: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = giFlat(w, l);
  if (i < giCount(GN) * giDirs(GN) * 4u) { atomicStore(&giDep[giU.dep[GN] + i], 0u); }
}
// the eight probes of cascade GN + 1 around a probe of cascade GN, for trilinear interpolation (their centres, by its
// own: half its cell's index - 0.25 of theirs each way)
@compute @workgroup_size(64) fn giLink(@builtin(workgroup_id) w: vec3u, @builtin(local_invocation_index) l: u32) {
  let p = giFlat(w, l);
  if (p >= giCount(GN)) { return; }
  let k = giProbeKey(GN, p);
  let b = vec3i(floor((vec3f(giCellOf(k)) + 0.5) * 0.5 - 0.5));
  for (var j = 0u; j < 8u; j++) {
    let q = giFind(GN + 1u, giKey(b + vec3i(i32(j & 1u), i32((j >> 1u) & 1u), i32(j >> 2u)), giLodOf(k)));
    atomicStore(&giIdx[giU.link[GN] + p * 8u + j], select(GI_NONE, q, giUsable(GN + 1u, q)));
  }
}
// cascade m's light in direction q of cascade m - 1 (A, averaged over q's four), at probe p of cascade m - 1:
// trilinearly from the eight around it that have it, as much weight as they had (w 0: none)
fn giAbove(m: u32, p: u32, q: u32) -> vec4f {
  let u = (vec3f(giCellOf(giProbeKey(m - 1u, p))) + 0.5) * 0.5 - 0.5;
  let f = u - floor(u);
  var acc = vec3f(0.0); var ws = 0.0;
  for (var j = 0u; j < 8u; j++) {
    let nb = atomicLoad(&giIdx[giU.link[m - 1u] + p * 8u + j]);
    if (nb == GI_NONE) { continue; }
    let a = giVal[giU.val[m] + nb * giDirs(m - 1u) + q];
    if (a.w <= 0.0) { continue; }
    let o = vec3f(f32(j & 1u), f32((j >> 1u) & 1u), f32(j >> 2u));
    let t = mix(1.0 - f, f, o);
    acc += a.rgb * t.x * t.y * t.z; ws += t.x * t.y * t.z;
  }
  return select(vec4f(0.0), vec4f(acc / ws, 1.0), ws > 0.0);
}
// the light in bucket q of probe p of cascade n: what its rays met within its interval (J), and as much as they found
// it clear (β), what lies beyond (Eq. 6, 7); w 0: no ray went that way
fn giCone(n: u32, p: u32, q: u32) -> vec4f {
  let b = giU.dep[n] + (p * giDirs(n) + q) * 4u;
  let c = atomicLoad(&giDep[b]);
  let all = f32(c & 0xffffu);
  if (all <= 0.0) { return vec4f(0.0); }
  var L = vec3f(f32(atomicLoad(&giDep[b + 1u])), f32(atomicLoad(&giDep[b + 2u])), f32(atomicLoad(&giDep[b + 3u]))) / (GI_SCALE * all);
  let beta = f32(c >> 16u) / all;
  if (n + 1u < GI_N && beta > 0.0) { L += beta * giAbove(n + 1u, p, q).rgb; }
  return vec4f(L, 1.0);
}
// cascade GN (1 and above), merged: each of its probes' light in each direction of the cascade below, the average of
// that direction's four (pre-averaged, as the paper does: only the cascade below reads it)
@compute @workgroup_size(64) fn giMerge(@builtin(workgroup_id) w: vec3u, @builtin(local_invocation_index) l: u32) {
  let D = giDirs(max(GN, 1u) - 1u);
  let i = giFlat(w, l);
  let p = i / D; let d = i % D;
  if (p >= giCount(GN)) { return; }
  var acc = vec3f(0.0); var k = 0.0;
  for (var c = 0u; c < 4u; c++) { let L = giCone(GN, p, d * 4u + c); if (L.w > 0.0) { acc += L.rgb; k += 1.0; } }
  giVal[giU.val[GN] + p * D + d] = select(vec4f(0.0), vec4f(acc / k, 1.0), k > 0.0);
}
@compute @workgroup_size(64) fn giMerge0(@builtin(workgroup_id) w: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = giFlat(w, l);
  if (i / 32u >= giCount(0u)) { return; }
  giVal[giU.val[0] + i] = giCone(0u, i / 32u, i % 32u);
}
// a place on a probe's 6 × 6 octahedral map ↔ its direction (giOct the other way)
fn giUnOct(uv: vec2f) -> vec3f {
  let e = uv * 2.0 - 1.0;
  var n = vec3f(e.x, 1.0 - abs(e.x) - abs(e.y), e.y);
  if (n.y < 0.0) { n = vec3f((1.0 - abs(n.z)) * select(-1.0, 1.0, n.x >= 0.0), n.y, (1.0 - abs(n.x)) * select(-1.0, 1.0, n.z >= 0.0)); }
  return normalize(n);
}
// the light falling on a surface facing each way at a cascade-0 probe, as the light around it shows on a matte surface
// (the cosine-weighted average of its 32 directions: what (1/π) ∫ L cos gives, as irradiance() gives the
// environment's), from the directions its rays went (w: their share of the cosine)
@compute @workgroup_size(64) fn giIrr(@builtin(workgroup_id) w: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = giFlat(w, l);
  let p = i / 36u; let e = i % 36u;
  if (p >= giCount(0u)) { return; }
  let t = giUnOct((vec2f(f32(e % 6u), f32(e / 6u)) + 0.5) / 6.0);
  var E = vec3f(0.0); var W = 0.0; var A = 0.0;
  for (var q = 0u; q < 32u; q++) {
    let c = max(dot(t, giBucketDir(q, 0u)), 0.0);
    A += c;
    let L = giVal[giU.val[0] + p * 32u + q];
    if (L.w > 0.0) { E += L.rgb * c; W += c; }
  }
  giVal[giU.maps + i] = select(vec4f(0.0), vec4f(E / W, W / A), W > 0.0);
}
// Light bouncing once more: each of a point's rays (as giSend sent them) again where it landed, what it met lit too by
// the light around it there as the merged cascades now have it (giAround, as a reflection's ray finds it), and what
// that brings back beyond what the bounce before did added to its deposit (in the cascade it was deposited in: the
// light alone, its ray counted already; in 32-bit integers, so that what is taken back is exactly what was added)
fn giMore(X: vec3f, lod: u32, w: vec3f, d: vec3i, n: u32) {
  let p = giFind(n, giKey(vec3i(floor(X / giSpacing(n, lod))), lod));
  if (p == GI_NONE) { return; }
  let b = giU.dep[n] + (p * giDirs(n) + giBucket(w, n)) * 4u;
  atomicAdd(&giDep[b + 1u], bitcast<u32>(d.x)); atomicAdd(&giDep[b + 2u], bitcast<u32>(d.y)); atomicAdd(&giDep[b + 3u], bitcast<u32>(d.z));
}
fn giAgain(X: vec3f, N: vec3f, lod: u32, both: bool, c: vec2u, slot: u32) {
  let O = X + N * 0.5;
  for (var k = 0u; k < giU.rays; k++) {
    let r = giRec[slot + k];
    if (r.x == GI_NONE) { continue; }
    let w = giRay(c, N, k);
    let t = bitcast<f32>(r.x);
    let n = giUnOct(unpack2x16unorm(r.y));
    let a = giAround(O + w * t, n, n, false, length(O - cam.eye) + t).diff;
    // (none there: none in the bounces after either, the probes being the same; nothing was added for it)
    if (a.w < 0.5 && r.w == 0u) { giRec[slot + k].x = GI_NONE; continue; }
    let take = vec3f(f32(r.z & 511u), f32((r.z >> 9u) & 511u), f32((r.z >> 18u) & 511u)) / 511.0;
    let e = giPackL(select(vec3f(0.0), min(take * a.rgb, vec3f(GI_MAX)), a.w > 0.5));
    let d = vec3i(round(giUnpackL(e) * GI_SCALE)) - vec3i(round(giUnpackL(r.w) * GI_SCALE));
    giRec[slot + k].w = e;
    giMore(X, lod, w, d, (r.z >> 27u) & 3u);
    if (both) { giMore(X, lod + 1u, w, d, (r.z >> 29u) & 3u); }
  }
}
@compute @workgroup_size(8, 8) fn giAgainRays(@builtin(global_invocation_id) id: vec3u) {
  let px = giSender(id.xy);
  if (px.x >= u32(cam.drawn.x) || px.y >= u32(cam.drawn.y)) { return; }
  let P4 = textureLoad(giPos, vec2i(px), 0);
  if (P4.w < 0.5) { return; }
  let d = giDist(P4.xyz);
  giAgain(P4.xyz, normalize(textureLoad(giNrm, vec2i(px), 0).xyz), giLodAt(d), giUp(d) > 0.0, id.xy, giSlot(id.xy, false));
}
@compute @workgroup_size(8, 8) fn giAgainHits(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= giHitsSize()) || giHitsOut(0u)) { return; }
  let H = giVal[giHit(id.xy)];
  if (H.w < 0.5) { return; }
  let F = giVal[giHit(id.xy) + 1u];
  giAgain(H.xyz, F.xyz, u32(F.w), false, id.xy, giSlot(id.xy, true));
}
// the light around each pixel's mesh (giAt)
@compute @workgroup_size(8, 8) fn giShade(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(cam.drawn.x) || id.y >= u32(cam.drawn.y)) { return; }
  let P = giPixel(id);
  if (P.w < 0.5) { textureStore(giOut, vec2i(id.xy), vec4f(0.0)); return; }
  let N = normalize(textureLoad(giNrm, vec2i(id.xy), 0).xyz);
  let d = giDist(P.xyz);
  var e = giAt(P.xyz, N, giLodAt(d));
  let up = giUp(d);
  if (up > 0.0) {
    let f = giAt(P.xyz, N, giLodAt(d) + 1u);
    if (e.w < 0.5) { e = f; } else if (f.w > 0.5) { e = mix(e, f, up); }
  }
  textureStore(giOut, vec2i(id.xy), e);
}`;

// GI's rays (with the scene: the shaders' prelude, the sub-frame's surfaces compiled in): from each pixel's mesh (or one
// in four: stride 2), each in a direction of its own (giRay), traced through the scene as reflections are, what it meets
// lit as GI's rays light it (traceLight's gi), the environment where it meets nothing; then split among the cascades by
// how far it went (giDeposit). giBand: x the first row of workgroups of the band this dispatch traces, y 1 where it is the hits'.
const GI_TRACE = /* wgsl */`
@group(2) @binding(6) var<uniform> giBand: vec4u;
@group(2) @binding(9) var<storage, read_write> giFirst: array<RayHit>;
// (giFirst holds this band's rays alone: where a ray's slot is, from the band's first)
fn giMet(slot: u32) -> u32 { return slot - giSlot(vec2u(0u, giBand.x * 8u), giBand.y != 0u); }
// what a point's rays meet first (slot: as giSend's), found in a shader of its own, which giSend then takes it from: a
// walk through the scene is far faster here than inside the shader that goes on to light what it meets, why not known.
// GI's rays at 1080p, 4 samples, a stream being encoded, in spring-brutalist's facade, pergola and pool on an RTX 5070 Ti:
// 325 → 179, 451 → 265 and 674 → 367 ms; the pool on a Radeon 890M: 2183 → 1239. The same rays within rounding: of 2
// million none on the pool met something else, 37 on gi-test, the frame moving a level on at most 0.5% of its pixels.
// (The shadow rays left in giSend's shader would gain the same way, 9 ms against some 30 of the pool's sub-frame, but
// gather would have to be split around them.)
fn giWalk(X: vec3f, N: vec3f, c: vec2u, slot: u32) {
  for (var k = 0u; k < giU.rays; k++) { giFirst[giMet(slot) + k] = traceScene(X + N * 0.5, giRay(c, N, k), 0.2, 1e6); }
}
// a point's rays (at c on its grid; w0: their footprint there), each deposited
// (both: to the level above lod too, a pixel in their overlap), and where it landed kept (slot: its first ray's place
// in giRec), where light bounces again
fn giSend(X: vec3f, N: vec3f, lod: u32, both: bool, c: vec2u, w0: f32, frag: vec2f, slot: u32) {
  for (var k = 0u; k < giU.rays; k++) {
    let w = giRay(c, N, k);
    let got = traceLightFrom(giFirst[giMet(slot) + k], X + N * 0.5, w, 0.15, w0, frag, true);
    let L = select(min(got.light, vec3f(GI_MAX)), vec3f(0.0), got.light != got.light);
    let n0 = giDeposit(X, lod, w, L, got.end);
    var n1 = 0u;
    if (both) { n1 = giDeposit(X, lod + 1u, w, L, got.end); }
    if (giU.bounces > 1u) {
      let t = clamp(got.take, vec3f(0.0), vec3f(1.0)) * 511.0;
      let z = u32(round(t.r)) | (u32(round(t.g)) << 9u) | (u32(round(t.b)) << 18u) | (n0 << 27u) | (n1 << 29u);
      let on = got.hit.w >= 0.0 && max(t.r, max(t.g, t.b)) >= 0.5;
      giRec[slot + k] = select(vec4u(GI_NONE, 0u, 0u, 0u), vec4u(bitcast<u32>(got.hit.w), pack2x16unorm(giOct(got.hit.xyz)), z, 0u), on);
    }
  }
}
@compute @workgroup_size(8, 8) fn giWalkRays(@builtin(global_invocation_id) id: vec3u) {
  let c = id.xy + vec2u(0u, giBand.x * 8u);
  let px = giSender(c);
  if (px.x >= u32(cam.drawn.x) || px.y >= u32(cam.drawn.y)) { return; }
  let P4 = textureLoad(giPos, vec2i(px), 0);
  if (P4.w < 0.5) { return; }
  giWalk(P4.xyz, normalize(textureLoad(giNrm, vec2i(px), 0).xyz), c, giSlot(c, false));
}
@compute @workgroup_size(8, 8) fn giTrace(@builtin(global_invocation_id) id: vec3u) {
  let c = id.xy + vec2u(0u, giBand.x * 8u);
  let px = giSender(c);
  if (px.x >= u32(cam.drawn.x) || px.y >= u32(cam.drawn.y)) { return; }
  let P4 = textureLoad(giPos, vec2i(px), 0);
  if (P4.w < 0.5) { return; }
  let X = P4.xyz;
  let d = giDist(X);
  giSend(X, normalize(textureLoad(giNrm, vec2i(px), 0).xyz), giLodAt(d), giUp(d) > 0.0, c, viewZ(X) / cam.focal, vec2f(px), giSlot(c, false));
}
// Where the camera's reflections look, GI's light is wanted too: a mirror (or near enough) on the floor shows the wall
// behind the camera, the space under a sideboard, and the light falling there is what lights them in it (aroundGI). And
// where light bounces more than once, where GI's rays land: the room behind the camera, lit by its windows, lights the
// wall the camera sees, and a bounce reads the light around what a ray met from the probes there (giAgain). The
// probes are only where the camera sees a surface, so for one pixel in each hit × hit (which one turns each
// sub-frame) this follows its mirror reflection, or its first GI ray (giRay's), to the first thing it cannot see
// through (on through glass; a layer ends it, as it takes no light) and, where no probe is there yet, keeps that
// point: probes are made there (giAddHits) and it sends GI's rays as a pixel does (giTraceHits). The reflections' own
// rays are spread round the mirror direction by their roughness, GI's every way; what they meet near these is lit from
// them, further off from what the camera sees, or else (a reflection's) the environment.
@compute @workgroup_size(8, 8) fn giReach(@builtin(global_invocation_id) id: vec3u) {
  // (the probes made so far, where the camera sees a surface: those made from here on are where reflections land)
  if (all(id.xy == vec2u(0u))) { for (var n = 0u; n < GI_N; n++) { atomicStore(&giIdx[5u + n], atomicLoad(&giIdx[n])); } }
  if (any(id.xy >= giHitsSize())) { return; }
  let at = giHit(id.xy);
  giVal[at] = vec4f(0.0);
  let j = u32(floor(cam.phase * 64.0)) % 16u;
  let px = giHitBlock(id.xy) * giU.hit + vec2u(vec2f(f32(j % 4u), f32(j / 4u)) * f32(giU.hit) / 4.0);
  if (px.x >= u32(cam.drawn.x) || px.y >= u32(cam.drawn.y)) { return; }
  let P4 = textureLoad(giPos, vec2i(px), 0);
  if (P4.w < 0.5) { return; }
  let N = normalize(textureLoad(giNrm, vec2i(px), 0).xyz);
  // (GI's rays' rows: those after the reflections', or all where there are none)
  let ray = (giU.lands & 1u) == 0u || id.y >= giBlocks().y;
  let D = select(reflect(-normalize(cam.eye - P4.xyz), N), giRay(px / giU.stride, N, 0u), ray);
  var O = P4.xyz + N * 0.5;
  for (var k = 0; k < 6; k++) {
    let h = traceScene(O, D, 0.2, 1e6);
    if (h.item < 0) { return; }
    let x = itemAt(h.item);
    if (x.copy < 0) { return; }
    if (materialAt(x.node).transmission > 0.0) { O += D * h.t; continue; }
    let X = O + D * h.t;
    let lod = giLod(X);
    if (giFind(0u, giKey(vec3i(floor(X / giSpacing(0u, lod))), lod)) != GI_NONE) { return; }
    let n = pointAt(h, O, D, 0.0).N;
    giVal[at] = vec4f(X, 1.0);
    // (its probes' level of detail by how far it is along the way the camera sees it, by the reflection: as large in
    // the reflection as the camera's own are on the frame, where by its distance from the eye a wall just behind the
    // camera would be cut as finely as one in front of it)
    // (and a level coarser where GI's rays landed: what a bounce brings is soft, and they land all around the camera:
    // gi-test's top cascade needs 3775 → 2997 of the probes, nearer Cycles rather than further: giAround finds them)
    giVal[at + 1u] = vec4f(select(n, -n, dot(n, D) > 0.0), f32(min(giLodAt(length(P4.xyz - cam.eye) + length(X - P4.xyz)) + select(0u, 1u, ray), 15u)));
    return;
  }
}
@compute @workgroup_size(8, 8) fn giWalkHits(@builtin(global_invocation_id) id: vec3u) {
  let c = id.xy + vec2u(0u, giBand.x * 8u);
  if (any(c >= giHitsSize()) || giHitsOut(0u)) { return; }
  let H = giVal[giHit(c)];
  if (H.w < 0.5) { return; }
  giWalk(H.xyz, giVal[giHit(c) + 1u].xyz, c, giSlot(c, true));
}
@compute @workgroup_size(8, 8) fn giTraceHits(@builtin(global_invocation_id) id: vec3u) {
  let c = id.xy + vec2u(0u, giBand.x * 8u);
  if (any(c >= giHitsSize()) || giHitsOut(0u)) { return; }
  let H = giVal[giHit(c)];
  if (H.w < 0.5) { return; }
  let F = giVal[giHit(c) + 1u];
  giSend(H.xyz, F.xyz, u32(F.w), false, c, length(H.xyz - cam.eye) / cam.focal, vec2f(giHitBlock(c) * giU.hit), giSlot(c, true));
}`;

// an object of promised pipelines (and lists of them, nulls kept), once every one is made
async function made(o) {
  const out = {};
  await Promise.all(Object.entries(o).map(async ([k, v]) => { out[k] = Array.isArray(v) ? await Promise.all(v) : await v; }));
  return out;
}

export const gi = {
  name: 'gi', stage: 'sub', reads: ['position', 'normal'], writes: ['gi'],
  setup() {},
  // (its pipelines and buffers are made the first time a scene asks for it: most films never do)
  pipes(R) {
    if (this.P) return this.P;
    const dev = R.dev, CS = GPUShaderStage.COMPUTE, tex = { texture: { sampleType: 'unfilterable-float' } };
    this.layout = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: CS, buffer: {} }, ...[1, 2, 3].map((binding) => ({ binding, visibility: CS, buffer: { type: 'storage' } })),
      { binding: 4, visibility: CS, ...tex }, { binding: 5, visibility: CS, ...tex }, { binding: 6, visibility: CS, buffer: { hasDynamicOffset: true } },
      { binding: 7, visibility: CS, storageTexture: { access: 'write-only', format: 'rgba16float' } }, { binding: 8, visibility: CS, buffer: { type: 'storage' } }, { binding: 9, visibility: CS, buffer: { type: 'storage' } }] });
    this.argsLayout = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: CS, buffer: { type: 'storage' } }] });
    // (each band's first row of workgroups, 256 bytes apart, read at a dynamic offset: the pixels' bands, then the
    // reflections' hits')
    this.bandBuf = dev.createBuffer({ size: 128 * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const code = R.module(COMMON + GI_CORE + GI_PASSES, 'gi');
    // (each made away from the GPU process's main thread, all at once: R.pipeline; the set, once they all are)
    const pipe = (entryPoint, constants, args) => R.pipeline(`gi ${entryPoint}${constants ? ` ${constants.GN}` : ''}`, () => ({ layout: R.pipelineLayout([R.layouts.frame, R.layouts.scene, this.layout, ...(args ? [this.argsLayout] : [])]),
      compute: { module: code, entryPoint, ...(constants && { constants }) } }), true);
    const each = (entry, ns) => ns.map((n) => pipe(entry, { GN: n }));
    this.P = made({ add: pipe('giAdd'), fix: pipe('giFix'), addHits: pipe('giAddHits'), fixHits: pipe('giFixHits'), args: pipe('giArgsFill', null, true), zero: each('giZero', [0, 1, 2, 3]), link: each('giLink', [0, 1, 2]),
      merge: [null, ...each('giMerge', [1, 2, 3])], merge0: pipe('giMerge0'), irr: pipe('giIrr'), shade: pipe('giShade'), againRays: pipe('giAgainRays'), againHits: pipe('giAgainHits') });
    this.P.catch(() => { this.P = null; });
    return this.P;
  },
  // the pipelines that trace, for the sub-frame's surfaces: the pixels' rays, where the reflections land, their rays
  trace(R) {
    let T = (this.T ??= new Map()).get(R.surfaceKey);
    if (!T) {
      const code = R.module(R.prelude() + GI_CORE + GI_TRACE, 'gi rays'), key = R.surfaceKey;
      const pipe = (entryPoint) => R.pipeline(`gi rays ${key} ${entryPoint}`, () => ({ layout: R.pipelineLayout([R.layouts.frame, R.layouts.scene, this.layout]), compute: { module: code, entryPoint } }), true);
      T = made({ walk: pipe('giWalkRays'), rays: pipe('giTrace'), reach: pipe('giReach'), walkHits: pipe('giWalkHits'), hits: pipe('giTraceHits') });
      this.T.set(key, T);
      T.catch(() => { if (this.T.get(key) === T) this.T.delete(key); });
    }
    return T;
  },
  /**
   * Its buffers, for probes P drawn px across: room for as many probes as a frame of the film's size needs at that size
   * (cascade 0: one for every 16 of its pixels at 16 px — a street of lamps, kerbs and railings made one for every 27;
   * cascade 1 three eighths of that, half as much again as a quarter for scattered things, each above it 1/3.2 of the
   * one below, as gi-test and spring-brutalist need rather than a quarter), their tables half full at most. A frame
   * that needs more leaves the rest out (counted: stats), which ones as its threads happen to run: it is then no longer
   * the same on every worker. And room for the hits, one for each hit² pixels drawn and each way probes are made out of
   * sight (giReach).
   */
  sized(R, P, hitAsked) {
    const hit = hitAsked ? Math.max(1, Math.round(hitAsked)) : hitOf(P), hits = Math.ceil(R.pw / hit) * Math.ceil(R.ph / hit) * 2;
    if (this.G?.P === P && this.G.hit === hit && this.G.hits >= hits) return this.G;
    const dev = R.dev, B = GPUBufferUsage, old = this.G;
    for (const b of old ? [old.idx, old.dep, old.val, old.args, old.u] : []) b.destroy();
    const dirs = (n) => 32 * 4 ** n, area = ((W * H) / 16) * (GI_PROBE / P) ** 2;
    const cap = [0, 1, 2, 3].map((n) => Math.max(256, Math.ceil((area * (n ? 0.375 / 3.2 ** (n - 1) : 1)) / 64) * 64));
    const slots = cap.map((c) => 2 ** Math.ceil(Math.log2(2 * c)));
    // where each part starts: giIdx (u32: the counts, the tables, the probes' keys, their links), giDep (u32), giVal (vec4)
    let at = 16;
    const tab = slots.map((s) => { const a = at; at += s * 4; return a; }), head = at;
    const key = cap.map((c) => { const a = at; at += c * 2; return a; });
    const link = cap.map((c, n) => { const a = at; if (n < 3) at += c * 8; return a; });
    const idxWords = at;
    at = 0; const dep = cap.map((c, n) => { const a = at; at += c * dirs(n) * 4; return a; }); const depWords = at;
    at = 0; const val = cap.map((c, n) => { const a = at; at += c * (n ? dirs(n - 1) : 32); return a; }); const maps = at; at += cap[0] * 36;
    const hitsAt = at; at += hits * 2;
    const data = new ArrayBuffer(160), u = new Uint32Array(data);   // (GIU: 156 bytes, 160 as a uniform)
    [cap, slots.map((s) => s - 1), tab, key, link, dep, val].forEach((v, k) => u.set(v, 4 + k * 4));
    u[32] = maps; u[33] = hitsAt; u[38] = hit;
    this.G = { P, hit, hits, cap, head, data, f: new Float32Array(data), w: u,
      idx: dev.createBuffer({ size: idxWords * 4, label: 'GI probes', usage: B.STORAGE | B.COPY_DST | B.COPY_SRC }),
      dep: dev.createBuffer({ size: depWords * 4, label: 'GI deposits', usage: B.STORAGE }),
      val: dev.createBuffer({ size: at * 16, label: 'GI light', usage: B.STORAGE }),
      args: dev.createBuffer({ size: 13 * 12, label: 'GI dispatches', usage: B.STORAGE | B.INDIRECT }),
      u: dev.createBuffer({ size: 160, usage: B.UNIFORM | B.COPY_DST }) };
    this.G.argsBG = dev.createBindGroup({ layout: this.argsLayout, entries: [{ binding: 0, resource: { buffer: this.G.args } }] });
    this.bgGen = null;
    return this.G;
  },
  /**
   * Room for where each of a sub-frame's rays landed (giRec: 16 bytes each), where light bounces more than once: the
   * pixels' rays (recW across), then the hits' (from recHits: rows of them for each way probes are made out of sight).
   * Grown as a sub-frame needs more (the rays a pixel sends in it); none (16 bytes) where light bounces once. And room
   * for what each ray of a band meets first (giFirst: 24 bytes each), read in that band alone, so that it does not grow
   * with the rays a frame traces. bandRows, hitRows: the most rows of points a band of them has.
   */
  records(R, stride, K, bounces, kinds, bandRows, hitRows) {
    const recW = Math.ceil(R.pw / stride), recHits = recW * Math.ceil(R.ph / stride) * K, hit = this.G.hit;
    const rays = recHits + Math.ceil(R.pw / hit) * Math.ceil(R.ph / hit) * kinds * K, size = bounces > 1 ? rays * 16 : 16;
    if (!this.rec || this.rec.size < size) { this.rec?.destroy(); this.rec = R.dev.createBuffer({ size, label: 'GI rays landed', usage: GPUBufferUsage.STORAGE }); this.bgGen = null; }
    const met = Math.max(bandRows * recW, hitRows * Math.ceil(R.pw / hit)) * K * 24;
    if (!this.first || this.first.size < met) { this.first?.destroy(); this.first = R.dev.createBuffer({ size: met, label: 'GI rays first met', usage: GPUBufferUsage.STORAGE }); this.bgGen = null; }
    return { recW, recHits };
  },
  // (its pipelines, and those that trace for the scene's surfaces: pipes sets up what trace's are made with)
  want(R, sub) { if (sub.gi) { this.pipes(R); this.trace(R); } },
  async run(R, sub) {
    const o = sub.gi;
    if (!o) { R.enc.beginRenderPass({ label: 'gi', colorAttachments: [R.clear('gi')] }).end(); return; }
    const dev = R.dev, P = await this.pipes(R), G = this.sized(R, Math.max(4, o.probe ?? GI_PROBE), o.hit);
    // (how many rays a pixel sends this sub-frame: the rays that fill a probe are what its light's grain depends on, and
    // a probe twice as wide takes them from four times the pixels, so as many reach each whatever its size: below one, one
    // pixel in each stride × stride sends them)
    // (rays a pixel a frame, 4 by default, and one a sub-frame at least, as the lights' shadows have more rays a sub-frame
    // where a frame has fewer: a lone sub-frame, scrubbing or the director's view, sends 4; a preview's 4 and a render's
    // 8, one each; below 1, one from every fourth pixel a sub-frame; once: all of them on its one sub-frame)
    const rays = o.rays ?? 4, wanted = (rays < 1 ? 0.25 : Math.max(1, Math.ceil(o.once ? rays : rays * sub.weight))) * (GI_PROBE / G.P) ** 2;
    const stride = wanted < 1 ? Math.round(Math.sqrt(1 / wanted)) : 1, again = !o.once || sub.first;
    // (probes out of the camera's sight: where its reflections land, where the scene's are traced; where GI's rays land,
    // where light bounces more than once)
    const bounces = Math.max(1, Math.round(o.bounces ?? 1)), lands = (sub.reflect ? 1 : 0) | (bounces > 1 ? 2 : 0), kinds = (lands & 1) + (lands >> 1);
    // (as many as where they land can be kept in one binding of the GPU's: records, as one sub-frame of once may ask)
    const K = Math.min(Math.max(1, Math.ceil(wanted)), bounces > 1 ? Math.max(1, Math.floor(dev.limits.maxStorageBufferBindingSize / 16 / (Math.ceil(R.pw / stride) * Math.ceil(R.ph / stride) + Math.ceil(R.pw / G.hit) * Math.ceil(R.ph / G.hit) * kinds))) : Infinity);
    // the rays in bands of rows, each sent on its own, as the heavy passes are (as many again as a pixel sends rays): a
    // GPU turns to the desktop only between them, and one that runs too long at once is lost (a heavy scene's rays on
    // an integrated GPU: a second and more)
    // (and the hits' rays, their bands from the 64th on)
    // (each band of them no more rays than one of the pixels': they are one for every hit² pixels, so a few bands at
    // most; split as finely as the pixels' rays, each band's passes cost more than its rays: 8 ms against 1.5 for one)
    // (where the scene's reflections are traced, they want GI's light where they land too, and a bounce where GI's rays
    // land: giReach; their hits' rows one way after the other)
    const reach = again && lands > 0, hw = Math.ceil(R.pw / G.hit), hh = Math.ceil(R.ph / G.hit) * kinds, hrows = Math.ceil(hh / 8);
    const rows = Math.ceil(R.ph / stride / 8), n = Math.min(64, rows, Math.ceil((R.bands * K) / (stride * stride)));
    const m = reach ? Math.min(hrows, Math.ceil((n * stride * stride) / (G.hit * G.hit))) : 0;
    const { recW, recHits } = this.records(R, stride, K, bounces, kinds, Math.ceil(rows / n) * 8, m ? Math.ceil(hrows / m) * 8 : 0);
    if (this.bgGen !== R.tex.gen) {
      this.bgGen = R.tex.gen;
      this.bg = dev.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer: G.u } }, { binding: 1, resource: { buffer: G.idx } }, { binding: 2, resource: { buffer: G.dep } },
        { binding: 3, resource: { buffer: G.val } }, { binding: 4, resource: R.view('position') }, { binding: 5, resource: R.view('normal') },
        { binding: 6, resource: { buffer: this.bandBuf, size: 16 } }, { binding: 7, resource: R.view('gi') }, { binding: 8, resource: { buffer: this.rec } }, { binding: 9, resource: { buffer: this.first } }] });
    }
    // (cascade 0's spacing at level 0: a probe that far from the eye is P drawn px across, see giD0)
    G.f[0] = G.P / 4 / R.rs; G.f[1] = o.reach ?? GI_REACH; G.w[2] = stride; G.w[3] = K;
    G.w[34] = bounces; G.w[35] = recW; G.w[36] = recHits; G.w[37] = lands;
    dev.queue.writeBuffer(G.u, 0, G.data);
    if (again) R.enc.clearBuffer(G.idx, 0, G.head * 4);
    // (each stage a pass of its own, named: what a profile of the frame shows)
    const px = [Math.ceil(R.pw / 8), Math.ceil(R.ph / 8)];
    const stage = (label, run) => { const c = R.enc.beginComputePass({ label: `gi ${label}` }); run(c); c.end(); };
    const go = (c, pipe, band = 0) => { c.setPipeline(pipe); c.setBindGroup(0, R.frameBG); c.setBindGroup(1, R.sceneBG); c.setBindGroup(2, this.bg, [band * 256]); };
    const job = (c, j) => c.dispatchWorkgroupsIndirect(G.args, j * 12);
    const T = again ? await this.trace(R) : null;
    if (again) {
      stage('probes', (c) => {
        go(c, P.add); c.dispatchWorkgroups(...px);
        go(c, P.fix); c.dispatchWorkgroups(...px);
        if (reach) {
          const hx = [Math.ceil(hw / 8), Math.ceil(hh / 8)];
          go(c, T.reach); c.dispatchWorkgroups(...hx);
          go(c, P.addHits); c.dispatchWorkgroups(...hx);
          go(c, P.fixHits); c.dispatchWorkgroups(...hx);
        }
        go(c, P.args); c.setBindGroup(3, G.argsBG); c.dispatchWorkgroups(1);
        for (let n = 0; n < 4; n++) { go(c, P.zero[n]); job(c, n); }
        for (let n = 0; n < 3; n++) { go(c, P.link[n]); job(c, 4 + n); }
      });
      const at = new Uint32Array(128 * 64);
      for (let b = 0; b < n; b++) at[b * 64] = Math.floor((b * rows) / n);
      for (let b = 0; b < m; b++) { at[(64 + b) * 64] = Math.floor((b * hrows) / m); at[(64 + b) * 64 + 1] = 1; }
      dev.queue.writeBuffer(this.bandBuf, 0, at, 0, (m ? 64 + m : n) * 64);
      for (let b = 0; b < n; b++) {
        const size = [Math.ceil(R.pw / stride / 8), Math.floor(((b + 1) * rows) / n) - Math.floor((b * rows) / n)];
        stage('walk', (c) => { go(c, T.walk, b); c.dispatchWorkgroups(...size); });
        stage('rays', (c) => { go(c, T.rays, b); c.dispatchWorkgroups(...size); });
        if (n > 1) R.cut();
      }
      for (let b = 0; b < m; b++) {
        const size = [Math.ceil(hw / 8), Math.floor(((b + 1) * hrows) / m) - Math.floor((b * hrows) / m)];
        stage('walk where they land', (c) => { go(c, T.walkHits, 64 + b); c.dispatchWorkgroups(...size); });
        stage('rays where they land', (c) => { go(c, T.hits, 64 + b); c.dispatchWorkgroups(...size); });
        if (m > 1) R.cut();
      }
      const merge = () => stage('merge', (c) => {
        for (let n = 3; n > 0; n--) { go(c, P.merge[n]); job(c, 8 + n); }
        go(c, P.merge0); job(c, 8);
        go(c, P.irr); job(c, 12);
      });
      merge();
      // (each bounce more: the rays' light again where they landed, lit by what the merge before found there, merged)
      for (let b = 1; b < bounces; b++) {
        stage('bounce', (c) => {
          go(c, P.againRays); c.dispatchWorkgroups(Math.ceil(R.pw / stride / 8), Math.ceil(R.ph / stride / 8));
          if (reach) { go(c, P.againHits); c.dispatchWorkgroups(Math.ceil(hw / 8), Math.ceil(hh / 8)); }
        });
        merge();
      }
    }
    stage('shade', (c) => { go(c, P.shade); c.dispatchWorkgroups(...px); });
    // (what it found, for the passes after it to read where their rays meet something: giReader)
    sub.giProbes = { u: G.u, idx: G.idx, val: G.val };
  },
  /** How many probes the last sub-frame made in each cascade, how many each had room for, and how many were left out. */
  async stats(R) {
    if (!this.G) return null;
    const b = R.dev.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), enc = R.dev.createCommandEncoder();
    enc.copyBufferToBuffer(this.G.idx, 0, b, 0, 32);
    R.dev.queue.submit([enc.finish()]);
    await b.mapAsync(GPUMapMode.READ);
    const v = [...new Uint32Array(b.getMappedRange())];
    b.destroy();
    return { probes: v.slice(0, 4), room: this.G.cap, left: v[4] };
  },
};
