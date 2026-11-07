// A film's scene at a moment, as its rays see it, for hardware-rays to measure on: dump.mjs <film page> <t> <dir>
// the renderer's own tables, every mesh's geometry, the WGSL its shaders start with and the camera, as a frame drew them.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { openBrowser } from '../../../tools/browser.mjs';
const [,, url, tArg, dir] = process.argv, t = +tArg;
fs.mkdirSync(dir, { recursive: true });
const srv = http.createServer((q, r) => { const f = fs.createWriteStream(path.join(dir, q.url.slice(1))); q.pipe(f); f.on('finish', () => { r.setHeader('access-control-allow-origin', '*'); r.end('ok'); }); });
await new Promise((d) => srv.listen(0, '127.0.0.1', d));
const br = await openBrowser(); const p = await br.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[page]', e.message));
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => window.__ready === true || window.__bootError, null, { timeout: 300000 });
const out = await p.evaluate(async ([t, port]) => {
  if (window.__bootError) return { error: window.__bootError };
  const { comp, dev } = window.__ephemeris, got = {};
  const put = comp.put; comp.put = function (name, data, usage) { if (name === 'scn' || name === 'inst' || name === 'sp') got[name] = data.slice(); return put.call(this, name, data, usage); };
  const write = dev.queue.writeBuffer; dev.queue.writeBuffer = function (buffer, off, data, ...more) { if (buffer === comp.camBuf) got.cam = data.slice(); if (buffer === comp.worldBuf) got.world = data.slice(); return write.call(this, buffer, off, data, ...more); };
  const t0 = performance.now(); await window.__frame(t, 1, 0.5, 24, 1); const firstMs = performance.now() - t0;
  comp.put = put; dev.queue.writeBuffer = write;
  const g = comp.geometry, b = dev.createBuffer({ size: g.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), e = dev.createCommandEncoder();
  e.copyBufferToBuffer(g.buf, 0, b, 0, g.size); dev.queue.submit([e.finish()]); await b.mapAsync(GPUMapMode.READ);
  const send = (name, body) => fetch(`http://127.0.0.1:${port}/${name}`, { method: 'POST', mode: 'cors', body });
  await send('geo.bin', new Uint8Array(b.getMappedRange()).slice()); b.destroy();
  for (const k of ['scn', 'inst', 'sp', 'cam', 'world']) await send(`${k}.bin`, got[k]);
  const [W, H] = window.__size;
  await send('prelude.wgsl', comp.prelude().replace(/__(W2|H2|W|H)__/g, (_, k) => ({ W, H, W2: W / 2, H2: H / 2 })[k]));
  const models = new Map();
  const meshes = comp.sub.meshes.map((n) => { const r = g.of(n.mesh.geo); if (!models.has(r.vertex)) models.set(r.vertex, { vertex: r.vertex, index: r.index, count: r.count, vertices: n.mesh.geo.pos.length / 3 }); return { model: r.vertex, first: n.first, copies: n.instances.length, solid: !!n.mesh.solid, glass: !!n.material.glass, label: n.label ?? n.mesh.label ?? '' }; });
  await send('scene.json', JSON.stringify({ W, H, drawn: [comp.pw, comp.ph], tables: comp.tables, meshes, models: [...models.values()], instanceFloats: got.inst.length / Math.max(1, meshes.reduce((a, m) => a + m.copies, 0)) }));
  return { firstMs, meshes: meshes.length, copies: meshes.reduce((a, m) => a + m.copies, 0), solidCopies: meshes.filter((m) => m.solid).reduce((a, m) => a + m.copies, 0), glassCopies: meshes.filter((m) => m.glass).reduce((a, m) => a + m.copies, 0), models: models.size, triangles: [...models.values()].reduce((a, m) => a + m.count / 3, 0), sceneTriangles: meshes.reduce((a, m) => a + models.get(m.model).count / 3 * m.copies, 0), geoMB: g.size / 1e6, scnMB: got.scn.byteLength / 1e6 };
}, [t, srv.address().port]);
console.log(JSON.stringify(out));
await br.close(); srv.close(); process.exit(0);
