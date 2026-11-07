// Two apps, two GPU processes. The editor app shows frames that a worker app (another Electron, its own GPU process)
// wrote with WebGPU into shared buffers; its window animates every frame and is traced, so a stall of it while the
// worker's GPU work runs shows. (env: OUT, PRODUCER, FRAMES, HEAVY)
const { app, BrowserWindow, sharedTexture, ipcMain, contentTracing } = require('electron');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { getfd } = require('../pidfd.node');
const OUT = process.env.OUT, R = { events: [], frames: [], made: [] };
const log = (...a) => { const s = a.join(' '); R.events.push([Date.now(), s]); console.log(s); };
const done = (why) => { log('done:', why); fs.writeFileSync(`${OUT}.json`, JSON.stringify(R, null, 1)); app.exit(0); };
const firstLine = (stream) => new Promise((ok) => readline.createInterface({ input: stream }).once('line', (l) => ok(JSON.parse(l))));
const handleOf = (info, pid, b) => ({ nativePixmap: { planes: [{ stride: b.stride, offset: b.offset, size: b.size, fd: getfd(pid, b.fd) }], modifier: info.modifier, supportsZeroCopyWebGpuImport: true } });
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.whenReady().then(async () => {
  setTimeout(() => done('timeout'), 150000);
  const win = new BrowserWindow({ width: 1600, height: 900, show: true,
    webPreferences: { preload: path.join(__dirname, '../app/preload.js'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => log('page:', (e.message ?? '').slice(0, 300)));
  ipcMain.on('drawn', (e, r) => R.frames.push(r));
  ipcMain.on('report', (e, r) => log('report', JSON.stringify(r)));
  await win.loadFile(path.join(__dirname, 'editor.html'));
  const alloc = spawn(process.env.PRODUCER, ['1472', '828', 'alloc', '0', '60'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const info = await firstLine(alloc.stdout);
  R.info = info; log('buffers made by', info.device, 'modifier', info.modifier);
  let imported;
  try { imported = info.bufs.map((b) => sharedTexture.importSharedTexture({ textureInfo: { pixelFormat: 'bgra', codedSize: { width: info.w, height: info.h }, handle: handleOf(info, alloc.pid, b) } })); }
  catch (e) { log('editor import failed:', e.message); alloc.stdin.end(); return done('import failed'); }
  await contentTracing.startRecording({ included_categories: ['toplevel', 'viz', 'devtools.timeline', '__metadata'], excluded_categories: ['*'] });
  await new Promise((r) => setTimeout(r, 300));
  win.webContents.executeJavaScript('console.timeStamp("zc:start")');
  // (the worker as the studio's render workers start: offscreen, Vulkan in its GPU process; and WebGPU on the buffers)
  const wflags = [`--ozone-platform=${process.env.WOZONE || 'wayland'}`, '--enable-features=CanvasDrawElement,WebGPU,EphemerisWebGPUNativePixmap', '--enable-unsafe-webgpu',
    '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-watchdog', '--shared-texture-webgpu'];
  const worker = spawn(process.execPath, [path.join(__dirname, 'worker.cjs'), ...wflags],
    { env: { ...process.env, ALLOC_PID: String(alloc.pid), INFO: JSON.stringify(info) }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stderr.on('data', (d) => { const s = d.toString(); if (/ERROR|FATAL|rror/.test(s) && !/lsfg|Unknown key|not compatible with Vulkan/.test(s)) log('worker stderr:', s.trim().slice(0, 300)); });
  let busy = 0, skipped = 0, shown = 0;
  readline.createInterface({ input: worker.stdout }).on('line', async (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.log) { log('worker:', m.log); return; }
    if (m.frame == null) return;
    R.made.push([m.frame, m.t, m.heavy ?? 0]);
    if (busy > 1) { skipped++; return; }
    busy++;
    try { await sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: imported[m.buf] }, { frame: m.frame, made: m.t, bar: m.bar, sentAt: Date.now() }); shown++; }
    catch (e) { log('send failed:', e.message); }
    busy--;
  });
  worker.on('exit', async (code) => {
    log('worker exit', code, 'shown', shown, 'skipped', skipped);
    win.webContents.executeJavaScript('console.timeStamp("zc:stop")');
    await new Promise((r) => setTimeout(r, 300));
    await contentTracing.stopRecording(`${OUT}.trace.json`);
    try { fs.writeFileSync(`${OUT}.png`, (await win.webContents.capturePage()).toPNG()); } catch {}
    alloc.stdin.end();
    done('worker finished');
  });
});
