// A song, heard by numbers (an agent cannot listen; a director should not have to type a tempo): where its beats and
// bars fall, by Beat This! (a small model, run on the CPU by the studio's model runtime: tools/models.mjs), and how sure
// it is of each; its tempo map (the steady tempos the sure beats keep, and where they change); how loud each bar is (and
// its low end: the kick and the bass), the parts it is made of (measured: where the music changes and which parts come
// back, A, B, C…, each with how intense it is) and its drops (where it rises into one of its loudest parts). A project's
// are kept beside its other derived media (renders/media/<file>/music.json), made again only when the file changes. The editor's tempo grid follows it (nle/model.js, detectedGrid).
//
//   node tools/music.mjs <file>                   what it found, in words
//   node tools/music.mjs <file> --json            all of it
//   node tools/music.mjs <file> --out <json>      all of it, written there (how the studio runs it, apart from itself)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decode, fft } from './sound.mjs';
import { model } from './models.mjs';
import { numbered, parts, partAt, lines as gridLines } from '../engine/grid.js';

export const VERSION = 2;   // (what a kept analysis was made by: a change to what is found makes them again)
const SR = 22050, NFFT = 1024, HOP = 441, FPS = SR / HOP, MELS = 128, CHUNK = 1500, BORDER = 6;
const r3 = (x) => Math.round(x * 1000) / 1000, r1 = (x) => Math.round(x * 10) / 10;

// ---------- the spectrogram Beat This! hears (its LogMelSpect: torchaudio's MelSpectrogram, magnitudes, Slaney mels from
// 30 Hz to 11 kHz, log1p(1000·x)), and per frame what the rest is measured from: power, low end and pitch classes
const melOf = (f) => (f < 1000 ? f / (200 / 3) : 15 + Math.log(f / 1000) / (Math.log(6.4) / 27));
const hzOf = (m) => (m < 15 ? m * (200 / 3) : 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)));
function melBank() {
  const nf = NFFT / 2 + 1, top = Math.floor(SR / 2), m0 = melOf(30), m1 = melOf(11000);
  const f = Array.from({ length: MELS + 2 }, (_, i) => hzOf(m0 + ((m1 - m0) * i) / (MELS + 1)));
  return Array.from({ length: MELS }, (_, m) => {
    const lo = [], w = [];
    for (let k = 0; k < nf; k++) {
      const hz = (top * k) / (nf - 1), v = Math.max(0, Math.min((hz - f[m]) / (f[m + 1] - f[m]), (f[m + 2] - hz) / (f[m + 2] - f[m + 1])));
      if (v > 0) { lo.push(k); w.push(v); }
    }
    return { k0: lo[0] ?? 0, w };
  });
}
const pitchClass = Array.from({ length: NFFT / 2 + 1 }, (_, k) => { const hz = (k * SR) / NFFT; return hz >= 65 && hz <= 2100 ? ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12 : -1; });

export function frames(x) {
  const T = 1 + Math.floor(x.length / HOP), pad = NFFT / 2, bank = melBank();
  const win = Float64Array.from({ length: NFFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT));
  const norm = 1 / Math.sqrt(NFFT);   // (torch.stft normalized: by the frame length)
  const at = (i) => { const j = i < 0 ? -i : i >= x.length ? 2 * (x.length - 1) - i : i; return x[Math.min(x.length - 1, Math.max(0, j))]; };   // (reflected at the ends)
  const spec = new Float32Array(T * MELS), power = new Float64Array(T), low = new Float64Array(T), chroma = new Float32Array(T * 12);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT), mag = new Float64Array(NFFT / 2 + 1);
  for (let t = 0; t < T; t++) {
    const s = t * HOP - pad;
    for (let i = 0; i < NFFT; i++) { re[i] = at(s + i) * win[i]; im[i] = 0; }
    fft(re, im);
    let p = 0, pl = 0;
    for (let k = 0; k <= NFFT / 2; k++) {
      const q = re[k] * re[k] + im[k] * im[k];
      mag[k] = Math.sqrt(q) * norm; p += q;
      if ((k * SR) / NFFT < 150) pl += q;
      if (pitchClass[k] >= 0) chroma[t * 12 + pitchClass[k]] += mag[k];
    }
    power[t] = p; low[t] = pl;
    for (let m = 0; m < MELS; m++) { const { k0, w } = bank[m]; let v = 0; for (let j = 0; j < w.length; j++) v += mag[k0 + j] * w[j]; spec[t * MELS + m] = Math.log1p(1000 * v); }
  }
  return { T, spec, power, low, chroma };
}

