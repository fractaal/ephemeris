// What the editor's Instrument panel asks the studio about instruments: the sound library's instruments listed (SFZ files
// and folders of samples named by note), one made into the sampler's data, and a sample's file read. A path is either
// `library/…` (inside soundLibrary(), tools/workspace.mjs) or relative to the open project; nothing outside those two is read.
//   import { listInstruments, instrumentData, sampleFile } from './instrument-api.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { importSfz, namedInstruments, nameParts, readInstrument } from './instruments.mjs';
import { soundLibrary } from './workspace.mjs';

const AUDIO = /\.(wav|flac|mp3|ogg|aif|aiff)$/i;
const slash = (p) => p.split(path.sep).join('/');
const inside = (base, rel) => { const f = path.resolve(base, rel); return f === base || f.startsWith(base + path.sep) ? f : null; };

/** The file or folder a path names: `library/…` in the sound library, else in the project `dir`. */
export function locate(dir, rel) {
  rel = String(rel ?? '');
  const lib = soundLibrary();
  if (rel === 'library' || rel.startsWith('library/')) return lib ? inside(path.resolve(lib), rel.slice(8)) : null;
  return inside(path.resolve(dir), rel);
}
const relOf = (dir, file) => {
  const lib = soundLibrary();
  return lib && (file === path.resolve(lib) || file.startsWith(path.resolve(lib) + path.sep)) ? slash(path.join('library', path.relative(path.resolve(lib), file))) : slash(path.relative(path.resolve(dir), file));
};

let listed = null;   // the library's instruments, found once (the library does not change while the studio runs)
/** Every instrument in the sound library: [{ path: 'library/…', kind: 'sfz' | 'named', name }], by path. A folder holds
 *  named samples when it has three or more audio files named by note (and no SFZ beside them); it is then not searched further. */
export async function listInstruments() {
  const lib = soundLibrary();
  if (!lib) return [];
  if (listed?.lib === lib) return listed.out;
  const root = path.resolve(lib), out = [];
  const walk = async (dir) => {
    const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const sfz = ents.filter((e) => e.isFile() && /\.sfz$/i.test(e.name));
    for (const e of sfz) out.push({ path: relOf(root, path.join(dir, e.name)), kind: 'sfz', name: e.name.replace(/\.sfz$/i, '') });
    const notes = ents.filter((e) => e.isFile() && AUDIO.test(e.name) && nameParts(e.name).note !== null);
    if (!sfz.length && notes.length >= 3) {
      // (a folder of Releases and Sustains is one instrument: the folder above them)
      const rel = relOf(root, dir).split('/'), cut = rel.findIndex((s, i) => i > 0 && /^(rel(ease)?s?|sus(tain)?s?)$/i.test(s)), at = (cut > 0 ? rel.slice(0, cut) : rel).join('/');
      if (!out.some((o) => o.path === at)) out.push({ path: at, kind: 'named', name: at.split('/').slice(at.split('/').length > 3 ? -2 : -1).join(' / ') });
      return;
    }
    for (const e of ents) if (e.isDirectory()) await walk(path.join(dir, e.name));
  };
  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  listed = { lib, out };
  return out;
}

const made = new Map();   // an instrument's data by its request and its file as it is (an SFZ with hundreds of samples is slow to import)
/** A library or project instrument as the sampler's data: { instruments: [{ kind: 'sampler', regions… }], dir }, where each
 *  region's `sample` is relative to `dir` (a path for sampleFile). kind: 'sfz', 'named' (octave: semitones added to the
 *  notes) or 'sampler' (a saved instrument .json). */
export async function instrumentData(dir, kind, rel, octave = 0) {
  const file = locate(dir, rel);
  if (!file) throw new Error(`no such path ${rel}`);
  // (the file as it is now: one changed in place is read again)
  const st = await fs.stat(file), key = `${kind} ${file} ${octave} ${st.mtimeMs} ${st.size}`;
  if (made.has(key)) return made.get(key);
  for (const k of made.keys()) if (k.startsWith(`${kind} ${file} ${octave} `)) made.delete(k);
  let instruments, base;
  if (kind === 'sfz') { instruments = [await importSfz(file)]; base = path.dirname(file); }
  else if (kind === 'named') { instruments = (await namedInstruments(file, { octave: +octave || 0 })).instruments; base = file; }
  else if (kind === 'sampler') { instruments = [await readInstrument(file)]; base = path.dirname(file); }
  else throw new Error(`unknown instrument kind ${kind}`);
  if (!instruments.length) throw new Error(`no instrument in ${rel}`);
  const out = { instruments, dir: relOf(dir, base) };
  if (kind === 'sfz' && !instruments[0].regions?.length) out.partOf = (await includers(file)).map((f) => relOf(dir, f));
  made.set(key, out);
  return out;
}

/** The SFZ programs that #include this one (in its folder and the three above it): an SFZ with no zones of its own is
 *  usually part of one (its keys and paths are the program's), and that is what to load instead. */
async function includers(file) {
  const out = [];
  let dir = path.dirname(file);
  for (let up = 0; up < 4; up++, dir = path.dirname(dir)) {
    const rel = slash(path.relative(dir, file)).toLowerCase();
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isFile() || !/\.sfz$/i.test(e.name) || path.join(dir, e.name) === file) continue;
      const text = await fs.readFile(path.join(dir, e.name), 'utf8').catch(() => '');
      if ([...text.matchAll(/^\s*#include\s+"([^"]+)"/gm)].some((m) => m[1].replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase() === rel)) out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** The absolute path of an audio file the panel asked for (null if it names none). */
export const sampleFile = (dir, rel) => { const f = locate(dir, rel); return f && AUDIO.test(f) ? f : null; };
