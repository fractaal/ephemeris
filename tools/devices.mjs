// An instrument as a device, in Node: what nle/device.js says of the Ephemeris Sampler and a plugin (Vial, the studio's
// synth, among them) alike, and what only Node can do for it — a plugin's parameters asked of its host (each value as
// the plugin writes it), a sampler's samples looked for and its zones made from sound files, an instrument checked
// before it is changed, and notes played through it to a file. The MCP's instruments, set_instrument and audition tools are made of these.
//
//   devices(dir, { query })                     the devices this machine plays, and their presets
//   describe(dir, spec, { query, limit })       { device, kind, name, params, contents, problems }
//   change(dir, spec, changes)                  { spec, sampler (its data, to save), said } or an InstrumentError
//   audition(dir, spec, notes, { grid })        { channels: [L, R], sr }: the notes (seconds from 0) through it
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deviceOf, samplerParams, pluginParams, parseValue, readNumber, textOf, toNorm, setPath } from '../nle/device.js';
import { resolveInstrument, instrumentPath } from './notes.mjs';
import { findPlugins, startInstrument, plughostPath, studioPresets, pluginPresets } from './plugins.mjs';
import { takePreset } from './presets.mjs';
import { listInstruments } from './instrument-api.mjs';
import { soundLibrary } from './workspace.mjs';
import { sources, render } from './mix.mjs';
import { pitch } from './pitch.mjs';

export class InstrumentError extends Error {}
const AUDIO = /\.(wav|flac|mp3|ogg|aif|aiff|m4a)$/i;
const slash = (p) => p.split(path.sep).join('/');
// f's path inside base, or null: by their real paths (the sound library is often a link: ~/Ephemeris/assets/Stock → ~/Stock)
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const within = (base, f) => { if (!base) return null; const b = real(base), x = real(f); return x === b || x.startsWith(b + path.sep) ? path.relative(b, x) : null; };

// ---------- the devices, and their presets
/** The devices this machine plays — the Ephemeris Sampler, and each plugin found (Vial, the studio's synth, among them) —
 *  with their presets (`query` narrows them by name): [{ device, kind, playable, why?, presets: [{ spec, name }], more }]. */
export async function devices(dir, { query = '', limit = 40 } = {}) {
  const q = query.toLowerCase(), hit = (s) => !q || String(s).toLowerCase().includes(q), cap = (list) => ({ presets: list.slice(0, limit), more: Math.max(0, list.length - limit) });
  const own = fs.existsSync(path.join(dir, 'instruments')) ? fs.readdirSync(path.join(dir, 'instruments')) : [];
  const lib = await listInstruments().catch(() => []), host = fs.existsSync(plughostPath());
  return [
    { device: 'Ephemeris Sampler', kind: 'sampler', playable: true, ...cap([
      ...own.filter((f) => /\.json$/i.test(f) && hit(f)).map((f) => ({ spec: { sampler: `instruments/${f}` }, name: f.replace(/\.json$/i, '') })),
      ...lib.filter((x) => hit(x.path)).map((x) => ({ spec: x.kind === 'sfz' ? { sfz: x.path } : { named: x.path }, name: x.name })),
    ]) },
    ...findPlugins().map((p) => ({ device: p.name, kind: 'plugin', playable: host, ...(!host && { why: `the plugin host is not built here (native/plughost/build.sh)` }),
      ...cap(pluginPresets(dir, p.name).filter((x) => hit(x.name) || hit(x.folder) || hit(x.spec?.state ?? ''))) })),
  ];
}

