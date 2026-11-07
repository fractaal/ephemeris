// The Code panel: the film's code (the files a version of it holds, its timelines aside: the studio's api/code), in an
// explorer of the project's folders (explorer.js: a file made, renamed or taken away from its right-click menu, each kept
// in the history; any other text file of the project's, a timeline or one in assets/, opened read-only) beside an editor — Ctrl+S writes the file, and the viewer renders the film again, as for any edit to it. Each
// file keeps its unsaved edits while another is shown. A file changed on disk (an agent, another editor) is loaded where
// it has no unsaved edits; otherwise the panel asks which wins. Wherever the studio names a line of the film's code (the
// inspector's, a lane's, an object's, the agent's), it opens here at that line (reveal): a line of Ephemeris's own code
// opens read-only. A version from the History is shown here too: what it changed, file by file, each as a diff of the
// file before and after it, with Restore (the whole project brought back to it).
// CodeMirror 6, loaded as the browser loads modules (index.html's import map).
import { linkFetch } from './link.js';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state';
import { keymap, Decoration } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { unifiedMergeView } from '@codemirror/merge';
import { tags as t } from '@lezer/highlight';
import { createExplorer, folderSource, pathsSource } from './explorer.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const languageOf = (f) => (/\.(m?js|cjs|jsx)$/.test(f) ? javascript({ jsx: f.endsWith('x') }) : /\.tsx?$/.test(f) ? javascript({ typescript: true, jsx: f.endsWith('x') }) : f.endsWith('.css') ? css() : /\.html?$/.test(f) ? html() : f.endsWith('.json') ? json() : []);

// the editor's look: its panels' greys, the mono face, the accent for the caret and selection
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '11.5px', color: 'var(--text)', backgroundColor: '#0f0f0f' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'oklch(80% 0.1 250 / 0.22) !important' },
  '.cm-gutters': { backgroundColor: '#121212', color: 'var(--faint)', border: 'none', borderRight: '1px solid var(--line)' },
  '.cm-activeLine': { backgroundColor: '#ffffff06' }, '.cm-activeLineGutter': { backgroundColor: '#ffffff08', color: 'var(--dim)' },
  '.cm-selectionMatch': { backgroundColor: '#ffffff12' }, '&.cm-focused .cm-matchingBracket': { backgroundColor: '#ffffff1c', outline: 'none' },
  '.cm-tooltip, .cm-panels': { backgroundColor: 'var(--raised)', color: 'var(--text)', border: '1px solid var(--line-2)' },
  '.cm-searchMatch': { backgroundColor: 'oklch(80% 0.12 85 / 0.25)' },
  // (the line the studio opened the file at; the lines that place the thing selected)
  '.cm-jumped': { backgroundColor: 'var(--accent-a)', boxShadow: 'inset 2px 0 var(--accent)' },
  '.cm-placed': { boxShadow: 'inset 3px 0 var(--accent)' },
  // (a version's diff: what it added green, what it took out red)
  '.cm-changedLine': { backgroundColor: 'oklch(72% 0.13 150 / 0.1) !important' }, '.cm-changedText': { background: 'oklch(72% 0.13 150 / 0.28) !important' },
  '.cm-deletedChunk': { backgroundColor: 'oklch(65% 0.16 25 / 0.12) !important' }, '.cm-deletedChunk del, .cm-deletedText': { background: 'oklch(65% 0.16 25 / 0.3) !important', textDecoration: 'none' },
  '.cm-collapsedLines': { color: 'var(--dim)', background: 'var(--panel)' },
}, { dark: true });
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: 'oklch(76% 0.11 305)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'oklch(80% 0.1 145)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'oklch(82% 0.1 65)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6f6f6f', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'oklch(82% 0.09 245)' },
  { tag: [t.typeName, t.className, t.tagName], color: 'oklch(82% 0.09 195)' },
  { tag: [t.propertyName, t.attributeName], color: '#c9c9c9' },
  { tag: [t.definition(t.variableName)], color: '#e4e4e4' },
  { tag: [t.operator, t.punctuation, t.bracket], color: '#9a9a9a' },
  { tag: t.invalid, color: 'var(--bad)' },
]);
// the line opened at (reveal), marked until the next is
const jump = StateEffect.define();
const jumped = StateField.define({
  create: () => Decoration.none,
  update: (d, tr) => { for (const e of tr.effects) if (e.is(jump)) return Decoration.set([Decoration.line({ class: 'cm-jumped' }).range(e.value)]); return d.map(tr.changes); },
  provide: (f) => EditorView.decorations.from(f),
});
// the lines that place the thing selected in the studio (docs/selection.md), marked while it is
const place = StateEffect.define();
const placed = StateField.define({
  create: () => Decoration.none,
  update: (d, tr) => { for (const e of tr.effects) if (e.is(place)) return Decoration.set(e.value.map((at) => Decoration.line({ class: 'cm-placed' }).range(at)), true); return d.map(tr.changes); },
  provide: (f) => EditorView.decorations.from(f),
});
const look = [theme, syntaxHighlighting(highlight), jumped, placed];
const quiet = (doc) => EditorState.create({ doc, extensions: [EditorState.readOnly.of(true), look] });

