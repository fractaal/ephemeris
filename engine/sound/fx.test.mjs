// Tests for the live effects (fx.js): `node engine/sound/fx.test.mjs`. For every effect: the output is the same
// sample for sample however the stream is cut into blocks, a set() mid-stream does not click, reset() forgets the
// past, and how long a block takes. Plus a few that pin what the effects do (the limiter's ceiling, the reverb against
// a plain convolution, its zero latency).
import { createFx, FX_TYPES, reverbReady } from './fx.js';
import * as effects from './effects.js';
const { convolve } = effects;

const sr = 48000;
let failed = 0;
const check = (ok, what) => { if (!ok) { failed++; console.log(`  FAIL ${what}`); } return ok; };

/** A deterministic stereo test signal: two sines and some noise, with bursts so dynamics have something to do. */
function signal(n, seed = 7) {
  let a = seed;
  const rnd = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296 - 0.5; };
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = (i % 9000) < 4500 ? 1 : 0.15;
    L[i] = env * (0.5 * Math.sin(i * 0.05) + 0.15 * Math.sin(i * 0.31) + 0.3 * rnd());
    R[i] = env * (0.4 * Math.sin(i * 0.037) + 0.2 * Math.sin(i * 0.23) + 0.3 * rnd());
  }
  return [L, R];
}
const sine = (n, amp = 0.3) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(i * 0.05); return [x, Float32Array.from(x)]; };

/** The IR the reverb tests share: a stereo, exponentially decaying noise `seconds` long, made without Math.random. */
function noiseIR(seconds, seed = 3) {
  let a = seed;
  const rnd = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296 - 0.5; };
  const n = Math.round(seconds * sr);
  return [0, 1].map(() => Float32Array.from({ length: n }, (_, i) => rnd() * Math.exp(-5 * i / n) * 0.05));
}
const media = { ir3: { channels: noiseIR(3) }, irMono: { channels: [noiseIR(0.8, 5)[0]] }, irShort: { channels: noiseIR(0.02, 9) } };

/** One spec per effect (all params at something that does audible work), and a second spec that set() moves to. */
const SPECS = {
  eq: [{ type: 'eq', bands: [{ type: 'lowshelf', freq: 100, gain: 3, q: 0.7 }, { type: 'peak', freq: 1500, gain: 6, q: 2 }, { type: 'highpass', freq: 60, slope: 24 }] },
    { type: 'eq', bands: [{ type: 'lowshelf', freq: 100, gain: -6, q: 0.7 }, { type: 'peak', freq: 900, gain: -9, q: 1 }, { type: 'highpass', freq: 90, slope: 24 }] }],
  compressor: [{ type: 'compressor', threshold: -24, ratio: 4, lookahead: 0.004, makeup: 3 }, { type: 'compressor', threshold: -40, ratio: 8, lookahead: 0.004, makeup: 6 }],
  limiter: [{ type: 'limiter', ceiling: -6, lookahead: 0.005, gain: 6 }, { type: 'limiter', ceiling: -12, lookahead: 0.005, gain: 3 }],
  saturate: [{ type: 'saturate', drive: 12, curve: 'tape' }, { type: 'saturate', drive: 24, curve: 'tape' }],
  delay: [{ type: 'delay', time: 0.1, feedback: 0.5, pingPong: true, lowpass: 4000, highpass: 150, mix: 0.4 }, { type: 'delay', time: 0.17, feedback: 0.3, pingPong: true, lowpass: 4000, highpass: 150, mix: 0.2 }],
  chorus: [{ type: 'chorus', rate: 0.9, depth: 0.003, mix: 0.5 }, { type: 'chorus', rate: 1.4, depth: 0.004, mix: 0.2 }],
  flanger: [{ type: 'flanger', rate: 0.4, feedback: 0.6, mix: 0.5 }, { type: 'flanger', rate: 0.7, feedback: -0.3, mix: 0.3 }],
  phaser: [{ type: 'phaser', rate: 0.5, stages: 6, feedback: 0.4, mix: 0.5 }, { type: 'phaser', rate: 0.8, stages: 6, min: 200, max: 2000, feedback: 0.2, mix: 0.3 }],
  reverb: [{ type: 'reverb', size: 5, decay: 0.7, mix: 0.4 }, { type: 'reverb', size: 5, decay: 0.7, mix: 0.1 }], // (the same room: a mix moves, nothing heavy)
};
const make = (spec) => createFx(spec, { sr, media });

