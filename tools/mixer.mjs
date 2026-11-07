// The mixer, for agents: the timeline's mixer read as text and changed by name, as the Mixer panel shows and changes it —
// a strip for each audio track (A1, A2… as the editor numbers them), each bus and the master; each strip's volume, pan,
// mute and solo, its effects in order with their params in their own units, and its sends. A change is checked whole
// before anything changes (an effect's param it does not have, a value past what its knob reaches, a bus that is not
// there) and said as the panel says its edits. The MCP's mixer tool is made of these; the editor lights what changed.
//
//   describe(doc)            the strips, as text
//   change(doc, changes)     { doc (a changed copy), said: [each change, in words] }, or a MixerError
import { PARAMS } from '../engine/sound/params.js';
import { isVisual, isNotes, FX, newFx } from '../nle/model.js';
import { parseValue, textOf } from '../nle/device.js';

export class MixerError extends Error {}
const fail = (s) => { throw new MixerError(s); };
// the strips' own controls, with the ranges of their knobs and faders (mixer.js)
const VOLUME = { title: 'volume', min: -60, max: 6, unit: 'dB' };
const PAN = { title: 'pan', min: -1, max: 1 };
const SEND = { title: 'a send', min: -40, max: 6, unit: 'dB' };
const DIVISIONS = /^1\/(1|2|4|8|16|32)[dt]?$/;   // (a delay's time in beats: engine/sound/fx.js delayTime)
const db1 = (v) => `${(v || 0).toFixed(1)} dB`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- the strips, and naming them
/** Every strip: { id (a track's id, bus:<id>, master), kind, num (a track's A-number), name, o (what holds its settings) }. */
export function stripsOf(doc) {
  return [
    ...doc.tracks.filter((t) => !isVisual(t)).map((t, i) => ({ id: t.id, kind: 'track', num: `A${i + 1}`, name: t.name ?? t.id, o: t })),
    ...(doc.buses ?? []).map((b) => ({ id: `bus:${b.id}`, kind: 'bus', name: b.name ?? b.id, o: b })),
    { id: 'master', kind: 'master', name: 'Master', o: doc.master ?? {} },
  ];
}
const label = (s) => (s.kind === 'master' ? 'Master' : s.kind === 'bus' ? `bus "${s.name}"` : `"${s.name}"`);
const listed = (ss) => ss.map((s) => (s.kind === 'track' ? `${s.num} "${s.name}"` : label(s))).join(', ');
/** The strip `name` names: a track's A-number, id or name, a bus's id or name ("bus Reverb" too), or master. */
function stripNamed(doc, name) {
  const all = stripsOf(doc), s = String(name).trim(), lc = s.toLowerCase(), bare = lc.replace(/^bus[:\s]\s*/, '');
  const by = (f) => all.filter(f);
  for (const hits of [by((x) => x.id === s), by((x) => x.num?.toLowerCase() === lc || (lc === 'master' && x.kind === 'master')),
    by((x) => x.kind === 'bus' && (x.id.slice(4) === s || x.id.slice(4).toLowerCase() === bare)), by((x) => x.name.toLowerCase() === lc || (x.kind === 'bus' && x.name.toLowerCase() === bare))]) {
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) fail(`"${name}" names ${hits.length} strips (${listed(hits)}): name one by its A-number or id.`);
  }
  return fail(`No strip "${name}". The strips: ${listed(all)}.`);
}
const busNamed = (doc, name) => { const s = stripNamed(doc, /^bus[:\s]/i.test(name) ? name : `bus ${name}`); return s.kind === 'bus' ? s : fail(`"${name}" is not a bus.`); };

