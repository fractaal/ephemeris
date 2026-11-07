// The sound lab's page: the engine's modules (engine/sound) loaded straight from the worktree, each sound rendered
// offline here in the page and played through Web Audio, drawn as a waveform and a spectrogram. Knobs come from each
// module's params metadata (PARAMS) where it has some, and from the defaults its functions declare where not.
const $ = (s, el = document) => el.querySelector(s);
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'line', 'g', 'rect']);
const h = (tag, attrs = {}, ...kids) => {
  const e = SVG_TAGS.has(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'on') for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f); else if (k === 'class') e.className = v; else if (v != null) e.setAttribute(k, v); }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const ctx = new AudioContext({ latencyHint: 'interactive' });
const SR = ctx.sampleRate;
const M = {};   // the engine's modules, loaded (again) by load()
const S = { tab: 'fx', sound: null, fxSource: null, fxName: '', playing: null, renderMs: 0 };

async function load() {
  const v = Date.now(), names = ['core', 'effects', 'edit', 'sampler', 'sfz'];
  const got = await Promise.all(names.map((n) => import(`/engine/sound/${n}.js?v=${v}`).then((m) => [n, m], (e) => [n, { __error: String(e.message || e) }])));
  for (const [n, m] of got) M[n] = m;
  status(names.map((n) => (M[n].__error ? `${n} ✕` : n)).join(' · '));
}
const status = (t) => { $('#status').textContent = t; };

// ---------------------------------------------------------------- params: metadata, or what the defaults say
// a param's description { value, min, max, step, unit, curve, options } from a name and a default, where a module gives none
function guess(name, value) {
  if (typeof value === 'string') return { value, options: [value] };
  if (typeof value === 'boolean') return { value, options: [true, false] };
  if (typeof value !== 'number') return null;
  const n = name.toLowerCase(), int = Number.isInteger(value);
  const R = (min, max, o = {}) => ({ value, min, max, ...o });
  if (/cutoff|freq|^from$|^to$|lowcut|highcut|^f$/.test(n)) return R(20, 20000, { unit: 'Hz', curve: 'log' });
  if (/^(a|d|r|attack|release|decay|hold)$/.test(n)) return R(0.001, 8, { unit: 's', curve: 'log' });
  if (/predelay|^time$/.test(n)) return R(0, 2, { unit: 's' });
  if (/^dur$|tail|seconds|length/.test(n)) return R(0.1, Math.max(30, value * 2), { unit: 's' });
  if (/threshold|ceiling/.test(n)) return R(-60, 0, { unit: 'dB' });
  if (/ratio/.test(n)) return R(1, 20, { unit: 'x' });
  if (/makeup|gain|db$/.test(n)) return R(-24, 24, { unit: 'dB' });
  if (/octave/.test(n)) return R(-3, 3, { step: 1 });
  if (/semi|semitones|transpose/.test(n)) return R(-24, 24, { step: 1, unit: 'st' });
  if (/cents|detune/.test(n)) return R(n === 'cents' ? -100 : 0, 100, { unit: 'ct' });
  if (/voices|count|repeats/.test(n)) return R(1, Math.max(16, value * 2), { step: 1 });
  if (/seed/.test(n)) return R(1, 999, { step: 1 });
  if (/rate/.test(n)) return R(0.01, Math.max(20, value * 2), { unit: 'Hz', curve: 'log' });
  if (/bpm/.test(n)) return R(40, 240, { step: 1 });
  if (/feedback/.test(n)) return R(0, 0.98);
  if (/drive/.test(n)) return R(0, 10);
  if (/size/.test(n) && value <= 1) return R(0, 1);
  if (value >= 0 && value <= 1 && !(int && value === 1 && /voices/.test(n))) return R(0, 1);
  if (value < 0) return R(value * 4, -value * 4);
  return R(0, Math.max(1, value * 4), int && value > 1 ? { step: 1 } : {});
}
// the defaults a function declares, as { name: value }: those destructured from its options (`{ a = 1, … } = {}`), or,
// for `o = {}`, the `o.name ?? value` it reads
function declared(fn) {
  const src = String(fn), out = {};
  const head = src.slice(src.indexOf('(') + 1);
  const open = head.indexOf('{');
  if (open >= 0 && open < head.indexOf(')') + 1e9) {
    let depth = 0, end = -1;
    for (let i = open; i < head.length; i++) { if (head[i] === '{' || head[i] === '[') depth++; else if (head[i] === '}' || head[i] === ']') { depth--; if (depth === 0) { end = i; break; } } }
    if (end > 0 && head.slice(0, open).split(',').length <= 2) {
      for (const m of head.slice(open + 1, end).matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*[\w$]+)?\s*=\s*(-?[\d.]+(?:e-?\d+)?|'[^']*'|true|false)/g)) out[m[1]] = JSON.parse(m[2].replace(/'/g, '"'));
    }
  }
  for (const m of src.matchAll(/\bo\.([A-Za-z_$][\w$]*)\s*\?\?\s*(-?[\d.]+(?:e-?\d+)?|'[^']*'|true|false)/g)) if (!(m[1] in out)) out[m[1]] = JSON.parse(m[2].replace(/'/g, '"'));
  return out;
}
// a module's description of fn's params, or a guess from its defaults
function schema(meta, fn) {
  if (meta) return Object.fromEntries(Object.entries(meta).map(([k, d]) => [k, typeof d === 'object' && d && !Array.isArray(d) ? d : guess(k, d)]).filter(([, d]) => d));
  return Object.fromEntries(Object.entries(declared(fn)).map(([k, v]) => [k, guess(k, v)]).filter(([, d]) => d));
}

