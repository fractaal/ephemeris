// Moving, turning and scaling the selection in the viewer, as Blender does: G moves it, R turns it, S scales it (with
// the pointer over the viewer), or drag the gizmo — an arrow per axis, a ring per axis, its centre, its square. X, Y or Z
// keeps to an axis (the world's; pressed again, the thing's own; again, none); a number typed is the amount; Ctrl snaps
// (10 px, 15°, 0.1); Shift is fine; a click or Enter sets it, Esc or a right click puts it back. What it sets is your
// keys at the playhead (the lanes', as the inspector's fields write them), as one undo step. While it goes, the outline
// follows the pointer at once (the thing's corners moved in the world, and seen through the camera), what it does is
// drawn over it (the axis, the turn so far, the scale's reach), and the viewer draws the picture with the change (doc()).
import { basis, project, hull } from './lens.js';

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const COLOR = { x: '#ff6262', y: '#7fd96f', z: '#5e90ff' };
const NAME = { move: 'Move', rotate: 'Rotate', scale: 'Scale' };
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
const fx = (v, d = 1) => String(+(+v).toFixed(d)).replace(/^-/, '−');
const pts = (list) => list.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

// ---------- turns as matrices, as the engine turns things: R = Rz · Ry · Rx (rx applied first: mesh.js)
function euler(rx, ry, rz) {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rad(rx)), Math.sin(rad(rx)), Math.cos(rad(ry)), Math.sin(rad(ry)), Math.cos(rad(rz)), Math.sin(rad(rz))];
  return [[cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx], [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx], [-sy, cy * sx, cy * cx]];
}
const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const apply = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const transpose = (M) => [0, 1, 2].map((i) => [M[0][i], M[1][i], M[2][i]]);
// a turn of `a` radians about the unit axis u (the engine's sense: about z, x turns toward y)
function about([x, y, z], a) {
  const c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}
// a turn's angles again (degrees: rx, ry, rz): of the two that make it (each every 360°), the nearest `near`, so a turn
// keeps going from the values it had rather than jumping to another way of writing it
const nearest = (A, B, near) => {
  const fit = (X) => X.map((v, i) => v + 360 * Math.round((near[i] - v) / 360)), far = (X) => X.reduce((s, v, i) => s + Math.abs(v - near[i]), 0);
  const p = fit(A), q = fit(B);
  return far(p) <= far(q) ? p : q;
};
function angles(R, near) {
  const ry = Math.asin(Math.max(-1, Math.min(1, -R[2][0])));
  const a = Math.abs(Math.cos(ry)) > 1e-6 ? [Math.atan2(R[2][1], R[2][2]), ry, Math.atan2(R[1][0], R[0][0])] : [Math.atan2(-R[1][2], R[1][1]), ry, 0];
  const A = a.map(deg);
  return nearest(A, [A[0] + 180, 180 - A[1], A[2] + 180], near);
}
// the film camera's turn, as lens.js turns it: its roll about the view axis, then its pitch about the horizontal, then its
// yaw about the vertical (R = Ry · Rx · Rz), with rx its pitch, ry its yaw and rz its roll
function camEuler(rx, ry, rz) {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rad(rx)), Math.sin(rad(rx)), Math.cos(rad(ry)), Math.sin(rad(ry)), Math.cos(rad(rz)), Math.sin(rad(rz))];
  return [[cy * cz + sy * sx * sz, sy * sx * cz - cy * sz, sy * cx], [cx * sz, cx * cz, -sx], [cy * sx * sz - sy * cz, sy * sz + cy * sx * cz, cy * cx]];
}
function camAngles(R, near) {
  const rx = Math.asin(Math.max(-1, Math.min(1, -R[1][2])));
  const a = Math.abs(Math.cos(rx)) > 1e-6 ? [rx, Math.atan2(R[0][2], R[2][2]), Math.atan2(R[1][0], R[1][1])] : [rx, Math.atan2(-R[2][0], R[0][0]), 0];
  const A = a.map(deg);
  return nearest(A, [180 - A[0], A[1] + 180, A[2] + 180], near);
}

