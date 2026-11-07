// The studio: Ephemeris's editor for every project in projects/. Its picker opens independent timelines at
// /p/<name>/<timeline>/. A project's timelines (timelines/<id>.json: sequences sharing its code, layers and media; `main` is its default) are edited like any NLE's: every edit is autosaved, each change to the
// project kept as a version of it (its history: history.mjs), and the film renders live into the viewer (preview.mjs) —
// whenever the film's code,
// Ephemeris or the timeline changes, the frames are rendered again, the one under the playhead first. The editor plays
// the timeline's audio itself, so audio edits never need a re-render. A project's film page is served on demand: by
// the shared dev server, or by the project's own (project.json `serve`).
//   node tools/nle.mjs [--project projects/<name>[/<timeline>]] [--url <film page>] [--port 5340] [--workers 8]
// Open http://localhost:5340 — press ? in the editor for the keys. Agents read the viewer and state of the open
// timeline at /p/<name>/<timeline>/… (.agents/skills/engine/nle.md).
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { format, blank, filmPage, samplesOf, clipEnd, TIMELINE_ID, detectedGrid, sameGrid, isVisual } from '../nle/model.js';
import { resolveInstrument } from './notes.mjs';
import { soundLibrary } from './workspace.mjs';
import { anchor, renameSites, orphansIn, parseSite } from '../nle/anchors.js';
import { createPreview } from './preview.mjs';
import { mixTimeline } from './mix.mjs';
import { jpeg as jpegOf, compress } from './frames.mjs';
import { createCaches, setCacheLimit, previewsOf } from './cache.mjs';
import { list as mediaList, probe as mediaProbe, probeAll, ensureFrames, kindOf, MEDIA_DIRS } from './media.mjs';
import { folder, readText } from './files.mjs';
import { migrateText, VERSION } from './migrations/index.mjs';
import { kept as keptMusic, ensure as ensureMusic, listening } from './music.mjs';
import { record, versions, version as versionAt, textAt, changes, diff as diffOf, restore, sources, holds, lastChanged, unkept, tags, tag, untag, resolve } from './history.mjs';
const LOOKS = ['accurate', 'fast', 'solid', 'wire'];   // (the viewer's looks: LOOKS in engine/render/index.js)
import { openWorker, crew, workerCount, setWorkerCount } from './worker.mjs';
import { rendererVersion, clearGpuCaches } from './browser.mjs';
import { createAgents } from './agent.mjs';
import { imageFile } from './agents/images.mjs';
import { serveLink } from './link.mjs';
import { workspace, version, config, configure } from './workspace.mjs';
import { watchMachine } from './machine.mjs';
import { renderBrowsers } from './browser.mjs';
import { closeModels } from './models.mjs';
import { listInstruments, instrumentData, sampleFile } from './instrument-api.mjs';
import { pluginSocket, findPlugins, pluginPresets } from './plugins.mjs';
import { presetFolders, setFolders, takePreset, vialData } from './presets.mjs';
import { WebSocketServer } from 'ws';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..'), UI = path.resolve(HERE, '../nle');
// the films: in the workspace (this checkout, or the folder chosen for them: see workspace.mjs)
const WS = workspace(), PROJECTS = path.join(WS, 'projects');
const PORT = +(args.port || 5340), WORKERS = +(args.workers || 8);
const ENGINE = version();
const NAME_OK = /^[\w][\w.-]*$/;
const projectDir = (name) => (NAME_OK.test(name || '') && fs.existsSync(path.join(PROJECTS, name)) && fs.statSync(path.join(PROJECTS, name)).isDirectory() ? path.join(PROJECTS, name) : null);
const [argName, argTimeline = null] = (args.project ? path.relative(PROJECTS, path.resolve(args.project)) : '').split(path.sep);
if (args.project && (!argName || argName.startsWith('..'))) { console.error(`a project lives in ${PROJECTS}`); process.exit(1); }
// a project's timelines: main first, then by name
const timelineIds = (dir) => { try { return fs.readdirSync(path.join(dir, 'timelines')).map((f) => /^(.+)\.json$/.exec(f)?.[1]).filter((id) => id && TIMELINE_ID.test(id)).sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b))); } catch { return []; } };
// the timeline a project last had open (renders/ is the machine's own: in no version of the project)
const lastFile = (dir) => path.join(dir, 'renders', 'studio.json');
const lastTimeline = (dir) => { try { const t = JSON.parse(fs.readFileSync(lastFile(dir), 'utf8')).timeline; if (timelineIds(dir).includes(t)) return t; } catch { /* none */ } return 'main'; };

// Vial's data folder: links to the preset folders, for its own browser (where this machine has Vial: tools/presets.mjs)
function syncVial(dir) {
  try { if (findPlugins().some((x) => x.name === 'Vial')) vialData(dir); } catch (e) { console.warn(`studio: Vial's preset folders: ${e.message}`); }
}

