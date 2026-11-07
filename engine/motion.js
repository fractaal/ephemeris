// Motion: a value over time as a stack of operators, each working on what the ones below it give — what a film's code
// writes, and what the editor shows as lanes (one per operator) and lets you change by hand over it (see the manual,
// docs/manual/motion.md). The operators, from the bottom up:
//   base    where it starts: motion(62)
//   rate    grows steadily, so much a second: .rate(40) (a rig's drift)
//   moves   .to(t, dur, v) eases from what is below to land on v as it ends (Aim: whatever is below it, which keeps
//           moving through and after it); .by(t, dur, dv) eases by an amount (Add). A run of moves is one lane, each
//           sized against the ones before it
//   keys    .keys([[t, v], …], { mode }): values at times, eased into each (glide, or the key's own ease). Add: offsets
//           on what is below; Aim: lands on each; Replace: its own values over its keys' span (one key: everywhere),
//           blended by its influence; Multiply
//   wander  .wander(amp, { speed }): a slow wobble
//   hits    .hits(list, { amount, attack, decay }): a pulse at each of a list of times ([{ t, vel }]: a part's notes as
//           the timeline plays them, engine/score.js hits()), rising over `attack` and falling away over `decay`, each
//           `amount` × its velocity
// A camera's rig() (camera.js) is one stack with a channel for each of its kind's (x, y, z, zoom kept as its logarithm,
// yaw, pitch, roll; a target camera's tx, ty, tz in place of yaw and pitch), each call naming the channels it moves. A motion placed as a value (MESH.at(0, motion(62).to(…), 0)) is
// evaluated at the scene's moment, and the thing placed remembers it, so the editor shows its lanes.
//
// The editor's changes (the timeline's overrides with a `stack`: see overrides.js) apply as a stack is evaluated:
// operators retimed, retargeted or switched to another mode, lanes reordered or turned off, lanes of your own added.
// Plain (no DOM, no packages): the editor evaluates the same stacks, with your changes, while you drag.
import { glide } from './ease.js';
import { basis } from './lens.js';
import { siteOf, here } from './site.js';

/** On a placed thing (a node, a copy, a camera pose): the motions its values came from, { prop: { stack, ch } }. */
export const STACKS = Symbol.for('ephemeris.stacks');
/** The moment the scene is being evaluated for (set by the runtime around a film's scene(t)): what placed motions take. */
export const clock = { t: 0 };
let used = false;   // (no motion yet: placing things checks nothing)
export const motionsUsed = () => used;

// ---------------------------------------------------------------- eases, by name (the editor writes names)
/** A swish's two sides (camera.js swishShape): out of its scene it gathers speed (0 → 1); into the next it arrives at
 *  that speed and settles (−1 → 0). */
export const swishOut = (p) => p ** 4, swishIn = (p) => -((1 - p) ** 4);
const EASES = new Map([['glide', glide], ['lin', (x) => x], ['swishOut', swishOut], ['swishIn', swishIn]]);
for (const [k, f] of EASES) f.easeName ??= k;
/** Names a film's eases (time.js's E), so the editor's changes can name them and its lanes show them. */
export function registerEases(E) {
  for (const [k, f] of Object.entries(E)) if (typeof f === 'function') { if (k !== 'glide') EASES.set(k, f); f.easeName ??= k; }
}
export const easeOf = (e) => (typeof e === 'function' ? e : EASES.get(e) ?? glide);
export const easeName = (e) => (typeof e === 'string' ? e : e?.easeName ?? 'custom');
// an ease of the film's own (a function no name is known for), as plain data: its values at 1024 even steps, and back
// (straight between them: within about 1e-6 of a smooth ease's move), so the editor's copy moves as the code's does
const CURVE = 1024;
const curveOf = (f) => (typeof f === 'function' && !f.easeName ? Array.from({ length: CURVE + 1 }, (_, i) => f(i / CURVE)) : null);
function fromCurve(c) {
  const f = (x) => { const u = Math.min(1, Math.max(0, x)) * CURVE, i = Math.min(CURVE - 1, Math.floor(u)); return c[i] + (c[i + 1] - c[i]) * (u - i); };
  f.easeName = 'custom';
  return f;
}
export const easeNames = () => [...EASES.keys()];
const ramp = (t, m) => easeOf(m.ease)(Math.min(1, Math.max(0, (t - m.t) / m.dur)));

