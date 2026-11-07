# Ephemeris

Ephemeris is a human-directed, agentic creative launchpad for making audiovisual work: motion graphics, programmable
visuals, music-driven pieces, product films, 3D/VFX shots, title sequences, and whatever sits between them.

It is designed for a person who wants to stay involved in making the work, not just prompt a generator and accept or
reroll its answer. The agent works inside the same editable project as the director: film code, timeline, media, music,
assets, rendered frames and history remain visible to both sides, while the source and timeline stay changeable. The
agent can propose, prototype, implement and inspect; the person can direct, grab a lane, change a note, audition a sound
or rewrite the idea.

The studio is deliberately open at its rendering boundary. Its shipped camera, layers, meshes, lights, effects, passes
and surfaces are useful starting points, not a closed visual language. A film can use them, replace them, write its own
WGSL, bring in external assets or the result of a specialist tool when that is the better choice, and keep the work in
the same directed project. Ephemeris is not trying to be a worse copy of every specialist application; it provides the
shared time, project and agent loop that lets visual and musical work meet.

The technical substrate is a time-addressable film: HTML/CSS and WebGPU form the visual world, and every frame is a
pure function of film time. That makes renders reproducible and parallelizable, while the NLE gives a person a place
to direct the camera, motion, cues, music and edits. Determinism is what makes the project inspectable and renderable;
it is not the whole identity of the studio.

Agents that build work here start with `AGENTS.md`; the skills (`.agents/skills/`) are the studio's reference and
procedures, and `.agents/styles/` holds house styles that agents read when they fit a piece.

## Quick start

```sh
npm install
./ephemeris new my-film          # projects/my-film/: a blank film, its history begun
./ephemeris serve                # http://localhost:5320/projects/my-film/
./ephemeris                      # the studio, http://localhost:5340: pick or make a project; music, cues, notes, the film
                                 # rendered live (each change a version). ./ephemeris nle my-film opens it straight away
npm run dist                     # the app in dist/: AppImage (Linux), .dmg (macOS), Setup.exe (Windows x64)
./ephemeris app                  # this checkout's studio in the app's window
./ephemeris check my-film        # the quality gates
./ephemeris master my-film       # the finished film, with its music, into projects/my-film/renders/
./ephemeris snapshot my-film     # reference frames; ./ephemeris compare --all shows which films a studio change alters
```

The app (`npm run dist`) needs nothing else on the machine (it brings its own Node, ffmpeg and ffprobe, pinned): on
first run it asks for a workspace, the folder its films live in (`~/Ephemeris`), and links the studio in
(`tools/workspace.mjs`). From a checkout, Ephemeris needs Node 22.15+, ffmpeg, git and a GPU with WebGPU; `npm install`
provides its pinned Electron. The editor, film rendering, GPU models and icon builds use that same Electron runtime—
there is no separate Chrome download on Linux, macOS or Windows. Each render worker runs in its own Electron process,
with hidden pages and a GPU process separate from the editor. Linux rendering is offscreen/headless and needs no X
server or Wayland session; macOS uses Metal and Windows uses Chromium's Windows GPU backend. As many workers run as
make rendering faster, measured as they render. One director per film: the NLE is single-user.

## Windows

On Windows 11 x64, use `ephemeris.cmd` from PowerShell or Command Prompt in place of `./ephemeris`:

```powershell
npm.cmd ci
.\ephemeris.cmd new my-film
.\ephemeris.cmd app
```

A checkout needs Node 22.15+, Git for Windows and ffmpeg on `PATH`. No Unix utilities, symlink privileges or Developer
Mode are needed by the app or its workspaces. Agents that
use Bash need Git for Windows and the agent provider's own sign-in. The app also supplies `node` and `./ephemeris`
launchers for Git Bash, so the skills' commands work there without a separate Node installation.

To build the self-contained installer, install Visual Studio Build Tools with **Desktop development with C++**,
including CMake and a Windows SDK, then run `npm.cmd run dist`. The build compiles the plugin host and Vial as x64
Windows binaries and includes them, their licences, Node, ffmpeg and ffprobe. `native/plughost/build.ps1` and
`native/vial/build.ps1` build the helpers separately; `EPHEMERIS_CACHE` selects their build cache. Windows plugins are
found in the standard per-user and Common Files VST3 folders, as well as the studio's own and the folders in Settings.

Builds are unsigned. SmartScreen can warn, and enforced Smart App Control/App Control policies can block the app or
its native helpers. Public distribution needs trusted signing of the installer and native binaries; do not turn
off a user's security policy as part of installation. Rendering needs a WebGPU-capable adapter and driver; a VM's
software adapter is not evidence of physical-GPU performance or of a plugin editor's OpenGL support.

Windows is a development build, not a validated graphics release. The Windows 11 VM's Microsoft Basic Render Driver
runs HTML layers but crashes Chromium's GPU process on mesh rendering. GPU-backed rendering and plugin-editor graphics
still need validation; the port does not silently change graphics backends or omit 3D features.

## Layout

```
engine/      the frame: clock, camera, layers, meshes and models, the renderer (engine/render), effects, passes, surfaces, runtime
elements/    building blocks: sequence (scenes), headlines, the pointer, typing, reveals, rings; looks/ (sdf, fog)
tools/       render, check, nle (server), mix, inspect, ephemeris (CLI)
nle/         the editor
app/         the studio as a desktop app (Electron): its window, icon, what it brings in place of a checkout, its build
assets/      shared assets (macOS pointers, GPL-3.0, see assets/cursors/README.md)
templates/   a new film: blank
.agents/     skills: the reference and procedures (also at .claude/skills); styles: named house styles
projects/    the films (ignored here; each holds its own history: history/)
```

The studio and the films are versioned separately: the studio improves without carrying any film's history, every
improvement reaches every film, and a film's repo holds everything it is made of (timeline, code, media, captures).
A film records which Ephemeris it was made with (`project.json`, and every render's sidecar).

## Licence

Ephemeris is source-available under the Functional Source License, version 1.1, with Apache 2.0 as its future licence
(FSL-1.1-ALv2, [`LICENSE.md`](LICENSE.md)). You may use it, change it and share it for anything except a commercial
product or service that competes with it, and each version becomes Apache-2.0 two years after it is released. The
films you make with it, and their renders, are yours.

Some parts are under their own licences, each with its licence beside it:

- `native/plughost/` and `native/vial/`: GPL-3.0. The plugin host loads Vial, which is GPL-3.0, into its own process;
  it is a separate program from the studio.
- `assets/cursors/`: GPL-3.0, from [ful1e5/apple_cursor](https://github.com/ful1e5/apple_cursor).
- `assets/fonts/`: the SIL Open Font License 1.1.
- `tools/models/`: Beat This! (MIT) and Basic Pitch (Apache-2.0). The models the studio downloads when first used list
  their licences in `tools/models/README.md`.