// ---------- values, in their own units ('-6 dB', '120 ms', '2.5 kHz', '30%', 'on'), checked against their range
// a bare number is in the param's own unit (seconds, not the ms its value is shown in); words say theirs ("5 ms")
const BARE = { s: 'seconds; write "5 ms" for milliseconds', Hz: 'Hz; write "2.5 kHz" for kilohertz', '%': '0–1; write "30%" for a percentage', dB: 'dB', m: 'metres', x: 'times', st: 'semitones' };
function valueOf(p, x) {
  const unit = p.unit;
  if (p.unit === '%') { if (typeof x === 'string' && /%\s*$/.test(x)) x = parseFloat(x) / 100; p = { ...p, unit: undefined }; }   // (kept 0–1)
  const r = parseValue(p, x);
  return r.error ? fail(`${r.error}${typeof x === 'number' && BARE[unit] ? ` (a bare number is in ${BARE[unit]})` : ''}.`) : r.value;
}
const words = (d, v) => (v == null ? 'none' : typeof v === 'object' ? JSON.stringify(v) : d?.unit === '%' ? `${Math.round(v * 100)}%` : d ? textOf(d, v) : String(v));
const paramsOf = (type) => Object.entries(PARAMS[type]).filter(([, d]) => typeof d.value !== 'object');
const EXTRA = { reverb: ['ir'], compressor: ['sidechain'], eq: ['bands', 'band <n>'] };

// one band of an EQ: its type, freq, gain, q and slope
function band(b, set, where) {
  for (const [k, x] of Object.entries(set ?? {})) {
    const d = PARAMS.eq[k];
    if (!d) fail(`${where}: a band has ${Object.keys(PARAMS.eq).join(', ')}, not "${k}".`);
    b[k] = valueOf({ title: `${where} ${k}`, ...d }, x);
  }
  return b;
}
// params on an effect (its type's, as its knobs reach them; and what it takes besides: a reverb's impulse response, a
// compressor's sidechain and auto makeup, a delay's time in beats), each said as the panel says it
function setFx(d, fx, set, where, said) {
  const type = fx.type, at = `${type} on ${where}`;
  for (const [k, x] of Object.entries(set)) {
    if (k === 'type') { if (x !== type) fail(`${at}: an effect's type does not change (take it out and add a ${x}).`); continue; }
    if (k === 'on') {
      const on = valueOf({ title: `${at} on`, options: [true, false] }, x);
      if (on !== (fx.on !== false)) said.push(`${on ? 'use' : 'bypass'} ${at}`);
      if (on) delete fx.on; else fx.on = false;
      continue;
    }
    let v;
    if (type === 'reverb' && k === 'ir') {
      v = x == null || x === 'room' ? undefined : String(x);
      if (v && (!d.media?.[v] || isNotes(d.media[v]) || (d.media[v].kind && d.media[v].kind !== 'audio'))) fail(`${at}: its impulse response is an audio medium of the timeline's, or "room" (the room its knobs make); "${x}" is not one.`);
    } else if (type === 'compressor' && k === 'sidechain') {
      v = x == null || x === 'none' ? undefined : stripNamed(d, x);
      if (v && v.kind !== 'track') fail(`${at}: a sidechain is a track, not ${label(v)}.`);
      v = v?.id;
    } else if (type === 'compressor' && k === 'makeup' && x === 'auto') v = 'auto';
    else if (type === 'delay' && k === 'time' && x && typeof x === 'object') {
      if (!(x.bpm > 0) || !(typeof x.division === 'number' ? x.division > 0 : DIVISIONS.test(String(x.division ?? '1/4')))) fail(`${at}: a time in beats is { bpm, division: "1/8" (d dotted, t triplet) or beats }.`);
      v = { bpm: x.bpm, division: x.division ?? '1/4' };
    } else if (type === 'eq' && k === 'bands') {
      if (!Array.isArray(x) || !x.length) fail(`${at}: bands is a list of { type, freq, gain, q }.`);
      v = x.map((b, j) => band({ type: 'peak', freq: 1000, gain: 0, q: 0.7071 }, b, `${at} band ${j + 1}`));
    } else if (type === 'eq' && /^band\s*\d+$/i.test(k)) {
      const j = +k.match(/\d+/)[0] - 1, b = fx.bands?.[j];
      if (!b) fail(`${at}: it has ${plural(fx.bands?.length ?? 0, 'band')} (from 1); give bands for others.`);
      const was = { ...b };
      band(b, x, `${at} band ${j + 1}`);
      for (const p of Object.keys(PARAMS.eq)) if (was[p] !== b[p]) said.push(`eq band ${j + 1} ${p} on ${where} ${words(PARAMS.eq[p], was[p])} → ${words(PARAMS.eq[p], b[p])}`);
      continue;
    } else {
      const d = PARAMS[type][k];
      if (!d || typeof d.value === 'object') fail(`${at}: a ${type} has ${[...paramsOf(type).map(([p]) => p), ...(EXTRA[type] ?? [])].join(', ')}, not "${k}".`);
      v = valueOf({ title: `${at}: ${k}`, ...d }, x);
    }
    if (JSON.stringify(v) === JSON.stringify(fx[k])) continue;
    const shown = (x) => (k === 'ir' ? x ?? 'room' : k === 'sidechain' ? (x ? `"${d.tracks.find((t) => t.id === x)?.name ?? x}"` : 'none') : words(PARAMS[type][k], x));
    said.push(`${type} ${k} on ${where} ${shown(fx[k])} → ${shown(v)}`);
    if (v === undefined) delete fx[k]; else fx[k] = v;
  }
}
// a new effect: its type's defaults written out (as the panel adds one), then what is given
function made(doc, spec, where) {
  if (!spec || typeof spec !== 'object' || !FX.includes(spec.type)) fail(`An effect is { type, …params }, its type one of ${FX.join(', ')}${spec?.type ? `, not "${spec.type}"` : ''}.`);
  const fx = newFx(spec.type), { type, ...rest } = spec;
  setFx(doc, fx, rest, where, []);
  return fx;
}
// the effect a key names on a strip: its place (from 1), its type (where it has one), or "<type> <n>"
function fxNamed(s, key) {
  const chain = s.o.fx ?? [], k = String(key).trim().toLowerCase(), m = /^([a-z]+)\s*(\d+)?$/.exec(k);
  const has = () => (chain.length ? `it has ${chain.map((f, i) => `${i + 1}. ${f.type}`).join(', ')}` : 'it has none');
  if (/^\d+$/.test(k)) return chain[+k - 1] ?? fail(`${label(s)} has no effect ${k}: ${has()}.`);
  const same = m ? chain.filter((f) => f.type === m[1]) : [];
  if (!same.length) return fail(`${label(s)} has no ${m?.[1] ?? key}: ${has()}.`);
  if (m[2]) return same[+m[2] - 1] ?? fail(`${label(s)} has ${plural(same.length, m[1])}, not ${m[2]}.`);
  if (same.length > 1) fail(`${label(s)} has ${same.length} ${m[1]}s: name one as "${m[1]} 1" or by its place (${has()}).`);
  return same[0];
}

