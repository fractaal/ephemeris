import { raysInput } from './rays.js';
// Geometry: every mesh's vertices, triangles and the hierarchy rays find them by, in one GPU buffer that the camera
// draws from (as vertex and index buffer) and rays read (as storage): a model's triangles are kept once. And the
// bounding volume hierarchies, each built by the surface area heuristic: one over a model's triangles (built once), one
// over the scene's copies, a copy to a leaf (built again each frame where they have moved, refit between: see scene.js).
//
// In the buffer (16-byte units): a vertex is two (position and u; normal and v); a model's triangles are three u32 each,
// in its hierarchy's order; a hierarchy node is two: its box's low corner and, for a leaf, its first triangle or, for a
// parent, where its subtree ends (skip pointers: walked without a stack, Smits 1998); then its high corner and how many
// triangles a leaf holds (0: a parent).
const VERTEX = 32;   // bytes

export class GeometryStore {
  constructor(dev) {
    this.dev = dev;
    this.models = new WeakMap();   // geometry → its record
    this.size = 0;   // bytes used
    this.gen = 0;    // (changes when the buffer is made again: what binds it is made again)
    this.buf = null;
    this.grow(1 << 20);
  }
  /**
   * A geometry's place in the buffer, added the first time it is drawn: { vertex, index, nodes } (the byte offset of its
   * vertices and triangles; its hierarchy's root and triangles in 16-byte units, for rays), count (indices).
   */
  of(geo) {
    let r = this.models.get(geo);
    if (r) return r;
    const n = geo.pos.length / 3, { nodes, order } = triangleHierarchy(geo);
    const verts = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) {
      verts.set(geo.pos.subarray(i * 3, i * 3 + 3), i * 8); verts[i * 8 + 3] = geo.uv ? geo.uv[i * 2] : 0;
      verts.set(geo.nrm.subarray(i * 3, i * 3 + 3), i * 8 + 4); verts[i * 8 + 7] = geo.uv ? geo.uv[i * 2 + 1] : 0;
    }
    const idx = new Uint32Array(Math.max(4, Math.ceil((order.length * 3) / 4) * 4));
    order.forEach((t, i) => { idx[i * 3] = geo.idx[t * 3]; idx[i * 3 + 1] = geo.idx[t * 3 + 1]; idx[i * 3 + 2] = geo.idx[t * 3 + 2]; });
    const at = this.reserve(verts.byteLength + idx.byteLength + nodes.byteLength);
    r = { vertex: at, index: at + verts.byteLength, nodes: (at + verts.byteLength + idx.byteLength) / 16, tris: (at + verts.byteLength) / 4, verts: at / 16, count: order.length * 3 };
    const q = this.dev.queue;
    q.writeBuffer(this.buf, r.vertex, verts); q.writeBuffer(this.buf, r.index, idx); q.writeBuffer(this.buf, r.nodes * 16, nodes);
    this.models.set(geo, r);
    return r;
  }
  reserve(bytes) {
    const at = this.size;
    if (at + bytes > this.buf.size) this.grow(Math.max(this.buf.size * 2, at + bytes));
    this.size += Math.ceil(bytes / 16) * 16;
    return at;
  }
  grow(bytes) {
    const old = this.buf;
    this.buf = this.dev.createBuffer({ size: bytes, label: 'geometry', usage: raysInput(this.dev) | GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    if (old) {
      const enc = this.dev.createCommandEncoder();
      enc.copyBufferToBuffer(old, 0, this.buf, 0, this.size);
      this.dev.queue.submit([enc.finish()]);
      old.destroy();
    }
    this.gen++;
  }
}

/** How a mesh's vertices reach the camera's shader: position, u, normal, v (one per vertex), then its copy's. */
export const VERTEX_LAYOUT = (instanceFloats) => [
  { arrayStride: VERTEX, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32' },
    { shaderLocation: 2, offset: 16, format: 'float32x3' }, { shaderLocation: 3, offset: 28, format: 'float32' }] },
  { arrayStride: instanceFloats * 4, stepMode: 'instance', attributes: Array.from({ length: instanceFloats / 4 }, (_, i) => ({ shaderLocation: 4 + i, offset: i * 16, format: 'float32x4' })) },
];

/**
 * A bounding volume hierarchy over n boxes (low and high corners, centres: xyz each, flat), depth first, laid out as a
 * model's (above), one box to a leaf, so that a ray tests a copy's own box before it opens the copy; `order`: the boxes'
 * indices in the leaves' order. Each node is split where the surface area heuristic finds cheapest among up to 16 bins
 * of centres along their widest spread (binned SAH, Wald 2007): a ray's chance of entering a box goes as its area, so a
 * large thing (the ground, a wall) is kept apart from the small things around it rather than enlarging every box it
 * shares with them. A subtree of m boxes is 2m - 1 nodes, so each node's place and skip pointer are known before what is
 * below it is built. Typed arrays throughout, no recursion: ~25 ms for 25,000 copies.
 */
