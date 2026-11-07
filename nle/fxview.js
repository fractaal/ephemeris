// An effect's view (in the mixer's drawer): its settings drawn as what they do to the sound (an EQ's response, each
// band's own), over the sound itself just before and after it as it plays. It is drawn in a worker on a canvas of its
// own (fxviewworker.js), from the effect's settings and the live engine's tap of it (live.js: the sound either side of
// it, a hop at a time), so neither the editor's main thread nor the audio thread draws or analyses anything. What the
// pointer does on it is the editor's: a drag heard as it goes (the strip's tweak), the edit made as it ends.
//
//   const views = createViews({ sr, tap(key, id, at, port), untap(key), openMenu })
//   const v = views.show(el, { key, id, at, type, spec, drag(spec), done(spec, what) })   // at: its place among the strip's effects that are on (null: off)
//   v.spec(spec) · v.select(j) · v.bind({ drag, done, select }) · v.tapAt(at) · v.el (moved into another element) · v.close()
import { eqResponse, compressorCurve, saturateCurve } from '../engine/sound/fx.js';
import { PARAMS, withDefaults } from '../engine/sound/params.js';

export const FMIN = 20, FMAX = 20000, EQ_DB = 18, SPEC_DB = [-90, -6];
export const BAND_COLOURS = ['#e8a23a', '#d8d03a', '#5fd36b', '#39c6c9', '#4f9bff', '#9a7bff', '#e35fd0', '#ef6464'];
export const colourOf = (j) => BAND_COLOURS[j % BAND_COLOURS.length];
/** A level that falls as a thing dropped does: held a moment at its peak (hold, s), then falling faster and faster (g,
 *  dB/s²) until one above it lifts it again. s = { level, v, held }, kept between calls; x: the level now; dt: seconds
 *  since the last call (any rate: the fall is the same). → the level shown. */
export function fall(s, x, dt, hold, g) {
  if (x >= s.level) { s.level = x; s.v = 0; s.held = hold; return x; }
  if (s.held > 0) { s.held -= dt; return s.level; }
  s.v += g * dt;
  return (s.level = Math.max(x, s.level - s.v * dt));
}
/** Whether a band has a gain (a bell, a shelf) or only shapes (a cut, a notch, a band-pass). */
export const hasGain = (type) => type === 'peak' || type === 'lowshelf' || type === 'highshelf';
const PAD = { l: 4, r: 4, t: 6, b: 15 };
/** Where things are on a view w × h pixels (device pixels: k, the display's ratio): frequency ↔ x (log), dB ↔ y. */
export function geometry(w, h, k = 1) {
  const l = PAD.l * k, r = w - PAD.r * k, t = PAD.t * k, b = h - PAD.b * k, span = Math.log(FMAX / FMIN);
  return {
    w, h, k, l, r, t, b,
    x: (f) => l + (r - l) * Math.log(Math.max(FMIN, f) / FMIN) / span,
    f: (x) => FMIN * Math.exp(span * Math.min(1, Math.max(0, (x - l) / (r - l)))),
    y: (db) => t + (b - t) * (0.5 - db / (2 * EQ_DB)),
    db: (y) => EQ_DB * (1 - 2 * (y - t) / (b - t)),
    // (the spectrum's own scale: dBFS, tilted 3 dB an octave up from 1 kHz so that music reads level)
    ys: (dbfs, f) => t + (b - t) * (1 - (dbfs + 3 * Math.log2(f / 1000) - SPEC_DB[0]) / (SPEC_DB[1] - SPEC_DB[0])),
  };
}
/** The bands' handles: each band's place on view g (a band without gain sits on 0 dB). */
export const handles = (bands, g) => (bands ?? []).map((b, j) => { const o = withDefaults(PARAMS.eq, b); return { j, x: g.x(o.freq), y: g.y(hasGain(o.type) ? o.gain : 0) }; });

