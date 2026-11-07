// Film clock: a stateless keyframe engine. Every frame is a pure function of t, so any frame can be rendered
// independently (parallel workers, motion-blur sub-frames) and the same t always looks the same.
import { bezier, glide, easeOut, easeInOut, powerIn, expoIn, sineIn, backOut } from './ease.js';
import { registerEases } from './motion.js';
import { parts, timeOf, position } from './grid.js';

export { bezier };

/**
 * Musical grid: tempo(116).b(bar, beat, sixteenth) → seconds (bar 0 = film start, four beats a bar). Or tempo(TL.grid):
 * the timeline's grid as the studio shows it (its offset and beats a bar; where the music sets it, each song's tempo map
 * from where its clip starts, bars counted on across: engine/grid.js), and at(t) → { bar, beat } there. BPM, BEAT and BAR are
 * the first part's.
 */
export function tempo(x) {
  if (typeof x === 'object' && x) {
    const p = parts(x)[0];
    return { BPM: p.bpm, BEAT: p.beat, BAR: p.bar, b: (bar, beat = 0, six = 0) => timeOf(x, bar, beat, six), at: (t) => position(x, t) };
  }
  const BEAT = 60 / x, BAR = BEAT * 4;
  return { BPM: x, BEAT, BAR, b: (bar, beat = 0, six = 0) => bar * BAR + beat * BEAT + six * (BEAT / 4) };
}

// ---------- easing ----------
export const E = {
  lin: (x) => x,
  apple: bezier(0.32, 0.72, 0, 1),      // product "settle" curve
  mat: bezier(0.2, 0.8, 0.2, 1),        // product cross-fade curve
  glide,                                // camera move: leaves gently, long settle (no kick at the start)
  out: easeOut(expoIn),
  out3: easeOut(powerIn(4)),
  out2: easeOut(powerIn(3)),
  in2: powerIn(3),
  in3: powerIn(4),
  inx: expoIn,
  io: easeInOut(powerIn(4)),
  io2: easeInOut(powerIn(3)),
  iox: easeInOut(expoIn),
  sine: easeInOut(sineIn),
  back: backOut(1.4),
  step: (x) => (x < 1 ? 0 : 1),
};
registerEases(E);   // (so the editor's changes can name them)
export const clamp = (v, a = 0, z = 1) => Math.min(z, Math.max(a, v));
export const lerp = (a, z, p) => a + (z - a) * p;
export const prog = (t, t0, t1, e = E.lin) => e(clamp((t - t0) / (t1 - t0)));

// ---------- tracks ----------
const tracks = new Map();     // el -> { prop -> keys }
const windows = [];           // [el, t0, t1]
const updaters = [];          // fn(t)

function lerpV(a, z, p) {
  if (typeof a === 'number') return lerp(a, z, p);
  if (Array.isArray(a)) return a.map((v, i) => lerp(v, z[i], p));
  return p < 1 ? a : z;
}
export function sample(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1]; const [t1, v1, e] = keys[i];
      const p = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
      return lerpV(v0, v1, (e || E.lin)(p));
    }
  }
  return keys[keys.length - 1][1];
}

/** anim(el, 'y', [[t, v], [t, v, ease], ...]) — ease applies to the segment ending at that key. */
export function anim(el, prop, keys) {
  if (!el) throw new Error('anim: missing element for ' + prop);
  if (!tracks.has(el)) tracks.set(el, {});
  const tr = tracks.get(el);
  const sorted = keys.slice().sort((a, c) => a[0] - c[0]);
  if (tr[prop]) {
    // merge: append keys (later calls extend the same property)
    tr[prop] = tr[prop].concat(sorted).sort((a, c) => a[0] - c[0]);
  } else tr[prop] = sorted;
  return el;
}
/** animate several props sharing the same times: animAll(el, {o:[[t,v],..], y:[...]}) */
export function animAll(el, map) { for (const k in map) anim(el, k, map[k]); return el; }
/** element only rendered between t0 and t1 */
export function life(el, t0, t1) { windows.push([el, t0, t1]); return el; }
export function every(fn) { updaters.push(fn); }
/** life() boundaries: the renderer keeps motion-blur sub-frames from straddling a hard cut */
export const lifeTimes = (duration) => [...new Set(windows.flatMap(([, t0, t1]) => [t0, t1]))].filter((t) => t > 0 && t < duration).sort((a, c) => a - c);

