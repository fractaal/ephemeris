# Chromium versus native WebGPU: Ephemeris experiment

**Where this stands (2026-11-03):** the director decided to stay in Chromium for now. Two later experiments took up what this report left open: [hardware-rays/](hardware-rays/README.md) (a big win on dense scenes such as spring-brutalist's pool, about neutral elsewhere) and [dom-textures/](dom-textures/README.md) (Electron's shared textures gave no pixels on NVIDIA hybrid Linux, so DOM layers would be copied). In the director's words, it is a question of "do you want DOM films to be worse (basically the point of eph in the first place) or the occasional wide complex scene that should arguably be rendered in blender instead of here be faster". To look again: zero-copy working (rerun `dom-textures/` at Electron upgrades), WebGPU gaining ray tracing, or dense scenes becoming the usual work. [dawn-rays/](dawn-rays/README.md) takes up the second itself: ray tracing added to Dawn, Chromium's WebGPU, so that nothing has to leave the browser.

**Verdict: keep the current Chromium-hosted renderer for now. These measurements do not establish a compelling speed or total-memory reason to migrate.** The renderer itself ports successfully, without rewriting its WGSL; the measured native drawing gains are small in absolute time, and the complete browser-plus-native prototype is usually slower and larger.

This is **not** a verdict against a fully browser-free film host or zero-copy GPU sharing. Neither was built here. The result distinguishes the proven portability from the unproven architectural payoff.

## Question and scope

Does hosting Ephemeris's renderer outside Chromium improve speed or resource use at the same visual quality, for HTML-heavy work and the Doctor Who 3D stress test? This is an experiment, not an application migration.

The prototype runs the existing renderer's JavaScript and WGSL on native Dawn. There are no changes to the renderer's lighting, geometry, tracing, sampling or denoising. No production film or application code is changed.

## What actually runs

1. **Current browser path:** the original film runtime evaluates the film, updates/paints/captures its HTML, renders on WebGPU, reads back RGBA, and sends the frame to the controlling process.
2. **Renderer-only comparison:** the original runtime's exact `renderSub`/`finish` inputs are captured. The same inputs, geometry, images, shaders, sample times and jitter are replayed in Chromium and native Dawn. Both finish the GPU work and read back RGBA. The submission-band count is fixed at 8 on both sides. This excludes film evaluation, browser HTML preparation and input transport.
3. **Working hybrid:** the original runtime still evaluates the film and prepares HTML in Chromium. A capture-only adapter replaces its renderer in this isolated page: no 3D frame graph or 3D pipelines remain in that browser. Scene data and changed HTML captures go to native Dawn, which uses the unchanged renderer. The measured handoff is a **CPU copy**, not shared GPU memory: layer GPU readback → binary WebSocket → child-process IPC → GPU upload/mip generation. Native output readback and delivery are included.

The Doctor Who film has no DOM layers at the tested moments. The hybrid nevertheless keeps its **film evaluation and initial asset decoding** in Chromium. A fully browser-free host for that entire film is **not implemented or timed**. Renderer-only memory must not be mistaken for the footprint of a complete film host.

## Workloads and controls

