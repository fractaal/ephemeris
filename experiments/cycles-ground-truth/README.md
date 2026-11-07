# A Cycles ground truth for a film's frame

An opt-in measurement, not part of the studio: nothing imports it. It renders one moment of a film in Blender's Cycles,
unbiased (no denoiser, no clamps, no glossy filter), so the renderer's frame can be compared with the true answer, as
the `rendering-technique` skill asks of an independent renderer.

- `dump.mjs` boots the film page and writes that moment's scene as JSON: every mesh's triangles in world space (as
  `instanceData` places them), its material (the Principled inputs, linear) and each copy's tint, the lights, the
  environment's colours and the camera.
- `build.py` builds it in Blender and renders it to a linear EXR. Ephemeris's world (x right, y down, z toward the
  viewer, px) is Blender's (x, −z, −y), 1 px a unit, each triangle's winding reversed to keep it outward. A sun of
  intensity I is a Cycles sun of strength π · I (this renderer's light colour × intensity is irradiance / π); the
  environment and emission are radiance in both. Only suns are built so far.
- `exr2npy.py` turns an EXR into a NumPy array (Blender's own Python reads EXR; the system's may not).

Cycles takes the fastest GPU there is (OptiX, then CUDA, then HIP): a 960 × 540 frame at 1024 samples is 8 s on an
RTX 5070 Ti, about 6 minutes on a Radeon 890M.

```sh
node experiments/cycles-ground-truth/dump.mjs http://localhost:5421/projects/<film>/ <t> scene.json
blender -b -P experiments/cycles-ground-truth/build.py -- --calibrate calib.exr        # a white plane under a strength-1 sun: 1/π
blender -b -P experiments/cycles-ground-truth/build.py -- scene.json truth.exr 960 540 1024 12          # every bounce
blender -b -P experiments/cycles-ground-truth/build.py -- scene.json one.exr 960 540 1024 12 one        # what GI computes
blender -b -P experiments/cycles-ground-truth/exr2npy.py -- truth.exr truth.npy
```

A film's own surfaces (its WGSL) do not cross over: make a copy of the film with flat materials (a surface's tone as
its base colour), the denoisers off (`shadows: { denoise: false }`, `reflections: { denoise: false }`), no bloom or
vignette, and `view: { transform: 'standard' }`, and render both from that. Decode the renderer's PNG from sRGB and
divide by its exposure before comparing.

## gi-test, 6.58 s (2026-11-01)

The loft by day from a fixed camera, flat materials, 960 × 540: Cycles at 1024 samples on the Radeon 890M (HIP), the
renderer at 64 sub-frames, each region's linear mean as a ratio to Cycles with one diffuse and one glossy bounce (what
GI computes: 1.00 is right).

| region | main (428a46b) | branch without dbb63fa | branch (6e10772) | all bounces ÷ one |
|---|---|---|---|---|
| whole frame | 1.24 | 1.10 | 1.01 | 1.45 |
| floor in shade, left | 9.56 | 1.75 | 1.00 | 3.18 |
| back wall | 1.00 | 1.00 | 0.81 | 2.33 |
| ceiling | 1.00 | 0.99 | 0.83 | 2.36 |
| sideboard front | 1.36 | 1.19 | 0.88 | 1.89 |
| floor before the sideboard | 6.88 | 3.03 | 2.16 | 3.00 |
| chair top (sunlit) | 1.21 | 1.09 | 1.07 | 1.22 |
| table top (sunlit) | 1.59 | 0.74 | 0.66 | 1.28 |
| sofa | 1.65 | 1.63 | 1.62 | 1.04 |

- Main's reflections lit what they met with the open sky: the shaded floor 9.6 times, the floor before the sideboard
  6.9 times what is there. The branch (090ae53, 43800c8) brings the frame to 1.01.
- dbb63fa (GI's rays' hits without the sky in their highlights) takes the shaded floor from 1.75 to 1.00; the walls and
  ceiling go 17–19% under, as the window's light off the glossy floor is no longer seen by GI either.
