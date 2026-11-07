// Debug: boots a film page, renders one frame, and reports layer captures and where nodes project.
import { openBrowser } from './browser.mjs';
const [,, url, t = '0'] = process.argv;
const br = await openBrowser();
const p = await br.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('console', (m) => console.log('[page]', m.text().slice(0, 200)));
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => window.__ready === true || window.__bootError, null, { timeout: 120000 });
console.log(await p.evaluate(async (t) => {
  if (window.__bootError) return window.__bootError;
  await window.__frame(t, 1, 0.5, 60);
  const { dev, comp, layers, film } = window.__ephemeris;
  const out = [];
  for (const L of layers.slice(0, 3)) {
    const r = L.el.getBoundingClientRect();
    // read the centre texel of the capture
    const buf = dev.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: L.gpu.capture, origin: [Math.floor(L.gpu.w / 2), Math.floor(L.gpu.h / 2), 0] }, { buffer: buf, bytesPerRow: 256 }, [1, 1]);
    dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const px = [...new Uint8Array(buf.getMappedRange()).slice(0, 4)];
    out.push(`${L.label} el ${Math.round(r.width)}x${Math.round(r.height)} tex ${L.gpu.w}x${L.gpu.h} centre px ${px}`);
  }
  const s = film.scene(t);
  out.push('camera ' + JSON.stringify(s.camera));
  out.push('node0 ' + JSON.stringify({ ...s.nodes[0], tex: !!s.nodes[0].tex }));
  return out.join('\n');
}, +t));
await br.close();
