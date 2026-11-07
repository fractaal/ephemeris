// Renders a film: headless Chrome workers (WebGPU + HTML-in-Canvas) each take the next two seconds of frames still to
// render, streaming raw RGBA over a WebSocket into that stretch's own ffmpeg chunk; chunks are concatenated with the
// audio. As many workers render as make it faster (worker.mjs, crew: one for a film that is mostly GPU work, more for one
// that is mostly the page's), up to --workers. Frames are pure functions of t, so workers need no shared state.
//
//   node tools/render.mjs --url http://localhost:5302/film.html --out renders/x.mp4 [--from 0] [--to dur]
//        [--fps 60] [--sub 8] [--shutter 0.5] [--workers 8] [--crf 14] [--audio file.wav|timeline.json|auto|none] [--preset slow] [--gop N]
//        [--meta out.json]   (what the probe saw: duration, hard cuts, rendered range, the cues it follows; written last,
//                             so the render is done when it is there)
//        [--share out-share.mp4]   (a copy to send: 10 Mbit/s, two passes, its grain kept; from the same frames)
//   node tools/render.mjs --url ... --stills 0,2.5,6.4 --dir /tmp/stills [--sub 1] [--look accurate|fast|solid|wire]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { mixTimeline } from './mix.mjs';
import { openWorker as open, crew, workerCount } from './worker.mjs';
import { fileURLToPath } from 'node:url';
import { rendererVersion } from './browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const ENGINE = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.dirname(fileURLToPath(import.meta.url)), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } })();
const URL = args.url;
const FPS = +(args.fps || 60), SUB = +(args.sub || 8), SHUTTER = +(args.shutter || 0.5), WORKERS = +(args.workers || 8), LOOK = args.look || 'accurate';   // (look: the studio's preview's, see LOOKS in engine/render/index.js)
const STILLS = args.stills ? args.stills.split(',').map(Number) : null;

// (alone: a film that fails to start ends the render; beside others already rendering it, see worker() below)
async function openWorker(k, alone = true) {
  const w = await open(URL, k).catch((e) => { if (!alone) throw e; console.log(`[w${k}] ${e.boot ? `boot failed: ${e.boot}` : e.message}`); process.exit(1); });
  return { meta: w.meta, frame: async (t) => (await w.frame(t, { sub: SUB, shutter: SHUTTER, fps: FPS, look: LOOK })).data, close: w.close };
}