- One bounce is GI's largest error here: every bounce in this pale room is 2.3–3.2 times one bounce on what only
  indirect light reaches.
- The floor before the sideboard (2.16 on 6e10772) was the reflection's hits' own highlights showing the open sky
  (its row profile 10 times Cycles' glossy light); 6ced8a6 lights them from GI: 0.91, the frame 1.00, the sideboard
  front 0.82.
- The sunlit table top (0.64) is caustics: its box took in the brass bowl and the glass vase, which focus and reflect
  the sun onto the table in Cycles (its brightest pixel there 32), as glass's shadows here, a tint, and one diffuse
  bounce do not. The plain sunlit table is 0.91, in line with the walls.
- The walls and ceiling (0.82) miss the sky's light bounced once: what a GI ray meets is lit by the lights alone, so
  the floor by the window lit by the sky does not light the walls here, where it does in Cycles' one bounce. That is
  more bounces, not a fault in the one.
- Cycles' passes count the environment's light on a surface as direct, so they do not separate GI's term from its own
  without care.

## GI bounces, gi-test 6.58 s (2026-11-02)

The same frame and flat copy, the renderer at 64 sub-frames with `bounces: n` (`rendering.gi.bounces` in the timeline),
Cycles at 1024 samples on the RTX 5070 Ti with n diffuse bounces and one glossy (`gi<n>`), and with every bounce
(`full`, 12). Each region's linear mean as a ratio:

| region | 1 ÷ one | 2 ÷ gi2 | 3 ÷ gi3 | 1 ÷ full | 2 ÷ full | 3 ÷ full |
|---|---|---|---|---|---|---|
| whole frame | 0.95 | 0.93 | 0.91 | 0.65 | 0.75 | 0.80 |
| floor in shade, left | 0.99 | 0.90 | 0.88 | 0.31 | 0.49 | 0.60 |
| back wall | 0.71 | 0.79 | 0.79 | 0.30 | 0.50 | 0.61 |
| ceiling | 0.74 | 0.81 | 0.81 | 0.32 | 0.54 | 0.65 |
| sideboard front | 0.83 | 0.80 | 0.79 | 0.44 | 0.58 | 0.65 |
| floor before the sideboard | 0.90 | 0.89 | 0.89 | 0.30 | 0.51 | 0.62 |
| chair top (sunlit) | 1.10 | 1.06 | 1.04 | 0.90 | 0.96 | 0.98 |

- With the sky off in both, one bounce is 0.91 on the back wall and 0.93 on the ceiling: most of the walls' 0.71 is
  the sky's light that falls on the room's other surfaces and bounces once onto them. GI's rays take the sky where
  they meet nothing, not at what they meet (that would light a closed room with the open sky), so the sky's light
  bounces one time fewer than the lights': `bounces: 2` has that bounce, and Cycles' `gi2` the next one too.
- Without probes where GI's rays land, two bounces gave the back wall 0.71 of `gi2`: the room behind the camera, lit by
  the windows, lights the back wall, and a bounce there found no probes. Made where one ray in each 4 × 4 pixels lands
  (as where reflections land), 0.79; the probes 57k → 85k in cascade 0, of room for 130k.
- Each bounce grows what it should: the back wall 1.48 times one bounce at two (Cycles 1.49), the ceiling 1.48 (1.53).
- This pale room needs many bounces (every bounce is 2.3 times one on its walls): three reach 0.61 of it there.
- Cost (4 sub-frames at 1080p, RTX 5070 Ti, interleaved ×3): the frame 221 ms at one bounce, 238 at two, 274 at
  three; GI's rays about 12 ms a sub-frame, a bounce about 4 and its merge 1.5.

## Rough reflections (2026-11-02)

Past the roughness it traces (fading from 0.35 to 0.6) a surface reflected the environment, which indoors is the open
sky, and spring-brutalist's pool spent 610 of its 630 ms of reflections on petals whose rays changed no pixel by more
than 4 levels. Now no ray goes where it could hardly show (UNSEEN, by material), and with GI what stands in is the light
GI found from the mirror direction. Flat copies at 64 sub-frames, one bounce, against Cycles' one. "Adds" is what
specular adds to the region: the frame with it less the frame with `specularIorLevel: 0` and no coat, in each renderer.

| region | total ÷ Cycles: sky | probes | adds: Cycles | sky | probes |
|---|---|---|---|---|---|
| **gi-test** (a closed room) whole frame | 0.962 | 0.934 | 0.0010 | 0.0021 | 0.0007 |
| rug | 1.348 | 0.889 | 0.0038 | 0.0134 | 0.0032 |
| chair top (sunlit) | 1.098 | 0.940 | 0.0097 | 0.0195 | 0.0057 |
| chair body (shade) | 0.978 | 0.937 | 0.0236 | 0.0301 | 0.0235 |
| chair back | 0.929 | 0.854 | 0.0130 | 0.0150 | 0.0102 |
| sofa | 1.180 | 1.174 | 0.0040 | 0.0044 | 0.0031 |
| **gi-room** (open at the front) whole frame | 0.902 | 0.866 | 0.0079 | 0.0113 | 0.0033 |
| back wall, top | 0.827 | 0.814 | 0.0092 | 0.0088 | 0.0036 |
| red wall | 0.930 | 0.874 | 0.0086 | 0.0101 | 0.0037 |
| teal wall | 0.858 | 0.779 | 0.0119 | 0.0109 | 0.0047 |
| floor | 0.928 | 0.861 | 0.0103 | 0.0212 | 0.0053 |
| ceiling | 0.938 | 0.935 | 0.0003 | 0.0101 | 0.0073 |
| ball | 0.895 | 0.862 | 0.0053 | 0.0096 | 0.0002 |

- The trade: in the closed room the probes are right where the sky was plainly wrong (the rug's specular 3.5 times what
  it should be, the leather's blue-grey sheen, gone). In the open room they read dim, about 0.4 of Cycles' specular where
  the sky's size is about right, though it is 2 times too much on the floor and 30 times on the ceiling. By eye the open
  room's three are close, with no artifact in any. Mean |log| of the regions' totals: closed 0.118 → 0.108, open 0.124 → 0.163.
- Why they read dim in the open room is not known. It is not the bar and bulb GI's rays see dark (with them off: 0.0070
  against 0.0010), nor the cosine-wide read (cascade 0's directions at the mirror direction, a narrower lobe, give the
  same to within 0.002), nor one bounce (at two against Cycles' two the frame is 0.885, the sky 0.910).
- Much of what is short of Cycles is not specular at all: with it off, gi-room's frame is 0.883 and gi-test's walls 0.77.
- The rays' cut alone, with the sky still standing in, made the closed room worse (the rug 1.488); with the probes it moves
  each region under 0.01.
- These numbers found a bug on the way: specularIorLevel 0 still reflected at grazing angles (Karis's y kept whatever F0
  was), the floor with specular off 14 times Cycles' under a blue-grey veil. Fixed (c8e9eb7), as Unreal gates it.
- Point lights: Cycles' 1 W shows 0.02449 on white 1 away (`--calibrate-point`, against 1/(4π²) = 0.0253 by theory, not
  explained), and a mesh within a light's radius must leave shadow rays, as shadowRay has it: gi-room's bulb blocked 72%
  of its lamp in Cycles until it did.

## Highlights sharing the diffuse light's shadow (2026-11-03)

The shadows pass traces rays toward the lights for diffuse light, and the opaque pass then traced as many more toward the
same lights for highlights: on spring-brutalist's pool, 167 of its 198 ms. Where one light at a point has shadows, its
highlights' rays toward that light now take what the shadows pass found; their rays along the reflection stay.

Where this should be at its worst: a sun half hidden by a wall, its penumbra across a floor of strips from roughness 0.1 to
0.8, dielectric and metal, direct light only, denoisers off, against Cycles at 4096 samples (RTX 5070 Ti). Each cell is the
penumbra's linear mean over Cycles'. Fully lit, the two are the same to three places; with two suns, byte-identical.

| strip, 64 sub-frames | 24° sun: main | shared | broken | 6° sun: main | shared | broken |
|---|---|---|---|---|---|---|
| dielectric 0.3 | 1.156 | 1.155 | 1.480 | 1.135 | 1.137 | 1.650 |
| dielectric 0.6 | 0.884 | 0.885 | 1.076 | 0.984 | 0.986 | 1.592 |
| metal 0.2 | 0.951 | 0.952 | 1.544 | 2.348 | 2.340 | 6.098 |
| metal 0.3 | 1.083 | 1.083 | 1.857 | 1.375 | 1.373 | 3.694 |
| metal 0.6 | 0.722 | 0.723 | 1.282 | 0.869 | 0.865 | 2.362 |

(Broken: highlights given no shadow where they share, to show the test sees it.)

- At 64 sub-frames gather takes one ray of each kind, whose weight cancels in its own ratio, so main's highlights were already
  weighed as the diffuse light's rays are. Main and shared differ at few sub-frames, where main takes several: the 24° sun on
  metal 0.2 is 0.747 at one sub-frame and 0.784 at four on main, 0.871 and 0.907 shared, both 0.95 at 64. So shared differs
  less with the sample count. Its RMSE against Cycles is up to 1.5 times main's on those strips at few sub-frames (metal 0.3:
  0.108 to 0.159 at four), as main's penumbra there happens to offset the metals' own error below; dielectrics move under 0.003.
