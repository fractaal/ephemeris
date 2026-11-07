// SFZ as an import format: SFZ text in, a sampler instrument (the plain data sampler.js plays) out. SFZ is never written
// back; once imported, the instrument is saved and edited as itself. Nothing here reads files: #include and what is known
// of each sample file go through callbacks the caller gives, and a region's `sample` stays the path the SFZ wrote
// (default_path applied, slashes forward), for the caller to make relative to its library. Opcodes the sampler has no
// use for (filters, EQ, LFOs, bend) and generated sounds (`*sine`) are dropped.
//   const inst = importSfz(text, { include: (path) => text | null, info: (sample) => ({ sr, loop }) | null });
import { midi } from './core.js';

const num = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
/* A key as SFZ writes it: a number, or a note name (c4 = 60, c#4, db4). NaN if neither. */
function keyNumber(v) {
  if (typeof v === 'number') return v;
  if (/^\s*-?\d+\s*$/.test(v)) return parseInt(v, 10);
  try { return midi(v.trim()); } catch { return NaN; }
}
const key = (v, d) => { const k = keyNumber(v); return Number.isFinite(k) ? k : d; };

/* A region with every field at its default, then `over` on top (the sampler's kits build theirs this way). */
function region(over = {}) {
  return {
    sample: '', lokey: 0, hikey: 127, keycenter: 60, lovel: 0, hivel: 127, lorand: 0, hirand: 1,
    seqLength: 1, seqPosition: 1, tune: 0, transpose: 0, volume: 0, pan: 0, ampVeltrack: 100, pitchKeytrack: 100,
    pitchVeltrack: 0, offset: 0, end: undefined, delay: 0, loopMode: undefined, loopStart: undefined, loopEnd: undefined,
    trigger: 'attack', group: 0, offBy: 0, offMode: 'fast', offTime: 0.006, rtDecay: 0, ampRandom: 0, pitchRandom: 0,
    // the envelope: seconds, sustain 0–1, and each stage's change per full velocity (the vel2 opcodes)
    ampeg: { delay: 0, attack: 0, hold: 0, decay: 0, sustain: 1, release: 0,
      vel2delay: 0, vel2attack: 0, vel2hold: 0, vel2decay: 0, vel2sustain: 0, vel2release: 0 },
    // crossfades by velocity and key: { lo, hi } to fade in over, { lo, hi } to fade out over (0–127), if present
    xfVel: undefined, xfKey: undefined,
    cc: {}, xfCc: [], swLast: undefined, swDefault: undefined, swLokey: undefined, swHikey: undefined,
    opcodes: {},
    ...over,
  };
}

