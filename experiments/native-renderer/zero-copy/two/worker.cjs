// The worker app (its own browser, its own GPU process): imports the shared buffers, and its page draws each frame into
// one with WebGPU (device.importSharedTexture, our Electron's), saying on stdout when the GPU has finished it.
// (env: INFO, ALLOC_PID, FRAMES, HEAVY)
const { app, BrowserWindow, sharedTexture, ipcMain } = require('electron');
const path = require('node:path');
const { getfd } = require('../pidfd.node');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.whenReady().then(async () => {
  const info = JSON.parse(process.env.INFO), pid = +process.env.ALLOC_PID;
  let imported;
  try {
    imported = info.bufs.map((b) => sharedTexture.importSharedTexture({ textureInfo: { pixelFormat: 'bgra', codedSize: { width: info.w, height: info.h },
      handle: { nativePixmap: { planes: [{ stride: b.stride, offset: b.offset, size: b.size, fd: getfd(pid, b.fd) }], modifier: info.modifier, supportsZeroCopyWebGpuImport: true } } } }));
  } catch (e) { out({ log: `worker import failed: ${e.message}` }); app.exit(1); return; }
  const win = new BrowserWindow({ show: false, width: 800, height: 600,
    webPreferences: { offscreen: true, preload: path.join(__dirname, 'worker-preload.js'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => out({ log: (e.message ?? '').slice(0, 300) }));
  ipcMain.on('done', (e, r) => out(r));
  ipcMain.on('finished', () => setTimeout(() => app.exit(0), 200));
  await win.loadFile(path.join(__dirname, 'worker.html'), { query: { frames: process.env.FRAMES || '600', heavy: process.env.HEAVY || '0', split: process.env.SPLIT || '1' } });
  for (let k = 0; k < imported.length; k++) await sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: imported[k] }, { buf: k });
  win.webContents.send('go');
});