// ---------- Beat This!: the model over 30 s chunks (overlapping by its border, the earlier chunk kept where they
// overlap), then its own minimal postprocessing: peaks within ±70 ms over even odds, downbeats moved onto beats; and
// each beat's confidence, the model's odds at its peak (over 0.5, as every beat is: near 1 where the beat is clear)
export async function beatsOf({ T, spec }) {
  const session = await model('beat_this-small0');   // (on the CPU: the same beats on every machine)
  const beat = new Float32Array(T).fill(-1000), down = new Float32Array(T).fill(-1000);
  const starts = [];
  for (let s = -BORDER; s < T - BORDER; s += CHUNK - 2 * BORDER) starts.push(s);
  if (T > CHUNK - 2 * BORDER) starts[starts.length - 1] = T - (CHUNK - BORDER);
  for (const s of starts.reverse()) {
    const a = Math.max(s, 0), b = Math.min(s + CHUNK, T), left = Math.max(0, -s), right = Math.max(0, Math.min(BORDER, s + CHUNK - T)), n = left + (b - a) + right;
    const input = new Float32Array(n * MELS);
    input.set(spec.subarray(a * MELS, b * MELS), left * MELS);
    const out = await session.run({ spect: { data: input, dims: [1, n, MELS] } });
    for (let i = BORDER; i < n - BORDER; i++) { const t = s + i; if (t >= 0 && t < T) { beat[t] = out.beat.data[i]; down[t] = out.downbeat.data[i]; } }
  }
  await session.close();
  const peaks = (y) => {
    const f = [];
    for (let t = 0; t < T; t++) {
      if (!(y[t] > 0)) continue;
      let top = true; for (let d = -3; d <= 3 && top; d++) if (t + d >= 0 && t + d < T && y[t + d] > y[t]) top = false;
      if (top) f.push(t);
    }
    const out = [];   // (neighbouring frames: one peak, at their mean)
    for (let i = 0; i < f.length;) { let j = i, sum = 0; while (j < f.length && (j === i || f[j] - f[j - 1] <= 1)) sum += f[j++]; out.push([sum / (j - i) / FPS, 1 / (1 + Math.exp(-y[f[i]]))]); i = j; }
    return out;
  };
  const found = peaks(beat), beats = found.map(([t]) => t), conf = found.map(([, p]) => p);
  const downs = [...new Set(peaks(down).map(([d]) => beats.reduce((b, x) => (Math.abs(x - d) < Math.abs(b - d) ? x : b), Infinity)).filter(Number.isFinite))];
  return { beats, conf, downs };
}

