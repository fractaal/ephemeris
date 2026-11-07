// Emitters, with global illumination: what glows brighter than EMIT_BRIGHT (its light's luminance, linear) — a solid (a
// box, a sphere) and a layer shown as authored, its picture its light — lights a mesh the camera sees directly, from the
// pixel: a point on one of them for each of a few rays, chosen as gather() chooses the scene's lights (by how much each
// may light the point, stratified over the sum), drawn uniformly over the solid angle it fills there and traced to it.
// GI's rays do not see their light (traceLight's gi rule), so it is counted once. A small bright emitter near a surface
// is lit this way without the noise GI's rays make finding it rarely, which bubbled as the camera moved. Dimmer ones (lit
// windows, a UI layer) are found by GI's rays, which see them without that noise and cost nothing more. A solid with one
// of the scene's lights inside it is that light's bulb: its light is the light's, and it is not an emitter.
import { INSTANCE_FLOATS } from '../mesh.js';
import { EMIT_BRIGHT } from './trace.js';
import { axes } from './scene.js';

const MAX_EMITTERS = 256;   // (the brightest; the rest stay dark to GI's rays, unsampled)

/**
 * The scene's emitters as the tables hold them (2 vec4s each, the brightest first): each copy of a solid glowing
 * brighter than EMIT_BRIGHT but a light's bulb, and each layer in the world shown as authored that bright. Each: its
 * centre and power (its luminance × area: how much it may light), what it is (a copy: its instance and node; a layer:
 * -1 - its index, and -1), its area, and how far it reaches past its centre. meshes, layers: the sub-frame's (each
 * mesh's first copy set: instancesData), inst: their copies, lights: lightsOf's.
 */
