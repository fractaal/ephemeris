const { sharedTexture } = require('electron');
const { contextBridge, ipcRenderer } = require('electron/renderer');
// (each buffer arrives once and is kept for the whole run: the page writes into it every few frames)
let onTexture = null;
const pending = [];
sharedTexture.setSharedTextureReceiver(async (data, args) => {
  if (onTexture) await onTexture(data.importedSharedTexture, args); else pending.push([data.importedSharedTexture, args]);
});
contextBridge.exposeInMainWorld('w', {
  onTexture: async (cb) => { onTexture = cb; for (const [t, a] of pending.splice(0)) await cb(t, a); },
  onGo: (cb) => ipcRenderer.on('go', () => cb()),
  done: (r) => ipcRenderer.send('done', r),
  finished: () => ipcRenderer.send('finished'),
});