const t0 = Date.now();
if (STILLS) {
  const dir = args.dir || 'renders/stills';
  fs.mkdirSync(dir, { recursive: true });
  const w = await openWorker(0);
  for (const t of STILLS) {
    const buf = await w.frame(t);
    const png = path.join(dir, `f${t.toFixed(2).padStart(6, '0')}.png`), [W, H] = w.meta.size;
    await new Promise((r) => { const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', '-', '-frames:v', '1', png]); p.on('close', r); p.stdin.end(buf); });
  }
  await w.close();
  console.log(`stills → ${dir} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else {
  const OUT = args.out;
  const tmp = fs.mkdtempSync(path.join(path.dirname(path.resolve(OUT)), '.render-'));
  // a cancelled render (the NLE's Cancel, or ctrl-c) leaves no chunks behind; exiting also closes the workers
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(130); });
  const probe = await openWorker('p');
  const duration = probe.meta.duration, [W, H] = probe.meta.size;   // (the film's frame: its timeline's size)
  await probe.close();
  // --audio auto: the film's own soundtrack (film.audio), fetched from its dev server
  if (args.audio === 'auto') {
    args.audio = 'none';
    if (probe.meta.audio) { const f = path.join(tmp, 'audio'); fs.writeFileSync(f, Buffer.from(await (await fetch(probe.meta.audio)).arrayBuffer())); args.audio = f; }
  }
  // --audio timeline.json: mixed by the NLE's own mixer, so the render sounds like the editor
  // a timeline's own mix; a timeline with no music yet renders without an audio track
  if (args.audio?.endsWith('.json')) { const f = path.join(tmp, 'mix.wav'); args.audio = (await mixTimeline(args.audio, f)).duration > 0 ? f : 'none'; }
  const from = +(args.from || 0), to = +(args.to || duration);
  const f0 = Math.round(from * FPS), f1 = Math.round(to * FPS);
  const count = workerCount();
  console.log(`${f1 - f0} frames @${FPS} × sub ${SUB} on ${count === 'dynamic' ? `up to ${WORKERS}` : count} workers`);
  // two seconds of frames at a time, in order, each into its own chunk; a stretch whose worker ran out of GPU memory
  // goes back to be rendered again
  const SPAN = Math.max(1, Math.round(FPS * 2)), stretches = [], files = [], again = [];
  for (let a = f0; a < f1; a += SPAN) stretches.push([a, Math.min(f1, a + SPAN)]);
  let next = 0, running = 0, made = 0;
  const live = new Set(), team = crew(WORKERS, () => start());
  const stretch = async (w, k, i) => {
    const [a, b] = stretches[i], file = path.join(tmp, `c${String(i).padStart(5, '0')}.mkv`);
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '4', '-pix_fmt', 'yuv444p', file], { stdio: ['pipe', 'inherit', 'inherit'] });
    try {
      for (let f = a; f < b; f++) {
        const buf = await w.frame(f / FPS);
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
        team.done(k);
        if (++made % 30 === 0) process.stdout.write(`\r ${made}/${f1 - f0} frames, ${team.n} worker${team.n > 1 ? 's' : ''}  ${((Date.now() - t0) / 1000).toFixed(0)}s `);
      }
    } catch (e) { ff.kill(); throw e; }
    ff.stdin.end(); await new Promise((r) => ff.on('close', r));
    files[i] = file;
  };
  const worker = async (k) => {
    running++;
    let w = null;
    try {
      // one that fails to start beside others rendering the same film: the machine has no room for another (the GPU
      // refused it), not a film that fails, so those render on
      try { w = await openWorker(k, running === 1); } catch (e) {
        team.full();
        console.log(`\n[w${k}] did not start (${String(e.message).slice(0, 120)}); rendering with ${team.n} worker${team.n > 1 ? 's' : ''}`);
        return;
      }
      for (;;) {
        if (running > team.n) break;   // (more are running than make it faster)
        const i = again.length ? again.shift() : next < stretches.length ? next++ : null;
        if (i == null) break;
        try { await stretch(w, k, i); } catch (e) {
          if (!/OUT_OF_DEVICE_MEMORY|out of memory/i.test(String(e.message)) || team.n === 1) throw e;
          again.push(i); team.full();
          console.log(`\nGPU memory is full; rendering with ${team.n} worker${team.n > 1 ? 's' : ''}`);
          break;
        }
      }
    } finally { running--; await w?.close(); start(); }
  };
  function start() {
    for (let k = running; k < team.n && (again.length || next < stretches.length); k++) { const p = worker(k); live.add(p); p.then(() => live.delete(p), () => live.delete(p)); }
  }
  start();
  while (live.size) await Promise.all([...live]);
  fs.writeFileSync(path.join(tmp, 'list.txt'), files.map((f) => `file '${f}'`).join('\n'));
  const audio = args.audio && args.audio !== 'none' && fs.existsSync(args.audio) ? ['-ss', String(from), '-t', String(to - from), '-i', args.audio] : [];
  // each file is encoded beside the chunks and moved into place whole: one that is there is done
  const ffmpeg = (a) => new Promise((resolve, reject) => spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), ...a], { stdio: 'inherit' })
    .on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (exit ${code})`)))));
  // apad: a short soundtrack ends in silence, never cuts the film; -t: a long one ends with it (-shortest overshoots by
  // a second or more in some ffmpeg versions: 7.0)
  const withAudio = (kbps) => ['-map', '0:v', ...(audio.length ? ['-map', '1:a', '-af', 'apad', '-c:a', 'aac', '-b:a', `${kbps}k`, '-t', String((f1 - f0) / FPS)] : [])];
  try {
    const out = path.join(tmp, 'out.mp4');
    await ffmpeg([...audio, ...withAudio(320), '-c:v', 'libx264', '-preset', args.preset || 'slow', '-crf', args.crf || '14', ...(args.gop ? ['-g', args.gop] : []), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
    fs.renameSync(out, OUT);
    // the copy to send: an average bitrate, so its size follows its length (10 Mbit/s: 75 MB a minute), in two passes;
    // tuned for grain, which a smaller encode otherwise smears into blotches (and which costs a clean film nothing)
    if (args.share) {
      const x264 = ['-c:v', 'libx264', '-preset', 'slow', '-tune', 'grain', '-b:v', '10M', '-maxrate', '15M', '-bufsize', '20M', '-pix_fmt', 'yuv420p', '-passlogfile', path.join(tmp, 'share')];
      await ffmpeg(['-map', '0:v', ...x264, '-pass', '1', '-an', '-f', 'mp4', process.platform === 'win32' ? 'NUL' : '/dev/null']);
      const share = path.join(tmp, 'share.mp4');
      await ffmpeg([...audio, ...withAudio(192), ...x264, '-pass', '2', '-movflags', '+faststart', share]);
      fs.renameSync(share, args.share);
    }
  } catch (e) { console.log(`\n${e.message}`); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); }
  fs.rmSync(tmp, { recursive: true, force: true });
  // the sidecar records what was rendered, and with which Ephemeris (so a film can be reproduced, or knowingly upgraded)
  if (args.meta) fs.writeFileSync(args.meta, JSON.stringify({ url: URL, fps: FPS, shutter: SHUTTER, from, to, duration, cuts: probe.meta.cuts ?? [], cues: probe.meta.cues ?? [], ephemeris: ENGINE, renderer: rendererVersion(), ...(args.share ? { share: path.basename(args.share) } : {}) }));
  const mb = (f) => `${(fs.statSync(f).size / 1e6).toFixed(0)} MB`;
  console.log(`\nwrote ${OUT} (${mb(OUT)})${args.share ? ` and ${args.share} (${mb(args.share)}, to send)` : ''} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
