// A film's history: versions of the whole project, each its timelines and its code as they were together (so the
// director's changes are always on the code they were made on), kept in the film's own history/. A version is a line of
// history/versions.jsonl naming the text of each file it holds; each text is kept once, compressed, in history/files/
// (named by its hash), so a version costs only the files that changed. The studio makes one whenever the project's
// files change (tools/nle.mjs); restoring one makes another, so nothing is lost by it.
// What a version holds: the project's text files, apart from what is not written by hand — folders named renders,
// media, assets, instruments (sounds, pictures and models brought in, presets copied in: each kept as it is) or
// node_modules, a folder that is a repository of its own (a product's clone), dot-files, links (to this machine's
// folders) and any file over 1 MB.
//   ./ephemeris history <name> [n|tag] [--since n|tag] [--restore n|tag] [--tag name [n|tag] [--force]] [--untag name]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { diff as lineDiff } from 'node:util';

const OUT = new Set(['history', 'renders', 'media', 'assets', 'instruments', 'node_modules']), MAX = 1 << 20;
const logFile = (dir) => path.join(dir, 'history', 'versions.jsonl');
const blob = (dir, hash) => path.join(dir, 'history', 'files', `${hash}.gz`);
const hashOf = (b) => crypto.createHash('sha1').update(b).digest('hex');
const bytesOf = (dir, hash) => zlib.gunzipSync(fs.readFileSync(blob(dir, hash)));

/** Whether a file at `rel` (a path with /, in the project at `dir`) is one a version would hold, by where it is: none of
 *  its folders left out, nor itself a dot-file (what is in it, text and size, is for sources to say). */
export function holds(dir, rel) {
  const parts = String(rel).split('/');
  if (!rel || rel.includes('\\') || /^[a-z]:/i.test(rel) || path.isAbsolute(rel) || parts.some((p) => !p || p === '..' || p.startsWith('.') || OUT.has(p))) return false;
  return !parts.slice(0, -1).some((_, i) => fs.existsSync(path.join(dir, ...parts.slice(0, i + 1), '.git')));
}

// the file at p as a version holds it, or null: a link, a folder, gone, over 1 MB, or not text (a binary file has a zero
// byte early on)
function textOf(p) {
  try { const st = fs.lstatSync(p); if (!st.isFile() || st.size > MAX) return null; } catch { return null; }
  const b = fs.readFileSync(p);
  return b.subarray(0, 8000).includes(0) ? null : b;
}
/** The files a version holds, as they are now: { 'film.js': Buffer, 'timelines/main.json': Buffer, … } (paths with /). */
export function sources(dir) {
  const out = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || OUT.has(e.name)) continue;
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!fs.existsSync(path.join(p, '.git'))) walk(p, r); }
      else if (e.isFile()) { const b = textOf(p); if (b) out[r] = b; }
    }
  })(dir, '');
  return out;
}

const logText = (dir) => { try { return fs.readFileSync(logFile(dir), 'utf8'); } catch { return ''; } };
/** The film's versions, oldest first: { n, at (an ISO time), message, files: { path: hash } }. */
export function versions(dir) {
  return logText(dir).split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });   // (a line a crash cut short: left out)
}
/** When the film was last changed, as its history knows (an ISO time), or null. */
export function lastChanged(dir) {
  try { return fs.statSync(logFile(dir)).mtime.toISOString(); } catch { return null; }
}

const same = (a, b) => { const k = Object.keys(a); return k.length === Object.keys(b).length && k.every((r) => a[r] === b[r]); };
/** Keeps the project as it is now as a new version, saying `message` → that version, or null where the last one already
 *  holds it as it is. */
