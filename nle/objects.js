// The film's objects in the timeline, under the cues (its layers): first the film camera and the scene (its light and
// lens), then a row for each thing the code defines, with every line that places it and all one line places (a loop's, a
// many()'s copies) as one (engine/runtime.js __objects), a bar where it is in the scene, in the order they first
// appear. A row's lanes open under it: the camera's and the scene's by their twirl, a thing's once it is selected.
// Collapsed, only the camera, the scene and the selection show. What the director added by hand (engine/things.js) comes
// first among them: its bar is its clip, dragged to move it in time and by its ends to trim it (timeline.js). A bar striped
// is where the code or the film decides: it stays where it is.
import { icon } from './icons.js';
import { iconOf } from './things.js';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ACCENT = '140,195,252', accent = (a = 1) => `rgba(${ACCENT},${a})`;
const ICON = {
  twirl: '<path d="M5 3l6 5-6 5z" fill="currentColor" stroke="none"/>',
  mesh: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11"/>', layer: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/>',
  title: '<path d="M3 4h10M8 4v9"/>', light: '<circle cx="8" cy="7" r="3.5"/><path d="M6.5 13h3M8 10.5V13"/>',
  pass: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 9.5l3.5-3 3 2.5 4.5-4"/>',
  camera: '<rect x="1.5" y="4.5" width="9" height="7" rx="1"/><path d="M10.5 7l4-2v6l-4-2"/>',
  scene: '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/>',
};
const THING = { mesh: 'cube', layer: 'square', title: 'text-t', light: 'lightbulb', pass: 'stack', camera: 'video-camera', scene: 'sun-horizon' };
const ic = (k) => (THING[k] ? icon(THING[k], false, 'mi') : `<svg class="mi" viewBox="0 0 16 16" aria-hidden="true">${ICON[k] ?? ICON.mesh}</svg>`);
const KIND = { mesh: 'Mesh', glass: 'Glass', layer: 'Layer', title: 'Title', light: 'Light', pass: 'Pass', mixed: 'Object' };
const H = { objs: 24, obj: 22 };

/**
 * api: { list() (the objects), films() (the film camera and the scene, as objects: { id, label, det, spans, sites: [],
 * sel }), selected() → { id (the selection's object), whole } or null, also() (the ids of the other objects selected),
 * select(object, add) (whole; add: with the rest selected, or taken out of it), thing() (the selection's lanes' thing:
 * open, to twirl), thingOf(object) (another's), relayout(), code({ file, line }), listed() (whether the film has said what
 * its objects are), finding() (whether it is being asked them now), add(button) (the Add menu), hidden(object), hide(object) (turned out of the film, or back),
 * rename(object, element), menu(object, x, y) }
 * marks' drawThing(row, top, h): the selection's moves and keys over its row (lanes.js marks)
 */
