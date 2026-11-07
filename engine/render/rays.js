// Hardware rays, where the GPU and the browser have them (the device's 'acceleration-structure' feature, a build of the
// studio's own browser): the scene as the GPU's structures, each model's triangles built once, a hierarchy over every
// copy and layer built when something has moved. traceScene and rayBlocked (trace.js) then ask the hardware, every shader
// that traces taking them from the prelude; their walks stay, unused, for what has no such feature. Item numbers are the
// walk's, so what a ray meets is told the same way whichever found it. Glass is left for the shader to see (a shadow
// passes it, tinted), and solids and layers are boxes to the hardware, their true forms met here (roundBox, hitLayer).
import { INSTANCE_FLOATS } from '../mesh.js';

const FEATURE = 'acceleration-structure';
const INPUT = 0x800;    // (GPUBufferUsage's acceleration structure build input)
const WORDS = 16;       // (an instance: its row-major 3×4 transform, id, mask, flags and which source)
const NOT_OPAQUE = 8;   // (an instance's flag: its triangles reach the shader)
const BINDING = 900;    // (in the scene's group, above the texture store's)

export const hasRays = (dev) => !!dev.features?.has(FEATURE);
/** What a buffer the structures are built from needs in its usage (none where there are no rays). */
export const raysInput = (dev) => (hasRays(dev) ? INPUT : 0);
/** The scene group's entry for its structure. */
export const raysLayout = (visibility) => ({ binding: BINDING, visibility, accelerationStructure: {} });
/** A shader using them, as it is compiled: `enable` comes before anything else in a module. */
export const withRays = (code) => (code.includes('rayQueryInitialize') ? `enable chromium_experimental_ray_query;\n${code}` : code);

/** The prelude's TRACE with the hardware asked, its walks kept under other names. A film's own TRACE without them is left as it is. */
export function hardwareTrace(T) {
  if (!T.includes('fn traceScene(') || !T.includes('fn rayBlocked(')) return T;
  return T.replace('fn traceScene(', 'fn walkScene(').replace('fn rayBlocked(', 'fn walkBlocked(') + RAYS;
}

// (the ray's flag 4: a shadow's walk ends at the first thing that stops it)
const RAYS = /* wgsl */`
@group(1) @binding(${BINDING}) var accel: acceleration_structure;
// (a ray the hardware may be asked about: anything else is undefined there. A refraction at glass's rim can leave no way on at all.)
fn askable(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> bool {
  let d = dot(D, D);
  return world.tables.traced != 0 && d > 0.0 && d < 1e30 && dot(P, P) < 1e30 && tmin >= 0.0 && tmax >= tmin;
}
fn solidAlong(x: Item, P: vec3f, D: vec3f) -> f32 {
  useCopy(x.copy);
  let d = objV(D);
  let kd = length(d);
  return roundBox(objP(P), d / kd, shapeOf(x.node).S) / kd;
}
// Exactly level (a card on a box's face): the entry numbered lowest, as the walk has it, which goes through them in order
// and keeps the first it finds nearest; the hardware goes in an order of its own.
fn traceScene(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> RayHit {
  var best = RayHit(tmax, -1, -1, vec2f(0.0));
  if (!askable(P, D, tmin, tmax)) { return best; }
  var q: ray_query;
  rayQueryInitialize(&q, accel, 0u, 0xffu, tmin, tmax, P, D);
  while (rayQueryProceed(&q)) {
    if (rayQueryGetCandidateType(&q) == 0u) { rayQueryCommitCandidate(&q); continue; }
    var limit = tmax;
    if (rayQueryGetCommittedType(&q) != 0u) { limit = rayQueryGetCommittedT(&q); }
    let it = i32(rayQueryGetCandidateInstanceId(&q));
    let x = itemAt(it);
    var t = tmax;
    var ab = vec2f(0.0);
    if (x.copy < 0) {
      let h = hitLayer(planeOf(-x.copy - 1), P, D, tmin, tmax);
      t = h.x;
      ab = h.yz;
    } else {
      t = solidAlong(x, P, D);
      if (t < tmin) { continue; }
    }
    if (t >= tmax || t > limit) { continue; }
    if (t < best.t || best.item < 0 || (t == best.t && it < best.item)) { best = RayHit(t, it, -1, ab); }
    if (t < limit) { rayQueryCommitCandidate(&q, t); }
  }
  if (rayQueryGetCommittedType(&q) == 1u) {
    let T = rayQueryGetCommittedT(&q);
    let it = i32(rayQueryGetCommittedInstanceId(&q));
    if (best.item < 0 || T < best.t || (T == best.t && it < best.item)) {
      return RayHit(T, it, i32(rayQueryGetCommittedPrimitiveIndex(&q)), rayQueryGetCommittedTriangleBarycentrics(&q));
    }
  }
  return best;
}
fn rayBlocked(P: vec3f, D: vec3f, tmin: f32, tmax: f32) -> i32 {
  if (!askable(P, D, tmin, tmax)) { return RAY_CLEAR; }
  var seen = RAY_CLEAR;
  var q: ray_query;
  rayQueryInitialize(&q, accel, 4u, 0xffu, tmin, tmax, P, D);
  while (rayQueryProceed(&q)) {
    let x = itemAt(i32(rayQueryGetCandidateInstanceId(&q)));
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
    if (rayQueryGetCandidateType(&q) == 1u) {
      let t = solidAlong(x, P, D);
      if (!(t >= tmin && t < tmax)) { continue; }
    }
    if (materialAt(x.node).transmission <= 0.0) { return RAY_STOPPED; }
    seen = RAY_TINTED;
  }
  if (rayQueryGetCommittedType(&q) != 0u) { return RAY_STOPPED; }
  return seen;
}
`;

