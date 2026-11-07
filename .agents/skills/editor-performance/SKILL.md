---
name: editor-performance
description: Keep the studio's editor (nle/) fast — what makes a frame of the editor expensive, how to build interface that stays cheap while the timeline plays or a drag goes on, and how to measure and find what is slow in the running studio (frame-cost.mjs, over CDP). Use when you add or change editor interface that updates continuously, route data through the editor, or when something in the editor is slow, stutters, or plays below the film's frame rate.
---

# Editor performance

The editor is one page, and its main thread does nearly everything: the frame loop (`tick` in `nle/app.js`, once per
display frame, 60 to 180 times a second), the browser's work on the page after each change, input, and every message
that arrives on it (sockets, workers, the worklet). A frame has 5.5–16 ms. When the main thread is full, everything
behind it waits: the viewer's frames arrive late, a key press takes seconds, a drag lags. Build so that the main thread
does per frame only what that frame shows, and measure before and after.

## What a frame costs

These are properties of this editor (about 5,600 elements in a wide window), measured with `frame-cost.mjs`:

- **Any change to the page makes that frame restyle, lay out, paint and layerize.** A change is a text, an inline
  style, a class or an attribute (some, like `hidden`, even when set to the value they have). Layerize rebuilds the
  page's list of layers: 1–4 ms whatever changed, more with more of the page shown. Paint stays inside the panel that
  changed (each `.lay-leaf` and the bars are `isolation: isolate`): about 0.5 ms. Something moved along by its style each
  frame of a scroll (the timeline's scrollbar handle was) costs that every frame: about 4 ms with spring-brutalist's
  object rows shown. Draw it on a canvas.
- **Containment does not avoid it.** With `contain: strict`, with `will-change` layers, and moved by `transform`
  instead of other properties, elements that change every frame still make it paint and layerize.
- **A canvas redrawn every frame does not repaint the page.** It costs its drawing (script) and about 1 ms of commit.
- **Reading geometry after the frame wrote to the page forces a layout then**, and the frame lays out again later:
  `clientWidth`, `offsetWidth`, `offsetParent`, `getBoundingClientRect()`, `getComputedStyle()`. About 0.7 ms each time.
  Setting a canvas's `font` forces the style update the same way.
- **Data that arrives on the main thread is handled there**, between frames: a socket's bytes are read out on it, and a
  promise from `createImageBitmap` resolves on it. A busy main thread slows the stream itself, whatever the network can
  carry.

## Building interface that stays cheap

- **Streams do not pass through the main thread.** A socket or source that delivers many messages or many bytes a
  second lives in a worker, which decodes or forwards it and gives the main thread only what it shows.
  `viewerworker.js` holds the viewer's socket and decodes and scales its frames there (an `ImageBitmap` transferred);
  `pluginworker.js` holds the plugin instruments' socket and sends their sound to the worklet on a `MessagePort` of its
  own; `voiceworker.js` makes the samplers' sound off it, on a port of its own too. A message to the worklet that must
  stay in order with such a stream goes through the same port.
- **What the director is waiting on goes first.** A worker's page has one thread, and JavaScript cannot be stopped as it
  runs. Every request to the director's worker has a turn (`tools/nle.mjs`): `now` (a frame, a pick, overlays), `idle`
  (Converge, a step at a time) and `slow` (a question over the whole film: lanes run its code at every frame, seconds on a
  heavy film). A `slow` one never holds the page: it runs in `inGaps` (`engine/runtime.js`), which looks up every 24 ms and
  waits while anything urgent goes on or has just gone on. A new question over the film goes in `inGaps`; one that blocks
  the page holds every frame behind it. `inGaps` runs the film's code once for each moment and gives the scene to every
  question whose next moment it is (`each(t, i, s)`), so read the scene it gives you, not `film.scene(t)` again: the
  objects and the camera's lanes, asked together, then take one pass over a heavy film, not two. The film's idle work
  (warming up, pre-rendering) waits while a question is out. Keep what is `now` short: ask for the frame shown, not its neighbours with it. What
  the director acts on should not wait for a whole question: the gizmo needs only the playhead's moment of a thing's lanes
  (`at`: about 15 ms, and `now`), so the editor asks that first, then a few moments, then every frame (`nle/lanes.js`
  refresh). A pass over every frame runs all the film's code at each, for whatever one thing was asked.
- **Many shapes that move are drawn from data each frame, not kept as a picture.** The timeline's lanes (clips, waveforms,
  objects' bars, the grid) are recorded as boxes, waves and pictures and drawn by WebGL2 (`nle/lanesgpu.js`) each frame they
  move, onto canvases the size of the view: about 1 ms to record them again after a change or a zoom, a uniform's change to
  scroll. A 2D canvas could not draw them each frame (15 ms on spring-brutalist), and the picture it kept to scroll over
  was memory as big as what it held (about 150 MB with 106 object rows) and a 20–30 ms draw each time a scroll left it,
  stalling for 0.3–2 s with the GPU near full. Shapes that overlap keep their order by depth (`g.clip0`), not by batch.
- **A canvas drawn again as things move is WebGL2 or 2D, not WebGPU.** The editor's window shows a WebGPU canvas at about
  2.7 ms of the GPU process's main thread each frame it changes, however small: a 3413 × 643 canvas cleared each frame
  costs 3.9 ms with WebGPU, 0.7 with WebGL2, 0.85 with 2D. That thread composites the window and runs every canvas's
  drawing, so it caps how fast everything shows.
- **Raw frames do not go through sockets.** Over the route frames take, 8 MB at 1080p takes 37 ms and 49 ms of CPU across
  the processes, against about 25 and 26 for a JPEG; a plain copy of it takes 1 ms. The sockets are the cost, not memory.
  Frames drawn now reach the app's own window as a file the system holds in memory (`app/framefile.cjs`).
- **Measure a frame's route over a bare CDP connection** (`Runtime.evaluate` alone), not an automation library: one that
  turns on DevTools' Network domain gets a copy of everything a page sends on its own socket, as base64, which doubled the
  cost of raw frames in a test. Use a window out of the way, and run the studio with Electron as Node
  (`ELECTRON_RUN_AS_NODE=1`), as the packaged app does: a process manager such as `ananicy` may run anything named `node`
  at idle priority.
- **The audio thread does a block's work and no more.** A block of the live engine is 128 samples (2.7 ms at 48 kHz),
  and the worklet's messages run between blocks: one that takes longer stops the sound, and the messages queued behind
  it (one per pointer move while a knob is dragged) stop it for longer. A value being dragged goes to the worklet as its
  strip alone (`audio.tweak`), not the timeline, and what takes long to prepare is made by a worker and handed over: a
  reverb's impulse response (`irworker.js`; 50–400 ms to make), which the reverb takes as it comes, playing its last
  until then. Measure an effect's `set()` against the block before a knob reaches it.
- **While playing, the page changes as the film's frame does.** `tick` sets `paced` on the display frames where the
  film's frame did not change, and updates to the page (the readouts, the scrubber, the cues over the picture, the
  meters, the tracks' lights) skip them. What must move on every display frame, such as a playhead line, is drawn on a
  canvas. Anything that falls or fades is given the time since its last update (`dt`), so how often it updates does not
  change its speed.
- **A list that grows draws each item once.** The agent's thread (`nle/agent.js` paint) keeps an element per item and
  draws an item again only when it changes (`touch`), the latest 150 of them; drawing the whole of a long conversation
  again on each event of a streamed reply cost 107–161 ms a frame, item by item 3–6 ms. Pictures in such a list are
  references the studio serves (`tools/agents/images.mjs`, a thumbnail), never data URLs in the list's data: they were
  33 MB of one conversation's events.
- **Write only what changed.** Compare with the last value written, kept in a variable. Don't read the DOM back to
  compare: reading costs, and `style` and `innerHTML` serialize differently from what was written, so the comparison
  never matches.
- **Don't read layout in the frame loop.** Keep a size from a `ResizeObserver`, whose callback runs after layout, when
  reading is free. Learn whether a panel shows from an observer reporting zero size, not from `offsetParent`. Read
  geometry in event handlers, not in `tick`.
- **A new region outside the panels is a layer of its own** (`isolation: isolate`, as `.lay-leaf`). Popups use
  `position: fixed` and attach to `body`, so isolation does not trap them.
- **Decode images in a worker, then scale them on an `OffscreenCanvas`** (`imageSmoothingQuality: 'high'`).
  `createImageBitmap`'s own `resizeQuality: 'high'` looks the same but is slow when several decode at once.

## Measuring

The studio's window needs a debug port, and Electron cannot open one in a running app: launch it with
`--remote-debugging-port=<port>` (from the checkout:
`node_modules/electron/dist/electron app/main.mjs --remote-debugging-port=9229`). Quitting the studio ends the turns of
the agents running in its panel; `curl -s localhost:5340/api/studio` shows whether any is busy. The page exposes the
editor's state as `window.__nle`.

`frame-cost.mjs` attaches over a bare CDP connection, plays a few seconds, and prints what a
display frame costs by phase, how busy the main thread was, and which script entry points ran how often:

```sh
node .agents/skills/editor-performance/frame-cost.mjs --seconds 4 --at 3            # from 3 s
node .agents/skills/editor-performance/frame-cost.mjs --why                         # what changed the page, which reads forced a layout
node .agents/skills/editor-performance/frame-cost.mjs --tab Mixer                   # with a panel's tab shown
node .agents/skills/editor-performance/frame-cost.mjs --css '#scrub { visibility: hidden; }'
```

`--why` lists, per second, each change to the page with its element, its reason and the line of script that made it,
and the layouts that script forced, with their stacks. `--css` applies a stylesheet during the run and removes it after.
Use it to test a cause before changing code: hide an element (`visibility: hidden`) to see what its changes cost, or pin
a property (`!important`) to see whether its changes are the cost. Compare runs at the same place in the film, with the
same panels shown.

For script time by function, trace with `disabled-by-default-v8.cpu_profiler` over CDP (`Tracing.start`) and sum the
`ProfileChunk` samples per thread. It is heavy, so keep that run short. To see what the viewer shows while playing,
count the `drawImage` calls on `#frame`'s context, or read the badge, which shows `N fps` when playback is slower than
the film.

What misleads a measurement:

- **A frame the window did not draw is a freeze only if the page had something new to show.** The compositor draws only
  on damage: a page that did not change skips the frame (`Graphics.Pipeline`, `SKIPPED_REASON_NO_DAMAGE`), so gaps between
  `Display::DrawAndSwap` while the playhead waits for a frame are not stalls. Measure what the director does: real input
  (`webContents.sendInputEvent`: a wheel, a middle-button drag) at a panel that shows, and check in the page that it moved
  on every frame. A panel in a tab behind another has no size (`getBoundingClientRect()` is zero), a scroller can have
  nothing to scroll, and a wheel sequence stays with the element it began on for a moment after it stops.

- **The display sets how often the frame loop runs**: 60 to 180 times a second on a screen, and a hidden window may run
  it far less often. Compare runs at the same rate (`frame-cost.mjs` prints it).
- **CDP input waits for the main thread.** `page.keyboard.press` returns only once the page has taken the key, which
  can take seconds when the main thread is full. Dispatch events in the page instead. A focused text field, such as
  the agent's box, takes the keys as text: blur it first.
- **`page.evaluate` waits for the main thread too.** Time things in the page (`performance.now()`) or from the trace,
  not from the script.
- **Playing plays the film's sound where the director is.** Tell them before a run that plays, and leave the playhead,
  the tabs and the page as they were (`frame-cost.mjs` does).
- **A reload picks up changes to `nle/`.** A reload with unsaved edits asks first (`__nle.pending`).
