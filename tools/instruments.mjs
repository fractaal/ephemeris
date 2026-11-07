// Sampler instruments and disk, in Node. An instrument is plain data (engine/sound/sampler.js): importSfz makes one from
// an SFZ library (SFZ is only ever read, never written), saveInstrument/readInstrument keep it as .json, and
// loadInstrument decodes the samples it names (once, by ffmpeg, at their own sample rate) into something that plays.
// A region's `sample` is a path relative to the library root, so the instrument and its samples can move together.
// namedInstruments maps a library that is only files named by note (C3_vl2_rr1.wav: most free libraries) into instruments.
//   import { importSfz, loadInstrument, saveInstrument, readInstrument, folderKit, loadFolder, namedInstruments, nameParts } from './instruments.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadSound } from './soundio.mjs';
import { importSfz as importSfzText } from '../engine/sound/sfz.js';
import { sampler, kit, spread } from '../engine/sound/sampler.js';
import { midi } from '../engine/sound/core.js';

const cache = new Map();

// A WAV's sample rate and the loop its smpl chunk holds, read from the chunk headers alone (no decoding).
async function wavInfo(file) {
  const h = await fs.open(file, 'r');
  try {
    const { size } = await h.stat(), b = Buffer.alloc(64);
    await h.read(b, 0, 12, 0);
    if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null;
    let sr = 0, loop;
    for (let pos = 12; pos + 8 <= size;) {
      await h.read(b, 0, 8, pos);
      const id = b.toString('latin1', 0, 4), len = b.readUInt32LE(4);
      if (id === 'fmt ') { await h.read(b, 0, 8, pos + 8); sr = b.readUInt32LE(4); }
      else if (id === 'smpl') {
        await h.read(b, 0, 36, pos + 8);
        if (b.readUInt32LE(28) > 0) {
          const e = Buffer.alloc(24);
          await h.read(e, 0, 24, pos + 8 + 36);
          loop = { start: e.readUInt32LE(8), end: e.readUInt32LE(12) };
        }
      }
      pos += 8 + len + (len & 1);
    }
    return sr ? { sr, loop } : null;
  } finally { await h.close(); }
}
// A FLAC file's rate, from its STREAMINFO (the block every FLAC starts with): read, not probed (a drum library's
// thousands of FLAC samples each asked of ffprobe took half a minute to import)
async function flacRate(file) {
  const h = await fs.open(file, 'r');
  try {
    const b = Buffer.alloc(21);
    await h.read(b, 0, 21, 0);
    return b.toString('latin1', 0, 4) === 'fLaC' && (b[4] & 0x7f) === 0 ? (b[18] << 12) | (b[19] << 4) | (b[20] >> 4) || null : null;
  } finally { await h.close(); }
}
const probeRate = (file) => new Promise((resolve, reject) => {
  const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', file]);
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('close', (c) => (c ? reject(new Error(`ffprobe failed: ${file}`)) : resolve(+out.trim())));
});

/** A file as a sound at its own sample rate, or at `sr` (cached). A WAV's loop points come along as `sound.loop` (at the
 *  rate it is decoded at); a file whose two sides are the same comes back with one array for both (the sampler then does
 *  half the work). */
export function loadSample(file, { sr } = {}) {
  const f = path.resolve(file), key = sr ? `${f}@${sr}` : f;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const info = await wavInfo(f).catch(() => null), own = info?.sr ?? (await flacRate(f).catch(() => null)) ?? await probeRate(f);
      const sound = await loadSound(f, sr ?? own);
      const [L, R] = sound.ch;
      let same = L.length === R.length;
      for (let i = 0; same && i < L.length; i++) if (L[i] !== R[i]) same = false;
      if (same) sound.ch[1] = L;
      if (info?.loop) { const k = (sr ?? own) / own; sound.loop = { start: Math.round(info.loop.start * k), end: Math.round(info.loop.end * k) }; }
      return sound;
    })());
    cache.get(key).catch(() => cache.delete(key));
  }
  return cache.get(key);
}

// Runs `fn` over `items`, a few at a time.
async function pool(items, fn, n = 6) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { for (let x; (x = queue.shift()) !== undefined;) await fn(x); }));
}

