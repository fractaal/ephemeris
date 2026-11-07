# Hardware ray tracing inside the browser's own WebGPU

An opt-in experiment, and the other side of ../REPORT.md's question: the rays go into Dawn, Chromium's WebGPU, rather than
the renderer leaving Chromium, so HTML layers are still captured straight onto the device the renderer uses and nothing
has to cross between processes. The engine's side is `engine/render/rays.js`; without the device's
`acceleration-structure` feature none of it runs, so stock Electron draws what it always did.

It runs in a custom build of the Electron the studio pins (44.5.1, Chromium 152), Vulkan only. A local build lives at
`~/CodeProjects/electron/src/out/Release`. To run a film on it from the checkout:

    ELECTRON_OVERRIDE_DIST_PATH=~/CodeProjects/electron/src/out/Release ./ephemeris nle <film> --port 5350

## Building it

`electron/` holds what the build needs, on top of Electron v44.5.1:

- `gclient.txt`: the `.gclient`, which fetches Chromium's own repository from GitHub's mirror, as googlesource sits silent on it.
- `dawn.patch.gz`: the WGSL extension `chromium_experimental_ray_query`, acceleration structures in Dawn's API, wire,
  Vulkan backend and Node binding, and the toggle `async_shader_module_parse` (below). `git am` it in `src/third_party/dawn`.
- `chromium.patch`: Blink's WebGPU bindings, the feature on the decoder's list, `--gpu-shared-shader-cache`, the
  toggle turned on for pages' devices, and `--gpu-low-priority-site`: the renderers of the sites given (the app gives
  the films' `http://localhost`) run all their GPU contexts at the GPU scheduler's low priority, so that the editor's
  window gets its turn on the GPU process's main thread between a heavy film frame's tasks. It has no measured effect:
  scrolled and dragged while spring-brutalist plays every frame over frames the cache lacks, the window holds 60 fps
  with it and without it. And the zero-copy frames (../zero-copy): `GPUDevice.importSharedTexture`, a writable WebGPU
  texture of a shared image, and, behind the feature `EphemerisWebGPUNativePixmap`, WebGPU on imported DMA-BUFs on
  desktop Linux. `git am` it in `src`. (A low global priority for the film's Vulkan queue as well,
  VK_KHR_global_priority through a Dawn toggle, was tried and measured no different: the GPU already shares itself with
  the compositor between dispatches; not kept.)
- `electron.patch`: `--shared-texture-webgpu`, sharedTexture's imports for WebGPU alone on Linux (the viewport's
  render process writes its frames into them, app/viewport.cjs). `git am` it in `src/electron`.
- `args.gn`: Electron's settings without link-time optimisation or profile data, in `src/out/Release/args.gn`.

Steps, with depot_tools' `python-bin` first on `PATH` (the system's Python can clash with the protobuf in the tree):
`gclient sync --no-history --shallow --with_tags --nohooks`, `gclient runhooks`, `git -C electron pack-refs --all`, the three
patches, `gn gen out/Release` with `CHROMIUM_BUILDTOOLS_PATH` set, then `third_party/ninja/ninja -C out/Release electron`.
The source takes 30 GB and the first build 2 h 45 min on a Ryzen AI 9 HX 370 at 20 jobs; a change to one file rebuilds it and
links again (about 3 min). `-j 24` froze the machine: Blink's generators each start a Python per thread, about 120 at 0.6 GB.
An official build would rebuild everything; it has not been tried.

For the app: `third_party/ninja/ninja -C out/Release electron:electron_dist_zip`, unzip `dist.zip` to a folder, strip `electron`,
then `EPHEMERIS_ELECTRON_DIST=<that folder> npm run dist`. `override_electron_version` in `args.gn` gives it Electron's version.

The same Dawn commits on Dawn's main are the branch `ephemeris-ray-query` of `~/CodeProjects/dawn`, built as `dawn.node`.

## The checks here

