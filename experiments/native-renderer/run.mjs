// Run with --root <frozen studio/workspace> --dawn <webgpu package directory> --film <name>.
// This does not connect to or change the running studio. It owns and closes its browser and native child.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, fork, execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { WebSocketServer } from 'ws';
import { chromePath, chromeArgs, CHROME_VERSION } from '../../tools/chrome.mjs';
import { unpack } from './codec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, xs) => x.startsWith('--') ? [...a, [x.slice(2), xs[i + 1]]] : a, []));
if (!args.root || !args.film) throw new Error('--root and --film are required');
const { CDP, evaluate } = await import(pathToFileURL(args.cdp ?? path.join(os.homedir(), '.agents/skills/browser-cdp/scripts/cdp.mjs')).href);
const root = path.resolve(args.root), out = path.resolve(args.out ?? path.join(root, 'results', `${args.film}-${args.mode ?? 'probe'}`));
const mode = args.mode ?? 'probe', count = Number(args.frames ?? 12), warm = Number(args.warm ?? 4);
const times = (args.times ?? '10').split(',').map(Number);
const timeline = JSON.parse(await fs.readFile(path.join(root, 'projects', args.film, 'timelines/main.json'), 'utf8'));
const settings = { sub: Number(args.samples ?? 4), scale: Number(args.scale ?? 0.5), fps: timeline.fps ?? 24, shutter: (timeline.shutter ?? 180) / 360 };
const options = { gi: timeline.gi ?? null, shadows: timeline.shadows ?? null };
await fs.mkdir(out, { recursive: true });
// Linux Vulkan implicit gaming layers are unrelated to Ephemeris and can otherwise load into the test.
process.env.VK_LOADER_LAYERS_DISABLE = '~implicit~';
process.env.MANGOHUD = '0';
process.title = 'eph-bench-driver';
try { execFileSync('chrt', ['-o', '-p', '0', String(process.pid)]); } catch {}

async function processes(roots) {
  const all = new Map();
  for (const name of await fs.readdir('/proc')) if (/^\d+$/.test(name)) {
    try {
      const s = await fs.readFile(`/proc/${name}/stat`, 'utf8'), a = s.slice(s.lastIndexOf(')') + 2).split(' ');
      all.set(+name, { pid: +name, ppid: +a[1], ticks: +a[11] + +a[12], nice: +a[16], policy: +a[38] });
    } catch {}
  }
  const chosen = new Set(roots); let again = true;
  while (again) { again = false; for (const x of all.values()) if (chosen.has(x.ppid) && !chosen.has(x.pid)) { chosen.add(x.pid); again = true; } }
  const result = [];
  for (const pid of chosen) if (all.has(pid)) {
    const x = all.get(pid);
    try {
      const text = await fs.readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
      x.pssKB = Number(/^Pss:\s+(\d+)/m.exec(text)?.[1] ?? 0);
      x.rssKB = Number(/^Rss:\s+(\d+)/m.exec(text)?.[1] ?? 0);
    } catch { x.pssKB = null; }
    result.push(x);
  }
  return { at: performance.now(), ticks: result.reduce((n, x) => n + x.ticks, 0), pssKB: result.reduce((n, x) => n + (x.pssKB ?? 0), 0), processes: result };
}
async function normalize(roots) {
  const snapshot = await processes(roots), tids = [];
  for (const { pid } of snapshot.processes) {
    try {
      execFileSync('chrt', ['-a', '-o', '-p', '0', String(pid)], { stdio: 'ignore' });
      tids.push(...await fs.readdir(`/proc/${pid}/task`));
    } catch {}
  }
  // Equalize CPU priority at the driver's inherited nice value (raising it would require root).
  if (tids.length) try { execFileSync('renice', ['16', '-p', ...tids], { stdio: 'ignore' }); } catch {}
}
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, median: s[Math.floor(s.length / 2)], p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))], mean: s.reduce((a, b) => a + b, 0) / s.length }; };
function diff(a, b) {
  if (a.length !== b.length) throw new Error(`Different image lengths: ${a.length}, ${b.length}`);
  let abs = 0, sq = 0, max = 0, over2 = 0, over8 = 0;
  for (let i = 0; i < a.length; i += 4) {
    let pixelMax = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); abs += d; sq += d * d; max = Math.max(max, d); pixelMax = Math.max(pixelMax, d); }
    over2 += pixelMax > 2; over8 += pixelMax > 8;
  }
  const n = a.length / 4;
  return { mae: abs / (n * 3), rmse: Math.sqrt(sq / (n * 3)), max, pixelsOver2: over2, pixelsOver8: over8, pixels: n };
}
let server, browser, chrome, profile, wss, native, page;
const waiting = [], packets = [];
const nextPacket = () => packets.length ? Promise.resolve(packets.shift()) : new Promise((r) => waiting.push(r));
let nextID = 1;
const replies = new Map();
function rpc(command, data = {}) {
  const id = nextID++;
  return new Promise((resolve, reject) => { replies.set(id, { resolve, reject }); native.send({ id, command, ...data }); });
}
async function call(method, ...a) {
  const started = performance.now();
  const response = page.evaluate(async ([method, args]) => window.__bench[method](...args), [method, a]);
  // A rendering error must reject instead of leaving a forever-waiting pixel request.
  const failure = response.then(() => new Promise(() => {}));
  const data = await Promise.race([nextPacket(), failure]), result = await response;
  return { data, result, wallMs: performance.now() - started };
}
const results = { created: new Date().toISOString(), mode, film: args.film, settings, chromeVersion: CHROME_VERSION,
  node: process.version, platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0].model, root, options,
  clockTicks: Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' })), rows: [] };