// ---------------------------------------------------------------- the timeline's changes to stacks
let OV = new Map(), version = 0;
/** The timeline's overrides (those with a `stack` change the code's motions); stacks solve again after a change. */
export function setOverrides(list) { OV = new Map((list ?? []).filter((o) => o?.stack).map((o) => [o.stack, o])); version++; }

// keys as the code or the editor writes them ([t, v, ease] or { t, v, ease }), in time order
export const keysOf = (ks) => (ks ?? []).map((k) => (Array.isArray(k) ? { t: k[0], v: k[1], ease: k[2] ?? 'glide' } : { t: k.t, v: k.v, ease: k.ease ?? 'glide' })).sort((a, b) => a.t - b.t);
// the value at t of keys `K` carrying `vals`: eased into each key, held before the first and after the last
function interp(K, vals, t) {
  const n = K.length;
  if (t <= K[0].t) return vals[0];
  if (t >= K[n - 1].t) return vals[n - 1];
  let j = 1;
  while (K[j].t < t) j++;
  const a = K[j - 1], b = K[j];
  return vals[j - 1] + (vals[j] - vals[j - 1]) * easeOf(b.ease)((t - a.t) / (b.t - a.t || 1));
}
// a slow wobble, about −1 to 1
const smooth = (x) => 0.62 * Math.sin(2 * Math.PI * 0.9 * x + 1.1) + 0.38 * Math.sin(2 * Math.PI * 1.7 * x + 0.3);
const SWISHED = ['x', 'y', 'z', 'tx', 'ty', 'tz', 'roll'];
// the field an operator keeps its per-channel values in
const FIELD = { rate: 'rate', wander: 'amp', keys: 'keys', hits: 'amp' };
const touches = (op, ch) => (op.kind === 'move' ? (op.mode === 'swish' ? SWISHED.includes(ch) : (op.to ?? op.by)?.[ch] !== undefined) : op[FIELD[op.kind]]?.[ch] !== undefined);

// an operator as the timeline changes it (x: its entry in the stack's override `ops`)
function changedOp(op, x) {
  if (!x) return op;
  const e = { ...op, changed: true };
  if (x.shift != null) { e.t = op.t + x.shift; if (op.at != null) e.at = op.at + x.shift; }
  for (const k of ['dur', 'ease', 'mode', 'speed', 'influence', 'from', 'attack', 'decay']) if (x[k] != null) e[k] = x[k];
  for (const k of ['to', 'by', 'rate', 'amp']) if (x[k]) e[k] = { ...op[k], ...x[k] };
  if (x.keys) e.keys = { ...op.keys, ...Object.fromEntries(Object.entries(x.keys).map(([c, ks]) => [c, keysOf(ks)])) };
  return e;
}
// a lane of your own (the timeline's), on channel ch: as operators
function yoursLane(L, ch) {
  const kind = L.kind === 'move' ? 'moves' : L.kind;
  const ops = kind === 'moves'
    ? (L.moves ?? []).map((m, j) => ({ id: `${L.id}.${j}`, kind: 'move', k: j, mode: m.mode ?? (m.to != null ? 'aim' : 'add'), t: m.t, dur: m.dur, ease: m.ease ?? 'glide', ...(m.to != null ? { to: { [ch]: m.to } } : { by: { [ch]: m.by ?? 0 } }) }))
    : [{ id: L.id, kind, k: -1, mode: L.mode ?? 'add', influence: L.influence ?? 1, from: L.from ?? 0, speed: L.speed ?? 1, seed: L.seed ?? 0, wave: 'smooth',
      ...(kind === 'keys' ? { keys: { [ch]: keysOf(L.keys) } } : kind === 'rate' ? { rate: { [ch]: L.rate ?? 0 } } : { amp: { [ch]: L.amp ?? 0 } }) }];
  return { id: L.id, kind, src: 'yours', ops, muted: !!L.muted };
}

