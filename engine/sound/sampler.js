// A sampler: notes in, recordings played back at the right pitch and level, out. It plays a sampler instrument, plain data
// that a project can save and an editor can edit (an SFZ library is imported into one by sfz.js; kit() makes a drum kit),
// over decoded sounds: pitch by windowed-sinc resampling (low-passed when pitching up so nothing folds back), velocity
// layers and round robins chosen from the notes alone, sustain loops, an amp envelope, release samples, chokes. Like every
// instrument here it is a function of the notes: the same notes, the same sound.
//
//   const piano = sampler(instrument, samples);   // samples: { [region.sample]: sound } (or a Map)
//   piano.render([{ t: 0, dur: 2, note: 60, vel: 0.8 }], { sr, length })  // → { sr, ch: [L, R] }
//
// The same thing live (the instrument interface of instrument.js), block by block, its notes at exact samples:
//   const live = createSampler(instrument, samples, { sr });
//   live.noteOn(60, 0.8, 17); live.noteOff(60, 90); live.process(L, R, 128);   // adds into L and R
// render() is this run over the whole of its notes, so there is one implementation.
//
// The instrument (JSON: no functions; times in seconds, levels in dB unless named; a field left out takes its default):
//   { kind: 'sampler', name,
//     gain, pan, tune,             // the whole instrument's level (dB), pan (−1…1) and tuning (cents), over each region's;
//                                  // they move the notes sounding when they change (control(): automation)
//     env: { a, h, d, s, r },      // amp envelope: attack, hold, decay (seconds), sustain (level 0–1, default 1), release
//     envVel: { a, h, d, s, r },   // what a full-velocity note adds to each stage (seconds; s a level): harder, faster
//     velTrack,                    // how much velocity sets level, 0–1 (default 1: level follows velocity squared)
//     cc: { 70: 100 },             // controllers' values until render's cc says otherwise (an SFZ's set_ccN)
//     regions: [{
//       sample,                    // the key into `samples`: a library-relative path or an id
//       key: [lo, hi], root,       // MIDI keys it answers to, and the key the recording is at (default 60)
//       vel: [lo, hi],             // velocity range in MIDI 0–127 (a note's vel 0–1 maps to 1–127)
//       rand: [lo, hi],            // plays when a number drawn per note (0–1) is inside: random layers
//       rr: { length, position },  // round robin: the region's turn comes every `length` matching notes, at `position`
//       tune,                      // cents (default 0)    keytrack: cents per key (100)    velTune: cents at full velocity
//       gain, pan,                 // dB, −1…1
//       offset, end, delay,        // seconds: start inside the sample, stop inside it, wait before sounding
//       loop: { mode, start, end },// mode 'none' | 'oneshot' (plays out, ignores the note's end) | 'continuous' | 'sustain'
//                                  // (loops while the note is held, then plays on); start/end in seconds, or the file's own
//       env, envVel, velTrack,     // this region's own, over the instrument's
//       trigger,                   // 'attack' (default) | 'release' (plays when the note ends; rtDecay dB/s of held time)
//       group, offBy,              // a hit in `group` cuts sounding voices whose offBy is it (offMode 'fast' | 'normal',
//                                  // offTime seconds for fast): a closed hat cutting an open one
//       randTune, randGain,        // random ± cents / dB per note
//       xfVel, xfKey,              // crossfades by velocity / key: { in: [lo, hi], out: [lo, hi] }
//       cc, xfCc,                  // gated by a controller: { 1: [lo, hi] }; crossfaded: [{ cc, in, out }] (values from render's cc)
//       sw: { last, default, lo, hi }  // keyswitches: plays only after key `last` (lo–hi are the switch keys; default is
//                                  // the one in force at the start)
//     }] }
import { SR, midi } from './core.js';

// The interpolation kernel: a Kaiser-windowed sinc, tabulated from 0 to `taps` zero crossings at RES steps each.
const RES = 512, KAISER = 7.5, kernels = new Map();
function besselI0(x) { let s = 1, t = 1; for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; }
function kernelTable(taps) {
  let K = kernels.get(taps);
  if (!K) {
    K = new Float64Array(taps * RES + 2);
    const norm = besselI0(KAISER);
    for (let i = 0; i < taps * RES; i++) {
      const x = i / RES, px = Math.PI * x, w = besselI0(KAISER * Math.sqrt(Math.max(0, 1 - (x / taps) ** 2))) / norm;
      K[i] = (x === 0 ? 1 : Math.sin(px) / px) * w;
    }
    kernels.set(taps, K);
  }
  return K;
}

