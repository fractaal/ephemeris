// Where the timeline's changes are attached to the film's code, and keeping them there as the code is edited. A change
// names what it changes by where the code made it (file:line:col: a motion, a rig, one of its operators, the call that
// placed a thing), and remembers the code on that line (its `code`, by those names). When the code is edited:
//   - a line that still reads the same, where it was: nothing to do;
//   - a line that now reads the same somewhere else, and only there (and was the only one when it was remembered):
//     the change follows it — never a guess, it is the same code;
//   - anything else (the line itself was edited, or reads the same in more than one place): the change is ORPHANED,
//     its names marked `orphan:file:line:col`, which nothing in the film is named, so it no longer applies. It stays
//     in the timeline, with the code it was on, to be attached again (by the director or an agent) or removed. An
//     orphan whose line comes back (an edit undone, code moved back) is attached again.
// Plain, so the studio and the editor share it.

const SITE = /^(orphan:)?(.+?\.[cm]?[jt]sx?):(\d+):(\d+)(#.*)?$/;
/** A name of a place in the code ('film.js:56:6', 'film.js:56:6#2', 'orphan:film.js:56:6'), parsed; null for any other. */
export function parseSite(s) {
  const m = typeof s === 'string' && SITE.exec(s);
  return m ? { orphan: !!m[1], file: m[2], line: +m[3], col: +m[4], loc: `${m[2]}:${m[3]}:${m[4]}`, key: `${m[1] ?? ''}${m[2]}:${m[3]}:${m[4]}`, rest: m[5] ?? '' } : null;
}

// the places a change, or a cue on a thing, names: its key (the place, without an operator's #n) for each
const keysOf = (byCh) => Object.values(byCh ?? {}).flat();
const sitesIn = (names) => [...new Set(names.map((n) => parseSite(n)?.key).filter(Boolean))];
// (an object, whole, is named by every line that places it: on.sites)
const sitesOf = (o) => sitesIn([o.stack, o.on?.at, ...(o.on?.sites ?? []), ...Object.keys(o.ops ?? {}), ...keysOf(o.order), ...keysOf(o.muted)]);
const onThing = (q) => q.on?.at || q.on?.sites?.length;
const cueSites = (q) => sitesIn([q.on?.at, ...(q.on?.sites ?? [])]);
// what holds names: the changes, and the cues on a thing (which remember their code in their `on`)
const holders = (doc) => [...(doc.overrides ?? []).map((o) => ({ sites: sitesOf(o), code: o.code })), ...(doc.cues ?? []).filter(onThing).map((q) => ({ sites: cueSites(q), code: q.on.code }))];

/** `doc` with the places `map` names (key → key) renamed, wherever a change or a cue names them. A new doc. */
export function renameSites(doc, map) {
  if (!map || !Object.keys(map).length) return doc;
  const sw = (s) => { const p = parseSite(s); return p && map[p.key] ? map[p.key] + p.rest : s; };
  const keys = (o) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [sw(k), v]));
  const ids = (byCh) => byCh && Object.fromEntries(Object.entries(byCh).map(([c, a]) => [c, Array.isArray(a) ? a.map(sw) : a]));
  return {
    ...doc,
    overrides: doc.overrides?.map((o) => ({ ...o, stack: o.stack && sw(o.stack), on: o.on && { ...o.on, at: o.on.at && sw(o.on.at), ...(o.on.sites && { sites: o.on.sites.map(sw) }) }, ops: keys(o.ops), order: ids(o.order), muted: ids(o.muted), code: keys(o.code) })),
    cues: doc.cues?.map((q) => (onThing(q) ? { ...q, on: { ...q.on, ...(q.on.at && { at: sw(q.on.at) }), ...(q.on.sites && { sites: q.on.sites.map(sw) }), code: keys(q.on.code) } } : q)),
  };
}

// a remembered line: its text (with its indent), or, where it read the same in more than one place, { text, copies }
const textOf = (e) => (typeof e === 'string' ? e : e?.text ?? null);
const copiesOf = (e) => (typeof e === 'string' ? 1 : e?.copies ?? 1);
const indent = (s) => s.length - s.trimStart().length;

/**
 * `doc` kept on the film's code as it now is (read(file) → its text, or null): each change's names followed, or orphaned,
 * and the code each name is on remembered (a name first seen is remembered as the code now reads there).
 * → { doc, map (the names renamed: key → key, for an editor to rename its copies too), orphans (how many now), changed }.
 */
