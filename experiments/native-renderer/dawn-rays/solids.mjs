// solids.mjs: a triangle and boxes the shader decides, each order of them worked out by hand, through the same logic the renderer's traceScene has.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { create, globals } = require(process.argv[2]);
Object.assign(globalThis, globals);
const gpu = create(['backend=vulkan', 'enable-dawn-features=allow_unsafe_apis']); globalThis.keepGpu = gpu;
const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
const dev = await adapter.requestDevice({ requiredFeatures: ['acceleration-structure'] });
const errors = []; dev.addEventListener('uncapturederror', (e) => { errors.push(e.error.message); console.log('ERROR', e.error.message); });
const INPUT = 0x800, buf = (data, usage) => { const b = dev.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true }); new data.constructor(b.getMappedRange()).set(data); b.unmap(); return b; };
const tri = dev.createAccelerationStructure({ type: 'bottom-level', maxVertexCount: 3 }), glass = dev.createAccelerationStructure({ type: 'bottom-level', maxVertexCount: 3 });
const box = dev.createAccelerationStructure({ type: 'bottom-level', maxAABBCount: 1 });
const vb = buf(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), INPUT), ab = buf(new Float32Array([-1, -1, -1, 1, 1, 1]), INPUT);
// each row of rays looks at its own column of the scene, x = 10 c: what lies at which z, and what the closest hit and the shadow's answer must be
const COLS = [
  { name: 'box before the triangle', parts: [['box', 3], ['tri', 8]], t: 2, kind: 2, id: 0, shadow: 2 },
  { name: 'box behind the triangle', parts: [['box', 12], ['tri', 8]], t: 8, kind: 1, id: 1, shadow: 2 },
  { name: 'box only', parts: [['box', 5]], t: 4, kind: 2, id: 0, shadow: 2 },
  { name: 'triangle only', parts: [['tri', 6]], t: 6, kind: 1, id: 1, shadow: 2 },
  { name: 'nothing', parts: [], t: 100, kind: 0, id: -1, shadow: 0 },
  { name: 'two boxes, nearer second in the list', parts: [['box', 9], ['box', 4]], t: 3, kind: 2, id: 0, shadow: 2 },
  { name: 'glass before the triangle', parts: [['glass', 3], ['tri', 8]], t: 3, kind: 1, id: 2, shadow: 2 },
  { name: 'glass alone: a shadow passes, tinted', parts: [['glass', 3]], t: 3, kind: 1, id: 2, shadow: 1 },
  { name: 'box past t max', parts: [['box', 200]], t: 100, kind: 0, id: -1, shadow: 0 },
];
const inst = []; COLS.forEach((c, x) => c.parts.forEach(([k, z]) => inst.push([k, x * 10, z])));
const blob = new ArrayBuffer(inst.length * 64), f = new Float32Array(blob), u = new Uint32Array(blob);
inst.forEach(([k, x, z], i) => { f.set([1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, z], i * 16); u.set([k === 'box' ? 0 : k === 'tri' ? 1 : 2, 0xff, k === 'glass' ? 8 : 0, k === 'box' ? 0 : k === 'tri' ? 1 : 2], i * 16 + 12); });
const tlas = dev.createAccelerationStructure({ type: 'top-level', maxInstanceCount: inst.length });
let enc = dev.createCommandEncoder();
enc.buildAccelerationStructure(tri, { vertexBuffer: vb, vertexCount: 3 }); enc.buildAccelerationStructure(glass, { vertexBuffer: vb, vertexCount: 3 });
enc.buildAccelerationStructure(box, { aabbBuffer: ab, aabbCount: 1, opaque: false });
enc.buildAccelerationStructure(tlas, { sources: [box, tri, glass], instanceData: blob }); dev.queue.submit([enc.finish()]);
const wgsl = `enable chromium_experimental_ray_query;
@group(0) @binding(0) var accel: acceleration_structure;
@group(0) @binding(1) var<storage, read_write> out: array<vec4f>;
fn boxAlong(O: vec3f, D: vec3f, c: vec3f) -> f32 { let a = (c - vec3f(1.0) - O) / D; let b = (c + vec3f(1.0) - O) / D; let lo = min(a, b); let hi = max(a, b); return max(lo.x, max(lo.y, lo.z)); }
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) g: vec3u) {
  let O = vec3f(f32(g.x) * 10.0, 0.0, 0.0); let D = normalize(vec3f(0.00001, 0.00001, 1.0)); let tmin = 0.01; let tmax = 100.0;
  var q: ray_query; var bestT = tmax; var bestId = -1.0;
  rayQueryInitialize(&q, accel, 0u, 0xffu, tmin, tmax, O, D);
  while (rayQueryProceed(&q)) {
    if (rayQueryGetCandidateType(&q) == 0u) { rayQueryCommitCandidate(&q); continue; }
    var limit = tmax;
    if (rayQueryGetCommittedType(&q) != 0u) { limit = rayQueryGetCommittedT(&q); }
    let center = rayQueryGetCandidateObjectRayOrigin(&q);
    let t = boxAlong(center, rayQueryGetCandidateObjectRayDirection(&q), vec3f(0.0));
    if (t >= tmin && t < limit) { rayQueryCommitCandidate(&q, t); bestT = t; bestId = f32(rayQueryGetCandidateInstanceId(&q)); }
  }
  let kind = rayQueryGetCommittedType(&q);
  var T = bestT; var id = bestId;
  if (kind == 1u) { T = rayQueryGetCommittedT(&q); id = f32(rayQueryGetCommittedInstanceId(&q)); }
  if (kind == 2u) { T = rayQueryGetCommittedT(&q); }
  // a shadow's: flag 4, glass tinting, boxes stopping
  var seen = 0.0; var stopped = false;
  var s: ray_query;
  rayQueryInitialize(&s, accel, 4u, 0xffu, tmin, tmax, O, D);
  while (rayQueryProceed(&s)) {
    if (rayQueryGetCandidateType(&s) == 1u) {
      let t = boxAlong(rayQueryGetCandidateObjectRayOrigin(&s), rayQueryGetCandidateObjectRayDirection(&s), vec3f(0.0));
      if (!(t >= tmin && t < tmax)) { continue; }
      stopped = true; rayQueryTerminate(&s); break;
    }
    seen = 1.0;
  }
  if (!stopped && rayQueryGetCommittedType(&s) != 0u) { stopped = true; }
  out[g.x] = vec4f(T, f32(kind), id, select(seen, 2.0, stopped));
}`;
const m = dev.createShaderModule({ code: wgsl }); for (const x of (await m.getCompilationInfo()).messages) console.log(x.type, x.message);
const p = await dev.createComputePipelineAsync({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
const hb = dev.createBuffer({ size: COLS.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }), rd = dev.createBuffer({ size: COLS.length * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
const bg = dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: tlas }, { binding: 1, resource: { buffer: hb } }] });
enc = dev.createCommandEncoder(); const c = enc.beginComputePass(); c.setPipeline(p); c.setBindGroup(0, bg); c.dispatchWorkgroups(COLS.length); c.end(); enc.copyBufferToBuffer(hb, 0, rd, 0, COLS.length * 16); dev.queue.submit([enc.finish()]);
await rd.mapAsync(GPUMapMode.READ); const o = new Float32Array(rd.getMappedRange()); let bad = 0;
COLS.forEach((w, i) => { const g = { t: o[i * 4], kind: o[i * 4 + 1], id: o[i * 4 + 2], shadow: o[i * 4 + 3] }; const ok = Math.abs(g.t - w.t) < 1e-3 && g.kind === w.kind && g.id === w.id && g.shadow === w.shadow; if (!ok) bad++; console.log(ok ? 'ok  ' : 'BAD ', w.name, JSON.stringify(g), ok ? '' : `wanted t ${w.t} kind ${w.kind} id ${w.id} shadow ${w.shadow}`); });
console.log(bad || errors.length ? `FAILED: ${bad} wrong, ${errors.length} errors` : `PASS: ${COLS.length} columns`); dev.destroy(); process.exit(bad || errors.length ? 1 : 0);
