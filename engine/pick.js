// Picking, for the editor: what is under a point of the frame at a moment, and its outline. The camera's ray through
// the point meets every copy of every mesh (a box's or sphere's exact form, as the renderer meets it; a model's
// triangles) and every layer in the world where its picture is not see-through, nearest first; layers on the screen
// (titles) are over everything, the last drawn on top.
import { basis, project, hull, W, H } from './lens.js';
import { axes } from './render/scene.js';
import { instanceData, INSTANCE_FLOATS } from './mesh.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const along = (P, D, t) => [P[0] + D[0] * t, P[1] + D[1] * t, P[2] + D[2] * t];

/** The camera's ray through frame point (x, y): from its eye, unit. */
export function rayAt(camera, x, y) {
  const B = basis(camera), u = (x - W / 2) / B.focal, v = (y - H / 2) / B.focal;
  const D = [0, 1, 2].map((k) => B.right[k] * u + B.down[k] * v - B.back[k]), l = Math.hypot(...D);
  return { B, P: B.eye, D: D.map((d) => d / l) };
}

/** A copy's model matrix (columns, translation) and inverse rows, as the instance buffer holds them. */
function copyOf(n, k) {
  const f = new Float32Array(INSTANCE_FLOATS);
  instanceData([n.instances[k]], f, 0);
  return {
    world: (p) => [0, 1, 2].map((a) => f[a] * p[0] + f[4 + a] * p[1] + f[8 + a] * p[2] + f[a * 4 + 3]),
    objV: (v) => [0, 1, 2].map((j) => f[12 + j * 4] * v[0] + f[12 + j * 4 + 1] * v[1] + f[12 + j * 4 + 2] * v[2]),
    T: [f[3], f[7], f[11]],
  };
}

// where a ray from o going d (unit, in the solid's own space) first meets a solid (half extents h, edge radius r) from
// outside, or -1: the box, then off its faces' flat parts its rounded edges and corner (Quilez; the renderer's roundBox)
function roundBox(o0, d0, h, r) {
  const size = h.map((v) => v - r), m = d0.map((v) => 1 / (Math.abs(v) < 1e-9 ? 1e-9 : v));
  const t1 = [0, 1, 2].map((a) => -m[a] * o0[a] - Math.abs(m[a]) * h[a]), t2 = [0, 1, 2].map((a) => -m[a] * o0[a] + Math.abs(m[a]) * h[a]);
  const tN = Math.max(...t1), tF = Math.min(...t2);
  if (tN > tF || tF < 0) return -1;
  const sg = [0, 1, 2].map((a) => (o0[a] + tN * d0[a] >= 0 ? 1 : -1)), ro = o0.map((v, a) => v * sg[a]), rd = d0.map((v, a) => v * sg[a]);
  const p = [0, 1, 2].map((a) => ro[a] + tN * rd[a] - size[a]);
  if (Math.min(Math.max(p[0], p[1]), Math.max(p[1], p[2]), Math.max(p[2], p[0])) < 0) return tN;
  const oc = sub(ro, size), r2 = r * r;
  let t = 1e20;
  const b = dot(oc, rd), hc = b * b - (dot(oc, oc) - r2);
  if (hc > 0) t = -b - Math.sqrt(hc);
  for (let a = 0; a < 3; a++) {
    const j = (a + 1) % 3, l = (a + 2) % 3, A = rd[j] ** 2 + rd[l] ** 2, B = oc[j] * rd[j] + oc[l] * rd[l];
    const hh = B * B - A * (oc[j] ** 2 + oc[l] ** 2 - r2);
    if (hh > 0) { const e = (-B - Math.sqrt(hh)) / A; if (e > 0 && e < t && Math.abs(ro[a] + rd[a] * e) < size[a]) t = e; }
  }
  return t < 1e19 ? t : -1;
}

// the nearest of a model's triangles along o + d t (its own space; t as in the world), past tmin
function triangles(geo, o, d) {
  const { pos, idx } = geo;
  let best = Infinity;
  for (let i = 0; i < idx.length; i += 3) {
    const a = [pos[idx[i] * 3], pos[idx[i] * 3 + 1], pos[idx[i] * 3 + 2]];
    const e1 = sub([pos[idx[i + 1] * 3], pos[idx[i + 1] * 3 + 1], pos[idx[i + 1] * 3 + 2]], a);
    const e2 = sub([pos[idx[i + 2] * 3], pos[idx[i + 2] * 3 + 1], pos[idx[i + 2] * 3 + 2]], a);
    const p = cross(d, e2), det = dot(e1, p);
    if (det === 0) continue;
    const w = sub(o, a), u = dot(w, p) / det;
    if (u < 0 || u > 1) continue;
    const q = cross(w, e1), v = dot(d, q) / det;
    if (v < 0 || u + v > 1) continue;
    const t = dot(e2, q) / det;
    if (t > 1e-3 && t < best) best = t;
  }
  return best;
}

