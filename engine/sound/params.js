// The effects' options: every effect's params for UIs and for the defaults (effects.js re-exports them). Kept apart so that
// fx.js (the live processors) and effects.js (the offline wrappers over them) can each read them without importing
// one another before either has loaded.

const P = (value, min, max, extra = {}) => ({ value, min, max, ...extra });
const B = (value) => ({ value, options: [true, false] });
const MIX = P(0.5, 0, 1, { step: 0.01, unit: '%' });
const ROOM = {
  size: P(10, 1, 100, { step: 0.5, unit: 'm', curve: 'log' }), // mean room dimension: ~3 small room, ~20 hall, ~80 huge
  decay: P(0.95, 0.1, 15, { step: 0.05, unit: 's', curve: 'log' }), // RT60; when left out it follows size (0.25 + 0.07·size; 0.95 at size 10)
  damping: P(0.5, 0, 1, { step: 0.01 }), predelay: P(0.01, 0, 0.2, { step: 0.001, unit: 's' }),
  width: P(1, 0, 1, { step: 0.01 }), early: P(0.5, 0, 1, { step: 0.01 }), seed: P(1, 0, 9999, { step: 1 }),
};
/**
 * Every effect's options as { name: { value (the default the function uses), min, max, step?, unit?, options?, curve? } }.
 * `unit` is 'dB' | 'Hz' | 's' | 'm' | '%' | 'x' | 'st'; `options` lists an enum's (or a switch's) choices; curve 'log'
 * means a slider should move in ratios (frequencies, times). The functions read their defaults from here. Options that
 * are not listed (a sound passed in: sidechain, ir; a delay time as { bpm, division }; makeup 'auto') are in each doc.
 */
export const PARAMS = {
  eq: { // one band; eq takes an array of them
    type: { value: 'peak', options: ['lowpass', 'highpass', 'lowshelf', 'highshelf', 'peak', 'notch', 'bandpass'] },
    freq: P(1000, 20, 20000, { unit: 'Hz', curve: 'log' }), gain: P(0, -24, 24, { step: 0.1, unit: 'dB' }),
    q: P(0.70710678, 0.1, 18, { step: 0.01, curve: 'log' }), slope: { value: 12, options: [12, 24], unit: 'dB' },
  },
  compressor: {
    threshold: P(-18, -60, 0, { step: 0.1, unit: 'dB' }), ratio: P(4, 1, 20, { step: 0.1, unit: 'x' }),
    knee: P(6, 0, 24, { step: 0.1, unit: 'dB' }), attack: P(0.01, 0.0001, 0.5, { unit: 's', curve: 'log' }),
    release: P(0.1, 0.005, 2, { unit: 's', curve: 'log' }), makeup: P(0, 0, 24, { step: 0.1, unit: 'dB' }),
    detect: { value: 'rms', options: ['rms', 'peak'] }, lookahead: P(0, 0, 0.02, { step: 0.001, unit: 's' }), mix: P(1, 0, 1, { step: 0.01, unit: '%' }),
  },
  limiter: {
    ceiling: P(-1, -12, 0, { step: 0.1, unit: 'dB' }), lookahead: P(0.005, 0.001, 0.02, { step: 0.001, unit: 's' }),
    release: P(0.1, 0.01, 1, { unit: 's', curve: 'log' }), gain: P(0, 0, 24, { step: 0.1, unit: 'dB' }), truePeak: B(true),
  },
  saturate: {
    drive: P(12, 0, 48, { step: 0.1, unit: 'dB' }), curve: { value: 'soft', options: ['soft', 'tape', 'hard'] },
    mix: P(1, 0, 1, { step: 0.01, unit: '%' }), compensate: B(true), oversample: { value: 4, options: [1, 2, 4, 8] },
  },
  delay: {
    time: P(0.25, 0.01, 2, { step: 0.001, unit: 's', curve: 'log' }), feedback: P(0.4, 0, 0.95, { step: 0.01 }), pingPong: B(false),
    lowpass: P(0, 0, 20000, { unit: 'Hz', curve: 'log' }), highpass: P(0, 0, 2000, { unit: 'Hz', curve: 'log' }), // 0 is off
    mix: P(0.3, 0, 1, { step: 0.01, unit: '%' }), tail: P(10, 0, 20, { step: 0.1, unit: 's' }),
  },
  chorus: {
    rate: P(0.8, 0.05, 8, { unit: 'Hz', curve: 'log' }), depth: P(0.003, 0, 0.01, { step: 0.0001, unit: 's' }),
    base: P(0.015, 0.005, 0.04, { step: 0.0005, unit: 's' }), voices: P(3, 1, 6, { step: 1 }), mix: MIX, spread: P(0.25, 0, 0.5, { step: 0.01 }),
  },
  flanger: {
    rate: P(0.25, 0.02, 5, { unit: 'Hz', curve: 'log' }), depth: P(0.002, 0, 0.005, { step: 0.0001, unit: 's' }),
    base: P(0.003, 0.0005, 0.01, { step: 0.0001, unit: 's' }), feedback: P(0.5, -0.95, 0.95, { step: 0.01 }), mix: MIX, spread: P(0.25, 0, 0.5, { step: 0.01 }),
  },
  phaser: {
    rate: P(0.4, 0.02, 5, { unit: 'Hz', curve: 'log' }), stages: P(4, 2, 12, { step: 2 }),
    min: P(300, 50, 2000, { unit: 'Hz', curve: 'log' }), max: P(3000, 500, 12000, { unit: 'Hz', curve: 'log' }),
    feedback: P(0.3, -0.95, 0.95, { step: 0.01 }), mix: MIX, spread: P(0.25, 0, 0.5, { step: 0.01 }),
  },
  roomIR: ROOM,
  reverb: { ...ROOM, mix: P(0.3, 0, 1, { step: 0.01, unit: '%' }), normalize: B(true) }, // predelay: with an `ir`, 0 unless given
};
/** The defaults in a PARAMS entry, overridden by the options given (undefined ones count as not given). */
export function withDefaults(spec, o = {}) {
  const r = {};
  for (const [k, v] of Object.entries(spec)) r[k] = v.value;
  for (const [k, v] of Object.entries(o ?? {})) if (v !== undefined) r[k] = v;
  return r;
}
