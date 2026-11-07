// Plugins (VST3) as instruments. Each one plays in its own plughost process (native/plughost, built by its build.sh into
// the cache): it loads the plugin, takes its state (a preset, as the plugin saves it: a Vital preset is a .vital file),
// the timeline's tempo and the instrument's notes, and streams its sound back, as fast as it goes for a render
// (tools/mix.mjs) or a little ahead of the playhead for the editor (the studio's api/plugins). A plugin that crashes
// takes only its own process down.
//
//   node tools/plugins.mjs list                    the plugins this machine has
//   node tools/plugins.mjs params <plugin>         a plugin's parameters, as `set` in an instrument names them
//
// A track's instrument { plugin: '<name, as its bundle is named: Vial for Vial.vst3, or a path>', state: '<a
// preset file: the project's, library/…, or vital/… in the Vital presets folder>', set: { '<parameter title>': 0–1 } }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './workspace.mjs';
import { presetsFor } from './presets.mjs';
import { instrumentPath, PRESETS_DIR } from './notes.mjs';
import { noteEvents, PLUGIN_TAIL } from '../nle/live.js';
import { automationPoints } from '../nle/automation.js';
import { clipEnd, notesClips } from '../nle/model.js';

// the app's own builds of the host and Vial (app/build.mjs puts them in its bin/; a checkout has none)
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');

/** Where the host is: EPHEMERIS_PLUGHOST, the app's own, or the cache (native/plughost/build.sh puts it there). */
const HOST = process.platform === 'win32' ? 'plughost.exe' : 'plughost';
const cache = () => process.env.EPHEMERIS_CACHE || path.join(os.homedir(), '.cache', 'ephemeris');
export const plughostPath = () => process.env.EPHEMERIS_PLUGHOST || [path.join(BIN, HOST), path.join(cache(), 'plughost', HOST)].find((f) => fs.existsSync(f)) || path.join(cache(), 'plughost', HOST);

/** Where plugins are looked for: the config's pluginPaths, the app's own (Vial), the cache's (native/vial/build.sh
 *  builds Vial there), and the system's VST3 folders. */
export function pluginFolders() {
  const home = os.homedir(), own = [...(config().pluginPaths ?? []), path.join(BIN, 'plugins'), path.join(cache(), 'plugins')];
  const system = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Common', 'VST3'),
      path.join(process.env.CommonProgramW6432 || process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'VST3')]
    : process.platform === 'darwin'
      ? [path.join(home, 'Library/Audio/Plug-Ins/VST3'), '/Library/Audio/Plug-Ins/VST3']
      : [path.join(home, '.vst3'), '/usr/lib/vst3', '/usr/local/lib/vst3'];
  return [...own, ...system].filter((d) => fs.existsSync(d));
}

/** Every plugin found: [{ name, path }] (named as its bundle is: Vial.vst3 is Vial), the first of a name kept. */
export function findPlugins() {
  const seen = new Map();
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(dir, e.name);
      if (/\.vst3$/i.test(e.name)) { const name = e.name.replace(/\.vst3$/i, ''); if (!seen.has(name)) seen.set(name, { name, path: f }); }
      else if (e.isDirectory() && depth < 2) walk(f, depth + 1);   // (vendors' folders)
    }
  };
  for (const d of pluginFolders()) walk(d, 0);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The studio's own presets for a plugin (assets/presets/<plugin>/): [{ file, name }]. */
