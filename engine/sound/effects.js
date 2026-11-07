// Effects for the sound engine: each takes a sound and returns a new one (the input is never changed); a tail (delay,
// reverb) makes the result longer. Params that can move (a cutoff, a gain, a mix) are numbers or functions of time in
// seconds. Everything is a pure function of its inputs: noise comes from rng(seed), so a render is the same everywhere.
//
//   eq, compressor, limiter, saturate, delay, chorus, flanger, phaser, reverb, roomIR, convolve, fft
import { rng, TAU, length } from './core.js';
import { PARAMS, withDefaults } from './params.js';
import { createFx, rbj } from './fx.js';
export { PARAMS, withDefaults };

// ---------- small helpers ----------

/** A param as a Float32Array of n values (a function is sampled every `step` samples and drawn straight between). */
export function track(p, n, sr, step = 32) {
  const out = new Float32Array(n);
  if (typeof p !== 'function') return out.fill(p);
  let a = p(0);
  for (let i = 0; i < n; i += step) {
    const b = p(Math.min(i + step, n) / sr), m = Math.min(step, n - i);
    for (let k = 0; k < m; k++) out[i + k] = a + (b - a) * (k / step);
    a = b;
  }
  return out;
}
const mapChannels = (s, f) => ({ sr: s.sr, ch: s.ch.map((c, i) => f(c, i)) });
const rms = (s) => {
  let sum = 0;
  for (const c of s.ch) for (let i = 0; i < c.length; i++) sum += c[i] * c[i];
  return Math.sqrt(sum / Math.max(1, s.ch[0].length * 2));
};
const scaleBy = (c, g) => { for (let i = 0; i < c.length; i++) c[i] *= g; };
const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };
const mixed = (dry, wet, mix) => {
  // crossfade a (possibly shorter) dry channel with a wet one, into a new array the length of the wet
  const out = new Float32Array(wet.length), m = typeof mix === 'number';
  for (let i = 0; i < out.length; i++) {
    const k = m ? mix : mix[i];
    out[i] = (i < dry.length ? dry[i] : 0) * (1 - k) + wet[i] * k;
  }
  return out;
};

// ---------- FFT ----------

const twiddles = new Map();
/** In-place radix-2 FFT of (re, im), Float64Arrays whose length is a power of two; `inverse` also divides by n. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  let tw = twiddles.get(n);
  if (!tw) {
    tw = { c: new Float64Array(n >> 1), s: new Float64Array(n >> 1) };
    for (let i = 0; i < n >> 1; i++) { tw.c[i] = Math.cos(TAU * i / n); tw.s[i] = Math.sin(TAU * i / n); }
    twiddles.set(n, tw);
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const wr = tw.c[w], wi = sign * tw.s[w], a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** The full convolution of x with h (Float32Arrays), length x + h − 1: overlap-add through one FFT size. */
export function convolve(x, h) {
  const n = x.length, m = h.length, out = new Float32Array(Math.max(0, n + m - 1));
  if (!n || !m) return out;
  if (m <= 48 || n <= 48) { // tiny: direct is quicker than transforming
    const [a, b] = n >= m ? [x, h] : [h, x];
    for (let j = 0; j < b.length; j++) { const g = b[j]; if (g) for (let i = 0; i < a.length; i++) out[i + j] += a[i] * g; }
    return out;
  }
  const size = Math.max(2048, nextPow2(Math.min(2 * Math.max(m, 1), 2 * (n + m)))), block = size - m + 1;
  const hr = new Float64Array(size), hi = new Float64Array(size), xr = new Float64Array(size), xi = new Float64Array(size);
  hr.set(h); fft(hr, hi);
  for (let s = 0; s < n; s += block) {
    const len = Math.min(block, n - s);
    xr.fill(0); xi.fill(0);
    for (let i = 0; i < len; i++) xr[i] = x[s + i];
    fft(xr, xi);
    for (let i = 0; i < size; i++) { const a = xr[i], b = xi[i]; xr[i] = a * hr[i] - b * hi[i]; xi[i] = a * hi[i] + b * hr[i]; }
    fft(xr, xi, true);
    const end = Math.min(len + m - 1, out.length - s);
    for (let i = 0; i < end; i++) out[s + i] += xr[i];
  }
  return out;
}

/** One biquad over x in place (the room's band-splitting filters). */
function biquad(x, type, f, q, g, sr) {
  const co = new Float64Array(5);
  rbj(type, f, q, g, sr, co);
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i], y = co[0] * v + z1;
    z1 = co[1] * v - co[3] * y + z2; z2 = co[2] * v - co[4] * y;
    x[i] = y;
  }
}

// ---------- the effects: wrappers over the live processors (fx.js) ----------
// Each effect here runs its processor over the whole sound, then (for a delay or a reverb) over its tail, with the
// processor's `latency` taken off the front: there is one implementation of each effect, the one that streams.

