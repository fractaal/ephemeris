// Zero-copy spike, the consumer: our Electron imports the producer's DMA-BUFs (sharedTexture) and hands each finished
// frame to a page as a VideoFrame; the page draws it and checks its pixels. (env: OUT, PRODUCER, MODE, FRAMES, DRAW)
const { app, BrowserWindow, sharedTexture, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { getfd } = require('../pidfd.node');
const OUT = process.env.OUT, R = { events: [], frames: [] };
const log = (...a) => { const s = a.join(' '); R.events.push([Date.now(), s]); console.log(s); };
const done = (why) => { log('done:', why); fs.writeFileSync(`${OUT}.json`, JSON.stringify(R, null, 1)); app.exit(0); };
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.whenReady().then(async () => {
  setTimeout(() => done('timeout'), 90000);
  const win = new BrowserWindow({ width: 1600, height: 900, show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => log('page:', (e.message ?? '').slice(0, 300)));
  ipcMain.on('drawn', (e, r) => R.frames.push(r));
  ipcMain.on('report', (e, r) => log('report', JSON.stringify(r)));
  await win.loadFile(path.join(__dirname, 'index.html'), { query: { draw: process.env.DRAW || '2d' } });
  const prod = spawn(process.env.PRODUCER, ['1472', '828', process.env.MODE || 'tiled', process.env.FRAMES || '600', '60'], { stdio: ['ignore', 'pipe', 'pipe'] });
  prod.stderr.on('data', (d) => { const s = d.toString(); if (!/lsfg-vk/.test(s)) log('producer:', s.trim().slice(0, 300)); });
  let imported = null, sent = 0, busy = 0, skipped = 0;
  readline.createInterface({ input: prod.stdout }).on('line', async (line) => {
    const m = JSON.parse(line);
    if (m.bufs) {
      R.info = m; log('buffers', line.slice(0, 300));
      try {
        imported = m.bufs.map((b) => sharedTexture.importSharedTexture({ textureInfo: { pixelFormat: 'bgra', codedSize: { width: m.w, height: m.h },
          handle: { nativePixmap: { planes: [{ stride: b.stride, offset: b.offset, size: b.size, fd: getfd(prod.pid, b.fd) }], modifier: m.modifier, supportsZeroCopyWebGpuImport: true } } } }));
        log('imported', imported.map((x) => x.textureId).join(','));
      } catch (e) { log('import failed:', e.message); }
      return;
    }
    if (m.frame == null || !imported) return;
    if (busy > 1) { skipped++; return; }   // (the page two frames behind: this one dropped, as a viewer would)
    busy++;
    const t = Date.now();
    try { await sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: imported[m.buf] }, { frame: m.frame, made: m.t, bar: m.bar, sentAt: t }); sent++; }
    catch (e) { log('send failed:', e.message); }
    busy--;
  });
  prod.on('exit', async (code) => {
    log('producer exit', code, 'sent', sent, 'skipped', skipped);
    await new Promise((r) => setTimeout(r, 500));
    try { fs.writeFileSync(`${OUT}.png`, (await win.webContents.capturePage()).toPNG()); } catch (e) { log('capture failed', e.message); }
    done('producer finished');
  });
});
