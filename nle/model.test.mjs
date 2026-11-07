// The grid the music makes (detectedGrid), read the way the film and the ruler read it: node nle/model.test.mjs
import assert from 'node:assert/strict';
import { detectedGrid } from './model.js';
import { timeOf } from '../engine/grid.js';

const near = (got, want, what) => assert.ok(Math.abs(got - want) < 1e-3, `${what}: ${got}, wanted ${want}`);
const doc = (clip, grid = { auto: true, bpm: 120, offset: 0, beatsPerBar: 4 }) => ({ grid, tracks: [{ id: 'a1', clips: [{ id: 'c1', media: 'song', gain: 0, ...clip }] }] });
const steady = { bpm: 120, beatsPerBar: 4, map: [{ t: 0, bpm: 120, offset: 0.5, beatsPerBar: 4 }] };

// the bars land where the song's bar lines play: wherever the clip is placed, trimmed and sped up
{
  const g = detectedGrid(doc({ at: 10, in: 20.25, out: 60 }), { song: steady });
  near(timeOf(g, 0), 0.25, 'bar 0'); near(timeOf(g, 1), 2.25, 'bar 1');
  const fast = detectedGrid(doc({ at: 10, in: 20.25, out: 60, speed: 1.25 }), { song: steady });
  near(timeOf(fast, 0), 0.6, 'bar 0 at 1.25×'); near(timeOf(fast, 1), 2.2, 'bar 1 at 1.25×');
}

// a song whose tempo changes changes the grid where that plays
{
  const song = { bpm: 120, beatsPerBar: 4, map: [{ t: 0, bpm: 120, offset: 0, beatsPerBar: 4 }, { t: 60, bpm: 90, offset: 60, beatsPerBar: 4 }] };
  const g = detectedGrid(doc({ at: 5, in: 30.3, out: 100 }), { song });
  near(timeOf(g, 1) - timeOf(g, 0), 2, 'a bar before the change');
  near(timeOf(g, 17), 34.7, 'the first bar of the new tempo');
  near(timeOf(g, 18) - timeOf(g, 17), 8 / 3, 'a bar after it');
}

// a tempo set by hand on the clip is the grid, in place of the one heard
{
  const g = detectedGrid(doc({ at: 4, in: 10, out: 40, tempo: { bpm: 100, offset: 10.3, beatsPerBar: 3 } }), { song: steady });
  near(timeOf(g, 0), 0.7, 'bar 0'); near(timeOf(g, 1) - timeOf(g, 0), 1.8, 'a bar of three beats at 100 bpm');
}

// a sound with no steady beat leaves the grid as it is
assert.equal(detectedGrid(doc({ at: 0, in: 0, out: 30 }), { song: { bpm: null } }), null);

console.log('model: ok');
