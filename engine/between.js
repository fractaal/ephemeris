// A frame's sub-frames between the moments the film's code ran. Of what a sub-frame is for (motion blur, depth of field,
// antialiasing, averaging its rays), only motion blur asks for another moment, and over one shutter things move in nearly
// straight lines: so the code runs at the shutter's first and last sub-frames and the frame's own moment, and the others
// are blended from those three, however many there are. (Cycles' motion blur blends between its motion steps the same way.)
// A frame whose three moments differ in kind (a thing appears, a list changes length, the camera jumps, a copy spins far, a
// pass's own data changes) is not blended: each of its sub-frames runs the code, as a frame of few sub-frames does.
import { instanceData, INSTANCE_FLOATS } from './mesh.js';

const plain = (x) => { if (!x || typeof x !== 'object') return false; const p = Object.getPrototypeOf(x); return p === Object.prototype || p === null; };
// x and y's values u of the way between: numbers, and numbers in what is plainly data; anything else, the nearer's
function mixed(x, y, u) {
  if (x === y) return x;
  if (typeof x === 'number' && typeof y === 'number') return x + (y - x) * u;
  if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) return x.map((v, i) => mixed(v, y[i], u));
  if (ArrayBuffer.isView(x) && ArrayBuffer.isView(y) && x.constructor === y.constructor && x.length === y.length) {
    const o = new x.constructor(x.length);
    for (let i = 0; i < x.length; i++) o[i] = x[i] + (y[i] - x[i]) * u;
    return o;
  }
  if (plain(x) && plain(y)) {
    const o = { ...x };
    for (const k in x) if (k in y) o[k] = mixed(x[k], y[k], u);
    return o;
  }
  return u < 0.5 ? x : y;
}
// (a mesh node's copies are blended by their rows, not as objects: many copies, many sub-frames)
const COPIES = new Set(['instances', 'options']);
function mixedNode(x, y, u) {
  const o = { ...x };
  for (const k in x) if (!COPIES.has(k) && k in y) o[k] = mixed(x[k], y[k], u);
  return o;
}
// whether two values are the same numbers, however they are held
const equal = (x, y) => {
  if (x === y) return true;
  if ((!ArrayBuffer.isView(x) && !Array.isArray(x)) || (!ArrayBuffer.isView(y) && !Array.isArray(y)) || x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (!equal(x[i], y[i])) return false;
  return true;
};
// A pass's data is the film's own, in a layout only its shader knows (doctor-who's lightning: how many bolts and sparks,
// then each in the next free place, so a place holds one spark at one moment and another, or none, at the next): numbers
// that cannot be blended. Where it changes over the shutter, the frame's sub-frames are real.
const same = (x, y) => {
  if (!x || !y) return !x && !y;
  return x.mesh === y.mesh && x.layer === y.layer && x.light === y.light && x.pass === y.pass && x.fx === y.fx && x.instances?.length === y.instances?.length && equal(x.data, y.data);
};
const far = (x, y) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
// where a camera is, each kind's own way of saying so
const spot = (c) => [c?.x ?? 0, c?.y ?? 0, c?.z ?? 0];
// whether a copy's rows at o turn far from a to b: a blend of rotations far apart squashes it (doctor-who's shards, plates
// spinning edge-on, became rows of thin lines); by two of its columns, as one is still when it turns about that
const COS_FAR = Math.cos((15 * Math.PI) / 180);
const turned = (a, b, o) => {
  for (let c = 0; c <= 8; c += 8) {
    const x0 = a[o + c], x1 = a[o + c + 1], x2 = a[o + c + 2], y0 = b[o + c], y1 = b[o + c + 1], y2 = b[o + c + 2];
    const l = Math.sqrt((x0 * x0 + x1 * x1 + x2 * x2) * (y0 * y0 + y1 * y1 + y2 * y2));
    if (l > 0 && x0 * y0 + x1 * y1 + x2 * y2 < COS_FAR * l) return true;
  }
  return false;
};
// one stretch being far longer than the other, and long: a jump, not a move
const jumped = (a, b) => { const s = Math.min(a, b), l = Math.max(a, b); return l > 4 * s + 8; };

/**
 * The film's scenes a, m, b at moments ta ≤ tm ≤ tb → (ts) => the scene at ts between them, or null where they cannot be
 * blended. A copy that jumps (spring-brutalist's petals, wrapping round the box the wind carries them through) keeps to the
 * nearer moment through the stretch it jumps in, rather than streaking across the scene.
 */
export function between(a, m, b, ta, tm, tb) {
  if (a.nodes.length !== m.nodes.length || b.nodes.length !== m.nodes.length) return null;
  for (let i = 0; i < m.nodes.length; i++) if (!same(a.nodes[i], m.nodes[i]) || !same(b.nodes[i], m.nodes[i])) return null;
  if (jumped(far(spot(a.camera), spot(m.camera)), far(spot(m.camera), spot(b.camera)))) return null;
  // each mesh node's rows at the three moments (one where its list is the same list), and which copies jump in which stretch
  let spins = false;
  const rows = m.nodes.map((n, i) => {
    if (spins || !n?.mesh || !n.instances?.length) return null;
    const count = n.instances.length, size = count * INSTANCE_FLOATS, row = (list) => { const r = new Float32Array(size); instanceData(list, r, 0); return r; };
    const lists = [a.nodes[i].instances, n.instances, b.nodes[i].instances];
    if (lists[0] === lists[1] && lists[1] === lists[2]) { const r = row(n.instances); return { A: r, M: r, B: r, jumps: null }; }
    const A = row(lists[0]), M = row(lists[1]), B = row(lists[2]);
    let jumps = null;
    for (let k = 0, o = 0; k < count; k++, o += INSTANCE_FLOATS) {
      const ax = A[o + 3] - M[o + 3], ay = A[o + 7] - M[o + 7], az = A[o + 11] - M[o + 11], bx = B[o + 3] - M[o + 3], by = B[o + 7] - M[o + 7], bz = B[o + 11] - M[o + 11];
      const da = Math.sqrt(ax * ax + ay * ay + az * az), db = Math.sqrt(bx * bx + by * by + bz * bz);
      if (jumped(da, db)) (jumps ??= new Uint8Array(count))[k] = da > db ? 1 : 2;
      else if (turned(A, M, o) || turned(M, B, o)) spins = true;
    }
    return { A, M, B, jumps };
  });
  if (spins) return null;
  const moments = {};   // (the frame's, whichever sub-frame's: what is found once for them all is kept here: scene.js shutterBoxes)
  return (ts) => {
    const first = ts <= tm, x = first ? a : m, y = first ? m : b, t0 = first ? ta : tm, t1 = first ? tm : tb, u = t1 > t0 ? Math.min(1, Math.max(0, (ts - t0) / (t1 - t0))) : 1;
    const s = {};
    for (const k in m) if (k !== 'nodes') s[k] = k in x && k in y ? mixed(x[k], y[k], u) : m[k];
    s.t = ts; s.moments = moments;
    s.nodes = m.nodes.map((n, i) => {
      if (!n) return n;
      const node = mixedNode(x.nodes[i], y.nodes[i], u);
      const r = rows[i];
      if (r) node.rows = { from: first ? r.A : r.M, to: first ? r.M : r.B, u, jumps: r.jumps, stretch: first ? 1 : 2, all: r };
      return node;
    });
    return s;
  };
}

/** A mesh node's copies' rows at that moment (between's), into a frame's instance data at offset. */
export function rowsInto({ from, to, u, jumps, stretch }, out, offset) {
  if (from === to) { out.set(from, offset); return; }
  const n = from.length;
  for (let k = 0, o = 0; o < n; k++, o += INSTANCE_FLOATS) {
    const q = offset + o;
    for (let j = 0; j < 12; j++) out[q + j] = from[o + j] + (to[o + j] - from[o + j]) * u;
    out[q + 24] = from[o + 24] + (to[o + 24] - from[o + 24]) * u; out[q + 25] = from[o + 25] + (to[o + 25] - from[o + 25]) * u; out[q + 26] = from[o + 26] + (to[o + 26] - from[o + 26]) * u; out[q + 27] = 1;
    // its inverse's rows from these columns (their cross products over the determinant), not blended: a blend of two
    // rotations is not quite one, and a ray taken into the copy's space by anything but its exact inverse lands off its
    // surface (the TARDIS, 300 px across, by 0.09 px, past where a shadow ray starts: it shadowed itself, a fifth darker)
    const a0 = out[q], a1 = out[q + 1], a2 = out[q + 2], b0 = out[q + 4], b1 = out[q + 5], b2 = out[q + 6], c0 = out[q + 8], c1 = out[q + 9], c2 = out[q + 10];
    const r00 = b1 * c2 - b2 * c1, r01 = b2 * c0 - b0 * c2, r02 = b0 * c1 - b1 * c0;
    const d = 1 / (a0 * r00 + a1 * r01 + a2 * r02);
    out[q + 12] = r00 * d; out[q + 13] = r01 * d; out[q + 14] = r02 * d; out[q + 15] = 0;
    out[q + 16] = (c1 * a2 - c2 * a1) * d; out[q + 17] = (c2 * a0 - c0 * a2) * d; out[q + 18] = (c0 * a1 - c1 * a0) * d; out[q + 19] = 0;
    out[q + 20] = (a1 * b2 - a2 * b1) * d; out[q + 21] = (a2 * b0 - a0 * b2) * d; out[q + 22] = (a0 * b1 - a1 * b0) * d; out[q + 23] = 0;
  }
  if (!jumps) return;
  // (a copy jumping in this stretch: at the nearer moment)
  const near = u < 0.5 ? from : to;
  for (let k = 0; k < jumps.length; k++) {
    if (jumps[k] !== stretch) continue;
    const o = k * INSTANCE_FLOATS;
    for (let j = 0; j < INSTANCE_FLOATS; j++) out[offset + o + j] = near[o + j];
  }
}
