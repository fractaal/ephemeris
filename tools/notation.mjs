// Notes as text, in the timeline's bars and beats: what an agent writes a notes clip in, and reads one back in (the MCP's
// notes and write_notes). Positions are the studio's bar.beat.sixteenth, counted from 0 as its ruler and
// tempo(TL.grid).b() count them, on the timeline's tempo grid (engine/grid.js: a tempo map is followed); times come
// out in film seconds. One line is one note or a chord, or a drum row:
//
//   swing 58%                      off-beat sixteenths late, so that a pair splits 58/42 (swing 58% 1/8: eighths)
//   vel .8                         the velocity of what says none (0–1; .8 unless set)
//   len 1/16                       the length of what says none (a drum row's hits: one step unless set)
//   steps 16                       a drum row's steps a bar (four a beat unless set)
//   4.0        F1          1/2  .9      bar 4, beat 0: F1 for a half note at velocity .9
//   4.2        Ab3 C4 Eb4  1/4  .6      a chord (each note a name, C4 = 60, or a MIDI number)
//   4.2        Ab3:.7 C4:.5  1/4        a chord whose notes each say their own velocity
//   4.3.2-12ms C5          1/16         beat 3, its third sixteenth (0–3), 12 ms early
//   4.1+1/3    G4          1/12         a third of the way through beat 1 (a triplet)
//   @8-15 0.0  F1  1/8                  bars 8–15: the line once a bar, its bar counted from the first of each
//   @8-15/2 1.2 Ab1 1/8                 every two bars (its bar 0 or 1 of each pair)
//   @8-15 kick 36 x...x...x...x... +4ms a drum row: a step each character (X accent 1, x the velocity set, o a ghost .4,
//                                       1–9 .1–.9, . or - a rest, | ignored), repeated over the bars it covers, 4 ms late
//
// Lengths: n/d of a whole note (1/4 a beat; 1/8. dotted, 1/8t a triplet), or 1.5b beats, 2bar, 250ms, 0.5s. A # at the
// start of a line or after a space starts a comment.
import { parts, partAt, position, timeOf } from '../engine/grid.js';
import { midi } from '../engine/sound/core.js';

