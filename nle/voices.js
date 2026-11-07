// The editor's samplers, played off the audio thread: each track's sampler (a voice stream, under its pluginKey) is played by a worker (voiceworker.js) a little ahead of where the worklet plays, and its
// sound streamed into the worklet (liveworklet.js keeps it, live.js reads it at the samples it plays, as a plugin's).
// The instruments are the live engine's own (engine/sound/instrument.js) from the same notes (live.js noteEvents), so
// what the editor plays from the start is still what a render (tools/mix.mjs, its instruments in the engine) makes;
// the audio thread keeps the clips, effects, faders and buses. The instruments are shared out over as many workers
// as the machine has cores to spare, each instrument's on one (its samples there once), so a dense score plays on
// several cores at once. A note changed while it plays is heard from where the worker has got to (AHEAD past the
// playhead); faders and effects at once.
//
//   voiceStreams(heard, sr)                        // a timeline's streams: [{ ikey, key, spec, ev }]
//   const host = createVoiceHost({ sr })           // a worker's instruments (voiceworker.js); in Node for the tests
//   host.resolved(key, spec) · host.retune(key, sampler)   // a sampler instrument resolved (instrumentKey) · dragged
//   host.streams([{ key, spec, ev }])              // the streams it plays: their instrument and their noteEvents
//   host.play(from) · host.pos · host.make(n)      // from that sample · where it has got to · the next n samples:
//                                                  //   { [key]: [L, R] }
//
//   const link = createVoiceLink({ sr, post })     // the page's side (audio.js): post: a message to the worklet
//   link.update(heard) · link.resolved(key, spec) · link.retune(key, sampler)
//   await link.play(from, gen) · link.stop()       // every worker plays from that sample: resolves once each has a start
import { noteEvents, pluginKey, instrumentKey, playableInstrument, firstAfter, automated } from './live.js';
import { createInstrument } from '../engine/sound/instrument.js';
import { isAutomated, isNotes } from './model.js';

export const AHEAD = 0.2;    // seconds each worker keeps ahead of where the worklet plays
const PRIME_WAIT = 400;      // ms play() waits at most for the workers' first sound
const MAX_MAKE = 2048;       // samples made in one go (a stream's arrays, sent to the worklet)

/** A timeline's voice streams: each track's sampler that plays notes clips, { ikey: its instrument's key, key: the
 *  stream's (pluginKey: its track's), spec, ev: its noteEvents as [sample, on 1|0, note, vel], points: its automation
 *  (its clips' and its track's) as controls(track, media) gives it (automation.js controlPoints, made by the page: a
 *  worker reads no lanes) }. */
export function voiceStreams(heard, sr, controls = null) {
  const out = [];
  for (const t of heard.tracks) {
    if (!t.instrument || t.instrument.plugin || !t.clips.some((c) => isNotes(heard.media[c.media]))) continue;
    out.push({ ikey: instrumentKey(t.instrument), key: pluginKey(t.id), spec: t.instrument, ev: noteEvents(t, heard, sr).map((e) => [e.s, e.on ? 1 : 0, e.note, e.vel ?? 0]), points: (isAutomated(t, heard.media) && controls?.(t, heard.media)) || null });
  }
  return out;
}

export function createVoiceHost({ sr }) {
  const resolved = new Map(), versions = new Map();
  const streams = new Map();   // key → { spec, ikey, ver, inst, ev, next }
  let pos = 0, list = [];
  // each stream's instrument brought to its spec, as live.js set() keeps a track's: kept while the same, set where it
  // changed, made where there was none; a sampler not resolved yet plays on as it was (silent if it was none)
  function sync() {
    const seen = new Set();
    for (const { key, spec, ev, points } of list) {
      seen.add(key);
      let s = streams.get(key);
      if (!s) { s = { inst: null }; streams.set(key, s); }
      s.ev = ev.map(([at, on, note, vel]) => ({ s: at, on: !!on, note, vel }));
      s.next = firstAfter(s.ev, pos);
      const ikey = instrumentKey(spec), ver = versions.get(ikey) ?? 0, p = playableInstrument(spec, resolved);
      const akey = JSON.stringify(points);
      if (s.ikey === ikey && s.ver === ver && s.akey === akey && (s.inst || !p)) continue;
      if (!p) continue;
      if (s.inst) s.inst.set(p);
      else { s.inst = automated(createInstrument(p, { sr })); s.inst.reset(pos); }   // (played with its automation's points)
      s.inst.setPoints(points ?? null);
      Object.assign(s, { spec, ikey, ver, akey });
    }
    for (const key of streams.keys()) if (!seen.has(key)) streams.delete(key);
  }
  return {
    resolved(key, spec) { resolved.set(key, spec); versions.set(key, (versions.get(key) ?? 0) + 1); sync(); },
    retune(key, sampler) { const r = resolved.get(key); if (r?.sampler) this.resolved(key, { ...r, sampler }); },
    streams(next) { list = next; sync(); },
    play(from) {
      pos = from;
      for (const s of streams.values()) { s.inst?.reset(pos); s.next = firstAfter(s.ev, pos); }
    },
    get pos() { return pos; },
    get keys() { return [...streams.keys()]; },
    make(n) {
      const out = {}, to = pos + n;
      for (const [key, s] of streams) {
        const L = new Float32Array(n), R = new Float32Array(n);
        while (s.next < s.ev.length && s.ev[s.next].s < to) {
          const e = s.ev[s.next++];
          if (s.inst && e.s >= pos) { if (e.on) s.inst.noteOn(e.note, e.vel, e.s - pos); else s.inst.noteOff(e.note, e.s - pos); }
        }
        s.inst?.process(L, R, n);
        out[key] = [L, R];
      }
      pos = to;
      return out;
    },
  };
}