// ---------- film pages: served on demand, by the shared dev server or a project's own; the studio stops what it started
const servers = new Map(), told = new Set();
const up = (url) => fetch(url, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
async function ensureServed(dir, url) {
  if (!url || (await up(url))) return;
  // (Vite's own script, run by node: a packaged studio has no node_modules/.bin, and is read-only: its config is loaded
  // as it is, not compiled beside it)
  let key = 'shared', cmd = process.execPath, a = [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', path.join(ROOT, 'vite.config.js'), '--configLoader', 'native'], cwd = WS;
  try { const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')); if (p.serve) { key = dir; cmd = path.join(dir, p.serve); a = []; cwd = dir; } } catch { /* the shared one */ }
  if (servers.has(key)) return;
  if (!told.has(url)) { told.add(url); console.log(`studio: starting ${key === 'shared' ? 'the shared dev server' : `${path.relative(WS, cmd)}`} for ${url}`); }   // (once: the viewer asks again while it is down)
  const child = spawn(cmd, a, { cwd, stdio: 'ignore', windowsHide: true });
  servers.set(key, child);
  child.on('exit', () => servers.delete(key));
  child.on('error', (e) => { console.log(`studio: could not start ${cmd}: ${e.message}`); servers.delete(key); });
}

// ---------- the open timeline: its project and its history, its file (saves serialized), its viewer, its watchers
async function openTimeline(name, tid) {
  const DIR = path.join(PROJECTS, name), REL = `timelines/${tid}.json`, FILE = path.join(DIR, REL);
  const urlArg = argName === name ? args.url : undefined;

  // Vial's own browser shows the preset folders, This project's being this one's (tools/presets.mjs)
  syncVial(DIR);
  fs.mkdirSync(path.join(DIR, 'timelines'), { recursive: true });
  const made = !fs.existsSync(FILE);
  if (made) fs.writeFileSync(FILE, format(blank(urlArg)));

  // the project's history (history.mjs): each change to it kept as a version of the whole — at once for a save that
  // says what it is (the editor's, an agent's), else once the files have been still a moment, saying which changed. A
  // version holds whatever else changed meanwhile: the messages waiting are said with it. The editor hears of each
  // version on its events, with its row of the History (a request of its own can wait behind the viewer's, which hold
  // the browser's few connections to the studio while the film loads again).
  let said = [], keepTimer = null;
  const entry = (v) => ({ n: v.n, at: v.at, message: v.message, ...changes(versionAt(DIR, v.n - 1), v) });
  const kept = (v) => { if (v) send('history', { version: entry(v) }); return v; };
  function keep(message) {
    clearTimeout(keepTimer); keepTimer = null;
    const all = [...said, message].filter(Boolean);
    said = [];
    return kept(record(DIR, all.length > 1 ? [all.map((m) => m.split('\n')[0]).join('; '), ...all.map((m) => m.split('\n').slice(1).join('\n').trim()).filter(Boolean)].join('\n\n') : all[0]));
  }
  function keepSoon(message) {
    if (message && !said.includes(message)) said.push(message);
    clearTimeout(keepTimer);
    keepTimer = setTimeout(() => { try { keep(); } catch (e) { console.warn(`studio: ${name}'s history: ${e.message}`); } }, 1500);
  }
  const clients = new Set();
  const send = (type, data) => { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  // (as the studio finds it: what changed while it was not looking is a version of its own)
  try { record(DIR, !versions(DIR).length ? 'The film as its history starts' : made ? `new timeline ${tid}` : 'Changed while the studio was closed'); }
  catch (e) { console.warn(`studio: ${name}'s history: ${e.message}`); }
  // (a timeline in an older format: migrated, kept as a version of its own after the one above, the History undoing it)
  {
    const was = fs.readFileSync(FILE, 'utf8'), m = migrateText(was, format);
    if (m.text !== was) {
      fs.writeFileSync(FILE, m.text);
      console.log(`studio: ${name}/${tid} ${m.from < VERSION ? `migrated from format ${m.from} to ${VERSION}` : 'completed'}${m.said.length ? `: ${m.said.join('; ')}` : ''}`);
      try { record(DIR, [`${REL} in format ${VERSION}`, ...m.said].join('\n')); } catch (e) { console.warn(`studio: ${name}'s history: ${e.message}`); }
    }
  }

  // timeline.json: a save only lands on the version the editor last saw (or on that version with its changes' names
  // followed where the film's code moved: the save is renamed the same way, see rekey)
  let disk = fs.readFileSync(FILE, 'utf8'), queue = Promise.resolve(), lastRekey = null, rekeys = 0;
  const doc = () => { try { return JSON.parse(disk); } catch { return {}; } };
  // the changes kept on the film's code (nle/anchors.js): a timeline's text as it is to be written
  const codeFile = (f) => { const p = path.resolve(DIR, f); if (!p.startsWith(DIR + path.sep)) return null; try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  // the music on its audio tracks (media id → what tools/music.mjs found, where it has: renders/media/<file>/music.json),
  // and the grid a Detected timeline takes from it (nle/model.js, detectedGrid)
  // (a medium's file, by its path in the project — assets/…, media/… — where it is in the project)
  const srcOf = (m) => { const r = path.relative(DIR, path.resolve(DIR, m?.src ?? '')); return m?.src && r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : null; };
  const songsOf = (d) => [...new Set((d.tracks ?? []).filter((t) => !isVisual(t)).flatMap((t) => t.clips.map((c) => c.media)))].filter((id) => srcOf(d.media?.[id]));
  const musicOf = (d) => Object.fromEntries(songsOf(d).map((id) => [id, keptMusic(DIR, srcOf(d.media[id]))]).filter(([, m]) => m));
  const anchored = (text) => {
    const a = anchor(JSON.parse(text), codeFile), g = a.doc.grid?.auto && detectedGrid(a.doc, musicOf(a.doc));
    if (g && !sameGrid(g, a.doc.grid)) { a.doc.grid = g; a.changed = true; a.grid = g; }
    return { ...a, text: a.changed ? format(a.doc) : text };
  };
  // each song placed is listened to once (a sound under 10 s is an effect or a voice: not), apart from the server; the
  // editor hears when one is done, and a Detected grid follows it
  const asked = new Set();
  async function listen() {
    const d = doc(), want = [...new Set(songsOf(d).map((id) => srcOf(d.media[id])))].filter((n) => !asked.has(n) && fs.existsSync(path.join(DIR, n)));
    if (!want.length) return;
    const infos = await probeAll(DIR, want);
    for (const [k, n] of want.entries()) {
      asked.add(n);
      const info = infos[k];
      if (info?.kind !== 'audio' || !(info.duration >= 10)) continue;
      ensureMusic(DIR, n).then((r) => { if (!r.made) return; send('music', { media: n }); rekey('music').catch(() => {}); });
    }
  }
  // (an agent's write is sent to the open editors as a change on disk: the editor's own saves are not, it has them)
  function save({ text, base, message, agent = false }) {
    return (queue = queue.then(async () => {
      const now = fs.readFileSync(FILE, 'utf8');
      let a, map = null, rekeyed = null;
      // (in the editor's layout, whoever wrote it: one line per medium, clip, cue and note, so a version's diff is its edit)
      try { text = format(JSON.parse(text)); } catch (e) { return { status: 400, body: { error: `not JSON: ${e.message}` } }; }
      text = migrateText(text, format).text;   // (written in an older format: an editor not loaded again since, an agent's)
      if (now !== base) {
        if (!(lastRekey && base === lastRekey.before && now === lastRekey.after)) return { status: 409, body: { conflict: true, text: now } };
        ({ map } = lastRekey); rekeyed = lastRekey.n; text = format(renameSites(JSON.parse(text), map));
      }
      try { a = anchored(text); } catch (e) { return { status: 400, body: { error: e.message } }; }
      if (Object.keys(a.map).length) map = { ...map, ...a.map };
      const before = disk;
      disk = a.text;
      fs.writeFileSync(FILE, a.text);
      each((p) => p.timelineChanged(before, a.text));
      if (agent) send('disk', { text: a.text });
      listen().catch(() => {});
      // (the editor takes in what the studio changed of its save: the code its changes are on, names followed)
      const back = a.text !== text || map ? { text: a.text, map, rekey: rekeyed } : {};
      try { return { status: 200, body: { ok: true, version: keep(message || `edit timeline ${tid}`)?.n ?? null, ...back } }; }   // (null: as a version already was, undone back to it say)
      catch (e) { return { status: 500, body: { error: `could not keep it in the history: ${e.message}`, written: true } }; }
    }));
  }
  // the film's code changed (or the timeline was opened): its changes followed to where their code now is, or orphaned,
  // kept with the change that moved them; the editor renames its copies (and its undo) the same way. → whether names changed
  function rekey(why) {
    return (queue = queue.then(async () => {
      const before = fs.readFileSync(FILE, 'utf8');
      let a; try { a = anchored(before); } catch { return false; }
      if (a.text === before) return false;
      disk = a.text;
      fs.writeFileSync(FILE, a.text);
      const renamed = Object.keys(a.map).length > 0;
      const n = ++rekeys;
      lastRekey = { n, before, after: a.text, map: a.map };   // (a save made on the version before lands on this one)
      send('rekey', { n, before, text: a.text, map: a.map, orphans: a.orphans });
      if (why === 'music') each((p) => p.timelineChanged(before, a.text));
      keepSoon(a.grid && !renamed ? gridMessage(a.grid) : rekeyMessage(a.map, why));
      return renamed;
    }));
  }
  // outside writes (Claude adding notes or cues): the editor reloads them if it has nothing pending, else it warns
  // (taken away: closed, its editors going to the project's first timeline)
  function diskChanged() {
    if (!fs.existsSync(FILE)) { if (isOpen(name, tid)) closeTimeline(name, tid, `${name}/${timelineIds(DIR)[0] ?? 'main'}`, 'deleted'); return; }
    let text; try { text = fs.readFileSync(FILE, 'utf8'); JSON.parse(text); } catch { return; }   // mid-write
    // (written in an older format, a version restored from before a migration say: migrated, and written so)
    const m = migrateText(text, format);
    if (m.text !== text) { text = m.text; fs.writeFileSync(FILE, text); }
    if (text !== disk) {
      const was = disk; each((p) => p.timelineChanged(was, text)); disk = text; send('disk', { text }); listen().catch(() => {});
      // (kept at once: the editor's next save may be written over it, the director choosing theirs)
      try { keep(`${REL} written outside the editor`); } catch (e) { console.warn(`studio: ${name}'s history: ${e.message}`); }
    }
  }
  // the project's other timelines, made, changed or taken away (by an agent, a restore, another tool): the editors'
  // tabs follow, and what the last version does not hold of them is kept, saying so (what the studio kept itself, its
  // timeline menu's, is not said again)
  const others = new Set();   // (the files of theirs the watcher named since)
  async function othersChanged() {
    const c = unkept(DIR, [...others]), id = (r) => r.slice('timelines/'.length, -'.json'.length);
    others.clear();
    for (const r of c.added) keepSoon(`new timeline ${id(r)}`);
    for (const r of c.removed) keepSoon(`delete timeline ${id(r)}`);
    if (c.changed.length) keepSoon(`${c.changed.join(', ')} changed`);
    send('timelines', await timelines(DIR));
  }
  let watchTimer = null, othersTimer = null;
  const timelineWatch = fs.watch(path.join(DIR, 'timelines'), (_, f) => {
    if (f === `${tid}.json`) { clearTimeout(watchTimer); watchTimer = setTimeout(diskChanged, 120); return; }
    const other = /^(.+)\.json$/.exec(String(f))?.[1];
    if (!other || !TIMELINE_ID.test(other)) return;
    others.add(`timelines/${other}.json`);
    clearTimeout(othersTimer);
    othersTimer = setTimeout(() => othersChanged().catch((e) => console.warn(`studio: ${name}'s timelines: ${e.message}`)), 250);
  });

  // the project's versions, newest first, each with what it changed and its tags (the latest 300)
  function history() {
    const all = versions(DIR), t = Object.entries(tags(DIR));
    return all.slice(-300).reverse().map((v, i, l) => ({ n: v.n, at: v.at, message: v.message, tags: t.filter(([, n]) => n === v.n).map(([k]) => k), ...changes(l[i + 1] ?? all[all.length - l.length - 1] ?? null, v) }));
  }

  // the viewer: rendered live (preview.mjs); R makes renders/draft.mp4 from the same frames. Its page carries the
  // project's settings (gi, shadows, reflections, rendering, pixelFilter, pixelFilterType), so changing one reloads the workers and
  // renders the film again
  const filmUrl = () => filmPage(doc(), urlArg || doc().url || '', tid);
  const settings = () => ({ fps: doc().fps || 60, shutter: doc().shutter ?? 180, samples: samplesOf(doc()).viewer, master: samplesOf(doc()).master });
  // The viewer's look (Blender's viewport shading: LOOKS in engine/render/index.js): each its own frames, rendered
  // while it is the one shown. Accurate's (the film as it renders) is also the draft's, and what agents see.
  let look = 'accurate', at = null;
  // the size the viewer's frames are drawn at, of the film's frame (the editor's Preview size: see preview.mjs)
  let size = 1;
  let stats = 0;   // (editors' viewers showing what drawing their frames took: while any does, the frames drawn keep it)
  const previews = {}, viewers = new Set();   // (viewers: the editors' viewer sockets, viewerSocket)
  // (frames slow to draw, in the look the viewer shows: the film's agents told, as the studio's note — see preview.mjs SLOW_MS)
  // what this film's browsers are compiling, for the viewer's corner: for each the shader it is on now, and how far along
  // its run of them, kept until none is compiling so that the count does not go back as one finishes first. An event
  // { now: [{ name, workers }], done, total, workers }, now empty when they are done.
  const compiling = new Map();
  let compilingSoon = null;
  const tellCompiling = () => {
    clearTimeout(compilingSoon); compilingSoon = null;
    const on = [...compiling.values()].filter((c) => c.now), now = new Map();
    for (const c of on) now.set(c.now, (now.get(c.now) ?? 0) + 1);
    const all = [...compiling.values()];
    send('compiling', { now: [...now].map(([name, workers]) => ({ name, workers })), done: all.reduce((a, c) => a + c.done, 0), total: all.reduce((a, c) => a + c.total, 0), workers: on.length });
    if (!on.length) compiling.clear();
  };
  const sayCompiling = (worker, c) => {
    if (c) compiling.set(worker, c); else compiling.delete(worker);
    if (![...compiling.values()].some((x) => x.now)) tellCompiling(); else compilingSoon ??= setTimeout(tellCompiling, 150);
  };
  // what this film's workers are on, for the viewer to say while its picture is behind (the event 'working': [{ what, t, ago: how long, ms }])
  const working = new Map();
  let workingSoon = null;
  const tellWorking = () => { clearTimeout(workingSoon); workingSoon = null; const now = Date.now(); send('working', [...working.values()].map(({ what, t, since }) => ({ what, t, ago: now - since }))); };
  const sayWorking = (who, what, t) => { if (what) working.set(who, { what, t, since: Date.now() }); else working.delete(who); workingSoon ??= setTimeout(tellWorking, 150); };
  const slowNote = (z) => `The viewer's frames of ${name}/${tid} are slow to draw: ${(z.ms / 1000).toFixed(1)} s each around ${z.from.toFixed(1) === z.to.toFixed(1) ? z.from.toFixed(1) : `${z.from.toFixed(1)}–${z.to.toFixed(1)}`} s, at ${Math.round(z.size * 100)}% of the frame's size and ${z.samples} samples a frame (more where depth of field or a fast camera asks). The director waits that long for each new frame. Profile one there (profile) to see what it costs before adding more.`;
  const previewOf = (l) => (previews[l] ??= createPreview({ out: path.join(DIR, 'renders', tid), cache: previewsOf(DIR, tid), url: filmUrl, settings, timeline: FILE, workers: WORKERS, engine: ENGINE,
    onFrame: (fr) => { viewers.forEach((v) => v.stored(l, fr)); caches.check(); }, stats: () => stats > 0,
    onSlow: (z) => { if (z && look === l) agents.note(name, slowNote(z)); },
    onCompiling: (k, c) => sayCompiling(`${l} ${k}`, c),
    onWork: (k, what, t) => { if (look === l || !what) sayWorking(`${l} ${k}`, what, t); },
    shaders: studioPrint, stamp: () => fingerprint(DIR, FILE), newest: () => newestOf(DIR, FILE), look: l, active: () => clients.size > 0 && look === l, prerender: () => prerender, size: () => size, serve: () => ensureServed(DIR, urlArg || doc().url),
    // (an editor's own film drawing them: engine/runtime.js preview, the first of this machine's workers)
    drawn: () => [...viewers].some((v) => v.fills),
    send: (type, data) => { if (type !== 'preview' || look === l) send(type, data); } }));   // (the viewer hears the look it shows)
  const preview = previewOf('accurate'), view = () => previews[look];
  const each = (fn) => Object.values(previews).forEach(fn);
  ensureServed(DIR, urlArg || doc().url);
  // the videos it shows have their frames (renders/ is in no version: decoded again where missing)
  for (const m of Object.values(doc().media ?? {})) if (m.kind === 'video' && m.w && srcOf(m) && fs.existsSync(path.join(DIR, srcOf(m)))) ensureFrames(DIR, { ...m, src: srcOf(m) }).then((made) => made && each((p) => p.invalidate()));

  // the film's own files: any change renders the film again (Ephemeris's are watched once, for whichever is open;
  // the project's other timelines are not this film's)
  // (its changes follow the code first, so the film renders once, with them where they now belong; a change already
  // taken in, by settle, is not taken in again)
  // (the project's own files changed are kept in its history, saying which, and are sent to the code panel; those the
  // panel changed say so already: told, by path, what it left there, its text or null where it took the file away)
  let files = filesPrint(DIR);
  const told = new Map();
  function filesChanged(paths = []) {
    // (a path whose folder is gone too is left out: the folder is said, and a watched folder taken away names itself in itself)
    const mine = [...new Set(paths.filter((p) => p.startsWith(DIR + path.sep) && fs.existsSync(path.dirname(p))).map((p) => path.relative(DIR, p).split(path.sep).join('/')))];
    if (mine.length) {
      // (with the film's code as it now is, and the text of each file of it changed, for the code panel)
      const src = sources(DIR), code = Object.keys(src).filter((r) => !r.startsWith('timelines/'));
      send('files', { paths: mine, code, texts: Object.fromEntries(mine.filter((r) => code.includes(r)).map((r) => [r, src[r].toString('utf8')])) });
      // (what is as the last version holds it is not said: a file a tool wrote and took away again, sed's or one written
      // beside another and renamed over it)
      const read = (r) => src[r]?.toString('utf8') ?? null, c = unkept(DIR, mine.filter((r) => !(told.has(r) && told.get(r) === read(r))));
      const others = [...c.changed, ...c.added, ...c.removed];
      for (const r of mine) told.delete(r);
      keepSoon(others.length ? `${others.join(', ')} changed` : null);
    }
    const now = filesPrint(DIR);
    if (now === files) return Promise.resolve();
    files = now;
    if (paths.includes(path.join(DIR, 'sound.js'))) send('sound', {});   // (the film's sound code: the editor runs it again)
    // (a file its pages never asked for is not the film's: notes, a script that places sounds, a bake's own page; its
    // frames stay. Ephemeris's own files, and any change while no page has loaded the film, count)
    const said = paths.length ? path.relative(WS, paths.at(-1)) : 'a file';
    if (paths.length && !paths.some((p) => madeOf(p))) { console.log(`viewer: ${said} changed, not one the film's pages load: its frames kept`); each((p) => p.restamp()); return Promise.resolve(); }
    console.log(`viewer: ${said} changed, rendering again`);
    return rekey('code').catch(() => {}).then(() => each((p) => p.invalidate()));
  }
  // whether the film is made of the file at p, as its pages asked its server for it (its folder's files are asked for at
  // /projects/<name>/…: a film another server serves, or whose pages have not loaded since it changed, is not known)
  function madeOf(p) {
    if (!p.startsWith(DIR + path.sep)) return true;
    const asked = preview.files(), at = `/${path.relative(WS, p).split(path.sep).join('/')}`, mine = `/${path.relative(WS, DIR).split(path.sep).join('/')}/`;
    if (!asked || ![...asked].some((a) => a.startsWith(mine))) return true;
    return asked.has(at) || [...asked].some((a) => a.startsWith(`${at}/`));
  }
  const stopWatching = watchTree(DIR, filesChanged);
  // the project's instruments (not the film's: its frames stay): a file changed is fetched again by the editor, which
  // keeps each instrument by the file it names (the folder made here if missing, so that one written later is seen)
  fs.mkdirSync(path.join(DIR, 'instruments'), { recursive: true });
  const stopInstruments = watchTree(path.join(DIR, 'instruments'), (paths) => send('instruments', { files: paths.map((p) => path.relative(DIR, p).split(path.sep).join('/')) }));

  // the code may have changed while the studio was not watching: the changes follow it now (only the code they are on
  // remembered, the first time: the film looks the same)
  rekey('open').then((renamed) => each((p) => (renamed ? p.invalidate() : p.restamp()))).catch(() => {});
  listen().catch(() => {});

  // the director's view: the scene at a time from a free camera, by workers of its own — one while its camera moves
  // (a worker that drew this time draws it again from another angle without touching the DOM), up to three while it
  // plays, as many as make it faster (each renders a frame ahead of the playhead; closed 15 s after). The first also
  // draws the viewer's frame the cache has not rendered, as the editor has the film (its edits, before they are saved),
  // and picks and finds things. Each request has its turn, as a system's quality of service: 'now', what the director is
  // waiting on (a frame, a pick, where things are); 'idle', a paused frame drawn on, after those; 'slow', a question about
  // the film (its objects, its lanes, the camera's path: seconds on a film whose code is heavy), which never holds the page:
  // it goes on in the gaps between everything else, other questions too (engine/runtime.js inGaps).
  // Opened on demand, loaded again when the film changes (its overrides alone taken in as they are, as the viewer's
  // are), closed after five minutes unused; a page whose GPU failed is replaced.
  const slots = [], waiting = [];
  // playing: as many as make it faster, up to three (see crew)
  let idleTimer = null, extraTimer = null, playing = false;
  const ahead = crew(3, () => pump());
  // the film as its code is now cannot start (a syntax error, say): every request answers with why at once, not each
  // after a page of its own has failed to start (the editor's are many, and the browser waits on them for any other)
  let unstartable = null;
  const TURNS = { now: 0, idle: 1, slow: 2 };
  async function runOn(slot, req) {
    const slow = req.turn === 'slow';
    let holding = true;
    slot.busy = true;
    try {
      const url = filmUrl(), { gen, loaded, overrides } = preview.film();
      if (unstartable?.url === url && unstartable.loaded === loaded) throw unstartable.e;
      const who = `director ${slots.indexOf(slot)}`;
      try {
        if (!slot.w || slot.url !== url || slot.loaded !== loaded) sayWorking(who, 'loading');
        if (!slot.w || slot.url !== url) { await slot.w?.close(); slot.w = null; slot.w = await openWorker(url, `d${slots.indexOf(slot)}`, (c) => sayCompiling(`director ${slots.indexOf(slot)}`, c)); Object.assign(slot, { url, gen, loaded, t: null }); }
        else if (slot.loaded !== loaded) { await slot.w.reload(); Object.assign(slot, { gen, loaded, t: null }); }
      } catch (e) { if (e.boot) unstartable = { url, loaded, e }; throw e; } finally { sayWorking(who); }
      if (slot.gen !== gen) { await slot.w.overrides(overrides ?? []); Object.assign(slot, { gen, t: null }); }
      if (req.t != null) sayWorking(who, 'drawing', req.t);
      if (slow) { holding = false; slot.busy = false; slot.slow = (slot.slow ?? 0) + 1; pump(); }   // (its page is up to date: frames may go ahead of it)
      const out = await req.job(slot.w).finally(() => { if (!slow) sayWorking(who); });
      if (req.t != null) slot.t = req.t;
      if (req.ahead) ahead.done(slots.indexOf(slot));
      req.resolve(out);
    } catch (e) {
      // a page whose GPU failed (out of memory, say) fails every frame after: the next request opens another
      // (a question's page loaded again under it by a frame is no failure of the page)
      if (holding && /GPU error|OUT_OF_DEVICE_MEMORY|out of memory|closed|crash/i.test(String(e.message))) { const w = slot.w; slot.w = null; w?.close(); if (req.ahead) ahead.full(); if (/OUT_OF_DEVICE_MEMORY|out of memory/i.test(String(e.message))) each((p) => p.makeRoom()); }
      req.reject(e);
    } finally { if (holding) slot.busy = false; else slot.slow--; pump(); }
  }
  function pump() {
    clearTimeout(idleTimer); idleTimer = setTimeout(closeDirectors, 300_000);
    // (those opened for the director's view playing hold GPU memory the viewer's renders want: closed once it stops)
    if (waiting.some((r) => r.ahead)) { clearTimeout(extraTimer); extraTimer = setTimeout(closeExtra, 15_000); }
    // (the director's own requests first, an agent's after them, each by its turn: in the order they came)
    for (const req of [...waiting].sort((a, b) => a.agent - b.agent || TURNS[a.turn] - TURNS[b.turn])) {
      if (req.ahead && !playing) { playing = true; ahead.reset(); }
      const free = (req.ahead ? slots.slice(0, ahead.n) : slots).filter((s) => !s.busy);
      let slot = free.find((s) => s.w && s.t === req.t) ?? free.find((s) => s.w) ?? free[0];
      if (!slot && (slots.length === 0 || (req.ahead && slots.length < ahead.n))) slots.push((slot = {}));
      if (!slot) return;
      waiting.splice(waiting.indexOf(req), 1);
      runOn(slot, req);
    }
  }
  async function closeExtra() {
    for (const s of slots.slice(1).filter((x) => !x.busy && !x.slow)) { slots.splice(slots.indexOf(s), 1); await s.w?.close(); }
    playing = false;
  }
  async function closeDirectors() {
    clearTimeout(idleTimer);
    for (const s of slots.filter((x) => !x.busy && !x.slow)) { slots.splice(slots.indexOf(s), 1); await s.w?.close(); }
    playing = false;
  }
  const director = (job, t = null, ahead = false, agent = false, turn = 'now') => new Promise((resolve, reject) => { waiting.push({ job, t, ahead, agent, turn, resolve, reject }); pump(); });
  // questions of the director's about the film as it is (`kind`: objects, lanes, lights…, each asked of a q), each
  // answered once for what the film is made of (the viewer's stamp) and kept with the timeline across switches
  // (answers): asked again, even while it is being answered, it is that answer. Those not answered yet are answered
  // together, by job(their qs) (→ an answer each, in order)
  function answerAll(kind, qs, job, agent = false, turn = 'slow') {
    const { made } = preview.film();
    let a = answers.get(FILE);
    if (a?.made !== made) a = { made, kinds: new Map() };
    latest(answers, FILE, a, ANSWERED.timelines);
    const got = a.kinds.get(kind) ?? new Map();
    a.kinds.set(kind, got);
    const keys = qs.map((q) => JSON.stringify(q)), had = keys.map((k) => got.get(k)), ask = qs.filter((_, i) => !had[i]);
    const all = ask.length ? director(job(ask), null, false, agent, turn) : null;
    let j = 0;
    return keys.map((key, i) => {
      let p = had[i];
      if (!p) {
        const n = j++;
        p = all.then((r) => r[n]);
        p.catch(() => { if (got.get(key) === p) got.delete(key); });   // (one that failed is asked again)
      }
      latest(got, key, p, ANSWERED.each);
      return p;
    });
  }
  const answer = (kind, q, job, agent = false) => answerAll(kind, [q], () => async (w) => [await job(w)], agent)[0];

  // the timeline's sound as one file, for an editor that does not play it itself (a phone's simple view, a page with no
  // live engine: nle/audio.js useMix): made by the engine a draft's sound is (mix.mjs), as AAC, kept beside the viewer's
  // frames until what is heard changes (its key: the tracks heard and their media, the mixer, the grid, and the dates of
  // the sound code, the instruments and the media files), then made again; the editors told when one is made ('mix')
  const MIXES = previewsOf(DIR, tid);
  let mixing = null, mixError = '';
  const dated = (f) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return ''; } };
  function mixKey() {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8')), tracks = d.tracks.filter((t) => !isVisual(t));
    const used = new Set(tracks.flatMap((t) => t.clips.map((c) => c.media))), media = Object.fromEntries(Object.entries(d.media).filter(([id]) => used.has(id)));
    let instruments = [];
    try { instruments = fs.readdirSync(path.join(DIR, 'instruments'), { recursive: true }).sort().map((f) => `${f}=${dated(path.join(DIR, 'instruments', f))}`); } catch { /* none */ }
    const files = Object.values(media).map((m) => m.src && dated(path.join(DIR, m.src)));
    return crypto.createHash('sha1').update(JSON.stringify([tracks, media, d.master, d.buses, d.grid, dated(path.join(DIR, 'sound.js')), instruments, files])).digest('hex').slice(0, 16);
  }
  /** The timeline's mix as it is heard now: { key, ready, none (no sound), error }; made now if it is not yet. */
  function mix() {
    const key = mixKey(), file = path.join(MIXES, `mix-${key}.m4a`);
    if (fs.existsSync(file)) return { key, ready: true };
    if (fs.existsSync(`${file}.none`)) return { key, ready: true, none: true };
    mixing ??= (async () => {
      const wav = path.join(MIXES, `.mix-${key}.wav`), part = path.join(MIXES, `.mix-${key}.m4a`);
      fs.mkdirSync(MIXES, { recursive: true });
      try {
        if ((await mixTimeline(FILE, wav)).duration > 0) {
          await new Promise((resolve, reject) => {
            const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', part], { stdio: ['ignore', 'ignore', 'pipe'] });
            let err = ''; p.stderr.on('data', (d) => { err += d; });
            p.on('error', reject); p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim()}`))));
          });
          fs.renameSync(part, file);
        } else fs.writeFileSync(`${file}.none`, '');
        for (const f of fs.readdirSync(MIXES)) if (/^mix-/.test(f) && !f.startsWith(`mix-${key}.`)) fs.rmSync(path.join(MIXES, f), { force: true });
        mixError = '';
        send('mix', { key });
      } catch (e) { mixError = String(e.message || e); send('mix', { key, error: mixError }); }
      finally { fs.rmSync(wav, { force: true }); fs.rmSync(part, { force: true }); mixing = null; }
    })();
    return { key, ready: false, ...(mixError && { error: mixError }) };
  }

  return {
    mix, mixFile: (key) => (/^[0-9a-f]{16}$/.test(key) ? path.join(MIXES, `mix-${key}.m4a`) : null),
    name, tid, dir: DIR, rel: REL, clients, viewers, send, save, keep, history, preview, view, previews, settings,
    shown: () => each((p) => p.shown()),
    /** The timeline's songs as tools/music.mjs heard them: { media id: its analysis }, and those still being listened to. */
    music: () => { const d = doc(), m = musicOf(d); return { music: m, listening: songsOf(d).filter((id) => !m[id] && asked.has(srcOf(d.media[id])) && listening(DIR, srcOf(d.media[id]))) }; },
    // (preview: the look the viewer shows; accurate: the film as it renders, which agents read)
    state: () => ({ name, timeline: tid, file: REL, dir: path.relative(WS, DIR).split(path.sep).join('/'), root: DIR, text: fs.readFileSync(FILE, 'utf8'), url: filmUrl(), urlFixed: !!urlArg, render: preview.render, draft: preview.readDraft(), preview: view().state(), accurate: preview.state(), engine: ENGINE, workers: workerCount() }),
    look: () => look,
    answer, answerAll,
    /** The viewer shows look l (LOOKS): its frames, from where the playhead is. */
    setLook(l) {
      if (!LOOKS.includes(l) || l === look) return;
      const was = previews[look];
      look = l;
      const p = previewOf(l);
      if (at) p.playhead(at.f, at.playing, at.every);
      was.shown(); p.shown();
      if (was !== preview) was.shed(0, true);   // (a look other than Accurate draws again at once: its frames are not kept, tools/cache.mjs)
    },
    playhead(f, playing, every) { at = { f, playing, every }; view().playhead(f, playing, every); },
    /** An editor's viewer shows what drawing its frames took (by 1), or stops (-1). */
    stats(by) { stats += by; },
    /** The size the viewer's frames are drawn at (of the film's frame). */
    size: () => size,
    /** The viewer's frames are drawn at the largest size an editor's viewer wants (its scale: of the film's frame, viewerSocket),
     *  a step of 1/8 from a quarter to whole: a phone's smaller viewer never makes the frames another editor shows softer. */
    sized() {
      const want = Math.max(0, ...[...viewers].map((v) => v.scale || 0));
      const z = Math.min(1, Math.max(0.25, Math.ceil(want * 8) / 8));
      if (want && z !== size) { size = z; each((p) => p.resized()); }
    },
    hold: (ms) => each((p) => p.hold(ms)),
    /** Frames drawn now while playing take the director's workers that render ahead out of the viewer's (preview.mjs lend). */
    lend: (ms) => each((p) => p.lend(ahead.n, ms)),
    invalidate: () => each((p) => p.invalidate()),
    filesChanged,
    /** Changes the watchers have not reported yet (they wait a moment for a write to finish), taken in now: an agent
     *  that edits the film and at once asks for its frames never gets frames from before the edit as current. */
    settle() { clearTimeout(watchTimer); diskChanged(); return filesChanged(); },
    // this machine's worker setting changed: the viewer's workers, and the director's while it plays, follow it
    rechoose() { each((p) => p.rechoose()); ahead.rechoose(); },
    prerenderChanged: () => each((p) => p.prerenderChanged()),
    director,
    /** Version n's files written over the project's (history.mjs restore), after a save in flight → the version that
     *  keeps it, or null where the project already was so. The editor hears of its timeline as of a change on disk. */
    restore(n) {
      const r = queue.then(() => {
        if (keepTimer) keep();
        return restore(DIR, n, 'Before restoring a version');
      });
      queue = r.catch(() => {});
      return r.then((v) => {
        kept(v);
        if (!fs.existsSync(FILE)) closeTimeline(name, tid, `${name}/${timelineIds(DIR)[0] ?? 'main'}`, 'deleted');   // (a version made before this timeline was)
        else this.settle();
        return v;
      });
    },
    /** The film's code, for the code panel: the files a version of it holds, its timelines aside (the editor's). */
    code: () => Object.keys(sources(DIR)).filter((r) => !r.startsWith('timelines/')),
    /** A file of the film's code as it is now (null: not one), and written over the text the panel last read (`base`)
     *  → { ok } or, where it has changed since, { conflict, text }. */
    readCode(rel) { if (!this.code().includes(rel)) return null; return fs.readFileSync(path.join(DIR, rel), 'utf8'); },
    writeCode(rel, text, base) {
      const now = this.readCode(rel);
      if (now == null) return { error: `${rel} is not a file of the film's code` };
      if (now !== base) return { conflict: true, text: now };
      if (keepTimer) keep();   // (a change on disk not kept yet, which this is written over: the director chose theirs)
      told.set(rel, text);
      fs.writeFileSync(path.join(DIR, rel), text);
      keepSoon(`edit ${rel}`);
      return { ok: true };
    },
    // the code panel's explorer: a file made, a file or folder renamed or taken away, each kept in the history as it
    // says (a folder's files all with it: one it holds that a version would not is never taken away unkept)
    // → { ok } or { error }
    makeCode(rel) {
      if (!holds(DIR, rel) || rel.startsWith('timelines/')) return { error: `${rel} cannot be a file of the film's code` };
      const f = path.join(DIR, rel);
      if (fs.existsSync(f)) return { error: `${rel} is there already` };
      for (let d = path.dirname(rel); d !== '.' && !fs.existsSync(path.join(DIR, d)); d = path.dirname(d)) told.set(d.split(path.sep).join('/'), null);   // (its folders, made with it)
      fs.mkdirSync(path.dirname(f), { recursive: true });
      told.set(rel, '');
      fs.writeFileSync(f, '');
      keepSoon(`new file ${rel}`);
      return { ok: true };
    },
    moveCode(from, to) {
      const under = this.under(from);
      if (!under) return { error: `${from} is not the film's code` };
      if (!holds(DIR, to) || to.startsWith('timelines/') || under.some((r) => !holds(DIR, to + r.slice(from.length)))) return { error: `${to} cannot be the film's code` };
      if (fs.existsSync(path.join(DIR, to))) return { error: `${to} is there already` };
      if (keepTimer) keep();
      for (const r of under) { told.set(r, null); told.set(to + r.slice(from.length), fs.readFileSync(path.join(DIR, r), 'utf8')); }
      if (!under.includes(from)) { told.set(from, null); told.set(to, null); }   // (a folder: no text of its own)
      for (let d = path.dirname(to); d !== '.' && !fs.existsSync(path.join(DIR, d)); d = path.dirname(d)) told.set(d.split(path.sep).join('/'), null);
      fs.mkdirSync(path.dirname(path.join(DIR, to)), { recursive: true });
      fs.renameSync(path.join(DIR, from), path.join(DIR, to));
      keepSoon(`rename ${from} → ${to}`);
      return { ok: true };
    },
    removeCode(rel) {
      const under = this.under(rel);
      if (!under) return { error: `${rel} is not the film's code` };
      if (keepTimer) keep();
      for (const r of [...under, rel]) told.set(r, null);
      fs.rmSync(path.join(DIR, rel), { recursive: true });
      keepSoon(`delete ${rel}`);
      return { ok: true };
    },
    /** A file of the film's code, or a folder holding only files of it → the files (paths), or null. */
    under(rel) {
      const p = path.join(DIR, rel);
      if (!holds(DIR, rel) || rel === 'timelines' || rel.startsWith('timelines/') || !fs.existsSync(p)) return null;
      const code = this.code();
      if (!fs.statSync(p).isDirectory()) return code.includes(rel) ? [rel] : null;
      const all = [];
      (function walk(d, r) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const x = `${r}/${e.name}`; if (e.isDirectory()) walk(path.join(d, e.name), x); else all.push(x); } })(p, rel);
      return all.length && all.every((r) => code.includes(r)) ? all : null;
    },
    // why: renamed (to `by`), deleted, or studio shutdown
    async close(by, why) {
      if (keepTimer) { try { keep(); } catch (e) { console.warn(`studio: ${name}'s history: ${e.message}`); } }
      send('closed', { by, why });
      for (const res of clients) res.end();
      clients.clear();   // (its workers, closed below, still say what they are doing: to no one now)
      timelineWatch.close(); clearTimeout(watchTimer); clearTimeout(othersTimer); stopWatching(); stopInstruments();
      clearTimeout(idleTimer); clearTimeout(extraTimer);
      for (const req of waiting.splice(0)) req.reject(new Error('This timeline was closed. Open a timeline to continue.'));
      await Promise.all([...Object.values(previews).map((p) => p.close()), ...slots.map((s) => s.w?.close())]);
    },
  };
}

// what a rekey says in the history: what followed the code, what was orphaned, what found its code again
function gridMessage(g) {
  const part = (p, i) => `${p.bpm} bpm, ${p.beatsPerBar} beats a bar${i ? ` from ${p.t} s (bar ${p.bar})` : ''}`;
  return `The tempo grid follows the music: ${(g.map ?? [g]).map(part).join('; ')}`;
}
function rekeyMessage(map, why) {
  const e = Object.entries(map), at = (k) => parseSite(k)?.loc ?? k;
  const orphaned = e.filter(([, to]) => to.startsWith('orphan:')), back = e.filter(([k]) => k.startsWith('orphan:')), moved = e.length - orphaned.length - back.length;
  if (!e.length) return 'Your changes remember the code they are on';
  const parts = [moved && `${moved} name${moved > 1 ? 's' : ''} followed ${why === 'open' ? 'the code as it now is' : 'the code as it moved'}`,
    orphaned.length && `${orphaned.length} orphaned (the code there changed: ${orphaned.map(([k]) => at(k)).join(', ')})`,
    back.length && `${back.length} found again (${back.map(([, to]) => at(to)).join(', ')})`].filter(Boolean);
  return `Your changes and the film's code: ${parts.join('; ')}\n\n${e.map(([k, to]) => `${k} → ${to}`).join('\n')}`;
}

// a directory tree, for changes that mean the film looks different (outputs, the history, a repo's own, dependencies and
// audio aside; the timeline is compared on its own)
// (sound/: a film's sound code, and engine/sound: what sound is made with; instruments/: its instruments' states, a
// plugin's saved as it is changed in its window — they change no frame)
const SKIP = new Set(['node_modules', '.git', 'history', 'renders', 'timelines', 'sound', 'instruments']), AUDIO = /\.(wav|mp3|m4a|aac|ogg|flac|aiff?)$/i;
// what the film's frames are made from, as a fingerprint: its files (as watchTree sees them: size and time of each),
// Ephemeris's, and the timeline — the same fingerprint, the same frames (the viewer keeps them across a restart)
// (each file by its path in its own place: the film's in the workspace, Ephemeris's in the studio, wherever that is)
function filesOf(d, out, base = WS) {
  try {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) filesOf(p, out, base);
      else if (!AUDIO.test(e.name)) { const s = fs.statSync(p); out.push(`${path.relative(base, p)}|${s.size}|${Math.round(s.mtimeMs)}`); }
    }
  } catch { /* gone */ }
  return out;
}
const studioFiles = () => [
  ...['engine', 'elements', 'assets'].flatMap((d) => filesOf(path.join(ROOT, d), [], ROOT)),
  ...['app/renderer.cjs', 'tools/browser.mjs'].map((f) => { const s = fs.statSync(path.join(ROOT, f)); return `${f}|${s.size}|${Math.round(s.mtimeMs)}`; }),
];
const newestOf = (dir, timelineFile) => Math.max(0, ...[...filesOf(dir, []), ...studioFiles()].map((l) => +l.split('|').pop()), fs.statSync(timelineFile).mtimeMs);
const fingerprint = (dir, timelineFile) => crypto.createHash('sha1').update([...filesOf(dir, []), ...studioFiles(), rendererVersion(), fs.readFileSync(timelineFile, 'utf8')].sort().join('\n')).digest('hex');
// (the same without the timeline: whether a file changed since the studio last looked)
const filesPrint = (dir) => crypto.createHash('sha1').update([...filesOf(dir, []), ...studioFiles(), rendererVersion()].sort().join('\n')).digest('hex');
// (Ephemeris's alone: what its own shaders are made from, beside each page's fingerprint of the film's: preview.mjs)
const studioPrint = () => crypto.createHash('sha1').update([...studioFiles(), rendererVersion()].sort().join('\n')).digest('hex');
// (onChange gets the paths changed since it was last called)
function watchTree(root, onChange) {
  const watching = new Map(), changed = new Set();
  let timer = null;
  const add = (d) => {
    if (watching.has(d)) return;
    try {
      watching.set(d, fs.watch(d, (_, f) => {
        if (!f || SKIP.has(String(f)) || AUDIO.test(f)) return;
        const p = path.join(d, String(f));
        try { if (fs.statSync(p).isDirectory()) add(p); } catch { /* removed */ }
        changed.add(p);
        clearTimeout(timer);
        timer = setTimeout(() => { const paths = [...changed]; changed.clear(); onChange(paths); }, 250);
      }));
      for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !SKIP.has(e.name)) add(path.join(d, e.name));
    } catch { /* gone, or not a directory */ }
  };
  add(root);
  return () => { clearTimeout(timer); for (const w of watching.values()) w.close(); };
}

// Runtime ownership is independent of navigation. Hidden timelines keep watchers and agent tools, while previews
// render only explicit requests or drafts. `current` is just the last editor opened, for unbound external clients.
let current = null;
const opened = new Map(), opening = new Map(), workspaceClients = new Set();
// whether the viewers fill the rest of each film around the playhead (the editor's Pre-render: preview.mjs), for every
// timeline until the studio restarts; off, the GPU is left to what is asked for (to measure the renderer, say)
let prerender = true;
// the director's answers about each timeline's film (answer), its file → { made: the stamp they are of, kinds: kind →
// question → answer }: those of the timelines opened latest, and of each kind the questions asked latest (an editor
// opening asks one or a few of each; the playhead's lights, asked again as it moves, take no room from its lanes)
const answers = new Map(), ANSWERED = { timelines: 8, each: 16 };
// (m's k set to v, the latest: past the limit, the one set longest ago goes)
const latest = (m, k, v, limit) => { m.delete(k); m.set(k, v); if (m.size > limit) m.delete(m.keys().next().value); };
// the viewer's caches across this machine's films, kept under its limit (tools/cache.mjs)
const caches = createCaches(() => ({ previews: [...opened.values()].flatMap((p) => Object.values(p.previews)), shown: new Set([...opened.values()].filter((p) => p.clients.size).map((p) => p.view())) }));
// the machine's CPU and GPUs (tools/machine.mjs) to the open timeline's editors, read while any editor is connected
let editors = 0, stopMachine = null;
function watching(by) {
  editors += by;
  // (what the studio takes is all under the app that started it, its window with it, or else under this process)
  const root = +process.env.EPHEMERIS_APP_PID === process.ppid ? process.ppid : process.pid;
  if (editors > 0 && !stopMachine) stopMachine = watchMachine((m) => { for (const p of opened.values()) p.send('machine', { ...m, cache: caches.info() }); }, { root, renderers: renderBrowsers });
  else if (editors <= 0 && stopMachine) { stopMachine(); stopMachine = null; }
}
const isOpen = (name, tid) => opened.has(`${name}/${tid}`);
async function acquire(name, tid) {
  const key = `${name}/${tid}`, dir = projectDir(name);
  if (!dir || !timelineIds(dir).includes(tid)) throw new Error(`No timeline "${tid}" in project "${name}". Choose one with the projects tool.`);
  if (opened.has(key)) return opened.get(key);
  if (!opening.has(key)) opening.set(key, openTimeline(name, tid).then((p) => {
    opened.set(key, p); caches.check(); workspaceChanged(); return p;
  }).finally(() => opening.delete(key)));
  return opening.get(key);
}
async function activate(name, tid) {
  current = await acquire(name, tid);
  const dir = current.dir;
  try { fs.mkdirSync(path.dirname(lastFile(dir)), { recursive: true }); fs.writeFileSync(lastFile(dir), JSON.stringify({ timeline: tid })); } catch { /* only a convenience */ }
  workspaceChanged();
  return current;
}
async function closeTimeline(name, tid, by, why) {
  const key = `${name}/${tid}`, p = opened.get(key);
  if (!p) return;
  opened.delete(key);
  if (current === p) current = null;
  workspaceChanged();
  await p.close(by, why);
}
function workspaceState() {
  return { engine: ENGINE, open: current ? `${current.name}/${current.tid}` : null,
    projects: [...new Set([...opened.values()].map((p) => p.name))].map((name) => ({ name, timeline: lastTimeline(path.join(PROJECTS, name)), agents: agents.list(name) })) };
}
function workspaceChanged() {
  const clients = [...workspaceClients, ...[...opened.values()].flatMap((p) => [...p.clients])];
  if (!clients.length) return;
  const data = JSON.stringify(workspaceState());
  for (const res of clients) res.write(`event: projects\ndata: ${data}\n\n`);
}
for (const d of ['engine', 'elements', 'assets']) watchTree(path.join(ROOT, d), (paths) => { for (const p of opened.values()) p.filesChanged(paths); });

// ---------- the projects, for the picker: what each is, how long, when last edited, a poster frame from its viewer
// a frame from a timeline's viewer, 40% in (a small JPEG of the one kept: /poster/<name>/<timeline>/<frame>.jpg)
function poster(dir, tid) {
  try {
    const frames = fs.readdirSync(path.join(previewsOf(dir, tid), 'preview')).map((f) => /^(\d+)\.png$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
    if (frames.length) return `/poster/${encodeURIComponent(path.basename(dir))}/${tid}/${frames[Math.floor(frames.length * 0.4)]}.jpg`;
  } catch { /* never previewed */ }
  return null;
}
// a project's timelines, for the editor's tabs
async function timelines(dir) {
  return Promise.all(timelineIds(dir).map(async (id) => {
    const rel = path.join('timelines', `${id}.json`);
    let tl = {}; try { tl = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { /* unreadable: listed anyway */ }
    const edited = fs.statSync(path.join(dir, rel)).mtime.toISOString();
    return { id, duration: duration(tl), fps: tl.fps ?? null, cues: tl.cues?.length ?? 0, edited, open: isOpen(path.basename(dir), id) };
  }));
}
// New (blank: the project's main settings, no clips or cues), Duplicate, Rename, Delete — each a version of the project
// (kept by the open timeline where it is this project's, so that its editors' History has it).
// `main` is the project's default (what `./ephemeris master <name>` renders): it is neither renamed nor deleted.
async function changeTimelines(dir, req, id) {
  const keep = (message) => { const p = [...opened.values()].find((p) => p.dir === dir); return p ? p.keep(message) : record(dir, message); };
  const name = path.basename(dir), file = (t) => path.join('timelines', `${t}.json`), has = (t) => timelineIds(dir).includes(t);
  const b = await jsonBody(req);
  const bad = (t) => (!TIMELINE_ID.test(t || '') ? 'a timeline name is lowercase letters, digits and dashes' : has(t) ? `there is already a timeline "${t}"` : null);
  if (req.method === 'POST') {
    const to = b.id, from = b.from;
    if (bad(to)) return [400, { error: bad(to) }];
    let text;
    if (from) { if (!has(from)) return [404, { error: `no timeline "${from}"` }]; text = fs.readFileSync(path.join(dir, file(from)), 'utf8'); }
    else {
      let m = {}; try { m = JSON.parse(fs.readFileSync(path.join(dir, file('main')), 'utf8')); } catch { /* no main */ }
      // (settings main does not set are left out, not written as undefined)
      text = format(JSON.parse(JSON.stringify({ version: VERSION, fps: m.fps ?? 60, shutter: m.shutter, size: m.size, url: m.url ?? '', gi: m.gi, shadows: m.shadows, reflections: m.reflections, rendering: m.rendering, grid: m.grid && !m.grid.auto ? m.grid : blank().grid, media: {}, tracks: [{ id: 'a1', name: 'Music', clips: [] }], cues: [] })));
    }
    fs.mkdirSync(path.join(dir, 'timelines'), { recursive: true });
    fs.writeFileSync(path.join(dir, file(to)), text);
    keep(from ? `duplicate timeline ${from} as ${to}` : `new timeline ${to}`);
    return [200, { id: to }];
  }
  if (!has(id)) return [404, { error: `no timeline "${id}"` }];
  if (id === 'main') return [400, { error: 'main is the project\'s default timeline: it keeps its name' }];
  const open = isOpen(name, id);
  if (req.method === 'PATCH') {
    const to = b.to;
    if (bad(to)) return [400, { error: bad(to) }];
    fs.renameSync(path.join(dir, file(id)), path.join(dir, file(to)));
    keep(`rename timeline ${id} → ${to}`);
    if (open) await closeTimeline(name, id, `${name}/${to}`, 'renamed');   // its editor reopens it under the new name (now there)
    try { fs.renameSync(path.join(dir, 'renders', id), path.join(dir, 'renders', to)); } catch { /* never previewed */ }
    return [200, { id: to }];
  }
  if (req.method === 'DELETE') {
    fs.rmSync(path.join(dir, file(id)));
    keep(`delete timeline ${id}`);
    if (open) await closeTimeline(name, id, `${name}/main`, 'deleted');
    fs.rmSync(path.join(dir, 'renders', id), { recursive: true, force: true });
    return [200, {}];
  }
  return [405, {}];
}
const duration = (tl) => Math.max(0, ...(tl.tracks ?? []).flatMap((t) => t.clips.map(clipEnd)), ...(tl.cues ?? []).map((q) => q.t + q.dur));
// the timeline drawn small, for a project with no frame to show: its cues and each track's clips, as [start, end]
const timelineMap = (tl) => ({ cues: (tl.cues ?? []).map((q) => [q.t, q.t + q.dur]), tracks: (tl.tracks ?? []).map((t) => t.clips.map((c) => [c.at, clipEnd(c)])) });
async function projects() {
  const names = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((e) => e.isDirectory() && NAME_OK.test(e.name) && !e.name.startsWith('.')).map((e) => e.name);
  const list = await Promise.all(names.map(async (name) => {
    const dir = path.join(PROJECTS, name);
    const main = path.join(dir, 'timelines', 'main.json');
    let tl = null; try { tl = JSON.parse(fs.readFileSync(main, 'utf8')); } catch { /* not opened yet */ }
    const edited = lastChanged(dir) ?? (tl ? fs.statSync(main).mtime.toISOString() : null);
    return { name, edited, poster: poster(dir, 'main'), open: [...opened.values()].some((p) => p.name === name) ? lastTimeline(dir) : null, agents: agents.list(name), timelines: timelineIds(dir).length,
      duration: tl ? duration(tl) : 0, fps: tl?.fps ?? null, cues: tl?.cues?.length ?? 0, map: tl ? timelineMap(tl) : null };
  }));
  return list.sort((a, b) => (b.edited ?? '').localeCompare(a.edited ?? ''));
}

// ---------- http
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff' };
function serveFile(req, res, file) {
  let st; try { st = fs.statSync(file); } catch { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
  if (!st.isFile()) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', size = st.size;
  // byte ranges, so the browser can seek the draft and step frames
  const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (r) {
    const a = r[1] ? +r[1] : Math.max(0, size - +r[2]), b = r[1] && r[2] ? Math.min(+r[2], size - 1) : size - 1;
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1, 'cache-control': 'no-store' });
    fs.createReadStream(file, { start: a, end: b }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }
}
const inside = (base, rel) => { const f = path.resolve(base, rel); return f === base || f.startsWith(base + path.sep) ? f : null; };
const body = (req) => new Promise((r) => { const b = []; req.on('data', (d) => b.push(d)); req.on('end', () => r(Buffer.concat(b))); });
// a JSON body, or {} when there is none (curl -X POST with no data)
const jsonBody = async (req) => { if (req.json) return req.json; const t = String(await body(req)).trim(); return (req.json = t ? JSON.parse(t) : {}); };
// (never kept by the browser: an answer holds only now — a stale status or error must not survive edits or restarts,
// leaving instruments without their samples or an agent
// without its conversations)
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };

// the director's view at t from a camera, a JPEG ({ data, w, h }) (draft: the editor's overrides as a drag would make
// them, for this view only; an agent's: Accurate's look, after the director's own, and the viewer's renders not held for it)
async function directorFrame(P, { t, camera, scale, ahead, draft, agent, profile, memory }) {
  if (!agent) P.hold(1500); else await P.settle();
  return P.director((w) => w.director(+t || 0, camera, Math.min(1, Math.max(0.25, +scale || 1)), !!ahead, Array.isArray(draft) ? draft : undefined, agent ? 'accurate' : P.look(), agent ? 0.85 : 0.8, !!profile, !!memory), +t || 0, !!ahead, !!agent);
}
// a frame of the film the viewer's cache does not have current, drawn now, a JPEG: as the editor has the timeline (draft:
// its overrides, edited and not yet saved); as the cache draws it (motion blur, full size), or quickly (blur: false,
// scale: smaller: while something is dragged). The cache's renders wait for it (and not when it fails); playing (ahead:
// a frame ahead of the playhead) it goes to the workers that render those, the cache's rendering going on with as many
// fewer workers as they are (at least one: it is what Preview waits for)
// (progress: shown while it is drawn, the frame so far given to it now and then: worker.mjs frame)
async function liveFrame(P, { t, draft, scale, blur, ahead, profile, memory }, progress = null) {
  const { fps, shutter, samples } = P.settings();
  if (!ahead) P.hold(1500); else P.lend(1000);
  const o = blur ? { sub: samples, shutter: shutter / 360, fps } : { sub: 1, shutter: 0, fps };
  try { return await P.director((w) => w.frame(+t || 0, { ...o, jpeg: blur ? 0.9 : 0.8, scale: Math.min(1, Math.max(0.25, +scale || 1)), draft: Array.isArray(draft) ? draft : undefined, look: P.look(), profile: !!profile, progress: blur ? progress : null, memory: !!memory }), +t || 0, !!ahead); }
  catch (e) { P.hold(0); throw e; }
}
// a paused frame drawn on past its samples, n of them in all (the viewer converging on it), for a moment more: the frame
// so far as a JPEG ({ data, w, h, done, sub }); the same key goes on where the last left off (worker.mjs converge). The
// viewer's renders go on meanwhile, and the director's other questions are answered between its moments
// (camera: the director's view's, at rest)
function convergeFrame(P, { key, t, n, draft, scale, camera, memory }) {
  const { fps, shutter } = P.settings();
  return P.director((w) => w.converge(String(key), +t || 0, Math.min(1024, Math.max(1, Math.round(+n) || 256)), { shutter: shutter / 360, fps, scale: Math.min(1, Math.max(0.25, +scale || 1)), draft: Array.isArray(draft) ? draft : undefined, look: P.look(), camera: camera ?? null, memory: !!memory }), +t || 0, false, false, 'idle');
}
// The editor's viewer: its frames over a socket of its own (no request a frame, no announcement to wait for). It says
// where its playhead is and which frames it shows ({ type: 'at', f, playing, every, from, to }): those the cache stores
// meanwhile come at once; it asks for others ({ type: 'get', f }), and for frames drawn now ({ type: 'live' | 'director',
// id, …: as liveFrame and directorFrame; progress: a live frame's so far, each { kind: 'live', id, partial, done, sub, w,
// h } before its JPEG, before the frame whole; { type: 'converge', id, key, t, n, …: as convergeFrame }, its frame so far
// { kind: 'converge', id, done, sub, w, h }), and says whether it shows what drawing them took ({ type: 'stats', on }: each
// header then has its profile, where it was kept). Each comes as one message: its header's length (u32 LE), the header
// (JSON: { kind: 'frame', f, look, gen, state, size, profile } before a kept frame's PNG; { kind: 'live' | 'director',
// id, w, h, profile } before a JPEG: each decoded by the browser off the editor's main thread); as JSON text, a frame
// the cache does not have ({ kind: 'none', f }) and a request that failed ({ kind: 'error', id, error }). The cache's
// frames go one at a time behind the frames drawn now, so a gesture's never waits behind them.
// How the cache's frames come is the viewer's to say ({ type: 'view', delivery, w, h, scale }), answered with what it
// gets ({ kind: 'view', delivery }): 'lossless', each as it is kept (a PNG); 'compressed', a JPEG that fits w x h, about a
// tenth of the bytes (frames.mjs compress: { type: 'image/jpeg' } in its header), for a viewer on another device over a
// network; 'auto', lossless on the studio's own machine (near) and compressed on any other. scale: the size it wants its
// frames drawn at (of the film's frame): they are drawn at the largest any viewer wants (P.sized). The frames drawn now
// come as JPEGs either way, unless the viewer is the studio's own window on this machine and says it reads memory
// (memory: true, near): then its header has where the frame is ({ file }: app/framefile.cjs), with no bytes after it. The
// answer says whether the viewer is on the studio's machine (near).
// What its connection can carry, the viewer measures (nle/app.js NET): { type: 'ping', id } is answered at once
// ({ kind: 'pong', id }); a cache frame sent straight after the one before, without the socket waiting for it, says so
// (waited: true in its header): the time between the two arriving is the network's. (A compressed frame is made as it is
// queued, not when its turn comes, so the frames ahead are ready when the socket is.)
function viewerSocket(ws, P, near) {
  let win = null, sending = false, compressed = false, fit = [0, 0];
  const queue = new Map();   // (f → a cache frame's header, its PNG and its JPEG being made, the newest of each)
  const message = (head, bytes) => {
    const h = Buffer.from(JSON.stringify(head)), n = Buffer.alloc(4);
    n.writeUInt32LE(h.length);
    return Buffer.concat([n, h, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
  };
  // (a frame drawn now: its bytes, or where they are)
  const drawn = (head, fr) => message({ ...head, ...(fr.file && { file: fr.file }) }, fr.data ?? Buffer.alloc(0));
  // (after: called as the last frame went, so a frame queued meanwhile waited for the socket)
  const next = async (after = false) => {
    if (sending || !queue.size || ws.readyState !== ws.OPEN) return;
    const [f, e] = queue.entries().next().value;
    queue.delete(f); sending = true;
    const waited = after && (!e.jpg || e.made);
    const jpg = e.jpg && (await e.jpg);   // (failed: sent as it is)
    if (ws.readyState !== ws.OPEN) { sending = false; return; }
    ws.send(message({ ...e.head, ...(jpg && { type: 'image/jpeg' }), ...(waited && { waited }) }, jpg ?? e.png), () => { sending = false; next(true); });
  };
  const frame = (head, png) => {
    const e = { head, png, jpg: null, made: false };
    if (compressed && fit[0] > 0) e.jpg = compress(png, fit[0], fit[1]).catch(() => null).finally(() => { e.made = true; });
    queue.delete(head.f); queue.set(head.f, e); next();
  };
  const v = { stats: false, stored(look, fr) { if (win && look === P.look() && fr.f >= win.from && fr.f <= win.to) frame({ kind: 'frame', f: fr.f, look, gen: fr.gen, state: fr.state, size: Math.round(fr.z * 8), ...(v.stats && fr.profile && { profile: fr.profile }) }, fr.png); } };
  P.viewers.add(v);
  ws.on('close', () => { P.viewers.delete(v); queue.clear(); if (v.stats) P.stats(-1); P.sized(); if (v.fills) Object.values(P.previews).forEach((p) => p.drawnChanged()); });
  ws.on('message', async (m, binary) => {
    let q = null;
    try {
      // (a frame an editor's own film drew, for the cache: [u32 header length][header: f, w, h, z, gen, key, look][RGBA rows])
      if (binary) {
        const n = m.readUInt32LE(0), h = JSON.parse(m.subarray(4, 4 + n).toString());
        if (h.type === 'put') P.previews[h.look]?.put(h.f, { data: m.subarray(4 + n), w: h.w, h: h.h }, h.z, h.gen, h.key);
        return;
      }
      q = JSON.parse(m);
      if (q.type === 'at') { win = { from: +q.from, to: +q.to }; P.playhead(q.f, q.playing, q.every); }
      else if (q.type === 'view') {
        compressed = q.delivery === 'compressed' || (q.delivery !== 'lossless' && !near);
        fit = [Math.round(+q.w) || 0, Math.round(+q.h) || 0];
        if (+q.scale) { v.scale = +q.scale; P.sized(); }
        v.memory = near && !!q.memory;
        // (an editor's own film, drawing the viewer's frames itself: engine/preview.js; or the editor, whose film will once it
        // is loaded, so that no worker loads the film to draw them meanwhile: nle/app.js sendView)
        if (!!q.fills !== !!v.fills) { v.fills = !!q.fills; Object.values(P.previews).forEach((p) => p.drawnChanged()); }
        ws.send(JSON.stringify({ kind: 'view', delivery: compressed ? 'compressed' : 'lossless', near }));
      }
      else if (q.type === 'ping') ws.send(JSON.stringify({ kind: 'pong', id: q.id }));
      // (an editor's own film, the director at work in it: the workers that fill the cache wait, as for a frame it asked)
      else if (q.type === 'hold') P.hold(Math.max(0, Math.min(5000, +q.ms || 0)));
      else if (q.type === 'stats') { if (!!q.on !== v.stats) { v.stats = !!q.on; P.stats(v.stats ? 1 : -1); } }
      else if (q.type === 'get') {
        const pv = P.view(), f = Math.round(+q.f), png = await pv.file(f), { profile, ...info } = pv.info(f);
        if (png) frame({ kind: 'frame', f, look: P.look(), ...info, ...(v.stats && profile && { profile }) }, png);
        else if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: 'none', f }));
      } else if (q.type === 'live' || q.type === 'director') {
        const part = (p) => { if (ws.readyState === ws.OPEN) ws.send(drawn({ kind: 'live', id: q.id, partial: true, done: p.done, sub: p.sub, w: p.w, h: p.h }, p)); };
        const fr = await (q.type === 'live' ? liveFrame : directorFrame)(P, { ...q, profile: v.stats, memory: v.memory }, q.progress ? part : null);
        if (ws.readyState === ws.OPEN) ws.send(drawn({ kind: q.type, id: q.id, w: fr.w, h: fr.h, ...(fr.profile && { profile: fr.profile }) }, fr));
      } else if (q.type === 'converge') {
        const fr = await convergeFrame(P, { ...q, memory: v.memory });
        if (ws.readyState === ws.OPEN) ws.send(drawn({ kind: 'converge', id: q.id, done: fr.done, sub: fr.sub, w: fr.w, h: fr.h }, fr));
      }
    } catch (e) { if (q?.id != null && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: 'error', id: q.id, error: String(e.message || e) })); }
  });
}

