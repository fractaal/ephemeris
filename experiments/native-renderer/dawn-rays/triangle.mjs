// triangle.mjs: rays fired at a known triangle and a moved copy, each answer worked out by hand. It proves the whole path: a BLAS
// from vertex and index buffers, a TLAS from raw instance words, a bind group, a ray query, and what comes back.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { create, globals } = require(process.argv[2]);
Object.assign(globalThis, globals);
const gpu = create(['backend=vulkan', 'enable-dawn-features=allow_unsafe_apis']); globalThis.keepGpu = gpu;
const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
console.log('adapter', adapter.info.description, 'feature', adapter.features.has('acceleration-structure'));
const dev = await adapter.requestDevice({ requiredFeatures: ['acceleration-structure'] });
const errors = []; dev.addEventListener('uncapturederror', (e) => { errors.push(e.error.message); console.log('ERROR', e.error.message); });
dev.lost.then((i) => { if (i.reason !== 'destroyed') console.log('LOST', i.message); });

const INPUT = 0x800;
const buf = (data, usage) => { const b = dev.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true }); new data.constructor(b.getMappedRange()).set(data); b.unmap(); return b; };
// a right triangle in the z = 0 plane, (0,0) (1,0) (0,1): its normal (v1-v0)x(v2-v0) is +z, so a ray going -z meets its front
const vb = buf(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), INPUT);
const ib = buf(new Uint32Array([0, 1, 2]), INPUT);
const blas = dev.createAccelerationStructure({ type: 'bottom-level', maxVertexCount: 3, maxIndexCount: 3 });
const tlas = dev.createAccelerationStructure({ type: 'top-level', maxInstanceCount: 2 });
// instance 0: as it is, at z = 5, id 111. Instance 1: moved by x + 10, at z = 7, id 222.
const words = new ArrayBuffer(32 * 4), f = new Float32Array(words), u = new Uint32Array(words);
f.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 5], 0); u.set([111, 0xff, 0, 0], 12);
f.set([1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 7], 16); u.set([222, 0xff, 0, 0], 28);
let enc = dev.createCommandEncoder();
enc.buildAccelerationStructure(blas, { vertexBuffer: vb, vertexCount: 3, indexBuffer: ib, indexCount: 3 });
enc.buildAccelerationStructure(tlas, { sources: [blas], instanceData: words });
dev.queue.submit([enc.finish()]);

const wgsl = `enable chromium_experimental_ray_query;
@group(0) @binding(0) var accel: acceleration_structure;
@group(0) @binding(1) var<storage, read> rays: array<vec4f>;
struct Hit { t: f32, instance: u32, id: u32, prim: u32, bary: vec2f, front: u32, kind: u32 };
@group(0) @binding(2) var<storage, read_write> hits: array<Hit>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) g: vec3u) {
  let o = rays[g.x * 2u]; let d = rays[g.x * 2u + 1u];
  var q: ray_query;
  rayQueryInitialize(&q, accel, 0u, 0xffu, o.w, d.w, o.xyz, d.xyz);
  while (rayQueryProceed(&q)) {}
  hits[g.x] = Hit(rayQueryGetCommittedT(&q), rayQueryGetCommittedInstanceIndex(&q), rayQueryGetCommittedInstanceId(&q),
    rayQueryGetCommittedPrimitiveIndex(&q), rayQueryGetCommittedTriangleBarycentrics(&q), u32(rayQueryGetCommittedTriangleFrontFace(&q)), rayQueryGetCommittedType(&q));
}`;
const m = dev.createShaderModule({ code: wgsl });
const info = await m.getCompilationInfo(); for (const x of info.messages) console.log(x.type, x.message);
const pipeline = await dev.createComputePipelineAsync({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
// origin+tmin, direction+tmax. What each should find:
const RAYS = [
  [[0.25, 0.25, 0], 0.001, [0, 0, 1], 100, { kind: 1, t: 5, id: 111, instance: 0, bary: [0.25, 0.25], front: 0 }, 'going +z: meets its back'],
  [[10.5, 0.25, 0], 0.001, [0, 0, 1], 100, { kind: 1, t: 7, id: 222, instance: 1, bary: [0.5, 0.25], front: 0 }, 'the moved copy, going +z'],
  [[0.25, 0.25, 0], 0.001, [0, 0, 2], 100, { kind: 1, t: 2.5, id: 111, instance: 0, bary: [0.25, 0.25], front: 0 }, 'a direction twice as long: t halves'],
  [[0.25, 0.25, 10], 0.001, [0, 0, -1], 100, { kind: 1, t: 5, id: 111, instance: 0, bary: [0.25, 0.25], front: 1 }, 'going -z: meets its front'],
  [[0.9, 0.9, 0], 0.001, [0, 0, 1], 100, { kind: 0 }, 'past its hypotenuse: a miss'],
  [[0.25, 0.25, 0], 0.001, [0, 0, 1], 4, { kind: 0 }, 't max short of it: a miss'],
];
const rays = new Float32Array(RAYS.length * 8);
RAYS.forEach((r, i) => rays.set([...r[0], r[1], ...r[2], r[3]], i * 8));
const rb = buf(rays, GPUBufferUsage.STORAGE);
const SIZE = 32, hb = dev.createBuffer({ size: SIZE * RAYS.length, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
const rd = dev.createBuffer({ size: SIZE * RAYS.length, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
const bg = dev.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: tlas }, { binding: 1, resource: { buffer: rb } }, { binding: 2, resource: { buffer: hb } }] });
enc = dev.createCommandEncoder(); const p = enc.beginComputePass(); p.setPipeline(pipeline); p.setBindGroup(0, bg); p.dispatchWorkgroups(RAYS.length); p.end();
enc.copyBufferToBuffer(hb, 0, rd, 0, SIZE * RAYS.length); dev.queue.submit([enc.finish()]);
await rd.mapAsync(GPUMapMode.READ);
const outF = new Float32Array(rd.getMappedRange()), outU = new Uint32Array(outF.buffer);
let bad = 0; const near = (a, b) => Math.abs(a - b) < 1e-4;
RAYS.forEach((r, i) => {
  const o = i * 8, got = { t: outF[o], instance: outU[o + 1], id: outU[o + 2], prim: outU[o + 3], bary: [outF[o + 4], outF[o + 5]], front: outU[o + 6], kind: outU[o + 7] }, want = r[4];
  const ok = got.kind === want.kind && (want.kind === 0 || (near(got.t, want.t) && got.id === want.id && got.instance === want.instance && near(got.bary[0], want.bary[0]) && near(got.bary[1], want.bary[1]) && got.front === want.front));
  if (!ok) bad++;
  console.log(ok ? 'ok  ' : 'BAD ', r[5], JSON.stringify(got));
});
console.log(bad || errors.length ? `FAILED: ${bad} wrong, ${errors.length} errors` : `PASS: ${RAYS.length} rays`);
dev.destroy(); process.exit(bad || errors.length ? 1 : 0);
