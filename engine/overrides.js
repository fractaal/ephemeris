// Overrides: the editor's changes over what a film's code computes (the timeline's "overrides"), as After Effects
// keyframes sit over an expression. Three kinds:
//   { stack: 'film.js:30:12', … }   a motion the code writes (motion(), a rig): its operators retimed or changed, its
//       lanes reordered or turned off, lanes of your own in it. Applied where the stack is evaluated (motion.js,
//       setOverrides): ops { opId: { shift, dur, ease, mode, to, by, rate, amp, speed, keys, influence } }, base
//       { ch: v }, order { ch: [laneId…] }, muted { ch: [laneId…] }, lanes { ch: [lane…] } (channel space: a rig's zoom
//       as its logarithm)
//   { on: { at, nth, key | like }, props }   a thing the code places, named as the editor found it: the call that
//       placed it (at: file:line:col), which of that call's nodes (nth), and for a copy of a many() its id or its
//       fields (key, like; see matchCopy)
//   { on: { sites: [at…] }, props }   an object, whole (the editor's: a thing the code defines with every line that
//       places it, and all one line places — a loop's, a many()'s copies): every copy of every node those lines
//       place, each changed as one would be (moved by the same amount, turned and scaled about its own centre, its
//       material's inputs set). A copy's own change applies over its object's
//   { on: { camera: true }, props }   the film's camera
//   { on: { scene: true }, props }   the scene's own settings (SCENE): its view, the lens's glow and vignette, the
//       light around and the backdrop. Its numbers take lanes over the code's value; a colour is set in place of the
//       code's (or keyed), and so is the view transform ('agx', 'neutral', 'standard')
// A thing's `props` can also hide it (hidden: true: not in the film, its row and its lanes still there), set a light's
// shadows (true | false), and scale an added thing along its own axes (sx, sy, sz).
// For the last two, each of `props` is a plain value of it (one the code computes without a motion: x, y, z, rx, ry,
// rz, s, opacity, a material input; a camera's channels: x, y, z, zoom, yaw, pitch, roll, a target camera's tx, ty, tz): { lanes: [lane…], order?, muted? },
// your lanes over the code's value; or, as first written, a value or keyframes [{ t, v }] (position and turn added
// to the code's, scale multiplying it, the rest in place of it; a colour always so). A lane: { id, kind: 'keys',
// mode: 'add' | 'aim' | 'replace' | 'multiply', keys: [[t, v, ease?]…], influence? } | { kind: 'moves', moves:
// [{ t, dur, to | by, ease? }] } | { kind: 'rate', rate, from } | { kind: 'wander', amp, speed }.
import { material } from './mesh.js';
import { LIGHT, lightWay, turned } from './light.js';
import { valueAt, keyed } from './keyframes.js';
import { siteOf, matchCopy, fieldsOf } from './pick.js';
import { Stack, asLanes as lanesOf } from './motion.js';
import { paramValue, withParam } from './pass.js';
import { ENVIRONMENT } from './render/scene.js';

const MOVES = ['x', 'y', 'z', 'rx', 'ry', 'rz'];
const AXES = ['sx', 'sy', 'sz'];
const OWN = new Set([...MOVES, 's', ...AXES, 'opacity', 'hidden']);
export const CAMERA = ['x', 'y', 'z', 'tx', 'ty', 'tz', 'zoom', 'yaw', 'pitch', 'roll'];   // (every kind's: lens.js CHANNELS)
// the scene's own settings: how it is seen (view: exposure, transform), the lens's glow and vignette (post: bloom,
// vignette), the light around (environment: intensity; its colours zenith, horizon, nadir) and the backdrop (what the
// camera sees where nothing is): numbers over which lanes go, colours, and the view transform (one of TRANSFORMS)
export const SCENE_NUMBERS = ['exposure', 'bloom', 'vignette', 'intensity'];
export const SCENE_COLOURS = ['zenith', 'horizon', 'nadir', 'backdrop'];
export const SCENE = ['transform', ...SCENE_NUMBERS, ...SCENE_COLOURS];

// a change the lanes can make (a number's); a colour is set in place of the code's
const numeric = (p) => (p && typeof p === 'object' && !Array.isArray(p) ? Array.isArray(p.lanes) : keyed(p) ? typeof p[0].v === 'number' : typeof p === 'number');

