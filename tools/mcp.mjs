// Ephemeris over MCP (stdio): the studio's eyes and hands for any agent — Claude in the studio's own panel, Claude
// Code, Codex, any client. One server, the same tools everywhere: each connection selects its own project/timeline
// (status, frames, picking, what a thing's motion is made of, the timeline), and read the manual. Film code is edited
// with the agent's own file tools (projects/<name>/film.js); the studio watches it and renders again.
//
//   ./ephemeris mcp [--studio http://localhost:5340] [--project <name>] [--timeline main]
//   claude mcp add ephemeris -- <repo>/ephemeris mcp          (Claude Code)
//   codex: [mcp_servers.ephemeris] command = "<repo>/ephemeris", args = ["mcp"]
//
// It talks to a running studio (./ephemeris). Editor navigation never retargets a connection. Nothing but the protocol
// goes to stdout.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Stack, setOverrides, asLanes } from '../engine/motion.js';
import { orphansIn, parseSite, renameSites } from '../nle/anchors.js';
import os from 'node:os';
import { retime, speedOf, clipEnd, isVisual, isNotes, format, automatedKeys, notesClips, INSTRUMENT } from '../nle/model.js';
import { clipAt } from '../nle/automation.js';
import { describeProfile } from './profile.mjs';
import { played, partNotes, ownNotes } from '../engine/score.js';
import { scoreOf } from './score.mjs';
import { when } from './history.mjs';
import { parts as gridParts, nearest, position, timeOf } from '../engine/grid.js';
import { parse as parseNotes, write as writeNotes, noteName, NotationError } from './notation.mjs';
import { describe as describeSong, SURE } from './music.mjs';
import { survey, table, placed, soundFiles, measure } from './sound.mjs';
import { devices, describe as describeInstrument, change as changeInstrument, lanesOf, audition, InstrumentError } from './devices.mjs';
import { deviceOf, textOf } from '../nle/device.js';
import { describe as describeMixer, change as changeMixer, MixerError } from './mixer.mjs';
import { levels, bands, meter, BANDS } from './levels.mjs';
import { pitch, table as pitchTable } from './pitch.mjs';
import { sources, render, decode as decodeStereo, writeWav } from './mix.mjs';
import { midi } from '../engine/sound/core.js';
import { depthLayers, describe as describeDepth } from './depth.mjs';
import { migrate } from './migrations/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const STUDIO = (arg('--studio') ?? process.env.EPHEMERIS_STUDIO ?? 'http://localhost:5340').replace(/\/$/, '');
const AGENT = arg('--agent');
let selected = arg('--project') ? { name: arg('--project'), tid: arg('--timeline') ?? 'main' } : null;
const log = (...a) => console.error('[ephemeris mcp]', ...a);

// ---------- the studio
class StudioError extends Error {}
async function get(url, o = {}) {
  let r;
  try { r = await fetch(url, { ...o, signal: AbortSignal.timeout(o.timeout ?? 120_000) }); }
  catch (e) { throw new StudioError(`The studio is not answering at ${STUDIO} (${e.cause?.code ?? e.message}). Start it with ./ephemeris (or pass --studio).`); }
  return r;
}
const json = async (r) => { const b = await r.json().catch(() => ({})); if (!r.ok || b?.error) throw new StudioError(b?.error ?? `${r.status} ${r.statusText}`); return b; };
// Panel connections have a project-owned target in the registry. External clients choose explicitly, or bind once
// to the last editor opened; neither follows subsequent navigation. `open` changes only this connection's target.
async function opened() {
  let o = selected;
  if (AGENT) o = await json(await get(`${STUDIO}/api/agents/${encodeURIComponent(AGENT)}/target`));
  else if (!o) {
    const s = await json(await get(`${STUDIO}/api/studio`));
    if (!s.open) throw new StudioError('No timeline is selected. Open one with the open tool (projects lists them), or pass --project.');
    const [name, tid] = s.open.split('/');
    o = selected = { name, tid };
  }
  return { ...o, base: `${STUDIO}/p/${encodeURIComponent(o.name)}/${encodeURIComponent(o.tid)}/` };
}
// (each request an agent's: where the studio queues, the director's own go first)
const api = async (p, body) => { const o = await opened(); return json(await get(o.base + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, agent: true }) })); };
const state = () => api('api/state');

// ---------- results
const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e instanceof StudioError ? e.message : String(e?.stack ?? e) }] });
const tool = (fn) => async (args) => { try { return await fn(args ?? {}); } catch (e) { return fail(e); } };

