// The effect views' worker (fxview.js): each view's canvas, drawn here from its effect's settings and, as it plays, the
// sound either side of the effect (the live engine's tap: each hop given back to it as soon as it is read). The
// spectra are of the last N samples (Hann), a column of the view each, rising at once and falling as a thing dropped
// (fxview.js fall: held HOLD s, then faster and faster, GRAVITY dB/s²).
import { fft } from '../engine/sound/effects.js';
import { DRAW, geometry, fall } from './fxview.js';

const N = 4096, HOP = 1024, HOLD = 0.05, GRAVITY = 160, HISTORY = 320;   // (a history: its last HISTORY hops, ~7 s)
const dbOf = (p) => 10 * Math.log10(p + 1e-12);
const WIN = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const NORM = 20 * Math.log10(N / 4);   // (a full-scale sine's magnitude in the Hann window: 0 dBFS)
const views = new Map();   // key → { type, canvas, ctx, spec, sr, k, sel, hover, pre, post (rings), i, fresh, shown: { pre, post }, at, hops }
globalThis.views = views;   // (for a look from the worker's console)

// (a column each: { level, v, held }, as fall keeps them)
const columns = (n) => Array.from({ length: n }, () => ({ level: -200, v: 0, held: 0 }));
function spectrum(ring, i0, sr, g, out, dt) {
  if (!ring) { for (const s of out) fall(s, -200, dt, HOLD, GRAVITY); return; }   // (no sound now: it falls away)
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = ring[(i0 + i) % N] * WIN[i];
  fft(re, im);
  const cols = out.length, bin = sr / N;
  for (let c = 0; c < cols; c++) {
    // (each column the loudest bin under it; a column narrower than a bin takes the bin it falls in)
    const fa = g.f(g.l + (g.r - g.l) * c / cols), fb = g.f(g.l + (g.r - g.l) * (c + 1) / cols);
    let a = Math.max(1, Math.floor(fa / bin)), b = Math.min(N / 2 - 1, Math.max(a, Math.floor(fb / bin))), m = 0;
    for (let j = a; j <= b; j++) m = Math.max(m, re[j] * re[j] + im[j] * im[j]);
    fall(out[c], 10 * Math.log10(m + 1e-20) - NORM, dt, HOLD, GRAVITY);
  }
}

function draw(v, now) {
  if (!v.ctx || !v.canvas.width) return;
  const dt = Math.min(0.1, (now - (v.at ?? now)) / 1000);
  v.at = now;
  const g = geometry(v.canvas.width, v.canvas.height, v.k), cols = Math.max(16, Math.round((g.r - g.l) / (2 * v.k)));
  if (!v.shown || v.shown.post.length !== cols) v.shown = { pre: columns(cols), post: columns(cols) };
  spectrum(v.fresh && v.pre, v.i, v.sr, g, v.shown.pre, dt); spectrum(v.fresh && v.post, v.i, v.sr, g, v.shown.post, dt);
  if (v.fresh) { v.fresh = false; v.live = now; }
  DRAW[v.type]?.(v.ctx, v.canvas.width, v.canvas.height, { type: v.type, now, ir: v.ir, spec: v.spec, sr: v.sr, sel: v.sel, hover: v.hover, k: v.k, mode: v.mode, hist: v.hist, level: v.level, pre: v.shown.pre.map((s) => s.level), post: v.shown.post.map((s) => s.level) });
  v.dirty = false;
}
// drawn on each display frame where something changed: its settings, the pointer, or sound came (and for a moment after
// it stops, as the spectrum falls away)
(function frame(now) {
  for (const v of views.values()) if (v.dirty || v.fresh || now - (v.live ?? -1e9) < 3000) draw(v, now);
  requestAnimationFrame(frame);
})(performance.now());

onmessage = ({ data: m }) => {
  if (m.view) {
    const { key, type, canvas, spec, sr } = m.view;
    views.get(key)?.port?.close();
    const hist = { inp: new Float32Array(HISTORY).fill(-120), out: new Float32Array(HISTORY).fill(-120), peak: new Float32Array(HISTORY).fill(-120), red: new Float32Array(HISTORY), i: 0 };
    views.set(key, { type, canvas, ctx: canvas.getContext('2d'), spec, sr, k: 1, sel: null, hover: null, mode: null, hist, level: null, pre: new Float32Array(N), post: new Float32Array(N), i: 0, fresh: false, dirty: true, port: null });
    return;
  }
  const v = views.get(m.key);
  if (!v) return;
  if (m.port) {   // (its tap's channel: each hop into the rings, its buffer given straight back to the audio thread)
    v.port?.close();
    const port = (v.port = m.port);
    port.onmessage = ({ data: d }) => {
      if (!d.hop) return;
      for (let j = 0; j < HOP; j++) { v.pre[(v.i + j) % N] = d.hop[j]; v.post[(v.i + j) % N] = d.hop[HOP + j]; }
      v.i = (v.i + HOP) % N; v.fresh = true; v.hops = (v.hops ?? 0) + 1;
      // (the hop's levels: its loudness in and out, its peak out, how far the effect turned it down — the histories')
      let ei = 0, eo = 0, pk = 0;
      for (let j = 0; j < HOP; j++) { const a = d.hop[j], b = d.hop[HOP + j]; ei += a * a; eo += b * b; pk = Math.max(pk, Math.abs(b)); }
      const h = v.hist, at = h.i;
      v.level = { inp: dbOf(ei / HOP), out: dbOf(eo / HOP), peak: 20 * Math.log10(pk + 1e-6), red: d.red };   // (loudness as the compressor's detector has it: the mean square)
      h.inp[at] = v.level.inp; h.out[at] = v.level.out; h.peak[at] = v.level.peak; h.red[at] = d.red; h.i = (at + 1) % HISTORY;
      port.postMessage({ give: d.hop }, [d.hop.buffer]);
    };
    return;
  }
  if (m.close) { v.port?.close(); views.delete(m.key); return; }
  if (m.size) { v.canvas.width = m.size[0]; v.canvas.height = m.size[1]; v.k = m.k; }
  if (m.spec) v.spec = m.spec;
  if ('sel' in m) v.sel = m.sel;
  if ('hover' in m) v.hover = m.hover;
  if (m.mode) v.mode = m.mode;
  if (m.ir) v.ir = m.ir;
  if (m.spec && !m.spec.ir) v.ir = null;
  v.dirty = true;
};