export function studioPresets(plugin) {
  const d = path.join(PRESETS_DIR, plugin);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => !f.startsWith('.')).sort().map((f) => ({ file: `presets/${plugin}/${f}`, name: f.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') })) : [];
}

/** A plugin's presets in the preset folders (tools/presets.mjs): [{ name, folder, spec (what an instrument is, playing
 *  it: the studio's or the project's), or take (copied into the project when chosen: takePreset) }]. A sound saved from
 *  its window is not one: the instrument names it while it plays it. */
export function pluginPresets(dir, plugin) {
  return presetsFor(dir, plugin).map((x) => ({ ...x, spec: x.state ? { plugin, state: x.state } : null }));
}

/** A plugin's bundle, from its name or its path. */
export function pluginPath(ref) {
  if (typeof ref !== 'string' || !ref) throw new Error('an instrument plugin is named: { plugin: "<name>" }');
  if ((path.isAbsolute(ref) || /[\\/]/.test(ref)) && fs.existsSync(ref)) return ref;
  const p = findPlugins().find((x) => x.name === ref);
  if (!p) throw new Error(`no plugin "${ref}" on this machine (looked in ${pluginFolders().join(', ') || 'no plugin folders'})`);
  return p.path;
}

/** Starts a plugin's host; resolves once the plugin is loaded. onSound(pos, L, R): its sound as it comes; onEvent(e): the
 *  other events (edited, editor, error). */
export function openPlugin(ref, { sr = 48000, block = 128, onSound = () => {}, onEvent = () => {} } = {}) {
  const host = plughostPath();
  if (!fs.existsSync(host)) return Promise.reject(new Error(`the plugin host is not built (${host}: native/plughost/build.sh)`));
  let bundle;
  try { bundle = pluginPath(ref); } catch (e) { return Promise.reject(e); }
  const proc = spawn(host, [bundle, '--sr', String(sr), '--block', String(block)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const waiting = { state: [], getState: [], done: [], texts: [] }, errors = [];
  let ready, failed, buf = Buffer.alloc(0), info = null;
  const loaded = new Promise((res, rej) => { ready = res; failed = rej; });
  proc.stderr.on('data', (d) => { errors.push(d); if (errors.length > 50) errors.shift(); });
  proc.on('error', (e) => failed(e));
  proc.on('close', (code) => {
    const why = new Error(`the plugin host for "${ref}" ended (${code ?? 'killed'}): ${Buffer.concat(errors).toString().trim().split('\n').slice(-3).join(' | ')}`);
    failed(why);
    for (const list of Object.values(waiting)) for (const w of list.splice(0)) w.reject(why);
    onEvent({ event: 'closed', code });
  });
  proc.stdin.on('error', () => {});   // (it ended: told by 'close')
  proc.stdout.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length >= 5) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const kind = buf[4], body = buf.subarray(5, 4 + len);
      buf = buf.subarray(4 + len);
      if (kind === 2) {
        const pos = Number(body.readBigInt64LE(0)), n = body.readUInt32LE(8);
        const f = new Float32Array(body.buffer.slice(body.byteOffset + 12, body.byteOffset + 12 + n * 8));   // (copied: aligned)
        onSound(pos, f.subarray(0, n), f.subarray(n, 2 * n));
      } else if (kind === 3) waiting.getState.shift()?.resolve(Buffer.from(body));
      else if (kind === 1) {
        const e = JSON.parse(body.toString());
        if (e.event === 'ready') { info = e; ready(); }
        else if (e.event === 'state') {   // (its parameters as the state set them)
          for (const p of info?.params ?? []) if (e.values?.[p.id] != null) p.value = e.values[p.id];
          waiting.state.shift()?.resolve(e.ok);
        }
        else if (e.event === 'done') waiting.done.shift()?.resolve(e.pos);
        else if (e.event === 'texts' || e.event === 'parsed') waiting.texts.shift()?.resolve(e.list);
        // (a host built before it could say a value's text: the question is answered, not left waiting)
        else if (e.event === 'error' && /^no command (texts|parse)$/.test(e.message)) waiting.texts.shift()?.reject(new Error(`this plugin host is older than its texts: native/plughost/build.sh builds it again`));
        else if (e.event === 'error' && !info) failed(new Error(e.message));
        else onEvent(e);
      }
    }
  });
  const write = (kind, payload) => {
    const head = Buffer.alloc(5);
    head.writeUInt32LE(payload.length + 1, 0); head[4] = kind;
    proc.stdin.write(Buffer.concat([head, payload]));
  };
  const command = (c) => write(1, Buffer.from(JSON.stringify(c)));
  const ask = (list, send) => new Promise((resolve, reject) => { waiting[list].push({ resolve, reject }); send(); });
  const api = {
    get info() { return info; },
    command,
    /** A parameter's id, from its title (as `set` names it). */
    param: (title) => info.params.find((p) => p.title === title)?.id,
    /** Takes a state (a preset file's bytes); resolves to whether the plugin took it. */
    setState: (bytes) => ask('state', () => write(3, Buffer.from(bytes))),
    getState: () => ask('getState', () => command({ op: 'getState' })),
    /** Sets parameters by title ({ 'Macro 1': 0.5 }), normalized; titles it does not have are returned. */
    set(values = {}) {
      const ids = {}, missing = [];
      for (const [title, v] of Object.entries(values)) { const id = api.param(title); if (id == null || typeof v !== 'number') missing.push(title); else ids[id] = Math.min(1, Math.max(0, v)); }
      if (Object.keys(ids).length) command({ op: 'params', values: ids });
      return missing;
    },
    tempo: (grid = {}) => command({ op: 'tempo', bpm: grid.bpm || 120, offset: grid.offset || 0, beatsPerBar: grid.beatsPerBar || 4 }),
    /** Parameters over the timeline (nle/automation.js automationPoints: [[sample, id, value], …]). */
    automation: (list) => command({ op: 'automation', list }),
    /** Normalized values as the plugin writes them ([[id, 0–1], …] → ["800 Hz", …]; "" where it does not say). */
    texts: (list) => ask('texts', () => command({ op: 'texts', list })),
    /** Text as the plugin reads it ([[id, "800 Hz"], …] → [0–1 or null, …]). */
    parse: (list) => ask('texts', () => command({ op: 'parse', list })),
    /** A parameter's value now (normalized; as its state set it), by title. */
    valueOf: (title) => info.params.find((p) => p.title === title)?.value,
    /** The notes, as live.js noteEvents gives them: [{ s, on, note, vel }]. */
    notes: (events) => command({ op: 'notes', list: events.map((e) => [e.s, e.on ? 1 : 0, e.note, e.vel ?? 0]) }),
    /** Its sound from sample `from` to `to`, as [L, R]. */
    async render(from, to) {
      const n = Math.max(0, to - from), L = new Float32Array(n), R = new Float32Array(n), was = onSound;
      onSound = (pos, l, r) => { L.set(l, pos - from); R.set(r, pos - from); };
      try { await ask('done', () => command({ op: 'render', from, to })); } finally { onSound = was; }
      return [L, R];
    },
    close() { if (proc.exitCode == null) { command({ op: 'quit' }); proc.stdin.end(); setTimeout(() => proc.kill(), 2000).unref(); } },
  };
  return loaded.then(() => api, (e) => { proc.kill(); throw e; });
}