export function createObjectRows(api) {
  let open = true;
  try { open = localStorage.getItem('nle:objects') !== '0'; } catch { /* storage refused */ }

  // the rows, from the lanes' own over the tracks (top: the camera's, the scene's, then the selection's, each its thing
  // row first)
  function rows(top) {
    const list = api.list();
    if (!list.length && !api.listed() && !api.finding?.()) return top;   // (not listed yet, nor asked: the lanes as they are)
    const sel = top.filter((r) => r.th.id === 'sel'), at = api.selected(), also = api.also();
    const out = [{ kind: 'objs', key: 'objs', h: H.objs, n: list.length }];
    // (the film camera and the scene first: a bar over the whole film, their lanes under them while open)
    for (const f of api.films()) {
      const rs = top.filter((r) => r.th.id === f.id);
      out.push({ kind: 'obj', key: `o:${f.id}`, h: H.obj, obj: f, sel: f.sel, of: false, thing: rs[0] ?? null }, ...rs.slice(1));
    }
    const films = out.length;
    let placed = false;
    for (const o of list) {
      // (the others selected: each its lanes under its row too)
      const mine = at?.id === o.id, theirs = top.filter((r) => r.th.id.startsWith('also:') && o.sites.includes(r.th.sel?.at));
      if (!open && !mine && !also.has(o.id)) continue;
      out.push({ kind: 'obj', key: `o:${o.id}`, h: H.obj, obj: o, sel: (mine && at.whole) || also.has(o.id) || !!o.picked, of: mine && !at.whole, thing: mine ? sel[0] ?? null : theirs[0] ?? null });
      // (its lanes under it: its row is its thing's)
      if (mine) { out.push(...sel.slice(1)); placed = true; }
      else if (theirs.length) out.push(...theirs.slice(1));
    }
    // (a selection no object is: a picture of the timeline's own)
    if (sel.length && !placed) out.splice(films, 0, ...sel);
    return out;
  }
  function head(row) {
    if (row.kind === 'objs') {
      return `<div class="mrow mobjs" data-o="all" title="${open ? 'Show only the camera and the selection' : 'Show every object'}"><button class="mtw${open ? ' open' : ''}" data-o="all" aria-label="${open ? 'Collapse' : 'Expand'}">${ic('twirl')}</button><b>Objects</b><span class="mdet">${row.n}${api.finding?.() ? ' · looking through the film…' : ''}</span><button class="madd" data-o="add" title="Add a shape or a light (Shift+A)" aria-label="Add">${icon('plus')}</button></div>`;
    }
    const o = row.obj, th = row.thing?.th, twirl = row.sel || row.of || !o.sites.length ? !!th?.open : false;
    const what = o.det ?? (row.of ? 'one copy' : o.copies > 1 ? `${o.copies} copies` : o.clip ? (o.linked ? 'Linked copy' : 'Added') : KIND[o.kind] ?? '');
    const lines = o.sites.length > 1 ? ` (${o.sites.length} lines)` : '';
    const tip = o.clip ? `${o.label}: drag its bar to move it in time, or its ends to trim it. Double-click to rename.` : o.sites.length ? `${o.label || KIND[o.kind]}: ${o.copies > 1 ? `${o.copies} copies at most` : 'one'}${lines}. Click to select it. The code decides when it shows.` : `${o.label}: click to select it and see its lanes.`;
    const off = o.sites.length ? api.hidden(o) : false;
    const eye = o.sites.length ? `<button class="meye${off ? ' off' : ''}" data-o="hide" data-obj="${esc(o.id)}" title="${off ? 'Show it (H)' : 'Hide it (H)'}" aria-label="${off ? 'Show' : 'Hide'}">${icon(off ? 'eye-slash' : 'eye')}</button>` : '';
    return `<div class="mrow mobj${row.sel ? ' sel' : row.of ? ' of' : ''}${off ? ' hid' : ''}" data-o="sel" data-obj="${esc(o.id)}" title="${esc(tip)}"><button class="mtw${twirl ? ' open' : ''}" data-o="tw" data-obj="${esc(o.id)}" aria-label="${twirl ? 'Collapse' : 'Expand'}">${ic('twirl')}</button>${o.type ? icon(iconOf(o.type), false, 'mi') : ic(o.kind === 'glass' ? 'mesh' : o.kind)}<b>${esc(o.label || KIND[o.kind] || 'Object')}</b><span class="mdet">${what}</span>${o.file ? `<button class="msrc" data-o="code" data-file="${esc(o.file)}" data-line="${o.line}" title="Where the code places it">${esc(o.file)}:${o.line}</button>` : ''}${eye}</div>`;
  }
  // a click on a head (true: it was one of these)
  function onHead(e) {
    const a = e.target.closest('[data-o]');
    if (!a) return false;
    e.stopPropagation();
    const o = a.dataset.obj && [...api.films(), ...api.list()].find((x) => x.id === a.dataset.obj);
    switch (a.dataset.o) {
      case 'all': open = !open; try { localStorage.setItem('nle:objects', open ? '1' : '0'); } catch { /* storage refused */ } api.relayout(); break;
      case 'code': api.code({ file: a.dataset.file, line: +a.dataset.line }); break;
      case 'add': api.add(a); break;
      case 'hide': if (o) api.hide(o); break;
      case 'tw': {
        const at = api.selected(), th = at?.id === o.id ? api.thing() : api.thingOf?.(o);
        if (th) { th.open = !th.open; api.relayout(); } else api.select(o);
        break;
      }
      case 'sel': if (o) api.select(o, e.shiftKey || e.ctrlKey || e.metaKey); break;
    }
    return true;
  }
  // a double-click on a head: an added thing's name, to rename it (true: it was one of these)
  function onDouble(e) {
    const a = e.target.closest('.mobj');
    const o = a && api.list().find((x) => x.id === a.dataset.obj);
    if (!o?.clip || e.target.closest('button')) return false;
    api.rename(o, a.querySelector('b'));
    return true;
  }
  // a right click on a head: what can be done to it, as its bar's (true: it was one of these)
  function onMenu(e) {
    const a = e.target.closest('.mobj');
    const o = a && api.list().find((x) => x.id === a.dataset.obj);
    if (!o) return false;
    e.preventDefault();
    api.menu(o, e.clientX, e.clientY);
    return true;
  }
  // the lane: where it is in the scene, a bar each stretch (lit where it is the selection)
  function drawBack(g, row, W) {
    g.fillStyle = '#080808'; g.fillRect(0, row.y, W, row.h);
    g.fillStyle = row.kind === 'objs' ? '#101010' : row.sel ? '#131a23' : '#131313';
    g.fillRect(0, row.y + 1, W, row.h - 2);
  }
  // (g: the lanes as the GPU draws them, lanesgpu.js: its stripes for a bar that stays where it is, held to the timeline's
  // time, so that they move with the bar)
  function draw(g, row, xOf, W) {
    if (row.kind !== 'obj') return;
    const top = row.y + 4, h = row.h - 8, o = row.obj;
    if (o.sites.length && api.hidden(o)) g.globalAlpha = 0.4;
    for (const [a, b] of o.spans) {
      const x0 = Math.max(-2, xOf(a)), x1 = Math.min(W + 2, xOf(b));
      if (x1 <= 0 || x0 >= W) continue;
      // (what can be moved in time is solid, its ends marked; what cannot, striped)
      if (o.clip) g.fillStyle = row.sel ? accent(0.42) : row.of ? accent(0.24) : '#3b4552';
      else g.fillStyle = row.sel ? g.zebra('rgb(62,86,112)', 'rgb(46,62,80)') : row.of ? g.zebra('rgb(44,56,70)', 'rgb(32,40,50)') : g.zebra('#2b3038', '#1e2126');
      g.fillRect(x0, top, Math.max(2, x1 - x0), h);
      if (o.clip && x1 - x0 > 14) { g.fillStyle = row.sel ? accent(0.95) : '#6b7a8c'; g.fillRect(x0, top, 2, h); g.fillRect(x1 - 2, top, 2, h); }
      if (row.sel) { g.strokeStyle = accent(0.8); g.lineWidth = 1; g.strokeRect(x0 + 0.5, top + 0.5, Math.max(1, x1 - x0 - 1), h - 1); }
    }
    g.globalAlpha = 1;
  }
  /** Over a row's bars, the selection's moves and keys, as its thing row draws them: drawThing(thing row, top, height). */
  function marks(row, drawThing) { if (row.kind === 'obj' && row.thing) drawThing(row.thing, row.y + 4, row.h - 8); }
  // on a bar of the row (an object there at t), or between them
  const on = (row, t) => row.kind === 'obj' && row.obj.spans.some(([a, b]) => t >= a && t < b);
  return { rows, head, onHead, onDouble, onMenu, drawBack, draw, marks, on, isRow: (r) => r.kind === 'obj' || r.kind === 'objs' };
}
