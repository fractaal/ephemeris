// Rays, WGSL. What the scene's light is traced through: every copy of every mesh and every layer in the world, in a
// hierarchy over them (the scene's tables, built again each frame where things move), each model's triangles in a
// hierarchy of their own (the geometry, built once) — the two levels hardware ray tracing uses. Boxes and spheres are met
// as their solid form, layers as their planes. What a ray meets is a surface as the camera would see it there
// (surfaceAt), lit by the same lights (gather) and the environment; glass it passes lets it on through, tinted; a layer's
// see-through parts let it on. Shadows, reflections, GI and glass all trace through here. A shadow's ray asks only
// whether anything stops light on its way (rayBlocked: the first such thing found ends it), not which thing is nearest.
// The walks go through each tree in one fixed order, by each node's skip pointer, whichever way the ray goes. Nearest child
// first with a stack, tried on GI's rays, was slower: 0.58 to 1.03 times the speed on an RTX 5070 Ti and 0.20 on a Radeon 890M,
// whose device was lost on spring-brutalist's pool (2026-11-03).
export const EMIT_BRIGHT = 2;   // (with GI: an emitter brighter than this, its luminance, is sampled from the pixels it lights)
// (a stochastic ray's light, at most, where it is added to a pixel it did not come from: one brighter is a firefly, not a
// picture; the camera sees bright things directly, unclamped, and a mirror's one ray is not clamped)
const RAY_MAX = 16;
// The light around what a reflection's or glass's ray meets, beyond the lights' own (aroundHit: what falls on a surface
// there facing N, diff, and, where both is set, facing R, refl; path: how far from the eye it is along the way it is
// seen; w 1 where it is found, 0 where it is not: diff is then the environment's): each shader that traces says where
// it comes from (R.prelude(around)). This, the default, is the
// environment's, as if nothing were in the way; a pass after GI's gives what GI found there instead (aroundGI in
// passes/gi.js), so that a wall in a closed room is as dim in the floor's reflection as it is to the camera, and its
// highlight shows the room rather than the open sky. (GI's own rays take neither: the light they meet is the lights'
// alone, as one bounce has it.)
export const AROUND_ENV = /* wgsl */`
fn aroundHit(X: vec3f, N: vec3f, R: vec3f, both: bool, path: f32) -> Around { return Around(vec4f(irradiance(N), 0.0), vec4f(0.0)); }
`;