export function hierarchy(lo, hi, c, n) {
  const B = 16, tree = new Float32Array(Math.max(0, 2 * n - 1) * 8), order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const area = (x0, x1, x2) => x0 * x1 + x1 * x2 + x2 * x0;
  // (12 bounds at r in f: a box's low and high corners, then its centres' low and high)
  const empty = (f, r) => { f[r] = f[r + 1] = f[r + 2] = f[r + 6] = f[r + 7] = f[r + 8] = Infinity; f[r + 3] = f[r + 4] = f[r + 5] = f[r + 9] = f[r + 10] = f[r + 11] = -Infinity; };
  const add = (f, r, x) => {
    if (lo[x] < f[r]) f[r] = lo[x]; if (lo[x + 1] < f[r + 1]) f[r + 1] = lo[x + 1]; if (lo[x + 2] < f[r + 2]) f[r + 2] = lo[x + 2];
    if (hi[x] > f[r + 3]) f[r + 3] = hi[x]; if (hi[x + 1] > f[r + 4]) f[r + 4] = hi[x + 1]; if (hi[x + 2] > f[r + 5]) f[r + 5] = hi[x + 2];
    if (c[x] < f[r + 6]) f[r + 6] = c[x]; if (c[x + 1] < f[r + 7]) f[r + 7] = c[x + 1]; if (c[x + 2] < f[r + 8]) f[r + 8] = c[x + 2];
    if (c[x] > f[r + 9]) f[r + 9] = c[x]; if (c[x + 1] > f[r + 10]) f[r + 10] = c[x + 1]; if (c[x + 2] > f[r + 11]) f[r + 11] = c[x + 2];
  };
  const bounds = (s, e, f, r) => { empty(f, r); for (let i = s; i < e; i++) add(f, r, order[i] * 3); };
  // (the bounds at q in g taken in by those at r in f)
  const merge = (f, r, g, q) => {
    for (let k = 0; k < 3; k++) { if (g[q + k] < f[r + k]) f[r + k] = g[q + k]; if (g[q + k + 3] > f[r + k + 3]) f[r + k + 3] = g[q + k + 3]; if (g[q + k + 6] < f[r + k + 6]) f[r + k + 6] = g[q + k + 6]; if (g[q + k + 9] > f[r + k + 9]) f[r + k + 9] = g[q + k + 9]; }
  };
  // (the bins: each one's count and its boxes' bounds; each cut's right side: its count, its cost)
  const cnt = new Int32Array(B), bin = new Float64Array(B * 12), rn = new Int32Array(B), rc = new Float64Array(B);
  // (the ranges still to build: their first and end in order, and their node; and their bounds, found as their parent
  // was split)
  const todo = new Int32Array(Math.max(3, 3 * (n + 1))), tb = new Float64Array(Math.max(12, 12 * (n + 1)));
  let top = 0;
  if (n) { todo[0] = 0; todo[1] = n; todo[2] = 0; top = 3; bounds(0, n, tb, 0); }
  while (top) {
    top -= 3;
    const s = todo[top], e = todo[top + 1], at = todo[top + 2], m = e - s, o = at * 8, r = top * 4;
    tree[o] = tb[r]; tree[o + 1] = tb[r + 1]; tree[o + 2] = tb[r + 2]; tree[o + 4] = tb[r + 3]; tree[o + 5] = tb[r + 4]; tree[o + 6] = tb[r + 5];
    if (m === 1) { tree[o + 3] = s; tree[o + 7] = 1; continue; }
    tree[o + 3] = at + 2 * m - 1; tree[o + 7] = 0;
    // its boxes in bins (as many as boxes, up to B) by their centres along the axis they spread widest on
    const w0 = tb[r + 9] - tb[r + 6], w1 = tb[r + 10] - tb[r + 7], w2 = tb[r + 11] - tb[r + 8];
    const ax = w0 >= w1 && w0 >= w2 ? 0 : w1 >= w2 ? 1 : 2, w = ax === 0 ? w0 : ax === 1 ? w1 : w2, from = tb[r + 6 + ax];
    const nb = m < B ? m : B, k = nb / w, binOf = (x) => Math.min(nb - 1, ((c[x + ax] - from) * k) | 0);
    // (the right side's bounds go where this range's were, the left's above them)
    const R = r, L = r + 12;
    let mid = s + (m >> 1);
    if (m === 2) {
      // (two boxes, the commonest case: the one with its centre lower first, as a cut between two bins would have them)
      if (w > 0 && c[order[s] * 3 + ax] > c[order[s + 1] * 3 + ax]) { const x = order[s]; order[s] = order[s + 1]; order[s + 1] = x; }
      bounds(s, mid, tb, L); bounds(mid, e, tb, R);
    } else if (w > 0) {
      for (let b = 0; b < nb; b++) { cnt[b] = 0; empty(bin, b * 12); }
      for (let i = s; i < e; i++) { const x = order[i] * 3, b = binOf(x); cnt[b]++; add(bin, b * 12, x); }
      // the cheapest cut between bins: the count on each side times its box's area
      let n0 = 0, x0 = Infinity, x1 = Infinity, x2 = Infinity, y0 = -Infinity, y1 = -Infinity, y2 = -Infinity;
      for (let b = nb - 1; b > 0; b--) {
        const q = b * 12;
        n0 += cnt[b];
        if (cnt[b]) { x0 = Math.min(x0, bin[q]); x1 = Math.min(x1, bin[q + 1]); x2 = Math.min(x2, bin[q + 2]); y0 = Math.max(y0, bin[q + 3]); y1 = Math.max(y1, bin[q + 4]); y2 = Math.max(y2, bin[q + 5]); }
        rn[b] = n0; rc[b] = n0 * area(y0 - x0, y1 - x1, y2 - x2);
      }
      let best = Infinity, cut = 0;
      n0 = 0; x0 = x1 = x2 = Infinity; y0 = y1 = y2 = -Infinity;
      for (let b = 0; b < nb - 1; b++) {
        const q = b * 12;
        n0 += cnt[b];
        if (cnt[b]) { x0 = Math.min(x0, bin[q]); x1 = Math.min(x1, bin[q + 1]); x2 = Math.min(x2, bin[q + 2]); y0 = Math.max(y0, bin[q + 3]); y1 = Math.max(y1, bin[q + 4]); y2 = Math.max(y2, bin[q + 5]); }
        if (!n0 || !rn[b + 1]) continue;
        const cost = n0 * area(y0 - x0, y1 - x1, y2 - x2) + rc[b + 1];
        if (cost < best) { best = cost; cut = b; }
      }
      // put in two, those in the bins up to the cut first, each side's bounds those of its bins (the first bin and the
      // last each hold a box, so neither side is empty)
      empty(tb, L); empty(tb, R);
      for (let b = 0; b < nb; b++) if (cnt[b]) merge(tb, b <= cut ? L : R, bin, b * 12);
      let i = s, j = e - 1;
      while (i <= j) {
        const x = order[i] * 3;
        if (binOf(x) <= cut) i++; else { order[i] = order[j]; order[j] = x / 3; j--; }
      }
      mid = i;
    } else { bounds(s, mid, tb, L); bounds(mid, e, tb, R); }   // (their centres all one point: in halves)
    todo[top] = mid; todo[top + 1] = e; todo[top + 2] = at + 2 * (mid - s);
    todo[top + 3] = s; todo[top + 4] = mid; todo[top + 5] = at + 1;
    top += 6;
  }
  return { tree, order };
}