// where a ray from o going d enters a box (lo, hi), or Infinity
function slab(lo, hi, o, d) {
  let tn = -Infinity, tf = Infinity;
  for (let a = 0; a < 3; a++) {
    const inv = 1 / (Math.abs(d[a]) < 1e-12 ? 1e-12 : d[a]), t0 = (lo[a] - o[a]) * inv, t1 = (hi[a] - o[a]) * inv;
    tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1));
  }
  return tf >= Math.max(tn, 0) ? Math.max(tn, 0) : Infinity;
}

// a mesh node's nearest copy along the ray: { t, copy }
function meshHit(n, P, D) {
  const solid = n.mesh.solid, [lo, hi] = n.mesh.bounds;
  let best = { t: Infinity, copy: -1 };
  for (let k = 0; k < n.instances.length; k++) {
    const C = copyOf(n, k), o = C.objV(sub(P, C.T)), d = C.objV(D);
    if (slab(lo, hi, o, d) >= best.t) continue;
    let t;
    if (solid) { const l = Math.hypot(...d), s = roundBox(o, d.map((v) => v / l), solid.half, solid.r); t = s > 0 ? s / l : Infinity; }
    else t = triangles(n.mesh.geo, o, d);
    if (t < best.t) best = { t, copy: k };
  }
  return best;
}

// a plane (a layer's) along the ray: distance and where across it (u, v from its top left, 0–1)
function planeHit(n, P, D) {
  const [U, V] = axes(n), C = [n.x, n.y, n.z ?? 0], N = cross(U, V), dn = dot(D, N);
  if (Math.abs(dn) < 1e-9) return null;
  const t = dot(sub(C, P), N) / dn;
  if (t <= 0) return null;
  const X = sub(along(P, D, t), C), a = dot(X, U) / dot(U, U), b = dot(X, V) / dot(V, V);
  return Math.abs(a) <= 1 && Math.abs(b) <= 1 ? { t, uv: [(a + 1) / 2, (b + 1) / 2] } : null;
}

// how see-through a layer's picture is at uv (its capture, read back: one texel), times its opacity
async function alphaAt(dev, n, [u, v]) {
  const L = n.tex;
  if (!L?.capture) return n.opacity ?? 1;
  const buf = dev.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: L.capture, origin: { x: Math.min(L.w - 1, Math.floor(u * L.w)), y: Math.min(L.h - 1, Math.floor(v * L.h)) } }, { buffer: buf, bytesPerRow: 256 }, [1, 1]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const a = new Uint8Array(buf.getMappedRange())[3] / 255;
  buf.unmap(); buf.destroy();
  return a * (n.opacity ?? 1);
}

/**
 * What is under frame point (x, y) in `scene` (as the renderer draws it: its camera, its nodes): { node (its index),
 * copy (of a mesh's), t (distance), point (world) }, or null.
 */
export async function pickAt(scene, x, y, dev) {
  const nodes = scene.nodes, solid = 0.25;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!n?.screen || !n.tex) continue;
    const [U, V] = axes(n), dx = x - n.x, dy = y - n.y, det = U[0] * V[1] - U[1] * V[0];
    if (!det) continue;
    const a = (dx * V[1] - dy * V[0]) / det, b = (U[0] * dy - U[1] * dx) / det;
    if (Math.abs(a) <= 1 && Math.abs(b) <= 1 && (await alphaAt(dev, n, [(a + 1) / 2, (b + 1) / 2])) > solid) return { node: i, copy: 0, t: 0, point: null };
  }
  const { P, D, B } = rayAt(scene.camera, x, y), hits = [];
  // the scene's own lights, marked in the editor's viewer: one within 24 px of where it is, the nearest
  let light = null;
  nodes.forEach((n, i) => {
    if (!n?.light) return;
    const p = project([n.x ?? 0, n.y ?? 0, n.z ?? 0], B);
    if (p.depth > 1 && Math.hypot(p.x - x, p.y - y) <= 24 && (!light || p.depth < light.t)) light = { node: i, copy: 0, t: p.depth };
  });
  if (light) { const n = nodes[light.node]; return { ...light, point: [n.x ?? 0, n.y ?? 0, n.z ?? 0] }; }
  nodes.forEach((n, i) => {
    if (!n || n.screen) return;
    if (n.tex && (n.opacity ?? 1) > 0.001) { const h = planeHit(n, P, D); if (h) hits.push({ node: i, copy: 0, ...h }); }
    if (n.mesh && n.instances?.length) { const h = meshHit(n, P, D); if (h.copy >= 0) hits.push({ node: i, copy: h.copy, t: h.t }); }
    // (a placed pass, an SDF object say: where the ray enters its bounds, as it is placed)
    if (n.pass?.bounds) { const C = copyOf({ instances: [n] }, 0), h = n.pass.bounds, t = slab(h.map((v) => -v), h, C.objV(sub(P, C.T)), C.objV(D)); if (t < Infinity) hits.push({ node: i, copy: 0, t }); }
  });
  hits.sort((a, b) => a.t - b.t);
  for (const h of hits) if (!h.uv || (await alphaAt(dev, nodes[h.node], h.uv)) > solid) return { ...h, point: along(P, D, h.t) };
  return null;
}