- Engine: `49ffc6e041e9295d7d9500731409996cc00928d8`, frozen with `git archive` and verified against Git's file hashes.
- HTML case: *Harmonices Mundi* (`motion-design-test-claude-2`), 18 s (four live layers: animated headings, year and Tycho's table) and 34 s (three live layers, including the animated SVG chart). The film also has lightweight procedural graphics: this is not a synthetic blank scene.
- Its older film shaders needed a **scratch-only compatibility adaptation**: remove duplicate `PI`/`TAU` declarations (same values already supplied by the renderer); change three old camera-field reads, `cam.k.x`, to their renamed equivalent, `cam.focal`. The old compositor explicitly documented `k.x` as focal length. No drawing math was changed. The director's original film is untouched.
- 3D case: `doctor-who-intro-max`, 10, 30 and 55 s, with its actual textures, materials, glass, traced shadows and film shaders. No film adaptation.
- GPU: RTX 5070 Ti, NVIDIA 615.71.09, Vulkan, on Ben's Ryzen AI 9 HX 370 Linux machine. Node 24.15.0; pinned Chromium 153.0.8010.47; native `webgpu` 0.6.2. Both devices request matching limits and timestamp support. These are different packaged Dawn builds: this does not isolate every compiler-version difference from browser-host overhead.
- Preview: 960 × 540, nominal four samples, **two independent runs**, each with six warm-up frames and 24 measured frames per starting moment. Actual adaptive sub-frame counts are preserved, not forced to four: at the fixed Doctor Who moments they are 4, 42 and 15.
- Full-resolution spot checks: 1920 × 1080, nominal four samples, 12 measured frames starting at HTML 18 s and Doctor Who 30 s. The initial HTML result was near break-even, so it was repeated twice more in opposing orders (three runs total); Doctor Who has one full-resolution run. These are **not 64-sample masters**.
- Renderer-only tests alternate which host goes first. End-to-end runs reverse baseline/hybrid order in the second repetition. Only one benchmark case renders at a time.
- Own process/thread trees are normalized after warm-up to SCHED_OTHER/nice 16, avoiding the machine's otherwise unequal treatment of Node (SCHED_IDLE) and Chrome (boosted). Actual process policies are recorded. Some small Chrome child processes appeared or changed priority afterward; their combined recorded CPU use was at most 60 ms in a measurement block. This is a residual source of noise, especially for CPU figures and tiny timing differences. No machine-wide policy or other application is changed.
- CDP's Network domain is disabled. During prototyping it was found to mirror binary output frames through the debugger, severely inflating apparent browser delivery cost. **Those exploratory results are excluded.** The final matrix uses a lean Runtime/Page-only CDP connection.
- The desktop and other applications remain running. Small single-digit percentage differences are not evidence of a reliable architectural speedup on an otherwise idle machine.

Renderer-only rows repeat a **fixed frame**. End-to-end rows render a **changing sequence** beginning there, with changing adaptive sample counts. Their absolute timings are therefore not additive. End-to-end throughput includes common output hashing; frame latency excludes that validation hash. Both return the same raw RGBA format, without JPEG or video encoding.

## Results

### Visual equivalence

**24 completed runs, one harness version; all 288 measured hybrid frames matched independently rendered browser frames byte-for-byte.** Adaptive sample counts also matched on every compared frame. All 28 direct image comparisons (original browser → replay, replay → native) had zero differing pixels. Rendered HTML/table/chart and Doctor Who stills were also inspected visually. No speed result is obtained by reducing quality.

### Renderer only — median milliseconds per fixed frame

Lower is better. Includes completed GPU work and RGBA readback, but not film evaluation, HTML preparation or transport into the renderer.

| Film / moment | Size | Chromium | Native Dawn | Interpretation |
|---|---:|---:|---:|---|
| HTML table, 18 s | 960×540 | 5.60 | 4.36 | Saves 1.24 ms |
| HTML chart, 34 s | 960×540 | 6.30 | 3.66 | Saves 2.64 ms |
| Doctor Who, 10 s | 960×540 | 36.50 | 35.37 | ~3% shorter; small |
| Doctor Who, 30 s | 960×540 | 301.40 | 298.09 | ~1% shorter |
| Doctor Who, 55 s | 960×540 | 138.90 | 137.95 | <1% shorter |
| HTML table, 18 s | 1920×1080 | 7.30 | 7.49 | Effectively tied across repeats |
| Doctor Who, 30 s | 1920×1080 | 712.70 | 715.52 | Effectively tied |

The “native helps 3D most” hypothesis is **not supported here**. The heavy 3D frame does substantially the same GPU work on both hosts. The larger *percentage* gains occur in the cheap HTML scenes' drawing stage, but save only a few milliseconds. They are not savings in HTML layout or painting.

### Complete frame-production path — frames/second

Higher is better. Each row renders a sequence beginning at the stated time, through delivered raw RGBA. Combined throughput is total frames / total measured time, not the average of rates.

| Film / sequence start | Size | Current Chromium | Browser + native, CPU handoff |
|---|---:|---:|---:|
| HTML table, 18 s | 960×540 | **44.02** | 22.16 |
| HTML chart, 34 s | 960×540 | **43.62** | 21.92 |
| Doctor Who, 10 s | 960×540 | 30.25 | 28.63 |
| Doctor Who, 30 s | 960×540 | **6.54** | 5.15 |
| Doctor Who, 55 s | 960×540 | **8.98** | 7.29 |
| HTML table, 18 s | 1920×1080 | 22.37 | 21.38 |
| Doctor Who, 30 s | 1920×1080 | 1.49 | 1.39 |

The two independent preview runs consistently put the HTML hybrid at about half the baseline throughput. At 1080p, HTML is **near break-even**, not a clear native win: browser runs were 21.91–23.31 fps; hybrid runs were 20.19–23.35 fps. The initially favorable hybrid run did not repeat reliably. Doctor Who's 1080p result is only a spot check; do not overinterpret its ~7% difference.

**Where the prototype pays:** the HTML table/chart transfer 1.63/1.96 MB of changing layer texels per frame. Layer readback alone has a median cost of about 11–12 ms, before additional packing, IPC, upload and scheduling. The renderer-only saving is 1–3 ms. The original path captures directly into GPU textures without this readback.

**Another important prototype cost:** the hybrid batches a frame's scene data before native drawing starts. The original runtime can overlap later film evaluation with GPU work already submitted for earlier sub-frames. The batch boundary loses that overlap; JSON serialization/decoding and IPC add work too. This helps explain Doctor Who's end-to-end regression even though it transfers **no HTML textures** during these sequences. Streaming sub-frames or evaluating the film natively could recover some of that loss; neither was measured. These regressions are not all inherent costs of native rendering.

### System memory and CPU

Representative **complete-path PSS**, in MiB:

| Preview workload | Chromium runs | Complete hybrid runs |
|---|---:|---:|
| HTML table | 791–808 | 926–997 |
| HTML chart | 812–877 | 1008–1067 |
| Doctor Who, 30 s | 1461–1549 | 2054–2075 |

The complete prototype is larger, not smaller. It keeps a browser film host and adds a native process, transferred data and duplicated assets. Approximate aggregate CPU time per frame also rose: HTML table **44 → 81 ms**, HTML chart **47 → 63 ms**, Doctor Who at 30 s **224 → 362 ms** (means of the two preview runs).

There **is** a smaller native renderer component: at preview size the native replay process used approximately **151–155 MiB** for the HTML cases and **560–797 MiB** for Doctor Who, versus approximately **679–728 MiB** and **1349–1692 MiB** for their browser workers. But the native replay process is **not doing the film evaluation/HTML work**. These side-by-side component snapshots are not an estimate of a complete browser-free studio's footprint. Removing the browser film host might make memory a reason to go native; this experiment does not establish the total saving.

### Decision

- **For current HTML/CSS motion-design work:** retain the integrated browser path. Moving only the renderer has no demonstrated whole-path payoff here.
- **For the Doctor Who stress test:** changing hosts is not a meaningful GPU-speed fix. Shader/scene costs dominate; the same renderer on native WebGPU remains essentially the same speed.
- **For future architecture:** native is technically credible, not blocked by WGSL. Revisit it for a concrete need—browser-free non-DOM jobs, a proven shared-texture path, or native-only GPU capabilities—not on an assumption that dropping Chrome makes these frames substantially faster.

The focused next experiment, *if such a need arises*, is the missing part of the proposed architecture (shared GPU handles or genuinely browser-free film evaluation), not another isolated shader replay. No migration is started or recommended by this benchmark.

## Resource interpretation

System memory is process-tree **PSS**, not summed RSS. End-to-end totals include the common control/server process and all required browser/native children. Renderer-only figures compare the native replay process against the browser process tree; they omit the browser work required to produce native inputs. CPU time is approximate aggregate `/proc` CPU ticks per completed frame. These are steady-state snapshots, **not peak startup memory**, and GPU VRAM is not separately measured.

## What this does not establish

- The performance of a zero-copy dmabuf/IOSurface/D3D shared-texture integration. Ordinary browser WebGPU does not export those handles, and this Node binding is not an Electron/CEF shared-texture integration. A CPU-copy loss is not proof that GPU sharing would lose.
- Fully native film evaluation/asset loading, including running browser-independent films without any Chromium process.
- Multiworker scaling, pooled HTML services, cross-frame pipelining, or shared assets across native workers.
- Full master-render/video-encoding throughput, GPU video encoding, or editor presentation latency.
- Windows/Metal, the 890M or MacBook. Results are specific to this machine/backend and these scenes.
- Hardware RT, DLSS, or a redesigned shader/renderer. Keeping the same WGSL keeps substantially the same GPU work.
- Total cold-start latency. Page boot is recorded, but native initialization, compilation and bootstrap asset transport are excluded from warm frame comparisons. They are not free: the Doctor Who bootstrap transfers roughly 192 MB of decoded texture texels once.

## Reproduction and artifacts

See `README.md`, `prepare.mjs`, `matrix.mjs` and `summarize.mjs`. Frozen inputs, exact input hashes, native dependency install, exploratory logs and raw frames remain locally under `~/.cache/ephemeris-native-bench/`. Final measurements are under `final/`; exploratory `smoke-*`, `clean-*` and `measure/` runs are not the final dataset.

The retained numerical evidence is in [`results/2026-10-24/`](results/2026-10-24/): all 24 run JSON files, `summary.json`, `matrix.json` (including the full-resolution HTML follow-up), `inputs.json` (222 hashed frozen inputs), the native dependency lock and binary/CDP-client hashes. It records raw per-frame timings, output SHA-256 hashes, adaptive sample counts, paired pixel-difference measures, pass profiles, process trees and harness source hashes. Images and film assets stay local, not in Git. The benchmark's three codec tests check preserved scene values/static identity, exact binary image bytes and explicit rejection of untransferable drawing functions; no existing test file was modified. Final `node --test`: **44 passing, 0 failing** (log: `~/.cache/ephemeris-native-bench/node-test.log`). The scratch workspace has no saved production reference snapshots, so `./ephemeris compare --all` there supplied no additional regression coverage; the paired renders and whole-sequence hashes are the visual evidence. All task-owned Chrome/native/server processes were closed and checked absent.