// ---------- a change
const ALLOWED = { track: ['volume', 'pan', 'mute', 'solo', 'sends', 'fx', 'add_fx', 'set_fx'], bus: ['volume', 'pan', 'mute', 'fx', 'add_fx', 'set_fx'], master: ['volume', 'fx', 'add_fx', 'set_fx'] };
// an effect with the params it was given, in words: 'compressor (threshold -24 dB, ratio 3 x)'
const fxGiven = (fx, spec) => { const ks = Object.keys(spec).filter((k) => k !== 'type'); return `${fx.type}${ks.length ? ` (${ks.map((k) => `${k} ${words(PARAMS[fx.type][k], fx[k])}`).join(', ')})` : ''}`; };
// change c on strip s of d (its settings as the panel leaves them: what is at its default left out)
function strip(d, s, c, said) {
  const where = label(s);
  if (!c || typeof c !== 'object') fail(`${where}: a change is { ${ALLOWED[s.kind].join(', ')} }.`);
  for (const k of Object.keys(c)) if (!ALLOWED[s.kind].includes(k)) fail(`${where}: ${s.kind === 'master' ? 'the master' : `a ${s.kind}`} has ${ALLOWED[s.kind].join(', ')}, not "${k}".`);
  const o = s.kind === 'master' ? (d.master ??= {}) : s.o;
  if (c.volume !== undefined) { const v = Math.round(valueOf(VOLUME, c.volume) * 10) / 10; if (v !== (o.volume ?? 0)) said.push(`fader ${where} ${db1(o.volume)} → ${db1(v)}`); o.volume = v; }
  if (c.pan !== undefined) { const v = Math.round(valueOf(PAN, c.pan) * 100) / 100; if (v !== (o.pan ?? 0)) said.push(`pan ${where} ${(o.pan ?? 0).toFixed(2)} → ${v.toFixed(2)}`); o.pan = v; }
  for (const k of ['mute', 'solo']) if (c[k] !== undefined) { const v = valueOf({ title: k, options: [true, false] }, c[k]); if (v !== !!o[k]) said.push(`${v ? '' : 'un'}${k} ${where}`); o[k] = v; }
  for (const [bn, x] of Object.entries(c.sends ?? {})) {
    const b = busNamed(d, bn), bid = b.id.slice(4), was = o.sends?.[bid];
    const v = x == null || x === 'off' ? null : Math.round(valueOf(SEND, x) * 10) / 10;
    if (v === (was ?? null)) continue;
    said.push(`send ${where} to ${label(b)} ${was == null ? 'off' : db1(was)} → ${v == null ? 'off' : db1(v)}`);
    if (v == null) delete o.sends[bid]; else (o.sends ??= {})[bid] = v;
  }
  if (c.fx !== undefined) {
    if (!Array.isArray(c.fx)) fail(`${where}: fx is the whole chain, a list of { type, …params } (add_fx adds one, set_fx changes one).`);
    const was = (o.fx ?? []).map((f) => f.type).join(', ') || 'none';
    o.fx = c.fx.map((f) => made(d, f, where));
    said.push(`${where} effects ${was} → ${o.fx.map((f, i) => fxGiven(f, c.fx[i])).join(', ') || 'none'}`);
  }
  if (c.set_fx !== undefined) {
    // (each named against the chain as it was: taking one out does not change what names the others)
    const named = Object.entries(c.set_fx ?? {}).map(([k, x]) => [fxNamed({ ...s, o }, k), x]);
    for (const [fx, x] of named) {
      if (x === null) { o.fx = o.fx.filter((f) => f !== fx); said.push(`remove ${fx.type} from ${where}`); }
      else if (typeof x === 'object') setFx(d, fx, x, where, said);
      else fail(`${where}: set_fx gives each effect its params ({ threshold: "-24 dB" }), or null to take it out.`);
    }
  }
  for (const f of c.add_fx ?? []) { const fx = made(d, f, where); (o.fx ??= []).push(fx); said.push(`add ${fxGiven(fx, f)} to ${where}`); }
  for (const k of ['volume', 'pan', 'mute', 'solo']) if (!o[k]) delete o[k];
  if (o.fx && !o.fx.length) delete o.fx;
  if (o.sends && !Object.keys(o.sends).length) delete o.sends;
  if (s.kind === 'master' && !Object.keys(o).length) delete d.master;
}
/**
 * Changes the mixer of a copy of `doc`: { set: { <strip>: { volume, pan, mute, solo, sends: { <bus>: dB | null }, fx: [the
 * whole chain], add_fx: [...], set_fx: { <effect>: { params } | null } } }, add_buses: [{ name, fx?, volume?, pan? }],
 * remove_buses: [names] }. Returns { doc, said }; throws a MixerError, changing nothing, where anything is wrong.
 */