- gi-test against Cycles' one bounce: no region moved in two places. Films against main at 64 sub-frames: 0.01 to 4.1% of
  pixels differ, mean change at most 0.001 levels, up as often as down; the most any pixel moved, 43 levels, single pixels
  on a plant's glossy leaf edges.
- The metal strips' own errors (2.35 above) are the same on both: see below.

| RTX 5070 Ti, 1080p, 4 sub-frames, no stream | main | shared | opaque pass |
|---|---|---|---|
| spring-brutalist pool (20 s) | 628 ms | 427 ms | 197 → 51 |
| pergola (15 s) | 343 ms | 266 ms | 81 → 14 |
| facade (9 s) | 225 ms | 209 ms | 30 → 9 |
| gi-test (4.4 s) | 92 ms | 88 ms | 36 → 32 |
| doctor-who (30 s, 13 lights) | 593 ms | 585 ms | 67 → 59 |
| Radeon 890M: the pool | 2460 ms | 1985 ms | |
| Radeon 890M: gi-test | 464 ms | 461 ms (within noise) | |

## A highlight's shape, and what a surface reflects (2026-11-03)

The strips again, the camera over each so that the sun's reflection lies on it, direct light only, 64 sub-frames, read from the
frame's linear light against Cycles at 4096 samples: the mean ÷ Cycles' in the sun's reflection and far outside it (6 to 12 of
its radii), and the strip's RMSE. Then the strips in a white world (no sun, no wall).

