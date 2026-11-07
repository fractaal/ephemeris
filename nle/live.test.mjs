// The live engine's mix, as heard: node nle/live.test.mjs
import assert from 'node:assert/strict';
import { createLive, instrumentKey } from './live.js';
import { render } from '../tools/mix.mjs';
import { reverbReady } from '../engine/sound/fx.js';

const sr = 48000, n = 4096;
const tone = (f) => Float32Array.from({ length: sr * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / sr));
const clip = (id, media) => ({ id, media, at: 0, in: 0, out: 2, gain: 0 });
// each track's peak over a stretch of the timeline played as `flags` set them
function heard(flags) {
  const live = createLive({ sr });
  live.addMedia('a', [tone(220), tone(220)]); live.addMedia('b', [tone(330), tone(330)]); live.addMedia('c', [tone(440), tone(440)]);
  live.set({ tracks: ['a', 'b', 'c'].map((m) => ({ id: m, name: m, clips: [clip(m, m)], ...flags[m] })), media: { a: {}, b: {}, c: {} } });
  live.seek(0.5);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let k = 0; k < 3; k++) live.process(L, R, n);
  return Object.fromEntries(Object.entries(live.levels()).map(([id, v]) => [id, v.peak > 0.01]));
}

// a soloed track is heard alone; two soloed, both
assert.deepEqual(heard({ b: { solo: true } }), { a: false, b: true, c: false, master: true });
assert.deepEqual(heard({ a: { solo: true }, c: { solo: true } }), { a: true, b: false, c: true, master: true });
// a muted track is not heard, soloed or not
assert.deepEqual(heard({ a: { mute: true } }), { a: false, b: true, c: true, master: true });
assert.deepEqual(heard({ b: { solo: true, mute: true }, c: { solo: true } }), { a: false, b: false, c: true, master: true });

// a note tried on a track (the piano roll's) is heard through its fader and the master, stopped or playing; muted, not
{
  const tried = (track, playing) => {
    const live = createLive({ sr });
    live.set({ tracks: [{ id: 'a', name: 'a', clips: [], volume: -12, ...track }], media: {}, master: { volume: -6 } });
    live.seek(0);
    live.hear('a', new Float32Array(n).fill(0.5), new Float32Array(n).fill(0.5));
    const L = new Float32Array(n), R = new Float32Array(n);
    if (playing) live.process(L, R, n); else live.processMonitor(L, R, n);
    return Math.max(...L.subarray(n / 2));   // (once the faders have settled)
  };
  for (const playing of [false, true]) {
    assert.ok(Math.abs(tried({}, playing) - 0.5 * 10 ** (-18 / 20)) < 0.002, `heard at -18 dB (${playing ? 'playing' : 'stopped'})`);
    assert.ok(tried({ mute: true }, playing) < 1e-4);
  }
}

// a reverb's impulse responses made elsewhere (irsFrom: the editor's worker), none on the audio thread: a knob turned
// asks for the new room, the reverb plays its last until it comes, then takes each that comes (one on the way, then the
// last asked) — sample for sample as an engine that makes each itself when it comes
{
  const room = (decay) => ({ fx: [{ type: 'reverb', size: 8, decay, mix: 0.5 }] });
  const wants = [], port = { postMessage: (m) => wants.push(m.want) }, give = (w) => port.onmessage({ data: { id: w.id, key: w.key, ir: reverbReady(w.spec, sr) } });
  const worked = createLive({ sr }), here = createLive({ sr });
  worked.irsFrom(port);
  for (const live of [worked, here]) {
    live.addMedia('a', [tone(220), tone(220)]);
    live.set({ tracks: [{ id: 'a', name: 'a', clips: [clip('a', 'a')], ...room(0.6) }], media: { a: {} } });
  }
  assert.equal(wants.length, 1, 'a reverb asks for its room');
  give(wants[0]);
  worked.seek(0); here.seek(0);
  const L = [new Float32Array(1024), new Float32Array(1024)], R = [new Float32Array(1024), new Float32Array(1024)];
  const same = (what) => { for (let b = 0; b < 4; b++) { worked.process(L[0], R[0], 1024); here.process(L[1], R[1], 1024); assert.deepEqual(L[0], L[1], what); assert.deepEqual(R[0], R[1], what); } };
  same('as made here');
  worked.tweak('a', room(1.4)); worked.tweak('a', room(2.2));   // (a knob turning: two rooms asked for)
  assert.equal(wants.length, 3, 'each room the knob turns to is asked for');
  same('its last room until the new one comes');
  give(wants[1]); here.tweak('a', room(1.4));
  same('the room on the way, when it comes');
  give(wants[2]); here.tweak('a', room(2.2));
  same('the last room asked for, when it comes');
}