const GRID_F = [30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000];
const fLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));
/** Draws an EQ's view (the worker's): v = { spec, sr, sel, hover, pre, post } (pre, post: the spectra, dBFS per column). */
export function drawEq(ctx, w, h, v) {
  const g = geometry(w, h, v.k ?? 1), k = g.k, bands = v.spec?.bands ?? [];
  ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, w, h);
  // the grid: octaves' landmarks and every 6 dB, 0 dB brighter
  ctx.font = `${9 * k}px Inter, system-ui, sans-serif`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
  for (const f of GRID_F) {
    const x = Math.round(g.x(f)) + 0.5;
    ctx.fillStyle = '#ffffff10'; ctx.fillRect(x, g.t, 1, g.b - g.t);
    if (f !== 20000 && f !== 30 && f !== 300 && f !== 3000) { ctx.fillStyle = '#6f6f6f'; ctx.fillText(fLabel(f), x, h - 4 * k); }
  }
  ctx.textAlign = 'left';
  for (let db = -EQ_DB + 6; db < EQ_DB; db += 6) {
    const y = Math.round(g.y(db)) + 0.5;
    ctx.fillStyle = db === 0 ? '#ffffff2a' : '#ffffff0d'; ctx.fillRect(g.l, y, g.r - g.l, 1);
    if (db) { ctx.fillStyle = '#5c5c5c'; ctx.fillText(`${db > 0 ? '+' : ''}${db}`, g.l + 3 * k, y - 2 * k); }
  }
  // the sound: after the EQ filled, before it a line (where it plays)
  const cols = v.post?.length ?? 0;
  if (cols) {
    const xs = (i) => g.l + (g.r - g.l) * (i + 0.5) / cols, fs = (i) => g.f(xs(i));
    ctx.beginPath(); ctx.moveTo(g.l, g.b);
    for (let i = 0; i < cols; i++) ctx.lineTo(xs(i), Math.min(g.b, Math.max(g.t, g.ys(v.post[i], fs(i)))));
    ctx.lineTo(g.r, g.b); ctx.closePath();
    ctx.fillStyle = '#ffffff17'; ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < cols; i++) ctx.lineTo(xs(i), Math.min(g.b, Math.max(g.t, g.ys(v.pre[i], fs(i)))));
    ctx.strokeStyle = '#ffffff22'; ctx.lineWidth = k; ctx.stroke();
  }
  // the response: each band's own (the one selected filled), then all together
  const n = Math.max(2, Math.round(g.r - g.l)), freqs = Array.from({ length: n }, (_, i) => g.f(g.l + i));
  const r = eqResponse(bands, v.sr ?? 48000, freqs), line = (vals) => { ctx.beginPath(); for (let i = 0; i < n; i++) ctx.lineTo(g.l + i, Math.min(g.b + 40 * k, Math.max(g.t - 40 * k, g.y(vals[i])))); };
  ctx.save(); ctx.beginPath(); ctx.rect(g.l, g.t, g.r - g.l, g.b - g.t); ctx.clip();
  r.bands.forEach((vals, j) => {
    const c = colourOf(j), on = j === v.sel || j === v.hover;
    if (j === v.sel) { line(vals); ctx.lineTo(g.r, g.y(0)); ctx.lineTo(g.l, g.y(0)); ctx.closePath(); ctx.fillStyle = `${c}33`; ctx.fill(); }
    line(vals); ctx.strokeStyle = on ? `${c}cc` : `${c}55`; ctx.lineWidth = k; ctx.stroke();
  });
  line(r.total); ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = 2 * k; ctx.stroke();
  ctx.restore();
  // the handles, numbered
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `600 ${8.5 * k}px Inter, system-ui, sans-serif`;
  for (const p of handles(bands, g)) {
    const c = colourOf(p.j), big = p.j === v.sel || p.j === v.hover, rr = (big ? 7.5 : 6.5) * k;
    ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
    ctx.fillStyle = c; ctx.fill();
    if (p.j === v.sel) { ctx.lineWidth = 1.5 * k; ctx.strokeStyle = '#fff'; ctx.stroke(); }
    ctx.fillStyle = '#111'; ctx.fillText(String(p.j + 1), p.x, p.y + 0.5 * k);
  }
}

// ---------- dynamics and saturation: a level's place (dB) on a view, -60 dB to 0 (+6 out, where makeup lifts it)
const DYN = [-60, 0];
/** The compressor's view as Ableton's: its transfer curve (level in → out: threshold, knee, ratio, makeup; a dot where the
 *  sound is now), or its activity (the level in scrolling by, its gain reduction hanging from the top, the threshold). */
