// Real studio + real MCP transports, with temporary shared-live projects. No model calls or GPU required.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('concurrent editors and MCP agents stay on their projects and detect conflicting shared writes', { timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-projects-'));
  const ws = path.join(tmp, 'workspace');
  for (const name of ['alpha', 'beta']) {
    const dir = path.join(ws, 'projects', name);
    fs.mkdirSync(path.join(dir, 'timelines'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'film.js'), `// ${name}\n`);
    for (const tid of ['main', 'alternate']) fs.writeFileSync(path.join(dir, 'timelines', tid + '.json'), JSON.stringify({ version: 1, fps: 24, url: '', media: {}, tracks: [], cues: [], grid: { bpm: 120, beatsPerBar: 4 } }));
  }
  const reservation = net.createServer();
  await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const base = `http://localhost:${port}`;
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, EPHEMERIS_WORKSPACE: ws, EPHEMERIS_SHARED: root };
  const process_ = spawn(process.execPath, [path.join(root, 'tools/nle.mjs'), '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  process_.stderr.on('data', (s) => { log += s; });
  const clients = [];
  t.signal.addEventListener('abort', () => process_.kill());
  try {
    await new Promise((resolve, reject) => {
      process_.stdout.on('data', (s) => { log += s; if (String(s).includes('studio: http:')) resolve(); });
      process_.once('exit', (code) => reject(new Error(`Studio exited (${code}): ${log}`)));
      process_.once('error', reject);
    });
    const request = async (url, method = 'GET', body) => {
      const r = await fetch(base + url, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
      assert.ok(r.ok, `${method} ${url}: ${r.status} ${await (r.ok ? Promise.resolve('') : r.text())}`);
      return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
    };
    const connect = async (extra) => {
      const c = new Client({ name: 'concurrency-check', version: '1' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'tools/mcp.mjs'), '--studio', base, ...extra], env, cwd: ws, stderr: 'pipe' });
      await c.connect(transport); clients.push(c); return c;
    };
    const call = async (c, name, args = {}) => c.callTool({ name, arguments: args });
    const result = (r) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

    await request('/p/alpha/main/');
    const a = await request('/p/alpha/main/api/agent');
    const a2 = await request('/p/alpha/main/api/agent/new', 'POST', {});
    const mcpA = await connect(['--agent', a.id]);
    const mcpA2 = await connect(['--agent', a2.id]);
    const external = await connect([]);
    assert.equal(JSON.parse(result(await call(external, 'status'))).open, 'alpha/main');
    const first = await call(mcpA, 'timeline'), second = await call(mcpA2, 'timeline');
    assert.equal(first.isError, undefined);
    assert.equal(second.isError, undefined);

    await request('/p/beta/main/');
    const b = await request('/p/beta/main/api/agent');
    const mcpB = await connect(['--agent', b.id]);
    assert.equal(JSON.parse(result(await call(mcpA, 'status'))).open, 'alpha/main');
    assert.equal(JSON.parse(result(await call(mcpB, 'status'))).open, 'beta/main');
    assert.equal(JSON.parse(result(await call(external, 'status'))).open, 'alpha/main');
    assert.equal((await request('/p/alpha/main/api/state')).name, 'alpha');
    assert.equal((await request('/p/beta/main/api/state')).name, 'beta');

    const doc = JSON.parse(result(first));
    doc.cues.push({ id: 'cue-a', label: 'Alpha only', t: 1, dur: 0 });
    const write = await call(mcpA, 'write_timeline', { text: JSON.stringify(doc), message: 'Agent A writes while beta is visible' });
    assert.ok(!write.isError, result(write));
    const stale = await call(mcpA2, 'write_timeline', { text: result(second), message: 'Stale agent must not overwrite A' });
    assert.equal(stale.isError, true);
    assert.match(result(stale), /Nothing was written/);
    const alpha = await request('/p/alpha/main/api/state'), beta = await request('/p/beta/main/api/state');
    assert.equal(JSON.parse(alpha.text).cues[0].label, 'Alpha only');
    assert.deepEqual(JSON.parse(beta.text).cues, []);

    // The code APIs likewise keep sharing live files, without silently accepting stale bases.
    const original = await request('/p/alpha/main/api/code/file?path=film.js');
    await request('/p/alpha/main/api/code/file', 'PUT', { path: 'film.js', base: original.text, text: '// shared edit\n' });
    const conflict = await fetch(base + '/p/alpha/main/api/code/file', { method: 'PUT', body: JSON.stringify({ path: 'film.js', base: original.text, text: '// stale\n' }) });
    assert.equal(conflict.status, 409);
    assert.equal((await request('/p/alpha/main/api/code/file?path=film.js')).text, '// shared edit\n');
    assert.equal((await request('/p/beta/main/api/code/file?path=film.js')).text, '// beta\n');

    const switched = await call(mcpA, 'open', { project: 'alpha', timeline: 'alternate' });
    assert.ok(!switched.isError, result(switched));
    assert.equal(JSON.parse(result(await call(mcpA, 'status'))).open, 'alpha/alternate');
    assert.equal(JSON.parse(result(await call(mcpA2, 'status'))).open, 'alpha/main');
    assert.equal((await request('/api/studio')).open, 'beta/main');
    const cross = await call(mcpA, 'open', { project: 'beta' });
    assert.equal(cross.isError, true);
    assert.match(result(cross), /belongs to alpha/);
    assert.equal(JSON.parse(result(await call(mcpA, 'status'))).open, 'alpha/alternate');
    const projects = (await request('/api/studio')).projects;
    assert.deepEqual(projects.map((p) => p.name).sort(), ['alpha', 'beta']);
    assert.equal(projects.find((p) => p.name === 'alpha').agents.length, 2);
    assert.equal(projects.find((p) => p.name === 'beta').agents.length, 1);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    if (process_.exitCode === null) { const exited = once(process_, 'exit'); process_.kill(); await exited; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
