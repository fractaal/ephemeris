// A pointer for interaction beats. It is a stand-in for the viewer's hand, so it is a character, not a literal
// cursor — macOS's own pointers (assets/cursors), moving like a paper airplane: it launches smoothly, glides on gentle
// curves and banks into them, lands decisively on its mark, and clicks with a clear nose-down press. It floats above
// the UI on its own plane (its shadow falls on the UI, so every camera move shows it riding above) and takes the shape
// of what it is over (arrow, I-beam over text, hand over controls). Everything is a pure function of film time, and
// its motion is node motion, so it gets motion blur.
import { E, clamp, bezier } from '../engine/time.js';
import ARROW from '../assets/cursors/arrow.svg?raw';
import HAND from '../assets/cursors/hand.svg?raw';
import TEXT from '../assets/cursors/text.svg?raw';

const ART = 256;   // the artboard the pointers are drawn on
const SHAPES = {
  // [svg, hotspot x, y on the artboard, the heading its tip points along (degrees, screen axes)]
  arrow: [ARROW, 80, 38, -112],
  hand: [HAND, 92, 53, -90],
  text: [TEXT, 129, 136, -90],
};
// a launch and a long glide in, landing with a hair of overshoot: decisive, not springy
const GLIDE = bezier(0.42, 0, 0.2, 1.025);
const wrap = (a) => ((a + 540) % 360) - 180;

/**
 * @param film    createFilm() handle
 * @param o.z     world z of the UI plane it works on
 * @param o.lift  how far above that plane it floats (world px); it dips to the plane on a click
 * @param o.size  the artboard's world size (a macOS arrow is about a sixth of it)
 * @param o.res   capture resolution: the largest on-screen scale it is seen at
 */
