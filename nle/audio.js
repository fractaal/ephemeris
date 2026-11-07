// Playback: the timeline is played live, as a DAW plays it — the live engine (live.js) in an AudioWorklet
// (liveworklet.js) makes its sound as it plays (clips, notes played by their instruments, effects, faders), so a
// knob turned while it plays is heard at once; renders run the same engine from the start (tools/mix.mjs), and are
// what playing from the start is. The audio clock is the editor's master clock; the muted draft video follows it. A
// plugin instrument (Vial, the studio's synth, among them) is played by its host in the studio, streamed in a little
// ahead (plugins.js); samplers by voice workers, off the audio thread, the same way (voices.js).
import { linkFetch } from './link.js';
import { clipEnd, isVisual, dbGain } from './model.js';
import { instrumentKey, needsResolving, samplesPlayed, notesWith, PLUGIN_TAIL } from './live.js';
import { createPluginLink } from './plugins.js';
import { createVoiceLink } from './voices.js';
import { controlPoints } from './automation.js';
import { played } from '../engine/score.js';
import { paramsOf } from './device.js';

export const ctx = new AudioContext({ latencyHint: 'interactive' });
// the listening volume: what the editor plays (the mix, the metronome, a note tried in the piano roll or the Instrument
// panel) reaches the speakers through it — this machine's, for hearing alone: never in the timeline, the meters or a render
const speakers = ctx.createGain();
speakers.connect(ctx.destination);
/** Sets the listening volume: dB over what the mix is (0: as it is), or silent. */
export function listening(db, on = true) { speakers.gain.setTargetAtTime(on ? dbGain(db) : 0, ctx.currentTime, 0.015); }
const media = new Map();   // id → { url, buffer, channels, peaks, error, ready }
let sentKey = '', gridKey = '', end = 0, startPos = 0, startAt = 0, mute = false, onChange = () => {}, levels = {}, plays = 0, pluginMissing = 0, voiceMissing = 0, monitoring = false;
export let playing = false;

/** Called whenever media load or the mix changes (to redraw waveforms). */
export function listen(fn) { onChange = fn; }
export const get = (id) => media.get(id);

/** Loads (once) and decodes a medium; resolves to its entry. A medium loaded again from a new url (a sound made again)
 *  keeps playing what it had until the new one is decoded. */
export function load(id, url) {
  const m = media.get(id);
  if (m && m.url === url) return m.ready;
  const e = { url, buffer: m?.buffer ?? null, channels: m?.channels, peaks: m?.peaks ?? null, error: '', gen: m?.gen ?? 0 };
  e.ready = linkFetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); })
    .then((b) => ctx.decodeAudioData(b))
    .then((buffer) => { e.buffer = buffer; e.channels = [...Array(buffer.numberOfChannels)].map((_, c) => buffer.getChannelData(c)); e.peaks = peaks(buffer); e.gen++; return e; })
    .catch((err) => { e.error = String(err.message || err); return e; })
    .finally(() => { onChange(); });
  media.set(id, e);
  return e.ready;
}

