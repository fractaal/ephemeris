// A timeline's format, as it changes: each change a migration of its own in this folder (<version>-<what>.mjs, exporting
// { version, what, migrate(doc) → { doc, said: [what it did, in words] } }), the function from the format before it
// (version − 1) to its own. A timeline names its format (`version`); one older than VERSION is migrated as it is read,
// each migration in turn. Where the studio reads a project's timeline to work on it (its server, opening one: tools/nle.mjs
// migrateFile), it keeps a version of the project first (its history), so the History can undo a migration, and writes
// the timeline in the new format; what only reads one (a render, the command line, a timeline an agent gives) migrates
// it as it reads it. Reading one into the format also gives it what the format has and a timeline written by hand or by
// an agent may leave out (complete): a cue's length, 0 for a point.
import fs from 'node:fs';
import * as instrumentsOnTracks from './2-instruments-on-tracks.mjs';

const MIGRATIONS = [instrumentsOnTracks].sort((a, b) => a.version - b.version);
/** The format a timeline is written in now. */
export const VERSION = Math.max(1, ...MIGRATIONS.map((m) => m.version));

/** A timeline (parsed) in the format VERSION: { doc, from (its format before), said: [what each migration did] }; the
 *  doc itself where it was in it already. */
export function migrate(doc) {
  const from = doc?.version ?? 1, said = [];
  let d = doc;
  if (from < VERSION) for (const m of MIGRATIONS) {
    if (m.version <= (d.version ?? 1)) continue;
    const r = m.migrate(d);
    d = { ...r.doc, version: m.version };
    said.push(...r.said.map((x) => `${m.what}: ${x}`));
  }
  const c = complete(d);
  return { doc: c.doc, from, said: [...said, ...c.said] };
}
// a timeline with what the format has that it left out (the doc itself where it left nothing out): a cue without a
// length is a point (dur 0), as the editor makes one; without one, the timeline's end is not a number
function complete(doc) {
  const short = (Array.isArray(doc?.cues) ? doc.cues : []).filter((q) => q && typeof q === 'object' && q.dur == null);
  if (!short.length) return { doc, said: [] };
  return { doc: { ...doc, cues: doc.cues.map((q) => (short.includes(q) ? { ...q, dur: 0 } : q)) },
    said: [`${short.length === 1 ? 'a cue' : `${short.length} cues`} without a length (${short.map((q) => `"${q.label || q.id}"`).join(', ')}): ${short.length === 1 ? 'a point' : 'points'}, dur 0`] };
}
/** A timeline's text in the format VERSION: { text, from, said } (text as it was where it was in it already and left
 *  nothing out, or is not a timeline). format(doc): how the studio writes one (nle/model.js format). */
export function migrateText(text, format) {
  let doc;
  try { doc = JSON.parse(text); } catch { return { text, from: null, said: [] }; }
  if (!doc || typeof doc !== 'object') return { text, from: null, said: [] };
  const r = migrate(doc);
  return r.doc === doc ? { text, from: r.from, said: [] } : { text: format(r.doc), from: r.from, said: r.said };
}
/** A timeline's file read in the format VERSION (parsed; the file left as it is). */
export const readTimeline = (file) => migrate(JSON.parse(fs.readFileSync(file, 'utf8'))).doc;
