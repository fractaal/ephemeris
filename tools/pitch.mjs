// Pitch by numbers: the notes a recording plays, so an agent (who cannot listen) can tell what a sung phrase, a loop, a
// sample or a reference's line is — by Basic Pitch (Bittner et al., "A Lightweight Instrument-Agnostic Model for
// Polyphonic Note Transcription and Multipitch Estimation", ICASSP 2022; tools/models): polyphonic, any instrument, each
// note's start, end, pitch and how strongly it sounds. Where a note sounds alone, its tuning to the cent and how steadily
// it holds it, by YIN over its middle (de Cheveigné and Kawahara, JASA 2002): a sampler zone's root and tune, a vocal
// chop's slice. The note-making is Basic Pitch's own (basic_pitch 0.4.0, note_creation.py), here in JS.
//
//   node tools/pitch.mjs <file or folder> [...] [--from s] [--to s] [--json]
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decode, soundFiles } from './sound.mjs';
import { model } from './models.mjs';

// Basic Pitch's constants (basic_pitch/constants.py, inference.py, note_creation.py)
const SR = 22050, HOP = 256, WIN = 2 * SR - HOP, FRAMES = 172, OVERLAP_FRAMES = 30, OVERLAP = OVERLAP_FRAMES * HOP, STEP = WIN - OVERLAP;
const KEYS = 88, MIDI_OFFSET = 21, ENERGY_TOL = 11, ALIGN = 0.0018;
const OUT = { note: 'StatefulPartitionedCall:1', onset: 'StatefulPartitionedCall:2' };
const YIN_SR = 44100;   // (tuning: finer lags than the model's rate gives a high note)
// the semitones of a note's harmonics above it (2nd–8th): what the model may also hear as notes while it sounds
const HARMONICS = new Set([2, 3, 4, 5, 6, 7, 8].map((h) => Math.round(12 * Math.log2(h))));

let session = null;
/** The model's note and onset activations of mono audio at SR: { note, onset } (Float32Array, frames × 88), frames. */
async function activations(x) {
  session ??= await model('basic-pitch');
  const padded = new Float32Array(OVERLAP / 2 + x.length); padded.set(x, OVERLAP / 2);
  const windows = Math.ceil(padded.length / STEP), keep = FRAMES - OVERLAP_FRAMES, half = OVERLAP_FRAMES / 2;
  const frames = Math.floor((x.length / STEP) * keep);
  const note = new Float32Array(windows * keep * KEYS), onset = new Float32Array(windows * keep * KEYS);
  for (let w0 = 0; w0 < windows; w0 += 16) {
    const n = Math.min(16, windows - w0), input = new Float32Array(n * WIN);
    for (let w = 0; w < n; w++) input.set(padded.subarray((w0 + w) * STEP, (w0 + w) * STEP + WIN), w * WIN);
    const out = await session.run({ 'serving_default_input_2:0': { data: input, dims: [n, WIN, 1] } });
    // (each window's frames, the half of its overlap at either end left out)
    for (const [k, dst] of [['note', note], ['onset', onset]]) {
      const a = out[OUT[k]].data;
      for (let w = 0; w < n; w++) dst.set(a.subarray((w * FRAMES + half) * KEYS, (w * FRAMES + FRAMES - half) * KEYS), (w0 + w) * keep * KEYS);
    }
  }
  return { note: note.subarray(0, frames * KEYS), onset: onset.subarray(0, frames * KEYS), frames };
}
// a frame's time (Basic Pitch's model_frames_to_time, its alignment as it is)
const frameTime = (i) => (i * HOP) / SR - Math.floor(i / FRAMES) * ((HOP / SR) * (FRAMES - WIN / HOP) + ALIGN);

/** Basic Pitch's notes from its activations (output_to_notes_polyphonic, with inferred onsets and its melodia trick):
 *  [{ s: first frame, e: end frame, note, amp }]. */
