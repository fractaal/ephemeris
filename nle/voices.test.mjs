// The editor's instruments played off the audio thread are what a render plays: node nle/voices.test.mjs
import assert from 'node:assert/strict';
import { createLive, instrumentKey, pluginKey } from './live.js';
import { createVoiceHost, voiceStreams, AHEAD } from './voices.js';
import { controlPoints } from './automation.js';
import { paramsOf } from './device.js';
import { isAutomated } from './model.js';

const SR = 48000;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '\n', e); process.exitCode = 1; }
}

// two samplers, each of one held tone (pitched by key): chords that overlap, on two tracks, one with an effect
const tone = (f, shape) => Float32Array.from({ length: SR * 3 }, (_, i) => 0.3 * shape((i * f / SR) % 1));
const sine = tone(220, (x) => Math.sin(2 * Math.PI * x)), saw = tone(110, (x) => 2 * x - 1);
const samplerSpec = { sfz: 'test.sfz' }, droneSpec = { sfz: 'drone.sfz' };
const resolved = { sampler: { kind: 'sampler', env: { a: 0.01, r: 0.3 }, regions: [{ sample: 's', key: [0, 127], root: 57 }] }, samples: { s: { sr: SR, ch: [sine, sine] } } };
const droneResolved = { sampler: { kind: 'sampler', env: { a: 0.4, r: 0.8 }, regions: [{ sample: 'd', key: [0, 127], root: 45 }] }, samples: { d: { sr: SR, ch: [saw, saw] } } };
const resolvedOf = new Map([[samplerSpec, resolved], [droneSpec, droneResolved]]);
const chord = (t, keys, dur) => keys.map((note) => ({ t, dur, note, vel: 0.7 }));
const plain = {
  media: {
    strings: { kind: 'audio', notes: [...chord(0.1, [45, 52, 57, 60], 1.2), ...chord(0.9, [46, 53, 58, 61], 1.5), ...chord(2.2, [44, 51], 0.6)] },
    drone: { kind: 'audio', notes: [...chord(0.3, [33, 40], 2.4)] },
  },
  tracks: [
    { id: 'a', name: 'Strings', instrument: samplerSpec, clips: [{ id: 'c1', media: 'strings', at: 0, in: 0, out: 3 }], fx: [{ type: 'eq', low: 3 }] },
    { id: 'b', name: 'Drone', instrument: droneSpec, clips: [{ id: 'c2', media: 'drone', at: 0.2, in: 0, out: 3 }], volume: -6, pan: 0.3 },
  ],
};

// what the timeline plays from `from` (s) for `secs`, in 128-sample blocks: as a render (its instruments in the
// engine), or as the editor (streamed from a voice host made ahead in chunks of its own)
// (each native instrument's automation as points, as the page makes them for its workers and a render for its engine)
const controls = (t, media) => controlPoints(t, media, paramsOf(t.instrument, { sampler: resolvedOf.get(t.instrument)?.sampler }), SR, 6 * SR);
function play(streamed, from, secs, tl = plain) {
  const live = createLive({ sr: SR, streamNotes: streamed }), n = Math.round(secs * SR), at0 = Math.round(from * SR);
  let host = null;
  const made = new Map();   // key → { L, R } from at0
  if (streamed) {
    host = createVoiceHost({ sr: SR });
    for (const [spec, r] of resolvedOf) host.resolved(instrumentKey(spec), r);
    host.streams(voiceStreams(tl, SR, controls));
    host.play(at0);
    for (const k of host.keys) {
      const buf = { L: new Float32Array(n + SR), R: new Float32Array(n + SR) };
      made.set(k, buf);
      live.setPluginSound(k, { read(L, R, at, m) { for (let i = 0; i < m; i++) { L[i] += buf.L[at - at0 + i]; R[i] += buf.R[at - at0 + i]; } } });
    }
  } else {
    for (const [spec, r] of resolvedOf) live.setResolved(instrumentKey(spec), r);
    for (const t of tl.tracks) if (isAutomated(t, tl.media)) live.setControls(pluginKey(t.id), controls(t, tl.media));
  }
  live.set(tl); live.seek(from);
  const L = new Float32Array(n), R = new Float32Array(n), bl = new Float32Array(128), br = new Float32Array(128);
  for (let i = 0; i < n; i += 128) {
    while (host && host.pos < live.at() + AHEAD * SR) {   // (made ahead, in chunks unlike the worklet's blocks)
      const at = host.pos, out = host.make(1500);
      for (const [k, [l, r]] of Object.entries(out)) { made.get(k).L.set(l, at - at0); made.get(k).R.set(r, at - at0); }
    }
    const m = Math.min(128, n - i);
    live.process(bl, br, m);
    L.set(bl.subarray(0, m), i); R.set(br.subarray(0, m), i);
  }
  return [L, R];
}
const same = ([a, b], [c, d]) => {
  let worst = 0, loud = 0;
  for (let i = 0; i < a.length; i++) { worst = Math.max(worst, Math.abs(a[i] - c[i]), Math.abs(b[i] - d[i])); loud = Math.max(loud, Math.abs(a[i])); }
  assert.ok(loud > 0.01, `silent (${loud})`);
  assert.equal(worst, 0, `differs by up to ${worst}`);
};

