// The live sampler: node engine/sound/sampler.test.mjs
// Block-size invariance on real libraries (skipped when /home/benjude/films/_sound/library is absent), and the behaviours on
// small synthetic sounds: timing, chokes, release triggers, loops, reset, the offline render being the live one.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createSampler, sampler } from './sampler.js';
import { createInstrument } from './instrument.js';

const SR = 48000, LIB = '/home/benjude/films/_sound/library';
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '\n', e); process.exitCode = 1; }
}

// A sound of constant 1 (or a ramp, or a sine) of `secs` seconds.
const sound = (secs, f = () => 1, sr = SR) => { const a = Float32Array.from({ length: Math.round(secs * sr) }, (_, i) => f(i)); return { sr, ch: [a, a] }; };
const energy = (a, from, to) => { let e = 0; for (let i = from; i < Math.min(to, a.length); i++) e += a[i] * a[i]; return e; };

// Plays events [{ at, on|off, note, vel }] in blocks of `block` for `length` samples.
function play(live, events, length, block) {
  const L = new Float32Array(length), R = new Float32Array(length);
  const evs = [...events].sort((a, b) => a.at - b.at);
  let e = 0;
  for (let at = 0; at < length; at += block) {
    const n = Math.min(block, length - at);
    while (e < evs.length && evs[e].at < at + n) {
      const x = evs[e++];
      if (x.cc !== undefined) live.cc(x.cc, x.value, x.at - at);
      else if (x.on) live.noteOn(x.note, x.vel ?? 0.8, x.at - at); else live.noteOff(x.note, x.at - at);
    }
    live.process(L.subarray(at, at + n), R.subarray(at, at + n), n);
  }
  return [L, R];
}
const notesToEvents = (notes) => notes.flatMap((n) => [{ at: Math.round(n.t * SR), on: true, note: n.note, vel: n.vel }, { at: Math.round((n.t + n.dur) * SR), note: n.note }]);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i] || (x !== x && b[i] !== b[i]));

// ── real libraries ────────────────────────────────────────────────────────────────────────────────────────────────
async function library(sfz, keys) {
  const { importSfz, loadSample, findFile } = await import('../../tools/instruments.mjs');
  const dir = path.dirname(sfz), inst = await importSfz(sfz, { root: dir });
  // only the regions the test's keys play (and release triggers on them), so decoding stays short
  inst.regions = inst.regions.filter((r) => keys.some((k) => k >= (r.key?.[0] ?? 0) && k <= (r.key?.[1] ?? 127)));
  const samples = new Map();
  for (const rel of new Set(inst.regions.map((r) => r.sample))) { const f = await findFile(path.resolve(dir, rel)); if (f) samples.set(rel, await loadSample(f)); }
  return { inst, samples };
}

const libs = [
  ['piano with release samples', `${LIB}/keys/freepats-upright-kw/UprightPianoKW-SFZ+FLAC-20220221/UprightPianoKW-20220221.sfz`, [48, 60, 64, 67],
    [{ t: 0, dur: 0.5, note: 60, vel: 0.7 }, { t: 0.123, dur: 0.6, note: 64, vel: 0.5 }, { t: 0.3, dur: 0.2, note: 67, vel: 0.9 }, { t: 0.45, dur: 0.4, note: 48, vel: 0.3 }, { t: 0.6, dur: 0.1, note: 60, vel: 0.8 }]],
  ['drum kit, hats choke, round robins', `${LIB}/drums/karoryfer-big-rusty-drums/Programs/02-basic.sfz`, [36, 38, 42, 46],
    [...Array.from({ length: 8 }, (_, i) => ({ t: i * 0.071, dur: 0.02, note: 42, vel: 0.4 + (i % 3) * 0.25 })),
      { t: 0.1, dur: 0.05, note: 46, vel: 0.8 }, { t: 0.42, dur: 0.05, note: 42, vel: 0.8 }, { t: 0.2, dur: 0.1, note: 36, vel: 0.9 },
      { t: 0.31, dur: 0.1, note: 38, vel: 0.8 }, { t: 0.33, dur: 0.1, note: 38, vel: 0.8 }]],
  ['looped sustain instrument (VSCO flute)', `${LIB}/instruments/vsco2ce-selected/FluteSusNV.sfz`, [69, 72, 76],
    [{ t: 0, dur: 0.6, note: 72, vel: 0.7 }, { t: 0.2, dur: 0.5, note: 76, vel: 0.6 }, { t: 0.31, dur: 0.15, note: 69, vel: 0.9 }]],
];
for (const [name, sfz, keys, notes] of libs) {
  await test(`invariance: ${name}`, async () => {
    if (!fs.existsSync(sfz)) { console.log('     (library absent, skipped)'); return; }
    const { inst, samples } = await library(sfz, keys), length = Math.round(1.6 * SR), events = notesToEvents(notes);
    const ref = play(createSampler(inst, samples, { sr: SR }), events, length, 128);
    assert.ok(ref[0].some((x) => x !== 0), 'silent output proves nothing');
    for (const block of [37, 512, 1]) {
      const got = play(createSampler(inst, samples, { sr: SR }), events, length, block);
      assert.ok(same(ref[0], got[0]) && same(ref[1], got[1]), `block ${block} differs`);
    }
    const off = sampler(inst, samples).render(notes, { sr: SR, length: length / SR });
    assert.ok(same(ref[0], off.ch[0]), 'offline render differs from live');
  });
}