/** A plugin instrument ({ plugin, state, set }) started: its host, given its state (dir: the project's, where a state's
 *  path is from) and its parameters. Resolves to the host, and the titles in `set` it does not have (as warnings). */
export async function startInstrument(dir, spec, opts) {
  const host = await openPlugin(spec.plugin, opts);
  try {
    if (spec.state && !(await host.setState(fs.readFileSync(instrumentPath(dir, spec.state))))) throw new Error(`"${spec.plugin}" did not take the state ${spec.state}`);
    return { host, missing: host.set(spec.set) };
  } catch (e) { host.close(); throw e; }
}

/** What a track's plugin instrument plays: the track's notes clips, rendered by its host from the start to its last
 *  notes clip's end and PLUGIN_TAIL after (tl: the timeline, for its patterns and its grid's tempo). [L, R] at sr. */
export async function renderInstrument(dir, tl, track, sr) {
  const spec = track.instrument, { host, missing } = await startInstrument(dir, spec, { sr });
  try {
    if (missing.length) console.warn(`${spec.plugin} has no parameter ${missing.map((m) => `"${m}"`).join(', ')}`);
    host.tempo(tl.grid);
    host.notes(noteEvents(track, tl, sr));
    const end = Math.max(0, ...notesClips(track, tl.media).map(clipEnd)), to = Math.ceil((end + PLUGIN_TAIL) * sr);
    host.automation(automationPoints(track, tl.media, sr, to, host.param, (title) => spec.set?.[title] ?? host.valueOf(title) ?? 0));
    return await host.render(0, to);
  } finally { host.close(); }
}

