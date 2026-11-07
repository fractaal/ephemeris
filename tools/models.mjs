// The studio's models (docs/studio.md, "What the studio runs"): ONNX files, run by onnxruntime (onnxruntime-web), the
// one model runtime. Each model in MODELS says where its file comes from (shipped in tools/models, or downloaded once
// per machine into ~/.cache/ephemeris/models and checked by its sha256) and where it runs:
//   gpu  WebGPU, in the studio's Electron on the machine's high-performance adapter; its WebAssembly where WebGPU
//        fails. Fast; a result can differ in its last digits from one GPU to another.
//   cpu  WebAssembly in this Node: the same result on every machine (for a measure each machine makes for itself).
//
//   const m = await model('depth-anything-v2-small');
//   const { predicted_depth } = await m.run({ pixel_values: { data: Float32Array, dims: [1, 3, h, w] } });   // → { data, dims }
//   await closeModels();   // (the GPU page also closes itself a minute after its last run)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(os.homedir(), '.cache', 'ephemeris', 'models');
// (onnxruntime-web's builds: Node loads its entry, the GPU page its WebGPU build and that build's WebAssembly)
const ORT = path.dirname(fileURLToPath(import.meta.resolve('onnxruntime-web')));
const THREADS = Math.min(8, Math.ceil(os.availableParallelism() / 2));   // (half the machine)

/** The models, by name: tools/models/README.md says where each came from, its licence and how it was checked. */
export const MODELS = {
  'beat_this-small0': { file: path.join(HERE, 'models', 'beat_this-small0.onnx'), on: 'cpu' },
  'basic-pitch': { file: path.join(HERE, 'models', 'basic_pitch-icassp_2022.onnx'), on: 'cpu' },
  'depth-anything-v2-small': {
    url: 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx',
    sha256: 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c', on: 'gpu',
  },
  'big-lama': {
    url: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx',
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6', on: 'gpu',
  },
};

// ---------- the file: shipped, or downloaded once (to a .part file, renamed only once its sha256 is right)
async function fileOf(name, m) {
  if (m.file) return m.file;
  const file = path.join(CACHE, `${name}.onnx`);
  if (fs.existsSync(file)) return file;
  console.error(`ephemeris: downloading the model ${name} once, into ${CACHE}`);
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`could not download ${m.url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer()), sum = crypto.createHash('sha256').update(buf).digest('hex');
  if (sum !== m.sha256) throw new Error(`${name}: the download's sha256 is ${sum}, not ${m.sha256}`);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(`${file}.part`, buf);
  fs.renameSync(`${file}.part`, file);
  return file;
}

const TYPES = { Float32Array: 'float32', Int32Array: 'int32', BigInt64Array: 'int64', Uint8Array: 'uint8', Int8Array: 'int8', Float64Array: 'float64' };
const ARRAYS = { float32: Float32Array, int32: Int32Array, int64: BigInt64Array, uint8: Uint8Array, int8: Int8Array, float64: Float64Array, bool: Uint8Array };

/** A model, ready to run: `.run(feeds)` (each input `{ data, dims }`) → its outputs, each `{ data, dims }`; `.on`:
 *  'webgpu' or 'wasm', where it runs. */
export async function model(name) {
  const m = MODELS[name];
  if (!m) throw new Error(`no model named ${name} (tools/models.mjs: ${Object.keys(MODELS).join(', ')})`);
  const file = await fileOf(name, m);
  return m.on === 'gpu' ? gpuModel(name, file) : cpuModel(file);
}

// ---------- cpu: onnxruntime's WebAssembly, here in Node
async function cpuModel(file) {
  const ort = await import('onnxruntime-web');
  ort.env.logLevel = 'error';
  ort.env.wasm.numThreads = THREADS;
  const session = await ort.InferenceSession.create(fs.readFileSync(file));
  return {
    on: 'wasm',
    async run(feeds) {
      const out = await session.run(Object.fromEntries(Object.entries(feeds).map(([k, t]) => [k, new ort.Tensor(TYPES[t.data.constructor.name], t.data, t.dims)])));
      return Object.fromEntries(Object.entries(out).map(([k, t]) => [k, { data: t.data, dims: t.dims }]));
    },
    close: () => session.release?.(),
  };
}

