// What the camera draws: of each mesh node, the copies whose boxes are in its view this sub-frame. The passes that
// rasterise meshes (prepass, opaque, glass) draw these, and nothing else of the scene: rays (shadows, reflections, GI,
// what glass sees through) still meet every copy, so a tree out of the frame still shades the meadow and shows in the
// pool. The passes drawn in bands of rows (opaque, glass: R.bands, each band sent on its own so the desktop goes on
// drawing between them) draw each band's own list, the copies in its rows, rather than every copy again for each band.
//
// It is the frame's first pass. Without it (a film's render.passes leaving it out) every copy is drawn, in every band.
// A film may take it (./ephemeris take <film> cull) and change what is kept: a wider margin, a thing always drawn,
// grass past some distance left out, a cheaper copy far off. It reads each copy's box in the world (sub.boxes: scene.js
// copyBoxes, or shutterBoxes where it holds the copy over the frame's shutter, the boxes rays' hierarchy is built over), the copies' instance data (sub.inst: each copy's own index in
// slot 15) and the sub-frame's camera (sub.cam: scene.js cameraData), and gives sub.draw = { buf, all, bands }: each
// node's [first, count] in buf, the copies' instance data put together (the frame's list, then each band's), which
// R.drawMeshes(pass, nodes, band) draws from. What it drew it says in the frame's profile.
import { INSTANCE_FLOATS } from '../../mesh.js';

