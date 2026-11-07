// An instrument as a device: whatever plays a notes medium — the Ephemeris Sampler or a plugin (a VST3 played by its host,
// tools/plugins.mjs; Vial, the studio's synth, among them) — described the same way, so that the Instrument panel, the
// lanes, renders and agents (the MCP's instruments tools) treat them alike. Shared by the editor and Node: no DOM, no
// Node APIs.
//
// A device's parameters, each { key (what the automation on its track names it by: the path in a sampler's data, a
// plugin's title), title, group, value (in its units, or a choice), min, max, unit, curve ('log'),
// options (a choice's), step, steps (a plugin's: 0 continuous), text (its value as the device writes it), live (it
// moves the notes sounding when it changes; else from the next note), automatable }. Automation is kept on the track
// whose instrument it is ({ instrument, automation: { instrument: { <key>: { lanes } } } }: automation.js) in 0–1 of each parameter's range, for every
// device; a native instrument's is played by control() (engine/sound/instrument.js), a plugin's by its host.
import { getPath, setPath } from '../engine/sound/instrument.js';

const base = (p) => String(p).split('/').pop().replace(/\.[^.]+$/, '');
/** What plays an instrument spec: { kind: 'sampler' | 'plugin' | 'none', device, name } (none: no instrument, or the
 *  Ephemeris Synth's, which is gone: Vial plays synth sounds). */
export function deviceOf(inst) {
  if (!inst) return { kind: 'none', device: null, name: 'no instrument' };
  if (inst.plugin) return { kind: 'plugin', device: inst.plugin, name: !inst.state ? inst.plugin : /\.state$/.test(inst.state) ? `${inst.plugin} · your sound` : base(inst.state).replace(/[-_]+/g, ' ') };
  if (inst.synth || inst.preset) return { kind: 'none', device: null, name: 'the Ephemeris Synth, gone (Vial plays synth sounds)' };
  return { kind: 'sampler', device: 'Ephemeris Sampler', name: base(inst.sfz ?? inst.sampler ?? inst.named ?? 'sampler') };
}

export { getPath, setPath };
const tokens = (path) => path.match(/[^.[\]]+/g).map((t) => (/^\d+$/.test(t) ? +t : t));
// a param's title, from its path: 'gain' → 'Level', 'env.a' → 'Amp Attack'
const WORD = { gain: 'Level', pan: 'Pan', tune: 'Tune', velTrack: 'Velocity', a: 'Attack', h: 'Hold', d: 'Decay', s: 'Sustain', r: 'Release' };
export function titleOf(path) {
  const t = tokens(path), last = t[t.length - 1];
  return [...(t.length > 1 && t[0] === 'env' ? ['Amp'] : []), WORD[last] ?? last].join(' ');
}

// ---------- the Ephemeris Sampler: its own params (its zones are what it holds: zonesOf)
const SAMPLER_PARAMS = [
  { path: 'gain', value: 0, min: -60, max: 12, unit: 'dB', step: 0.1, live: true },
  { path: 'pan', value: 0, min: -1, max: 1, step: 0.01, live: true },
  { path: 'tune', value: 0, min: -2400, max: 2400, unit: 'ct', step: 1, live: true },
  { path: 'env.a', value: 0, min: 0.0005, max: 10, unit: 's', curve: 'log', live: false },
  { path: 'env.h', value: 0, min: 0, max: 10, unit: 's', live: false },
  { path: 'env.d', value: 0, min: 0, max: 10, unit: 's', live: false },
  { path: 'env.s', value: 1, min: 0, max: 1, step: 0.01, live: false },
  { path: 'env.r', value: 0, min: 0.003, max: 10, unit: 's', curve: 'log', live: false },
  { path: 'velTrack', value: 1, min: 0, max: 1, step: 0.01, live: false },
];
/** The sampler's params, valued from its data (an instrument's JSON: engine/sound/sampler.js). */
export function samplerParams(data = {}) {
  return SAMPLER_PARAMS.map((spec) => describe({ key: spec.path, title: titleOf(spec.path), group: spec.path.startsWith('env') ? 'Amp envelope' : 'Output', value: getPath(data, spec.path) ?? spec.value, spec, live: spec.live }));
}

/** A native instrument's params: a sampler's from its data (resolved: the sampler's JSON, where it is known); a plugin's
 *  come from its host (pluginParams). */
export function paramsOf(spec, { sampler } = {}) {
  if (spec && !spec.plugin && !spec.synth && !spec.preset) return samplerParams(sampler ?? {});
  return [];
}

// ---------- a plugin: its parameters as its host reports them (each 0–1, with its own text)
/** A plugin's params from its host's info ({ params: [{ id, title, units, steps, value, text, automatable }] }), its
 *  instrument's `set` over them. */
export function pluginParams(info, set = {}) {
  return (info?.params ?? []).map((p) => ({ key: p.title, title: p.title, group: null, id: p.id, value: set[p.title] ?? p.value, min: 0, max: 1,
    unit: p.units || '', steps: p.steps, text: set[p.title] != null && set[p.title] !== p.value ? null : p.text || null, live: true, automatable: !!p.automatable, norm: set[p.title] ?? p.value }));
}