// ---------- the tempo map its sure beats make (those the model is confident of: SURE or more): the steady lines (a beat
// every P seconds) that they keep to in turn, each from a bar's worth of sure beats in a row that keep to it, chosen to
// leave out the fewest of them, a change of line costing a bar's worth (so a fill or a few stray beats are carried over,
// the line kept through them). Unsure beats, where the model is guessing, are not used: a line carries on through them,
// the first back to the song's start. Every line is at the model's level of the beat (one in half or double time folded
// onto it) and fitted to its own sure beats by least squares (their 20 ms steps smoothed); its bars from the downbeats
// there. → [{ t (from; the first 0), bpm, offset (a bar line), beatsPerBar, sure (its sure beats) }], or null where no
// bar's worth of sure beats keeps to one line (a voice, an effect, music without a beat)
export const SURE = 0.95;
const TOL = 0.035;   // (a beat on a line: within 35 ms of it, half of the 70 ms within which a beat counts as found)
export function tempoMap(beats, conf, downs) {
  const sure = beats.filter((_, i) => conf[i] >= SURE), n = sure.length;
  // beats a bar: how many lie between downbeats, most often
  const at = new Map(beats.map((b, i) => [b, i])), di = downs.map((d) => at.get(d)), counts = new Map();
  for (let i = 1; i < di.length; i++) { const c = di[i] - di[i - 1]; if (c >= 2 && c <= 7) counts.set(c, (counts.get(c) ?? 0) + 1); }
  const per = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 4;
  if (n < per) return null;
  // the model's level of the beat: the commonest gap between its beats
  const hist = new Map();
  for (let i = 1; i < beats.length; i++) { const g = beats[i] - beats[i - 1]; if (g > 0.25 && g < 1.5) for (const d of [-1, 0, 1]) hist.set(Math.round(g * 100) + d, (hist.get(Math.round(g * 100) + d) ?? 0) + (d ? 0.5 : 1)); }
  if (!hist.size) return null;
  const P0 = [...hist].sort((a, b) => b[1] - a[1])[0][0] / 100;
  // a line through points [k, t] (t = phase + P·k), by least squares; how far t is from a line; the sure beats on one
  const fit = (pts) => {
    const m = pts.length, mk = pts.reduce((a, [k]) => a + k, 0) / m, mt = pts.reduce((a, [, t]) => a + t, 0) / m;
    let num = 0, den = 0; for (const [k, t] of pts) { num += (k - mk) * (t - mt); den += (k - mk) ** 2; }
    return den > 0 ? { P: num / den, phase: mt - (num / den) * mk } : null;
  };
  const off = (L, t) => t - L.phase - L.P * Math.round((t - L.phase) / L.P);
  const on = (L, a, b) => sure.filter((t) => t >= a && t <= b && Math.abs(off(L, t)) <= TOL).map((t) => [Math.round((t - L.phase) / L.P), t]);
  // the lines to choose from: one from each bar's worth of sure beats in a row that keep to one (each a beat on from the
  // last: beats in time with nothing don't), grown over the song, refitted to the sure beats on it over twice its span,
  // and again, until the span is the song (two that keep the same sure beats: one line)
  const cands = [], seen = new Set();
  for (let i = 0; i + per <= n; i++) {
    const pts = sure.slice(i, i + per).map((t, k) => [k, t]);
    let L = fit(pts);
    if (!L || pts.some(([k, t]) => Math.abs(t - L.phase - L.P * k) > TOL)) continue;
    while (L.P < P0 / Math.SQRT2) L = { P: L.P * 2, phase: L.phase };   // (at the model's level of the beat)
    while (L.P > P0 * Math.SQRT2) L = { P: L.P / 2, phase: L.phase };
    for (let a = pts[0][1], b = pts.at(-1)[1]; !(a < sure[0] && b > sure.at(-1)); ) { const w = b - a; a -= w; b += w; L = fit(on(L, a, b)) ?? L; }
    const key = on(L, -Infinity, Infinity).map(([, t]) => t).join();
    if (!seen.has(key)) { seen.add(key); cands.push(L); }
  }
  if (!cands.length) return null;
  // the lines in turn that leave out the fewest sure beats, a change costing a bar's worth (Viterbi)
  const m = cands.length, from = [];
  let cost = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    let best = 0; for (let c = 1; c < m; c++) if (cost[c] < cost[best]) best = c;
    const next = new Float64Array(m), back = new Int32Array(m);
    for (let c = 0; c < m; c++) {
      if (i && cost[best] + per < cost[c]) { next[c] = cost[best] + per; back[c] = best; } else { next[c] = cost[c]; back[c] = c; }
      if (Math.abs(off(cands[c], sure[i])) > TOL) next[c] += 1;
    }
    from.push(back); cost = next;
  }
  let c = 0; for (let k = 1; k < m; k++) if (cost[k] < cost[c]) c = k;
  const path = new Int32Array(n); for (let i = n - 1; i >= 0; i--) { path[i] = c; c = from[i][c]; }
  const runs = [];
  for (let i = 0; i < n; i++) if (!i || path[i] !== path[i - 1]) runs.push({ L: cands[path[i]], a: sure[i], b: sure[i] }); else runs.at(-1).b = sure[i];
  // each from the bar line before its first sure beat (after the last of the one before it), its bars from its downbeats
  return runs.map((r, j) => {
    const L = fit(on(r.L, r.a, r.b)) ?? r.L, phases = new Map();
    for (const d of downs) {
      if (d < r.a - TOL || d > r.b + TOL || Math.abs(off(L, d)) > TOL) continue;
      const q = ((Math.round((d - L.phase) / L.P) % per) + per) % per; phases.set(q, (phases.get(q) ?? 0) + 1);
    }
    const bar = L.P * per, line = L.phase + L.P * ([...phases].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0);
    const t = j ? Math.max(runs[j - 1].b + TOL, line + Math.floor((r.a + TOL - line) / bar) * bar) : 0;
    return { t, bpm: 60 / L.P, offset: j ? line : line - Math.floor((line + TOL) / bar) * bar, beatsPerBar: per, sure: on(L, r.a, r.b).length };
  });
}

