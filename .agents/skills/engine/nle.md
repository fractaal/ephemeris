# The studio, the NLE and timelines

One director per film: the studio is single-user, and it keeps the film's history in the film (`history/`).

Where a film is blocked out against its music: Ben edits the music and drops cues while listening (and watching the
film, rendered live), every edit is saved and kept as a version of the project, and the film is then built around his
cues.

```sh
./ephemeris                  # the studio: http://localhost:5340, a project picker; a timeline's editor at /p/<name>/<timeline>/
./ephemeris nle <name>[/<timeline>]   # the studio with it open [--url <film page>] [--port 5340] [--workers 8]
```

- **Studio**: one server for every project in `projects/`. It opens on a splash and a picker (each project's poster
  frame, length, fps, cues, last edit; New project makes one from the template). Project tabs below the top bar switch
  between open projects; +, the project menu or Ctrl+O opens another. Every project and timeline has its own runtime:
  opening another leaves existing editors and agents working. A hidden timeline keeps its file watchers and agent
  tools, rendering requested frames and drafts rather than filling an unseen preview cache. A project's film page is served on
  demand: the shared dev server, or the project's own (`project.json` `serve`), started by the studio if not running.
- **Timelines** are a project's sequences, `timelines/<id>.json`: they share the project's code, layers and media — a
  cut-down, a version to other music, or another film from the same parts (a timeline's `url` names its film page).
  `main` is the default: what `./ephemeris master <name>` renders and what a film plays without `?timeline=`; it keeps
  its name. In the editor they are the tabs over the timeline: + makes a new one (blank, with main's settings) or a
  copy; right-click one to duplicate, rename or delete it (each a version of the project). The tabs follow the
  project's timelines whatever changes them (an agent, a restore, another tool), and one made, changed or taken away
  outside the editor is kept as a version (`new timeline social`, `timelines/social.json changed`, `delete timeline
  social`); the open one taken away closes, its editor going to the project's first. `/p/<name>/<timeline>/` is
  its editor; `/p/<name>/` opens the last one used. Each has its own viewer frames and draft (`renders/<timeline>/`);
  the CLI takes `<name>/<timeline>` (`./ephemeris master my-film/social`). A film plays the timeline its page names:
  `const TL = await timeline(import.meta.url)` (`engine/runtime.js`).
- **Scene**, in the inspector with nothing selected: the scene's own settings (view, exposure, bloom, vignette, the
  sky's light and colours, the backdrop), each set or keyed there as an override over what the film's code sets.
- **Settings** are the timeline's, in the inspector with nothing selected: film URL, tempo grid, fps, size, shutter,
  samples, pixel filter, and global illumination, shadows and reflections
  for the whole film (`gi`, `shadows`, `reflections`: true turns on GI in every scene, traced shadows from every one of
  the scene's own lights, or traced reflections in every scene; false turns them off; left out, as the film's code asks;
  GI is experimental), and how they are traced (`rendering`: `{ gi: { probe, rays, bounces }, shadows: { rays, denoise },
  reflections: { denoise }, glass: { bounces } }`, each field over what the film's scenes ask, as a scene's `gi`,
  `shadows` and `reflections` and a glass's `bounces` take them; a field left out, or empty in the inspector, is as
  the film sets it, its value greyed there). They are saved in the timeline's file, so
  the viewer, drafts and every render (`master`, `stills`, `check`, `compare`) use them; changing one renders again.

- **Viewer**: the film, rendered live like an After Effects preview (`tools/preview.mjs`), kept on the timeline's
  audio clock. In the app on Linux the viewport draws it (see Workers), reading the cache's frames where they are current
  and giving it each it draws; what this says of frames drawn now by the studio is its way where the viewport does not
  draw, and until the viewport has drawn its first frame only the cache's frames show. Render workers (the studio's pinned Electron) render frames on demand into the machine's caches, out of the film (`~/.cache/ephemeris/previews/<film>-<hash>/<timeline>/preview/<frame>.png`:
  `tools/cache.mjs`; lossless, `tools/frames.mjs`; the draft, `renders/<timeline>/draft.mp4`, is made from them): the frame
  under the playhead first, the frames ahead of it while playing, then the rest of the film outward from the playhead
  (that last fill is **Pre-render**: see below).
  Whenever the film changes, every frame is rendered again. A change is: a file of the project its pages asked the
  film's server for (its code, pictures, models: `tools/nle.mjs` `madeOf`; any file of it while no page has loaded the
  film since it last changed, or where another server serves it), `engine/`, `elements/` or `assets/`, or the timeline —
  except what the film cannot see of it: cues it does not follow, and the note and label of a cue it reads only by its
  time and length (`C.at`, `C.end`; `C.get` reads all of it). A file beside the film that its pages never load (notes, a
  script that places sounds, a bake's own page) keeps the frames. An edit of the timeline's overrides alone (the
  director's changes: the gizmo, the inspector, the lanes) is taken in by the open pages as it is
  (`window.__overrides`), with no reload (launch: ~2 s saved per edit; frames byte-identical to a fresh page's); the
  shutter and the viewer's sub-frames draw the frames again on the pages as they are; anything else reloads them. Until a frame has rendered
  again, the viewer draws it at once from the studio's viewing worker as the editor has the timeline, saved or not
  (asked over the viewer's socket, `…/api/viewer` (`tools/nle.mjs` `viewerSocket`): drawn at `scale`, as Delivery says below;
  `draft`: overrides, for that frame only): at
  the Preview size, half of it and without motion blur while something moves, then as the cache draws it, with Converge
  on shown as it is drawn (its sub-frames spread over its shutter, lens and pixel, the frame so far after the first and
  then about ten times a second, "3 / 8 sub-frames" in the badge; whole, it lands up to half as long again later). A
  frame of the previous version is shown only while
  nothing newer can be (a cue edit before its reload), marked "updating". Playing shows the cache's own frames (drafts'
  quality, kept): it renders ahead of the playhead by about a frame's render time, so frames land as the playhead
  reaches them. Over an edit the cache has not rendered yet (a gesture while it plays, or a change just made), frames
  are drawn at once instead, as the director's view draws them while playing (each a round trip ahead of the playhead,
  half size, no motion blur; asked `ahead`, which leaves the cache rendering with one worker fewer for each that draws
  them, and at least one), until the cache's are current. The
  viewer's frames come over that socket as soon as the cache stores them, PNGs the browser decodes off the editor's main
  thread. All films' caches together stay under a limit set for the machine (`tools/cache.mjs`, 10 GB unless set; the
  page bar's Cache shows it and sets it): past it, the films opened longest ago lose theirs first, then the open film's
  other looks, then its frames farthest from the playhead (after which it renders only near the playhead until the limit
  is raised); a draft's frames stay until it is made. A cache keeps what its frames are made of (a fingerprint of the
  film's files, Ephemeris's and the timeline), with what the film's pages said of it then (its length, cuts, cues and
  parts): a timeline opened again, after a switch or a restart, keeps the frames still current and knows its film at
  once. The studio's viewing worker's answers about the film as it is (its objects, lanes, lights, passes, camera path
  and samples) are kept the same way for the timelines opened latest, so a timeline switched back to, its film
  unchanged, has them at once; a question asked again while it is answered waits for that answer.
  The timeline bar's **Drop frames** (on the music's clock: a frame not rendered in time is skipped, the
  picture holding) or **Every frame** (each shown, silent, slower if need be; the cache renders the next) is Blender's
  playback choice. Pressing play saves pending edits first, so the frames ahead render with them. `preview` in the state carries
  `key`/`base` (the timeline as the frames show it, `nle/anchors.js` `filmSees`), so the editor can tell. A film that
  fails to start shows its error in the viewer. Frames are drafts' quality (the timeline's fps, shutter and viewer
  samples). The editor mixes and plays the timeline itself (Web Audio), so audio edits never render.
  The **Metronome** (beside Snap, K) clicks each beat of the timeline's grid as it plays (each part's tempo and metre
  where the grid follows the music), a bar's first beat higher, with its volume beside it. It is the director's alone:
  added after the master (`nle/metronome.js`), never in a render or on the meters.
