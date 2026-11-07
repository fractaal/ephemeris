---
name: engine
description: How Ephemeris's time-addressable visual substrate is built — DOM layers → WebGPU, drawing your own way (passes, SDF objects, fog) or with what ships, the built-in elements, the conventions every film follows, and the tools (render, stills, check, NLE). Use whenever you write or change film code.
---

# The engine

The engine is Ephemeris's time-addressable visual substrate, inside a broader studio where a person and an agent work
on the same project. DOM for content, WebGPU for the camera: components are authored as ordinary HTML/CSS, captured
into mipmapped textures with HTML-in-Canvas, and composited by a small WebGPU renderer under one real 3D camera.
**Every frame is a pure function of film time t**: give it any t and it computes where everything is. Renders are
therefore deterministic and split across parallel headless-Chrome workers. (That is the name: an ephemeris is a table
of where every body will be at each moment.)

The project around the engine also holds the timeline, music, media and the agent's changes. Determinism makes that
shared work inspectable and reproducible; it is an enabling substrate, not the whole creative identity of Ephemeris.

```
engine/time.js        film clock: stateless keyframes (anim, seek, life, every), easing E, tempo(TL.grid).b(bar, beat)
engine/grid.js        the timeline's tempo grid: one tempo, or the music's (a part per song), bars counted across
engine/camera.js      cameras (orbit, free, target); rig(): a scene's camera (base drift + layered moves), swish() between scenes, frame()
engine/motion.js      motion(): a value as a stack of operators (rate, moves, keys, wander) — what the studio's lanes show
engine/score.js       a project's sound.js (its parts' notes and parameter motions: the sound skill); hits() and heard():
                      a part's notes for a film's .hits() pulses (docs/manual/motion.md)
engine/layers.js      DOM layers → textures (capture, padding, resolution)
engine/render/        the renderer (WebGPU): one scene every pass reads (shaders.js), the frame as passes that name
                      what they read and write (index.js PASSES; passes/: cull, meshes, shadows, AO, GI, the denoiser,
                      layers, glass, films' passes, bloom and the view transform), traced light (trace.js) — each piece
                      a film can take
engine/mesh.js        3D: shapes (box, sphere, sweep, arch, frame, torus, cylinder), materials, instancing
engine/gltf.js        glTF models (.gltf, .glb)
engine/effect.js      effects: WGSL planes evaluated per screen pixel (sharp at any zoom)
engine/pass.js        passes: the film's own full-screen shaders (fog, grading, a raymarched world, SDF objects)
engine/surface.js     surfaces: a mesh's look in the film's own WGSL (fed to the lighting, or its own light)
engine/runtime.js     the film runtime: frame protocol for the render driver
elements/             built-in building blocks (below); elements/looks/: SDF objects, fog
tools/                render, check, nle, mix, inspect, and the ./ephemeris CLI
nle/                  the editor
assets/               shared assets (the macOS pointers)
templates/film/       a new project's starting point
```

Rendering uses the studio's pinned Electron (`tools/browser.mjs`, `app/renderer.cjs`; the version is in `package.json`),
with HTML-in-Canvas enabled. There is no separate Chrome download. Each worker has its own process, separate from the
editor, and each page has a fresh in-memory session. The engine uses `copyElementImageToTexture({ source },
{ destination: { texture } })`, an experimental API: updating Electron is a rendering upgrade too (then
`./ephemeris compare --all`). Linux renders offscreen through Vulkan without a display server, macOS through Metal,
and Windows through Chromium's Windows GPU backend. As many workers render as make it
faster (measured: see `nle.md`, Workers), and a sub-frame's heavy passes (meshes with their reflections, glass) are
drawn in bands of a few ms each, measured as it renders, so the desktop sharing the GPU never waits long for its frame.

## The rendering boundary is open

Ephemeris owns the camera, motion you can grab, cues, the timeline and the editor; it does not prescribe a fixed look.
The person and the agent can use the shipped options, change them, write new shaders, or bring in the result of a
specialist tool when that is the better fit. It assumes WebGPU as its visual substrate and keeps the directing workflow
coherent around it.
`docs/manual/drawing.md` lists what ships and how to write your own. In short:

- What ships is a set of options: HTML layers, effects, the looks in `elements/looks/` (SDF objects, fog every light
  glows in), and the renderer (meshes and models, its Principled materials, traced shadows, reflections and GI). Use
  them as they are, copy one into the film and change it, or ignore them. The renderer's own pieces too: `./ephemeris
  take <film> <piece>` copies one of its passes or the WGSL they share into the film, to change and give back to it
  (`F.run({ render: { passes, lib } })`; `docs/manual/drawing.md`, Taking the renderer's pieces).
- A surface's look needs no material system: a film's own shader can set it from where the point is. On a mesh:
  `F.surface(code, { params })`, given where it is placed (`.at(x, y, z, { surface, …params })`): `fn surface(s)`
  feeds the renderer's lighting, `fn shade(s)` is its own (or unlit); seen in reflections, GI and through glass too;
  its own pictures with `textures` (engine/surface.js).
- Fonts: `assets/fonts/` has six OFL families (sans, two serifs, condensed, mono, typewriter: its README lists them).
  Import `../../assets/fonts/fonts.css` and name the family. They are the same on every machine; system fonts are not.
- Or write it yourself: `F.pass(code, …)` runs the film's own WGSL over the frame (every sub-frame on the opaque
  picture, seeing where surfaces are and the scene; once a frame on its light; or on the frame as seen), and can draw surfaces
  of its own that everything else meets by depth. It reads pictures (`F.texture`: images, its own numbers), draws into
  buffers of its own that later passes read (`F.target`), and can draw once a frame (`once`) where it is costly. A whole
  film can be one raymarched shader. Go as far as the look needs. Its own surfaces can be lit as meshes are, with the
  same materials (`litMaterial`, `material(…)`: coats, sheen, thin films, glass), shadowed by the scene's meshes and
  its own geometry (`fn sceneDistance`): engine/pass.js.
- Traced light is correct and costly, and grainy until many sub-frames average it.
- Whatever draws it, keep it directable: what changes over time is a motion passed in as a named param (lanes), and
  what a person would point at is placed (an `F.light` your shader reads, a placed pass with `bounds`, a mesh).

## A film in a project

A project is `projects/<name>/`, a folder that holds the editable audiovisual work: film code, timeline, media, music
and captures, and its history (`history/`: every version of its timelines and code together, kept by the studio). Its
film module imports the engine by path (`../../engine/…`, `../../elements/…`) — projects always sit at that depth.

```js
import { createFilm, timeline } from '../../engine/runtime.js';
import { cam, rig, frame } from '../../engine/camera.js';
const TL = await timeline(import.meta.url);   // the timeline its page names (timelines/main.json by default)

const F = createFilm();
const card = F.layer(cardEl, { w: 780, h: 220, pad: 120, res: 2.5 });
const camera = rig(0, cam({ zoom: 0.9, yaw: 10 }), { drift: { x: 12, zoom: 0.03 } })
  .to(1.2, 1.4, frame({ x: -390, y: -110, w: 780, h: 220 }, { width: 1100 }));      // one layered move
