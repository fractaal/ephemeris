// What the studio takes, as the page bar shows it: read from the running system, for what it has really started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { watchMachine } from './machine.mjs';

const CHILD = `const b = Buffer.alloc(300 * 2 ** 20, 1); for (;;) { for (let i = 0; i < b.length; i += 4096) b[i]++; }`;

test('a process the studio starts counts in what the studio takes, its memory and its CPU', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 60000 }, async () => {
  const child = spawn(process.execPath, ['-e', CHILD], { stdio: 'ignore' });
  let stop;
  try {
    const seen = await new Promise((resolve, reject) => {
      const giveUp = setTimeout(() => reject(new Error('it was never counted')), 45000);
      stop = watchMachine((m) => { const t = m.app?.parts.tools; if (t && t.ram > 200 * 2 ** 20 && t.cpu > 0) { clearTimeout(giveUp); resolve(m.app); } });
    });
    assert.ok(seen.ram >= seen.parts.tools.ram);
    assert.ok(seen.cpu >= 1, `CPU ${seen.cpu}%`);
  } finally { stop?.(); child.kill(); }
});
