import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterOffset } from './filter.js';

// the offsets of n evenly spread samples, and their spread
const offsets = (width, n = 4096) => Array.from({ length: n }, (_, i) => filterOffset((i + 0.5) / n, width));
const sigma = (xs) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);

test("samples spread as Blender's Blackman-Harris 1.5 px: centred, within 1.5 px of the pixel's centre", () => {
  const xs = offsets(1.5);
  assert.ok(xs.every((x) => Math.abs(x) <= 1.5));
  assert.ok(Math.abs(xs.reduce((s, x) => s + x, 0) / xs.length) < 1e-6);
  // (σ of the four-term window 3 px wide, integrated numerically)
  assert.ok(Math.abs(sigma(xs) - 0.416) < 0.002, `σ ${sigma(xs)}`);
});

test('a narrower filter draws its samples nearer the centre, in proportion', () => {
  assert.ok(Math.abs(sigma(offsets(0.75)) - 0.208) < 0.002);
});

test('a box spreads samples evenly across the pixel, whatever the width', () => {
  const n = 4096, xs = Array.from({ length: n }, (_, i) => filterOffset((i + 0.5) / n, 3, 'box'));
  assert.ok(xs.every((x) => Math.abs(x) <= 0.5));
  assert.ok(Math.abs(xs.reduce((s, x) => s + x, 0) / n) < 1e-6);
  assert.ok(Math.abs(sigma(xs) - 0.2887) < 0.001, `σ ${sigma(xs)}`);
});

test("the window's middle holds most of the samples", () => {
  // (the share of the 3 px window within ±0.5 px, integrated numerically)
  const xs = offsets(1.5);
  assert.ok(Math.abs(xs.filter((x) => Math.abs(x) < 0.5).length / xs.length - 0.763) < 0.003);
});
