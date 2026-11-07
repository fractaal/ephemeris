// Automation: a track's instrument's parameters moved over the timeline as motions, whatever the instrument (device.js).
// Each parameter is a stack of lanes (keys, moves, rate, wander: engine/motion.js) over its base (its value in the
// instrument), as the lanes panel shows and edits them (lanes.js), in two layers:
//   the clip's    kept in a notes medium (a pattern), in its own time (seconds from its start, as its notes are):
//                 { media: { <id>: { notes, automation: { <parameter key>: { lanes, order?, muted? } } } } }
//                 played wherever a clip of it plays (each clip's in, at and speed placing it), by the instrument of
//                 the track it is on, so it moves and repeats with its clips; between them a parameter holds where the
//                 last clip that moves it left it
//   the track's   kept on the track, in the timeline's time, over the clips' (on top):
//                 { instrument, automation: { instrument: { <parameter key>: { lanes, order?, muted? } } } }
// (a parameter's key: a plugin's title, a native instrument's path: device.js). Values are 0–1 of the parameter's range.
// Evaluated with the engine's own code, here and in renders: a plugin's into the points its host takes (native/plughost:
// automation), a native instrument's into the points its control() takes (controlPoints).
// A film's sound code (its sound.js: engine/score.js) adds a third, between them: a parameter's motion in the
// timeline's time, over the clips' lanes and under the track's, with the director's changes to it kept in the
// timeline's overrides by its id, as a film motion's are (engine/score.js played: the timeline with it in).
import { Stack, asLanes } from '../engine/motion.js';
import '../engine/time.js';   // (names the eases a lane may choose)
import { fromNorm } from './device.js';
import { speedOf, clipEnd, automatedKeys, notesClips, INSTRUMENT } from './model.js';
import { played } from '../engine/score.js';

const STEP = 256;    // samples between evaluations (~5 ms)
const EPS = 0.002;   // a change smaller than this is not sent (plugins smooth between the values they are given)
const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** A parameter's stack: its lanes over its base (below(t): what they work on, if not the base: the clips' layer). */
export function paramStack(p, base, id = 'param', below = null) {
  const L = asLanes('value', p ?? { lanes: [] });
  return new Stack(null, { id, code: below ?? (() => base), local: { lanes: { value: L.lanes }, ...(L.order && { order: { value: L.order } }), ...(L.muted && { muted: { value: L.muted } }) } });
}

/** A clip's lanes (a parameter's automation in its medium: { lanes, order?, muted? }) in the timeline's time where clip c
 *  plays them, or back from it (`back`): each time, length, rate and speed in them (the pattern's time is in + (t − at) ×
 *  speed). The lanes editor works on them in the timeline's time, and keeps them in the pattern's. */
export function clipLanes(p, c, back = false) {
  const sp = speedOf(c), off = c.in - c.at * sp;   // (pattern time = sp · t + off)
  const T = back ? (t) => r6(sp * t + off) : (m) => (m - off) / sp, D = back ? (d) => r6(d * sp) : (d) => d / sp, R = back ? (r) => r6(r / sp) : (r) => r * sp;
  const lanes = (p.lanes ?? []).map((l) => {
    const o = { ...l };
    if (l.keys) o.keys = l.keys.map((k) => (Array.isArray(k) ? [T(k[0]), ...k.slice(1)] : { ...k, t: T(k.t) }));
    if (l.moves) o.moves = l.moves.map((m) => ({ ...m, t: T(m.t), dur: D(m.dur) }));
    if (l.kind === 'rate') {   // (from: the pattern's start, unless it says)
      o.rate = R(l.rate ?? 0); o.from = T(l.from ?? (back ? -off / sp : 0));
      if (back && o.from === 0) delete o.from;
    }
    if (l.kind === 'wander') {   // (smooth(m · speed + seed), m the pattern's time: sp · t + off)
      const speed = l.speed ?? 1;
      if (back) { o.speed = r6(speed / sp); o.seed = r6((l.seed ?? 0) - off * o.speed); } else { o.speed = speed * sp; o.seed = (l.seed ?? 0) + off * speed; }
      if (o.seed === 0) delete o.seed;
    }
    return o;
  });
  return { ...p, lanes };
}