// What a sound looks like to the voice loop: the arrays, whether both sides are the same, a loop it carries.
const prepared = new WeakMap();
function prepare(s) {
  let p = prepared.get(s);
  if (!p) {
    const [L, R] = s.ch;
    let mono = L === R;
    if (!mono && L.length === R.length) { mono = true; for (let i = 0; i < L.length; i++) if (L[i] !== R[i]) { mono = false; break; } }
    p = { L, R: mono ? L : R, n: L.length, mono, sr: s.sr, loop: s.loop };
    prepared.set(s, p);
  }
  return p;
}

const SHAPE_END = Math.exp(-6.9);
// A fall of 60 dB over `len`, easing to exactly 0 at the end (so a release ends without a step): 1 → 0 as x goes 0 → 1.
const fall = (x) => (Math.exp(-6.9 * x) - SHAPE_END) / (1 - SHAPE_END);
// The envelope's level `u` seconds into the voice (held), from its stages.
function heldLevel(e, u) {
  if (u < e.delay) return 0;
  u -= e.delay;
  if (u < e.attack) return u / e.attack;
  u -= e.attack;
  if (u < e.hold) return 1;
  u -= e.hold;
  if (u < e.decay) return e.sustain + (1 - e.sustain) * fall(u / e.decay);
  return e.sustain;
}
const level = (e, u) => (u < e.off ? heldLevel(e, u) : u >= e.off + e.release ? 0 : e.from * fall((u - e.off) / e.release));


// Whether one number (a velocity, key or controller) is inside a region's range, with its crossfades.
const randIn = (x, r) => x >= r.lorand && (x < r.hirand || r.hirand >= 1);
const inRange = (x, lo, hi) => x >= lo && x <= hi;
function fadeGain(x, f) {
  let g = 1;
  if (f.in && f.in[1] > f.in[0]) g *= Math.sqrt(clamp((x - f.in[0]) / (f.in[1] - f.in[0]), 0, 1));
  else if (f.in) g *= x >= f.in[0] ? 1 : 0;
  if (f.out && f.out[1] > f.out[0]) g *= Math.sqrt(clamp(1 - (x - f.out[0]) / (f.out[1] - f.out[0]), 0, 1));
  else if (f.out) g *= x <= f.out[1] ? 1 : 0;
  return g;
}

const LOOP = { none: 'no_loop', oneshot: 'one_shot', continuous: 'loop_continuous', sustain: 'loop_sustain' };
const pair = (x, d) => (x ? [x[0] ?? d[0], x[1] ?? d[1]] : d);

// A native region as the voice code reads it (seconds to frames of its own sample, defaults filled in).
function compile(inst, reg, p, idx) {
  const e = { ...inst.env, ...reg.env }, ev = { ...inst.envVel, ...reg.envVel };
  const lp = reg.loop ?? {}, fileLoop = p.loop;
  let mode = LOOP[lp.mode ?? 'none'], start, end;
  if (mode === 'loop_continuous' || mode === 'loop_sustain') {
    start = lp.start !== undefined ? Math.round(lp.start * p.sr) : fileLoop?.start;
    end = lp.end !== undefined ? Math.round(lp.end * p.sr) - 1 : fileLoop?.end;
    if (start === undefined || end === undefined || end <= start) mode = 'no_loop';
  }
  const key = pair(reg.key, [0, 127]), vel = pair(reg.vel, [0, 127]), rand = pair(reg.rand, [0, 1]);
  const stages = (a, st) => ({ attack: a.a ?? 0, hold: a.h ?? 0, decay: a.d ?? 0, sustain: a.s ?? st, release: a.r ?? 0 });
  return {
    sample: reg.sample, p, idx, seen: 0, lokey: key[0], hikey: key[1], keycenter: reg.root ?? 60, lovel: vel[0], hivel: vel[1],
    lorand: rand[0], hirand: rand[1], seqLength: reg.rr?.length ?? 1, seqPosition: reg.rr?.position ?? 1,
    tune: reg.tune ?? 0, transpose: 0, pitchKeytrack: reg.keytrack ?? 100, pitchVeltrack: reg.velTune ?? 0, volume: reg.gain ?? 0,
    pan: reg.pan ?? 0, ampVeltrack: reg.velTrack ?? inst.velTrack ?? 1, delay: reg.delay ?? 0,
    offset: Math.round((reg.offset ?? 0) * p.sr), end: reg.end !== undefined ? Math.round(reg.end * p.sr) : undefined,
    mode, ls: start, le: Math.min(end ?? 0, p.n - 1), trigger: reg.trigger ?? 'attack', rtDecay: reg.rtDecay ?? 0,
    ownEnv: reg.env ?? {}, ownVelTrack: reg.velTrack != null,   // (what the region sets itself: the instrument's controls leave it)
    group: reg.group ?? 0, offBy: reg.offBy ?? 0, offMode: reg.offMode ?? 'fast', offTime: reg.offTime ?? 0.006,
    ampRandom: reg.randGain ?? 0, pitchRandom: reg.randTune ?? 0,
    ampeg: { ...stages(e, 1), delay: 0, vel2attack: ev.a ?? 0, vel2hold: ev.h ?? 0, vel2decay: ev.d ?? 0,
      vel2sustain: ev.s ?? 0, vel2release: ev.r ?? 0, vel2delay: 0 },
    xfVel: reg.xfVel, xfKey: reg.xfKey, xfCc: reg.xfCc ?? [], cc: reg.cc ?? {}, ccKeys: Object.keys(reg.cc ?? {}),
    swLast: reg.sw?.last, swDefault: reg.sw?.default, swLokey: reg.sw?.lo, swHikey: reg.sw?.hi,
  };
}