/** A spec with its moving params (functions of time, in seconds) read at t. */
function at(v, t) {
  if (typeof v === 'function') return v(t);
  if (Array.isArray(v)) return v.map((x) => at(x, t));
  if (v && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, at(x, t)]));
  return v;
}
const isMoving = (v) => typeof v === 'function' || (Array.isArray(v) ? v.some(isMoving) : !!v && Object.getPrototypeOf(v) === Object.prototype && Object.values(v).some(isMoving));
const MOVE_STEP = 32;   // samples between reads of a moving param (the processor glides between them)

/**
 * Runs the effect `spec` ({ type, …params }) over s: a new sound, as long as s plus the effect's tail if it makes one
 * (`extend`: a delay's echoes, a reverb's ring). Moving params are read every MOVE_STEP samples and handed to the
 * processor's set(). `each(p, from, to)` may run the processor itself (a compressor's sidechain).
 */
function through(s, spec, { extend = false, each } = {}) {
  const sr = s.sr, n = length(s), moving = isMoving(spec), p = createFx(moving ? at(spec, 0) : spec, { sr });
  const lat = p.latency, N = n + (extend ? Math.round(p.tail * sr) : 0), M = N + lat, step = moving ? MOVE_STEP : 1 << 14;
  const L = new Float32Array(M), R = new Float32Array(M);
  L.set(s.ch[0]); R.set(s.ch[1]);
  for (let i = 0; i < M; i += step) {
    const to = Math.min(M, i + step);
    if (moving && i) p.set(at(spec, i / sr));
    if (each) each(p, L, R, i, to); else p.process(L.subarray(i, to), R.subarray(i, to), to - i);
  }
  return { sr, ch: [L.slice(lat, lat + N), R.slice(lat, lat + N)] };
}
const fx = (type, o) => ({ type, ...o });

/**
 * Equaliser: any number of bands, in series. A band is { type, freq, gain, q, slope }:
 *   type: 'lowpass' | 'highpass' (slope 12 or 24 dB/oct, Butterworth; q adds a resonance), 'lowshelf' | 'highshelf'
 *   (gain dB, q 0.707 is a plain shelf), 'peak' (a bell: gain dB, q), 'notch', 'bandpass'. freq (Hz), gain (dB) and q can
 *   be functions of time.
 */
export function eq(s, bands) {
  return through(s, { type: 'eq', bands });
}

// ---------- dynamics ----------

/**
 * Compressor. o: threshold (dB, −18), ratio (4), knee (dB, 6), attack and release (s, 0.01 and 0.1), makeup (dB, or
 * 'auto' to match the input's overall RMS), detect ('rms' or 'peak'), lookahead (s: the gain is applied that much early),
 * sidechain (a sound that drives the detector: ducking), mix (1; less is parallel compression), grOut (an object that
 * receives .gr, the gain reduction in dB per sample). Stereo is linked: both channels get the same gain.
 */
export function compressor(s, o = {}) {
  const { sidechain = null, grOut = null, ...rest } = o, auto = rest.makeup === 'auto', mix = withDefaults(PARAMS.compressor, rest).mix;
  const n = length(s), sc = sidechain ? sidechain.ch.map((c) => { const r = new Float32Array(n + Math.ceil(0.03 * s.sr)); r.set(c.subarray(0, n)); return r; }) : null;
  const gr = grOut ? new Float32Array(n) : null;
  const spec = fx('compressor', auto ? { ...rest, makeup: 0, mix: 1 } : rest);
  const run = (p, L, R, i, to) => {
    if (gr) { // (one sample at a time, to read the gain reduction of each)
      for (let k = i; k < to; k++) { p.process(L.subarray(k, k + 1), R.subarray(k, k + 1), 1, ...(sc ? [sc[0].subarray(k, k + 1), sc[1].subarray(k, k + 1)] : [])); if (k < n) gr[k] = p.reduction; }
    } else p.process(L.subarray(i, to), R.subarray(i, to), to - i, ...(sc ? [sc[0].subarray(i, to), sc[1].subarray(i, to)] : []));
  };
  let wet = through(s, spec, { each: sc || gr ? run : undefined });
  if (grOut) grOut.gr = gr;
  if (auto) {
    const r = rms(wet);
    if (r > 0) for (const c of wet.ch) scaleBy(c, rms(s) / r);
    if (mix < 1) wet = mapChannels(wet, (c, k) => mixed(s.ch[k], c, mix));
  }
  return wet;
}

/**
 * Brickwall limiter: the output never exceeds the ceiling. o: ceiling (dB, −1), lookahead (s, 0.005: the gain eases down
 * over that time before a peak), release (s, 0.1), gain (input gain, dB, 0), truePeak (true: the peaks between samples,
 * seen at 4× oversampling, are held to the ceiling too). Stereo is linked.
 */
