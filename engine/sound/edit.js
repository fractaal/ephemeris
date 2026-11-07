// Sound editing for the sound engine: cutting, reversing, fading, levelling, panning, resampling, time-stretching and
// pitch-shifting, looping and joining, and grains (a recording as a texture). Every function returns a new sound and
// leaves its input alone. Times are seconds.
//
//   reverse, trim, fade, gain, normalize, loudness, pan, width, mono,
//   resample, pitch, stretch, pitchShift, loop, stutter, swell, concat, crossfade, granular, freeze
import { db, TAU, length, duration, peak, resize, rng, param } from './core.js';
import { fft, reverb, track, PARAMS as FX, withDefaults } from './effects.js';

const P = (value, min, max, extra = {}) => ({ value, min, max, ...extra });
const FIRST = { positional: true }; // the option is the function's own argument after the sound, not a key of the options object
const MODES = { method: { value: 'auto', options: ['auto', 'vocoder', 'wsola'] }, window: P(0, 0, 8192, { step: 256 }) }; // window 0: the method's own
/** Every edit's options like effects.js's PARAMS (`positional: true` marks an argument that follows the sound directly). */
export const PARAMS = {
  reverse: {}, mono: {},
  trim: { t0: P(0, 0, 600, { step: 0.01, unit: 's', ...FIRST }), t1: P(10, 0, 600, { step: 0.01, unit: 's', ...FIRST }) }, // t1 defaults to the end
  fade: { in: P(0, 0, 10, { step: 0.01, unit: 's' }), out: P(0, 0, 10, { step: 0.01, unit: 's' }), curve: { value: 'sine', options: ['linear', 'sine', 'smooth', 'exp', 'log'] } },
  gain: { gain: P(1, 0, 4, { step: 0.01, unit: 'x', ...FIRST }) },
  normalize: { peak: P(-1, -24, 0, { step: 0.1, unit: 'dB' }), lufs: P(-16, -40, -5, { step: 0.1, unit: 'dB' }) }, // give one: lufs wins
  pan: { pan: P(0, -1, 1, { step: 0.01, ...FIRST }) },
  width: { width: P(1, 0, 2, { step: 0.01, ...FIRST }) },
  resample: { ratio: P(1, 0.25, 4, { step: 0.01, unit: 'x', curve: 'log', ...FIRST }) },
  pitch: { semitones: P(0, -24, 24, { step: 0.01, unit: 'st', ...FIRST }) },
  stretch: { factor: P(1, 0.25, 4, { step: 0.01, unit: 'x', curve: 'log', ...FIRST }), ...MODES },
  pitchShift: { semitones: P(0, -24, 24, { step: 0.01, unit: 'st', ...FIRST }), ...MODES },
  loop: { seconds: P(4, 0.1, 600, { step: 0.1, unit: 's', ...FIRST }), xfade: P(0, 0, 2, { step: 0.001, unit: 's' }) },
  stutter: {
    at: P(0, 0, 60, { step: 0.01, unit: 's' }), slice: P(0.125, 0.01, 2, { step: 0.005, unit: 's', curve: 'log' }), repeats: P(4, 1, 32, { step: 1 }),
    decay: P(1, 0.2, 1.2, { step: 0.01 }), insert: { value: false, options: [true, false] },
  },
  swell: { ...FX.reverb, size: P(12, 1, 100, { step: 0.5, unit: 'm', curve: 'log' }), decay: P(2.5, 0.1, 15, { step: 0.05, unit: 's', curve: 'log' }),
    mix: P(0.8, 0, 1, { step: 0.01, unit: '%' }), lead: P(0, 0, 10, { step: 0.05, unit: 's' }) }, // lead 0: all of the build-up
  concat: { gap: P(0, -2, 5, { step: 0.01, unit: 's' }) },
  crossfade: { seconds: P(0.1, 0.001, 10, { step: 0.001, unit: 's', curve: 'log', ...FIRST }), curve: { value: 'sine', options: ['linear', 'sine', 'smooth', 'exp', 'log'] } },
  granular: { dur: P(5, 0.1, 60, { unit: 's' }), grain: P(0.08, 0.005, 1, { unit: 's', curve: 'log' }), density: P(25, 1, 200, { unit: '/s', curve: 'log' }),
    position: P(0.5, 0, 1), spread: P(0.05, 0, 1), pitch: P(0, -24, 24, { unit: 'st' }), pitchSpread: P(0, 0, 12, { unit: 'st' }),
    pan: P(0.5, 0, 1), window: { value: 'hann', options: ['hann', 'tri', 'gauss', 'tukey', 'perc'] }, jitter: P(0.6, 0, 1), reverse: P(0, 0, 1),
    gain: P(1, 0, 4), seed: P(1, 1, 999, { step: 1 }) },
  freeze: { at: P(0.3, 0, 1), dur: P(5, 0.1, 60, { unit: 's' }), grain: P(0.15, 0.005, 1, { unit: 's', curve: 'log' }), density: P(30, 1, 200, { unit: '/s', curve: 'log' }),
    spread: P(0.01, 0, 1) }, // and granular's other options
};