// a native param described: its range, unit and curve from its spec, its value's 0–1 and text
function describe({ key, title, group, value, spec, live }) {
  const p = { key, title, group, value, live, automatable: (spec.min != null || spec.options || spec.bool) && !spec.text };
  if (spec.options) p.options = spec.options;
  else if (spec.bool) p.options = [false, true];
  else Object.assign(p, { min: spec.min, max: spec.max, ...(spec.unit && { unit: spec.unit }), ...(spec.curve && { curve: spec.curve }), ...(spec.step && { step: spec.step }) });
  if (spec.off !== undefined) p.off = spec.off;
  p.norm = value == null ? null : toNorm(p, value);
  p.text = textOf(p, value);
  return p;
}

// ---------- values: a param's own ↔ 0–1 (what lanes hold) ↔ text
/** A value in 0–1 of the param's range (a choice's index over its last; a log range in ratios). */
export function toNorm(p, v) {
  if (p.options) return p.options.length > 1 ? Math.max(0, p.options.indexOf(v)) / (p.options.length - 1) : 0;
  if (p.min == null) return v;   // (a plugin's: already 0–1)
  const x = p.curve === 'log' && p.min > 0 ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min);
  return Math.min(1, Math.max(0, x));
}
/** The param's own value at n (0–1). */
export function fromNorm(p, n) {
  const x = Math.min(1, Math.max(0, n));
  if (p.options) return p.options[Math.round(x * (p.options.length - 1))];
  if (p.min == null) return x;
  const v = p.curve === 'log' && p.min > 0 ? p.min * (p.max / p.min) ** x : p.min + x * (p.max - p.min);
  return p.step ? Math.round(v / p.step) * p.step : v;
}
const trim = (v) => String(+(+v).toPrecision(4));
/** A native param's value as words: '800 Hz', 'saw', 'on'. */
export function textOf(p, v) {
  if (v == null) return p.off !== undefined ? 'off' : null;
  if (p.options) return typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v);
  if (p.unit === 'Hz' && v >= 1000) return `${trim(v / 1000)} kHz`;
  if (p.unit === 's' && v < 1) return `${trim(v * 1000)} ms`;
  return `${trim(v)}${p.unit ? ` ${p.unit}` : ''}`;
}
// units as a value's words say them, to the param's: a factor, by the unit each family is kept in
const UNITS = { hz: ['Hz', 1], khz: ['Hz', 1000], s: ['s', 1], sec: ['s', 1], secs: ['s', 1], ms: ['s', 0.001], db: ['dB', 1], ct: ['ct', 1], cents: ['ct', 1], st: ['st', 1], semitones: ['st', 1], oct: ['oct', 1], m: ['m', 1], metres: ['m', 1], meters: ['m', 1], '%': ['%', 1], x: ['x', 1], bpm: ['bpm', 1], beats: ['beats', 1] };
/** A number and its unit from words ('800 Hz', '-6dB', '0.1 s', '12'): { n, unit (the family's, or null), factor }, or null. */
export function readNumber(text) {
  const m = /^\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(String(text));
  if (!m) return null;
  const u = m[2] ? UNITS[m[2].toLowerCase()] : null;
  if (m[2] && !u) return { n: +m[1], unit: m[2], factor: 1, unknown: true };
  return { n: +m[1], unit: u?.[0] ?? null, factor: u?.[1] ?? 1 };
}
/** A native param's own value from words or a number ('800 Hz', '1.2 kHz', 'saw', true): { value } or { error }. */
export function parseValue(p, x) {
  if (p.options) {
    const hit = p.options.find((o) => String(o).toLowerCase() === String(x).toLowerCase() || (typeof o === 'boolean' && ['on', 'off'].includes(String(x).toLowerCase()) && o === (String(x).toLowerCase() === 'on')));
    return hit !== undefined ? { value: hit } : { error: `${p.title} is one of ${p.options.join(', ')}` };
  }
  if (x === null && p.off !== undefined) return { value: null };
  const r = typeof x === 'number' ? { n: x, unit: null, factor: 1 } : readNumber(x);
  if (!r) return { error: `${p.title} is a number${p.unit ? ` in ${p.unit}` : ''} (${textOf(p, p.min)} to ${textOf(p, p.max)})` };
  if (r.unknown) return { error: `${p.title} is in ${p.unit || 'no unit'}: "${r.unit}" is not a unit read here` };
  if ((r.unit && p.unit && r.unit !== p.unit) || (r.unit && !p.unit)) return { error: `${p.title} is in ${p.unit || 'no unit'}, not ${r.unit}` };
  const v = r.n * r.factor;
  if (v < p.min - 1e-9 || v > p.max + 1e-9) return { error: `${p.title} runs from ${textOf(p, p.min)} to ${textOf(p, p.max)}: ${textOf(p, v)} is outside it` };
  return { value: v };
}
