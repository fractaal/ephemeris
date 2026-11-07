// A project's media (its sounds, pictures and videos: in assets/, or media/ in a project from before assets/ held them),
// each named by its path in the project (src: assets/sfx/whoosh.wav): what it is (audio, an image, a video) and its
// size, length and frame rate, as ffprobe reads them; and a video's frames, each its own picture, so the film can show
// the exact frame for any moment (a <video> seeks only near one): decoded once by ffmpeg into renders/<src>/ (not in a
// version: made again from the video where it is missing). What a file is, is kept too (renders/probe.json), by its
// size and time, so the assets panel lists a folder without probing it again.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i, VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi)$/i, AUDIO = /\.(wav|mp3|m4a|aac|ogg|oga|flac|aiff?|opus)$/i;
/** What a file is, by its name: 'image', 'video', 'audio' or null. */
export const kindOf = (name) => (IMAGE.test(name) ? 'image' : VIDEO.test(name) ? 'video' : AUDIO.test(name) ? 'audio' : null);
const LONGEST = 1920;   // (a video's frames are decoded no larger: the film's frame)

const probeFile = (dir) => path.join(dir, 'renders', 'probe.json');
/** Where a video's frames are, relative to the project: renders/<src>/000001.jpg… */
export const framesOf = (src) => `renders/${src}`;
/** The folders a project's media are in: assets/, and media/ (a project's from before). */
export const MEDIA_DIRS = ['assets', 'media'];

function ffprobe(file) {
  return new Promise((resolve) => execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', file], (e, out) => {
    if (e) return resolve(null);
    try { resolve(JSON.parse(out)); } catch { resolve(null); }
  }));
}

/** What the file at src (its path in the project) is: { name (its file's), src, kind, bytes, w, h (an image's or video's
 *  frames'), duration (audio, video), fps and sound (video: whether it has any), frames (a video's: framesOf) }. */
export async function probe(dir, src, cache = null) {
  const file = path.join(dir, src), st = fs.statSync(file), kind = kindOf(src);
  const key = `${st.size}:${Math.round(st.mtimeMs)}:2`;   // (:2 — what a video says of its sound, since)
  if (cache?.[src]?.key === key) return cache[src].info;
  const info = { name: path.basename(src), src, kind, bytes: st.size };
  const p = kind ? await ffprobe(file) : null;
  const v = p?.streams?.find((s) => s.codec_type === 'video');
  if (v && kind !== 'audio') {
    const k = kind === 'video' ? Math.min(1, LONGEST / Math.max(v.width, v.height)) : 1;
    info.w = Math.round(v.width * k / 2) * 2 || v.width; info.h = Math.round(v.height * k / 2) * 2 || v.height;
  }
  if (kind === 'video' && v) { const [a, b] = String(v.r_frame_rate).split('/').map(Number); info.fps = b ? a / b : a || 30; info.sound = !!p.streams.some((s) => s.codec_type === 'audio'); }
  if (kind !== 'image' && p?.format?.duration) info.duration = +p.format.duration;
  if (kind === 'video') info.frames = framesOf(src);
  if (cache) cache[src] = { key, info };
  return info;
}
/** What each file of srcs is (probe), several probed at once, those probed before as they were kept. */
export async function probeAll(dir, srcs) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(probeFile(dir), 'utf8')); } catch { /* none yet */ }
  const out = new Array(srcs.length), had = JSON.stringify(cache);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (next < srcs.length) { const i = next++; out[i] = await probe(dir, srcs[i], cache).catch(() => null); } }));
  const now = JSON.stringify(cache);
  if (now !== had) try { fs.mkdirSync(path.dirname(probeFile(dir)), { recursive: true }); fs.writeFileSync(probeFile(dir), now); } catch { /* kept next time */ }
  return out;
}

/** Every sound, picture and video in the project's assets/ and media/ and their folders, as probe() says (newest first). */
export async function list(dir) {
  const srcs = [];
  for (const top of MEDIA_DIRS) (function walk(rel) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r); else if (e.isFile() && kindOf(e.name)) srcs.push(r);
    }
  })(top);
  const infos = (await probeAll(dir, srcs)).map((x, i) => x && { ...x, made: fs.statSync(path.join(dir, srcs[i])).mtimeMs }).filter(Boolean);
  return infos.sort((a, b) => b.made - a.made);
}

const decoding = new Map();   // video file → its decode under way
/**
 * A video's frames, decoded where they are missing (done again only if the video changed since): resolves true once it
 * has decoded them (the film's frames that show it are then to render again), false if they were there already or
 * cannot be. Each frame a JPEG at the video's own rate, no larger than the film's frame.
 */
export function ensureFrames(dir, info) {
  const out = path.join(dir, framesOf(info.src)), file = path.join(dir, info.src), mark = path.join(out, 'done.json');
  const st = fs.statSync(file), key = `${st.size}:${Math.round(st.mtimeMs)}`;
  try { if (JSON.parse(fs.readFileSync(mark, 'utf8')).key === key) return Promise.resolve(false); } catch { /* not yet */ }
  if (decoding.has(file)) return decoding.get(file);
  const job = new Promise((resolve) => {
    fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-fps_mode', 'passthrough', '-vf', `scale=${info.w}:${info.h}`, '-q:v', '3', path.join(out, '%06d.jpg')]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      decoding.delete(file);
      if (code !== 0) { console.log(`media: could not decode ${info.src}: ${err.trim().slice(0, 200)}`); return resolve(false); }
      const count = fs.readdirSync(out).filter((f) => f.endsWith('.jpg')).length;
      fs.writeFileSync(mark, JSON.stringify({ key, count }));
      console.log(`media: ${info.src}: ${count} frames`);
      resolve(true);
    });
  });
  decoding.set(file, job);
  return job;
}
