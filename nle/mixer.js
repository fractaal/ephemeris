// The Mixer panel: a narrow channel strip for each audio track (numbered as the timeline numbers them: A1, A2…), each
// bus (a shared effect the tracks send to: a reverb many tracks share; the project's own, named as it names them) and
// the master, kept at the right. A strip reads top to bottom as its sound flows: its instrument, which plays its notes
// clips (click it to open it in the Instrument panel, its ▾ to swap it or give the track one), its effects (a row each:
// click it to open its controls in the drawer beside the strips), its sends (how much goes to each bus), its pan, its
// fader and meter, mute and solo. Every change is an undoable edit when it ends (a drag's last value), described in plain
// words. The mixing itself is the live engine's (live.js), the one renders run, so what the strips do is what exports.
import { PARAMS } from '../engine/sound/effects.js';
import { deviceOf } from './device.js';
import { isVisual, isNotes, FX, newFx } from './model.js';
import { knob, choice, rack, fmt } from './knobs.js';
import { trackColour } from './colours.js';
import { colourOf, fall, DRAW } from './fxview.js';

const VIEWED = new Set(Object.keys(DRAW));   // (the effects that have a view)

const DB_MIN = -60, DB_MAX = 6;   // the fader's and the meter's range
const dbPos = (db) => Math.min(1, Math.max(0, (db - DB_MIN) / (DB_MAX - DB_MIN)));   // 0 bottom … 1 top
const toDb = (v) => 20 * Math.log10(Math.max(v, 1e-6));
const h = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const marked = (e, data) => { Object.assign(e.dataset, data); return e; };   // (where Claude's light finds a part: presence.js)
const button = (text, title, on) => { const b = h('button', '', text); b.title = title; b.onclick = on; return b; };
const db1 = (v) => `${(v || 0).toFixed(1)}`;
const fxName = (type) => (type === 'eq' ? 'EQ' : type[0].toUpperCase() + type.slice(1));

/** What plays an instrument, and a short name for it: device.js deviceOf, the same for the Ephemeris Sampler and a
 *  plugin (Vial, the studio's synth, among them). */
export const instrumentOf = deviceOf;

/**
 * host: the panel's body; S (S.doc: the timeline); edit(desc, fn) the editor's undoable edit; openMenu(anchor, items);
 * media(): the audio media's ids (for a reverb's impulse response); levelsAt(t) → { <track id | master>: { peak, rms } };
 * tweak(id, strip): a strip's mix heard at once, unsaved (a value being dragged: its edit is made when the drag ends);
 * views: the effects' views (fxview.js createViews: the drawer's EQ shows one);
 * openInstrument(track id, tab?): shows the track's instrument in the Instrument panel; plugins(): the plugins this
 * machine has and their presets (api/plugins: { plugins: [names], presets: { <name>: [{ state, name }] } }), for
 * swapping an instrument.
 */
