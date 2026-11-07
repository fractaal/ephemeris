// A film's sound in code: the project's sound.js, beside film.js, says what its parts' instruments do over the film, as
// motions (motion.js), as film.js says what is seen. The studio runs it wherever the film's sound is made (the editor,
// renders), against the timeline, and again when either changes:
//
//   // sound.js
//   export default ({ part, cues, b, BEAT }) => {
//     const drop = cues.at('drop', 32);
//     part('bass').automate('Filter 1 Cutoff').to(drop - 4 * BEAT, 4 * BEAT, 0.9).wander(0.03, { speed: 0.5 });
//   };
//
// part(id): a notes medium of the timeline (a part: its clips place it, the instrument of the track each is on plays it).
//   .automate(param): that parameter of the instrument of each track that plays the part (its key, as the `instruments`
//   tool lists it: a plugin's title, a sampler's path) as a motion, in 0–1 of its range, starting from what is below it
//   (the instrument's value, and the clips' own lanes): chain .to(), .by(), .keys(), .rate(), .wander() on it, at the
//   timeline's times. The director's changes to it are the timeline's overrides, kept by the line that made it, as a
//   film motion's are; the track's own lanes work on top of it.
//   .notes([{ t, dur, note, vel }, …]): its notes, in its own time (seconds from its start; note 60 is C4, vel 0–1). The
//   director's edits of them in the piano roll are kept in the timeline over them: the medium's `notes` are theirs
//   (added), its `removed` ([[t, note], …]) the code's they took away or changed; a removal the code no longer makes a
//   note for does nothing.
// The run's context: part, cues ({ at, end, get }, as elements/cues.js reads them), the grid's tempo (b(bar, beat,
// sixteenth) → s, BPM, BEAT, BAR: time.js tempo) and TL, the timeline itself.
//
// A film moves with its parts the other way: hits(TL, part, { note }) are a part's notes as the timeline plays them (film
// time, each clip placing it), for a motion's .hits() (motion.js): a pulse on every kick. heard(TL, import.meta.url) is
// the timeline with the project's sound.js run against it, so the notes it writes are among them:
//
//   const TL = await heard(await timeline(import.meta.url), import.meta.url);
//   push(BALL.at(0, 0, 0, { s: motion(1).hits(hits(TL, 'drums', { note: 36 }), { amount: 0.15, decay: 0.2 }) }));
import { Stack, atMoment } from './motion.js';
import { namedFrom, here } from './site.js';
import { tempo } from './time.js';

/** Runs sound.js's default export `fn` against timeline TL, its lines named from `dir` (the project folder's URL):
 *  { automation: [{ part, key, desc }] (desc: the motion as data: Stack.describe()), notes: { <part>: [{ t, dur, note,
 *  vel }] }, cues: the ids it read }. */
export function score(fn, TL, dir) {
  const automation = [], notes = {}, read = new Set(), byId = new Map((TL.cues ?? []).map((c) => [c.id, c]));
  const cue = (id) => { read.add(id); return byId.get(id); };
  const ctx = {
    TL,
    ...tempo(TL.grid ?? {}),
    cues: { at: (id, fallback) => cue(id)?.t ?? fallback, end: (id, fallback) => { const c = cue(id); return c?.dur ? c.t + c.dur : fallback; }, get: cue },
    part: (id) => ({
      /** Parameter `key` as a motion from what is below it (name: what the director's changes to it are kept by). */
      automate(key, { name = null } = {}) {
        const s = new Stack({ value: 0 }, { stack: here(), name, code: () => 0 });
        automation.push({ part: id, key, s });
        return s;
      },
      /** Notes of the part ([{ t, dur, note, vel }], in its time), added to those it has from this run. */
      notes(list) {
        for (const n of list ?? []) {
          if (![n?.t, n?.dur, n?.note].every(Number.isFinite)) throw new Error(`part('${id}').notes: a note is { t, dur, note, vel } (numbers), not ${JSON.stringify(n)}`);
          (notes[id] ??= []).push({ t: n.t, dur: n.dur, note: n.note, vel: n.vel ?? 0.8 });
        }
        return this;
      },
    }),
  };
  namedFrom(dir, () => atMoment(0, () => fn(ctx)));   // (its motions numbered afresh each run, as a scene's are)
  for (const list of Object.values(notes)) list.sort((a, b) => a.t - b.t || a.note - b.note);
  return { automation: automation.map(({ part, key, s }) => ({ part, key, desc: s.describe() })), notes, cues: [...read] };
}

// ---------- a part's notes, for a film
/** The parts a film read (hits): the studio renders its frames again when one of them changes (runtime.js reports them
 *  with the cues it reads). */