await test('played from the start, the editor plays what a render makes, sample for sample', () => {
  same(play(true, 0, 3.5), play(false, 0, 3.5));
});

await test('played from inside a note, the same', () => {
  same(play(true, 1.37, 2), play(false, 1.37, 2));
});

// the same with each instrument's own parameters automated: one sampler's level and tune, the other's pan
const keys = (pairs) => ({ lanes: [{ id: 'k', kind: 'keys', mode: 'aim', keys: pairs }] });
const moving = { ...plain, tracks: [
  { ...plain.tracks[0], automation: { instrument: { gain: keys([[0.4, 0.83], [2.1, 0.7, 'lin']]), tune: keys([[1, 0.5], [1.6, 0.52, 'smooth']]) } } },
  { ...plain.tracks[1], automation: { instrument: { pan: keys([[0.5, 0.3], [2.5, 0.85, 'lin']]) } } },
] };
await test('automated, the editor plays what a render makes, from the start and from inside a note', () => {
  same(play(true, 0, 3.5, moving), play(false, 0, 3.5, moving));
  same(play(true, 1.37, 2, moving), play(false, 1.37, 2, moving));
});

// the drone's pan moved by lanes of its pattern's own (in its time: from the pattern's start), its clip 0.4 s in; and the
// same lanes on its track, 0.4 s later
const inClip = { media: { ...plain.media, drone: { ...plain.media.drone, automation: { pan: keys([[0.3, 0.2], [1.8, 0.9, 'lin']]) } } },
  tracks: [plain.tracks[0], { ...plain.tracks[1], clips: [{ ...plain.tracks[1].clips[0], at: 0.4 }] }] };
const onTrack = { ...plain, tracks: [plain.tracks[0], { ...inClip.tracks[1], automation: { instrument: { pan: keys([[0.7, 0.2], [2.2, 0.9, 'lin']]) } } }] };
await test('a pattern\'s own automation plays where its clip plays it: as the same lanes on the track, as late as the clip', () => {
  const [a, b] = play(false, 0, 3.5, inClip), [c, d] = play(false, 0, 3.5, onTrack);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - c[i]), Math.abs(b[i] - d[i]));
  assert.ok(worst < 1e-6, `differs by up to ${worst}`);
});
await test('a pattern\'s own automation: the editor plays what a render makes, from the start and from inside a note', () => {
  same(play(true, 0, 3.5, inClip), play(false, 0, 3.5, inClip));
  same(play(true, 1.37, 2, inClip), play(false, 1.37, 2, inClip));
});

await test('a track whose instrument is a plugin is not a voice stream (its host plays it)', () => {
  const keys = voiceStreams({ ...plain, tracks: [plain.tracks[0], { ...plain.tracks[1], instrument: { plugin: 'Vial' } }] }, SR).map((s) => s.key);
  assert.deepEqual(keys, ['a']);
});

console.log(`${passed} passed`);