/** The code's own value of a plain property of a placed node (its copy `it`, for a mesh), or of a camera. */
export function codeValue(n, it, k) {
  if (!n) return null;
  if (n.pass) {
    // (a placed pass is where it is, as a mesh copy is; then its params)
    if (n.pass.bounds && MOVES.includes(k)) return n[k] ?? 0;
    if (n.pass.bounds && k === 's') return Array.isArray(n.s) ? n.s[0] : n.s ?? 1;
    const v = paramValue(n.params, k);
    return typeof v === 'number' ? v : null;
  }
  if (n.light) return MOVES.includes(k) ? n[k] ?? 0 : LIGHT.includes(k) && typeof n[k] === 'number' ? n[k] : null;
  if (n.mesh) {
    if (MOVES.includes(k)) return it[k] ?? 0;
    if (k === 's') return Array.isArray(it.s) ? it.s[0] : it.s ?? 1;
    // (its scale along each of its own axes, as an added thing has it)
    if (AXES.includes(k)) return Array.isArray(it.s) ? it.s[AXES.indexOf(k)] : it.s ?? 1;
    // (a surface of the film's own: its params, as a material's inputs)
    const sv = paramValue(n.surface?.params, k);
    if (typeof sv === 'number') return sv;
    // (how strongly it glows: the material keeps that in its emission, its colour times it)
    if (k === 'emissionStrength') return n.material ? Math.max(...n.material.emission) : null;
    return typeof n.material?.[k] === 'number' ? n.material[k] : null;
  }
  if (MOVES.includes(k)) return n[k] ?? 0;
  return k === 's' ? 1 : k === 'opacity' ? n.opacity ?? 1 : null;
}
/** A camera's own value of k. */
export const cameraValue = (c, k) => c?.[k] ?? (k === 'zoom' ? 1 : 0);

// each change's lanes as a stack over the code's value, kept for the page's life (it reads one timeline): its solves
// (an Aim key against the code's value at its time) are worked out once
// (an object's change is one stack for all its copies, but where its lanes land on a value — an Aim key, a move to a
// value — each copy solves against its own code: a stack each, `member` naming it)
const stacks = new Map();
const sizedOf = new WeakMap();
function sized(k, p) {
  if (!p || typeof p !== 'object') return false;
  let v = sizedOf.get(p);
  if (v == null) sizedOf.set(p, (v = lanesOf(k, p).lanes.some((l) => (l.kind === 'keys' && l.mode === 'aim') || ((l.kind === 'moves' || l.kind === 'move') && (l.moves ?? []).some((m) => (m.mode ?? (m.to != null ? 'aim' : 'add')) === 'aim')))));
  return v;
}
function laneValue(id, k, p, code, t, codeAt, member = null) {
  const key = member && sized(k, p) ? `${id}|${k}|${member()}` : `${id}|${k}`;
  let e = stacks.get(key);
  if (!e || e.src !== p) {
    const L = lanesOf(k, p), now = { t: NaN, v: 0 }, seen = new Map();
    const at = (tt) => {
      if (tt === now.t) return now.v;
      if (!seen.has(tt)) seen.set(tt, codeAt(tt) ?? now.v);
      return seen.get(tt);
    };
    e = { src: p, now, stack: new Stack(null, { id: key, code: at, local: { lanes: { value: L.lanes }, ...(L.order && { order: { value: L.order } }), ...(L.muted && { muted: { value: L.muted } }) } }) };
    stacks.set(key, e);
  }
  e.now.t = t; e.now.v = code;
  return e.stack.value('value', t);
}