// ---------- describing one
// the param a name means (its key or its title, in any case), or the nearest few by their words
function find(params, name) {
  const n = String(name).toLowerCase();
  const p = params.find((x) => x.key.toLowerCase() === n || x.title.toLowerCase() === n);
  if (p) return { p };
  const words = n.split(/[^a-z0-9]+/).filter(Boolean), score = (x) => words.filter((w) => x.title.toLowerCase().includes(w) || x.key.toLowerCase().includes(w)).length;
  const near = params.map((x) => [score(x), x]).filter(([s]) => s).sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, x]) => x.title);
  return { near };
}
// a sampler's sample, as its instrument names it: the file it is, or null
const sampleAt = (dir, root, n) => { try { const f = /^library\//.test(n) ? instrumentPath(dir, n) : path.resolve(root, n); return fs.existsSync(f) ? f : null; } catch { return null; } };
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'], noteName = (n) => `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;

/** An instrument spec described, whatever plays it: { device, kind, name, params (narrowed by `query`, at most `limit`
 *  of a plugin's), count (all its params), contents (what it holds), problems (what is wrong: a param it does not have,
 *  a sample that is not there, a state the plugin would not take) }. A plugin's are asked of its host (started, then
 *  closed). */
export async function describe(dir, spec, { query = '', limit = 80 } = {}) {
  const d = deviceOf(spec), q = query.toLowerCase(), problems = [], out = { ...d, spec };
  const narrow = (ps) => (q ? ps.filter((p) => p.title.toLowerCase().includes(q) || p.key.toLowerCase().includes(q)) : ps);
  if (d.kind === 'sampler') {
    let r = null;
    try { r = await resolveInstrument(dir, spec); } catch (e) { problems.push(e.message); }
    const data = r?.sampler ?? { regions: [] }, regions = data.regions ?? [], params = samplerParams(data);
    const missing = [...new Set(regions.map((g) => g.sample).filter((n) => n && !sampleAt(dir, r.root, n)))];
    if (missing.length) problems.push(`${missing.length} sample${missing.length === 1 ? ' is' : 's are'} not there (their zones are silent): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`);
    if (r && !regions.length) problems.push('it has no zones: it plays nothing');
    const keys = new Set(); for (const g of regions) { const [a, b] = g.key ?? [0, 127]; for (let k = a; k <= b; k++) keys.add(k); }
    const lo = Math.min(...keys), hi = Math.max(...keys), gaps = [];
    for (let k = lo; k <= hi; k++) if (!keys.has(k)) gaps.push(noteName(k));
    Object.assign(out, { params: narrow(params), count: params.length, contents: {
      zones: regions.length, samples: new Set(regions.map((g) => g.sample)).size, keys: keys.size ? `${noteName(lo)}–${noteName(hi)}${gaps.length ? ` (none on ${gaps.length > 8 ? `${gaps.length} keys` : gaps.join(' ')})` : ''}` : 'none',
      velocityLayers: new Set(regions.map((g) => JSON.stringify(g.vel ?? null))).size, roundRobins: Math.max(1, ...regions.map((g) => g.rr?.length ?? 1)),
      list: regions.slice(0, 64).map((g) => ({ sample: g.sample, keys: g.key ? `${noteName(g.key[0])}–${noteName(g.key[1])}` : 'all', root: noteName(g.root ?? 60), ...(g.tune && { tune: g.tune }), ...(g.offset != null && { offset: g.offset }), ...(g.end != null && { end: g.end }), ...(g.gain && { gain: g.gain }), ...(g.loop?.mode && { loop: g.loop.mode }) })),
    } });
  } else if (d.kind === 'plugin') {
    let host = null;
    try {
      const s = await startInstrument(dir, spec);
      host = s.host;
      for (const m of s.missing) { const f = find(pluginParams(host.info), m); problems.push(`"${m}" in its set is not one of ${spec.plugin}'s parameters${f.near?.length ? ` (near: ${f.near.join(', ')})` : ''}`); }
      const params = pluginParams(host.info, spec.set), shown = narrow(params).slice(0, limit);
      // (asked of the plugin, in one go: the text of a value `set` gives over its state, each one's ends in its own
      // words, and a choice's every step)
      const asks = [];
      for (const p of shown) {
        if (p.text == null && typeof p.value === 'number') asks.push([p, 'text', p.value]);
        if (p.steps > 0 && p.steps <= 16) for (let i = 0; i <= p.steps; i++) asks.push([p, 'choice', i / p.steps]);
        else asks.push([p, 'lo', 0], [p, 'hi', 1]);
      }
      const texts = asks.length ? await host.texts(asks.map(([p, , v]) => [p.id, v])).catch(() => []) : [];
      asks.forEach(([p, what], i) => { const t = texts[i] || null; if (what === 'text') p.text = t; else if (what === 'choice') (p.choices ??= []).push(t); else p[what] = t; });
      Object.assign(out, { params: shown, count: params.length, more: Math.max(0, narrow(params).length - shown.length), contents: { state: spec.state ?? 'its default sound', vendor: host.info.vendor, latency: host.info.latency } });
    } catch (e) { problems.push(e.message); Object.assign(out, { params: [], count: 0 }); } finally { host?.close(); }
  } else if (spec?.synth || spec?.preset) {
    try { await resolveInstrument(dir, spec); } catch (e) { problems.push(e.message); }
    Object.assign(out, { params: [], count: 0 });
  } else problems.push('no instrument: give one ({ plugin }, { sampler }, { sfz }, { named })');
  out.problems = problems;
  return out;
}

// ---------- a plugin's value from words: the value whose text, as the plugin writes it, says them
async function pluginValue(host, p, x) {
  if (typeof x === 'number') return x >= 0 && x <= 1 ? { norm: x } : { error: `${p.title} takes 0–1 as a number, or its value in words as the plugin writes them ("${p.text}")` };
  const want = String(x).trim();
  if (p.steps > 0) {   // (a choice: each step's words)
    const texts = await host.texts(Array.from({ length: p.steps + 1 }, (_, i) => [p.id, i / p.steps]));
    const i = texts.findIndex((t) => t.toLowerCase() === want.toLowerCase());
    if (i >= 0) return { norm: i / p.steps, text: texts[i] };
    const r = readNumber(want), j = r ? texts.findIndex((t) => readNumber(t)?.n === r.n) : -1;
    return j >= 0 ? { norm: j / p.steps, text: texts[j] } : { error: `${p.title} is one of ${texts.join(', ')}` };
  }
  const r = readNumber(want), [a, b] = (await host.texts([[p.id, 0], [p.id, 1]])).map(readNumber);
  if (!r || r.unknown || !a || !b) {
    const [v] = await host.parse([[p.id, want]]);
    return v != null ? { norm: v } : { error: `${p.title} reads as "${p.text}" (the plugin's words): give it so, or 0–1` };
  }
  if ((r.unit ?? a.unit) !== (a.unit ?? r.unit)) return { error: `${p.title} reads in ${a.unit} (${textOf({ unit: a.unit }, a.n * a.factor)} to ${textOf({ unit: b.unit }, b.n * b.factor)}), not ${r.unit}` };
  const v = r.n * r.factor, va = a.n * a.factor, vb = b.n * b.factor, up = vb > va;
  if (v < Math.min(va, vb) - 1e-9 || v > Math.max(va, vb) + 1e-9) return { error: `${p.title} runs from ${await host.texts([[p.id, up ? 0 : 1]]).then((t) => t[0])} to ${await host.texts([[p.id, up ? 1 : 0]]).then((t) => t[0])}` };
  // (its words, read back as numbers, rise or fall with its value: halved towards the one that says `v`)
  let lo = 0, hi = 1;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2, [t] = await host.texts([[p.id, mid]]), m = readNumber(t), at = m ? m.n * m.factor : NaN;
    if (!Number.isFinite(at)) break;
    if ((at < v) === up) lo = mid; else hi = mid;
  }
  const norm = (lo + hi) / 2, [text] = await host.texts([[p.id, norm]]);
  return { norm, text };
}

// ---------- changing one
// a sound file as a sampler names it: in the sound library (library/…), in the project (from instruments/), or copied in
function sampleRef(dir, file) {
  const f = path.resolve(file), lib = within(soundLibrary(), f);
  if (lib != null) return slash(path.join('library', lib));
  if (within(dir, f) != null) return slash(path.relative(path.join(real(dir), 'instruments'), real(f)));
  const hash = crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 8), name = `${path.basename(f).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 48)}-${hash}${path.extname(f)}`;
  const to = path.join(dir, 'instruments', 'samples', name);
  if (!fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(f, to); }
  return `samples/${name}`;
}
const keyOf = (k) => { if (typeof k === 'number') return k; const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(k)); if (!m) return null; return 12 * (+m[3] + 1) + { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0); };
/** A zone from a sound file: { file (anywhere: copied into the project unless the project or the sound library has it),
 *  key (a note, or [lo, hi]: where it plays; its root alone if left out), root and tune (left out: what pitch measures of
 *  it, the note it holds longest), offset, end (s: a slice of it), and any region field (gain, pan, loop, vel, rr, group,
 *  offBy…) }. */
