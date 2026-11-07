// The Instrument panel: the instrument of the selected track (or of the track the selected clip is on: track.instrument,
// which plays its notes clips), edited and auditioned. Its bar (outside the instrument itself) chooses what plays the notes — the Ephemeris Sampler or a plugin
// (Vial, the studio's synth, or another VST3) — and from what: an instrument from the sound library, a plugin and its
// preset. Under it, the instrument as a device:
//   Ephemeris Sampler  its zones as a stack of bars over the keys, the selected one's sample and settings, its amp
//                      (sampler-device.js); an edited sampler is saved as a file of the project's
//                      (instruments/<name>-<hash>.json: api/instrument/save) that the patterns playing it then name
//   a plugin           a VST3 this machine has, played by its host (plugins.js): its own window, its macros as knobs and
//                      its parameters by name; a parameter keyed (◆, at the playhead) is automated (its keys are lanes on
//                      the audio track: automation.js; its knob then keys it where the playhead is). While the timeline is
//                      stopped, the plugin shown here is heard as it is played (the keyboard below, its window's)
// A keyboard on screen (and a w s e d f t g y h u j k on the computer's, while the panel has focus; z/x: octave) plays
// the instrument now: a sampler in the page, with the engine itself; a plugin on its host. The `instrument` forms (a
// track's instrument, as the timeline keeps it):
//   { sfz: '<path>' } · { sampler: '<saved instrument .json>' }
//   · { named: '<folder of samples named by note>', octave: <semitones> }      (paths: the project's, or library/…)
//   · { plugin: '<name>', state: '<preset: presets/…, the project's, library/… or vital/…>', set: { '<parameter>': 0–1 } }
// Each change is one edit (app.js edit()), made when a drag ends, so undo and autosave work.
import { linkFetch } from './link.js';
import { knob, seg } from './knobs.js';
import { sampler } from '/files/engine/sound/sampler.js';
import { paramAt, keyTarget, keyedAt, withKey } from './automation.js';
import { played } from '../engine/score.js';
import { automatedKeys, notesClips, INSTRUMENT, clipEnd, speedOf } from './model.js';
import { samplerParams } from './device.js';
import { samplesPlayed, pluginKey } from './live.js';
import { samplerDevice, noteName, MEDIA_TYPE } from './sampler-device.js';
import { ctx as editorAudio, hear as hearNote } from './audio.js';

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (k === 'on') for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f); else if (k === 'class') e.className = v; else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const KEYS = 'awsedftgyhujkolp;'.split('');   // a w s e d f t g y h u j k o l p ; → C … E, an octave up
const SAMPLER = 'Ephemeris Sampler';
// paths of the project's files, as the studio names them ('instruments/kit/a.wav', '../media/b.wav' from instruments/)
function join(a, b) { const out = []; for (const s of `${a}/${b}`.split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); } return out.join('/'); }
function relTo(from, to) { const f = from.split('/').filter(Boolean), t = to.split('/').filter(Boolean); let i = 0; while (i < f.length && i < t.length && f[i] === t[i]) i++; return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/'); }
const short = (n) => String(n ?? '').replace(/^.*\//, '').replace(/\.(wav|flac|mp3|ogg|aiff?|json|sfz)$/i, '');

/** The panel. ctx: { S (the editor's state), edit(desc, fn), target() → { track (its id), name, m (the track: its
 *  instrument) } of the selected track, or null; hear(doc): plays a version of the timeline at once; plugins: the plugin link (plugins.js);
 *  reveal(key, target): opens a parameter's lanes (its instrument's, on the target clip's track); importFile(file) → the project's medium for a file dropped from the
 *  computer; preview(instrument, data): a sampler's settings being dragged, heard at once (null: as saved again);
 *  score(): what the film's sound code does now (engine/score.js: its motions are a parameter's automation too);
 *  heardDoc(): the timeline as heard, with it in; openSettings(): the settings, where its preset folders are }. Its
 *  element is `el` (put in the panel's body); refresh() after the document or selection changes. */
export function createInstrumentPanel({ el, S, edit, target, hear = () => {}, plugins = null, reveal = () => {}, importFile = null, preview = () => {}, score = () => null, heardDoc = null, openSettings = () => {} }) {
  let mine = false;   // (an edit of ours that the panel already shows)
  const st = { tab: null, shown: '', oct: 4, filter: '', list: null, sampler: null, loading: '', note: '', plugins: null, pfilter: '', zone: 0, lib: false, zview: 'keys', zr: null, modTab: null };
  const decoded = new Map();   // decoded samples by their url (a library is fetched once)
  let device = null;
  const toast = (t) => { st.note = t; const n = el.querySelector('.inst-note'); if (n) n.textContent = t; };

  /** Plays `note` on the instrument as it is now (a sampler as the knobs have it, even mid-drag; a plugin on its host).
   *  Resolves to the sound, for tests (a sampler's). */
  async function play(note) {
    const t = target();
    if (!t) return null;
    if (st.tab === 'plugin') { if (t.m.instrument.plugin) plugins?.note(pluginKey(t.track), note, true); return null; }   // (held until release)
    try {
      const ring = st.sampler;
      if (ring) { await samplesFor(ring, [note]); device?.hit?.(note); }
      if (!ring?.inst) { toast(st.loading ? 'still loading…' : 'no instrument to play'); return null; }
      const snd = ring.inst.render([{ t: 0, dur: 0.9, note, vel: 0.8 }], { sr: editorAudio.sampleRate });
      if (!snd.ch[0].length) { toast(`no zone plays ${noteName(note)}`); return null; }   // (nothing to play: no zone has this key)
      hearNote(t.track, snd); return snd;   // (through its track, as the timeline plays it)
    } catch (e) { toast(`can't play it: ${e.message}`); return null; }
  }
  /** A key let go: a plugin's note ends (a sampler's plays its own length). */
  function release(note) {
    const t = target();
    if (t && st.tab === 'plugin' && t.m.instrument.plugin) plugins?.note(pluginKey(t.track), note, false);
  }

  // ---------- samples: an instrument from the studio, its samples fetched and decoded once
  async function sample(url) {
    if (!decoded.has(url)) decoded.set(url, linkFetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.arrayBuffer(); }).then((b) => editorAudio.decodeAudioData(b))
      .then((ab) => ({ sr: ab.sampleRate, ch: [ab.getChannelData(0), ab.numberOfChannels > 1 ? ab.getChannelData(1) : ab.getChannelData(0)] })));
    return decoded.get(url);
  }
  // a sample's file, named as its instrument names it (from its folder, or library/…)
  const sampleUrl = (s, n) => `api/library/file?path=${encodeURIComponent(n.startsWith('library/') ? n : join(s.dir, n))}`;
  const specOf = (inst) => (inst.sfz ? { kind: 'sfz', path: inst.sfz } : inst.named ? { kind: 'named', path: inst.named, octave: inst.octave ?? 0 } : inst.sampler ? { kind: 'sampler', path: inst.sampler } : null);
  // A sampler instrument is fetched when chosen, but its samples only as notes need them (a piano is hundreds of megabytes):
  // the keyboard's notes at once, any other note the first time it is played.
  async function loadSampler(spec) {
    const key = JSON.stringify(spec);
    if (st.sampler?.key === key || st.loading === key) return;
    st.loading = key; st.sampler = null; toast('loading…');
    try {
      const q = new URLSearchParams({ kind: spec.kind, path: spec.path, octave: spec.octave ?? 0 });
      const r = await (await linkFetch(`api/instrument?${q}`)).json();
      if (r.error) throw new Error(r.error);
      if (st.loading !== key) return;   // (another instrument chosen meanwhile)
      st.sampler = { key, data: r.instruments[0], dir: r.dir, samples: {}, inst: null, partOf: r.partOf ?? [], path: spec.path };
      st.zone = 0; st.zr = null;
      draw();
      // (the keyboard's notes ready to play — unless that is a big program's hundreds of recordings: then each key's
      // the first time it is played)
      const keys = [...Array(25)].map((_, i) => 12 * (st.oct + 1) + i);
      if (samplesPlayed(st.sampler.data, keys.map((note) => ({ note, vel: 0.8 }))).size <= 64) await samplesFor(st.sampler, keys);
      toast('');
    } catch (e) { toast(`can't load ${spec.path}: ${e.message}`); } finally { if (st.loading === key) st.loading = ''; }
  }
  /** Loads the samples of the regions that answer `notes` as the keys play them (velocity 0.8: of a cymbal's twelve
   *  velocity layers, the one they hit), and rebuilds the sampler with them. */
  async function samplesFor(s, notes) {
    const names = [...samplesPlayed(s.data, notes.map((note) => ({ note, vel: 0.8 })))].filter((n) => !(n in s.samples));
    for (let i = 0; i < names.length; i += 8) {
      await Promise.all(names.slice(i, i + 8).map(async (n) => {
        try { s.samples[n] = await sample(sampleUrl(s, n)); } catch { s.samples[n] = null; }
      }));
    }
    if (names.length || !s.inst) s.inst = sampler(s.data, Object.fromEntries(Object.entries(s.samples).filter(([, v]) => v)));
  }

  // ---------- edits: each one undoable, in plain words
  /** Sets the instrument of the selected track as one edit (change(track); keep: the panel already shows it). */
  function commit(desc, change, keep = false) {
    const t = target(); if (!t) return;
    mine = keep;
    edit(desc.replace('@', `"${t.name}"`), (d) => change(d.tracks.find((y) => y.id === t.track)));
    mine = false;
  }
  function pick(spec) {
    const inst = spec.kind === 'sfz' ? { sfz: spec.path } : { named: spec.path, octave: spec.octave ?? (/vcsl/i.test(spec.path) ? 12 : 0) };
    st.lib = false; st.tab = 'sampler'; st.sampler = null;   // (a new sampler being made gives way to this one)
    commit(`@ plays ${spec.path}`, (m) => { m.instrument = inst; });
  }

  // ---------- Ephemeris Sampler
  async function libraryList() {
    if (!st.list) { st.list = []; try { st.list = await (await linkFetch('api/instruments')).json(); } catch { st.list = []; } if (st.lib) draw(); }
    return st.list;
  }
  // a sample's name as a saved instrument of the project's names it (from instruments/, or the library's as library/…)
  const savedName = (dir, n) => { const full = n.startsWith('library/') ? n : join(dir, n); return full.startsWith('library/') ? full : relTo('instruments', full); };
  /** An edit of the sampler instrument: fn(data) on a copy, its samples named as the project's saved instrument names
   *  them; saved as a file of the project's, and the patterns that play this instrument (or only this one: `only`) pointed
   *  at it — one undoable edit. */
  let saving = Promise.resolve();   // (one after another: each starts from the instrument the last one saved)
  const samplerChange = (desc, fn, opts) => (saving = saving.then(() => saveSampler(desc, fn, opts)));
  async function saveSampler(desc, fn, { only = false } = {}) {
    const t = target(), s = st.sampler;
    if (!t || !s) return;
    const spec0 = t.m.instrument, was = JSON.stringify(spec0), data = structuredClone(s.data), sounds = {};
    for (const r of data.regions) if (r.sample) { const n = savedName(s.dir, r.sample); if (s.samples[r.sample] !== undefined) sounds[n] = s.samples[r.sample]; r.sample = n; }
    fn(data);
    const name = data.name || t.m.name || t.name;
    try {
      const res = await (await linkFetch('api/instrument/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, data }) })).json();
      if (res.error) throw new Error(res.error);
      const spec = { sampler: res.path };
      st.sampler = { key: JSON.stringify(specOf(spec)), data, dir: 'instruments', samples: sounds, inst: null };
      st.sampler.inst = sampler(data, Object.fromEntries(Object.entries(sounds).filter(([, v]) => v)));
      mine = true;
      edit(`${name}: ${desc}`, (d) => {
        for (const tr of d.tracks) if (tr.instrument && (only ? tr.id === t.track : JSON.stringify(tr.instrument) === was)) tr.instrument = { ...spec };
      });
      mine = false;
      if (specOf(spec0)) preview(spec0, null);   // (what it was before the drag, under its own name: undo comes back to it)
      st.note = '';
      draw();
    } catch (e) { mine = false; toast(`can't save the instrument: ${e.message}`); }
  }
  // the sounds a drop carries: a sound of the project's (from the Assets panel), or files from the computer brought in
  const isSound = (n) => /\.(wav|flac|mp3|ogg|aiff?)$/i.test(n ?? '');
  async function soundsOf(e) {
    const asset = e.dataTransfer.getData(MEDIA_TYPE);
    if (asset) { const m = JSON.parse(asset); if (m.kind === 'audio' || isSound(m.src)) return [m.src]; toast('drop a sound: that is not one'); return []; }
    const files = [...e.dataTransfer.files].filter((x) => /^audio\//.test(x.type) || isSound(x.name));
    if (!files.length) { toast('drop a sound (wav, flac, mp3, ogg)'); return []; }
    if (!importFile) return [];
    const srcs = [];
    for (const f of files) { const info = await importFile(f); if (info?.src) srcs.push(info.src); }
    return srcs;
  }
  // a sampler's settings being dragged: heard at once — the timeline's (if it plays), and the keys here — the edit made
  // when the drag ends (samplerChange)
  function draftSampler(data) {
    const t = target(), s = st.sampler;
    if (!t || !s) return;
    s.inst = sampler(data, Object.fromEntries(Object.entries(s.samples).filter(([, v]) => v)));
    if (s.key !== 'new' && specOf(t.m.instrument)) preview(t.m.instrument, data);
  }
  const samplerCtx = () => ({ st, samplerChange, play, sample, sampleUrl, soundsOf, nameOf: (src) => relTo('instruments', src), redraw: () => drawBody(), load: (path) => pick({ kind: 'sfz', path }), preview: draftSampler,
    // (its own params' keying: device.js's, from its data as it is)
    param: (path) => { const p = samplerParams(st.sampler?.data ?? {}).find((x) => x.key === path), t = target(); return p && t ? keying(t, p) : null; } });
  // a new sampler, empty, shown until its first sound is dropped on it (then saved, and the pattern plays it)
  const freshSampler = (t) => ({ key: 'new', data: { kind: 'sampler', name: t?.m.name ?? t?.name ?? 'sampler', env: { r: 0.05 }, regions: [] }, dir: 'instruments', samples: {}, inst: null });

  // ---------- a parameter's automation (automation.js): its clip's, kept in the pattern, and its track's over it
  // (as the doc is now: a control drawn before an edit reads the doc after it; as heard, with the sound code's motions)
  const playedDoc = () => heardDoc?.() ?? played(S.doc, score());
  const trackOf = (t) => playedDoc().tracks.find((y) => y.id === t.track);
  // (the notes its track's notes clips' patterns hold: its octave; those sounding at timeline time x, where they play)
  const trackNotes = (t) => { const d = playedDoc(); return notesClips(trackOf(t), d.media).flatMap((c) => d.media[c.media].notes); };
  const trackSounding = (t, x) => {
    const d = playedDoc(), out = [];
    for (const c of notesClips(trackOf(t), d.media)) {
      if (x < c.at || x >= clipEnd(c)) continue;
      const at = c.in + (x - c.at) * speedOf(c);
      for (const n of d.media[c.media].notes) if (n.t <= at && at < n.t + n.dur) out.push({ note: n.note, vel: n.vel });
    }
    return out;
  };
  const automationOf = (t) => { const tr = trackOf(t), media = playedDoc().media; return { track: tr?.automation?.[INSTRUMENT] ?? null, clips: notesClips(tr, media).map((c) => media[c.media].automation ?? null) }; };
  const isKeyed = (t, key) => automatedKeys(trackOf(t), playedDoc().media).includes(key);
  // its value at time x (0–1); whether a key is at x in the layer a key there goes to (keyTarget)
  const valueAt = (t, p, x) => paramAt(trackOf(t), playedDoc().media, p.key, p.norm)(x);
  const keysHere = (t, key, x) => { const k = keyTarget(trackOf(t), playedDoc().media, key, x); return keyedAt(k.p, k.at); };
  // the keyed controls drawn, each following the playhead (follow): its ◆ lit where a key is, its knob (where it has one)
  // at the automation's value there
  let followers = [], followedAt = NaN;

  // ---------- a plugin: its macros as knobs, its parameters by name, each keyable
  async function pluginList() {
    if (!st.plugins) { st.plugins = { plugins: [], presets: {} }; try { st.plugins = await (await linkFetch('api/plugins')).json(); } catch { /* none */ } draw(); }
    return st.plugins;
  }
  // any instrument's parameter at the playhead (p: device.js's, its key what its track's automation names it by, norm its
  // value 0–1): its value there (its automation's, where it has one), its ◆ (keyed where the playhead is, or the key
  // there taken away), and keyAt: a value (0–1) keyed at the playhead, heard while dragged, an edit when final;
  // follow(knob, value): its knob shows the automation's value (value(n): in the knob's units) as the playhead moves
  function keying(t, p) {
    const automated = isKeyed(t, p.key), normAt = () => valueAt(t, p, S.t);
    const key = h('button', { class: `inst-key${automated ? ' on' : ''}`,
      on: { click: (e) => {   // (where the playhead is now: it may have moved since the panel was drawn)
        e.preventDefault(); e.stopPropagation();
        const there = keysHere(t, p.key, S.t), first = !isKeyed(t, p.key);
        edit(`"${t.name}": ${p.title} ${there ? 'key taken away' : 'keyed'} at ${S.t.toFixed(2)} s`, (d) => withKey(d, t.track, p.key, S.t, normAt(), there, score()));
        if (first) reveal(p.key, t);
      } } }, '◆');
    const keyAt = (n, final, said = n.toFixed(2)) => {
      if (final) edit(`"${t.name}": ${p.title} → ${said} at ${S.t.toFixed(2)} s`, (d) => withKey(d, t.track, p.key, S.t, n, false, score()));
      else { const doc = structuredClone(S.doc); withKey(doc, t.track, p.key, S.t, n, false, score()); hear(doc); }
    };
    const k = { t, p, automated, normAt, key, keyAt, follow: (knob, value = (n) => n) => { k.knob = knob; k.value = value; } };
    followers.push(k); here(k, S.t);
    return k;
  }
  // a keyed control's ◆ at time x: lit where a key is
  function here(k, x) {
    const on = keysHere(k.t, k.p.key, x);
    k.key.classList.toggle('here', on);
    k.key.title = on ? 'Take away the key at the playhead' : 'Key it at the playhead';
  }
  /** The playhead at x: each keyed control as it is there (its ◆, and an automated knob's value; not one being turned). */
  function follow(x) {
    if (x === followedAt || !target()) return;
    followedAt = x;
    for (const k of followers) {
      here(k, x);
      if (k.automated && k.knob && !k.knob.classList.contains('on')) k.knob.set(k.value(valueAt(k.t, k.p, x)));
    }
  }
  // a plugin parameter's control: set (in `set`, over the state), or keyed where the playhead is (automated)
  function paramControl(t, inst, p) {
    const base = inst.set?.[p.title] ?? p.value, k = keying(t, { key: p.title, title: p.title, norm: base });
    const setTo = (y, final) => {
      if (k.automated) return k.keyAt(y, final);   // (automated: a key at the playhead)
      const next = { ...inst, set: { ...inst.set, [p.title]: y } };
      if (final) commit(`@: ${p.title} ${(+base).toFixed(2)} → ${y.toFixed(2)}`, (mm) => { mm.instrument = next; }, true);
      else { const doc = structuredClone(S.doc); doc.tracks.find((y) => y.id === t.track).instrument = next; hear(doc); }   // (heard at once while dragged)
    };
    return { v: k.normAt(), setTo, key: k.key, follow: k.follow };
  }
  function pluginBody(m, t) {
    const inst = m.instrument, key = pluginKey(t.track), s = plugins?.status(key);
    if (!inst.plugin) return h('div', { class: 'dev-msg' }, inst.synth || inst.preset ? 'This played the Ephemeris Synth, which is gone: choose Vial, the studio\'s synth, and a preset in the bar above.' : st.plugins?.plugins.length ? 'Choose a plugin in the bar above.' : 'No plugins found on this machine.');
    if (s?.error) return h('div', { class: 'dev-msg bad' }, s.error);
    if (!s?.ready) return h('div', { class: 'dev-msg' }, `Starting ${inst.plugin}…`);
    const params = s.info.params ?? [], auto = new Set(automatedKeys(trackOf(t), playedDoc().media)), f = st.pfilter.trim().toLowerCase();
    // its macros (the preset designer's main controls), as big knobs
    const macros = params.filter((p) => /^macro \d+$/i.test(p.title)).slice(0, 8);
    const macroRow = macros.length ? h('section', { class: 'dsec macros' }, h('div', { class: 'dsec-head' }, h('b', {}, 'Macros')), h('div', { class: 'pl-macros' }, macros.map((p) => {
      const c = paramControl(t, inst, p), k = knob(p.title.replace(/^macro/i, 'Macro'), { value: p.value, min: 0, max: 1, step: 0.001 }, c.v, (y, final) => c.setTo(y, final));
      k.classList.add('big'); c.follow(k);
      return h('div', { class: 'pl-cell' }, k, c.key);
    }))) : null;
    // its parameters, found by name (the keyed ones always shown)
    const shown = (f ? params.filter((p) => p.title.toLowerCase().includes(f)) : params.filter((p) => auto.has(p.title) && !macros.includes(p))).slice(0, 48);
    // (a knob each; the words the search shares with every name it found left off, so the rest of each shows)
    const common = f && shown.every((p) => p.title.toLowerCase().startsWith(f)) ? f.length : 0;
    const cells = shown.map((p) => {
      const c = paramControl(t, inst, p), name = p.title.slice(common).trim() || p.title;
      const k = knob(name, { value: p.value, min: 0, max: 1, step: p.steps ? 1 / p.steps : 0.001 }, c.v, (y, final) => c.setTo(y, final));
      k.title = `${p.title}: drag up or down (shift: finer) · click, then scroll · double-click: its default`; c.follow(k);
      return h('div', { class: 'pl-cell' }, k, c.key);
    });
    const search = h('input', { type: 'search', placeholder: `Search its ${params.length} parameters`, value: st.pfilter, spellcheck: 'false',
      on: { input: (e) => { st.pfilter = e.target.value; const at = e.target.selectionStart; drawBody(); const i = el.querySelector('.pl-params input[type=search]'); i?.focus(); i?.setSelectionRange(at, at); } } });
    return h('div', { class: 'pl' }, macroRow,
      h('section', { class: 'dsec pl-params' }, h('div', { class: 'dsec-head' }, h('b', {}, 'Parameters'), h('span', { class: 'dim' }, f ? `${shown.length} found` : auto.size ? 'the animated ones' : ''), h('span', { class: 'grow' }), search),
        cells.length ? h('div', { class: 'pl-grid' }, cells) : h('div', { class: 'dsec-none' }, f ? 'No parameter matches.' : 'Search its parameters by name; the ◆ under one keys it at the playhead.')));
  }

  // ---------- the keyboard (a plugin's: the sampler has its own, under its zones)
  function keyboard() {
    const box = h('div', { class: 'inst-keys' }), whites = [0, 2, 4, 5, 7, 9, 11], span = 2, kw = 100 / (7 * span + 1);
    box._keys = new Map();
    for (let o = 0; o <= span; o++) for (let s = 0; s < 12; s++) {
      if (o === span && s > 0) break;
      const white = whites.includes(s), wi = whites.filter((w) => w < s).length + o * 7, off = o * 12 + s;
      const k = h('div', { class: white ? 'w' : 'b', style: white ? `left:${wi * kw}%;width:${kw}%` : `left:${(wi - 0.3) * kw}%;width:${kw * 0.6}%` }, h('span', {}, s === 0 ? `C${st.oct + o}` : KEYS[off] ?? ''));
      const up = () => { if (k.classList.contains('on')) release(12 * (st.oct + 1) + off); k.classList.remove('on'); };
      k.addEventListener('pointerdown', () => { k.classList.add('on'); play(12 * (st.oct + 1) + off); });
      k.addEventListener('pointerup', up); k.addEventListener('pointerleave', up);
      box._keys.set(off, k); box.append(k);
    }
    return box;
  }
  // computer keys: only while the panel has focus (the editor's own keys, space and S and the rest, work elsewhere)
  el.tabIndex = 0;
  el.addEventListener('pointerdown', (e) => { if (!e.target.closest('input, select, textarea')) el.focus({ preventScroll: true }); });
  el.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && st.lib) { st.lib = false; draw(); return; }
    const octave = e.key === 'z' ? -1 : e.key === 'x' ? 1 : 0;
    if (octave) { e.stopPropagation(); st.oct = Math.min(7, Math.max(1, st.oct + octave)); if (st.tab !== 'sampler') draw(); return; }
    const i = KEYS.indexOf(e.key);
    if (i < 0) return;
    e.preventDefault(); e.stopPropagation();   // (a key the editor would otherwise act on)
    if (e.repeat) return;
    el.querySelector('.inst-keys')?._keys.get(i)?.classList.add('on');
    play(12 * (st.oct + 1) + i);
  });
  el.addEventListener('keyup', (e) => { const i = KEYS.indexOf(e.key); if (i >= 0) { el.querySelector('.inst-keys')?._keys.get(i)?.classList.remove('on'); release(12 * (st.oct + 1) + i); } });

  // ---------- the bar: what plays the notes (outside the instrument itself)
  function bar(t) {
    const inst = t.m.instrument, tab = st.tab;
    const kind = seg(['sampler', 'plugin'], tab, (k) => { st.tab = k; st.lib = false; draw(); },
      { labels: { sampler: 'Sampler', plugin: 'Plugin' }, titles: { sampler: 'The Ephemeris Sampler: sounds mapped across the keys', plugin: 'A plugin (VST3): Vial, the studio\'s synth, or another on this machine' } });
    let source;
    if (tab === 'sampler') {
      const s = st.sampler, fresh = s?.key === 'new';
      source = [h('span', { class: 'lbl' }, 'Instrument'), h('span', { class: 'inst-src', title: inst.sampler ?? inst.sfz ?? inst.named ?? '' },
        fresh ? 'new sampler (drop a sound to start it)' : s ? `${s.data.name ?? short(inst.sampler ?? inst.sfz ?? inst.named)} · ${s.data.regions.length} zone${s.data.regions.length === 1 ? '' : 's'}` : st.loading ? 'loading…' : '—'),
      h('button', { class: `btn${st.lib ? ' on' : ''}`, title: 'Start from an instrument in the sound library', on: { click: () => { st.lib = !st.lib; libraryList(); draw(); } } }, 'Library…'),
      h('button', { class: 'btn ghost', title: 'An empty sampler: drop sounds on its keys', on: { click: () => { st.sampler = freshSampler(t); st.zone = 0; st.zr = null; st.lib = false; draw(); } } }, 'New')];
    } else {
      const list = st.plugins ?? { plugins: [], presets: {} }, presets = list.presets?.[inst.plugin] ?? [];
      source = [h('span', { class: 'lbl' }, 'Plugin'), h('select', { title: 'The plugin that plays these notes', on: { change: (e) => e.target.value && commit(`@ plays ${e.target.value}`, (mm) => { mm.instrument = { plugin: e.target.value }; }) } },
        h('option', { value: '' }, list.plugins.length ? 'choose…' : 'none found'), list.plugins.map((p) => h('option', { value: p, selected: p === inst.plugin }, p)))];
      // its presets, by the folder they are in (the settings' preset folders): one of a folder of this machine's copied into
      // the project as it is chosen; the sound it plays now first where it is none of them (its own, as its window left it)
      const current = !inst.state ? 'Its default' : presets.some((q) => q.state === inst.state) ? null : /\.state$/.test(inst.state) ? 'Your sound' : short(inst.state).replace(/\.vital$/i, '').replace(/[-_]/g, ' ');
      const groups = [...new Set(presets.map((q) => q.folder))];
      const choose = async (q) => {
        let state = q.state;
        if (!state) {
          const r = await (await linkFetch('api/presets/take', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(q.take) })).json();
          if (r.error) return toast(r.error);
          state = r.state;
        }
        commit(`@: preset ${q.name}`, (mm) => { mm.instrument = { plugin: inst.plugin, state }; });
      };
      source.push(h('span', { class: 'lbl' }, 'Preset'), h('select', { title: 'Start from a preset (replaces its state)', on: { change: (e) => { const v = e.target.value; if (v === 'folders') { e.target.value = ''; return openSettings(); } if (v !== '') choose(presets[+v]); } } },
        ...(current ? [h('option', { value: '', selected: true }, current)] : []),
        groups.map((g) => h('optgroup', { label: g }, presets.map((q, i) => (q.folder === g ? h('option', { value: String(i), selected: !!q.state && q.state === inst.state }, q.name) : null)))),
        h('option', { value: 'folders' }, 'Preset folders…')));
    }
    return h('div', { class: 'inst-bar' }, kind, h('i', { class: 'inst-div' }), ...source, h('span', { class: 'grow' }), h('span', { class: 'inst-note' }, st.note));
  }
  // the library (a sampler to start from): over the device, under the bar
  function library() {
    const search = h('input', { type: 'search', placeholder: `Search ${st.list?.length ?? '…'} instruments in the sound library`, value: st.filter, spellcheck: 'false', on: { input: (e) => { st.filter = e.target.value; fill(); } } });
    const rows = h('div', { class: 'lib-list' }), cur = specOf(target()?.m.instrument ?? {});
    const fill = () => {
      const f = st.filter.trim().toLowerCase(), shown = (st.list ?? []).filter((i) => !f || i.path.toLowerCase().includes(f)).slice(0, 300);
      rows.replaceChildren(...shown.map((i) => h('button', { class: `lib-row${cur?.path === i.path ? ' on' : ''}`, title: i.path, on: { click: () => pick({ kind: i.kind, path: i.path }) } },
        h('span', { class: 'lib-kind' }, i.kind === 'sfz' ? 'SFZ' : 'notes'), h('b', {}, i.name), h('span', { class: 'dim' }, i.path.replace(/^library\//, '').replace(/\/[^/]*$/, '')))));
      if (!shown.length) rows.append(h('div', { class: 'dsec-none' }, st.list?.length ? 'No instrument matches.' : 'Loading the library…'));
    };
    fill();
    requestAnimationFrame(() => search.focus());
    return h('div', { class: 'inst-lib' }, h('div', { class: 'lib-head' }, search, h('button', { class: 'tb', title: 'Close (Esc)', on: { click: () => { st.lib = false; draw(); } } }, '×')), rows);
  }

  // ---------- the device: its title (its name, its own buttons) over what it is
  function deviceOf(t) {
    const m = t.m;
    if (st.tab === 'sampler') {
      if (!st.sampler) return frame(SAMPLER, [], h('div', { class: 'dev-msg' }, st.loading ? 'Loading the instrument…' : ''));
      const d = samplerDevice(samplerCtx()), f = frame(SAMPLER, [d.viewSeg], d);
      f.classList.add('fill');
      return f;
    }
    const s = plugins?.status(pluginKey(t.track)), inst = m.instrument;
    const win = inst.plugin ? h('button', { class: 'btn', title: 'Open the plugin\'s window (changes are kept)', disabled: !s?.ready || !s.info?.editor, on: { click: () => plugins.editor(pluginKey(t.track), true) } }, 'Open its window') : null;
    return frame(inst.plugin ?? 'Plugin', [win], pluginBody(m, t));
  }
  function frame(name, actions, content) {
    const f = h('div', { class: 'dev' }, h('div', { class: 'dev-head' }, h('i', { class: 'dev-on', title: 'This instrument plays the pattern' }), h('b', {}, name), h('span', { class: 'grow' }), ...actions), h('div', { class: 'dev-content' }, content));
    f.hit = content.hit;
    return f;
  }
  /** Draws the device again (a zone selected, a search typed, a tab), keeping where it is scrolled to. */
  function drawBody() {
    const t = target(), b = el.querySelector('.inst-body');
    if (!t || !b) return draw();
    const scroll = [b.scrollTop, b.scrollLeft], rows = el.querySelector('.zs-rows')?.scrollTop ?? 0;
    followers = []; followedAt = NaN;
    device = deviceOf(t);
    b.replaceChildren(device);
    b.scrollTop = scroll[0]; b.scrollLeft = scroll[1];
    const z = el.querySelector('.zs-rows'); if (z) z.scrollTop = rows;
  }
  function draw() {
    const t = target(), title = el.closest('.panel')?.querySelector('#instTitle');
    if (!t) {
      plugins?.focus(null); el.classList.remove('device'); device = null; followers = [];
      el.replaceChildren(h('div', { class: 'inst-empty' }, 'Select a clip of notes to edit its instrument.'));
      if (title) title.textContent = '';
      st.shown = ''; return;
    }
    // (a pattern shown anew: its keyboard from the octave of its lowest note, so that its notes are on it)
    if (t.track !== st.octFor) { st.octFor = t.track; const lo = Math.min(...trackNotes(t).map((n) => n.note)); if (Number.isFinite(lo)) st.oct = Math.min(7, Math.max(1, Math.floor(lo / 12) - 1)); }
    const inst = t.m.instrument;
    if (!(st.tab && st.shownName === t.track)) { st.tab = specOf(inst) ? 'sampler' : 'plugin'; st.lib = false; if (st.sampler?.key === 'new') st.sampler = null; }
    st.shownName = t.track;
    if (st.tab === 'plugin') pluginList();
    plugins?.focus(st.tab === 'plugin' && inst.plugin ? pluginKey(t.track) : null);   // (heard as it is played, while stopped)
    const spec = specOf(inst);
    if (spec && st.sampler?.key !== 'new') loadSampler(spec);
    else if (st.tab === 'sampler' && st.sampler?.key !== 'new') st.sampler = freshSampler(t);   // (no sampler yet: an empty one to drop sounds on)
    if (title) title.textContent = t.name;   // (its track's)
    const b = el.querySelector('.inst-body'), scroll = b ? [b.scrollTop, b.scrollLeft] : [0, 0], rows = el.querySelector('.zs-rows')?.scrollTop ?? 0;
    el.classList.add('device'); el.dataset.dev = st.tab;
    followers = []; followedAt = NaN;
    device = deviceOf(t);
    const body = h('div', { class: 'inst-body' }, device);
    el.replaceChildren(bar(t), body, ...(st.lib ? [library()] : []),
      ...(st.tab === 'sampler' ? [] : [h('div', { class: 'inst-foot' }, keyboard(), h('div', { class: 'inst-keyinfo' }, 'Click the keys, or press ', h('kbd', {}, 'A'), '–', h('kbd', {}, 'K'), ' here · ', h('kbd', {}, 'Z'), h('kbd', {}, 'X'), ' octave'))]));
    body.scrollTop = scroll[0]; body.scrollLeft = scroll[1];
    const z = el.querySelector('.zs-rows'); if (z) z.scrollTop = rows;
    st.shown = shownKey(t);
    litKey = '';   // (drawn anew: lit again)
  }
  // what the panel shows: the clip's medium, its instrument and its track's automation of it
  const shownKey = (t) => JSON.stringify([t.track, t.m.instrument, st.tab, automationOf(t), notesClips(trackOf(t), playedDoc().media)]);
  /** Shows the selected clip's instrument (again, if it or its automation changed — not for our own edit, which the panel
   *  already shows). */
  function refresh() {
    const t = target(), key = t ? shownKey(t) : '';
    if (key === st.shown) return;
    if (mine && t) { st.shown = key; return; }
    draw();
  }
  plugins?.onStatus((key) => { const t = target(); if (st.tab === 'plugin' && t && key === pluginKey(t.track)) draw(); });
  draw();
  /** Shows a tab (sampler or plugin), or the one the instrument's kind gives. */
  function show(tab) { if (tab) { st.tab = tab; st.shownName = target()?.track; } st.shown = ''; draw(); }
  // while playing, the notes its pattern sounds at the playhead (t; null: none) lit on its keyboard, and on a sampler's
  // keys and the zones that play them (each zone's keys and velocities)
  let litKey = '';
  function light(t) {
    const tg = target(), sounding = t == null || !tg ? [] : trackSounding(tg, t), key = sounding.map((n) => `${n.note}:${n.vel}`).join(' ');
    if (key === litKey) return;
    litKey = key;
    const notes = new Set(sounding.map((n) => n.note));
    for (const [off, k] of el.querySelector('.inst-keys')?._keys ?? []) k.classList.toggle('lit', notes.has(12 * (st.oct + 1) + off));
    for (const k of el.querySelectorAll('.zk[data-k]')) k.classList.toggle('lit', notes.has(+k.dataset.k));
    for (const b of el.querySelectorAll('.zbar[data-keys]')) {
      const [a, z] = b.dataset.keys.split(' ').map(Number), [v0, v1] = b.dataset.vels.split(' ').map(Number);
      b.classList.toggle('lit', sounding.some((n) => { const v = 1 + Math.round(n.vel * 126); return n.note >= a && n.note <= z && v >= v0 && v <= v1; }));
    }
  }
  /** Instrument files changed on disk (the project's paths): the sampler shown is loaded again if it is one of them. */
  function forget(files) {
    if (!st.sampler?.path || st.sampler.key === 'new' || !files.some((f) => f === st.sampler.path || f.startsWith(`${st.sampler.path.replace(/\/$/, '')}/`))) return;
    st.sampler = null; st.shown = ''; draw();
  }
  /** The preset folders changed (the settings): the plugins' presets listed again. */
  function presetsChanged() { st.plugins = null; if (st.tab === 'plugin') pluginList(); }
  el.panel = { refresh, play, show, light, follow, forget, presetsChanged, state: st };   // (for the tests: the page's own handle on it)
  return el.panel;
}