// a node's plain properties as its override sets them now (each the value the lanes give, with the code's beside it)
// (member: which copy of an object's this is, named only where its lanes need it)
function valuesOf(o, n, it, t, codeAt, member = null) {
  const out = {};
  for (const [k, v] of Object.entries(o.props ?? {})) {
    if (!numeric(v)) { out[k] = { set: valueAt(v, t), code: null }; continue; }
    const code = codeValue(n, it, k);
    if (code == null) continue;
    out[k] = { set: laneValue(o.id, k, v, code, t, (tt) => codeAt(tt, k), member), code };
  }
  return out;
}
// a thing with its properties set: position and turn, its scale (by the factor the lanes give over the code's), opacity
function moved(thing, p, size) {
  const o = { ...thing };
  for (const k of MOVES) if (p[k]) o[k] = p[k].set;
  if (p.s) {
    const f = p.s.set / (p.s.code || 1);
    if (size && !thing.pass) { o.w *= f; o.h *= f; } else o.s = Array.isArray(o.s) ? o.s.map((v) => v * f) : (o.s ?? 1) * f;
  }
  // (along its own axes, by the factor each gives over the code's)
  if (AXES.some((k) => p[k])) { const s = Array.isArray(o.s) ? o.s : [o.s ?? 1, o.s ?? 1, o.s ?? 1]; o.s = s.map((v, i) => v * (p[AXES[i]] ? p[AXES[i]].set / (p[AXES[i]].code || 1) : 1)); }
  if (p.opacity) o.opacity = p.opacity.set;
  if (p.hidden) o.hidden = !!p.hidden.set;
  // (a copy's own colour, which tints its material's: the colour set is the colour it has)
  if (p.baseColor && !size && !thing.pass && !thing.light) delete o.baseColor;
  // (a light's own: its numbers, its colour)
  for (const k of LIGHT) if (p[k] && thing.light) o[k] = p[k].set;
  if (p.color && thing.light) o.color = p.color.set;
  if (p.shadows && thing.light) o.shadows = !!p.shadows.set;
  // (turned: its way, from the way it had unturned)
  if (thing.light && (p.rx || p.ry || p.rz)) { o.dir = turned(thing.dir0 ?? lightWay(thing), o.rx, o.ry, o.rz); o.aim = undefined; }
  // (a pass's params: numbers by their lanes, a colour in place of the code's)
  if (thing.pass) { o.params = thing.params; for (const k in p) o.params = withParam(o.params, k, p[k].set); }
  return o;
}
const flat = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.set]));
const codeOf = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.code]));

/** The node `on` names in `nodes` (each carrying where it was placed: its site), and its copy; null where it is not. */
export function findPlaced(nodes, on) {
  const mine = [];
  const seen = new Map();
  nodes.forEach((n, i) => {
    const at = n && siteOf(n.site)?.at;
    if (!at) return;
    const nth = n.nth ?? (seen.set(at, (seen.get(at) ?? -1) + 1), seen.get(at));
    if (at === on.at && nth === (on.nth ?? 0)) mine.push(i);
  });
  if (!mine.length) return null;
  const n = nodes[mine[0]];
  if (!n.mesh) return { i: mine[0], n, it: null, k: 0 };
  const k = n.instances.length === 1 ? 0 : matchCopy(n.instances.map((it) => it.__orig ?? it), on);
  return k < 0 ? null : { i: mine[0], n, it: n.instances[k], k };
}

/**
 * The scene's nodes with `overrides` applied at t (each node needs where it was placed: its site, see placed()).
 * codeScene(t): the scene as the code alone computes it at another moment (an Aim lane is sized against it).
 */
