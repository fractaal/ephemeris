// A timeline's sound, rendered: the live engine the editor plays it with (nle/live.js: clips, notes played by their
// instruments, effects, faders), run from the start, so a render is sample for sample what playing it from the start in
// the editor is. ffmpeg only decodes the sources and writes the file.
//   node tools/mix.mjs projects/<name>/timelines/<id>.json out.wav
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isVisual, isNotes, clipEnd, isAutomated, notesClips } from '../nle/model.js';
import { createLive, instrumentKey, needsResolving, pluginKey, samplesPlayed, notesWith, PLUGIN_TAIL } from '../nle/live.js';
import { controlPoints } from '../nle/automation.js';
import { played } from '../engine/score.js';
import { scoreOf } from './score.mjs';
import { paramsOf } from '../nle/device.js';
import { resolveInstrument, instrumentPath } from './notes.mjs';
import { loadSample } from './instruments.mjs';
import { renderInstrument } from './plugins.mjs';

const SILENT = 10 ** (-96 / 20);   // where a render's tail is cut

const run = (cmd, args, input) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }), out = [], err = [];
  p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => err.push(d));
  p.on('close', (code) => (code ? reject(new Error(`${cmd} failed: ${Buffer.concat(err).toString().slice(-500)}`)) : resolve(Buffer.concat(out))));
  p.stdin.end(input);
});

/** Decodes a file to planar stereo float at `sr`: { channels: [L, R] }. */
export async function decode(file, sr) {
  const buf = await run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(sr), '-']);
  const x = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)), n = x.length >> 1;   // copy: aligned
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = x[2 * i]; R[i] = x[2 * i + 1]; }
  return { channels: [L, R] };
}

/** What a timeline plays, decoded (project dir: where its media/ is): { sr, media: id → { channels }, resolved: instrument
 *  key → { sampler, samples }, plugins: pluginKey → [L, R] (what each plugin instrument plays, rendered by its host: all
 *  at once, each in its own process), score: what the project's sound code does (tools/score.mjs: its motions played with
 *  the timeline's) }, at the first clip's file's own rate (else 48 kHz), so a timeline that only cuts one file
 *  plays its samples untouched. Its audio media are the clips' files and the impulse responses its reverbs name; its tracks'
 *  sampler instruments are resolved (their data, and each sample decoded once at the timeline's rate, as the editor's
 *  browser decodes them: a note at its sample's own pitch is then played as it was recorded, not resampled). */
