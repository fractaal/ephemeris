// The viewport's render process: the editor's own film (its Preview and Director views) drawn in a browser and a GPU
// process of its own, as the studio's render workers draw theirs, so that a heavy frame of it never holds up the editor's
// window; its frames reach that window as GPU memory neither copies (app/frames.cjs). The editor's main process
// (app/main.mjs) starts it with a Node IPC channel and drives it:
//   { op: 'load', url }    the film's page (engine/runtime.js ?viewport=worker), in a new window each time
//   { port }               a message of the editor's for the page
//   { free: { ring, k } }  an image the editor's window is done with
// and it says: { ready } once up; { say } what the page says of itself (viewport-ready, -failed, -lost); { port } the
// page's messages; { ring } a ring of images it made, for the editor to import too; { dropRing } one let go; { frame } a
// frame drawn into one; { log } what is worth the studio's log. It ends when the channel closes.
const { app, BrowserWindow, ipcMain, MessageChannelMain, sharedTexture } = require('electron');
const path = require('node:path');
const { createAllocator, importRing, pack, unpack } = require('./frames.cjs');

app.setName('Ephemeris viewport');
if (process.platform === 'darwin') app.setActivationPolicy('accessory');
process.on('disconnect', () => app.exit(0));
app.on('window-all-closed', () => {});

const send = (m) => { try { process.send?.(m); } catch { /* the channel closing */ } };
const log = (s) => send({ log: s });
let win = null, port = null, alloc = null, ringN = 0;
const rings = new Map();   // (id → its images, imported here)
const LEVELS = { warning: 'warning', error: 'error', 2: 'warning', 3: 'error' };

function dropRing(id) {
  for (const t of rings.get(id) ?? []) try { t.release(); } catch { /* released */ }
  rings.delete(id);
  alloc?.free(id);
  send({ dropRing: id });
}
function open(url) {
  port?.close(); port = null;
  if (win && !win.isDestroyed()) win.destroy();
  for (const id of [...rings.keys()]) dropRing(id);
  // (its window's size is the film's layers', not the frame's, which the film says: as a render worker's)
  win = new BrowserWindow({ show: false, width: 1920, height: 1080, frame: false,
    webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false, preload: path.join(__dirname, 'viewport-preload.cjs') } });
  const wc = win.webContents;
  wc.on('console-message', (e) => { const level = LEVELS[e.level]; if (level && !/favicon|Failed to load resource|GL Driver/.test(e.message ?? '')) log(`[viewport] ${String(e.message).slice(0, 300)}`); });
  wc.on('render-process-gone', (e, d) => send({ say: { ephemeris: 'viewport-lost', message: `its page ended (${d.reason})` } }));
  wc.loadURL(url).catch((e) => send({ say: { ephemeris: 'viewport-failed', error: `its page did not load: ${e.message}` } }));
}

ipcMain.on('viewport:say', (e, data) => {
  if (e.sender !== win?.webContents) return;
  if (data?.ephemeris === 'viewport-ready') {
    // (its port: the editor's questions and the page's answers and events, passed on as they come)
    const { port1, port2 } = new MessageChannelMain();
    port?.close();
    port = port1;
    port1.on('message', ({ data: m }) => send({ port: pack(m) }));
    port1.start();
    e.sender.postMessage('viewport:port', null, [port2]);
  }
  send({ say: data });
});
// a ring of images of w × h: made by the helper, imported here, given to the page (each, before this answers), and said
// to the editor's main process, which imports it too; the ring before it let go of
ipcMain.handle('viewport:ring', async (e, w, h) => {
  if (e.sender !== win?.webContents) throw new Error('not the viewport page');
  alloc ??= createAllocator({ log });
  await alloc.started;
  const id = `r${++ringN}`, r = await alloc.ring(id, w, h, 3), imported = importRing(r);
  rings.set(id, imported);
  for (let k = 0; k < imported.length; k++) await sharedTexture.sendSharedTexture({ frame: e.sender.mainFrame, importedSharedTexture: imported[k] }, { ring: id, k });
  send({ ring: r });
  for (const old of [...rings.keys()]) if (old !== id) dropRing(old);
  return { id, n: imported.length };
});
ipcMain.on('viewport:frame', (e, p) => { if (e.sender === win?.webContents) send({ frame: pack(p) }); });

// (what comes before the app is ready, a window then being impossible, waits for it)
const ready = app.whenReady();
process.on('message', async (m) => {
  await ready;
  if (m?.op === 'load') return open(m.url);
  if (m?.port && port) return port.postMessage(unpack(m.port));
  if (m?.free) return win?.webContents.send('viewport:free', m.free.ring, m.free.k);
  if (m?.op === 'quit') return app.exit(0);
});
app.whenReady().then(() => send({ ready: true }));