// ── Voices ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// A voice is a plain object in a pool made once, its fields rewritten when a note starts, so playing allocates nothing.
// Everything a voice does is counted in its own frames (`age`) from the sample it starts on, never in the block's, which
// is what makes the sound the same however the stream is cut into blocks.

const BLK = 32;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function newVoice() {
  return { active: false, r: null, p: null, noteId: -1, delayLeft: 0, age: 0, pos: 0, ratio: 1, hs: 0, cut: 1,
    loop: false, ls: 0, le: 0, sustainLoop: false, looping: false, wrapped: false, endPos: 0, limit: Infinity,
    gl: 0, gr: 0, group: 0, offBy: 0, offAge: Infinity, ignoreOff: false,
    g: 0, g1: 0, d: 0, c: 0,
    env: { delay: 0, attack: 0, hold: 0, decay: 0, sustain: 1, release: 0, off: Infinity, from: 0 } };
}

// The voice's amp level `age` frames in, with the ramp down over the last 2 ms of a sample that is not looping.
function gainAt(v, age, pos, sr) {
  let g = level(v.env, age / sr);
  if (!v.loop) { const taper = 0.002 * v.p.sr; if (v.endPos - pos < taper) g *= Math.max(0, (v.endPos - pos) / taper); }
  return g;
}

// The frame (counted from its start) at which a voice has finished sounding: the envelope's end, or a sustain of 0 once
// its decay is through. A sample running out is noticed as the voice plays.
function setLimit(v, sr) {
  const e = v.env;
  let secs = Infinity;
  if (v.offAge !== Infinity) secs = e.off + e.release;
  if (e.sustain === 0) secs = Math.min(secs, e.attack + e.hold + e.decay);
  v.limit = secs === Infinity ? Infinity : Math.ceil(secs * sr);
}

// The voice's release starts `now` frames in, for `release` seconds. The level falls from wherever it is, and the ramp
// to the next 32-frame boundary is redrawn so the fall starts at once.
function release(v, now, rel, sr) {
  const e = v.env;
  v.offAge = now; e.off = now / sr; e.release = rel;
  e.from = heldLevel(e, e.off);
  setLimit(v, sr);
  if (v.c > 0 && now === v.age) {
    v.g1 = gainAt(v, v.age + v.c, v.pos + v.ratio * v.c, sr);
    v.d = (v.g1 - v.g) / v.c;
  }
}

