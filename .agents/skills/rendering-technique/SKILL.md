---
name: rendering-technique
description: For changing the studio's renderer, not for making films. How to implement or fix a rendering technique in the renderer (light, shadows, reflections, GI, sampling, denoising, volumes) so that it is correct, not just plausible. Find the method graphics programmers use and read its paper, render a ground truth that is provably the true answer, and measure the method's bias, noise and cost against it. Use when you build or change how engine/render/ or the shipped looks compute light, or are fixing a bug reported in them. Do not use it while making a film (a product video, a motion design piece) unless the director asks for it.
---

# Rendering techniques: sources and ground truth

This skill is for work on the studio's renderer: `engine/render/` and the looks it ships. While you make a film, a
look that is wrong for the film is a creative problem. Fix it in the film, or tell the director if you think it is a
renderer bug. Start this work only when the director asks for it.

Most of what a renderer computes is an estimate of an answer that exists: how much light reaches this pixel. A frame
that looks plausible is no evidence that the estimate is right. A wrong estimate often looks fine until a particular
light, surface or camera shows the error. Two things are evidence:

- **Sources.** The method is one graphics programmers use for this problem. It is built from its paper's own
  equations, and anything you add is named as yours.
- **Ground truth.** The same frame is rendered by a method that is slow and simple and provably gives the true
  answer. The technique is measured against it, at the sample counts people see.

Do both when you build a technique. When a frame looks wrong, do both before you change anything. Tuning until the
frame looks right only moves the error somewhere else. A clamp, an epsilon or a scale factor that hides a symptom is
not a fix unless the source calls for it. If you keep one, tell the director.

## Find the method

- Name the problem in the field's terms first: many-light direct lighting with visibility, sampling a glossy lobe, a
  shadow denoiser, light leaking through thin walls. The right words find the literature.
- Find what is established and what is current. The textbooks give the established estimator: *Physically Based
  Rendering* (4th edition, free at pbr-book.org) and *Real-Time Rendering*. Recent papers and production talks show
  what renderers do now: SIGGRAPH's Advances in Real-Time Rendering course, HPG, I3D, EGSR, JCGT, and the engines'
  own write-ups. Search for them. What you remember of a paper can be wrong in exactly the detail that matters, and
  newer work may have replaced it.
- Read the paper itself, not its abstract or a summary. Put the PDF in your scratchpad, run `pdftotext -layout` on
  it, and read the equations, what they assume, and the section on your case (several lights, smooth or rough
  surfaces, small or large lights). Papers say where they stop working, and that is often where the bug is.
- If the paper leaves your case out, look for work that covers it before you invent something. If you do invent (a
  constant the paper doesn't give, a simplification, a clamp), say so in the code and to the director, and measure it
  against ground truth like everything else.
- Cite the source in the code where its maths is: author, year, equation.

What Ephemeris asks of a method:
- Each frame renders alone, and comes out the same however it is reached (`./ephemeris check` renders frames twice to
  see). A method that keeps history across frames (temporal accumulation, temporal reuse) has to work within one frame
  here: its samples come from the frame's sub-frames and its own rays.
- A sum that GPU threads add in parallel is added in fixed point, so the order of the additions doesn't change it.
- The editor's view draws as few as one sub-frame, and masters draw the timeline's master samples (64 by default).
  A method has to hold up at both.

## Ground truth must be the true answer

A reference that is wrong in the same way as the method agrees with it, and so approves the bug. Rendering it with
many samples doesn't help: it then converges, confidently, to the wrong answer. Ground truth needs three things.

- **It computes the actual quantity.** Write it from the integral the method estimates: light arriving over the
  hemisphere, times the BSDF, times the cosine. Don't build it from the method's own pieces. If it calls the method's
  analytic light terms, its visibility or its sampler, it inherits their errors. Share only the scene and the BSDF's
  value for a pair of directions, and check the BSDF separately (below).
- **Each sample is unbiased.** Averaging sub-frames converges to the expected value of one sub-frame's estimate. That
  is the true answer only if each sample is plain Monte Carlo: the integrand divided by the probability of drawing that
  sample, used as it is. Multiple importance sampling with weights that sum to one stays unbiased. These stay biased
  however many sub-frames you average, if they are inside a sample:
  - a ratio (Σ w·V / Σ w);
  - an analytic unshadowed term multiplied by an estimated visibility;
  - a clamp, a normalisation or a max;
  - a cache or a denoiser.

  Real-time methods use exactly these. They are what is being tested, so ground truth can't use them.
- **It can see the case.** A mirror sees a light only along its reflection. A ground truth that only sends rays
  toward lights will practically never find that direction. One that follows the reflection must be able to hit the
  light's actual shape. Some cases have an exact answer instead: a light of zero size needs only one shadow ray.

Then prove it before you trust it.

- **Cases with a known answer.** Put a white diffuse surface in a uniform white environment with nothing in the way
  (every environment colour the same). It returns the environment's radiance exactly: this is the furnace test. A
  light's colour × intensity is its irradiance / π (shaders.js, highlight()): a white matte surface lit head-on by a sun
  of intensity 1 shows 1, so an unshadowed light over a diffuse surface of albedo ρ gives ρ · I cos θ (÷ r² for a point
  light). A sphere light's unshadowed irradiance has a closed form. Ground truth matches all of these to within its
  noise.
- **Two estimators agree.** Sampling the lights and sampling the BSDF share only the integrand they sample, and both
  converge to the same picture. Where they disagree, one has a bug.
- **It converges.** The difference between N and 4N samples halves each time N grows fourfold. If it stops halving,
  the ground truth is itself biased.
- **An independent renderer.** Some things are shared by every variant you can write here: the BSDF, the light
  units, the view transform. Only an outside renderer can check them. Render a simple scene with the same materials and
  lights in Blender's Cycles (the renderer's materials follow its Principled BSDF), Mitsuba 3 or pbrt-v4, and compare.
  Cycles' light strengths are irradiance: a sun of intensity I here is a Blender sun of strength π · I (checked: a white
  matte plane under a strength-1 Cycles sun shows 1/π, here 1); the environment and emission are radiance in both.

