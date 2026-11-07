// Samplers made from sound files (set_instrument's zones): node tools/devices.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { change } from './devices.mjs';
import { writeWav } from './mix.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-test-')), dir = path.join(tmp, 'project'), shelf = path.join(tmp, 'shelf');
fs.mkdirSync(dir); fs.mkdirSync(shelf);
// the sound library, reached through a link as a workspace's assets/Stock is
fs.symlinkSync(shelf, path.join(tmp, 'library'), process.platform === 'win32' ? 'junction' : 'dir');
process.env.EPHEMERIS_SOUND_LIBRARY = path.join(tmp, 'library');
const sr = 48000, sound = async (file, s, f) => { const x = Float32Array.from({ length: s * sr }, (_, i) => f(i / sr)); await writeWav(x, x, sr, file); return file; };
let seed = 1;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const hit = await sound(path.join(tmp, 'hit.wav'), 0.3, (t) => noise() * Math.exp(-t * 30));
const tone = await sound(path.join(tmp, 'a4.wav'), 1.5, (t) => 0.5 * Math.sin(2 * Math.PI * 440 * t));
const shelved = await sound(path.join(shelf, 'snare.wav'), 0.3, (t) => noise() * Math.exp(-t * 20));
const sampler = async (zones) => (await change(dir, {}, { device: 'Ephemeris Sampler', zones })).sampler.regions;

try {
  // a drum, with no pitch in it, plays as recorded on the key it is given
  const [drum] = await sampler([{ file: hit, key: 36, loop: { mode: 'oneshot' } }]);
  assert.deepEqual([drum.key, drum.root], [[36, 36], 36]);
  // a pitched sound spread over keys plays in tune across them: its root is the note it holds
  const [keys] = await sampler([{ file: tone, key: ['C4', 'C5'] }]);
  assert.deepEqual([keys.key, keys.root], [[60, 72], 69]);
  // a file in the sound library is named there, not copied into the project, though the library is reached by a link
  const [lib] = await sampler([{ file: shelved, key: 38, loop: { mode: 'oneshot' } }]);
  assert.equal(lib.sample, 'library/snare.wav');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'instruments', 'samples')).filter((f) => f.startsWith('snare')), []);
  // a file from elsewhere is copied into the project's instruments/samples
  const [own] = await sampler([{ file: hit, key: 40 }]);
  assert.match(own.sample, /^samples\/hit-[0-9a-f]{8}\.wav$/);
  assert.equal(fs.existsSync(path.join(dir, 'instruments', own.sample)), true);
  console.log('devices: ok');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
