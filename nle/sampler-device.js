// The Ephemeris Sampler's device (the Instrument panel's, instrument.js): its zones as a stack of bars over the keys,
// one row each — a bar spans the keys it plays (or, in the Velocity view, the velocities); drag its edges to change them,
// the bar to move it (its root key with it), its ◆ to set the key the recording is at; drop a sound on a row to swap its
// sample, on the empty space (or a key) to make a zone there. Under the stack, the selected zone: its sample's waveform
// with where it starts, ends and loops to drag, its pitch, level, pan and how it plays; and the instrument's amp
// envelope, by its points. Every change is one edit, made when a drag ends (ctx.samplerChange saves the instrument).
import { knob, seg, fmt } from './knobs.js';
import { envEditor, sampleEditor } from './displays.js';
import { fromNorm, toNorm } from './device.js';

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (k === 'on') for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f); else if (k === 'class') e.className = v; else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);
export const noteName = (k) => `${NAMES[((k % 12) + 12) % 12]}${Math.floor(k / 12) - 1}`;
const short = (n) => String(n ?? '').replace(/^.*\//, '').replace(/\.(wav|flac|mp3|ogg|aiff?)$/i, '');
const range = (a, b, name = noteName) => (a === b ? name(a) : `${name(a)}–${name(b)}`);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const keysOf = (r) => r.key ?? [0, 127];
const velsOf = (r) => r.vel ?? [1, 127];
const MODES = ['none', 'oneshot', 'sustain', 'continuous'];
const MODE_LABEL = { none: 'Held', oneshot: 'One-shot', sustain: 'Loop held', continuous: 'Loop' };
const MODE_TITLE = { none: 'Plays while the note is held', oneshot: 'Plays to its end, however short the note', sustain: 'Loops while the note is held, then plays on', continuous: 'Loops until the note ends' };
const ENV = { a: { value: 0.002, min: 0.001, max: 5, curve: 'log', unit: 's' }, h: { value: 0, min: 0, max: 2, step: 0.001, unit: 's' }, d: { value: 0.5, min: 0.001, max: 10, curve: 'log', unit: 's' }, s: { value: 1, min: 0, max: 1, step: 0.01 }, r: { value: 0.05, min: 0.005, max: 10, curve: 'log', unit: 's' } };
const ENV_NAME = { a: 'Attack', h: 'Hold', d: 'Decay', s: 'Sustain', r: 'Release' };
export const MEDIA_TYPE = 'application/x-ephemeris-media';   // (what a drag from the Assets panel carries: app.js)
/** Whether a browser drag carries a project sound or files from the computer. */
export const carriesSoundDrop = (e) => {
  const dt = e?.dataTransfer;
  return !!dt && ([...(dt.types ?? [])].some((t) => t === MEDIA_TYPE || t === 'Files') || (dt.files?.length ?? 0) > 0);
};

/** The device for ctx.st.sampler ({ data, dir, samples, inst }; data.regions: its zones). ctx: { st, samplerChange(desc,
 *  fn, { only }), play(note), sample(url) → sound, sampleUrl(s, name), soundsOf(e) → [src] (a drop's sounds, brought into
 *  the project), redraw() }. The element's hit(note) lights the zones a note played. */
export function samplerDevice(ctx) {
  const { st } = ctx, s = st.sampler, regs = s.data.regions;
  st.zview ??= 'keys';
  const vel = st.zview === 'vel';
  if (st.zone >= regs.length) st.zone = regs.length - 1;

  // ---------- the axis: keys k0–k1 shown (fitted to the zones, or as zoomed), or the velocities 1–127
  const used = regs.flatMap(keysOf).filter((k) => k > 0 && k < 127);
  const fit = () => {
    let a = used.length ? Math.min(...used) - 3 : 36, b = used.length ? Math.max(...used) + 3 : 84;
    if (b - a < 36) { const c = (a + b) / 2; a = Math.round(c - 18); b = a + 36; }
    return [clamp(a, 0, 127 - 12), clamp(b, 12, 127)];
  };
  const [k0, k1] = st.zr ?? fit();
  const lo = vel ? 1 : k0, n = vel ? 127 : k1 - k0 + 1;
  const pct = (k) => ((k - lo) / n) * 100;
  const span = (a, b) => { const x = Math.max(a, lo), y = Math.min(b, lo + n - 1); return y < x ? null : { left: pct(x), width: ((y - x + 1) / n) * 100 }; };
  const at = (e, laneEl) => { const r = laneEl.getBoundingClientRect(); return clamp(lo + Math.floor(((e.clientX - r.left) / r.width) * n), lo, lo + n - 1); };
  const rangeOf = (r) => (vel ? velsOf(r) : keysOf(r));
  const say = (a, b) => (vel ? (a === b ? `${a}` : `${a}–${b}`) : range(a, b));

  // ---------- the stack: a row per zone (its name, its bar) — only those in view made (a program of 1362 zones is a few
  // dozen rows on screen), the rest as the stack is scrolled
  const ROW = 21;   // (a row's height, its line included: .zs-row)
  const rows = h('div', { class: 'zs-rows' }), list = h('div', { class: 'zs-list', style: `height:${regs.length * ROW}px` });
  const bars = [], made = new Map();
  /** A changed sampler heard as it is dragged: fn(data) on a copy. */
  const draft = (fn) => { const d = structuredClone(s.data); fn(d); ctx.preview(d); };
  function rowOf(i) {
    const r = regs[i], [a, b] = rangeOf(r), sp = span(a, b), sel = i === st.zone;
    // (its round robin turn, velocities and release, short: 1/3 · v0–13 · rel)
    const tags = [r.rr?.length > 1 ? `${r.rr.position}/${r.rr.length}` : null, !vel && r.vel ? `v${r.vel[0]}–${r.vel[1]}` : null, r.trigger === 'release' ? 'rel' : null].filter(Boolean);
    const name = h('div', { class: 'zs-name', title: `${r.sample ?? 'no sample'}${r.rr?.length > 1 ? ` · round robin ${r.rr.position} of ${r.rr.length}` : ''}${r.vel ? ` · velocities ${r.vel[0]}–${r.vel[1]}` : ''}${r.trigger === 'release' ? ' · plays when the note ends' : ''}` },
      h('span', { class: 'zs-i' }, i + 1), h('b', {}, short(r.sample) || 'no sample'), tags.length ? h('em', {}, tags.join(' ')) : null,
      h('span', { class: 'zs-acts' },
        h('button', { class: 'zs-act', title: 'Hear it at its root key', on: { click: (e) => { e.stopPropagation(); ctx.play(r.root ?? a); } } }, '▶'),
        h('button', { class: 'zs-act x', title: 'Remove this zone', on: { click: (e) => { e.stopPropagation(); remove(i); } } }, '×')));
    const lane = h('div', { class: 'zs-lane' });
    if (sp) {
      const bar = h('div', { class: `zbar${sel ? ' sel' : ''}${r.trigger === 'release' ? ' rel' : ''}`, style: `left:${sp.left}%;width:${sp.width}%`, 'data-keys': keysOf(r).join(' '), 'data-vels': velsOf(r).join(' '),
        title: `${short(r.sample)} · ${say(a, b)} · drag: move · edges: ${vel ? 'velocities' : 'keys'}${vel ? '' : ' · ◆: root key'} · double-click: hear` },
      h('i', { class: 'zedge l' }), h('span', { class: 'zbar-text' }, say(a, b)), h('i', { class: 'zedge r' }));
      if (!vel) {
        const root = r.root ?? 60;
        if (sel && root >= a && root <= b) bar.append(h('i', { class: 'zroot', style: `left:${((root - Math.max(a, lo) + 0.5) / (Math.min(b, lo + n - 1) - Math.max(a, lo) + 1)) * 100}%`, title: `Root ${noteName(root)}: the key the recording is at · drag it` }));
      }
      bar.addEventListener('pointerdown', (e) => grab(e, i, bar, lane));
      bar.addEventListener('dblclick', () => ctx.play(r.root ?? a));
      lane.append(bar);
      bars[i] = bar;
    } else lane.append(h('div', { class: 'zoff' }, a < lo ? '◂' : '▸'));
    const row = h('div', { class: `zs-row${sel ? ' sel' : ''}`, style: `top:${i * ROW}px` }, name, lane);
    row.addEventListener('pointerdown', (e) => { if (e.button === 0 && !e.target.closest('.zbar, button')) pick(i); });
    dropOn(row, (srcs) => { if (srcs[0]) swap(i, srcs[0]); }, () => `swap ${short(r.sample)}`, lane);
    return row;
  }
  // the rows in view (and a few either side) made, the others let go
  function fill() {
    const top = rows.scrollTop, a = Math.max(0, Math.floor(top / ROW) - 8), b = Math.min(regs.length - 1, Math.ceil((top + (rows.clientHeight || 400)) / ROW) + 8);
    for (const [i, row] of made) if (i < a || i > b) { row.remove(); made.delete(i); delete bars[i]; }
    for (let i = a; i <= b; i++) if (!made.has(i)) { const row = rowOf(i); made.set(i, row); list.append(row); }
  }
  rows.append(list);
  rows.addEventListener('scroll', () => requestAnimationFrame(fill));
  // the empty row at the bottom: drop a sound at a key to make a zone there
  const addLane = h('div', { class: 'zs-lane add' }, h('span', {}, regs.length ? `Drop sounds here to add zones${vel ? '' : ' at the keys they land on'}` : ''));
  const addRow = h('div', { class: `zs-row add${regs.length ? '' : ' empty'}` },
    h('div', { class: 'zs-name add' }, regs.length ? '+ Drop a sound' : 'No zones yet'), addLane);
  const own = (p) => short(p).replace(/\.sfz$/i, '');
  if (!regs.length) addLane.replaceChildren(s.partOf?.length
    // (an SFZ that is part of a program: its keys and samples are the program's, so alone it has none)
    ? h('div', { class: 'zs-empty' }, h('b', {}, `${own(s.path)} has no zones of its own`),
      h('span', {}, `It is part of ${s.partOf.map(own).join(' and ')}, which sets its keys and samples. Load that instead, or drop sounds here to build your own.`),
      h('div', { class: 'zs-empty-acts' }, s.partOf.slice(0, 3).map((p) => h('button', { class: 'btn', title: p, on: { click: () => ctx.load(p) } }, `Load ${own(p)}`))))
    : s.key !== 'new' ? h('div', { class: 'zs-empty' }, h('b', {}, 'This instrument has no zones'), h('span', {}, 'Drop sounds here to build it, from the Assets panel or your computer, or choose another from the Library.'))
    : h('div', { class: 'zs-empty' }, h('b', {}, 'Drop sounds here'), h('span', {}, 'from Assets or your computer. Each sound goes on the key you drop it on. Stretch it across the keys it should play.')));
  dropOn(addRow, (srcs, e) => add(srcs, vel ? 60 : at(e, addLane)), (e) => (vel ? 'new zone' : `new zone at ${noteName(at(e, addLane))}`), addLane);
  rows.append(addRow);

  // ---------- the axis row: zoom, and the keys (they play, and show the selected zone's) or the velocity scale
  const sz = regs[st.zone];
  const axisLane = h('div', { class: `zs-axis${vel ? ' vel' : ''}` });
  if (vel) for (const v of [1, 32, 64, 96, 127]) axisLane.append(h('span', { class: 'zs-tick', style: `left:${pct(v)}%` }, v));
  else for (let k = k0; k <= k1; k++) {
    const inSel = sz && k >= keysOf(sz)[0] && k <= keysOf(sz)[1], isRoot = sz && k === (sz.root ?? 60);
    const key = h('div', { class: `zk${BLACK.has(k % 12) ? ' b' : ''}${inSel ? ' in' : ''}${isRoot ? ' root' : ''}`, style: `left:${pct(k)}%;width:${100 / n}%`, title: noteName(k), 'data-k': k },
      k % 12 === 0 ? h('span', {}, noteName(k)) : null);
    key.addEventListener('pointerdown', (e) => { if (e.button === 0) { key.classList.add('on'); ctx.play(k); } });
    for (const ev of ['pointerup', 'pointerleave']) key.addEventListener(ev, () => key.classList.remove('on'));
    axisLane.append(key);
  }
  if (!vel) dropOn(axisLane, (srcs, e) => add(srcs, at(e, axisLane)), (e) => `new zone at ${noteName(at(e, axisLane))}`, axisLane);
  const zoom = (f, around) => {
    if (vel) return;
    const [a, b] = st.zr ?? fit(), c = around ?? (a + b) / 2, w = clamp(Math.round((b - a) * f), 12, 127);
    const na = clamp(Math.round(c - (c - a) * (w / (b - a))), 0, 127 - w);
    st.zr = [na, na + w]; ctx.redraw();
  };
  const axisName = h('div', { class: 'zs-name axis' },
    vel ? h('span', { class: 'dim' }, 'Velocity') : h('div', { class: 'seg mini' },
      h('button', { title: 'Zoom out (Ctrl+wheel over the zones)', on: { click: () => zoom(1.5) } }, '−'),
      h('button', { title: 'Fit the zones', on: { click: () => { st.zr = null; ctx.redraw(); } } }, 'Fit'),
      h('button', { title: 'Zoom in', on: { click: () => zoom(1 / 1.5) } }, '+')),
    h('span', { class: 'grow' }), vel ? null : h('span', { class: 'dim mono' }, range(k0, k1)));
  const axisRow = h('div', { class: 'zs-row axis' }, axisName, axisLane);
  // (Ctrl+wheel zooms the keys at the pointer, a sideways wheel or Shift+wheel moves along them, middle-drag pans: as in the timeline)
  // (the keys stay in view under the zones, inside their scroller so the two line up whatever its scrollbar takes)
  rows.append(axisRow);
  const stack = h('div', { class: 'zs' }, rows);
  // the lanes' columns: the black keys' darker, a line at each C (as the piano roll's rows)
  if (!vel) {
    const stops = [];
    for (let k = k0; k <= k1; k++) {
      const c = BLACK.has(k % 12) ? '#0c0c0c' : '#151515', a = pct(k).toFixed(3), b = pct(k + 1).toFixed(3);
      stops.push(k % 12 === 0 ? `#262626 ${a}%, #262626 calc(${a}% + 1px), ${c} calc(${a}% + 1px), ${c} ${b}%` : `${c} ${a}%, ${c} ${b}%`);
    }
    stack.style.setProperty('--keys', `linear-gradient(to right, ${stops.join(', ')})`);
  }
  stack.addEventListener('wheel', (e) => {
    if (vel) return;
    const lane = axisLane, r = lane.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(Math.exp(e.deltaY * 0.002), lo + ((e.clientX - r.left) / r.width) * n); }
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault(); const [a, b] = st.zr ?? fit(), d = Math.round(((e.deltaX || e.deltaY) / r.width) * n * 1.5) || Math.sign(e.deltaX || e.deltaY);
      const na = clamp(a + d, 0, 127 - (b - a)); st.zr = [na, na + (b - a)]; ctx.redraw();
    }
  }, { passive: false });
  stack.addEventListener('pointerdown', (e) => {
    if (e.button !== 1 || vel) return;
    e.preventDefault();
    const r = axisLane.getBoundingClientRect(), x0 = e.clientX, [a, b] = st.zr ?? fit();
    stack.setPointerCapture(e.pointerId); stack.style.cursor = 'grabbing';
    const move = (ev) => { const d = Math.round(((x0 - ev.clientX) / r.width) * n), na = clamp(a + d, 0, 127 - (b - a)); if (na !== (st.zr ?? [a])[0]) { st.zr = [na, na + (b - a)]; ctx.redraw(); } };
    const up = () => { stack.removeEventListener('pointermove', move); stack.removeEventListener('pointerup', up); stack.style.cursor = ''; };
    stack.addEventListener('pointermove', move); stack.addEventListener('pointerup', up);
  });

  // ---------- a bar dragged: by an edge, its range; by its body, moved; by its ◆, its root key
  function grab(e, i, bar, lane) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const r = regs[i], [a, b] = rangeOf(r), from = at(e, lane), t = e.target.classList, min = vel ? 1 : 0, max = 127;
    const how = t.contains('zroot') ? 'root' : t.contains('l') ? 'from' : t.contains('r') ? 'to' : 'move';
    let na = a, nb = b, root = r.root ?? 60, moved = false, last = 0;
    bar.setPointerCapture(e.pointerId); bar.classList.add('drag');
    const text = bar.querySelector('.zbar-text'), rootEl = bar.querySelector('.zroot');
    const move = (ev) => {
      const d = at(ev, lane) - from;
      if (how === 'root') root = clamp((r.root ?? 60) + d, a, b);
      else if (how === 'from') na = clamp(a + d, min, b);
      else if (how === 'to') nb = clamp(b + d, a, max);
      else { const dd = clamp(d, min - a, max - b); na = a + dd; nb = b + dd; }
      moved = moved || d !== 0;
      const sp = span(na, nb);
      if (sp) { bar.style.left = `${sp.left}%`; bar.style.width = `${sp.width}%`; }
      text.textContent = how === 'root' ? `root ${noteName(root)}` : say(na, nb);
      if (rootEl) rootEl.style.display = how === 'root' || how === 'move' ? '' : 'none';
      if (rootEl && how === 'root') rootEl.style.left = `${((root - Math.max(a, lo) + 0.5) / (Math.min(b, lo + n - 1) - Math.max(a, lo) + 1)) * 100}%`;
      if (d !== last) { last = d; draft((dd) => { const z = dd.regions[i]; if (how === 'root') z.root = root; else if (vel) z.vel = [na, nb]; else { z.key = [na, nb]; if (how === 'move') z.root = (z.root ?? a) + (na - a); } }); }
    };
    const up = () => {
      bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up);
      bar.classList.remove('drag');
      if (!moved || (how === 'root' ? root === (r.root ?? 60) : na === a && nb === b)) { if (st.zone !== i) pick(i); return; }
      st.zone = i;
      const what = short(r.sample);
      if (how === 'root') return ctx.samplerChange(`${what}: root ${noteName(r.root ?? 60)} → ${noteName(root)}`, (dd) => { dd.regions[i].root = root; });
      ctx.samplerChange(how === 'move' ? `${what} moved to ${say(na, nb)}` : `${what} plays ${vel ? 'velocities ' : ''}${say(na, nb)} (was ${say(a, b)})`, (dd) => {
        const z = dd.regions[i];
        if (vel) z.vel = [na, nb];
        else { z.key = [na, nb]; if (how === 'move') z.root = (z.root ?? a) + (na - a); }
      });
    };
    bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
  }
  function pick(i) { st.zone = i; ctx.redraw(); }
  function remove(i) {
    const r = regs[i];
    st.zone = Math.max(0, Math.min(st.zone, regs.length - 2));
    ctx.samplerChange(`zone ${i + 1} (${short(r.sample)}) removed`, (d) => { d.regions.splice(i, 1); });
  }
  function swap(i, src) {
    st.zone = i;
    ctx.samplerChange(`zone ${i + 1} plays ${short(src)} (was ${short(regs[i].sample)})`, (d) => { d.regions[i].sample = ctx.nameOf(src); });
  }
  // new zones at key k (several sounds: a key each, upwards). A short sound (under a second and a half) is a hit: it
  // plays out, at its own pitch on every key; a longer one is pitched by the key and plays while the note is held.
  async function add(srcs, k) {
    if (!srcs.length) return;
    const zs = [];
    for (const [j, src] of srcs.entries()) {
      let len = 0;
      try { const snd = await ctx.sample(ctx.sampleUrl({ dir: 'instruments' }, ctx.nameOf(src))); len = snd.ch[0].length / snd.sr; } catch { /* (unreadable: as a hit) */ }
      const key = clamp(k + j, 0, 127);
      zs.push(len && len >= 1.5 ? { sample: ctx.nameOf(src), key: [key, key], root: key } : { sample: ctx.nameOf(src), key: [key, key], root: key, keytrack: 0, loop: { mode: 'oneshot' } });
    }
    st.zone = regs.length + zs.length - 1; st.reveal = true;
    ctx.samplerChange(zs.length === 1 ? `a zone at ${noteName(zs[0].key[0])}: ${short(srcs[0])}` : `${zs.length} zones from ${noteName(zs[0].key[0])}`, (d) => { d.regions.push(...zs); }, { only: !regs.length });
  }
  // a place a sound can be dropped on: what the drop does, and a hint while it is over it
  function dropOn(target, apply, hint, within = target) {
    target.addEventListener('dragover', (e) => {
      if (!carriesSoundDrop(e)) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy';
      target.classList.add('drop'); target.dataset.hint = hint(e);
      if (within !== target) within.dataset.hint = hint(e);
    });
    target.addEventListener('dragleave', (e) => { if (!target.contains(e.relatedTarget)) target.classList.remove('drop'); });
    target.addEventListener('drop', async (e) => {
      if (!carriesSoundDrop(e)) return;
      e.preventDefault(); e.stopPropagation(); target.classList.remove('drop');
      const srcs = await ctx.soundsOf(e);
      if (srcs.length) apply(srcs, e);
    });
  }

  // ---------- the selected zone: its sample (start, end, loop), pitch, level, pan, how it plays
  function zonePanel() {
    const i = st.zone, r = regs[i];
    if (!r) return h('div', { class: 'dsec zone empty' }, h('div', { class: 'dsec-head' }, h('b', {}, 'Zone')), h('div', { class: 'dsec-none' }, regs.length ? 'Select a zone.' : 'Drop a sound on the stack to make the first zone.'));
    const set = (desc, fn) => ctx.samplerChange(`zone ${i + 1} ${desc}`, (d) => fn(d.regions[i]));
    const wave = h('div', { class: 'zs-wave' });
    const showWave = (snd) => wave.replaceChildren(sampleEditor(snd, r, (k, v, final) => {
      const mut = (z) => {
        if (k === 'offset') { if (v > 0) z.offset = v; else delete z.offset; } else if (k === 'end') z.end = v;
        else z.loop = { ...(z.loop ?? { mode: 'sustain' }), [k === 'loopStart' ? 'start' : 'end']: v };
      };
      if (!final) return draft((dd) => mut(dd.regions[i]));   // (heard as it is dragged)
      const was = { offset: r.offset ?? 0, end: r.end, loopStart: r.loop?.start, loopEnd: r.loop?.end }[k];
      set(`${{ offset: 'start', end: 'end', loopStart: 'loop start', loopEnd: 'loop end' }[k]} ${was != null ? `${(+was).toFixed(3)} → ` : ''}${v.toFixed(3)} s`, mut);
    }).el);
    showWave(undefined);
    if (r.sample) ctx.sample(ctx.sampleUrl(s, r.sample)).then(showWave, () => showWave(null));
    const [a, b] = keysOf(r), [vl, vh] = velsOf(r);
    // (a knob: heard as it turns, the edit made when it is let go)
    const K = (name, d, v, desc, mut) => knob(name, d, v, (x, final) => (final ? set(desc(x), (z) => mut(z, x)) : draft((dd) => mut(dd.regions[i], x))));
    const pitched = r.keytrack !== 0;
    return h('div', { class: 'dsec zone' },
      h('div', { class: 'dsec-head' }, h('span', { class: 'zs-i' }, i + 1), h('b', {}, short(r.sample) || 'no sample'),
        h('span', { class: 'dim' }, r.sample?.startsWith('library/') || s.dir?.startsWith('library') ? 'from the library' : 'the project\'s'), h('span', { class: 'grow' }),
        h('span', { class: 'zs-facts mono' }, `keys ${range(a, b)} · root ${noteName(r.root ?? 60)} · vel ${vl}–${vh}`),
        h('button', { class: 'tog', title: 'Hear it at its root key', on: { click: () => ctx.play(r.root ?? a) } }, '▶ Hear'),
        h('button', { class: 'tog', title: 'Remove this zone', on: { click: () => remove(i) } }, 'Remove')),
      wave,
      h('div', { class: 'zs-ctl' },
        h('div', { class: 'zs-opt' }, h('span', { class: 'lbl' }, 'Pitch'), seg(['key', 'fixed'], pitched ? 'key' : 'fixed', (v) => set(v === 'key' ? 'follows the keys' : 'plays at its own pitch', (z) => { if (v === 'key') delete z.keytrack; else z.keytrack = 0; }),
          { labels: { key: 'Follows keys', fixed: 'Fixed' }, titles: { key: 'Pitched by the key it is played at, from its root', fixed: 'Every key plays it as it is (a drum hit)' } })),
        h('div', { class: 'zs-opt' }, h('span', { class: 'lbl' }, 'Plays'), seg(MODES, r.loop?.mode ?? 'none', (v) => set(`plays ${MODE_LABEL[r.loop?.mode ?? 'none']} → ${MODE_LABEL[v]}`, (z) => { if (v === 'none') delete z.loop; else z.loop = { ...z.loop, mode: v }; }), { labels: MODE_LABEL, titles: MODE_TITLE })),
        h('div', { class: 'zs-knobs' },
          K('Tune', { value: 0, min: -1200, max: 1200, step: 1, unit: 'ct' }, r.tune ?? 0, (v) => `tune ${v} cents`, (z, v) => { if (v) z.tune = v; else delete z.tune; }),
          K('Level', { value: 0, min: -24, max: 12, step: 0.1, unit: 'dB' }, r.gain ?? 0, (v) => `level ${v.toFixed(1)} dB`, (z, v) => { if (v) z.gain = v; else delete z.gain; }),
          K('Pan', { value: 0, min: -1, max: 1, step: 0.01 }, r.pan ?? 0, (v) => `pan ${v.toFixed(2)}`, (z, v) => { if (v) z.pan = v; else delete z.pan; }))));
  }
  // ---------- the instrument's amp envelope (every zone's, unless a zone has its own): its points, and a knob each
  function ampPanel() {
    const env = { a: 0.002, h: 0, d: 0.5, s: 1, r: 0.05, ...s.data.env };
    // (what a gesture changed, one edit: the decay's point moves the decay and the sustain)
    let ended = null;
    const set = (k, v) => {
      if (!ended) {
        ended = {};
        queueMicrotask(() => {
          const p = ended; ended = null;
          ctx.samplerChange(`amp ${Object.entries(p).map(([key, x]) => `${ENV_NAME[key].toLowerCase()} ${fmt(s.data.env?.[key] ?? ENV[key].value, ENV[key])} → ${fmt(x, ENV[key])}`).join(', ')}`, (d) => { Object.assign((d.env ??= {}), p); });
        });
      }
      ended[k] = v;
    };
    const knobs = {};
    // (heard as it is dragged: the envelope as it is now, both of a point's values)
    const hear = () => draft((d) => { d.env = { ...d.env, ...env }; });
    const ed = envEditor(env, ENV, (k, v, final) => { env[k] = v; knobs[k]?.set(v); if (!final) hear(); else if (v !== (s.data.env?.[k] ?? ENV[k].value)) set(k, v); }, { hold: true });
    // (each keyable at the playhead: its ◆; where its track automates it, turning it keys it there)
    const row = h('div', { class: 'env-knobs' }, Object.keys(ENV).map((k) => {
      const kp = ctx.param?.(`env.${k}`);
      knobs[k] = knob(ENV_NAME[k], ENV[k], kp?.automated ? fromNorm(kp.p, kp.normAt()) : env[k], (v, final) => {
        if (kp?.automated) return kp.keyAt(toNorm(kp.p, v), final);
        env[k] = v; ed.update(env); if (final) set(k, v); else hear();
      });
      kp?.follow(knobs[k], (n) => fromNorm(kp.p, n));
      return kp ? h('div', { class: 'pl-cell' }, knobs[k], kp.key) : knobs[k];
    }));
    return h('div', { class: 'dsec amp' }, h('div', { class: 'dsec-head' }, h('b', {}, 'Amp'), h('span', { class: 'dim' }, 'every zone')), ed.el, row);
  }

  // the instrument's own level, pan and tune, over every zone's (each keyable at the playhead, as the amp's are)
  function outPanel() {
    const OUT = { gain: { value: 0, min: -60, max: 12, step: 0.1, unit: 'dB' }, pan: { value: 0, min: -1, max: 1, step: 0.01 }, tune: { value: 0, min: -2400, max: 2400, step: 1, unit: 'ct' } };
    const NAME = { gain: 'Level', pan: 'Pan', tune: 'Tune' };
    return h('div', { class: 'dsec amp' }, h('div', { class: 'dsec-head' }, h('b', {}, 'Output'), h('span', { class: 'dim' }, 'every zone')), h('div', { class: 'env-knobs' }, Object.keys(OUT).map((k) => {
      const kp = ctx.param?.(k), cur = s.data[k] ?? 0;
      const kn = knob(NAME[k], OUT[k], kp?.automated ? fromNorm(kp.p, kp.normAt()) : cur, (v, final) => {
        if (kp?.automated) return kp.keyAt(toNorm(kp.p, v), final);
        if (final) ctx.samplerChange(`${NAME[k].toLowerCase()} ${fmt(cur, OUT[k])} → ${fmt(v, OUT[k])}`, (d) => { if (v) d[k] = v; else delete d[k]; });
        else draft((d) => { d[k] = v; });
      });
      kp?.follow(kn, (n) => fromNorm(kp.p, n));
      return kp ? h('div', { class: 'pl-cell' }, kn, kp.key) : kn;
    })));
  }

  const el = h('div', { class: 'smp2' }, stack, h('div', { class: 'smp-detail' }, zonePanel(), ampPanel(), outPanel()));
  fill();
  // (once it is in the page: the rows its height shows, and a zone just made brought into view)
  requestAnimationFrame(() => {
    if (st.reveal) { st.reveal = false; rows.scrollTop = Math.max(0, st.zone * ROW - rows.clientHeight / 2); }
    fill();
  });
  el.viewSeg = seg(['keys', 'vel'], st.zview, (v) => { st.zview = v; ctx.redraw(); }, { labels: { keys: 'Keys', vel: 'Velocity' }, titles: { keys: 'The zones over the keys they play', vel: 'The zones over the velocities they play at (layers)' } });
  /** Lights the zones a note plays (velocity 0.8, as the keys play it). */
  el.hit = (note) => {
    const v = Math.round(0.8 * 126) + 1;
    regs.forEach((r, i) => { const [a, b] = keysOf(r), [x, y] = velsOf(r); if (bars[i] && note >= a && note <= b && v >= x && v <= y && r.trigger !== 'release') { bars[i].classList.remove('hit'); void bars[i].offsetWidth; bars[i].classList.add('hit'); } });
  };
  return el;
}