/** The studio's api/plugins: a WebSocket on which the editor plays its plugin instruments live. dir: the project's.
 *  The editor's messages (JSON):
 *    open { key, spec, sr }    a host for a track's plugin instrument (pluginKey), given its state and parameters
 *    spec { key, spec }        its instrument changed (another state: taken anew; parameters: set)
 *    notes { key, list }       its notes, as plughost takes them    tempo { grid }      the timeline's
 *    play { from, ahead, key? }    every host (or one) plays from that sample, `ahead` past the last ack { pos }
 *    monitor { key, from, ahead }  one plays as it is played, the timeline stopped     note { key, on, note, velocity }
 *    automation { key, list }      its parameters over the timeline (nle/automation.js automationPoints)
 *    stop { key? } · close { key } · editor { key, open, title }    (the plugin's own window)
 *  Its answers: { key, event: 'ready', id, name, params, editor, missing } · { key, event: 'error', message } ·
 *  { key, event: 'editor', open } · { key, event: 'values', values } (its parameters, as a new state set them) ·
 *  { key, event: 'saved', state }: the plugin was changed in its window, and its state is
 *  now that file in the project (instruments/…), which the instrument should name. Sound comes as binary messages:
 *  [u32 id][u32 n][f64 sample][n floats, left][n floats, right]. */