// ---------- per bar: how loud (dB below the loudest bar), its low end (dB, the same way), and what it sounds like
// (a timbre and its pitch classes, compared between bars to find parts that come back)
function barsOf(fr, map, duration) {
  const grid = { map: numbered(map) }, ps = parts(grid), ls = gridLines(grid, -ps[0].bar, duration, 'bar');
  const bars = ls.map((l, i) => ({ t: l.t, n: l.bar, end: ls[i + 1]?.t ?? Math.min(duration, l.t + partAt(ps, l.t).bar) })).filter((b) => b.end > 0).map(({ t, n, end }) => {
    const a = Math.max(0, Math.round(t * FPS)), b = Math.min(fr.T, Math.round(end * FPS));
    let p = 0, l = 0; const tim = new Float64Array(16), chr = new Float64Array(12);
    for (let f = a; f < b; f++) {
      p += fr.power[f]; l += fr.low[f];
      for (let m = 0; m < MELS; m++) tim[m >> 3] += fr.spec[f * MELS + m];
      for (let c = 0; c < 12; c++) chr[c] += fr.chroma[f * 12 + c];
    }
    const len = Math.max(1, b - a), cs = Math.hypot(...chr) || 1;
    return { t, n, p: p / len, l: l / len, feat: [...[...tim].map((v) => v / len / 8), ...[...chr].map((v) => (3 * v) / cs)] };
  });
  const top = Math.max(...bars.map((b) => b.p), 1e-12), topL = Math.max(...bars.map((b) => b.l), 1e-12);
  for (const b of bars) { b.db = r1(10 * Math.log10(Math.max(b.p, 1e-12) / top)); b.lowDb = r1(10 * Math.log10(Math.max(b.l, 1e-12) / topL)); }
  return bars;
}

