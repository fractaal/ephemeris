import { Encoder, Decoder, pack } from './codec.mjs';

export async function install(port) {
  const { comp: R, dev, layers, film } = window.__ephemeris;
  if (film.render) throw new Error('Custom JS renderer overrides are outside this benchmark transport');
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = fail; });
  const encoder = new Encoder(), sent = new Map(), reads = new Map();
  const original = { sub: R.renderSub, finish: R.finish };
  const frames = new Map();
  let gpuError = null;
  dev.addEventListener('uncapturederror', (e) => { gpuError ??= e.error.message; });
  const check = () => { if (gpuError) throw new Error(gpuError); };
  const send = (bytes) => socket.send(bytes);
  async function readLayer(id, L) {
    let b = reads.get(id);
    const row = Math.ceil(L.width * 4 / 256) * 256;
    if (!b) { b = dev.createBuffer({ size: row * L.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); reads.set(id, b); }
    const e = dev.createCommandEncoder();
    e.copyTextureToBuffer({ texture: L.capture }, { buffer: b, bytesPerRow: row }, [L.width, L.height]);
    dev.queue.submit([e.finish()]); await b.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(b.getMappedRange()), data = new Uint8Array(L.width * L.height * 4);
    for (let y = 0; y < L.height; y++) data.set(mapped.subarray(y * row, y * row + L.width * 4), y * L.width * 4);
    b.unmap(); return { id, width: L.width, height: L.height, version: L.version, data };
  }
  const call = (t, o) => window.__frame(t, o.sub, o.shutter, o.fps, o.scale, undefined, 'accurate', 0, o.profile ?? false);
  window.__bench = {
    async baseline(t, o) {
      check(); let subs = 0, result;
      R.renderSub = function (...a) { subs++; return original.sub.apply(this, a); };
      const start = performance.now();
      try { result = await call(t, o); } finally { R.renderSub = original.sub; }
      const renderMs = performance.now() - start; check();
      send(window.__last);
      return { renderMs, width: R.pw, height: R.ph, subs, profile: result[2], bands: R.bands };
    },
    async capture(t, o, draw = false) {
      const start = performance.now(), calls = []; let finish;
      R.renderSub = function (...a) { calls.push(encoder.value(a)); if (draw) return original.sub.apply(this, a); };
      R.finish = async function (...a) { finish = encoder.value(a); return draw ? original.finish.apply(this, a) : new Uint8Array(0); };
      try { await call(t, { ...o, profile: false }); } finally { R.renderSub = original.sub; R.finish = original.finish; }
      check();
      const prepared = performance.now();
      const images = [];
      for (const [id, L] of encoder.layers) if (sent.get(id) !== L.version) { images.push(await readLayer(id, L)); sent.set(id, L.version); }
      for (const [id, image] of encoder.bitmaps) if (!sent.has(id)) {
        const capture = dev.createTexture({ size: [image.width, image.height], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        dev.queue.copyExternalImageToTexture({ source: image }, { texture: capture }, [image.width, image.height]);
        images.push(await readLayer(id, { capture, width: image.width, height: image.height, version: 0 }));
        capture.destroy(); reads.get(id).destroy(); reads.delete(id); sent.set(id, 0);
      }
      const copied = performance.now();
      const frame = { calls, finish, frameInfo: R.frameInfo, scale: o.scale, bands: 8 };
      const meta = { frame, resources: encoder.drain(), size: window.__size, options: { gi: R.giAll ?? R.options?.gi ?? null, shadows: R.shadowsAll ?? R.options?.shadows ?? null } };
      const packet = pack(meta, images);
      if (draw) frames.set(t, frame);
      send(packet);
      return { prepareMs: prepared - start, layerReadbackMs: copied - prepared, serializeMs: performance.now() - copied, bytes: packet.length,
        imageBytes: images.reduce((n, x) => n + x.data.length, 0), captures: images.length, subs: calls.length, bands: R.bands };
    },
    async replay(t, profile = false) {
      const decoder = new Decoder(); decoder.objects = encoder.objects;
      const f = decoder.value(frames.get(t)); if (!f) throw new Error(`No captured frame ${t}`);
      R.resize(f.scale); R.frameInfo = f.frameInfo; R.bands = f.bands;
      if (profile) R.prof.begin();
      const start = performance.now();
      for (const a of f.calls) original.sub.apply(R, a);
      const pixels = await original.finish.apply(R, f.finish);
      check();
      const renderMs = performance.now() - start;
      const took = profile ? await R.prof.end() : null;
      send(pixels); return { renderMs, profile: took, subs: f.calls.length };
    },
    close() { for (const b of reads.values()) b.destroy(); socket.close(); },
  };
  const limits = Object.fromEntries(['maxTextureDimension2D', 'maxStorageBufferBindingSize', 'maxBufferSize', 'maxColorAttachmentBytesPerSample', 'maxSampledTexturesPerShaderStage', 'maxStorageBuffersPerShaderStage'].map((k) => [k, dev.limits[k]]));
  const info = dev.adapterInfo;
  return { size: window.__size, duration: window.__duration, limits,
    adapter: info ? Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map((k) => [k, info[k]])) : null,
    layers: layers.map((L) => ({ label: L.label, live: L.live, width: L.w, height: L.h, res: L.res })),
  };
}