const mapChannels = (s, f) => ({ sr: s.sr, ch: s.ch.map((c, i) => f(c, i)) });
const copy = (s) => mapChannels(s, (c) => Float32Array.from(c));
const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

// ---------- cutting and levels ----------

/** The sound backwards. */
export function reverse(s) { return mapChannels(s, (c) => Float32Array.from(c).reverse()); }

/** The part between t0 and t1 seconds (t1 defaults to the end; times outside the sound are cut to it). */
export function trim(s, t0 = 0, t1 = duration(s)) {
  const a = Math.max(0, Math.round(t0 * s.sr)), b = Math.min(length(s), Math.round(t1 * s.sr));
  return mapChannels(s, (c) => Float32Array.from(c.subarray(a, Math.max(a, b))));
}

const FADES = {
  linear: (x) => x,
  sine: (x) => Math.sin(x * Math.PI / 2), // equal power: for crossfades of unrelated sounds
  smooth: (x) => x * x * (3 - 2 * x),
  exp: (x) => x * x * x, // starts slowly, as a natural decay ends
  log: (x) => 1 - (1 - x) ** 3,
};
/** Fades in over `in` seconds and out over `out` seconds (the end of the sound), shaped by curve: 'linear' | 'sine' | 'smooth' | 'exp' | 'log'. */
export function fade(s, o = {}) {
  const { in: fin, out: fout, curve } = withDefaults(PARAMS.fade, o), f = FADES[curve];
  if (!f) throw new Error(`fade: unknown curve ${curve}`);
  const n = length(s), a = Math.min(n, Math.round(fin * s.sr)), b = Math.min(n, Math.round(fout * s.sr));
  return mapChannels(s, (c) => {
    const o = Float32Array.from(c);
    for (let i = 0; i < a; i++) o[i] *= f(i / a);
    for (let i = 0; i < b; i++) o[n - 1 - i] *= f(i / b);
    return o;
  });
}

/** × g (linear; a number or a function of time in seconds). For decibels: gain(s, db(−6)). */
export function gain(s, g) {
  const k = track(g, length(s), s.sr);
  return mapChannels(s, (c) => { const o = new Float32Array(c.length); for (let i = 0; i < o.length; i++) o[i] = c[i] * k[i]; return o; });
}