export function emittersData(meshes, layers, inst, lights) {
  const len = (v) => Math.hypot(...v), across = (a, b) => len([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
  const bulbs = lights.filter((L) => L.light !== 'sun').map((L) => ({ at: L.at, radius: Math.max(0, L.radius ?? 20) }));
  const out = [];
  meshes.forEach((m, i) => {
    const solid = m.mesh.solid, e = m.material.emission, lum = 0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2];
    if (!solid || m.material.glass || !(lum > EMIT_BRIGHT)) return;
    const h = solid.half;
    for (let k = 0; k < m.instances.length; k++) {
      // (its model's columns and its centre: see instanceData)
      const o = (m.first + k) * INSTANCE_FLOATS, col = (j) => [inst[o + j * 4], inst[o + j * 4 + 1], inst[o + j * 4 + 2]], [c0, c1, c2] = [col(0), col(1), col(2)];
      const c = [inst[o + 3], inst[o + 7], inst[o + 11]];
      if (bulbs.some((L) => len([L.at[0] - c[0], L.at[1] - c[1], L.at[2] - c[2]]) <= L.radius)) continue;
      const area = 8 * (h[1] * h[2] * across(c1, c2) + h[0] * h[2] * across(c0, c2) + h[0] * h[1] * across(c0, c1));
      out.push([...c, lum * area, m.first + k, i, area, len(h) * Math.max(len(c0), len(c1), len(c2))]);
    }
  });
  layers.forEach((l, li) => {
    const b = (l.bright ?? 1) ** 2.2, opacity = l.opacity ?? 1;
    if (l.lit || !(opacity > 0) || !(b > EMIT_BRIGHT)) return;
    // (its picture's light is unknown here: half its brightness, as a guess at how much of it is lit)
    const [U, V] = axes(l), area = 4 * across(U, V);
    out.push([l.x, l.y, l.z ?? 0, area * 0.5 * b * opacity, -1 - li, -1, area, len(U) + len(V)]);
  });
  out.sort((a, b) => b[3] - a[3]);
  return Float32Array.from(out.slice(0, MAX_EMITTERS).flat());
}

/** The WGSL: the emitters' light on a surface (emitLight), each sampled by the solid angle it fills (emitSample). */
export const EMITTERS = /* wgsl */`
// one of the scene's emitters (see emittersData): its centre and power, what it is (a copy: its instance and node; a
// layer: -1 - its index, and -1), its area and how far it reaches past its centre
struct Emitter { C: vec3f, power: f32, copy: i32, node: i32, area: f32, reach: f32 };
fn emitterOf(e: i32) -> Emitter {
  let b = world.tables.emitters + e * 2;
  let a = scn[b];
  let c = scn[b + 1];
  return Emitter(a.xyz, a.w, i32(c.x), i32(c.y), c.z, c.w);
}
// how much an emitter may light X (normal N): its power over its distance squared (no nearer than its area), none where it
// is wholly behind the surface
fn emitWeight(E: Emitter, X: vec3f, N: vec3f) -> f32 {
  let d = E.C - X;
  if (dot(d, N) < -E.reach) { return 0.0; }
  return E.power / (dot(d, d) + E.area);
}
// The emitters' light on a surface at X (normal N), as a matte surface shows it, (1/π) ∫ L cos: K points (4 a frame,
// one a sub-frame at least, as GI's rays: by solid angle, few are smooth), each on the emitter its share of the sum fell
// in (where the K points start turned by the sub-frame's phase, so a frame's interleave), weighed by the chance of that
// emitter.
fn emitLight(X: vec3f, N: vec3f, frag: vec2f) -> vec3f {
  let n = world.tables.emitterCount;
  if (n <= 0 || world.tables.traced == 0) { return vec3f(0.0); }
  var W = 0.0;
  for (var e = 0; e < n; e++) { W += emitWeight(emitterOf(e), X, N); }
  if (W <= 0.0) { return vec3f(0.0); }
  let K = max(1, i32(ceil(4.0 * cam.weight)));
  let xi = fract(hash3(vec3f(frag, 53.0)) + cam.phase);
  var acc = vec3f(0.0);
  var C = 0.0;
  var k = 0;
  for (var e = 0; e < n && k < K; e++) {
    let E = emitterOf(e);
    let w = emitWeight(E, X, N);
    if (w <= 0.0) { continue; }
    C += w;
    loop {
      if (k >= K || (f32(k) + xi) / f32(K) * W >= C) { break; }
      acc += emitSample(E, X, N, frag, k) * (W / (f32(K) * w));
      k++;
    }
  }
  return acc;
}
// the angle between two unit vectors, without acos's loss near 0 and π (as pbrt's AngleBetween)
fn emitAngle(a: vec3f, b: vec3f) -> f32 {
  if (dot(a, b) < 0.0) { return PI - 2.0 * asin(clamp(length(a + b) * 0.5, -1.0, 1.0)); }
  return 2.0 * asin(clamp(length(b - a) * 0.5, -1.0, 1.0));
}
// a point on the rectangle s + [0, 1] ex + [0, 1] ey (ex across ey) as seen from p, uniform by the solid angle it fills
// there (Ureña, Fajardo and King 2013, "An Area-Preserving Parametrization for Spherical Rectangles", as pbrt-v4's
// SampleSphericalRectangle writes it), either side of it; w: that solid angle (0: none)
fn emitRectPoint(p: vec3f, s: vec3f, ex: vec3f, ey: vec3f, u: vec2f) -> vec4f {
  let exl = length(ex);
  let eyl = length(ey);
  let X = ex / exl;
  let Y = ey / eyl;
  var Z = cross(X, Y);
  let d = s - p;
  var z0 = dot(d, Z);
  if (z0 > 0.0) { Z = -Z; z0 = -z0; }
  let x0 = dot(d, X);
  let y0 = dot(d, Y);
  let x1 = x0 + exl;
  let y1 = y0 + eyl;
  let v00 = vec3f(x0, y0, z0); let v01 = vec3f(x0, y1, z0); let v10 = vec3f(x1, y0, z0); let v11 = vec3f(x1, y1, z0);
  let n0 = normalize(cross(v00, v10)); let n1 = normalize(cross(v10, v11));
  let n2 = normalize(cross(v11, v01)); let n3 = normalize(cross(v01, v00));
  let g0 = emitAngle(-n0, n1); let g1 = emitAngle(-n1, n2); let g2 = emitAngle(-n2, n3); let g3 = emitAngle(-n3, n0);
  let omega = g0 + g1 + g2 + g3 - TAU;
  if (!(omega > 0.0)) { return vec4f(s + ex * u.x + ey * u.y, 0.0); }
  if (omega < 1e-3) { return vec4f(s + ex * u.x + ey * u.y, omega); }
  let b0 = n0.z;
  let b1 = n2.z;
  let au = u.x * (g0 + g1 - TAU) + (u.x - 1.0) * (g2 + g3);
  let fu = (cos(au) * b0 - b1) / sin(au);
  let cu = clamp(select(-1.0, 1.0, fu >= 0.0) / sqrt(fu * fu + b0 * b0), -0.99999994, 0.99999994);
  let xu = clamp(-(cu * z0) / sqrt(max(1.0 - cu * cu, 0.0)), x0, x1);
  let dd = sqrt(xu * xu + z0 * z0);
  let h0 = y0 / sqrt(dd * dd + y0 * y0);
  let h1 = y1 / sqrt(dd * dd + y1 * y1);
  let hv = h0 + u.y * (h1 - h0);
  let yv = select(y1, hv * dd / sqrt(1.0 - hv * hv), hv * hv < 1.0 - 1e-6);
  return vec4f(p + X * xu + Y * yv + Z * z0, omega);
}
// One point on an emitter as seen from X (sample k of this pixel and sub-frame: a rotated R3 sequence), and its light
// at X, unweighted by the choosing: uniform by the solid angle the emitter fills, so a point beside it counts as much as
// one at its far end (by area, a bar's light on the wall behind it is speckled), (1/π) L cos θ Ω — a sphere by the cone
// it fills, a box on the faces that face X (each by its solid angle; its rounded edges taken as sharp), a layer on its
// picture (either side).
fn emitSample(E: Emitter, X: vec3f, N: vec3f, frag: vec2f, k: i32) -> vec3f {
  let h = vec3f(hash3(vec3f(frag, 61.0)), hash3(vec3f(frag.yx, 67.0)), hash3(vec3f(frag, 71.0)));
  let u = fract(h + (floor(cam.phase * 64.0) * 16.0 + f32(k)) * vec3f(0.8191725, 0.6710436, 0.5497005));
  let O = X + N * 0.5;
  var L: vec3f;
  var P: vec4f;   // the point, and the solid angle it was drawn from
  if (E.node < 0) {
    let Q = planeOf(-E.copy - 1);
    P = emitRectPoint(O, Q.C - Q.U - Q.V, Q.U * 2.0, Q.V * 2.0, u.xy);
    let ab = vec2f(dot(P.xyz - Q.C, Q.U) / dot(Q.U, Q.U), dot(P.xyz - Q.C, Q.V) / dot(Q.V, Q.V));
    L = planeColor(Q, ab, 4.0).rgb * Q.bright;
  } else {
    useCopy(E.copy);
    let S = shapeOf(E.node).S;
    L = materialAt(E.node).emit;
    if (S.w >= min(S.x, min(S.y, S.z)) - 0.01) {
      // a sphere: a direction within the cone it fills, uniformly, and where it meets it
      let c = vec3f(I[0].w, I[1].w, I[2].w);
      let r = S.x * length(I[0].xyz);
      let d = c - O;
      let dl = length(d);
      if (dl <= r) { return vec3f(0.0); }
      let cosMax = sqrt(max(1.0 - r * r / (dl * dl), 0.0));
      let ct = 1.0 - u.x * (1.0 - cosMax);
      let st = sqrt(max(1.0 - ct * ct, 0.0));
      let wz = d / dl;
      let T1 = normalize(cross(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(wz.y) > 0.9), wz));
      let T2 = cross(wz, T1);
      let w = T1 * cos(TAU * u.y) * st + T2 * sin(TAU * u.y) * st + wz * ct;
      let bq = dot(w, d);
      P = vec4f(O + w * (bq - sqrt(max(bq * bq - dl * dl + r * r, 0.0))), TAU * (1.0 - cosMax));
    } else {
      // a box: each axis's face that faces X, a point on one, chosen by the solid angles they fill (they do not overlap,
      // seen from outside: the box's is their sum)
      let o = objP(O);
      var F = array<vec4f, 3>(vec4f(0.0), vec4f(0.0), vec4f(0.0));
      var total = 0.0;
      for (var a = 0; a < 3; a++) {
        if (abs(o[a]) <= S[a]) { continue; }
        let j = (a + 1) % 3;
        let l = (a + 2) % 3;
        var c = vec3f(0.0);
        c[a] = sign(o[a]) * S[a]; c[j] = -S[j]; c[l] = -S[l];
        F[a] = emitRectPoint(O, worldP(c), I[j].xyz * (2.0 * S[j]), I[l].xyz * (2.0 * S[l]), u.xy);
        total += F[a].w;
      }
      if (!(total > 0.0)) { return vec3f(0.0); }
      let pick = select(select(2, 1, u.z * total < F[0].w + F[1].w), 0, u.z * total < F[0].w);
      P = vec4f(F[pick].xyz, total);
    }
  }
  let D = P.xyz - O;
  let r = length(D);
  let w = D / max(r, 1e-6);
  let cosN = max(dot(N, w), 0.0);
  if (cosN <= 0.0 || !(P.w > 0.0)) { return vec3f(0.0); }
  // (the emitter itself ends the walk: its rounded edges may come before the point on its box)
  let e = L * (cosN * P.w / PI) * rayTransmittance(O, w, r - 0.5, E.copy);
  return select(e, vec3f(0.0), e != e);
}`;
