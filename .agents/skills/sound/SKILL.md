---
name: sound
description: The studio's sound tools — sounds (measures sound files), pitch (the notes a recording plays), music (tempo, beats, parts), levels (the mix's loudness, octaves and peaks), the mixer (mixer: each strip's volume, pan, effects and sends), bounce (the mix or a track as a file), notes clips written in bars and beats (notes, write_notes), and instruments — the Ephemeris Sampler and plugins alike, Vial (the studio's synth) among them (instruments, set_instrument, audition) — so that you can choose, place, write, play and balance sound without hearing it. Use when adding or revising SFX or music, choosing sounds from a library, or checking a film's sound.
---

# Sound

You cannot hear a film, so measure its sound. These tools describe sound files and the mix in numbers and plain
words. What gets a sound, and which, is the film's choice (a named style can say more: `.agents/styles/`).

Each tool is the studio's (MCP), and most are on the command line too (`./ephemeris sound | pitch | music | levels`).
Reach for them before writing a measuring script of your own: they read the mix exactly as the editor plays it.

## Placing a sound

Place by the sound's own shape: `at = moment − peakAt / speed` (or `onset` for a hit), from `sounds` below.

## Variation without new files

A clip's `speed` (NLE inspector: Speed; the timeline file: `speed`) plays it faster or slower with its pitch, as tape
does: 0.84 makes a second, slower, lower pass of the same orbit; 1.0 → 1.26 across a run of hits makes them climb.
Subtle changes (a few semitones) are all the variation most sounds need.

## Measuring sounds: `sounds`

You cannot listen, so measure. The `sounds` tool (MCP; `./ephemeris sound <files or folders>` on the command line,
tools/sound.mjs) gives, per sound: duration, where it peaks,
attack, decay, its energy in `sub` (< 60 Hz), `low` (< 150 Hz), `high` (> 4 kHz) and `air` (> 8 kHz), centroid,
flatness, tonality, pitch slope, crest factor, and plain-word tags:

| Tag | Means |
|---|---|
| `sub`, `bassy` | weight you feel |
| `thin`, `tinny`, `bright`, `airy` | little or no low end |
| `tonal` | a ring, chime, beep or whistle |
| `rising`, `falling` | its pitch moves |
| `click`, `hit`, `boom`, `ring`, `swell`, `swoosh`, `bed` | its shape |
| `stops-hard` | a build that ends in a thump: wrong for a soft landing |
| `punchy`, `soft` | hard transient / no transient |

```sh
sounds { files: ["~/Stock/Audio/Whooshes"], tags: "bassy,swoosh", max: 2, sort: "low" }   # deep, short swooshes, deepest first
./ephemeris sound ~/Stock/Audio/Whooshes --tags bassy,swoosh --max 2 --sort low           # the same, in a terminal
./ephemeris sound assets/sfx-*.wav --json                                                  # every measure, for a script
```

`sounds` with no files checks what you placed: each sound the timeline plays, with its onset and peak in film time
(its trim and speed followed), the grid line nearest the peak and how far off, and the nearest cue. Read it against
what the film needs.
`music` gives the beats, bars, drops and parts to place against.

The tags are guides: read the numbers, and say which sounds you chose and why.

`sounds` with `bands` gives each file's balance by octave over a span (`from`, `to`): read a reference's loudest part
that way and set it against the mix's (`levels` with `bands`, below).

## The notes in a recording: `pitch` (draft)

*Draft: for Ben's review.*

`pitch` (MCP; `./ephemeris pitch <files or folders>`, tools/pitch.mjs) finds the notes a recording plays, with Basic
Pitch: polyphonic, any instrument. Each note: its start and end in the file, its note, how strongly it sounds, its
loudness, and, where it sounds alone, its tuning in cents and how far it strays. Use it to:

- find a sample's root and tune for a sampler zone (`root`, `tune`, `offset`, `end`);
- cut vocal chops: the held notes of a loop (`steady: 6, min: 0.25`), across a folder at once, a range of keys at a
  time (`keys: "F3-G5"`);
- read a loop's line as notes, to chop or re-voice it: one file comes back as notation too, on a grid of its own tempo
  (`bpm`) or the timeline's (`at`), `quantize: "1/16"` to put it on the grid;
- work out a song's chords, bass and hook for the listener to study, play with, re-voice, recreate or use in a piece
  (MUSIC.md, "Working with references", says how to use them).

A note's tuning is only said where it sounds alone: in a chord, the notes say none. The model sometimes hears a strong
harmonic as a quiet note of its own, an octave or more above the real one: read the loudness before trusting a high,
quiet note.