// A line with the #defines so far put in (longest name first, so $DIR2 is not read as $DIR).
function substitute(line, defines) {
  if (!line.includes('$')) return line;
  for (const n of [...defines.keys()].sort((a, b) => b.length - a.length)) line = line.split(n).join(defines.get(n));
  return line;
}
// Comments out, #include and #define done: one string of headers and opcodes. An #include's path may use #defines.
function preprocess(text, include, defines, depth = 0) {
  if (depth > 16) throw new Error('sfz: #include nests too deep');
  const out = [];
  for (let line of text.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/)) {
    const c = line.indexOf('//');
    if (c >= 0) line = line.slice(0, c);
    let m;
    if ((m = /^\s*#define\s+(\$\w+)\s*(.*?)\s*$/.exec(line))) { defines.set(m[1], m[2]); continue; }
    if ((m = /#include\s+"([^"]*)"/.exec(line))) {
      const sub = include(substitute(m[1], defines).replace(/\\/g, '/'));
      out.push(preprocess(line.slice(0, m.index), include, defines, depth + 1));
      if (sub != null) out.push(preprocess(sub, include, defines, depth + 1));
      out.push(preprocess(line.slice(m.index + m[0].length), include, defines, depth + 1));
      continue;
    }
    out.push(substitute(line, defines));
  }
  return out.join('\n');
}

// Sections with their opcodes as strings. A value runs to the next `name=` or header, so a sample path may hold spaces.
function parseSections(src) {
  const re = /<(\w+)>|(?:^|(?<=\s))([A-Za-z_]\w*)=/g, list = [];
  let cur = null, name = null, from = 0, m;
  const put = (end) => { if (cur && name) cur.ops[name] = src.slice(from, end).trim(); name = null; };
  while ((m = re.exec(src))) {
    put(m.index);
    if (m[1]) { cur = { header: m[1], ops: {} }; list.push(cur); } else if (cur) { name = m[2]; from = re.lastIndex; }
  }
  put(src.length);
  return list;
}

const ENV = { delay: 'delay', attack: 'attack', hold: 'hold', decay: 'decay', sustain: 'sustain', release: 'release' };

// Raw opcodes (merged down the control/global/master/group/region ladder) to a region with numbers.
function build(ops, control) {
  const r = region({ opcodes: ops });
  const n = (name, d) => num(ops[name], d);
  if (ops.sample !== undefined) {
    const p = ops.sample.replace(/\\/g, '/');
    r.sample = p.startsWith('*') || /^\/|^[A-Za-z]:\//.test(p) ? p : control.defaultPath + p;
  }
  if (ops.key !== undefined) { const k = key(ops.key, 60); r.lokey = r.hikey = r.keycenter = k; }
  r.lokey = key(ops.lokey, r.lokey); r.hikey = key(ops.hikey, r.hikey);
  if (ops.pitch_keycenter !== undefined) r.keycenter = key(ops.pitch_keycenter, 60);
  r.lovel = n('lovel', 0); r.hivel = n('hivel', 127); r.lorand = n('lorand', 0); r.hirand = n('hirand', 1);
  r.seqLength = n('seq_length', 1); r.seqPosition = n('seq_position', 1);
  r.tune = n('tune', n('pitch', 0)); r.transpose = n('transpose', 0); r.volume = n('volume', 0);
  r.pan = n('pan', 0) / 100; r.ampVeltrack = n('amp_veltrack', 100) / 100;
  r.pitchKeytrack = n('pitch_keytrack', 100); r.pitchVeltrack = n('pitch_veltrack', 0);
  r.offset = n('offset', 0); r.end = ops.end !== undefined ? n('end', undefined) : undefined; r.delay = n('delay', 0);
  r.loopMode = (ops.loop_mode ?? ops.loopmode)?.toLowerCase();
  r.loopStart = ops.loop_start !== undefined ? n('loop_start') : ops.loopstart !== undefined ? n('loopstart') : undefined;
  r.loopEnd = ops.loop_end !== undefined ? n('loop_end') : ops.loopend !== undefined ? n('loopend') : undefined;
  r.trigger = (ops.trigger ?? 'attack').toLowerCase();
  r.group = n('group', 0); r.offBy = n('off_by', n('offby', 0));
  r.offMode = (ops.off_mode ?? 'fast').toLowerCase(); r.offTime = n('off_time', 0.006); r.rtDecay = n('rt_decay', 0);
  r.ampRandom = n('amp_random', 0); r.pitchRandom = n('pitch_random', 0);
  for (const k in ENV) r.ampeg[k] = n(`ampeg_${k}`, r.ampeg[k]);
  r.ampeg.sustain = n('ampeg_sustain', 100) / 100;
  for (const k of ['delay', 'attack', 'hold', 'decay', 'sustain', 'release']) r.ampeg[`vel2${k}`] = n(`ampeg_vel2${k}`, 0);
  r.ampeg.vel2sustain /= 100;
  if (ops.xfin_lovel !== undefined || ops.xfout_lovel !== undefined) {
    r.xfVel = {
      in: ops.xfin_lovel !== undefined ? [n('xfin_lovel', 0), n('xfin_hivel', 0)] : undefined,
      out: ops.xfout_lovel !== undefined ? [n('xfout_lovel', 127), n('xfout_hivel', 127)] : undefined,
    };
  }
  if (ops.xfin_lokey !== undefined || ops.xfout_lokey !== undefined) {
    r.xfKey = {
      in: ops.xfin_lokey !== undefined ? [key(ops.xfin_lokey, 0), key(ops.xfin_hikey, 0)] : undefined,
      out: ops.xfout_lokey !== undefined ? [key(ops.xfout_lokey, 127), key(ops.xfout_hikey, 127)] : undefined,
    };
  }
  const xf = {};
  for (const k in ops) {
    let m;
    if ((m = /^(lo|hi)cc(\d+)$/.exec(k))) (r.cc[m[2]] ??= [0, 127])[m[1] === 'lo' ? 0 : 1] = n(k, 0);
    else if ((m = /^xf(in|out)_(lo|hi)cc(\d+)$/.exec(k))) {
      const e = xf[m[3]] ??= { cc: +m[3] };
      (e[m[1]] ??= [0, 0])[m[2] === 'lo' ? 0 : 1] = n(k, 0);
    }
  }
  r.xfCc = Object.values(xf);
  r.swLast = ops.sw_last !== undefined ? key(ops.sw_last) : undefined;
  r.swDefault = ops.sw_default !== undefined ? key(ops.sw_default) : undefined;
  r.swLokey = ops.sw_lokey !== undefined ? key(ops.sw_lokey) : undefined;
  r.swHikey = ops.sw_hikey !== undefined ? key(ops.sw_hikey) : undefined;
  return r;
}

/* SFZ text to { regions, control }. `include(path)` returns the text of an #include (or null); control holds
 *  { defaultPath, cc } (the <control> section's default_path and initial set_ccN values, set_hdccN's 0–1 scaled to 0–127). */
function parseSfz(text, { include = () => null } = {}) {
  const src = preprocess(text, include, new Map());
  const control = { defaultPath: '', cc: {} }, regions = [];
  let global = {}, master = {}, group = {};
  for (const s of parseSections(src)) {
    if (s.header === 'control') {
      for (const k in s.ops) {
        if (k === 'default_path') control.defaultPath = s.ops[k].replace(/\\/g, '/').replace(/([^/])$/, '$1/');
        else if (/^set_cc\d+$/.test(k)) control.cc[k.slice(6)] = num(s.ops[k], 0);
        else if (/^set_hdcc\d+$/.test(k)) control.cc[k.slice(8)] = num(s.ops[k], 0) * 127;
      }
    } else if (s.header === 'global') { global = s.ops; master = {}; group = {}; }
    else if (s.header === 'master') { master = s.ops; group = {}; }
    else if (s.header === 'group') group = s.ops;
    else if (s.header === 'region') regions.push(build({ ...global, ...master, ...group, ...s.ops }, control));
  }
  return { regions, control };
}

// The value most regions share (by JSON), to hoist it up to the instrument and leave only exceptions on regions.
function common(values) {
  const n = new Map();
  for (const v of values) { const k = JSON.stringify(v); n.set(k, (n.get(k) ?? 0) + 1); }
  let best = '', c = 0;
  for (const [k, x] of n) if (x > c) { best = k; c = x; }
  return best === '' ? undefined : JSON.parse(best);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const round = (x) => Math.round(x * 1e6) / 1e6;

/** SFZ text to a sampler instrument (see sampler.js). `include(path)` gives an #include's text; `info(sample)` gives what
 *  the caller knows of a sample file: { sr, loop: { start, end } (frames, from the file) }, to turn the SFZ's frame
 *  positions (loop points, offset, end) into seconds (without it a sample is taken as 44100 Hz). */
export function importSfz(text, { include, info = () => null, name = 'sfz' } = {}) {
  const { regions, control } = parseSfz(text, { include });
  const out = [], envs = [], envVels = [], tracks = [];
  for (const r of regions) {
    if (!r.sample || r.sample.startsWith('*')) continue;
    const f = info(r.sample), sr = f?.sr ?? 44100, o = { sample: r.sample };
    const ev = r.ampeg;
    const env = {}, envVel = {};
    for (const [k, v] of [['a', 'attack'], ['h', 'hold'], ['d', 'decay'], ['r', 'release']]) {
      if (ev[v]) env[k] = ev[v];
      if (ev[`vel2${v}`]) envVel[k] = ev[`vel2${v}`];
    }
    if (ev.sustain !== 1) env.s = ev.sustain;
    if (ev.vel2sustain) envVel.s = ev.vel2sustain;
    envs.push(env); envVels.push(envVel); tracks.push(r.ampVeltrack);
    o.env = env; o.envVel = envVel; o.velTrack = r.ampVeltrack;
    o.key = [Math.max(0, r.lokey), Math.min(127, r.hikey)];
    o.root = r.keycenter;
    if (r.lovel > 0 || r.hivel < 127) o.vel = [r.lovel, r.hivel];
    if (r.lorand > 0 || r.hirand < 1) o.rand = [r.lorand, r.hirand];
    if (r.seqLength > 1) o.rr = { length: r.seqLength, position: r.seqPosition };
    const tune = r.tune + r.transpose * 100;
    if (tune) o.tune = tune;
    if (r.pitchKeytrack !== 100) o.keytrack = r.pitchKeytrack;
    if (r.pitchVeltrack) o.velTune = r.pitchVeltrack;
    if (r.volume) o.gain = r.volume;
    if (r.pan) o.pan = r.pan;
    if (r.offset) o.offset = round(r.offset / sr);
    if (r.end !== undefined) o.end = round(r.end / sr);
    if (r.delay) o.delay = r.delay;
    // a loop: the SFZ's points, else the file's; loop points with no loop_mode mean looping
    const lm = { no_loop: 'none', one_shot: 'oneshot', loop_continuous: 'continuous', loop_sustain: 'sustain' };
    const ls = r.loopStart ?? f?.loop?.start, le = r.loopEnd ?? f?.loop?.end;
    const mode = lm[r.loopMode] ?? (ls !== undefined && le !== undefined ? 'continuous' : 'none');
    if (mode !== 'none') {
      o.loop = { mode };
      if ((mode === 'continuous' || mode === 'sustain') && ls !== undefined && le !== undefined) {
        o.loop.start = round(ls / sr); o.loop.end = round((le + 1) / sr);
      }
    }
    if (r.trigger === 'release' || r.trigger === 'release_key') o.trigger = 'release';
    if (r.rtDecay) o.rtDecay = r.rtDecay;
    if (r.group) o.group = r.group;
    if (r.offBy) o.offBy = r.offBy;
    if ((r.group || r.offBy) && r.offMode !== 'fast') o.offMode = r.offMode;
    if (r.offTime !== 0.006) o.offTime = r.offTime;
    if (r.pitchRandom) o.randTune = r.pitchRandom;
    if (r.ampRandom) o.randGain = r.ampRandom;
    if (r.xfVel) o.xfVel = r.xfVel;
    if (r.xfKey) o.xfKey = r.xfKey;
    if (Object.keys(r.cc).length) o.cc = r.cc;
    if (r.xfCc.length) o.xfCc = r.xfCc;
    if (r.swLast !== undefined || r.swLokey !== undefined) {
      o.sw = {};
      if (r.swLast !== undefined) o.sw.last = r.swLast;
      if (r.swDefault !== undefined) o.sw.default = r.swDefault;
      if (r.swLokey !== undefined) { o.sw.lo = r.swLokey; o.sw.hi = r.swHikey ?? r.swLokey; }
    }
    out.push(o);
  }
  // what most regions share goes on the instrument; a region keeps only where it differs
  const env = common(envs) ?? {}, envVel = common(envVels) ?? {}, velTrack = common(tracks) ?? 1;
  // (an override names every stage either side sets, so a region can also switch one off)
  const full = (x, y, dflt) => Object.fromEntries([...new Set([...Object.keys(x), ...Object.keys(y)])].map((k) => [k, x[k] ?? dflt[k] ?? 0]));
  out.forEach((o) => {
    if (same(o.env, env)) delete o.env; else o.env = full(o.env, env, { s: 1 });
    if (same(o.envVel, envVel)) delete o.envVel; else o.envVel = full(o.envVel, envVel, {});
    if (o.velTrack === velTrack) delete o.velTrack;
  });
  const inst = { kind: 'sampler', name };
  if (Object.keys(env).length) inst.env = env;
  if (Object.keys(envVel).length) inst.envVel = envVel;
  if (velTrack !== 1) inst.velTrack = velTrack;
  if (Object.keys(control.cc).length) inst.cc = control.cc;
  inst.regions = out;
  return inst;
}
