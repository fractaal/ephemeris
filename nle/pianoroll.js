// The piano roll: the notes of the selected notes clip (a medium with `notes`, see model.js isNotes) on a time-by-pitch grid,
// with those of every other notes clip selected with it (each where it plays against the first: edited together, each note
// kept in its own clip; a note drawn goes in the first), and faint behind them, the notes of the other notes clips that
// play then (ghosts: a right double-click on one opens its clip).
// Time runs across (the medium's own seconds, with the timeline's tempo grid as bar and beat lines), pitch up the side on a
// keyboard you can play, velocity in a lane under the notes.
// Draw: click empty space (a note in the cell clicked, as long and as loud as the last note touched; drag to place it,
// Shift-drag to set its length). Move: drag a note; resize: drag its end; copy: Shift-drag it. Delete: right-click a note,
// or right-drag across several; a right-click on empty space deselects. Select: Ctrl-click, Ctrl-drag a box (with Shift:
// add to the selection), Ctrl-drag the keyboard (the notes of those pitches). Velocity: paint it in the lane (Shift: a
// line), or Alt+wheel over a note. The roll's Snap (as the timeline's, by zoom, none, or a fixed length) applies to all
// of these and to the playhead set on its ruler; Alt places freely. The tools (quantize, legato, chop, glue, duplicate:
// notetools.js) change the selected notes, or all of them when none is.
// A gesture is drawn from a working copy and becomes one edit (one undo step) when the pointer is released; the studio
// then makes the clip's sound again, and the old one plays until the new is ready. The notes and chords you play are
// heard at once: a sampler's made in the browser with the engine itself (from the samples the studio serves), a plugin's
// on its host. As in the timeline: middle-drag pans, Ctrl-wheel zooms, and while playing the view pages along with the
// playhead.
import { linkFetch } from './link.js';
import { isNotes, soundingNotes } from './model.js';
import { pluginKey } from './live.js';
import { instrumentOf } from './mixer.js';
import { parts as gridParts, partAt, lines as gridLines, nearest as gridNearest, floor as gridFloor, position } from '../engine/grid.js';
import { quantize, legato, chop, glue, repeatEvery } from './notetools.js';
import { ownNotes } from '../engine/score.js';
import { snapName, isSnap, zoomPer as zoomPerOf, snapItems } from './snap.js';
import { sampler } from '/files/engine/sound/sampler.js';
import * as audio from './audio.js';
import { find, onEvery } from './layout.js';
import { trackColour, mix } from './colours.js';

const KEYS = 46, RULER = 18, VEL = 54, EDGE = 6, MIN_DRAG = 3;
const VEL0 = 0.8;     // a note's velocity when nothing else sets it (before any note is touched; Alt-click in the lane)
const GLINT = 2000;   // how long Claude's light on notes lasts (ms): its sweep, flare and fade
const C = {
  bg: '#0f0f0f', white: '#151515', black: '#101010', rowLine: '#0a0a0a', octave: '#262626', bar: 'rgba(255,255,255,0.1)', beat: 'rgba(255,255,255,0.04)', sub: 'rgba(255,255,255,0.02)',
  keyWhite: '#bdbdbd', keyBlack: '#1c1c1c', keyText: '#5a5a5a', text: '#d4d4d4', dim: '#8e8e8e', ruler: '#1c1c1c', outside: 'rgba(0,0,0,0.45)', head: '140,195,252',
  oddBar: 'rgba(0,0,0,0.18)', hoverRow: 'rgba(255,255,255,0.03)', ghost: 'rgba(255,255,255,0.03)', ghostEdge: 'rgba(255,255,255,0.09)', ink: '#0d0d0d', seam: '#080808',
};
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);
const noteName = (p) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r3 = (x) => Math.round(x * 1000) / 1000, r2 = (x) => Math.round(x * 100) / 100;
const f2 = (x) => (+x).toFixed(2);
const pct = (v) => `${Math.round(v * 100)}%`;
const keyOf = (n) => `${n.src}:${n.mt}:${n.note}`;   // (a note shown: its clip's pattern, its own time there, its pitch)
const byTime = (a, b) => a.t - b.t || a.note - b.note;
// a note in its track's colour, the quieter the darker (as Live's)
const velColor = (top, v) => mix(top, C.bg, 0.7 * (1 - v));
const CLIP_EDGE = ['#ff9f5a', '#ff6fb5', '#b98cff', '#5ad1ff', '#ffd75a'];   // (the edge of another clip's notes, by its place among those shown)
const PREFS = 'nle:roll';   // (the roll's Snap and ghosts, kept for this machine)

