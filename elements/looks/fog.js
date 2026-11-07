// Fog that the scene's lights shine in: everything fades into it with distance, and every light (F.light) scatters in
// it toward the eye along each pixel's ray up to the surface there — a bulb's halo, a headlight's beam in mist, a
// torch's cone in smoke, a sun's haze (the same everywhere: a sun is far off). The fog is uneven in space (drifting wisps, two octaves of noise), and it is marched: each
// light's scattering is gathered at a few points along the ray where that light is strongest (equiangular samples: as
// many where it is near as its 1/d² says), each lit as the fog there is thick and scattering forward as fog does, so a
// halo takes the fog's shape and a beam shows the wisps it passes through; how thick the fog is along the ray is
// gathered the same way, so a surface fades behind a wisp, not under a stain stuck to it. The points are jittered per
// pixel and per sub-frame, and the sub-frames' average is smooth. A scene-stage pass (engine/pass.js): place it after
// what it covers, before what should stay clear of it.
//
// One way to do fog, written with the pass API any film has: use it, copy and change it (FOG is its WGSL: fogScatter,
// fogThickness and fogDensityAt for a film's own shaders, and fogGlow, the closed-form glow of the lights along a ray,
// cheap and noiseless: the lights a glossy floor reflects, say), or write your own. It does not shadow its light
// (nothing blocks a light's halo): for shafts that geometry cuts, march the ray in a pass of your own.
//
//   import { fog } from '../../elements/looks/fog.js';
//   const FOG = fog(F, { color: '#1c1e22', density: 0.0004 });
//   nodes.push(FOG.at({ density: motion(0.0004).to(12, 3, 0.0009) }));
//
// params: density (per px: 1/density is how far light goes before e fades it), color (the fog's own, lit by nothing),
// glow (how strongly the lights shine in it: 1 is as their intensity says), start (px from the eye before it
// thickens), far (px: how far the background is), wisps (0–1: how uneven), wispScale (px across a wisp), drift
// (px a second the wisps move along x, y, z), forward (0–0.9: how much the fog scatters light onward rather than every
// way: brighter looking toward a light, darker looking away), lightsBlur (0–0.05: how soft the halos are), samples
// (points per light along each ray, each sub-frame: more is smoother in a single sample, and costs)

import { withDefaults } from '../../engine/pass.js';

