// Timeline model, shared by the editor (browser) and the offline mixer (tools/mix.mjs, Node): one definition
// of how clips sound, so a render plays exactly what the editor plays. No DOM, no Node APIs.
//
// A timeline, timelines/<id>.json in its project (times in seconds; `at` is the timeline position, `in`/`out` the source
// range; gain in dB):
//   { version: 2, fps, shutter (degrees, default 180), size ([w, h] px: the film's frame, default [1920, 1080]), url,
//     gi, shadows and reflections (true | false: global illumination in every scene, traced shadows from every light,
//     traced reflections in every scene, or none; left out: as the film's code asks), rendering (how they are traced,
//     each over what the film's scenes ask: { gi: { probe, rays, bounces, once, reach, hit }, shadows: { rays, denoise },
//     reflections: { denoise }, glass: { bounces } }, as a scene's gi, shadows and reflections and a glass's bounces
//     have them; a key left out: as the film's code asks),
//     samples ({ viewer, master }: how many samples a frame takes, each the frame drawn again a fraction of a pixel over
//     and across the shutter, in the viewer (and the drafts made of its frames) and in a master: SAMPLES where left
//     out; depth of field or a fast camera take more), pixelFilter (px: how far the samples spread round each pixel,
//     engine/render/filter.js; PIXEL_FILTER where left out), pixelFilterType ('box': evenly across the pixel, the width
//     not used; left out: Blackman-Harris),
//     grid: { bpm, offset, beatsPerBar, auto?, track?, map? } (engine/grid.js; auto: Detected, from the music: detectedGrid; track: the explicit tempo-master track), media: { <id>: { src, kind?, name?, w?, h?, duration?, fps?, frames? } },
//     tracks: [{ id, name, kind?, instrument?, automation?, clips: [{ id, media, at, in, out, gain, fadeIn, fadeOut, speed, tempo? }] }],
//     cues: [{ id, t, dur, label, note }] }
// A track is heard (audio, the default) or seen (kind: 'visual'): its clips images and videos (media kind 'image',
// 'video': their size w × h, a video's duration, frame rate and decoded frames, tools/media.mjs) that the film shows
// in the world where each starts (engine/runtime.js, timelineClips), later tracks over earlier ones; an image's
// in/out are any span of it (it is still).
// The things the director adds by hand (a cube, a light: engine/things.js) are clips with a `thing` in place of media, on
// a visual track of their own (things: true) that shows as rows of the timeline's Objects, not as a track.
// A clip's `speed` (default 1) is varispeed, as tape or a sampler plays: pitch and length change together — 0.5 plays
// an octave lower and twice as long, 2 an octave higher and half as long. Its source range stays in source seconds.
// A clip's `tempo` ({ bpm, offset, beatsPerBar }: offset a bar line in its source's own seconds) is its music's tempo set by
// hand; without it, the tempo is the one the studio heard (detectedGrid).

import { numbered } from '../engine/grid.js';
import { PIXEL_FILTER } from '../engine/render/filter.js';
import { PARAMS } from '../engine/sound/effects.js';

export const XF = 0.012;    // clips that touch on a track crossfade over 12 ms centred on the splice, so a join never clicks
export const EDGE = 0.004;  // a clip edge cut into its source (not a join) fades over at least 4 ms, for the same reason
const EPS = 1e-4;           // edges closer than this touch (snapping makes them exact; this absorbs float noise)

export const curves = {
  power: (x) => Math.sin((x * Math.PI) / 2),        // equal power: unrelated audio keeps its loudness through a splice
  linear: (x) => x,                                 // equal gain: both sides are the same audio (a split), sums back to 1
  smooth: (x) => (1 - Math.cos(x * Math.PI)) / 2,   // fades: raised cosine
};

/** Samples a frame takes where the timeline sets none: the viewer's (and its drafts'), a master's (enough that a thin
 *  bright edge, a rim light on a face side-on, shows as a line, not dots; Blender's EEVEE renders 64 by default too). */
export const SAMPLES = Object.freeze({ viewer: 4, master: 64 });
export const samplesOf = (tl) => ({ ...SAMPLES, ...tl.samples });
/** The agent's name unless the director names it otherwise, and what the studio calls it where room is short (a name of the
 *  director's own is its own short form). */
export const AGENT_NAME = 'Ephemerides';
export const agentShort = (name) => (name === AGENT_NAME ? 'Eph' : name);
export { PIXEL_FILTER };

