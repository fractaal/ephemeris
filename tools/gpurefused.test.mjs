// Real studio, real film page, a real GPU: what the GPU refuses while it draws a frame (out of memory, say) comes out as a
// black or part-drawn picture, which must never be shown or kept as if it were the frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('../', import.meta.url));
const freePort = async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
};
// (from 2 s on, a buffer over the GPU's limit is asked for as each moment is drawn: refused at once, taking no memory)
const FILM = `import { createFilm } from '../../engine/runtime.js';
import { cam } from '../../engine/camera.js';
import { box } from '../../engine/mesh.js';
let device = null;
const encoder = GPUDevice.prototype.createCommandEncoder;
GPUDevice.prototype.createCommandEncoder = function (...a) { device = this; return encoder.apply(this, a); };
const F = createFilm(), cube = F.mesh(box({ w: 100 }), { label: 'cube' });
F.run({
  duration: 4,
  scene: (t) => {
    if (t >= 2) device?.createBuffer({ size: device.limits.maxBufferSize + 4, usage: GPUBufferUsage.STORAGE });
    return { camera: cam(), environment: { backdrop: '#202020' }, nodes: [cube.at(0, 0, 0)] };
  },
});
`;

test('a frame the GPU refused comes back as an error, and the next one is drawn on a page that works', { timeout: 240000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-refused-')), ws = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(ws, 'projects'), { recursive: true });
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, EPHEMERIS_WORKSPACE: ws, EPHEMERIS_SHARED: root };
  for (const k of ['XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete env[k];
  const made = spawnSync(process.execPath, [path.join(root, 'tools/ephemeris.mjs'), 'new', 'refused'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const dir = path.join(ws, 'projects', 'refused');
  fs.writeFileSync(path.join(dir, 'film.js'), FILM);
  const filmPort = await freePort(), port = await freePort(), kids = [];
  const timeline = path.join(dir, 'timelines', 'main.json');
  fs.writeFileSync(timeline, JSON.stringify({ ...JSON.parse(fs.readFileSync(timeline, 'utf8')), url: `http://localhost:${filmPort}/projects/refused/`, fps: 24 }));
  // (each in a group of its own, so that what it starts, the film's server, ends with it)
  const start = (args) => { const p = spawn(process.execPath, args, { cwd: root, env, stdio: 'ignore', detached: true }); kids.push(p); };
  const up = async (url) => { for (let i = 0; i < 600; i++) { if (await fetch(url).then((r) => r.ok, () => false)) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`${url} did not start`); };
  let viewer = null;
  try {
    start([path.join(root, 'tools/ephemeris.mjs'), 'serve', '--port', String(filmPort), '--strictPort']);
    await up(`http://localhost:${filmPort}/projects/refused/`);
    start([path.join(root, 'tools/nle.mjs'), 'refused', '--port', String(port)]);
    await up(`http://localhost:${port}/api/studio`);
    const base = `http://localhost:${port}/p/refused/main/`;
    await up(base);
    viewer = new WebSocket(`${base.replace('http', 'ws')}api/viewer`);
    await new Promise((r, j) => { viewer.once('open', r); viewer.once('error', j); });
    const waiting = new Map();
    viewer.on('message', (m, binary) => {
      const head = binary ? JSON.parse(m.subarray(4, 4 + m.readUInt32LE(0))) : JSON.parse(String(m));
      if (head.id != null && !head.partial) { waiting.get(head.id)?.(head); waiting.delete(head.id); }
    });
    let id = 0;
    const camera = (await (await fetch(`${base}api/director/path`, { method: 'POST', body: JSON.stringify({ times: [1] }) })).json())[0].camera;
    const frame = (t) => new Promise((resolve) => { const me = ++id; waiting.set(me, resolve); viewer.send(JSON.stringify({ type: 'director', id: me, t, camera, scale: 0.25 })); });

    const fine = await frame(1);
    assert.equal(fine.kind, 'director', JSON.stringify(fine));
    const refused = await frame(3);
    assert.equal(refused.kind, 'error', `the frame the GPU refused came back as a picture: ${JSON.stringify(refused)}`);
    assert.match(refused.error, /GPU error/);
    const after = await frame(1);
    assert.equal(after.kind, 'director', JSON.stringify(after));
  } finally {
    viewer?.close();
    for (const p of kids) try { process.kill(-p.pid); } catch { /* ended */ }
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