// ---------------------------------------------------------------- knobs
const fmt = (v, d) => {
  if (typeof v !== 'number') return String(v);
  const u = d.unit ?? '', a = Math.abs(v);
  const n = d.step >= 1 ? v.toFixed(0) : a >= 1000 ? `${(v / 1000).toFixed(a >= 10000 ? 1 : 2)}k` : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(a < 0.1 && a > 0 ? 3 : 2);
  return `${n}${u && u !== 'x' ? ` ${u}` : u}`;
};
function knob(name, d, value, onChange) {
  const log = d.curve === 'log' && d.min > 0;
  const toX = (v) => (log ? Math.log(v / d.min) / Math.log(d.max / d.min) : (v - d.min) / (d.max - d.min));
  const toV = (x) => { let v = log ? d.min * (d.max / d.min) ** x : d.min + x * (d.max - d.min); if (d.step) v = Math.round(v / d.step) * d.step; return Math.min(d.max, Math.max(d.min, v)); };
  let v = value === undefined ? d.value : value;
  const arc = h('path', { fill: 'none', stroke: 'var(--accent)', 'stroke-width': 3, 'stroke-linecap': 'round' });
  const dot = h('line', { stroke: '#e6e6e6', 'stroke-width': 2, 'stroke-linecap': 'round' });
  const svg = h('svg', { viewBox: '0 0 46 46' }, h('circle', { cx: 23, cy: 23, r: 17, fill: '#262626', stroke: '#3a3a3a' }), h('path', { d: arcPath(0, 1), fill: 'none', stroke: '#333', 'stroke-width': 3, 'stroke-linecap': 'round' }), arc, dot);
  const val = h('div', { class: 'val' });
  const el = h('div', { class: 'knob', title: `${name}: drag up/down (shift: fine), double-click: default` }, svg, h('div', { class: 'name' }, name), val);
  const draw = () => {
    const x = v == null ? 0 : Math.min(1, Math.max(0, toX(v))), a = -135 + 270 * x, r = (a - 90) * Math.PI / 180;
    arc.setAttribute('d', v == null ? '' : arcPath(0, x)); dot.setAttribute('x1', 23 + Math.cos(r) * 7); dot.setAttribute('y1', 23 + Math.sin(r) * 7); dot.setAttribute('x2', 23 + Math.cos(r) * 15); dot.setAttribute('y2', 23 + Math.sin(r) * 15);
    val.textContent = v == null ? 'off' : fmt(v, d);
  };
  let drag = null;
  el.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, x: v == null ? 0 : toX(v) }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => { if (!drag) return; const nx = Math.min(1, Math.max(0, drag.x + (drag.y - e.clientY) / (e.shiftKey ? 900 : 180))); const nv = toV(nx); if (nv !== v) { v = nv; draw(); onChange(v, false); } });
  el.addEventListener('pointerup', () => { if (drag) { drag = null; onChange(v, true); } });
  el.addEventListener('dblclick', () => { v = d.value; draw(); onChange(v, true); });
  el.addEventListener('wheel', (e) => { e.preventDefault(); v = toV(Math.min(1, Math.max(0, (v == null ? 0 : toX(v)) - Math.sign(e.deltaY) / 60))); draw(); onChange(v, true); }, { passive: false });
  draw();
  return el;
}
function arcPath(x0, x1) {
  const p = (x) => { const r = (-135 + 270 * x - 90) * Math.PI / 180; return [23 + Math.cos(r) * 19, 23 + Math.sin(r) * 19]; };
  const [ax, ay] = p(x0), [bx, by] = p(Math.max(x1, x0 + 1e-4));
  return `M${ax} ${ay} A19 19 0 ${270 * (x1 - x0) > 180 ? 1 : 0} 1 ${bx} ${by}`;
}
function select(name, d, value, onChange) {
  const s = h('select', { on: { change: () => onChange(d.options.find((o) => String(o) === s.value) ?? s.value, true) } }, d.options.map((o) => h('option', { value: String(o) }, String(o))));
  s.value = String(value ?? d.value);
  return h('div', { class: 'field' }, h('label', {}, name), s);
}
// a rack of controls for params `sch`, values in `vals` (changed in place), onChange(final) after each
function rack(title, sch, vals, onChange, extra = []) {
  const box = h('div', { class: 'knobs' });
  for (const [k, d] of Object.entries(sch)) {
    if (d.options) box.append(select(k, d, vals[k], (v) => { vals[k] = v; onChange(true); }));
    else box.append(knob(k, d, vals[k], (v, fin) => { vals[k] = v; onChange(fin); }));
  }
  return h('div', { class: 'rack' }, h('header', {}, h('b', {}, title), h('span', { class: 'grow' }), ...extra), box);
}

