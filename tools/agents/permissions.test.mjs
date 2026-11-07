import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { judgeTool } from './permissions.mjs';

// Advance retry waits without making outage tests sleep. The outcome, not retry timing, is the contract.
async function outcome(t, evaluate, signal) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const result = judgeTool(evaluate, signal).finally(() => { settled = true; });
  for (let i = 0; i < 30 && !settled; i++) { await tick(); t.mock.timers.runAll(); }
  assert.ok(settled, 'a failed evaluation must return to the model instead of waiting indefinitely');
  return result;
}

test('Auto allows an approved call and returns a distinct security denial for a rejected call', async () => {
  assert.equal(await judgeTool(async () => 'ALLOW'), undefined);
  assert.deepEqual(await judgeTool(async () => 'DENY'), { block: true, reason: 'The security system denied this tool call.' });
});

test('a late recovery within the retry allowance still permits the call', async (t) => {
  let failures = 10;
  assert.equal(await outcome(t, async () => {
    if (failures-- > 0) throw new Error('Service unavailable');
    return 'ALLOW';
  }), undefined);
});

test('an unavailable evaluator returns a retriable evaluation error, not a security denial', async (t) => {
  assert.deepEqual(await outcome(t, async () => { throw new Error('Service unavailable'); }), {
    block: true,
    reason: 'The security system failed to evaluate this tool call. This is not indicative of a block. You may retry shortly.',
  });
});

test('a malformed verdict is an evaluation failure, not permission to run or a policy denial', async (t) => {
  assert.deepEqual(await outcome(t, async () => 'ALLOW or DENY'), {
    block: true,
    reason: 'The security system failed to evaluate this tool call. This is not indicative of a block. You may retry shortly.',
  });
});

test('stopping during evaluation prevents execution even if the evaluator returns ALLOW', async () => {
  const abort = new AbortController();
  assert.deepEqual(await judgeTool(async () => { abort.abort(); return 'ALLOW'; }, abort.signal), { block: true, reason: 'Stopped.' });
});

test('stopping while retrying returns immediately rather than waiting for the evaluator to recover', async (t) => {
  const abort = new AbortController();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = judgeTool(async () => { throw new Error('Connection lost'); }, abort.signal);
  await tick();
  abort.abort();
  assert.deepEqual(await result, { block: true, reason: 'Stopped.' });
});
