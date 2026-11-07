// The metronome's clicks against the grid: node nle/metronome.test.mjs
import assert from 'node:assert/strict';
import { createMetronome } from './metronome.js';

const SR = 48000;
// plays a grid from timeline sample `from` for `len` samples, cut into blocks of the given sizes (repeating) → the left channel
function play(grid, { from = 0, len = 5 * SR, blocks = [128] } = {}) {
  const m = createMetronome({ sr: SR }), L = new Float32Array(len), R = new Float32Array(len);
  m.set({ grid, on: true });
  m.seek();
  for (let k = 0, b = 0; k < len; b++) {
    const n = Math.min(blocks[b % blocks.length], len - k);
    m.process(L.subarray(k), R.subarray(k), n, from + k);
    k += n;
  }
  return L;
}
// where each click starts (after 10 ms of silence; its first sample may be its tone's zero) and how loud it peaks
function clicks(out, from = 0) {
  const found = [];
  for (let i = 0, quiet = Infinity; i < out.length; i++) {
    if (out[i] === 0) { quiet++; continue; }
    if (quiet >= 480) found.push({ s: from + i, peak: 0 });
    quiet = 0;
    found.at(-1).peak = Math.max(found.at(-1).peak, Math.abs(out[i]));
  }
  return found;
}
const near = (got, want) => assert.ok(want.length === got.length && got.every((c, k) => c.s - want[k] >= 0 && c.s - want[k] <= 1), `clicks at ${got.map((c) => c.s)}, wanted ${want}`);

// a beat on every beat of one tempo (120 bpm, bar 0 at 0.25 s), the bar's first beat louder
{
  const got = clicks(play({ bpm: 120, offset: 0.25, beatsPerBar: 4 }, { len: 3 * SR }));
  near(got, [12000, 36000, 60000, 84000, 108000, 132000]);
  assert.ok(got[0].peak > got[1].peak * 1.3 && got[4].peak > got[3].peak * 1.3, 'bar lines click louder');
  assert.ok(Math.abs(got[1].peak - got[2].peak) < 1e-6, 'other beats alike');
}

// a tempo map: the second song's tempo (90 bpm, its bar line at 3 s) from where its part starts
{
  const grid = { auto: true, bpm: 120, offset: 0, beatsPerBar: 4, map: [{ t: 0, bpm: 120, offset: 0, beatsPerBar: 4, bar: 0 }, { t: 3, bpm: 90, offset: 3, beatsPerBar: 3, bar: 2 }] };
  const got = clicks(play(grid, { len: 5.1 * SR }));
  near(got, [0, 24000, 48000, 72000, 96000, 120000, 144000, 176000, 208000, 240000]);
  assert.ok(got[6].peak > got[7].peak * 1.3 && got[9].peak > got[8].peak * 1.3, "the new part's bars (3 beats) click louder");
}

// cut into any blocks (a worklet's 128, a first block started part-way), from anywhere: the same clicks, sample for sample
{
  const grid = { bpm: 133, offset: 0.1, beatsPerBar: 4 };
  const whole = play(grid, { from: 31337, blocks: [4096] }), cut = play(grid, { from: 31337, blocks: [37, 128, 1, 128, 500] });
  assert.deepEqual(cut, whole);
  near(clicks(whole, 31337).slice(0, 3), [48108, 69762, 91417]);
}

// off: silent
{
  const m = createMetronome({ sr: SR }), L = new Float32Array(SR), R = new Float32Array(SR);
  m.set({ grid: { bpm: 120 }, on: false });
  m.process(L, R, SR, 0);
  assert.ok(L.every((v) => v === 0));
}

console.log('metronome tests passed');