export function change(doc, { set = {}, add_buses: adds = [], remove_buses: drops = [] } = {}) {
  const d = structuredClone(doc), said = [];
  // (new buses first, so the sends below can name them)
  for (const b of adds) {
    if (!b?.name) fail('A new bus is { name, fx?, volume?, pan? }.');
    if ((d.buses ?? []).some((x) => (x.name ?? x.id).toLowerCase() === String(b.name).toLowerCase())) fail(`There is a bus "${b.name}" already.`);
    let n = 1;
    while ((d.buses ?? []).some((x) => x.id === `bus${n}`)) n++;
    const bus = { id: `bus${n}`, name: String(b.name), fx: [{ ...newFx('reverb'), mix: 1 }] }, { name, ...rest } = b;   // (as the panel adds one: a reverb)
    (d.buses ??= []).push(bus);
    strip(d, stripNamed(d, `bus:${bus.id}`), rest, []);
    said.push(`add bus "${bus.name}" (${bus.fx?.map((f) => f.type).join(', ') || 'no effects'})`);
  }
  for (const name of drops) {
    const s = busNamed(d, name), bid = s.id.slice(4);
    d.buses = d.buses.filter((b) => b.id !== bid);
    let n = 0;
    for (const t of d.tracks) if (t.sends?.[bid] != null) { delete t.sends[bid]; n++; if (!Object.keys(t.sends).length) delete t.sends; }
    if (!d.buses.length) delete d.buses;
    said.push(`remove ${label(s)}${n ? ` (and ${plural(n, 'send')} to it)` : ''}`);
  }
  for (const [name, c] of Object.entries(set)) strip(d, stripNamed(d, name), c, said);
  return { doc: d, said };
}

