// The metronome: a click on each beat of the timeline's grid as it plays (engine/grid.js: one tempo, or the music's, a
// part for each song from its clip on, as the ruler draws it), the first beat of each bar higher and louder. It is the
// editor's alone, as a DAW's is: the worklet (liveworklet.js) adds it after the master, so it is never in a render or on
// the meters. Each click starts at its beat's sample (the nearest one), however the sound is cut into blocks.
//
//   const click = createMetronome({ sr });
//   click.set({ grid, on, volume })   // any of them (volume in dB; 0: as made); a new grid is followed from the next block
//   click.seek()                      // played from elsewhere: what rang is cut, the beats looked up again
//   click.process(L, R, n, s, off)    // adds the clicks of timeline samples s…s+n−1 into L and R, from index off
import { lines } from '../engine/grid.js';
import { dbGain } from './model.js';

const AHEAD = 1;   // seconds of beats looked up at a time (the grid's lines made once a second, not each block)

// a click: a tone at f Hz with a brighter one over its start, gone within 60 ms, its peak at `peak`
function clickOf(sr, f, peak) {
  const n = Math.round(0.06 * sr), fade = Math.round(0.005 * sr), w = new Float32Array(n);
  let most = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    w[i] = (Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.012) + 0.3 * Math.sin(5 * Math.PI * f * t) * Math.exp(-t / 0.003)) * Math.min(1, (n - i) / fade);
    most = Math.max(most, Math.abs(w[i]));
  }
  for (let i = 0; i < n; i++) w[i] *= peak / most;
  return w;
}

export function createMetronome({ sr }) {
  const BAR = clickOf(sr, 1760, 0.5), BEAT = clickOf(sr, 1320, 0.32);
  let grid = {}, on = false, gain = 1, beats = [], i = 0, upto = 0, stale = true, ring = null, j = 0;
  // the beats of samples from…from+AHEAD, each at its nearest sample
  function lookUp(from) {
    const to = from + Math.round(AHEAD * sr);
    beats = lines(grid, from / sr, to / sr).map((l) => ({ s: Math.round(l.t * sr), bar: l.beat === 0 })).filter((b) => b.s >= from && b.s < to);
    i = 0; upto = to;
  }
  return {
    set(o) {
      if ('grid' in o) { grid = o.grid ?? {}; stale = true; }
      if ('on' in o) { on = !!o.on; stale = true; ring = null; }
      if ('volume' in o) gain = dbGain(o.volume);
    },
    seek() { stale = true; ring = null; },
    process(L, R, n, s, off = 0) {
      if (!on) return;
      if (stale) { lookUp(s); stale = false; }
      for (let k = 0; k < n;) {
        while (i >= beats.length && upto < s + n) lookUp(upto);
        while (i < beats.length && beats[i].s < s + k) i++;   // (passed: played from after them)
        const b = beats[i], next = b && b.s < s + n ? b.s - s : n;
        if (ring) {   // the click ringing, up to the next one (or the block's end)
          const m = Math.min(next - k, ring.length - j);
          for (let x = 0; x < m; x++) { const v = ring[j + x] * gain; L[off + k + x] += v; R[off + k + x] += v; }
          j += m;
          if (j >= ring.length) ring = null;
        }
        if (next < n) { ring = b.bar ? BAR : BEAT; j = 0; i++; }
        k = next;
      }
    },
  };
}
