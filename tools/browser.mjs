// The studio's rendering browser is its pinned Electron, on every platform. A packaged tool is already running in
// that executable as Node; a checkout uses its electron dependency. No second browser is downloaded or installed.
// Each openBrowser keeps its own process and profile, separate from the editor and from other render workers, and drives
// it over a Node IPC channel (app/renderer.cjs): no debugging protocol, no automation library.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const rendererVersion = () => `Electron ${process.versions.electron ?? require('electron/package.json').version}`;
const SHADERS = path.join(os.homedir(), '.cache', 'ephemeris', 'shaders');
// What a browser drawing films needs: HTML-in-Canvas, WebGPU's features as a render worker has them (the ray tracing of
// an Electron built with experiments/native-renderer/dawn-rays' patches among them), and, in such an Electron, compiled
// shaders in one folder all its browsers share, so a new browser's first frame takes about 0.7 s rather than 12 to 24 s,
// in any profile (stock Electron ignores the folder and keeps them per profile, below). The switches the editor's own
// window has too, for its own WebGPU (app/main.mjs).
export const FILM_FEATURES = ['CanvasDrawElement'];
export const FILM_SWITCHES = [['enable-unsafe-webgpu'], ['gpu-shared-shader-cache', SHADERS]];
const FLAGS = [
  `--enable-features=${[...FILM_FEATURES, 'WebGPU', ...(process.platform === 'linux' ? ['Vulkan'] : [])].join(',')}`,
  ...FILM_SWITCHES.map(([k, v]) => (v ? `--${k}=${v}` : `--${k}`)),
  '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb',
  '--force-device-scale-factor=1', '--disable-lcd-text', '--font-render-hinting=none',
  // A heavy film's first frame can hold the GPU for tens of seconds (its pipelines compiling); the watchdog would kill
  // the GPU process mid-frame and every page's WebGPU with it ("A valid external Instance reference no longer exists").
  '--disable-gpu-watchdog',
  // A film makes its copies anew each moment, tens of thousands of objects that die young, and the room for them is memory
  // its renderer holds: over 100 frames of spring-brutalist, 16 MB a side averages 270 MB and peaks at 336, where 64 MB takes
  // 350 and 485, with frames within 3% of each other. V8's helper threads pay for it off the film's thread, 0.11 to 0.21
  // cores. 32 MB costs about the same and saves no more; 8 MB and V8's own default save no more either.
  // (--enable-low-end-device-mode saves far more on a film of big pictures, 1150 to 729 MB, but caps a film's JS at 304 MB,
  // past which its page crashes, and decodes full-size pictures on a live layer again each frame: ten of them, 92 to 325 ms.)
  '--js-flags=--min-semi-space-size=16 --max-semi-space-size=16',
  ...(process.platform === 'linux' ? ['--ozone-platform=headless', '--use-angle=vulkan', '--use-webgpu-adapter=vulkan'] : []),
];

// The viewport's render process (app/viewport.cjs: the editor's own film, in a browser of its own) draws as a render worker
// does, but in the display's own Ozone (headless Ozone cannot take an image another process made), its frames written
// into images it shares with the editor's window (app/frames.cjs: our Electron's patches, experiments/native-renderer/
// zero-copy: WebGPU on imported DMA-BUFs, and those imports for WebGPU alone).
export const VIEWPORT_FLAGS = [
  `--enable-features=${[...FILM_FEATURES, 'WebGPU', 'EphemerisWebGPUNativePixmap'].join(',')}`,
  ...FILM_SWITCHES.map(([k, v]) => (v ? `--${k}=${v}` : `--${k}`)),
  '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb',
  '--force-device-scale-factor=1', '--disable-lcd-text', '--font-render-hinting=none', '--disable-gpu-watchdog',
  '--js-flags=--min-semi-space-size=16 --max-semi-space-size=16', '--shared-texture-webgpu',
];