export class NotationError extends Error {}
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** A MIDI note's name (60 is C4). */
export const noteName = (n) => `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

const POS = /^(-?\d+)\.(\d+)(?:\.(\d+))?(?:\+(\d+)\/(\d+))?(?:([+-]\d+(?:\.\d+)?)ms)?$/;
const NOTE = /^(?:[A-Ga-g][#b]?-?\d|\d{1,3})(?::(?:0?\.\d+|1\.0*|0\.0*))?$/;   // (a note of a chord may say its own velocity: F3:.9)
const LEN = /^(?:(\d+)\/(\d+)([.t]?)|(\d*\.?\d+)(b|bars?|ms|s))$/;
const VEL = /^(?:0?\.\d+|1\.0*|0\.0*)$/;
const ROW = /^(?=.*[Xxo.\-|])[Xxo.\-|1-9]+$/;
const SHIFT = /^([+-]\d+(?:\.\d+)?)ms$/;
const RANGE = /^@(-?\d+)(?:-(-?\d+))?(?:\/(\d+))?$/;

const toNote = (s) => { const n = s.split(':')[0]; return /^\d+$/.test(n) ? +n : midi(n); };
const ownVel = (s) => (s.includes(':') ? +s.split(':')[1] : null);
/** A length's beats, or its seconds ({ s }). */
function length(s, bpb) {
  const m = LEN.exec(s);
  if (m[1]) return { beats: (4 * +m[1]) / +m[2] * (m[3] === '.' ? 1.5 : m[3] === 't' ? 2 / 3 : 1) };
  const v = +m[4];
  return m[5] === 'b' ? { beats: v } : m[5].startsWith('bar') ? { beats: v * bpb } : { s: m[5] === 'ms' ? v / 1000 : v };
}

/**
 * Notes from text (see above), on `grid` (a timeline's): { notes: [{ t, dur, note, vel }] in film seconds, in time order;
 * bars: [first, last], the bars it covers (a range's whole span) } — or a NotationError naming the line and what is wrong.
 */
export function parse(text, grid = {}) {
  const ps = parts(grid), notes = [];
  let swing = 0.5, swingPer = 0.25, vel = 0.8, len = null, steps = null, lo = Infinity, hi = -Infinity;
  const cover = (a, b) => { lo = Math.min(lo, a); hi = Math.max(hi, b); };
  // where bar, beat (with its fraction) fall, swung: an off-beat sixteenth (or eighth) moved by the swing
  const at = (bar, beats) => {
    const k = beats / swingPer, part = ps.filter((p) => p.n <= bar).at(-1) ?? ps[0];
    const swung = Math.abs(k - Math.round(k)) < 1e-6 && Math.round(k) % 2 !== 0 ? (swing - 0.5) * 2 * swingPer * part.beat : 0;
    return timeOf(grid, bar, beats) + swung;
  };
  const add = (t, beatsOrS, note, v) => {
    const p = partAt(ps, t), dur = beatsOrS.s ?? beatsOrS.beats * p.beat;
    if (!(dur > 0)) throw new Error('a note lasts more than nothing');
    if (note < 0 || note > 127 || !Number.isInteger(note)) throw new Error(`no MIDI note ${note}`);
    notes.push({ t: r6(t), dur: r6(dur), note, vel: v });
  };
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*/, '').trim();   // (a comment's # starts the line or follows a space: F#3 is a note)
    if (!line) return;
    const fail = (why) => { throw new NotationError(`line ${i + 1} ("${raw.trim()}"): ${why}`); };
    try {
      let tok = line.split(/\s+/);
      // directives
      if (tok[0] === 'swing') {
        const m = /^(\d+(?:\.\d+)?)%$/.exec(tok[1] ?? '') ?? fail('swing is a percentage: swing 58%');
        swing = +m[1] / 100; swingPer = tok[2] === '1/8' ? 0.5 : tok[2] == null || tok[2] === '1/16' ? 0.25 : fail('swing is of 1/16 or 1/8');
        if (swing < 0.5 || swing >= 0.75) fail('swing is from 50% (straight) to under 75%');
        return;
      }
      if (tok[0] === 'vel') { vel = VEL.test(tok[1] ?? '') ? +tok[1] : fail('vel is from 0 to 1: vel .8'); return; }
      if (tok[0] === 'len') { len = LEN.test(tok[1] ?? '') ? tok[1] : fail('len is a length: len 1/16'); return; }
      if (tok[0] === 'steps') { steps = /^\d+$/.test(tok[1] ?? '') && +tok[1] > 0 ? +tok[1] : fail('steps is a number: steps 16'); return; }
      // a range: where the line repeats, its bars counted from the first of each period
      let range = null;
      if (tok[0].startsWith('@')) {
        const m = RANGE.exec(tok[0]) ?? fail('a range is @first-last (bars), maybe /period: @8-15 or @8-15/2');
        range = { a: +m[1], b: m[2] != null ? +m[2] : null, per: m[3] != null ? +m[3] : null };
        if (range.b != null && range.b < range.a) fail('a range runs from its first bar to a later one');
        tok = tok.slice(1);
      }
      const row = tok.findIndex((x) => ROW.test(x) && ![NOTE, VEL, POS, LEN].some((re) => re.test(x)));
      if (row >= 0) {
        // a drum row: [label] note pattern [±ms]
        const note = tok[row - 1] && NOTE.test(tok[row - 1]) ? toNote(tok[row - 1]) : fail('a drum row names its note before its steps: kick 36 x...x...');
        const pat = tok[row].replace(/\|/g, ''), rest = tok.slice(row + 1);
        let shift = 0;
        for (const x of rest) { const m = SHIFT.exec(x); if (m) shift = +m[1] / 1000; else fail(`"${x}" after a drum row's steps (only an offset: +4ms)`); }
        const a = range?.a ?? 0, bpb = (partAt(ps, timeOf(grid, a)).beatsPerBar), n = steps ?? bpb * 4, bars = Math.ceil(pat.length / n);
        const per = range?.per ?? bars, b = range?.b ?? a + bars - 1;
        cover(a, b);
        const stepBeats = bpb / n, hit = len ? length(len, bpb) : { beats: stepBeats };
        for (let base = a; base <= b; base += per) {
          [...pat].forEach((ch, s) => {
            if (ch === '.' || ch === '-') return;
            const bar = base + Math.floor(s / n);
            if (bar > b) return;
            const v = ch === 'X' ? 1 : ch === 'x' ? vel : ch === 'o' ? 0.4 : +ch / 10;
            add(at(bar, (s % n) * stepBeats) + shift, hit, note, v);
          });
        }
        return;
      }
      // a note or chord: position, notes, [length], [velocity]
      const m = POS.exec(tok[0]) ?? fail('a line starts with its position, bar.beat[.sixteenth] (from 0): 4.2 or 4.2.3, maybe +1/3 or -12ms');
      const ns = [], extra = { len: null, vel: null };
      for (const x of tok.slice(1)) {
        if (NOTE.test(x) && extra.len == null && extra.vel == null) ns.push([toNote(x), ownVel(x)]);
        else if (LEN.test(x) && extra.len == null && extra.vel == null) extra.len = x;
        else if (VEL.test(x) && extra.vel == null) extra.vel = +x;
        else fail(`"${x}" is not a note (C4, F#3, Bb2 or 0–127), a length (1/8, 1.5b, 250ms) or a velocity (.8)${extra.vel != null ? ' (the velocity comes last)' : ''}`);
      }
      if (!ns.length) fail('no notes: name them after the position (C4 E4 G4)');
      const relBar = +m[1], beats = +m[2] + (m[3] != null ? +m[3] / 4 : 0) + (m[4] != null ? +m[4] / +m[5] : 0), shift = m[6] != null ? +m[6] / 1000 : 0;
      const bars = range ? (() => { const per = range.per ?? 1, b = range.b ?? range.a + per - 1, out = []; for (let base = range.a; base <= b; base += per) if (base + relBar <= b) out.push(base + relBar); cover(range.a, b); return out; })() : [relBar];
      for (const bar of bars) {
        if (!range) cover(bar, bar);
        const bpb = partAt(ps, timeOf(grid, bar)).beatsPerBar, l = length(extra.len ?? len ?? '1/16', bpb), t = at(bar, beats) + shift;
        for (const [note, v] of ns) add(t, l, note, v ?? extra.vel ?? vel);
      }
    } catch (e) { if (e instanceof NotationError) throw e; fail(e.message); }
  });
  notes.sort((x, y) => x.t - y.t || x.note - y.note);
  return { notes, bars: Number.isFinite(lo) ? [lo, hi] : null };
}