function notesOf({ note: frames, onset, frames: T }, { onsetThresh, frameThresh, minFrames, lo = 0, hi = KEYS }) {
  const at = (t, f) => t * KEYS + f;
  for (let t = 0; t < T; t++) for (let f = 0; f < KEYS; f++) if (f < lo || f >= hi) { frames[at(t, f)] = 0; onset[at(t, f)] = 0; }
  // onsets inferred from the frames' rises (two frames back), scaled to the onsets' own peak, where they are higher
  const diff = new Float32Array(T * KEYS);
  let maxOn = 0, maxDiff = 0;
  for (let t = 0; t < T; t++) for (let f = 0; f < KEYS; f++) {
    const v = frames[at(t, f)], d = t < 2 ? 0 : Math.max(0, Math.min(v - frames[at(t - 1, f)], v - frames[at(t - 2, f)]));
    diff[at(t, f)] = d; if (d > maxDiff) maxDiff = d; if (onset[at(t, f)] > maxOn) maxOn = onset[at(t, f)];
  }
  const on = new Float32Array(T * KEYS);
  for (let i = 0; i < on.length; i++) on[i] = Math.max(onset[i], maxDiff ? (maxOn * diff[i]) / maxDiff : 0);
  // each onset peak over the threshold, latest first, held while the frames stay on (a gap of up to ENERGY_TOL frames)
  const peaks = [];
  for (let t = 1; t < T - 1; t++) for (let f = 0; f < KEYS; f++) { const v = on[at(t, f)]; if (v >= onsetThresh && v > on[at(t - 1, f)] && v > on[at(t + 1, f)]) peaks.push([t, f]); }
  peaks.reverse();
  const rem = Float32Array.from(frames), notes = [];
  const clear = (t, f) => { rem[at(t, f)] = 0; if (f < KEYS - 1) rem[at(t, f + 1)] = 0; if (f > 0) rem[at(t, f - 1)] = 0; };
  const mean = (s, e, f) => { let a = 0; for (let t = s; t < e; t++) a += frames[at(t, f)]; return a / (e - s); };
  for (const [s, f] of peaks) {
    if (s >= T - 1) continue;
    let i = s + 1, k = 0;
    while (i < T - 1 && k < ENERGY_TOL) { k = rem[at(i, f)] < frameThresh ? k + 1 : 0; i++; }
    i -= k;
    if (i - s <= minFrames) continue;
    for (let t = s; t < i; t++) clear(t, f);
    notes.push({ s, e: i, note: f + MIDI_OFFSET, amp: mean(s, i, f) });
  }
  // the melodia trick: what energy is left, loudest first, as notes too (each cell visited in the order np.argmax would
  // reach it: its values only ever fall to 0, so the highest left is the highest of those not yet cleared)
  const order = [];
  for (let i = 0; i < rem.length; i++) if (rem[i] > frameThresh) order.push(i);
  order.sort((a, b) => rem[b] - rem[a] || a - b);
  for (const c of order) {
    if (rem[c] <= frameThresh) continue;
    const mid = Math.floor(c / KEYS), f = c % KEYS;
    rem[c] = 0;
    let i = mid + 1, k = 0;
    while (i < T - 1 && k < ENERGY_TOL) { k = rem[at(i, f)] < frameThresh ? k + 1 : 0; clear(i, f); i++; }
    const e = i - 1 - k;
    i = mid - 1; k = 0;
    while (i > 0 && k < ENERGY_TOL) { k = rem[at(i, f)] < frameThresh ? k + 1 : 0; clear(i, f); i--; }
    const s = i + 1 + k;
    if (e - s <= minFrames) continue;
    notes.push({ s, e, note: f + MIDI_OFFSET, amp: mean(s, e, f) });
  }
  return notes;
}

/** The fundamental near `hz` (within a semitone) in x from i0, by YIN: Hz, or null where it is not periodic there. */
function yin(x, i0, hz) {
  const P = YIN_SR / hz, t0 = Math.max(2, Math.floor(P / 2 ** (1 / 12))), t1 = Math.ceil(P * 2 ** (1 / 12)) + 1;
  const W = Math.min(4096, Math.max(512, 2 * t1));
  if (i0 + W + t1 + 1 > x.length) return null;
  const d = new Float64Array(t1 + 2);
  for (let tau = 1; tau <= t1 + 1; tau++) { let s = 0; for (let j = 0; j < W; j++) { const v = x[i0 + j] - x[i0 + j + tau]; s += v * v; } d[tau] = s; }
  // cumulative mean normalized difference; its lowest dip in the semitone, between lags by a parabola
  let sum = 0, best = -1, bv = Infinity;
  const cm = new Float64Array(t1 + 2); cm[0] = 1;
  for (let tau = 1; tau <= t1 + 1; tau++) { sum += d[tau]; cm[tau] = sum ? (d[tau] * tau) / sum : 1; }
  for (let tau = t0; tau <= t1; tau++) if (cm[tau] < bv) { bv = cm[tau]; best = tau; }
  if (best < 0 || bv > 0.3) return null;
  const a = cm[best - 1], b = cm[best], c = cm[best + 1], den = a - 2 * b + c;
  return YIN_SR / (best + (den > 0 ? (0.5 * (a - c)) / den : 0));
}
/** A note's tuning where it sounds alone: its cents from the equal-tempered note (A4 = 440 Hz) over its middle half, and
 *  how far they stray (the median distance from that), or null where YIN does not find it periodic. */