// A stack's id (what the timeline's changes to it name): its name, or the line that made it. Several made by one line
// (a loop's: a camera for each shot) or given one name are numbered in the order they are made (film.js:78:25,
// film.js:78:25#2, …): those made as the film sets up once, those made in a scene afresh each time a scene is
// evaluated (atMoment), as the editor numbers what one line places. A name keeps its changes when the code around it
// changes; a numbered one keeps them while the line makes them in the same order.
let made = 0, setup = new Map(), inScene = null;
const numbered = (at) => { const n = inScene ?? setup, k = (n.get(at) ?? 0) + 1; n.set(at, k); return k === 1 ? at : `${at}#${k}`; };
/** Evaluates fn as the scene at t: motions placed as values take its moment, and those it makes are numbered afresh. */
export function atMoment(t, fn) {
  const was = clock.t, counts = inScene;
  clock.t = t; inScene = new Map();
  try { return fn(); } finally { clock.t = was; inScene = counts; }
}
/**
 * A value over time: a base and the operators chained on it, in channel space (a channel kept as a logarithm takes
 * logarithms). channels: its names (['value'] for motion()); log: those kept as logarithms; t0: when its rates start;
 * code(t): a base the code computes (a placed thing's plain value, under your lanes); local: overrides of its own
 * (a placed thing's lanes), in place of the timeline's for its id; name: what the film calls it (its id).
 */
export class Stack {
  constructor(base, { channels = ['value'], log = [], t0 = 0, stack = null, code = null, local = null, id = null, fixed = null, name = null } = {}) {
    used = true;
    this.site = siteOf(stack);
    this.name = name;
    this.id = id ?? (name != null || this.site ? numbered(name ?? this.site.at) : `stack:${++made}`);
    this.channels = channels;
    this.log = new Set(log);
    this.t0 = t0;
    this.fixed = fixed;   // (what every pose of it says beside its channels: a camera's kind)
    this.base = Object.fromEntries(channels.map((c) => [c, base?.[c] ?? 0]));
    this.code = code;
    this.local = local;
    this.ops = [];
    this._v = -1;
  }
  // ---------- the chain (a motion's: plain values; a rig's: objects naming channels)
  _chs(x) { return x !== null && typeof x === 'object' && !Array.isArray(x) ? x : { [this.channels[0]]: x }; }
  _op(kind, fields, stack) {
    const site = siteOf(stack), at = site?.at ?? `${this.id}#op${this.ops.length}`;
    let id = at;
    for (let n = 2; this.ops.some((o) => o.id === id); n++) id = `${at}#${n}`;
    this.ops.push({ id, site, kind, k: this.ops.length, ...fields });
    this._v = -1;
    return this;
  }
  /** Grows steadily, so much a second, from `from` (the stack's start). */
  rate(r, { from = this.t0, top = false } = {}) { return this._op('rate', { rate: this._chs(r), from, top }, here()); }
  /** Eases from what is below, starting at t, to land on `target` at t + dur. */
  to(t, dur, target, ease = glide) { return this._op('move', { mode: 'aim', t, dur, ease, to: this._chs(target) }, here()); }
  /** Eases by `amount` from t over dur. */
  by(t, dur, amount, ease = glide) { return this._op('move', { mode: 'add', t, dur, ease, by: this._chs(amount) }, here()); }
  /** Values at times ([[t, v, ease?], …], or { channel: […] }): mode add (offsets), aim, replace or multiply. */
  keys(list, { mode = 'add', influence = 1 } = {}) {
    return this._op('keys', { mode, influence, keys: Object.fromEntries(Object.entries(this._chs(list)).map(([c, ks]) => [c, keysOf(ks)])) }, here());
  }
  /** A slow wobble of `amp` (speed: how fast; seed: where in it). */
  wander(amp, { speed = 1, seed = 0, wave = 'smooth', top = false } = {}) { return this._op('wander', { amp: this._chs(amp), speed, seed, wave, top }, here()); }
  /** A pulse at each of `list`'s times ([{ t, vel }], a part's notes: score.js hits()): `amount` × its velocity at its
   *  peak, `attack` s after it, falling away over `decay` s (to a third of it in each). */
  hits(list, { amount = 1, attack = 0.005, decay = 0.25, top = false } = {}) {
    const times = (list ?? []).map((h) => [h.t, h.vel ?? 1]).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
    return this._op('hits', { times, amp: this._chs(amount), attack, decay, top }, here());
  }
  /** (a rig's swish: a move whose size is the screen travel `px` turned into the world, where the camera is at `at`) */
  _swish(t, dur, ease, at, px, roll, stack) { return this._op('move', { mode: 'swish', t, dur, ease, at, px, roll }, stack); }