// ---------- notes written out

const TOL = 5e-4;   // (s: what is read as on a grid line, or as a musical length)
const near = (x, y, tol = TOL) => Math.abs(x - y) < tol;
const v3 = (v) => { const x = Math.round(v * 1000) / 1000; return x >= 1 ? '1.0' : x <= 0 ? '0.0' : String(x).replace(/^0\./, '.'); };   // (always with its point: 1 alone is a note)
function reduce(n, d) { const g = (a, b) => (b ? g(b, a % b) : a), k = g(n, d); return `${n / k}/${d / k}`; }
/** A length (s) where a beat lasts `beat` s: a fraction of a whole note (sixteenths, thirty-seconds, triplets), else ms. */
function lengthText(dur, beat) {
  for (const d of [16, 32, 24, 48]) { const k = Math.round((dur / beat * d) / 4); if (k > 0 && near((4 * k) / d * beat, dur)) return reduce(k, d); }
  return `${Math.round(dur * 1e4) / 10}ms`;
}
/** Where t falls, as bar.beat[.sixteenth][+n/d][±ms] on the swung grid. */
function posText(grid, t, swing) {
  const { bar, beat, part } = position(grid, t + TOL);   // (a note a hair early is on the line it is early for)
  const sixteenths = beat * 4, k = Math.round(sixteenths), shifted = (k % 2 !== 0) ? (swing - 0.5) * 2 * 0.25 * part.beat : 0;
  // on a (swung) sixteenth, else on a third or sixth of a beat, else the sixteenth nearest and how far off
  const exact = (bt, sh = 0) => near(timeOf(grid, bar, bt) + sh, t);
  const name = (b6) => { const b = Math.floor(b6 / 4 + 1e-9), s = Math.round(b6 - 4 * b); return `${bar}.${b}${s ? `.${s}` : ''}`; };
  if (k < 4 * part.beatsPerBar && exact(k / 4, shifted)) return name(k);
  for (const d of [3, 6]) { const j = Math.round((beat % 1) * d); if (j > 0 && j < d && exact(Math.floor(beat) + j / d)) return `${bar}.${Math.floor(beat)}+${reduce(j, d)}`; }
  const kk = Math.min(Math.max(0, k), 4 * part.beatsPerBar - 1), sh = kk % 2 !== 0 ? (swing - 0.5) * 2 * 0.25 * part.beat : 0, off = Math.round((t - timeOf(grid, bar, kk / 4) - sh) * 1000);
  return `${name(kk)}${off >= 0 ? '+' : ''}${off}ms`;
}
// the swing most off-beat sixteenths keep (a steady delay of them), or 0.5: straight
function swingOf(grid, notes) {
  const offs = [];
  for (const n of notes) {
    const { bar, beat, part } = position(grid, n.t), k = Math.floor(beat * 4 + 0.5 - 0.15);   // (a late one belongs to the sixteenth before it)
    if (k % 2 === 0) continue;
    const d = n.t - timeOf(grid, bar, k / 4);
    if (d > -0.002 && d < 0.4 * 0.25 * part.beat) offs.push(d / (0.25 * part.beat));
  }
  if (offs.length < 8) return 0.5;
  offs.sort((a, b) => a - b);
  const med = offs[offs.length >> 1], steady = offs.filter((x) => Math.abs(x - med) < 0.03).length / offs.length;
  return med > 0.03 && steady >= 0.6 ? Math.round((0.5 + med / 2) * 1000) / 1000 : 0.5;
}