/**
 * A hierarchy's boxes found again for its boxes moved (lo, hi: the same n boxes hierarchy() was built over, in the same
 * order), its shape kept: each leaf's box from its boxes, each other node's from the two below it (the node after it,
 * and the one after that one's subtree). The same boxes as a build gives for the same tree; a tree as good as a new one
 * while things move little (what a frame's sub-frames see), at a fraction of a build's cost. tree: changed in place.
 */
export function refit(tree, order, lo, hi) {
  for (let at = tree.length / 8 - 1; at >= 0; at--) {
    const o = at * 8, count = tree[o + 7];
    let l0 = Infinity, l1 = Infinity, l2 = Infinity, h0 = -Infinity, h1 = -Infinity, h2 = -Infinity;
    if (count > 0) {
      for (let i = tree[o + 3], e = i + count; i < e; i++) {
        const b = order[i] * 3;
        l0 = Math.min(l0, lo[b]); l1 = Math.min(l1, lo[b + 1]); l2 = Math.min(l2, lo[b + 2]);
        h0 = Math.max(h0, hi[b]); h1 = Math.max(h1, hi[b + 1]); h2 = Math.max(h2, hi[b + 2]);
      }
    } else {
      const a = o + 8, b = (tree[a + 7] > 0 ? at + 2 : tree[a + 3]) * 8;
      l0 = Math.min(tree[a], tree[b]); l1 = Math.min(tree[a + 1], tree[b + 1]); l2 = Math.min(tree[a + 2], tree[b + 2]);
      h0 = Math.max(tree[a + 4], tree[b + 4]); h1 = Math.max(tree[a + 5], tree[b + 5]); h2 = Math.max(tree[a + 6], tree[b + 6]);
    }
    tree[o] = l0; tree[o + 1] = l1; tree[o + 2] = l2; tree[o + 4] = h0; tree[o + 5] = h1; tree[o + 6] = h2;
  }
}