export function limiter(s, o = {}) {
  return through(s, fx('limiter', o));
}

// ---------- saturation ----------

/**
 * Saturation. o: drive (dB, 12; a number or function), curve ('soft' tanh, 'tape' asymmetric, 'hard' clip), mix (1),
 * compensate (true: the output is brought back to the level of a −12 dBFS sine at this drive), oversample (4; 1 for none).
 */
export function saturate(s, o = {}) {
  return through(s, fx('saturate', o));
}

// ---------- delay and modulation ----------

/**
 * Delay. o: time (seconds, or { bpm, division }), feedback (0.4), pingPong (the echoes bounce left and right, starting
 * left), lowpass and highpass (Hz, in the feedback loop, so each repeat is duller or thinner), mix (0.3), tail (the most
 * seconds of echoes after the sound, 10).
 */
export function delay(s, o = {}) {
  return through(s, fx('delay', o), { extend: true });
}
/** Chorus: o { rate Hz 0.8, depth s 0.003, base s 0.015, voices 3, mix 0.5, spread 0.25 (right LFO phase, turns) }. */
export function chorus(s, o = {}) {
  return through(s, fx('chorus', o));
}
/** Flanger: a short swept delay with feedback. o { rate 0.25, depth s 0.002, base s 0.003, feedback 0.5 (negative too), mix 0.5 }. */
export function flanger(s, o = {}) {
  return through(s, fx('flanger', o));
}
/** Phaser: o { rate Hz 0.4, stages 4 (any even number), min 300, max 3000 (Hz, swept exponentially), feedback 0.3, mix 0.5 }. */
export function phaser(s, o = {}) {
  return through(s, fx('phaser', o));
}

// ---------- reverb ----------

const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
/**
 * A generated room impulse response (stereo). o:
 *   size    mean room dimension in metres: ~3 a small room, ~20 a hall, ~80 huge (10)
 *   decay   RT60 in seconds at low frequencies (default grows with size)
 *   damping 0–1: how much faster the highs die (0 all bands alike, 0.5 natural, 1 very dark) (0.5)
 *   predelay seconds before the first reflection (0.01)
 *   width   0–1: how different left and right are (1)
 *   early   0–1: the early reflections' level (0.5): discrete echoes off a shoebox room's walls (image sources)
 *   sr, seed
 * The late field is exponentially decaying noise split in eight octave bands, each with its own decay time, left and
 * right drawn from different noise; the whole is normalised to unit energy (a wet signal then has the dry's loudness).
 */
export function roomIR(o = {}) {
  const g = withDefaults(PARAMS.roomIR, o), sr = o.sr ?? 48000, { size, damping, width, early } = g;
  const decay = o.decay ?? 0.25 + 0.07 * size, pre = g.predelay, rand = rng(g.seed);
  const rtAt = (f) => decay / (1 + damping * f / 1000 * 0.6);
  const cuts = [125, 250, 500, 1000, 2000, 4000, 8000], mids = [88, 177, 354, 707, 1414, 2828, 5657, 11000];
  const rts = mids.map(rtAt), len = Math.ceil((pre + Math.max(...rts, 0.05) * 1.3 + 0.05) * sr), tau = Math.min(0.08, 0.004 + size * 0.0015);
  const noise = () => Float32Array.from({ length: len }, () => rand() - 0.5);
  const common = noise(), chans = [0, 1].map((c) => {
    const ind = noise(), nz = new Float32Array(len), w = Math.min(Math.max(width, 0), 1), a = Math.sqrt(1 - w), b = Math.sqrt(w);
    for (let i = 0; i < len; i++) nz[i] = a * common[i] + b * ind[i];
    // octave bands as differences of lowpasses, so that all bands at full level sum back to the noise exactly
    const tot = new Float32Array(len), lps = [];
    for (let k = 0; k < cuts.length; k++) {
      const lpf = Float32Array.from(nz);
      biquad(lpf, 'lowpass', cuts[k], 0.70710678, 0, sr);
      lps.push(lpf);
    }
    for (let k = 0; k < mids.length; k++) {
      const hiBand = k < cuts.length ? lps[k] : null, loBand = k > 0 ? lps[k - 1] : null, k60 = 3 / rts[k];
      for (let i = 0; i < len; i++) {
        const band = (hiBand ? hiBand[i] : nz[i]) - (loBand ? loBand[i] : 0), t = i / sr - pre;
        if (t >= 0) tot[i] += band * 10 ** (-k60 * t) * (1 - Math.exp(-t / tau));
      }
    }
    return tot;
  });
  // late field to unit energy
  for (const c of chans) { let e = 0; for (let i = 0; i < len; i++) e += c[i] * c[i]; scaleBy(c, 1 / Math.sqrt(e || 1)); }
  if (early > 0) addEarly(chans, { sr, size, decay, damping, pre, early, rand, width });
  // the very end fades out, so the tail never stops short
  const f0 = Math.floor(len * 0.9);
  for (const c of chans) {
    for (let i = f0; i < len; i++) c[i] *= 0.5 + 0.5 * Math.cos(Math.PI * (i - f0) / (len - f0));
    let e = 0; for (let i = 0; i < len; i++) e += c[i] * c[i];
    scaleBy(c, 1 / Math.sqrt(e || 1));
  }
  return { sr, ch: chans };
}