/**
 * The film's page as the viewer and renders load it: its url, with what the runtime reads from the page — which of the
 * project's timelines it plays (id; `main` by default) and the timeline's settings (gi, shadows, reflections,
 * rendering, pixelFilter, pixelFilterType).
 */
export function filmPage(tl, url = tl.url, id = 'main') {
  if (!url) return '';
  const on = (k) => (typeof tl[k] === 'boolean' ? `${k}=${tl[k] ? 1 : 0}` : '');
  const rendering = tl.rendering && Object.keys(tl.rendering).length ? `rendering=${encodeURIComponent(JSON.stringify(tl.rendering))}` : '';
  const q = [id !== 'main' ? `timeline=${encodeURIComponent(id)}` : '', on('gi'), on('shadows'), on('reflections'), rendering, typeof tl.pixelFilter === 'number' ? `pixelFilter=${tl.pixelFilter}` : '', tl.pixelFilterType === 'box' ? 'pixelFilterType=box' : ''].filter(Boolean).join('&');
  return q ? `${url}${url.includes('?') ? '&' : '?'}${q}` : url;
}
/** A timeline's name: lowercase letters, digits and dashes (it is its file's name, timelines/<id>.json). */
export const TIMELINE_ID = /^[a-z0-9][a-z0-9-]*$/;

export const speedOf = (c) => c.speed || 1;
/** Whether a track's clips are seen (images, videos) rather than heard. */
export const isVisual = (t) => t?.kind === 'visual';
/** Whether a track is one of pictures, shown as a track (not the things added by hand, which show as Objects rows). */
export const isPictures = (t) => isVisual(t) && !t.things;
/** Each change of the timeline's on an added thing, as a copy naming the clip `to` in place of `from`. */
export function thingChanges(doc, from, to) {
  return (doc.overrides ?? []).filter((o) => o.on?.at === `clip:${from}`).map((o, i) => ({ ...structuredClone(o), id: `${o.id}-${to}${i ? `-${i}` : ''}`, on: { ...structuredClone(o.on), at: `clip:${to}` } }));
}
/** A notes medium: a pattern of notes ({ t, dur, note, vel }, seconds from the clip's start); each clip of it a place
 *  the pattern plays, by the instrument of the track it is on. */
export const isNotes = (m) => Array.isArray(m?.notes);
/** A track is a hybrid, as Bitwig's: it has an instrument (track.instrument: { plugin }, { sfz }, { sampler } or
 *  { named }: live.js), which plays its notes clips, and its effects, which every clip on it plays through, notes or
 *  sound. Its instrument's automation is track.automation[INSTRUMENT] (automation.js). */
export const INSTRUMENT = 'instrument';
/** The instrument a track's notes play when it has none chosen: Vial's pluck (Vial, the studio's synth: a preset of the
 *  studio's own, assets/presets/Vial/). */
export const DEFAULT_INSTRUMENT = Object.freeze({ plugin: 'Vial', state: 'presets/Vial/pluck.vital' });
export const clipEnd = (c) => c.at + (c.out - c.in) / speedOf(c);
/** A track's notes clips (media: the timeline's). */
export const notesClips = (track, media) => (track?.clips ?? []).filter((c) => isNotes(media?.[c.media]));
/** The parameters a track's instrument has automated: the track's own and its notes clips' patterns' (automation.js). */
export const automatedKeys = (track, media) => [...new Set([...notesClips(track, media).flatMap((c) => Object.keys(media[c.media].automation ?? {})), ...Object.keys(track?.automation?.[INSTRUMENT] ?? {})])];
export const isAutomated = (track, media) => automatedKeys(track, media).length > 0;
/** The notes of notes medium `id` sounding at timeline time t, where its clips play it: [{ note, vel }]. */
export function soundingNotes(doc, id, t) {
  const notes = doc.media?.[id]?.notes, out = [];
  if (!notes) return out;
  for (const tr of doc.tracks ?? []) for (const c of tr.clips) {
    if (c.media !== id || t < c.at || t >= clipEnd(c)) continue;
    const m = c.in + (t - c.at) * speedOf(c);
    for (const n of notes) if (n.t <= m && m < n.t + n.dur) out.push({ note: n.note, vel: n.vel });
  }
  return out;
}
export const dbGain = (db) => 10 ** ((db || 0) / 20);