  // ---------- lanes
  _ov() { return this.local ?? OV.get(this.id) ?? null; }
  _sync() { if (this._v !== version) { this._v = version; this._lanes = new Map(); this._d = new Map(); this._aims = new Map(); this._sw = new Map(); this._sums = new Map(); } }
  /** A channel's lanes as the code writes them: its base, an operator each (a run of moves as one), those kept on top last. */
  codeLanes(ch) {
    const out = [{ id: 'base', kind: this.code ? 'code' : 'base', src: 'code', ops: [] }], top = [];
    for (const op of this.ops) {
      if (!touches(op, ch)) continue;
      const last = out[out.length - 1];
      if (op.kind === 'move' && last.kind === 'moves' && !op.top) last.ops.push(op);
      else (op.top ? top : out).push({ id: op.id, kind: op.kind === 'move' ? 'moves' : op.kind, src: 'code', ops: [op] });
    }
    return [...out, ...top];
  }
  /** A channel's lanes as they apply: the code's (each operator as the timeline changes it) and yours, in order. */
  lanes(ch) {
    this._sync();
    let L = this._lanes.get(ch);
    if (L) return L;
    const o = this._ov(), ops = o?.ops ?? {};
    L = [...this.codeLanes(ch).map((l) => ({ ...l, ops: l.ops.map((op) => changedOp(op, ops[op.id])) })), ...(o?.lanes?.[ch] ?? []).map((x) => yoursLane(x, ch))];
    const order = o?.order?.[ch];
    if (order) {
      const by = new Map(L.map((l) => [l.id, l])), first = order.map((id) => by.get(id)).filter((l) => l && l.id !== 'base');
      L = [L[0], ...first, ...L.slice(1).filter((l) => !first.includes(l))];
    }
    const muted = new Set(o?.muted?.[ch] ?? []);
    L = L.map((l) => ({ ...l, muted: l.muted || muted.has(l.id) }));
    this._lanes.set(ch, L);
    return L;
  }

