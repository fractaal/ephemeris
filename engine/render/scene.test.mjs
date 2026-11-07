import test from 'node:test';
import assert from 'node:assert/strict';
import { between } from '../between.js';
import { instancesData, shutterBoxes } from './scene.js';

const shape = { bounds: [[-10, -20, -30], [10, 20, 30]] };
const scene = (copies) => ({ camera: { x: 0, y: 0, z: 0 }, nodes: [{ mesh: shape, instances: copies }] });
const copies = (t) => [
  { x: 5, y: 5, z: 5 },                                     // still
  { x: -100 + t * 300, y: 40, z: 0 },                       // moving fast in a straight line
  { x: 0, y: t * 30, z: 200, rz: t * 24, s: 2 },            // moving and turning, as far as can be blended
  { x: t < 0.75 ? -700 + t : 700 + t, y: 0, z: -50 },       // jumping across the scene late in the shutter
];

test('every copy lies inside its box over the shutter at every moment of the shutter', () => {
  const at = between(scene(copies(0)), scene(copies(0.5)), scene(copies(1)), 0, 0.5, 1);
  assert.ok(at, 'these moments can be blended');
  for (let ts = 0; ts <= 1; ts += 0.05) {
    const s = at(ts), inst = instancesData(s.nodes), { lo, hi } = shutterBoxes(s.moments, s.nodes);
    for (let k = 0; k < 4; k++) for (let corner = 0; corner < 8; corner++) {
      const p = [corner & 1 ? 10 : -10, corner & 2 ? 20 : -20, corner & 4 ? 30 : -30], o = k * 28;
      for (let a = 0; a < 3; a++) {
        const v = inst[o + a] * p[0] + inst[o + 4 + a] * p[1] + inst[o + 8 + a] * p[2] + inst[o + a * 4 + 3];
        assert.ok(v >= lo[k * 3 + a] - 1e-3 && v <= hi[k * 3 + a] + 1e-3, `copy ${k} at ${ts.toFixed(2)}, axis ${a}: ${v} outside ${lo[k * 3 + a]} to ${hi[k * 3 + a]}`);
      }
    }
  }
});