// Plays `count` frames of a voice into L/R from frame `o0`. Returns how many it played (fewer if it ended). out: the
// instrument's own output gain on each side, a frame each (gl, gr: from frame 0 of the block), and its pitch bend (a ratio).
function playVoice(v, L, R, o0, count, kernel, taps, sr, out) {
  const { p, loop, ls, le, endPos } = v, { L: sL, R: sR, n: srcN, mono } = p, { gl: oL, gr: oR, bend } = out;
  const ratio = v.ratio * bend, cut = bend === 1 ? v.cut : ratio > 1 ? 1 / ratio : 1, hs = bend === 1 ? v.hs : ratio > 1 ? Math.ceil(taps * ratio) : taps;
  const kmax = taps * RES, period = loop ? le + 1 - ls : 0, loopEnd1 = loop ? le + 1 : 0;
  let { pos, age, g, g1, d, c, looping, wrapped } = v;
  let i = 0;
  if (v.delayLeft > 0) { i = Math.min(v.delayLeft, count); v.delayLeft -= i; }
  for (; i < count; i++) {
    if (age >= v.limit || (!loop && pos >= endPos)) { v.active = false; break; }
    if (c === 0) { g1 = gainAt(v, age + BLK, pos + ratio * BLK, sr); d = (g1 - g) / BLK; c = BLK; v.g1 = g1; }
    if (loop && v.sustainLoop && looping && age >= v.offAge) looping = false;
    if (looping && pos >= loopEnd1) { pos -= period; wrapped = true; }
    let aL = 0, aR = 0;
    if (g !== 0) {
      const i0 = Math.floor(pos), lo = i0 - hs + 1, hi = i0 + hs;
      if (ratio === 1 && pos === i0) {
        let idx = i0;
        if (looping && idx > le) idx -= period;
        if (idx >= 0 && idx < srcN) { aL = sL[idx]; aR = sR[idx]; }
      } else if (lo >= (looping && wrapped ? ls : 0) && hi <= (looping ? le : srcN - 1)) {
        for (let j = lo; j <= hi; j++) {
          const k = Math.abs(j - pos) * cut * RES, ki = k | 0;
          if (ki >= kmax) continue;
          const w = kernel[ki] + (kernel[ki + 1] - kernel[ki]) * (k - ki);
          aL += sL[j] * w; if (!mono) aR += sR[j] * w;
        }
        aL *= cut; aR *= cut;
      } else {
        for (let j = lo; j <= hi; j++) {
          let idx = j;
          if (looping) { if (idx > le) idx -= period; else if (wrapped && idx < ls) idx += period; }
          if (idx < 0 || idx >= srcN) continue;
          const k = Math.abs(j - pos) * cut * RES, ki = k | 0;
          if (ki >= kmax) continue;
          const w = kernel[ki] + (kernel[ki + 1] - kernel[ki]) * (k - ki);
          aL += sL[idx] * w; if (!mono) aR += sR[idx] * w;
        }
        aL *= cut; aR *= cut;
      }
      if (mono) aR = aL;
    }
    L[o0 + i] += aL * g * v.gl * oL[o0 + i]; R[o0 + i] += aR * g * v.gr * oR[o0 + i];
    pos += ratio; age++; c--;
    if (c === 0) g = g1; else g += d;
  }
  v.pos = pos; v.age = age; v.g = g; v.g1 = g1; v.d = d; v.c = c; v.looping = looping; v.wrapped = wrapped;
  return i;
}