/**
 * api: { sel() (the selection now: kind (the film camera's: 'camera', its rx, ry, rz its pitch, yaw and roll, its s its
 * zoom), where, outline, box), cam() (the camera the viewer shows, or null), k() (frame
 * px per screen px), mouse() (the pointer in frame px), shown(k) (a property's value now, from the lanes), edits(values)
 * (the lanes' edit for them: { desc, fn }), commit(values, outline), hud(text), paint(), toast(text), doc() }
 */
export function createGizmo(api) {
  let G = null;
  // ---------- a gesture
  // (bare: begun away from the moment its outline is of — a point on its path — so none is drawn as it goes)
  function start(mode, { axis = null, drag = false, bare = false } = {}) {
    const r = api.sel(), cam = api.cam();
    if (!r?.where) return api.toast('Select something in the viewer first');
    if (r.kind === 'light' && mode === 'scale') return api.toast('A light has no scale: its radius is in the inspector.');
    if (r.kind === 'light' && mode === 'rotate' && r.where?.type === 'point') return api.toast('A point light shines every way, so it has nothing to turn.');
    if (r.kind === 'pass' && r.where?.x == null) return api.toast('A pass covers the frame: change its params in the inspector');
    if (!cam && r.kind !== 'title') return api.toast('A moment: the camera is still loading');
    if (r.kind !== 'title' && api.shown('x') == null) return api.toast('A moment: its lanes are still loading');
    const title = r.kind === 'title', w = r.where;
    const v0 = Object.fromEntries(['x', 'y', 'z', 'rx', 'ry', 'rz', 's', 'sx', 'sy', 'sz'].map((k) => [k, api.shown(k) ?? (k === 's' ? (Array.isArray(w.s) ? w.s[0] : w.s ?? 1) : w[k] ?? 0)]));
    const center = [v0.x, v0.y, v0.z], B = title ? null : basis(cam), p0 = title ? { x: w.x, y: w.y, scale: 1 } : project(center, B), filmCam = r.kind === 'camera';
    const m0 = api.mouse() ?? [p0.x + 60, p0.y];
    G = { mode, axis, local: mode === 'scale' && !!axis, axes: r.where?.sx != null, drag, title, B, center, p0: [p0.x, p0.y], scale: p0.scale, v0, R0: (filmCam ? camEuler : euler)(v0.rx, v0.ry, v0.rz), angles: filmCam ? camAngles : angles, m0, eff: [0, 0], last: m0,
      typed: '', turned: 0, prevAng: Math.atan2(m0[1] - p0.y, m0[0] - p0.x), bare, outline0: bare ? null : r.outline, box0: title || bare ? null : r.box ?? null, values: { ...v0 }, doc: null, docKey: null };
    update();
  }
  // the pointer moved (frame px): Shift moves a tenth as far
  function move(m, shift, ctrl) {
    if (!G) return;
    G.ctrl = ctrl;
    const d = [m[0] - G.last[0], m[1] - G.last[1]], k = shift ? 0.1 : 1;
    G.eff = [G.eff[0] + d[0] * k, G.eff[1] + d[1] * k];
    G.last = m;
    if (G.mode === 'rotate') {
      const cur = pointer(), a = Math.atan2(cur[1] - G.p0[1], cur[0] - G.p0[0]);
      let da = a - G.prevAng;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      G.turned += da; G.prevAng = a;
    }
    update();
  }
  const pointer = () => [G.m0[0] + G.eff[0], G.m0[1] + G.eff[1]];
  // the screen's direction of a world direction at the centre (frame px per world px)
  function screenAxis(a) {
    const L = 40 / G.scale, q = project(add(G.center, a, L), G.B);
    return [(q.x - G.p0[0]) / L, (q.y - G.p0[1]) / L];
  }
  // the axis the gesture keeps to, in the world: the world's, or (pressed twice) the thing's own as it is turned now
  const axisDir = (ax = G.axis, local = G.local) => (local ? apply(G.R0, AXES[ax]) : AXES[ax]);
  // a turn without an axis goes about the world axis most along the view
  const viewAxis = () => { const b = G.B?.back ?? [0, 0, 1], i = [0, 1, 2].reduce((m, j) => (Math.abs(b[j]) > Math.abs(b[m]) ? j : m), 2); return 'xyz'[i]; };
  // what the turn goes about: { name, u (unit, world), local }
  const turnAxis = () => (G.axis ? { name: G.axis, u: axisDir(), local: G.local } : { name: G.title ? 'z' : viewAxis(), u: AXES[G.title ? 'z' : viewAxis()], local: false });
  function compute(ctrl) {
    const n = G.typed === '' || G.typed === '-' ? null : +G.typed, v = { ...G.v0 };
    let hud = '', screen = { dx: 0, dy: 0, ang: 0, f: 1 }, turn = null;
    const label = () => (G.axis ? `${G.axis.toUpperCase()}${G.local ? ' local' : ''}` : 'Free');
    if (G.mode === 'move') {
      let d;
      if (G.title) d = G.axis === 'y' ? [0, n ?? G.eff[1], 0] : G.axis === 'x' ? [n ?? G.eff[0], 0, 0] : [n ?? G.eff[0], G.axis ? 0 : G.eff[1], 0];
      else if (G.axis) {
        const a = axisDir(), q = screenAxis(a);
        let t = n ?? dot2(G.eff, q) / Math.max(1e-6, dot2(q, q));
        if (ctrl && n == null) t = Math.round(t / 10) * 10;
        d = [a[0] * t, a[1] * t, a[2] * t];
      } else if (n != null) d = [n, 0, 0];
      else d = [0, 1, 2].map((i) => (G.B.right[i] * G.eff[0] + G.B.down[i] * G.eff[1]) / G.scale);
      if (ctrl && n == null && !(G.axis && !G.title)) d = d.map((x) => Math.round(x / 10) * 10);
      v.x += d[0]; v.y += d[1]; v.z += d[2];
      if (G.title) screen = { dx: d[0], dy: d[1] };
      else { const p = project(add(G.center, d), G.B); screen = { dx: p.x - G.p0[0], dy: p.y - G.p0[1] }; }
      const along = G.axis && G.local ? `  (${fx(Math.hypot(...d) * Math.sign(dot(d, axisDir()) || 1))} along it)` : '';
      hud = `${label()}  ${['x', 'y', 'z'].filter((k) => Math.abs(v[k] - G.v0[k]) > 1e-6 || (!G.local && G.axis === k)).map((k) => `${k} ${fx(v[k] - G.v0[k])}`).join('  ') || 'x 0  y 0'} px${along}`;
    } else if (G.mode === 'rotate') {
      const A = turnAxis();
      // (on screen, y down, a turn about an axis toward the camera shows clockwise: measured on the film's cube)
      const dir = G.title ? 1 : dot(A.u, G.B.back) > 0 ? 1 : -1;
      let a = n ?? deg(G.turned) * dir;
      if (ctrl && n == null) a = Math.round(a / 15) * 15;
      if (G.title) v.rz += a;
      else [v.rx, v.ry, v.rz] = G.angles(mul(about(A.u, rad(a)), G.R0), [G.v0.rx, G.v0.ry, G.v0.rz]);
      screen = { ang: G.title ? a : a * dir };
      turn = { ...A, a };
      hud = `${G.axis ? label() : `${A.name.toUpperCase()} (the axis most along the view)`}  ${fx(a)}°`;
    } else {
      const c = G.p0, d0 = Math.hypot(G.m0[0] - c[0], G.m0[1] - c[1]), cur = pointer();
      let f;
      if (G.axis) {
        // along one of its own axes: how far the pointer is along it, from the centre, of how far it was
        const q = screenAxis(axisDir(G.axis, true)), l = Math.hypot(...q) || 1, u = [q[0] / l, q[1] / l], a0 = dot2([G.m0[0] - c[0], G.m0[1] - c[1]], u);
        f = n ?? (Math.abs(a0) > 8 ? (a0 + dot2(G.eff, u)) / a0 : 1 + dot2(G.eff, u) / 200);
      } else f = n ?? (d0 > 8 ? Math.hypot(cur[0] - c[0], cur[1] - c[1]) / d0 : 1 + G.eff[0] / 200);
      if (ctrl && n == null) f = Math.round(f * 10) / 10;
      f = Math.max(0.001, f);
      if (G.axes) for (const a of G.axis ? [G.axis] : ['x', 'y', 'z']) v[`s${a}`] = G.v0[`s${a}`] * f;
      else v.s = G.v0.s * f;
      screen = { f };
      hud = `${G.axis ? `${G.axis.toUpperCase()} ` : ''}×${fx(f, 3)}${G.axes ? '' : `  (scale ${fx(v.s, 3)})`}`;
    }
    return { v, hud, screen, turn };
  }
  // what changed (only those; a turn written again as angles moves the others by float noise, which is not a change)
  const changed = (v) => Object.fromEntries(Object.entries(v).filter(([k, x]) => Math.abs(x - G.v0[k]) > (k[0] === 'r' ? 1e-4 : 1e-6)).map(([k, x]) => [k, Math.round(x * 1000) / 1000]));
  function update() {
    const { v, hud, screen, turn } = compute(G.ctrl);
    G.values = v; G.screen = screen; G.turn = turn;
    const keys = G.mode === 'scale' ? (G.axes ? 'X Y Z its axis · ' : '') : 'X Y Z axis (twice: its own) · ';
    api.hud(`<b>${NAME[G.mode]}</b> ${hud}<span>${G.typed !== '' ? ` · typed ${G.typed}` : ''} · ${keys}type a number · Ctrl snaps · Shift fine · ${G.drag ? 'release' : 'click or Enter'} sets · Esc cancels</span>`);
    api.paint();
  }
  /** The timeline as the gesture would leave it (the viewer draws it), or null when none goes on. */
  function doc() {
    if (!G) return null;
    const vals = changed(G.values), key = JSON.stringify(vals);
    if (G.docKey !== key) {
      const d = structuredClone(api.doc()), e = Object.keys(vals).length ? api.edits(vals, G.v0) : null;
      if (e) e.fn(d);
      G.doc = d; G.docKey = key;
    }
    return G.doc;
  }
  function finish(keep) {
    if (!G) return;
    const vals = changed(G.values), out = G.bare ? null : outline(), v0 = G.v0;
    G = null;
    api.hud('');
    if (keep && Object.keys(vals).length) api.commit(vals, out, v0);
    api.paint();
  }
  // the outline as the change moves it: the thing's corners moved in the world and seen through the camera (until the
  // studio finds the thing again); a title's (on the screen) moved on the screen
  function outline() {
    if (!G) return null;
    if (G.bare) return [];
    if (G.box0 && G.B) {
      // (its corners in its own axes, scaled along each, then turned and moved)
      const v = G.values, f = v.s / (G.v0.s || 1), F = G.axes ? ['sx', 'sy', 'sz'].map((k) => v[k] / (G.v0[k] || 1)) : [f, f, f], R = euler(v.rx, v.ry, v.rz), T = transpose(G.R0);
      const q = G.box0.map((w) => { const l = apply(T, sub(w, G.center)); return project(add([v.x, v.y, v.z], apply(R, [l[0] * F[0], l[1] * F[1], l[2] * F[2]])), G.B); });
      if (q.some((p) => p.depth <= 1)) return null;
      return hull(q.map((p) => [p.x, p.y]));
    }
    const s = G.screen, poly = G.outline0, c = G.p0;
    if (!poly || !s) return poly;
    const cos = Math.cos(rad(s.ang ?? 0)), sin = Math.sin(rad(s.ang ?? 0)), f = s.f ?? 1;
    return poly.map(([x, y]) => { const dx = (x - c[0]) * f, dy = (y - c[1]) * f; return [c[0] + dx * cos - dy * sin + (s.dx ?? 0), c[1] + dx * sin + dy * cos + (s.dy ?? 0)]; });
  }

  // ---------- keys while it goes
  function key(e) {
    if (!G) return false;
    const k = e.key;
    if (k === 'Escape') { finish(false); return true; }
    if (k === 'Enter') { finish(true); return true; }
    // (scaling: along its own axis, or none, where it scales along each)
    if (/^[xyz]$/i.test(k) && G.mode === 'scale' && G.axes) { const a = k.toLowerCase(); G.axis = G.axis === a ? null : a; update(); return true; }
    if (/^[xyz]$/i.test(k) && G.mode !== 'scale') {
      // the world's axis, then (again) the thing's own, then none, as Blender does
      const a = k.toLowerCase();
      if (G.axis !== a) { G.axis = a; G.local = false; } else if (!G.local && !G.title) G.local = true; else { G.axis = null; G.local = false; }
      update(); return true;
    }
    if (/^[0-9.]$/.test(k)) { G.typed += k; update(); return true; }
    if (k === '-') { G.typed = G.typed.startsWith('-') ? G.typed.slice(1) : `-${G.typed}`; update(); return true; }
    if (k === 'Backspace') { G.typed = G.typed.slice(0, -1); update(); return true; }
    if (k === 'Control') { G.ctrl = true; update(); return true; }
    if (['g', 'r', 's'].includes(k.toLowerCase())) { const m = { g: 'move', r: 'rotate', s: 'scale' }[k.toLowerCase()]; if (m !== G.mode) { const was = G; finish(false); start(m, { axis: null }); if (G) G.m0 = was.last; } return true; }
    return true;   // (nothing else happens mid-gesture)
  }

  // ---------- drawn over the selection (frame px): the gizmo, its parts grabbed with the pointer; mid-gesture, what the
  // gesture does
  // a ring (or an arc of one) about `u` through `c` (world), of radius R, seen through B: its points, each in front of
  // the centre or behind it; null if it goes behind the camera
  function ring(c, u, R, B, from = 0, span = 2 * Math.PI, n = 64) {
    const e1 = unit(cross(u, Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = cross(u, e1), cd = project(c, B).depth, out = [];
    for (let i = 0; i <= n; i++) {
      const a = from + (span * i) / n, q = project(add(add(c, e1, R * Math.cos(a)), e2, R * Math.sin(a)), B);
      if (q.depth <= 1) return null;
      out.push({ p: [q.x, q.y], front: q.depth <= cd, a });
    }
    return out;
  }
  // SVG path data through the points of a ring in front of its centre (or behind it)
  const runs = (list, front) => { let d = '', on = false; for (const x of list) { if (x.front === front) { d += `${on ? 'L' : 'M'}${x.p[0].toFixed(1)} ${x.p[1].toFixed(1)}`; on = true; } else on = false; } return d; };
  // an arrowhead: a cone from `base` to `tip` (world), seen through B, as its outline on the screen
  function cone(base, tip, r, B) {
    const u = unit(sub(tip, base)), e1 = unit(cross(u, Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = cross(u, e1), list = [tip];
    for (let i = 0; i < 16; i++) { const a = (i / 16) * 2 * Math.PI; list.push(add(add(base, e1, r * Math.cos(a)), e2, r * Math.sin(a))); }
    const q = list.map((p) => project(p, B));
    return q.some((p) => p.depth <= 1) ? null : hull(q.map((p) => [p.x, p.y]));
  }
  const SIZE = 90, RING = 0.68;   // (the arrows' length on the screen, px; the rings' radius, of it)
  // show: which of its handles the viewer draws ({ move, rotate, scale }: the overlays'); a light only moves
  function svg(show = { move: true, rotate: true, scale: true }) {
    if (G) return guides();
    const r = api.sel(), cam = api.cam();
    if (!r?.where || (!cam && r.kind !== 'title')) return '';
    const k = api.k(), w = r.where, title = r.kind === 'title';
    const on = { move: show.move, rotate: show.rotate && (r.kind !== 'light' || w.type !== 'point'), scale: show.scale && r.kind !== 'light' };
    if (!on.move && !on.rotate && !on.scale) return '';
    let c, parts = '';
    if (title) {
      c = [w.x, w.y];
      if (on.rotate) parts += `<g class="gz gz-ring" data-gz="rotate"><circle cx="${c[0]}" cy="${c[1]}" r="${SIZE * k}" fill="none" class="gz-hit"/><circle cx="${c[0]}" cy="${c[1]}" r="${SIZE * k}" fill="none" class="gz-line"/></g>`;
    } else {
      const center = [w.x, w.y, w.z ?? 0], B = basis(cam), p = project(center, B);
      if (p.depth <= 1) return '';
      c = [p.x, p.y];
      const L = (SIZE * k) / p.scale;
      // a ring per axis, to turn about it (its far half faint, as it goes behind)
      for (const [ax, a] of on.rotate ? Object.entries(AXES) : []) {
        const g = ring(center, a, L * RING, B);
        if (!g) continue;
        const all = g.map((x, i) => `${i ? 'L' : 'M'}${x.p[0].toFixed(1)} ${x.p[1].toFixed(1)}`).join('');
        parts += `<g class="gz gz-ring" data-gz="rotate" data-axis="${ax}"><path d="${all}" class="gz-hit" fill="none"/><path d="${runs(g, false)}" class="gz-rl back" stroke="${COLOR[ax]}" fill="none"/><path d="${runs(g, true)}" class="gz-rl" stroke="${COLOR[ax]}" fill="none"/></g>`;
      }
      // an arrow per axis, to move along it: in perspective, so an axis toward or away from you is short, its head a cone
      for (const [ax, a] of on.move ? Object.entries(AXES) : []) {
        const s = project(add(center, a, L * 0.2), B), e = project(add(center, a, L * 0.8), B), head = cone(add(center, a, L * 0.8), add(center, a, L * 1.05), L * 0.075, B);
        if (s.depth <= 1 || e.depth <= 1 || !head) continue;
        const len = Math.hypot(e.x - c[0], e.y - c[1]), op = Math.min(1, Math.max(0, (len - 8 * k) / (16 * k)));
        if (op <= 0) continue;   // (an axis along the view: nothing to drag)
        parts += `<g class="gz gz-arrow" data-gz="move" data-axis="${ax}" opacity="${op.toFixed(2)}"><line x1="${s.x}" y1="${s.y}" x2="${e.x}" y2="${e.y}" stroke="${COLOR[ax]}" class="gz-shaft"/><line class="gz-hit" x1="${c[0]}" y1="${c[1]}" x2="${e.x}" y2="${e.y}"/><polygon points="${pts(head)}" fill="${COLOR[ax]}" class="gz-head"/></g>`;
      }
      // a small square along each of its own axes, to scale along it (where it has them)
      if (on.scale && w.sx != null) {
        const Rw = euler(w.rx ?? 0, w.ry ?? 0, w.rz ?? 0), box = 4.5 * k;
        for (const [ax, a] of Object.entries(AXES)) {
          const q = project(add(center, apply(Rw, a), L * 0.58), B);
          if (q.depth <= 1 || Math.hypot(q.x - c[0], q.y - c[1]) < 22 * k) continue;
          parts += `<g class="gz" data-gz="scale" data-axis="${ax}"><rect x="${q.x - box}" y="${q.y - box}" width="${box * 2}" height="${box * 2}" fill="${COLOR[ax]}" class="gz-sq-axis"/></g>`;
        }
      }
    }
    const sq = 8 * k, s = [c[0] + SIZE * 0.92 * k, c[1] - SIZE * 0.92 * k];
    if (on.scale) parts += `<g class="gz" data-gz="scale"><line x1="${c[0]}" y1="${c[1]}" x2="${s[0]}" y2="${s[1]}" class="gz-sq-line"/><rect x="${s[0] - sq}" y="${s[1] - sq}" width="${sq * 2}" height="${sq * 2}" class="gz-sq"/></g>`;
    if (on.move) parts += `<g class="gz" data-gz="move"><circle cx="${c[0]}" cy="${c[1]}" r="${8 * k}" class="gz-center"/></g>`;
    return `<g class="gizmo">${parts}</g>`;
  }
  // mid-gesture: where it was, the axis it keeps to, the turn so far on its ring, the scale's reach from the centre
  function guides() {
    const k = api.k(), c = G.p0, cur = pointer();
    // (a light line over a dark one, so it reads on any picture)
    const twice = (tag, at, cls) => `<${tag} ${at} class="gz-under"/><${tag} ${at} class="${cls}"/>`;
    let out = twice('circle', `cx="${c[0]}" cy="${c[1]}" r="${4 * k}" fill="none"`, 'gz-pivot');
    const line = (u, color) => {
      const q = G.title ? u.slice(0, 2) : screenAxis(u), l = Math.hypot(...q) || 1, d = [q[0] / l, q[1] / l];
      return `<line class="gz-guide" x1="${c[0] - d[0] * 4000}" y1="${c[1] - d[1] * 4000}" x2="${c[0] + d[0] * 4000}" y2="${c[1] + d[1] * 4000}" stroke="${color}"/>`;
    };
    const dashTo = twice('line', `x1="${c[0]}" y1="${c[1]}" x2="${cur[0]}" y2="${cur[1]}"`, 'gz-dash');
    if (G.mode === 'move') {
      if (G.axis) out = line(axisDir(), COLOR[G.axis]) + out;
      const s = G.screen;
      if (s && Math.hypot(s.dx, s.dy) > 2) out += twice('line', `x1="${c[0]}" y1="${c[1]}" x2="${c[0] + s.dx}" y2="${c[1] + s.dy}"`, 'gz-trail') + `<circle cx="${c[0] + s.dx}" cy="${c[1] + s.dy}" r="${4 * k}" class="gz-pivot now"/>`;
    } else if (G.mode === 'rotate') {
      const t = G.turn, color = COLOR[t.name];
      if (G.title) out += `<circle cx="${c[0]}" cy="${c[1]}" r="${SIZE * k}" fill="none" class="gz-turn-ring" stroke="${color}"/>`;
      else {
        if (G.axis) out = line(t.u, color) + out;
        const R = (SIZE * k) / G.scale, g = ring(G.center, t.u, R, G.B);   // (larger than the gizmo's: the turn reads at a glance)
        if (g) {
          out += `<path d="${runs(g, false)}" class="gz-turn-ring back" stroke="${color}" fill="none"/><path d="${runs(g, true)}" class="gz-turn-ring" stroke="${color}" fill="none"/>`;
          // the turn so far: from where the pointer took hold of the ring, as far as the thing has turned
          const near = (x) => Math.hypot(x.p[0] - G.m0[0], x.p[1] - G.m0[1]), from = g.reduce((b, x) => (near(x) < near(b) ? x : b)).a;
          const span = Math.max(-2 * Math.PI, Math.min(2 * Math.PI, rad(t.a)));
          const arc = Math.abs(span) > 1e-3 && ring(G.center, t.u, R, G.B, from, span, Math.max(8, Math.ceil(Math.abs(span) / 0.08)));
          if (arc) out += `<polygon points="${pts([c, ...arc.map((x) => x.p)])}" class="gz-sweep" fill="${color}"/>`;
        }
      }
      out += dashTo;
    } else {
      if (G.axis) out = line(axisDir(G.axis, true), COLOR[G.axis]) + out;
      const d0 = Math.hypot(G.m0[0] - c[0], G.m0[1] - c[1]), d1 = Math.hypot(cur[0] - c[0], cur[1] - c[1]);
      if (d0 > 8 && !G.axis) out += twice('circle', `cx="${c[0]}" cy="${c[1]}" r="${d0}" fill="none"`, 'gz-reach was') + twice('circle', `cx="${c[0]}" cy="${c[1]}" r="${d1}" fill="none"`, 'gz-reach');
      out += dashTo;
    }
    return `<g class="gizmo-guides">${out}</g>`;
  }

  return {
    start, move, key, finish, svg, outline, doc,
    /** What the gesture changes now: { vals (the values it changed), v0 (all as they were) }, or null when none goes on. */
    values: () => (G ? { vals: changed(G.values), v0: G.v0 } : null),
    get active() { return !!G; },
    get dragging() { return !!G?.drag; },
    setCtrl(on) { if (G && G.ctrl !== on) { G.ctrl = on; update(); } },
  };
}
