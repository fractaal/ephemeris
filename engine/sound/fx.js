// Live effects: each of effects.js's effects as a processor the live engine (nle/live.js) runs as the sound streams,
// block by block — in the editor's AudioWorklet while it plays, and in a render from the start.
//
//   const p = createFx({ type: 'compressor', threshold: -20, ratio: 3 }, { sr, media });   // null for an unknown type
//   p.process(L, R, n)   // the next n samples of a stereo stream, in place (Float32Arrays, n ≤ their length)
//   p.set(spec)          // new params (a knob turned while it plays): no click, the state kept
//   p.reset()            // forget the past (a seek)
//   p.tail               // seconds it may ring on after its input stops (a reverb's, a delay's)
//   p.latency            // samples the output lags the input by (a limiter's lookahead): constant, 0 for most
//
// Rules every processor keeps:
//   - what it outputs does not depend on how the stream is cut into blocks (128 at a time, 37, or all at once give the
//     same samples), so a render from the start is exactly what the editor played from the start;
//   - deterministic (no Math.random: seeded where it needs noise); no allocation in process(); real-time cheap;
//   - a spec is effects.js's PARAMS for its type (on: false is handled by the engine, not here). A reverb's `ir` is a
//     media id: media[id].channels are its samples at sr (else it makes its room from its params).
//
// How they keep them:
//   - everything is per sample, never per block: filters, detectors, LFOs and ramps all step once per sample, and the
//     one thing that works in blocks (the reverb's FFTs) works in blocks of its own fixed size counted from the start
//     of the stream, whatever size process() is given;
//   - set() does not jump: the gains and levels it changes glide to their new values over a few milliseconds (a
//     one-pole per sample), an EQ's coefficients ramp linearly over the same time, a delay's time slews like a tape;
//   - a lookahead is a fixed delay, so `latency` is set when the processor is made and stays: the engine delays the
//     tracks that have none by as much. Changing a lookahead later needs a new processor (set() leaves it).
//   - process(L, R, n, dL, dR) of a compressor takes the detector's input too (a sidechain); the engine does not.
import { PARAMS, withDefaults } from './params.js';
import { fft, roomIR } from './effects.js';
import { TAU, db } from './core.js';

export const FX_TYPES = Object.keys(PARAMS).filter((t) => t !== 'roomIR');

const RAMP = 0.004;   // seconds a changed gain or level takes to arrive
const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };
const ramp = (sr, seconds = RAMP) => 1 - Math.exp(-1 / (seconds * sr));

/** A value that glides to its target: one step per sample (so cutting the stream into blocks cannot change it). */
class Smooth {
  constructor(v, k) { this.c = v; this.t = v; this.k = k; }
  jump(v) { this.c = this.t = v; }
  next() {
    const d = this.t - this.c;
    if (d === 0) return this.c;
    if (Math.abs(d) < 1e-6 * Math.max(1, Math.abs(this.t))) return this.c = this.t;
    return this.c += d * this.k;
  }
}

/** A live processor for an effect spec ({ type, …params }), or null for a type with none. */
export function createFx(spec, { sr, media = {}, ready = null } = {}) {
  if (!FX_TYPES.includes(spec?.type)) return null;
  const fx = MAKERS[spec.type](spec, sr, media, ready);
  fx.set(spec);
  return fx;
}

// ---------- eq ----------

/** RBJ biquad coefficients into co[o…o+4] = [b0, b1, b2, a1, a2] (already divided by a0). */
export function rbj(type, f, q, g, sr, co, o = 0) {
  const w = TAU * Math.min(Math.max(f, 8), sr * 0.49) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * Math.max(q, 0.05));
  const A = 10 ** (g / 40), sA = 2 * Math.sqrt(A) * al;
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass': b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
    case 'highpass': b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
    case 'bandpass': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
    case 'notch': b0 = 1; b1 = -2 * cs; b2 = 1; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
    case 'peak': b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; break;
    case 'lowshelf':
      b0 = A * ((A + 1) - (A - 1) * cs + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sA);
      a0 = (A + 1) + (A - 1) * cs + sA; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sA; break;
    case 'highshelf':
      b0 = A * ((A + 1) + (A - 1) * cs + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sA);
      a0 = (A + 1) - (A - 1) * cs + sA; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sA; break;
    default: throw new Error(`eq: unknown band type ${type}`);
  }
  co[o] = b0 / a0; co[o + 1] = b1 / a0; co[o + 2] = b2 / a0; co[o + 3] = a1 / a0; co[o + 4] = a2 / a0;
}

const BUTTER = { 12: [0.70710678], 24: [0.54119610, 1.30656296] };
/** An EQ's bands as the biquads that make them: a 24 dB/oct pass is two, the others one each. */
function eqSections(bands = []) {
  const out = [];
  for (const band of bands) {
    const { type, freq, gain, q, slope } = withDefaults(PARAMS.eq, band);
    if (type === 'lowpass' || type === 'highpass') for (const v of BUTTER[slope] ?? BUTTER[12]) out.push({ type, f: freq, q: v * q / 0.70710678, g: 0 });
    else out.push({ type, f: freq, q, g: gain });
  }
  return out;
}

/** An EQ's response (bands as `eq` takes them, at sample rate sr): its gain in dB at each frequency of `freqs` (Hz), all
 *  its bands together and each band's own — { total, bands: [Float64Array] } — from the biquads that make its sound. */
export function eqResponse(bands, sr, freqs) {
  const co = new Float64Array(5), total = new Float64Array(freqs.length), each = [];
  for (const band of bands ?? []) {
    const out = new Float64Array(freqs.length);
    for (const s of eqSections([band])) {
      rbj(s.type, s.f, s.q, s.g, sr, co);
      const [b0, b1, b2, a1, a2] = co;
      freqs.forEach((f, i) => {
        // |H(e^jw)|² = |b0 + b1 e^-jw + b2 e^-2jw|² / |1 + a1 e^-jw + a2 e^-2jw|²
        const w = TAU * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
        const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
        out[i] += 10 * Math.log10(Math.max(1e-24, (nr * nr + ni * ni) / (dr * dr + di * di)));
      });
    }
    each.push(out);
    for (let i = 0; i < total.length; i++) total[i] += out[i];
  }
  return { total, bands: each };
}