/** Runs a processor over [L, R] cut at the sizes in `cuts` (repeated), calling set(spec) at sample `setAt`. → the output. */
function run(spec, [xl, xr], cuts, { setAt = -1, next = null, proc = make(spec) } = {}) {
  const n = xl.length, L = Float32Array.from(xl), R = Float32Array.from(xr);
  let i = 0, k = 0;
  while (i < n) {
    let m = Math.min(cuts[k++ % cuts.length], n - i);
    if (setAt > i && setAt < i + m) m = setAt - i; // (a set() lands between blocks: cut there)
    if (i === setAt) proc.set(next);
    proc.process(L.subarray(i, i + m), R.subarray(i, i + m), m);
    i += m;
  }
  return [L, R];
}
const same = (a, b) => { for (let c = 0; c < 2; c++) for (let i = 0; i < a[c].length; i++) if (a[c][i] !== b[c][i] && !(Number.isNaN(a[c][i]) && Number.isNaN(b[c][i]))) return i; return -1; };

const PATTERNS = { 'all at once': [1e9], 128: [128], 37: [37], 1: [1], 'ragged': [1, 127, 129, 500, 3, 64, 2048, 7] };

console.log('block-size invariance (every cut gives the same samples, ===):');
const N = 30000, input = signal(N);
for (const type of FX_TYPES) {
  const spec = SPECS[type][0], ref = run(spec, input, PATTERNS['all at once']);
  const fin = ref.every((c) => c.every(Number.isFinite)), moved = ref.some((c, k) => c.some((v, i) => v !== input[k][i]));
  const bad = Object.entries(PATTERNS).filter(([, cuts]) => same(ref, run(spec, input, cuts)) >= 0).map(([name]) => name);
  check(fin, `${type}: output not finite`); check(moved, `${type}: output equals the input (does nothing)`);
  check(!bad.length, `${type}: differs when cut as ${bad.join(', ')}`);
  console.log(`  ${type.padEnd(11)} ${bad.length || !fin ? 'FAIL' : 'ok'}  (${Object.keys(PATTERNS).join(', ')})`);
}

console.log('set() mid-stream: same samples for every cut, and no click:');
{
  const T = 12000, sin = sine(N);
  for (const type of FX_TYPES) {
    const [a, b] = SPECS[type];
    const ref = run(a, input, [1e9], { setAt: T, next: b });
    const bad = Object.entries(PATTERNS).filter(([, cuts]) => same(ref, run(a, input, cuts, { setAt: T, next: b })) >= 0).map(([name]) => name);
    check(!bad.length, `${type}: set() at ${T} gives different samples when cut as ${bad.join(', ')}`);
    // the click test: a steady sine, the biggest jump between neighbours after the set against before it
    const steady = run(a, sin, [128]), moved = run(a, sin, [128], { setAt: T, next: b });
    const jump = (x, from, to) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[0][i] - x[0][i - 1])); return m; };
    const before = jump(steady, 6000, T), after = jump(moved, T, T + 6000), floor = jump(steady, T, T + 6000);
    const ok = check(after <= Math.max(before, floor) * 3 + 0.01, `${type}: a step of ${after.toFixed(4)} after set() (steady ${before.toFixed(4)})`);
    console.log(`  ${type.padEnd(11)} ${ok ? 'ok' : 'FAIL'}  biggest step ${after.toFixed(4)} (steady ${before.toFixed(4)})`);
  }
}

console.log('reset() forgets:');
for (const type of FX_TYPES) {
  const spec = SPECS[type][0], p = make(spec), once = run(spec, input, [128], { proc: p });
  p.reset();
  const again = run(spec, input, [128], { proc: p });
  const silent = [new Float32Array(2000), new Float32Array(2000)];
  p.reset(); p.process(silent[0], silent[1], 2000);
  const rest = Math.max(...silent.map((c) => Math.max(...c.map(Math.abs))));
  const ok = check(same(once, again) < 0, `${type}: after reset() the output differs from a fresh run`) & check(rest === 0, `${type}: after reset() silence gives ${rest}`);
  console.log(`  ${type.padEnd(11)} ${ok ? 'ok' : 'FAIL'}`);
}

