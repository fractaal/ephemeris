// One render worker: a hidden page in its own pinned Electron, rendering frames on request. Frames come back over a
// WebSocket, { data, w, h }: raw RGBA (to keep, or to encode a video), or a JPEG (jpeg: its quality, 0–1: a frame the
// editor shows once); or, for the studio's own window (memory), { file, w, h }: the socket says only where the frame is
// (app/framefile.cjs). Used by render.mjs and by the NLE's preview (preview.mjs).
import { WebSocketServer } from 'ws';
import { openBrowser } from './browser.mjs';
import { config, configure } from './workspace.mjs';
import framefile from '../app/framefile.cjs';

// (the page's window: layers are captured at their own sizes and the frame is drawn off screen, so it is not the film's
// frame, which the film reports: meta.size)
const VIEW = { width: 1920, height: 1080 };
const UNLOADED = 'its code did not load';

// why the film server refused a script, as it says (Vite's error page: the message, and the lines where it is), or its
// status
async function whyRefused(url) {
  const res = await fetch(url).catch(() => null), at = new URL(url).pathname.slice(1);
  const e = await res?.text().then((s) => JSON.parse(/const error = (\{.*\})\s*$/m.exec(s)?.[1] ?? 'null'), () => null);
  return e?.message ? `${at}${e.loc?.line ? `:${e.loc.line}` : ''}: ${e.message}${e.frame ? `\n${e.frame}` : ''}` : `${at}: ${res ? `${res.status} ${res.statusText}` : 'not there'}`;
}