// Min/max of the mid channel per bin, at three resolutions (16, 128 and 4096 samples): enough to draw any zoom without
// touching every sample. As the timeline's GPU reads them (lanesgpu.js): one array of 16-bit floats, each level's bins in
// turn, a bin's min then its max; `at` and `n`: where each level starts (in bins) and how many it has.
const BINS = [16, 128, 4096];
function peaks(buffer) {
  const L = buffer.getChannelData(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const n = BINS.map((b) => Math.ceil(L.length / b)), at = [0, n[0], n[0] + n[1]], data = new Float16Array(2 * (at[2] + n[2]));
  for (let k = 0; k < n[0]; k++) {
    let lo = 0, hi = 0;
    for (let i = k * 16, e = Math.min(L.length, i + 16); i < e; i++) { const v = (L[i] + R[i]) / 2; if (v < lo) lo = v; else if (v > hi) hi = v; }
    data[2 * k] = lo; data[2 * k + 1] = hi;
  }
  // (each coarser level from the one under it: its bins, 8 and 32 of them; a 16-bit float keeps a level's min and max as
  // close as the screen shows them)
  for (let l = 1; l < 3; l++) {
    const per = BINS[l] / BINS[l - 1], from = at[l - 1], len = n[l - 1];
    for (let k = 0; k < n[l]; k++) {
      let lo = 0, hi = 0;
      for (let j = k * per, e = Math.min(len, j + per); j < e; j++) { const a = data[2 * (from + j)], b = data[2 * (from + j) + 1]; if (a < lo) lo = a; if (b > hi) hi = b; }
      data[2 * (at[l] + k)] = lo; data[2 * (at[l] + k) + 1] = hi;
    }
  }
  return { bins: BINS, at, n, data };
}

// ---------- the worklet: sent the timeline when it changes, and each medium once decoded (again when loaded anew); the
// voice workers each sampler instrument once resolved (its data from the studio, its samples fetched and decoded here)
// (a browser gives an AudioWorklet only to a secure page: https, or http://localhost on the studio's own machine. On
// another device over plain http there is none: no live engine, its messages dropped, and the studio's mix plays: useMix)
/** Whether the live engine plays here. */
export const live = !!ctx.audioWorklet;
let node = null, fileUrl = (p) => p;
const pending = [], sent = new Map();
const post = (m, transfer) => (node ? node.port.postMessage(m, transfer) : live ? pending.push([m, transfer]) : undefined);
/** The plugin instruments' hosts (plugins.js): their windows, their saved states. */
export const plugins = createPluginLink({ sr: ctx.sampleRate, post });
const voices = createVoiceLink({ sr: ctx.sampleRate, post });
// the reverbs' impulse responses, made by a worker of their own (irworker.js), on a port to the engine: never on the audio thread
if (live) {
  const w = new Worker(new URL('./irworker.js', import.meta.url), { type: 'module' }), ch = new MessageChannel();
  w.postMessage({ sr: ctx.sampleRate, port: ch.port1 }, [ch.port1]);
  w.onerror = (e) => console.warn(`reverb worker: ${e.message}`);
  post({ irPort: ch.port2 }, [ch.port2]);
}
const ready = !live ? Promise.resolve() : ctx.audioWorklet.addModule(new URL('./liveworklet.js', import.meta.url)).then(() => {
  node = new AudioWorkletNode(ctx, 'ephemeris-live', { numberOfInputs: 0, outputChannelCount: [2] });
  node.connect(speakers);
  node.port.onmessage = ({ data }) => {
    if (data.levels) { levels = data.levels; monitoring = !!data.monitoring; if (data.missing != null) pluginMissing = data.missing; if (data.voiceMissing != null) voiceMissing = data.voiceMissing; }
    if (data.at != null) plugins.ack(data.at);   // (playing, or monitoring a plugin while stopped)
  };
  for (const [m, transfer] of pending.splice(0)) node.port.postMessage(m, transfer);
});
/** Where the project's own files are fetched from (for an instrument's samples in the project). */
export function useFiles(fn) { fileUrl = fn; }

// a native instrument's automation as the points its voice worker plays (worked out here: a worker reads no lanes)
const controlsFor = (t, media) => controlPoints(t, media, paramsOf(t.instrument, { sampler: samplerData(t.instrument) }), ctx.sampleRate, Math.ceil((end + PLUGIN_TAIL) * ctx.sampleRate));
// the film's sound code, as run against the timeline (engine/score.js): its motions played with the timeline's own
let score = null;
/** Takes in what the film's sound code (sound.js) does now (score(): null, none), and plays the timeline with it (again:
 *  at once; else with the next update). */
export function setScore(s, again = true) { score = s; if (again && last) update(...last); }
/** Takes in the timeline as it is now: its media loaded and sent, its instruments resolved, the timeline sent when what is
 *  heard of it changed (with the sound code's motions in it). urlOf(id, medium): where an audio medium is fetched from
 *  (null: not an audio file). */
export function update(doc, urlOf) {
  last = [doc, urlOf];
  const heardDoc = played(doc, score);   // (the parts' notes and motions the sound code writes, in)
  if (!live || mix) { end = Math.max(0, ...heardDoc.tracks.filter((t) => !isVisual(t)).flatMap((t) => t.clips.map(clipEnd))); return; }   // (nothing loaded, no plugin's host opened: nothing plays them here)
  const instruments = new Map();
  for (const t of doc.tracks) if (!isVisual(t) && needsResolving(t.instrument)) instruments.set(instrumentKey(t.instrument), t.instrument);
  for (const [id, m] of Object.entries(doc.media)) {
    if (Array.isArray(m.notes)) continue;
    if (!m.kind || m.kind === 'audio') { const url = urlOf(id, m); if (url) load(id, url); }   // (pictures are not heard)
  }
  for (const [key, spec] of instruments) resolve(key, spec, notesWith(heardDoc, key));
  for (const [id, e] of media) if (e.channels && sent.get(id) !== e.channels[0]) { sent.set(id, e.channels[0]); post({ media: { [id]: e.channels } }); }
  const heard = { tracks: heardDoc.tracks.filter((t) => !isVisual(t)), media: heardDoc.media, master: doc.master, buses: doc.buses };
  const key = JSON.stringify(heard);
  end = Math.max(0, ...heard.tracks.flatMap((t) => t.clips.map(clipEnd)));
  if (key !== sentKey) { sentKey = key; post({ timeline: heard }); voices.update(heard, controlsFor); }
  const g = JSON.stringify(doc.grid ?? null);
  if (g !== gridKey) { gridKey = g; post({ grid: doc.grid ?? {} }); }   // (the metronome's beats)
  plugins.update({ ...heard, grid: doc.grid });
}
// a sampler instrument (an SFZ, a saved instrument, a folder of notes: { sfz | sampler | named }) made playable: its data
// from the studio (api/instrument), the samples its notes can play decoded here (samplesPlayed: of a cymbal program's
// 1362 recordings, the few a pattern hits), then sent to its voice worker under its key — again, with more, when its notes
// come to need more (a note added at another key, a louder one)
const studio = new Map();   // instrument key → its data from the studio (a promise)
const known = new Map();    // instrument key → a sampler's data once it came (its params' values: the lanes' bases)
/** A sampler instrument's data as the studio gave it (null until it has). */
export const samplerData = (spec) => known.get(instrumentKey(spec)) ?? null;
const given = new Map();    // instrument key → { names: the samples the worklet has, job: the last send }
const decoded = new Map();  // a sample's url → its sound (a promise): decoded once, whichever instrument names it
const dragged = new Map();  // instrument key → its settings being dragged (sent instead of the studio's, until the edit)
const unloaded = new Map(); // instrument key → [{ name: a sample its notes play ('': the instrument's data), why }]: not loaded here
let last = null;            // the timeline update() last took in, and its urlOf
let resolvedLater = null;
/** The instruments the timeline plays that could not be loaded here, whole or some of their samples (a file gone, one
 *  the editor cannot decode), so notes they play are silent in the editor: [{ parts: the names of the tracks that play
 *  it, missing: [{ name, why }] }]. */
export function unloadedSamples() {
  if (!last) return [];
  const [doc] = last;
  return [...unloaded].map(([key, missing]) => ({
    parts: doc.tracks.filter((t) => !isVisual(t) && t.instrument && instrumentKey(t.instrument) === key).map((t) => t.name || t.id),
    missing,
  })).filter((u) => u.parts.length);
}
/** Whether an instrument spec names one of these files of the project's (its .json or .sfz, or a file in its folder). */
export const namesFile = (spec, files) => {
  const p = (spec?.sampler ?? spec?.sfz ?? spec?.named ?? '').replace(/^\.\//, '').replace(/\/$/, '');
  return !!p && files.some((f) => f === p || f.startsWith(`${p}/`));
};
/** Instrument files changed on disk (the project's paths): the instruments that name them are fetched again, and heard so. */
export function instrumentsChanged(files) {
  let any = false;
  for (const key of studio.keys()) if (namesFile(JSON.parse(key), files)) { studio.delete(key); given.delete(key); any = true; }
  if (any && last) update(...last);
}
function resolve(key, spec, notes) {
  if (!studio.has(key)) studio.set(key, linkFetch('api/instrument', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instrument: spec }) })
    .then((res) => res.json()).then((r) => { if (r.error) throw new Error(r.error); return r; }));
  const data = studio.get(key), g = given.get(key) ?? { names: null, job: Promise.resolve() };   // (its request held here: one that failed is taken out of studio, and the jobs queued after it see why)
  given.set(key, g);
  g.job = g.job.then(async () => {
    const r = await data;
    if (!known.has(key)) { known.set(key, r.sampler); sentKey = ''; clearTimeout(resolvedLater); resolvedLater = setTimeout(() => last && update(...last), 50); }   // (its params' values: its automation's bases; the timeline sent again once for the instruments a film resolves together)
    const want = samplesPlayed(r.sampler, notes);
    if (g.names && [...want].every((n) => g.names.has(n))) return;
    const names = new Set([...(g.names ?? []), ...want]), samples = {}, missing = [];
    // (a sample in the library named so from a project's instrument: library/…)
    const urlOf = (n) => (n.startsWith('library/') ? `api/library/file?path=${encodeURIComponent(n)}` : r.base?.startsWith('library/') ? `api/library/file?path=${encodeURIComponent(`${r.base}/${n}`)}` : fileUrl([r.base, n].filter(Boolean).join('/')));
    await Promise.all([...names].map(async (n) => {
      const url = urlOf(n);
      if (!decoded.has(url)) decoded.set(url, linkFetch(url).then((res) => { if (!res.ok) throw new Error(res.status === 404 ? 'not found' : `the studio answered ${res.status}`); return res.arrayBuffer(); })
        .then((b) => ctx.decodeAudioData(b).catch(() => { throw new Error('the editor can’t decode it'); })).then((b) => ({ sr: b.sampleRate, ch: [b.getChannelData(0), b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)] })));
      try { samples[n] = await decoded.get(url); } catch (e) { decoded.delete(url); missing.push({ name: n, why: e.message }); }   // (left out: tried again when it loads again)
    }));
    g.names = names;
    if (missing.length) unloaded.set(key, missing); else unloaded.delete(key);
    voices.resolved(key, { sampler: dragged.get(key) ?? r.sampler, samples });
  }).catch((e) => { console.warn(`instrument ${key}: ${e.message}`); unloaded.set(key, [{ name: '', why: e.message }]); studio.delete(key); given.delete(key); });
}
/** A sampler's settings as they are being dragged (unsaved), heard at once while the timeline plays; null: as saved
 *  again (the edit made: what it was is what undo comes back to). Its samples are those it has. */