export function cursor(film, { res = 3, z = 2, lift = 70, size = 46, ring = 'rgba(255,255,255,.85)' } = {}) {
  const layer = (k, shadow) => {
    const el = document.createElement('div');
    el.innerHTML = SHAPES[k][0];
    const svg = el.querySelector('svg');
    Object.assign(svg.style, { display: 'block', width: `${size}px`, height: `${size}px` });
    if (shadow) { for (const p of svg.querySelectorAll('[fill]:not([fill="none"]), [stroke]')) { if (p.getAttribute('fill') !== 'none') p.setAttribute('fill', '#000'); if (p.hasAttribute('stroke')) p.setAttribute('stroke', '#000'); } el.style.filter = 'blur(2px)'; }
    return film.layer(el, { w: size, h: size, pad: shadow ? 12 : 4, res, label: `cursor ${k}${shadow ? ' shadow' : ''}` });
  };
  const L = Object.fromEntries(Object.keys(SHAPES).map((k) => [k, { body: layer(k), shadow: layer(k, true) }]));
  const ringEl = document.createElement('div');
  Object.assign(ringEl.style, { borderRadius: '50%', boxShadow: `inset 0 0 0 2px ${ring}` });
  const ripple = film.layer(ringEl, { w: 48, h: 48, pad: 8, res, label: 'cursor ring' });

  const moves = [];   // { t, dur, to, arc, drag }
  const clicks = [];
  const shapes = [];  // [t, shape]
  let start = null;
  const point = (p, what) => { if (typeof p === 'function') throw new Error(`cursor: ${what} is measured from the DOM, but was added after the film was ready (add moves in ready())`); return p; };
  const shapeAt = (t) => { let s = 'arrow', s0 = 'arrow', t0 = -1e9; for (const [ts, k] of shapes) if (ts <= t) { s0 = s; s = k; t0 = ts; } return { s, s0, t0 }; };

  const api = {
    moves,
    /** Where the pointer rests before its first move: [x, y] world, or a function measuring it (see measure). */
    from(p) { start = p; return api; },
    /**
     * Glide to p over [t, t + dur]; arc bends the path sideways by that fraction of its length. p is [x, y] world, or
     * a function measuring it from the DOM (see measure). `shape` is what it becomes as it arrives (it travels as an
     * arrow); `drag` marks a move made while pressed (a selection), which is meant to be short.
     */
    move(t, p, { dur = 1.5, arc = 0.1, shape, drag = false } = {}) {
      moves.push({ t, dur, to: p, arc, drag }); moves.sort((a, b) => a.t - b.t);
      if (shape) { shapes.push([t + 0.06, 'arrow'], [t + dur * 0.82, shape]); shapes.sort((a, b) => a[0] - b[0]); }
      return api;
    },
    click(t) { clicks.push(t); return api; },
    /** Changes shape at t (arrow, text, hand). */
    shape(t, k) { shapes.push([t, k]); shapes.sort((a, b) => a[0] - b[0]); return api; },
    /**
     * Measures the targets given as functions, each from the DOM as it stands when the pointer arrives there (the
     * resting point: when it leaves), so where it goes never depends on which frame was rendered first. The runtime
     * calls it once the film is ready, with domAt(t) putting the DOM in its state at t.
     */
    measure(domAt) {
      for (const m of moves) if (typeof m.to === 'function') { domAt(m.t + m.dur); m.to = m.to(); }
      if (typeof start === 'function') { domAt(moves[0]?.t ?? 0); start = start(); }
    },
    /** Tip position at time t (on the UI plane). */
    pos(t) {
      let p = point(start ?? moves[0]?.to ?? [0, 0], 'where it starts');
      for (const m of moves) {
        const q = point(m.to, `the move at ${m.t.toFixed(2)}s`);
        if (t <= m.t) break;
        const x = clamp((t - m.t) / m.dur);
        const u = GLIDE(x);
        const dx = q[0] - p[0], dy = q[1] - p[1];
        const c = [p[0] + dx / 2 - dy * m.arc, p[1] + dy / 2 + dx * m.arc];
        // the quadratic arc, evaluated a little past its end for the landing's overshoot
        const a = (1 - u) * (1 - u), b = 2 * u * (1 - u), d = u * u;
        const pt = [a * p[0] + b * c[0] + d * q[0], a * p[1] + b * c[1] + d * q[1]];
        if (x < 1) return pt;
        p = q;
      }
      return p;
    },
    /**
     * Scene nodes at time t: shadow and ripples on the UI plane, the pointer above it. `lift` overrides its height
     * (a pointer arriving from the camera), `scale` its size.
     */
    nodes(t, { scale = 1, opacity = 1, lift: liftAt } = {}) {
      const [x, y] = api.pos(t);
      const dt = 1 / 60, p0 = api.pos(t - dt), p1 = api.pos(t + dt), pm = api.pos(t - 2 * dt), pp = api.pos(t + 2 * dt);
      const v = [(p1[0] - p0[0]) / (2 * dt), (p1[1] - p0[1]) / (2 * dt)], speed = Math.hypot(v[0], v[1]);
      const acc = [(pp[0] - 2 * x + pm[0]) / (4 * dt * dt), (pp[1] - 2 * y + pm[1]) / (4 * dt * dt)];
      const out = [];
      // a click: a small wind-up (lifts, tips back), a clear press (dips, nose down, squashes), a short rebound
      let press = 0, wind = 0, rebound = 0;
      for (const c of clicks) {
        const d = t - c;
        if (d >= -0.2 && d < -0.06) wind = Math.max(wind, Math.sin(Math.PI * (d + 0.2) / 0.14));
        if (d >= -0.06 && d < 0) press = Math.max(press, E.in2((d + 0.06) / 0.06));
        if (d >= 0 && d < 0.16) press = Math.max(press, 1 - E.out2(d / 0.16));
        if (d >= 0.1 && d < 0.4) rebound = Math.max(rebound, Math.sin(Math.PI * (d - 0.1) / 0.3) * (1 - (d - 0.1) / 0.3));
        if (d >= 0 && d < 0.6) {
          const k = E.out3(d / 0.6);
          out.push(ripple.at(x, y, { z: z + 0.5, s: scale * (0.3 + 1.5 * k), opacity: opacity * 0.75 * (1 - k) }));
        }
      }
      // it hovers with the slightest breath, and dips most of the way to the UI to press
      const base = liftAt ?? lift * (1 + 0.04 * Math.sin(t * 1.9));
      const h = base * (1 + 0.15 * wind - 0.85 * press + 0.1 * rebound);
      const { s: k, s0, t0 } = shapeAt(t);
      // like a paper airplane: it banks into its turns (by how fast its heading turns) and points a little along its
      // path; no tumbling with speed
      const turn = speed > 40 ? (v[0] * acc[1] - v[1] * acc[0]) / (speed * speed) : 0;   // rad/s
      const bank = clamp(turn * 14, -12, 12) * clamp(speed / 400);
      const steer = speed > 40 ? clamp(wrap((Math.atan2(v[1], v[0]) * 180) / Math.PI - SHAPES[k][3]) * 0.08, -6, 6) * clamp(speed / 900) : 0;
      const rz = bank + steer - 5 * wind + 10 * press - 2.5 * rebound;
      const ry = 0.8 * bank, rx = clamp(-v[1] * 0.004, -6, 6) + 18 * press - 6 * wind;
      // squash and stretch, held back: a little stretch along its motion at speed, a little squash in the press
      const e = clamp(speed / 2600, 0, 0.32) * 0.6, r = (rz * Math.PI) / 180;
      const lx = speed ? Math.abs((v[0] * Math.cos(r) + v[1] * Math.sin(r)) / speed) : 0, ly = speed ? Math.abs((-v[0] * Math.sin(r) + v[1] * Math.cos(r)) / speed) : 0;
      const sx = (1 + e * lx - 0.5 * e * ly) * (1 + 0.1 * press - 0.05 * rebound), sy = (1 + e * ly - 0.5 * e * lx) * (1 - 0.1 * press + 0.06 * rebound + 0.035 * wind);
      const swap = clamp((t - t0) / 0.14);
      const draw = (key, o) => {
        const [, hx, hy] = SHAPES[key];
        // the hotspot sits at (x, y); the artboard's centre is offset from it, turned with the bank
        const ox = (0.5 - hx / ART) * size * scale * sx, oy = (0.5 - hy / ART) * size * scale * sy;
        const cx = x + ox * Math.cos(r) - oy * Math.sin(r), cy = y + ox * Math.sin(r) + oy * Math.cos(r);
        // a shape change pops: the new shape grows in with a little overshoot
        const pop = o < 1 ? E.back(o) : 1;
        const lightX = 0.35 * h, lightY = 0.55 * h;   // light from the upper left: the shadow falls down and right
        const sh = L[key].shadow.at(cx + lightX, cy + lightY, { z: z + 0.5, s: scale * pop * (1 + h / 500), rz, opacity: o * opacity * 0.4 * clamp(1 - h / 900) });
        const bd = L[key].body.at(cx, cy, { z: z + h, s: scale * pop, rz, rx, ry, opacity: o * opacity });
        for (const n of [sh, bd]) { n.w *= sx; n.h *= sy; }
        out.push(sh, bd);
      };
      // while one shape gives way to the next both draw, always in the same order (so neither pops over the other)
      for (const key of Object.keys(SHAPES)) {
        if (key === k) draw(k, swap < 1 && s0 !== k ? swap : 1);
        else if (key === s0 && swap < 1) draw(s0, 1 - swap);
      }
      return out;
    },
  };
  film.cursors?.push(api);   // for the tools (check.mjs reports its pacing)
  return api;
}