export function createMixer({ host, S, edit, openMenu, media, levelsAt, tweak = () => {}, views = null, openInstrument = () => {}, plugins = async () => ({ plugins: [], presets: {} }) }) {
  const meters = new Map();   // strip id → { rms, peak, shown, top, was }
  // (whether the panel shows, kept as it changes: asked each frame, it would lay the page out again)
  let onScreen = false;
  new ResizeObserver(([e]) => { onScreen = e.contentRect.width > 0; }).observe(host);
  let down = false, stale = false;   // a pointer is down in the panel (a knob being dragged): it is not rebuilt under it
  let open = null;                   // the effect shown in the drawer: { id (strip), i (its place in the chain) }
  let shownView = null, keptView = null;   // its view (fxview.js), while the drawer shows one: kept as the drawer is made again
  host.addEventListener('pointerdown', () => { down = true; });
  host.ownerDocument.addEventListener('pointerup', () => { down = false; if (stale) render(); }, true);

  // the track, or the master, an edit is on (looked up in the document as it is then: undo replaces the document)
  // (a bus's strip id is bus:<its id>)
  const target = (doc, id, make = false) => (id === 'master' ? (make ? (doc.master ??= {}) : doc.master)
    : id.startsWith('bus:') ? (doc.buses ?? []).find((b) => b.id === id.slice(4)) : doc.tracks.find((t) => t.id === id));
  const label = (id) => (id === 'master' ? 'Master' : id.startsWith('bus:') ? `bus "${target(S.doc, id)?.name ?? id.slice(4)}"` : `"${S.doc.tracks.find((t) => t.id === id)?.name ?? id}"`);
  /** A value being dragged on a strip, heard at once: fn(owner) on a copy of the strip alone, sent straight to the live
   *  engine (not the timeline: on every move of a drag, that took the audio thread past its time), until the edit is made. */
  const preview = (id, fn) => { const o = structuredClone(target(S.doc, id) ?? {}); fn(o); tweak(id, o); };
  /** An edit on a strip: fn(owner); the master is left out of the document again when nothing is set on it. */
  const change = (id, desc, fn) => edit(desc, (doc) => {
    const o = target(doc, id, true);
    fn(o);
    for (const k of ['volume', 'pan', 'mute', 'solo']) if (!o[k]) delete o[k];
    if (o.fx && !o.fx.length) delete o.fx;
    if (o.sends && !Object.keys(o.sends).length) delete o.sends;
    if (id === 'master' && !Object.keys(o).length) delete doc.master;
  });

  // ---------- the fader: a cap on a rail, dragged (shift: finer), clicked and scrolled (as a knob is), double-clicked back to 0 dB
  function fader(id, value) {
    let v = value;
    const cap = h('i', 'fader-cap'), val = h('span', 'fader-val'), rail = h('div', 'fader-rail', h('b'), cap);
    const scale = h('div', 'fader-scale', ...[6, 0, -12, -24, -48].map((d) => { const s = h('span', '', d); s.style.bottom = `${dbPos(d) * 100}%`; return s; }));
    const box = h('div', 'fader', scale, rail);
    box.title = 'Volume: drag (shift: finer) · click, then scroll · double-click: 0 dB';
    const draw = () => { cap.style.bottom = `${dbPos(v) * 100}%`; val.textContent = db1(v); };
    const commit = (nv) => { nv = Math.round(Math.min(DB_MAX, Math.max(DB_MIN, nv)) * 10) / 10; if (nv === (target(S.doc, id)?.volume ?? 0)) return; change(id, `fader ${label(id)} ${db1(target(S.doc, id)?.volume)} → ${db1(nv)} dB`, (o) => { o.volume = nv; }); };
    let drag = null, armed = false, scrolled = 0;
    const settle = () => { if (scrolled) { clearTimeout(scrolled); scrolled = 0; commit(v); } };
    box.addEventListener('pointerleave', () => { armed = false; settle(); });
    box.addEventListener('pointerdown', (e) => {
      armed = true;
      const r = rail.getBoundingClientRect();
      if (!cap.contains(e.target)) v = Math.round((DB_MIN + (1 - (e.clientY - r.top) / r.height) * (DB_MAX - DB_MIN)) * 10) / 10;   // (a click on the rail jumps there)
      drag = { y: e.clientY, v }; box.setPointerCapture(e.pointerId); e.preventDefault(); draw();
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      v = Math.round(Math.min(DB_MAX, Math.max(DB_MIN, drag.v - (e.clientY - drag.y) / rail.clientHeight * (DB_MAX - DB_MIN) * (e.shiftKey ? 0.1 : 1))) * 10) / 10;
      draw(); preview(id, (o) => { o.volume = v; });
    });
    box.addEventListener('pointerup', () => { if (drag) { drag = null; commit(v); } });
    box.addEventListener('dblclick', () => { v = 0; draw(); commit(0); });
    box.addEventListener('wheel', (e) => { if (!armed) return; e.preventDefault(); v = Math.min(DB_MAX, Math.max(DB_MIN, v - Math.sign(e.deltaY) * (e.shiftKey ? 0.1 : 1))); draw(); preview(id, (o) => { o.volume = v; }); clearTimeout(scrolled); scrolled = setTimeout(settle, 1500); }, { passive: false });
    draw();
    return { box, val };
  }
  function meter(id) {
    const rms = h('i', 'meter-rms'), peak = h('b', 'meter-peak'), el = h('div', 'meter', rms, peak);
    meters.set(id, { rms, peak, shown: DB_MIN, top: DB_MIN, was: '', rmsFall: { level: DB_MIN, v: 0, held: 0 }, peakFall: { level: DB_MIN, v: 0, held: 0 } });
    return el;
  }

  // ---------- an effect's controls (in the drawer)
  function fxControls(id, i, fx) {
    const type = fx.type;
    const set = (key, v, dflt) => change(id, `${type} ${key} on ${label(id)} ${fmt(fx[key] ?? dflt, PARAMS[type][key])} → ${fmt(v, PARAMS[type][key])}`, (t) => { t.fx[i][key] = v; });
    if (type === 'eq') return eqBands(id, i, fx);
    const r = rack(type, PARAMS[type], fx, (k, v, final) => { if (final) set(k, v, PARAMS[type][k].value); else { preview(id, (t) => { t.fx[i][k] = v; }); shownView?.spec({ ...fx, [k]: v }); } });
    const body = r.querySelector('.rack-body'), graph = views && VIEWED.has(type) ? h('div', 'fx-graph') : null;
    if (graph) viewIn(graph, id, i, fx);
    if (type === 'reverb') {   // an impulse response of the project's, or the room made from the knobs
      const ids = media();
      body.prepend(marked(choice('Impulse', { value: 'room', options: ['room', ...ids] }, fx.ir ?? 'room', (v) => change(id, `reverb ir on ${label(id)} ${fx.ir ?? 'room'} → ${v}`, (t) => { if (v === 'room') delete t.fx[i].ir; else t.fx[i].ir = v; })), { k: 'ir' }));
    }
    if (type === 'compressor') {   // what it listens to: what it compresses, or another track (the bass ducking under the kick)
      const others = S.doc.tracks.filter((t) => !isVisual(t) && t.id !== id), name = (tid) => S.doc.tracks.find((t) => t.id === tid)?.name ?? tid;
      body.prepend(marked(choice('Sidechain', { value: 'none', options: ['none', ...others.map((t) => t.id)], labels: Object.fromEntries(others.map((t) => [t.id, t.name ?? t.id])) }, fx.sidechain ?? 'none',
        (v) => change(id, `compressor sidechain on ${label(id)} ${fx.sidechain ? name(fx.sidechain) : 'none'} → ${v === 'none' ? 'none' : name(v)}`, (t) => { if (v === 'none') delete t.fx[i].sidechain; else t.fx[i].sidechain = v; })), { k: 'sidechain' }));
    }
    return graph ? h('div', 'fx-viewed', graph, body) : body;   // (its view above its knobs)
  }
  // the EQ: its view (fxview.js: what it does to the sound, each band's own, over the sound either side of it as it
  // plays; a band's handle dragged, its Q scrolled, one added with a double-click) above a row per band — its kind, its
  // frequency, gain and Q, its removal — and a band added
  function eqBands(id, i, fx) {
    const body = h('div', 'eq-bands'), rows = [];
    const select = (j) => rows.forEach((r, k) => r.classList.toggle('sel', k === j));
    if (views) { const graph = h('div', 'eq-view'); body.append(graph); viewIn(graph, id, i, fx, select); }
    (fx.bands ?? []).forEach((b, j) => {
      const set = (key, v) => change(id, `eq band ${j + 1} ${key} on ${label(id)} ${fmt(b[key], PARAMS.eq[key])} → ${fmt(v, PARAMS.eq[key])}`, (t) => { t.fx[i].bands[j][key] = v; });
      const swatch = h('i', 'eq-swatch'); swatch.style.background = colourOf(j);
      const row = marked(h('div', 'eq-band', swatch,
        choice(`Band ${j + 1}`, PARAMS.eq.type, b.type, (v) => change(id, `eq band ${j + 1} on ${label(id)} ${b.type} → ${v}`, (t) => { t.fx[i].bands[j].type = v; })),
        ...['freq', 'gain', 'q'].map((k) => knob({ freq: 'Freq', gain: 'Gain', q: 'Q' }[k], PARAMS.eq[k], b[k], (v, final) => {
          if (final) return set(k, v);
          preview(id, (t) => { t.fx[i].bands[j][k] = v; });
          const s = structuredClone(fx); s.bands[j][k] = v; shownView?.spec(s);
        })),
        Object.assign(button('×', 'Remove this band', () => change(id, `eq band ${j + 1} removed on ${label(id)}`, (t) => { t.fx[i].bands.splice(j, 1); })), { className: 'mx-btn eq-x' })), { band: j });
      row.onpointerdown = () => { select(j); shownView?.select(j); };
      rows.push(row); body.append(row);
    });
    body.append(Object.assign(button('+ Band', 'Add a band (or double-click the view where it goes)', () => change(id, `eq band ${(fx.bands?.length ?? 0) + 1} added on ${label(id)}`, (t) => { (t.fx[i].bands ??= []).push({ type: 'peak', freq: 1000, gain: 0, q: 1 }); })), { className: 'mx-btn wide eq-add' }));
    return body;
  }
  // an effect's view (fxview.js) in el: the drawer's own, kept as the drawer is made again (its sound tapped where the
  // effect is among those on; a drag heard as it goes, an edit as it ends)
  function viewIn(el, id, i, fx, select = () => {}) {
    const o = target(S.doc, id), at = fx.on === false ? null : o.fx.slice(0, i).filter((e) => e.on !== false).length, key = `${id}:${i}`;
    const on = { select, drag: (s) => preview(id, (t) => { t.fx[i] = s; }), done: (s, what) => change(id, `${what} on ${label(id)}`, (t) => { t.fx[i] = s; }) };
    if (keptView?.key === key && keptView.type === fx.type) { shownView = keptView; el.append(shownView.el); shownView.bind(on); shownView.spec(fx); shownView.tapAt(at); }
    else shownView = views.show(el, { key, id, at, type: fx.type, spec: fx, ...on });
  }
  // the drawer: the open effect's controls, its bypass, place in the chain and removal
  function drawer() {
    const o = open && target(S.doc, open.id), fx = o?.fx?.[open.i];
    if (!fx) { open = null; return null; }
    const { id, i } = open, type = fx.type, on = fx.on !== false, n = o.fx.length;
    const head = h('header', 'mx-drawer-head',
      h('b', '', fxName(type)), h('span', 'mx-drawer-on', id === 'master' ? 'Master' : id.startsWith('bus:') ? `bus ${o.name ?? id.slice(4)}` : o.name ?? id),
      h('span', 'grow'),
      Object.assign(button('⏻', on ? 'Bypass this effect' : 'Use this effect', () => change(id, `${on ? 'bypass' : 'use'} ${type} on ${label(id)}`, (t) => { if (on) t.fx[i].on = false; else delete t.fx[i].on; })), { className: `mx-btn${on ? ' on' : ''}` }),
      Object.assign(button('↑', 'Earlier in the chain', () => { open = { id, i: i - 1 }; change(id, `move ${type} up on ${label(id)}`, (t) => { [t.fx[i - 1], t.fx[i]] = [t.fx[i], t.fx[i - 1]]; }); }), { className: 'mx-btn', disabled: i === 0 }),
      Object.assign(button('↓', 'Later in the chain', () => { open = { id, i: i + 1 }; change(id, `move ${type} down on ${label(id)}`, (t) => { [t.fx[i + 1], t.fx[i]] = [t.fx[i], t.fx[i + 1]]; }); }), { className: 'mx-btn', disabled: i === n - 1 }),
      Object.assign(button('Remove', 'Remove it from the chain', () => { open = null; change(id, `remove ${type} from ${label(id)}`, (t) => { t.fx.splice(i, 1); }); }), { className: 'mx-btn wide' }),
      Object.assign(button('×', 'Close', () => { open = null; render(); }), { className: 'mx-btn' }));
    const el = h('aside', `mx-drawer${on ? '' : ' off'}${views && VIEWED.has(type) ? ' wide' : ''}`, head, h('div', 'mx-drawer-body', fxControls(id, i, fx)));
    el.dataset.of = id; el.dataset.fx = i;
    return el;
  }

  // ---------- a track's instrument, which plays its notes clips: its device marked (Smp, VST), its ▾ to swap it (or give
  // a track that has none one)
  const BADGE = { sampler: 'Smp', plugin: 'VST' };
  function chips(t) {
    const inst = t.instrument, notes = t.clips.filter((c) => isNotes(S.doc.media[c.media])).length;
    const swap = button('▾', inst ? 'Swap the instrument' : 'Give the track an instrument (it plays its notes clips)', async (e) => {
      e.stopPropagation();
      const set = (desc, ins) => edit(`"${t.name ?? t.id}" plays ${desc}`, (d) => { d.tracks.find((x) => x.id === t.id).instrument = structuredClone(ins); });
      // (each plugin, and the studio's own presets for it: Vial's, the studio's synth)
      const { plugins: names = [], presets = {} } = await plugins();
      openMenu(swap, [
        ...names.flatMap((p) => [
          ...(presets[p] ?? []).filter((x) => x.state.startsWith('presets/')).map((x) => ({ label: `${p} · ${x.name}`, cur: inst?.plugin === p && inst.state === x.state, act: () => set(`${p} ${x.name}`, { plugin: p, state: x.state }) })),
          { label: p, cur: inst?.plugin === p && !(presets[p] ?? []).some((x) => x.state === inst.state && x.state.startsWith('presets/')), act: () => set(p, { plugin: p }) },
        ]),
        ...(inst ? ['hr', { label: 'Sampler…', hint: 'pick one in the Instrument panel', act: () => openInstrument(t.id, 'sampler') }] : []),
        ...(inst ? [{ label: 'No instrument', hint: notes ? 'its notes clips are silent' : '', act: () => edit(`"${t.name ?? t.id}" has no instrument`, (d) => { delete d.tracks.find((x) => x.id === t.id).instrument; }) }] : []),
      ]);
    });
    if (!inst) return [h('div', 'irow audio', h('span', 'irow-name', notes ? 'No instrument' : t.clips.length ? 'Audio clips' : 'No clips'), swap)];
    const { kind, name, device } = instrumentOf(inst), c = h('div', `irow ${kind}`, h('b', 'irow-kind', BADGE[kind] ?? '?'), h('span', 'irow-name', name || device), swap);
    c.title = `${device ? `${device} · ` : ''}${name} — click: open it in the Instrument panel`;
    c.onclick = () => openInstrument(t.id);
    return [c];
  }

  // ---------- a strip's effects: a slot each (the open one marked), and adding one
  function slots(id, o) {
    const list = (o?.fx ?? []).map((fx, i) => {
      const on = fx.on !== false, s = h('button', `slot${on ? '' : ' off'}${open?.id === id && open.i === i ? ' open' : ''}`, h('i'), h('span', '', fxName(fx.type)));
      s.title = `${fx.type}${on ? '' : ' (bypassed)'} — click: its controls`;
      s.dataset.fx = i;
      s.onclick = () => { open = open?.id === id && open.i === i ? null : { id, i }; render(); };
      return s;
    });
    const add = button('+ Effect', 'Add an effect to the end of the chain', () => openMenu(add, FX.map((type) => ({ label: fxName(type), act: () => { open = { id, i: (target(S.doc, id)?.fx ?? []).length }; change(id, `add ${type} to ${label(id)}`, (t) => { (t.fx ??= []).push(newFx(type)); }); } }))));
    add.className = 'slot add';
    return marked(h('div', 'slots', ...list, add), { part: 'fx' });
  }

  // ---------- a track's sends: a small knob for each bus (how much of it, after its fader, goes there; at the bottom: none)
  const SEND = { value: -12, min: -40, max: 6, step: 0.5, unit: 'dB' };
  function sends(id, o) {
    const buses = S.doc.buses ?? [];
    if (!buses.length) return null;
    return h('div', 'sends', h('div', 'mx-sub', 'Sends'), h('div', 'sends-knobs', buses.map((b) => {
      const v = o.sends?.[b.id];
      const k = knob(b.name ?? b.id, SEND, v ?? SEND.min, (x, final) => {
        const set = (t) => { t.sends ??= {}; if (x <= SEND.min) delete t.sends[b.id]; else t.sends[b.id] = x; };
        if (final) change(id, `send ${label(id)} to bus "${b.name ?? b.id}" ${v == null ? 'off' : `${v.toFixed(1)} dB`} → ${x <= SEND.min ? 'off' : `${x.toFixed(1)} dB`}`, set); else preview(id, set);
      });
      k.classList.add('mini');
      if (v == null) k.classList.add('none');
      k.title = `Send to “${b.name ?? b.id}”`;
      k.dataset.send = b.id;
      return k;
    })));
  }

  // ---------- a strip
  function strip(id, o, name, t = null, num = '') {
    const master = id === 'master', bus = id.startsWith('bus:'), f = fader(id, o?.volume ?? 0);
    const pan = master ? null : knob('Pan', { value: 0, min: -1, max: 1, step: 0.01 }, o.pan ?? 0, (v, final) => { if (final) change(id, `pan ${label(id)} ${(o.pan ?? 0).toFixed(2)} → ${v.toFixed(2)}`, (x) => { x.pan = v; }); else preview(id, (x) => { x.pan = v; }); });
    pan?.classList.add('pan');
    const flag = (k, word) => { const b = button(word[0].toUpperCase(), `${word[0].toUpperCase()}${word.slice(1)}${k === 'solo' ? ' (hear only the soloed tracks)' : ''}`, () => change(id, `${o[k] ? 'un' : ''}${word} ${label(id)}`, (x) => { x[k] = !o[k]; })); b.classList.add('flag', k); b.classList.toggle('on', !!o[k]); return b; };
    const ch = t ? chips(t) : null;
    const head = h('header', '', num ? h('span', 'strip-num', num) : null, h('span', 'strip-name', name), bus ? h('span', 'strip-tag', 'bus') : null);
    head.title = master ? 'Master' : bus ? `Bus “${name}”` : `${num} ${name}`;
    const el = h('section', `strip${master ? ' master' : bus ? ' bus' : ''}`,
      head,
      ch ? h('div', 'strip-what', ch) : null,
      slots(id, o),
      master || bus ? null : sends(id, o),
      h('div', 'strip-fader', pan ? h('div', 'strip-pan', pan) : null, h('div', 'strip-rail', meter(id), f.box), f.val),
      h('div', 'flags', master ? null : flag('mute', 'mute'), master || bus ? null : flag('solo', 'solo')));
    if (!master && !bus && S.doc.tracks.some((x) => x.solo) && !o.solo) el.classList.add('quiet');
    if (t) el.style.setProperty('--tc', trackColour(S.doc.tracks.indexOf(t)).top);   // (its head in its track's colour)
    if (o?.mute) el.classList.add('muted');
    // (where Claude's light finds what it changed: presence.js)
    el.dataset.strip = id; f.box.dataset.part = 'volume';
    if (pan) pan.dataset.part = 'pan';
    for (const b of el.querySelectorAll('.flag')) b.dataset.part = b.classList.contains('mute') ? 'mute' : 'solo';
    return el;
  }

  function render() {
    if (down) { stale = true; return; }
    stale = false;
    const was = host.querySelector('.mx-strips')?.scrollLeft ?? 0;
    meters.clear();
    const tracks = S.doc.tracks.filter((t) => !isVisual(t));
    // (a new bus: a reverb the tracks can send to)
    const addBus = button('+ Bus', 'Add a bus: a shared effect tracks can send to', () => {
      const n = (S.doc.buses ?? []).length + 1, id = `bus${n}`;
      edit(`add bus "Bus ${n}"`, (doc) => { (doc.buses ??= []).push({ id, name: `Bus ${n}`, fx: [{ ...newFx('reverb'), mix: 1 }] }); });
    });
    addBus.className = 'add-bus';
    const buses = S.doc.buses ?? [];
    const row = h('div', 'mx-strips', ...tracks.map((t, i) => strip(t.id, t, t.name, t, `A${i + 1}`)),
      h('div', 'mx-gap'), ...buses.map((b) => strip(`bus:${b.id}`, b, b.name ?? b.id)), addBus);
    // (the master outside the strips' scroller: it stays at the right, over nothing)
    keptView = shownView; shownView = null;   // (the drawer made again: its view moved into it, if it still shows the same effect)
    host.replaceChildren(row, strip('master', S.doc.master ?? {}, 'Master'), drawer() ?? '');
    if (keptView !== shownView) keptView?.close();
    keptView = null;
    row.scrollLeft = was;
  }

  /** Moves the meters to the levels at time t (the playhead): the RMS as a bar, the peak as a line held a moment, each
   *  falling as a thing dropped (fxview.js fall; dt seconds since they last moved: as fast however often they move). Each
   *  move paints the panel again. */
  function tick(t, dt) {
    if (!onScreen) return;   // (another tab is showing)
    const l = levelsAt(t);
    for (const [id, m] of meters) {
      const lv = l[id], rms = lv ? toDb(lv.rms) : DB_MIN, peak = lv ? toDb(lv.peak) : DB_MIN;
      m.shown = fall(m.rmsFall, rms, dt, 0, 360); m.top = fall(m.peakFall, peak, dt, 0.6, 60);
      const was = `${m.shown.toFixed(1)} ${m.top.toFixed(1)}`;
      if (was === m.was) continue;
      m.was = was;
      m.rms.style.clipPath = `inset(${(1 - dbPos(m.shown)) * 100}% 0 0 0)`; m.peak.style.bottom = `${dbPos(m.top) * 100}%`;
      m.peak.classList.toggle('hot', m.top > 0);
    }
  }
  return { render, tick };
}