- **Looks** (the viewer's four buttons, Z): how the viewer draws the film, as Blender's viewport shading.
  - **Accurate:** the film as it renders. Drafts, masters and what agents see (the frames tool, the frame in the panel's
    context) are always this.
  - **Fast:** nothing traced (reflections of the studio around, the scene's lights unshadowed) and one sub-frame (no
    motion blur or depth of field).
  - **Solid:** each mesh matte in its own colour, in a plain studio's light: no glass, glow, mirror or the scene's lights.
  - **Wire:** meshes' edges and layers' outlines.

  Accurate keeps its frames. Another look keeps its own (preview-<look>/ beside preview/) only while it is shown, and
  draws them again on coming back; they never take room from Accurate's. The director's view follows it. `./ephemeris stills <name> <t> --look solid` renders one; the renderer's
  `look` (LOOKS in engine/render/index.js) is how.
- **Layout** (nle/layout.js): the panels (viewer, inspector, cues, timeline, the agent) are laid out as the director likes,
  kept for the machine: drag the edge between two to resize them; drag a panel's grip (⋮⋮, the start of its header)
  onto another's edge to put it beside it, its middle to make them tabs, the window's edge to run it along that side;
  ⧉ opens it in a window of its own (another screen), closing that window docks it back, and the windows open again
  with the studio. The top bar's layout button resets it. A panel in its own window is still the editor's page (the
  same code, state and keys): code that reaches for an element, a key or the frame loop goes through layout.js
  (find, onEvery, bodyClass, frame) so it works there too.
- **Overlays** (the viewer's Overlays, Shift+Alt+Z all off and on): what the viewer draws over the picture, each view its
  own, as Blender's viewports. The scene's lights (a mark each), the selection's outline, its handles (Move, Rotate and
  Scale, each on or off; G, R and S work either way; a light has only Move), a grid on the world's floor (y = 0, a
  line every 100 px, the X axis red and Z blue), and in the director's view the film's camera and its path. By default
  all on, except the grid over the film's camera. Kept in the director's browser; never rendered.
  Each picture's are those of its own frame: the editor asks for the frames it shows next, a few at a time (`POST
  …/api/overlays { times, sel, draft, camera }`: the film's camera, the scene's lights and the selection at each), and
  draws them in the world, through the camera of the picture shown.
- **Stats** (the viewer's Stats, beside Cues; kept for this machine): what drawing the picture shown took (engine/render/profile.js): the page's time on the film's
  code (each time its scene(t) ran), its layers, the scene's data, the GPU's commands and waiting for the GPU, saving or
  encoding it; and the GPU's time in each of the renderer's passes (the film's own by their labels, the GI's and the
  denoiser's stages by theirs) and how much of its time from first pass to last it was in one. While it shows, the
  studio times every frame it draws, and each comes with its profile; Profile this frame draws one drawn before again,
  now (`POST …/api/profile { t, draft, master }`, as the MCP server's profile tool and `./ephemeris profile <name> [t]`
  do).
- **Director's view** (the Director tab over the viewer, or V): the scene at the playhead from a camera of your own,
  outside the film's — drag to orbit, right-drag (or Shift-drag) to pan, the wheel to dolly, F to frame the film's
  camera again. The film's camera is drawn in: its frustum at the playhead (a mark on top for up) and its path through
  the film, one line per shot. Workers of its own render it (opened on first use, closed after five minutes unused): one
  while its camera moves (the same moment from another angle needs no DOM or captures: ~30 frames a second at half
  size), up to three while it plays (as many as make it faster). Playing, you can still move the camera: frames are asked for just ahead of the
  playhead, each from the camera as it is then, and drawn at once with the layers as last captured while the page
  catches up in the background (~12 captures a second), so motion and the camera run at full rate and only what
  animates inside a layer can trail a frame or two (a product film's six live layers: ~35 frames a second). Its overlays (the grid, the scene's
  lights, the selection's outline and handles) are drawn from the camera of the picture shown, from where they are in
  the world, so they move with it, playing or not. While it is in use the viewer's preview
  starts no new frames. Screen-space nodes and post belong to the film's camera and are left out. For agents:
  `POST /p/<name>/<timeline>/api/director {t, camera}` → a JPEG (camera as the film's: x, y, z, zoom, yaw, pitch,
  roll, focal); `POST …/api/director/path {times}` → the film camera's pose at each.
- **What changed**: a re-rendered frame that differs from the version it replaced is highlighted (the accent) on the film's
  strip (under the timeline's ruler, and under the viewer's scrubber), and the viewer's header counts them: after editing a
  film, that is exactly where the edit landed.
- **Workers** (the viewer's header, for this machine: Dynamic or a number): how many render the viewer's frames. In the
  app on Linux the first is the editor's own film, the **viewport** (`app/viewport.cjs`: the film's page in a browser
  and GPU process of its own, each frame handed to the editor's window as GPU memory, `app/frames.cjs`, and drawn there
  with the overlays and gizmo over it): it draws the Preview and the Director view, the frame under the playhead
  included, and fills the cache while nothing else is drawn. "1 worker" is it alone; each more is a render worker of
  the studio's, filling the cache beside it (the frames ahead while playing, then the rest), never the playhead's frame,
  and not making its shaders ready first (the viewport makes its own: no frame of the workers' is waited on).
  Where it is alone, what only a render worker draws (whole: a draft's range, an agent's `frames`; and what the film
  says of itself before any page has loaded it) opens one, closed 30 s after its last frame. Elsewhere (another
  device, an app that cannot share frames, a film that does not start in the viewport) render workers draw them all,
  the playhead's first. Dynamic: as many as make filling faster, measured as they render (`worker.mjs` `crew`, the
  viewport's frames counted): one to start, another while the one last added made them at least 15% faster; one fewer
  if the GPU runs out of memory or will not start another. A film that is mostly GPU work (ray tracing, depth of field: duck) settles at one, since more only queue on
  the GPU and the desktop waits behind each; one that is mostly the page's work (capturing the DOM: launch) at several.
  They close after 30 s with nothing to render. Renders (`master`) work the same way, two seconds of frames at a time.
- **A frame the GPU refuses** (out of memory, a shader it cannot use) comes back black or part drawn, like any other. So
  each frame asks the GPU before it goes anywhere (`runtime.js` `unrefused`), and one refused fails where it is: it is
  never shown or kept, and that page is closed. Out of memory, another worker draws it, and the viewer's workers give one
  up when the page refused is the one the director's view or an agent is waiting on.
- **What Ephemeris takes** (the page bar, `tools/machine.mjs`): every process under the app, CPU as a share of all the
  computer's cores, memory with what they share counted once (Pss on Linux, the footprint Activity Monitor shows on
  macOS; not shown on Windows). Its tooltip lists the window, the studio, the render workers and what else they started.
- **Slow frames**: where the viewer's frames take a second or more each to draw, three in a row (past a worker's first,
  its shaders compiled), the status line says `Slow: 9.3 s a frame`, and every agent in the project gets a studio note
  saying how slow, where and at what size: at its next step if it is working, else with the director's next message
  (`preview.mjs` SLOW_MS). Said again only once frames come quicker or take twice as long.
- **Shaders** (no setting): a film's pipelines are made before a worker takes frames. The renderer compiles every surface the film has made, whichever a shot uses, so a shot with others compiles nothing; and a worker first draws a small frame at each moment that wants pipelines another does not (`Renderer.wants`, runtime.js `__warm`, worker `warm`), so that it never holds a frame the playhead waits for while it compiles. A film's first worker draws one frame first, as there is nothing to show until it has. A browser that has made the same shaders ready is not made ready again: a page loaded again for a cue, or for code that changes none of its shaders, draws at once (spring-brutalist: 52 s saved a worker). The same shaders are those of the same fingerprint, the page's of the film's WGSL, frame, render settings and GPU (runtime.js `shaderSet`) with the studio's of Ephemeris's files; each browser profile keeps those it has made ready (`~/.cache/ephemeris/warmed/`, cleared with the GPU caches). On our own Electron compiled shaders go in one folder every browser shares; on stock Electron each profile keeps its own (`tools/browser.mjs`). The viewer's compile badge counts a pipeline as compiling once the GPU has done what was sent before it (`render/compiling.js`): one from the caches is made by then, and not shown.
- **Converge** (the viewer's Converge, on unless turned off; kept for this machine): a paused frame the viewer shows as
  the film is goes on being drawn past the timeline's samples, up to 256, a moment at a time on the viewing worker
  (`{ type: 'converge', key, t, n }` over the viewer's socket; runtime.js `__converge`), its count in the badge, shown over
  the film's own once it has as many. What fades as it climbs is noise from too few samples; what stays is the
  renderer's error. Hold Q to see the film's own samples. The cache renders 15–35% fewer frames while it does (on
  doctor-who-intro-max: they share the GPU); playing stops it. The director's view at rest converges too, from its
  camera (`camera` in that message): at the playhead, without motion blur or the film's post, as its one sample is drawn,
  over which it shows once it has as many sub-frames as Preview's; Q shows that sample, moving the camera begins again.
- **Pre-render** (beside the workers; on by default): the viewer's rendering of the rest of the film outward from the
  playhead. Off, only what is needed is drawn: the frame under the playhead, the frames ahead while playing, the frames
  an agent asks for (`frames`) and a draft's range; after a change to the film, the frames outside those stay stale
  until the playhead reaches them, and the status line says `Pre-render off`. It leaves the GPU alone, so a timing of
  the renderer (`profile`, `./ephemeris profile`, a benchmark) is not skewed by the fill, and a change being iterated on
  does not render the whole film each time. It is the whole studio's (every timeline), kept until the studio restarts
  (a setting left off does not outlive the session), and the same for every editor: the button in the viewer's header
  (`preview.mjs` `prerender`), or `GET`/`POST /api/prerender {on}` (the MCP `prerender` tool, which also says which it
  is; `status` shows it too). Turn it back on when done: the director's viewer is empty past the playhead while it is
  off. Drafts are not changed by it: asking for one renders the frames of its range that are missing, as always, so a
  draft made with it off takes as long as the frames take.
- **Preview size** (beside the workers): how many pixels the viewer's frames are drawn with, kept in the browser.
  **Dynamic** (the default; its label says the size, `Dynamic · 960 × 540`) draws as many as the viewer shows (its
  pixels on the screen), in steps of an eighth of the film's frame from a quarter to whole; or **Full**, **Half**,
  **Quarter**. Drawing a quarter of the pixels takes less than half the time (a heavy film, 4 sub-frames on a 5070 Ti: 156 →
  71 ms a frame at half), and a frame is the same picture at any size (`engine/render/index.js` `resize`: the camera and
  everything placed keep the film's frame px). Each frame remembers the size it was drawn at; one smaller than the
  viewer now wants is shown while it is drawn again. Drafts' frames, and those an agent asks for, are drawn whole. With
  several editors open (the desk's and a phone's), frames are drawn at the largest size any of their viewers wants.
- **Delivery** (beside the workers; kept for the device): how the cache's frames reach this screen. **Lossless** sends
  each as it is kept (a PNG: 0.5–2 MB); **Compressed** a JPEG that fits the viewer (`tools/frames.mjs` `compress`:
  about a tenth to a twentieth of the bytes, made in 10–75 ms); **Auto** (the default; its label says which it chose)
  is lossless on the studio's own machine and compressed on any other device. Frames drawn now (a drag, an unsaved
  edit, Converge) come without loss to the app's own window on the studio's machine: the render browser's process writes
  each to a file the system holds in memory, the socket says which, the window's process reads it (`app/framefile.cjs`;
  film pages and the window keep their sandboxes, so the bytes cross Electron's IPC at each end). A plain browser or
  another device gets JPEGs, and so does the window from the moment it fails to read one. The viewer says all this over
  its socket (`{ type: 'view', delivery, w, h, scale, memory }`). A compressed frame is made as it is queued, so the
  frames ahead are ready when the socket is.
- **Other devices** (a phone, another computer, over Tailscale or the local network): they open the studio at
  `http://<this machine>:5340` with the password in Settings › Other devices (`remotePassword` in
  `~/.config/ephemeris/config.json`), which the browser asks for once. The studio's own machine is never asked; a
  request a local proxy forwards counts as another device's; with no password set, other devices are not let in. Over
  plain http another device's page is not a secure one, so it has no live engine (no AudioWorklet). Its viewer shows the
  connection under the frame's badge (`nle/app.js` NET): the studio's answer time (a `ping` over the viewer's socket
  every 3 s), how much is coming of how much it can carry (`2 ms · 1.4 of 24 Mbit/s`: the cache's frames sent straight
  after the one before, `waited` in their header, timed as they arrive), and whether that is enough to play at the film's
  frame rate (`enough to play`, `only just enough`, `about 11 of 24 fps`), its dot green, amber or red.
