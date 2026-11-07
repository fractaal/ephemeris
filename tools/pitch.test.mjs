// The notes in a recording: node tools/pitch.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pitch } from './pitch.mjs';
import { writeWav } from './mix.mjs';

// a recording: A4, then a C major chord, then an E5 20 cents sharp — each a tone with its harmonics, as an instrument's
// (the model may hear a strong harmonic as a quiet note of its own: what it finds besides these is not asserted)
const sr = 44100, L = new Float32Array(sr * 3.4);
const tone = (from, to, hz) => { for (let i = Math.round(from * sr); i < to * sr; i++) { const t = i / sr - from, env = Math.min(1, t / 0.01, (to - from - t) / 0.02); for (let h = 1; h <= 6; h++) L[i] += (0.3 / (h * h)) * env * Math.sin(2 * Math.PI * hz * h * t); } };
tone(0.2, 0.8, 440); for (const n of [60, 64, 67]) tone(1.2, 2.0, 440 * 2 ** ((n - 69) / 12)); tone(2.4, 3.0, 440 * 2 ** ((76 + 0.2 - 69) / 12));
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-')), 'tones.wav');
await writeWav(L, L, sr, file);

const { notes } = await pitch(file), near = (n, t, dur) => Math.abs(n.t - t) < 0.03 && Math.abs(n.t + n.dur - (t + dur)) < 0.06;
const at = (note) => notes.filter((n) => n.note === note);
assert.ok(near(at(69)[0], 0.2, 0.6), 'A4 where it plays');
for (const n of [60, 64, 67]) assert.ok(near(at(n)[0], 1.2, 0.8) && !at(n)[0].alone && at(n)[0].cents == null, `the chord's ${n}: there, and not alone (no tuning said)`);
const e = at(76)[0];
assert.ok(near(e, 2.4, 0.6) && e.alone && Math.abs(e.cents - 20) <= 3 && e.wobble <= 3, `E5 alone, 20 cents sharp, held (${e.cents} ±${e.wobble})`);
assert.ok(Math.abs(at(69)[0].cents) <= 3, 'A4 in tune');
console.log('pitch: ok');
process.exit(0);
