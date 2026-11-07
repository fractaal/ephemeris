// What the viewer draws over the picture, through the camera the picture was drawn from: the floor's grid, the scene's
// lights, the selection's outline (each copy of an object whole), the selection's path and the points its pose is set
// at, the project camera's frame and path (seen from outside it, in the Director view) and the notes pinned to things.
// Each is SVG in the frame's pixels (an <svg class="obj-ov"> of viewBox 0 0 W H laid over the picture, styled by
// overlays.css), drawn through B, the camera's basis (lens.js basis), and leaves out what is behind the camera. The
// editor's viewer draws them over its pictures (nle/app.js), the film in the editor's frame over its own (viewport.js).
import { project, hull } from './lens.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const r6 = (x) => Math.round(x * 1e6) / 1e6;
/** A colour as CSS: an [r, g, b] of 0 to 1 as hex. */
export const cssColor = (c) => (Array.isArray(c) ? `#${c.map((v) => Math.round(255 * Math.min(1, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}` : c ?? '#ffffff');
/** A polygon's points as SVG takes them. */
export const points = (poly) => poly.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');

/** A box's corners in the world seen through B: their hull on the frame, or null where one is behind the camera. */
export function boxHull(box, B) {
  const q = box.map((p) => project(p, B));
  return q.some((p) => p.depth <= 1) ? null : hull(q.map((p) => [p.x, p.y]));
}
/** A located thing's outline on the frame (as pick.js describes one: its corners in the world, seen through B; or, with
 *  none or no camera, the outline on the screen it came with). */
export const outlineOf = (now, B) => (!now ? null : now.box && B ? boxHull(now.box, B) : now.outline ?? null);
/** The copies of an object whole, each its outline on the frame (members: each its corners in the world, or an outline
 *  on the screen as it is). */
export const membersOf = (now, B) => now?.members?.flatMap((m) => {
  if (m[0].length === 2) return [m];
  const q = B ? boxHull(m, B) : null;
  return q ? [q] : [];
}) ?? null;

/** The selection's outlines: each copy of an object whole (members, thinly), the thing itself (sel) and the others
 *  selected with it (also, fainter), each a polygon of frame pixels. */
export function outlinesSvg({ members = null, sel = null, also = [] }) {
  return (members ? `<g class="sel-all">${members.map((q) => `<polygon points="${points(q)}"/>`).join('')}</g>` : '')
    + (sel ? `<polygon class="sel" points="${points(sel)}"/>` : '')
    + also.filter(Boolean).map((q) => `<polygon class="sel also" points="${points(q)}"/>`).join('');
}

/** The world's floor (y = 0) as a grid: a line every 100 px, every fifth stronger, fading out to 3000 px from the
 *  origin; its X axis red, its Z axis blue (the gizmo's colours); each line cut where it passes behind the camera. */
export function gridSvg(B) {
  const NEAR = 20, STEP = 100, EXT = 3000, d = {};
  const depth = (p) => -((p[0] - B.eye[0]) * B.back[0] + (p[1] - B.eye[1]) * B.back[1] + (p[2] - B.eye[2]) * B.back[2]);
  const seg = (a, b, cls) => {
    const da = depth(a), db = depth(b);
    if (da < NEAR && db < NEAR) return;
    if (da < NEAR) a = a.map((v, i) => v + (b[i] - v) * ((NEAR - da) / (db - da)));
    else if (db < NEAR) b = b.map((v, i) => v + (a[i] - v) * ((NEAR - db) / (da - db)));
    const p = project(a, B), q = project(b, B);
    d[cls] = `${d[cls] ?? ''}M${p.x.toFixed(1)} ${p.y.toFixed(1)}L${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
  };
  for (let i = -EXT / STEP; i <= EXT / STEP; i++) {
    const c = i * STEP, kind = i % 5 ? 'minor' : 'major';
    for (let s0 = -EXT; s0 < EXT; s0 += 1000) {
      const band = `b${Math.min(2, Math.floor((Math.max(Math.abs(c), Math.abs(s0), Math.abs(s0 + 1000)) - 1) / 1000))}`;
      seg([c, 0, s0], [c, 0, s0 + 1000], `${i ? kind : 'axz'} ${band}`);   // along z (x = c)
      seg([s0, 0, c], [s0 + 1000, 0, c], `${i ? kind : 'axx'} ${band}`);   // along x (z = c)
    }
  }
  return `<g class="grid">${Object.entries(d).map(([cls, path]) => `<path class="${cls}" d="${path}"/>`).join('')}</g>`;
}

/** The scene's own lights (runtime.js lightsIn): a mark where each is, in its colour, a spot's way dashed from it; from
 *  where each is in the world (point, aim), or where it was found on the screen (x, y, toward) with no camera. */
export function lightsSvg(lights, B) {
  let out = '';
  for (const l of lights ?? []) {
    let { x, y, toward } = l;
    if (B && l.point) {
      const p = project(l.point, B), q = l.aim && project(l.aim, B);
      if (p.depth <= 1) continue;
      x = p.x; y = p.y; toward = q && q.depth > 1 ? [q.x, q.y] : null;
    } else if (x == null) continue;
    const c = esc(cssColor(l.color)), way = toward ? `<line x1="0" y1="0" x2="${(toward[0] - x).toFixed(1)}" y2="${(toward[1] - y).toFixed(1)}"/>` : '';
    out += `<g class="light-mark" transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><title>${esc(l.label || l.type)}: click to select</title>${way}<circle r="16" style="stroke:${c}"/><circle r="6" class="core" style="fill:${c}"/></g>`;
  }
  return out;
}

/** A thing's path through the film (runs: each a line, [[t, [x, y, z]]…]) and the points its pose is set at (pts: {
 *  t, what: 'key' | a move's, sel: its lane selected }, each a handle: data-pt its index; the one at the playhead t
 *  filled); k: frame pixels a screen pixel, so the marks keep their size. */
export function pathSvg(runs, pts, B, { k = 1, t = 0 } = {}) {
  const at = new Map();
  let d = '';
  for (const run of runs ?? []) {
    let on = false;
    for (const [tt, p] of run) {
      const q = project(p, B);
      if (q.depth <= 1) { on = false; continue; }
      at.set(tt, q);
      d += `${on ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
      on = true;
    }
  }
  const r = 4.5 * k, marks = [];
  (pts ?? []).forEach((p, i) => {
    const q = at.get(r6(p.t));
    if (!q) return;
    const now = Math.abs(p.t - t) < 1e-3, m = p.what === 'key' ? `<path class="mark" d="M0 ${-r * 1.35}L${r * 1.35} 0L0 ${r * 1.35}L${-r * 1.35} 0Z"/>` : `<circle class="mark" r="${r}"/>`;
    marks.push(`<g class="path-pt${p.sel ? ' sel' : ''}${now ? ' now' : ''}" data-pt="${i}" transform="translate(${q.x.toFixed(1)},${q.y.toFixed(1)})"><title>${p.what === 'key' ? 'A key' : 'A move lands'} at ${(+p.t).toFixed(2)} s · click to go there, drag to move it there</title><circle class="hit" r="${11 * k}"/>${m}</g>`);
  });
  return `${d ? `<path class="path under" d="${d}"/><path class="path" d="${d}"/>` : ''}${marks.join('')}`;
}