  // ---------- evaluating
  /**
   * Channel ch at t: its lanes below lane `upto`, and of lane `upto` (a run of moves) those moves made before chain
   * place k (what a move is sized against); the whole stack by default.
   */
  value(ch, t, upto = Infinity, k = Infinity) {
    const L = this.lanes(ch), o = this._ov();
    let v = 0;
    for (let i = 0; i < L.length && i <= upto; i++) {
      const lane = L[i], partial = i === upto;
      if (partial && lane.kind !== 'moves') break;
      if (lane.kind === 'base') { v = o?.base?.[ch] ?? this.base[ch]; continue; }
      if (lane.kind === 'code') { v = this.code(t); continue; }
      if (lane.muted) continue;
      const op = lane.ops[0];
      switch (lane.kind) {
        case 'rate': v = v + op.rate[ch] * (t - op.from); break;
        case 'wander': v = this._wander(op, ch, v, t); break;
        case 'hits': v += this._hits(op, ch, t); break;
        case 'keys': v = this._keys(ch, L, i, op, v, t); break;
        case 'moves': {
          const d = this._solve(ch, L, i), kmax = partial ? k : Infinity;
          lane.ops.forEach((m, j) => { if (m.k < kmax) v += d[j] * ramp(t, m); });
          break;
        }
      }
    }
    return v;
  }
  /** Channel ch as it was when the chain's operator k was called (what a swish turns its travel by). */
  before(ch, t, k) {
    const L = this.lanes(ch), i = L.findIndex((l) => l.kind === 'moves' && l.ops.some((m) => m.k >= k));
    return i < 0 ? this.value(ch, t) : this.value(ch, t, i, k);
  }
  _wander(op, ch, v, t) {
    const wave = typeof op.wave === 'object' ? op.wave[ch] : op.wave, a = op.amp[ch];
    // (a rig's float: a handheld wander of so many screen px, so world px divided by the zoom)
    if (wave === 'float-x') return v + Math.sin(t * 0.7 + 1.3) * (a / Math.exp(this.value('zoom', t)));
    if (wave === 'float-y') return v + Math.cos(t * 0.53) * (a / Math.exp(this.value('zoom', t))) * 0.75;
    return v + a * smooth(t * op.speed + op.seed);
  }
  // the pulses sounding at t: the hits before it, back to where the last has died away
  _hits(op, ch, t) {
    const H = op.times, a = Math.max(1e-4, op.attack ?? 0.005), d = Math.max(1e-4, op.decay ?? 0.25), amount = op.amp[ch] ?? 0;
    let lo = 0, hi = H.length - 1, i = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (H[m][0] <= t) { i = m; lo = m + 1; } else hi = m - 1; }
    let sum = 0;
    for (; i >= 0; i--) {
      const dt = t - H[i][0];
      if (dt > a + 10 * d) break;
      sum += H[i][1] * (dt < a ? dt / a : Math.exp(-(dt - a) / d));
    }
    return amount * sum;
  }
  _keys(ch, L, i, op, v, t) {
    const K = op.keys[ch];
    if (!K?.length) return v;
    if (op.mode === 'add') return v + interp(K, K.map((q) => q.v), t);
    if (op.mode === 'multiply') return v * interp(K, K.map((q) => q.v), t);
    if (op.mode === 'aim') {
      const key = `${ch}|${L[i].id}`;
      let offs = this._aims.get(key);
      if (!offs) { offs = K.map((q) => q.v - this.value(ch, q.t, i, -Infinity)); this._aims.set(key, offs); }
      return v + interp(K, offs, t);
    }
    if (K.length > 1 && (t < K[0].t || t > K[K.length - 1].t)) return v;
    const own = interp(K, K.map((q) => q.v), t), w = op.influence ?? 1;
    return w === 1 ? own : v + (own - v) * w;
  }
  // each move's size in lane i: a .to() lands on its target against what is below and the moves before it; a .by()
  // is its amount; a swish turns its screen travel into the world where the camera is then
  _solve(ch, L, i) {
    const key = `${ch}|${L[i].id}`;
    let d = this._d.get(key);
    if (d) return d;
    this._d.set(key, (d = []));   // (filled in order: each move is sized against the ones before it)
    L[i].ops.forEach((m, j) => {
      if (m.mode === 'add') d[j] = m.by?.[ch] ?? 0;
      else if (m.mode === 'swish') d[j] = this._swished(m)[ch] ?? 0;
      else d[j] = m.to?.[ch] === undefined ? 0 : m.to[ch] - this.value(ch, m.t + m.dur, i, m.k);
    });
    return d;
  }
  _swished(m) {
    let w = this._sw.get(m.id);
    if (w) return w;
    const c = Object.fromEntries(this.channels.map((ch) => [ch, this.before(ch, m.at, m.k)]));
    const pose = this.pose(c), B = basis(pose), k = 1 / pose.zoom;
    const v = [0, 1, 2].map((a) => (B.right[a] * m.px[0] + B.down[a] * m.px[1]) * k);
    // (what a target camera faces moves with it: a whip pans, it does not turn)
    this._sw.set(m.id, (w = { x: v[0], y: v[1], z: v[2], tx: v[0], ty: v[1], tz: v[2], roll: m.roll }));
    return w;
  }
  /** Channel values (channel space) as values: logarithms back to what they are. */
  pose(c) { const out = this.fixed ? { ...this.fixed } : {}; for (const ch of this.channels) out[ch] = this.log.has(ch) ? Math.exp(c[ch]) : c[ch]; return out; }
  /** The value at t (a motion's), or every channel's (a rig's, as values). */
  at(t) {
    if (this.channels.length === 1) return this.value(this.channels[0], t);
    const c = {};
    for (const ch of this.channels) c[ch] = this.value(ch, t);
    return this.pose(c);
  }
  /**
   * Its value added up from 0 to t (a motion's: how far a speed has gone, how far a spin rate has turned; a rig's
   * channel ch), from its values every 1/240 s, straight between them. Kept until the timeline's changes to it change,
   * so a scene can ask it at every moment for what the whole motion so far adds up to.
   */
  integral(t, ch = this.channels[0]) {
    this._sync();
    let S = this._sums.get(ch);
    if (!S) this._sums.set(ch, (S = { v: new Float64Array(1024), s: new Float64Array(1024), n: 1 })), (S.v[0] = this.value(ch, 0));
    if (t <= 0) return S.v[0] * t;
    // (the table, to past t: its values and their sums so far, grown as later moments are asked for)
    const h = 1 / 240, i = Math.floor(t / h);
    if (i + 2 > S.n) {
      const n = Math.max(i + 2, S.n * 2);
      if (n > S.v.length) { const v = new Float64Array(n), s = new Float64Array(n); v.set(S.v); s.set(S.s); S.v = v; S.s = s; }
      for (let k = S.n; k < n; k++) { S.v[k] = this.value(ch, k * h); S.s[k] = S.s[k - 1] + ((S.v[k - 1] + S.v[k]) * h) / 2; }
      S.n = n;
    }
    const u = t - i * h, a = S.v[i], b = S.v[i + 1];
    return S.s[i] + a * u + ((b - a) * u * u) / (2 * h);
  }
  /** What lane i of channel ch adds at t (what the stack is with it, less what it is without). */
  adds(ch, i, t) { return this.value(ch, t, i + 1, -Infinity) - this.value(ch, t, i, -Infinity); }

  // ---------- for the editor
  /** The code's stack as plain data (operators as the code writes them, eases by name). */
  describe() {
    const ease = (e) => { const c = curveOf(e); return { ease: easeName(e), ...(c && { curve: c }) }; };
    const plain = (op) => {
      const { site, ease: e, keys, ...rest } = op;
      return { ...rest, line: site?.line ?? null, file: site?.file ?? null, ...(e !== undefined && ease(e)),
        ...(keys && { keys: Object.fromEntries(Object.entries(keys).map(([c, ks]) => [c, ks.map((q) => ({ ...q, ...ease(q.ease) }))])) }) };
    };
    return { id: this.id, ...(this.name != null && { name: this.name }), file: this.site?.file ?? null, line: this.site?.line ?? null, channels: this.channels, log: [...this.log], t0: this.t0, base: this.base, ...(this.fixed && { fixed: this.fixed }), ops: this.ops.map(plain) };
  }
  /** A described stack again (the editor's copy: evaluated with the timeline's changes while you drag). */
  static from(d, o = {}) {
    const s = new Stack(d.base, { channels: d.channels, log: d.log, t0: d.t0, id: d.id, fixed: d.fixed ?? null, name: d.name ?? null, ...o });
    s.site = d.file ? { file: d.file, line: d.line, at: d.id } : null;
    const ease = ({ curve, ...q }) => (curve ? { ...q, ease: fromCurve(curve) } : q);
    s.ops = d.ops.map((op) => ({ ...ease(op), site: op.file ? { file: op.file, line: op.line, at: op.id } : null,
      ...(op.keys && { keys: Object.fromEntries(Object.entries(op.keys).map(([c, ks]) => [c, ks.map(ease)])) }) }));
    return s;
  }
}

