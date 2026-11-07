// Frames a render process draws and the editor's window shows, as GPU memory neither copies (Linux): images made by
// native/frames' helper (ephemeris-frames: DMA-BUFs in the driver's own tiled layout), taken into each process that uses
// them (getfd.node: pidfd_getfd) and imported by Electron's sharedTexture. The viewport's render process (app/viewport.cjs)
// makes a ring of them for the size it draws, draws each frame into one with WebGPU and says which; the editor's main
// process imports the same ring and hands each frame to its page as a VideoFrame (app/main.mjs). Elsewhere, or where the
// helper is missing, available() is false and the editor shows what the studio's workers draw, as on another device.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

// (the app's own, else what native/frames/build.sh built into the cache)
const dirs = () => [process.env.EPHEMERIS_FRAMES_DIR, process.resourcesPath && path.join(process.resourcesPath, 'app', 'bin'),
  path.join(process.env.EPHEMERIS_CACHE || path.join(os.homedir(), '.cache', 'ephemeris'), 'frames')].filter(Boolean);
const find = (name) => dirs().map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) ?? null;
let addon;
const getfd = () => (addon ??= require(find('getfd.node')));

/** Whether frames can be shared here: Linux, the helper and the addon there, and Electron's sharedTexture. */
function available() {
  if (process.platform !== 'linux' || !find('ephemeris-frames') || !find('getfd.node')) return false;
  try { return !!require('electron').sharedTexture; } catch { return false; }
}

/**
 * The helper, started: ring(id, w, h, n) makes n images of w × h (a promise of { ring, w, h, modifier, bufs, pid }, its
 * images' descriptors in the helper, to import), free(id) lets them go, close() ends it. Its first line says its GPU.
 */
function createAllocator({ log = () => {} } = {}) {
  const child = spawn(find('ephemeris-frames'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const asks = new Map();
  let first, gone = null;
  const started = new Promise((resolve, reject) => { first = { resolve, reject }; });
  child.stderr.on('data', (d) => { const s = String(d); if (!/lsfg-vk|Unknown key/.test(s)) log(`frames: ${s.trim().slice(0, 300)}`); });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.device) return first.resolve(m);
    if (m.ring != null) { const a = asks.get(`ring ${m.ring}`); asks.delete(`ring ${m.ring}`); if (m.error) a?.reject(new Error(`frames: ${m.error}`)); else a?.resolve({ ...m, pid: child.pid }); return; }
    if (m.freed != null) { asks.get(`free ${m.freed}`)?.resolve(); asks.delete(`free ${m.freed}`); return; }
    if (m.error) { first.reject(new Error(`frames: ${m.error}`)); log(`frames: ${m.error}`); }
  });
  child.on('exit', (code) => {
    gone = new Error(`the frames helper ended (${code})`);
    first.reject(gone);
    for (const a of asks.values()) a.reject(gone);
    asks.clear();
  });
  const ask = (key, line) => new Promise((resolve, reject) => {
    if (gone) return reject(gone);
    asks.set(key, { resolve, reject });
    child.stdin.write(`${line}\n`);
  });
  return {
    started,
    pid: child.pid,
    ring: (id, w, h, n = 3) => ask(`ring ${id}`, `ring ${id} ${w} ${h} ${n}`),
    free: (id) => ask(`free ${id}`, `free ${id}`).catch(() => {}),
    close() { child.stdin.end(); setTimeout(() => child.kill(), 2000).unref(); },
  };
}

/**
 * A ring the helper made (ring(), its pid), imported into this process: one SharedTextureImported each, which
 * sharedTexture.sendSharedTexture hands to a page. (In the viewport's render process, --shared-texture-webgpu, for WebGPU
 * alone, its page writing them; in the editor's, for its window to show.)
 */
function importRing(r) {
  const { sharedTexture } = require('electron');
  const { getfd: take, close } = getfd();
  return r.bufs.map((b) => {
    const fd = take(r.pid, b.fd);
    try {
      return sharedTexture.importSharedTexture({ textureInfo: { pixelFormat: 'rgba', codedSize: { width: r.w, height: r.h },
        handle: { nativePixmap: { planes: [{ stride: b.stride, offset: b.offset, size: b.size, fd }], modifier: r.modifier, supportsZeroCopyWebGpuImport: true } } } });
    } finally { close(fd); }   // (Electron keeps a copy of its own)
  });
}

// (a page's messages across a Node IPC channel, which carries JSON: their typed arrays and buffers as base64, and back)
const pack = (v) => {
  if (ArrayBuffer.isView(v)) return { __bytes: v.constructor.name, b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  if (v instanceof ArrayBuffer) return { __bytes: 'ArrayBuffer', b64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(pack);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)]));
  return v;
};
const unpack = (v) => {
  if (Array.isArray(v)) return v.map(unpack);
  if (v && typeof v === 'object') {
    if (v.__bytes) {
      const b = Buffer.from(v.b64, 'base64'), ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
      return v.__bytes === 'ArrayBuffer' ? ab : v.__bytes === 'Buffer' ? b : new globalThis[v.__bytes](ab);
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x)]));
  }
  return v;
};

module.exports = { available, createAllocator, importRing, pack, unpack };
