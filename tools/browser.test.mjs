// Real rendering-runtime integration: run with Node on a checkout, or the app executable in ELECTRON_RUN_AS_NODE mode.
// Linux is exercised without DISPLAY/Wayland. The app must render from its own runtime, not a warmed Chrome cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { WebSocketServer } from 'ws';
import { openBrowser, renderBrowsers } from './browser.mjs';

const pixel = (page) => page.evaluate(async () => {
  let adapter;
  for (let i = 0; i < 100 && !adapter; i++) {
    adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) await new Promise((r) => setTimeout(r, 50));
  }
  if (!adapter) throw new Error('No WebGPU adapter');
  const device = await adapter.requestDevice();
  try {
    const canvas = document.querySelector('canvas');
    canvas.getContext('webgpu').configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The hidden canvas did not paint')), 10000);
      canvas.addEventListener('paint', () => { clearTimeout(timeout); resolve(); }, { once: true });
      canvas.requestPaint();
    });
    const texture = device.createTexture({ size: [32, 32], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    device.queue.copyElementImageToTexture({ source: document.querySelector('div') }, { destination: { texture } });
    const buffer = device.createBuffer({ size: 256 * 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const commands = device.createCommandEncoder();
    commands.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [32, 32]);
    device.queue.submit([commands.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(buffer.getMappedRange());
    const rgba = Array.from(data.slice(16 * 256 + 16 * 4, 16 * 256 + 16 * 4 + 4));
    buffer.unmap();
    return rgba;
  } finally { device.destroy(); }
});

test('bundled Electron renders hidden HTML, fresh pages and screenshots without another browser', { timeout: 60000 }, async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><body style="margin:0"><canvas layoutsubtree width="32" height="32"><div style="position:absolute;left:0;top:0;width:32px;height:32px;background:${req.url === '/green' ? 'rgb(20,210,70)' : 'rgb(230,30,50)'}"></div></canvas></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browsers = [];
  t.signal.addEventListener('abort', () => { for (const b of browsers) b.close().catch(() => {}); });
  try {
    const a = await openBrowser(); browsers.push(a);
    const b = await openBrowser(); browsers.push(b);
    const first = await a.newPage({ viewport: { width: 32, height: 32 } });
    await first.goto(url);
    assert.deepEqual(await pixel(first), [230, 30, 50, 255]);
    await first.evaluate(() => localStorage.setItem('film-state', 'previous page'));
    await first.close();
    const fresh = await a.newPage({ viewport: { width: 32, height: 32 } });
    await fresh.goto(url + '/green');
    assert.equal(await fresh.evaluate(() => localStorage.getItem('film-state')), null);
    assert.deepEqual(await pixel(fresh), [20, 210, 70, 255]);
    await a.close(); browsers.splice(browsers.indexOf(a), 1);
    const remaining = await b.newPage({ viewport: { width: 16, height: 16 } });
    await remaining.goto(url);
    assert.deepEqual(await pixel(remaining), [230, 30, 50, 255]);
    // Icon and inspection tools screenshot ordinary DOM/SVG, not the capture canvas after destroying its GPU device.
    const icon = await b.newPage({ viewport: { width: 16, height: 16 } });
    await icon.setContent('<body style="margin:0"><svg width="16" height="16"><rect width="16" height="16" fill="rgb(230,30,50)"/></svg></body>');
    const png = await icon.screenshot();
    assert.equal(png.readUInt32BE(16), 16);
    assert.equal(png.readUInt32BE(20), 16);
    const rgba = execFileSync(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { input: png, windowsHide: true });
    assert.deepEqual([...rgba.subarray((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)], [230, 30, 50, 255]);
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
    await new Promise((r) => server.close(r));
  }
});

// What a browser and every process under it take in memory now, in MB, with what they share counted once.
function memoryMB(main) {
  const parent = new Map();
  for (const n of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try { const stat = fs.readFileSync(`/proc/${n}/stat`, 'utf8'); parent.set(+n, +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]); } catch { /* it ended */ }
  }
  const under = (p) => p === main || (parent.has(p) && under(parent.get(p)));
  let kB = 0;
  for (const p of parent.keys()) if (under(p)) { try { kB += +/^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${p}/smaps_rollup`, 'utf8'))[1]; } catch { /* it ended */ } }
  return kB / 1024;
}

test('a render browser does not keep every picture a page has drawn', { skip: process.platform !== 'linux' && 'reads memory from /proc', timeout: 120000 }, async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><body style="margin:0"><canvas layoutsubtree width="1600" height="1600"><div style="position:absolute;left:0;top:0;width:1600px;height:1600px"></div></canvas></body>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await openBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1600 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const main = [...renderBrowsers].at(-1), before = memoryMB(main);
    // 60 pictures of 10 MB each, drawn at full size on one layer: 600 MB decoded
    await page.evaluate(async () => {
      let adapter;
      for (let i = 0; i < 100 && !adapter; i++) {
        adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) await new Promise((r) => setTimeout(r, 50));
      }
      const device = await adapter.requestDevice(), canvas = document.querySelector('canvas'), layer = document.querySelector('div');
      const picture = new OffscreenCanvas(1600, 1600), g = picture.getContext('2d');
      for (let i = 0; i < 60; i++) {
        g.fillStyle = `rgb(${i * 4},100,${240 - i * 4})`;
        g.fillRect(0, 0, 1600, 1600);
        const img = new Image();
        img.src = URL.createObjectURL(await picture.convertToBlob());
        img.style.cssText = 'position:absolute;left:0;top:0;width:1600px;height:1600px;opacity:0.05';
        await img.decode();
        layer.append(img);
      }
      canvas.getContext('webgpu').configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
      await new Promise((r) => { canvas.addEventListener('paint', r, { once: true }); canvas.requestPaint(); });
      const texture = device.createTexture({ size: [1600, 1600], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      device.queue.copyElementImageToTexture({ source: layer }, { destination: { texture } });
      await device.queue.onSubmittedWorkDone();
      device.destroy();
    });
    await new Promise((r) => setTimeout(r, 2000));
    const grew = memoryMB(main) - before;
    assert.ok(grew < 500, `the browser grew by ${Math.round(grew)} MB for 600 MB of pictures it has finished drawing`);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

test("a render page's frame for the studio's window lands in a file byte for byte, and goes with its browser", { timeout: 60000 }, async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><body></body>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const tools = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => tools.once('listening', r));
  const said = new Promise((r) => tools.on('connection', (s) => s.on('message', (m) => r(JSON.parse(String(m))))));
  const browser = await openBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 32, height: 32 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async (port) => {
      await window.__frames.open(port);
      const memory = await new Promise((r) => { addEventListener('message', (e) => { if (e.data === 'frames-port') r(e.ports[0]); }); window.__frames.share(); });
      memory.postMessage(Uint8Array.from({ length: 4 * 32 * 32 }, (_, i) => (i * 7) & 255));
      memory.postMessage({ w: 32, h: 32 });
    }, tools.address().port);
    const head = await said;
    assert.deepEqual([head.w, head.h], [32, 32]);
    assert.deepEqual([...fs.readFileSync(head.file)], Array.from({ length: 4 * 32 * 32 }, (_, i) => (i * 7) & 255));
    await browser.close();
    assert.equal(fs.existsSync(head.file), false);
  } finally {
    await browser.close().catch(() => {});
    tools.close();
    await new Promise((r) => server.close(r));
  }
});