/** Two biquads over x, in place (direct form II transposed), coefficients already divided by a0. */
function biquad(x, [b0, b1, b2, a1, a2]) {
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i], y = b0 * v + z1; z1 = b1 * v - a1 * y + z2; z2 = b2 * v - a2 * y; x[i] = y; }
}
// BS.1770 K-weighting: a high shelf (+4 dB above ~1.7 kHz, the head) and a 38 Hz high-pass
function kWeights(sr) {
  const shelf = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196, K = Math.tan(Math.PI * f0 / sr);
    const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416, a0 = 1 + K / Q + K * K;
    return [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  })();
  const hp = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773, K = Math.tan(Math.PI * f0 / sr), a0 = 1 + K / Q + K * K;
    return [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  })();
  return [shelf, hp];
}
/** Integrated loudness in LUFS (BS.1770 K-weighting, 400 ms blocks, absolute −70 and relative −10 LU gates); −Infinity for silence. */
export function loudness(s) {
  const [shelf, hp] = kWeights(s.sr), w = s.ch.map((c) => { const o = Float32Array.from(c); biquad(o, shelf); biquad(o, hp); return o; });
  const blk = Math.round(0.4 * s.sr), hop = Math.round(0.1 * s.sr), n = length(s), energies = [];
  const sq = w.map((c) => { const p = new Float64Array(n + 1); for (let i = 0; i < n; i++) p[i + 1] = p[i] + c[i] * c[i]; return p; });
  for (let a = 0; a + blk <= n; a += hop) energies.push(sq.reduce((t, p) => t + (p[a + blk] - p[a]) / blk, 0));
  if (!energies.length) energies.push(sq.reduce((t, p) => t + p[n] / Math.max(n, 1), 0));
  const lk = (z) => -0.691 + 10 * Math.log10(z);
  const above = energies.filter((z) => lk(z) > -70);
  if (!above.length) return -Infinity;
  const rel = lk(above.reduce((a, b) => a + b, 0) / above.length) - 10, gated = above.filter((z) => lk(z) > rel);
  return gated.length ? lk(gated.reduce((a, b) => a + b, 0) / gated.length) : -Infinity;
}
/** Scales the whole sound to a target: { peak: dB (−1) } for the sample peak, or { lufs: dB } for integrated loudness. */
export function normalize(s, o = {}) {
  if (o.lufs === undefined && o.peak === undefined) o = withDefaults({ peak: PARAMS.normalize.peak });
  let g;
  if (o.lufs !== undefined) { const l = loudness(s); g = Number.isFinite(l) ? db(o.lufs - l) : 1; }
  else { const p = peak(s); g = p > 0 ? db(o.peak) / p : 1; }
  return mapChannels(s, (c) => { const r = new Float32Array(c.length); for (let i = 0; i < r.length; i++) r[i] = c[i] * g; return r; });
}

/** Balance, −1 (left) … 1 (right), equal power (centre leaves the sound as it is); a number or a function of time. */
export function pan(s, p) {
  const k = track(p, length(s), s.sr), [L, R] = s.ch, l = new Float32Array(L.length), r = new Float32Array(L.length);
  for (let i = 0; i < l.length; i++) {
    const x = Math.max(-1, Math.min(1, k[i]));
    l[i] = L[i] * Math.cos((x + 1) * Math.PI / 4) * Math.SQRT2; r[i] = R[i] * Math.sin((x + 1) * Math.PI / 4) * Math.SQRT2;
  }
  return { sr: s.sr, ch: [l, r] };
}
/** Stereo width by mid/side: 0 is mono, 1 unchanged, 2 twice as wide (a number or a function of time). */
export function width(s, w) {
  const k = track(w, length(s), s.sr), [L, R] = s.ch, l = new Float32Array(L.length), r = new Float32Array(L.length);
  for (let i = 0; i < l.length; i++) {
    const m = (L[i] + R[i]) * 0.5, d = (L[i] - R[i]) * 0.5 * k[i];
    l[i] = m + d; r[i] = m - d;
  }
  return { sr: s.sr, ch: [l, r] };
}
/** Both sides the mean of left and right. */
export function mono(s) { return width(s, 0); }

// ---------- resampling, stretching, pitch ----------

const HALF = 14, OVS = 512;
const KERNEL = (() => { // sinc × Kaiser, tabulated from 0 to HALF zero crossings
  const t = new Float64Array(HALF * OVS + 2), beta = 9;
  const i0 = (x) => { let sum = 1, term = 1; for (let k = 1; k < 30; k++) { term *= (x / (2 * k)) ** 2; sum += term; } return sum; };
  const norm = i0(beta);
  for (let j = 0; j < t.length; j++) {
    const x = j / OVS, w = x < HALF ? i0(beta * Math.sqrt(1 - (x / HALF) ** 2)) / norm : 0;
    t[j] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w;
  }
  return t;
})();
/**
 * Plays the sound back `ratio` times faster: 2 is an octave up and half as long (pitch and speed together, like a
 * sampler). Windowed-sinc interpolation, low-passed below the new Nyquist when speeding up so nothing aliases.
 */
