// The preload of the film's page in the viewport's render process (app/viewport.cjs; engine/runtime.js ?viewport=worker).
// The page gets its port to the editor as a frame of the editor's would (a window message, 'ephemeris-viewport', from
// itself); what it says of itself (viewport-ready, -failed, -lost: posted to its own window, its parent being itself)
// goes to the editor; and __viewportFrames: the ring of images it draws its frames into (ring(w, h): one of that size,
// made, its images given to onTexture first), each frame drawn said (frame), each image the editor is done with told
// (onFree).
const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

ipcRenderer.on('viewport:port', (e) => window.postMessage('ephemeris-viewport', '*', e.ports));
addEventListener('message', (e) => {
  const what = e.data?.ephemeris;
  if (typeof what === 'string' && what.startsWith('viewport-')) ipcRenderer.send('viewport:say', e.data);
});

let onTexture = null, onFree = null;
const early = [];
sharedTexture.setSharedTextureReceiver(async (data, args) => {
  if (onTexture) await onTexture(data.importedSharedTexture, args);
  else early.push([data.importedSharedTexture, args]);
});
ipcRenderer.on('viewport:free', (e, ring, k) => onFree?.(ring, k));

contextBridge.exposeInMainWorld('__viewportFrames', {
  ring: (w, h) => ipcRenderer.invoke('viewport:ring', w, h),
  frame: (p) => ipcRenderer.send('viewport:frame', p),
  onTexture: async (cb) => { onTexture = cb; for (const [t, a] of early.splice(0)) await cb(t, a); },
  onFree: (cb) => { onFree = cb; },
});
