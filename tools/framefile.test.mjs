// Frames drawn now crossing to the studio's window as a file (app/framefile.cjs): what is written is what is read, a
// page cannot have anything else read, and what a browser leaves behind goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import framefile from '../app/framefile.cjs';

const { writer, read, take, sweep } = framefile;
const bytes = (n, k) => Uint8Array.from({ length: n }, (_, i) => (i * k) & 255);

test('a frame written is read back byte for byte, however many frames came before it', async (t) => {
  const page = writer(`${process.hrtime.bigint()}`.slice(-9));
  t.after(() => page.close());
  for (let k = 1; k <= 9; k++) {
    const frame = bytes(4096, k), file = page.write(frame);
    assert.deepEqual(new Uint8Array(await read(file, frame.length)), frame);
  }
});

test('a smaller frame after a larger one reads as the smaller one', async (t) => {
  const page = writer(`${process.hrtime.bigint()}`.slice(-9));
  t.after(() => page.close());
  for (let i = 0; i < 4; i++) page.write(bytes(8192, 3));   // (every slot holds a large frame)
  const small = bytes(1024, 5), file = page.write(small);
  assert.deepEqual(new Uint8Array(await read(file, small.length)), small);
});

test('frames not yet taken back are there for the frames after them', async (t) => {
  const page = writer(`${process.hrtime.bigint()}`.slice(-9));
  t.after(() => page.close());
  const a = bytes(2048, 7), b = bytes(2048, 11), fa = page.write(a), fb = page.write(b);
  assert.deepEqual(new Uint8Array(await read(fa, a.length)), a);
  assert.deepEqual(new Uint8Array(await read(fb, b.length)), b);
});

test('a frame taken is its bytes, and leaves its file holding no memory for the next frame to find', async (t) => {
  const page = writer(`${process.hrtime.bigint()}`.slice(-9));
  t.after(() => page.close());
  for (let k = 1; k <= 9; k++) {
    const frame = bytes(4096, k), file = page.write(frame);
    assert.deepEqual(new Uint8Array(await take(file, frame.length)), frame);
    assert.equal(fs.statSync(file).size, 0);
  }
});

test('nothing but a frame can be read, whatever a page asks for', async (t) => {
  const page = writer(`${process.hrtime.bigint()}`.slice(-9));
  t.after(() => page.close());
  const file = page.write(bytes(16, 1)), dir = path.dirname(file);
  await assert.rejects(read('/etc/passwd', 16));
  await assert.rejects(read(path.join(dir, '..', 'passwd'), 16));
  await assert.rejects(read(path.join(dir, `${path.basename(file)}/../../secret`), 16));
  await assert.rejects(read(path.join(dir, 'not-a-frame'), 16));
});

test('a frame cut short is an error, not a picture of what was there before', async (t) => {
  const page = writer(`${process.hrtime.bigint()}`.slice(-9));
  t.after(() => page.close());
  const file = page.write(bytes(16, 1));
  await assert.rejects(read(file, 32));
});

test("closing a page takes its files away", async () => {
  const page = writer(`${process.hrtime.bigint()}`.slice(-9));
  const files = [page.write(bytes(16, 1)), page.write(bytes(16, 2))];
  for (const f of files) assert.equal(fs.existsSync(f), true);
  page.close();
  for (const f of files) assert.equal(fs.existsSync(f), false);
});

test("what a browser that has ended left behind goes, a running browser's stays", async (t) => {
  const page = writer(`${process.hrtime.bigint()}`.slice(-9));
  t.after(() => page.close());
  const mine = page.write(bytes(16, 1)), dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const left = path.join(path.dirname(mine), `${dead}-1-0`);
  fs.writeFileSync(left, 'x');
  sweep();
  assert.equal(fs.existsSync(left), false);
  assert.equal(fs.existsSync(mine), true);
});
