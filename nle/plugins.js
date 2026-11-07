// The editor's plugin instruments: each track's plugin instrument (its instrument: { plugin, state, set }) is played by
// its own host in the studio (tools/plugins.mjs pluginSocket: api/plugins, a WebSocket), from the same notes the live
// engine has (live.js noteEvents), and its sound streamed into the worklet, a little ahead of where it plays
// (liveworklet.js keeps it, live.js reads it at the samples it plays): the socket is held by a worker (pluginworker.js)
// that sends the sound to the worklet itself, off the main thread. audio.js drives it:
//   const link = createPluginLink({ sr, post })   // post: a message to the worklet
//   link.update(heard)                            // the timeline as heard: sessions opened, changed, closed
//   await link.play(from)                         // every host plays from that sample: resolves once each has a start
//   link.ack(pos) · link.stop()                   // where the worklet is now · stopped
//   link.focus(key) · link.note(key, note, on)   // the plugin being worked on (the Instrument panel's), and a note on it
//   link.hear(key, note, vel, dur)               // a note heard now (the piano roll's), the plugin monitored meanwhile
//   link.editor(key, open) · link.onSaved(fn) · link.status(key) · link.onStatus(fn)
// A track's automation of each plugin (automation.js) is sent to its host whenever it, its instrument or the values its
// state gives change.
// While the timeline is stopped, the plugin being worked on, and any whose window is open, are monitored: their hosts
// play as they are played (their window's keyboard, note()), a little ahead of the worklet's own clock.
import { noteEvents, pluginKey, PLUGIN_TAIL } from './live.js';
import { automationPoints } from './automation.js';
import { clipEnd, notesClips, INSTRUMENT } from './model.js';

const AHEAD = 0.3;    // seconds each host keeps ahead of where the worklet plays (what reaches the editor late, on a busy
                      // machine, is not heard: a change while it plays is heard this much later)
const PRIME = 0.05;   // seconds of sound each host has made before playing starts (at most PRIME_WAIT for it)
const PRIME_WAIT = 400;
const MONITOR_AHEAD = 0.04;   // (shorter: a note played is heard sooner; the timeline's own notes need no hurry)