- **The simple view** (a phone's; Auto by the screen, or View › Simple view and the header's Full editor, kept for the
  device): the viewer with its controls, a scrubber and the transport (Drop frames / Every frame too), each going on to
  another line where the screen is too narrow, and the agent; nothing else. It hears the studio's mix in place
  of the live engine (so does any page without one): the timeline's sound made by the draft's engine (`tools/mix.mjs`),
  as AAC, `api/mix` (`{ key, ready, none, error }`) and `api/mix/<key>.m4a`, made again when what is heard changes (the
  tracks heard, their media, the mixer, the grid, the sound code, the instruments); the editors hear `mix` when it is.
- **R** saves the film as a file, `projects/<name>/renders/<timeline>/draft.mp4`, with the timeline's music, from the viewer's
  frames (rendering any that are missing, or drawn smaller than whole, first); only the in/out range when one is set (I/O, or shift-drag the ruler).
  Its sidecar (`.json`) records url, fps, range, duration, cuts, cues and the Ephemeris version.
- **For agents**: `curl localhost:5340/p/<name>/<timeline>/preview/<frame>.jpg` is that frame as the timeline on disk
  has it, once rendered (frame = floor(t × fps)), at the size it was drawn (the viewer's: `sizes` in the state, a
  digit a frame, in eighths of the film's frame; `POST …/api/preview/want {frames}` draws them whole, as the frames
  tool does); `curl localhost:5340/p/<name>/<timeline>/api/state` → `preview` has each frame's state (`frames`: one digit per frame, 0
  none, 1 stale, 2 current, 3 current and changed by the latest change), the film's duration, cuts, the cues it
  follows, and any error. These address the named timeline independently of what the director is viewing; a request
  opens its runtime on demand without navigating an editor.
