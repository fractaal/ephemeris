// Where in a film's own code a call came from, from its call stack: what the editor names things by (a placed node,
// a motion and each of its operators). Plain, so the editor shares it.

/** A timeline's clips that are things the director added by hand: each has a `thing` (engine/things.js). */
export const addedClips = (doc) => (doc?.tracks ?? []).flatMap((t) => (t.clips ?? []).filter((c) => c.thing));
/** What a film's pages take in without loading again: the timeline's overrides, and each added thing as { thing: its clip }. */
export const liveEdits = (doc) => [...(doc?.overrides ?? []), ...addedClips(doc).map((thing) => ({ thing }))];

let base = null;   // the project's folder, where the code is run from elsewhere than its page (namedFrom)
/** Runs fn with sites named from `dir` (the project folder's URL) rather than the page's: the studio running a project's
 *  code itself (its sound.js: engine/score.js), in the editor's page or in Node. */
export function namedFrom(dir, fn) {
  const was = base;
  base = dir;
  try { return fn(); } finally { base = was; }
}

/**
 * Where the film's own code made the call being made now (a node placed, a motion made): its site, as siteOf names it.
 * Read from the few frames above (a call straight from the film's code), or, where the film's is not among them (a call
 * through the engine's or an element's code), from up to 40: a call stack costs, and the editor's lanes take one for
 * every node and motion at every frame of the film.
 */
export function here() {
  const limit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 5;
    const near = siteOf(new Error().stack);
    if (near) return near;
    Error.stackTraceLimit = 40;
    return siteOf(new Error().stack);
  } finally { Error.stackTraceLimit = limit; }
}

// (each stack named once per folder it is named from: a scene's nodes are placed by the same calls at every moment)
let named = new Map(), namedDir = null, page = null;
/**
 * The first frame of `stack` in the film's own code (not the engine's, its elements' or a package's), as
 * { at: 'file:line:col', file, line, col }, the file relative to the page (or to namedFrom's folder); null without one.
 * A site given as such (named already, or a timeline's clip: { at: 'clip:<id>', clip }) is itself.
 */
export function siteOf(stack) {
  if (!stack) return null;
  if (typeof stack === 'object') return stack;
  if (!base && typeof location !== 'undefined' && page?.href !== location.href) page = { href: location.href, dir: new URL('.', location.href).href };
  const dir = base ?? page?.dir;
  if (!dir) return null;
  if (dir !== namedDir || named.size > 20000) { named = new Map(); namedDir = dir; }
  let site = named.get(stack);
  if (site === undefined) named.set(stack, (site = parse(stack, dir)));
  return site;
}
function parse(stack, dir) {
  for (const l of stack.split('\n').slice(1)) {
    const m = l.match(/((?:https?|file):\/\/[^\s()]+):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    const url = m[1].split('?')[0];
    if (!url.startsWith(dir)) continue;
    let file = url.slice(dir.length);
    // a page served from elsewhere (a product film's, from its app's dev server) reaches the film's code by its path on disk:
    // named, as every project's code is, from the project's directory
    if (file.startsWith('@fs/')) { const i = file.indexOf('/projects/'); if (i < 0) continue; file = file.slice(i + 10).split('/').slice(1).join('/'); }
    if (/(^|\/)(engine|elements|node_modules)\//.test(file) || file.startsWith('@')) continue;
    // (the line in the file as written, where the page's server changed it: its source map says)
    const [line, col] = original(m[1], +m[2], +m[3]);
    return { at: `${file}:${line}:${col}`, file, line, col };
  }
  return null;
}

// a served module's source map (a dev server inlines one where it changes the code), as each generated line's segments
// [column, source line, source column]: read once per module, as a site there is first asked for (only while the
// editor asks: picking, its lanes)
const maps = new Map();
function mapOf(url) {
  if (maps.has(url)) return maps.get(url);
  let map = null;
  try {
    const x = new XMLHttpRequest();
    x.open('GET', url, false);
    x.send();
    const ref = /\/\/# sourceMappingURL=data:application\/json;(?:charset=[^;,]+;)?base64,([A-Za-z0-9+/=]+)\s*$/.exec(x.responseText);
    if (ref) map = decode(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(ref[1]), (c) => c.charCodeAt(0)))).mappings);
  } catch { /* none: the lines are the file's */ }
  maps.set(url, map);
  return map;
}
const B64 = Object.fromEntries([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));
function decode(mappings) {
  const lines = [];
  let srcLine = 0, srcCol = 0, src = 0;
  for (const l of mappings.split(';')) {
    const segs = [];
    let col = 0;
    for (const seg of l.split(',')) {
      if (!seg) continue;
      const v = [];
      let n = 0, shift = 0;
      for (const ch of seg) {
        const d = B64[ch];
        n += (d & 31) << shift;
        if (d & 32) shift += 5;
        else { v.push(n & 1 ? -(n >> 1) : n >> 1); n = 0; shift = 0; }
      }
      col += v[0];
      if (v.length >= 4) { src += v[1]; srcLine += v[2]; srcCol += v[3]; segs.push([col, srcLine, srcCol]); }
    }
    lines.push(segs);
  }
  return lines;
}
// a generated line and column (1-based) as the source's
function original(url, line, col) {
  if (typeof XMLHttpRequest === 'undefined') return [line, col];
  const segs = mapOf(url)?.[line - 1];
  if (!segs?.length) return [line, col];
  let s = segs[0];
  for (const x of segs) { if (x[0] <= col - 1) s = x; else break; }
  return [s[1] + 1, s[2] + 1];
}