export function record(dir, message) {
  const last = versions(dir).at(-1), files = {};
  for (const [r, b] of Object.entries(sources(dir))) {
    const h = (files[r] = hashOf(b)), f = blob(dir, h);
    if (fs.existsSync(f)) continue;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.part`, zlib.gzipSync(b));
    fs.renameSync(`${f}.part`, f);
  }
  if (last && same(last.files, files)) return null;
  const v = { n: (last?.n ?? 0) + 1, at: new Date().toISOString(), message: message || 'Changes', files };
  const torn = !/(^|\n)$/.test(logText(dir));   // (a line a crash cut short: this one starts a line of its own)
  fs.appendFileSync(logFile(dir), `${torn ? '\n' : ''}${JSON.stringify(v)}\n`);
  return v;
}

/** Which of the files at `rels` (paths with /; a folder: the files of it a version would hold now, and those the last
 *  one holds) are not as the last version holds them → { added, changed, removed }, each a list of paths: a file a
 *  version would hold that the last does not, one it holds that is otherwise now, one it holds that is gone. */
export function unkept(dir, rels) {
  const was = versions(dir).at(-1)?.files ?? {}, out = { added: [], changed: [], removed: [] };
  const inside = (r) => { try { return fs.lstatSync(path.join(dir, r)).isDirectory() ? Object.keys(sources(path.join(dir, r))).map((x) => `${r}/${x}`) : []; } catch { return []; } };
  const all = new Set(rels.filter((r) => holds(dir, r)).flatMap((r) => [r, ...inside(r), ...Object.keys(was).filter((k) => k.startsWith(`${r}/`))]));
  for (const r of all) {
    const b = textOf(path.join(dir, r)), h = b ? hashOf(b) : null;
    if (h === (was[r] ?? null)) continue;
    (!h ? out.removed : !was[r] ? out.added : out.changed).push(r);
  }
  return out;
}

// Tags: names for versions, as git's are ("sent to the client", "before the graze"), kept in history/tags.json as
// { name: n }. A tag names one version until it is moved (force) or taken away; restoring never moves one. Anywhere a
// version is asked for, its tag will do (resolve).
const tagFile = (dir) => path.join(dir, 'history', 'tags.json');
/** The film's tags: { name: n }. */
export function tags(dir) { try { return JSON.parse(fs.readFileSync(tagFile(dir), 'utf8')); } catch { return {}; } }
function writeTags(dir, t) {
  fs.mkdirSync(path.dirname(tagFile(dir)), { recursive: true });
  fs.writeFileSync(`${tagFile(dir)}.part`, `${JSON.stringify(t, null, 2)}\n`);
  fs.renameSync(`${tagFile(dir)}.part`, tagFile(dir));
}
/** Tags version n (the latest where left out) `name` → the tags. A name another version has already is refused unless
 *  `force` (it moves); a name is as git's are: no spaces, none of ~^:?*[\, not starting with -, and not a number. */
export function tag(dir, name, n = versions(dir).at(-1)?.n, force = false) {
  name = String(name ?? '').trim();
  if (!/^(?!-)[^\s~^:?*[\\]+$/.test(name) || /^\d+$/.test(name)) throw new Error(`"${name}" can't be a tag: no spaces or ~^:?*[\\, not starting with -, not a number`);
  if (!version(dir, n)) throw new Error(`no version ${n}`);
  const t = tags(dir);
  if (name in t && t[name] !== +n && !force) throw new Error(`the tag "${name}" is on version ${t[name]} (force moves it)`);
  t[name] = +n;
  writeTags(dir, t);
  return t;
}
/** Takes the tag `name` away → the tags. */
export function untag(dir, name) {
  const t = tags(dir);
  if (!(name in t)) throw new Error(`no tag "${name}"`);
  delete t[name];
  writeTags(dir, t);
  return t;
}
/** A version by its number or a tag → its number, or null. */
export function resolve(dir, ref) {
  if (/^\d+$/.test(String(ref ?? ''))) return version(dir, ref) ? +ref : null;
  return tags(dir)[ref] ?? null;
}

/** When version v was kept, in this machine's time: 2026-10-23 14:05. */
export const when = (v) => { const d = new Date(v.at), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
/** Version n, or null. */
export const version = (dir, n) => versions(dir).find((v) => v.n === +n) ?? null;
/** A file's text in version v, or null where v holds no such file. */
export const textAt = (dir, v, rel) => (v?.files[rel] ? bytesOf(dir, v.files[rel]).toString('utf8') : null);

/** What changed from version a to version b (a null: from nothing) → { added, changed, removed }, each a list of paths. */
export function changes(a, b) {
  const was = a?.files ?? {}, now = b.files;
  return {
    added: Object.keys(now).filter((r) => !(r in was)),
    changed: Object.keys(now).filter((r) => r in was && was[r] !== now[r]),
    removed: Object.keys(was).filter((r) => !(r in now)),
  };
}

/** The change from version a to version b (a null: from nothing) as a unified diff, as `diff -u` writes one, file by file
 *  (`only`: that file's alone). */
export function diff(dir, a, b, only = null) {
  const c = changes(a, b);
  return [...c.changed, ...c.added, ...c.removed].filter((r) => !only || r === only).sort().map((r) => unified(r, textAt(dir, a, r), textAt(dir, b, r))).join('');
}
function unified(rel, before, after, context = 3) {
  // (a file's lines, the last one marked where it has no newline, as diff -u marks it)
  const lines = (t) => { if (!t) return []; const l = t.split('\n'); if (l.at(-1) === '') l.pop(); else l[l.length - 1] += '\n\\ No newline at end of file'; return l; };
  const a = lines(before), b = lines(after);
  // (diff(actual, expected): 1 is a line only actual has, -1 one only expected has; each run of changes shows what went
  // before what came; ai, bi: where a line is in each)
  const ops = [];
  let ai = 0, bi = 0, run = [];
  const flush = () => {
    const b0 = bi;
    for (const o of run) if (o.op === '-') ops.push({ ...o, ai: ai++, bi: b0 });
    for (const o of run) if (o.op === '+') ops.push({ ...o, ai, bi: bi++ });
    run = [];
  };
  for (const [op, line] of lineDiff(b, a)) {
    if (op === 0) { flush(); ops.push({ op: ' ', line, ai: ai++, bi: bi++ }); }
    else run.push({ op: op === 1 ? '+' : '-', line });
  }
  flush();
  const out = [`--- ${before == null ? '/dev/null' : `a/${rel}`}\n+++ ${after == null ? '/dev/null' : `b/${rel}`}\n`];
  for (let i = 0; i < ops.length;) {
    if (ops[i].op === ' ') { i++; continue; }
    // a hunk: this change and those within twice the context of it, with the context around them
    let j = i;
    for (let k = i; k < ops.length && k - j <= 2 * context; k++) if (ops[k].op !== ' ') j = k;
    const from = Math.max(0, i - context), to = Math.min(ops.length, j + context + 1), h = ops.slice(from, to);
    const na = h.filter((o) => o.op !== '+').length, nb = h.filter((o) => o.op !== '-').length;
    const range = (start, n) => `${n ? start + 1 : start}${n === 1 ? '' : `,${n}`}`;
    out.push(`@@ -${range(h[0].ai, na)} +${range(h[0].bi, nb)} @@\n`, ...h.map((o) => `${o.op}${o.line}\n`));
    i = to;
  }
  return out.join('');
}

/** Writes version n's files over the project's (removing those a version would hold that it does not), after keeping
 *  the project as it is now (`before`: what that version says) → the version made of it, or null where the project
 *  already was so. */
export function restore(dir, n, before = `Before restoring version ${n}`) {
  const v = version(dir, n);
  if (!v) throw new Error(`no version ${n}`);
  record(dir, before);
  for (const r of Object.keys(sources(dir))) if (!(r in v.files)) fs.rmSync(path.join(dir, r));
  for (const [r, h] of Object.entries(v.files)) {
    const f = path.join(dir, r), b = bytesOf(dir, h);
    if (fs.existsSync(f) && fs.readFileSync(f).equals(b)) continue;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, b);
  }
  return record(dir, `Restored version ${n} (${v.message.split('\n')[0]})`);
}