export class HardwareScene {
  constructor(dev) { this.dev = dev; this.models = new Map(); this.boxes = new Map(); this.max = 0; this.tlas = null; this.gen = 0; this.last = null; this.built = { blas: 0, tlas: 0, tlasMs: 0 }; }

  // one box, [-half, half], for solids of that size or (half 1) the layers' boxes
  box(enc, half) {
    const key = half.join();
    let b = this.boxes.get(key);
    if (!b) {
      const dev = this.dev, buf = dev.createBuffer({ size: 24, usage: INPUT, mappedAtCreation: true });
      new Float32Array(buf.getMappedRange()).set([-half[0], -half[1], -half[2], half[0], half[1], half[2]]); buf.unmap();
      b = dev.createAccelerationStructure({ type: 'bottom-level', maxAABBCount: 1, label: 'a box' });
      enc.buildAccelerationStructure(b, { aabbBuffer: buf, aabbCount: 1, opaque: false });
      this.boxes.set(key, b); this.built.blas++;
    }
    return b;
  }
  // a model's triangles, from the store's own vertices and indices (they do not change once written)
  model(R, enc, g) {
    let b = this.models.get(g);
    if (!b) {
      const vertices = (g.index - g.vertex) / 32;   // (32 bytes each, the triangles right after them: geometry.js)
      b = this.dev.createAccelerationStructure({ type: 'bottom-level', maxVertexCount: vertices, maxIndexCount: g.count, label: 'a model' });
      enc.buildAccelerationStructure(b, { vertexBuffer: R.geometry.buf, vertexOffset: g.vertex, vertexStride: 32, vertexCount: vertices, indexBuffer: R.geometry.buf, indexOffset: g.index, indexCount: g.count });
      this.models.set(g, b); this.built.blas++;
    }
    return b;
  }

  /** The scene's structure as this sub-frame has it, built where something has changed since. T: the walk's hierarchy (R.tlas). */
  sync(R, meshes, inst) {
    const T = R.tlas, n = T.items.length / 4;
    if (!this.tlas || n > this.max) {
      this.tlas?.destroy();
      this.max = Math.max(n * 2, 16);
      this.tlas = this.dev.createAccelerationStructure({ type: 'top-level', maxInstanceCount: this.max, label: 'the scene' });
      this.gen++; this.last = null;
    }
    if (this.last && (n === 0 ? this.last.n === 0 : this.last.order === T.order && same(this.last.lo, T.lo) && same(this.last.hi, T.hi) && same(this.last.inst, inst))) return this.tlas;
    const t0 = performance.now(), enc = this.dev.createCommandEncoder();

    // each entry's number in the walk's hierarchy, which a hit names
    const item = new Uint32Array(n);
    for (let i = 0; i < n; i++) item[T.order[i]] = i;

    const data = new ArrayBuffer(n * WORDS * 4), f = new Float32Array(data), u = new Uint32Array(data);
    const sources = [], at = new Map(), sourceOf = (b) => { let s = at.get(b); if (s === undefined) { s = sources.length; sources.push(b); at.set(b, s); } return s; };
    let e = 0;
    if (n > 0) meshes.forEach((m) => {
      const solid = m.mesh.solid, s = sourceOf(solid ? this.box(enc, solid.half) : this.model(R, enc, R.geometry.of(m.mesh.geo)));
      const flags = m.material.transmissionWeight > 0 ? NOT_OPAQUE : 0;
      for (let k = 0; k < m.instances.length; k++, e++) {
        const o = (m.first + k) * INSTANCE_FLOATS, w = e * WORDS;
        // (the copy's model columns, its translation in each row's w, as rows)
        f[w] = inst[o]; f[w + 1] = inst[o + 4]; f[w + 2] = inst[o + 8]; f[w + 3] = inst[o + 3];
        f[w + 4] = inst[o + 1]; f[w + 5] = inst[o + 5]; f[w + 6] = inst[o + 9]; f[w + 7] = inst[o + 7];
        f[w + 8] = inst[o + 2]; f[w + 9] = inst[o + 6]; f[w + 10] = inst[o + 10]; f[w + 11] = inst[o + 11];
        u[w + 12] = item[e]; u[w + 13] = 0xff; u[w + 14] = flags; u[w + 15] = s;
      }
    });
    // layers, each a box round its plane, as the walk's hierarchy has them
    for (; e < n; e++) {
      const w = e * WORDS, x = e * 3, s = sourceOf(this.box(enc, [1, 1, 1]));
      f[w] = (T.hi[x] - T.lo[x]) / 2; f[w + 3] = (T.hi[x] + T.lo[x]) / 2;
      f[w + 5] = (T.hi[x + 1] - T.lo[x + 1]) / 2; f[w + 7] = (T.hi[x + 1] + T.lo[x + 1]) / 2;
      f[w + 10] = (T.hi[x + 2] - T.lo[x + 2]) / 2; f[w + 11] = (T.hi[x + 2] + T.lo[x + 2]) / 2;
      u[w + 12] = item[e]; u[w + 13] = 0xff; u[w + 14] = 0; u[w + 15] = s;
    }
    enc.buildAccelerationStructure(this.tlas, { sources, instanceData: data });
    this.dev.queue.submit([enc.finish()]);
    this.last = { n, order: T.order, lo: T.lo, hi: T.hi, inst };
    this.built.tlas++; this.built.tlasMs += performance.now() - t0;
    return this.tlas;
  }
}

function same(a, b) { if (a === b) return true; if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
