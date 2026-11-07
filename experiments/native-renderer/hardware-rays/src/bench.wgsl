
// ---------- the benchmark's own, after the renderer's prelude
@group(2) @binding(0) var<storage, read_write> genP: array<vec4f>;
@group(2) @binding(1) var<storage, read_write> genG: array<vec4f>;
@group(2) @binding(2) var<storage, read_write> genS: array<vec4f>;
@group(2) @binding(3) var<storage, read> tRays: array<vec4f>;
@group(2) @binding(4) var<storage, read_write> tHits: array<vec4f>;

// each ray two vec4s: origin and tmin (below 0: no ray), way and tmax
@compute @workgroup_size(8, 8) fn gen(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(cam.drawn);
  if (any(id.xy >= size)) { return; }
  let i = id.y * size.x + id.x;
  let D = viewDir(vec2f(id.xy) + 0.5);
  genP[i * 2u] = vec4f(cam.eye, 0.2); genP[i * 2u + 1u] = vec4f(D, 1e6);
  genG[i * 2u] = vec4f(0.0, 0.0, 0.0, -1.0); genS[i * 2u] = vec4f(0.0, 0.0, 0.0, -1.0);
  let h = traceScene(cam.eye, D, 0.2, 1e6);
  if (h.item < 0 || itemAt(h.item).copy < 0) { return; }
  let p = pointAt(h, cam.eye, D, 0.0);
  let N = select(p.N, -p.N, dot(p.N, D) > 0.0);
  let O = p.P + N * 0.5;
  // a GI ray as the renderer sends them: a way over the sphere by area, turned to the surface's side
  let k = f32((id.x & 255u) + (id.y & 255u) * 256u);
  let u = fract(0.5 + k * vec2f(0.7548777, 0.5698403));
  let z = 2.0 * u.y - 1.0; let r = sqrt(max(1.0 - z * z, 0.0)); let ph = u.x * 6.2831853;
  let w = vec3f(r * cos(ph), z, r * sin(ph));
  genG[i * 2u] = vec4f(O, 0.2); genG[i * 2u + 1u] = vec4f(select(w, -w, dot(w, N) < 0.0), 1e6);
  // toward the sun
  var L = vec3f(0.3, -0.9, 0.3);
  for (var l = 0; l < lightCount(); l++) { if (world.lights[l].kind > 1.5) { L = -world.lights[l].dir; break; } }
  genS[i * 2u] = vec4f(O, 0.2); genS[i * 2u + 1u] = vec4f(normalize(L), 1e6);
}

// the renderer's walk, as traceScene is
@compute @workgroup_size(64) fn swClosest(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i * 2u >= arrayLength(&tRays)) { return; }
  let a = tRays[i * 2u];
  if (a.w < 0.0) { tHits[i] = vec4f(-2.0); return; }
  let b = tRays[i * 2u + 1u];
  let h = traceScene(a.xyz, b.xyz, a.w, b.w);
  tHits[i] = vec4f(select(-1.0, h.t, h.item >= 0), f32(h.item), f32(h.prim), 0.0);
}
// rayBlocked's walk, without what it asks of glass and layers' pictures
fn bxBlocked(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> bool {
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
    if (s.y < max(s.x, tmin) || s.x > tmax) { ni = select(i32(lo.w), ni + 1, count > 0); continue; }
    for (var k = 0; k < count; k++) {
      let x = itemAt(i32(lo.w) + k);
      if (x.copy < 0) { continue; }
      useCopy(x.copy);
      let sh = shapeOf(x.node);
      let o = objP(P);
      let d = objV(D);
      if (sh.solid) { let kd = length(d); let t = roundBox(o, d / kd, sh.S) / kd; if (t >= tmin && t < tmax) { return true; } }
      else if (anyTri(sh, o, d, tmin, tmax)) { return true; }
    }
    ni++;
  }
  return false;
}
@compute @workgroup_size(64) fn swAny(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i * 2u >= arrayLength(&tRays)) { return; }
  let a = tRays[i * 2u];
  if (a.w < 0.0) { tHits[i] = vec4f(-2.0); return; }
  let b = tRays[i * 2u + 1u];
  tHits[i] = vec4f(select(-1.0, 1.0, bxBlocked(a.xyz, b.xyz, a.w, b.w)), 0.0, 0.0, 0.0);
}

// the renderer's real GI ray: what it meets shaded, by its lights and their shadows, its surfaces and materials (as giTrace calls it)
@compute @workgroup_size(64) fn realGi(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i * 2u >= arrayLength(&tRays)) { return; }
  let a = tRays[i * 2u];
  if (a.w < 0.0) { tHits[i] = vec4f(-2.0); return; }
  let b = tRays[i * 2u + 1u];
  let size = u32(cam.drawn.x);
  let got = traceLight(a.xyz, b.xyz, 0.15, length(a.xyz - cam.eye) / cam.focal, vec2f(f32(i % size), f32(i / size)), true);
  tHits[i] = vec4f(got.light, got.first);
}