/** The project camera seen from outside it, as the Director view shows it: its path through the film (path: runtime.js
 *  __cameraPath's poses, [{ t, eye, camera, right, down }]), a line for each shot, its cuts each a small square; and at
 *  t where it is and what it frames, between the two poses about t (its frustum, a small triangle over its frame's top
 *  edge saying which way is up), in the accent where selected. W × H: the film's frame; k: frame pixels a screen pixel.
 *  line: the path drawn (or only the camera at t). */
export function cameraSvg(path, B, { cuts = [], t = 0, W, H, k = 1, selected = false, line = true } = {}) {
  if (!path?.length) return '';
  const at = (p) => { const q = project(p, B); return q.depth > 1 ? [q.x, q.y] : null; };
  const d = (pts, close) => {
    let s = '', on = false;
    for (const p of pts) {
      const q = p && at(p);
      if (!q) { on = false; continue; }
      s += `${on ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
      on = true;
    }
    return close && pts.every((p) => p && at(p)) ? `${s}Z` : s;
  };
  let out = '';
  if (line) {
    // one line per shot: a hard cut jumps to another camera, not along a path
    out += `<path class="cam-path" d="${d(path.flatMap((p, i) => (i && cuts.some((c) => path[i - 1].t < c && c <= p.t) ? [null, p.eye] : [p.eye])))}"/>`;
    for (const c of cuts) {
      const p = path.reduce((a, b) => (Math.abs(b.t - c) < Math.abs(a.t - c) ? b : a)), q = at(p.eye);
      if (q) out += `<rect class="cam-cut" x="${(q[0] - 2.5 * k).toFixed(1)}" y="${(q[1] - 2.5 * k).toFixed(1)}" width="${5 * k}" height="${5 * k}"/>`;
    }
  }
  const i = path.findIndex((p) => p.t >= t);
  if (i >= 0) {
    const a = path[Math.max(0, i - 1)], b = path[i], u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    const mix = (x, y) => x.map((v, j) => v + (y[j] - v) * u);
    const corners = (p) => { const c = p.camera, T = [c.x, c.y, c.z], hw = W / 2 / c.zoom, hh = H / 2 / c.zoom;
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => T.map((v, j) => v + p.right[j] * sx * hw + p.down[j] * sy * hh)); };
    const ca = corners(a), cb = corners(b), C = ca.map((p, j) => mix(p, cb[j])), E = mix(a.eye, b.eye);
    const top = C[0].map((v, j) => (v + C[1][j]) / 2), lift = top.map((v, j) => v - (C[3][j] - C[0][j]) * 0.12), half = C[1].map((v, j) => (v - C[0][j]) * 0.08);
    const lines = [d([...C, C[0]]), ...C.map((c) => d([E, c])), d([top.map((v, j) => v - half[j]), lift, top.map((v, j) => v + half[j])])].join('');
    const q = at(E);
    out += `<g class="cam-frustum${selected ? ' sel' : ''}"><path d="${lines}"/>${q ? `<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="${(3.5 * k).toFixed(2)}"/>` : ''}</g>`;
  }
  return `<g class="camera">${out}</g>`;
}

/** Notes pinned to things (pins: { point: a place in the world, or screen: [x, y] on the frame; text }), each a pin
 *  with its text. */
export function pinsSvg(pins, B) {
  let out = '';
  for (const q of pins ?? []) {
    let p = null;
    if (q.point && B) { const s = project(q.point, B); if (s.depth > 1) p = [s.x, s.y]; }
    else if (q.screen) p = q.screen;
    if (!p) continue;
    out += `<g class="pin" transform="translate(${p[0].toFixed(1)},${p[1].toFixed(1)})"><circle r="9"/><circle r="3.5" class="dot"/><text x="16" y="5">${esc(q.text)}</text></g>`;
  }
  return out;
}