// ── synthetic ─────────────────────────────────────────────────────────────────────────────────────────────────────
const one = (extra = {}, env = {}) => ({ kind: 'sampler', env: { a: 0.0005, r: 0.003, ...env }, regions: [{ sample: 'x', key: [0, 127], root: 60, ...extra }] });

await test('a note starts at its exact sample and ends in its release', () => {
  const live = createSampler(one(), { x: sound(2) }, { sr: SR });
  const [L] = play(live, [{ at: 1000, on: true, note: 60, vel: 1 }, { at: 5000, note: 60 }], 8000, 128);
  assert.equal(L.findIndex((x) => x !== 0), 1001); // sample 1000 is the attack's first, still 0
  assert.ok(L[4999] > 0.9 && L[5000] > 0.9, 'held until the note off');
  assert.equal(L[5000 + 0.003 * SR + 2], 0);
  assert.ok(L[5000 + 70] < L[5000 + 10]);
});

await test('every block size, a note on inside the block, the same', () => {
  const inst = one({}, { a: 0.01, r: 0.05 }), s = { x: sound(1, (i) => Math.sin(i * 0.05)) };
  const ev = [{ at: 5, on: true, note: 62 }, { at: 90, on: true, note: 67 }, { at: 3000, note: 62 }, { at: 3001, note: 67 }];
  const ref = play(createSampler(inst, s, { sr: SR }), ev, 9000, 128);
  for (const b of [1, 7, 37, 128, 1000]) assert.ok(same(ref[0], play(createSampler(inst, s, { sr: SR }), ev, 9000, b)[0]), `block ${b}`);
});

await test('pitch: an octave up plays twice as fast', () => {
  const live = createSampler(one(), { x: sound(1, (i) => Math.sin(2 * Math.PI * 440 * i / SR)) }, { sr: SR });
  const [L] = play(live, [{ at: 0, on: true, note: 72, vel: 1 }], 12000, 128);
  let crossings = 0;
  for (let i = 2000; i < 10000; i++) if (L[i - 1] < 0 && L[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings - 8000 / SR * 880) <= 1, `${crossings} crossings`);
});

await test('a hit in a group cuts the voices it cuts', () => {
  const inst = { kind: 'sampler', env: { r: 0.01 }, regions: [
    { sample: 'x', key: [46, 46], root: 46, keytrack: 0, group: 2, offBy: 1, loop: { mode: 'oneshot' } },
    { sample: 'x', key: [42, 42], root: 42, keytrack: 0, group: 1, loop: { mode: 'oneshot' } }] };
  const s = { x: sound(1) };
  const open = play(createSampler(inst, s, { sr: SR }), [{ at: 0, on: true, note: 46 }, { at: 10, note: 46 }], 20000, 128)[0];
  assert.ok(open[15000] > 0.5, 'the open hat rings');
  const inst2 = { ...inst, regions: [inst.regions[0], { ...inst.regions[1], sample: 'y' }] };
  const quiet = play(createSampler(inst2, { x: sound(1), y: sound(0.001, () => 0) }, { sr: SR }), [{ at: 0, on: true, note: 46 }, { at: 10, note: 46 }, { at: 4000, on: true, note: 42 }, { at: 4010, note: 42 }], 20000, 128)[0];
  assert.ok(quiet[3999] > 0.5 && quiet[4000 + 0.01 * SR + 5] === 0 && quiet[15000] === 0, 'cut with its fast release');
  assert.ok(quiet[4000 + 100] < quiet[3999], 'falling');
});

