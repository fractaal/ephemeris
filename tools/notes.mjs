// A track's instrument, resolved: a notes medium ({ notes: [{ t, dur, note, vel }] }, see nle/model.js isNotes) is played
// live by the instrument of the track its clip is on (track.instrument: nle/live.js). The instrument is one of
//   { sfz: '<path>' } | { sampler: '<path to a saved instrument .json>' } | { named: '<folder of note-named samples>', octave }
//   { plugin: '<name>', state?: '<preset path>', set?: { '<parameter title>': 0–1 } }    (a VST3: tools/plugins.mjs)
// Paths are the project's, `presets/…` among the studio's own presets (assets/presets/<plugin>/: Vial's, the studio's
// synth), `library/…` inside the sound library (tools/workspace.mjs soundLibrary), or `vital/…` in this machine's preset
// folders (tools/presets.mjs: what the one Vital presets folder named). A sampler is resolved here (its data, and where its samples are); the editor (api/instrument)
// and renders (tools/mix.mjs) ask. A plugin is played by its own host (tools/plugins.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSfz, readInstrument, namedInstruments } from './instruments.mjs';
import { soundLibrary } from './workspace.mjs';
import { addedFolders } from './presets.mjs';
import { DEFAULT_INSTRUMENT } from '../nle/model.js';

/** The studio's own presets for plugins: assets/presets/<plugin name>/. */
export const PRESETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'presets');

/** The file a path of an instrument names: in the project, among the studio's presets (`presets/…`), in the sound
 *  library (`library/…`), or in the Vital presets folder (`vital/…`); never outside the folder it names. */
export function instrumentPath(dir, p) {
  if (/^presets\//.test(p)) {
    const f = path.resolve(PRESETS_DIR, p.slice('presets/'.length));
    if (path.relative(PRESETS_DIR, f).startsWith('..')) throw new Error(`"${p}" is outside the studio's presets`);
    return f;
  }
  if (/^vital\//.test(p)) {   // (named as the one Vital presets folder named them: found in this machine's preset folders)
    const rel = p.slice('vital/'.length), at = addedFolders().map((d) => path.resolve(d, rel)).find((f, i) => !path.relative(addedFolders()[i], f).startsWith('..') && fs.existsSync(f));
    if (!at) throw new Error(`"${p}" is not in this machine's preset folders (the settings' Preset folders)`);
    return at;
  }
  if (!/^library\//.test(p)) return path.resolve(dir, p);
  const lib = soundLibrary();
  if (!lib) throw new Error(`"${p}" is in the sound library, and this machine has none (EPHEMERIS_SOUND_LIBRARY, or soundLibrary in the config)`);
  const f = path.resolve(lib, p.slice('library/'.length));
  if (path.relative(lib, f).startsWith('..')) throw new Error(`"${p}" is outside the sound library`);
  return f;
}

/** A sampler instrument spec as { sampler: instrument data, root: the folder its samples are named from }. */
export async function resolveInstrument(dir, spec = {}) {
  if (spec.synth || spec.preset) throw new Error(`the Ephemeris Synth is gone: Vial plays synth sounds (${JSON.stringify(DEFAULT_INSTRUMENT)}, or another of its presets)`);
  if (spec.sfz) { const f = instrumentPath(dir, spec.sfz); return { sampler: await importSfz(f), root: path.dirname(f) }; }
  if (spec.sampler) { const f = instrumentPath(dir, spec.sampler); return { sampler: await readInstrument(f), root: path.dirname(f) }; }
  if (spec.named) {
    const f = instrumentPath(dir, spec.named), { instruments } = await namedInstruments(f, { octave: spec.octave ?? 0 });
    const best = instruments.sort((a, b) => b.regions.length - a.regions.length)[0];
    if (!best) throw new Error(`no samples named by note in "${spec.named}"`);
    return { sampler: best, root: f };
  }
  throw new Error('a track\'s instrument is { plugin }, { sfz }, { sampler } or { named }');
}