// ---------------------------------------------------------------- the current sound: drawn, played, saved
function show(snd, name = '') {
  S.sound = snd; S.soundName = name;
  drawWave(snd); drawSpec(snd);
  let pk = 0; for (const c of snd.ch) for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i]));
  const lufs = M.edit?.loudness ? ` · ${M.edit.loudness(snd).toFixed(1)} LUFS` : '';
  $('#meter').textContent = `${name ? `${name} · ` : ''}${(snd.ch[0].length / snd.sr).toFixed(2)} s · peak ${(20 * Math.log10(Math.max(pk, 1e-9))).toFixed(1)} dBFS${lufs} · rendered in ${S.renderMs.toFixed(0)} ms`;
  if ($('#auto').checked) play(snd);
}
function play(snd = S.sound) {
  stop();
  if (!snd || !snd.ch[0].length) return;
  if (ctx.state !== 'running') ctx.resume();
  const b = ctx.createBuffer(2, snd.ch[0].length, snd.sr);
  b.copyToChannel(snd.ch[0], 0); b.copyToChannel(snd.ch[1] ?? snd.ch[0], 1);
  const src = ctx.createBufferSource(); src.buffer = b; src.connect(safe(snd)); src.start();
  S.playing = src; src.onended = () => { if (S.playing === src) S.playing = null; };
}
function stop() { try { S.playing?.stop(); } catch {} S.playing = null; }
// a short sound played over whatever plays (the keyboard's notes)
function blip(snd) {
  if (ctx.state !== 'running') ctx.resume();
  const b = ctx.createBuffer(2, snd.ch[0].length, snd.sr); b.copyToChannel(snd.ch[0], 0); b.copyToChannel(snd.ch[1] ?? snd.ch[0], 1);
  const src = ctx.createBufferSource(); src.buffer = b; src.connect(safe(snd)); src.start();
}
// where a sound plays into: turned down to just under full scale when it peaks past it (the speakers', and the ears',
// sake; the meter says when), with a limiter after everything for the keyboard's overlapping notes
const guard = (() => { const c = ctx.createDynamicsCompressor(); c.threshold.value = -1; c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.001; c.release.value = 0.1; c.connect(ctx.destination); return c; })();
function safe(snd) {
  let pk = 0; for (const c of snd.ch) for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i]));
  const g = ctx.createGain(); g.gain.value = pk > 0.95 ? 0.95 / pk : 1; g.connect(guard);
  if (pk > 0.95 && snd === S.sound) $('#meter').textContent += ` · played ${(20 * Math.log10(0.95 / pk)).toFixed(1)} dB down`;
  return g;
}
function timed(f) { const t0 = performance.now(); const r = f(); S.renderMs = performance.now() - t0; return r; }
function wav(snd) {
  const n = snd.ch[0].length, buf = new ArrayBuffer(44 + n * 6), v = new DataView(buf), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 6, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, snd.sr, true); v.setUint32(28, snd.sr * 6, true); v.setUint16(32, 6, true); v.setUint16(34, 24, true); w(36, 'data'); v.setUint32(40, n * 6, true);
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < 2; c++, o += 3) { const s = Math.max(-1, Math.min(1, (snd.ch[c] ?? snd.ch[0])[i])) * 8388607 | 0; v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); }
  return new Blob([buf], { type: 'audio/wav' });
}

