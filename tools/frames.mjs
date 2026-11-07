// The viewer's frames, kept without loss (tools/preview.mjs): PNG, RGB (the studio's frames are opaque), each row
// filtered by its left neighbour (Sub) and deflated quickly (level 1). Measured on glass, launch and horror-test: 0.8 MB
// a frame at a viewer's 1216x684 (29 ms to make on one thread, 6 ms for the browser to decode), 1.9 MB at 1080p (73 ms,
// 14 ms). Every reader takes it as it is: the editor's viewer decodes it off its main thread (raw frames, ~4x the
// bytes, took that thread's time and held up its input at 60 frames a second), ffmpeg reads it for the draft and makes
// agents' JPEGs from it. Made on threads of their own, so the studio's server is never held up by it.
//   const png = await encode(rgba, w, h);
//   const jpg = await jpeg(png, 0.9);   (a JPEG of a kept frame, for agents and posters: ffmpeg; { width } scales it)
//   const small = await compress(png, w, h);   (one for a viewer on another device, many a second: see below)
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type, data) {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return out;
}
function encodeNow(rgba, w, h) {
  const rows = Buffer.allocUnsafe(h * (w * 3 + 1));
  for (let y = 0, i = 0, o = 0; y < h; y++) {
    rows[o++] = 1;   // (Sub)
    let r = 0, g = 0, b = 0;
    for (let x = 0; x < w; x++, i += 4) {
      const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2];
      rows[o++] = (R - r) & 255; rows[o++] = (G - g) & 255; rows[o++] = (B - b) & 255;
      r = R; g = G; b = B;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;   // (8 bits, RGB)
  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 1 })), chunk('IEND', Buffer.alloc(0))];
  const out = Buffer.allocUnsafeSlow(parts.reduce((a, p) => a + p.length, 0));   // (its own memory: it is handed to the caller's thread)
  let at = 0;
  for (const p of parts) { p.copy(out, at); at += p.length; }
  return out;
}

// a kept frame's pixels again, RGB: its rows inflated and their filter undone (Sub, as encodeNow writes them; None)
function pixelsNow(png) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20), idat = [];
  for (let at = 8; at < png.length;) {
    const n = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + n));
    at += 12 + n;
  }
  const rows = zlib.inflateSync(Buffer.concat(idat)), stride = w * 3, out = Buffer.allocUnsafeSlow(stride * h);
  for (let y = 0; y < h; y++) {
    const i = y * (stride + 1), o = y * stride, filter = rows[i];
    if (filter === 0) { rows.copy(out, o, i + 1, i + 1 + stride); continue; }
    if (filter !== 1) throw new Error(`not a kept frame (row filter ${filter})`);
    out[o] = rows[i + 1]; out[o + 1] = rows[i + 2]; out[o + 2] = rows[i + 3];
    for (let x = 3; x < stride; x++) out[o + x] = (rows[i + 1 + x] + out[o + x - 3]) & 255;
  }
  return out;
}

if (!isMainThread) {
  parentPort.on('message', ({ id, op, buf, w, h }) => {
    try {
      const out = op === 'pixels' ? pixelsNow(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)) : encodeNow(buf, w, h);
      parentPort.postMessage({ id, buf: out }, [out.buffer]);
    } catch (e) { parentPort.postMessage({ id, error: String(e.message || e) }); }
  });
}

// the threads: a quarter of the machine, two at least, four at most; started when first needed, ended when idle
const SIZE = Math.max(2, Math.min(4, Math.floor(os.availableParallelism() / 4)));
let pool = null, next = 0, idle = null, ids = 0;
const pending = new Map();
function threads() {
  clearTimeout(idle); idle = setTimeout(() => { if (!pending.size) { pool?.forEach((t) => t.terminate()); pool = null; } }, 30_000);
  if (pool) return pool;
  pool = Array.from({ length: SIZE }, () => {
    const t = new Worker(new URL(import.meta.url));
    t.on('message', ({ id, buf, error }) => { const p = pending.get(id); pending.delete(id); if (!p) return; if (error) p.reject(new Error(error)); else p.resolve(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)); });
    t.on('error', (e) => { for (const [id, p] of pending) { pending.delete(id); p.reject(e); } pool = null; });
    t.unref();
    return t;
  });
  return pool;
}