export function createPianoRoll(api) {
  const { S } = api, $ = find;   // (its panel may be in a window of its own)
  // a pattern as heard (api.heard: the notes its sound code writes in, with the director's edits over them), and the notes
  // its code writes (api.codeNotes: null where it writes none)
  const heard = (id) => api.heard?.(id) ?? S.doc.media[id];
  const canvas = $('#rollCanvas'), body = $('#rollBody'), ctxEl = $('#rollCtx'), hintEl = $('#rollHint'), snapBtn = $('#rollSnap'), toolsBtn = $('#rollTools');
  let W = 300, H = 200, dpr = 1, dirty = true, clipId = null, sel = new Set(), drag = null, held = '', seenSel = '', drawn = '';
  let clipboard = [], hover = null, lastRight = null;
  let touched = { dur: null, vel: VEL0 };   // the last note touched: a new note is as long and as loud
  const view = { x0: 0, pps: 100, top: 84, rh: 14 };
  const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch { return {}; } })();
  const keep = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* only a convenience */ } };
  let snapMode = ['timeline', 'zoom', 'none'].includes(prefs.snap) || isSnap(prefs.snap) ? prefs.snap : 'timeline';
  let ghostsOn = prefs.ghosts !== false;

  // ---------- the clip shown, and where things are
  function found() {
    for (const track of S.doc.tracks) for (const clip of track.clips) if (clip.id === clipId) { const m = heard(clip.media); if (isNotes(m)) return { clip, track, id: clip.media, m }; }
    return null;
  }
  // the clips shown: the one opened, and each other notes clip selected (each pattern once), with off: how much later on the
  // timeline its own time runs than the first's
  function shown() {
    const f = found(); if (!f) return [];
    const base = f.clip.at - f.clip.in, out = [{ ...f, off: 0 }], seen = new Set([f.id]);
    for (const track of S.doc.tracks) for (const clip of track.clips) {
      if (!S.sel.has(clip.id) || seen.has(clip.media) || !isNotes(S.doc.media[clip.media])) continue;
      seen.add(clip.media); out.push({ clip, track, id: clip.media, m: heard(clip.media), off: clip.at - clip.in - base });
    }
    return out;
  }
  // their notes, each in the first's time (t) and its own (mt), with the pattern it is in (src)
  const all = () => shown().flatMap((s) => s.m.notes.map((n) => ({ ...n, t: n.t + s.off, mt: n.t, src: s.id })));
  const notesOf = () => drag?.work ?? wheeling?.work ?? all();
  const shownOf = (src) => shown().find((s) => s.id === src);
  // each shown clip's notes in its track's colour (src → colour)
  const coloursOf = () => new Map(shown().map((s) => [s.id, trackColour(S.doc.tracks.indexOf(s.track)).top]));
  // the ghosts: the notes of every other notes clip, where it plays, in the first's time (with the clip they are in)
  function ghosts() {
    const ss = shown(); if (!ghostsOn || !ss.length) return [];
    const f = ss[0], ids = new Set(ss.map((s) => s.id)), base = f.clip.at - f.clip.in, out = [];
    for (const track of S.doc.tracks) for (const clip of track.clips) {
      const m = heard(clip.media);
      if (!isNotes(m) || ids.has(clip.media)) continue;
      const off = clip.at - clip.in - base;
      for (const n of m.notes) if (n.t + n.dur > clip.in && n.t < clip.out) out.push({ t: n.t + off, dur: n.dur, note: n.note, clip });
    }
    return out;
  }
  const G = () => S.doc.grid || { bpm: 120, offset: 0, beatsPerBar: 4 };
  const xOf = (m) => KEYS + (m - view.x0) * view.pps;
  const mAt = (x) => view.x0 + (x - KEYS) / view.pps;
  const yOf = (p) => RULER + (view.top - p) * view.rh;
  const pitchAt = (y) => clamp(Math.floor(view.top - (y - RULER) / view.rh), 0, 127);
  const notesH = () => H - RULER - VEL;
  const tlTime = (f, m) => f.clip.at + m - f.clip.in;   // the medium's time m, on the timeline
  const label = (f) => f.m.name ?? f.id;
  const partOf = (f, m) => partAt(gridParts(G()), tlTime(f, m));
  // where m falls, as the editor counts it: bar.beat.sixteenth from 0
  const barBeat = (f, m) => { const { bar, beat } = position(G(), tlTime(f, m)); return `${bar}.${Math.floor(beat)}.${Math.floor((beat % 1) * 4)}`; };
  const beatsLong = (f, n) => { const b = r2(n.dur / partOf(f, n.t).beat); return `${b} beat${b === 1 ? '' : 's'}`; };

  // ---------- snap: the roll's own (nle/snap.js), as the timeline's Snap (its grid: by zoom here, or its fixed length; off:
  // N), by zoom, none, or a fixed length; Alt places freely
  // the finest lines at least 14 px apart at this zoom, in beats ('bar': a bar)
  const zoomPer = (f) => zoomPerOf(partOf(f, mAt(W / 2)), view.pps);
  // what snaps now: a length in beats, 'bar', or null (nothing)
  function snapPer(f, e) {
    if (e?.altKey) return null;
    if (snapMode === 'timeline') return !S.snap ? null : S.snapGrid && S.snapGrid !== 'zoom' ? S.snapGrid : zoomPer(f);
    return snapMode === 'zoom' ? zoomPer(f) : snapMode === 'none' ? null : snapMode;
  }
  // m on the grid of `per`: its nearest line, or (floor) the line before it (the start of the cell it is in)
  const onGrid = (f, m, per, floor) => (per == null ? m : (floor ? gridFloor : gridNearest)(G(), tlTime(f, m), per) - f.clip.at + f.clip.in);
  const snap = (f, m, e, floor = false) => onGrid(f, m, snapPer(f, e), floor);
  // a step of the snap at m (of the zoom when nothing snaps): what the arrows move by, the shortest note drawn
  function stepSeconds(f, m, e) {
    const per = snapPer(f, e) ?? zoomPer(f), p = partOf(f, m);
    return per === 'bar' ? p.bar : per * p.beat;
  }
  function setSnap(mode) { snapMode = mode; prefs.snap = mode; keep(); dirty = true; }
  snapBtn.onclick = () => {
    const f = found();
    api.openMenu(snapBtn, [
      { label: 'As the timeline', hint: `${!S.snap ? 'off' : S.snapGrid && S.snapGrid !== 'zoom' ? snapName(S.snapGrid) : 'by zoom'} · N`, checked: snapMode === 'timeline', act: () => setSnap('timeline') },
      { label: 'By zoom', hint: f ? snapName(zoomPer(f)) : '', checked: snapMode === 'zoom', act: () => setSnap('zoom') },
      { label: 'None', checked: snapMode === 'none', act: () => setSnap('none') }, 'hr',
      ...snapItems(snapMode, setSnap),
    ].map((it) => (it.act ? { ...it, act: () => { it.act(); canvas.focus({ preventScroll: true }); } } : it)));
  };
  // the button says what snaps now
  function snapLabel(f) {
    const per = f ? snapPer(f) : null, text = per == null ? 'Off' : snapName(per), el = snapBtn.querySelector('span');
    if (el.textContent !== text) el.textContent = text;
    snapBtn.classList.toggle('on', per != null);
  }

  let fit = false;
  function open(id) { clipId = id; sel = new Set(); drag = null; fit = true; dirty = true; }
  // the time the clips shown play (in the first's time): from the earliest's in to the latest's out
  const span = () => { const ss = shown(); return [Math.min(...ss.map((s) => s.clip.in + s.off)), Math.max(...ss.map((s) => s.clip.out + s.off))]; };
  // the view for the clips just opened: all of their time across, their notes' pitches in the middle (once the panel has a size)
  function fitView() {
    fit = false;
    const [a, b] = span(), len = Math.max(b - a, 2);
    view.pps = Math.max(20, (W - KEYS - 24) / len); view.x0 = a - 8 / view.pps;
    const ps = all().map((n) => n.note);
    view.top = ps.length ? clamp(Math.round((Math.min(...ps) + Math.max(...ps)) / 2) + notesH() / view.rh / 2, 12, 127) : 76;
  }
  /** Opens clip `id` (a notes clip) in the roll. */
  const show = (id) => { open(id); seenSel = [...S.sel].join(); };

  // ---------- size
  function resize() {
    dpr = devicePixelRatio || 1;
    W = Math.max(100, body.clientWidth); H = Math.max(80, body.clientHeight);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    }
    dirty = true;
  }
  new ResizeObserver(resize).observe(body);

  // ---------- hearing notes
  const players = new Map();   // an instrument as the editor plays it: JSON of its spec → { render(note) → sound }
  const samples = new Map();   // sample url → decoded sound
  async function sampleSound(url) {
    if (!samples.has(url)) samples.set(url, linkFetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); }).then((b) => audio.ctx.decodeAudioData(b))
      .then((b) => ({ sr: b.sampleRate, ch: [b.getChannelData(0), b.getChannelData(b.numberOfChannels > 1 ? 1 : 0)] })));
    return samples.get(url);
  }
  const inKeys = (r, note) => (r.key == null ? true : Array.isArray(r.key) ? note >= r.key[0] && note <= r.key[1] : note === r.key);
  async function makePlayer(spec) {
    const r = await (await linkFetch('api/instrument', { method: 'POST', body: JSON.stringify({ instrument: spec }) })).json();
    if (r.error) throw new Error(r.error);
    // a sampler: only the samples this note needs are fetched (the regions for its key and velocity)
    return {
      async render(n) {
        const v = 1 + Math.round(n.vel * 126), regions = r.sampler.regions.filter((g) => g.trigger !== 'release' && inKeys(g, n.note) && (!g.vel || (v >= g.vel[0] && v <= g.vel[1])));
        const url = (s) => (s.startsWith('library/') ? `api/library/file?path=${encodeURIComponent(s)}` : r.base?.startsWith('library/') ? `api/library/file?path=${encodeURIComponent(`${r.base}/${s}`)}` : api.resolve([r.base, s].filter(Boolean).join('/')));
        const got = {};
        await Promise.all(regions.map(async (g) => { got[g.sample] = await sampleSound(url(g.sample)); }));
        return sampler({ ...r.sampler, regions }, got).render([n], { length: n.dur + 1.5, sr: audio.ctx.sampleRate });
      },
    };
  }
  /** Plays a note on the instrument of the clip shown's track, heard through the track as the timeline plays it (a
   *  plugin's on its host; a sampler's made here). */
  async function hear(f, note, vel = 0.8, dur = 0.7) {
    const inst = f.track.instrument;
    if (!inst) return;
    if (inst.plugin) {
      if (!audio.plugins.hear(pluginKey(f.track.id), note, vel, dur)) api.toast(`${inst.plugin} is still starting`, true);
      return;
    }
    const k = JSON.stringify(inst);
    if (!players.has(k)) players.set(k, makePlayer(inst));
    try {
      audio.hear(f.track.id, await (await players.get(k)).render({ t: 0, dur, note, vel }));
    } catch (e) { players.delete(k); api.toast(`Couldn't play ${noteName(note)}: ${e.message}`, true); }
  }

  // ---------- edits: each gesture becomes one
  // the new notes of each clip shown, in its own time (with a clip grown if they run past its sound), and the selection that
  // follows them
  const tidy = (n) => ({ t: r3(Math.max(0, n.t)), dur: r3(Math.max(0.01, n.dur)), note: n.note, vel: r2(n.vel) });
  function commit(f, desc, notes, selected) {
    const list = shown(), outs = new Map(list.map((s) => [s.id, []])), off = new Map(list.map((s) => [s.id, s.off]));
    const own = (n) => tidy({ ...n, t: n.t - off.get(n.src) });
    for (const n of notes) outs.get(n.src)?.push(own(n));
    api.edit(desc, (d) => {
      for (const s of list) {
        const out = outs.get(s.id).sort(byTime), m = d.media[s.id], was = m.length, code = api.codeNotes?.(s.id);
        if (code) {   // (a pattern whose notes its sound code writes: the director's edits kept over them)
          const o = ownNotes(code, out);
          if (JSON.stringify([o.notes, o.removed]) === JSON.stringify([m.notes ?? [], m.removed ?? []])) continue;
          m.notes = o.notes;
          if (o.removed.length) m.removed = o.removed; else delete m.removed;
        } else {
          if (JSON.stringify(out) === JSON.stringify(m.notes)) continue;
          m.notes = out;
        }
        const end = Math.max(0, ...out.map((n) => n.t + n.dur));
        if (m.length != null && end > m.length) {   // (a clip that showed all of its sound shows the new end too)
          m.length = r3(end + 0.5);
          const c = d.tracks.flatMap((t) => t.clips).find((x) => x.id === s.clip.id);
          if (c && c.in === 0 && c.out >= was - 1e-3) c.out = m.length;
        }
      }
    });
    sel = new Set(selected.map((n) => { const o = own(n); return keyOf({ src: n.src, mt: o.t, note: o.note }); }));
    dirty = true;
  }
  // where an edit is, in its description: the clip, or how many
  const where = (f) => { const n = shown().length; return n > 1 ? `${n} clips` : `"${label(f)}"`; };
  const count = (n) => (n === 1 ? 'note' : `${n} notes`);
  const words = (f, picked) => (picked.length === 1 ? `note ${noteName(picked[0].note)}` : count(picked.length));
  const chosen = (notes) => notes.filter((n) => sel.has(keyOf(n)));

  function deleteSelected() {
    const f = found(); if (!f) return;
    const base = all(), gone = chosen(base); if (!gone.length) return;
    commit(f, `delete ${words(f, gone)} from ${where(f)}`, base.filter((n) => !gone.includes(n)), []);
  }
  function copySelected(cut) {
    const f = found(); if (!f) return;
    const list = chosen(all()); if (!list.length) return;
    const t0 = Math.min(...list.map((n) => n.t));
    clipboard = list.map((n) => ({ t: r3(n.t - t0), dur: n.dur, note: n.note, vel: n.vel }));
    if (cut) deleteSelected(); else api.toast(`Copied ${count(list.length)}`);
  }
  // at the playhead, where it is in the clip and in view (set it on the ruler: it snaps); else at the left of the view
  function paste() {
    const f = found(); if (!f || !clipboard.length) return;
    const head = S.t - f.clip.at + f.clip.in, x = xOf(head), at = head >= f.clip.in && head < f.clip.out && x >= KEYS && x <= W ? head : mAt(KEYS + 8), t0 = Math.max(0, snap(f, at));
    const added = clipboard.map((n) => ({ ...n, t: t0 + n.t, src: f.id }));
    commit(f, `paste ${count(added.length)} into "${label(f)}"`, [...all(), ...added], added);
  }
  function nudge(dm, dp) {
    const f = found(); if (!f) return;
    const base = all(), picked = chosen(base); if (!picked.length) return;
    dm = Math.max(dm, -Math.min(...picked.map((n) => n.mt))); dp = clamp(dp, -Math.min(...picked.map((n) => n.note)), 127 - Math.max(...picked.map((n) => n.note)));
    if (!dm && !dp) return;
    const moved = picked.map((n) => ({ ...n, t: n.t + dm, note: n.note + dp }));
    commit(f, dp && !dm ? `transpose ${words(f, picked)} by ${dp > 0 ? '+' : ''}${dp} in ${where(f)}` : `move ${words(f, picked)} in ${where(f)}`, [...base.filter((n) => !picked.includes(n)), ...moved], moved);
    hear(shownOf(moved[0].src) ?? f, moved[0].note, moved[0].vel);
  }
  function selectAll() { sel = new Set(all().map(keyOf)); dirty = true; }
  function deselect() { sel = new Set(); dirty = true; }
  function invert() { sel = new Set(all().map(keyOf).filter((k) => !sel.has(k))); dirty = true; }

  // ---------- the tools: on the selected notes, or all of them when none is; one edit each, its notes selected after
  function tool(verb, change) {
    const f = found(); if (!f) return;
    const base = all(), picked = chosen(base), them = picked.length ? picked : base; if (!them.length) return;
    const out = change(f, them);
    commit(f, `${verb} ${words(f, them)} in ${where(f)}`, [...base.filter((n) => !them.includes(n)), ...out], picked.length ? out : []);
  }
  const fixedPer = (f) => snapPer(f) ?? zoomPer(f);   // (what a tool works to: the snap, or the zoom's lines when nothing snaps)
  const TOOLS = {
    quantize: () => tool('quantize', (f, ns) => { const per = fixedPer(f); return quantize(ns, (t) => Math.max(0, onGrid(f, t, per))); }),
    legato: () => tool('legato', (f, ns) => legato(ns)),
    chop: () => tool('chop', (f, ns) => { const per = fixedPer(f); return chop(ns, (n) => gridLines(G(), tlTime(f, n.t), tlTime(f, n.t + n.dur), per).map((l) => l.t - f.clip.at + f.clip.in)); }),
    glue: () => tool('glue', (f, ns) => glue(ns)),
    // a copy after itself (a phrase on the next bar, a note right after itself), the copy selected: again, and again after it
    duplicate: () => {
      const f = found(); if (!f) return;
      const base = all(), picked = chosen(base), them = picked.length ? picked : base; if (!them.length) return;
      const a = Math.min(...them.map((n) => n.t)), b = Math.max(...them.map((n) => n.t + n.dur)), p = partOf(f, a);
      const off = repeatEvery(b - a, { step: stepSeconds(f, a), beat: p.beat, bar: p.bar }), copies = them.map((n) => ({ ...n, t: n.t + off }));
      commit(f, `duplicate ${words(f, them)} in ${where(f)}`, [...base, ...copies], copies);
    },
  };
  function toggleGhosts() { ghostsOn = !ghostsOn; prefs.ghosts = ghostsOn; keep(); dirty = true; api.toast(`Ghost notes ${ghostsOn ? 'on' : 'off'}`); }
  toolsBtn.onclick = () => api.openMenu(toolsBtn, [
    { label: 'Quantize', hint: 'Alt+Q', act: TOOLS.quantize }, { label: 'Legato', hint: 'Ctrl+L', act: TOOLS.legato }, { label: 'Chop', hint: 'Ctrl+U', act: TOOLS.chop },
    { label: 'Glue', hint: 'Ctrl+G', act: TOOLS.glue }, { label: 'Duplicate', hint: 'Ctrl+B', act: TOOLS.duplicate }, 'hr',
    { label: 'Select all', hint: 'Ctrl+A', act: selectAll }, { label: 'Invert selection', hint: 'Shift+I', act: invert }, { label: 'Deselect', hint: 'Ctrl+D', act: deselect }, 'hr',
    { label: 'Ghost notes', hint: 'Alt+V', checked: ghostsOn, act: toggleGhosts },
  ].map((it) => (it.act ? { ...it, act: () => { it.act(); canvas.focus({ preventScroll: true }); } } : it)));

  // ---------- the pointer
  const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const inNotes = (p) => p.x >= KEYS && p.y >= RULER && p.y < H - VEL;
  const hits = (n, p) => { const x = xOf(n.t), y = yOf(n.note); return p.x >= x && p.x <= x + Math.max(3, n.dur * view.pps) && p.y >= y - view.rh && p.y < y; };
  function noteAt(p, ns = notesOf()) {
    for (let i = ns.length - 1; i >= 0; i--) if (hits(ns[i], p)) return i;
    return -1;
  }
  const atEnd = (n, p) => { const w = n.dur * view.pps; return w > 8 && p.x > xOf(n.t) + w - Math.min(EDGE, w / 3); };
  const velAt = (y) => clamp(((H - 4) - y) / (VEL - 8), 0.02, 1);
  const touch = (n) => { touched = { dur: n.dur, vel: n.vel }; };
  const seekAt = (f, p, e) => api.seek(tlTime(f, snap(f, mAt(p.x), e)));
  const noteText = (f, n) => `<b>${noteName(n.note)}</b> · ${barBeat(f, n.t)} · ${beatsLong(f, n)} · velocity ${pct(n.vel)}`;

  // the hint in the panel's bar: what is under the pointer, or what a gesture is doing; the keys when it is elsewhere
  const HINT = hintEl.innerHTML;
  let hintNow = HINT;
  function hint(h) { h ||= HINT; if (h !== hintNow) { hintNow = h; hintEl.innerHTML = h; } }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // ---------- G and S on the selected notes (docs/selection.md), the roll focused: G moves them in time and pitch as the
  // pointer goes, S stretches their timing (each start and length) about the playhead. A number typed is the amount (G:
  // seconds; S: how many times as long). A click or Enter sets it, Esc or a right click puts it back: one edit
  let lastP = null;
  function gesture(mode) {
    const f = found(), notes = all(), picked = chosen(notes);
    if (!f || !picked.length || drag) return false;
    const start = lastP ?? { x: xOf(picked[0].t), y: yOf(picked[0].note) }, anchor = picked.reduce((a, n) => (n.t < a.t ? n : a));
    drag = { kind: 'g', mode, f, base: notes, picked, anchor, start, m0: mAt(start.x), typed: '', work: notes, hot: new Set(picked), desc: '' };
    stepGesture(start, {});
    return true;
  }
  function stepGesture(p, e) {
    const d = drag, f = d.f, n = /^-?\d*\.?\d+$/.test(d.typed) ? +d.typed : null, { picked } = d;
    let moved;
    if (d.mode === 'move') {
      let dm = n ?? snap(f, d.anchor.t + mAt(p.x) - d.m0, e) - d.anchor.t, dp = n != null ? 0 : pitchAt(p.y) - pitchAt(d.start.y);
      dm = Math.max(dm, -Math.min(...picked.map((x) => x.mt))); dp = clamp(dp, -Math.min(...picked.map((x) => x.note)), 127 - Math.max(...picked.map((x) => x.note)));
      moved = new Map(picked.map((x) => [x, { ...x, t: x.t + dm, note: x.note + dp }]));
      d.desc = `move ${words(f, picked)} by ${f2(dm)} s${dp ? `, ${dp > 0 ? '+' : ''}${dp} semitones` : ''} in ${where(f)}`;
      hint(`<b>Move</b> ${dm >= 0 ? '+' : '−'}${f2(Math.abs(dm))} s${dp ? ` · ${dp > 0 ? '+' : ''}${dp} st` : ''}${d.typed ? ` · typed ${d.typed}` : ''} · click or Enter sets it · Esc puts it back`);
    } else {
      const head = S.t - f.clip.at + f.clip.in, a = d.start.x - xOf(head), k = Math.max(0, n ?? (Math.abs(a) < 4 ? 1 : (p.x - xOf(head)) / a));
      moved = new Map(picked.map((x) => [x, { ...x, t: Math.max(0, head + (x.t - head) * k), dur: Math.max(0.02, x.dur * k) }]));
      d.desc = `stretch ${words(f, picked)} ×${k.toFixed(3)} about the playhead in ${where(f)}`;
      hint(`<b>Stretch</b> ×${k.toFixed(3)} about the playhead${d.typed ? ` · typed ${d.typed}` : ''} · click or Enter sets it · Esc puts it back`);
    }
    d.hot = new Set(moved.values()); d.work = d.base.map((x) => moved.get(x) ?? x); d.p = p;
    dirty = true;
  }
  function endGesture(set) {
    const d = drag;
    drag = null; dirty = true; hint('');
    if (set) commit(d.f, d.desc, d.work, [...d.hot]);
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (drag?.kind === 'g') { e.preventDefault(); e.stopPropagation(); return endGesture(e.button === 0); }
    const f = found(); if (!f || (e.button !== 0 && e.button !== 2)) return;
    endWheel();
    canvas.focus(); canvas.setPointerCapture(e.pointerId);
    const p = pt(e), notes = all(), ctrl = e.ctrlKey || e.metaKey;
    if (e.button === 2) return erase(f, p, notes);
    if (p.y < RULER) { if (p.x >= KEYS) { seekAt(f, p, e); drag = { kind: 'scrub' }; } return; }
    if (p.x < KEYS) {   // the keyboard: play it (drag: from key to key); Ctrl-drag selects the notes of those pitches
      if (p.y >= H - VEL) return;
      const pitch = pitchAt(p.y);
      if (ctrl) { drag = { kind: 'pitches', from: pitch, to: pitch, add: e.shiftKey, was: sel }; pickPitches(notes, pitch); return; }
      held = pitch; hear(f, held); drag = { kind: 'key' }; dirty = true; return;
    }
    if (p.y >= H - VEL) {   // the velocity lane: paint each bar passed (of the selected notes, when there are some); Shift: a line
      drag = { kind: 'paint', f, base: notes, work: notes, start: p, last: p, only: chosen(notes).length ? new Set(sel) : null, vals: new Map(), line: e.shiftKey, reset: e.altKey };
      paint(p); return;
    }
    const i = noteAt(p, notes), n = i >= 0 ? notes[i] : null;
    if (ctrl) { drag = { kind: 'box', start: p, p, add: e.shiftKey, on: n && keyOf(n) }; return; }
    if (n) {   // a note: move it with the others selected, or resize them by its end; Shift: move copies (a click: select it too)
      const k = keyOf(n), copy = e.shiftKey, picked = sel.has(k) ? chosen(notes) : [n];
      if (!copy && !sel.has(k)) sel = new Set([k]);
      touch(n); hear(shownOf(n.src) ?? f, n.note, n.vel);
      drag = { kind: !copy && atEnd(n, p) ? 'resize' : 'move', copy, f, base: notes, picked, grabbed: n, start: p, m0: mAt(p.x), dm: 0, dp: 0, work: notes, hot: new Set(), moved: false };
      dirty = true; return;
    }
    // empty space: a note in the cell clicked, as long and as loud as the last touched; dragging places it (Shift: its length)
    const t = Math.max(0, snap(f, mAt(p.x), e, true)), pitch = pitchAt(p.y);
    const made = { t, dur: Math.max(touched.dur ?? partOf(f, t).beat, 0.02), note: pitch, vel: touched.vel, src: f.id, mt: t };
    sel = new Set(); hear(f, pitch, made.vel);
    drag = { kind: e.shiftKey ? 'length' : 'place', f, base: notes, start: p, m0: mAt(p.x), made0: made, made, work: [...notes, made], hot: new Set([made]), moved: false };
    dirty = true;
    hint(noteText(f, made));
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = pt(e);
    lastP = p;
    if (drag?.kind === 'g') return stepGesture(p, e);
    if (!drag) return hoverAt(p, e);
    const f = drag.f;
    if (drag.kind === 'scrub') { const g = found(); if (g) { seekAt(g, p, e); hint(`<b>Playhead</b> ${barBeat(g, snap(g, mAt(p.x), e))}`); } return; }
    if (drag.kind === 'key') { const pitch = pitchAt(p.y); if (pitch !== held) { held = pitch; hear(found(), pitch); dirty = true; } return; }
    if (drag.kind === 'pitches') return pickPitches(all(), pitchAt(p.y));
    if (drag.kind === 'box') { drag.p = p; dirty = true; return; }
    if (drag.kind === 'erase') return erasing(p);
    if (drag.kind === 'paint') return paint(p);
    if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < MIN_DRAG) return;
    drag.moved = true;
    const { picked } = drag;
    if (drag.kind === 'move') {
      let dm = snap(f, drag.grabbed.t + mAt(p.x) - drag.m0, e) - drag.grabbed.t, dp = pitchAt(p.y) - pitchAt(drag.start.y);
      dm = Math.max(dm, -Math.min(...picked.map((n) => n.mt))); dp = clamp(dp, -Math.min(...picked.map((n) => n.note)), 127 - Math.max(...picked.map((n) => n.note)));
      if (dp !== drag.dp) hear(shownOf(drag.grabbed.src) ?? f, drag.grabbed.note + dp, drag.grabbed.vel);
      drag.dm = dm; drag.dp = dp;
      const moved = new Map(picked.map((n) => [n, { ...n, t: n.t + dm, note: n.note + dp }]));
      drag.hot = new Set(moved.values());
      drag.work = drag.copy ? [...drag.base, ...moved.values()] : drag.base.map((n) => moved.get(n) ?? n);
      hint(`${drag.copy ? '<b>Copy</b> ' : ''}${noteText(f, moved.get(drag.grabbed))}`);
    } else if (drag.kind === 'resize') {
      const end = snap(f, mAt(p.x), e), dd = end - (drag.grabbed.t + drag.grabbed.dur);
      const sized = new Map(picked.map((n) => [n, { ...n, dur: Math.max(n.dur + dd, 0.02) }]));
      drag.hot = new Set(sized.values()); drag.work = drag.base.map((n) => sized.get(n) ?? n); drag.sized = sized.get(drag.grabbed);
      hint(noteText(f, drag.sized));
    } else if (drag.kind === 'place') {
      const t = Math.max(0, snap(f, drag.made0.t + mAt(p.x) - drag.m0, e)), note = pitchAt(p.y);
      if (note !== drag.made.note) hear(f, note, drag.made.vel);
      drag.made = { ...drag.made0, t, mt: t, note };
      drag.hot = new Set([drag.made]); drag.work = [...drag.base, drag.made];
      hint(noteText(f, drag.made));
    } else if (drag.kind === 'length') {
      const end = snap(f, mAt(p.x), e);
      drag.made = { ...drag.made, dur: Math.max(end - drag.made.t, stepSeconds(f, drag.made.t, e)) };
      drag.hot = new Set([drag.made]); drag.work = [...drag.base, drag.made];
      hint(noteText(f, drag.made));
    }
    dirty = true;
  });

  canvas.addEventListener('pointerup', (e) => {
    if (drag?.kind === 'g') return;
    const d = drag; drag = null; dirty = true;
    held = '';
    if (d) release(d, e);
    hoverAt(pt(e), e);
  });
  function release(d, e) {
    if (d.kind === 'box') return boxed(d, pt(e));
    const f = d.f;
    if (!f) return;
    if (d.kind === 'erase') {
      if (d.gone.size) commit(f, `delete ${count(d.gone.size)} from ${where(f)}`, d.work, chosen(d.work));
      else if (d.empty) deselect();
      return;
    }
    if (d.kind === 'paint') { if (d.vals.size) commit(f, `set velocity of ${count(d.vals.size)} in ${where(f)}`, d.work, chosen(d.work)); return; }
    if (d.kind === 'place' || d.kind === 'length') {
      if (d.kind === 'length' && d.moved) touched.dur = d.made.dur;
      commit(f, `add note ${noteName(d.made.note)} at ${f2(d.made.t)} s to "${label(f)}"`, d.work, [d.made]);
      return;
    }
    if (!d.moved) {   // a Shift-click: the note in or out of the selection
      if (d.copy) { const k = keyOf(d.grabbed); sel = new Set(sel); sel.has(k) ? sel.delete(k) : sel.add(k); }
      return;
    }
    const out = [...d.hot];
    if (d.copy) { if (d.dm || d.dp) commit(f, `copy ${words(f, d.picked)} in ${where(f)}`, d.work, out); return; }
    if (d.kind === 'resize') touched.dur = d.sized.dur;
    const at = d.kind === 'move' && out.length === 1 ? ` to ${f2(out[0].t)} s` : '';
    commit(f, `${d.kind} ${words(f, d.picked)}${at} in ${where(f)}`, d.work, out);
  }
  canvas.addEventListener('pointercancel', () => { drag = null; held = ''; dirty = true; });
  canvas.addEventListener('pointerleave', () => { lastP = null; if (!drag) { hover = null; hint(''); dirty = true; } });
  canvas.addEventListener('contextmenu', (e) => { if (drag?.kind === 'g') e.preventDefault(); }, true);

  // what the pointer is over: its cursor, the row and key lit, the hint
  function hoverAt(p, e) {
    const f = found(); if (!f) return;
    let h = null, cursor = 'default', text = '';
    if (p.y < RULER) {
      if (p.x >= KEYS) { cursor = 'text'; text = `<b>Playhead</b> click to set it, on the snap (Alt: anywhere) · ${barBeat(f, snap(f, mAt(p.x), e))}`; }
    } else if (p.x < KEYS) {
      if (p.y < H - VEL) { h = { pitch: pitchAt(p.y), i: -1 }; cursor = 'pointer'; text = `<b>${noteName(h.pitch)}</b> click to hear it · Ctrl-drag: select the notes of these keys`; }
    } else if (p.y >= H - VEL) {
      cursor = 'ns-resize'; text = '<b>Velocity</b> drag to paint it · Shift-drag: a line · Alt-click: reset';
    } else {
      const ns = notesOf(), i = noteAt(p, ns), n = ns[i];
      h = { pitch: pitchAt(p.y), i };
      if (n) { cursor = e.shiftKey ? 'copy' : atEnd(n, p) ? 'ew-resize' : 'grab'; text = noteText(f, n); }
      else { cursor = 'crosshair'; text = `${noteName(h.pitch)} · ${barBeat(f, Math.max(0, snap(f, mAt(p.x), e, true)))}`; }
    }
    canvas.style.cursor = cursor;
    if (h?.pitch !== hover?.pitch || h?.i !== hover?.i) { hover = h; dirty = true; }
    hint(text);
  }

  // a right-click deletes the note under it, a right-drag each note it crosses; on empty space, with none crossed, it
  // deselects. Twice on a ghost: opens its clip.
  function erase(f, p, notes) {
    const now = performance.now(), twice = lastRight && now - lastRight.t < 400 && Math.hypot(p.x - lastRight.x, p.y - lastRight.y) < 6;
    lastRight = { t: now, x: p.x, y: p.y };
    if (twice && inNotes(p) && noteAt(p, notes) < 0) {
      const g = ghosts().findLast((n) => hits(n, p));
      if (g) { drag = null; api.select(g.clip.id); return; }
    }
    drag = { kind: 'erase', f, base: notes, work: notes, gone: new Set(), last: p, empty: inNotes(p) && noteAt(p, notes) < 0 };
    erasing(p);
  }
  function erasing(p) {
    const d = drag, n = Math.max(1, Math.ceil(Math.hypot(p.x - d.last.x, p.y - d.last.y) / 3));
    for (let k = 1; k <= n; k++) {   // (every few px along the way, so that a quick sweep misses none)
      const q = { x: d.last.x + ((p.x - d.last.x) * k) / n, y: d.last.y + ((p.y - d.last.y) * k) / n };
      if (!inNotes(q)) continue;
      const i = noteAt(q, d.work); if (i < 0) continue;
      d.gone.add(d.work[i]); d.work = d.work.filter((_, j) => j !== i);
    }
    d.last = p; dirty = true;
    if (d.gone.size) hint(`<b>Delete</b> ${count(d.gone.size)}`);
  }
  function boxed(d, b) {
    const a = d.start;
    if (Math.hypot(b.x - a.x, b.y - a.y) < MIN_DRAG) {   // a Ctrl-click: the note in or out of the selection; on empty space, none
      if (d.on) { sel = new Set(sel); sel.has(d.on) ? sel.delete(d.on) : sel.add(d.on); } else if (!d.add) sel = new Set();
      return;
    }
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const picked = notesOf().filter((n) => xOf(n.t) <= x1 && xOf(n.t + n.dur) >= x0 && yOf(n.note) - view.rh <= y1 && yOf(n.note) >= y0).map(keyOf);
    sel = d.add ? new Set([...sel, ...picked]) : new Set(picked);
  }
  function pickPitches(notes, to) {
    const d = drag, lo = Math.min(d.from, to), hi = Math.max(d.from, to);
    d.to = to;
    sel = new Set([...(d.add ? d.was : []), ...notes.filter((n) => n.note >= lo && n.note <= hi).map(keyOf)]);
    hint(`<b>Select</b> ${noteName(lo)}${hi > lo ? `–${noteName(hi)}` : ''} · ${count(chosen(notes).length)}`);
    dirty = true;
  }
  function paint(p) {
    const d = drag, a = d.line ? d.start : d.last;
    const vAt = d.line ? (x) => velAt(a.y) + (velAt(p.y) - velAt(a.y)) * (p.x === a.x ? 1 : clamp((x - a.x) / (p.x - a.x), 0, 1)) : () => (d.reset ? VEL0 : velAt(p.y));
    if (d.line) d.vals = new Map();   // (a line: the notes under it now)
    for (const n of d.base) {
      const x = xOf(n.t) + 2;
      if ((!d.only || d.only.has(keyOf(n))) && x >= Math.min(a.x, p.x) - 3 && x <= Math.max(a.x, p.x) + 3) d.vals.set(n, r2(clamp(vAt(x), 0.02, 1)));
    }
    d.work = d.base.map((n) => (d.vals.has(n) ? { ...n, vel: d.vals.get(n) } : n));
    d.last = p; dirty = true;
    hint(`<b>Velocity</b> ${pct(d.reset ? VEL0 : velAt(p.y))}${d.vals.size ? ` · ${count(d.vals.size)}` : ''}`);
  }

  // ---------- Alt+wheel over the notes: the velocity of the note under the pointer (and the rest of the selection, if it is
  // in it), or of the selected notes; one edit once the wheel rests
  let wheeling = null;
  function endWheel() {
    const w = wheeling; if (!w) return;
    wheeling = null; clearTimeout(w.timer);
    commit(w.f, `set velocity of ${words(w.f, w.them)} in ${where(w.f)}`, w.work, [...w.hot]);
  }
  onEvery('keyup', (e) => { if (e.key === 'Alt') endWheel(); });
  function wheelVelocity(e, p) {
    const f = found(); if (!f) return false;
    if (!wheeling) {
      const notes = all(), n = inNotes(p) ? notes[noteAt(p, notes)] : null, them = n && !sel.has(keyOf(n)) ? [n] : chosen(notes);
      if (!them.length) return false;
      wheeling = { f, base: notes, them, dv: 0 };
    }
    const w = wheeling;
    w.dv += (-e.deltaY / 100) * (e.ctrlKey || e.metaKey ? 0.005 : 0.03);   // (Ctrl: finely)
    const set = new Map(w.them.map((n) => [n, { ...n, vel: r2(clamp(n.vel + w.dv, 0.02, 1)) }]));
    w.hot = new Set(set.values()); w.work = w.base.map((n) => set.get(n) ?? n);
    clearTimeout(w.timer); w.timer = setTimeout(endWheel, 600);
    hint(`<b>Velocity</b> ${pct(set.get(w.them[0]).vel)}${w.them.length > 1 ? ` · ${count(w.them.length)}` : ''}`);
    dirty = true;
    return true;
  }

  // ---------- middle-drag pans, as the timeline's does: along in time, and up and down the pitches
  let pan = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault(); e.stopPropagation();   // (not the browser's autoscroll, nor a note's drag)
    pan = { x: e.clientX, y: e.clientY, x0: view.x0, top: view.top };
    canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing';
  }, true);
  canvas.addEventListener('pointermove', (e) => {
    if (!pan) return;
    e.stopPropagation();
    view.x0 = pan.x0 - (e.clientX - pan.x) / view.pps;
    view.top = clamp(pan.top + (e.clientY - pan.y) / view.rh, 12, 127);
    dirty = true;
  }, true);
  canvas.addEventListener('pointerup', (e) => { if (!pan || e.button !== 1) return; e.stopPropagation(); pan = null; canvas.style.cursor = ''; }, true);
  canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

  // the bar's zoom (as the timeline's): around the middle of what shows, and Fit (the clip across, its notes centred)
  const zoomBy = (k) => { const m = mAt((KEYS + W) / 2); view.pps = clamp(view.pps * k, 4, 4000); view.x0 = m - ((W - KEYS) / 2) / view.pps; dirty = true; };
  $('#rollIn').onclick = () => zoomBy(1.5);
  $('#rollOut').onclick = () => zoomBy(1 / 1.5);
  $('#rollFit').onclick = () => { if (found()) { fitView(); dirty = true; } };

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = pt(e);
    if (e.altKey && p.x >= KEYS) { wheelVelocity(e, p); return; }
    if (e.ctrlKey || e.metaKey) {   // zoom the time at the pointer
      const m = mAt(p.x), k = Math.exp(-e.deltaY * 0.003);
      view.pps = clamp(view.pps * k, 4, 4000); view.x0 = m - (p.x - KEYS) / view.pps;
    } else if (e.altKey) { view.rh = clamp(view.rh * Math.exp(-e.deltaY * 0.002), 6, 40); }   // (over the keyboard: taller or shorter rows)
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) view.x0 += (e.deltaX || e.deltaY) / view.pps;
    else view.top = clamp(view.top + e.deltaY / view.rh * 0.5, 12, 127);
    dirty = true;
  }, { passive: false });

  // keys while the roll has focus (they stay here: Delete would otherwise delete the clip); undo, redo, Space and N (Snap)
  // go on to the editor
  canvas.addEventListener('keydown', (e) => {
    const f = found(); if (!f) return;
    if (drag?.kind === 'g') {   // (G or S under way: a number typed, Enter, Esc, or the other of G and S)
      if (e.key === 'Enter') endGesture(true);
      else if (e.key === 'Escape') endGesture(false);
      else if (/^[0-9.]$/.test(e.key) || (e.key === '-' && !drag.typed)) { drag.typed += e.key; stepGesture(drag.p, e); }
      else if (e.key === 'Backspace') { drag.typed = drag.typed.slice(0, -1); stepGesture(drag.p, e); }
      else if ((e.code === 'KeyG' || e.code === 'KeyS') && !e.repeat) { drag.mode = e.code === 'KeyG' ? 'move' : 'stretch'; drag.typed = ''; stepGesture(drag.p, e); }
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat && (e.code === 'KeyG' || e.code === 'KeyS') && gesture(e.code === 'KeyG' ? 'move' : 'stretch')) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Escape' && (drag || wheeling)) {   // (a gesture under way: dropped)
      if (wheeling) { clearTimeout(wheeling.timer); wheeling = null; }
      drag = null; held = ''; dirty = true; hint('');
      e.preventDefault(); e.stopPropagation(); return;
    }
    endWheel();
    const mod = e.ctrlKey || e.metaKey, k = e.code, alt = e.altKey;
    let handled = true;
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    else if (mod && k === 'KeyA') selectAll();
    else if (mod && k === 'KeyD') deselect();
    else if (mod && k === 'KeyC') copySelected(false);
    else if (mod && k === 'KeyX') copySelected(true);
    else if (mod && k === 'KeyV') paste();
    else if (mod && k === 'KeyB') TOOLS.duplicate();
    else if (mod && k === 'KeyL') TOOLS.legato();
    else if (mod && k === 'KeyU') TOOLS.chop();
    else if (mod && k === 'KeyG') TOOLS.glue();
    else if (alt && !mod && k === 'KeyQ') TOOLS.quantize();
    else if (alt && !mod && k === 'KeyV') toggleGhosts();
    else if (e.shiftKey && !mod && !alt && k === 'KeyI') invert();
    else if (e.key === 'Escape') deselect();
    else if (e.key === 'PageUp') nudge(0, 12);
    else if (e.key === 'PageDown') nudge(0, -12);
    else if (e.key === 'ArrowUp') nudge(0, mod ? 12 : 1);
    else if (e.key === 'ArrowDown') nudge(0, mod ? -12 : -1);
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && sel.size) nudge((e.key === 'ArrowLeft' ? -1 : 1) * (alt ? 1 / view.pps : stepSeconds(f, mAt(W / 2))), 0);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  });

  // ---------- drawn
  function draw() {
    // the clip shown follows the selection (a notes clip selected in the timeline opens here)
    const s = [...S.sel].join();
    if (s !== seenSel) {
      seenSel = s;
      const pick = S.doc.tracks.flatMap((t) => t.clips).find((c) => S.sel.has(c.id) && isNotes(S.doc.media[c.media]));
      if (pick && !S.sel.has(clipId)) open(pick.id);   // (the first opened stays first while it is selected)
      else dirty = true;
    }
    const f = found();
    if (f && fit && body.clientWidth > 200) { resize(); fitView(); }
    if (glint && performance.now() - glint.t0 > GLINT) { glint = null; dirty = true; }
    const key = [S.t, W, H, view.x0, view.pps, view.top, view.rh, sel.size, S.snap, S.snapGrid, snapMode, !!api.playing?.(), glint && performance.now()].join('|');
    if (!dirty && key === drawn) return;
    dirty = false; drawn = key;
    snapLabel(f);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    const ss = f ? shown() : [], ns = ss.reduce((a, s) => a + s.m.notes.length, 0);
    const ctx = !f ? '' : ss.length > 1 ? `${ss.map((s) => `"${label(s)}"`).join(' + ')} · ${ns} note${ns === 1 ? '' : 's'}` : `"${label(f)}" · ${instrumentName(f.track.instrument)} · ${ns} note${ns === 1 ? '' : 's'}`;
    if (ctxEl.textContent !== ctx) ctxEl.textContent = ctx;
    if (!f) {
      g.fillStyle = C.dim; g.font = '12px system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText('Select a notes clip in the timeline, or add one with + Notes', W / 2, H / 2); g.textAlign = 'left';
      return;
    }
    rows(g); gridLinesDraw(g, f); region(g); ghostsDraw(g); notesDraw(g); velocityLane(g); keyboard(g); ruler(g, f); playhead(g, f);
    if (drag?.kind === 'box') {
      const a = drag.start, b = drag.p;
      g.fillStyle = `rgba(${C.head},0.12)`; g.strokeStyle = `rgba(${C.head},0.7)`;
      g.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y)); g.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    }
  }
  const instrumentName = (i) => { const o = instrumentOf(i); return o.kind === 'none' ? 'no instrument' : `${o.device} · ${o.name}`; };

  function rows(g) {
    g.save(); g.beginPath(); g.rect(KEYS, RULER, W - KEYS, notesH()); g.clip();
    for (let p = 0; p < 128; p++) {
      const y = yOf(p);
      if (y < RULER - view.rh || y > H) continue;
      g.fillStyle = BLACK.has(p % 12) ? C.black : C.white; g.fillRect(KEYS, y - view.rh, W - KEYS, view.rh);
      if (p === hover?.pitch) { g.fillStyle = C.hoverRow; g.fillRect(KEYS, y - view.rh, W - KEYS, view.rh); }
      g.fillStyle = p % 12 === 0 ? C.octave : C.rowLine; g.fillRect(KEYS, Math.round(y) - 1, W - KEYS, 1);
    }
    g.restore();
  }
  // every other bar a shade darker; the bar and beat lines, and between them the snap's (a quarter of a beat when it snaps
  // to beats or more)
  function gridLinesDraw(g, f) {
    const t0 = tlTime(f, mAt(KEYS)), t1 = tlTime(f, mAt(W)), ps = gridParts(G()), p = partAt(ps, (t0 + t1) / 2);
    const lineAt = (t) => Math.round(xOf(t - f.clip.at + f.clip.in));
    const bars = gridLines(G(), t0 - p.bar, t1, 'bar');
    g.fillStyle = C.oddBar;
    bars.forEach((l, i) => { if (l.bar % 2) { const a = lineAt(l.t), b = bars[i + 1] ? lineAt(bars[i + 1].t) : W; g.fillRect(Math.max(KEYS, a), RULER, Math.min(W, b) - Math.max(KEYS, a), notesH()); } });
    const per = snapPer(f), sub = typeof per === 'number' && per < 1 ? per : 0.25;
    for (const [each, color] of [[sub, C.sub], [1, C.beat]]) if (p.beat * each * view.pps >= 6) for (const l of gridLines(G(), t0, t1, each)) { g.fillStyle = color; g.fillRect(lineAt(l.t), RULER, 1, notesH() + VEL); }
    for (const l of bars) { g.fillStyle = C.bar; g.fillRect(lineAt(l.t), RULER, 1, notesH() + VEL); }
  }
  // what is outside the clips (before the first's in, after the last's out) is dimmed: it is not heard
  function region(g) {
    g.fillStyle = C.outside;
    const [ia, ib] = span(), a = xOf(ia), b = xOf(ib);
    if (a > KEYS) g.fillRect(KEYS, RULER, Math.min(a, W) - KEYS, H - RULER);
    if (b < W) g.fillRect(Math.max(b, KEYS), RULER, W - Math.max(b, KEYS), H - RULER);
  }
  function ghostsDraw(g) {
    g.save(); g.beginPath(); g.rect(KEYS, RULER, W - KEYS, notesH()); g.clip();
    g.fillStyle = C.ghost; g.strokeStyle = C.ghostEdge;
    for (const n of ghosts()) {
      const x = xOf(n.t), w = Math.max(3, n.dur * view.pps), y = yOf(n.note) - view.rh;
      if (x > W || x + w < KEYS || y > H || y < RULER - view.rh) continue;
      g.fillRect(x, y + 1, w, view.rh - 1); g.strokeRect(x + 0.5, y + 1.5, w - 1, view.rh - 2);
    }
    g.restore();
  }
  function notesDraw(g) {
    g.save(); g.beginPath(); g.rect(KEYS, RULER, W - KEYS, notesH()); g.clip();
    const ids = shown().map((s) => s.id), hot = drag?.hot ?? wheeling?.hot, tops = coloursOf();   // (the first clip's notes as they are; another's edged in its own colour)
    notesOf().forEach((n, i) => {
      const x = xOf(n.t), w = Math.max(3, n.dur * view.pps), y = yOf(n.note) - view.rh, on = hot?.size ? hot.has(n) : sel.has(keyOf(n));
      if (x > W || x + w < KEYS || y > H || y < RULER - view.rh) return;
      const top = tops.get(n.src);
      g.fillStyle = on ? mix(top, '#ffffff', 0.35) : velColor(top, n.vel); g.fillRect(x, y + 1, w, view.rh - 1);
      g.fillStyle = `rgba(255,255,255,${!drag && hover?.i === i ? 0.32 : 0.18})`; g.fillRect(x, y + 1, w, 1);
      if (!drag && hover?.i === i) { g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(x, y + 1, w, view.rh - 1); }
      const c = ids.indexOf(n.src);
      if (c > 0) { g.fillStyle = CLIP_EDGE[(c - 1) % CLIP_EDGE.length]; g.fillRect(x, y + 1, 3, view.rh - 1); }
      if (on) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.strokeRect(x + 0.5, y + 1.5, w - 1, view.rh - 2); g.lineWidth = 1; }
      if (glint?.keys.has(keyOf(n))) glinted(g, n, x, y, w);
      if (w > 28 && view.rh >= 11) { g.fillStyle = C.ink; g.font = '9px system-ui, sans-serif'; g.fillText(noteName(n.note), x + 3, y + view.rh - 3); }
    });
    g.restore();
  }
  function velocityLane(g) {
    const y0 = H - VEL, hot = drag?.hot ?? wheeling?.hot, tops = coloursOf();
    g.fillStyle = C.bg; g.fillRect(KEYS, y0, W - KEYS, VEL); g.fillStyle = C.seam; g.fillRect(KEYS, y0, W - KEYS, 1);
    g.save(); g.beginPath(); g.rect(KEYS, y0, W - KEYS, VEL); g.clip();
    for (const n of notesOf()) {
      const x = xOf(n.t), on = hot?.size ? hot.has(n) : sel.has(keyOf(n)), h = n.vel * (VEL - 8);
      if (x < KEYS - 4 || x > W) continue;
      const top = tops.get(n.src);
      g.fillStyle = on ? mix(top, '#ffffff', 0.35) : velColor(top, n.vel); g.fillRect(x, H - 4 - h, 4, h);
      if (on) { g.fillStyle = '#fff'; g.fillRect(x, H - 4 - h, 4, 1.5); }
    }
    if (drag?.kind === 'paint' && drag.line) { g.strokeStyle = `rgba(${C.head},0.8)`; g.beginPath(); g.moveTo(drag.start.x, drag.start.y); g.lineTo(drag.last.x, drag.last.y); g.stroke(); }
    g.restore();
    g.fillStyle = C.dim; g.font = '9px system-ui, sans-serif'; g.fillText('velocity', 6, y0 + 12);
  }
  function keyboard(g) {
    // (while playing, the keys its notes sound at the playhead lit; the key under the pointer, and those a Ctrl-drag spans, tinted)
    const lit = new Set(api.playing?.() ? shown().flatMap((s) => soundingNotes(api.heardDoc?.() ?? S.doc, s.id, S.t)).map((n) => n.note) : []);
    const [lo, hi] = drag?.kind === 'pitches' ? [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)] : [hover?.pitch ?? -1, hover?.pitch ?? -1];
    g.fillStyle = C.bg; g.fillRect(0, RULER, KEYS, H - RULER);
    g.save(); g.beginPath(); g.rect(0, RULER, KEYS, notesH()); g.clip();
    for (let p = 0; p < 128; p++) {
      const y = yOf(p) - view.rh;
      if (y > H || y < RULER - view.rh) continue;
      const black = BLACK.has(p % 12), w = black ? KEYS * 0.62 : KEYS - 1;
      g.fillStyle = (p === held && drag?.kind === 'key') || lit.has(p) ? `rgb(${C.head})` : black ? C.keyBlack : C.keyWhite;
      g.fillRect(0, y + 0.5, w, view.rh - 1);
      if (p >= lo && p <= hi) { g.fillStyle = `rgba(${C.head},0.45)`; g.fillRect(0, y + 0.5, w, view.rh - 1); }
      if (p % 12 === 0) { g.fillStyle = C.keyText; g.font = '9px system-ui, sans-serif'; g.fillText(noteName(p), KEYS - 20, y + view.rh - 3); }
    }
    g.restore();
    g.fillStyle = C.seam; g.fillRect(KEYS - 1, RULER, 1, H - RULER);
  }
  function ruler(g, f) {
    g.fillStyle = C.ruler; g.fillRect(0, 0, W, RULER);
    g.save(); g.beginPath(); g.rect(KEYS, 0, W - KEYS, RULER); g.clip();
    g.font = '9px system-ui, sans-serif'; g.fillStyle = C.dim;
    const t0 = tlTime(f, mAt(KEYS)), t1 = tlTime(f, mAt(W)), lineAt = (t) => Math.round(xOf(t - f.clip.at + f.clip.in));
    if (partAt(gridParts(G()), (t0 + t1) / 2).beat * view.pps >= 8) for (const l of gridLines(G(), t0, t1, 1)) if (l.beat) g.fillRect(lineAt(l.t), RULER - 4, 1, 4);
    for (const l of gridLines(G(), t0, t1, 'bar')) { const x = lineAt(l.t); g.fillRect(x, 6, 1, RULER - 6); g.fillText(String(l.bar), x + 3, 11); }
    g.restore();
  }
  function playhead(g, f) {
    const x = xOf(S.t - f.clip.at + f.clip.in);
    if (x < KEYS || x > W) return;
    g.fillStyle = `rgb(${C.head})`; g.fillRect(Math.round(x), 0, 1, H);
  }

  /** While playing: the view pages on when the playhead (inside the clip) runs off it, as the timeline's does. */
  function follow() {
    const f = found();
    if (!f || drag) return;
    const m = S.t - f.clip.at + f.clip.in;
    if (m < f.clip.in || m > f.clip.out) return;
    const x = xOf(m);
    if (x > W - 40 || x < KEYS) { view.x0 = m - ((W - KEYS) / view.pps) * 0.08; dirty = true; }
  }

  // ---------- Claude's light (presence.js): the notes it just wrote glint in its colours, violet to blue, a sweep across
  // them in time (as its pencil went), each flaring and fading over two seconds, while the roll shows their clip
  let glint = null;   // { keys (keyOf each), t0, a, b (the span of their times) }
  function glinted(g, n, x, y, w) {
    const u = glint.b > glint.a ? (n.t - glint.a) / (glint.b - glint.a) : 0, s = (performance.now() - glint.t0) / 1000 - 0.45 * u;
    const k = s < 0 ? 0 : Math.min(1, s / 0.12) * (1 - Math.min(1, Math.max(0, (s - 0.35) / 1.2)));
    if (k <= 0) return;
    const c = `${Math.round(158 - 61 * u)},${Math.round(120 + 48 * u)},255`;
    g.save();
    g.shadowColor = `rgba(${c},${k})`; g.shadowBlur = 14 * k;
    g.strokeStyle = `rgba(${c},${k})`; g.lineWidth = 1.5; g.strokeRect(x + 0.5, y + 1.5, w - 1, view.rh - 2);
    g.shadowBlur = 0; g.fillStyle = `rgba(255,255,255,${0.3 * k})`; g.fillRect(x, y + 1, w, view.rh - 1);
    g.restore();
  }
  /** Lights `notes` (each { t, note }, in medium `media`'s own time) where the roll shows that medium: their box in the
   *  window as a function (null when none is in view, or the roll is in a window of its own), else null. */
  function light(media, notes) {
    const s = shownOf(media);
    if (!s || !notes.length || !canvas.getBoundingClientRect().width) return null;
    const keys = new Set(notes.map((n) => keyOf({ src: media, mt: n.t, note: n.note }))), ts = notes.map((n) => n.t + s.off);
    glint = { keys, t0: performance.now(), a: Math.min(...ts), b: Math.max(...ts) };
    dirty = true;
    if (canvas.ownerDocument !== document) return null;
    return () => {
      const ns = notesOf().filter((n) => keys.has(keyOf(n))), c = canvas.getBoundingClientRect();
      if (!ns.length) return null;
      const x0 = Math.max(KEYS, Math.min(...ns.map((n) => xOf(n.t)))), x1 = Math.min(W, Math.max(...ns.map((n) => xOf(n.t) + Math.max(3, n.dur * view.pps))));
      const y0 = Math.max(RULER, Math.min(...ns.map((n) => yOf(n.note) - view.rh))), y1 = Math.min(H - VEL, Math.max(...ns.map((n) => yOf(n.note))));
      return x1 > x0 && y1 > y0 ? new DOMRect(c.left + x0, c.top + y0, x1 - x0, y1 - y0) : null;
    };
  }

  return {
    draw, show, follow, light, invalidate: () => { dirty = true; }, focus: () => canvas.focus({ preventScroll: true }),
    /** The selected notes, in words (for the agent): by pattern, each note's pitch and its time in the pattern (a few: their
     *  pitches only). */
    describeSel() {
      if (!found()) return null;
      const ns = chosen(all());
      if (!ns.length) return null;
      const by = Map.groupBy(ns.sort((a, b) => a.mt - b.mt || a.note - b.note), (n) => n.src);
      return [...by].map(([src, xs]) => `${xs.length} of "${src}" (${xs.length <= 12 ? xs.map((n) => `${noteName(n.note)} at ${n.mt.toFixed(2)} s`).join(', ') : `${[...new Set(xs.map((n) => noteName(n.note)))].join(' ')}, ${xs[0].mt.toFixed(2)}–${Math.max(...xs.map((n) => n.mt + n.dur)).toFixed(2)} s`} in the pattern)`).join('; ');
    },
    /** How many notes are selected. */
    selectedCount: () => (found() ? chosen(all()).length : 0),
  };
}