// ---------- the manual: docs/manual's chapters and the agent skills, by name
function chapters() {
  const out = [];
  const md = (dir, prefix) => { try { for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith('.md')) out.push({ id: `${prefix}${f.replace(/\.md$/, '').replace(/^SKILL$/, '').replace(/^README$/, 'index')}`.replace(/\/$/, ''), file: path.join(dir, f) }); } catch { /* none */ } };
  md('docs/manual', '');
  try { for (const s of fs.readdirSync(path.join(ROOT, '.agents/skills'))) md(`.agents/skills/${s}`, `skill/${s}/`); } catch { /* none */ }
  return out.map((c) => ({ ...c, title: (fs.readFileSync(path.join(ROOT, c.file), 'utf8').match(/^#\s+(.+)$/m)?.[1] ?? c.id).trim() }));
}

const server = new McpServer({ name: 'ephemeris', version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version }, {
  instructions: `Ephemeris is a motion design studio: films are code (projects/<name>/film.js, on the engine in engine/), directed in a studio where the director blocks out cues and music and changes the film's motion by hand (motion lanes: the timeline's overrides). These tools see and change the timeline selected for this agent, not whichever project the director is viewing. status names it; open selects another timeline for this connection only. Panel agents stay in their assigned project. The director and other agents share the live files; read current contents before editing and preserve changes you did not make.
Start with status. Look before and after you change something (frames). To understand what is on screen: pick (what is at a point), objects (what the code places, each thing with every line that places it and a loop's copies as one, and when each is in the scene), locate (where it is at another moment), stacks (what its motion is made of: the code's operators and the director's changes), track (how the camera and things move on screen over a span, without rendering). Cues, music, the mixer and overrides are in the timeline (timeline, write_timeline); the mixer is read and changed by strip with mixer (volume, pan, effects and their params in their units, sends, buses), checked first; notes clips are read and written in bars and beats (notes, write_notes), and what plays them — each track's instrument, which plays the notes clips on it: the Ephemeris Sampler or a plugin (Vial, the studio's synth), alike — is read, changed, automated and heard with instruments, set_instrument and audition; retime moves everything after a time when a scene's length changes; reattach puts a change your code edit orphaned back on its code; media lists what the director brought in. You cannot listen, so measure: music (the songs' tempo, bars, drops and parts, in film time; the timeline's grid follows the music unless the director set it), sounds (what sound files are like, or where each sound the timeline plays lands: its peak against the beat and the cues), pitch (the notes a recording plays, and their tuning), levels (the mix's loudness, the voice over the rest, the mix by octave, what drives the master; a variant before you write it), bounce (the mix or a track as a file). Read the sound skill (manual: skill/sound) before working on sound or music. Before writing film code, read the manual (manual: "motion" and "skill/engine"); reference says what an engine name is and how it is called. Run check before you say you are done.
The director's cues and overrides are theirs: never move, rename or drop them unless asked (a change they ask for that lengthens or shortens a scene asks for the later ones to keep in step: retime); fold overrides into code only when asked (the motion chapter says how).`,
});

// ---------- what is open, and opening another
server.registerTool('status', {
  title: 'Studio status',
  description: 'What this agent has selected: the project and timeline, its film (page, duration, fps, cuts, the cues it follows), how far the viewer\'s frames have rendered, a draft render, any error, and the director\'s changes orphaned by an edit to the code they were on. Start here, and look again after you edit film code.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, tool(async () => {
  const o = await opened(), s = await state(), d = JSON.parse(s.text), p = s.accurate ?? s.preview, f = p.frames ?? '';   // (the film as it renders, whatever look the viewer shows)
  const count = (c) => [...f].filter((x) => x === c).length;
  return text({
    open: `${o.name}/${o.tid}`, project: s.dir, timelineFile: s.file, filmPage: s.url, engine: s.engine,
    film: { duration: p.duration, fps: p.fps, cuts: p.cuts, followsCues: (p.cues ?? []).map((c) => c.id) },
    frames: { total: f.length, fresh: count('2') + count('3'), stale: count('1'), notYet: count('0'), working: p.working, prerender: p.prerender },
    error: p.error || null, draft: s.draft ?? null, render: s.render ?? null,
    timeline: { cues: d.cues.length, tracks: d.tracks.length, overrides: (d.overrides ?? []).length, fps: d.fps, grid: d.grid },
    ...(orphansIn(d).length && {
      orphaned: orphansIn(d).map(({ override, cue, ...l }) => ({ ...l, changes: l.kind === 'cue' ? 'a cue on this thing' : l.kind === 'change' ? override : override.ops?.[Object.keys(override.ops ?? {}).find((k) => k === l.site || k.startsWith(`${l.site}#`))] ?? 'its lane order or mute' })),
      orphanedHelp: 'The director\'s changes whose code was edited (the line they were on changed, or now reads the same in two places), so they no longer apply. If you made that edit, attach each again: in the timeline, rename its orphan:file:line:col names to where that code now is (keep any #n), or remove it if the code it changed is gone, and say so. Otherwise tell the director. (manual: motion)',
    }),
  });
}));
server.registerTool('projects', {
  title: 'Projects', description: 'The studio\'s projects: name, timelines, duration, cues, when last edited, and which is open.', inputSchema: {}, annotations: { readOnlyHint: true },
}, tool(async () => text(await json(await get(`${STUDIO}/api/projects`)))));
server.registerTool('open', {
  title: 'Open a timeline',
  description: 'Selects a project\'s timeline for this agent (main by default), without moving the director or other agents. A panel agent can select timelines within its assigned project only.',
  inputSchema: { project: z.string().describe('The project\'s name (projects/<name>)'), timeline: z.string().optional().describe('Its timeline (main by default)') },
}, tool(async ({ project, timeline = 'main' }) => {
  if (AGENT) {
    await json(await get(`${STUDIO}/api/agents/${encodeURIComponent(AGENT)}/target`, { method: 'POST', body: JSON.stringify({ project, timeline }) }));
  } else {
    await json(await get(`${STUDIO}/p/${encodeURIComponent(project)}/${encodeURIComponent(timeline)}/api/state`));
    selected = { name: project, tid: timeline };
  }
  readText = null;
  return text(`Selected ${project}/${timeline} for this agent. Other agents and editors have not moved.`);
}));

// ---------- the timeline: cues, music, overrides
// What this agent last read of the timeline (the timeline tool), followed through its own writes: write_timeline writes
// over that, so it fails where the file has changed since (the director's edits are never written over unseen)
let readText = null;
/** Writes `doc` over `base` (the timeline's text as it was read), kept as a version of the project → the studio's answer
 *  ({ version: its number, or null where nothing changed }); a
 *  StudioError with conflict: true where the file is no longer `base`. */
async function put(doc, base, message) {
  const o = await opened();
  const r = await get(`${o.base}api/timeline`, { method: 'PUT', body: JSON.stringify({ text: JSON.stringify(doc, null, 2) + '\n', base, message: `${message}\n\n(written by an agent through the ephemeris MCP)`, agent: true }) });
  const b = await r.json().catch(() => ({}));
  if (r.status === 409) throw Object.assign(new StudioError('The timeline changed since it was read (the director, or an edit in flight). Nothing was written.'), { conflict: true });
  if (!r.ok || b.error) throw new StudioError(b.error ?? `${r.status}`);
  if (readText === base) readText = b.text ?? format(doc);   // (the studio saves it in its own layout)
  return b;
}
// a notes medium's notes in the timeline's text as how many there are (a part is hundreds of lines: notes reads them)
const ELIDED = /^(\d+) notes \(/;
const elided = (doc) => ({ ...doc, media: Object.fromEntries(Object.entries(doc.media ?? {}).map(([id, m]) => [id, isNotes(m) ? { ...m, notes: `${m.notes.length} notes (the notes tool reads them, write_notes writes them; write_timeline keeps them as they are)` } : m])) });
server.registerTool('timeline', {
  title: 'Read the timeline',
  description: 'The open timeline\'s file (timelines/<id>.json): fps, shutter, grid, cues (the director\'s: label, note, time, range; `on` pins a cue to a thing), tracks and their clips (audio; and pictures, kind "visual": images and videos the film shows in the world, each where its clip starts, under the film\'s camera; their media entries carry kind, w, h, and a video\'s duration, fps and frames), the mixer (each audio track\'s volume, pan, fx, sends; buses; master), and overrides (the director\'s changes to the film\'s motion; the manual\'s motion chapter has the schema). A notes medium\'s notes show as how many there are: the notes tool reads them.',
  inputSchema: {}, annotations: { readOnlyHint: true },
}, tool(async () => { const s = await state(); readText = s.text; return text(`${JSON.stringify(elided(JSON.parse(s.text)), null, 2)}\n`); }));
server.registerTool('write_timeline', {
  title: 'Write the timeline',
  description: 'Replaces the open timeline\'s file with `text` (the whole JSON, as timeline returns it, changed) and keeps it as a version of the project, saying `message`; the director\'s editor reloads it. A notes medium whose notes are as timeline shows them ("312 notes (…)") keeps its notes as they are (write_notes changes them). Fails, writing nothing, where the file changed since you last read it with timeline (read it again and redo the change). Keep the director\'s cues and overrides unless asked.',
  inputSchema: { text: z.string().describe('The whole timeline JSON'), message: z.string().describe('What changed and why: the version\'s message in the history') },
}, tool(async ({ text: t, message }) => {
  let doc;
  try { doc = JSON.parse(t); } catch (e) { throw new StudioError(`Not JSON: ${e.message}`); }
  if (!Array.isArray(doc.cues) || !Array.isArray(doc.tracks)) throw new StudioError('A timeline has cues and tracks (arrays): read it with the timeline tool and change that.');
  if (readText == null) throw new StudioError('Read the timeline first (the timeline tool): write_timeline replaces what you read, and fails where it has changed since. Nothing was written.');
  const base = readText, was = JSON.parse(base).media ?? {};
  for (const [id, m] of Object.entries(doc.media ?? {})) {
    if (typeof m?.notes !== 'string' || !ELIDED.test(m.notes)) continue;
    if (!isNotes(was[id])) throw new StudioError(`media "${id}" has its notes as the timeline tool shows them ("${m.notes.slice(0, 20)}…"), and the timeline you read has no notes medium "${id}" to keep them from: give its notes, or write them with write_notes. Nothing was written.`);
    m.notes = was[id].notes;
  }
  let b;
  try { b = await put(doc, base, message); } catch (e) { throw e.conflict ? new StudioError('The timeline changed since you read it (the director, or an edit in flight). Nothing was written: read it again (timeline) and redo your change on it.') : e; }
  return text(b.version ? `Written: version ${b.version}.` : 'Nothing changed: the timeline already reads so.');
}));
// (a diff over this many characters is cut: one file's alone is asked for with path)
const DIFF_MAX = 40_000;
const cut = (d) => (d.length <= DIFF_MAX ? d : `${d.slice(0, DIFF_MAX)}\n… ${d.slice(DIFF_MAX).split('\n').length} more lines: ask for one file's (path)`);
server.registerTool('history', {
  title: 'The project\'s history',
  description: 'The open project\'s versions, newest first, with their tags. A version is the whole project (every timeline and the film\'s code; not media, assets or instruments), kept whenever it changes: each edit the director makes, each write of yours, each change to the code, saying what changed and which files. `version`: what that version changed, as a unified diff. `since`: everything that changed from that version to now (what the director did since your last draft, say). `path`: that file\'s diff alone. A tag stands for its version anywhere one is asked for.',
  inputSchema: {
    version: z.union([z.number().int(), z.string()]).optional().describe('A version (its number or a tag): its diff from the one before'),
    since: z.union([z.number().int(), z.string()]).optional().describe('A version (its number or a tag): the diff from it to the latest'),
    path: z.string().optional().describe('One file\'s diff alone (timelines/main.json, film.js)'),
  },
  annotations: { readOnlyHint: true },
}, tool(async ({ version, since, path: only }) => {
  if (version == null && since == null) {
    const list = await api('api/history'), files = (h) => [...h.changed, ...h.added.map((f) => `+${f}`), ...h.removed.map((f) => `-${f}`)].join(', ');
    return text(list.slice(0, 80).map((h) => `${h.n}${h.tags?.length ? ` (${h.tags.join(', ')})` : ''}  ${when(h)}  ${h.message.split('\n')[0]}  [${files(h)}]`).join('\n') || 'No versions yet.');
  }
  // (a version by its tag: its number, for the one before it)
  const n = version == null ? null : typeof version === 'number' ? version : (await api('api/history')).find((h) => h.tags?.includes(version))?.n;
  if (version != null && n == null) return text(`No version is tagged "${version}".`);
  const q = new URLSearchParams(version != null ? { from: n - 1, to: n } : { from: since });
  if (only) q.set('path', only);
  const d = await api(`api/diff?${q}`);
  return text(d.diff ? `Version ${d.from} → ${d.to}:\n${cut(d.diff)}` : `Nothing changed from version ${d.from} to ${d.to}${only ? ` in ${only}` : ''}.`);
}));
server.registerTool('restore', {
  title: 'Restore a version',
  description: 'Brings the whole project back to a version (history lists them): its timelines and the film\'s code together, the files it did not have removed; media, assets and instruments stay as they are. What is there now is kept first, and the restore is a version of its own, so it can be undone by restoring the one before. The director\'s editor reloads. Ask the director before restoring over their work.',
  inputSchema: { version: z.union([z.number().int(), z.string()]).describe('The version to bring back: its number or a tag') },
}, tool(async ({ version }) => {
  const r = await api('api/restore', { n: version });
  readText = null;   // (the timeline as read is no longer what is there)
  return text(r.version ? `Restored version ${version}: now version ${r.version}.` : `The project already is as version ${version} keeps it.`);
}));
server.registerTool('tag', {
  title: 'Tag a version',
  description: 'Names a version, as a git tag does ("sent to client", "before-graze"): history shows it, and history and restore take it for the version. A tag names one version; a name already on another is refused unless `force` moves it. `remove` takes a tag away. Tags are the director\'s marks too: ask before moving or removing one you did not make.',
  inputSchema: {
    name: z.string().describe('The tag: no spaces, none of ~^:?*[\\, not starting with -, not a number'),
    version: z.union([z.number().int(), z.string()]).optional().describe('The version to tag (its number or another tag); the latest where left out'),
    force: z.boolean().optional().describe('Move the tag here from the version it names'),
    remove: z.boolean().optional().describe('Take the tag away'),
  },
}, tool(async ({ name, version, force, remove }) => {
  const t = await api('api/tags', { name, n: version, force, remove });
  return text(remove ? `Removed the tag "${name}".` : `Tagged version ${t[name]} "${name}".`);
}));

// ---------- notes clips, as text in bars and beats (tools/notation.mjs)
const r3 = (x) => Math.round(x * 1e3) / 1e3, r6 = (x) => Math.round(x * 1e6) / 1e6;
// where a notes medium plays: its clips by start; the first maps its own seconds to the film's
function placing(doc, id) {
  const clips = doc.tracks.filter((t) => !isVisual(t)).flatMap((t) => t.clips.filter((c) => c.media === id).map((c) => ({ c, t }))).sort((a, b) => a.c.at - b.c.at);
  const c = clips[0]?.c, sp = c ? speedOf(c) : 1;
  return { clips, sp, toFilm: (t) => (c ? c.at + (t - c.in) / sp : t), toMedium: (f) => (c ? c.in + (f - c.at) * sp : f) };
}
const instrumentWords = (i = {}) => (i.plugin ? `the plugin ${i.plugin}${i.state ? ` (${i.state})` : ''}` : i.sampler ? `the sampler ${i.sampler}` : i.sfz ? `the SFZ ${i.sfz}` : i.named ? `the samples in ${i.named}` : i.preset || i.synth ? 'the Ephemeris Synth, which is gone (silent: Vial plays synth sounds)' : 'no instrument');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`, barsWords = (s) => (String(s).includes('-') ? `bars ${s}` : `bar ${s}`);
const range = (ns) => { const lo = noteName(Math.min(...ns)), hi = noteName(Math.max(...ns)); return lo === hi ? lo : `${lo}–${hi}`; };
const barsOf = (s) => { const m = /^(-?\d+)(?:-(-?\d+))?$/.exec(String(s).trim()); if (!m || (m[2] != null && +m[2] < +m[1])) throw new StudioError(`bars is a bar or a range of them, counted from 0: "4" or "4-11", not "${s}". Nothing was written.`); return [+m[1], m[2] != null ? +m[2] : +m[1]]; };
const barAt = (g, t) => position(g, t + 5e-4).bar;
const posWords = (g, t) => { const { bar, beat } = position(g, t + 5e-4); return `${bar}.${+beat.toFixed(2)}`; };
const gridWords = (g) => `${g.bpm ?? 120} bpm, ${g.beatsPerBar ?? 4} beats a bar${g.map?.length > 1 ? ` (a tempo map of ${g.map.length} parts: the bars follow it)` : ''}${g.auto ? ', from the music' : ''}`;
const whereWords = (doc, id) => placing(doc, id).clips.map(({ c, t }) => `"${t.name}" ${c.at.toFixed(2)}–${clipEnd(c).toFixed(2)} s (bars ${barAt(doc.grid ?? {}, c.at)}–${barAt(doc.grid ?? {}, clipEnd(c) - 1e-3)})`);
// what plays a notes medium: the instruments of the tracks its clips are on (a track's instrument plays its notes clips)
const playedByWords = (doc, id) => { const ts = [...new Map(placing(doc, id).clips.map(({ t }) => [t.id, t])).values()]; return ts.length ? ts.map((t) => `${instrumentWords(t.instrument)}${ts.length > 1 ? ` on "${t.name}"` : ''}`).join(', ') : 'nothing yet (no track plays it)'; };
const NOTATION = 'The text: one line a note or chord — position (the studio\'s bar.beat.sixteenth from 0, as its ruler counts: 4.2, 4.2.3, 4.1+1/3, 4.2-12ms), notes (C4 = 60, F#3, Bb2, or MIDI numbers; a chord\'s note may carry its own velocity, C4:.6), length (1/16, 1/8., 1/8t, 1.5b, 2bar, 250ms), velocity (0–1, .8 unless set) — or a drum row, [@bars] [label] note steps [±ms] (@8-15 kick 36 x...x...x...x... : a character a sixteenth, X accent, x hit, o ghost, 1–9 tenths, . rest, | ignored; repeated over the bars). @8-15 before a line repeats it every bar (@8-15/2: every two), its bar counted from each repeat\'s first. Lines `swing 58%`, `vel .7`, `len 1/8`, `steps 12` set what follows; # comments.';

// the timeline with notes medium `media` written: → { doc, said, msg }
function notesWritten(doc, { media, notation, bars, add = false, instrument, track, name }) {
  const g = doc.grid ?? {}, d = structuredClone(doc);
  let parsed;
  try { parsed = parseNotes(notation, g); } catch (e) { throw e instanceof NotationError ? new StudioError(`${e.message}. Nothing was written.`) : e; }
  const { notes } = parsed, range = bars != null ? barsOf(bars) : null;
  const from = range ? timeOf(g, range[0]) : -Infinity, to = range ? timeOf(g, range[1] + 1) : Infinity;
  if (!notes.length && !range) throw new StudioError('No notes in `notation`. To empty bars of a part, give `bars` and no notes. Nothing was written.');
  if (range) { const out = notes.find((n) => n.t < from - 5e-4 || n.t >= to - 5e-4); if (out) throw new StudioError(`A note (${noteName(out.note)} at ${posWords(g, out.t)}) starts outside ${barsWords(bars)}: write only the notes of the bars you replace, or widen \`bars\`. Nothing was written.`); }
  let m = d.media?.[media], made = null;
  if (m && !isNotes(m)) throw new StudioError(`media "${media}" is a file (${m.src}), not notes: name another. Nothing was written.`);
  if (!m) {
    if (!notes.length) throw new StudioError('A new part needs notes. Nothing was written.');
    const [lo, hi] = range ?? parsed.bars, at = r6(Math.max(0, Math.min(timeOf(g, lo), notes[0].t)));
    const end = Math.max(timeOf(g, hi + 1), ...notes.map((n) => n.t + n.dur));
    d.media ??= {};
    m = d.media[media] = { kind: 'audio', name: name ?? media, notes: [], length: r3(end - at) };
    const ids = new Set(d.tracks.flatMap((t) => [t.id, ...t.clips.map((c) => c.id)])), fresh = (k) => { let n = 1; while (ids.has(`${k}${n}`)) n++; ids.add(`${k}${n}`); return `${k}${n}`; };
    let tr = d.tracks.find((t) => !isVisual(t) && (t.id === track || t.name === track));
    if (!tr && !instrument) throw new StudioError(`A new track plays "${media}": give its \`instrument\` (what plays the track's notes: the sound skill: { plugin: "Vial", state: "presets/Vial/pluck.vital" }, { sampler: "instruments/kit.json" }), or name a \`track\` that has one. Nothing was written.`);
    if (tr && !tr.instrument && !instrument) throw new StudioError(`"${tr.name}" has no instrument yet: give \`instrument\` (what plays its notes clips). Nothing was written.`);
    if (!tr) { tr = { id: fresh('a'), name: track ?? name ?? media, clips: [] }; d.tracks.push(tr); }
    tr.clips.push({ id: fresh('c'), media, at, in: 0, out: m.length, gain: 0, fadeIn: 0, fadeOut: 0 });
    made = tr.name;
  }
  // (an instrument given: the instrument of the track named, else of each track that plays the medium)
  if (instrument) for (const t of d.tracks.filter((y) => !isVisual(y) && (track ? y.id === track || y.name === track : y.clips.some((c) => c.media === media)))) t.instrument = instrument;
  if (name) m.name = name;
  const p = placing(d, media), written = notes.map((n) => ({ t: r6(p.toMedium(n.t)), dur: r6(n.dur * p.sp), note: n.note, vel: n.vel }));
  const early = written.find((n) => n.t < -5e-4);
  if (early) throw new StudioError(`A note (${noteName(early.note)} at ${posWords(g, notes[written.indexOf(early)].t)}) comes before "${media}" starts (where its first clip starts it: ${p.toFilm(0).toFixed(2)} s, bar ${barAt(g, p.toFilm(0))}): move the clip earlier (its at and in), or write that part as a part of its own. Nothing was written.`);
  const inRange = (n) => { const f = p.toFilm(n.t); return f >= from - 5e-4 && f < to - 5e-4; };
  const kept = add ? m.notes : m.notes.filter((n) => !inRange(n)), replaced = m.notes.length - kept.length;
  m.notes = [...kept, ...written.map((n) => ({ ...n, t: Math.max(0, n.t) }))].sort((a, b) => a.t - b.t || a.note - b.note);
  // its length, and the clip that showed all of it, past its last note (as the piano roll makes them)
  const last = Math.max(0, ...m.notes.map((n) => n.t + n.dur)), was = m.length;
  if (was != null && last > was) { m.length = r3(last + 0.5); for (const { c } of p.clips) if (c.in === 0 && c.out >= was - 1e-3) c.out = m.length; }
  const unheard = written.filter((n) => !p.clips.some(({ c }) => n.t >= c.in - 1e-6 && n.t < c.out));
  const where = whereWords(d, media);
  const said = `${made ? `Made "${media}" (played by ${playedByWords(d, media)}) on "${made}". ` : ''}Wrote ${plural(written.length, 'note')} into "${media}"${range ? ` in ${barsWords(bars)}` : ''}${replaced ? ` in place of ${replaced}` : ''}${add ? ' (added to its notes)' : ''}: it has ${m.notes.length}, played on ${where.join(', ') || 'no clip'}${unheard.length ? `. ${unheard.length} of the notes written fall outside its clips (the first at ${posWords(g, p.toFilm(unheard[0].t))}): they are not heard until a clip covers them (its in and out)` : ''}`;
  return { doc: d, said, msg: `"${m.name ?? media}": ${plural(written.length, 'note')}${range ? ` in ${barsWords(bars)}` : ''}${made ? ', a new part' : ''}` };
}
server.registerTool('notes', {
  title: 'Read notes clips',
  description: `The timeline's notes clips, as text in bars and beats that write_notes takes back. Without \`media\`: each notes medium — its name, instrument, how many notes and their range, where its clips play it (track, seconds, bars). With \`media\`: its notes, a line each (chords one line), on the timeline's grid as its first clip plays it; \`bars\` ("4-11") only the notes that start in them; \`tab\` drum rows where a drum's hits keep to the sixteenths. Lines starting with # are comments; the rest, pasted into write_notes is the same notes, within half a millisecond. ${NOTATION}`,
  inputSchema: { media: z.string().optional(), bars: z.string().optional(), tab: z.boolean().optional() }, annotations: { readOnlyHint: true },
}, tool(async ({ media, bars, tab = false }) => {
  // (the parts as heard: those whose notes the film's sound code writes, with the director's edits over them)
  const s = await state(), raw = JSON.parse(s.text), sc = await scoreOf(s.root, raw).catch(() => null), doc = played(raw, sc), g = doc.grid ?? {}, all = Object.entries(doc.media ?? {}).filter(([, m]) => isNotes(m));
  const fromCode = (id) => (sc?.notes?.[id] ? ` (written by sound.js${raw.media[id]?.notes?.length || raw.media[id]?.removed?.length ? `, with ${plural(raw.media[id].notes?.length ?? 0, 'note')} of the director's and ${plural(raw.media[id].removed?.length ?? 0, 'note')} of its taken away` : ''})` : '');
  if (!media) {
    if (!all.length) return text('The timeline has no notes clips: write_notes makes one.');
    return text([`The grid: ${gridWords(g)}.`, ...all.map(([id, m]) => {
      const ns = m.notes.map((n) => n.note), where = whereWords(doc, id);
      return `${id}${m.name && m.name !== id ? ` ("${m.name}")` : ''}: ${plural(m.notes.length, 'note')}${fromCode(id)}${ns.length ? `, ${range(ns)}` : ''}, played by ${playedByWords(doc, id)}; ${where.length ? `plays on ${where.join(', ')}` : 'no clip plays it'}`;
    })].join('\n'));
  }
  const m = doc.media?.[media];
  if (!isNotes(m)) throw new StudioError(`No notes medium "${media}"${doc.media?.[media] ? ' (it is a file)' : ''}. The notes media: ${all.map(([id]) => id).join(', ') || 'none'}.`);
  const p = placing(doc, media), [a, b] = bars != null ? barsOf(bars) : [-Infinity, Infinity];
  const film = m.notes.map((n) => ({ t: p.toFilm(n.t), dur: n.dur / p.sp, note: n.note, vel: n.vel ?? 0.8 })).filter((n) => { const bar = barAt(g, n.t); return bar >= a && bar <= b; }).sort((x, y) => x.t - y.t || x.note - y.note);
  const where = whereWords(doc, media);
  return text([
    `# ${media}${m.name && m.name !== media ? ` ("${m.name}")` : ''}: ${bars != null ? `${film.length} of its ${plural(m.notes.length, 'note')} in ${barsWords(bars)}` : plural(film.length, 'note')}${fromCode(media)}, played by ${playedByWords(doc, media)}`,
    `# ${where.length ? `plays on ${where.join(', ')}${where.length > 1 ? ' (bars as the first plays it)' : ''}` : 'no clip plays it (bars as if it started at 0 s)'}; the grid: ${gridWords(g)}`,
    writeNotes(film, g, { tab }),
  ].join('\n'));
}));
server.registerTool('write_notes', {
  title: 'Write a notes clip',
  description: `Writes a notes clip's notes from text in bars and beats (as the notes tool reads them) and keeps it as a version of the project; the director's editor and piano roll show it at once, and nothing else in the timeline changes (it is written on the timeline as it is then, the director's edits kept). \`media\`: the notes medium; a new one is made where there is none, its clip on \`track\` (a track's name or id: else a track of its own, named so, which needs \`instrument\`); its clip covers the bars written. A track's instrument plays its notes clips (the medium has none of its own). \`bars\` ("8-15"): only the notes that start in those bars are replaced (what is written must start in them; no notes empties them); without it, all of its notes. \`add\`: keep its notes, add these. \`instrument\` sets the instrument of \`track\`, else of each track that plays the medium ({ plugin }: Vial, the studio's synth, and its presets; { sampler }, { sfz }, { named }: the sound skill), \`name\` the medium's name. ${NOTATION}`,
  inputSchema: {
    media: z.string().describe('The notes medium\'s id (a new one is made)'), notation: z.string().describe('The notes, as text'),
    bars: z.string().optional().describe('Only these bars ("8-15", from 0)'), add: z.boolean().optional(),
    instrument: z.record(z.string(), z.any()).optional(), track: z.string().optional(), name: z.string().optional(),
    message: z.string().optional().describe('The version\'s message in the history (else: what was written)'),
  },
}, tool(async (args) => {
  for (let tries = 0; ; tries++) {
    const s = await state(), raw = JSON.parse(s.text), code = (await scoreOf(s.root, raw).catch(() => null))?.notes?.[args.media];
    // (a part whose notes the film's sound code writes: written over them as the director's edits are, the code's left
    // as they are kept as the code makes them: engine/score.js ownNotes)
    const heard = code ? { ...raw, media: { ...raw.media, [args.media]: { ...raw.media[args.media], notes: partNotes(code, raw.media[args.media]) } } } : raw;
    const { doc, said, msg } = notesWritten(heard, args);
    if (code) { const m = doc.media[args.media], o = ownNotes(code, m.notes); m.notes = o.notes; if (o.removed.length) m.removed = o.removed; else delete m.removed; }
    try { const b = await put(doc, s.text, args.message ?? msg); return text(`${said}.${b.version ? ` Version ${b.version}.` : ''}`); }
    catch (e) { if (!e.conflict) throw e; if (tries >= 2) throw new StudioError('The timeline kept changing while the notes were written (the director editing it): nothing was written. Try again.'); }   // (written again on the timeline as it is now)
  }
}));

// ---------- instruments: the Ephemeris Sampler and plugins (Vial, the studio's synth, among them), one kind of thing (tools/devices.mjs)
const tracksPlaying = (doc, id) => doc.tracks.filter((t) => !isVisual(t) && t.clips.some((c) => c.media === id));
// the track an instrument tool works on: `track` (its id or name), else the one track that plays notes medium `media`
function trackFor(doc, { track, media }) {
  const audio = doc.tracks.filter((t) => !isVisual(t));
  if (track) { const t = audio.find((y) => y.id === track || y.name === track); if (!t) throw new StudioError(`No track "${track}". The tracks: ${audio.map((y) => `"${y.name}"`).join(', ')}. Nothing was changed.`); return t; }
  if (!media) throw new StudioError('Name the track (track: its name or id): a track\'s instrument plays its notes clips. Nothing was changed.');
  notesMedium(doc, media);
  const ts = tracksPlaying(doc, media);
  if (!ts.length) throw new StudioError(`No track plays "${media}": an instrument is a track's. Nothing was changed.`);
  if (ts.length > 1) throw new StudioError(`"${media}" plays on ${ts.length} tracks (${ts.map((t) => `"${t.name}"`).join(', ')}), each with its instrument: name the one (track). Nothing was changed.`);
  return ts[0];
}
function notesMedium(doc, media) {
  const m = doc.media?.[media];
  if (!isNotes(m)) throw new StudioError(`No notes medium "${media}"${m ? ' (it is a file)' : ''}. The notes media: ${Object.entries(doc.media ?? {}).filter(([, x]) => isNotes(x)).map(([id]) => id).join(', ') || 'none'}.`);
  return m;
}
const rangeWords = (p) => (p.options ? `one of ${p.options.join(', ')}` : p.choices ? `one of ${p.choices.join(', ')}` : p.steps > 0 ? `${p.steps + 1} steps` : p.lo != null ? `${p.lo} to ${p.hi}` : p.min != null && p.steps == null ? `${textOf(p, p.min)} to ${textOf(p, p.max)}` : '0–1');
const paramRow = (p, automated) => `  ${p.title.padEnd(28)} ${String(p.text ?? p.value).padEnd(18)} ${rangeWords(p).padEnd(26)} ${p.live ? 'live' : 'next note'}${p.automatable ? '' : ', fixed'}${automated ? ', automated' : ''}${p.key !== p.title ? `   [${p.key}]` : ''}`;
function contentsWords(c = {}) {
  if (c.oscillators) return `oscillators ${c.oscillators.join(', ')}; LFOs ${c.lfos.join(', ') || 'none'}`;
  if (c.zones != null) return `${c.zones} zone${c.zones === 1 ? '' : 's'} of ${c.samples} sample${c.samples === 1 ? '' : 's'}, keys ${c.keys}, ${c.velocityLayers} velocity layer${c.velocityLayers === 1 ? '' : 's'}, round robins ${c.roundRobins}${c.list?.length ? `\n${c.list.map((z) => `  ${z.keys.padEnd(9)} root ${z.root.padEnd(4)} ${z.tune ? `tune ${z.tune} ` : ''}${z.offset != null ? `${z.offset}–${z.end ?? 'end'} s ` : ''}${z.gain ? `${z.gain} dB ` : ''}${z.loop ? `${z.loop} ` : ''}${z.sample}`).join('\n')}${c.zones > c.list.length ? `\n  … ${c.zones - c.list.length} more` : ''}` : ''}`;
  if (c.state) return `the state ${c.state} (${c.vendor})`;
  return 'nothing';
}
// a time in a point: seconds, or bar.beat[.sixteenth] as notation counts them
const timeIn = (g) => (x) => { if (typeof x === 'number') return x; const m = /^(-?\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(x).trim()); return m ? timeOf(g, +m[1], +m[2] + (m[3] != null ? +m[3] / 4 : 0)) : NaN; };
server.registerTool('instruments', {
  title: 'Instruments',
  description: 'What plays the timeline\'s notes clips: each track\'s instrument, which plays the notes clips on it — the Ephemeris Sampler and plugins (VST3s, played by their host: Vial, the studio\'s synth, among them), one kind of thing (tools/devices.mjs). Without `track`: the devices this machine plays and their presets (`query` narrows them by name), and each track\'s instrument. With `track` (its name or id; or `media`, a notes medium one track plays): its instrument — the device, its preset or state, what it holds (a sampler\'s zones, keys, layers, round robins; a plugin\'s state), what is wrong with it (a param it does not have, a sample that is not there), and its parameters, each with its value in its own words, its range, whether it moves the notes sounding (live) or the next note, and whether its track automates it; `query`: only those whose name has it (a plugin has hundreds: ask by name). set_instrument changes it, audition plays notes through it.',
  inputSchema: { track: z.string().optional(), media: z.string().optional(), query: z.string().optional(), limit: z.number().optional() }, annotations: { readOnlyHint: true },
}, tool(async ({ track, media, query = '', limit = 80 }) => {
  const s = await state(), doc = JSON.parse(s.text), dir = s.root;
  if (!track && !media) {
    const ds = await devices(dir, { query });
    const parts = doc.tracks.filter((t) => !isVisual(t) && (t.instrument || t.clips.some((c) => isNotes(doc.media?.[c.media])))).map((t) => { const d = deviceOf(t.instrument), n = t.clips.filter((c) => isNotes(doc.media?.[c.media])).length; return `  "${t.name}" (${t.id}): ${t.instrument ? `${d.device ?? 'nothing'}${d.name !== d.device ? ` · ${d.name}` : ''}` : 'no instrument (its notes clips are silent)'}; ${plural(n, 'notes clip')}`; });
    return text([`The devices${query ? ` (presets matching "${query}")` : ''}:`,
      ...ds.map((d) => `  ${d.device} (${d.kind}${d.playable ? '' : `: ${d.why}`}): ${d.presets.length + d.more} preset${d.presets.length + d.more === 1 ? '' : 's'}${d.presets.length ? `\n${d.presets.map((p) => `    ${p.name}${p.folder ? ` (${p.folder})` : ''}  ${p.spec ? JSON.stringify(p.spec) : 'set_instrument preset by its name: copied into the project'}`).join('\n')}${d.more ? `\n    … ${d.more} more (query narrows them)` : ''}` : ''}`),
      '', parts.length ? 'The tracks\' instruments:' : 'The timeline has no notes clips (write_notes makes one).', ...parts].join('\n'));
  }
  const t = trackFor(doc, { track, media }), r = await describeInstrument(dir, t.instrument, { query, limit });
  const heard = played(doc, await scoreOf(dir, doc).catch(() => null));   // (with the sound code's motions: sound.js)
  const autos = new Set(automatedKeys(heard.tracks.find((y) => y.id === t.id), heard.media));
  return text([
    `"${t.name}": ${r.device ?? 'no instrument'}${r.name && r.name !== r.device ? ` · ${r.name}` : ''}  ${JSON.stringify(t.instrument ?? null).slice(0, 200)}`,
    r.problems.length ? `Problems: ${r.problems.join('; ')}` : 'No problems found.',
    `It holds: ${contentsWords(r.contents)}`,
    `${r.count} parameters${query ? `; ${r.params.length}${r.more ? ` (+${r.more})` : ''} with "${query}"` : r.more ? `; the first ${r.params.length} (query narrows them)` : ''} — title, value, range, when it moves, [its key]:`,
    ...r.params.map((p) => paramRow(p, autos.has(p.key))),
  ].join('\n'));
}));
server.registerTool('set_instrument', {
  title: 'Change an instrument',
  description: 'Changes a track\'s instrument (what plays its notes clips), the same way whatever plays it, checked against the instrument first (nothing changes if anything is wrong: it says what). `track`: the track (its name or id; or `media`, a notes medium one track plays). `device`: another (Ephemeris Sampler, a plugin\'s name: Vial, the studio\'s synth; instruments lists them), from `preset` (a plugin\'s: a preset\'s name in the preset folders, as instruments lists them, "pluck" — one of a folder of this machine\'s is copied into the project — or a state file, presets/…, instruments/…; a sampler instrument: instruments/….json, library/….sfz, a folder of note-named samples). `set`: { <param title or key>: value } in its own units or words ("800 Hz", "120 ms", "-6 dB", "Saw"; a plugin\'s as it writes them, "Ladder", "40 semitones", or 0–1), as instruments lists them; null puts a plugin\'s back to its state\'s. `zones` (a sampler\'s, in place of its zones) and `add_zones`: [{ file, key (a note or [lo, hi]), root and tune (left out: measured by pitch, the note the file holds longest), offset, end (s: a slice), gain, pan, loop: { mode: "oneshot" }, vel, rr, group, offBy }] (a file outside the project and the sound library is copied into instruments/samples). `automate`: { <param>: [[at, value, ease?], …] } as keys (at: the timeline\'s seconds, or bar.beat as notation counts; value as in set; ease lin, glide (the default), step…), null to take a param\'s away, in `layer` "track" (the default: kept on the track, over the whole timeline) or "clip" (kept in the notes medium a clip of the track plays at `at`, in its own time: each key at the point of the pattern that clip plays then, so it moves and repeats with its clips; under the track\'s). A changed sampler is saved as instruments/<name>-<hash>.json, as the Instrument panel saves one. Kept as a version of the project.',
  inputSchema: { track: z.string().optional(), media: z.string().optional(), device: z.string().optional(), preset: z.string().optional(), set: z.record(z.string(), z.any()).optional(), zones: z.array(z.record(z.string(), z.any())).optional(), add_zones: z.array(z.record(z.string(), z.any())).optional(), automate: z.record(z.string(), z.any()).optional(), layer: z.enum(['track', 'clip']).optional(), track: z.string().optional(), message: z.string().optional() },
}, tool(async (args) => {
  for (let tries = 0; ; tries++) {
    const s = await state(), doc = JSON.parse(s.text), dir = s.root, o = await opened(), t0 = trackFor(doc, args);
    let r;
    try { r = await changeInstrument(dir, t0.instrument ?? null, args); } catch (e) { throw e instanceof InstrumentError ? new StudioError(e.message) : e; }
    if (r.sampler) {   // (saved as the Instrument panel saves one: a file of its own)
      const sv = await json(await get(`${o.base}api/instrument/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: t0.name ?? t0.id, data: r.sampler }) }));
      r.spec = { sampler: sv.path }; r.said.push(`saved as ${sv.path}`);
    }
    const d = structuredClone(doc), t = d.tracks.find((y) => y.id === t0.id);
    t.instrument = r.spec;
    if (args.automate) {
      let l;
      try { l = await lanesOf(dir, r.spec, args.automate, timeIn(d.grid ?? {})); } catch (e) { throw e instanceof InstrumentError ? new StudioError(e.message) : e; }
      if (args.layer === 'clip') {   // (each key in the pattern a clip of the track plays then, at its own time)
        const touched = new Set();
        for (const [k, v] of Object.entries(l.lanes)) {
          if (!v) { for (const c of notesClips(t, d.media)) { const am = d.media[c.media].automation; if (am) { delete am[k]; touched.add(c.media); } } continue; }
          const by = new Map();   // (medium → its keys)
          for (const lane of v.lanes) for (const [at, ...rest] of lane.keys) {
            const c = clipAt(t, d.media, at);
            if (!c) throw new StudioError(`At ${at.toFixed(3)} s no notes clip plays on "${t.name}": a key of a clip's own is where one does. Nothing was changed.`);
            if (!by.has(c.media)) by.set(c.media, { ...v, lanes: v.lanes.map((x) => ({ ...x, keys: [] })) });
            by.get(c.media).lanes[v.lanes.indexOf(lane)].keys.push([Math.round((c.in + (at - c.at) * speedOf(c)) * 1e6) / 1e6, ...rest]);
          }
          for (const [id, p] of by) { for (const x of p.lanes) x.keys.sort((a, b) => a[0] - b[0]); (d.media[id].automation ??= {})[k] = p; touched.add(id); }
        }
        for (const id of touched) if (d.media[id].automation && !Object.keys(d.media[id].automation).length) delete d.media[id].automation;
      } else {
        for (const [k, v] of Object.entries(l.lanes)) { if (v) ((t.automation ??= {})[INSTRUMENT] ??= {})[k] = v; else if (t.automation?.[INSTRUMENT]) delete t.automation[INSTRUMENT][k]; }
        if (t.automation?.[INSTRUMENT] && !Object.keys(t.automation[INSTRUMENT]).length) delete t.automation[INSTRUMENT];
        if (t.automation && !Object.keys(t.automation).length) delete t.automation;
      }
      r.said.push(...l.said.map((x) => (args.layer === 'clip' ? `${x} in its clips` : x)));
    }
    try {
      const b = await put(d, s.text, args.message ?? `"${t.name}": ${r.said.join(', ')}`);
      return text(`"${t.name}": ${r.said.join('; ') || 'nothing asked'}. ${b.version ? `Version ${b.version}.` : 'Nothing changed in the timeline.'}`);
    } catch (e) { if (!e.conflict) throw e; if (tries >= 2) throw new StudioError('The timeline kept changing while this was written (the director editing it): nothing was written. Try again.'); }
  }
}));
server.registerTool('audition', {
  title: 'Hear an instrument',
  description: 'Plays notes through an instrument without changing the timeline: a track\'s (`track`, or `media`: a notes medium one track plays) or any spec (`instrument`: { plugin, state, set }, { sampler }); the notes as notation (as write_notes takes it: its first bar played from 0 s; `bpm` its tempo, else the timeline\'s grid). Written to renders/<timeline>/audition-<name>.wav and measured: its loudness and true peak, and what it is like (sounds\' measures and words: weight, brightness, attack, decay, tags). Try a preset or a change on a phrase before you set it.',
  inputSchema: { track: z.string().optional(), media: z.string().optional(), instrument: z.record(z.string(), z.any()).optional(), notation: z.string(), bpm: z.number().optional(), name: z.string().optional() },
}, tool(async ({ track, media, instrument, notation, bpm, name }) => {
  const s = await state(), doc = JSON.parse(s.text), dir = s.root, o = await opened();
  const spec = instrument ?? (track || media ? trackFor(doc, { track, media }).instrument : null);
  if (!spec) throw new StudioError('Name the instrument: track (a track\'s), media (a notes clip\'s track\'s) or instrument (a spec).');
  const g = bpm ? { bpm, offset: 0, beatsPerBar: 4 } : doc.grid ?? {};
  let parsed;
  try { parsed = parseNotes(notation, g); } catch (e) { throw e instanceof NotationError ? new StudioError(e.message) : e; }
  if (!parsed.notes.length) throw new StudioError('No notes in `notation`.');
  const t0 = timeOf(g, parsed.bars[0]), notes = parsed.notes.map((n) => ({ ...n, t: n.t - t0 }));
  const { channels: [L, R], sr } = await audition(dir, spec, notes, { grid: g }), d = deviceOf(spec);
  const stem = String(name ?? track ?? media ?? d.name).replace(/[^\w.+ -]+/g, '_').trim() || 'audition';
  const rel = path.join('renders', o.tid, `audition-${stem}.wav`), file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeWav(L, R, sr, file);
  const [mt, M] = await Promise.all([meter(L, R, sr), measure(file)]);
  return text(`${rel}: ${(L.length / sr).toFixed(2)} s, ${notes.length} notes through ${d.device}${d.name !== d.device ? ` · ${d.name}` : ''}; ${mt.I ?? '?'} LUFS integrated, true peak ${mt.TP ?? '?'} dBTP.\n${table([M], dir)}`);
}));

// ---------- the mixer, as the Mixer panel shows it: read, and changed by name (tools/mixer.mjs)
server.registerTool('mixer', {
  title: 'The mixer',
  description: 'The timeline\'s mixer, as the Mixer panel shows it: a strip for each audio track (A1, A2… as the editor numbers them), each bus (a shared effect the tracks send to) and the master — its volume, pan, mute and solo, its effects in order with every param in its own units, its sends, and what plays on it. Without changes: the strips as text. `set`: { <strip>: change }, a strip named by its A-number, name or id (a bus by its name, the master as master); a change has any of `volume` (dB, -60 to 6), `pan` (-1 left to 1 right), `mute`, `solo`, `sends` ({ <bus>: dB, -40 to 6, or null: none }), `fx` (the whole chain, in order: [{ type, on?, …params }]), `add_fx` ([…] to the end of the chain), `set_fx` ({ <an effect: its type, "compressor 2" where there are two, or its place from 1>: { params } to change, null to take it out }); params as words with their unit ("-24 dB", "120 ms", "2.5 kHz", "30%", "on"; `on: false` bypasses), or bare numbers in each param\'s own unit, as the last line of the read-out gives them (seconds, though values show as ms; Hz; a % as 0–1). An EQ\'s `bands` replaces its bands, `"band 2": { gain }` changes one. `add_buses`: [{ name, fx?, volume?, pan? }] (without fx: a reverb); `remove_buses`: [names] (the sends to it go too). Everything is checked first (nothing changes if anything is wrong: it says what), then written and kept as a version saying `message`; the director\'s editor lights what changed. levels measures the mix.',
  inputSchema: {
    set: z.record(z.string(), z.record(z.string(), z.any())).optional().describe('{ <strip>: { volume, pan, mute, solo, sends, fx, add_fx, set_fx } }'),
    add_buses: z.array(z.record(z.string(), z.any())).optional(), remove_buses: z.array(z.string()).optional(),
    message: z.string().optional().describe('The version\'s message in the history (else: what changed)'),
  },
}, tool(async (args) => {
  if (!args.set && !args.add_buses?.length && !args.remove_buses?.length) return text(describeMixer(JSON.parse((await state()).text)));
  for (let tries = 0; ; tries++) {
    const s = await state();
    let r;
    try { r = changeMixer(JSON.parse(s.text), args); } catch (e) { throw e instanceof MixerError ? new StudioError(`${e.message} Nothing was changed.`) : e; }
    if (!r.said.length) return text('Nothing changed: the mixer already reads so.');
    try { const b = await put(r.doc, s.text, args.message ?? `Mixer: ${r.said.join('; ')}`); return text(`${r.said.join('; ')}. ${b.version ? `Version ${b.version}.` : 'Nothing changed in the timeline.'}`); }
    catch (e) { if (!e.conflict) throw e; if (tries >= 2) throw new StudioError('The timeline kept changing while this was written (the director editing it): nothing was written. Try again.'); }   // (made again on the timeline as it is now)
  }
}));

// making room: everything from a time on moved, as an editor's ripple (the film's code times its own scenes: change it
// there; this keeps the director's cues, clips and changes in step with it)
server.registerTool('retime', {
  title: 'Make room in the timeline',
  description: 'Moves everything in the timeline from `at` on by `by` seconds (negative takes time out): cues (a range across `at` grows or shrinks with it), clips, and the director\'s changes\' keys and moves; what is before `at` stays. Kept as a version of the project. Use it when the film\'s code lengthens or shortens a scene, so the later cues and changes stay where they belong.',
  inputSchema: { at: z.number(), by: z.number(), message: z.string().optional().describe('Why (the version\'s message in the history)') },
}, tool(async ({ at, by, message }) => {
  const s = await state(), { doc, moved } = retime(JSON.parse(s.text), at, by);
  let b;
  try { b = await put(doc, s.text, `${message ?? `everything from ${at} s moved ${by > 0 ? '+' : ''}${by} s`} (${moved.cues} cues, ${moved.clips} clips, ${moved.keys} keys)`); } catch (e) { throw e.conflict ? new StudioError('The timeline changed as it was being written: nothing was moved. Try again.') : e; }
  return text(`Moved ${moved.cues} cue(s), ${moved.clips} clip(s) and ${moved.keys} key(s) from ${at} s by ${by} s${b.version ? `: version ${b.version}` : ''}.`);
}));
// an orphaned change attached again: to where its code now is
server.registerTool('reattach', {
  title: 'Attach a change again',
  description: 'Attaches the director\'s change that an edit to the code orphaned (status lists them) to where its code now is: `from` is its orphaned name (orphan:file:line:col) or the change\'s id; `to` is the place the code now makes that thing (file:line:col: pick or locate it to read `at`). The studio then remembers the code there. Kept as a version of the project. Only for an edit you made; otherwise tell the director.',
  inputSchema: { from: z.string(), to: z.string() },
}, tool(async ({ from, to }) => {
  const s = await state(), doc = JSON.parse(s.text), dest = parseSite(to);
  if (!dest || dest.orphan) throw new StudioError(`\`to\` is a place in the code, file:line:col (as pick returns \`at\`), not "${to}".`);
  let key = parseSite(from)?.key;
  if (!key) {
    const ov = (doc.overrides ?? []).find((x) => x.id === from);
    if (!ov) throw new StudioError(`No change "${from}": status lists the orphaned ones.`);
    const names = [...new Set([ov.stack, ov.on?.at, ...Object.keys(ov.ops ?? {})].map((n) => parseSite(n)).filter((p) => p?.orphan).map((p) => p.key))];
    if (names.length !== 1) throw new StudioError(names.length ? `Change ${from} is orphaned in ${names.length} places (${names.join(', ')}): give \`from\` as one of them.` : `Change ${from} is not orphaned.`);
    key = names[0];
  }
  const d = renameSites(doc, { [key]: dest.key });
  // (what it remembered of its old line is no longer its code: the studio remembers the line there now)
  for (const x of d.overrides ?? []) if (x.code) delete x.code[dest.key];
  for (const q of d.cues ?? []) if (q.on?.code) delete q.on.code[dest.key];
  let b;
  try { b = await put(d, s.text, `attach ${key} again at ${dest.key}`); } catch (e) { throw e.conflict ? new StudioError('The timeline changed as it was being written: nothing was attached. Try again.') : e; }
  const left = orphansIn(JSON.parse((await state()).text)).length;
  return text(`Attached ${key} at ${dest.key}${b.version ? ` (version ${b.version})` : ''}. ${left ? `${left} orphaned still.` : 'Nothing orphaned now.'}`);
}));

// ---------- the project's media (the assets panel)
server.registerTool('media', {
  title: 'Media', description: 'The open project\'s sounds, pictures and videos: in assets/ and its folders (the assets panel; files brought in go there), and media/ in a project from before assets/ held them, each by its path in the project (src: `assets/sfx/whoosh.wav`): each file\'s kind (audio, image, video), size, length, frame rate and whether a video has sound, newest first. A picture is placed on a Pictures track (kind "visual") and shows in the world where its clip starts; a sound on an audio track.', inputSchema: {}, annotations: { readOnlyHint: true },
}, tool(async () => text(await api('api/media'))));

// ---------- listening (an agent cannot): the songs, the sounds, the mix
const project = async () => { const s = await state(); return { tl: JSON.parse(s.text), dir: s.root }; };
// the open timeline, or a variant of it in a file of its own (the project's media are its), to measure without writing the timeline
async function heardTimeline(timeline) {
  const p = await project();
  if (!timeline) return p;
  const f = path.resolve(p.dir, timeline.replace(/^~(?=$|\/)/, os.homedir()));
  let tl;
  try { tl = migrate(JSON.parse(fs.readFileSync(f, 'utf8'))).doc; } catch (e) { throw new StudioError(`\`timeline\` is a timeline's JSON file (a copy of the open one, changed: timelines/<id>.json's form): ${f}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`); }
  if (!Array.isArray(tl.tracks)) throw new StudioError(`${f} is not a timeline (it has no tracks).`);
  return { tl, dir: p.dir, variant: path.relative(p.dir, f) };
}
const filesIn = (dir, list) => list.map((f) => { const a = path.resolve(dir, f.replace(/^~(?=$|\/)/, os.homedir())); if (!fs.existsSync(a)) throw new StudioError(`No such file or folder: ${a}`); return a; });
const TIMELINE_ARG = z.string().optional().describe('A variant to measure instead of the open timeline: a copy of its JSON, changed, in a file of the project\'s (renders/try.json: renders/ is in no version of the project, and a file in timelines/ is a timeline of its own); the timeline is not written');
const mmss = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
server.registerTool('music', {
  title: 'The music',
  description: 'The songs on the timeline as the studio heard them (Beat This!, a beat-tracking model, and measures of the song itself: tools/music.mjs): each one\'s tempo map (from the beats Beat This! is sure of: one steady tempo, or where it changes; carried through where it is unsure) and beats a bar, or the tempo set by hand on its clip; its drops (where it rises into one of its loudest parts, the kick and bass coming in); its parts (where the music changes: A, B, C…, a letter again where a part comes back, each with its intensity 1–5) — in the song\'s own time and in film time where its clips play it (trims and speed followed). And the timeline\'s tempo grid: Detected (it follows the music: each song\'s tempo map and bars from where its clip starts) or set by hand. `media`: one song (its id on the timeline, or a file of the project\'s by its path, assets/song.wav: heard now if it has not been, ~10 s); `beats`: its beats and downbeats in film time from `from` to `to`, marked where the model is unsure of them.',
  inputSchema: { media: z.string().optional(), beats: z.boolean().optional(), from: z.number().optional(), to: z.number().optional() }, annotations: { readOnlyHint: true },
}, tool(async ({ media, beats, from = 0, to = Infinity }) => {
  const { tl } = await project(), r = await api('api/music'), out = [];
  const g = tl.grid ?? {}, ps = gridParts(g);
  const gps = g.map ?? [g];
  out.push(`The tempo grid: ${g.auto ? 'Detected (it follows the music)' : 'set by hand'}: ${gps.slice(0, 12).map((p, i) => `${p.bpm} bpm, ${p.beatsPerBar ?? 4} beats a bar${i ? ` from ${p.t} s (bar ${p.bar})` : `, bar 0 at ${(ps[0].line).toFixed(3)} s`}${p.media ? ` (${p.media}${p.speed ? ` at ${p.speed}×` : ''})` : ''}`).join('; ')}${gps.length > 12 ? `; … (${gps.length} tempos in all)` : ''}. In film code: tempo(TL.grid).b(bar, beat).`);
  let songs = Object.entries(r.music);
  if (media) {
    songs = songs.filter(([id]) => id === media || tl.media[id]?.src === media || tl.media[id]?.src === `media/${media}`);
    if (!songs.length) { const h = await api('api/music', { media }); if (h.error) throw new StudioError(h.error); songs = [[media, h.music]]; }
  }
  if (r.listening.length) out.push(`Still listening to ${r.listening.join(', ')} (about 10 s a song): ask again shortly.`);
  if (!songs.length) out.push('No song on the timeline has been heard (a sound of 10 s or more on an audio track is). media names a file of the project\'s (its path: assets/song.wav) to hear one.');
  for (const [id, m] of songs) {
    out.push('', `${id}: ${describeSong(m)}`);
    const clips = tl.tracks.filter((t) => !isVisual(t)).flatMap((t) => t.clips.filter((c) => c.media === id).map((c) => ({ c, t })));
    for (const { c, t } of clips) {
      const sp = speedOf(c), film = (s) => c.at + (s - c.in) / sp, within = (s) => s >= c.in - 1e-6 && s <= c.out + 1e-6;
      out.push(`  on the timeline: ${t.name}, ${c.at.toFixed(2)}–${clipEnd(c).toFixed(2)} s, from ${mmss(c.in)} of it${sp !== 1 ? ` at ${sp}×` : ''} (film time = ${c.at.toFixed(3)} + (song time − ${c.in.toFixed(3)})${sp !== 1 ? ` / ${sp}` : ''})`);
      if (c.tempo) out.push(`    its tempo set by hand on the clip: ${c.tempo.bpm} bpm, ${c.tempo.beatsPerBar} beats a bar, a bar line ${c.tempo.offset} s into the song`);
      const drops = (m.drops ?? []).filter((d) => within(d.t));
      if (drops.length) out.push(`    drops in the film: ${drops.map((d) => `${film(d.t).toFixed(2)} s`).join(', ')}`);
      const secs = m.sections.map((x, i) => ({ ...x, end: m.sections[i + 1]?.t ?? m.duration })).filter((x) => Math.min(x.end, c.out) - Math.max(x.t, c.in) > 0.05);
      if (secs.length) out.push(`    parts in the film: ${secs.map((x) => `${x.label}${x.intensity ? `(${x.intensity})` : ''} ${film(Math.max(x.t, c.in)).toFixed(2)}–${film(Math.min(x.end, c.out)).toFixed(2)}`).join(', ')}`);
      if (beats) {
        const downs = new Set(m.downbeats), bs = m.beats.map((b, i) => [b, m.conf?.[i] ?? 1]).filter(([b]) => within(b) && film(b) >= from && film(b) <= to).slice(0, 400);
        out.push(`    beats in the film (| a downbeat, ? one the model is unsure of): ${bs.map(([b, p]) => `${downs.has(b) ? '|' : ''}${film(b).toFixed(2)}${p < SURE ? '?' : ''}`).join(' ')}`);
      }
    }
  }
  return text(out.join('\n'));
}));
server.registerTool('sounds', {
  title: 'Sounds, measured',
  description: 'What sounds are like, by numbers (you cannot listen: tools/sound.mjs): duration, where each peaks, attack and decay, its weight (sub < 60 Hz, low < 150 Hz, high > 4 kHz, air > 8 kHz), centroid, flatness, tonality, pitch slope, crest, and plain-word tags (sub, bassy, thin, tinny, bright, airy, tonal, rising, falling, click, hit, boom, ring, swell, swoosh, bed, stops-hard, punchy, soft). `files`: sound files or folders (the project\'s: media/…; or anywhere, ~ for home: a library), narrowed by `tags` (all of them, comma-separated), `min` and `max` (duration, s), and ordered by `sort` (a measure, descending; -measure ascending). `bands` (with files): instead, each file\'s balance by octave from `from` to `to` (s), as levels\' bands gives the mix\'s: to set a mix against a reference\'s loudest part. Without files: the sounds the timeline plays (not songs), each where it lands in the film — its onset and peak in film time, the grid line nearest its peak (bar.beat.sixteenth) and how far off, the nearest cue. Read the sound skill first (manual: skill/sound): what gets a sound, which, where it peaks.',
  inputSchema: { files: z.array(z.string()).optional(), tags: z.string().optional(), min: z.number().optional(), max: z.number().optional(), sort: z.string().optional(), bands: z.boolean().optional(), from: z.number().optional(), to: z.number().optional() }, annotations: { readOnlyHint: true },
}, tool(async ({ files, tags, min, max, sort, bands: byOctave, from = 0, to = Infinity }) => {
  const { tl, dir } = await project();
  if (files?.length && byOctave) {
    // each file's balance by octave, from `from` to `to`: as levels gives the mix's, to compare with a reference
    const list = soundFiles(filesIn(dir, files)).slice(0, 40), rows = [];
    for (const f of list) {
      const { channels: [L, R] } = await decodeStereo(f, 48000), i0 = Math.min(L.length, Math.round(from * 48000)), i1 = Math.min(L.length, Math.round(to * 48000));
      const b = bands(L.subarray(i0, i1), R.subarray(i0, i1), 48000);
      const rel = path.relative(dir, f);
      rows.push(`${BANDS.map((c, j) => `${c >= 1000 ? `${c / 1000}k` : Math.round(c)}:${b.share[j]}`).join(' ')}   side ${b.side} dB under mid, ${b.sideLow} under 150 Hz   ${rel.startsWith('..') ? f.replace(os.homedir(), '~') : rel} ${(i0 / 48000).toFixed(2)}–${(i1 / 48000).toFixed(2)} s`);
    }
    return text(`Each file's balance by octave (each octave's dB of its whole: levels' bands give the mix's the same way):\n${rows.join('\n')}`);
  }
  if (files?.length) {
    const abs = files.map((f) => path.resolve(dir, f.replace(/^~(?=$|\/)/, os.homedir())));
    for (const f of abs) if (!fs.existsSync(f)) throw new StudioError(`No such file or folder: ${f}`);
    const { rows, files: n } = await survey(abs, { tags, min, max, sort }, 400);
    return text(`${rows.length} of ${n} sound${n === 1 ? '' : 's'}${n >= 400 ? ' (the first 400 files)' : ''}:\n${table(rows, abs.length === 1 && fs.statSync(abs[0]).isDirectory() ? abs[0] : dir)}`);
  }
  const rows = await placed(tl, dir, { nearest, position });
  if (!rows.length) return text('The timeline plays no sounds but its songs.');
  return text(['  film s  sound                   track       onset   peak    nearest grid line   cue', ...rows.map((r) => `${r.at.toFixed(2).padStart(8)}  ${r.media.padEnd(22).slice(0, 22)}  ${r.track.padEnd(10).slice(0, 10)}  ${r.onset?.toFixed(2).padStart(6) ?? '     -'}  ${r.peak != null ? r.peak.toFixed(2).padStart(6) : 'trimmed'}  ${`${r.grid.at} ${r.grid.off >= 0 ? '+' : ''}${r.grid.off} ms`.padEnd(18)}  ${r.cue ? `"${r.cue.label}" ${r.cue.off >= 0 ? '+' : ''}${r.cue.off} ms` : ''}${r.speed !== 1 ? `  ${r.speed}×` : ''}  [${r.tags.join(' ')}]`)].join('\n'));
}));
server.registerTool('levels', {
  title: 'The mix\'s levels',
  description: 'How loud the mix is, as a broadcast meter reads it (EBU R128), mixed as masters are (tools/levels.mjs): the film\'s, a span\'s (`from`, `to`) or each of `spans`\' ([[8, 24], [28, 44]]: one render for them all) integrated loudness, range, true peak and loudest moment; each track alone (as it sounds in the mix, through the master); and wherever a voice speaks, how far it stands above everything else (the sound skill asks at least ~3 LU), with where it is least. A voice is a track named for one (Voice, VO, Narration…) unless `voice` names the tracks. `bands`: each span by octave (31 Hz–16 kHz, dBFS) for the mix and each track, the loudest track in each octave marked, how far the side is under the mid (all, and under 150 Hz: the low end should be near mono), and the mix\'s balance (each octave\'s share of the whole, as sounds\' bands give a reference\'s). `peaks`: where the tracks summed peak highest before the master\'s effects (what its limiter works on) and what each track is there (as many renders again). `timeline`: measure a variant instead (the timeline is not written). Each call renders from the start, the mix and every track alone, several at once: a minute of film with ten tracks takes about 15 s.',
  inputSchema: { from: z.number().optional(), to: z.number().optional(), spans: z.array(z.tuple([z.number(), z.number()])).optional(), voice: z.array(z.string()).optional(), bands: z.boolean().optional(), peaks: z.boolean().optional(), timeline: TIMELINE_ARG }, annotations: { readOnlyHint: true },
}, tool(async ({ from, to, spans, voice, bands: b, peaks, timeline }) => {
  const { tl, dir, variant } = await heardTimeline(timeline), r = await levels(tl, dir, { from, to, spans, voice, bands: b, peaks });
  return text(`${variant ? `(${variant}, not the open timeline)\n` : ''}${r.text}`);
}));

// ---------- pitch: the notes a recording plays
server.registerTool('pitch', {
  title: 'The notes in a recording',
  description: 'The notes sound files play, by Basic Pitch (polyphonic, any instrument: tools/pitch.mjs): each note\'s start and end (s, in the file), its note, how strongly the model hears it (vel, 0–1) and its loudness (dB, RMS); and where a note sounds alone, its tuning (cents from equal temperament, A4 = 440) and how far it strays (±cents), by YIN — a sampler zone\'s root and tune, a vocal chop\'s slice (offset, end), a reference\'s line. `files`: files or folders (the project\'s: media/…; ~ for home: a library); `from`, `to` (s) a span of one file. Narrowed by `alone` (only notes sounding alone), `steady` (only those that stray no more than this, cents), `min` (s, the shortest), `keys` ("F3-G5"). With one file (or `notation`), its notes also as notation write_notes takes: on a grid of `bpm` from the file\'s start (a loop\'s own tempo), else on the timeline\'s grid with the file starting at `at` (film s, 0 unless set); `quantize` ("1/16") puts each start on that grid and each length to a whole number of it. `onset`, `frame` (0–1): Basic Pitch\'s thresholds (0.5, 0.3; lower finds quieter notes). Monophonic tuning only: a chord\'s notes say no cents. About 0.3 s a loop, 3 s a song.',
  inputSchema: { files: z.array(z.string()), from: z.number().optional(), to: z.number().optional(), alone: z.boolean().optional(), steady: z.number().optional(), min: z.number().optional(), keys: z.string().optional(), notation: z.boolean().optional(), bpm: z.number().optional(), at: z.number().optional(), quantize: z.string().optional(), onset: z.number().optional(), frame: z.number().optional() }, annotations: { readOnlyHint: true },
}, tool(async ({ files: fs_, from, to, alone, steady, min, keys, notation, bpm, at = 0, quantize, onset, frame }) => {
  const { tl, dir } = await project(), list = soundFiles(filesIn(dir, fs_));
  if (!list.length) throw new StudioError('No sound files there.');
  let lo = -Infinity, hi = Infinity;
  if (keys) { const m = /^\s*(\S+?)\s*-\s*(\S+)\s*$/.exec(keys); try { [lo, hi] = [m[1], m[2]].map((k) => (/^\d+$/.test(k) ? +k : midi(k))); } catch { throw new StudioError(`keys is a range of notes: "F3-G5" or "53-79", not "${keys}"`); } }
  const keep = (n) => n.note >= lo && n.note <= hi && (!min || n.dur >= min) && (!alone || n.alone) && (steady == null || (n.wobble != null && n.wobble <= steady));
  const ins = filesIn(dir, fs_), base = ins.length === 1 && fs.statSync(ins[0]).isDirectory() ? ins[0] : path.dirname(list[0]), out = [], LIMIT = 400;
  const shownPath = (f) => { const r = path.relative(base, f); return r && !r.startsWith('..') ? r : f.replace(os.homedir(), '~'); };
  let rows = 0, more = 0, last = null;
  for (const f of list) {
    let r;
    try { r = await pitch(f, { from: list.length === 1 ? from : undefined, to: list.length === 1 ? to : undefined, onset, frame }); } catch (e) { out.push(`${shownPath(f)}: ${e.message}`); continue; }
    const ns = r.notes.filter(keep);
    if (!ns.length && list.length > 1) continue;
    const shown = ns.slice(0, Math.max(0, LIMIT - rows)); rows += shown.length; more += ns.length - shown.length;
    out.push(`${shownPath(f)}: ${ns.length}${ns.length !== r.notes.length ? ` of ${r.notes.length}` : ''} notes, ${r.from.toFixed(2)}–${r.to.toFixed(2)} s${shown.length ? `\n${pitchTable(shown)}` : ''}`);
    last = { r, ns };
  }
  if (list.length > 1) out.unshift(`In ${base.replace(os.homedir(), '~')}:`);
  if (more) out.push(`(${more} more notes not shown: the first ${LIMIT} are. Narrow with keys, steady, alone, min, or fewer files.)`);
  out.push('(cents: where a note sounds alone and holds a pitch; ? alone but not periodic there; - not alone)');
  if (last && (notation ?? list.length === 1)) {
    const g = bpm ? { bpm, offset: 0, beatsPerBar: 4 } : tl.grid ?? {}, shift = bpm ? 0 : at;
    let ns = last.ns.map((n) => ({ t: n.t + shift, dur: n.dur, note: n.note, vel: Math.round(n.vel * 100) / 100 }));
    if (quantize) {
      // (each start to the nearest line of that length, each length to a whole number of them)
      const q = parseNotes(`0.0 C4 ${quantize}`, { bpm: 60, offset: 0, beatsPerBar: 4 }).notes[0]?.dur;   // (its length in beats)
      if (!q) throw new StudioError(`quantize is a length: "1/16", "1/8"`);
      ns = ns.map((n) => { const t = nearest(g, n.t, q), beat = gridParts(g).find((p, i, a) => !a[i + 1] || a[i + 1].t > t).beat; return { ...n, t, dur: Math.max(1, Math.round(n.dur / (q * beat))) * q * beat }; });
    }
    out.push('', `As notation (${bpm ? `${bpm} bpm, bar 0 at the file's start` : `the timeline's grid, the file starting at ${at} s`}${quantize ? `, quantized to ${quantize}` : ''}; write_notes takes it):`, writeNotes(ns, g));
  }
  return text(out.join('\n'));
}));

// ---------- a bounce: the mix, or tracks alone, as a file
server.registerTool('bounce', {
  title: 'Bounce to a file',
  description: 'Renders the mix, or `tracks` alone (names or ids: the rest muted, as levels hears a track: a compressor listening to a muted one still hears it), through the master, to a WAV (32-bit float) in renders/<timeline>/: to listen outside the studio, to hand the director, or to measure a part on its own (sounds, pitch). `from`, `to` (s): only that span (rendered from the start, so what rings into it is there). `name`: the file\'s (else what it holds). `master: false`: without the master\'s effects. `timeline`: a variant instead of the open timeline.',
  inputSchema: { tracks: z.array(z.string()).optional(), from: z.number().optional(), to: z.number().optional(), name: z.string().optional(), master: z.boolean().optional(), timeline: TIMELINE_ARG },
}, tool(async ({ tracks, from = 0, to = Infinity, name, master = true, timeline }) => {
  const { tl, dir, variant } = await heardTimeline(timeline), o = await opened();
  const heard = tl.tracks.filter((t) => !isVisual(t) && t.clips.length);
  const picked = tracks?.length ? tracks.map((x) => heard.find((t) => t.id === x || t.name === x) ?? (() => { throw new StudioError(`No audio track "${x}" with clips: ${heard.map((t) => `"${t.name}" (${t.id})`).join(', ')}`); })()) : heard;
  if (!picked.length) throw new StudioError('Nothing is heard: no clips on the audio tracks.');
  const x = { ...tl, tracks: tl.tracks.map((t) => (isVisual(t) || picked.includes(t) ? t : { ...t, mute: true })), ...(master ? {} : { master: { ...(tl.master ?? {}), fx: (tl.master?.fx ?? []).map((f) => ({ ...f, on: false })) } }) };
  const src = await sources(x, dir), [L, R] = render(x, src, { until: to });
  const i0 = Math.min(L.length, Math.round(Math.max(0, from) * src.sr)), l = L.subarray(i0), r = R.subarray(i0);
  const stem = (name ?? (tracks?.length ? picked.map((t) => t.name).join('+') : 'mix')).replace(/[^\w.+ -]+/g, '_').trim() || 'mix';
  const rel = path.join('renders', o.tid, `bounce-${stem}${from > 0 || Number.isFinite(to) ? `-${from}-${Number.isFinite(to) ? to : 'end'}` : ''}${master ? '' : '-dry'}.wav`), file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeWav(l, r, src.sr, file);
  const m = await meter(l, r, src.sr);
  return text(`${variant ? `(${variant}, not the open timeline) ` : ''}${rel}: ${(l.length / src.sr).toFixed(2)} s at ${src.sr} Hz, ${picked.length === heard.length ? 'the whole mix' : picked.map((t) => `"${t.name}"`).join(', ') + ' alone'}${master ? '' : ', without the master\'s effects'}; ${m.I ?? '?'} LUFS integrated, true peak ${m.TP ?? '?'} dBTP.`);
}));

// ---------- photos in depth
server.registerTool('depth', {
  title: 'Photos in depth',
  description: 'Cuts photos by depth into layers that can stand apart in the world, for parallax as the camera moves (tools/depth.mjs: Depth Anything V2 Small measures it and LaMa fills what is painted out, both on the GPU; ~8 s a photo). Each photo becomes, in the open project\'s assets/depth: <name>-far.jpg (the whole photo, what is nearer painted out), <name>-mid.webp (only when it has three depths), <name>-near.webp (the nearest: usually the people), <name>-depth.png and <name>.json. Place them with elements/depth.js (depthPhoto). The cut follows depth, not things: a person reaching towards the camera can fall across two layers, and what is painted out is filled by LaMa from what is around it (soft, from the photo at 512 × 512), seen only as the camera moves. `photos`: files in the project (media/…), each a path or { file, name, crop: [x, y, w, h] } (crop: one part of it, a collage\'s half).',
  inputSchema: { photos: z.array(z.union([z.string(), z.object({ file: z.string(), name: z.string().optional(), crop: z.array(z.number()).length(4).optional() })])) },
}, tool(async ({ photos }) => {
  const { dir } = await project(), out = [];
  for (const p of photos) {
    const { file, name, crop } = typeof p === 'string' ? { file: p } : p, abs = path.resolve(dir, file);
    if (!fs.existsSync(abs)) throw new StudioError(`No such file: ${file}`);
    out.push(describeDepth(await depthLayers(abs, { out: path.join(dir, 'assets', 'depth'), name, crop })));
  }
  return text(`In assets/depth:\n${out.join('\n')}`);
}));

// ---------- looking
const fresh = (s, f) => /[23]/.test((s.accurate ?? s.preview).frames?.[f] ?? '');
// (and drawn whole: the viewer's frames are drawn at its size, the ones asked for here whole)
const whole = (s, f) => fresh(s, f) && ((s.accurate ?? s.preview).sizes?.[f] ?? '8') === '8';
server.registerTool('frames', {
  title: 'Look at the film',
  description: 'The film at the given times, as the viewer shows it (the studio\'s preview: the film\'s camera, at its frame rate and shutter). Frames not rendered yet are rendered first, right after the frame under the director\'s playhead (up to `wait` seconds). Up to 8 at once.',
  inputSchema: { times: z.array(z.number()).min(1).max(8).describe('Times in seconds'), wait: z.number().optional().describe('How long to wait for frames to render (default 90 s)') },
  annotations: { readOnlyHint: true },
}, tool(async ({ times, wait = 90 }) => {
  const o = await opened();
  let s = await state();
  const fps = (s.accurate ?? s.preview).fps || 60, frames = times.map((t) => Math.max(0, Math.floor(t * fps + 1e-6)));
  const until = Date.now() + wait * 1000;
  // (wanted: rendered after the director's playhead, never instead of it: the director's viewer keeps going)
  const missing = () => frames.filter((f) => !whole(s, f));
  if (missing().length) await get(`${o.base}api/preview/want`, { method: 'POST', body: JSON.stringify({ frames: missing() }) });
  while (missing().length && Date.now() < until) { await new Promise((r) => setTimeout(r, 700)); s = await state(); if ((s.accurate ?? s.preview).error) throw new StudioError(`The film is not rendering: ${(s.accurate ?? s.preview).error}`); }
  const content = [];
  for (const [i, f] of frames.entries()) {
    const r = await get(`${o.base}preview/${f}.jpg?look=accurate`);
    if (!r.ok) { content.push({ type: 'text', text: `${times[i]} s (frame ${f}): not rendered yet` }); continue; }
    content.push({ type: 'text', text: `${times[i]} s · frame ${f}${!fresh(s, f) ? ' (stale: from before the latest change)' : whole(s, f) ? '' : ' (at the viewer\'s size: not yet drawn whole)'}` });
    content.push({ type: 'image', data: Buffer.from(await r.arrayBuffer()).toString('base64'), mimeType: 'image/jpeg' });
  }
  return { content };
}));
server.registerTool('view', {
  title: 'Look from another camera',
  description: 'The scene at t from a camera of your own (the director\'s view: outside the film\'s camera, without its title cards and post): x, y, z (the point it looks at, world px), zoom, yaw, pitch, roll (degrees), focal. The camera tool gives the film camera\'s pose to start from.',
  inputSchema: { t: z.number(), camera: z.object({ x: z.number(), y: z.number(), z: z.number().optional(), zoom: z.number().optional(), yaw: z.number().optional(), pitch: z.number().optional(), roll: z.number().optional(), focal: z.number().optional() }), scale: z.number().min(0.25).max(1).optional() },
  annotations: { readOnlyHint: true },
}, tool(async ({ t, camera, scale = 0.6 }) => {
  const o = await opened();
  const r = await get(`${o.base}api/director`, { method: 'POST', body: JSON.stringify({ t, camera: { z: 0, zoom: 1, yaw: 0, pitch: 0, roll: 0, ...camera }, scale, agent: true }) });
  if (!r.ok) throw new StudioError(`The view did not render: ${r.status}`);
  return { content: [{ type: 'image', data: Buffer.from(await r.arrayBuffer()).toString('base64'), mimeType: 'image/jpeg' }] };
}));
server.registerTool('camera', {
  title: 'The film camera', description: 'Where the film\'s camera is at each of `times`: its kind (orbit, free or target), its eye, and its pose as the orbit camera that sees the same (x, y, z the point at the frame\'s centre, the frame there W / zoom wide; zoom, yaw, pitch, roll, focal), which the view tool takes.', inputSchema: { times: z.array(z.number()).min(1).max(400) }, annotations: { readOnlyHint: true },
}, tool(async ({ times }) => text((await api('api/director/path', { times })).map((c) => ({ t: c.t, kind: c.kind, ...c.camera, eye: c.eye.map((v) => +v.toFixed(1)) })))));

// ---------- understanding what is on screen
const thing = { at: z.string().describe('Where the code placed it (file:line:col, as pick returns)'), nth: z.number().optional(), key: z.union([z.string(), z.number()]).nullable().optional(), like: z.record(z.string(), z.any()).nullable().optional(), copy: z.number().optional() };
// (or an object, whole: every line that places it, as objects lists them; with at… the copy its values are read from)
const object = { ...thing, at: thing.at.optional(), sites: z.array(z.string()).optional().describe('An object, whole: the lines that place it (sites, as objects lists them)') };
server.registerTool('pick', {
  title: 'What is there',
  description: 'What is under frame point (x, y) (the film\'s frame px: its timeline\'s size, 1920×1080 if it says none) at t, through the film\'s camera: what it is (mesh, glass, layer, title, light, or pass: a placed pass of the film\'s own, an SDF object say), which copy, where the film\'s code placed and made it (file:line), where it is and how it looks. Its at/nth/key/like name it for locate and stacks.',
  inputSchema: { t: z.number(), x: z.number(), y: z.number() }, annotations: { readOnlyHint: true },
}, tool(async ({ t, x, y }) => { const r = await api('api/pick', { t, camera: null, x, y }); if (!r) return text('Nothing there (the background).'); const { outline, ...rest } = r; return text(rest); }));
server.registerTool('passes', {
  title: 'The film\'s own shaders',
  description: 'The film\'s passes (its own WGSL, see docs/manual/drawing.md) in the scene at t: each one\'s label, its stage (scene: each sub-frame\'s opaque picture; frame: the finished frame), its params as they are then, and where the code placed it (at, nth: name it so for locate and stacks, its params\' lanes). A pass over the whole frame is picked by a click only where it says what it draws there, so this is where to find one.',
  inputSchema: { t: z.number() }, annotations: { readOnlyHint: true },
}, tool(async ({ t }) => { const r = await api('api/passes', { t }); return text(r?.length ? r : 'No passes in the scene then.'); }));
server.registerTool('locate', {
  title: 'Where it is then', description: 'A thing (named as pick names it) at another moment: where it is and how it looks; null where it is not in the scene. Given sites (an object, whole, as objects lists it): one of its copies so (the one at… names, or its first) and how many it has then (count).', inputSchema: { t: z.number(), ...object }, annotations: { readOnlyHint: true },
}, tool(async ({ t, ...sel }) => {
  if (!sel.at && !sel.sites?.length) throw new StudioError('Name a thing (at, nth… from pick) or an object (sites, from objects).');
  const r = await api('api/locate', { t, camera: null, ...sel }); if (!r) return text('Not in the scene then.'); const { outline, members, ...rest } = r; return text(rest);
}));
server.registerTool('objects', {
  title: 'The film\'s objects',
  description: 'The film\'s objects, as the studio\'s timeline lists them and the director selects them: each thing the code defines (a mesh, a layer, a light, a pass) with every line that places it, and all one line places (a loop\'s, a many()\'s copies), as one; and each thing the director added by hand (added: true, its sites clip:<id>: a clip in the timeline, the manual\'s motion chapter says what it is). Each: its label, kind, sites (the lines that place it: file:line:col), spans (where it is in the scene, seconds) and copies (the most at once). Name one by its sites for locate or show to mean all of it; the director\'s changes to a whole object are overrides on { sites }.',
  inputSchema: {}, annotations: { readOnlyHint: true },
}, tool(async () => {
  const s = await state(), p = s.accurate ?? s.preview;
  if (p?.duration == null) return text('The film has not loaded yet: see status.');
  const list = await api('api/objects', { duration: p.duration, fps: p.fps, cuts: p.cuts ?? [] });
  return text(list.map((o) => ({ ...o, spans: o.spans.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]) })));
}));
// how the film moves on screen over a span: the camera's on-screen speed, where it rests (under 0.2 px per 1/60 s for 8
// frames) or reverses within a shot (check --momentum's measures), and where things are on the frame
server.registerTool('track', {
  title: 'How it moves on screen',
  description: 'How the film moves on screen from `from` to `to` (seconds), without drawing a frame: the film camera\'s on-screen speed, where it rests or reverses within a shot (with the numbers), and where each of `things` is on the frame (its px: the timeline\'s size, 1920×1080 if it says none) over the span — a placed thing, named as pick names it, or a world point. Use it to try camera moves and pacing quickly (edit the code, track again) before looking at frames or running every check.',
  inputSchema: { from: z.number(), to: z.number(), fps: z.number().optional().describe('Samples a second (60 by default)'),
    things: z.array(z.object({ ...thing, at: thing.at.optional(), point: z.array(z.number()).length(3).optional().describe('A world point [x, y, z] instead'), label: z.string().optional() })).max(8).optional() },
  annotations: { readOnlyHint: true },
}, tool(async ({ from, to, fps = 60, things = [] }) => {
  if (!(to > from)) throw new StudioError('`to` comes after `from`.');
  const rows = await api('api/track', { from, to, fps, things }), [W, H] = (await project()).tl.size ?? [1920, 1080];
  const k = 60 / fps, minRun = Math.max(2, Math.ceil(8 / k)), rests = [], snaps = [];
  let run = 0;
  rows.forEach((r, i) => {
    if (r.speed != null && r.world && r.speed < 0.2 * k) run++; else { if (run >= minRun) rests.push(`${rows[i - run].t.toFixed(2)}–${r.t.toFixed(2)} s: the camera at rest (under 0.2 px per 1/60 s)`); run = 0; }
    const a = rows[i - 1]?.centre, b = r.centre;
    if (a && b && Math.hypot(...a) > 2 * k && Math.hypot(...b) > 2 * k && a[0] * b[0] + a[1] * b[1] < 0) snaps.push(`${r.t.toFixed(2)} s: snaps back — the frame was moving (${a.map((v) => (v / k).toFixed(0)).join(', ')}) px per 1/60 s and then (${b.map((v) => (v / k).toFixed(0)).join(', ')}): it reverses within a shot`);
  });
  if (run >= minRun) rests.push(`${rows[rows.length - run].t.toFixed(2)} s–end: the camera at rest`);
  const sp = rows.map((r) => r.speed).filter((v) => v != null).map((v) => v / k).sort((a, b) => a - b), fastest = rows.reduce((b, r) => ((r.speed ?? -1) > (b.speed ?? -1) ? r : b), rows[0]);
  const step = Math.max(1, Math.ceil(rows.length / 48)), names = things.map((x, i) => x.label ?? (x.point ? `point ${i + 1}` : x.at));
  const each = things.map((_, j) => {
    const on = rows.filter((r) => r.things[j] && r.things[j][0] >= 0 && r.things[j][0] <= W && r.things[j][1] >= 0 && r.things[j][1] <= H), moves = [];
    for (let i = 1; i < rows.length; i++) { const a = rows[i - 1].things[j], b = rows[i].things[j]; if (a && b) moves.push([Math.hypot(b[0] - a[0], b[1] - a[1]) / k, rows[i].t]); }
    const top = moves.reduce((b, m) => (m[0] > b[0] ? m : b), [0, null]);
    return { thing: names[j], onFrame: `${Math.round((on.length / rows.length) * 100)}% of the span`, fastest: top[1] != null ? `${top[0].toFixed(1)} px per 1/60 s at ${top[1].toFixed(2)} s` : null };
  });
  return text({
    restsAndReversals: rests.length || snaps.length ? [...rests, ...snaps] : 'none in this span',
    camera: sp.length ? { speedPxPer60th: { min: +sp[0].toFixed(2), median: +sp[sp.length >> 1].toFixed(2), max: +sp[sp.length - 1].toFixed(2) }, fastestAt: fastest.t } : null,
    things: each.length ? each : undefined,
    samples: [`t · camera px per 1/60 s${names.map((n) => ` · ${n} (x, y on the frame)`).join('')}`,
      ...rows.filter((_, i) => i % step === 0).map((r, i) => `${r.t.toFixed(2)} · ${r.speed == null ? (i ? 'cut' : '—') : (r.speed / k).toFixed(2)}${r.things.map((p) => ` · ${p ? `${p[0].toFixed(0)}, ${p[1].toFixed(0)}` : 'not in view'}`).join('')}`)],
  });
}));
server.registerTool('profile', {
  title: 'What a frame takes to draw',
  description: 'Draws the frame at t now, as the director has the film, and says what drawing it took: the page\'s time on the film\'s code (its scene(t), each time it ran), its layers, the scene made ready for the GPU and waiting for it; and the GPU\'s time in each of the renderer\'s passes, the film\'s own passes by their labels, slowest first, and how much of the time from its first pass to its last it was in one (the rest it waited for work). As the viewer draws its frames (its samples and size), or master: as a master render does (the timeline\'s master samples, whole). Measure before making a film faster, and again after. The viewer\'s background rendering shares the GPU and skews the time: turn it off first (prerender).',
  inputSchema: { t: z.number(), master: z.boolean().optional() }, annotations: { readOnlyHint: true },
}, tool(async ({ t, master }) => text(describeProfile(await api('api/profile', { t, master: !!master, agent: true })))));
server.registerTool('prerender', {
  title: 'Pre-render',
  description: 'Whether the studio\'s viewers render the rest of the film in the background, around the director\'s playhead (the editor\'s Pre-render: on, until the studio restarts or you turn it off). Turn it off (on: false) before you time the renderer (profile, ./ephemeris profile), so that the background fill does not share the GPU and skew the measure, and on again when you are done: the director\'s viewer fills the film while it is on. Off, the frame under the playhead, what playing needs, the frames you ask for (frames) and drafts still render. Without on, says which it is.',
  inputSchema: { on: z.boolean().optional() },
}, tool(async ({ on }) => {
  const r = await json(await get(`${STUDIO}/api/prerender`, on === undefined ? {} : { method: 'POST', body: JSON.stringify({ on }) }));
  return text(r.on ? 'Pre-render is on: the viewers render the rest of the film in the background.' : 'Pre-render is off: the viewers render only the frame under the playhead, what playing needs, and what is asked for.');
}));
server.registerTool('stacks', {
  title: 'What its motion is made of',
  description: 'A thing\'s properties (named as pick names it), or the film camera\'s (camera: true), at t: for each, its value, and the stack it comes from — the code\'s operators (base, rate, moves, keys, wander, each with its file:line) and the director\'s changes over them (operators changed, lanes reordered or turned off, lanes of their own) — or that the code computes it without a motion. Or the scene\'s own settings (scene: true): its view (exposure, transform), the lens\'s bloom and vignette (post), the light around (environment: intensity, zenith, horizon, nadir) and the backdrop, each as the code sets it and as the director changed it in the inspector\'s Scene (which goes over the code: a change to the code\'s value under a director\'s Replace does not show). The manual\'s motion chapter explains stacks.',
  inputSchema: { t: z.number(), camera: z.boolean().optional(), scene: z.boolean().optional(), ...Object.fromEntries(Object.entries(thing).map(([k, v]) => [k, v.optional()])) },
  annotations: { readOnlyHint: true },
}, tool(async ({ t, camera, scene, ...sel }) => {
  if (!camera && !scene && !sel.at) throw new StudioError('Name a thing (at, nth… from pick) or pass camera: true or scene: true.');
  const r = await api('api/stacks', { t, sel: camera ? { camera: true } : scene ? { scene: true } : sel });
  if (!r) return text('Not in the scene then.');
  const doc = JSON.parse((await state()).text);
  setOverrides(doc.overrides);
  const entry = (doc.overrides ?? []).find((o) => (camera ? o.on?.camera : scene ? o.on?.scene : o.on && !o.on.camera && o.on.at === sel.at && (o.on.nth ?? 0) === (sel.nth ?? 0)));
  // (and its object's, whole: under its own)
  const whole = !camera && !scene && (doc.overrides ?? []).find((o) => o.on?.sites?.includes(sel.at));
  const lane = (l, ch) => ({ lane: l.id, kind: l.kind, from: l.src === 'yours' ? 'the director' : 'the code', ...(l.ops[0]?.site?.line && { line: `${l.ops[0].site.file}:${l.ops[0].site.line}` }), ...(l.muted && { off: true }), ...(l.ops.some((x) => x.changed) && { changedByTheDirector: true }),
    ...(l.kind === 'moves' ? { moves: l.ops.map((m) => ({ mode: m.mode, t: m.t, dur: m.dur, ...(m.to?.[ch] != null && { to: m.to[ch] }), ...(m.by?.[ch] != null && { by: m.by[ch] }), ease: typeof m.ease === 'string' ? m.ease : m.ease?.easeName ?? 'custom' })) }
      : l.kind === 'keys' ? { mode: l.ops[0].mode, keys: l.ops[0].keys[ch]?.map((k) => [k.t, k.v, k.ease]) } : l.kind === 'rate' ? { perSecond: l.ops[0].rate[ch], from: l.ops[0].from } : l.kind === 'wander' ? { amount: l.ops[0].amp[ch], speed: l.ops[0].speed } : {}) });
  const props = r.props.map((p) => {
    if (p.stack) {
      const s = Stack.from(p.stack), L = s.lanes(p.ch);
      return { property: p.k, value: p.value, motion: `${p.stack.file}:${p.stack.line}`, channel: p.ch, ...(p.stack.log.includes(p.ch) && { note: 'kept as a logarithm (a rig\'s zoom)' }), stack: L.map((l) => (l.kind === 'base' ? { lane: 'base', value: s.base[p.ch] } : lane(l, p.ch))) };
    }
    const ov = entry?.props?.[p.k], all = whole?.props?.[p.k];
    // (the scene's: its numbers take lanes; a colour or the transform the director sets in place of the code's, or keys)
    if (scene) return { property: p.k, value: p.value, code: p.code, ...(ov != null && (typeof p.code === 'number' ? { directorsLanes: asLanes(p.k, ov).lanes } : { directorsValue: ov })) };
    return { property: p.k, value: p.value, code: p.code, motion: 'computed by the code (no motion: one Code lane)', ...(all != null && { directorsLanesOnItsWholeObject: asLanes(p.k, all).lanes }), ...(ov != null && { directorsLanes: asLanes(p.k, ov).lanes }) };
  }).filter((p) => scene || p.stack?.length > 1 || p.directorsLanes || p.directorsLanesOnItsWholeObject || p.value !== p.code || ['x', 'y', 'z', 'tx', 'ty', 'tz', 'zoom', 'yaw', 'pitch', 'roll'].includes(p.property));
  return text({ t, thing: r.label, kind: r.kind, properties: props });
}));

