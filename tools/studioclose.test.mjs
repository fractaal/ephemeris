// Real studio, real film page: closing a timeline, an editor connected and its worker open, is no failure of the studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const freePort = async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
};
const FILM = `import { createFilm } from '../../engine/runtime.js';
import { cam } from '../../engine/camera.js';
import { box } from '../../engine/mesh.js';
const F = createFilm(), cube = F.mesh(box({ w: 100 }), { label: 'cube' });
F.run({ duration: 2, scene: () => ({ camera: cam(), environment: { backdrop: '#202020' }, nodes: [cube.at(0, 0, 0)] }) });
`;

test('a timeline renamed under an open editor leaves the studio running, and the studio then ends cleanly', { timeout: 240000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-close-')), ws = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(ws, 'projects'), { recursive: true });
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, EPHEMERIS_WORKSPACE: ws, EPHEMERIS_SHARED: root };
  for (const k of ['XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete env[k];
  const made = spawnSync(process.execPath, [path.join(root, 'tools/ephemeris.mjs'), 'new', 'closing'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const dir = path.join(ws, 'projects', 'closing'), filmPort = await freePort(), port = await freePort(), kids = [];
  fs.writeFileSync(path.join(dir, 'film.js'), FILM);
  // (a second timeline: main keeps its name)
  const timeline = JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'timelines', 'main.json'), 'utf8')), url: `http://localhost:${filmPort}/projects/closing/`, fps: 24 });
  fs.writeFileSync(path.join(dir, 'timelines', 'main.json'), timeline);
  fs.writeFileSync(path.join(dir, 'timelines', 'cut.json'), timeline);
  // (each in a group of its own, so that what it starts, the film's server, ends with it)
  const start = (args) => { const p = spawn(process.execPath, args, { cwd: root, env, stdio: 'ignore', detached: true }); kids.push(p); return p; };
  const up = async (url) => { for (let i = 0; i < 600; i++) { if (await fetch(url).then((r) => r.ok, () => false)) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`${url} did not start`); };
  const editors = [];
  // (an editor connected, with what it hears held open; and a worker opened for the timeline)
  const openEditor = async (base) => {
    const c = new AbortController();
    editors.push(c);
    await fetch(`${base}api/events`, { signal: c.signal });
    await (await fetch(`${base}api/director/path`, { method: 'POST', body: JSON.stringify({ times: [1] }) })).json();
  };
  try {
    start([path.join(root, 'tools/ephemeris.mjs'), 'serve', '--port', String(filmPort), '--strictPort']);
    await up(`http://localhost:${filmPort}/projects/closing/`);
    const studio = start([path.join(root, 'tools/nle.mjs'), 'closing', '--port', String(port)]);
    const ended = new Promise((r) => studio.once('exit', (code, signal) => r({ code, signal })));
    await up(`http://localhost:${port}/api/studio`);
    await up(`http://localhost:${port}/p/closing/cut/`);
    await openEditor(`http://localhost:${port}/p/closing/cut/`);

    const renamed = await fetch(`http://localhost:${port}/api/projects/closing/timelines/cut`, { method: 'PATCH', body: JSON.stringify({ to: 'cut2' }) });
    assert.equal(renamed.status, 200, await renamed.text());
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await fetch(`http://localhost:${port}/api/studio`).catch(() => ({ ok: false }))).ok, true, 'the studio died when the timeline closed');

    await up(`http://localhost:${port}/p/closing/cut2/`);
    await openEditor(`http://localhost:${port}/p/closing/cut2/`);
    process.kill(studio.pid, 'SIGTERM');
    assert.deepEqual(await ended, { code: 0, signal: null });
  } finally {
    for (const c of editors) c.abort();
    for (const p of kids) try { process.kill(-p.pid); } catch { /* ended */ }
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