const TF = ['x', 'y', 'z', 'rx', 'ry', 'rz', 's', 'sx', 'sy', 'px', 'py'];
function apply(el, tr, t) {
  const v = {};
  for (const p in tr) v[p] = sample(tr[p], t);
  const st = el.style;
  if (TF.some((k) => k in v)) {
    const x = v.x ?? 0, y = v.y ?? 0, z = v.z ?? 0;
    const s = v.s ?? 1, sx = (v.sx ?? 1) * s, sy = (v.sy ?? 1) * s;
    const pre = ('px' in v || 'py' in v) ? `translate(${v.px ?? 0}%, ${v.py ?? 0}%) ` : '';
    st.transform = `${pre}translate3d(${x}px, ${y}px, ${z}px) rotateX(${v.rx ?? 0}deg) rotateY(${v.ry ?? 0}deg) rotateZ(${v.rz ?? 0}deg) scale(${sx}, ${sy})`;
  }
  if ('o' in v) st.opacity = clamp(v.o);
  const f = [];
  if ('blur' in v && v.blur > 0.01) f.push(`blur(${v.blur}px)`);
  if ('bright' in v) f.push(`brightness(${v.bright})`);
  if ('sat' in v) f.push(`saturate(${v.sat})`);
  if ('blur' in v || 'bright' in v || 'sat' in v) st.filter = f.join(' ') || 'none';
  if ('w' in v) st.width = v.w + 'px';
  if ('h' in v) st.height = v.h + 'px';
  if ('r' in v) st.borderRadius = v.r + 'px';
  if ('clip' in v) { const [a, c, d, e2, rr = 0] = v.clip; st.clipPath = `inset(${a}% ${c}% ${d}% ${e2}% round ${rr}px)`; }
  for (const p in v) {
    if (p.startsWith('--')) st.setProperty(p, typeof v[p] === 'number' ? String(v[p]) : v[p]);
    else if (p.startsWith('css:')) st.setProperty(p.slice(4), v[p]);
  }
}

export function seek(t) {
  for (const [el, t0, t1] of windows) {
    const on = t >= t0 && t < t1;
    const want = on ? '' : 'none';
    if (el.style.display !== want) el.style.display = want;
  }
  for (const [el, tr] of tracks) {
    if (el.style.display === 'none') continue;
    apply(el, tr, t);
  }
  for (const fn of updaters) fn(t);
  pin(t);
}
/**
 * CSS animations and transitions run on the film clock, never on wall time. Call again after any DOM change made after
 * seek (a film's update(t)): an animation it starts (a spinner that appears with a class) would otherwise run on wall
 * time for that frame, and its phase would depend on which frames that worker rendered before. `root` limits it to
 * one element's subtree.
 */
export function pin(t, root = document) { for (const a of animationsIn(root)) { a.pause(); a.currentTime = t * 1000; } }
/**
 * Holds CSS animations at rest: finite ones finished, loops at their start. What the film measures in ready() and
 * what a layer captured once shows, so neither depends on when it happened (a slow boot measuring a card whose
 * entrance is still settling, say).
 */
export function rest(root = document) {
  for (const a of animationsIn(root)) { const end = a.effect?.getComputedTiming().endTime; a.pause(); a.currentTime = Number.isFinite(end) ? end : 0; }
}
const animationsIn = (root) => (root === document ? document.getAnimations() : root.getAnimations({ subtree: true }));

// ---------- DOM helpers ----------
export function h(tag, cls, html, parent) {
  const [t, id] = tag.split('#');
  const el = document.createElement(t || 'div');
  if (id) el.id = id;
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  if (parent) parent.appendChild(el);
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// common entrances
export function rise(el, t, { dur = 0.6, y = 24, blur = 8, s = null, ease = E.apple, o = 1 } = {}) {
  anim(el, 'o', [[t, 0], [t + dur * 0.6, o, E.mat]]);
  if (y) anim(el, 'y', [[t, y], [t + dur, 0, ease]]);
  if (blur) anim(el, 'blur', [[t, blur], [t + dur * 0.8, 0, E.out2]]);
  if (s != null) anim(el, 's', [[t, s], [t + dur, 1, ease]]);
  return el;
}
export function fall(el, t, { dur = 0.4, y = -16, blur = 8, ease = E.in2, s = null } = {}) {
  anim(el, 'o', [[t, 1], [t + dur, 0, E.lin]]);
  if (y) anim(el, 'y', [[t, 0], [t + dur, y, ease]]);
  if (blur) anim(el, 'blur', [[t, 0], [t + dur, blur, E.in2]]);
  if (s != null) anim(el, 's', [[t, 1], [t + dur, s, ease]]);
  return el;
}
/** deterministic PRNG */
export function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
