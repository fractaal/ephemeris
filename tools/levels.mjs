// The mix's loudness, as a broadcast meter reads it (EBU R128: ffmpeg's ebur128), mixed by the editor's own mixer
// (nle/model.js) as masters are: the film's (or each span's) integrated loudness, range and true peak and its loudest
// moment; each track's own; and wherever a voice speaks, how far it stands above everything else (the sound skill:
// at least ~3 LU). A voice is a track named for one (Voice, VO, Narration, Dialogue…) unless they are named. And, asked:
// each span's energy by octave (the mix's balance, and which track fills each octave), how wide it is (side against mid,
// the low end apart), and what drives the master: where the tracks summed peak before its effects, and what is in them.
//
//   node tools/levels.mjs projects/<name>/timelines/<id>.json [--from s] [--to s] [--spans 0-8,8-24] [--voice "Track,Track"]
//                         [--bands] [--peaks]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isVisual } from '../nle/model.js';
import { fft } from './sound.mjs';
import { sources, renderAll } from './mix.mjs';
import { migrate } from './migrations/index.mjs';

const VOICE = /\b(voice|vo|narrat\w*|dialog\w*|speech|vox)\b/i;
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** ffmpeg's meter over stereo (L, R at sr): { I, LRA, TP, M, S } (M, S: momentary and short-term, every 100 ms). */
export function meter(L, R, sr) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostats', '-v', 'verbose', '-f', 'f32le', '-ar', String(sr), '-ac', '2', '-i', '-', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-']);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', () => {
      const M = [], S = [];
      for (const m of err.matchAll(/t:\s*[\d.]+\s+TARGET:\S+\s+LUFS\s+M:\s*(-?[\d.]+|-inf)\s+S:\s*(-?[\d.]+|-inf)/g)) { M.push(+m[1] || -120); S.push(+m[2] || -120); }
      const sum = err.slice(err.lastIndexOf('Summary:'));
      const num = (re) => { const m = re.exec(sum); return m ? +m[1] : null; };
      resolve({ I: num(/I:\s+(-?[\d.]+) LUFS/), LRA: num(/LRA:\s+([\d.]+) LU/), TP: num(/Peak:\s+(-?[\d.]+) dBFS/), M, S });
    });
    p.stdin.on('error', () => {});   // (ffmpeg may close it at the end)
    const x = new Float32Array(L.length * 2);
    for (let i = 0; i < L.length; i++) { x[2 * i] = L[i]; x[2 * i + 1] = R[i]; }
    p.stdin.end(Buffer.from(x.buffer));
  });
}

/** The octave bands' centres (Hz). */
export const BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const dB = (p) => (p > 1e-15 ? 10 * Math.log10(p) : -150);
/**
 * Stereo (L, R at sr) by octave: { level: each band's level (dBFS, as an RMS level: a full-scale sine is −3), share: each
 * band's dB of the whole's energy (the shape a reference is compared by), side: the side's level against the mid's (dB:
 * −∞ is mono), sideLow: the same under 150 Hz (where it should be near mono) }.
 */
export function bands(L, R, sr) {
  const N = 8192, w = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)), ww = w.reduce((a, x) => a + x * x, 0);
  const band = new Float64Array(BANDS.length), mid = [0, 0], side = [0, 0];   // ([all, under 150 Hz])
  const re = new Float64Array(N), im = new Float64Array(N), re2 = new Float64Array(N), im2 = new Float64Array(N);
  let frames = 0;
  for (let s = 0; s + N <= L.length; s += N / 2, frames++) {
    for (let i = 0; i < N; i++) { re[i] = (L[s + i] + R[s + i]) * 0.5 * w[i]; re2[i] = (L[s + i] - R[s + i]) * 0.5 * w[i]; }
    im.fill(0); im2.fill(0); fft(re, im); fft(re2, im2);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * sr) / N, pm = re[k] * re[k] + im[k] * im[k], ps = re2[k] * re2[k] + im2[k] * im2[k];
      // (mid² + side² is L² + R² halved: the band's power is both channels', as an RMS meter reads stereo)
      const j = BANDS.findIndex((c) => f >= c / Math.SQRT2 && f < c * Math.SQRT2);
      if (j >= 0) band[j] += pm + ps;
      mid[0] += pm; side[0] += ps; if (f < 150) { mid[1] += pm; side[1] += ps; }
    }
  }
  const norm = 2 / (Math.max(1, frames) * N * ww), total = band.reduce((a, x) => a + x, 0);
  return {
    level: [...band].map((p) => Math.round(dB(p * norm))), share: [...band].map((p) => Math.round(dB(p / (total || 1)))),
    side: Math.round(dB(side[0]) - dB(mid[0])), sideLow: Math.round(dB(side[1]) - dB(mid[1])),
  };
}
const bandHead = () => BANDS.map((c) => (c >= 1000 ? `${c / 1000}k` : String(Math.round(c))).padStart(5)).join('');