/** What each clip plays: its span on the timeline (crossfade handles included) and the gain ramps over it. */
export function regions(tl, durations = {}) {
  const out = [];
  for (const tr of tl.tracks.filter((t) => !isVisual(t))) {   // (what is heard: a visual track's clips are seen)
    const clips = [...tr.clips].sort((a, b) => a.at - b.at);
    clips.forEach((c, i) => {
      const prev = clips[i - 1], next = clips[i + 1], end = clipEnd(c), h = XF / 2;
      const joinIn = !!prev && Math.abs(clipEnd(prev) - c.at) < EPS, joinOut = !!next && Math.abs(next.at - end) < EPS;
      const same = (a, b) => a.media === b.media && Math.abs(a.out - b.in) < EPS && speedOf(a) === speedOf(b);   // a split, still contiguous in the source
      const a0 = joinIn ? c.at - h : c.at, a1 = joinOut ? end + h : end;
      const ramps = [];
      if (joinIn) ramps.push({ t0: c.at - h, t1: c.at + h, curve: same(prev, c) ? 'linear' : 'power', out: false });
      if (joinOut) ramps.push({ t0: end - h, t1: end + h, curve: same(c, next) ? 'linear' : 'power', out: true });
      // edges at the very start/end of a file keep their attack/tail; edges cut mid-file get at least EDGE
      const fi = Math.max(c.fadeIn || 0, !joinIn && c.in > EPS ? EDGE : 0);
      const fo = Math.max(c.fadeOut || 0, !joinOut && c.out < (durations[c.media] ?? Infinity) - EPS ? EDGE : 0);
      if (fi) ramps.push({ t0: a0, t1: c.at + fi, curve: 'smooth', out: false });
      if (fo) ramps.push({ t0: end - fo, t1: a1, curve: 'smooth', out: true });
      out.push({ clip: c, track: tr.id, joinIn, joinOut, a0, a1, gain: dbGain(c.gain), ramps });
    });
  }
  return out;
}

/** Gain of one ramp at timeline time t. */
export function ramp(r, t) {
  if (t <= r.t0) return r.out ? 1 : 0;
  if (t >= r.t1) return r.out ? 0 : 1;
  const x = (t - r.t0) / (r.t1 - r.t0);
  return curves[r.curve](r.out ? 1 - x : x);
}

/** Adds each region's clip, with its gain and ramps, into L and R: n samples of the timeline from sample `from` (L[0] is
 *  sample `from`). Each sample is worked out on its own, so any window of it is the same as the whole. */
export function addClips(rs, media, sr, L, R, n, from = 0) {
  const to = from + n;
  for (const r of rs) {
    const ch = media[r.clip.media].channels, cl = ch[0], cr = ch[1] ?? cl, sp = speedOf(r.clip);
    if (sp === 1) {
      // whole-sample offset into the source, so a clip plays its samples untouched (no interpolation)
      const off = Math.round(r.clip.in * sr) - Math.round(r.clip.at * sr);
      const i0 = Math.max(Math.round(r.a0 * sr), -off, 0, from), i1 = Math.min(Math.round(r.a1 * sr), cl.length - off, to);
      for (let i = i0; i < i1; i++) {
        let g = r.gain;
        for (const p of r.ramps) g *= ramp(p, i / sr);
        L[i - from] += cl[i + off] * g; R[i - from] += cr[i + off] * g;
      }
      continue;
    }
    // varispeed: the source is read `sp` samples per output sample, between samples by 4-point (Catmull-Rom)
    // interpolation (no anti-aliasing filter: fine for the few semitones a sound is pitched, not for octaves up)
    const s0 = r.clip.in * sr - r.clip.at * sr * sp;
    const i0 = Math.max(Math.round(r.a0 * sr), 0, from), i1 = Math.min(Math.round(r.a1 * sr), to);
    for (let i = i0; i < i1; i++) {
      const s = s0 + i * sp;
      if (s < 0 || s >= cl.length - 1) continue;
      let g = r.gain;
      for (const p of r.ramps) g *= ramp(p, i / sr);
      const k = Math.floor(s), f = s - k;
      L[i - from] += catmull(cl, k, f) * g; R[i - from] += catmull(cr, k, f) * g;
    }
  }
}

// ---------- the mixer: a fader, pan, mute/solo and effects on each audio track, and on the master ----------
// An audio track may have { volume (dB, 0), pan (−1…1, 0), mute, solo, fx: [{ type, on?, …params }] }, the timeline
// { master: { volume?, fx? } }. type is one of effects.js's (eq: { bands: [{ type, freq, gain, q }] }); on: false
// bypasses it; a reverb may name an impulse response by media id (`ir`). Order: a track's clips summed → its effects →
// volume and pan → (mute, solo) → the tracks summed → master effects → master volume, played live (live.js).

