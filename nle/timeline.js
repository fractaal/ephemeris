// Timeline view: ruler, film lane (the film's shots, and which frames the viewer has), cue lane and audio tracks, drawn on canvases and edited
// by direct manipulation. A drag recomputes the document from where it stood when the drag began, so a whole drag is
// one undo step and one line in the commit message.
import { regions, clipEnd, speedOf, isVisual, isPictures, thingChanges } from './model.js';
import { parts as gridParts, partAt, lines as gridLines, nearest as gridNearest } from '../engine/grid.js';
import * as audio from './audio.js';
import { find, onEvery, docs } from './layout.js';
import { zoomPer } from './snap.js';
import { trackColour } from './colours.js';
import { createLanesGPU } from './lanesgpu.js';

const LANE = { cues: 38, track: 54 }, RULER = 28, STRIP = 12, EDGE_PX = 6, SNAP_PX = 8, MIN_CLIP = 0.02;
// the same greys as nle.css; the accent (oklch(80% 0.1 250) in sRGB) marks only the playhead, selection, activity
const ACCENT = '140,195,252', accent = (a = 1) => `rgba(${ACCENT},${a})`;
const C = {
  bg: '#0f0f0f', lane: '#121212', track: '#151515', sep: '#080808', bar: 'rgba(255,255,255,0.07)', beat: 'rgba(255,255,255,0.025)',
  text: '#d4d4d4', dim: '#8e8e8e', faint: '#5a5a5a', ruler: '#1c1c1c', tick: '#4a4a4a', tickMinor: '#2c2c2c', sub: 'rgba(255,255,255,0.012)',
  range: 'rgba(255,255,255,0.05)', rangeRuler: 'rgba(255,255,255,0.13)', rangeEdge: '#b0b0b0',
  cue: '#f3dc4c', cueDim: 'rgba(243,220,76,0.12)', cueLine: 'rgba(243,220,76,0.16)',
   clipEdge: '#0d0d0d', clipInk: '#0d0d0d', thumb: '#282828', thumbHot: '#323232',
  shotA: '#2a2745', shotB: '#24213b', shotText: '#c4beff', cut: '#a59bff', rendered: '#a59bff', stale: 'rgba(165,155,255,0.3)',
};
const HINT = {
  move: '<b>Clip</b> drag to move, also onto another track · Shift-drag copies · edges trim · dots on top fade · S splits at the playhead',
  'trim-in': '<b>Trim start</b> drag · hold Alt to ignore snapping', 'trim-out': '<b>Trim end</b> drag · hold Alt to ignore snapping',
  'fade-in': '<b>Fade in</b> drag right to lengthen', 'fade-out': '<b>Fade out</b> drag left to lengthen',
  cue: '<b>Cue</b> drag to move · double-click to rename · drag its tab to make a range · notes in the inspector',
  end: '<b>Cue length</b> drag to make or resize a range',
  cues: '<b>Cues</b> click to seek · drag to draw a range · double-click for a new cue · M at the playhead',
  track: '<b>Track</b> click to seek · Ctrl-drag selects (Ctrl+Shift adds) · drop audio files here · Ctrl+B duplicates the selection',
  obj: '<b>Object</b> its bars: where it is in the scene · click one to select it there · its lanes open under it', objs: '<b>Objects</b> what the project\'s code places · click to seek', film: '<b>Visual</b> its shots · the line under them: rendered frames (bright: just changed) · R renders a draft',
  ruler: '<b>Ruler</b> drag to scrub · ⇧-drag to set in/out · Ctrl+wheel zooms · middle-drag pans',
};
const f2 = (t) => t.toFixed(2);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** The film as a strip, where the timeline's ruler and the viewer's scrubber show it (y, h: its band; xOf, tOf: time and
 *  its x; W: the width): its shots (numbered where there is room), its cuts, and under them the frames the viewer has,
 *  in runs of the same state (1 stale, 2 current, 3 current and changed by the latest change). */
export function filmStrip(g, F, { xOf, tOf, W, y, h, numbers = true }) {
  const dur = F.duration;
  g.font = '9.5px Inter, system-ui, sans-serif'; g.textBaseline = 'middle';
  if (!F.url || dur == null) { if (numbers) { g.fillStyle = C.faint; g.fillText(!F.url ? 'no project URL — audio and cues only' : F.error ? 'the project is not rendering — see the viewer' : 'loading the project…', 8, y + h / 2); } return; }
  const bounds = [0, ...F.cuts.filter((c) => c > 0 && c < dur), dur], bar = Math.max(2, h - 4);
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = xOf(bounds[i]), b = xOf(bounds[i + 1]);
    if (b < 0 || a > W) continue;
    g.fillStyle = i % 2 ? C.shotB : C.shotA;
    g.fillRect(a, y + 1, Math.max(1, b - a - 1), bar);
    if (numbers && b - a > 20) { g.fillStyle = C.shotText; g.fillText(String(i + 1), Math.max(a, 0) + 4, y + 1 + bar / 2); }
  }
  for (const c of F.cuts) { const x = Math.round(xOf(c)) + 0.5; g.fillStyle = C.cut; g.fillRect(x - 0.5, y + 1, 1, bar); }
  const fr = F.frames ?? '', fps = F.fps, i0 = Math.max(0, Math.floor(tOf(0) * fps)), i1 = Math.min(fr.length, Math.ceil(tOf(W) * fps) + 1);
  for (let i = i0; i < i1;) {
    const st = fr.charCodeAt(i); let j = i + 1;
    while (j < i1 && fr.charCodeAt(j) === st) j++;
    if (st > 48) {
      const a = xOf(i / fps), b = xOf(j / fps);
      g.fillStyle = st === 49 ? C.stale : st === 50 ? C.rendered : accent();
      g.fillRect(a, y + h - 2, Math.max(st === 51 ? 1 : 0, b - a), 2);
    }
    i = j;
  }
}