export function compGeometry(w, h, k = 1) {
  const l = 26 * k, r = w - 8 * k, t = 8 * k, b = h - 16 * k;
  return { k, l, r, t, b, x: (db) => l + (r - l) * (db - DYN[0]) / (DYN[1] - DYN[0]), db: (x) => DYN[0] + (DYN[1] - DYN[0]) * (x - l) / (r - l),
    y: (db) => b - (b - t) * (db - DYN[0]) / (DYN[1] + 6 - DYN[0]), dbY: (y) => DYN[0] + (DYN[1] + 6 - DYN[0]) * (b - y) / (b - t) };
}
function dynGrid(ctx, g, w, h, vertical = true) {
  ctx.font = `${9 * g.k}px Inter, system-ui, sans-serif`; ctx.fillStyle = '#5c5c5c';
  for (let db = -48; db <= 0; db += 12) {
    const y = Math.round(g.y(db)) + 0.5;
    ctx.fillStyle = '#ffffff0d'; ctx.fillRect(g.l, y, g.r - g.l, 1);
    ctx.fillStyle = '#5c5c5c'; ctx.textAlign = 'right'; ctx.fillText(String(db), g.l - 4 * g.k, y + 3 * g.k);
    if (vertical) { const x = Math.round(g.x(db)) + 0.5; ctx.fillStyle = '#ffffff0d'; ctx.fillRect(x, g.t, 1, g.b - g.t); ctx.fillStyle = '#5c5c5c'; ctx.textAlign = 'center'; ctx.fillText(String(db), x, h - 4 * g.k); }
  }
}
// (a history's place: oldest at the left, the newest at the right edge)
function scroll(ctx, g, hist, key, draw) {
  const n = hist[key].length, at = hist.i;
  for (let j = 0; j < n; j++) draw(g.l + (g.r - g.l) * j / (n - 1), hist[key][(at + j) % n], j);
}
export function drawCompressor(ctx, w, h, v) {
  const g = compGeometry(w, h, v.k ?? 1), k = g.k, o = v.spec ?? {}, curve = compressorCurve(o), thr = o.threshold ?? -18;
  ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, w, h);
  if (v.mode === 'activity') {
    dynGrid(ctx, g, w, h, false);
    if (v.hist) {
      ctx.beginPath(); ctx.moveTo(g.l, g.b); scroll(ctx, g, v.hist, 'inp', (x, db) => ctx.lineTo(x, Math.max(g.t, Math.min(g.b, g.y(db))))); ctx.lineTo(g.r, g.b); ctx.closePath();
      ctx.fillStyle = '#ffffff1f'; ctx.fill();
      ctx.beginPath(); scroll(ctx, g, v.hist, 'out', (x, db) => ctx.lineTo(x, Math.max(g.t, Math.min(g.b, g.y(db))))); ctx.strokeStyle = '#ffffff66'; ctx.lineWidth = k; ctx.stroke();
      // (the gain reduction, hanging from the top: 24 dB its full height)
      ctx.fillStyle = '#e8a23acc';
      const n = v.hist.red.length, cw = (g.r - g.l) / (n - 1) + 0.5;
      scroll(ctx, g, v.hist, 'red', (x, red) => { if (red > 0.05) ctx.fillRect(x, g.t, cw, (g.b - g.t) * Math.min(1, red / 24)); });
    }
    const y = Math.round(g.y(thr)) + 0.5;
    ctx.fillStyle = '#4f9bff'; ctx.fillRect(g.l, y - (v.hover === 'thr' ? 1 : 0), g.r - g.l, v.hover === 'thr' ? 2 : 1);
    ctx.font = `${9 * k}px Inter, system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.fillText(`${thr.toFixed(1)} dB`, g.l + 4 * k, y - 4 * k);
    return;
  }
  dynGrid(ctx, g, w, h);
  ctx.beginPath(); ctx.moveTo(g.x(DYN[0]), g.y(DYN[0])); ctx.lineTo(g.x(0), g.y(0)); ctx.strokeStyle = '#ffffff1a'; ctx.lineWidth = k; ctx.stroke();   // (unity)
  const knee = o.knee ?? 6;
  ctx.fillStyle = '#4f9bff14'; ctx.fillRect(g.x(thr - knee / 2), g.t, g.x(thr + knee / 2) - g.x(thr - knee / 2), g.b - g.t);
  ctx.beginPath();
  for (let x = g.l; x <= g.r; x += k) ctx.lineTo(x, Math.max(g.t, g.y(curve(g.db(x)))));
  ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = 2 * k; ctx.stroke();
  const tx = g.x(thr), ty = g.y(curve(thr));
  ctx.fillStyle = '#4f9bff'; ctx.fillRect(Math.round(tx), g.t, 1, g.b - g.t);
  for (const [x, y, on] of [[tx, ty, v.hover === 'thr'], [g.x(0), Math.max(g.t, g.y(curve(0))), v.hover === 'ratio']]) { ctx.beginPath(); ctx.arc(x, y, (on ? 6.5 : 5) * k, 0, Math.PI * 2); ctx.fillStyle = '#4f9bff'; ctx.fill(); }
  if (v.level && v.level.inp > DYN[0]) { ctx.beginPath(); ctx.arc(g.x(Math.min(0, v.level.inp)), Math.max(g.t, g.y(curve(Math.min(0, v.level.inp)))), 4 * k, 0, Math.PI * 2); ctx.fillStyle = '#e8a23a'; ctx.fill(); }
  ctx.font = `${9 * k}px Inter, system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.fillStyle = '#9a9a9a';
  ctx.fillText(`${thr.toFixed(1)} dB · ${(o.ratio ?? 4).toFixed(1)}:1 · knee ${knee.toFixed(1)}`, g.l + 6 * k, g.t + 11 * k);
}
/** The limiter's view: its sound out scrolling by, its gain reduction hanging from the top, its ceiling. */
export function drawLimiter(ctx, w, h, v) {
  const g = compGeometry(w, h, v.k ?? 1), k = g.k, ceil = v.spec?.ceiling ?? -1;
  ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, w, h);
  dynGrid(ctx, g, w, h, false);
  if (v.hist) {
    ctx.beginPath(); ctx.moveTo(g.l, g.b); scroll(ctx, g, v.hist, 'peak', (x, db) => ctx.lineTo(x, Math.max(g.t, Math.min(g.b, g.y(db))))); ctx.lineTo(g.r, g.b); ctx.closePath();
    ctx.fillStyle = '#ffffff24'; ctx.fill();
    ctx.fillStyle = '#ef6464cc';
    const n = v.hist.red.length, cw = (g.r - g.l) / (n - 1) + 0.5;
    scroll(ctx, g, v.hist, 'red', (x, red) => { if (red > 0.05) ctx.fillRect(x, g.t, cw, (g.b - g.t) * Math.min(1, red / 12)); });
  }
  const y = Math.round(g.y(ceil)) + 0.5;
  ctx.fillStyle = '#4f9bff'; ctx.fillRect(g.l, y - (v.hover === 'ceil' ? 1 : 0), g.r - g.l, v.hover === 'ceil' ? 2 : 1);
  ctx.font = `${9 * k}px Inter, system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.fillText(`ceiling ${ceil.toFixed(1)} dB`, g.l + 4 * k, y - 4 * k);
}
/** The saturator's view as Ableton's: its curve (a sample in → out) at the drive it has, the sound's reach shaded. */
export function drawSaturate(ctx, w, h, v) {
  const k = v.k ?? 1, side = Math.min(w - 16 * k, h - 16 * k), l = (w - side) / 2, t = (h - side) / 2, c = saturateCurve(v.spec ?? {});
  const X = (x) => l + side * (x + 1) / 2, Y = (y) => t + side * (1 - y) / 2;
  ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff0d'; for (const q of [-1, -0.5, 0, 0.5, 1]) { ctx.fillRect(Math.round(X(q)), t, 1, side); ctx.fillRect(l, Math.round(Y(q)), side, 1); }
  if (v.level?.peak > -60) { const a = Math.min(1, 10 ** (v.level.peak / 20)); ctx.fillStyle = '#e8a23a1a'; ctx.fillRect(X(-a), t, X(a) - X(-a), side); }
  ctx.beginPath(); ctx.moveTo(X(-1), Y(-1)); ctx.lineTo(X(1), Y(1)); ctx.strokeStyle = '#ffffff1a'; ctx.lineWidth = k; ctx.stroke();
  ctx.beginPath(); for (let i = 0; i <= 200; i++) { const x = -1 + i / 100; ctx.lineTo(X(x), Math.max(t - 20 * k, Math.min(t + side + 20 * k, Y(c(x))))); }
  ctx.strokeStyle = v.hover === 'drive' ? '#ffffff' : '#f2f2f2'; ctx.lineWidth = 2 * k; ctx.stroke();
  ctx.font = `${9 * k}px Inter, system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.fillStyle = '#9a9a9a';
  ctx.fillText(`${v.spec?.curve ?? 'soft'} · drive ${(v.spec?.drive ?? 12).toFixed(1)} dB`, l + 4 * k, t + 11 * k);
}