export function createPluginLink({ sr, post }) {
  const sessions = new Map();   // key → { spec, specKey, notesKey, id, ready, error, info, from }
  const byId = new Map();
  let worker = null, open = false, grid = '', saved = () => {}, playing = null, primed = null, primeSeq = 0, at = 0, end = 0;
  const listeners = new Set(), changed = (key) => { for (const fn of listeners) fn(key); };
  let focus = null, mon = null;   // the panel's plugin; while monitoring: { keys } (their streams on the worklet's monitor clock)
  const heard = new Map();        // key → a timer: a plugin a note was just heard on, monitored until its note has rung
  const send = (m) => { if (open) worker.postMessage({ send: m }); };
  // (what the worklet is told of the hosts' sound: through the worker, once there is one, in order with the sound)
  const toWorklet = (m) => (worker ? worker.postMessage({ worklet: m }) : post(m));

  function connect() {
    if (!worker) {
      worker = new Worker(new URL('./pluginworker.js', import.meta.url), { type: 'module' });
      const ch = new MessageChannel();
      worker.postMessage({ port: ch.port1 }, [ch.port1]);
      post({ pluginPort: ch.port2 }, [ch.port2]);
      worker.onmessage = ({ data }) => fromWorker(data);
      worker.onerror = (e) => console.warn(`plugin worker: ${e.message}`);
    }
    worker.postMessage({ connect: new URL('api/plugins', location.href).href.replace(/^http/, 'ws') });
  }
  function fromWorker(d) {
    if (d.open) {
      open = true;
      grid = '';
      for (const [key, s] of sessions) start(key, s);   // (again, after the studio was restarted: each joins when ready)
      return;
    }
    if (d.closed) { open = false; for (const s of sessions.values()) s.ready = false; byId.clear(); setTimeout(connect, 1000); return; }
    if (d.primed != null) { if (primed?.seq === d.primed) primed.done(); return; }
    const m = d.msg, s = sessions.get(m.key);
    if (!s) return;
    if (m.event === 'ready') { s.ready = true; s.error = ''; s.info = m; s.id = m.id; byId.set(m.id, m.key); s.autoKey = ''; automate(m.key, s); if (playing != null) join(m.key); }
    else if (m.event === 'values') { for (const p of s.info?.params ?? []) if (m.values[p.id] != null) p.value = m.values[p.id]; s.autoKey = ''; automate(m.key, s); }
    else if (m.event === 'error') { s.error = m.message; console.warn(`plugin ${m.key}: ${m.message}`); }
    else if (m.event === 'editor') s.editorOpen = m.open;
    else if (m.event === 'saved') return saved({ key: m.key, track: s.track.id, state: m.state });
    changed(m.key);
    monitor();
  }
  // a host ready while the timeline plays: it plays from a little past where the worklet is (silent until it catches up)
  function join(key) {
    const from = at + Math.round(AHEAD * sr), keys = key ? [key] : [...sessions.keys()];
    for (const k of keys) { toWorklet({ pluginStart: { from, key: k } }); send({ op: 'play', key: k, from, ahead: Math.round(AHEAD * sr) }); }
  }
  // the plugins monitored while stopped: the panel's, and those whose window is open (on a clock from 0)
  function monitor() {
    if (playing != null) return;
    const want = new Set([...sessions].filter(([k, s]) => s.ready && (k === focus || s.editorOpen || heard.has(k))).map(([k]) => k));
    if (!want.size) { if (mon) { for (const k of mon.keys) send({ op: 'stop', key: k }); mon = null; toWorklet({ monitor: null }); } return; }
    const fresh = !mon;
    if (fresh) { mon = { keys: new Set() }; at = 0; toWorklet({ monitor: { from: 0 } }); }
    for (const k of mon.keys) if (!want.has(k)) { send({ op: 'stop', key: k }); mon.keys.delete(k); }
    for (const k of want) {
      if (mon.keys.has(k)) continue;
      const from = fresh ? 0 : at + Math.round(MONITOR_AHEAD * sr);
      toWorklet({ pluginStart: { from, key: k } });
      send({ op: 'monitor', key: k, from, ahead: Math.round(MONITOR_AHEAD * sr) });
      mon.keys.add(k);
    }
    toWorklet({ monitorKeys: [...mon.keys] });
  }
  // a track's automation of its plugin (its own, and its clips'), as points for its host (sent again only when either,
  // where the clips are, the instrument or the state's values change: the base of each lane)
  function automate(key, s) {
    if (!s.ready || !s.track) return;
    const clips = notesClips(s.track, s.media), autoKey = JSON.stringify([s.track.automation?.[INSTRUMENT] ?? null, clips, clips.map((c) => s.media[c.media].automation ?? null), s.spec.set ?? null, end]);
    if (autoKey === s.autoKey) return;
    s.autoKey = autoKey;
    const param = (title) => s.info.params.find((p) => p.title === title);
    send({ op: 'automation', key, list: automationPoints(s.track, s.media, sr, Math.ceil((end + PLUGIN_TAIL) * sr), (t) => param(t)?.id ?? null, (t) => s.spec.set?.[t] ?? param(t)?.value ?? 0) });
  }
  function start(key, s) {
    s.ready = false;
    send({ op: 'open', key, spec: s.spec, sr });
    send({ op: 'tempo', grid: s.grid });
    send({ op: 'notes', key, list: s.list });
  }

  return {
    /** The timeline as heard: a session for each track's plugin instrument; opened, changed, closed to match. */
    update(heard) {
      const want = new Map();
      for (const t of heard.tracks) if (t.instrument?.plugin && notesClips(t, heard.media).length) want.set(pluginKey(t.id), { spec: t.instrument, track: t });
      if (!want.size && !sessions.size) return;
      if (!worker) connect();
      end = Math.max(0, ...heard.tracks.flatMap((t) => t.clips.map(clipEnd)));
      const g = JSON.stringify(heard.grid ?? {});
      if (g !== grid) { grid = g; send({ op: 'tempo', grid: heard.grid }); }
      for (const [key, w] of want) {
        const list = noteEvents(w.track, heard, sr).map((e) => [e.s, e.on ? 1 : 0, e.note, e.vel ?? 0]), notesKey = JSON.stringify(list), specKey = JSON.stringify(w.spec);
        let s = sessions.get(key);
        if (!s || s.spec.plugin !== w.spec.plugin) {
          if (s) { send({ op: 'close', key }); byId.delete(s.id); }
          s = { spec: w.spec, specKey, notesKey, list, grid: heard.grid, track: w.track, media: heard.media, title: w.track.name || w.track.id };
          sessions.set(key, s);
          start(key, s);
          continue;
        }
        if (s.specKey !== specKey) { s.spec = w.spec; s.specKey = specKey; send({ op: 'spec', key, spec: w.spec }); }
        if (s.notesKey !== notesKey) { s.notesKey = notesKey; s.list = list; send({ op: 'notes', key, list }); }
        s.grid = heard.grid; s.track = w.track; s.media = heard.media;
        automate(key, s);
      }
      for (const [key, s] of sessions) if (!want.has(key)) { send({ op: 'close', key }); byId.delete(s.id); sessions.delete(key); mon?.keys.delete(key); toWorklet({ pluginDrop: key }); }
    },
    /** Every host plays from sample `from`; resolves once each (that is ready) has made a little of its sound. */
    play(from) {
      if (mon) { mon = null; toWorklet({ monitor: null }); }
      playing = from; at = from;
      toWorklet({ pluginStart: { from } });
      if (!sessions.size) return Promise.resolve();
      send({ op: 'play', from, ahead: Math.round(AHEAD * sr) });
      return new Promise((done) => {
        const seq = ++primeSeq, timer = setTimeout(() => { primed = null; done(); }, PRIME_WAIT);
        primed = { seq, done: () => { clearTimeout(timer); primed = null; done(); } };
        if ([...sessions.values()].every((x) => !x.ready)) primed.done();
        else worker.postMessage({ prime: { until: from + Math.round(PRIME * sr), seq } });   // (answered once each has)
      });
    },
    ack(pos) { at = pos; if (playing != null || mon) send({ op: 'ack', pos }); },
    stop() { playing = null; send({ op: 'stop' }); mon = null; monitor(); },
    /** The plugin being worked on (the Instrument panel's), monitored while stopped; null: none. */
    focus(key) { if (key !== focus) { focus = key; monitor(); } },
    /** A note played on a plugin now (heard while it plays or is monitored). */
    note(key, note, on, velocity = 0.8) { send({ op: 'note', key, note, on, velocity }); },
    /** A note heard now on a plugin, `dur` seconds long: monitored (if it was not) until it has rung. False: not started yet. */
    hear(key, note, velocity = 0.8, dur = 0.7) {
      if (!sessions.get(key)?.ready) return false;
      clearTimeout(heard.get(key));
      heard.set(key, setTimeout(() => { heard.delete(key); monitor(); }, (dur + 3) * 1000));
      monitor();   // (before the note: the host is monitoring when it comes)
      send({ op: 'note', key, note, on: true, velocity });
      setTimeout(() => send({ op: 'note', key, note, on: false }), dur * 1000);
      return true;
    },
    /** Opens (or closes) a track's plugin's own window. */
    editor(key, show = true) { const s = sessions.get(key); if (s) send({ op: 'editor', key, open: show, title: `${s.info?.name ?? s.spec.plugin} · ${s.title}` }); },
    /** fn({ key, track, state }): a plugin was changed in its window, and its state saved as that file in the project. */
    onSaved(fn) { saved = fn; },
    /** fn(key): a session's status changed (ready, an error, its window opened or closed). */
    onStatus(fn) { listeners.add(fn); },
    status: (key) => { const s = sessions.get(key); return s ? { ready: !!s.ready, error: s.error ?? '', info: s.info ?? null, editor: !!s.editorOpen } : null; },
  };
}