export function applyOverrides(nodes, overrides, t, codeScene = null) {
  const list = (overrides ?? []).filter((o) => o?.on?.at || o?.on?.sites?.length);
  if (!list.length) return nodes;
  // (the code's scene at another moment, once for every copy that sizes a lane against it)
  const scenes = new Map(), sceneAt = (tt) => { if (!scenes.has(tt)) scenes.set(tt, codeScene(tt)); return scenes.get(tt); };
  // the code's value of a property of a node (named as an override names it, or by a function that names it) at another
  // moment
  const codeAt = (on) => (tt, k) => { const f = codeScene && findPlaced(sceneAt(tt).nodes, typeof on === 'function' ? on() : on); return f ? codeValue(f.n, f.it, k) : null; };
  // each node keeps which of its call's nodes it is (nth), also when a copy leaves it for a material of its own
  const bySite = new Map();
  nodes = nodes.map((n, i) => {
    const at = n && siteOf(n.site)?.at;
    if (!at) return n;
    if (!bySite.has(at)) bySite.set(at, []);
    bySite.get(at).push(i);
    return { ...n, nth: bySite.get(at).length - 1 };
  });
  // an object's changes first, on every copy it has: what a copy's own change is over
  for (const o of list) {
    if (!o.on.sites?.length) continue;
    for (const at of o.on.sites) for (const i of bySite.get(at) ?? []) {
      const n = nodes[i];
      if (!n.mesh) {
        const p = valuesOf(o, n, null, t, codeAt({ at, nth: n.nth }), () => `${at}#${n.nth}`);
        nodes[i] = { ...moved(n, p, true), __applied: flat(p), __override: o.id, __code: { opacity: n.opacity ?? 1, ...codeOf(p) } };
        continue;
      }
      // (a mesh's copies each moved; its material's inputs, and its surface's params, set for all of them)
      let mat = null;
      const instances = n.instances.map((it, k) => {
        const orig = it.__orig ?? it, key = orig.id ?? orig.key ?? null;
        const p = valuesOf(o, n, it, t, codeAt(() => ({ at, nth: n.nth, ...(key != null ? { key } : { like: fieldsOf(orig), copy: k }) })), () => `${at}#${n.nth}#${key ?? k}`);
        mat ??= Object.fromEntries(Object.entries(p).filter(([q]) => !OWN.has(q)).map(([q, v]) => [q, v.set]));
        return { ...moved(it, p, false), __orig: orig, __applied: flat(p), __override: o.id, __code: codeOf(p) };
      });
      nodes[i] = { ...n, instances, ...(mat && Object.keys(mat).length && withMaterial(n, mat)) };
    }
  }
  const out = [...nodes], extra = [];
  // per node: its copies' changes, and which copies leave for a material of their own
  const work = new Map();
  for (const o of list) {
    if (o.on.sites?.length) continue;
    const i = (bySite.get(o.on.at) ?? [])[o.on.nth ?? 0];
    if (i == null) continue;
    const n = nodes[i];
    if (!n.mesh) {
      const p = valuesOf(o, n, null, t, codeAt(o.on));
      out[i] = { ...moved(out[i], p, true), __applied: { ...n.__applied, ...flat(p) }, __override: o.id, __code: { opacity: n.opacity ?? 1, ...n.__code, ...codeOf(p) } };
      continue;
    }
    const k = n.instances.length === 1 ? 0 : matchCopy(n.instances.map((it) => it.__orig ?? it), o.on);
    if (k < 0) continue;
    const p = valuesOf(o, n, n.instances[k], t, codeAt(o.on));
    if (!work.has(i)) work.set(i, new Map());
    const w = work.get(i), mat = Object.fromEntries(Object.entries(p).filter(([key]) => !OWN.has(key)).map(([key, v]) => [key, v.set]));
    w.set(k, { p: { ...w.get(k)?.p, ...p }, mat: { ...w.get(k)?.mat, ...mat }, id: o.id });
  }
  for (const [i, w] of work) {
    const n = nodes[i], stay = [];
    n.instances.forEach((it, k) => {
      const c = w.get(k);
      if (!c) return stay.push(it);
      // (what it was, and what changed it, for the editor: also the code's values)
      const m = { ...moved(it, c.p, false), __orig: it.__orig ?? it, __applied: { ...it.__applied, ...flat(c.p) }, __override: c.id, __code: { ...it.__code, ...codeOf(c.p) } };
      if (!Object.keys(c.mat).length) return stay.push(m);
      // a material of its own: this copy draws as a node of its own (its surface's params changed there too)
      const own = { ...n, instances: [m], ...withMaterial(n, c.mat) };
      if (n.instances.length === 1) { out[i] = own; return; }
      extra.push(own);
    });
    if (out[i] === nodes[i] || out[i].instances === n.instances) out[i] = { ...n, instances: stay };
  }
  const all = extra.length ? [...out, ...extra] : out;
  return list.some((o) => o.props?.hidden) ? all.flatMap(shown) : all;
}
/**
 * A gesture as it goes over the scene's nodes (the editor's viewport: viewport.js): each thing `refs` names (as an
 * override's `on` does: a node and its copy, or an object's every copy) moved and turned by as much as `vals` are over
 * `v0` (x, y, z, rx, ry, rz), and scaled as many times (s, sx, sy, sz), as the editor's edit of it leaves it at this
 * moment. Each node needs where it was placed (its site).
 */
export function nudged(nodes, refs, vals, v0) {
  const change = (it) => {
    const p = {};
    for (const k of MOVES) if (k in vals) { const was = it[k] ?? 0; p[k] = { set: was + vals[k] - (v0[k] ?? 0), code: was }; }
    for (const k of ['s', ...AXES]) if (k in vals) p[k] = { set: vals[k], code: v0[k] || 1 };
    return p;
  };
  const copy = (it) => ({ ...moved(it, change(it), false), __orig: it.__orig ?? it });
  const out = [...nodes];
  for (const on of refs) {
    if (on.sites?.length) {
      const sites = new Set(on.sites);
      out.forEach((n, i) => { if (n && sites.has(siteOf(n.site)?.at)) out[i] = n.mesh ? { ...n, instances: n.instances.map(copy) } : moved(n, change(n), true); });
      continue;
    }
    const f = findPlaced(out, on);
    if (!f) continue;
    if (!f.n.mesh) { out[f.i] = moved(f.n, change(f.n), true); continue; }
    const instances = [...f.n.instances];
    instances[f.k] = copy(f.it);
    out[f.i] = { ...f.n, instances };
  }
  return out;
}
/** The film camera with a gesture as it goes (the gizmo's x, y, z, rx, ry, rz and s are its x, y, z, pitch, yaw, roll and
 *  zoom; what its kind lacks it keeps). */
