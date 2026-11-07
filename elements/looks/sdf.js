// SDF objects: shapes written as signed distance functions in WGSL and raymarched where they are placed. Smooth unions
// and carving make what triangles cannot easily: a creature, a melted logo, a soft form with a hollow cut into it, a
// whole world repeated cell by cell. Each is a placed pass (engine/pass.js): a thing in the world that the editor picks,
// outlines and moves, its params lanes, its surfaces met by meshes, layers, glass and fog by depth.
//
// This is one way to draw, written with the same pass API any film has: use it as it is, copy it into the film and
// change it, or write your own pass from scratch.
//
//   import { sdf } from '../../elements/looks/sdf.js';
//   const BLOB = sdf(F, {
//     label: 'blob', bounds: [26, 34, 26],       // half extents of its own space (px), as placed: rays march only inside
//     params: { dent: 0, color: '#b9a8ff' },
//     map: /* wgsl */`
//     fn map(q: vec3f) -> vec2f {                 // q: a point in its own space (y down); → (distance, material id)
//       var d = sdEllipsoid(q, vec3f(18.0, 24.0, 20.0));
//       d = smax(d, -sdEllipsoid(q - vec3f(0.0, 10.0 + 6.0 * p.dent, -18.0), vec3f(8.0, 4.0 + 8.0 * p.dent, 8.0)), 2.0);
//       return vec2f(d, 0.0);
//     }`,
//   });
//   nodes.push(BLOB.at(x, y, z, { ry: 20, s: 1.5, dent: motion(0).to(6, 0.8, 1) }));
//
// Shading: by default it is lit as meshes are (engine/render/passes/film.js, litMaterialReflecting: the environment, the
// scene's lights, their shadows traced through the scene where they ask, and its own soft shadows and occlusion), in its
// params' `color` and `roughness`: light, which the frame's view transform shows as it shows meshes. Give `shade` — fn
// shade(h: Hit) -> vec3f, returning its light — for a look of its own: shadeLit(h, base, rough) is the default's light,
// and every pass's lighting is there to call (litMaterial for a whole mesh material: coat, sheen, a thin film, glass;
// softShadow, occlusion: its map is the sceneDistance they march).
// The SDF library (SDF, below: sdSphere, sdBox, sdRoundBox, sdEllipsoid, sdCapsule, sdCylinder, sdRoundCone, sdTorus,
// smin, smax, rot2, opRep, opRepLimited, opRepCell) is plain WGSL: any pass may include it (noise3 every pass has).

import { withDefaults } from '../../engine/pass.js';

export const SDF = /* wgsl */`
fn sdSphere(q: vec3f, r: f32) -> f32 { return length(q) - r; }
fn sdBox(q: vec3f, b: vec3f) -> f32 { let d = abs(q) - b; return length(max(d, vec3f(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0); }
fn sdRoundBox(q: vec3f, b: vec3f, r: f32) -> f32 { return sdBox(q, b - vec3f(r)) - r; }
fn sdEllipsoid(q: vec3f, r: vec3f) -> f32 { let k0 = length(q / r); let k1 = length(q / (r * r)); return k0 * (k0 - 1.0) / max(k1, 1e-6); }
fn sdCapsule(q: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 { let pa = q - a; let ba = b - a; let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
// a cylinder along y: radius r, half height h
fn sdCylinder(q: vec3f, r: f32, h: f32) -> f32 { let d = abs(vec2f(length(q.xz), q.y)) - vec2f(r, h); return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0))); }
fn sdRoundCone(q: vec3f, a: vec3f, b: vec3f, r1: f32, r2: f32) -> f32 {
  let ba = b - a; let l2 = dot(ba, ba); let rr = r1 - r2; let a2 = l2 - rr * rr; let il2 = 1.0 / l2;
  let pa = q - a; let y = dot(pa, ba); let z = y - l2; let xv = pa * l2 - ba * y; let x2 = dot(xv, xv);
  let y2 = y * y * l2; let z2 = z * z * l2; let k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) { return sqrt(x2 + z2) * il2 - r2; }
  if (sign(y) * a2 * y2 < k) { return sqrt(x2 + y2) * il2 - r1; }
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
// a ring about y: its radius R, its tube's r
fn sdTorus(q: vec3f, R: f32, r: f32) -> f32 { return length(vec2f(length(q.xz) - R, q.y)) - r; }
// smooth union and smooth subtraction (smax(a, -b, k) carves b out of a), blending over k
fn smin(a: f32, b: f32, k: f32) -> f32 { let h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
fn smax(a: f32, b: f32, k: f32) -> f32 { let h = max(k - abs(a - b), 0.0) / k; return max(a, b) + h * h * k * 0.25; }
fn rot2(v: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(c * v.x - s * v.y, s * v.x + c * v.y); }
// repetition: q in its own cell, cells every s (px) along each axis (an axis not repeated: s = 1e9); opRepLimited
// repeats only cells −lim … lim (n in a row, centred: lim = (n − 1) / 2); opRepCell is the cell's index, to vary each
// copy (a hash of it; clamp it as opRepLimited does). The distance holds while the shape stays inside its cell.
fn opRep(q: vec3f, s: vec3f) -> vec3f { return q - s * round(q / s); }
fn opRepLimited(q: vec3f, s: vec3f, lim: vec3f) -> vec3f { return q - s * clamp(round(q / s), -lim, lim); }
fn opRepCell(q: vec3f, s: vec3f) -> vec3f { return round(q / s); }
`;