// A number in [0, 1) for a note and a purpose: random layers and random tune/gain come from the note's number in the stream
// (not from a generator walked in order), so they cannot depend on when voices start or end.
function unit(seed, id, what) {
  let t = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(id + 1, 0xc2b2ae35) ^ Math.imul(what + 1, 0x27d4eb2f);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const EMPTY = [];
const EV_ON = 0, EV_OFF = 1, EV_CC = 2;

// An instrument's regions made ready: by key, release triggers apart, the keyswitch keys, and how long a note can ring on.
function build(instrument, samples) {
  const get = (k) => (samples instanceof Map ? samples.get(k) : samples?.[k]);
  const all = [], byKey = [], releases = [], switches = [], missing = [];
  let tail = 0;
  instrument.regions.forEach((reg, idx) => {
    const sound = get(reg.sample);
    if (!sound) { missing.push(reg.sample); return; }
    const p = prepare(sound), r = compile(instrument, reg, p, idx);
    all.push(r);
    if (r.swLokey !== undefined) switches.push([r.swLokey, r.swHikey ?? r.swLokey]);
    for (let k = Math.max(0, Math.ceil(r.lokey)); k <= Math.min(127, Math.floor(r.hikey)); k++) {
      const into = r.trigger === 'release' ? releases : byKey;
      (into[k] ??= []).push(r);
    }
    const e = r.ampeg, plays = (r.mode === 'one_shot' || r.trigger === 'release') ? 2 * (p.n / p.sr) : 0;
    tail = Math.max(tail, r.delay + Math.max(e.release + Math.max(0, e.vel2release), plays));
  });
  return { all, byKey, releases, switches, missing, tail, swDefault: all.find((r) => r.swDefault !== undefined)?.swDefault };
}

/** A live sampler: the instrument interface of instrument.js over a sampler instrument (the data above) and its decoded
 *  sounds. `sr`: the rate it plays at. `taps`: the interpolation's reach (12; 4 is fast and dull on high notes). Every
 *  note sounds: no voice is ever taken over. `voices`: how many are made up front (64), more made as notes need them.
 *  `seed` and `cc` as render()'s. Notes and controller changes are queued at their sample (`offset` into
 *  the next process() block) and take effect there, inside the block.
 *    noteOn(note, vel, offset)   noteOff(note, offset)   cc(number, value, offset)
 *    process(L, R, n)  adds n samples      set(instrument, samples)  a changed instrument: sounding voices carry on
 *    reset()  silence, and the notes counted from nothing again      tail  seconds a released note may still sound */
export function createSampler(instrument, samples, { sr = SR, taps = 12, voices = 64, seed = 1, cc = {} } = {}) {
  const kernel = kernelTable(taps);
  let b = build(instrument, samples), swLast = b.swDefault;
  const ccv = new Float64Array(128);
  const setCcDefaults = () => { ccv.fill(0); for (const [c, x] of Object.entries({ ...instrument.cc, ...cc })) ccv[c] = x; };
  setCcDefaults();
  const pool = Array.from({ length: voices }, newVoice);
  // the notes held, a pool like the voices' (a noteOff finds the oldest held on its key)
  const held = Array.from({ length: 256 }, () => ({ on: false, key: 0, note: 0, id: 0, vel127: 0, rand: 0, at: 0 }));
  let clock = 0, nextId = 0, busyUntil = 0;
  // the instrument's own level, pan and tune (its data's, or control()'s), and its envelope and velocity where control()
  // set them; the output gains eased to a new level a sample at a time, as a fader is (no click; the same however the
  // stream is cut into blocks)
  let ctl = {};
  const ease = 1 - Math.exp(-1 / (0.005 * sr));
  const own = () => ({ gain: instrument.gain ?? 0, pan: instrument.pan ?? 0, tune: instrument.tune ?? 0 });
  const sides = () => {
    const g = 10 ** ((ctl.gain ?? 0) / 20), pan = clamp(ctl.pan ?? 0, -1, 1), a = (pan + 1) * Math.PI / 4;
    return pan === 0 ? [g, g] : [g * Math.cos(a) * Math.SQRT2, g * Math.sin(a) * Math.SQRT2];   // (centred: each side exactly its gain)
  };
  ctl = own();
  let [outL, outR] = sides();
  const out = { gl: new Float32Array(512).fill(1), gr: new Float32Array(512).fill(1), bend: 1 };
  // the queue of what happens when, sorted by time; ties keep the order they were asked in
  let evCap = 1024, evT = new Float64Array(evCap), evK = new Int8Array(evCap), evA = new Float64Array(evCap), evB = new Float64Array(evCap);
  let evHead = 0, evLen = 0;

  function queue(time, kind, a, bb) {
    if (evLen === evCap) {
      const n = evCap * 2, T = new Float64Array(n), K = new Int8Array(n), A = new Float64Array(n), B = new Float64Array(n);
      T.set(evT); K.set(evK); A.set(evA); B.set(evB);
      evT = T; evK = K; evA = A; evB = B; evCap = n;
    }
    let i = evLen++;
    for (; i > evHead && evT[i - 1] > time; i--) { evT[i] = evT[i - 1]; evK[i] = evK[i - 1]; evA[i] = evA[i - 1]; evB[i] = evB[i - 1]; }
    evT[i] = time; evK[i] = kind; evA[i] = a; evB[i] = bb;
  }

  // a voice to start: a free one, else a new one (a note never cuts another short)
  function takeVoice() {
    for (let i = 0; i < pool.length; i++) if (!pool[i].active) return pool[i];
    const v = newVoice(); pool.push(v); return v;
  }

  // Starts a voice for region r. `held`: seconds the note was held (release triggers); `id`: the note's number in the stream.
  function spawn(r, note, vel127, id, noteId, heldSecs, isRelease) {
    let e = r.ampeg;
    const v01 = vel127 / 127, p = r.p, what = 1 + r.idx * 2;
    let gain = 10 ** (r.volume / 20);
    const vt = ctl.velTrack != null && !r.ownVelTrack ? ctl.velTrack : r.ampVeltrack;
    gain *= vt >= 0 ? 1 - vt + vt * v01 * v01 : 1 + vt + -vt * (1 - v01) * (1 - v01);
    if (r.xfVel) gain *= fadeGain(vel127, r.xfVel);
    if (r.xfKey) gain *= fadeGain(note, r.xfKey);
    for (let i = 0; i < r.xfCc.length; i++) gain *= fadeGain(ccv[r.xfCc[i].cc], r.xfCc[i]);
    if (r.ampRandom) gain *= 10 ** (((unit(seed, id, what) * 2 - 1) * r.ampRandom) / 20);
    if (isRelease && r.rtDecay) gain *= 10 ** (-(r.rtDecay * heldSecs) / 20);
    const cents = r.tune + (r.pitchRandom ? (unit(seed, id, what + 1) * 2 - 1) * r.pitchRandom : 0) + r.pitchVeltrack * v01;
    const semis = (note - r.keycenter) * (r.pitchKeytrack / 100) + r.transpose + cents / 100;
    const v = takeVoice(), env = v.env, ce = ctl.env;
    if (ce) e = { ...e, ...Object.fromEntries(Object.entries({ attack: 'a', hold: 'h', decay: 'd', sustain: 's', release: 'r' }).filter(([, k]) => ce[k] != null && r.ownEnv[k] == null).map(([n, k]) => [n, ce[k]])) };
    v.active = true; v.r = r; v.p = p; v.noteId = noteId;
    v.ratio = 2 ** (semis / 12) * (p.sr / sr);
    v.cut = v.ratio > 1 ? 1 / v.ratio : 1; v.hs = v.ratio > 1 ? Math.ceil(taps * v.ratio) : taps;
    v.loop = r.mode === 'loop_continuous' || r.mode === 'loop_sustain';
    v.ls = r.ls ?? 0; v.le = r.le; v.sustainLoop = r.mode === 'loop_sustain'; v.looping = v.loop; v.wrapped = false;
    v.pos = r.offset; v.endPos = r.end !== undefined ? Math.min(r.end, p.n) : p.n;
    v.delayLeft = Math.round(r.delay * sr); v.age = 0; v.c = 0;
    env.attack = Math.max(Math.max(0, e.attack + e.vel2attack * v01), 0.0005);
    env.hold = Math.max(0, e.hold + e.vel2hold * v01);
    env.decay = Math.max(0, e.decay + e.vel2decay * v01);
    env.sustain = clamp(e.sustain + e.vel2sustain * v01, 0, 1);
    env.release = Math.max(Math.max(0, e.release + e.vel2release * v01), 0.003);
    env.off = Infinity; env.from = 0; v.offAge = Infinity;
    // one-shots (and release samples) play out; others stop at the note's end
    v.ignoreOff = (r.mode === 'one_shot' || isRelease) && !v.loop;
    v.group = r.group; v.offBy = r.offBy;
    const pan = clamp(r.pan, -1, 1), a = (pan + 1) * Math.PI / 4;
    v.gl = gain * Math.cos(a) * Math.SQRT2; v.gr = gain * Math.sin(a) * Math.SQRT2;
    // a release sample that loops has no note to end it: it lets go when the held time was up
    if (isRelease && v.loop) release(v, Math.max(0, Math.round((heldSecs - r.delay) * sr)), env.release, sr);
    else setLimit(v, sr);
    v.g = gainAt(v, 0, v.pos, sr);
    return v;
  }

  // a hit in a group cuts the sounding voices that are cut by it: released now, fast unless the region says normal
  function choke(hit) {
    for (let i = 0; i < pool.length; i++) {
      const u = pool[i];
      if (!u.active || u === hit || u.offBy !== hit.group || u.delayLeft > 0 || u.offAge !== Infinity) continue;
      release(u, u.age, u.r.offMode === 'normal' ? u.env.release : Math.max(u.r.offTime, 0.003), sr);
    }
  }

  function noteOn(note, vel, at) {
    const key = Math.round(note), vel127 = clamp(Math.round((vel ?? 0.8) * 127), 1, 127);
    for (let i = 0; i < b.switches.length; i++) if (key >= b.switches[i][0] && key <= b.switches[i][1]) { swLast = key; return; }
    const id = nextId++, rand = unit(seed, id, 0);
    let slot = null;
    for (let i = 0; i < held.length; i++) {
      const h = held[i];
      if (!h.on) { slot = h; break; }
      if (!slot || h.id < slot.id) slot = h;
    }
    slot.on = true; slot.key = key; slot.note = note; slot.id = id; slot.vel127 = vel127; slot.rand = rand; slot.at = at;
    const list = b.byKey[key] ?? EMPTY;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r.swLast !== undefined && r.swLast !== swLast) continue;
      if (!inRange(vel127, r.lovel, r.hivel) || !randIn(rand, r)) continue;
      let gated = false;
      for (let k = 0; k < r.ccKeys.length; k++) if (!inRange(ccv[r.ccKeys[k]], r.cc[r.ccKeys[k]][0], r.cc[r.ccKeys[k]][1])) gated = true;
      if (gated) continue;
      if (r.seqLength > 1 && (r.seen++ % r.seqLength) + 1 !== r.seqPosition) continue;
      const v = spawn(r, note, vel127, id, id, 0, false);
      if (r.group) choke(v);
    }
  }

  function noteOff(note, at) {
    const key = Math.round(note);
    let n = null;
    for (let i = 0; i < held.length; i++) if (held[i].on && held[i].key === key && (!n || held[i].id < n.id)) n = held[i];
    if (!n) return;
    n.on = false;
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i];
      if (v.active && v.noteId === n.id && !v.ignoreOff && v.offAge === Infinity) release(v, v.delayLeft > 0 ? 0 : v.age, v.env.release, sr);
    }
    const list = b.releases[key] ?? EMPTY, secs = (at - n.at) / sr;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!inRange(n.vel127, r.lovel, r.hivel) || !randIn(n.rand, r)) continue;
      if (r.seqLength > 1 && (r.seen++ % r.seqLength) + 1 !== r.seqPosition) continue;
      spawn(r, n.note, n.vel127, n.id, -1, secs, true);
    }
  }

  function apply(i) {
    if (evK[i] === EV_ON) noteOn(evA[i], evB[i], evT[i]);
    else if (evK[i] === EV_OFF) noteOff(evA[i], evT[i]);
    else ccv[evA[i]] = evB[i];
  }

  function process(L, R, n) {
    const end = clock + n;
    let at = clock;
    // (the instrument's output gains a frame each, eased from where they were to where control() set them)
    const [tL, tR] = sides();
    if (out.gl.length < n) { out.gl = new Float32Array(n); out.gr = new Float32Array(n); }
    for (let i = 0; i < n; i++) { if (outL !== tL) outL += (tL - outL) * ease; if (outR !== tR) outR += (tR - outR) * ease; out.gl[i] = outL; out.gr[i] = outR; }
    out.bend = 2 ** ((ctl.tune ?? 0) / 1200);
    while (at < end) {
      while (evHead < evLen && evT[evHead] <= at) apply(evHead++);
      let stop = evHead < evLen ? Math.min(end, evT[evHead]) : end;
      const count = stop - at, o0 = at - clock;
      for (let i = 0; i < pool.length; i++) {
        const v = pool[i];
        if (!v.active) continue;
        const done = playVoice(v, L, R, o0, count, kernel, taps, sr, out);
        if (at + done > busyUntil) busyUntil = at + done;
      }
      at = stop;
    }
    if (evHead === evLen) evHead = evLen = 0;
    clock = end;
  }

  return {
    noteOn(note, vel, offset = 0) { queue(clock + offset, EV_ON, note, vel ?? 0.8); },
    noteOff(note, offset = 0) { queue(clock + offset, EV_OFF, note, 0); },
    cc(number, value, offset = 0) { queue(clock + offset, EV_CC, number, value); },
    process,
    /** The instrument's own params as they move (automation): { gain, pan, tune, 'env.a'…'env.r', velTrack }, each in its
     *  units. Level, pan and tune move the notes sounding (from this block, eased over it); the envelope and velocity,
     *  the notes from now on. */
    control(values) {
      for (const [k, x] of Object.entries(values)) {
        if (k.startsWith('env.')) (ctl.env ??= {})[k.slice(4)] = x;
        else ctl[k] = x;
      }
    },
    set(next, nextSamples = samples) {
      const old = b.all.length, was = own();
      instrument = next; samples = nextSamples; b = build(next, nextSamples);
      for (const [k, x] of Object.entries(own())) if (ctl[k] === was[k]) ctl[k] = x;   // (its own, changed; what control() moves stays)
      if (b.all.length !== old) swLast = b.swDefault;
      for (const k of Object.keys(next.cc ?? {})) ccv[k] = next.cc[k];
    },
    reset() {
      [outL, outR] = sides();
      for (const v of pool) v.active = false;
      for (const h of held) h.on = false;
      evHead = evLen = 0; clock = nextId = busyUntil = 0;
      for (const r of b.all) r.seen = 0;
      swLast = b.swDefault; setCcDefaults();
    },
    get tail() { return b.tail; },
    get missing() { return b.missing; },
    /** voices sounding now, and the sample after the last one that sounded (what the offline render trims to) */
    get active() { let n = 0; for (const v of pool) if (v.active) n++; return n; },
    get pending() { return evLen - evHead; },
    get busyUntil() { return busyUntil; },
    get now() { return clock; },
  };
}

