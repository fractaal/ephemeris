// Preset folders: where the studio finds presets for its plugins, as the settings list them (the Instrument panel's
// dropdown, the agents' instruments and set_instrument):
//   Ephemeris      the studio's own, shipped with it (assets/presets/<plugin>/): named presets/<plugin>/<file> anywhere
//   Your presets   the workspace's presets/, every project's (a plugin's own saves land in presets/<plugin>/)
//   This project   its instruments/: the presets it holds (taken from a folder, written by an agent)
//   added folders  any others, this machine's (presetFolders in the config; the Vital presets folder, vitalPresets, is one)
// A plugin's presets are the files there of the kind its presets in the studio are (Vial's: .vital): a preset is loaded
// as the plugin's state, so only a plugin whose preset files are its state has them (tools/plugins.mjs). One taken from
// Your presets or an added folder is copied into the project's instruments/, so the film holds what it is made of.
//
// Vial, the studio's synth, has a browser of its own, reading the presets and wavetables of its data folder: the studio
// points it (its config's data_directory) at a folder of links to these (vialData), so it lists the same.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG, STUDIO, config, configure, chosen } from './workspace.mjs';
import { PRESETS_DIR } from './notes.mjs';

const r = (s) => s.split(path.sep).join('/');
// a folder's files to a depth, as [relative path, …] (not hidden ones)
function filesIn(dir, depth = 3, rel = '') {
  let out = [];
  let es = [];
  try { es = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (e.name.startsWith('.')) continue;
    const p = rel ? path.join(rel, e.name) : e.name, full = path.join(dir, p);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch { continue; } }
    if (isDir) { if (depth > 1) out = out.concat(filesIn(dir, depth - 1, p)); } else out.push(p);
  }
  return out;
}