/** Biquads in series, one pair of states (left, right) each; a changed band ramps its coefficients straight over RAMP. */
function eqFx(_, sr) {
  const RN = Math.max(1, Math.round(RAMP * sr)), co = new Float64Array(5);
  let types = [], cur = new Float64Array(0), from = cur, tgt = cur, step = cur, z = cur, pos = RN;
  const fx = {
    tail: 0, latency: 0,
    set(spec) {
      const list = eqSections(spec.bands), S = list.length, next = new Float64Array(S * 5);
      list.forEach((s, i) => { rbj(s.type, s.f, s.q, s.g, sr, co); next.set(co, i * 5); });
      if (S === types.length && list.every((s, i) => s.type === types[i])) { // same bands: glide to the new numbers
        from = Float64Array.from(cur); step = next.map((v, i) => (v - from[i]) / RN); pos = 0;
      } else { // a band added or its type changed: the sections that stay keep their state
        const nz = new Float64Array(S * 4); nz.set(z.subarray(0, Math.min(z.length, nz.length))); z = nz;
        cur = Float64Array.from(next); from = cur; step = new Float64Array(S * 5); pos = RN;
      }
      tgt = next; types = list.map((s) => s.type);
    },
    reset() { z.fill(0); cur = Float64Array.from(tgt); pos = RN; },
    process(L, R, n) {
      const m = Math.min(n, RN - pos); // the samples of this call still on the ramp
      for (let s = 0; s < types.length; s++) {
        const o = s * 5, q = s * 4;
        let b0 = cur[o], b1 = cur[o + 1], b2 = cur[o + 2], a1 = cur[o + 3], a2 = cur[o + 4];
        let l1 = z[q], l2 = z[q + 1], r1 = z[q + 2], r2 = z[q + 3];
        for (let i = 0; i < m; i++) {
          const j = pos + i + 1, end = j >= RN; // the coefficient at ramp step j is from + step·j (the target itself at the end)
          b0 = end ? tgt[o] : from[o] + step[o] * j; b1 = end ? tgt[o + 1] : from[o + 1] + step[o + 1] * j;
          b2 = end ? tgt[o + 2] : from[o + 2] + step[o + 2] * j; a1 = end ? tgt[o + 3] : from[o + 3] + step[o + 3] * j;
          a2 = end ? tgt[o + 4] : from[o + 4] + step[o + 4] * j;
          const xl = L[i], xr = R[i], yl = b0 * xl + l1, yr = b0 * xr + r1;
          l1 = b1 * xl - a1 * yl + l2; l2 = b2 * xl - a2 * yl; r1 = b1 * xr - a1 * yr + r2; r2 = b2 * xr - a2 * yr;
          L[i] = yl; R[i] = yr;
        }
        for (let i = m; i < n; i++) {
          const xl = L[i], xr = R[i], yl = b0 * xl + l1, yr = b0 * xr + r1;
          l1 = b1 * xl - a1 * yl + l2; l2 = b2 * xl - a2 * yl; r1 = b1 * xr - a1 * yr + r2; r2 = b2 * xr - a2 * yr;
          L[i] = yl; R[i] = yr;
        }
        cur[o] = b0; cur[o + 1] = b1; cur[o + 2] = b2; cur[o + 3] = a1; cur[o + 4] = a2;
        z[q] = l1; z[q + 1] = l2; z[q + 2] = r1; z[q + 3] = r2;
      }
      pos += m;
    },
  };
  return fx;
}

// ---------- dynamics ----------

/**
 * Compressor: a power (or peak) detector, a gain computer with a soft knee, an attack/release smoother, per sample,
 * stereo linked. A lookahead delays the sound by that many samples (its `latency`) while the detector sees it undelayed,
 * so the gain arrives early; a ring holds the delayed sound. Makeup 'auto' needs the whole sound: live it is 0.
 */
function compressorFx(spec, sr) {
  const la = Math.round(withDefaults(PARAMS.compressor, spec).lookahead * sr), size = pow2(la + 1), mask = size - 1;
  const ringL = new Float32Array(size), ringR = new Float32Array(size), k = ramp(sr);
  const thr = new Smooth(0, k), rat = new Smooth(1, k), mk = new Smooth(0, k), mix = new Smooth(1, k);
  const cp = Math.exp(-1 / (0.01 * sr));
  let ca = 0, cr = 0, knee = 0, isRms = true, p = 0, g = 0, w = 0, fresh = true;
  const fx = {
    tail: 0, latency: la, get reduction() { return g; }, // (dB, what the last sample was turned down by: for a meter)
    set(spec) {
      const o = withDefaults(PARAMS.compressor, spec);
      thr.t = o.threshold; rat.t = o.ratio; mk.t = typeof o.makeup === 'number' ? o.makeup : 0; mix.t = o.mix;
      ca = Math.exp(-1 / Math.max(o.attack * sr, 1e-3)); cr = Math.exp(-1 / Math.max(o.release * sr, 1e-3));
      knee = o.knee; isRms = o.detect !== 'peak';
      if (fresh) { thr.jump(thr.t); rat.jump(rat.t); mk.jump(mk.t); mix.jump(mix.t); fresh = false; }
    },
    reset() { ringL.fill(0); ringR.fill(0); p = 0; g = 0; w = 0; },
    process(L, R, n, dL = L, dR = R) {
      for (let i = 0; i < n; i++) {
        const a = dL[i], b = dR[i];
        let lvl;
        if (isRms) { p = (a * a + b * b) * 0.5 * (1 - cp) + p * cp; lvl = 10 * Math.log10(p + 1e-12); }
        else lvl = 20 * Math.log10(Math.max(Math.abs(a), Math.abs(b)) + 1e-9);
        const over = lvl - thr.next(), slope = 1 / rat.next() - 1;
        let target;
        if (2 * over < -knee) target = 0;
        else if (2 * Math.abs(over) <= knee) target = slope * (over + knee / 2) ** 2 / (2 * knee);
        else target = slope * over;
        g = target < g ? target + (g - target) * ca : target + (g - target) * cr;
        ringL[w & mask] = L[i]; ringR[w & mask] = R[i];
        const xl = ringL[(w - la) & mask], xr = ringR[(w - la) & mask], gain = 10 ** ((g + mk.next()) / 20), m = mix.next();
        L[i] = xl * (1 - m) + xl * gain * m; R[i] = xr * (1 - m) + xr * gain * m;
        w++;
      }
    },
  };
  return fx;
}

