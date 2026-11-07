import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runtime } from './runtime.mjs';

test('the app prepares its shared files in a Unicode user folder and provides its tools', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-runtime-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'Studio & études'), data = path.join(tmp, 'Données');
  for (const name of ['engine', 'elements', 'assets', 'nle', 'docs', '.agents']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'sample.txt'), 'shared content');
  }
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Studio instructions');
  const win = process.platform === 'win32', wasPath = process.env.PATH;
  // No installed Node or media tools may rescue a broken app launcher on Windows.
  if (win) process.env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  let r;
  try { r = await runtime({ root, data, exe: process.execPath }); }
  finally { process.env.PATH = wasPath; }
  assert.equal(fs.readFileSync(path.join(r.env.EPHEMERIS_SHARED, 'AGENTS.md'), 'utf8'), 'Studio instructions');
  assert.equal(fs.readFileSync(path.join(r.env.EPHEMERIS_SHARED, 'CLAUDE.md'), 'utf8'), 'Studio instructions');
  assert.equal(fs.readFileSync(path.join(r.env.EPHEMERIS_SHARED, 'engine', 'sample.txt'), 'utf8'), 'shared content');
  const opts = { env: r.env, encoding: 'utf8', windowsHide: true };
  assert.equal(execFileSync(r.node, ['-p', '6 * 7'], opts).trim(), '42');
  assert.match(execFileSync('ffmpeg', ['-version'], opts), /ffmpeg version/);
  assert.match(execFileSync('ffprobe', ['-version'], opts), /ffprobe version/);
  if (win) {
    assert.equal(execFileSync('cmd.exe', ['/d', '/s', '/c', 'node -p 6*7'], { ...opts, windowsVerbatimArguments: true }).trim(), '42');
    const bash = path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(bash)) assert.equal(execFileSync(bash, ['--noprofile', '--norc', '-c', 'node -p "6*7"'], opts).trim(), '42');
    else t.diagnostic('Git Bash is not installed; its launcher check was not run.');
  }
});
