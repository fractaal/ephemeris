// The editor's sound, played live: the live engine (live.js) in an AudioWorklet, fed the timeline, its media and its
// instruments by the page (audio.js), and told when to play from where. It starts at the exact sample it was asked for
// (a frame of the audio clock), so playing from the start is sample for sample what a render makes. A plugin
// instrument's sound comes from its host as it is made (plugins.js), and each sampler's from a voice worker
// (voices.js: on a port of its own, each told here where the worklet plays), kept here until it is played. The metronome
// (metronome.js), when on, is added after the master: the director's alone.
import { createLive } from './live.js';
import { createMetronome } from './metronome.js';

const LEVELS = 4;   // blocks between meter readings sent to the page (~11 ms at 48 kHz)
const KEEP = 1 << Math.ceil(Math.log2(sampleRate));   // samples of a plugin's sound kept (a second or more: its host keeps 0.3 s ahead)

// a plugin's sound as it comes: one stretch from where it started playing, the last KEEP samples of it
function streamOf() {
  const l = new Float32Array(KEEP), r = new Float32Array(KEEP);
  let from = 0, to = 0;
  return {
    missing: 0,   // samples asked for before they came (while playing)
    start(s) { from = to = s; },
    /** A block of it (from its host): taken where it goes on from what it has, else (a stale one) dropped. */
    write(pos, L, R) {
      if (pos !== to) return;
      for (let i = 0; i < L.length; i++) { const j = (pos + i) & (KEEP - 1); l[j] = L[i]; r[j] = R[i]; }
      to += L.length;
      if (to - from > KEEP) from = to - KEEP;
    },
    read(L, R, at, n) {
      for (let i = 0; i < n; i++) {
        const s = at + i;
        if (s < from) continue;
        if (s >= to) { this.missing += at + n - s; break; }
        const j = s & (KEEP - 1);
        L[i] += l[j]; R[i] += r[j];
      }
    },
  };
}

class LiveProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.live = createLive({ sr: sampleRate, streamNotes: true });
    this.click = createMetronome({ sr: sampleRate });
    this.state = 'stopped'; this.start = 0; this.count = 0;
    this.tmpL = new Float32Array(128); this.tmpR = new Float32Array(128);
    this.streams = new Map();
    this.pluginFrom = 0;   // where the hosts were last asked to play from (a stream that comes later starts there)
    // the voice workers' streams (voices.js): each play's start, then its sound, in order on the worker's own port
    this.voices = new Map(); this.ports = []; this.gen = 0;
    const voice = (key) => { let s = this.voices.get(key); if (!s) { s = streamOf(); this.voices.set(key, s); this.live.setPluginSound(key, s); } return s; };
    const fromWorker = ({ data: m }) => {
      if (m.voiceStart) for (const key of m.voiceStart.keys) voice(key).start(m.voiceStart.from);
      if (m.voice) m.voice.keys.forEach((key, i) => this.voices.get(key)?.write(m.voice.pos, m.voice.L[i], m.voice.R[i]));
    };
    const stream = (key) => { let s = this.streams.get(key); if (!s) { s = streamOf(); s.start(this.pluginFrom); this.streams.set(key, s); this.live.setPluginSound(key, s); } return s; };
    this.port.onmessage = ({ data: m }) => {
      if (m.plugin) return stream(m.plugin.key).write(m.plugin.pos, m.plugin.L, m.plugin.R);
      if (m.voicePort) { m.voicePort.onmessage = fromWorker; this.ports.push(m.voicePort); }
      if (m.irPort) this.live.irsFrom(m.irPort);   // (the reverbs' impulse responses, made by a worker: audio.js)
      // (the plugin instruments' worker: their sound, and what is said of it, on its own port, in order: plugins.js)
      if (m.pluginPort) { m.pluginPort.onmessage = this.port.onmessage; this.ports.push(m.pluginPort); }
      if (m.pluginStart != null) {   // { from, key? }: every host (or one, joining) asked to play from there
        if (m.pluginStart.key) stream(m.pluginStart.key).start(m.pluginStart.from);
        else { for (const s of this.streams.values()) s.start(m.pluginStart.from); this.pluginFrom = m.pluginStart.from; }
      }
      if (m.pluginDrop) { this.streams.delete(m.pluginDrop); this.live.setPluginSound(m.pluginDrop, null); }
      // stopped, some plugins are heard as they are played, through their tracks (live.js monitor)
      if (m.monitor !== undefined) {
        this.live.monitor(null);
        if (m.monitor) this.live.monitor([], m.monitor.from);
        else if (this.monitoring) this.port.postMessage({ levels: {}, monitoring: false });   // (the meters fall)
        this.monitoring = !!m.monitor;
      }
      if (m.monitorKeys && this.monitoring) this.live.monitor(m.monitorKeys);
      if (m.hear) this.live.hear(m.hear.track, m.hear.L, m.hear.R);   // (a note tried: heard through its track)
      for (const [id, ch] of Object.entries(m.media ?? {})) this.live.addMedia(id, ch);
      for (const id of m.drop ?? []) this.live.removeMedia(id);
      // (the timeline again when what it plays arrived after it: a medium decoded)
      if (m.timeline) this.tl = m.timeline;
      if (this.tl && (m.timeline || m.media || m.drop)) this.live.set(this.tl);
      if (m.grid !== undefined) this.click.set({ grid: m.grid });
      if (m.metronome) this.click.set(m.metronome);
      if (m.play) { this.gen = m.play.gen; this.live.seek(m.play.t); this.click.seek(); this.start = Math.round(m.play.at * sampleRate); this.state = 'waiting'; }
      if (m.stop) this.state = 'stopped';
      if (m.tweak) this.live.tweak(m.tweak.id, m.tweak.strip);   // (a value being dragged on a strip: audio.js tweak)
      if (m.tap) this.live.tap(m.tap.key, m.tap.id, m.tap.at, m.tap.port);   // (an effect's view watching it: audio.js tap)
      if (m.untap) this.live.untap(m.untap);
    };
  }
  process(_, outputs) {
    const [L, R] = outputs[0], n = L.length;
    if (this.state === 'stopped') {
      const hearing = this.live.hearing();
      if (!this.monitoring && !hearing) { if (this.tried) { this.tried = false; this.port.postMessage({ levels: {}, monitoring: false }); } return true; }   // (the meters fall)
      this.tried = hearing;
      this.live.processMonitor(L, R, n);
      if (++this.count % LEVELS === 0) this.port.postMessage({ at: this.live.monitorAt(), levels: this.live.levels(), monitoring: true });
      return true;
    }
    let at = 0;
    if (this.state === 'waiting') {
      at = this.start - currentFrame;
      if (at >= n) return true;
      at = Math.max(0, at); this.state = 'playing';
    }
    const s = Math.round(this.live.time() * sampleRate);   // (the timeline sample this block's sound starts at)
    if (at) {   // (it starts inside this block: silence until the asked-for frame)
      this.live.process(this.tmpL, this.tmpR, n - at);
      L.set(this.tmpL.subarray(0, n - at), at); R.set(this.tmpR.subarray(0, n - at), at);
    } else this.live.process(L, R, n);
    this.click.process(L, R, n - at, s, at);
    if (++this.count % LEVELS === 0) {
      let missing = 0, voiceMissing = 0;
      for (const s of this.streams.values()) missing += s.missing;
      for (const s of this.voices.values()) voiceMissing += s.missing;
      const ack = { ack: { pos: this.live.at(), gen: this.gen } };
      for (const p of this.ports) p.postMessage(ack);
      this.port.postMessage({ levels: this.live.levels(), t: this.live.time(), at: this.live.at(), missing, voiceMissing });
    }
    return true;
  }
}
registerProcessor('ephemeris-live', LiveProcessor);
