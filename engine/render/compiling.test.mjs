import test from 'node:test';
import assert from 'node:assert/strict';
import { watchCompiling } from './compiling.js';

// a device that does what it is sent in order, each piece done when the test says (finish): work submitted, and the
// pipelines it makes; work done tells those waiting on everything sent before them
function device() {
  const items = [], waits = [];
  const check = () => { for (const w of [...waits]) if (items.slice(0, w.at).every((i) => i.done)) { waits.splice(waits.indexOf(w), 1); w.resolve(); } };
  const make = (d) => { items.push({ done: false }); return { made: d }; };
  return {
    queue: { submit: () => { items.push({ done: false }); }, onSubmittedWorkDone: () => new Promise((resolve) => { waits.push({ at: items.length, resolve }); check(); }) },
    createRenderPipeline: make,
    createComputePipeline: make,
    finish: async () => { items.find((i) => !i.done).done = true; check(); await new Promise((r) => setTimeout(r)); },
  };
}
const fs = (label, entryPoint = 'fs') => ({ fragment: { module: { label }, entryPoint } });
const cs = (label, entryPoint) => ({ compute: { module: { label }, entryPoint } });
const wait = () => new Promise((r) => setTimeout(r, 130));

test('says what is being compiled, in the order asked for, and when none is', async () => {
  const dev = device(), said = [];
  watchCompiling(dev).to((c) => said.push(c));
  const pipe = dev.createComputePipeline(cs('gi rays', 'giTrace'));
  dev.createRenderPipeline(fs('opaque'));
  assert.deepEqual(pipe, { made: cs('gi rays', 'giTrace') });
  await wait();
  assert.deepEqual(said.at(-1), { now: 'gi rays · giTrace', done: 0, total: 2 });
  await dev.finish(); await wait();
  assert.deepEqual(said.at(-1), { now: 'opaque', done: 1, total: 2 });
  await dev.finish();
  assert.deepEqual(said.at(-1), { now: null, done: 2, total: 2 });
});

test('counts each run of them afresh', async () => {
  const dev = device(), said = [];
  watchCompiling(dev).to((c) => said.push(c));
  dev.createRenderPipeline(fs('one'));
  await dev.finish();
  dev.createRenderPipeline(fs('two'));
  await wait();
  assert.deepEqual(said.at(-1), { now: 'two', done: 0, total: 1 });
});

test('one made while the GPU draws what came before it is not said, and one still being made after that is', async () => {
  const dev = device(), said = [];
  watchCompiling(dev).to((c) => said.push(c));
  dev.queue.submit();
  dev.createRenderPipeline(fs('from the cache'));
  await wait();
  await dev.finish(); await dev.finish(); await wait();
  assert.ok(said.every((c) => c.now === null), JSON.stringify(said));
  dev.queue.submit();
  dev.createRenderPipeline(fs('compiling'));
  await wait();
  assert.equal(said.at(-1).now, null);
  await dev.finish(); await wait();
  assert.equal(said.at(-1).now, 'compiling');
});

test('a pipeline being compiled before anyone listens is told when they do', async () => {
  const dev = device(), said = [], w = watchCompiling(dev);
  dev.createRenderPipeline({ label: 'named', fragment: { module: { label: 'not this' } } });
  await new Promise((r) => setTimeout(r));
  w.to((c) => said.push(c));
  assert.deepEqual(said, [{ now: 'named', done: 0, total: 1 }]);
});

test('a lost device compiles nothing more', async () => {
  let lose;
  const dev = { ...device(), lost: new Promise((r) => { lose = r; }) }, said = [];
  watchCompiling(dev).to((c) => said.push(c));
  dev.createRenderPipeline(fs('never done'));
  lose(); await new Promise((r) => setTimeout(r));
  assert.equal(said.at(-1).now, null);
});

test("one made away from the GPU process's thread is said while it is made, and one made at once (its caches hold it) is not", async () => {
  const said = [], pending = [];
  const dev = { queue: { onSubmittedWorkDone: async () => {} }, createRenderPipeline: () => ({}), createComputePipeline: () => ({}),
    createRenderPipelineAsync: (d) => new Promise((resolve) => pending.push(() => resolve({ made: d }))) };
  watchCompiling(dev).to((c) => said.push(c));
  const cached = dev.createRenderPipelineAsync(fs('from the cache'));
  pending.shift()();
  assert.deepEqual(await cached, { made: fs('from the cache') });
  await wait();
  assert.ok(said.every((c) => c.now === null), JSON.stringify(said));
  const slow = dev.createRenderPipelineAsync(fs('opaque'));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(said.at(-1), { now: 'opaque', done: 0, total: 1 });
  pending.shift()(); await slow; await wait();
  assert.equal(said.at(-1).now, null);
});