// ---------- the mixer, as text
function fxWords(doc, fx, i) {
  const ps = fx.type === 'eq' ? (fx.bands ?? []).map((b, j) => `band ${j + 1} ${b.type} ${words(PARAMS.eq.freq, b.freq)}${/peak|shelf/.test(b.type) ? ` ${b.gain >= 0 ? '+' : ''}${words(PARAMS.eq.gain, b.gain)}` : ''} q ${+(+b.q).toFixed(2)}`)
    : paramsOf(fx.type).map(([k, d]) => `${k} ${words(d, fx[k] ?? d.value)}`);
  if (fx.ir) ps.unshift(`ir ${fx.ir}`);
  if (fx.sidechain) ps.unshift(`sidechain "${doc.tracks.find((t) => t.id === fx.sidechain)?.name ?? fx.sidechain}"`);
  if (typeof fx.time === 'object') ps.unshift(`time ${fx.time.division} at ${fx.time.bpm} bpm`);
  if (fx.makeup === 'auto') ps.unshift('makeup auto');
  return `  ${i + 1}. ${fx.type}${fx.on === false ? ' (bypassed)' : ''}: ${ps.join(', ')}`;
}
/** The mixer as text: each strip, its settings, effects and sends, and what plays on a track. */
export function describe(doc) {
  const buses = new Map((doc.buses ?? []).map((b) => [b.id, b.name ?? b.id]));
  const lines = ['Strips are named by A-number, name or id (a bus by its name, the master as master). The sound flows: a track\'s clips → its effects → its volume and pan → mute, solo → its sends (after its fader) and the tracks summed → the master\'s effects → the master\'s volume.'];
  for (const s of stripsOf(doc)) {
    const o = s.o, flags = [o.mute && 'muted', o.solo && 'soloed'].filter(Boolean);
    let plays = '';
    if (s.kind === 'track') {
      const ms = [...new Set(o.clips.map((c) => c.media))], notes = ms.filter((m) => isNotes(doc.media?.[m]));
      plays = ms.length ? `; plays ${[notes.length ? `notes ${notes.map((m) => `"${doc.media[m].name ?? m}"`).join(', ')}` : '', ms.length > notes.length ? plural(o.clips.filter((c) => !notes.includes(c.media)).length, 'audio clip') : ''].filter(Boolean).join(' and ')}` : '; no clips';
    }
    lines.push(`${s.kind === 'track' ? `${s.num} "${s.name}" (${s.id})` : s.kind === 'bus' ? `bus "${s.name}" (${s.id.slice(4)})` : 'Master'}: ${db1(o.volume)}${s.kind === 'master' ? '' : `, pan ${(o.pan ?? 0).toFixed(2)}`}${flags.length ? `, ${flags.join(', ')}` : ''}${plays}`);
    (o.fx ?? []).forEach((fx, i) => lines.push(fxWords(doc, fx, i)));
    const sends = Object.entries(o.sends ?? {});
    if (sends.length) lines.push(`  sends: ${sends.map(([b, v]) => `"${buses.get(b) ?? b}" ${db1(v)}`).join(', ')}`);
  }
  const bare = ([k, d]) => (d.options ? k : `${k} ${d.unit === '%' ? '0–1' : d.unit ?? ''}`.trim());
  lines.push(`Effects, each param with the unit a bare number is in (words say their own: "5 ms", "2.5 kHz", "30%"): ${FX.map((t) => `${t} (${t === 'eq' ? 'bands: [{ type, freq Hz, gain dB, q }]' : [...paramsOf(t).map(bare), ...(EXTRA[t] ?? [])].join(', ')})`).join('; ')}.`);
  return lines.join('\n');
}