export function createTimeline(api) {
  const { S } = api;
  const $ = find;   // (its panel may be in a window of its own)
  const rulerEl = $('#ruler'), canvas = $('#canvas'), lanesEl = $('#lanes'), heads = $('#heads'), thumb = $('#thumb'), hscroll = $('#hscroll');
  canvas.tabIndex = 0;
  // The lanes are three canvases the size of what shows of them (#tlview, held at the top of the lanes as they scroll):
  // under, the lanes as the GPU draws them (canvas: lanesgpu.js, drawGPU); over that, their ink (text, the motion lanes'
  // curves: drawInk); over that, what moves over them (the playhead, the pointer's line, the snap line, a box being drawn,
  // each motion lane's value at the playhead: overLanes, drawOver), drawn again as it moves (overDirty), the rest when the
  // lanes change (dirty) or move (scrolled). The ruler is a canvas with the same over it.
  const over = (under) => { const c = under.ownerDocument.createElement('canvas'); c.className = 'tl-over'; c.setAttribute('aria-hidden', 'true'); under.after(c); return c; };
  const ink = over(canvas), overLanes = over(ink), overRuler = over(rulerEl), col = $('#tlcol'), view = $('#tlview');
  let overDirty = true, shown = { L: [], bottom: 0, rs: [] };   // (shown: the lanes as last drawn, for what goes over them)
  let scrolled = false, scrollY = 0, viewH = 100;   // (scrollY: how far down the lanes the view is, px; viewH: how tall it is)
  let W = 300, H = 100, dpr = 1, dirty = true, hover = null, hoverT = null, drag = null, headKey = '', dropLane = null, fitShown = false;
  const lanesGPU = createLanesGPU(canvas, () => { dirty = true; });

  const xOf = (t) => (t - S.view.x0) * S.view.pps;
  const tOf = (x) => S.view.x0 + x / S.view.pps;
  const visible = () => W / S.view.pps;
  const extent = () => Math.max(S.end(), 10) + visible() * 0.25;
  const clampX0 = (x0) => Math.round(clamp(x0, -12 / S.view.pps, Math.max(0, extent() - visible())) * S.view.pps) / S.view.pps;
  const setX0 = (x0) => { S.view.x0 = clampX0(x0); scrolled = true; };
  const durations = () => Object.fromEntries(Object.keys(S.doc.media).map((id) => [id, audio.get(id)?.buffer?.duration ?? Infinity]));
  // how long a clip's source is: a sound's, a video's; a still image any length
  const sourceLength = (id) => { const m = S.doc.media[id]; return m?.kind === 'image' ? Infinity : m?.kind === 'video' ? m.duration ?? Infinity : audio.get(id)?.buffer?.duration ?? Infinity; };
  // the tracks as the lanes show them: what is seen (the last over the rest, so on top) above what is heard
  const music = () => S.page === 'music';
  // a medium as heard (api.heard: a pattern with the notes its sound code writes in)
  const heardMedium = (id) => api.heard?.(id) ?? S.doc.media[id];   // (the Music page: the cues and the tracks heard, no film, motion or pictures)
  const tracksShown = () => [...(music() ? [] : S.doc.tracks.filter(isPictures).reverse()), ...S.doc.tracks.filter((t) => !isVisual(t))];

  // the lanes top to bottom: the film, the cues, the motion lanes (the camera's and the selection's: lanes.js), the tracks,
  // each with its instruments' motion under it where it shows (the selected notes clip's, and a track's whose motion is
  // shown: on the Music page too)
  const motion = (l) => l.kind[0] === 'm';
  const instrumental = (r) => !!r.th?.instrument;
  // (the motion rows: those over the tracks, and the instruments', by the track they go under)
  function motionRows() {
    const rows = api.lanes?.rows() ?? [], under = new Map();
    for (const r of rows) if (instrumental(r)) { const k = r.th.instrument.track; if (!under.has(k)) under.set(k, []); under.get(k).push(r); }
    const top = music() ? [] : rows.filter((r) => !instrumental(r));
    return { top: api.objectRows && !music() ? api.objectRows.rows(top) : top, under };
  }
  function lanes() {
    const { top, under } = motionRows();
    const out = [{ kind: 'cues', h: LANE.cues }, ...top];
    for (const track of tracksShown()) out.push({ kind: 'track', track, h: LANE.track }, ...(under.get(track.id) ?? []));
    let y = 0;
    for (const l of out) { l.y = y; y += l.h; }
    return out;
  }

  // ---------- sizing
  function resize() {
    // a host that shows the timeline at another scale (a film's copy of the editor, under its layer's zoom) says so
    dpr = api.pixelRatio || devicePixelRatio || 1;
    W = Math.max(100, lanesEl.clientWidth - heads.offsetWidth);
    if (fitShown && lanesEl.clientWidth) { fitShown = false; fit(); }
    viewH = Math.max(1, lanesEl.clientHeight); H = Math.max(lanes().reduce((a, l) => a + l.h, 0), viewH);
    const rh = music() ? RULER : RULER + 1 + STRIP;   // (the ruler, and under it the film's strip)
    overRuler.style.left = `${rulerEl.offsetLeft}px`;
    if (col.style.height !== `${H}px`) col.style.height = `${H}px`;   // (as tall as the lanes: what they scroll through)
    if (view.style.height !== `${viewH}px`) view.style.height = `${viewH}px`;
    for (const [el, w, h] of [[canvas, W, viewH], [rulerEl, W, rh], [ink, W, viewH], [overLanes, W, viewH], [overRuler, W, rh]]) {
      // (a canvas given a size anew is reallocated and cleared: only when it changes)
      if (el.width === Math.round(w * dpr) && el.height === Math.round(h * dpr) && el.style.width === `${w}px` && el.style.height === `${h}px`) continue;
      el.style.width = `${w}px`; el.style.height = `${h}px`;
      el.width = Math.round(w * dpr); el.height = Math.round(h * dpr);
    }
    dirty = true;
  }
  new ResizeObserver(resize).observe(lanesEl);
  // (the scrollbar's width, kept as it changes: read while drawing, after the page was written to, it would lay the page
  // out again each frame)
  let scrollW = 0, scrollH = 0, thumbWas = '', thumbHot = false, tdrag = null;
  new ResizeObserver(() => { scrollW = hscroll.clientWidth; scrollH = hscroll.clientHeight; thumbWas = ''; dirty = true; }).observe(hscroll);

  // ---------- track headers (DOM, scroll with the lanes)
  let mheads = null, iheads = new Map(), mhtml = '';   // (the motion lanes' heads: over the tracks; under each track, by its id)
  const acts = new Map();   // each audio track's activity light (its head's), and how lit it is: track id → { el, lit }
  let actAt = null;          // (the time the lights were last set for, while playing)
  function syncHeads() {
    const key = JSON.stringify([music(), [...motionRows().under.keys()], ...tracksShown().map((t) => [t.id, t.name, t.kind, !!t.mute, !!t.solo, !!api.lanes?.trackShown(t.id)])]);
    if (key === headKey) return;
    headKey = key; mhtml = '';
    heads.innerHTML = ''; acts.clear();
    const row = (cls, h, html, title) => { const d = document.createElement('div'); d.className = `head ${cls}`; d.style.height = `${h}px`; d.innerHTML = html; if (title) d.title = title; heads.append(d); return d; };
    // (the film's shots and rendered frames: a strip under the ruler, which stays as the lanes scroll; not on the Music page)
    $('#rulerRow').classList.toggle('film-strip', !music());
    row('cues', LANE.cues, '<span class="dot cue"></span><span>Cues</span><kbd>M</kbd>', 'M drops a cue at the playhead, also while playing');
    mheads = document.createElement('div'); mheads.className = 'mheads'; heads.append(mheads);
    iheads = new Map();
    const under = motionRows().under;
    const nV = S.doc.tracks.filter(isPictures).length;
    let a = 0, v = 0;
    tracksShown().forEach((tr) => {
      const tid = isVisual(tr) ? `V${nV - v++}` : `A${++a}`;
      // (a track heard: its mute and solo, as on its mixer strip; dimmed while another is soloed)
      // (and its motion shown, where it plays notes: its instruments' lanes stay open under it)
      const notes = !isVisual(tr) && tr.clips.some((c) => Array.isArray(S.doc.media[c.media]?.notes)), shown = !!api.lanes?.trackShown(tr.id);
      const flags = isVisual(tr) ? '' : `${notes ? `<button class="tflag motion${shown ? ' on' : ''}" data-motion title="${shown ? 'Hide its motion' : 'Show motion: its instruments’ lanes stay open under the track'}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12.5C6.5 12.5 7.5 4 12 4"/><path d="M12 1.6l2.4 2.4-2.4 2.4-2.4-2.4z" fill="currentColor" stroke="none"/></svg></button>` : ''}<button class="tflag mute${tr.mute ? ' on' : ''}" data-flag="mute" title="Mute">M</button><button class="tflag solo${tr.solo ? ' on' : ''}" data-flag="solo" title="Solo">S</button>`;
      const quiet = !isVisual(tr) && !tr.solo && S.doc.tracks.some((t) => t.solo && !isVisual(t));
      const d = row(`track${isVisual(tr) ? ' visual' : ''}${tr.mute || quiet ? ' quiet' : ''}`, LANE.track, `<span class="tid">${tid}</span><span class="name" title="Double-click to rename"></span>${flags}<button class="x" title="Remove track (undo with Ctrl+Z)">×</button>`);
      d.title = 'Right-click for track actions'; d.dataset.track = tr.id; d.style.setProperty('--tc', trackColour(S.doc.tracks.indexOf(tr)).top);
      for (const b of d.querySelectorAll('[data-flag]')) b.onclick = () => api.trackFlag?.(tr.id, b.dataset.flag);
      const mb = d.querySelector('[data-motion]');
      if (mb) mb.onclick = () => api.lanes.toggleTrack(tr.id);
      if (!isVisual(tr)) { const el = document.createElement('i'); el.className = 'tact'; d.append(el); acts.set(tr.id, { el, lit: 0 }); }
      d.querySelector('.name').textContent = tr.name;
      d.querySelector('.name').ondblclick = (e) => api.renameTrack(tr.id, e.target);
      d.querySelector('.x').onclick = () => api.removeTrack(tr.id);
      d.oncontextmenu = (e) => {
        const items = api.trackMenu?.(tr, d);
        if (!items?.length) return;
        e.preventDefault(); e.stopPropagation(); api.openMenu(d, items, { x: e.clientX, y: e.clientY });
      };
      if (under.has(tr.id)) { const box = document.createElement('div'); box.className = 'mheads'; heads.append(box); iheads.set(tr.id, box); }
    });
    resize();
  }
  // the motion lanes' heads: rebuilt when what they show changes (each row as tall as its lane, its gutter above it)
  function syncMotionHeads() {
    if (!api.lanes || !mheads) return;
    const { top, under } = motionRows(), rows = [...top, ...[...under.values()].flat()];
    api.lanes.index(rows);
    const pad = { mthing: 6, mprop: 2, mvec: 2, mlane: 2, mnone: 2, objs: 2, obj: 1 }, objRow = (r) => api.objectRows?.isRow(r);
    const htmlOf = (rs) => rs.map((r) => `<div class="mwrap ${r.kind}" style="height:${r.h}px;padding-top:${pad[r.kind]}px${r.kind === 'mprop' || r.kind === 'mvec' || r.kind === 'obj' ? `;padding-bottom:${r.kind === 'obj' ? 1 : 2}px` : ''}">${objRow(r) ? api.objectRows.head(r) : api.lanes.head(r)}</div>`).join('');
    const html = [htmlOf(top), ...[...iheads.keys()].map((id) => htmlOf(under.get(id) ?? []))];
    if (html.join('\n') !== mhtml) {
      mheads.innerHTML = html[0]; [...iheads.values()].forEach((box, i) => { box.innerHTML = html[i + 1]; }); mhtml = html.join('\n');
      const w = rows.length ? '300px' : '124px';
      if (document.documentElement.style.getPropertyValue('--head-w') !== w) for (const d of docs()) d.documentElement.style.setProperty('--head-w', w);
      resize();
    }
    readMotionHeads();
  }
  // (their values at the playhead)
  function readMotionHeads() { if (!api.lanes || !mheads) return; api.lanes.readouts(mheads); for (const box of iheads.values()) api.lanes.readouts(box); }

  heads.addEventListener('click', (e) => { if (api.objectRows?.onHead(e) || api.lanes?.onHead(e)) dirty = true; });
  heads.addEventListener('dblclick', (e) => { api.objectRows?.onDouble(e); });
  heads.addEventListener('contextmenu', (e) => { api.objectRows?.onMenu(e); });
  let hdrag = null;
  // a track's head dragged up or down (from anywhere on it but its buttons and its name being typed): it moves among the
  // tracks of its kind (what is seen, what is heard), to where the line shows when it is let go
  const kindOf = (tr) => (isVisual(tr) ? 'visual' : 'audio');
  heads.addEventListener('pointerdown', (e) => {
    const d = e.target.closest('.head.track');
    if (!d || e.button !== 0 || e.target.closest('button, input')) return;
    const tr = S.doc.tracks.find((t) => t.id === d.dataset.track);
    if (tr) hdrag = { kind: 'track', tr, d, y0: e.clientY, moved: false, pid: e.pointerId };
  });
  heads.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-mgrip]'), r = e.target.closest('[data-mreorder]');
    if (!g && !r) return;
    e.preventDefault(); e.stopPropagation();
    heads.setPointerCapture(e.pointerId);
    const wrap = (g || r).closest('.mwrap');
    if (g) hdrag = { kind: 'height', key: g.dataset.mgrip, lk: g.dataset.kind, y0: e.clientY, h0: wrap.offsetHeight - (g.dataset.kind === 'mprop' ? 4 : 2) };
    else { const row = lanes().find((l) => l.key === r.dataset.mreorder); hdrag = { kind: 'reorder', row, wrap, y0: e.clientY }; wrap.classList.add('dragging'); }
  });
  // where a track dragged to clientY lands: before the head of its kind it is over the upper half of (or after the last)
  function trackSlot(d, y) {
    const same = [...heads.querySelectorAll('.head.track')].filter((el) => kindOf(S.doc.tracks.find((t) => t.id === el.dataset.track)) === kindOf(d.tr));
    let at = same.length;
    for (let i = 0; i < same.length; i++) { const r = same[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { at = i; break; } }
    return { same, at };
  }
  heads.addEventListener('pointermove', (e) => {
    if (!hdrag) return;
    if (hdrag.kind === 'track') {
      if (!hdrag.moved && Math.abs(e.clientY - hdrag.y0) < 4) return;
      if (!hdrag.moved) { hdrag.moved = true; heads.setPointerCapture(hdrag.pid); hdrag.d.classList.add('dragging'); }
      hdrag.d.style.transform = `translateY(${e.clientY - hdrag.y0}px)`;
      const { same, at } = trackSlot(hdrag, e.clientY);
      same.forEach((el, i) => { el.classList.toggle('drop-above', i === at); el.classList.toggle('drop-below', at === same.length && i === same.length - 1); });
      return;
    }
    if (hdrag.kind === 'height') { api.lanes.setHeight(hdrag.key, hdrag.lk, hdrag.h0 + e.clientY - hdrag.y0); return; }
    hdrag.wrap.style.transform = `translateY(${e.clientY - hdrag.y0}px)`;
    for (const el of heads.querySelectorAll('.mwrap.drop')) el.classList.remove('drop');
    const over = overLane(e, hdrag.row);
    if (over) over.el.classList.add('drop');
  });
  heads.addEventListener('pointerup', (e) => {
    const d = hdrag; hdrag = null;
    if (!d) return;
    if (d.kind === 'track') {
      if (!d.moved) return;
      const { same, at } = trackSlot(d, e.clientY);
      d.d.style.transform = ''; d.d.classList.remove('dragging');
      for (const el of same) el.classList.remove('drop-above', 'drop-below');
      // (the kind's tracks in their new order as shown, then as the timeline keeps them: what is seen, the last on top)
      const shown = same.map((el) => el.dataset.track), from = shown.indexOf(d.tr.id), to = at > from ? at - 1 : at;
      if (to === from) return;
      shown.splice(from, 1); shown.splice(to, 0, d.tr.id);
      api.reorderTracks(isVisual(d.tr) ? shown.reverse() : shown, d.tr.id, to < from ? 'up' : 'down');
      return;
    }
    if (d.kind === 'reorder') {
      d.wrap.style.transform = ''; d.wrap.classList.remove('dragging');
      const over = overLane(e, d.row);
      if (over) api.lanes.reorder(d.row.P, d.row.lane.id, Math.max(1, over.row.i));
    }
    dirty = true;
  });
  heads.addEventListener('dblclick', (e) => {
    const g = e.target.closest('[data-mgrip]');
    if (!g) return;
    const k = g.dataset.kind, now = g.closest('.mwrap').offsetHeight;
    api.lanes.setHeight(g.dataset.mgrip, k, now < api.lanes.DEF_H[k] * 2.5 ? api.lanes.DEF_H[k] * 4 : null);
  });
  // the lane of the same property the pointer is over (a reorder's drop)
  function overLane(e, from) {
    for (const el of heads.querySelectorAll('.mwrap.mlane')) {
      const r = el.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY >= r.bottom) continue;
      const key = el.querySelector('[data-mrow]')?.dataset.mrow, row = lanes().find((l) => l.key === key);
      return row && row.P === from.P && row !== from ? { el, row } : null;
    }
    return null;
  }

  // ---------- grid: the timeline's (engine/grid.js): one tempo, or the music's, a part for each tempo of each song from its clip on
  const G = () => S.doc.grid || {};
  const inView = () => partAt(gridParts(G()), tOf(W / 2));   // (the part in view sets how fine the lines are)
  // the grid things land on (Snap: nle/snap.js): by zoom, or the fixed length chosen; null with snapping off (N) or Alt
  const snapPer = (e) => (!S.snap || e?.altKey ? null : S.snapGrid && S.snapGrid !== 'zoom' ? S.snapGrid : zoomPer(inView(), S.view.pps));

  // ---------- snapping: onto the grid, or onto a mark nearer than its line — the playhead, cues, clip edges, film cuts, the
  // in/out range, keys — within a few pixels
  function snapTargets(exclude) {
    const ts = [0, S.t];
    for (const q of S.doc.cues) if (!exclude.has(q.id)) { ts.push(q.t); if (q.dur) ts.push(q.t + q.dur); }
    for (const tr of S.doc.tracks) for (const c of tr.clips) if (!exclude.has(c.id)) ts.push(c.at, clipEnd(c));
    if (S.film.duration != null) ts.push(...S.film.cuts, S.film.duration);
    if (S.range) ts.push(S.range.a, S.range.b);
    if (api.lanes) ts.push(...api.lanes.keyTimes());
    return ts;
  }
  // t snapped: { t, hit: the mark it caught (drawn as a line), or null (the grid's line, or nothing) }
  function snap(t, targets, e) {
    const per = snapPer(e);
    if (per == null) return { t, hit: null };
    let best = gridNearest(G(), t, per), bd = Math.abs(best - t), hit = null;
    for (const x of targets) { const d = Math.abs(x - t); if (d < bd && d <= SNAP_PX / S.view.pps) { bd = d; best = x; hit = x; } }
    return { t: best, hit };
  }
  // a clip or range cue moved by dt, snapped: its start on the grid, as the piano roll's notes land — or its start or its
  // end on a mark nearer than that
  function snapPair(a, b, dt, targets, e) {
    const per = snapPer(e);
    S.snapLine = null;
    if (per == null) return dt;
    let best = gridNearest(G(), a + dt, per) - (a + dt);
    for (const edge of b == null ? [a] : [a, b]) for (const x of targets) {
      const d = x - (edge + dt);
      if (Math.abs(d) < Math.abs(best) && Math.abs(d) <= SNAP_PX / S.view.pps) { best = d; S.snapLine = x; }
    }
    return dt + best;
  }

  // ---------- hit testing
  function hit(x, y) {
    const L = lanes(), lane = L.find((l) => y >= l.y && y < l.y + l.h);
    if (!lane) return { kind: 'none' };
    if (motion(lane)) return { kind: 'motion', ...api.lanes.hit(lane, x, y, lane.y, xOf, tOf), lane };
    // (an added thing's bar is its clip: moved in time, or trimmed by its ends)
    if (lane.kind === 'obj' && lane.obj.clip) {
      const c = lane.obj.clip, x0 = xOf(c.at), x1 = xOf(clipEnd(c)), wide = x1 - x0 > 14;
      if (wide && Math.abs(x - x0) <= EDGE_PX) return { kind: 'clip', clip: c, zone: 'trim-in', lane };
      if (wide && Math.abs(x - x1) <= EDGE_PX) return { kind: 'clip', clip: c, zone: 'trim-out', lane };
      return x >= x0 && x <= x1 ? { kind: 'clip', clip: c, zone: 'move', lane } : { kind: 'lane', lane, obj: null };
    }
    if (lane.kind === 'obj' || lane.kind === 'objs') return { kind: 'lane', lane, obj: lane.kind === 'obj' && api.objectRows.on(lane, tOf(x)) ? lane.obj : null };
    if (lane.kind === 'cues') {
      let best = null, bd = Infinity;
      for (const q of S.doc.cues) {
        const qx = xOf(q.t), qe = xOf(q.t + q.dur);
        if (q.dur > 0) {
          if (Math.abs(x - qe) <= 5 && qe - qx > 8) return { kind: 'cue', cue: q, zone: 'end', lane };
          if (x >= qx - 4 && x <= qe) { const d = Math.abs(x - qx); if (d < bd) { bd = d; best = { kind: 'cue', cue: q, zone: 'move', lane }; } }
        } else {
          if (x >= qx + 5 && x <= qx + 12 && y < lane.y + 16 && (S.sel.has(q.id) || hover?.cue === q)) return { kind: 'cue', cue: q, zone: 'end', lane };
          const d = Math.abs(x - qx); if (d <= 6 && d < bd) { bd = d; best = { kind: 'cue', cue: q, zone: 'move', lane }; }
        }
      }
      return best || { kind: 'lane', lane };
    }
    if (lane.kind === 'track') {
      const clips = [...lane.track.clips].sort((a, b) => a.at - b.at);
      for (let i = clips.length - 1; i >= 0; i--) {
        const c = clips[i], x0 = xOf(c.at), x1 = xOf(clipEnd(c)), w = x1 - x0;
        if (x < x0 - 3 || x > x1 + 3) continue;
        const top = y < lane.y + 16 && !isVisual(lane.track);   // (a picture has no fades)
        if (top && Math.abs(x - xOf(c.at + (c.fadeIn || 0))) <= 6 && w > 24) return { kind: 'clip', clip: c, zone: 'fade-in', lane };
        if (top && Math.abs(x - xOf(clipEnd(c) - (c.fadeOut || 0))) <= 6 && w > 24) return { kind: 'clip', clip: c, zone: 'fade-out', lane };
        if (Math.abs(x - x0) <= EDGE_PX && w > 14) return { kind: 'clip', clip: c, zone: 'trim-in', lane };
        if (Math.abs(x - x1) <= EDGE_PX && w > 14) return { kind: 'clip', clip: c, zone: 'trim-out', lane };
        if (x >= x0 && x <= x1) return { kind: 'clip', clip: c, zone: 'move', lane };
      }
    }
    return { kind: 'lane', lane };
  }
  const CURSOR = { 'trim-in': 'ew-resize', 'trim-out': 'ew-resize', 'fade-in': 'col-resize', 'fade-out': 'col-resize', end: 'ew-resize', move: 'grab', key: 'ew-resize', land: 'ew-resize' };
  const hintFor = (h) => (h.kind === 'motion' ? api.lanes.hint(h) : h.kind === 'clip' ? HINT[h.zone] : h.kind === 'cue' ? HINT[h.zone === 'end' ? 'end' : 'cue'] : h.lane ? HINT[h.lane.kind] : '');

  const findClip = (doc, id) => { for (const track of doc.tracks) { const clip = track.clips.find((c) => c.id === id); if (clip) return { clip, track }; } return {}; };
  // the selection's timed things — its clips, its cues, the keys and moves chosen in the motion lanes — retimed together
  // from the doc as a gesture began (docs/selection.md): fn gives each time its new one; k, how many times as long each cue
  // and move gets (a clip keeps its length). Without: the kinds a drag moves itself
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  function retimer({ clips: withClips = true, cues: withCues = true } = {}) {
    const doc = S.doc, groups = api.lanes?.choice() ?? [];
    const clips = withClips ? doc.tracks.flatMap((t) => t.clips.filter((c) => S.sel.has(c.id)).map((c) => ({ id: c.id, at: c.at }))) : [];
    const cues = withCues ? doc.cues.filter((q) => S.sel.has(q.id)).map((q) => ({ id: q.id, t: q.t, dur: q.dur })) : [];
    const times = [...clips.map((c) => c.at), ...cues.map((q) => q.t), ...(api.lanes?.choiceTimes(groups) ?? [])];
    return {
      n: times.length, min: times.length ? Math.min(...times) : 0, times,
      apply(d, fn, k = 1) {
        for (const c of clips) findClip(d, c.id).clip.at = Math.max(0, r6(fn(c.at)));
        for (const q of cues) { const x = d.cues.find((y) => y.id === q.id); x.t = Math.max(0, r6(fn(q.t))); if (k !== 1) x.dur = r6(q.dur * k); }
        if (groups.length) api.lanes.retime(d, groups, fn, k);
      },
      done(fn) { if (groups.length) api.lanes.moved(groups, fn); },
    };
  }
  const name = (c) => `"${c.thing?.label ?? c.media}"`;
  const cueName = (q) => (q.label ? `"${q.label}"` : `at ${f2(q.t)}`);

  // ---------- drags
  // (copy: a clip Shift-dragged is copied, the selection with it where it is in it; the copies are selected after)
  function startDrag(e, x, y, h, copy = false) {
    const base = structuredClone(S.doc), sel = S.sel, pps = () => S.view.pps;
    const d = { x0: x, y0: y, base, moved: false, apply: null, desc: '', id: (h.clip || h.cue)?.id, zone: h.zone };
    if (h.kind === 'clip') {
      const id = h.clip.id, b = findClip(base, id).clip, picked = sel.has(id) ? sel : new Set([id]);
      if (h.zone === 'move') {
        const moving = base.tracks.flatMap((tr, ti) => tr.clips.filter((c) => picked.has(c.id)).map((c) => ({ id: c.id, at: c.at, ti })));
        const prim = moving.find((m) => m.id === id), targets = snapTargets(copy ? new Set() : new Set(moving.map((m) => m.id)));
        const rest = copy ? null : retimer({ clips: false });   // (the rest of the selection: with them, in time)
        let fn = null;
        d.after = () => rest?.done(fn);
        const first = +api.newId('c').slice(1), copies = moving.map((m, i) => `c${first + i}`);
        if (copy) d.after = () => api.selectMany(copies, false);
        d.apply = (doc, dx, dy, ev) => {
          let dt = snapPair(b.at, clipEnd(b), dx / pps(), targets, ev);
          dt = Math.max(dt, -Math.min(...moving.map((m) => m.at)), rest?.n ? -rest.min : -Infinity);
          fn = (t) => t + dt; rest?.apply(doc, fn);
          const over = lanes().find((l) => ev.y >= l.y && ev.y < l.y + l.h);
          let dti = over?.kind === 'track' ? doc.tracks.findIndex((t) => t.id === over.track.id) - prim.ti : 0;
          dti = clamp(dti, -Math.min(...moving.map((m) => m.ti)), doc.tracks.length - 1 - Math.max(...moving.map((m) => m.ti)));
          if (moving.some((m) => isVisual(doc.tracks[m.ti]) !== isVisual(doc.tracks[m.ti + dti]) || doc.tracks[m.ti].things || doc.tracks[m.ti + dti].things)) dti = 0;   // (pictures onto tracks seen, sounds onto tracks heard; an added thing stays on its own)
          moving.forEach((m, i) => {
            const { clip, track } = findClip(doc, m.id);
            const moved = copy ? { ...structuredClone(clip), id: copies[i] } : (track.clips.splice(track.clips.indexOf(clip), 1), clip);
            if (copy && clip.thing) (doc.overrides ??= []).push(...thingChanges(doc, m.id, copies[i]));   // (as it is: where it was moved to, its material)
            moved.at = m.at + dt;
            doc.tracks[m.ti + dti].clips.push(moved);
          });
          const to = dti ? ` to "${doc.tracks[prim.ti + dti].name}"` : '';
          if (copy) return moving.length > 1 ? `copy ${moving.length} clips by ${dt >= 0 ? '+' : ''}${f2(dt)}${to}` : `copy ${name(b)} to ${f2(b.at + dt)}${to}`;
          return moving.length > 1 ? `move ${moving.length} clips by ${dt >= 0 ? '+' : ''}${f2(dt)}${to}` : `move ${name(b)} ${f2(b.at)} → ${f2(b.at + dt)}${to}`;
        };
      } else if (h.zone === 'trim-in' || h.zone === 'trim-out') {
        const targets = snapTargets(new Set([id])), dur = sourceLength(b.media), end0 = clipEnd(b), sp = speedOf(b), still = b.thing || (dur === Infinity && S.doc.media[b.media]?.kind === 'image');
        d.apply = (doc, dx, dy, ev) => {
          const c = findClip(doc, id).clip;
          if (h.zone === 'trim-in') {
            const s = snap(b.at + dx / pps(), targets, ev); S.snapLine = s.hit;
            const at = clamp(s.t, still ? 0 : Math.max(0, b.at - b.in / sp), end0 - MIN_CLIP);   // (a still: as early as you like)
            c.in = b.in + (at - b.at) * sp; c.at = at;
            c.fadeIn = Math.min(c.fadeIn || 0, Math.max(0, end0 - at - (c.fadeOut || 0)));
            return `trim start of ${name(b)} ${f2(b.at)} → ${f2(at)}`;
          }
          const s = snap(end0 + dx / pps(), targets, ev); S.snapLine = s.hit;
          const end = clamp(s.t, b.at + MIN_CLIP, b.at + (dur - b.in) / sp);
          c.out = b.in + (end - b.at) * sp;
          c.fadeOut = Math.min(c.fadeOut || 0, Math.max(0, end - b.at - (c.fadeIn || 0)));
          return `trim end of ${name(b)} ${f2(end0)} → ${f2(end)}`;
        };
      } else {
        const len = clipEnd(b) - b.at, key = h.zone === 'fade-in' ? 'fadeIn' : 'fadeOut', other = h.zone === 'fade-in' ? 'fadeOut' : 'fadeIn';
        d.apply = (doc, dx) => {
          const c = findClip(doc, id).clip, v0 = b[key] || 0;
          c[key] = Math.round(clamp(v0 + (h.zone === 'fade-in' ? dx : -dx) / pps(), 0, len - (b[other] || 0)) * 1000) / 1000;
          return `fade ${h.zone === 'fade-in' ? 'in' : 'out'} ${name(b)} ${f2(v0)} → ${f2(c[key])} s`;
        };
      }
    } else if (h.kind === 'cue') {
      const id = h.cue.id, b = base.cues.find((q) => q.id === id);
      if (h.zone === 'move') {
        const moving = base.cues.filter((q) => sel.has(q.id)), targets = snapTargets(new Set(moving.map((q) => q.id)));
        const rest = retimer({ cues: false });   // (the rest of the selection: with them)
        let fn = null;
        d.after = () => rest.done(fn);
        d.apply = (doc, dx, dy, ev) => {
          let dt = snapPair(b.t, b.dur ? b.t + b.dur : null, dx / pps(), targets, ev);
          dt = Math.max(dt, -Math.min(...moving.map((q) => q.t)), rest.n ? -rest.min : -Infinity);
          for (const m of moving) doc.cues.find((q) => q.id === m.id).t = m.t + dt;
          fn = (t) => t + dt; rest.apply(doc, fn);
          return moving.length > 1 ? `move ${moving.length} cues by ${dt >= 0 ? '+' : ''}${f2(dt)}` : `move cue ${b.label ? `"${b.label}" ` : ''}${f2(b.t)} → ${f2(b.t + dt)}`;
        };
      } else {
        const targets = snapTargets(new Set([id]));
        d.apply = (doc, dx, dy, ev) => {
          const q = doc.cues.find((c) => c.id === id), s = snap(b.t + b.dur + dx / pps(), targets, ev); S.snapLine = s.hit;
          q.dur = Math.max(0, s.t - b.t);
          if (q.dur * pps() < 3) q.dur = 0;
          return `cue ${cueName(b)} length ${f2(b.dur)} → ${f2(q.dur)}`;
        };
      }
    } else if (h.kind === 'lane' && h.lane.kind === 'cues') {
      // drag on the empty cue lane draws a range cue; a click without a drag just seeks there
      const id = api.newId('q'), targets = snapTargets(new Set()), t0 = snap(tOf(x), targets, e).t;
      d.click = () => { api.select(null); api.seek(Math.max(0, tOf(x))); };
      d.apply = (doc, dx, dy, ev) => {
        const s = snap(tOf(x + dx), targets, ev); S.snapLine = s.hit;
        const a = Math.max(0, Math.min(t0, s.t)), b2 = Math.max(t0, s.t);
        doc.cues.push({ id, t: a, dur: b2 - a, label: '', note: '' });
        S.sel = new Set([id]);
        return `add range cue ${f2(a)}–${f2(b2)}`;
      };
    } else return null;
    return d;
  }

  // (where the pointer is on the lanes: px along the view, px down the lanes)
  const at = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top + scrollY]; };
  function onDown(e) {
    if (e.button !== 0) return;
    canvas.focus({ preventScroll: true });
    const [x, y] = at(e), h = hit(x, y), additive = e.shiftKey || e.ctrlKey || e.metaKey;
    // Ctrl, over the motion lanes: a box, as over the clips (Ctrl+Shift: added to the selection)
    if (h.kind === 'motion' && (e.ctrlKey || e.metaKey) && h.what === 'row') { drag = { box: { x0: x, y0: y, x, y, add: e.shiftKey } }; canvas.setPointerCapture(e.pointerId); return; }
    if (h.kind === 'motion') {
      const r = h.row;
      if (h.what === 'row') {
        if (r.kind === 'mthing') api.lanes.select({ th: r.th.id });
        else if (r.kind === 'mprop') api.lanes.select({ th: r.th.id, k: r.P.k });
        else if (r.kind === 'mvec') api.lanes.select({ th: r.th.id, v: r.V.id });
        else if (r.kind === 'mlane') api.lanes.selectAt(r, h.cell);   // (the part under the pointer: its lane there)
        drag = { scrub: true }; api.seek(tOf(x)); canvas.setPointerCapture(e.pointerId);
        return;
      }
      const targets = snapTargets(new Set());
      const md = api.lanes.drag(h, x, {
        snap: (t, ev) => { const s = snap(t, targets, ev); S.snapLine = s.hit; return s.t; },
        snapPair: (a, b, dt, ev) => snapPair(a, b, dt, targets, ev),
        add: additive, retimer, timed: () => [...S.sel].some((id) => findClip(S.doc, id).clip || S.doc.cues.some((q) => q.id === id)),
      });
      if (!md) { dirty = true; return; }
      api.panels();
      drag = { x0: x, y0: y, base: structuredClone(S.doc), moved: false, apply: md.apply, after: md.after, click: md.click, desc: '', zone: h.what };
      canvas.setPointerCapture(e.pointerId); canvas.style.cursor = h.what === 'move' ? 'grabbing' : 'ew-resize';
      return;
    }
    // Ctrl, as the piano roll's: a box that selects what it touches (Ctrl+Shift: added to the selection), from a clip or cue
    // too; a click on one toggles it
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (h.kind === 'clip' || h.kind === 'cue' || (h.kind === 'lane' && h.lane.kind !== 'cues'))) {
      drag = { box: { x0: x, y0: y, x, y, add: e.shiftKey }, toggle: (h.clip || h.cue)?.id ?? null }; canvas.setPointerCapture(e.pointerId); return;
    }
    let copy = false;
    if (h.kind === 'clip' || h.kind === 'cue') {
      const id = (h.clip || h.cue).id;
      // Shift: a clip dragged is copied (the selection with it, where it is in it); a click toggles it
      if (additive && h.zone === 'move' && h.kind === 'clip') copy = true;
      else if (additive && h.zone === 'move') { api.select(id, 'toggle'); if (!S.sel.has(id)) return; }
      else if (!S.sel.has(id)) api.select(id);
    } else if (h.obj) {
      // an object's bar: it selected (whole), the playhead where it was clicked
      api.selectObject(h.obj, Math.max(0, tOf(x)));
      drag = { scrub: true }; canvas.setPointerCapture(e.pointerId);
      return;
    } else if (h.lane.kind === 'obj' || h.lane.kind === 'objs') {
      drag = { scrub: true }; api.seek(Math.max(0, tOf(x))); canvas.setPointerCapture(e.pointerId);
      return;
    } else if (h.kind === 'lane' && h.lane.kind !== 'cues') {
      // empty space: with Shift, a box that selects what it touches, in place of the selection; else deselect and put the
      // playhead there
      if (additive) { drag = { box: { x0: x, y0: y, x, y, add: false } }; canvas.setPointerCapture(e.pointerId); return; }
      api.select(null);
      drag = { scrub: true }; api.seek(tOf(x)); canvas.setPointerCapture(e.pointerId);
      return;
    }
    drag = startDrag(e, x, y, h, copy);
    if (copy && drag) drag.click = () => api.select(h.clip.id, 'toggle');   // (Shift-click, not dragged: toggled, as before)
    else if (drag && h.clip?.thing) drag.click = () => api.seek(Math.max(0, tOf(x)));   // (an added thing's bar clicked, not dragged: the playhead there, as an object's bar)
    if (drag) { canvas.setPointerCapture(e.pointerId); if (CURSOR[h.zone] === 'grab') canvas.style.cursor = 'grabbing'; }
  }
  function onMove(e) {
    const [x, y] = at(e);
    hoverT = tOf(x);
    if (drag?.scrub) { api.seek(Math.max(0, tOf(x))); return; }
    if (drag?.box) { drag.box.x = x; drag.box.y = y; overDirty = true; return; }
    if (drag) {
      const dx = x - drag.x0, dy = y - drag.y0;
      if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      if (!drag.moved) { drag.moved = true; S.dragging = true; }
      S.doc = structuredClone(drag.base);
      drag.desc = drag.apply(S.doc, dx, dy, { altKey: e.altKey, y });
      api.changedLive();
      dirty = true;
      return;
    }
    const h = hit(x, y), prev = hover;
    hover = h.kind === 'clip' || h.kind === 'cue' ? h : null;
    canvas.style.cursor = hover ? CURSOR[h.zone] : h.kind === 'motion' && h.what !== 'row' ? CURSOR[h.what] : 'default';
    api.hint(hintFor(h));
    if (prev?.clip !== hover?.clip || prev?.cue !== hover?.cue || prev?.zone !== hover?.zone) dirty = true;
    overDirty = true;   // the hover line follows the pointer (drawn over the lanes, not with them)
  }
  function onUp() {
    const d = drag; drag = null; S.snapLine = null; S.dragging = false; dirty = true;
    canvas.style.cursor = hover ? CURSOR[hover.zone] : 'default';
    if (d?.box) {
      const b = d.box, x0 = Math.min(b.x0, b.x), x1 = Math.max(b.x0, b.x), y0 = Math.min(b.y0, b.y), y1 = Math.max(b.y0, b.y);
      if (x1 - x0 < 3 && y1 - y0 < 3) { if (d.toggle) api.select(d.toggle, 'toggle'); else api.seek(Math.max(0, tOf(b.x))); return; }   // (a click: the one under it toggled, or the playhead there)
      const ids = [];
      for (const l of lanes()) {
        if (l.y + l.h <= y0 || l.y >= y1) continue;
        if (l.kind === 'track') for (const c of l.track.clips) if (xOf(clipEnd(c)) >= x0 && xOf(c.at) <= x1) ids.push(c.id);
        if (l.kind === 'obj' && l.obj.clip && xOf(clipEnd(l.obj.clip)) >= x0 && xOf(l.obj.clip.at) <= x1) ids.push(l.obj.clip.id);
        if (l.kind === 'cues') for (const q of S.doc.cues) if (xOf(q.t + q.dur) >= x0 - 4 && xOf(q.t) <= x1 + 4) ids.push(q.id);
      }
      api.selectMany(ids, b.add, (add) => api.lanes?.pickBox(lanes().filter((l) => motion(l) && l.y + l.h > y0 && l.y < y1), x0, x1, xOf));
      return;
    }
    if (d && !d.scrub && d.moved) { api.dragged(d.base, d.desc); d.after?.(); }
    else if (d?.click) d.click();
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', () => { if (!drag) { hover = null; hoverT = null; api.hint(''); dirty = true; } });
  canvas.addEventListener('contextmenu', (e) => {
    const [x, y] = at(e), h = hit(x, y);
    let items = null;
    if (h.kind === 'clip' || h.kind === 'cue') {
      const id = (h.clip || h.cue).id;
      if (!S.sel.has(id)) api.select(id);
      items = api.itemMenu?.(h);
    } else if (h.kind === 'lane' && h.lane.kind === 'track') items = api.trackMenu?.(h.lane.track);
    if (!items?.length) return;
    e.preventDefault(); e.stopPropagation(); api.openMenu(canvas, items, { x: e.clientX, y: e.clientY });
  });
  canvas.addEventListener('dblclick', (e) => {
    const [x, y] = at(e), h = hit(x, y);
    if (h.kind === 'motion' && h.what === 'row' && (h.row.kind === 'mvec' || (h.row.kind === 'mlane' && h.row.lane.kind === 'keys'))) api.lanes.addKeyAt(h.row, snap(tOf(x), snapTargets(new Set()), e).t);
    else if (h.kind === 'cue') inlineLabel(h.cue.id);
    else if (h.kind === 'clip' && api.openNotes?.(h.clip)) { /* (a pattern: opened in the piano roll) */ }
    else if (h.kind === 'lane' && h.lane.kind === 'cues') inlineLabel(api.addCue(snap(tOf(x), snapTargets(new Set()), e).t));
  });
  // Esc mid-drag puts everything back
  onEvery('keydown', (e) => { if (e.key === 'Escape' && drag && !drag.scrub) { S.doc = drag.base; drag = null; S.dragging = false; S.snapLine = null; api.changedLive(); dirty = true; } }, true);

  // rename a cue where it sits on the lane (no dialog); Enter or clicking away keeps it, Esc cancels
  function inlineLabel(id) {
    const q = S.doc.cues.find((c) => c.id === id);
    if (!q) return;
    const input = document.createElement('input');
    input.className = 'inline-edit'; input.value = q.label; input.placeholder = 'label'; input.spellcheck = false;
    input.style.left = `${heads.offsetWidth + clamp(xOf(q.t) + 9, 0, W - 176)}px`;
    input.style.top = `${lanes().find((l) => l.kind === 'cues').y + 10}px`;
    lanesEl.append(input); input.focus(); input.select();
    let done = false;
    const finish = (keep) => { if (done) return; done = true; const v = input.value.trim(); input.remove(); if (keep && v !== q.label) api.setCueLabel(id, v); };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    input.onblur = () => finish(true);
  }

  // ---------- ruler: click/drag scrubs; shift-drag marks the in/out range; its edges drag
  let rdrag = null;
  const nearRange = (x) => S.range && (Math.abs(x - xOf(S.range.a)) <= 5 ? 'a' : Math.abs(x - xOf(S.range.b)) <= 5 ? 'b' : null);
  rulerEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const x = e.offsetX, t = Math.max(0, tOf(x)), edge = nearRange(x);
    rulerEl.setPointerCapture(e.pointerId);
    if (edge) rdrag = { edge };
    else if (e.shiftKey) { rdrag = { from: t }; api.setRange(t, t); }
    else { rdrag = { scrub: true }; api.seek(t); }
  });
  rulerEl.addEventListener('pointermove', (e) => {
    const x = e.offsetX, t = Math.max(0, tOf(x));
    hoverT = tOf(x); overDirty = true;
    if (!rdrag) { rulerEl.style.cursor = nearRange(x) ? 'ew-resize' : 'text'; api.hint(nearRange(x) ? '<b>In/out</b> drag to adjust · Alt+X clears' : !music() && e.offsetY > RULER ? HINT.film : HINT.ruler); return; }
    const s = snap(t, snapTargets(new Set()), e).t;
    if (rdrag.scrub) api.seek(t);
    else if (rdrag.edge) { const r = { ...S.range, [rdrag.edge]: s }; api.setRange(Math.min(r.a, r.b), Math.max(r.a, r.b)); if (r.a > r.b) rdrag.edge = rdrag.edge === 'a' ? 'b' : 'a'; }
    else api.setRange(Math.min(rdrag.from, s), Math.max(rdrag.from, s));
  });
  rulerEl.addEventListener('pointerup', () => { if (rdrag && !rdrag.scrub && S.range && S.range.b - S.range.a < 1 / 60) api.setRange(null); rdrag = null; });
  rulerEl.addEventListener('pointerleave', () => { if (!rdrag) { hoverT = null; api.hint(''); overDirty = true; } });

  // ---------- wheel: scroll, along and up and down; ctrl/cmd zooms around the pointer. A wheel's step glides there over
  // about a tenth of a second, as the browser's own scrolling does (a touchpad's small steps go at once: glide). Up and
  // down are the timeline's too: the lanes are drawn where they are scrolled to in the frame their heads move, where the
  // browser's own scrolling moves the heads a frame before the lanes are drawn for it.
  const glide = { x: null, y: null, at: 0 };   // (where a wheel's steps are going: the view's start, s; the lanes' scroll, px)
  // (the director moved the view along themselves: the playhead is not followed until it is in view again, follow)
  let catching = true;
  const scrollTo = (y) => { y = Math.round(clamp(y, 0, Math.max(0, H - viewH))); if (y === scrollY) return; scrollY = y; scrolled = true; lanesEl.scrollTop = y; };
  function onWheel(e) {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { glide.x = null; zoomAt(tOf(x), Math.exp(-e.deltaY * 0.0018)); return; }
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewH : 1, dx = e.deltaX * k, dy = e.deltaY * k, d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    const step = e.deltaMode !== 0 || Math.abs(d) >= 40;   // (a wheel's notch, not a touchpad's slide)
    if (e.shiftKey || Math.abs(dx) > Math.abs(dy) || H <= viewH || e.currentTarget === rulerEl) {
      catching = false;
      const to = clampX0((glide.x ?? S.view.x0) + d / S.view.pps);
      if (step) glide.x = to; else { glide.x = null; setX0(to); }
    } else {
      const to = clamp((glide.y ?? scrollY) + d, 0, Math.max(0, H - viewH));
      if (step) glide.y = to; else { glide.y = null; scrollTo(to); }
    }
  }
  // (each frame: a step's way there, by a share of what is left, at least a px)
  function glideOn() {
    const now = performance.now(), dt = Math.min(64, now - glide.at), k = 1 - Math.exp(-dt / 40);
    glide.at = now;
    if (glide.x != null) {
      const left = (glide.x - S.view.x0) * S.view.pps, was = S.view.x0;
      if (Math.abs(left) <= 1) { setX0(glide.x); glide.x = null; }
      else { setX0(S.view.x0 + (Math.sign(left) * Math.max(1, Math.abs(left) * k)) / S.view.pps); if (S.view.x0 === was) glide.x = null; }
    }
    if (glide.y != null) {
      const left = glide.y - scrollY;
      if (Math.abs(left) <= 1) { scrollTo(glide.y); glide.y = null; }
      else scrollTo(scrollY + Math.sign(left) * Math.max(1, Math.abs(left) * k));
    }
  }
  lanesEl.addEventListener('wheel', onWheel, { passive: false });
  rulerEl.addEventListener('wheel', onWheel, { passive: false });
  // (scrolled however: the lanes drawn again where they now are, in the frame the heads move)
  lanesEl.addEventListener('scroll', () => { if (lanesEl.scrollTop !== scrollY) { scrollY = lanesEl.scrollTop; scrolled = true; } });

  // ---------- middle-drag pans: along in time, and (on the lanes) up and down them
  let pan = null;
  function onPanDown(e) {
    if (e.button !== 1) return;
    e.preventDefault(); e.stopPropagation();   // (not the browser's autoscroll, nor a drag of the lanes)
    glide.x = glide.y = null;
    pan = { el: e.currentTarget, x: e.clientX, y: e.clientY, x0: S.view.x0, top: scrollY };
    pan.el.setPointerCapture(e.pointerId);
    pan.el.style.cursor = canvas.style.cursor = 'grabbing';
  }
  function onPanMove(e) {
    if (!pan) return;
    e.stopPropagation();
    if (e.clientX !== pan.x) catching = false;
    setX0(pan.x0 - (e.clientX - pan.x) / S.view.pps);
    if (pan.el === lanesEl) scrollTo(pan.top - (e.clientY - pan.y));
  }
  function onPanUp(e) {
    if (!pan || e.button !== 1) return;
    pan.el.style.cursor = ''; canvas.style.cursor = 'default'; pan = null;
  }
  for (const el of [lanesEl, rulerEl]) {
    el.addEventListener('pointerdown', onPanDown, true);
    el.addEventListener('pointermove', onPanMove, true);
    el.addEventListener('pointerup', onPanUp, true);
    el.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  }

  function zoomAt(t, k) {
    const minPps = W / (Math.max(S.end(), 5) * 1.6), x = xOf(t);
    S.view.pps = clamp(S.view.pps * k, minPps, 4000);
    setX0(t - x / S.view.pps);
  }
  // (a timeline not shown yet, its panel behind another tab, is fitted once it is: its width is not known before)
  function fit() {
    if (!lanesEl.clientWidth) { fitShown = true; return; }
    S.view.pps = W / (Math.max(S.end(), 5) * 1.03); S.view.x0 = -8 / S.view.pps; dirty = true;
  }

  // horizontal scrollbar: its handle dragged, or the bar clicked (the view centred there, and dragged on from there).
  // The handle is drawn on a canvas filling the bar (drawThumb): an element moved along it each frame of a scroll made the
  // page's layers be worked out again, about 4 ms of each of those frames on spring-brutalist's timeline.
  const thumbAt = () => { const e = extent(), w = Math.max(24, (visible() / e) * scrollW); return [clamp((S.view.x0 / e) * scrollW, 0, scrollW - w), w]; };
  const onThumb = (x) => { const [a, w] = thumbAt(); return x >= a && x <= a + w; };
  function drawThumb() {
    const [x, w] = thumbAt(), hot = thumbHot || !!tdrag, key = `${Math.round(x * dpr)}|${Math.round(w * dpr)}|${hot}|${scrollW}|${scrollH}|${dpr}`;
    if (key === thumbWas) return;
    thumbWas = key;
    const pw = Math.round(scrollW * dpr), ph = Math.round(scrollH * dpr);
    if (thumb.width !== pw || thumb.height !== ph) { thumb.width = pw; thumb.height = ph; }
    const g = thumb.getContext('2d');
    g.clearRect(0, 0, pw, ph);
    g.fillStyle = hot ? C.thumbHot : C.thumb; g.fillRect(Math.round(x * dpr), Math.round(dpr), Math.round(w * dpr), Math.round(6 * dpr));
  }
  hscroll.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    glide.x = null; catching = false;
    if (!onThumb(e.offsetX)) setX0((e.offsetX / scrollW) * extent() - visible() / 2);
    tdrag = { x: e.clientX, x0: S.view.x0 }; hscroll.setPointerCapture(e.pointerId); drawThumb();
  });
  hscroll.addEventListener('pointermove', (e) => {
    if (tdrag) { setX0(tdrag.x0 + ((e.clientX - tdrag.x) / scrollW) * extent()); return; }
    const hot = onThumb(e.offsetX); if (hot !== thumbHot) { thumbHot = hot; drawThumb(); }
  });
  const thumbUp = () => { tdrag = null; drawThumb(); };
  hscroll.addEventListener('pointerup', thumbUp); hscroll.addEventListener('pointercancel', thumbUp);
  hscroll.addEventListener('pointerleave', () => { if (thumbHot) { thumbHot = false; drawThumb(); } });

  // ---------- drawing
  function drawRuler() {
    const g = rulerEl.getContext('2d'), full = rulerEl.height / dpr, strip = !music(), h = strip ? RULER : full, mid = 14;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.ruler; g.fillRect(0, 0, W, full);
    g.fillStyle = C.sep; g.fillRect(0, mid, W, 1);
    if (strip) { g.fillStyle = C.sep; g.fillRect(0, h, W, 1); filmStrip(g, { ...S.film, url: S.url }, { xOf, tOf, W, y: h + 1, h: full - h - 1 }); }
    if (S.range) { const a = xOf(S.range.a), b = xOf(S.range.b); g.fillStyle = C.rangeRuler; g.fillRect(a, 0, b - a, h); g.fillStyle = C.rangeEdge; g.fillRect(a - 1, 0, 2, h); g.fillRect(b - 1, 0, 2, h); }
    g.font = '9.5px Inter, system-ui, sans-serif'; g.textBaseline = 'middle';
    // seconds (top row)
    const steps = [[0.05, 0.01], [0.1, 0.02], [0.25, 0.05], [0.5, 0.1], [1, 0.25], [2, 0.5], [5, 1], [10, 2], [15, 5], [30, 5], [60, 10]];
    const [major, minor] = steps.find(([s]) => s * S.view.pps >= 60) || steps.at(-1);
    for (let k = Math.floor(tOf(0) / minor); ; k++) {
      const t = k * minor, x = Math.round(xOf(t)) + 0.5; if (x > W) break; if (t < 0) continue;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      g.fillStyle = isMajor ? C.tick : C.tickMinor; g.fillRect(x - 0.5, isMajor ? 2 : 9, 1, isMajor ? mid - 2 : mid - 9);
      if (isMajor) { g.fillStyle = C.dim; g.fillText(major < 1 ? `${t.toFixed(major < 0.1 ? 2 : 1)}s` : `${Math.round(t)}s`, x + 3, 7.5); }
    }
    // bars (bottom row), zero-based like tempo().b(bar, beat); where the music's tempo changes, the new one
    const p = inView(), every = [1, 2, 4, 8, 16, 32].find((n) => n * p.bar * S.view.pps >= 24) || 64, t0 = tOf(0), t1 = tOf(W);
    if (p.beat * S.view.pps >= 6) for (const l of gridLines(G(), t0, t1, 1)) if (l.t >= 0) { g.fillStyle = C.tickMinor; g.fillRect(Math.round(xOf(l.t)), h - 4, 1, 4); }
    const ps = gridParts(G()), firsts = new Set(ps.slice(1).map((q) => q.n));
    for (const l of gridLines(G(), t0, t1, 'bar')) {
      if (l.t < 0 || (l.bar % every && !firsts.has(l.bar))) continue;
      const x = Math.round(xOf(l.t));
      g.fillStyle = C.tick; g.fillRect(x, mid + 1, 1, h - mid - 1);
      if (!firsts.has(l.bar)) { g.fillStyle = '#a0a0a0'; g.fillText(String(l.bar), x + 3, mid + 7.5); }
    }
    // (a part's first bar: its number and its tempo, from where the song starts)
    ps.slice(1).forEach((q, i) => {
      const x = Math.round(xOf(q.t)); if (x < -120 || x > W) return;
      const tempo = `${+q.bpm.toFixed(2)} bpm${q.beatsPerBar !== ps[i].beatsPerBar ? ` · ${q.beatsPerBar}/bar` : ''}`, num = `${q.n}  `;
      g.fillStyle = C.ruler; g.fillRect(x, mid + 1, g.measureText(num + tempo).width + 8, h - mid - 1);
      g.fillStyle = C.cue; g.fillRect(x, mid + 1, 1, h - mid - 1);
      g.fillStyle = '#a0a0a0'; g.fillText(num, x + 4, mid + 7.5);
      g.fillStyle = C.cue; g.fillText(tempo, x + 4 + g.measureText(num).width, mid + 7.5);
    });
  }

  // the lanes as the GPU draws them (lanesgpu.js), recorded as a 2D canvas would draw them (g): the lanes, the grid, the
  // range, the cues' lines, the clips (their waveforms and pictures), the objects' bars. What is text, or few and drawn with
  // paths, is ink over them (drawInk).
  function drawLanes(g) {
    const L = lanes();
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    for (const l of L) {
      if (motion(l)) { api.lanes.drawBack(g, l, l.y, W); continue; }
      if (l.kind === 'obj' || l.kind === 'objs') { api.objectRows.drawBack(g, l, W); continue; }
      g.fillStyle = l.track && l.track.id === dropLane?.track?.id ? '#202416' : l.kind === 'track' ? C.track : C.lane; g.fillRect(0, l.y, W, l.h); g.fillStyle = C.sep; g.fillRect(0, l.y + l.h - 1, W, 1);
    }
    const bottom = L.at(-1).y + L.at(-1).h, cuesL = L.find((l) => l.kind === 'cues'), under = L[L.indexOf(cuesL) + 1];
    // past the end of everything
    const xe = xOf(S.end());
    if (xe < W) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(Math.max(0, xe), 0, W, bottom); }
    // grid: the snap's own lines where they are finer than beats (as the piano roll draws them), the beats, the bars
    const gp = inView(), per = snapPer();
    if (typeof per === 'number' && per < 1 && per * gp.beat * S.view.pps >= 5) for (const l of gridLines(G(), tOf(0), tOf(W), per)) if (l.t >= 0) { g.fillStyle = C.sub; g.fillRect(Math.round(xOf(l.t)), cuesL.y, 1, bottom - cuesL.y); }
    if (gp.beat * S.view.pps >= 7) for (const l of gridLines(G(), tOf(0), tOf(W), 1)) if (l.t >= 0) { g.fillStyle = C.beat; g.fillRect(Math.round(xOf(l.t)), cuesL.y, 1, bottom - cuesL.y); }
    if (gp.bar * S.view.pps >= 5) for (const l of gridLines(G(), tOf(0), tOf(W), 'bar')) if (l.t >= 0) { g.fillStyle = C.bar; g.fillRect(Math.round(xOf(l.t)), cuesL.y, 1, bottom - cuesL.y); }
    if (S.range) { const a = xOf(S.range.a), b = xOf(S.range.b); g.fillStyle = C.range; g.fillRect(a, 0, b - a, bottom); }
    // cue lines run through the tracks, so audio lines up with them by eye
    for (const q of S.doc.cues) { const x = Math.round(xOf(q.t)) + 0.5; if (x < 0 || x > W || !under) continue; g.fillStyle = S.sel.has(q.id) ? 'rgba(243,220,76,0.4)' : C.cueLine; g.fillRect(x - 0.5, under.y, 1, bottom - under.y); }
    const rs = regions(S.doc, durations());
    // (each clip over those before it on its track, as a 2D canvas draws them one after another: g.clip0)
    for (const l of L) if (l.kind === 'track') { if (isVisual(l.track)) for (const c of l.track.clips) { g.clip0(); drawPicture(g, c, l); } else for (const r of rs) if (r.track === l.track.id) { g.clip0(); drawClip(g, r, l); } }
    g.z = 1;
    for (const l of L) if (l.kind === 'obj') api.objectRows.draw(g, l, xOf, W);
    shown = { L, bottom, rs };
  }

  // The lanes are recorded for a stretch round the view (half of it again each side, at its zoom: built), and drawn from
  // there by the GPU as the view moves (lanesGPU.draw); a scroll past the stretch, a zoom or a change records them again
  // (about a millisecond on spring-brutalist's). The view's start is kept to a whole px, the stretch's with it, so that a
  // line lands on the pixel it would.
  const built = { t0: 0, pps: 0, w: 0, ok: false };
  function record() {
    const margin = Math.ceil(W / 2), w = W + 2 * margin, rec = lanesGPU.record(), view = [S.view.x0, W];
    S.view.x0 -= margin / S.view.pps; W = w;
    try { drawLanes(rec); Object.assign(built, { t0: S.view.x0, pps: S.view.pps, w, ok: true }); } finally { [S.view.x0, W] = view; }
    lanesGPU.commit(rec, dpr);
  }
  const builtAt = () => (S.view.x0 - built.t0) * S.view.pps;   // (where the view starts in the stretch, px)
  const builtShows = () => { const x = builtAt(); return built.ok && built.pps === S.view.pps && x > -1e-3 && x + W <= built.w + 1e-3; };
  function drawGPU() {
    lanesGPU.draw({ x: Math.round(builtAt()), y: scrollY, w: W, h: viewH, dpr, pps: S.view.pps, zx: Math.round(built.t0 * S.view.pps) });
  }

  // over the lanes, as the view shows them (ink: a canvas the size of the view, drawn again as it moves): each clip's name
  // (held at the view's left edge while the clip starts before it), a sound's "loading…", a trim edge lit and a sound's fade
  // handles, a song's parts and drops, a splice's crossfade, the cues, the selection's moves and keys on its object's row,
  // the motion lanes (fitted to what they show), the hint under the tracks. Only the lanes in view.
  function drawInk() {
    const g = ink.getContext('2d'), { L, bottom, rs } = shown, seen = (l) => l.y + l.h > scrollY && l.y < scrollY + viewH;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, ink.width, ink.height);
    g.setTransform(dpr, 0, 0, dpr, 0, -scrollY * dpr);
    for (const l of L) {
      if (!seen(l)) continue;
      if (l.kind === 'track') {
        if (isVisual(l.track)) for (const c of l.track.clips) { clipLabel(g, c, l); clipMarks(g, c, l); }
        else for (const r of rs) if (r.track === l.track.id) { clipInk(g, r, l); clipLabel(g, r.clip, l); clipMarks(g, r.clip, l); }
      } else if (l.kind === 'obj') api.objectRows.marks(l, (row, y, h) => api.lanes.marks(g, row, y, h, xOf, W));
      else if (l.kind === 'cues') drawCues(g, l);
      else if (motion(l)) api.lanes.draw(g, l, l.y, xOf, tOf, W);
    }
    if (H - bottom > 36) { g.fillStyle = C.faint; g.font = '10.5px Inter, system-ui, sans-serif'; g.textBaseline = 'middle'; g.fillText('Drop audio, images or video here', 10, bottom + 18); }
  }
  // a clip's name (and a sound's "loading…"), held at the view's left edge while the clip starts before it, within its
  // outline
  function clipLabel(g, c, l) {
    const x0 = xOf(c.at), x1 = xOf(clipEnd(c));
    if (x1 < -2 || x0 > W + 2) return;
    const y0 = l.y + 2, h = l.h - 5, w = Math.max(1, x1 - x0), TOP = 13, picture = isVisual(l.track);
    g.save(); g.beginPath(); g.rect(x0 + 1, y0 + 1, w - 2, h - 2); g.clip();
    g.fillStyle = C.clipInk; g.font = '600 10px Inter, system-ui, sans-serif'; g.textBaseline = 'middle';
    if (picture) { const m = S.doc.media[c.media]; g.fillText(`${m?.name ?? c.media}${m?.kind === 'video' ? '' : ' · still'}`, Math.max(x0, 0) + 6, y0 + 7); }
    else {
      g.fillText(`${c.media}${c.gain ? `  ${c.gain > 0 ? '+' : ''}${c.gain.toFixed(1)} dB` : ''}`, Math.max(x0, 0) + 6, y0 + 7);
      const m = audio.get(c.media);
      if (!heardMedium(c.media)?.notes && !m?.peaks) {
        g.fillStyle = C.dim; g.font = '10px Inter, system-ui, sans-serif';
        g.fillText(m?.error ? `can't load: ${m.error}` : 'loading…', Math.max(x0, 0) + 8, y0 + TOP + 1 + (h - TOP - 1) / 2);
      }
    }
    g.restore();
  }

  // what moves over them, drawn again as it moves (see over): the pointer's line and its time, the snap line, the box
  // being drawn, the motion lanes' values at the playhead, the playhead
  function drawOver() {
    const g = overLanes.getContext('2d'), r = overRuler.getContext('2d'), full = overRuler.height / dpr, { L, bottom } = shown;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, overLanes.width, overLanes.height);
    g.setTransform(dpr, 0, 0, dpr, 0, -scrollY * dpr);
    r.setTransform(dpr, 0, 0, dpr, 0, 0); r.clearRect(0, 0, W, full);
    if (hoverT != null && !drag) {
      const x = Math.round(xOf(hoverT)) + 0.5, label = `${hoverT.toFixed(2)}  ${api.barBeat(hoverT)}`;
      g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(x - 0.5, 0, 1, bottom);
      r.font = '9.5px "JetBrains Mono", ui-monospace, monospace'; r.textBaseline = 'middle';
      const w = r.measureText(label).width + 8, lx = clamp(x + 4, 0, W - w);
      r.fillStyle = 'rgba(255,255,255,0.25)'; r.fillRect(x - 0.5, 0, 1, full);
      r.fillStyle = '#0e0e0e'; r.fillRect(lx, 1, w, 12);
      r.fillStyle = C.text; r.fillText(label, lx + 4, 7.5);
    }
    if (S.snapLine != null) { const x = Math.round(xOf(S.snapLine)) + 0.5; g.fillStyle = accent(0.9); g.fillRect(x - 0.5, 0, 1, bottom); }
    if (drag?.box) {   // (the box being drawn)
      const b = drag.box, x = Math.min(b.x0, b.x), y = Math.min(b.y0, b.y), w = Math.abs(b.x - b.x0), h = Math.abs(b.y - b.y0);
      g.fillStyle = accent(0.12); g.fillRect(x, y, w, h); g.strokeStyle = accent(0.7); g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w, h);
    }
    for (const l of L) if (motion(l) && l.y + l.h > scrollY && l.y < scrollY + viewH) api.lanes.drawNow?.(g, l, xOf, W);
    const px = Math.round(xOf(S.t)) + 0.5;
    if (px >= 0 && px <= W) { g.fillStyle = accent(); g.fillRect(px - 0.5, 0, 1, H); }
    if (px >= -8 && px <= W + 8) {
      r.fillStyle = accent();
      r.beginPath(); r.moveTo(px - 5, 0); r.lineTo(px + 5, 0); r.lineTo(px + 5, 7); r.lineTo(px, 12); r.lineTo(px - 5, 7); r.closePath(); r.fill();
      r.fillRect(px - 0.5, 11, 1, full);
    }
  }

  function drawCues(g, l) {
    const cues = [...S.doc.cues].sort((a, b) => a.t - b.t), top = l.y + 3, bot = l.y + l.h - 4;
    g.textBaseline = 'middle';
    cues.forEach((q, i) => {
      const x = Math.round(xOf(q.t)) + 0.5, xe = xOf(q.t + q.dur), next = cues[i + 1] ? xOf(cues[i + 1].t) : W + 400;
      if (Math.max(x, xe) < -200 || x > W + 4) return;
      const sel = S.sel.has(q.id), hov = hover?.cue === q || drag?.id === q.id, endHot = (hover?.cue === q && hover.zone === 'end') || (drag?.id === q.id && drag.zone === 'end');
      if (q.dur > 0) {
        g.fillStyle = sel ? 'rgba(243,220,76,0.24)' : hov ? 'rgba(243,220,76,0.19)' : C.cueDim; g.fillRect(x, top, xe - x, bot - top);
        g.fillStyle = C.cue; g.fillRect(x, top, xe - x, 2);
        g.fillStyle = endHot ? accent() : C.cue; g.fillRect(xe - (endHot ? 2 : 1), top, endHot ? 2 : 1, bot - top);
        if (sel) { g.strokeStyle = accent(); g.lineWidth = 1; g.strokeRect(x + 0.5, top + 0.5, xe - x - 1, bot - top - 1); }
      }
      g.fillStyle = C.cue; g.fillRect(x - 0.5, top, 1, bot - top);
      // flag
      g.beginPath(); g.moveTo(x - 0.5, top); g.lineTo(x + 6, top); g.lineTo(x + 6, top + 7); g.lineTo(x - 0.5, top + 10); g.closePath();
      g.fillStyle = hov && !sel ? '#fbe98a' : C.cue; g.fill();
      if (sel) { g.strokeStyle = accent(); g.lineWidth = 1.5; g.stroke(); }
      // a cue the film follows carries an accent dot on its flag
      if (S.film.cues.some((c) => c.id === q.id)) { g.beginPath(); g.arc(x + 2.8, top + 4.4, 1.9, 0, Math.PI * 2); g.fillStyle = accent(); g.fill(); }
      // the tab that drags a point cue out into a range
      if (q.dur === 0 && (sel || hov)) { g.fillStyle = endHot ? accent() : 'rgba(243,220,76,0.6)'; g.fillRect(x + 8, top + 2, 3, 7); }
      const room = (q.dur > 0 ? Math.max(xe, Math.min(next, x + 400)) : next) - x - 12;
      if ((q.label || q.note) && room > 12) {
        g.save(); g.beginPath(); g.rect(x + (q.dur > 0 ? 3 : 8), l.y, room, l.h); g.clip();
        g.font = '500 11px Inter, system-ui, sans-serif'; g.fillStyle = sel ? '#ffffff' : '#f6e79a';
        g.fillText(q.label || '—', x + (q.dur > 0 ? 5 : 9), top + 16);
        if (q.note) { g.font = '10px Inter, system-ui, sans-serif'; g.fillStyle = C.dim; g.fillText(q.note.split('\n')[0], x + (q.dur > 0 ? 5 : 9), top + 27); }
        g.restore();
      }
    });
  }

  // a picture's clip (an image, a video): its picture at its start, its name; the outline as an audio clip's
  const thumbs = new Map();   // media id → its picture (an image; a video's first frame), once loaded
  function thumbOf(id) {
    const m = S.doc.media[id];
    if (!m || thumbs.has(id)) return thumbs.get(id)?.complete ? thumbs.get(id) : null;
    const img = new Image();
    img.onload = () => { dirty = true; };
    img.src = api.resolve(m.kind === 'video' ? `${m.frames}/000001.jpg` : m.src);
    thumbs.set(id, img);
    return null;
  }
  function drawPicture(g, c, l) {
    const x0 = xOf(c.at), x1 = xOf(clipEnd(c));
    if (x1 < -2 || x0 > W + 2) return;
    const sel = S.sel.has(c.id), y0 = l.y + 2, h = l.h - 5, w = Math.max(1, x1 - x0), m = S.doc.media[c.media];
    const hz = (drag?.id === c.id && drag.zone) || (hover?.clip === c && hover.zone), TOP = 13;
    g.save();
    g.beginPath(); g.rect(x0, y0, w, h); g.clip();
    g.fillStyle = sel ? '#5c86d6' : '#476fbf'; g.fillRect(x0, y0, w, h);
    g.fillStyle = sel ? '#a9c6ff' : '#86abff'; g.fillRect(x0, y0, w, TOP);
    // its picture, along the clip (a strip of it, as an editor shows a video)
    const img = thumbOf(c.media), ph = h - TOP - 2;
    if (img && m?.w) { const pw = (ph * m.w) / m.h; g.picture({ img, x: x0, y: y0 + TOP + 1, w: pw, h: ph, step: pw + 2 }); }
    g.restore();   // (its name: clipLabel, over the lanes as shown)
    g.layer = 'over'; g.strokeStyle = sel ? accent() : hz ? 'rgba(255,255,255,0.3)' : C.clipEdge; g.lineWidth = 1;
    g.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1); g.layer = 'under';
  }
  function drawClip(g, r, l) {
    const c = r.clip, x0 = xOf(c.at), x1 = xOf(clipEnd(c));
    if (x1 < -2 || x0 > W + 2) return;
    const sel = S.sel.has(c.id), m = audio.get(c.media), y0 = l.y + 2, h = l.h - 5, w = Math.max(1, x1 - x0);
    const hz = (drag?.id === c.id && drag.zone) || (hover?.clip === c && hover.zone), hov = !!hz, TOP = 13;
    g.save();
    g.beginPath(); g.rect(x0, y0, w, h); g.clip();
    const tc = trackColour(S.doc.tracks.indexOf(l.track));
    g.fillStyle = sel ? tc.selBody : tc.body; g.fillRect(x0, y0, w, h);
    g.fillStyle = sel ? tc.selTop : tc.top; g.fillRect(x0, y0, w, TOP);
    // waveform: the mid channel, scaled by the clip's gain and fades (what you hear)
    const top = y0 + TOP + 1, mid = top + (h - TOP - 1) / 2, half = (h - TOP - 4) / 2, notes = heardMedium(c.media)?.notes;
    if (notes) {
      // a notes clip: its pattern's notes as they play here (pitch up the clip, the trimmed part left out), not a sound
      const sp = speedOf(c), seen = notes.filter((n) => n.t + n.dur > c.in && n.t < c.out);
      const lo = Math.min(...seen.map((n) => n.note)), hi = Math.max(...seen.map((n) => n.note)), span = Math.max(12, hi - lo + 1);
      const rowH = Math.max(1.5, (h - TOP - 4) / span), base = lo - Math.floor((span - (hi - lo + 1)) / 2);
      g.fillStyle = sel ? tc.selWave : tc.wave;
      for (const n of seen) {
        const a = xOf(c.at + (Math.max(n.t, c.in) - c.in) / sp), b = xOf(c.at + (Math.min(n.t + n.dur, c.out) - c.in) / sp);
        g.globalAlpha = 0.45 + 0.55 * (n.vel ?? 0.8);
        g.fillRect(a, top + 1 + (base + span - 1 - n.note) * rowH, Math.max(1.5, b - a - 1), Math.max(1.5, rowH - 0.5));
      }
      g.globalAlpha = 1;
    }   // (still loading: said by clipLabel)
    // its waveform, the mid channel scaled by its gain and ramps (what you hear), and its fades shaded above their curve:
    // drawn by the GPU from its peaks (lanesgpu.js), a column of it each px
    const sp = speedOf(c), fade = (len, out) => (len > 0 ? [out ? x1 - len * S.view.pps : x0, out ? x1 : x0 + len * S.view.pps, hz === (out ? 'fade-out' : 'fade-in') ? accent() : 'rgba(255,255,255,0.5)'] : [0, 0, '#000']);
    g.globalAlpha = 0.85;
    g.wave({ peaks: notes ? null : m?.peaks ?? null, mid, half, at: c.at - S.view.x0, from: c.in, speed: sp, sr: m?.buffer?.sampleRate ?? 48000, gain: r.gain,
      ramps: r.ramps.map((q) => ({ ...q, t0: q.t0 - S.view.x0, t1: q.t1 - S.view.x0 })), colour: sel ? tc.selWave : tc.wave, fades: [fade(c.fadeIn, false), fade(c.fadeOut, true)] });
    g.globalAlpha = 1;
    g.layer = 'over';
    const mu = S.music?.[c.media];
    if (mu?.bpm) songMarks(g, c, mu, x0, x1, y0, h);
    g.restore();   // (its name and gain: clipLabel, over the lanes as shown)
    // outline: the accent when selected; a trim edge lights up under the pointer
    g.strokeStyle = sel ? accent() : hov ? 'rgba(255,255,255,0.3)' : C.clipEdge; g.lineWidth = 1;
    g.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
    g.layer = 'under';
    // (a splice's crossfade, a song's parts and drops: clipInk; a trim edge lit under the pointer, a fade's handles:
    // clipMarks, over its name)
  }
  // over a sound's clip, as the lanes are shown: the mark of an automatic crossfade at its splice, a song's parts' letters
  // and its drops
  function clipInk(g, r, l) {
    const c = r.clip, x0 = xOf(c.at), x1 = xOf(clipEnd(c));
    if (x1 < -2 || x0 > W + 2) return;
    const y0 = l.y + 2, h = l.h - 5, mu = S.music?.[c.media];
    if (mu?.bpm) { g.save(); g.beginPath(); g.rect(x0, y0, Math.max(1, x1 - x0), h); g.clip(); songInk(g, c, mu, x0, x1, y0, h); g.restore(); }
    if (r.joinIn) {   // automatic crossfade at the splice
      const x = Math.round(x0) + 0.5; g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x - 3.5, y0 + 3); g.lineTo(x + 3.5, y0 + 10); g.moveTo(x - 3.5, y0 + 10); g.lineTo(x + 3.5, y0 + 3); g.stroke();
    }
  }
  // over a clip's name, as the lanes are shown: the trim edge under the pointer lit, and a selected or pointed-at sound's
  // fade handles
  function clipMarks(g, c, l) {
    const x0 = xOf(c.at), x1 = xOf(clipEnd(c));
    if (x1 < -2 || x0 > W + 2) return;
    const y0 = l.y + 2, h = l.h - 5, w = Math.max(1, x1 - x0), hz = (drag?.id === c.id && drag.zone) || (hover?.clip === c && hover.zone);
    if (hz === 'trim-in' || hz === 'trim-out') { g.fillStyle = accent(); g.fillRect(hz === 'trim-in' ? x0 : x1 - 3, y0, 3, h); }
    if (isVisual(l.track) || !((S.sel.has(c.id) || hz) && w > 24)) return;
    for (const [x, zone] of [[x0 + (c.fadeIn || 0) * S.view.pps, 'fade-in'], [x1 - (c.fadeOut || 0) * S.view.pps, 'fade-out']]) {
      const hx = clamp(x, x0 + 4, x1 - 4), hot = hz === zone;
      g.fillStyle = hot ? accent() : '#ffffff'; g.beginPath(); g.arc(hx, y0 + 4.5, hot ? 4 : 3, 0, Math.PI * 2); g.fill();
    }
  }

  // a song as the studio heard it (tools/music.mjs): its parts along the clip's foot (lighter, the more intense; its
  // letter where each starts: a letter again is a part come back), its beats as ticks over them (downbeats taller;
  // fainter, the less sure the model is of each), its drops marked at the top. The parts and beats are the lanes' (the
  // GPU's: songMarks), the letters and drops are ink (songInk).
  const songOf = (c, mu, x0, x1) => {
    const sp = speedOf(c);
    return { sp, xAt: (s) => xOf(c.at + (s - c.in) / sp), within: (s) => s >= c.in - 1e-6 && s <= c.out + 1e-6, lo: Math.max(x0, 0), hi: Math.min(x1, W),
      parts: mu.sections.map((s, i) => [s, mu.sections[i + 1]?.t ?? mu.duration]).filter(([s, end]) => end > c.in && s.t < c.out) };
  };
  function songMarks(g, c, mu, x0, x1, y0, h) {
    const { sp, xAt, within, lo, hi, parts } = songOf(c, mu, x0, x1), foot = y0 + h - 4;
    for (const [s, end] of parts) {
      const a = Math.max(lo, xAt(Math.max(s.t, c.in))), b = Math.min(hi, xAt(Math.min(end, c.out)));
      if (b > a) { g.fillStyle = `rgba(255,255,255,${s.intensity ? 0.1 + 0.11 * s.intensity : 0.04})`; g.fillRect(a, foot, Math.max(1, b - a - 1), 3); }
    }
    const beatPx = (60 / mu.bpm / sp) * S.view.pps, downs = new Set(mu.downbeats);
    if (beatPx * mu.beatsPerBar >= 5) {
      mu.beats.forEach((b, i) => {
        const down = downs.has(b); if (!within(b) || (!down && beatPx < 5)) return;
        const x = xAt(b), sure = Math.max(0, ((mu.conf?.[i] ?? 1) - 0.5) / 0.5); if (x < lo || x > hi) return;
        g.fillStyle = `rgba(255,255,255,${down ? 0.2 + 0.5 * sure : 0.1 + 0.22 * sure})`; g.fillRect(Math.round(x), foot - (down ? 7 : 4), 1, down ? 7 : 4);
      });
    }
  }
  function songInk(g, c, mu, x0, x1, y0, h) {
    const { xAt, within, lo, hi, parts } = songOf(c, mu, x0, x1), foot = y0 + h - 4;
    g.font = '600 8.5px Inter, system-ui, sans-serif'; g.textBaseline = 'alphabetic';
    for (const [s, end] of parts) {
      const a = Math.max(lo, xAt(Math.max(s.t, c.in))), b = Math.min(hi, xAt(Math.min(end, c.out)));
      if (b - a > 16 && s.intensity && s.t >= c.in - 1e-6) { g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText(s.label, a + 3, foot - 2); }
    }
    for (const d of mu.drops ?? []) {
      if (!within(d.t)) continue;
      const x = Math.round(xAt(d.t)); if (x < lo - 30 || x > hi) continue;
      g.fillStyle = C.cue; g.beginPath(); g.moveTo(x - 4, y0 + 13); g.lineTo(x + 4, y0 + 13); g.lineTo(x, y0 + 18); g.closePath(); g.fill();
      if (hi - x > 30) { g.font = '600 8.5px Inter, system-ui, sans-serif'; g.fillText('drop', x + 6, y0 + 20); }
    }
  }

  function draw(force) {
    syncHeads();
    glideOn();
    if (dirty || force) { dirty = false; built.ok = false; }
    if (!built.ok || scrolled) {
      // (their heads as they were: a scroll changes neither them nor the playhead)
      if (!built.ok) syncMotionHeads(); else readMotionHeads();
      scrolled = false; overDirty = true;
      if (!builtShows()) record();
      drawGPU(); drawInk(); drawRuler(); drawThumb();
    }
    if (overDirty) { overDirty = false; drawOver(); }
  }

  // where a dropped file lands: the track and time under the pointer
  function dropAt(cx, cy) {
    const r = canvas.getBoundingClientRect();
    if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null;
    const y = cy - r.top + scrollY, l = lanes().find((k) => y >= k.y && y < k.y + k.h);
    return { track: l?.kind === 'track' ? l.track.id : null, t: Math.max(0, snap(tOf(cx - r.left), snapTargets(new Set()), {}).t), lane: l };
  }
  function setDropLane(l) { if (l?.track?.id !== dropLane?.track?.id) { dropLane = l; dirty = true; } }

  // ---------- G and S in time (docs/selection.md): the selection's clips, cues, keys and moves moved (G) or stretched about
  // the playhead (S) as the pointer goes, wherever it is in the window; a number typed is the amount (seconds; how many
  // times as long). A click or Enter sets it, Esc or a right click puts it back: one undo step
  let gest = null, px = null, gestEnd = 0;
  onEvery('pointermove', (e) => { if (e.view?.document !== canvas.ownerDocument) return; px = e.clientX - canvas.getBoundingClientRect().left; if (gest) { gest.ev = e; stepGesture(); } });
  onEvery('pointerdown', (e) => { if (!gest) return; e.preventDefault(); e.stopPropagation(); endGesture(e.button === 0); }, true);
  onEvery('contextmenu', (e) => { if (gest || performance.now() - gestEnd < 600) { e.preventDefault(); e.stopPropagation(); } }, true);
  function gesture(mode) {
    if (gest || drag) return false;
    const R = retimer();
    if (!R.n) return false;
    gest = { mode, R, base: structuredClone(S.doc), x0: px ?? xOf(S.t), p: S.t, typed: '', ev: null, fn: (t) => t, k: 1, desc: '' };
    S.dragging = true; stepGesture();
    return true;
  }
  function stepGesture() {
    const g = gest, x = px ?? g.x0, n = /^-?\d*\.?\d+$/.test(g.typed) ? +g.typed : null, things = `${g.R.n} ${g.R.n === 1 ? 'thing' : 'things'}`;
    let say;
    if (g.mode === 'move') {
      let dt = n ?? (x - g.x0) / S.view.pps;
      if (n == null) { const s = snap(g.R.min + dt, snapTargets(new Set(S.sel)), g.ev ?? {}); S.snapLine = s.hit; dt = s.t - g.R.min; }
      dt = Math.max(dt, -g.R.min);
      g.fn = (t) => t + dt; g.k = 1;
      g.desc = `move ${things} by ${dt >= 0 ? '+' : ''}${f2(dt)} s`; say = `Move ${dt >= 0 ? '+' : '−'}${f2(Math.abs(dt))} s`;
    } else {
      const a = g.x0 - xOf(g.p), b = x - xOf(g.p), k = Math.max(0, n ?? (Math.abs(a) < 4 ? 1 : b / a));
      g.fn = (t) => g.p + (t - g.p) * k; g.k = k;
      g.desc = `stretch ${things} ×${k.toFixed(3)} about ${f2(g.p)} s`; say = `Stretch ×${k.toFixed(3)} about the playhead`;
    }
    S.doc = structuredClone(g.base);
    g.R.apply(S.doc, g.fn, g.k);
    api.changedLive();
    api.hint(`<b>${say}</b> · ${things}${g.typed ? ` · typed ${g.typed}` : ''} · click or Enter sets it · Esc puts it back`);
    dirty = true;
  }
  function endGesture(set) {
    const g = gest;
    gest = null; gestEnd = performance.now(); S.dragging = false; S.snapLine = null; api.hint(''); dirty = true;
    if (!set) { S.doc = g.base; api.changedLive(); return; }
    api.dragged(g.base, g.desc); g.R.done(g.fn);
  }
  // a key while G or S goes on: a number typed, Backspace, Enter, Esc, or the other of G and S (the rest wait)
  function gestureKey(e) {
    if (!gest) return false;
    if (e.key === 'Enter') endGesture(true);
    else if (e.key === 'Escape') endGesture(false);
    else if (/^[0-9.]$/.test(e.key) || (e.key === '-' && !gest.typed)) { gest.typed += e.key; stepGesture(); }
    else if (e.key === 'Backspace') { gest.typed = gest.typed.slice(0, -1); stepGesture(); }
    else if ((e.code === 'KeyG' || e.code === 'KeyS') && !e.repeat) { const m = e.code === 'KeyG' ? 'move' : 'stretch'; if (m !== gest.mode) { gest.mode = m; gest.typed = ''; stepGesture(); } }
    return true;
  }

  return {
    draw, fit, zoomAt, xOf, tOf, lanes, dropAt, setDropLane, inlineLabel,
    /** G or S in time on the selection's clips, cues, keys and moves (false: none is selected). */
    gesture, gestureKey, gesturing: () => !!gest,
    /** The motion lanes changed (rows, heights): lay out again. */
    relayout: () => { mhtml = ''; resize(); },
    invalidate: () => { dirty = true; },
    /** The playhead moved (and nothing else did): what goes over the lanes drawn again, not the lanes. */
    moved: () => { overDirty = true; },
    /** While playing: the view turns its page as the playhead reaches its right edge; not while the director has moved
     *  it away from the playhead (a wheel, a pan, the scrollbar), until the playhead is in view again or plays anew
     *  (followAgain): their scroll and the page turning fought each frame, the view jittering back and forth. */
    follow() { const x = xOf(S.t); if (x >= 0 && x <= W - 40) catching = true; else if (catching) setX0(S.t - visible() * 0.08); },
    followAgain() { catching = true; },
    reveal(t) { const x = xOf(t); if (x < 20 || x > W - 20) setX0(t - visible() / 2); },
    /** Each audio track's light as the timeline plays at t (null: stopped), dt seconds since the last: full when a clip or
     *  a note on it starts, falling to half while what it plays goes on (a note held, a clip playing), out when it ends,
     *  as a DAW's track lights do. */
    activity(t, dt) {
      const from = actAt != null && t != null && t >= actAt ? actAt : t;
      actAt = t;
      for (const tr of S.doc.tracks) {
        const a = acts.get(tr.id); if (!a) continue;
        let started = false, held = false;
        if (t != null) for (const c of tr.clips) {
          const end = clipEnd(c); if (end <= from || c.at > t) continue;
          const notes = heardMedium(c.media)?.notes, sp = speedOf(c);
          if (!notes) { held ||= t < end; started ||= c.at > from && c.at <= t; continue; }
          const m = c.in + (t - c.at) * sp;
          for (const n of notes) {
            const at = c.at + (n.t - c.in) / sp;
            if (at < c.at - 1e-9 || at >= end) continue;
            if (at > from && at <= t) started = true;
            if (n.t <= m && m < n.t + n.dur) held = true;
          }
        }
        const goal = held ? 0.5 : 0, lit = started ? 1 : a.lit > goal ? Math.max(goal, a.lit - dt * 3) : goal;
        if (Math.abs(lit - a.lit) < 0.005 && !(lit === 0 && a.lit !== 0)) continue;
        a.lit = lit; a.el.style.opacity = (0.12 + 0.88 * lit).toFixed(2);
      }
    },
  };
}
