// A rendering-only Electron process. It uses the app's Chromium without opening the editor or sharing its GPU process.
// Whatever started it (tools/browser.mjs: the studio, a render's command) drives it over the Node IPC channel it was given:
// each { id, op, ... } answered { id, ok } or { id, error }; its pages' console, errors and requests come back as
// { page, event, ... }. It quits by itself once that channel closes (whatever started it is gone).
const { app, ipcMain, BrowserWindow, session } = require('electron');
const { writer, sweep } = require('./framefile.cjs');

const profile = app.commandLine.getSwitchValue('user-data-dir');
if (profile) {
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}
app.setName('Ephemeris renderer');
if (process.platform === 'darwin') app.setActivationPolicy('accessory');

// The channel closes when its parent ends (killed, crashed, ended without closing this); and, should that be missed,
// its pid going (on Linux and the Mac the parent becomes another process, on Windows the parent's pid no longer answers).
process.on('disconnect', () => app.exit(0));
const parent = process.ppid;
setInterval(() => {
  let gone = process.ppid !== parent;
  if (!gone) try { process.kill(parent, 0); } catch (e) { gone = e.code === 'ESRCH'; }
  if (gone) app.exit(0);
}, 1000).unref();

// GPU, colour and Linux's headless Ozone flags are process arguments (tools/browser.mjs): Ozone starts before app code.
// Reloading a film closes its old page before opening a fresh one; that must not stop its browser.
app.on('window-all-closed', () => {});

// Each page's frames (app/frames-preload.cjs) go on to the tools' socket from here, one socket per page.
const sockets = new Map();
ipcMain.handle('frames:open', (e, port) => new Promise((resolve, reject) => {
  const page = e.sender, s = new WebSocket(`ws://127.0.0.1:${port}`);
  s.onopen = () => {
    sockets.get(page.id)?.close();
    sockets.set(page.id, s);
    page.once('destroyed', () => { if (sockets.get(page.id) === s) sockets.delete(page.id); s.close(); });
    resolve();
  };
  s.onerror = () => reject(new Error(`the tools' socket on port ${port} did not open`));
}));
ipcMain.on('frames:send', (e, data) => sockets.get(e.sender.id)?.send(data));

// A page's frames drawn now for the studio's window (app/framefile.cjs) come on a port of their own, each its bytes and
// then what it is (the page's bridge, frames:send's, would copy them once more): written to a file, the socket told which.
sweep();
const writers = new Set();
ipcMain.on('frames:share', (e) => {
  const page = e.sender, port = e.ports[0], files = writer(page.id);
  let file = null;
  writers.add(files);
  port.on('message', ({ data }) => {
    if (ArrayBuffer.isView(data)) file = files.write(data);
    else sockets.get(page.id)?.send(JSON.stringify({ ...data, file }));
  });
  port.start();
  page.once('destroyed', () => { port.close(); files.close(); writers.delete(files); });
});
app.on('will-quit', () => { for (const files of writers) files.close(); });

// ---------- the pages, driven over the channel
const pages = new Map();   // (id → { win, init: [[script source, arg]] })
const byContents = new Map();   // (webContents id → page id)
let nextPage = 0;
const send = (m) => { try { process.send?.(m); } catch { /* the channel closing */ } };
const event = (page, type, data) => send({ page, event: type, ...data });
// (what a page's code gives back, as JSON carries it: typed arrays and their buffers as base64, tools/browser.mjs reads)
const pack = (v) => {
  if (ArrayBuffer.isView(v)) return { __bytes: v.constructor.name, b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  if (v instanceof ArrayBuffer) return { __bytes: 'ArrayBuffer', b64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(pack);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)]));
  return v;
};
// (each partition's requests, told as their page's: one listener a session, the pages sharing it told apart by contents)
const watched = new Set();
function watch(s) {
  if (watched.has(s)) return;
  watched.add(s);
  s.webRequest.onBeforeRequest((d, cb) => { const id = byContents.get(d.webContentsId); if (id) event(id, 'request', { url: d.url }); cb({}); });
  s.webRequest.onCompleted((d) => { const id = byContents.get(d.webContentsId); if (id) event(id, 'response', { url: d.url, status: d.statusCode, type: d.resourceType }); });
}
// (the console's levels as the tools name them: Chromium's info, warning, error)
const LEVELS = { debug: 'debug', info: 'log', warning: 'warning', error: 'error', 0: 'log', 1: 'log', 2: 'warning', 3: 'error' };
// (the page's own init scripts, asked for by its preload before its code runs: app/frames-preload.cjs)
ipcMain.on('renderer:init', (e) => { e.returnValue = pages.get(byContents.get(e.sender.id))?.init ?? []; });
// (an error the page's code threw and nothing caught: its preload hears it)
ipcMain.on('renderer:pageerror', (e, message, stack) => { const id = byContents.get(e.sender.id); if (id) event(id, 'pageerror', { message, stack }); });

