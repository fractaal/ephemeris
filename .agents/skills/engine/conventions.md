# Engine conventions

These exist because each one was a visible defect at some point.

**World and camera**
- World axes match CSS: x right, y down, z toward the viewer, in px. At zoom 1 with no rotation the plane z = 0
  renders 1:1, so a DOM layout drops straight into the world.
- Place content once; move the camera. Do not animate a plane to fake a camera move.
- Frame with `frame(rect, { at, width })` instead of hand-tuned numbers.
- Each scene can have its own `rig()`: a base pose, a `drift` if it should move the whole time, and moves layered on
  top (`to()` arrives on a framing, `by()` is relative; eases from `E`, `E.glide` by default).
- `swish()` whips from one scene's rig into the next across a cut (`swishShape()`: a quartic launch over `dur`, the cut
  at full speed with both sides streaking across it, a softer settle over `durIn`; `sequence()` opens the shutter with
  its speed, to 180° at the cut). Keep the travel (`px`) short enough that each side is still in frame at the cut.
  `sequence()` carries a scene's graphics (its headline) out with its swish.

**Layers**
- One layer per component. Never crop a component out of a bigger capture.
- Full-frame screen layers (an end card) set `layer.fullFrame = true`; they are opaque to the edge on purpose.
- Shadows that should live in the scene come from a scene's `light` and `cast: true`, not from a CSS box-shadow: a
  baked shadow is painted onto its own plane, so it turns with it and reads flat in 3D. (Glows are light; bake them.)
- `pad` must hold everything that spills past the component: glow, shadow blur + offset, focus rings. The texture
  edge must be transparent, so nothing clips and plane edges never alias. Shadows and glows are CSS, inside the pad.
- `res` = the largest on-screen scale the layer is ever seen at (a 2.4x close-up needs res 2.4). It is fixed for
  the whole film: changing it re-lays out text. Smaller sizes come from mipmaps.
- `live: true` only for layers whose DOM animates; better, `live: [t0, t1]` for the window it animates in (static
  layers are captured once; a windowed layer also once on each side of its window). Where a layer is captured once,
  its CSS animations are held still (a static layer's at rest, a windowed one's at the window's nearest edge), and its
  DOM must not change: `check` names any layer that changes there, and the layers holding loops that show still (a
  spinner that should spin needs a live window).
- Animate layers (position, rotation, opacity) in `scene(t)` when the motion should get motion blur. Motion inside a
  layer's DOM is captured once per frame, so it is crisp but not blurred.
- Layers that share a plane draw in scene order; otherwise depth decides, per pixel. Anything that floats over another
  in the app (a composer over a transcript) must sit in front of it in depth (or on its plane, after it in the scene).
- What must stay sharp at any zoom, or is drawn rather than laid out (a sky, a sweep of light), is an `effect()`.
  So is anything an app draws with WebGL: a page's GL canvases lose their context under the GPU memory pressure of
  parallel workers and go blank, so port the shader to an effect and draw it under (or over) the layer.
- An effect's noise hashes its lattice cells with integers (a PCG hash of `vec2i(cell)`, as `projects/launch/topo.wgsl`
  does), never `fract(sin(dot(p, …)) * 43758.5)`: sin() of large numbers is imprecise on some GPUs, which breaks the
  field into blocks with bright seams there while it looks right on others (launch's contours: fine on the MacBook,
  broken on Unixboat).
- Workers capture only the layers their frames draw, which is what keeps parallel workers inside GPU memory; a GPU
  error fails the frame it happens in, and every frame after it on that page (each would be stale or black).

**Components (for app UI)**
- Rebuild app UI for the film from the app's own markup and CSS; do not run the live app. Its motion is built for
  use, not for camera, and its state machines are not on the film clock.
- No live inputs, carets or real timers. Draw a caret as an element and animate it with the film clock.
- Images are the film's own files, not fetched from the network: a network image arrives at a different moment in
  each worker, and is gone when the network is.
- An app motion that JavaScript drives (an oscillator, a state machine) is run by the film on its clock, from the
  app's own module where it exports one (a chat composer's working light, say).
- Anything with a start time is keyed with `anim()` on the film clock. CSS animations are for ambient loops only
  (glows, spinners); the clock pins them to film time.
- A component shown alone must look complete alone: no gutters or seams that only make sense inside the app.
- Never show something the app does not have. Light restyling for the film is fine when the motif exists in-app.
- A part must get every stylesheet the app gives it, including the ones components import next to themselves.
  Check rebuilt parts against the app before using them (see the `product-ui` skill).
- Never crop a component to fit a frame. If it does not fit, show the whole page it lives on.

**Look**
- Light adds up as light; layers as authored (UI) come out exactly as the page draws them, over the frame as seen (see
  the engine skill). No grain unless it is a deliberate look. The final pass dithers below one 8-bit step, which is all
  dark gradients need.