When you report, say what your ground truth still shares with the method.

## Render it

- Work on scratch copies. Put the test film in a scratch workspace (`EPHEMERIS_WORKSPACE` in your scratchpad), never
  in the checkout's `projects/`. Make the ground truth a second copy of the film that takes the piece under test and
  rewrites its estimate (`./ephemeris take <film> shaders`, or a pass; see docs/manual/drawing.md, Taking the
  renderer's pieces). Both copies then render from the same studio.
- To compare against the committed renderer while the checkout has changes, use a second scratch workspace with
  `git archive HEAD engine | tar -x -C <ws>`. Link `elements`, `assets`, `nle` and `docs` into it from the checkout
  yourself: the command line leaves a workspace that has a real `engine/` alone. Then run
  `EPHEMERIS_WORKSPACE=<ws> ./ephemeris serve --port <n>`, and point the film's timeline `url` at that port.
- Reproduce what was reported first. Use the film, moment and camera where it shows; for the editor's free view, copy
  that view into the scratch film's camera. Use the same settings too: the timeline's shadows and reflections, and the
  sample count of the view that showed it.
- `./ephemeris stills <film> <t> --sub 64 --shutter 0` averages 64 sub-frames of one moment in linear light, each
  jittered and seeded differently. A frame takes at most 64. Put more samples inside the ground truth's own loop:
  more rays per light, per pixel.
- The same frame rendered twice is byte-identical, so a rerun shows no noise. Render at two sample counts instead:
  what changes between them is the ground truth's own noise. A difference below that floor means nothing.
- Renders at 1, 4 and 32 samples that come out identical mean the samples are not reaching the shader: a seed or a
  count never changes. The comparison then measures nothing.

## Measure

- Measure the estimate, not what surrounds it. In the scratch films, set the view transform to `'standard'` with
  exposure low enough that nothing clips, set `post.bloom` to 0, and turn the denoisers off (the scene's
  `shadows: { denoise: false }` and `reflections: { denoise: false }`). A denoiser blurs over the bias you are looking for; measure it separately,
  against the same ground truth. Convert the PNGs from sRGB to linear before you subtract.
- Measure each region that matters: where the artifact is, a shadow, a plain lit area, the whole frame. Report the
  bias (the mean difference: an error that does not average away) and the RMSE (error of any kind). Crop the method
  and the ground truth side by side and look at them. Find the pixels furthest off in each direction.
- Compare like with like. The method at one sub-frame shows what the editor's view shows. At the ground truth's
  sub-frame count, it shows what the method converges to. Where the sub-frame counts differ, edges differ by
  antialiasing alone, so keep measured regions away from edges.
- Separate noise from bias: give the method many more samples of its own (a variant with its ray count raised). Noise
  shrinks as samples grow. What stays, or grows, is bias: a fault in the estimator, which more samples or more blur
  will not fix.
- To see where an estimate goes wrong, render a variant that writes an intermediate value as its colour: which light a
  pixel chose, its visibility, a probability.

## Cost

A technique is as good as its error for the time it takes.

- Time a film as the studio opens it. Its timeline's `gi`, `shadows`, `reflections` and `rendering` reach the page in its
  URL's query (`nle/model.js`), and the bare page traces with the defaults: spring-brutalist's GI at 16 samples took 3.5
  times as long there, and what limited its frames was another thing altogether.
- Measure time on the GPU the film renders on, after a warm-up render (the first one compiles shaders). An open editor
  fills its viewer's frames in the background on that GPU: turn Pre-render off (the `prerender` tool) first, and on again
  after.
- Compare techniques at equal time (which is closer to ground truth in the same milliseconds) or at equal error (which
  is faster).
- A speed-up changes the error too, so measure both. Fewer rays, a cache, a cheaper approximation or a smaller drawing
  size each gets measured against ground truth.
- The renderer has no per-pass timer. To time one pass, wrap the WebGPU device from Playwright: ask for
  `'timestamp-query'` and add `timestampWrites` to each pass.

## Report

Tell the director:
- what the method is and where it comes from, and what in it is yours;
- the numbers against ground truth, at the editor's sample count and the master's;
- the crops beside ground truth;
- the cost;
- what the ground truth shares with the method, and what you have not checked.

A bias you cannot explain is an open finding, not a finished technique.
