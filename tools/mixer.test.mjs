// The mixer, changed by name: node tools/mixer.test.mjs
import assert from 'node:assert/strict';
import { change, describe, MixerError } from './mixer.mjs';

const timeline = () => ({
  media: { kick: { notes: [] }, room: { kind: 'audio', src: 'media/room.wav' } },
  tracks: [
    { id: 'v1', kind: 'visual', clips: [] },
    { id: 'kick', name: 'Kick', clips: [{ id: 'c1', media: 'kick', at: 0, in: 0, out: 4 }] },
    { id: 'bass', name: 'Bass', volume: -2, fx: [{ type: 'compressor', threshold: -18, ratio: 4 }, { type: 'compressor', threshold: -30, ratio: 2 }], sends: { hall: -12 }, clips: [] },
  ],
  buses: [{ id: 'hall', name: 'Hall', fx: [{ type: 'reverb', mix: 1 }] }],
});
const refused = (changes, why) => { const doc = timeline(), was = structuredClone(doc); assert.throws(() => change(doc, changes), (e) => e instanceof MixerError && why.test(e.message)); assert.deepEqual(doc, was); };

// a strip by its A-number (audio tracks only, in order), its name or its id; values in their units, kept in the timeline's
{
  const { doc } = change(timeline(), { set: { A1: { volume: '-3 dB', pan: -0.25 }, bass: { mute: 'on' }, hall: { volume: -6 } } });
  assert.equal(doc.tracks[1].volume, -3);
  assert.equal(doc.tracks[1].pan, -0.25);
  assert.equal(doc.tracks[2].mute, true);
  assert.equal(doc.buses[0].volume, -6);
}
// an effect added with its params in words; its type's defaults for the rest
{
  const { doc } = change(timeline(), { set: { Kick: { add_fx: [{ type: 'compressor', attack: '5 ms', mix: '50%', threshold: '-24 dB' }] } } });
  const fx = doc.tracks[1].fx[0];
  assert.deepEqual([fx.type, fx.attack, fx.mix, fx.threshold, fx.ratio], ['compressor', 0.005, 0.5, -24, 4]);
}
// a bare number in the param's own unit, words in any of its family's: a reverb's size in metres, its predelay in ms
{
  const fx = change(timeline(), { set: { Kick: { add_fx: [{ type: 'reverb', size: '3 m', predelay: '5 ms', decay: 1.2 }] } } }).doc.tracks[1].fx[0];
  assert.deepEqual([fx.size, fx.predelay, fx.decay], [3, 0.005, 1.2]);
  refused({ set: { Kick: { add_fx: [{ type: 'reverb', predelay: 5 }] } } }, /0 ms to 200 ms.*a bare number is in seconds/);
}
// one of two effects of a type named by its number or place; a type alone is refused where there are two
{
  const { doc } = change(timeline(), { set: { Bass: { set_fx: { 'compressor 2': { ratio: 3 } } } } });
  assert.deepEqual(doc.tracks[2].fx.map((f) => f.ratio), [4, 3]);
  assert.deepEqual(change(timeline(), { set: { Bass: { set_fx: { 1: null } } } }).doc.tracks[2].fx.map((f) => f.threshold), [-30]);
  refused({ set: { Bass: { set_fx: { compressor: { ratio: 3 } } } } }, /2 compressors/);
}
// a send to a bus by its name; null takes it away; a bus taken out takes the sends to it
{
  assert.deepEqual(change(timeline(), { set: { Kick: { sends: { Hall: -10 } } } }).doc.tracks[1].sends, { hall: -10 });
  assert.equal(change(timeline(), { set: { Bass: { sends: { Hall: null } } } }).doc.tracks[2].sends, undefined);
  const { doc } = change(timeline(), { remove_buses: ['Hall'] });
  assert.equal(doc.buses, undefined);
  assert.equal(doc.tracks[2].sends, undefined);
}
// a new bus (a reverb when no effects are given), which the same change can send to
{
  const { doc } = change(timeline(), { add_buses: [{ name: 'Echo', fx: [{ type: 'delay', time: '375 ms' }] }, { name: 'Plate' }], set: { Kick: { sends: { Echo: -14 } } } });
  const echo = doc.buses.find((b) => b.name === 'Echo'), plate = doc.buses.find((b) => b.name === 'Plate');
  assert.equal(echo.fx[0].time, 0.375);
  assert.equal(plate.fx[0].type, 'reverb');
  assert.equal(doc.tracks[1].sends[echo.id], -14);
}
// a strip at its defaults leaves them out of the timeline, as the panel does
assert.equal('volume' in change(timeline(), { set: { Bass: { volume: 0 } } }).doc.tracks[2], false);
// anything wrong changes nothing, and says what is wrong
refused({ set: { Kick: { volume: -3 }, Bass: { add_fx: [{ type: 'compressor', threshold: -70 }] } } }, /-60 dB to 0 dB/);
refused({ set: { Kick: { add_fx: [{ type: 'compressor', drive: 3 }] } } }, /has threshold, ratio.*not "drive"/);
refused({ set: { master: { pan: 0.5 } } }, /not "pan"/);
refused({ set: { Snare: { volume: -3 } } }, /No strip "Snare"/);
refused({ set: { Kick: { sends: { Plate: -10 } } } }, /No strip/);
refused({ set: { Kick: { add_fx: [{ type: 'reverb', ir: 'kick' }] } } }, /impulse response/);
// the strips as text name what plays on each track and every effect
assert.match(describe(timeline()), /A1 "Kick" \(kick\).*plays notes "kick"/);
assert.match(describe(timeline()), /2\. compressor: threshold -30 dB, ratio 2 x/);
console.log('mixer: ok');
