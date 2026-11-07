// Ears by numbers: measures sound files so an agent (who cannot listen) can tell what a sound is like before using it
// in a film, and where each sound a timeline plays lands (placed) — how heavy (sub, low, high, air, centroid), what texture (noisy, tonal, rising or falling), and what shape
// (attack, where it peaks, how it decays or sustains) — and names it in plain words (bassy, tinny, airy, tonal,
// punchy, hit, swell, swoosh, bed, click…). See .agents/skills/sound for how to choose and place sounds with it.
//
//   node tools/sound.mjs <file or folder> [...]            a table, one row per sound (folders: every sound inside)
//   node tools/sound.mjs <...> --tags bassy,hit            only the sounds with all these tags
//   node tools/sound.mjs <...> --max 1.5 --min 0.2         by duration (s)
//   node tools/sound.mjs <...> --sort low|centroid|...     sorted by a measure (descending; prefix - for ascending)
//   node tools/sound.mjs <...> --json                      every measure, for scripts
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SR = 22050, N = 2048, HOP = 512;
const AUDIO = /\.(wav|aif|aiff|mp3|ogg|flac|m4a)$/i;

/** Decodes a file to mono float at SR. */
export const decode = (file) => new Promise((resolve, reject) => {
  const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-']), out = [];
  p.stdout.on('data', (d) => out.push(d));
  p.on('error', (e) => reject(new Error(`ffmpeg could not start (${e.code ?? e.message}): the app brings its own; a checkout needs one on the PATH`)));
  p.on('close', (code) => {
    if (code) return reject(new Error(`ffmpeg could not decode ${file}`));
    const b = Buffer.concat(out);
    resolve(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
  });
});

/** In-place radix-2 FFT of (re, im), length a power of two. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));

/** Every measure of one sound. */
export async function measure(file) {
  const x = await decode(file), dur = x.length / SR;
  // the envelope, 10 ms windows
  const w = Math.round(SR / 100), env = [];
  for (let i = 0; i + w <= x.length; i += w) { let s = 0; for (let k = 0; k < w; k++) s += x[i + k] * x[i + k]; env.push(Math.sqrt(s / w)); }
  if (!env.length) env.push(0);
  const peakI = env.indexOf(Math.max(...env)), peakDb = db(env[peakI]);
  const onI = env.findIndex((e) => db(e) > peakDb - 30), endI = env.length - 1 - [...env].reverse().findIndex((e) => db(e) > peakDb - 30);
  const tailI = env.findIndex((e, i) => i > peakI && db(e) < peakDb - 20);
  const near = env.filter((e) => db(e) > peakDb - 10).length;
  let sum = 0, peakSample = 0; for (const v of x) { sum += v * v; peakSample = Math.max(peakSample, Math.abs(v)); }
  const rms = Math.sqrt(sum / Math.max(1, x.length));
  // the spectrum, frame by frame, weighted by each frame's energy
  const bin = SR / N, han = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  let tot = 0, sub = 0, low = 0, mid = 0, high = 0, air = 0, cen = 0, flat = 0, peaky = 0, wsum = 0, tonalSum = 0, tonalW = 0;
  const cents = [];
  for (let i = 0; i + N <= Math.max(x.length, N); i += HOP) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 0; k < N; k++) re[k] = (x[i + k] ?? 0) * han[k];
    fft(re, im);
    let e = 0, c = 0, logs = 0, mx = 0, s60 = 0, s150 = 0, s4k = 0, s8k = 0, m = 0, bandMax = 0, bandSum = 0, bandN = 0;
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k], f = k * bin;
      e += p; c += p * f; logs += Math.log(p + 1e-12); mx = Math.max(mx, p);
      if (f < 60) s60 += p; if (f < 150) s150 += p; if (f >= 150 && f < 4000) m += p; if (f >= 4000) s4k += p; if (f >= 8000) s8k += p;
      if (f >= 250 && f < 10000) { bandMax = Math.max(bandMax, p); bandSum += p; bandN++; }   // tonality, above the bass
    }
    if (e < 1e-9) continue;
    const K = N / 2 - 1, gm = Math.exp(logs / K), am = e / K;
    tot += e; sub += s60; low += s150; mid += m; high += s4k; air += s8k; cen += c; wsum += e;
    flat += (gm / am) * e; peaky += (mx / am) * e;
    if (bandSum > 1e-9) { tonalSum += (bandMax / (bandSum / bandN)) * bandSum; tonalW += bandSum; }
    cents.push([i / SR, c / e, e]);
  }
  const W = Math.max(wsum, 1e-12), T = Math.max(tot, 1e-12);
  // which way its pitch moves: the slope of the centroid over its loud part (Hz per second)
  const loud = cents.filter(([, , e]) => e > wsum / Math.max(1, cents.length) * 0.3);
  let slope = 0;
  if (loud.length > 3) {
    const mt = loud.reduce((a, [t]) => a + t, 0) / loud.length, mc = loud.reduce((a, [, c]) => a + c, 0) / loud.length;
    let num = 0, den = 0; for (const [t, c] of loud) { num += (t - mt) * (c - mc); den += (t - mt) ** 2; }
    slope = den ? num / den : 0;
  }
  const M = {
    file, dur: +dur.toFixed(2), onset: +(onI / 100).toFixed(2), peakAt: +(peakI / 100).toFixed(2), attack: +((peakI - onI) / 100).toFixed(2),
    decay: tailI > 0 ? +((tailI - peakI) / 100).toFixed(2) : +((endI - peakI) / 100).toFixed(2), sustain: +(near / env.length).toFixed(2),
    crest: +(db(peakSample) - db(rms)).toFixed(1), peakDb: +db(peakSample).toFixed(1),
    sub: +(sub / T).toFixed(2), low: +(low / T).toFixed(2), mid: +(mid / T).toFixed(2), high: +(high / T).toFixed(2), air: +(air / T).toFixed(2),
    centroid: Math.round(cen / W), flatness: +(flat / W).toFixed(2), tonal: +db(Math.sqrt(tonalW ? tonalSum / tonalW : 1)).toFixed(1), pitch: Math.round(slope),
  };
  M.tags = tags(M);
  return M;
}

