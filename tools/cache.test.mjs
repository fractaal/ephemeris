// The viewer's caches on a machine at its limit: Accurate's frames, which take long to make, outlast the other looks', which
// draw again at once. A home of its own, its files sparse: only their sizes matter.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ephemeris-cache-'));
process.env.HOME = HOME;
const GB = 1024 ** 3;
const { createCaches, setCacheLimit, PREVIEWS } = await import('./cache.mjs');

const folder = (film, look, gb = 0) => {
  const dir = path.join(PREVIEWS, film, 'main', look);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'preview.json'), '{}');
  if (gb) { const f = path.join(dir, '0.png'); fs.closeSync(fs.openSync(f, 'w')); fs.truncateSync(f, gb * GB); }
  return dir;
};
// (an open timeline's look: holds gb, gives up what it is asked to)
const open = (film, look, gb) => {
  const P = { dir: path.join(PREVIEWS, film, 'main', look), held: gb * GB, bytes: () => P.held,
    shed(excess, all) { const freed = all ? P.held : Math.min(P.held, excess); P.held -= freed; return freed; } };
  return P;
};
// (a look at the caches, past the few seconds it waits)
const settle = async (o) => { const c = createCaches(() => o); c.check(); await new Promise((r) => setTimeout(r, 3300)); };

before(() => setCacheLimit(10));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test("a closed project's other looks go, however much room there is, and its Accurate frames stay", async () => {
  const fast = folder('closed-a', 'preview-fast', 1), wire = folder('closed-a', 'preview-wire', 1), accurate = folder('closed-a', 'preview', 1);
  await settle({ previews: [], shown: new Set() });
  assert.equal(fs.existsSync(fast), false);
  assert.equal(fs.existsSync(wire), false);
  assert.equal(fs.existsSync(accurate), true);
  fs.rmSync(path.join(PREVIEWS, 'closed-a'), { recursive: true });
});

test("past the limit in Fast, Fast gives up its frames before a closed project loses its Accurate frames", async () => {
  const theirs = folder('closed-b', 'preview', 8);
  const fast = open('open-b', 'preview-fast', 4), accurate = open('open-b', 'preview', 1);
  await settle({ previews: [accurate, fast], shown: new Set([fast]) });
  assert.equal(fs.existsSync(theirs), true);
  assert.equal(accurate.held, 1 * GB);
  assert.ok(fast.held <= 1 * GB, `Fast still holds ${fast.held / GB} GB`);
  fs.rmSync(path.join(PREVIEWS, 'closed-b'), { recursive: true });
});

test('past the limit in Fast, the open project keeps its Accurate frames', async () => {
  const fast = open('open-c', 'preview-fast', 9), accurate = open('open-c', 'preview', 5);
  await settle({ previews: [accurate, fast], shown: new Set([fast]) });
  assert.equal(accurate.held, 5 * GB);
  assert.equal(accurate.held + fast.held <= 10 * GB, true);
});

test('with nothing but Accurate frames, the project opened longest ago goes first', async () => {
  const old = folder('closed-old', 'preview', 6), recent = folder('closed-recent', 'preview', 6);
  const long = new Date(Date.now() - 86400e3);
  fs.utimesSync(path.join(old, 'preview.json'), long, long);
  await settle({ previews: [], shown: new Set() });
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(recent), true);
});