function tuning(x, t, dur, note) {
  const hz = 440 * 2 ** ((note - 69) / 12), a = Math.round((t + dur * 0.25) * YIN_SR), b = Math.round((t + dur * 0.75) * YIN_SR);
  const step = Math.max(256, Math.floor((b - a) / 8)), cents = [];
  for (let i = a; i < b; i += step) { const f = yin(x, i, hz); if (f) cents.push(1200 * Math.log2(f / hz)); }
  if (cents.length < Math.max(1, Math.ceil(((b - a) / step) * 0.5))) return null;
  const med = (v) => [...v].sort((p, q) => p - q)[v.length >> 1], c = med(cents);
  return { cents: Math.round(c), wobble: Math.round(med(cents.map((v) => Math.abs(v - c)))) };
}
const decodeAt = (file, sr) => new Promise((resolve, reject) => {
  const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-']), out = [];
  p.stdout.on('data', (d) => out.push(d));
  p.on('error', (e) => reject(new Error(`ffmpeg could not start (${e.code ?? e.message})`)));
  p.on('close', (code) => { if (code) return reject(new Error(`ffmpeg could not decode ${file}`)); const b = Buffer.concat(out); resolve(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))); });
});

/**
 * The notes in a sound file (from `from` to `to`, s): { file, duration, notes: [{ t, dur (s, in the file's own time),
 * note (MIDI), vel (how strongly the model hears it, 0–1), db (its loudness: RMS dBFS over it), alone (no other note
 * over a fifth of it but its own harmonics, which the model may hear as notes too), cents and wobble (where it is alone and periodic: its tuning and how far it strays, cents) }] },
 * in time order. onset and frame: Basic Pitch's thresholds (0.5, 0.3: lower finds more, quieter notes); minLength (s).
 */
export async function pitch(file, { from = 0, to = Infinity, onset = 0.5, frame = 0.3, minLength = 0.1277, minNote = null, maxNote = null } = {}) {
  const all = await decode(file), duration = all.length / SR;
  const i0 = Math.max(0, Math.round(from * SR)), i1 = Math.min(all.length, Math.round(Math.min(to, duration) * SR));
  const act = await activations(all.subarray(i0, i1));
  const found = notesOf(act, { onsetThresh: onset, frameThresh: frame, minFrames: Math.round((minLength * SR) / HOP), lo: minNote != null ? minNote - MIDI_OFFSET : 0, hi: maxNote != null ? maxNote - MIDI_OFFSET + 1 : KEYS });
  const fine = await decodeAt(file, YIN_SR), off = i0 / SR;
  const notes = found.map((n) => { const t = off + frameTime(n.s); return { t, dur: Math.max(1 / SR, off + frameTime(n.e) - t), note: n.note, vel: n.amp }; }).sort((a, b) => a.t - b.t || a.note - b.note);
  for (const n of notes) {
    let s = 0; const a = Math.round(n.t * YIN_SR), b = Math.min(fine.length, Math.round((n.t + n.dur) * YIN_SR));
    for (let i = a; i < b; i++) s += fine[i] * fine[i];
    n.db = Math.round(10 * Math.log10(s / Math.max(1, b - a) + 1e-12) * 10) / 10;
    n.alone = !notes.some((o) => o !== n && !HARMONICS.has(o.note - n.note) && Math.min(o.t + o.dur, n.t + n.dur) - Math.max(o.t, n.t) > 0.2 * n.dur);
    if (n.alone) Object.assign(n, tuning(fine, n.t, n.dur, n.note) ?? {});
  }
  return { file, duration, from: off, to: i1 / SR, notes };
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const name = (n) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
/** The notes as a table, a row each: start, end, note, velocity, loudness, and tuning where it sounds alone. */
export function table(notes) {
  return ['  start     end  note   vel    dB  cents  strays', ...notes.map((n) => `${n.t.toFixed(3).padStart(7)} ${(n.t + n.dur).toFixed(3).padStart(7)}  ${name(n.note).padEnd(4)} ${n.vel.toFixed(2).padStart(5)} ${n.db.toFixed(1).padStart(5)}  ${n.cents != null ? `${n.cents >= 0 ? '+' : ''}${n.cents}`.padStart(5) : (n.alone ? '    ?' : '    -')}  ${n.wobble != null ? `±${n.wobble}` : ''}`)].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? +args[i + 1] : undefined; };
  const inputs = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--') && fs.existsSync(a));
  if (!inputs.length) { console.log('node tools/pitch.mjs <file or folder> [...] [--from s] [--to s] [--json]'); process.exit(1); }
  for (const f of soundFiles(inputs)) {
    const r = await pitch(f, { from: opt('from'), to: opt('to') });
    if (args.includes('--json')) console.log(JSON.stringify(r));
    else console.log(`${f}  ${r.from.toFixed(2)}–${r.to.toFixed(2)} s: ${r.notes.length} notes (cents where one sounds alone: ? not periodic there, - not alone)\n${table(r.notes)}\n`);
  }
  process.exit(0);   // (the model's threads)
}