/**
 * The sounds a timeline plays (tl, its project in dir), each where it lands in the film: its onset and its peak in film
 * time (its trim and speed followed; a peak trimmed away said so), the grid line nearest the peak (bar.beat, and how
 * far off), and the cue nearest it — what Ben's notes on the launch film's sound were about (pans peak late, things
 * that pass the camera lead, hits on the beat). Songs (a clip of 15 s or more) are left out. → rows, in film order.
 */
export async function placed(tl, dir, { nearest, position } = {}) {
  const rows = [], seen = new Map();
  for (const tr of tl.tracks.filter((t) => t.kind !== 'visual')) for (const c of tr.clips) {
    const m = tl.media[c.media]; if (!m?.src) continue;   // (a notes clip has no file: its instrument plays it)
    const sp = c.speed || 1, len = (c.out - c.in) / sp; if (len >= 15) continue;
    const file = path.resolve(dir, m.src);
    if (!seen.has(file)) seen.set(file, measure(file).catch(() => null));
    const M = await seen.get(file); if (!M) continue;
    const film = (s) => +(c.at + (s - c.in) / sp).toFixed(3), inside = (s) => s >= c.in - 0.005 && s <= c.out + 0.005;
    const peak = inside(M.peakAt) ? film(M.peakAt) : null, at = peak ?? +c.at.toFixed(3);
    const g = nearest && position ? (() => { const line = nearest(tl.grid ?? {}, at, 0.25), p = position(tl.grid ?? {}, line); return { at: `${p.bar}.${Math.floor(p.beat + 1e-6)}.${Math.round((p.beat % 1) * 4) % 4}`, off: Math.round((at - line) * 1000) }; })() : null;
    const cue = (tl.cues ?? []).reduce((a, q) => (Math.abs(q.t - at) < Math.abs((a?.t ?? Infinity) - at) ? q : a), null);
    rows.push({ track: tr.name, clip: c.id, media: c.media, at: +c.at.toFixed(3), end: +(c.at + len).toFixed(3), speed: sp, gain: c.gain || 0, onset: inside(M.onset) ? film(M.onset) : null, peak, trimmedPeak: peak == null, tags: M.tags, grid: g, cue: cue && Math.abs(cue.t - at) <= 1.5 ? { label: cue.label || cue.id, t: cue.t, off: Math.round((at - cue.t) * 1000) } : null });
  }
  return rows.sort((a, b) => a.at - b.at);
}

