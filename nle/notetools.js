// The piano roll's tools, as pure functions on the notes they change ({ t, dur, note, vel, src }: t and dur in seconds,
// src the pattern a note is in). Each returns the changed notes in place of those it was given; the roll keeps the rest of
// each pattern as it was. No imports: tested in Node (notetools.test.mjs).

const EPS = 1e-3;   // (notes are kept to the millisecond: closer than this, two times are the same)
const groups = (notes, key) => { const m = new Map(); for (const n of notes) { const k = key(n); if (!m.has(k)) m.set(k, []); m.get(k).push(n); } return [...m.values()]; };

/** Each note's start moved to snap(t) (the nearest line of the grid); lengths kept. */
export const quantize = (notes, snap) => notes.map((n) => ({ ...n, t: snap(n.t) }));

/** Each note lasts until the next start after its own in its pattern, whatever its pitch (a chord's notes all reach the
 *  next chord); the notes that start last keep their lengths. */
export function legato(notes) {
  return groups(notes, (n) => n.src).flatMap((ns) => {
    const starts = [...new Set(ns.map((n) => n.t))].sort((a, b) => a - b);
    return ns.map((n) => { const next = starts.find((s) => s > n.t + EPS); return next == null ? n : { ...n, dur: next - n.t }; });
  });
}

/** Each note cut where cuts(n) says (times inside it: the grid's lines), each piece a note of its own. */
export function chop(notes, cuts) {
  return notes.flatMap((n) => {
    const end = n.t + n.dur, at = [n.t, ...cuts(n).filter((c) => c > n.t + EPS && c < end - EPS).sort((a, b) => a - b), end];
    return at.slice(1).map((b, i) => ({ ...n, t: at[i], dur: b - at[i] }));
  });
}

/** Notes of the same pitch in the same pattern that touch or overlap made one: from the first's start to the last end,
 *  at the first's velocity. */
export function glue(notes) {
  return groups(notes, (n) => `${n.src}\n${n.note}`).flatMap((ns) => {
    const out = [];
    for (const n of [...ns].sort((a, b) => a.t - b.t)) {
      const p = out.at(-1);
      if (p && n.t <= p.t + p.dur + EPS) p.dur = Math.max(p.dur, n.t + n.dur - p.t);
      else out.push({ ...n });
    }
    return out;
  });
}

/** How far after itself a run of notes `span` long repeats when duplicated: its length rounded up to whole bars when it
 *  lasts half a bar or more, to whole beats when it lasts half a beat or more, else to whole steps (lengths in seconds). */
export function repeatEvery(span, { step, beat, bar }) {
  const unit = span >= bar / 2 - EPS ? bar : span >= beat / 2 - EPS ? beat : step;
  return Math.max(1, Math.ceil(span / unit - EPS)) * unit;
}
