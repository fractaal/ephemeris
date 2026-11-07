// A preview's Wire look (LOOKS in index.js): meshes as their triangles' edges and layers as their outlines, over the
// backdrop, every line seen (as Blender's wireframe, see-through). It draws the frame's light itself, in one sub-frame.
import { COMMON } from '../shaders.js';
import { axes } from '../scene.js';

const MESH = [0.62, 0.66, 0.72], LAYER = [0.36, 0.62, 1.0];

export const wire = {
  name: 'wire', stage: 'sub', reads: [], writes: ['light', 'authored'],
  setup(R) {
    const mod = R.module(COMMON + /* wgsl */`
struct VO { @builtin(position) pos: vec4f };
@vertex fn vsBack(@builtin(vertex_index) i: u32) -> VO { let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); return VO(vec4f(p * 2.0 - 1.0, 0.0, 1.0)); }
@fragment fn fsBack(v: VO) -> @location(0) vec4f { return vec4f(backdrop(viewDir(v.pos.xy / cam.scale)), 1.0); }
struct VI { @location(0) pos: vec3f, @location(4) c0: vec4f, @location(5) c1: vec4f, @location(6) c2: vec4f };
@vertex fn vsMesh(v: VI) -> VO { return VO(project(v.c0.xyz * v.pos.x + v.c1.xyz * v.pos.y + v.c2.xyz * v.pos.z + vec3f(v.c0.w, v.c1.w, v.c2.w))); }
@fragment fn fsMesh() -> @location(0) vec4f { return vec4f(${MESH.join(', ')}, 1.0); }
// a layer's outline: world points, or frame px where it is on the screen (w 1)
@vertex fn vsLayer(@location(0) p: vec4f) -> VO {
  if (p.w > 0.5) { return VO(vec4f((p.x + cam.jitter.x - cam.center.x) / cam.center.x, -(p.y + cam.jitter.y - cam.center.y) / cam.center.y, 1.0, 1.0)); }
  return VO(project(p.xyz));
}
@fragment fn fsLayer() -> @location(0) vec4f { return vec4f(${LAYER.join(', ')}, 1.0); }`, 'wire');
    // (its pass has the frame's light and the layers as authored: the lines go in the light, the other is only cleared)
    const layout = R.pipelineLayout([R.layouts.frame]), targets = [{ format: 'rgba16float' }, { format: 'rgba16float', writeMask: 0 }];
    const P = (vs, fs, topology, buffers) => R.pipeline(`wire ${vs}`, () => ({ layout, vertex: { module: mod, entryPoint: vs, buffers }, fragment: { module: mod, entryPoint: fs, targets }, primitive: { topology } }));
    // (the meshes' vertices: their position alone, and their copy's model columns)
    const [vb, ib] = R.vertexLayout;
    this.back = P('vsBack', 'fsBack', 'triangle-list');
    this.mesh = P('vsMesh', 'fsMesh', 'line-list', [{ ...vb, attributes: [vb.attributes[0]] }, { ...ib, attributes: ib.attributes.slice(0, 3) }]);
    this.layer = P('vsLayer', 'fsLayer', 'line-list', [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }]);
    this.edges = new WeakMap();
  },
  // a model's edges, each once
  edgesOf(R, geo) {
    let e = this.edges.get(geo);
    if (e) return e;
    const idx = geo.idx, n = geo.pos.length / 3, seen = new Set(), list = [];
    for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = idx[t + k], b = idx[t + ((k + 1) % 3)], key = a < b ? a * n + b : b * n + a;
      if (!seen.has(key)) { seen.add(key); list.push(a, b); }
    }
    const data = new Uint32Array(list), buf = R.dev.createBuffer({ size: Math.max(4, data.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    R.dev.queue.writeBuffer(buf, 0, data);
    this.edges.set(geo, (e = { buf, count: data.length }));
    return e;
  },
  async run(R, sub) {
    const lines = [], [back, mesh, layer] = await Promise.all([this.back, this.mesh, this.layer]);
    for (const n of sub.layers) {
      if (n.screen) { const x0 = n.x - n.w / 2, y0 = n.y - n.h / 2, x1 = x0 + n.w, y1 = y0 + n.h, c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; for (let k = 0; k < 4; k++) lines.push(...c[k], 0, 1, ...c[(k + 1) % 4], 0, 1); continue; }
      const [U, V] = axes(n), at = (a, b) => [0, 1, 2].map((k) => [n.x, n.y, n.z ?? 0][k] + U[k] * a + V[k] * b), c = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
      for (let k = 0; k < 4; k++) lines.push(...c[k], 0, ...c[(k + 1) % 4], 0);
    }
    const p = R.enc.beginRenderPass({ label: 'wire', colorAttachments: [R.clear('light'), R.clear('authored')] });
    p.setPipeline(back); p.setBindGroup(0, R.frameBG); p.draw(3);
    p.setPipeline(mesh);
    for (const n of sub.meshes) {
      const g = R.geometry.of(n.mesh.geo), e = this.edgesOf(R, n.mesh.geo);
      p.setVertexBuffer(0, R.geometry.buf, g.vertex); p.setVertexBuffer(1, R.bufs.inst); p.setIndexBuffer(e.buf, 'uint32');
      p.drawIndexed(e.count, n.instances.length, 0, 0, n.first);
    }
    if (lines.length) {
      const data = new Float32Array(lines);
      if (!this.lineBuf || this.lineBuf.size < data.byteLength) { this.lineBuf?.destroy(); this.lineBuf = R.dev.createBuffer({ size: data.byteLength * 2, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }); }
      R.dev.queue.writeBuffer(this.lineBuf, 0, data);
      p.setPipeline(layer); p.setVertexBuffer(0, this.lineBuf); p.draw(data.length / 4);
    }
    p.end();
  },
};
