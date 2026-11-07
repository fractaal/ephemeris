const { sharedTexture } = require('electron');
const { contextBridge, ipcRenderer } = require('electron/renderer');
contextBridge.exposeInMainWorld('zc', {
  onFrame: (cb) => sharedTexture.setSharedTextureReceiver(async (data, args) => {
    const imported = data.importedSharedTexture;
    try { await cb(imported, args); } finally { imported.release(); }
  }),
  drawn: (r) => ipcRenderer.send('drawn', r),
  report: (r) => ipcRenderer.send('report', r),
});