export function pluginSocket(ws, { dir }) {
  const sessions = new Map();   // key → { id, spec, state, host, queue (what came while it started), timer }
  let nextId = 1;
  const reply = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const sound = (id, pos, L, R) => {
    if (ws.readyState !== 1) return;
    const n = L.length, b = Buffer.allocUnsafe(16 + 8 * n);
    b.writeUInt32LE(id, 0); b.writeUInt32LE(n, 4); b.writeDoubleLE(pos, 8);
    Buffer.from(L.buffer, L.byteOffset, 4 * n).copy(b, 16); Buffer.from(R.buffer, R.byteOffset, 4 * n).copy(b, 16 + 4 * n);
    ws.send(b);
  };
  const to = (s, c) => (s.host ? s.host.command(c) : s.queue.push(c));
  const hashOf = (bytes) => createHash('sha1').update(bytes).digest('hex').slice(0, 12);
  // what it holds now (as its window opens), to tell a change from none (a window opened and closed)
  const holds = async (s) => { s.hash = hashOf(await s.host.getState()); };
  // a plugin changed in its window: its state kept (a while after the last change, and when its window closes), as a
  // file named by what it holds
  async function save(key, s) {
    try {
      clearTimeout(s.timer);
      const bytes = await s.host.getState(), hash = hashOf(bytes);
      if (hash === s.hash) return;
      s.hash = hash;
      const rel = `instruments/${String(s.spec.plugin).replace(/[^\w.-]+/g, '_')}-${hash}.state`, f = path.join(dir, rel);
      if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); }
      if (sessions.get(key) !== s) return;
      s.state = rel;
      reply({ key, event: 'saved', state: rel });
    } catch (e) { reply({ key, event: 'error', message: `its state was not saved: ${e.message}` }); }
  }
  async function open(key, spec, sr) {
    sessions.get(key)?.host?.close();
    const s = { id: nextId++, spec, sr, state: spec.state, host: null, queue: [], timer: null };
    sessions.set(key, s);
    try {
      const { host, missing } = await startInstrument(dir, spec, {
        sr,
        onSound: (pos, L, R) => sound(s.id, pos, L, R),
        onEvent: (e) => {
          if (sessions.get(key) !== s) return;
          if (e.event === 'edited') { clearTimeout(s.timer); s.timer = setTimeout(() => save(key, s), 1200); }
          else if (e.event === 'editor') { reply({ key, event: 'editor', open: e.open }); if (s.host) (e.open ? holds(s) : save(key, s)); }
          else if (e.event === 'error') reply({ key, event: 'error', message: e.message });
          else if (e.event === 'closed') { s.host = null; reply({ key, event: 'error', message: `the plugin stopped (${e.code ?? 'killed'})` }); }
        },
      });
      if (sessions.get(key) !== s) return host.close();
      s.host = host;
      for (const c of s.queue.splice(0)) host.command(c);
      const { name, params, editor } = host.info;
      reply({ key, event: 'ready', id: s.id, name, params, editor, missing });
    } catch (e) {
      if (sessions.get(key) === s) sessions.delete(key);
      reply({ key, event: 'error', message: e.message });
    }
  }
  ws.on('message', async (data, binary) => {
    if (binary) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const s = sessions.get(m.key);
    try {
      if (m.op === 'open') return await open(m.key, m.spec, m.sr || 48000);
      if (m.op === 'close') { s?.host?.close(); clearTimeout(s?.timer); return sessions.delete(m.key); }
      if (m.op === 'tempo') { for (const x of sessions.values()) to(x, { op: 'tempo', bpm: m.grid?.bpm || 120, offset: m.grid?.offset || 0, beatsPerBar: m.grid?.beatsPerBar || 4 }); return; }
      if (m.op === 'play' || m.op === 'monitor' || m.op === 'stop' || m.op === 'ack') {
        for (const x of m.key ? [s].filter(Boolean) : sessions.values()) to(x, { op: m.op, from: m.from, ahead: m.ahead, pos: m.pos });
        return;
      }
      if (m.op === 'note') { if (s?.host) s.host.command({ op: 'note', on: !!m.on, note: m.note, velocity: m.velocity ?? 0.8 }); return; }
      if (m.op === 'automation') { if (s) to(s, { op: 'automation', list: m.list ?? [] }); return; }
      if (!s) return;
      if (m.op === 'notes') to(s, { op: 'notes', list: m.list });
      else if (m.op === 'editor') to(s, { op: 'editor', open: m.open !== false, title: m.title });
      else if (m.op === 'spec' && !s.host) await open(m.key, m.spec, s.sr);   // (changed while it started: started anew)
      else if (m.op === 'spec') {
        const was = s.spec;
        s.spec = m.spec;
        if ((m.spec.state ?? null) !== (s.state ?? null)) {   // (not the file it saved itself: that is what it holds)
          s.state = m.spec.state;
          if (m.spec.state && !(await s.host.setState(fs.readFileSync(instrumentPath(dir, m.spec.state))))) reply({ key: m.key, event: 'error', message: `it did not take ${m.spec.state}` });
          s.host.set(m.spec.set);
          reply({ key: m.key, event: 'values', values: Object.fromEntries(s.host.info.params.map((p) => [p.id, p.value])) });
        } else if (JSON.stringify(was.set ?? {}) !== JSON.stringify(m.spec.set ?? {})) s.host.set(m.spec.set);
      }
    } catch (e) { reply({ key: m.key, event: 'error', message: e.message }); }
  });
  ws.on('close', () => { for (const x of sessions.values()) { clearTimeout(x.timer); x.host?.close(); } sessions.clear(); });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ref] = process.argv.slice(2);
  if (cmd === 'list') for (const p of findPlugins()) console.log(`${p.name}\t${p.path}`);
  else if (cmd === 'params' && ref) {
    const p = await openPlugin(ref);
    for (const x of p.info.params) console.log(`${x.title}\t${x.value.toFixed(3)}${x.steps ? `\t${x.steps + 1} steps` : ''}${x.units ? `\t${x.units}` : ''}`);
    p.close();
  } else { console.error('usage: node tools/plugins.mjs list | params <plugin>'); process.exit(2); }
}