await test('round robins come in turn, and random layers from the notes alone', () => {
  const inst = { kind: 'sampler', env: { r: 0.003 }, regions: [1, 2, 3].map((p) => ({ sample: 's' + p, key: [60, 60], root: 60, rr: { length: 3, position: p } })) };
  const s = { s1: sound(0.05, () => 0.25), s2: sound(0.05, () => 0.5), s3: sound(0.05, () => 1) };
  const ev = [0, 1, 2, 3].flatMap((i) => [{ at: i * 4000, on: true, note: 60, vel: 1 }, { at: i * 4000 + 1000, note: 60 }]);
  const [L] = play(createSampler(inst, s, { sr: SR }), ev, 16000, 128);
  const lvl = [0, 1, 2, 3].map((i) => Math.round(L[i * 4000 + 500] * 100) / 100 / (L[500] || 1));
  assert.deepEqual(lvl.map((x) => Math.round(x * 4) / 4), [1, 2, 4, 1].map((x) => x / 1));
});

await test('release triggers play when the note ends, quieter the longer it was held (rtDecay)', () => {
  const inst = { kind: 'sampler', env: { r: 0.05 }, regions: [{ sample: 'x', key: [60, 60], root: 60 }, { sample: 'r', key: [60, 60], root: 60, trigger: 'release', rtDecay: 6 }] };
  const s = { x: sound(5, () => 0.5), r: sound(0.2, () => 1) };
  const run = (hold) => play(createSampler(inst, s, { sr: SR }), [{ at: 0, on: true, note: 60, vel: 1 }, { at: hold * SR, note: 60 }], 5 * SR / 2, 128)[0];
  const a = run(0.5), b = run(1.5);
  const after = (L, hold) => L[Math.round(hold * SR) + 0.15 * SR];
  assert.ok(after(a, 0.5) > 0.5 * 0.9, 'the release sample sounds after the main voice has faded');
  assert.ok(after(b, 1.5) < after(a, 0.5), 'longer held: quieter');
});

await test('a sustain loop holds while the note is held, then plays on', () => {
  const inst = one({ loop: { mode: 'sustain', start: 0.1, end: 0.2 } });
  // 0–0.1 s: 0.2, loop 0.1–0.2 s: 0.6, rest: 1.0
  const s = { x: sound(0.4, (i) => (i < 0.1 * SR ? 0.2 : i < 0.2 * SR ? 0.6 : 1)) };
  const [L] = play(createSampler(inst, s, { sr: SR }), [{ at: 0, on: true, note: 60, vel: 1 }, { at: 0.5 * SR, note: 60 }], SR, 128);
  assert.ok(Math.abs(L[0.45 * SR] - 0.6) < 0.01, 'still looping after the sample is over');
  assert.ok(Math.abs(L[0.05 * SR] - 0.2) < 0.01);
  assert.ok(L[0.5 * SR + 0.003 * SR + 10] === 0, 'and the release ends it');
});

await test('reset silences everything and starts the notes counting again', () => {
  const inst = { kind: 'sampler', env: { r: 0.003 }, regions: [1, 2].map((p) => ({ sample: 's' + p, key: [60, 60], root: 60, rr: { length: 2, position: p } })) };
  const s = { s1: sound(0.5, () => 0.25), s2: sound(0.5, () => 1) };
  const ev = [{ at: 0, on: true, note: 60 }, { at: 100, note: 60 }];
  const live = createSampler(inst, s, { sr: SR });
  const first = play(live, ev, 4000, 128)[0];
  live.noteOn(60, 1, 0); live.process(new Float32Array(10), new Float32Array(10), 10); // advances the round robin, leaves a voice
  live.reset();
  assert.equal(live.active, 0);
  const again = play(live, ev, 4000, 128)[0];
  assert.ok(same(first, again), 'as if new');
});