export function resample(s, ratio) {
  if (ratio === 1) return copy(s);
  const n = length(s), m = Math.max(0, Math.floor(n / ratio)), cut = Math.min(1, 0.97 / ratio), R = HALF / cut;
  return mapChannels(s, (x) => {
    const out = new Float32Array(m);
    for (let j = 0; j < m; j++) {
      const pos = j * ratio, k0 = Math.max(0, Math.ceil(pos - R)), k1 = Math.min(n - 1, Math.floor(pos + R));
      let acc = 0;
      for (let k = k0; k <= k1; k++) {
        const d = Math.abs(k - pos) * cut * OVS, i = d | 0, f = d - i;
        acc += x[k] * (KERNEL[i] + (KERNEL[i + 1] - KERNEL[i]) * f);
      }
      out[j] = acc * cut;
    }
    return out;
  });
}
/** Pitch by resampling: `semitones` up (negative: down); the sound gets shorter or longer by the same ratio. */
export function pitch(s, semitones) { return resample(s, 2 ** (semitones / 12)); }

const hann = (N) => Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(TAU * i / N));
const wrap = (x) => x - TAU * Math.round(x / TAU);

/** Which frames start a new transient: where the spectrum grows suddenly (flux well above its recent mean). */
function onsets(mono, N, positions) {
  const win = hann(N), re = new Float64Array(N), im = new Float64Array(N), K = N / 2, prev = new Float64Array(K), flux = new Float64Array(positions.length);
  positions.forEach((p, f) => {
    for (let i = 0; i < N; i++) { const k = p - N / 2 + i; re[i] = k >= 0 && k < mono.length ? mono[k] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    let sum = 0;
    for (let k = 1; k < K; k++) { const m = Math.log1p(100 * Math.hypot(re[k], im[k]) / N); sum += Math.max(0, m - prev[k]); prev[k] = m; }
    flux[f] = f ? sum : 0;
  });
  const flag = new Uint8Array(positions.length);
  for (let f = 2; f < flux.length - 1; f++) {
    let mean = 0; const a = Math.max(0, f - 10);
    for (let j = a; j < f; j++) mean += flux[j];
    mean /= f - a;
    if (flux[f] > 2.2 * mean + 6 && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1]) flag[f] = 1;
  }
  return flag;
}

