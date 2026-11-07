// Sampler drop acceptance: node nle/sampler-device.test.mjs
import assert from 'node:assert/strict';
import { carriesSoundDrop, MEDIA_TYPE } from './sampler-device.js';

const event = (types = [], files = []) => ({ dataTransfer: { types, files } });

assert.equal(carriesSoundDrop(event([MEDIA_TYPE])), true, 'accepts an Assets-panel sound');
assert.equal(carriesSoundDrop(event(['Files'])), true, 'accepts a filesystem drag');
assert.equal(carriesSoundDrop(event([], [{ name: 'kick.wav' }])), true, 'accepts file payloads even without drag types');
assert.equal(carriesSoundDrop(event(['text/plain'])), false, 'ignores unrelated drags');
assert.equal(carriesSoundDrop({}), false, 'ignores events without a data transfer');

console.log('sampler drop tests passed');