- **Lanes**: Film (read-only: its shots and hard cuts, and the bar of rendered frames), Cues, and audio tracks. Press ?
  for the keys.
- **Autosave**: 2 s after the last edit (never mid-drag), the server writes the timeline's file and keeps the project
  as a version, with a message listing the edits (`move cue "team" 26.90 → 27.41; split "sayso" at 33.20`). Failures
  show in the top bar with a Retry.
- **History** (the tab beside Cues; `tools/history.mjs`): the project's versions, newest first. A version is the whole
  project as it was together: every timeline and the film's code — its text files, apart from folders named `renders`,
  `media`, `assets`, `instruments`, `node_modules` or `history`, a folder that is a repository of its own, dot-files,
  links and files over 1 MB. The studio keeps one whenever the project changes: each save of the editor's or an
  agent's (with its message), and any other change to the project's files once they have been still for 1.5 s
  (`film.js changed`; `edit film.js` from the Code panel). Clicking one shows what it changed in the Code panel;
  Restore writes that version's files over the project's (removing the files it did not have), after keeping what is
  there, and keeps the result as a version of its own (`Restored version 12 (…)`): restoring the one before undoes it.
  `./ephemeris history <name>` lists them; `<n>` shows what version n changed, `--since <n>` what changed after it,
  `--path <file>` one file's diff, `--restore <n>` restores it.