/** Phase vocoder with identity phase locking (Laroche & Dolson) and phase resets at transients. */
function vocoder(x, factor, N, positions, reset, Hs) {
  const win = hann(N), K = N / 2, outLen = Math.round(x.length * factor), out = new Float32Array(outLen + N), norm = new Float32Array(outLen + N);
  const re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(K + 1), ph = new Float64Array(K + 1);
  const prevPh = new Float64Array(K + 1), synPh = new Float64Array(K + 1), peaks = new Int32Array(K + 1), owner = new Int32Array(K + 1);
  positions.forEach((p, f) => {
    for (let i = 0; i < N; i++) { const k = p - N / 2 + i; re[i] = k >= 0 && k < x.length ? x[k] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= K; k++) { mag[k] = Math.hypot(re[k], im[k]); ph[k] = Math.atan2(im[k], re[k]); }
    if (f === 0 || reset[f]) synPh.set(ph);
    else {
      const Ha = p - positions[f - 1];
      let np = 0;
      for (let k = 0; k <= K; k++) {
        const m = mag[k];
        if (m > (mag[k - 1] ?? 0) && m >= (mag[k + 1] ?? 0) && m > (mag[k - 2] ?? 0) && m >= (mag[k + 2] ?? 0)) peaks[np++] = k;
      }
      if (np === 0) peaks[np++] = 0;
      for (let q = 0, k = 0; k <= K; k++) { while (q + 1 < np && k - peaks[q] > peaks[q + 1] - k) q++; owner[k] = peaks[q]; }
      for (let q = 0; q < np; q++) {
        const k = peaks[q], w = TAU * k / N, dev = wrap(ph[k] - prevPh[k] - w * Ha), inst = w + dev / Ha;
        synPh[k] = synPh[k] + inst * Hs;
      }
      const old = Float64Array.from(synPh);
      for (let k = 0; k <= K; k++) { const o = owner[k]; if (o !== k) synPh[k] = old[o] + ph[k] - ph[o]; }
    }
    prevPh.set(ph);
    for (let k = 0; k <= K; k++) {
      re[k] = mag[k] * Math.cos(synPh[k]); im[k] = mag[k] * Math.sin(synPh[k]);
      if (k > 0 && k < K) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    im[0] = 0; im[K] = 0;
    fft(re, im, true);
    const at = f * Hs - N / 2;
    for (let i = 0; i < N; i++) { const o = at + i; if (o >= 0 && o < out.length) { out[o] += re[i] * win[i]; norm[o] += win[i] * win[i]; } }
  });
  const res = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) res[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
  return res;
}

/** Waveform-similarity overlap-add on the mono mix; returns where each output frame's segment starts in the input. */
function wsolaStarts(mono, factor, N, count) {
  const Hs = N >> 1, delta = N >> 2, starts = new Int32Array(count), step = 4, half = Hs;
  for (let m = 1; m < count; m++) {
    const nominal = Math.round(m * Hs / factor), ref = starts[m - 1] + Hs; // the natural continuation of the last segment
    let best = nominal, bestScore = -Infinity;
    const score = (c) => {
      let xy = 0, yy = 1e-9, xx = 1e-9;
      for (let i = 0; i < half; i += step) {
        const a = mono[ref + i] ?? 0, b = mono[c + i] ?? 0;
        xy += a * b; yy += b * b; xx += a * a;
      }
      return xy / Math.sqrt(xx * yy);
    };
    for (let c = nominal - delta; c <= nominal + delta; c += step) if (c >= 0) { const sc = score(c); if (sc > bestScore) { bestScore = sc; best = c; } }
    for (let c = best - step + 1; c < best + step; c++) if (c >= 0) { const sc = score(c); if (sc > bestScore) { bestScore = sc; best = c; } }
    starts[m] = best;
  }
  return starts;
}

/**
 * Time-stretches without changing pitch: factor 2 is twice as long. o:
 *   method  'auto' (default: wsola for rhythmic sounds, with a transient every ~0.7 s or oftener, else the vocoder),
 *           'vocoder' (a phase vocoder with identity phase locking and phase resets at transients: smooth
 *           on sustained and tonal sounds, a little soft on drums) or 'wsola' (waveform-similarity overlap-add: keeps
 *           drum hits crisp, but warbles on tones and chords at large factors; best for factors 0.7–1.5)
 *   window  frame size in samples (vocoder 2048, wsola 1536; smaller keeps transients, larger is smoother on low notes)
 */
export function stretch(s, factor, o = {}) {
  if (factor === 1) return copy(s);
  const n = length(s), mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (s.ch[0][i] + s.ch[1][i]) * 0.5;
  o = withDefaults(PARAMS.stretch, o);
  let method = o.method;
  if (method === 'auto') { // a rhythmic sound (hits every second or so) wants crisp attacks, anything else wants smooth
    const pos = Int32Array.from({ length: Math.ceil(n / 512) }, (_, f) => f * 512);
    method = onsets(mono, 1024, pos).reduce((a, b) => a + b, 0) / (n / s.sr) >= 1.5 ? 'wsola' : 'vocoder';
  }
  if (method === 'wsola') {
    const N = (o.window || 1536) & ~1, Hs = N >> 1, outLen = Math.round(n * factor);
    const count = Math.ceil(outLen / Hs) + 1, starts = wsolaStarts(mono, factor, N, count), win = hann(N);
    return mapChannels(s, (x) => {
      const out = new Float32Array(count * Hs + N);
      for (let m = 0; m < count; m++) {
        const a = starts[m], o0 = m * Hs;
        for (let i = 0; i < N; i++) { const v = x[a + i]; if (v !== undefined) out[o0 + i] += v * win[i]; }
      }
      return out.slice(Hs >> 1, (Hs >> 1) + outLen);
    });
  }
  const N = nextPow2(o.window || 2048), Hs = N >> 2, outLen = Math.round(n * factor), count = Math.ceil(outLen / Hs) + 1;
  const positions = Int32Array.from({ length: count }, (_, f) => Math.round(f * Hs / factor));
  const reset = onsets(mono, Math.min(N, 1024), positions);
  return mapChannels(s, (x) => vocoder(x, factor, N, positions, reset, Hs));
}

/** Pitch shift keeping the length: `semitones` up or down (a stretch, then a resample). Takes stretch's options. */
export function pitchShift(s, semitones, o = {}) {
  const r = 2 ** (semitones / 12), long = stretch(s, r, o), out = resample(long, r), n = length(s);
  return resize(out, n / s.sr);
}

// ---------- looping, joining ----------

/** Repeats the sound until it is `seconds` long (cut to it), the seams crossfaded by `xfade` seconds when given. */
export function loop(s, seconds, o = {}) {
  const { xfade } = withDefaults(PARAMS.loop, o);
  const n = length(s), total = Math.round(seconds * s.sr), x = Math.min(Math.round(xfade * s.sr), n >> 1), period = Math.max(1, n - x);
  return mapChannels(s, (c) => {
    const out = new Float32Array(total);
    for (let at = 0, rep = 0; at < total; at += period, rep++) {
      const more = at + period < total; // a next repeat will come in under this one's tail
      for (let i = 0; i < n && at + i < total; i++) {
        let g = 1;
        if (rep > 0 && i < x) g = Math.sin((i / x) * Math.PI / 2);
        else if (more && i >= n - x) g = Math.cos(((i - (n - x)) / x) * Math.PI / 2);
        out[at + i] += c[i] * g;
      }
    }
    return out;
  });
}

/**
 * Stutter: from `at` seconds the slice [at, at + slice] is repeated `repeats` times over the original (the sound keeps its
 * length; `insert: true` makes room instead), each repeat `decay` times the last, edges faded by 2 ms against clicks.
 */
export function stutter(s, o = {}) {
  const { at, slice, repeats, decay, insert } = withDefaults(PARAMS.stutter, o);
  const sr = s.sr, a = Math.round(at * sr), L = Math.max(1, Math.round(slice * sr)), n = length(s), edge = Math.min(L >> 1, Math.round(0.002 * sr));
  const total = insert ? n + L * (repeats - 1) : n;
  return mapChannels(s, (c) => {
    const out = new Float32Array(total);
    out.set(c.subarray(0, Math.min(a, total)));
    for (let r = 0; r < repeats; r++) {
      const g = decay ** r;
      for (let i = 0; i < L; i++) {
        const o = a + r * L + i;
        if (o >= total) break;
        const e = Math.min(1, i / edge, (L - 1 - i) / edge);
        out[o] = (c[a + i] ?? 0) * g * (e < 1 && r > 0 ? e : 1);
      }
    }
    const from = a + repeats * L, src = insert ? a + L : from;
    for (let i = 0; from + i < total && src + i < n; i++) out[from + i] = c[src + i];
    return out;
  });
}

/**
 * A swell: the sound preceded by its own rising tail. The sound is reversed, put through a reverb, and reversed back, so
 * the reverb's tail builds up into the start of the sound. o: the reverb's options ({ size, decay, ir, … }), mix (0.8),
 * and `lead`: seconds of build-up to keep (all of it by default). The result is that much longer than the sound.
 */
export function swell(s, o = {}) {
  const { lead, ...rv } = withDefaults(PARAMS.swell, o), wet = reverse(reverb(reverse(s), rv));
  return !lead ? wet : trim(wet, Math.max(0, duration(wet) - duration(s) - lead));
}

/** The sounds one after another, `gap` seconds apart (a negative gap overlaps them, plain). */
export function concat(sounds, o = {}) {
  const { gap } = withDefaults(PARAMS.concat, o);
  const sr = sounds[0].sr, g = Math.round(gap * sr), total = sounds.reduce((t, x, i) => t + length(x) + (i ? g : 0), 0);
  const out = { sr, ch: [new Float32Array(Math.max(0, total)), new Float32Array(Math.max(0, total))] };
  let at = 0;
  for (const x of sounds) {
    for (let c = 0; c < 2; c++) for (let i = 0; i < length(x) && at + i < out.ch[c].length; i++) if (at + i >= 0) out.ch[c][at + i] += x.ch[c][i];
    at += length(x) + g;
  }
  return out;
}

/** a joined to b with the last `seconds` of a overlapping the first of b (curve 'sine' is equal power, 'linear' equal gain). */
export function crossfade(a, b, seconds, curve = PARAMS.crossfade.curve.value) {
  const x = Math.min(Math.round(seconds * a.sr), length(a), length(b)), f = FADES[curve], na = length(a), total = na + length(b) - x;
  return {
    sr: a.sr,
    ch: [0, 1].map((c) => {
      const out = new Float32Array(total);
      out.set(a.ch[c]);
      for (let i = 0; i < x; i++) out[na - x + i] *= f(1 - i / x);
      for (let i = 0; i < length(b); i++) out[na - x + i] += b.ch[c][i] * (i < x ? f(i / x) : 1);
      return out;
    }),
  };
}

// ---------- grains ----------

const WINDOWS = { hann: (x) => 0.5 - 0.5 * Math.cos(TAU * x), tri: (x) => 1 - Math.abs(2 * x - 1),
  gauss: (x) => Math.exp(-18 * (x - 0.5) ** 2), tukey: (x) => Math.min(1, 5 * Math.min(x, 1 - x)),
  perc: (x) => Math.min(1, x * 40) * Math.exp(-4 * x) };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const panGains = (p) => { const a = (clamp(p, -1, 1) + 1) * Math.PI / 4; return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2]; };

