// Tests for plugin instruments (plugins.mjs, native/plughost): `node tools/plugins.test.mjs`. They need the host built
// (native/plughost/build.sh) and Vial (native/vial/build.sh, or any Vial.vst3 in a plugin folder); without them they
// say so and pass. The host loads it and lists its parameters (not its MIDI stand-ins); a state taken is the state
// given back; a render is silent before the first note and sounding after it; playing streams the same sound as a render
// (within reason: Vial's random phases differ between instances); renderInstrument plays a track's clips.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPlugin, findPlugins, plughostPath, startInstrument, renderInstrument } from './plugins.mjs';
import { noteEvents } from '../nle/live.js';

let failed = 0;
const check = (ok, what) => { if (!ok) { failed++; console.log(`  FAIL ${what}`); } else console.log(`  ok   ${what}`); return ok; };
const rms = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
const db = (v) => 20 * Math.log10(v + 1e-12);

// the notes of a track, as samples (no host needed)
{
  const tl = { media: { p: { notes: [{ t: 0, dur: 0.5, note: 60 }, { t: 1, dur: 2, note: 64, vel: 0.5 }] }, q: { notes: [{ t: 0, dur: 1, note: 40 }] } } };
  const track = { clips: [{ media: 'p', at: 2, in: 0, out: 2 }, { media: 'q', at: 0, in: 0, out: 1 }] };
  const ev = noteEvents(track, tl, 1000, 'p');
  check(JSON.stringify(ev.map((e) => [e.s, e.on, e.note])) === JSON.stringify([[2000, true, 60], [2500, false, 60], [3000, true, 64], [4000, false, 64]]), 'noteEvents: one medium\'s notes at their samples, cut at the clip\'s end');
}

