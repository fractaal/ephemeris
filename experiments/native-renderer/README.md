# Native-host rendering experiment

This is an opt-in benchmark, not a production renderer or a migration. Nothing in the studio imports it.

**Findings:** [REPORT.md](REPORT.md). [Numerical evidence](results/2026-10-24/) includes all 24 runs and exact frame-equivalence checks.

It runs the same `engine/render/` JavaScript and WGSL in pinned Chrome and in Node with Dawn (`webgpu` 0.6.2), on Vulkan. Film code, timeline overrides, shutter selection, cut boundaries, adaptive sample counts, pixel jitter and layer capture stay in the production browser runtime.

## What is compared

- `compare`: capture the actual arguments supplied to `Renderer.renderSub` and `finish`, then render the same inputs in Chrome and native Dawn. Static geometry, shaders and image inputs retain their identities. Both replays fix the submission band count at 8. Includes GPU completion and RGBA readback; excludes film evaluation and HTML preparation. Baseline → replay and replay → native pixel differences are recorded separately.
- `baseline`: production browser runtime, including film evaluation, HTML preparation, GPU rendering, RGBA readback and binary output to the controlling process. Sequential, changing frame times.
- `hybrid`: the same runtime prepares the film and HTML but a minimal capture-only renderer replaces its 3D renderer **in the isolated benchmark page only**. It sends scene values and changed HTML textures to native Dawn, which draws the frame. Includes a real CPU-copy handoff (GPU readback → binary WebSocket → child IPC → upload), plus native output readback/IPC. No Chrome 3D renderer is retained in this mode.

The CPU handoff is **not** a shared-GPU-texture implementation. It measures a working portable prototype, not the best possible native integration. A renderer-only win does not count as an end-to-end win. A CPU-copy loss does not establish that dmabuf/IOSurface/D3D sharing would lose. Video encoding, editor presentation, cross-platform shared-handle imports and hardware RT are not measured.

## Running

Requires the studio's installed dependencies, Linux/Vulkan, and an isolated install of `webgpu@0.6.2`. Do not add it to the application's dependencies:

```sh
npm install --prefix "$HOME/.cache/ephemeris-native-bench" --save-exact webgpu@0.6.2
```

Create a frozen workspace with `prepare.mjs` (destination must not exist):

```sh
node experiments/native-renderer/prepare.mjs \
  --workspace /path/to/films-workspace --out /path/to/frozen-workspace --ref <engine-commit>
```

It copies the engine from Git and the two films without `history/`, `renders/` or `.git/`, links installed dependencies, and writes a SHA-256 input manifest. The DOM film is *Harmonices Mundi* (`motion-design-test-claude-2`), at 18 s (four live HTML layers, including Tycho's animated table) and 34 s (three live layers, including an SVG chart). Its older shaders need a recorded compatibility adaptation in the copy: remove duplicate `PI`/`TAU` declarations supplied identically by the current renderer, and rename three reads of the old camera's `cam.k.x` (focal length) to `cam.focal`. No film math is changed. The original film is not edited. Doctor Who needs no adaptation.

Do not use the live workspace: a source edit during a measurement invalidates the comparison. `--record-existing yes` records a manually frozen workspace after verifying the engine against the stated Git commit.

```sh
node experiments/native-renderer/run.mjs \
  --root /path/to/frozen-workspace \
  --dawn "$HOME/.cache/ephemeris-native-bench/node_modules/webgpu" \
  --film doctor-who-intro-max --mode compare \
  --times 10,30,55 --scale 0.5 --samples 4 --warm 4 --frames 24 \
  --out /path/to/results
```

To reproduce the complete sequential matrix (two preview repetitions, full-resolution spot checks, and two extra full-resolution HTML repetitions), use a new output directory:

```sh
node experiments/native-renderer/matrix.mjs /path/to/frozen-workspace \
  "$HOME/.cache/ephemeris-native-bench/node_modules/webgpu" /path/to/new-results
node experiments/native-renderer/summarize.mjs /path/to/new-results
```

Use `--mode probe` to check boot and layer inventory first. `baseline` and `hybrid` advance each selected time by one timeline frame per measurement. Startup is recorded separately from warm timing. Results include raw samples, profiles, process-tree CPU counters/PSS, and raw RGBA comparison frames. The native dependency/compiler and Chrome need not use identical Dawn revisions; record that limitation.

The harness uses the `browser-cdp` skill's small CDP client (default `~/.agents/skills/browser-cdp/scripts/cdp.mjs`; override with `--cdp`). It starts its own loopback server and sandboxed temporary-profile Chrome, and closes both plus its native child in `finally`. It does not connect to or restart the director's app. The headless film target must be visible to its own compositor for HTML-in-Canvas paint events; it has no desktop window.

**Measurement controls:** CDP Network is deliberately not enabled: it mirrors every binary pixel WebSocket through the debugger, adding large, image-entropy-dependent overhead. Those early exploratory timings must not be used. Vulkan implicit gaming layers are disabled only for benchmark children. After warm-up, only the benchmark's own process/thread trees are normalized to SCHED_OTHER/nice 16 (the inherited priority, which can be matched without root). This avoids the host's policy that otherwise demotes Node to SCHED_IDLE while boosting Chrome. Each result includes the observed policies/nice values; this is a matched-priority comparison, not a prediction of unchanged host policy.

`baseline`/`hybrid` record every output's SHA-256 and actual sub-frame count. `summarize.mjs <measurement-directory>` combines repeats and compares the independently rendered sequences, plus the raw first frames. PSS is the whole benchmark process tree (including the common control/server process), not summed RSS. CPU time is approximate process-tree `/proc` ticks. Measurements do not include video encoding, disk output, or editor presentation.