function canvasFit(c) { const r = c.getBoundingClientRect(), d = devicePixelRatio || 1; c.width = Math.max(1, r.width * d | 0); c.height = Math.max(1, r.height * d | 0); return c.getContext('2d'); }
function drawWave(snd) {
  const c = $('#wave'), g = canvasFit(c), W = c.width, H = c.height, L = snd.ch[0], R = snd.ch[1] ?? L, n = L.length;
  g.fillStyle = '#151515'; g.fillRect(0, 0, W, H); g.fillStyle = 'oklch(80% 0.1 250)';
  for (let x = 0; x < W; x++) {
    let lo = 0, hi = 0; const a = Math.floor(x * n / W), b = Math.max(a + 1, Math.floor((x + 1) * n / W));
    for (let i = a; i < b && i < n; i++) { const s = (L[i] + R[i]) / 2; if (s < lo) lo = s; if (s > hi) hi = s; }
    g.fillRect(x, H / 2 - hi * H / 2, 1, Math.max(1, (hi - lo) * H / 2));
  }
}
// a spectrogram: short-time spectra (Hann, 4096) on a log frequency axis (30 Hz – 20 kHz), level as colour
function drawSpec(snd) {
  const c = $('#spec'), g = canvasFit(c), W = c.width, H = c.height, N = 4096, L = snd.ch[0], R = snd.ch[1] ?? L, n = L.length;
  const img = g.createImageData(W, H), win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  const re = new Float64Array(N), im = new Float64Array(N), f0 = 30, f1 = Math.min(20000, snd.sr / 2);
  const rows = new Int32Array(H).map((_, y) => Math.min(N / 2 - 1, Math.round(f0 * (f1 / f0) ** (1 - y / (H - 1)) / snd.sr * N)));
  const cols = new Float32Array(W * H);
  let top = 1e-9;
  for (let x = 0; x < W; x++) {
    const mid = Math.floor((x + 0.5) * n / W), s0 = mid - N / 2;
    for (let i = 0; i < N; i++) { const k = s0 + i; re[i] = k >= 0 && k < n ? (L[k] + R[k]) / 2 * win[i] : 0; im[i] = 0; }
    fftInPlace(re, im);
    for (let y = 0; y < H; y++) { const k = rows[y], mag = Math.hypot(re[k], im[k]); cols[y * W + x] = mag; if (mag > top) top = mag; }
  }
  for (let i = 0; i < W * H; i++) {
    const t = Math.min(1, Math.max(0, (20 * Math.log10(cols[i] / top + 1e-12) + 90) / 90));
    const [r, gg, b] = inferno(t), o = i * 4; img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  $('#specAxis').innerHTML = `<span>0 s</span><span>${(n / snd.sr / 2).toFixed(2)} s</span><span>${(n / snd.sr).toFixed(2)} s</span><span>↕ 30 Hz – 20 kHz, log · 90 dB below its loudest</span>`;
}
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const ur = re[i + j], ui = im[i + j], vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr; re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}
function inferno(t) {
  const P = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
  const x = t * (P.length - 1), i = Math.min(P.length - 2, Math.floor(x)), f = x - i;
  return P[i].map((v, k) => v + (P[i + 1][k] - v) * f);
}