export const FOG = /* wgsl */`
fn fogNoise(x: vec3f) -> f32 {
  let i = floor(x); let f = fract(x); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(hash3(i + vec3f(0.0, 1.0, 0.0)), hash3(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
             mix(mix(hash3(i + vec3f(0.0, 0.0, 1.0)), hash3(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(hash3(i + vec3f(0.0, 1.0, 1.0)), hash3(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}
// the scene's lights scattered toward the eye along ray r from its start to T (px), in fog of this density (per px),
// evenly and isotropically, in closed form; blur widens each halo (0 sharp: a light's own glow; ~0.01 for what a rough
// surface reflects)
fn fogGlow(r: Ray, T: f32, density: f32, blur: f32) -> vec3f {
  var g = vec3f(0.0);
  var sun = vec3f(0.0);
  for (var i = 0; i < lightCount(); i++) {
    let L = world.lights[i];
    // (a sun lights the fog the same everywhere along the ray: evenly every way, as the fog in front of each part leaves it)
    if (L.kind > 1.5) { sun += L.color * 0.0795775 * (1.0 - exp(-density * T)); continue; }
    let v = L.pos - r.o; let b = dot(v, r.d); let vv = dot(v, v);
    let h = sqrt(max(vv - b * b, 1.0) + blur * blur * vv);
    var I = (atan((T - b) / h) + atan(b / h)) / h;
    if (L.kind > 0.5) { let cp = r.o + r.d * clamp(b, 0.0, T); I *= smoothstep(L.cosOuter, L.cosInner, dot(normalize(cp - L.pos), L.dir)); }
    // (dimmed by the fog on the way: along the ray to the nearest point, then across to the light)
    g += L.color * I * exp(-density * (max(b, 0.0) + h));
  }
  // a point's intensity is as bright as 1000 px away (1e6 / d²); scattered by density, evenly every way (1 / 4π)
  return g * 1.0e6 * density * 0.0795775 + sun;
}

// the fog as a medium: its mean density (per px), how forward it scatters (Henyey-Greenstein g), its wisps' size (px),
// how uneven it is (0–1), how its wisps drift (px a second), and how soft the lights' halos are
struct FogMedium { density: f32, forward: f32, scale: f32, wisps: f32, drift: vec3f, blur: f32 };
// how thick the fog is at x, as a share of its mean (1 on average): two octaves of drifting noise, the second's grid
// turned from the first's so no line of them shows
fn fogDensityAt(m: FogMedium, x: vec3f) -> f32 {
  if (m.wisps <= 0.0) { return 1.0; }
  let q = (x + m.drift * film.t) / m.scale;
  let n = fogNoise(q) * 0.62 + fogNoise(q.zxy * 2.37 + 7.1) * 0.38;
  return mix(1.0, 0.25 + 1.5 * n, m.wisps);
}
// how much of a light going way c (cosine between the light's way and the eye's, reversed) the fog sends toward the eye
fn fogPhase(c: f32, g: f32) -> f32 { let g2 = g * g; return (1.0 - g2) / (12.566371 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
// the scene's lights scattered toward the eye along ray r from \`t0\` to T (px), through medium m: each light at n
// points spread as its 1/d² along the ray is (equiangular), jittered by j (0–1, a pixel's own and a sub-frame's), each
// lit as the fog there is thick, dimmed by the fog on its way from the light and on to the eye, within a spot's cone
fn fogScatter(r: Ray, t0: f32, T: f32, m: FogMedium, n: i32, j: f32) -> vec3f {
  var g = vec3f(0.0);
  if (T <= t0) { return g; }
  for (var i = 0; i < lightCount(); i++) {
    let L = world.lights[i];
    // a sun lights the fog the same everywhere: what it scatters toward the eye, dimmed by the fog in front of each part
    if (L.kind > 1.5) { g += L.color * fogPhase(dot(L.dir, -r.d), m.forward) * (exp(-m.density * t0) - exp(-m.density * T)); continue; }
    let v = L.pos - r.o; let b = dot(v, r.d); let vv = dot(v, v);
    let h = sqrt(max(vv - b * b, 1.0) + m.blur * m.blur * vv);
    let thA = atan((t0 - b) / h); let thB = atan((T - b) / h);
    let w = (thB - thA) / h;   // (∫ 1/d² along the way: what the samples average over)
    // (a light whose most here is too little to see is left out)
    if (w * max(max(L.color.r, L.color.g), L.color.b) * 1.0e6 * m.density * fogPhase(1.0, m.forward) * 1.75 * exp(-m.density * (max(b, t0) + h)) < 2e-5) { continue; }
    var sum = 0.0;
    for (var k = 0; k < n; k++) {
      let u = (f32(k) + fract(j + f32(k) * 0.618034)) / f32(n);
      let t = b + h * tan(mix(thA, thB, u));
      let x = r.o + r.d * t;
      let lv = x - L.pos; let ld = max(length(lv), 1e-3); let ldir = lv / ld;
      var f = fogPhase(dot(ldir, -r.d), m.forward) * fogDensityAt(m, x) * exp(-m.density * (t + ld));
      if (L.kind > 0.5) { f *= smoothstep(L.cosOuter, L.cosInner, dot(ldir, L.dir)); }
      sum += f;
    }
    g += L.color * w * sum / f32(n) * 1.0e6 * m.density;
  }
  return g;
}
// how thick the fog is along r from \`t0\` to T, as a share of its mean: its density at n points along the way, spread
// as the fog hides what is past them (more where the eye still sees), jittered by j
fn fogThickness(r: Ray, t0: f32, T: f32, m: FogMedium, n: i32, j: f32) -> f32 {
  let tot = 1.0 - exp(-m.density * max(T - t0, 0.0));
  if (tot < 1e-4 || m.wisps <= 0.0) { return 1.0; }
  var a = 0.0;
  for (var k = 0; k < n; k++) {
    let u = (f32(k) + fract(j + f32(k) * 0.754877)) / f32(n);
    a += fogDensityAt(m, r.o + r.d * (t0 - log(1.0 - u * tot) / m.density));
  }
  return a / f32(n);
}`;

const DRAW = /* wgsl */`
fn draw(px: vec2f, uv: vec2f) -> vec4f {
  let r = viewRay(px); let s = surface(px);
  let T = select(p.far, length(s.xyz - r.o), s.w > 0.5);
  let m = FogMedium(max(p.density, 1e-9), p.forward, p.wispScale, p.wisps, p.drift, p.lightsBlur);
  // (this pixel's own offset for the samples, a different one each sub-frame: interleaved gradient noise)
  let j = fract(fract(52.9829189 * fract(dot(px, vec2f(0.06711056, 0.00583715)))) + film.seed * 0.618034);
  let n = i32(clamp(round(p.samples), 1.0, 32.0));
  let tr = exp(-p.density * max(T - p.start, 0.0) * fogThickness(r, p.start, T, m, n, j));
  let lit = fogScatter(r, p.start, T, m, n, j) * p.glow;
  return vec4f(input(px).rgb * tr + p.color * (1.0 - tr) + lit, 1.0);
}`;

/** The fog, as a scene-stage pass; place it with .at({ …params }) (any of them a motion). */
export function fog(F, params = {}, { label = 'fog' } = {}) {
  const r = (value, min, max) => ({ value, min, max });
  return F.pass(FOG + DRAW, {
    stage: 'scene', label,
    params: withDefaults({ density: r(0.0004, 0, 0.003), color: '#16181b', glow: r(1, 0, 4), start: r(0, 0, 5000), far: 100000, wisps: r(0.6, 0, 1),
      wispScale: r(900, 100, 5000), drift: [30, -4, 12], forward: r(0.3, 0, 0.9), lightsBlur: r(0, 0, 0.05), samples: r(6, 1, 16) }, params),
  });
}