await test('cc gates regions', () => {
  const inst = { kind: 'sampler', env: { r: 0.003 }, regions: [{ sample: 'x', key: [60, 60], root: 60, cc: { 1: [64, 127] } }] };
  const live = createSampler(inst, { x: sound(1) }, { sr: SR });
  const [L] = play(live, [{ at: 0, cc: 1, value: 10 }, { at: 100, on: true, note: 60 }, { at: 1000, note: 60 }, { at: 2000, cc: 1, value: 100 }, { at: 2100, on: true, note: 60 }], 4000, 128);
  assert.equal(L[500], 0); assert.ok(L[2500] > 0);
});

await test('the offline render is the live sampler, notes at their rounded samples', () => {
  const inst = one(), s = { x: sound(1, (i) => Math.sin(i * 0.03)) };
  const notes = [{ t: 0.1, dur: 0.2, note: 60 }, { t: 0.25, dur: 0.3, note: 65, vel: 0.5 }];
  const off = sampler(inst, s).render(notes, { sr: SR, length: 1 });
  const live = play(createSampler(inst, s, { sr: SR }), notesToEvents(notes), SR, 128);
  assert.ok(same(off.ch[0], live[0]) && same(off.ch[1], live[1]));
  const free = sampler(inst, s).render(notes, { sr: SR });
  assert.ok(free.ch[0].length > 0.55 * SR && free.ch[0].length < 0.6 * SR, `${free.ch[0].length}`);
});

await test('createInstrument gives the sampler to the live engine', () => {
  const inst = createInstrument({ sampler: one(), samples: { x: sound(1) } }, { sr: SR });
  const L = new Float32Array(300), R = new Float32Array(300);
  inst.noteOn(60, 1, 10); inst.process(L, R, 300);
  assert.ok(L[100] > 0 && L[5] === 0);
});

await test('the live instrument takes a changed sampler, again and again (a setting dragged while it plays)', () => {
  const s = { x: sound(1) }, base = one(), inst = createInstrument({ sampler: base, samples: s }, { sr: SR });
  const level = (gain) => {
    inst.set({ sampler: { ...base, regions: base.regions.map((r) => ({ ...r, gain })) }, samples: s });
    inst.reset(); inst.noteOn(60, 1, 0);
    const L = new Float32Array(4800), R = new Float32Array(4800); inst.process(L, R, 4800);
    return energy(L, 0, 4800);
  };
  const loud = level(0), quiet = level(-40), back = level(0);
  assert.ok(quiet < loud / 1000, `${quiet} vs ${loud}`);
  assert.ok(Math.abs(back - loud) < loud * 1e-6);
});

await test('more notes than voices made up front: every one sounds, none cut short', () => {
  const level = (count) => {
    const live = createSampler(one(), { x: sound(2) }, { sr: SR, voices: 4 }), L = new Float32Array(SR / 2), R = new Float32Array(SR / 2);
    for (let i = 0; i < count; i++) live.noteOn(60, 0.8, i * 48);   // (a note each millisecond, all held)
    live.process(L, R, SR / 2);
    return { level: L[SR / 2 - 1], active: live.active };
  };
  const once = level(1), all = level(100);
  assert.equal(all.active, 100);
  assert.ok(Math.abs(all.level - 100 * once.level) < 1e-3 * all.level, `${all.level} vs 100 × ${once.level}`);
});

await test('timing: 32 sounding pitched voices, 12 taps, µs per 128-sample block', () => {
  const s = { x: sound(30, (i) => Math.sin(i * 0.02) + 0.3 * Math.sin(i * 0.31)) };
  const live = createSampler(one({ loop: { mode: 'continuous', start: 1, end: 29 } }), s, { sr: SR, voices: 64 });
  for (let i = 0; i < 32; i++) live.noteOn(40 + i * 1.3, 0.8, 0); // pitched both up and down: the slow path and the anti-alias one
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let i = 0; i < 50; i++) live.process(L, R, 128);
  const N = 300, t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { L.fill(0); R.fill(0); live.process(L, R, 128); }
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
  console.log(`     ${us.toFixed(0)} µs per block (budget 2667)`);
  assert.equal(live.active, 32);
  assert.ok(us < 2667 / 2, `${us} µs`);
});

console.log(`${passed} passed`);