/** Opens the film at `url` and waits for it to boot; a film that fails to start throws its error. */
export async function openWorker(url, label = '', onCompiling = null) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 64 * 1024 * 1024 });
  await new Promise((r) => wss.once('listening', r));
  // (the page's frames, as they come: a frame's pixels; or, before a frame so far, what it is: text)
  let queue = [], waiter = null;
  // (or what its shaders are doing, as it changes, whenever: engine/render/compiling.js)
  wss.on('connection', (s) => s.on('message', (m, binary) => { const x = binary ? m : String(m); if (!binary && x.startsWith('{"compiling"')) { onCompiling?.(JSON.parse(x).compiling); return; } if (waiter) { const w = waiter; waiter = null; w(x); } else queue.push(x); }));
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => { waiter = r; }));
  // the frame `drawing` (page.evaluate's) sends, { data: its pixels } or { file: where they are }, and before it each frame
  // so far it sends, given to progress({ done, sub, w, h, data | file }) as it comes; an error drawing it is thrown
  async function pixels(drawing, progress) {
    const failed = drawing.then(() => new Promise(() => {}));
    for (;;) {
      const m = await Promise.race([next(), failed]);
      if (typeof m !== 'string') return { data: Buffer.from(m) };
      const head = JSON.parse(m);
      if (head.file && head.done == null) return { file: head.file };
      progress?.(head.file ? head : { ...head, data: Buffer.from(await next()) });
    }
  }
  let br = await openBrowser().catch((e) => { wss.close(); throw e; });
  const close = async () => { onCompiling?.(null); await br.close().catch(() => {}); wss.close(); };
  // (files: every URL of the film's server its page asked for since it loaded, these files or not: what its film is
  // made of, for the studio to tell a change to the film from one to a file beside it)
  let page, meta, files = new Set();
  // the film loads into a new page each time: a page navigated again keeps state that draws some text and images a
  // level or two differently, so its frames would not match a fresh worker's
  const load = async () => {
    await page?.close().catch(() => {});
    onCompiling?.(null);
    queue = []; waiter = null;
    // (a browser whose GPU caches were cleared is closed and a new one opened: browser.mjs clearGpuCaches)
    if (br.stale) { await br.close().catch(() => {}); br = await openBrowser(); }
    page = await br.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
    // a module of its code that does not load (one the film server cannot parse, a file not there) means the film never
    // runs, and the page throws nothing: only its script element has an error event. Its boot fails with what the
    // server said of each script it refused
    const refused = [], served = new URL(url).origin, asked = (files = new Set());
    page.on('request', (r) => { const u = new URL(r.url()); if (u.origin === served) { try { asked.add(decodeURIComponent(u.pathname)); } catch { asked.add(u.pathname); } } });
    page.on('response', (r) => { if (r.status() >= 400 && r.request().resourceType() === 'script') refused.push(r.url()); });
    await page.addInitScript((said) => addEventListener('error', (e) => { if (e.target instanceof HTMLScriptElement) window.__bootError ??= said; }, true), UNLOADED);
    // an error before the film is ready means it will never be (a syntax error in its code, say): its boot fails with it
    let failBoot = null, early = null;
    page.on('pageerror', (e) => { console.log(`[w${label}] pageerror`, e.message.slice(0, 300)); if (failBoot) failBoot(e); else early ??= e; });
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/favicon|Failed to load resource|GL Driver/.test(m.text())) console.log(`[w${label}]`, m.text().slice(0, 300)); });
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}ws=${wss.address().port}`, { waitUntil: 'load' });
    const failed = new Promise((_, reject) => { failBoot = (e) => reject(Object.assign(new Error(`the film failed to start: ${e.message}`), { boot: String(e.stack || e.message) })); });
    failed.catch(() => {});   // (the race below reports it; an error after the race is settled has nowhere to go)
    if (early) failBoot(early);
    try { await Promise.race([page.waitForFunction(() => window.__ready === true || window.__bootError, null, { timeout: 180_000 }), failed]); } finally { failBoot = null; }
    let bootError = await page.evaluate(() => window.__bootError);
    if (bootError === UNLOADED && refused.length) bootError = (await Promise.all(refused.map(whyRefused))).join('\n\n');
    if (bootError) throw Object.assign(new Error(`the film failed to start: ${bootError}`), { boot: bootError });
    return (meta = await page.evaluate(() => ({ duration: window.__duration, audio: window.__audio, cuts: window.__cuts, cues: window.__cueRefs, parts: window.__partRefs, size: window.__size, shaders: window.__shaders })));
  };
  try { await load(); } catch (e) { await close(); throw e; }
  return {
    get meta() { return meta; },
    /** The paths of the film's server its page has asked for since it loaded (see load). */
    get files() { return files; },
    /** Whether this worker's browser has made ready every shader of `key` (warm), so a page of it draws without compiling. */
    warmed: (key) => br.warmed(key),
    /** This worker's browser has made ready every shader of `key`. */
    madeReady: (key) => br.madeReady(key),
    /** The frame at t: { data, w, h }, RGBA or a JPEG (scale: of the frame's size; draft: the timeline's overrides as
     *  the editor has them, for this frame only; profile: and what drawing it took, engine/render/profile.js; progress:
     *  shown while it is drawn, progress({ done, sub, w, h, data: a JPEG }) given the frame so far now and then; memory:
     *  for the studio's own window, { file, w, h } in place of its data, where the page can). */
    async frame(t, { sub = 8, shutter = 0.5, fps = 60, scale = 1, draft = undefined, look = 'accurate', jpeg = 0, profile = false, progress = null, memory = false } = {}) {
      // A whole frame to keep comes by its file too, taken here: 8 MB over the sockets took 42 ms of CPU and 35 of waiting,
      // by file about 18 and 16 (a reel, 100 frames in 4.1 s where they took 5.9). (A frame shown as it is drawn sends
      // JPEGs, which stay on the socket.)
      const byFile = !memory && !jpeg && !progress;
      const drawing = page.evaluate(([t, s, sh, f, sc, d, l, q, p, g, m]) => window.__frame(t, s, sh, f, sc, d ?? undefined, l, q, p, g, m), [t, sub, shutter, fps, scale, draft ?? null, look, jpeg, profile, !!progress, memory || byFile]);
      const got = await pixels(drawing, progress), [w, h, took] = await drawing;
      return { ...(byFile && got.file ? { data: await framefile.take(got.file, w * h * 4) } : got), w, h, ...(took && { profile: took }) };
    },
    /** The frame at t drawn on past its own sub-frames, n in all (the editor's viewer converging on it), for about
     *  `budget` ms more: { data: the frame so far, a JPEG, w, h, done, sub }; again with the same key, from where it left
     *  off (see runtime.js __converge). (camera: the director's view's, its frame at rest.) */
    async converge(key, t, n, { shutter = 0.5, fps = 60, scale = 1, draft = undefined, look = 'accurate', budget = 150, camera = null, memory = false } = {}) {
      const drawing = page.evaluate(([k, t, n, sh, f, sc, d, l, b, c, m]) => window.__converge(k, t, n, sh, f, sc, d ?? undefined, l, 0.85, b, c, m), [key, t, n, shutter, fps, scale, draft ?? null, look, budget, camera, memory]);
      const got = await pixels(drawing), [w, h, step] = await drawing;
      return { ...got, w, h, ...step };
    },
    /** The shaders of every moment of the film made ready, as this page will draw them (see runtime.js __warm): { moments, ms }. */
    warm: (fps, look = 'accurate') => page.evaluate(([f, l]) => window.__warm(f, l), [fps, look]),
    /** The timeline's overrides, edited: the film takes them in without loading again. */
    overrides: (list) => page.evaluate((l) => window.__overrides(l), list),
    /** The scene at t from another camera than the film's (the director's view), as frame() gives it (scale: of the
     *  frame's size; live: playing, so drawn at once with the layers as last captured while the page catches up). */
    async director(t, camera, scale = 1, live = false, draft = undefined, look = 'accurate', jpeg = 0, profile = false, memory = false) {
      const drawing = page.evaluate(([t, c, s, l, d, k, q, p, m]) => window.__director(t, c, s, l, d ?? undefined, k, q, p, m), [t, camera, scale, live, draft ?? null, look, jpeg, profile, memory]);
      const got = await pixels(drawing), [w, h, took] = await drawing;
      return { ...got, w, h, ...(took && { profile: took }) };
    },
    /** The film's camera at each of `times` (see runtime.js). */
    cameraPath: (times, draft) => page.evaluate(([ts, d]) => window.__cameraPath(ts, d ?? undefined), [times, draft ?? null]),
    /** What is under frame point (x, y) at t, seen by `camera` (the director's) or the film's (null), and where the
     *  film's code placed it (see runtime.js); and that thing again at another moment or from another camera. */
    pick: (t, camera, x, y) => page.evaluate(([t, c, x, y]) => window.__pick(t, c, x, y), [t, camera, x, y]),
    locate: (t, camera, at, nth, sel, draft) => page.evaluate(([t, c, a, n, k, d]) => window.__locate(t, c, a, n, k, d ?? undefined), [t, camera, at, nth, sel, draft ?? null]),
    /** A thing's properties (or the camera's: sel { camera: true }; the scene's: { scene: true }) with the code's stacks they came from, at t; and the
     *  code's own values of `ks` at each of `times` (see runtime.js). */
    stacks: (t, sel) => page.evaluate(([t, s]) => window.__stacks(t, s), [t, sel]),
    /** The scene's own lights at t as the editor marks them (seen by `camera`, or the film's: null; see runtime.js). */
    lights: (t, camera) => page.evaluate(([t, c]) => window.__lights(t, c), [t, camera]),
    passes: (t) => page.evaluate((t) => window.__passes(t), t),
    /** What the editor draws over its picture of each of `times`: the film's camera, the lights, the selection (see
     *  runtime.js). */
    overlays: (times, sel, draft, camera, also) => page.evaluate(([ts, s, d, c, a]) => window.__overlays(ts, s, d ?? undefined, c, a), [times, sel ?? null, draft ?? null, camera ?? null, also ?? []]),
    /** How the film moves on screen over a span (see runtime.js, __track). */
    track: (from, to, fps, things) => page.evaluate(([a, b, f, x]) => window.__track(a, b, f, x), [from, to, fps, things]),
    samples: (sel, ks, times) => page.evaluate(([s, k, ts]) => window.__samples(s, k, ts), [sel, ks, times]),
    /** What gives each of a thing's properties (or the camera's) at every frame and cut of the film, of each of `sels`
     *  (see runtime.js). */
    lanes: (sels, o, draft) => page.evaluate(([s, x, d]) => window.__lanes(s, x, d ?? undefined), [sels, o, draft ?? null]),
    /** The film's objects over its whole length, as the editor lists them (see runtime.js). */
    objects: (o) => page.evaluate((x) => window.__objects(x), o),
    /** Loads the film afresh (its code or timeline changed) and returns what it now reports. */
    reload: load,
    close,
  };
}

/** How many workers render on this machine, as set in the studio (the viewer's header; config.json): 'dynamic' (as many
 *  as make rendering faster, see crew) or that many. */
export function workerCount() { const w = config().workers; return Number.isInteger(w) && w > 0 ? w : 'dynamic'; }
/** Sets it: 'dynamic', or a number of workers (1 to 16). */
export function setWorkerCount(w) {
  configure({ workers: w === 'dynamic' ? 'dynamic' : Math.max(1, Math.min(16, Math.round(+w) || 1)) });
  return workerCount();
}

/**
 * How many workers to keep rendering: as many as this machine's setting says (workerCount), or, dynamic, as many as
 * raise the frames rendered a second. Dynamic starts with one, adds another while the one last added made the workers
 * together at least 15% faster, and gives that one back when it did not. Either way one fewer, and no more after, when
 * the GPU runs out of memory: in the runs that follow too (each measures again from one), until the setting changes, as
 * growing into it again after each edit ran the GPU out of memory again and again, stalling the editor's own film with
 * it. Measured rather than guessed from the machine, so it suits any machine and film: a film
 * whose frames are mostly GPU work (ray tracing, depth of field) settles at one or two (more only queue up on the GPU,
 * and the desktop waits behind them all), one whose frames are mostly the page's own work (capturing the DOM) at as
 * many as keep helping.
 * Dynamic adds one only where the GPU has room for it (room(), its owner's measure of free GPU memory), so that it does
 * not find the GPU's limit by running out of memory, the editor's own film stalling with it.
 *   const team = crew(max, () => startMore(), () => roomForOneMore); team.n: how many now; team.done(k) after worker
 *   k's frame; a worker stops when more are running than team.n; team.full() when one ran out of GPU memory;
 *   team.reset() when a new run starts; team.rechoose() when the setting changed; team.remeasure() when its workers
 *   draw again after some waited
 */
export function crew(max, grow = () => {}, room = () => true) {
  let n = 1, cap = max, roof = Infinity, base = null, held = false, watch = 0, t0 = 0, count = 0;   // (roof: as many as the GPU had room for)
  // after a change, its measure starts with the newest worker's first frame (a worker takes seconds to start); after the
  // setting changed, with any worker's next frame (those running on are any of them: watch -1)
  const set = (m) => { n = m; watch = m - 1; t0 = 0; count = 0; };
  const team = {
    get n() { return n; },
    reset() { const c = workerCount(); cap = Math.min(c === 'dynamic' ? max : c, roof); base = null; held = c !== 'dynamic'; set(held ? cap : 1); },
    // (more start now; those over it stop after their frame)
    rechoose() { roof = Infinity; team.reset(); watch = -1; grow(); },
    done(k) {
      if (held) return;
      const now = Date.now();
      if (!t0) { if (k === watch || watch < 0) { t0 = now; count = 0; } return; }
      count++;
      // long enough to tell: a few seconds, and a couple of frames from each worker
      if (now - t0 < 3000 || count < 2 * n + 2) return;
      const rate = count / (now - t0);
      if (base == null || rate >= base * 1.15) {
        base = rate;
        if (n < cap && room()) { set(n + 1); grow(); } else held = true;
      } else { set(n - 1); held = true; }
    },
    full() { cap = roof = Math.max(1, n - 1); set(cap); held = true; },
    // (after a while its workers were not all drawing: measured again from any worker's next frame)
    remeasure() { t0 = 0; count = 0; watch = -1; },
  };
  team.reset();
  return team;
}
