enable wgpu_ray_query;
// the same rays, the GPU's ray tracing hardware walking
@group(0) @binding(0) var acc: acceleration_structure;
@group(0) @binding(1) var<storage, read> tRays: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> tHits: array<vec4f>;
@compute @workgroup_size(64) fn hwClosest(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i * 2u >= arrayLength(&tRays)) { return; }
  let a = tRays[i * 2u];
  if (a.w < 0.0) { tHits[i] = vec4f(-2.0); return; }
  let b = tRays[i * 2u + 1u];
  var q: ray_query;
  rayQueryInitialize(&q, acc, RayDesc(0u, 0xFFu, a.w, b.w, a.xyz, b.xyz));
  rayQueryProceed(&q);
  let r = rayQueryGetCommittedIntersection(&q);
  tHits[i] = vec4f(select(-1.0, r.t, r.kind != 0u), f32(r.instance_index), f32(r.primitive_index), 0.0);
}
@compute @workgroup_size(64) fn hwAny(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i * 2u >= arrayLength(&tRays)) { return; }
  let a = tRays[i * 2u];
  if (a.w < 0.0) { tHits[i] = vec4f(-2.0); return; }
  let b = tRays[i * 2u + 1u];
  var q: ray_query;
  rayQueryInitialize(&q, acc, RayDesc(4u, 0xFFu, a.w, b.w, a.xyz, b.xyz));   // (ends at the first hit)
  rayQueryProceed(&q);
  let r = rayQueryGetCommittedIntersection(&q);
  tHits[i] = vec4f(select(-1.0, 1.0, r.kind != 0u), 0.0, 0.0, 0.0);
}
