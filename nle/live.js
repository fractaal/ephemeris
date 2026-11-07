// The live engine: a timeline's sound, made block by block as it plays, as a DAW makes it — its audio clips (model.js:
// their splices, fades, gains and speeds, sample for sample), its notes clips played by their instruments
// (engine/sound/instrument.js: a notes medium is a pattern, each clip of it a place it plays), each track's effects
// (engine/sound/fx.js), fader and pan, mute and solo, its sends to the timeline's buses (a shared reverb: { buses: [{ id,
// name, fx, volume, mute }] }, a track's { sends: { <bus id>: dB } }, after its fader), and the master's effects and fader.
// A compressor anywhere may listen to a track instead of what it compresses ({ type: 'compressor', sidechain: <track id> }:
// the bass ducking under the kick): it hears that track after its effects, before its fader (a muted track still
// triggers it; one that is not there is silence); the track it listens to plays first. It runs in the editor's
// AudioWorklet (liveworklet.js) while it plays, and in a render (tools/mix.mjs) from the start, where it is exactly what
// the editor played from the start: nothing in it depends on how the sound is cut into blocks. In the editor
// (streamNotes) its samplers are played by workers off the audio thread (voices.js) and streamed in, as plugins (Vial,
// the studio's synth, among them) are, so a dense score plays on several cores; a render plays them here. Effects that
// look ahead (a limiter) make their track late: the others are delayed to match, and the whole is played that much ahead, so what comes out
// at a sample is the timeline at that sample.
//
//   const live = createLive({ sr, streamNotes })   // streamNotes: every sampler is a stream too (voices.js),
//                                      // under its track's pluginKey, its sound given by setPluginSound
//   live.addMedia(id, channels)       // an audio medium's decoded samples (at sr)
//   live.setResolved(key, spec)        // a sampler instrument's data and samples, for the tracks whose instrument has
//                                      // this key (instrumentKey): { sampler, samples }
//   live.setPluginSound(key, sound)    // a plugin instrument's sound (made by its host, tools/plugins.mjs, from the notes
//                                      // noteEvents gives), for a track (pluginKey): { read(L, R, at, n) }
//                                      // adds its samples at..at+n (silence where it has none yet)
//   live.setControls(key, points)      // a native instrument's automation for a track (pluginKey): the
//                                      // points its control() takes (automation.js controlPoints), made where lanes are read
//   live.irsFrom(port)                 // reverbs' impulse responses made on the other side of a port (nle/irworker.js),
//                                      // not here: a reverb plays its last until its new one comes
//   live.set(timeline)                 // what to play (again whenever it changes: effects and instruments keep their state)
//   live.seek(t)                       // play from t (s): what rang before is forgotten
//   live.process(L, R, n)              // the next n samples, into L and R
//   live.monitor(keys, from) · live.processMonitor(L, R, n)   // while stopped: plugin instruments (pluginKey) heard as
//                                      // they are played, through their tracks, on a clock of their own from `from`
//   live.hear(track, L, R)             // a note tried now (the piano roll's, the Instrument panel's), heard through its
//                                      // track as the timeline plays it, playing or stopped; live.hearing(): any still ringing
//   live.levels()                      // each track's (and the master's) { peak, rms } since last asked
import { regions, addClips, isVisual, dbGain, speedOf, clipEnd, curves } from './model.js';
import { createFx } from '../engine/sound/fx.js';
import { createInstrument } from '../engine/sound/instrument.js';

const MAX = 4096;              // the longest block (a worklet's is 128; a render may ask for more)
const SMOOTH = 0.005;          // seconds a fader, pan or mute takes to reach a new value (no click)
const isNotesMedium = (m) => Array.isArray(m?.notes);
/** A track's instrument, as the key its resolved form is kept under (setResolved). */
export const instrumentKey = (spec) => JSON.stringify(spec ?? null);
/** Whether an instrument needs its sampler data and samples resolved first (a plugin's host plays it as it is; the
 *  Ephemeris Synth's, gone, plays nothing). */
export const needsResolving = (spec) => !!spec && !spec.synth && !spec.preset && !spec.plugin;
/** The samples of a sampler instrument that notes ([{ note, vel }]) can play: a region's, when a note is in its keys and
 *  velocities (as the sampler hears it: vel 0–1 → 1–127). A big program has hundreds of recordings (a cymbal's velocity
 *  layers and round robins on every key), of which a pattern plays a few: only those need decoding. */