export function anchor(doc, read) {
  const files = new Map();
  const linesOf = (f) => { if (!files.has(f)) { const t = read(f); files.set(f, t == null ? null : t.split(/\r?\n/)); } return files.get(f); };
  const remember = (lines, i) => { const text = lines[i].trimEnd(), s = text.trim(), copies = lines.reduce((n, l) => n + (l.trim() === s ? 1 : 0), 0); return copies > 1 ? { text, copies } : text; };
  const H = holders(doc), stored = new Map();
  for (const h of H) for (const k of h.sites) if (!stored.has(k) && h.code?.[k] != null) stored.set(k, h.code[k]);
  const map = {}, now = new Map();
  for (const k of new Set(H.flatMap((h) => h.sites))) {
    const p = parseSite(k), lines = linesOf(p.file), e = stored.get(k), text = textOf(e);
    const here = lines && p.line <= lines.length && lines[p.line - 1].length >= p.col - 1 ? p.line - 1 : -1;
    if (!p.orphan && (text == null ? here >= 0 : here >= 0 && lines[here].trim() === text.trim())) { now.set(k, remember(lines, here)); continue; }
    const hits = text != null && lines ? lines.flatMap((l, i) => (l.trim() === text.trim() ? [i] : [])) : [];
    if (text != null && copiesOf(e) === 1 && hits.length === 1) {
      const i = hits[0], to = `${p.file}:${i + 1}:${Math.max(1, p.col - indent(text) + indent(lines[i]))}`;
      map[k] = to; now.set(to, remember(lines, i));
    } else if (!p.orphan) { map[k] = `orphan:${p.loc}`; if (e != null) now.set(map[k], e); }
    else if (e != null) now.set(k, e);
  }
  const out = { ...renameSites(doc, map) };   // (a new doc: the one given stays as it was)
  const codeFor = (sites) => { const c = Object.fromEntries(sites.filter((k) => now.has(k)).map((k) => [k, now.get(k)])); return Object.keys(c).length ? c : undefined; };
  out.overrides = out.overrides?.map((o) => ({ ...o, code: codeFor(sitesOf(o)) }));
  out.cues = out.cues?.map((q) => (onThing(q) ? { ...q, on: { ...q.on, code: codeFor(cueSites(q)) } } : q));
  const orphans = orphansIn(out).length;
  return { doc: out, map, orphans, changed: JSON.stringify(out) !== JSON.stringify(doc) };
}

// (a doc without the code it remembers: what a film reads of its changes)
export function strip(doc) {
  return { ...doc, overrides: doc.overrides?.map(({ code, ...o }) => o), cues: doc.cues?.map((q) => (q.on?.code ? { ...q, on: (({ code, ...on }) => on)(q.on) } : q)) };
}

/**
 * What in `doc` is orphaned: [{ kind: 'change' | 'operator' | 'line' | 'cue', id, site (its orphan: name), code (the
 * line it was on, or null), override?, cue? }] — a change whose motion or thing is orphaned whole (an object's: every
 * line that placed it); one of a motion's operators; one of the lines an object's change names, where others still
 * place it; a cue on a thing.
 */
export function orphansIn(doc) {
  const out = [];
  const codeOf = (h, k) => textOf(h?.[k])?.trim() ?? null;
  const lost = (sites) => (sites ?? []).map((n) => parseSite(n)).filter((p) => p?.orphan);
  for (const o of doc.overrides ?? []) {
    const lines = lost(o.on?.sites), gone = o.on?.sites?.length && lines.length === o.on.sites.length;
    const whole = gone ? lines[0] : parseSite(o.stack ?? o.on?.at);
    if (whole?.orphan) { out.push({ kind: 'change', id: o.id, site: whole.key, code: codeOf(o.code, whole.key), override: o }); continue; }
    for (const p of lines) out.push({ kind: 'line', id: o.id, site: p.key, code: codeOf(o.code, p.key), override: o });
    for (const k of new Set([...Object.keys(o.ops ?? {}), ...keysOf(o.order), ...keysOf(o.muted)].map((n) => parseSite(n)).filter((p) => p?.orphan).map((p) => p.key))) {
      out.push({ kind: 'operator', id: o.id, site: k, code: codeOf(o.code, k), override: o });
    }
  }
  for (const q of doc.cues ?? []) {
    const lines = lost(q.on?.sites), p = q.on?.sites?.length ? (lines.length === q.on.sites.length ? lines[0] : null) : parseSite(q.on?.at);
    if (p?.orphan) out.push({ kind: 'cue', id: q.id, site: p.key, code: codeOf(q.on.code, p.key), cue: q });
  }
  return out;
}

