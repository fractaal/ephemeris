// The editor's panels, laid out as you like (as Blender's areas, or an IDE's): side by side or stacked, a tree of
// splits whose leaves hold one panel or several as tabs. Drag between two panels to resize them; drag a panel by its
// grip (⋮⋮, at the start of its header) onto another's edge to put it beside it, onto its middle to make them tabs, or
// onto the window's edge to run it along that side; ⧉ opens it in a window of its own (another screen: the viewer,
// Claude), and closing that window docks it back where it was; × closes it on this page (the Window menu opens it
// again, where it was). Pages (Film, Music: Resolve's pages) are layouts of their own, each kept as you leave it, with
// its own closed panels; a panel in a window of its own stays there on every page. Kept for this machine
// (localStorage), with the windows it opened (reopened, where they were, when the studio opens again). A panel's own
// `hidden` (Claude's, closed) takes it out until it shows again.
//
// A panel in a window of its own is still this page's: the same code runs it (no copy of the editor to keep in step),
// so what reaches only this window has to reach those too — the keys and the pointer (onEvery), elements looked up by
// id (find), menus opened from it (in its own document), the body's state (bodyClass) and the frame loop (frame, so it
// still draws while the main window is minimised).
import { icon } from './icons.js';

const KEY = 'nle:layout', MIN = 120;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- the windows: this one and the panels' own
const popouts = new Map();   // panel id → its window
const handlers = [];         // [type, fn, options]: on every window
/** Listens on this window and every panel's own, now and as they open. */
export function onEvery(type, fn, options) {
  handlers.push([type, fn, options]);
  addEventListener(type, fn, options);
  for (const w of popouts.values()) w.addEventListener(type, fn, options);
}
/** Every document the editor shows: this one first. */
export const docs = () => [document, ...[...popouts.values()].filter((w) => !w.closed).map((w) => w.document)];
/** The element for selector s, in whichever document it is now. */
export function find(s) {
  for (const d of docs()) { const e = d.querySelector(s); if (e) return e; }
  return null;
}
/** A class on every window's body (playing, dropping), as on this one. */
export function bodyClass(name, on) { for (const d of docs()) d.body.classList.toggle(name, on); }
/** fn(now) once a frame, from whichever window is drawing (a minimised one draws none). */
export function frame(fn) {
  let done = false;
  const go = (now) => { if (!done) { done = true; fn(now); } };
  requestAnimationFrame(go);
  for (const w of popouts.values()) if (!w.closed) w.requestAnimationFrame(go);
}

// ---------- the tree: { dir: 'row' | 'col', size, kids: [node…] } or { tabs: [id…], active, size }; size: px, 'fill'
// (what is left, shared) or 'auto' (as its content needs). Each split has a 'fill' among the kids it shows.
const isLeaf = (n) => Array.isArray(n.tabs);
function* leaves(n) { if (isLeaf(n)) yield n; else for (const k of n.kids) yield* leaves(k); }
function parentOf(n, root) {
  if (isLeaf(root)) return null;
  for (const k of root.kids) { if (k === n) return root; const p = parentOf(n, k); if (p) return p; }
  return null;
}

/**
 * Lays out `host`'s panels. panels: { id: { el, title, head? (its header: else its first .phead), close? (its own
 * closing, in place of this page's: Claude's) } }; pages: { id: { title, def(w, h): its layout for a window w × h (a
 * panel it leaves out starts closed), v? (its version: a new one replaces the layout kept) } }, the first the one at first. relayout(): after the layout changed (the timeline
 * measures itself again); paged(): after the page changed.
 */