// Each browser's profile is one of a pool kept beside the studio's other caches, each used by one browser at a time (a
// profile's caches are not safe to share between processes): the WebGPU pipelines it compiled are kept there, so a new
// browser's first frame takes about half a second rather than the 15 s or so of compiling them all again. A profile is
// taken by writing its `owner` file (the process's pid); one whose owner has ended is free again. So each profile
// compiles for itself: on doctor-who a second browser beside the first, a second page in the same browser (which also
// froze the other pages while a page compiled) and a new profile given a copy of the first's caches took as long as the
// first did, nothing having reached its disk after 2.5 minutes (after 5.5, its own next first frame took 0.8 s).
const PROFILES = path.join(os.homedir(), '.cache', 'ephemeris', 'renderers');
// The sets of shaders each profile's browsers have made ready (worker.mjs warmed: a page's fingerprint, the studio's
// added), one file a profile: its GPU caches hold them, so a page of one draws without compiling. Cleared with the
// caches.
const WARMED = path.join(os.homedir(), '.cache', 'ephemeris', 'warmed'), KEPT = 64;
const warmedOf = (profile) => { try { return JSON.parse(fs.readFileSync(path.join(WARMED, path.basename(profile)), 'utf8')); } catch { return []; } };
const held = new Set();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function takeProfile() {
  for (let i = 0; ; i++) {
    const dir = path.join(PROFILES, String(i)), owner = path.join(dir, 'owner');
    if (held.has(dir)) continue;
    fs.mkdirSync(dir, { recursive: true });
    try { fs.writeFileSync(owner, String(process.pid), { flag: 'wx' }); held.add(dir); return dir; } catch { /* taken */ }
    const pid = Number(fs.readFileSync(owner, 'utf8'));
    if (pid && (pid === process.pid || !alive(pid))) { fs.rmSync(owner, { force: true }); i--; }   // (left by a studio that ended)
  }
}
// (this process's profiles whose caches go when their browser closes: clearGpuCaches)
const stale = new Set();
function giveBack(dir) {
  if (stale.delete(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  else fs.rmSync(path.join(dir, 'owner'), { force: true });
  held.delete(dir);
}
/** Clears the GPU caches the render browsers keep: a profile no browser holds goes now (one another studio's browser
 *  holds is left to it); one this process's browser holds, when that browser closes (stale: a worker loading its page
 *  again opens a new browser rather than keep it). */
export function clearGpuCaches() {
  for (const n of fs.existsSync(PROFILES) ? fs.readdirSync(PROFILES) : []) {
    const dir = path.join(PROFILES, n);
    if (held.has(dir)) { stale.add(dir); continue; }
    let pid = 0;
    try { pid = Number(fs.readFileSync(path.join(dir, 'owner'), 'utf8')); } catch { /* free */ }
    if (pid && pid !== process.pid && alive(pid)) continue;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  fs.rmSync(SHADERS, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(SHADERS, { recursive: true });
  fs.rmSync(WARMED, { recursive: true, force: true, maxRetries: 3 });
}
// what a page's partition keeps that it is given fresh: all but the GPU's caches (Electron's 'shadercache')
const FRESH = ['cookies', 'filesystem', 'indexdb', 'localstorage', 'websql', 'serviceworkers', 'cachestorage'];

/** The processes of the rendering browsers open now (their main ones). */
export const renderBrowsers = new Set();
// (a page's typed arrays and buffers as app/renderer.cjs packs them for JSON, back as they were)
const unpack = (v) => {
  if (Array.isArray(v)) return v.map(unpack);
  if (v && typeof v === 'object') {
    if (v.__bytes) { const b = Buffer.from(v.b64, 'base64'); if (v.__bytes === 'ArrayBuffer' || v.__bytes === 'Buffer') return v.__bytes === 'Buffer' ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.length); const T = globalThis[v.__bytes]; return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x)]));
  }
  return v;
};
// (a function of the page's and its argument as the code that calls it there; JSON carries the argument, as Playwright's did)
const callOf = (fn, arg) => (typeof fn === 'function' ? `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})` : String(fn));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A rendering browser, our Electron (app/renderer.cjs) started with `flags` (the film's: FLAGS): newPage({ viewport,
 * preload, transparent }) and close(). Its pages: goto(url), setContent(html), evaluate(fn, arg), waitForFunction(fn,
 * arg, { timeout }), addInitScript(fn, arg) (before the page's code, on each load), setViewportSize({ width, height }),
 * screenshot({ path, clip, omitBackground }), on('console' | 'pageerror' | 'request' | 'response' | 'crash', fn) and
 * close(): what the studio's tools ask of a page, as they asked it of Playwright's.
 */
export async function openBrowser({ flags = FLAGS } = {}) {
  const profile = takeProfile();
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  // (the script is the entry point for a checkout's Electron; the packaged app routes --renderer to the same script)
  const exe = process.versions.electron ? process.execPath : require('electron');
  const child = spawn(exe, [path.join(ROOT, 'app', 'renderer.cjs'), '--renderer', `--user-data-dir=${profile}`, ...flags],
    { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  // (Chromium's own complaints stay out of the studio's log, but for a crash's)
  let tail = '';
  child.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); if (process.env.EPHEMERIS_RENDERER_LOG) fs.appendFileSync(process.env.EPHEMERIS_RENDERER_LOG, d); for (const l of String(d).split('\n')) if (/FATAL|Check failed/.test(l)) console.log(`renderer: ${l.slice(0, 300)}`); });
  const asks = new Map(), handlers = new Map();
  let id = 0, ready, gone = null;
  const up = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  child.on('message', (m) => {
    if (m?.ready) return ready.resolve();
    if (m?.id != null) { const a = asks.get(m.id); asks.delete(m.id); if (m.error != null) a?.reject(new Error(m.error)); else a?.resolve(m.ok); return; }
    if (m?.event) for (const f of handlers.get(m.page)?.get(m.event) ?? []) try { f(m); } catch (e) { console.log('a page handler failed:', e.message); }
  });
  child.on('exit', (code, signal) => {
    gone = new Error(`the rendering browser ended (${signal ?? code})${/FATAL|Check failed/.test(tail) ? `: ${tail.split('\n').filter((l) => /FATAL|Check failed/.test(l)).pop()}` : ''}`);
    ready.reject(gone);
    for (const a of asks.values()) a.reject(gone);
    asks.clear();
    for (const page of handlers.keys()) for (const f of handlers.get(page).get('crash') ?? []) try { f({ reason: 'browser gone' }); } catch { /* (its handler's) */ }
  });
  const ask = (op, args = {}, timeout = 0) => {
    if (gone) return Promise.reject(gone);
    const n = ++id;
    return new Promise((resolve, reject) => {
      asks.set(n, { resolve, reject });
      if (timeout) setTimeout(() => { if (asks.delete(n)) reject(new Error(`${op} took longer than ${timeout} ms`)); }, timeout).unref?.();
      child.send({ id: n, op, ...args });
    });
  };
  let late;
  try {
    await Promise.race([up, new Promise((_, reject) => { late = setTimeout(() => reject(new Error('the rendering browser did not start in 60 s')), 60_000); })]);
  } catch (e) { child.kill(); giveBack(profile); throw e; }
  finally { clearTimeout(late); }
  const { pid } = child;
  renderBrowsers.add(pid);
  child.once('exit', () => renderBrowsers.delete(pid));
  function pageOf(n) {
    const on = new Map();
    handlers.set(n, on);
    const listen = (event, fn) => { if (!on.has(event)) on.set(event, []); on.get(event).push(fn); };
    return {
      on(event, fn) {
        // (in the shapes Playwright gave them, which the tools read)
        if (event === 'console') listen('console', (m) => fn({ type: () => m.type, text: () => m.text }));
        else if (event === 'pageerror') listen('pageerror', (m) => fn(Object.assign(new Error(m.message), { stack: m.stack || m.message })));
        else if (event === 'request') listen('request', (m) => fn({ url: () => m.url }));
        else if (event === 'response') listen('response', (m) => fn({ url: () => m.url, status: () => m.status, request: () => ({ resourceType: () => m.type }) }));
        else listen(event, fn);
        return this;
      },
      goto: (url) => ask('goto', { page: n, url }),
      setContent: (html) => ask('content', { page: n, html }),
      addInitScript: (fn, arg) => ask('init', { page: n, source: String(fn), arg }),
      evaluate: (fn, arg) => ask('eval', { page: n, js: callOf(fn, arg) }).then(unpack),
      async waitForFunction(fn, arg, { timeout = 30_000, polling = 100 } = {}) {
        const until = Date.now() + timeout;
        for (;;) {
          const v = await ask('eval', { page: n, js: callOf(fn, arg) });
          if (v) return v;
          if (Date.now() > until) throw new Error(`waiting for the page took longer than ${timeout} ms`);
          await sleep(polling);
        }
      },
      setViewportSize: ({ width, height }) => ask('size', { page: n, width, height }),
      async screenshot({ path: file, clip } = {}) {
        const png = Buffer.from(await ask('shot', { page: n, clip }), 'base64');
        if (file) fs.writeFileSync(file, png);
        return png;
      },
      async close() { handlers.delete(n); await ask('close', { page: n }).catch(() => {}); },
    };
  }
  return {
    /** Its caches were cleared (clearGpuCaches): it should be closed, and a new one opened. */
    get stale() { return stale.has(profile); },
    /** Whether its caches hold every shader of `key` (a set made ready: madeReady). */
    warmed: (key) => !stale.has(profile) && warmedOf(profile).includes(key),
    /** Its caches hold every shader of `key` now. */
    madeReady(key) {
      if (stale.has(profile)) return;
      fs.mkdirSync(WARMED, { recursive: true });
      const file = path.join(WARMED, path.basename(profile));
      fs.writeFileSync(`${file}.part`, JSON.stringify([...warmedOf(profile).filter((k) => k !== key), key].slice(-KEPT)));
      fs.renameSync(`${file}.part`, file);
    },
    /** A page (an offscreen window), fresh: every page gets fresh cookies, storage and HTTP cache (its partition, kept
     *  on disk for the GPU's caches, is cleared of the rest first; a browser's pages share it: one page at a time each).
     *  (preload: the page's frames go out through IPC, app/frames-preload.cjs.) Chromium keeps a page's decoded pictures
     *  up to 512 MB for each browser, long after a layer's capture has used them; one moderate memory notification halves
     *  that limit for as long as the browser lives: a reel's worker 1140 to 920 MB, and ten full-size pictures on a
     *  live layer draw as fast as before (critical empties it, and the pictures on a live layer are decoded again each
     *  frame from then on, 50 to 350 ms; --enable-low-end-device-mode's 64 MB does the same). */
    async newPage({ viewport = { width: 1280, height: 720 }, transparent = false } = {}) {
      const n = await ask('newPage', { ...viewport, partition: 'persist:render', preload: path.join(ROOT, 'app', 'frames-preload.cjs'), fresh: FRESH, pressure: 'moderate', transparent });
      return pageOf(n);
    },
    async close() {
      try { if (!gone) await ask('quit', {}, 5000).catch(() => {}); await Promise.race([new Promise((r) => (gone ? r() : child.once('exit', r))), new Promise((r) => setTimeout(r, 5000).unref())]); if (!gone) child.kill(); }
      finally { giveBack(profile); }
    },
  };
}