- **Outside edits** to a timeline's file (notes or cues written by another tool) reload live when the editor has
  nothing pending; otherwise it asks which version wins. Either way the outside edit is kept as a version first.
- **Code** (a panel, a tab beside the timeline's): the film's code — the files a version holds, its timelines aside —
  in an explorer of the project's folders (nle/explorer.js, shared with the Assets panel: each folder listed as it
  opens; right-click makes, renames or deletes a file of the code, each kept as a version: `new file parts/sky.js`,
  `rename …`, `delete …`; any other text file, a timeline or one in `assets/`, opens read-only) beside an editor
  (CodeMirror). Ctrl+S writes the file, and the viewer renders
  the film again. A file changed on disk is loaded where it has no unsaved edits; otherwise the panel asks which wins
  (the disk's is kept as a version either way). Every line of code the studio names opens there at that line, marked:
  the inspector's Placed and Made lines and its code, a lane's line and code, an object row's, the agent's `film.js:57`
  links and its `show { code }`. A line of Ephemeris's own code (`engine/…`, `elements/…`) opens read-only.
- **Media** (the Assets panel, beside Cues): an explorer of the project's folders that opens at `assets/` (its path
  goes up to the project's folder and back): sounds, images and video, each with its picture, size, length and frame
  rate (tools/media.mjs probes a folder's as it opens), and other files listed. Files dropped on the editor, on the
  panel, or brought in with Import are copied into `assets/` (the folder of it the panel shows): a project holds
  everything it is made of (its assets are in no version). A file is placed where it is: a medium's `src` is its path
  in the project. A project from before assets/ held its sounds and footage keeps them in `media/`, which works the
  same.
  Dropped on the
  timeline, or dragged there from the panel (a double-click: at the playhead), a sound goes on an audio track and a
  picture on a **Pictures** track (`kind: "visual"`, above the audio tracks), an image for 5 s at first, a video for
  its length. The film shows each picture **in the world where its clip starts**: a card under the film's camera,
  centred where it looks, facing it, filling its frame there (covering it). It then belongs to the scene: parallax as
  the camera drifts, motion blur, reflections in glass, and it sits at the camera's focus, so push it back (z) to make
  it a backdrop. It is selected, moved and keyed as anything the code places (its site is `clip:<id>`, no line of
  code). Later tracks draw over earlier ones. A video shows its exact frame for each moment: its frames are decoded
  once by ffmpeg into `renders/<src>/` (in no version; decoded again where missing, as the editor opens the
  timeline), never a `<video>` seeking near one. A video with sound brings it: its sound goes on an audio track at the
  same time (its own media entry, `kind: "audio"`, the same file), trimmed and moved on its own.
- **Final renders** use the same mixer: `./ephemeris master <name>` (render.mjs `--audio projects/<name>/timelines/main.json`;
  or `node tools/mix.mjs projects/<name>/timelines/main.json out.wav`), so the film sounds exactly like the editor.

### A timeline (`timelines/<id>.json`)

```json
{
  "version": 2,
  "fps": 24,
  "shutter": 45,
  "size": [1080, 1920],
  "url": "http://localhost:5320/projects/<name>/",
  "grid": { "auto": true, "bpm": 116.044, "offset": 0.0621, "beatsPerBar": 4, "media": "sayso" },
  "media": {
    "sayso": { "src": "assets/sayso.wav" },
    "poster": { "src": "assets/poster.png", "kind": "image", "name": "poster.png", "w": 1600, "h": 1000 },
    "launch": { "src": "assets/launch.mp4", "kind": "video", "name": "launch.mp4", "w": 1280, "h": 720, "duration": 3, "fps": 30, "frames": "renders/assets/launch.mp4" }
  },
  "tracks": [
    { "id": "v1", "name": "Pictures 1", "kind": "visual", "clips": [
      { "id": "c2", "media": "poster", "at": 1, "in": 0, "out": 3 },
      { "id": "c3", "media": "launch", "at": 4.5, "in": 0.5, "out": 2.5 }
    ] },
    { "id": "a1", "name": "Music", "clips": [
      { "id": "c1", "media": "sayso", "at": 0, "in": 12.85, "out": 33.52, "gain": 0, "fadeIn": 0.06, "fadeOut": 0 }
    ] }
  ],
  "cues": [
    { "id": "q1", "t": 20.69, "dur": 0, "label": "drop", "note": "logo slams in on the kick" }
  ]
}
```

- `version` is the timeline's format: one in an older format is migrated as the studio opens it (tools/migrations: a
  version of the project kept first, so the History undoes it), and as the command line and renders read it.
- A track is a hybrid, as Bitwig's: its `instrument` (the sound skill's forms) plays the notes clips on it, and its
  effects shape every clip on it, notes or sound; its instrument's automation is `automation.instrument`.