/** A playable instrument from a sampler instrument (the data above) and the decoded sounds its regions name (`samples`:
 *  an object or a Map keyed by region.sample; a sound may carry `loop: { start, end }` in frames, from its file, for
 *  regions that loop without saying where). `taps`: the interpolation's reach on each side (12: clean; 4 is fast and dull
 *  on high notes). Regions whose sample is not in `samples` are left out (listed in `.missing`). Its render() is the live
 *  sampler run over the whole of the notes: one implementation. */
export function sampler(instrument, samples, { taps = 12 } = {}) {
  const missing = build(instrument, samples).missing, CHUNK = 8192;
  function render(notes, { sr = SR, length, seed = 1, cc = {} } = {}) {
    const live = createSampler(instrument, samples, { sr, taps, seed, cc });
    // each note is a start and an end, in order of time; a note's end never comes before its start
    const events = [];
    notes.forEach((nt, i) => {
      const on = Math.round(nt.t * sr), off = Math.max(on, Math.round((nt.t + Math.max(0, nt.dur ?? 0)) * sr));
      events.push({ f: on, k: 1, i, on: true, nt }, { f: off, k: off === on ? 2 : 0, i, on: false, nt });
    });
    events.sort((a, b) => a.f - b.f || a.k - b.k || a.i - b.i);
    for (const e of events) {
      if (e.on) live.noteOn(e.nt.note, e.nt.vel ?? 0.8, e.f); else live.noteOff(e.nt.note, e.f);
    }
    const want = length !== undefined ? Math.max(0, Math.ceil(length * sr)) : Infinity, chunks = [];
    let done = 0;
    while (done < want && (live.pending > 0 || live.active > 0)) {
      const m = Math.min(CHUNK, want - done), L = new Float32Array(m), R = new Float32Array(m);
      live.process(L, R, m); chunks.push([L, R]); done += m;
    }
    const n = length !== undefined ? want : live.busyUntil, out = { sr, ch: [new Float32Array(n), new Float32Array(n)] };
    let at = 0;
    for (const [L, R] of chunks) {
      const m = Math.min(L.length, n - at);
      if (m > 0) { out.ch[0].set(L.subarray(0, m), at); out.ch[1].set(R.subarray(0, m), at); }
      at += L.length;
    }
    return out;
  }
  return { render, instrument, missing };
}