const sr = 48000, vial = findPlugins().find((p) => p.name === 'Vial');
if (!fs.existsSync(plughostPath()) || !vial) {
  console.log(`  skip the host's tests: ${!fs.existsSync(plughostPath()) ? `no host at ${plughostPath()}` : 'no Vial.vst3 in the plugin folders'}`);
} else {
  const notes = [0, 4, 7].flatMap((k) => [{ s: sr / 2, on: true, note: 60 + k, vel: 0.8 }, { s: sr * 1.5, on: false, note: 60 + k }]);
  const host = await openPlugin('Vial', { sr });
  const params = host.info.params;
  check(params.some((p) => p.title === 'Macro 1') && !params.some((p) => /^MIDI CC/.test(p.title)), `its ${params.length} parameters, its macros among them, no MIDI stand-ins`);
  const state = await host.getState();
  check(state.length > 1000 && (await host.setState(state)), 'its state, taken back');
  host.tempo({ bpm: 100 });
  host.notes(notes);
  const [L, R] = await host.render(0, sr * 2);
  check(rms(L, 0, sr / 2) === 0 && rms(R, 0, sr / 2) === 0, 'silent before the first note');
  check(db(rms(L, sr * 0.6, sr * 1.4)) > -40, `sounding while the notes play (${db(rms(L, sr * 0.6, sr * 1.4)).toFixed(1)} dBFS)`);
  // playing: the same notes streamed, a little ahead of where it is told the listener is
  const got = new Float32Array(sr * 2);
  const live = await openPlugin('Vial', { sr, onSound: (pos, l) => { if (pos < got.length) got.set(l.subarray(0, got.length - pos), pos); } });
  live.tempo({ bpm: 100 });
  live.notes(notes);
  live.command({ op: 'play', from: 0, ahead: 4800 });
  for (let at = 0; at < sr * 2; at += 2400) { await new Promise((r) => setTimeout(r, 5)); live.command({ op: 'ack', pos: at }); }
  await new Promise((r) => setTimeout(r, 200));
  live.close();
  let worst = 0;
  for (let a = sr / 2; a < sr * 1.5; a += sr / 10) worst = Math.max(worst, Math.abs(db(rms(got, a, a + sr / 10)) - db(rms(L, a, a + sr / 10))));
  check(worst < 1.5, `playing streams what a render makes (loudness within ${worst.toFixed(2)} dB, each tenth of a second)`);
  // monitoring (the timeline stopped): no timeline notes, a note played now is heard, and stops when let go
  const heard = new Float32Array(sr * 2);
  const mon = await openPlugin('Vial', { sr, onSound: (pos, l) => { if (pos < heard.length) heard.set(l.subarray(0, heard.length - pos), pos); } });
  mon.notes(notes);
  mon.command({ op: 'monitor', from: 0, ahead: 2400 });
  let at = 0;
  const run = async (until) => { for (; at < until; at += 1200) { await new Promise((r) => setTimeout(r, 3)); mon.command({ op: 'ack', pos: at }); } };
  await run(sr * 0.75);
  mon.command({ op: 'note', on: true, note: 57, velocity: 0.8 });
  await run(sr * 1.25);
  mon.command({ op: 'note', on: false, note: 57 });
  await run(sr * 2);
  await new Promise((r) => setTimeout(r, 200));
  mon.close();
  check(rms(heard, sr / 2, sr * 0.75) === 0, 'monitoring: the timeline\'s notes are not played');
  check(db(rms(heard, sr * 0.85, sr * 1.25)) > -45, `monitoring: a note played now is heard (${db(rms(heard, sr * 0.85, sr * 1.25)).toFixed(1)} dBFS)`);
  check(db(rms(heard, sr * 1.9, sr * 2)) < db(rms(heard, sr * 0.85, sr * 1.25)) - 20, 'monitoring: let go, it fades');
  host.close();

  // a project's state file, and a track's clips rendered by renderInstrument
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-plugins-'));
  fs.mkdirSync(path.join(dir, 'instruments'));
  fs.writeFileSync(path.join(dir, 'instruments', 'v.state'), state);
  const { host: h2, missing } = await startInstrument(dir, { plugin: 'Vial', state: 'instruments/v.state', set: { 'Macro 1': 0.5, 'No Such Knob': 1 } }, { sr });
  check(JSON.stringify(missing) === '["No Such Knob"]', 'set: the titles it does not have are told');
  h2.close();
  const tl = { grid: { bpm: 100 }, media: { k: { notes: [{ t: 0, dur: 0.5, note: 57, vel: 0.8 }] } } };
  const track = { id: 't', instrument: { plugin: 'Vial', state: 'instruments/v.state' }, clips: [{ media: 'k', at: 1, in: 0, out: 1 }] };
  const [l2] = await renderInstrument(dir, tl, track, sr);
  check(l2.length === sr * (2 + 5) && rms(l2, 0, sr) === 0 && db(rms(l2, sr * 1.05, sr * 1.4)) > -40, 'renderInstrument: silent until its clip, sounding in it, rendered 5 s past its end');
  // automation: a parameter keyed over the timeline is heard moving (the filter opening: the sound brightens)
  const bright = (x, a, b) => { let d = 0, m = 0; for (let i = Math.round(a) + 1; i < Math.round(b); i++) { d += Math.abs(x[i] - x[i - 1]); m += Math.abs(x[i]); } return d / (m || 1); };
  const swept = { grid: { bpm: 120 }, media: { s: { notes: [48, 55, 60].map((n) => ({ t: 0, dur: 3, note: n, vel: 0.8 })) } } };   // (the default patch has its filter off)
  const sweepTrack = { id: 't', instrument: { plugin: 'Vial', set: { 'Filter 1 Switch': 1 } }, clips: [{ media: 's', at: 0, in: 0, out: 3 }], automation: { instrument: { 'Filter 1 Cutoff': { lanes: [{ id: 'k', kind: 'keys', mode: 'aim', keys: [[0.2, 0.1], [2.8, 0.9, 'lin']] }] } } } };
  const [sw] = await renderInstrument(dir, swept, sweepTrack, sr);
  const early = bright(sw, sr * 0.4, sr * 0.8), late = bright(sw, sr * 2.2, sr * 2.6);
  check(late > early * 1.5, `automation: the filter keyed open is heard opening (brightness ${early.toFixed(3)} → ${late.toFixed(3)})`);
  fs.rmSync(dir, { recursive: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
