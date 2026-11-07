# A page's pixels as GPU memory in a renderer of our own

Step 1 of evaluating a native renderer with the DOM as textures handed to it (see ../REPORT.md, which left this open). An
opt-in experiment: nothing in the studio imports it. A Rust program on wgpu 30 starts Electron's offscreen shared-texture
mode as its child, takes each paint's DMA-BUF (`pidfd_getfd`), imports it (`texture_from_dmabuf_fd`), reads a tag of 24 cells
at two corners of the page to tell which moment it shows, and draws it with a shader of its own.

```sh
cargo build --release
./run.sh <label> <renderer GPU name> <nvidia|radeon> <x11|wayland> "<host flags>" [w] [h]   # out/<label>/host.log: Chromium's log
```

## What it found (2026-11-02; Electron 44.5.1, RTX 5070 Ti in an eGPU + Radeon 890M, NVIDIA 615, Hyprland)

**No run produced pixels.** About 30 runs across ANGLE on Vulkan and on EGL, Graphite, X11 and Wayland, NVIDIA and AMD, and render
node overrides: each gave either a real but empty DMA-BUF (all bytes 0 by a CPU mapping and through Vulkan, on an opaque page
too) or a CPU paint. The page itself draws: plain `offscreen: true` paints it.

- What Chromium logs: `Should skip nVidia device named: nvidia-drm` (it will not allocate from it), and on X11 with ANGLE on
  Vulkan `Internal Vulkan error (-8) ... DmaBufImageSiblingVkLinux.cpp`, `Failed to create EGLImage: EGL_BAD_PARAMETER`,
  `Unable to initialize binding from pixmap`. Hiding the driver's name from Chromium's own check (an `LD_PRELOAD` shim)
  removes the first and the buffers stay empty, so that skip is not the only thing in the way. Wayland with ANGLE on Vulkan
  stays empty with none of those errors. Why is not known.
- The renderer's side holds up as far as it can be tested: wgpu picks its GPU by name and imports the buffers (0.6 ms each,
  then reused), on empty buffers only; so it is not shown that real pixels would arrive, nor where the memory lives. One
  run importing on the Radeon lost its device (`radv/amdgpu: Not enough memory for command submission`).
- Frame accuracy could not be tested here, nothing being drawn. ../REPORT.md's capture path was byte-identical over 288 frames.
- Size: Wayland clamps an offscreen window to a display's logical size (the panel's 2560×1600 at 1.67× is 1536×960); X11 gave what was asked. Headless Ozone gives no shared textures (1×1, CPU), neither of which touches the capture path the studio uses now.