export function samplesPlayed(inst, notes) {
  const hits = [...new Set(notes.map((n) => `${Math.round(n.note)} ${Math.min(127, Math.max(1, Math.round((n.vel ?? 0.8) * 127)))}`))].map((x) => x.split(' ').map(Number));
  const want = new Set();
  for (const r of inst?.regions ?? []) {
    if (!r.sample || want.has(r.sample)) continue;
    const [klo, khi] = r.key ?? [0, 127], [vlo, vhi] = r.vel ?? [0, 127];
    if (hits.some(([k, v]) => k >= klo && k <= khi && (r.xfVel || (v >= vlo && v <= vhi)))) want.add(r.sample);   // (a velocity crossfade: its own ranges)
  }
  return want;
}
/** A track's instrument as it is played: a sampler once resolved (`resolved`: instrument key → its form; else
 *  null until then), a plugin as itself (its host plays it). */
export function playableInstrument(spec, resolved) {
  if (spec?.plugin) return { plugin: spec };
  if (spec?.synth || spec?.preset) return null;
  return resolved.get(instrumentKey(spec)) ?? null;
}
/** The notes a timeline's tracks play with the instrument whose key this is (each track's notes clips' patterns). */
export const notesWith = (tl, key) => (tl.tracks ?? []).filter((t) => t.instrument && instrumentKey(t.instrument) === key)
  .flatMap((t) => [...new Set(t.clips.map((c) => c.media))].flatMap((id) => (isNotesMedium(tl.media?.[id]) ? tl.media[id].notes : [])));
/** The key a track's plugin instrument's sound (and a native one's automation) is kept under: its track's id. */
export const pluginKey = (track) => String(track);
/** The live engine's place for a track's instrument (st.insts: one, under this name). */
const ONE = 'instrument';
export const PLUGIN_TAIL = 5;   // seconds a plugin's last note may ring (its reverb and delay included; renders cut the silence)

/** A native instrument played with points of its params ([[sample, key, value], …]: automation.js controlPoints), each
 *  given to its control() at its sample, the state at a seek given at once; the same instrument otherwise. setPoints
 *  takes them as they are now. No lanes are read here (the worklet and the voice workers cannot read them). */
export function automated(inst) {
  const bl = new Float32Array(MAX), br = new Float32Array(MAX);
  let at = 0, pts = null, next = 0;
  // (every point at or before sample s, the last of each param: its state there)
  const seekTo = (s) => {
    next = 0;
    if (!pts) return;
    const vals = {};
    while (next < pts.length && pts[next][0] <= s) { vals[pts[next][1]] = pts[next][2]; next++; }
    if (Object.keys(vals).length) inst.control(vals);
  };
  return {
    noteOn: (...a) => inst.noteOn(...a), noteOff: (...a) => inst.noteOff(...a), cc: (...a) => inst.cc?.(...a),
    set: (spec) => inst.set(spec), get tail() { return inst.tail; },
    reset(s = 0) { at = s; inst.reset(s); seekTo(s); },
    setPoints(p) { pts = p?.length ? p : null; seekTo(at); },
    process(L, R, n) {
      if (!pts) { inst.process(L, R, n); at += n; return; }
      for (let i = 0; i < n;) {
        while (next < pts.length && pts[next][0] <= at) {
          const s0 = pts[next][0], vals = {};
          while (next < pts.length && pts[next][0] === s0) { vals[pts[next][1]] = pts[next][2]; next++; }
          inst.control(vals);
        }
        const m = Math.min(n - i, MAX, next < pts.length ? pts[next][0] - at : Infinity);
        bl.fill(0, 0, m); br.fill(0, 0, m);
        inst.process(bl, br, m);
        for (let k = 0; k < m; k++) { L[i + k] += bl[k]; R[i + k] += br[k]; }
        i += m; at += m;
      }
    },
  };
}

/** Every note a track's notes clips play (only those of `medium`, if given), as events at samples, in order (a note past
 *  its clip's end is cut there; at one sample, notes end before notes start). */
