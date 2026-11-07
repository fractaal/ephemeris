// Real studio, real film page: what the director is waiting on goes ahead of a long question about the film.
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
// (its code takes about 5 ms a moment, as a heavy film's does: lanes over its 720 frames take seconds)
const FILM = `import { createFilm } from '../../engine/runtime.js';
import { cam } from '../../engine/camera.js';
import { box } from '../../engine/mesh.js';
const F = createFilm(), cube = F.mesh(box({ w: 100 }), { label: 'cube' });
F.run({
  duration: 30,
  scene: (t) => { const end = performance.now() + 5; while (performance.now() < end); return { camera: cam(), environment: { backdrop: '#202020' }, nodes: [cube.at(0, 0, 0)] }; },
});
`;

test('a frame asked for during a long question about the film comes before its answer', { timeout: 240000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-turns-')), ws = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(ws, 'projects'), { recursive: true });
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, EPHEMERIS_WORKSPACE: ws, EPHEMERIS_SHARED: root };
  for (const k of ['XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete env[k];
  const run = (...a) => spawnSync(process.execPath, [path.join(root, 'tools/ephemeris.mjs'), ...a], { cwd: root, env, encoding: 'utf8' });
  const made = run('new', 'slow');
  assert.equal(made.status, 0, made.stderr);
  const dir = path.join(ws, 'projects', 'slow');
  fs.writeFileSync(path.join(dir, 'film.js'), FILM);
  const filmPort = await freePort(), port = await freePort(), kids = [];
  const timeline = path.join(dir, 'timelines', 'main.json');
  fs.writeFileSync(timeline, JSON.stringify({ ...JSON.parse(fs.readFileSync(timeline, 'utf8')), url: `http://localhost:${filmPort}/projects/slow/`, fps: 24 }));
  // (each in a group of its own, so that what it starts, the film's server, ends with it)
  const start = (args) => { const p = spawn(process.execPath, args, { cwd: root, env, stdio: 'ignore', detached: true }); kids.push(p); };
  const up = async (url) => { for (let i = 0; i < 600; i++) { if (await fetch(url).then((r) => r.ok, () => false)) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`${url} did not start`); };
  let viewer = null;
  try {
    start([path.join(root, 'tools/ephemeris.mjs'), 'serve', '--port', String(filmPort), '--strictPort']);
    await up(`http://localhost:${filmPort}/projects/slow/`);
    start([path.join(root, 'tools/nle.mjs'), 'slow', '--port', String(port)]);
    await up(`http://localhost:${port}/api/studio`);
    const base = `http://localhost:${port}/p/slow/main/`, post = (u, b) => fetch(base + u, { method: 'POST', body: JSON.stringify(b) });
    await up(base);
    viewer = new WebSocket(`${base.replace('http', 'ws')}api/viewer`);
    await new Promise((r, j) => { viewer.once('open', r); viewer.once('error', j); });
    const waiting = new Map();
    viewer.on('message', (m, binary) => {
      const head = binary ? JSON.parse(m.subarray(4, 4 + m.readUInt32LE(0))) : JSON.parse(String(m));
      if (head.id != null && !head.partial) { waiting.get(head.id)?.(head); waiting.delete(head.id); }
    });
    let id = 0;
    const camera = (await (await post('api/director/path', { times: [1] })).json())[0].camera;
    const frame = (yaw) => new Promise((resolve) => { const me = ++id; waiting.set(me, resolve); viewer.send(JSON.stringify({ type: 'director', id: me, t: 1, camera: { ...camera, yaw: camera.yaw + yaw }, scale: 0.25 })); });
    const first = await frame(0);
    assert.equal(first.kind, 'director', JSON.stringify(first));

    let answered = false;
    const lanes = post('api/lanes', { sel: { camera: true }, duration: 30, fps: 24, cuts: [], values: true }).then((r) => r.json()).then((a) => { answered = true; return a; });
    await new Promise((r) => setTimeout(r, 200));
    // (what the gizmo needs of a thing's lanes: the playhead's moment, without waiting for every frame)
    const moment = await (await post('api/lanes', { sel: { camera: true }, duration: 30, fps: 24, cuts: [], values: true, at: 1 })).json();
    assert.equal(answered, false, "one moment's lanes came after the whole film's, so they waited behind them");
    assert.ok(moment.props.some((q) => q.k === 'x'), JSON.stringify(moment).slice(0, 200));
    for (let i = 1; i <= 3; i++) {
      const fr = await frame(i);
      assert.equal(fr.kind, 'director', JSON.stringify(fr));
      assert.equal(answered, false, `frame ${i} came after the question was answered, so it waited behind it`);
    }
    const a = await lanes;
    assert.equal(a.kind, 'camera');
    assert.ok(a.props.length > 0);
  } finally {
    viewer?.close();
    for (const p of kids) try { process.kill(-p.pid); } catch { /* ended */ }
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
