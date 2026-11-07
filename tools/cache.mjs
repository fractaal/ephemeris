// The viewer's caches (tools/preview.mjs), every film's on this machine, kept under a size set for this machine
// (config.json cacheLimit, in GB; 10 unless set). Accurate's frames are the cache: they take long to make. The other looks'
// draw again at once, so they are kept only while a film that is open can show them (the editor's setLook drops a look's on
// leaving it), and they never take room from Accurate's. Past the limit, frames go, those least likely to be wanted first:
// the open films' other looks, then the caches of the films opened longest ago (whole), then the open film's Accurate
// frames farthest from its playhead (they render again when it comes near); a draft's frames stay until it is made, so a
// draft of a long film can pass the limit for as long as it takes.
//   const caches = createCaches(() => ({ previews: all live previews, shown: Set of visible previews }) or null);   caches.check() after frames are kept;
//   caches.info() → { bytes, limit } (bytes: all of them, the open film's as its previews count them)
// They are kept out of the films, in PREVIEWS: what is in a film is what it is made of, and a folder that is backed up
// or snapshotted (a btrfs home under snapper, say) would keep every frame the limit let go, and every one drawn again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, configure } from './workspace.mjs';

const GB = 1024 ** 3;
export const PREVIEWS = path.join(os.homedir(), '.cache', 'ephemeris', 'previews');
/** Where the film in `dir` keeps its timeline `tid`'s caches (preview/, preview-<look>/): named for the film, and for
 *  its folder, so that two workspaces' films of the same name keep their own. */
// (a look other than Accurate's: preview-<look>/)
const otherLook = (dir) => path.basename(dir) !== 'preview';
export const previewsOf = (dir, tid) => path.join(PREVIEWS, `${path.basename(dir)}-${crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 10)}`, tid);
/** This machine's limit, in GB. */
export const cacheLimit = () => { const g = +config().cacheLimit; return g > 0 ? g : 10; };
/** Sets it (1 to 1000 GB). */
export function setCacheLimit(g) { configure({ cacheLimit: Math.max(1, Math.min(1000, Math.round(+g) || 10)) }); return cacheLimit(); }

// a cache folder's size, and when it was last used (its index written: preview.json)
async function measure(dir) {
  let bytes = 0;
  for (const f of await fs.promises.readdir(dir).catch(() => [])) bytes += (await fs.promises.stat(path.join(dir, f)).catch(() => null))?.size ?? 0;
  const used = (await fs.promises.stat(path.join(dir, 'preview.json')).catch(() => fs.promises.stat(dir).catch(() => null)))?.mtimeMs ?? 0;
  return { dir, bytes, used };
}
// every cache folder on this machine (a film's that is gone among them, as one opened long ago)
async function folders() {
  const out = [];
  for (const p of await fs.promises.readdir(PREVIEWS).catch(() => [])) {
    for (const t of await fs.promises.readdir(path.join(PREVIEWS, p)).catch(() => [])) {
      for (const c of await fs.promises.readdir(path.join(PREVIEWS, p, t)).catch(() => [])) if (/^preview(-\w+)?$/.test(c)) out.push(path.join(PREVIEWS, p, t, c));
    }
  }
  return out;
}

export function createCaches(open) {
  let others = null, openDirs = '', timer = null, busy = false;
  // Inactive cache folders, measured again when the set of live timelines changes.
  async function othersNow(mine) {
    const key = [...mine].sort().join('\n');
    if (others && key === openDirs) return others;
    openDirs = key;
    const closed = (await folders()).filter((d) => !mine.has(d));
    for (const d of closed.filter(otherLook)) await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {});
    others = await Promise.all(closed.filter((d) => !otherLook(d)).map(measure));
    return others;
  }
  async function trim() {
    const o = open(), shown = (p) => o?.shown instanceof Set ? o.shown.has(p) : p === o?.shown, mine = new Set(o?.previews.map((p) => p.dir) ?? []);
    const rest = await othersNow(mine), limit = cacheLimit() * GB;
    let total = rest.reduce((a, c) => a + c.bytes, 0) + (o?.previews.reduce((a, p) => a + p.bytes(), 0) ?? 0);
    if (total <= limit) return;
    const live = o?.previews ?? [], byShown = (a, b) => shown(a) - shown(b);
    const shedAll = (list) => { for (const p of list.sort(byShown)) { if (total <= limit) return; total -= p.shed(total - limit, !shown(p)); } };
    // the open films' other looks, not shown first
    shedAll(live.filter((p) => otherLook(p.dir)));
    if (total <= limit) return;
    // the films opened longest ago, whole
    for (const c of [...rest].sort((a, b) => a.used - b.used)) {
      if (total <= limit) return;
      await fs.promises.rm(c.dir, { recursive: true, force: true }).catch(() => {});
      total -= c.bytes; rest.splice(rest.indexOf(c), 1);
      console.log(`cache: ${path.relative(PREVIEWS, c.dir)} dropped (${(c.bytes / GB).toFixed(1)} GB; limit ${cacheLimit()} GB)`);
    }
    // the open films' Accurate frames: one not shown, then those farthest from the playhead
    shedAll(live.filter((p) => !otherLook(p.dir)));
  }
  return {
    /** Frames were kept: past the limit (looked at a few seconds later, not on every frame), some go. */
    check() {
      if (timer) return;
      timer = setTimeout(async () => {
        timer = null;
        if (busy) return;
        busy = true;
        try { await trim(); } catch (e) { console.log(`cache: ${e.message}`); } finally { busy = false; }
      }, 3000);
    },
    /** Drops every film's frames (the open films' look as they had none: they render again). */
    async clear() {
      const o = open(), mine = new Set(o?.previews.map((p) => p.dir) ?? []);
      for (const d of await folders()) if (!mine.has(d)) await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {});
      others = []; openDirs = [...mine].sort().join('\n');
      for (const p of o?.previews ?? []) p.shed(0, true);
    },
    info() {
      const o = open();
      return { bytes: (others ?? []).reduce((a, c) => a + c.bytes, 0) + (o?.previews.reduce((a, p) => a + p.bytes(), 0) ?? 0), limit: cacheLimit() };
    },
  };
}
