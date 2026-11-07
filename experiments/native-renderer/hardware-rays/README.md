# Hardware ray tracing against the renderer's own walk

Step 2 of evaluating a native renderer (see ../REPORT.md, ../dom-textures/). An opt-in experiment: nothing in the studio imports it.

- `dump.mjs <film page> <t> <dir>`: a film's scene as a real frame drew it (the renderer's tables, geometry, camera and the WGSL its shaders start with).
- `hardware-rays --data <dir> --gpu <name>`: the same rays through `traceScene` and through wgpu's ray queries (camera, GI bounce, sun shadow), hit against hit; then the renderer's real GI ray, `traceLight` with its shading, with only `traceScene` and `rayBlocked` told apart. Solids are their mesh's triangles to the hardware; a film's pictures are white in both.
- `share.mjs <film page> <t> <samples> [rendering]`: the real renderer, its walks done two and three times: what a frame gains is what walking costs.

## What it found (2026-11-03; RTX 5070 Ti in an eGPU, Radeon 890M; wgpu 30, its ray query experimental; 1080p)

The renderer's WGSL went through wgpu's compiler (naga) unchanged, and the real GI ray gave the same light. On spring-brutalist's pool the software version took 84.8 ms against the studio's own 90 ms a sub-frame, so the harness is faithful.

| The real shaded GI ray, per sample | Our walk | Hardware | | Rays within 2% |
|---|---:|---:|---|---:|
| spring-brutalist, 20 s: 24,946 copies, 36.6 M triangles, 1 light | 82–85 ms | 7.7–8.0 ms | 10.6–11× faster | 99.83% |
| gi-test, 4.4 s: 327 copies, 1 light | 7.7–8.3 ms | 6.2–6.6 ms | 1.2–1.3× faster | 99.93% |
| doctor-who, 10 s: 8 copies, 14 lights | 1.0–1.1 ms | 1.0 ms | 1.0–1.1× faster | 100.00% |
| doctor-who, 30 s: 44 copies, 13 lights | 1.8–1.9 ms | 1.4–1.5 ms | 1.3× faster | 99.88% |
| spring-brutalist, Radeon 890M | 536–540 ms | 538–543 ms | no change | 99.83% |

Walking alone, without shading: spring-brutalist 15–21× (camera, GI), 3.8× (sun shadows); the others 1.3–7×. The TLAS over 24,946 copies builds in 2.6–5.1 ms on the RTX. Each row is three runs of the same program. A first run had doctor-who at 30 s at 4.6 and 26.8 ms, hardware 5.8× slower; it has not come back in nine runs since, with its 13 lights or fewer (`--lights n`), and what caused it is not known. GI is off in that film at that moment, so these rows are the real shader forced on a frame that does not use it. Why the Radeon gains nothing when its walk alone is 8× faster is not known.

What a real frame spends (4 samples asked), from `share.mjs`:

| | Frame | GI rays | Shadows pass | Opaque | Other |
|---|---:|---:|---:|---:|---|
| spring-brutalist, 20 s | 782 ms | 360 | 55 | 200 | film code 66, scene data 81 |
| gi-test, 4.4 s, 2 bounces | 122 ms | 32 | 3 | 38 | |
| doctor-who, 30 s | 597 ms | none | 15 | 70 | **time vortex pass 457**, a raymarched film pass no tracer touches |

Walks done twice and three times scale nearly linearly in compute (spring-brutalist's GI rays 360 → 670 → 934 ms, shadows 55 → 107 → 160) but not in the opaque pass (200 → 489 → 1139 for shadow rays), so the opaque pass's share is not known and it was not ported. The pool frame's estimate is about 400–440 ms against 782: GI rays as measured, the shadow pass by the walking ratio, the rest unchanged. The first compile did not shrink: the real GI pipeline 2.6 s with our walk, 3.7 s with hardware.
