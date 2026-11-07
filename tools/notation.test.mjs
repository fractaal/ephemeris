// Notes as text: node tools/notation.test.mjs
import assert from 'node:assert/strict';
import { parse, write, NotationError } from './notation.mjs';

const grid = { bpm: 120, offset: 0, beatsPerBar: 4 };   // (a beat 0.5 s, a bar 2 s)
const notes = (text, g = grid) => parse(text, g).notes.map(({ t, dur, note, vel }) => [t, dur, note, vel]);

// a note: its bar and beat from 0, its name, length and velocity
assert.deepEqual(notes('4.0 F1 1/2 .9'), [[8, 1, 29, 0.9]]);
// a chord; the velocity unsaid is .8, the length unsaid a sixteenth
assert.deepEqual(notes('0.2 Ab3 C4 Eb4'), [[1, 0.125, 56, 0.8], [1, 0.125, 60, 0.8], [1, 0.125, 63, 0.8]]);
// each note of a chord its own velocity
assert.deepEqual(notes('0.0 C4:.5 G4:1.0 1/4'), [[0, 0.5, 60, 0.5], [0, 0.5, 67, 1]]);
// a sixteenth, early by ms; a MIDI number
assert.deepEqual(notes('0.3.2-12ms 72 1/16 .7'), [[1.738, 0.125, 72, 0.7]]);
// a triplet's place and length
assert.deepEqual(notes('0.1+1/3 G4 1/8t'), [[0.666667, 0.166667, 67, 0.8]]);
// lengths: dotted, beats, bars, ms, s
assert.deepEqual(notes('0.0 C4 1/8.\n1.0 C4 1.5b\n2.0 C4 2bar\n3.0 C4 250ms\n4.0 C4 0.4s').map((n) => n[1]), [0.375, 0.75, 4, 0.25, 0.4]);
// swing moves the off-beat sixteenths only (58%: by 0.16 of a sixteenth); 1/8 swing the off-beat eighths
assert.deepEqual(notes('swing 58%\n0.0 C4\n0.0.1 C4\n0.0.2 C4').map((n) => n[0]), [0, 0.145, 0.25]);
assert.deepEqual(notes('swing 60% 1/8\n0.0.1 C4\n0.0.2 C4').map((n) => n[0]), [0.125, 0.3]);
// vel and len set what follows
assert.deepEqual(notes('vel .5\nlen 1/4\n0.0 C4\nvel .6\n0.1 D4 1/8'), [[0, 0.5, 60, 0.5], [0.5, 0.25, 62, 0.6]]);
// a line repeated over a range, every bar or every period
assert.deepEqual(notes('@2-4 0.1 C2').map((n) => n[0]), [4.5, 6.5, 8.5]);
assert.deepEqual(notes('@0-3/2 1.0 C2').map((n) => n[0]), [2, 6]);
// a drum row: its steps' velocities (X 1, x the velocity set, o .4, digits tenths), over the bars of its range, offset
assert.deepEqual(notes('@2-3 kick 36 x...X...|o...5...'), [
  [4, 0.125, 36, 0.8], [4.5, 0.125, 36, 1], [5, 0.125, 36, 0.4], [5.5, 0.125, 36, 0.5],
  [6, 0.125, 36, 0.8], [6.5, 0.125, 36, 1], [7, 0.125, 36, 0.4], [7.5, 0.125, 36, 0.5],
]);
assert.deepEqual(notes('hat F#2 .x.x +4ms').map((n) => n[0]), [0.129, 0.379]);
// a row longer than a bar spans its bars; swung
assert.deepEqual(notes('swing 58%\n@0-1 C1 x.......x.......x.......x.......').map((n) => n[0]), [0, 1, 2, 3]);
assert.deepEqual(notes('swing 58%\nC1 .x').map((n) => n[0]), [0.145]);
// the bars it covers
assert.deepEqual(parse('@8-15 kick 36 x...\n3.2 C4', grid).bars, [3, 15]);
// a tempo map: bars on across its parts (here 60 bpm from bar 4, at 8 s)
assert.deepEqual(notes('5.0 C4 1/4', { map: [{ t: 0, bpm: 120, offset: 0, beatsPerBar: 4, bar: 0 }, { t: 8, bpm: 60, offset: 8, beatsPerBar: 4, bar: 4 }] }), [[12, 1, 60, 0.8]]);
// comments; a sharp is not one
assert.deepEqual(notes('# the bass\n0.0 F#1 1/4  # the root'), [[0, 0.5, 30, 0.8]]);

// what is wrong is said, with its line
for (const [text, says] of [['0.0 C4\n0.1 H4', /line 2 .*"H4"/], ['C4 0.0', /line 1 .*position/], ['0.0 C4 .8 1/4', /velocity comes last/], ['swing 90%', /under 75%/], ['@5-2 0.0 C4', /later one/], ['kick x...', /names its note/]]) {
  assert.throws(() => parse(text, grid), (e) => e instanceof NotationError && says.test(e.message), text);
}

// written out: chords as one line, swing found, lengths musical where they are, ms where not, a drum row
const part = [
  { t: 0, dur: 1, note: 29, vel: 0.9 },
  { t: 1, dur: 0.5, note: 56, vel: 0.6 }, { t: 1, dur: 0.5, note: 60, vel: 0.6 }, { t: 1, dur: 0.5, note: 63, vel: 0.55 },
  { t: 1.7, dur: 0.3, note: 72, vel: 0.8 },
];
assert.equal(write(part, grid).replace(/ +/g, ' '), '0.0 F1 1/2 .9\n0.2 G#3:.6 C4:.6 D#4:.55 1/4\n0.3.2-50ms C5 300ms .8');
// (sixteenths, the off-beat ones 0.02 s late: on a 0.125 s sixteenth, swing 58%)
const hats = [...Array(16)].map((_, k) => ({ t: k * 0.125 + (k % 2 ? 0.02 : 0), dur: 0.125, note: 42, vel: k % 2 ? 0.4 : 1 }));
assert.equal(write(hats, grid, { tab: true }), 'swing 58%\n@0 F#2 XoXo|XoXo|XoXo|XoXo');
// and read back as it was
for (const [ns, opts] of [[part, {}], [hats, { tab: true }]]) {
  const back = parse(write(ns, grid, opts), grid).notes, want = [...ns].sort((a, b) => a.t - b.t || a.note - b.note);
  assert.equal(back.length, want.length);
  back.forEach((n, i) => { assert.ok(Math.abs(n.t - want[i].t) < 5e-4 && Math.abs(n.dur - want[i].dur) < 5e-4 && n.note === want[i].note && Math.abs(n.vel - want[i].vel) < 1e-3, JSON.stringify([n, want[i]])); });
}

console.log('notation: ok');
