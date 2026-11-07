// Motion lanes, in the timeline under the cues: what the film camera's properties and the selection's are made of, and
// the selected notes clip's instrument's (its automated parameters, whatever plays it: your lanes over each one's base, its value in the
// instrument's state, kept on the audio track: automation.js).
// Each property is drawn as the film renders it, wherever the playhead is: a row with its total curve, and opened, a
// lane per operator (engine/motion.js), applied from the bottom up, top first. What gives a property can change over
// the film — a camera for each shot (a rig each), the code computing it in one scene, a thing not in the scene — so it
// is made of parts, each over its own stretch of the timeline (api/lanes: what gives it at every frame and cut): a
// motion's operators sit in its stretch, in lanes shared with the parts that have them (each shot's Rate in one Rate
// lane, shot by shot); a value the code computes some other way is the Code lane there (its values at each frame, from
// the same answer),
// and what the code does to the camera after its rig (a shake) is a Code lane over it. Yours are the timeline's
// overrides: on a motion (its operators changed, its lanes reordered or off, lanes of your own in it), or over the
// thing's own value, for the whole film. They are evaluated here with the engine's own code as you make them, so a
// curve follows a drag; the film renders them once saved. A change at a moment goes to the part that gives the
// property then; a lane's head changes it in every part it is in.
import { icon } from './icons.js';
import { Stack, setOverrides, keysOf, asLanes, easeName, easeOf } from '/files/engine/motion.js';
import '/files/engine/time.js';   // (names the film's eases, so lanes show them and your changes can choose them)
import { clipLanes, paramAt } from './automation.js';
import { clipEnd, speedOf, automatedKeys, notesClips, INSTRUMENT } from './model.js';

const KIND = { base: 'Base', code: 'Code', rate: 'Rate', moves: 'Moves', keys: 'Keys', wander: 'Wander', hits: 'Hits' };
// a lane's name, where it shows (an instrument's base is its preset's value, not the code's)
const kindName = (P, l) => (l.kind === 'code' && P.th.instrument ? (P.clipped ? 'Clips' : 'Preset') : KIND[l.kind]);
// a property's name, unit, and whether its graph draws up as the value falls (y: up the screen)
const PROP = {
  x: ['X', 'px'], y: ['Y', 'px'], z: ['Z', 'px'], rx: ['Rotate X', '°'], ry: ['Rotate Y', '°'], rz: ['Rotate Z', '°'], s: ['Scale', '×'], opacity: ['Opacity', ''],
  tx: ['Target X', 'px'], ty: ['Target Y', 'px'], tz: ['Target Z', 'px'], zoom: ['Zoom', '×'], yaw: ['Yaw', '°'], pitch: ['Pitch', '°'], roll: ['Roll', '°'],
  metallic: ['Metallic', ''], roughness: ['Roughness', ''], ior: ['IOR', ''], transmissionWeight: ['Transmission', ''], coatWeight: ['Coat', ''],
  sheenWeight: ['Sheen', ''], iridescence: ['Iridescence', ''], dispersion: ['Dispersion', ''], thinFilmThickness: ['Thin film', 'nm'], normalStrength: ['Normal strength', ''],
  sx: ['Scale X', '×'], sy: ['Scale Y', '×'], sz: ['Scale Z', '×'], emissionStrength: ['Emission', ''],
  intensity: ['Intensity', ''], radius: ['Radius', 'px'], angle: ['Cone', '°'], soft: ['Soft edge', ''], range: ['Range', 'px'],
};
// the scene's own numbers (the inspector's Scene, with nothing selected), named as the editor says them
const SCENE_PROP = { exposure: ['Exposure', '×'], bloom: ['Bloom', ''], vignette: ['Vignette', ''], intensity: ['Sky intensity', '×'] };
const MODES = { add: 'Add', aim: 'Aim', replace: 'Replace', multiply: 'Multiply' };
const SAY = {
  base: 'Where the code starts it.',
  code: 'The value from the code. Your lanes work on top of it.',
  after: 'What the code adds after its motion (a shake, a kick). Change it in the code.',
  rate: 'Grows at a steady rate, like a drift or a spin.',
  wander: 'A slow wobble, like a handheld camera.',
  hits: 'A pulse on each note a part plays, rising and falling away.',
  aim: 'Each move lands on its target.',
  add: 'Each move adds its amount.',
  swish: 'A whip pan across a cut. Drag it to retime it.',
  keys: { add: 'Its keys add to what is below.', aim: 'Lands on each key’s value.', replace: 'Its own values, ignoring what is below.', multiply: 'Scales what is below.' },
};
// properties that are one vector: a row of their own whose keys are all of theirs at once, opened to each of them
const VEC = [['pos', 'Position', ['x', 'y', 'z']], ['rot', 'Rotation', ['rx', 'ry', 'rz']], ['scale', 'Scale', ['sx', 'sy', 'sz']], ['turn', 'Rotation', ['yaw', 'pitch', 'roll']], ['target', 'Target', ['tx', 'ty', 'tz']]];
const AXIS = ['#f07878', '#8fd77f', '#78a2f5'];   // (each part of a vector's colour: X, Y, Z as the viewer's axes)
const GAP = 2, DEF_H = { mthing: 24, mprop: 44, mlane: 26 }, MIN_H = { mprop: 34, mlane: 22 }, MAX_H = 360;
const ACCENT = '140,195,252', accent = (a = 1) => `rgba(${ACCENT},${a})`, CODE = '#8a94a3';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const fx = (v, d = 2) => String(+(+v).toFixed(d)).replace(/^-/, '−');
const sgn = (v, d = 2) => (v > 0 ? '+' : '') + fx(v, d);
const ICON = {
  scene: '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/>',
  base: '<path d="M2 8h12"/>', code: '<path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4"/>', rate: '<path d="M2.5 13L13.5 3"/>',
  wander: '<path d="M1.5 8c1.6-4.5 3.4-4.5 5 0s3.4 4.5 5 0 2.3-3 3-1.5"/>', moves: '<path d="M2 12.5C6.5 12.5 7.5 4 12 4"/><path d="M12 1.6l2.4 2.4-2.4 2.4-2.4-2.4z" fill="currentColor" stroke="none"/>',
  keys: '<path d="M4.5 4.8l2.3-2.3 2.3 2.3-2.3 2.3zM9 11.2l2.3-2.3 2.3 2.3-2.3 2.3z"/>',
  hits: '<path d="M1.5 13h1.5l1-9 3 9h1l1-9 3 9h2.5"/>', camera: '<rect x="1.5" y="4.5" width="9" height="7" rx="1"/><path d="M10.5 7l4-2v6l-4-2"/>',
  mesh: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11"/>', layer: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/>', eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
  eyeoff: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><path d="M2.5 13.5l11-11"/>', key: '<path d="M8 3l5 5-5 5-5-5z"/>', plus: '<path d="M8 3v10M3 8h10"/>',
  handle: '<circle cx="6" cy="4" r="1" fill="currentColor"/><circle cx="10" cy="4" r="1" fill="currentColor"/><circle cx="6" cy="8" r="1" fill="currentColor"/><circle cx="10" cy="8" r="1" fill="currentColor"/><circle cx="6" cy="12" r="1" fill="currentColor"/><circle cx="10" cy="12" r="1" fill="currentColor"/>',
  twirl: '<path d="M5 3l6 5-6 5z" fill="currentColor" stroke="none"/>',
  instrument: '<circle cx="8" cy="8" r="5.5"/><path d="M8 8l2.6-2.6"/>',
};
const THING = { mesh: 'cube', layer: 'square', title: 'text-t', light: 'lightbulb', pass: 'stack', camera: 'video-camera', scene: 'sun-horizon' };
const ic = (k) => (THING[k] ? icon(THING[k], false, 'mi') : `<svg class="mi" viewBox="0 0 16 16" aria-hidden="true">${ICON[k]}</svg>`);
// a code part's one lane (the value the code computes there), and what the code does to the camera after its rig
const CODED = { id: 'base', kind: 'code', src: 'code', ops: [] }, AFTER = { id: 'after', kind: 'code', src: 'code', ops: [] };

