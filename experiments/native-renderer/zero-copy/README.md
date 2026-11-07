# A frame handed between processes as GPU memory

An opt-in experiment: nothing in the studio imports it. It tests the seam a render process of its own needs: a finished
frame reaching the editor's page as GPU memory, with no copy through the CPU.

- `producer/` (Rust, `ash`): a ring of three images on the NVIDIA card, made by Vulkan with memory that exports as a
  DMA-BUF in the driver's own tiled layout (an explicit DRM format modifier), drawn each frame (a background that changes
  with the frame, a moving white bar, a corner block whose red is the frame number) and announced on stdout once the GPU
  has finished it.
- `pidfd.c`: a Node-API addon, `getfd(pid, fd)`, a copy of a child process's file descriptor (`pidfd_getfd`).
- `app/`: our Electron imports the three buffers (`sharedTexture.importSharedTexture`, a `nativePixmap` handle) and hands
  each finished frame to a page (`sendSharedTexture`), which gets a `VideoFrame`, draws it on a 2D canvas and checks its
  pixels.

```sh
(cd producer && cargo build --release --offline)
gcc -shared -fPIC -O2 -I<node include dir> pidfd.c -o pidfd.node
FRAMES=300 ./run.sh <tag>        # out/<tag>.json: each frame drawn, with the pixels checked every 20th
```

## What it found (2026-11-07; our Electron 44.5.1, RTX 5070 Ti in an eGPU, NVIDIA 615, Hyprland, Wayland)

- **The import works with no patch.** NVIDIA offers six tiled modifiers for BGRA that it can draw into
  (`0x0300000000606010` to `…15`); linear it cannot draw into. Chromium imported the tiled buffers, and the page drew them:
  the corner's red was the frame number on every frame checked, the bar white where it was drawn, the background as drawn.
- **0.5 ms** from the producer's GPU finishing a frame to the page having drawn it (0.9 at the 95th percentile), the
  draw itself 0.2 to 0.4 ms: a 6 MB frame, so nothing crossed the CPU. 295 of 300 frames drawn at 60 a second.
- Nothing orders the producer's next write against the page's read (NVIDIA has no implicit sync on DMA-BUFs): a frame
  drawn late can show a later frame's contents (the first one did, 100 ms late). A real ring needs the reader to say when
  it is done with a buffer.
- What failed before (`../dom-textures`) was Chromium *making* such buffers on NVIDIA (its GBM allocator skips the
  `nvidia-drm` device; with the check hidden the buffers stayed empty), not taking them.
- On Linux, Electron imports with GL, raster and display uses only (`electron_api_shared_texture.cc`); on Windows and
  macOS it adds WebGPU read and write. A page writing a frame into such a buffer with WebGPU needs those uses on Linux
  and a way to get a writable `GPUTexture` from the import, which no WebGPU API gives.

## Two apps, two GPU processes: a render worker writing, the editor showing

`two/`: the editor app starts the producer in its `alloc` mode (it makes and exports the ring, draws nothing, and lets any
process of ours take the descriptors) and a worker app: another Electron, its own browser and GPU process, an offscreen
window, as the studio's render workers are. The worker's page draws each frame with WebGPU straight into a buffer
(`device.importSharedTexture`, below), waits for its GPU, and says so on stdout; the editor's page draws that buffer and
checks it, while something on it moves every display frame and its window is traced. Every 30 frames the worker queues a
long compute job (`HEAVY` iterations, `SPLIT` dispatches) behind the next frame, as a heavy frame of a film would be.

```sh
APPJS=two/editor.cjs FRAMES=300 HEAVY=31250 SPLIT=64 ./run.sh <tag> && python3 twostat.py <tag>
```

`patches/`: what our Electron needs for the worker's half (on top of `../dawn-rays/electron`), each behind a switch:

- Blink: `GPUDevice.importSharedTexture(videoFrame, usage)`, a writable `GPUTexture` of the GPU texture behind a
  `VideoFrame` (`WebGPUMailboxTexture::FromVideoFrame` now honours the usage it is given).
- Chromium: desktop Linux keeps WebGPU off Ozone images for want of sync fences between WebGPU and GL on one image; the
  feature `EphemerisWebGPUNativePixmap` allows it and asks Dawn for `SharedTextureMemoryDmaBuf` and
  `SharedFenceSyncFD` on its WebGPU devices.
- Electron: `--shared-texture-webgpu` imports with WebGPU use alone (so no GL use needs fences with it). The editor keeps
  the default (display) imports.

The worker runs with `--ozone-platform=wayland` (headless Ozone cannot take a buffer handle),
`--enable-features=EphemerisWebGPUNativePixmap` and `--shared-texture-webgpu`.

**Found (2026-11-07):** every frame written by the worker reached the editor's page right (15 of 15 checks per run), 1 to
2 ms from the worker's GPU finishing it to the editor's page having drawn it. With the worker's GPU busy 355 to 388 ms
at a time (ten times, the work in 64 dispatches), the editor's window held 60.0 frames a second, no gap over 17 ms. The
same work as one dispatch whose threads each run for about 170 ms (a worst case: the driver switches only between
threads) cost the editor three late frames, the longest 119 ms, at 57 frames a second. In one browser, a film page's
heavy frame held the editor's window for the whole frame (0.47 s in a test, 1.1 to 1.4 s in the director's session).
