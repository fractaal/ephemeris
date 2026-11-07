---
name: materialize
description: Turn the director's NLE timeline (cues, ranges, notes, edits) into the film — read what changed, build or retime it, verify, and put a new draft in front of them. Use when the director says they've blocked something out, left notes, or asks for the next draft.
---

# Materializing a film from the timeline

The director blocks out the film in the NLE (`./ephemeris nle <name>`): the music edit, cues placed against it, notes
on cues. Everything they do is kept in the project's history, a version of the whole project at each change. Your job
is to read it exactly, build the film around it with taste, verify, and tell them the next draft is in their viewer.

## 1. Read what the director did

The `history` tool (or the command line):

```sh
./ephemeris history <name> | head -40           # the versions, newest first ("move cue …", "note on cue …"), their files
./ephemeris history <name> --since <n>          # all that changed after version n (your last draft's): moves, notes
./ephemeris history <name> <n> --path film.js   # what version n changed in one file
```

Then list every cue with its note (`t`, `dur`, `id`, `label`, `note`). Separate:
- **Structure cues** the film reads by `id` (scene starts): their new times retime the film automatically.
- **Ranges** (`dur > 0`): a span an action should fill ("the glide to the send button should last this long").
- **Notes**: issues (defects), suggestions (ideas to build), and direction about feel. Read them through the
  `direction` skill. Sequences of small moves on one cue mean the director was searching for a feel.
- **Annotations**: cues with `on`, pinned to an object the director clicked. `on.at` is the line of the film's code
  that placed it (`on.copy`: which copy of a `many()`), so the note is about exactly that thing at that moment
  (see the engine skill's nle.md).
- **Overrides** (`overrides` in the timeline): the director's direct changes to the film's motion, made in the
  timeline's lanes and the inspector: the code's operators retimed or changed, lanes reordered or turned off, keys and
  moves of their own over a motion or a thing's plain values (docs/manual/motion.md). They are the director's: keep
  them unless asked to fold them into the code (then make the code produce the same result and remove them, in one
  write that says so). Write new motion with `motion()` and rigs, placed as values, so the director can grab it.
- **Things added by hand** (clips with a `thing` in the timeline; the `objects` tool lists them as `added: true`): shapes and
  lights the director blocked out in the viewer. Read them as direction: what they want, where and when, in rough. They
  stay in the timeline until you are asked to fold them (docs/manual/motion.md says how).

One director per film. Never move, rename or delete the director's cues. If you add cues of your own (placeholders,
story beats), write them with `write_timeline`, its message saying what and why: the studio keeps it as a version of
its own, and the director's editor reloads it.

## 2. Build it

- Scene times come from cues by name, through `elements/cues.js`: `C.at('team', b(15))`, `C.end('glide', …)` for a
  range's end. The fallback is what the film does if the cue is missing. The film reports the cues it reads: the NLE
  marks them ("film uses this") and asks the director before one is deleted; `check` warns when one is missing.
- Cues the director adds get automatic names (q1, q2…). If the film starts following one of them, tell the director
  and suggest a meaningful name (they rename it in the NLE inspector); when they rename a cue the film follows, the
  history shows `name cue … q6 → probe`: update the film to the new name.
- **Cues conduct, they do not gate**: lead in before a cue, overlap the next section, follow through; land exactly
  only where it matters (a click, a send, a drop). A pointer can already be heading somewhere before its cue.
- Give centrepieces room; give personality time; keep pointer moves across the screen at 1.5 s or more.
- Fix causes in the layer that owns them: the film for content and timing; Ephemeris (`engine/`, `elements/`,
  `tools/`) for anything every film should get. Say which you touched.
- When a note conflicts with what the director agreed earlier, or a choice changes the agreed result, ask.

## 3. Verify the thing they will watch

1. `./ephemeris stills <name> <times>` at the beats you changed; look at them (contact sheets help).
2. `./ephemeris check <name>`: every gate passes, or you can say exactly why a flag is benign (and show it).
3. The director's viewer renders your changes by itself as you save (see `engine/nle.md`): they may be watching it
   change. When you are done, wait for it to be up to date (`curl localhost:5340/p/<name>/<timeline>/api/state`: `preview.frames` has no 0
   or 1 left, `preview.error` empty), then **check what they will see**, not just stills: its frames
   (`/preview/<frame>.jpg`) every ~2.5 s for black or frozen stretches, and at the moments you changed. The frames it
   marked changed (3) should be the moments you meant to change, and only those. For a file, R (or
   `curl -X POST localhost:5340/p/<name>/<timeline>/api/render`) writes `renders/<timeline>/draft.mp4` from those frames, with the music. Stills from
   one worker can pass while parallel workers fail (GPU memory, lost contexts).
4. Only then tell the director: what changed in their terms, what you decided and why, what you verified and how,
   anything still open.

## 4. Keep their language

When the director says something new about how they want things to feel, add it to the `direction` skill's
vocabulary (with what it turned out to mean in practice). If the film uses a named style (`.agents/styles/`), add any
new principle to it.