/**
 * A placed thing's change of a plain property (an override's props[k]) as lanes over the code's value: { lanes,
 * order?, muted? } as is; a value or keyframes [{ t, v }] as first written, as one lane of keys (position and turn
 * added to the code's, scale multiplying it, the rest in place of it).
 */
export function asLanes(k, p) {
  if (p && typeof p === 'object' && !Array.isArray(p) && Array.isArray(p.lanes)) return p;
  const keyed = Array.isArray(p) && p.length > 0 && typeof p[0] === 'object' && p[0] && 't' in p[0];
  return { lanes: [{ id: 'v', kind: 'keys', mode: ['x', 'y', 'z', 'rx', 'ry', 'rz'].includes(k) ? 'add' : k === 's' ? 'multiply' : 'replace', keys: keyed ? p.map((q) => [q.t, q.v]) : [[0, p]], ...(!keyed && { static: true }) }] };
}

/**
 * A value over time, from `base`: chain .rate(), .to(), .by(), .keys(), .wander() on it, and place it as a value.
 * `name`: what the timeline's changes to it are kept by (else the line that makes it; numbered where one line makes
 * several, as a loop does).
 */
export function motion(base = 0, { name = null } = {}) { return new Stack({ value: base }, { stack: here(), name }); }
export const isMotion = (v) => v instanceof Stack;

/**
 * A placed thing's values now: each motion among them evaluated at the scene's moment, and remembered (`from`: prop →
 * { stack, ch }). Values that are not motions pass through.
 */
export function settle(o, from) {
  let out = o;
  for (const k in o) {
    const v = o[k];
    if (!(v instanceof Stack)) continue;
    if (out === o) out = { ...o };
    out[k] = v.at(clock.t);
    from[k] = { stack: v, ch: v.channels[0] };
  }
  return out;
}