export async function sources(tl, dir) {
  const score = await scoreOf(dir, tl);
  tl = played(tl, score);
  const heard = tl.tracks.filter((t) => !isVisual(t)), used = [...new Set(heard.flatMap((t) => t.clips.map((c) => c.media)))].filter((id) => tl.media[id]);
  const irs = [...heard, ...(tl.buses ?? []), tl.master ?? {}].flatMap((t) => (t.fx ?? []).map((e) => e.ir)).filter((id) => typeof id === 'string' && tl.media[id]);
  const src = (id) => path.resolve(dir, tl.media[id].src);
  const ids = [...new Set([...used.filter((id) => !isNotes(tl.media[id])), ...irs])].filter((id) => tl.media[id].src && fs.existsSync(src(id)));
  // (the rate of the first clip's file: an impulse response, or a timeline of notes alone, does not set it)
  const first = ids.find((id) => used.includes(id));
  const sr = first ? +execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', src(first)]).toString().trim() : 48000;
  const media = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await decode(src(id), sr)])));
  const resolved = {}, playing = heard.filter((t) => t.instrument && notesClips(t, tl.media).length);   // (the tracks whose instruments play notes)
  for (const t of playing.filter((x) => needsResolving(x.instrument))) {
    const spec = t.instrument, key = instrumentKey(spec), id = t.name || t.id;
    if (resolved[key]) continue;
    try {
      const r = await resolveInstrument(dir, spec), samples = {};
      // (a project's instrument may name a sample in the sound library: library/…)
      // (only the samples its notes can play: of a big program's recordings, the few its patterns hit)
      await Promise.all([...samplesPlayed(r.sampler, notesWith(tl, key))].map(async (n) => { try { samples[n] = await loadSample(/^library\//.test(n) ? instrumentPath(dir, n) : path.resolve(r.root, n), { sr }); } catch { /* missing: left out */ } }));
      resolved[key] = { sampler: r.sampler, samples };
    } catch (e) { console.warn(`mix: the instrument of "${id}" (${key}): ${e.message}`); }
  }
  const plugins = {};
  await Promise.all(playing.filter((t) => t.instrument.plugin).map(async (t) => {
    try { plugins[pluginKey(t.id)] = await renderInstrument(dir, tl, t, sr); } catch (e) { console.warn(`mix: the plugin of "${t.name || t.id}": ${e.message}`); }
  }));
  return { sr, media, resolved, plugins, score };
}

/** Renders a timeline from the start with what sources() gave: [L, R] at its rate, as long as its last clip and what
 *  still sounds after it (the tails of its instruments and effects, up to where it falls below −96 dBFS), or only until
 *  `until` (s: what is before it is as in the whole). progress(f), if given, is told how far it is (0 to 1) as it goes. */
export function render(tl, { sr, media, resolved, plugins = {}, score = null }, { until = Infinity, progress } = {}) {
  tl = played(tl, score);
  const live = createLive({ sr });
  for (const [id, m] of Object.entries(media)) live.addMedia(id, m.channels);
  for (const [key, spec] of Object.entries(resolved)) live.setResolved(key, spec);
  for (const [key, [pl, pr]] of Object.entries(plugins)) {
    live.setPluginSound(key, { read(L, R, at, n) { for (let i = Math.max(0, -at), e = Math.min(n, pl.length - at); i < e; i++) { L[i] += pl[at + i]; R[i] += pr[at + i]; } } });
  }
  const heard = { tracks: tl.tracks.filter((t) => !isVisual(t)), media: tl.media, master: tl.master, buses: tl.buses };
  // (each native instrument's automation, as the points its control() takes: worked out here, where lanes are read)
  const last = Math.max(0, ...heard.tracks.flatMap((t) => t.clips.map(clipEnd))), to = Math.ceil(Math.min(until, last + PLUGIN_TAIL) * sr);
  for (const t of heard.tracks) {
    const spec = t.instrument;
    if (spec && !spec.plugin && isAutomated(t, tl.media)) live.setControls(pluginKey(t.id), controlPoints(t, tl.media, paramsOf(spec, { sampler: resolved[instrumentKey(spec)]?.sampler }), sr, to));
  }
  live.set(heard); live.seek(0);
  const end = Math.max(0, ...heard.tracks.flatMap((t) => t.clips.map(clipEnd))), n = Math.min(Math.ceil((end ? end + live.tail() : 0) * sr), Math.ceil(until * sr));
  const L = new Float32Array(n), R = new Float32Array(n), bl = new Float32Array(128), br = new Float32Array(128);
  for (let i = 0; i < n; i += 128) {
    const m = Math.min(128, n - i);
    live.process(bl, br, m);
    L.set(bl.subarray(0, m), i); R.set(br.subarray(0, m), i);
    if (progress && (i & 0xffff) === 0) progress(i / n);   // (every 65536 samples)
  }
  let k = n;   // (a tail is how long a sound may ring at most; most die sooner)
  while (Number.isFinite(until) ? false : k > Math.ceil(end * sr) && Math.abs(L[k - 1]) < SILENT && Math.abs(R[k - 1]) < SILENT) k--;
  return [L.subarray(0, k), R.subarray(0, k)];
}
// what sources() gave, its sounds moved into shared memory (once: a worker reads them where they are)
function shared(x, seen = new Map()) {
  if (x instanceof Float32Array) {
    if (!seen.has(x)) { const s = new Float32Array(new SharedArrayBuffer(x.byteLength)); s.set(x); seen.set(x, s); }   // (a mono sample's two channels stay one)
    return seen.get(x);
  }
  if (Array.isArray(x)) return x.map((v) => shared(v, seen));
  return x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, shared(v, seen)])) : x;
}
/** Several timelines rendered from the same sources (sources() of one that has them all: a mix and its tracks soloed,
 *  say), each by render() on a worker thread, a few at once (half the machine): [[L, R], …] in their order, sample for
 *  sample what render() makes of each. progress(f), if given, is told how far they all are (0 to 1); then even one
 *  timeline is rendered on a worker, so that the thread asking is free to hear it (the studio's, which answers the
 *  editor meanwhile). */
export async function renderAll(tls, src, { progress, ...opts } = {}) {
  if (tls.length < 2 && !progress) return tls.map((tl) => render(tl, src, opts));
  const data = shared(src), out = new Array(tls.length), n = Math.min(tls.length, Math.ceil(os.availableParallelism() / 2));
  const workers = Array.from({ length: n }, () => new Worker(new URL('./mixworker.mjs', import.meta.url), { workerData: data }));
  const done = new Array(tls.length).fill(0);   // (how far each is)
  const told = (id, f) => { done[id] = f; progress?.(done.reduce((a, b) => a + b, 0) / tls.length); };
  let next = 0;
  try {
    await Promise.all(workers.map((w) => new Promise((resolve, reject) => {
      const take = () => { if (next >= tls.length) return resolve(); const id = next++; w.postMessage({ id, tl: tls[id], opts, progress: !!progress }); };
      w.on('message', ({ id, L, R, at }) => { if (at != null) return told(id, at); out[id] = [L, R]; told(id, 1); take(); });
      w.on('error', reject);
      w.on('exit', (code) => reject(new Error(`a render worker stopped (exit ${code})`)));
      take();
    })));
  } finally { await Promise.all(workers.map((w) => w.terminate())); }
  return out;
}

/** Stereo float at `sr` written to a WAV (32-bit float). */
export async function writeWav(L, R, sr, out) {
  const x = new Float32Array(L.length * 2);
  for (let i = 0; i < L.length; i++) { x[2 * i] = L[i]; x[2 * i + 1] = R[i]; }
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(sr), '-ac', '2', '-i', '-', '-c:a', 'pcm_f32le', out], Buffer.from(x.buffer));
}
/** A timeline's file rendered to a WAV (32-bit float); progress(f), if given, is told how far its render is (renderAll). */
export async function mixTimeline(file, out, { progress } = {}) {
  // (its media are the project's: media/…, beside timelines/, where its timelines are)
  const tl = JSON.parse(fs.readFileSync(file, 'utf8')), src = await sources(tl, path.resolve(path.dirname(file), '..'));
  const [[L, R]] = await renderAll([tl], src, { progress });
  await writeWav(L, R, src.sr, out);
  return { sampleRate: src.sr, duration: L.length / src.sr };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, out] = process.argv.slice(2);
  const r = await mixTimeline(file, out);
  console.log(`mixed ${file} → ${out} (${r.duration.toFixed(3)} s @ ${r.sampleRate} Hz)`);
}