export function createVoiceLink({ sr, post }) {
  const workers = [];            // { worker, keys: Set of instrument keys, sent: what its streams were last sent as, primed }
  const home = new Map();        // instrument key → its worker
  const specs = new Map();       // instrument key → its resolved form (sent to its worker when it has one)
  const cap = Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 4) - 2);
  let waiting = null;
  // an instrument's worker: a new one while there are cores to spare, else the one with fewest instruments
  function workerOf(ikey) {
    let w = home.get(ikey);
    if (w) return w;
    if (workers.length < cap) {
      const worker = new Worker(new URL('./voiceworker.js', import.meta.url), { type: 'module' }), ch = new MessageChannel();
      w = { worker, keys: new Set(), sent: '', primed: false };
      worker.postMessage({ sr, port: ch.port1 }, [ch.port1]);
      post({ voicePort: ch.port2 }, [ch.port2]);
      worker.onmessage = ({ data }) => { if (data.primed) { w.primed = true; waiting?.(); } };
      worker.onerror = (e) => console.warn(`voice worker: ${e.message}`);
      workers.push(w);
    } else w = workers.reduce((a, b) => (b.keys.size < a.keys.size ? b : a));
    w.keys.add(ikey); home.set(ikey, w);
    if (specs.has(ikey)) w.worker.postMessage({ resolved: { key: ikey, spec: specs.get(ikey) } });
    return w;
  }
  return {
    /** The timeline as heard: each track's sampler notes media, a stream on its instrument's worker, with its
     *  automation's points (controls: voiceStreams'). */
    update(heard, controls) {
      const per = new Map(workers.map((w) => [w, []]));
      for (const { ikey, key, spec, ev, points } of voiceStreams(heard, sr, controls)) {
        const w = workerOf(ikey);
        if (!per.has(w)) per.set(w, []);
        per.get(w).push({ key, spec, ev, points });
      }
      for (const [w, list] of per) {
        const sent = JSON.stringify(list);
        if (sent !== w.sent) { w.sent = sent; w.worker.postMessage({ streams: list }); }
      }
    },
    /** A sampler instrument resolved (its data and samples): for the worker its streams are on. */
    resolved(ikey, spec) { specs.set(ikey, spec); home.get(ikey)?.worker.postMessage({ resolved: { key: ikey, spec } }); },
    /** A sampler's settings being dragged (its samples kept). */
    retune(ikey, sampler) { const r = specs.get(ikey); if (r?.sampler) { specs.set(ikey, { ...r, sampler }); home.get(ikey)?.worker.postMessage({ retune: { key: ikey, sampler } }); } },
    /** Every worker plays from sample `from` (`gen`: this play's, as the worklet's acks carry it). */
    play(from, gen) {
      for (const w of workers) { w.primed = false; w.worker.postMessage({ play: { from, gen } }); }
      return new Promise((done) => {
        const timer = setTimeout(() => { waiting = null; done(); }, PRIME_WAIT);
        waiting = () => { if (workers.every((w) => w.primed)) { clearTimeout(timer); waiting = null; done(); } };
        waiting();
      });
    },
    stop() { for (const w of workers) w.worker.postMessage({ stop: true }); },
  };
}

/** A worker's loop (voiceworker.js): told what to play by the page, it keeps AHEAD past the worklet's acks (of this
 *  play: `gen`), its sound sent to the worklet on `port`, each play's start first. */
export function runVoiceWorker(scope) {
  let host = null, port = null, gen = -1, playing = false;
  const ahead = (sr) => Math.round(AHEAD * sr);
  function fill(until) {
    while (playing && host.pos < until) {
      const n = Math.min(MAX_MAKE, until - host.pos), at = host.pos, made = host.make(n), keys = Object.keys(made);
      if (!keys.length) continue;
      port.postMessage({ voice: { pos: at, keys, L: keys.map((k) => made[k][0]), R: keys.map((k) => made[k][1]) } }, keys.flatMap((k) => [made[k][0].buffer, made[k][1].buffer]));
    }
  }
  let sr = 48000;
  scope.onmessage = ({ data: m }) => {
    if (m.port) {
      sr = m.sr; host = createVoiceHost({ sr }); port = m.port;
      port.onmessage = ({ data: a }) => { if (a.ack && a.ack.gen === gen) fill(a.ack.pos + ahead(sr)); };
    }
    if (m.resolved) host.resolved(m.resolved.key, m.resolved.spec);
    if (m.retune) host.retune(m.retune.key, m.retune.sampler);
    if (m.streams) {
      const before = new Set(host.keys);
      host.streams(m.streams);
      // (a stream added while it plays starts where the worker is)
      const fresh = host.keys.filter((k) => !before.has(k));
      if (playing && fresh.length) port.postMessage({ voiceStart: { keys: fresh, from: host.pos } });
    }
    if (m.play) {
      gen = m.play.gen; playing = true;
      host.play(m.play.from);
      port.postMessage({ voiceStart: { keys: host.keys, from: m.play.from } });
      fill(m.play.from + ahead(sr));
      scope.postMessage({ primed: true });
    }
    if (m.stop) playing = false;
  };
}
