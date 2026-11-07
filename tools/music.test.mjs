// A song's tempo map from the beats Beat This! hears: node tools/music.test.mjs
import assert from 'node:assert/strict';
import { tempoMap } from './music.mjs';

// beats as the model gives them: on its 20 ms frames, each with how sure it is; downbeats are some of the beats
const frame = (t) => Math.round(t * 50) / 50;
function song(stretches) {
  const beats = [], conf = [], downs = [];
  for (const { from, to, bpm, bar = 4, first = from, sure = 1, every = 1 } of stretches) {
    const P = 60 / bpm;
    for (let k = Math.ceil((from - first) / P - 1e-9); first + k * P < to - 1e-9; k++) {
      if (k % every) continue;
      const t = frame(first + k * P);
      beats.push(t); conf.push(typeof sure === 'function' ? sure(k) : sure);
      if (((k % bar) + bar) % bar === 0) downs.push(t);
    }
  }
  return [beats, conf, downs];
}
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got}, wanted ${want} ± ${tol}`);
// the bar line of a part nearest t
const barLine = (p, t) => { const bar = (60 / p.bpm) * p.beatsPerBar; return p.offset + Math.round((t - p.offset) / bar) * bar; };

// a breakdown where the model is unsure, with a burst of beats it is sure of off the song's beat: one tempo through it
{
  const [b1, c1, d1] = song([{ from: 0, to: 60, bpm: 128, first: 1.14 }]);
  const stray = [61.3, 61.71, 62.25, 62.58, 63.16, 63.49];   // (sure, in time with nothing)
  const unsure = Array.from({ length: 40 }, (_, i) => frame(64 + i * 0.66));
  const [b2, c2, d2] = song([{ from: 90.5, to: 150, bpm: 128, first: 1.14 }]);
  const map = tempoMap([...b1, ...stray, ...unsure, ...b2], [...c1, ...stray.map(() => 0.99), ...unsure.map(() => 0.7), ...c2], [...d1, ...d2]);
  assert.equal(map.length, 1, `one tempo, got ${map.map((p) => p.bpm.toFixed(2)).join(', ')}`);
  near(map[0].bpm, 128, 0.01, 'its tempo');
  near(barLine(map[0], 121), 1.14 + 64 * 1.875, 0.005, 'a bar line in the second half, in step with the first');
}

// a song that changes tempo: a part for each, the second from where the music changes
{
  const [beats, conf, downs] = song([{ from: 0, to: 40, bpm: 120 }, { from: 40, to: 80, bpm: 90, first: 40 }]);
  const map = tempoMap(beats, conf, downs);
  assert.equal(map.length, 2, `two tempos, got ${map.map((p) => p.bpm.toFixed(2)).join(', ')}`);
  near(map[0].bpm, 120, 0.02, 'the first tempo'); near(map[1].bpm, 90, 0.02, 'the second tempo');
  near(map[1].t, 40, 0.05, 'where the second starts');
  near(barLine(map[1], 41), 40, 0.005, 'its bar line');
}

// an intro the model hears in half time, then the song's beat: the song's tempo from the start
{
  const [beats, conf, downs] = song([{ from: 0, to: 16, bpm: 116, first: 0.5, every: 2 }, { from: 16, to: 60, bpm: 116, first: 0.5 }]);
  const map = tempoMap(beats, conf, downs);
  assert.equal(map.length, 1);
  near(map[0].bpm, 116, 0.02, 'its tempo');
}

// beats only some of which the model is sure of (every other one): the tempo of all of them, not half of it
{
  const [beats, conf, downs] = song([{ from: 0, to: 60, bpm: 116, sure: (k) => (k % 2 ? 0.8 : 0.99) }]);
  near(tempoMap(beats, conf, downs)[0].bpm, 116, 0.02, 'its tempo');
}

// three beats a bar
{
  const [beats, conf, downs] = song([{ from: 0, to: 40, bpm: 150, bar: 3, first: 0.3 }]);
  const [p] = tempoMap(beats, conf, downs);
  assert.equal(p.beatsPerBar, 3);
  near(barLine(p, 20), 0.3 + 16 * 1.2, 0.005, 'a bar line');
}

// a voice: beats the model is unsure of, or sure of but in time with nothing — no tempo
{
  const t = [0.4, 1.31, 1.62, 2.75, 3.1, 4.4, 4.71, 5.93, 7.2, 7.46, 8.9, 9.3, 10.75, 11.02, 12.6, 13.4];
  assert.equal(tempoMap(t, t.map(() => 0.7), []), null);
  assert.equal(tempoMap(t, t.map(() => 0.99), []), null);
}

console.log('music: ok');