/** A node's (or a mesh copy's) outline on the frame, seen by `camera`: a polygon of frame points, or null if behind it. */
/** A placed thing's corners in the world: its box's eight (a mesh), its plane's four (a layer); null on the screen. */
export function corners(n, copy) {
  if (n.screen) return null;
  // (a light: a small box round where it is, as large as the light)
  if (n.light) { const c = [n.x ?? 0, n.y ?? 0, n.z ?? 0], h = Math.max(n.radius ?? 0, 12); return [0, 1, 2, 3, 4, 5, 6, 7].map((m) => [c[0] + (m & 1 ? h : -h), c[1] + (m & 2 ? h : -h), c[2] + (m & 4 ? h : -h)]); }
  // (a pass: its bounds, if it is placed; one over the whole frame has none)
  if (n.pass) { if (!n.pass.bounds) return null; const C = copyOf({ instances: [n] }, 0), h = n.pass.bounds; return [0, 1, 2, 3, 4, 5, 6, 7].map((m) => C.world([m & 1 ? h[0] : -h[0], m & 2 ? h[1] : -h[1], m & 4 ? h[2] : -h[2]])); }
  if (n.mesh) {
    const C = copyOf(n, copy), s = n.mesh.solid, [lo, hi] = s ? [s.half.map((v) => -v), s.half] : n.mesh.bounds;
    return [0, 1, 2, 3, 4, 5, 6, 7].map((m) => C.world([m & 1 ? hi[0] : lo[0], m & 2 ? hi[1] : lo[1], m & 4 ? hi[2] : lo[2]]));
  }
  const [U, V] = axes(n), c = [n.x, n.y, n.z ?? 0];
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [0, 1, 2].map((k) => c[k] + U[k] * a + V[k] * b));
}
export function outline(n, copy, camera, c = corners(n, copy)) {
  if (n.screen) { const [U, V] = axes(n); return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [n.x + U[0] * a + V[0] * b, n.y + U[1] * a + V[1] * b]); }
  if (!c) return null;
  const B = basis(camera), q = c.map((p) => project(p, B));
  if (q.some((p) => p.depth <= 1)) return null;
  return hull(q.map((p) => [p.x, p.y]));
}

export { siteOf } from './site.js';

/** A copy's plain fields (its position, turn, scale, colour and the film's own: what tells it from the others). */
export const fieldsOf = (it) => Object.fromEntries(Object.entries(it).filter(([, v]) => v == null || ['number', 'string', 'boolean'].includes(typeof v)));
/**
 * Which of a node's copies is the one named { key, like, copy }: by its id (a copy's `id` or `key`, if the film gives
 * them), else the copy sharing the most fields with `like` (a list the film rebuilds each moment keeps what does not
 * move: its size, colour, its own data), the nearest of those; else by place in the list. -1: none.
 */
export function matchCopy(instances, { key = null, like = null, copy = 0 }) {
  if (key != null) return instances.findIndex((it) => (it.id ?? it.key) === key);
  if (like) {
    const names = Object.keys(like);
    let best = -1, bestSame = 0, bestD = Infinity;
    instances.forEach((it, k) => {
      const same = names.filter((n) => it[n] === like[n]).length;
      const d = Math.hypot((it.x ?? 0) - (like.x ?? 0), (it.y ?? 0) - (like.y ?? 0), (it.z ?? 0) - (like.z ?? 0));
      if (same > bestSame || (same === bestSame && d < bestD)) { best = k; bestSame = same; bestD = d; }
    });
    if (best >= 0 && bestSame >= Math.max(2, Math.ceil(names.length * 0.4))) return best;
  }
  return copy < instances.length ? copy : -1;
}
