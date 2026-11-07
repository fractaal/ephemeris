# Drawing: what ships, and your own

Ephemeris is a human-directed, agentic creative studio. Its rendering engine is an open visual substrate for the
person and the agent to use together: the camera, motion as stacks you can grab, cues, the timeline, the editor where a
director points at a thing and changes it, and renders that are the same on every worker. How a film *looks* is not
decided by the studio. It assumes WebGPU, and gives the film room to write what it needs.

So whatever a film needs to look right, write it. What ships is a set of ways to draw, each fine to use as it is, to
take into the film and change, or to ignore:

| What | For | Where |
|---|---|---|
| Layers | real HTML and CSS: a product's UI, type, anything a browser draws | `F.layer` (engine/layers.js) |
| Effects | a procedural plane in the world (a starfield, a light sweep) | `effect` (engine/effect.js) |
| Passes | your own full-screen shaders: fog, a grade, grain, a whole raymarched world | `F.pass` (engine/pass.js) |
| SDF objects | shapes as distance functions, smoothly joined, carved and repeated (a creature, a melted logo, a colonnade) | `sdf` (elements/looks/sdf.js) |
| Fog | uneven fog that every light scatters in, marched along each ray | `fog` (elements/looks/fog.js) |
| Your own shading | how a surface looks, computed in your shader from where it is: tiles, wood, rust, wear, glow | `F.surface` on a mesh, an SDF object's `shade`, or a pass (below: Surfaces) |
| Meshes and models | triangles and imported glTF, shaded by the renderer's Principled materials | `F.mesh`, `F.model` (engine/mesh.js) |
| Traced shadows, reflections, GI | physically correct light on meshes and glass, asked for: a light's `shadows: true`, a scene's `reflections: true`, `gi: true` | the renderer's own (engine/render/) |
| The renderer itself | every pass of the frame and the WGSL they share | `./ephemeris take <film> <piece>` (below: Taking the renderer's pieces) |

None of these is *the* way. If fog is close but not right, copy `elements/looks/fog.js` into the film and change it. If
none of them fits, write the renderer the film needs in a pass: a whole world can be one raymarched shader, a
painting a shader that never draws a triangle. Go as far as the film wants.

## What Ephemeris does ask

Rendering is yours; the director's hands are Ephemeris's. Whatever draws a film, three things keep it directable:

1. **What changes over time is a motion.** A light dimming, a shape swelling, a colour drifting, the grain growing: write them
   as `motion(…)` (docs/manual/motion.md) or keys, and pass them in as params. Then the director sees lanes and can
   drag a key, retime a move, or override a value, however the pixels are drawn.
2. **What a person would point at is placed.** Lights (`F.light`), meshes, layers and placed passes (`bounds`) are
   picked by a click, outlined, and moved with the gizmo. A pass over the whole frame is listed in the Timeline panel to
   select. A light that your own shader draws should still be an `F.light` (your shader reads it: `world.lights[i]`,
   `lightHere(i, X)`), so the director can click it and key it.
3. **Params have names.** `params: { grain: 0.08, glow: 1 }` shows as *grain* and *glow*, which a director can read.
   Numbers become lanes; colours become colour fields.

## Light, and how the frame is seen

Light is physical from the first shader to the end of the frame: colours given as CSS are sRGB and made linear once,
lights add up, and the sub-frames of a frame (motion blur, antialiasing, depth of field) average light, as a camera's
shutter does — a light streaking past stays bright. The frame is seen once, at the end, through its view transform
(`scene.view = { transform, exposure }`): `'agx'` (the default, Blender's AgX: light of every colour rolls off toward
white as film does, and coloured lights mix as they should), `'neutral'` (Khronos PBR Neutral: a colour picked for a
mesh comes out as picked under white light, but adding light of one colour darkens the others — under a warm and a
blue light a shadow can show lighter than the floor around it — so it suits product shots in white light),
`'standard'` (none: light past 1 clips). Bloom (`post.bloom`, a lens's few hundredths) spreads light by how bright it is, before the
transform. The director can set these, the vignette and the environment's light and colours in the inspector's Scene
(nothing selected), over what the code sets ([motion](motion.md): the scene's own settings).

Layers as authored (captured HTML, not lit) are graphics, not light: they are put over the seen frame as they were
drawn, blending among themselves and over it as a browser blends, so UI comes out exactly as designed whatever the
view transform. A layer that is lit (`lit: true`), one brighter than authored (`bright` past 1) and an effect plane are
light, in the world with the rest.

## Surfaces

A surface's look does not need a material system: a film's own shader can set it from where the point is (in a pass,
in an SDF object's `shade`, or on a mesh with `F.surface`).

`F.surface(code, { params, textures })` is given where a mesh is placed (`MESH.at(x, y, z, { surface: S, …params })`).
Its code defines either `fn surface(s: SurfaceIn) -> SurfaceOut` (base colour, roughness, metallic, normal and
emission from where the point is, then lit as the Principled material is) or `fn shade(s: SurfaceIn) -> vec3f` (its
own light: toon bands, unlit, anything). Its `textures` (`F.texture(…)` images) are params too: `surfaceTexture(p.ao, s)`
reads one where the point is (an occlusion map, a mask, a decal on the mesh's uv). It is seen everywhere the mesh is (to
the camera, in traced reflections, GI, through glass): the camera and every ray shade through the same code. Its
params are lanes and sliders in the editor as a material's inputs are. engine/surface.js lists what `SurfaceIn` holds.

## Passes

```js
const PRINT = F.pass(/* wgsl */`
fn draw(px: vec2f, uv: vec2f) -> vec4f {
  let c = input(px).rgb;
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  return vec4f(vec3f(l) * p.tint + (filmGrain(px) - 0.5) * p.grain, 1.0);
}`, { stage: 'display', label: 'print', params: { grain: 0.08, tint: '#fff6e6' } });

nodes.push(PRINT.at({ grain: motion(0.08).to(18.4, 0.1, 0.14) }));
```

A pass runs at its stage, each on what the one before it made, in scene order:

- `stage: 'scene'` runs on every sub-frame's opaque picture (light), before layers and glass, so motion blur and depth
  of field apply to what it draws. It sees `surface(px)` (where the opaque surface there is in the world),
  `surfaceNormal(px)`, `viewRay(px)`, the camera (`cam`) and the world (`world`: the environment, the lights). Fog and
  light in it, or a whole world.
- `stage: 'light'` (the default) runs once a frame on the frame's light, before the view transform: halation, glows,
  a grade in light, a lens's effects.
- `stage: 'display'` runs once a frame on the frame as seen (after the view transform, with the layers as authored over
  it): grain, a print's look, a grade on the picture.
- A pass sees the scene as the renderer's own passes do: it can light its surfaces as meshes are lit, with the same
  materials — `litMaterial(X, N, V, m)` (`m = material(base, rough, metal)`, then a coat, sheen, a thin film or
  transmission as a mesh has them), `shownAsMeshes` (glass, with the frame behind it) — shadowed by the scene's meshes
  and layers (each light with `shadows: true`, one traced ray), reflect the scene (`reflection(…)` traces it), and
  read the environment (`environment(R, spread)`, `irradiance(N)`). Define `fn sceneDistance(w) -> f32` (how far a
  point is from your surfaces) and your surfaces also shadow and occlude themselves (`softShadow`, `occlusion`).
  `engine/render/passes/film.js` lists what a pass is given.
- A pass's surfaces are not in the scene's ray tracing: meshes do not see them in reflections or shadows. Things that
  must shadow and reflect each other are best one kind: meshes, or one pass.
- A scene pass that defines `fn drawSurface(px, uv) -> Surface` instead of `draw` draws surfaces: where it returns a
  world point with `w` 1, its pixel is depth tested against meshes and then is what is opaque there, so layers, glass
  and later passes meet it by depth.
- `bounds: [hx, hy, hz]` places a pass in the world: `.at(x, y, z, { rx, ry, rz, s, …params })`, picked and moved like a
  mesh, its code working in its own space (`toLocal`, `toWorld`, `boundsHit`). `fn pick(px) -> vec2f` says what a click
  meets in what it draws.
- Anything else the film computes goes in as `data` (`.at(params, { data })`, read as `data[i]`, a `vec4f` each).
  A frame's code runs at its shutter's ends and middle; its other sub-frames are virtual, each number lerped between those (`engine/between.js`). `data` is yours in a layout only your shader knows, so it is not lerped: where it changes within a shutter, that frame's sub-frames all run the code, as do frames where a thing appears, a list changes length or a copy spins far.
- Pictures: `textures: { name: … }` reads images (`F.texture('./assets/x.png')`, with mip levels) or the film's own
  numbers (`F.texture({ width, height, data })`), with `smp` (clamped) or `smpWrap` (repeating).
- Its own buffers: `target: F.target({ scale: 0.5 })` draws a pass into a picture of its own instead of the frame, and a
  later pass reads it by name: a glow at half size, blurred at a quarter, put over the frame; a mask; a pass in parts.
- `once: true` draws a pass once a frame (on its first sub-frame) and gives the rest of the frame's sub-frames what it
  drew: a costly world that does its own antialiasing costs 1× instead of 64× in a master (its samples), without motion blur.

A mistake in a pass's WGSL is reported at the line of the film's code.

## Taking the renderer's pieces

The renderer (`engine/render/`) is a list of passes, each a file that holds its WGSL and the JavaScript that feeds it,
and the WGSL they all share (how a surface is shaded, how light falls, how rays are traced). When one is close but not
right for a film, take it and change it:

```sh
./ephemeris take <film> meshes      # projects/<film>/render/meshes.js: the prepass and the opaque pass, the film's own
./ephemeris take <film> cull        # projects/<film>/render/cull.js: which copies the camera draws
./ephemeris take <film> shadows     # projects/<film>/render/shadows.js: the lights' shadows on what the camera sees
./ephemeris take <film> shaders     # the shared WGSL: the BSDF, the lights, surfaceAt, surfaceLight
```

The copy's imports point back at the studio, so it runs as it is; the film then gives it to the renderer:

```js
import { PASSES } from '../../engine/render/index.js';
import { opaque } from './render/meshes.js';
import { SURFACE } from './render/shaders.js';
F.run({ render: { passes: PASSES.map((p) => (p.name === 'opaque' ? opaque : p)), lib: { SURFACE } }, … });
```

- `render.passes` is the frame's list: the studio's with one replaced, one of the film's own put in where it should
  run, one left out. Each pass names the frame's textures it reads and writes (`engine/render/graph.js`); the list is
  put together when the film starts, and a pass that reads what none before it writes fails there, naming both.
- `render.lib` replaces parts of the WGSL every shading and tracing shader starts with (`LIB` in
  `engine/render/index.js`: `BSDF`, `LIGHTING`, `SURFACE`, `TRACE`, …). The camera and every ray shade through it, so a
  BSDF of the film's own is the one meshes, their reflections, GI and glass all show.
- The copy is the film's: the studio's goes on changing without it. A film that took a piece long ago may need a fix
  the studio made since; compare the two (`engine/render/…` and the film's `render/…`) and bring it across.
- Keep what the editor relies on: draw the scene's own nodes from the camera it is given, keep `R.look` (the
  preview's Fast, Solid and Wire), keep every frame a function of its moment (`./ephemeris check` renders frames twice
  to see), and keep the geometry where it is (picking finds meshes by their triangles and boxes; a pass that moves
  vertices in its shader needs to say where things are, as a pass's `fn pick` does).
- Make a pass's pipelines with `R.pipeline(key, () => descriptor)` and await them in `run` (an async function) before
  recording anything; say in `want(R, sub)` which ones a sub-frame will draw with, so that they are made side by side
  as it starts. The key names everything the descriptor is made from that can change while the film runs (`R.surfaceKey`,
  the pass's variant). A pipeline made with `R.dev.createRenderPipeline` compiles on the browser's GPU thread, and the
  studio's whole window waits for it: seconds for a heavy shader.

## Meshes, and traced light

The renderer traces shadows and reflections where a film asks for them: a light's `shadows: true`, a scene's
`reflections: true`, `gi: true`; glass, chosen as a material, traces its own way through. Traced light is correct and
costs: a scene of thousands of meshes takes most of a frame's time on its shadow rays, and a few rays a pixel are
grainy until many sub-frames average them.

The camera draws only the copies it sees. The frame's first pass, `cull` (`engine/render/passes/cull.js`), keeps the
copies whose boxes are in the frame, and for each band of rows the heavy passes are drawn in, those in its rows. Rays
still meet every copy: a tree out of the frame still shades the meadow and shows in the pool. The profile says what it
drew (`cull: 3,014 of 24,746 copies drawn …`). A film changes what it keeps by taking it: a wider margin, a thing
always drawn, grass past some distance left out, a cheaper mesh far off. Leaving it out of `render.passes` draws every
copy.

The lights' shadows on what the camera sees are found in a pass of their own, `shadows`
(`engine/render/passes/shadows.js`): for each pixel the prepass found a surface at, rays toward the shadowed lights, and
how much of their diffuse light gets through, which the opaque pass shades with. A GPU walks rays several times faster
in a small pass than inside the opaque pass's whole shader. It does not see the surface's material: it weighs the lights
as they light a white matte surface, and takes the surface's normal as the mesh has it (before a normal map or a
surface's `normal` bends it). The highlights' shadows, and those of what reflections and glass meet, are traced where
they are shaded. Leaving it out of `render.passes` has the opaque pass trace its own.

Stats shows which way a frame's rays were traced. Hardware RT uses the graphics card's ray tracing hardware. Software RT
traces them in ordinary shaders, where the build of the studio or the card has none: the picture looks the same (a few
pixels differ, nearly all by one level) and usually takes longer, up to about three times on a scene of many meshes. A
frame that traces nothing shows neither.

Sub-frames are how many times a frame is drawn, each a fraction of a pixel over and across the shutter, then averaged:
they make the antialiasing and the motion blur (the timeline's `samples`). More smooth thin bright edges and motion blur,
and take longer; depth of field and fast camera moves take more where they need them. The pixel filter sets how those
offsets spread round each pixel: Blackman-Harris within the filter width, or Box evenly across the pixel, which shows a
thin bright edge as dots or dashes until many sub-frames fill it in.

The timeline's inspector sets how GI is traced, over what the film's scenes ask:

- **GI traces.** Every sub-frame finds the light again on each of the frame's sub-frames. Once a frame finds it on the
  first alone and the others read it, which is much quicker. It can lag fast moves, and in a room lit by its bounces it
  can shimmer while the camera moves, however many rays it has.
- **GI probe size.** The size of the probes on the frame. Doubling it makes the light coarser and sends a quarter of the
  rays.
- **GI rays.** How many rays a pixel sends in a frame. More reduce grain. Once a frame wants about 16: 4 leaves shaded
  floors pebbly, and more than 16 adds little. Every sub-frame sends at least one ray a pixel, so values below the frame's
  sub-frames change nothing.
- **GI bounces.** How many times light bounces. More light a room more fully and take noticeably longer.
- **GI reach.** How far the nearest probes see, in their spacing.
- **GI hit spacing.** How sparsely probes cover what the camera can't see, where a reflection or a bounce lands. Wider is
  quicker, but a room lit by its bounces goes darker.