async function zoneOf(dir, z) {
  const { file, key, root, tune, ...rest } = z;
  if (!file || !fs.existsSync(path.resolve(dir, String(file).replace(/^~(?=\/)/, process.env.HOME)))) throw new InstrumentError(`no such sound file: ${file}`);
  const abs = path.resolve(dir, String(file).replace(/^~(?=\/)/, process.env.HOME));
  if (!AUDIO.test(abs)) throw new InstrumentError(`${file} is not a sound file`);
  let r = keyOf(root), t = tune;
  if (r == null) {
    const found = (await pitch(abs, { from: z.offset ?? 0, to: z.end ?? Infinity })).notes.filter((n) => n.cents != null).sort((x, y) => y.dur - x.dur)[0];
    if (!found && !key && !rest.loop) throw new InstrumentError(`${path.basename(abs)}: no note holds a pitch in it; give its root, or a key for it (a drum: loop { mode: 'oneshot' })`);
    if (found) { r = found.note; t ??= -found.cents; }
  }
  const k = Array.isArray(key) ? key.map(keyOf) : key != null ? [keyOf(key), keyOf(key)] : r != null ? [r, r] : null;
  if (k?.some((x) => x == null)) throw new InstrumentError(`${file}: its key is a note (C4, F#3) or a MIDI number, or [lo, hi]`);
  // (no pitch in it, as a drum: it plays as recorded on its key, the lowest of a range; not two octaves from the C4 a root defaults to)
  if (r == null && k) r = k[0];
  return { sample: sampleRef(dir, abs), ...(k && { key: k }), ...(r != null && { root: r }), ...(t && { tune: Math.round(t) }), ...rest };
}