export const TRACE = /* wgsl */`
struct Around { diff: vec4f, refl: vec4f };   // (aroundHit's: see AROUND_ENV)
struct RayHit { t: f32, item: i32, prim: i32, b: vec2f };   // how far, what (its entry), which triangle, where on it
// where a ray (from P, 1/direction inv) enters and leaves a box
fn slab(lo: vec3f, hi: vec3f, P: vec3f, inv: vec3f) -> vec2f {
  let t0 = (lo - P) * inv;
  let t1 = (hi - P) * inv;
  return vec2f(max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z)), min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z)));
}
fn safeInv(d: vec3f) -> vec3f { return 1.0 / select(d, vec3f(1e-9), abs(d) < vec3f(1e-9)); }
// where a ray o + d t meets a model's triangle ti, in its own space: (t, and where on it: u, v); t -1 where it does not
fn triHit(sh: Shape, ti: i32, o: vec3f, d: vec3f) -> vec3f {
  let a = geoAt(sh.verts + triVertex(sh.tris, ti * 3) * 2).xyz;
  let e1 = geoAt(sh.verts + triVertex(sh.tris, ti * 3 + 1) * 2).xyz - a;
  let e2 = geoAt(sh.verts + triVertex(sh.tris, ti * 3 + 2) * 2).xyz - a;
  let p = cross(d, e2);
  let det = dot(e1, p);
  if (det == 0.0) { return vec3f(-1.0, 0.0, 0.0); }
  let id = 1.0 / det;
  let w = o - a;
  let u = dot(w, p) * id;
  if (u < 0.0 || u > 1.0) { return vec3f(-1.0, 0.0, 0.0); }
  let q = cross(w, e1);
  let v = dot(d, q) * id;
  if (v < 0.0 || u + v > 1.0) { return vec3f(-1.0, 0.0, 0.0); }
  return vec3f(dot(e2, q) * id, u, v);
}
// the nearest of a model's triangles along o + d t, in its own space (affine: the same t as in the world), if nearer
// than best
fn hitTris(sh: Shape, o: vec3f, d: vec3f, tmin: f32, item: i32, best: ptr<function, RayHit>) {
  let inv = safeInv(d);
  let end = select(i32(geoAt(sh.root).w), 1, geoAt(sh.root + 1).w > 0.5);   // the root: a leaf, or where its subtree ends
  var ni = 0;
  loop {
    if (ni >= end) { break; }
    let lo = geoAt(sh.root + ni * 2);
    let hi = geoAt(sh.root + ni * 2 + 1);
    let s = slab(lo.xyz, hi.xyz, o, inv);
    let count = i32(hi.w);
    if (s.y < max(s.x, tmin) || s.x > (*best).t) { ni = select(i32(lo.w), ni + 1, count > 0); continue; }
    for (var k = 0; k < count; k++) {
      let ti = i32(lo.w) + k;
      let h = triHit(sh, ti, o, d);
      if (h.x > tmin && h.x < (*best).t) { *best = RayHit(h.x, item, ti, h.yz); }
    }
    ni++;
  }
}
// whether any of a model's triangles lies along o + d t, tmin < t < tmax (its own space): the first found ends the walk
fn anyTri(sh: Shape, o: vec3f, d: vec3f, tmin: f32, tmax: f32) -> bool {
  let inv = safeInv(d);
  let end = select(i32(geoAt(sh.root).w), 1, geoAt(sh.root + 1).w > 0.5);
  var ni = 0;
  loop {
    if (ni >= end) { break; }
    let lo = geoAt(sh.root + ni * 2);
    let hi = geoAt(sh.root + ni * 2 + 1);
    let s = slab(lo.xyz, hi.xyz, o, inv);
    let count = i32(hi.w);
    if (s.y < max(s.x, tmin) || s.x > tmax) { ni = select(i32(lo.w), ni + 1, count > 0); continue; }
    for (var k = 0; k < count; k++) {
      let t = triHit(sh, i32(lo.w) + k, o, d).x;
      if (t > tmin && t < tmax) { return true; }
    }
    ni++;
  }
  return false;
}
// a solid (S: half extents, edge radius): a box with rounded edges (a sphere when the radius is its half size)
fn sdSolid(p: vec3f, S: vec4f) -> f32 {
  let q = abs(p) - (S.xyz - vec3f(S.w));
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - S.w;
}
fn nSolid(p: vec3f, S: vec4f) -> vec3f {
  let q = abs(p) - (S.xyz - vec3f(S.w));
  let o = max(q, vec3f(0.0));
  if (dot(o, o) > 1e-10) { return normalize(o * sign(p)); }
  if (q.x >= q.y && q.x >= q.z) { return vec3f(sign(p.x), 0.0, 0.0); }
  if (q.y >= q.z) { return vec3f(0.0, sign(p.y), 0.0); }
  return vec3f(0.0, 0.0, sign(p.z));
}
// where a ray from o going d (unit, in its space) first meets a solid from outside (negative: it does not), exactly: the
// box, then (off its faces' flat parts) its rounded edges as cylinders and its corner as a sphere (Quilez)
fn roundBox(o0: vec3f, d0: vec3f, S: vec4f) -> f32 {
  let size = S.xyz - vec3f(S.w);
  let m = safeInv(d0);
  let n = m * o0;
  let k = abs(m) * S.xyz;
  let t1 = -n - k;
  let t2 = -n + k;
  let tN = max(max(t1.x, t1.y), t1.z);
  let tF = min(min(t2.x, t2.y), t2.z);
  if (tN > tF || tF < 0.0) { return -1.0; }
  // in the first octant, by symmetry
  let sg = select(vec3f(-1.0), vec3f(1.0), o0 + tN * d0 >= vec3f(0.0));
  let ro = o0 * sg;
  let rd = d0 * sg;
  let p = ro + tN * rd - size;
  if (min(min(max(p.x, p.y), max(p.y, p.z)), max(p.z, p.x)) < 0.0) { return tN; }   // on a face's flat part
  let oc = ro - size;
  let dd = rd * rd;
  let oo = oc * oc;
  let od = oc * rd;
  let r2 = S.w * S.w;
  var t = 1e20;
  let hc = (od.x + od.y + od.z) * (od.x + od.y + od.z) - (oo.x + oo.y + oo.z - r2);
  if (hc > 0.0) { t = -(od.x + od.y + od.z) - sqrt(hc); }
  for (var a = 0; a < 3; a++) {
    let j = (a + 1) % 3;
    let l = (a + 2) % 3;
    let A = dd[j] + dd[l];
    let B = od[j] + od[l];
    let h = B * B - A * (oo[j] + oo[l] - r2);
    if (h > 0.0) {
      let e = (-B - sqrt(h)) / A;
      if (e > 0.0 && e < t && abs(ro[a] + rd[a] * e) < size[a]) { t = e; }
    }
  }
  return select(-1.0, t, t < 1e19);
}
// how far a ray from p inside the solid (d: unit, in its space) goes before leaving it: to the sharp box's face, then
// back along the ray onto the rounded surface (each step the distance to it, so it never passes it)
fn exitSolid(p: vec3f, d: vec3f, S: vec4f) -> f32 {
  let s = select(vec3f(-1.0), vec3f(1.0), d >= vec3f(0.0));
  let t = (s * S.xyz - p) / (s * max(abs(d), vec3f(1e-6)));
  var u = max(min(t.x, min(t.y, t.z)), 0.0);
  for (var i = 0; i < 12; i++) { u -= max(sdSolid(p + d * u, S), 0.0); }
  return max(u, 0.0);
}
// a layer in the world: its centre and opacity, its half axes, its picture (a handle) and how bright its light is, and
// whether it is lit as a matte surface is
struct Plane { C: vec3f, opacity: f32, U: vec3f, pic: f32, V: vec3f, bright: f32, lit: bool };
fn planeOf(li: i32) -> Plane {
  let b = world.tables.layers + li * 4;
  let a = scn[b]; let u = scn[b + 1]; let v = scn[b + 2]; let x = scn[b + 3];
  return Plane(a.xyz, a.w, u.xyz, u.w, v.xyz, v.w, x.x > 0.5);
}
// where a ray meets a layer's plane within its edges: distance, and where across it (-1 to 1 each way)
fn hitLayer(L: Plane, P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> vec3f {
  let n = cross(L.U, L.V);
  let dn = dot(D, n);
  if (abs(dn) < 1e-9) { return vec3f(tmax, 0.0, 0.0); }
  let t = dot(L.C - P, n) / dn;
  if (t <= tmin || t >= tmax) { return vec3f(tmax, 0.0, 0.0); }
  let X = P + D * t - L.C;
  let ab = vec2f(dot(X, L.U) / dot(L.U, L.U), dot(X, L.V) / dot(L.V, L.V));
  if (abs(ab.x) > 1.0 || abs(ab.y) > 1.0) { return vec3f(tmax, 0.0, 0.0); }
  return vec3f(t, ab);
}
// a layer's picture where a ray met it (premultiplied light), read at lod
fn planeColor(L: Plane, ab: vec2f, lod: f32) -> vec4f { return texReadLevel(L.pic, ab * 0.5 + 0.5, lod) * L.opacity; }
// what an entry of the scene's hierarchy is: a copy (its instance and node) or a layer (-1 - its index)
struct Item { copy: i32, node: i32 };
fn itemAt(it: i32) -> Item { let x = scn[world.tables.items + it]; return Item(i32(x.x), i32(x.y)); }
// the nearest thing a ray from P going D (unit) meets past tmin and before tmax (item -1: nothing)
fn traceScene(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> RayHit {
  var best = RayHit(tmax, -1, -1, vec2f(0.0));
  if (world.tables.traced == 0) { return best; }
  let T = world.tables.tlas;
  let inv = safeInv(D);
  let end = select(i32(scn[T].w), 1, scn[T + 1].w > 0.5);
  var ni = 0;
  loop {
    if (ni >= end) { break; }
    let lo = scn[T + ni * 2];
    let hi = scn[T + ni * 2 + 1];
    let s = slab(lo.xyz, hi.xyz, P, inv);
    let count = i32(hi.w);
    if (s.y < max(s.x, tmin) || s.x > best.t) { ni = select(i32(lo.w), ni + 1, count > 0); continue; }
    for (var k = 0; k < count; k++) {
      let it = i32(lo.w) + k;
      let x = itemAt(it);
      if (x.copy < 0) {
        let h = hitLayer(planeOf(-x.copy - 1), P, D, tmin, best.t);
        if (h.x < best.t) { best = RayHit(h.x, it, -1, h.yz); }
        continue;
      }
      useCopy(x.copy);
      let sh = shapeOf(x.node);
      let o = objP(P);
      let d = objV(D);
      if (sh.solid) {
        let kd = length(d);
        let t = roundBox(o, d / kd, sh.S) / kd;
        if (t >= tmin && t < best.t) { best = RayHit(t, it, -1, vec2f(0.0)); }
      } else {
        hitTris(sh, o, d, tmin, it, &best);
      }
    }
    ni++;
  }
  return best;
}
// What lies along P + D t (tmin < t < tmax) as a shadow needs it, not which of it is nearest: RAY_STOPPED where something
// there stops light (the walk ends at the first such thing found), else RAY_TINTED where it passes something that only
// tints it (glass, a layer's part-clear picture: rayTransmittance then walks it in order), else RAY_CLEAR.
const RAY_CLEAR = 0;
const RAY_TINTED = 1;
const RAY_STOPPED = 2;
fn rayBlocked(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> i32 {
  if (world.tables.traced == 0) { return RAY_CLEAR; }
  let T = world.tables.tlas;
  let inv = safeInv(D);
  let end = select(i32(scn[T].w), 1, scn[T + 1].w > 0.5);
  var seen = RAY_CLEAR;
  var ni = 0;
  loop {
    if (ni >= end) { break; }
    let lo = scn[T + ni * 2];
    let hi = scn[T + ni * 2 + 1];
    let s = slab(lo.xyz, hi.xyz, P, inv);
    let count = i32(hi.w);
    if (s.y < max(s.x, tmin) || s.x > tmax) { ni = select(i32(lo.w), ni + 1, count > 0); continue; }
    for (var k = 0; k < count; k++) {
      let x = itemAt(i32(lo.w) + k);
      if (x.copy < 0) {
        let L = planeOf(-x.copy - 1);
        let h = hitLayer(L, P, D, tmin, tmax);
        if (h.x < tmax) {
          let a = planeColor(L, h.yz, 0.0).a;
          if (1.0 - a < 0.01) { return RAY_STOPPED; }
          if (a > 0.0) { seen = RAY_TINTED; }
        }
        continue;
      }
      useCopy(x.copy);
      let sh = shapeOf(x.node);
      let o = objP(P);
      let d = objV(D);
      var hit = false;
      if (sh.solid) {
        let kd = length(d);
        let t = roundBox(o, d / kd, sh.S) / kd;
        hit = t >= tmin && t < tmax;
      } else {
        hit = anyTri(sh, o, d, tmin, tmax);
      }
      if (hit) {
        if (materialAt(x.node).transmission <= 0.0) { return RAY_STOPPED; }
        seen = RAY_TINTED;
      }
    }
    ni++;
  }
  return seen;
}
// What a ray met, as a surface point (its copy in use: I). width: the ray's footprint there (world px), which picks the
// level its pictures are read at (ray cones). A solid's pictures are read at their smallest level (their average): its
// uv is not found.
fn pointAt(h: RayHit, P: vec3f, D: vec3f, width: f32) -> Point {
  let x = itemAt(h.item);
  useCopy(x.copy);
  let X = P + D * h.t;
  let sh = shapeOf(x.node);
  let tint = tintOf(x.copy);
  if (sh.solid) {
    let l = objP(X);
    return Point(X, l, worldN(nSolid(l, sh.S)), vec2f(0.5), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec3f(0.0), vec3f(0.0), x.node, tint, l / max(sh.S.xyz, vec3f(1.0)));
  }
  let i0 = triVertex(sh.tris, h.prim * 3); let i1 = triVertex(sh.tris, h.prim * 3 + 1); let i2 = triVertex(sh.tris, h.prim * 3 + 2);
  let a0 = geoAt(sh.verts + i0 * 2); let a1 = geoAt(sh.verts + i1 * 2); let a2 = geoAt(sh.verts + i2 * 2);
  let n0 = geoAt(sh.verts + i0 * 2 + 1); let n1 = geoAt(sh.verts + i1 * 2 + 1); let n2 = geoAt(sh.verts + i2 * 2 + 1);
  let w = 1.0 - h.b.x - h.b.y;
  let t0 = vec2f(a0.w, n0.w);
  let t1 = vec2f(a1.w, n1.w) - t0;
  let t2 = vec2f(a2.w, n2.w) - t0;
  let uv = t0 + t1 * h.b.x + t2 * h.b.y;
  let e1 = worldV(a1.xyz - a0.xyz);
  let e2 = worldV(a2.xyz - a0.xyz);
  // its pictures' texels per world px there (the triangle's share of its uv over its area in the world), as uv per px
  let f = width * sqrt(abs(t1.x * t2.y - t1.y * t2.x) / max(length(cross(e1, e2)), 1e-12));
  let uvf = uvFrame(e1, e2, t1, t2);
  let l = a0.xyz * w + a1.xyz * h.b.x + a2.xyz * h.b.y;
  return Point(X, l, worldN(n0.xyz * w + n1.xyz * h.b.x + n2.xyz * h.b.y), uv, vec2f(f, 0.0), vec2f(0.0, f), uvf[0], uvf[1], x.node, tint, X / 300.0);
}
// light i as seen from X: the cone of directions it fills there (a sun: its disc in the sky; a point or spot: its bulb, a
// sphere of its radius) — its axis, the cosine of its half-angle, and its solid angle (sr); from within a bulb, the
// half of the sky toward its centre
struct Cone { w: vec3f, cosMax: f32, solid: f32 };
fn lightCone(i: i32, X: vec3f) -> Cone {
  let l = world.lights[i];
  if (l.kind > 1.5) { let s = sin(l.size); let c = cos(l.size); return Cone(-l.dir, c, TAU * s * s / (1.0 + c)); }
  let v = l.pos - X;
  let d2 = max(dot(v, v), 1e-12);
  let s2 = min(l.radius * l.radius / d2, 1.0);   // (the half-angle's sine, squared: 1 - cos without cancelling)
  let c = sqrt(1.0 - s2);
  return Cone(v * inverseSqrt(d2), c, TAU * s2 / (1.0 + c));
}
// a direction in cone C, uniformly over its solid angle (so with probability density 1 / C.solid), for u in [0, 1)²
fn inCone(C: Cone, u: vec2f) -> vec3f {
  let e = u.x * C.solid / TAU;   // (1 - cos of its angle from the axis)
  let st = sqrt(max(e * (2.0 - e), 0.0));
  let T1 = normalize(cross(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(C.w.y) > 0.9), C.w));
  let T2 = cross(C.w, T1);
  return normalize((T1 * cos(TAU * u.y) + T2 * sin(TAU * u.y)) * st + C.w * (1.0 - e));
}
// a direction in cone C as inCone draws it, over a surface of normal N that C's axis is over: one under the surface is
// swapped for its opposite across the axis, which is over it. A light on the surface's horizon then sends all its rays
// where they can find what hides it. Under the surface they would find nothing, and the ratio of what they found would be
// 1: a point the light cannot reach would show it whole. (The swap is ours, not a paper's: the part of the light opposite
// what is under the horizon counts twice. Against Cycles, a floor behind a wall under a 24° sun 3° up: where the wall hides
// all of it, 0.1% through, 34% without the swap; the share through along the floor, RMSE 0.066, 0.263 without it.)
fn inConeOver(C: Cone, u: vec2f, N: vec3f) -> vec3f {
  let D = inCone(C, u);
  return select(reflect(-D, C.w), D, dot(D, N) > 0.0);
}
// this pixel's sample s of this sub-frame, for light i (salt: which kind of sample): three numbers in [0, 1), a rotated R3
// sequence, each pixel and light its own
fn lightU(frag: vec2f, i: i32, s: f32, salt: f32) -> vec3f {
  let h = vec3f(hash3(vec3f(frag, salt + f32(i))), hash3(vec3f(frag.yx, salt + 13.0 + f32(i))), hash3(vec3f(frag, salt + 31.0 + f32(i))));
  return fract(h + (floor(cam.phase * 64.0) * 16.0 + s) * vec3f(0.8191725, 0.6710436, 0.5497005));
}
// how much of light i reaches X (normal N) along D, a direction in its cone: each colour, as glass on the way tints it and
// a layer's see-through parts let it by. What lies within a light's radius (its own bulb) does not shadow it. From a hair
// above the surface, and whatever it meets however near: a ray going away from a surface cannot meet it again, and a wider
// margin let light through wherever two things touch (gi-test's beams: the ceiling beside one, starting inside its rounded
// edge, saw the lantern straight through it).
const RAY_LIFT = 0.05;
// (Two calls of rayTransmittance, though the rest of the walk is called from one place, see Lobe: one here as well
// compiled a shader in about 5 s rather than 7 on an RTX 5070 Ti, but the opaque pass then took longer, why not known:
// gi-test 36 → 48 ms, spring-brutalist 199 → 344, doctor-who 69 → 78.)
fn shadowRay(X: vec3f, N: vec3f, i: i32, D: vec3f) -> vec3f {
  if (world.tables.traced == 0) { return vec3f(1.0); }
  let l = world.lights[i];
  let O = X + N * RAY_LIFT;
  if (l.kind > 1.5) { return rayTransmittance(O, D, 1e6, RAY_UNSTOPPED); }
  // (to where the ray meets the bulb's sphere: nearer than its centre by the chord's half)
  let v = l.pos - O;
  let b = dot(v, D);
  let tmax = b - sqrt(max(b * b - dot(v, v) + l.radius * l.radius, 0.0));
  return rayTransmittance(O, D, tmax, RAY_UNSTOPPED);
}
// whether light i reaches X (normal N) along one ray toward it (sample s of this pixel and sub-frame), so its shadow is as
// soft as the light is large (the sub-frames average them)
fn lightRay(X: vec3f, N: vec3f, i: i32, frag: vec2f, s: f32) -> vec3f {
  return shadowRay(X, N, i, inCone(lightCone(i, X), lightU(frag, i, s, 17.0).xy));
}
// how much light gets from O along D (unit) to tmax, each colour: glass on the way tints it, a layer's see-through parts
// let it by, anything else stops it. until: a copy (or a layer, -1 - its index) that ends the walk where it is met (an
// emitter's own surface, before the point on it the ray went to), or RAY_UNSTOPPED
const RAY_UNSTOPPED = -2147483647;
fn rayTransmittance(O: vec3f, D: vec3f, tmax: f32, until: i32) -> vec3f {
  // (a ray that nothing in particular ends, a shadow's: whether anything stops it is found first, ending at the first
  // thing found rather than looking for the nearest; only one that passes something tinting it is walked in order)
  if (until == RAY_UNSTOPPED) {
    let b = rayBlocked(O, D, 0.0, tmax);
    if (b == RAY_STOPPED) { return vec3f(0.0); }
    if (b == RAY_CLEAR) { return vec3f(1.0); }
  }
  var keep = vec3f(1.0);
  var gone = 0.0;
  for (var j = 0; j < 6; j++) {
    if (gone >= tmax) { break; }
    let hit = traceScene(O + D * gone, D, 0.5, tmax - gone);
    if (hit.item < 0) { break; }
    gone += hit.t;
    let x = itemAt(hit.item);
    if (x.copy == until) { break; }
    if (x.copy < 0) {
      let L = planeOf(-x.copy - 1);
      keep *= 1.0 - planeColor(L, hit.b, 0.0).a;
    } else {
      let M = materialAt(x.node);
      if (M.transmission <= 0.0) { return vec3f(0.0); }   // glass lets it through, tinted by its colour; else it is dark
      keep *= M.transmission * M.base * tintOf(x.copy) * 0.92;
    }
    if (max(keep.r, max(keep.g, keep.b)) < 0.01) { return vec3f(0.0); }
  }
  return keep;
}
// the light falling on a matte surface at X (normal Nf, either side, seen from V: a lit layer), from the environment
// (or, with GI, ambient: w 1) and every light (their shadows traced when shadows)
const MATTE = Terms(vec3f(1.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
fn matteLight(X: vec3f, Nf: vec3f, V: vec3f, frag: vec2f, shadows: bool, rays: i32, ambient: vec4f) -> vec3f {
  let N = select(Nf, -Nf, dot(Nf, V) < 0.0);
  return select(irradiance(N), ambient.rgb, ambient.w > 0.5) + gather(X, N, V, 1.0, 1.0, 0.5, MATTE, frag, shadows, rays, notFound()).lit.diff;
}
// The light a ray from P0 going D brings back. cone: how fast its footprint widens (radians); w0: its footprint at P0.
// What it meets is lit as the camera would see it lit, its lights' shadows traced with one ray of each kind (what glass
// or a mirror shows in a box's shadow stays in it), reflecting the environment in turn (gi: as GI's rays light it, an
// emitter brighter than EMIT_BRIGHT dark: its light is sampled from the pixels it lights). first: how far it went before
// it first met something (1e4: nothing); end: how far before what stopped it (1e6: it went on to the environment).
// Where GI's ray stopped at a surface: which way it faces and how far along the ray it is (hit; w below 0: it stopped at
// none), and how much of the light around it there comes back along the ray (take: its diffuse light and sheen's share,
// through what the ray passed on its way), which GI's next bounce lights it with (passes/gi.js, giAgain).
struct Traced { light: vec3f, first: f32, end: f32, hit: vec4f, take: vec3f };
fn traced(light: vec3f, first: f32, end: f32) -> Traced { return Traced(light, first, end, vec4f(0.0, 0.0, 0.0, -1.0), vec3f(0.0)); }
fn traceLight(P0: vec3f, D: vec3f, cone: f32, w0: f32, frag: vec2f, gi: bool) -> Traced { return traceLightFrom(RayHit(0.0, RAY_UNWALKED, -1, vec2f(0.0)), P0, D, cone, w0, frag, gi); }
// the same, what the ray meets first found already (GI's rays, in a shader of their own: passes/gi.js, giWalk), or RAY_UNWALKED
const RAY_UNWALKED = -2;
fn traceLightFrom(met: RayHit, P0: vec3f, D: vec3f, cone: f32, w0: f32, frag: vec2f, gi: bool) -> Traced {
  var acc = vec3f(0.0);
  var keep = vec3f(1.0);
  var P = P0;
  var gone = 0.0;
  var first = 1e4;
  var glassed = false;   // it has passed through a piece of glass
  let V = -D;
  for (var k = 0; k < 6; k++) {
    var h = met;
    if (k > 0 || met.item == RAY_UNWALKED) { h = traceScene(P, D, 0.2, 1e6); }
    if (h.item < 0) { return traced(acc + keep * skyAt(D), first, 1e6); }
    if (k == 0) { first = h.t; }
    gone += h.t;
    let width = w0 + gone * cone;
    let x = itemAt(h.item);
    let X = P + D * h.t;
    // what it met, as the one call of gather takes it (see Lobe): a layer, if lit, as a matte surface (as matteLight)
    let layer = x.copy < 0;
    var L: Plane;
    var c = vec4f(0.0);
    var p: Point;
    var s: Surf;
    var N = vec3f(0.0);
    var W = MATTE;
    var rough = 1.0; var coatRough = 1.0; var sheenRough = 0.5;
    if (layer) {
      L = planeOf(-x.copy - 1);
      c = planeColor(L, h.b, log2(max(width * texSize(L.pic) / (2.0 * length(L.U)), 1.0)));
      let Nf = normalize(cross(L.U, L.V));
      N = select(Nf, -Nf, dot(Nf, V) < 0.0);
    } else {
      p = pointAt(h, P, D, width);
      s = surfaceAt(p, V);
      if (s.own) { return traced(acc + keep * s.light, first, gone); }
      // (as emittersData chooses them: by the material's own emission, a solid, not glass; a light's bulb is dark too, its
      // light the light's)
      if (gi && shapeOf(x.node).solid) {
        let own = materialAt(x.node);
        if (own.transmission <= 0.0 && luma(own.emit) > ${EMIT_BRIGHT}.0) { s.M.emit = vec3f(0.0); }
      }
      // (glass behind glass, in a reflection: the environment, rather than following it on through glass after glass)
      if (glassed && s.M.transmission > 0.0) { return traced(acc + keep * skyAt(D), first, gone); }
      W = weightsOf(s.M, s.base, s.N, V, p.at).w;
      N = s.N; rough = clamp(s.M.rough, 0.02, 1.0); coatRough = clamp(s.M.coatRough, 0.02, 1.0); sheenRough = s.M.sheenRough;
    }
    var g = Gathered(noTerms(), vec3f(0.0), vec3f(0.0), vec3f(0.0));
    if (!layer || L.lit) { g = gather(X, N, V, rough, coatRough, sheenRough, W, frag, true, 1, notFound()); }
    if (layer) {
      // its picture there, as authored (its light) or lit, over what is beyond it
      var rgb = c.rgb * L.bright;
      if (L.lit) { rgb *= select(irradiance(N), vec3f(0.0), gi) + g.lit.diff; }
      else if (gi && L.bright > ${EMIT_BRIGHT}.0) { rgb = vec3f(0.0); }
      acc += keep * rgb;
      keep *= 1.0 - c.a;
      if (max(keep.r, max(keep.g, keep.b)) < 0.01) { return traced(acc, first, gone); }
      P = X;
      continue;
    }
    // (what GI's ray meets is lit by the lights alone, one bounce: neither its diffuse light nor its highlights take
    // the environment, which would bring the sky into a closed room)
    var env = Terms(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
    if (!gi) {
      let path = length(P0 - cam.eye) + gone;
      // (its highlights, where it has any: the light around a surface facing along its reflection where that is found
      // (GI's), not the environment's reflection, which would show the open sky in a closed room)
      let glossy = max(max(W.spec.r, W.spec.g), max(W.spec.b, max(W.coat.r, max(W.coat.g, W.coat.b)))) > 0.0;
      let a = aroundHit(X, s.N, reflect(-V, s.N), glossy, path);
      env = around(s, V, 1.0, a.diff.rgb);
      if (a.refl.w > 0.5) { env.spec = a.refl.rgb; env.coat = a.refl.rgb; }
    }
    let lit = surfaceLight(s, V, g.lit, env, p.at);
    acc += keep * lit.col;
    if (s.M.transmission <= 0.0) {
      if (!gi) { return traced(acc, first, gone); }
      let take = keep * (W.diff + W.sheen * select(0.0, sheenAlbedo(clamp(dot(s.N, V), 1e-3, 1.0), s.M.sheenRough), max(W.sheen.r, max(W.sheen.g, W.sheen.b)) > 0.0));
      return Traced(acc, first, gone, vec4f(s.N, length(X - P0)), take);
    }
    // glass: on through it (not bent), tinted by its path inside, and milky as frost scatters the light around it
    let haze = clamp(s.M.rough, 0.0, 1.0) * 0.3;
    acc += keep * lit.trans * haze * irradiance(s.N);
    keep *= lit.trans * (1.0 - haze);
    glassed = true;
    P = X;
    let sh = shapeOf(x.node);
    if (sh.solid) {
      let q = objP(X + D * 0.05);
      let d = normalize(objV(D));
      let Q = worldP(q + d * exitSolid(q, d, sh.S));
      keep *= exp(-s.M.absorb * length(Q - X));
      P = Q;
    }
    if (max(keep.r, max(keep.g, keep.b)) < 0.01) { return traced(acc, first, gone); }
  }
  return traced(acc, first, gone);
}
// how far a ray from P going D (unit) goes before it meets something it cannot see through (1e6: nothing within tmax),
// and whether that is a layer (1) or a mesh (0): glass, and a layer where it is more clear than not, let it on
fn opaqueHit(P: vec3f, D: vec3f, tmax: f32) -> vec2f {
  var gone = 0.0;
  for (var k = 0; k < 6; k++) {
    let h = traceScene(P + D * gone, D, 0.2, tmax - gone);
    if (h.item < 0) { return vec2f(1e6, 0.0); }
    gone += h.t;
    let x = itemAt(h.item);
    if (x.copy < 0) { if (planeColor(planeOf(-x.copy - 1), h.b, 0.0).a > 0.5) { return vec2f(gone, 1.0); } }
    else if (materialAt(x.node).transmission <= 0.0) { return vec2f(gone, 0.0); }
  }
  return vec2f(gone, 0.0);
}
// Reflections, ray traced. A rough surface's ray is drawn from its spread of reflected directions (GGX's visible normals,
// Heitz 2018), a different one each sub-frame, so the frame's sub-frames average them into its blur; past TRACED
// roughness it fades into what stands in for them, as engines cap the roughness they trace: with GI, the light it found
// from that way (aroundHit: a cosine-wide average from the probes around the point), where the environment's reflection
// would show the open sky in a closed room (Cycles' gi-test: the rug 1.35 of the truth, now 0.89, the leather's blue
// sheen gone; in a room open to the sky it reads dim, gi-room's frame 0.90 → 0.87, why not known: the ground truth's
// README), else the environment's. A rough surface's ray's light is clamped (RAY_MAX) against fireflies.
// No ray where its light could hardly show (UNSEEN: the traced share of the reflection times how much the surface
// reflects head-on, so a rough dielectric rather than a rough metal): spring-brutalist's petals (roughness 0.55) took
// 610 of the pool's 630 ms of reflections and changed no pixel by more than 4 levels. By material, not by angle: a pixel
// shades with its neighbours, and a few scattered rays cost nearly what all of them do.
const TRACED = vec2f(0.35, 0.6);
const UNSEEN = vec2f(0.005, 0.01);
const REUSE_ROUGH = 0.05;   // (below this, a mirror: one ray is noiseless)
// a microfacet normal drawn from those a viewer at V sees on a GGX surface of roughness a (Heitz 2018), for u in [0, 1)²
fn ggxVisible(V: vec3f, N: vec3f, a: f32, u: vec2f) -> vec3f {
  let T1 = normalize(cross(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(N.y) > 0.9), N));
  let T2 = cross(N, T1);
  let Vh = normalize(vec3f(a * dot(V, T1), a * dot(V, T2), dot(V, N)));
  let l2 = Vh.x * Vh.x + Vh.y * Vh.y;
  let A = select(vec3f(1.0, 0.0, 0.0), vec3f(-Vh.y, Vh.x, 0.0) * inverseSqrt(l2), l2 > 0.0);
  let B = cross(Vh, A);
  let r = sqrt(u.x);
  let phi = TAU * u.y;
  let t1 = r * cos(phi);
  let s = 0.5 * (1.0 + Vh.z);
  let t2 = (1.0 - s) * sqrt(1.0 - t1 * t1) + s * r * sin(phi);
  let Nh = A * t1 + B * t2 + Vh * sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2));
  let H = normalize(vec3f(a * Nh.x, a * Nh.y, max(Nh.z, 0.0)));
  return normalize(T1 * H.x + T2 * H.y + N * H.z);
}
// what a surface at X (normal N, seen from V, of roughness rough, reflecting f0 head-on) reflects; foot: how much its
// mirror direction turns across the pixel. reuse: one ray, kept for the denoiser (Reflected: what it brought back, how
// likely it was to be sent — 0: it went under the surface and was sent along the mirror direction instead — where it
// went, the lobe's alpha, and how much of the reflection is traced: 0, nothing kept)
struct Reflected { light: vec3f, L: vec3f, pdf: f32, hit: vec3f, a: f32, traced: f32 };
// In steps (lobeOf, then for each of its n rays lobeRay, traceLight and lobeGot, then lobeDone), so that a shader traces
// all its rays in one loop: traceLight takes in every surface of the film, and the GPU's compiler makes a copy of it for
// each place it is called from, at a cost that grows faster than the copies do.
struct Lobe { X: vec3f, N: vec3f, V: vec3f, R0: vec3f, stand: vec3f, h: vec2f, rough: f32, a: f32, traced: f32, cone: f32, w0: f32, n: i32, reuse: bool, seen: vec3f, out: Reflected };
const NO_REFLECTED = Reflected(vec3f(0.0), vec3f(0.0), 0.0, vec3f(0.0), 0.0, 0.0);
// (no lobe: what a surface with no coat has for one)
fn noLobe() -> Lobe { return Lobe(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0), vec2f(0.0), 0.0, 0.0, 0.0, 0.0, 0.0, 0, false, vec3f(0.0), NO_REFLECTED); }
fn lobeOf(X: vec3f, N: vec3f, V: vec3f, rough: f32, f0: f32, foot: f32, frag: vec2f, reuse0: bool) -> Lobe {
  let R0 = reflect(-V, N);
  var stand = environment(R0, clamp(rough, 0.02, 1.0) * 0.7);
  let share = 1.0 - smoothstep(TRACED.x, TRACED.y, rough);
  if (share < 1.0 && f0 > 0.0) { let g = aroundHit(X, R0, R0, false, length(X - cam.eye)); if (g.diff.w > 0.5) { stand = g.diff.rgb; } }
  let traced = share * smoothstep(UNSEEN.x, UNSEEN.y, share * f0);
  var l = noLobe();
  l.out.light = stand;
  if (traced <= 0.0 || world.tables.traced == 0 || world.tracing.reflect < 0.5) { return l; }
  let a = max(rough * rough, 1e-4);
  let reuse = reuse0 && rough >= REUSE_ROUGH;
  // rougher surfaces send more rays (up to 4 a sub-frame, within the frame's budget) where their reflection shows
  // (metals, grazing angles), each sub-frame's different (a rotated R2 sequence over them all, each pixel its own)
  let shows = f0 + (1.0 - f0) * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  let n = select(budget(1 + i32(round(3.0 * smoothstep(0.05, 0.35, rough) * smoothstep(0.04, 0.3, shows) * traced))), 1, reuse);
  let h = vec2f(hash3(vec3f(frag, 11.0)), hash3(vec3f(frag.yx, 5.0)));
  return Lobe(X, N, V, R0, stand, h, rough, a, traced, foot + a * 0.5, viewZ(X) / cam.focal, n, reuse, vec3f(0.0), l.out);
}
// the way its k-th ray goes (one that would go under the surface: along the mirror direction instead)
fn lobeRay(l: Lobe, k: i32) -> vec3f {
  let u = fract(l.h + (floor(cam.phase * 64.0) * 4.0 + f32(k)) * vec2f(0.7548777, 0.5698403));
  let R = reflect(-l.V, ggxVisible(l.V, l.N, l.a, u));
  return select(R, l.R0, dot(R, l.N) <= 0.0);
}
// what a ray going R brought back (traceLight from l.X + l.N * 0.5, with l.cone and l.w0)
fn lobeGot(l0: Lobe, R: vec3f, got: Traced) -> Lobe {
  var l = l0;
  let L = select(got.light, min(got.light, vec3f(${RAY_MAX}.0)), l.rough >= REUSE_ROUGH);
  l.seen += L;
  if (l.reuse) {
    let NoV = max(dot(l.N, l.V), 1e-4);
    l.out.L = L; l.out.hit = R * got.first; l.out.a = l.a; l.out.traced = l.traced;
    l.out.pdf = select(ggxPdf(l.N, l.V, R, l.a, NoV), 0.0, all(R == l.R0));   // (the mirror direction: it went under the surface)
  }
  return l;
}
fn lobeDone(l0: Lobe) -> Reflected {
  var out = l0.out;
  if (l0.n > 0) { out.light = mix(l0.stand, l0.seen / f32(l0.n), l0.traced); }
  return out;
}`;