// ---------- pointing things out to the director
server.registerTool('show', {
  title: 'Show the director',
  description: 'Points the director\'s studio at something: moves the playhead to t, selects a thing (as pick names it) or the camera, opens a property\'s motion lanes, or opens a line of the film\'s code in the director\'s Code panel, with a short note. Use it when you say "look at this".',
  inputSchema: {
    t: z.number().optional().describe('Move the playhead here'),
    select: z.object(object).optional().describe('Select this thing (as pick names it), or an object whole (sites, as objects lists it)'),
    camera: z.boolean().optional().describe('Select the film camera'),
    property: z.string().optional().describe('Open this property\'s lanes (x, y, zoom, yaw, roughness…) of what is selected'),
    code: z.object({ file: z.string(), line: z.number() }).optional().describe('Open this line of the code in the Code panel (file relative to the project; engine/… or elements/…: Ephemeris\'s own, read-only)'),
    note: z.string().optional().describe('A short note the director sees'),
  },
}, tool(async (b) => { const r = await api('api/show', b); return text(r.editors ? `Shown in the studio (${r.editors} editor${r.editors > 1 ? 's' : ''} open).` : 'No editor is open to show it in.'); }));

// ---------- checking, rendering
server.registerTool('check', {
  title: 'Quality checks', description: 'Runs the open project\'s quality gates (./ephemeris check): padding, determinism, cues, layer captures. momentum and pacing add two measures a named style can ask for (the camera resting or reversing within a shot; a pointer crossing the screen in under 1.5 s). Run it before you say you are done.', inputSchema: { momentum: z.boolean().optional(), pacing: z.boolean().optional() }, annotations: { readOnlyHint: true },
}, tool(async ({ momentum = false, pacing = false } = {}) => {
  const o = await opened();
  const out = await new Promise((resolve) => {
    let s = '';
    // (the command line as this server runs: the same Node, in a checkout or the app, whose own ./ephemeris is elsewhere)
    const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'ephemeris.mjs'), 'check', o.tid === 'main' ? o.name : `${o.name}/${o.tid}`, ...(momentum ? ['--momentum'] : []), ...(pacing ? ['--pacing'] : [])], { cwd: ROOT });
    p.stdout.on('data', (d) => { s += d; }); p.stderr.on('data', (d) => { s += d; });
    p.on('error', (e) => resolve(`The checks could not start: ${e.message}`));   // (said, not this server ended)
    p.on('close', (code) => resolve(`${s.trim()}\n(exit ${code})`));
  });
  return text(out);
}));
server.registerTool('render_draft', {
  title: 'Render a draft', description: 'Saves the film as a draft video with its music (renders/<timeline>/draft.mp4) from the viewer\'s frames, or only from…to (seconds). Returns at once; status reports progress.', inputSchema: { from: z.number().optional(), to: z.number().optional() },
}, tool(async ({ from, to }) => text(await api('api/render', { from, to }))));