// ---------- its parts: where the music changes (a checkerboard over the bars' likeness, Foote's novelty, with the
// loudness's jumps), at bar lines, preferring four-bar phrases; each part named after the earlier one it sounds like
function sectionsOf(bars) {
  const n = bars.length; if (n < 8) return { sections: [], drops: [] };
  const dim = bars[0].feat.length, mean = new Array(dim).fill(0), sd = new Array(dim).fill(0);
  for (const b of bars) b.feat.forEach((v, i) => { mean[i] += v / n; });
  for (const b of bars) b.feat.forEach((v, i) => { sd[i] += (v - mean[i]) ** 2 / n; });
  const z = bars.map((b) => b.feat.map((v, i) => (v - mean[i]) / (Math.sqrt(sd[i]) || 1)));
  const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };
  const S = z.map((a) => z.map((b) => cos(a, b))), K = 4;
  const novelty = bars.map((_, i) => {
    if (i < 2 || i > n - 2) return 0;
    let s = 0, w = 0;
    for (let a = -K; a < K; a++) for (let b = -K; b < K; b++) {
      const p = i + a, q = i + b; if (p < 0 || q < 0 || p >= n || q >= n) continue;
      const g = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * (K / 2) ** 2));
      s += ((a < 0) === (b < 0) ? -1 : 1) * g * S[p][q]; w += g;
    }
    return -s / w;   // (unlike across the line, alike within: high)
  });
  const level = (i, j) => { let s = 0, c = 0; for (let k = Math.max(0, i); k < Math.min(n, j); k++) { s += 10 ** (bars[k].db / 10); c++; } return c ? 10 * Math.log10(s / c) : -99; };
  const levelL = (i, j) => { let s = 0, c = 0; for (let k = Math.max(0, i); k < Math.min(n, j); k++) { s += 10 ** (bars[k].lowDb / 10); c++; } return c ? 10 * Math.log10(s / c) : -99; };
  const rise = bars.map((_, i) => (i < 1 ? 0 : level(i, i + 2) - level(i - 2, i)));
  const nm = Math.max(...novelty, 1e-9);
  const start = bars.findIndex((b) => b.db > -30);
  const score = bars.map((_, i) => (novelty[i] / nm) + Math.min(1, Math.abs(rise[i]) / 6) * 0.8 + ((i - start) % 4 === 0 ? 0.15 : 0));
  const avg = score.reduce((a, v) => a + v, 0) / n, sdv = Math.sqrt(score.reduce((a, v) => a + (v - avg) ** 2, 0) / n);
  const cut = [0];
  const cand = score.map((s, i) => [i, s]).filter(([i, s]) => i >= 2 && i <= n - 2 && s > avg + 0.5 * sdv && score.slice(Math.max(0, i - 2), i + 3).every((v) => v <= s)).sort((a, b) => b[1] - a[1]);
  for (const [i] of cand) if (cut.every((c) => Math.abs(c - i) >= 4)) cut.push(i);
  if (start > 0 && cut.every((c) => Math.abs(c - start) >= 2)) cut.push(start);   // (where the music starts after silence)
  cut.sort((a, b) => a - b);
  const parts = cut.map((a, k) => ({ a, b: cut[k + 1] ?? n }));
  // names: a part like an earlier one takes its letter; intensity 1–5 from its loudness within the song
  const centroid = (p) => z[0].map((_, d) => { let s = 0; for (let i = p.a; i < p.b; i++) s += z[i][d]; return s / (p.b - p.a); });
  const named = [];
  for (const p of parts) {
    p.c = centroid(p); p.db = level(p.a, p.b);
    const like = named.map((q) => [q, cos(p.c, q.c)]).sort((a, b) => b[1] - a[1])[0];
    p.label = like && like[1] > 0.75 ? like[0].label : String.fromCharCode(65 + new Set(named.map((q) => q.label)).size);
    named.push(p);
  }
  const loud = parts.filter((p) => p.db > -30).map((p) => p.db), lo = Math.min(...loud), hi = Math.max(...loud);
  const sections = parts.map((p) => ({ t: r3(Math.max(0, bars[p.a].t)), end: r3(bars[p.b - 1].t + (bars[1].t - bars[0].t)), bars: p.b - p.a, label: p.db > -30 ? p.label : 'silence',
    intensity: p.db > -30 ? 1 + Math.round((4 * (p.db - lo)) / Math.max(1e-6, hi - lo)) : 0, db: r1(p.db) }));
  // drops: where the music rises into one of its loudest parts with the kick and bass coming in, in order
  const drops = [];
  parts.forEach((p, i) => {
    const up = level(p.a, p.a + 2) - level(p.a - 2, p.a), upL = levelL(p.a, p.a + 2) - levelL(p.a - 2, p.a);
    if (i > 0 && up >= 3 && upL >= 5 && sections[i].intensity >= 4) drops.push({ t: r3(bars[p.a].t), bar: bars[p.a].n, rise: r1(up), low: r1(upL) });
  });
  return { sections, drops };
}

/** Everything found in a sound file (see the top of this file). */
export async function analyse(file) {
  const x = await decode(file), duration = x.length / SR;
  const fr = frames(x), { beats, conf, downs } = await beatsOf(fr), map = tempoMap(beats, conf, downs);
  const out = { version: VERSION, file: path.basename(file), duration: r3(duration), model: 'Beat This! (small0)', beats: beats.map(r3), conf: conf.map((c) => Math.round(c * 100) / 100), downbeats: downs.map(r3) };
  if (!map) return { ...out, bpm: null };
  const main = map.reduce((a, p) => (p.sure > a.sure ? p : a)), bars = barsOf(fr, map, duration), { sections, drops } = sectionsOf(bars);
  return { ...out, bpm: r3(main.bpm), beatsPerBar: main.beatsPerBar, map: map.map((p) => ({ t: Math.round(p.t * 1e4) / 1e4, bpm: Math.round(p.bpm * 1e4) / 1e4, offset: Math.round(p.offset * 1e4) / 1e4, beatsPerBar: p.beatsPerBar, sure: p.sure })),
    bars: bars.map((b) => ({ t: r3(b.t), db: b.db, low: b.lowDb })), sections, drops };
}