/** The folders added on this machine (presetFolders; the old vitalPresets among them). */
export const addedFolders = () => [...new Set([...(config().presetFolders ?? []), ...(config().vitalPresets ? [config().vitalPresets] : []), ...(process.env.EPHEMERIS_VITAL_PRESETS ? [process.env.EPHEMERIS_VITAL_PRESETS] : [])])];
/** Your presets: the workspace's presets/ (made if missing; the workspace as chosen, never linked here: workspace.mjs). */
export function yourFolder() {
  const d = path.join(chosen() ?? STUDIO, 'presets');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** The preset folders, in order: [{ id, label, path, kind: 'studio' | 'yours' | 'project' | 'added' }] (dir: the open
 *  project's; none without one). */
export function presetFolders(dir = null) {
  return [
    { id: 'studio', label: 'Ephemeris', path: PRESETS_DIR, kind: 'studio' },
    { id: 'yours', label: 'Your presets', path: yourFolder(), kind: 'yours' },
    ...(dir ? [{ id: 'project', label: 'This project', path: path.join(dir, 'instruments'), kind: 'project' }] : []),
    ...addedFolders().map((p, i, all) => {   // (each by its name; two of one name told apart, and none named as the others)
      const n = path.basename(p), same = all.filter((q, j) => j < i && path.basename(q) === n).length, taken = ['Ephemeris', 'Your presets', 'This project', 'User'].includes(n);
      return { id: `folder:${p}`, label: same || taken ? `${n} (${same + 2})` : n, path: p, kind: 'added' };
    }),
  ];
}

// the kinds of file a plugin's presets are: those of its presets in the studio (none: it has no presets here)
const kindsOf = (plugin) => new Set(filesIn(path.join(PRESETS_DIR, plugin), 1).map((f) => path.extname(f).toLowerCase()).filter(Boolean));
const nameOf = (f) => path.basename(f).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');

/** A plugin's presets in every folder: [{ name, folder (its label), kind, state (what an instrument names: the studio's
 *  presets/…, the project's instruments/…), or take ({ folder: id, file }: copied into the project when chosen) }]. */
export function presetsFor(dir, plugin) {
  const kinds = kindsOf(plugin);
  if (!kinds.size) return [];
  const out = [];
  for (const f of presetFolders(dir)) {
    const files = filesIn(f.path).filter((x) => kinds.has(path.extname(x).toLowerCase())).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    for (const x of files) {
      const rel = r(x), base = { name: nameOf(x), folder: f.label, kind: f.kind };
      if (f.kind === 'studio') { if (rel.startsWith(`${plugin}/`)) out.push({ ...base, state: `presets/${rel}` }); }
      else if (f.kind === 'project') out.push({ ...base, state: `instruments/${rel}` });
      else out.push({ ...base, take: { folder: f.id, file: rel } });
    }
  }
  return out;
}

/** A preset of Your presets or an added folder copied into the project's instruments/ (a file of that name there kept
 *  where it is the same; else named apart by its content): what an instrument names it by, instruments/…. */
export function takePreset(dir, { folder, file }) {
  const f = presetFolders(dir).find((x) => x.id === folder && (x.kind === 'yours' || x.kind === 'added'));
  if (!f) throw new Error(`no preset folder "${folder}"`);
  const src = path.resolve(f.path, file);
  if (path.relative(f.path, src).startsWith('..') || !fs.existsSync(src)) throw new Error(`no preset "${file}" in ${f.label}`);
  const bytes = fs.readFileSync(src), inst = path.join(dir, 'instruments');
  fs.mkdirSync(inst, { recursive: true });
  let name = path.basename(src), to = path.join(inst, name);
  if (fs.existsSync(to) && !fs.readFileSync(to).equals(bytes)) {
    name = `${name.replace(/\.[^.]+$/, '')}-${crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 6)}${path.extname(name)}`;
    to = path.join(inst, name);
  }
  if (!fs.existsSync(to)) fs.writeFileSync(to, bytes);
  return `instruments/${name}`;
}

/** Adds a folder (it must be one), or takes one away (the old single Vital presets folder too, vitalPresets). */
export function setFolders({ add = null, remove = null } = {}) {
  let list = config().presetFolders ?? [];
  if (add) {
    const p = path.resolve(String(add).replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`${p} is not a folder`);
    if (!addedFolders().includes(p)) list = [...list, p];
  }
  if (remove) list = list.filter((p) => p !== remove);
  configure({ presetFolders: list, ...(remove && config().vitalPresets === remove && { vitalPresets: undefined }) });
}

// ---------- Vial's own browser: its data folder, links to these
/** Vial's config file (JUCE's place for it: Vital's LoadSave::getConfigFile, named Vial). */
export function vialConfigFile() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'vial', 'Vial.config');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'vial', 'Vial.config');
  return path.join(os.homedir(), '.vial', 'Vial.config');
}
/** The folder Vial reads its presets and wavetables from, made of links to the preset folders: a folder each, its
 *  presets (Presets) and wavetables (Wavetables, an added folder's: a pack of them is one); its own saves (User/Presets)
 *  in Your presets/Vial. Vial's config is pointed at it. dir: the open project's (This project), or none. */
export function vialData(dir = null) {
  const data = path.join(path.dirname(CONFIG), 'vial'), user = path.join(yourFolder(), 'Vial');
  fs.mkdirSync(path.join(data, 'User'), { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  const link = (at, target) => {
    try { if (fs.readlinkSync(at) === target) return; fs.unlinkSync(at); } catch { /* none there, or not a link */ }
    try { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* a folder of its own there: left */ }
  };
  const want = new Set(['User']);
  link(path.join(data, 'User', 'Presets'), user);
  for (const f of presetFolders(dir)) {
    if (f.kind === 'yours') continue;   // (its Vial folder is Vial's User)
    const name = f.label, at = path.join(data, name);
    want.add(name);
    link(path.join(at, 'Presets'), f.kind === 'studio' ? path.join(f.path, 'Vial') : f.path);
    if (f.kind === 'added') link(path.join(at, 'Wavetables'), f.path);
  }
  // (folders no longer listed: their links go)
  for (const e of fs.readdirSync(data)) {
    if (want.has(e)) continue;
    for (const k of ['Presets', 'Wavetables']) { try { fs.lstatSync(path.join(data, e, k)).isSymbolicLink() && fs.unlinkSync(path.join(data, e, k)); } catch { /* none */ } }
    try { fs.rmdirSync(path.join(data, e)); } catch { /* not empty: left */ }
  }
  const cf = vialConfigFile();
  let c = {};
  try { c = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch { /* none yet */ }
  if (c.data_directory !== data) { fs.mkdirSync(path.dirname(cf), { recursive: true }); fs.writeFileSync(cf, JSON.stringify({ ...c, data_directory: data }, null, 2)); }
  return data;
}
