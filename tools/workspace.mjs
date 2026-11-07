// Where films are made: a workspace, the folder whose projects/ holds them (each a folder of its own). The studio's shared
// folders are linked into it, so it reads as a checkout does: engine/, elements/, assets/ and nle/ (films import them
// as ../../engine/…; nle/: a film that shows the editor), the skills and AGENTS.md (for agents working there), and
// ./ephemeris (this studio's command line).
// A checkout with films of its own is its own workspace; otherwise it is EPHEMERIS_WORKSPACE, or the one in
// ~/.config/ephemeris/config.json (the app asks for it once). Whichever studio runs links the workspace to itself, so a
// checkout's studio shows its changes on the films there, as the app's does its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { batchScript, shellQuote } from './launchers.mjs';

export const STUDIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// this machine's choices: its workspace, how many render workers (worker.mjs)
export const CONFIG = path.join(os.homedir(), '.config', 'ephemeris', 'config.json');
// what a workspace links to (each of these, in the studio, or in the copy the app keeps of them: EPHEMERIS_SHARED)
const WIN = process.platform === 'win32';
const SHARED = ['engine', 'elements', 'assets', 'nle', 'docs', '.agents', 'AGENTS.md', 'CLAUDE.md', 'ephemeris', ...(WIN ? ['ephemeris.cmd'] : [])];

/** This machine's choices (CONFIG). */
export const config = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
/** The sound library's folder (instruments, samples, impulse responses: what `library/…` names in a sound), or null:
 *  EPHEMERIS_SOUND_LIBRARY, or soundLibrary in CONFIG. */
export const soundLibrary = () => process.env.EPHEMERIS_SOUND_LIBRARY || config().soundLibrary || null;
/** Keeps `changes` among this machine's choices. */
export function configure(changes) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ ...config(), ...changes }, null, 2) + '\n');
}
const ownFilms = () => { try { return fs.readdirSync(path.join(STUDIO, 'projects')).some((n) => !n.startsWith('.')); } catch { return false; } };

/** The workspace's folder (null: none chosen yet, and this checkout has no films of its own). */
export function chosen() {
  if (process.env.EPHEMERIS_WORKSPACE) return path.resolve(process.env.EPHEMERIS_WORKSPACE);
  if (ownFilms()) return STUDIO;
  return config().workspace ?? null;
}
/** Keeps `dir` as the workspace from now on. */
export function choose(dir) { configure({ workspace: path.resolve(dir) }); }

/** The workspace, ready: its projects/ there, and this studio linked in (this checkout itself, if none was chosen; the
 *  app's studio has no films of its own, and asks for a workspace when it first opens). */
export function workspace() {
  let ws = chosen() ?? (process.env.EPHEMERIS_SHARED ? null : STUDIO);
  if (!ws) { console.error('no workspace yet: open Ephemeris once, and choose the folder your films live in'); process.exit(1); }
  fs.mkdirSync(path.join(ws, 'projects'), { recursive: true });
  // its real path, as git and the studio's own files give theirs (a workspace reached through a link, like macOS's /tmp,
  // is otherwise not where git says its films are)
  ws = fs.realpathSync(ws);
  if (ws !== STUDIO) link(ws, process.env.EPHEMERIS_SHARED || STUDIO);
  return ws;
}

// links each shared folder or file into the workspace, replacing a link to another studio's (never a folder of its own;
// and never into a checkout, whose own links are its files: another studio runs on its films as they are)
function link(ws, from) {
  try { if (fs.lstatSync(path.join(ws, 'engine')).isDirectory()) return; } catch { /* not a checkout */ }
  // Windows directory junctions need no elevation. Files are copied (or a launcher points at the studio): remember
  // only those we made, by content, so switching studios refreshes them without overwriting the person's own files.
  const manifest = path.join(ws, '.ephemeris-links.json');
  let copies = {};
  if (WIN) { try { copies = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch { /* first link */ } }
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const put = (name, target) => {
    if (!fs.existsSync(target)) return;
    const at = path.join(ws, name);
    let st = null;
    try { st = fs.lstatSync(at); } catch { /* none yet */ }
    if (WIN && fs.statSync(target).isFile()) {
      if (st && !st.isSymbolicLink() && (!st.isFile() || copies[name] !== hash(fs.readFileSync(at)))) { delete copies[name]; return; }
      const bytes = name === 'ephemeris.cmd' ? Buffer.from(batchScript(`call "${target.replaceAll('%', '%%')}" %*`))
        : name === 'ephemeris' ? Buffer.from(`#!/bin/sh\nexec ${shellQuote(target)} "$@"\n`) : fs.readFileSync(target);
      if (st?.isSymbolicLink()) fs.unlinkSync(at);
      fs.writeFileSync(at, bytes, { mode: name === 'ephemeris' ? 0o755 : 0o644 });
      copies[name] = hash(bytes);
      return;
    }
    if (st && !st.isSymbolicLink()) return;   // the workspace's own: left as it is
    if (st && fs.readlinkSync(at) === target) return;
    if (st) fs.unlinkSync(at);
    fs.symlinkSync(target, at, WIN ? 'junction' : undefined);
  };
  for (const name of SHARED) put(name, path.join(from, WIN && name === 'CLAUDE.md' ? 'AGENTS.md' : name));
  // agents (Claude Code) find skills in .claude/skills, beside the workspace's own .claude settings
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  put(path.join('.claude', 'skills'), path.join(from, '.agents', 'skills'));
  if (WIN) fs.writeFileSync(manifest, JSON.stringify(copies) + '\n');
}

/** This studio's version: its commit in a checkout, or what the app's build recorded (version.json). */
export function version() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: STUDIO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a checkout */ }
  try { return JSON.parse(fs.readFileSync(path.join(STUDIO, 'version.json'), 'utf8')).version; } catch { return null; }
}