export const partsRead = new Set();
/** Part `id`'s notes as the timeline plays them, in film time: [{ t, vel, note, dur }] in time order, from each clip of it
 *  on a track heard (its in, out and speed placing them; a muted track's too: what is seen keeps time when the sound is
 *  off). note: only these (a note, a list of them, or a test of one). */
export function hits(TL, id, { note = null } = {}) {
  partsRead.add(id);
  const m = TL.media?.[id], keep = note == null ? () => true : typeof note === 'function' ? note : Array.isArray(note) ? (n) => note.includes(n) : (n) => n === note;
  if (!Array.isArray(m?.notes)) return [];
  const out = [];
  for (const tr of TL.tracks ?? []) for (const c of tr.clips) {
    if (c.media !== id || tr.kind === 'visual') continue;
    const sp = c.speed || 1;
    for (const n of m.notes) if (keep(n.note) && n.t >= c.in - 1e-9 && n.t < c.out) out.push({ t: c.at + (n.t - c.in) / sp, vel: n.vel ?? 0.8, note: n.note, dur: n.dur / sp });
  }
  return out.sort((a, b) => a.t - b.t || a.note - b.note);
}
/** The timeline with the project's sound.js (beside `base`, a film's import.meta.url) run against it, as heard: TL
 *  itself where there is none. */
export async function heard(TL, base) {
  const url = new URL('sound.js', base);
  if (!(await fetch(url, { method: 'HEAD', cache: 'no-store' }).then((r) => r.ok, () => false))) return TL;   // (none)
  const fn = (await import(url.href)).default;
  return typeof fn === 'function' ? played(TL, score(fn, TL, new URL('.', base).href)) : TL;
}

// ---------- the timeline as heard with it
// (notes as the piano roll keeps them: a note's time and length to the millisecond, its velocity to the hundredth)
const r3 = (x) => Math.round(x * 1000) / 1000, r2 = (x) => Math.round(x * 100) / 100;
const tidy = (n) => ({ t: r3(n.t), dur: r3(n.dur), note: n.note, vel: r2(n.vel ?? 0.8) });
const same = (a, b) => a.t === b.t && a.dur === b.dur && a.note === b.note && a.vel === b.vel;
const byTime = (a, b) => a.t - b.t || a.note - b.note;
/** A part's notes as heard: its code's (`code`), less those its medium `m` took away (removed: [[t, note], …], each one
 *  note), and the medium's own (m.notes: the director's). */
export function partNotes(code, m) {
  const gone = [...(m?.removed ?? [])];
  const kept = code.filter((n) => { const i = gone.findIndex(([t, note]) => Math.abs(t - r3(n.t)) < 1e-6 && note === n.note); if (i < 0) return true; gone.splice(i, 1); return false; });
  return [...kept, ...(m?.notes ?? [])].sort(byTime);
}
/** A part's notes as edited (`edited`: all of them, as the piano roll keeps them), as its medium keeps them over its
 *  code's (`code`): { notes: those the code does not make (the director's), removed: the code's that are not there,
 *  [[t, note], …] }. The code's notes left as they were are kept as the code makes them. */
export function ownNotes(code, edited) {
  const left = edited.map(tidy), removed = [];
  for (const c of code.map(tidy)) { const i = left.findIndex((n) => same(n, c)); if (i >= 0) left.splice(i, 1); else removed.push([c.t, c.note]); }
  return { notes: left.sort(byTime), removed };
}

/** The timeline as heard with its sound code's run (sc: score()) in it: the parts whose notes it writes with them (and
 *  the director's edits over them: partNotes); each of its motions on the tracks that play its part, as the `code` of the
 *  parameter's entry in their instrument's automation (automation.instrument), with the director's changes to it
 *  (`changes`: the timeline's override for its id: nle/automation.js plays them). A new timeline (TL itself without any). */
export function played(TL, sc) {
  if (!sc || (!sc.automation?.length && !Object.keys(sc.notes ?? {}).length)) return TL;
  const media = { ...TL.media };
  for (const [id, code] of Object.entries(sc.notes ?? {})) if (media[id]) media[id] = { ...media[id], notes: partNotes(code, media[id]) };
  const tracks = TL.tracks.map((t) => {
    const mine = (sc.automation ?? []).filter((a) => t.clips.some((c) => c.media === a.part));
    if (!mine.length) return t;
    const automation = { ...t.automation };
    for (const a of mine) automation.instrument = { ...automation.instrument, [a.key]: { ...automation.instrument?.[a.key], code: a.desc, changes: (TL.overrides ?? []).find((o) => o.stack === a.desc.id) ?? null } };
    return { ...t, automation };
  });
  return { ...TL, media, tracks };
}