// (a copy goes to the thread: the caller keeps its own bytes)
function onThread(msg, bytes) {
  const id = ++ids, t = threads()[next++ % SIZE];
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); t.postMessage({ ...msg, id, buf: copy }, [copy.buffer]); });
}
/** A frame's RGBA bytes (w x h) as a PNG to keep. */
export const encode = (rgba, w, h) => onThread({ w, h }, rgba);
/** A kept frame's size, from its header: [w, h]. */
export const sizeOf = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];

/** A kept frame as a JPEG, by ffmpeg: quality 0–1; width: scaled to it. */
export function jpeg(png, quality = 0.9, { width = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const out = [], err = [];
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'png_pipe', '-i', '-', ...(width ? ['-vf', `scale=${width}:-2`] : []),
      '-frames:v', '1', '-q:v', String(Math.round(2 + (1 - quality) * 29)), '-f', 'image2pipe', '-c:v', 'mjpeg', '-']);
    p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: ${Buffer.concat(err).toString().trim()}`))));
    p.stdin.on('error', () => {});
    p.stdin.end(png);
  });
}

// ---------- a kept frame for a viewer on another device (tools/nle.mjs viewerSocket): a JPEG at the viewer's size. On
// a launch film at 960x540, 43–84 KB a frame where the PNG is 490–920 KB (8–17 Mbit/s at 24 frames a second, the PNGs 97–180).
// The PNG is read back to its pixels on one of the threads above, and an ffmpeg kept running for each size (the frame's,
// the JPEG's) makes the JPEG from them in 10–15 ms: fed the PNGs themselves, ffmpeg holds each frame back until two more
// have come, and one started for each frame takes ~130 ms. Each ends when it has had nothing to do for a while.
const encoders = new Map();   // `${from}>${to}@${quality}` → its ffmpeg
function encoder(iw, ih, ow, oh, quality) {
  const key = `${iw}x${ih}>${ow}x${oh}@${quality}`;
  if (encoders.has(key)) return encoders.get(key);
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${iw}x${ih}`, '-i', '-',
    '-vf', `scale=${ow}:${oh}:flags=bicubic`, '-threads', '1', '-c:v', 'mjpeg', '-q:v', String(Math.round(2 + (1 - quality) * 29)), '-f', 'mpjpeg', '-flush_packets', '1', '-']);
  // (each JPEG comes as a part of its own, its length in the part's header: "--ffmpeg\r\n…Content-length: n\r\n\r\n" + n bytes)
  const waiting = [];
  let buf = Buffer.alloc(0), idle = null;
  p.stdout.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (;;) {
      const head = buf.indexOf('\r\n\r\n');
      if (head < 0) break;
      const n = +/Content-length:\s*(\d+)/i.exec(buf.toString('latin1', 0, head))?.[1];
      if (!Number.isFinite(n) || buf.length < head + 4 + n) break;
      const jpg = Buffer.from(buf.subarray(head + 4, head + 4 + n));
      buf = buf.subarray(head + 4 + n);
      waiting.shift()?.resolve(jpg);
    }
  });
  const gone = () => { if (encoders.get(key) === e) encoders.delete(key); };
  const end = (err) => { gone(); clearTimeout(idle); for (const w of waiting.splice(0)) w.reject(err); };
  p.on('error', end);
  p.on('close', () => end(new Error('ffmpeg ended')));
  p.stdin.on('error', () => {});
  const e = {
    encode(rgb) {
      clearTimeout(idle); idle = setTimeout(() => { gone(); p.stdin.end(); }, 30_000);
      return new Promise((resolve, reject) => { waiting.push({ resolve, reject }); p.stdin.write(rgb); });
    },
  };
  encoders.set(key, e);
  return e;
}
/** A kept frame as a JPEG that fits w x h (never larger than the frame): quality 0–1. */
export async function compress(png, w, h, quality = 0.85) {
  const [iw, ih] = sizeOf(png), k = Math.min(1, w / iw, h / ih);
  const ow = Math.max(2, Math.round((iw * k) / 2) * 2), oh = Math.max(2, Math.round((ih * k) / 2) * 2);
  const rgb = await onThread({ op: 'pixels' }, png);
  return encoder(iw, ih, ow, oh, quality).encode(rgb);
}