/** A compressor's curve as its settings say (its view's): the level out (dB) for a level in (dB) held long enough for
 *  attack and release to settle — compressorFx's gain computer (soft knee), its makeup and its mix. → (dB in) → dB out. */
export function compressorCurve(spec) {
  const o = withDefaults(PARAMS.compressor, spec), slope = 1 / o.ratio - 1, knee = o.knee, mk = typeof o.makeup === 'number' ? o.makeup : 0;
  return (x) => {
    const over = x - o.threshold;
    const g = 2 * over < -knee ? 0 : knee > 0 && 2 * Math.abs(over) <= knee ? slope * (over + knee / 2) ** 2 / (2 * knee) : slope * over;
    return x + 20 * Math.log10(Math.max(1e-9, 1 - o.mix + o.mix * 10 ** ((g + mk) / 20)));
  };
}

// Interpolating a sample peak: three points between samples (¼, ½, ¾), 8 taps of a Hann-windowed sinc.
const TP = [0.25, 0.5, 0.75].map((fr) => Float64Array.from({ length: 8 }, (_, j) => {
  const x = fr - (j - 3), w = 0.5 + 0.5 * Math.cos(Math.PI * x / 4.5);
  return (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w;
}));

/**
 * Brickwall limiter with lookahead L: the gain each sample needs is the lowest need over the L samples up to it
 * (a sliding minimum), released by a one-pole, then averaged over the next L, so it ramps down ahead of a peak. A true
 * peak needs 4 samples after the one it judges, so the sound is delayed by L − 1 + 4 (L − 1 without truePeak): that is
 * `latency`, fixed. Rings (the sound, the needs, the deque of the minimum, the released gains) are all preallocated.
 */
function limiterFx(spec, sr) {
  const o0 = withDefaults(PARAMS.limiter, spec), L = Math.max(1, Math.round(o0.lookahead * sr)), a = o0.truePeak ? 4 : 0;
  const lat = L - 1 + a, xs = pow2(lat + 9), xm = xs - 1, ws = pow2(L + 1), wm = ws - 1;
  const xl = new Float32Array(xs), xr = new Float32Array(xs), need = new Float64Array(ws), dq = new Float64Array(ws), hh = new Float64Array(ws);
  const k = ramp(sr), ceil = new Smooth(1, k), g0 = new Smooth(1, k);
  let rel = 0, tp = true, t = 0, j = 0, head = 0, tail = 0, h = 1, run = 0, fresh = true;
  const fx = {
    tail: 0, latency: lat, get reduction() { return 20 * Math.log10(Math.max(1e-6, run / L)); }, // (dB, the gain the last sample got, its input gain aside: for a meter)
    set(spec) {
      const o = withDefaults(PARAMS.limiter, spec);
      ceil.t = db(o.ceiling); g0.t = db(o.gain); rel = Math.exp(-1 / Math.max(o.release * sr, 1)); tp = o.truePeak && a > 0;
      if (fresh) { ceil.jump(ceil.t); g0.jump(g0.t); fresh = false; }
    },
    reset() { xl.fill(0); xr.fill(0); need.fill(0); dq.fill(0); hh.fill(0); t = 0; j = 0; head = 0; tail = 0; h = 1; run = 0; },
    process(Lc, Rc, n) {
      for (let i = 0; i < n; i++) {
        xl[t & xm] = Lc[i]; xr[t & xm] = Rc[i];
        const c = ceil.next(), gi = g0.next();
        if (t >= a) { // judge the sample a behind the newest (it has its 4 followers)
          const q = t - a, lim = c * 0.35;
          let pk = Math.max(Math.abs(xl[q & xm]), Math.abs(xr[q & xm])) * gi;
          if (tp && (pk > lim || Math.max(Math.abs(xl[(q + 1) & xm]), Math.abs(xr[(q + 1) & xm])) * gi > lim)) {
            for (let f = 0; f < 3; f++) {
              const hf = TP[f];
              let u = 0, v = 0;
              for (let d = 0; d < 8; d++) { const s = (q + d - 3) & xm; u += xl[s] * hf[d]; v += xr[s] * hf[d]; }
              pk = Math.max(pk, Math.abs(u) * gi, Math.abs(v) * gi);
            }
          }
          const nd = pk > c ? c / pk : 1;
          need[j & wm] = nd;
          while (tail > head && need[dq[(tail - 1) & wm] & wm] >= nd) tail--;
          dq[tail & wm] = j; tail++;
          if (dq[head & wm] <= j - L) head++;
          const m = need[dq[head & wm] & wm];
          h = Math.min(m, h + (1 - h) * (1 - rel));
          run += h - hh[(j - L) & wm]; hh[j & wm] = h;
          j++;
        }
        const s = (t - lat) & xm, gain = (run / L) * gi;
        Lc[i] = Math.max(-c, Math.min(c, xl[s] * gain)); Rc[i] = Math.max(-c, Math.min(c, xr[s] * gain));
        t++;
      }
    },
  };
  return fx;
}

// ---------- saturation ----------

// Oversampling by L with a Kaiser-windowed sinc, 2·OS_K input samples long: the same filter up and down, now causal
// (so the sound lags by 2·OS_K samples, the saturator's `latency`), run as a polyphase bank so only the taps that meet
// a non-zero sample are multiplied.
const OS_K = 8;
const kernels = new Map();
function osKernel(L) {
  if (kernels.has(L)) return kernels.get(L);
  const len = 2 * OS_K * L + 1, h = new Float64Array(len), c = 0.9;
  const i0 = (x) => { let sum = 1, t = 1; for (let k = 1; k < 20; k++) { t *= (x / (2 * k)) ** 2; sum += t; } return sum; };
  const beta = 8, norm = i0(beta);
  for (let j = -OS_K * L; j <= OS_K * L; j++) {
    const x = c * j / L, w = i0(beta * Math.sqrt(1 - (j / (OS_K * L)) ** 2)) / norm;
    h[j + OS_K * L] = c * (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w;
  }
  const taps = 2 * OS_K + 1, poly = new Float64Array(L * taps); // poly[p·taps + d] = h[d·L + p]
  for (let p = 0; p < L; p++) for (let d = 0; d < taps; d++) poly[p * taps + d] = d * L + p < len ? h[d * L + p] : 0;
  const out = { h, poly, taps };
  kernels.set(L, out);
  return out;
}
const TAPE_BIAS = Math.tanh(0.35);
const SHAPES = {
  soft: Math.tanh,
  tape: (v) => Math.tanh(v + 0.35) - TAPE_BIAS, // a lopsided curve, so even harmonics too; the DC is removed after
  hard: (v) => (v > 1 ? 1 : v < -1 ? -1 : v),
};
/** The gain that brings a shaper's output back to a −12 dBFS sine's level at this drive (what `compensate` does live). */
function compensation(shape, drive) {
  const A = 0.25, N = 256, y = new Float64Array(N);
  let mean = 0, e = 0;
  for (let i = 0; i < N; i++) mean += y[i] = shape(drive * A * Math.sin(TAU * i / N)) / N;
  for (let i = 0; i < N; i++) e += (y[i] * N - mean * N) ** 2 / N;
  return e > 1e-12 ? (A * A / 2) ** 0.5 / Math.sqrt(e) : 1;
}

/** A saturator's curve as its settings say (its view's): what an input sample (−1…1) comes out as, its drive,
 *  compensation and mix in it (the DC blocker after the shaper aside: it takes away only the lean a curve adds over
 *  time). → (x) → y. */
export function saturateCurve(spec) {
  const o = withDefaults(PARAMS.saturate, spec), shape = SHAPES[o.curve] ?? Math.tanh, d = db(o.drive), c = o.compensate ? compensation(shape, d) : 1;
  return (x) => x * (1 - o.mix) + shape(x * d) * c * o.mix;
}

function saturateFx(spec, sr) {
  const k = ramp(sr), drive = new Smooth(1, k), comp = new Smooth(1, k), mix = new Smooth(1, k);
  const dc = Math.exp(-TAU * 10 / sr);
  let Lo = 1, shape = Math.tanh, compensate = true, kern = null, lat = 0, fresh = true;
  let xr, hi, hm, n = 0, pxL = 0, pyL = 0, pxR = 0, pyR = 0;
  /** One channel's next input sample through the oversampled shaper: x up to Lo× (polyphase), shaped, back down. */
  function oversampled(c, x, dr) {
    const { h, poly, taps } = kern, xc = xr[c], hc = hi[c];
    xc[n & 31] = x;
    for (let p = 0; p < Lo; p++) {
      let acc = 0;
      for (let d = 0, b = p * taps; d < taps; d++) acc += xc[(n - d) & 31] * poly[b + d];
      hc[(n * Lo + p) & hm] = shape(acc * dr);
    }
    let y = 0;
    const start = (n - 2 * OS_K) * Lo;
    for (let u = 0, len = h.length; u < len; u++) y += hc[(start + u) & hm] * h[u];
    return y / Lo;
  }
  const fx = {
    tail: 0, latency: 0,
    set(spec) {
      const o = withDefaults(PARAMS.saturate, spec);
      shape = SHAPES[o.curve];
      if (!shape) throw new Error(`saturate: unknown curve ${o.curve}`);
      compensate = o.compensate;
      drive.t = db(o.drive); mix.t = o.mix; comp.t = compensate ? compensation(shape, drive.t) : 1;
      if (fresh || o.oversample !== Lo) { // a new oversampling factor: new filters (and an empty past)
        Lo = o.oversample; kern = Lo > 1 ? osKernel(Lo) : null; lat = Lo > 1 ? 2 * OS_K : 0; fx.latency = lat;
        xr = [new Float64Array(32), new Float64Array(32)]; hi = [new Float64Array(pow2(2 * OS_K * Lo + Lo + 2)), new Float64Array(pow2(2 * OS_K * Lo + Lo + 2))];
        hm = hi[0].length - 1;
      }
      if (fresh) { drive.jump(drive.t); comp.jump(comp.t); mix.jump(mix.t); fresh = false; }
    },
    reset() { xr[0].fill(0); xr[1].fill(0); hi[0].fill(0); hi[1].fill(0); n = 0; pxL = pyL = pxR = pyR = 0; },
    process(L, R, cnt) {
      for (let i = 0; i < cnt; i++) {
        const dr = drive.next(), cg = comp.next(), m = mix.next();
        const wl = Lo === 1 ? shape(L[i] * dr) : oversampled(0, L[i], dr), wr = Lo === 1 ? shape(R[i] * dr) : oversampled(1, R[i], dr);
        const dl = Lo === 1 ? L[i] : xr[0][(n - lat) & 31], drr = Lo === 1 ? R[i] : xr[1][(n - lat) & 31]; // the dry, as late as the wet
        pyL = wl - pxL + dc * pyL; pxL = wl; pyR = wr - pxR + dc * pyR; pxR = wr; // a DC blocker at 10 Hz
        L[i] = dl * (1 - m) + pyL * cg * m; R[i] = drr * (1 - m) + pyR * cg * m;
        n++;
      }
    },
  };
  return fx;
}

// ---------- delay and modulation ----------

const DIVISIONS = { '1/1': 4, '1/2': 2, '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125 };
/** A delay time in seconds from a number (seconds) or { bpm, division: '1/8' | '1/4d' | '1/8t' | beats }. */
export function delayTime(t) {
  if (typeof t === 'number') return t;
  const d = t.division ?? '1/4';
  let beats = typeof d === 'number' ? d : DIVISIONS[d.replace(/[dt]$/, '')];
  if (beats === undefined) throw new Error(`delay: unknown division ${d}`);
  if (typeof d === 'string' && d.endsWith('d')) beats *= 1.5;
  if (typeof d === 'string' && d.endsWith('t')) beats *= 2 / 3;
  return beats * 60 / t.bpm;
}

/**
 * Delay: a ring per side, the echoes fed back through a one-pole lowpass and highpass. A changed time moves the read
 * point at a limited speed (a tenth of a sample per sample), so the echoes glide in pitch like a tape's instead of
 * clicking; a time that stays is an exact whole number of samples.
 */
function delayFx(_, sr) {
  const k = ramp(sr), fb = new Smooth(0, k), mix = new Smooth(0, k);
  const SLEW = 0.1;
  let bufL = new Float32Array(0), bufR = bufL, mask = 0, w = 0, d = 1, target = 1, pp = false;
  let lpA = 1, hpA = 0, hpOn = false, lpL = 0, lpR = 0, hxL = 0, hxR = 0, hyL = 0, hyR = 0, fresh = true;
  const fx = {
    tail: 0, latency: 0,
    set(spec) {
      const o = withDefaults(PARAMS.delay, spec);
      target = Math.max(1, Math.round(delayTime(o.time) * sr));
      const need = pow2(target + 4);
      if (need > bufL.length) { // a longer time than the ring holds: a bigger ring, the past carried over
        const nl = new Float32Array(need), nr = new Float32Array(need);
        for (let i = 1; i <= bufL.length; i++) { nl[(w - i) & (need - 1)] = bufL[(w - i) & mask]; nr[(w - i) & (need - 1)] = bufR[(w - i) & mask]; }
        bufL = nl; bufR = nr; mask = need - 1;
      }
      const f = Math.min(o.feedback, 0.98);
      fb.t = f; mix.t = o.mix; pp = !!o.pingPong;
      lpA = o.lowpass ? 1 - Math.exp(-TAU * o.lowpass / sr) : 1; hpOn = !!o.highpass; hpA = hpOn ? Math.exp(-TAU * o.highpass / sr) : 0;
      const repeats = f > 0.001 ? Math.ceil(Math.log(0.001) / Math.log(f)) : 1;
      fx.tail = Math.min(o.tail, (repeats + 1) * target / sr);
      if (fresh) { fb.jump(f); mix.jump(o.mix); d = target; fresh = false; }
    },
    reset() { bufL.fill(0); bufR.fill(0); w = 0; d = target; lpL = lpR = hxL = hxR = hyL = hyR = 0; },
    process(L, R, n) {
      for (let i = 0; i < n; i++) {
        if (d !== target) d = Math.abs(target - d) <= SLEW ? target : d + Math.sign(target - d) * SLEW;
        let wl, wr;
        if (d === target) { wl = bufL[(w - d) & mask]; wr = bufR[(w - d) & mask]; } // (a whole number of samples)
        else {
          const r = w - d, q = Math.floor(r), f = r - q, a = q & mask, b = (q + 1) & mask;
          wl = bufL[a] + (bufL[b] - bufL[a]) * f; wr = bufR[a] + (bufR[b] - bufR[a]) * f;
        }
        lpL += (wl - lpL) * lpA; lpR += (wr - lpR) * lpA;
        const yL = lpL - hxL + hpA * hyL, yR = lpR - hxR + hpA * hyR; hxL = lpL; hxR = lpR; hyL = yL; hyR = yR;
        const dl = hpOn ? yL : lpL, dr = hpOn ? yR : lpR, f = fb.next(), m = mix.next(), xl = L[i], xr = R[i];
        if (pp) { bufL[w & mask] = (xl + xr) * 0.5 + f * dr; bufR[w & mask] = f * dl; }
        else { bufL[w & mask] = xl + f * dl; bufR[w & mask] = xr + f * dr; }
        L[i] = xl * (1 - m) + wl * m; R[i] = xr * (1 - m) + wr * m;
        w++;
      }
    },
  };
  return fx;
}

/**
 * Chorus and flanger: `voices` taps swept by sine LFOs round `base` seconds, `depth` seconds each way, read with cubic
 * interpolation from a ring per side; the taps' mean goes back into the ring through `feedback` (a flanger's). The
 * right side's LFOs start `spread` of a turn later. A tap never reads nearer than 2 samples, where the ring is written.
 */
function modFx(type) {
  return (_, sr) => {
    const MAXV = 6, size = pow2(Math.ceil(0.1 * sr) + 8), mask = size - 1, k = ramp(sr);
    const bufs = [new Float32Array(size), new Float32Array(size)], ph = new Float64Array(2 * MAXV), last = new Float64Array(2);
    const depth = new Smooth(0, k), base = new Smooth(0, k), mix = new Smooth(0, k), fbk = new Smooth(0, k);
    let rate = 0, voices = 1, spread = 0, t = 0, fresh = true;
    const phases = () => { for (let c = 0; c < 2; c++) for (let v = 0; v < MAXV; v++) ph[c * MAXV + v] = v / voices + (c ? spread : 0); };
    const fx = {
      tail: 0, latency: 0,
      set(spec) {
        const o = withDefaults(PARAMS[type], spec);
        rate = o.rate; depth.t = o.depth; base.t = o.base; mix.t = o.mix; fbk.t = o.feedback ?? 0;
        const nv = type === 'flanger' ? 1 : Math.max(1, Math.min(MAXV, Math.round(o.voices)));
        const sp = o.spread;
        if (fresh) { voices = nv; spread = sp; phases(); depth.jump(depth.t); base.jump(base.t); mix.jump(mix.t); fbk.jump(fbk.t); fresh = false; }
        voices = nv; spread = sp;
        const f = Math.abs(fbk.t), rings = f > 0.001 ? Math.min(10, Math.log(0.001) / Math.log(f)) : 1;
        fx.tail = (o.base + o.depth) * (1 + (type === 'flanger' ? rings : 0));
      },
      reset() { bufs[0].fill(0); bufs[1].fill(0); last.fill(0); t = 0; phases(); },
      process(L, R, n) {
        for (let i = 0; i < n; i++, t++) {
          const dp = depth.next(), bs = base.next(), m = mix.next(), f = fbk.next();
          for (let c = 0; c < 2; c++) {
            const x = c ? R[i] : L[i], buf = bufs[c];
            buf[t & mask] = x + f * last[c];
            let acc = 0;
            for (let v = 0; v < voices; v++) {
              const pi = c * MAXV + v;
              let p = ph[pi] + rate / sr; if (p >= 1) p -= 1;
              ph[pi] = p;
              const dl = Math.max(2, (bs + dp * Math.sin(TAU * p)) * sr), pos = t - dl, q = Math.floor(pos), fr = pos - q;
              const a = buf[(q - 1) & mask], b = buf[q & mask], cc = buf[(q + 1) & mask], d = buf[(q + 2) & mask];
              acc += b + 0.5 * fr * (cc - a + fr * (2 * a - 5 * b + 4 * cc - d + fr * (3 * (b - cc) + d - a))); // cubic Hermite between b and cc
            }
            last[c] = acc / voices;
            const y = x * (1 - m) + last[c] * m;
            if (c) R[i] = y; else L[i] = y;
          }
        }
      },
    };
    return fx;
  };
}

/** Phaser: an all-pass chain swept exponentially between min and max by a sine LFO per side, mixed with the dry. */
function phaserFx(_, sr) {
  const MAXS = 12, k = ramp(sr), lo = new Smooth(0, k), hi = new Smooth(0, k), fbk = new Smooth(0, k), mix = new Smooth(0, k);
  const z = [new Float64Array(MAXS), new Float64Array(MAXS)], ph = new Float64Array(2), a = new Float64Array(2), last = new Float64Array(2);
  let rate = 0, stages = 4, spread = 0, t = 0, fresh = true;
  const fx = {
    tail: 0, latency: 0,
    set(spec) {
      const o = withDefaults(PARAMS.phaser, spec);
      rate = o.rate; stages = Math.max(1, Math.min(MAXS, Math.round(o.stages))); spread = o.spread;
      lo.t = Math.log(o.min); hi.t = Math.log(o.max); fbk.t = o.feedback; mix.t = o.mix;
      fx.tail = Math.abs(o.feedback) > 0.01 ? 0.5 : 0.05;
      if (fresh) { lo.jump(lo.t); hi.jump(hi.t); fbk.jump(fbk.t); mix.jump(mix.t); ph[1] = spread; fresh = false; }
    },
    reset() { z[0].fill(0); z[1].fill(0); ph[0] = 0; ph[1] = spread; a.fill(0); last.fill(0); t = 0; },
    process(L, R, n) {
      for (let i = 0; i < n; i++, t++) {
        const l = lo.next(), h = hi.next(), f = fbk.next(), m = mix.next(), upd = (t & 7) === 0; // the coefficient moves every 8 samples
        for (let c = 0; c < 2; c++) {
          let p = ph[c] + rate / sr; if (p >= 1) p -= 1;
          ph[c] = p;
          if (upd) { const tn = Math.tan(Math.PI * Math.exp(l + (h - l) * (0.5 - 0.5 * Math.cos(TAU * p))) / sr); a[c] = (tn - 1) / (tn + 1); }
          const x = c ? R[i] : L[i], zc = z[c], ac = a[c];
          let v = x + f * last[c];
          for (let s = 0; s < stages; s++) { const w = ac * v + zc[s]; zc[s] = v - ac * w; v = w; }
          last[c] = v;
          const y = x * (1 - m) + (x + v) * 0.5 * m; // a notch where the all-pass chain is out of phase
          if (c) R[i] = y; else L[i] = y;
        }
      }
    },
  };
  return fx;
}

// ---------- reverb ----------
//
// Convolution with the impulse response h, in real time and with no latency. h is cut into pieces that grow:
//   h[0, 128)       the head: a plain dot product with the last 128 inputs, per sample
//   [128, 256), [256, 512), …, [1024, 2048)   one FFT partition each, of size 128, 256, … 1024
//   [2048, end)     partitions of 2048, as many as it takes
// A partition of size S at lags [S·(1+j), S·(2+j)) takes the last 2S inputs through an FFT every S samples, keeps the
// spectra of the latest (a frequency-domain delay line), and the product with its piece's spectrum, back through an
// inverse FFT, is that piece's contribution to the next S outputs (overlap-save). Since every piece lags the input by
// at least its own size, its output is known before it is needed: only the head runs on the current sample.
// The two sides share each FFT (left as real part, right as imaginary part). The big level's sum over its many
// partitions is done a few at a time over the S/128 blocks before it is needed, so no block does much more than another.
// For the same reason the levels' boundaries are staggered: a level of P = S/128 blocks has its boundaries at block P/2 − 1
// of its period (256, 512, 1024, 2048 at 0, 1, 3, 7), so no two of the big FFTs fall in the same block. (A boundary may
// fall anywhere: a piece lags by at least S, so whenever it comes, the inputs the next S outputs need are all in.)
// All the FFTs happen on a fixed grid counted from the start of the stream (every 128 samples), whatever the size of
// the blocks process() gets, so the output is the same for any cut. Dry/wet is the last step: `mix` costs nothing.

const REV_B = 128, REV_MAXS = 2048;

/** A reverb's impulse response (two Float32Arrays, equal in length): the media one, else the generated room. */
function reverbIR(spec, sr, media) {
  const o = withDefaults(PARAMS.reverb, spec), given = irChannels(spec, media) ?? null, src = given ?? roomIR({ ...spec, sr }).ch;
  const pad = given && spec.predelay ? Math.round(spec.predelay * sr) : 0;
  const irs = [0, 1].map((c) => { const s = src[c] ?? src[0], r = new Float32Array(s.length + pad); r.set(s, pad); return r; });
  if (given && o.normalize) {
    let e = 0; for (const c of irs) for (let i = 0; i < c.length; i++) e += c[i] * c[i];
    const g = 1 / Math.sqrt(e / 2 || 1);
    for (const c of irs) for (let i = 0; i < c.length; i++) c[i] *= g;
  }
  if (!src[1]) irs[1] = irs[0]; // a mono impulse response: one spectrum for both sides
  return irs;
}
/** The channels of the impulse response a spec names (a media id, or a sound given directly), if there are any. */
const irChannels = (spec, media) => (typeof spec.ir === 'string' ? media[spec.ir]?.channels : spec.ir?.ch);
/** What of a spec decides the impulse response (a changed mix leaves it alone). */
const irKey = (spec) => JSON.stringify([typeof spec.ir === 'string' ? spec.ir : null, spec.size, spec.decay, spec.damping, spec.predelay,
  spec.width, spec.early, spec.seed, spec.normalize]);

/** A reverb's impulse response made ready to play: the head it convolves directly (reversed), its pieces' spectra (with
 *  their delay lines, empty) and its tail — what its set() makes of a spec, made elsewhere where the reverb plays on an
 *  audio thread (createFx's `ready`: nle/irworker.js). */
export function reverbReady(spec, sr, media = {}) {
  const [irL, irR] = reverbIR(spec, sr, media), N = Math.max(irL.length, irR.length), head = [new Float64Array(REV_B), new Float64Array(REV_B)];
  for (let i = 0; i < REV_B; i++) { head[0][REV_B - 1 - i] = irL[i] ?? 0; head[1][REV_B - 1 - i] = irR[i] ?? 0; }
  return { head, levels: reverbLevels(irL, irR, N), tail: Math.max(0, N - 1) / sr };
}

/** The levels of FFT partitions for an impulse response of N samples, with its pieces' spectra. */
function reverbLevels(irL, irR, N) {
  const levels = [], mono = irL === irR;
  for (let o = REV_B, S = REV_B; o < N; S = Math.min(S * 2, REV_MAXS)) {
    const c = S >= REV_MAXS ? Math.ceil((N - o) / S) : 1, bins = S + 1, size = 2 * S, wr = new Float64Array(size), wi = new Float64Array(size);
    const mk = () => new Float32Array(c * bins), P = S / REV_B, lv = {
      S, c, bins, size, o, head: c - 1, P, phase: P > 1 ? P / 2 - 1 : 0, per: Math.ceil((c - 1) / (S / REV_B)), wr, wi,
      hLr: mk(), hLi: mk(), hRr: null, hRi: null, xLr: mk(), xLi: mk(), xRr: mk(), xRi: mk(),
      aLr: new Float64Array(bins), aLi: new Float64Array(bins), aRr: new Float64Array(bins), aRi: new Float64Array(bins),
      oL: new Float64Array(S), oR: new Float64Array(S),
    };
    if (mono) { lv.hRr = lv.hLr; lv.hRi = lv.hLi; } else { lv.hRr = mk(); lv.hRi = mk(); }
    for (let j = 0; j < c; j++) { // each piece's spectrum
      wr.fill(0); wi.fill(0);
      for (let i = 0; i < S; i++) { const x = o + j * S + i; if (x < N) { wr[i] = irL[x] ?? 0; wi[i] = irR[x] ?? 0; } }
      fft(wr, wi);
      for (let q = 0; q < bins; q++) {
        const r = (size - q) & (size - 1), b = j * bins + q;
        lv.hLr[b] = (wr[q] + wr[r]) / 2; lv.hLi[b] = (wi[q] - wi[r]) / 2;
        if (!mono) { lv.hRr[b] = (wi[q] + wi[r]) / 2; lv.hRi[b] = -(wr[q] - wr[r]) / 2; }
      }
    }
    levels.push(lv);
    o += c * S;
  }
  return levels;
}

/** Every S samples (S = the level's size): the new input spectrum into the delay line, and the next S outputs. */
function levelBoundary(lv, histL, histR, T, hmask) {
  const { S, size, bins, wr, wi } = lv;
  for (let i = 0; i < size; i++) { const x = (T - size + i) & hmask; wr[i] = histL[x]; wi[i] = histR[x]; }
  fft(wr, wi);
  lv.head = (lv.head + 1) % lv.c;
  const base = lv.head * bins;
  for (let q = 0; q < bins; q++) {
    const r = (size - q) & (size - 1), b = base + q;
    lv.xLr[b] = (wr[q] + wr[r]) / 2; lv.xLi[b] = (wi[q] - wi[r]) / 2; lv.xRr[b] = (wi[q] + wi[r]) / 2; lv.xRi[b] = -(wr[q] - wr[r]) / 2;
  }
  for (let q = 0; q < bins; q++) { // the sum so far (the older partitions) plus the newest times the first piece
    const b = base + q, ar = lv.xLr[b], ai = lv.xLi[b], br = lv.xRr[b], bi = lv.xRi[b];
    const yLr = lv.aLr[q] + ar * lv.hLr[q] - ai * lv.hLi[q], yLi = lv.aLi[q] + ar * lv.hLi[q] + ai * lv.hLr[q];
    const yRr = lv.aRr[q] + br * lv.hRr[q] - bi * lv.hRi[q], yRi = lv.aRi[q] + br * lv.hRi[q] + bi * lv.hRr[q];
    wr[q] = yLr - yRi; wi[q] = yLi + yRr; // left + i·right, and the conjugate-mirrored half the real signals imply
    if (q > 0 && q < S) { wr[size - q] = yLr + yRi; wi[size - q] = -yLi + yRr; }
  }
  fft(wr, wi, true);
  for (let i = 0; i < S; i++) { lv.oL[i] = wr[S + i]; lv.oR[i] = wi[S + i]; }
  lv.aLr.fill(0); lv.aLi.fill(0); lv.aRr.fill(0); lv.aRi.fill(0);
}
/** One slice of the older partitions' sum for the next boundary (partition j now sits j − 1 places back in the line). */
function levelSlice(lv, s) {
  const { c, bins } = lv, j1 = Math.min(c, 1 + (s + 1) * lv.per);
  for (let j = 1 + s * lv.per; j < j1; j++) {
    const xb = (((lv.head - (j - 1)) % c) + c) % c * bins, hb = j * bins;
    for (let q = 0; q < bins; q++) {
      const ar = lv.xLr[xb + q], ai = lv.xLi[xb + q], br = lv.xRr[xb + q], bi = lv.xRi[xb + q];
      const hr = lv.hLr[hb + q], hi = lv.hLi[hb + q], gr = lv.hRr[hb + q], gi = lv.hRi[hb + q];
      lv.aLr[q] += ar * hr - ai * hi; lv.aLi[q] += ar * hi + ai * hr;
      lv.aRr[q] += br * gr - bi * gi; lv.aRi[q] += br * gi + bi * gr;
    }
  }
}

// A reverb's impulse response takes 50–400 ms to make (a room's, of its size and decay), and a block of the live engine
// has 2.7: where it plays on an audio thread, `ready(spec, key)` gives it the one it needs from elsewhere — { key, ir:
// reverbReady's }, the one asked for or one made on the way to it; null: asked for, set() comes again when it has come —
// and it plays its last until then. With none, it makes its own.
function reverbFx(_, sr, media, ready) {
  const B = REV_B, HM = 2 * REV_MAXS - 1;
  const histL = new Float64Array(HM + 1), histR = new Float64Array(HM + 1);
  const hbL = new Float64Array(2 * B - 1), hbR = new Float64Array(2 * B - 1), tl = new Float64Array(B), tr = new Float64Array(B);
  const revL = new Float64Array(B), revR = new Float64Array(B), mix = new Smooth(0, ramp(sr));
  let key = null, levels = [], fill = 0, e = 0, ref = null, fresh = true;
  function use(ir) { // a new impulse response: its pieces; the input's past stays, the delay lines start empty
    revL.set(ir.head[0]); revR.set(ir.head[1]);
    levels = ir.levels;
    fx.tail = ir.tail;
  }
  function event() { // a block of 128 samples is complete
    e++;
    const T = e * B;
    hbL.copyWithin(0, B, 2 * B - 1); hbR.copyWithin(0, B, 2 * B - 1);
    tl.fill(0); tr.fill(0);
    for (const lv of levels) {
      const r = (e + lv.P - lv.phase) % lv.P; // (blocks since its last boundary)
      if (r === 0) levelBoundary(lv, histL, histR, T, HM);
      if (lv.c > 1) levelSlice(lv, r);
      const off = r * B;
      for (let s = 0; s < B; s++) { tl[s] += lv.oL[off + s]; tr[s] += lv.oR[off + s]; }
    }
    fill = 0;
  }
  const fx = {
    tail: 0, latency: 0,
    set(spec) {
      const next = irKey(spec), ch = irChannels(spec, media); // (the channels by identity: a loaded or swapped one is new)
      if (fresh || next !== key || ch !== ref) {
        const got = ready ? ready(spec, next) : { key: next, ir: reverbReady(spec, sr, media) };
        if (got) { key = got.key; ref = ch; use(got.ir); }
      }
      mix.t = withDefaults(PARAMS.reverb, spec).mix;
      if (fresh) { mix.jump(mix.t); fresh = false; }
    },
    reset() {
      histL.fill(0); histR.fill(0); hbL.fill(0); hbR.fill(0); tl.fill(0); tr.fill(0); fill = 0; e = 0;
      for (const lv of levels) {
        for (const a of [lv.xLr, lv.xLi, lv.xRr, lv.xRi, lv.aLr, lv.aLi, lv.aRr, lv.aRi, lv.oL, lv.oR]) a.fill(0);
        lv.head = lv.c - 1;
      }
    },
    process(L, R, n) {
      let i = 0;
      while (i < n) {
        const m = Math.min(n - i, B - fill), T = e * B;
        for (let s = 0; s < m; s++) {
          const f = fill + s, xl = L[i + s], xr = R[i + s];
          hbL[B - 1 + f] = xl; hbR[B - 1 + f] = xr; histL[(T + f) & HM] = xl; histR[(T + f) & HM] = xr;
          let yl = tl[f], yr = tr[f];
          for (let q = 0; q < B; q++) { yl += revL[q] * hbL[f + q]; yr += revR[q] * hbR[f + q]; }
          const mx = mix.next();
          L[i + s] = xl * (1 - mx) + yl * mx; R[i + s] = xr * (1 - mx) + yr * mx;
        }
        fill += m; i += m;
        if (fill === B) event();
      }
    },
  };
  return fx;
}

const MAKERS = {
  eq: eqFx, compressor: compressorFx, limiter: limiterFx, saturate: saturateFx, delay: delayFx,
  chorus: modFx('chorus'), flanger: modFx('flanger'), phaser: phaserFx, reverb: reverbFx,
};
