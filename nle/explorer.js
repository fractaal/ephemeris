// An explorer of the project's files, as a tree (the Assets and Code panels'): it opens at a folder of its own (home:
// media/, the project's root), and the path along its top goes up to the project's root and back; a folder opens in
// place, listed as it opens (api/files: a project can hold tens of thousands of files), and the folders open are kept
// for this machine (it opens at its own folder each time). What a file's row shows, and what clicking, double-clicking, dragging it or
// its menu does, is the panel's. Arrow keys move through it (left and right close and open a folder), Enter acts.
//
//   const x = createExplorer({ el, list, home, key, project, show, row, on, current, empty })
//     list(dir) → Promise<{ entries: [{ name, path, dir: true } | { name, path, size, kind }] }> (folderSource: api/files)
//     show(entry) → whether a file is shown; row(entry) → its row's HTML after the indent; current() → the file marked
//     on: { click(entry, e), dblclick(entry, e), menu(entry | null, e, rowEl), draggable(entry), drag(entry, e) → whether it is }
//   x.draw() · x.refresh(paths?) · x.reveal(path) · x.root() · x.setRoot(dir) · x.ask(rowEl, value) → Promise<name | null>
//   x.use(list, { open: 'all' }) (another source, a version's files, kept apart) · x.use(null) (the project's again)

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const within = (p, dir) => !dir || p === dir || p.startsWith(`${dir}/`);

/** The project's folders as api/files lists them (fetch: the panel's, for the open timeline's api/…; probe: each sound,
 *  picture and video with what the studio says it is, its `info`). */
export const folderSource = (fetcher, { probe = false } = {}) => (dir) => fetcher(`api/files?dir=${encodeURIComponent(dir)}${probe ? '&probe=1' : ''}`).then((r) => (r.ok ? r.json() : { entries: [] }));
/** A list of file paths as folders (a version's files): each folder's entries, made from the paths. */
export function pathsSource(paths, info = () => ({})) {
  const dirs = new Map([['', new Map()]]);
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      const at = parts.slice(0, i + 1).join('/'), up = parts.slice(0, i).join('/'), last = i === parts.length - 1;
      if (!dirs.has(up)) dirs.set(up, new Map());
      if (!dirs.get(up).has(at)) dirs.get(up).set(at, last ? { name: parts[i], path: at, ...info(at) } : { name: parts[i], path: at, dir: true });
      if (!last && !dirs.has(at)) dirs.set(at, new Map());
    }
  }
  return async (dir) => ({ entries: [...(dirs.get(dir)?.values() ?? [])].sort((a, b) => (b.dir === true) - (a.dir === true) || a.name.localeCompare(b.name, undefined, { numeric: true })) });
}

