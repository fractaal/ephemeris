// The Ephemeris app: the studio (tools/nle.mjs) in a window of its own. Packaged (npm run dist: app/build.mjs) it is the
// whole studio, Node included (see runtime.mjs), for films in a workspace of their own (tools/workspace.mjs: asked for
// once); from a checkout (./ephemeris app) it runs that checkout's. It opens the studio already running on this machine
// (started in a terminal: ./ephemeris), or starts one and stops it on quit. The studio's header is the window's title bar:
// on macOS its traffic lights sit at the header's left, elsewhere the window's buttons at its right.
//   <app> --cli <command…>: the command line (a workspace's ./ephemeris runs this), with no window
import { app, BrowserWindow, Menu, MessageChannelMain, dialog, ipcMain, screen, sharedTexture, shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtime, integrate } from './runtime.mjs';
import { FILM_SWITCHES, VIEWPORT_FLAGS } from '../tools/browser.mjs';
import framefile from './framefile.cjs';
import frames from './frames.cjs';
import { chosen, choose, version } from '../tools/workspace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..');
const STUDIO = 'http://localhost:5340';
// (the window opens it at 127.0.0.1, another site than the films' servers at localhost: a film running in a frame of the
// editor's own, its viewer's (nle/viewport.js), then has a process of its own, which never holds up the editor's)
const PAGE = 'http://127.0.0.1:5340';
const MAC = process.platform === 'darwin';
// how to start this app again (an AppImage's own file, not where it is mounted this time)
const EXE = process.env.APPIMAGE || process.execPath;
if (process.argv.includes('--viewport-worker')) {
  // The viewport's render process (app/viewport.cjs), which the editor's main process starts: no workspace, no lock, no
  // studio window of its own.
  await import('./viewport.cjs');
} else if (process.argv.includes('--renderer')) {
  // A worker does not choose/relink a workspace, acquire the editor's instance lock, or open a studio window.
  await import('./renderer.cjs');
} else {
  // (a frame of another site keeps what it stores apart from the same site's own pages: the editor, opened at 127.0.0.1,
  // could not read what it kept when it opened at localhost, nle/storage.js; this app shows nothing but the studio's pages
  // and its films, a link to anything else opening in the browser)
  app.commandLine.appendSwitch('disable-features', 'ThirdPartyStoragePartitioning');
  // (the editor's own page draws with WebGPU, its glow, nle/glow.js: as its render browsers have it, tools/browser.mjs;
  // the film draws in the viewport's, app/viewport.cjs)
  for (const [k, v] of FILM_SWITCHES) app.commandLine.appendSwitch(k, v ?? '');
  app.setName('Ephemeris');
  app.setDesktopName('ephemeris.desktop');   // (Linux: the launcher entry its windows belong to)
  // Node and the rest of what the studio runs with: the app's own when packaged; from a checkout, the terminal's.
  const R = app.isPackaged ? await runtime({ root: ROOT, data: app.getPath('userData'), exe: EXE })
    : { node: 'node', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ELECTRON_') && k !== 'CHROME_DESKTOP')) };
  const cli = process.argv.indexOf('--cli');
  if (cli >= 0) {
    const r = spawnSync(R.node, [path.join(ROOT, 'tools', 'ephemeris.mjs'), ...process.argv.slice(cli + 1)], { stdio: 'inherit', env: R.env, cwd: process.cwd() });
    app.exit(r.status ?? 1);
  } else window(R);
}

function window(R) {
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }   // (one already open: it comes to the front, see second-instance)
  const up = () => fetch(`${STUDIO}/api/studio`).then((r) => r.ok, () => false);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // the studio this app started (null: one was already running, or none yet), and whether the app is quitting
  let server = null, quitting = false, win = null;
  async function studio() {
    if (await up()) return;
    // where the films are, asked for once (unless a checkout has films of its own)
    if (!chosen()) {
      const home = path.join(os.homedir(), 'Ephemeris');
      const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: [`Use ${home.replace(os.homedir(), '~')}`, 'Choose…'], defaultId: 0, cancelId: 0,
        message: 'Where should your films live?', detail: 'Ephemeris keeps each film in a folder of its own (with its history: every version of it), together in one folder: your workspace.' });
      let dir = home;
      if (response === 1) {
        const r = await dialog.showOpenDialog(win, { title: 'Your workspace', defaultPath: os.homedir(), properties: ['openDirectory', 'createDirectory'] });
        if (!r.canceled && r.filePaths[0]) dir = r.filePaths[0];
      }
      fs.mkdirSync(dir, { recursive: true });
      choose(dir);
    }
    const logs = app.getPath('logs');
    fs.mkdirSync(logs, { recursive: true });
    const log = fs.openSync(path.join(logs, 'studio.log'), 'a');
    server = spawn(R.node, [path.join(ROOT, 'tools', 'nle.mjs')], { cwd: ROOT, env: { ...R.env, EPHEMERIS_APP_PID: String(process.pid) }, stdio: ['ignore', log, log, 'ipc'], windowsHide: true });
    fs.closeSync(log);
    server.on('exit', (code) => { server = null; if (!quitting) failed(`The studio stopped (exit ${code}). Its log: ${path.join(logs, 'studio.log')}`); });
    for (let i = 0; i < 1200 && server; i++) { if (await up()) return; await wait(100); }
    throw new Error(`The studio did not start. Its log: ${path.join(logs, 'studio.log')}`);
  }
  function failed(message) {
    win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(`<b>Ephemeris</b><span>${message.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`))}`);
  }
  // what the studio needs from the machine itself: said once, at the start (it opens all the same)
  function needs() {
    const missing = [['ffmpeg', ['-version'], 'renders drafts and finished films']]
      .filter(([cmd, args]) => spawnSync(cmd, args, { env: R.env, stdio: 'ignore' }).status !== 0);
    if (!missing.length) return;
    const how = MAC ? 'brew install ffmpeg' : process.platform === 'win32' ? 'winget install Gyan.FFmpeg' : 'your package manager (pacman -S ffmpeg, apt install ffmpeg…)';
    dialog.showMessageBox(win, { type: 'warning', message: `Ephemeris needs ${missing.map(([c]) => c).join(' and ')}`,
      detail: `${missing.map(([c, , why]) => `${c} ${why}`).join('; ')}. Install with ${how}, then open Ephemeris again.` });
  }
  // what the window shows until the studio's own page draws (its splash: the same orbit), or why it cannot
  const page = (body) => `<!doctype html><html data-app="${process.platform}"><style>html,body{margin:0;height:100%;background:#0e0e0e;color:#d6d6d6;font:13px Inter,system-ui,sans-serif;-webkit-app-region:drag}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}b{font-size:26px;font-weight:600;letter-spacing:-.02em;margin-top:14px}span{color:#909090;font-size:12px;max-width:520px;text-align:center}
svg{width:64px;height:64px;fill:none}svg>circle:first-child{stroke:#383838}.body{fill:#d6d6d6}.moon{fill:oklch(80% .1 250);transform-origin:32px 32px;animation:o 2.4s linear infinite}@keyframes o{to{transform:rotate(360deg)}}</style>
<body><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="22"/><circle class="body" cx="32" cy="32" r="5"/><g class="moon"><circle cx="54" cy="32" r="3"/></g></svg>${body}</body></html>`;

  // the window's place and size, as it was left (its size alone if that place is on no screen now)
  const placeFile = () => path.join(app.getPath('userData'), 'window.json');
  function place() {
    try {
      const b = JSON.parse(fs.readFileSync(placeFile(), 'utf8'));
      const on = screen.getAllDisplays().some(({ workArea: a }) => b.x >= a.x && b.y >= a.y && b.x < a.x + a.width && b.y < a.y + a.height);
      return on ? b : { width: b.width, height: b.height };
    } catch { return { width: 1600, height: 1000 }; }
  }
  function open() {
    win = new BrowserWindow({
      ...place(), minWidth: 960, minHeight: 600, backgroundColor: '#0e0e0e', title: 'Ephemeris',
      titleBarStyle: 'hidden',
      ...(MAC ? { trafficLightPosition: { x: 12, y: 10 } } : { titleBarOverlay: { color: '#1c1c1c', symbolColor: '#d6d6d6', height: 32 } }),
      webPreferences: { preload: path.join(HERE, 'preload.cjs') },
    });
    win.on('close', () => { try { fs.writeFileSync(placeFile(), JSON.stringify(win.getNormalBounds())); } catch { /* (not kept) */ } });
    win.on('closed', () => { win = null; });
    // the studio's pages stay here, a panel opened in a window of its own is one (nle/layout.js: its page's, the same
    // code running it); anything else (a film's page, a link) opens in the browser
    win.webContents.setWindowOpenHandler(({ url, frameName }) => {
      if (frameName.startsWith('ephemeris-panel-') && (url === 'about:blank' || url === '')) {
        return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: '#0e0e0e', autoHideMenuBar: true, minWidth: 320, minHeight: 240 } };
      }
      shell.openExternal(url); return { action: 'deny' };
    });
    // (they close with it)
    win.on('closed', () => { for (const w of BrowserWindow.getAllWindows()) w.close(); });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(PAGE) && !url.startsWith(STUDIO) && !url.startsWith('data:')) { e.preventDefault(); shell.openExternal(url); } });
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page('<b>Ephemeris</b><span>motion design studio</span>'))}`);
    studio().then(() => win?.loadURL(PAGE), (e) => failed(e.message));
  }

  // menus: what macOS needs (copy and paste reach text fields only through the Edit menu) and the usual View items, none
  // on a key the studio uses itself (⌘Z/⇧⌘Z/⌘Y its own undo, ⌘B split, ⌘O the projects, ⌘S): its undo is the page's, so
  // the Edit menu's Undo sends the page the key, unless a text field has the focus
  const key = (keyCode, modifiers) => () => { for (const type of ['keyDown', 'keyUp']) win?.webContents.sendInputEvent({ type, keyCode, modifiers }); };
  const typing = () => win?.webContents.executeJavaScript('(e => !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)))(document.activeElement)');
  function menus() {
    // (reloading is the studio's window's, from any of its panels' windows too: theirs are its page's)
    const view = { label: 'View', submenu: [{ label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.reload() },
      { label: 'Force Reload', accelerator: 'Shift+CmdOrCtrl+R', click: () => win?.webContents.reloadIgnoringCache() }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] };
    const undo = (redo) => async () => { if (await typing()) win.webContents[redo ? 'redo' : 'undo'](); else key('Z', redo ? ['meta', 'shift'] : ['meta'])(); };
    const edit = { label: 'Edit', submenu: [{ label: 'Undo', accelerator: 'Cmd+Z', click: undo(false) }, { label: 'Redo', accelerator: 'Shift+Cmd+Z', click: undo(true) }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }] };
    // (the page's menus once it has sent them: its own File, View, Window and Help, this Edit kept for text fields)
    const page = (label) => bar.find((m) => m.label === label);
    Menu.setApplicationMenu(Menu.buildFromTemplate(MAC ? (bar.length
      ? [{ role: 'appMenu' }, page('File'), edit, page('View'), { ...page('Window'), submenu: [...page('Window').submenu, { type: 'separator' }, { role: 'minimize' }, { role: 'zoom' }] }, { ...page('Help'), role: 'help' }].filter(Boolean)
      : [{ role: 'appMenu' }, edit, view, { role: 'windowMenu' }]) : [view]));
  }
  // a menu as the page gives it (app/preload.cjs): its items told back by id when chosen
  const template = (items, send) => items.map((it) => (it === 'hr' ? { type: 'separator' } : it.role ? { role: it.role, ...(it.label ? { label: it.label } : {}) } : {
    label: it.label, enabled: !it.disabled, ...(it.checked != null ? { type: 'checkbox', checked: !!it.checked } : {}),
    ...(it.keys ? { accelerator: it.keys, registerAccelerator: false } : {}),
    ...(it.submenu ? { submenu: template(it.submenu, send) } : { click: () => send(it.id) }),
  }));
  let bar = [];
  ipcMain.on('menu-bar:2', (e, list) => {
    if (!MAC) return;   // (elsewhere the page draws its menu bar in its own header)
    bar = list.map((m) => ({ label: m.label, submenu: template(m.items, (id) => e.sender.send('menu-bar:2:pick', id)) }));
    menus();
  });

  // a menu the page opens (a right-click's, its menu bar's): the system's own, where the page asks (its zoom followed)
  ipcMain.on('menu:2', (e, items, at) => {
    const zoom = e.sender.getZoomFactor();
    Menu.buildFromTemplate(template(items, (id) => e.sender.send('menu:2:pick', id)))
      .popup({ window: BrowserWindow.fromWebContents(e.sender), x: Math.round(at.x * zoom), y: Math.round(at.y * zoom) });
  });

  // a folder chosen in the system's dialog (the settings' preset folders): its path, or null
  ipcMain.handle('folder:1', async (e, title) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: title || 'Choose a folder', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });

  // ---------- the viewport's render process (app/viewport.cjs): the editor's own film, drawn in a browser and a GPU process
  // of its own, its frames this window's as GPU memory neither copies (app/frames.cjs: Linux, the helper there; elsewhere
  // the editor shows what the studio's workers draw). Started the first time the editor asks for its film; the editor
  // (nle/viewport.js) talks to the film's page on a port of its own, as to a frame of its own.
  const VP = { child: null, page: null, port: null, rings: new Map() };
  const toViewport = (m) => { try { VP.child?.send(m); } catch { /* it ended */ } };
  const dropRing = (id) => { for (const t of VP.rings.get(id) ?? []) try { t.release(); } catch { /* released */ } VP.rings.delete(id); };
  function viewportProcess() {
    if (VP.child && VP.child.exitCode == null && !VP.child.killed) return;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
    // (the script is the entry point for a checkout's Electron; the packaged app routes --viewport-worker to it)
    const child = spawn(process.execPath, [path.join(HERE, 'viewport.cjs'), '--viewport-worker', '--ozone-platform-hint=auto', ...VIEWPORT_FLAGS],
      { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (/FATAL|Check failed/.test(l)) console.log(`viewport: ${l.slice(0, 300)}`); });
    child.on('message', viewportSaid);
    child.on('exit', (code, signal) => {
      if (VP.child !== child) return;
      VP.child = null; VP.port?.close(); VP.port = null;
      for (const id of [...VP.rings.keys()]) dropRing(id);
      if (!quitting && VP.page && !VP.page.isDestroyed()) VP.page.send('viewport:say', { ephemeris: 'viewport-lost', message: `its render process ended (${signal ?? code})` });
    });
    VP.child = child;
  }
  function viewportSaid(m) {
    if (m.log) return console.log(m.log);
    // (a ring of images it made: imported here too, each frame drawn into one handed to the page as a VideoFrame)
    if (m.ring) {
      try { VP.rings.set(m.ring.ring, frames.importRing(m.ring)); }
      catch (e) { VP.page?.send('viewport:say', { ephemeris: 'viewport-failed', error: `its frames could not be shown here: ${e.message}` }); }
      return;
    }
    if (m.dropRing) return dropRing(m.dropRing);
    const page = VP.page;
    if (!page || page.isDestroyed()) return;
    if (m.say) {
      if (m.say.ephemeris !== 'viewport-ready') return page.send('viewport:say', m.say);
      // (the page's port: the editor's messages passed on to it, its own to the editor)
      const { port1, port2 } = new MessageChannelMain();
      VP.port?.close();
      VP.port = port1;
      port1.on('message', ({ data }) => toViewport({ port: frames.pack(data) }));
      port1.start();
      return page.postMessage('viewport:say', m.say, [port2]);
    }
    if (m.port) return VP.port?.postMessage(frames.unpack(m.port));
    if (m.frame) {
      const p = frames.unpack(m.frame), imported = p.ring && VP.rings.get(p.ring)?.[p.k];
      const meta = { ring: p.ring, k: p.k, w: p.w, h: p.h, shown: p.shown, overlay: p.overlay, fr: p.fr };
      if (!imported) { page.send('viewport:frame', meta); if (p.ring) toViewport({ free: { ring: p.ring, k: p.k } }); return; }
      sharedTexture.sendSharedTexture({ frame: page.mainFrame, importedSharedTexture: imported }, meta)
        .catch((e) => { console.log(`viewport: a frame was not shown: ${e.message}`); toViewport({ free: { ring: p.ring, k: p.k } }); });
    }
  }
  ipcMain.handle('viewport:load', (e, url) => {
    if (!frames.available()) return false;
    VP.page = e.sender;
    viewportProcess();
    toViewport({ op: 'load', url });
    return true;
  });
  ipcMain.on('viewport:free', (e, ring, k) => toViewport({ free: { ring, k } }));

  // frames drawn now, read for the viewer's worker (framefile.cjs): the page, sandboxed, has no files of its own
  ipcMain.on('frames:reader:1', (e) => {
    const port = e.ports[0];
    port.on('message', ({ data: { id, file, n } }) => framefile.read(file, n).then((px) => port.postMessage({ id, px }), (err) => port.postMessage({ id, error: String(err.message || err) })));
    port.start();
  });

  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } else open(); });
  app.on('activate', () => { if (!win) open(); });
  // macOS keeps an app without windows running (the dock reopens it); elsewhere closing the window quits it
  app.on('window-all-closed', () => { if (!MAC) app.quit(); });
  // IPC closes on a normal quit or an app crash. Windows cannot deliver POSIX signals to Node for cleanup.
  app.on('before-quit', () => { quitting = true; if (server?.connected) server.disconnect(); });
  app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: 'Ephemeris', applicationVersion: version() ?? 'studio', credits: 'A motion design studio' });
    if (app.isPackaged && process.platform === 'linux' && process.env.APPIMAGE) integrate({ root: ROOT, exe: EXE });
    menus();
    open();
    needs();
  });
}
