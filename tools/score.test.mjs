// A film's sound code (a project's sound.js) is played in renders, with the director's changes to it: node tools/score.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreOf } from './score.mjs';
import { render } from './mix.mjs';
import { instrumentKey } from '../nle/live.js';
import { ownNotes } from '../engine/score.js';

const SR = 48000;
// a project of its own: its sound.js, the studio's engine beside it as in a workspace
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ephemeris-score-')), dir = path.join(ws, 'projects', 'p');
fs.mkdirSync(dir, { recursive: true });
fs.symlinkSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine'), path.join(ws, 'engine'), process.platform === 'win32' ? 'junction' : 'dir');
fs.writeFileSync(path.join(dir, 'sound.js'), `import { E } from '../../engine/time.js';
export default ({ part, cues }) => {
  part('tone').automate('gain').to(cues.at('dip', 1), 1, 0.5, E.lin);
  // a part of its own whose notes it writes: a beat of C4, E4, G4 (G4 a little after the tenth of a second)
  part('arp').notes([{ t: 0, dur: 0.4, note: 60, vel: 0.9 }, { t: 0.5, dur: 0.4, note: 64, vel: 0.7 }, { t: 1.0001234, dur: 0.4, note: 67, vel: 0.7 }]);
};
`);

// a sampler of one held sine, a note through the whole timeline; its level (gain: -60 to 12 dB, so 0 dB is 60/72)
const sine = Float32Array.from({ length: SR * 4 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR));
const spec = { sfz: 'tone.sfz' };
const resolved = { [instrumentKey(spec)]: { sampler: { kind: 'sampler', env: { a: 0.001, r: 0.05 }, regions: [{ sample: 's', key: [0, 127], root: 57 }] }, samples: { s: { sr: SR, ch: [sine, sine] } } } };
const timeline = (extra = {}) => ({ grid: { bpm: 120 }, cues: [{ id: 'dip', t: 1, dur: 0 }], overrides: [], media: { tone: { kind: 'audio', notes: [{ t: 0, dur: 3.5, note: 57, vel: 0.8 }] } },
  tracks: [{ id: 'a', name: 'Tone', instrument: spec, clips: [{ id: 'c', media: 'tone', at: 0, in: 0, out: 3.5 }] }], ...extra });
const played = async (tl) => render(tl, { sr: SR, media: {}, resolved, plugins: {}, score: await scoreOf(dir, tl) }, { until: 3 });
const plain = (tl) => render(tl, { sr: SR, media: {}, resolved, plugins: {} }, { until: 3 });   // (as it is, without sound.js)
const close = ([a, b], [c, d]) => {
  let worst = 0, loud = 0;
  for (let i = 0; i < a.length; i++) { worst = Math.max(worst, Math.abs(a[i] - c[i]), Math.abs(b[i] - d[i])); loud = Math.max(loud, Math.abs(a[i])); }
  assert.ok(loud > 0.01, `silent (${loud})`);
  assert.ok(worst < 1e-6, `differs by up to ${worst}`);
};
// the same as lanes of the track's own: keys that hold 0 dB until 1 s, then fall straight to `to` at 2 s
const keyed = (to) => ({ tracks: [{ ...timeline().tracks[0], automation: { instrument: { gain: { lanes: [{ id: 'k', kind: 'keys', mode: 'aim', keys: [[1, 60 / 72], [2, to, 'lin']] }] } } } }] });

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '\n', e); process.exitCode = 1; }
}
try {
  await test('a part\'s parameter moved by sound.js is played as it says, from the cue it names', async () => {
    close(await played(timeline()), await played(timeline({ cues: [{ id: 'dip', t: 1, dur: 0 }], ...keyed(0.5) })));
  });
  await test('the director\'s change to it (a move\'s target, kept in the timeline by its line) is played', async () => {
    const sc = await scoreOf(dir, timeline()), { id, ops } = sc.automation[0].desc;
    close(await played(timeline({ overrides: [{ id: 'o1', stack: id, ops: { [ops[0].id]: { to: { value: 0.25 } } } }] })), await played(timeline(keyed(0.25))));
  });
  // the arp: its notes from sound.js (none in the timeline), or the same notes written in the timeline
  const arp = (m) => ({ ...timeline(), media: { arp: { kind: 'audio', notes: [], ...m } }, tracks: [{ id: 'b', name: 'Arp', instrument: spec, clips: [{ id: 'd', media: 'arp', at: 0.2, in: 0, out: 2 }] }] });
  const notes = (...ns) => ns.map(([t, note, vel]) => ({ t, dur: 0.4, note, vel }));
  await test('a part\'s notes written by sound.js are played where its clip plays them', async () => {
    close(await played(arp()), plain(arp({ notes: notes([0, 60, 0.9], [0.5, 64, 0.7], [1.0001234, 67, 0.7]) })));
  });
  await test('the director\'s edits over them are played: a note taken away, one added', async () => {
    close(await played(arp({ removed: [[0.5, 64]], notes: notes([1.5, 72, 0.8]) })), plain(arp({ notes: notes([0, 60, 0.9], [1.0001234, 67, 0.7], [1.5, 72, 0.8]) })));
  });
  await test('edits kept over a part\'s code: the code\'s notes left as they were stay the code\'s, one moved is taken away and added', () => {
    const code = notes([0, 60, 0.9], [0.5, 64, 0.7], [1.0001234, 67, 0.7]);
    // (as the piano roll keeps them: to the millisecond; E4 moved to 0.75)
    assert.deepEqual(ownNotes(code, notes([0, 60, 0.9], [0.75, 64, 0.7], [1, 67, 0.7])), { notes: notes([0.75, 64, 0.7]), removed: [[0.5, 64]] });
    assert.deepEqual(ownNotes(code, notes([0, 60, 0.9], [0.5, 64, 0.7], [1, 67, 0.7])), { notes: [], removed: [] });
    assert.deepEqual(ownNotes(code, notes([0, 60, 0.9], [1, 67, 0.7])), { notes: [], removed: [[0.5, 64]] });
  });
  await test('a timeline whose cue moved moves it', async () => {
    const later = timeline({ cues: [{ id: 'dip', t: 1.5, dur: 0 }] });
    const lanes = { tracks: [{ ...timeline().tracks[0], automation: { instrument: { gain: { lanes: [{ id: 'k', kind: 'keys', mode: 'aim', keys: [[1.5, 60 / 72], [2.5, 0.5, 'lin']] }] } } } }] };
    close(await played(later), await played(timeline({ cues: later.cues, ...lanes })));
  });
} finally { fs.rmSync(ws, { recursive: true, force: true }); }
console.log(`${passed} passed`);