export function noteEvents(tr, tl, sr, medium) {
  const ev = [];
  for (const c of tr.clips) {
    const m = tl.media?.[c.media];
    if (!isNotesMedium(m) || (medium && c.media !== medium)) continue;
    const sp = speedOf(c);
    for (const n of m.notes) {
      if (n.t < c.in - 1e-9 || n.t >= c.out) continue;
      const on = Math.round((c.at + (n.t - c.in) / sp) * sr), off = Math.round((c.at + (Math.min(n.t + n.dur, c.out) - c.in) / sp) * sr);
      ev.push({ s: on, on: true, note: n.note, vel: n.vel ?? 0.8, media: c.media }, { s: Math.max(on + 1, off), on: false, note: n.note, media: c.media });
    }
  }
  return ev.sort((a, b) => a.s - b.s || (a.on === b.on ? 0 : a.on ? 1 : -1));
}

/** A track's notes clips as the gain over its instrument's sound (one instrument plays them all): each clip's
 *  gain and fades from where it starts until the next one starts. A note still ringing after its clip ends rings at the
 *  clip's gain, unless the clip fades out: then it is silent from the clip's end, as an audio clip is. null where every
 *  clip is at 0 dB without fades (the sound as it is). */
export function notesEnvelope(clips) {
  if (clips.every((c) => !c.gain && !c.fadeIn && !c.fadeOut)) return null;
  return [...clips].sort((a, b) => a.at - b.at).map((c) => ({ at: c.at, end: clipEnd(c), g: dbGain(c.gain), fi: c.fadeIn || 0, fo: c.fadeOut || 0 }));
}
/** That gain at timeline time t (s). */
export function envelopeAt(env, t) {
  let c = env[0];
  for (const e of env) { if (e.at > t) break; c = e; }
  if (t < c.at) return c.fi ? 0 : c.g;
  let g = c.g;
  if (c.fi && t < c.at + c.fi) g *= curves.smooth((t - c.at) / c.fi);
  if (c.fo) g *= t >= c.end ? 0 : t > c.end - c.fo ? curves.smooth((c.end - t) / c.fo) : 1;
  return g;
}

// a pan's balance (the far side fades, the near side stays) and a fader, as the gains on each side
const gains = (db, pan = 0, on = true) => {
  const g = on ? dbGain(db) : 0;
  return [g * (pan > 0 ? Math.cos(pan * Math.PI / 2) : 1), g * (pan < 0 ? Math.cos(-pan * Math.PI / 2) : 1)];
};