/** A request for the open project P: p is the path below /p/<name>. */
// What an agent asks about the film (its MCP tool calls: what is under a point, where a thing is, its lanes, the camera's
// path…), asked of an editor's own film where one shows the timeline and has it up (engine/runtime.js, nle/viewport.js),
// as the editor's own questions are: no render worker started for them, and answered as the film is in front of the
// director; else by the studio's own, a worker's page. (The editor's own questions come here only where its film cannot
// answer them: never asked back of it.)
const ASKED_OF_FILM = new Set(['/api/pick', '/api/locate', '/api/objects', '/api/stacks', '/api/lanes', '/api/samples', '/api/lights', '/api/passes', '/api/track', '/api/director/path', '/api/overlays', '/api/director']);
const films = new Map();   // (an editor's link → { key: 'name/timeline', ready }: the film it has up)
async function askedOfFilm(key, url, b) {
  for (const [link, f] of films) {
    if (f.key !== key || !f.ready) continue;
    const a = await link.ask(url, b).catch(() => null);
    if (a?.status === 200) return a;
  }
  return null;
}

async function projectRoute(P, p, req, res, u, key) {
  if (ASKED_OF_FILM.has(p) && req.method === 'POST' && !req.viaLink && films.size) {
    const a = await askedOfFilm(key, p.slice(1), await jsonBody(req));
    if (a) { res.writeHead(200, { 'content-type': a.headers['content-type'] ?? 'application/json', 'cache-control': 'no-store', 'x-answered-by': 'editor' }); return res.end(a.body); }
  }
  // (a frame of the look asked for, the viewer's or Accurate's for agents, as a JPEG made from the one kept)
  if (p.startsWith('/preview/')) {
    const m = /^\/preview\/(\d+)\.jpg$/.exec(p), jpg = m && (await (P.previews[u.searchParams.get('look')] ?? P.view()).jpeg(+m[1]).catch(() => null));
    if (!jpg) return json(res, 404, {});
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
    return res.end(jpg);
  }
  if (p === '/api/look' && req.method === 'POST') { const { look } = await jsonBody(req); P.setLook(look); return json(res, 200, { look: P.look() }); }
  if (p === '/api/state') { await P.settle(); return json(res, 200, P.state()); }
  if (p === '/api/preview/want' && req.method === 'POST') { const { frames } = await jsonBody(req); P.preview.want(Array.isArray(frames) ? frames : []); return json(res, 200, {}); }
  if (p === '/api/timeline' && req.method === 'PUT') { const r = await P.save(await jsonBody(req)); return json(res, r.status, r.body); }
  // the project's history: its versions, a file as one holds it, the change from one to another (to the latest where
  // `to` is left out; `from` 0: from nothing; `path`: that file's alone) as a unified diff, and restoring one
  if (p === '/api/history') return json(res, 200, P.history());
  // (a version asked for by its number or a tag: history.mjs resolve)
  const ref = (x) => resolve(P.dir, x) ?? x;
  if (p === '/api/version' && req.method === 'GET') {
    const v = versionAt(P.dir, ref(u.searchParams.get('n')));
    return v ? json(res, 200, { text: textAt(P.dir, v, u.searchParams.get('path') ?? '') }) : json(res, 404, { error: `no version ${u.searchParams.get('n')}` });
  }
  if (p === '/api/diff' && req.method === 'GET') {
    const all = versions(P.dir), at = (n) => all.find((v) => v.n === +ref(n)), to = u.searchParams.has('to') ? at(u.searchParams.get('to')) : all.at(-1);
    const from = +u.searchParams.get('from') === 0 ? null : at(u.searchParams.get('from'));
    if (!to || from === undefined) return json(res, 404, { error: 'no such version' });
    return json(res, 200, { from: from?.n ?? 0, to: to.n, ...changes(from, to), diff: diffOf(P.dir, from, to, u.searchParams.get('path')) });
  }
  if (p === '/api/restore' && req.method === 'POST') {
    try { const v = await P.restore(ref((await jsonBody(req)).n)); return json(res, 200, { version: v?.n ?? null }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  // a version tagged (n: its number or a tag; the latest where left out; force: a name on another version moves), or a
  // tag taken away (remove) → the tags; the editor's History shows them again
  if (p === '/api/tags' && req.method === 'POST') {
    const { name, n, remove, force } = await jsonBody(req);
    try { if (remove) untag(P.dir, name); else tag(P.dir, name, n == null ? undefined : ref(n), !!force); } catch (e) { return json(res, 400, { error: e.message }); }
    P.send('history', { version: null });
    return json(res, 200, tags(P.dir));
  }
  // the film's code, in the code panel: its files, one read, one written over what the panel read (409: changed since)
  if (p === '/api/code' && req.method === 'GET') return json(res, 200, P.code());
  if (p === '/api/code/file' && req.method === 'GET') { const t = P.readCode(u.searchParams.get('path') ?? ''); return t == null ? json(res, 404, {}) : json(res, 200, { text: t }); }
  if (p === '/api/code/file' && req.method === 'PUT') {
    const { path: rel, text, base } = await jsonBody(req), r = P.writeCode(String(rel ?? ''), String(text ?? ''), base);
    return json(res, r.conflict ? 409 : r.error ? 400 : 200, r);
  }
  // (the explorer's: a file made, a file or folder renamed, one taken away)
  if (p === '/api/code/file' && req.method === 'POST') { const r = P.makeCode(String((await jsonBody(req)).path ?? '')); return json(res, r.error ? 400 : 200, r); }
  if (p === '/api/code/file' && req.method === 'PATCH') { const b = await jsonBody(req), r = P.moveCode(String(b.path ?? ''), String(b.to ?? '')); return json(res, r.error ? 400 : 200, r); }
  if (p === '/api/code/file' && req.method === 'DELETE') { const r = P.removeCode(u.searchParams.get('path') ?? ''); return json(res, r.error ? 400 : 200, r); }
  if (p === '/api/render' && req.method === 'POST') { const { from, to } = await jsonBody(req); P.preview.exportDraft(from, to); return json(res, 200, P.preview.render); }
  if (p === '/api/render/cancel' && req.method === 'POST') { P.preview.cancelExport(); return json(res, 200, {}); }
  // the director's view at t from a camera, as a JPEG (for agents: the editor's comes over its socket), and the film
  // camera's path (times in, a pose for each out)
  if (p === '/api/director' && req.method === 'POST') {
    const { data } = await directorFrame(P, await jsonBody(req));
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
    return res.end(data);
  }
  // picking: what is under a frame point at t (from the director's camera, or the film's), and that thing again later
  if (p === '/api/pick' && req.method === 'POST') { const { t, camera, x, y, agent } = await jsonBody(req); return json(res, 200, await P.director((w) => w.pick(+t || 0, camera ?? null, +x, +y), null, false, !!agent)); }
  // (sites: an object, whole — the copy named by at, nth and the rest, or its first, with every copy of it)
  if (p === '/api/locate' && req.method === 'POST') { const { t, camera, at, nth, key, like, copy, sites, draft, agent } = await jsonBody(req); return json(res, 200, await P.director((w) => w.locate(+t || 0, camera ?? null, at ?? null, +nth || 0, { key: key ?? null, like: like ?? null, copy: +copy || 0, ...(Array.isArray(sites) && sites.length && { sites }) }, Array.isArray(draft) ? draft : undefined), null, false, !!agent)); }
  // the film's objects (what the code defines, with every line that places it), where each is in the scene
  // (each a question about the film as it is, its answer kept for it: P.answer)
  if (p === '/api/objects' && req.method === 'POST') { const { duration, fps, cuts, agent } = await jsonBody(req), o = { duration: Math.max(0, +duration || 0), fps: Math.min(24, Math.max(1, +fps || 12)), cuts: (cuts ?? []).map(Number).filter(Number.isFinite) }; return json(res, 200, await P.answer('objects', o, (w) => w.objects(o), !!agent)); }
  // the editor's lanes: what a thing's (or the camera's) properties come from, and the code's values over time
  if (p === '/api/stacks' && req.method === 'POST') { const { t, sel, agent } = await jsonBody(req), q = [+t || 0, sel ?? { camera: true }]; return json(res, 200, await P.answer('stacks', q, (w) => w.stacks(...q), !!agent)); }
  // (sels: several at once, an answer each, those not answered yet found together)
  if (p === '/api/lanes' && req.method === 'POST') {
    const { sel, sels, duration, fps, cuts, values, at, draft, agent } = await jsonBody(req), edits = Array.isArray(draft) ? draft : undefined, o = { duration: Math.max(0, +duration || 0), fps: Math.min(240, Math.max(1, +fps || 60)), cuts: (cuts ?? []).map(Number).filter(Number.isFinite), ...(values && { values: true }), ...(Number.isFinite(at) && { at }) };
    const got = await Promise.all(P.answerAll('lanes', (Array.isArray(sels) ? sels : [sel ?? { camera: true }]).map((s) => [s, o, edits ?? null]), (qs) => (w) => w.lanes(qs.map(([s]) => s), o, edits), !!agent, Number.isFinite(at) ? 'now' : 'slow'));
    return json(res, 200, Array.isArray(sels) ? got : got[0]);
  }
  if (p === '/api/samples' && req.method === 'POST') { const { sel, ks, times, agent } = await jsonBody(req), q = [sel ?? { camera: true }, (ks ?? []).slice(0, 32), (times ?? []).slice(0, 4000)]; return json(res, 200, await P.answer('samples', q, (w) => w.samples(...q), !!agent)); }
  // what drawing the frame at t takes (engine/render/profile.js), drawn now: as the viewer draws its frames (its samples,
  // its size), or as a master is (master: the timeline's master samples, whole), as the editor has the film (draft); the
  // viewer's renders wait while it is drawn, so they take no share of the GPU
  if (p === '/api/profile' && req.method === 'POST') {
    const { t, draft, master, agent } = await jsonBody(req), { fps, shutter, samples, master: mastered } = P.settings();
    if (agent) await P.settle();
    const o = master ? { sub: mastered, scale: 1 } : { sub: samples, scale: P.size() };
    // (drawn by an editor's own film where one has the film up, once the director leaves its view still: the editor's own
    // Profile this frame too, its film never having been asked it; else by a render worker, the cache's work held for it)
    if (films.size) {
      const a = await askedOfFilm(key, 'api/profile', { t: +t || 0, sub: o.sub, scale: o.scale, shutter: shutter / 360, fps, draft: Array.isArray(draft) ? draft : null });
      if (a) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-answered-by': 'editor' }); return res.end(a.body); }
    }
    P.hold(600_000);
    try {
      const fr = await P.director((w) => w.frame(+t || 0, { ...o, shutter: shutter / 360, fps, look: agent || master ? 'accurate' : P.look(), draft: Array.isArray(draft) ? draft : undefined, profile: true }), +t || 0, false, !!agent);
      return json(res, 200, { t: +t || 0, samples: o.sub, size: [fr.w, fr.h], ...fr.profile });
    } finally { P.hold(0); }
  }
  // what the editor draws over its picture of each of a few frames (times): the film's camera there, the scene's lights,
  // the selection (sel: as locate names it), as the editor has the film (draft); camera: the director's, its view's
  if (p === '/api/overlays' && req.method === 'POST') { const { times, sel, draft, camera, also } = await jsonBody(req); return json(res, 200, await P.director((w) => w.overlays((times ?? []).slice(0, 48).map(Number), sel ?? null, Array.isArray(draft) ? draft : undefined, camera ?? null, Array.isArray(also) ? also.slice(0, 32) : []))); }
  // the scene's own lights at t, where the viewer marks them (from the director's camera, or the film's)
  // how the film moves on screen over a span: the camera's speed and reversals, and where things are on the frame
  if (p === '/api/track' && req.method === 'POST') { const { from, to, fps, things, agent } = await jsonBody(req); return json(res, 200, await P.director((w) => w.track(+from || 0, +to || 0, Math.min(120, Math.max(1, +fps || 60)), Array.isArray(things) ? things.slice(0, 8) : []), null, false, !!agent)); }
  if (p === '/api/lights' && req.method === 'POST') { const { t, camera, agent } = await jsonBody(req), q = [+t || 0, camera ?? null]; return json(res, 200, await P.answer('lights', q, (w) => w.lights(...q), !!agent)); }
  if (p === '/api/passes' && req.method === 'POST') { const { t, agent } = await jsonBody(req), q = +t || 0; return json(res, 200, await P.answer('passes', q, (w) => w.passes(q), !!agent)); }
  // (a path with the editor's edits not saved yet, a gizmo's while it is dragged: asked of those alone, not kept)
  if (p === '/api/director/path' && req.method === 'POST') {
    const { times, draft, agent } = await jsonBody(req), q = (times ?? []).slice(0, 4000);
    if (agent) await P.settle();
    return json(res, 200, await (Array.isArray(draft) ? P.director((w) => w.cameraPath(q, draft), null, false, !!agent) : P.answer('path', q, (w) => w.cameraPath(q), !!agent)));
  }
  if (p === '/api/music' && req.method === 'GET') return json(res, 200, P.music());
  // a notes clip's sampler instrument, resolved: { sampler: instrument, base: where its samples are named from
  // (project-relative, or library/…) } (its samples are fetched from api/library/file, below)
  if (p === '/api/instrument' && req.method === 'POST') {
    try {
      const r = await resolveInstrument(P.dir, (await jsonBody(req)).instrument), lib = soundLibrary();
      const under = lib && !path.relative(lib, r.root).startsWith('..');
      return json(res, 200, { sampler: r.sampler, base: (under ? `library/${path.relative(lib, r.root)}` : path.relative(P.dir, r.root)).split(path.sep).join('/') });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  // a song of the project's heard now (an agent asking about one not on the timeline): its analysis, made if missing
  // (media: its path in the project, assets/…; a name alone is one in media/, as a project from before assets/ named it)
  if (p === '/api/music' && req.method === 'POST') {
    const { media } = await jsonBody(req), m = String(media ?? ''), rel = MEDIA_DIRS.some((d) => m.startsWith(`${d}/`)) ? m : `media/${m}`, f = inside(P.dir, rel);
    if (!f || !fs.existsSync(f)) return json(res, 404, { error: `no file ${rel}` });
    return json(res, 200, await ensureMusic(P.dir, path.relative(P.dir, f).split(path.sep).join('/')));
  }
  // a sampler instrument edited in the Instrument panel, kept as a file of the project's named by what it holds
  // (instruments/<name>-<hash>.json; its samples named from instruments/, or library/…); the timeline's
  // notes media are then pointed at it (an edit of theirs: undo goes back to the file before)
  if (p === '/api/instrument/save' && req.method === 'POST') {
    const { name, data } = await jsonBody(req);
    if (!Array.isArray(data?.regions)) return json(res, 400, { error: 'a sampler instrument needs regions' });
    const text = `${JSON.stringify(data, null, 1)}\n`, hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
    const slug = String(name || 'sampler').toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'sampler';
    const rel = `instruments/${slug}-${hash}.json`, f = path.join(P.dir, rel);
    if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
    return json(res, 200, { path: rel });
  }
  // the Instrument panel's: the library's instruments, one as the sampler's data, and a sample's file (the library's, or the project's)
  if (p === '/api/instruments' && req.method === 'GET') return json(res, 200, await listInstruments());
  // the Instrument panel's plugins: those this machine has, and the Vital presets folder's presets (vital/…)
  // the plugins this machine has, and each one's presets ({ state, name }: tools/devices.mjs pluginPresets)
  if (p === '/api/plugins' && req.method === 'GET') {
    const plugins = findPlugins().map((x) => x.name);
    return json(res, 200, { plugins, presets: Object.fromEntries(plugins.map((n) => [n, pluginPresets(P.dir, n).map((x) => ({ name: x.name, folder: x.folder, ...(x.state ? { state: x.state } : { take: x.take }) }))])) });
  }
  // the settings' preset folders (tools/presets.mjs): listed, with how many presets each holds; one added or taken away
  if (p === '/api/settings/presets') {
    if (req.method === 'POST') { try { setFolders(await jsonBody(req)); } catch (e) { return json(res, 400, { error: e.message }); } syncVial(P.dir); }
    const plugins = findPlugins().map((x) => x.name), count = new Map();
    for (const n of plugins) for (const x of pluginPresets(P.dir, n)) count.set(x.folder, (count.get(x.folder) ?? 0) + 1);
    return json(res, 200, { folders: presetFolders(P.dir).map((f) => ({ ...f, presets: count.get(f.label) ?? 0 })) });
  }
  // a preset of a folder of this machine's, copied into the project's instruments/ as it is chosen
  if (p === '/api/presets/take' && req.method === 'POST') {
    try { return json(res, 200, { state: takePreset(P.dir, await jsonBody(req)) }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/instrument' && req.method === 'GET') {
    try { return json(res, 200, await instrumentData(P.dir, u.searchParams.get('kind'), u.searchParams.get('path'), u.searchParams.get('octave'))); } catch (e) { return json(res, 404, { error: e.message }); }
  }
  if (p === '/api/library/file' && req.method === 'GET') { const f = sampleFile(P.dir, u.searchParams.get('path')); return f ? serveFile(req, res, f) : json(res, 404, {}); }
  // the project's media (its sounds, pictures and videos in assets/, and media/ in a project from before), what each is; a
  // video's frames decoded where missing
  if (p === '/api/media' && req.method === 'GET') {
    const all = await mediaList(P.dir);
    for (const m of all) if (m.kind === 'video' && m.w) ensureFrames(P.dir, m).then((made) => made && P.invalidate());
    return json(res, 200, all);
  }
  // a file dropped or brought in is copied into the project's assets/ (or the folder of it, or of media/, the panel shows:
  // dir, its path in the project): a project holds everything it is made of
  if (p === '/api/media' && req.method === 'POST') {
    const data = await body(req), name = path.basename(u.searchParams.get('name') || 'audio').replace(/[^\w.\- ]+/g, '_');
    const want = String(u.searchParams.get('dir') ?? ''), dir = (MEDIA_DIRS.some((d) => want === d || want.startsWith(`${d}/`)) && !want.split('/').some((x) => x.startsWith('.') || x === '..') && inside(P.dir, want)) || path.join(P.dir, 'assets');
    fs.mkdirSync(dir, { recursive: true });
    let f = name, k = 1;
    while (fs.existsSync(path.join(dir, f)) && !fs.readFileSync(path.join(dir, f)).equals(data)) f = name.replace(/(\.[^.]*)?$/, ` ${++k}$1`);
    fs.writeFileSync(path.join(dir, f), data);
    // (what it is: a video's frames decoded meanwhile, the film rendered again once they are there)
    const info = await mediaProbe(P.dir, path.relative(P.dir, path.join(dir, f)).split(path.sep).join('/'));
    if (info.kind === 'video' && info.w) ensureFrames(P.dir, info).then((made) => made && P.invalidate());
    return json(res, 200, info);
  }
  // the project's files, a folder at a time (the explorers': tools/files.mjs), and a text file of it read wherever it is
  if (p === '/api/files' && req.method === 'GET') {
    const r = folder(P.dir, u.searchParams.get('dir') ?? '');
    if (!r) return json(res, 404, {});
    // (probe: each sound, picture and video with what it is, as the timeline places it: tools/media.mjs)
    if (u.searchParams.get('probe')) {
      const media = r.entries.filter((e) => !e.dir && kindOf(e.name)), infos = await probeAll(P.dir, media.map((e) => e.path));
      media.forEach((e, i) => { if (infos[i]) e.info = infos[i]; });
    }
    return json(res, 200, r);
  }
  if (p === '/api/files/text' && req.method === 'GET') { const t = readText(P.dir, u.searchParams.get('path') ?? ''); return t == null ? json(res, 404, {}) : json(res, 200, { text: t }); }
  // Each editor selects its conversation explicitly; another tab or device cannot move its selection.
  if (p === '/api/settings/agent' || p.startsWith('/api/agent')) {
    try {
      const id = u.searchParams.get('agent');
      if (p === '/api/agent/new' && req.method === 'POST') return json(res, 200, agents.add(P.name, P.tid).state());
      if (p === '/api/agent/resume' && req.method === 'POST') return json(res, 200, (await agents.resume(P.name, P.tid, await jsonBody(req))).state());
      if (p === '/api/agent/close' && req.method === 'POST') { await agents.close(P.name, id); return json(res, 200, { ok: true }); }
      if (p === '/api/agent/rename' && req.method === 'POST') return json(res, 200, await agents.rename(P.name, await jsonBody(req)));
      if (p === '/api/agent/delete' && req.method === 'POST') { await agents.remove(P.name, await jsonBody(req)); return json(res, 200, { ok: true }); }
      const a = agents.get(P.name, id, P.tid);
      if (p === '/api/settings/agent') { if (req.method === 'POST') { agents.refreshModels(); return json(res, 200, await a.configure(await jsonBody(req))); } return json(res, 200, await a.settings()); }
      if (p === '/api/agent') return json(res, 200, { ...a.state(), agents: agents.list(P.name) });
      if (p === '/api/agent/models') return json(res, 200, await agents.models(a));
      const reads = { '/api/agent/conversations': 'conversations' };
      const writes = { '/api/agent/send': 'send', '/api/agent/answer': 'answer', '/api/agent/stop': 'stop', '/api/agent/model': 'setModel', '/api/agent/effort': 'setEffort', '/api/agent/permissions': 'setPermissions' };
      if (reads[p]) return json(res, 200, await a[reads[p]]());
      if (writes[p] && req.method === 'POST') {
        const b = await jsonBody(req);
        if (p === '/api/agent/send') b.context = { ...b.context, timeline: P.tid };
        return json(res, 200, await a[writes[p]](b));
      }
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  // an agent pointing something out to the director (the MCP show tool): the editors go there
  if (p === '/api/show' && req.method === 'POST') { const b = await jsonBody(req); P.send('show', b); return json(res, 200, { ok: true, editors: P.clients.size }); }
  // the timeline's sound as one file (an editor's that does not play it itself): whether it is made, and the file
  if (p === '/api/mix') return json(res, 200, P.mix());
  if (p.startsWith('/api/mix/')) { const f = P.mixFile(/^\/api\/mix\/(\w+)\.m4a$/.exec(p)?.[1]); return f && fs.existsSync(f) ? serveFile(req, res, f) : json(res, 404, {}); }
  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': hi\n\n'); P.clients.add(res); P.shown(); watching(1); req.on('close', () => { P.clients.delete(res); P.shown(); watching(-1); });
    return;
  }
  json(res, 404, {});
}

// Agents outlive editor navigation; their context and events never consult `current`.
const agents = createAgents({
  root: WS, studio: `http://localhost:${PORT}`,
  open: async (name, tid) => {
    const p = await acquire(name, tid);
    return { name, tid, url: p.state().url, frameJpeg: (f) => p.view().jpeg(f, 0.88) };
  },
  emit: (name, type, data) => {
    for (const p of opened.values()) if (p.name === name) p.send(type, data);
    if (type === 'agents') workspaceChanged();
  },
});

// Other devices (a phone, another computer, over the network) open the studio with this machine's password
// (remotePassword in its config: Settings), asked by the browser's own prompt and kept by it; the machine the studio runs
// on is never asked. With no password set, other devices are not let in. (A request a proxy on this machine forwards — an
// HTTPS front such as `tailscale serve` — comes from another device: asked too.)
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const local = (req) => LOCAL.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers.forwarded;
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
function allowed(req) {
  if (local(req)) return true;
  const pw = config().remotePassword, m = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!pw || !m) return false;
  const given = Buffer.from(m[1], 'base64').toString('utf8').replace(/^[^:]*:/, '');   // (the user name is not asked for)
  return crypto.timingSafeEqual(digest(given), digest(pw));
}
function refuse(res) {
  res.writeHead(401, { 'www-authenticate': 'Basic realm="Ephemeris", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(config().remotePassword ? 'Ephemeris needs its password to open from another device.' : 'Ephemeris has no password for other devices yet: set one in Settings on the machine it runs on.');
}
// where other devices reach it: this machine's name and its addresses on the networks it is on
function addresses() {
  const ips = Object.values(os.networkInterfaces()).flat().filter((a) => a && !a.internal && a.family === 'IPv4').map((a) => a.address);
  return [os.hostname(), ...ips].map((h) => `http://${h}:${PORT}`);
}

// every request the studio answers, over HTTP or over an editor's link (tools/link.mjs), which comes to it the same way
async function handle(req, res) {
  const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
  if (!allowed(req)) return refuse(res);
  try {
    if (p === '/') return serveFile(req, res, path.join(UI, 'studio.html'));
    if (p.startsWith('/nle/')) { const f = inside(UI, p.slice(5)); return f ? serveFile(req, res, f) : json(res, 404, {}); }
    if (p.startsWith('/engine/')) { const f = inside(path.join(ROOT, 'engine'), p.slice(8)); return f ? serveFile(req, res, f) : json(res, 404, {}); }   // (beside nle/, as in a workspace: model.js's ../engine/)
    // files: a project's from the workspace; the studio's own (its engine, its packages: what the editor imports) from the studio
    if (p.startsWith('/poster/')) {
      const m = /^\/poster\/([^/]+)\/([^/]+)\/(\d+)\.jpg$/.exec(p), d = m && TIMELINE_ID.test(m[2]) && projectDir(m[1]);
      const jpg = d && (await fs.promises.readFile(path.join(previewsOf(d, m[2]), 'preview', `${m[3]}.png`)).then((b) => jpegOf(b, 0.8, { width: 480 }), () => null));
      if (!jpg) return json(res, 404, {});
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=300' });
      return res.end(jpg);
    }
    if (p.startsWith('/files/')) { const rel = p.slice(7), f = inside(rel.startsWith('projects/') ? WS : ROOT, rel); return f ? serveFile(req, res, f) : json(res, 404, {}); }
    // an image of the panel's conversations, by its name (tools/agents/images.mjs): whole, or a thumbnail w px wide; its
    // name is its content, so the browser may keep it
    if (p.startsWith('/agent-image/')) {
      const got = await imageFile(p.slice('/agent-image/'.length), u.searchParams.get('w'));
      if (!got) return json(res, 404, {});
      res.writeHead(200, { 'content-type': got.type, 'cache-control': 'max-age=31536000, immutable' });
      return fs.createReadStream(got.file).pipe(res);
    }
    if (p === '/api/studio') return json(res, 200, workspaceState());
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      workspaceClients.add(res); workspaceChanged(); req.on('close', () => workspaceClients.delete(res)); return;
    }
    const target = /^\/api\/agents\/([^/]+)\/target$/.exec(p);
    if (target) {
      const a = agents.target(target[1]);
      if (req.method === 'POST') {
        const { project, timeline = 'main' } = await jsonBody(req);
        if (project !== a.project) return json(res, 400, { error: `This agent belongs to ${a.project}. Start an agent in ${project} to work there; this agent's target was not changed.` });
        await acquire(project, timeline); a.setTarget(timeline);
      }
      return json(res, 200, a.target());
    }
    // the viewer's caches' limit on this machine, in GB (tools/cache.mjs): raised, the open film's renders all of it again
    if (p === '/api/cache' && req.method === 'POST') {
      const was = caches.info().limit, limit = setCacheLimit((await jsonBody(req)).limit);
      if (limit > was) for (const p of opened.values()) Object.values(p.previews).forEach((pv) => pv.roomy());
      caches.check();
      return json(res, 200, caches.info());
    }
    // the caches cleared: every film's frames, and the GPU's compiled pipelines the render browsers keep; the open films
    // load again (their workers in new browsers) and render again
    if (p === '/api/cache/clear' && req.method === 'POST') {
      clearGpuCaches();
      await caches.clear();
      for (const p of opened.values()) p.invalidate();
      return json(res, 200, caches.info());
    }
    // how many render workers this machine runs ('dynamic' or a number: worker.mjs, workerCount; an editor's own film the
    // first of them, where it draws the viewer's frames)
    if (p === '/api/workers' && req.method === 'POST') {
      const b = await jsonBody(req);
      const w = b.workers != null ? setWorkerCount(b.workers) : workerCount();
      for (const p of opened.values()) p.rechoose();
      return json(res, 200, { workers: w });
    }
    // whether the viewers render the rest of the film around the playhead ({ on }: preview.mjs, the editor's Pre-render)
    if (p === '/api/prerender') {
      if (req.method === 'POST') {
        const { on } = await jsonBody(req);
        if (typeof on !== 'boolean') return json(res, 400, { error: 'on: true or false' });
        prerender = on; for (const p of opened.values()) p.prerenderChanged();
      }
      return json(res, 200, { on: prerender });
    }
    // other devices: the password they open the studio with ('': none, not let in), and where they reach it
    if (p === '/api/settings/devices') {
      if (req.method === 'POST') { const { password } = await jsonBody(req); configure({ remotePassword: String(password ?? '') || undefined }); }
      return json(res, 200, { password: config().remotePassword ?? '', addresses: addresses() });
    }
    if (p === '/api/projects' && req.method === 'GET') return json(res, 200, await projects());
    if (p === '/api/projects' && req.method === 'POST') {
      // a new project from templates/film, as its own repo (./ephemeris new)
      const { name } = await jsonBody(req);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name || '')) return json(res, 400, { error: 'a project name is lowercase letters, digits and dashes' });
      if (fs.existsSync(path.join(PROJECTS, name))) return json(res, 409, { error: `there is already a project "${name}"` });
      const r = spawnSync(process.execPath, [path.join(HERE, 'ephemeris.mjs'), 'new', name], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
      return r.status === 0 ? json(res, 200, { name }) : json(res, 500, { error: (r.stderr || r.stdout || 'could not make it').trim() });
    }
    // a project's timelines: list, new, duplicate, rename, delete
    const tm = /^\/api\/projects\/([^/]+)\/timelines(?:\/([^/]+))?$/.exec(p);
    if (tm) {
      const dir = projectDir(tm[1]);
      if (!dir) return json(res, 404, { error: `no project "${tm[1]}"` });
      if (req.method === 'GET' && !tm[2]) return json(res, 200, await timelines(dir));
      const [status, out] = await changeTimelines(dir, req, tm[2]);
      return json(res, status, out);
    }
    // Each timeline's API and sockets address its own runtime, whether or not an editor is showing it.
    const m = /^\/p\/([^/]+)(?:\/([^/]+))?(\/.*)?$/.exec(p);
    if (m) {
      const [, name, tid, rest] = m, dir = projectDir(name);
      if (!dir) return json(res, 404, { error: `no project "${name}"` });
      if (!tid) { res.writeHead(302, { location: `/p/${name}/${lastTimeline(dir)}/` }); return res.end(); }
      if (!timelineIds(dir).includes(tid)) return json(res, 404, { error: `no timeline "${tid}" in ${name}` });
      if (!rest) { res.writeHead(302, { location: `/p/${name}/${tid}/` }); return res.end(); }
      if (rest === '/') { await activate(name, tid); return serveFile(req, res, path.join(UI, 'index.html')); }
      return await projectRoute(await acquire(name, tid), rest, req, res, u, `${name}/${tid}`);   // (awaited: its failure is answered below, not left hanging)
    }
    json(res, 404, {});
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
}
const server = http.createServer(handle).listen(PORT, async () => {
  let first = '';
  if (argName) {
    const dir = projectDir(argName);
    if (!dir) { console.error(`no project ${argName}`); process.exit(1); }
    const tid = argTimeline ?? lastTimeline(dir);
    if (!timelineIds(dir).includes(tid)) { console.error(`no timeline ${tid} in ${argName}`); process.exit(1); }
    await activate(argName, tid);
    first = `p/${argName}/${tid}/`;
  }
  console.log(`studio: http://localhost:${PORT}/${first}`);
});

// the open timeline's sockets: its viewer's frames (viewerSocket), /p/<name>/<timeline>/api/viewer; its plugin
// instruments, played live by their hosts (tools/plugins.mjs pluginSocket), …/api/plugins
const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (!allowed(req)) return socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
  // (an editor's link: every request it makes and event stream it reads, tools/link.mjs)
  if (new URL(req.url, 'http://x').pathname === '/link') return sockets.handleUpgrade(req, socket, head, (ws) => serveLink(ws, req, handle, { film: (link, f) => (f ? films.set(link, f) : films.delete(link)) }));
  const m =/^\/p\/([^/]+)\/([^/]+)\/api\/(plugins|viewer)$/.exec(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!m || !isOpen(m[1], m[2])) return socket.destroy();
  const P = opened.get(`${m[1]}/${m[2]}`);
  if (m[3] === 'viewer') return sockets.handleUpgrade(req, socket, head, (ws) => viewerSocket(ws, P, local(req)));
  sockets.handleUpgrade(req, socket, head, (ws) => pluginSocket(ws, { dir: P.dir }));
});

// the studio outlives a film that fails mid-edit (a worker's page erroring while it reloads): logged, not fatal
process.on('unhandledRejection', (e) => console.error('studio:', e?.message ?? e));

function shutdown() {
  for (const ws of sockets.clients) ws.terminate();   // also closes their plugin hosts
  for (const c of servers.values()) c.kill();
  // A timeline also owns its director/inspection workers; closing only previews leaves those processes alive.
  Promise.allSettled([agents.closeAll(), ...[...opened.values()].map((p) => p.close(null, 'shutdown')), closeModels()]).then(() => process.exit(0));
}
for (const sig of ['SIGINT', 'SIGTERM', 'disconnect']) process.on(sig, shutdown);