/** Parameter `key` of `track`'s instrument as it plays (media: the timeline's): t (timeline s) → 0–1, its clips'
 *  automation (each notes clip playing its pattern's lanes; between clips held where the last that moves it left it, and
 *  before the first where it starts), the sound code's motion over them (in a played timeline), and the track's lanes
 *  over that. base: its value in the instrument (0–1). */
export function paramAt(track, media, key, base) {
  const tp = track?.automation?.[INSTRUMENT]?.[key];
  const clips = notesClips(track, media).filter((c) => media[c.media].automation?.[key]?.lanes?.length).sort((a, b) => a.at - b.at);
  let below = () => base;
  if (clips.length) {
    const stacks = new Map(), stackOf = (id) => stacks.get(id) ?? stacks.set(id, paramStack(media[id].automation[key], base, `${id}|${key}`)).get(id);
    below = (t) => {
      let c = clips[0];
      for (const x of clips) { if (x.at <= t) c = x; else break; }
      return stackOf(c.media).value('value', Math.min(c.out, Math.max(c.in, c.in + (t - c.at) * speedOf(c))));
    };
  }
  if (tp?.code) {   // (the code's motion, over what is below it so far)
    const s = Stack.from(tp.code, { code: below, local: tp.changes ?? {} });
    below = (t) => s.value('value', t);
  }
  if (!tp?.lanes?.length) return below;
  const s = paramStack(tp, base, `${track.id}|${INSTRUMENT}|${key}`, below);
  return (t) => s.value('value', t);
}

/** The notes clip on `track` playing at timeline time t (the last to start, where they overlap), or null. */
export const clipAt = (track, media, t) => notesClips(track, media).filter((c) => c.at <= t && t < clipEnd(c)).sort((a, b) => b.at - a.at)[0] ?? null;
/** Where a key of parameter `key` at timeline time t goes, as the lanes panel puts one (track: as played, with the
 *  sound code's motions in it): in the track's lanes where it has some for it; else on the sound code's motion of it,
 *  where there is one (your lanes on it, kept in the timeline's overrides by its id); else in the automation of the
 *  pattern a notes clip plays at t (at its pattern's time); else in the track's. { layer: 'track' | 'code' | 'clip',
 *  at (s, in that layer's time), p: the parameter's lanes there ({ lanes }), or null, medium (layer clip: the pattern's
 *  id), code: the motion (layer code) }. */
export function keyTarget(track, media, key, t) {
  const tp = track?.automation?.[INSTRUMENT]?.[key];
  if (!tp?.lanes?.length && tp?.code) return { layer: 'code', at: r6(t), p: { lanes: tp.changes?.lanes?.value ?? [] }, code: tp.code };
  const c = tp?.lanes?.length ? null : clipAt(track, media, t);
  if (c) return { layer: 'clip', at: r6(c.in + (t - c.at) * speedOf(c)), p: media[c.media]?.automation?.[key] ?? null, medium: c.media };
  return { layer: 'track', at: r6(t), p: tp?.lanes ? tp : null };
}
/** Whether a parameter's entry (p) has a key at `at` (its layer's time): in its first Keys lane. */
export const keyedAt = (p, at) => !!p?.lanes?.find((l) => l.kind === 'keys')?.keys.some((k) => Math.abs((k.t ?? k[0]) - at) < 1e-3);
/** Keys parameter `key` of track `trackId`'s instrument at timeline time t to v (0–1), or takes the key there away
 *  (`remove`), in doc d (sc: the sound code's run, engine/score.js): in the layer keyTarget names, in its first Keys lane
 *  (made if missing, aiming: held before its first key and after its last). What is left empty goes. */
