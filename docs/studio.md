# Changing the studio

For a task that changes Ephemeris itself (`engine/`, `elements/`, `tools/`, `nle/`), not a film.

- Make the change in the studio's checkout. In a workspace, `engine/`, `elements/` and the rest are links into the
  studio, so a change through them is a change to the studio (the app's own copy is replaced by its next build).
- A project's own concerns (how it brings a product in, its capture tools) stay in the project.
- Before you commit, run `./ephemeris compare --all`. It lists every frame that the change alters in each film, with
  diff images (each project needs a `./ephemeris snapshot` first, made on this machine). Alter films only on purpose.
  Differences within Chrome's raster noise (no pixel more than 2 levels off, at most 1000 pixels) are listed but not
  counted.
- Renders use the app's pinned Electron (`tools/browser.mjs`, `app/renderer.cjs`), not a separately downloaded or
  system browser. A worker has its own process, separate from the editor; its pages have fresh in-memory sessions.
  Updating Electron changes the rendering runtime too: check the rendered frames, not just the editor's startup.
- A change to how the renderer computes light (`engine/render/`, the looks in `elements/looks/`): read the
  `rendering-technique` skill.
- A change to what can be selected, or to what acts on a selection: read `docs/selection.md`. The studio has one
  selection, and anything new that can be selected joins it.
- A change to the editor (`nle/`) that updates while the timeline plays or a drag goes on, or data that streams through
  it: read the `editor-performance` skill. The editor's main thread draws the page at the display's rate, and what
  else it carries slows with it.

## Interface text

Text in the studio's interface tells the user what they need to use it, and nothing else.

| Element | Length | Example |
|---|---|---|
| Label | 1–3 words, sentence case, no punctuation | "Fade in", "Tempo" |
| Button or menu item | a verb, plus its object if needed; "…" if it opens a dialog | "Delete", "Render draft", "Rename…" |
| Value or status | the value with its unit, or up to 5 words | "128.01 bpm · 4/bar", "Listening…" |
| Hint under a field | only if the field is unclear without it; one line, up to about 10 words | |
| Tooltip | up to about 15 words: what it does if the label doesn't say, its shortcut, or one behaviour the user wouldn't guess | "Metronome (K): plays a click on each beat. Renders don't include it." |
| Empty state | one sentence saying how to add the first item | "No cues yet. Press M to add one." |
| Confirmation | the action, and anything that can't be undone | "Delete the timeline “intro”? It stays in the project's history." |
| Error or message | what happened and what to do, in one sentence | |

Write tooltips, hints and messages as plain, complete sentences. Don't drop words to make them shorter, and don't
phrase them like a slogan: write "Plays a click on each beat. Renders don't include it.", not "Clicks on the beat as it
plays, never in a render."

Interface text never includes:
- how something is implemented: file paths, timings, algorithms, data formats, model names, code names (`.to()`,
  `film.js:120`);
- why it was designed that way;
- what is already visible on screen;
- how standard interactions work (undo, drag to move, double-click to rename), unless this control works differently;
- comparisons to other software.

These rules are for copy: the words written to help someone use the studio. Telemetry is different. Where the studio
reports what the machine is doing (the shaders compiling, a frame's passes, workers, timings), show the real names, counts
and units, and don't translate them into friendlier words or leave them out as implementation. A technical name also
belongs as a control's current value, where it can be changed, not as a note beside a field.

Call a thing by the same name everywhere it appears. Detail beyond this goes in `docs/manual/` or the ? help overlay. The
code comments in this repo explain how things work at length; don't reuse their wording in the interface.

## Interface look

Use tone to delineate. Inside a panel, a header, a control or a row is a fill one step from what is behind it, and it has no
outline. Keep a line where the line is the information: a grid, a ruler, a playhead, a keyboard's keys, what has focus or where
a drop lands. Panels sit a 1 px gap apart with barely rounded corners (`--r-panel`), and controls are nearly square
(`--r-ctl`). A state asks for attention by how much it matters, never by an underline or a bar of accent:

- **Where you are** (a tab, a page): one tone up, no colour.
- **What is on** (a toggle, the current value of a group): the blue as a tint, with blue text.
- **What you act on** (a selected row, a menu's highlight, the main action): the blue swapped with its text. Few at a time.

The blue also marks what is selected in the work (a clip, an object in the viewer), the playhead and what is overridden. Icons come from `nle/icons.js` (Phosphor).

## What the studio runs

The studio runs each part of itself in one of the kinds below, each with its own place and rules. A new capability goes
in the first kind that fits it. If none fits, it stays outside the studio.

- **JavaScript** (`engine/`, `elements/`, `tools/`, `nle/`): the default. The engine runs in the browser, the tools in
  Node (in the app, its Electron run as Node).
- **Models** (`tools/models.mjs`, `tools/models/`): a model that measures or prepares what a film brings in (a song, a
  photo, footage) and turns it into something the engine or an agent can use (a song's beats, a photo's depth, the
  ground behind the people cut out of a photo). Models are ONNX files, run by onnxruntime (`onnxruntime-web`), the one
  model runtime, in one of two places that `MODELS` names for each:
  - `gpu`: WebGPU in the studio's Electron, on the machine's high-performance adapter, and its WebAssembly where
    WebGPU fails. A result can differ in its last digits from one GPU to another, so it suits what is made once and kept
    (a photo's layers, written into the film).
  - `cpu`: WebAssembly in the studio's own Node: the same result on every machine, for a measure each machine makes
    for itself (a song's beats).

  Ask before adding another runtime (onnxruntime-node, PyTorch). A model comes in only if:
  - its code and its weights both allow commercial use (films are commercial work);
  - its export is checked against the original model (the same outputs, within float error), and
    `tools/models/README.md` says where it came from, its licence, how it was exported and what the check found;
  - it is small enough to ship with the app (tens of MB). A larger one is downloaded once per machine into
    `~/.cache/ephemeris/models` from a pinned URL and checked by its sha256.

  An agent reaches a model through a tool named for what it does (`music`, not `beat_this`), on the MCP server and
  the command line. Its results are either cached beside the media (`renders/media/<file>/`, measured again when the
  file changes) or written into the film's own assets when the film is built from them.
- **Native helpers** (`native/<name>/`): only for what exists only as native code, or needs what Node cannot do. A VST3
  plugin is a native library, so `native/plughost` hosts it, and `native/vial` builds Vial, the studio's synth (Vital's
  GPLv3 source at a pinned commit, with a patch). A helper's `build.sh` builds it from pinned sources into
  `~/.cache/ephemeris/<name>` (`build.ps1` on Windows x64); an `EPHEMERIS_<NAME>` path can point elsewhere. Windows
  builds use MSVC and the Windows SDK, with a statically linked C++ runtime. The app's build takes this machine's
  builds into its `bin/`, with their licences and where their source is (`bin/NOTICE.md`). A helper runs as its own
  process, so a crash takes down only the helper.

Some things stay outside the studio: anything that needs its own heavy stack (PyTorch, ComfyUI, Blender), has
non-commercial weights, or generates a film's content instead of measuring or preparing what it brings in (generated
images or video, 3D reconstruction). A film can still use them. Bring the result in as the film's media or assets, and
keep the script that made it in the film's repo (`projects/<name>/tools/`), so it can be run again.
