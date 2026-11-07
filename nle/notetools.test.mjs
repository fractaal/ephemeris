// The piano roll's tools on notes: node nle/notetools.test.mjs
import assert from 'node:assert/strict';
import { quantize, legato, chop, glue, repeatEvery } from './notetools.js';

const n = (t, dur, note = 60, src = 'a', vel = 0.8) => ({ t, dur, note, vel, src });
const plain = (ns) => ns.map(({ t, dur, note, src }) => [+t.toFixed(3), +dur.toFixed(3), note, src]).sort((a, b) => a[0] - b[0] || a[2] - b[2]);

// quantize moves starts to the grid and keeps lengths
assert.deepEqual(plain(quantize([n(0.11, 0.3), n(0.62, 0.1)], (t) => Math.round(t / 0.25) * 0.25)), [[0, 0.3, 60, 'a'], [0.5, 0.1, 60, 'a']]);

// legato: each note reaches the next start, a chord's notes reach the next chord, the last keep their lengths
assert.deepEqual(plain(legato([n(0, 0.1, 60), n(0, 0.2, 64), n(1, 0.1, 62), n(2, 0.3, 65)])),
  [[0, 1, 60, 'a'], [0, 1, 64, 'a'], [1, 1, 62, 'a'], [2, 0.3, 65, 'a']]);
// …and an overlapping note is cut back to the next start
assert.deepEqual(plain(legato([n(0, 3, 60), n(1, 0.5, 62)])), [[0, 1, 60, 'a'], [1, 0.5, 62, 'a']]);
// …within its own pattern only
assert.deepEqual(plain(legato([n(0, 0.1, 60, 'a'), n(1, 0.1, 62, 'b')])), [[0, 0.1, 60, 'a'], [1, 0.1, 62, 'b']]);

// chop cuts at the times inside a note, and leaves a note with none inside it whole
const quarters = (x) => [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5].filter((c) => c >= x.t && c <= x.t + x.dur);
assert.deepEqual(plain(chop([n(0.1, 0.9, 60)], quarters)), [[0.1, 0.15, 60, 'a'], [0.25, 0.25, 60, 'a'], [0.5, 0.25, 60, 'a'], [0.75, 0.25, 60, 'a']]);
assert.deepEqual(plain(chop([n(0.3, 0.1, 61)], quarters)), [[0.3, 0.1, 61, 'a']]);

// glue joins touching or overlapping notes of one pitch in one pattern, at the first's velocity
const glued = glue([n(0, 0.5, 60, 'a', 0.4), n(0.5, 0.5, 60, 'a', 0.9), n(0.8, 0.6, 60, 'a'), n(2, 0.5, 60), n(0.5, 0.5, 62), n(0.5, 0.5, 60, 'b')]);
assert.deepEqual(plain(glued), [[0, 1.4, 60, 'a'], [0.5, 0.5, 60, 'b'], [0.5, 0.5, 62, 'a'], [2, 0.5, 60, 'a']]);
assert.equal(glued.find((x) => x.t === 0).vel, 0.4);

// duplicate repeats a phrase on the next bar, a note or chord right after itself
const g = { step: 0.125, beat: 0.5, bar: 2 };   // (120 bpm, 4 beats a bar)
assert.equal(repeatEvery(1.75, g), 2);    // a bar's phrase whose last note ends early
assert.equal(repeatEvery(2, g), 2);
assert.equal(repeatEvery(2.5, g), 4);
assert.equal(repeatEvery(0.5, g), 0.5);   // a note a beat long
assert.equal(repeatEvery(0.6, g), 1);
assert.equal(repeatEvery(0.125, g), 0.125);   // a step
assert.equal(repeatEvery(0, g), 0.125);
console.log('notetools: ok');