const view = (wc, width, height) => wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
const ops = {
  async newPage({ width = 1280, height = 720, partition = 'persist:render', preload, fresh = [], pressure = null, transparent = false }) {
    const s = session.fromPartition(partition);
    await s.clearCache();
    if (fresh.length) await s.clearStorageData({ storages: fresh });
    watch(s);
    const win = new BrowserWindow({
      width, height, useContentSize: true, frame: false, show: false, transparent,
      ...(transparent && { backgroundColor: '#00000000' }),
      webPreferences: { partition, backgroundThrottling: false, offscreen: true, sandbox: true, ...(preload && { preload }) },
    });
    const id = ++nextPage, wc = win.webContents;
    pages.set(id, { win, init: [] });
    byContents.set(wc.id, id);
    wc.on('console-message', (e) => event(id, 'console', { type: LEVELS[e.level] ?? 'log', text: e.message ?? '' }));
    wc.on('render-process-gone', (e, d) => event(id, 'crash', { reason: d.reason }));
    win.on('closed', () => { pages.delete(id); byContents.delete(wc.id); event(id, 'closed', {}); });
    await win.loadURL('about:blank');
    // (its size as the page sees it, through a DevTools session of its own kept for its life, as device mode sets one:
    // an offscreen window under Linux's headless Ozone is 1×1 whatever it was made; the override outlives navigations)
    wc.debugger.attach('1.3');
    await view(wc, width, height);
    if (transparent) await wc.debugger.sendCommand('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    // Chromium keeps a page's decoded pictures up to 512 MB for each browser, long after a layer's capture has used them.
    // One moderate notification halves that limit for as long as the browser lives (tools/browser.mjs newPage).
    if (pressure) await wc.debugger.sendCommand('Memory.simulatePressureNotification', { level: pressure });
    return id;
  },
  init({ page, source, arg }) { pages.get(page).init.push([source, arg]); return true; },
  async goto({ page, url }) { await pages.get(page).win.loadURL(url); return true; },
  async content({ page, html }) { await pages.get(page).win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`); return true; },
  async eval({ page, js }) { return pack(await pages.get(page).win.webContents.executeJavaScript(js, true)); },
  async size({ page, width, height }) { const { win } = pages.get(page); win.setContentSize(width, height); await view(win.webContents, width, height); return true; },
  // (through its DevTools session, which draws the page at its emulated size: the window's own capture is its real size)
  async shot({ page, clip }) {
    const { data } = await pages.get(page).win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', ...(clip && { clip: { ...clip, scale: 1 } }) });
    return data;
  },
  close({ page }) { const p = pages.get(page); if (p && !p.win.isDestroyed()) p.win.destroy(); return true; },
  quit() { setTimeout(() => app.exit(0), 10); return true; },
};
process.on('message', async (m) => {
  if (!m || m.id == null || !ops[m.op]) return;
  try {
    if (!pages.has(m.page) && m.page != null) throw new Error(`no page ${m.page}: it was closed`);
    send({ id: m.id, ok: await ops[m.op](m) });
  } catch (e) { send({ id: m.id, error: String(e?.message ?? e) }); }
});
app.whenReady().then(() => send({ ready: true }));