console.log('what they do:');
{
  // limiter: never above the ceiling, a constant latency
  const p = make({ type: 'limiter', ceiling: -6, gain: 12, lookahead: 0.005 }), ceil = 10 ** (-6 / 20);
  const [L, R] = run({ type: 'limiter', ceiling: -6, gain: 12, lookahead: 0.005 }, input, [128], { proc: p });
  let peak = 0; for (const c of [L, R]) for (const v of c) peak = Math.max(peak, Math.abs(v));
  check(peak <= ceil + 1e-6, `limiter: peak ${peak} over the ceiling ${ceil}`);
  const imp = [new Float32Array(1000), new Float32Array(1000)]; imp[0][500] = 0.1; imp[1][500] = 0.1;
  const q = make({ type: 'limiter', ceiling: -6, gain: 0 }), o = run({ type: 'limiter', ceiling: -6, gain: 0 }, imp, [128], { proc: q });
  let at = 0; for (let i = 0; i < 1000; i++) if (Math.abs(o[0][i]) > Math.abs(o[0][at])) at = i;
  check(at === 500 + q.latency, `limiter: a quiet impulse at 500 comes out at ${at}, latency ${q.latency}`);
  console.log(`  limiter: peak ${peak.toFixed(4)} ≤ ceiling ${ceil.toFixed(4)}, latency ${q.latency} samples (${(q.latency / sr * 1000).toFixed(2)} ms)`);
  console.log(`  latencies: ${FX_TYPES.map((t) => `${t} ${make(SPECS[t][0]).latency}`).join(', ')}`);
}
{
  // reverb: the same as a plain convolution (stereo, mono IR, an IR shorter than the head), and no latency
  for (const ir of ['ir3', 'irMono', 'irShort']) {
    const x = signal(20000, 11), spec = { type: 'reverb', ir, mix: 1, normalize: false }, p = make(spec);
    const out = run(spec, x, [128], { proc: p });
    const ch = media[ir].channels;
    let worst = 0, scale = 0;
    for (let c = 0; c < 2; c++) {
      const ref = convolve(x[c], ch[c] ?? ch[0]);
      for (let i = 0; i < 20000; i++) { worst = Math.max(worst, Math.abs(out[c][i] - ref[i])); scale = Math.max(scale, Math.abs(ref[i])); }
    }
    check(worst / scale < 1e-5, `reverb ${ir}: differs from the convolution by ${(worst / scale).toExponential(2)}`);
    console.log(`  reverb ${ir.padEnd(7)} vs convolution: worst error ${(worst / scale).toExponential(1)} of peak, tail ${p.tail.toFixed(3)} s`);
  }
  const p = make({ type: 'reverb', ir: 'ir3', mix: 1, normalize: false }), L = new Float32Array(1), R = new Float32Array(1);
  L[0] = 1; R[0] = 1; p.process(L, R, 1);
  check(Math.abs(L[0] - media.ir3.channels[0][0]) < 1e-9, `reverb: an impulse's first output sample is ${L[0]}, not ${media.ir3.channels[0][0]}`);
  console.log('  reverb: the first sample of an impulse is the IR\'s first (no latency)');
}
{
  // reverb with its impulse responses made elsewhere (createFx's ready: the live engine's worker): its last plays until
  // the new one comes, then the new one, sample for sample as a reverb that makes its own then
  const a = { type: 'reverb', size: 5, decay: 0.7, mix: 0.5 }, b = { type: 'reverb', size: 12, decay: 1.6, mix: 0.5 }, x = signal(40000, 5);
  const asked = [];
  let come = null;
  const ready = (spec, key) => { if (come) { const c = come; come = null; return c; } asked.push(key); return null; };
  const elsewhere = createFx(a, { sr, media, ready });
  come = { key: asked.at(-1), ir: reverbReady(a, sr, media) }; elsewhere.set(a);
  const here = make(a), then = make(a), T1 = 12032, T2 = 24064, out = [[], [], []];
  for (let i = 0; i < x[0].length; i += 128) {
    if (i === T1) { here.set(b); elsewhere.set(b); }
    if (i === T2) { come = { key: asked.at(-1), ir: reverbReady(b, sr, media) }; elsewhere.set(b); then.set(b); }
    [here, elsewhere, then].forEach((p, k) => { const L = x[0].slice(i, i + 128), R = x[1].slice(i, i + 128); p.process(L, R, L.length); out[k].push(...L); });
  }
  const differs = (u, v) => u.findIndex((s, i) => s !== v[i]);
  check(asked.length === 2, `reverb made elsewhere: asked ${asked.length} times, not once for each room`);
  check(differs(out[1], out[2]) < 0, `reverb made elsewhere: differs at ${differs(out[1], out[2])} from one that makes the new room when it comes`);
  check(differs(out[1], out[0]) >= T1, 'reverb made elsewhere: took the new room before it came');
  console.log('  reverb: an impulse response made elsewhere plays as one made here, from when it comes');
}