const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const ICON = { js: 'JS', mjs: 'JS', cjs: 'JS', ts: 'TS', css: '#', html: '<>', json: '{}', md: 'M', wgsl: 'S', glsl: 'S' };
const iconOf = (f) => ICON[/\.(\w+)$/.exec(f)?.[1]] ?? '·';
const KEY = 'nle:codeTree';

/**
 * host: the panel's element; dir: the project's folder (projects/<name>, as the studio's paths name it); api(path,
 * init) → fetch's response (the open timeline's api/…); toast(text, bad); openMenu(anchor, items, at); tag(n),
 * untag(n, name): version n tagged, a tag of it taken away; restore(n): the whole project brought back to version n (the
 * editor saves its edits first).
 * → { filesChanged(event) (the studio's 'files' event), reveal({ file, line, col }) (a line, opened here), showVersion(h)
 *    (a row of the History), relayout() (after the panel moved: a window of its own), dirty() (files with unsaved edits) }
 */
export function createCodePanel({ host, dir, api, toast, openMenu, restore, tag, untag, selected = () => {} }) {
  host.innerHTML = `<div class="phead"><span class="ptab on">Code</span><span class="pctx code-ctx"></span><span class="grow"></span>
    <button class="tog code-tree-btn" title="The project's files">Files</button>
    <button class="tog code-save" title="Write the file (Ctrl+S): the viewer renders the project again">Save</button></div>
    <div class="code-bar code-version" hidden></div><div class="code-bar code-conflict" hidden></div>
    <div class="code-main"><nav class="code-tree" aria-label="The project's files"><div class="code-tree-head"><span>Files</span><span class="grow"></span>
      <button class="tb code-new" title="A new file (a path: parts/sky.js makes its folder)" aria-label="New file">+</button></div><div class="code-explorer"></div></nav>
    <div class="code-gutter"></div><div class="code-body"></div></div>`;
  const $ = (s) => host.querySelector(s), body = $('.code-body'), bar = $('.code-version'), clash = $('.code-conflict'), ctx = $('.code-ctx'), saveBtn = $('.code-save');
  const tree = $('.code-tree'), main = $('.code-main');
  // each file shown: { state (CodeMirror's: its text, undo, selection), base (its text as last read or written), other
  // (Ephemeris's own code, read-only) }
  const files = new Map();
  let list = [], path = null, version = null;   // (version: the History's row shown, its files' texts; null: editing)
  const language = new Compartment();
  const view = new EditorView({ parent: body, root: host.ownerDocument, state: quiet('') });
  // (the file shown is in the view: its state there is the one to read)
  const stateOf = (f) => (f === path && !version ? view.state : files.get(f)?.state);
  const dirtyIn = (f) => files.has(f) && !files.get(f).other && stateOf(f).doc.toString() !== files.get(f).base;
  let wasDirty = false;
  // Manual edits stay unsaved across project switches; the original base still detects concurrent agent edits.
  const draftKey = `nle:code-draft:${dir}`;
  let drafts = null;
  try { drafts = JSON.parse(sessionStorage.getItem(draftKey) || 'null'); } catch {}
  function stash() {
    const dirty = [...files.keys()].filter(dirtyIn);
    try { sessionStorage.setItem(draftKey, JSON.stringify({ path, files: dirty.map((f) => ({ path: f, base: files.get(f).base, text: stateOf(f).doc.toString() })) })); return true; }
    catch { return !dirty.length; }
  }


  // the explorer's place (shown, its width), kept for this machine
  let shape = { on: true, w: 190 };
  try { shape = { ...shape, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { /* the default */ }
  const keepShape = () => { try { localStorage.setItem(KEY, JSON.stringify(shape)); } catch { /* only a convenience */ } };
  const placed = () => { tree.hidden = $('.code-gutter').hidden = !shape.on; main.style.setProperty('--tree-w', `${shape.w}px`); $('.code-tree-btn').classList.toggle('on', shape.on); };
  placed();
  $('.code-tree-btn').onclick = () => { shape.on = !shape.on; keepShape(); placed(); };
  $('.code-gutter').onpointerdown = (e) => {
    const g = e.currentTarget, x0 = e.clientX, w0 = shape.w;
    g.setPointerCapture(e.pointerId);
    g.onpointermove = (m) => { shape.w = Math.round(Math.min(480, Math.max(120, w0 + m.clientX - x0))); placed(); };
    g.onpointerup = () => { g.onpointermove = g.onpointerup = null; keepShape(); };
  };

  // the lines you select are the studio's selection (selected: { file, from, to }, or null once no text is selected), told
  // once the selection rests
  let telling = null, told = null;
  const choosing = EditorView.updateListener.of((u) => {
    if (!u.selectionSet || !u.transactions.some((tr) => tr.isUserEvent('select') || tr.isUserEvent('select.pointer'))) return;
    clearTimeout(telling);
    telling = setTimeout(() => {
      const r = view.state.selection.main, doc = view.state.doc, now = r.empty || !path ? null : { file: path, from: doc.lineAt(r.from).number, to: doc.lineAt(r.to - (r.to > r.from && doc.lineAt(r.to).from === r.to ? 1 : 0)).number };
      if (JSON.stringify(now) !== JSON.stringify(told)) { told = now; selected(now); }
    }, 120);
  });
  function editing(doc, f) {
    return EditorState.create({ doc, extensions: [basicSetup, keymap.of([{ key: 'Mod-s', run: () => { save(); return true; } }, indentWithTab]), language.of(languageOf(f)), look, choosing,
      EditorView.updateListener.of((u) => { if (u.docChanged && dirtyIn(path) !== wasDirty) shown(); })] });
  }
  const reading = (doc, f) => EditorState.create({ doc, extensions: [basicSetup, EditorState.readOnly.of(true), languageOf(f), look, choosing] });
  // the selected thing's lines (its sites, "file:line:col"), marked in whichever of them is shown
  let sites = [];
  function markPlaced() {
    const doc = view.state.doc, at = sites.flatMap((s) => { const m = /^(.*?):(\d+)(?::\d+)?$/.exec(s), n = +m?.[2]; return m?.[1] === path && n >= 1 && n <= doc.lines ? [doc.line(n).from] : []; });
    view.dispatch({ effects: place.of([...new Set(at)].sort((a, b) => a - b)) });
  }

  // ---------- what is shown: the explorer, the header
  function shown() {
    const x = path && files.get(path);
    if (version) ctx.textContent = `version ${version.h.n}${version.path ? ` · ${version.path}` : ''}`;
    else ctx.textContent = !path ? '' : x?.other === 'project' ? `${path} · read-only: not the project's code` : x?.other ? `${path} · Ephemeris's own, read-only` : `${path} · ${(wasDirty = dirtyIn(path)) ? 'unsaved' : 'saved'}`;
    saveBtn.hidden = !!version || !!x?.other;
    saveBtn.classList.toggle('on', !version && wasDirty);
    drawTree();
  }
  // the explorer: the project's text files (a version's: the files it changed, each marked made, changed or taken away)
  const ex = createExplorer({
    el: $('.code-explorer'), list: folderSource(api), home: '', key: 'code', project: dir.split('/').pop(), empty: 'No code yet: + makes a file.',
    show: (e) => !!version || e.kind === 'text',
    current: () => (version ? version.path : path),
    row: (e) => {
      const v = version, f = e.path, own = list.includes(f);
      const badge = v ? (v.h.added.includes(f) ? '<b class="ct-badge add" title="Made in this version">A</b>' : v.h.removed.includes(f) ? '<b class="ct-badge del" title="Taken away in this version">D</b>' : '<b class="ct-badge mod" title="Changed in this version">M</b>')
        : dirtyIn(f) ? '<i class="ct-dot" title="Unsaved"></i>' : '';
      return `<span class="ct-icon">${iconOf(f)}</span><span class="ex-name${v || own ? '' : ' ct-ro'}"${v || own ? '' : ' title="Read-only: not the project\'s code"'}>${esc(e.name)}</span>${badge}`;
    },
    on: {
      click: (e) => { if (version) { version.path = e.path; showVersionFile(); } else open(e.path); },
      // a file made, renamed or taken away (editing, not a version)
      menu: (e, ev, r) => {
        if (version) return;
        const p = e?.path ?? null, folder = e ? (e.dir ? e.path : parentOf(e.path)) : ex.root();
        openMenu(r ?? tree, [
          { label: folder ? `New file in ${folder}/…` : 'New file…', act: () => ex.ask(r, folder ? `${folder}/` : '').then((to) => to && change('POST', { path: to }, to)) },
          ...(p && (e.dir || list.includes(p)) ? ['hr', { label: 'Rename…', act: () => ex.ask(r, p).then((to) => to && to !== p && change('PATCH', { path: p, to }, e.dir ? null : to, p)) },
            { label: 'Delete…', act: () => { if (confirm(`Delete ${p}${e.dir ? ' and every file in it' : ''}? It stays in the project's history.`)) change('DELETE', null, null, p); } }] : []),
        ], { x: ev.clientX, y: ev.clientY });
      },
    },
  });
  const drawTree = () => ex.draw();
  $('.code-new').onclick = () => { if (!version) ex.ask(null, ex.root() ? `${ex.root()}/` : '').then((to) => to && change('POST', { path: to }, to)); };
  // → the explorer's change made (the studio keeps it as a version); `opens`: the file to show after it, `was`: the one
  // it renamed or took away
  async function change(method, body, opens, was = null) {
    const r = await api(method === 'DELETE' ? `api/code/file?path=${encodeURIComponent(was)}` : 'api/code/file', { method, ...(body && { body: JSON.stringify(body) }) }), b = await r.json().catch(() => ({}));
    if (!r.ok) { toast(b.error ?? `Could not change ${was ?? body?.path}`, true); return; }
    // (a file renamed keeps its unsaved edits; one shown, and gone, gives way to another)
    if (method === 'PATCH') for (const [f, x] of [...files]) if (f === was || f.startsWith(`${was}/`)) { files.delete(f); files.set(body.to + f.slice(was.length), x); if (path === f) path = body.to + f.slice(was.length); }
    if (method === 'DELETE') for (const f of [...files.keys()]) if (f === was || f.startsWith(`${was}/`)) { files.delete(f); if (path === f) path = null; }
    await loadList();
    ex.refresh([was, body?.path, body?.to].filter(Boolean));
    if (opens) { await open(opens); ex.reveal(opens); }
  }

  // ---------- the film's files
  async function loadList() {
    try { list = await (await api('api/code')).json(); } catch { return; }
    if (drafts) {
      const d = drafts; drafts = null;
      for (const x of d.files ?? []) {
        if (!list.includes(x.path)) list.push(x.path); // keep recoverable text even if an agent removed its file
        files.set(x.path, { state: editing(x.text, x.path), base: x.base });
      }
      if (d.path && list.includes(d.path)) await open(d.path);
    }
    await settle();
  }
  // (the file shown is still there: else film.js, or the first)
  async function settle() {
    if (!version && (!path || (!list.includes(path) && !files.get(path)?.other))) await open(list.find((f) => /(^|\/)film\.js$/.test(f)) ?? list[0] ?? null);
    else shown();
  }
  async function read(f) { const r = await api(`api/code/file?path=${encodeURIComponent(f)}`); return r.ok ? (await r.json()).text : null; }
  // (a text file of the project's that is not the film's code: a timeline, one in assets/)
  async function readOther(f) { const r = await api(`api/files/text?path=${encodeURIComponent(f)}`); return r.ok ? (await r.json()).text : null; }
  async function open(f) {
    if (path && files.has(path) && !version) files.get(path).state = view.state;
    path = f;
    if (!f) { view.setState(quiet('')); shown(); return; }
    if (!files.has(f)) {
      const own = list.includes(f), text = await (own ? read(f) : readOther(f));
      if (text == null) { path = null; return loadList(); }
      files.set(f, own ? { state: editing(text, f), base: text } : { state: reading(text, f), base: text, other: 'project' });
    }
    view.setState(files.get(f).state);
    markPlaced();
    shown();
  }
  async function save() {
    const x = files.get(path), f = path;
    if (!x || x.other || version) return;
    x.state = view.state;
    const text = view.state.doc.toString();
    if (text === x.base) return;
    const r = await api('api/code/file', { method: 'PUT', body: JSON.stringify({ path: f, text, base: x.base }) }), b = await r.json().catch(() => ({}));
    if (r.status === 409) return conflict(f, b.text);
    if (!r.ok) { toast(b.error ?? `Could not save ${f}`, true); return; }
    x.base = text;
    if (f === path) shown();
  }
  // the file changed on disk while it had unsaved edits here: the director chooses
  function conflict(f, disk) {
    clash.hidden = false;
    clash.innerHTML = `<span><b>${esc(f)} changed on disk</b> while you had unsaved edits.</span><button class="btn" data-k="disk">Load the disk version</button><button class="btn" data-k="mine">Keep mine</button>`;
    clash.onclick = (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k, x = files.get(f);
      if (!k || !x) return;
      clash.hidden = true; clash.onclick = null;
      if (path === f && !version) x.state = view.state;
      if (k === 'disk') { x.state = editing(disk, f); x.base = disk; if (path === f && !version) view.setState(x.state); shown(); }
      else { x.base = disk; if (path === f && !version) save(); }
    };
  }

  // ---------- a line, opened here: the film's file (named from the project's folder, or from the studio's, as the
  // studio's own code is: read-only) at that line, marked
  async function reveal({ file, line = 1, col = 1 }) {
    let f = String(file ?? '').replace(/^\.\//, '');
    if (f.startsWith(`${dir}/`)) f = f.slice(dir.length + 1);
    if (version) closeVersion();
    if (!list.length) await loadList();
    if (list.includes(f) || files.get(f)?.other === 'project' || (!files.has(f) && (await readOther(f)) != null)) await open(f);
    else {
      if (!files.get(f)?.other) {
        const r = await linkFetch(`/files/${f.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' }).catch(() => null);
        if (!r?.ok) { toast(`${f} is not in the project's code, nor Ephemeris's`, true); return; }
        files.set(f, { state: reading(await r.text(), f), other: true });
      }
      await open(f);
    }
    const doc = view.state.doc, l = doc.line(Math.min(doc.lines, Math.max(1, Math.round(+line) || 1))), at = l.from + Math.min(l.length, Math.max(0, (+col || 1) - 1));
    view.dispatch({ selection: { anchor: at }, effects: [EditorView.scrollIntoView(at, { y: 'center' }), jump.of(l.from)] });
    shown();
    if (!files.get(f)?.other || files.get(f).other === 'project') ex.reveal(f);
  }

  // ---------- a version, from the History: each file it changed, before and after it
  async function showVersion(h) {
    if (!version && path && files.has(path)) files.get(path).state = view.state;
    const all = [...h.changed, ...h.added, ...h.removed].sort();
    version = { h, files: all, path: all.find((f) => /(^|\/)film\.js$/.test(f)) ?? all.find((f) => !f.startsWith('timelines/')) ?? all[0] ?? null };
    ex.use(pathsSource(all), { open: 'all' });
    bar.hidden = false;
    // (its tags, each taken away by its ×, and Tag… to add one)
    const chips = (h.tags ?? []).map((t) => `<span class="tag">${esc(t)}<button class="link" data-untag="${esc(t)}" title="Remove this tag">×</button></span>`).join('');
    bar.innerHTML = `<span><b>Version ${h.n}</b> ${chips} · ${esc(h.message.split('\n')[0])}</span><span class="grow"></span><button class="btn ghost" data-k="tag" title="Name this version, as a git tag: agents and ./ephemeris history take the name for it">Tag…</button><button class="btn" data-k="restore" title="Bring the whole project back to this version: its timelines and code (what is there now is kept as a version first)">Restore</button><button class="btn ghost" data-k="close" title="Back to the code as it is now">Done</button>`;
    bar.onclick = (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      const u = e.target.closest('[data-untag]')?.dataset.untag;
      if (u) { closeVersion(); untag(h.n, u); }
      if (k === 'tag') { closeVersion(); tag(h.n); }
      if (k === 'restore') { const n = h.n; closeVersion(); restore(n); }
      if (k === 'close') closeVersion();
    };
    view.setState(quiet(''));   // (until its files come)
    await showVersionFile();
  }
  async function showVersionFile() {
    const v = version, f = v?.path;
    shown();
    if (!f) { view.setState(quiet('This version changed no file.')); return; }
    const at = async (n) => (n > 0 ? (await (await api(`api/version?n=${n}&path=${encodeURIComponent(f)}`)).json().catch(() => ({}))).text ?? '' : '');
    const [before, after] = await Promise.all([at(v.h.n - 1), at(v.h.n)]);
    if (version !== v || v.path !== f) return;
    view.setState(EditorState.create({ doc: after, extensions: [basicSetup, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping, languageOf(f), look, unifiedMergeView({ original: before, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 8 } })] }));
  }
  function closeVersion() {
    version = null; bar.hidden = true; bar.onclick = null;
    ex.use(null);
    if (path && files.has(path)) { view.setState(files.get(path).state); shown(); } else open(path);
  }
  saveBtn.onclick = () => save();
  loadList();

  return {
    /** Files of the film changed (the studio's 'files' event: their paths, the film's code now, the text of each file
     *  of it changed): each one shown here loaded again where it has no unsaved edits (else the director chooses). */
    async filesChanged({ paths, code, texts }) {
      list = code;
      ex.refresh(paths);
      await settle();
      for (const f of paths) {
        const x = files.get(f), disk = texts[f];
        if (!x || disk == null || disk === x.base) continue;
        if (stateOf(f).doc.toString() === disk) { x.base = disk; continue; }   // (what was saved here)
        if (!dirtyIn(f)) { x.state = editing(disk, f); x.base = disk; if (f === path && !version) view.setState(x.state); }
        else conflict(f, disk);
      }
      shown();
    },
    reveal,
    showVersion,
    /** The lines that place the thing selected in the studio (its sites, "file:line:col"), marked; [] for none. */
    mark(list) { if (JSON.stringify(list) === JSON.stringify(sites)) return; sites = list; if (!version) markPlaced(); },
    /** Something else was selected in the studio in place of the lines selected here: the text is no longer selected. */
    unselect() { told = null; clearTimeout(telling); const r = view.state.selection.main; if (!r.empty) view.dispatch({ selection: { anchor: r.head } }); },
    /** After the panel moved (a window of its own, or back): the editor follows it into its document. */
    relayout() { if (view.root !== host.ownerDocument) view.setRoot(host.ownerDocument); },
    /** The files with unsaved edits. */
    dirty: () => [...files.keys()].filter(dirtyIn),
    stash,
  };
}