// ---------------------------------------------------------------- samples from the libraries
const decoded = new Map();
const PICK = { at: null };   // (where the sample browser last was)
async function sample(lib, rel) {
  const key = `${lib}/${rel}`;
  if (!decoded.has(key)) decoded.set(key, fetch(`/files/${lib}/${rel.split('/').map(encodeURIComponent).join('/')}`).then((r) => { if (!r.ok) throw new Error(`${r.status} ${rel}`); return r.arrayBuffer(); })
    .then((b) => ctx.decodeAudioData(b)).then((ab) => ({ sr: ab.sampleRate, ch: [ab.getChannelData(0), ab.numberOfChannels > 1 ? ab.getChannelData(1) : ab.getChannelData(0)] })));
  return decoded.get(key);
}
// a wavetable file, decoded at its own sample rate: its frames are counted in samples, so resampling it to the page's
// rate (as decodeAudioData does) would cut each frame off mid-cycle
// the sample browser: resolves to { lib, path } of a picked file, or null
function pick(filter = /./) {
  return new Promise(async (resolve) => {
    const libs = await (await fetch('/libs')).json();
    let lib = PICK.at?.lib ?? libs[0], dir = PICK.at?.path ?? '';
    const close = (v) => { $('#browser').hidden = true; resolve(v); };
    $('#browserClose').onclick = () => close(null);
    const go = async () => {
      PICK.at = { lib, path: dir, name: dir.split('/').pop() || lib };
      const r = await (await fetch(`/ls/${lib}/${dir.split('/').map(encodeURIComponent).join('/')}`)).json();
      const parts = dir ? dir.split('/') : [];
      $('#crumbs').replaceChildren(...libs.map((l) => h('a', { on: { click: () => { lib = l; dir = ''; go(); } } }, `${l} `)), ' / ',
        ...parts.flatMap((p, i) => [h('a', { on: { click: () => { dir = parts.slice(0, i + 1).join('/'); go(); } } }, p), ' / ']));
      $('#listing').replaceChildren(
        ...(dir ? [h('div', { class: 'dir', on: { click: () => { dir = parts.slice(0, -1).join('/'); go(); } } }, '..')] : []),
        ...r.dirs.map((d) => h('div', { class: 'dir', on: { click: () => { dir = dir ? `${dir}/${d}` : d; go(); } } }, d)),
        ...r.files.filter((f) => filter.test(f)).map((f) => h('div', { class: 'file', on: { click: () => close({ lib, path: dir ? `${dir}/${f}` : f, name: f }) } }, f)));
    };
    $('#browser').hidden = false; go();
  });
}

// ---------------------------------------------------------------- the keyboard (the sampler's)
const KEYMAP = 'awsedftgyhujkolp;'.split('');   // a w s e d f t g y h u j k o l p ; → C … E an octave up
const KB = { octave: 4, len: 0.9, vel: 0.8 };
function keyboard(onNote) {
  const box = h('div', { id: 'keys' }), whites = [0, 2, 4, 5, 7, 9, 11], span = 2, kw = 100 / (7 * span + 1);
  const keyEls = new Map();
  for (let o = 0; o <= span; o++) for (let s = 0; s < 12; s++) {
    if (o === span && s > 0) break;
    const white = whites.includes(s), wi = whites.filter((w) => w < s).length + o * 7;
    const el = h('div', { class: white ? 'w' : 'b', style: white ? `left:${wi * kw}%;width:${kw}%` : `left:${(wi - 0.32) * kw}%;width:${kw * 0.64}%` }, h('span', {}, KEYMAP[o * 12 + s] ?? ''));
    const off = o * 12 + s;
    el.addEventListener('pointerdown', () => { const n = 12 * (KB.octave + 1) + off; el.classList.add('on'); onNote(n); });
    el.addEventListener('pointerup', () => el.classList.remove('on')); el.addEventListener('pointerleave', () => el.classList.remove('on'));
    keyEls.set(off, el); box.append(el);
  }
  box._keys = keyEls;
  return box;
}
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.repeat || e.metaKey || e.ctrlKey) return;
  if (e.key === ' ') { e.preventDefault(); S.playing ? stop() : play(); return; }
  if (S.tab !== 'sampler') return;
  if (e.key === 'z') { KB.octave = Math.max(1, KB.octave - 1); status(`octave ${KB.octave}`); return; }
  if (e.key === 'x') { KB.octave = Math.min(7, KB.octave + 1); status(`octave ${KB.octave}`); return; }
  const i = KEYMAP.indexOf(e.key); if (i < 0) return;
  const note = 12 * (KB.octave + 1) + i;
  $('#keys')?._keys?.get(i)?.classList.add('on');
  samplerNote(note);
});
document.addEventListener('keyup', (e) => { const i = KEYMAP.indexOf(e.key); if (i >= 0) $('#keys')?._keys?.get(i)?.classList.remove('on'); });

