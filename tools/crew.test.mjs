// How many render workers draw the cache (worker.mjs crew): measured, and fewer once the GPU has run out of memory, in the
// runs after it too
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-'));   // (this machine's settings: a fresh one)
const { crew } = await import('./worker.mjs');
const { configure } = await import('./workspace.mjs');

// the workers' frames, as a measure of fps frames a second takes them: one decision of the crew's
let clock = 1e9;
Date.now = () => clock;
function measure(team, fps) {
  team.done(team.n - 1);   // (its newest worker's first frame starts the measure)
  const n = team.n;
  for (let i = 0; i < 200 && team.n === n; i++) { clock += 1000 / fps; team.done(0); }
}

test('dynamic: one more while it is faster, one fewer when the GPU runs out, and no more in the next run', () => {
  configure({ workers: 'dynamic' });
  const team = crew(8);
  measure(team, 10); measure(team, 20);
  assert.equal(team.n, 3);
  team.full();
  assert.equal(team.n, 2);
  team.reset();   // (a new run, after an edit)
  assert.equal(team.n, 1);
  measure(team, 10); measure(team, 20); measure(team, 40);
  assert.equal(team.n, 2);
});

test('the setting changed: as many as help again', () => {
  configure({ workers: 'dynamic' });
  const team = crew(8);
  measure(team, 10); measure(team, 20); team.full();
  team.rechoose();
  measure(team, 10); measure(team, 20);
  assert.equal(team.n, 3);
});

test('a number of workers set: that many, fewer where the GPU had no room for them', () => {
  configure({ workers: 3 });
  const team = crew(8);
  assert.equal(team.n, 3);
  team.full();
  team.reset();
  assert.equal(team.n, 2);
});

test('dynamic: one more only where the GPU has room for it', () => {
  configure({ workers: 'dynamic' });
  let free = 2;   // (how many more the GPU has room for)
  const team = crew(8, () => {}, () => free > 0);
  measure(team, 10); free--; measure(team, 20); free--;
  assert.equal(team.n, 3);
  measure(team, 40);   // (faster, but no room)
  assert.equal(team.n, 3);
});