| strip, sun across | in it: before | after | far outside: before | after | RMSE: before | after |
|---|---|---|---|---|---|---|
| metal 0.1, 1° | 0.622 | 1.003 | 1.721 | 1.006 | 39.8 | 2.31 |
| metal 0.1, 6° | 0.600 | 0.999 | 11.49 | 1.006 | 25.7 | 5.60 |
| metal 0.3, 1° | 0.913 | 1.001 | 0.938 | 1.001 | 0.757 | 0.024 |
| metal 0.3, 6° | 0.671 | 1.000 | 1.225 | 1.003 | 2.92 | 0.081 |
| metal 0.6, 1° | 0.873 | 0.997 | 0.872 | 1.000 | 0.146 | 0.004 |
| dielectric 0.1, 1° | 0.689 | 1.005 | 1.730 | 1.012 | 2.73 | 0.204 |
| dielectric 0.1, 6° | 0.668 | 1.000 | 1.105 | 0.994 | 1.90 | 0.487 |
| dielectric 0.3, 1° | 0.984 | 1.024 | 1.011 | 1.027 | 0.023 | 0.036 |
| dielectric 0.3, 6° | 0.749 | 1.021 | 1.102 | 0.996 | 0.199 | 0.038 |

| strip, white world, ÷ Cycles | before | after |
|---|---|---|
| dielectric 0.1 / 0.45 / 0.8 | 0.995 / 0.969 / 0.986 | 1.000 / 1.000 / 1.000 |
| metal 0.1 / 0.3 / 0.45 | 0.952 / 0.845 / 0.783 | 1.000 / 0.999 / 0.999 |
| metal 0.6 / 0.8 | 0.749 / 0.734 | 1.000 / 1.000 |