export function previewSampler(spec, data) {
  const key = instrumentKey(spec), g = given.get(key);
  if (!g?.names) return;
  if (data) { dragged.set(key, data); voices.retune(key, data); return; }
  if (!dragged.delete(key)) return;
  studio.get(key)?.then((r) => r.sampler && !dragged.has(key) && voices.retune(key, r.sampler));
}
/** The metronome (metronome.js): { on, volume (dB) }, either. */
export function metronome(o) { post({ metronome: o }); }
/** A note tried now (the piano roll's, the Instrument panel's): its sound ({ ch }, at ctx's sample rate) heard on track
 *  `track` as the timeline plays it — its effects, fader, pan, sends, the master — and through the listening volume. */
export function hear(track, snd) {
  if (ctx.state !== 'running') ctx.resume();
  const L = Float32Array.from(snd.ch[0]), R = Float32Array.from(snd.ch[1] ?? snd.ch[0]);
  post({ hear: { track, L, R } }, [L.buffer, R.buffer]);
}
/** Samples of plugin sound the worklet wanted before it came (for the tests: a host that fell behind). */
export const pluginUnderruns = () => pluginMissing;
/** Samples of a sampler's sound the worklet wanted before its voice worker made them. */
export const voiceUnderruns = () => voiceMissing;
/** How loud each track (by id; `master`) is now, for the meters: { peak, rms } (linear); nothing while stopped (but a
 *  plugin heard as it is played). */
