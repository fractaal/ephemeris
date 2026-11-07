import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { holds } from './history.mjs';
import { pluginPath } from './plugins.mjs';

test('project code paths cannot use Windows separators or a drive to leave the project', () => {
  for (const file of ['folder\\..\\..\\outside.js', 'C:outside.js', 'C:/outside.js', '../outside.js']) {
    assert.equal(holds(os.tmpdir(), file), false, file);
  }
  assert.equal(holds(os.tmpdir(), 'scene/object.js'), true);
});

test('a plugin can be named by its native filesystem path', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-plugin-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Plugin & études.vst3');
  fs.writeFileSync(file, 'plugin discovery fixture');
  assert.equal(pluginPath(file), file);
});