// ---------------------------------------------------------------- Effects
const FX = { chain: [], dry: false };
// the editing tools take positional arguments: how the lab calls each, with its params
const EDITS = {
  reverse: { params: {}, run: (e, s) => e.reverse(s) },
  pitch: { params: { semitones: { value: -5, min: -24, max: 24, step: 1, unit: 'st' } }, run: (e, s, p) => e.pitch(s, p.semitones) },
  pitchShift: { params: { semitones: { value: 5, min: -24, max: 24, step: 1, unit: 'st' } }, run: (e, s, p) => e.pitchShift(s, p.semitones) },
  stretch: { params: { factor: { value: 2, min: 0.25, max: 8, unit: 'x', curve: 'log' } }, run: (e, s, p) => e.stretch(s, p.factor) },
  swell: { params: {}, run: (e, s) => e.swell(s) },
  stutter: { params: { at: guess('at', 0), slice: { value: 0.125, min: 0.02, max: 1, unit: 's' }, repeats: { value: 4, min: 1, max: 16, step: 1 }, decay: guess('decay', 1) }, run: (e, s, p) => e.stutter(s, p) },
  fade: { params: { in: { value: 0.05, min: 0, max: 5, unit: 's' }, out: { value: 0.5, min: 0, max: 10, unit: 's' } }, run: (e, s, p) => e.fade(s, p) },
  normalize: { params: { peak: { value: -1, min: -24, max: 0, unit: 'dB' } }, run: (e, s, p) => e.normalize(s, p) },
  width: { params: { width: { value: 1.5, min: 0, max: 3 } }, run: (e, s, p) => e.width(s, p.width) },
  granular: { params: null, run: (e, s, p) => e.granular(s, p) },   // (params: edit.js's own)
  freeze: { params: null, run: (e, s, p) => e.freeze(s, p) },
};
function fxPanel() {
  const fx = M.effects, ed = M.edit;
  if (fx.__error) return h('p', { class: 'note' }, `effects.js does not load: ${fx.__error}`);
  const effectNames = Object.keys(fx.PARAMS ?? {}).length ? Object.keys(fx.PARAMS) : ['eq', 'compressor', 'limiter', 'saturate', 'delay', 'chorus', 'flanger', 'phaser', 'reverb'].filter((k) => typeof fx[k] === 'function');
  const editNames = Object.keys(EDITS).filter((k) => typeof ed[k] === 'function');
  const wrap = h('div'), body = h('div');
  const run = () => {
    const src = S.fxSource; if (!src) { status('pick a source first'); return; }
    if (FX.dry) { S.renderMs = 0; show(src, `${S.fxName} (dry)`); return; }
    try {
      show(timed(() => FX.chain.reduce((s, c) => (c.off ? s : c.kind === 'edit' ? EDITS[c.name].run(ed, s, c.vals) : fx[c.name](s, c.name === 'eq' ? [c.vals] : c.vals)), src)), `${S.fxName} → ${FX.chain.filter((c) => !c.off).map((c) => c.name).join(' → ') || 'dry'}`);
    } catch (e) { status(`effects: ${e.message}`); }
  };
  let pending = null;
  const later = (fin) => { if (fin) { clearTimeout(pending); pending = setTimeout(run, 60); } };
  const draw = () => {
    body.replaceChildren(...FX.chain.map((c, i) => {
      const sch = c.kind === 'edit' ? EDITS[c.name].params ?? ed.PARAMS[c.name] : c.name === 'eq' ? (fx.PARAMS?.eq?.band ?? fx.PARAMS?.eq ?? { type: { value: 'peak', options: ['lowpass', 'highpass', 'lowshelf', 'highshelf', 'peak', 'notch'] }, f: guess('f', 1000), gain: guess('gain', 6), q: { value: 1, min: 0.1, max: 18, curve: 'log' } }) : schema(fx.PARAMS?.[c.name], fx[c.name]);
      for (const [k, d] of Object.entries(sch)) if (!(k in c.vals)) c.vals[k] = d.value;
      const r = rack(c.name, sch, c.vals, later, [
        h('button', { on: { click: () => { c.off = !c.off; draw(); run(); } } }, c.off ? 'on' : 'bypass'),
        h('button', { on: { click: () => { if (i > 0) { [FX.chain[i - 1], FX.chain[i]] = [FX.chain[i], FX.chain[i - 1]]; draw(); run(); } } } }, '↑'),
        h('button', { on: { click: () => { FX.chain.splice(i, 1); draw(); run(); } } }, '✕')]);
      r.classList.add('fx-card'); if (c.off) r.classList.add('off');
      return r;
    }));
  };
  const add = h('select', { on: { change: () => { const [kind, name] = add.value.split(':'); if (name) { FX.chain.push({ kind, name, vals: {} }); draw(); run(); } add.value = ''; } } },
    h('option', { value: '' }, '+ add…'), h('optgroup', { label: 'effects' }, effectNames.map((n) => h('option', { value: `fx:${n}` }, n))), h('optgroup', { label: 'editing' }, editNames.map((n) => h('option', { value: `edit:${n}` }, n))));
  const srcLabel = h('span', { class: 'mono dim' }, S.fxName || 'no source yet');
  wrap.append(
    h('div', { class: 'row' }, h('b', {}, 'Source'), srcLabel,
      h('button', { on: { click: async () => { const f = await pick(/\.(wav|mp3|flac|ogg|aiff?)$/i); if (!f) return; S.fxSource = await sample(f.lib, f.path); S.fxName = f.name; srcLabel.textContent = f.name; run(); } } }, 'Pick a sample…'),
      h('button', { on: { click: () => { if (S.sound) { S.fxSource = S.sound; S.fxName = S.soundName || 'sound'; srcLabel.textContent = S.fxName; run(); } } } }, 'Use the current sound')),
    h('div', { class: 'row' }, add, h('button', { on: { click: run } }, 'Render ▶'), h('button', { on: { click: (e) => { FX.dry = !FX.dry; e.target.classList.toggle('on', FX.dry); run(); } } }, 'A/B: dry')),
    body);
  draw();
  return wrap;
}

