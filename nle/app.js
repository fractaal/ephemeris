// The editor: state, edits with undo/redo, autosave (2 s after the last edit, each save kept by the server as a version
// of the project: its History), playback, the viewer (frames the server renders live, on the audio clock), panels and keys.
import './storage.js';
import { linkFetch, LinkEvents } from './link.js';
import { createViewport } from './viewport.js';
import { icon } from './icons.js';
import { startTips, pinTip } from './tips.js';
import { format, clipEnd, speedOf, isVisual, detectedGrid, sameGrid, isNotes, DEFAULT_INSTRUMENT, isAutomated, SAMPLES, samplesOf, PIXEL_FILTER, AGENT_NAME, isPictures, thingChanges } from './model.js';
import { parts as gridParts, partAt, position } from '../engine/grid.js';
import { renameSites, orphansIn, dropOrphan, filmSees, followed, strip, parseSite } from './anchors.js';
import * as audio from './audio.js';
import { pluginKey } from './live.js';
import { createTimeline, filmStrip } from './timeline.js';
import { createLanes } from './lanes.js';
import { createAgentPanel } from './agent.js';
import { createMixer } from './mixer.js';
import { createPresence } from './presence.js';
import { createGizmo } from '/files/engine/gizmo.js';
import { gridSvg, lightsSvg, outlinesSvg, outlineOf, membersOf, pathSvg as pathMarks, cameraSvg, pinsSvg } from '/files/engine/overlays.js';
import { createObjectRows } from './objects.js';
import { createInstrumentPanel } from './instrument.js';
import { createCodePanel } from './code.js';
import { createExplorer, folderSource } from './explorer.js';
import { createViews } from './fxview.js';
import { deviceOf, paramsOf, pluginParams, textOf, fromNorm } from './device.js';
import { createPianoRoll } from './pianoroll.js';
import { trackColour } from './colours.js';
import { createLayout, onEvery, find, bodyClass, frame } from './layout.js';
import { numberFields } from './numfield.js';
import { snapName, isSnap, snapItems } from './snap.js';
import { basis, setFrame, W as FW, H as FH } from '/files/engine/lens.js';
import { valueAt, keyed } from '/files/engine/keyframes.js';
import { addedClips, liveEdits } from '/files/engine/site.js';
import { ADD, MATERIALS, isLightType, newThing } from './things.js';
import { score, played } from '/files/engine/score.js';

const $ = find;   // (an element in whichever window it is now: see layout.js)
const SAVE_AFTER = 2000;
const f2 = (t) => (+t).toFixed(2);
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const st = await (await linkFetch('api/state')).json();
const S = {
  name: st.name, timeline: st.timeline, file: st.file, dir: st.dir, url: st.url, urlFixed: st.urlFixed, text: st.text, doc: JSON.parse(st.text), draft: st.draft, render: st.render, film: st.preview,
  undo: [], redo: [], pending: [], saving: false, dragging: false, conflict: null, history: [], version: null,
  t: 0, sel: new Set(), range: null, snap: true, snapLine: null, view: { x0: 0, pps: 20 },
  end() {
    const d = this.doc;
    return Math.max(1, this.film.duration || 0, audio.mixDuration(), ...d.tracks.flatMap((t) => t.clips.map(clipEnd)), ...d.cues.map((q) => q.t + q.dur));
  },
};
let roll = null;   // (the piano roll, made with the layout below)
// (state the layout's and the studio's first calls reach, before the code that uses it is: the app's menus pushed to
// the system's menu bar, and how far the instruments' sound had fallen behind)
let menusLater = 0, lateAt = 0, lateWas = 0;
window.__nle = S;   // for poking at from the console (and the tests)
// the editor's own film, in the viewer's screen (nle/viewport.js)
const viewport = createViewport({ el: document.getElementById('screen'), on: (event, d) => viewportEvent(event, d) });
window.__viewport = viewport;   // (and it, for the tests)
const KEY = `nle:${S.dir}:${S.timeline}`;
let rememberedView = false;
try { const k = JSON.parse(localStorage.getItem(KEY) || '{}'); S.range = k.range || null; S.t = Math.max(0, +k.t || 0); if (k.view?.pps > 0) { S.view = k.view; rememberedView = true; } } catch {}
const remember = (o) => { try { localStorage.setItem(KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(KEY) || '{}'), ...o })); } catch {} };
// a project's file (its path, as the project names it) where the studio serves it: each name in the path encoded, so a
// sample named "Bass D#2.wav" is that file, not "Bass D" and a fragment
const resolve = (src) => new URL(src.split('/').map(encodeURIComponent).join('/'), `${location.origin}/files/${S.dir}/`).pathname;

// ---------- the simple view, for a phone (or any small screen): the viewer with a scrubber under it, and the agent, the
// one panel beside it; the studio's mix is what plays (audio.js useMix), not the live engine. Auto by the screen; Simple
// or Full chosen (View › Simple view, or the header's Full editor), kept for this device, unless it is what Auto picks
const SMALL = matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 1024px)').matches;
const SIMPLE = (() => { let v = 'auto'; try { v = localStorage.getItem('nle:view') || 'auto'; } catch { /* storage refused */ } return v === 'simple' || (v !== 'full' && SMALL); })();
function viewMode(simple) {
  try { if (simple === SMALL) localStorage.removeItem('nle:view'); else localStorage.setItem('nle:view', simple ? 'simple' : 'full'); } catch { /* only for this page, then */ }
  location.reload();
}
document.body.classList.toggle('simple', SIMPLE);
// (the studio's mix plays in the simple view, and where the page has no live engine: audio.live)
const MIX = SIMPLE || !audio.live;
if (MIX) audio.useMix(null);

document.title = `${S.name} · ${S.timeline}`;
$('#projName').textContent = S.name;
$('#path').textContent = `${S.dir}/${S.file}`;

// ---------- menus (the project switcher, the timelines' and right-click context menus): one at a time, closed by a click elsewhere or Esc
const menu = document.createElement('div');
menu.className = 'menu'; menu.setAttribute('role', 'menu'); menu.tabIndex = -1; menu.hidden = true; document.body.append(menu);
let menuFor = null;
function closeMenu() { menu.hidden = true; menuFor?.classList.remove('on'); menuFor = null; }
/** items: [{ label, hint, cur, checked, disabled, act, submenu? }, { role } (Electron's own: in the app alone)] or 'hr';
 *  at: a point (a right-click, the menu bar's) instead of below the anchor: in the app, the system's own menu there
 *  (app/preload.cjs), a hint that is a key its shortcut, other hints left out. */
function openMenu(anchor, items, at) {
  if (at && window.studioApp && anchor.ownerDocument === document) return systemMenu(items, at);
  if (menuFor === anchor && !at) return closeMenu();
  closeMenu();
  items = items.flatMap((it) => (it.role ? [] : it.submenu ? ['hr', { label: it.label, disabled: true }, ...it.submenu] : [it]));
  menu.innerHTML = items.map((it, i) => {
    if (it === 'hr') return '<hr>';
    const check = it.checked == null ? '' : ` aria-checked="${it.checked}"`;
    return `<button data-i="${i}" class="${it.cur ? 'cur' : ''}${it.checked ? ' checked' : ''}"${check} role="${it.checked == null ? 'menuitem' : 'menuitemcheckbox'}" ${it.disabled ? 'disabled' : ''}><span class="menu-check" aria-hidden="true">${it.checked ? '✓' : ''}</span><span>${esc(it.label)}</span><span class="faint">${esc(it.hint || '')}</span></button>`;
  }).join('');
  const r = anchor.getBoundingClientRect(), doc = anchor.ownerDocument, win = doc.defaultView || window;
  doc.body.append(menu);   // (in the anchor's window: a panel may have one of its own)
  menu.hidden = false;
  const x = at?.x ?? r.left, y = at?.y ?? r.bottom + 2, maxX = Math.max(4, win.innerWidth - menu.offsetWidth - 4), maxY = Math.max(4, win.innerHeight - menu.offsetHeight - 4);
  Object.assign(menu.style, { left: `${Math.max(4, Math.min(maxX, x))}px`, top: `${Math.max(4, Math.min(maxY, y))}px` });
  anchor.classList.add('on'); menuFor = anchor;
  for (const b of menu.querySelectorAll('button')) b.onclick = () => { const it = items[+b.dataset.i]; closeMenu(); it.act?.(); };
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}
// a hint as an accelerator, where it is a key (Ctrl+C: CmdOrCtrl+C; Del: Delete), else none
const accelerator = (hint = '') => (/^((Ctrl|Shift|Alt)\+)*([A-Z0-9,]|F\d{1,2}|Del|Delete|Backspace|Enter|Esc)$/.test(hint) ? hint.replace(/^Ctrl\+/, 'CmdOrCtrl+').replace(/\bDel$/, 'Delete') : undefined);
// items as the system's menus take them, each act kept in acts by the id it is told back by
const forSystem = (items, acts) => items.map((it) => (it === 'hr' ? 'hr' : it.role ? { role: it.role } : { label: it.label, checked: it.checked, disabled: !!it.disabled, keys: accelerator(it.hint),
  ...(it.submenu ? { submenu: forSystem(it.submenu, acts) } : { id: acts.push(it.act) - 1 }) }));
function systemMenu(items, at) {
  closeMenu();
  const acts = [];
  window.studioApp.contextMenu(forSystem(items, acts), { x: at.x, y: at.y }, (id) => acts[id]?.());
}
menu.addEventListener('keydown', (e) => {
  const buttons = [...menu.querySelectorAll('button:not(:disabled)')], here = buttons.indexOf(menu.ownerDocument.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
  if (!buttons.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (here + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus();
});
onEvery('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && !menuFor?.contains(e.target)) closeMenu(); });
onEvery('contextmenu', (e) => { if (!menu.hidden && !menu.contains(e.target) && !menuFor?.contains(e.target)) closeMenu(); }, true);

// Save the timeline and preserve manual code/chat drafts before navigating. Agents are owned by the studio,
// not this page; returning to a project reconnects to them where they are now.
async function navigate(url) {
  if (S.dragging) return toast('Finish this edit before switching projects.');
  await save();
  if (S.pending.length && !S.conflict && !S.saveError) await save();
  if (S.pending.length || S.conflict || S.saveError) return toast('Resolve the unsaved timeline changes before switching.', true);
  if (!codePanel.stash()) return toast('Save your code changes before switching; browser storage is full.', true);
  panel.stash(); remember({ t: S.t, view: S.view });
  location.href = url;
}
function projectTabs(state) {
  const bar = $('#projectTabs');
  bar.innerHTML = (state.projects ?? []).map((p) => {
    const waiting = p.agents.filter((a) => a.waiting).length, working = p.agents.filter((a) => a.busy && !a.waiting).length;
    const status = [working && `${working} working`, waiting && `${waiting} waiting`].filter(Boolean).join(' · ');
    return `<button class="project-tab${p.name === S.name ? ' on' : ''}${waiting ? ' waiting' : working ? ' busy' : ''}" data-project="${esc(p.name)}" aria-current="${p.name === S.name ? 'page' : 'false'}" title="${esc(p.name)}${status ? ` · ${status}` : ''}"><span>${esc(p.name)}</span>${status ? `<small>${status}</small>` : ''}</button>`;
  }).join('') + '<button class="project-add" title="Open another project" aria-label="Open another project">+</button>';
  for (const b of bar.querySelectorAll('[data-project]')) b.onclick = () => { if (b.dataset.project !== S.name) navigate(`/p/${encodeURIComponent(b.dataset.project)}/`); else if (b.classList.contains('waiting')) panel.show(true); };
  bar.querySelector('.project-add').onclick = () => navigate('/');
}
$('#proj').onclick = async () => {
  const list = await linkFetch('/api/projects').then((r) => r.json()).catch(() => []);
  openMenu($('#proj'), [...list.map((p) => ({ label: p.name, hint: p.agents?.some((a) => a.waiting) ? 'waiting for you' : p.agents?.some((a) => a.busy) ? 'working' : p.open ? 'open' : '', cur: p.name === S.name, act: () => { if (p.name !== S.name) navigate(`/p/${encodeURIComponent(p.name)}/`); } })),
    'hr', { label: 'All projects…', hint: 'Ctrl+O', act: () => navigate('/') }]);
};

// ---------- timelines: the project's sequences, as tabs. Each is its own file (timelines/<id>.json), history and viewer,
// sharing the project's code, layers and media; `main` is the default (what master renders) and keeps its name
const TL_API = `/api/projects/${encodeURIComponent(S.name)}/timelines`;
const goTimeline = (id) => navigate(`/p/${encodeURIComponent(S.name)}/${encodeURIComponent(id)}/`);
// (the list: the studio's, which it sends whenever the project's timelines change, from whatever changed them)
async function timelineTabs(list) {
  list ??= await linkFetch(TL_API).then((r) => r.json()).catch(() => []);
  const bar = $('#seqTabs');   // (in the timeline's header, beside its grip and its window button)
  bar.innerHTML = list.map((t) => `<button class="seq${t.id === S.timeline ? ' on' : ''}" data-id="${esc(t.id)}" title="${esc(t.id)} · ${f2(t.duration)} s · ${t.cues} cue${t.cues === 1 ? '' : 's'}${t.id === 'main' ? ' · the project’s default timeline' : ''} — right-click for more">${esc(t.id)}</button>`).join('')
    + '<button class="seq add" id="seqAdd" title="A new timeline, or a copy of this one">+</button>';
  for (const b of bar.querySelectorAll('.seq[data-id]')) {
    b.onclick = () => { if (b.dataset.id !== S.timeline) goTimeline(b.dataset.id); };
    b.oncontextmenu = (e) => { e.preventDefault(); timelineMenu(b, b.dataset.id, { x: e.clientX, y: e.clientY }); };
    b.ondblclick = () => { if (b.dataset.id !== 'main') renameTimeline(b.dataset.id); };
  }
  $('#seqAdd').onclick = () => openMenu($('#seqAdd'), [
    { label: 'New timeline…', hint: 'blank', act: () => askName('New timeline', '', (id) => makeTimeline(id)) },
    { label: `Duplicate “${S.timeline}”…`, act: () => askName(`Duplicate “${S.timeline}”`, `${S.timeline}-copy`, (id) => makeTimeline(id, S.timeline)) }]);
}
function timelineMenu(anchor, id, at) {
  openMenu(anchor, [
    { label: 'Open', disabled: id === S.timeline, act: () => goTimeline(id) },
    { label: 'Duplicate…', act: () => askName(`Duplicate “${id}”`, `${id}-copy`, (to) => makeTimeline(to, id)) },
    { label: 'Rename…', disabled: id === 'main', hint: id === 'main' ? 'the default' : '', act: () => renameTimeline(id) },
    'hr',
    { label: 'Delete…', disabled: id === 'main', act: () => deleteTimeline(id) },
  ], at);
}
async function tlCall(method, url, payload) {
  const r = await linkFetch(url, { method, body: payload ? JSON.stringify(payload) : undefined });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) { toast(b.error || 'That did not work', true); return null; }
  return b;
}
async function makeTimeline(id, from) { const b = await tlCall('POST', TL_API, { id, from }); if (b) goTimeline(b.id); }
function renameTimeline(id) {
  askName(`Rename “${id}”`, id, async (to) => {
    if (to === id) return;
    await tlCall('PATCH', `${TL_API}/${encodeURIComponent(id)}`, { to });   // (this one: the studio closes it, and its editor follows the new name)
  });
}
async function deleteTimeline(id) {
  if (!confirm(`Delete the timeline “${id}”? It stays in the project's history.`)) return;
  await tlCall('DELETE', `${TL_API}/${encodeURIComponent(id)}`);
}
/** Asks for a timeline name (lowercase letters, digits, dashes), then done(name). */
// (ask: what is asked for, other than a timeline's name: its label, hint, and check(v) → why it won't do, or null)
const TIMELINE_NAME = { hint: 'Lowercase letters, digits and dashes (e.g. <code>social-15s</code>).', check: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? null : 'A timeline name is lowercase letters, digits and dashes') };
function askName(title, value, done, ask = TIMELINE_NAME) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<form class="sheet small"><div class="sheet-head"><b>${esc(title)}</b><button type="button" class="link" data-close>Cancel · Esc</button></div>
    <div class="form"><label>${esc(ask.label ?? 'Name')}</label><input name="n" value="${esc(value)}" spellcheck="false" autocomplete="off">
    <span></span><span class="hint">${ask.hint}</span>
    <div class="full row-btns"><button class="btn primary" type="submit">OK</button></div></div></form>`;
  const f = o.querySelector('form'), input = f.elements.n, close = () => o.remove();
  o.onclick = (e) => { if (e.target === o || e.target.dataset.close != null) close(); };
  o.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  f.onsubmit = (e) => {
    e.preventDefault();
    const v = input.value.trim();
    const why = ask.check(v);
    if (why) { toast(why, true); return; }
    close(); done(v);
  };
  document.body.append(o); input.focus(); input.select();
}

// ---------- edits
function newId(prefix) {
  const d = S.doc, ids = [...d.cues.map((q) => q.id), ...d.tracks.map((t) => t.id), ...d.tracks.flatMap((t) => t.clips.map((c) => c.id)), ...(d.overrides ?? []).map((o) => o.id)];
  return prefix + (Math.max(0, ...ids.filter((i) => i.startsWith(prefix)).map((i) => +i.slice(prefix.length) || 0)) + 1);
}
function tidy(d) {
  for (const q of d.cues) { q.t = r6(q.t); q.dur = r6(q.dur); }
  d.cues.sort((a, b) => a.t - b.t);
  for (const tr of d.tracks) { for (const c of tr.clips) for (const k of ['at', 'in', 'out', 'fadeIn', 'fadeOut']) c[k] = r6(c[k] || 0); tr.clips.sort((a, b) => a.at - b.at); }
}
/** Records S.doc (already changed from `before`) as one undoable edit described by `desc`. */
function record(before, desc) {
  followMusic(S.doc);
  tidy(S.doc);
  if (format(S.doc) === format(before)) { docChanged(); return false; }
  S.undo.push({ doc: before, desc }); S.redo.length = 0;
  if (S.undo.length > 500) S.undo.shift();
  S.pending.push(desc);
  docChanged(); scheduleSave();
  return true;
}
function edit(desc, fn) { const before = structuredClone(S.doc); fn(S.doc); return record(before, desc); }
// the music (tools/music.mjs, as the studio heard each song placed): a Detected grid follows it, in the same edit as the
// clip that moved it (the studio does the same with what it is given: tools/nle.mjs)
S.music = {}; S.listening = [];
function followMusic(d) { if (!d.grid?.auto) return; const g = detectedGrid(d, S.music); if (g && !sameGrid(g, d.grid)) d.grid = g; }
async function loadMusic() {
  try { Object.assign(S, await (await linkFetch('api/music')).json()); } catch { return; }
  tl.invalidate(); panels();
}
// where an audio medium is fetched from (a notes medium is played by its instrument, live: audio.js)
const heardUrl = (id, m) => (m.src ? resolve(m.src) : null);
audio.useFiles(resolve);
function undo() {
  const u = S.undo.pop(); if (!u) return toast('Nothing to undo');
  S.redo.push({ doc: S.doc, desc: u.desc }); S.doc = u.doc;
  if (S.pending.at(-1) === u.desc) S.pending.pop(); else S.pending.push(`undo ${u.desc}`);
  docChanged(); scheduleSave(); toast(`Undo: ${u.desc}`);
}
function redo() {
  const r = S.redo.pop(); if (!r) return toast('Nothing to redo');
  S.undo.push({ doc: S.doc, desc: r.desc }); S.doc = r.doc;
  if (S.pending.at(-1) === `undo ${r.desc}`) S.pending.pop(); else S.pending.push(r.desc);
  docChanged(); scheduleSave(); toast(`Redo: ${r.desc}`);
}
// the film as the editor has it, as the viewer's frames are compared with it (anchors.js filmSees): its key, and its
// base, without its overrides (which the film's pages take in as they are: drawn now, before its frames have rendered)
function filmKeys() {
  const fl = followed(S.film);
  S.filmKey = filmSees(S.doc, fl); S.filmBase = filmSees(S.doc, fl, { overrides: false });
}
function docChanged() {
  heard = null;
  filmKeys();
  const ids = new Set([...S.doc.cues.map((q) => q.id), ...S.doc.tracks.flatMap((t) => t.clips.map((c) => c.id))]);
  S.sel = new Set([...S.sel].filter((i) => ids.has(i)));
  scoreAgain(false);
  audio.update(S.doc, heardUrl);
  lanes.sync(); laneCtl(); orphansBtn(); tl.invalidate(); panels(); roll?.invalidate();
  viewport.overrides(liveEdits(strip(S.doc)));
}

// ---------- the film's sound in code: the project's sound.js (engine/score.js), run here against the timeline as it is
// (again on every edit: its motions follow the cues), its motions played with the timeline's own and shown in the lanes
const SOUND = { fn: null, score: null, error: '' };
async function loadSound() {
  const url = `${location.origin}/files/${S.dir}/sound.js`;
  SOUND.fn = null;
  try {
    if ((await linkFetch(url, { method: 'HEAD', cache: 'no-store' })).ok) {
      const fn = (await import(`${url}?v=${Date.now()}`)).default;
      if (typeof fn !== 'function') throw new Error('its default export is not a function of the timeline');
      SOUND.fn = fn;
    }
    SOUND.error = '';
  } catch (e) { soundError(e); }
  scoreAgain();
}
function soundError(e) { const m = `sound.js: ${e.message}`; if (m !== SOUND.error) toast(m); SOUND.error = m; }
/** sound.js run again against the timeline (play: given to the audio at once). */
function scoreAgain(play = true) {
  let sc = null;
  if (SOUND.fn) try { sc = score(SOUND.fn, S.doc, `${location.origin}/files/${S.dir}/`); if (SOUND.error.startsWith('sound.js')) SOUND.error = ''; } catch (e) { soundError(e); sc = SOUND.score; }
  const was = JSON.stringify(SOUND.score);
  SOUND.score = sc;
  audio.setScore(sc, play);
  if (JSON.stringify(sc) !== was) { lanes.sync(); tl.invalidate(); instrumentPanel?.refresh(); }
}
/** The timeline as heard: with the sound code's notes and motions in it (made again once either changes: an edit changes
 *  the doc in place, so it is let go of then, in docChanged and as a drag goes). */
let heard = null;
const heardDoc = () => (heard?.doc === S.doc && heard.sc === SOUND.score ? heard.out : (heard = { doc: S.doc, sc: SOUND.score, out: played(S.doc, SOUND.score) }).out);

// ---------- autosave: one version per burst of edits, never mid-drag
let saveTimer = null, savingTask = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, SAVE_AFTER); saveState(); }
function message(msgs) {
  if (msgs.length <= 3) return msgs.join('; ');
  return `${msgs.length} edits: ${msgs.slice(0, 2).join('; ')}; …\n\n${msgs.map((m) => `- ${m}`).join('\n')}`;
}
function save() { return savingTask ??= saveNow().finally(() => { savingTask = null; }); }
async function saveNow() {
  if (S.dragging || S.saving || S.conflict) { if (!S.conflict) scheduleSave(); return; }
  if (!S.pending.length) return saveState();
  const text = format(S.doc), msgs = S.pending.slice();
  S.saving = true; saveState();
  let res, body;
  try { res = await linkFetch('api/timeline', { method: 'PUT', body: JSON.stringify({ text, base: S.text, message: message(msgs) }) }); body = await res.json(); }
  catch (e) { body = { error: `server unreachable (${e.message})` }; }
  S.saving = false;
  if (res?.status === 410) { closed({ by: body.open }); return; }
  if (res?.status === 409) { conflict(body.text); return; }
  if (body.error) { S.saveError = body.error; if (body.written) S.text = text; saveState(); return; }   // edits stay pending: retried by the next save
  S.saveError = null; S.pending.splice(0, msgs.length);
  if (body.text) adopt(body.text, body.map); else S.text = text;
  if (body.rekey) S.rekeyed = Math.max(S.rekeyed ?? 0, body.rekey);   // (the studio renamed this save as the code moved)
  if (body.version) S.version = body.version;   // the history list refreshes on the server's event
  if (S.rekeyLater) { const ev = S.rekeyLater; S.rekeyLater = null; onRekey(ev); }
  if (S.pending.length) scheduleSave(); else saveState();
}
// the studio's version of the timeline, taken in: what it changed of a save, or of the timeline as the film's code
// moved (anchors.js) — names followed (renamed in the editor's copy and its undo too), and the code each change is on
function adopt(text, map) {
  S.text = text;
  const renamed = map && Object.keys(map).length > 0;
  if (renamed) {
    S.doc = renameSites(S.doc, map);
    for (const u of [...S.undo, ...S.redo]) u.doc = renameSites(u.doc, map);
  }
  const d = JSON.parse(text), code = new Map((d.overrides ?? []).map((o) => [o.id, o.code])), cue = new Map((d.cues ?? []).map((q) => [q.id, q.on?.code]));
  for (const o of S.doc.overrides ?? []) { if (code.get(o.id)) o.code = code.get(o.id); else delete o.code; }
  for (const q of S.doc.cues ?? []) if (q.on) { if (cue.get(q.id)) q.on.code = cue.get(q.id); else delete q.on.code; }
  const regrid = d.grid?.auto && S.doc.grid?.auto && !sameGrid(d.grid, S.doc.grid);   // (the music it heard)
  if (regrid) S.doc.grid = d.grid;
  if (renamed || regrid) docChanged();
}
// the film's code changed under the timeline's changes (the studio followed them, or orphaned them)
function onRekey(ev) {
  if (S.saving) { S.rekeyLater = ev; return; }   // (after the save: it may have taken this in already)
  if (ev.n <= (S.rekeyed ?? 0) || S.text === ev.text) return;
  S.rekeyed = ev.n;
  if (S.text !== ev.before) return onDisk(ev.text);
  adopt(ev.text, ev.map);
  const orphaned = Object.values(ev.map).filter((to) => to.startsWith('orphan:')).length, back = Object.keys(ev.map).filter((k) => k.startsWith('orphan:')).length;
  if (orphaned) toast(`${orphaned === 1 ? 'One of your changes no longer applies because its code was edited' : `${orphaned} of your changes no longer apply because their code was edited`}. See the timeline bar.`);
  else if (back) toast(`${back === 1 ? 'An orphaned change' : `${back} orphaned changes`} found ${back === 1 ? 'its' : 'their'} code again`);
}
function saveState() {
  const el = $('#save'), txt = $('#saveText'), retry = $('#retry');
  retry.hidden = true;
  if (S.conflict) { el.dataset.state = 'conflict'; txt.textContent = 'Changed on disk — choose a version'; }
  else if (S.saveError) { el.dataset.state = 'error'; txt.textContent = S.saveError; el.title = S.saveError; retry.hidden = false; }
  else if (S.saving) { el.dataset.state = 'saving'; txt.textContent = 'Saving…'; }
  else if (S.pending.length || S.dragging) { el.dataset.state = 'pending'; txt.textContent = `Unsaved · ${S.pending.length} edit${S.pending.length === 1 ? '' : 's'}`; }
  else { el.dataset.state = 'saved'; txt.textContent = S.version ? `Saved · version ${S.version}` : 'Saved'; el.title = ''; }
}
$('#retry').onclick = () => { S.saveError = null; save(); };

// outside edits (another tool, or Claude writing notes): reload when nothing is pending, else ask
function onDisk(text) {
  if (text === S.text || text === format(S.doc)) { S.text = text; return; }
  const typing = $('#inspector').contains($('#inspector').ownerDocument.activeElement);
  if (!S.pending.length && !S.dragging && !S.saving && !typing) { const was = S.doc; load(text); presence.changed(was, S.doc); if (S.restoring) S.restoring = null; else toast(`${S.file} changed on disk — reloaded`); return; }
  conflict(text);
}
function load(text) {
  S.text = text; S.doc = JSON.parse(text); S.undo = []; S.redo = []; S.pending = []; S.conflict = null; S.saveError = null;
  clearTimeout(saveTimer); $('#banner').hidden = true; docChanged(); saveState(); loadHistory();
}
// The timeline was renamed or deleted (its editor follows), or the studio shut down. Project navigation never closes it.
function closed({ by, why } = {}) {
  S.closed = true; es.close();
  if (why === 'renamed' || why === 'deleted') { location.href = `/p/${by}/`; return; }
  const b = $('#banner'), me = `${S.name}/${S.timeline}`;
  b.innerHTML = `<span><b>${esc(me)} is closed</b>: ${by ? `${esc(by)} was opened` : 'another timeline was opened'} in the studio.${S.pending.length ? ` ${S.pending.length} unsaved edit${S.pending.length === 1 ? '' : 's'} could not be saved.` : ''}</span><button class="btn" id="reopen">Reopen ${esc(me)}</button>`;
  b.hidden = false;
  $('#reopen').onclick = () => location.reload();
}
function conflict(text) {
  S.conflict = text; S.rekeyLater = null; saveState();
  const b = $('#banner');
  b.innerHTML = `<span><b>${esc(S.file)} changed on disk</b> while you had unsaved edits.</span><button class="btn" id="cDisk">Load the disk version</button><button class="btn" id="cMine">Keep mine (theirs stays in history)</button>`;
  b.hidden = false;
  $('#cDisk').onclick = () => { load(S.conflict); toast('Loaded the disk version'); };
  $('#cMine').onclick = () => { S.text = S.conflict; S.conflict = null; b.hidden = true; if (!S.pending.length) S.pending.push('keep editor version over outside edit'); save(); };
}

// ---------- history: the project's versions (each its timelines and code together), newest first; one is shown in the
// Code panel (what it changed), and restoring it brings the whole project back to it, as a version of its own
async function loadHistory() {
  try { S.history = await (await linkFetch('api/history')).json(); } catch { return; }
  showHistory();
}
// (a version kept: its row, from the studio's event, put at the top — the list fetched again where one was missed)
function versionKept(h) {
  if (h && S.history[0]?.n === h.n - 1) { S.history.unshift(h); showHistory(); } else loadHistory();
}
function showHistory() {
  S.version = S.history[0]?.n ?? S.version;
  const el = $('#historyList');
  el.className = 'list';
  el.innerHTML = S.history.length ? '' : '<div class="empty">No versions yet.</div>';
  const short = (f) => f.replace(/^timelines\//, '');
  for (const [i, h] of S.history.entries()) {
    const row = document.createElement('div'), files = [...h.changed.map(short), ...h.added.map((f) => `+${short(f)}`), ...h.removed.map((f) => `−${short(f)}`)];
    row.className = `row${i === 0 ? ' head' : ''}`;
    row.title = `${h.message}\n\n${files.join(', ')}\n\nClick to see what this version changed (and restore it); right-click to tag it`;
    row.innerHTML = `<span class="msg">${(h.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}${esc(h.message.split('\n')[0])}</span><span class="when">${esc(when(h.at))}</span><span class="sha">${h.n} · ${esc(files.join(', '))}</span>`;
    row.onclick = () => { codePanel.showVersion(h); layout.reveal('code'); };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      openMenu(row, [
        { label: 'Show what it changed', act: () => row.onclick() },
        { label: 'Tag…', act: () => askName(`Tag version ${h.n}`, '', (name) => tagVersion(h.n, name), TAG_NAME) },
        ...(h.tags ?? []).map((t) => ({ label: `Remove the tag \u201c${t}\u201d`, act: () => tagVersion(h.n, t, true) })),
        'hr',
        { label: i === 0 ? 'Restore (it is the current version)' : 'Restore this version', disabled: i === 0, act: () => restoreVersion(h.n) },
      ], { x: e.clientX, y: e.clientY });
    };
    el.append(row);
  }
  saveState();
}
// (the editor's edits saved first, so that they are in the version kept before the restore)
async function restoreVersion(n) {
  clearTimeout(saveTimer);
  if (S.pending.length || S.saving) { while (S.saving) await new Promise((r) => setTimeout(r, 50)); await save(); }
  if (S.pending.length) { toast('Your edits could not be saved, so nothing was restored', true); return; }
  S.restoring = n;
  const r = await linkFetch('api/restore', { method: 'POST', body: JSON.stringify({ n }) }), b = await r.json().catch(() => ({}));
  if (!r.ok) { S.restoring = null; toast(b.error ?? 'Could not restore it', true); return; }
  toast(b.version ? `Restored version ${n}. To undo it, restore version ${b.version - 1}` : `The project already is as version ${n} keeps it`);
}
// a version tagged, as git tags one (name; history.mjs tag), or a tag taken away (remove); a name on another version
// moves here once the director says so
const TAG_NAME = { label: 'Tag', hint: 'A name for this version, as a git tag (e.g. <code>sent-to-client</code>): no spaces.', check: (v) => (!v || /[\s~^:?*[\\]/.test(v) || v.startsWith('-') || /^\d+$/.test(v) ? 'A tag has no spaces or ~^:?*[\\, doesn\u2019t start with -, and isn\u2019t a number' : null) };
async function tagVersion(n, name, remove = false, force = false) {
  const r = await linkFetch('api/tags', { method: 'POST', body: JSON.stringify({ n, name, remove, force }) }), b = await r.json().catch(() => ({}));
  if (r.ok) { toast(remove ? `Removed the tag \u201c${name}\u201d` : `Tagged version ${n} \u201c${name}\u201d`); return loadHistory(); }
  const on = /is on version (\d+)/.exec(b.error ?? '')?.[1];
  if (on && confirm(`\u201c${name}\u201d is on version ${on}. Move it to version ${n}?`)) return tagVersion(n, name, false, true);
  if (!on) toast(b.error ?? 'Could not tag it', true);
}
function when(iso) {
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString() ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

// ---------- selection & actions. The studio has one selection (docs/selection.md): the thing in the viewer (O.sel), the
// timeline's cues and clips (S.sel), a property, lane, key or move in the motion lanes (lanes.selected()), the piano
// roll's notes. A click replaces all of it; Shift or Ctrl adds to it; selecting a lane selects its thing
function select(id, mode) {
  // (an added thing's clip is the thing: selected as it is, keeping the playhead)
  const added = id != null && addedClips(S.doc).find((c) => c.id === id);
  if (added) { if (mode !== 'toggle') S.sel = new Set([id]); selectObject(objectOfClip(added), S.t, false, mode === 'toggle'); return; }
  if (id != null) lanes.clear();
  if (id == null) S.sel = new Set();
  else if (mode === 'toggle') { S.sel = new Set(S.sel); S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); }
  else { S.sel = new Set([id]); dropThing(); linesOff(); }
  tl.invalidate(); panels();
}
// nothing selected, anywhere
function selectNone() { S.sel = new Set(); lanes.clear(); dropThing(); linesOff(); tl.invalidate(); panels(); }
// the lines selected in the Code panel ({ file, from, to }), in place of the rest of the selection, with the thing they
// place (an object one of them places); null: none selected there now
let codeSel = null;
const siteLine = (at) => { const m = /^(.*?):(\d+)(?::\d+)?$/.exec(at ?? ''); return m ? { file: m[1], line: +m[2] } : null; };
function selectLines(x) {
  codeSel = x;
  if (!x) return panels();
  S.sel = new Set(); lanes.clear();
  const os = OBJ.list.filter((ob) => ob.sites.some((at) => { const l = siteLine(at); return l?.file === x.file && l.line >= x.from && l.line <= x.to; }));
  if (!os.length) dropThing();
  else if (os.some((o, i) => objectOf((i ? O.also[i - 1] : O.sel)?.at) !== o) || O.also.length !== os.length - 1) {
    // (several: the first, then each other with it, at the moment the first is found)
    selectObject(os[0], null, true).then(async () => { for (const o of os.slice(1)) await selectObject(o, S.t, true, true); });
  }
  tl.invalidate(); panels();
}
// something else selected in place of the code's lines: they are no longer selected there
function linesOff() { if (!codeSel) return; codeSel = null; codePanel.unselect(); }
// the thing in the viewer, no longer selected (with what else is selected left as it is)
function dropThing() {
  if (!O.sel) return;
  dropAddedClips();
  O.sel = O.now = O.show = null; O.also = []; O.alsoNow = []; pickChip(null); tl.relayout(); paintObjects();
}
// (the clips of the added things selected, out of the selection with them)
function dropAddedClips(list = [O.sel, ...O.also]) { const off = new Set(list.map((x) => x?.clip).filter(Boolean)); if (off.size) S.sel = new Set([...S.sel].filter((id) => !off.has(id))); }
// Esc: one level out. Keys, moves, a lane or a property to their thing (the clip, for an instrument's); a copy of an
// object of many to the object whole; a thing to nothing
function stepOut() {
  if (codeSel) { linesOff(); return panels(); }
  const s = lanes.selected();
  if (s?.th.startsWith('inst:') || (s && (s.k || s.v) && s.th === 'sel')) { lanes.clear(); tl.relayout(); return panels(); }
  if (s && (s.k || s.v)) return lanes.select({ th: s.th });
  if (s) { lanes.clear(); if (s.th === 'sel' && O.sel) return escapeObject(); tl.relayout(); return panels(); }
  if (O.sel) return escapeObject();
  select(null);
}
function seek(t) {
  S.t = Math.max(0, Math.min(t, S.end() + 30)); L.moved = performance.now();
  audio.seek(S.t); tl.moved();
}
function addCue(t) {
  const id = newId('q');
  edit(`add cue at ${f2(t)}`, (d) => d.cues.push({ id, t: r6(t), dur: 0, label: '', note: '' }));
  S.sel = new Set([id]); tl.invalidate(); panels();
  return id;
}
function setCueLabel(id, v) {
  const q = S.doc.cues.find((x) => x.id === id);
  edit(`label cue ${q.label ? `"${q.label}"` : `at ${f2(q.t)}`} → "${v}"`, (d) => { d.cues.find((x) => x.id === id).label = v; });
}
function openCue(id) {
  select(id);
  const i = $('#inspector input[name=label]');
  if (i) { i.focus(); i.select(); }
}
const clipsAll = () => S.doc.tracks.flatMap((track) => track.clips.map((clip) => ({ clip, track })));
let timelineClipboard = null;
const timelineCount = (n) => `${n} item${n === 1 ? '' : 's'}`;
function selectedTimeline() {
  return {
    cues: S.doc.cues.filter((q) => S.sel.has(q.id)),
    clips: clipsAll().filter(({ clip }) => S.sel.has(clip.id)),
  };
}
function copyTimelineSelection(cut = false) {
  const { cues, clips } = selectedTimeline(), times = [...cues.map((q) => q.t), ...clips.map(({ clip }) => clip.at)];
  if (!times.length) return false;
  const t0 = Math.min(...times);
  timelineClipboard = {
    cues: cues.map((cue) => ({ cue: structuredClone(cue), dt: r6(cue.t - t0) })),
    clips: clips.map(({ clip, track }) => ({ clip: structuredClone(clip), trackId: track.id, trackIndex: S.doc.tracks.indexOf(track), visual: isVisual(track), dt: r6(clip.at - t0), changes: clip.thing ? thingChanges(S.doc, clip.id, clip.id) : [] })),
  };
  const count = cues.length + clips.length;
  if (cut) {
    if (deleteSelection()) toast(`Cut ${timelineCount(count)}`);
    else timelineClipboard = null;
  } else toast(`Copied ${timelineCount(count)}`);
  return true;
}
function pasteTimelineSelection() {
  if (!timelineClipboard) return false;
  const at = r6(Math.max(0, S.t)), used = new Set([
    ...S.doc.cues.map((q) => q.id), ...S.doc.tracks.map((t) => t.id), ...clipsAll().map(({ clip }) => clip.id), ...(S.doc.overrides ?? []).map((o) => o.id),
  ]);
  const fresh = (prefix) => { let n = 1, id; do { id = `${prefix}${n++}`; } while (used.has(id)); used.add(id); return id; };
  const trackFor = (item) => S.doc.tracks.find((t) => t.id === item.trackId && isVisual(t) === item.visual)
    ?? (S.doc.tracks[item.trackIndex] && isVisual(S.doc.tracks[item.trackIndex]) === item.visual ? S.doc.tracks[item.trackIndex] : null)
    ?? S.doc.tracks.find((t) => isVisual(t) === item.visual);
  const cues = timelineClipboard.cues.map(({ cue, dt }) => ({ ...structuredClone(cue), id: fresh('q'), t: r6(at + dt) }));
  const clips = timelineClipboard.clips.map((item) => {
    const track = trackFor(item);
    return track ? { ...structuredClone(item.clip), id: fresh('c'), at: r6(at + item.dt), trackId: track.id, from: item.clip.id, changes: item.changes } : null;
  }).filter(Boolean);
  if (!cues.length && !clips.length) return toast('Nothing to paste: the original tracks are gone', true), false;
  const ids = [...cues.map((q) => q.id), ...clips.map((c) => c.id)];
  edit(`paste ${timelineCount(ids.length)} at ${f2(at)}`, (d) => {
    d.cues.push(...cues);
    for (const { trackId, from, changes, ...c } of clips) {
      d.tracks.find((t) => t.id === trackId)?.clips.push(c);
      if (changes?.length) (d.overrides ??= []).push(...thingChanges({ overrides: changes }, from, c.id));
    }
  });
  S.sel = new Set(ids); lanes.clear(); tl.invalidate(); panels(); tl.reveal(at);
  toast(`Pasted ${timelineCount(ids.length)}`);
  return true;
}
function selectAllTimeline() {
  const ids = [...S.doc.cues.map((q) => q.id), ...clipsAll().map(({ clip }) => clip.id)];
  if (!ids.length) return false;
  S.sel = new Set(ids); lanes.clear(); tl.invalidate(); panels();
  return true;
}
// the selected clips and cues again, right after themselves (FL's Ctrl+B): each later by how long the selection lasts (a
// bar, where it lasts no time: cues alone); the copies selected
function duplicateSelection() {
  const { cues, clips } = selectedTimeline();
  if (!cues.length && !clips.length) return false;
  const a = Math.min(...clips.map(({ clip }) => clip.at), ...cues.map((q) => q.t)), b = Math.max(...clips.map(({ clip }) => clipEnd(clip)), ...cues.map((q) => q.t + q.dur));
  const dt = r6(b > a + 1e-6 ? b - a : partAt(gridParts(grid()), a).bar);
  let nc = +newId('c').slice(1), nq = +newId('q').slice(1);
  const copies = [...clips.map(({ clip, track }) => ({ track: track.id, item: { ...structuredClone(clip), id: `c${nc++}`, at: r6(clip.at + dt) } })), ...cues.map((q) => ({ cue: { ...structuredClone(q), id: `q${nq++}`, t: r6(q.t + dt) } }))];
  edit(`duplicate ${timelineCount(copies.length)} after themselves`, (d) => {
    for (const c of copies) if (c.cue) d.cues.push(c.cue); else d.tracks.find((t) => t.id === c.track)?.clips.push(c.item);
    clips.forEach(({ clip }, i) => { if (clip.thing) (d.overrides ??= []).push(...thingChanges(d, clip.id, copies[i].item.id)); });
  });
  S.sel = new Set(copies.map((c) => (c.cue ?? c.item).id)); lanes.clear(); tl.invalidate(); panels(); tl.reveal(a + dt);
  return true;
}
// every clip and cue not selected selected, and the rest not (FL's Shift+I)
function invertSelection() {
  const ids = [...S.doc.cues.map((q) => q.id), ...clipsAll().map(({ clip }) => clip.id)];
  S.sel = new Set(ids.filter((i) => !S.sel.has(i))); lanes.clear(); tl.invalidate(); panels();
}
// notes clips each given a pattern of their own (FL's Make unique): a copy of the one they play — its notes as heard (those
// its sound code writes, with the director's edits) and its own motion — so that a change to one leaves the clips that
// played it with it
function makeUnique(ids) {
  const picked = clipsAll().filter(({ clip }) => ids.includes(clip.id) && isNotes(S.doc.media[clip.media]));
  if (!picked.length) return;
  const heard = heardDoc();
  edit(`make ${picked.length === 1 ? `"${picked[0].clip.media}"` : `${picked.length} clips`} unique`, (d) => {
    for (const { clip, track } of picked) {
      const old = clip.media, m = d.media[old], names = new Set(Object.values(d.media).map((x) => x.name));
      let n = 2, id, name;
      do { id = `${old}-${n++}`; } while (d.media[id]);
      n = 2;
      do { name = `${m.name ?? old} ${n++}`; } while (names.has(name));
      const copy = { ...structuredClone(m), name, notes: structuredClone(heard.media[old]?.notes ?? m.notes) };
      delete copy.removed;
      d.media[id] = copy;
      const tr = d.tracks.find((t) => t.id === track.id);
      tr.clips.find((c) => c.id === clip.id).media = id;
    }
  });
}
function split() {
  const t = r6(S.t), under = clipsAll().filter(({ clip }) => clip.at + 0.002 < t && clipEnd(clip) - 0.002 > t);
  // (nothing selected: the clips under the playhead, but not the things added by hand, which last the film)
  const chosen = under.some(({ clip }) => S.sel.has(clip.id)) ? under.filter(({ clip }) => S.sel.has(clip.id)) : under.filter(({ clip }) => !clip.thing);
  if (!chosen.length) return toast('No clip under the playhead');
  const ids = chosen.map(({ clip }) => clip.id);
  edit(chosen.map(({ clip }) => `split "${clip.thing?.label ?? clip.media}" at ${f2(t)}`).join('; '), (d) => {
    let n = +newId('c').slice(1);
    for (const tr of d.tracks) for (const c of [...tr.clips]) {
      if (!ids.includes(c.id)) continue;
      const cut = c.in + (t - c.at) * speedOf(c), id = `c${n++}`;
      tr.clips.push({ ...structuredClone(c), id, at: t, in: cut, ...(c.thing ? {} : { fadeIn: 0 }) });
      if (c.thing) (d.overrides ??= []).push(...thingChanges(d, c.id, id));
      c.out = cut; if (!c.thing) c.fadeOut = 0;
    }
  });
}
/** Whether the film reads this cue by its name: elements/cues.js reports them. */
const filmUses = (id) => S.film.cues.some((c) => c.id === id);
function deleteSelection() {
  const keys = lanes.deletion();   // (the keys and moves chosen in the lanes: with the clips and cues, one step)
  if (lanes.selected() && !keys) { lanes.deleteChosen(); return true; }   // (a lane chosen: Delete is its, not its clip's)
  const selected = selectedTimeline();
  if (!keys && !selected.cues.length && !selected.clips.length) return false;
  const used = selected.cues.filter((q) => filmUses(q.id));
  if (used.length && !confirm(`The project is timed to ${used.length === 1 ? 'this cue' : 'these cues'} (${used.map((q) => q.label || q.id).join(', ')}). Delete anyway?`)) return false;
  const descs = [];
  for (const q of selected.cues) descs.push(`delete cue ${q.label ? `"${q.label}" ` : ''}at ${f2(q.t)}`);
  for (const { clip } of selected.clips) descs.push(`delete "${clip.thing?.label ?? clip.media}" ${f2(clip.at)}–${f2(clipEnd(clip))}`);
  if (keys) descs.push(keys.desc);
  const sel = S.sel, gone = new Set(selected.clips.filter(({ clip }) => clip.thing).map(({ clip }) => `clip:${clip.id}`));
  // (an added thing goes with what was changed on it)
  const changed = edit(descs.join('; '), (d) => { keys?.fn(d); d.cues = d.cues.filter((q) => !sel.has(q.id)); for (const tr of d.tracks) tr.clips = tr.clips.filter((c) => !sel.has(c.id)); if (gone.size && d.overrides) d.overrides = d.overrides.filter((o) => !gone.has(o.on?.at)); });
  if (gone.has(O.sel?.at) || O.also.some((x) => gone.has(x.at))) dropThing();
  S.sel = new Set(); if (keys) lanes.clear(); panels();
  return changed;
}
function setTempoMaster(id) {
  const tr = S.doc.tracks.find((t) => t.id === id);
  if (!tr || isVisual(tr)) return;
  const p = partAt(gridParts(grid()), S.t), base = { bpm: +p.bpm.toFixed(3), offset: +barMod(p).toFixed(4), beatsPerBar: p.beatsPerBar };
  if (S.doc.grid?.track === id) {
    edit(`use base tempo instead of "${tr.name}"`, (d) => { d.grid = base; });
    return;
  }
  edit(`make "${tr.name}" the tempo master`, (d) => { d.grid = { ...base, auto: true, track: id }; });
}
function timelineTrackMenu(track, head) {
  const items = [], master = S.doc.grid?.auto && S.doc.grid?.track === track.id;
  if (!isVisual(track)) items.push({ label: 'Tempo master', hint: master ? 'drives the tempo grid' : 'use this track for the grid', checked: master, act: () => setTempoMaster(track.id) });
  if (head) items.push('hr', { label: 'Rename…', hint: 'double-click the name', act: () => renameTrack(track.id, head.querySelector('.name')) });
  items.push({ label: 'Remove track', hint: 'undo with Ctrl+Z', act: () => removeTrack(track.id) });
  return items;
}
function timelineItemMenu(h) {
  const id = (h.clip || h.cue).id, items = [
    ...(h.clip?.thing ? [{ label: 'Focus', hint: 'F', act: focusSelection }, { label: 'Rename…', act: () => renameAdded(objectOfClip(h.clip)) }, { label: objectHidden(objectOfClip(h.clip)) ? 'Show' : 'Hide', hint: 'H', act: () => toggleHidden(objectOfClip(h.clip)) }, 'hr'] : []),
    { label: 'Copy', hint: 'Ctrl+C', act: () => copyTimelineSelection() },
    { label: 'Cut', hint: 'Ctrl+X', act: () => copyTimelineSelection(true) },
    ...(h.clip?.thing ? [{ label: 'Duplicate', hint: 'Shift+D', act: duplicateThings }, { label: 'Repeat after itself', hint: 'Ctrl+B', act: () => duplicateSelection() }] : [{ label: 'Duplicate', hint: 'Ctrl+B', act: () => duplicateSelection() }]),
  ];
  // a notes clip: its pattern its own (the selection's notes clips, where it is in it); not where no other clip plays it
  if (h.clip && isNotes(S.doc.media[h.clip.media])) {
    const ids = S.sel.has(id) ? [...S.sel] : [id], shared = clipsAll().filter(({ clip }) => ids.includes(clip.id) && isNotes(S.doc.media[clip.media]) && clipsAll().some((o) => o.clip.media === clip.media && o.clip.id !== clip.id));
    items.push('hr', { label: 'Make unique', hint: shared.length ? '' : 'no other clip plays it', disabled: !shared.length, act: () => makeUnique(shared.map(({ clip }) => clip.id)) });
  }
  if (h.kind === 'cue') items.push({ label: 'Rename…', act: () => openCue(id) });
  items.push('hr', { label: 'Delete', hint: 'Del', act: () => { lanes.clear(); deleteSelection(); } });   // (the clip's menu: the clip, whatever lane is chosen)
  return items;
}
// a track heard (audio) or seen (pictures: images, videos), asked which
function addTrack() {
  openMenu($('#addTrack'), [
    { label: 'Audio track', hint: 'sounds', act: () => { const id = newId('a'), name = `Audio ${S.doc.tracks.filter((t) => !isVisual(t)).length + 1}`; edit(`add track "${name}"`, (d) => d.tracks.push({ id, name, clips: [] })); } },
    { label: 'Pictures track', hint: 'images, video', act: () => { const id = newId('v'), name = `Pictures ${S.doc.tracks.filter(isPictures).length + 1}`; edit(`add track "${name}"`, (d) => d.tracks.push({ id, name, kind: 'visual', clips: [] })); } },
  ]);
}
// a clip of notes (four bars at the playhead) on the selected audio track, opened in the piano roll: played by the track's
// instrument (a track that has none is given Vial's pluck)
function addNotes() {
  const d = S.doc, picked = clipsAll().find(({ clip }) => S.sel.has(clip.id))?.track, track = picked && !isVisual(picked) ? picked : d.tracks.filter((t) => !isVisual(t)).at(-1);
  let n = 1; while (d.media[`notes${n}`]) n++;
  const mid = `notes${n}`, name = `Notes ${n}`, cid = newId('c'), tid = track?.id ?? newId('a'), len = r6(partAt(gridParts(grid()), S.t).bar * 4), at = r6(S.t);
  edit(`add notes clip "${name}"`, (x) => {
    x.media[mid] = { kind: 'audio', name, notes: [], length: len };
    if (!track) x.tracks.push({ id: tid, name: 'Audio 1', clips: [] });
    const tr = x.tracks.find((t) => t.id === tid);
    tr.instrument ??= { ...DEFAULT_INSTRUMENT };
    tr.clips.push({ id: cid, media: mid, at, in: 0, out: len, gain: 0, fadeIn: 0, fadeOut: 0 });
  });
  S.sel = new Set([cid]); tl.invalidate(); panels(); roll.show(cid); layout.reveal('pianoroll');
}
function removeTrack(id) {
  const tr = S.doc.tracks.find((t) => t.id === id), p = partAt(gridParts(grid()), S.t), base = { bpm: +p.bpm.toFixed(3), offset: +barMod(p).toFixed(4), beatsPerBar: p.beatsPerBar };
  edit(`remove track "${tr.name}"${tr.clips.length ? ` (${tr.clips.length} clip${tr.clips.length > 1 ? 's' : ''})` : ''}`, (d) => {
    d.tracks = d.tracks.filter((t) => t.id !== id);
    if (d.grid?.track === id) d.grid = base;
  });
}
// a kind's tracks (what is seen, or what is heard) in a new order (`ids`, as the timeline keeps them), in the places they
// had among the others
function reorderTracks(ids, moved, way) {
  const tr = S.doc.tracks.find((t) => t.id === moved);
  edit(`move track "${tr?.name ?? moved}" ${way}`, (d) => {
    const kind = new Set(ids), by = new Map(d.tracks.map((t) => [t.id, t]));
    let i = 0;
    d.tracks = d.tracks.map((t) => (kind.has(t.id) ? by.get(ids[i++]) : t));
  });
}
function renameTrack(id, el) {
  const tr = S.doc.tracks.find((t) => t.id === id), input = document.createElement('input');
  input.value = tr.name; el.textContent = ''; el.append(input); input.focus(); input.select();
  let done = false;
  const finish = (ok) => {
    if (done) return; done = true;
    const v = input.value.trim();
    el.textContent = tr.name;
    if (ok && v && v !== tr.name) edit(`rename track "${tr.name}" → "${v}"`, (d) => { d.tracks.find((t) => t.id === id).name = v; });
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); };
  input.onblur = () => finish(true);
}
function setRange(a, b) {
  S.range = a == null ? null : { a: r6(a), b: r6(b) };
  remember({ range: S.range }); tl.invalidate(); rangeChip();
}
function rangeChip() {
  $('#rangeChip').hidden = !S.range;
  if (S.range) $('#rangeText').textContent = `${f2(S.range.a)} – ${f2(S.range.b)} s`;
  $('#renderLabel').textContent = S.range ? 'Render in/out' : 'Render draft';
}
$('#rangeClear').onclick = () => setRange(null);

// ---------- panels: inspector, cue list
const grid = () => S.doc.grid || { bpm: 120, offset: 0, beatsPerBar: 4 };
function barBeat(t) {   // zero-based bar.beat.sixteenth, like tempo(TL.grid).b(bar, beat, six) in the project code
  const { bar, beat } = position(grid(), t);
  return `${bar}.${Math.floor(beat)}.${Math.floor((beat - Math.floor(beat)) * 4)}`;
}
const barMod = (p) => ((p.line % p.bar) + p.bar) % p.bar;   // (a part's bar lines as one tempo's offset: where bar 0 would start)
// what the grid is following, in words (the inspector's)
function gridWords() {
  const g = grid(), song = (id, sp) => `${esc(id)}${sp && sp !== 1 ? ` at ${sp}×` : ''}`, master = g.track && S.doc.tracks.find((t) => t.id === g.track);
  if (!g.auto) return 'One tempo for the whole timeline.';
  const listening = S.listening.length ? ` Listening to ${S.listening.map(esc).join(', ')}…` : '';
  const source = master ? `Tempo master “${esc(master.name)}”` : g.track ? `Tempo master track “${esc(g.track)}” is missing` : 'Detected from the music';
  if (!g.media) return `${source}: no steady beat yet.${listening}`;
  const ps = g.map ?? [g], songs = [...new Set(ps.map((p) => song(p.media, p.speed)))].join(', ');
  return `${source}: ${songs}${ps.length > 1 ? `, ${ps.length} tempos` : ''}.${listening}`;
}
let mixer = null, instrumentPanel = null;   // (the Mixer and Instrument panels, made below)
function panels() {
  if (O.sel?.added && !objectOf(O.sel.at)) dropThing();   // (an added thing undone away, or removed by another hand)
  inspector(); cueList(); mixer?.render(); instrumentPanel?.refresh(); pushMenus();
  // (how many are selected besides what the inspector shows: what is selected, not what owns it)
  const ls = lanes.selected(), deep = lanes.picked() || (ls && (ls.k || ls.v) ? 1 : 0);
  const addedHere = [O.sel, ...O.also].filter((x) => x?.clip && S.sel.has(x.clip)).length;   // (a thing and its clip are one)
  const n = S.sel.size - addedHere + (roll?.selectedCount() ?? 0) + deep + (!deep && (O.sel || (ls && !ls.th.startsWith('inst:'))) ? 1 : 0) + (codeSel ? 1 : 0) + O.also.length;
  codePanel.mark([O.sel, ...O.also].filter(Boolean).flatMap((x) => x.sites ?? (x.at ? [x.at] : [])));   // (the selected things' lines, marked in the code)
  $('#inspTitle').dataset.more = n > 1 ? ` · ${n - 1} more selected` : '';
  const cam = ls?.th === 'camera';   // (the film camera selected: drawn so in the director's view)
  if (cam !== D.camSel) { D.camSel = cam; if (D.view === 'director' && D.img) paintDirector(); paintObjects(); }
}
$('#inspector').addEventListener('focusout', () => setTimeout(() => { if ($('#inspector').dataset.stale) inspector(); }));

function inspector() {
  const el = $('#inspector'), title = $('#inspTitle'), a = el.ownerDocument.activeElement;
  // don't rebuild a field being typed in (but rebuild once it is left)
  if (el.contains(a) && a.matches('input, textarea, select') && el.dataset.for === [...S.sel].join()) { el.dataset.stale = '1'; return; }
  el.dataset.for = [...S.sel].join(); el.dataset.stale = '';
  el.onclick = el.onchange = null;
  // (an added thing selected is shown as a thing, not as its clip)
  const addedOn = new Set([O.sel, ...O.also].map((x) => x?.clip).filter(Boolean));
  const cues = S.doc.cues.filter((q) => S.sel.has(q.id)), clips = clipsAll().filter(({ clip }) => S.sel.has(clip.id) && !addedOn.has(clip.id));
  // (one added thing's clip selected, its thing not yet: selected as a thing)
  if (!cues.length && clips.length === 1 && clips[0].clip.thing) { selectObject(objectOfClip(clips[0].clip), S.t); return; }
  // a motion lane, property or the camera, selected in the timeline (or a lane of the selected clip's instrument)
  const lane = lanes.selected();
  if (lane && !cues.length && (!clips.length || lane.th.startsWith('inst:')) && lanes.inspector(el, title)) { el.dataset.obj = ''; return; }
  if (!O.sel || cues.length || clips.length) el.dataset.obj = '';
  const num = (name, v, step = 0.01, extra = '') => `<input type="number" name="${name}" value="${+(+v).toFixed(4)}" step="${step}" ${extra}>`;
  if (cues.length + clips.length > 1) {
    title.textContent = 'Selection';
    el.innerHTML = `<div class="form"><span class="full">${cues.length ? `${cues.length} cue${cues.length > 1 ? 's' : ''}` : ''}${cues.length && clips.length ? ', ' : ''}${clips.length ? `${clips.length} ${clips.every(({ clip }) => clip.thing) ? 'thing' : 'clip'}${clips.length > 1 ? 's' : ''}` : ''} selected</span>
      <div class="full row-btns"><button class="btn danger" data-act="delete">Delete</button></div></div>`;
  } else if (cues.length) {
    const q = cues[0];
    title.textContent = 'Cue';
    const uses = filmUses(q.id);
    el.innerHTML = `<div class="insp-title"><span class="sw" style="background:var(--cue)"></span><b>${esc(q.label || 'Untitled cue')}</b><span>bar ${barBeat(q.t)}</span>${uses ? '<span class="film-uses" title="Part of the project is timed to this cue, so moving the cue moves that part.">project uses this</span>' : ''}</div>
      <div class="form">
        <label>Label</label><input name="label" value="${esc(q.label)}" placeholder="e.g. drop" spellcheck="false">
        <label>Name</label><input name="id" value="${esc(q.id)}" spellcheck="false" title="What the project calls this cue (lowercase, digits, dashes)">
        ${uses ? `<span></span><span class="hint">The project refers to this cue by name. If you rename it, the project's code has to be updated too.</span>` : ''}
        <label>Time</label><div class="pair">${num('t', q.t, 0.01, 'min="0"')}<span class="ro">s</span></div>
        <label>Length</label><div class="pair">${num('dur', q.dur, 0.01, 'min="0"')}<span class="ro">s</span></div>
        ${q.dur ? `<span></span><span class="hint">${f2(q.t)}–${f2(q.t + q.dur)} s · bar ${barBeat(q.t)} to ${barBeat(q.t + q.dur)}</span>` : ''}
        <label class="full">Note</label><textarea class="full" name="note" rows="5" placeholder="${q.on ? 'What should change about it — a note your agent reads' : 'What should happen here — notes for the project'}" spellcheck="true">${esc(q.note)}</textarea>
        ${q.on ? `<label>On</label><span class="ro">${esc(q.on.label || q.on.kind)}${q.on.sites ? ' · every copy' : q.on.copy != null ? ` · copy ${q.on.copy + 1}` : ''} · <button class="link" data-act="selectOn" title="Select it in the viewer">${esc((q.on.at ?? q.on.sites?.[0] ?? '').replace(/:\d+$/, ''))}</button></span>` : ''}
        <div class="full row-btns"><button class="btn" data-act="seek">Go to</button><button class="btn danger" data-act="delete">Delete</button></div>
      </div>`;
  } else if (clips.length) {
    const { clip: c, track } = clips[0], m = audio.get(c.media), dur = m?.buffer?.duration;
    title.textContent = 'Clip';
    el.innerHTML = `<div class="insp-title"><span class="sw" style="background:${trackColour(S.doc.tracks.indexOf(track)).top}"></span><b>${esc(c.media)}</b><span title="${esc(S.doc.media[c.media]?.src || '')}">${esc(S.doc.media[c.media]?.src || '')}</span></div>
      <div class="form">
        <label>Track</label><select name="track">${S.doc.tracks.map((t) => `<option value="${t.id}" ${t.id === track.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        <label>Start</label><div class="pair">${num('at', c.at, 0.01, 'min="0"')}<span class="ro">s · ends ${f2(clipEnd(c))}</span></div>
        <label>Source</label><div class="pair">${num('in', c.in, 0.01, 'min="0"')}<span class="ro">→</span>${num('out', c.out, 0.01, `min="0" ${dur ? `max="${dur}"` : ''}`)}</div>
        <label>Speed</label><div class="pair">${num('speed', speedOf(c), 0.01, 'min="0.25" max="4"')}<span class="ro">× · ${(12 * Math.log2(speedOf(c)) >= 0 ? '+' : '') + (12 * Math.log2(speedOf(c))).toFixed(1)} semitones</span></div>
        <label>Gain</label><div class="pair"><input type="range" name="gainR" min="-30" max="12" step="0.5" value="${c.gain || 0}">${num('gain', c.gain || 0, 0.5, 'style="width:62px"')}<span class="ro">dB</span></div>
        <label>Fade in</label><div class="pair">${num('fadeIn', c.fadeIn || 0, 0.01, 'min="0"')}<span class="ro">s</span></div>
        <label>Fade out</label><div class="pair">${num('fadeOut', c.fadeOut || 0, 0.01, 'min="0"')}<span class="ro">s</span></div>
        ${notesFields(c.media)}${tempoFields(c, track, num)}
        <div class="full row-btns"><button class="btn danger" data-act="delete">Delete</button></div>
      </div>`;
  } else if (O.sel) {
    return objectInspector(el, title);
  } else {
    const g = grid(), gp = partAt(gridParts(g), S.t);   // (where the music sets it, the part at the playhead)
    title.textContent = 'Timeline';
    const film = S.page !== 'music';   // (the Music page: the tempo alone)
    const open = (id) => (!film && id === 'music') || !inspClosed.has(id), caret = icon('caret-right', false, 'car');
    const sect = (id, ic, name, body, over = false) => `<section class="sect"><button class="sect-h${over ? ' ov' : ''}" data-sect="${id}" aria-expanded="${open(id)}">${caret}${icon(ic, false, 'sic')}<span>${name}</span>${over ? '<span class="dot"></span>' : ''}</button><div class="sect-b form"${open(id) ? '' : ' hidden'}>${body}</div></section>`;
    const grp = (id, ic, name, sw, body, off = false, tip = '') => { const over = Object.keys(S.doc.rendering?.[id] ?? {}).length > 0;
      return `<div class="grp"><button class="grp-t${over ? ' ov' : ''}" data-sect="${id}" aria-expanded="${open(id)}"${tip ? ` title="${tip}"` : ''}>${caret}${icon(ic, false, 'sic')}<span>${name}</span></button>${sw || '<span></span>'}<div class="grp-b form${off ? ' off' : ''}"${open(id) ? '' : ' hidden'}>${body}</div></div>`; };
    const overridden = Object.values(S.doc.rendering ?? {}).some((o) => Object.keys(o).length);
    el.innerHTML = `<div class="sects">
      ${sect('music', 'music-notes', 'Music', `<label>Tempo grid</label><select name="gridFrom"><option value="auto" ${g.auto ? 'selected' : ''}>Detected from the music</option><option value="set" ${g.auto ? '' : 'selected'}>Set by hand</option></select>
        <span></span><span class="hint">${gridWords()}</span>
        <label>Tempo</label><div class="pair">${num('bpm', +gp.bpm.toFixed(3), 0.01, 'min="1"')}<span class="ro">bpm${g.map ? ` · here (${gp.t > 0 ? `from ${f2(gp.t)} s` : 'from the start'})` : ''}</span></div>
        <label>Grid offset</label><div class="pair">${num('offset', +barMod(gp).toFixed(4), 0.001)}<span class="ro">s</span></div>
        <label>Beats / bar</label>${num('beatsPerBar', gp.beatsPerBar, 1, 'min="1"')}`)}
      ${film ? `${sect('project', 'film-strip', 'Project', `<label>Project URL</label><input name="url" value="${esc(S.doc.url || '')}" placeholder="http://localhost:5320/projects/…/" spellcheck="false">
        ${S.urlFixed ? `<span></span><span class="hint">Renders use --url ${esc(S.url)}</span>` : ''}
        <label>FPS</label>${num('fps', S.doc.fps || 60, 1, 'min="1"')}
        <label>Size</label><div class="pair">${num('width', (S.doc.size ?? [1920, 1080])[0], 2, 'min="64" max="8192"')}<span class="ro">×</span>${num('height', (S.doc.size ?? [1920, 1080])[1], 2, 'min="64" max="8192"')}<span class="ro">px</span></div>`)}
      ${sect('sampling', 'aperture', 'Sampling', `<label>Shutter</label><div class="pair">${num('shutter', S.doc.shutter ?? 180, 1, 'min="0" max="720"')}<span class="ro">°</span></div>
        <label title="Depth of field and fast camera moves take more where they need them.">Sub-frames</label><div class="pair"><span class="ro">viewer</span>${num('samplesViewer', samplesOf(S.doc).viewer, 1, 'min="1" max="64" style="width:36px;padding:0 4px"')}<span class="ro">master</span>${num('samplesMaster', samplesOf(S.doc).master, 1, 'min="1" max="64" style="width:36px;padding:0 4px"')}</div>
        <span></span><span class="hint">Each one draws the frame again. More are smoother but take longer.</span>
        <label title="Box shows thin bright edges as dots until many sub-frames fill them in.">Pixel filter</label><select name="pixelFilterType"><option value="blackman-harris">Blackman-Harris</option><option value="box" ${S.doc.pixelFilterType === 'box' ? 'selected' : ''}>Box</option></select>
        ${S.doc.pixelFilterType === 'box' ? '' : `<label title="Wider is softer. Narrower is sharper and shows more aliasing.">Filter width</label><div class="pair">${num('pixelFilter', S.doc.pixelFilter ?? PIXEL_FILTER, 0.1, 'min="0.01" max="10"')}<span class="ro">px</span></div>`}`)}
      ${sect('light', 'sun-horizon', 'Light', `${grp('gi', 'sparkle', 'Global illumination', forFilm('gi', ['Project default', 'On (experimental)', 'Off']), renderingFields('gi'), S.doc.gi === false, 'Light bounces off surfaces onto others. Renders take longer.')}
        ${grp('shadows', 'circle-half', 'Shadows', forFilm('shadows', ['Project default', 'All lights', 'No lights']), renderingFields('shadows'), S.doc.shadows === false)}
        ${grp('reflections', 'flip-horizontal', 'Reflections', forFilm('reflections', ['Project default', 'On', 'Off']), renderingFields('reflections'), S.doc.reflections === false)}
        ${grp('glass', 'wine', 'Glass', '', renderingFields('glass'))}
        <span class="full hint">Empty fields use the project default.</span>`, overridden)}
      ${sect('scene', 'cube', 'Scene', `<div class="full form" id="sceneFields"><span class="full hint">…</span></div>
        <span class="full hint">Values here override the project’s code. ◇ animates one.</span>`)}
      ${sect('passes', 'stack', 'Passes', `<span class="full ro" id="passList">…</span>
        <span class="full hint">Select a pass to edit its settings.</span>`)}` : ''}
      <div class="sect-b form"><div class="full hint">${film ? 'Select a cue or clip to edit it.' : 'Select a clip to edit it.'}</div></div>
    </div>`;
    el.onclick = sectToggled;
    if (film) { listPasses(el); sceneFields(el); }
  }
  for (const input of el.querySelectorAll('input, select, textarea')) {
    input.onkeydown = (e) => { if (e.key === 'Enter' && input.tagName !== 'TEXTAREA') input.blur(); if (e.key === 'Escape') { el.dataset.for = ''; inspector(); } };
    if (input.name === 'gainR') { input.oninput = () => { el.querySelector('input[name=gain]').value = input.value; }; input.onchange = () => setField('gain', input.value); }
    else input.onchange = () => setField(input.name, input.value);
  }
  for (const b of el.querySelectorAll('[data-act]')) b.onclick = () => (b.dataset.act === 'delete' ? deleteSelection() : b.dataset.act === 'selectOn' ? selectOn(cues[0]) : (seek(cues[0].t), tl.reveal(cues[0].t)));
}

// a notes clip's pattern: how many notes, as heard (the piano roll edits them; the Instrument panel its instrument), and
// whether the film's sound code writes them
function notesFields(id) {
  const m = heardDoc().media[id];
  return isNotes(m) ? `<label>Notes</label><span class="ro">${m.notes.length}${SOUND.score?.notes?.[id] ? ' · from the code' : ''} · in the piano roll</span>` : '';
}
// a song clip's tempo: the one the studio heard (Autodetect: tools/music.mjs, from the beats Beat This! is sure of) or set
// by hand (clip.tempo: its bar lines in the song's own seconds, so that they move with the clip)
function tempoFields(c, track, num) {
  if (isNotes(S.doc.media[c.media])) return '';
  const t = c.tempo, mu = S.music[c.media], g = grid(), bpm = (x) => +x.toFixed(2), bpms = mu?.map?.map((p) => p.bpm) ?? [];
  const [heard, more] = S.listening.includes(c.media) ? ['Listening…', 'Analysing the song. This takes about 10 seconds.']
    : !mu ? ['Not analysed', 'Only sounds 10 seconds or longer are analysed.']
    : !mu.map ? ['No steady beat', 'No steady beat was found. Set the tempo by hand instead.']
    : [bpms.length === 1 ? `${bpm(mu.bpm)} bpm · ${mu.beatsPerBar}/bar` : `${bpms.length} tempos · ${bpm(Math.min(...bpms))}–${bpm(Math.max(...bpms))} bpm`,
      'Detected from the song’s clearest beats. The ticks on the clip are fainter where the detection is less certain.'];
  const off = !g.auto ? 'grid set by hand' : g.track && g.track !== track.id ? 'not the tempo master' : '';
  return `<label>Tempo</label><select name="tempoFrom" title="Autodetect uses the tempo detected in the song. Set by hand lets you enter one tempo for this clip, and its bars move with the clip."><option value="auto" ${t ? '' : 'selected'}>Autodetect</option><option value="set" ${t ? 'selected' : ''}>Set by hand</option></select>
        ${t ? '' : `<span></span><span class="hint" title="${esc(more)}">${heard}${off ? ` · ${off}` : ''}</span>`}
        ${t ? `<label>BPM</label>${num('tempoBpm', t.bpm, 0.01, 'min="1"')}
        <label>First bar</label><div class="pair">${num('tempoOffset', t.offset, 0.001)}<span class="ro">s in song</span></div>
        <label>Beats / bar</label>${num('tempoPer', t.beatsPerBar, 1, 'min="1"')}${off ? `<span></span><span class="hint">${off}</span>` : ''}` : ''}`;
}
function setClipTempo(c, name, v) {
  const id = c.id, n = `"${c.media}"`, clip = (d) => d.tracks.flatMap((t) => t.clips).find((k) => k.id === id);
  if (name === 'tempoFrom') {
    if (v === 'auto') return edit(`tempo of ${n}: autodetect`, (d) => { delete clip(d).tempo; });
    // from the tempo heard where the clip starts, or the grid's there
    const sp = speedOf(c), heard = S.music[c.media]?.map, h = heard && [...heard].reverse().find((p) => p.t <= c.in + 1e-6);
    const g = h ?? (() => { const p = partAt(gridParts(grid()), c.at); return { bpm: p.bpm / sp, offset: c.in + (p.line - c.at) * sp, beatsPerBar: p.beatsPerBar }; })();
    const bar = (60 / g.bpm) * g.beatsPerBar, tempo = { bpm: +g.bpm.toFixed(3), offset: +(((g.offset % bar) + bar) % bar).toFixed(4), beatsPerBar: g.beatsPerBar };
    return edit(`tempo of ${n}: set by hand, ${tempo.bpm} bpm`, (d) => { clip(d).tempo = tempo; });
  }
  const key = { tempoBpm: 'bpm', tempoOffset: 'offset', tempoPer: 'beatsPerBar' }[name], was = c.tempo[key];
  const val = key === 'beatsPerBar' ? Math.max(1, Math.round(v)) : key === 'bpm' ? Math.max(1, v) : v;
  edit(`tempo of ${n}: ${{ bpm: 'bpm', offset: 'first bar', beatsPerBar: 'beats a bar' }[key]} ${was} → ${val}`, (d) => { clip(d).tempo = { ...clip(d).tempo, [key]: val }; });
}
// a setting the timeline may set for the whole film (true, false) or leave to the film's code: a select of the three
const forFilm = (name, [film, on, off], now = S.doc[name]) => `<select name="${name}">${[['', film], ['on', on], ['off', off]].map(([v, l]) => `<option value="${v}" ${(now === true ? 'on' : now === false ? 'off' : '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
// the timeline's rendering (nle/model.js): how the film's light is traced, each field over what its scenes ask, left
// empty as they ask (the film's own value greyed in it, the renderer's until the film says: sceneFields). [what, field,
// label, unit, step, min, max, the renderer's own], or a switch: [what, field, label, its three choices if not On and Off]
const RENDERING = [
  ['gi', 'once', 'GI traces', ['Project default', 'Once a frame', 'Every sub-frame']],
  ['gi', 'probe', 'GI probe size', 'px', 1, 4, 64, 16],
  ['gi', 'rays', 'GI rays', 'a frame', 0.25, 0.25, 64, 4],
  ['gi', 'bounces', 'GI bounces', 'times', 1, 1, 8, 1],
  ['gi', 'reach', 'GI reach', '× probe spacing', 0.1, 0.5, 8, 1.6],
  ['gi', 'hit', 'GI hit spacing', 'px', 1, 1, 64, 'auto'],
  ['shadows', 'rays', 'Shadow rays', 'a frame', 1, 1, 64, 8],
  ['shadows', 'denoise', 'Shadow denoise'],
  ['reflections', 'denoise', 'Reflection denoise'],
  ['glass', 'bounces', 'Glass bounces', 'pieces of glass', 1, 0, 16, 4],
];
const RENDERING_TIPS = {
  'gi.once': 'Once a frame is much quicker, but can shimmer in rooms lit by bounces.',
  'gi.probe': 'Larger probes make the light coarser and render faster.',
  'gi.rays': 'More rays reduce grain. Once a frame wants about 16. Every sub-frame sends at least one.',
  'gi.bounces': 'More bounces light a room more fully and take noticeably longer.',
  'gi.reach': 'Sets how far the nearest probes see.',
  'gi.hit': 'Sets how sparsely probes cover what the camera can’t see. Wider is quicker but can darken rooms.',
  'shadows.rays': 'Used while shadows are denoised. Without denoising, each light takes 16 rays a frame.',
  'shadows.denoise': 'Without denoising, shadows keep their grain.',
  'glass.bounces': 'How many other pieces of glass light passes through. At 0, glass ignores other glass.',
};
// (which of the inspector's sections are shut, on this machine; a group inside one by its own id)
// a section's head clicked: it opens or closes, and stays so
const sectToggled = (e) => {
  const h = e.target.closest('[data-sect]'), b = h?.parentElement.querySelector(':scope > .sect-b, :scope > .grp-b');
  if (!b) return;
  const opening = b.hidden; b.hidden = !opening; h.setAttribute('aria-expanded', opening);
  inspClosed[opening ? 'delete' : 'add'](h.dataset.sect);
  try { localStorage.setItem('nle:inspClosed', JSON.stringify([...inspClosed])); } catch { /* only a convenience */ }
};
const inspClosed = new Set((() => { try { return JSON.parse(localStorage.getItem('nle:inspClosed')) ?? ['music', 'scene', 'passes']; } catch { return ['music', 'scene', 'passes']; } })());
// (a field in its group: GI rays there is Rays; the longer name is what history says)
const inGroup = (label) => { const l = label.replace(/^(GI|Shadow|Reflection|Glass) /, ''); return l[0].toUpperCase() + l.slice(1); };
const renderingFields = (what) => RENDERING.filter((r) => r[0] === what).map(([, f, label, unit, step, min, max, own]) => {
  const name = `rendering.${what}.${f}`, v = S.doc.rendering?.[what]?.[f], tip = RENDERING_TIPS[`${what}.${f}`], lbl = `<label class="${v === undefined ? '' : 'ov'}"${tip ? ` title="${tip}"` : ''}>${inGroup(label)}</label>`;
  if (!step) return `${lbl}${forFilm(name, unit ?? ['Project default', 'On', 'Off'], v)}`;
  return `${lbl}<div class="pair"><input type="number" name="${name}" value="${v ?? ''}" placeholder="${own}" step="${step}" min="${min}" max="${max}" style="width:62px"><span class="ro">${unit}</span></div>`;
}).join('\n');
// one of them set (raw: the field's; empty, project default), the timeline's rendering emptied of what is left out
function setRendering(name, raw) {
  const [, what, f] = name.split('.'), [, , label, , step, min, max] = RENDERING.find((r) => r[0] === what && r[1] === f);
  const v = raw === '' ? null : !step ? raw === 'on' : Math.min(max, Math.max(min, step >= 1 ? Math.round(+raw) : +raw));
  if (typeof v === 'number' && !Number.isFinite(v)) return inspector();
  edit(`${label} → ${v === null ? 'project default' : v === true ? 'on' : v === false ? 'off' : v}`, (d) => {
    const one = { ...d.rendering?.[what] };
    if (v === null) delete one[f]; else one[f] = v;
    d.rendering = { ...d.rendering, [what]: one };
    if (!Object.keys(one).length) delete d.rendering[what];
    if (!Object.keys(d.rendering).length) delete d.rendering;
  });
}
function setField(name, raw) {
  if (name === 'id') return renameCue(raw.trim());
  if (name.startsWith('rendering.')) return setRendering(name, raw);
  const v = name === 'label' || name === 'note' || name === 'url' || name === 'track' || name === 'gi' || name === 'shadows' || name === 'reflections' || name === 'pixelFilterType' || name === 'gridFrom' || name === 'tempoFrom' ? raw : +raw;
  if (typeof v === 'number' && !Number.isFinite(v)) return inspector();
  const q = S.doc.cues.find((x) => S.sel.has(x.id)), cc = clipsAll().find(({ clip }) => S.sel.has(clip.id));
  if (q) {
    const id = q.id, who = q.label ? `"${q.label}"` : `at ${f2(q.t)}`;
    const desc = { label: `label cue ${q.label ? `"${q.label}"` : `at ${f2(q.t)}`} → "${v}"`, note: `note on cue ${who}`, t: `move cue ${q.label ? `"${q.label}" ` : ''}${f2(q.t)} → ${f2(v)}`, dur: `cue ${who} length ${f2(q.dur)} → ${f2(v)}` }[name];
    edit(desc, (d) => { const x = d.cues.find((k) => k.id === id); x[name] = typeof v === 'number' ? Math.max(0, v) : v; });
  } else if (cc) {
    const c = cc.clip, id = c.id, n = `"${c.media}"`, dur = audio.get(c.media)?.buffer?.duration ?? Infinity;
    if (name.startsWith('tempo')) return setClipTempo(c, name, v);
    if (name === 'track') { edit(`move ${n} to "${S.doc.tracks.find((t) => t.id === v).name}"`, (d) => { const tr = d.tracks.find((t) => t.clips.some((k) => k.id === id)), x = tr.clips.find((k) => k.id === id); tr.clips.splice(tr.clips.indexOf(x), 1); d.tracks.find((t) => t.id === v).clips.push(x); }); return; }
    const desc = { at: `move ${n} ${f2(c.at)} → ${f2(v)}`, in: `set in of ${n} ${f2(c.in)} → ${f2(v)}`, out: `set out of ${n} ${f2(c.out)} → ${f2(v)}`, gain: `gain ${n} ${(c.gain || 0).toFixed(1)} → ${v.toFixed(1)} dB`, fadeIn: `fade in ${n} ${f2(c.fadeIn || 0)} → ${f2(v)} s`, fadeOut: `fade out ${n} ${f2(c.fadeOut || 0)} → ${f2(v)} s`, speed: `speed of ${n} ${f2(speedOf(c))} → ${f2(v)}×` }[name];
    edit(desc, (d) => {
      const x = d.tracks.flatMap((t) => t.clips).find((k) => k.id === id);
      if (name === 'at') x.at = Math.max(0, v);
      else if (name === 'in') x.in = Math.min(Math.max(0, v), x.out - 0.02);
      else if (name === 'out') x.out = Math.max(Math.min(v, dur), x.in + 0.02);
      else if (name === 'gain') x.gain = Math.max(-60, Math.min(24, v));
      else if (name === 'speed') { x.speed = Math.max(0.25, Math.min(4, v)); if (x.speed === 1) delete x.speed; }
      else x[name] = Math.max(0, v);
      const len = (x.out - x.in) / speedOf(x);
      if (x.fadeIn + x.fadeOut > len) { if (name === 'fadeOut') x.fadeOut = len - x.fadeIn; else x.fadeIn = Math.max(0, len - x.fadeOut); }
    });
  } else {
    if (name === 'url') edit(`set film url → ${v || '(none)'}`, (d) => { d.url = v.trim(); });
    else if (name === 'fps') edit(`fps ${S.doc.fps} → ${v}`, (d) => { d.fps = Math.max(1, Math.round(v)); });
    else if (name === 'gi' || name === 'shadows' || name === 'reflections') edit(`${name === 'gi' ? 'global illumination' : name} → ${v || (name === 'shadows' ? 'project default' : 'project default')}`, (d) => { if (v) d[name] = v === 'on'; else delete d[name]; });
    else if (name === 'width' || name === 'height') {
      const [w, h] = S.doc.size ?? [1920, 1080], n = Math.max(64, Math.min(8192, Math.round(v / 2) * 2)), size = name === 'width' ? [n, h] : [w, n];
      edit(`size ${w} × ${h} → ${size[0]} × ${size[1]}`, (d) => { if (size[0] === 1920 && size[1] === 1080) delete d.size; else d.size = size; });
    }
    else if (name === 'shutter') edit(`shutter ${S.doc.shutter ?? 180}° → ${v}°`, (d) => { d.shutter = Math.max(0, Math.min(720, Math.round(v))); });
    else if (name === 'samplesViewer' || name === 'samplesMaster') {
      const k = name === 'samplesViewer' ? 'viewer' : 'master', n = Math.max(1, Math.min(64, Math.round(v)));
      edit(`${k} sub-frames ${samplesOf(S.doc)[k]} → ${n}`, (d) => {
        d.samples = { ...d.samples, [k]: n };
        if (n === SAMPLES[k]) delete d.samples[k];
        if (!Object.keys(d.samples).length) delete d.samples;
      });
    }
    else if (name === 'pixelFilterType') edit(`pixel filter → ${v === 'box' ? 'Box' : 'Blackman-Harris'}`, (d) => { if (v === 'box') d.pixelFilterType = 'box'; else delete d.pixelFilterType; });
    else if (name === 'pixelFilter') {
      const w = Math.max(0.01, Math.min(10, v));
      edit(`filter width ${S.doc.pixelFilter ?? PIXEL_FILTER} → ${w} px`, (d) => { if (w === PIXEL_FILTER) delete d.pixelFilter; else d.pixelFilter = w; });
    }
    else if (name === 'gridFrom') {
      if (v === 'auto') edit('tempo grid: detected from the music', (d) => { d.grid = { ...grid(), auto: true }; });   // (record follows the music)
      else { const { bpm, offset = 0, beatsPerBar = 4 } = grid(); edit('tempo grid: set by hand', (d) => { d.grid = { bpm, offset, beatsPerBar }; }); }
    } else {
      // a value typed: the grid is the director's from now on, one tempo (the part shown, with this value)
      const p = partAt(gridParts(grid()), S.t), was = { bpm: +p.bpm.toFixed(3), offset: +barMod(p).toFixed(4), beatsPerBar: p.beatsPerBar };
      edit(`grid ${name} ${was[name]} → ${v}${grid().auto ? ' (set by hand)' : ''}`, (d) => { d.grid = { ...was, [name]: name === 'beatsPerBar' ? Math.max(1, Math.round(v)) : name === 'bpm' ? Math.max(1, v) : v }; });
    }
    if (name === 'url' && !S.urlFixed) S.url = v.trim();
  }
}

let cueNow = null;
/** Renames the selected cue (its name is what the film calls it). */
function renameCue(v) {
  const q = S.doc.cues.find((x) => S.sel.has(x.id));
  if (!q || v === q.id) return;
  if (!/^[a-z][a-z0-9-]*$/.test(v) || S.doc.cues.some((x) => x.id === v)) { alert(`"${v}" can't be a cue name: lowercase letters, digits and dashes, starting with a letter, and not already used.`); return inspector(); }
  const old = q.id;
  edit(`name cue ${q.label ? `"${q.label}" ` : ''}${old} → ${v}`, (d) => { d.cues.find((x) => x.id === old).id = v; });
  S.sel = new Set([v]); panels();
}
function cueList() {
  const el = $('#cueList'), cues = S.doc.cues;
  el.className = 'list';
  $('#cueCount').textContent = cues.length || '';
  if (!cues.length) { el.innerHTML = '<div class="empty">No cues yet. Press <kbd>M</kbd> to add one at the playhead, even while playing.</div>'; return; }
  el.innerHTML = cues.map((q, i) => `<div class="row${S.sel.has(q.id) ? ' sel' : ''}${q.dur ? ' range' : ''}" data-id="${q.id}">
      <span class="pin${q.on ? ' on' : ''}"${q.on ? ` title="On ${esc(q.on.label || q.on.kind)}"` : ''}></span><span class="lbl">${q.label ? esc(q.label) : q.on ? `<i>on ${esc(q.on.label || q.on.kind)}</i>` : `<i>cue ${i + 1}</i>`}${filmUses(q.id) ? ' <span class="film-uses" title="The project follows this cue">film</span>' : ''}</span>
      <span class="t">${f2(q.t)}${q.dur ? `–${f2(q.t + q.dur)}` : ''}</span><span class="bb">${barBeat(q.t)}</span>
      ${q.note ? `<span class="note">${esc(q.note.split('\n')[0])}</span>` : ''}</div>`).join('');
  for (const row of el.querySelectorAll('.row')) {
    const q = cues.find((x) => x.id === row.dataset.id);
    row.onclick = (e) => { select(q.id, e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : null); seek(q.t); tl.reveal(q.t); };
    row.ondblclick = () => openCue(q.id);
  }
  cueNow = null; markCueNow();
  el.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
}
function markCueNow() {
  const q = S.doc.cues.findLast((x) => x.t <= S.t + 1e-6);
  if (q?.id === cueNow) return;
  cueNow = q?.id;
  for (const row of $('#cueList').querySelectorAll('.row')) row.classList.toggle('now', row.dataset.id === cueNow);
}
// the inspector is rebuilt when focus leaves it, not under the cursor while tabbing between fields
$('#inspector').addEventListener('focusout', (e) => { if (!$('#inspector').contains(e.relatedTarget)) setTimeout(() => { $('#inspector').dataset.for = ''; inspector(); }); });

// ---------- the viewer: frames the server renders live (tools/preview.mjs), the one under the playhead first (playing,
// those ahead of it). Where the cache does not have the frame under a still playhead as the editor has the film — an
// edit not yet saved or rendered (a drag of the gizmo, a field, a lane), a frame the cache has not reached since the
// film changed — the studio's viewing worker draws it now (ask 'live'): quickly while something moves (half size,
// without motion blur), then as the cache draws it. A frame of an earlier version of the film is shown only while
// nothing newer can be, marked
const frameEl = $('#frame'), g2 = frameEl.getContext('2d'), badge = $('#frameBadge'), screenMsg = $('#screenMsg');
const shown = new Map(), loading = new Set();   // frame → { bmp, gen, state }: decoded at the viewer's size, near the playhead
const KEEP = 30;
let drawn = null, drawnOk = false, drawnF = null, behind = 0;
const frameAt = (t) => Math.floor(t * (S.doc.fps || 60) + 1e-6);
const stateOf = (f) => (S.film.frames.charCodeAt(f) || 48) - 48;   // 0 none, 1 stale, 2 current, 3 current and changed
const sizeOf = (f) => (S.film.sizes?.charCodeAt(f) || 56) - 48;   // the size it was drawn at, in eighths of the project's frame
// a decoded frame is outdated once a newer version of it is on the server
const outdated = (f) => { const c = shown.get(f), s = stateOf(f); return !c || c.look !== S.film.look || (s >= 2 && (c.state < 2 || c.gen !== S.film.gen || c.size !== sizeOf(f))); };
function fetchFrame(f) {
  if (loading.has(f) || loading.size >= 6) return;
  if (vsend({ type: 'get', f })) loading.add(f);
}
// ---------- the viewer's socket (tools/nle.mjs viewerSocket), held by a worker that decodes its pictures (viewerworker.js),
// so that they come as fast while the editor's own drawing fills the main thread: the cache's frames come over it raw,
// those it stores near the playhead as soon as they are; frames drawn now are asked for by id (ask). Opened again a
// second after it drops. (while Stats shows, each comes with what drawing it took: kept with its picture; a frame so
// far, or converging, with how many of its sub-frames it is: SAMPLED)
// (memory: the studio's own window: it reads frames drawn now where they are, app/framefile.cjs, not asking for JPEGs)
const VS = { worker: null, open: false, asks: new Map(), id: 0, at: '', view: '', fit: '', memory: false }, TOOK = new WeakMap(), SAMPLED = new WeakMap();
function openViewerSocket() {
  const u = new URL('api/viewer', location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (!VS.worker) {
    VS.worker = new Worker(new URL('./viewerworker.js', import.meta.url), { type: 'module' });
    VS.worker.onmessage = ({ data }) => viewerMessage(data);
    VS.worker.onerror = (e) => console.warn(`viewer worker: ${e.message}`);
    if (window.studioApp?.framesReader) {
      addEventListener('message', (e) => { if (e.data === 'frames-reader' && e.ports[0]) { VS.worker.postMessage({ reader: e.ports[0] }, [e.ports[0]]); VS.memory = true; sendView(); } });
      window.studioApp.framesReader();
    }
  }
  VS.fit = ''; sendFit();
  VS.worker.postMessage({ open: u.href });
}
// the size the worker draws the pictures at: the viewer's (no viewer shown, the Music page's: as they come)
function sendFit() {
  const fit = frameEl.width && frameEl.height ? [frameEl.width, frameEl.height] : [0, 0], key = fit.join('x');
  if (VS.worker && key !== VS.fit) { VS.fit = key; VS.worker.postMessage({ fit }); }
}
function viewerMessage(m) {
  if (m.open) { VS.open = true; VS.at = ''; VS.view = ''; ST.on = null; sendView(); return; }
  if (m.closed) {
    VS.open = false;
    for (const a of VS.asks.values()) a.reject(new Error('The studio is not answering.'));
    VS.asks.clear(); loading.clear();
    setTimeout(openViewerSocket, 1000);
    return;
  }
  if (m.text) {
    const q = JSON.parse(m.text);
    if (q.kind === 'none') return loading.delete(q.f);
    if (q.kind === 'view') { NET.near = q.near !== false; return deliveryShown(q.delivery); }
    if (q.kind === 'pong') return netAnswered(q.id);
    const a = VS.asks.get(q.id); VS.asks.delete(q.id); a?.reject(new Error(q.error));
    return;
  }
  const { head, bmp } = m;
  // (a frame in memory it could not read: JPEGs from here on)
  if (m.unread && VS.memory) { VS.memory = false; sendView(); }
  netCame(head, m.bytes);
  if (head.kind === 'frame') return keepFrame(head, bmp);
  // (a live frame so far: the frame whole comes after)
  const a = VS.asks.get(head.id);
  if (!head.partial) VS.asks.delete(head.id);
  if (!bmp) return head.partial || a?.reject(new Error(m.error));
  if (!a || (head.partial && !a.partial)) return bmp.close();
  if (head.profile) TOOK.set(bmp, head.profile);
  if (head.sub) SAMPLED.set(bmp, { done: head.done, sub: head.sub });
  if (head.partial) a.partial(bmp); else a.resolve(bmp);
}
// (quick: an ask's picture, scaled quickly)
const vsend = (m, quick = false) => { if (!VS.open) return false; VS.worker.postMessage({ send: m, quick }); return true; };
/** A frame drawn now, 'live', 'director' or 'converge' (tools/nle.mjs liveFrame, directorFrame, convergeFrame), as a
 *  picture the viewer's size; partial(picture): each frame so far, as it comes (a live frame's with body.progress). */
function ask(kind, body, quick, partial = null) {
  const id = ++VS.id;
  return new Promise((resolve, reject) => { if (vsend({ type: kind, id, ...body }, quick)) VS.asks.set(id, { resolve, reject, partial }); else reject(new Error('The studio is not answering.')); });
}
// a frame of the cache, as it came (decoded: none, asked for again on a later tick): kept unless one newer than it is (a
// frame read from the cache just before the cache stored it again can come after the one stored)
function keepFrame(head, bmp) {
  const f = head.f, c = shown.get(f);
  loading.delete(f);
  if (!bmp) return;
  if (c && c.look === head.look && (c.gen > head.gen || (c.gen === head.gen && c.state >= 2 && head.state < 2))) return bmp.close();
  if (head.profile) TOOK.set(bmp, head.profile);
  c?.bmp.close();
  shown.set(f, { bmp, gen: head.gen, state: head.state, look: head.look, size: head.size });
  if (shown.size > KEEP) {
    const now = frameAt(S.t), far = [...shown.keys()].sort((a, b) => Math.abs(b - now) - Math.abs(a - now));
    for (const k of far.slice(0, shown.size - KEEP)) { shown.get(k).bmp.close(); shown.delete(k); }
  }
}
// the timeline as the viewer draws it (a gesture's, while one goes on) and its key; and its overrides, for a request
// where the film's pages do not have them yet
const liveDoc = () => gizmo.doc() ?? S.doc;
let gzKey = { doc: null, key: '' };
function liveKey() {
  const d = gizmo.doc();
  if (!d) return S.filmKey;
  if (gzKey.doc !== d) gzKey = { doc: d, key: filmSees(d, followed(S.film)) };
  return gzKey.key;
}
const draftNow = () => (S.film.key != null && liveKey() !== S.film.key ? liveEdits(strip(liveDoc())) : undefined);
// whether the cache's frame f shows the film as the editor has it (the frames are of its timeline, and f is rendered
// since the film last changed)
function current(f) {
  const c = shown.get(f);
  return !!c && stateOf(f) >= 2 && c.state >= 2 && c.gen === S.film.gen && (S.film.key == null || S.film.key === liveKey());
}
// whether a frame drawn now can show it: the film's pages take its overrides as they are, but the rest of the timeline
// (the cues it follows) they read as they load, so an edit of those waits for its frames
const drawable = () => S.film.key != null && !S.film.error && S.film.base === S.filmBase;

// a frame drawn now, one at a time (the latest wanted)
const L = { img: null, sent: '', inflight: false, moved: 0, failed: 0 };
function liveFrame(f) {
  const key = liveKey(), quick = gizmo.active || S.dragging || performance.now() - L.moved < 250, l = L.img;
  if (l && l.f === f && l.key === key && l.loaded === S.film.loaded && (l.exact || quick)) return;
  const want = `${f}|${key}|${S.film.loaded}|${quick}`;
  if (L.inflight || want === L.sent || performance.now() - L.failed < 4000) return;
  const loaded = S.film.loaded;
  L.sent = want; L.inflight = true;
  // (with Converge on, drawn whole it shows as it is drawn: the frame so far, its sub-frames counted in the badge; it
  // lands later, each sub-frame waiting for the GPU and the frames so far finished: up to half as long again)
  let whole = false;
  const soFar = (bmp) => { if (whole || L.sent !== want) return bmp.close(); L.img?.bmp.close(); L.img = { bmp, f, key, loaded, exact: false }; };
  ask('live', { t: f / (S.doc.fps || 60), draft: draftNow(), scale: quick ? Math.max(0.25, viewSize() / 2) : viewSize(), blur: !quick, progress: !quick && CV.on }, quick, soFar)
    .then((bmp) => { whole = true; L.img?.bmp.close(); L.img = { bmp, f, key, loaded, exact: !quick }; })
    .catch(() => { L.sent = ''; L.failed = performance.now(); })   // (tried again in a few seconds)
    .finally(() => { L.inflight = false; });
}
// still: the cache's frame if it is the film as the editor has it; else one drawn now; else the cache's, marked
// → [picture, why it may not be the film as it is now (the badge), its frame]. (None drawn now while the editor's own
// film loads the first time: the studio would load another copy of the film, a GPU's worth of it kept minutes, to draw
// what that one is about to)
function stillPicture(f) {
  const c = shown.get(f);
  if (current(f)) return [c, '', f];
  if (!viewport.draws && (gizmo.active || drawable())) liveFrame(f);
  const l = L.img;
  if (l && l.f === f) return [l, gizmo.active || (l.key === liveKey() && l.loaded === S.film.loaded) ? '' : 'updating', f];
  return [c, c ? 'updating' : 'rendering', f];
}
// playing: the cache's frames, as it renders them ahead of the playhead (full quality, kept). Dropping frames, the
// newest there is at or before the playhead shows (where there is none, the picture holds); playing every frame, the
// playhead waits for each (everyFrame). Over an edit the cache has not rendered yet (a gesture going on, or one just
// made, or the film changed), frames drawn now (livePlaying) until the cache's are current.
function playingPicture(f) {
  if (current(f)) return [shown.get(f), '', f];
  for (let k = f - 1; k >= Math.max(0, f - 24) && k > (drawnOk ? drawnF ?? -1 : -1); k--) if (current(k)) return [shown.get(k), '', k];
  if (!PLAY.every && !viewport.draws && (gizmo.active || drawable()) && (gizmo.active || liveKey() !== S.film.key || stateOf(f) === 1)) {
    const l = livePlaying(f);
    if (l) return [l, '', l.f];
  }
  if (drawn && drawnOk) return [drawn, '', drawnF];   // (dropped: the picture holds)
  const c = shown.get(f);
  return [c, c ? 'updating' : 'rendering', f];
}
// frames drawn now while playing, as the director's view asks for them (directorPlay): each where the playhead will be
// when it comes back, from the film as the editor has it (a gesture's too), again when that changes or the playhead
// reaches another frame, at most once a display frame and three at a time, quickly (half size, no motion blur); the
// newest asked at or before the playhead (never a frame before the one shown). The cache's rendering goes on meanwhile.
const LP = { buf: new Map(), loaded: null, rtt: null, playing: 0, sentF: null, sentKey: null, shownF: null, seq: 0 };
function livePlaying(f) {
  const fps = S.doc.fps || 60, key = liveKey();
  if (LP.loaded !== S.film.loaded) { for (const b of LP.buf.values()) b.bmp.close(); LP.buf.clear(); LP.loaded = S.film.loaded; LP.sentF = LP.shownF = null; }
  for (const [k, b] of LP.buf) if (k < f - 2) { b.bmp.close(); LP.buf.delete(k); }
  if (LP.shownF != null && LP.shownF > f) LP.shownF = null;   // (the playhead went back)
  let best = null;
  for (const b of LP.buf.values()) if (b.f <= f && b.f >= (LP.shownF ?? -1) && (best == null || b.seq > best.seq)) best = b;
  if (best) LP.shownF = best.f;
  const i = Math.min(Math.floor((S.film.duration || S.end()) * fps), frameAt(S.t + (LP.rtt ?? 120) / 1000));
  if (LP.playing < 3 && (i !== LP.sentF || key !== LP.sentKey)) {
    const sent = performance.now(), seq = ++LP.seq, loaded = S.film.loaded;
    LP.playing++; LP.sentF = i; LP.sentKey = key;
    ask('live', { t: i / fps, draft: draftNow(), scale: Math.max(0.25, viewSize() / 2), blur: false, ahead: true }, true)
      .then((bmp) => {
        LP.rtt = 0.8 * (LP.rtt ?? 120) + 0.2 * (performance.now() - sent);
        const had = LP.buf.get(i);
        if (loaded === LP.loaded && i >= frameAt(S.t) - 2 && !(had && had.seq > seq)) { had?.bmp.close(); LP.buf.set(i, { bmp, f: i, seq }); } else bmp.close();
      })
      .catch(() => {})
      .finally(() => { LP.playing--; });
  }
  return best;
}
function viewer() {
  if (D.view === 'director') return director();
  const [dw, dh] = S.doc?.size ?? [1920, 1080];
  if (dw !== FW || dh !== FH) placeFrame();   // (the timeline's size was edited, undone, or changed by another editor)
  // (the editor's own film draws it once it is up, or while it loads again, the one before showing its last picture; the
  // first time it loads, the cache's frames show here meanwhile, as they are: stillPicture)
  const P = S.film, f = frameAt(S.t), F = P.frames.length, own = viewport.ready || (viewport.loading && !!viewport.frame);
  // where the playhead is, so the server renders that frame first (and the ones ahead while playing), and the frames
  // shown (from, to), which come as soon as the cache stores them (none here where the editor's own film reads them)
  const at = `${f}:${audio.playing}:${PLAY.every}:${own}`, [from, to] = own ? [0, -1] : audio.playing ? [f, f + 11] : [f - 2, f + 2];
  if (at !== VS.at && vsend({ type: 'at', f, playing: audio.playing, every: PLAY.every, from, to })) VS.at = at;
  if (!own) for (const i of audio.playing ? [f, f + 1, f + 2, f + 3, f + 4, f + 5, f + 6, f + 7, f + 8, f + 9, f + 10, f + 11] : [f, f + 1, f - 1, f + 2, f - 2]) {
    if (i >= 0 && i < F && stateOf(i) && outdated(i)) fetchFrame(i);
  }
  const msg = (html, black) => { if (screenMsg.innerHTML !== html) screenMsg.innerHTML = html; screenMsg.classList.toggle('black', !!black); };
  const badgeText = (t) => { if (badge.hidden !== !t) badge.hidden = !t; if (t && badge.textContent !== t) badge.textContent = t; };
  if (!S.url) { badgeText(''); return msg('<b>No project URL</b><span>Set one in the timeline settings to see the project</span>', true); }
  if (P.duration != null && f >= F) { badgeText(''); drawn = null; return msg('<b>After the end of the project</b>', true); }
  if (own) return ownPreview(msg, badgeText);
  if (D.own) { D.own = false; VP.gesture = false; $('#screen').classList.remove('own'); }   // (the film did not start in the editor: the studio's frames)
  const [pic, why, pf] = audio.playing ? playingPicture(f) : stillPicture(f), conv = audio.playing ? null : converged(f, pic, why);
  if ((conv ?? pic) && (conv ?? pic) !== drawn) {
    g2.drawImage((conv ?? pic).bmp, 0, 0, frameEl.width, frameEl.height);
    drawn = conv ?? pic; drawnOk = !why; drawnF = pf; ST.bmp = pic.bmp; ST.f = pf;
    if (audio.playing) PLAY.drew.push(performance.now());
  }
  const c = shown.get(f);
  if (P.error && !(c && stateOf(f) >= 2) && !drawnOk) { badgeText(''); return msg(`<b>${esc(P.error.split('\n')[0])}</b><span>${esc(P.error.split('\n').slice(1).join(' ').trim().slice(0, 300))}</span>`, true); }
  if (!drawn) { badgeText(''); const w = workingText(); return msg(`<b>Rendering…</b>${w ? `<span>${w}</span>` : ''}`, true); }
  msg('');
  // (marked once it has been behind a moment: a picture drawn now usually arrives first)
  if (why) { if (!behind) { behind = performance.now(); unlinger(noticeEl); } }
  else { if (behind && performance.now() - behind > 200 && !audio.playing) linger(noticeEl, `<b>Updated · ${((performance.now() - behind) / 1000).toFixed(1)} s</b>`); behind = 0; }
  const late = why && performance.now() - behind > 200, w = late && workingText();
  badgeText((late ? `${why[0].toUpperCase()}${why.slice(1)}${w ? ` · ${w}` : ''}` : '') || sampledText() || playRate());
}
// a badge's last word, left up a moment for whoever looked too late, a bar along its foot shrinking to say how long, then
// faded. (Animations of transform and opacity, on the compositor: nothing more for the page to do until they end.)
const LINGER_MS = 3000, noticeEl = $('#noticeBadge'), lingering = new Map();
function linger(el, html) {
  unlinger(el);
  el.innerHTML = `${html}<i class="lingerBar"></i>`; el.hidden = false;
  el.lastElementChild.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: LINGER_MS });
  const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { delay: LINGER_MS - 400, duration: 400, fill: 'forwards' });
  lingering.set(el, fade);
  fade.onfinish = () => unlinger(el);
}
function unlinger(el) {
  const fade = lingering.get(el);
  if (!fade) return;
  lingering.delete(el); fade.onfinish = null; fade.cancel(); el.hidden = true; el.innerHTML = '';
}
// what the film's workers are on, as the viewer's picture waits for a newer one: this frame's, or what comes before it
const WK = { list: [] };
function workingText() {
  const f = frameAt(S.t), here = (w) => w.t != null && frameAt(w.t) === f, of = (what) => WK.list.filter((w) => w.what === what);
  const drawing = of('drawing').find(here);
  if (drawing) return `rendering this frame · ${Math.floor((performance.now() - drawing.since) / 1000)} s`;
  if (of('storing').some(here)) return 'saving this frame';
  const n = (count, one) => `${one}${count > 1 ? ` · ${count} workers` : ''}`;
  if (of('loading').length) return n(of('loading').length, 'loading the project');
  if (of('warming').length) return n(of('warming').length, 'compiling shaders');
  return of('drawing').length ? 'rendering other frames first' : '';
}
// what the film's workers are compiling, over the picture, until the last is done: how far along, how long, and each one
// on now; then how it went, lingering
const CP = { el: $('#compileBadge'), data: null, since: 0, timer: 0, html: '' };
function compilingShown(data) {
  if (data.now.length) {
    if (!CP.timer) { unlinger(CP.el); CP.html = ''; CP.since = performance.now(); CP.timer = setInterval(compilingDrawn, 250); }
    CP.data = data;
    return compilingDrawn();
  }
  const was = CP.data;
  CP.data = null; clearInterval(CP.timer); CP.timer = 0; CP.html = '';
  if (was) linger(CP.el, `<b>${data.total || was.total} shaders ready · ${((performance.now() - CP.since) / 1000).toFixed(1)} s</b>`);
}
function compilingDrawn() {
  const d = CP.data, on = !!d;
  const html = !on ? '' : `<b>Compiling shaders · ${d.done} of ${d.total} · ${Math.floor((performance.now() - CP.since) / 1000)} s${d.workers > 1 ? ` · ${d.workers} workers` : ''}</b>${d.now.map((s) => `<span>${esc(s.name)}${s.workers > 1 ? ` ×${s.workers}` : ''}</span>`).join('')}`;
  if (html === CP.html) return;
  CP.html = html; CP.el.innerHTML = html; CP.el.hidden = !on;
}
// playing slower than the film's rate (frames dropped, or waited for): how fast, as Blender shows it
function playRate() {
  const now = performance.now(), fps = S.doc.fps || 60;
  while (PLAY.drew.length && PLAY.drew[0] < now - 1000) PLAY.drew.shift();
  if (!audio.playing || now - PLAY.started < 1200) return '';
  const n = PLAY.drew.length;
  return n < fps * 0.85 ? `${n} fps` : '';
}
// ---------- overlays: what the viewer draws over the picture, each view its own (as Blender's viewports): the scene's
// lights, the selection's outline, its handles (move, turn, scale: G, R, S work either way), a grid on the world's floor
// (y = 0) with its X and Z axes, and in the director's view the film's camera and its path. A viewing preference, kept
// in this browser: the viewer's Overlays opens them, Shift+Alt+Z turns all of a view's off and on
const OV_ITEMS = [
  ['lights', 'Lights', 'where the scene\u2019s own lights are'],
  ['selection', 'Selection', 'its outline'],
  ['bar', 'Toolbar', 'what you can do to the selection'],
  ['add', 'Add', 'the row of shapes and lights', 'director'],
  ['move', 'Move', 'arrows and centre (G)'],
  ['rotate', 'Rotate', 'rings (R)'],
  ['scale', 'Scale', 'the square (S)'],
  ['grid', 'Grid', 'the floor, y = 0: X red, Z blue'],
  ['camera', 'Project camera', 'its frame and path', 'director'],
  ['path', 'Path', 'the selection’s path, and the points its pose is set at (↑ ↓)'],
];
const OV = { film: { on: true, lights: true, selection: true, bar: true, move: true, rotate: true, scale: true, grid: false, path: true },
  director: { on: true, lights: true, selection: true, bar: true, add: true, move: true, rotate: true, scale: true, grid: true, camera: true, path: true } };
try { const k = JSON.parse(localStorage.getItem('nle:overlays') || '{}'); for (const v of ['film', 'director']) Object.assign(OV[v], k[v]); } catch {}
/** Whether the view shown draws overlay k (none, with its overlays off). */
const ovOn = (k) => OV[D.view].on && !!OV[D.view][k];
const ovPanel = document.createElement('div');
ovPanel.className = 'ovpanel'; ovPanel.hidden = true; document.body.append(ovPanel);
function setOverlay(k, v) {
  OV[D.view][k] = v;
  try { localStorage.setItem('nle:overlays', JSON.stringify(OV)); } catch {}
  overlaysShown();
  addRowShown();
  paintObjects();
  if (D.view === 'director' && D.img) paintDirector();
}
// the button as the view shown has them, and the panel if it is open
function overlaysShown() {
  $('#ovBtn').classList.toggle('on', OV[D.view].on);
  if (ovPanel.hidden) return;
  const o = OV[D.view], v = D.view;
  ovPanel.innerHTML = `<label class="ov-all"><input type="checkbox" data-ov="on" ${o.on ? 'checked' : ''}><b>Overlays</b><span class="faint">${v === 'director' ? 'Director' : 'Project camera'} · ⇧ Alt Z</span></label>` +
    OV_ITEMS.filter(([, , , only]) => !only || only === v).map(([k, label, hint]) => `<label class="${o.on ? '' : 'off'}"><input type="checkbox" data-ov="${k}" ${o[k] ? 'checked' : ''}>${label}<span class="faint">${hint}</span></label>`).join('');
  const b = $('#ovBtn'), r = b.getBoundingClientRect();
  if (ovPanel.ownerDocument !== b.ownerDocument) b.ownerDocument.body.append(ovPanel);   // (the viewer's window)
  Object.assign(ovPanel.style, { left: `${Math.max(8, Math.min(b.ownerDocument.defaultView.innerWidth - ovPanel.offsetWidth - 8, r.right - ovPanel.offsetWidth))}px`, top: `${r.bottom + 4}px` });
}
function overlayPanel(open) { ovPanel.hidden = !open; $('#ovBtn').classList.toggle('open', open); overlaysShown(); }
ovPanel.onchange = (e) => { const k = e.target.dataset.ov; e.target.blur(); if (k) setOverlay(k, e.target.checked); };   // (blurred: Space plays)
$('#ovBtn').onclick = () => overlayPanel(ovPanel.hidden);
onEvery('pointerdown', (e) => { if (!ovPanel.hidden && !ovPanel.contains(e.target) && !e.target.closest('#ovBtn')) overlayPanel(false); }, true);
// ---------- Converge (the viewer's Converge, kept for this machine): a paused frame the viewer shows as the film is (the
// cache's current frame, or one drawn now whole) is drawn on past the timeline's samples, up to 256, a moment at a time
// (a converge frame: tools/nle.mjs convergeFrame), the director's other questions answered between; shown over the
// film's own once it has as many, the count in the badge. What fades as it climbs is the frame's samples' noise; what
// stays is the renderer's error. Q held shows the film's own. The director's view at rest goes the same way, from its
// camera (directorConverged).
const CV = { on: true, key: '', since: 0, asking: false, pic: null, done: 0, sub: 0, flip: false };
try { CV.on = localStorage.getItem('nle:converge') !== '0'; } catch {}
$('#convergeBtn').classList.toggle('on', CV.on);
$('#convergeBtn').onclick = () => {
  CV.on = !CV.on; CV.key = '';
  try { localStorage.setItem('nle:converge', CV.on ? '1' : '0'); } catch {}
  $('#convergeBtn').classList.toggle('on', CV.on);
};
onEvery('keyup', (e) => { if (e.code === 'KeyQ') CV.flip = false; });
addEventListener('blur', () => { CV.flip = false; });
// what is converging is now what key says: begun again where it is another
function convergeFor(key) {
  if (key !== CV.key) { CV.key = key; CV.since = performance.now(); CV.pic?.bmp.close(); CV.pic = null; CV.done = CV.sub = 0; }
}
// its next moment asked for (body: its t, and for the director's view its camera), once it has rested a moment, so that
// a scrub or a drag asks for nothing
function convergeOn(key, body) {
  if (CV.asking || performance.now() - CV.since <= 400 || (CV.sub && CV.done >= CV.sub)) return;
  CV.asking = true;
  ask('converge', { key, n: 256, draft: draftNow(), scale: viewSize(), ...body }, false)
    .then((bmp) => {
      if (CV.key !== key) return bmp.close();
      CV.pic?.bmp.close(); CV.pic = { bmp };
      ({ done: CV.done, sub: CV.sub } = SAMPLED.get(bmp));
    })
    .catch(() => { CV.since = performance.now() + 5000; })   // (tried again in a few seconds)
    .finally(() => { CV.asking = false; });
}
// whether it has as many sub-frames as the frame it is shown over (Q held: that frame)
const convergedEnough = () => CV.pic && CV.done >= samplesOf(S.doc).viewer && !CV.flip;
// frame f's converged picture, as far as it has come, to show for `pic` (the film's own: its why, a reason it may not
// be the film as it is now); null where it is the film's own that shows
function converged(f, pic, why) {
  const fps = S.doc.fps || 60, key = hashKey(`${f}|${liveKey()}|${S.film.loaded}|${S.film.look}|${viewSize()}`);
  convergeFor(key);
  const whole = !why && pic && (current(f) || (pic === L.img && L.img.exact));
  if (!CV.on || viewport.draws || D.view !== 'film' || !whole || gizmo.active || S.dragging) return null;
  convergeOn(key, { t: f / fps });
  return convergedEnough() ? CV.pic : null;
}
// how many sub-frames the picture shown is of, where it is not the film's whole: drawn now, or converging (the badge)
function sampledText() {
  const s = SAMPLED.get(drawn?.bmp);
  if (s && drawn === CV.pic) return CV.done < CV.sub ? `Converging · ${CV.done} / ${CV.sub} sub-frames` : `${CV.sub} sub-frames`;
  if (s && s.done < s.sub) return `${s.done} / ${s.sub} sub-frames`;
  if (CV.flip && CV.pic) return 'The project\u2019s own sub-frames';
  if (CV.on && CV.sub && CV.done < CV.sub && D.view === 'film' && !audio.playing) return `Converging · ${CV.done} / ${CV.sub}`;
  return '';
}
const hashKey = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36); };
// ---------- Stats (the viewer's Stats, kept for this machine): what drawing the picture shown took (engine/render/profile.js) — the
// page's time on the film's code, its layers, the scene made ready for the GPU and waiting for it, and the GPU's in each
// of the renderer's passes. While it shows, the studio times every frame it draws, and each comes with its profile
// (TOOK); one it drew before has none, and Profile this frame draws the frame shown again, now, to time it (api/profile)
const ST = { shown: false, on: null, bmp: null, f: null, now: null, busy: false, html: '' };
try { ST.shown = localStorage.getItem('nle:stats') === '1'; } catch {}
startTips(onEvery);
$('#statsBtn').classList.toggle('on', ST.shown);
$('#statsBtn').onclick = () => {
  ST.shown = !ST.shown;
  try { localStorage.setItem('nle:stats', ST.shown ? '1' : '0'); } catch {}
  $('#statsBtn').classList.toggle('on', ST.shown);
};
const statsEl = document.createElement('div');
statsEl.className = 'stats'; statsEl.hidden = true; $('#screen').append(statsEl);
// (which way the frame's rays were traced, as its profile says; a frame with none shows neither)
const RT = {
  hardware: ['Hardware RT', 'Your graphics card’s ray tracing hardware traces this frame. Traced light usually renders faster this way.'],
  software: ['Software RT', 'Your graphics card traces this frame in ordinary shaders, because this build or card has no ray tracing hardware. It looks the same but usually renders slower.'],
};
const fmtMs = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ms`);
function followStats() {
  const on = ST.shown;
  if (on !== ST.on && vsend({ type: 'stats', on })) ST.on = on;
  if (statsEl.hidden === on) statsEl.hidden = !on;
  if (!on) return;
  // (the editor's own film's frames come with what drawing them took, ownShown; the Director view is no frame of the film)
  const key = `${S.film.gen}|${liveKey()}|${S.film.look}`, f = (D.own ? D.ownShown?.f : ST.f) ?? frameAt(S.t), film = D.view === 'film';
  const now = film && ST.now?.f === f && ST.now.key === key, p = now ? ST.now.p : D.own ? D.ownTook?.p ?? null : TOOK.get(ST.bmp);
  const row = (name, ms, of, title = '') => `<div class="st-row"${title ? ` title="${esc(title)}"` : ''}><span>${esc(name)}</span><i><b style="width:${Math.min(100, (ms / (of || 1)) * 100).toFixed(1)}%"></b></i><em>${fmtMs(ms)}</em></div>`;
  const out = [`<div class="st-head"><b>${film ? `Frame ${f}` : 'Director view'}</b>${p ? `<span>${fmtMs(p.ms)} · ${p.subs} sub-frame${p.subs === 1 ? '' : 's'}${now ? ' · drawn again' : ''}</span>` : ''}</div>`];
  const rt = p?.said?.find((s) => s.name === 'rays')?.text;
  if (RT[rt]) out.push(`<button class="st-rt ${rt}" data-act="rt" data-tip-fast title="${esc(RT[rt][1])}">${icon('cpu', rt === 'hardware')}${RT[rt][0]}</button>`);
  if (!p) out.push(`<div class="st-none">${ST.busy ? 'Drawing it again to time it…' : 'Not timed: drawn before Stats was on.'}</div>`);
  else {
    for (const s of p.stages) out.push(row(s.name, s.ms, p.ms, s.n > 1 ? `${s.n} times, ${fmtMs(s.ms / s.n)} each` : ''));
    if (p.gpu) {
      const passes = [...p.gpu.passes].sort((a, b) => b.ms - a.ms);
      out.push(`<div class="st-sub">GPU<span title="The rest of the time it waited for work">${fmtMs(p.gpu.ms)} · ${Math.round((p.gpu.busy / (p.gpu.ms || 1)) * 100)}% in passes</span></div>`);
      for (const x of passes.slice(0, 8)) out.push(row(x.name, x.ms, p.gpu.ms, x.parts.filter((q) => q.name !== x.name).map((q) => `${q.name}: ${fmtMs(q.ms)}`).join('\n')));
      if (passes.length > 8) out.push(`<div class="st-more">${passes.length - 8} more · ${fmtMs(passes.slice(8).reduce((a, x) => a + x.ms, 0))}</div>`);
    }
  }
  if (film) out.push(`<button class="btn" data-act="profile" ${ST.busy ? 'disabled' : ''}>Profile this frame</button>`);
  const html = out.join('');
  if (html !== ST.html) { statsEl.innerHTML = html; ST.html = html; }
}
statsEl.onclick = (e) => {
  if (e.target.closest('[data-act=profile]')) profileFrame();
  const rt = e.target.closest('[data-act=rt]');
  if (rt) pinTip(rt);
};
async function profileFrame() {
  const f = frameAt(S.t), key = `${S.film.gen}|${liveKey()}|${S.film.look}`;
  ST.busy = true;
  try {
    const r = await post('api/profile', { t: f / (S.doc.fps || 60), draft: draftNow() }), p = await r.json();
    if (!r.ok) throw new Error(p.error || r.statusText);
    ST.now = { f, key, p };
  } catch (e) { toast(`The frame was not profiled: ${e.message}`); } finally { ST.busy = false; }
}
// ---------- the viewer's look (Blender's viewport shading): Accurate (the film as it renders: drafts, masters and what
// agents see are always this), Fast (nothing traced, one sub-frame: no motion blur or depth of field), Solid (each mesh
// matte in its own colour, a plain studio's light), Wire (meshes' edges, layers' outlines). Each keeps its own frames,
// so going back is instant; kept for this machine. Z steps through them.
const LOOK_NAMES = { accurate: 'Accurate', fast: 'Fast', solid: 'Solid', wire: 'Wire' };
// (the look asked for, until the studio says it shows it: the editor's own film draws in it at once, not a round trip to
// the studio later, its frames coming from the studio's cache of it once it does)
let lookAsked = null;
const lookNow = () => { if (lookAsked && (S.film.look ?? 'accurate') === lookAsked) lookAsked = null; return lookAsked ?? S.film.look ?? 'accurate'; };
function setLook(l) {
  try { localStorage.setItem('nle:look', l); } catch {}
  lookAsked = l;
  // (the director's view drawn again, in it)
  post('api/look', { look: l }).then(() => { D.sent = ''; D.buf.clear(); drawn = null; }).catch(() => { if (lookAsked === l) lookAsked = null; });
  for (const b of $('#looks').querySelectorAll('[data-look]')) b.classList.toggle('on', b.dataset.look === l);
}
// the look the viewer's frames are of (the studio says): the buttons as it is
function lookShown() { for (const b of $('#looks').querySelectorAll('[data-look]')) b.classList.toggle('on', b.dataset.look === (S.film.look ?? 'accurate')); }
$('#looks').onclick = (e) => { const b = e.target.closest('[data-look]'); if (b) setLook(b.dataset.look); };
// ---------- the director's view: the scene at the playhead from a camera of your own, outside the film's (orbit, pan,
// dolly), rendered by the studio on request (a worker of its own, ~30 ms a frame); the film's camera is drawn in —
// where it is now and what it frames (its frustum), and its path through the film
// (two requests in flight, so the studio renders the next while this one travels; half size while the camera moves)
const D = { view: 'film', lock: false, cam: null, img: null, imgCam: null, conv: null, inflight: 0, seq: 0, shownSeq: 0, moved: 0, sent: '', path: null, pathGen: null, drag: null, error: '',
  // while playing: frames at and just ahead of the playhead, rendered in parallel (frame → { bmp, cam, t, seq }); the one
  // shown (shownF, its request shownS) and the last asked for (sentF, from sentCam); those under way (asked)
  buf: new Map(), bufGen: null, rtt: null, playing: 0, shownF: null, shownS: null, sentF: null, sentCam: null, asked: new Set() };
// (the studio's director worker's questions about the film — the objects, lanes… — seconds each on a heavy film: no more than
// three are asked at once, so that the browser's six connections to the studio keep room for the rest, a save, the history
// or a restore, which would otherwise wait behind them; and for what the director is waiting on, a pick or where the
// selection is, which is never held back by them)
const DIRECTED = /^api\/(objects|lanes|samples|lights|profile|director\/path|stacks|track|passes)$/, directed = { n: 0, waiting: [] };
const nextDirected = () => { while (directed.n < 3 && directed.waiting.length) { directed.n++; directed.waiting.shift()(); } };
function post(url, body) {
  // (the editor's own film answers what it can, here: nle/viewport.js)
  const own = viewport.answer(url, body);
  if (own) return own;
  const ask = () => linkFetch(url, { method: 'POST', body: JSON.stringify(body) });
  if (!DIRECTED.test(url) || body?.at != null) return ask();   // (one moment's lanes: over at once, and the gizmo waits on them)
  return new Promise((go) => { directed.waiting.push(go); nextDirected(); }).then(() => ask().finally(() => { directed.n--; nextDirected(); }));
}
function setView(v) {
  D.view = v; drawn = null; VP.gesture = false;
  convergeFor('');
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === v);
  $('#screen').classList.toggle('director', v === 'director');
  placeFrame();   // (the Director view's picture covers the screen; the film's fits inside it)
  $('#directorHint').hidden = v !== 'director';
  $('#lockBtn').hidden = v !== 'director';
  overlaysShown();
  addRowShown();
  if (v === 'director') { D.sent = ''; if (!D.cam) frameFilmCamera(); if (D.img) paintDirector(); }
}
for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => setView(b.dataset.view);
// the director's camera where it shows the film's, from a little further back and off to the side (a film that does
// not start, or takes over a minute to: said, and tried again when the film changes, or on F)
async function frameFilmCamera() {
  D.error = '';
  try {
    // (asked of the editor's own film where it is up, as the rest is: post; of the studio otherwise, a minute at most)
    const body = { times: [frameAt(S.t) / (S.doc.fps || 60)] };
    const r = await (viewport.answer('api/director/path', body) ?? linkFetch('api/director/path', { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }));
    const b = await r.json();
    if (!r.ok || !Array.isArray(b)) throw new Error(b?.error || r.statusText);
    const p = b[0];
    D.cam = { ...p.camera, zoom: p.camera.zoom * 0.45, yaw: p.camera.yaw + 30, pitch: p.camera.pitch - 15, roll: 0 };
  } catch (e) { D.error = `The director's view could not start: ${e.name === 'TimeoutError' ? 'the project took over a minute to answer' : e.message}`; D.errorGen = S.film.gen; }
}
// the film camera's path: a pose every ~1/12 s (at most 1200), again whenever the film changes
async function loadPath() {
  const gen = S.film.gen, end = S.film.duration || S.end(), n = Math.min(1200, Math.max(2, Math.ceil(end * 12)));
  D.pathGen = gen;
  try { D.path = await (await post('api/director/path', { times: Array.from({ length: n + 1 }, (_, i) => (i / n) * end) })).json(); if (D.img) paintDirector(); }
  catch { D.pathGen = null; }
}
function director() {
  const msg = (html) => { if (screenMsg.innerHTML !== html) screenMsg.innerHTML = html; screenMsg.classList.toggle('black', !!html && !D.img); };
  badge.hidden = true;
  if (D.error && D.errorGen !== S.film.gen && !D.cam) frameFilmCamera();   // (the film changed: again)
  if (D.error) return msg(`<b>${esc(D.error)}</b><span>Tried again when the project changes · F: now</span>`);
  if (!D.cam) return msg('<b>Opening the director’s view…</b>');
  lockSync();
  if (D.pathGen !== S.film.gen) loadPath();
  if (viewport.draws) return ownDirector(msg);
  if (D.own) { D.own = false; $('#screen').classList.remove('own'); }   // (the film did not start in the editor: the studio draws it)
  if (audio.playing) return directorPlay();
  D.shownF = null; D.sentF = null;
  const t = frameAt(S.t) / (S.doc.fps || 60), scale = performance.now() - D.moved < 250 ? Math.max(0.25, viewSize() / 2) : viewSize();
  const key = JSON.stringify([t, D.cam, S.film.gen, S.film.look, scale, liveKey()]);
  if (D.inflight < 2 && key !== D.sent) {
    const cam = { ...D.cam }, seq = ++D.seq;
    D.inflight++; D.sent = key;
    ask('director', { t, camera: cam, scale, draft: draftNow() }, scale < 1)
      .then((bmp) => {
        if (seq < D.shownSeq) { bmp.close(); return; }   // an older view, overtaken
        D.shownSeq = seq; D.img?.close(); D.img = bmp; D.imgCam = cam; D.imgT = t;
        if (D.view === 'director') paintDirector();
      })
      .catch((e) => { D.sent = ''; console.warn('director', e); })
      .finally(() => { D.inflight--; });
  }
  directorConverged(t, scale === viewSize() && key === D.sent && !D.inflight);
  msg(D.img ? '' : '<b>Rendering…</b>');
}
// The Director view drawn by the editor's own film (nle/viewport.js), onto its own canvas under this one, which keeps the
// film camera's path and frustum (paintDirector) and the overlays over it: told what to show as that changes (each
// display frame; the same is said once). A quick frame while it moves or plays, smaller; at rest drawn on (Converge) to
// 256 sub-frames, Q held showing its first. Each frame it shows comes back (ownShown) with the camera it is of.
// the moment asked of the editor's own film not shown yet, a third of a second on: said over the picture, as the studio's
// workers' frames were (what the film says it is doing, VP.working; its shaders compiling have a badge of their own), and
// once it is shown, how long it took, lingering. Not while playing (the badge says how fast it plays)
const OWN_LATE = { since: 0, t: null };
function ownLate() {
  const w = !audio.playing && viewport.late, now = performance.now();
  if (w) { if (!OWN_LATE.since || OWN_LATE.t !== w.t) { OWN_LATE.since = now - w.ms; OWN_LATE.t = w.t; } }   // (timed from the moment asked last)
  else { if (OWN_LATE.since && now - OWN_LATE.since > 300) linger(noticeEl, `<b>Updated · ${((now - OWN_LATE.since) / 1000).toFixed(1)} s</b>`); OWN_LATE.since = 0; VP.working = null; }
  if (!w || w.ms < 300) return '';
  if (noticeEl.innerHTML) unlinger(noticeEl);
  return `Drawing ${D.view === 'director' ? 'the view' : `frame ${w.f ?? frameAt(w.t)}`}${VP.working ? ` · ${VP.working}` : ''} · ${(w.ms / 1000).toFixed(1)} s`;
}
function ownDirector(msg) {
  if (!D.own) { D.own = true; $('#screen').classList.add('own'); }
  const fps = S.doc.fps || 60, t = frameAt(S.t) / fps, quick = audio.playing || VP.gesture || S.dragging || performance.now() - D.moved < 250;
  // (locked and playing: the film camera's own view at each frame, as the film has it there; camSeq: the last of the
  // viewport's own moves of the view this has heard of, so that one it made since is not undone)
  viewport.view({ view: 'director', t, camera: D.lock && audio.playing ? 'film' : { ...D.cam }, camSeq: D.camSeq ?? 0, look: lookNow(), scale: quick ? Math.max(0.25, viewSize() / 2) : viewSize(), draft: draftNow(),
    playing: audio.playing, n: CV.on && !quick && !CV.flip ? 256 : 1, place: D.place, frame: D.frame, stats: ST.shown, cache: cacheState() });
  msg(D.ownShown ? '' : '<b>Rendering…</b>');
  const c = D.ownShown, text = ownLate() || (!CV.on || !c || c.sub < 2 ? '' : CV.flip ? 'One sub-frame' : c.done < c.sub ? `Converging · ${c.done} / ${c.sub}` : `${c.sub} sub-frames`);
  badge.hidden = !text;
  if (text && badge.textContent !== text) badge.textContent = text;
}
function ownShown(e) {
  // (what drawing it took, Stats on: kept while the frame shown is the same one, drawn on)
  const which = e.f ?? JSON.stringify([e.t, e.camera]);
  if (e.profile || D.ownTook?.which !== which) D.ownTook = e.profile ? { which, p: e.profile } : null;
  D.ownShown = e; D.imgCam = e.camera; D.imgT = e.t;
  window.__shown = (window.__shown ?? 0) + 1; window.__lastShown = e;   // (counted, and the last kept, for the tests)
  if (audio.playing) PLAY.drew.push(performance.now());
  if (D.view === 'director') paintDirector();
  paintObjects();
}
// The Preview drawn by the editor's own film (engine/runtime.js preview): the film's frame at the playhead through its own
// camera, from the cache it reads itself (the frames' states and sizes here, and whether they are of the timeline as the
// editor has it) or drawn there; converging as the director's view does (Q held: the film's own)
const viewerUrl = () => { const u = new URL('api/viewer', location.href); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; return u.href; };
// what the editor's own film needs of the cache in either view, to read its frames and give it those it draws: its
// socket, its frames' states and sizes, whether they are of the timeline as the editor has it (ok; key: the studio's), and
// how it keeps them (the timeline's samples and shutter, the Preview's size); Pre-render, whether it fills the rest
const cacheState = () => { const P = S.film; return { studio: viewerUrl(), gen: P.gen, ok: P.key == null || P.key === liveKey(), key: P.key, frames: P.frames, sizes: P.sizes, prerender: !!P.prerender,
  samples: samplesOf(S.doc).viewer, shutter: (S.doc.shutter ?? 180) / 360, fps: S.doc.fps || 60, scale: viewSize() }; };
function ownPreview(msg, badgeText) {
  if (!D.own) { D.own = true; $('#screen').classList.add('own'); g2.clearRect(0, 0, frameEl.width, frameEl.height); drawn = null; }
  const P = S.film, fps = S.doc.fps || 60, f = frameAt(S.t);
  viewport.view({ view: 'film', t: f / fps, f, look: lookNow(), playing: audio.playing, every: PLAY.every,
    n: CV.on && !CV.flip ? 256 : 0, place: D.place, draft: draftNow(), stats: ST.shown, cache: cacheState() });
  const c = D.ownShown;
  if (P.error && !c) { badgeText(''); return msg(`<b>${esc(P.error.split('\n')[0])}</b><span>${esc(P.error.split('\n').slice(1).join(' ').trim().slice(0, 300))}</span>`, true); }
  if (!c) { badgeText(''); return msg('<b>Rendering…</b>', true); }
  msg('');
  badgeText(audio.playing ? playRate() : ownLate() || (!CV.on || c.sub < 2 ? '' : CV.flip ? 'The film’s own' : c.done < c.sub ? `Converging · ${c.done} / ${c.sub}` : `${c.sub} sub-frames`));
}
// What the editor's own film says of its viewport, the Director view drawn there (engine/viewport.js): a frame shown, what
// a click picked, the view moved, a gesture's values, a point on the path gone to, the things selected as the frame
// shown has them, a key it did not take, something dragged in, the pointer over it or not. Each the editor's to make
// its own: the selection, the timeline's edits and the toolbar are its
const VP = { gesture: false, moving: false };
function viewportEvent(event, d) {
  switch (event) {
    case 'shown': return ownShown(d);
    case 'picked': return picked(d.r, d.x, d.y, d.add, d.t);
    case 'camera': D.cam = d.cam; D.camSeq = d.seq; D.moved = performance.now(); VP.moving = !d.done; if (d.done && D.lock) lockCommit(); return;
    case 'gizmo': return viewport.committed(commitGesture(d.vals, null, d.v0));
    case 'point': { const p = PATH.pts[d.i]; if (p) goToPoint(p); return; }
    case 'now': OL.at.clear(); OL.at.set(frameAt(d.t), d); return showOverlays(d);
    case 'key': return keyFromViewport(d);
    case 'gesture': VP.gesture = d.on; if (!d.on) { $('#inspector').dataset.obj = ''; inspector(); } return paintBar();
    case 'dragging': return inspectorDragging(d.vals);
    case 'toast': return toast(d.text);
    case 'drag': return bodyClass('dropping', true);
    case 'compiling': return compilingShown(d);
    case 'working': VP.working = d.what || null; return;   // (what the film is doing for the frame asked: ownLate)
    case 'draws': return sendView();
    case 'over': GZ.over = d.on; return;
  }
}
// a gesture's values as it goes in the viewport, in the inspector's fields (rebuilt as they are when it ends)
function inspectorDragging(vals) {
  const el = $('#inspector');
  for (const [k, v] of Object.entries(vals)) { const f = el.querySelector(`input[type="number"][name="${k}"]`); if (f) f.value = +(+v).toFixed(3); }
}
// a key pressed while the editor's film has the focus (it was clicked last), which its viewport did not take: the editor's
function keyFromViewport(d) {
  const r = $('#screen').getBoundingClientRect();
  if (d.client) GZ.client = { x: r.left + d.client[0], y: r.top + d.client[1] };
  dispatchEvent(new KeyboardEvent(d.type, { key: d.key, code: d.code, shiftKey: d.shiftKey, ctrlKey: d.ctrlKey, altKey: d.altKey, metaKey: d.metaKey, repeat: d.repeat, cancelable: true }));
}
// the view at rest (rested: its frame the last asked for, at its full size, and here), drawn on as a paused frame of the
// film's is, the count in the badge; the picture repainted as it comes, or where Q or the button changes which shows
// (not where the view itself changed: what shows stays until its new frame comes, the one before it being older still)
function directorConverged(t, rested) {
  const key = hashKey(JSON.stringify([t, D.cam, S.film.gen, S.film.look, viewSize(), liveKey()])), same = key === CV.key;
  convergeFor(key);
  if (CV.on && rested && !D.drag && !gizmo.active && !S.dragging) convergeOn(key, { t, camera: { ...D.cam } });
  const pic = directorPicture();
  if (pic !== D.conv) { D.conv = pic; if (D.img && (pic || same || !CV.on)) paintDirector(); }
  const text = !CV.on || CV.sub < 2 ? '' : CV.flip ? 'One sub-frame' : CV.done < CV.sub ? `Converging · ${CV.done} / ${CV.sub}` : `${CV.sub} sub-frames`;
  badge.hidden = !text;
  if (text && badge.textContent !== text) badge.textContent = text;
}
// the converged picture to show over the view's own one sample; null: its own
const directorPicture = () => (CV.on && convergedEnough() ? CV.pic.bmp : null);
// playing: you can move the camera while it plays. Each frame is asked for where the playhead will be when it comes back
// (a round trip ahead), from the camera as it is then: again when the camera moves or the playhead reaches another
// frame, at most once a display frame and four at a time, at half size; the studio renders them on as many workers as it
// has. The newest asked at or before the playhead is shown (never a frame before the one shown), so the picture follows
// your hand one round trip behind. Playing every frame, the next three are asked for, and the playhead waits for each.
// (Asking further ahead showed the camera as it was that far back: at 24 fps, a third of a second.)
function directorPlay() {
  const fps = S.doc.fps || 60, f = frameAt(S.t), end = Math.floor((S.film.duration || S.end()) * fps);
  const bufGen = `${S.film.gen}|${liveKey()}`;
  if (D.bufGen !== bufGen) { for (const b of D.buf.values()) b.bmp.close(); D.buf.clear(); D.bufGen = bufGen; D.sentF = null; D.shownF = null; }
  for (const [k, b] of D.buf) if (k < f - 2) { b.bmp.close(); D.buf.delete(k); }
  if (D.shownF != null && D.shownF > f) D.shownF = null;   // (the playhead went back)
  let best = null;
  for (const [k, b] of D.buf) if (k <= f && k >= (D.shownF ?? -1) && (best == null || b.seq > best.b.seq)) best = { k, b };
  // (the overlays are drawn from the camera of the picture shown: D.imgCam)
  if (best && (best.k !== D.shownF || best.b.seq !== D.shownS)) { D.shownF = best.k; D.shownS = best.b.seq; D.imgCam = best.b.cam; D.imgT = best.b.t; paintDirector(best.b.bmp, best.b.cam, best.b.t); }
  if (D.playing >= 4) return;
  let i = null;
  if (PLAY.every) { for (let k = f + 1; k <= Math.min(end, f + 3); k++) if (!D.buf.has(k) && !D.asked.has(k)) { i = k; break; } }
  else if ((i = Math.min(end, frameAt(S.t + (D.rtt ?? 120) / 1000))) === D.sentF && D.cam === D.sentCam) i = null;
  if (i == null) return;
  const cam = { ...(D.lock && OL.at.get(i)?.camera.camera || D.cam) }, t = i / fps, sent = performance.now(), gen = D.bufGen, seq = ++D.seq;
  D.playing++; D.asked.add(i); D.sentF = i; D.sentCam = D.cam;
  ask('director', { t, camera: cam, scale: Math.max(0.25, Math.min(0.5, viewSize())), ahead: true, draft: draftNow() }, true)
    .then((bmp) => {
      D.rtt = 0.8 * (D.rtt ?? 120) + 0.2 * (performance.now() - sent);
      // (one asked after it for the same frame, from a camera moved since, has the place)
      const had = D.buf.get(i);
      if (gen === D.bufGen && i >= frameAt(S.t) - 2 && !(had && had.seq > seq)) { had?.bmp.close(); D.buf.set(i, { bmp, cam, t, seq }); } else bmp.close();
    })
    .catch(() => {})
    .finally(() => { D.playing--; D.asked.delete(i); });
}
// a picture and, drawn with the camera it was rendered from, the film's camera: its path, and its frustum then
function paintDirector(img = directorPicture() ?? D.img, cam = D.imgCam, imgT = D.imgT) {
  const w = frameEl.width, h = frameEl.height;
  if (D.own) g2.clearRect(0, 0, w, h);   // (the editor's own film draws the picture, under this: ownDirector)
  else { g2.drawImage(img, 0, 0, w, h); ST.bmp = img === CV.pic?.bmp ? D.img : img; }
  ST.f = frameAt(imgT);
  if (!cam) return;
  drawn = null;
}
// orbit (drag), pan (right- or Shift-drag), dolly (wheel), always about the director camera's target
{
  const scr = $('#screen');
  scr.addEventListener('pointerdown', (e) => {
    if (D.view !== 'director' || D.own || !D.cam || e.target.closest('#cueOverlay, .stats, .obj-bar, .add-row') || e.target.closest('.gz') || gizmo.active) return;
    e.preventDefault(); scr.setPointerCapture(e.pointerId);
    D.drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey, cam: { ...D.cam } };
  });
  scr.addEventListener('pointermove', (e) => {
    if (!D.drag) return;
    const dx = e.clientX - D.drag.x, dy = e.clientY - D.drag.y, c = { ...D.drag.cam };
    if (!D.drag.pan) { c.yaw -= dx * 0.3; c.pitch = Math.max(-89, Math.min(89, c.pitch + dy * 0.3)); }
    else {
      const B = basis(D.drag.cam), s = FW / frameEl.clientWidth / c.zoom;   // world px per screen px, at the target
      for (const [j, a] of [[0, 'x'], [1, 'y'], [2, 'z']]) c[a] = (c[a] ?? 0) - (B.right[j] * dx + B.down[j] * dy) * s;
    }
    D.cam = c; D.moved = performance.now(); D.drag.moved = true;
  });
  const end = () => { const was = D.drag; D.drag = null; if (was?.moved && D.lock) lockCommit(); };
  scr.addEventListener('pointerup', end); scr.addEventListener('pointercancel', end);
  scr.addEventListener('contextmenu', (e) => { if (D.view === 'director') e.preventDefault(); });
  scr.addEventListener('wheel', (e) => {
    if (D.view !== 'director' || D.own || !D.cam) return;
    e.preventDefault(); D.cam = { ...D.cam, zoom: D.cam.zoom * Math.exp(-e.deltaY * 0.0015) }; D.moved = performance.now();
    if (D.lock) { D.wheeling = true; clearTimeout(D.wheelTimer); D.wheelTimer = setTimeout(() => { D.wheeling = false; lockCommit(); }, 300); }
  }, { passive: false });
}
// ---------- Lock to view (as Blender's Lock Camera to View): the Director view is the project camera's, and orbiting,
// panning and dollying it move that camera at the playhead (each gesture one change, into the lane selected: the
// gizmo's rule, lanes.intoLane). Scrubbing and playing, the view follows the camera
function setLock(on) {
  D.lock = on;
  $('#lockBtn').classList.toggle('on', on);
  if (on && D.view !== 'director') setView('director');
  if (on) { D.sent = ''; lockSync(); }
  placeFrame(); drawn = null;
  paintBar(); paintObjects();
  if (D.img) paintDirector();
}
$('#lockBtn').onclick = () => setLock(!D.lock);
// the view as the camera is at the frame shown (as the overlays of that frame have it, with the changes not yet saved),
// but not while the view is being moved, nor before the overlays after a change have come
function lockSync() {
  if (!D.lock || D.drag || D.wheeling || VP.moving) return;
  const c = OL.at.get(frameAt(S.t))?.camera?.camera;
  if (c && JSON.stringify(c) !== JSON.stringify(D.cam)) D.cam = { ...c };
}
// the view (an orbit camera, as lens.js asOrbit gives any camera) as the values of the project camera's own channels,
// whatever its kind: those that changed
function viewAsCamera(v, pose) {
  const B = basis(v), kind = pose.kind ?? 'orbit', now = (k) => lanes.shown('camera', k);
  let out;
  if (kind === 'orbit') out = { x: v.x, y: v.y, z: v.z, zoom: v.zoom, yaw: v.yaw, pitch: v.pitch, roll: v.roll };
  else if (kind === 'free') out = { x: B.eye[0], y: B.eye[1], z: B.eye[2], yaw: v.yaw, pitch: v.pitch, roll: v.roll };
  else {
    // (what a target camera faces: as far ahead of it as it was)
    const T = [now('tx'), now('ty'), now('tz')].map((x) => x ?? 0), dist = Math.hypot(...pose.eye.map((e, j) => e - T[j])) || 1;
    out = { x: B.eye[0], y: B.eye[1], z: B.eye[2], tx: B.eye[0] - B.back[0] * dist, ty: B.eye[1] - B.back[1] * dist, tz: B.eye[2] - B.back[2] * dist, roll: v.roll };
  }
  return Object.fromEntries(Object.entries(out).filter(([k, x]) => { const n = now(k); return n != null && Math.abs(x - n) > 1e-4 * Math.max(1, Math.abs(n)); }).map(([k, x]) => [k, Math.round(x * 1000) / 1000]));
}
function lockCommit() {
  const pose = OL.at.get(frameAt(S.t))?.camera ?? OL.shown?.camera;
  if (!D.lock || !pose || !D.cam) return;
  const vals = viewAsCamera(D.cam, pose);
  if (!Object.keys(vals).length) return;
  const e = lanes.valueEdits('camera', vals, { into: true });
  if (!e) return toast('Its lanes are not ready yet: try again in a moment');
  if (e.error) { toast(e.error); D.cam = { ...pose.camera }; return; }
  edit(e.desc, e.fn);
  OL.at.clear(); OL.key = '';   // (the overlays again, of the camera as it is now: until then the view stays where you put it)
  toast(e.desc);
}
let viewK = 1;   // (frame px per screen px: the overlays' handles keep their size on the screen)
function placeFrame() {
  // the film's frame, as its timeline says (size: [w, h]; FW × FH are it, here and in the film's page)
  const [fw, fh] = S.doc?.size ?? [1920, 1080];
  if (fw !== FW || fh !== FH) { try { setFrame([fw, fh]); } catch { /* not a size: the frame stays */ } $('#objOverlay').setAttribute('viewBox', `0 0 ${FW} ${FH}`); drawn = null; VS.view = ''; clearTimeout(sizeTimer); sizeTimer = setTimeout(sendSize, 250); }
  // the picture at the frame's shape inside the screen, at the display's resolution. The Director view is yours and frames
  // nothing, so its picture covers the screen at the film's scale, the screen's own shape of it drawn (D.frame). Locked to
  // the project camera, it frames the film, whole
  const sc = $('#screen'), w = sc.clientWidth, h = sc.clientHeight, pw = (D.view === 'director' && !D.lock ? Math.max : Math.min)(w, (h * FW) / FH), ph = (pw * FH) / FW, dpr = devicePixelRatio || 1;
  Object.assign(frameEl.style, { left: `${(w - pw) / 2}px`, top: `${(h - ph) / 2}px`, width: `${pw}px`, height: `${ph}px` });
  D.place = { left: (w - pw) / 2, top: (h - ph) / 2, width: pw, height: ph };
  // (the part of it the screen shows, px of the film's frame: all the editor's own film draws of the Director view, of
  // its own shape)
  D.frame = pw > w + 0.5 || ph > h + 0.5 ? [Math.min(FW, Math.round((FW * w) / pw)), Math.min(FH, Math.round((FH * h) / ph))] : null;
  Object.assign($('#badges').style, { right: `${Math.max(0, (w - pw) / 2) + 8}px`, top: `${Math.max(0, (h - ph) / 2) + 8}px` });
  Object.assign($('#objOverlay').style, { left: `${(w - pw) / 2}px`, top: `${(h - ph) / 2}px`, width: `${pw}px`, height: `${ph}px` });
  viewK = FW / (pw || FW);
  const W2 = Math.round(pw * dpr), H2 = Math.round(ph * dpr);
  if (frameEl.width !== W2 || frameEl.height !== H2) { frameEl.width = W2; frameEl.height = H2; drawn = null; sendFit(); }
  return { w, h, pw, ph };
}
function filmChanged() {
  filmKeys();
  const P = S.film, el = $('#draftInfo'), n = P.frames.length;
  let ready = 0, changed = 0;
  for (let i = 0; i < n; i++) { const s = P.frames.charCodeAt(i); if (s >= 50) ready++; if (s === 51) changed++; }
  el.classList.toggle('bad', !!P.error);
  // (how many dynamic chose: a number of your own says itself)
  // (dynamic: how many the crew is now, the editor's own film the first where it draws, as the setting counts them)
  const k = (P.workers ?? 0) + (viewport.draws ? 1 : 0);
  const crew = P.working && P.workers && $('#workersSel').value === 'dynamic' ? `<span class="wk">${k} worker${k > 1 ? 's' : ''}</span>` : '';
  el.innerHTML = !S.url ? 'No project URL' : P.error ? '<b>Not rendering</b> details' : P.working || ready < n && P.prerender ? `<b>Rendering</b> ${ready} / ${n} frames${crew}` : ready < n ? `<b>Pre-render off</b> ${ready} / ${n} frames` : `<b>Up to date</b> ${n} frames${changed ? `<i>${changed} changed</i>` : ''}`;
  $('#preBtn').classList.toggle('on', P.prerender);
  el.title = P.error || (changed ? 'Highlighted on the Visual lane: the frames the latest change to the project altered' : '');
  el.onclick = P.error ? () => showLog(P.error) : null;
  tl.invalidate();
}
function renderState() {
  const r = S.render, el = $('#renderState'), busy = r.phase === 'rendering';
  $('#renderBtn').disabled = busy; $('#cancelBtn').hidden = !busy; pushMenus();
  $('#renderBtn').title = `Render a draft video with the music (R). If an in/out range is set, only that part is rendered.${S.draft ? `\nThe last one: ${f2(S.draft.from)}–${f2(S.draft.to)} s, ${new Date(S.draft.made).toLocaleString()}` : ''}`;
  el.className = 'render-state';
  if (busy) {
    const s = Math.round((Date.now() - r.started) / 1000), what = { frames: 'frames', sound: 'mixing sound', video: 'encoding' }[r.step] ?? '';
    el.innerHTML = `<span>Draft ${f2(r.from)}–${r.to != null ? f2(r.to) : 'end'} s</span><span class="bar"><i style="width:${Math.round(r.progress * 100)}%"></i></span><span>${what} ${Math.round(r.progress * 100)}% · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</span>`;
  } else if (r.phase === 'error') {
    el.className = 'render-state error'; el.innerHTML = '<span>Draft failed — details</span>';
    el.onclick = () => showLog(r.error);
  } else el.innerHTML = '';
}
function requestRender() {
  if (S.render.phase === 'rendering') return;
  if (!S.url) return toast('No project URL — set one in the timeline settings', true);
  linkFetch('api/render', { method: 'POST', body: JSON.stringify(S.range ? { from: S.range.a, to: S.range.b } : {}) });
}
$('#renderBtn').onclick = requestRender;
$('#cancelBtn').onclick = () => linkFetch('api/render/cancel', { method: 'POST' });
setInterval(() => { if (S.render.phase === 'rendering') renderState(); }, 1000);

// ---------- objects: click one in the viewer (either camera) to select it — what it is, the line of the film's code
// that placed it, where it is now — and annotate it: a cue pinned to it (cue.on), read by the film's agent with the rest.
// The studio finds what is under the click (api/pick) and the same thing again at each frame shown (api/overlays), by
// where the film's code placed it.
const O = { sel: null, now: null, t: 0, down: null, code: new Map(), codeGen: null, show: null, also: [], alsoNow: [], asked: 0 };
// several things selected (docs/selection.md): O.sel is the one clicked last (its values in the inspector, its lanes, the
// gizmo's), O.also the others (each as O.sel is: a copy, or an object whole), O.alsoNow each as the frame shown has it
const refOf = (x) => ({ at: x.at, nth: x.nth, key: x.key, like: x.like, copy: x.copy, ...(x.sites && { sites: x.sites }) });
// (the same thing: the same object whole, or the same copy)
const sameThing = (a, b) => !!a && !!b && (a.sites || b.sites ? !!a.sites && !!b.sites && objectOf(a.at) === objectOf(b.at) : a.at === b.at && (a.nth ?? 0) === (b.nth ?? 0) && JSON.stringify(a.key) === JSON.stringify(b.key));
// r added to the things selected (the one clicked last), or, selected already, taken out
function addThing(r) {
  const was = [O.sel, ...O.also].filter(Boolean), i = was.findIndex((x) => sameThing(x, r));
  if (i >= 0) { dropAddedClips([was[i]]); was.splice(i, 1); O.sel = was.pop() ?? null; O.now = O.sel ? (sameThing(O.sel, O.now) ? O.now : null) : null; O.also = was; }
  else { O.also = was; O.sel = r; if (r.clip && r.added) S.sel = new Set([...S.sel, r.clip]); }
  O.alsoNow = [];
}
const ovl = $('#objOverlay');
// the film's objects (api/objects: engine/runtime.js __objects): each a thing the code defines with every line that
// places it, and all one line places (a loop's, a many()'s copies), as one. A click in the viewer selects the object
// whole first (O.sel.sites: its lines; O.sel itself the copy clicked, what its values and lanes are read from), and a
// second click on one of its copies, or the chip by the pointer, that copy alone; the timeline lists them
const OBJ = { list: [], by: new Map(), key: '', listed: false, asking: false };   // (asking: the film asked, not answered yet)
const objectOf = (at) => {
  if (!at) return null;
  if (at.startsWith('clip:')) { const c = addedClips(S.doc).find((x) => `clip:${x.id}` === at); return c ? objectOfClip(c) : null; }
  return OBJ.by.get(at) ?? null;
};
// an added thing as an object: from the timeline as it is now, so its row follows a drag at once (its copies, as the film
// last said: a linked copy has as many as what it copies)
function objectOfClip(c) {
  const th = c.thing, at = `clip:${c.id}`, listed = OBJ.by.get(at);
  return { id: at, clip: c, type: th.type, linked: !!th.of, label: th.label ?? listed?.label ?? 'Thing', kind: isLightType(th.type) ? 'light' : listed?.kind ?? (th.transmissionWeight ? 'glass' : 'mesh'), sites: [at], spans: [[c.at, clipEnd(c)]], copies: listed?.copies ?? OBJ.by.get(th.of?.sites?.[0])?.copies ?? 1, file: null, line: null, picked: S.sel.has(c.id) };
}
// (an object with more than one copy, or more than one line placing it: selected whole first)
const isMany = (o) => !!o && (o.copies > 1 || o.sites.length > 1);
function followObjectList() {
  const f = S.film, k = JSON.stringify([f.gen, f.loaded, f.duration, f.cuts, f.fps]);
  if (k === OBJ.key || f.duration == null || !S.url) return;
  OBJ.key = k; OBJ.asking = true; tl.relayout();
  // (not answered: the film loaded again meanwhile, say; asked again a moment later, the Objects row saying so meanwhile)
  const again = () => { if (OBJ.key !== k) return; OBJ.asking = false; tl.relayout(); setTimeout(() => { if (OBJ.key === k) OBJ.key = ''; }, 2000); };
  post('api/objects', { duration: f.duration, fps: Math.min(24, f.fps || 24), cuts: f.cuts ?? [] }).then((r) => r.json()).then((list) => {
    if (OBJ.key !== k) return;
    if (!Array.isArray(list)) return again();
    OBJ.list = list.filter((o) => !o.added); OBJ.by = new Map(list.flatMap((o) => o.sites.map((at) => [at, o]))); OBJ.listed = true; OBJ.asking = false;
    // (a whole object selected keeps its lines as the list now has them)
    const o = O.sel?.sites && objectOf(O.sel.sites.find((at) => objectOf(at)));
    if (o) O.sel = { ...O.sel, sites: o.sites, object: o.label };
    tl.relayout(); tl.invalidate(); if (O.sel) inspector();
  }).catch(again);
}
const frameTime = () => frameAt(S.t) / (S.doc.fps || 60);
const viewCam = () => (D.view === 'director' ? D.imgCam : null);
// a click (not a drag) on the picture: what is there
{
  const scr = $('#screen');
  // (the Director view drawn by the editor's own film: its pointer is its own, engine/viewport.js)
  scr.addEventListener('pointerdown', (e) => { O.down = D.own || e.target.closest('#cueOverlay, .stats, .obj-bar, .add-row') || e.button !== 0 ? null : { x: e.clientX, y: e.clientY }; });
  scr.addEventListener('pointerup', (e) => {
    const d = O.down; O.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    const r = frameEl.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    pickAt(((e.clientX - r.left) / r.width) * FW, ((e.clientY - r.top) / r.height) * FH, e.shiftKey || e.ctrlKey || e.metaKey);
  });
}
async function pickAt(x, y, add = false) {
  if (D.view === 'director' && !D.imgCam) return;
  const t = frameTime(), camera = viewCam();
  try {
    const r = await (await post('api/pick', { t, camera, x, y })).json();
    if (r?.error) throw new Error(r.error);
    picked(r, x, y, add, t);
  } catch (e) { toast(`Could not pick: ${e.message}`); }
}
// what a click at (x, y) of the frame at t picked (r; null: nothing there), selected
function picked(r, x, y, add, t) {
  // an object of many copies: whole, first (its copy clicked again, or the chip: that copy alone)
  // (a copy of the object selected, or of the one a copy is selected of: that copy, as a group's are once inside it)
  const o = r && objectOf(r.at), whole = isMany(o) && objectOf(O.sel?.at) !== o;
  // (Shift or Ctrl: added to the things selected, or taken out; nothing there: as it was)
  if (add) { if (!r) return; addThing(whole ? { ...r, sites: o.sites, object: o.label } : r); if (O.sel === r || O.sel?.at === r.at) O.now = r; O.t = t; lanes.clear(); tl.relayout(); panels(); paintObjects(); return; }
  // (nothing there: what was selected, its clip too, is no longer)
  if (!r) dropAddedClips();
  O.sel = whole ? { ...r, sites: o.sites, object: o.label } : r; O.now = r; O.t = t; O.also = []; O.alsoNow = [];
  if (r) { S.sel = new Set(r.added ? [r.clip] : []); lanes.clear(); linesOff(); }
  O.show = r ? { file: r.file, line: r.line } : null;
  tl.relayout(); panels(); paintObjects();
  pickChip(whole ? { x, y, r } : null);
}
function deselectObject() { dropAddedClips(); O.sel = O.now = O.show = null; O.also = []; O.alsoNow = []; pickChip(null); tl.relayout(); panels(); paintObjects(); }
// the selection whole (its object's every copy), or one copy of it (the copy it was read from: `copy`, as locate names it)
function selectWhole(o, copy = O.sel) {
  if (!o) return;
  O.sel = { ...(copy ?? {}), sites: o.sites, object: o.label, label: copy?.label ?? o.label, kind: copy?.kind ?? o.kind };
  pickChip(null); lanes.clear(); tl.relayout(); panels(); paintObjects();
}
function selectCopy(r) {
  if (!r) return;
  O.sel = { ...r }; delete O.sel.sites; delete O.sel.object; delete O.sel.count; delete O.sel.members;
  if (O.now) { O.now = { ...O.now }; delete O.now.sites; delete O.now.members; }
  pickChip(null); lanes.clear(); tl.relayout(); panels(); paintObjects();
}
// Esc: a copy of an object of many, back to the object whole; the object (or a thing alone), deselected
function escapeObject() {
  const o = !O.sel.sites && objectOf(O.sel.at);
  if (isMany(o)) selectWhole(o); else deselectObject();
}
// an object selected from the timeline (its row): whole, read from its first copy at the playhead, or (not in the scene
// there) the playhead at the nearest moment it is
async function selectObject(o, seekTo = null, keepLines = false, add = false) {
  if (!o.sites.length) return selectFilmThing(o.id, seekTo);
  if (seekTo != null) seek(seekTo);
  else if (!o.spans.some(([a, b]) => S.t >= a && S.t < b)) {
    const edge = o.spans.map(([a, b]) => (S.t < a ? a : Math.max(a, b - 1 / (S.doc.fps || 60)))).sort((a, b) => Math.abs(a - S.t) - Math.abs(b - S.t))[0];
    if (edge != null) { seek(edge); tl.reveal(edge); }
  }
  const t = frameTime(), camera = viewCam();
  // (not in the scene at the playhead: what the list says of it; a thing added by hand and alone is not a whole of many)
  const many = isMany(o), clipped = o.clip ? { clip: o.clip.id, added: true } : {};
  const known = { label: o.label, kind: o.kind, at: o.sites[0], nth: 0, file: o.file, line: o.line, ...clipped, ...(many || !o.clip ? { sites: o.sites, object: o.label } : {}) };
  // (what is added by hand is known here: selected at once, its row and toolbar not waiting on a frame being drawn; where it
  // is follows. A selection made since is the one that stands)
  const asked = add ? O.asked : ++O.asked;
  if (o.clip && !add) { S.sel = new Set([o.clip.id]); if (!keepLines) linesOff(); O.sel = known; O.now = null; O.also = []; O.alsoNow = []; O.t = t; pickChip(null); lanes.clear(); tl.relayout(); panels(); paintObjects(); }
  try {
    const r = await (await post('api/locate', { t, camera, sites: o.sites, draft: draftNow() })).json();
    if (r?.error) throw new Error(r.error);
    if (asked !== O.asked) return;
    const it = !r ? known : many ? { ...r, sites: o.sites, object: o.label } : r;
    const now = !r ? null : many ? { ...r, sites: o.sites } : r;
    if (add) { addThing(it); if (O.sel === it) O.now = now; }
    else { S.sel = new Set(o.clip ? [o.clip.id] : []); if (!keepLines) linesOff(); O.sel = it; O.now = now; O.also = []; O.alsoNow = []; }
    O.t = t; O.show = r ? { file: r.file, line: r.line } : null;
    pickChip(null); lanes.clear(); tl.relayout(); panels(); paintObjects();
  } catch (e) { toast(`Could not find it: ${e.message}`); }
}
// the film camera or the scene, from its row: selected, its lanes open (a click on its bar: the playhead there too)
function selectFilmThing(id, seekTo = null) {
  if (seekTo != null) seek(seekTo);
  const th = lanes.M.things.find((x) => x.id === id);
  if (th) th.open = true;
  lanes.select({ th: id });
}
// ---------- the toolbar by the selection: what can be done to it, each with its key, and the copy just clicked alone
const BAR = { el: document.createElement('div'), html: '', at: '', copy: null, t: 0 };
BAR.el.className = 'obj-bar'; BAR.el.hidden = true; $('#screen').append(BAR.el);
// (the copy a click on an object of many landed on: the toolbar offers it alone, for as long as the playhead stays)
function pickChip(at) { BAR.copy = at?.r ?? null; BAR.t = S.t; paintBar(); }
const barBtn = (act, ic, title, label = '', cls = '') => `<button class="obj-b${cls ? ` ${cls}` : ''}" data-act="${act}" title="${esc(title)}" aria-label="${esc(label || title)}">${icon(ic)}${label ? `<span>${esc(label)}</span>` : ''}</button>`;
// (the points on its path: the one before, the one after)
const pointBtns = () => barBtn('prevpt', 'caret-left', 'The point on its path before this one (↑): its key, or where its move lands') + barBtn('nextpt', 'caret-right', 'The point on its path after this one (↓)');
function barHtml() {
  if (!O.sel) {   // (the project camera, selected in the Director view)
    const pts = lanes.points('camera').length;
    return [`<span class="obj-name"><b>Camera</b></span>`, pts && `<span class="obj-g">${pointBtns()}</span>`,
      `<span class="obj-g">${barBtn('lock', 'video-camera', 'Lock to view: the view is the project camera’s, and orbiting, panning and dollying move it (at the playhead, into the lane selected)', 'Lock to view', D.lock ? 'on' : '')}</span>`,
      `<span class="obj-g">${barBtn('ask', 'chat-circle-text', `Ask ${panel.short} about it`)}</span>`].filter(Boolean).join('');
  }
  const s = O.sel, r = O.now ?? s, many = O.also.length, w = r.where ?? {}, placed = s.kind !== 'title' && (s.kind !== 'pass' || w.x != null), own = !s.clip || s.added;
  const light = s.kind === 'light', mesh = s.kind === 'mesh' || s.kind === 'glass', o = objectOf(s.at), hid = selectionHidden();
  const count = many ? `${many + 1} selected` : s.sites ? (O.now?.count ? `${O.now.count} copies` : 'every copy') : s.copies > 1 ? `copy ${(r.copy ?? s.copy) + 1} of ${r.copies ?? s.copies}` : '';
  const parts = [`<span class="obj-name"><b>${esc((s.sites && s.object) || s.label || o?.label || 'Object')}</b>${count ? `<i>${esc(count)}</i>` : ''}</span>`];
  const group = (...xs) => { const g = xs.filter(Boolean).join(''); if (g) parts.push(`<span class="obj-g">${g}</span>`); };
  group(placed && barBtn('focus', 'frame-corners', 'Frames it in the Director view (F)', 'Focus'), placed && barBtn('aim', 'video-camera', 'Points the project camera at it, at the playhead'));
  if (!many && pathThing() === 'sel' && lanes.points('sel').length) group(pointBtns());
  group(own && (placed || s.kind === 'title') && barBtn('duplicate', 'copy', 'A copy of it beside it (Shift+D)', 'Duplicate'));
  if (!many && (mesh || light)) {
    const c = mesh ? hexOf(r.material?.baseColor) : hexOf(w.color);
    group(`<label class="obj-color" title="Colour" style="--c:${esc(c)}"><input type="color" value="${esc(c)}" aria-label="Colour"></label>`,
      mesh && `<button class="obj-b" data-act="material" title="How its surface looks" aria-haspopup="menu"><span>Material</span>${icon('caret-down', true, 'obj-car')}</button>`,
      light && s.added && `<button class="obj-b" data-act="lighttype" title="What kind of light it is" aria-haspopup="menu"><span>${esc(ADD.find((a) => a.type === w.type)?.label ?? 'Light')}</span>${icon('caret-down', true, 'obj-car')}</button>`);
  }
  group(s.at && own && barBtn('hide', hid ? 'eye-slash' : 'eye', hid ? 'Show it (H)' : 'Hide it, from the film too (H)', '', hid ? 'on' : ''), s.added ? barBtn('delete', 'trash', 'Delete (Del)') : '');
  if (!many) group(s.sites && BAR.copy && barBtn('one', 'crosshair-simple', 'Select only the copy you clicked. Or click it again.', 'Select this copy'), !s.sites && isMany(objectOf(s.at)) && barBtn('all', 'stack', 'Select every copy (Esc)', 'Every copy'));
  group(barBtn('ask', 'chat-circle-text', `Ask ${panel.short} about it`));
  return parts.join('');
}
// the toolbar over what is selected, or under it where there is no room above; inside the viewer. Not while it plays or is
// being moved, and not over what is not on the frame
function paintBar() {
  const show = (!!O.sel || (pathThing() === 'camera' && D.view === 'director')) && !gizmo.active && !(D.own && VP.gesture) && !audio.playing && ovOn('bar');
  if (BAR.el.hidden === show) BAR.el.hidden = !show;
  if (!show) return;
  const html = barHtml();
  if (html !== BAR.html) { BAR.el.innerHTML = html; BAR.html = html; BAR.at = ''; }
  const fr = frameEl.getBoundingClientRect(), sr = $('#screen').getBoundingClientRect(), poly = selOutline();
  const cssX = (x) => fr.left - sr.left + (x / FW) * fr.width, cssY = (y) => fr.top - sr.top + (y / FH) * fr.height;
  let cx = sr.width / 2, top = 8;
  if (poly?.length) {
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]), a = cssY(Math.min(...ys)), b = cssY(Math.max(...ys));
    cx = cssX((Math.min(...xs) + Math.max(...xs)) / 2);
    top = a - BAR.el.offsetHeight - 10 >= 4 ? a - BAR.el.offsetHeight - 10 : Math.min(b + 10, sr.height - BAR.el.offsetHeight - 4);
  }
  const left = Math.max(4, Math.min(sr.width - BAR.el.offsetWidth - 4, cx - BAR.el.offsetWidth / 2));
  const at = `${Math.round(left)},${Math.round(top)}`;
  if (at !== BAR.at) { BAR.at = at; BAR.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`; }
}
BAR.el.addEventListener('pointerdown', (e) => e.stopPropagation());
BAR.el.addEventListener('pointerup', (e) => e.stopPropagation());
BAR.el.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  switch (b.dataset.act) {
    case 'focus': return focusSelection();
    case 'aim': return aimCamera();
    case 'duplicate': return duplicateThings();
    case 'hide': return hideSelection();
    case 'delete': return deleteSelection();
    case 'one': return selectCopy(BAR.copy);
    case 'all': return selectWhole(objectOf(O.sel.at));
    case 'ask': return panel.ask();
    case 'prevpt': return stepPoint(-1);
    case 'nextpt': return stepPoint(1);
    case 'lock': return setLock(!D.lock);
    case 'material': return openMenu(b, MATERIALS.map((m) => ({ label: m.label, act: () => setMaterial(m) })));
    case 'lighttype': return openMenu(b, ADD.filter((a) => a.light).map((a) => ({ label: a.label, checked: (O.now ?? O.sel).where?.type === a.type, act: () => setLightType(a.type) })));
  }
});
// (a colour picked: one change, when the picker settles)
BAR.el.addEventListener('change', (e) => { if (e.target.type !== 'color') return; if (O.sel.kind === 'light') setProp('color', e.target.value); else setBaseColor(e.target.value); paintBar(); });
// ---------- things added by hand (engine/things.js): each a clip of a track of their own
const thingsTrack = (d) => { let t = d.tracks.find((x) => x.things); if (!t) d.tracks.push((t = { id: 'things', name: 'Added', kind: 'visual', things: true, clips: [] })); return t; };
// a name not yet taken among them: "Cube", then "Cube 2"
function freshLabel(base) {
  const taken = new Set(addedClips(S.doc).map((c) => c.thing.label));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
/** A thing added where the viewer's camera looks, for the film's length, selected. */
function addNew(type) {
  const cam = overlayCam(), a = ADD.find((x) => x.type === type);
  if (!cam) return toast('A moment: the camera is still loading');
  const id = newId('c'), label = freshLabel(a.light ? a.label.replace(/ light$/, '') : a.label), end = r6(Math.max(1, S.film.duration ?? S.end()));
  const { w, h, pw, ph } = placeFrame(), seen = { w: FW * Math.min(1, w / pw), h: FH * Math.min(1, h / ph) };
  edit(`add ${label}`, (d) => thingsTrack(d).clips.push({ id, at: 0, in: 0, out: end, thing: { ...newThing(type, cam, FH, seen), label } }));
  selectAddedClip(id);
}
function selectAddedClip(id, add = false) {
  const c = addedClips(S.doc).find((x) => x.id === id);
  return c ? selectObject(objectOfClip(c), S.t, false, add) : null;
}
// the menu of what can be added: from the + on Objects, or Shift+A (by the pointer over the viewer, else over its middle)
function addMenu(anchor = null, at = null) {
  const shapes = ADD.filter((a) => !a.light), lights = ADD.filter((a) => a.light), item = (a) => ({ label: a.label, act: () => addNew(a.type) });
  const r = $('#screen').getBoundingClientRect();
  openMenu(anchor ?? addRow, [...shapes.map(item), 'hr', ...lights.map(item)], anchor ? at : at ?? { x: r.left + r.width / 2 - 120, y: r.top + r.height / 2 - 120 });
}
// the row of the same at the foot of the Director view, a click each
const addRow = document.createElement('div');
addRow.className = 'add-row'; addRow.hidden = true;
{
  const buttons = (light) => ADD.filter((a) => !a.light === !light).map((a) => `<button data-add="${a.type}" title="Add a ${esc(a.label.toLowerCase())} (Shift+A: the menu)" aria-label="Add a ${esc(a.label.toLowerCase())}">${icon(a.icon)}</button>`).join('');
  addRow.innerHTML = `<span class="add-l">${icon('plus')}Add</span><span class="add-g">${buttons(false)}</span><span class="add-g">${buttons(true)}</span>`;
  $('#screen').append(addRow);
  addRow.addEventListener('click', (e) => { const b = e.target.closest('[data-add]'); if (b) addNew(b.dataset.add); });
}
function addRowShown() { addRow.hidden = !(D.view === 'director' && ovOn('add')); }
// how far a copy lands beside what it copies: its width and a bit along the view's right, in the world
function besideIt(r, cam) {
  const B = cam ? basis(cam) : null, right = B?.right ?? [1, 0, 0], along = (r.box ?? []).map((p) => p[0] * right[0] + p[1] * right[1] + p[2] * right[2]);
  const w = along.length ? Math.max(...along) - Math.min(...along) : 120;
  return right.map((v) => Math.round(v * w * 1.15));
}
/** A copy of each thing selected, beside it, the copies selected: of an added thing, its own; of what the code places, one
 *  linked to it (engine/things.js), as its motion is the code's. */
async function duplicateThings() {
  const list = [O.sel, ...O.also].filter(Boolean), cam = overlayCam(), made = [], end = r6(Math.max(1, S.film.duration ?? S.end()));
  if (!list.length) return false;
  let n = +newId('c').slice(1);
  edit(`duplicate ${list.length > 1 ? `${list.length} things` : list[0].label || list[0].kind}`, (d) => {
    for (const s of list) {
      const r = sameThing(s, O.sel) ? O.now ?? s : O.alsoNow[O.also.indexOf(s)] ?? s, off = besideIt(r, cam), id = `c${n++}`, track = thingsTrack(d);
      if (s.added) {
        const from = addedClips(d).find((c) => c.id === s.clip), th = from.thing;
        track.clips.push({ ...structuredClone(from), id, thing: { ...structuredClone(th), label: freshLabel(th.label), x: (th.x ?? 0) + off[0], y: (th.y ?? 0) + off[1], z: (th.z ?? 0) + off[2] } });
        (d.overrides ??= []).push(...thingChanges(d, from.id, id));
      } else {
        const o = objectOf(s.at), spans = o?.spans ?? [[0, end]];
        const of = s.sites ? { sites: s.sites } : { at: s.at, nth: s.nth ?? 0, ...(s.copies > 1 && (s.key != null ? { key: s.key } : { like: s.like, copy: s.copy })) };
        const at = r6(Math.min(...spans.map((x) => x[0])));
        track.clips.push({ id, at, in: 0, out: r6(Math.max(...spans.map((x) => x[1])) - at), thing: { of, label: freshLabel(`${(s.sites && s.object) || s.label || 'Thing'} copy`), x: off[0], y: off[1], z: off[2] } });
      }
      made.push(id);
    }
  });
  await selectAddedClip(made[0]);
  for (const id of made.slice(1)) await selectAddedClip(id, true);
  return true;
}
// hidden: not in the film, its row and its lanes still there. An object whole, or one copy of it
const hiddenWhole = (x, o) => x.props?.hidden === true && (x.on?.sites?.some((a) => o.sites.includes(a)) || (o.sites.includes(x.on?.at) && x.on.key == null && !x.on.like));
const objectHidden = (o) => (S.doc.overrides ?? []).some((x) => hiddenWhole(x, o));
function toggleHidden(o) {
  const off = objectHidden(o);
  edit(`${off ? 'show' : 'hide'} ${o.label || o.kind}`, (d) => {
    d.overrides ??= [];
    if (off) { for (const x of d.overrides) if (hiddenWhole(x, o)) delete x.props.hidden; d.overrides = d.overrides.filter((x) => !x.on || Object.keys(x.props ?? { keep: 1 }).length); return; }
    d.overrides.push({ id: newId('o'), on: { label: o.label, kind: o.kind, sites: o.sites }, props: { hidden: true } });
  });
  paintBar();
}
const copyAlone = (s) => !s.sites && isMany(objectOf(s.at));
const copyHidden = (s) => (S.doc.overrides ?? []).find((x) => x.props?.hidden === true && x.on && !x.on.sites && names(x.on, s));
function selectionHidden() { const s = O.sel; if (!s?.at) return false; if (copyAlone(s)) return !!copyHidden(s); const o = objectOf(s.at); return o ? objectHidden(o) : !!copyHidden(s); }
function hideSelection() {
  // (a picture has no row to bring it back from: its clip is on its track)
  const list = [O.sel, ...O.also].filter((s) => s?.at && (!s.clip || s.added));
  for (const s of list) {
    if (!copyAlone(s) && objectOf(s.at)) { toggleHidden(objectOf(s.at)); continue; }
    const was = copyHidden(s);
    edit(`${was ? 'show' : 'hide'} ${s.label || s.kind}${s.copies > 1 ? ` #${(s.copy ?? 0) + 1}` : ''}`, (d) => {
      d.overrides ??= [];
      if (was) { const x = d.overrides.find((y) => y.id === was.id); delete x.props.hidden; if (!Object.keys(x.props).length) d.overrides.splice(d.overrides.indexOf(x), 1); return; }
      d.overrides.push({ id: newId('o'), on: onOf(s), props: { hidden: true } });
    });
  }
  paintBar();
}
// a look of the material menu's: its inputs as the fields set them (your lanes over the code's), one undo step
// (what glows, glows in its own colour: the override it has, with that set beside its base colour)
function setMaterial(m) {
  const set = Object.fromEntries(Object.entries(m.set).filter(([k]) => lanes.shown('sel', k) != null));
  const e = lanes.valueEdits('sel', set), r = O.now ?? O.sel, color = hexOf(r.material?.baseColor);
  if (!e) return toast('Its lanes are not ready yet: try again in a moment');
  edit(`${O.sel.label || O.sel.kind}: ${m.label.toLowerCase()}`, (d) => {
    e.fn(d);
    if (!m.set.emissionStrength) return;
    const x = d.overrides?.find((q) => q.on && !q.on.camera && names(q.on, O.sel));
    if (x) x.props.emissionColor = color;
  });
  inspector();
}
function setBaseColor(hex) {
  setProp('baseColor', hex);
  const x = (S.doc.overrides ?? []).find((q) => q.on && !q.on.camera && names(q.on, O.sel));
  if (x?.props?.emissionColor) edit(`${O.sel.label || O.sel.kind}: its glow's colour`, (d) => { d.overrides.find((q) => q.id === x.id).props.emissionColor = hex; });
}
function setLightType(type) {
  const id = O.sel?.clip;
  edit(`${O.sel.label}: ${type} light`, (d) => { addedClips(d).find((c) => c.id === id).thing.type = type; });
  paintBar();
}
function renameAdded(o, el = null) {
  const c = o?.clip;
  if (!c) return;
  const at = el ?? $('#heads')?.querySelector(`.mobj[data-obj="${CSS.escape(o.id)}"] b`), done = (v) => { if (v && v !== c.thing.label) edit(`rename "${c.thing.label}" → "${v}"`, (d) => { addedClips(d).find((x) => x.id === c.id).thing.label = v; }); };
  if (!at) { const v = prompt('Name', c.thing.label); if (v != null) done(v.trim()); return; }
  const input = at.ownerDocument.createElement('input');
  input.className = 'inline-name'; input.value = c.thing.label; at.textContent = ''; at.append(input); input.focus(); input.select();
  let over = false;
  const finish = (ok) => { if (over) return; over = true; const v = input.value.trim(); at.textContent = c.thing.label; if (ok) done(v); };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  input.onclick = (e) => e.stopPropagation();
  input.onblur = () => finish(true);
}
// what the selection takes up in the world: { c (its centre), r (how far it reaches) }, or null where it has no place there
function selectionExtent() {
  const pts = [O.now, ...O.alsoNow].filter(Boolean).flatMap((x) => [...(x.members?.flat() ?? []), ...(x.box ?? [])]).filter((p) => p.length === 3);
  if (!pts.length) return null;
  const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
  return { c: lo.map((v, k) => (v + hi[k]) / 2), r: Math.max(20, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2) };
}
/** F: the selection framed in the Director view (its camera turned no differently, gliding there); the film's own camera is left as it is. */
async function focusSelection() {
  if (D.lock) setLock(false);   // (framing moves the view: it would move the project camera)
  if (!O.sel) { if (D.view === 'director') frameFilmCamera(); return; }
  const e = selectionExtent();
  if (!e) return toast(O.now ? 'It has no place in the world to frame.' : 'It is not in the scene at the playhead.');
  if (!D.cam) await frameFilmCamera();
  if (!D.cam) return;
  if (D.view !== 'director') setView('director');
  // (framed in what of the picture the screen shows)
  const sc = $('#screen'), shown = Math.min(1, sc.clientHeight / Math.max(1, Math.max(sc.clientWidth * (FH / FW), sc.clientHeight)));
  glideDirector({ ...D.cam, x: e.c[0], y: e.c[1], z: e.c[2], zoom: Math.max(0.01, Math.min(100, (FH * shown) / (e.r * 3.2))) });
}
function glideDirector(to) {
  const from = { ...D.cam }, t0 = performance.now(), T = 260, lerp = (a, b, u) => (a ?? 0) + ((b ?? 0) - (a ?? 0)) * u;
  D.glide = to;
  const step = (now) => {
    if (D.glide !== to || D.drag) return;
    const u = Math.min(1, (now - t0) / T), k = u * u * (3 - 2 * u);
    D.cam = { ...to, x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k), z: lerp(from.z, to.z, k), zoom: from.zoom * (to.zoom / from.zoom) ** k };
    D.moved = now;
    if (u < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
/** The project camera pointed at the selection at the playhead: its own keys, so its motion goes on under them. */
function aimCamera() {
  const e = selectionExtent(), pose = OL.shown?.camera;
  if (!e || !pose) return toast('It is not in the scene at the playhead.');
  const [x, y, z] = e.c, eye = pose.eye, d = [eye[0] - x, eye[1] - y, eye[2] - z], l = Math.hypot(...d) || 1, deg = (r) => (r * 180) / Math.PI;
  const vals = pose.kind === 'target' ? { tx: x, ty: y, tz: z } : pose.kind === 'free' ? { yaw: deg(Math.atan2(d[0], d[2])), pitch: deg(Math.asin(-d[1] / l)) } : { x, y, z };
  const e2 = lanes.valueEdits('camera', Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, Math.round(v * 100) / 100])));
  if (!e2) return toast('Its lanes are not ready yet: try again in a moment');
  edit(`point the project camera at ${O.sel.label || O.sel.kind}`, e2.fn);
}
// ---------- the overlays of each frame the viewer shows (api/overlays: the film's camera there, the scene's lights, the
// selection), asked for a few frames at a time — around the playhead, and playing, those it shows next, as far ahead as
// a round trip and a quarter second, twice over — and each drawn over the picture of its own frame, so they never trail
// it. Mid-gesture the gizmo moves the outline; the director's camera moving asks for nothing (what they draw is in the
// world, seen through the camera of the picture shown: paintObjects).
const OL = { key: '', at: new Map(), asking: false, rtt: 80, shown: null };
// the frame of the picture shown: the viewer's, or the director's view's
const shownFrame = () => (D.view === 'director' ? (D.imgT == null ? null : frameAt(D.imgT)) : drawnF ?? frameAt(S.t));
function followOverlays() {
  if (BAR.copy && BAR.t !== S.t) pickChip(null);   // (the copy clicked is the moment's it was clicked at)
  if (gizmo.active || D.own) return;   // (the editor's own film finds them over its frames: ownState, viewportEvent now)
  const sel = O.sel?.at ? refOf(O.sel) : null, also = O.also.filter((x) => x.at).map(refOf);
  const key = JSON.stringify([S.film.gen, liveKey(), sel, also, D.view]);
  if (key !== OL.key) { OL.key = key; OL.at.clear(); }
  const o = OL.at.get(shownFrame());
  if (o && o !== OL.shown) showOverlays(o);
  const fps = S.doc.fps || 60, f = frameAt(S.t), end = Math.floor((S.film.duration || S.end()) * fps), ahead = Math.ceil((OL.rtt / 1000 + 0.25) * fps);
  const missing = [];
  for (let i = Math.max(0, audio.playing ? f : f - 3); i <= Math.min(end, audio.playing ? f + 2 * ahead : f + 3); i++) if (!OL.at.has(i)) missing.push(i);
  // (playing: asked again once half of what is ahead is shown)
  if (OL.asking || !missing.length || (audio.playing && OL.at.has(f) && missing.length < ahead)) return;
  // (paused: the frame shown first and those around it one at a time: a big object's take a tenth of a second each, which
  // the picture should not wait behind)
  if (!audio.playing) { missing.sort((a, b) => Math.abs(a - f) - Math.abs(b - f)); missing.length = 1; }
  OL.asking = true;
  const sent = performance.now();
  post('api/overlays', { times: missing.map((i) => i / fps), sel, also, draft: draftNow(), camera: D.view === 'director' ? D.cam : null })
    .then((r) => r.json()).then((list) => {
      OL.rtt = 0.8 * OL.rtt + 0.2 * (performance.now() - sent);
      if (key !== OL.key || !Array.isArray(list)) return;
      list.forEach((x, j) => OL.at.set(missing[j], x));
      const now = frameAt(S.t);
      for (const i of OL.at.keys()) if (i < now - 24 || i > now + 240) OL.at.delete(i);
    })
    .catch(() => {}).finally(() => { OL.asking = false; });
}
// a frame's overlays over its picture: the selection as it is there (its values in the inspector, paused)
function showOverlays(o) {
  OL.shown = o;
  O.alsoNow = (o.also ?? []).map((x, i) => (x && O.also[i]?.sites ? { ...x, sites: O.also[i].sites } : x));
  if (O.sel && 'sel' in o) {
    O.now = o.sel && O.sel.sites ? { ...o.sel, sites: O.sel.sites } : o.sel; O.t = o.t;
    if (!audio.playing) inspector();
  }
  paintObjects();
}
// the overlay: the selection's outline, and the annotations in effect at the playhead pinned to their objects
let objPainted = '';
// the camera of the picture shown, the overlays (the grid, lights, outline, handles and pinned notes) drawn from it: the
// director's, or the film's at the frame shown (its overlays); null until it is known
function overlayCam() { return D.view === 'director' ? D.imgCam : OL.shown?.camera.camera ?? null; }
// what is selected and how the overlays are set, for the editor's own film to draw over its picture and to turn with its
// gizmo (engine/viewport.js), with the editor's colours (overlays.css)
const OVCSS = ['--accent', '--accent-a', '--cue', '--text', '--dim', '--mono', '--r-panel'];
let ovColors = null;
function ownState() {
  ovColors ??= Object.fromEntries(OVCSS.map((k) => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()]));
  const id = pathThing(), target = cameraTarget();
  const path = id && ovOn('path') && !audio.playing && !(id === 'camera' && (D.view !== 'director' || D.lock)) ? { runs: lanes.path(id), points: lanes.points(id) } : null;
  PATH.pts = path?.points ?? [];
  return {
    show: OV[D.view], cues: showCues, lock: D.lock, camSel: !!D.camSel, camPath: D.path ?? null, cuts: S.film.cuts ?? [],
    sel: O.sel?.at ? { ...refOf(O.sel), kind: O.sel.kind, label: O.sel.label } : null,
    also: O.also.filter((x) => x.at).map(refOf),
    target: target && { ...target, values: Object.fromEntries(['x', 'y', 'z', 'pitch', 'yaw', 'roll', 'zoom'].map((k) => [k, lanes.shown('camera', k)])) },
    path,
    pins: showCues ? cuesAt(S.t).active.filter((q) => q.on).map((q) => ({ point: q.on.point, screen: q.on.screen, text: (q.label || q.note.split('\n')[0] || q.on.label || 'note').slice(0, 60) })) : [],
    into: O.sel || target ? lanes.intoText(O.sel ? 'sel' : 'camera') : '',
    colors: ovColors,
  };
}
function paintObjects() {
  // (the Director view drawn by the editor's own film: what goes over it is drawn there, from what is said here)
  if (D.own) { viewport.overlayState(ownState()); if (objPainted) { ovl.innerHTML = ''; objPainted = ''; } return paintBar(); }
  const out = [], cam = overlayCam(), B = cam && basis(cam);
  // the floor's grid, under the rest
  if (ovOn('grid') && B) out.push(gridSvg(B));
  // the project camera, seen from outside it in the Director view: its path, where it is and what it frames
  if (D.view === 'director' && B && ovOn('camera') && !D.lock) out.push(cameraSvg(D.path, B, { cuts: S.film.cuts ?? [], t: D.imgT, W: FW, H: FH, k: viewK, selected: D.camSel }));
  // the scene's own lights: a mark where each is, in its colour (a spot's way dashed from it), from where it is in the
  // world (until the camera is known, as the studio saw them)
  if (ovOn('lights')) out.push(lightsSvg(OL.shown?.lights, B));
  // (a whole object: each of its copies outlined, its corners in the world seen through the camera, or one on the screen
  // as it is; but mid-gesture the copy it is read from, as the gizmo moves it; the others selected each outlined, fainter)
  const members = O.sel?.sites && !gizmo.active ? membersOf(O.now, B) : null;
  if (ovOn('selection')) out.push(outlinesSvg({ members, sel: O.sel && (gizmo.outline() ?? (members ? null : selOutline())), also: gizmo.active ? [] : O.alsoNow.map((x) => x && selOutline(x)) }));
  if (B) out.push(pathSvg(B));
  if ((O.sel && O.now) || cameraTarget()) out.push(gizmo.svg(OV[D.view].on ? OV[D.view] : {}));
  if (showCues) out.push(pinsSvg(cuesAt(S.t).active.filter((q) => q.on).map((q) => ({ point: q.on.point, screen: q.on.screen, text: (q.label || q.note.split('\n')[0] || q.on.label || 'note').slice(0, 60) })), B));
  const html = out.join('');
  if (html !== objPainted) { ovl.innerHTML = html; objPainted = html; }
  paintBar();
}
// the selection's outline: its corners in the world through the camera of the picture shown (a thing with none, on the
// screen, or a camera not yet known: as the studio found it)
function selOutline(now = O.now) {
  const c = overlayCam();
  return outlineOf(now, c && basis(c));
}
// ---------- the selection's path through the film and the points on it its pose is set at (its keys, where its moves
// land: lanes.points), drawn through the camera of the picture shown. The lane selected's in the accent. A point is a
// handle: a click takes the playhead there and selects its key or move (its lane: where G then puts the thing), a drag
// moves the thing there. ↑ ↓ step through them (the lane selected's, or all of them)
// the thing whose path it is: the selection in the viewer, or the project camera selected (its row, a lane of it)
function pathThing() {
  if (O.sel) return O.sel.at && O.sel.kind !== 'title' && (O.now ?? O.sel).where?.x != null ? 'sel' : null;
  return lanes.selected()?.th === 'camera' ? 'camera' : null;
}
const PATH = { pts: [], down: null };
function pathSvg(B) {
  const id = pathThing();
  PATH.pts = [];
  // (the project camera's in the Director view, where you see it from outside; not looking through it)
  if (!id || !ovOn('path') || audio.playing || (id === 'camera' && (D.view !== 'director' || D.lock))) return '';
  PATH.pts = lanes.points(id);
  return pathMarks(lanes.path(id), PATH.pts, B, { k: viewK, t: S.t });
}
// a point gone to: the playhead there, its key or move selected (and its lane)
function goToPoint(p) {
  if (audio.playing) stopPlay();
  seek(p.t); tl.reveal(p.t);
  lanes.selectPoint(p);
}
// the next point (dir 1) or the one before (-1): the lane selected's, or all of the thing's; null where there is none
function pointFrom(dir) {
  const id = pathThing(), pts = id ? lanes.points(id) : [], mine = pts.filter((p) => p.sel), list = mine.length ? mine : pts;
  if (!list.length) return null;
  return (dir > 0 ? list.find((x) => x.t > S.t + 1e-4) : list.findLast((x) => x.t < S.t - 1e-4)) ?? false;
}
function stepPoint(dir) {
  const p = pointFrom(dir);
  if (p === null) return false;
  if (!p) { toast(dir > 0 ? 'No point after this one' : 'No point before this one'); return true; }
  if (audio.playing) stopPlay();
  seek(p.t); tl.reveal(p.t);
  return true;
}
// a piece of the film's code: the lines around the one that placed (or made) the selection, that line marked
async function codeAround({ file, line }) {
  if (O.codeGen !== S.film.gen) { O.code.clear(); O.codeGen = S.film.gen; }
  if (!O.code.has(file)) O.code.set(file, linkFetch(resolve(file), { cache: 'no-store' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText)))));
  const lines = (await O.code.get(file)).split('\n'), a = Math.max(1, line - 5), b = Math.min(lines.length, line + 5);
  return `<div class="code-file">${esc(file)}</div><pre>${lines.slice(a - 1, b).map((l, i) => `<span class="${a + i === line ? 'hit' : ''}"><i>${a + i}</i>${esc(l) || ' '}</span>`).join('')}</pre>`;
}
// ---------- overrides: the selection's properties, changed here over what the film's code computes (engine/
// overrides.js): position and rotation as offsets, scale as a factor, opacity and material inputs as values. Each is a
// value, or keyframes once its ◆ is on (an edit then sets the keyframe at the playhead; two keyframes ease from one to
// the next, as a camera's .to() does). They live in the timeline (overrides), so they are versioned and the agent sees them.
const MOVES = ['x', 'y', 'z', 'rx', 'ry', 'rz'];
const LIGHT_KEYS = ['intensity', 'radius', 'angle', 'soft'];   // a light's own numbers (engine/light.js)
// a colour as CSS and as an <input type=color> takes it: a CSS colour as it is, an sRGB triple (0–1) as #rrggbb
const hexOf = (c) => (Array.isArray(c) ? '#' + c.map((v) => Math.round(255 * Math.min(1, Math.max(0, v))).toString(16).padStart(2, '0')).join('') : c ?? '#ffffff');
const cssColor = (c) => (Array.isArray(c) ? hexOf(c) : c ?? '#ffffff');
const MATS = [['baseColor', 'Base colour', 'color'], ['metallic', 'Metallic', 0.01], ['roughness', 'Roughness', 0.01], ['ior', 'IOR', 0.01],
  ['transmissionWeight', 'Transmission', 0.01], ['coatWeight', 'Coat', 0.01], ['sheenWeight', 'Sheen', 0.01], ['emissionStrength', 'Emission', 0.05],
  ['iridescence', 'Iridescence', 0.01], ['dispersion', 'Dispersion', 0.01], ['normalStrength', 'Normal strength', 0.05]];
// the selection's override: the one the studio applied to it, or (until it has rendered a change) the one naming it
// (a whole object's: the one naming its lines; a copy's applied override may be its object's, which is not its own)
const ovOf = (r) => (r ? (!r.sites && S.doc.overrides?.find((o) => o.id === r.override && !o.on?.sites)) || S.doc.overrides?.find((o) => o.on && !o.on.camera && names(o.on, r)) || null : null);
const sameSites = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
function names(on, r) {
  if (on.sites || r.sites) return !!(on.sites && r.sites) && sameSites(on.sites, r.sites);
  if (on.at !== r.at || (on.nth ?? 0) !== (r.nth ?? 0)) return false;
  if (!(r.copies > 1)) return true;
  if (on.key != null || r.key != null) return on.key === r.key;
  // (a copy without an id: the one sharing most of its fields, as the studio matches it)
  const f = Object.keys(on.like ?? {});
  return f.length > 0 && f.filter((k) => on.like[k] === r.like?.[k]).length >= Math.max(2, Math.ceil(f.length * 0.4));
}
// the thing an override names: where the code placed it, which of that call's nodes, which copy (its id, or its fields)
const onOf = (r) => (r.sites ? { label: r.object ?? r.label, kind: r.kind, sites: r.sites } : { label: r.label, kind: r.kind, at: r.at, nth: r.nth, ...(r.copies > 1 && (r.key != null ? { key: r.key } : { like: r.like })) });
// the code's own value of a property at the playhead (what the override is applied over)
function codeValue(r, k) {
  if (r.code?.[k] != null && k !== 'baseColor') return r.code[k];
  const a = r.applied ?? {}, w = r.where ?? {};
  if (MOVES.includes(k)) return (w[k] ?? 0) - (a[k] ?? 0);
  if (k === 's') { const s = Array.isArray(w.s) ? w.s[0] : w.s ?? 1; return s / (a.s ?? 1); }
  return r.code?.[k] ?? (k === 'opacity' ? (w.opacity ?? 1) : r.material?.[k] ?? passParam(r.surface?.params, k) ?? (r.kind === 'light' ? w[k] : r.kind === 'pass' ? passParam(w.params, k) : undefined));
}
// a pass's param by the editor's name for it (a vector's part: name.x)
const passParam = (params, k) => { const [b, part] = k.split('.'), v = params?.[b]; return part == null ? v : Array.isArray(v) ? v['xyzw'.indexOf(part)] : undefined; };
const shownValue = (r, k) => (r.kind === 'pass' && !MOVES.includes(k) && k !== 's' ? passParam(r.where?.params, k) : (MOVES.includes(k) ? r.where?.[k] ?? 0 : k === 's' ? (Array.isArray(r.where?.s) ? r.where.s[0] : r.where?.s ?? 1) : k === 'opacity' ? r.where?.opacity ?? 1 : r.material?.[k] ?? passParam(r.surface?.params, k)) ?? (r.kind === 'light' ? r.where?.[k] : undefined));
// a property set to `shown` (what the field shows): stored as the override's value at the playhead
function setProp(k, shown) {
  // (a number: your keys on top of its stack, in the timeline's lanes; a colour or a yes or no: set in place of the code's)
  if (k !== 'baseColor' && typeof shown === 'number' && lanes.setValue('sel', k, shown)) return inspector();
  const r = O.now ?? O.sel, t = r6(O.t), code = codeValue(r, k);
  const v = MOVES.includes(k) ? r6(shown - code) : k === 's' ? r6(shown / (code || 1)) : typeof shown === 'number' ? r6(shown) : shown;
  const o = ovOf(r), id = o?.id ?? newId('o');
  edit(`${r.label || r.kind}: ${k} → ${typeof shown === 'number' ? +shown.toFixed(3) : shown}${o && keyed(o.props[k]) ? ` at ${f2(t)}` : ''}`, (d) => {
    d.overrides ??= [];
    let x = d.overrides.find((q) => q.id === id);
    if (!x) d.overrides.push((x = { id, on: onOf(r), props: {} }));
    const p = x.props[k];
    if (keyed(p)) { const key = p.find((q) => Math.abs(q.t - t) < 1e-3); if (key) key.v = v; else p.push({ t, v }); p.sort((a, b) => a.t - b.t); }
    else x.props[k] = v;
  });
  pending(r, id);
}
// ◆: keyframes for a property — on (a keyframe at the playhead, from its value now), a keyframe added or taken away
function toggleKey(k) {
  if (k !== 'baseColor' && lanes.toggleKey('sel', k)) return inspector();
  const r = O.now ?? O.sel, t = r6(O.t), o = ovOf(r), id = o?.id ?? newId('o');
  const cur = o && k in o.props ? valueAt(o.props[k], t) : MOVES.includes(k) ? 0 : k === 's' ? 1 : shownValue(r, k);
  edit(`${r.label || r.kind}: keyframe ${k} at ${f2(t)}`, (d) => {
    d.overrides ??= [];
    let x = d.overrides.find((q) => q.id === id);
    if (!x) d.overrides.push((x = { id, on: onOf(r), props: {} }));
    const p = x.props[k];
    if (!keyed(p)) x.props[k] = [{ t, v: cur }];
    else if (p.some((q) => Math.abs(q.t - t) < 1e-3)) { x.props[k] = p.filter((q) => Math.abs(q.t - t) >= 1e-3); if (!x.props[k].length) delete x.props[k]; }
    else { p.push({ t, v: cur }); p.sort((a, b) => a.t - b.t); }
    if (!Object.keys(x.props).length) d.overrides.splice(d.overrides.indexOf(x), 1);
  });
  pending(r, id);
}
// back to what the code says: one property, or all of them
function resetProp(k) {
  if (k ? k !== 'baseColor' && lanes.resetProp('sel', k) : lanes.resetAll('sel')) { if (k) return inspector(); }
  const r = O.now ?? O.sel, o = ovOf(r);
  if (!o) return inspector();
  edit(k ? `${r.label || r.kind}: ${k} as the code has it` : `${r.label || r.kind}: as the code has it`, (d) => {
    const x = d.overrides.find((q) => q.id === o.id);
    if (k) delete x.props[k];
    if (!k || !Object.keys(x.props).length) d.overrides.splice(d.overrides.indexOf(x), 1);
  });
  pending(r, o.id);
}
// the selection shown at once as its override (`id`) now has it at the playhead: the code's values, changed by it (the
// studio renders it, and finds the selection again, once the change is saved; until then it belongs to the override)
function pending(r, id) {
  const o = S.doc.overrides?.find((q) => q.id === id), t = r6(O.t);
  if (O.now) {
    const now = { ...O.now, where: { ...r.where }, material: r.material && { ...r.material }, applied: {}, override: o ? id : null,
      code: r.code ?? { opacity: r.where?.opacity ?? 1, ...r.material } };
    for (const k of new Set([...Object.keys(r.applied ?? {}), ...Object.keys(o?.props ?? {})])) {
      if (o?.props?.[k]?.lanes) continue;   // (what lanes give, as the frame shown has it: already in where it is)
      const code = codeValue(r, k), v = o && k in o.props ? valueAt(o.props[k], t) : null;
      if (v != null) now.applied[k] = v;
      const shown = v == null ? code : MOVES.includes(k) ? code + v : k === 's' ? code * v : v;
      if (MOVES.includes(k) || k === 's' || k === 'opacity') now.where[k] = shown; else if (now.material) now.material[k] = shown;
    }
    O.now = now;
  }
  if (O.sel) O.sel = { ...O.sel, override: o ? id : null };
  inspector();
}
function objectInspector(el, title) {
  const r = O.now ?? O.sel, s = O.sel, w = r.where ?? {}, m = r.material, o = ovOf(r), t = r6(O.t);
  const key = JSON.stringify([s.at, s.nth, s.key, s.sites, r.count, r.where, r.material, !!O.now, o, lanes.M.version, r6(S.t), s.added ? objectOf(s.at)?.clip : null]);   // (rebuilt only when what it shows changes)
  if (el.dataset.obj === key) return;
  el.dataset.obj = key; el.dataset.for = '';
  const n = (v, d = 2) => (v == null ? '' : +(+v).toFixed(d));
  const site = (x, k) => (x ? `<button class="link code-at" data-k="${k}" title="Open this line in the Code panel">${esc(x.file)}:${x.line}</button>` : '<span class="ro">–</span>');
  title.textContent = 'Object';
  const clip = s.added ? objectOf(s.at)?.clip ?? null : null, th = clip?.thing, from = s.added ? 'how it was added' : 'what the code says';
  const kinds = { mesh: 'Mesh', glass: 'Glass', layer: 'Layer', title: 'Title (on the screen)', light: w.type === 'sun' ? 'Light · sun' : w.type === 'spot' ? 'Light · spot' : 'Light · point', pass: w.x != null ? 'Object · its own shader' : w.stage === 'scene' ? 'Pass · each sub-frame' : 'Pass · the finished frame' };
  const kindText = th ? (th.of ? 'Linked copy' : ADD.find((x) => x.type === th.type)?.label ?? kinds[s.kind]) : kinds[s.kind];
  // (a pass's own params, by the names its code gives them: numbers (on a slider where it gives a range), each part of a
  // vector (name.x, name.y…), colours) as [key, value, label, range]
  const listOf = (ps, ranges) => Object.entries(ps ?? {}).flatMap(([k, v]) => (typeof v === 'number' ? [[k, v, k, ranges?.[k]]]
    : Array.isArray(v) ? v.map((x, i) => [`${k}.${'xyzw'[i]}`, x, `${k} ${'xyzw'[i]}`, null]) : typeof v === 'string' && v.startsWith('#') ? [[k, v, k, null]] : []));
  // (and a mesh's surface of the film's own: its params, after the material's inputs)
  const params = s.kind === 'pass' ? listOf(w.params, w.ranges) : r.surface ? listOf(r.surface.params, r.surface.ranges) : [];
  const paramFields = () => params.map(([k, v, label, range]) => (typeof v === 'number' ? field(k, label, v, range?.step ?? 0.001, 'number', range) : field(k, label, v, 0, 'color'))).join('');
  // a property's field: its value at the playhead, marked where it is overridden; ◆ its keyframes; × back to the code
  const field = (k, label, v, step, type = 'number', range = null) => {
    // (a number's state from its lanes: changed, keyed, a key here; its value as they give it now)
    const ls = type === 'color' ? null : lanes.keyState('sel', k);
    if (ls) v = lanes.shown('sel', k) ?? v;
    const p = ls ? (ls.changed ? true : null) : o?.props?.[k], kf = ls ? ls.keyed : keyed(p), at = ls ? ls.here : kf && p.some((q) => Math.abs(q.t - t) < 1e-3);
    const slider = range?.min != null && range?.max != null ? `<input type="range" name="${k}" min="${range.min}" max="${range.max}" step="${range.step ?? (range.max - range.min) / 1000}" value="${n(v, 4)}">` : '';
    const input = type === 'color' ? `<input type="color" name="${k}" value="${esc(v ?? '#ffffff')}">` : `${slider}<input type="number" name="${k}" value="${n(v, 3)}" step="${step}">`;
    return `<label class="${p != null ? 'ov' : ''}" title="${p != null ? `Changed from ${from}` : ''}">${label}</label><div class="pair prop">${input}<button class="kf${kf ? ' on' : ''}${at ? ' here' : ''}" data-kf="${k}" title="${kf ? (at ? 'Remove the keyframe here' : 'Add a keyframe here') : 'Keyframes: animate it (a keyframe here, from its value now)'}">${at ? '◆' : '◇'}</button>${p != null ? `<button class="rst" data-reset="${k}" title="Back to ${from}">×</button>` : ''}</div>`;
  };
  const keys = [...new Set([...Object.values(o?.props ?? {}).filter(keyed).flatMap((p) => p.map((q) => q.t)), ...[...MOVES, 's', 'sx', 'sy', 'sz', 'opacity', ...MATS.map((x) => x[0]), ...LIGHT_KEYS, ...params.map(([k]) => k)].flatMap((k) => lanes.keyState('sel', k)?.times ?? [])])].sort((a, b) => a - b);
  // (a whole object: every copy; a copy of one: which, and the way back to all of them)
  const whole = !!s.sites, of = !whole && isMany(objectOf(s.at)) ? objectOf(s.at) : null;
  const lines = whole ? s.sites.map((at) => parseSite(at)).filter(Boolean) : null;
  const count = whole ? (O.now?.count ? ` · ${O.now.count} copies here` : '') : s.copies > 1 ? ` · copy ${(r.copy ?? s.copy) + 1} of ${r.copies ?? s.copies}` : '';
  const sect = (id, ic, name, body) => (body ? `<section class="sect"><button class="sect-h" data-sect="${id}" aria-expanded="${!inspClosed.has(id)}">${icon('caret-right', false, 'car')}${icon(ic, false, 'sic')}<span>${name}</span></button><div class="sect-b form"${inspClosed.has(id) ? ' hidden' : ''}>${body}</div></section>` : '');
  const light = s.kind === 'light', placedIn = s.kind !== 'pass' || w.x != null, sx = w.sx != null;
  const size = sx && th && !th.of ? `<label>Size</label><span class="ro">${[lanes.shown('sel', 'sx') ?? w.sx, lanes.shown('sel', 'sy') ?? w.sy, lanes.shown('sel', 'sz') ?? w.sz].map((v) => Math.round(v * 100)).join(' × ')} px</span>` : '';
  el.innerHTML = `<div class="insp-title"><span class="sw" style="background:${m ? m.baseColor : light ? cssColor(w.color) : 'var(--accent)'}"></span><b>${esc((whole && s.object) || s.label || kinds[s.kind])}</b><span>${kindText ?? 'Object'}${count}${O.now || (clip && S.t >= clip.at && S.t < clipEnd(clip)) ? '' : ' · not in the scene here'}</span></div>
    <div class="sects">
      ${s.added ? sect('obj-time', 'clock-counter-clockwise', 'Name and time', `<label>Name</label><input data-thing="label" value="${esc(th?.label ?? '')}" spellcheck="false">
        <label>In</label><div class="pair"><input type="number" data-thing="in" value="${n(clip?.at, 3)}" step="0.01" min="0"><span class="ro">s</span></div>
        <label>Out</label><div class="pair"><input type="number" data-thing="out" value="${clip ? n(clipEnd(clip), 3) : ''}" step="0.01" min="0"><span class="ro">s</span></div>`)
      : sect('obj-code', 'code', 'Code', `${whole ? `<label>Placed</label><span class="ro">${lines.map((x, i) => `<button class="link code-at" data-k="site:${i}" title="Open this line in the Code panel">${esc(x.file)}:${x.line}${lines.some((y, j) => j !== i && y.file === x.file && y.line === x.line) ? `:${x.col}` : ''}</button>`).join(' · ')}</span>`
          : `<label>Placed</label>${site(s.file && { file: s.file, line: s.line }, 'at')}`}
        <label>Made</label>${site(s.made, 'made')}
        <div class="full code" id="objCode"><span class="hint">…</span></div>`)}
      ${s.kind === 'pass' && w.x == null ? sect('obj-params', 'sliders-horizontal', 'Params', paramFields()) : sect('obj-move', 'crosshair', 'Transform', `${field('x', 'X', w.x, 1)}${field('y', 'Y', w.y, 1)}${field('z', 'Z', w.z ?? 0, 1)}
        ${!light || w.type !== 'point' ? `${field('rx', 'Rotate X', w.rx ?? 0, 1)}${field('ry', 'Rotate Y', w.ry ?? 0, 1)}${field('rz', 'Rotate Z', w.rz ?? 0, 1)}` : ''}
        ${light ? '' : sx ? `${field('sx', 'Scale X', w.sx, 0.01)}${field('sy', 'Scale Y', w.sy, 0.01)}${field('sz', 'Scale Z', w.sz, 0.01)}${size}` : field('s', 'Scale', Array.isArray(w.s) ? w.s[0] : w.s ?? 1, 0.01)}
        ${s.kind === 'layer' || s.kind === 'title' ? field('opacity', 'Opacity', w.opacity ?? 1, 0.01) : ''}`)}
      ${light ? sect('obj-light', 'lightbulb', 'Light', `${s.added ? `<label>Type</label><select data-thing="type">${ADD.filter((a) => a.light).map((a) => `<option value="${a.type}"${a.type === w.type ? ' selected' : ''}>${a.label}</option>`).join('')}</select>` : ''}
        ${field('color', 'Colour', hexOf(w.color), 0, 'color')}${field('intensity', 'Intensity', w.intensity, 0.01)}
        ${w.type === 'sun' ? field('angle', 'Size', w.angle, 0.1) : field('radius', 'Radius', w.radius, 1)}
        ${w.type === 'spot' ? `${field('angle', 'Cone', w.angle, 1)}${field('soft', 'Soft edge', w.soft, 0.01)}` : ''}
        ${w.type !== 'sun' && w.range != null ? field('range', 'Range', w.range, 10) : w.type !== 'sun' && s.added ? '<label title="How far it reaches. Left empty, as far as it adds anything you can see.">Range</label><div class="pair"><input type="number" data-thing="range" placeholder="Auto" step="10" min="0"><span class="ro">px</span></div>' : ''}
        <label title="Traces its shadows, which takes longer to draw.">Shadows</label><div class="pair"><input type="checkbox" data-prop="shadows"${w.shadows ? ' checked' : ''}></div>`) : ''}
      ${s.kind === 'pass' && w.x != null ? sect('obj-params', 'sliders-horizontal', 'Params', paramFields()) : ''}
      ${m ? sect('obj-mat', 'palette', 'Material', `<label>Preset</label><div class="pair obj-looks">${MATERIALS.map((x, i) => `<button class="btn" data-look="${i}">${x.label}</button>`).join('')}</div>${MATS.filter(([k]) => m[k] !== undefined).map(([k, label, step]) => field(k, label, m[k], step === 'color' ? 0 : step, step === 'color' ? 'color' : 'number')).join('')}
        ${r.surface ? `<label>Surface</label><span class="ro">${esc(r.surface.label)} · ${r.surface.mode === 'shade' ? 'its own light' : 'lit as the material is'}</span>${paramFields()}` : ''}`) : ''}
      <div class="sect-b form">
      ${keys.length ? `<label>Keyframes</label><span class="ro keys">${keys.map((k) => `<button class="link" data-seek="${k}">${f2(k)}</button>`).join(' ')}</span>` : ''}
      <div class="full row-btns"><button class="btn primary" data-act="ask" title="Ask ${esc(panel.short)} about it">Ask ${esc(panel.short)}</button><button class="btn" data-act="annotate" title="Pin a note to it at the playhead (A)">Annotate</button>${o || lanes.anyChanged('sel') ? `<button class="btn" data-act="reset" title="Every property back to ${from}">Reset all</button>` : ''}${whole && O.now ? '<button class="btn" data-act="one" title="The copy its values are shown from. Clicking a copy again in the viewer also selects it.">Select one copy</button>' : ''}${of ? '<button class="btn" data-act="all" title="Every copy of it, from every line that places it (Esc)">Select every copy</button>' : ''}<button class="btn" data-act="deselect">${of ? 'Deselect' : 'Deselect · Esc'}</button></div>
      ${whole ? '<span class="full hint">A change here changes every copy.</span>' : ''}
      ${s.added ? '' : `<span class="full hint">Changes here sit over the code's values. ${esc(panel.short)} can fold them into the code.</span>`}
      </div>
    </div>`;
  el.onclick = sectToggled;
  // (what the thing is, not its lanes: its name, when it is in the film, a light's kind and reach)
  const onThing = (f, desc) => { const id = clip.id; edit(desc, (d) => f(addedClips(d).find((c) => c.id === id))); };
  for (const i of el.querySelectorAll('[data-thing]')) {
    i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); if (e.key === 'Escape') { i.value = i.defaultValue; i.blur(); } };
    i.onchange = () => {
      const v = i.value.trim(), num = +v;
      if (i.dataset.thing === 'label') { if (v) onThing((c) => { c.thing.label = v; }, `rename "${th.label}" → "${v}"`); }
      else if (i.dataset.thing === 'type') setLightType(v);
      else if (i.dataset.thing === 'range') onThing((c) => { if (v === '') delete c.thing.range; else c.thing.range = num; }, `${th.label}: range → ${v || 'auto'}`);
      else if (Number.isFinite(num) && i.dataset.thing === 'in') { const end = clipEnd(clip); onThing((c) => { c.at = Math.max(0, Math.min(r6(num), end - 0.02)); c.out = r6(end - c.at); c.in = 0; }, `${th.label}: in → ${f2(num)}`); }
      else if (Number.isFinite(num) && i.dataset.thing === 'out') onThing((c) => { c.out = r6(Math.max(c.in + 0.02, c.in + num - c.at)); }, `${th.label}: out → ${f2(num)}`);
    };
  }
  el.querySelector('[data-prop=shadows]')?.addEventListener('change', (e) => setProp('shadows', e.target.checked));
  for (const b of el.querySelectorAll('[data-look]')) b.onclick = () => setMaterial(MATERIALS[+b.dataset.look]);
  const show = (x) => { O.show = x; codeAround(x).then((html) => { const c = el.querySelector('#objCode'); if (c) c.innerHTML = html; }).catch((e) => { const c = el.querySelector('#objCode'); if (c) c.innerHTML = `<span class="hint">${esc(e.message)}</span>`; }); };
  // (a line named: shown below, and opened in the Code panel; the lines shown, opened there too)
  for (const b of el.querySelectorAll('.code-at')) b.onclick = () => { const x = b.dataset.k === 'made' ? s.made : b.dataset.k.startsWith('site:') ? lines[+b.dataset.k.slice(5)] : { file: s.file, line: s.line }; show(x); showCode(x); };
  const codeEl = el.querySelector('#objCode');
  if (codeEl) codeEl.onclick = () => { if (O.show?.file) showCode(O.show); };
  if (codeEl && (O.show?.file || s.file || s.made)) show(O.show?.file ? O.show : s.file ? { file: s.file, line: s.line } : s.made);
  // (a slider moves its number as it goes; either sets the value when let go)
  for (const i of el.querySelectorAll('.prop input[type=range]')) i.oninput = () => { const f = i.parentElement.querySelector('input[type=number]'); if (f) f.value = i.value; };
  for (const i of el.querySelectorAll('.prop input')) {
    i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); if (e.key === 'Escape') { i.value = i.defaultValue; i.blur(); } };   // (left as it was)
    i.onchange = () => { const v = i.type === 'color' ? i.value : +i.value; if (i.type === 'color' || Number.isFinite(v)) setProp(i.name, v); };
  }
  for (const b of el.querySelectorAll('[data-kf]')) b.onclick = () => toggleKey(b.dataset.kf);
  for (const b of el.querySelectorAll('[data-reset]')) b.onclick = () => resetProp(b.dataset.reset);
  for (const b of el.querySelectorAll('[data-seek]')) b.onclick = () => { seek(+b.dataset.seek); tl.reveal(+b.dataset.seek); };
  el.querySelector('[data-act=annotate]').onclick = annotate;
  el.querySelector('[data-act=ask]').onclick = () => panel.ask();
  el.querySelector('[data-act=deselect]')?.addEventListener('click', deselectObject);
  el.querySelector('[data-act=one]')?.addEventListener('click', () => selectCopy(O.now));
  el.querySelector('[data-act=all]')?.addEventListener('click', () => selectWhole(of));
  el.querySelector('[data-act=reset]')?.addEventListener('click', () => resetProp(null));
}
// a note pinned to the selection at the playhead: a cue on it (what it is, the line that placed it, which copy, and the
// point clicked, in the world, or on the screen for a title)
function annotate() {
  const r = O.sel;
  if (!r) return;
  const id = newId('q'), t = r6(O.t), p = (O.now ?? r).point ?? r.point;
  const c = (O.now ?? r).outline, mid = c ? [c.reduce((a, q) => a + q[0], 0) / c.length, c.reduce((a, q) => a + q[1], 0) / c.length].map((v) => Math.round(v)) : null;
  const on = { ...onOf(r), ...(r.copies > 1 && !r.sites && { copy: r.copy }), ...(p ? { point: p.map((v) => Math.round(v * 10) / 10) } : mid && { screen: mid }) };
  edit(`annotate ${r.sites ? `${r.object || r.label || r.kind}, every copy` : `${r.label || r.kind}${r.copies > 1 ? ` #${r.copy + 1}` : ''}`} at ${f2(t)}`, (d) => d.cues.push({ id, t, dur: 0, label: '', note: '', on }));
  pickChip(null);
  O.sel = O.now = null;
  S.sel = new Set([id]); tl.invalidate(); panels(); paintObjects();
  const note = $('#inspector textarea[name=note]');
  if (note) note.focus();
}
// a cue's object, selected again (from the cue's inspector)
// the film's passes at the playhead (see engine/pass.js), each a button that selects it (a pass covers the frame, so a
// click in the viewer cannot pick it)
async function listPasses(el) {
  const t = frameTime();
  try {
    const list = await (await post('api/passes', { t })).json();
    const at = el.querySelector('#passList');
    if (!at) return;
    if (!Array.isArray(list) || !list.length) { at.textContent = 'none here'; return; }
    at.innerHTML = list.map((p, i) => `<button class="link" data-pass="${i}" title="${esc(p.at ?? '')}">${esc(p.label)}</button>`).join(' · ');
    for (const b of at.querySelectorAll('[data-pass]')) b.onclick = () => selectPass(list[+b.dataset.pass], t);
  } catch { const at = el.querySelector('#passList'); if (at) at.textContent = 'not available'; }
}
// ---------- the scene's own settings (the Timeline's Scene, with nothing selected): how the frame is seen (its view
// transform, its exposure), the lens's glow and vignette, the light around (the environment's intensity and colours)
// and the backdrop — an override on: { scene: true } (engine/overrides.js). Its numbers are a thing in the timeline's
// lanes ('scene'), keyed as any thing's; a colour is set in place of the code's (or keyed), and so is the transform
const SCENE_FIELDS = [['transform', 'View'], ['exposure', 'Exposure', 0, 4, 0.01], ['bloom', 'Bloom', 0, 0.2, 0.001], ['vignette', 'Vignette', 0, 1, 0.01],
  ['intensity', 'Sky light', 0, 4, 0.01], ['zenith', 'Sky above'], ['horizon', 'Horizon'], ['nadir', 'Below'], ['backdrop', 'Backdrop']];
const TRANSFORM_NAMES = { agx: 'AgX · film', neutral: 'Neutral · product', standard: 'Standard · clips past 1' };
let sceneAsked = 0;
async function sceneFields(el) {
  const n = ++sceneAsked, t = frameTime();
  let r = null;
  try { r = await (await post('api/stacks', { t, sel: { scene: true } })).json(); } catch { /* not running */ }
  const at = el.querySelector('#sceneFields');
  if (n !== sceneAsked || !at) return;
  // (the film's own way of tracing its light, greyed where the timeline's rendering leaves a field empty)
  for (const i of el.querySelectorAll('input[name^="rendering."]')) { const [, what, f] = i.name.split('.'), v = r?.rendering?.[what]?.[f]; if (v != null && typeof v !== 'object') i.placeholder = v; }
  if (!r?.props) { at.innerHTML = '<span class="full hint">Not available here.</span>'; return; }
  const o = S.doc.overrides?.find((q) => q.on?.scene), by = Object.fromEntries(r.props.map((p) => [p.k, p])), tt = r6(S.t);
  const kfBtn = (k, kf, here) => `<button class="kf${kf ? ' on' : ''}${here ? ' here' : ''}" data-skf="${k}" title="${kf ? (here ? 'Remove the keyframe here' : 'Add a keyframe here') : 'Keyframes: animate it (a keyframe here, from its value now)'}">${here ? '◆' : '◇'}</button>`;
  const rst = (k, on) => (on ? `<button class="rst" data-srst="${k}" title="Back to what the code says">×</button>` : '');
  at.innerHTML = SCENE_FIELDS.map(([k, label, min, max, step]) => {
    const p = by[k], mine = o?.props?.[k];
    if (k === 'transform') {
      return `<label class="${mine != null ? 'ov' : ''}">${label}</label><div class="pair prop"><select data-scene="${k}">${Object.entries(TRANSFORM_NAMES).map(([v, l]) => `<option value="${v}" ${p.value === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${rst(k, mine != null)}</div>`;
    }
    if (step) {
      const ls = lanes.keyState('scene', k), v = lanes.shown('scene', k) ?? p.value, changed = ls?.changed || mine != null;
      return `<label class="${changed ? 'ov' : ''}">${label}</label><div class="pair prop"><input type="range" data-scene="${k}" min="${min}" max="${max}" step="${step}" value="${+(+v).toFixed(4)}"><input type="number" data-scene="${k}" value="${+(+v).toFixed(3)}" step="${step}" style="width:62px">${kfBtn(k, ls?.keyed, ls?.here)}${rst(k, changed)}</div>`;
    }
    const kf = keyed(mine), here = kf && mine.some((q) => Math.abs(q.t - tt) < 1e-3);
    const sky = k === 'backdrop' && p.value == null;
    return `<label class="${mine != null ? 'ov' : ''}">${label}</label><div class="pair prop"><input type="color" data-scene="${k}" value="${esc(hexOf(p.value ?? '#000000'))}">${sky ? '<span class="ro">the sky</span>' : ''}${kfBtn(k, kf, here)}${rst(k, mine != null)}</div>`;
  }).join('');
  for (const i of at.querySelectorAll('input[type=range]')) i.oninput = () => { const f = i.parentElement.querySelector('input[type=number]'); if (f) f.value = i.value; };
  for (const i of at.querySelectorAll('[data-scene]')) {
    const k = i.dataset.scene;
    i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); if (e.key === 'Escape') { i.value = i.defaultValue; i.blur(); } };
    i.onchange = () => {
      if (i.type === 'range' || i.type === 'number') { const v = +i.value; if (Number.isFinite(v) && !lanes.setValue('scene', k, v)) setSceneValue(k, v); }
      else setSceneValue(k, i.value);
      inspector();
    };
  }
  for (const b of at.querySelectorAll('[data-skf]')) b.onclick = () => { const k = b.dataset.skf; if (!lanes.toggleKey('scene', k)) toggleSceneKey(k, by[k].value); inspector(); };
  for (const b of at.querySelectorAll('[data-srst]')) b.onclick = () => { const k = b.dataset.srst; if (!lanes.resetProp('scene', k)) sceneEdit(`Scene › ${k} as the code has it`, (x) => { delete x.props[k]; }); inspector(); };
}
// the scene's override, changed (made where it is missing, gone when nothing is left in it)
function sceneEdit(desc, fn) {
  edit(desc, (d) => {
    d.overrides ??= [];
    let x = d.overrides.find((q) => q.on?.scene);
    if (!x) d.overrides.push((x = { id: newId('o'), on: { scene: true }, props: {} }));
    fn(x);
    if (!Object.keys(x.props).length) d.overrides.splice(d.overrides.indexOf(x), 1);
  });
}
// a colour (or the view transform) set at the playhead: on its key there where it is keyed, else in place of the code's
function setSceneValue(k, v) {
  const t = r6(S.t);
  sceneEdit(`Scene › ${k} → ${typeof v === 'number' ? +v.toFixed(3) : v}`, (x) => {
    const p = x.props[k];
    if (keyed(p)) { const key = p.find((q) => Math.abs(q.t - t) < 1e-3); if (key) key.v = v; else { p.push({ t, v }); p.sort((a, b) => a.t - b.t); } }
    else x.props[k] = v;
  });
}
// ◆ on a colour: keyframes (one at the playhead, from its value now), one added or taken away
function toggleSceneKey(k, now) {
  const t = r6(S.t);
  sceneEdit(`Scene › ${k}: keyframe at ${f2(t)}`, (x) => {
    const p = x.props[k], cur = p != null && !keyed(p) ? p : keyed(p) ? valueAt(p, t) : now;
    if (!keyed(p)) x.props[k] = [{ t, v: Array.isArray(cur) ? hexOf(cur) : cur }];
    else if (p.some((q) => Math.abs(q.t - t) < 1e-3)) { x.props[k] = p.filter((q) => Math.abs(q.t - t) >= 1e-3); if (!x.props[k].length) delete x.props[k]; }
    else { p.push({ t, v: hexOf(cur) }); p.sort((a, b) => a.t - b.t); }
  });
}
async function selectPass(p, t) {
  const camera = viewCam();
  try {
    const r = await (await post('api/locate', { t, camera, at: p.at, nth: p.nth ?? 0 })).json();
    if (!r || r.error) return toast(`${p.label} is not in the scene at ${f2(t)} s`);
    O.sel = O.now = r; O.t = t; O.show = null;
    S.sel = new Set(); tl.invalidate(); panels(); paintObjects();
  } catch (e) { toast(`Could not find it: ${e.message}`); }
}

async function selectOn(q) {
  seek(q.t); tl.reveal(q.t);
  await selectThing({ t: q.t, ...q.on, nth: q.on.nth ?? 0, copy: q.on.copy ?? 0 }, `${q.on.label || 'Its object'} is not in the scene at ${f2(q.t)} s`);
}

// ---------- cues over the viewer: the cue in effect at the playhead (a viewing preference, kept in this browser only)
const ov = $('#cueOverlay'), ovRows = ov.querySelector('.ov-rows'), ovNext = ov.querySelector('.ov-next');
let showCues = true, ovKey = '', ovPrevT = null;
try { showCues = localStorage.getItem('nle:viewerCues') !== '0'; } catch {}
function setShowCues(on) {
  showCues = on; ovKey = '';
  try { localStorage.setItem('nle:viewerCues', on ? '1' : '0'); } catch {}
  $('#cuesBtn').classList.toggle('on', on); ov.hidden = !on;
}
$('#cuesBtn').onclick = () => setShowCues(!showCues);
// the size the viewer's frames are drawn at: Auto, as many pixels as the viewer has (a step of 1/8 of the film's frame,
// a quarter to whole: what it is now said in the control), or a size of your own; kept in this browser. Drafts and masters
// are drawn whole whatever it is
const sizeControls = $('#sizeControls'), sizeDynamicPx = $('#sizeDynamicPx');
let previewSize = 'dynamic';
try { previewSize = localStorage.getItem('nle:previewSize') || 'dynamic'; } catch { /* storage refused */ }
if (!['dynamic', '1', '0.5', '0.3333333333', '0.25'].includes(previewSize)) previewSize = 'dynamic';
const quantizePreview = (z) => Math.min(1, Math.max(0.25, Math.ceil(z * 8) / 8));
function viewSize() {
  const z = previewSize === 'dynamic' ? quantizePreview(frameEl.width / FW) : +previewSize;
  return Math.min(1, Math.max(0.25, z));
}
let sizeTimer = null;
function sendSize() {
  const z = viewSize(), dynamicZ = quantizePreview(frameEl.width / FW);
  const px = Math.max(64, Math.min(FW, Math.round((FW * z) / 64) * 64)), ph = Math.round((px * FH) / FW);
  const dynamicPx = Math.max(64, Math.min(FW, Math.round((FW * dynamicZ) / 64) * 64)), dynamicPh = Math.round((dynamicPx * FH) / FW);
  sizeDynamicPx.textContent = `· ${dynamicPx}×${dynamicPh}`;
  const dynamic = sizeControls.querySelector('[data-size="dynamic"]');
  dynamic.title = `Auto · ${dynamicPx} × ${dynamicPh} pixels (as many as the viewer has)`;
  dynamic.setAttribute('aria-label', `Automatic preview resolution · ${dynamicPx} × ${dynamicPh} pixels`);
  for (const b of sizeControls.querySelectorAll('[data-size]')) {
    const on = b.dataset.size === previewSize;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
  }
  sendView();
}
// how this viewer's frames come (tools/nle.mjs viewerSocket 'view'): Auto, Lossless or Compressed, kept for this device; with
// the size they are drawn at and the size it shows them (a compressed frame fits it)
let delivery = 'auto';
try { delivery = localStorage.getItem('nle:delivery') || 'auto'; } catch { /* storage refused */ }
if (!['auto', 'lossless', 'compressed'].includes(delivery)) delivery = 'auto';
$('#deliverySel').value = delivery;
$('#deliverySel').onchange = (e) => { delivery = e.target.value; try { localStorage.setItem('nle:delivery', delivery); } catch { /* only a convenience */ } sendView(); };
// (fills: the editor's own film draws the viewer's frames, or will once it is loaded, so that the studio's workers do not
// load the film to draw them meanwhile; not where it cannot: nle/viewport.js draws)
function sendView() {
  const m = { type: 'view', delivery, w: frameEl.width, h: frameEl.height, scale: viewSize(), memory: VS.memory, fills: viewport.draws }, key = JSON.stringify(m);
  if (key !== VS.view && vsend(m)) VS.view = key;
}
// (what Auto chose: the studio's answer)
function deliveryShown(as) { $('#deliverySel').options[0].textContent = `Auto · ${as === 'compressed' ? 'Compressed' : 'Lossless'}`; }
// ---------- the connection, for a viewer on another device (not near the studio: its answer to 'view'), on the picture
// under its badge: how long the studio takes to answer (a ping every 3 s over the viewer's socket: the median of the last five);
// how much is coming now (every frame's bytes over the last 2 s) of how much it can carry (the cache's frames sent straight
// after the one before, waited: their bytes over the time between their arriving, over the last 10 s); and whether that is
// enough to play (the film's frame rate × the bytes of its frames lately, as they come now: this size, this delivery)
const NET = { near: true, id: 0, pings: new Map(), rtts: [], last: 0, came: [], got: [], sizes: [], shown: 0 };
function netCame(head, bytes) {
  const now = performance.now();
  NET.got.push({ at: now, bytes });
  if (head.kind === 'frame') { NET.sizes.push(bytes); if (NET.sizes.length > 24) NET.sizes.shift(); }
  if (head.waited && NET.last) NET.came.push({ at: now, bytes, gap: now - NET.last });
  NET.last = now;
}
function netAnswered(id) {
  const t = NET.pings.get(id);
  NET.pings.delete(id);
  if (t == null) return;
  NET.rtts.push(performance.now() - t); if (NET.rtts.length > 5) NET.rtts.shift();
}
setInterval(() => {
  if (NET.near) return;
  const now = performance.now(), id = ++NET.id;
  for (const [k, t] of NET.pings) if (now - t > 10_000) NET.pings.delete(k);   // (lost: the socket dropped)
  if (vsend({ type: 'ping', id })) NET.pings.set(id, now);
}, 3000);
const mbit = (bps) => `${bps >= 1e7 ? Math.round(bps / 1e6) : (bps / 1e6).toFixed(1)} Mbit/s`;
function netShown() {
  const chip = $('#netBadge'), now = performance.now();
  if (chip.hidden !== NET.near) chip.hidden = NET.near;
  if (NET.near || now - NET.shown < 500) return;
  NET.shown = now;
  NET.came = NET.came.filter((x) => now - x.at < 10_000); NET.got = NET.got.filter((x) => now - x.at < 2000);
  const used = (NET.got.reduce((a, x) => a + x.bytes, 0) * 8) / 2;
  const rtt = NET.rtts.length ? [...NET.rtts].sort((a, b) => a - b)[NET.rtts.length >> 1] : null;
  const bytes = NET.came.reduce((a, x) => a + x.bytes, 0), gaps = NET.came.reduce((a, x) => a + x.gap, 0);
  // (frames that came too close together to time say only that it is at least so fast; and it carries at least what comes)
  const timed = bytes ? (bytes * 8) / (Math.max(gaps, 50) / 1000) : 0, exact = gaps >= 50 && timed >= used, speed = Math.max(timed, used) || null;
  const fps = S.doc.fps || 60, per = NET.sizes.length ? NET.sizes.reduce((a, b) => a + b, 0) / NET.sizes.length : null, need = per && per * 8 * fps;
  // (said on the picture too: a phone has no tooltips)
  let q = '', say = '', why = rtt != null ? `The studio answers in ${Math.round(rtt)} ms.` : '';
  if (speed && need) {
    const can = Math.max(1, Math.floor(speed / 8 / per));
    if (speed >= need * (exact ? 1.25 : 0.95)) { q = 'good'; say = 'enough to play'; why = `Fast enough to play at ${fps} fps: playing needs about ${mbit(need)}.`; }
    else if (!exact) q = '';
    else if (speed >= need * 0.9) { q = 'tight'; say = 'only just enough'; why = `Only just fast enough to play at ${fps} fps: playing needs about ${mbit(need)}.`; }
    else { q = 'bad'; say = `about ${can} of ${fps} fps`; why = `Too slow to play every frame: about ${can} of ${fps} fps. A smaller preview size needs less.`; }
  }
  const text = [rtt != null && `${Math.round(rtt)} ms`, speed ? `${mbit(used).replace(' Mbit/s', '')} of ${exact ? '' : '> '}${mbit(speed)}` : used && mbit(used), say].filter(Boolean).join(' · ') || 'Measuring the connection…';
  if (chip.textContent !== text) chip.textContent = text;
  if (chip.dataset.q !== q) chip.dataset.q = q;
  why = [why || 'The connection to the studio, measured as frames come.', `Coming in now: ${mbit(used)}${speed ? `, of ${exact ? 'about' : 'more than'} ${mbit(speed)} it can carry` : ''}.`].join(' ');
  if (chip.title !== why) chip.title = why;
}
for (const b of sizeControls.querySelectorAll('[data-size]')) b.classList.toggle('on', b.dataset.size === previewSize);
sizeControls.onclick = (e) => {
  const b = e.target.closest('[data-size]'); if (!b) return;
  previewSize = b.dataset.size;
  try { localStorage.setItem('nle:previewSize', previewSize); } catch { /* storage refused */ }
  sendSize();
};
// render workers on this machine: dynamic, or a number of your own (the status beside it says how many are running)
$('#workersSel').value = String(st.workers ?? 'dynamic');
$('#workersSel').onchange = async (e) => {
  try { const r = await (await linkFetch('/api/workers', { method: 'POST', body: JSON.stringify({ workers: e.target.value }) })).json(); e.target.value = String(r.workers); filmChanged(); }
  catch (err) { toast(`Could not set the workers: ${err.message}`); }
};
// Pre-render (the whole studio's, until it restarts): the studio says whether it is on (S.film.prerender), here and to the other editors
$('#preBtn').onclick = () => post('/api/prerender', { on: !S.film.prerender }).catch((err) => toast(`Could not change Pre-render: ${err.message}`));
setShowCues(showCues);
// sit on the picture itself (inside the letterbox), so it reads as an overlay on the film
new ResizeObserver(() => {
  const { w, h, pw, ph } = placeFrame();
  clearTimeout(sizeTimer); sizeTimer = setTimeout(sendSize, 250);   // (the viewer's size settled: its frames drawn at it)
  ov.style.left = `${(w - pw) / 2 + 12}px`; ov.style.bottom = `${(h - ph) / 2 + 12}px`; ov.style.maxWidth = `${Math.min(520, pw * 0.5)}px`;
}).observe($('#screen'));
// a point cue is in effect until the next cue starts; a range cue while the playhead is inside it
function cuesAt(t) {
  const cues = S.doc.cues, active = [];
  cues.forEach((q, i) => {
    if (q.t > t + 1e-6) return;
    if (q.dur > 0 ? t < q.t + q.dur : !(cues.slice(i + 1).find((x) => x.t > q.t + 1e-6)?.t <= t + 1e-6)) active.push(q);
  });
  return { active: active.sort((a, b) => b.t - a.t).slice(0, 2), next: cues.find((q) => q.t > t + 1e-6) };
}
function cueOverlay() {
  if (!showCues) return;
  const t = S.t, { active, next } = cuesAt(t);
  const key = JSON.stringify(active.map((q) => [q.id, q.label, q.note, q.t, q.dur]));
  if (key !== ovKey) {
    ovKey = key;
    ovRows.innerHTML = active.map((q) => `<div class="ov-row" data-id="${q.id}"><b>${q.label ? esc(q.label) : `<i>cue at ${f2(q.t)}</i>`}</b><span class="when">${f2(q.t)}${q.dur ? `–${f2(q.t + q.dur)}` : ''} · ${barBeat(q.t)}</span>${q.note ? `<span class="note">${esc(q.note)}</span>` : ''}${q.dur ? '<i class="prog"></i>' : ''}</div>`).join('');
  }
  for (const q of active) if (q.dur > 0) { const p = ovRows.querySelector(`[data-id="${q.id}"] .prog`); if (p) p.style.width = `${Math.min(100, ((t - q.t) / q.dur) * 100).toFixed(2)}%`; }
  const nx = next ? `next <b>${next.label ? esc(next.label) : `cue at ${f2(next.t)}`}</b> in <span>${(next.t - t).toFixed(1)} s</span>` : '';
  if (ovNext.innerHTML !== nx) ovNext.innerHTML = nx;
  // the moment a cue hits during playback: a short flash of the accent, to judge sync by eye
  if (audio.playing && ovPrevT != null && t > ovPrevT && t - ovPrevT < 0.25) {
    for (const q of S.doc.cues) if (q.t > ovPrevT && q.t <= t) { const row = ovRows.querySelector(`[data-id="${q.id}"]`); if (row) { row.classList.remove('hit'); void row.offsetWidth; row.classList.add('hit'); } }
  }
  ovPrevT = t;
}

// ---------- playback: dropping frames (on the music's clock: a frame not rendered in time is skipped; the studio renders
// ahead of the playhead) or every frame (each shown as the film is now, slower than real time if need be, the music
// silent: it cannot wait), as Blender's playback offers
const PLAY = { every: (() => { try { return localStorage.getItem('nle:play') === 'every'; } catch { return false; } })(), due: 0, started: 0, drew: [] };
async function startPlay() {
  if (S.pending.length) { clearTimeout(saveTimer); save(); }   // (the frames ahead render with your edits)
  PLAY.due = PLAY.started = performance.now(); PLAY.drew = []; tl.followAgain();
  await audio.play(S.t, { silent: PLAY.every });
}
function stopPlay() { const t = audio.pause(); if (!PLAY.every) S.t = t; bodyClass('playing', false); }
async function togglePlay() {
  if (audio.playing) stopPlay();
  else { if (S.t >= S.end() - 0.01) S.t = 0; await startPlay(); }
  bodyClass('playing', audio.playing);
}
function setPlayMode(every) {
  PLAY.every = every;
  try { localStorage.setItem('nle:play', every ? 'every' : 'drop'); } catch { /* only a convenience */ }
  for (const b of document.querySelectorAll('[data-play]')) b.classList.toggle('on', (b.dataset.play === 'every') === every);
  if (audio.playing) { stopPlay(); startPlay().then(() => bodyClass('playing', true)); }
}
for (const b of document.querySelectorAll('[data-play]')) b.onclick = () => setPlayMode(b.dataset.play === 'every');
setPlayMode(PLAY.every);
// playing every frame: the next one as soon as it can be shown as the film is now (the cache's, or drawn now), never
// faster than the film's rate
function everyFrame() {
  const fps = S.doc.fps || 60, now = performance.now(), n = frameAt(S.t) + 1;
  // (the editor's own film drawing it: once it has shown the frame before)
  const ready = D.own ? (D.ownShown?.f ?? frameAt(D.ownShown?.t ?? -1)) >= n - 1 || n >= S.film.frames.length
    : D.view === 'director' ? D.buf.has(n) || n > Math.floor((S.film.duration || S.end()) * fps) : n >= S.film.frames.length || current(n);
  if (now < PLAY.due || !ready) return;
  PLAY.due = PLAY.due + 1000 / fps < now - 1000 / fps ? now : PLAY.due + 1000 / fps;
  S.t = n / fps;
}
function step(dt, frames) {
  if (audio.playing) stopPlay();
  const fps = S.doc.fps || 60;
  seek(frames ? (Math.round(S.t * fps) + dt) / fps : S.t + dt);
  tl.reveal(S.t);
}
function editPoints() {
  const p = new Set([0, S.end()]);
  for (const q of S.doc.cues) { p.add(q.t); if (q.dur) p.add(q.t + q.dur); }
  for (const { clip } of clipsAll()) { p.add(clip.at); p.add(clipEnd(clip)); }
  for (const c of S.film.cuts) p.add(c);
  return [...p].sort((a, b) => a - b);
}
function jump(dir) {
  if (stepPoint(dir)) return;   // (something selected: its points)
  const p = editPoints(), t = dir > 0 ? p.find((x) => x > S.t + 1e-4) : p.findLast((x) => x < S.t - 1e-4);
  if (t != null) { seek(t); tl.reveal(t); }
}
$('#play').onclick = togglePlay;
$('#tlPlay').onclick = togglePlay;
$('#tlStart').onclick = () => { seek(0); tl.reveal(0); };
$('#toStart').onclick = () => { seek(0); tl.reveal(0); };
$('#toEnd').onclick = () => { seek(S.end()); tl.reveal(S.t); };
$('#stepBack').onclick = () => step(-1, true);
$('#stepFwd').onclick = () => step(1, true);

// ---------- keys
const typingIn = (e) => e.target.closest?.('input, textarea, select, [contenteditable]');
onEvery('keydown', (e) => {
  if (!menu.hidden && e.key === 'Escape') { closeMenu(); return; }
  // (a gesture under way in the editor's own film, the Director view's: its keys)
  if (D.own && VP.gesture) { e.preventDefault(); e.stopPropagation(); viewport.key(e); return; }
  if (gizmo.active) { if (gizmo.key(e)) { e.preventDefault(); e.stopPropagation(); } return; }
  if (tl.gesturing()) { if (tl.gestureKey(e)) { e.preventDefault(); e.stopPropagation(); } return; }
  if (typingIn(e)) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (!$('#help').hidden && (e.key === 'Escape' || e.key === '?')) { $('#help').hidden = true; return; }
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'b') { e.preventDefault(); if (!duplicateSelection()) split(); return; }   // (nothing selected: the clip under the playhead split)
  if (mod && k === 'd') { e.preventDefault(); selectNone(); return; }
  if (mod && k === 's') { e.preventDefault(); toast('No need to save. Edits are saved automatically.'); return; }
  if (mod && k === 'o') { e.preventDefault(); navigate('/'); return; }
  if (mod && k === ',') { e.preventDefault(); openSettings(); return; }
  if (mod && k === 'a') { if (selectAllTimeline()) { e.preventDefault(); return; } }
  if (mod && k === 'c') { if (copyTimelineSelection()) { e.preventDefault(); return; } }
  if (mod && k === 'x') { if (copyTimelineSelection(true)) { e.preventDefault(); return; } }
  if (mod && k === 'v') { if (pasteTimelineSelection()) { e.preventDefault(); return; } }
  if (mod) return;
  if (e.altKey && e.code === 'KeyX') { e.preventDefault(); setRange(null); return; }
  if (e.altKey && e.shiftKey && e.code === 'KeyZ') { e.preventDefault(); setOverlay('on', !OV[D.view].on); return; }
  if (e.key === 'Escape' && !ovPanel.hidden) { overlayPanel(false); return; }
  // over the viewer, with something selected: G moves it, R turns it, S scales it (elsewhere R renders, S splits)
  if (GZ.over && (O.sel || cameraTarget()) && !e.repeat && ['KeyG', 'KeyR', 'KeyS'].includes(e.code)) { e.preventDefault(); if (D.own) viewport.key(e); else gizmo.start({ KeyG: 'move', KeyR: 'rotate', KeyS: 'scale' }[e.code]); return; }
  // elsewhere, G moves the selection's clips, cues, keys and moves in time; S stretches them about the playhead
  if (!GZ.over && !e.repeat && e.code === 'KeyG' && !e.shiftKey && !e.altKey && tl.gesture('move')) { e.preventDefault(); return; }
  if (!GZ.over && !e.repeat && e.code === 'KeyS' && !e.shiftKey && !e.altKey && tl.gesture('stretch')) { e.preventDefault(); return; }
  if (e.shiftKey && e.code === 'KeyI') { e.preventDefault(); return invertSelection(); }
  if (e.shiftKey && e.code === 'KeyA') { e.preventDefault(); return addMenu(null, GZ.over ? GZ.client : null); }
  if (e.shiftKey && e.code === 'KeyD' && O.sel) { e.preventDefault(); return duplicateThings(); }
  if (e.shiftKey && /^Digit[1-9]$/.test(e.code)) { const id = Object.keys(PAGES)[+e.code.slice(5) - 1]; if (id) { e.preventDefault(); layout.setPage(id); return; } }
  const fps = S.doc.fps || 60;
  switch (e.code) {
    case 'Space': e.preventDefault(); if (!e.repeat) togglePlay(); return;
    case 'ArrowLeft': e.preventDefault(); return step(-1, !e.shiftKey);
    case 'ArrowRight': e.preventDefault(); return step(1, !e.shiftKey);
    case 'ArrowUp': e.preventDefault(); return jump(-1);
    case 'ArrowDown': e.preventDefault(); return jump(1);
    case 'Home': e.preventDefault(); seek(0); return tl.reveal(0);
    case 'End': e.preventDefault(); seek(S.end()); return tl.reveal(S.t);
    case 'KeyM': if (!e.repeat) addCue(audio.playing && !PLAY.every ? audio.now(e.timeStamp) : Math.round(S.t * fps) / fps); return;
    case 'KeyS': return split();
    case 'KeyI': return setRange(S.t, S.range && S.range.b > S.t ? S.range.b : Math.max(S.t + 1, S.end()));
    case 'KeyO': return setRange(S.range && S.range.a < S.t ? S.range.a : 0, S.t);
    case 'KeyR': return requestRender();
    case 'KeyN': return toggleSnap();
    case 'KeyK': return toggleMetronome();
    case 'KeyC': return setShowCues(!showCues);
    case 'KeyQ': CV.flip = true; return;
    case 'KeyV': return setView(D.view === 'film' ? 'director' : 'film');
    // (Z along the buttons as they read, left to right; Shift+Z back)
    case 'KeyZ': { const L = [...$('#looks').querySelectorAll('[data-look]')].map((b) => b.dataset.look), l = L[(L.indexOf(S.film.look ?? 'accurate') + (e.shiftKey ? L.length - 1 : 1)) % L.length]; setLook(l); return toast(`Look: ${LOOK_NAMES[l]}`); }
    case 'KeyF': focusSelection(); return;
    case 'KeyH': if (O.sel) hideSelection(); return;
    case 'Equal': case 'NumpadAdd': return tl.zoomAt(S.t, 1.5);
    case 'Minus': case 'NumpadSubtract': return tl.zoomAt(S.t, 1 / 1.5);
    case 'Backslash': return tl.fit();
    case 'Delete': case 'Backspace': e.preventDefault(); if (!deleteSelection() && O.sel && !O.sel.added) toast(`The code places this. Hide it (H), or ask ${panel.short} to remove it.`); return;
    case 'Escape': return stepOut();
    case 'KeyA': e.preventDefault(); return annotate();
    case 'KeyL': e.preventDefault(); return panel.show();
  }
  if (e.key === '?') $('#help').hidden = false;
});
$('#helpBtn').onclick = () => { $('#help').hidden = false; };
$('#help').onclick = (e) => { if (e.target.id === 'help' || e.target.dataset.close != null) $('#help').hidden = true; };
// Snap (nle/snap.js): on or off (N), and the grid things land on — by zoom, or a fixed length — besides the marks they catch
// on (the playhead, cues, clip edges, cuts); kept for this machine, as the piano roll's is
{ try { const k = JSON.parse(localStorage.getItem('nle:snap') || '{}'); if (typeof k.on === 'boolean') S.snap = k.on; if (k.grid === 'zoom' || isSnap(k.grid)) S.snapGrid = k.grid; } catch {} }
S.snapGrid ??= 'zoom';
function snapShown(redraw = true) {   // (not as the page sets up: the timeline is made later)
  const b = $('#snapBtn'), text = !S.snap ? 'Off' : S.snapGrid === 'zoom' ? 'By zoom' : snapName(S.snapGrid);
  b.classList.toggle('on', S.snap);
  if (b.querySelector('span').textContent !== text) b.querySelector('span').textContent = text;
  try { localStorage.setItem('nle:snap', JSON.stringify({ on: S.snap, grid: S.snapGrid })); } catch {}
  if (redraw) tl.invalidate();
}
function setSnap(on, grid = S.snapGrid) { S.snap = on; S.snapGrid = grid; snapShown(); }
function toggleSnap() { setSnap(!S.snap); toast(`Snapping ${S.snap ? 'on' : 'off'}`); }
$('#snapBtn').onclick = () => openMenu($('#snapBtn'), [
  { label: 'By zoom', hint: 'the finest lines in view', checked: S.snap && S.snapGrid === 'zoom', act: () => setSnap(true, 'zoom') },
  { label: 'None', hint: 'N', checked: !S.snap, act: () => setSnap(false) }, 'hr',
  ...snapItems(S.snap ? S.snapGrid : null, (v) => setSnap(true, v)),
]);
snapShown(false);
// the metronome (K): a click on each beat of the grid as the timeline plays (metronome.js), the director's alone; on or
// off and its volume kept for this machine
const METRO = (() => { try { const k = JSON.parse(localStorage.getItem('nle:metronome') || '{}'); return { on: !!k.on, volume: Number.isFinite(k.volume) ? k.volume : 0 }; } catch { return { on: false, volume: 0 }; } })();
function setMetronome(o) {
  Object.assign(METRO, o);
  try { localStorage.setItem('nle:metronome', JSON.stringify(METRO)); } catch { /* only a convenience */ }
  audio.metronome(METRO);
  const vol = $('#metroVol');
  $('#metroBtn').classList.toggle('on', METRO.on); vol.hidden = !METRO.on; vol.value = METRO.volume; vol.title = `Metronome volume: ${METRO.volume > 0 ? '+' : ''}${METRO.volume} dB`;
}
function toggleMetronome() { setMetronome({ on: !METRO.on }); toast(`Metronome ${METRO.on ? 'on' : 'off'}`); }
$('#metroBtn').onclick = toggleMetronome;
$('#metroVol').oninput = (e) => setMetronome({ volume: +e.target.value });
$('#metroVol').onchange = (e) => e.target.blur();   // (left focused, it would take Space)
setMetronome({});
// the listening volume: how loud the editor plays here, over the master (audio.js speakers); this machine's, and never in
// the timeline or a render. Double-click the slider: 0 dB; the speaker mutes it.
const LISTEN = (() => { try { const k = JSON.parse(localStorage.getItem('nle:listen') || '{}'); return { db: Number.isFinite(k.db) ? k.db : 0, on: k.on !== false }; } catch { return { db: 0, on: true }; } })();
function setListening(o) {
  Object.assign(LISTEN, o);
  try { localStorage.setItem('nle:listen', JSON.stringify(LISTEN)); } catch { /* only a convenience */ }
  audio.listening(LISTEN.db, LISTEN.on);
  const vol = $('#listenVol'), words = `${LISTEN.db > 0 ? '+' : ''}${LISTEN.db} dB`;
  vol.value = LISTEN.db; vol.title = `Listening volume: ${words}${LISTEN.on ? '' : ', muted'}. Only what you hear here; renders don't change. Double-click: 0 dB.`;
  $('#listenBtn').classList.toggle('off', !LISTEN.on); $('#listenBtn').title = LISTEN.on ? 'Mute what you hear in the editor. Renders don\'t change.' : 'Unmute';
}
$('#listenVol').oninput = (e) => setListening({ db: +e.target.value, on: true });
$('#listenVol').onchange = (e) => e.target.blur();   // (left focused, it would take Space)
$('#listenVol').ondblclick = () => setListening({ db: 0, on: true });
$('#listenBtn').onclick = () => setListening({ on: !LISTEN.on });
setListening({});
// lit for each beat it clicks (what is heard: the audio clock), brighter on a bar's first
function metroBeat() {
  const b = $('#metroBtn'), heard = METRO.on && audio.playing && !PLAY.every;
  const p = heard && position(grid(), audio.now()), lit = heard && (p.beat % 1) * p.part.beat < 0.09;
  b.classList.toggle('beat', !!lit); b.classList.toggle('bar', !!lit && p.beat < 1);
}
$('#addTrack').onclick = addTrack;
$('#addNotes').onclick = addNotes;
$('#zoomIn').onclick = () => tl.zoomAt(S.t, 1.5);
$('#zoomOut').onclick = () => tl.zoomAt(S.t, 1 / 1.5);
$('#zoomFit').onclick = () => tl.fit();
// clicking a control must not leave it focused, or Space would press it instead of playing
for (const b of document.querySelectorAll('button')) b.addEventListener('mouseup', () => b.blur());

// ---------- media: the project's (media/, the Assets panel), brought in by dropping files on the editor or the panel,
// or its Import; placed on the timeline where they are dropped (a file, or an asset dragged from the panel), at the
// playhead on a double-click. A sound goes on a track heard; a picture (an image, a video) on a track seen, which the
// film shows in the world where the clip starts (a card under its camera, filling its frame there: engine/runtime.js).
const MEDIA_TYPE = 'application/x-ephemeris-media';
const kindOfFile = (f) => (/^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(f.name) ? 'image' : /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(f.name) ? 'video'
  : /^audio\//.test(f.type) || /\.(wav|mp3|m4a|aac|ogg|oga|flac|aiff?|opus)$/i.test(f.name) ? 'audio' : null);
const STILL = 5;   // (an image's clip, at first: as long as an editor's still)
/** Copies a file into the project's media/ (committed there): what it is (tools/media.mjs: probe), or null. */
async function importFile(f) {
  const r = await linkFetch(`api/media?name=${encodeURIComponent(f.name)}&dir=${encodeURIComponent(assetsInto())}`, { method: 'POST', body: f });
  if (!r.ok) { toast(`Couldn't copy ${f.name}`, true); return null; }
  return r.json();
}
/** Places media (as the studio says it is) on the timeline at t (on track `trackId` if it is of its kind); the time after
 *  it. A video with sound brings its sound too, on an audio track at the same time (trimmed and moved on its own). */
async function placeMedia(info, t, trackId = null) {
  const visual = info.kind === 'image' || info.kind === 'video';
  if (!info.kind) { toast(`${info.name}: not a sound, image or video`, true); return t; }
  if (visual && !info.w) { toast(`Couldn't read ${info.name}`, true); return t; }
  // its entry among the timeline's media (a video's sound one of its own, the same file heard)
  const idFor = (kind, suffix = '') => {
    const found = Object.keys(S.doc.media).find((k) => S.doc.media[k].src === info.src && (S.doc.media[k].kind ?? 'audio') === kind);
    if (found) return found;
    const base = (info.name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || info.kind) + suffix;
    let id = base; for (let n = 2; S.doc.media[id]; n++) id = `${base}-${n}`;
    return id;
  };
  const heard = async (id) => { const m = await audio.load(id, resolve(info.src)); if (!m.buffer) toast(`Couldn't decode ${info.name}'s sound: ${m.error}`, true); return m.buffer ? r6(m.buffer.duration) : null; };
  const at0 = r6(t), adds = [];
  let len;
  if (visual) {
    len = info.kind === 'video' ? r6(info.duration ?? STILL) : STILL;
    const track = S.doc.tracks.find((x) => x.id === trackId && isPictures(x)) ?? S.doc.tracks.find(isPictures);
    adds.push({ visual: true, id: idFor(info.kind), track: track?.id ?? newId('v'), clip: { id: newId('c'), at: at0, in: 0, out: len },
      entry: { src: info.src, kind: info.kind, name: info.name, w: info.w, h: info.h, ...(info.kind === 'video' && { duration: info.duration, fps: info.fps, frames: info.frames }) } });
  }
  if (!visual || info.sound) {
    const id = idFor('audio', visual ? '-sound' : ''), dur = await heard(id);
    if (dur != null) {
      len ??= dur;
      const track = S.doc.tracks.find((x) => x.id === trackId && !isVisual(x)) ?? S.doc.tracks.find((x) => !isVisual(x));
      adds.push({ visual: false, id, track: track?.id ?? newId('a'), clip: { id: newId('c'), at: at0, in: 0, out: Math.min(len, dur), gain: 0, fadeIn: 0, fadeOut: 0 }, entry: visual ? { src: info.src, kind: 'audio' } : { src: info.src } });
    }
  }
  if (!adds.length) return t;
  edit(`add "${adds[0].id}"${adds.length > 1 ? ' and its sound' : ''} at ${f2(at0)}`, (d) => {
    for (const a of adds) {
      d.media[a.id] = a.entry;
      if (!d.tracks.some((x) => x.id === a.track)) d.tracks.push(a.visual ? { id: a.track, name: `Pictures ${d.tracks.filter(isPictures).length + 1}`, kind: 'visual', clips: [] } : { id: a.track, name: `Audio ${d.tracks.filter((x) => !isVisual(x)).length + 1}`, clips: [] });
      d.tracks.find((x) => x.id === a.track).clips.push({ ...a.clip, media: a.id });
    }
  });
  return t + len;
}
const carries = (e) => [...e.dataTransfer.types].some((x) => x === 'Files' || x === MEDIA_TYPE);
onEvery('dragover', (e) => {
  if (!carries(e)) return;
  e.preventDefault(); bodyClass('dropping', true);
  const at = tl.dropAt(e.clientX, e.clientY); tl.setDropLane(at?.lane?.kind === 'track' ? at.lane : null);
});
onEvery('dragleave', (e) => { if (!e.relatedTarget) { bodyClass('dropping', false); tl.setDropLane(null); } });
onEvery('drop', async (e) => {
  if (!carries(e)) return;
  e.preventDefault(); bodyClass('dropping', false); tl.setDropLane(null);
  // (onto the assets panel: brought in, not placed)
  const intoPanel = e.target.closest?.('#assetsPanel');
  const asset = e.dataTransfer.getData(MEDIA_TYPE);
  const at = tl.dropAt(e.clientX, e.clientY);
  let t = at?.t ?? S.t;
  if (asset) { if (!intoPanel) await placeMedia(JSON.parse(asset), t, at?.track); return; }
  const files = [...e.dataTransfer.files].filter(kindOfFile);
  if (!files.length) return toast('Drop sounds, images or video (wav, mp3, png, jpg, mp4, mov…)', true);
  for (const f of files) {
    const info = await importFile(f);
    if (info && !intoPanel) t = await placeMedia(info, t, at?.track);
  }
  assets();
});

// the Assets panel: the project's files in an explorer (explorer.js), from assets/ (up to the project's root and back) —
// its sounds, pictures and videos, each dragged onto the timeline or double-clicked (at the playhead), placed where it
// is; a file of another kind (a font, a model) listed, not placed. A file brought in goes to the folder of assets/ shown
// (of media/, in a project from before assets/ held them)
const ASSETS_HOME = 'assets';
const assetsInto = () => { const r = assetsEx.root(); return /^(assets|media)(\/|$)/.test(r) ? r : ASSETS_HOME; };
const sizeText = (b) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const mediaText = (m) => [m.w && `${m.w} × ${m.h}`, m.kind === 'video' && (m.sound ? 'with sound' : 'silent'), m.duration && `${m.duration < 60 ? m.duration.toFixed(1) : `${Math.floor(m.duration / 60)}:${String(Math.round(m.duration % 60)).padStart(2, '0')}`} s`, m.fps && `${+m.fps.toFixed(2)} fps`].filter(Boolean).join(' · ');
const isPlaceable = (e) => !!e.info?.kind;   // (a sound, a picture or a video the studio could read: api/files probe)
const assetsEx = createExplorer({
  el: $('#assetList'), list: folderSource(linkFetch, { probe: true }), home: ASSETS_HOME, key: 'assets', project: S.dir.split('/').pop(), empty: 'Drop sounds, images or video here, or Import.',
  row: (e) => {
    const m = e.info, kind = e.kind === 'text' ? null : e.kind, used = Object.values(S.doc.media).some((x) => x.src === e.path);
    const pic = kind === 'image' ? `<img src="${esc(resolve(e.path))}" alt="" loading="lazy">` : kind === 'video' && m?.frames ? `<img src="${esc(resolve(`${m.frames}/000001.jpg`))}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('i'),{textContent:'▶'}))">` : `<i>${kind === 'audio' ? '♪' : kind === 'video' ? '▶' : esc((/\.(\w+)$/.exec(e.name)?.[1] ?? '·').slice(0, 4))}</i>`;
    return `<span class="pic ${kind ?? 'other'}">${pic}</span><span class="txt${used ? ' used' : ''}"><b>${esc(e.name)}</b><span>${esc((m && mediaText(m)) || sizeText(e.size))}</span></span>`;
  },
  on: {
    dblclick: (e) => { if (isPlaceable(e)) placeMedia(e.info, S.t); },
    draggable: isPlaceable,
    drag: (e, ev) => { if (!isPlaceable(e)) return false; ev.dataTransfer.setData(MEDIA_TYPE, JSON.stringify(e.info)); ev.dataTransfer.effectAllowed = 'copy'; return true; },
  },
});
// (the folders shown listed again: a file brought in)
const assets = () => assetsEx.refresh();
$('#assetImport').onclick = () => $('#assetFile').click();
$('#assetFile').onchange = async (e) => { for (const f of [...e.target.files]) await importFile(f); e.target.value = ''; assets(); };

// ---------- toasts, log
function toast(text, bad) {
  const el = document.createElement('div'); el.className = `toast${bad ? ' bad' : ''}`; el.textContent = text;
  $('#toasts').append(el); setTimeout(() => el.remove(), 2600);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
}
// ---------- settings: this machine's, for every project (the studio's config): the agent (its name, and the harness it
// runs on: tools/agent.mjs) and the preset folders (tools/presets.mjs); opened at a section (agent, presets)
const KIND_SAY = { studio: 'comes with Ephemeris', yours: 'every project', project: 'this project', added: '' };
function openSettings(at = null) {
  if (document.querySelector('.overlay.settings')) return;
  const o = document.createElement('div'); o.className = 'overlay settings';
  o.innerHTML = '<div class="sheet"><div class="sheet-head"><b>Settings</b><button class="link" data-close>Close · Esc</button></div><div class="set-body"><section class="set-sec" data-sec="agent"></section><section class="set-sec" data-sec="presets"></section><section class="set-sec" data-sec="devices"></section></div></div>';
  const body = o.querySelector('.set-body'), agentEl = body.querySelector('[data-sec=agent]'), presetsEl = body.querySelector('[data-sec=presets]'), devicesEl = body.querySelector('[data-sec=devices]'), pick = window.studioApp?.pickFolder;
  const close = () => { o.remove(); document.removeEventListener('keydown', onKey, true); instrumentPanel?.presetsChanged(); panel.sync(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  o.onclick = (e) => { if (e.target === o || e.target.closest('[data-close]')) close(); };
  document.addEventListener('keydown', onKey, true);
  document.body.append(o);
  if (at) requestAnimationFrame(() => body.querySelector(`[data-sec=${at}]`)?.scrollIntoView({ block: 'start' }));
  // the agent: what the director calls it, and which harness runs it (each with whether it is ready here, and how to make it so)
  const agent = ({ name, defaultName, harness, harnesses }) => {
    agentEl.innerHTML = `<div class="set-h"><b>Agent</b><span class="hint">The agents’ name and the default harness for new conversations.</span></div>
      <div class="set-rows"><label class="set-row set-name"><b>Name</b><input name="agentName" value="${esc(name)}" placeholder="${esc(defaultName)}" maxlength="40" spellcheck="false"><span class="dim">what the studio calls it, and the agent itself</span></label>
      ${harnesses.map((h) => `<label class="set-row set-harness${h.ready ? '' : ' unready'}"><b><input type="radio" name="harness" value="${h.id}"${h.id === harness ? ' checked' : ''}>${esc(h.label)}</b><span class="set-status${h.ready === undefined ? ' dim' : ''}" title="${esc([h.detail, h.where].filter(Boolean).join('\n'))}">${h.experimental ? `<span class="set-exp" title="${esc(h.experimental)}">Highly experimental</span>` : ''}${h.ready === undefined ? 'checking…' : `<i class="${h.ready ? 'ok' : 'no'}"></i>${esc(h.detail)}`}</span>${h.fix ? `<code class="set-fix" title="Run this in a terminal">${esc(h.fix)}</code>` : '<span></span>'}${h.actions?.length ? `<span class="set-acts">${h.actions.map((x) => `<button class="btn" data-act="${esc(x.id)}" data-harness="${h.id}" title="${esc(x.note ?? '')}"${acting ? ' disabled' : ''}>${esc(x.label)}</button>`).join('')}${h.actions.filter((x) => x.caution).map((x) => `<span class="hint">${esc(x.label)}: ${esc(x.note)}</span>`).join('')}</span>` : ''}</label>`).join('')}</div>`;
  };
  // what a harness's settings do (install, sign in or out): answered once done; meanwhile its state, read again (how far an
  // install has come)
  let acting = false;
  agentEl.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    e.preventDefault();
    acting = true;
    for (const x of agentEl.querySelectorAll('[data-act]')) x.disabled = true;
    const poll = setInterval(() => loadAgent(), 1500);
    try { await loadAgent({ act: { harness: b.dataset.harness, id: b.dataset.act } }); } finally { clearInterval(poll); acting = false; loadAgent(); }
  };
  // (a studio started before a section existed answers nothing for it: this page is read anew on each load, its server
  // only when the app starts)
  const stale = (el, what) => { el.innerHTML = `<div class="set-h"><b>${what}</b></div><div class="set-rows"><div class="set-row set-stale">The studio’s server started before this setting existed: quit Ephemeris and open it again (reloading the window is not enough).</div></div>`; };
  const loadAgent = async (change) => {
    const res = await linkFetch('api/settings/agent', change ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) } : {}).catch(() => null);
    if (res?.status === 404) return stale(agentEl, 'Agent');
    const r = res ? await res.json().catch((e) => ({ error: e.message })) : { error: 'The studio is not answering.' };
    if (r.error) return toast(r.error, true);
    agent(r);
    if (change?.name !== undefined) panel.named(r.name);
  };
  agentEl.onchange = (e) => {
    if (e.target.name === 'harness') {
      loadAgent({ harness: e.target.value });
    }
    if (e.target.name === 'agentName') loadAgent({ name: e.target.value });
  };
  agentEl.onkeydown = (e) => { if (e.key === 'Enter' && e.target.name === 'agentName') e.target.blur(); };
  agent({ name: panel.name, defaultName: AGENT_NAME, harness: null, harnesses: [] });
  loadAgent();
  const show = ({ folders }) => {
    presetsEl.innerHTML = `<div class="set-h"><b>Preset folders</b><span class="hint">Their presets show in the Instrument panel and in Vial.</span></div>
      <div class="set-rows">${folders.map((f) => `<div class="set-row"><b>${esc(f.label)}</b><span class="set-path" title="${esc(f.path)}">${esc(f.path)}</span><span class="dim">${f.presets} preset${f.presets === 1 ? '' : 's'}</span>${f.kind === 'added' ? `<button class="link" data-remove="${esc(f.path)}">Remove</button>` : `<span class="dim">${KIND_SAY[f.kind]}</span>`}</div>`).join('')}</div>
      <div class="set-add">${pick ? '<button class="btn" data-add>Add a folder…</button>' : '<input name="folder" placeholder="A folder on this machine, as a path" spellcheck="false"><button class="btn" data-add>Add</button>'}</div>`;
  };
  const load = async (change) => {
    const res = await linkFetch('api/settings/presets', change ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) } : {});
    if (res.status === 404) return stale(presetsEl, 'Preset folders');
    const r = await res.json();
    if (r.error) return toast(r.error, true);
    show(r);
  };
  presetsEl.onclick = async (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) return load({ remove: rm.dataset.remove });
    if (!e.target.closest('[data-add]')) return;
    const folder = pick ? await pick('A folder of presets') : presetsEl.querySelector('input[name=folder]').value.trim();
    if (folder) load({ add: folder });
  };
  presetsEl.onkeydown = (e) => { if (e.key === 'Enter' && e.target.name === 'folder') presetsEl.querySelector('[data-add]').click(); };
  load();
  // other devices (a phone, another computer): the password they open the studio with (tools/nle.mjs allowed), and where
  const devices = ({ password, addresses }) => {
    devicesEl.innerHTML = `<div class="set-h"><b>Other devices</b><span class="hint">Open the studio on a phone or another computer at one of these addresses, with this password.</span></div>
      <div class="set-rows"><label class="set-row set-name"><b>Password</b><input name="password" type="password" value="${esc(password)}" placeholder="None: other devices can’t open the studio" spellcheck="false" autocomplete="off"><button class="link" data-reveal>Show</button></label>
      ${addresses.map((a) => `<div class="set-row"><b></b><span class="set-path">${esc(a)}</span><span></span><span></span></div>`).join('')}</div>`;
  };
  const loadDevices = async (change) => {
    const res = await linkFetch('/api/settings/devices', change ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) } : {}).catch(() => null);
    if (res?.status === 404) return stale(devicesEl, 'Other devices');
    const r = res ? await res.json().catch((e) => ({ error: e.message })) : { error: 'The studio is not answering.' };
    if (r.error) return toast(r.error, true);
    devices(r);
  };
  devicesEl.onclick = (e) => {
    const b = e.target.closest('[data-reveal]'), input = devicesEl.querySelector('input[name=password]');
    if (!b) return;
    e.preventDefault();
    input.type = input.type === 'password' ? 'text' : 'password'; b.textContent = input.type === 'password' ? 'Show' : 'Hide';
  };
  devicesEl.onchange = (e) => { if (e.target.name === 'password') loadDevices({ password: e.target.value }); };
  devicesEl.onkeydown = (e) => { if (e.key === 'Enter' && e.target.name === 'password') e.target.blur(); };
  loadDevices();
}

function showLog(text) {
  const o = document.createElement('div'); o.className = 'overlay';
  o.innerHTML = '<div class="sheet"><div class="sheet-head"><b>Render log</b><button class="link">Close</button></div><pre class="log"></pre></div>';
  o.querySelector('pre').textContent = text; o.onclick = (e) => { if (e.target === o || e.target.tagName === 'BUTTON') o.remove(); };
  document.body.append(o);
}

// ---------- server events
const es = new LinkEvents('api/events');
openViewerSocket();
es.addEventListener('render', (e) => { S.render = JSON.parse(e.data); renderState(); });
es.addEventListener('draft', (e) => { S.draft = JSON.parse(e.data); renderState(); if (S.draft) toast(`Draft saved: ${S.dir}/renders/${S.timeline}/draft.mp4`); });
es.addEventListener('preview', (e) => { S.film = JSON.parse(e.data); viewport.sync(S.film); filmChanged(); lookShown(); machineShown(); });
es.addEventListener('machine', (e) => { S.machine = JSON.parse(e.data); machineShown(); });
es.addEventListener('compiling', (e) => compilingShown(JSON.parse(e.data)));
es.addEventListener('working', (e) => { const now = performance.now(); WK.list = JSON.parse(e.data).map((w) => ({ ...w, since: now - w.ago })); });
es.addEventListener('disk', (e) => onDisk(JSON.parse(e.data).text));
es.addEventListener('rekey', (e) => onRekey(JSON.parse(e.data)));
es.addEventListener('music', () => loadMusic());
es.addEventListener('sound', () => loadSound());
es.addEventListener('instruments', (e) => { const { files } = JSON.parse(e.data); audio.instrumentsChanged(files); instrumentPanel?.forget(files); });
es.addEventListener('history', (e) => versionKept(JSON.parse(e.data).version));
es.addEventListener('timelines', (e) => timelineTabs(JSON.parse(e.data)));
es.addEventListener('files', (e) => { const d = JSON.parse(e.data); codePanel.filesChanged(d); assetsEx.refresh(d.paths); });
es.addEventListener('closed', (e) => closed(JSON.parse(e.data)));
es.addEventListener('agent', (e) => { const x = JSON.parse(e.data); panel.event(x); if (x.agent === panel.id && (!x.timeline || x.timeline === S.timeline)) presence.event(x); });
es.addEventListener('agents', (e) => panel.agents(JSON.parse(e.data)));
es.addEventListener('projects', (e) => projectTabs(JSON.parse(e.data)));
es.addEventListener('show', (e) => onShow(JSON.parse(e.data)));
// the studio's mix, where it is what plays (MIX): asked for as the editor opens and whenever what is heard may have changed
// (the studio makes it again if so, and says when it has: 'mix')
let mixSaid = '';
async function followMix() {
  const r = await linkFetch('api/mix').then((x) => x.json()).catch(() => null);
  if (r?.ready) audio.useMix(r.none ? null : `api/mix/${r.key}.m4a`);
  if (r?.error && r.error !== mixSaid) toast(`The sound could not be mixed: ${r.error.split('\n')[0]}`, true);
  mixSaid = r?.error ?? '';
}
if (MIX) { followMix(); for (const ev of ['mix', 'disk', 'sound', 'instruments', 'music', 'open']) es.addEventListener(ev, followMix); }

// ---------- boot
// ---------- motion lanes (lanes.js): what the camera's and the selection's properties are made of, in the timeline
const pop = document.createElement('div');
pop.className = 'mpop'; pop.hidden = true; document.body.append(pop);
function popover(anchor, html, pick) {
  anchor.ownerDocument.body.append(pop);   // (in the anchor's window)
  pop.innerHTML = html; pop.hidden = false;
  const r = anchor.getBoundingClientRect(), h = pop.offsetHeight, w = pop.offsetWidth, win = anchor.ownerDocument.defaultView;
  pop.style.left = `${Math.max(8, Math.min(win.innerWidth - w - 8, r.left))}px`;
  pop.style.top = `${r.bottom + h + 6 > win.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  pop.onclick = (e) => { const b = e.target.closest('[data-mpick]'); if (b && !b.disabled) { pop.hidden = true; pick?.(b.dataset.mpick); } };
}
onEvery('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-m=mode], [data-m=addop], [data-mi=addop]')) pop.hidden = true; }, true);
onEvery('keydown', (e) => { if (e.key === 'Escape') pop.hidden = true; });
// ---------- moving, turning, scaling the selection in the viewer (engine/gizmo.js): G, R, S over the viewer, or its handles.
// The gizmo shows the thing clicked last; each other thing selected changes with it: moved and turned by as much,
// scaled as many times, each about its own centre (what it lacks, as a light's turn, it keeps): one edit
// The film camera, selected (its lanes, nothing in the viewer) in the director's view, is the gizmo's too: G moves it, R
// turns it (about where its x, y, z are: an orbit camera's target, the eye of the others), S zooms it; its pitch, yaw
// and roll are the gizmo's rx, ry, rz, its zoom its s (what a target camera lacks, its pitch and yaw, it keeps)
const CAMK = { rx: 'pitch', ry: 'yaw', rz: 'roll', s: 'zoom' };
function cameraTarget() {
  if (O.sel || D.view !== 'director' || lanes.selected()?.th !== 'camera') return null;
  const at = (k) => lanes.shown('camera', k);
  return at('x') == null ? null : { kind: 'camera', label: 'Camera', where: { x: at('x'), y: at('y'), z: at('z') ?? 0 } };
}
const gizmoShown = (k) => (O.sel ? lanes.shown('sel', k) : lanes.shown('camera', CAMK[k] ?? k));
function valueEditsAll(vals, v0) {
  if (!O.sel) {   // (the film camera)
    const v = Object.fromEntries(Object.entries(vals).map(([k, x]) => [CAMK[k] ?? k, x]).filter(([k]) => lanes.shown('camera', k) != null));
    return Object.keys(v).length ? lanes.valueEdits('camera', v, { into: true }) : null;
  }
  const es = [lanes.valueEdits('sel', vals, { into: true })];
  O.also.forEach((_, i) => {
    const id = `also:${i}`, v = {};
    for (const [k, x] of Object.entries(vals)) { const now = lanes.shown(id, k); if (now != null) v[k] = Math.round((/^s[xyz]?$/.test(k) ? now * (x / (v0[k] || 1)) : now + (x - v0[k])) * 1000) / 1000; }
    if (Object.keys(v).length) es.push(lanes.valueEdits(id, v));
  });
  if (es[0]?.error) return es[0];
  if (es.some((e) => !e?.fn)) return null;
  return { desc: es.length > 1 ? `${es.length} things: ${es[0].desc}` : es[0].desc, fn: (d) => { for (const e of es) e.fn(d); } };
}
const GZ = { mouse: null, over: false };
// a gesture's values (the gizmo's: here, or in the editor's own film's viewport), into the lanes, one edit; whether made
function commitGesture(vals, outline, v0) {
  const e = valueEditsAll(vals, v0);
  if (!e) { toast('Its lanes are not ready yet: try again in a moment'); return false; }
  if (e.error) { toast(e.error); return false; }
  edit(e.desc, e.fn);
  if (O.sel && O.now) O.now = { ...O.now, where: { ...O.now.where, ...vals }, outline: outline ?? O.now.outline };
  inspector();
  return true;
}
const hud = document.createElement('div');
hud.className = 'gizmo-hud'; hud.hidden = true; $('#screen').append(hud);
const toFrame = (e) => { const r = frameEl.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * FW, ((e.clientY - r.top) / r.height) * FH]; };
// (the picture with the change as it goes is the viewer's: it draws the gesture's timeline, gizmo.doc())
const gizmo = createGizmo({
  sel: () => (O.sel ? O.now : cameraTarget()),
  cam: overlayCam,
  k: () => FW / (frameEl.getBoundingClientRect().width || FW),
  mouse: () => GZ.mouse,
  shown: gizmoShown,
  edits: (vals, v0) => { const e = valueEditsAll(vals, v0); return e?.fn ? e : null; },
  commit: commitGesture,
  // (and where it goes: the lane selected, or your keys)
  hud(html) { hud.hidden = !html; if (html) hud.innerHTML = `${html}<span class="into">${esc(lanes.intoText(O.sel ? 'sel' : 'camera'))}</span>`; },
  paint: () => paintObjects(),
  toast, doc: () => S.doc,
});
{
  const scr = $('#screen');
  scr.addEventListener('pointermove', (e) => { GZ.mouse = toFrame(e); GZ.client = { x: e.clientX, y: e.clientY }; GZ.over = true; });
  scr.addEventListener('pointerleave', () => { GZ.over = false; });
  // a handle grabbed: a gesture for as long as it is held
  scr.addEventListener('pointerdown', (e) => {
    const pt = e.target.closest('.path-pt');
    if (pt && e.button === 0 && !gizmo.active) {
      e.preventDefault(); e.stopImmediatePropagation(); O.down = null;
      const p = PATH.pts[+pt.dataset.pt];
      if (p) { goToPoint(p); PATH.down = { x: e.clientX, y: e.clientY }; }
      return;
    }
    const h = e.target.closest('.gz');
    if (!h || e.button !== 0 || gizmo.active) return;
    e.preventDefault(); e.stopImmediatePropagation(); O.down = null;
    GZ.mouse = toFrame(e);
    gizmo.start(h.dataset.gz, { axis: h.dataset.axis || null, drag: true });
  }, true);
}
onEvery('pointermove', (e) => {
  // (a point held and dragged: the thing moved there, its outline left out, being of another moment)
  if (PATH.down && !gizmo.active && Math.hypot(e.clientX - PATH.down.x, e.clientY - PATH.down.y) > 4) { PATH.down = null; GZ.mouse = toFrame(e); gizmo.start('move', { drag: true, bare: true }); }
  if (gizmo.active) { GZ.mouse = toFrame(e); gizmo.move(GZ.mouse, e.shiftKey, e.ctrlKey || e.metaKey); }
});
onEvery('pointerup', (e) => { PATH.down = null; if (gizmo.dragging) { e.preventDefault(); gizmo.finish(true); } });
// a gesture from the keys: a click sets it, a right click puts it back (and neither picks)
onEvery('pointerdown', (e) => { if (!gizmo.active || gizmo.dragging) return; e.preventDefault(); e.stopImmediatePropagation(); O.down = null; gizmo.finish(e.button === 0); }, true);
onEvery('contextmenu', (e) => { if (gizmo.active) e.preventDefault(); }, true);

// a track's instrument, whatever plays it: its motion's lanes, and its key; each parameter's base (its value, 0–1 of its
// range), its title and its values in its words (device.js)
function instrumentOn(track) {
  const spec = track?.instrument;
  if (!spec || isVisual(track)) return null;
  const key = pluginKey(track.id), info = () => audio.plugins.status(key)?.info;
  const params = () => (spec.plugin ? pluginParams(info(), spec.set) : paramsOf(spec, { sampler: audio.samplerData(spec) }));
  const of = (k) => params().find((p) => p.key === k);
  return { key, track: track.id, label: `${spec.plugin ? info()?.name ?? spec.plugin : deviceOf(spec).device} · ${track.name || track.id}`,
    base: (k) => of(k)?.norm ?? 0.5, title: (k) => of(k)?.title ?? k, text: (k, n) => { const p = !spec.plugin && of(k); return p ? textOf(p, fromNorm(p, n)) : null; } };
}
// the instrument of the track the selected clips are on (all on one)
function selectedInstrument() {
  const clips = clipsAll().filter(({ clip }) => S.sel.has(clip.id));
  return clips.length && new Set(clips.map((x) => x.track.id)).size === 1 ? instrumentOn(clips[0].track) : null;
}
// the instruments whose motion shows: the selected notes clip's, and every one on a track whose motion is shown (kept:
// shown even with nothing moving it yet)
function instrumentsShown() {
  const out = new Map(), sel = selectedInstrument();
  if (sel) out.set(sel.key, sel);
  for (const track of S.doc.tracks) {
    if (isVisual(track) || !lanes.trackShown(track.id)) continue;
    const i = instrumentOn(track);
    if (i) out.set(i.key, { ...i, kept: true });
  }
  return [...out.values()];
}
const lanes = createLanes({
  S, post, toast, names, onOf, codeAround, showCode, popover, instruments: instrumentsShown, score: () => SOUND.score, agentName: () => panel.short,
  edit: (desc, fn) => edit(desc, fn),
  // (a whole object: its lines, beside the copy its lanes are read from)
  draft: () => draftNow(), selection: () => (O.sel ? { at: O.sel.at, nth: O.sel.nth, key: O.sel.key, like: O.sel.like, copy: O.sel.copy, copies: O.sel.copies, label: O.sel.label, kind: O.sel.kind, file: O.sel.file, line: O.sel.line, ...(O.sel.sites && { sites: O.sel.sites, object: O.sel.object }) } : null),
  others: () => O.also.map((x) => ({ ...refOf(x), label: x.label, kind: x.kind, file: x.file, line: x.line, ...(x.sites && { object: x.object }) })),
  relayout: () => { tl.relayout(); tl.invalidate(); laneCtl(); },
  // (a lane selected: the timeline's cues and clips are not, except the clip whose instrument's lanes these are)
  panels: () => {
    const s = lanes.selected();
    if (s && !s.th.startsWith('inst:')) { S.sel = new Set(); linesOff(); if (s.th !== 'sel' && !s.th.startsWith('also:')) dropThing(); }
    panels();
  },
  ask: (text) => panel.ask(text),
});
// the timeline bar's lane controls: which properties show, how tall the lanes are (Fit: as tall as the timeline allows)
function laneCtl() {
  const el = $('#laneCtl'), on = lanes.M.things.length > 0;
  el.hidden = !on;
  for (const b of el.querySelectorAll('[data-show]')) b.classList.toggle('on', b.dataset.show === lanes.M.show);
  $('#foldBtn').hidden = !(S.doc.overrides ?? []).length && !addedClips(S.doc).length;
}
$('#laneCtl').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.fold != null) return panel.ask('Fold my changes in the timeline (its overrides, and the things I added by hand) into the film’s code, as the manual’s motion chapter says: make the code produce the same film, then remove them from the timeline, in one commit that says so. Tell me what changed where.');
  if (b.dataset.show) lanes.setShow(b.dataset.show);
  if (b.dataset.lh === 'fit') {
    const rows = tl.lanes(), fixed = rows.filter((r) => !(r.kind === 'mlane' || (r.kind === 'mprop' && r.P.open))).reduce((a, r) => a + r.h, 0);
    const open = rows.filter((r) => r.kind === 'mlane' || (r.kind === 'mprop' && r.P.open)).reduce((a, r) => a + lanes.DEF_H[r.kind], 0);
    lanes.setScale(0, ($('#lanes').clientHeight - fixed - 8) / Math.max(1, open));
  } else if (b.dataset.lh) lanes.setScale(+b.dataset.lh);
};
// your changes orphaned by an edit to the code they were on (anchors.js): each, with the code it was on, to remove;
// or Claude to attach them again
const short = (c) => (!c ? 'code no longer there' : c.length > 54 ? `${c.slice(0, 53)}…` : c);
function orphanWhat(l) {
  const at = l.site.replace(/^orphan:/, '').replace(/:\d+$/, '');
  if (l.kind === 'cue') return `Cue “${l.cue.label || l.cue.id}” on ${at}: ${short(l.code)}`;
  if (l.kind === 'change') return `${l.override.stack ? 'A motion' : l.override.on?.sites ? 'An object' : 'A thing'} at ${at}, all your changes to it: ${short(l.code)}`;
  if (l.kind === 'line') return `A line placing “${l.override.on.label || 'an object'}” at ${at} (your changes stay on its other lines): ${short(l.code)}`;
  const k = Object.keys(l.override.ops ?? {}).find((n) => n === l.site || n.startsWith(`${l.site}#`));
  const what = k ? Object.keys(l.override.ops[k]).join(', ') : 'its order or mute';
  return `Your ${what} at ${at}: ${short(l.code)}`;
}
function orphansBtn() {
  const n = orphansIn(S.doc).length, b = $('#orphansBtn');
  b.hidden = !n;
  b.textContent = `${n} orphaned`;
}
$('#orphansBtn').onclick = () => {
  const L = orphansIn(S.doc);
  if (!L.length) return;
  const ask = () => panel.ask(`Some of my changes in the timeline are orphaned: the code they were on was edited, so they no longer apply. For each, find where its code is now and attach it again (rename its orphan:file:line:col names in the timeline to that place, keeping any #n), or tell me its code is gone and what the change did. Ask me if it is not clear which code it belongs to.\n${L.map((l) => `- ${l.site} (${l.kind}): was on \`${l.code ?? '?'}\``).join('\n')}`);
  openMenu($('#orphansBtn'), [
    ...L.map((l) => ({ label: orphanWhat(l), hint: 'Remove', act: () => edit(`remove an orphaned change (${l.site.replace(/^orphan:/, '')})`, (d) => Object.assign(d, dropOrphan(d, l))) })),
    'hr',
    { label: `Ask ${panel.short} to attach them again`, act: ask },
    { label: `Remove ${L.length === 1 ? 'it' : `all ${L.length}`}`, act: () => edit(`remove ${L.length} orphaned change${L.length > 1 ? 's' : ''}`, (d) => { let x = d; for (const l of orphansIn(d)) x = dropOrphan(x, l); Object.assign(d, x); }) },
  ]);
};

// ---------- the agent (agent.js): the panel, with the studio as it is for each message; and the agent showing you things
const panel = createAgentPanel({
  simple: SIMPLE, project: S.name, timeline: S.timeline, openTimeline: goTimeline,
  post, toast,
  settings: () => openSettings('agent'),
  // (its name, wherever the studio says it: the layout's tab, the inspector's ask)
  renamed: () => { layout.render(); if (O.sel) inspector(); },
  get: (u) => linkFetch(u).then((r) => r.json()),
  seek: (t) => { seek(t); tl.reveal(t); },
  relayout: () => { tl.relayout(); dispatchEvent(new Event('resize')); },
  showCode, select: (s) => selectThing(s),
  context: () => {
    const f = frameAt(S.t), cues = S.doc.cues.filter((q) => S.sel.has(q.id));
    return {
      t: S.t, frame: f, frameReady: D.view === 'film' && /[23]/.test(S.film.frames?.[f] ?? ''),
      sel: O.sel && { label: O.sel.label, kind: O.sel.kind, at: O.sel.at, nth: O.sel.nth, key: O.sel.key, like: O.sel.like, copy: O.sel.copy, copies: O.sel.copies, ...(O.sel.sites && { sites: O.sel.sites, object: O.sel.object, count: O.now?.count ?? null }), ...(O.sel.added && { added: true, clip: O.sel.clip }) },
      also: O.also.map((x) => `${x.sites ? `${x.object || x.label}, every copy (sites ${JSON.stringify(x.sites)})` : `${x.label || x.kind} at ${x.at}${x.copies > 1 ? `, copy ${(x.copy ?? 0) + 1} of ${x.copies}` : ''} (at: "${x.at}", nth: ${x.nth ?? 0})`}`),
      lane: lanes.describeSel(), cues: cues.map((q) => `"${q.label || q.id}" at ${f2(q.t)} s${q.note ? ` (${q.note.split('\n')[0].slice(0, 80)})` : ''}`),
      clips: selectedTimeline().clips.map(({ clip: c, track }) => (c.thing ? `"${c.thing.label}", added by hand, at ${f2(c.at)}–${f2(clipEnd(c))} s (clip ${c.id})` : `"${c.media}" on ${track.name} at ${f2(c.at)}–${f2(clipEnd(c))} s (clip ${c.id})`)),
      notes: roll?.describeSel() ?? null, noteCount: roll?.selectedCount() ?? 0,
      code: codeSel && `${codeSel.file}:${codeSel.from}${codeSel.to > codeSel.from ? `–${codeSel.to}` : ''}`,
      range: S.range ? `${f2(S.range.a)}–${f2(S.range.b)} s` : null,
    };
  },
});
// (the conversation so far, each time the editor connects: what it missed; the avatar leaves if Claude is not working)
es.addEventListener('open', async () => { if (!(await panel.sync())) presence.event({ type: 'ended' }); });
// Claude, where it works (presence.js): where each thing is in the window, for its avatar and its light
const box = (el) => (el && el.ownerDocument === document ? el.getBoundingClientRect() : null);   // (in a panel's own window: not here)
// a span of a lane of the timeline's canvas (x0 to x1 in its px), as a box in the window (the canvas shows the lanes from
// as far down them as they are scrolled)
const laneBox = (kind, which, x0, x1) => {
  const c = box($('#canvas')), l = tl.lanes().find((x) => x.kind === kind && which(x)), a = Math.max(0, x0), b = Math.min(c?.width ?? 0, x1);
  return c && l && b > a ? new DOMRect(c.left + a, c.top + l.y - $('#lanes').scrollTop + 2, b - a, l.h - 4) : null;
};
const presence = createPresence({
  dock: () => box(panel.opened && !layout.detached('claude') ? $('#agentInput') : $('#agentBtn')),
  viewer: () => box($('#screen')),
  timeline: () => box($('#lanes')),
  history: () => box($('#historyPanel .ptab')),
  status: () => box($('#draftInfo')),
  render: () => box($('#renderBtn')),
  help: () => box($('#helpBtn')),
  ruler: (t) => { const r = box($('#ruler')), x = tl.xOf(t); return r && x >= 0 && x <= r.width ? new DOMRect(r.left + x - 6, r.top, 12, r.height) : null; },
  cue: (id) => { const q = S.doc.cues.find((x) => x.id === id); return q && laneBox('cues', () => true, tl.xOf(q.t) - 3, q.dur ? tl.xOf(q.t + q.dur) : tl.xOf(q.t) + 80); },
  cueRow: (id) => box($(`#cueList .row[data-id="${CSS.escape(id)}"]`)),
  clip: (id) => { const tr = S.doc.tracks.find((t) => t.clips.some((c) => c.id === id)), c = tr?.clips.find((x) => x.id === id); return c && laneBox('track', (l) => l.track === tr, tl.xOf(c.at), tl.xOf(clipEnd(c))); },
  lanesOf: (th) => box($(`#heads .mthing[data-th="${CSS.escape(th)}"]`)),
  // a thing (as pick names it), found in the frame on screen: its outline's box (null: not in this frame)
  located: async (sel) => {
    try {
      const r = await (await post('api/locate', { t: frameTime(), camera: viewCam(), ...sel, agent: true })).json();
      if (!r?.outline?.length) return null;
      const xs = r.outline.map((p) => p[0]), ys = r.outline.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.max(0, Math.min(...xs)), Math.min(FW, Math.max(...xs)), Math.max(0, Math.min(...ys)), Math.min(FH, Math.max(...ys))];
      return () => { const o = box(ovl); if (!o || x1 <= x0 || y1 <= y0) return null; const sx = o.width / FW, sy = o.height / FH; return new DOMRect(o.left + x0 * sx, o.top + y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy); };
    } catch { return null; }
  },
  prop: (th, k) => box($(`#heads .mprop[data-th="${CSS.escape(th)}"][data-k="${CSS.escape(k)}"]`)),
  field: (name) => box($(`#inspector [name="${CSS.escape(name)}"]`)),
  doc: () => S.doc,
  // the Mixer: a strip (a track's id, bus:<id>, master), or a part of it (sel: [data-part="volume"], [data-fx="1"],
  // [data-send="<bus>"]: mixer.js), or (no id) the whole panel; an open effect's control in its drawer (sel: [data-k="ratio"])
  // (cut to what of it shows: the strips scroll beside the master)
  mixer: (id, sel = '') => (id ? shownIn(box($(`#mixerBody [data-strip="${CSS.escape(id)}"] ${sel}`.trim())), id === 'master' ? '#mixerBody' : '#mixerBody .mx-strips') : box($('#mixerBody'))),
  fxControl: (id, i, sel) => shownIn(box($(`#mixerBody .mx-drawer[data-of="${CSS.escape(id)}"][data-fx="${i}"] ${sel}`)), '#mixerBody .mx-drawer'),
  tab: (panel) => box($(`.lay-tabs [data-lay="${CSS.escape(panel)}"]`)),
  trackFlag: (id, k) => box($(`#heads [data-track="${CSS.escape(id)}"] [data-flag="${k}"]`)),
  // notes of a notes medium (its own times), lit in the piano roll where it shows them: their box (a function), or null
  notes: (media, notes) => roll?.light(media, notes) ?? null,
});
// r, cut to what of it shows in the element `sel` finds (null: none of it)
function shownIn(r, sel) {
  const o = r && box($(sel));
  if (!o) return null;
  const x0 = Math.max(r.left, o.left), y0 = Math.max(r.top, o.top), x1 = Math.min(r.right, o.right), y1 = Math.min(r.bottom, o.bottom);
  return x1 > x0 && y1 > y0 ? new DOMRect(x0, y0, x1 - x0, y1 - y0) : null;
}

// a thing, selected (Claude's pick, or what it shows you, or a cue's): the playhead there, the thing found again (sites:
// an object, whole)
async function selectThing({ t = S.t, ...sel }, missing = 'It is not in the scene there') {
  seek(t); tl.reveal(t);
  const camera = viewCam();
  try {
    const r = await (await post('api/locate', { t: frameTime(), camera, ...sel })).json();
    if (!r || r.error) return toast(missing);
    const o = sel.sites && objectOf(sel.sites.find((at) => objectOf(at))), sites = o?.sites ?? sel.sites;
    O.sel = sites ? { ...r, sites, object: o?.label ?? sel.label ?? r.label } : r; O.now = sites ? { ...r, sites } : r; O.also = []; O.alsoNow = [];
    O.t = frameTime(); O.show = null;
    S.sel = new Set(); pickChip(null); lanes.clear(); linesOff(); tl.relayout(); panels(); paintObjects();
  } catch (e) { toast(`Could not find it: ${e.message}`); }
}
// what an agent shows you (the MCP show tool): the playhead, a thing or the camera, a property's lanes, a line of code, a note
async function onShow(b) {
  if (b.note) claudeNote(b.note);
  if (b.select) await selectThing({ t: b.t ?? S.t, ...b.select });
  else if (b.t != null) { seek(b.t); tl.reveal(b.t); }
  if (b.camera) { O.sel = O.now = null; paintObjects(); lanes.select({ th: 'camera', ...(b.property && { k: b.property }) }); }
  if (b.property) lanes.reveal(b.camera ? 'camera' : 'sel', b.property);
  if (b.code) showCode(b.code);
}
let noteTimer = null;
function claudeNote(text) {
  let n = $('.claude-note');
  if (!n) { n = document.createElement('div'); n.className = 'claude-note'; document.body.append(n); }
  n.innerHTML = `<svg viewBox="0 0 16 16"><path d="M8 1.5l1.3 4.1 4.2-1.6-2.6 3.6 3.6 2.5-4.4.2.4 4.3L8 11.5l-2.5 3.1.4-4.3-4.4-.2 3.6-2.5L2.5 4l4.2 1.6z"/></svg><span>${esc(text)}</span>`;
  n.hidden = false; clearTimeout(noteTimer); noteTimer = setTimeout(() => { n.hidden = true; }, 6000);
}
// a line of the film's code (or Ephemeris's, read-only), opened in the Code panel at that line: wherever the studio
// names one (the inspector, a lane, an object's row, the agent's replies and its show)
function showCode({ file, line, col }) {
  layout.reveal('code');
  return codePanel.reveal({ file, line, col });
}

let lanesKey = '';
// the lanes again when the selection, the film's code or its frames change (they show the whole film: the playhead
// moving changes nothing in them), the instruments shown change, or one gets its first motion or loses its last
function followLanes() {
  if (audio.playing) return;   // (playing: they follow once it stops)
  if (S.film.duration == null && S.url && !S.film.error) return;   // (the film's length: asked of it once it is known, not before and again)
  const insts = instrumentsShown().map((i) => [i.key, isAutomated(heardDoc().tracks.find((t) => t.id === i.track), heardDoc().media)]);
  const k = JSON.stringify([O.sel && [O.sel.at, O.sel.nth, O.sel.key, O.sel.copy, O.sel.sites], O.also.map(refOf), S.film.loaded, S.film.duration, S.film.cuts, S.film.fps, insts]);
  if (k !== lanesKey) { lanesKey = k; lanes.refresh(); }
}

// the Instrument panel: the instrument of the selected clip's medium, if it has one (notes media)
instrumentPanel = createInstrumentPanel({ el: $('#instrument'), S, edit, plugins: audio.plugins, score: () => SOUND.score, heardDoc, openSettings, preview: audio.previewSampler, reveal: (key, t) => lanes.reveal(`inst:${t.track}`, key), importFile: async (f) => { const info = await importFile(f); assets(); return info; }, hear: (doc) => audio.update(doc, heardUrl), target: () => {
  // (the track of the clips selected, all on one; else a track selected: its instrument)
  const clips = clipsAll().filter(({ clip }) => S.sel.has(clip.id)), on = new Set(clips.map((x) => x.track.id));
  const tr = clips.length && on.size === 1 ? clips[0].track : !clips.length ? S.doc.tracks.find((t) => S.sel.has(t.id)) : null;
  return tr && !isVisual(tr) && tr.instrument ? { track: tr.id, name: tr.name || tr.id, m: tr } : null;
} });
// a plugin changed in its own window: the instrument names the state its host saved (one edit, so undo goes back)
// (a plugin's state loaded: its parameters' values are the bases of their lanes)
audio.plugins.onStatus((key) => { if (instrumentsShown().some((i) => i.key === key)) { lanes.sync(); tl.invalidate(); } });
audio.plugins.onSaved(({ track, state }) => {
  const tr = S.doc.tracks.find((t) => t.id === track), plugin = tr?.instrument?.plugin;
  if (plugin) edit(`"${tr.name || track}": ${plugin} changed in its window`, (d) => { d.tracks.find((t) => t.id === track).instrument = { plugin, state }; });
});
// the film's objects in the timeline (objects.js): a row each, the selection's lanes under its own
const objectRows = createObjectRows({
  // (what was added first, in the order it was added, however its clips have moved)
  list: () => [...addedClips(S.doc).sort((a, b) => +a.id.slice(1) - +b.id.slice(1)).map(objectOfClip), ...OBJ.list],
  listed: () => OBJ.listed,
  finding: () => OBJ.asking,
  add: (b) => addMenu(b),
  hidden: objectHidden,
  hide: toggleHidden,
  rename: (o, el) => renameAdded(o, el),
  menu: (o, x, y) => openMenu($('#heads'), [
    { label: 'Select', act: () => selectObject(o) },
    { label: 'Focus', hint: 'F', act: async () => { await selectObject(o); focusSelection(); } },
    ...(o.clip ? [{ label: 'Rename…', act: () => renameAdded(o) }] : []),
    { label: 'Duplicate', hint: 'Shift+D', act: async () => { await selectObject(o); duplicateThings(); } },
    { label: objectHidden(o) ? 'Show' : 'Hide', hint: 'H', act: () => toggleHidden(o) },
    ...(o.clip ? ['hr', { label: 'Delete', hint: 'Del', act: async () => { await selectObject(o); deleteSelection(); } }] : []),
  ], { x, y }),
  selected: () => (O.sel ? { id: objectOf(O.sel.at)?.id ?? null, whole: !!O.sel.sites || !isMany(objectOf(O.sel.at)) } : null),
  select: (o, add = false) => selectObject(o, null, false, add),
  also: () => new Set(O.also.map((x) => objectOf(x.at)?.id).filter(Boolean)),
  thingOf: (o) => lanes.M.things.find((th) => (o.sites.length ? th.id.startsWith('also:') && o.sites.includes(th.sel?.at) : th.id === o.id)) ?? null,
  // (the film camera and the scene: rows as the objects', first)
  films: () => ['camera', 'scene'].filter((id) => lanes.M.things.some((th) => th.id === id)).map((id) => ({ id, label: id === 'camera' ? 'Camera' : 'Scene', kind: id,
    det: id === 'camera' ? 'the project’s camera' : 'its light and lens', spans: [[0, S.film.duration ?? S.end()]], sites: [], copies: 1, sel: !O.sel && lanes.selected()?.th === id && !lanes.selected()?.k && !lanes.selected()?.v })),
  thing: () => lanes.M.things.find((th) => th.id === 'sel') ?? null,
  relayout: () => tl.relayout(),
  code: showCode,
});
const tl = createTimeline({
  S, newId, seek, select, setRange, openCue, addCue, setCueLabel, renameTrack, removeTrack, reorderTracks, barBeat, lanes, panels, resolve, heard: (id) => heardDoc().media[id],
  objectRows, selectObject,
  openMenu, trackMenu: timelineTrackMenu, itemMenu: timelineItemMenu,
  // clips and cues a box drew round: added to the selection, or in its place
  // (pickLanes: a box's keys and moves, chosen in the lanes too; none of the viewer's thing's, in place of the selection:
  // the thing is not selected)
  selectMany: (ids, add, pickLanes) => {
    if (!add) lanes.clear();
    S.sel = new Set([...(add ? S.sel : []), ...ids]);
    pickLanes?.(add);
    if (!add && !lanes.pickedOn('sel')) dropThing();
    if (!add) linesOff();
    tl.invalidate(); panels();
  },
  // a track's mute or solo, from its head (as its mixer strip's)
  trackFlag: (id, k) => { const tr = S.doc.tracks.find((t) => t.id === id); edit(`${tr[k] ? 'un' : ''}${k} "${tr.name}"`, (d) => { const t = d.tracks.find((x) => x.id === id); if (t[k]) delete t[k]; else t[k] = true; }); },
  // a pattern double-clicked: opened in the piano roll, which takes the keys
  openNotes: (clip) => { if (!isNotes(S.doc.media[clip.media])) return false; select(clip.id); roll.show(clip.id); layout.reveal('pianoroll'); requestAnimationFrame(() => roll.focus()); return true; },
  hint: (html) => { const el = $('#hint'); if (el.innerHTML !== html) el.innerHTML = html; },
  dragged: (base, desc) => { if (!record(base, desc)) saveState(); },
  changedLive: () => { heard = null; filmKeys(); lanes.sync(); panels(); saveState(); },   // mid-drag: the mix waits for the drop
});
// (once for each burst of them: a film's sounds load together, and the timeline taken in again and each panel drawn
// again, asking the studio what it shows, is work for each)
let loadedLater = null;
audio.listen(() => { clearTimeout(loadedLater); loadedLater = setTimeout(() => { audio.update(S.doc, heardUrl); tl.invalidate(); panels(); }, 100); });
// ---------- the panels' layout (layout.js): as the studio has it until you move them
// the Mixer (mixer.js): a strip for each audio track; its changes are edits
let pluginList = null;
mixer = createMixer({ host: $('#mixerBody'), S, edit, openMenu, media: () => Object.keys(S.doc.media).filter((id) => !S.doc.media[id].kind || S.doc.media[id].kind === 'audio'), levelsAt: audio.levelsAt, tweak: audio.tweak, views: createViews({ sr: audio.ctx.sampleRate, tap: audio.tap, untap: audio.untap, openMenu, soundOf: (id) => audio.get(id)?.channels ?? null }),
  // a strip's instrument: a clip of its track selected (a notes clip, if it has one), the Instrument panel shown (at a tab, if asked)
  openInstrument: (tid, tab) => {
    const tr = S.doc.tracks.find((t) => t.id === tid), clip = tr?.clips.find((c) => isNotes(S.doc.media[c.media])) ?? tr?.clips[0];
    if (!clip) return;
    select(clip.id); instrumentPanel.show(tab); layout.reveal('instrument');
  },
  plugins: async () => (pluginList ??= linkFetch('api/plugins').then((r) => r.json()).then((r) => ({ plugins: r.plugins ?? [], presets: r.presets ?? {} }), () => ({ plugins: [], presets: {} }))) });
mixer.render();
const codePanel = createCodePanel({ host: $('#codePanel'), dir: S.dir, api: (p, init) => linkFetch(p, init), toast, openMenu, restore: restoreVersion, selected: selectLines,
  tag: (n) => askName(`Tag version ${n}`, '', (name) => tagVersion(n, name), TAG_NAME), untag: (n, name) => tagVersion(n, name, true) });
roll = createPianoRoll({ S, edit, seek, toast, resolve, openMenu, select, playing: () => audio.playing, heard: (id) => heardDoc().media[id], heardDoc, codeNotes: (id) => SOUND.score?.notes?.[id] ?? null });
numberFields();   // (every number field: drag it up or down, click it to type)
const layout = createLayout($('#work'), {
  viewer: { el: $('#viewer'), title: 'Viewer', icon: 'monitor-play' },
  inspector: { el: $('#inspectorPanel'), title: 'Inspector', icon: 'sliders-horizontal' },
  instrument: { el: $('#instrumentPanel'), title: 'Instrument', icon: 'wave-sine' },
  cues: { el: $('#cuesPanel'), title: 'Cues', icon: 'flag' },
  history: { el: $('#historyPanel'), title: 'History', icon: 'clock-counter-clockwise' },
  assets: { el: $('#assetsPanel'), title: 'Assets', icon: 'folder-open' },
  timeline: { el: $('#tl'), title: 'Timeline', icon: 'rows', head: '#seqbar' },
  mixer: { el: $('#mixerPanel'), title: 'Mixer', icon: 'faders' },
  pianoroll: { el: $('#rollPanel'), title: 'Piano roll', icon: 'piano-keys' },
  code: { el: $('#codePanel'), title: 'Code', icon: 'code' },
  // (its id from when the agent was Claude alone: saved layouts name it so)
  claude: { el: $('#agent'), get title() { return panel.name; }, close: () => panel.show(false) },
}, {
  // (the simple view's: the viewer over the agent, or beside it on a screen wider than it is tall)
  pages: SIMPLE ? { simple: { title: 'Simple', def: (w, h) => (w > h
    ? { dir: 'row', kids: [{ size: 'fill', tabs: ['viewer'] }, { size: Math.round(w * 0.42), tabs: ['claude'] }] }
    : { dir: 'col', kids: [{ size: Math.round((w * 9) / 16) + 230, tabs: ['viewer'] }, { size: 'fill', tabs: ['claude'] }] }) } } : {   // (+ its controls, scrubber and transport)
    // the viewer and its side panels over the timeline, Claude beside them all
    film: { title: 'Visual', def: (w, h) => ({ dir: 'row', kids: [
      { size: 'fill', dir: 'col', kids: [
        { size: Math.round(h * 0.58), dir: 'row', kids: [{ size: 'fill', tabs: ['viewer'] }, { size: Math.round(Math.min(380, Math.max(280, w * 0.19))), dir: 'col', kids: [{ size: 'auto', tabs: ['inspector'] }, { size: 'fill', tabs: ['cues', 'history', 'assets'], active: 'cues' }] }] },
        { size: 'fill', tabs: ['timeline', 'pianoroll', 'mixer', 'instrument', 'code'], active: 'timeline' }] },
      { size: 380, tabs: ['claude'] }] }) },
    // the Director view as large as it can be, over a low timeline, for placing things: the inspector beside it
    layout: { title: 'Layout', def: (w, h) => ({ dir: 'row', kids: [
      { size: 'fill', dir: 'col', kids: [{ size: 'fill', tabs: ['viewer'] }, { size: Math.round(h * 0.22), tabs: ['timeline', 'code'], active: 'timeline' }] },
      { size: Math.round(Math.min(380, Math.max(280, w * 0.19))), dir: 'col', kids: [{ size: 'fill', tabs: ['inspector'] }, { size: Math.round(h * 0.2), tabs: ['cues', 'assets', 'history'], active: 'cues' }] },
      { size: 380, tabs: ['claude'] }] }) },
    // the timeline over the piano roll (the mixer its tab) and the instrument; the inspector and the sounds beside them
    music: { title: 'Audio', v: 2, def: (w, h) => ({ dir: 'row', kids: [
      { size: 'fill', dir: 'col', kids: [
        { size: Math.round(h * 0.45), tabs: ['timeline'] },
        { size: 'fill', dir: 'row', kids: [{ size: 'fill', tabs: ['pianoroll', 'mixer'], active: 'pianoroll' }, { size: Math.round(w * 0.3), tabs: ['instrument'] }] }] },
      { size: Math.round(Math.min(380, Math.max(280, w * 0.19))), dir: 'col', kids: [{ size: 'auto', tabs: ['inspector'] }, { size: 'fill', tabs: ['assets', 'history'], active: 'assets' }] },
      { size: 380, tabs: ['claude'] }] }) },
  },
  relayout: () => { tl.relayout(); tl.invalidate(); codePanel.relayout(); dispatchEvent(new Event('resize')); pushMenus(); },
  paged: (pid) => { keepPageView(S.page); S.page = pid; showPageView(pid); pagesBar(); pushMenus(); tl.relayout(); tl.invalidate(); panels(); },
});

// ---------- the pages (Resolve's), a button for each at the window's foot (Shift+1, Shift+2)
const PAGES = { film: 'Visual', music: 'Audio', layout: 'Layout' };
const PAGE_ICON = { film: icon('film-strip'), music: icon('waveform'), layout: icon('cube') };
// how the pages that show the scene see it, each kept as you leave it: Layout starts on the Director view drawn Fast, for
// placing things with the picture keeping up, without Pre-render (that view draws its own frames, so the fill would be frames
// nobody sees, sharing the GPU with it); and its viewer keeps its seek bar but leaves its transport to the timeline's, for the room
const PAGE_VIEWS = (() => { try { return JSON.parse(localStorage.getItem('nle:pageViews')) ?? {}; } catch { return {}; } })();
const keepPageView = (pid) => {
  if (pid !== 'film' && pid !== 'layout') return;
  PAGE_VIEWS[pid] = { view: D.view, look: S.film.look ?? 'accurate', prerender: S.film.prerender !== false };
  try { localStorage.setItem('nle:pageViews', JSON.stringify(PAGE_VIEWS)); } catch { /* only a convenience */ }
};
function showPageView(pid) {
  bodyClass('page-layout', pid === 'layout');
  const v = { ...(pid === 'layout' ? { view: 'director', look: 'fast', prerender: false } : pid === 'film' ? { prerender: true } : {}), ...PAGE_VIEWS[pid] };
  if (v.view && v.view !== D.view) setView(v.view);
  if (v.look && v.look !== (S.film.look ?? 'accurate')) setLook(v.look);
  if (v.prerender != null && v.prerender !== (S.film.prerender !== false)) post('/api/prerender', { on: v.prerender }).catch(() => { /* (as it was: the button says) */ });
}
function pagesBar() {
  $('#pageBtns').innerHTML = Object.entries(PAGES).map(([id, name], i) => `<button data-page="${id}" class="${layout.page() === id ? 'on' : ''}" title="${name} (Shift+${i + 1})">${PAGE_ICON[id]}${name}</button>`).join('');
}
$('#pages').onclick = (e) => { const b = e.target.closest('[data-page]'); if (b) layout.setPage(b.dataset.page); };
S.page = layout.page(); pagesBar();
showPageView(S.page);

// ---------- the simple view's own: the agent open (its box not focused: a phone's keyboard would cover the viewer), the
// layout made again when the screen turns. The scrubber under the viewer, in either view: dragged, the playhead follows;
// else it follows the playhead; under it the film's strip, its shots and the frames rendered, as the timeline's ruler
const scrubber = $('#scrubber'), scrubTime = $('#scrubTime'), scrubStrip = $('#scrubStrip');
let scrubbing = false, stripWas = [], stripW = 0;
// (its width, kept as it changes: read each frame, after the page was written to, it would lay the page out again)
new ResizeObserver(() => { stripW = scrubStrip.clientWidth; }).observe(scrubStrip);
if (SIMPLE) {
  panel.show(true, false);
  layout.reset();   // (for the screen as it is turned now: the layout kept was made for either)
  matchMedia('(orientation: landscape)').addEventListener('change', () => layout.reset());
}
scrubber.addEventListener('pointerdown', () => { scrubbing = true; });
for (const ev of ['pointerup', 'pointercancel']) addEventListener(ev, () => { scrubbing = false; });
scrubber.oninput = () => { seek(+scrubber.value); tl.reveal(S.t); };
function scrubShown() {
  const end = Math.max(S.film.duration || 0, S.end()), text = `${S.t.toFixed(2)} / ${end.toFixed(2)} s`;
  if (+scrubber.max !== end) scrubber.max = end;
  if (!scrubbing && Math.abs(+scrubber.value - S.t) > 1e-3) scrubber.value = S.t;
  if (scrubTime.textContent !== text) scrubTime.textContent = text;
  // (drawn again only when what it shows changes: compared as they are, each frame, not made into one string)
  const w = stripW, dpr = devicePixelRatio || 1, F = S.film, now = [w, dpr, end, F.duration, F.cuts, F.frames, S.url];
  if (!w || !end || now.every((x, i) => x === stripWas[i])) return;
  stripWas = now;
  scrubStrip.width = Math.round(w * dpr); scrubStrip.height = Math.round(10 * dpr);
  const g = scrubStrip.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  filmStrip(g, { ...F, url: S.url }, { xOf: (t) => (t / end) * w, tOf: (x) => (x / w) * end, W: w, y: 0, h: 10, numbers: false });
}
$('#fullBtn').onclick = () => viewMode(false);
// (a canvas of the editor's the GPU lost, given back blank a moment later: drawn again; its process restarted, say)
addEventListener('contextrestored', (e) => {
  if (e.target === frameEl) { drawn = null; if (D.view === 'director' && !D.own && (directorPicture() ?? D.img)) paintDirector(); }
  if (e.target === scrubStrip) stripWas = [];
  tl.invalidate(); roll?.invalidate();
}, true);

// ---------- what the machine is doing, at the right of the page bar: what Ephemeris itself takes, the whole computer's CPU
// and GPUs (tools/machine.mjs: each GPU where the system says), the viewer's render workers (busy of running, and frames a
// second), and a warning while playing when an instrument's sound comes later than it plays (it cannot keep up)
const bytesOf = (b) => (b < 1024 ** 3 ? `${Math.round(b / 1024 ** 2)} MB` : `${(b / 1024 ** 3).toFixed(1)} GB`);
function appUse(a) {
  const line = (name, p) => p && `${name}: ${bytesOf(p.ram)}, ${Math.round(p.cpu)}%`;
  return ['All that Ephemeris runs, on all of this computer\u2019s cores. Memory they share counts once.',
    line('Window', a.parts.window), line('Viewport (the editor\u2019s film)', a.parts.viewport), line('Studio', a.parts.studio), line(a.parts.workers?.n === 1 ? '1 render worker' : `${a.parts.workers?.n} render workers`, a.parts.workers), line('Film servers and tools', a.parts.tools)].filter(Boolean).join('\n');
}
function machineShown() {
  const m = S.machine, F = S.film, el = $('#machine'), out = [];
  const late = audio.voiceUnderruns() + audio.pluginUnderruns();
  if (late > lateWas && audio.playing) lateAt = Date.now();
  lateWas = late;
  if (Date.now() - lateAt < 3000) out.push('<b class="bad" title="Some instruments can\u2019t keep up, so parts drop out. Renders aren\u2019t affected.">Audio is falling behind</b>');
  // an instrument, or some of its samples, the editor could not load: the notes they play are silent here
  const unloaded = audio.unloadedSamples();
  if (unloaded.length) {
    const parts = unloaded.flatMap((u) => u.parts), lines = unloaded.flatMap((u) => u.missing.map((x) => `${u.parts.join(', ')}: ${x.name ? x.name.split('/').pop() : 'its instrument'} (${x.why})`));
    const title = `The notes they play are silent in the editor.\n${lines.slice(0, 12).join('\n')}${lines.length > 12 ? `\n\u2026and ${lines.length - 12} more` : ''}`;
    out.push(`<b class="bad" title="${esc(title)}">Didn\u2019t load: ${esc(parts.slice(0, 3).join(', '))}${parts.length > 3 ? ` +${parts.length - 3}` : ''}</b>`);
  }
  if (m) {
    if (m.app) out.push(`<span class="eph" title="${esc(appUse(m.app))}">Ephemeris CPU ${m.app.cpu}% \u00b7 RAM ${bytesOf(m.app.ram)}</span>`);
    out.push(`<span title="All of this computer\u2019s cores">System CPU ${m.cpu}%</span>`);
    if (m.gpus.length) out.push(`<span title="${esc(m.gpus.map((g) => `${g.name}: ${g.use}%`).join('\n'))}">GPU ${m.gpus.map((g) => `${g.use}%`).join(' · ')}</span>`);
  }
  // (the film slow to draw here: preview.mjs SLOW_MS; its agents are told too)
  if (F?.slow) { const z = F.slow; out.push(`<b class="bad" title="${esc(`Frames around ${z.from.toFixed(1) === z.to.toFixed(1) ? z.from.toFixed(1) : `${z.from.toFixed(1)}\u2013${z.to.toFixed(1)}`} s take ${(z.ms / 1000).toFixed(1)} s each to draw on this machine, at ${Math.round(z.size * 100)}% of the frame and ${z.samples} samples. Agents working on this film get a note about it. A smaller preview size, or Fast, draws quicker while you work.`)}">Slow: ${(z.ms / 1000).toFixed(1)} s a frame</b>`); }
  if (F?.workers) out.push(`<span title="Busy render workers, out of those running${F.working && F.rate ? `. ${F.rate} frames a second.` : '.'}">Workers ${F.busy ?? 0}/${F.workers}</span>`);
  // the viewer's kept frames, all films' (tools/cache.mjs): a click sets the limit, or clears the caches
  if (m?.cache) { const gb = m.cache.bytes / 1024 ** 3; out.push(`<button data-cache title="Frames the viewer keeps, in all films. Past the limit, the least needed go first. Click to set the limit or clear the cache.">Cache ${gb < 10 ? gb.toFixed(1) : Math.round(gb)} / ${m.cache.limit} GB</button>`); }
  el.innerHTML = out.join('');
}
$('#machine').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cache]');
  if (!b) return;
  const set = async (limit) => { try { const cache = await (await post('/api/cache', { limit })).json(); S.machine = { ...S.machine, cache }; machineShown(); } catch { toast('The cache limit was not changed: the studio did not answer.'); } };
  // (clear: every film's frames and the render browsers' compiled shaders; the open film renders again from scratch)
  const clear = async () => { try { const cache = await (await post('/api/cache/clear', {})).json(); S.machine = { ...S.machine, cache }; machineShown(); toast('Cache cleared: frames render again, shaders compile again.'); } catch { toast('The cache was not cleared: the studio did not answer.'); } };
  openMenu(b, [...[5, 10, 20, 50, 100].map((g) => ({ label: `${g} GB`, checked: g === S.machine?.cache?.limit, act: () => set(g) })), 'hr', { label: 'Clear cache', act: clear }]);
});

// ---------- the menu bar: the studio's actions by menu. In the app on macOS, the system's menu bar (sent again as what
// it shows changes); elsewhere, labels in the header, each opening its menu (the system's in the app)
const PANEL_NAMES = [['viewer', 'Viewer'], ['timeline', 'Timeline'], ['inspector', 'Inspector'], ['cues', 'Cues'], ['history', 'History'], ['assets', 'Assets'], ['pianoroll', 'Piano roll'], ['instrument', 'Instrument'], ['mixer', 'Mixer'], ['code', 'Code'], ['claude', 'Agent']];
const isOpen = (id) => (id === 'claude' ? panel.opened : layout.isOpen(id));
function menus() {
  const rendering = !$('#cancelBtn').hidden, fps = S.doc.fps || 60, app = !!window.studioApp;
  return [
    { label: 'File', items: [
      { label: 'All projects…', hint: 'Ctrl+O', act: () => navigate('/') },
      'hr',
      { label: 'New timeline…', act: () => askName('New timeline', '', (id) => makeTimeline(id)) },
      { label: `Duplicate “${S.timeline}”…`, act: () => askName(`Duplicate “${S.timeline}”`, `${S.timeline}-copy`, (id) => makeTimeline(id, S.timeline)) },
      'hr',
      { label: 'Import media…', act: () => $('#assetFile').click() },
      'hr',
      { label: 'Settings…', hint: 'Ctrl+,', act: openSettings },
      'hr',
      { label: 'Render draft', hint: 'R', disabled: rendering, act: requestRender },
      { label: 'Cancel render', disabled: !rendering, act: () => $('#cancelBtn').click() },
    ] },
    { label: 'Edit', items: [
      { label: 'Undo', hint: 'Ctrl+Z', disabled: !S.undo.length, act: undo },
      { label: 'Redo', hint: 'Ctrl+Shift+Z', disabled: !S.redo.length, act: redo },
      'hr',
      { label: 'Cut', hint: 'Ctrl+X', act: () => copyTimelineSelection(true) },
      { label: 'Copy', hint: 'Ctrl+C', act: () => copyTimelineSelection() },
      { label: 'Paste', hint: 'Ctrl+V', act: () => pasteTimelineSelection() },
      { label: 'Duplicate', hint: 'Ctrl+B', disabled: !S.sel.size, act: () => duplicateSelection() },
      { label: 'Delete', hint: 'Del', act: () => deleteSelection() },
      'hr',
      { label: 'Select all', hint: 'Ctrl+A', act: () => selectAllTimeline() },
      { label: 'Deselect', hint: 'Ctrl+D', disabled: !S.sel.size, act: () => { select(null); lanes.clear(); panels(); } },
      { label: 'Invert selection', hint: 'Shift+I', act: invertSelection },
      'hr',
      { label: 'Split at the playhead', hint: 'S', act: split },
      { label: 'Add a cue at the playhead', hint: 'M', act: () => addCue(Math.round(S.t * fps) / fps) },
    ] },
    { label: 'View', items: [
      { label: 'Preview', hint: 'V', checked: D.view === 'film', act: () => setView('film') },
      { label: 'Director', hint: 'V', checked: D.view === 'director', act: () => setView('director') },
      'hr',
      ...Object.entries(LOOK_NAMES).map(([l, name]) => ({ label: name, checked: (S.film.look ?? 'accurate') === l, act: () => setLook(l) })),
      'hr',
      { label: 'Overlays', hint: 'Shift+Alt+Z', checked: OV[D.view].on, act: () => setOverlay('on', !OV[D.view].on) },
      { label: 'Cues over the viewer', hint: 'C', checked: showCues, act: () => setShowCues(!showCues) },
      { label: 'Simple view', checked: SIMPLE, act: () => viewMode(!SIMPLE) },
      'hr',
      { label: 'Snap', hint: 'N', checked: S.snap, act: toggleSnap },
      { label: 'Metronome', hint: 'K', checked: METRO.on, act: toggleMetronome },
      'hr',
      { label: 'Zoom the timeline in', hint: '=', act: () => tl.zoomAt(S.t, 1.5) },
      { label: 'Zoom the timeline out', hint: '-', act: () => tl.zoomAt(S.t, 1 / 1.5) },
      { label: 'Fit the timeline', hint: '\\', act: () => tl.fit() },
      ...(app ? ['hr', { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, 'hr', { role: 'togglefullscreen' }, 'hr', { role: 'reload' }, { role: 'toggleDevTools' }] : []),
    ] },
    { label: 'Window', items: [
      ...Object.entries(PAGES).map(([id, name], i) => ({ label: name, hint: `Shift+${i + 1}`, checked: layout.page() === id, act: () => layout.setPage(id) })),
      'hr',
      ...PANEL_NAMES.map(([id, name]) => ({ label: id === 'claude' ? panel.name : name, checked: isOpen(id), act: () => (id === 'claude' ? panel.show() : isOpen(id) ? layout.close(id) : layout.open(id)) })),
      'hr',
      { label: 'Open in its own window', submenu: PANEL_NAMES.map(([id, name]) => ({ label: name, checked: layout.detached(id), act: () => (layout.detached(id) ? layout.dock(id) : layout.detach(id)) })) },
      { label: `Reset the ${PAGES[layout.page()]} page`, act: () => layout.reset() },
    ] },
    { label: 'Help', items: [{ label: 'Keyboard shortcuts', hint: '?', act: () => { $('#help').hidden = false; } }] },
  ];
}
for (const b of document.querySelectorAll('#menubar [data-menu]')) {
  b.onclick = () => { const r = b.getBoundingClientRect(); openMenu(b, menus().find((m) => m.label === b.dataset.menu).items, window.studioApp ? { x: r.left, y: r.bottom } : undefined); };
}
function pushMenus() {
  if (document.documentElement.dataset.app !== 'darwin') return;
  clearTimeout(menusLater);
  menusLater = setTimeout(() => { const acts = []; window.studioApp.menuBar(menus().map((m) => ({ label: m.label, items: forSystem(m.items, acts) })), (id) => acts[id]?.()); }, 60);
}
onEvery('pointerup', pushMenus); onEvery('keyup', pushMenus);   // (what the menus check, changed by a click or a key)
pushMenus();
docChanged(); filmChanged(); renderState(); rangeChip(); loadHistory(); saveState(); timelineTabs(); assets(); loadMusic(); loadSound();
requestAnimationFrame(() => { if (rememberedView) tl.invalidate(); else tl.fit(); });
linkFetch('/api/studio').then((r) => r.json()).then(projectTabs).catch(() => {});
addEventListener('pagehide', () => { remember({ t: S.t, view: S.view }); codePanel.stash(); });
addEventListener('beforeunload', (e) => { if (S.pending.length || (codePanel.dirty().length && !codePanel.stash())) { e.preventDefault(); e.returnValue = ''; } });
// (the look kept for this machine, if the studio shows another)
{ let l = null; try { l = localStorage.getItem('nle:look'); } catch {} if (l && LOOK_NAMES[l] && l !== (S.film.look ?? 'accurate')) setLook(l); else lookShown(); }
let chipsAt = 0;
(function tick() {
  frame(tick);   // (asked for first: a step that throws costs this frame, not every frame after it)
  if (audio.playing) {
    if (PLAY.every) everyFrame(); else S.t = audio.now();
    if (S.t >= S.end()) stopPlay();
    tl.follow(); roll.follow(); tl.moved(); markCueNow();
  }
  // (as it plays, what the page shows other than its canvases — the readouts, the scrubber, the cues over the picture, the
  // meters, the tracks lit as they sound — changes as the film's frame does, not at the display's rate: each change lays
  // the page out and paints it again; the canvases, the timeline among them, move on every frame)
  const fps = S.doc.fps || 60, f = Math.floor(S.t * fps + 1e-6), paced = audio.playing && f === tick.f;
  tick.f = f;
  viewer(); if (!paced) cueOverlay(); followObjectList(); followOverlays(); paintObjects(); followStats(); followLanes();
  if (!paced) scrubShown();
  netShown();
  // (the agent's chips: as it plays, a few times a second, as their time moves on every frame)
  if (!audio.playing || performance.now() - chipsAt > 250) { panel.chips(); chipsAt = performance.now(); }
  // (a readout is written only when it changes)
  if (!paced) for (const [id, text] of [['tcTime', S.t.toFixed(3)], ['tcFrame', `f ${f}`], ['tcBar', barBeat(S.t)]]) { const el = $(`#${id}`); if (el.textContent !== text) el.textContent = text; }
  tl.draw(); roll.draw(); metroBeat(); instrumentPanel?.light(audio.playing ? S.t : null); instrumentPanel?.follow(S.t);
  if (!paced) {
    const now = performance.now(), dt = Math.min(0.1, (now - (tick.at ?? now)) / 1000);
    tick.at = now;
    mixer.tick(audio.playing ? audio.now() : S.t, dt); tl.activity(audio.playing ? S.t : null, dt);
  }
})();
