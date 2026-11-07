// Tells the studio's pages they are in the app, and on which platform (nle.css: the header is the window's title bar),
// and gives them the system's own menus (app/main.mjs): a right-click's, and on macOS the menu bar's. The item chosen is
// told back by its id. The channels' number changes with what they carry, so that a page reloaded over an older app
// (its main process from before) gets no menu rather than the wrong item. And the editor's own film, drawn in the
// viewport's render process (app/viewport.cjs), its frames this window's as GPU memory (app/frames.cjs): viewport.
const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

const mark = () => { if (document.documentElement) document.documentElement.dataset.app = process.platform; };
mark();
window.addEventListener('DOMContentLoaded', mark);

let pick = null, barPick = null;
ipcRenderer.on('menu:2:pick', (e, id) => { const f = pick; pick = null; f?.(id); });
ipcRenderer.on('menu-bar:2:pick', (e, id) => barPick?.(id));

// The viewport's film says of itself (viewport-ready with its port, -failed, -lost) as a frame of the editor's would: a
// window message (nle/viewport.js), viewportWorker set. Each frame it draws comes as a VideoFrame of the image it is in;
// once this page has drawn it and the GPU is done with it, the image goes back to the film to draw into again (released
// as Electron's own release() does, its main process told; then the film).
let onFrame = null;
ipcRenderer.on('viewport:say', (e, data) => window.postMessage({ ...data, viewportWorker: true }, location.origin, e.ports));
ipcRenderer.on('viewport:frame', (e, meta) => onFrame?.(null, meta));
sharedTexture?.setSharedTextureReceiver(async (data, meta) => {
  const imported = data.importedSharedTexture;
  try { await onFrame?.(imported, meta); }
  finally {
    imported.subtle.release(async () => {
      await ipcRenderer.invoke('IMPORT_SHARED_TEXTURE_RELEASE_RENDERER_TO_MAIN', imported.textureId).catch(() => {});
      ipcRenderer.send('viewport:free', meta.ring, meta.k);
    });
  }
});

contextBridge.exposeInMainWorld('studioApp', {
  /** items: [{ label, id?, checked?, disabled?, keys? (a shortcut shown beside it), role? (Electron's own), submenu? }]
   *  or 'hr'; at: { x, y } in the page. */
  contextMenu: (items, at, onPick) => { pick = onPick; ipcRenderer.send('menu:2', items, at); },
  /** The menu bar (macOS: the system's): [{ label, items }]. */
  menuBar: (menus, onPick) => { barPick = onPick; ipcRenderer.send('menu-bar:2', menus); },
  /** A folder chosen in the system's dialog (titled so): its path, or null. */
  pickFolder: (title) => ipcRenderer.invoke('folder:1', title),
  /** A port that reads frames drawn now (app/framefile.cjs: { id, file, n } answered { id, px } or { id, error }), which
   *  comes to the page in a window message, 'frames-reader': a port cannot cross the bridge. */
  framesReader: () => {
    const { port1, port2 } = new MessageChannel();
    ipcRenderer.postMessage('frames:reader:1', null, [port1]);
    window.postMessage('frames-reader', location.origin, [port2]);
  },
  /** The editor's film in the viewport's render process: load(url), its page (?viewport=worker), a promise of whether it
   *  can be (false: frames cannot be shared here, app/frames.cjs); onFrame(fn): each frame it draws, fn(imported, meta),
   *  imported a SharedTextureImported (its getVideoFrame(), drawn before fn's promise settles), meta { w, h, shown,
   *  overlay, fr } (or fn(null, meta): what a frame shows without a picture of its own). */
  viewport: {
    load: (url) => ipcRenderer.invoke('viewport:load', url),
    onFrame: (fn) => { onFrame = fn; },
  },
});
