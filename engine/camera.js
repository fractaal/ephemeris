// Camera. World axes match CSS: x right, y down, z toward the viewer, units in px. Content is placed once in world
// space and stays put; the camera moves. Each scene drives it with its own rig (rig()), and scenes hand over with a
// swish (swish()).
//
// A camera is one of three kinds (lens.js says each exactly):
//   orbit   (the default) looks at x, y, z from FOCAL / zoom away, swung round it by yaw and pitch: a product turning
//           under the lens, a move that keeps a subject framed
//   free    stands at x, y, z and turns where it stands by yaw and pitch: a head turning, a pan on a tripod, a walk;
//           zoom is its lens
//   target  stands at x, y, z and always faces tx, ty, tz: a camera that follows something, or circles it while the
//           eye moves; zoom is its lens
// Roll (about the view axis) and the lens (focal) are any kind's. At zoom 1 with no rotation, each kind's defaults
// (cam()) render the plane z = 0 1:1, so DOM layouts map straight to the screen.
import { E } from './time.js';
import { Stack, STACKS, swishOut, swishIn } from './motion.js';
import { here } from './site.js';

export { FOCAL, W, H, CHANNELS, basis, project, asOrbit, setFrame } from './lens.js';
import { basis, project, W, H, FOCAL, CHANNELS } from './lens.js';

/** @typedef {{ kind?: 'orbit' | 'free' | 'target', x: number, y: number, z: number, tx?: number, ty?: number, tz?: number, zoom: number, yaw?: number, pitch?: number, roll: number }} Cam */
const REST = {
  orbit: { x: 0, y: 0, z: 0, zoom: 1, yaw: 0, pitch: 0, roll: 0 },
  free: { kind: 'free', x: 0, y: 0, z: FOCAL, zoom: 1, yaw: 0, pitch: 0, roll: 0 },
  target: { kind: 'target', x: 0, y: 0, z: FOCAL, tx: 0, ty: 0, tz: 0, zoom: 1, roll: 0 },
};
/** A camera: its kind's defaults (lens.js), then what you give (cam({ kind: 'free', z: 1400, yaw: -20 })). */
export const cam = (c = {}) => {
  if (!REST[c.kind ?? 'orbit']) throw new Error(`a camera's kind is 'orbit', 'free' or 'target' (not '${c.kind}')`);
  return { ...REST[c.kind ?? 'orbit'], ...c };
};

/**
 * Camera with no rotation that shows world rect `r` (x, y, w, h) at screen point `at` (its centre) with on-screen
 * width `width`. The usual way to frame a component: "put this card's centre at (1300, 540), 900 px wide".
 */
export function frame(r, { at = [W / 2, H / 2], width = W * 0.8, ...rest } = {}) {
  const zoom = width / r.w;
  return cam({ x: r.x + r.w / 2 - (at[0] - W / 2) / zoom, y: r.y + r.h / 2 - (at[1] - H / 2) / zoom, zoom, ...rest });
}

// ---------------------------------------------------------------- rigs
// a pose's or a move's channels as the rig keeps them (zoom as its logarithm), only those its kind has that it names
const chans = (c, CH) => { const o = {}; for (const k of CH) if (c[k] !== undefined) o[k] = k === 'zoom' ? Math.log(c[k]) : c[k]; return o; };

/**
 * A scene's camera, of the kind its start pose names (an orbit camera unless it says kind: 'free' or 'target'). A base
 * pose can move linearly the whole time (`drift`, per second; zoom as a log rate, so 0.03 is a ~3 %/s push), and
 * expressive moves are layered on top as eased offsets. Scenes get their own rig and hand over with a swish (see
 * swish()).
 *
 *   const r = rig(T0, frame(card, { width: 900 }), { drift: { x: 14, zoom: 0.02 }, float: 3 })
 *     .to(T0 + 1.2, 1.1, frame(row, { width: 1200 }))   // arrive on that framing at t + dur; the drift carries on
 *     .by(T0 + 3, 0.8, { yaw: -4 });                     // a relative move
 *   scene: (t) => ({ camera: r.at(t), ... })
 *
 * `float` adds a slow handheld wander of that many screen px. A rig is a motion stack (motion.js) with a channel each
 * for what its kind has (x, y, z, zoom, yaw, pitch and roll; a target camera's tx, ty, tz in place of yaw and pitch):
 * its start the base, its drift a rate, each call a move, its float a wander on top; the editor shows each channel's
 * lanes, and its changes to them apply here. `name` is what those changes are kept by: give rigs made in a loop (a
 * camera for each shot) a name each, from what they show, so that they stay on their shot when shots are added or
 * reordered (unnamed, they are numbered in the order the line makes them).
 *
 *   const eye = rig(T0, cam({ kind: 'free', x: 0, y: -170, z: 2400 }), { float: 2 })
 *     .to(T0 + 1, 3, { z: 900 })                          // walk forward
 *     .by(T0 + 4.5, 0.6, { yaw: -35 });                   // and look left, turning where it stands
 */