/** A texture from a sound: grains of it, scattered. grain: seconds. density: grains per second. position: where in the
 *  input to read, 0–1 (a number or a function of time: move it to scan). spread: random position scatter (0–1 of the
 *  input). pitch: semitones (number or fn); pitchSpread: random ± semitones. pan: stereo scatter 0–1. window: hann tri
 *  gauss tukey perc. jitter 0–1: timing irregularity. reverse: share of grains played backwards. gain scales the result
 *  (kept equal across densities). */
export function granular(s, o = {}) {
  const { dur, grain, density, position, spread, pitch, pitchSpread, pan, window, jitter, reverse, gain, seed } = withDefaults(PARAMS.granular, o);
  const sr = s.sr, n = Math.ceil(dur * sr), out = { sr, ch: [new Float32Array(n), new Float32Array(n)] }, r = rng(seed * 7 + 1);
  const [iL, iR] = s.ch, N = iL.length, pos = param(position), pit = param(pitch), dn = param(density);
  const wf = WINDOWS[window] ?? WINDOWS.hann, W = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) W[i] = wf(i / 1023);
  const glen = Math.max(8, Math.round(grain * sr));
  let t = 0;
  while (t < dur) {
    const d = Math.max(0.5, dn(t)), at = Math.round((t + (r() - 0.5) * jitter / d) * sr);
    t += 1 / d;
    if (at < 0 || at >= n) continue;
    const st = pit(t) + pitchSpread * (r() * 2 - 1), rate = 2 ** (st / 12), rev = r() < reverse;
    const span = glen * rate;
    let p0 = (pos(t) + spread * (r() * 2 - 1)) * N - (rev ? span : 0);
    p0 = clamp(p0, 0, Math.max(0, N - span - 2));
    const [gl, gr] = panGains((r() * 2 - 1) * pan);
    const ov = Math.max(1, grain * d), k = gain * 1.4 / Math.sqrt(ov);
    const m = Math.min(glen, n - at), L = out.ch[0], R = out.ch[1];
    for (let i = 0; i < m; i++) {
      const x = p0 + (rev ? span - i * rate : i * rate), j = x | 0, f = x - j;
      if (j + 1 >= N) break;
      const w = W[(i / glen * 1023) | 0] * k;
      L[at + i] += (iL[j] + (iL[j + 1] - iL[j]) * f) * w * gl;
      R[at + i] += (iR[j] + (iR[j + 1] - iR[j]) * f) * w * gr;
    }
  }
  return out;
}

/** A moment of a sound held as long as you like: grains from around `at` (0–1 of the input). Takes granular's options. */
export function freeze(s, o = {}) {
  const { at, ...rest } = withDefaults(PARAMS.freeze, o);
  return granular(s, { ...rest, position: at });
}