/**
 * The levels of timeline `tl` (its project in `dir`) over each of `spans` ([[from, to], …] s; else from `from` to `to`),
 * as words and numbers: { text, spans: [{ from, to, mix, tracks, voices, bands? }], peaks? }. Each track is heard alone
 * as in the mix (the rest muted: a compressor listening to a muted track still hears it, as a solo in a DAW does).
 */
export async function levels(tl, dir, { from = 0, to = Infinity, spans = null, voice = null, bands: withBands = false, peaks = false } = {}) {
  const heard = tl.tracks.filter((t) => !isVisual(t) && t.clips.length);
  if (!heard.length) return { text: 'Nothing is heard: no clips on the audio tracks.' };
  const want = (spans?.length ? spans : [[from, to]]).map(([a, b]) => [Math.max(0, a), b]), until = Math.max(...want.map(([, b]) => b));
  const src = await sources(tl, dir), { sr } = src;
  const solo = (tracks, x = tl) => ({ ...x, tracks: heard.map((t) => (tracks.includes(t) ? t : { ...t, mute: true })) });
  const voices = heard.filter((t) => (voice ? voice.includes(t.name) || voice.includes(t.id) : VOICE.test(t.name)));
  // every render it needs, at once: the mix, each track alone, the rest under each voice, and (peaks) the same before the
  // master's effects
  const dry = { ...tl, master: { ...(tl.master ?? {}), fx: (tl.master?.fx ?? []).map((f) => ({ ...f, on: false })) } };
  const wanted = [solo(heard), ...heard.map((t) => solo([t])), ...voices.map((v) => solo(heard.filter((t) => t !== v))), ...(peaks ? [solo(heard, dry), ...heard.map((t) => solo([t], dry))] : [])];
  const made = await renderAll(wanted, src, { until }), take = (k) => made.splice(0, k);
  const [all] = take(1), each = take(heard.length), under = take(voices.length), rests = new Map(voices.map((v, i) => [v, under[i]])), [dryAll, ...dryEach] = made;
  const out = { spans: [] };
  for (const [a, b] of want) {
    const cut = ([L, R]) => { const i0 = Math.min(L.length, Math.round(a * sr)), i1 = Math.min(L.length, Math.round(b * sr)); return [L.subarray(i0, i1), R.subarray(i0, i1)]; };
    const top = (S) => { let k = 0; S.forEach((v, i) => { if (v > S[k]) k = i; }); return { db: S[k] ?? -120, t: a + (k + 1) * 0.1 }; };   // (each value is of the window ending there)
    const [m, ...ms] = await Promise.all([all, ...each].map((x) => meter(...cut(x), sr)));
    const span = { from: a, to: +(a + m.M.length * 0.1).toFixed(2), mix: { I: m.I, LRA: m.LRA, TP: m.TP, loudest: top(m.S) }, tracks: heard.map((t, i) => ({ name: t.name, I: ms[i].I, loudest: top(ms[i].M) })), voices: [] };   // (a track's loudest: momentary, an effect is short)
    for (const v of voices) {
      // (where it speaks: within 12 LU of its own loudness, not its breaths and tails)
      const own = ms[heard.indexOf(v)], vm = own.M, rest = await meter(...cut(rests.get(v)), sr), floor = Math.max(-45, (own.I ?? -45) - 12);
      const gaps = vm.map((x, k) => (x > floor ? { t: a + (k + 1) * 0.1, d: x - (rest.M[k] ?? -120) } : null)).filter(Boolean);
      if (!gaps.length) { span.voices.push({ name: v.name, speaks: 0 }); continue; }
      const ds = gaps.map((g) => g.d).sort((p, q) => p - q), least = gaps.reduce((p, g) => (g.d < p.d ? g : p));
      span.voices.push({ name: v.name, speaks: +(gaps.length * 0.1).toFixed(1), median: r1(ds[ds.length >> 1]), least: { lu: r1(least.d), t: +least.t.toFixed(1) }, under3: Math.round((100 * ds.filter((d) => d < 3).length) / ds.length) });
    }
    if (withBands) span.bands = { mix: bands(...cut(all), sr), tracks: each.map((x) => bands(...cut(x), sr)) };
    out.spans.push(span);
  }
  if (peaks) {
    // the tracks summed before the master's effects (each alone the same way), and where that peaks highest
    const [L, R] = dryAll, stems = dryEach, win = Math.round(sr * 0.05), hits = [];
    for (const [a, b] of want) for (let i = Math.round(a * sr); i < Math.min(L.length, Math.round(b * sr)); i += win) {
      let p = 0, at = i;
      for (let k = i; k < Math.min(L.length, i + win); k++) { const v = Math.max(Math.abs(L[k]), Math.abs(R[k])); if (v > p) { p = v; at = k; } }
      hits.push({ p, at });
    }
    hits.sort((x, y) => y.p - x.p);
    out.peaks = { limited: tl.master?.fx?.some((f) => f.on !== false && (f.type === 'limiter' || f.type === 'compressor')), top: hits.slice(0, 6).map(({ p, at }) => {
      const ch = Math.abs(L[at]) >= Math.abs(R[at]) ? 0 : 1;
      return { t: at / sr, db: dB(p * p), sum: [L, R][ch][at], tracks: heard.map((t, i) => ({ name: t.name, v: stems[i][ch][at] ?? 0 })).filter((x) => Math.abs(x.v) >= 0.01).sort((x, y) => Math.abs(y.v) - Math.abs(x.v)) };
    }) };
  }
  out.text = describe(out, heard, voices.length > 0);
  return out;
}