/** Spreads samples over consecutive notes from `from` (a number or a name): { 36: a, 37: b, … } for kit(). */
export function spread(samples, from = 36) {
  const k0 = typeof from === 'string' ? midi(from) : from, map = {};
  samples.forEach((s, i) => { map[k0 + i] = s; });
  return map;
}

/** A drum kit as a sampler instrument. `map`: note (number or name) → a sample (its key into `samples`), a list of them
 *  (round robins, taken in turn), or { samples | sample, gain (dB), pan, tune, group, offBy (a hit in `group` cuts voices
 *  whose offBy is it, as a closed hat cuts an open one), velTrack (0–1, default 1), pitched + root (play across the keys
 *  from `root` instead of one-shot on one) }. */
export function kit(map, { name = 'kit' } = {}) {
  const regions = [];
  for (const [k, entry] of Object.entries(map)) {
    const note = /^-?\d+$/.test(k) ? +k : midi(k);
    const e = typeof entry === 'string' ? { samples: [entry] } : Array.isArray(entry) ? { samples: entry } : entry;
    const list = e.samples ?? [e.sample];
    list.forEach((sample, i) => {
      const r = { sample, key: e.pitched ? [0, 127] : [note, note], root: e.pitched ? (e.root ?? note) : note };
      if (!e.pitched) { r.keytrack = 0; r.loop = { mode: 'oneshot' }; }
      if (list.length > 1) r.rr = { length: list.length, position: i + 1 };
      for (const f of ['gain', 'pan', 'tune', 'group', 'offBy', 'velTrack']) if (e[f]) r[f] = e[f];
      regions.push(r);
    });
  }
  return { kind: 'sampler', name, env: { r: 0.02 }, regions };
}
