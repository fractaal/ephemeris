// A timeline's format migrated (tools/migrations): node tools/migrations/migrations.test.mjs
import assert from 'node:assert/strict';
import { migrate, migrateText, VERSION } from './index.mjs';

const vial = (state) => ({ plugin: 'Vial', state }), keys = (k) => ({ lanes: [{ id: 'k', kind: 'keys', mode: 'aim', keys: k }] });
const old = {
  version: 1, fps: 24,
  media: {
    groove: { kind: 'audio', name: 'Groove', notes: [{ t: 0, dur: 1, note: 36, vel: 0.8 }], instrument: vial('instruments/sub.vital') },
    outro: { kind: 'audio', notes: [{ t: 0, dur: 1, note: 38, vel: 0.8 }], instrument: vial('instruments/sub.vital') },
    drop: { kind: 'audio', notes: [{ t: 0, dur: 2, note: 31, vel: 0.9 }], instrument: vial('instruments/808-slide.vital') },
    spare: { kind: 'audio', notes: [], instrument: { sampler: 'instruments/kit.json' } },
    song: { src: 'assets/song.wav' },
  },
  tracks: [
    { id: 'music', name: 'Music', clips: [{ id: 'm1', media: 'song', at: 0, in: 0, out: 30 }] },
    { id: 'bass', name: 'Bass', volume: -4, pan: 0.1, sends: { hall: -12 }, fx: [{ type: 'compressor', threshold: -20 }],
      automation: { groove: { 'Filter 1 Cutoff': keys([[1, 0.2]]) }, drop: { Volume: keys([[8, 0.5]]) }, gone: { Volume: keys([[0, 1]]) } },
      clips: [{ id: 'b1', media: 'groove', at: 0, in: 0, out: 4 }, { id: 'b2', media: 'drop', at: 8, in: 0, out: 2, trackId: 'bass' }, { id: 'b3', media: 'outro', at: 12, in: 0, out: 4 }] },
  ],
};

{ // a track that played two instruments is two tracks, each with its own, its clips, the same mix and its automation
  const { doc, from, said } = migrate(old);
  assert.equal(from, 1);
  assert.equal(doc.version, VERSION);
  assert.deepEqual(doc.tracks.map((t) => t.name), ['Music', 'Bass', 'Bass · 808-slide']);
  const [music, bass, split] = doc.tracks;
  assert.equal(music.instrument, undefined, 'a track of sound alone has no instrument');
  assert.deepEqual(bass.instrument, vial('instruments/sub.vital'), 'the instrument of its first notes clip stays');
  assert.deepEqual(bass.clips.map((c) => c.id), ['b1', 'b3']);
  assert.deepEqual(split.instrument, vial('instruments/808-slide.vital'));
  assert.deepEqual(split.clips.map((c) => c.id), ['b2']);
  for (const k of ['volume', 'pan', 'sends', 'fx']) assert.deepEqual(split[k], bass[k], `the split track has the same ${k}`);
  assert.deepEqual(bass.automation, { instrument: { 'Filter 1 Cutoff': keys([[1, 0.2]]) } });
  assert.deepEqual(split.automation, { instrument: { Volume: keys([[8, 0.5]]) } });
  assert.ok(Object.values(doc.media).every((m) => !('instrument' in m)), 'media have no instruments');
  assert.ok(!('trackId' in split.clips[0]), 'a clip no longer names a track of its own');
  assert.ok(said.some((s) => /"gone", which it does not play, left out/.test(s)), 'automation of a pattern the track did not play is said to be left out');
  assert.ok(said.some((s) => /"spare", on no track/.test(s)), 'a pattern no track plays is said to have lost its instrument');
  assert.notEqual(old.tracks.length, doc.tracks.length, 'the timeline given is left as it was');
}

{ // a timeline in the format of now is as it is
  const now = { version: VERSION, tracks: [], media: {} };
  assert.equal(migrate(now).doc, now);
  assert.equal(migrateText(JSON.stringify(now), JSON.stringify).text, JSON.stringify(now));
  assert.equal(migrateText('not json', JSON.stringify).text, 'not json');
}

{ // a track's patterns that shared one instrument, and both automated the same parameter: the first's is kept, said
  const two = structuredClone(old);
  two.tracks[1].automation.outro = { 'Filter 1 Cutoff': keys([[13, 0.9]]) };
  const { doc, said } = migrate(two);
  assert.deepEqual(doc.tracks[1].automation.instrument['Filter 1 Cutoff'], keys([[1, 0.2]]));
  assert.ok(said.some((s) => /Filter 1 Cutoff by "outro" left out/.test(s)));
}

{ // a cue written without a length (an agent's, say) is a point: without one the editor's timeline had no end, and froze
  const now = { version: VERSION, tracks: [], media: {}, cues: [{ id: 'meadow', label: 'meadow', t: 0 }, { id: 'swell', t: 4, dur: 2 }] };
  const { doc, said } = migrate(now);
  assert.deepEqual(doc.cues.map((q) => q.dur), [0, 2]);
  assert.ok(said.some((s) => /"meadow"/.test(s)), 'the cue given a length is said');
  assert.equal(now.cues[0].dur, undefined, 'the timeline given is left as it was');
  assert.equal(JSON.parse(migrateText(JSON.stringify(now), JSON.stringify).text).cues[0].dur, 0, 'its text is written with the length');
}

console.log('migrations: ok');