Three things, each hiding the others:

- **The shape.** A light's size widened GGX's lobe, which puts too much in its long tails and too little in its middle: a haze
  around every sharp reflection, the reflection itself dim. `ggxDisc` (shaders.js) is GGX averaged over the disc a light moves the
  half vector across, in slope space. That has a closed form, because GGX there is the form factor's kernel from a point to a
  parallel plane. This is ours, from that observation, not from a paper. It is a circle where the true shape is an ellipse
  (the mean of its two radii): just outside the disc's edge on the glossiest strips it reads high, metal 0.1 under a 6° sun 1.29.
- **What a surface reflects.** Karis 2014's fit gave rough 0.1 seen at 38° y 0.0094 where the true value is 0.0006 and rough 0.6
  an albedo 15% low. It is now a table found by numerical integration (ggx.js, ggx_table.py), as Cycles has its own, with the
  y of an actual dielectric of index 1.5: Cycles' dielectrics use the true Fresnel, which Schlick's is 9% under at 38°. Other
  indices scale from that curve; only 1.5 is measured here.
- **Multiple scattering.** Cycles adds what a single bounce among the microfacets loses (bsdf_microfacet.h,
  microfacet_ggx_preserve_energy, from Kulla and Conty 2017's appendix), `scatteredMore`.

Still open: dielectric 0.3 under the 1° sun goes from a little low in places to 2.4% high throughout, its RMSE up from 0.023 to
0.036, why not known. The coat takes no multiple scattering, as far as Cycles' code was read. In the loft against one-bounce
Cycles: the frame 0.93 to 0.92, the floor in shade 1.01 to 0.99, the rug 0.87 to 0.89, the sofa 1.17 to 1.18, the rest as they were.

Every film's frames change: rough surfaces reflect more (spring-brutalist up to 1.8 levels brighter on average) and a sun's
reflection is a small bright disc, not a soft blob. Cost (RTX 5070 Ti, 1080p, 4 sub-frames, turn about): the pool 429 to 458 ms,
the pergola, gi-test and doctor-who within their noise; the opaque shader's compile within its noise (8 to 12 s either way).

## Light through what touches (2026-11-03)

The director saw it on gi-test at 10.83 s ("light haloing on the ceiling beam"): a bright line along where a beam meets the
ceiling and the wall. With GI off it stayed, bright on a black beam, so direct light. A shadow ray started 1 px off the surface
and ignored what it met within 0.5 px. Beside the beam's rounded edge (radius 4) that start lies inside the beam, and a ray
from inside a solid does not meet it, so the ceiling there saw the lantern straight through. Shadow rays now start 0.05 px off
and count all they meet: a ray going away from a surface cannot meet it again.

Against main: the line is gone; other changes lie along what touches (boards, the rug's edge, a chair's foot, overlapping
petals), almost all darker: gi-test 0.09 to 0.17 levels on average, spring-brutalist 0.2 to 0.6 (its petals about 1.4). In the
loft against one-bounce Cycles no region moved over 0.01. Coarse tubes with smooth normals, where a mesh meeting itself should
be at its worst, against Cycles: RMSE 0.0161 to 0.0160, nothing on the tubes. Frames within their noise. GI's and reflections'
rays keep their own margins (0.5 px, 0.2 px): not looked at.

## Materials alone (2026-11-01)

Slabs of the loft's materials, nothing else in the world, 64 sub-frames against Cycles at 512 samples (the centre of
each slab, linear; 1.00 is right):

