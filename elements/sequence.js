// A film's scenes, run as one: each scene has its start, its camera rig, its environment and what it draws.
// Scenes hand over with swishes (an operator's whip pan across the cut: see swishShape() in engine/camera.js; the
// shutter opens with the whip's speed, to `shutter` at the cut, so the blur grows and fades with the motion, and the two
// scenes' environments cross over so the light moves with the whip). Headlines belong to their scene: they leave with
// it, carried by its swish.
//
//   const S = sequence({ scenes: [{ t0, cam: 'A', environment: (t) => …, draw(t, push, camera) { push(nodes…) }, post: (t) => … }],
//                        swishes: { [t]: { px: [0, 1600], dur: 0.5 } }, cams: CAM, headlines: H.list });
//   F.run({ …, cuts: S.cuts, scene: S.at });
// A scene's draw may return a camera to use instead of its rig's (a montage computing its own, a shake), and pushes its
// lights (F.light) as it does its meshes. A scene's `environment` (the sky around, and the backdrop the camera sees: see
// the engine skill's 3D section) and its `view`, `ao`, `gi`, `reflections` and `shadows` are objects or functions of t.
import { E, clamp, lerp } from '../engine/time.js';
import { cam, swishShape } from '../engine/camera.js';

// a CSS colour as sRGB [r, g, b] 0–1 (what is mixed)
const srgbOf = (c) => (Array.isArray(c) ? c : (c.replace('#', '').length === 3 ? [...c.replace('#', '')].map((d) => d + d) : c.replace('#', '').match(/../g)).map((d) => parseInt(d, 16) / 255));
const mixColour = (a, c, w) => (a == null || c == null ? (w < 0.5 ? a : c) : srgbOf(a).map((v, k) => lerp(v, srgbOf(c)[k], w)));
/** A backdrop: its colour, and soft glows on it ([{ x, y, r, color }], frame px). */
export const BACKDROP = (color, glows = []) => ({ color, glows });
/** An environment between a and c (w 0 → 1): its colours blend, its backdrop's glows fade across. */
export function mixEnvironment(a = {}, c = {}, w) {
  const out = {};
  for (const k of ['zenith', 'horizon', 'nadir']) if (a[k] != null || c[k] != null) out[k] = mixColour(a[k], c[k], w);
  if (a.intensity != null || c.intensity != null) out.intensity = lerp(a.intensity ?? 1, c.intensity ?? 1, w);
  const ba = typeof a.backdrop === 'object' && !Array.isArray(a.backdrop) ? a.backdrop : { color: a.backdrop };
  const bc = typeof c.backdrop === 'object' && !Array.isArray(c.backdrop) ? c.backdrop : { color: c.backdrop };
  const fade = (g, k) => ({ ...g, color: srgbOf(g.color ?? '#ffffff').map((v) => v * k) });
  if (ba.color != null || bc.color != null) {
    out.backdrop = { color: mixColour(ba.color, bc.color, w), glows: [...(ba.glows ?? []).map((g) => fade(g, 1 - w)), ...(bc.glows ?? []).map((g) => fade(g, w))].slice(0, 6) };
  }
  return out;
}

/** shutter: how far a swish opens it at its fastest, in frames (0.5 is a film camera's 180°). */
export function sequence({ scenes, swishes = {}, shutter = 0.5, cams = {}, headlines = [], post = { vignette: 0.28 } }) {
  const shapes = Object.fromEntries(Object.entries(swishes).map(([tc, o]) => [tc, swishShape(o)]));
  const index = (t) => { let i = 0; while (i < scenes.length - 1 && t >= scenes[i + 1].t0) i++; return i; };
  const own = (S, k, t) => (typeof S[k] === 'function' ? S[k](t) : S[k]);
  const environment = (t, i) => {
    const near = (tc, k0, k1) => { const S = shapes[tc]; if (!S) return null; const w = E.sine(clamp((t - (tc - S.dur)) / (S.dur + S.durIn))); return w > 0 && w < 1 ? mixEnvironment(own(scenes[k0], 'environment', t), own(scenes[k1], 'environment', t), w) : null; };
    return (i > 0 && near(scenes[i].t0, i - 1, i)) || (i < scenes.length - 1 && near(scenes[i + 1].t0, i, i + 1)) || own(scenes[i], 'environment', t);
  };
  const end = (t) => scenes[index(t) + 1]?.t0 ?? Infinity;
  /** The camera's on-screen travel from its scene's swishes at t (px), for graphics that ride along. */
  const whip = (t, i) => {
    const S = scenes[i], next = scenes[i + 1], o = shapes[next?.t0], o0 = shapes[S.t0];
    if (o && t >= next.t0 - o.dur) { const k = o.out(clamp((t - (next.t0 - o.dur)) / o.dur)); return [o.px[0] * k, o.px[1] * k]; }
    if (o0 && t < S.t0 + o0.durIn) { const k = o0.in(clamp((t - S.t0) / o0.durIn)); return [o0.pxIn[0] * k, o0.pxIn[1] * k]; }
    return [0, 0];
  };
  return {
    index,
    /** Every scene change is a cut (swished or hard): pass these (plus any cuts inside a scene) to F.run's `cuts`. */
    cuts: scenes.slice(1).map((S) => S.t0),
    at(t) {
      const nodes = [];
      const push = (...ns) => { for (const n of ns) if (n) nodes.push(n); };
      const i = index(t), S = scenes[i];
      let camera = S.cam ? cams[S.cam].at(t) : cam();
      const drawn = S.draw(t, push, camera);
      if (drawn) camera = drawn;
      const off = whip(t, i);
      for (const hd of headlines) {
        if (t < hd.t - 0.2 || t > hd.out + 0.9 || t >= end(hd.t)) continue;
        if (hd.scrim) push(hd.scrim(t));
        const n = hd.node(); n.x -= off[0]; n.y -= off[1]; push(n);
      }
      const open = Math.max(0, ...[S.t0, scenes[i + 1]?.t0].map((tc) => shapes[tc]?.speed(t, tc) ?? 0));
      return { camera, environment: environment(t, i), nodes, post: { ...post, ...(S.post?.(t) ?? {}) }, shutter: open > 0 ? shutter * open : undefined,
        view: own(S, 'view', t), ao: own(S, 'ao', t), gi: own(S, 'gi', t), reflections: own(S, 'reflections', t), shadows: own(S, 'shadows', t) };
    },
  };
}