export function createExplorer({ el, list, home = '', key, project = 'project', show = () => true, row, on = {}, current = () => null, empty = 'Nothing here.' }) {
  const doc = el.ownerDocument;
  el.classList.add('explorer');
  el.innerHTML = '<div class="ex-path"></div><div class="ex-tree" tabindex="0"></div>';
  const bar = el.querySelector('.ex-path'), tree = el.querySelector('.ex-tree');
  const KEY = `nle:explorer:${key}:${project}`;
  // the project's own state (its root, its folders open, those listed), and another source's while it is used
  const live = { list, root: home, open: new Set(), cache: new Map() };
  try { const k = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (k) live.open = new Set(k.open ?? []); } catch { /* the default */ }
  let st = live, selected = null, byPath = new Map(), order = [];
  const keep = () => { if (st !== live) return; try { localStorage.setItem(KEY, JSON.stringify({ open: [...live.open].slice(-400) })); } catch { /* only a convenience */ } };

  function load(dir) {
    if (st.cache.has(dir)) return;
    const s = st;
    s.cache.set(dir, null);   // (being listed)
    s.list(dir).then((r) => { s.cache.set(dir, r?.entries ?? []); if (s === st) draw(); }, () => { s.cache.set(dir, []); if (s === st) draw(); });
  }

  function drawPath() {
    const parts = st.root ? st.root.split('/') : [], crumbs = [`<button class="ex-crumb" data-root="" title="The project's folder">${esc(project)}</button>`];
    parts.forEach((p, i) => crumbs.push(`<span class="ex-sep">/</span><button class="ex-crumb" data-root="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`));
    bar.innerHTML = `<button class="ex-up" title="Up a folder" aria-label="Up a folder"${st.root ? '' : ' disabled'}>↑</button><span class="ex-crumbs">${crumbs.join('')}</span>`
      + (st === live && st.root !== home ? `<button class="ex-home" title="Back to ${esc(home || project)}" aria-label="Back to ${esc(home || project)}">⌂</button>` : '');
    bar.querySelector('.ex-crumbs').scrollLeft = 1e6;
  }
  function draw() {
    drawPath();
    const rows = [], cur = current();
    byPath = new Map(); order = [];
    (function walk(dir, depth) {
      const entries = st.cache.get(dir);
      if (entries === undefined) load(dir);
      if (!entries) { rows.push(`<div class="ex-row ex-wait" style="--d:${depth}">…</div>`); return; }
      let n = 0;
      for (const e of entries) {
        if (!e.dir && !show(e)) continue;
        n++; byPath.set(e.path, e); order.push(e.path);
        if (e.dir) {
          const open = st.open.has(e.path);
          rows.push(`<div class="ex-row ex-dir${selected === e.path ? ' sel' : ''}" data-path="${esc(e.path)}" style="--d:${depth}"><span class="ex-tw${open ? ' open' : ''}"></span><span class="ex-name">${esc(e.name)}</span></div>`);
          if (open) walk(e.path, depth + 1);
        } else {
          const drag = on.drag && (on.draggable?.(e) ?? true) ? ' draggable="true"' : '';
          rows.push(`<div class="ex-row ex-file${e.path === cur ? ' on' : ''}${selected === e.path ? ' sel' : ''}" data-path="${esc(e.path)}" style="--d:${depth}" title="${esc(e.path)}"${drag}>${row(e)}</div>`);
        }
      }
      if (!n && depth === 0) rows.push(`<div class="ex-empty">${esc(empty)}</div>`);
    })(st.root, 0);
    tree.innerHTML = rows.join('');
  }

  function setRoot(dir) {
    st.root = dir;
    selected = null;
    keep(); draw();
    tree.scrollTop = 0;
  }
  function toggle(dir, open = !st.open.has(dir)) {
    if (open) st.open.add(dir); else st.open.delete(dir);
    keep(); draw();
  }
  const entryOf = (rowEl) => rowEl && byPath.get(rowEl.dataset.path);
  function choose(path) {
    selected = path;
    for (const r of tree.querySelectorAll('.ex-row.sel')) r.classList.remove('sel');
    const r = [...tree.querySelectorAll('.ex-row[data-path]')].find((x) => x.dataset.path === path);
    r?.classList.add('sel'); r?.scrollIntoView({ block: 'nearest' });
  }

  bar.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('ex-up')) setRoot(parentOf(st.root));
    else if (b.classList.contains('ex-home')) setRoot(home);
    else if (b.dataset.root != null) setRoot(b.dataset.root);
    b.blur();   // (Space plays)
  };
  tree.onclick = (e) => {
    const r = e.target.closest('.ex-row'), x = entryOf(r);
    if (!x || r.querySelector('input')) return;
    choose(x.path);
    if (x.dir) toggle(x.path); else on.click?.(x, e);
  };
  tree.ondblclick = (e) => { const x = entryOf(e.target.closest('.ex-row')); if (x && !x.dir) on.dblclick?.(x, e); };
  tree.oncontextmenu = (e) => {
    if (!on.menu) return;
    e.preventDefault();
    const r = e.target.closest('.ex-row'), x = entryOf(r);
    if (x) choose(x.path);
    on.menu(x ?? null, e, r);
  };
  tree.ondragstart = (e) => { const x = entryOf(e.target.closest('.ex-row')); if (!x || !on.drag?.(x, e)) e.preventDefault(); };
  tree.onkeydown = (e) => {
    if (e.target !== tree) return;
    const i = order.indexOf(selected), x = byPath.get(selected);
    const go = (j) => { if (order[j] != null) choose(order[j]); };
    if (e.key === 'ArrowDown') go(i < 0 ? 0 : Math.min(order.length - 1, i + 1));
    else if (e.key === 'ArrowUp') go(i < 0 ? 0 : Math.max(0, i - 1));
    else if (e.key === 'ArrowRight' && x?.dir) { if (!st.open.has(x.path)) toggle(x.path, true); else go(i + 1); }
    else if (e.key === 'ArrowLeft' && x) { if (x.dir && st.open.has(x.path)) toggle(x.path, false); else if (parentOf(x.path) !== st.root && within(parentOf(x.path), st.root)) choose(parentOf(x.path)); }
    else if (e.key === 'Enter' && x) { if (x.dir) toggle(x.path); else (on.dblclick ?? on.click)?.(x, e); }
    else return;
    e.preventDefault(); e.stopPropagation();
  };

  return {
    draw,
    /** The folders that hold `paths` listed again (none given: every folder); those open, as they show. */
    refresh(paths) {
      if (!paths) live.cache.clear();
      else for (const p of paths) for (let d = parentOf(p); ; d = parentOf(d)) { live.cache.delete(d); if (!d) break; }
      if (st === live) draw();
    },
    /** Shows the file at `path`: its folders opened (and the root its, if it is not inside it). */
    reveal(path) {
      if (!path) return;
      if (!within(path, st.root)) st.root = within(path, home) ? home : '';
      for (let d = parentOf(path); d && d !== st.root; d = parentOf(d)) st.open.add(d);
      keep(); draw();
      choose(path);
    },
    root: () => st.root,
    setRoot,
    /** A name typed in place of a row (or at the top): Enter takes it, Esc or leaving it does not. */
    ask(rowEl, value) {
      return new Promise((done) => {
        const box = doc.createElement('div'), input = doc.createElement('input');
        box.className = 'ex-row ex-ask'; box.style.cssText = rowEl?.getAttribute('style') ?? '--d:0';
        input.value = value; input.spellcheck = false;
        box.append(input);
        if (rowEl?.isConnected) rowEl.replaceWith(box); else tree.prepend(box);
        input.focus(); input.setSelectionRange(value.endsWith('/') ? value.length : value.lastIndexOf('/') + 1, value.length);
        let over = false;
        const end = (take) => { if (over) return; over = true; const v = input.value.trim().replace(/^\/+/, ''); draw(); done(take && v ? v : null); };
        input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') end(true); if (e.key === 'Escape') end(false); };
        input.onblur = () => end(false);
      });
    },
    /** Shows another source (a version's files: all its folders open), apart from the project's; null: the project's again. */
    use(other, { open } = {}) {
      if (!other) { st = live; draw(); return; }
      st = { list: other, root: '', open: new Set(), cache: new Map(), all: open === 'all' };
      if (open === 'all') {
        const s = st;
        // (every folder listed and opened, as it is a short list of a version's files)
        (async function openAll(dir) { for (const e of (await s.list(dir)).entries) if (e.dir) { s.open.add(e.path); await openAll(e.path); } })('').then(() => { if (s === st) draw(); });
      }
      draw();
    },
  };
}
