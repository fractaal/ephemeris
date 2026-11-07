// Run on each supported OS: a workspace stays usable without symlink privileges, and switching studios preserves
// the director's files. Exercise the public workspace entry point in separate processes, as app launches do.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const module = new URL('./workspace.mjs', import.meta.url).href;
const WIN = process.platform === 'win32';
const read = (f) => fs.readFileSync(f, 'utf8');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-workspace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'Films & études');
  const studio = (version) => {
    const at = path.join(dir, `Studio & études ${version}`);
    for (const folder of ['engine', 'elements', 'assets', 'nle', 'docs', '.agents/skills']) {
      fs.mkdirSync(path.join(at, folder), { recursive: true });
      fs.writeFileSync(path.join(at, folder, 'version.txt'), version);
    }
    for (const file of ['AGENTS.md', 'CLAUDE.md']) fs.writeFileSync(path.join(at, file), `Instructions ${version}`);
    fs.writeFileSync(path.join(at, 'ephemeris.cmd'), `@echo off\r\necho ${version} %*\r\n`);
    fs.writeFileSync(path.join(at, 'ephemeris'), `#!/bin/sh\nprintf '${version} %s\\n' "$*"\n`, { mode: 0o755 });
    return at;
  };
  const launch = (from) => execFileSync(process.execPath, ['--input-type=module', '-e', `import { workspace } from ${JSON.stringify(module)}; workspace();`], {
    env: { ...process.env, EPHEMERIS_WORKSPACE: ws, EPHEMERIS_SHARED: from }, windowsHide: true,
  });
  return { dir, ws, studio, launch };
}

test('a workspace follows the active studio and its command line, while preserving the films', (t) => {
  const { ws, studio, launch } = fixture(t);
  const a = studio('one'), b = studio('two');
  launch(a);
  const film = path.join(ws, 'projects', 'film.txt');
  fs.writeFileSync(film, 'The director’s film');
  for (const [from, want] of [[a, 'one'], [b, 'two']]) {
    launch(from);
    assert.equal(read(path.join(ws, 'engine', 'version.txt')), want);
    assert.equal(read(path.join(ws, '.claude', 'skills', 'version.txt')), want);
    assert.equal(read(path.join(ws, 'AGENTS.md')), `Instructions ${want}`);
    assert.equal(read(path.join(ws, 'CLAUDE.md')), `Instructions ${want}`);
    assert.equal(read(film), 'The director’s film');
    const output = WIN
      ? execFileSync('cmd.exe', ['/d', '/s', '/c', `""${path.join(ws, 'ephemeris.cmd')}" check film"`], { encoding: 'utf8', windowsVerbatimArguments: true })
      : execFileSync(path.join(ws, 'ephemeris'), ['check', 'film'], { encoding: 'utf8' });
    assert.equal(output.trim(), `${want} check film`);
    if (WIN) {
      const bash = path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe');
      if (fs.existsSync(bash)) {
        const text = execFileSync(bash, ['--noprofile', '--norc', '-c', './ephemeris check film'], { cwd: ws, encoding: 'utf8', windowsHide: true });
        assert.equal(text.trim(), `${want} check film`);
      } else t.diagnostic('Git Bash is not installed; its workspace launcher check was not run.');
    }
  }
});

test('the command line creates a film in a Unicode workspace', (t) => {
  const { ws, dir } = fixture(t);
  execFileSync(process.execPath, [fileURLToPath(new URL('./ephemeris.mjs', import.meta.url)), 'new', 'unicode-film'], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, EPHEMERIS_WORKSPACE: ws, EPHEMERIS_SHARED: '' }, windowsHide: true,
  });
  const project = path.join(ws, 'projects', 'unicode-film');
  assert.ok(read(path.join(project, 'film.js')).includes('createFilm'));
  assert.equal(JSON.parse(read(path.join(project, 'timelines', 'main.json'))).url, 'http://localhost:5320/projects/unicode-film/');
  assert.ok(read(path.join(project, 'history', 'versions.jsonl')).includes('new film'));
});

test('a workspace does not replace the director’s own instructions or folders', (t) => {
  const { ws, studio, launch } = fixture(t);
  const a = studio('one'), b = studio('two');
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'assets', 'own.txt'), 'Own assets');
  launch(a);
  const instructions = path.join(ws, 'AGENTS.md');
  if (!WIN) fs.unlinkSync(instructions);   // replace a Unix link, rather than editing the studio it links to
  fs.writeFileSync(instructions, 'Own instructions');
  launch(b);
  assert.equal(read(instructions), 'Own instructions');
  assert.equal(read(path.join(ws, 'assets', 'own.txt')), 'Own assets');
  assert.equal(read(path.join(ws, 'engine', 'version.txt')), 'two');
});