/**
 * Notes (film seconds) as text on `grid`: the swing it reads with (where its off-beat sixteenths keep one), then each note
 * or chord (notes that start and last together) a line, in time order; with `tab`, each note that keeps to the swung
 * sixteenths at a drum row's velocities as drum rows a bar each (bars alike in a row as one range). parse() gives these
 * notes back within half a millisecond (what is read as on the grid, or as a musical length) and a thousandth of velocity.
 */
export function write(notes, grid = {}, { tab = false } = {}) {
  const swing = swingOf(grid, notes), out = [];
  if (swing !== 0.5) out.push(`swing ${+(swing * 100).toFixed(1)}%`);
  let rest = notes;
  if (tab) {
    const rowsOut = [];
    const step = (n) => { const { bar, beat, part } = position(grid, n.t + TOL), k = Math.round(beat * 4); return { bar, k, part, ok: k < 4 * part.beatsPerBar && near(timeOf(grid, bar, k / 4) + (k % 2 ? (swing - 0.5) * 0.5 * part.beat : 0), n.t) }; };
    const CH = (v) => (near(v, 1, 1e-6) ? 'X' : near(v, 0.8, 1e-6) ? 'x' : near(v, 0.4, 1e-6) ? 'o' : near(v * 10, Math.round(v * 10), 1e-6) && v > 0 && v < 1 ? String(Math.round(v * 10)) : null);
    const byNote = new Map();
    for (const n of notes) { if (!byNote.has(n.note)) byNote.set(n.note, []); byNote.get(n.note).push(n); }
    const kept = new Set();
    for (const [note, ns] of [...byNote].sort((a, b) => a[0] - b[0])) {
      const st = ns.map(step), dur = ns[0].dur;
      // (a drum's hits: four or more, each as long and no longer than a beat, on the steps, at a row's velocities)
      if (ns.length < 4 || dur > st[0].part.beat + 1e-6 || !st.every((s, i) => s.ok && CH(ns[i].vel) && near(ns[i].dur, dur, 1e-6) && st[0].part.beatsPerBar === s.part.beatsPerBar)) continue;
      const bpb = st[0].part.beatsPerBar, bars = new Map();
      ns.forEach((n, i) => { const s = st[i]; if (!bars.has(s.bar)) bars.set(s.bar, Array(4 * bpb).fill('.')); bars.get(s.bar)[s.k] = CH(n.vel); });
      const lenNote = near(dur, 0.25 * st[0].part.beat, 1e-6) ? null : lengthText(dur, st[0].part.beat);
      const list = [...bars].sort((a, b) => a[0] - b[0]).map(([bar, cells]) => [bar, cells.join('')]);
      const runs = [];
      for (const [bar, p] of list) { const r = runs.at(-1); if (r && r.p === p && r.b === bar - 1) r.b = bar; else runs.push({ a: bar, b: bar, p }); }
      // (a beat's four steps grouped, so the row reads in beats)
      const group = (p) => p.match(/.{1,4}/g).join('|');
      for (const r of runs) rowsOut.push({ a: r.a, text: `${lenNote ? `len ${lenNote}\n` : ''}@${r.a}${r.b !== r.a ? `-${r.b}` : ''} ${noteName(note)} ${group(r.p)}${lenNote ? '\nlen 1/16' : ''}` });
      ns.forEach((n) => kept.add(n));
    }
    out.push(...rowsOut.sort((a, b) => a.a - b.a).map((r) => r.text));
    rest = notes.filter((n) => !kept.has(n));
  }
  // chords: notes that start and last together (each its own velocity where they differ)
  const lines = [];
  for (const n of rest) {
    const last = lines.at(-1);
    if (last && near(last.t, n.t, 1e-6) && near(last.dur, n.dur, 1e-6)) { last.notes.push(n); continue; }
    lines.push({ t: n.t, dur: n.dur, notes: [n] });
  }
  for (const l of lines) {
    const p = partAt(parts(grid), l.t), same = l.notes.every((n) => near(n.vel, l.notes[0].vel, 1e-6));
    const ns = l.notes.map((n) => (same ? noteName(n.note) : `${noteName(n.note)}:${v3(n.vel)}`)).join(' ');
    out.push(`${posText(grid, l.t, swing).padEnd(12)} ${ns.padEnd(10)} ${lengthText(l.dur, p.beat).padEnd(5)}${same ? ` ${v3(l.notes[0].vel)}` : ''}`.trimEnd());
  }
  return out.join('\n');
}
