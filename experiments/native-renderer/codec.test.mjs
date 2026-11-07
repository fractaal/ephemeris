import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Encoder, Decoder, pack, unpack } from './codec.mjs';

const wire = (x) => JSON.parse(JSON.stringify(x));
test('scene values and typed geometry survive a JSON transport without changing the frame', () => {
  const e = new Encoder(), d = new Decoder();
  const geo = { pos: new Float32Array([1, -2, 0.5]), nrm: new Float32Array([0, 1, 0]), idx: new Uint32Array([0]) };
  const input = { camera: { focal: 2200 }, nodes: [{ geo }, { geo }], range: Infinity, near: -Infinity, empty: null };
  const encoded = e.value(input); d.add(wire(e.drain()));
  const output = d.value(wire(encoded));
  assert.deepEqual(output, input);
  assert.equal(output.nodes[0].geo, output.nodes[1].geo);
  // A later frame refers to the same static geometry, not a freshly allocated copy per frame.
  const next = e.value({ geo, t: 2 }); d.add(wire(e.drain()));
  assert.equal(d.value(wire(next)).geo, output.nodes[0].geo);
});

test('binary packets preserve every image byte and frame metadata from an offset buffer', () => {
  const images = [
    { id: 7, width: 1, height: 1, version: 2, data: new Uint8Array([0, 127, 255, 63]) },
    { id: 8, width: 1, height: 1, version: 3, data: new Uint8Array([255, 0, 1, 255]) },
  ];
  const packet = pack({ frame: { t: 18, label: 'Tycho’s table' } }, images);
  const padded = new Uint8Array(packet.length + 6); padded.set(packet, 3);
  const result = unpack(padded.subarray(3, 3 + packet.length));
  assert.deepEqual(result.meta.frame, { t: 18, label: 'Tycho’s table' });
  assert.deepEqual(result.images.map(({ id, width, height, version, data }) => ({ id, width, height, version, data })), images);
});

test('untransferable drawing functions fail rather than silently changing a scene', () => {
  assert.throws(() => new Encoder().value({ draw: () => 1 }), /Cannot transfer function at draw/);
  assert.throws(() => new Decoder().value({ $ref: 42 }), /Missing resource 42/);
});