// A path as written in an SFZ (maybe other case than on disk) to the file that exists, or null.
export async function findFile(file) {
  const exists = (p) => fs.access(p).then(() => true, () => false);
  if (await exists(file)) return file;
  let cur = path.parse(file).root;
  for (const part of path.relative(cur, file).split(path.sep)) {
    const next = path.join(cur, part);
    if (await exists(next)) { cur = next; continue; }
    const hit = (await fs.readdir(cur).catch(() => [])).find((n) => n.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

// What is known of a sample file without decoding it: its rate and the loop it carries (frames).
async function fileInfo(file) {
  const w = await wavInfo(file).catch(() => null);
  return w ?? { sr: (await flacRate(file).catch(() => null)) ?? await probeRate(file) };
}

const slash = (p) => p.split(path.sep).join('/');

/** An SFZ file as a sampler instrument (data; see engine/sound/sampler.js). Samples are found next to the file (as the
 *  SFZ names them), else under each of `roots` (other folders to try the same relative path in: a library split over
 *  several folders); #includes the same way. Each region's `sample` is made relative to `root` (default: the SFZ's folder),
 *  which is where loadInstrument will look for it. */
export async function importSfz(file, { root, roots = [], name } = {}) {
  const dir = path.dirname(path.resolve(file)), text = await fs.readFile(file, 'utf8'), base = path.resolve(root ?? dir);
  const bases = [dir, ...roots.map((r) => path.resolve(r))];
  const locate = async (rel) => {
    for (const b of bases) { const f = await findFile(path.resolve(b, rel)); if (f) return f; }
    return null;
  };
  // #include files are read before parsing (the parser is synchronous): parse, load the files it asked for that are not
  // loaded yet (their paths may use #defines, and they may include more), again until it asks for nothing new
  const includes = new Map();
  let names;
  for (let round = 0, wanted = [null]; wanted.length && round < 16; round++) {
    wanted = []; names = new Set();
    importSfzText(text, { include: (p) => { if (!includes.has(p)) wanted.push(p); return includes.get(p) ?? null; }, info: (s) => { names.add(s); return null; } });
    for (const rel of new Set(wanted)) { const f = await locate(rel); includes.set(rel, f ? await fs.readFile(f, 'utf8') : null); }
  }
  const where = new Map(), infos = new Map();
  await pool([...names].filter((s) => !s.startsWith('*')), async (rel) => {
    const f = await locate(rel);
    where.set(rel, f);
    if (f) infos.set(rel, await fileInfo(f));
  });
  const inst = importSfzText(text, {
    include: (p) => includes.get(p) ?? null, info: (s) => infos.get(s) ?? null, name: name ?? path.parse(file).name,
  });
  for (const r of inst.regions) r.sample = slash(path.relative(base, where.get(r.sample) ?? path.resolve(dir, r.sample)));
  return inst;
}

/** A sampler instrument made playable: the samples its regions name are found under `root` and decoded (cached; a file
 *  may be in a different case than named). The result is a sampler (render(notes, { sr, length })) with `.missing`: the
 *  samples that could not be found. Samples are decoded at their own rate and resampled when played, whatever the render
 *  rate, so no rate is asked for here. */
export async function loadInstrument(inst, { root = '.', taps } = {}) {
  const base = path.resolve(root), samples = new Map(), absent = [];
  await pool([...new Set(inst.regions.map((r) => r.sample))], async (rel) => {
    const f = await findFile(path.resolve(base, rel));
    if (f) samples.set(rel, await loadSample(f)); else absent.push(rel);
  });
  const player = sampler(inst, samples, { taps });
  player.missing = absent;
  return player;
}

/** Writes an instrument as JSON: the instrument's own fields, then one line per region (so a diff shows what changed). */
export async function saveInstrument(file, inst) {
  const { regions, ...rest } = inst;
  const head = JSON.stringify(rest, null, 2).slice(0, -2);
  const body = regions.map((r) => '    ' + JSON.stringify(r)).join(',\n');
  await fs.writeFile(file, `${head},\n  "regions": [\n${body}\n  ]\n}\n`);
}
export async function readInstrument(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

const AUDIO = /\.(wav|flac|mp3|ogg|aif|aiff)$/i;

/** A folder of one-shots as a drum kit instrument, spread over consecutive notes from `from` (name order; `match`: a
 *  regexp to keep only some). Samples are named relative to `root` (default: the folder itself). */
export async function folderKit(dir, { root = dir, from = 36, match, limit = 128, name = path.basename(dir) } = {}) {
  const names = (await fs.readdir(dir)).filter((n) => AUDIO.test(n) && (!match || match.test(n))).sort().slice(0, limit);
  return kit(spread(names.map((n) => slash(path.relative(root, path.join(dir, n)))), from), { name });
}
/** folderKit, loaded. */
export async function loadFolder(dir, opts = {}) {
  return loadInstrument(await folderKit(dir, opts), { root: opts.root ?? dir, taps: opts.taps });
}

// What a sample's path says: its note, its loudness layer, its round robin, whether it is a release sample, and the rest
// of the words (its family: one instrument per family, e.g. a harpsichord's stops). Read token by token: a note (C3, A#0,
// Db4, Cs4); a layer (vl2, v2, or a dynamic: pp … fff, soft, medium, loud, with a round robin after it: f1); a round
// robin (rr2, r01, or a number last); rel or release; sus is dropped. Folders named Releases mark release samples.
const LEVEL = { ppp: 0, pp: 1, p: 2, mp: 3, mf: 4, f: 5, ff: 6, fff: 7, soft: 1, quiet: 1, medium: 4, med: 4, loud: 6, hard: 7 };
export function nameParts(rel) {
  const segs = rel.split('/'), file = segs.pop().replace(/\.[^.]+$/, '');
  const out = { note: null, level: 0, rr: 0, release: false, family: [] };
  for (const s of segs) if (/^rel(ease)?s?$/i.test(s)) out.release = true; else if (!/^(sus(tain)?s?|samples?)$/i.test(s)) out.family.push(s);
  const tokens = file.split(/[_\s.]+|-(?!\d)/).filter(Boolean);
  tokens.forEach((t, i) => {
    let m;
    if (out.note === null && (m = /^([A-G])([#bs]?)(-?\d)$/.exec(t))) out.note = midi(m[1] + (m[2] === 's' ? '#' : m[2]) + m[3]);
    else if ((m = /^(?:vl|v|vel|layer)(\d+)$/i.exec(t))) out.level = +m[1];
    else if ((m = /^(ppp|pp|p|mp|mf|f|ff|fff|soft|quiet|medium|med|loud|hard)(\d*)$/i.exec(t))) { out.level = LEVEL[m[1].toLowerCase()]; if (m[2]) out.rr = +m[2]; }
    else if ((m = /^(?:rr|r|rnd)(\d+)$/i.exec(t))) out.rr = +m[1];
    else if (/^rel(ease)?$/i.test(t)) out.release = true;
    else if (/^sus(tain)?$/i.test(t)) { /* (the default) */ }
    else if (/^\d+$/.test(t) && out.note !== null && i === tokens.length - 1) out.rr = +t;
    else out.family.push(t);
  });
  return out;
}
// MIDI keys each sampled note answers to: up to halfway to its neighbours, and 6 keys past the outermost
function keyRanges(notes) {
  const r = [...new Set(notes)].sort((a, b) => a - b), out = new Map();
  r.forEach((n, i) => out.set(n, [i ? Math.floor((r[i - 1] + n) / 2) + 1 : Math.max(0, n - 6), i < r.length - 1 ? Math.floor((n + r[i + 1]) / 2) : Math.min(127, n + 6)]));
  return out;
}

/** A library of samples named by note (no SFZ: C3_vl2_rr1.wav, Upright1_Rel_C0_vl3_rr2.wav, glock_loud_C5_01.wav) as
 *  instruments, one per family of names (see nameParts). Layers split the velocity range evenly; round robins take turns;
 *  release samples play when a note ends. `octave`: semitones added to every named note (libraries differ on which C is
 *  middle C: +12 for one that calls it C3). Files with no note in their name are listed in `skipped`. */
export async function namedInstruments(dir, { root = dir, octave = 0, match, env = { r: 0.3 } } = {}) {
  const files = (await fs.readdir(dir, { recursive: true })).map(slash).filter((f) => AUDIO.test(f) && (!match || match.test(f))).sort();
  const families = new Map(), skipped = [];
  for (const f of files) {
    const p = nameParts(f);
    if (p.note === null) { skipped.push(f); continue; }
    const name = p.family.join(' ') || path.basename(dir);
    if (!families.has(name)) families.set(name, []);
    families.get(name).push({ ...p, note: p.note + octave, sample: slash(path.relative(root, path.join(dir, f))) });
  }
  const instruments = [...families].map(([name, list]) => {
    const levels = [...new Set(list.map((s) => s.level))].sort((a, b) => a - b), n = levels.length;
    const ranges = { false: keyRanges(list.filter((s) => !s.release).map((s) => s.note)), true: keyRanges(list.filter((s) => s.release).map((s) => s.note)) };
    const turns = new Map();
    for (const s of list) { const k = `${s.note} ${s.level} ${s.release}`; if (!turns.has(k)) turns.set(k, []); turns.get(k).push(s); }
    const regions = [];
    for (const group of turns.values()) {
      group.sort((a, b) => a.rr - b.rr);
      group.forEach((s, i) => {
        const r = { sample: s.sample, key: ranges[s.release].get(s.note), root: s.note }, li = levels.indexOf(s.level);
        if (n > 1) r.vel = [Math.floor(li * 127 / n) + 1, Math.floor((li + 1) * 127 / n)];
        if (group.length > 1) r.rr = { length: group.length, position: i + 1 };
        if (s.release) r.trigger = 'release';
        regions.push(r);
      });
    }
    return { kind: 'sampler', name, env: { ...env }, regions };
  });
  return { instruments, skipped };
}
