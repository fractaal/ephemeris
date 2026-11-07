import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Decoder, unpack } from './codec.mjs';

process.title = 'eph-native-bench';
let gpu, dev, R, decoder, failure, frames = new Map();
const at = (root, f) => pathToFileURL(path.join(root, f)).href;
async function init({ root, dawn, limits, size, options }) {
  const { create, globals } = await import(at(dawn, 'index.js'));
  Object.assign(globalThis, globals);
  gpu = create(['backend=vulkan']);
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No native WebGPU adapter');
  for (const [k, v] of Object.entries(limits)) if (adapter.limits[k] < v) throw new Error(`Native ${k} ${adapter.limits[k]} < browser ${v}`);
  dev = await adapter.requestDevice({ requiredLimits: limits, requiredFeatures: ['timestamp-query'] });
  dev.addEventListener('uncapturederror', (e) => { failure ??= e.error.message; console.error('[native GPU]', e.error.message); });
  dev.lost.then((i) => { if (i.reason !== 'destroyed') failure ??= i.message; });
  const { setFrame } = await import(at(root, 'engine/camera.js')); setFrame(size);
  const { Renderer } = await import(at(root, 'engine/render/index.js'));
  const { Mesh } = await import(at(root, 'engine/mesh.js'));
  const { Texture, Target, Pass } = await import(at(root, 'engine/pass.js'));
  const { Surface } = await import(at(root, 'engine/surface.js'));
  // Browser-decoded source images arrive as raw RGBA. Keep all texture/mipmap work in the
  // unmodified renderer; substitute only the web-platform image upload at the native boundary.
  dev.queue.copyExternalImageToTexture = ({ source, flipY }, destination, size) => {
    if (flipY || !source.pixels) throw new Error('Unsupported external image upload');
    dev.queue.writeTexture(destination, source.pixels, { bytesPerRow: source.width * 4 }, size);
  };
  R = new Renderer(dev, options);
  decoder = new Decoder({ Mesh, Texture, Target, Pass, Surface }, ({ width, height }) => R.allocLayer(width, height));
  const info = Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map((k) => [k, adapter.info[k]]));
  // Normalize only this benchmark process. Do not change machine-wide scheduler policies.
  try { execFileSync('chrt', ['-o', '-p', '0', String(process.pid)]); } catch {}
  return { pid: process.pid, adapter: info, features: [...dev.features], limits: Object.fromEntries(Object.keys(limits).map((k) => [k, dev.limits[k]])) };
}
function ingest(packet, key) {
  const start = performance.now(), { meta, images } = unpack(packet);
  decoder.add(meta.resources);
  const decoded = performance.now();
  for (const image of images) {
    const L = decoder.objects.get(image.id);
    if (L.capture) {
      dev.queue.writeTexture({ texture: L.capture }, image.data, { bytesPerRow: image.width * 4 }, [image.width, image.height]);
      R.buildMips(L); L.version = image.version;
    } else L.pixels = image.data;
  }
  const f = decoder.value(meta.frame); frames.set(key, f);
  return { decodeMs: decoded - start, uploadSubmitMs: performance.now() - decoded, subs: f.calls.length };
}
async function draw(key, { profile = false, pixels = false, fixedBands = false } = {}) {
  if (failure) throw new Error(failure);
  const f = frames.get(key); if (!f) throw new Error(`No native frame ${key}`);
  R.resize(f.scale); R.frameInfo = f.frameInfo;
  if (fixedBands) R.bands = f.bands;
  if (profile) R.prof.begin();
  const start = performance.now();
  for (const a of f.calls) R.renderSub(...a);
  const data = await R.finish(...f.finish), renderMs = performance.now() - start;
  const took = profile ? await R.prof.end() : null;
  if (failure) throw new Error(failure);
  return { renderMs, profile: took, width: R.pw, height: R.ph, bands: R.bands, ...(pixels && { pixels: Buffer.from(data) }) };
}
let chain = Promise.resolve();
process.on('message', (m) => {
  chain = chain.then(async () => {
    try {
      let result;
      if (m.command === 'init') result = await init(m);
      else if (m.command === 'ingest') result = ingest(m.packet, m.key);
      else if (m.command === 'draw') result = await draw(m.key, m.options);
      else if (m.command === 'frame') { const start = performance.now(), input = ingest(m.packet, m.key); result = { ...input, ...await draw(m.key, m.options), nativeMs: performance.now() - start }; }
      else if (m.command === 'close') { dev?.destroy(); gpu = null; process.send({ id: m.id, result: {} }, () => process.exit(0)); return; }
      else throw new Error(`Unknown command ${m.command}`);
      process.send({ id: m.id, result });
    } catch (e) { process.send({ id: m.id, error: e.stack }); }
  });
});
process.on('disconnect', () => { dev?.destroy(); process.exit(0); });