/** How large a hierarchy's boxes are, all told: the sum of their areas (a ray's chance of entering a box goes as its area). */
export function surface(tree) {
  let sum = 0;
  for (let o = 0; o < tree.length; o += 8) {
    const x = tree[o + 4] - tree[o], y = tree[o + 5] - tree[o + 1], z = tree[o + 6] - tree[o + 2];
    sum += x * y + y * z + z * x;
  }
  return sum;
}

/**
 * A model's triangles' hierarchy: split where the surface area heuristic finds cheapest among 12 bins per axis; its nodes
 * (as hierarchy() lays them out) and its triangles' order.
 */
function triangleHierarchy({ pos, idx }) {
  const n = idx.length / 3;
  const lo = new Float32Array(n * 3), hi = new Float32Array(n * 3), c = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) for (let a = 0; a < 3; a++) {
    const v = [0, 1, 2].map((k) => pos[idx[t * 3 + k] * 3 + a]);
    lo[t * 3 + a] = Math.min(...v); hi[t * 3 + a] = Math.max(...v); c[t * 3 + a] = (v[0] + v[1] + v[2]) / 3;
  }
  const order = Int32Array.from({ length: n }, (_, i) => i), nodes = [];
  const area = (l, h) => { const d = [h[0] - l[0], h[1] - l[1], h[2] - l[2]]; return d[0] * d[1] + d[1] * d[2] + d[2] * d[0]; };
  const grow = (b, l, h) => { for (let k = 0; k < 3; k++) { b.l[k] = Math.min(b.l[k], l[k]); b.h[k] = Math.max(b.h[k], h[k]); } };
  const empty = () => ({ n: 0, l: [Infinity, Infinity, Infinity], h: [-Infinity, -Infinity, -Infinity] });
  const B = 12;
  const build = (s, e) => {
    const at = nodes.length, all = empty(), cs = empty();
    for (let i = s; i < e; i++) { const t = order[i] * 3; grow(all, lo.subarray(t, t + 3), hi.subarray(t, t + 3)); grow(cs, c.subarray(t, t + 3), c.subarray(t, t + 3)); }
    nodes.push(null);
    let best = { cost: (e - s) * area(all.l, all.h), ax: -1, split: 0 };
    if (e - s > 2) for (let a = 0; a < 3; a++) {
      const w = cs.h[a] - cs.l[a];
      if (w <= 0) continue;
      const bins = Array.from({ length: B }, empty);
      for (let i = s; i < e; i++) {
        const t = order[i] * 3, b = bins[Math.min(B - 1, Math.floor(((c[t + a] - cs.l[a]) / w) * B))];
        b.n++; grow(b, lo.subarray(t, t + 3), hi.subarray(t, t + 3));
      }
      // the cost of each split: either side's count times its box's area (in the parent's units: a ray's chance of entering)
      const left = [], acc = empty();
      for (let i = 0; i < B - 1; i++) { acc.n += bins[i].n; grow(acc, bins[i].l, bins[i].h); left.push(acc.n ? acc.n * area(acc.l, acc.h) : 0); }
      const r = empty();
      for (let i = B - 1; i > 0; i--) {
        r.n += bins[i].n; grow(r, bins[i].l, bins[i].h);
        const cost = 0.5 * area(all.l, all.h) + left[i - 1] + (r.n ? r.n * area(r.l, r.h) : 0);
        if (r.n && r.n < e - s && cost < best.cost) best = { cost, ax: a, split: cs.l[a] + (w * i) / B };
      }
    }
    let mid = null;
    if (best.ax >= 0) {
      let i = s, j = e - 1;
      while (i <= j) { if (c[order[i] * 3 + best.ax] < best.split) i++; else { const t = order[i]; order[i] = order[j]; order[j] = t; j--; } }
      if (i > s && i < e) mid = i;   // (a split rounding left one side empty: as if none were cheaper)
    }
    if (mid == null) {
      if (e - s <= 8) { nodes[at] = [...all.l, s, ...all.h, e - s]; return; }
      // nothing cheaper than one leaf, but too many for one: halves along the widest spread of centres
      const ax = [0, 1, 2].reduce((m, a) => (cs.h[a] - cs.l[a] > cs.h[m] - cs.l[m] ? a : m), 0);
      order.set(Array.from(order.subarray(s, e)).sort((p, q) => c[p * 3 + ax] - c[q * 3 + ax]), s);
      mid = (s + e) >> 1;
    }
    build(s, mid);
    build(mid, e);
    nodes[at] = [...all.l, nodes.length, ...all.h, 0];
  };
  if (n) build(0, n);
  else nodes.push([0, 0, 0, 0, 0, 0, 0, 0]);
  return { nodes: new Float32Array(nodes.flat()), order };
}