- `real.mjs <port> <film> <t> <hw|walk> [frames] [out]`: a frame in a real browser, the film as the studio opens it (its
  timeline's settings in the address, its own samples, shutter and rate). `TREE` names the studio copy, `MOVE=1` steps each
  frame on a frame's time, `SUBS` sets the samples. walk: the same browser without the feature asked for.
- `triangle.mjs <dawn.node>`, `solids.mjs <dawn.node>`: rays through a known scene, each answer worked out by hand.
- `capture.mjs <port> <film> <t> <file>`: a real frame's `renderSub` and `finish` inputs, nothing drawn.
- `replay.mjs <file> [frames] [out]`: that frame on one Dawn build, by the walk and by the hardware, drawn in turn.
  `native-patch.py` applies what `../native.mjs` needs for it.

## What it found (2026-11-03; RTX 5070 Ti in an eGPU, NVIDIA 615; 1080p; the engine at b9053e2; two rounds, turn about)

Each film with its own settings and viewer samples, the same moment drawn 13 times, the median of the last 12:

| | Samples | Stock, walk | Ours, walk | Ours, hardware | GPU busy, ours: walk → hardware | Pixels of 2,073,600 that differ, walk to hardware, most levels |
|---|---:|---:|---:|---:|---:|---|
| spring-brutalist, 20 s, the pool | 64 | 2,563 ms | 2,625 ms | 916 ms | 2,474 → 733 ms | 5,729, 6 (5,702 by 1) |
| spring-brutalist, 9 s, the facade | 64 | 890 ms | 913 ms | 540 ms | 786 → 344 ms | 6,046, 5 (6,028 by 1) |
| gi-test, 4.4 s | 64 | 1,667 ms | 1,622 ms | 1,152 ms | 1,579 → 1,117 ms | 214, 3 (212 by 1) |
| doctor-who-intro-max, 30 s | 4 | 479 ms | 501 ms | 430 ms | 431 → 374 ms | 1,240, 6 (1,221 by 1) |
| horror-test, 4 s | 4 | 73 ms | 76 ms | 47 ms | 62 → 34 ms | 333, 4 (326 by 1) |
| layers-glass-new, 2 s | 4 | 19.8 ms | 20.6 ms | 22.4 ms | 14.1 → 14.5 ms | 34, 24 |

At 16 samples, one round: the pool 720, 711, 282 ms; the facade 277, 274, 156 ms; gi-test 429, 480, 320 ms.

Stock and our build by the walk are byte-identical on all of these, so the patches change nothing unless rays are used,
and leaving out official builds' optimisation shows no cost within this noise on films the GPU limits. Where HTML layers
change every frame the CPU shows it: a launch film's capture takes about 7 to 9 ms on stock and about 10 ms on ours, by the walk
or the hardware alike, the whole frame 20 to 26 ms on any of them, and all three byte-identical there and on a reel.

Scene data costs more with hardware at many samples (the facade at 64, about 150 to 320 ms): the walk's virtual sub-frames
share one tree, while `HardwareScene` builds its top structure for each sub-frame. Against a walk with nothing culled,
layers-glass-new's hardware frame has no pixel different and the walk's own 25: the walk misses a few nearest hits there.
Debug assertions and the Khronos validation layer (1.3.284, Steam's) find nothing on `dawn.node` but that layer not knowing a newer struct.

### Shared shaders

`--gpu-shared-shader-cache=<folder>` keeps Dawn's compiled shaders and pipelines in a folder, one file an entry, instead of
each profile's disk cache. A new browser's first frame, the driver's own cache removed, in seconds (gi-test,
spring-brutalist's facade, doctor-who at 30 s, hardware rays, 4 samples):

| | gi-test | Facade | doctor-who |
|---|---:|---:|---:|
| No folder, first browser | 24.0 | 12.6 | 13.1 |
| No folder, next browser, same profile | 21.7 | 12.5 | 16.5 |
| Folder, first browser | 19.8 | 12.5 | 16.0 |
| Folder, next browser, same profile | 0.76 | 0.67 | 1.12 |
| Folder, a new profile | 0.79 | 0.66 | 1.37 |
| Folder, a new profile, the film from another port | 0.75 | 0.60 | 1.34 |

The three films hold 206 files, 6.5 MB, which nothing prunes. Two browsers started 8 s apart on a new folder gain nothing (26.0 and
20.3 s): an entry appears only once it has compiled. The studio's GPU process runs without a seccomp filter here, so the
sandbox has not needed a rule for the folder; with that sandbox on, it would.

The folder also keeps what Dawn learns parsing a shader module, so a page that makes the same WGSL again skips the parse:
210 KB of WGSL takes 2 to 3 ms in a reloaded page with the folder, and 92 to 170 ms every time without it. Without the folder a
reloaded page misses the profile's own cache although its renderer process is the same; a second device in the same page
hits it. The studio's render browsers and the app's window pass the folder (`FILM_SWITCHES` in `tools/browser.mjs`), so a film
reloaded in the editor's frame finds its WGSL parsed there.

### WGSL parsed off the GPU's main thread (2026-11-06)

Every page's WebGPU in a browser runs on its GPU process's main thread, which also composites the browser's windows. Dawn
parsed a shader module there inside `createShaderModule` (Tint's parse, resolve and validation, and the reflection pipelines
need), so one page's shaders froze the others' frames. The Dawn toggle `async_shader_module_parse` parses on Dawn's worker
pool, as its asynchronous pipelines compile, and Chromium's WebGPU decoder turns it on for the devices pages create.
`--disable-dawn-features=async_shader_module_parse` turns it off. Skia's own device never has it: it waits for its pipelines
with `WaitAny`, which does not run the queue a deferred pipeline waits in.

- `createShaderModule` returns at once. `getCompilationInfo`, error scopes and the uncaptured error event get a module's
  errors when the parse ends, each error in the scope that was current at the call, its message as before.
- `createComputePipelineAsync` and `createRenderPipelineAsync` asked for while a module of theirs is still parsing keep a copy
  of their descriptor, and the GPU's main thread validates and makes the pipeline once the module is parsed (validation and
  default layouts touch the device, which pages' devices do not lock), then a worker compiles it as before.
- A synchronous pipeline made right after its module parses the module itself if no worker has begun, and waits for the one
  that has, so it takes as long as before. Synchronous pipelines still compile on the main thread.

Measured with a page timing its own `queue.onSubmittedWorkDone()` round trips while a cross-site iframe (its own process,
the same GPU process) compiles; the page waits 4 ms between round trips, so a longest gap of about 6 ms is no wait at
all. One 210 KB compute shader, or eight where a row says so, RTX 5070 Ti, the toggle off and on in the same build, runs
taken in turn, the studio running alongside:

| What the iframe does | Off: the page's longest gap | On |
|---|---:|---:|
| `createShaderModule`, then `getCompilationInfo` (the parse: 90 to 170 ms) | the whole parse | 4.2 to 5.9 ms |
| `createShaderModule`, then `createComputePipelineAsync` (2.4 to 4.0 s, either way) | 127 to 182 ms | 4.5 to 7.9 ms |
| Eight of them at once (5.5 to 6.2 s) | 779 to 983 ms | 18 to 22 ms |
| Eight `createShaderModule` at once, then `getCompilationInfo` | 702 to 1,006 ms | 14 to 82 ms |
| `createComputePipeline`, synchronous | the whole compile | the whole compile |

On, the eight modules parse side by side: all eight are parsed 200 to 330 ms after the first call, where the main thread took
700 to 1,000 ms one after another. What the main thread still does for a module is Dawn copying the WGSL and hashing it twice
with SHA3, about 2.0 ms for 210 KB (in a trace). Letting go of eight parsed modules takes it 31 to 58 ms, the same off or
on: Dawn then frees what it kept of each parse, its Tint program. Making a page's device takes it about 90 ms.

Byte for byte as the build before it: messages from `getCompilationInfo`, the error scope and the uncaptured error event
for a syntax error and a type error; asynchronous and synchronous pipelines from an invalid module, a wrong entry point
and a wrong constant. The same off and on: 120 modules, a quarter invalid, each with an asynchronous or synchronous
compute or render pipeline, all asked for at once; a device destroyed while its module parses and a pipeline waits; a
render pipeline with two vertex buffers, three targets, depth, stencil and constants, asked for while its modules parse,
drawing the pixels a synchronous one draws; rays fired at the hand-checked triangle. The toggle is among the device's toggles Dawn keys its caches by, so this build
compiles everything once more on first use, in each profile and in the shared folder.

## Not known

The Radeon 890M and the Mac (they have no such feature and stay on the walk); an official build's cost and what it gives; BLAS
compaction's memory saving; VRAM use; a real film's WGSL parsed on the workers, which waits for the engine asking for its
pipelines asynchronously (a synchronous pipeline waits for its module's parse). Keep a reference to `gpu` when using
`dawn.node`: its AsyncRunner holds a raw pointer to the instance `gpu` owns, so a collected `gpu` means calls into freed memory.