/**
 * An instrument spec changed, checked against its device first (nothing is changed if anything is wrong: an
 * InstrumentError says all of it). changes: { device (another: 'Ephemeris Sampler', or a plugin's name: Vial, the studio's
 * synth), preset (a sampler's file or library instrument; a plugin's state: a file, or the name of one of the studio's
 * presets for it, assets/presets/<plugin>/), set ({ <param key or title>:
 * value, in its units or its words }), zones (a sampler's, from sound files: zoneOf; replacing its zones), add_zones
 * (added to them) }. → { spec, sampler (its data where it changed: saved as a file by the caller, which names it in
 * spec.sampler), said: [what changed, in words] }.
 */
export async function change(dir, spec, { device, preset, set = {}, zones, add_zones: addZones } = {}) {
  let next = structuredClone(spec ?? {}), data = null;
  const said = [], errors = [];
  // the device, and what it starts from
  if (device || preset) {
    const want = device ?? deviceOf(next).device, plugin = findPlugins().find((p) => p.name.toLowerCase() === String(want).toLowerCase());
    if (/^ephemeris synth$/i.test(want)) throw new InstrumentError(`the Ephemeris Synth is gone: Vial is the studio's synth (device "Vial", preset: ${studioPresets('Vial').map((x) => `"${x.name}"`).join(', ') || 'its state files'})`);
    if (/^ephemeris sampler$/i.test(want)) {
      if (preset) {
        const f = (() => { try { return instrumentPath(dir, preset); } catch { return null; } })();
        if (!f || !fs.existsSync(f)) throw new InstrumentError(`no sampler instrument "${preset}" (a saved instrument .json, an .sfz, or a folder of samples named by note: the project's, or library/…)`);
        next = /\.sfz$/i.test(f) ? { sfz: preset } : fs.statSync(f).isDirectory() ? { named: preset } : { sampler: preset };
      } else if (!(next.sampler || next.sfz || next.named)) { next = {}; data = { kind: 'sampler', name: 'sampler', env: { r: 0.05 }, regions: [] }; }
    } else if (plugin) {
      if (!fs.existsSync(plughostPath())) throw new InstrumentError(`${plugin.name} needs the plugin host, which is not built here (native/plughost/build.sh)`);
      // (a preset by its name in the preset folders: one of a folder of this machine's copied into the project; or a
      // state file)
      const presets = pluginPresets(dir, plugin.name), want = String(preset ?? '').toLowerCase().replace(/[-_]+/g, ' ').replace(/\.[a-z]+$/, '');
      const named = preset && presets.find((x) => x.name.toLowerCase() === want);
      const state = named ? named.state ?? takePreset(dir, named.take) : preset;
      if (state && !named) { try { if (!fs.existsSync(instrumentPath(dir, state))) throw new Error(); } catch { throw new InstrumentError(`no preset "${preset}" for ${plugin.name}: ${presets.slice(0, 24).map((x) => `"${x.name}"`).join(', ') || 'none in the preset folders'}${presets.length > 24 ? ` (+${presets.length - 24}: instruments lists them)` : ''}, or a state file (the project's, or library/…)`); } }
      next = { plugin: plugin.name, ...(state ? { state } : next.plugin === plugin.name && next.state ? { state: next.state } : {}), ...(next.plugin === plugin.name && next.set ? { set: next.set } : {}) };
    } else throw new InstrumentError(`no device "${want}": the Ephemeris Sampler, or a plugin (${findPlugins().map((p) => p.name).join(', ') || 'none found'})`);
    said.push(`${deviceOf(next).device}${preset ? ` from ${preset}` : ''}`);
  }
  const kind = deviceOf(next).kind;
  // its params
  if (kind === 'sampler' && (Object.keys(set).length || zones || addZones)) {
    if (!data) {
      let r;
      try { r = await resolveInstrument(dir, next); } catch (e) { throw new InstrumentError(e.message); }
      // (its samples named from where it will be saved, instruments/: a library instrument's from its own folder until now)
      data = structuredClone(r.sampler);
      for (const g of data.regions ?? []) if (g.sample && !/^library\//.test(g.sample)) { const f = path.resolve(r.root, g.sample); const lib = within(soundLibrary(), f); g.sample = lib != null ? slash(path.join('library', lib)) : slash(path.relative(path.join(real(dir), 'instruments'), real(f))); }
    }
    for (const [name, x] of Object.entries(set)) {
      const f = find(samplerParams(data), name);
      if (!f.p) { errors.push(`the sampler has no "${name}" (its own: ${samplerParams(data).map((p) => p.title).join(', ')}; a zone's are set in its zones)`); continue; }
      const v = parseValue(f.p, x);
      if (v.error) { errors.push(v.error); continue; }
      data = setPath(data, f.p.key, v.value); said.push(`${f.p.title} ${textOf(f.p, v.value)}`);
    }
    if (zones || addZones) {
      const made = [];
      for (const z of [...(zones ?? []), ...(addZones ?? [])]) { try { made.push(await zoneOf(dir, z)); } catch (e) { errors.push(e.message); } }
      // (a zone from a file elsewhere, made relative to where the instrument will be: instruments/)
      data.regions = zones ? made : [...(data.regions ?? []), ...made];
      said.push(`${made.length} zone${made.length === 1 ? '' : 's'} ${zones ? 'in place of its zones' : 'added'}`);
    }
  } else if (kind === 'plugin' && Object.keys(set).length) {
    let host;
    try {
      host = (await startInstrument(dir, next)).host;
      const params = pluginParams(host.info, next.set), out = { ...(next.set ?? {}) };
      for (const [name, x] of Object.entries(set)) {
        const f = find(params, name);
        if (!f.p) { errors.push(`${next.plugin} has no "${name}"${f.near?.length ? ` (near: ${f.near.join(', ')})` : ''}`); continue; }
        if (x === null) { delete out[f.p.title]; said.push(`${f.p.title} as its state has it`); continue; }
        const v = await pluginValue(host, f.p, x);
        if (v.error) { errors.push(v.error); continue; }
        out[f.p.title] = Math.round(v.norm * 1e6) / 1e6; said.push(`${f.p.title} ${v.text ?? (await host.texts([[f.p.id, v.norm]]))[0] ?? v.norm.toFixed(3)}`);
      }
      next = { ...next, set: out };
    } catch (e) { if (e instanceof InstrumentError) throw e; errors.push(e.message); } finally { host?.close(); }
  } else if (Object.keys(set).length || zones || addZones) errors.push(`${zones || addZones ? 'zones are a sampler\'s' : 'there is no instrument to set'}: ${kind === 'none' ? 'give a device' : `this is ${deviceOf(next).device}`}`);
  if (errors.length) throw new InstrumentError(`${errors.join('; ')}. Nothing was changed.`);
  return { spec: next, sampler: data, said };
}

// ---------- automating one
/**
 * Automation for an instrument (its spec, as change() left it), from points in its params' own words: automate: {
 * <param key or title>: [[at, value, ease?], …] (at: seconds, or what `at` makes of words: a bar.beat; value in the
 * param's units or words, or 0–1 for a plugin's; ease: lin, glide (the default), step…), or null (its automation taken
 * away) } → { [key]: { lanes } | null } as a track keeps it (nle/automation.js), and said: what in words. Checked first: an
 * InstrumentError says what is wrong, and nothing is made.
 */
export async function lanesOf(dir, spec, automate, at = (x) => x) {
  const kind = deviceOf(spec).kind, out = {}, said = [], errors = [];
  let host = null, params;
  try {
    if (kind === 'plugin') { host = (await startInstrument(dir, spec)).host; params = pluginParams(host.info, spec.set); }
    else params = samplerParams((await resolveInstrument(dir, spec).catch(() => null))?.sampler ?? {});
    for (const [name, points] of Object.entries(automate ?? {})) {
      const f = find(params, name);
      if (!f.p) { errors.push(`${deviceOf(spec).device} has no "${name}"${f.near?.length ? ` (near: ${f.near.join(', ')})` : ''}`); continue; }
      if (!f.p.automatable) { errors.push(`${f.p.title} cannot be automated`); continue; }
      if (points === null) { out[f.p.key] = null; said.push(`${f.p.title}: its automation taken away`); continue; }
      if (!Array.isArray(points) || !points.length) { errors.push(`${f.p.title}: its points are [[at, value, ease?], …]`); continue; }
      const keys = [];
      for (const pt of points) {
        const [when, x, ease] = Array.isArray(pt) ? pt : [pt?.at, pt?.value, pt?.ease], t = at(when);
        if (!Number.isFinite(t)) { errors.push(`${f.p.title}: "${when}" is not a time (seconds, or bar.beat)`); continue; }
        const v = kind === 'plugin' ? await pluginValue(host, f.p, x) : (() => { const r = parseValue(f.p, x); return r.error ? r : { norm: toNorm(f.p, r.value) }; })();
        if (v.error) { errors.push(v.error); continue; }
        keys.push([Math.round(t * 1e6) / 1e6, Math.round(v.norm * 1e5) / 1e5, ...(ease ? [ease] : [])]);
      }
      keys.sort((a, b) => a[0] - b[0]);
      out[f.p.key] = { lanes: [{ id: `k${crypto.randomBytes(3).toString('hex')}`, kind: 'keys', mode: 'aim', keys }] };
      said.push(`${f.p.title}: ${keys.length} key${keys.length === 1 ? '' : 's'}`);
    }
  } finally { host?.close(); }
  if (errors.length) throw new InstrumentError(`${errors.join('; ')}. Nothing was changed.`);
  return { lanes: out, said };
}

// ---------- hearing one
/** Notes ([{ t, dur, note, vel }], seconds from 0) played through an instrument spec, as a render plays them (the
 *  project's media and instruments are dir's; a plugin's host plays its; grid: the tempo a plugin's synced LFOs follow). */
export async function audition(dir, spec, notes, { grid } = {}) {
  const len = Math.max(0.5, ...notes.map((n) => n.t + n.dur)) + 0.25;
  const tl = { grid, media: { a: { kind: 'audio', notes } }, tracks: [{ id: 'a', name: 'audition', instrument: spec, clips: [{ id: 'c', media: 'a', at: 0, in: 0, out: len }] }] };
  const src = await sources(tl, dir);
  return { channels: render(tl, src), sr: src.sr };
}