// ---------- time: delay's taps, a modulation's sweep, a reverb's decay — x is time from the left edge
const timeGeometry = (w, h, k = 1, span = 2) => { const l = 26 * k, r = w - 10 * k, t = 10 * k, b = h - 16 * k; return { k, l, r, t, b, span, x: (s) => l + (r - l) * s / span, s: (x) => span * (x - l) / (r - l) }; };
function timeGrid(ctx, g, w, h, step = 0.25, unit = 's') {
  ctx.font = `${9 * g.k}px Inter, system-ui, sans-serif`; ctx.textAlign = 'center';
  for (let s = 0; s <= g.span + 1e-9; s += step) { const x = Math.round(g.x(s)) + 0.5; ctx.fillStyle = '#ffffff0d'; ctx.fillRect(x, g.t, 1, g.b - g.t); ctx.fillStyle = '#5c5c5c'; ctx.fillText(unit === 'ms' ? `${Math.round(s * 1000)}` : `${+s.toFixed(2)}`, x, h - 4 * g.k); }
}
/** The delay's view as Ableton's Echo: its taps over time, each down by the feedback, left and right in turn (ping-pong). */
export const delayGeometry = (w, h, k, o) => timeGeometry(w, h, k, Math.min(4, Math.max(1, (o?.time ?? 0.25) * 8)));
export function drawDelay(ctx, w, h, v) {
  const o = withDefaults(PARAMS.delay, v.spec ?? {}), g = delayGeometry(w, h, v.k ?? 1, o), k = g.k, mid = (g.t + g.b) / 2, half = (g.b - g.t) / 2;
  ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, w, h);
  timeGrid(ctx, g, w, h, g.span > 2 ? 0.5 : 0.25);
  ctx.fillStyle = '#ffffff1a'; ctx.fillRect(g.l, Math.round(mid), g.r - g.l, 1);
  // (a tap's height: its level, -48 dB to 0, the first at the mix)
  for (let n = 1; n * o.time <= g.span; n++) {
    const db = 20 * Math.log10(Math.max(1e-6, o.mix * o.feedback ** (n - 1))), a = Math.max(0, 1 + db / 48), x = g.x(n * o.time), up = !o.pingPong || n % 2;
    ctx.fillStyle = n === 1 && v.hover === 'tap' ? '#ffffff' : `rgba(79,155,255,${0.35 + 0.65 * a})`;
    // (ping-pong: left above the line, right below; else both sides)
    if (o.pingPong) ctx.fillRect(Math.round(x) - k, up ? mid - half * a : mid, 3 * k, half * a);
    else ctx.fillRect(Math.round(x) - k, mid - half * a, 3 * k, 2 * half * a);
  }
  ctx.fillStyle = '#9a9a9a'; ctx.font = `${9 * k}px Inter, system-ui, sans-serif`; ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(o.time * 1000)} ms · feedback ${Math.round(o.feedback * 100)}%${o.pingPong ? ' · ping-pong' : ''}`, g.l + 4 * k, g.t + 10 * k);
}
/** A modulation's view (chorus, flanger) as Ableton's: its delay line's length over two seconds of its LFO, each voice in
 *  its own phase, moving as the sound plays. */
export const modGeometry = (w, h, k) => timeGeometry(w, h, k, 2);
export function drawMod(ctx, w, h, v) {
  const type = v.type ?? 'chorus', o = withDefaults(PARAMS[type], v.spec ?? {}), g = modGeometry(w, h, v.k ?? 1), k = g.k, voices = type === 'chorus' ? o.voices : 1;
  const top = (o.base + PARAMS[type].depth.max) * 1000, Y = (ms) => g.b - (g.b - g.t) * ms / top, now = (v.now ?? 0) / 1000;
  ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, w, h);
  timeGrid(ctx, g, w, h, 0.5);
  ctx.fillStyle = '#ffffff1a'; ctx.fillRect(g.l, Math.round(Y(o.base * 1000)), g.r - g.l, 1);
  for (let j = 0; j < voices; j++) {
    ctx.beginPath();
    for (let x = g.l; x <= g.r; x += 2 * k) { const s = g.s(x); ctx.lineTo(x, Y((o.base + o.depth * Math.sin(2 * Math.PI * (o.rate * (s + now)) + (2 * Math.PI * j) / voices)) * 1000)); }
    ctx.strokeStyle = j === 0 ? (v.hover === 'depth' ? '#ffffff' : '#f2f2f2') : '#4f9bff88'; ctx.lineWidth = (j === 0 ? 2 : 1) * k; ctx.stroke();
  }
  ctx.fillStyle = '#9a9a9a'; ctx.font = `${9 * k}px Inter, system-ui, sans-serif`; ctx.textAlign = 'left';
  ctx.fillText(`${o.rate.toFixed(2)} Hz · depth ${(o.depth * 1000).toFixed(2)} ms around ${(o.base * 1000).toFixed(1)} ms${voices > 1 ? ` · ${voices} voices` : ''}`, g.l + 4 * k, g.t + 10 * k);
}
/** The phaser's view: its notches (one for every two stages) sweeping between its min and max, over the frequencies. */
export function drawPhaser(ctx, w, h, v) {
  const o = withDefaults(PARAMS.phaser, v.spec ?? {}), g = geometry(w, h, v.k ?? 1), k = g.k, now = (v.now ?? 0) / 1000;
  ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, w, h);
  ctx.font = `${9 * k}px Inter, system-ui, sans-serif`; ctx.textAlign = 'center';
  for (const f of GRID_F) { const x = Math.round(g.x(f)) + 0.5; ctx.fillStyle = '#ffffff10'; ctx.fillRect(x, g.t, 1, g.b - g.t); if (f !== 20000 && f !== 30 && f !== 300 && f !== 3000) { ctx.fillStyle = '#6f6f6f'; ctx.fillText(fLabel(f), x, h - 4 * k); } }
  const x0 = g.x(o.min), x1 = g.x(o.max);
  ctx.fillStyle = '#4f9bff14'; ctx.fillRect(x0, g.t, x1 - x0, g.b - g.t);
  for (const [x, part] of [[x0, 'min'], [x1, 'max']]) { ctx.fillStyle = v.hover === part ? '#ffffff' : '#4f9bff'; ctx.fillRect(Math.round(x) - (v.hover === part ? 1 : 0), g.t, v.hover === part ? 2 : 1, g.b - g.t); }
  // (where the sweep is now, the notches spread an octave apart above it)
  const ph = 0.5 + 0.5 * Math.sin(2 * Math.PI * o.rate * now), f0 = o.min * (o.max / o.min) ** ph;
  for (let j = 0; j < o.stages / 2; j++) { const f = f0 * 2 ** j; if (f > 20000) break; const x = g.x(f); ctx.fillStyle = '#f2f2f2'; ctx.fillRect(Math.round(x) - k, g.t + 18 * k, 2 * k, g.b - g.t - 18 * k); }
  ctx.fillStyle = '#9a9a9a'; ctx.textAlign = 'left';
  ctx.fillText(`${o.rate.toFixed(2)} Hz · ${o.stages} stages · ${fLabel(Math.round(o.min))}–${fLabel(Math.round(o.max))}`, g.l + 4 * k, g.t + 10 * k);
}
/** The reverb's view: its decay over time — the pre-delay, the early reflections, then the tail down to −60 dB at its
 *  decay (RT60); the highs falling sooner as the damping rises. */
export const reverbGeometry = (w, h, k, o, ir = null) => timeGeometry(w, h, k, Math.max(0.5, Math.min(16, (o?.ir && ir?.rt ? ir.rt : o?.decay ?? 1) * 1.25 + (o?.predelay ?? 0))));
/** An impulse response's decay (channels: its sound): its Schroeder curve, dB every `step` s, and the time it takes to
 *  fall 60 dB (from its fall between −5 and −35 dB, as T30 measures it). */
export function irDecay(channels, sr, step = 0.01) {
  const n = channels[0].length, e = new Float64Array(n + 1);
  for (let i = n - 1; i >= 0; i--) { let p = 0; for (const c of channels) p += c[i] * c[i]; e[i] = e[i + 1] + p; }
  const m = Math.max(1, Math.round(step * sr)), db = new Float32Array(Math.ceil(n / m));
  for (let j = 0; j < db.length; j++) db[j] = 10 * Math.log10(e[j * m] / (e[0] || 1) + 1e-12);
  const at = (lvl) => { const j = db.findIndex((x) => x <= lvl); return j < 0 ? null : j * step; }, a = at(-5), b = at(-35);
  return { step, db, rt: a != null && b != null && b > a ? 2 * (b - a) : null };
}
export function drawReverb(ctx, w, h, v) {
  const o = withDefaults(PARAMS.reverb, v.spec ?? {}), g = reverbGeometry(w, h, v.k ?? 1, o, v.ir), k = g.k, Y = (db) => g.t + (g.b - g.t) * (-db / 66);
  ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, w, h);
  timeGrid(ctx, g, w, h, g.span > 8 ? 2 : g.span > 3 ? 1 : g.span > 1.2 ? 0.5 : 0.25);
  for (const db of [-12, -24, -36, -48, -60]) { ctx.fillStyle = '#ffffff0d'; ctx.fillRect(g.l, Math.round(Y(db)), g.r - g.l, 1); ctx.fillStyle = '#5c5c5c'; ctx.textAlign = 'right'; ctx.fillText(String(db), g.l - 4 * k, Y(db) + 3 * k); }
  if (v.spec?.ir) {   // (an impulse response's own decay: its energy still to come, from each moment — its Schroeder curve)
    const c = v.ir;
    if (c) {
      ctx.beginPath(); for (let i = 0; i < c.db.length; i++) { const x = g.x(i * c.step); if (x > g.r) break; ctx.lineTo(x, Math.min(g.b, Y(c.db[i]))); }
      ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = 2 * k; ctx.stroke();
    }
    ctx.fillStyle = '#9a9a9a'; ctx.textAlign = 'left';
    ctx.fillText(`impulse response: ${v.spec.ir}${c?.rt ? ` · decay ${c.rt.toFixed(2)} s` : ''}`, g.l + 4 * k, g.t + 10 * k);
    return;
  }
  const tail = (rt) => { ctx.beginPath(); ctx.moveTo(g.x(o.predelay), Y(0)); for (let x = g.x(o.predelay); x <= g.r; x += 2 * k) ctx.lineTo(x, Math.min(g.b, Y(-60 * (g.s(x) - o.predelay) / rt))); };
  tail(o.decay * (1 - 0.6 * o.damping)); ctx.strokeStyle = '#4f9bff88'; ctx.lineWidth = k; ctx.stroke();   // (the highs)
  tail(o.decay); ctx.lineTo(g.r, g.b); ctx.lineTo(g.x(o.predelay), g.b); ctx.closePath(); ctx.fillStyle = '#ffffff12'; ctx.fill();
  tail(o.decay); ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = 2 * k; ctx.stroke();
  // (the early reflections: a few, as the room's size spaces them)
  for (let j = 1; j <= 6; j++) { const s = o.predelay + j * o.size / 343 * 0.6; if (s > g.span) break; const x = g.x(s); ctx.fillStyle = `rgba(232,162,58,${o.early})`; ctx.fillRect(Math.round(x) - k, Y(-3 - 2.5 * j), 2 * k, g.b - Y(-3 - 2.5 * j)); }
  const ex = g.x(o.predelay + o.decay); ctx.beginPath(); ctx.arc(ex, Y(-60), (v.hover === 'decay' ? 6.5 : 5) * k, 0, Math.PI * 2); ctx.fillStyle = '#4f9bff'; ctx.fill();
  ctx.fillStyle = '#9a9a9a'; ctx.textAlign = 'right';   // (at the right: the early reflections are at the left)
  ctx.fillText(`${o.decay.toFixed(2)} s · ${o.size} m · pre-delay ${Math.round(o.predelay * 1000)} ms · damping ${Math.round(o.damping * 100)}%`, g.r - 4 * k, g.t + 10 * k);
}
export const DRAW = { eq: drawEq, compressor: drawCompressor, limiter: drawLimiter, saturate: drawSaturate, delay: drawDelay, chorus: drawMod, flanger: drawMod, phaser: drawPhaser, reverb: drawReverb };
/** The effects that have a view, and the views a view has (the first shown first). */
export const MODES = { compressor: ['transfer', 'activity'] };
/** Whether a view moves by itself while the sound plays (its LFO). */
export const MOVES = new Set(['chorus', 'flanger', 'phaser']);

// ---------- the editor's side: a view shown, its canvas given to the worker, its tap asked for, and the pointer on it
let worker = null;
const workerOf = () => (worker ??= new Worker(new URL('./fxviewworker.js', import.meta.url), { type: 'module' }));
const fmt = (v, d) => (d.unit === 'Hz' ? (v >= 1000 ? `${+(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`) : d.unit === 'dB' ? `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` : v.toFixed(2));
const clampTo = (d, v) => Math.min(d.max, Math.max(d.min, v));

export function createViews({ sr = 48000, tap = () => {}, untap = () => {}, openMenu = null, soundOf = () => null }) {
  return {
    /** A view of the effect `type` shown in el (its canvas made there, the size el gives it). */
    show(el, { key, id, at, type, spec, ...on }) {
      const doc = el.ownerDocument, box = doc.createElement('div'), canvas = doc.createElement('canvas'), w = workerOf();
      box.className = 'fx-view'; canvas.className = 'fx-canvas';
      box.append(canvas); el.append(box);
      const off = canvas.transferControlToOffscreen();
      w.postMessage({ view: { key, type, canvas: off, spec, sr } }, [off]);
      // (the tap: a channel from the live engine to the worker, made again where the effect's place among those on moves)
      const tapAt = (a) => {
        const ch = new MessageChannel();
        w.postMessage({ key, port: ch.port2 }, [ch.port2]);
        if (a != null) tap(key, id, a, ch.port1); else { untap(key); ch.port1.close(); }
      };
      tapAt(at);
      let { drag = () => {}, done = () => {}, select = () => {} } = on;
      let size = [0, 0], cur = structuredClone(spec), sel = null, hover = null, closed = false;
      const ro = new ResizeObserver(() => {
        const k = doc.defaultView.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
        size = [Math.round(r.width * k), Math.round(r.height * k)];
        w.postMessage({ key, size, k });
      });
      ro.observe(canvas);
      const tell = () => w.postMessage({ key, spec: cur, sel, hover });
      // (a reverb's impulse response: its decay, from its sound as the editor has it decoded — soundOf(id): its channels)
      let irOf = null;
      const irSent = () => { if (type !== 'reverb' || !cur.ir || cur.ir === irOf) return; const ch = soundOf(cur.ir); if (!ch) return; irOf = cur.ir; w.postMessage({ key, ir: irDecay(ch, sr) }); };
      irSent();
      const ratio = () => doc.defaultView.devicePixelRatio || 1;
      const pos = (e) => { const r = canvas.getBoundingClientRect(), k = ratio(); return [(e.clientX - r.left) * k, (e.clientY - r.top) * k]; };
      // (its views, as Ableton's compressor has: a button each, over its corner)
      let mode = MODES[type]?.[0] ?? null;
      if (mode) {
        const bar = doc.createElement('div');
        bar.className = 'fx-modes';
        for (const m of MODES[type]) {
          const b = doc.createElement('button');
          b.textContent = m[0].toUpperCase() + m.slice(1); b.className = m === mode ? 'on' : '';
          b.onclick = () => { mode = m; for (const x of bar.children) x.classList.toggle('on', x === b); w.postMessage({ key, mode }); b.blur(); };
          bar.append(b);
        }
        box.append(bar);
        w.postMessage({ key, mode });
      }
      if (type === 'eq') eqPointer();
      else if (type === 'compressor') parts({
        geo: compGeometry,
        near: (g, x, y) => {
          const thr = cur.threshold ?? PARAMS.compressor.threshold.value, curve = compressorCurve(cur);
          if (mode === 'activity') return Math.abs(y - g.y(thr)) < 6 * g.k ? 'thr' : null;
          if (Math.hypot(x - g.x(0), y - Math.max(g.t, g.y(curve(0)))) < 10 * g.k) return 'ratio';
          return Math.abs(x - g.x(thr)) < 7 * g.k ? 'thr' : null;
        },
        move: (part, g, x, y) => {
          const P = PARAMS.compressor;
          if (part === 'thr') cur.threshold = Math.round(clampTo(P.threshold, mode === 'activity' ? g.dbY(y) : g.db(x)) * 10) / 10;
          else { const o = withDefaults(P, cur), mk = typeof o.makeup === 'number' ? o.makeup : 0, over = g.dbY(y) - mk - o.threshold; cur.ratio = Math.round(clampTo(P.ratio, over > 0.01 ? -o.threshold / over : P.ratio.max) * 10) / 10; }
        },
        what: (part) => (part === 'thr' ? `compressor threshold ${fmt(cur.threshold, PARAMS.compressor.threshold)}` : `compressor ratio ${cur.ratio.toFixed(1)}:1`),
        wheel: (g, x, y, dir) => { if (mode === 'activity' || Math.abs(x - g.x(cur.threshold ?? -18)) > 20 * g.k) return null; cur.knee = Math.round(clampTo(PARAMS.compressor.knee, (cur.knee ?? 6) + dir) * 10) / 10; return `compressor knee ${cur.knee.toFixed(1)} dB`; },
      });
      else if (type === 'limiter') parts({
        geo: compGeometry,
        near: (g, x, y) => (Math.abs(y - g.y(cur.ceiling ?? -1)) < 6 * g.k ? 'ceil' : null),
        move: (part, g, x, y) => { cur.ceiling = Math.round(clampTo(PARAMS.limiter.ceiling, g.dbY(y)) * 10) / 10; },
        what: () => `limiter ceiling ${fmt(cur.ceiling, PARAMS.limiter.ceiling)}`,
      });
      else if (type === 'saturate') parts({
        geo: (w0, h0, k) => ({ k }),
        near: () => 'drive',
        move: (part, g, x, y, grab) => { cur.drive = Math.round(clampTo(PARAMS.saturate.drive, grab.from.drive + (grab.y - y) / (4 * g.k)) * 10) / 10; },
        what: () => `saturate drive ${(cur.drive ?? 12).toFixed(1)} dB`,
      });
      else if (type === 'delay') parts({
        geo: (w0, h0, k) => delayGeometry(w0, h0, k, withDefaults(PARAMS.delay, cur)),
        near: (g, x) => (Math.abs(x - g.x(withDefaults(PARAMS.delay, cur).time)) < 8 * g.k ? 'tap' : null),
        move: (part, g, x, y, grab) => {
          cur.time = Math.round(clampTo(PARAMS.delay.time, g.s(x)) * 1000) / 1000;
          cur.feedback = Math.round(clampTo(PARAMS.delay.feedback, grab.from.feedback + (grab.y - y) / (200 * g.k)) * 100) / 100;
        },
        what: () => `delay time ${Math.round(cur.time * 1000)} ms, feedback ${Math.round(cur.feedback * 100)}%`,
      });
      else if (type === 'chorus' || type === 'flanger') parts({
        geo: modGeometry,
        near: () => 'depth',
        move: (part, g, x, y, grab) => { cur.depth = Math.round(clampTo(PARAMS[type].depth, grab.from.depth + (grab.y - y) * PARAMS[type].depth.max / (120 * g.k)) * 10000) / 10000; },
        what: () => `${type} depth ${(cur.depth * 1000).toFixed(2)} ms`,
        wheel: (g, x, y, dir) => { cur.rate = Math.round(clampTo(PARAMS[type].rate, withDefaults(PARAMS[type], cur).rate * Math.exp(dir * 0.08)) * 100) / 100; return `${type} rate ${cur.rate.toFixed(2)} Hz`; },
      });
      else if (type === 'phaser') parts({
        geo: geometry,
        near: (g, x) => { const o = withDefaults(PARAMS.phaser, cur); return Math.abs(x - g.x(o.min)) < 7 * g.k ? 'min' : Math.abs(x - g.x(o.max)) < 7 * g.k ? 'max' : null; },
        move: (part, g, x) => { cur[part] = Math.round(clampTo(PARAMS.phaser[part], g.f(x))); },
        what: (part) => `phaser ${part} ${fmt(cur[part], PARAMS.phaser[part])}`,
      });
      else if (type === 'reverb') parts({
        geo: (w0, h0, k) => reverbGeometry(w0, h0, k, withDefaults(PARAMS.reverb, cur)),
        near: (g, x, y) => { const o = withDefaults(PARAMS.reverb, cur); if (cur.ir) return null; return Math.hypot(x - g.x(o.predelay + o.decay), y - (g.b - 6 * g.k)) < 14 * g.k || Math.abs(x - g.x(o.predelay + o.decay)) < 6 * g.k ? 'decay' : null; },
        move: (part, g, x) => { cur.decay = Math.round(clampTo(PARAMS.reverb.decay, g.s(x) - withDefaults(PARAMS.reverb, cur).predelay) * 100) / 100; },
        what: () => `reverb decay ${cur.decay.toFixed(2)} s`,
      });
      // a view's parts (geo: its places; near: the part under the pointer, or null) dragged (move: the settings as the
      // pointer has them; what: the edit's words), heard as they move, the edit made as the drag ends; wheel: a setting
      // turned (→ the edit's words, or null where it does nothing there)
      function parts({ geo, near, move, what, wheel = null }) {
        const g = () => geo(size[0], size[1], ratio());
        let grab = null, wheelTimer = 0;
        canvas.addEventListener('pointermove', (e) => {
          const [x, y] = pos(e);
          if (grab) { move(grab.part, g(), x, y, grab); grab.moved = true; tell(); drag(cur); return; }
          const h = near(g(), x, y);
          if (h !== hover) { hover = h; canvas.style.cursor = h == null ? '' : type === 'saturate' || type === 'chorus' || type === 'flanger' ? 'ns-resize' : 'grab'; tell(); }
        });
        canvas.addEventListener('pointerleave', () => { if (!grab && hover != null) { hover = null; tell(); } });
        canvas.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          const [x, y] = pos(e), part = near(g(), x, y);
          if (part == null) return;
          grab = { part, y, from: withDefaults(PARAMS[type], cur), moved: false };
          canvas.setPointerCapture(e.pointerId);
        });
        canvas.addEventListener('pointerup', () => { if (!grab) return; const { part, moved } = grab; grab = null; if (moved) done(cur, what(part)); });
        if (wheel) canvas.addEventListener('wheel', (e) => {
          const [x, y] = pos(e), said = wheel(g(), x, y, -Math.sign(e.deltaY) * (e.shiftKey ? 0.1 : 1));
          if (said == null) return;
          e.preventDefault(); tell(); drag(cur);
          clearTimeout(wheelTimer); wheelTimer = setTimeout(() => done(cur, said), 600);
        }, { passive: false });
      }
      // the EQ: a band's handle dragged (frequency and gain), its Q scrolled; a double-click adds a band there, a right
      // click on one changes its kind or removes it
      function eqPointer() {
        const geo = () => { const k = doc.defaultView.devicePixelRatio || 1; return geometry(size[0], size[1], k); };
        const at = (e) => { const r = canvas.getBoundingClientRect(), k = doc.defaultView.devicePixelRatio || 1; return [(e.clientX - r.left) * k, (e.clientY - r.top) * k]; };
        const near = (e) => { const g = geo(), [x, y] = at(e); let best = null, bd = 11 * g.k; for (const p of handles(cur.bands, g)) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p.j; } } return best; };
        const band = (j) => withDefaults(PARAMS.eq, cur.bands[j]);
        const what = (j, keys) => `eq band ${j + 1} ${keys.map((k) => `${k} ${fmt(band(j)[k], PARAMS.eq[k])}`).join(', ')}`;
        let grab = null, wheelTimer = 0;
        canvas.addEventListener('pointermove', (e) => {
          if (grab) {
            const g = geo(), [x, y] = at(e), b = cur.bands[grab.j];
            b.freq = Math.round(clampTo(PARAMS.eq.freq, g.f(x)) * 10) / 10;
            if (hasGain(band(grab.j).type)) b.gain = Math.round(clampTo(PARAMS.eq.gain, g.db(y)) * 10) / 10;
            grab.moved = true; tell(); drag(cur);
            return;
          }
          const h = near(e);
          if (h !== hover) { hover = h; canvas.style.cursor = h == null ? '' : 'grab'; tell(); }
        });
        canvas.addEventListener('pointerleave', () => { if (!grab && hover != null) { hover = null; tell(); } });
        canvas.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          const j = near(e);
          if (j == null) return;
          sel = j; select(j); grab = { j, moved: false };
          canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; tell();
        });
        canvas.addEventListener('pointerup', () => {
          if (!grab) return;
          const { j, moved } = grab; grab = null; canvas.style.cursor = hover == null ? '' : 'grab';
          if (moved) done(cur, what(j, hasGain(band(j).type) ? ['freq', 'gain'] : ['freq']));
        });
        canvas.addEventListener('wheel', (e) => {
          const j = near(e) ?? sel;
          if (j == null) return;
          e.preventDefault();
          cur.bands[j].q = Math.round(clampTo(PARAMS.eq.q, band(j).q * Math.exp(-Math.sign(e.deltaY) * (e.shiftKey ? 0.03 : 0.12))) * 100) / 100;
          sel = j; select(j); tell(); drag(cur);
          clearTimeout(wheelTimer); wheelTimer = setTimeout(() => done(cur, what(j, ['q'])), 600);
        }, { passive: false });
        canvas.addEventListener('dblclick', (e) => {
          if (near(e) != null) return;
          const g = geo(), [x, y] = at(e), b = { type: 'peak', freq: Math.round(g.f(x)), gain: Math.round(clampTo(PARAMS.eq.gain, g.db(y)) * 10) / 10, q: 1 };
          cur.bands = [...(cur.bands ?? []), b]; sel = cur.bands.length - 1; select(sel); tell();
          done(cur, `eq band ${sel + 1} added at ${fmt(b.freq, PARAMS.eq.freq)}, ${fmt(b.gain, PARAMS.eq.gain)}`);
        });
        canvas.addEventListener('contextmenu', (e) => {
          const j = near(e);
          if (j == null || !openMenu) return;
          e.preventDefault(); e.stopPropagation();
          const kind = band(j).type;
          openMenu(canvas, [
            ...PARAMS.eq.type.options.map((t) => ({ label: TYPE_NAMES[t] ?? t, checked: t === kind, act: () => { cur.bands[j].type = t; tell(); done(cur, `eq band ${j + 1} ${kind} → ${t}`); } })),
            'hr', { label: 'Remove band', act: () => { cur.bands.splice(j, 1); sel = null; hover = null; tell(); done(cur, `eq band ${j + 1} removed`); } },
          ], { x: e.clientX, y: e.clientY });
        });
      }
      return {
        key, type, el: box,
        /** The effect's settings as they are now (an edit made elsewhere: a knob's). */
        spec(s) { if (closed) return; cur = structuredClone(s); tell(); irSent(); },
        /** What the pointer's changes do, made anew (the drawer made again around the view). */
        bind(h) { ({ drag = drag, done = done, select = select } = h); },
        tapAt(a) { if (!closed && a !== at) { at = a; tapAt(a); } },
        select(j) { sel = j; tell(); },
        close() { if (closed) return; closed = true; ro.disconnect(); untap(key); w.postMessage({ key, close: true }); box.remove(); },
      };
    },
  };
}
export const TYPE_NAMES = { peak: 'Bell', lowshelf: 'Low shelf', highshelf: 'High shelf', lowpass: 'Low pass (high cut)', highpass: 'High pass (low cut)', notch: 'Notch', bandpass: 'Band pass' };
