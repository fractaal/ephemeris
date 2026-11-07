// The sound engine's common ground. A sound is stereo Float32Arrays at a sample rate ({ sr, ch: [L, R] }). Every module
// is a plain function of what it is given: noise comes from seeded generators, never Math.random, so a sound is a
// function of its description as a frame is of t, the same in the editor, in a render and on any machine. Nothing here
// touches files, the Web Audio API or Node: whoever calls loads samples (Node: tools/soundio.mjs; the editor: its own
// decoder) and passes them in.
//
// Conventions every module keeps:
//   - a source returns a new sound; an effect takes a sound and returns one (a new one, or the same one changed in
//     place, saying which); a tail (a reverb's, a delay's) makes the sound longer
//   - times are seconds, pitches MIDI note numbers (60 middle C, fractional for between), levels linear unless named dB
//   - a note is { t, dur, note, vel } (vel 0–1); an instrument is { render(notes, { sr, length? }) → sound }
//   - a param is a number or a function of time in seconds (param(p) makes either a function), so anything can move

export const SR = 48000;
export const TAU = Math.PI * 2;

/** A silent stereo sound `seconds` long. */
export function sound(seconds, sr = SR) {
  const n = Math.max(0, Math.ceil(seconds * sr));
  return { sr, ch: [new Float32Array(n), new Float32Array(n)] };
}
/** A sound from channels (mono is copied to both sides). */
export function fromChannels(ch, sr = SR) { return { sr, ch: [ch[0], ch[1] ?? Float32Array.from(ch[0])] }; }
export const length = (s) => s.ch[0].length;
export const duration = (s) => s.ch[0].length / s.sr;

export const db = (d) => 10 ** (d / 20);
export const toDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));
/** A MIDI note's frequency (A4 = 69 = 440 Hz). */
export const hz = (note) => 440 * 2 ** ((note - 69) / 12);
export const noteOf = (f) => 69 + 12 * Math.log2(f / 440);
/** A note name to its number: 'C4' 60, 'A#3' 58, 'Eb5' 75. */
export function midi(name) {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name);
  if (!m) throw new Error(`not a note name: ${name}`);
  return 12 * (+m[3] + 1) + { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

/** A seeded generator, 0 ≤ x < 1 (mulberry32): the same seed, the same sequence. */
export function rng(seed = 1) {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A param as a function of time (seconds): a number stays itself. */
export const param = (p) => (typeof p === 'function' ? p : () => p);
/** A curve through [t, value] points, straight between them (ease: 'lin', 'exp' for levels and pitches). */
export function curve(points, ease = 'lin') {
  const P = [...points].sort((a, b) => a[0] - b[0]);
  return (t) => {
    if (t <= P[0][0]) return P[0][1];
    for (let i = 1; i < P.length; i++) {
      if (t <= P[i][0]) {
        const [t0, v0] = P[i - 1], [t1, v1] = P[i], x = (t - t0) / Math.max(t1 - t0, 1e-9);
        return ease === 'exp' && v0 > 0 && v1 > 0 ? v0 * (v1 / v0) ** x : v0 + (v1 - v0) * x;
      }
    }
    return P[P.length - 1][1];
  };
}
/** An ADSR envelope's level at time t into a note that is released at `off` (seconds; a, d, r in seconds, s a level). */
export function adsr({ a = 0.005, d = 0.1, s = 1, r = 0.2 } = {}) {
  return (t, off = Infinity) => {
    const held = (u) => (u < a ? u / a : u < a + d ? 1 + (s - 1) * ((u - a) / d) : s);
    if (t < off) return held(t);
    const from = held(off), u = t - off;
    return u >= r ? 0 : from * (1 - u / r);
  };
}

/** Adds `src` into `dst` from `at` seconds, × gain (a number or a function of the time into src), panned (−1 left … 1 right, equal power). */
export function mixInto(dst, src, at = 0, gain = 1, pan = 0) {
  const g = param(gain), off = Math.round(at * dst.sr), n = Math.min(length(src), length(dst) - off);
  const p = Math.max(-1, Math.min(1, pan)), gl = Math.cos((p + 1) * Math.PI / 4) * Math.SQRT2, gr = Math.sin((p + 1) * Math.PI / 4) * Math.SQRT2;
  const [L, R] = dst.ch, [sl, sr] = src.ch, fixed = typeof gain === 'number';
  for (let i = Math.max(0, -off); i < n; i++) {
    const k = fixed ? gain : g(i / src.sr);
    L[i + off] += sl[i] * k * gl; R[i + off] += sr[i] * k * gr;
  }
  return dst;
}
/** The loudest sample's level (linear). */
export function peak(s) { let m = 0; for (const c of s.ch) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i])); return m; }
/** The same sound, `seconds` longer or cut to `seconds` (a tail's room). */
export function resize(s, seconds) {
  const n = Math.max(0, Math.ceil(seconds * s.sr));
  return { sr: s.sr, ch: s.ch.map((c) => { const o = new Float32Array(n); o.set(c.subarray(0, Math.min(n, c.length))); return o; }) };
}