export function createLive({ sr, streamNotes = false }) {
  const media = {}, resolved = new Map(), sounds = new Map(), controls = new Map(), k = 1 - Math.exp(-1 / (SMOOTH * sr));
  const versions = new Map();  // instrument key → how many times its resolved form changed (more samples, a setting dragged)
  const tracks = new Map();    // track id → its state, kept across set() (its effects and instruments go on ringing)
  let order = [], run = [], buses = [], master = newBus('master'), pos = 0, durations = {}, lead = 0, soloed = false;
  let monitor = null;          // while stopped: { keys, at }, the plugins heard as they are played (monitor())
  let tried = [];              // notes tried now (hear()): { track, L, R, i, end (its sound, then its track's effects' tail) }
  const busById = new Map();   // bus id → its state, kept across set() (its reverb goes on ringing)
  const skipL = new Float32Array(MAX), skipR = new Float32Array(MAX), NOKEY = { bL: new Float32Array(MAX), bR: new Float32Array(MAX) };
  const noteL = new Float32Array(MAX), noteR = new Float32Array(MAX);   // (an instrument's block, before its clips' gain)

  function newBus(id) { return { id, fx: [], gl: 1, gr: 1, tl: 1, tr: 1, peak: 0, sum: 0, count: 0 }; }
  // a bus's effects brought to its specs: a processor kept where the type is the same (its params set), made where not
  function syncFx(bus, specs = []) {
    const was = bus.fx;
    bus.fx = specs.map((spec, i) => {
      const old = bus.fx[i];
      // (kept where it can take the change: an impulse response, a lookahead or an oversampling is a new processor)
      if (old?.spec.type === spec.type && old.spec.ir === spec.ir && old.spec.lookahead === spec.lookahead && old.spec.oversample === spec.oversample) { if (JSON.stringify(old.spec) !== JSON.stringify(spec)) old.p.set(spec); old.spec = spec; return old; }
      const f = { spec, id: ++fxN };
      f.p = createFx(spec, { sr, media, ready: irPort && readyFor(f) });
      return f;
    });
    for (const f of was) if (!bus.fx.includes(f)) asking.delete(f.id);
  }
  // ---------- reverbs' impulse responses (irsFrom): one takes 50–400 ms to make, a block 2.7 ms to play, so where the
  // engine plays on an audio thread a reverb's (a knob turned: its size, its decay) is made by a worker, and the reverb
  // plays its last until it comes. Each asks for the one it needs now (the worker makes the newest each asked for), and
  // takes each that comes: while a knob turns, the ones on the way to where it stops.
  let irPort = null, fxN = 0;
  const asking = new Map();   // an effect's id → it, while its impulse response is being made
  function readyFor(f) {
    return (spec, key) => {
      if (f.came) { const c = f.came; f.came = null; return c; }
      if (f.asked !== key) {
        f.asked = key; asking.set(f.id, f);
        irPort.postMessage({ want: { id: f.id, key, spec, ch: typeof spec.ir === 'string' ? media[spec.ir]?.channels ?? null : null } });
      }
      return null;
    };
  }
  function irCame({ id, key, ir }) {
    const f = asking.get(id);
    if (!f) return;
    if (f.asked === key) { asking.delete(id); f.asked = null; }
    f.came = { key, ir }; f.p.set(f.spec); f.came = null;   // (taken, unless what it plays already is what it needs)
  }
  // ---------- taps (audio.js tap): an effect's sound just before and after it, for its view (nle/fxview.js), sent a hop
  // at a time on the view's port: each hop in a buffer the view gives back (none free: that hop is left out — the audio
  // thread makes none and waits for none). A hop: its HOP samples before the effect, then after it (left and right
  // averaged), with how far the effect turned the sound down over it (a compressor's, a limiter's reduction, dB).
  const HOP = 1024, taps = new Map();   // strip id → its taps: { key, at (its place among the strip's effects that are on), … }
  function tap(key, id, at, port) {
    untap(key);
    const t = { key, at, port, free: [], buf: null, i: 0, red: 0 };
    for (let k = 0; k < 8; k++) t.free.push(new Float32Array(2 * HOP));
    port.onmessage = ({ data }) => { if (data.give?.length === 2 * HOP) t.free.push(data.give); };
    taps.set(id, [...(taps.get(id) ?? []), t]);
  }
  function untap(key) {
    for (const [id, list] of taps) {
      const rest = list.filter((t) => { if (t.key !== key) return true; t.port.onmessage = null; t.port.close(); return false; });
      if (rest.length) taps.set(id, rest); else taps.delete(id);
    }
  }
  // (a block's samples into the tap's hop, before the effect or after it; a hop full, sent. A hop starts with a buffer
  // or, none free, is left out; a block past the hop's end — blocks are 128 samples, a hop 8 of them — has its rest left out)
  function tapInto(t, L, R, n, after, p) {
    if (!after) t.buf ??= t.free.pop() ?? null;
    const m = Math.min(n, HOP - t.i);
    if (t.buf) { const b = t.buf, at = (after ? HOP : 0) + t.i; for (let j = 0; j < m; j++) b[at + j] = (L[j] + R[j]) * 0.5; }
    if (!after) return;
    if (p?.reduction != null) t.red = Math.max(t.red, Math.abs(p.reduction));
    t.i += m;
    if (t.i >= HOP) { if (t.buf) t.port.postMessage({ hop: t.buf, red: t.red }, [t.buf.buffer]); t.buf = null; t.i = 0; t.red = 0; }
  }
  // a strip's effects on its sound, those watched tapped either side
  function runFx(st, L, R, n) {
    const ts = taps.get(st.id);
    for (let i = 0; i < st.fx.length; i++) {
      const f = st.fx[i];
      if (ts) for (const t of ts) if (t.at === i) tapInto(t, L, R, n, false);
      f.p?.process(L, R, n, f.key?.bL, f.key?.bR);
      if (ts) for (const t of ts) if (t.at === i) tapInto(t, L, R, n, true, f.p);
    }
  }
  // a notes medium's instrument for a track (a plugin: what its host made of the same notes; streamed, every one)
  const playable = (spec) => (streamNotes && !spec?.plugin ? { plugin: spec, voices: true } : playableInstrument(spec, resolved));
  // a plugin's (or a streamed) instrument: its sound read at the samples played (its notes are its host's)
  function streamed(key, at) {
    return { noteOn() {}, noteOff() {}, cc() {}, set() {}, reset(s = 0) { at = s; }, tail: PLUGIN_TAIL, process(L, R, n) { sounds.get(key)?.read(L, R, at, n); at += n; } };
  }

  const live = {
    addMedia(id, channels) { media[id] = { channels }; durations[id] = channels[0].length / sr; },
    removeMedia(id) { delete media[id]; delete durations[id]; },
    setResolved(key, spec) { resolved.set(key, spec); versions.set(key, (versions.get(key) ?? 0) + 1); },
    setPluginSound(key, sound) { if (sound) sounds.set(key, sound); else sounds.delete(key); },
    setControls(key, points) { if (points?.length) controls.set(key, points); else controls.delete(key); },
    /** One strip's mix as `s` has it (a value being dragged: audio.js tweak), the timeline not set again: its effects'
     *  values, its fader, pan and sends to the buses it has (id: a track's, `bus:<id>`, `master`). Its effects as they
     *  are: one added, taken away, moved or switched off, or a send made, waits for set. */
    tweak(id, s) {
      const st = id === 'master' ? master : id.startsWith('bus:') ? busById.get(id.slice(4)) : tracks.get(id);
      const fx = (s.fx ?? []).filter((e) => e.on !== false);
      if (!st || fx.length !== st.fx.length || fx.some((e, i) => e.type !== st.fx[i].spec.type)) return;
      syncFx(st, fx);
      // (a processor made anew, an impulse response changed: its sidechain as set gives it)
      for (const f of st.fx) if (!('key' in f)) { const k = f.spec.sidechain; f.key = k && k !== st.id ? tracks.get(k) ?? NOKEY : null; }
      if (st === master) [st.tl, st.tr] = gains(s.volume, 0);
      else if (id.startsWith('bus:')) [st.tl, st.tr] = gains(s.volume, s.pan, !s.mute);
      else {
        [st.tl, st.tr] = gains(s.volume, s.pan, !s.mute && (!soloed || !!s.solo));
        for (const x of st.sends ?? []) { const d = s.sends?.[[...busById].find(([, b]) => b === x.bus)?.[0]]; x.t = d == null ? 0 : dbGain(d); }
      }
    },
    /** Watches an effect (`at`: its place among the effects of strip `id` that are on): its sound either side of it sent
     *  on `port` a hop at a time (a view's: nle/fxview.js); untap(key) stops. */
    tap, untap,
    /** Reverbs made from now on have their impulse responses made on the other side of `port` (nle/irworker.js): a
     *  want { id, key, spec, ch (a medium's channels, for one named by id) } sent for each, the made { id, key, ir }
     *  (fx.js reverbReady's) taken as it comes. */
    irsFrom(port) { irPort = port; port.onmessage = ({ data }) => irCame(data); },
    /** What to play: the timeline as it is now. */
    set(tl) {
      const audio = tl.tracks.filter((t) => !isVisual(t)), solo = (soloed = audio.some((t) => t.solo));
      const rs = regions(tl, durations).filter((r) => media[r.clip.media]);
      const seen = new Set();
      order = audio.map((t) => {
        let st = tracks.get(t.id);
        if (!st) { st = { ...newBus(t.id), insts: new Map(), ev: [], next: 0, bL: new Float32Array(MAX), bR: new Float32Array(MAX) }; tracks.set(t.id, st); }
        seen.add(t.id);
        st.rs = rs.filter((r) => r.track === t.id);
        syncFx(st, (t.fx ?? []).filter((e) => e.on !== false));
        [st.tl, st.tr] = gains(t.volume, t.pan, !t.mute && (!solo || !!t.solo));   // (!!: a track not soloed has no solo, and gains() takes undefined as on)
        // its instrument, which plays its notes clips (kept while it stays the same; set where changed)
        const want = new Map(), notes = t.clips.filter((c) => isNotesMedium(tl.media?.[c.media]));
        if (t.instrument && notes.length) want.set(ONE, t.instrument);
        for (const [id, x] of st.insts) if (!want.has(id)) st.insts.delete(id);
        for (const [id, spec] of want) {
          const key = instrumentKey(spec), ver = versions.get(key) ?? 0, had = st.insts.get(id), p = playable(spec), kind = p?.voices ? 'voices' : p?.plugin ? 'plugin' : 'sampler';
          if (had?.key === key && had.ver === ver && (had.inst || !p)) continue;
          if (!p && had?.inst) continue;   // (a sampler changed and not resolved yet: the one it was plays on until it is)
          if (had?.inst && p && had.kind === kind) { if (kind !== 'voices') had.inst.set(p); had.key = key; had.ver = ver; continue; }
          // (a native instrument played with its track's automation of it: its points, given again whenever the timeline is set)
          const inst = !p ? null : p.plugin ? streamed(pluginKey(t.id), pos) : automated(createInstrument(p, { sr }));
          inst?.reset?.(pos);
          st.insts.set(id, { key, kind, inst, ver });
        }
        for (const x of st.insts.values()) { x.inst?.setPoints?.(controls.get(pluginKey(t.id)) ?? null); x.env = notesEnvelope(notes); }
        st.ev = noteEvents(t, tl, sr); st.next = firstAfter(st.ev, pos);
        return st;
      });
      for (const id of tracks.keys()) if (!seen.has(id)) tracks.delete(id);
      // the buses, and each track's sends to them (smoothed like its fader)
      const keep = new Set();
      buses = (tl.buses ?? []).map((b) => {
        let st = busById.get(b.id);
        if (!st) { st = { ...newBus(`bus:${b.id}`), inL: new Float32Array(MAX), inR: new Float32Array(MAX) }; busById.set(b.id, st); }   // (its meter's id: bus:<id>)
        keep.add(b.id);
        syncFx(st, (b.fx ?? []).filter((e) => e.on !== false));
        [st.tl, st.tr] = gains(b.volume, b.pan, !b.mute);
        return st;
      });
      for (const id of busById.keys()) if (!keep.has(id)) busById.delete(id);
      for (const [i, t] of audio.entries()) {
        const st = order[i], was = new Map((st.sends ?? []).map((x) => [x.bus, x]));
        st.sends = Object.entries(t.sends ?? {}).filter(([id, d]) => busById.has(id) && d != null).map(([id, d]) => {
          const bus = busById.get(id), x = was.get(bus) ?? { bus, g: 0 };
          x.t = dbGain(d); return x;
        });
      }
      syncFx(master, (tl.master?.fx ?? []).filter((e) => e.on !== false));
      [master.tl, master.tr] = gains(tl.master?.volume, 0);
      // sidechains: each compressor's track (not latency-aligned: a few ms either way, less than a ducking's attack), and the
      // order the tracks play in, a track listened to before its listeners (in a loop, the key that closes it is dropped)
      for (const st of [...order, ...buses, master]) for (const f of st.fx) { const id = f.spec.sidechain; f.key = id && id !== st.id ? tracks.get(id) ?? NOKEY : null; }
      run = [];
      const seenRun = new Map(), visit = (st) => {
        seenRun.set(st, 1);
        for (const f of st.fx) if (f.key && f.key !== NOKEY) { const s = seenRun.get(f.key); if (s === 1) f.key = null; else if (!s) visit(f.key); }
        seenRun.set(st, 2); run.push(st);
      };
      for (const st of order) if (!seenRun.has(st)) visit(st);
      // latency: each track delayed to the latest one's (a delay line of its own), the master's added after
      const lat = (bus) => bus.fx.reduce((a, f) => a + (f.p?.latency ?? 0), 0), most = Math.max(0, ...order.map(lat));
      for (const st of order) {
        const d = most - lat(st);
        if (d !== st.delay) { st.delay = d; st.dl = d ? new Float32Array(d) : null; st.dr = d ? new Float32Array(d) : null; st.di = 0; }
      }
      lead = most + lat(master);
    },
    /** Plays from t (seconds): effects and instruments start silent (their clocks at t), faders where they are set. The
     *  latency is played through first, so the next sample out is t's. */
    seek(t) {
      pos = Math.max(0, Math.round(t * sr));
      for (const st of [...order, ...buses, master]) {
        for (const f of st.fx) f.p?.reset();
        st.gl = st.tl; st.gr = st.tr;
        for (const x of st.sends ?? []) x.g = x.t;
        if (st.dl) { st.dl.fill(0); st.dr.fill(0); st.di = 0; }
        if (st.insts) { for (const x of st.insts.values()) { x.inst?.reset(pos); x.g = undefined; } st.next = firstAfter(st.ev, pos); }
      }
      for (let left = lead; left > 0; left -= MAX) live.process(skipL, skipR, Math.min(MAX, left));
    },
    /** While stopped, the plugin instruments heard as they are played (pluginKey of each; null: none), on a clock of
     *  their own from `from` (a new set's: keys added later are read from where the clock is). */
    monitor(keys, from = 0) {
      if (!keys) { monitor = null; return; }
      monitor ??= { keys: new Set(), at: from };
      const want = new Set(keys);
      for (const k of monitor.keys) if (!want.has(k)) monitor.keys.delete(k);
      for (const st of order) for (const x of st.insts.values()) {
        const k = pluginKey(st.id);
        if (x.kind === 'plugin' && want.has(k) && !monitor.keys.has(k)) { monitor.keys.add(k); x.inst.reset(monitor.at); }
      }
    },
    monitorAt: () => monitor?.at ?? 0,
    /** A note tried now on track `track` (its sound, at this sample rate), heard through the track's effects, fader,
     *  sends and the master, playing or stopped, its track ringing on for its effects' tail. */
    hear(track, L, R) {
      const st = tracks.get(track);
      if (st) tried.push({ track, L, R, i: 0, end: L.length + Math.round(st.fx.reduce((a, f) => a + (f.p?.tail ?? 0), 0) * sr) });
    },
    hearing: () => tried.length > 0,
    /** The next n samples while stopped: the monitored plugins through their tracks' effects, faders and sends, the buses
     *  and the master (the rest of the timeline silent and still: its clips and notes are where they were). */
    processMonitor(L, R, n) {
      L.fill(0, 0, n); R.fill(0, 0, n);
      for (const b of buses) { b.inL.fill(0, 0, n); b.inR.fill(0, 0, n); }
      for (const st of run) {
        st.bL.fill(0, 0, n); st.bR.fill(0, 0, n);   // (a track not heard is silence, to a compressor listening to it too)
        let heard = tryInto(st, st.bL, st.bR, n);
        for (const x of st.insts.values()) if (x.kind === 'plugin' && monitor?.keys.has(pluginKey(st.id))) { x.inst.process(st.bL, st.bR, n); heard = true; }
        if (!heard) continue;
        runFx(st, st.bL, st.bR, n);
        mixInto(st, st.bL, st.bR, L, R, n);
      }
      for (const b of buses) { runFx(b, b.inL, b.inR, n); mixInto(b, b.inL, b.inR, L, R, n); }
      runFx(master, L, R, n);
      mixInto(master, L, R, L, R, n);
      if (monitor) monitor.at += n;
      tried = tried.filter((x) => x.i < x.end);
    },
    /** The timeline time of the next sample out (seconds). */
    time: () => (pos - lead) / sr,
    /** The sample its instruments play next (ahead of time() by the latency: a plugin's host keeps ahead of it). */
    at: () => pos,
    /** The next n samples (n ≤ 4096) into L and R. */
    process(L, R, n) {
      L.fill(0, 0, n); R.fill(0, 0, n);
      for (const b of buses) { b.inL.fill(0, 0, n); b.inR.fill(0, 0, n); }
      const from = pos, to = pos + n;
      for (const st of run) {
        const bufL = st.bL, bufR = st.bR;
        bufL.fill(0, 0, n); bufR.fill(0, 0, n);
        addClips(st.rs, media, sr, bufL, bufR, n, from);   // (each clip clamped to the block: nothing made per block)
        // its notes in this block, each at its sample: instruments play into the track's sound
        while (st.next < st.ev.length && st.ev[st.next].s < to) {
          const e = st.ev[st.next++], inst = st.insts.get(ONE)?.inst;
          if (inst && e.s >= from) { if (e.on) inst.noteOn(e.note, e.vel, e.s - from); else inst.noteOff(e.note, e.s - from); }
        }
        for (const x of st.insts.values()) {
          if (!x.inst) continue;
          if (!x.env) { x.inst.process(bufL, bufR, n); continue; }
          // (its clips' gains and fades, smoothed as a fader is: a clip that starts at another gain does not click)
          noteL.fill(0, 0, n); noteR.fill(0, 0, n);
          x.inst.process(noteL, noteR, n);
          let g = x.g ?? envelopeAt(x.env, from / sr);
          for (let i = 0; i < n; i++) { g += (envelopeAt(x.env, (from + i) / sr) - g) * k; bufL[i] += noteL[i] * g; bufR[i] += noteR[i] * g; }
          x.g = g;
        }
        tryInto(st, bufL, bufR, n);
        runFx(st, bufL, bufR, n);
        mixInto(st, bufL, bufR, L, R, n);
      }
      for (const b of buses) { runFx(b, b.inL, b.inR, n); mixInto(b, b.inL, b.inR, L, R, n); }
      runFx(master, L, R, n);
      mixInto(master, L, R, L, R, n);
      pos = to;
      tried = tried.filter((x) => x.i < x.end);
    },
    /** Each track's and the master's loudness since last asked: { id: { peak, rms } } (linear). */
    levels() {
      const out = {};
      for (const st of [...order, ...buses, master]) { out[st.id] = { peak: st.peak, rms: Math.sqrt(st.sum / (2 * st.count || 1)) }; st.peak = st.sum = st.count = 0; }
      return out;
    },
    /** How long the sound may ring on after the last clip ends (its effects' and instruments' tails), seconds. */
    tail() {   // a track's own (its instruments', then its effects'), then the longest bus it sends to, then the master's
      const own = (st) => st.fx.reduce((a, f) => a + (f.p?.tail ?? 0), 0) + Math.max(0, ...[...(st.insts?.values() ?? [])].map((x) => x.inst?.tail ?? 0));
      return own(master) + Math.max(0, ...order.map((st) => own(st) + Math.max(0, ...(st.sends ?? []).map((x) => own(x.bus)))));
    },
  };
  // the notes tried on a track (hear()) into its sound, the next n samples: whether it has any, sounding or ringing
  function tryInto(st, bL, bR, n) {
    let any = false;
    for (const x of tried) {
      if (x.track !== st.id) continue;
      for (let j = 0, m = Math.max(0, Math.min(n, x.L.length - x.i)); j < m; j++) { bL[j] += x.L[x.i + j]; bR[j] += x.R[x.i + j]; }
      x.i += n; any = true;
    }
    return any;
  }
  // a bus's sound, its fader and pan (each sample a step nearer the set value), into L and R; its meter
  function mixInto(st, inL, inR, L, R, n) {
    let { gl, gr, peak, sum } = st;
    const dl = st.dl, dr = st.dr, d = st.delay;
    for (let i = 0; i < n; i++) {
      gl += (st.tl - gl) * k; gr += (st.tr - gr) * k;
      let xl = inL[i], xr = inR[i];
      if (dl) { const j = st.di; const yl = dl[j], yr = dr[j]; dl[j] = xl; dr[j] = xr; st.di = j + 1 === d ? 0 : j + 1; xl = yl; xr = yr; }
      const l = xl * gl, r = xr * gr;
      L[i] = (inL === L ? 0 : L[i]) + l; R[i] = (inR === R ? 0 : R[i]) + r;
      if (st.sends) for (const x of st.sends) { x.g += (x.t - x.g) * k; x.bus.inL[i] += l * x.g; x.bus.inR[i] += r * x.g; }
      const a = Math.abs(l), b = Math.abs(r);
      if (a > peak) peak = a; if (b > peak) peak = b;
      sum += l * l + r * r;
    }
    st.gl = gl; st.gr = gr; st.peak = peak; st.sum = sum; st.count += n;
  }
  return live;
}
// the first event at or after sample s
export function firstAfter(ev, s) { let lo = 0, hi = ev.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].s < s) lo = m + 1; else hi = m; } return lo; }
