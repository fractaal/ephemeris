import test from 'node:test';
import assert from 'node:assert/strict';
import { frozen } from './frozen.js';

test('a kept scene keeps its moment when the film writes the same buffer again', () => {
  const buffer = new Float32Array([1, 2]);
  const first = frozen({ nodes: [{ data: buffer }] });
  buffer[0] = 9;
  assert.equal(first.nodes[0].data[0], 1);
});

test('nothing is copied where nothing is written in place', () => {
  const node = { x: 1, instances: [{ x: 1 }], params: { glow: [1, 2] } }, scene = { nodes: [node], camera: { x: 0 } };
  assert.equal(frozen(scene), scene);
});