results.harness = Object.fromEntries(await Promise.all(['run.mjs', 'browser.mjs', 'producer.mjs', 'native.mjs', 'codec.mjs'].map(async (file) => [file, createHash('sha256').update(await fs.readFile(path.join(here, file))).digest('hex')])));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  // Vite is needed for the films' CSS and ?raw imports. No workspace relinking or studio CLI is involved.
  const producer = mode === 'hybrid' ? await fs.readFile(path.join(here, 'producer.mjs'), 'utf8') : null;
  server = await createServer({ root, configFile: false, logLevel: 'error', optimizeDeps: { entries: [`projects/${args.film}/index.html`] },
    plugins: producer ? [{ name: 'benchmark-layer-producer', configureServer(s) {
      s.middlewares.use((req, res, next) => { if (req.url.split('?')[0] !== '/engine/render/index.js') return next(); res.setHeader('Content-Type', 'application/javascript'); res.end(producer); });
    } }] : [],
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, fs: { allow: [root, here, path.resolve(here, '../..')] } } });
  await server.listen();
  const port = server.httpServer.address().port;
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (s) => s.on('message', (data) => { if (waiting.length) waiting.shift()(data); else packets.push(data); }));
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'eph-native-bench-'));
  chrome = spawn(await chromePath(), [...chromeArgs, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let text = '';
    chrome.stderr.on('data', (s) => { text += s; const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text); if (m) resolve(m[1]); });
    chrome.once('error', reject); chrome.once('exit', (code) => reject(new Error(`Chrome exited ${code}: ${text.slice(-2000)}`)));
  });
  // Do not enable CDP Network: it mirrors every binary pixel WebSocket frame through the
  // debugger, adding large, entropy-dependent overhead unrelated to the renderer.
  browser = await CDP.connect(endpoint, 180000);
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank', background: false });
  page = await browser.attach(targetId);
  page.evaluate = (fn, arg) => evaluate(page, `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`);
  const errors = [];
  page.onEvent(({ method, params }) => {
    if (method === 'Runtime.exceptionThrown') { const text = params.exceptionDetails.exception?.description ?? params.exceptionDetails.text; errors.push(text); console.error('[page]', text); }
    if (method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(params.type)) console.error('[browser]', params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 600));
  });
  await page.call('Page.enable'); await page.call('Runtime.enable');
  // This browser is headless and task-owned: activate its film target so HTML-in-Canvas paints.
  await page.call('Page.bringToFront');
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const query = new URLSearchParams();
  for (const k of ['shadows', 'gi']) if (timeline[k] != null) query.set(k, timeline[k] ? '1' : '0');
  if (timeline.pixelFilter != null) query.set('pixelFilter', timeline.pixelFilter);
  const boot = performance.now();
  await page.call('Page.navigate', { url: `http://127.0.0.1:${port}/projects/${args.film}/?${query}` });
  await page.evaluate(async () => {
    const end = performance.now() + 175000;
    while (!window.__ready && !window.__bootError) { if (performance.now() > end) throw new Error('Film boot timed out'); await new Promise((r) => setTimeout(r, 50)); }
  });
  await page.call('Page.bringToFront');
  const bootError = await page.evaluate(() => window.__bootError);
  if (bootError || errors.length) throw new Error(bootError || errors.join('\n'));
  results.bootMs = performance.now() - boot;
  results.visibility = await page.evaluate(() => document.visibilityState);
  if (results.visibility !== 'visible') throw new Error('Headless film target must be visible for HTML-in-Canvas painting');
  results.browser = await page.evaluate(async ([module, port]) => (await import(module)).install(port), [`/@fs/${here}/browser.mjs`, wss.address().port]);
  console.log(JSON.stringify({ event: 'ready', film: args.film, mode, bootMs: results.bootMs, adapter: results.browser.adapter, layers: results.browser.layers.length }));
  if (mode !== 'probe') {
    if (mode !== 'baseline') {
    native = fork(path.join(here, 'native.mjs'), [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    native.on('message', (m) => { const p = replies.get(m.id); replies.delete(m.id); if (m.error) p?.reject(new Error(m.error)); else p?.resolve(m.result); });
    native.on('exit', (code) => { for (const p of replies.values()) p.reject(new Error(`Native exited ${code}`)); replies.clear(); });
    results.native = await rpc('init', { root, dawn: path.resolve(args.dawn ?? path.join(here, 'node_modules/webgpu')), limits: results.browser.limits, size: results.browser.size, options });
    console.log(JSON.stringify({ event: 'native-ready', ...results.native }));
    }
    for (const t of times) {
      if (mode === 'compare') {
        const captured = await call('capture', t, settings, true);
        await fs.writeFile(path.join(out, `frame-${t}.packet`), captured.data);
        const inventory = unpack(captured.data);
        const ingest = await rpc('ingest', { packet: captured.data, key: t });
        console.log(JSON.stringify({ event: 'captured', t, ...captured.result, resources: inventory.meta.resources.length, ingest }));
        for (let i = 0; i < warm; i++) { await call('replay', t); await rpc('draw', { key: t, options: { fixedBands: true } }); }
        const b = await call('baseline', t, settings);
        const c = await call('replay', t);
        const n = await rpc('draw', { key: t, options: { pixels: true, fixedBands: true } });
        await fs.writeFile(path.join(out, `baseline-${t}.rgba`), b.data);
        await fs.writeFile(path.join(out, `browser-${t}.rgba`), c.data);
        await fs.writeFile(path.join(out, `native-${t}.rgba`), n.pixels);
        const quality = { baselineReplay: diff(b.data, c.data), browserNative: diff(c.data, n.pixels) };
        await normalize([process.pid]);
        const samples = [];
        const beforeBrowser = await processes([chrome.pid]), beforeNative = await processes([native.pid]);
        for (let i = 0; i < count; i++) {
          // Alternate which runs first; neither renders concurrently with the other.
          let a, b;
          if (i % 2) { b = await rpc('draw', { key: t, options: { fixedBands: true } }); a = await call('replay', t); }
          else { a = await call('replay', t); b = await rpc('draw', { key: t, options: { fixedBands: true } }); }
          samples.push({ browserMs: a.result.renderMs, browserWallMs: a.wallMs, nativeMs: b.renderMs });
        }
        const afterBrowser = await processes([chrome.pid]), afterNative = await processes([native.pid]);
        const bp = await call('baseline', t, { ...settings, profile: true });
        const cp = await call('replay', t, true);
        const np = await rpc('draw', { key: t, options: { profile: true, fixedBands: true } });
        const row = { t, width: n.width, height: n.height, quality, capture: captured.result, samples,
          browser: stats(samples.map((x) => x.browserMs)), native: stats(samples.map((x) => x.nativeMs)),
          profiles: { baseline: bp.result.profile, browser: cp.result.profile, native: np.profile },
          resources: { beforeBrowser, beforeNative, afterBrowser, afterNative } };
        results.rows.push(row); console.log(JSON.stringify({ event: 'comparison', t, quality, browser: row.browser, native: row.native }));
      } else if (mode === 'hybrid' || mode === 'baseline') {
        const run = async (time, pixels = false) => {
          const began = performance.now();
          if (mode === 'baseline') {
            const b = await call('baseline', time, settings);
            return { time, wallMs: performance.now() - began, ...b.result, hash: hash(b.data), ...(pixels && { pixels: b.data }) };
          }
          const prepared = await call('capture', time, settings);
          const n = await rpc('frame', { key: 'current', packet: prepared.data, options: { pixels: true } });
          return { time, wallMs: performance.now() - began, browserWallMs: prepared.wallMs, ...prepared.result, ...n, hash: hash(n.pixels), ...(pixels ? {} : { pixels: undefined }) };
        };
        for (let i = 0; i < warm; i++) await run(t + i / settings.fps);
        const first = await run(t, true);
        await fs.writeFile(path.join(out, `${mode}-${t}.rgba`), first.pixels);
        delete first.pixels;
        await normalize([process.pid]);
        const before = await processes([process.pid]), samples = [];
        const start = performance.now();
        for (let i = 0; i < count; i++) samples.push(await run(t + i / settings.fps));
        const elapsedMs = performance.now() - start, after = await processes([process.pid]);
        const row = { t, first, samples, elapsedMs, fps: count * 1000 / elapsedMs, wall: stats(samples.map((x) => x.wallMs)), before, after };
        results.rows.push(row); console.log(JSON.stringify({ event: mode, t, fps: row.fps, wall: row.wall, pssMB: after.pssKB / 1024 }));
      }
      await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    }
  }
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
} finally {
  if (native?.connected) await rpc('close').catch(() => {});
  if (browser) { await browser.call('Browser.close').catch(() => {}); browser.close(); }
  if (chrome && chrome.exitCode === null) chrome.kill('SIGTERM');
  wss?.close(); await server?.close();
  if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