// ---------- the engine's own words: what a name in engine/ or elements/ is (its doc comment and how it is called)
function reference() {
  const out = [];
  for (const dir of ['engine', 'elements']) {
    let files = [];
    try { files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js')); } catch { continue; }
    for (const f of files) {
      const lines = fs.readFileSync(path.join(ROOT, dir, f), 'utf8').split('\n');
      let cls = null, fn = null;
      lines.forEach((l, i) => {
        const top = /^export (?:default )?(?:async )?(function\*?|const|let|class) (\w+)/.exec(l);
        if (/^export (?:default )?class (\w+)/.test(l)) { cls = /class (\w+)/.exec(l)[1]; fn = null; } else if (top) { cls = null; fn = top[2]; } else if (/^\S/.test(l) && !/^\}/.test(l)) cls = fn = null;
        // (a class's methods; and, inside an exported function, the documented methods of what it returns: createFilm.light, rig.to)
        const member = (cls || fn) && /^\s+(?:static |async |get |set )*(\w+)\s*\(.*\)\s*\{/.exec(l), documented = /^\s*(\*\/|\*|\/\*\*)/.test(lines[i - 1] ?? '');
        const name = top ? top[2] : member && !['constructor', 'if', 'for', 'while', 'switch', 'catch', 'function'].includes(member[1]) && (cls ? /^  \S/.test(l) : documented) ? `${cls ?? fn}.${member[1]}` : null;
        if (!name) return;
        const doc = [];
        for (let j = i - 1; j >= 0 && /^\s*(\/\/|\/\*\*|\*|\*\/)/.test(lines[j]); j--) doc.unshift(lines[j].trim().replace(/^(\/\/ ?|\/\*\* ?|\* ?|\*\/)/, ''));
        out.push({ name, where: `${dir}/${f}:${i + 1}`, signature: l.trim().replace(/\s*\{$/, '').slice(0, 220), doc: doc.join(' ').replace(/\s+/g, ' ').trim() });
      });
    }
  }
  return out;
}
server.registerTool('reference', {
  title: 'The engine\'s reference',
  description: 'What a name in the engine or its elements is (a function, a const, a class or its method: motion, rig, swish, F.light, Layer.at, E, tempo…): where it is, how it is called, and its own doc comment. `name`: the name, or a word to look for in names and docs. Read it instead of grepping engine/.',
  inputSchema: { name: z.string() }, annotations: { readOnlyHint: true },
}, tool(async ({ name }) => {
  const all = reference(), q = name.toLowerCase().replace(/^f\./, '');
  const exact = all.filter((x) => x.name.toLowerCase() === q || x.name.toLowerCase().endsWith(`.${q}`));
  const found = exact.length ? exact : all.filter((x) => x.name.toLowerCase().includes(q)).concat(all.filter((x) => !x.name.toLowerCase().includes(q) && x.doc.toLowerCase().includes(q)));
  if (!found.length) return text(`Nothing named or about "${name}" in engine/ or elements/. The manual's chapters (manual) and the engine skill say how films are made.`);
  return text(found.slice(0, 10).map((x) => `${x.name} — ${x.where}\n  ${x.signature}${x.doc ? `\n  ${x.doc.slice(0, 900)}` : ''}`).join('\n\n') + (found.length > 10 ? `\n\n(${found.length - 10} more: name it more closely)` : ''));
}));

// ---------- the manual
server.registerTool('manual', {
  title: 'The manual',
  description: 'How films are made, for the director and the agent alike: without `chapter`, the list of chapters (the manual\'s, and the agent skills\': skill/engine is how films are written); with one, its text.',
  inputSchema: { chapter: z.string().optional() }, annotations: { readOnlyHint: true },
}, tool(async ({ chapter }) => {
  const all = chapters();
  if (!chapter) return text(all.map((c) => `${c.id} — ${c.title}`).join('\n'));
  const c = all.find((x) => x.id === chapter || x.id === chapter.replace(/\.md$/, ''));
  if (!c) throw new StudioError(`No chapter "${chapter}". Chapters: ${all.map((x) => x.id).join(', ')}`);
  return text(fs.readFileSync(path.join(ROOT, c.file), 'utf8'));
}));
for (const c of chapters()) {
  server.registerResource(c.id, `ephemeris://manual/${c.id}`, { title: c.title, mimeType: 'text/markdown', description: `The manual: ${c.title}` },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: fs.readFileSync(path.join(ROOT, c.file), 'utf8') }] }));
}

await server.connect(new StdioServerTransport());
log(`ready (studio: ${STUDIO})`);
