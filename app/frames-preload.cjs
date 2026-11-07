// A render page's preload (app/renderer.cjs). Its frames go out through Electron's IPC to its renderer process, which
// hands them to the tools' socket (tools/worker.mjs). Before the page's own code runs, the scripts its driver gave it
// (tools/browser.mjs addInitScript) run in the page's world; an error its code throws that nothing catches is told to
// the driver (its pageerror).
const { contextBridge, ipcRenderer } = require('electron');

for (const [source, arg] of ipcRenderer.sendSync('renderer:init') ?? []) {
  try { contextBridge.executeInMainWorld({ func: new Function(`return (${source})`)(), args: arg === undefined ? [] : [arg] }); }
  catch (e) { ipcRenderer.send('renderer:pageerror', `an init script failed: ${e?.message ?? e}`, String(e?.stack ?? '')); }
}
addEventListener('error', (e) => { if (!(e.target instanceof Element)) ipcRenderer.send('renderer:pageerror', String(e.message ?? e.error?.message ?? 'error'), String(e.error?.stack ?? '')); });
addEventListener('unhandledrejection', (e) => ipcRenderer.send('renderer:pageerror', `Uncaught (in promise) ${e.reason?.message ?? e.reason}`, String(e.reason?.stack ?? '')));

contextBridge.exposeInMainWorld('__frames', {
  /** Connects to the tools' socket on `port`; resolves once it is open. */
  open: (port) => ipcRenderer.invoke('frames:open', port),
  /** A frame (bytes) or what comes next (text), in order. */
  send: (data) => ipcRenderer.send('frames:send', data),
  /** A port for frames drawn now for the studio's window (app/renderer.cjs frames:share), which comes to the page in
   *  a window message, 'frames-port': a port cannot cross the bridge. */
  share: () => {
    const { port1, port2 } = new MessageChannel();
    ipcRenderer.postMessage('frames:share', null, [port1]);
    window.postMessage('frames-port', '*', [port2]);
  },
});
