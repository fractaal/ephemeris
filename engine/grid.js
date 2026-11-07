// The film's musical grid, as a timeline holds it (its `grid`): one tempo for the whole film ({ bpm, offset,
// beatsPerBar }: the director's, typed in the studio) or, where the music sets it (Detected: nle/model.js, detectedGrid),
// each song's tempo map from where its clip starts: a part for each steady tempo in it (map: [{ t, bpm, offset,
// beatsPerBar, bar }]: each part's bar lines at offset + k bars, `bar` the number of its first bar line after t), the
// bars counted on across them. Bars and beats count from 0; bar 0 starts at the first part's offset. The film's
// tempo(TL.grid) and the studio's ruler, grid lines, snapping and bar.beat all read it here. No imports: the engine, the
// editor and the tools share it.

/** The grid's parts in time order: { t (from; the first from -Infinity), bpm, beat, bar (lengths in s), beatsPerBar,
 *  n (the number of its first bar line), line (that line's time) }. */
export function parts(grid = {}) {
  const raw = grid.map?.length ? grid.map : [{ bpm: grid.bpm ?? 120, offset: grid.offset ?? 0, beatsPerBar: grid.beatsPerBar ?? 4 }];
  return raw.map((p, i) => {
    const beat = 60 / p.bpm, beatsPerBar = p.beatsPerBar ?? 4, bar = beat * beatsPerBar, offset = p.offset ?? 0;
    return { t: i ? p.t : -Infinity, bpm: p.bpm, beat, bar, beatsPerBar, n: i ? p.bar : 0, line: i ? offset + Math.ceil((p.t - offset) / bar - 1e-6) * bar : offset };
  });
}
/** A map's parts ([{ t, bpm, offset, beatsPerBar }], in time order) numbered: each one's `bar`, the number of its first
 *  bar line after its t, the bars counted on from the part before it (the first's bar 0 at its offset). */
export function numbered(map) {
  const out = [];
  for (const p of map) {
    if (!out.length) { out.push({ ...p, bar: 0 }); continue; }
    const q = parts({ map: [...out, { ...p, bar: 0 }] }).at(-2);
    out.push({ ...p, bar: q.n + Math.floor((p.t - 1e-6 - q.line) / q.bar) + 1 });
  }
  return out;
}

/** The part time t falls in. */
export const partAt = (ps, t) => { let p = ps[0]; for (const q of ps) if (q.t <= t + 1e-9) p = q; return p; };

/** Where time t falls: { bar, beat } (beat with its fraction: 1.5 is halfway through the bar's second beat), part. */
export function position(grid, t) {
  const p = partAt(parts(grid), t), b = (t - p.line) / p.beat + 1e-6, k = Math.floor(b / p.beatsPerBar);
  return { bar: p.n + k, beat: Math.max(0, b - k * p.beatsPerBar - 1e-6), part: p };
}

/** When bar, beat and sixteenth (each from 0) fall. */
export function timeOf(grid, bar, beat = 0, six = 0) {
  const ps = parts(grid); let p = ps[0];
  for (const q of ps) if (q.n <= bar) p = q;
  return p.line + (bar - p.n) * p.bar + beat * p.beat + (six * p.beat) / 4;
}

/** The grid's lines from t0 to t1 (each part's up to the next part's start), every `per` of a beat (1: beats; 0.25:
 *  sixteenths; 'bar': bars): { t, bar, beat }, beat 0 a bar line. */
export function lines(grid, t0, t1, per = 1) {
  const ps = parts(grid), out = [];
  ps.forEach((p, i) => {
    const a = Math.max(t0, p.t), b = Math.min(t1, ps[i + 1]?.t ?? Infinity), k1 = per === 'bar' ? p.beatsPerBar : per, d = p.beat * k1;
    if (!(b > a)) return;
    for (let k = Math.ceil((a - p.line) / d - 1e-9); out.length < 20000; k++) {
      const t = p.line + k * d; if (t > b + 1e-9 || (i + 1 < ps.length && t >= b - 1e-9)) break;
      const beats = k * k1, bar = Math.floor(beats / p.beatsPerBar + 1e-9);
      out.push({ t, bar: p.n + bar, beat: beats - bar * p.beatsPerBar });
    }
  });
  return out;
}

/** The grid line nearest t, every `per` of a beat (or 'bar'). */
export function nearest(grid, t, per = 1) {
  const p = partAt(parts(grid), t), d = p.beat * (per === 'bar' ? p.beatsPerBar : per);
  return p.line + Math.round((t - p.line) / d) * d;
}
/** The grid line at or before t (the start of the cell t is in), every `per` of a beat (or 'bar'). */
export function floor(grid, t, per = 1) {
  const p = partAt(parts(grid), t), d = p.beat * (per === 'bar' ? p.beatsPerBar : per);
  return p.line + Math.floor((t - p.line) / d + 1e-6) * d;
}