export const FX = Object.keys(PARAMS).filter((t) => t !== 'roomIR');   // (roomIR makes an impulse response; it is not a processor)
/** A new EQ's bands: a low shelf, two peaks, a high shelf, all flat. */
export const eqBands = () => [
  { type: 'lowshelf', freq: 100, gain: 0, q: 0.7071 }, { type: 'peak', freq: 400, gain: 0, q: 1 },
  { type: 'peak', freq: 2500, gain: 0, q: 1 }, { type: 'highshelf', freq: 8000, gain: 0, q: 0.7071 },
];
/** A new effect of a type, with its defaults written out so they show in the timeline. */
export function newFx(type) {
  if (type === 'eq') return { type, bands: eqBands() };
  return { type, ...Object.fromEntries(Object.entries(PARAMS[type]).filter(([, d]) => typeof d.value !== 'object').map(([k, d]) => [k, d.value])) };
}
/** The signal between samples k and k + 1, at fraction f. */
function catmull(x, k, f) {
  const p0 = x[Math.max(0, k - 1)], p1 = x[k], p2 = x[k + 1], p3 = x[Math.min(x.length - 1, k + 2)];
  return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
}

/** A timeline's text: one line per medium, clip and cue, so `git diff` reads as a list of edits. */
export function format(doc) {
  // (an array of plain values, like a point, stays on one line; so does an object of plain values and such arrays)
  const plain = (x) => !x || typeof x !== 'object';
  const flat = (x) => plain(x) || (Array.isArray(x) && x.length > 0 && x.every(plain));
  // (as JSON.stringify: an object's undefined values are left out, an array's are null)
  const f = (v, ind) => {
    if (v === undefined) return 'null';
    if (Array.isArray(v) && v.length && v.every(plain)) return `[${v.map((x) => JSON.stringify(x) ?? 'null').join(', ')}]`;
    if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${ind}  ${f(x, `${ind}  `)}`).join(',\n')}\n${ind}]` : '[]';
    if (v && typeof v === 'object') {
      const e = Object.entries(v).filter(([, x]) => x !== undefined && typeof x !== 'function');
      if (!e.length) return '{}';
      if (e.every(([, x]) => flat(x))) return `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${f(x, ind)}`).join(', ')} }`;
      return `{\n${e.map(([k, x]) => `${ind}  ${JSON.stringify(k)}: ${f(x, `${ind}  `)}`).join(',\n')}\n${ind}}`;
    }
    return JSON.stringify(v);
  };
  return `${f(doc, '')}\n`;
}

export const blank = (url = '') => ({
  version: 2, fps: 60, url, grid: { auto: true, bpm: 120, offset: 0, beatsPerBar: 4 }, media: {},
  tracks: [{ id: 'a1', name: 'Audio 1', clips: [] }], cues: [],
});

/**
 * The grid the music makes (Detected: grid.auto): each song's tempo map (music: media id → its analysis, tools/music.mjs:
 * the steady tempos its sure beats keep, and where they change) or the tempo set by hand on its clip (clip.tempo), from
 * where the song's clip starts until the next song's (the first from the film's start), its speed and trims followed — a
 * song at 1.1× is 10% faster, its bar lines where they play. A clip shorter than two of its bars, or of a sound with no
 * steady beat (a voice, an effect: no tempo map), sets nothing; a part that carries on the one before it (the next piece
 * of a split song) adds none. → { auto, bpm, offset, beatsPerBar, media (the first part's: the song's id), map (where
 * there are two or more parts: each also its song, and its speed if not 1) }, or null while no clip has a tempo (the grid
 * is then left as it is).
 */
export function detectedGrid(doc, music = {}) {
  const r = (x, k = 1e4) => Math.round(x * k) / k, mod = (a, b) => ((a % b) + b) % b, songs = [], tempoTrack = doc.grid?.track;
  for (const tr of (doc.tracks ?? []).filter((t) => !isVisual(t) && (!tempoTrack || t.id === tempoTrack))) for (const c of tr.clips) {
    const map = c.tempo ? [{ t: 0, ...c.tempo }] : music[c.media]?.map, sp = speedOf(c), film = (s) => c.at + (s - c.in) / sp;
    if (!map?.length) continue;
    const ps = map.filter((p, i) => (map[i + 1]?.t ?? Infinity) > c.in && (!i || p.t < c.out));
    if (clipEnd(c) - c.at < (2 * 60 * ps[0].beatsPerBar) / (ps[0].bpm * sp)) continue;
    songs.push({ t: c.at, len: clipEnd(c) - c.at, parts: ps.map((p) => {
      const bar = (60 * p.beatsPerBar) / (p.bpm * sp), offset = r(mod(film(p.offset), bar)), from = Math.max(c.at, film(p.t));
      // (a part that starts on a bar line of its own, as a change of tempo does: from just before it, so that it is the
      // part's first though the times are rounded)
      const line = offset + Math.ceil((from - offset - 1e-3) / bar) * bar;
      return { t: line < from ? Math.floor(line * 1e4) / 1e4 : r(from), bpm: r(p.bpm * sp, 1e3), offset, beatsPerBar: p.beatsPerBar, media: c.media, ...(sp !== 1 ? { speed: sp } : {}) };
    }) });
  }
  if (!songs.length) return null;
  songs.sort((a, b) => a.t - b.t || b.len - a.len);
  const kept = songs.filter((s, i) => !i || s.t > songs[i - 1].t + 1e-3), map = [];   // (two from the same moment: the longer)
  kept.forEach((s, i) => {
    for (const p of s.parts) {
      if (p.t >= (kept[i + 1]?.t ?? Infinity) - 1e-6) break;
      const last = map.at(-1), bar = (60 / p.bpm) * p.beatsPerBar;
      if (last && Math.abs(last.bpm - p.bpm) < 0.01 && last.beatsPerBar === p.beatsPerBar && Math.min(mod(p.offset - last.offset, bar), mod(last.offset - p.offset, bar)) < 0.005) continue;
      map.push(p);
    }
  });
  const { bpm, offset, beatsPerBar, media } = map[0];
  return { auto: true, bpm, offset, beatsPerBar, media, ...(tempoTrack ? { track: tempoTrack } : {}), ...(map.length > 1 ? { map: numbered(map) } : {}) };
}

/** Whether two grids are the same (key order aside). */
export const sameGrid = (a = {}, b = {}) => ['auto', 'bpm', 'offset', 'beatsPerBar', 'media', 'track'].every((k) => a[k] === b[k]) && JSON.stringify(a.map ?? null) === JSON.stringify(b.map ?? null);

/**
 * Makes room in a timeline (or takes it out): everything from `at` on moves `by` seconds — cues (a range across `at`
 * grows, or shrinks, with it), clips, and the director's changes' keys, moves and rates — what an editor's ripple does
 * when a scene is lengthened. What is before `at` stays. → { doc (a new one), moved: { cues, clips, keys } }.
 */
export function retime(doc, at, by) {
  const d = structuredClone(doc), moved = { cues: 0, clips: 0, keys: 0 };
  const after = (t) => t >= at - 1e-6, to = (t) => Math.round(Math.max(0, t + by) * 1e6) / 1e6;
  for (const q of d.cues ?? []) {
    if (after(q.t)) { q.t = to(q.t); moved.cues++; } else if (q.dur > 0 && q.t + q.dur > at + 1e-6) { q.dur = Math.max(0, Math.round((q.dur + by) * 1e6) / 1e6); moved.cues++; }
  }
  for (const tr of d.tracks ?? []) for (const c of tr.clips) if (after(c.at)) { c.at = to(c.at); moved.clips++; }
  // a change's lanes (keys [t, v, ease?], moves { t }, a rate's from), and its values as first written (keyframes [{ t, v }])
  const lane = (L) => {
    if (Array.isArray(L?.keys)) L.keys = L.keys.map((k) => (Array.isArray(k) && after(k[0]) ? (moved.keys++, [to(k[0]), ...k.slice(1)]) : k));
    for (const m of L?.moves ?? []) if (after(m.t)) { m.t = to(m.t); moved.keys++; }
    if (L?.kind === 'rate' && typeof L.from === 'number' && after(L.from)) { L.from = to(L.from); moved.keys++; }
  };
  const keyframes = (p) => (Array.isArray(p) && p.length && typeof p[0] === 'object' && 't' in p[0] ? p.map((k) => (after(k.t) ? (moved.keys++, { ...k, t: to(k.t) }) : k)) : p);
  for (const o of d.overrides ?? []) {
    for (const k of Object.keys(o.props ?? {})) { o.props[k] = keyframes(o.props[k]); for (const L of o.props[k]?.lanes ?? []) lane(L); }
    for (const ls of Object.values(o.lanes ?? {})) for (const L of ls) lane(L);   // (a motion's lanes of the director's own)
    for (const op of Object.values(o.ops ?? {})) lane(op);   // (an operator's keys, as changed)
  }
  return { doc: d, moved };
}
