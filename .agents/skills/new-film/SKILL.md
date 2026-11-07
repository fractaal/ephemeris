---
name: new-film
description: Start a new film project in Ephemeris — scaffold the project repo, bring in music, block out the story with the director, and get to a first draft. Use when someone wants to make audiovisual work.
---

# Starting a film project

A film is Ephemeris's editable audiovisual unit: it may be a motion graphic, a music-driven visual, a programmable
scene, a product film, a 3D/VFX shot, or a mixture. Start with the person's intent, then use the agent and the studio
to make a first draft that remains open to direction.

## 1. The project

```sh
./ephemeris new <name>        # projects/<name>/: a blank film, its first version kept in its history
./ephemeris serve             # dev server (5320): http://localhost:5320/projects/<name>/
./ephemeris nle <name>        # the studio with it open (http://localhost:5340/p/<name>/)
```

The project holds everything the film is made of — `film.js` (the film), `timelines/main.json` (music, cues, fps,
shutter), `assets/` (music, voiceover, footage, images, fonts, models), notes — and its history (`history/`: each version of its
timelines and code); `renders/` is what the studio made from it. `project.json`
records which Ephemeris it was made with. A film that shows a product's UI brings its own server and capture tools:
see `product-ui`.

## 2. Music and cues

A film can be timed against music. Drop audio onto a track in the editor (split, trim, fade; joins crossfade on their
own). The studio listens to each song placed (Beat This!, a beat-tracking model, ~10 s a song) and the grid follows it:
Detected, the default, is each song's tempo and bars from where its clip starts: its tempo map, from the beats the model
is sure of (one steady tempo, or where it changes). A director sets a clip's tempo by hand (its Tempo in the inspector),
or types a tempo for the whole grid. `music` (MCP; `./ephemeris music <file>`) gives a song's tempo, drops and parts (A, B, C…, each
with its intensity) in film time. Film code counts bars on the same grid with `tempo(TL.grid).b(bar, beat)`.

Cues are named moments in the timeline. The director places them (M drops one at the playhead, even while playing),
with labels and notes. Film code reads a cue by name (`cues(F, TL).at('name', fallback)`), so moving a cue in the editor
moves its moment. `materialize` §1 says how to write cues of your own.

## 3. Before you show a draft

`./ephemeris check`, stills at the moments that matter, a draft through the editor, and `review-draft`.
