// The project's files a folder at a time, for the editor's explorers (nle/explorer.js: the Assets and Code panels): a
// folder's folders and files, each file with what it is. A project can hold tens of thousands of files (a vendored
// repository's node_modules), so each folder is listed as it is opened. The studio's own folders (history, renders),
// node_modules and dot-files are left out. A text file of the project's can be read wherever it is (the code panel shows
// one the project's history does not keep, read-only).
import fs from 'node:fs';
import path from 'node:path';
import { kindOf } from './media.mjs';

const STUDIO = new Set(['history', 'renders']), MAX = 1 << 20;
const TEXT = /\.(m?js|cjs|jsx|tsx?|css|html?|json|md|txt|wgsl|glsl|frag|vert|svg|xml|ya?ml|csv|tsv|sfz|toml|ini|sh|py)$/i;
// (a path with /, from the project's folder: none of its parts hidden, history and renders only at the top)
const shown = (rel) => !rel || rel.split('/').every((p, i) => p && p !== '..' && !p.startsWith('.') && p !== 'node_modules' && !(i === 0 && STUDIO.has(p)));
const fileOf = (dir, rel) => { const f = path.resolve(dir, rel); return shown(rel) && (f === dir || f.startsWith(dir + path.sep)) ? f : null; };

// whether a file is text the code panel can show: by its name, else (no name says) by its first bytes holding no zero
function isText(file, name, size) {
  if (size > MAX) return false;
  if (TEXT.test(name)) return true;
  if (kindOf(name) || /\.\w+$/.test(name) && !/\.(lock|log|conf|cfg|env)$/i.test(name)) return false;
  try { const fd = fs.openSync(file, 'r'), b = Buffer.alloc(Math.min(size, 8000)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); return !b.includes(0); } catch { return false; }
}

/** The folder at `rel` in the project at `dir` ('' its root): { dir, entries: [{ name, path, dir: true } | { name, path,
 *  size, kind: 'image' | 'video' | 'audio' | 'text' | null }] }, folders first, each by name; null where it is no folder
 *  shown. */
export function folder(dir, rel = '') {
  rel = String(rel).replace(/^\/+|\/+$/g, '');
  const d = fileOf(dir, rel);
  let list;
  try { list = d && fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
  if (!list) return null;
  const at = (name) => (rel ? `${rel}/${name}` : name), entries = [];
  for (const e of list) {
    const p = at(e.name);
    if (!shown(p)) continue;
    let isDir = e.isDirectory(), st = null;
    if (e.isSymbolicLink()) try { st = fs.statSync(path.join(d, e.name)); isDir = st.isDirectory(); } catch { continue; }
    if (isDir) { entries.push({ name: e.name, path: p, dir: true }); continue; }
    if (!e.isFile() && !st?.isFile()) continue;
    try { st ??= fs.statSync(path.join(d, e.name)); } catch { continue; }
    const kind = kindOf(e.name) ?? (isText(path.join(d, e.name), e.name, st.size) ? 'text' : null);
    entries.push({ name: e.name, path: p, size: st.size, kind });
  }
  entries.sort((a, b) => (b.dir === true) - (a.dir === true) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { dir: rel, entries };
}

/** The text of the file at `rel` in the project, or null: not text, over 1 MB, or not one shown. */
export function readText(dir, rel) {
  const f = fileOf(dir, String(rel));
  try { const st = f && fs.statSync(f); return st?.isFile() && isText(f, path.basename(f), st.size) ? fs.readFileSync(f, 'utf8') : null; } catch { return null; }
}