/** The early reflections of a shoebox room by the image-source method, added into chans. */
function addEarly(chans, { sr, size, decay, damping, pre, early, rand, width }) {
  const dims = [size * 1.45, size * 1.05, size * 0.65], V = dims[0] * dims[1] * dims[2];
  const S = 2 * (dims[0] * dims[1] + dims[0] * dims[2] + dims[1] * dims[2]);
  const alpha = Math.min(0.9, 0.161 * V / (Math.max(decay, 0.05) * S)), beta = Math.sqrt(1 - alpha);
  const src = [0.2 + 0.2 * rand(), 0.3 + 0.4 * rand(), 0.35 + 0.2 * rand()].map((v, i) => v * dims[i]);
  const lis = [0.55 + 0.2 * rand(), 0.3 + 0.4 * rand(), 0.35 + 0.2 * rand()].map((v, i) => v * dims[i]);
  const ear = 0.09 * (0.3 + width), R = 3, len = chans[0].length;
  const buf = [new Float32Array(len), new Float32Array(len)];
  for (let c = 0; c < 2; c++) {
    const p = [lis[0], lis[1] + (c ? ear : -ear), lis[2]];
    const direct = Math.hypot(src[0] - p[0], src[1] - p[1], src[2] - p[2]);
    for (let q0 = 0; q0 < 2; q0++) for (let q1 = 0; q1 < 2; q1++) for (let q2 = 0; q2 < 2; q2++) {
      for (let r0 = -R; r0 <= R; r0++) for (let r1 = -R; r1 <= R; r1++) for (let r2 = -R; r2 <= R; r2++) {
        const hits = Math.abs(2 * r0 - q0) + Math.abs(2 * r0) + Math.abs(2 * r1 - q1) + Math.abs(2 * r1) + Math.abs(2 * r2 - q2) + Math.abs(2 * r2);
        if (hits === 0 || hits > 6) continue;
        const ix = (1 - 2 * q0) * src[0] + 2 * r0 * dims[0], iy = (1 - 2 * q1) * src[1] + 2 * r1 * dims[1];
        const iz = (1 - 2 * q2) * src[2] + 2 * r2 * dims[2];
        const dist = Math.hypot(ix - p[0], iy - p[1], iz - p[2]), at = ((dist - direct) / 343 + pre) * sr;
        const g = beta ** hits * direct / dist, k = Math.floor(at), fr = at - k;
        if (k + 8 >= len) continue;
        for (let j = -7; j <= 8; j++) { // a fractional-delay pulse, Hann-windowed sinc
          const idx = k + j;
          if (idx >= 0) buf[c][idx] += g * sinc(j - fr) * (0.5 + 0.5 * Math.cos(Math.PI * (j - fr) / 8.5));
        }
      }
    }
    // walls take the highs
    const a = 1 - Math.exp(-TAU * (14000 * (1 - 0.85 * damping) + 1500) / sr);
    let y = 0;
    for (let i = 0; i < len; i++) { y += (buf[c][i] - y) * a; buf[c][i] = y; }
  }
  let e = 0;
  for (const b of buf) for (let i = 0; i < len; i++) e += b[i] * b[i];
  const k = Math.sqrt(0.6 * early) / Math.sqrt(e / 2 || 1); // early energy up to 0.6 of the late field's
  for (let c = 0; c < 2; c++) for (let i = 0; i < len; i++) chans[c][i] += buf[c][i] * k;
}

/**
 * Reverb by convolution. o: ir (a sound; else the room options { size, decay, damping, predelay, width, early, seed }
 * make one with roomIR), mix (0.3: dry·(1−mix) + wet·mix), predelay (s, added before the impulse response), normalize
 * (true: the impulse response is brought to unit energy). The result is as much longer as the impulse response.
 */
export function reverb(s, o = {}) {
  if (o.ir && o.ir.sr !== s.sr) throw new Error(`reverb: the impulse response is at ${o.ir.sr} Hz, the sound at ${s.sr}`);
  return through(s, fx('reverb', o), { extend: true });
}