export function nudgedCamera(c, vals, v0) {
  const o = { ...c };
  for (const [k, ch] of [['x', 'x'], ['y', 'y'], ['z', 'z'], ['rx', 'pitch'], ['ry', 'yaw'], ['rz', 'roll']]) if (k in vals && o[ch] != null) o[ch] += vals[k] - (v0[k] ?? 0);
  if ('s' in vals && o.zoom != null) o.zoom *= vals.s / (v0.s || 1);
  return o;
}
// a node as what is hidden leaves it: gone, or without its hidden copies
function shown(n) {
  if (!n?.instances?.some((it) => it.hidden)) return n?.hidden ? [] : [n];
  const instances = n.instances.filter((it) => !it.hidden);
  return instances.length ? [{ ...n, instances }] : [];
}
// a mesh node's material with `mat` set over the code's (its surface's params where they are its), and the code's kept
function withMaterial(n, mat) {
  let surface = n.surface;
  const rest = {};
  for (const [key, v] of Object.entries(mat)) { if (surface && paramValue(surface.params, key) !== undefined) surface = { ...surface, params: withParam(surface.params, key, v) }; else rest[key] = v; }
  return { material: material({ ...n.mesh.defaults, ...n.options, ...n.__mat, ...rest }), surface, __mat: { ...n.__mat, ...rest }, __code: n.__code ?? n.material };
}

/** The scene's own value of k (SCENE): the renderer's where the scene sets none (a backdrop it does not set: null, the sky). */
export function sceneValue(s, k) {
  if (k === 'exposure') return s?.view?.exposure ?? 1;
  if (k === 'transform') return s?.view?.transform ?? 'agx';
  if (k === 'bloom' || k === 'vignette') return s?.post?.[k] ?? 0;
  const e = s?.environment, b = e?.backdrop;
  if (k === 'backdrop') return (b && typeof b === 'object' && !Array.isArray(b) ? b.color : b) ?? null;
  return e?.[k] ?? ENVIRONMENT[k] ?? null;
}
/** The scene with the overrides on it (`on: { scene: true }`) at t: its view, post and environment as they set them. */
export function applyScene(scene, overrides, t, codeScene = null) {
  const list = (overrides ?? []).filter((o) => o?.on?.scene);
  if (!list.length || !scene) return scene;
  const view = { ...scene.view }, post = { ...scene.post }, environment = { ...scene.environment };
  for (const o of list) for (const [k, p] of Object.entries(o.props ?? {})) {
    if (SCENE_NUMBERS.includes(k)) {
      if (!numeric(p)) continue;
      const v = laneValue(o.id, k, p, sceneValue(scene, k), t, (tt) => (codeScene ? sceneValue(codeScene(tt), k) : null));
      if (k === 'exposure') view.exposure = v; else if (k === 'intensity') environment.intensity = v; else post[k] = v;
    } else if (k === 'transform') {
      if (typeof p === 'string') view.transform = p;
    } else if (SCENE_COLOURS.includes(k)) {
      const c = keyed(p) ? valueAt(p, t) : p;
      if (typeof c !== 'string' && !Array.isArray(c)) continue;
      // (a backdrop with glows keeps them: its colour is set)
      const b = environment.backdrop;
      if (k === 'backdrop') environment.backdrop = b && typeof b === 'object' && !Array.isArray(b) ? { ...b, color: c } : c;
      else environment[k] = c;
    }
  }
  return { ...scene, view, post, environment };
}

/** The film's camera with the overrides on it (`on: { camera: true }`) at t; codeCamera(t): the code's at another moment. */
export function applyCamera(camera, overrides, t, codeCamera = null) {
  const list = (overrides ?? []).filter((o) => o?.on?.camera);
  if (!list.length || !camera) return camera;
  const c = { ...camera };
  for (const o of list) for (const [k, v] of Object.entries(o.props ?? {})) {
    if (!CAMERA.includes(k) || !numeric(v)) continue;
    c[k] = laneValue(o.id, k, v, cameraValue(camera, k), t, (tt) => (codeCamera ? cameraValue(codeCamera(tt), k) : null));
  }
  return c;
}
