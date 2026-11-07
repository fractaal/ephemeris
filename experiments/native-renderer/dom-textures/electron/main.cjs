// The page's side: one offscreen window whose pixels arrive as shared GPU memory. It says each paint on stdout and holds
// the texture until the renderer lets it go; the renderer sends { seek: n } to set the page to moment n.
const { app, BrowserWindow } = require('electron');
const readline = require('readline');
const W = +process.env.DOM_W, H = +process.env.DOM_H;
const say = (o) => process.stdout.write('@@' + JSON.stringify(o) + '\n');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, enableLargerThanScreen: true, show: false, transparent: !process.env.DOM_OPAQUE, backgroundColor: process.env.DOM_OPAQUE ? '#204060' : undefined, frame: false,
    webPreferences: { offscreen: { useSharedTexture: true }, backgroundThrottling: false } });
  const held = new Map(); let id = 0;
  win.webContents.on('paint', (e) => {
    const T = e.texture; if (!T) { say({ ev: 'cpu' }); return; }
    const i = T.textureInfo, p = i.handle?.nativePixmap?.planes?.[0];
    if (!p) { T.release(); say({ ev: 'nohandle' }); return; }
    held.set(++id, T);
    say({ ev: 'paint', id, fd: p.fd, stride: p.stride, offset: p.offset, size: p.size, modifier: String(i.handle.nativePixmap.modifier), w: i.codedSize.width, h: i.codedSize.height, format: i.pixelFormat, frameCount: i.metadata?.frameCount ?? null });
  });
  win.webContents.setFrameRate(60);
  await win.loadFile(require('path').join(__dirname, 'page.html'));
  const status = app.getGPUFeatureStatus(), info = await win.webContents.executeJavaScript(`(() => { const g = document.createElement('canvas').getContext('webgl2'); const d = g && g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : null; })()`);
  setTimeout(() => { const f = app.getGPUFeatureStatus(); say({ ev: 'later', compositing: f.gpu_compositing, raster: f.rasterization }); }, 3000);
  say({ ev: 'ready', size: win.getContentSize(), compositing: status.gpu_compositing, raster: status.rasterization, webgl: info, gpuPid: app.getAppMetrics().find((m) => m.type === 'GPU')?.pid });
  readline.createInterface({ input: process.stdin }).on('line', async (l) => {
    const m = JSON.parse(l);
    if (m.release) { held.get(m.release)?.release(); held.delete(m.release); }
    if (m.seek != null) { await win.webContents.executeJavaScript(`seek(${m.seek})`); say({ ev: 'seeked', n: m.seek }); }
    if (m.invalidate) win.webContents.invalidate();
    if (m.quit) app.exit(0);
  });
});