/** `doc` without the orphaned thing `l` (orphansIn's): a change removed, an operator's change out of its change, a cue off its thing. */
export function dropOrphan(doc, l) {
  const gone = (n) => parseSite(n)?.key === l.site;
  if (l.kind === 'cue') return { ...doc, cues: doc.cues.map((q) => (q.id === l.id ? (({ on, ...rest }) => rest)(q) : q)) };
  if (l.kind === 'change') return { ...doc, overrides: doc.overrides.filter((o) => o.id !== l.id) };
  if (l.kind === 'line') return { ...doc, overrides: doc.overrides.map((o) => (o.id !== l.id ? o : { ...o, on: { ...o.on, sites: o.on.sites.filter((n) => !gone(n)) }, code: o.code && Object.fromEntries(Object.entries(o.code).filter(([k]) => k !== l.site)) })) };
  const less = (byCh) => byCh && Object.fromEntries(Object.entries(byCh).map(([c, a]) => [c, a.filter((n) => !gone(n))]).filter(([, a]) => a.length));
  return {
    ...doc,
    overrides: doc.overrides.map((o) => (o.id !== l.id ? o : { ...o, ops: o.ops && Object.fromEntries(Object.entries(o.ops).filter(([k]) => !gone(k))), order: less(o.order), muted: less(o.muted), code: o.code && Object.fromEntries(Object.entries(o.code).filter(([k]) => k !== l.site)) })),
  };
}

// (a value as text with its objects' keys in order: two docs that say the same read the same)
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
/**
 * What of a timeline its film sees, as text to compare: all of it but the code its changes remember, the cues the film
 * does not follow (`follows`: their ids) and its sound — audio tracks, the media only they play, the mixer's buses and master
 * (the editor plays the sound itself; the film draws only visual tracks' pictures: engine/runtime.js), so an edit to
 * the sound never renders a frame again — but for the parts the film reads (`follows`' "part:<id>": engine/score.js hits),
 * whose notes and clips it moves with — and a master's samples (the viewer's frames take the viewer's). Of a cue the film
 * reads only by its time and length (`at`, `end`: elements/cues.js), only they: its note and label change no frame.
 * `overrides: false` is what its pages load: without its changes and the things added by hand (the film takes them in as
 * they are edited), nor the shutter and samples, which each frame is asked for with (tools/worker.mjs frame).
 */
export function filmSees(doc, follows, { overrides = true } = {}) {
  const d = strip(doc), tracks = (d.tracks ?? []).filter((t) => t.kind === 'visual').map((t) => (overrides ? t : { ...t, clips: t.clips.filter((c) => !c.thing) })), seen = new Set(tracks.flatMap((t) => t.clips.map((c) => c.media)));
  const parts = [...follows].filter((f) => f.startsWith('part:')).map((f) => f.slice(5)).sort();
  const heard = parts.map((id) => [id, d.media?.[id] ?? null, (d.tracks ?? []).filter((t) => t.kind !== 'visual').flatMap((t) => t.clips.filter((c) => c.media === id).map((c) => [c.at, c.in, c.out, c.speed ?? 1]))]);
  return canon({ ...d, tracks, media: Object.fromEntries(Object.entries(d.media ?? {}).filter(([id]) => seen.has(id))), master: undefined, buses: undefined,
    shutter: overrides ? d.shutter : undefined, samples: overrides ? d.samples?.viewer : undefined,
    cues: (d.cues ?? []).filter((c) => follows.has(c.id)).map((c) => (follows.has(`whole:${c.id}`) ? c : { id: c.id, t: c.t, dur: c.dur })),
    overrides: overrides ? d.overrides ?? [] : undefined, ...(heard.length && { parts: heard }) });
}
/** What a film follows of its timeline, as filmSees takes it: the cues it reads (by id; whole:<id> where it reads more of
 *  one than its time and length) and the parts (part:<id>), from what it reported as it loaded ({ cues, parts }:
 *  engine/runtime.js). */
export const followed = (film) => new Set([...(film?.cues ?? []).flatMap((c) => (c.whole ? [c.id, `whole:${c.id}`] : [c.id])), ...(film?.parts ?? []).map((p) => `part:${p.id}`)]);
