// The images in the panel's conversations (the frames an agent looked at, the images the director attached), each kept
// once by its content in the machine's cache (~/.cache/ephemeris/agent-images/<sha1>.<ext>), so that the panel's events
// carry a reference ({ image: its file's name }) rather than the image itself. A long conversation's events were 8 to 33 MB
// of base64, sent to the editor and drawn into its thread whole. The thread shows a thumbnail of each, made once with
// ffmpeg (<sha1>-w<width>.jpg beside it). The cache is a copy: whatever it drops comes back from the transcripts when a
// conversation is shown again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const DIR = () => path.join(os.homedir(), '.cache', 'ephemeris', 'agent-images');
const LIMIT = 1024 ** 3;   // (past 1 GB, the files used longest ago go)
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
const NAME = /^[0-9a-f]{40}\.(jpg|png|webp|gif)$/;

/** An image as a data URL, kept: its reference, { image: its name }; anything else as it is. */
export function keepImage(url) {
  const m = typeof url === 'string' && /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(url);
  if (!m || !EXT[m[1]]) return url;
  const bytes = Buffer.from(m[2], 'base64');
  const name = `${crypto.createHash('sha1').update(bytes).digest('hex')}.${EXT[m[1]]}`, file = path.join(DIR(), name);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.writeFileSync(`${file}.part`, bytes);
    fs.renameSync(`${file}.part`, file);
    trimSoon();
  }
  return { image: name };
}

/** A kept image's file and type, or null (not a name of one, or not kept any more); width: a thumbnail of it that wide,
 *  made now if it is not yet (a JPEG). */
export async function imageFile(name, width = 0) {
  if (!NAME.test(name)) return null;
  const file = path.join(DIR(), name);
  if (!fs.existsSync(file)) return null;
  const w = Math.round(+width);
  if (!(w > 0)) return { file, type: TYPE[name.split('.').pop()] };
  const thumb = path.join(DIR(), `${name.split('.')[0]}-w${Math.min(1024, w)}.jpg`);
  if (!fs.existsSync(thumb)) await making(thumb, () => scaled(file, thumb, Math.min(1024, w)));
  return { file: thumb, type: 'image/jpeg' };
}

// thumbnails being made (each once, however many ask), a few ffmpegs at a time
const busy = new Map(), queue = [];
let running = 0;
function making(out, make) {
  if (busy.has(out)) return busy.get(out);
  const p = new Promise((resolve, reject) => { queue.push(() => make().then(resolve, reject)); next(); }).finally(() => busy.delete(out));
  busy.set(out, p);
  return p;
}
function next() {
  while (running < 3 && queue.length) { running++; queue.shift()().finally(() => { running--; next(); }); }
}
function scaled(file, out, width) {
  return new Promise((resolve, reject) => {
    const err = [], part = `${out}.part.jpg`;
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', `scale='min(${width},iw)':-2`, '-frames:v', '1', '-q:v', '4', part], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) { fs.renameSync(part, out); resolve(); } else { fs.rmSync(part, { force: true }); reject(new Error(`ffmpeg: ${Buffer.concat(err).toString().trim()}`)); }
    });
  });
}

// the cache under its limit, the files used longest ago going first (at most once a minute)
let trimAt = 0;
function trimSoon() {
  if (Date.now() - trimAt < 60_000) return;
  trimAt = Date.now();
  setTimeout(() => {
    try {
      const files = fs.readdirSync(DIR()).map((f) => { const p = path.join(DIR(), f), s = fs.statSync(p); return { p, size: s.size, at: Math.max(s.atimeMs, s.mtimeMs) }; });
      let total = files.reduce((a, f) => a + f.size, 0);
      for (const f of files.sort((a, b) => a.at - b.at)) { if (total <= LIMIT) break; fs.rmSync(f.p, { force: true }); total -= f.size; }
    } catch { /* (a copy: nothing is lost) */ }
  }, 1000).unref?.();
}