export function createLanes(api) {
  const { S } = api;
  // what is shown: the camera, and the selection (the object picked in the viewer)
  // (tracks: the tracks whose motion shows, by project/timeline: this machine's view, as the lanes' heights are)
  const M = { things: [], show: 'animated', sel: null, picks: new Set(), heights: {}, scale: 1, version: 0, curves: new Map(), stacks: new Map(), tracks: {} };
  try { const k = JSON.parse(localStorage.getItem('nle:lanes') || '{}'); M.show = k.show ?? M.show; M.scale = k.scale ?? 1; M.heights = k.heights ?? {}; M.tracks = k.tracks ?? {}; } catch {}
  const keep = () => { try { localStorage.setItem('nle:lanes', JSON.stringify({ show: M.show, scale: M.scale, heights: M.heights, tracks: M.tracks })); } catch {} };
  const shownHere = () => M.tracks[`${S.name}/${S.timeline}`] ?? [];

  // ---------- the model. A thing (the camera, the selection, an instrument) has properties P; a property has parts C, each
  // over its stretch [t0, t1) — a motion (src 'stack': its stack, with your changes and without) or the code (src
  // 'code') — and, over the whole film, the thing's own lanes (P.own, src 'own': yours over its value). A C has what
  // a lane needs of its property (th, k, ch, label, unit, log), so the lanes' code works on either.
  const unitOf = (k) => PROP[k]?.[1] ?? '';
  const labelOf = (k) => PROP[k]?.[0] ?? k;
  // where a thing's own changes are (in d): the overrides' entry for the camera or a placed thing, { props: { k: … } };
  // an instrument's, its track's automation of it (as props); made where missing if `make`
  function thingStore(d, th, make = false) {
    if (th.instrument) {
      const t = d.tracks.find((x) => x.id === th.instrument.track);
      if (!t) return null;
      if (make) ((t.automation ??= {})[INSTRUMENT] ??= {});
      const a = t.automation?.[INSTRUMENT];
      return a ? { props: a } : null;
    }
    if (make) d.overrides ??= [];
    let o = (d.overrides ?? []).find((x) => (th.id === 'camera' ? x.on?.camera : th.id === 'scene' ? x.on?.scene : x.on && !x.on.camera && !x.on.scene && api.names(x.on, th.sel)));
    if (!o && make) d.overrides.push((o = { id: newIdIn(d), on: th.id === 'camera' ? { camera: true } : th.id === 'scene' ? { scene: true } : api.onOf(th.sel), props: {} }));
    if (o && make) o.props ??= {};
    return o ?? null;
  }
  const entryFor = (th) => thingStore(S.doc, th);
  const common = (P) => ({ P, th: P.th, k: P.k, label: P.label, unit: P.unit, invert: P.invert });
  // a track's instrument's properties: the parameters it has lanes for (each a constant base: its value in the
  // instrument, a plugin's in its state or its `set`), each named and its values read as the instrument says them. Where
  // a pattern on the track has lanes of its own for one (its clips': automation.js), each clip of it is a part over its
  // stretch, those lanes where it plays them (in the timeline's time), and between clips the value is held where the last
  // left it; the track's lanes (yours over the whole film) are over them
  function buildInstrument(th) {
    const old = new Map(th.props.map((P) => [P.k, P])), info = th.instrument;
    const track = S.doc.tracks.find((t) => t.id === info.track), media = S.doc.media;
    const notes = notesClips(track, media).sort((a, b) => a.at - b.at), parts = new Set(notes.map((c) => c.media));
    th.kind = 'instrument'; th.label = info.label;
    const code = (api.score?.()?.automation ?? []).filter((a) => parts.has(a.part));
    th.props = [...new Set([...automatedKeys(track, media), ...code.map((a) => a.key)])].map((k) => {
      const P = old.get(k) ?? { th, k, open: false, samples: null }, base = info.base(k), mine = code.find((a) => a.key === k);
      const clips = notes.filter((c) => media[c.media].automation?.[k]?.lanes?.length);
      Object.assign(P, { label: info.title?.(k) ?? k, unit: '', log: false, invert: false, codeNow: base, varies: false, clipped: clips.length > 0 });
      // the sound code's motion of it (sound.js): one part over the whole film, its operators the code's (your changes to
      // them, and your lanes on it, in the timeline's overrides by its id), on what the clips' lanes give
      if (mine) { P.parts = [{ ...common(P), log: false, ch: 'value', src: 'stack', id: mine.desc.id, desc: mine.desc, key: `${mine.desc.id}@-Infinity`, t0: -Infinity, t1: Infinity, below: paramAt({ ...track, automation: null }, media, k, base) }]; return P; }
      const hold = (t0, t1, v) => ({ ...common(P), log: false, ch: 'value', src: 'code', key: `code@${t0}`, t0, t1, v });
      if (!clips.length) { P.parts = [hold(-Infinity, Infinity, base)]; return P; }
      const parts = [], local = (p) => ({ lanes: { value: p.lanes }, ...(p.order && { order: { value: p.order } }), ...(p.muted && { muted: { value: p.muted } }) });
      clips.forEach((c, i) => {
        const cp = media[c.media].automation[k], t1 = Math.min(clipEnd(c), clips[i + 1]?.at ?? Infinity), id = `clip:${c.media}|${k}`;
        const C = { ...common(P), log: false, ch: 'value', src: 'clip', id, key: `clip:${c.id}`, clip: c, medium: c.media, t0: c.at, t1,
          stack: new Stack(null, { id, code: () => base, local: local(clipLanes(cp, c)) }), bare: new Stack(null, { id, code: () => base, local: {} }) };
        const at = (x) => C.stack.value('value', x);
        if (!i) parts.push(hold(-Infinity, c.at, at(c.at)));
        parts.push(C);
        const next = clips[i + 1]?.at ?? Infinity, held = at(c.at + (c.out - c.in) / speedOf(c));
        if (t1 < next) parts.push(hold(t1, next, held));
      });
      P.parts = parts;
      return P;
    });
  }
  // a thing as the film has it over its whole length (api/lanes): each property's runs as parts
  function build(th, r) {
    const old = new Map(th.props.map((P) => [P.k, P]));
    th.kind = r.kind; th.label = th.id === 'camera' ? 'Camera' : th.id === 'scene' ? 'Scene' : th.sel?.object || r.label || th.sel?.label || r.kind;
    th.props = r.props.map((p) => {
      const P = old.get(p.k) ?? { th, k: p.k, open: false, samples: null };
      const runs = p.runs.filter((x) => x.id !== false);   // (where it is in the scene)
      Object.assign(P, { label: th.id === 'scene' ? SCENE_PROP[p.k][0] : labelOf(p.k), unit: th.id === 'scene' ? SCENE_PROP[p.k][1] : unitOf(p.k), invert: p.k === 'y' && th.id !== 'camera', varies: p.varies, codeNow: null });
      P.log = runs.some((x) => x.id && r.stacks[x.id].log.includes(x.ch));
      // (the code's values at each frame, where it computes them or changes them after a motion)
      P.samples = p.vals ? { t: r.times, v: p.vals, d: p.d ?? null } : null;
      P.parts = runs.map((x) => {
        const desc = x.id ? r.stacks[x.id] : null, t0 = x.t0 <= 0 ? -Infinity : x.t0;
        return { ...common(P), t0, t1: x.t1 ?? Infinity, id: x.id, desc, ch: desc ? x.ch : 'value', src: desc ? 'stack' : 'code', log: !!desc && desc.log.includes(x.ch), after: x.after, v: x.v, key: `${x.id ?? 'code'}@${t0}` };
      });
      return P;
    });
  }
  // a stack from the film's description, one per motion or rig (shared by its channels and its parts), with and
  // without your changes
  // (below: what it works on, for a motion that starts from it: an instrument's parameter, under the sound code's)
  function stackOf(desc, below = null) {
    let s = M.stacks.get(desc.id);
    if (!s || s.src !== desc || s.below !== below) s = { src: desc, below, live: Stack.from(desc, below ? { code: below } : {}), bare: Stack.from(desc, { local: {}, ...(below && { code: below }) }) };
    M.stacks.set(desc.id, s);
    return s;
  }
  // your changes (the doc's overrides) into the stacks: after every edit, and as a drag goes
  function sync() {
    setOverrides(S.doc.overrides);
    for (const th of M.things) if (th.instrument) buildInstrument(th);   // (its parameters are those with lanes: a key added, one more)
    for (const th of M.things) {
      const e = entryFor(th);
      for (const P of th.props) {
        for (const c of P.parts) if (c.src === 'stack') { const s = stackOf(c.desc, c.below); c.stack = s.live; c.bare = s.bare; }
        // (yours over the thing's value, which is what its parts give: in values, a rig's zoom not as its logarithm)
        const L = asLanes(P.k, e?.props?.[P.k] ?? { lanes: [] }), code = (t) => fromP(P, segValue(P, t));
        P.own = { ...common(P), log: false, ch: 'value', src: 'own', key: 'own', t0: -Infinity, t1: Infinity,
          stack: new Stack(null, { id: `${th.id}|${P.k}`, code, local: { lanes: { value: L.lanes }, ...(L.order && { order: { value: L.order } }), ...(L.muted && { muted: { value: L.muted } }) } }) };
      }
    }
    M.version++; M.curves.clear();
  }

  // ---------- values, in the property's channel space (a rig's zoom: its logarithm)
  const toP = (P, v) => (P.log ? Math.log(v) : v), fromP = (P, v) => (P.log ? Math.exp(v) : v);
  const disp = (P, v) => (P.log ? Math.exp(v) : v);          // a channel value as it reads
  const store = (P, v) => (P.log ? Math.log(v) : v);
  const inSpan = (C, t) => t >= C.t0 && t < C.t1;
  // a part made of a stack: a motion's (the code's, with your changes), or a clip's (its pattern's lanes, yours)
  const stacked = (C) => C?.src === 'stack' || C?.src === 'clip';
  // whether part C shows its motion's key at t: the part whose stretch it is in, or, outside every stretch of that
  // motion, the nearest (a key put beyond where its motion shows still shapes the curve there, and can still be moved).
  // A clip's keys end with the clip
  function keyIn(P, C, t) {
    if (inSpan(C, t)) return true;
    if (C.src !== 'stack') return false;
    let near = null, gap = Infinity;
    for (const c of P.parts) {
      if (c.id !== C.id) continue;
      if (inSpan(c, t)) return false;
      const d = t < c.t0 ? c.t0 - t : t - c.t1;
      if (d < gap) { gap = d; near = c; }
    }
    return near === C;
  }
  // the part that gives P at t (none: it is not in the scene then)
  function partAt(P, t) {
    const ps = P.parts;
    let lo = 0, hi = ps.length - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ps[m].t0 <= t) { at = m; lo = m + 1; } else hi = m - 1; }
    return at >= 0 && t < ps[at].t1 ? ps[at] : null;
  }
  // the code's values at the film's frames (its value `f`: v, the code's; d, what it does after a motion), straight
  // between frames within the part at t; before the first frame and after the last, theirs
  function sampled(P, f, t) {
    const s = P.samples, c = partAt(P, t), vs = s?.[f], none = f === 'v' ? c?.v ?? NaN : 0;
    if (!vs?.length) return none;
    const n = s.t.length;
    if (t <= s.t[0] || t >= s.t[n - 1]) return vs[t <= s.t[0] ? 0 : n - 1] ?? none;
    let i = Math.min(n - 2, Math.max(0, Math.floor(((t - s.t[0]) / (s.t[n - 1] - s.t[0])) * (n - 1))));
    while (i > 0 && s.t[i] > t) i--;
    while (i < n - 2 && s.t[i + 1] < t) i++;
    const a = vs[i], b = vs[i + 1];
    if (c && s.t[i] < c.t0) return b ?? NaN;
    if (c && s.t[i + 1] >= c.t1) return a ?? NaN;
    if (a == null || b == null) return a ?? b ?? NaN;
    return a + (b - a) * ((t - s.t[i]) / (s.t[i + 1] - s.t[i] || 1));
  }
  // the code's value at t of a property it computes without a motion
  const codeAt = (P, t) => (P.th.instrument ? partAt(P, t)?.v ?? P.codeNow ?? 0 : sampled(P, 'v', t));
  const afterAt = (P, t) => sampled(P, 'd', t) ?? 0;
  // what the parts give at t (NaN where it is not in the scene): a motion's (with your changes on it), the code's
  function segValue(P, t, bare = false) {
    const c = partAt(P, t);
    if (!c) return NaN;
    if (!stacked(c)) return toP(P, codeAt(P, t));
    return (bare ? c.bare : c.stack).value(c.ch, t) + (c.after ? afterAt(P, t) : 0);
  }
  const hasOwn = (P) => P.own.stack.lanes('value').length > 1;
  // the property at t as the frame has it: what its parts give, and yours over the whole film on top
  function valueAt(P, t) {
    if (!hasOwn(P)) return segValue(P, t);
    return Number.isNaN(segValue(P, t)) ? NaN : toP(P, P.own.stack.value('value', t));
  }
  // as the code alone has it
  const bareAt = (P, t) => segValue(P, t, true);
  // the spans where it is not in the scene
  function outside(P) {
    if (P.out?.v === M.version) return P.out.list;
    const list = [];
    let at = -Infinity;
    for (const c of P.parts) { if (c.t0 > at) list.push([at, c.t0]); at = c.t1; }
    if (at < Infinity) list.push([at, Infinity]);
    P.out = { v: M.version, list };
    return list;
  }

  // ---------- lanes: each part's operators, by kind, in lanes shared across the parts (each shot's Rate in one), the
  // lowest the base (or the code's value), then yours over the whole film. A lane is { id, kind, src, cells }; a cell
  // is a part's own lane in it, { c, lane, i } (i: its place in the part's stack)
  function rowsOf(P) {
    if (P.rows?.v === M.version) return P.rows.list;
    const by = new Map(), order = [];
    const put = (key, cell, prev) => {
      if (!by.has(key)) { by.set(key, []); order.splice(prev == null ? 0 : order.indexOf(prev) + 1, 0, key); }
      by.get(key).push(cell);
    };
    for (const c of P.parts) {
      if (!stacked(c)) { put('base', { c, lane: CODED, i: 0 }, null); continue; }
      const n = {};
      let prev = null;
      c.stack.lanes(c.ch).forEach((lane, i) => {
        const g = `${lane.src}:${lane.kind}`, key = lane.id === 'base' ? 'base' : `${g}:${(n[g] = (n[g] ?? -1) + 1)}`;
        put(key, { c, lane, i }, prev);
        prev = key;
      });
    }
    const list = order.map((id) => ({ id, cells: by.get(id) }));
    const after = P.parts.filter((c) => c.src === 'stack' && c.after);
    if (after.length) list.push({ id: 'after', cells: after.map((c) => ({ c, lane: AFTER, i: -1 })) });
    P.own.stack.lanes('value').forEach((lane, i) => { if (i) list.push({ id: `own:${lane.id}`, cells: [{ c: P.own, lane, i }] }); });
    list.forEach((R, i) => {
      const L = R.cells.map((x) => x.lane);
      Object.assign(R, { i, kind: L.some((l) => l.kind === 'base') ? 'base' : L[0].kind, src: L[0].src, muted: L.every((l) => l.muted), own: R.id.startsWith('own:') });
    });
    P.rows = { v: M.version, list };
    return list;
  }
  const cellAt = (R, t) => R.cells.find((x) => inSpan(x.c, t)) ?? null;
  // a part's base, as it applies (the timeline may change it)
  const baseOf = (C) => C.stack.value(C.ch, 0, 1, -Infinity);
  // a lane in a word (a property's stack, bottom up)
  const rowWord = (P, R) => (R.id === 'after' ? 'code after' : R.id === 'base' ? (R.kind === 'code' ? (P.th.instrument ? 'preset' : 'code') : R.cells.length === 1 ? fx(disp(P, baseOf(R.cells[0].c))) : 'base') : KIND[R.kind].toLowerCase() + (R.src === 'yours' ? ' (yours)' : ''));
  // the lanes a change goes to, once each (a part in two stretches has its lanes once)
  const once = (cells) => [...new Map(cells.map((x) => [`${stacked(x.c) ? x.c.id : x.c.key}|${x.lane.id}`, x])).values()];
  // what a lane's cell adds at t, in the property's channel space (its base: where it starts)
  function cellValue(P, x, t) {
    if (x.lane === CODED) return toP(P, codeAt(P, t));
    if (x.lane === AFTER) return afterAt(P, t);
    if (x.lane.kind === 'base') return baseOf(x.c);
    if (x.c.src === 'own') { const s = x.c.stack; return toP(P, s.value('value', t, x.i + 1, -Infinity)) - toP(P, s.value('value', t, x.i, -Infinity)); }
    return x.c.stack.adds(x.c.ch, x.i, t);
  }
  const changedLane = (l) => l.src === 'yours' || l.muted || l.ops.some((op) => op.changed);
  const isChanged = (P) => rowsOf(P).some((R) => R.cells.some((x) => changedLane(x.lane))) || P.parts.some((c) => c.src === 'stack' && !!(S.doc.overrides ?? []).find((o) => o.stack === c.id && (o.order?.[c.ch] || o.base?.[c.ch] != null)));
  const animated = (P) => rowsOf(P).length > 1 || P.varies;
  const shownProps = (th) => th.props.filter((P) => M.show === 'all' || (M.show === 'yours' ? isChanged(P) : animated(P) || isChanged(P)));
  // a part as it reads: a motion's name (the rig a film named), or its line (and which of those that line made)
  const partName = (C) => (C.src === 'own' ? 'yours, over the whole project' : C.src === 'clip' ? `the clip at ${fx(C.clip.at)} s` : C.src === 'code' ? (!C.th.instrument ? 'the code' : C.P.parts.length > 1 ? 'between clips' : 'the preset') : C.desc.name ?? `${C.desc.file}:${C.desc.line}${/#\d+$/.test(C.id) ? ` ${C.id.slice(C.id.lastIndexOf('#'))}` : ''}`);
  const spanText = (C) => (C.t1 === Infinity && C.t0 === -Infinity ? 'the whole project' : `${fx(Math.max(0, C.t0))}–${C.t1 === Infinity ? 'end' : `${fx(C.t1)} s`}`);
  const partsWord = (th) => (th.id === 'camera' ? 'cameras' : th.instrument ? 'clips' : 'motions');
  // the parts a property's motions come from, once each
  const stackParts = (P) => [...new Map(P.parts.filter((c) => c.src === 'stack').map((c) => [c.id, c])).values()];

  // ---------- fetching: the things over the whole film (when the selection, the film or its frames change), with the
  // code's values at each frame
  let fetching = 0;
  const wholeAsked = new Set();   // (what has had its pass over every frame)
  async function refresh() {
    // (the instruments whose motion shows: the selected notes clip's, those on tracks whose motion is shown; from the doc)
    const plugs = api.instruments?.() ?? [];
    // (the others selected with it: theirs too, to change with it and to show under their rows)
    const want = [{ id: 'camera', sel: { camera: true } }, { id: 'scene', sel: { scene: true } }, ...(api.selection() ? [{ id: 'sel', sel: api.selection() }] : []), ...(api.others?.() ?? []).map((sel, i) => ({ id: `also:${i}`, sel })), ...plugs.map((p) => ({ id: `inst:${p.key}`, sel: { instrument: p.key }, instrument: p }))];
    const n = ++fetching, film = { duration: S.film.duration ?? S.end(), fps: S.film.fps || S.doc.fps || 60, cuts: S.film.cuts ?? [], values: true };
    // (the film's: asked together, so that what is not answered yet is found in one pass over the film)
    const asked = want.filter((w) => !w.instrument), ask = (o) => api.post('api/lanes', { sels: asked.map((w) => w.sel), ...o }).then((r) => r.json()).catch(() => null);
    const show = (got) => {
      const res = want.map((w) => (Array.isArray(got) ? got[asked.indexOf(w)] : null));
      M.things = want.map((w, i) => {
        const old = M.things.find((th) => th.id === w.id && JSON.stringify(th.sel) === JSON.stringify(w.sel));
        const th = old ?? { id: w.id, sel: w.sel, open: w.id !== 'camera' && w.id !== 'scene', props: [] };   // (the camera's and the scene's: opened by their rows)
        if (w.instrument) { th.instrument = w.instrument; buildInstrument(th); } else if (res[i]?.props) build(th, res[i]);
        return th;
      }).filter((th) => th.props.length || th.instrument?.kept);   // (a track's shown with nothing moving it yet: said so)
      sync();
      if (M.sel && !M.things.some((th) => th.id === M.sel.th)) M.sel = null;
      api.relayout();
    };
    if (!asked.length) return show([]);
    // (what was selected before is not what the gizmo moves now, while this one's answer comes)
    M.things = M.things.filter((th) => want.some((w) => w.id === th.id && JSON.stringify(w.sel) === JSON.stringify(th.sel)));
    // (a pass over every frame takes seconds on a film whose code is heavy, and the gizmo and the inspector wait on what it
    // answers: the playhead's moment first, all they need, then a few moments for the lanes to show, then every frame)
    const key = JSON.stringify([S.film.gen, asked.map((w) => w.sel)]);
    if (!wholeAsked.has(key)) {
      for (const o of [{ ...film, at: S.t, draft: api.draft?.() }, { ...film, fps: Math.min(film.fps, Math.max(1, 48 / film.duration)), cuts: [...film.cuts, S.t] }]) {
        const first = await ask(o);
        if (n !== fetching) return;
        if (first) show(first);
      }
    }
    const got = await ask(film);
    if (n !== fetching) return;
    wholeAsked.add(key);
    show(got);
  }

  // ---------- rows: a thing, its properties, and an open property's lanes (top first)
  const hOf = (key, kind) => Math.round(M.heights[key] ?? DEF_H[kind] * (kind === 'mthing' ? 1 : M.scale));
  function rows() {
    const out = [];
    for (const th of M.things) {
      out.push({ kind: 'mthing', th, key: `t:${th.id}`, h: 24 + 6 });
      if (!th.open) continue;
      const props = shownProps(th), vecs = new Set();
      if (!props.length) out.push({ kind: 'mnone', th, key: `n:${th.id}`, h: 24 });
      // (in: the vector it is part of, opened)
      const prop = (P, inV = null) => {
        const pk = `p:${th.id}.${P.k}`;
        out.push({ kind: 'mprop', th, P, in: inV, key: pk, h: (P.open ? hOf(pk, 'mprop') : 24) + GAP * 2 });
        if (!P.open) return;
        const L = rowsOf(P);
        for (let i = L.length - 1; i >= 0; i--) {
          const lk = `l:${th.id}.${P.k}.${L[i].id}`;
          out.push({ kind: 'mlane', th, P, in: inV, lane: L[i], i, top: i === L.length - 1, key: lk, h: hOf(lk, 'mlane') + GAP });
        }
      };
      // (a vector shows where the first of it would, with every part of it under it)
      for (const P of props) {
        const V = vecOf(th, P.k);
        if (!V) { prop(P); continue; }
        if (vecs.has(V.id)) continue;
        vecs.add(V.id);
        out.push({ kind: 'mvec', th, V, key: `v:${th.id}.${V.id}`, h: 24 + GAP * 2 });
        if (V.open) for (const Q of V.Ps) prop(Q, V.id);
      }
    }
    return out;
  }
  // the vector property k is part of in th (its parts, those it has: two at least), kept on th so it stays open
  function vecOf(th, k) {
    if (th.instrument) return null;
    const [id, label, ks] = VEC.find(([, , ks]) => ks.includes(k)) ?? [];
    const Ps = ks?.map((x) => th.props.find((P) => P.k === x)).filter(Boolean) ?? [];
    if (Ps.length < 2) return null;
    const V = ((th.vecs ??= {})[id] ??= { id, label, open: false });
    V.Ps = Ps;
    return V;
  }
  const findV = (thId, id) => M.things.find((th) => th.id === thId)?.vecs?.[id] ?? null;
  // a vector's keys: its parts' keys (every Keys lane of theirs, each with the part that shows it), by time, each with
  // which of its parts have one then (full: all of them; out: beyond the stretch of each)
  function vecKeys(V) {
    if (V.keys?.v === M.version) return V.keys.list;
    const at = new Map();
    for (const P of V.Ps) for (const R of rowsOf(P)) for (const { c: C, lane } of R.cells) {
      if (lane.kind !== 'keys' || lane.muted) continue;
      (lane.ops[0].keys[C.ch] ?? []).forEach((k, j) => {
        if (!keyIn(P, C, k.t)) return;
        const n = Math.round(k.t * 1000);
        if (!at.has(n)) at.set(n, { t: k.t, items: [] });
        at.get(n).items.push({ P, C, lane, j, yours: lane.src === 'yours' || lane.ops[0].changed, out: !inSpan(C, k.t) });
      });
    }
    const list = [...at.values()].sort((a, b) => a.t - b.t);
    for (const q of list) Object.assign(q, { full: V.Ps.every((P) => q.items.some((x) => x.P === P)), yours: q.items.some((x) => x.yours), out: q.items.every((x) => x.out) });
    V.keys = { v: M.version, list };
    return list;
  }
  // a selection: a thing; a property (k); a lane (lane: its id); a part's own lane in it (part, lid), its key or move
  const selCell = (R, s) => (s?.part ? R.cells.find((x) => x.c.key === s.part && (s.lid == null || x.lane.id === s.lid)) ?? null : null);
  const isSel = (row) => {
    const s = M.sel;
    if (!s || s.th !== row.th.id || row.kind === 'mnone') return false;
    if (row.kind === 'mthing') return !s.k && !s.v;
    if (row.kind === 'mvec') return s.v === row.V.id && !s.k;
    if (row.kind === 'mprop') return s.k === row.P.k && !s.lane && !s.lid;
    return s.k === row.P.k && (s.lid != null ? !!selCell(row.lane, s) : s.lane === row.lane.id);
  };
  // the cell a lane's selection is on: the part chosen, or its only one
  const chosen = (R) => selCell(R, M.sel) ?? (R.cells.length === 1 ? R.cells[0] : null);

  // ---------- heads (DOM): names, what each lane is, its code line, its mode, on/off, a handle to reorder, a grip
  const lineOf = (x) => (x.lane.src !== 'yours' && x.lane.ops[0]?.site?.line ? x.lane.ops[0].site : x.lane.kind === 'base' && x.c.desc?.line ? { file: x.c.desc.file, line: x.c.desc.line } : null);
  // what is the same in every cell of a lane (null where they differ)
  const same = (vs) => (vs.every((v) => v === vs[0]) ? vs[0] : null);
  function head(row) {
    const { th } = row, sel = isSel(row) ? ' sel' : '';
    if (row.kind === 'mthing') {
      const icon = th.id === 'camera' || th.id === 'scene' ? th.id : th.kind === 'layer' || th.kind === 'instrument' ? th.kind : 'mesh';
      return `<div class="mrow mthing${sel}" data-mrow="${row.key}" data-m="selthing" data-th="${th.id}"><button class="mtw${th.open ? ' open' : ''}" data-m="twthing" data-th="${th.id}" aria-label="${th.open ? 'Collapse' : 'Expand'}">${ic('twirl')}</button>${ic(icon)}<b>${esc(th.label)}</b><span class="mdet">${th.id === 'camera' ? 'the project’s camera' : th.id === 'scene' ? 'its light and lens' : th.instrument ? 'its motion' : th.sel?.sites ? 'every copy' : th.sel?.copies > 1 ? `copy ${(th.sel.copy ?? 0) + 1} of ${th.sel.copies}` : ''}</span>${th.sel?.file ? `<button class="msrc" data-m="code" data-file="${esc(th.sel.file)}" data-line="${th.sel.line}" title="Where the code places it">${esc(th.sel.file)}:${th.sel.line}</button>` : ''}</div>`;
    }
    if (row.kind === 'mnone') return `<div class="mrow mnone"><span class="mdet">${th.instrument && !th.props.length ? 'No motion yet: key a knob with its ◆ in the Instrument panel.' : `Nothing ${M.show === 'yours' ? 'changed' : 'animated'}`}</span></div>`;
    if (row.kind === 'mvec') {
      const { V } = row, parts = V.Ps.map((P) => P.label).join(', '), ch = V.Ps.some(isChanged) ? '<span class="mdot" title="Changed by you"></span>' : '';
      return `<div class="mrow mvec${V.open ? ' open' : ''}${sel}" data-mrow="${row.key}" data-m="selvec" data-th="${th.id}" data-v="${V.id}" title="${esc(`${V.label}: ${parts}`)}">
        <button class="mtw${V.open ? ' open' : ''}" data-m="twvec" data-th="${th.id}" data-v="${V.id}" aria-label="${V.open ? 'Collapse' : `Expand: ${parts}`}">${ic('twirl')}</button><span class="mnm">${V.label}</span>${ch}<span class="mval">${V.Ps.map((P, i) => `<span data-mr="${row.key}" data-c="${i}" style="color:${AXIS[i]}"></span>`).join(' ')}<span class="munit">${vecUnit(V)}</span></span>
        <button class="mhb" data-m="addvkey" data-th="${th.id}" data-v="${V.id}" title="Key ${esc(parts)} at the playhead">${ic('key')}</button><span class="mhb"></span></div>`;
    }
    const { P } = row, inV = row.in ? ' inv' : '';
    if (row.kind === 'mprop') {
      const L = rowsOf(P), order = L.map((R) => rowWord(P, R)).join(' › ');
      const ch = isChanged(P) ? '<span class="mdot" title="Changed by you"></span>' : '', axis = row.in ? findV(th.id, row.in)?.Ps.indexOf(P) : -1;
      return `<div class="mrow mprop${P.open ? ' open' : ''}${inV}${sel}" data-mrow="${row.key}" data-m="selprop" data-th="${th.id}" data-k="${P.k}" title="${esc(`${P.label} · ${L.length} lane${L.length > 1 ? 's' : ''}`)}">
        <div class="ml1"><button class="mtw${P.open ? ' open' : ''}" data-m="twprop" data-th="${th.id}" data-k="${P.k}" aria-label="${P.open ? 'Collapse' : 'Expand'}">${ic('twirl')}</button><span class="mnm"${axis >= 0 ? ` style="color:${AXIS[axis]}"` : ''}>${P.label}</span>${ch}<span class="mval" data-mr="${row.key}"></span>
        <button class="mhb" data-m="addkey" data-th="${th.id}" data-k="${P.k}" title="Key ${P.label} at the playhead">${ic('key')}</button><button class="mhb" data-m="addop" data-th="${th.id}" data-k="${P.k}" title="Add an operator: keys, a move, a rate, a wander">${ic('plus')}</button></div>
        ${P.open ? `<div class="morder" title="${esc(order)}">${esc(order)}</div>` : ''}${P.open ? `<div class="mgrip" data-mgrip="${row.key}" data-kind="mprop" title="Drag to make it taller or shorter · double-click: tall, or back"></div>` : ''}</div>`;
    }
    const { lane: R } = row, cells = R.cells, one = cells.length === 1 ? cells[0] : null, yours = R.src === 'yours';
    const sites = cells.map(lineOf), site = sites.every((s) => s && s.file === sites[0].file && s.line === sites[0].line) ? sites[0] : null;
    const line = site ? `<button class="msrc" data-m="code" data-file="${esc(site.file)}" data-line="${site.line}" title="Show it in the code">${esc(site.file)}:${site.line}</button>`
      : yours ? `<span class="myours" title="Made in the timeline: not in the code">yours</span>` : '';
    const fixed = R.kind === 'base' || R.kind === 'code';
    const mode = fixed ? '<span class="mmode ghost"></span>' : `<button class="mmode${yours ? ' yours' : ''}" data-m="mode" data-th="${th.id}" data-k="${P.k}" data-lane="${esc(R.id)}" title="How it combines with what is below it · click to change${cells.length > 1 ? ` (in all ${cells.length})` : ''}">${same(cells.map((x) => modeName(x.lane))) ?? 'Mixed'}</button>`;
    const det = one ? laneDetail(one.c, one.lane) : R.id === 'after' ? 'after its motion' : same(cells.map((x) => laneDetail(x.c, x.lane))) ?? `${cells.length} ${partsWord(th)}`;
    const name = R.kind === 'base' && cells.some((x) => x.lane === CODED) ? 'Base · code' : kindName(P, R);
    return `<div class="mrow mlane ${yours ? 'yours' : 'code'}${R.muted ? ' muted' : ''}${row.top ? ' top' : ''}${inV}${sel}" data-mrow="${row.key}" data-m="sellane" data-th="${th.id}" data-k="${P.k}" data-lane="${esc(R.id)}" title="${esc(laneSay(P, R.id === 'after' ? AFTER : cells[0].lane) + (cells.length > 1 ? ` In ${cells.length} ${partsWord(th)}, each in its stretch.` : ''))}">
      ${fixed ? '<span class="mhandle"></span>' : `<span class="mhandle" data-mreorder="${row.key}" title="Drag to reorder">${ic('handle')}</span>`}<span class="mkind">${ic(R.id === 'after' ? 'code' : R.kind)}</span><span class="mnm">${name}</span><span class="mdet">${esc(det)}</span>${!yours && cells.some((x) => x.lane.ops.some((o) => o.changed)) ? '<span class="mdot" title="Changed by you"></span>' : ''}
      <span class="mgrow"></span>${fixed && R.id !== 'after' ? '' : `<span class="mval dim" data-mr="${row.key}"></span>`}${line}${mode}
      ${fixed ? '<span class="mhb"></span>' : `<button class="mhb${R.muted ? ' off' : ''}" data-m="mute" data-th="${th.id}" data-k="${P.k}" data-lane="${esc(R.id)}" title="${R.muted ? 'Turn it back on' : 'Turn it off'}${cells.length > 1 ? ` (in all ${cells.length})` : ''}">${ic(R.muted ? 'eyeoff' : 'eye')}</button>`}
      <div class="mgrip" data-mgrip="${row.key}" data-kind="mlane" title="Drag to make it taller or shorter · double-click: tall, or back"></div></div>`;
  }
  const modeName = (lane) => {
    if (lane.kind === 'moves') { const ms = new Set(lane.ops.map((m) => m.mode)); return ms.size > 1 ? 'Mixed' : ms.has('swish') ? 'Swish' : MODES[[...ms][0]]; }
    return lane.kind === 'keys' ? MODES[lane.ops[0].mode] : 'Add';
  };
  function laneDetail(C, lane) {
    const op = lane.ops[0], u = C.unit;
    if (lane === AFTER) return 'after its motion';
    if (lane.kind === 'base') return fmtV(C, baseOf(C));
    if (lane.kind === 'code') return C.th.instrument ? fmtV(C, C.P.codeNow ?? 0) : 'computed';
    if (lane.kind === 'rate') return C.log ? `${sgn(op.rate[C.ch] * 100, 1)} %/s` : `${sgn(op.rate[C.ch], 2)}${u}/s`;
    if (lane.kind === 'wander') return `${fx(op.amp[C.ch], 1)}${u === 'px' ? ' px' : u}${op.wave === 'smooth' ? ` · ${fx(op.speed)}×` : ''}`;
    if (lane.kind === 'keys') return `${op.keys[C.ch]?.length ?? 0} key${op.keys[C.ch]?.length === 1 ? '' : 's'}`;
    if (lane.kind === 'hits') return `${op.times.length} · ${sgn(disp(C, op.amp[C.ch]) - (C.log ? 1 : 0), 2)}${u === 'px' ? ' px' : u}`;
    return lane.ops.length > 1 ? `${lane.ops.length} moves` : '';
  }
  function laneSay(P, lane) {
    if (lane === AFTER) return SAY.after;
    if (lane.kind === 'code' && P.th.instrument) return 'The instrument’s own value. Your lanes work on top of it.';
    if (lane.kind === 'moves') { const m = lane.ops[0]; return SAY[m.mode] ?? SAY.aim; }
    if (lane.kind === 'keys') return SAY.keys[lane.ops[0].mode];
    return SAY[lane.kind];
  }
  // (P: a property, or a part of one: the same fields)
  const fmtV = (P, v) => { const said = P.th?.instrument?.text?.(P.k, v); if (said) return said; v = disp(P, v); return P.unit === '°' ? `${fx(v, 1)}°` : P.unit === '×' ? `${fx(v, 3)}×` : P.unit === 'px' ? `${fx(v, 1)} px` : P.unit === 'nm' ? `${fx(v, 0)} nm` : fx(v, 3); };
  const vecUnit = (V) => V.Ps[0].unit;
  const fmtD = (P, d) => (P.log ? `×${fx(Math.exp(d), 3)}` : P.unit === '°' ? `${sgn(d, 1)}°` : P.unit === 'px' ? sgn(d, 1) : sgn(d, 3));
  // the readouts at the playhead: each property's value, each lane's part of it (– where it has none then)
  function readouts(el) {
    for (const r of el.querySelectorAll('[data-mr]')) {
      const row = byKey.get(r.dataset.mr);
      if (!row) continue;
      let text;
      if (row.kind === 'mprop') { const v = valueAt(row.P, S.t); text = Number.isFinite(v) ? fmtV(row.P, v) : '–'; }
      else if (row.kind === 'mvec') { const P = row.V.Ps[r.dataset.c], v = P && valueAt(P, S.t); text = Number.isFinite(v) ? fx(disp(P, v), P.unit === '×' ? 3 : 1) : '–'; }
      else { const x = cellAt(row.lane, S.t); text = !x ? '–' : x.lane.muted ? 'off' : fmtD(row.P, cellValue(row.P, x, S.t)); }
      if (r.textContent !== text) r.textContent = text;   // (only a change: a write lays the page out again)
    }
  }
  let byKey = new Map();

  // ---------- drawing (the canvas): each lane framed, with a gutter, its curve, its keys and moves
  function curve(row, W, H, pad, xOf, tOf, fn, key) {
    const ck = `${key}|${W}|${H}|${S.view.x0}|${S.view.pps}|${M.version}`;
    let c = M.curves.get(ck);
    if (c) return c;
    const n = Math.max(2, Math.round(W / 3)), vs = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) vs[i] = fn(tOf((W * i) / n));
    let lo = Infinity, hi = -Infinity;
    for (const v of vs) { if (!Number.isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(hi - lo > 1e-9)) { if (!Number.isFinite(lo)) lo = hi = 0; lo -= 1; hi += 1; }
    const inv = row.P?.invert, y = (v) => pad + ((inv ? (v - lo) : (hi - v)) / (hi - lo)) * (H - 2 * pad);
    c = { vs, n, lo, hi, y };
    M.curves.set(ck, c);
    return c;
  }
  function stroke(g, c, W, y0, color, width = 1.2, dash = null) {
    g.beginPath();
    let pen = false;
    for (let i = 0; i <= c.n; i++) { if (!Number.isFinite(c.vs[i])) { pen = false; continue; } const x = (W * i) / c.n, y = y0 + c.y(c.vs[i]); if (pen) g.lineTo(x, y); else g.moveTo(x, y); pen = true; }
    g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash ?? []); g.stroke(); g.setLineDash([]);
  }
  function grid(g, P, c, W, y0, H, disp2) {
    if (H < 40) return;
    const span = c.hi - c.lo, raw = span / Math.max(1, Math.floor(H / 26)), p10 = 10 ** Math.floor(Math.log10(raw)), m = raw / p10, step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p10;
    g.font = '9px "JetBrains Mono", ui-monospace, monospace'; g.textBaseline = 'middle';
    for (let v = Math.ceil(c.lo / step) * step; v <= c.hi + step * 1e-6; v += step) {
      const y = Math.round(y0 + c.y(v)) + 0.5;
      g.fillStyle = Math.abs(v) < step * 1e-6 ? '#303030' : '#1c1c1c'; g.fillRect(0, y - 0.5, W, 1);
      g.fillStyle = '#5c5c5c'; g.fillText(disp2(v), 5, y);
    }
  }
  const frame = (row, y) => { const top = y + (row.kind === 'mthing' ? 6 : GAP); return [top, row.h - (row.kind === 'mthing' ? 6 : row.kind === 'mprop' || row.kind === 'mvec' ? GAP * 2 : GAP)]; };
  // a part's stretch on the canvas, within it
  const spanX = (C, xOf, W) => [Math.max(-2, C.t0 === -Infinity ? -2 : xOf(C.t0)), Math.min(W + 2, C.t1 === Infinity ? W + 2 : xOf(C.t1))];
  // under the grid: the gutter, and each lane's well
  function drawBack(g, row, y, W) {
    const [top, H] = frame(row, y), sel = isSel(row);
    g.fillStyle = '#080808'; g.fillRect(0, y, W, row.h);
    g.fillStyle = row.kind === 'mthing' ? '#121212' : row.kind === 'mlane' ? (sel && !M.sel.part ? '#121821' : '#101010') : sel ? '#131a23' : '#131313';
    g.fillRect(0, top, W, H);
  }
  // over it: the frame, the curves, the keys and moves
  function draw(g, row, y, xOf, tOf, W) {
    const [top, H] = frame(row, y), sel = isSel(row);
    g.strokeStyle = sel ? accent(0.5) : '#1f1f1f'; g.lineWidth = 1; g.strokeRect(0.5, top + 0.5, W - 1, H - 1);
    if (row.kind === 'mnone') return;
    if (row.kind === 'mthing') return drawThing(g, row, top, H, xOf, W);
    if (row.kind === 'mvec') return drawVec(g, row, top, H, xOf, tOf, W);
    const { P } = row;
    g.save(); g.beginPath(); g.rect(0, top, W, H); g.clip();
    for (const [a, b] of outside(P)) { const xa = Math.max(0, a === -Infinity ? 0 : xOf(a)), xb = Math.min(W, b === Infinity ? W : xOf(b)); if (xb > xa) { g.fillStyle = 'rgba(0,0,0,0.42)'; g.fillRect(xa, top, xb - xa, H); } }
    // where one part hands over to the next (a cut to another shot's camera)
    g.fillStyle = row.kind === 'mprop' ? '#262626' : '#232323';
    for (const c of P.parts) { if (c.t0 === -Infinity) continue; const x = Math.round(xOf(c.t0)) + 0.5; if (x >= 0 && x <= W) g.fillRect(x - 0.5, top, 1, H); }
    if (row.kind === 'mprop') {
      const c = curve(row, W, H, P.open ? 6 : 4, xOf, tOf, (t) => valueAt(P, t), row.key);
      if (P.open) grid(g, P, c, W, top, H, (v) => fmtV(P, v));
      if (isChanged(P) && rowsOf(P).length > 1) {
        const b = curve(row, W, H, P.open ? 6 : 4, xOf, tOf, (t) => bareAt(P, t), `${row.key}|bare`);
        stroke(g, { ...b, y: c.y }, W, top, '#6b6b6b', 1, [3, 3]);
      }
      stroke(g, c, W, top, P.open ? '#e6e6e6' : '#9a9a9a', P.open ? 1.6 : 1);
      // its keys, on its curve (one beyond its stretch, faint, at what its motion gives then)
      for (const R of rowsOf(P)) for (const { c: C, lane } of R.cells) {
        if (lane.kind !== 'keys' || lane.muted) continue;
        for (const k of lane.ops[0].keys[C.ch] ?? []) {
          const kx = xOf(k.t);
          if (kx < -4 || kx > W + 4 || !keyIn(P, C, k.t)) continue;
          const inside = inSpan(C, k.t), v = inside ? valueAt(P, k.t) : C.stack.value(C.ch, k.t);
          if (!Number.isFinite(v)) continue;
          g.globalAlpha = inside ? 1 : 0.5;
          diamond(g, kx, Math.min(top + H - 3, Math.max(top + 3, top + c.y(v))), 3, lane.src === 'yours' || lane.ops[0].changed ? accent(0.85) : '#a3adbb', '#0b0b0b');
        }
        g.globalAlpha = 1;
      }
      // (where it is at the playhead: drawn over the lanes as the playhead moves, drawNow)
      row.now = { top, H, c };
    } else drawLane(g, row, top, H, xOf, tOf, W);
    g.restore();
  }
  // a property's value at the playhead, on its curve as the lane was last drawn (and its number, open): over the lanes,
  // drawn again as the playhead moves, the lane itself not (timeline.js drawOver)
  function drawNow(g, row, xOf, W) {
    const n = row.now, P = row.P;
    if (row.kind !== 'mprop' || !n) return;
    const x = xOf(S.t), v = valueAt(P, S.t), py = n.top + n.c.y(v);
    if (!(x >= 0 && x <= W && Number.isFinite(v))) return;
    g.save(); g.beginPath(); g.rect(0, n.top, W, n.H); g.clip();
    g.beginPath(); g.arc(x, py, 3.2, 0, Math.PI * 2); g.fillStyle = isChanged(P) ? accent() : '#e6e6e6'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#0f0f0f'; g.stroke();
    if (P.open) { const t = fmtV(P, v); g.font = '9.5px "JetBrains Mono", ui-monospace, monospace'; const w = g.measureText(t).width + 6; g.fillStyle = 'rgba(9,9,9,0.88)'; g.fillRect(x + 7, py - 7, w, 14); g.fillStyle = '#e6e6e6'; g.textBaseline = 'middle'; g.fillText(t, x + 10, py); }
    g.restore();
  }
  function drawThing(g, row, top, H, xOf, W) {
    // when things happen in it: its moves and keys, faint, each in its part's stretch
    for (const P of row.th.props) for (const R of rowsOf(P)) for (const x of R.cells) {
      const l = x.lane, C = x.c;
      if (l.muted) continue;
      if (l.kind === 'moves') for (const m of l.ops) { if (!(m.t < C.t1 && m.t + m.dur > C.t0)) continue; const a = xOf(Math.max(m.t, C.t0)), b = xOf(Math.min(m.t + m.dur, C.t1)); if (b < 0 || a > W) continue; g.fillStyle = l.src === 'yours' || m.changed ? accent(0.35) : '#3a4048'; g.fillRect(a, top + H / 2 - 2, Math.max(2, b - a), 4); }
      if (l.kind === 'keys') for (const k of l.ops[0].keys[C.ch] ?? []) { if (!keyIn(P, C, k.t)) continue; const kx = xOf(k.t); if (kx < -5 || kx > W + 5) continue; g.globalAlpha = inSpan(C, k.t) ? 1 : 0.5; diamond(g, kx, top + H / 2, 3, l.src === 'yours' || l.ops[0].changed ? accent(0.6) : '#6a7280'); g.globalAlpha = 1; }
      if (l.kind === 'hits') { g.fillStyle = l.ops[0].changed ? accent(0.45) : '#4a5058'; for (const [t] of l.ops[0].times) { if (!inSpan(C, t)) continue; const hx = xOf(t); if (hx >= -2 && hx <= W + 2) g.fillRect(hx, top + H / 2 - 3, 1, 6); } }
    }
  }
  // a vector: each part's curve (in its colour, on its own scale), faint, and its keys: solid where every part has one, hollow
  // where some do
  function drawVec(g, row, top, H, xOf, tOf, W) {
    const { V } = row, mid = top + H / 2;
    g.save(); g.beginPath(); g.rect(0, top, W, H); g.clip();
    for (const [a, b] of outside(V.Ps[0])) { const xa = Math.max(0, a === -Infinity ? 0 : xOf(a)), xb = Math.min(W, b === Infinity ? W : xOf(b)); if (xb > xa) { g.fillStyle = 'rgba(0,0,0,0.42)'; g.fillRect(xa, top, xb - xa, H); } }
    V.Ps.forEach((P, i) => stroke(g, curve({ P }, W, H, 4, xOf, tOf, (t) => valueAt(P, t), `${row.key}|${P.k}`), W, top, AXIS[i] + '99', 1));
    for (const q of vecKeys(V)) {
      const kx = xOf(q.t);
      if (kx < -6 || kx > W + 6) continue;
      const picked = q.items.every((x) => M.picks.has(keyRef(x.P, x.C, x.lane, q.t))), color = q.yours ? accent() : '#a3adbb', ring = picked ? '#ffffff' : '#0b0b0b';
      g.globalAlpha = q.out && !picked ? 0.5 : 1;   // (beyond the stretch of each: faint)
      if (q.full) diamond(g, kx, mid, 5, color, ring);
      else { diamond(g, kx, mid, 5, '#0b0b0b', ring); diamond(g, kx, mid, 3.2, '#0b0b0b', color); }
    }
    g.globalAlpha = 1;
    g.restore();
  }
  function diamond(g, x, y, r, fill, ring = null) {
    g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath();
    g.fillStyle = fill; g.fill();
    if (ring) { g.strokeStyle = ring; g.lineWidth = 1.5; g.stroke(); }
  }
  function drawLane(g, row, top, H, xOf, tOf, W) {
    const { P, lane: R } = row, mid = top + H / 2, s = M.sel, pick = isSel(row) ? selCell(R, s) : null;
    const colorOf = (x) => (x.lane.src === 'yours' || x.lane.ops.some((o) => o.changed) ? accent() : CODE);
    // (the part chosen in it: its stretch lit)
    if (pick) { const [a, b] = spanX(pick.c, xOf, W); g.fillStyle = '#141a22'; g.fillRect(a, top, b - a, H); }
    const fixed = R.kind === 'base' || R.kind === 'code', pad = H >= 40 ? 6 : 4;
    const c = curve(row, W, H, pad, xOf, tOf, (t) => { const x = cellAt(R, t); return x ? cellValue(P, x, t) : NaN; }, row.key);
    if (H >= 40) grid(g, P, c, W, top, H, (v) => (fixed && R.id !== 'after' ? fmtV(P, v) : fmtD(P, v)));
    else if (!fixed && c.lo < 0 && c.hi > 0) { g.fillStyle = '#262626'; g.fillRect(0, Math.round(top + c.y(0)) - 0.5, W, 1); }
    for (const x of R.cells) {
      const [a, b] = spanX(x.c, xOf, W);
      if (b <= a || b < 0 || a > W) continue;
      const lane = x.lane, C = x.c, yours = lane.src === 'yours', color = colorOf(x);
      g.save(); g.beginPath(); g.rect(a, top, b - a, H); g.clip();
      g.globalAlpha = lane.muted ? 0.35 : 1;
      stroke(g, c, W, top, lane.kind === 'base' ? '#59606b' : lane.kind === 'moves' ? (yours ? accent(0.5) : 'rgba(138,148,163,0.45)') : lane.kind === 'code' ? CODE : color, lane.kind === 'base' ? 1 : 1.2);
      if (lane.kind === 'base' && b - a > 48) { g.font = '9.5px "JetBrains Mono", ui-monospace, monospace'; g.textBaseline = 'middle'; g.fillStyle = '#6a6a6a'; const v = baseOf(C); g.fillText(fmtV(C, v), Math.max(a, 0) + 8, Math.min(top + H - 7, Math.max(top + 7, top + c.y(v) + (H >= 40 ? -8 : 0)))); }
      if (lane.kind === 'keys') {
        const K = lane.ops[0].keys[C.ch] ?? [];
        K.forEach((k, j) => { const kx = xOf(k.t); if (!inSpan(C, k.t) || kx < -6 || kx > W + 6) return; const s2 = M.picks.has(keyRef(P, C, lane, k.t)); diamond(g, kx, mid, 5, color, s2 ? '#ffffff' : '#0b0b0b'); });
      }
      if (lane.kind === 'moves') {
        const d = C.stack._solve(C.ch, C.stack.lanes(C.ch), x.i);
        lane.ops.forEach((m, j) => {
          const ma = xOf(m.t), mb = xOf(m.t + m.dur), w = Math.max(6, mb - ma), bh = 16, by = H >= 40 ? top + 4 : mid - bh / 2;
          if (mb < -40 || ma > W + 40) return;
          const ch = yours || m.changed, s2 = M.picks.has(moveRef(P, C, lane, j));
          g.fillStyle = ch ? accent(0.14) : 'rgba(163,173,187,0.12)'; g.fillRect(ma, by, w, bh);
          g.strokeStyle = s2 ? '#ffffff' : ch ? accent(0.45) : '#3f4650'; g.lineWidth = 1; g.strokeRect(ma + 0.5, by + 0.5, w - 1, bh - 1);
          // the move's ease, rising the way it moves
          const up = (d[j] < 0) !== !!P.invert;
          g.beginPath();
          for (let k = 0; k <= 16; k++) { const q = k / 16, v = easeCurve(m)(q), px = ma + q * w, yy = by + 2 + (up ? 1 - v : v) * (bh - 4); k ? g.lineTo(px, yy) : g.moveTo(px, yy); }
          g.strokeStyle = ch ? accent(0.9) : '#7b8592'; g.lineWidth = 1.2; g.stroke();
          diamond(g, mb, by + bh / 2, 5, ch ? accent() : '#a3adbb', s2 ? '#ffffff' : '#0b0b0b');
          g.font = '9.5px "JetBrains Mono", ui-monospace, monospace'; g.textBaseline = 'middle'; g.fillStyle = ch ? accent() : '#8a8a8a';
          g.fillText(m.mode === 'aim' ? `→ ${fmtV(C, m.to?.[C.ch] ?? 0)}` : m.mode === 'swish' ? 'swish' : `by ${fmtD(C, m.by?.[C.ch] ?? 0)}`, mb + 9, by + bh / 2);
        });
      }
      g.restore();
    }
    // (keys beyond their part's stretch: faint, where they are, over the rest)
    for (const x of R.cells) {
      if (x.lane.kind !== 'keys') continue;
      const { c: C, lane } = x;
      for (const k of lane.ops[0].keys[C.ch] ?? []) {
        const kx = xOf(k.t);
        if (inSpan(C, k.t) || kx < -6 || kx > W + 6 || !keyIn(P, C, k.t)) continue;
        const picked = M.picks.has(keyRef(P, C, lane, k.t));
        g.globalAlpha = picked ? 1 : lane.muted ? 0.2 : 0.5;
        diamond(g, kx, mid, 5, colorOf(x), picked ? '#ffffff' : '#0b0b0b');
      }
    }
    g.globalAlpha = 1;
  }
  // a move's ease, 0 → 1 (a swish's way in runs −1 → 0)
  const easeCurve = (m) => (q) => { const v = easeOf(m.ease)(q); return v < 0 ? 1 + v : v; };

  // ---------- hit testing on the canvas: a key, a move (its body or its ◆), each in its part's stretch, or the row (and
  // the part under the pointer)
  function hit(row, x, y, top, xOf, tOf) {
    const H = row.h - GAP, mid = top + GAP + H / 2;
    if (row.kind === 'mvec') {
      const q = [...vecKeys(row.V)].reverse().find((k) => Math.abs(x - xOf(k.t)) <= 6 && Math.abs(y - mid) <= 8);
      return q ? { what: 'vkey', row, q } : { what: 'row', row };
    }
    if (row.kind !== 'mlane') return { what: 'row', row };
    for (const cell of [...row.lane.cells].reverse()) {
      const { c: C, lane } = cell;
      if (lane.muted) continue;
      if (lane.kind === 'keys') {
        const K = lane.ops[0].keys[C.ch] ?? [];
        for (let j = K.length - 1; j >= 0; j--) if (keyIn(row.P, C, K[j].t) && Math.abs(x - xOf(K[j].t)) <= 6 && Math.abs(y - mid) <= 8) return { what: 'key', row, cell, j };
      }
      if (lane.kind === 'moves') {
        const by0 = H >= 40 ? top + GAP + 4 : mid - 8, [sa, sb] = spanX(C, xOf, Infinity);
        if (x < sa - 6 || x > sb + 6) continue;
        for (let j = lane.ops.length - 1; j >= 0; j--) {
          const m = lane.ops[j], a = xOf(m.t), b = xOf(m.t + m.dur);
          if (y < by0 - 3 || y > by0 + 19) continue;
          if (Math.abs(x - b) <= 6) return { what: 'land', row, cell, j };
          if (x >= a && x <= Math.max(b, a + 6)) return { what: 'move', row, cell, j };
        }
      }
    }
    return { what: 'row', row, cell: cellAt(row.lane, tOf(x)) };
  }
  const HINT = {
    key: '<b>Key</b> drag to retime it · Alt: no snapping · its value in the inspector',
    move: '<b>Move</b> drag to retime it (it keeps following its cue) · drag its ◆ to change when it lands',
    land: '<b>Lands</b> drag to change when the move lands',
    mlane: '<b>Lane</b> click to select · double-click a Keys lane to add a key',
    mprop: '<b>Property</b> its value in the project · dashed: the code alone',
    mthing: '<b>Motion</b> click a property to open its stack',
    mvec: '<b>Vector</b> its parts together · double-click to key them all · open it for each one',
    vkey: '<b>Key</b> of every part keyed then (hollow: some) · drag to retime them together · Delete removes them',
  };

  // ---------- writing your changes into the doc (the timeline's overrides)
  // where a part's changes go: its motion (a stack's entry, by its id), its clip's lanes (its pattern's), or the thing's
  // own (over the whole film). A clip's are changed in the timeline's time, where this clip plays them, and put back in
  // the pattern's when the change is done (settle: the edit's end, or a drag's step)
  const working = new WeakMap();   // doc → Map(medium|key → { p, c }): a clip's lanes being changed, in the timeline's time
  function storeOf(d, C) {
    if (C.src === 'clip') {
      const m = d.media[C.medium], w = working.get(d) ?? new Map(), at = `${C.medium}|${C.k}`;
      working.set(d, w);
      if (!w.has(at)) w.set(at, { id: C.medium, k: C.k, c: C.clip, p: structuredClone(clipLanes(m.automation?.[C.k] ?? { lanes: [] }, C.clip)) });
      const { p } = w.get(at);
      return { entry: m, src: 'clip', lanes: () => p.lanes, ops: () => ({}), order: () => p.order ?? null, setOrder: (v) => { p.order = v; }, muted: () => (p.muted ??= []) };
    }
    d.overrides ??= [];
    if (C.src === 'stack') {
      let o = d.overrides.find((x) => x.stack === C.id);
      if (!o) d.overrides.push((o = { id: newIdIn(d), stack: C.id }));
      const ch = C.ch;
      return {
        entry: o, src: 'stack',
        lanes: () => ((o.lanes ??= {})[ch] ??= []),
        ops: () => (o.ops ??= {}),
        order: () => o.order?.[ch] ?? null, setOrder: (v) => { (o.order ??= {})[ch] = v; },
        muted: () => ((o.muted ??= {})[ch] ??= []),
      };
    }
    const o = thingStore(d, C.th, true);
    const p = (o.props[C.k] = structuredClone(asLanes(C.k, o.props[C.k] ?? { lanes: [] })));
    return { entry: o, src: 'thing', lanes: () => p.lanes, ops: () => ({}), order: () => p.order ?? null, setOrder: (v) => { p.order = v; }, muted: () => (p.muted ??= []) };
  }
  function settle(d) {
    const w = working.get(d);
    if (!w) return;
    working.delete(d);
    for (const { id, k, c, p } of w.values()) (d.media[id].automation ??= {})[k] = clipLanes(p, c, true);
  }
  const newIdIn = (d) => { const ids = [...d.cues.map((q) => q.id), ...(d.overrides ?? []).map((o) => o.id)].filter((i) => /^o\d+$/.test(i)); return `o${Math.max(0, ...ids.map((i) => +i.slice(1))) + 1}`; };
  // empty entries and fields go
  function tidy(d) {
    settle(d);
    const empty = (v) => v == null || (Array.isArray(v) ? !v.length : typeof v === 'object' && !Object.keys(v).length);
    for (const o of d.overrides ?? []) {
      if (o.stack) {
        for (const f of ['lanes', 'order', 'muted', 'base']) { if (o[f]) for (const k of Object.keys(o[f])) if (empty(o[f][k])) delete o[f][k]; if (empty(o[f])) delete o[f]; }
        if (o.ops) { for (const k of Object.keys(o.ops)) if (empty(o.ops[k])) delete o.ops[k]; if (empty(o.ops)) delete o.ops; }
      } else if (o.props) for (const k of Object.keys(o.props)) { const p = o.props[k]; if (p && typeof p === 'object' && !Array.isArray(p) && Array.isArray(p.lanes)) { if (!p.lanes.length) delete o.props[k]; else { if (empty(p.order)) delete p.order; if (empty(p.muted)) delete p.muted; } } }
    }
    if (d.overrides) d.overrides = d.overrides.filter((o) => (o.stack ? ['lanes', 'order', 'muted', 'base', 'ops'].some((f) => o[f]) : !empty(o.props)));
    for (const t of d.tracks ?? []) {   // (an instrument's: a parameter with no lanes left goes, and an automation left empty)
      if (!t.automation) continue;
      for (const [m, a] of Object.entries(t.automation)) {
        for (const [k, p] of Object.entries(a)) { if (!p?.lanes?.length) delete a[k]; else { if (empty(p.order)) delete p.order; if (empty(p.muted)) delete p.muted; } }
        if (empty(a)) delete t.automation[m];
      }
      if (empty(t.automation)) delete t.automation;
    }
    for (const m of Object.values(d.media ?? {})) {   // (a pattern's own, the same)
      if (!m.automation) continue;
      for (const [k, p] of Object.entries(m.automation)) { if (!p?.lanes?.length) delete m.automation[k]; else { if (empty(p.order)) delete p.order; if (empty(p.muted)) delete p.muted; } }
      if (empty(m.automation)) delete m.automation;
    }
  }
  const keyRow = (k) => [r6(k.t), r6(k.v), ...(k.ease && k.ease !== 'glide' ? [k.ease] : [])];
  // a lane's own record in the doc (yours), or its operator's override (the code's)
  function laneIn(st, lane) { return st.lanes().find((l) => l.id === lane.id); }
  function opIn(st, op) { const ops = st.ops(); return (ops[op.id] ??= {}); }
  const findP = (thId, k) => M.things.find((th) => th.id === thId)?.props.find((P) => P.k === k);
  const findRow = (P, id) => rowsOf(P).find((R) => R.id === id);
  // a change's words: the thing (and which of its parts, where it has several), the property
  const what = (C) => `${C.th.label}${C.src === 'clip' ? ' (its clips)' : C.src === 'stack' && C.P.parts.length > 1 ? ` (${partName(C)})` : ''} › ${C.label}`;
  const lanesOf = (C) => C.stack.lanes(C.ch);
  // where a change at t goes: the motion that gives the property then (a camera's: that shot's rig); else (the code
  // computes it then, or you have lanes over the whole film on it) the thing's own lanes, over the whole film
  const targetAt = (P, t) => { const c = partAt(P, t); return stacked(c) && !hasOwn(P) ? c : P.own; };
  // a part's value at t in its own channel space (what its keys and moves are in)
  const partValue = (C, t, upto = Infinity) => C.stack.value(C.ch, t, upto, -Infinity);

  // a key's time (a drag): yours, or the code's keys (their override)
  function setKeyTime(d, C, lane, j, t) {
    const st = storeOf(d, C);
    if (lane.src === 'yours') { const L = laneIn(st, lane); L.keys = keysOf(L.keys).map((k, i) => (i === j ? { ...k, t } : k)).sort((a, b) => a.t - b.t).map(keyRow); return; }
    const op = lane.ops[0], o = opIn(st, op);
    o.keys = { ...(o.keys ?? {}), [C.ch]: (op.keys[C.ch] ?? []).map((k, i) => (i === j ? { ...k, t } : k)).sort((a, b) => a.t - b.t).map(keyRow) };
  }
  // a move's start (keeping its length) and its length (keeping its start)
  function setMove(d, C, lane, j, { t, dur }) {
    const st = storeOf(d, C), m = lane.ops[j];
    if (lane.src === 'yours') { const L = laneIn(st, lane), mm = L.moves[j]; if (t != null) mm.t = r6(t); if (dur != null) mm.dur = r6(dur); return; }
    const o = opIn(st, m), code = C.desc.ops.find((x) => x.id === m.id);
    if (t != null) { o.shift = r6(t - code.t); if (Math.abs(o.shift) < 1e-6) delete o.shift; }
    if (dur != null) { o.dur = r6(dur); if (Math.abs(o.dur - code.dur) < 1e-6) delete o.dur; }
  }

  // ---------- drags (the timeline's model: from the doc as the drag began, so one drag is one undo step)
  function drag(h, x0, api2) {
    const { row, cell } = h, pps = () => S.view.pps;
    if (h.what === 'land') {   // (when a move lands: its length)
      const { P } = row, C = cell.c, { lane } = cell, m = lane.ops[h.j], t0 = m.t, d0 = m.dur;
      pickOnly([moveRef(P, C, lane, h.j)]); select({ th: row.th.id, k: P.k, lane: row.lane.id, part: C.key, lid: lane.id, move: h.j }, true);
      return { apply(doc, dx, dy, ev) { const end = api2.snap(t0 + d0 + dx / pps(), ev), dur = Math.max(1 / 24, r6(end - t0)); setMove(doc, C, lane, h.j, { dur }); settle(doc); return `${what(C)}: move lands ${fx(t0 + d0)} → ${fx(t0 + dur)} s`; } };
    }
    // what was grabbed, as the choice names it; and the one clicked, the inspector's
    let refs = [], active = null, t0 = 0;
    if (h.what === 'vkey') { refs = h.q.items.map((x) => keyRef(x.P, x.C, x.lane, h.q.t)); active = { th: row.th.id, v: row.V.id, vt: h.q.t }; t0 = h.q.t; }
    else if (cell && (h.what === 'key' || h.what === 'move')) {
      const { P } = row, C = cell.c, { lane } = cell;
      t0 = h.what === 'key' ? lane.ops[0].keys[C.ch][h.j].t : lane.ops[h.j].t;
      refs = [h.what === 'key' ? keyRef(P, C, lane, t0) : moveRef(P, C, lane, h.j)];
      active = { th: row.th.id, k: P.k, lane: row.lane.id, part: C.key, lid: lane.id, ...(h.what === 'key' ? { key: h.j } : { move: h.j }) };
    }
    if (!refs.length) return null;
    // (Shift or Ctrl: added to the choice, or taken out of it)
    if (api2.add) { const on = togglePicks(refs); M.sel = on ? active : null; api.relayout(); api.panels(); return null; }
    const had = refs.every((r) => M.picks.has(r)), others = had && (M.picks.size > refs.length || api2.timed());
    if (!had) { pickOnly(refs); select(active, true); } else M.sel = active;
    // (it, with everything else chosen: moved together; a click on it alone, the choice is it)
    const R = api2.retimer();
    let fn = (t) => t;
    return {
      apply(doc, dx, dy, ev) {
        const dt = Math.max(-R.min, r6(api2.snap(t0 + dx / pps(), ev)) - t0);
        fn = (t) => t + dt; R.apply(doc, fn);
        return `${others ? `${R.n} things` : refs.length > 1 ? `${row.th.label} › ${row.V?.label}: key` : h.what === 'key' ? `${what(cell.c)}: key` : `${what(cell.c)}: move`} ${fx(t0)} → ${fx(t0 + dt)} s`;
      },
      after: () => R.done(fn),
      click: others ? () => { pickOnly(refs); select(active, true); } : null,
    };
  }

  // ---------- several keys and moves chosen at once (docs/selection.md): each by its thing, property, part and lane, and
  // its time (a key) or its place in the lane (a move). M.sel is the one clicked last: the inspector's
  // (a motion's by its id: one motion in several stretches has the same keys and moves in each)
  const partRef = (C) => (C.src === 'stack' ? C.id : C.key);
  const keyRef = (P, C, lane, t) => `k|${P.th.id}|${P.k}|${partRef(C)}|${lane.id}|${r6(t)}`;
  const moveRef = (P, C, lane, j) => `m|${P.th.id}|${P.k}|${partRef(C)}|${lane.id}|${j}`;
  function pickOnly(refs) { M.picks = new Set(refs); }
  // (each added, or each taken out where all were in: whether they are in now)
  function togglePicks(refs) { const on = !refs.every((r) => M.picks.has(r)); for (const r of refs) if (on) M.picks.add(r); else M.picks.delete(r); return on; }
  // what is chosen, as the lanes have it now: for each lane of a part (once), the places of its keys and moves chosen
  function choice() {
    const out = new Map();
    if (!M.picks.size) return [];
    for (const th of M.things) for (const P of th.props) for (const R of rowsOf(P)) for (const { c: C, lane } of R.cells) {
      if (lane.kind !== 'keys' && lane.kind !== 'moves') continue;
      const ks = lane.kind === 'keys' ? (lane.ops[0].keys[C.ch] ?? []).flatMap((k, j) => (keyIn(P, C, k.t) && M.picks.has(keyRef(P, C, lane, k.t)) ? [j] : [])) : [];
      const ms = lane.kind === 'moves' ? lane.ops.flatMap((m, j) => (M.picks.has(moveRef(P, C, lane, j)) ? [j] : [])) : [];
      if (!ks.length && !ms.length) continue;
      const id = `${C.src === 'stack' ? C.id : C.key}|${C.ch}|${lane.id}`, g = out.get(id) ?? { P, C, lane, keys: new Set(), moves: new Set() };
      for (const j of ks) g.keys.add(j);
      for (const j of ms) g.moves.add(j);
      out.set(id, g);
    }
    return [...out.values()];
  }
  const choiceTimes = (groups) => groups.flatMap(({ C, lane, keys, moves }) => [...[...keys].map((j) => lane.ops[0].keys[C.ch][j].t), ...[...moves].map((j) => lane.ops[j].t)]);
  // the chosen keys and moves retimed in d (fn: a time's new time; k: how many times as long each move gets)
  function retime(d, groups, fn, k = 1) {
    for (const { C, lane, keys, moves } of groups) {
      const st = storeOf(d, C);
      if (keys.size) {
        const shift = (K) => K.map((q, j) => (keys.has(j) ? { ...q, t: Math.max(0, r6(fn(q.t))) } : q)).sort((a, b) => a.t - b.t).map(keyRow);
        if (lane.src === 'yours') { const L = laneIn(st, lane); L.keys = shift(keysOf(L.keys)); }
        else { const op = lane.ops[0], o = opIn(st, op); o.keys = { ...(o.keys ?? {}), [C.ch]: shift(op.keys[C.ch] ?? []) }; }
      }
      for (const j of moves) { const m = lane.ops[j]; setMove(d, C, lane, j, { t: Math.max(0, r6(fn(m.t))), ...(k !== 1 && { dur: Math.max(1 / 24, r6(m.dur * k)) }) }); }
    }
    settle(d);
  }
  // once they are retimed: the choice names their keys by their new times (and the one clicked, its new place)
  function moved(groups, fn) {
    const was = [], now = [];
    for (const { P, C, lane, keys } of groups) for (const j of keys) { const t = lane.ops[0].keys[C.ch][j].t; was.push(keyRef(P, C, lane, t)); now.push(keyRef(P, C, lane, Math.max(0, r6(fn(t))))); }
    for (const r of was) M.picks.delete(r);
    for (const r of now) M.picks.add(r);
    const s = M.sel;
    if (s?.vt != null) M.sel = { ...s, vt: Math.max(0, r6(fn(s.vt))) };
    else if (s?.key != null) {
      const g = groups.find((x) => x.C.key === s.part && x.lane.id === s.lid && x.keys.has(s.key));
      const t = g && Math.max(0, r6(fn(g.lane.ops[0].keys[g.C.ch][s.key].t)));
      const x = g && rowsOf(g.P).flatMap((R) => R.cells).find((c) => c.c.key === s.part && c.lane.id === s.lid);
      if (x) M.sel = { ...s, key: (x.lane.ops[0].keys[x.c.ch] ?? []).findIndex((q) => Math.abs(q.t - t) < 1e-6) };
    }
    api.relayout();
  }
  // the keys and moves a box covers (rows: the motion rows it crosses; x0–x1: its span on the canvas), added to the choice
  function pickBox(rows, x0, x1, xOf) {
    const refs = [], within = (t) => xOf(t) >= x0 - 4 && xOf(t) <= x1 + 4;
    let first = null;   // (the first it found: the inspector's)
    for (const row of rows) {
      if (row.kind === 'mvec') { for (const q of vecKeys(row.V)) if (within(q.t)) { refs.push(...q.items.map((x) => keyRef(x.P, x.C, x.lane, q.t))); first ??= { th: row.th.id, v: row.V.id, vt: q.t }; } continue; }
      if (row.kind !== 'mlane' || row.lane.muted) continue;
      for (const { c: C, lane } of row.lane.cells) {
        const at = { th: row.th.id, k: row.P.k, lane: row.lane.id, part: C.key, lid: lane.id };
        if (lane.kind === 'keys') (lane.ops[0].keys[C.ch] ?? []).forEach((k, j) => { if (keyIn(row.P, C, k.t) && within(k.t)) { refs.push(keyRef(row.P, C, lane, k.t)); first ??= { ...at, key: j }; } });
        if (lane.kind === 'moves') lane.ops.forEach((m, j) => { if (xOf(m.t + m.dur) >= x0 && xOf(m.t) <= x1) { refs.push(moveRef(row.P, C, lane, j)); first ??= { ...at, move: j }; } });
      }
    }
    for (const r of refs) M.picks.add(r);
    if (first && !M.sel) M.sel = first;
    api.relayout();
    return refs.length;
  }
  // the chosen keys and moves removed from d: keys, and your moves (the code's moves stay: turn their lane off)
  function dropChoice(d, groups) {
    for (const { C, lane, keys, moves } of groups) {
      const st = storeOf(d, C);
      if (keys.size) {
        const K = (lane.ops[0].keys[C.ch] ?? []).filter((_, j) => !keys.has(j)).map(keyRow);
        if (lane.src !== 'yours') { const op = lane.ops[0]; opIn(st, op).keys = { ...(opIn(st, op).keys ?? {}), [C.ch]: K }; }
        else if (K.length) laneIn(st, lane).keys = K;
        else st.lanes().splice(st.lanes().indexOf(laneIn(st, lane)), 1);
      }
      if (moves.size && lane.src === 'yours') {
        const L = laneIn(st, lane);
        if (!L) continue;
        L.moves = L.moves.filter((_, j) => !moves.has(j));
        if (!L.moves.length) st.lanes().splice(st.lanes().indexOf(L), 1);
      }
    }
    tidy(d);
  }
  // the choice in words: how many keys and moves, of what, when (and each lane's, after a dash)
  function choiceText(groups) {
    const nk = groups.reduce((n, g) => n + g.keys.size, 0), nm = groups.reduce((n, g) => n + g.moves.size, 0), ts = choiceTimes(groups);
    const ps = new Set(groups.map((g) => g.P)), name = (P) => { const V = vecOf(P.th, P.k); return V?.Ps.every((Q) => ps.has(Q)) ? V.label : P.label; };   // (every part of a vector: the vector)
    const of = [...new Set(groups.map((g) => `${g.P.th.label} › ${name(g.P)}`))];
    const head = `${[nk && `${nk} key${nk > 1 ? 's' : ''}`, nm && `${nm} move${nm > 1 ? 's' : ''}`].filter(Boolean).join(' and ')} · ${of.length > 2 ? `${of.length} properties` : of.join(', ')}, ${fx(Math.min(...ts))}${ts.length > 1 ? `–${fx(Math.max(...ts))}` : ''} s`;
    return `${head} — ${groups.map((g) => `${what(g.C)} ${KIND[g.lane.kind].toLowerCase()}${g.lane.src === 'yours' ? ' (yours)' : g.lane.ops[0]?.site?.line ? ` (${g.lane.ops[0].site.file}:${g.lane.ops[0].site.line})` : ''} at ${[...[...g.keys].map((j) => g.lane.ops[0].keys[g.C.ch][j].t), ...[...g.moves].map((j) => g.lane.ops[j].t)].map((t) => fx(t)).join(', ')} s`).join('; ')}`;
  }

  // ---------- actions from the heads, the inspector and the menus
  // (keep: the keys and moves chosen stay chosen)
  function select(s, keep = false) { if (s?.lane !== M.sel?.lane || s?.k !== M.sel?.k || s?.part !== M.sel?.part) M.code = null; if (!keep) M.picks = new Set(); M.sel = s; api.relayout(); api.panels(); }
  // a lane chosen on the canvas at t: its part there (the lane, where none has it then)
  function selectAt(row, cell) { select({ th: row.th.id, k: row.P.k, lane: row.lane.id, ...(cell && { part: cell.c.key, lid: cell.lane.id }) }); }
  // (a lane selected: the timeline's cues and clips are not)
  function edit(desc, fn) { api.edit(desc, (d) => { fn(d); tidy(d); }); }
  // a lane on or off (from its head: in every part it is in, all as one)
  function toggleMute(P, R, cells = R.cells) {
    const off = !cells.every((x) => x.lane.muted);
    edit(`${P.th.label} › ${P.label}: ${KIND[R.kind].toLowerCase()} ${off ? 'off' : 'on'}`, (d) => {
      for (const { c: C, lane } of once(cells)) {
        if (!!lane.muted === off) continue;
        const st = storeOf(d, C);
        if (lane.src === 'yours') { const L = laneIn(st, lane); if (L) { if (off) L.muted = true; else delete L.muted; } continue; }
        const m = st.muted(), i = m.indexOf(lane.id);
        if (i >= 0) m.splice(i, 1); else m.push(lane.id);
      }
    });
  }
  // a lane moved to place `to` (from the bottom) among its property's: in each part it is in, the part's own lanes in
  // that order (yours over the whole film stay over the parts')
  function reorder(P, laneId, to) {
    const L = rowsOf(P), from = L.findIndex((R) => R.id === laneId);
    if (from < 1 || to < 1 || to === from || to >= L.length) return;
    if (L[from].own !== L[to].own) return api.toast(L[from].own ? 'Your lanes over the whole project work on what every part gives: they stay above the parts’' : 'A part’s lanes stay under your lanes over the whole project');
    const ids = L.map((R) => R.id);
    const [x] = ids.splice(from, 1); ids.splice(to, 0, x);
    const rank = new Map(ids.map((id, i) => [id, i]));
    // each part the lane is in, with which lane each of its own lanes is in
    const parts = new Map();
    for (const R of L) for (const cell of R.cells) {
      const id = stacked(cell.c) ? cell.c.id : cell.c.key;
      if (!parts.has(id)) parts.set(id, { C: cell.c, in: new Map(), moved: false });
      parts.get(id).in.set(cell.lane.id, R.id);
      if (R.id === laneId) parts.get(id).moved = true;
    }
    edit(`${P.th.label} › ${P.label}: ${KIND[L[from].kind].toLowerCase()} moved in the stack`, (d) => {
      for (const { C, in: inLane, moved } of parts.values()) {
        if (!moved) continue;
        const now = lanesOf(C).map((l) => l.id).filter((id) => id !== 'base');
        const next = [...now].sort((a, b) => rank.get(inLane.get(a)) - rank.get(inLane.get(b)));
        if (next.join() !== now.join()) storeOf(d, C).setOrder(next);
      }
    });
    api.toast(`${KIND[L[from].kind]} now works on: ${['the base', ...ids.slice(1, to).map((id) => rowWord(P, L.find((r) => r.id === id)))].join(', ')}`);
  }
  // a lane of your own on top of a property, at t (the playhead): keys (one at t), a move, a rate, a wander — in the
  // part that gives it then
  function addLane(P, kind, t = S.t, C = targetAt(P, t)) {
    t = r6(t);
    const v = partValue(C, t), id = `y${Date.now().toString(36).slice(-5)}`, span = Math.abs(disp(C, v)) * 0.15 || 10;
    const lane = kind === 'keys' ? { id, kind, mode: 'add', keys: [[t, 0]] }
      : kind === 'moves' ? { id, kind, moves: [{ t, dur: 0.6, to: r6(C.log ? v + 0.1 : v + (C.invert ? -span : span)) }] }
      : kind === 'rate' ? { id, kind, rate: C.log ? 0.02 : C.unit === '°' ? 10 : r6(span), from: t }
      : { id, kind, amp: C.log ? 0.02 : r6(span * 0.5), speed: 1 };
    edit(`${what(C)}: add ${KIND[kind].toLowerCase()}`, (d) => storeOf(d, C).lanes().push(lane));
    P.open = true; select({ th: P.th.id, k: P.k, part: C.key, lid: id });
  }
  // a key at t in a Keys lane (laneId: its lane, in the part there), or in your keys on top of the part there (made if
  // there are none): where the stack is then, so nothing jumps
  function addKey(P, laneId = null, t = S.t) {
    t = r6(t);
    const e = keyAdd(P, laneId, t);
    if (!e) return api.toast('There is a key here already');
    if (e.made) return addLane(P, 'keys', t, e.C);
    edit(`${what(e.C)}: key at ${fx(t)} s`, e.fn);
    P.open = true; pickOnly([keyRef(P, e.C, e.lane, t)]); select({ th: P.th.id, k: P.k, part: e.C.key, lid: e.lane.id, key: e.j }, true);
  }
  // the edit that adds that key: { C, lane, j (its place), fn }, or with no Keys lane of yours there, { made } (one with
  // that key); null where there is a key then already
  function keyAdd(P, laneId, t) {
    let cell = laneId ? cellAt(findRow(P, laneId) ?? { cells: [] }, t) : null;
    if (cell?.lane.kind !== 'keys') cell = null;
    if (!cell) {
      const C = targetAt(P, t), L = lanesOf(C), lane = [...L].reverse().find((l) => l.kind === 'keys' && l.src === 'yours');
      if (!lane) { const id = `y${Date.now().toString(36).slice(-5)}${P.k}`; return { made: true, C, lane: { id }, fn: (d) => storeOf(d, C).lanes().push({ id, kind: 'keys', mode: 'add', keys: [[t, 0]] }) }; }
      cell = { c: C, lane, i: L.indexOf(lane) };
    }
    const { c: C, lane, i } = cell, op = lane.ops[0], K = op.keys[C.ch] ?? [];
    if (K.some((k) => Math.abs(k.t - t) < 1e-3)) return null;
    const v = op.mode === 'add' ? C.stack.adds(C.ch, i, t) : op.mode === 'multiply' ? 1 : partValue(C, t, i + 1);
    return { C, lane, j: [...K, { t }].sort((a, b) => a.t - b.t).findIndex((k) => k.t === t), fn: (d) => {
      const st = storeOf(d, C), nk = [...K, { t, v: r6(v), ease: 'glide' }].sort((a, b) => a.t - b.t).map(keyRow);
      if (lane.src === 'yours') laneIn(st, lane).keys = nk; else opIn(st, op).keys = { ...(opIn(st, op).keys ?? {}), [C.ch]: nk };
    } };
  }
  // a vector keyed at t: a key on each part of it with none then, where it is then (one undo step)
  function keyVec(V, t = S.t) {
    t = r6(t);
    const here = vecKeys(V).find((q) => Math.abs(q.t - t) < 1e-3), th = V.Ps[0].th;
    const es = V.Ps.filter((P) => !here?.items.some((x) => x.P === P)).map((P) => ({ P, e: keyAdd(P, null, t) })).filter((x) => x.e);
    if (!es.length) return api.toast(`${V.label} is keyed here already`);
    edit(`${th.label} › ${V.label}: key at ${fx(t)} s`, (d) => { for (const { e } of es) e.fn(d); });
    pickOnly([...(here?.items ?? []).map((x) => keyRef(x.P, x.C, x.lane, t)), ...es.map(({ P, e }) => keyRef(P, e.C, e.lane, t))]);
    select({ th: th.id, v: V.id, vt: t }, true);
  }
  const addKeyAt = (row, t) => (row.kind === 'mvec' ? keyVec(row.V, Math.max(0, t)) : addKey(row.P, row.lane.kind === 'keys' ? row.lane.id : null, Math.max(0, t)));
  // a new mode, keeping where it lands: each key's result, each move's arrival (in each of `cells`, all as one)
  function setMode(P, cells, mode) {
    const lane0 = cells[0]?.lane;
    if (!lane0) return;
    edit(`${P.th.label} › ${P.label}: ${KIND[lane0.kind].toLowerCase()} ${MODES[mode] ?? mode}`, (d) => {
      for (const { c: C, lane, i } of once(cells)) {
        const ch = C.ch, s = C.stack, L = lanesOf(C), st = storeOf(d, C);
        if (lane.kind === 'keys') {
          const op = lane.ops[0], K = op.keys[ch] ?? [];
          const res = K.map((k) => s.value(ch, k.t, i + 1, -Infinity)), below = K.map((k) => s.value(ch, k.t, i, -Infinity));
          const nk = K.map((k, j) => keyRow({ ...k, v: mode === 'add' ? res[j] - below[j] : mode === 'multiply' ? (below[j] ? res[j] / below[j] : 1) : res[j] }));
          if (lane.src === 'yours') Object.assign(laneIn(st, lane), { mode, keys: nk });
          else Object.assign(opIn(st, op), { mode, keys: { ...(opIn(st, op).keys ?? {}), [ch]: nk } });
        } else if (lane.kind === 'moves') {
          const dd = s._solve(ch, L, i);
          lane.ops.forEach((m, j) => {
            if (m.mode === 'swish' || m.mode === mode) return;
            const te = m.t + m.dur, landed = s.value(ch, te, i, m.k) + dd[j];
            if (lane.src === 'yours') { const mm = laneIn(st, lane).moves[j]; mm.mode = mode; if (mode === 'add') { mm.by = r6(dd[j]); delete mm.to; } else { mm.to = r6(landed); delete mm.by; } }
            else { const o = opIn(st, m); o.mode = mode; if (mode === 'add') o.by = { ...(o.by ?? {}), [ch]: r6(dd[j]) }; else o.to = { ...(o.to ?? {}), [ch]: r6(landed) }; }
          });
        }
      }
    });
    api.toast(`${MODES[mode]} · kept where it lands${cells.length > 1 ? ` (in all ${cells.length})` : ''}`);
  }
  function resetLane(C, lane) {
    edit(`${what(C)}: ${KIND[lane.kind].toLowerCase()} as the code has it`, (d) => {
      const st = storeOf(d, C);
      if (lane.src === 'yours') { const ls = st.lanes(), i = ls.findIndex((l) => l.id === lane.id); if (i >= 0) ls.splice(i, 1); }
      else { const ops = st.ops(); for (const op of lane.ops) delete ops[op.id]; const m = st.muted(), i = m.indexOf(lane.id); if (i >= 0) m.splice(i, 1); }
    });
    if (lane.src === 'yours') select({ th: C.th.id, k: C.k });
  }
  // Delete, with a lane chosen: the key chosen in it goes (and a lane of yours left without keys), else the lane if it is
  // yours; the code's stay (turned off, or changed in the code). Whatever is chosen, Delete is the lanes' then: never the
  // clip whose instrument they are
  function deleteChosen() {
    const del = deletion();
    if (del) { edit(del.desc, del.fn); M.picks = new Set(); M.sel = M.sel && { th: M.sel.th, ...(M.sel.k && { k: M.sel.k }), ...(M.sel.v && { v: M.sel.v }) }; return; }
    const s = M.sel, th = s && M.things.find((x) => x.id === s.th), P = th && s.k && th.props.find((p) => p.k === s.k);
    // (a vector's key: every part's key then)
    const V = th && !P && s.v && th.vecs?.[s.v], q = V && s.vt != null && vecKeys(V).find((k) => Math.abs(k.t - s.vt) < 1e-3);
    if (q) { edit(`${th.label} › ${V.label}: remove the key at ${fx(q.t)} s`, (d) => { for (const x of q.items) dropKey(d, x.C, x.lane, x.j); }); M.sel = { th: s.th, v: s.v }; return; }
    const R = P && ((s.lid != null ? rowsOf(P).find((r) => selCell(r, s)) : null) ?? (s.lane ? findRow(P, s.lane) : null)), cell = R && chosen(R);
    if (!cell) return;
    const { c: C, lane } = cell;
    if (lane.kind === 'keys' && s.key != null) {
      edit(`${what(C)}: remove a key`, (d) => dropKey(d, C, lane, s.key));
      M.sel = { ...s, key: null };
      return;
    }
    if (lane.src === 'yours') return resetLane(C, lane);
    if (lane.kind !== 'base' && lane.kind !== 'code') api.toast('This lane is the code’s: turn it off with its eye, or change it in the code');
  }
  // the chosen keys and moves taken out, as an edit (null: none chosen)
  function deletion() {
    const groups = choice();
    if (!groups.length) return null;
    return { desc: `remove ${choiceText(groups).split(' — ')[0]}`, fn: (d) => dropChoice(d, groups) };
  }
  // key j of a Keys lane taken out (a lane of yours left without keys goes)
  function dropKey(d, C, lane, j) {
    const op = lane.ops[0], K = (op.keys[C.ch] ?? []).filter((_, i) => i !== j).map(keyRow), st = storeOf(d, C);
    if (lane.src !== 'yours') { opIn(st, op).keys = { ...(opIn(st, op).keys ?? {}), [C.ch]: K }; return; }
    if (K.length) laneIn(st, lane).keys = K; else st.lanes().splice(st.lanes().indexOf(laneIn(st, lane)), 1);
  }
  // the code's line, in the inspector under what it shows
  // (a line of the code named: shown in the inspector, and opened in the Code panel)
  function codeAtLine(file, line) { M.code = { file, line: +line }; api.panels(); api.showCode({ file, line: +line }); }

  // ---------- menus: a lane's mode, and adding an operator
  const DIA = {
    add: '<path d="M2 22C14 22 18 8 30 8S46 16 54 12" stroke="#666" stroke-dasharray="3 3"/><path d="M2 18C14 18 18 4 30 4S46 12 54 8" stroke="currentColor"/>',
    aim: '<path d="M2 22C14 22 18 10 30 10S46 18 54 14" stroke="#666" stroke-dasharray="3 3"/><path d="M2 22C12 22 16 6 26 6C32 6 38 16 54 14" stroke="currentColor"/><path d="M26 3.5l2.5 2.5-2.5 2.5-2.5-2.5z" fill="currentColor" stroke="none"/>',
    replace: '<path d="M2 22C14 22 18 10 30 10S46 18 54 14" stroke="#666" stroke-dasharray="3 3"/><path d="M2 22C8 22 10 16 14 16H42C46 16 48 14 54 14" stroke="currentColor"/>',
    multiply: '<path d="M2 20C14 20 18 12 30 12S46 16 54 14" stroke="#666" stroke-dasharray="3 3"/><path d="M2 18C14 18 18 4 30 4S46 10 54 7" stroke="currentColor"/>',
  };
  // (cells: the parts' lanes it changes — from a lane's head, every one)
  function modeMenu(anchor, P, cells) {
    const lane = cells[0]?.lane;
    if (!lane) return;
    const cur = same(cells.map((x) => x.lane.ops[0]?.mode));
    const items = lane.kind === 'moves'
      ? [['aim', 'Aim', 'Each move lands on its target as it ends.'], ['add', 'Add', 'Each move adds its amount to what is below.']]
      : lane.kind === 'keys' ? [['add', 'Add', 'Its keys are offsets on top of what is below, which shows through.'], ['aim', 'Aim', 'Lands on each key’s value at its time; what is below keeps moving in between.'], ['replace', 'Replace', 'Its own values over its keys’ span, ignoring what is below.'], ['multiply', 'Multiply', P.log ? 'For values that are not a rig’s zoom (Add already multiplies it).' : 'Scales what is below by its keys.']]
      : null;
    if (!items) return api.popover(anchor, `<div class="mh">${KIND[lane.kind]}</div><div class="mnote">${lane.kind === 'rate' ? 'It grows steadily, adding to what is below.' : 'A wobble, adding to what is below.'} Drag its handle to reorder it.</div>`);
    if (lane.kind === 'moves' && cells.some((x) => x.lane.ops.some((m) => m.mode === 'swish'))) return api.popover(anchor, `<div class="mh">Swish</div><div class="mnote">${SAY.swish}</div>`);
    api.popover(anchor, `<div class="mh">How it combines with what is below${cells.length > 1 ? ` · in all ${cells.length} ${partsWord(P.th)}` : ''}</div>${items.map(([m, n, d]) => `<button class="mmi${cur === m ? ' on' : ''}" data-mpick="${m}" ${m === 'multiply' && P.log ? 'disabled' : ''}><svg class="dia" viewBox="0 0 56 26" fill="none" stroke-width="1.5" aria-hidden="true">${DIA[m]}</svg><b>${n}</b><span>${d}</span></button>`).join('')}<div class="mnote">Switching keeps where it lands. Dashed: what is below it.</div>`,
      (m) => setMode(P, cells, m));
  }
  function addMenu(anchor, P) {
    const items = [['keys', 'Keys', 'Values at times, eased between: Add, Aim or Replace.'], ['moves', 'Move', 'Land on a value at a time, or move by an amount.'], ['rate', 'Rate', 'Grow steadily, so much a second: a drift, a spin.'], ['wander', 'Wander', 'A slow wobble: handheld, a bob.']];
    const C = targetAt(P, S.t), where = stacked(C) && P.parts.length > 1 ? ` · ${partName(C)}` : '';
    api.popover(anchor, `<div class="mh">Add on top of ${esc(P.label)}${esc(where)}</div>${items.map(([k, n, d]) => `<button class="mmi" data-mpick="${k}"><svg class="dia small" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">${ICON[k]}</svg><b>${n}</b><span>${d}</span></button>`).join('')}<div class="mh">Later</div>${[['Delay', 'What is below, later: a stagger across copies.'], ['Loop', 'What is below, again and again.'], ['Link', 'Follow another property, like a driver.']].map(([n, d]) => `<button class="mmi" disabled><span></span><b>${n}</b><span>${d}</span></button>`).join('')}`,
      (k) => addLane(P, k));
  }

  // head events (delegated from the timeline's heads)
  function onHead(e) {
    const a = e.target.closest('[data-m]');
    if (!a) return false;
    const d = a.dataset, P = d.k ? findP(d.th, d.k) : null, R = P && d.lane ? findRow(P, d.lane) : null;
    e.stopPropagation();
    switch (d.m) {
      case 'twthing': { const th = M.things.find((x) => x.id === d.th); th.open = !th.open; api.relayout(); break; }
      case 'twprop': P.open = !P.open; api.relayout(); break;
      case 'twvec': { const V = findV(d.th, d.v); if (V) { V.open = !V.open; api.relayout(); } break; }
      case 'selvec': select({ th: d.th, v: d.v }); break;
      case 'addvkey': { const V = findV(d.th, d.v); if (V) keyVec(V); break; }
      case 'selthing': select({ th: d.th }); break;
      case 'selprop': select({ th: d.th, k: d.k }); break;
      case 'sellane': if (!(M.sel?.lane === d.lane && M.sel?.k === d.k && !M.sel?.part)) select({ th: d.th, k: d.k, lane: d.lane }); break;
      case 'mute': if (R) toggleMute(P, R); break;
      case 'mode': if (R) { select({ th: d.th, k: d.k, lane: d.lane }); modeMenu(a, P, R.cells); } break;
      case 'addop': addMenu(a, P); break;
      case 'addkey': addKey(P); break;
      case 'code': codeAtLine(d.file, d.line); break;
    }
    return true;
  }

  // ---------- the inspector, for a lane (or a property, or the camera) selected in the timeline
  function inspector(el, title) {
    const s = M.sel, th = s && M.things.find((x) => x.id === s.th), P = th && s.k && th.props.find((p) => p.k === s.k);
    if (!th) return false;
    if (!P) {
      title.textContent = th.label;
      el.innerHTML = `<div class="insp-title"><span class="sw" style="background:var(--accent)"></span><b>${esc(th.label)}</b><span>${th.id === 'camera' ? 'the project’s camera' : th.id === 'scene' ? 'its light and lens' : 'Motion'}</span></div>
        <div class="mstack">${th.props.map((p) => `<button data-mi="prop" data-k="${p.k}"><span class="mnm">${p.label}</span><span class="mdet">${rowsOf(p).length > 1 ? rowsOf(p).map((R) => rowWord(p, R)).join(' › ') : `${fmtV(p, valueAt(p, S.t))}${p.varies ? '' : ', still'}`}</span>${isChanged(p) ? '<span class="mdot"></span>' : ''}</button>`).join('')}</div>
        <span class="hint">Open a property in the timeline to see what moves it.</span>`;
      el.onclick = (e) => { const b = e.target.closest('[data-mi=prop]'); if (b) { const p = th.props.find((x) => x.k === b.dataset.k); p.open = true; select({ th: th.id, k: p.k }); } };
      return true;
    }
    const L = rowsOf(P), R = (s.lid != null ? L.find((r) => selCell(r, s)) : null) ?? (s.lane ? L.find((r) => r.id === s.lane) : null), cell = R && chosen(R);
    if (!R) {
      title.textContent = `${th.label} › ${P.label}`;
      const ms = stackParts(P);
      el.innerHTML = `<div class="insp-title"><b>${P.label}</b><span>${esc(th.label)} · ${fmtV(P, valueAt(P, S.t))}</span></div>
        <div class="sec">Its stack, top first</div><div class="mstack">${[...L].reverse().map((r) => `<button data-mi="lane" data-lane="${esc(r.id)}"><span class="mkind ${r.src}">${ic(r.id === 'after' ? 'code' : r.kind)}</span><span class="mnm">${r.id === 'after' ? 'Code' : r.kind === 'code' && P.th.instrument ? 'Preset' : KIND[r.kind]}</span><span class="mdet">${r.kind === 'code' && P.th.instrument ? fmtV(P, P.codeNow ?? 0) : r.cells.length > 1 ? `${r.cells.length} ${partsWord(th)}` : r.kind === 'base' ? fmtV(P, baseOf(r.cells[0].c)) : r.id === 'after' ? 'after its motion' : r.kind === 'code' ? (P.th.instrument ? fmtV(P, P.codeNow ?? 0) : 'computed by the code') : modeName(r.cells[0].lane)}${r.muted ? ' · off' : ''}</span>${r.src === 'yours' ? '<span class="myours">yours</span>' : r.cells.length === 1 && lineOf(r.cells[0]) ? `<span class="msrc">${esc(lineOf(r.cells[0]).file)}:${lineOf(r.cells[0]).line}</span>` : ''}</button>`).join('')}</div>
        <div class="row-btns"><button class="btn" data-mi="addkey">Key at playhead</button><button class="btn" data-mi="addop">Add operator</button></div>
        <span class="hint">Each lane works on the ones below it; drag a handle to reorder.${ms.length > 1 ? ` From ${ms.length} ${partsWord(th)}, each over its own stretch.` : ''}</span>`;
      el.onclick = (e) => {
        const b = e.target.closest('[data-mi]');
        if (!b) return;
        if (b.dataset.mi === 'lane') select({ th: th.id, k: P.k, lane: b.dataset.lane });
        if (b.dataset.mi === 'addkey') addKey(P);
        if (b.dataset.mi === 'addop') addMenu(b, P);
      };
      return true;
    }
    if (!cell) {
      // a lane in several parts: choose one (its head turns it off, or changes its mode, in all of them)
      title.textContent = `${th.label} › ${P.label} › ${R.id === 'after' ? 'Code' : kindName(P, R)}`;
      el.innerHTML = `<div class="insp-title"><span class="mkind ${R.src}">${ic(R.id === 'after' ? 'code' : R.kind)}</span><b>${R.id === 'after' ? 'Code' : kindName(P, R)}</b><span>${P.label} · ${esc(th.label)}</span></div>
        <div class="sec">In ${R.cells.length} ${partsWord(th)}</div><div class="mstack">${R.cells.map((x, j) => `<button data-mi="cell" data-j="${j}"><span class="mnm">${esc(partName(x.c))}</span><span class="mdet">${esc(spanText(x.c))} · ${esc(laneDetail(x.c, x.lane))}${x.lane.muted ? ' · off' : ''}</span>${changedLane(x.lane) ? '<span class="mdot"></span>' : ''}</button>`).join('')}</div>
        <span class="hint">${esc(laneSay(P, R.id === 'after' ? AFTER : R.cells[0].lane))} Each ${th.id === 'camera' ? 'camera' : 'motion'} has its own. Choose one to change it.</span>`;
      el.onclick = (e) => { const b = e.target.closest('[data-mi=cell]'); if (b) { const x = R.cells[+b.dataset.j]; select({ th: th.id, k: P.k, lane: R.id, part: x.c.key, lid: x.lane.id }); } };
      return true;
    }
    const { c: C, lane } = cell;
    title.textContent = `${th.label} › ${P.label} › ${lane === AFTER ? 'Code' : kindName(P, lane)}`;
    const op = lane.ops[0], yours = lane.src === 'yours', code = (id) => C.desc?.ops.find((x) => x.id === id);
    const num = (name, v, step, unit, was, extra = '') => {
      const ch = was != null && Math.abs(was - v) > 1e-9;
      return `<label class="${ch ? 'ov' : ''}">${name}</label><div class="pair prop"><input type="number" data-mf="${extra}" value="${+(+v).toFixed(4)}" step="${step}"><span class="ro">${unit}</span>${ch ? `<span class="hint" title="The code says ${fx(was, 4)}">code ${fx(was, 3)}</span>` : ''}</div>`;
    };
    const uv = (v) => disp(C, v), ud = (d) => (C.log ? Math.exp(d) : d);
    const where = P.parts.length > 1 || C.src === 'own' ? `<div class="mnote">${esc(partName(C))} · ${esc(spanText(C))}</div>` : '';
    let h = `<div class="insp-title"><span class="mkind ${lane.src}">${ic(lane === AFTER ? 'code' : lane.kind)}</span><b>${lane === AFTER ? 'Code' : kindName(P, lane)}</b><span>${P.label} · ${esc(th.label)}</span>${yours ? '<span class="myours">yours</span>' : op?.site?.line ? `<button class="link mono" data-mi="code" data-file="${esc(op.site.file)}" data-line="${op.site.line}">${esc(op.site.file)}:${op.site.line}</button>` : ''}</div>${where}<div class="form">`;
    if (lane.kind === 'keys' || (lane.kind === 'moves' && !lane.ops.some((m) => m.mode === 'swish'))) {
      const modes = lane.kind === 'moves' ? [['aim', 'Aim · .to()'], ['add', 'Add · .by()']] : [['add', 'Add'], ['aim', 'Aim'], ['replace', 'Replace'], ['multiply', 'Multiply']];
      const cur = lane.kind === 'moves' ? (new Set(lane.ops.map((m) => m.mode)).size > 1 ? null : lane.ops[0].mode) : op.mode;
      h += `<label>Mode</label><div class="seg">${modes.map(([m, l]) => `<button data-mi="mode" data-mode="${m}" class="${cur === m ? 'on' : ''}" ${m === 'multiply' && C.log ? 'disabled' : ''}>${l}</button>`).join('')}</div>`;
      if (lane.kind === 'keys' && op.mode === 'replace') h += num('Influence', op.influence ?? 1, 0.05, '', code(op.id)?.influence, 'infl');
    }
    if (lane.kind === 'base') h += `<label>Value</label><span class="ro">${fmtV(C, baseOf(C))}</span>`;
    if (lane === CODED) h += `<label>Now</label><span class="ro">${inSpan(C, S.t) ? fmtV(P, toP(P, codeAt(P, S.t))) : '–'}</span>`;
    if (lane === AFTER) h += `<label>Now</label><span class="ro">${inSpan(C, S.t) ? fmtD(P, afterAt(P, S.t)) : '–'}</span>`;
    if (lane.kind === 'rate') h += num('Per second', op.rate[C.ch], C.log ? 0.005 : 1, C.log ? 'log' : `${C.unit}/s`, yours ? null : code(op.id)?.rate?.[C.ch], 'rate');
    if (lane.kind === 'wander') h += num('Amount', op.amp[C.ch], 1, C.unit, yours ? null : code(op.id)?.amp?.[C.ch], 'amp') + (op.wave === 'smooth' ? num('Speed', op.speed, 0.1, '×', yours ? null : code(op.id)?.speed, 'speed') : '');
    if (lane.kind === 'hits') h += num('Amount', op.amp[C.ch], C.unit === '' || C.log ? 0.01 : 1, C.unit, yours ? null : code(op.id)?.amp?.[C.ch], 'amp') + num('Attack', op.attack, 0.005, 's', yours ? null : code(op.id)?.attack, 'attack') + num('Decay', op.decay, 0.01, 's', yours ? null : code(op.id)?.decay, 'decay') + `<label>Hits</label><span class="ro">${op.times.length}</span>`;
    h += '</div>';
    if (lane.kind === 'moves') lane.ops.forEach((m, j) => {
      const c = yours ? null : code(m.id);
      h += `<div class="sec${M.sel.move === j ? ' on' : ''}">${lane.ops.length > 1 ? `Move ${j + 1}` : 'Move'}${m.mode === 'swish' ? ' · swish' : ''}</div><div class="form">`;
      h += num('Starts', m.t, 1 / 24, 's', c?.t, `t.${j}`);
      if (m.mode !== 'swish') h += num('Lasts', m.dur, 1 / 24, 's', c?.dur, `dur.${j}`) + `<label>Lands</label><span class="ro">${fx(m.t + m.dur, 3)} s</span>`;
      if (m.mode === 'aim') h += num('Target', uv(m.to?.[C.ch] ?? 0), C.log ? 0.05 : 1, C.unit, c?.to?.[C.ch] != null ? uv(c.to[C.ch]) : null, `to.${j}`);
      if (m.mode === 'add') h += num('Amount', ud(m.by?.[C.ch] ?? 0), C.log ? 0.01 : 1, C.log ? '×' : C.unit, c?.by?.[C.ch] != null ? ud(c.by[C.ch]) : null, `by.${j}`);
      if (m.mode !== 'swish') h += `<label class="${c && easeName(c.ease) !== easeName(m.ease) ? 'ov' : ''}">Ease</label><select data-mf="ease.${j}">${easeChoices(m.ease)}</select>`;
      h += '</div>';
    });
    if (lane.kind === 'keys') {
      const K = op.keys[C.ch] ?? [], vl = op.mode === 'add' ? (C.log ? 'Times' : 'Adds') : op.mode === 'aim' ? 'Lands at' : op.mode === 'multiply' ? 'Times' : 'Value';
      h += `<div class="sec">Keys</div><div class="mkeys"><span class="h">Time</span><span class="h">${vl}</span><span class="h">Ease in</span><span></span>${K.map((k, j) => `<input type="number" data-mf="kt.${j}" value="${+k.t.toFixed(4)}" step="${(1 / 24).toFixed(4)}" class="${M.sel.key === j ? 'sel' : ''}" aria-label="Time of key ${j + 1}"><input type="number" data-mf="kv.${j}" value="${+(op.mode === 'add' ? ud(k.v) : op.mode === 'multiply' ? k.v : uv(k.v)).toFixed(4)}" step="${C.unit === '' || C.log ? 0.01 : 1}" class="${M.sel.key === j ? 'sel' : ''}" aria-label="Value of key ${j + 1}"><select data-mf="ke.${j}" aria-label="Ease into key ${j + 1}">${easeChoices(k.ease)}</select><button class="rst" data-mi="delkey" data-j="${j}" title="Remove this key">×</button>`).join('')}</div>
        <div class="row-btns"><button class="btn" data-mi="addkey">Key at playhead</button></div>`;
    }
    const fixed = lane.kind === 'base' || lane.kind === 'code', changed = lane.ops.some((o) => o.changed) || (lane.muted && lane.src === 'code');
    h += `<div class="row-btns"><button class="btn primary" data-mi="ask" title="Ask ${esc(api.agentName())} about this lane">Ask ${esc(api.agentName())}</button>${!yours && op?.site?.line ? `<button class="btn" data-mi="code" data-file="${esc(op.site.file)}" data-line="${op.site.line}">Show in code</button>` : ''}${!fixed && R.cells.length > 1 ? `<button class="btn" data-mi="mute">${lane.muted ? 'Turn it on' : 'Turn it off'} here</button>` : ''}${changed && !yours ? '<button class="btn" data-mi="reset">Back to the code</button>' : ''}${yours ? '<button class="btn" data-mi="remove">Remove</button>' : ''}</div>`;
    h += `<span class="hint">${esc(laneSay(P, lane))}${fixed ? '' : yours ? ' You added this in the timeline. It isn’t in the code yet.' : ' Changes here override the code.'}${R.cells.length > 1 ? ` This is one of ${R.cells.length} ${partsWord(th)} in this lane, covering ${spanText(C)}.` : ''}</span>`;
    el.innerHTML = h + codeBlock(op?.site);
    fillCode(el);
    el.onclick = (e) => {
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      const d = b.dataset;
      if (d.mi === 'mode') setMode(P, [cell], d.mode);
      if (d.mi === 'ask') api.ask();
      if (d.mi === 'code') codeAtLine(d.file, d.line);
      if (d.mi === 'mute') toggleMute(P, R, [cell]);
      if (d.mi === 'reset') resetLane(C, lane);
      if (d.mi === 'remove') resetLane(C, lane);
      if (d.mi === 'addkey') { if (lane.kind === 'keys' && !inSpan(C, S.t)) return api.toast(`The playhead is outside ${partName(C)}: move it into ${spanText(C)}`); addKey(P, lane.kind === 'keys' ? R.id : null); }
      if (d.mi === 'delkey') edit(`${what(C)}: remove a key`, (doc) => { const st = storeOf(doc, C), K = (op.keys[C.ch] ?? []).filter((_, j) => j !== +d.j).map(keyRow); if (yours) laneIn(st, lane).keys = K; else opIn(st, op).keys = { ...(opIn(st, op).keys ?? {}), [C.ch]: K }; });
    };
    el.onchange = (e) => {
      const f = e.target.dataset?.mf;
      if (!f) return;
      const raw = e.target.value, v = +raw, [fld, js] = f.split('.'), j = +js;
      if (e.target.type === 'number' && !Number.isFinite(v)) return;
      edit(`${what(C)}: ${KIND[lane.kind].toLowerCase()} ${fld}`, (d) => {
        const st = storeOf(d, C);
        if (lane.kind === 'moves') {
          const m = lane.ops[j];
          if (fld === 't' || fld === 'dur') return setMove(d, C, lane, j, { [fld]: v });
          if (yours) { const mm = laneIn(st, lane).moves[j]; if (fld === 'to') mm.to = r6(store(C, v)); if (fld === 'by') mm.by = r6(C.log ? Math.log(v) : v); if (fld === 'ease') mm.ease = raw; return; }
          const o = opIn(st, m);
          if (fld === 'to') o.to = { ...(o.to ?? {}), [C.ch]: r6(store(C, v)) };
          if (fld === 'by') o.by = { ...(o.by ?? {}), [C.ch]: r6(C.log ? Math.log(v) : v) };
          if (fld === 'ease') o.ease = raw;
          return;
        }
        if (lane.kind === 'keys' && (fld === 'kt' || fld === 'kv' || fld === 'ke' || fld === 'infl')) {
          if (fld === 'infl') { if (yours) laneIn(st, lane).influence = v; else opIn(st, op).influence = v; return; }
          const K = (op.keys[C.ch] ?? []).map((k, i) => (i !== j ? k : fld === 'kt' ? { ...k, t: r6(v) } : fld === 'ke' ? { ...k, ease: raw } : { ...k, v: op.mode === 'add' ? (C.log ? Math.log(v) : v) : op.mode === 'multiply' ? v : store(C, v) })).sort((a, b) => a.t - b.t).map(keyRow);
          if (yours) laneIn(st, lane).keys = K; else opIn(st, op).keys = { ...(opIn(st, op).keys ?? {}), [C.ch]: K };
          return;
        }
        const map = { rate: 'rate', amp: 'amp' };
        if (map[fld]) { if (yours) laneIn(st, lane)[fld] = v; else opIn(st, op)[fld] = { ...(opIn(st, op)[fld] ?? {}), [C.ch]: v }; }
        if (fld === 'speed') { if (yours) laneIn(st, lane).speed = v; else opIn(st, op).speed = v; }
        if (fld === 'attack' || fld === 'decay') { if (yours) laneIn(st, lane)[fld] = Math.max(0, v); else opIn(st, op)[fld] = Math.max(0, v); }
      });
    };
    return true;
  }
  // the code around a line (the lane's, or one asked for), in the inspector
  function codeBlock(site) {
    const c = M.code ?? (site?.line ? { file: site.file, line: site.line } : null);
    return c ? `<div class="full code" id="laneCode" data-file="${esc(c.file)}" data-line="${c.line}"><span class="hint">…</span></div>` : '';
  }
  function fillCode(el) {
    const box = el.querySelector('#laneCode');
    if (!box) return;
    api.codeAround({ file: box.dataset.file, line: +box.dataset.line }).then((html) => { box.innerHTML = html; }).catch((e) => { box.innerHTML = `<span class="hint">${esc(e.message)}</span>`; });
    box.title = 'Open it in the Code panel';
    box.onclick = () => api.showCode({ file: box.dataset.file, line: +box.dataset.line });
  }
  function easeChoices(cur) {
    const name = easeName(cur), names = ['glide', 'lin', 'apple', 'mat', 'sine', 'out3', 'out2', 'out', 'in2', 'in3', 'io', 'io2', 'back'];
    return [...new Set([...(names.includes(name) || name === 'custom' ? [] : [name]), ...names])].map((n) => `<option value="${n}"${n === name ? ' selected' : ''}>${n}</option>`).join('') + (name === 'custom' ? '<option selected disabled>custom (the code’s)</option>' : '');
  }

  // ---------- the object inspector's fields (a property's value at the playhead, ◆ its keys, × back to the code): your
  // keys on top of what gives it at the playhead, made if there are none, in the mode the property reads best in (an
  // offset for position and turn, a factor for scale, a value for the rest). A value set without ◆ holds everywhere
  // that part gives it (one key, `static`)
  const MOVES = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'yaw', 'pitch', 'roll', 'tx', 'ty', 'tz', 'zoom'];
  // a new Keys lane's mode: a move adds (a camera's turn and its target too, so its own motion goes on under it; a rig's
  // zoom, kept as its logarithm, adds there: a factor), a scale multiplies, the rest replace; an instrument's parameter
  // aims (it holds the first key's value before it and the last's after, as automation does)
  const modeFor = (k, P) => (P?.th.instrument ? 'aim' : MOVES.includes(k) && (k !== 'zoom' || P?.log) ? 'add' : /^s[xyz]?$/.test(k) ? 'multiply' : 'replace');
  const topKeys = (C) => [...lanesOf(C)].reverse().find((l) => l.kind === 'keys' && l.src === 'yours') ?? null;
  // a key's value in lane i (mode) of part C that puts it at `want` at t
  function keyValue(C, i, mode, t, want) {
    const below = partValue(C, t, i);
    return r6(mode === 'add' ? want - below : mode === 'multiply' ? (below ? want / below : 1) : want);
  }
  function keyState(thId, k) {
    const P = findP(thId, k);
    if (!P) return null;
    const C = targetAt(P, S.t), kl = topKeys(C), K = kl?.ops[0].keys[C.ch] ?? [], keyed = !!kl && !laneRecord(C, kl)?.static;
    return { changed: isChanged(P), keyed, here: keyed && K.some((q) => Math.abs(q.t - S.t) < 1e-3), times: keyed ? K.map((q) => q.t) : [] };
  }
  // a lane of yours as the doc has it (its flags)
  function laneRecord(C, lane) {
    const o = C.src === 'stack' ? (S.doc.overrides ?? []).find((x) => x.stack === C.id)?.lanes?.[C.ch] : C.src === 'clip' ? S.doc.media[C.medium]?.automation?.[C.k]?.lanes : asLanes(C.k, entryFor(C.th)?.props?.[C.k] ?? { lanes: [] }).lanes;
    return o?.find((l) => l.id === lane.id) ?? null;
  }
  const shown = (thId, k) => { const P = findP(thId, k); if (!P) return null; const v = valueAt(P, S.t); return Number.isFinite(v) ? disp(P, v) : null; };
  // what the part at t must give for the property to read v (a value, as the inspector shows it), in its own space: the
  // code's change after a rig (a shake) taken off
  const wantOf = (P, C, v, t) => (C.src === 'stack' ? store(C, v) - (C.after ? afterAt(P, t) : 0) : v);
  // the change that puts property k at value v at the playhead (your keys on top: see setValue), as a description and
  // an edit of the doc — several make one undo step (a move: x, y and z), and one can be tried before it is made
  // ---------- a change from the viewer (the gizmo, Lock to view, Point the camera) goes into the lane selected, at the
  // playhead: a Keys lane's key there (made if there is none), the move of a Moves lane that lands there (a new move
  // landing there, where none does), a Base everywhere. The other properties the change moves go into the same lane of
  // theirs (a rig's move names several channels; your lanes, by their place among yours). With no lane selected, or
  // none of theirs like it, a change goes where the inspector's fields put it (valueEdit).
  // the lane selected, as a cell (its part, lane and place in the part's stack) with its property and row
  function selectedCell(thId, t = S.t) {
    const s = M.sel;
    if (!s?.k || s.th !== thId || (s.lid == null && !s.lane)) return null;
    const P = findP(thId, s.k);
    if (!P) return null;
    for (const R of rowsOf(P)) {
      if (s.lid == null ? R.id !== s.lane : !R.cells.some((x) => x.c.key === s.part && x.lane.id === s.lid)) continue;
      const x = s.lid == null ? cellAt(R, t) ?? (R.cells.length === 1 ? R.cells[0] : null) : R.cells.find((c) => c.c.key === s.part && c.lane.id === s.lid);
      return x ? { P, R, ...x } : null;
    }
    return null;
  }
  // (a lane's place among the part's lanes of yours of its kind)
  const rankIn = (L, lane) => L.filter((l) => l.src === 'yours' && l.kind === lane.kind).indexOf(lane);
  // the lane of property P like the one selected (sc): in the same part, the same operator of the code's (a run of moves
  // with one of its moves), or yours of its kind in the same place among yours
  function likeCell(sc, P) {
    if (P === sc.P) return sc;
    const C = sc.c.src === 'own' ? P.own : P.parts.find((c) => c.key === sc.c.key);
    if (!C || !stacked(C) && C.src !== 'own') return null;
    const L = lanesOf(C), mine = lanesOf(sc.c);
    const lane = sc.lane.src === 'yours' ? L.filter((l) => l.src === 'yours' && l.kind === sc.lane.kind)[rankIn(mine, sc.lane)]
      : sc.lane.kind === 'base' ? L.find((l) => l.id === 'base' && l.kind === 'base')
      : L.find((l) => l.src === 'code' && l.kind === sc.lane.kind && l.ops.some((op) => sc.lane.ops.some((o) => o.id === op.id)));
    return lane ? { P, c: C, lane, i: L.indexOf(lane) } : null;
  }
  const NO_POINT = (kind) => `A ${KIND[kind]} lane has no value to put at the playhead: its numbers are in the inspector. Select a Keys or Moves lane, or none.`;
  const landing = (m, t) => Math.abs(m.t + m.dur - t) < 1e-3;
  // a part's changes as a copy to try an edit on (its store, as storeOf gives the doc's) and the part's value at t with
  // them: a motion's override, or the thing's own lanes over its value
  function trial(P, C) {
    const ch = C.ch;
    if (C.src === 'stack') {
      const o = structuredClone((S.doc.overrides ?? []).find((x) => x.stack === C.id) ?? {});
      return { st: { entry: o, lanes: () => ((o.lanes ??= {})[ch] ??= []), ops: () => (o.ops ??= {}), order: () => o.order?.[ch] ?? null, setOrder: (v) => { (o.order ??= {})[ch] = v; } },
        at: (t) => Stack.from(C.desc, { local: o, ...(C.below && { code: C.below }) }).value(ch, t) };
    }
    const e = entryFor(C.th), p = structuredClone(asLanes(C.k, e?.props?.[C.k] ?? { lanes: [] }));
    return { st: { entry: p, lanes: () => p.lanes, ops: () => ({}), order: () => p.order ?? null, setOrder: (v) => { p.order = v; } },
      at: (t) => new Stack(null, { id: 'trial', code: C.stack.code, local: { lanes: { value: p.lanes }, ...(p.order && { order: { value: p.order } }), ...(p.muted && { muted: { value: p.muted } }) } }).value('value', t) };
  }
  // the edit that puts property k of thing thId at v (as it reads) at the playhead, in the lane selected: { desc, fn },
  // { error } where that lane cannot take it, null where no lane is selected for it. Each edit sets one number (a key's
  // value, where a move lands, a base); the part's value at t is straight in it, so two tries on a copy of its changes
  // give the number that puts it at v exactly, whatever the lanes around it do
  function intoLane(thId, k, v) {
    const sc = selectedCell(thId), P = findP(thId, k);
    if (!sc || !P) return null;
    let x = likeCell(sc, P);
    // (a Moves lane selected, and none like it on this property: the code's move names other channels. It moves this one
    // as a move of its own does, over the same time, in a lane of yours just over the part's base)
    if (!x && sc.lane.kind === 'moves') { const C = sc.c.src === 'own' ? P.own : P.parts.find((c) => c.key === sc.c.key && c.src === 'stack'); if (C) x = { P, c: C, lane: null, i: 1 }; }
    if (!x || (x.c.src !== 'stack' && x.c.src !== 'own')) return null;
    if (x.lane?.id === 'after') return { error: 'What the code adds after its motion (a shake) is the code’s: select another lane, or none.' };
    const { c: C, i } = x, lane = x.lane ?? { id: null, kind: 'moves', src: 'none', ops: [] }, t = r6(S.t), ch = C.ch, want = wantOf(P, C, v, t), name = `${what(C)} › ${KIND[lane.kind]}`;
    let put, desc, x0 = 0;
    if (lane.kind === 'base') {
      if (C.src !== 'stack') return { error: 'The code computes this value: select a lane over it, or none.' };
      x0 = baseOf(C); desc = `${name}, everywhere`;
      put = (st, n) => { st.entry.base = { ...st.entry.base, [ch]: n }; };
    } else if (lane.kind === 'keys') {
      const op = lane.ops[0], K = op.keys[ch] ?? [], j = K.findIndex((q) => Math.abs(q.t - t) < 1e-3), stat = lane.src === 'yours' && laneRecord(C, lane)?.static;
      const one = stat || !K.length, at = one ? K[0]?.t ?? t : t;
      x0 = one ? K[0]?.v ?? 0 : j >= 0 ? K[j].v : 0;
      desc = `${name}: ${stat ? 'its value' : j >= 0 ? `the key at ${fx(t)} s` : `a key at ${fx(t)} s`}`;
      const keysWith = (n) => (one ? [{ t: at, v: n, ease: K[0]?.ease ?? 'glide' }] : j >= 0 ? K.map((q, m) => (m === j ? { ...q, v: n } : q)) : [...K, { t, v: n, ease: 'glide' }].sort((a, b) => a.t - b.t)).map(keyRow);
      put = (st, n) => { if (lane.src === 'yours') laneIn(st, lane).keys = keysWith(n); else { const o = opIn(st, op); o.keys = { ...o.keys, [ch]: keysWith(n) }; } };
    } else if (lane.kind === 'moves') {
      // (no lane like the one selected: the lane of yours over the base, if it is one of moves)
      const L = lanesOf(C), low = !x.lane && L[1]?.src === 'yours' && L[1].kind === 'moves' ? L[1] : null, ln = low ?? lane, j = ln.ops.findIndex((m) => landing(m, t));
      if (j >= 0) {
        const m = ln.ops[j];
        if (m.mode === 'swish') return { error: 'A swish turns as far as the cut needs: drag it to retime it, or select another lane.' };
        const f = m.mode === 'add' ? 'by' : 'to';
        x0 = m[f]?.[ch] ?? 0; desc = `${name}: the move landing at ${fx(t)} s`;
        put = (st, n) => { if (ln.src === 'yours') laneIn(st, ln).moves[j][f] = n; else { const o = opIn(st, m); o[f] = { ...o[f], [ch]: n }; } };
      } else {
        // none lands here: a move that does, from where the one before it lands (where the move selected lands here, over
        // its time). Into this lane, where it is yours (in time order: the moves after it are sized against it, so they
        // land where they did); else into a lane of yours just under the code's (made where there is none), or over the
        // part's base, which the code's moves after it are sized against the same way
        const under = x.lane ? L[i - 1] : null, mine = low ?? (lane.src === 'yours' ? lane : under?.src === 'yours' && under.kind === 'moves' ? under : null);
        const same = sc.lane.ops.find((m) => landing(m, t));
        const ends = [...lane.ops, ...sc.lane.ops, ...(mine && mine !== lane ? mine.ops : [])].map((m) => m.t + m.dur).filter((e) => e < t - 1e-3);
        const t0 = r6(same ? same.t : ends.length ? Math.max(...ends) : Math.max(0, Number.isFinite(C.t0) ? C.t0 : 0, t - 1)), dur = r6(same ? same.dur : Math.max(1 / 24, t - t0));
        const id = `y${Date.now().toString(36).slice(-5)}${k}`, order = L.slice(1).map((l) => l.id);
        x0 = partValue(C, t); desc = `${name}: a move landing at ${fx(t)} s`;
        put = (st, n) => {
          const move = { t: t0, dur, to: n };
          if (mine) { const ms = laneIn(st, mine).moves; ms.splice(ms.filter((q) => q.t + q.dur <= t).length, 0, move); return; }
          st.lanes().push({ id, kind: 'moves', moves: [move] });
          if (lane.src !== 'yours') { const o = [...order]; o.splice(x.lane ? o.indexOf(lane.id) : 0, 0, id); st.setOrder(o); }
        };
      }
    } else return { error: NO_POINT(lane.kind) };
    // (two tries: the value at t for the number as it is, and for one more)
    const tryWith = (n) => { const tr = trial(P, C); put(tr.st, n); return tr.at(t); }, f0 = tryWith(x0), f1 = tryWith(x0 + 1);
    if (!(Math.abs(f1 - f0) > 1e-9)) return { error: `${name}: what is over it holds it here, so it cannot move it. Select another lane, or none.` };
    const n = r6(x0 + (want - f0) / (f1 - f0));
    return { desc, fn: (d) => put(storeOf(d, C), n) };
  }
  // what a change from the viewer to thing thId at the playhead goes into, in words (the gizmo's readout)
  function intoText(thId) {
    const t = r6(S.t), sc0 = selectedCell(thId), sc = sc0 && (sc0.c.src === 'stack' || sc0.c.src === 'own') ? sc0 : null;
    if (!sc) {
      const P = findP(thId, 'x') ?? M.things.find((th) => th.id === thId)?.props[0];
      const C = P && targetAt(P, t), kl = C && topKeys(C), stat = kl && laneRecord(C, kl)?.static;
      return kl && !stat ? `Into your keys, at ${fx(t)} s · select a lane to choose another` : `Into your value over ${C && C.src === 'stack' && P.parts.length > 1 ? 'this shot' : 'the whole project'} · press ◆ to key it, or select a lane`;
    }
    const { c: C, lane } = sc, at = lane.src === 'yours' ? ' (yours)' : lane.ops[0]?.site?.line ? ` (${lane.ops[0].site.file}:${lane.ops[0].site.line})` : '', name = `${KIND[lane.kind]}${at}`;
    if (lane.kind === 'keys') { const K = lane.ops[0].keys[C.ch] ?? [], stat = lane.src === 'yours' && laneRecord(C, lane)?.static; return `Into ${name}: ${stat ? 'its value' : K.some((q) => Math.abs(q.t - t) < 1e-3) ? 'the key here' : `a new key at ${fx(t)} s`}`; }
    if (lane.kind === 'moves') { const m = lane.ops.find((q) => landing(q, t)); return m ? (m.mode === 'swish' ? 'A swish cannot be moved here · select another lane' : `Into ${name}: where the move at ${fx(m.t)}–${fx(m.t + m.dur)} s lands`) : `Into ${lane.src === 'yours' ? name : 'Moves (yours)'}: a new move landing at ${fx(t)} s`; }
    if (lane.kind === 'base') return C.src === 'stack' ? `Into Base${at}: everywhere` : 'The code computes this value · select a lane over it, or none';
    return NO_POINT(lane.kind);
  }

  // ---------- a thing's path through the film and the points on it its pose is set at, drawn in the viewer
  const POSE = ['x', 'y', 'z', 'rx', 'ry', 'rz', 's', 'sx', 'sy', 'sz', 'zoom', 'yaw', 'pitch', 'roll', 'tx', 'ty', 'tz'];
  // its keys and where its moves land, once each by time: the lane selected's (and the same lane's in its other pose
  // properties), and the rest of its pose lanes', each { t, sel (the lane selected's), what (key, move), at (the
  // selection that names it) }
  function points(thId) {
    const th = M.things.find((x) => x.id === thId);
    if (!th) return [];
    const sc = selectedCell(thId), by = [];
    for (const P of th.props) {
      if (!POSE.includes(P.k)) continue;
      const like = sc && likeCell(sc, P);
      for (const R of rowsOf(P)) for (const { c: C, lane } of R.cells) {
        if (lane.muted || (lane.kind !== 'keys' && lane.kind !== 'moves') || (lane.src === 'yours' && laneRecord(C, lane)?.static)) continue;
        const sel = !!like && like.c.key === C.key && like.lane.id === lane.id, ref = { th: thId, k: P.k, lane: R.id, part: C.key, lid: lane.id };
        if (lane.kind === 'keys') (lane.ops[0].keys[C.ch] ?? []).forEach((q, j) => { if (keyIn(P, C, q.t)) by.push({ t: q.t, sel, what: 'key', at: { ...ref, key: j } }); });
        else lane.ops.forEach((m, j) => { const e = m.t + m.dur; if (m.mode !== 'swish' && e >= C.t0 - 1e-6 && e <= C.t1 + 1e-6) by.push({ t: e, sel, what: 'move', at: { ...ref, move: j } }); });
      }
    }
    by.sort((a, b) => a.t - b.t || b.sel - a.sel);
    const out = [];
    for (const p of by) { const q = out[out.length - 1]; if (q && Math.abs(q.t - p.t) < 1e-3) { q.sel ||= p.sel; continue; } out.push({ ...p }); }
    return out;
  }
  // where it is (x, y, z, as its lanes give it) through the film, about 12 times a second and at each of its points: runs
  // of [t, [x, y, z]], broken where it is not in the scene and where another motion takes over (a cut to another camera)
  function path(thId) {
    const th = M.things.find((x) => x.id === thId), Ps = ['x', 'y', 'z'].map((k) => th?.props.find((P) => P.k === k));
    if (!Ps[0] || !Ps[1]) return [];
    const end = S.film.duration || S.end(), key = `${M.version}|${end}`;
    if (th.path?.key === key) return th.path.runs;
    const n = Math.min(1200, Math.max(2, Math.ceil(end * 12))), ts = [...new Set([...Array.from({ length: n + 1 }, (_, i) => r6((i / n) * end)), ...points(thId).map((p) => r6(p.t))])].sort((a, b) => a - b);
    const runs = [];
    let run = null, was = null;
    for (const t of ts) {
      const p = Ps.map((P) => (P ? disp(P, valueAt(P, t)) : 0)), part = partAt(Ps[0], t)?.id ?? null;
      if (p.some((v) => !Number.isFinite(v))) { run = null; continue; }
      if (!run || (th.id === 'camera' && part !== was)) runs.push((run = []));
      run.push([t, p]); was = part;
    }
    th.path = { key, runs };
    return runs;
  }

  function valueEdit(thId, k, v) {
    const P = findP(thId, k);
    if (!P) return null;
    const t = r6(S.t), C = targetAt(P, t), want = wantOf(P, C, v, t), kl = topKeys(C);
    if (!kl) {
      const mode = modeFor(k, P), val = keyValue(C, lanesOf(C).length, mode, t, want), id = `y${Date.now().toString(36).slice(-5)}${k}`;
      return { desc: `${P.label} → ${fx(v, 3)}`, fn: (d) => storeOf(d, C).lanes().push({ id, kind: 'keys', mode, keys: [[t, val]], static: true }) };
    }
    const i = lanesOf(C).indexOf(kl), op = kl.ops[0], K = op.keys[C.ch] ?? [], val = keyValue(C, i, op.mode, t, want), stat = laneRecord(C, kl)?.static;
    const nk = stat || K.length === 0 ? [{ t: K[0]?.t ?? t, v: val, ease: 'glide' }]
      : K.some((q) => Math.abs(q.t - t) < 1e-3) ? K.map((q) => (Math.abs(q.t - t) < 1e-3 ? { ...q, v: val } : q)) : [...K, { t, v: val, ease: 'glide' }].sort((a, b) => a.t - b.t);
    return { desc: `${P.label} → ${fx(v, 3)}${stat ? '' : ` at ${fx(t)} s`}`, fn: (d) => { laneIn(storeOf(d, C), kl).keys = nk.map(keyRow); } };
  }
  // (into: a change from the viewer — the gizmo, Lock to view, Point the camera — goes into the lane selected: intoLane)
  function valueEdits(thId, values, { into = false } = {}) {
    const es = Object.entries(values).map(([k, v]) => (into && intoLane(thId, k, v)) || valueEdit(thId, k, v));
    const bad = es.find((e) => e?.error);
    if (bad) return bad;
    if (!es.length || es.some((e) => !e)) return null;
    const th = M.things.find((x) => x.id === thId);
    return { desc: `${th.label}${th.sel?.sites ? ', every copy' : ''}: ${es.map((e) => e.desc).join(', ')}`, fn: (d) => { for (const e of es) e.fn(d); tidy(d); } };
  }
  function setValue(thId, k, v) { return setValues(thId, { [k]: v }); }
  function setValues(thId, values) {
    const e = valueEdits(thId, values);
    if (!e) return false;
    api.edit(e.desc, e.fn);
    return true;
  }
  function toggleKey(thId, k) {
    const P = findP(thId, k);
    if (!P) return false;
    const t = r6(S.t), C = targetAt(P, t), kl = topKeys(C), now = partValue(C, t);
    if (!kl) {
      const mode = modeFor(k, P), id = `y${Date.now().toString(36).slice(-5)}`, val = keyValue(C, lanesOf(C).length, mode, t, now);
      edit(`${what(C)}: keys, one at ${fx(t)} s`, (d) => storeOf(d, C).lanes().push({ id, kind: 'keys', mode, keys: [[t, val]] }));
      return true;
    }
    const i = lanesOf(C).indexOf(kl), op = kl.ops[0], K = op.keys[C.ch] ?? [], stat = laneRecord(C, kl)?.static, here = K.findIndex((q) => Math.abs(q.t - t) < 1e-3);
    edit(`${what(C)}: ${here >= 0 && !stat ? 'remove the key' : 'key'} at ${fx(t)} s`, (d) => {
      const st = storeOf(d, C), rec = laneIn(st, kl);
      if (stat) { delete rec.static; if (here < 0) rec.keys = [...K, { t, v: keyValue(C, i, op.mode, t, now), ease: 'glide' }].sort((a, b) => a.t - b.t).map(keyRow); return; }
      if (here >= 0) { const nk = K.filter((_, j) => j !== here); if (nk.length) rec.keys = nk.map(keyRow); else st.lanes().splice(st.lanes().indexOf(rec), 1); return; }
      rec.keys = [...K, { t, v: keyValue(C, i, op.mode, t, now), ease: 'glide' }].sort((a, b) => a.t - b.t).map(keyRow);
    });
    return true;
  }
  // back to what the code says: your lanes on it go, and your changes to the code's operators on it, in every part
  function resetProp(thId, k, desc = true) {
    const P = findP(thId, k);
    if (!P) return false;
    const fn = (d) => {
      for (const C of stackParts(P)) {
        const o = (d.overrides ?? []).find((x) => x.stack === C.id);
        if (!o) continue;
        for (const f of ['lanes', 'order', 'muted', 'base']) if (o[f]) delete o[f][C.ch];
        for (const l of lanesOf(C)) if (l.src === 'code') for (const op of l.ops) if (o.ops) delete o.ops[op.id];
      }
      const o = thingStore(d, P.th);
      if (o?.props) delete o.props[k];
      if (P.th.instrument) for (const c of notesClips(d.tracks.find((t) => t.id === P.th.instrument.track), d.media)) delete d.media[c.media].automation?.[k];   // (its patterns' own)
    };
    if (desc) edit(`${P.th.label} › ${P.label} as the code has it`, fn); else return fn;
    return true;
  }
  function resetAll(thId) {
    const th = M.things.find((x) => x.id === thId);
    if (!th) return false;
    const fns = th.props.map((P) => resetProp(thId, P.k, false)).filter(Boolean);
    edit(`${th.label}: as the code has it`, (d) => { for (const f of fns) f(d); });
    return true;
  }

  // ---------- the timeline bar's controls: which properties show, the lanes' height
  function setShow(v) { M.show = v; keep(); api.relayout(); }
  function setScale(d, fit) {
    M.heights = {};
    if (fit) M.scale = Math.max(1, Math.min(8, fit));
    else M.scale = Math.max(0.85, Math.min(8, M.scale * (d > 0 ? 1.4 : 1 / 1.4)));
    keep(); api.relayout();
  }
  function setHeight(key, kind, h) { if (h == null) delete M.heights[key]; else M.heights[key] = Math.max(MIN_H[kind], Math.min(MAX_H, Math.round(h))); keep(); api.relayout(); }

  return {
    M, refresh, sync, rows, head, drawBack, draw, drawNow, hit, drag, onHead, inspector, readouts, reorder, setShow, setScale, setHeight, addKeyAt, select, selectAt, hOf, DEF_H, GAP,
    /** A thing's moves and keys, faint, over a row of another's (its object's, in the timeline's Objects). */
    marks: (g, row, top, H, xOf, W) => drawThing(g, row, top, H, xOf, W),
    keyState, shown, setValue, setValues, valueEdits, toggleKey, resetProp, resetAll,
    /** Where a change from the viewer to a thing goes now, in words; its path through the film; the points on it. */
    intoText, path, points,
    /** A point (of points()) selected: its key or move, and its lane. */
    selectPoint(p) {
      const P = findP(p.at.th, p.at.k), x = P && rowsOf(P).flatMap((R) => R.cells).find((c) => c.c.key === p.at.part && c.lane.id === p.at.lid);
      if (!x) return;
      P.open = true;
      pickOnly([p.what === 'key' ? keyRef(P, x.c, x.lane, x.lane.ops[0].keys[x.c.ch][p.at.key].t) : moveRef(P, x.c, x.lane, p.at.move)]);
      select(p.at, true);
    },
    /** What is selected in the lanes, in words (for the agent). */
    describeSel() {
      const groups = choice();
      if (groups.length && (M.picks.size > 1 || !M.sel)) return choiceText(groups);
      const s = M.sel, th = s && M.things.find((x) => x.id === s.th);
      if (!th) return null;
      const P = s.k && th.props.find((p) => p.k === s.k), R = P && ((s.lid != null ? rowsOf(P).find((r) => selCell(r, s)) : null) ?? (s.lane ? findRow(P, s.lane) : null)), cell = R && chosen(R), lane = cell?.lane;
      const at = lane?.ops[0]?.site?.line ? ` (${lane.ops[0].site.file}:${lane.ops[0].site.line})` : lane?.src === 'yours' ? ' (yours, in the timeline)' : '';
      const ms = P ? stackParts(P) : [];
      const part = cell && P.parts.length > 1 ? `, in ${partName(cell.c)} over ${spanText(cell.c)}` : R && !cell ? `, in ${R.cells.length} ${partsWord(th)}` : '';
      const V = !P && s.v && th.vecs?.[s.v];
      if (V) return `${th.label} › ${V.label} (${V.Ps.map((p) => p.label).join(', ')})${s.vt != null ? `, its key at ${fx(s.vt)} s` : ''}`;
      return [th.label, P?.label, R && `${R.id === 'after' ? 'Code after its motion' : kindName(P, R)}${at}${part}`].filter(Boolean).join(' › ')
        + (!P ? '' : ms.length > 1 ? ` — from ${ms.length} ${partsWord(th)} over the project, each in its stretch` : ms.length ? ` — the motion at ${ms[0].desc.file}:${ms[0].desc.line}` : ' — computed by the code');
    },
    /** Opens a property's lanes (once the thing's stacks are in) and selects it. */
    reveal(thId, k) {
      // (a property the Show filter hides is shown: everything is listed)
      const go = () => { const P = findP(thId, k); if (!P) return false; if (!shownProps(P.th).includes(P)) { M.show = 'all'; keep(); } P.th.open = true; P.open = true; select({ th: thId, k }); return true; };
      if (!go()) { let n = 0; const t = setInterval(() => { if (go() || ++n > 40) clearInterval(t); }, 150); }
    },
    anyChanged: (thId) => !!M.things.find((th) => th.id === thId)?.props.some(isChanged),
    hint: (h) => (h.what === 'row' ? HINT[h.row.kind] ?? '' : HINT[h.what]),
    index(rs) { byKey = new Map(rs.map((r) => [r.key, r])); },
    selected: () => M.sel,
    /** The keys and moves chosen, by lane, to retime or remove together (see retime, moved, deletion). */
    choice, choiceTimes, retime, moved, pickBox, deletion,
    /** How many keys and moves are chosen (a vector's key at a time: one); whether any is a thing's (by its id). */
    picked: () => new Set([...M.picks].map((r) => { const [w, th, k, , , at] = r.split('|'); return w === 'm' ? r : `${th}|${VEC.find(([, , ks]) => ks.includes(k))?.[0] ?? k}|${at}`; })).size,
    pickedOn: (thId) => [...M.picks].some((r) => r.split('|')[1] === thId),
    deleteChosen,
    /** Whether a track's motion shows (its instruments' lanes, under it, selected or not). */
    trackShown: (id) => shownHere().includes(id),
    /** Shows a track's motion, or stops showing it. */
    toggleTrack(id) {
      const ids = shownHere();
      M.tracks[`${S.name}/${S.timeline}`] = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
      if (!M.tracks[`${S.name}/${S.timeline}`].length) delete M.tracks[`${S.name}/${S.timeline}`];
      keep(); refresh();
    },
    clear() { M.sel = null; M.picks = new Set(); },
    keyTimes() {
      const ts = [];
      for (const th of M.things) for (const P of th.props) for (const R of rowsOf(P)) for (const { c: C, lane: l } of R.cells) {
        if (l.kind === 'keys') for (const k of l.ops[0].keys[C.ch] ?? []) if (keyIn(P, C, k.t)) ts.push(k.t);
        if (l.kind === 'moves') for (const m of l.ops) if (m.t < C.t1 && m.t + m.dur > C.t0) ts.push(m.t, m.t + m.dur);
      }
      return ts;
    },
  };
}
