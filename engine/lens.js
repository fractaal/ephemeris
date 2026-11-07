// The lens: how a camera sees the world — its basis and projection. Plain math with no imports, so the editor shares it
// (the director's view draws the film's camera with it).
//
// A camera is one of three kinds (its `kind`), all with a zoom, a roll and a lens (focal):
//   orbit   (the default; two points) x, y, z is the point it looks at; the eye sits focal / zoom from it, swung round
//           it by yaw and pitch. Zoom moves the eye nearer (the plane through the target keeps its scale whatever the
//           lens); turning swings the eye round the target.
//   free    (one point) x, y, z is the eye, turned where it stands by yaw and pitch: a head turning, a camera panned
//           on its tripod. Zoom is the lens's (focal × zoom).
//   target  (two points) x, y, z is the eye and tx, ty, tz the point it always faces, wherever either moves. Zoom is the
//           lens's.
// Yaw turns about the world's vertical, pitch about the camera's horizontal, roll about its view axis, in degrees. At
// zoom 1, a free or target camera at z = FOCAL facing −z (the defaults: cam()) frames the plane z = 0 1:1, as an orbit
// camera at its defaults does.
export const FOCAL = 2200;
/**
 * The film's frame, W × H px: 1920 × 1080 unless its timeline says otherwise ("size": [w, h], read by timeline() before
 * the film is drawn). Live bindings: what imports them sees the film's.
 */
export let W = 1920, H = 1080;
/** Sets the film's frame ([w, h]: whole, even px, an encoder's chroma halves both). */
export function setFrame(size) {
  const [w, h] = size ?? [1920, 1080];
  if (![w, h].every((v) => Number.isInteger(v) && v >= 64 && v <= 8192 && v % 2 === 0)) throw new Error(`a film's size is [width, height] in px, each even and 64 to 8192 (not ${JSON.stringify(size)})`);
  W = w; H = h;
}
/** Each kind's channels: what a rig of that kind animates (the editor's lanes). */
export const CHANNELS = {
  orbit: ['x', 'y', 'z', 'zoom', 'yaw', 'pitch', 'roll'],
  free: ['x', 'y', 'z', 'zoom', 'yaw', 'pitch', 'roll'],
  target: ['x', 'y', 'z', 'tx', 'ty', 'tz', 'zoom', 'roll'],
};

const rad = (d) => (d * Math.PI) / 180;
const rot = (v, axis, a) => {
  const c = Math.cos(a), s = Math.sin(a), [x, y, z] = v;
  if (axis === 'x') return [x, y * c - z * s, y * s + z * c];
  if (axis === 'y') return [x * c + z * s, y, -x * s + z * c];
  return [x * c - y * s, x * s + y * c, z];
};
const deg = (r) => (r * 180) / Math.PI;
/** A target camera's yaw and pitch: those that face its eye toward (tx, ty, tz). */
function aimOf(c) {
  const d = [c.x - (c.tx ?? 0), c.y - (c.ty ?? 0), (c.z || 0) - (c.tz ?? 0)], l = Math.hypot(...d) || 1;
  return { yaw: deg(Math.atan2(d[0], d[2])), pitch: deg(Math.asin(-d[1] / l)), dist: Math.hypot(...d) };
}
/**
 * Camera basis in world space: right, down, back (toward the viewer), the eye, and the lens (focal, px: smaller is
 * wider); `center`, the point at the frame's centre focal / zoom from the eye, where the world shows at the camera's zoom
 * (an orbit camera's target: its frame there is W / zoom wide); and `dist`, how far the eye is from what it looks at
 * (an orbit camera's target, a target camera's; a free camera's centre), where depth of field focuses unless told.
 */
export function basis(c, focal = c.focal ?? FOCAL) {
  const kind = c.kind ?? 'orbit', aim = kind === 'target' ? aimOf(c) : null;
  if (!CHANNELS[kind]) throw new Error(`a camera's kind is 'orbit', 'free' or 'target' (not '${kind}')`);
  const yaw = aim ? aim.yaw : c.yaw || 0, pitch = aim ? aim.pitch : c.pitch || 0;
  // roll about the view axis, then pitch about the horizontal, then yaw about the world vertical
  const R = (v) => rot(rot(rot(v, 'z', rad(c.roll || 0)), 'x', rad(pitch)), 'y', rad(yaw));
  const right = R([1, 0, 0]), down = R([0, 1, 0]), back = R([0, 0, 1]);
  if (kind === 'orbit') {
    const d = focal / c.zoom;
    const eye = [c.x + back[0] * d, c.y + back[1] * d, (c.z || 0) + back[2] * d];
    return { right, down, back, eye, focal, center: [c.x, c.y, c.z || 0], dist: d };
  }
  // (free and target: the eye where it is, the lens zoomed)
  const zoom = c.zoom ?? 1, f = focal * zoom, d = f / zoom;
  const eye = [c.x ?? 0, c.y ?? 0, c.z ?? 0], center = eye.map((e, k) => e - back[k] * d);
  return { right, down, back, eye, focal: f, center, dist: aim ? aim.dist : d };
}
/**
 * Any camera as the orbit camera that sees exactly what it sees (its centre the target, its lens the focal it has):
 * what the editor draws and turns a camera with, whatever its kind.
 */
export function asOrbit(c) {
  const B = basis(c), aim = c.kind === 'target' ? aimOf(c) : null;
  return { x: B.center[0], y: B.center[1], z: B.center[2], zoom: c.zoom ?? 1, yaw: aim ? aim.yaw : c.yaw ?? 0, pitch: aim ? aim.pitch : c.pitch ?? 0,
    roll: c.roll ?? 0, focal: B.focal };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Screen position (px, frame origin top-left) and depth of a world point (c: the frame's centre, the film's unless given). */
export function project(p, B, c = [W / 2, H / 2]) {
  const d = [p[0] - B.eye[0], p[1] - B.eye[1], p[2] - B.eye[2]];
  const depth = -dot(d, B.back);
  const k = B.focal / depth;
  return { x: c[0] + dot(d, B.right) * k, y: c[1] + dot(d, B.down) * k, depth, scale: k };
}
/** The convex hull of points [x, y] (monotone chain), counterclockwise: a thing's outline from its corners. */
export function hull(p) {
  p = [...p].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => { const h = []; for (const x of list) { while (h.length >= 2 && turn(h[h.length - 2], h[h.length - 1], x) <= 0) h.pop(); h.push(x); } h.pop(); return h; };
  return [...half(p), ...half([...p].reverse())];
}