export function withKey(d, trackId, key, t, v, remove = false, sc = null) {
  const tr = d.tracks.find((y) => y.id === trackId);
  if (!tr) return;
  const p = played(d, sc), k = keyTarget(p.tracks.find((y) => y.id === trackId), p.media, key, t), { layer, at } = k, m = layer === 'clip' ? d.media[k.medium] : null;
  if (layer === 'code') {   // (your lanes on the code's motion: its override, made if missing, as the lanes panel makes one)
    let o = (d.overrides ??= []).find((x) => x.stack === k.code.id);
    if (!o) d.overrides.push((o = { id: `o${Math.max(0, ...[...d.cues, ...d.overrides].map((x) => /^o(\d+)$/.exec(x.id)?.[1] ?? 0).map(Number)) + 1}`, stack: k.code.id }));
    const ls = ((o.lanes ??= {}).value ??= []);
    let lane = ls.find((l) => l.kind === 'keys');
    if (!lane) ls.push((lane = { id: `y${Date.now().toString(36).slice(-5)}`, kind: 'keys', mode: 'aim', keys: [] }));
    lane.keys = lane.keys.filter((q) => Math.abs((q.t ?? q[0]) - at) > 1e-3);
    if (!remove) lane.keys = [...lane.keys, [at, Math.round(v * 1e5) / 1e5]].sort((y, z) => (y.t ?? y[0]) - (z.t ?? z[0]));
    if (!lane.keys.length) ls.splice(ls.indexOf(lane), 1);
    if (!ls.length) delete o.lanes.value;
    if (!Object.keys(o.lanes).length) delete o.lanes;
    if (!['lanes', 'ops', 'order', 'muted', 'base'].some((f) => o[f])) d.overrides.splice(d.overrides.indexOf(o), 1);
    return;
  }
  const home = layer === 'clip' ? (m.automation ??= {}) : ((tr.automation ??= {})[INSTRUMENT] ??= {}), q = (home[key] ??= { lanes: [] });
  let lane = q.lanes.find((l) => l.kind === 'keys');
  if (!lane) q.lanes.push((lane = { id: `y${Date.now().toString(36).slice(-5)}`, kind: 'keys', mode: 'aim', keys: [] }));
  lane.keys = lane.keys.filter((x) => Math.abs((x.t ?? x[0]) - at) > 1e-3);
  if (!remove) lane.keys = [...lane.keys, [at, Math.round(v * 1e5) / 1e5]].sort((y, z) => (y.t ?? y[0]) - (z.t ?? z[0]));
  if (!lane.keys.length) q.lanes.splice(q.lanes.indexOf(lane), 1);
  if (!q.lanes.length) delete home[key];
  if (layer === 'clip') { if (!Object.keys(m.automation).length) delete m.automation; return; }
  if (!Object.keys(tr.automation[INSTRUMENT]).length) delete tr.automation[INSTRUMENT];
  if (!Object.keys(tr.automation).length) delete tr.automation;
}

/** What a track's automation of its plugin instrument sends its host (media: the timeline's), from sample 0 to `to`:
 *  [[sample, id, value], …] in order. idOf(title): the parameter's id (or null: not the plugin's); baseOf(title): its base. */
export function automationPoints(track, media, sr, to, idOf, baseOf) {
  const out = [];
  for (const title of automatedKeys(track, media)) {
    const pid = idOf(title);
    if (pid == null) continue;
    const at = paramAt(track, media, title, baseOf(title));
    let last = NaN;
    for (let i = 0; i <= to; i += STEP) {
      const v = Math.min(1, Math.max(0, at(i / sr)));
      if (!(Math.abs(v - last) < EPS)) { out.push([i, pid, Math.round(v * 1e5) / 1e5]); last = v; }
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** What a track's automation of its native instrument sets (media: the timeline's), as points its control() takes:
 *  [[sample, key, value in the param's units], …] every STEP samples from 0 to `to` where a value changes (by more than
 *  EPS of its range), each automated param's first at 0; null where it automates none of `params` (the instrument's:
 *  device.js). Made where lanes can be read (the page, Node), played where they cannot (the voice
 *  workers and the worklet: live.js automated()), as a plugin's points are played by its host. */
export function controlPoints(track, media, params, sr, to) {
  const list = automatedKeys(track, media).map((key) => {
    const p = params.find((x) => x.key === key);
    return p?.automatable && p.norm != null ? { p, at: paramAt(track, media, key, p.norm) } : null;
  }).filter(Boolean);
  if (!list.length) return null;
  const out = [];
  for (const { p, at } of list) {
    let last = NaN;
    for (let i = 0; i <= to; i += STEP) {
      const n = Math.min(1, Math.max(0, at(i / sr)));
      if (!(Math.abs(n - last) < EPS)) { out.push([i, p.key, fromNorm(p, n)]); last = n; }
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}