## Levels

Measure the mix with `levels` (MCP; `./ephemeris levels <name>`): the film's integrated loudness and true peak, each
track alone, and the voice over everything else wherever it speaks (its least, and where). Set each effect's gain from
its measured loudness, not by eye on a waveform. A true peak above −1 dBTP can clip once the film is encoded.

Each call renders the mix from the start, and every track alone, several at once (a minute of film with ten tracks:
about 15 s), so ask for every span you need at once: `spans: [[0, 8], [8, 24], [28, 44]]` (an intro, a groove, a drop). Also, as needed:

- `bands`: each span by octave (31 Hz–16 kHz) for the mix and each track, the loudest track in each octave marked, how
  far the side is under the mid (the low end, under 150 Hz, should be near mono), and the mix's balance to set against
  a reference's (`sounds` with `bands`). Mud, harshness and a buried bass show here.
- `peaks`: where the tracks summed peak highest before the master's effects, and what each track is there: what the
  master's limiter is working on. A limiter that pumps the mix on every snare is fixed at the snare, not the master.
- `timeline`: a variant to measure instead (a copy of the timeline's JSON in `renders/`, changed), to try a balance
  before you write it.

`bounce` writes the mix, or tracks alone, to `renders/<timeline>/bounce-….wav`: to hand the director, or to measure a
part on its own with `sounds` or `pitch` (a plugin's preset, a chord voicing). It takes `from`, `to` and `timeline`
too.

## Mixer (draft)

*Draft: not reviewed by Ben.* The timeline can carry a mixer, all of it optional (a timeline without these fields mixes as before). The live engine (`nle/live.js`) plays it, in the editor and in renders (`tools/mix.mjs`), so both sound the same.

Read and change it with `mixer`, not `write_timeline`. Without changes it lists each strip as the Mixer panel shows it (the audio tracks as A1, A2…, the buses, the master): its volume, pan, mute and solo, its effects in order with every param in its units, its sends, and what plays on it. `set: { <strip>: { volume, pan, mute, solo, sends, fx, add_fx, set_fx } }` changes strips named by A-number, name or id (a bus by its name, the master as `master`), with values as words with their unit (`"-24 dB"`, `"120 ms"`, `"2.5 kHz"`, `"3 m"`, `"30%"`, `"on"`) or as bare numbers in each param's own unit, which the read-out's last line lists: seconds (though times show as ms), Hz, metres, and 0–1 for a percentage. `fx` is the whole chain, `add_fx` adds to its end, and `set_fx` names one effect by its type, `"compressor 2"` or its place from 1 (`null` takes it out); an EQ takes `bands`, or `"band 2": { gain }`. `add_buses` and `remove_buses` make and take out buses (a bus taken out takes the sends to it). It checks the whole change first and changes nothing if anything is wrong, then writes it (a version of the project), and the director's editor lights each part that changed. The fields below are what it writes.

- On an audio track: `volume` (dB, 0), `pan` (−1…1, 0), `mute`, `solo`, and `fx: [{ type, on?, …params }]`, a chain in order. `type` is one of `eq`, `compressor`, `limiter`, `saturate`, `delay`, `chorus`, `flanger`, `phaser`, `reverb` (params as `engine/sound/effects.js` takes them; `on: false` bypasses). An eq is `{ type: 'eq', bands: [{ type, freq, gain, q }] }`. A reverb may name an impulse response by media id, `{ type: 'reverb', ir: '<audio medium id>', mix }`, else it makes a room from its own params.
- On the timeline: `master: { volume?, fx?: [...] }`, and `buses: [{ id, name, fx, volume?, pan?, mute? }]`: shared effects (a reverb many tracks use). A track sends to a bus after its fader: `sends: { <bus id>: dB }`.
- A compressor can listen to another track: `{ type: 'compressor', sidechain: <track id>, … }` (the bass ducking under the kick). It hears that track after its effects, before its fader; a muted track still triggers it.
- The master's volume comes after its effects: above 0 dB it clips after the limiter.
- Order: a track's clips summed → its effects → volume and pan → (mute, solo) → tracks summed → master effects → master volume.

## Music (draft)

*Draft: not reviewed by Ben.* To write and produce music (notes, instruments, arrangement, mix, master), read
`MUSIC.md` beside this file: a general handbook for composing and producing without hearing. When the music should be
sleek and contemporary (product films, demos, motion graphics), read the house style
`.agents/styles/sleek-music/STYLE.md`; other styles in `.agents/styles/` may fit other films. When the director gives
you a sketch (a loop, a phrase, a motif) to build the score on, read the `musical-identity` skill first.

## Instruments (draft)

*Draft: for Ben's review.*

A track's instrument plays the notes clips on it: a track is a hybrid, as Bitwig's, its instrument (`instrument`, on the
track) and its effects, which every clip on it plays through, notes or sound. Two devices are one kind of thing: the **Ephemeris Sampler**, and a
**plugin** (a VST3: **Vial**, the open-source build of Vital, is the studio's synth; another VST3 on this machine plays
the same way). Each has parameters with values in their own units, holds something (a sampler its zones, a plugin its
state), and can be heard and automated the same way. A plugin plays in its own host process (the app ships the host and
Vial; a checkout builds them: `native/plughost/build.sh`, `native/vial/build.sh`); the sampler plays in the engine.

Presets come from the preset folders of the studio's settings (File › Settings: `tools/presets.mjs`): **Ephemeris**
(the studio's own: Vial's `presets/Vial/<name>.vital`, pluck, warm pad, sub bass, saw lead, supersaw, dark drone, fm
bell, fm electric piano; a notes clip added to a track that has no instrument gives it the pluck), **Your presets** (the workspace's `presets/`, every
project's: what the person saves in Vial's own window lands in `presets/Vial/`), **This project** (its `instruments/`)
and folders the person added (their Vital presets, wavetable packs). A plugin's presets are the files of the kind its
presets in the studio are (Vial's: `.vital`). `instruments` lists them by folder; `set_instrument` takes one by its
name, and one from Your presets or an added folder is copied into the project's `instruments/` (the film holds it). An
older instrument may name `vital/<name>.vital`: it is found in the added folders. Vial's own browser lists the same
folders and their wavetables. A sound the person made in Vial's window is the instrument's state
(`instruments/Vial-….state`), not a preset. A preset holds Vial's
modulations (an envelope on the filter, an LFO on the pitch): `set` changes their amounts (`Modulation 1 Amount`…) and
every other parameter, not what is routed where. For a route a preset lacks, start from one that has it, or ask the
person to route it in Vial's window.

- `instruments`: the devices this machine plays and their presets (`query`: a name), and each track's instrument.
  With `track` (its name or id; or `media`, a part one track plays), its instrument: its device, preset or state, what it holds, what is wrong with it (a param it
  does not have, a sample that is not there), and every parameter with its value in its own words ("800 Hz",
  "-6.02dB", "Ladder"), its range, and whether it moves the notes sounding (live) or the next note. A plugin has
  hundreds: ask by name (`query: "filter 1"`).
- `set_instrument { track, … }`: change a track's instrument (or give it one), checked against the device first (a typo or a value outside a range changes nothing
  and says the nearest names). `device` and `preset` swap what plays it (`{ "device": "Vial", "preset": "sub bass" }`);
  `set` its params by title or key, in their units or words: a sampler's `{ "Amp Release": "120 ms", "Level": "-6 dB"
  }`, a plugin's as the plugin writes them, `{ "Filter 1 Model": "Ladder", "Volume": "-9 dB", "Filter 1 Cutoff": "40
  semitones" }` (Vital's cutoff is in semitones: the range says so). Vital's macros (`Macro 1` to `Macro 4`) are a
  preset designer's main controls: try them first.
- `audition`: notes in notation through any instrument (a track's, or a spec you are trying), to a file, measured:
  its loudness and what it is like. Choose a preset or a change by what a phrase through it measures.

The `instrument` forms, as a track keeps them:

| Form | Plays with |
|---|---|
| `{ sampler: '<path>' }` | a sampler, from a saved instrument `.json` (`engine/sound/sampler.js` describes its fields) |
| `{ sfz: '<path>' }` | a sampler, from an SFZ file |
| `{ named: '<folder>', octave: <semitones> }` | a sampler, from a folder of samples named by note (`C3_vl2_rr1.wav`); VCSL and Serato folders want `octave: 12` |
| `{ plugin: '<name>', state: '<preset>', set: { '<parameter>': 0–1 } }` | a plugin: `state` a preset as the plugin saves it (`presets/Vial/<name>.vital`, the studio's; the project's, `instruments/<name>.vital`), `set` its parameters by title over it |

A path is the project's, `presets/…` among the studio's own presets, or `library/…` inside the sound library
(`EPHEMERIS_SOUND_LIBRARY`). The plugin gets the
timeline's tempo from its grid; a note may ring up to 5 s after it ends (reverb, delay). When the person changes a
plugin in its own window, the studio saves its state in the project (`instruments/<plugin>-<hash>.state`) and the
instrument names that file.

### Samplers from sound files (draft)

*Draft: for Ben's review.*

`set_instrument` with `zones` (in place of a sampler's zones) or `add_zones` makes zones from sound files:
`{ file, key, root, tune, offset, end, gain, pan, loop, vel, rr, group, offBy }`. Left out, `root` and `tune` are what
`pitch` measures of the file (the note it holds longest, to the cent): a sung slice's zone plays in tune across its
keys, and on a single key it is retuned to that key. To trigger a pitched slice as recorded (a chop on a pad), give its
`root` as its key. A sound with no pitch in it plays as recorded on its key, so a drum is
`{ file, key: 36, loop: { mode: 'oneshot' } }` (it plays whole, whatever the note's length). A file in the sound library
is named there (`library/…`); one outside the project and the library is copied into `instruments/samples/`. The changed sampler is saved as
`instruments/<name>-<hash>.json`, as the Instrument panel saves one; a file there changed in place is heard at once.

### Automation (draft)

*Draft: for Ben's review.*

Any automatable parameter of any instrument can move, the same way: each is a stack of lanes over its base (its value
in the instrument), named by the parameter's key (a plugin's title, `Filter 1 Cutoff`; the sampler's path, `gain`,
`env.r`), in 0–1 of its range. It has two layers:

- **The clip's**, kept in the notes medium, in its own time (seconds from the part's start, as its notes are). Every
  clip of the part plays it where it plays the part, on the instrument of the track it is on, so it moves and repeats
  with its clips; between clips the parameter holds where the last one that moves it left it. Use it for what belongs
  to the phrase (a filter that opens on every repeat of a riff).
- **The track's**, kept on the track (`automation.instrument`), in the timeline's time, over the clips' layer. Use it
  for what belongs to the arrangement (a filter that opens across the build to the drop).

```json
"media": { "bass": { "notes": […], "automation": { "Filter 1 Cutoff": { "lanes": [
  { "id": "k1", "kind": "keys", "mode": "aim", "keys": [[0, 0.35], [1.9, 0.8, "lin"]] } ] } } } }
"tracks": [{ "id": "a3", "instrument": {…}, "clips": […], "automation": { "instrument": { "Filter 1 Cutoff": { "lanes": [
  { "id": "k2", "kind": "keys", "mode": "aim", "keys": [[16, 0.35], [24, 0.8, "lin"]] } ] } } } }]
```

- Write it with `set_instrument`'s `automate`, in the parameter's own words, at bar.beat or seconds on the timeline:
  `{ "Filter 1 Cutoff": [["16.0", "-20 semitones"], ["24.0", "30 semitones", "lin"]] }` (an ease names how it comes
  to a key: `glide`, the default, `lin`, `step`…); `null` takes a parameter's away. `layer: "clip"` keeps each key in
  the part a notes clip of the track plays at that time, at the point of the part it plays then (a time where none
  plays is an error); the default is the track's.
- `aim` holds the first key's value before it and the last key's after it, as automation in a DAW does. Other lanes
  work as they do for any motion: `wander` (a slow wobble), `rate`, `moves` (`docs/manual/motion.md`).
- A live parameter moves the notes sounding as it changes; one that moves the next note (an envelope's times, an
  oscillator's wave) changes the notes that start after it.
- In the studio, the ◆ beside a knob in the Instrument panel keys it at the playhead (a sampler's and a plugin's
  alike): in the clip there, unless the parameter has lanes on its track, which then take the key. Under a track, the
  timeline shows its instrument's motion (its automated parameters: each notes clip over its own stretch, the track's
  lanes over the whole film) while one of its clips is selected, or always where its head's "Show motion"
  toggle is on (this machine's view, not the timeline's).

### Sound in code: sound.js (draft)

*Draft: for Ben's review.*

A project's `sound.js`, beside `film.js`, writes its parts' notes and moves their parameters with motions
(`docs/manual/motion.md`), as film.js moves what is seen. Its default export is a function of the timeline, which the
studio runs wherever the sound is made (the editor, renders, bounces, levels), and again when the timeline or the file
changes:

```js
import { E } from '../../engine/time.js';

export default ({ part, cues, b, BEAT }) => {
  const drop = cues.at('drop', 32);
  // the bass's filter opens over the bar before the drop, and breathes after it
  part('bass').automate('Filter 1 Cutoff').to(drop - 4 * BEAT, 4 * BEAT, 0.9, E.io).wander(0.03, { speed: 0.5 });
  // an arpeggio in eighths, the downbeats louder
  const chord = [60, 64, 67, 72];
  part('arp').notes(Array.from({ length: 32 }, (_, i) => ({ t: (i * BEAT) / 2, dur: BEAT * 0.45, note: chord[i % 4], vel: i % 2 ? 0.6 : 0.9 })));
};
```

- `part(id).notes([{ t, dur, note, vel }, …])`: the part's notes, in its own time (seconds from its start, as a notes
  medium keeps them). The part is a notes medium of the timeline, with its clips, each played by the instrument of the
  track it is on (`write_notes` makes one; the notes it writes there are the director's own, over the code's). The director edits them in the piano roll
  as any part's: the timeline keeps their edits over the code's notes (the medium's `notes`, added; `removed`, the
  code's they took away or changed, as `[t, note]`), so a code note they did not touch stays as the code makes it. A
  removal the code no longer makes a note for does nothing. `notes` reads a part as heard, and says which are the code's;
  `write_notes` writes over them as the director does.
- `part(id).automate(param)`: a parameter of the instrument of each track that plays the part (its key, as
  `instruments` lists it), in 0–1 of its range, starting from what is below it: the instrument's value and the clips'
  own lanes. Chain `.to()`, `.by()`, `.keys()`,
  `.rate()`, `.wander()` on it, at the timeline's times. It plays on every track that plays the part, under the track's
  own lanes. `{ name }` keeps the director's changes to it when its line moves.
- The run's context: `part`, `cues` (`at`, `end`, `get`, as `elements/cues.js` reads them), the grid's tempo (`b(bar,
  beat, sixteenth)` → s, `BPM`, `BEAT`, `BAR`) and `TL`, the timeline.
- The director sees it in the lanes as the code's (grey, `sound.js:<line>`), changes its operators, adds lanes on it,
  reorders and mutes them, as for a film motion; those changes are the timeline's overrides, by the line that made it.
  When you change the code, the changes follow their lines or are orphaned, as a film motion's are. Fold them into the
  code when asked, as for film motions.
- An error in it stops renders and is shown in the editor; `node -e` it, or `bounce`, before you say it works.

## Notes clips (draft)

*Draft: Ben has not reviewed this section.*

A timeline medium can be a part instead of a file: its notes, played by the instrument of the track its clip is on. The live
engine plays it, in the editor and in renders alike, and the piano roll edits it. A clip of it places it on an audio
track; its `in` and `out` are seconds of the part, and its gain and fades act on the part's sound (a note still ringing
after the clip ends rings at the clip's gain, unless the clip fades out). A clip's gain comes before its track's
effects, as in any mixer: a compressor or saturator there takes much of a change back. To move a part's level in the
mix, use its track's `volume`, which comes after them.

Write and read parts with `write_notes` and `notes`, in bars and beats on the timeline's grid; `timeline` shows a
part's notes only as how many there are. A line is a note or a chord, or a drum row:

```
swing 58%                          # the off-beat sixteenths late (lines that follow)
4.0        F1          1/2   .9    # bar 4, beat 0 (the studio's bar.beat.sixteenth, from 0): F1, a half note, velocity .9
4.2        Ab3 C4 Eb4  1/4   .6    # a chord
4.2        Ab3:.7 C4:.5  1/4       # each note its own velocity
4.3.2-12ms C5          1/16        # beat 3's third sixteenth, 12 ms early
@8-15 0.0  F1          1/8         # bars 8–15: the line once a bar (its bar from each repeat's first; @8-15/2: every two)
@8-15 kick 36 x...x...x...x...     # a drum row: a step a character (X accent, x hit, o ghost, 1–9 tenths, . rest)
```

- `write_notes { media, notation, bars?, add?, instrument?, track? }` writes one part (a version of the project), the
  rest of the timeline untouched (the director's edits elsewhere are kept). `bars: "8-15"` replaces only those bars;
  `add` keeps what is there. A new part gets a clip over the bars written, on `track`; a new track, or one that
  has no instrument, needs `instrument`, which becomes the track's (`instrument` given for a part already placed
  sets the instrument of the tracks that play it).
- `notes` lists the parts (what plays them, their range, where they play); `notes { media, bars?, tab? }` reads one back in the
  same text (`tab`: drum rows where the hits keep to the grid). Change what you read and write it back.
- In the file, `notes` are `{ t, dur, note, vel }` in seconds from the part's start (60 is C4, `vel` 0–1), and
  `length` is how long the part is. They stay in seconds when the grid changes.
- What plays a part is its track's `instrument` (Instruments, above): look at it with `instruments`, change it with
  `set_instrument`. A part moved to another track plays that track's instrument.