- Times in seconds. A clip plays its source from `in` to `out` starting at timeline time `at`; `gain` in dB;
  `speed` (default 1) plays it faster or slower with its pitch, as tape does (0.5: an octave down, twice as long; a
  clip then lasts (out − in) / speed on the timeline): variants of one sound without new files;
  `fadeIn`/`fadeOut` in seconds (raised-cosine curves). `media[].src` is relative to the project directory.
- `size` (`[width, height]` px, each even, 64 to 8192; none means 1920 × 1080) is the film's frame: its aspect, and
  the px of the camera, placement, `screen` nodes, passes (`film.size`), picking, the viewer, stills and the master. A
  timeline can have its own (a vertical cut-down of a wide film). Preview size is a scale of it.
- `fps` and `shutter` (the shutter angle in degrees: 180 exposes half of each frame interval; 45 is crisp and
  staccato) are the film's frame rate and motion blur. The NLE's viewer and drafts use them; `./ephemeris master` passes them to render.mjs. A scene can still open the shutter for a frame (a swish's whip smear).
- `samples` (`{ "viewer": 4, "master": 64 }` where left out) is how many times a frame is drawn, each a fraction of a
  pixel over (and across the shutter), and averaged: antialiasing and motion blur. The viewer and drafts take
  `viewer`, `./ephemeris master` takes `master`; depth of field (`dof.samples`) and a fast camera take more. Too few
  shows a thin bright edge (a rim light on a face side-on) as dots or dashes. `pixelFilter` (px, 1.5 where left out)
  is how far each pixel gathers those samples (Blackman-Harris, as Blender's): wider is softer, narrower sharper and
  more aliased. `pixelFilterType: "box"` spreads them evenly across the pixel instead, and the width is not used. The
  inspector calls samples sub-frames.
- Cues are points (`dur: 0`) or ranges (`dur > 0`); `label` and `note` are the director's words for what happens there.
  `id` is the cue's name: what the film calls it. New cues are named q1, q2…; the director renames them in the
  inspector (Name). Cues the film follows carry an accent dot and a "film uses this" badge (what the film reported when the
  viewer last loaded it), and deleting one asks first. They
  conduct rather than gate: a cue anchors the beat that matters, and things lead in and follow through around it.
- **Annotations** are cues pinned to an object: the director clicks something in the viewer (either camera), the
  inspector shows what it is and the line of the film's code that placed it, and Annotate (A) makes a cue with `on`:
  `"on": { "label": "card", "kind": "layer", "at": "film.js:123:19", "nth": 0, "copy": 6, "point": [x, y, z] }`.
  `at` is the call that placed it (file:line:col, the page's directory being the project's), `nth` which of the nodes
  that call placed (in a loop), `copy` which copy of a `many()` (omitted for one), `kind` mesh, glass, layer or title,
  and `point` the world point clicked (`screen: [x, y]` in frame px for a title). Its `note` is about that thing at
  that moment. It is found again with `POST …/api/locate { t, camera, at, nth, copy }`; `POST …/api/pick { t,
  camera, x, y }` is what is under a frame point (camera null: the film's). Line numbers are the code as it was when
  the note was made: after editing the film, check the history (`history`, a version's diff) if a line moved.
- **Agents** reach the studio through its MCP server (`./ephemeris mcp`, stdio; docs/manual/agents.md): status,
  frames (images), view, camera, pick, locate, stacks, profile, prerender, timeline, write_timeline, history, restore,
  show (point the director's
  studio at something), check, render_draft, manual. Each connection selects its own timeline (`--project <name>
  --timeline <id>`, or `open`); without an explicit choice it binds once to the last editor opened. Navigation does not
  retarget it. Panel agents (each harness of tools/agent.mjs) use the same server, bound to their own
  project. New agent adds an independent conversation; tabs select one, Stop interrupts it, End closes it with its
  transcript kept. Its `open` selects a timeline within that project, not the director's view. Messages start with
  `<studio>…</studio>`, what the director showed as they wrote, and the studio's own notes since (frames slow to draw). Agents share live files and history; timeline writes
  based on stale contents fail rather than replacing unseen edits.
- **Overrides** are the director's changes to the film's motion, made in the timeline's motion lanes and the
  inspector, and applied by the runtime as the film is evaluated (`engine/overrides.js`, `engine/motion.js`), in the
  viewer, drafts and masters alike. The manual's motion chapter (docs/manual/motion.md) has the model and the schema:
  changes to a motion the code writes (`{ "stack": "film.js:56:6", "ops", "order", "muted", "lanes" }`), and lanes
  over a placed thing's plain values (`{ "on": { "at", "nth", "key" | "like" }, "props": { "y": { "lanes": […] } } }`)
  or the camera's (`"on": { "camera": true }`), or the scene's own settings (`"on": { "scene": true }`: exposure,
  transform, bloom, vignette, the environment's intensity and colours, the backdrop; set in the inspector's Scene,
  over the code's `view`, `post` and `environment`). `on` names the thing as annotations do (`key`: a copy's `id`; without
  one, `like`: its fields, which find it again in a list the film rebuilds each moment). An older form of `props`
  (a value or keyframes `[{ t, v }]`: position and turn offsets, scale a factor, the rest values) still reads; a colour
  (`baseColor`) is always a value. `POST …/api/stacks { t, sel }` says what a thing's properties (or the camera's:
  `sel: { camera: true }`; the scene's: `sel: { scene: true }`) are made of at t; `…/api/lanes { sel, duration, fps, cuts, at, draft }` (at: the moment alone, at once; draft: the editor's overrides for that moment) what gives each at every frame
  (the parts the lanes show: a rig for each shot, the code); `…/api/samples { sel, ks, times }` the code's own values.
  A stack's id is its `name`, or the line that made it (numbered, `#2` on, where one line makes several). When asked to fold
  overrides into the code, change the code so the film looks the same without them, then remove them from the
  timeline (one write, saying so); never drop one silently.
- `grid.offset` is where bar 0 starts. The editor shows bar.beat.sixteenth zero-based, like `tempo(TL.grid).b(bar,
  beat, six)`, so a cue it shows at 10.0.0 is `b(10)` in film code. `grid.auto` (Detected, a new timeline's default):
  the grid follows the music, written by the studio (nle/model.js `detectedGrid`, from each song's beats:
  tools/music.mjs, kept in renders/<src>/music.json): `bpm`, `offset`, `beatsPerBar` and `media` are the first
  song's, and where a later song sets another tempo or metre, `map` lists a part per song (`t` where its clip starts,
  its `bpm`, `offset`, `beatsPerBar`, `bar`: the number of its first bar line, `media`, `speed`). `grid.track` is an
  explicit Tempo master: only qualifying music clips on that audio track can drive the detected grid; the track is set
  from the timeline's right-click menu. Without it, legacy Auto detection considers qualifying audio tracks. Don't
  write the grid of a Detected timeline: move the music and the grid follows; a value the director types makes it theirs
  (`auto` gone, one tempo). `tempo(TL.grid)` (engine/grid.js) reads either; `tempo(116)` stays one tempo from 0.
- Clips that touch on a track (one ends where the next starts) crossfade over 12 ms centred on the splice: equal
  power between different audio, equal gain across a split (so a split plays back seamlessly). Any other clip edge cut
  into its source fades over at least 4 ms. Nothing clicks.
- A film reads its timeline (cue times, grid, music length) with `const TL = await timeline(import.meta.url)`. The
  file is written one clip/cue per line so a version's diff (`history`) reads as a list of edits.