export function levelsAt() { return (playing && !mute) || monitoring ? levels : {}; }
/** Where the timeline's sound ends (its last clip; effects may ring on after it). */
export const mixDuration = () => end;

/** Context time of the sample reaching the speakers now (so the playhead is what you hear, not what is queued). */
function heard() {
  const ts = ctx.getOutputTimestamp?.();
  if (ts && ts.performanceTime > 0) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
}
/** Playhead position; `at` (a performance.now() time, e.g. an event's timeStamp) asks where it was then. */
export function now(at) {
  if (!playing) return startPos;
  const shift = at == null ? 0 : (at - performance.now()) / 1000;
  return startPos + Math.max(0, heard() + shift - startAt);
}

/** A strip's mix heard at once as `strip` has it (its effects' values, fader, pan and sends: a value being dragged),
 *  without the timeline sent again (id: a track's, `bus:<id>`, `master`); the edit made as the drag ends sends it whole. */
export function tweak(id, strip) { post({ tweak: { id, strip } }); }
/** An effect's view watching it (key: the view's; at: its place among strip id's effects that are on): the sound either
 *  side of it sent on `port`, a hop at a time, as it plays (live.js tap); untap(key) stops. */
export function tap(key, id, at, port) { post({ tap: { key, id, at, port } }, [port]); }
export function untap(key) { post({ untap: key }); }