// ---------- a project's: kept, and made apart from the process that asks (the studio's server keeps serving meanwhile)
// (each song by its path in the project, src: its analysis in renders/<src>/music.json)
const keptFile = (dir, src) => path.join(dir, 'renders', src, 'music.json');
const keyOf = (file) => { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}:${VERSION}`; };
/** The analysis of the song at src (its path in the project) if it has been made (and the file has not changed since),
 *  else null. */
export function kept(dir, src) {
  try { const k = JSON.parse(fs.readFileSync(keptFile(dir, src), 'utf8')); return k.key === keyOf(path.join(dir, src)) ? k.music : null; } catch { return null; }
}
const making = new Map();
/** Whether the song at src is being listened to now. */
export const listening = (dir, src) => making.has(path.join(dir, src));
/** The analysis of the song at src, made where it is missing (by a Node of its own): resolves { music, made } or { error }. */
export function ensure(dir, src) {
  const name = src, music = kept(dir, src); if (music) return Promise.resolve({ music, made: false });
  const file = path.join(dir, src), out = keptFile(dir, src);
  if (making.has(file)) return making.get(file);
  const job = new Promise((resolve) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const key = keyOf(file), tmp = `${out}.${process.pid}.tmp`;
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), file, '--out', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      making.delete(file);
      try {
        if (code) throw new Error(err.trim().split('\n').at(-1) || `exit ${code}`);
        const music = JSON.parse(fs.readFileSync(tmp, 'utf8'));
        fs.writeFileSync(out, JSON.stringify({ key, music })); fs.rmSync(tmp, { force: true });
        console.log(`music: ${name}: ${music.bpm ?? 'no steady'} bpm`);
        resolve({ music, made: true });
      } catch (e) { fs.rmSync(tmp, { force: true }); console.log(`music: could not analyse ${name}: ${e.message}`); resolve({ error: e.message }); }
    });
  });
  making.set(file, job);
  return job;
}

/** What it found, in a few lines of words. */
export function describe(m) {
  const mmss = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  const lines = [`${m.file}  ${mmss(m.duration)}`];
  const sure = `${m.conf.filter((c) => c >= SURE).length} of its ${m.beats.length} beats sure`;
  if (!m.bpm) return [...lines, `  no steady beat (${sure}: not a bar's worth on one line)`].join('\n');
  if (m.map.length === 1) lines.push(`  ${m.bpm} bpm, ${m.beatsPerBar} beats a bar, the first bar line at ${m.map[0].offset} s: one steady tempo (${sure})`);
  else lines.push(`  its tempo changes: ${m.map.slice(0, 8).map((p) => `${+p.bpm.toFixed(2)} bpm${p.beatsPerBar !== m.beatsPerBar ? ` (${p.beatsPerBar} a bar)` : ''} from ${mmss(p.t)}`).join(', ')}${m.map.length > 8 ? `, … (${m.map.length} in all)` : ''}; mostly ${m.bpm} bpm, ${m.beatsPerBar} beats a bar (${sure})`);
  for (const d of m.drops) lines.push(`  ${d === m.drops[0] ? 'the drop' : 'a drop'}: ${mmss(d.t)} (bar ${d.bar}), +${d.rise} dB, low end ${d.low >= 0 ? '+' : ''}${d.low} dB`);
  lines.push('  parts:');
  for (const s of m.sections) lines.push(`    ${mmss(s.t).padStart(8)}  ${s.label.padEnd(7)} ${String(s.bars).padStart(3)} bars  ${s.intensity ? `intensity ${s.intensity}` : ''}  ${s.db} dB`);
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.log('node tools/music.mjs <file> [--json | --out <json>]'); process.exit(1); }
  const m = await analyse(file), o = rest.indexOf('--out');
  if (o >= 0) fs.writeFileSync(rest[o + 1], JSON.stringify(m));
  else process.stdout.write(rest.includes('--json') ? `${JSON.stringify(m, null, 1)}\n` : `${describe(m)}\n`);
}