// ---------- gpu: one rendering Electron for this process, with a page that runs the models, served from here on
// 127.0.0.1 (a secure context, which WebGPU needs; cross-origin isolated, which the WebAssembly fallback's threads need).
// Models and tensors cross over HTTP as raw bytes (not over DevTools, whose pipe stops at 100 MB): the page fetches a
// run's inputs and posts its outputs. Linux runs offscreen and headless, independent of the desktop's display GPU.
const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import * as ort from '/ort/ort.webgpu.min.mjs';
ort.env.wasm.wasmPaths = '/ort/';
ort.env.wasm.numThreads = ${THREADS};
ort.env.logLevel = 'error';
// the adapter, asked for as the engine does (the first ask can come back empty): handed to onnxruntime, whose own ask can
let adapter = null;
for (let i = 0; i < 20 && !adapter; i++) { adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }); if (!adapter) await new Promise((r) => setTimeout(r, 250)); }
if (adapter) ort.env.webgpu.adapter = adapter;
const sessions = {}, ARRAYS = { float32: Float32Array, int32: Int32Array, int64: BigInt64Array, uint8: Uint8Array, int8: Int8Array, float64: Float64Array, bool: Uint8Array };
window.load = async (name) => {
  sessions[name] ??= await ort.InferenceSession.create('/model/' + name, { executionProviders: adapter ? ['webgpu', 'wasm'] : ['wasm'] });
  return { on: adapter ? 'webgpu' : 'wasm', gpu: adapter ? [adapter.info.vendor, adapter.info.architecture].filter(Boolean).join(' ') : null };
};
window.run = async (name, id, inputs) => {
  const feeds = {};
  for (const [k, { type, dims }] of Object.entries(inputs)) feeds[k] = new ort.Tensor(type, new ARRAYS[type](await (await fetch('/in/' + id + '/' + k)).arrayBuffer()), dims);
  const out = await sessions[name].run(feeds), meta = {};
  for (const [k, t] of Object.entries(out)) {
    const data = t.location === 'cpu' ? t.data : await t.getData();
    await fetch('/out/' + id + '/' + k, { method: 'POST', body: data });
    meta[k] = { type: t.type, dims: t.dims };
  }
  return meta;
};
window.ready = true;
</script>`;

let gpu = null, idle = null;
const transfers = new Map();
const ISO = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
function serve(q, r) {
  const [, kind, a, b] = decodeURIComponent(new URL(q.url, 'http://x').pathname).split('/');
  const send = (type, body) => { r.writeHead(200, { ...ISO, 'Content-Type': type }); r.end(body); };
  const file = (type, f) => { r.writeHead(200, { ...ISO, 'Content-Type': type, 'Content-Length': fs.statSync(f).size }); fs.createReadStream(f).pipe(r); };
  if (kind === 'out') { const parts = []; q.on('data', (d) => parts.push(d)); q.on('end', () => { transfers.set(`out/${a}/${b}`, Buffer.concat(parts)); send('text/plain', ''); }); return; }
  if (kind === 'in' && transfers.has(`in/${a}/${b}`)) return send('application/octet-stream', transfers.get(`in/${a}/${b}`));
  if (kind === 'model' && MODELS[a]) return fileOf(a, MODELS[a]).then((f) => file('application/octet-stream', f), () => { r.writeHead(500); r.end(); });
  if (kind === 'ort' && fs.existsSync(path.join(ORT, path.basename(a)))) return file(a.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', path.join(ORT, path.basename(a)));
  if (!kind) return send('text/html', PAGE);
  r.writeHead(404); r.end();
}
async function page() {
  clearTimeout(idle);
  gpu ??= (async () => {
    const server = http.createServer(serve);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const browser = await openBrowser().catch((e) => { server.close(); throw e; });
    const p = await browser.newPage();
    p.on('crash', () => console.error('[models] the GPU page crashed'));
    p.on('pageerror', (e) => console.error('[models]', e.message));
    if (process.env.EPHEMERIS_MODELS_DEBUG) p.on('console', (m) => console.error('[models page]', m.text().slice(0, 300)));
    await p.goto(`http://127.0.0.1:${server.address().port}/`);
    await p.waitForFunction(() => window.ready === true, null, { timeout: 60_000 });
    return { browser, server, p };
  })();
  return (await gpu).p;
}
const later = () => { clearTimeout(idle); idle = setTimeout(closeModels, 60_000); idle.unref?.(); };

let ids = 0;
async function gpuModel(name, file) {
  const p = await page();
  const { on, gpu: adapter } = await p.evaluate((n) => window.load(n), name);
  later();
  return {
    on, adapter,
    async run(feeds) {
      const id = String(++ids), inputs = {};
      for (const [k, t] of Object.entries(feeds)) {
        transfers.set(`in/${id}/${k}`, Buffer.from(t.data.buffer, t.data.byteOffset, t.data.byteLength));
        inputs[k] = { type: TYPES[t.data.constructor.name], dims: t.dims };
      }
      const meta = await (await page()).evaluate(([n, i, inp]) => window.run(n, i, inp), [name, id, inputs]);
      const out = {};
      for (const [k, { type, dims }] of Object.entries(meta)) {
        const buf = transfers.get(`out/${id}/${k}`), A = ARRAYS[type];
        out[k] = { data: new A(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), dims };
        transfers.delete(`out/${id}/${k}`);
      }
      for (const k of Object.keys(feeds)) transfers.delete(`in/${id}/${k}`);
      later();
      return out;
    },
    close: () => {},
  };
}

/** Closes the GPU page and its rendering process. */
export async function closeModels() {
  clearTimeout(idle);
  const g = gpu;
  gpu = null;
  if (!g) return;
  const { browser, server } = await g;
  await browser.close().catch(() => {});
  server.close();
}