// ---------------------------------------------------------------- Sampler
const SM = { instrument: null, name: '' };
function samplerNote(note) { if (SM.instrument) try { blip(SM.instrument.render([{ t: 0, dur: KB.len, note, vel: KB.vel }], { sr: SR })); } catch (e) { status(`sampler: ${e.message}`); } }
function samplerPanel() {
  const sm = M.sampler;
  const wrap = h('div');
  if (sm.__error) { wrap.append(h('p', { class: 'note' }, `sampler.js does not load: ${sm.__error}`)); return wrap; }
  const label = h('span', { class: 'mono dim' }, SM.name || 'no instrument');
  // an instrument the server made (an SFZ imported, a folder as a kit, a folder of samples named by note): its samples
  // fetched and decoded, then played. A folder of named samples can hold several (a harpsichord's stops): pick one.
  const families = h('select', { hidden: '' }), octave = h('select', { title: 'Shift the named notes: libraries differ on which C is middle C' },
    [-12, 0, 12, 24, 48].map((k) => h('option', { value: k }, `notes ${k > 0 ? '+' : ''}${k}`)));
  octave.value = '0';
  const load = async (kind, f) => {
    status(`importing ${f.name}…`);
    try {
      const q = kind === 'named' ? `?octave=${octave.value}` : '';
      const r = await (await fetch(`/${kind}/${f.lib}/${f.path.split('/').map(encodeURIComponent).join('/')}${q}`)).json();
      if (r.error) throw new Error(r.error);
      families.replaceChildren(...r.instruments.map((x, i) => h('option', { value: i }, x.name)));
      families.hidden = r.instruments.length < 2;
      families.onchange = () => use(r, f, r.instruments[+families.value]);
      await use(r, f, r.instruments[0]);
    } catch (e) { status(`sampler: ${e.message}`); }
  };
  const use = async (r, f, inst) => {
    try {
      const names = [...new Set(inst.regions.map((x) => x.sample).filter(Boolean))], samples = {};
      let done = 0;
      await Promise.all(names.map(async (n) => { try { samples[n] = await sample(f.lib, join(r.dir, n)); } catch { /* missing: the sampler lists it */ } status(`samples ${++done} / ${names.length}`); }));
      SM.instrument = sm.sampler(inst, samples); SM.name = inst.name ?? f.name;
      const missing = SM.instrument.missing?.length ?? 0;
      label.textContent = `${SM.name} · ${inst.regions.length} regions · ${Object.keys(samples).length} samples${missing ? ` · ${missing} missing` : ''}`;
      status('ready: play the keyboard (A W S E D F T G Y H U J K, Z/X octave)');
    } catch (e) { status(`sampler: ${e.message}`); }
  };
  const demo = () => {
    if (!SM.instrument) return;
    const N = [], o = (KB.octave - 4) * 12;
    [[48, 55, 60, 64], [45, 52, 57, 60], [41, 48, 53, 57], [43, 50, 55, 59]].forEach((c, i) => c.forEach((n) => N.push({ t: i * 1.2, dur: 1.1, note: n + o, vel: 0.55 + 0.1 * (i % 2) })));
    [72, 74, 76, 79, 76, 74, 72, 71].forEach((n, i) => N.push({ t: i * 0.6, dur: 0.55, note: n + o, vel: 0.7 }));
    try { show(timed(() => SM.instrument.render(N, { sr: SR })), `${SM.name} · phrase`); } catch (e) { status(`sampler: ${e.message}`); }
  };
  wrap.append(h('p', { class: 'note' }, 'Load an SFZ, make a drum kit from a folder of one-shots, or an instrument from a folder of samples named by note, then play it on the keyboard. The CC0 finds are in the cc0 library (top of the browser): keys/, instruments/vsco2ce-selected/ (SFZ), drums/, foley/. VCSL folders are named notes: the upright wants notes +12.'),
    h('div', { class: 'row' }, h('button', { on: { click: async () => { const f = await pick(/\.sfz$/i); if (f) load('import', f); } } }, 'Load an SFZ…'),
      h('button', { on: { click: async () => { const f = await pickFolder(); if (f) load('kit', f); } } }, 'Kit from a folder…'),
      h('button', { title: 'A folder of samples named by note (C3_vl2_rr1.wav…), as VCSL is: no SFZ needed', on: { click: async () => { const f = await pickFolder(); if (f) load('named', f); } } }, 'Notes from a folder…'),
      octave, families),
    h('div', { class: 'row' }, h('button', { on: { click: demo } }, 'Play phrase'), label),
    keyboard((n) => samplerNote(n)));
  return wrap;
}
// the sample browser, for a folder: resolves to { lib, path, name } of the folder it was in when "Use this folder" was pressed
function pickFolder() {
  return new Promise((resolve) => {
    let done = false;
    const use = h('button', { style: 'margin-left:8px', on: { click: () => { done = true; resolve(PICK.at); $('#browser').hidden = true; use.remove(); } } }, 'Use this folder');
    $('#browser header').append(use);
    pick(/^$/).then((f) => { use.remove(); if (!done) resolve(f); });
  });
}
const join = (a, b) => { const out = []; for (const p of `${a}/${b}`.split('/')) { if (!p || p === '.') continue; if (p === '..') out.pop(); else out.push(p); } return out.join('/'); };

// ---------------------------------------------------------------- tabs
function draw() {
  const panel = $('#panel');
  const make = { fx: fxPanel, sampler: samplerPanel }[S.tab];
  try { panel.replaceChildren(make()); } catch (e) { panel.replaceChildren(h('p', { class: 'note' }, `${S.tab}: ${e.message}`)); console.error(e); }
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b)); draw(); }));
$('#play').onclick = () => play(); $('#stop').onclick = stop;
$('#save').onclick = () => { if (!S.sound) return; const a = h('a', { href: URL.createObjectURL(wav(S.sound)), download: `${(S.soundName || 'sound').replace(/[^\w.-]+/g, '-')}.wav` }); a.click(); };
$('#toFx').onclick = () => { if (!S.sound) return; S.fxSource = S.sound; S.fxName = S.soundName || 'sound'; S.tab = 'fx'; document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'fx')); draw(); };
$('#reload').onclick = async () => { await load(); draw(); };
window.addEventListener('resize', () => { if (S.sound) { drawWave(S.sound); drawSpec(S.sound); } });

await load();
draw();