// the march, the hit and the default shading, around the film's map (and shade)
const BODY = (shade, steps) => /* wgsl */`
struct Hit { p: vec3f, n: vec3f, q: vec3f, m: f32, rd: vec3f, t: f32 };   // world point, its normal, own-space point, material, the ray's way, how far
fn objScale() -> f32 { return length(obj.m[0].xyz); }
// the distance in the world (its own, scaled as placed: a uniform scale keeps it a distance)
fn mapWorld(w: vec3f) -> vec2f { let h = map(toLocal(w)); return vec2f(h.x * objScale(), h.y); }
fn normalAt(w: vec3f, e: f32) -> vec3f {
  let q = toLocal(w); let k = e / objScale();
  let n = vec3f(map(q + vec3f(k, 0.0, 0.0)).x - map(q - vec3f(k, 0.0, 0.0)).x, map(q + vec3f(0.0, k, 0.0)).x - map(q - vec3f(0.0, k, 0.0)).x, map(q + vec3f(0.0, 0.0, k)).x - map(q - vec3f(0.0, 0.0, k)).x);
  return normalToWorld(normalize(n));
}
// its surfaces as what shadows the light on it (softShadow, occlusion), and lit as meshes are: the environment, the
// scene's lights (their traced shadows) and its own soft shadows, its creases darker
fn sceneDistance(w: vec3f) -> f32 { return mapWorld(w).x; }
fn shadeLit(h: Hit, base: vec3f, rough: f32) -> vec3f {
  let R = reflect(h.rd, h.n);
  return litMaterialReflecting(h.p, h.n, -h.rd, material(base, rough, 0.0), environment(R, clamp(rough, 0.02, 1.0) * 0.7), environment(R, 0.021), occlusion(h.p, h.n, 12.0 * objScale())).col;
}
${shade ?? /* wgsl */`fn shade(h: Hit) -> vec3f { return shadeLit(h, p.color, p.roughness); }`}
fn drawSurface(px: vec2f, uv: vec2f) -> Surface {
  let r = viewRay(px);
  let span = boundsHit(r);
  let miss = Surface(input(px), vec4f(0.0), vec3f(0.0));
  if (span.x > span.y) { return miss; }
  // (what is opaque already, nearer: it hides this, so no need to march past it)
  let s = surface(px);
  let far = select(span.y, min(span.y, dot(s.xyz - r.o, r.d)), s.w > 0.5);
  var t = span.x; var hit = false; var m = 0.0;
  for (var i = 0; i < ${steps}; i++) {
    let h = mapWorld(r.o + r.d * t);
    if (h.x < max(0.4 * t / cam.focal, 1e-3)) { hit = true; m = h.y; break; }
    t += h.x;
    if (t > far) { break; }
  }
  if (!hit) { return miss; }
  let w = r.o + r.d * t;
  let n = normalAt(w, max(0.5 * t / cam.focal, 0.02));
  let col = shade(Hit(w, n, toLocal(w), m, r.d, t));
  return Surface(vec4f(col, 1.0), vec4f(w, 1.0), n);
}`;

/**
 * An SDF object, placed with .at(x, y, z, { rx, ry, rz, s, …params }). `map` defines fn map(q: vec3f) -> vec2f in its
 * own space ((distance, material id)); `bounds`: half extents of that space (px), [x, y, z] or one number; `params`:
 * its own (p.<name> in map and shade; `color` and `roughness` are the default shading's, given if you leave them out);
 * `shade` (optional) defines fn shade(h: Hit) -> vec3f; `steps` the march's most (160); `code`: more WGSL before map
 * (helpers it calls).
 */
export function sdf(F, { map, bounds, params = {}, shade = null, steps = 160, code = '', label = 'sdf' }) {
  if (!/fn\s+map\s*\(/.test(map ?? '')) throw new Error(`sdf "${label}": map defines fn map(q: vec3f) -> vec2f`);
  if (!bounds) throw new Error(`sdf "${label}": bounds, the half extents of its own space (px), so its rays march only there`);
  return F.pass(SDF + '\n' + code + '\n' + map + '\n' + BODY(shade, steps), {
    stage: 'scene', label, bounds, params: withDefaults(shade ? {} : { color: '#bdbab3', roughness: { value: 0.5, min: 0, max: 1 } }, params),
  });
}