function describe(o, heard, named) {
  const lu = (x) => (x == null ? '?' : `${x.toFixed(1)}`), lines = [];
  for (const s of o.spans) {
    if (lines.length) lines.push('');
    const tp = s.mix.TP;
    lines.push(`The mix, ${s.from.toFixed(2)}–${s.to.toFixed(2)} s: ${lu(s.mix.I)} LUFS integrated, range ${lu(s.mix.LRA)} LU, true peak ${lu(tp)} dBTP${tp != null && tp > -1 ? ' (over −1 dBTP: bring it down)' : ''}; loudest ${lu(s.mix.loudest.db)} LUFS (short-term) at ${s.mix.loudest.t.toFixed(1)} s`);
    lines.push(`Each track alone: ${s.tracks.map((t) => `${t.name} ${lu(t.I)} LUFS (loudest ${lu(t.loudest.db)} momentary, at ${t.loudest.t.toFixed(1)} s)`).join('; ')}`);
    for (const v of s.voices) {
      if (!v.speaks) { lines.push(`${v.name}: silent here`); continue; }
      lines.push(`${v.name} over everything else, where it speaks (${v.speaks} s): ${v.median >= 0 ? '+' : ''}${v.median} LU typically, ${v.least.lu >= 0 ? '+' : ''}${v.least.lu} LU at its least (${v.least.t} s); ${v.under3}% of it under 3 LU${v.under3 > 10 ? ': lower what is under it there, or raise the voice' : ''}`);
    }
    if (s.bands) {
      const b = s.bands, w = Math.max(5, ...heard.map((t) => t.name.length)) + 2, cell = (v) => (v <= -90 ? '-' : String(v)).padStart(5), loud = BANDS.map((_, j) => b.tracks.reduce((k, x, i) => (x.level[j] > b.tracks[k].level[j] ? i : k), 0));
      lines.push(`By octave (dBFS, as RMS):${' '.repeat(Math.max(0, w - 24))}${bandHead()}`);
      lines.push(`${'the mix'.padEnd(w)}${b.mix.level.map(cell).join('')}   side ${b.mix.side} dB under mid, ${b.mix.sideLow} under 150 Hz`);
      heard.forEach((t, i) => lines.push(`${t.name.slice(0, w - 1).padEnd(w)}${b.tracks[i].level.map((v, j) => (v <= -90 ? '-' : `${loud[j] === i ? '*' : ''}${v}`).padStart(5)).join('')}${b.tracks[i].level.some((v) => v > -90) ? `   side ${b.tracks[i].side} dB under mid` : ''}`));
      lines.push(`(* the loudest track in the octave.) The mix's balance (each octave's dB of its whole, as sounds' bands give a reference's): ${BANDS.map((c, j) => `${c >= 1000 ? `${c / 1000}k` : Math.round(c)}:${b.mix.share[j]}`).join(' ')}`);
    }
  }
  if (!named) lines.push('(no track is named for a voice: name it, or pass voice, to see it against the rest)');
  if (o.peaks) {
    lines.push('', `Before the master's effects${o.peaks.limited ? ' (what its limiter or compressor works on)' : ''}, the tracks summed peak highest at:`);
    for (const p of o.peaks.top) lines.push(`  ${p.t.toFixed(3)} s  ${p.db >= 0 ? '+' : ''}${p.db.toFixed(1)} dBFS  (${p.sum.toFixed(2)}): ${p.tracks.map((x) => `${x.name} ${x.v.toFixed(2)}`).join(', ') || 'nothing alone over 0.01'}`);
    lines.push('  (each track there as it sounds alone; what is left over is the buses\' (reverb, delay) and tracks meeting in a compressor)');
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, ...rest] = process.argv.slice(2), opt = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (!file) { console.log('node tools/levels.mjs <timeline.json> [--from s] [--to s] [--spans 0-8,8-24] [--voice "Track,Track"] [--bands] [--peaks]'); process.exit(1); }
  const tl = migrate(JSON.parse(fs.readFileSync(file, 'utf8'))).doc;
  const spans = opt('spans')?.split(',').map((s) => s.split('-').map(Number));
  const o = await levels(tl, path.resolve(path.dirname(file), '..'), { from: +(opt('from') ?? 0), to: +(opt('to') ?? Infinity), spans, voice: opt('voice')?.split(','), bands: rest.includes('--bands'), peaks: rest.includes('--peaks') });
  console.log(o.text);
}