console.log('live: ok');

// a notes clip's gain and fades are heard: its instrument's sound through them, its release ringing on past the clip
// unless the clip fades out (a sampler of one held sine)
function notes(c) {
  const live = createLive({ sr }), spec = { sampler: 'instruments/sine.json' }, sine = tone(440);
  live.setResolved(instrumentKey(spec), { sampler: { kind: 'sampler', env: { a: 0.001, s: 1, r: 0.4 }, regions: [{ sample: 's', key: [0, 127], root: 69 }] }, samples: { s: { sr, ch: [sine, sine] } } });
  live.set({ tracks: [{ id: 't', name: 't', instrument: spec, clips: [{ id: 'c', media: 'p', at: 0, in: 0, out: 0.5, ...c }] }], media: { p: { notes: [{ t: 0, dur: 0.5, note: 69, vel: 1 }] } } });
  live.seek(0);
  const out = new Float32Array(sr), L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < sr; i += n) { live.process(L, R, Math.min(n, sr - i)); out.set(L.subarray(0, Math.min(n, sr - i)), i); }
  const peak = (a, b) => out.subarray(Math.round(a * sr), Math.round(b * sr)).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  return { held: peak(0.2, 0.3), tail: peak(0.55, 0.6) };
}
const plain = notes({}), quieter = notes({ gain: -6 }), faded = notes({ fadeOut: 0.2 });
assert.ok(Math.abs(quieter.held / plain.held - 0.501) < 0.01, `a clip at −6 dB plays at half (${quieter.held / plain.held})`);
assert.ok(plain.tail > 0.01, 'a note rings on after its clip ends');
assert.ok(faded.tail < 1e-4, `a clip that fades out is silent after its end (${faded.tail})`);
console.log('live notes clips: ok');

// an instrument's own parameters, automated on its track, move what it plays as it plays: a sampler's level and tune
// lower and raise a held note (each lane in 0–1 of the parameter's range) (as a render plays it: tools/mix.mjs)
function automatedNote(instrument, automation, resolved) {
  const tl = { tracks: [{ id: 't', name: 't', instrument, clips: [{ id: 'c', media: 'p', at: 0, in: 0, out: 2 }], automation: { instrument: automation } }], media: { p: { notes: [{ t: 0, dur: 2, note: 57, vel: 1 }] } } };
  const [out] = render(tl, { sr, media: {}, resolved: resolved ? { [JSON.stringify(instrument)]: resolved } : {} });
  const win = (a, b) => out.subarray(Math.round(a * sr), Math.round(b * sr));
  const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  const crossings = (x) => x.reduce((c, v, i) => c + (i && (v >= 0) !== (x[i - 1] >= 0) ? 1 : 0), 0) / x.length;   // (a sample)
  return { early: win(0.05, 0.19), late: win(1.5, 1.9), rms, crossings };   // (before the sweep, and after it)
}
const sweep = (a, b) => ({ lanes: [{ id: 'k', kind: 'keys', mode: 'aim', keys: [[0.2, a], [1.4, b, 'lin']] }] });
{
  const tone = Float32Array.from({ length: 3 * sr }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr));
  const resolved = { sampler: { kind: 'sampler', env: { a: 0.005, r: 0.05 }, regions: [{ sample: 's', key: [0, 127], root: 57 }] }, samples: { s: { sr, ch: [tone, tone] } } };
  const spec = { sampler: 'instruments/tone.json' };
  // (level −60…+12 dB: 0 dB is 60/72 of it, −12 dB 48/72)
  const quieter = automatedNote(spec, { gain: sweep(60 / 72, 48 / 72) }, resolved), drop = 20 * Math.log10(quieter.rms(quieter.late) / quieter.rms(quieter.early));
  assert.ok(Math.abs(drop + 12) < 0.5, `a sampler's level automated down 12 dB lowers a held note 12 dB (${drop.toFixed(2)})`);
  // (tune −2400…+2400 cents: 0 is half of it, an octave up three quarters)
  const higher = automatedNote(spec, { tune: sweep(0.5, 0.75) }, resolved), ratio = higher.crossings(higher.late) / higher.crossings(higher.early);
  assert.ok(Math.abs(ratio - 2) < 0.05, `a sampler's tune automated up an octave raises a held note an octave (${ratio.toFixed(3)}×)`);
}
console.log('live automation: ok');