/** Plays from t (silent: the clock runs, the music does not — the editor playing every frame keeps its own time). */
export async function play(t, { silent = false } = {}) {
  if (ctx.state !== 'running') await ctx.resume();
  await ready;
  const gen = ++plays, engine = live && !mix && !silent;
  const from = Math.round(Math.max(0, t) * ctx.sampleRate);
  if (!engine) { plugins.stop(); voices.stop(); } else await Promise.all([plugins.play(from), voices.play(from, gen)]);   // (each host and worker has its start)
  if (gen !== plays) return;   // (played again, or paused, meanwhile)
  startPos = t; startAt = ctx.currentTime + 0.03; playing = true; mute = silent;
  post(engine ? { play: { t: Math.max(0, t), at: startAt, gen } } : { stop: true });
  if (mix) mixFrom(silent ? null : startAt);
}
export function pause() { const t = now(); plays++; post({ stop: true }); plugins.stop(); voices.stop(); mixFrom(null); playing = false; startPos = t; return t; }

// ---------- the studio's mix in place of the live engine (a phone's simple view; a page with no AudioWorklet): the
// timeline's sound as one file the studio makes (tools/nle.mjs mix), decoded once and played from the playhead by a
// buffer source, on the same clock. One made again (the sound changed) takes over where it plays once it is decoded.
let mix = null;   // null: the live engine plays; else { url, buffer, src }
/** Plays the studio's mix from now on, from url (null: none yet, or no sound: silence). */
export function useMix(url) {
  mix ??= { url: null, buffer: null, src: null };
  if (url === mix.url) return;
  mix.url = url;
  if (!url) { mix.buffer = null; if (playing) mixFrom(null); return; }
  linkFetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`the studio answered ${r.status}`)))).then((b) => ctx.decodeAudioData(b)).then((buffer) => {
    if (mix.url !== url) return;
    mix.buffer = buffer;
    if (playing && !mute) mixFrom(ctx.currentTime + 0.05);
  }).catch((e) => console.warn(`the studio's mix: ${e.message}`));
}
// the mix playing from context time `when` (where the playhead is then), the one playing until then; null: stopped
function mixFrom(when) {
  const was = mix?.src;
  if (mix) mix.src = null;
  if (when == null) return was?.stop();
  const off = startPos + (when - startAt);
  was?.stop(when);
  if (!mix.buffer || off >= mix.buffer.duration) return;
  const src = (mix.src = ctx.createBufferSource());
  src.buffer = mix.buffer; src.connect(speakers); src.start(when, Math.max(0, off));
}
export function seek(t) { if (playing) play(t, { silent: mute }); else startPos = t; }