| material | under a sun, black sky | in a uniform white sky |
|---|---|---|
| white matte | 0.996 | 1.000 |
| velvet without sheen (base #3d6650, roughness 0.85, specular 0.1) | 1.004 | 0.977 |
| travertine (#dccbb0, roughness 0.28) | 1.021 | 0.988 |
| leather (#8a4520, roughness 0.5, specular 0.25, coat 0.3 at 0.28) | 1.077 | 0.929 |
| velvet with sheen (weight 1, roughness 0.35) | 0.810 (now 1.000) | 1.779 (now 0.981) |

- The sofa's 1.62 in the room was its sheen. This renderer's was the Charlie distribution with Neubelt's visibility,
  its albedo table integrating that lobe (within 0.007 at every angle and roughness tried): consistent in itself, but
  Blender's Principled BSDF since 4.0 has the microfiber sheen of Zeltner, Burley and Chiang 2022 (Cycles'
  bsdf_sheen.h), which reflects far less light around it at these angles. The renderer now has that one, Cycles' own
  table (engine/render/sheen.js): velvet with sheen 1.000 under the sun, 0.981 in the white sky (its base alone 0.977
  there); backlit by a sun 8.5° up, sheen alone over a black base 0.994 at roughness 0.5, white matte 0.998. In the room
  the sofa is 1.18 (was 1.64), the frame 0.95: the walls 0.71 (were 0.82), as the rug's sheen, seen from them at a
  grazing angle, no longer reflects more than it should of the sun, which stood in for some of the sky's light bounced
  once that GI's hits leave out.
- Backlit at a grazing angle, velvet's base without sheen is 0.62: its specular highlight there, not the sheen.
- The coat is a few percent off each way, the blue most (1.34 in sun).

## Out-of-sight probes that did not fit (2026-11-02)

The director saw it on gi-test at two bounces: a settled frame dimmer than the same view moving, a bright grainy band on
the floor below the sideboard, a grey stone table, and the whole room brightening at about 4.7 s. Where the probes made
out of the camera's sight did not all fit, none was used, and a reflection's ray with no probe near took the open sky.
Cascade 3 needed 3088 of its 3072 at 4.70 s and 3041 at 4.75 s, so 16 probes of about 140,000 were the whole jump: the
frame's mean 69.1 → 75.0 of 255. Moving, the viewer draws smaller and needs fewer; among a settled frame's sub-frames, some
fit and some did not. Larger probes were worse, at one bounce too: as many points made probes whatever the probes' size,
so probe 64 at two bounces asked 1.48 times cascade 0's room.

What changed: only the cascade that does not fit loses its out-of-sight probes; those points are as far apart as the
probes are wide; those of GI's rays make probes a level coarser; cascades 2 and 3 have room for 1/3.2 of the one below
rather than a quarter (GI's buffers at probe 16: 582 → 684 MB).

| gi-test, 2 bounces, probe 16 | before | after |
|---|---|---|
| fullest cascade over the film (of its room) | 1.23 | 0.71 |
| frame's mean, 4.70 → 4.75 s | 69.1 → 75.0 | 76.4 → 75.6 |
| settled frame at 4.4 s (moving 80.8) | 76.7 | 81.3 |
| frame ÷ Cycles' two bounces (flat copy, 64 sub-frames) | 0.91 | 0.92 |
| ceiling, rug ÷ the same | 0.82, 0.86 | 0.84, 0.88 |

Against one-bounce Cycles no region moved more than 0.01. GI's time is within the runs' noise at probe 16 and
10 ms against 12 at gi-test's probe 64. Still over: spring-brutalist's pool (t 20), scattered petals, its cascade 3 at 1.01 of
its room at one bounce, 1.09 at probe 24, 1.34 at two bounces and probe 16, where only that cascade's out-of-sight
probes go. Every 4 × 4 block follows a mirror ray whether or not its surface sends reflection rays any more
(b68a283), but a surface's roughness is its WGSL's to say, which the GI pass has not run: not done.
