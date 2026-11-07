// The instrument panels' displays: flat line drawings in a dark well, the accent's line over a faint fill. Some only show
// a setting (an oscillator's wave, an LFO's shape); the editors are handled directly (an envelope's points, a filter's
// corner, a sample's start, end and loop), each { el, update(values) } with onChange(key, value, final) as a drag goes
// (final when it ends: the panel makes its edit then). Drawn from the values alone, not by running the engine.
const NS = 'http://www.w3.org/2000/svg';
const W = 160, H = 44, PAD = 4;
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const div = (cls, text) => { const e = document.createElement('div'); e.className = cls; if (text) e.textContent = text; return e; };
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const secs = (t) => (t < 1 ? `${Math.round(t * 1000)} ms` : `${t.toFixed(2)} s`);

// a well: its engraved midline and quarter marks, a filled area and the line over it
function well(cls, marks = true) {
  const el = svgEl('svg', { class: `disp ${cls}`, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  if (marks) {
    el.append(svgEl('line', { class: 'disp-grid', x1: 0, x2: W, y1: H / 2, y2: H / 2 }));
    for (const x of [W / 4, W / 2, (3 * W) / 4]) el.append(svgEl('line', { class: 'disp-grid', x1: x, x2: x, y1: 0, y2: H }));
  }
  const fill = svgEl('path', { class: 'disp-fill' }), line = svgEl('path', { class: 'disp-line' });
  el.append(fill, line);
  return { el, set(points, base = H / 2) {   // points: [[x 0–1, y 0–1 (up)], …]
    const xy = points.map(([x, y]) => [PAD + x * (W - 2 * PAD), H - PAD - y * (H - 2 * PAD)]);
    const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
    line.setAttribute('d', d);
    fill.setAttribute('d', xy.length ? `${d}L${xy.at(-1)[0].toFixed(1)} ${base}L${xy[0][0].toFixed(1)} ${base}Z` : '');
  } };
}
// a little deterministic noise (the same picture each time)
function noise(n, color) {
  let a = 7, last = 0, out = [];
  for (let i = 0; i < n; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    const w = a / 4294967296 * 2 - 1;
    last = color === 'brown' ? Math.max(-1, Math.min(1, last + w * 0.35)) : color === 'pink' ? last * 0.6 + w * 0.55 : w;
    out.push(last);
  }
  return out;
}
// one cycle-and-a-bit of a wave, as values −1…1 at N+1 points over `cycles`
function waveAt(type, o, N, cycles) {
  const pw = num(o.pw, 0.5), pos = num(o.pos, 0), rnd = type === 'noise' ? noise(N + 1, o.color) : null, out = [];
  for (let i = 0; i <= N; i++) {
    const ph = ((i / N) * cycles) % 1, s = Math.sin(2 * Math.PI * ph);
    out.push(type === 'sine' ? s : type === 'triangle' ? 1 - 4 * Math.abs(ph - 0.5) : type === 'square' ? (ph < 0.5 ? 1 : -1)
      : type === 'pulse' ? (ph < pw ? 1 : -1) : type === 'noise' ? rnd[i] : type === 'wavetable' ? s * (1 - pos) + (2 * ph - 1) * pos
      : type === 'fm' ? Math.sin(2 * Math.PI * ph + 1.6 * Math.sin(4 * Math.PI * ph)) : 2 * ph - 1);   // saw
  }
  return out;
}

/** An oscillator's wave, two cycles of it: { type, pw, pos, color }. */
export function waveDisplay(osc) {
  const w = well('wave');
  const update = (o = {}) => { const v = waveAt(o.type ?? 'saw', o, 120, 2); w.set(v.map((y, i) => [i / 120, 0.5 + y * 0.42])); };
  update(osc);
  return { el: w.el, update };
}
/** A wave's glyph, for a button choosing it (sine, saw, …; an LFO's sh: stepped). */
export function waveIcon(type) {
  const N = 24, v = type === 'sh' ? [0.6, 0.6, -0.4, -0.4, 0.9, 0.9, -0.8, -0.8, 0.2, 0.2].flatMap((y) => [y, y, y]).slice(0, N + 1) : waveAt(type, { pw: 0.25, pos: 0.6 }, N, type === 'noise' ? 3 : 1.25);
  const d = v.map((y, i) => `${i ? 'L' : 'M'}${(1 + (i / N) * 16).toFixed(1)} ${(6 - y * 4.2).toFixed(1)}`).join('');
  const s = svgEl('svg', { class: 'wave-ico', viewBox: '0 0 18 12', 'aria-hidden': 'true' });
  s.append(svgEl('path', { d }));
  return s;
}

/** An LFO's shape, two cycles: { shape (sine, triangle, saw, square, sh) }. */
export function lfoDisplay(lfo) {
  const w = well('lfo');
  const update = (o = {}) => {
    const shape = o.shape ?? 'sine', N = 120, steps = noise(8, 'white'), pts = [];
    for (let i = 0; i <= N; i++) {
      const ph = ((i / N) * 2) % 1;
      const v = shape === 'triangle' ? 1 - 4 * Math.abs(ph - 0.5) : shape === 'saw' ? 2 * ph - 1 : shape === 'square' ? (ph < 0.5 ? 1 : -1)
        : shape === 'sh' ? steps[Math.min(7, Math.floor((i / N) * 8))] : Math.sin(2 * Math.PI * ph);
      pts.push([i / N, 0.5 + v * 0.42]);
    }
    w.set(pts);
  };
  update(lfo);
  return { el: w.el, update };
}

// ---------- editors: an SVG drawn in a 0–100 box (stretched to the element), handles as dots over it at percentages
function editor(cls) {
  const el = div(`ed ${cls}`), svg = svgEl('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const read = div('ed-read');
  el.append(svg, read);
  /** A handle: drag(fx, fy, e) with the pointer's place as fractions of the box (y down), and done() when let go. */
  function handle(cls2, title, drag, done) {
    const h = div(`ed-hdl ${cls2}`); h.title = title;
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation(); h.setPointerCapture(e.pointerId); el.classList.add('dragging'); h.classList.add('on');
      const move = (ev) => { const r = el.getBoundingClientRect(); drag(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1), ev); };
      const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); el.classList.remove('dragging'); h.classList.remove('on'); read.textContent = ''; done(); };
      h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
    });
    el.append(h);
    return h;
  }
  const place = (h, fx, fy) => { h.style.left = `${fx * 100}%`; h.style.top = `${fy * 100}%`; };
  return { el, svg, read, handle, place };
}
const pathOf = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * 100).toFixed(2)} ${(y * 100).toFixed(2)}`).join('');

/** An envelope edited by its points: the attack's peak (its time), the hold's end, the decay's end (its time and the
 *  sustain level), the release's end. env { a, h?, d, s, r }; spec: each stage's param description (min, max); hold: show
 *  the hold stage. Times are drawn on a square-root scale, each stage in its own part of the width, so 5 ms of attack
 *  and 2 s of release can both be seen and dragged. */
export function envEditor(env, spec, onChange, { hold = false } = {}) {
  const ed = editor('env'), parts = hold ? { a: 0.2, h: 0.1, d: 0.22, sus: 0.16, r: 0.28 } : { a: 0.22, d: 0.26, sus: 0.18, r: 0.3 };
  const top = 0.08, bot = 0.94, left = 0.02, span = 0.96;
  const fill = svgEl('path', { class: 'ed-fill' }), line = svgEl('path', { class: 'ed-line' }), susLine = svgEl('path', { class: 'ed-guide' });
  ed.svg.append(fill, susLine, line);
  let e = { ...env };
  const max = (k) => spec[k]?.max ?? 10, min = (k) => spec[k]?.min ?? 0;
  const fx = (k, t) => Math.sqrt(clamp(t, 0, max(k)) / max(k)) * parts[k] * span;   // a stage's width
  const tx = (k, f) => clamp(max(k) * (clamp(f, 0, parts[k] * span) / (parts[k] * span)) ** 2, min(k), max(k));
  const yOf = (lvl) => bot - lvl * (bot - top);
  const geo = () => {
    const xa = left + fx('a', e.a), xh = xa + (hold ? fx('h', e.h ?? 0) : 0), xd = xh + fx('d', e.d), xs = xd + parts.sus * span, xr = xs + fx('r', e.r);
    return { xa, xh, xd, xs, xr, ys: yOf(clamp(e.s, 0, 1)) };
  };
  const hA = ed.handle('a', 'Attack: drag along', (x) => { e.a = tx('a', x - left); draw(); say('Attack', secs(e.a)); onChange('a', e.a, false); }, () => onChange('a', e.a, true));
  const hH = hold ? ed.handle('h', 'Hold: drag along', (x) => { e.h = tx('h', x - geo().xa); draw(); say('Hold', secs(e.h)); onChange('h', e.h, false); }, () => onChange('h', e.h, true)) : null;
  const hD = ed.handle('d', 'Decay: drag along · Sustain: drag up or down', (x, y) => {
    const g = geo(); e.d = tx('d', x - g.xh); e.s = +clamp((bot - y) / (bot - top), 0, 1).toFixed(3); draw(); say('Decay', `${secs(e.d)} · sustain ${Math.round(e.s * 100)}%`); onChange('d', e.d, false); onChange('s', e.s, false);
  }, () => { onChange('d', e.d, true); onChange('s', e.s, true); });
  const hR = ed.handle('r', 'Release: drag along', (x) => { e.r = tx('r', x - geo().xs); draw(); say('Release', secs(e.r)); onChange('r', e.r, false); }, () => onChange('r', e.r, true));
  const say = (k, v) => { ed.read.textContent = `${k} ${v}`; };
  function draw() {
    const g = geo(), pts = [[left, bot], [g.xa, top], ...(hold ? [[g.xh, top]] : []), [g.xd, g.ys], [g.xs, g.ys], [g.xr, bot]];
    line.setAttribute('d', pathOf(pts)); fill.setAttribute('d', `${pathOf(pts)}Z`);
    susLine.setAttribute('d', pathOf([[g.xd, g.ys], [1, g.ys]]));
    ed.place(hA, g.xa, top); if (hH) ed.place(hH, g.xh, top); ed.place(hD, g.xd, g.ys); ed.place(hR, g.xr, bot);
  }
  draw();
  return { el: ed.el, update: (nv) => { e = { ...nv }; draw(); } };
}

/** A filter's response over 20 Hz–20 kHz, edited by its corner: drag it along for the cutoff, up for resonance.
 *  f { type (lp, hp, bp, notch, ladder, off), cutoff (Hz), res (0–1) }. */
export function filterEditor(f, onChange) {
  const ed = editor('filter'), fill = svgEl('path', { class: 'ed-fill' }), line = svgEl('path', { class: 'ed-line' }), zero = svgEl('path', { class: 'ed-guide' });
  for (const hz of [100, 1000, 10000]) ed.svg.append(svgEl('path', { class: 'ed-grid', d: `M${(Math.log(hz / 20) / Math.log(1000)) * 100} 0V100` }));
  ed.svg.append(zero, fill, line);
  let o = { ...f };
  const X = (hz) => Math.log(hz / 20) / Math.log(1000), DB0 = 1 - 36 / 54;   // (0 dB, as a fraction from the top)
  const yRes = (res) => DB0 - 0.26 * res;
  const hz = (x) => Math.round(20 * 1000 ** x);
  const h = ed.handle('c', 'Cutoff: drag along · Resonance: drag up', (x, y) => {
    o.cutoff = clamp(hz(x), 20, 20000); o.res = +clamp((DB0 - y) / 0.26, 0, 1).toFixed(3); draw();
    ed.read.textContent = `${o.cutoff >= 1000 ? `${(o.cutoff / 1000).toFixed(o.cutoff >= 10000 ? 1 : 2)} kHz` : `${o.cutoff} Hz`} · res ${o.res.toFixed(2)}`;
    onChange('cutoff', o.cutoff, false); onChange('res', o.res, false);
  }, () => { onChange('cutoff', o.cutoff, true); onChange('res', o.res, true); });
  function draw() {
    const type = o.type ?? 'lp', fc = Math.max(20, num(o.cutoff, 20000)), q = 0.6 + num(o.res, 0) * 9, N = 100, pts = [];
    for (let i = 0; i <= N; i++) {
      const fr = 20 * 1000 ** (i / N), x = fr / fc, den = Math.sqrt((1 - x * x) ** 2 + (x / q) ** 2) || 1e-6;
      let g = type === 'off' ? 1 : type === 'hp' ? (x * x) / den : type === 'bp' ? (x / q) / den : type === 'notch' ? Math.abs(1 - x * x) / den : 1 / den;
      if (type === 'ladder') g = g * g;
      const db = clamp(20 * Math.log10(Math.max(g, 1e-6)), -36, 18);
      pts.push([i / N, 1 - (db + 36) / 54]);
    }
    line.setAttribute('d', pathOf(pts)); fill.setAttribute('d', `${pathOf(pts)}L1 1L0 1Z`);
    zero.setAttribute('d', `M0 ${DB0 * 100}H100`);
    h.hidden = type === 'off';
    ed.place(h, X(fc), yRes(num(o.res, 0)));
  }
  draw();
  return { el: ed.el, update: (nv) => { o = { ...nv }; draw(); } };
}

/** A sample's waveform with where it starts and ends playing (and its loop, when it loops) to drag: snd { sr, ch } (or
 *  null), r { offset, end, loop: { mode, start, end } } in seconds; onChange(key: offset | end | loopStart | loopEnd). */
export function sampleEditor(snd, r, onChange) {
  const ed = editor('sample'), body = svgEl('path', { class: 'ed-wave' }), mid = svgEl('path', { class: 'ed-grid', d: 'M0 50H100' });
  const outL = svgEl('rect', { class: 'ed-out', y: 0, height: 100 }), outR = svgEl('rect', { class: 'ed-out', y: 0, height: 100 }), loop = svgEl('rect', { class: 'ed-loop', y: 0, height: 100 });
  ed.svg.append(mid, loop, body, outL, outR);
  const len = snd?.ch?.[0]?.length ? snd.ch[0].length / snd.sr : 0;
  if (!len) { ed.el.classList.add('none'); ed.read.textContent = snd === undefined ? 'loading…' : 'no sample'; return { el: ed.el, update() {} }; }
  // the waveform: the louder channel's peak per column
  const L = snd.ch[0], Rr = snd.ch[1] ?? L, cols = 400, per = Math.max(1, Math.floor(L.length / cols)), mx = [];
  let peak = 1e-6;
  for (let c = 0; c < cols; c++) { let m = 0; for (let i = c * per, e = Math.min(L.length, i + per); i < e; i++) m = Math.max(m, Math.abs(L[i]), Math.abs(Rr[i])); mx.push(m); peak = Math.max(peak, m); }
  const top = mx.map((m, c) => `${c ? 'L' : 'M'}${((c / (cols - 1)) * 100).toFixed(2)} ${(50 - (m / peak) * 46).toFixed(2)}`).join('');
  const bot = mx.map((_, c) => `L${(((cols - 1 - c) / (cols - 1)) * 100).toFixed(2)} ${(50 + (mx[cols - 1 - c] / peak) * 46).toFixed(2)}`).join('');
  body.setAttribute('d', `${top}${bot}Z`);
  let v = { offset: num(r.offset, 0), end: num(r.end, len), ls: num(r.loop?.start, 0), le: num(r.loop?.end, len), loops: ['sustain', 'continuous'].includes(r.loop?.mode) };
  const keyOf = { offset: 'offset', end: 'end', ls: 'loopStart', le: 'loopEnd' };
  const mk = (k, cls, title, lo, hi) => ed.handle(cls, title, (x) => {
    v[k] = +clamp(x * len, lo(), hi()).toFixed(4); draw(); ed.read.textContent = `${title.split(':')[0]} ${secs(v[k])}`; onChange(keyOf[k], v[k], false);
  }, () => onChange(keyOf[k], v[k], true));
  const hS = mk('offset', 'start', 'Start: drag along', () => 0, () => v.end - 0.001), hE = mk('end', 'end', 'End: drag along', () => v.offset + 0.001, () => len);
  const hLS = mk('ls', 'lstart', 'Loop start: drag along', () => 0, () => v.le - 0.001), hLE = mk('le', 'lend', 'Loop end: drag along', () => v.ls + 0.001, () => len);
  function draw() {
    const f = (t) => t / len;
    outL.setAttribute('x', 0); outL.setAttribute('width', f(v.offset) * 100);
    outR.setAttribute('x', f(v.end) * 100); outR.setAttribute('width', (1 - f(v.end)) * 100);
    loop.setAttribute('x', f(v.ls) * 100); loop.setAttribute('width', Math.max(0, f(v.le) - f(v.ls)) * 100);
    loop.style.display = v.loops ? '' : 'none';
    hLS.hidden = hLE.hidden = !v.loops;
    ed.place(hS, f(v.offset), 0); ed.place(hE, f(v.end), 0); ed.place(hLS, f(v.ls), 1); ed.place(hLE, f(v.le), 1);
  }
  draw();
  ed.el.append(div('ed-len', secs(len)));
  return { el: ed.el, update(nr) { v = { offset: num(nr.offset, 0), end: num(nr.end, len), ls: num(nr.loop?.start, 0), le: num(nr.loop?.end, len), loops: ['sustain', 'continuous'].includes(nr.loop?.mode) }; draw(); } };
}