F.run({
  duration: 6,
  scene: (t) => ({
    camera: camera.at(t),
    environment: { backdrop: { color: '#050805', glows: [{ x: 960, y: 480, r: 1100, color: '#0a120a' }] } },
    nodes: [card.at(0, 0, { ry: -8 })],
    post: { vignette: 0.3 },
  }),
});
```

- **Motion** (docs/manual/motion.md, the manual's chapter): write what moves as `motion(base).to(…).wander(…)` (and
  cameras as rigs), placed as values (`BALL.at(x, GOLD.y, 0)`), so the studio shows it as lanes the director can grab.
  Plain math works too, but shows as one opaque Code lane. The director's changes to it live in the timeline's
  overrides; keep them, and fold them into the code only when asked (the chapter says how).
- **Cameras** are of three kinds (`cam({ kind, … })`; engine/lens.js says each exactly). `orbit`, the default, looks at
  x, y, z from FOCAL / zoom away and swings round it by yaw and pitch: the way to keep a subject framed while the view
  turns. `free` stands at x, y, z and turns where it stands by yaw and pitch, its zoom the lens's: a head turning, a pan
  on a tripod, a walk, a point of view. `target` stands at x, y, z and always faces tx, ty, tz, its zoom the lens's:
  following something that moves, or moving the eye while the subject stays centred. A rig is of its start pose's kind
  (`rig(t0, cam({ kind: 'free', z: 2400 }))`), and its lanes are that kind's channels.
- `scene(t)` returns the camera, environment, nodes, view and post for time t, and must be pure. Nodes are
  `layer.at(x, y, { z, s, rx, ry, rz, opacity, blur, bright, screen })` (or `layer.at(x, y, z, {…})`, as meshes take it) or `effect.at(...)`; screen nodes
  (`screen: true`, frame px) are for type and graphics that do not move with the camera. `blur` is in px of the layer
  as authored, as CSS `filter: blur()` takes them (a bell's spread, past the layer's edges too), so it scales with the
  layer; animate it to rise out of or fall into a blur.
- The studio evaluates `scene(t)` at every frame of the film to list the film's objects and to draw the lanes of the
  camera and of what the director selects, so the director waits on its cost times the film's frames. Keep a call to
  the work its moment needs. What a motion adds up to over the film so far (how far a speed has gone, how far a spin
  rate has turned) is `SPEED.integral(t)`, which follows the director's changes to it; a table of the whole film built
  again in each call makes every lane slow.
- To make a film draw faster, measure first and again after: the profile tool (or `./ephemeris profile <name> t`) says
  what drawing a frame takes, the film's code and each of the GPU's passes, the film's own by their labels.
- The frame is the timeline's `size` (`[w, h]`, 1920 × 1080 if it has none). `W` and `H` (`engine/camera.js`) are it
  once `await timeline(import.meta.url)` has run: read them after it, not at the top of a module that loads before.
- `update(t)` runs after the clock each frame for DOM state keyframes cannot express (typing, a flipped control).
- `ready()` runs once the fonts and images are in, with CSS animations at rest (finite ones finished, loops at their
  start): measure layout (`layer.world(el, x, y)`), build rigs, add pointer moves. Measured there, the layout is the
  same in every worker however long its boot took.
- A scene may return `shutter` (in frames) to open the shutter wider for a frame — a swish's whip smear; it never
  closes it below the film's own.
- `cuts`: hard-cut times; motion-blur sub-frames never straddle one.
- The frame's light is physical, and the frame is seen once, at the end: `view: { transform, exposure }` (`'agx'`, the
  default: Blender's AgX, light rolls off toward white as film does and coloured lights mix as they should;
  `'neutral'`: Khronos PBR Neutral, a mesh's picked colour comes out as picked under white light, but adding light of one
  colour darkens the others, so not under coloured lights; `'standard'`: none, light past 1 clips), `post: { bloom, vignette }` (bloom spreads light by how
  bright it is: a few hundredths is a lens's). The sub-frames average light, as a shutter does: a light streaking past
  stays bright. Layers as authored (captured UI) are graphics, put over the seen frame exactly as drawn, blending as a
  browser blends; `environment.backdrop` (what the camera sees where nothing is) is a colour as seen too. The director
  sets these in the inspector's Scene, over the code's (`stacks` with `scene: true` says what they changed).

## 3D (the renderer)

What follows is the renderer's own way to draw 3D: meshes and models with Principled materials, under one physical
light, traced where a film asks. A film that wants another look writes its own (above, and `docs/manual/drawing.md`),
or takes the renderer's pieces and changes them (`./ephemeris take`).

Meshes live in the same world as layers (px, y down, z toward the viewer) under the same camera. What is in front is
settled per pixel by depth, as in any renderer: meshes are opaque and fill the depth buffer; layers are textured quads
whose every visible pixel goes into that pixel's list of fragments, sorted by depth when the frame is resolved
(order-independent transparency), so cards that cross each other or a cube meet exactly where they meet, and soft
edges, shadows and fades blend correctly whatever is behind them. Layers on the same plane keep their scene order.
Rasterized, with shadows, reflections, GI and what is seen in glass ray traced, through one scene: the camera's shader
and every ray shade a point with the same code, so a reflection shows a thing as the camera would see it.

The light is one environment (the sky around: what lights from every way, what glossy things reflect, and what the
camera sees where nothing is) and the scene's lights: suns (light from one way, as from far off: a key light, a soft
box), points and spots where they are (a bulb, a torch, a stage light).

```js
import { box, sphere, arch, frame, torus, sweep, roundRect } from '../../engine/mesh.js';
const CUBE = F.mesh(box({ w: 200, r: 28 }));                          // rounded box, 200 px
const DUCK = F.model('./assets/duck/duck.gltf', { size: 300 });       // glTF, largest side 300 px, loaded before ready()
const KEY = F.light('sun', { intensity: 1.3, angle: 4, shadows: true, label: 'key' });   // a sun: light from one way
const SOFT = F.light('sun', { intensity: 0.4, angle: 40, label: 'soft box' });           // a broad one: a soft box
const BULB = F.light('point', { color: '#ffb26b', intensity: 0.4, radius: 16, label: 'bulb' });
const SPOT = F.light('spot', { color: '#8fb4ff', intensity: 2, angle: 30, soft: 0.5, radius: 50, label: 'spot' });
scene: (t) => ({
  camera: { ...CAM.at(t), dof: { aperture: 40, focus: [x, y, z] } },  // depth of field (a world point, or a distance)
  environment: { zenith: '#e9ecff', horizon: '#c9c3d8', nadir: '#9a7fb0', intensity: 0.5,   // the sky around
                 backdrop: '#101014' },                                // what the camera sees instead (optional)
  view: { transform: 'agx', exposure: 1 },                             // how the frame is seen (agx, neutral, standard)
  post: { bloom: 0.04, vignette: 0.2 },                                // the lens's glow, its vignette
  ao: { radius: 40, strength: 0.75 },                                  // ambient occlusion (default; false turns it off)
  reflections: true, gi: false,                                        // traced light, asked for
  nodes: [
    CUBE.at(x, y, z, { ry: 30, baseColor: '#ff5fa2', roughness: 0.3 }),
    CUBE.many(list, { baseColor: '#4c6bff' }),                        // [{ x, y, z, rx, ry, rz, s, baseColor }]: hundreds
    CUBE.at(x, y, z, { transmissionWeight: 1, dispersion: 0.4, roughness: 0.04 }),          // clear, polished glass
    CUBE.at(x, y, z, { transmissionWeight: 1, attenuationColor: '#2f45ff', attenuationDistance: 260, roughness: 0.42 }),   // frosted blue
    BALL.at(x, y, z, { baseColor: '#ffc56b', metallic: 1, roughness: 0.18 }),               // gold
    DUCK.at(x, y, z, { roughness: 0.2 }), CARD.at(x, y, z),
    POSTER.at(x, y, z, { lit: true }),                                // a layer lit by the scene (a poster, a sign)
    KEY.at(-800, -900, 800, { aim: [0, 0, 0] }), SOFT.at(700, -300, 600, { aim: [0, 0, 0] }),
    BULB.at(x, y, z), SPOT.at(x, y, z, { aim: [x, y, z] }),           // lights, placed (aimed at a world point)
  ],
}),
```

- The environment is a gradient by direction: `zenith` (up), `horizon`, `nadir` (down), CSS colours, × `intensity`. It
  lights everything from every way (its light on a surface is found exactly for each way it faces), glossy surfaces
  reflect it, and the camera sees it where nothing is, unless `backdrop` (a CSS colour) gives the camera something
  else to see there (a studio's black, a brand colour) while the light stays the environment's.
- The scene's lights: `F.light('sun' | 'point' | 'spot', { … })`, placed with `.at(x, y, z, { … })` among the nodes, as a
  mesh is (up to 256 a scene; a property given as a motion animates it). Placed so, the studio marks them in the viewer,
  selects and moves them, and keys their intensity, colour and size. A sun lights from one way: `aim` (a world point
  it shines toward from where it is placed) or `dir` (the way it shines); `intensity` is how bright a surface facing
  it is (1: as white as its colour); `angle` is how large it looks (degrees across: 0.5 is the real sun's, 30–60 a soft
  box), and so how soft its shadows and highlights are. A point or spot's `intensity` is how bright it is 1000 px away
  (nearer is brighter, by distance squared; 0.3–0.5 lights a still life, a spot that must reach across the scene wants
  2 or more). `radius` (px) is its size: its shadows and highlights are as soft as it is large, and anything within it
  (its own bulb mesh) does not shadow it — give a light a radius at least its bulb's. A spot also has `aim` or `dir`,
  `angle` (its cone, degrees across) and `soft` (how much of the cone's edge fades, 0–1). `range` (px) is where a
  point or spot ends (by default where it, with as many as the scene has, would add too little to see, so many dim
  lights still light what they ring; give a dim one in a big scene a range to save the work).
- Traced light is asked for: a light casts no shadows unless it says `shadows: true`; then they are traced (every mesh
  and layer in the world blocks them; tinted by glass the light passes through, shaped by a layer's see-through parts),
  diffuse light and highlights each take their own rays, shared among the lights by how much each gives a point of that
  light, so many lights cost about as much as one: a marquee's every bulb can be a light. Where nothing is in the way
  there is no noise; a shadow's colour is the other lights' (a bulb's shadow lit blue by the spot). As many of a
  highlight's rays follow the surface's own reflection as go toward the lights, so a glossy floor shows exactly what
  hides a light in it (a box cuts a row of bulbs' streak where its reflection covers them). On meshes diffuse light's
  shadows are denoised (Heitz, Hill and McGuire 2018: only what the rays found in the way is filtered, as wide as it is
  noisy, so textures and edges stay exact and a contact shadow stays sharp): 8 rays of each kind a pixel a frame, 1 to 4
  a sub-frame (`shadows: { rays }` in the scene for more; `shadows: { denoise: false }`: 16, unfiltered). Grain is left
  where many dim lights are partly hidden, and most where a light is buried (a bulb inside a wall still takes rays where
  it would light): put lights where their light can go. What reflections and glass show is lit with its shadows too
  (one ray of each kind, unfiltered). No lights asking for shadows, no cost.
- Layers as authored are graphics: they come out exactly as drawn (and blend as a browser blends) whatever the light,
  and they receive no shadows. `lit: true` makes a layer a matte surface in the world whose colour is its picture, lit
  by the environment and the lights, with their traced shadows; `bright` past 1 makes a layer light (a screen glowing,
  which blooms and lights what is near with GI).
- The materials are Blender's Principled BSDF (for meshes; a surface you shade yourself needs none), its inputs by
  Blender's names in camelCase, with Blender's defaults (but a white base colour): `baseColor`, `metallic`, `roughness`,
  `ior`; `specularIorLevel`, `specularTint`; `transmissionWeight` (glass), `dispersion`; `coatWeight`, `coatRoughness`,
  `coatIor`, `coatTint` (lacquer, car paint); `sheenWeight`, `sheenRoughness`, `sheenTint` (velvet, fabric);
  `emissionColor` + `emissionStrength` (its own light: blooms by how bright it is; strength 0 is off, as in Blender);
  `thinFilmThickness` (nm) + `thinFilmIor` (soap, oil, coated glass: interference colours that slide with the angle).
  Highlights are GGX, as wide as a light is large. A copy's `baseColor` (in `many()`) multiplies the material's.
  Ephemeris's own: `attenuationColor` + `attenuationDistance` (glass), `thickness`, `bounces`, `iridescence` (0–1,
  stylized: a dichroic film whose colours slide with the angle and sweep across the faces), `rim` + `rimPower` (a
  coloured silhouette). Not here: subsurface, anisotropy, alpha. An old name (`color`, `glass`, `emissive`, `glow`) is
  an error that names its replacement. A material's layout on the GPU is declared once (`engine/render/materials.js`).
- A glTF model brings its material (with the extensions Blender's exporter writes Principled BSDF into), its base
  colour texture and its normal map. A mesh of your own takes them as `F.mesh(geo, { texture, normalMap })` (images or
  mip chains: `mips(blob)` from `engine/gltf.js`, which keeps a normal map's values as stored); a normal map is
  Blender's and glTF's kind (tangent space, green up the picture, on the mesh's uv: no tangents needed) and
  `normalStrength` (1) bends by it as Blender's Normal Map node's Strength does. Textures are kept in one store the
  camera and rays read alike (`engine/render/textures.js`: up to 4096 px), so they show wherever the mesh is seen (the
  camera, traced reflections, GI), but not on glass; where a traced ray meets a box or sphere as its solid, a texture
  shows its average colour and no normal map. A surface's own pictures: `F.surface(code, { textures })`.
- Give a generated list's items an `id` (`Array.from({ length }, (_, i) => ({ id: i, … }))`, kept through `{ ...c }`):
  the editor tells copies of a `many()` apart by it, for selecting, annotating and overriding one; without ids it
  matches them by their fields, which fails where every field animates.
- `sweep({ path, profile })` sweeps a `roundRect()` or `circle()` along points: arches, frames, rings, pipes, rods.
  `merge()` and `place()` combine geometry.
- `F.mesh(geometry)` takes any triangles: `{ pos, nrm, uv, idx }` (Float32Array xyz, xyz, uv; Uint32Array triangle
  indices), written by hand, computed by the film, or from the generators above.
- Depth of field and soft edges come from the sub-frame accumulation (the lens moves across its aperture): a scene
  with `dof` renders at least `dof.samples` (32) sub-frames per frame.
- Glass (`transmissionWeight: 1`, with `ior`, `dispersion`, `attenuationColor`, `attenuationDistance`, `thickness`,
  `bounces`, and `roughness` for frost) is ray traced: the nearest glass at each pixel is
  rasterized, and its light is followed through its own solid and on through every other piece of glass it meets (up to
  `bounces`, 4; found through the one scene, on screen or not), each bending it, tinting it (by its base colour, and its
  path) and frosting it, into the frame behind the glass. Glass behind glass is traced, not ordered: it cannot flicker,
  and there is no limit on how many pieces. A `box()` or `sphere()` is traced through its solid form: the view bends
  going in and out, and where the inside face is too steep it bounces back inside (the thick, bright-and-deep edges of a
  glass block). Other shapes are treated as panes `thickness` px thick. `attenuationColor` is the colour after
  `attenuationDistance` px of glass, so long paths and edges go deeper (white is clear). What the light leaving the
  glass meets is found by tracing it through the scene (a card or a mesh passing through a solid is met inside it). A
  layer the camera also sees there is read from the frame behind the glass, as drawn (full resolution): far things
  shift more, and frost melts them by how far back they are, with a milky haze; the frame's sub-frames interleave
  frost's rays, so a master's 64 are smooth. A mesh is always traced (it is lit, and looks different from
  where the light meets it than from the camera), as is a layer the camera cannot see there. `dispersion` splits
  colours at the bends (a few px at most). A thin film on glass reflects its interference colours and lets the rest
  through; `iridescence` is the bold, stylized one. Its reflection is traced (below). A layer as authored seen through
  glass or in a reflection is light there (its colour as light), so it passes through the view's curve as everything
  seen through glass does. `projects/glass` is the test bench.
- Reflections are traced only where the scene asks (`reflections: true`, or `{ denoise }`); by default glossy surfaces
  reflect the environment alone, which costs nothing and is often all a look needs. Traced, every mesh and glass
  reflects the scene around it (meshes, layers, glass), by Fresnel — about 4% head-on for plastic and glass, its own
  colour for metal, nearly a mirror at grazing angles. What a reflected ray meets is lit as the camera would see it lit
  (the same shading: its textures, its normal map, the film's surface on it), reflecting the environment in turn; a
  layer's see-through parts let it on; glass it passes reflects and lets it through, tinted and not bent. Where it meets
  nothing it sees the environment. Rough surfaces scatter their rays (GGX, a different direction each sub-frame), and
  on meshes their reflections are denoised (Stachowiak and Uludag 2015's ray reuse: one ray a pixel, each pixel's
  reflection made of its neighbours' rays as well, each weighed by its own roughness's lobe, so a rough reflection keeps
  its shape, the streak a light makes in a glossy floor, and a mirror stays sharp); a rough surface's ray is clamped
  against fireflies (a mirror's is not). `reflections: { denoise: false }` scatters up to 4 rays a sub-frame where a
  reflection shows strongly, unfiltered. Past a roughness of 0.6 a surface reflects only what stands in for rays (from 0.35 it
  fades over), as engines cap the roughness they trace: with GI, the light it found from that way; else the environment.
  No ray is sent where it could hardly show (a dielectric past a roughness of about 0.52). Reflections see everything in the world, on screen or not, but
  not screen-space layers.
- GI (`gi: true`, or `{ probe, rays, bounces, once, reach, hit }`): the light around each mesh the camera sees, found by tracing, in place of
  the environment's diffuse light — the colour a red wall bleeds onto the floor, a lamp lighting the room it is in.
  Split Radiance Cascades (Freeman, Sannikov and Pitt-Francis 2026): sparse probes where the camera
  sees meshes, found again every sub-frame from nothing kept between frames (the same frame on any worker); one bounce
  by default (`bounces`: more, each a pass over where GI's rays landed, not traced again, with probes made where they
  land out of sight; the sky's light bounces one time fewer than the lights'; each about half what GI's rays cost),
  diffuse; a small bright emitter (a glowing box or sphere, a layer brighter than authored) lights what is near it from
  each pixel, without the noise GI's rays would make finding it. `probe` (px on the frame, 16) sets how fine the light is and what it costs, as many rays reaching
  each probe whatever its size (32: a quarter of the rays, 64: a sixteenth); `rays` (a pixel's in a frame at that size, 4; at
  least one a sub-frame, below 1 a quarter of that) sets its grain; `once: true` makes the probes on a frame's first sub-frame only, with all of `rays` there. Raise `rays` with it: 4 leaves shaded floors pebbly, 16 was clean on spring-brutalist. Look at it moving: on gi-test, a room lit by its bounces, it shimmers from frame to frame as the camera moves, the same at 16 rays as at 64. `reach` (1.6) is how far cascade 0 sees in its probes' spacing; `hit` (4 at probe 16) how sparsely pixels make probes out of the camera's sight. What a
  reflection or glass shows is lit by it too, where its probes are: near what the camera sees, and, in a scene with
  `reflections`, where its mirror reflections land (behind the camera, under furniture); elsewhere by the environment. Layers and glass's own surface send light into it but do not take it. The
  timeline's `gi` turns it on or off for the whole film, and its `rendering.gi` sets all of these
  over the film's (nle.md).
- Lens: `camera.focal` (default 2200) — smaller is wider (a tunnel at ~1000), larger is a long lens. The plane
  through an orbit camera's target keeps its scale whatever the lens; only depth is exaggerated or compressed (its zoom
  moves the eye). A free or target camera's zoom is the lens's (focal × zoom): a zoom in, the eye staying where it is.
- Depth of field is physical: at close range it is very shallow (a 110 px aperture 950 px from a duck keeps about
  ±50 px sharp). For a sharp subject on a melted background, shoot as a cinematographer would: a long lens (`focal`
  6000+) from farther back, a modest aperture, and the background much deeper.
- Make rounded shapes at their size (`box({ w, h, d, r })`): a rounded cube scaled unevenly stretches its bevel into
  a pill. `s` is for uniform scale and small variations.
- Models: credit the author and licence next to `F.model()` (Poly Haven models are CC0). The model's own base colour
  texture and factors are its defaults; options passed to `.at()` override them.
- Timing comes from the director's cues, by name, through `elements/cues.js` (see `materialize`).

## Elements

Built-in building blocks a film composes. Promote something from a film into `elements/` once it is proven there and
nothing in it belongs to one product.

- `elements/sequence.js` — a film's scenes run as one: `sequence({ scenes, swishes, cams, headlines })` → `.at(t)` for
  `F.run`'s `scene`, `.cuts` for its `cuts`. Each scene: `{ t0, cam, environment, draw(t, push, camera), post(t), view,
  ao, gi, reflections, shadows }` (objects, or functions of t; lights are pushed in draw as nodes); swishes open the
  shutter and cross the environments over; headlines leave with their scene. `BACKDROP(color, glows)`,
  `mixEnvironment()`.
- `elements/headline.js` — headlines: `headlines(F).add(lines, { left, top, size, t, out, lime, eyebrow,
  center, scrim })`; lines rise in from blur and fall out; a scrim when over busy footage.
- `elements/cursor.js` — a pointer: `cursor(F, { z, lift, size, res })`,
  `.from(p).move(t, p, { dur, arc, shape, drag }).click(t)`, `.nodes(t, { lift, opacity })` in a scene's draw. A target
  that must be measured at its moment (an element that moves) can be a function: it is measured once at boot, from the
  DOM as it stands when the pointer arrives, so add those moves in `ready()`.
- `elements/typing.js` — `typing(text, t0, t1)` keystroke times, `typeInto(t, editor, text, times, {…})` into a real
  editor (caret, placeholder, send button), `caret()`.
- `elements/reveal.js` — rows that arrive one by one (collapse, grow in, reflow); `hidden(t)` to keep a growing
  transcript anchored at its end.
- `elements/rings.js` — pulse rings swelling out from a point (something ringing): `rings(F).at(x, y, age)`.
- `elements/looks/` — ways to draw, written as passes (use, copy and change, or ignore): `sdf(F, { map, bounds, params,
  shade })` an SDF object placed as a mesh is (`.at(x, y, z, { ry, s, …params })`; its WGSL library `SDF`: shapes,
  smooth union and carving, noise); `fog(F, params)` fog every scene light glows in (`fogGlow` for your own shaders).
  Each exports its WGSL.
- `elements/depth.js` — a photo in depth: `await depthPhoto(F, name, { frame: { x, y, zoom }, room, deep, pivot, cover })`
  places the layers the `depth` tool cut (`assets/depth/<name>-*`) apart in the world, scaled to line up as the photo
  from the camera's rest (an orbit camera at `z: P.pivot`, unturned); `P.draw(push, x, y)` in a scene's draw,
  `P.backdrop(push, x, y)` behind it for a whip. Turn the camera (yaw, pitch, roll, drift) and what is near comes away
  from what is behind it. The cut follows depth, not things: look at the layers before building a shot on them.
- `elements/cues.js` — the director's cues by name: `const C = cues(F, TL)`, `C.at('drop', fallback)`,
  `C.end('glide', fallback)` (a range's end), `C.get(id)` (the whole cue: its note and label too). The cues a film reads are reported to the NLE and `check`;
  a cue's note or label changes the film only where it reads that cue with `get`.
- `elements/type.js` — the line animation under headlines: `lines(el, { t, out })`, `span()`.

## Tools

```sh
./ephemeris serve                    # dev server for projects that need only Ephemeris (5320)
./ephemeris nle <name>               # the editor (5340): music, cues, the film rendered live, autosaved history — see nle.md
./ephemeris stills <name> 1.5,20.7   # stills into projects/<name>/renders/stills (look at them)
./ephemeris check <name>             # gates: padding, determinism, cues, layers captured once (--momentum, --pacing: a style's)
./ephemeris master <name>            # the finished film: its fps/shutter, full motion blur, its music; also -share.mp4
./ephemeris snapshot <name>          # reference frames (each cue, every 2.5 s), on this machine
./ephemeris compare <name>|--all     # which frames a change altered (diff images in renders/compare)
./ephemeris depth <name> assets/a.jpg # a photo cut by depth into layers, in assets/depth (--name, --crop x,y,w,h)
node tools/render.mjs --url <page> …  # the driver itself (--from/--to, --sub, --workers, --audio)
node tools/inspect.mjs <page> 12        # debug: layer captures and node placement for one frame
```

`check` exits 1 on a failed gate; the cursor-pacing and cues lines are warnings. Frames are byte-identical however
they are reached, but only on one machine and one rendering runtime: references are per machine. A product film may bring its own dev server
(its page URL lives in its timelines' `url`); see `product-ui`.

## Conventions

Every convention exists because it was a visible defect once: read `conventions.md` before writing film code.
The studio, its timelines, the live viewer, drafts and the timeline schema are in `nle.md`.