export function createLayout(host, panels, { pages, relayout = () => {}, paged = () => {} }) {
  const holder = document.createElement('div');   // panels not shown (another tab, hidden, closed, its own window)
  holder.hidden = true; document.body.append(holder);
  // a panel put elsewhere in this window without being taken out of it (moveBefore): a frame in it keeps its page (the
  // viewer's: the editor's own film, which taken out and put back loads again, its picture gone meanwhile), and the panel
  // its focus and scroll; into another window's document, or where the browser cannot move it so, as before
  const put = (parent, el) => {
    if (parent.moveBefore && parent.isConnected && el.isConnected && parent.ownerDocument === el.ownerDocument) {
      try { parent.moveBefore(el, null); return; } catch { /* (put as before) */ }
    }
    parent.append(el);
  };
  const ids = Object.keys(panels), first = Object.keys(pages)[0];
  // a page as its layout makes it: its tree, and the panels it leaves out closed
  const fresh = (pid) => { const tree = pages[pid].def(innerWidth, innerHeight), held = [...leaves(tree)].flatMap((l) => l.tabs); return { v: pages[pid].v ?? 1, tree, closed: ids.filter((id) => !held.includes(id)) }; };
  // (a page of other panels, from another version of the studio: its layout)
  const whole = (pg) => { const held = pg && [...leaves(pg.tree)].flatMap((l) => l.tabs).concat(pg.closed ?? []); return !!held && held.length === ids.length && ids.every((id) => held.includes(id)); };
  // (a panel a page's saved layout does not know yet, new in this version of the studio: put in the tab group that holds
  // its neighbours in the page's own layout, or closed where none of them is in it, so the director's layout is kept)
  function adopt(pid, pg) {
    const held = pg && [...leaves(pg.tree)].flatMap((l) => l.tabs).concat(pg.closed ?? []);
    if (!held || held.some((id) => !ids.includes(id))) return pg;
    const def = [...leaves(pages[pid].def(innerWidth, innerHeight))];
    for (const id of ids.filter((x) => !held.includes(x))) {
      const near = def.find((l) => l.tabs.includes(id))?.tabs.filter((x) => x !== id) ?? [];
      const leaf = [...leaves(pg.tree)].find((l) => l.tabs.some((x) => near.includes(x)));
      if (leaf) leaf.tabs.push(id); else (pg.closed ??= []).push(id);
    }
    return pg;
  }
  let state = load();

  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
    if (s?.v === 1) s = { v: 2, page: first, pages: { [first]: { tree: s.tree, closed: [] } }, detached: s.detached, bounds: s.bounds };   // (one layout: the first page's)
    if (s?.v !== 2) s = { v: 2, page: first, pages: {}, detached: [], bounds: {} };
    // (what an older layout did not keep: none detached, no windows' places)
    if (!Array.isArray(s.detached)) s.detached = [];
    if (!s.bounds || typeof s.bounds !== 'object') s.bounds = {};
    for (const pid of Object.keys(pages)) if (!whole(adopt(pid, s.pages[pid])) || (s.pages[pid].v ?? 1) !== (pages[pid].v ?? 1)) s.pages[pid] = fresh(pid);
    if (!pages[s.page]) s.page = first;
    return s;
  }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const cur = () => state.pages[state.page];
  const shown = (id) => !panels[id].el.hidden && !state.detached.includes(id) && !cur().closed.includes(id);
  const visible = (n) => (isLeaf(n) ? n.tabs.some(shown) : n.kids.some(visible));

  // ---------- each panel's grip and its own-window button, in its header
  for (const [id, p] of Object.entries(panels)) {
    const head = p.head ? p.el.querySelector(p.head) : p.el.querySelector('.phead');
    const grip = document.createElement('span');
    grip.className = 'lay-grip'; grip.title = `Drag to move ${p.title}`;
    grip.onpointerdown = (e) => startDrag(id, e);
    const pop = document.createElement('button');
    pop.className = 'lay-pop'; pop.innerHTML = icon('arrow-square-out');
    pop.onclick = () => (popouts.has(id) ? dock(id) : detach(id));
    pop.addEventListener('mouseup', () => pop.blur());
    const x = document.createElement('button');
    x.className = 'lay-close'; x.title = `Close ${p.title}`; x.innerHTML = icon('x');
    x.onclick = () => (p.close ? p.close() : close(id));
    x.addEventListener('mouseup', () => x.blur());
    head.prepend(grip); head.append(pop, x);
    if (p.icon) grip.insertAdjacentHTML('afterend', `<span class="lay-ic">${icon(p.icon)}</span>`);
    p.grip = grip; p.pop = pop;
    // (a panel hidden or shown again, as Claude's: laid out again)
    new MutationObserver(() => render()).observe(p.el, { attributes: true, attributeFilter: ['hidden'] });
  }

  // ---------- drawn: the tree as nested flex boxes, the gutters between, each leaf its panel (and its tabs)
  let rendering = false;
  function render() {
    if (rendering) return;
    rendering = true;
    // (panels moved lose their scroll and focus: kept)
    const scrolled = [...host.querySelectorAll('*')].filter((e) => e.scrollTop || e.scrollLeft).map((e) => [e, e.scrollTop, e.scrollLeft]);
    const focused = document.activeElement;
    for (const p of Object.values(panels)) if (p.el.ownerDocument === document && p.el.parentNode !== holder) put(holder, p.el);
    host.replaceChildren(node(cur().tree));
    // (each leaf's panel moved in once the leaves are in the window: see put)
    for (const leaf of host.querySelectorAll('.lay-leaf')) if (leaf.panel) put(leaf, panels[leaf.panel].el);
    for (const [e, t, l] of scrolled) { e.scrollTop = t; e.scrollLeft = l; }
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    for (const [id, p] of Object.entries(panels)) p.pop.title = popouts.has(id) ? `Dock ${p.title} back in the studio's window` : `Open ${p.title} in its own window`;
    rendering = false;
    relayout();
  }
  function node(n) {
    if (isLeaf(n)) {
      const leaf = document.createElement('div');
      leaf.className = 'lay-leaf'; leaf.layNode = n;
      const ids = n.tabs.filter(shown);
      if (!ids.includes(n.active)) n.active = ids[0];
      if (ids.length > 1) {
        const tabs = document.createElement('div');
        tabs.className = 'lay-tabs';
        tabs.innerHTML = ids.map((id) => `<button data-lay="${id}" class="${id === n.active ? 'on' : ''}">${panels[id].icon ? icon(panels[id].icon) : ''}${esc(panels[id].title)}</button>`).join('');
        tabs.onclick = (e) => { const b = e.target.closest('[data-lay]'); if (b) { n.active = b.dataset.lay; save(); render(); } };
        for (const b of tabs.querySelectorAll('button')) { b.onpointerdown = (e) => startDrag(b.dataset.lay, e); b.addEventListener('mouseup', () => b.blur()); }
        leaf.append(tabs);
      }
      leaf.panel = n.active;   // (its panel: put in by render)
      return leaf;
    }
    const box = document.createElement('div');
    box.className = `lay-split ${n.dir}`; box.layNode = n;
    const kids = n.kids.filter(visible);
    // (one of them takes what is left: the 'fill' among them, else the last)
    const fill = kids.find((k) => k.size === 'fill') ?? kids[kids.length - 1];
    kids.forEach((k, i) => {
      if (i) box.append(gutter(n, kids[i - 1], k));
      const cell = node(k);
      sizeCell(cell, k === fill ? 'fill' : k.size, n.dir);
      box.append(cell);
    });
    return box;
  }
  function sizeCell(cell, size, dir) {
    cell.style.flex = size === 'fill' ? '1 1 0' : size === 'auto' ? '0 1 auto' : `0 0 ${size}px`;
    cell.classList.toggle('lay-auto', size === 'auto'); cell.classList.toggle('lay-fill', size === 'fill');
    cell.style[dir === 'row' ? 'minWidth' : 'minHeight'] = `${size === 'auto' ? 0 : MIN}px`;
  }

  // ---------- resizing: a gutter moves the edge between the two beside it (a fixed one takes the change; two fixed share it)
  function gutter(split, a, b) {
    const g = document.createElement('div');
    g.className = `lay-gut ${split.dir}`; g.title = 'Drag to resize';
    g.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add('on');
      const row = split.dir === 'row', ca = g.previousElementSibling, cb = g.nextElementSibling;
      const ra = row ? ca.offsetWidth : ca.offsetHeight, rb = row ? cb.offsetWidth : cb.offsetHeight, x0 = row ? e.clientX : e.clientY;
      const fillA = ca.classList.contains('lay-fill'), fillB = cb.classList.contains('lay-fill');
      g.onpointermove = (ev) => {
        const na = Math.max(MIN, Math.min(ra + rb - MIN, ra + (row ? ev.clientX : ev.clientY) - x0)), nb = ra + rb - na;
        if (fillA && !fillB) b.size = Math.round(nb); else if (fillB) a.size = Math.round(na); else { a.size = Math.round(na); b.size = Math.round(nb); }
        if (a.size !== 'fill') sizeCell(ca, a.size, split.dir);
        if (b.size !== 'fill') sizeCell(cb, b.size, split.dir);
      };
      g.onpointerup = () => { g.onpointermove = g.onpointerup = null; g.classList.remove('on'); save(); relayout(); };
    };
    return g;
  }

  // ---------- moving: a panel dragged by its grip (or its tab), dropped beside another, onto it (tabs), or along an edge
  let drag = null;
  function startDrag(id, e) {
    if (e.button !== 0 || popouts.has(id)) return;
    e.preventDefault();
    drag = { id, x: e.clientX, y: e.clientY, on: false, zone: null };
    const move = (ev) => {
      if (!drag.on && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 5) return;
      if (!drag.on) {
        drag.on = true;
        drag.ghost = Object.assign(document.createElement('div'), { className: 'lay-ghost', textContent: panels[id].title });
        drag.mark = Object.assign(document.createElement('div'), { className: 'lay-drop' });
        document.body.append(drag.ghost, drag.mark);
        document.body.classList.add('lay-dragging');
      }
      drag.ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 10}px)`;
      drag.zone = zoneAt(ev.clientX, ev.clientY, id);
      const r = drag.zone?.rect;
      drag.mark.hidden = !r;
      if (r) Object.assign(drag.mark.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('keydown', key, true);
      const d = drag; drag = null;
      if (!d.on) return;
      d.ghost.remove(); d.mark.remove(); document.body.classList.remove('lay-dragging');
      if (d.zone) place(d.id, d.zone);
    };
    const key = (ev) => { if (ev.key === 'Escape' && drag?.on) { ev.stopPropagation(); drag.zone = null; up(); } };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('keydown', key, true);
  }
  // where a drop at (x, y) would put it: { leaf, side: 'left' | 'right' | 'top' | 'bottom' | 'center', rect } or
  // { root: side, rect }; null where it would not move
  function zoneAt(x, y, id) {
    const W = host.getBoundingClientRect(), E = 14;
    const edge = x - W.left < E ? 'left' : W.right - x < E ? 'right' : y - W.top < E ? 'top' : W.bottom - y < E ? 'bottom' : null;
    if (edge && x >= W.left && x <= W.right && y >= W.top && y <= W.bottom) {
      const f = 0.28, r = { left: W.left, top: W.top, width: W.width, height: W.height };
      if (edge === 'left' || edge === 'right') { r.width = W.width * f; if (edge === 'right') r.left = W.right - r.width; } else { r.height = W.height * f; if (edge === 'bottom') r.top = W.bottom - r.height; }
      return { root: edge, rect: r };
    }
    for (const el of host.querySelectorAll('.lay-leaf')) {
      const R = el.getBoundingClientRect();
      if (x < R.left || x > R.right || y < R.top || y > R.bottom) continue;
      const leaf = el.layNode, u = (x - R.left) / R.width, v = (y - R.top) / R.height;
      if (leaf.tabs.filter(shown).length === 1 && leaf.tabs.includes(id)) return null;   // (onto itself)
      const side = u > 0.3 && u < 0.7 && v > 0.3 && v < 0.7 ? 'center' : [['left', u], ['right', 1 - u], ['top', v], ['bottom', 1 - v]].reduce((a, b) => (b[1] < a[1] ? b : a))[0];
      if (side === 'center' && leaf.tabs.includes(id)) return null;
      const r = { left: R.left, top: R.top, width: R.width, height: R.height };
      if (side === 'left' || side === 'right') { r.width /= 2; if (side === 'right') r.left += r.width; }
      if (side === 'top' || side === 'bottom') { r.height /= 2; if (side === 'bottom') r.top += r.height; }
      return { leaf, side, rect: r, extent: side === 'left' || side === 'right' ? R.width : R.height };
    }
    return null;
  }
  function place(id, z) {
    take(id);
    const n = { tabs: [id], active: id };
    if (z.root) {
      const dir = z.root === 'left' || z.root === 'right' ? 'row' : 'col', first = z.root === 'left' || z.root === 'top';
      n.size = Math.round((dir === 'row' ? host.offsetWidth : host.offsetHeight) * 0.28);
      const t = cur().tree;
      if (!isLeaf(t) && t.dir === dir) t.kids[first ? 'unshift' : 'push'](n);
      else cur().tree = { dir, kids: first ? [n, { ...t, size: 'fill' }] : [{ ...t, size: 'fill' }, n] };
    } else if (z.side === 'center') {
      z.leaf.tabs.push(id); z.leaf.active = id;
    } else {
      const L = z.leaf, dir = z.side === 'left' || z.side === 'right' ? 'row' : 'col', first = z.side === 'left' || z.side === 'top';
      const P = parentOf(L, cur().tree);
      n.size = Math.max(MIN, Math.round(z.extent / 2));
      if (P && P.dir === dir) {
        P.kids.splice(P.kids.indexOf(L) + (first ? 0 : 1), 0, n);
        if (typeof L.size === 'number') L.size = Math.max(MIN, L.size - n.size);
      } else {
        const S = { dir, size: L.size, kids: first ? [n, L] : [L, n] };
        L.size = 'fill';
        if (P) P.kids[P.kids.indexOf(L)] = S; else cur().tree = S;
      }
    }
    tidy(); save(); render();
  }
  // takes panel id out of the tree (its leaf with it, if it held only that)
  function take(id) {
    const L = [...leaves(cur().tree)].find((l) => l.tabs.includes(id));
    if (!L) return;
    L.tabs = L.tabs.filter((x) => x !== id);
    if (L.active === id) L.active = L.tabs[0];
    if (!L.tabs.length) { const P = parentOf(L, cur().tree); if (P) P.kids.splice(P.kids.indexOf(L), 1); }
  }
  // splits of one kid become it (its size theirs); a split without a 'fill' gets one (its last)
  function tidy(n = cur().tree, set = (x) => { cur().tree = x; }) {
    if (isLeaf(n)) return;
    n.kids.forEach((k, i) => tidy(k, (x) => { n.kids[i] = x; }));
    if (n.kids.length === 1) { const k = n.kids[0]; k.size = n.size ?? 'fill'; set(k); return; }
    if (!n.kids.some((k) => k.size === 'fill')) n.kids[n.kids.length - 1].size = 'fill';
  }

  // ---------- closed on this page, and open again: a tab beside a panel it shared its place with in the page's own
  // layout (else beside the first)
  function close(id) {
    if (popouts.has(id)) dock(id);
    take(id); tidy();
    if (!cur().closed.includes(id)) cur().closed.push(id);
    save(); render();
  }
  function reopen(id) {
    if (!cur().closed.includes(id)) return;
    cur().closed = cur().closed.filter((x) => x !== id);
    const mates = [...leaves(pages[state.page].def(innerWidth, innerHeight))].find((l) => l.tabs.includes(id))?.tabs ?? [];
    const here = [...leaves(cur().tree)], L = here.find((l) => l.tabs.some((x) => x !== id && mates.includes(x))) ?? here[0];
    L.tabs.push(id); L.active = id;
    save(); render();
  }

  // ---------- a window of its own
  function detach(id) {
    const p = panels[id], b = state.bounds[id], r = p.el.getBoundingClientRect();
    const size = b ?? { x: screenX + r.left + 40, y: screenY + r.top + 40, w: Math.max(420, Math.round(r.width)), h: Math.max(320, Math.round(r.height)) };
    const w = open('', `ephemeris-panel-${id}`, `popup,left=${size.x},top=${size.y},width=${size.w},height=${size.h}`);
    if (!w) return false;   // (a browser that will not open it now: it stays here)
    const css = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => `<link rel="stylesheet" href="${esc(l.href)}">`).join('');
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><base href="${esc(location.href)}"><title>${esc(p.title)} · ${esc(document.title)}</title>${css}</head><body class="popout"></body></html>`);
    w.document.close();
    w.document.documentElement.style.cssText = document.documentElement.style.cssText;
    w.document.body.classList.add(...[...document.body.classList].filter((c) => c !== 'ready'));
    w.document.body.append(p.el);
    popouts.set(id, w);
    for (const [type, fn, options] of handlers) w.addEventListener(type, fn, options);
    if (!state.detached.includes(id)) state.detached.push(id);
    const keep = () => { state.bounds[id] = { x: w.screenX, y: w.screenY, w: w.outerWidth, h: w.outerHeight }; save(); };
    w.addEventListener('resize', keep);
    // closed (or reloaded): back in its place here
    w.addEventListener('pagehide', () => { if (!leaving && popouts.get(id) === w) { keep(); dock(id, false); } });
    save(); render();
    return true;
  }
  function dock(id, close = true) {
    const w = popouts.get(id);
    popouts.delete(id);
    state.detached = state.detached.filter((x) => x !== id);
    if (w) { try { if (!w.closed) state.bounds[id] = { x: w.screenX, y: w.screenY, w: w.outerWidth, h: w.outerHeight }; } catch {} }
    put(holder, panels[id].el);
    save(); render();
    if (close && w && !w.closed) w.close();
    else if (w && !w.closed) setTimeout(() => { if (!w.closed) w.close(); });   // (reloaded: an empty window)
  }
  // this page going (reloaded, closed): its panels' windows with it, to open again with it
  let leaving = false;
  addEventListener('pagehide', () => { leaving = true; for (const w of popouts.values()) { try { w.close(); } catch {} } });

  render();
  for (const id of [...state.detached]) { state.detached = state.detached.filter((x) => x !== id); detach(id); }

  return {
    render,
    /** Whether panel id is in a window of its own. */
    detached: (id) => popouts.has(id),
    /** This page's own layout again, every panel back in this window. */
    reset() { for (const id of [...popouts.keys()]) dock(id); state.pages[state.page] = fresh(state.page); save(); render(); },
    detach, dock, close, open: reopen,
    /** Whether panel id is open on this page (in its place or a window of its own). */
    isOpen: (id) => !cur().closed.includes(id),
    /** The page shown, and showing another. */
    page: () => state.page,
    setPage(pid) { if (!pages[pid] || pid === state.page) return; state.page = pid; save(); render(); paged(pid); },
    /** Brings panel id forward when it is a tab behind another (opening it on this page if it is closed). */
    reveal(id) { reopen(id); for (const l of leaves(cur().tree)) if (l.tabs.includes(id) && l.active !== id) { l.active = id; save(); render(); } },
    /** Brings panel id's own window to the front (false: it has none). */
    focus(id) { const w = popouts.get(id); if (!w) return false; w.focus(); return true; },
  };
}