export const cull = {
  name: 'cull', stage: 'sub', reads: [], writes: [],
  // how far past the frame's edge a copy is still drawn (drawn px)
  margin: 2,
  setup() {},
  run(R, sub) {
    const { meshes, inst, boxes, cam } = sub, bands = R.bands;
    const { eye, j, B } = cam, f = B.focal, [rx, ry, rz] = B.right, [dx, dy, dz] = B.down, [bx, by, bz] = B.back;
    // (the frame in frame px: X = cx + (v·right) f / z, Y = cy + (v·down) f / z, z = -v·back, v from the eye; a drawn
    // row is rs frame px)
    const W = R.fw, H = R.fh, cx = W / 2 + j[0], cy = H / 2 + j[1], m = this.margin / R.rs, rowsPer = (R.rs * bands) / R.ph;
    const { lo, hi, c, n } = boxes, b0 = new Int16Array(n), b1 = new Int16Array(n);
    // (a box wholly outside the plane through the eye with normal (nx, ny, nz): v its centre from the eye, h its half size)
    const outside = (nx, ny, nz, vx, vy, vz, h0, h1, h2) => nx * vx + ny * vy + nz * vz + Math.abs(nx) * h0 + Math.abs(ny) * h1 + Math.abs(nz) * h2 < 0;
    for (let e = 0; e < n; e++) {
      const i3 = e * 3, vx = c[i3] - eye[0], vy = c[i3 + 1] - eye[1], vz = c[i3 + 2] - eye[2];
      const h0 = hi[i3] - c[i3], h1 = hi[i3 + 1] - c[i3 + 1], h2 = hi[i3 + 2] - c[i3 + 2];
      const zc = -(vx * bx + vy * by + vz * bz), ez = Math.abs(bx) * h0 + Math.abs(by) * h1 + Math.abs(bz) * h2;
      b0[e] = -1;
      if (zc + ez <= 0) continue;   // (behind the eye)
      if (zc - ez > 0) {
        // wholly in front: where its corners fall on the frame, and so the rows it covers
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let s = 0; s < 8; s++) {
          const px = vx + (s & 1 ? h0 : -h0), py = vy + (s & 2 ? h1 : -h1), pz = vz + (s & 4 ? h2 : -h2);
          const z = -(px * bx + py * by + pz * bz), X = cx + ((px * rx + py * ry + pz * rz) * f) / z, Y = cy + ((px * dx + py * dy + pz * dz) * f) / z;
          if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
        }
        if (x1 < -m || x0 > W + m || y1 < -m || y0 > H + m) continue;
        b0[e] = Math.max(0, Math.floor((y0 - m) * rowsPer)); b1[e] = Math.min(bands - 1, Math.floor((y1 + m) * rowsPer));
        continue;
      }
      // across the eye's plane: kept unless one of the frame's four sides has it wholly outside; in every band
      if (outside(rx * f - (cx + m) * bx, ry * f - (cx + m) * by, rz * f - (cx + m) * bz, vx, vy, vz, h0, h1, h2)) continue;
      if (outside(-rx * f + (cx - W - m) * bx, -ry * f + (cx - W - m) * by, -rz * f + (cx - W - m) * bz, vx, vy, vz, h0, h1, h2)) continue;
      if (outside(dx * f - (cy + m) * bx, dy * f - (cy + m) * by, dz * f - (cy + m) * bz, vx, vy, vz, h0, h1, h2)) continue;
      if (outside(-dx * f + (cy - H - m) * bx, -dy * f + (cy - H - m) * by, -dz * f + (cy - H - m) * bz, vx, vy, vz, h0, h1, h2)) continue;
      b0[e] = 0; b1[e] = bands - 1;
    }
    // the lists, node by node: the frame's, then (drawn in bands) each band's
    const N = meshes.length, lists = bands > 1 ? 1 + bands : 1, count = new Int32Array(lists * N);
    meshes.forEach((nd, i) => {
      for (let e = nd.first; e < nd.first + nd.instances.length; e++) {
        if (b0[e] < 0) continue;
        count[i]++;
        if (lists > 1) for (let b = b0[e]; b <= b1[e]; b++) count[(1 + b) * N + i]++;
      }
    });
    const first = new Int32Array(lists * N);
    let total = 0;
    for (let k = 0; k < first.length; k++) { first[k] = total; total += count[k]; }
    const F = INSTANCE_FLOATS, at = first.slice();
    if (!this.data || this.data.length < total * F) this.data = new Float32Array(Math.ceil(Math.max(1, total) * 1.5) * F);
    const data = this.data, put = (k, e) => { const d = at[k]++ * F, s = e * F; for (let q = 0; q < F; q++) data[d + q] = inst[s + q]; };
    meshes.forEach((nd, i) => {
      for (let e = nd.first; e < nd.first + nd.instances.length; e++) {
        if (b0[e] < 0) continue;
        put(i, e);
        if (lists > 1) for (let b = b0[e]; b <= b1[e]; b++) put((1 + b) * N + i, e);
      }
    });
    if (!this.buf || this.buf.size < data.byteLength) {
      this.buf?.destroy();
      this.buf = R.dev.createBuffer({ size: data.byteLength, label: 'copies drawn', usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    R.dev.queue.writeBuffer(this.buf, 0, data, 0, Math.max(1, total) * F);
    const list = (k) => Array.from({ length: N }, (_, i) => [first[k * N + i], count[k * N + i]]), all = list(0);
    sub.draw = { buf: this.buf, all, bands: lists > 1 ? Array.from({ length: bands }, (_, b) => list(1 + b)) : [all] };
    if (R.prof.on) {
      const drawn = count.subarray(0, N).reduce((a, x) => a + x, 0), inBands = lists > 1 ? total - drawn : drawn;
      // (the things of most copies, by name: a thing made of several meshes, as one)
      const by = new Map();
      meshes.forEach((nd, i) => { const l = nd.label || `mesh ${i}`, x = by.get(l) ?? [l, 0, 0]; x[1] += count[i]; x[2] += nd.instances.length; by.set(l, x); });
      const most = [...by.values()].filter(([, , k]) => k > 1).sort((a, b) => b[2] - a[2]).slice(0, 4);
      R.prof.say('cull', `${drawn.toLocaleString('en')} of ${n.toLocaleString('en')} copies drawn${lists > 1 ? `; in ${bands} bands, ${inBands.toLocaleString('en')} draws of them` : ''}${most.length ? ` (${most.map(([l, d, k]) => `${l} ${d.toLocaleString('en')} of ${k.toLocaleString('en')}`).join(', ')})` : ''}`);
    }
  },
};