console.log('the offline wrappers (effects.js):');
{
  const x = { sr, ch: signal(24000) }, len = (s) => s.ch[0].length;
  const lens = { eq: len(effects.eq(x, [{ type: 'peak', freq: 800, gain: 4 }])), compressor: len(effects.compressor(x, { lookahead: 0.005 })), limiter: len(effects.limiter(x)),
    saturate: len(effects.saturate(x)), chorus: len(effects.chorus(x)), flanger: len(effects.flanger(x)), phaser: len(effects.phaser(x)) };
  check(Object.values(lens).every((l) => l === 24000), `lengths changed: ${JSON.stringify(lens)}`);
  const d = effects.delay(x, { time: 0.1, feedback: 0.5 });
  check(d.ch[0].length > 24000 + 0.1 * sr, `delay has no tail (${d.ch[0].length})`);
  const rv = effects.reverb(x, { size: 4, decay: 0.5 });
  check(rv.ch[0].length > 24000 + 0.4 * sr, `reverb has no tail (${rv.ch[0].length})`);
  // a moving param: a cutoff sweep, and a gain curve on the saturator's drive, both finite and not the still version
  const sweep = effects.eq(x, [{ type: 'lowpass', freq: (t) => 500 + 4000 * t, slope: 24 }]);
  check(sweep.ch[0].every(Number.isFinite) && sweep.ch[0][20000] !== effects.eq(x, [{ type: 'lowpass', freq: 500, slope: 24 }]).ch[0][20000], 'a moving cutoff does not move');
  // the sidechain ducks, grOut says by how much, makeup 'auto' matches the loudness
  const key = { sr, ch: [new Float32Array(24000).fill(0.8), new Float32Array(24000).fill(0.8)] }, g = {};
  const duck = effects.compressor(x, { threshold: -30, ratio: 10, sidechain: key, grOut: g, attack: 0.001 });
  check(g.gr.length === 24000 && g.gr[23000] < -10, `grOut ${g.gr?.[23000]}`);
  const rms = (s) => Math.sqrt(s.ch[0].reduce((q, v) => q + v * v, 0) / len(s));
  check(rms(duck) < rms(x) / 2, `sidechain did not duck (${rms(duck)} vs ${rms(x)})`);
  const auto = effects.compressor(x, { threshold: -30, ratio: 6, makeup: 'auto' });
  check(Math.abs(rms(auto) / rms(x) - 1) < 0.02, `makeup auto: ${rms(auto) / rms(x)}`);
  console.log('  lengths, tails, moving params, sidechain, grOut, makeup auto: checked');
}

console.log('time per 128-sample block (µs, mean / worst of 3000 blocks, after warm-up):');
{
  const specs = { ...Object.fromEntries(FX_TYPES.map((t) => [t, SPECS[t][0]])), 'reverb (3 s IR)': { type: 'reverb', ir: 'ir3', mix: 0.3 } };
  const [xl, xr] = signal(128);
  for (const [name, spec] of Object.entries(specs)) {
    const p = make(spec), L = new Float32Array(128), R = new Float32Array(128), total = 3000;
    let sum = 0, worst = 0;
    for (let b = -300; b < total; b++) {
      L.set(xl); R.set(xr);
      const t0 = process.hrtime.bigint();
      p.process(L, R, 128);
      const us = Number(process.hrtime.bigint() - t0) / 1000;
      if (b >= 0) { sum += us; worst = Math.max(worst, us); }
    }
    console.log(`  ${name.padEnd(16)} ${(sum / total).toFixed(1).padStart(7)} / ${worst.toFixed(0).padStart(5)}   (${(sum / total / 2666.7 * 100).toFixed(1)}% of real time)`);
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
