// Real studio, real film page, a real GPU: what the director changes loads the film again only where its pages read it,
// and a page loaded again makes its shaders ready again only where they could be new. The viewer says both as it does
// them ("loading the project", "compiling shaders": its workers' work, the editor's events), and its frames say what
// was drawn again (stale until drawn).
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
// (a cue read by its time, one read whole; a surface's WGSL and a number beside it in a module of the film's; each moment
// takes 40 ms of its code, so that making its shaders ready lasts long enough for the editor to be told of it)
const FILM = `import { createFilm, timeline } from '../../engine/runtime.js';
import { cam } from '../../engine/camera.js';
import { box } from '../../engine/mesh.js';
import { cues } from '../../elements/cues.js';
import { PAINT, SIZE } from './look.js';
const TL = await timeline(import.meta.url);
const F = createFilm(), C = cues(F, TL);
const drop = C.at('drop', 1), title = C.get('title');
const paint = F.surface(PAINT, { label: 'paint' }), cube = F.mesh(box({ w: SIZE }), { label: 'cube' });
const slow = () => { const end = performance.now() + 40; while (performance.now() < end); };
F.run({ duration: 2, scene: (t) => (slow(), { camera: cam(), environment: { backdrop: title?.label === 'dark' ? '#000000' : '#202020' }, nodes: [cube.at(t < drop ? -80 : 80, 0, 0, { surface: paint })] }) });
`;
const look = (red, size) => `export const PAINT = /* wgsl */\`fn surface(s: SurfaceIn) -> SurfaceOut { var o = asIs(s); o.base = vec3f(${red}, 0.3, 0.2); return o; }\`;
export const SIZE = ${size};
`;

test('a page is loaded again only for what it reads, and makes its shaders ready again only where they could be new', { timeout: 420000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-reloads-')), ws = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(ws, 'projects'), { recursive: true });
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, EPHEMERIS_WORKSPACE: ws, EPHEMERIS_SHARED: root };
  for (const k of ['XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete env[k];
  const made = spawnSync(process.execPath, [path.join(root, 'tools/ephemeris.mjs'), 'new', 'reloads'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const dir = path.join(ws, 'projects', 'reloads'), file = path.join(dir, 'timelines', 'main.json'), filmPort = await freePort(), port = await freePort(), kids = [];
  fs.writeFileSync(path.join(dir, 'film.js'), FILM);
  fs.writeFileSync(path.join(dir, 'look.js'), look(0.8, 100));
  const cue = (id, t) => ({ id, t, dur: 0, label: '', note: '' });
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), url: `http://localhost:${filmPort}/projects/reloads/`, fps: 24, cues: [cue('drop', 1), cue('title', 1.5)] }));
  const start = (args) => { const p = spawn(process.execPath, args, { cwd: root, env, stdio: 'ignore', detached: true }); kids.push(p); };
  const up = async (url) => { for (let i = 0; i < 600; i++) { if (await fetch(url).then((r) => r.ok, () => false)) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`${url} did not start`); };
  const ac = new AbortController();
  try {
    start([path.join(root, 'tools/ephemeris.mjs'), 'serve', '--port', String(filmPort), '--strictPort']);
    await up(`http://localhost:${filmPort}/projects/reloads/`);
    start([path.join(root, 'tools/nle.mjs'), 'reloads', '--port', String(port), '--workers', '1']);
    await up(`http://localhost:${port}/api/studio`);
    const base = `http://localhost:${port}/p/reloads/main/`;
    await up(base);

    // the editor's events, as they come: what the workers are on, and the viewer's frames
    const seen = [];
    const res = await fetch(`${base}api/events`, { signal: ac.signal });
    (async () => {
      let buf = '';
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data) seen.push({ type, data: JSON.parse(data) });
        }
      }
    })().catch(() => {});
    const mark = () => seen.length;
    const did = (from, what) => seen.slice(from).some((e) => e.type === 'working' && e.data.some((w) => w.what === what));
    const redrawn = (from) => seen.slice(from).some((e) => e.type === 'preview' && e.data.frames.includes('1'));
    const fresh = async (from) => {
      for (let i = 0; i < 1800; i++) {
        const p = seen.slice(from).filter((e) => e.type === 'preview').at(-1)?.data;
        if (p?.error) throw new Error(p.error);
        if (p && p.frames.length === 48 && /^[23]+$/.test(p.frames) && !p.working) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('the viewer\'s frames were not all drawn');
    };
    const settle = () => new Promise((r) => setTimeout(r, 3000));
    const edit = async (change) => {
      const text = fs.readFileSync(file, 'utf8'), d = JSON.parse(text);
      change(d);
      const r = await fetch(`${base}api/timeline`, { method: 'PUT', body: JSON.stringify({ text: JSON.stringify(d), base: text }) });
      assert.equal(r.status, 200, await r.text());
    };
    const noteOn = (id, note) => (d) => { d.cues.find((c) => c.id === id).note = note; };

    let at = mark();
    await fresh(at);
    assert.ok(did(at, 'warming'), 'the film\'s first page did not make its shaders ready');

    at = mark();
    await edit((d) => { d.cues.find((c) => c.id === 'drop').t = 0.5; });
    await fresh(at);
    assert.ok(did(at, 'loading'), 'a cue the film reads was moved and the film was not loaded again');
    assert.ok(!did(at, 'warming'), 'a page loaded again for a cue made its shaders ready again');

    at = mark();
    await edit(noteOn('drop', 'the cube crosses'));
    await settle();
    assert.ok(!did(at, 'loading') && !redrawn(at), 'a note on a cue the film reads only by its time loaded or drew the film again');

    at = mark();
    await edit((d) => { d.cues.find((c) => c.id === 'title').label = 'dark'; });
    await fresh(at);
    assert.ok(did(at, 'loading'), 'a label on a cue the film reads whole did not load the film again');

    at = mark();
    await edit((d) => { d.shutter = 90; });
    await fresh(at);
    assert.ok(redrawn(at), 'the shutter changed and the frames were not drawn again');
    assert.ok(!did(at, 'loading'), 'the shutter changed and the film was loaded again');

    at = mark();
    fs.writeFileSync(path.join(dir, 'NOTES.md'), '# What the cube does\n');
    await settle();
    assert.ok(!did(at, 'loading') && !redrawn(at), 'a file the film does not load loaded or drew it again');

    at = mark();
    fs.writeFileSync(path.join(dir, 'look.js'), look(0.8, 120));
    await fresh(at);
    assert.ok(did(at, 'loading'), 'a module of the film changed and the film was not loaded again');
    assert.ok(!did(at, 'warming'), 'the film\'s code changed but not its shaders, and they were made ready again');

    at = mark();
    fs.writeFileSync(path.join(dir, 'look.js'), look(0.2, 120));
    await fresh(at);
    assert.ok(did(at, 'warming'), 'a surface\'s WGSL changed and its shaders were not made ready');
  } finally {
    ac.abort();
    for (const p of kids) try { process.kill(-p.pid); } catch { /* ended */ }
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