export function rig(t0, start, { drift = {}, float = 0, name = null } = {}) {
  const site = here(), pose = cam(start), kind = pose.kind ?? 'orbit', CH = CHANNELS[kind];
  // (what every pose of it says beside its channels: its kind, and its lens when the start pose gives one)
  const fixed = { ...(kind === 'orbit' ? {} : { kind }), ...(pose.focal != null ? { focal: pose.focal } : {}) };
  const s = new Stack(chans(pose, CH), { channels: CH, log: ['zoom'], t0, stack: site, fixed: Object.keys(fixed).length ? fixed : null, name });
  const rates = Object.fromEntries(CH.filter((k) => drift[k]).map((k) => [k, drift[k]]));
  if (Object.keys(rates).length) s._op('rate', { rate: rates, from: t0, top: false }, site);
  // (a target camera's wander moves what it faces with it: the camera shakes, it does not turn)
  const amp = kind === 'target' ? { x: float, y: float, tx: float, ty: float } : { x: float, y: float };
  const wave = kind === 'target' ? { x: 'float-x', y: 'float-y', tx: 'float-x', ty: 'float-y' } : { x: 'float-x', y: 'float-y' };
  if (float) s._op('wander', { amp, speed: 1, seed: 0, wave, top: true }, site);
  const from = Object.fromEntries(CH.map((ch) => [ch, { stack: s, ch }]));
  const r = {
    t0,
    stack: s,
    /** The camera at t (it remembers the rig it came from, for the editor's lanes). */
    at(t) { const c = s.at(t); c[STACKS] = from; return c; },
    /** Layers a move that arrives on `pose` (any subset of its kind's channels) at t + dur. */
    to(t, dur, pose, ease = E.glide) { s.to(t, dur, chans(pose, CH), ease); return r; },
    /** Layers a relative move: world px for x/y/z (and tx/ty/tz), degrees for angles, a factor for zoom. */
    by(t, dur, delta, ease = E.glide) { s.by(t, dur, chans(delta, CH), ease); return r; },
    /** Whips out of the scene into a cut at tc (see swishShape()): gathers speed over `dur`, travelling `px` screen px. */
    swishOut(tc, o = {}) { const S = swishShape(o); s._swish(tc - S.dur, S.dur, S.out, tc, S.px, S.roll, here()); return r; },
    /** Whips into the scene from a cut at tc, arriving at the speed a matching swishOut left with, and settling over `durIn`. */
    swishIn(tc, o = {}) { const S = swishShape(o); s._swish(tc, S.durIn, S.in, tc + S.durIn, S.pxIn, S.rollIn, here()); return r; },
  };
  return r;
}

/**
 * A swish's shape, either side of its cut, like an operator's whip pan: the camera leaves its scene gently and gathers
 * speed (a quartic ease over `dur`), passes the cut at its fastest, and settles into the next scene over `durIn`
 * (longer: a whip lands softer than it leaves). The sides meet at the same on-screen speed, so the in side travels `px`
 * scaled by durIn / dur. `speed(t, tc)` is the whip's speed relative to its peak (1 at the cut), which sequence() opens
 * the shutter by, so the blur grows and fades with the motion.
 *   o = { px: [x, y] screen px the out side travels, roll (degrees), dur, durIn }
 */
export function swishShape({ px = [-2400, 0], roll = 0, dur = 0.5, durIn = dur * 1.4 } = {}) {
  const N = 4, k = durIn / dur;
  return {
    px, roll, dur, durIn, pxIn: [px[0] * k, px[1] * k], rollIn: roll * k,
    out: swishOut,                          // p ** N: 0 → 1
    in: swishIn,                            // -((1 - p) ** N): -1 → 0
    speed(t, tc) {
      if (t <= tc - dur || t >= tc + durIn) return 0;
      return t < tc ? ((t - (tc - dur)) / dur) ** (N - 1) : (1 - (t - tc) / durIn) ** (N - 1);
    },
  };
}

/** A swish cut at tc from rig a to rig b: one continuous whip across the cut (put tc in the film's cuts). */
export function swish(a, b, tc, o = {}) { a.swishOut(tc, o); b.swishIn(tc, o); }

/**
 * Largest on-screen displacement (px) of the plane through camera a's centre (lens.js), facing it, between cameras a
 * and b: what of the world a sees at its centre's distance, and where b shows it.
 */
export function screenShift(a, b) {
  const A = basis(a), B = basis(b), s = Math.hypot(...A.center.map((v, i) => v - A.eye[i])) / A.focal;
  let m = 0;
  for (const sx of [0, W / 2, W]) for (const sy of [0, H / 2, H]) {
    const dir = [0, 1, 2].map((i) => A.right[i] * (sx - W / 2) + A.down[i] * (sy - H / 2) - A.back[i] * A.focal);
    const q = project([A.eye[0] + dir[0] * s, A.eye[1] + dir[1] * s, A.eye[2] + dir[2] * s], B);
    m = Math.max(m, Math.hypot(q.x - sx, q.y - sy));
  }
  return m;
}