/** Plain words for the measures (thresholds set against a director's ears; they are guides, not verdicts). */
export function tags(m) {
  const t = [];
  if (m.sub >= 0.25) t.push('sub');
  if (m.low >= 0.35 || m.centroid < 350) t.push('bassy');
  else if (m.low < 0.06 && m.centroid > 2200) t.push('tinny');
  else if (m.centroid > 1800) t.push('bright');
  if (m.low < 0.05 && m.dur >= 0.3) t.push('thin');   // no low end: a whoosh or hit without it reads soft, flutey, cheap
  if (m.flatness >= 0.3 && m.low < 0.12) t.push('airy');
  if (m.tonal >= 21 && m.low < 0.7) t.push('tonal');   // a ring, chime, beep or whistle (pure-bass sounds read as peaky, not as tones)
  if (m.pitch > 400) t.push('rising'); else if (m.pitch < -400) t.push('falling');
  if (m.dur < 0.3 && m.attack <= 0.02) t.push('click');
  else if (m.attack <= 0.03 && m.decay <= 0.6) t.push('hit');
  else if (m.attack <= 0.05 && m.decay > 0.6) t.push(m.low >= 0.25 ? 'boom' : 'ring');
  else if (m.attack >= 0.35 * m.dur && m.dur > 0.6) t.push('swell');
  else if (m.dur >= 3 && m.sustain >= 0.5) t.push('bed');
  else t.push('swoosh');
  if (m.attack >= 0.5 && m.decay < 0.35 && m.decay < m.attack / 2) t.push('stops-hard');   // a build that ends in a thump
  if (m.crest >= 16 && m.attack <= 0.05) t.push('punchy');
  if (m.crest < 11 && m.attack > 0.1 && m.low < 0.15) t.push('soft');
  return t;
}

/** The sounds in files and folders (each folder's, all the way down), measured, narrowed and ordered: opt.tags (all of
 *  them, comma-separated), opt.min / opt.max (duration, s), opt.sort (a measure, descending; -measure ascending). */
/** The sound files of files and folders (a folder's, in name order, its folders' too). */
export const soundFiles = (inputs) => inputs.flatMap(function walk(p) {
  const s = fs.statSync(p);
  return s.isDirectory() ? fs.readdirSync(p).sort().flatMap((f) => walk(path.join(p, f))) : AUDIO.test(p) ? [p] : [];
});
export async function survey(inputs, opt = {}, limit = Infinity) {
  const files = soundFiles(inputs).slice(0, limit);
  let rows = [];
  for (const f of files) { try { rows.push(await measure(f)); } catch (e) { console.error(e.message); } }
  if (opt.tags) { const want = String(opt.tags).split(','); rows = rows.filter((r) => want.every((w) => r.tags.includes(w))); }
  if (opt.max) rows = rows.filter((r) => r.dur <= +opt.max);
  if (opt.min) rows = rows.filter((r) => r.dur >= +opt.min);
  if (opt.sort) { const k = String(opt.sort).replace(/^-/, ''), s = String(opt.sort).startsWith('-') ? 1 : -1; rows.sort((a, b) => s * (a[k] - b[k])); }
  return { rows, files: files.length };
}
/** Measured sounds as a table (file names relative to base). */
export function table(rows, base = null) {
  return ['   dur  peak@ attack decay   sub  low  high  air  centroid flat tonal pitch crest  tags',
    ...rows.map((r) => `${r.dur.toFixed(2).padStart(6)} ${r.peakAt.toFixed(2).padStart(5)} ${r.attack.toFixed(2).padStart(6)} ${r.decay.toFixed(2).padStart(5)}  ${r.sub.toFixed(2)} ${r.low.toFixed(2)} ${r.high.toFixed(2)} ${r.air.toFixed(2)}  ${String(r.centroid).padStart(6)} Hz ${r.flatness.toFixed(2)} ${r.tonal.toFixed(0).padStart(4)} ${String(r.pitch).padStart(6)} ${r.crest.toFixed(0).padStart(4)}  ${r.tags.join(' ').padEnd(26)} ${base ? path.relative(base, r.file) : r.file}`)].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = {}, inputs = [];
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1]?.startsWith('--') || i + 1 >= args.length ? true : args[++i]; else inputs.push(args[i]);
  const { rows } = await survey(inputs, opt);
  // (no process.exit after writing: piped output is written asynchronously, and exiting would cut it off)
  if (opt.json) process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
  else console.log(table(rows, inputs.length === 1 && fs.statSync(inputs[0]).isDirectory() ? inputs[0] : null));
}
